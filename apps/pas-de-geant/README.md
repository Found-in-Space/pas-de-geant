# Pas de Géant

_Walk around worlds, one small step at a time._

Pas de Géant is a room-scale WebXR terrain globe. The un-displaced WGS 84
surface meets the physical floor beneath the observer. Walking or controller
travel rolls the planet through that contact point.

## Run locally

From the repository root:

```sh
npm run dev -- --port 4197
```

Open `http://127.0.0.1:4197`. The desktop fallback uses WASD to travel, Z/X to
change planet scale, C/V to change radial exaggeration, and Backspace to reset.

WebXR requires a secure context. A USB-connected Quest can use an Android
reverse tunnel:

```sh
adb reverse tcp:4197 tcp:4197
```

Then open `http://localhost:4197` in the headset.

### Quest runtime diagnostics

Development builds expose `window.pasDeGeantDebug` to the Quest Browser
JavaScript console. A deployed build exposes it only when the page is opened
with `?debug=1`. It can read the complete tile planner and runtime metrics and
change the simulation without leaving VR:

```js
pasDeGeantDebug.help()
pasDeGeantDebug.snapshot()
pasDeGeantDebug.setLocation(45.88, 6.89)
pasDeGeantDebug.setScale(80)
pasDeGeantDebug.setRadialMultiplier(2)
pasDeGeantDebug.setMaxZ("textures", 14)
pasDeGeantDebug.setTilePixelRatio("textures", 1.5)
```

The runtime snapshot includes a rolling ten-second frame distribution,
application CPU time, draw calls and primitives, Three.js resource counts,
tile/source request-decode-upload-residency metrics, recent resource timing,
WebGL capabilities, and browser heap. `mark(name)` retains a named snapshot;
control changes and `clearMetrics()` start a clean frame window.

For repeatable measurements, `beginBenchmark(options)` captures the live
session, disables walking and controller-driven scale changes, resets the
render/tile controls, and moves to an exact location. Let both planner queues
reach zero, freeze them with `setTileRecalculation("both", false)`, then clear
the metrics before sampling. `endBenchmark()` restores the captured location,
scale, inputs, layers, and tile controls. A useful high-load, near-sea-level
case is Pisa at scale 2500:

```js
pasDeGeantDebug.beginBenchmark({
  latitudeDegrees: 43.722952,
  longitudeDegrees: 10.396597,
  displayRadiusM: 2500,
  radialMultiplier: 1,
})
```

The repository helper uses Meta Quest Developer Hub's bundled ADB, opens its
Quest Browser DevTools socket, and combines the runtime snapshot with device
GPU busy/clock, CPU clocks, browser-process memory, battery, and thermal data:

```sh
npm run quest:debug -- snapshot
npm run quest:debug -- device
npm run quest:debug -- call setLocation '[45.88,6.89]'
npm run quest:debug -- call setMaxZ '["textures",14]'
```

Set `PAS_DE_GEANT_ADB` only if ADB is installed somewhere other than Meta
Quest Developer Hub's standard macOS location. The helper forwards local port
9222 to `chrome_devtools_remote`; Chrome can inspect the same endpoint at
`http://127.0.0.1:9222`.

`setRendering(false)` keeps simulation and tile work running but skips the
Three.js render call, which separates main-thread simulation cost from render
submission. If disabling rendering restores the target frame rate, compare
framebuffer scale and layer visibility to distinguish fill cost from scene
complexity. XR framebuffer scale must be changed after leaving VR and before
re-entering; foveation can change during a session.

## Controls

- Left stick: head-relative travel
- Left trigger: faster travel
- Right stick vertical: whole-planet scale
- Right stick horizontal: radial terrain and altitude exaggeration
- X: toggle committed terrain-tile tint and boundaries
- Y: toggle photographic source-tile boundaries
- A: toggle the Realtime voice guide
- Hold B: reset location and scale

The hand panel uses touch-os and the embedded NASA Blue Marble image to show
the underfoot point, display scale, radial multiplier, committed terrain zoom
range, and voice-agent state.

## Terrain and imagery library

The production surface is composed from reusable, provider-neutral modules:

- the tile-onion layout calculates a complete, non-overlapping, 2:1 balanced
  XYZ cut;
- the transition planner finds the minimal atomic replacement groups between
  two complete cuts;
- the payload-neutral worker scheduler owns the committed terrain resources,
  cancels superseded work, and publishes only complete atomic swaps;
- cancellable image providers coalesce source requests and reuse decoded
  overzoom ancestors;
- an independent photographic planner maintains a virtual-texture page table
  and GPU texture-array pool at its own draw and source zooms;
- `TerrainSurface` is the only application-facing integration point.

Terrain z comes from observer height above the flat, un-displaced Earth
surface, latitude, render-buffer focal length, elevation page resolution, and
its own screen-density target. Photographic z uses a separate metre-per-texel
target and hysteresis. Either pipeline can therefore be capped, overzoomed,
and tuned without changing the other. Terrain elevation never feeds back into
LOD selection.

