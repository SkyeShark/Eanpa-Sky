Run `node qa/performance-review.mjs my-run` with Node 24, Python, and Chrome.
`BROWSER_PATH` and `PYTHON_PATH` override platform defaults. Ports 8378 and 9223
must be free; the runner refuses to attach to another session.

The runner owns and cleans up its browser profile, processes, and server. It
records initial startup, texture-upgrade completion when available, sky quality,
Earth/Ringworld/return switches, and the optional effects selector. Screenshots,
process logs, and `report.json` go to `.artifacts/performance/my-run/`.

`curtainMs` measures a control change to the loading curtain closing after GPU
completion. `firstFrameObservedMs` additionally waits for the game frame counter
to advance, with up to 100 ms polling uncertainty. Neither is physical display
latency. `MAX_SWITCH_MS` sets a failure budget; the default is 180 seconds.
Page/GPU errors, failed startup, failed upgrades, and incomplete switches fail
the run. These checks complement frame benchmarks, which exclude rebuilds.

Localhost measurements isolate construction and compilation, not internet
download speed. Record actual adapters and compare repeated runs with matching
viewports/cache conditions. Browser shader-cache clearing does not clear the
driver cache or control unrelated GPU work. The reduced effects mode must be
visually checked on reflective objects as well as measured for speed.
