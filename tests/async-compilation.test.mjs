import test from 'node:test';
import assert from 'node:assert/strict';
import { WebGPURenderer, WebGPUBackend, Scene, PerspectiveCamera, Mesh, BoxGeometry,
    MeshBasicNodeMaterial, Layers, HalfFloatType, TSL } from '../vendor/three/three.webgpu.js';

// Node has no browser scheduler; keep the real compiler's yield boundaries.
globalThis.self = {scheduler: {yield: () => new Promise(resolve => setImmediate(resolve))}};

function compilerFixture({ count = 9, fail = -1 } = {}) {
    const scene = new Scene(), camera = new PerspectiveCamera();
    for (let i = 0; i < count; i++) {
        const mesh = new Mesh(new BoxGeometry(), new MeshBasicNodeMaterial());
        mesh.userData.index = i;
        // Precompilation must not cull using another camera's stale frustum.
        mesh.geometry.computeBoundingSphere = () => { throw Error('Frustum queried during compilation'); };
        scene.add(mesh);
    }
    const list = { opaque: [], transparent: [], transparentDoublePass: [],
        begin() { this.opaque.length = 0; }, finish() {},
        push(object, geometry, material, groupOrder, z, group) { this.opaque.push({object, material, group}); } };
    const stats = { active: 0, peak: 0, submitted: [], completed: [], after: [] };
    const context = { clippingContext: {updateGlobal() {}} };
    const renderer = {
        _initialized: true, _isPreCompiling: false, _renderTarget: null, _outputRenderTarget: null,
        _currentRenderContext: 'original-context', _handleObjectFunction: 'original-handler',
        _currentRenderObjectFunction: 'original-render', _compilationPromises: null,
        sortObjects: false, opaque: true, transparent: true, backend: {},
        _renderContexts: {get: () => context}, _renderLists: {get: () => list},
        _background: {update() {}}, _createObjectPipeline() {},
        _projectObject: WebGPURenderer.prototype._projectObject,
        _renderObjects(items, camera, scene) {
            for (const item of items) this._compilationPromises.push({...item, scene, camera});
        },
        _objects: {get: (object, material) => ({object, material})},
        _nodes: {
            nodeFrame: {renderId: 7, update() {}},
            async getForRenderAsync() { assert.equal(renderer._isPreCompiling, false); },
            updateBefore() { assert.equal(renderer._isPreCompiling, true); },
            updateForRender() {},
            updateAfter({object}) {
                assert.equal(renderer._isPreCompiling, true);
                assert.ok(stats.completed.includes(object.userData.index), 'GPU preparation precedes updateAfter');
                stats.after.push(object.userData.index);
            },
        },
        _geometries: {updateForRender() {}}, _bindings: {updateForRender() {}},
        _pipelines: {getForRender({object}, promises) {
            const index = object.userData.index;
            stats.submitted.push(index); stats.active++; stats.peak = Math.max(stats.peak, stats.active);
            promises.push(new Promise((resolve, reject) => setTimeout(() => {
                assert.equal(renderer._isPreCompiling, false, 'No renderer-wide flag survives an await');
                stats.active--; stats.completed.push(index);
                if (index === fail) reject(Error('Compilation failed')); else resolve();
            }, 30 + (index % 3) * 8)));
        }},
    };
    return {renderer, scene, camera, stats};
}

test('GPU compilation overlaps within a bounded queue and completes before returning', async () => {
    const f = compilerFixture();
    await WebGPURenderer.prototype.compileAsync.call(f.renderer, f.scene, f.camera);
    assert.equal(f.stats.peak, 4);
    assert.equal(f.stats.active, 0);
    assert.deepEqual(f.stats.after, [...Array(9).keys()]);
    assert.equal(f.renderer._isPreCompiling, false);
    assert.equal(f.renderer._currentRenderContext, 'original-context');
    assert.equal(f.renderer._handleObjectFunction, 'original-handler');
    assert.equal(f.renderer._nodes.nodeFrame.renderId, 7);
});

test('a failed compilation drains outstanding driver work and restores the renderer', async () => {
    const f = compilerFixture({fail: 2});
    await assert.rejects(WebGPURenderer.prototype.compileAsync.call(f.renderer, f.scene, f.camera), /Compilation failed/);
    assert.equal(f.stats.active, 0);
    assert.equal(f.renderer._isPreCompiling, false);
    assert.equal(f.stats.submitted.length, 4);
    assert.deepEqual(f.stats.after, [0, 1, 3]);
});

test('offscreen compilation uses the target depth and stencil contract', async () => {
    const f = compilerFixture({count: 1});
    const target = {depthBuffer: false, stencilBuffer: true};
    Object.assign(f.renderer, {depth: true, stencil: false, _renderTarget: target,
        _textures: {updateRenderTarget() {}, get: () => ({textures: [], depthTexture: null})}});
    await WebGPURenderer.prototype.compileAsync.call(f.renderer, f.scene, f.camera);
    const context = f.renderer._renderContexts.get();
    assert.equal(context.renderTarget, target);
    assert.equal(context.depth, false);
    assert.equal(context.stencil, true);
});

