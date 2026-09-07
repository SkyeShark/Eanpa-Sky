import { makeFragmentMotion } from './fragment_motion.js';

// ASTEROID MOON — bake-once asset pipeline + thin runtime loader.
// Recipe (Skye): subdivided irregular chunk → tileable height + MATCHING
// albedo (AI-generated) → TESSELLATED HIGH-POLY (analytic potato evaluated
// per sub-vertex, NOT interpolated) displaced from the height into REAL
// crater geometry → bake down to the runtime mesh's 1:1 UV: shaded albedo
// (cavity + slope, light-neutral) AND an OBJECT-SPACE NORMAL atlas from the
// high-poly — crater interiors then shade dynamically under the moving sun,
// which is where the depth read comes from (vertex displacement alone on a
// runtime-density mesh leaves craters as painted shadow-circles).
// Bake runs ONCE via bakeAsteroidMoon (a tool, not engine behavior); the
// engine only ever loads the three artifacts with makeAsteroidMoon.
//
// BAKE (once, from a browser bake scene):
//   const directory = await showDirectoryPicker();
//   const writeArtifact = async (name, data) => {
//       const file = await directory.getFileHandle(name, { create: true });
//       const output = await file.createWritable();
//       await output.write(data); await output.close();
//   };
//   const out = await globalThis.bakeAsteroidMoon({ renderer,
//       textures: { height, albedo }, writeArtifact });
//   → writes asteroid_moon_mesh.f32 + asteroid_moon_baked.png +
//     asteroid_moon_normal.png; returns { mesh } for the lookdev turntable
// RUNTIME (any scene — ASSETS values are base64 CONTENT, decode the mesh
// with b64toArrayBuffer; load normal atlas WITHOUT srgb):
//   const moon = await globalThis.makeAsteroidMoon({ meshBytes, baked, normal });
//   scene.add(moon.mesh);   // unit-ish radius — scale/orbit is the scene's job

globalThis._asteroidGeoFromArrays = function (pos, norm, uvA) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvA, 2));
    return geo;
};

// CELESTIAL-BODY material (same treatment as the sky system's standard moon
// and rock planet): UNLIT self-emissive — scene lights/fog/aerial haze blow a
// lit Standard material out to a white blob at sky distances. Shading is the
// body's OWN analytic lambert: baked object-space normals rotated by the
// model matrix vs a sun-direction uniform, with a wrap floor for sky-shine.
// Feed uniforms per frame: sunDir (copy sky.sunDir), sunCol (palette sun).
globalThis._asteroidMoonMaterial = function (bakedTex, normalTex) {
    const T3 = THREE;
    const uSunDir = T3.uniform(new T3.Vector3(0, 0.4, -0.9).normalize());
    const uSunCol = T3.uniform(new T3.Color(1, 1, 1));
    const uGain = T3.uniform(2.0);
    const mat = new T3.MeshBasicNodeMaterial({ fog: false });
    const alb = T3.texture(bakedTex, T3.uv()).rgb;
    let lit;
    if (normalTex) {
        const nObj = T3.texture(normalTex, T3.uv()).xyz.mul(2).sub(1);
        const nWorld = T3.normalize(T3.modelWorldMatrix.mul(T3.vec4(nObj, 0)).xyz);
        lit = T3.max(T3.dot(nWorld, uSunDir), 0).mul(0.92).add(0.08);
    } else {
        const nWorld = T3.normalize(T3.modelWorldMatrix.mul(T3.vec4(T3.normalLocal, 0)).xyz);
        lit = T3.max(T3.dot(nWorld, uSunDir), 0).mul(0.92).add(0.08);
    }
    mat.colorNode = alb.mul(lit).mul(uSunCol).mul(uGain);
    return { mat, uniforms: { sunDir: uSunDir, sunCol: uSunCol, gain: uGain } };
};

