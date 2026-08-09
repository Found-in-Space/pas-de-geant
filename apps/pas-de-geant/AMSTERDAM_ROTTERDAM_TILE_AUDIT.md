# Amsterdam to Rotterdam tile-loading audit

This document records the browser diagnostic used on 2026-08-09 to measure
high-zoom tile churn, cancellation, backpressure, destination fetch latency,
and destination commit latency while moving from Amsterdam to Rotterdam.

This was a diagnostic Playwright test, not a permanent regression test. The
temporary full-cut audit hook and route test were removed after each run. The
steps below are sufficient to reconstruct the same diagnostic without changing
application behaviour.

## What actually ran in this task

The measured Amsterdam-to-Rotterdam route was run in the repository's
standalone Playwright Chromium process. It was **not** run through the Codex
in-app Browser tab and it was not run in Chrome or on the Quest.

The actual sequence was:

1. Connect the Codex in-app Browser and open the already-running local app.
2. Discover that Browser page evaluation returned `undefined` for
   `window.pasDeGeantDebug`, even though the page console showed that the app
   had installed the debug API.
3. Stop trying to drive the measurement through that Browser tab.
4. Add a temporary read-only `tileAudit()` method to the app's existing debug
   interface.
5. Append a temporary route diagnostic to the existing repository Playwright
   spec.
6. Run that one test with the repository `npm run test:browser` script.
7. Capture its `ROUTE_AUDIT` terminal output.
8. Remove the temporary debug exposure and Playwright test.

No browser extension, login, cookie state, mobile emulation, network
throttling, service-worker override, or Quest connection was involved.

## Initial in-app Browser attempt

This section is historical context, not the route runner. It explains why the
test changed to standalone Playwright.

The browser runtime was initialized in the persistent JavaScript tool using
this exact code and plugin path:

```js
if (globalThis.agent?.browsers == null) {
  const { setupBrowserRuntime } = await import(
    "/Users/kws/.codex/plugins/cache/openai-bundled/browser/26.730.61639/scripts/browser-client.mjs"
  )
  globalThis.agent = await setupBrowserRuntime()
}
if (globalThis.browser == null) {
  globalThis.browser = await agent.browsers.getDefault()
  nodeRepl.write(await browser.documentation())
}
```

The existing tabs were checked with:

```js
var tabsNow = await browser.user.openTabs()
nodeRepl.write(tabsNow)
```

The local page was then opened with:

```js
globalThis.appTab = await browser.tabs.new()
await appTab.goto("http://127.0.0.1:4197/")
await appTab.playwright.waitForLoadState({
  state: "domcontentloaded",
  timeoutMs: 10000,
})
await appTab.playwright.waitForTimeout(2500)
```

The page's development console contained:

```text
[vite] connecting...
[vite] connected.
Pas de Géant runtime controls: window.pasDeGeantDebug.help()
```

However, this exact page evaluation:

```js
var dbgProbe = await appTab.playwright.evaluate(() => ({
  href: location.href,
  type: typeof window.pasDeGeantDebug,
  keys: Object.keys(window).filter((key) => key.includes("pasDe")),
}))
nodeRepl.write(dbgProbe)
```

returned:

```js
{
  href: "http://127.0.0.1:4197/",
  keys: [],
  type: "undefined",
}
```

That mismatch is why the Amsterdam-to-Rotterdam measurement itself used the
repository Playwright runner. A follow-up agent reproducing the recorded test
does not need to repeat this failed in-app Browser probe.

## Local server that was actually used

The app server was already running before the route test. Availability was
checked with:

```sh
curl -I --max-time 3 http://127.0.0.1:4197
```

The task also fetched the served source to confirm that the development build
contained the debug API:

```sh
curl -s --max-time 3 http://127.0.0.1:4197/src/main.ts | \
  rg -n "pasDeGeantDebug =|Development build" | tail -n 10
```

The Vite client messages above confirm that this was the live Vite development
server, not a separately launched production preview. The route task did
**not** execute `npm run dev`, `npm run build`, or `npm run preview`; it reused
that existing server.

