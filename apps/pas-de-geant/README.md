# Pas de Géant

_Walk around worlds, one small step at a time._

Pas de Géant is a room-scale WebXR Solar System explorer. Earth and Moon have
ground surfaces; every registered major body can be viewed orbitally or from a
camera-relative free-roam frame. Authoritative positions are physical J2000
metres in Float64 data, with one `1:N` conversion to headset metres applied only at the
render boundary. This keeps the same architecture usable from a one-metre toy
planet to a hundred-metre exploration globe and across interplanetary distance.

Shared geometry, ephemerides, surface streaming, and navigation frames live in
[`@found-in-space/worlds`](../../packages/worlds/README.md). Earth, Moon, and
plain planetary globes use `createWorldRuntime`; the Eclipse Observatory uses
the package's terrain capability. The optional `/skykit` adapter lets another
Found in Space host use this runtime through Skykit's public lifecycle.

## Run locally

From the repository root:

```sh
npm run dev -- --port 4197
```

Open `http://127.0.0.1:4197`. The desktop fallback uses WASD to travel or orbit,
Z/X to change planet scale, C/V to change orbital altitude or terrain
exaggeration, and Backspace to reset.
Use the World and Navigation selectors for Earth/Moon ground mode and any-body
orbit/free mode. M cycles navigation modes and N switches Earth/Moon.

The focused desktop Moon viewer is at `http://127.0.0.1:4197/moon/`. Drag to
orbit, scroll or pinch to approach the surface, and use the on-screen controls
or +/− keys to change distance.

For walking on the Moon, open `http://127.0.0.1:4197/?world=moon`, or use
**Walk on the Moon in VR** from either page. The launch starts in lunar ground
mode at 18° N, 24° W without requesting Earth geolocation. In the headset,
select **Enter VR**, then walk through your room or use the left stick to travel.
The right stick changes world scale vertically and relief exaggeration
horizontally; hold B to reset. This uses the same WebXR camera, controllers,
contact-frame transport, terrain runtime, and wrist panel as Earth. Moon terrain
readouts and debug controls refer to the lunar surface. Without a configured
LOLA source it renders the reference sphere with the bundled lunar imagery.

For the Apollo 11 imagery test, open **`/moon/apollo11/`** on the same HTTPS
development origin (currently `https://geant.demo.k-si.com/moon/apollo11/`
through Cudy), then select **Enter VR**. It starts in surface mode at
0.67416° N, 23.47314° E with the variable-resolution preview and **1:50** scale.
One headset metre corresponds to 50 physical lunar metres; the loaded terrain
underfoot is pinned to the physical floor, including elevations below the lunar
reference sphere. Terrain and imagery detail use camera clearance above that
loaded surface. Reset returns to the site and the launch
scale.

The equivalent full URL is
`/?world=moon&site=apollo11&scale=50&imagery=apollo11-preview`. Use
`imagery=global` to compare the same viewpoint against WAC alone, or `scale=N`
to choose another denominator. Ordinary Earth and Moon launches keep their
existing defaults. The shared imagery loader chooses an available opaque XYZ
tile from the global, Kaguya, regional NAC or landing-site NAC provider. It uses
the existing queue, source sharing, decoder, parent sampling and texture pool.
There is no VR canvas compositor or additional rendering layer. The renderer
applies the lunar display curve once.

Prepare the local Apollo payload with the sibling texture pipeline's
`prepare-preview-tiles` command, documented in its
`projects/moon/apollo11-preview/README.md`. The resulting
`.cache/apollo11-preview/runtime/product.json` declares available tiles and caps.
The producer regrids the archive images and fills masked holes before serving;
VR only fetches prepared PNGs. Partial context boundary tiles use global imagery.

