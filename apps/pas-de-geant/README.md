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

Before running any ADB command, open Meta Quest Developer Hub and confirm that
the headset is connected and authorized there. Use the ADB associated with
that working Developer Hub connection before trying another ADB installation;
`adb` below refers to that executable.

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
tile/source request-decode-upload metrics, recent resource timing,
WebGL capabilities, and browser heap. `mark(name)` retains a named snapshot;
control changes and `clearMetrics()` start a clean frame window.

The reproducible high-zoom Amsterdam-to-Rotterdam browser audit is documented
in [AMSTERDAM_ROTTERDAM_TILE_AUDIT.md](./AMSTERDAM_ROTTERDAM_TILE_AUDIT.md).
It records the exact route, warm-up and arrival conditions, temporary full-cut
audit exposure, actual in-app Browser failure and Playwright fallback, complete
browser/server configuration, verbatim temporary test source, executed
commands, metric definitions, cache caveats, and the before/after results.

For repeatable measurements, `beginBenchmark(options)` captures the live
session, disables walking and controller-driven scale changes, resets the
render/tile controls, and moves to an exact location. Let both planner queues
reach zero, freeze topology-target recalculation with
`setTileRecalculation("both", false)`, then clear the metrics before sampling.
Geometric horizon culling remains live while topology is frozen. `endBenchmark()`
restores the captured location, scale, inputs, layers, and tile controls. A
useful high-load, near-sea-level case is Pisa at scale 2500:

```js
pasDeGeantDebug.beginBenchmark({
  latitudeDegrees: 43.722952,
  longitudeDegrees: 10.396597,
  displayRadiusM: 2500,
  radialMultiplier: 1,
})
```

The repository helper checks Meta Quest Developer Hub's ADB first, opens the
Quest Browser DevTools socket, and combines the runtime snapshot with device
GPU busy/clock, CPU clocks, browser-process memory, battery, and thermal data:

```sh
npm run quest:debug -- snapshot
npm run quest:debug -- device
npm run quest:debug -- targets
npm run quest:debug -- call setLocation '[45.88,6.89]'
npm run quest:debug -- call setMaxZ '["textures",14]'
```

Run `targets` before opening the browser console. It forwards local port 9222
to the Quest Browser's `chrome_devtools_remote` socket and lists the available
pages. Open `http://127.0.0.1:9222/json/list` in a desktop browser, find the Pas
de Géant page, open its `devtoolsFrontendUrl`, and select the Console tab.

If the helper reports that no device is available or authorized, return to
Meta Quest Developer Hub and restore its connection before trying another
ADB. Set `PAS_DE_GEANT_ADB` only after checking Developer Hub and confirming
that the working ADB is installed in a nonstandard location.

`setRendering(false)` keeps simulation and tile work running but skips the
Three.js render call, which separates main-thread simulation cost from render
submission. If disabling rendering restores the target frame rate, compare
framebuffer scale and layer visibility to distinguish fill cost from scene
complexity. XR framebuffer scale must be changed after leaving VR and before
re-entering; foveation can change during a session.

## Controls

- Left stick: head-relative travel
- Left trigger + left stick left/right: turn the view
- Left grip: faster travel
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
Terrarium pages hydrate only horizon-retained members of the planner-owned committed
terrain cut. The photographic pipeline loads and commits independently, and a
fragment can resolve a finer imagery page than the terrain mesh containing it.
Elevation is required before a new terrain replacement commits. A confirmed
missing elevation page resolves as flat terrain; a missing photographic page
resolves to an available ancestor or Blue Marble. Neither kind of 404 blocks
its sibling cells.

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

When the configured source is MapTiler `satellite-v2`, the application uses
MapTiler Satellite Plain's 256 px raster endpoint by default while preserving
the configured key and attribution:

- the default and `?imageryVariant=maptiler-256` use 256 px raster tiles;
- `?imageryVariant=maptiler-512` remains available as an explicit diagnostic
  override for the configured 512 px raw source.

For example, compare
`http://127.0.0.1:4197/?imageryVariant=maptiler-512` with
`http://127.0.0.1:4197/?imageryVariant=maptiler-256`. The photographic tile
onion remains 8 by 8 in both cases. Its source-pixel size is supplied to the
existing imagery zoom selector, and each variant has a distinct provider and
request URL so their pages cannot share cache identity.

During local development, textures and elevation use the canonical same-origin
route `/api/tiles/{provider}/{z}/{x}/{y}`. The server registry expands those
coordinates through the selected provider's HTTP(S) URL template. Provider IDs
not present in the registry return 404, so the endpoint cannot be used as an
open forward proxy.

The initial registry exposes `textures`, the diagnostic `textures-source`, and
`elevation`. Each provider has its own request coalescing, throttle queue, and
cache namespace below the repository's ignored `.cache/tiles` directory. By
default, each queue permits 16 upstream requests at a time and spaces starts
by 10 ms (about 100 starts per second). A provider's `Retry-After` pauses only
its own queue; rate-limit responses without that header use a five-second
fallback. Production builds and previews keep the configured direct provider
URLs.