To reproduce the same setup when port 4197 is not already serving the current
worktree, start it in a separate terminal before running Playwright:

```sh
npm run dev -- --port 4197
```

Wait until `http://127.0.0.1:4197/` responds. Leave that process running. This
ensures Playwright's `reuseExistingServer: true` path matches the recorded run.

## Exact Playwright browser configuration

The run used [playwright.pas-de-geant.config.ts](../../playwright.pas-de-geant.config.ts)
unchanged. Its complete configuration at the time was:

```ts
import { defineConfig } from "@playwright/test";

const port = process.env.PAS_DE_GEANT_PORT ?? "4197";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "tests/browser",
  testMatch: "pas-de-geant.spec.ts",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL,
    geolocation: {
      latitude: 35.6762,
      longitude: 139.6503,
    },
    permissions: ["geolocation"],
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      `npm run preview --workspace @found-in-space/pas-de-geant -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
```

Important consequences:

- The browser was Playwright's bundled/default Chromium project. No explicit
  browser channel, viewport, device descriptor, headless flag, or launch
  arguments were supplied.
- Playwright normally runs headless when `headless` is not overridden.
- The Tokyo geolocation in the config only supplied initial page permission
  and startup location. `beginBenchmark()` immediately replaced it with the
  exact Amsterdam coordinates.
- Because a Vite server already responded on port 4197,
  `reuseExistingServer: true` meant the fallback `vite preview` command was not
  used.
- Traces would be kept only if the test failed. The recorded run passed, so no
  retained failure trace was used for the reported measurements.

The root [package.json](../../package.json) script used by the run was:

```json
{
  "scripts": {
    "test:browser": "playwright test --config playwright.pas-de-geant.config.ts"
  }
}
```

## Exact temporary source used by the runner

The route was not executed by a standalone script under `scripts/`. It was a
temporary Playwright `test(...)` block appended to
`tests/browser/pas-de-geant.spec.ts`.

The verbatim 495-line test block recovered from this task is preserved as a
non-executable documentation fixture:

[amsterdam-rotterdam-tile-audit.spec.ts.txt](../../tests/browser/amsterdam-rotterdam-tile-audit.spec.ts.txt)

The two exact `apply_patch` inputs used to expose `tileAudit()` and add the
browser test type declaration are preserved separately:

[amsterdam-rotterdam-tile-audit-hooks.apply_patch.txt](../../tests/browser/amsterdam-rotterdam-tile-audit-hooks.apply_patch.txt)

For an exact reconstruction:

1. Read and apply both recorded patch blocks in the hooks file, in order.
2. Append the complete contents of the `.spec.ts.txt` fixture to the existing
   `tests/browser/pas-de-geant.spec.ts` using `apply_patch`.
3. Do **not** rename the fixture and expect Playwright to discover it:
   `testMatch` selects only `pas-de-geant.spec.ts`.
4. Do not alter the existing `beforeEach`. It enables
   `window.__PAS_DE_GEANT_ENABLE_TEST_HOOKS__`, opens `/`, and waits for
   `#loading-state` to become hidden. The route test then installs its fetch
   init script, reloads once, and waits for the loading state again.

The fixture is deliberately `.txt` so normal typechecking and browser tests do
not collect it. It records exactly what ran; it is not a maintained regression
test.

## Exact commands executed for the recorded run

From `/Users/kws/work/fis/pas-de-geant`, after applying the temporary hooks and
test block, the commands were:

```sh
npm run typecheck
```

The first typecheck exposed missing `window.pasDeGeantDebug` declarations in
the browser-test TypeScript context. The recorded second hook patch added those
declarations to `tests/browser/test-globals.d.ts`, after which this was run
again and passed:

```sh
npm run typecheck
```

The single route diagnostic was then launched with exactly:

```sh
npm run test:browser -- --grep \
  "audits high-zoom travel from Amsterdam to Rotterdam after planned-delta ordering"
```

In the Codex sandbox this command was executed with approval to allow the
Playwright process to connect to the local server. The shell command itself was
unchanged.

The process printed:

```text
Running 1 test using 1 worker
```