function passFixture() {
    const scene = new Scene(), camera = new PerspectiveCamera();
    const pass = TSL.pass(scene, camera, {samples: 0});
    pass.contextNode = TSL.context({eanpaReflectionSurfacePass: true});
    pass.overrideMaterial = new MeshBasicNodeMaterial();
    const layers = new Layers(); layers.set(3); pass.setLayers(layers);
    pass.transparent = false;
    let target = {name: 'previous-target'}, mrt = {name: 'previous-mrt'};
    const renderer = {
        contextNode: TSL.context({inheritedValue: 12}), transparent: true, opaque: true, autoClear: false,
        samples: 4, reversedDepthBuffer: false,
        getOutputBufferType: () => HalfFloatType, getOutputRenderTarget: () => null,
        getRenderTarget: () => target, setRenderTarget: value => { target = value; },
        getMRT: () => mrt, setMRT: value => { mrt = value; },
        getPixelRatio: () => 1, getSize: value => value.set(320, 180),
    };
    return {pass, renderer, scene, camera};
}

test('a pass compiles and renders with the identical merged context and attachment format', async () => {
    const {pass, renderer, scene, camera} = passFixture();
    const outerContext = renderer.contextNode, outerTarget = renderer.getRenderTarget();
    let compiledContext;
    const check = () => {
        assert.equal(renderer.getRenderTarget(), pass.renderTarget);
        assert.equal(renderer.getRenderTarget().texture.type, HalfFloatType);
        assert.equal(renderer.getRenderTarget().samples, 0);
        assert.equal(renderer.contextNode.getFlowContextData().inheritedValue, 12);
        assert.equal(renderer.contextNode.getFlowContextData().eanpaReflectionSurfacePass, true);
        assert.equal(scene.overrideMaterial, pass.overrideMaterial);
        assert.equal(camera.layers.mask, 8);
        assert.equal(renderer.transparent, false);
    };
    renderer.compileAsync = async () => { check(); compiledContext = renderer.contextNode; };
    renderer.render = () => { check(); assert.equal(renderer.contextNode, compiledContext); };
    await pass.compileAsync(renderer);
    pass.updateBefore({renderer});
    assert.equal(renderer.contextNode, outerContext);
    assert.equal(renderer.getRenderTarget(), outerTarget);
    assert.equal(renderer.transparent, true);
    assert.equal(scene.overrideMaterial, null);
    assert.equal(camera.layers.mask, 1);
    pass.dispose();
});

test('a rejected pass compilation restores its parent render state', async () => {
    const {pass, renderer, scene, camera} = passFixture();
    const outerContext = renderer.contextNode, outerTarget = renderer.getRenderTarget(), outerMrt = renderer.getMRT();
    renderer.compileAsync = async () => { throw Error('Pass failed'); };
    await assert.rejects(pass.compileAsync(renderer), /Pass failed/);
    assert.equal(renderer.contextNode, outerContext);
    assert.equal(renderer.getRenderTarget(), outerTarget);
    assert.equal(renderer.getMRT(), outerMrt);
    assert.equal(renderer.transparent, true);
    assert.equal(scene.overrideMaterial, null);
    assert.equal(camera.layers.mask, 1);
    pass.dispose();
});

test('overlapping driver compilations keep their own validation errors', async t => {
    const backend = new WebGPUBackend(), completions = [], scopes = [], events = [];
    backend.attributeUtils.createShaderVertexBuffers = () => [];
    backend.utils.getCurrentColorFormat = () => 'rgba8unorm';
    backend.utils.getCurrentDepthStencilFormat = () => 'depth32float';
    Object.assign(backend.pipelineUtils, {_getColorWriteMask: () => 15,
        _getPrimitiveState: () => ({}), _getDepthCompare: () => 'less', _getSampleCount: () => 1});
    backend.device = {
        createPipelineLayout: () => ({}),
        pushErrorScope() { scopes.push({}); events.push('push'); },
        createRenderPipelineAsync(descriptor) {
            const index = completions.length;
            scopes.at(-1).index = index; events.push('create' + index);
            return new Promise((resolve, reject) => completions.push({resolve, reject, descriptor}));
        },
        popErrorScope() {
            const {index} = scopes.pop(); events.push('pop' + index);
            return Promise.resolve(index === 1 ? {message: 'invalid second descriptor'} : null);
        },
    };
    const messages = [];
    t.mock.method(console, 'error', (...args) => messages.push(args.join(' ')));
    const pipelines = [], promises = [];
    for (let i = 0; i < 3; i++) {
        const pipeline = {vertexProgram: {}, fragmentProgram: {}}; pipelines.push(pipeline);
        const material = new MeshBasicNodeMaterial(); material.name = 'scope' + i;
        backend.createRenderPipeline({object: {}, material, geometry: {}, pipeline,
            context: {textures: null, depth: false, stencil: false}, getBindings: () => []}, promises);
    }
    assert.deepEqual(events, ['push', 'create0', 'pop0', 'push', 'create1', 'pop1', 'push', 'create2', 'pop2']);
    completions[2].reject(Error('third compilation rejected'));
    completions[0].resolve({name: 'first'}); completions[1].resolve({name: 'second'});
    await Promise.all(promises);
    assert.equal(backend.get(pipelines[0]).error, undefined);
    assert.equal(backend.get(pipelines[0]).pipeline.name, 'first');
    assert.equal(backend.get(pipelines[1]).error, true);
    assert.equal(backend.get(pipelines[2]).error, true);
    assert.ok(messages.some(m => m.includes('invalid second descriptor')));
    assert.ok(messages.some(m => m.includes('third compilation rejected')));
});