The standalone Eclipse Observatory is at
`http://127.0.0.1:4197/eclipse/`. Earth, Moon, shadow cones, and the apparent
Sun remain in one coherent system frame; the unscaled headset and controllers
move through it. Its Earth reuses the terrain elevation and configured
photographic-imagery pipeline, targeted from the nearest WGS84 point beneath
the headset. The rendered WGS84-plus-topography surface is the inward altitude
floor. In VR, either grip alone leaves navigation unchanged, two grips orbit
and reorient the observer without changing Earth-centred distance or stereo
separation, the left stick moves around an Earth-centred radial sphere while
keeping Earth framed, and the right stick changes topographic altitude or
the scale denominator while preserving every Earth–Moon–Sun dimension and the
observer position in physical metres.
A/B/X/Y toggle voice, reset the Earth-orbital viewpoint, play or pause, and
show or hide the left-wrist panel.
The right trigger operates the panel ray. Desktop drag orbits the observer and
the wheel moves closer or farther as a diagnostic fallback.

### Development supervision

The Vite development server exposes a supervisor dashboard at
`http://127.0.0.1:4197/supervisor/`. An Earth ground-mode headset appears there
only while its immersive XR session is active. The dashboard shows live
position, ground-projected gaze, and `1:N` scale, and can send explicit warp or
scale-denominator commands. Map destinations
can be saved as a browser-local location library, then warped to, shown or hidden
as Earth surface markers, and independently enabled for off-screen guidance.
Multiple guides can be active together. Headset visibility survives supervision
socket reconnects but clears when the immersive XR session ends; saved locations
remain on the dashboard's development origin until removed there.

The main-world dashboard includes eclipse simulation controls in every
navigation mode without replacing the normal Earth controls. It follows live
UTC by default. The supervisor can load the verified 12 August 2026 total
eclipse paused at first contact, show or hide the shadow cones, play or pause
the shared simulation clock at 180×, scrub across the complete first-to-last
contact period, and return the whole astronomical scene to live time.

An immersive standalone Eclipse Observatory session also appears in the
dashboard with its dedicated event, UTC, playback, and timeline workspace.

Warp and scale-denominator supervision commands accept an optional `time`
duration in seconds. Positive values animate from the live state to the target
with ease-in/out; omitting `time` or setting it to zero preserves the instant
behavior. The dashboard automatically uses 1 second for a warp of at most 5 metres in
headset space and 2.5 seconds for a longer warp. Warp distance is the surface
arc at the current `1:N` scale. Dashboard scale changes always use 2.5
seconds.

Add an optional label to the headset URL when several devices are in use:

```text
http://localhost:4197/?sessionLabel=Quest%20lab
```

The session connection is an optional development aid: socket failures do not
interrupt the headset experience, and production or preview builds contain no
supervision client or dashboard. MQDH casting remains separate from this map
and command channel.

Development and preview hosts, local HTTP APIs, the tile proxy, and the
supervision socket accept browser origins on `localhost`, private or link-local
IP networks, and `k-si.com` subdomains. The origin policy does not compare the
public browser host with the Vite process's internal host, so it also works
behind a reverse proxy. Both servers listen on all local interfaces so a device
on the private subnet can connect directly.

For an additional development hostname, set
`__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` to that exact hostname in the server
process environment. Vite host checks, local HTTP APIs, and the supervision
origin checks honor the same setting, including private Tailscale HTTPS names.

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
Use `http://localhost:4197/?world=moon` for the lunar walking launch.

### Quest runtime diagnostics

Development builds expose `window.pasDeGeantDebug` to the Quest Browser
JavaScript console. A deployed build exposes it only when the page is opened
with `?debug=1`. It can read the complete tile planner and runtime metrics and
change the simulation without leaving VR:

```js
pasDeGeantDebug.help()
pasDeGeantDebug.snapshot()
pasDeGeantDebug.setLocation(45.88, 6.89)
pasDeGeantDebug.setScaleDenominator(80000)
pasDeGeantDebug.setTerrainMultiplier(2)
pasDeGeantDebug.setMaxZ("textures", 14)
pasDeGeantDebug.setTilePixelRatio("textures", 1.5)
```

The runtime snapshot includes a rolling ten-second frame distribution,
application CPU time, draw calls and primitives, Three.js resource counts,
tile/source request-decode-upload metrics, recent resource timing,
WebGL capabilities, and browser heap. `mark(name)` retains a named snapshot;
control changes and `clearMetrics()` start a clean frame window.
`controls.surfaceView` reports loaded elevation, signed height above the reference
surface, and the actual terrain clearance used to select tile detail.