Its intermediate `console.log` output was buffered in this run. The task
polled the still-running Playwright process approximately every 30 seconds; the
complete `ROUTE_AUDIT` object appeared when the process exited. The final runner
status was:

```text
1 passed (2.4m)
```

No other browser script, Quest helper, ADB command, browser extension, or
external traffic-capture program was run for this measurement.

## Environment and important caveats

- Run from the repository root.
- The measured runner was the existing Playwright Chromium harness in
  `playwright.pas-de-geant.config.ts`.
- Its configured URL was `http://127.0.0.1:4197`, where it reused the already
  running Vite development server.
- The application was tested with its normally configured elevation and
  photographic-imagery providers. No artificial latency or network throttling
  was added.
- The ignored proxy cache at `.cache/tiles` was **not cleared**. Consequently,
  the later run was a warm-cache run and must not be compared with a cold-cache
  run as if network conditions were identical.
- Do not delete `.cache/tiles` merely to reproduce the historical run. If a
  clean-cache experiment is wanted, make that a separately labelled test and
  record that the cache was cleared.
- The later run measured `HEAD d76582f` plus the uncommitted direct-delta and
  descending-z scheduler changes. Those changes removed intermediate
  refinement requests and ordered the current planned delta by descending z.

Validate the source before running:

```sh
npm run typecheck
```

## Fixed test parameters

| Parameter | Value |
|---|---:|
| Amsterdam | `52.3676, 4.9041` |
| Rotterdam | `51.9244, 4.4777` |
| Display radius | `1500 m` |
| Radial multiplier | `1` (the benchmark default) |
| Travel duration | `20,000 ms` |
| Amsterdam warm-up timeout | `240 s` |
| Post-arrival observation timeout | `120 s` |
| Warm-up polling interval | `1 s` |
| Travel planner-sampling interval | `250 ms` |
| Post-arrival polling interval | `1 s` |
| Expected terrain underfoot z | `11` in the recorded runs |
| Expected imagery underfoot z | `13` in the recorded runs |
| Terrain provider concurrency | `4` |
| Imagery provider concurrency | `6` |

Derive the z values from the runtime planner target rather than hard-coding
them. The z11/z13 values above are recorded results, not test inputs.

## Temporary exact-cut audit exposure

`pasDeGeantDebug.snapshot()` exposes counts and targets, but the test also
needed exact committed and planned tile identities. For the run, a temporary
read-only `pasDeGeantDebug.tileAudit()` method was added with this shape:

```ts
{
  terrain: {
    revision: number,
    committed: string[],
    planned: string[],
    requirements: Array<{ key: string; state: string }>,
  },
  textures: {
    revision: number,
    committed: string[],
    planned: string[],
    requirements: Array<{ key: string; state: string }>,
  },
}
```

Each pipeline produced its fields directly from its latest scheduler snapshot:

```ts
{
  revision: snapshot.revision,
  committed: snapshot.committedCut.map(tileIdentityKey),
  planned: snapshot.requestedCut.map(tileIdentityKey),
  requirements: snapshot.requirements.map(({ tile, state }) => ({
    key: tileIdentityKey(tile),
    state,
  })),
}
```

The temporary method was implemented on `ImageryVirtualTexture`, combined by
`TerrainSurface`, and exposed through the existing development debug API in
`main.ts`. Add the corresponding declaration to
`tests/browser/test-globals.d.ts` while the diagnostic exists. Remove all of
these temporary additions after capturing the result.

This exposure is intentionally read-only. It must not drive or modify planner
state.

## Network instrumentation

The Playwright test added an init script **before reloading the page**. The init
script wrapped `window.fetch` and recorded requests matching:

```text
^/api/tiles/(elevation|textures(?:-source)?)/(\d+)/(\d+)/(\d+)$
```

Map `elevation` to the `terrain` pipeline and both texture provider IDs to the
`textures` pipeline. Store tile identities as `z/x/y`.

For every matching request, record:

- provider, key and z;
- `performance.now()` at fetch start;
- whether the key was in the pipeline's `planned` cut at that instant;
- whether the key was in `requirements` at that instant;
- `performance.now()`, HTTP status, or thrown error name when fetch settled;
- whether the key was planned, committed, or required when a successful fetch
  settled.