globalThis.bakeAsteroidMoon = async function ({ renderer, textures = {}, writeArtifact = null, opts = {} } = {}) {
    const T3 = THREE;
    const { vec2, vec3, float, texture, normalize, clamp, abs, attribute } = T3;
    const SEED = opts.seed ?? 7;
    const TILE = opts.tile ?? 2.2;
    const AMP = opts.reliefAmp ?? 0.055;
    const SQ = opts.squash ?? [1.15, 0.82, 1.0];
    const W = opts.bakeSize ?? 1024;
    const HSUB = opts.hiSub ?? 4;                    // high-poly: HSUB² sub-tris per base face
    for (const t of [textures.height, textures.albedo]) if (t) t.wrapS = t.wrapT = T3.RepeatWrapping;

    // ---- the analytic potato: radius as a pure function of direction, so
    // the high-poly evaluates the TRUE smooth surface at any density ----
    const h3 = (x, y, z) => {
        const v = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + SEED * 91.3) * 43758.5453;
        return v - Math.floor(v);
    };
    const vn3 = (x, y, z) => {
        const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
        const xf = x - xi, yf = y - yi, zf = z - zi;
        const s = (t) => t * t * (3 - 2 * t);
        const sx = s(xf), sy = s(yf), sz = s(zf);
        let acc = 0;
        for (let dz = 0; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
            acc += h3(xi + dx, yi + dy, zi + dz) * ((dx ? sx : 1 - sx) * (dy ? sy : 1 - sy) * (dz ? sz : 1 - sz));
        }
        return acc;
    };
    const potato = (d, out) => {
        const r = 1
            + (vn3(d.x * 1.4 + 9, d.y * 1.4, d.z * 1.4) - 0.5) * 0.52
            + (vn3(d.x * 3.1, d.y * 3.1 + 4, d.z * 3.1) - 0.5) * 0.18;
        return out.set(d.x * r * SQ[0], d.y * r * SQ[1], d.z * r * SQ[2]);
    };
    const uvOf = (d) => [Math.atan2(d.z, d.x) / (Math.PI * 2) + 0.5,
        Math.asin(Math.max(-1, Math.min(1, d.y))) / Math.PI + 0.5];
    const seamFix = (uvArr, count) => {
        for (let f = 0; f < count / 3; f++) {
            const u0 = uvArr[f * 6], u1 = uvArr[f * 6 + 2], u2 = uvArr[f * 6 + 4];
            if (Math.max(u0, u1, u2) - Math.min(u0, u1, u2) > 0.5) {
                for (let k = 0; k < 3; k++) if (uvArr[f * 6 + k * 2] < 0.5) uvArr[f * 6 + k * 2] += 1;
            }
        }
    };
    const smoothNormals = (g) => {
        g.computeVertexNormals();                    // flat on non-indexed — weld and average
        const p = g.getAttribute('position'), n = g.getAttribute('normal');
        const acc = new Map();
        const key = (i) => `${Math.round(p.getX(i) * 1e5)},${Math.round(p.getY(i) * 1e5)},${Math.round(p.getZ(i) * 1e5)}`;
        for (let i = 0; i < p.count; i++) {
            const k = key(i);
            let a = acc.get(k);
            if (!a) acc.set(k, a = [0, 0, 0]);
            a[0] += n.getX(i); a[1] += n.getY(i); a[2] += n.getZ(i);
        }
        for (let i = 0; i < p.count; i++) {
            const a = acc.get(key(i));
            const l = Math.hypot(a[0], a[1], a[2]) || 1;
            n.setXYZ(i, a[0] / l, a[1] / l, a[2] / l);
        }
    };

    // ---- height map → JS pixels (displacement source for both meshes) ----
    const hRT = new T3.RenderTarget(W, W, { depthBuffer: false });
    {
        const m = new T3.MeshBasicNodeMaterial();
        m.colorNode = texture(textures.height, T3.uv()).rgb;
        const s = new T3.Scene(); s.add(new T3.Mesh(new T3.PlaneGeometry(2, 2), m));
        const cam = new T3.OrthographicCamera(-1, 1, 1, -1, -1, 1);
        const prev = renderer.getRenderTarget?.();
        renderer.setRenderTarget(hRT);
        if (renderer.renderAsync) await renderer.renderAsync(s, cam);
        else renderer.render(s, cam);
        renderer.setRenderTarget(prev ?? null);
    }
    const hPix = await renderer.readRenderTargetPixelsAsync(hRT, 0, 0, W, W);
    const hAt = (u, x) => {
        const fx = (((u % 1) + 1) % 1) * W - 0.5, fy = (((x % 1) + 1) % 1) * W - 0.5;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0;
        const g = (xi, yi) => hPix[((((yi % W) + W) % W) * W + (((xi % W) + W) % W)) * 4] / 255;
        return g(x0, y0) * (1 - tx) * (1 - ty) + g(x0 + 1, y0) * tx * (1 - ty)
            + g(x0, y0 + 1) * (1 - tx) * ty + g(x0 + 1, y0 + 1) * tx * ty;
    };
    const triH = (p, n) => {
        const wx = Math.abs(n.x) ** 4, wy = Math.abs(n.y) ** 4, wz = Math.abs(n.z) ** 4;
        const ws = wx + wy + wz;
        return (hAt(p.y * TILE, p.z * TILE) * wx + hAt(p.x * TILE, p.z * TILE) * wy + hAt(p.x * TILE, p.y * TILE) * wz) / ws;
    };
    const displace = (g) => {
        const p = g.getAttribute('position'), n = g.getAttribute('normal');
        const v = new T3.Vector3(), nv = new T3.Vector3();
        for (let i = 0; i < p.count; i++) {
            v.fromBufferAttribute(p, i); nv.fromBufferAttribute(n, i);
            const h = (triH(v, nv) - 0.5) * AMP * 2;
            p.setXYZ(i, v.x + nv.x * h, v.y + nv.y * h, v.z + nv.z * h);
        }
        smoothNormals(g);                            // TRUE displaced normals
    };

    // ---- RUNTIME mesh: icosphere base, analytic potato, displaced ----
    // (NOTE: three's icosahedron detail = 20·(d+1)² faces, not 4^d)
    const geo = new T3.IcosahedronGeometry(1, opts.detail ?? 24).toNonIndexed();
    const basePos = geo.getAttribute('position');
    const baseCount = basePos.count;
    const baseDirs = new Float32Array(baseCount * 3); // unit dirs — the high-poly tessellates FROM THESE
    {
        const v = new T3.Vector3(), o = new T3.Vector3();
        for (let i = 0; i < baseCount; i++) {
            v.fromBufferAttribute(basePos, i).normalize();
            baseDirs[i * 3] = v.x; baseDirs[i * 3 + 1] = v.y; baseDirs[i * 3 + 2] = v.z;
            potato(v, o);
            basePos.setXYZ(i, o.x, o.y, o.z);
        }
    }
    smoothNormals(geo);
    const uvArr = new Float32Array(baseCount * 2);
    {
        const v = new T3.Vector3();
        for (let i = 0; i < baseCount; i++) {
            v.set(baseDirs[i * 3], baseDirs[i * 3 + 1], baseDirs[i * 3 + 2]);
            const [u, vv] = uvOf(v);
            uvArr[i * 2] = u; uvArr[i * 2 + 1] = vv;
        }
        seamFix(uvArr, baseCount);
    }
    geo.setAttribute('uv', new T3.BufferAttribute(uvArr, 2));
    displace(geo);

    // ---- HIGH-POLY: barycentric tessellation of each base face, with the
    // potato re-evaluated ANALYTICALLY at every sub-vertex (real smooth
    // surface, no base faceting), then displaced into real crater bowls ----
    const faces = baseCount / 3;
    const triPerFace = HSUB * HSUB;
    const hiCount = faces * triPerFace * 3;
    const hiPos = new Float32Array(hiCount * 3);
    const hiOpos = new Float32Array(hiCount * 3);
    const hiUv = new Float32Array(hiCount * 2);
    {
        const d0 = new T3.Vector3(), d1 = new T3.Vector3(), d2 = new T3.Vector3();
        const d = new T3.Vector3(), o = new T3.Vector3();
        let w = 0, wu = 0;
        const emit = (a, b) => {
            const c = 1 - a - b;
            d.set(
                baseDirs[fi * 9] * c + baseDirs[fi * 9 + 3] * a + baseDirs[fi * 9 + 6] * b,
                baseDirs[fi * 9 + 1] * c + baseDirs[fi * 9 + 4] * a + baseDirs[fi * 9 + 7] * b,
                baseDirs[fi * 9 + 2] * c + baseDirs[fi * 9 + 5] * a + baseDirs[fi * 9 + 8] * b,
            ).normalize();
            potato(d, o);
            hiPos[w] = o.x; hiPos[w + 1] = o.y; hiPos[w + 2] = o.z;
            hiOpos[w] = o.x; hiOpos[w + 1] = o.y; hiOpos[w + 2] = o.z;
            w += 3;
            const [u, vv] = uvOf(d);
            hiUv[wu] = u; hiUv[wu + 1] = vv; wu += 2;
        };
        var fi = 0;
        for (fi = 0; fi < faces; fi++) {
            for (let i = 0; i < HSUB; i++) {
                for (let j = 0; j < HSUB - i; j++) {
                    const a0 = i / HSUB, b0 = j / HSUB, s = 1 / HSUB;
                    emit(a0, b0); emit(a0 + s, b0); emit(a0, b0 + s);
                    if (j < HSUB - i - 1) { emit(a0 + s, b0); emit(a0 + s, b0 + s); emit(a0, b0 + s); }
                }
            }
        }
        seamFix(hiUv, hiCount);
    }
    const hiGeo = new T3.BufferGeometry();
    hiGeo.setAttribute('position', new T3.BufferAttribute(hiPos, 3));
    hiGeo.setAttribute('uv', new T3.BufferAttribute(hiUv, 2));
    smoothNormals(hiGeo);
    displace(hiGeo);                                 // REAL crater geometry
    console.log(`[asteroid_moon] high-poly for bake: ${hiCount / 3} tris`);

    // ---- bake twins: rasterize the HIGH poly in its UV space, writing
    // (1) shaded albedo (cavity + slope, light-neutral) and (2) the high
    // poly's OBJECT-SPACE normals — the runtime normal atlas ----
    const tri = (tex, p, n, scale) => {
        const wgt = abs(n).pow(4);
        const ws = wgt.x.add(wgt.y).add(wgt.z);
        return texture(tex, p.yz.mul(scale)).mul(wgt.x.div(ws))
            .add(texture(tex, p.xz.mul(scale)).mul(wgt.y.div(ws)))
            .add(texture(tex, p.xy.mul(scale)).mul(wgt.z.div(ws)));
    };
    const bakeGeo = new T3.BufferGeometry();
    {
        const flat = new Float32Array(hiCount * 3);
        for (let i = 0; i < hiCount; i++) { flat[i * 3] = hiUv[i * 2]; flat[i * 3 + 1] = hiUv[i * 2 + 1]; flat[i * 3 + 2] = 0; }
        bakeGeo.setAttribute('position', new T3.BufferAttribute(flat, 3));
        bakeGeo.setAttribute('opos', new T3.BufferAttribute(hiOpos, 3));
        bakeGeo.setAttribute('hnrm', hiGeo.getAttribute('normal'));
    }
    const runBake = async (mat, clearCol) => {
        const target = new T3.RenderTarget(W, W, { depthBuffer: false });
        target.texture.colorSpace = T3.NoColorSpace;
        const s = new T3.Scene();
        s.background = clearCol;
        s.add(new T3.Mesh(bakeGeo, mat));
        const wrapCopy = new T3.Mesh(bakeGeo, mat);  // seam faces live at u ∈ [1, 1.5]
        wrapCopy.position.x = -1;
        s.add(wrapCopy);
        const cam = new T3.OrthographicCamera(0, 1, 0, 1, -1, 1);   // WebGPU RTs get no flipY — orientation must match sampling
        const prev = renderer.getRenderTarget?.();
        renderer.setRenderTarget(target);
        if (renderer.renderAsync) await renderer.renderAsync(s, cam);
        else renderer.render(s, cam);
        renderer.setRenderTarget(prev ?? null);
        target.texture.wrapS = target.texture.wrapT = T3.RepeatWrapping;
        return target;
    };
    // (1) shaded albedo
    const albMat = new T3.MeshBasicNodeMaterial({ side: T3.DoubleSide, fog: false });
    {
        const op = attribute('opos', 'vec3');
        const n = normalize(op);
        const hC = tri(textures.height, op, n, TILE).r;
        const t1 = normalize(T3.cross(n, vec3(0.2, 1, 0.1)));
        const t2 = normalize(T3.cross(n, t1));
        const e = float(0.02);
        const h1t = tri(textures.height, op.add(t1.mul(e)), n, TILE).r;
        const h2t = tri(textures.height, op.sub(t1.mul(e)), n, TILE).r;
        const h3t = tri(textures.height, op.add(t2.mul(e)), n, TILE).r;
        const h4t = tri(textures.height, op.sub(t2.mul(e)), n, TILE).r;
        const hAvg = h1t.add(h2t).add(h3t).add(h4t).mul(0.25);
        const cavity = clamp(float(1).sub(hAvg.sub(hC).mul(5.5)), 0.5, 1.12);
        const slope = abs(h1t.sub(h2t)).add(abs(h3t.sub(h4t)));
        const slopeK = clamp(float(1).sub(slope.mul(1.6)), 0.72, 1);
        albMat.colorNode = tri(textures.albedo, op, n, TILE).rgb.mul(cavity).mul(slopeK);
    }
    const albRT = await runBake(albMat, new T3.Color(0.40, 0.36, 0.32));
    // (2) object-space normal atlas from the displaced high poly
    const nrmMat = new T3.MeshBasicNodeMaterial({ side: T3.DoubleSide, fog: false });
    nrmMat.colorNode = attribute('hnrm', 'vec3').mul(0.5).add(0.5);
    const nrmRT = await runBake(nrmMat, new T3.Color(0.5, 0.5, 0.5));

    // ---- optional browser artifact sink ----
    if (writeArtifact !== null && typeof writeArtifact !== 'function') {
        throw new TypeError('bakeAsteroidMoon writeArtifact must be a function');
    }
    if (writeArtifact) {
        const pos = geo.getAttribute('position'), nrm = geo.getAttribute('normal');
        const count = pos.count;
        const bytes = new Uint8Array(4 + count * 32);
        bytes.set(new Uint8Array(new Uint32Array([count]).buffer), 0);
        bytes.set(new Uint8Array(pos.array.buffer, pos.array.byteOffset, count * 12), 4);
        bytes.set(new Uint8Array(nrm.array.buffer, nrm.array.byteOffset, count * 12), 4 + count * 12);
        bytes.set(new Uint8Array(uvArr.buffer), 4 + count * 24);
        await writeArtifact('asteroid_moon_mesh.f32', new Blob(
            [bytes], { type: 'application/octet-stream' },
        ));
        const encodeAtlas = async (rt) => {
            const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, W);
            const flipped = new Uint8Array(px.length);   // readback bottom-up; canvas pixels top-down
            for (let y = 0; y < W; y++) flipped.set(px.subarray(y * W * 4, (y + 1) * W * 4), (W - 1 - y) * W * 4);
            const canvas = new OffscreenCanvas(W, W);
            const context = canvas.getContext('2d');
            if (!context) throw new Error('2D canvas unavailable for asteroid atlas encoding');
            const rgba = new Uint8ClampedArray(
                flipped.buffer, flipped.byteOffset, flipped.byteLength,
            );
            context.putImageData(new ImageData(rgba, W, W), 0, 0);
            return canvas.convertToBlob({ type: 'image/png' });
        };
        await writeArtifact('asteroid_moon_baked.png', await encodeAtlas(albRT));
        await writeArtifact('asteroid_moon_normal.png', await encodeAtlas(nrmRT));
        console.log(`[asteroid_moon] wrote browser artifacts: asteroid_moon_mesh.f32 + asteroid_moon_baked.png + asteroid_moon_normal.png (${count} runtime verts, ${hiCount / 3} bake tris)`);
    }

    // lookdev mesh straight from the live targets (celestial-body material)
    const built = globalThis._asteroidMoonMaterial(albRT.texture, nrmRT.texture);
    const mesh = new T3.Mesh(geo, built.mat);
    mesh.name = 'asteroid_moon';
    mesh.userData.noSupportCheck = true; mesh.userData.noWet = true;
    return { mesh, uniforms: built.uniforms };
};