The reproducible high-zoom Amsterdam-to-Rotterdam browser audit is documented
in [AMSTERDAM_ROTTERDAM_TILE_AUDIT.md](./AMSTERDAM_ROTTERDAM_TILE_AUDIT.md).
It records the exact route, warm-up and arrival conditions, temporary full-cut
audit exposure, actual in-app Browser failure and Playwright fallback, complete
browser/server configuration, verbatim temporary test source, executed
commands, metric definitions, cache caveats, and the before/after results.

The unattended Meta Quest 3 WebXR emulator testbed is documented in
[QUEST_3_WEBXR_EMULATOR_TESTBED.md](./QUEST_3_WEBXR_EMULATOR_TESTBED.md). It
uses Meta IWER and Playwright to enter a stereo emulated session, run a fixed
Pisa `1:424.73392` look-around scenario, capture views and runtime state, and
exercise headset poses without a physical headset. Emulator frame timings are
host-browser timings, not Quest hardware performance measurements.

For repeatable measurements, `beginBenchmark(options)` captures the live
session, disables walking and controller-driven scale changes, resets the
render/tile controls, and moves to an exact location. Let both planner queues
reach zero, freeze topology-target recalculation with
`setTileRecalculation("both", false)`, then clear the metrics before sampling.
Geometric horizon culling remains live while topology is frozen. `endBenchmark()`
restores the captured location, scale, inputs, layers, and tile controls. A
useful high-load, near-sea-level case is Pisa at `1:2548.40352` (the same
rendered Earth size as the former 2,500-m-radius fixture):