Use the original `fetch` unchanged for the actual request. Do not delay,
replace, route, or synthesize responses.

There is a small worker-to-main-thread observation race: the worker can request
a tile just before the main-thread audit snapshot containing that requirement
arrives. The recorded later run therefore saw four terrain and five imagery
fetches before `tileAudit()` reported them. Do not automatically interpret
that number as irrelevant loading. Correlate such starts with the subsequent
planner revision and final planned cut.

## Underfoot tile calculation

The test calculated the destination identity using standard Web Mercator XYZ:

```ts
function tileKey(latitude: number, longitude: number, z: number): string {
  const count = 2 ** z;
  const latitudeRadians = latitude * Math.PI / 180;
  const x = Math.floor((longitude + 180) / 360 * count);
  const y = Math.floor(
    (1 - Math.log(
      Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians),
    ) / Math.PI) / 2 * count,
  );
  return `${z}/${x}/${Math.max(0, Math.min(count - 1, y))}`;
}
```

At every warm-up and arrival poll, read each pipeline's current
`planner_target.maxZoom` from `pasDeGeantDebug.snapshot()` and recalculate the
underfoot key. Do not assume the expected z remains unchanged.

## Exact run sequence

### 1. Load and establish Amsterdam

Enable the existing browser test hooks, open `/`, and wait for
`#loading-state` to be hidden. After installing the fetch wrapper, reload and
wait for the loading state again.

Start the controlled state:

```js
pasDeGeantDebug.beginBenchmark({
  latitudeDegrees: 52.3676,
  longitudeDegrees: 4.9041,
  displayRadiusM: 1500,
})
pasDeGeantDebug.setTileRecalculation("both", true)
```

The second call is essential: `beginBenchmark()` freezes recalculation while it
establishes its baseline.

Poll once per second for at most 240 seconds. Amsterdam is established when
both the terrain and imagery underfoot keys are members of their respective
`committed` arrays. The historical run deliberately did not require every
background request to be idle, although queue state at departure was recorded.

Immediately before movement:

1. Save the Amsterdam committed keys and queue/outstanding counts.
2. Clear the fetch-event array so the route summary excludes warm-up traffic.
3. Call `pasDeGeantDebug.clearMetrics()`.

### 2. Move over exactly 20 seconds

Use page-side `requestAnimationFrame`, not 20 seconds followed by one location
jump. On every callback, linearly interpolate both coordinates and call
`setLocation`:

```js
const startedAt = performance.now()

function update(now) {
  const progress = Math.min(1, (now - startedAt) / 20_000)
  pasDeGeantDebug.setLocation(
    52.3676 + (51.9244 - 52.3676) * progress,
    4.9041 + (4.4777 - 4.9041) * progress,
  )
  if (progress < 1) requestAnimationFrame(update)
}

requestAnimationFrame(update)
```

Record the actual start and end `performance.now()` values and the number of
location updates. Every 250 ms, capture:

- planner revision and exact planned cut for each pipeline;
- source queue and in-flight counts;
- planner requested, in-flight, and total-outstanding counts.

Do not call the large audit method on every animation frame. The later run made
35 location updates in 20.354 seconds because the page was under heavy work;
that update count is part of the result.

### 3. Observe Rotterdam

At arrival, recalculate the terrain and imagery underfoot keys from the current
planner target. Poll once per second for up to 120 seconds.

For each pipeline record:

- first matching destination fetch start relative to arrival;
- matching fetch completion relative to arrival;
- first poll at which the destination key is committed relative to arrival;
- queue, in-flight, and total-outstanding counts.

Stop early only after both destination underfoot keys are committed. A missing
fetch or commit after 120 seconds is reported as `null`/not observed rather
than failing the diagnostic immediately.

## Summary calculations

For terrain and imagery separately, report:

- fetch starts, successful settlements, aborts, and still-pending fetches;
- unique keys and duplicate starts (`sum(count(key) - 1)` for keys started
  more than once);
- starts during and after the 20-second movement;
- successful fetches that were no longer planned, committed, or required when
  they settled;
