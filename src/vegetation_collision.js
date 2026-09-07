// Lightweight player collision for the instanced SeedThree vegetation.
//
// Rendering already owns the authored GLBs and their visual LODs. Physics does
// not duplicate those triangle meshes: this module streams small analytic
// capsule unions for the handful of plants near the explorer. The module is
// deliberately dependency-free so its streaming/collision contract can be
// exercised by the CPU audit without constructing Three.js or a renderer.

export const VEGETATION_COLLISION_CONFIG = Object.freeze({
    // Allocate a plant's capsule union only when the explorer is genuinely
    // close. The short cadence/travel threshold preserves a safe lead while
    // sprinting even though the resident physics radius is just seven metres.
    activeRadius: 7,
    releaseRadius: 9.5,
    refreshInterval: 0.12,
    refreshTravel: 1.25,
    cellSize: 12,
    playerRadius: 0.38,
    playerHeadMargin: 0.12,
    maxSweepStep: 0.24,
    maxSweepSteps: 8,
});

// Capsule endpoints are in authored plant-local metres. A vertical capsule
// represents the trunk; sloped capsules retain the solid cores of the major
// arms while leaving foliage/card silhouettes non-solid.
const COLLISION_TEMPLATES = Object.freeze({
    saguaro: Object.freeze([
        // Main column.
        Object.freeze([0.00, 0.02, 0.00, 0.02, 8.25, 0.02, 0.34, 'trunk']),
        // Two authored upward arms: a compact rear-left arm and the long
        // forward-right arm visible in the repaired SeedThree silhouette.
        Object.freeze([-0.03, 2.90, -0.02, -0.64, 3.72, -0.78, 0.25, 'arm-left-lower']),
        Object.freeze([-0.64, 3.72, -0.78, -0.49, 5.62, -0.55, 0.23, 'arm-left-upper']),
        Object.freeze([0.05, 3.15, 0.04, 1.08, 4.48, 1.20, 0.26, 'arm-right-lower']),
        Object.freeze([1.08, 4.48, 1.20, 1.38, 8.18, 1.54, 0.23, 'arm-right-upper']),
    ]),
    joshua: Object.freeze([
        // The woody trunk narrows rapidly below the skirt.
        Object.freeze([0.00, 0.02, 0.00, 0.04, 3.18, 0.02, 0.32, 'trunk']),
        // Four conservative cores follow the hand-authored crown spread. They
        // intentionally stop inside the leaf rosettes so cards never become
        // invisible walls.
        Object.freeze([-0.02, 2.02, 0.00, -2.38, 3.48, -0.34, 0.24, 'branch-west']),
        Object.freeze([0.03, 2.16, 0.03, 2.52, 3.70, 0.32, 0.24, 'branch-east']),
        Object.freeze([0.02, 2.30, 0.03, 0.42, 3.62, 2.05, 0.23, 'branch-south']),
        Object.freeze([-0.02, 2.24, -0.03, -0.72, 3.52, -1.92, 0.23, 'branch-north']),
    ]),
    // Mojave flora (desert_dressing/mojave_flora shrub fields). Trunk-scale
    // cores only: each capsule covers the multi-stem root crown, never the
    // spray-card canopy, so foliage always stays passable. These templates are
    // currently STAGED — the scrub layer has never fed a collision streamer
    // (only vegetation.js registers species), so shrub/yucca placements remain
    // deliberately collision-free until a dressing streamer is wired in.
    blackbrush: Object.freeze([
        Object.freeze([0.00, 0.00, 0.00, 0.00, 0.35, 0.00, 0.10, 'trunk']),
    ]),
    creosote: Object.freeze([
        Object.freeze([0.00, 0.00, 0.00, 0.00, 0.55, 0.00, 0.14, 'trunk']),
    ]),
    sagebrush: Object.freeze([
        Object.freeze([0.00, 0.00, 0.00, 0.00, 0.45, 0.00, 0.12, 'trunk']),
    ]),
    yucca: Object.freeze([
        // Thatch column + the stiff lower skirt core; bayonet leaves passable.
        Object.freeze([0.00, 0.00, 0.00, 0.00, 0.55, 0.00, 0.16, 'trunk']),
    ]),
});

