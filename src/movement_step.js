// Narrow first-person step/mantle helper. Ordinary terrain and the ziggurat's
// 0.20 m treads stay on the normal grounding path; only surfaces explicitly
// tagged `assistedStep` (the two Inanna dais courses) can start this motion.

// 0.52: the stair curb stones top out 0.48-0.52 m over their treads and are
// knee-high decor a player simply steps onto — at 0.34 they were standable
// but unsteppable, which read as an invisible wall at the stone face.
export const MAX_WALK_STEP_RISE = 0.52;
export const FLOOR_CONTACT_TOLERANCE = 0.025;

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const smooth01 = (value) => {
    const t = clamp01(value);
    return t * t * (3 - 2 * t);
};

export function createAssistedStepState() {
    return {
        active: false,
        elapsed: 0,
        duration: 0,
        fromX: 0,
        fromZ: 0,
        toX: 0,
        toZ: 0,
        fromEyeY: 0,
        targetEyeY: 0,
        targetKind: null,
        rise: 0,
        starts: 0,
        completions: 0,
        blockedHighEntries: 0,
        lastDuration: 0,
        lastPeakFrameRise: 0,
    };
}

const finiteSurface = (surface) => Number.isFinite(surface?.height);

export function surfaceRise(previousSurface, nextSurface) {
    if (!finiteSurface(previousSurface) || !finiteSurface(nextSurface)) return 0;
    return nextSurface.height - previousSurface.height;
}

export function tryBeginAssistedStep(state, {
    previousSurface,
    nextSurface,
    previousX,
    previousZ,
    candidateX,
    candidateZ,
    physicalEyeY,
    eyeHeight,
    grounded,
    jumpQueued,
} = {}) {
    if (!state || state.active || !grounded || jumpQueued) return false;
    if (!finiteSurface(previousSurface) || !finiteSurface(nextSurface)) return false;
    if (nextSurface.assistedStep !== true) return false;

    const rise = surfaceRise(previousSurface, nextSurface);
    const allowedRise = Number(nextSurface.maxAssistedRise ?? nextSurface.entryRise ?? 0);
    if (rise <= MAX_WALK_STEP_RISE + FLOOR_CONTACT_TOLERANCE
        || !Number.isFinite(allowedRise)
        || rise > allowedRise + FLOOR_CONTACT_TOLERANCE) return false;

    // The explicit dais transition is inward-only. This prevents its metadata
    // from becoming a generic wall-climb permission when the player brushes a
    // side while moving tangentially or outward.
    const centerX = Number(nextSurface.entryCenterX ?? 0);
    const centerZ = Number(nextSurface.entryCenterZ ?? 0);
    const previousRadius = Math.hypot(previousX - centerX, previousZ - centerZ);
    const candidateRadius = Math.hypot(candidateX - centerX, candidateZ - centerZ);
    if (!(candidateRadius < previousRadius - 1e-5)) return false;

    const expectedSourceHeight = nextSurface.height - Number(nextSurface.entryRise ?? rise);
    if (Math.abs(previousSurface.height - expectedSourceHeight) > 0.08) return false;

    state.active = true;
    state.elapsed = 0;
    // Roughly 0.5 s for the upper course and 0.62 s for the 1.05 m lower
    // course: readable as one continuous climb, never a one-frame eye snap.
    state.duration = Math.max(0.42, Math.min(0.68, 0.28 + rise * 0.32));
    state.fromX = previousX;
    state.fromZ = previousZ;
    state.toX = candidateX;
    state.toZ = candidateZ;
    state.fromEyeY = physicalEyeY;
    state.targetEyeY = nextSurface.height + eyeHeight;
    state.targetKind = nextSurface.kind ?? 'assisted_step';
    state.rise = rise;
    state.starts++;
    state.lastDuration = state.duration;
    state.lastPeakFrameRise = 0;
    return true;
}

export function advanceAssistedStep(state, dt, output = {}) {
    if (!state?.active) return null;
    const frameDt = Math.max(0, Math.min(Number.isFinite(dt) ? dt : 0, 0.1));
    const previousT = clamp01(state.elapsed / Math.max(state.duration, 1e-6));
    const previousEyeY = state.fromEyeY
        + (state.targetEyeY - state.fromEyeY) * smooth01(previousT);
    state.elapsed = Math.min(state.duration, state.elapsed + frameDt);
    const t = clamp01(state.elapsed / Math.max(state.duration, 1e-6));
    const lift = smooth01(t);
    // Lift first, then carry the capsule centre across the vertical face. The
    // player therefore never travels through the solid dais at foot height.
    const forward = smooth01((t - 0.38) / 0.62);
    output.x = state.fromX + (state.toX - state.fromX) * forward;
    output.z = state.fromZ + (state.toZ - state.fromZ) * forward;
    output.eyeY = state.fromEyeY + (state.targetEyeY - state.fromEyeY) * lift;
    output.progress = t;
    output.done = t >= 1;
    output.kind = state.targetKind;
    state.lastPeakFrameRise = Math.max(
        state.lastPeakFrameRise,
        Math.abs(output.eyeY - previousEyeY),
    );
    if (output.done) {
        state.active = false;
        state.completions++;
    }
    return output;
}

export function shouldBlockHighSurfaceEntry({
    previousSurface,
    nextSurface,
    physicalEyeY,
    eyeHeight,
} = {}) {
    const rise = surfaceRise(previousSurface, nextSurface);
    if (rise <= MAX_WALK_STEP_RISE + FLOOR_CONTACT_TOLERANCE) return false;
    // A jump may enter only once the feet actually clear the top. Below that,
    // retain the previous X/Z and let gravity/jump integration continue.
    return physicalEyeY - eyeHeight
        < nextSurface.height - FLOOR_CONTACT_TOLERANCE;
}

export function cancelAssistedStep(state) {
    if (!state) return;
    state.active = false;
    state.elapsed = 0;
    state.duration = 0;
    state.targetKind = null;
    state.rise = 0;
}