```js
pasDeGeantDebug.beginBenchmark({
  latitudeDegrees: 43.722952,
  longitudeDegrees: 10.396597,
  scaleDenominator: 2548.40352,
  terrainMultiplier: 1,
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

- Left stick: surface/free travel, or target-locked orbital movement
- Left trigger + left stick left/right: turn the view
- Left grip: faster travel
- Right stick vertical: whole-planet scale
- Right stick horizontal: orbital altitude, or surface terrain exaggeration
- X: toggle committed terrain-tile tint and boundaries
- Y: toggle photographic source-tile boundaries
- A: toggle the Realtime voice guide
- Hold B: reset location and scale
- M (desktop): cycle ground, orbital, and free-roam placement
- N (desktop): switch between Earth and Moon

Ground travel uses a walking-scale velocity. Orbit uses the left stick/WASD to
move around the focused body in headset-screen directions while keeping it
framed; right-stick horizontal or C/V changes altitude independently. Free roam
uses head-relative 3D thrust and increases velocity with distance from the
focused body. Left grip/Shift accelerates movement.

The hand panel uses touch-os and the embedded NASA Blue Marble image to show
the underfoot point, display scale, terrain multiplier, committed terrain zoom
range, and voice-agent state.

The Realtime voice guide also exposes `get_navigation_state` and
`set_navigation`, so requests such as “stand on the Moon”, “orbit Jupiter”, or
“make the Moon 100 metres in radius” use the same state transition functions as
the visible controls. Bodies without a detailed surface automatically enter
orbit instead of pretending to provide ground terrain.

In an immersive Earth surface session, the guide can also look up named places,
then list, add, rename, show, hide, remove, and independently enable or disable
guidance for labeled location pins. Voice-created pins and their visibility are
held only in the current XR session: hiding retains a pin so the guide can show
it again, while removing it forgets it. Requests such as “drop a pin over
Florence”, “turn the Florence pin off”, and “rename the Florence pin to Stop 1”
are resolved into the required lookup and pin-tool calls without exposing pin
IDs to the user.

## Lunar surface data

The bundled `lroc-color-2k.jpg` is the immediate, offline full-globe fallback.
For new colour and LOLA topography products, use the same spherical Mercator
XYZ scheme as Earth, with an explicit lunar radius of 1,737,400 m. The shared
loader admits each product descriptor before using its tiles, and rejects
imagery/elevation grid mismatches. Immutable format 1 imagery remains geographic
and selects its explicit compatibility model; changing a descriptor cannot
reproject stored pixels.

For local acceptance, configure the producer's imagery directory and the
separate scientific elevation directory. The imagery parent contains
`product.json` and `base.png`; elevation has its own `product.json`:

```sh
PAS_DE_GEANT_LUNAR_IMAGERY_DIRECTORY=/path/to/new-product/imagery
PAS_DE_GEANT_LUNAR_ELEVATION_DIRECTORY=/path/to/new-heights/elevation
```

Keep source data, completed products, and their validation evidence on a durable
data volume outside Git. A running viewer must not depend on `/tmp` or another
disposable build directory. Verify staged transfers against their payload
manifests before promoting them and changing these configured roots.

Reuse the running server during development. Apply configuration changes only
when switching to a validated payload and restarting that server deliberately.
The existing 512-pixel global imagery reaches zoom 8; its descriptor caps
requests independently of elevation. It is retained as an explicit diagnostic
provider and is unbound by default. Set the provider's `maxZoom` lower in the
session configuration for testing.

For static/CDN hosting, edit `public/session-config.json`. Each lunar provider
needs its public immutable `urlTemplate` and matching `productUrl`, for example:

```json
"moon-global": {
  "urlTemplate": "https://tiles.example/new-release/imagery/{z}/{x}/{y}.png",
  "addressing": "xyz",
  "attribution": "Source attribution",
  "tileSize": 256,
  "minZoom": 0,
  "maxZoom": 8,
  "productUrl": "https://tiles.example/new-release/product.json"
}
```

Bind a verified 256-pixel runtime derivative with `bindings.moonImagery`. The
example local settings file shows the matching provider override and binding.
The existing 512-pixel WAC product remains listed but unbound in the static
session file; binding it is an explicit diagnostic choice. Legacy local Moon
and Apollo environment paths likewise configure providers without selecting
them. The provider tile size must match its descriptor. Local development
products expose only the whitelisted descriptor, base and tile paths. A
descriptor fetch/validation failure
retains the bundled base and flat heights rather than guessing a grid.

The existing immutable `20261011.1` WAC CDN payload remains usable as format 1.
Its geographic zoom-0 tile supplies the equirectangular base. New format 2
products carry a separate authenticated full-latitude `base.png`; Mercator zoom
0 is unsuitable for that role. The same loader serves the main, focused Moon
and Apollo views. The shared polar caps use the base and flat reference heights
outside ±85.05112878°. Base and detail share the Quest-reviewed Moon presentation:
linear-light tone exponent `0.8`, neutral lighting, gain `1.3`, explicit output
colour conversion, then contrast `2` around output-space pivot `0.4`. Neutral
lighting omits the final solar modulation and blue fill; the imagery retains its
photographed shadows and the existing adaptive tonal balance. This is a viewing
choice, not a simulation of current surface illumination or a change to stored
source samples. Renderer-wide tone mapping is not applied to this surface curve.

Scientific heights use `kind: "elevation-xyz"`, `formatVersion: 2`, a matching
`grid`, units in metres, a reference-surface vertical datum and an explicit
encoding/bounds descriptor. LOLA RG16 stores an unsigned 16-bit value in red and
green; height is `value × 0.5 − 10,000 m`. Display imagery never supplies height
samples. Browser request URLs and provider identities include grid/product
identity so switching a local dataset cannot reuse old geographic cache bytes.
Published migrations require new immutable prefixes.

The sibling `terrain-pipeline` produces controlled height products for all six
Apollo landing sites. Its initial recipe composes global LOLA, regional
SLDEM2015 and local LROC NAC DTMs on this same Mercator grid. It converts native
units to scalar metres, retains nodata masks and declares 128 m transitions
inside overlay edges before Terrarium encoding. Terrarium decodes as
`R × 256 + G + B / 256 − 32768` metres, with at most 1/512 m encoding error.
Source spacing and stereo uncertainty remain distinct from that encoding error.

Prepared height descriptors may carry `availability`, with a complete global
maximum zoom and inclusive `[z, minX, minY, maxX, maxY]` detail ranges. The shared
height provider selects the finest available ancestor; its existing crop UVs
serve finer mesh patches. Outside local coverage it selects regional or global
heights. A missing declared tile remains a failure, so incomplete products
cannot become flat terrain. Prepared PNGs use the same indefinite browser
elevation cache, scoped by the grid and product identity in their URLs.

Build and validate the independent terrain product, then set
`PAS_DE_GEANT_LUNAR_ELEVATION_DIRECTORY` to its `elevation` directory. No special
Apollo renderer, mesh pipeline or imagery change is required. Keep a rollback
configuration for the previous product. Initial producer outputs are scratch;
desktop/Quest visual acceptance and catalog publication are separate steps.

The GDAL helper produces small display fixtures or scratch elevation migration
outputs; controlled publication imagery belongs to the sibling texture
pipeline. The helper requires an embedded or explicitly reviewed lunar source
CRS, complete UInt16 LOLA samples for heights, and a new output directory:

```sh
npm run lunar:tiles -- \
  --elevation /data/ldem_64_uint.tif \
  --source-crs /data/reviewed-source.wkt \
  --projection web-mercator \
  --output /data/new-moon-elevation
