# Pas de Géant

One public package for planetary models, streamed surfaces and composable
browser experiences. This is a local alpha implementation; no npm or CDN release
is implied. Isolated development cases live in the repository's `integration/`
workspace and use only public exports.

| Export | Responsibility |
| --- | --- |
| `@found-in-space/pas-de-geant` | Explicit viewer composition, state/actions and plugin factories |
| `/worlds` | Body models, providers, streaming and rendering |
| `/worlds/skykit` | Optional SkyKit lifecycle adapter |
| `/browser` | `createGeantBrowser({ host, ...options })` |
| `/embed` | Attributes, `mount`, `unmount`, `whenReady`, `mountAll`, and `Geant` |
| `/ai` | Optional VoiceOS browser runtime/plugin |

Internal filenames are implementation details. See [world capabilities](docs/worlds.md)
for source contracts, coordinates, terrain, caching and ownership.

## JavaScript browser

```ts
import { createGeantBrowser } from "@found-in-space/pas-de-geant/browser";

const moon = await createGeantBrowser({
  host: document.querySelector<HTMLElement>("#moon")!,
  bodies: ["moon"],
  location: { latitudeDegrees: 18, longitudeDegrees: -24 },
  scaleDenominator: 50, // physical metres per render metre: 1:50
  controls: { pointer: "grab" },
  stars: false,
});
await moon.actions.invoke("geant:scale.set", { scaleDenominator: 100 });
await moon.dispose();
```

Hosts may provide their own dimensions; an empty unstyled host receives a
420-pixel-high viewer. Each instance owns a generated subtree, renderer,
configuration, navigation, providers, workers, resize observation and animation
loop. A Moon viewer constructs no Earth runtime and needs no Earth services.
Keyboard input belongs to the focused viewer; editable fields remain usable.
`start()`, `stop()`, `resize()`, `install(plugin)` and `getSnapshot()` are exposed.
Repeated disposal is safe. An explicitly supplied renderer is borrowed and its
GPU resources are not disposed by the browser.

`bodies` selects construction; `focusBody` chooses the navigation target from
that set. `locations` stores independent per-body coordinates. Surface contacts
retain transported tangent frames. `mode` is `surface`, `orbit` or `free`;
`controls.pointer` is separately `look`, `grab`, `orbit` or `none`.
`controls: false` disables manual controls. `movement: false` disables manual
locomotion while tracked XR head motion continues. Set `xr: true` to install the
SkyKit session adapter and its host-local entry button. `time` is `now` or an ISO
UTC timestamp ending in Z; `timeRate` is a finite playback rate, including zero.

Defaults use bundled NASA Earth/Moon base imagery and explicit reference
surfaces with **no measured elevation or high-resolution tile service**. Other
registered bodies have plain globes. This keeps startup independent of API routes
and development tile-cache hosts. Stars, XR and AI are opt-in. Missing base
imagery falls back to a plain reference colour.

## Datasets and surfaces

Imagery and elevation are independent per-body selections. Use `datasets` with
explicit `imagery` and/or `elevation` bindings containing `productUrl`,
`urlTemplate`, `attribution`, and optional `addressing` (`xyz` or `tms`). Source
descriptors are admitted before tile bytes are interpreted; mismatched grids,
units or datums fail startup. Configured descriptor errors are surfaced to the
caller. Checksums in descriptors identify sources; the runtime does not claim
cryptographic payload verification. Use 256-pixel display products for Quest;
scientific elevation keeps its separately admitted dimensions.

For custom XYZ services, prepared sparse products and application-specific
fallbacks, supply `surfaces: { moon: async ({ renderer, signal }) => source }`.
A `WorldSurfaceSource` independently supplies the base, imagery, elevation and
surface model. Create mutable providers inside the factory for each viewer.
Returned providers transfer to the instance; base textures transfer only with
`disposeBaseTexture: true`. Factories must honour their abort signal and clean
up allocations if they reject. Shared immutable cache bytes are safe; mutable
providers and GPU resources need explicit ownership.

`await browser.setSurface(body, factory)` prepares a replacement, processes its
surface to readiness, switches atomically, then disposes the old runtime. A
failed or superseded replacement leaves the old surface active. Keep the browser
running while waiting for readiness. Authored compositions own their own surface
replacement policy.

## Plugins and authored composition

`createGeantViewer({ renderer, scene, camera, ...configuration })` is the direct
composition route. It borrows rendering resources and supplies the real SkyKit
plugin/part/action lifecycle. Call `install(createGeantWorldsPlugin(...))`, then
`viewer.update()` and `viewer.render()` from the host's scheduler. `getGeantContext`
exposes domain state and world handles to ordinary plugin objects.