The embedded Blue Marble is immediate, complete fallback imagery. Mapterhorn
Terrarium pages hydrate the committed terrain cut. The photographic pipeline
loads and commits independently, and a fragment can resolve a finer imagery
page than the terrain mesh containing it. Elevation is required before a new
terrain replacement commits. A confirmed missing elevation page resolves as
flat terrain; a missing photographic page resolves to an available ancestor
or Blue Marble. Neither kind of 404 blocks its sibling cells.

Terrarium displacement is decoded and bilinearly sampled in the vertex shader.
Draw tiles sample cropped regions of source ancestors after the provider's
maximum zoom. Shallow skirts hide unavoidable raster/LOD edge differences.
There is no hidden inner globe: only the committed Web Mercator surface and
flat Blue Marble polar caps are rendered.

Photographic source pages retain their native dimensions in a mipmapped,
anisotropic GPU texture array. A double-buffered page table maps continuous Web
Mercator fragment coordinates to an exact page or an overzoomed provider
ancestor. Existing mappings remain visible until a replacement mapping is
ready. Press Y to inspect photographic source boundaries; press X to inspect
the independent committed terrain cut.

### Optional photographic imagery

No network imagery provider is hard-coded. Configure one at build time:

```sh
VITE_IMAGERY_XYZ_TEMPLATE='https://example.test/{z}/{x}/{y}.jpg'
VITE_IMAGERY_ATTRIBUTION='Required provider attribution'
VITE_IMAGERY_PROVIDER_ID='provider-id'
VITE_IMAGERY_TILE_SIZE=512
VITE_IMAGERY_MIN_ZOOM=0
VITE_IMAGERY_MAX_ZOOM=22
```

The URL and attribution are required together. Source tiles retain their
native dimensions, requests never exceed the provider maximum zoom, and deep
draw levels crop the corresponding source ancestor.

Mapterhorn publishes its endpoint and source-level attribution at
<https://mapterhorn.com/data-access/> and
<https://mapterhorn.com/attribution/>.

## Location and Realtime guide

At startup, the app first asks the browser for device location, then tries an
approximate GeoJS location, and finally falls back to 0° N, 0° E. Reset returns
to the resolved starting point.

To enable the voice guide, copy `.env.example` to `.env.local`, add an OpenAI
API key, and restart the local server. The browser receives only a short-lived
Realtime client secret from `POST /api/realtime/token`.

```sh
cp apps/pas-de-geant/.env.example apps/pas-de-geant/.env.local
```

The local server also performs cached OpenStreetMap Nominatim reverse lookups
for the guide. The upstream endpoint can be replaced with
`PAS_DE_GEANT_GEOCODER_URL`.

### Voice research tools

The guide can look up external facts without sending arbitrary URLs from the
headset. It uses English Wikipedia for stable background questions (for
example, “What is plate tectonics?”) and live web search for current, recent,
or niche questions (for example, “Search the web for today’s Alpine weather”).
A more specific follow-up causes a new, narrower lookup.

The voice session still requires the server-only `OPENAI_API_KEY`. Wikipedia
needs no additional upstream API key, while live web search reuses the OpenAI
key already configured for Realtime; it is never exposed to browser code.
Search results appear in a compact Research area with linked source titles,
while the voice guide speaks the substantive answer and never reads the source
URLs aloud.

### Voice tile-debug controls

The voice guide can read and tune the terrain and photographic tile pipelines
while the app is running. Ask it to change screen pixels per source pixel, set
or clear a topology max-z, enable or disable the warm view-distance buffer,
change its overhead percentage, or set or clear a payload delta-z cap for
terrain, textures, or both. A delta-z of 3 retains the four payload bands from
z through z-3 without changing the complete mixed-LOD tile topology. Disabling
view distance loads the full eligible current tile onion.

Terrain and texture recalculation can be frozen independently to inspect one
current world selection while the other continues following the view. For
example, ask “freeze terrain recalculation” or “resume texture recalculation.”
Rendering and already-started tile work continue while frozen; re-enabling a
pipeline immediately applies the latest view. The guide reads the controls
before reporting them and returns the effective terrain and texture target
zooms after each change.

Ask “what is the tile planner waiting for?” or “are texture tiles still
loading?” to read planner and scheduler state. The report separates topology
requirements, tile-payload bridge requests, and provider source fetch jobs;
source fetches may be fewer because several tile requests can share one source.

## Other layers

The celestial sphere loads the default Found in Space SkyKit catalogue and
uses Astronomy Engine to rotate J2000 directions into the current Earth-fixed
frame. Catalogue failure leaves an empty sky without blocking the surface.

Live Airplanes.live traffic is opt-in and only polls during an immersive VR
session. Leaving VR, hiding the page, or disabling the layer stops requests.

CelesTrak satellite tracking is also opt-in. The 100 brightest, space-station,
and combined science/education groups can be enabled independently from the
page or by asking the voice guide. Orbital elements are cached for CelesTrak's
two-hour update interval, while SGP4 propagation moves the markers locally.
Satellite altitude uses the same radial multiplier as terrain and aircraft.

## Validation

```sh
npm run check
npm test
npm run build
```

Source and licence details are in `public/THIRD_PARTY_LICENSES.txt`. Terrain
and imagery are not suitable for navigation or safety-critical use.