- starts grouped by z;
- sampled planned-cut additions and removals whenever the sampled revision
  changes;
- peak source queue, source in-flight, and planner total-outstanding counts.

The diagnostic asserted only the established provider backpressure caps:

```ts
expect(peakTerrainInFlight).toBeLessThanOrEqual(4)
expect(peakTextureInFlight).toBeLessThanOrEqual(6)
```

Everything else was reported for diagnosis rather than frozen as a timing
assertion.

## Command

The temporary test was named:

```text
audits high-zoom travel from Amsterdam to Rotterdam after planned-delta ordering
```

It was run with:

```sh
npm run test:browser -- --grep \
  "audits high-zoom travel from Amsterdam to Rotterdam after planned-delta ordering"
```

The test timeout was set to 600 seconds. The recorded later run passed in 2.4
minutes.

## Recorded results

### Earlier run, before direct final-plan scheduling

- Route duration: 20.188 s.
- Amsterdam imagery took about 151 s to establish; both underfoot pipelines
  took roughly three minutes in total.
- At departure, terrain still had 47 queued and 51 total outstanding requests;
  imagery was idle.
- Neither Rotterdam terrain `11/1049/677` nor imagery `13/4197/2708` was even
  fetch-started or committed during the 120-second post-arrival window.
- Terrain: 80 starts, 64 completions, 12 aborts, 4 pending, 80 unique, no
  duplicates, no restarted-after-abort requests, and no stale successful
  completions. Peak queue/in-flight/outstanding was 70/4/74.
- Imagery: 121 starts, 89 completions, 31 aborts, 1 pending, 121 unique, no
  duplicates, no restarted-after-abort requests, and no stale successful
  completions. Peak queue/in-flight/outstanding was 108/6/114.

### Later run, with direct final-plan scheduling and descending-z admission

- Amsterdam established after approximately 19 one-second polls. Both
  pipelines had zero outstanding requests at departure. This was a warm-cache
  result and is not directly comparable to the earlier run's different cache
  and departure-queue state.
- Route duration: 20.354 s, with 35 location updates.
- Rotterdam terrain key: `11/1049/677`.
  - Fetch started 10.063 s before arrival.
  - Fetch completed 9.440 s before arrival with HTTP 200.
  - Tile committed 3.902 s after arrival.
- Rotterdam imagery key: `13/4197/2708`.
  - Fetch started 6.505 s after arrival.
  - Fetch completed 7.171 s after arrival with HTTP 200.
  - Tile did not commit until 84.380 s after arrival.
- Terrain: 126 starts and completions, no aborts, no pending requests, 126
  unique keys, no duplicates, and no stale successful completions. There were
  29 starts during movement and 97 afterward.
- Imagery: 232 starts, 195 successful settlements, 37 aborts, no pending
  requests, 232 unique keys, no duplicates, and no stale successful
  completions. There were 80 starts during movement and 152 afterward.
- Peak queue/in-flight/outstanding:
  - Terrain: 105/4/109.
  - Imagery: 164/6/170.
- Sampled planned-cut churn during movement:
  - Terrain: 2 sampled revisions, 141 additions, 159 removals.
  - Imagery: 5 sampled revisions, 408 additions, 417 removals.

The later run showed that destination network admission was no longer starved,
but imagery still waited about 77 seconds after its HTTP response before the
destination key committed. The fetch wrapper does not distinguish decode-ready,
scheduler-ready, atomic-swap, and GPU-publication times; a follow-up diagnostic
should timestamp those stages separately.

## Cleanup and verification

After collecting the terminal output:

1. Remove the temporary `tileAudit()` methods and debug-API declaration.
2. Remove the temporary Playwright route test, restoring the normal browser
   spec.
3. Do not remove or overwrite unrelated worktree changes.
4. Run:

```sh
npm run typecheck
git diff --check
git status --short
```

Before handing off, verify that no temporary changes remain in `main.ts`,
`imagery.ts`, `terrain-surface.ts`, `tests/browser/test-globals.d.ts`, or
`tests/browser/pas-de-geant.spec.ts`.
