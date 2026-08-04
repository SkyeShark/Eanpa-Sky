# Known issues — v0.1

Actively being worked on, roughly in this order:

1. **Warped/whorled ground textures** on steep terrain — a texture projection
   trick tuned for small hills breaks on the new mountains. Diagnosed; fix in
   progress.
2. **Ground materials don't follow the terrain yet** — material placement
   doesn't track the new mountains' rock, soil, and wear the way it should.
3. **Screen-space reflection (SSR) bugs.** Root cause identified with the
   artist: the empty below-horizon half of the cloud sky was fighting
   downward-facing reflections, because this build never wired the donor
   implementation's fixed compose. Now ported: the sky's own reflection
   layer (per-ray cloud evaluation with a below-horizon ground fallback)
   composes only where SSR misses, SSR always renders fully on top, and
   opaque materials no longer double-count the sky through env-IBL.
   Awaiting visual confirmation.
4. **Rocks have no player collision yet.**
5. **Occasional position jumps ("teleports") on collision contact.**
   Instrumented — the build logs the responsible subsystem when it happens.
6. **Two-handed wall brace doesn't trigger** — running square into a wall
   still plays a one-handed reaction; the impact-speed measurement fix is
   pending.
7. **Ground brightness steps on the High quality tier** — likely the
   10-second environment-reflection re-bake; a temporal-blend fix is planned.
8. **Stair edge trim** collision has been through several iterations this
   release; if you still hit an invisible wall walking on the trim, it's a
   known hot spot.
9. **Cliff placement is hand-authored** and due for a revision pass.
10. **Weather switching still hangs briefly**, and some other UI transitions
    (skybox changes, quality changes) carry similar hitches — known, and
    actively being optimized.

The world exists to prove the sky: the sky/weather engine is the product,
the desert is its benchmark stage. Sky bug reports are the most valuable.