```

It performs actual reprojection, preserves the numeric encoding, uses nearest
encoded pyramid samples and records source/code/grid/command/payload evidence.
Missing target height coverage is rejected. It does not deploy or publish its
scratch output. Existing elevation bytes without a scientific descriptor are
not silently assigned a new grid. See
[the migration guide](../../docs/surface-grid-migration.md) for replay and
acceptance steps.

### Compare native lunar imagery locally

The dataset preview downloads the 0–3° N, 0–3° E Kaguya seamless and standard
ortho tiles, plus the corresponding native LROC WAC source strip. It creates
a synchronized pan/zoom comparison, losslessly encoded PNG display tiles,
and GeoTIFFs preserving the original values and lunar coordinates. Kaguya's
8.42 m and 7.40 m grids remain at their original 10,800² and 12,288² dimensions;
WAC remains at 100 m/pixel. Select either dataset in either panel and use its
1:1 button to inspect one source pixel per physical display pixel.

Run from the repository root with a Python interpreter containing GDAL and
NumPy (the development Mac's Homebrew GDAL uses the interpreter below):

```sh
/opt/homebrew/opt/python@3.14/bin/python3.14 scripts/build-lunar-preview.py --download
python3 -m http.server 4198 --bind 127.0.0.1 --directory .cache/lunar-preview/site
```

Open `http://127.0.0.1:4198/`. Omit `--download` to rebuild from cached sources.
The approximately 635 MB of sources and 550 MB of compiled previews stay in
the ignored `.cache/lunar-preview/` directory. This preview is independent of
the application development server and does not configure the globe's imagery.

Both Kaguya images use a shared 0.5–99.5 percentile display stretch after
applying their respective PDS scale/offset values. WAC uses its own stretch
and has different illumination. PNG display values are 8-bit; the GeoTIFFs
retain the source precision and validity masks. Highest-resolution tiles are
pixel copies of the tone-mapped source; lower levels use area averaging.
No sharpening is applied. This one patch does not assess neighboring joins,
polar coverage, or the optional NASA colour composite. Provenance, exact grid
dimensions, scales, and display intervals are recorded in `manifest.json`.

The join study extends that same viewer with a four-tile junction at 3° N,
3° E, transitions at 84° N/S, and polar tile joins at 88° N/S along the prime
meridian. Run this after building the original comparison:

```sh
/opt/homebrew/opt/python@3.14/bin/python3.14 scripts/build-lunar-join-preview.py --download --build
```

It reuses the existing preview server. Select a **Study area**, toggle **Join
lines**, and use **1:1 pixels** to inspect the assembled image. Equatorial
samples preserve each product's native grid. Polar samples use the same lunar
stereographic projection at 10 m/pixel, with bilinear resampling; these are
compiled output pixels rather than untouched cylindrical source pixels. The
seamless polar transition is a deliberate hard switch at 84° latitude, with
no blending or fallback fill to hide a mismatch. The preview is opaque: low
saturation displays as black, high saturation as white, and blank data as
black. Saturation categories use nearest-neighbour reprojection separately
from the calibrated values. Scientific GeoTIFFs retain their validity masks.
The area outside each cropped sample also displays as black.