First-party factories include worlds, controls, stars, a Touch OS panel adapter,
and SkyKit XR. `createGeantStarPass()` is the advanced explicit multipass path;
it retains the tested observer/projection behavior without importing an authored
journey. Aircraft and satellite extensions remain separate packages.

Hosts can use the browser's advanced `compose(viewer, signal)` hook for
explicit frame order and rendering. Page layout, URL interpretation, service
policy and authored experiences belong to the host. Development cases have no
special access to package internals and are excluded from the default build.

```ts
await browser.install({
  id: "my-readout",
  setup(context) {
    return context.addPart({ id: "my-frame", update(frame) { /* ... */ } });
  },
});
```

Domain actions include `geant:navigation.setLocation` (degrees/metres),
`geant:navigation.setMode`, `geant:body.focus`, `geant:scale.set` (1:N),
`geant:terrain.setMultiplier`, `geant:navigation.travel` (physical metres),
`geant:navigation.setObserver` (heliocentric J2000 metres), and `geant:time.set`
(UTC milliseconds/rate). SkyKit action invocation returns settled handler
results; inspect rejected results when calling programmatically.

## HTML embed

Build with `npm run build:embed` at the repository root and copy the **entire**
`dist/embed` directory to your static site. No application API routes are needed.

```html
<div data-geant-browser data-geant-bodies="moon"
     data-geant-location="18,-24" data-geant-scale="50"
     data-geant-controls="grab" style="height:400px"></div>
<script type="module" src="/geant/geant.js"></script>
```

Attributes also include `data-geant-focus-body`, `data-geant-mode`,
`data-geant-stars`, `data-geant-keyboard`, `data-geant-movement`, `data-geant-xr`,
`data-geant-terrain-multiplier`, `data-geant-time`, `data-geant-time-rate`,
`data-geant-datasets` (a per-body JSON object of explicit bindings), and
`data-geant-ai-endpoint`, and `data-geant-ai-profile`. Boolean values are `true` or `false`.

```js
import { Geant } from "/geant/geant.js";
const browser = await Geant.whenReady(document.querySelector("[data-geant-browser]"));
await Geant.unmount(browser.host);
// Explicit mount is idempotent; failed hosts can be retried after fixing their options.
```

The embed scans at DOM readiness. Dynamic pages use explicit mount/unmount;
there is no global mutation observer. Startup failures reject `mount`/`whenReady`
and dispatch `geant:error` during automatic mounting. Importing other entry
points starts no viewer and mutates no page state.

The npm distribution contains ESM, declarations, workers and base assets for
bundlers. Its tested Three.js baseline is **0.170.0**, matching the released
SkyKit dependency peers. External consumers should share this instance. The
self-contained embed bundles its compatible Three instance;
custom script add-ons should use the viewer context instead of introducing a
second Three runtime. Mixing separate SkyKit/Geant script bundles needs a shared
bundler/import-map build; two independently bundled runtimes are not supported.

Module workers are bundled with their dependencies. The static embed defaults
to a Blob module bootstrap for cross-origin module graphs (CORS and `worker-src
blob:` are required). Hosts whose CSP excludes Blob workers can pass
`workers: createWorldWorkerFactory({ "terrain-scheduler": sameOriginUrl,
"imagery-scheduler": sameOriginUrl, "imagery-decoder": decoderUrl })` from
`/worlds`. Keep all distribution files together.

## Optional AI

Install the compatible `@found-in-space/voice-os@0.1.0-alpha.1` peer to use `/ai`.
Set `ai: { sessionEndpoint: "/your/token-route", profile: "your-profile" }` or
install `createGeantAiPlugin(...)` explicitly. No microphone or connection starts
until activation. Tools invoke the same domain actions and report selected-body
state; Earth geocoding is not implicitly installed. The endpoint must be backed
by an authorized token service advertising matching tools. Credentials and token
issuance remain outside the browser graph. Service failure leaves worlds usable.

## Development and validation

From the repository root, run `npm run check`, `npm test`, `npm run build`,
`npm run build:embed`, `npm run check:spatial-package`, and
`npm run check:package -- --offline`. After building the embed,
`npm run check:embed` runs the focused static-host acceptance check; it requires
an installed Chromium (or `GEANT_BROWSER_EXECUTABLE`). `npm run examples` serves the independent
instances and declarative examples; `npm run build:examples` builds static output.
Packed checks use an unrelated temporary consumer, including shared Three
resolution, exports/types and standalone workers/assets.

Desktop and physical Quest acceptance are separate from unit/build checks.
No physical Quest acceptance or npm publication is implied by this source tree.

Use VoiceOS's external token-service tooling and configure its endpoint/profile.
The service can derive matching Geant contracts from `geantAiCapabilities(bodies)`.
The isolated `integration/voice.html` case exercises that public adapter; this
repository contains no token server or authored voice agent.
