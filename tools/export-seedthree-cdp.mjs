#!/usr/bin/env node

// Dependency-free SeedThree production exporter.
//
// This drives SeedThree's existing browser UI through raw Chrome DevTools
// Protocol calls. It deliberately does not import SeedThree's headless API: the
// UI owns the GPU card and billboard bakes, and its Download .glb callback owns
// the production MSFT_lod export.
//
// Expected setup (use a Chrome profile/port separate from Eanpa's 9223):
//   npm.cmd run dev -- --port 5390 --strictPort
//   chrome.exe --remote-debugging-port=9333 --user-data-dir=<isolated-profile> \
//     --remote-allow-origins=* http://localhost:5390
//   node tools/export-seedthree-cdp.mjs

import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[++i];
    if (value == null || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    out[key] = value;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = resolve('C:/Users/sdn52/OneDrive/Desktop');
const cdpPort = Number(args['cdp-port'] ?? process.env.SEEDTHREE_CDP_PORT ?? 9333);
const appUrl = args.url ?? process.env.SEEDTHREE_URL ?? 'http://localhost:5390/';
const timeoutMs = Number(args['timeout-ms'] ?? process.env.SEEDTHREE_TIMEOUT_MS ?? 600_000);
const outputDir = resolve(args['output-dir'] ?? join(repoRoot, 'assets', 'vegetation'));
const stagingDir = resolve(args['staging-dir'] ?? join(repoRoot, 'artifacts', `seedthree-downloads-${Date.now()}`));

const jobs = [
  {
    id: 'saguaro',
    speciesKey: 'saguaro',
    preset: resolve(args['saguaro-preset'] ?? join(
      desktop,
      'eidoverse-video-prealpha-0.01',
      'work',
      'seedthree_gallery',
      'saguaro_seed555.seedthree.json',
    )),
    output: 'saguaro_seed555.glb',
  },
  {
    id: 'joshuaTree',
    speciesKey: 'joshuaTree',
    preset: resolve(args['joshua-preset'] ?? join(
      desktop,
      'eidoverse-video-prealpha-0.01',
      'work',
      'seedthree_gallery',
      'joshuaTree_seed555.seedthree.json',
    )),
    output: 'joshuaTree_seed555.glb',
  },
];

class CDPClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', ({ data }) => this.onMessage(JSON.parse(data)));
    socket.addEventListener('close', () => {
      for (const { reject: rejectCall } of this.pending.values()) {
        rejectCall(new Error('Chrome DevTools socket closed'));
      }
      this.pending.clear();
    });
  }

  onMessage(message) {
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  call(method, params = {}, callTimeoutMs = 60_000) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(new Error(`${method} timed out after ${callTimeoutMs} ms`));
      }, callTimeoutMs);
      this.pending.set(id, { method, resolve: resolveCall, reject: rejectCall, timer });
    });
  }

  close() {
    this.socket.close();
  }
}

async function connectToSeedThree() {
  const base = `http://127.0.0.1:${cdpPort}`;
  let targets;
  try {
    targets = await fetch(`${base}/json/list`).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    });
  } catch (error) {
    throw new Error(`Cannot reach isolated Chrome CDP port ${cdpPort}: ${error.message}`);
  }

  let target = targets.find((item) => item.type === 'page' && item.url.startsWith(appUrl));
  if (!target) {
    const created = await fetch(`${base}/json/new?${encodeURIComponent(appUrl)}`, { method: 'PUT' });
    if (!created.ok) throw new Error(`Could not create SeedThree Chrome tab: HTTP ${created.status}`);
    target = await created.json();
  }
  if (!target.webSocketDebuggerUrl) throw new Error('SeedThree Chrome tab has no DevTools WebSocket URL');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error('Timed out opening Chrome DevTools socket')), 15_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    socket.addEventListener('error', (event) => { clearTimeout(timer); rejectOpen(event.error ?? new Error('CDP socket error')); }, { once: true });
  });
  return new CDPClient(socket);
}

async function evaluate(cdp, expression, { byValue = true, userGesture = false, timeout = 60_000 } = {}) {
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: byValue,
    userGesture,
  }, timeout);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return byValue ? result.result.value : result.result;
}