// ---------- SHATTERED MOON (collab asset): load a GLB cluster of fragments
// (one big + mediums + small bits strung along an orbital streak), rewire
// every material to the celestial lambert (unlit self-shaded — scene-lit
// materials blow out to white at sky distance), and give each fragment a
// slow deterministic tumble. glbBytes = Uint8Array (ASSETS are base64
// content — decode with b64toArrayBuffer). update(t) drives the tumbles.
globalThis.makeShatteredMoon = async function ({ glbBytes, spread = 1.75 } = {}) {
    const T3 = THREE;
    const loader = new globalThis.GLTFLoader();
    const buf = glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength);
    const gltf = await loader.parseAsync(buf, '');
    const group = gltf.scene;
    const uSunDir = T3.uniform(new T3.Vector3(0, 0.4, -0.9).normalize());
    const uSunCol = T3.uniform(new T3.Color(1, 1, 1));
    const uGain = T3.uniform(2.0);
    const matCache = new Map();
    const sourceMaterials = new Set();
    const sourceTextures = new Set();
    const pieces = [];
    group.traverse((o) => {
        if (!o.isMesh) return;
        const src = o.material;
        if (src) {
            sourceMaterials.add(src);
            for (const value of Object.values(src)) if (value?.isTexture) sourceTextures.add(value);
        }
        if (!matCache.has(src)) {
            const m = new T3.MeshBasicNodeMaterial({ fog: false });
            const alb = src && src.map ? T3.texture(src.map, T3.uv()).rgb : T3.vec3(0.42, 0.38, 0.34);
            const nGeo = T3.normalize(T3.modelWorldMatrix.mul(T3.vec4(T3.normalLocal, 0)).xyz);
            let nW = nGeo;
            if (src && src.normalMap) {
                // baked normal atlas carries the 2.4M-tri sculpt on the 72k
                // low — without it the terminator shading is vertex-flat.
                // No tangent attribute in the GLB: Schuler cotangent frame
                // from screen-space derivatives.
                const nTex = T3.texture(src.normalMap, T3.uv()).xyz.mul(2).sub(1);
                const dp1 = T3.dFdx(T3.positionWorld), dp2 = T3.dFdy(T3.positionWorld);
                const duv1 = T3.dFdx(T3.uv()), duv2 = T3.dFdy(T3.uv());
                const dp2perp = T3.cross(dp2, nGeo), dp1perp = T3.cross(nGeo, dp1);
                const tangent = dp2perp.mul(duv1.x).add(dp1perp.mul(duv2.x));
                const bitangent = dp2perp.mul(duv1.y).add(dp1perp.mul(duv2.y));
                const invMax = T3.float(1).div(T3.sqrt(T3.max(T3.dot(tangent, tangent), T3.dot(bitangent, bitangent)).max(1e-12)));
                nW = T3.normalize(
                    tangent.mul(invMax).mul(nTex.x)
                        .add(bitangent.mul(invMax).mul(nTex.y))
                        .add(nGeo.mul(nTex.z))
                );
            }
            // celestial lambert: the terminator sweeps each chunk as the red
            // giant crosses the sky — real phases per fragment
            const incidence = T3.max(T3.dot(nW, uSunDir), 0);
            const emission = T3.max(T3.dot(nW, T3.normalize(T3.cameraPosition.sub(T3.positionWorld))), 0);
            // A Lommel-Seeliger/Lambert blend gives particulate regolith a
            // broad illuminated face and a defined terminator. A geometric
            // horizon guard stops mapped crater normals lighting the far side.
            const limb = T3.smoothstep(-0.025, 0.065, T3.dot(nGeo, uSunDir));
            const particulate = incidence.div(incidence.add(emission).max(0.05));
            const lit = particulate.mul(0.75).add(incidence.mul(0.25)).mul(limb).add(0.018);
            m.colorNode = alb.mul(lit).mul(uSunCol).mul(uGain);
            matCache.set(src, m);
        }
        o.material = matCache.get(src);
        o.userData.noSupportCheck = true; o.userData.noWet = true;
        pieces.push(o);
    });
    // Converted node materials retain the texture objects, not their source
    // GLTF material containers.
    for (const material of sourceMaterials) material.dispose?.();
    group.userData.noSupportCheck = true; group.userData.noWet = true;
    const h = (i, k) => { const v = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return v - Math.floor(v); };
    const fragmentMotion = makeFragmentMotion(T3, pieces, {spread});
    const basePos = fragmentMotion.basePositions;
    const heroIndex = fragmentMotion.heroIndex;
    fragmentMotion.update(0);

    // VOLUMETRIC accretion dust (Skye: not specks, not a ring — a soft
    // raymarched cloud, vaguely toroidal, that FOLLOWS the chaotic motion:
    // every fragment drags a cling-blob of dust via per-piece uniforms).
    const heroR = fragmentMotion.radii[heroIndex];
    // the sphere must cover the WHOLE fragment streak (Skye: dust read as a
    // blob centered on the hero — the old 2.3*heroR shell never even reached
    // the outer fragments, so their halos/streamers were clipped to nothing)
    const heroBaseJ = basePos[heroIndex];
    const arcXJ = Math.max(...basePos.map((b) => Math.abs(b.x - heroBaseJ.x)), heroR);
    const pieceRJ = fragmentMotion.radii;
    const RC = Math.max(heroR * 2.3, arcXJ * 1.2);
    // streak centroid (envelope center — NOT the hero: ref) in hero-space
    const centJ = basePos.reduce((a, b) => a.add(b), new T3.Vector3()).multiplyScalar(1 / basePos.length).sub(heroBaseJ);
    // contact-gap plume pairs: the 3 closest pairs among the 7 biggest
    // fragments — dust is emitted where chunks grind, not at body centers
    const bigJ = pieceRJ.map((r, i) => [i, r]).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([i]) => i);
    const pairsJ = [];
    for (let a = 0; a < bigJ.length; a++) for (let b = a + 1; b < bigJ.length; b++) {
        pairsJ.push([bigJ[a], bigJ[b], basePos[bigJ[a]].distanceTo(basePos[bigJ[b]])]);
    }
    pairsJ.sort((a, b) => a[2] - b[2]);
    const plumePairsJ = pairsJ.slice(0, 3);
    const uCamLocal = T3.uniform(new T3.Vector3(0, 0, 50));
    const uSunL = T3.uniform(new T3.Vector3(0, 1, 0));   // sun dir, dust-local (march-only)
    const uPlume = [0, 1, 2].map(() => T3.uniform(new T3.Vector3(0, 999, 0)));
    const uDustT = T3.uniform(0);
    const uPieceL = pieces.map(() => T3.uniform(new T3.Vector3(0, 999, 0)));
    // The march already accumulates premultiplied radiance. Keep Three from
    // multiplying RGB by opacity a second time, while retaining the standard
    // over operator for the framebuffer blend.
    const dustMat = new T3.MeshBasicNodeMaterial({
        transparent: true, depthWrite: false, side: T3.BackSide, fog: false,
        premultipliedAlpha: false,
        blending: T3.CustomBlending,
        blendEquation: T3.AddEquation,
        blendSrc: T3.OneFactor,
        blendDst: T3.OneMinusSrcAlphaFactor,
        blendEquationAlpha: T3.AddEquation,
        blendSrcAlpha: T3.OneFactor,
        blendDstAlpha: T3.OneMinusSrcAlphaFactor,
    });
    // deferred pipeline: transparent node materials MUST declare MRT aux
    // outputs or naga rejects the pipeline (invalid OutputType) and the
    // mesh silently never draws — same fix the shield ships with
    if (T3.mrt && !globalThis.EANPA_NO_MRT) dustMat.mrtNode = T3.mrt({ normal: T3.vec4(0), metalrough: T3.vec4(0) });   // EANPA: forward path — mrt stamps compile to empty structs in Chrome
    {
        const { vec2, vec3, float, fract, floor, mix, exp, dot, sqrt, max, min, normalize, smoothstep, clamp, Loop } = T3;
        // the 6 biggest chunks get collision-trail filaments (streamers)
        const streamIdx = pieceRJ.map((r, i) => [i, r])
            .filter(([i]) => i !== heroIndex).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([i]) => i);
        const h21v = (pp) => {
            const a = fract(vec3(pp.x, pp.y, pp.x).mul(0.1031));
            const d2 = dot(a, vec3(a.y, a.z, a.x).add(33.33));
            const b2 = a.add(d2);
            return fract(b2.x.add(b2.y).mul(b2.z));
        };
        const vn2 = (pp) => {
            const i2 = floor(pp), f2 = fract(pp);
            const sm = f2.mul(f2).mul(float(3).sub(f2.mul(2)));
            const A = h21v(i2), B = h21v(i2.add(vec2(1, 0)));
            const C = h21v(i2.add(vec2(0, 1))), D = h21v(i2.add(vec2(1, 1)));
            return mix(mix(A, B, sm.x), mix(C, D, sm.x), sm.y);
        };
        // cheap density proxy for the LIGHT taps (Beer's-law self-shadow):
        // streak + plumes + the 7 biggest skins — mass only, no froth (the
        // same trick the sky's shafts use: light is cast by MASSES)
        const densCheap = (pp) => {
            const ccx = pp.x.sub(centJ.x).div(arcXJ * 1.30);
            const ccy = pp.y.sub(centJ.y).div(heroR * 0.68);
            const ccz = pp.z.sub(centJ.z).div(heroR * 0.90);
            const ee = ccx.mul(ccx).add(ccy.mul(ccy)).add(ccz.mul(ccz));
            let d = float(1).div(ee.add(1.0)).mul(0.50);
            for (let pk = 0; pk < 3; pk++) {
                const dpl = pp.sub(uPlume[pk]);
                const q = dot(dpl, dpl).div(heroR * heroR * 0.35);
                d = d.add(float(1).div(q.mul(q).add(1.0)).mul(1.35));
            }
            for (const bi of bigJ) {
                const hw = Math.min(Math.max(pieceRJ[bi] * 2.2, heroR * 0.30), heroR * 0.85);
                const ds2 = pp.sub(uPieceL[bi]);
                d = d.add(exp(dot(ds2, ds2).div(hw * hw).negate()).mul(0.72));
            }
            return d;
        };
        const marchFn = T3.Fn(() => {
        const ro = uCamLocal;
        const rd = normalize(T3.positionLocal.sub(uCamLocal));
        const bq = dot(ro, rd);
        const cq = dot(ro, ro).sub(RC * RC);
        const discq = max(bq.mul(bq).sub(cq), 0.0);
        const sq = sqrt(discq);
        const t0 = max(bq.negate().sub(sq), 0.0);
        const t1 = max(bq.negate().add(sq), 0.0);
        const stepLen = t1.sub(t0).div(40);
        // phase is per-ray (mu constant along the ray): isotropic base +
        // forward-scatter lobe — backlit dust flares, comet-coma style
        const mu = dot(rd, uSunL);
        const muP = max(mu, 0.0);
        const phaseF = float(0.45).add(muP.mul(muP).mul(muP).mul(muP).mul(muP).mul(2.4));
        const cAcc = vec3(0, 0, 0).toVar();
        const aAcc = float(0).toVar();
        // house march pattern: no iterator — advance a toVar point manually
        // A linear fractional hash formed visible parallel marching bands.
        // Stable pixel PCG decorrelates adjacent rays without animated fizz.
        const pixel=T3.screenCoordinate;
        const jitr=T3.hash(T3.uint(pixel.x).add(T3.uint(pixel.y).mul(T3.uint(65537))));
        const p = ro.add(rd.mul(t0)).add(rd.mul(stepLen).mul(jitr.mul(0.9).add(0.05))).toVar();
        Loop({ start: 0, end: 40, type: 'int' }, () => {
            // clumpy irregular wisps — ~half the volume near-zero (ref:
            // F-ring kinks, beta Pic one-sided clumps; never a smooth fog).
            // Sign-safe squares: WGSL pow(negative, 2) is NaN.
            const n1 = vn2(vec2(p.x.mul(5.2 / RC).add(uDustT.mul(0.05)), p.z.mul(5.2 / RC)).add(p.y.mul(2.6 / RC)));
            const n2 = vn2(vec2(p.z.mul(9.5 / RC).sub(uDustT.mul(0.08)), p.y.mul(9.5 / RC).add(p.x.mul(3.5 / RC))));
            const n3 = vn2(vec2(p.x.mul(19.0 / RC).add(uDustT.mul(0.11)), p.y.mul(19.0 / RC).sub(p.z.mul(7.0 / RC))));
            const gate = smoothstep(float(0.16), float(0.85), n1.mul(0.50).add(n2.mul(0.30)).add(n3.mul(0.20)));
            // GRANULARITY: near-pixel speckle so the veil reads as countless
            // fine particles, not a smooth medium (Skye: granular + noisy)
            const n4 = vn2(vec2(p.x.mul(38.0 / RC).add(p.y.mul(17.0 / RC)).add(uDustT.mul(0.15)), p.z.mul(41.0 / RC).sub(p.y.mul(23.0 / RC))));
            const grain = n4.mul(n4);
            const pLen = p.length().add(heroR * 0.1);
            // sunward-sharp / anti-sunward-feathered skew (DART tail: one
            // crisp edge, one long skirt — never symmetric)
            const sHat = dot(p, uSunL).div(pLen);
            const skew = sHat.mul(0.45).add(1.0);
            // STREAK envelope centered on the fragment CENTROID, power-law
            // falloff (1/r-class tails read as debris; gaussians read blob)
            const cx = p.x.sub(centJ.x).div(arcXJ * 1.30);
            const cy = p.y.sub(centJ.y).div(heroR * 0.85);
            const cz = p.z.sub(centJ.z).div(heroR * 1.10);
            const eR2 = cx.mul(cx).add(cy.mul(cy)).add(cz.mul(cz));
            const q0 = eR2.mul(skew).mul(skew);
            const streak = float(1).div(q0.add(q0.mul(q0).mul(0.6)).add(1.0));
            // clear moat around the hero — bodies sweep their surroundings
            const moat = smoothstep(float(0.2), float(1.05), pLen.div(heroR));
            // hard edge-kill well inside the mesh shell (never print the cut)
            const envK = float(1).sub(smoothstep(0.80, 1.0, p.length().div(RC)));
            let dens = streak.mul(0.10).mul(moat).mul(gate.mul(0.9).add(0.1)).mul(envK);
            // CONTACT-GAP PLUMES — the freshest, densest dust lives where
            // fragments grind past each other, not at body centers (DART)
            for (let pk = 0; pk < 3; pk++) {
                const dpl = p.sub(uPlume[pk]);
                const q = dot(dpl, dpl).div(heroR * heroR * 0.35);
                dens = dens.add(float(1).div(q.mul(q).add(1.0)).mul(0.85).mul(gate.mul(0.85).add(0.15)).mul(envK));
            }
            // thin per-fragment skins, bulk shifted ANTI-sunward (mini
            // radiation-pressure tails; small debris grinds the most)
            for (let bi = 0; bi < 16; bi++) {
                const hw = Math.min(Math.max(pieceRJ[bi] * 2.2, heroR * 0.30), heroR * 0.85);
                const ds2 = p.sub(uPieceL[bi]).add(uSunL.mul(hw * 0.55));
                const q2 = dot(ds2, ds2).div(hw * hw);
                dens = dens.add(exp(q2.negate()).mul(0.30).mul(gate.mul(0.8).add(0.2)).mul(envK));
            }
            // collision-trail FILAMENTS: thin, noise-beaded streamers from
            // the break face to the big chunks (DART-ejecta ray look)
            for (const si of streamIdx) {
                const e = uPieceL[si];
                const hpar = clamp(dot(p, e).div(dot(e, e).add(1e-4)), 0.0, 1.0);
                const wv = p.sub(e.mul(hpar));
                const q3 = dot(wv, wv).div(heroR * heroR * 0.013);
                dens = dens.add(exp(q3.negate()).mul(float(1).sub(hpar.mul(0.40))).mul(0.55).mul(gate.mul(0.8).add(0.2)).mul(envK));
            }
            // FORM remap: cliff the smooth field into billows — keeps 12%
            // of the faint connective haze, turns everything else into
            // defined shapes whose cores saturate (locally THICK medium ->
            // pixel color comes from the form's near surface, not a
            // chord-average that cancels lit/shadow into flatness)
            const form = smoothstep(float(0.22), float(0.80), dens);
            dens = dens.mul(form.mul(0.88).add(0.12));
            dens = dens.mul(grain.mul(2.1).add(0.38));
            // REAL per-sample lighting (the cloud dome's recipe): Beer's-law
            // taps toward the sun for self-shadowing, powder term so dense
            // clump cores darken while thin fringes glow, phase for backlight
            const dl1 = densCheap(p.add(uSunL.mul(heroR * 0.28)));
            const dl2 = densCheap(p.add(uSunL.mul(heroR * 0.75)));
            const denL = dl1.add(dl2).mul(heroR * 0.30).mul(gate.mul(0.8).add(0.4));
            const beers = exp(denL.negate().mul(3.2))
                .add(exp(denL.negate().mul(0.4)).mul(0.26));
            const powdered = float(0.12).add(min(dens.mul(1.2), 1.0).max(1e-6).pow(0.6).mul(1.0));
            const lit = mix(powdered, float(1.0), clamp(denL.mul(0.25), 0.0, 1.0));
            const litI = beers.mul(phaseF).mul(lit);
            const scol = vec3(0.36, 0.33, 0.28).mul(uSunCol).mul(uGain).mul(litI);
            const sampleAlpha=float(1).sub(exp(dens.mul(stepLen.div(RC)).mul(-8.5)));
            const w = sampleAlpha.mul(float(1).sub(aAcc));
            cAcc.addAssign(scol.mul(w));
            aAcc.addAssign(w);
            p.addAssign(rd.mul(stepLen));
        });
        const opacity=min(aAcc,.38);
        return T3.vec4(cAcc.mul(opacity.div(max(aAcc,1e-6))),opacity);
        });
        // the cloud dome's output wiring, verbatim: one march, two roots
        const o = marchFn();
        dustMat.colorNode = o.rgb;
        dustMat.opacityNode = o.a;
    }
    const dust = new T3.Mesh(new T3.SphereGeometry(RC, 32, 16), dustMat);
    dust.userData.noSupportCheck = true; dust.userData.noWet = true;
    dust.renderOrder = -99.5;
    dust.frustumCulled = false;
    group.add(dust);

    // GRANULAR DEBRIS RIVER (Skye's NASA crumbling-asteroid reference): the
    // dust IS particles — thousands of discrete sunlit grains streaming in
    // braided lanes along the fragment line, power-law sized (mostly tiny,
    // a few pebbles), lambert-lit like the fragments so each grain has a
    // bright and dark side; the volumetric march underneath supplies the
    // smoke pockets between boulders.
    const SPECK_N = 7000;
    const speckBase = new T3.OctahedronGeometry(1, 0);
    const speckGeo = new T3.InstancedBufferGeometry();
    speckGeo.setIndex(speckBase.index);
    for(const [name,attribute]of Object.entries(speckBase.attributes))speckGeo.setAttribute(name,attribute);
    speckBase.dispose();
    speckGeo.instanceCount=SPECK_N;
    const speckMat = new T3.MeshBasicNodeMaterial({ fog: false });
    const specks = new T3.Mesh(speckGeo, speckMat);
    specks.userData.noSupportCheck = true; specks.userData.noWet = true;
    specks.renderOrder = -99.5;
    specks.frustumCulled = false;
    group.add(specks);
    const skSeeds = [];
    for (let i = 0; i < SPECK_N; i++) {
        const a = h(i, 41), b = h(i, 42), c = h(i, 43), d = h(i, 44), e = h(i, 45);
        const nearPiece = h(i, 46) < 0.30 ? Math.floor(h(i, 47) * pieces.length) : -1;
        skSeeds.push({
            x0: (a * 2 - 1) * arcXJ * 1.15,
            lanePh: Math.floor(b * 3) * 2.1 + h(i, 48) * 0.6,
            yOff: (d - 0.5) * heroR * 0.85,
            zOff: (h(i, 49) - 0.5) * heroR * 1.1,
            // power-law sizes: mostly sub-pixel dust, a few pebbles
            s: heroR * (0.007 + 0.030 * Math.pow(c, 5)),
            v: (0.008 + 0.020 * e) * heroR,          // slow streaming drift
            wob: h(i, 50) * Math.PI * 2,
            spin: 0.3 + h(i, 51) * 1.4,
            nearPiece,
            orbR: heroR * (0.5 + h(i, 52) * 1.6),
            orbPh: h(i, 53) * Math.PI * 2,
            orbW: 0.02 + h(i, 54) * 0.05,
        });
    }
    const skAxis = new T3.Vector3(0.42, 0.75, 0.51).normalize();
    const SPAN = arcXJ * 1.3;
    const speckParents=pieces.map(p=>p.position.clone());
    const uSpeckParents=T3.uniformArray(speckParents,'vec3');
    for(const [name,keys]of Object.entries({speckA:['x0','lanePh','yOff','zOff'],
        speckB:['s','v','wob','spin'],speckC:['nearPiece','orbR','orbPh','orbW']})){
        const values=new Float32Array(SPECK_N*4);
        for(let i=0;i<SPECK_N;i++)for(let k=0;k<4;k++)values[i*4+k]=skSeeds[i][keys[k]];
        speckGeo.setAttribute(name,new T3.InstancedBufferAttribute(values,4));
    }
    const a=T3.attribute('speckA','vec4'),b=T3.attribute('speckB','vec4'),c=T3.attribute('speckC','vec4');
    const axis=T3.vec3(skAxis),angle=b.z.add(uDustT.mul(b.w));
    const rotate=v=>v.mul(T3.cos(angle)).add(T3.cross(axis,v).mul(T3.sin(angle)))
        .add(axis.mul(T3.dot(axis,v)).mul(T3.float(1).sub(T3.cos(angle))));
    speckMat.positionNode=T3.Fn(()=>{
        const center=T3.vec3(0).toVar();
        T3.If(c.x.greaterThanEqual(0),()=>{
            const parent=uSpeckParents.element(T3.uint(c.x));
            const th=c.z.add(uDustT.mul(c.w));
            center.assign(parent.add(T3.vec3(T3.cos(th).mul(c.y),
                T3.sin(th.mul(.7).add(b.z)).mul(c.y).mul(.45),T3.sin(th).mul(c.y).mul(.6))));
        }).Else(()=>{
            const x=T3.mod(a.x.add(b.y.mul(uDustT)).add(SPAN),SPAN*2).sub(SPAN);
            center.assign(T3.vec3(x,T3.sin(x.mul(.9/heroR).add(a.y)).mul(heroR*.45).add(a.z),
                T3.sin(x.mul(.6/heroR).add(a.y.mul(1.7))).mul(heroR*.5).add(a.w)));
        });
        return center.add(rotate(T3.positionLocal).mul(b.x));
    })();
    const speckNormal=T3.normalize(T3.modelWorldMatrix.mul(T3.vec4(rotate(T3.normalLocal),0)).xyz);
    const speckLight=T3.max(T3.dot(speckNormal,uSunDir),0).mul(.92).add(.08);
    speckMat.colorNode=T3.vec3(.42,.38,.34).mul(speckLight).mul(uSunCol).mul(uGain);

    let texturesDisposed = false;
    return {
        group, pieces, dust, specks, motionInfo: fragmentMotion.stats,
        uniforms: { sunDir: uSunDir, sunCol: uSunCol, gain: uGain },
        disposeTextures() {
            if (texturesDisposed) return;
            texturesDisposed = true;
            for (const texture of sourceTextures) texture.dispose?.();
            sourceTextures.clear();
        },
        update(t) {
            fragmentMotion.update(t);
            const hp = pieces[heroIndex].position;
            dust.position.copy(hp);
            uDustT.value = t;
            for (let i = 0; i < pieces.length && i < uPieceL.length; i++) {
                uPieceL[i].value.copy(pieces[i].position).sub(hp);
            }
            const cam = globalThis._c;
            if (cam) {
                dust.updateMatrixWorld();
                uCamLocal.value.copy(cam.position);
                dust.worldToLocal(uCamLocal.value);
                // sun direction into dust-local space for the march's
                // directional density (feeds a MARCH uniform only — the
                // colorNode stays untouched, see heisenbug note)
                if (!dust.userData._invM) dust.userData._invM = new T3.Matrix4();
                dust.userData._invM.copy(dust.matrixWorld).invert();
                uSunL.value.copy(uSunDir.value).transformDirection(dust.userData._invM);
                // contact-gap plume anchors ride the chaotic pair midpoints
                for (let k = 0; k < 3 && k < plumePairsJ.length; k++) {
                    const [pa, pb] = plumePairsJ[k];
                    uPlume[k].value.copy(pieces[pa].position).add(pieces[pb].position)
                        .multiplyScalar(0.5).sub(hp);
                }
            }
            // The vertex shader streams and rotates all 7,000 grains. Only
            // the sixteen parent positions and time change on the CPU.
            for(let i=0;i<pieces.length;i++)speckParents[i].copy(pieces[i].position);
        },
    };
};