// ---- baked convex hulls (tools/build-collision-hulls.py) -----------------
// CoACD approximate convex decomposition of the ACTUAL render meshes, so
// hard-stop shapes track the visual silhouettes instead of hand-fitted
// capsules that drifted from them. The library is injected at runtime (the
// browser fetches assets/collision/convex_hulls_v1.json); when a species has
// hulls they replace its capsule template, otherwise the capsules remain as
// the working fallback so CPU audits and partial loads stay functional.
// Hull planes are outward in authored local metres: inside means
// dot(n, p) + d < 0 for every plane.
let HULL_LIBRARY = null;

export function setConvexHullLibrary(species = null) {
    HULL_LIBRARY = species && typeof species === 'object' ? species : null;
    return HULL_LIBRARY ? Object.keys(HULL_LIBRARY).length : 0;
}

const cellKey = (x, z) => `${x},${z}`;
const finite = (value, fallback = 0) => Number.isFinite(Number(value))
    ? Number(value)
    : fallback;

const rotateLocal = (x, z, cosine, sine) => ({
    x: x * cosine + z * sine,
    z: -x * sine + z * cosine,
});

export function makeVegetationCollisionProxy(species, placement) {
    const template = COLLISION_TEMPLATES[species];
    const hullSet = HULL_LIBRARY?.[species] ?? null;
    if (!template && !hullSet) return null;
    const scale = Math.max(0.05, finite(placement?.scale, 1));
    const yaw = finite(placement?.yaw, 0);
    const cosine = Math.cos(yaw);
    const sine = Math.sin(yaw);
    const baseX = finite(placement?.x);
    const baseY = finite(placement?.y);
    const baseZ = finite(placement?.z);
    if (hullSet) {
        // World-space plane transform for rotate+uniform-scale+translate:
        // n_w = R(n); d_w = d * scale - dot(n_w, base). Rotation preserves
        // plane-normal length, so the inside test stays metric. Placements
        // with a full row-major 3x3 `rot9` (tilted rocks) use it; plant
        // placements rotate by yaw only.
        const rot9 = Array.isArray(placement?.rot9) && placement.rot9.length === 9
            ? placement.rot9
            : null;
        const rotateNormal = rot9
            ? (nx, ny, nz) => ({
                x: rot9[0] * nx + rot9[1] * ny + rot9[2] * nz,
                y: rot9[3] * nx + rot9[4] * ny + rot9[5] * nz,
                z: rot9[6] * nx + rot9[7] * ny + rot9[8] * nz,
            })
            : (nx, ny, nz) => {
                const r = rotateLocal(nx, nz, cosine, sine);
                return { x: r.x, y: ny, z: r.z };
            };
        const hulls = hullSet.map((hull) => {
            const lo = hull.aabb.min, hi = hull.aabb.max;
            // exact world AABB of the transformed local box: all 8 corners
            let minX = Infinity, minY = Infinity, minZ = Infinity;
            let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
            for (let corner = 0; corner < 8; corner++) {
                const c = rotateNormal(
                    (corner & 1 ? hi[0] : lo[0]) * scale,
                    (corner & 2 ? hi[1] : lo[1]) * scale,
                    (corner & 4 ? hi[2] : lo[2]) * scale,
                );
                minX = Math.min(minX, baseX + c.x); maxX = Math.max(maxX, baseX + c.x);
                minY = Math.min(minY, baseY + c.y); maxY = Math.max(maxY, baseY + c.y);
                minZ = Math.min(minZ, baseZ + c.z); maxZ = Math.max(maxZ, baseZ + c.z);
            }
            return {
                planes: hull.planes.map(([nx, ny, nz, d]) => {
                    const n = rotateNormal(nx, ny, nz);
                    return [n.x, n.y, n.z,
                        d * scale - (n.x * baseX + n.y * baseY + n.z * baseZ)];
                }),
                aabb: { minX, maxX, minY, maxY, minZ, maxZ },
            };
        });
        return {
            key: `${species}:${placement.id}`,
            species,
            id: placement.id,
            x: baseX,
            y: baseY,
            z: baseZ,
            scale,
            yaw,
            primitives: [],
            hulls,
        };
    }
    const primitives = template.map((definition) => {
        const a = rotateLocal(definition[0] * scale, definition[2] * scale, cosine, sine);
        const b = rotateLocal(definition[3] * scale, definition[5] * scale, cosine, sine);
        return {
            ax: baseX + a.x,
            ay: baseY + definition[1] * scale,
            az: baseZ + a.z,
            bx: baseX + b.x,
            by: baseY + definition[4] * scale,
            bz: baseZ + b.z,
            radius: definition[6] * scale,
            role: definition[7],
        };
    });
    return {
        key: `${species}:${placement.id}`,
        species,
        id: placement.id,
        x: baseX,
        y: baseY,
        z: baseZ,
        scale,
        yaw,
        primitives,
    };
}