The study covers representative polar-region joins, not the complete caps at
90°. JAXA's host ignores byte-range requests; the downloader reads a normal
source stream through its last needed row, preserving those original bytes
and the detached label in `.cache/lunar-preview/join-sources/`. Cached complete
images are reused. Scene JSON files record source windows, radiometric scales,
output grids, and valid-pixel fractions. Derived GeoTIFFs contain calibrated
Float32 samples. Both products and all joins within a scene share one display
stretch. Use `--build` without `--download` to rebuild entirely from the cache.

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

Terrain z comes from camera clearance above loaded terrain, latitude,
render-buffer focal length, elevation page resolution, and
its own screen-density target. Photographic z uses a separate metre-per-texel
target and hysteresis. Either pipeline can therefore be capped, overzoomed,
and tuned without changing the other. Surface mode pins the sampled terrain
contact to the physical floor, so crouching changes that clearance directly.

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

### Tile sources and the development cache

**Quest display imagery baseline: 256 × 256 pixels for every body and provider.**
Earlier physical Quest testing found performance problems with 512-pixel
imagery. The 512-pixel option is diagnostic only; a Moon/Apollo product declaring
512 pixels does not establish acceptance for normal Quest use. This concerns
display imagery, not elevation. See the [tile-size decision and known integration
gap](../../docs/quest-imagery-tile-size.md).

The headset loads `session-config.json` once from the application base path,
including on nested pages. It contains versioned provider records with complete
tile URL templates, XYZ/TMS addressing, attribution, zoom coverage, optional
product descriptors, and named Earth/Moon/Apollo bindings. The static build
packages `public/session-config.json`; change that file to select public hosted
providers. No tile server is part of the production application.

For development, set the independent cache's browser-reachable origin in
`apps/pas-de-geant/.env.local`:

```sh
PAS_DE_GEANT_TILE_CACHE_URL=https://your-independent-cache.example
```

Earth imagery and elevation use that cache by default. The development server
delivers its resolved configuration at `/session-config.json`; the headset
requests tiles directly from the selected provider. Cache host details remain
in local settings and upstream credentials remain with the cache service.

Copy `session-config.local.example.json` to the ignored
`session-config.local.json` for per-provider overrides. A provider can specify
its own `urlTemplate` and `productUrl` for a hosted service, or `localRoot` and
`localTilePathTemplate` for a temporary product. A local root must contain a
validated `product.json` and live on durable storage outside Git. The dedicated
development server serves only descriptors, declared base images and tile
paths at `/_local-tiles/{providerId}/…`; it does not proxy or redirect. The
same-origin route is available to a headset through the development origin.

Development MapTiler source URLs are rejected unless deliberately enabled. An
unavailable cache fails the selected tile request without falling back to an
upstream. Emergency direct access requires the exact explicit setting:

```sh
PAS_DE_GEANT_ALLOW_DIRECT_MAPTILER=I_ACCEPT_MAPTILER_RATE_LIMIT_RISK
```

Leaving this unset is the normal development configuration. A public CDN or
other explicitly selected source can use its own path and query syntax. The
default 256-pixel variant uses the cache's `textures` provider; the diagnostic
512-pixel variant uses `textures-source`. Both have independent bindings and
remain persistent browser cache keys.

Successful imagery and Earth elevation are retained indefinitely in browser
Cache Storage, including proxy and explicitly configured source URLs. The
independent service retains good tiles indefinitely on disk, including legacy
expired metadata. Upstream backoff and outages must not block access to the
server cache: it returns retained imagery first and temporary, marked black
HTTP 200 images for missing display tiles during backoff. The imagery loader
accepts those placeholders without pausing other cache requests. They use short
HTTP freshness and never enter indefinite browser Cache Storage; subsequent
requests can obtain real imagery after recovery. This applies to display
imagery, not numeric elevation. Actual cache-service failures remain retryable
errors. Source identity
changes and explicit invalidation replace retained content. Browser storage
remains subject to the browser's own eviction policy.