// ---------- runtime: load the baked artifacts, nothing else ----------
globalThis.makeAsteroidMoon = async function ({ meshBytes, meshPath, baked, normal } = {}) {
    let bytes;
    if (meshBytes !== undefined && meshBytes !== null) {
        if (meshBytes instanceof ArrayBuffer) {
            bytes = new Uint8Array(meshBytes);
        } else if (ArrayBuffer.isView(meshBytes)) {
            bytes = new Uint8Array(
                meshBytes.buffer, meshBytes.byteOffset, meshBytes.byteLength,
            );
        } else {
            throw new TypeError('makeAsteroidMoon meshBytes must be an ArrayBuffer or typed-array view');
        }
    } else {
        if (!meshPath) throw new TypeError('makeAsteroidMoon requires meshBytes or meshPath');
        const response = await fetch(meshPath);
        if (!response.ok) {
            throw new Error(`Failed to fetch asteroid moon mesh ${meshPath}: HTTP ${response.status}`);
        }
        bytes = new Uint8Array(await response.arrayBuffer());
    }
    if (bytes.byteLength < 4) throw new Error('Asteroid moon mesh is truncated');
    const base = bytes.byteOffset;
    const count = new Uint32Array(bytes.buffer.slice(base, base + 4))[0];
    if (4 + count * 32 > bytes.byteLength) throw new Error('Asteroid moon mesh payload is truncated');
    const posA = new Float32Array(bytes.buffer.slice(base + 4, base + 4 + count * 12));
    const nrmA = new Float32Array(bytes.buffer.slice(base + 4 + count * 12, base + 4 + count * 24));
    const uvA = new Float32Array(bytes.buffer.slice(base + 4 + count * 24, base + 4 + count * 32));
    const geo = globalThis._asteroidGeoFromArrays(posA, nrmA, uvA);
    baked.wrapS = baked.wrapT = THREE.RepeatWrapping;
    if (normal) normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
    const built = globalThis._asteroidMoonMaterial(baked, normal);
    const mesh = new THREE.Mesh(geo, built.mat);
    mesh.name = 'asteroid_moon';
    mesh.userData.noSupportCheck = true; mesh.userData.noWet = true;
    return { mesh, uniforms: built.uniforms };
};
