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

See the [movement architecture and integration contract](docs/movement.md).
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
retain transported tangent frames. `mode` is a host-defined navigation label.
The optional browser preset maps `surface`, `observation`/`orbit`, and `ship`/`free`.
XR and desktop use separate models. `controls.pointer` selects `look`, `grab`, `orbit`, or `none`.
The `movement` option accepts a model object or a host selection function.
`movement: false` omits the placement adapter.
`controls: false` disables manual controls. `controls: { movement: false }` disables manual locomotion while tracking continues.
The top-level `movement: false` omits the placement adapter. Set `xr: true` to install the
SkyKit session adapter and its host-local entry button. `time` is `now` or an ISO
UTC timestamp ending in Z; `timeRate` is a finite playback rate, including zero.

Defaults use bundled NASA Earth/Moon base imagery and explicit reference
surfaces with **no measured elevation or high-resolution tile service**. Other
registered bodies have plain globes. This keeps startup independent of API routes
and development tile-cache hosts. Stars, XR and AI are opt-in. Missing base
imagery falls back to a plain reference colour.

## Standard controls and extensions

The browser installs one `createGeantControlsPlugin()` using
`standardGeantControlScheme`. It owns keyboard, pointer and XR input together.
XR session setup is separate: `xr: true` adds the entry button and tracking;
`controls: false` leaves tracking available without manual navigation.

| Input | Standard behavior |
| --- | --- |
| WASD | Surface or desktop free travel. Desktop orbit uses movement around the body. |
| Shift | Faster desktop travel |
| Z/X | Desktop world scale |
| C/V | Desktop orbital distance |
| Drag / wheel | Desktop look, orbit, scale, or orbital distance |
| Left stick / left grip in surface and observation | Contact travel / faster travel |
| Right stick horizontal in surface and observation | Snap turn, with 30 degrees per deflection |
| Right stick vertical in surface | Physical altitude above terrain or the reference surface |
| Right stick vertical in observation | Map height in room metres |
| Right stick / right grip in ship | Ship travel / faster travel |
| Left stick / left grip in ship | Pitch and yaw / roll modifier |

The standard XR scheme does not change scale.
Planner overlays, terrain adjustment, and voice shortcuts have no standard bindings.
A diagonal surface gesture selects one right-stick function until neutral.
Small travel inputs retain their magnitude.
`controls.speedHeadsetMPerSecond` overrides travel speed in room metres per second.

Schemes are immutable data with stable binding IDs. Extend with `add`, `replace`
or `remove`. Duplicate IDs and overlapping input conditions are rejected;
replacement is explicit. Conditions can select navigation/pointer modes and
required or excluded modifiers. Bindings invoke arbitrary public action IDs.
Feature plugins expose actions; the consuming application chooses their inputs.
Planner and terrain plugins ship no keyboard or XR binding fragments.

```ts
import {
  createGeantTileDebugPlugin, createGeantTerrainToolsPlugin,
  extendGeantControlScheme, standardGeantControlScheme,
} from "@found-in-space/pas-de-geant";
import { investigationBindings } from "./controls.js"; // Authored by your application.

const tools = extendGeantControlScheme(standardGeantControlScheme, {
  id: "my-investigation",
  add: investigationBindings,
});
const browser = await createGeantBrowser({
  host,
  controls: { scheme: tools },
  plugins: [createGeantTileDebugPlugin(), createGeantTerrainToolsPlugin()],
});
```

The planner plugin supplies terrain/imagery overlay actions and a small host
panel. Applications can invoke `GEANT_TILE_DEBUG_ACTIONS` through any chosen
binding, UI or programmatic caller. It follows the viewer's selected worlds and
replacement surfaces; uninstalling hides the overlays.

Terrain tools supply a numeric multiplier, Restore 1× control and
`GEANT_TERRAIN_TOOL_ACTIONS.adjust` for application-authored bindings.
Exaggeration changes the representation; it does not change source elevations.
Installing/removing tools preserves the current multiplier. Configuration and
`geant:terrain.setMultiplier` remain available without the tools plugin.
Both tool factories accept `{ panel: false }` for hosts supplying their own UI.
The built-in panels are HTML; in immersive XR applications can author controller
bindings or compose a Touch OS panel with the same actions.

For a live viewer, `browser.controls?.setScheme(nextScheme)` replaces the scheme
without adding another input owner. `describeGeantControlScheme(scheme)` derives
help from its actual bindings. To remove an extension, replace its bindings
first, then call the teardown returned by `await browser.install(plugin)`.
Blur, visibility changes, navigation/focus changes, rebinding, XR transitions
and source changes clear held inputs. Release keys/sticks/buttons before
starting a new interaction. Disposal releases listeners, parts and captures.

`GEANT_MOTION_ACTIONS` exposes move, altitude, attitude, recenter, orbit, distance, drag, scale, and look commands.
The selected model supplies movement behavior. They use the public action
registry, including canonical navigation adapters. Continuous commands accept
`deltaSeconds`; movement components are `right`/`forward`, orbital components
are `x`/`y`, adjustments use `value`, and look takes angular displacements
`yawRadians`/`pitchRadians`. A binding's `component`, `multiplier`, `payload`
and optional `timeScale` map input into those commands. One-shot key/button
bindings use press edges. Continuous key/button bindings specify `phase: "hold"`.
An XR axis binding can use `phase: "press"` for one command per deflection.
Tracked XR cameras retain their head orientation; manual turning moves the rig.

The alpha demo-specific `controllerIntent`/`freshButtonLatch` API was removed.
`createGeantXrPlugin()` now owns sessions only. Install controls separately when
using the explicit viewer route. The browser route installs standard controls
automatically. Navigation mode remains independent of the control scheme.

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
plugin/part/action lifecycle. Install the worlds and movement plugins separately.
`createGeantViewer()` installs no default movement model.
The host supplies `createGeantMovementPlugin({ model })` and its required controls.
Call `viewer.update()` and `viewer.render()` from the host scheduler.
The [integration procedure](docs/movement.md#integration-procedure) shows the complete composition. `getGeantContext`
exposes domain state and world handles to ordinary plugin objects.

First-party factories include worlds, movement, controls, planner diagnostics, terrain
tools, stars, a Touch OS panel adapter, and SkyKit XR. `createGeantStarPass()` is the advanced explicit multipass path;
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
`geant:navigation.setMode` (a host-defined label), `geant:navigation.setAltitude` (physical metres), `geant:body.focus`, `geant:scale.set` (1:N),
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