## Location and Realtime guide

Both the walking and eclipse experiences use the independent
`@found-in-space/voice-os` package. `src/voice-agent.ts` composes its runtime and
browser adapter; `src/voice-contracts.ts` shares tool declarations with the
trusted configurations in `src/voice-profiles.ts`. Application commands,
geocoding, knowledge services, controller labels and greetings stay here.
`src/realtime-token-server.ts` supplies Geant's origin and profile selection
policy to the shared server helper. Automatic VAD response creation is retained.
The app pins the published `0.1.0-alpha.1` package and its registry integrity in
the npm lockfile. To adopt a later tested release, run
`npm install @found-in-space/voice-os@<version> --workspace @found-in-space/pas-de-geant --save-exact`
at the repository root, then run `npm run check`, `npm test`, `npm run build`
and `npm run api:build`. Live microphone, speaker, interruption and recovery
checks in a browser and Quest remain part of host acceptance; offline tests
and production builds do not establish physical audio behavior.

At startup, the app first asks the browser for device location, then tries an
approximate GeoJS location, and finally falls back to 0° N, 0° E. Reset returns
to the resolved starting point.

To enable the voice guide, copy `.env.example` to `.env.local`, add an OpenAI
API key, and restart the local server. The browser receives only a short-lived
Realtime client secret from `POST /api/realtime/token`.

```sh
cp apps/pas-de-geant/.env.example apps/pas-de-geant/.env.local
```

The local server also performs cached OpenStreetMap Nominatim forward and
reverse lookups for the guide. Their upstream endpoints can be replaced with
`PAS_DE_GEANT_FORWARD_GEOCODER_URL` and `PAS_DE_GEANT_GEOCODER_URL`.

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

## Amazon forest outlines

