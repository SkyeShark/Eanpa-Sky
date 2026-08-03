#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const [, , userPath, runtimePath, outputPath] = process.argv;
if (!userPath || !runtimePath || !outputPath) {
  console.error('usage: node tools/diff-ziggurat-area-reports.mjs USER.json RUNTIME.json OUTPUT.json');
  process.exit(2);
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const user = readJson(userPath);
const runtime = readJson(runtimePath);
const byName = (items) => new Map(items.map((item) => [item.name, item]));
const stable = (value) => JSON.stringify(value);

const userObjects = byName(user.objects);
const runtimeObjects = byName(runtime.objects);
const names = [...new Set([...userObjects.keys(), ...runtimeObjects.keys()])].sort();

const objectDiffs = [];
for (const name of names) {
  const current = userObjects.get(name);
  const previous = runtimeObjects.get(name);
  if (!previous) {
    objectDiffs.push({ status: 'user_only', name, user: current });
    continue;
  }
  if (!current) {
    objectDiffs.push({ status: 'runtime_only', name, runtime: previous });
    continue;
  }

  const fields = {};
  for (const key of [
    'type', 'data', 'parent', 'collections', 'matrix_world', 'dimensions',
    'hide_render', 'hide_viewport', 'instance_collection', 'materials',
    'modifiers', 'custom_properties',
  ]) {
    if (stable(current[key]) !== stable(previous[key])) {
      fields[key] = { user: current[key], runtime: previous[key] };
    }
  }

  if (current.type === 'MESH' && previous.type === 'MESH') {
    const currentMesh = user.meshes[current.data];
    const previousMesh = runtime.meshes[previous.data];
    const mesh = {};
    for (const key of [
      'vertices', 'edges', 'polygons', 'loops', 'triangles', 'bounds',
      'position_hash', 'topology_hash', 'smooth_hash', 'sharp_hash',
      'corner_normal_hash', 'normals_domain', 'attributes', 'uv_layers',
      'degenerate_faces', 'nonmanifold_edges', 'signed_volume', 'face_area',
      'custom_properties',
    ]) {
      if (stable(currentMesh?.[key]) !== stable(previousMesh?.[key])) {
        mesh[key] = { user: currentMesh?.[key], runtime: previousMesh?.[key] };
      }
    }
    if (Object.keys(mesh).length) fields.mesh = mesh;
  }

  objectDiffs.push({
    status: Object.keys(fields).length ? 'changed' : 'unchanged',
    name,
    fields,
  });
}

const summarize = (status) => objectDiffs.filter((item) => item.status === status).length;
const report = {
  basis: {
    user: { source: user.source, bytes: user.bytes, sha256: user.sha256 },
    runtime: { source: runtime.source, bytes: runtime.bytes, sha256: runtime.sha256 },
    limitation: 'No prior whole-area user snapshot exists; runtime architecture is the structural before-state.',
  },
  summary: {
    user_only: summarize('user_only'),
    runtime_only: summarize('runtime_only'),
    changed: summarize('changed'),
    unchanged: summarize('unchanged'),
  },
  object_diffs: objectDiffs,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(outputPath);
console.log(JSON.stringify(report.summary));
