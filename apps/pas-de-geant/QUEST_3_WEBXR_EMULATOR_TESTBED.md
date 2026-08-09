# Quest 3 WebXR emulator testbed

This testbed runs Pas de Géant in a Meta Quest 3 WebXR environment without a
headset. It uses Meta's
[Immersive Web Emulation Runtime (IWER)](https://meta-quest.github.io/immersive-web-emulation-runtime/)
inside Playwright Chromium, enters an emulated immersive session, renders
stereo views, and drives the emulated headset pose programmatically.

The testbed is a functional and load diagnostic. It is not a Quest performance
benchmark: Chromium's host GPU or software WebGL renderer determines its frame
time, not the Quest's Adreno GPU, browser compositor, thermal state, or display.
Use the repository's `quest:debug` helper for physical-device performance
measurements.

## Included Pisa scenario

The reusable scenario is
[`tests/browser/pas-de-geant.xr-emulator.spec.ts`](../../tests/browser/pas-de-geant.xr-emulator.spec.ts).
It performs these steps:

1. Start at Pisa (`43.722952, 10.396597`) with the application's default scale.
2. Enter an IWER Meta Quest 3 immersive session with stereo rendering enabled.
3. Call `pasDeGeantDebug.beginBenchmark()` to disable physical and controller
   movement and reset the runtime controls.
4. Wait until the terrain and photographic planner queues reach zero.
5. Capture the default-scale stereo view.
6. Call `pasDeGeantDebug.setScale(15000)`.
7. Wait until both planner queues reach zero, then freeze tile recalculation as
   described by the normal benchmark workflow.
8. Capture forward and downward stereo views at scale `15,000`.
9. Turn the emulated headset left, backward, and right. Each pose must produce
   a newer XR render frame; the complete pose and runtime snapshot is recorded.
10. Write a JSON audit, restore the benchmark state, and end the XR session.

`15,000` is the exact scale value passed to `setScale`. It is not a route
distance or a 15 km observation radius. Runtime snapshots retain the
implementation's `displayRadiusM` field name, but the scenario and artifacts
refer to the requested value as **scale 15,000**.

## Run it

From the repository root:

```sh
npm install
npm run test:browser:xr
```

The XR configuration reuses a development server already listening on port
4197. If none exists, Playwright starts the app's Vite development server and
stops it after the run. This is deliberately a development-server test: WebXR
emulation is enabled by `?xrEmulation=quest3` only in development builds, or in
a build explicitly created with `VITE_ENABLE_XR_EMULATION=1`.

Use a different port when necessary:

```sh
PAS_DE_GEANT_XR_PORT=4297 npm run test:browser:xr
```

The default emulated drawing buffer is fixed at 800 by 450 pixels. Fixing the
viewport makes planner inputs reproducible and keeps stereo software rendering
practical. Override it explicitly for a separate labelled experiment:

```sh
PAS_DE_GEANT_XR_VIEWPORT_WIDTH=1600 \
PAS_DE_GEANT_XR_VIEWPORT_HEIGHT=900 \
npm run test:browser:xr
```

Larger buffers can be much slower in headless Chromium and change the
screen-density-dependent tile targets. Do not compare results from different
viewport sizes as if they were the same configuration.

For a visible browser window:

```sh
npm run test:browser:xr -- --headed
```

## Outputs

Each run writes ignored, disposable artifacts below
`.cache/pas-de-geant-xr-testbed/`:

- `01-pisa-default.png`
- `02-pisa-scale-15000-forward.png`
- `03-pisa-scale-15000-down.png`
- `pisa-quest3-webxr-audit.json`
- a Playwright trace when the test fails

The separate cache location prevents the normal `test:browser` suite from
clearing the XR evidence when it resets its own `test-results/` directory.

The terminal prints the exact JSON path and a concise summary. The JSON retains
the emulator device/version, headset position and quaternion, session state,
scale and location, tile controls, planner state, drawing buffer, renderer
counts, and rolling frame telemetry for every stage. Frame telemetry is useful
for detecting stalls or proving that a pose produced frames, but it must not be
reported as Quest hardware performance.

## What the setup changes

[`src/bootstrap.ts`](./src/bootstrap.ts) is now the browser entry point. With no
emulation query parameter it simply imports the normal application. When the
explicit test parameter is allowed, it installs IWER before `main.ts` checks
`navigator.xr`, exposes `window.pasDeGeantXrEmulator`, and then starts the app.

The wrapper exposes only the operations needed by diagnostics:

```ts
pasDeGeantXrEmulator.snapshot()
pasDeGeantXrEmulator.setHeadsetPose({
  pitchDegrees: -25,
  yawDegrees: 90,
})
pasDeGeantXrEmulator.endSession()
```

The explicit emulator path forces IWER over Chromium's native `navigator.xr`.
This is necessary because headless Chromium may expose a native WebXR object
even when it has no XR device; without the override, Three.js displays
`VR NOT SUPPORTED`. Normal pages do not request this override.

## Extending the testbed

Keep scenario-specific actions in the XR Playwright spec rather than adding
them to production controls. Useful extensions include:

- additional locations and scale sequences;
- controller sticks, triggers, grips, or buttons through IWER;
- hand-tracking poses and input-mode transitions;
- `visible-blurred`, hidden, tracking-loss, and recenter lifecycle cases;
- action recordings captured from a real Quest and replayed through IWER.

For a new diagnostic, preserve these invariants:

- assert that the emulator is `Meta Quest 3` with stereo enabled;
- assert `renderer.xr.presenting === true` before sampling;
- fix and record the viewport;
- use the debug benchmark controls to disable accidental physical input;
- wait for both planner queues to reach zero before freezing topology;
- record scale values without reinterpreting them as geographic distances;
- do not treat host-renderer FPS as Quest FPS.

## Verified run

The initial headless verification on 2026-08-09 passed in 4.1 minutes with
IWER 2.3.0. It used an 800 by 450 stereo buffer, entered a reported 90 Hz
emulated session, reached default-scale queue idle in 12.5 seconds, reached
scale-15,000 queue idle in 30.2 seconds, and produced distinct frames for all
six recorded stages. The scale-15,000 targets were terrain zoom 13 and
photographic zoom 17 in that run.

Those timings describe one local, cache-dependent diagnostic run. They are not
a performance baseline or an assertion in the test.
