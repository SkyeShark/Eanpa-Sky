import assert from 'node:assert/strict';
import test from 'node:test';
import { createConvexReceiverIds } from '../src/reflection_receiver_id.js';

test('only explicitly convex groups reject their own reflection hits', () => {
    const id = createConvexReceiverIds();
    const shell = { userData: { ssrConvexGroup: 'orb' } };
    const engraving = { userData: { ssrConvexGroup: 'orb' } };
    const other = { userData: { ssrConvexGroup: 'other' } };
    assert.ok(id(shell) > 1);
    assert.equal(id(shell), id(engraving));
    assert.notEqual(id(shell), id(other));
    assert.equal(id({ userData: {} }), 1, 'ordinary concave meshes retain self reflections');
    assert.equal(id({ ...shell, isInstancedMesh: true }), 1, 'instances can reflect one another');
    assert.equal(id({ ...shell, isBatchedMesh: true }), 1);
});

test('receiver IDs stay exactly representable in half-float storage without recycling', () => {
    const id = createConvexReceiverIds();
    const first = { userData: { ssrConvexGroup: 'first' } };
    assert.equal(id(first), 2);
    for (let index = 1; index < 2046; index++) {
        assert.equal(id({ userData: { ssrConvexGroup: String(index) } }), index + 2);
    }
    assert.equal(id({ userData: { ssrConvexGroup: 'overflow' } }), 1);
    assert.equal(id(first), 2);
});
