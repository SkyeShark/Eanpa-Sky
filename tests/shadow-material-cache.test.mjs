import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeMaterial } from '../vendor/three/three.webgpu.js';
import { installShadowMaterialCache } from '../src/shadow_material_cache.js';

function harness() {
    const base = new NodeMaterial(); base.isShadowPassMaterial = true;
    const opaque = new NodeMaterial(), cutout = new NodeMaterial(); cutout.alphaTest = 0.5;
    const scene = { overrideMaterial: base }, draws = [];
    const renderer = { renderObject(object, scene, camera, geometry, source) {
        const material = scene.overrideMaterial;
        material.alphaTest = source.alphaTest;
        draws.push({ material, version: material.version });
        if (object.fail) throw new Error('draw failed');
    } };
    const original = renderer.renderObject;
    const cache = installShadowMaterialCache(renderer);
    const draw = (source, object = {}) => renderer.renderObject(object, scene, {}, {}, source);
    return { base, opaque, cutout, scene, renderer, original, cache, draws, draw };
}
test('alternating opaque and cutout shadows keep independent stable material versions', () => {
    const h = harness();
    for (let frame = 0; frame < 5; frame++) { h.draw(h.opaque); h.draw(h.cutout); }
    assert.notEqual(h.draws[0].material, h.draws[1].material);
    assert.equal(h.draws[0].material, h.draws[8].material);
    assert.equal(h.draws[1].version, h.draws[9].version);
    assert.equal(h.base.version, 0);
    assert.equal(h.cache.stats.variants, 2);
    h.cache.dispose();
});
test('source changes and custom shadow roots still invalidate their variant', () => {
    const h = harness(); h.draw(h.cutout);
    const first = h.draws.at(-1);
    h.cutout.alphaTest = 0; h.draw(h.cutout);
    assert.equal(h.draws.at(-1).material.alphaTest, 0);
    assert.ok(h.draws.at(-1).version > first.version);
    h.draw(h.opaque);
    const opaqueVariant = h.draws.at(-1).material;
    h.base.positionNode = { custom: true }; h.draw(h.opaque);
    assert.equal(h.draws.at(-1).material, opaqueVariant);
    assert.equal(h.draws.at(-1).material.positionNode, h.base.positionNode);
    h.cache.dispose();
});
test('failed draws restore the override and disposing owners releases variants', () => {
    const h = harness();
    assert.throws(() => h.draw(h.opaque, { fail: true }), /draw failed/);
    assert.equal(h.scene.overrideMaterial, h.base);
    h.draw(h.cutout); h.cutout.dispose();
    assert.equal(h.cache.stats.variants, 1);
    h.base.dispose(); assert.equal(h.cache.stats.variants, 0);
    h.cache.dispose(); h.cache.dispose();
    assert.equal(h.renderer.renderObject, h.original);
});