The development defaults can be tuned in `.env.local`:

```sh
PAS_DE_GEANT_TILE_PROXY_MAX_CONCURRENCY=16
PAS_DE_GEANT_TILE_PROXY_MIN_INTERVAL_MS=10
PAS_DE_GEANT_TILE_PROXY_DEFAULT_TTL_MS=86400000
PAS_DE_GEANT_TILE_PROXY_UPSTREAM_BACKOFF_MS=5000
PAS_DE_GEANT_TILE_PROXY_CACHE_DIRECTORY=../../.cache/tiles
PAS_DE_GEANT_TILE_PROXY_CACHE_KEY_IGNORED_QUERY_PARAMETERS=key
PAS_DE_GEANT_TILE_PROXY_TEXTURES_UPSTREAM_TEMPLATE=
PAS_DE_GEANT_TILE_PROXY_TEXTURES_SCHEME=xyz
PAS_DE_GEANT_TILE_PROXY_ELEVATION_UPSTREAM_TEMPLATE=https://tiles.mapterhorn.com/{z}/{x}/{y}.webp
PAS_DE_GEANT_TILE_PROXY_ELEVATION_SCHEME=xyz
PAS_DE_GEANT_TILE_PROXY_UPSTREAM_HEADERS_JSON={}
PAS_DE_GEANT_TILE_PROXY_FORWARD_REQUEST_HEADERS=origin,referer,user-agent
PAS_DE_GEANT_TILE_PROXY_TEXTURES_UPSTREAM_HEADERS_JSON=
PAS_DE_GEANT_TILE_PROXY_TEXTURES_FORWARD_REQUEST_HEADERS=
PAS_DE_GEANT_TILE_PROXY_ELEVATION_UPSTREAM_HEADERS_JSON=
PAS_DE_GEANT_TILE_PROXY_ELEVATION_FORWARD_REQUEST_HEADERS=
PAS_DE_GEANT_TILE_PROXY_PROVIDERS_JSON=
```

The fallback TTL applies only when an otherwise cacheable image response does
not publish an explicit lifetime. `no-store` and `private` responses are never
written to disk. The cache has no automatic size eviction; remove
`.cache/tiles` manually when a clean development run is needed. The ignored
query-parameter list keeps rotating credentials out of cache identity; set it
to the parameter names used by the configured providers. URL templates may put
`{z}`, `{x}`, and `{y}` in any order and may include extensions and query
parameters. Set a provider's scheme to `tms` when its upstream Y axis is
inverted. Fixed upstream headers are configured as a JSON object. Incoming
headers are forwarded only when named in the comma-separated forwarding list;
this is useful for providers that validate `Origin`, `Referer`, or
`User-Agent`. Fixed values take precedence over forwarded values. The texture
and elevation variables override the shared defaults for their respective
providers.

Additional provider IDs and per-provider overrides can be supplied as a JSON
object in `PAS_DE_GEANT_TILE_PROXY_PROVIDERS_JSON`; each record accepts
`urlTemplate`, `scheme`, `upstreamHeaders`, `forwardRequestHeaders`, and the
throttle/cache settings shown above in camelCase. Forwarded headers do not vary
the cache identity, so they should identify or authorize the same tile content
rather than select a different representation.

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

Location questions give the guide the unrounded live WGS 84 latitude and
longitude underfoot, plus an address-level reverse lookup with mapped feature,
road, neighbourhood, locality, region, country, and water details when
available. The coordinates remain authoritative because the nearest mapped
feature returned by reverse geocoding is approximate.

The guide can also rotate the virtual world around the observer. For example,
say “look right”, “look left”, “look behind”, “face west”, or “rotate the view
to 270 degrees”. Absolute headings use compass bearings clockwise from north;
relative turns keep controller travel and physical walking aligned with the
rotated world.

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
while the app is running. Ask it to change screen pixels per source pixel or
set or clear a topology max-z for terrain, textures, or both. Payload work is
restricted to planner-owned topology and replacement groups that intersect the
geometric surface horizon.

Terrain and texture topology-target recalculation can be frozen independently
to inspect one planned world selection while the other continues replanning.
For example, ask “freeze terrain recalculation” or “resume texture
recalculation.” Horizon culling continues to follow observer location and eye
height while a target is frozen, so beyond-horizon planner work can remain
deferred; re-enabling a pipeline immediately applies the latest topology
target. The guide reads the controls before reporting them and returns the
effective terrain and texture target zooms after each change.

Ask “what is the tile planner waiting for?” or “are texture tiles still
loading?” to read planner and scheduler state. The report separates topology
requirements, tile-payload bridge requests, and provider source fetch jobs;
source fetches may be fewer because several tile requests can share one source.

## Other layers

The celestial sphere loads the default Found in Space SkyKit catalogue and
uses Astronomy Engine to rotate J2000 directions into the current Earth-fixed
frame. Catalogue failure leaves an empty sky without blocking the surface. The
voice guide can show or hide the Sun, Moon, each planet, all planets, or all
Solar System bodies without changing the background star catalogue.

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
