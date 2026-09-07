import test from 'node:test';
import assert from 'node:assert/strict';
import { installRebuildResourceCache } from '../src/rebuild_resource_cache.js';

function fixture() {
    const uploaded = new Set(), backingDeletes = [], disposals = [];
    const renderer = {
        backend: { delete(a) { backingDeletes.push(a); } },
        _attributes: { has:a=>uploaded.has(a), delete:a=>uploaded.delete(a) },
        _objects: { createRenderObject(geometry, inputs) {
            return { geometry, getAttributes:()=>inputs, onDispose() { disposals.push(this); },
                dispose() { this.onDispose(); } };
        } },
    };
    return { renderer, uploaded, backingDeletes, disposals, owner:installRebuildResourceCache(renderer) };
}
test('rebuild cleanup retires every draw and generated matrix column while retaining shared geometry', () => {
    const f=fixture(), position={}, backing={};
    const columns=Array.from({length:4},()=>({isInterleavedBufferAttribute:true,data:backing}));
    const geo={attributes:{position},index:{}};
    const a=f.renderer._objects.createRenderObject(geo,[position,...columns]);
    const b=f.renderer._objects.createRenderObject(geo,[position,...columns]);
    a.getAttributes();b.getAttributes();
    [position,...columns].forEach(x=>f.uploaded.add(x));
    f.owner.clear();
    assert.deepEqual([...f.uploaded],[position]);
    assert.deepEqual(f.backingDeletes,[backing]);
    assert.equal(f.disposals.length,2);
    a.dispose();assert.equal(f.disposals.length,2);
    assert.equal(f.owner.stats.releasedAttributes,4);
});
test('an attribute later used by geometry survives cleanup; disposed draws do not retain their buffers', () => {
    const f=fixture(), nodeAttribute={}, instance={};
    const draw=f.renderer._objects.createRenderObject({attributes:{}},[nodeAttribute,instance]);
    draw.getAttributes();draw.dispose();
    const next=f.renderer._objects.createRenderObject({attributes:{position:nodeAttribute}},[nodeAttribute]);
    next.getAttributes();f.uploaded.add(nodeAttribute);f.uploaded.add(instance);
    f.owner.dispose();f.owner.dispose();
    assert.deepEqual([...f.uploaded],[nodeAttribute]);
    assert.deepEqual(f.backingDeletes,[instance]);
    assert.equal(f.disposals.length,2);
    assert.equal(f.owner.stats.clears,1);
});