const verticalDistanceToInterval = (valueMin, valueMax, segmentMin, segmentMax) => {
    if (valueMax < segmentMin) return segmentMin - valueMax;
    if (valueMin > segmentMax) return valueMin - segmentMax;
    return 0;
};

const deterministicNormal = (key) => {
    let hash = 2166136261;
    for (let index = 0; index < key.length; index++) {
        hash ^= key.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    const angle = ((hash >>> 0) / 4294967296) * Math.PI * 2;
    return { x: Math.cos(angle), z: Math.sin(angle) };
};

// Resolve the player's vertical segment against one world-space convex hull.
// Three heights sample the segment; the deepest sample's least-separating
// face gives the push direction. Faces pointing mostly up/down are never
// pushed from — standing on a rock top must not eject the player sideways.
// Intersect a vertical line with the convex half-spaces. The upper
// boundary is a support only when its plane is walkable and reachable.
const walkableHullTop = (hull, x, z, maximumHeight = Infinity) => {
    const b = hull.aabb;
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return null;
    let lower = b.minY, upper = b.maxY, normalY = 1;
    for (const [nx, ny, nz, d] of hull.planes) {
        const side = nx * x + nz * z + d;
        if (Math.abs(ny) < 1e-7) {
            if (side > 1e-5) return null;
            continue;
        }
        const crossing = -side / ny;
        if (ny > 0 && crossing < upper) { upper = crossing; normalY = ny; }
        else if (ny < 0) lower = Math.max(lower, crossing);
    }
    if (lower > upper + 1e-5 || upper > maximumHeight + 1e-5 || normalY < 0.65) return null;
    return { height: upper, kind: 'rock', assistedStep: false, normalY };
};

const HULL_SAMPLE_FRACTIONS = [0.15, 0.55, 1.0];
const HULL_MAX_PUSH = 0.6;
const resolveHull = (position, hull, eyeHeight, config, supportsStanding = false) => {
    const clearance = config.playerRadius;
    const feetY = position.y - eyeHeight;
    const headY = position.y + config.playerHeadMargin;
    const box = hull.aabb;
    if (position.x < box.minX - clearance || position.x > box.maxX + clearance
        || position.z < box.minZ - clearance || position.z > box.maxZ + clearance
        || headY < box.minY || feetY > box.maxY + clearance) return false;
    // Vertical landing owns a walkable top. Expanding slanted top planes by
    // the body radius here used to eject the player sideways just before
    // their feet landed, even though a simple horizontal-box test passed.
    const support = supportsStanding ? walkableHullTop(hull, position.x, position.z) : null;
    if (support && feetY >= support.height - 1e-4) return false;
    let deepest = Infinity;
    let pushX = 0;
    let pushZ = 0;
    for (const fraction of HULL_SAMPLE_FRACTIONS) {
        const y = feetY + (headY - feetY) * fraction;
        let maxSide = -Infinity;
        let sideX = 0;
        let sideZ = 0;
        for (const [nx, ny, nz, d] of hull.planes) {
            const s = nx * position.x + ny * y + nz * position.z + d;
            if (s <= maxSide) continue;
            maxSide = s;
            sideX = nx;
            sideZ = nz;
        }
        if (maxSide < deepest) {
            deepest = maxSide;
            pushX = sideX;
            pushZ = sideZ;
        }
    }
    if (deepest >= clearance) return false;
    const lateral = Math.hypot(pushX, pushZ);
    if (lateral < 0.35) return false;   // top/bottom face: on the rock, not beside it
    const move = Math.min(HULL_MAX_PUSH, (clearance - deepest) / lateral);
    position.x += (pushX / lateral) * move;
    position.z += (pushZ / lateral) * move;
    return true;
};

const resolvePrimitive = (
    position,
    previous,
    primitive,
    proxyKey,
    eyeHeight,
    config,
) => {
    const abx = primitive.bx - primitive.ax;
    const abz = primitive.bz - primitive.az;
    const horizontalLengthSq = abx * abx + abz * abz;
    let along = 0;
    if (horizontalLengthSq > 1e-10) {
        along = Math.max(0, Math.min(1, (
            (position.x - primitive.ax) * abx
            + (position.z - primitive.az) * abz
        ) / horizontalLengthSq));
    }
    const closestX = primitive.ax + abx * along;
    const closestZ = primitive.az + abz * along;
    const feetY = position.y - eyeHeight;
    const headY = position.y + config.playerHeadMargin;
    const verticalDistance = horizontalLengthSq <= 1e-10
        ? verticalDistanceToInterval(
            feetY,
            headY,
            Math.min(primitive.ay, primitive.by),
            Math.max(primitive.ay, primitive.by),
        )
        : verticalDistanceToInterval(
            feetY,
            headY,
            primitive.ay + (primitive.by - primitive.ay) * along,
            primitive.ay + (primitive.by - primitive.ay) * along,
        );
    const expandedRadius = primitive.radius + config.playerRadius;
    if (verticalDistance >= expandedRadius) return false;
    const horizontalRadius = Math.sqrt(Math.max(
        0,
        expandedRadius * expandedRadius - verticalDistance * verticalDistance,
    ));
    let dx = position.x - closestX;
    let dz = position.z - closestZ;
    const distanceSq = dx * dx + dz * dz;
    if (distanceSq >= horizontalRadius * horizontalRadius) return false;
    const distance = Math.sqrt(distanceSq);
    if (distance > 1e-7) {
        dx /= distance;
        dz /= distance;
    } else {
        // Preserve the approach side when the sample lands exactly on an axis;
        // a stable hash is the final fallback for a spawn inside a trunk.
        const previousAlong = horizontalLengthSq > 1e-10
            ? Math.max(0, Math.min(1, (
                (previous.x - primitive.ax) * abx
                + (previous.z - primitive.az) * abz
            ) / horizontalLengthSq))
            : 0;
        dx = previous.x - (primitive.ax + abx * previousAlong);
        dz = previous.z - (primitive.az + abz * previousAlong);
        const previousDistance = Math.hypot(dx, dz);
        if (previousDistance > 1e-7) {
            dx /= previousDistance;
            dz /= previousDistance;
        } else {
            const fallback = deterministicNormal(`${proxyKey}:${primitive.role}`);
            dx = fallback.x;
            dz = fallback.z;
        }
    }
    position.x = closestX + dx * horizontalRadius;
    position.z = closestZ + dz * horizontalRadius;
    return true;
};

export function createVegetationCollisionStreamer(options = {}) {
    const config = Object.freeze({
        ...VEGETATION_COLLISION_CONFIG,
        ...(options.config ?? {}),
    });
    if (!(config.releaseRadius > config.activeRadius)) {
        throw new Error('Vegetation collision releaseRadius must exceed activeRadius');
    }
    const grid = new Map();
    const entries = [];
    const active = new Map();
    let lastRefresh = -Infinity;
    let anchorX = Infinity;
    let anchorZ = Infinity;
    let refreshes = 0;
    let loadCount = 0;
    let unloadCount = 0;
    let peakActive = 0;
    let candidateChecks = 0;
    let primitiveChecks = 0;
    let resolvedContacts = 0;
    let lastResolvedContacts = 0;
    let disposed = false;
    const visited = new Set();

    const registerSpecies = (species, placements = []) => {
        if (!COLLISION_TEMPLATES[species] && !HULL_LIBRARY?.[species]) return 0;
        let registered = 0;
        for (const placement of placements) {
            const entry = {
                key: `${species}:${placement.id}`,
                species,
                placement,
                x: finite(placement.x),
                z: finite(placement.z),
                radius: Math.max(0, finite(placement.boundsRadius)),
            };
            entries.push(entry);
            // Large rocks can be touched well before their pivot is nearby.
            // Index their occupied cells so activation follows their surface.
            const minGX = Math.floor((entry.x - entry.radius) / config.cellSize);
            const maxGX = Math.floor((entry.x + entry.radius) / config.cellSize);
            const minGZ = Math.floor((entry.z - entry.radius) / config.cellSize);
            const maxGZ = Math.floor((entry.z + entry.radius) / config.cellSize);
            for (let gx = minGX; gx <= maxGX; gx++) {
                for (let gz = minGZ; gz <= maxGZ; gz++) {
                    const key = cellKey(gx, gz);
                    if (!grid.has(key)) grid.set(key, []);
                    grid.get(key).push(entry);
                }
            }
            registered++;
        }
        return registered;
    };

    const refresh = (position, time = 0, force = false) => {
        if (disposed || !position) return false;
        const x = finite(position.x);
        const z = finite(position.z);
        const now = finite(time);
        const anchorTravel = Math.hypot(x - anchorX, z - anchorZ);
        if (!force
            && now - lastRefresh < config.refreshInterval
            && anchorTravel < config.refreshTravel) return false;

        lastRefresh = now;
        anchorX = x;
        anchorZ = z;
        refreshes++;

        for (const [key, proxy] of active) {
            const dx = proxy.x - x;
            const dz = proxy.z - z;
            const release = config.releaseRadius + (proxy.boundsRadius ?? 0);
            if (dx * dx + dz * dz <= release * release) continue;
            active.delete(key);
            unloadCount++;
        }

        const minGX = Math.floor((x - config.releaseRadius) / config.cellSize);
        const maxGX = Math.floor((x + config.releaseRadius) / config.cellSize);
        const minGZ = Math.floor((z - config.releaseRadius) / config.cellSize);
        const maxGZ = Math.floor((z + config.releaseRadius) / config.cellSize);
        visited.clear();
        for (let gx = minGX; gx <= maxGX; gx++) {
            for (let gz = minGZ; gz <= maxGZ; gz++) {
                const cell = grid.get(cellKey(gx, gz));
                if (!cell) continue;
                for (const entry of cell) {
                    if (visited.has(entry.key)) continue;
                    visited.add(entry.key);
                    candidateChecks++;
                    if (active.has(entry.key)) continue;
                    const dx = entry.x - x;
                    const dz = entry.z - z;
                    const activate = config.activeRadius + entry.radius;
                    if (dx * dx + dz * dz > activate * activate) continue;
                    const proxy = makeVegetationCollisionProxy(
                        entry.species,
                        entry.placement,
                    );
                    if (!proxy) continue;
                    proxy.boundsRadius = entry.radius;
                    active.set(entry.key, proxy);
                    loadCount++;
                }
            }
        }
        peakActive = Math.max(peakActive, active.size);
        return true;
    };

    const resolve = (
        position,
        previous = position,
        time = 0,
        eyeHeight = 1.82,
    ) => {
        const refreshed = refresh(position, time, false);
        lastResolvedContacts = 0;
        if (disposed || !position || active.size === 0) {
            return { active: active.size, contacts: 0, refreshed };
        }
        const targetX = finite(position.x);
        const targetY = finite(position.y);
        const targetZ = finite(position.z);
        const startX = finite(previous?.x, targetX);
        const startY = finite(previous?.y, targetY);
        const startZ = finite(previous?.z, targetZ);
        const travel = Math.hypot(targetX - startX, targetZ - startZ);
        const steps = Math.max(1, Math.min(
            config.maxSweepSteps,
            Math.ceil(travel / config.maxSweepStep),
        ));
        const sample = { x: startX, y: startY, z: startZ };
        const prior = { ...sample };
        const stepX = (targetX - startX) / steps;
        const stepY = (targetY - startY) / steps;
        const stepZ = (targetZ - startZ) / steps;
        for (let step = 0; step < steps; step++) {
            prior.x = sample.x;
            prior.y = sample.y;
            prior.z = sample.z;
            sample.x += stepX;
            sample.y += stepY;
            sample.z += stepZ;
            // Two passes settle overlaps between a trunk and its adjoining arm
            // while keeping the hot path bounded by the small active set.
            for (let pass = 0; pass < 2; pass++) {
                let passContact = false;
                for (const proxy of active.values()) {
                    for (const primitive of proxy.primitives) {
                        primitiveChecks++;
                        if (!resolvePrimitive(
                            sample,
                            prior,
                            primitive,
                            proxy.key,
                            finite(eyeHeight, 1.82),
                            config,
                        )) continue;
                        lastResolvedContacts++;
                        resolvedContacts++;
                        passContact = true;
                    }
                    if (proxy.hulls) {
                        for (const hull of proxy.hulls) {
                            primitiveChecks++;
                            if (!resolveHull(
                                sample,
                                hull,
                                finite(eyeHeight, 1.82),
                                config,
                                proxy.species.startsWith('rock_'),
                            )) continue;
                            lastResolvedContacts++;
                            resolvedContacts++;
                            passContact = true;
                        }
                    }
                }
                if (!passContact) break;
            }
        }
        position.x = sample.x;
        position.z = sample.z;
        return {
            active: active.size,
            contacts: lastResolvedContacts,
            refreshed,
        };
    };

    const snapshot = () => ({
        mode: HULL_LIBRARY
            ? 'proximity-streamed-capsule-and-convex-hull-unions'
            : 'proximity-streamed-analytic-capsule-unions',
        config: { ...config },
        registered: entries.length,
        gridCells: grid.size,
        active: active.size,
        activeBySpecies: [...active.values()].reduce((counts, proxy) => {
            counts[proxy.species] = (counts[proxy.species] ?? 0) + 1;
            return counts;
        }, {}),
        activePrimitiveCount: [...active.values()].reduce(
            (sum, proxy) => sum + proxy.primitives.length,
            0,
        ),
        activeHullCount: [...active.values()].reduce(
            (sum, proxy) => sum + (proxy.hulls?.length ?? 0),
            0,
        ),
        activeKeys: [...active.keys()],
        refreshes,
        loadCount,
        unloadCount,
        peakActive,
        candidateChecks,
        primitiveChecks,
        resolvedContacts,
        lastResolvedContacts,
        lastRefresh,
        anchor: Number.isFinite(anchorX) ? { x: anchorX, z: anchorZ } : null,
    });

    const activeProxies = () => [...active.values()].map((proxy) => ({
        ...proxy,
        primitives: proxy.primitives.map((primitive) => ({ ...primitive })),
    }));

    const dispose = () => {
        disposed = true;
        active.clear();
        grid.clear();
        entries.length = 0;
        visited.clear();
    };

    const walkSurfaceAt = (x, z, maximumHeight = Infinity) => {
        let best = null;
        for (const proxy of active.values()) {
            if (!proxy.species.startsWith('rock_')) continue;
            for (const hull of proxy.hulls ?? []) {
                const top = walkableHullTop(hull, x, z, maximumHeight);
                if (top && (!best || top.height > best.height)) best = top;
            }
        }
        return best;
    };

    return {
        config,
        registerSpecies,
        refresh,
        resolve,
        snapshot,
        activeProxies,
        walkSurfaceAt,
        dispose,
    };
}