async function waitFor(label, check, waitMs = timeoutMs, intervalMs = 250) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < waitMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? ` (${lastError.message})` : ''}`);
}

const controllerHelpers = `
  const controller = (label) => [...document.querySelectorAll('.lil-controller, .controller')]
    .find((item) => (item.querySelector('.lil-name, .name')?.textContent ?? '').includes(label));
  const controllerValue = (label) => {
    const host = controller(label);
    const input = host?.querySelector('select, input');
    if (input?.value) return input.value;
    const display = host?.querySelector('.lil-display')?.textContent?.trim();
    return label === 'Species' && display
      ? display.replace(/\\s+(.)/g, (_, c) => c.toUpperCase()).replace(/^./, (c) => c.toLowerCase())
      : null;
  };
`;

async function pageState(cdp) {
  return evaluate(cdp, `(() => {
    ${controllerHelpers}
    const loading = document.getElementById('loading');
    const error = document.getElementById('err');
    return {
      title: document.title,
      readyState: document.readyState,
      loading: !!loading?.classList.contains('on'),
      species: controllerValue('Species'),
      seed: controllerValue('Seed'),
      hasLoad: !!controller('Load preset'),
      hasExport: !!controller('Download .glb'),
      error: error && getComputedStyle(error).display !== 'none' ? error.textContent.trim() : null,
    };
  })()`);
}

async function installFileInputCaptureAndClickLoad(cdp) {
  const captured = await evaluate(cdp, `(() => {
    ${controllerHelpers}
    const slot = globalThis.__seedthreeCDP ??= {};
    if (!slot.originalInputClick) {
      slot.originalInputClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function (...clickArgs) {
        if (this.type === 'file') {
          slot.fileInput = this;
          return;
        }
        return slot.originalInputClick.apply(this, clickArgs);
      };
    }
    slot.fileInput = null;
    const host = controller('Load preset');
    const button = host?.querySelector('button') ?? host;
    if (!button) throw new Error('SeedThree Load preset controller not found');
    button.click();
    return !!slot.fileInput;
  })()`, { userGesture: true });
  if (!captured) throw new Error('SeedThree did not create its preset file input');
  const remote = await evaluate(cdp, 'globalThis.__seedthreeCDP.fileInput', { byValue: false });
  if (!remote.objectId) throw new Error('Could not retain SeedThree preset file input');
  return remote.objectId;
}

async function loadPreset(cdp, job, preset) {
  console.log(`[seedthree] Loading ${basename(job.preset)} through the UI`);
  const objectId = await installFileInputCaptureAndClickLoad(cdp);
  await cdp.call('DOM.setFileInputFiles', { files: [job.preset], objectId });

  // DOM.setFileInputFiles normally dispatches change. If this Chrome build only
  // updates FileList, invoke SeedThree's unchanged onchange handler once.
  await sleep(300);
  let state = await pageState(cdp);
  if (state.species !== job.speciesKey || Number(state.seed) !== Number(preset.controls.seed)) {
    await evaluate(cdp, '(async () => globalThis.__seedthreeCDP.fileInput.onchange?.())()', { timeout: timeoutMs });
  }

  await waitFor(`${job.id} preset values`, async () => {
    state = await pageState(cdp);
    if (state.error) throw new Error(state.error);
    return state.species === job.speciesKey && Number(state.seed) === Number(preset.controls.seed);
  });
  await waitFor(`${job.id} GPU rebuild and billboard bake`, async () => {
    state = await pageState(cdp);
    if (state.error) throw new Error(state.error);
    return !state.loading;
  });
  await sleep(1_000);
  state = await pageState(cdp);
  if (state.error) throw new Error(state.error);
  console.log(`[seedthree] Ready: species=${state.species}, seed=${state.seed}`);
}

async function setDownloadDirectory(cdp) {
  try {
    await cdp.call('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: stagingDir,
      eventsEnabled: true,
    });
  } catch (browserError) {
    try {
      await cdp.call('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: stagingDir });
    } catch (pageError) {
      throw new Error(`Cannot configure Chrome downloads: ${browserError.message}; ${pageError.message}`);
    }
  }
}

async function clickProductionExport(cdp) {
  const result = await evaluate(cdp, `(() => {
    ${controllerHelpers}
    // SeedThree asks for a destination before its asynchronous GPU export. In an
    // automated tab there is no native-dialog driver, so expose the exporter's
    // own anchor-download fallback and let CDP route that download to staging.
    try {
      Object.defineProperty(window, 'showSaveFilePicker', {
        value: undefined,
        writable: true,
        configurable: true,
      });
    } catch {
      window.showSaveFilePicker = undefined;
    }

    // SeedThree completes its GPU export asynchronously, and Chrome may block
    // the later synthetic anchor click because it no longer has user gesture
    // activation. Capture that generated GLB anchor, then click it from a
    // second CDP evaluation that explicitly restores user activation.
    const slot = globalThis.__seedthreeDownloadHandoff ??= {};
    if (!slot.nativeAnchorClick) slot.nativeAnchorClick = HTMLAnchorElement.prototype.click;
    if (!slot.nativeRevoke) slot.nativeRevoke = URL.revokeObjectURL;
    slot.anchor = null;
    HTMLAnchorElement.prototype.click = function (...args) {
      if ((this.download || '').toLowerCase().endsWith('.glb')) {
        slot.anchor = this;
        return;
      }
      return slot.nativeAnchorClick.apply(this, args);
    };
    URL.revokeObjectURL = function (url) {
      if (slot.anchor?.href === url) return;
      return slot.nativeRevoke.call(URL, url);
    };

    const host = controller('Download .glb');
    const button = host?.querySelector('button') ?? host;
    if (!button) throw new Error('SeedThree Download .glb controller not found');
    button.click();
    return { pickerDisabled: typeof window.showSaveFilePicker !== 'function' };
  })()`, { userGesture: true });
  if (!result.pickerDisabled) throw new Error('Could not disable native save picker in the automated tab');

  await waitFor('production GLB blob',
    () => evaluate(cdp, '!!globalThis.__seedthreeDownloadHandoff?.anchor'),
    timeoutMs, 200);
  await evaluate(cdp, `(() => {
    const slot = globalThis.__seedthreeDownloadHandoff;
    if (!slot?.anchor) throw new Error('No captured GLB anchor');
    const name = slot.anchor.download;
    slot.nativeAnchorClick.call(slot.anchor);
    HTMLAnchorElement.prototype.click = slot.nativeAnchorClick;
    URL.revokeObjectURL = slot.nativeRevoke;
    slot.anchor = null;
    return name;
  })()`, { userGesture: true });
}

async function currentGlbs() {
  const entries = await readdir(stagingDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.glb'))
    .map((entry) => resolve(stagingDir, entry.name));
}

async function waitForNewDownload(cdp, before) {
  let candidate = null;
  let stableSize = -1;
  let stablePolls = 0;
  return waitFor('completed production GLB download', async () => {
    const state = await pageState(cdp);
    if (state.error) throw new Error(state.error);
    const files = (await currentGlbs()).filter((file) => !before.has(file));
    if (!files.length) return null;
    candidate = files[0];
    const info = await stat(candidate);
    if (info.size > 20_000 && info.size === stableSize) stablePolls++;
    else stablePolls = 0;
    stableSize = info.size;
    return stablePolls >= 2 ? candidate : null;
  }, timeoutMs, 500);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function parseGlb(buffer) {
  expect(buffer.length >= 20, 'GLB is too small');
  expect(buffer.toString('ascii', 0, 4) === 'glTF', 'GLB magic is invalid');
  expect(buffer.readUInt32LE(4) === 2, `Expected GLB v2, got v${buffer.readUInt32LE(4)}`);
  expect(buffer.readUInt32LE(8) === buffer.length, 'GLB declared length does not match file size');
  const jsonLength = buffer.readUInt32LE(12);
  expect(buffer.toString('ascii', 16, 20) === 'JSON', 'First GLB chunk is not JSON');
  expect(20 + jsonLength <= buffer.length, 'GLB JSON chunk extends past end of file');
  const json = JSON.parse(buffer.toString('utf8', 20, 20 + jsonLength).replace(/\u0000+|\s+$/g, ''));
  return json;
}

function descendants(json, rootIndex) {
  const found = [];
  const todo = [...(json.nodes[rootIndex]?.children ?? [])];
  while (todo.length) {
    const index = todo.shift();
    found.push(index);
    todo.push(...(json.nodes[index]?.children ?? []));
  }
  return found;
}

function meshTriangleCount(json, meshIndex) {
  const mesh = json.meshes?.[meshIndex];
  if (!mesh) return 0;
  return (mesh.primitives ?? []).reduce((total, primitive) => {
    const accessorIndex = primitive.indices ?? primitive.attributes?.POSITION;
    const count = json.accessors?.[accessorIndex]?.count ?? 0;
    return total + Math.floor(count / 3);
  }, 0);
}

function validateProductionGlb(buffer, job, preset) {
  const json = parseGlb(buffer);
  const nodes = json.nodes ?? [];
  expect(json.extensionsUsed?.includes('MSFT_lod'), 'GLB does not declare MSFT_lod');

  const lod0Index = nodes.findIndex((node) => /_LOD0$/.test(node.name ?? ''));
  expect(lod0Index >= 0, 'GLB has no _LOD0 node');
  const lod0 = nodes[lod0Index];
  const ids = lod0.extensions?.MSFT_lod?.ids;
  expect(Array.isArray(ids) && ids.length === 3, `Expected three MSFT_lod fallback ids, got ${ids?.length ?? 0}`);
  const chain = [lod0Index, ...ids];
  const lodNames = chain.map((index) => nodes[index]?.name ?? '');
  for (let rank = 0; rank < 4; rank++) {
    expect(lodNames[rank].endsWith(`_LOD${rank}`), `MSFT_lod rank ${rank} points to ${lodNames[rank] || '<unnamed>'}`);
  }
  const coverage = lod0.extras?.MSFT_screencoverage;
  expect(Array.isArray(coverage) && coverage.length === 4, 'MSFT_screencoverage must contain four entries');
  expect(coverage.every((value) => Number.isFinite(value) && value > 0 && value <= 1), 'Invalid MSFT_screencoverage values');

  const realLods = chain.slice(0, 3).map((nodeIndex, rank) => {
    const childIndices = descendants(json, nodeIndex);
    const meshes = [nodeIndex, ...childIndices].filter((index) => nodes[index]?.mesh != null);
    const cardMeshes = meshes.filter((index) => /(?:_leaves(?:$|_)|spine|frond|rosette|card)/i.test(nodes[index]?.name ?? ''));
    return {
      rank,
      name: nodes[nodeIndex].name,
      meshCount: meshes.length,
      cardMeshCount: cardMeshes.length,
      triangles: meshes.reduce((sum, index) => sum + meshTriangleCount(json, nodes[index].mesh), 0),
    };
  });
  expect(realLods.every((lod) => lod.meshCount > 0 && lod.triangles > 0), 'One or more real-geometry LODs are empty');
  expect(realLods.some((lod) => lod.cardMeshCount > 0), 'No baked instanced card/foliage mesh was exported');

  const billboardIndex = chain[3];
  const billboardChildren = descendants(json, billboardIndex);
  const billboardCards = billboardChildren.filter((index) => /^billboard_(front|side)$/.test(nodes[index]?.name ?? ''));
  expect(billboardCards.length === 2, `Expected front+side billboard cards, got ${billboardCards.length}`);
  expect(billboardCards.every((index) => nodes[index].mesh != null), 'A billboard card has no mesh');
  const billboardMaterials = [...new Set(billboardCards.flatMap((index) =>
    (json.meshes[nodes[index].mesh]?.primitives ?? []).map((primitive) => primitive.material).filter(Number.isInteger),
  ))];
  expect(billboardMaterials.length === 2, `Expected two billboard materials, got ${billboardMaterials.length}`);
  expect(billboardMaterials.every((index) => json.materials?.[index]?.pbrMetallicRoughness?.baseColorTexture),
    'A billboard material is missing its GPU-baked albedo texture');
  expect((json.images?.length ?? 0) > 0 && json.images.every((image) => image.bufferView != null || image.uri),
    'GLB has no valid embedded images');

  return {
    format: json.asset?.version,
    generator: json.asset?.generator ?? null,
    sourcePreset: basename(job.preset),
    species: preset.species,
    seed: preset.controls.seed,
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    extensionsUsed: json.extensionsUsed ?? [],
    lodNames,
    screenCoverage: coverage,
    realLods,
    billboard: {
      node: nodes[billboardIndex].name,
      cards: billboardCards.map((index) => nodes[index].name),
      materials: billboardMaterials.length,
    },
    meshes: json.meshes?.length ?? 0,
    materials: json.materials?.length ?? 0,
    textures: json.textures?.length ?? 0,
    images: json.images?.length ?? 0,
  };
}

await mkdir(outputDir, { recursive: true });
await mkdir(stagingDir, { recursive: true });
for (const job of jobs) {
  const preset = JSON.parse(await readFile(job.preset, 'utf8'));
  expect(preset.format === 'seedthree-preset/1', `${job.preset} is not a SeedThree v1 preset`);
  expect(preset.species === job.speciesKey, `${job.preset} has species ${preset.species}, expected ${job.speciesKey}`);
  expect(Number(preset.controls?.seed) === 555, `${job.preset} is not seed 555`);
  job.presetData = preset;
}

console.log(`[seedthree] Connecting to isolated Chrome on CDP port ${cdpPort}`);
const cdp = await connectToSeedThree();
const browserProblems = [];
cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
  const message = exceptionDetails?.exception?.description ?? exceptionDetails?.text ?? 'Runtime exception';
  browserProblems.push(message);
  console.error(`[browser exception] ${message}`);
});
cdp.on('Log.entryAdded', ({ entry }) => {
  if (entry?.level === 'error') {
    browserProblems.push(entry.text);
    console.error(`[browser log] ${entry.text}`);
  }
});
cdp.on('Runtime.consoleAPICalled', ({ type, args: consoleArgs }) => {
  const message = (consoleArgs ?? []).map((item) => item.value ?? item.description ?? '').join(' ');
  if (/\[SeedThree\]|GLB export|preset/i.test(message)) console.log(`[browser ${type}] ${message}`);
});

const reports = [];
try {
  await Promise.all([
    cdp.call('Page.enable'),
    cdp.call('Runtime.enable'),
    cdp.call('DOM.enable'),
    cdp.call('Log.enable'),
  ]);
  await setDownloadDirectory(cdp);
  await cdp.call('Page.navigate', { url: appUrl });
  await waitFor('SeedThree initial production build', async () => {
    const state = await pageState(cdp);
    if (state.error) throw new Error(state.error);
    return state.readyState === 'complete' && state.hasLoad && state.hasExport && !state.loading;
  });
  console.log('[seedthree] Browser UI is ready');

  const seenDownloads = new Set(await currentGlbs());
  for (const job of jobs) {
    await loadPreset(cdp, job, job.presetData);
    console.log(`[seedthree] Invoking production Download .glb for ${job.id}`);
    await clickProductionExport(cdp);
    const downloaded = await waitForNewDownload(cdp, seenDownloads);
    seenDownloads.add(downloaded);
    const buffer = await readFile(downloaded);
    const report = validateProductionGlb(buffer, job, job.presetData);
    const destination = resolve(outputDir, job.output);
    await copyFile(downloaded, destination);
    const copied = await readFile(destination);
    expect(createHash('sha256').update(copied).digest('hex') === report.sha256, `Copy verification failed for ${destination}`);
    report.file = destination;
    report.downloadName = basename(downloaded);
    reports.push(report);
    console.log(`[seedthree] Validated ${job.output}: ${(report.bytes / 1024 / 1024).toFixed(2)} MiB, ${report.lodNames.join(' -> ')}`);
  }

  const manifest = {
    format: 'eanpa-seedthree-browser-exports/1',
    generatedAt: new Date().toISOString(),
    sourceApp: appUrl,
    cdpPort,
    stagingDir,
    browserProblems,
    exports: reports,
  };
  const manifestPath = resolve(outputDir, 'seed555-exports.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[seedthree] Wrote validation manifest: ${manifestPath}`);
} finally {
  cdp.close();
}
