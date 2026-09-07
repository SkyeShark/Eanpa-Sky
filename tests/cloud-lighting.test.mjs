import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../engine/sky_system.js', import.meta.url), 'utf8');
const start = source.indexOf('wrapCloudShadows(sceneRoot,');
const end = source.indexOf('// JS: sun dimming factor', start);
assert.ok(start >= 0 && end > start);
const makeWrapper = Function('scene', 'sys', 'T3', 'cloudShadowSun', 'cloudShadowRoots', 'console',
    `return ({ ${source.slice(start, end)} });`);
const restoreStart = source.indexOf('for (const [material, roots] of cloudShadowRoots)');
const restoreEnd = source.indexOf('cloudShadowRoots.clear();', restoreStart) + 'cloudShadowRoots.clear();'.length;
assert.ok(restoreStart >= 0 && restoreEnd > restoreStart);
const restore = Function('cloudShadowRoots', source.slice(restoreStart, restoreEnd));

function harness() {
    const colorNode = {}, alphaTestNode = {}, emissiveNode = {};
    const material = { isMeshStandardNodeMaterial: true, userData: {}, colorNode, alphaTestNode, emissiveNode,
        setupLightingModel() {
            return { direct(data) { return data; }, indirect: 'native indirect response' };
        } };
    const root = { traverse(callback) { callback({ isMesh: true, material, userData: {} }); } };
    const celestial = {}, localLight = {}, roots = new Map();
    const wrapper = makeWrapper(root, { domes: [], tslCloudShadow: () => 0.4 }, { positionWorld: {} },
        celestial, roots, { log() {} });
    const original = material.setupLightingModel;
    wrapper.wrapCloudShadows(root, 1);
    const model = material.setupLightingModel({});
    const lightColor = { mul(factor) { return factor; } };
    const data = light => ({ lightNode: { light }, lightColor, reflectedLight: {} });
    return { material, colorNode, alphaTestNode, emissiveNode, celestial, localLight, roots, root,
        wrapper, original, model, data };
}

test('cloud shadows attenuate the celestial direct light and preserve native material/indirect response', () => {
    const h = harness(), input = h.data(h.celestial);
    const shaded = h.model.direct(input, { object: { userData: {} } });
    assert.equal(shaded.lightColor, 0.4);
    assert.equal(shaded.reflectedLight, input.reflectedLight);
    assert.notEqual(shaded, input, 'a shared light input is not mutated');
    assert.equal(h.material.colorNode, h.colorNode);
    assert.equal(h.material.alphaTestNode, h.alphaTestNode);
    assert.equal(h.material.emissiveNode, h.emissiveNode);
    assert.equal(h.model.indirect, 'native indirect response');
});

test('local lights and objects excluded from cloud shadows keep their direct light', () => {
    const h = harness();
    const local = h.data(h.localLight), excluded = h.data(h.celestial);
    assert.equal(h.model.direct(local, { object: { userData: {} } }), local);
    assert.equal(h.model.direct(excluded, { object: { userData: { noCloudShadow: true } } }), excluded,
        'shared materials respect per-object exclusion');
});

test('repeated wrapping does not stack attenuation and retains the original for disposal', () => {
    const h = harness(), wrapped = h.material.setupLightingModel;
    h.wrapper.wrapCloudShadows(h.root, 1);
    assert.equal(h.material.setupLightingModel, wrapped);
    assert.equal(h.roots.size, 1);
    assert.equal(h.roots.get(h.material).original, h.original);
});

test('sky disposal restores its direct-light wrapper without overwriting a later owner', () => {
    const h = harness();
    restore(h.roots);
    assert.equal(h.material.setupLightingModel, h.original);
    assert.equal(h.roots.size, 0);
    const other = harness(), laterOwner = () => ({});
    other.material.setupLightingModel = laterOwner;
    restore(other.roots);
    assert.equal(other.material.setupLightingModel, laterOwner);
    assert.equal(other.roots.size, 0);
});

test('imported PBR materials carry cloud lighting through renderer node conversion and restore cleanly', () => {
    const h = harness();
    for (const physical of [false, true]) {
        const material = { isMeshStandardMaterial: true, isMeshPhysicalMaterial: physical, userData: {} };
        const nativeModel = () => ({ direct: data => data, physical });
        const root = { traverse(cb) { cb({ isMesh: true, material, userData: {} }); } };
        const roots = new Map();
        const T3 = { positionWorld: {},
            MeshStandardNodeMaterial: { prototype: { setupLightingModel: nativeModel } },
            MeshPhysicalNodeMaterial: { prototype: { setupLightingModel: nativeModel } } };
        makeWrapper(root, { domes: [], tslCloudShadow: () => 0.4 }, T3, h.celestial, roots,
            { log() {} }).wrapCloudShadows(root);
        // Match the renderer library's enumerable-property conversion.
        const converted = Object.assign({}, material);
        const model = converted.setupLightingModel({});
        assert.equal(model.direct(h.data(h.celestial), { object: { userData: {} } }).lightColor, 0.4);
        assert.equal(model.physical, physical);
        restore(roots);
        assert.equal(Object.hasOwn(material, 'setupLightingModel'), false);
    }
});
