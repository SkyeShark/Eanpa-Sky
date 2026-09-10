// Pure arithmetic helpers become reusable WGSL functions. Inlining this
// lattice at every FBM/light-march call produced half-megabyte cloud shaders.
// Keep uniforms and textures outside these layouts; all inputs are explicit.
export function makeAnalyticSkyNoise(T) {
    const {Fn, vec3, float, fract, floor, mix, dot} = T;
    const hash = p => {
        const q = fract(p.mul(0.3183099).add(vec3(0.1, 0.17, 0.13))).mul(17);
        return fract(q.x.mul(q.y).mul(q.z).mul(q.x.add(q.y).add(q.z)));
    };
    const noise3A = Fn(([p]) => {
        const i = floor(p), f = fract(p);
        const sm = f.mul(f).mul(float(3).sub(f.mul(2)));
        const nx0 = mix(hash(i), hash(i.add(vec3(1, 0, 0))), sm.x);
        const nx1 = mix(hash(i.add(vec3(0, 1, 0))), hash(i.add(vec3(1, 1, 0))), sm.x);
        const nx2 = mix(hash(i.add(vec3(0, 0, 1))), hash(i.add(vec3(1, 0, 1))), sm.x);
        const nx3 = mix(hash(i.add(vec3(0, 1, 1))), hash(i.add(vec3(1, 1, 1))), sm.x);
        return mix(mix(nx0, nx1, sm.y), mix(nx2, nx3, sm.y), sm.z);
    }).setLayout({name: 'eanpaSkyNoise3', type: 'float', inputs: [{name: 'p', type: 'vec3'}]});
    const rotate = p => vec3(dot(p, vec3(0, 0.8, 0.6)),
        dot(p, vec3(-0.8, 0.36, -0.48)), dot(p, vec3(-0.6, -0.48, 0.64)));
    const fbm3A = Fn(([p]) => {
        const pp = p.toVar();
        const f = noise3A(pp).mul(0.5).toVar();
        pp.assign(rotate(pp).mul(2.02));
        f.addAssign(noise3A(pp).mul(0.25));
        pp.assign(rotate(pp).mul(2.03));
        f.addAssign(noise3A(pp).mul(0.125));
        return f;
    }).setLayout({name: 'eanpaSkyFbm3', type: 'float', inputs: [{name: 'p', type: 'vec3'}]});
    return {noise3A, fbm3A};
}
