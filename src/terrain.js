// Eanpa terrain: an open, domain-warped desert basin with broken canyon
// rims and sedimentary mesas, carved by droplet hydraulic erosion (the
// standard particle method: each droplet walks downhill, erodes up to its
// sediment capacity, and deposits on slowdown). Erosion also PAINTS the
// material: deposition writes gravel weight and scouring writes rock
// weight into a vertex splat attribute. The existing three CC0 PBR sets
// (AmbientCG) are recolored into sand, gravel, and sandstone; rock goes
// triplanar so steep faces do not stretch.
export async function makeTerrain(T3) {
    const SIZE = 4200, SEGS = 256, G = SEGS + 1;

    // ---- height field: fbm + domain warp ----
    const h2 = (x, y) => {
        const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
        return v - Math.floor(v);
    };
    const vn2 = (x, y) => {
        const xi = Math.floor(x), yi = Math.floor(y);
        const xf = x - xi, yf = y - yi;
        const s = (t) => t * t * (3 - 2 * t);
        const sx = s(xf), sy = s(yf);
        const a = h2(xi, yi), b = h2(xi + 1, yi), c = h2(xi, yi + 1), d = h2(xi + 1, yi + 1);
        return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    };
    const fbm = (x, y, oct = 6) => {
        let amp = 1, f = 1, sum = 0, norm = 0;
        for (let o = 0; o < oct; o++) { sum += vn2(x * f, y * f) * amp; norm += amp; amp *= 0.52; f *= 2.11; }
        return sum / norm;
    };

    const clamp01 = (x) => Math.max(0, Math.min(1, x));
    const smooth = (a, b, x) => {
        const t = clamp01((x - a) / (b - a));
        return t * t * (3 - 2 * t);
    };
    const CANYONS = [
        [0.962, 0.273, 0.080, 0.24],   // east / north-east wash
        [-0.781, -0.625, 0.090, 0.22], // south-west canyon
        [-0.351, 0.936, 0.070, 0.34],  // narrow north-west pass
    ];
    const canyonAt = (px, pz, wx, wz, [dx, dz, width, start]) => {
        const cx = px + wx * 0.65, cz = pz + wz * 0.65;
        const along = cx * dx + cz * dz;
        const across = Math.abs(cx * dz - cz * dx);
        const widening = width + Math.max(0, along - start) * 0.08;
        return smooth(start, 0.92, along)
            * (1 - smooth(widening, widening * 2.15, across));
    };
    const MESAS = [
        [-0.47, 0.24, 0.285, 0.145, -0.24, 255],
        [0.46, -0.22, 0.235, 0.125, 0.38, 218],
        [0.08, -0.50, 0.185, 0.105, -0.32, 178],
        [-0.18, -0.37, 0.095, 0.072, 0.18, 132],
    ].map(([cx, cz, rx, rz, rotation, height]) => ({
        cx, cz,
        invRx: 1 / rx,
        invRz: 1 / rz,
        cs: Math.cos(rotation),
        sn: Math.sin(rotation),
        height,
    }));
    const mesaAt = (px, pz, macro, ridge, mesa) => {
        const lx = px - mesa.cx, lz = pz - mesa.cz;
        const mx = (lx * mesa.cs + lz * mesa.sn) * mesa.invRx;
        const mz = (-lx * mesa.sn + lz * mesa.cs) * mesa.invRz;
        const edge = Math.hypot(mx, mz) + (macro - 0.5) * 0.16 + (ridge - 0.5) * 0.035;
        return (1 - smooth(0.66, 0.96, edge)) * mesa.height;
    };

    const hmap = new Float32Array(G * G);
    for (let j = 0; j < G; j++) {
        for (let i = 0; i < G; i++) {
            const u = i / SEGS, v = j / SEGS;
            const px = u * 2 - 1, pz = v * 2 - 1;
            const wx = (fbm(u * 2.35 + 13.7, v * 2.35 + 4.1) - 0.5) * 0.25;
            const wz = (fbm(u * 2.35 + 41.8, v * 2.35 + 71.3) - 0.5) * 0.25;
            const macro = fbm((u + wx) * 2.15 + 8.4, (v + wz) * 2.15 + 19.7);
            const ridge = Math.pow(1 - Math.abs(fbm((u + wz) * 3.9 + 2.7, (v + wx) * 3.9 + 31.1) * 2 - 1), 2.35);

            // A noisy, slightly elliptical rim replaces the old continuous
            // radial bowl. Directional corridors punch all the way through it,
            // leaving broad canyon exits rather than an enclosing crater wall.
            const qx = px + wx, qz = pz + wz;
            const angle = Math.atan2(qz, qx);
            const radial = Math.hypot(qx * 0.94, qz * 1.06);
            const rimField = radial + (macro - 0.5) * 0.22
                + Math.sin(angle * 3.0 + macro * 4.0) * 0.045;

            const opening = Math.max(
                canyonAt(px, pz, wx, wz, CANYONS[0]),
                canyonAt(px, pz, wx, wz, CANYONS[1]),
                canyonAt(px, pz, wx, wz, CANYONS[2]),
            );
            const rimMask = smooth(0.49, 0.88, rimField);
            let rimMass = rimMask * (155 + ridge * 245 + (macro - 0.5) * 65);
            rimMass *= 1 - opening * 0.97;

            // Compact plateau profiles create individually readable mesas and
            // buttes inside the broken rim. Edge noise is shared, keeping the
            // generation cost in the same range as the previous four-fBm field.
            const mesaMass = Math.max(
                mesaAt(px, pz, macro, ridge, MESAS[0]),
                mesaAt(px, pz, macro, ridge, MESAS[1]),
                mesaAt(px, pz, macro, ridge, MESAS[2]),
                mesaAt(px, pz, macro, ridge, MESAS[3]),
            );

            // Quantizing only a small share of consolidated rock produces
            // sandstone shelves without turning the height field into stairs;
            // hydraulic erosion below still owns the final drainage detail.
            const rockMass = rimMass + mesaMass;
            const terraced = Math.floor(rockMass / 24) * 24;
            const terraceMix = smooth(72, 180, rockMass) * 0.09;
            const sedimentary = rockMass * (1 - terraceMix) + terraced * terraceMix;
            const basinFloor = (macro - 0.5) * 48 + ridge * 23;
            const washCut = opening * smooth(0.22, 0.92, radial) * (18 + ridge * 15);
            hmap[j * G + i] = basinFloor + sedimentary - washCut;
        }
    }

    // ---- droplet hydraulic erosion (also paints deposit/scour maps) ----
    const deposit = new Float32Array(G * G);
    const scour = new Float32Array(G * G);
    const CELL = SIZE / SEGS;
    const hAt = (x, y) => {
        const xi = Math.max(0, Math.min(G - 2, Math.floor(x))), yi = Math.max(0, Math.min(G - 2, Math.floor(y)));
        const fx = x - xi, fy = y - yi, o = yi * G + xi;
        return hmap[o] * (1 - fx) * (1 - fy) + hmap[o + 1] * fx * (1 - fy)
             + hmap[o + G] * (1 - fx) * fy + hmap[o + G + 1] * fx * fy;
    };
    const splat = (arr, x, y, amt) => {
        const xi = Math.max(0, Math.min(G - 2, Math.floor(x))), yi = Math.max(0, Math.min(G - 2, Math.floor(y)));
        const fx = x - xi, fy = y - yi, o = yi * G + xi;
        arr[o] += amt * (1 - fx) * (1 - fy); arr[o + 1] += amt * fx * (1 - fy);
        arr[o + G] += amt * (1 - fx) * fy; arr[o + G + 1] += amt * fx * fy;
    };
    let seed = 1234567;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const DROPS = 90000, INERTIA = 0.08, CAP_K = 5.0, ERODE_K = 0.35, DEPOSIT_K = 0.35, EVAP = 0.015, GRAV = 4.5;
    for (let d = 0; d < DROPS; d++) {
        let x = rnd() * SEGS, y = rnd() * SEGS, dx = 0, dy = 0, vel = 1, water = 1, sed = 0;
        for (let life = 0; life < 36; life++) {
            const xi = Math.max(0, Math.min(G - 2, Math.floor(x))), yi = Math.max(0, Math.min(G - 2, Math.floor(y)));
            const fx = x - xi, fy = y - yi, o = yi * G + xi;
            const gx = (hmap[o + 1] - hmap[o]) * (1 - fy) + (hmap[o + G + 1] - hmap[o + G]) * fy;
            const gy = (hmap[o + G] - hmap[o]) * (1 - fx) + (hmap[o + G + 1] - hmap[o + 1]) * fx;
            dx = dx * INERTIA - gx * (1 - INERTIA);
            dy = dy * INERTIA - gy * (1 - INERTIA);
            const len = Math.hypot(dx, dy);
            if (len < 1e-5) break;
            dx /= len; dy /= len;
            const hOld = hAt(x, y);
            const nx = x + dx, ny = y + dy;
            if (nx < 1 || ny < 1 || nx > SEGS - 1 || ny > SEGS - 1) break;
            const dh = hAt(nx, ny) - hOld;
            const cap = Math.max(-dh, 0.01) * vel * water * CAP_K;
            if (sed > cap || dh > 0) {
                const drop = dh > 0 ? Math.min(dh, sed) : (sed - cap) * DEPOSIT_K;
                sed -= drop;
                splat(hmap, x, y, drop);
                splat(deposit, x, y, drop);
            } else {
                const take = Math.min((cap - sed) * ERODE_K, -dh);
                sed += take;
                splat(hmap, x, y, -take);
                splat(scour, x, y, take);
            }
            vel = Math.sqrt(Math.max(vel * vel + dh * -GRAV, 0.01));
            water *= 1 - EVAP;
            x = nx; y = ny;
        }
    }

    // ---- geometry with splat attribute (x = deposit, y = scour) ----
    // Anchor: world origin sits ON the final ground at terrain center; the
    // procedural field's absolute datum should never float the whole scene.
    const h0 = hmap[(G >> 1) * G + (G >> 1)];
    const geo = new T3.PlaneGeometry(SIZE, SIZE, SEGS, SEGS);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position');
    const splatAttr = new Float32Array(pos.count * 2);
    for (let j = 0; j < G; j++) {
        for (let i = 0; i < G; i++) {
            const vi = j * G + i;
            pos.setY(vi, hmap[vi] - h0);
            splatAttr[vi * 2] = Math.min(deposit[vi] * 0.9, 1);
            splatAttr[vi * 2 + 1] = Math.min(scour[vi] * 0.55, 1);
        }
    }
    geo.setAttribute('splat', new T3.BufferAttribute(splatAttr, 2));
    geo.computeVertexNormals();

    // ---- PBR sets (AmbientCG, CC0) ----
    const L = new T3.TextureLoader();
    const tex = async (p, srgb) => {
        const t = await L.loadAsync(p);
        t.wrapS = t.wrapT = T3.RepeatWrapping;
        if (srgb) t.colorSpace = T3.SRGBColorSpace;
        return t;
    };
    const set = async (id) => ({
        col: await tex(`./assets/pbr/${id}/${id}_1K-JPG_Color.jpg`, true),
        nrm: await tex(`./assets/pbr/${id}/${id}_1K-JPG_NormalGL.jpg`, false),
        rgh: await tex(`./assets/pbr/${id}/${id}_1K-JPG_Roughness.jpg`, false),
        ao:  await tex(`./assets/pbr/${id}/${id}_1K-JPG_AmbientOcclusion.jpg`, false),
    });
    // Grass001 remains in the texture budget as fine, stochastic ground
    // detail, but its green chroma is discarded below and its normals are
    // softened so it reads as wind-ruffled sand rather than vegetation.
    const [sandDetail, rock, gravel] = await Promise.all([set('Grass001'), set('Rock030'), set('Gravel022')]);

    const {
        vec2, vec3, float, positionWorld, normalWorld, texture, attribute,
        fract, floor, mix, dot, smoothstep, abs, normalize, sign,
        cameraViewMatrix,
    } = T3;
    const h21 = (p) => {
        const a = fract(vec3(p.x, p.y, p.x).mul(0.1031));
        const dd = dot(a, vec3(a.y, a.z, a.x).add(33.33));
        const b = a.add(dd);
        return fract(b.x.add(b.y).mul(b.z));
    };
    const vnT = (p) => {
        const i = floor(p), f = fract(p);
        const sm = f.mul(f).mul(float(3).sub(f.mul(2)));
        const A = h21(i), B = h21(i.add(vec2(1, 0)));
        const C = h21(i.add(vec2(0, 1))), D = h21(i.add(vec2(1, 1)));
        return mix(mix(A, B, sm.x), mix(C, D, sm.x), sm.y);
    };

    // TDBG feature mask (?tdbg=N in the URL): binary-search which node
    // construct Chrome's validator rejects. Bits: 1=colorNode splat blend,
    // 2=roughnessNode, 4=normalNode, 8=aoNode. Default 15 = everything.
    const TDBG = Number(new URLSearchParams(location.search).get('tdbg') ?? 15);
    const mat = new T3.MeshStandardNodeMaterial({ metalness: 0 });
    const uvS = positionWorld.xz.mul(1 / 8.5);        // softened sand detail
    const uvV = positionWorld.xz.mul(1 / 5.5);        // gravel tile
    const macro = vnT(positionWorld.xz.mul(0.004)).mul(0.5).add(0.75);   // kills tiling repetition

    // rock: triplanar (world XZ/XY/ZY by normal weights) so cliffs don't smear
    const rs = 1 / 11;
    const nA = abs(normalWorld);
    const wSum = nA.x.add(nA.y).add(nA.z);
    const triW = nA.div(wSum);
    const rockTri = (t) => texture(t, positionWorld.zy.mul(rs)).mul(triW.x)
        .add(texture(t, positionWorld.xz.mul(rs)).mul(triW.y))
        .add(texture(t, positionWorld.xy.mul(rs)).mul(triW.z));

    const sp = attribute('splat', 'vec2');
    const slope = float(1).sub(normalWorld.y).clamp(0, 1);
    const breakup = vnT(positionWorld.xz.mul(0.02)).sub(0.5).mul(0.14);
    // layer weights: sand base → gravel in deposition basins → rock on
    // scoured/steep faces and high ridges
    let wGravel = smoothstep(float(0.12), float(0.55), sp.x.add(breakup))
        .max(smoothstep(float(0.04), float(0.10), slope)
            .mul(float(1).sub(smoothstep(float(0.10), float(0.30), slope))).mul(0.5));
    let wRock = smoothstep(float(0.18), float(0.50), slope.add(breakup))
        .max(smoothstep(float(0.10), float(0.45), sp.y))
        .max(smoothstep(float(190), float(330), positionWorld.y));
    wRock = wRock.clamp(0, 1);
    wGravel = wGravel.mul(float(1).sub(wRock));
    const wSand = float(1).sub(wRock).sub(wGravel).clamp(0, 1);
    let terrainColorNode = null;
    let terrainNormalNode = null;
    let terrainRoughnessNode = null;
    let terrainAoNode = null;

    if (TDBG & 1) {
        const luminance = (c) => dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
        const sandValue = luminance(texture(sandDetail.col, uvS)).mul(0.52).add(0.48);
        const gravelValue = luminance(texture(gravel.col, uvV)).mul(0.50).add(0.46);
        const rockValue = luminance(rockTri(rock.col)).mul(0.48).add(0.50);

        // Horizontal bands are gently warped so the strata follow the broad
        // geology without becoming perfectly straight shader stripes.
        const strataWarp = vnT(positionWorld.xz.mul(0.0045)).sub(0.5).mul(12.0)
            .add(vnT(positionWorld.xz.mul(0.0016).add(vec2(4.7, 9.2))).sub(0.5).mul(17.0));
        const strataPhase = fract(positionWorld.y.add(strataWarp).mul(1 / 23));
        const strataBody = smoothstep(float(0.08), float(0.28), strataPhase)
            .mul(float(1).sub(smoothstep(float(0.68), float(0.94), strataPhase)));
        const ironBand = smoothstep(float(0.73), float(0.79), strataPhase)
            .mul(float(1).sub(smoothstep(float(0.84), float(0.91), strataPhase)));

        const colS = vec3(0.76, 0.39, 0.16).mul(sandValue);
        const colV = vec3(0.56, 0.255, 0.095).mul(gravelValue);
        const sandstoneTint = mix(vec3(0.50, 0.18, 0.058), vec3(0.73, 0.31, 0.10), strataBody)
            .mul(mix(float(1), float(0.88), ironBand));
        const colR = sandstoneTint.mul(rockValue);
        terrainColorNode = colS.mul(wSand).add(colV.mul(wGravel)).add(colR.mul(wRock)).mul(macro).rgb;
    }

    if ((TDBG & 4) && T3.normalMap) {
        const nSandView = T3.normalMap(texture(sandDetail.nrm, uvS).rgb, vec2(0.28, 0.28));
        const nGravelView = T3.normalMap(texture(gravel.nrm, uvV).rgb, vec2(0.72, 0.72));

        // A tangent-space normal cannot be blended raw across three projections:
        // on cliffs that interprets X/Y faces in the ground plane's tangent
        // frame. Decode each projection, orient it into world space, then blend
        // the actual normals. A neutral map resolves exactly to normalWorld.
        const nX = texture(rock.nrm, positionWorld.zy.mul(rs)).rgb.mul(2).sub(1);
        const nY = texture(rock.nrm, positionWorld.xz.mul(rs)).rgb.mul(2).sub(1);
        const nZ = texture(rock.nrm, positionWorld.xy.mul(rs)).rgb.mul(2).sub(1);
        const axisSign = sign(normalWorld);
        const worldX = vec3(nX.z.mul(axisSign.x), nX.y.mul(axisSign.x).mul(-1), nX.x);
        const worldY = vec3(nY.x, nY.z.mul(axisSign.y), nY.y.mul(axisSign.y).mul(-1));
        const worldZ = vec3(nZ.x, nZ.y.mul(axisSign.z), nZ.z.mul(axisSign.z));
        const rockNormalWorld = normalize(worldX.mul(triW.x).add(worldY.mul(triW.y)).add(worldZ.mul(triW.z)));
        const rockNormalView = cameraViewMatrix.transformDirection(rockNormalWorld);
        terrainNormalNode = normalize(nSandView.mul(wSand)
            .add(nGravelView.mul(wGravel))
            .add(rockNormalView.mul(wRock)));
    }

    if (TDBG & 2) {
        const rghS = texture(sandDetail.rgh, uvS).r.mul(0.18).add(0.80);
        const rghV = texture(gravel.rgh, uvV).r.mul(0.24).add(0.72);
        const rghR = rockTri(rock.rgh).r.mul(0.38).add(0.56);
        terrainRoughnessNode = rghS.mul(wSand).add(rghV.mul(wGravel)).add(rghR.mul(wRock)).clamp(0.62, 1);
    }

    if (TDBG & 8) {
        const aoS = texture(sandDetail.ao, uvS).r;
        const aoV = texture(gravel.ao, uvV).r;
        const aoR = rockTri(rock.ao).r;
        terrainAoNode = aoS.mul(wSand).add(aoV.mul(wGravel)).add(aoR.mul(wRock)).mul(0.5).add(0.5);
    }

    const mesh = new T3.Mesh(geo, mat);
    mesh.name = 'eanpa_terrain';
    // Optimized modes shed whole PBR texture groups instead of merely
    // reducing sky samples. Performance keeps the authored color/roughness
    // response (10 texture reads instead of ~20); Balanced restores normals;
    // Cinematic also restores the AO triplet. Node identities are reused, so
    // a tier change recompiles once but does not rebuild terrain or textures.
    mesh.setQuality = (quality = 'balanced') => {
        const nextNormal = quality === 'performance' ? null : terrainNormalNode;
        const nextAo = quality === 'cinematic' ? terrainAoNode : null;
        const changed = mat.colorNode !== terrainColorNode
            || mat.roughnessNode !== terrainRoughnessNode
            || mat.normalNode !== nextNormal
            || mat.aoNode !== nextAo;
        mat.colorNode = terrainColorNode;
        mat.roughnessNode = terrainRoughnessNode;
        mat.normalNode = nextNormal;
        mat.aoNode = nextAo;
        if (changed) mat.needsUpdate = true;
        mesh.userData.quality = quality;
    };
    mesh.setQuality(globalThis.document?.getElementById?.('quality')?.value ?? 'balanced');

    // Deterministic queries against the FINAL, eroded height field. Coordinates
    // are terrain-local (and therefore world-space while this identity mesh is
    // left at its returned transform). Out-of-bounds queries clamp to the edge.
    const HALF_SIZE = SIZE * 0.5;
    const sampleScratch = {};
    const writeTerrainSample = (worldX, worldZ, out) => {
        const inside = worldX >= -HALF_SIZE && worldX <= HALF_SIZE
            && worldZ >= -HALF_SIZE && worldZ <= HALF_SIZE;
        const x = Math.max(-HALF_SIZE, Math.min(HALF_SIZE, worldX));
        const z = Math.max(-HALF_SIZE, Math.min(HALF_SIZE, worldZ));
        const gx = (x + HALF_SIZE) / CELL;
        const gz = (z + HALF_SIZE) / CELL;
        const xi = Math.min(SEGS - 1, Math.floor(gx));
        const zi = Math.min(SEGS - 1, Math.floor(gz));
        const fx = gx - xi, fz = gz - zi;
        const o = zi * G + xi;
        const h00 = hmap[o], h10 = hmap[o + 1];
        const h01 = hmap[o + G], h11 = hmap[o + G + 1];
        const hx0 = h00 + (h10 - h00) * fx;
        const hx1 = h01 + (h11 - h01) * fx;
        const dhdx = ((h10 - h00) * (1 - fz) + (h11 - h01) * fz) / CELL;
        const dhdz = ((h01 - h00) * (1 - fx) + (h11 - h10) * fx) / CELL;
        const grade = Math.hypot(dhdx, dhdz);
        const invNormalLength = 1 / Math.sqrt(1 + grade * grade);

        out.x = x;
        out.z = z;
        out.inside = inside;
        out.height = hx0 + (hx1 - hx0) * fz - h0;
        out.slope = Math.atan(grade); // radians from horizontal
        out.grade = grade;
        const normal = out.normal || (out.normal = {});
        normal.x = -dhdx * invNormalLength;
        normal.y = invNormalLength;
        normal.z = -dhdz * invNormalLength;
        return out;
    };
    const heightAt = (x, z) => writeTerrainSample(x, z, sampleScratch).height;
    const slopeAt = (x, z) => writeTerrainSample(x, z, sampleScratch).slope;
    const sampleTerrain = (x, z, out = {}) => writeTerrainSample(x, z, out);
    const bounds = Object.freeze({
        minX: -HALF_SIZE, maxX: HALF_SIZE,
        minZ: -HALF_SIZE, maxZ: HALF_SIZE,
    });
    const terrainSampler = Object.freeze({
        seed: 1234567,
        size: SIZE,
        cellSize: CELL,
        bounds,
        heightAt,
        slopeAt,
        sample: sampleTerrain,
    });
    mesh.heightAt = heightAt;
    mesh.slopeAt = slopeAt;
    mesh.sampleTerrain = sampleTerrain;
    mesh.terrainBounds = bounds;
    mesh.terrainSampler = terrainSampler;
    let disposed = false;
    mesh.dispose = () => {
        if (disposed) return;
        disposed = true;
        mesh.removeFromParent();
        geo.dispose();
        mat.dispose();
        for (const setTextures of [sandDetail, rock, gravel]) {
            for (const texture of Object.values(setTextures)) texture.dispose?.();
        }
    };
    return mesh;
}
