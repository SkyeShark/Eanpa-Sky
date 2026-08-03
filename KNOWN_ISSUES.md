# Known issues — v0.1

Actively being worked on, roughly in this order:

1. **Warped/whorled ground textures** on steep terrain — a texture projection
   trick tuned for small hills breaks on the new mountains. Diagnosed; fix in
   progress.
2. **Ground materials don't follow the terrain yet** — the baked terrain
   ships with rock/soil/wear maps, but the ground still paints with the older
   hand-authored layering. Wiring the baked maps in is the next major step.
3. **Screen-space reflection (SSR) bugs.** Known concrete case: glitching at
   the bottom of the screen near the Inanna orb — the fix (screen-edge fade
   on SSR) exists in the eidoverse-video implementation and is pending port.
   Beyond that one, full parity with the eidoverse-video reflection fixes has
   **not** been verified end to end, so additional SSR issues may exist until
   that investigation is finished.
4. **Rocks have no player collision.** Their correctly-shaped convex hulls
   are already baked (`assets/collision/`); the placement feed that connects
   them is pending.
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
9. **Cliff pieces are hand-placed**, not yet driven by the terrain
   generator's own scarp masks.
10. **First weather activation can hitch** briefly despite the boot-time
    warmup; deeper pipeline pre-compilation is planned.

The world exists to prove the sky: the sky/weather engine is the product,
the desert is its benchmark stage. Sky bug reports are the most valuable.
