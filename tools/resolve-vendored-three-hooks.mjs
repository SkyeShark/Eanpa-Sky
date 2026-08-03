// Node module-resolution hooks mapping the bare three specifiers onto the
// vendored r184 build — the Node twin of index.html's browser import map.
// Audits that import REAL src/ modules (which use bare 'three/tsl', e.g.
// src/materials/noise.js via texture_base.js) register this before the dynamic
// import; without it Node walks up to an unrelated globally installed three of
// a different revision and mixes incompatible node classes into one graph.
// The mapped file URLs are identical to the audits' own static relative
// imports, so Node's module cache hands back the SAME vendored instance.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDORED = new Map([
    ['three', path.join(ROOT, 'vendor', 'three', 'three.webgpu.js')],
    ['three/webgpu', path.join(ROOT, 'vendor', 'three', 'three.webgpu.js')],
    ['three/tsl', path.join(ROOT, 'vendor', 'three', 'three.tsl.js')],
]);

export function resolve(specifier, context, nextResolve) {
    const mapped = VENDORED.get(specifier);
    if (mapped) return { url: pathToFileURL(mapped).href, shortCircuit: true };
    return nextResolve(specifier, context);
}
