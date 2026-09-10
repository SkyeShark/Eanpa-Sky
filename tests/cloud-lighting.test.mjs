import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {ringSolarVisibility} from '../engine/ring_eclipse.js';

const source = await readFile(new URL('../engine/sky_system.js', import.meta.url), 'utf8');
const start = source.indexOf('setSolarOcclusion(nodeFactory');
const end = source.indexOf('// JS: sun dimming factor', start);
assert.ok(start >= 0 && end > start);
const makeWrapper = Function('scene', 'sys', 'T3', 'cloudShadowSun', 'cloudShadowRoots', 'console', 'u',
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
    const sys = { domes: [], tslCloudShadow: () => 0.4 }, u = {moonLightK:{value:0}};
    const T3 = {positionWorld:{x:0,y:1.82,z:96}, mix:(a,b,k)=>a*(1-k.value)+b*k.value};
    const wrapper = makeWrapper(root, sys, T3, celestial, roots, { log() {} }, u);
    Object.assign(sys,wrapper);
    const original = material.setupLightingModel;
    wrapper.wrapCloudShadows(root, 1);
    const model = material.setupLightingModel({});
    const lightColor = { mul(factor) { return factor; } };
    const data = light => ({ lightNode: { light }, lightColor, reflectedLight: {} });
    return { material, colorNode, alphaTestNode, emissiveNode, celestial, localLight, roots, root,
        wrapper, original, model, data, sys, T3, u };
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

test('spatial eclipse follows each receiver, composes with clouds, and leaves local lights and moonlight intact',()=>{
    const h=harness(),color=value=>({value,mul(factor){return color(value*factor)}});
    const sun={x:.049,y:Math.sqrt(1-.049**2),z:0};
    h.wrapper.setSolarOcclusion(point=>ringSolarVisibility(point,sun));
    const wrapped=h.material.setupLightingModel;
    const input={lightNode:{light:h.celestial},lightColor:color(1)};
    const sample=(x,y,flags={})=>{
        Object.assign(h.T3.positionWorld,{x,y,z:96});
        return h.model.direct(input,{object:{userData:flags}}).lightColor.value;
    };
    assert.equal(sample(-200,0),0,'ground inside the moving shadow');
    assert.equal(sample(200,0),.4,'sunlit ground retains only cloud attenuation');
    assert.ok(sample(0,500)<sample(0,0),'roof uses its own ray through the ring');
    assert.equal(sample(200,0,{noCloudShadow:true}),1,'cloud opt-out does not remove solar coverage');
    assert.equal(sample(-200,0,{noSolarShadow:true}),.4,'solar opt-out retains cloud shading');
    const local={...input,lightNode:{light:h.localLight}};
    assert.equal(h.model.direct(local,{object:{userData:{}}}),local);
    h.u.moonLightK.value=1;assert.equal(sample(-200,0),.4,'planetshine remains cloud-shadowed, never eclipsed');
    h.wrapper.setSolarOcclusion(null);
    assert.equal(sample(-200,0),.4);assert.equal(h.material.setupLightingModel,wrapped,'changing an occluder never stacks wrappers');
});