[MapBiomas Amazonia Collection 6](https://amazonia.mapbiomas.org/en/en/mapbiomas-amazonia-collection/)
contains one 30 m land-cover band per year from 1985 through 2023. Its download
tool can export spatial GeoTIFF tiles whose bands retain that year order. The
repository pipeline mosaics any number of those tiles, extracts natural-forest
classes, resamples the binary forest mask, traces its 50% boundary, simplifies
the result in metres, and packages it as surface polylines:

```sh
npm run amazon:outlines -- \
  --input-dir /data/mapbiomas-amazonia-collection-6 \
  --output apps/pas-de-geant/public/data/amazon-forest \
  --years 1985,1995,2005,2015,2023 \
  --lod globe:4000:8000 \
  --lod regional:500:1000 \
  --source-label "MapBiomas Amazonia Collection 6"
```

The command requires the GDAL command-line tools but does not download or
publish anything. Pass individual tiles with repeated `--input` options instead
of `--input-dir` when useful. Official whole-Amazon, single-year files can be
passed explicitly instead:

```sh
npm run amazon:outlines -- \
  --year-input 1986=/data/mapbiomas-amazon-1986.tif \
  --year-input 2023=/data/mapbiomas-amazon-2023.tif \
  --output /data/pas-de-geant/amazon-forest \
  --lod globe:4000:8000 \
  --lod regional:500:1000
```

By default, pixel value 1 (aggregated natural
forest) and its subclasses 3 (forest formation), 4 (savanna/open forest), 5
(mangrove), and 6 (flooded forest) count as natural forest, following the
Collection 6
[legend](https://amazonia.mapbiomas.org/en/legend-codes/). Use
`--forest-classes` to choose another definition or collection. `--years` also
accepts ranges such as `1985-2023`; omitting it converts every input band.

Every `--lod` is `name:raster-cell-metres:line-simplification-metres`. These
values are explicit because a continent-scale outline and a close surface view
need materially different fidelity. The working mask is averaged before its
50% contour is traced, so the output is a generalized boundary rather than an
assertion that the source itself has coarser pixels. Simplified segments are
geodesically subdivided at 25 km by default so they remain on the globe instead
of cutting visibly through it; change that with `--max-segment-metres`.

The output `manifest.json` lists each year and LOD, its bounds, line/point
counts, byte size, and relative `.pdg-lines` URL. The binary representation is
little-endian and contains a 40-byte header followed by line records:

```text
0   char[8]    "PDGLINE\0"
8   uint32     format version (1)
12  int32      year
16  uint32     line count
20  uint32     total point count
24  float32[4] west, south, east, north
40  repeated: uint32 point count, then float32 longitude/latitude pairs
```

Add `--keep-geojson` to retain newline-delimited GeoJSON for QGIS inspection.
For Pas de Géant, `.pdg-lines` avoids GeoJSON's parsing and object-allocation
cost while remaining simple to turn into a Three.js `LineSegments` geometry.
At globe and regional scales this is usually cheaper than a 30 m raster overlay.
If the experience needs filled forest, fine local clearings, or continuous zoom
all the way to source resolution, raster tiles remain the better representation.

The POC loads its 1986 and 2023 globe LODs (about 240 KB and 365 KB
respectively) from the temporary Found in Space dataset at
`https://data.foundin.space/3592e66d-2b29-4e4b-97d0-7fc1d3e9e4f8/manifest.json`.
Generated and source data remain outside the repository because their upstream
licence applies independently of the application code. Set
`VITE_AMAZON_FOREST_MANIFEST_URL` to test another locally served or hosted
manifest.

On first display, the client rasterizes each year's closed contours with the
even-odd fill rule, so enclosed clearings remain holes, then composites the
selected translucent fills and their brighter boundaries into one geographic
texture. The terrain shader samples that texture on the same elevation-displaced
tiles as the base imagery. The historical layer therefore follows topography
without a separate line mesh hovering above it.

The internal forest-outline store is the single state and mutation boundary
used by the renderer, supervision, and voice integrations, and is available for
a future TouchOS control. The POC exposes its independent year checkboxes only
in the development supervisor for now; there are no controls on the preflight
page. The voice agent uses the same store through `get_amazon_forest_outlines` and
`set_amazon_forest_outline_visibility`. Available controls come from the
manifest, so adding another generated year does not require another display
mode. The larger regional outputs are deliberately not part of the normal app
assets; generate or host them separately if close-up inspection becomes part of
the experience.

## Other layers

The celestial sphere loads the default Found in Space SkyKit catalogue and
uses Astronomy Engine to rotate J2000 directions into the current Earth-fixed
frame. Catalogue failure leaves an empty sky without blocking the surface. The
voice guide can show or hide the Sun, Moon, each planet, all planets, or all
Solar System bodies without changing the background star catalogue.

Satellite and aircraft objects are maintained in the independent `satellites`
and `aircraft` extension projects. Their standalone examples demonstrate public
SkyKit plugin registration. This application currently includes neither extension;
its API server and voice/supervision controls do not depend on their services.

## Validation

```sh
npm run check
npm test
npm run build
```

Source and licence details are in `public/THIRD_PARTY_LICENSES.txt`. Terrain
and imagery are not suitable for navigation or safety-critical use.

## Local application APIs

Vite serves application APIs on the development machine alongside the demo.
Realtime token issuance, geocoding and knowledge APIs use that
machine's configuration. Set `OPENAI_API_KEY`
in its private `apps/pas-de-geant/.env.local` when voice is required, and start
the app with `npm run dev -- --port 4197`.

The independent cache host serves no application APIs or local lunar products.
Vite rejects the retired `PAS_DE_GEANT_API_BACKEND_URL` setting.

Application API requests stay on the development site's origin, including its
HTTPS proxy. `/api/supervision` and the supervisor console stay with the local Vite
server, so each development server retains its own headset sessions.

For local HTTP integration checks, build the standalone application API server
with `npm run api:build` and run it with `npm run api:serve`. Supply its private
configuration through the process environment; the command does not load Vite's
environment files. `PAS_DE_GEANT_API_HOST` defaults to `127.0.0.1` and
`PAS_DE_GEANT_API_PORT` defaults to `4198`. This local helper returns 404 for app
pages and source code. `/healthz` reports readiness. Session configuration is
delivered only through `session-config.json` by the Vite development server or
as a static file. Upstream credentials and the OpenAI API key remain server-side.
