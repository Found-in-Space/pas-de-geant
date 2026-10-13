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
scale. This entry is also linked from the imagery comparison page.

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
scale-denominator commands. It can also independently
toggle live aircraft symbols, radar labels, and the same brightest, station, and
science/education satellite groups exposed to the voice agent. Map destinations
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
contact period, and return the whole astronomical scene to live time. Live
aircraft interpolation remains tied to wall-clock time.

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
The canonical global imagery reaches zoom 8; its descriptor caps requests
independently of elevation. `PAS_DE_GEANT_LUNAR_IMAGERY_MAX_ZOOM` can lower that
cap for testing.

For static/CDN hosting, provide the public immutable imagery template and
matching descriptor, with CORS enabled and no credentials:

```sh
PAS_DE_GEANT_LUNAR_IMAGERY_URL_TEMPLATE='https://tiles.example/new-release/imagery/{z}/{x}/{y}.png'
PAS_DE_GEANT_LUNAR_IMAGERY_PRODUCT_URL='https://tiles.example/new-release/product.json'
PAS_DE_GEANT_LUNAR_ELEVATION_URL_TEMPLATE='https://tiles.example/new-height-release/elevation/{z}/{x}/{y}.png'
PAS_DE_GEANT_LUNAR_ELEVATION_PRODUCT_URL='https://tiles.example/new-height-release/elevation/product.json'
```

An imagery descriptor URL is derived automatically from a public template ending
in `/imagery/{z}/{x}/{y}.png`; other templates and server-only upstream proxies
need an explicit public descriptor URL. Local directories expose only the
whitelisted descriptor/base and XYZ paths. A descriptor fetch/validation failure
retains the bundled base and flat heights rather than guessing a grid.

The existing immutable `20261011.1` WAC CDN payload remains usable as format 1.
Its geographic zoom-0 tile supplies the equirectangular base. New format 2
products carry a separate authenticated full-latitude `base.png`; Mercator zoom
0 is unsuitable for that role. The same loader serves the main, focused Moon
and Apollo views. The shared polar caps use the base and flat reference heights
outside ±85.05112878°. Tone exponent `0.55` remains a uniform presentation
choice for both base and detail, without changing stored source samples.

Scientific heights use `kind: "elevation-xyz"`, `formatVersion: 2`, a matching
`grid`, units in metres, a reference-surface vertical datum and an explicit
encoding/bounds descriptor. LOLA RG16 stores an unsigned 16-bit value in red and
green; height is `value × 0.5 − 10,000 m`. Display imagery never supplies height
samples. Browser request URLs and provider identities include grid/product
identity so switching a local dataset cannot reuse old geographic cache bytes.
Published migrations require new immutable prefixes.

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

### Compare Apollo imagery against the WAC base

Open `http://127.0.0.1:4197/moon/compare/` on the existing development server,
or follow **Compare Apollo imagery** from the Moon viewer. The page is an explicitly geographic archive comparison. Its WAC base defaults
to immutable `20261011.1` (zooms 0–8), independently of the 3D runtime grid;
`PAS_DE_GEANT_LUNAR_STUDY_IMAGERY_URL_TEMPLATE` selects another geographic base.
It
overlays LROC/Lunaserv imagery for all six landing sites: high-resolution,
high-Sun, low-Sun, and the additional advertised variants where available.
The default Apollo 11 view previews a variable-resolution pyramid over a
**100 × 100 km** region: Kaguya context at about 8.4 m/pixel, the 1.3 m NAC mosaic
within an inner 25 km band, and a 0.52 m NAC mosaic within an inner 5 km band.
Source masks determine the actual detail coverage. Holes retain coarser imagery,
and zooming beyond a source's useful level keeps its capped geographic parent.
The page shows estimated coverage shares and can outline the detail footprints.
The initial opacity is 100%, so the preview is fully visible. Existing comparison
links retain their selected source, view and opacity.

The context tiles are built by the sibling texture producer; see its
`projects/moon/apollo11-preview/README.md` and `preview.toml` for the replay
command. `/lunar-preview/` serves the local generated manifest and PNGs from
`.cache/apollo11-preview`, or `PAS_DE_GEANT_LUNAR_PREVIEW_DIRECTORY`. This is a
local preview: NAC is regridded from remote archive pyramids on demand, and seams
and differing illumination have not been corrected. It is not a complete 1 m
regional mosaic or a self-contained published tile package.

Wider archive regional mosaics remain available for all six sites. **50 × 50 km**
and **100 × 100 km** select the pyramid for Apollo 11, or the regional source at
other sites, and outline a square centred on the landing site. Switching sites
keeps the selected area size. The global WAC base remains underneath every layer.

The page requests small registered WMS images directly from the public LROC
service, or geographic crops assembled from the archive's Zoomify browse tiles.
`/lunar-study-tiles/` provides same-origin access to these fixed public archive
products in the development, preview, and application API servers. It does not
accept arbitrary upstream URLs. Native NAC mosaics remain at the archive; the
local context builder downloads four Kaguya tiles. Regional previews include JPEG
browse compression and their existing
display stretch; Apollo 16's browse pyramid is resampled to approximately 0.63 m.

Blend, swipe, and blink compare the candidate against WAC or a second NAC
version. Hold **B**, or the base button, to reveal only WAC. Context, join, and
detail views return to the NASA/LROC-derived lunar module location. Both
layers share lunar geographic coordinates; stored square XYZ base tiles
display as 512 × 256 rectangles without losing their 512 stored rows.

The shared display setting either preserves stored display pixels or applies
the viewer's `0.55` linear-light brightness exponent to both sources. The study
omits the 3D viewer's lighting and ACES exposure. **Match visible terrain brightness
to WAC** compares corresponding unadjusted terrain over the current view,
resampled to approximately the 100 m base scale when zoomed in. It sets gain
from the median linear-light brightness ratio, preserves candidate contrast,
and resets the brightness offset. Transparent and clipped samples are excluded.
Use the join view for a local match. The result is a display adjustment rather
than calibrated albedo or photometric correction; illumination differences remain.
Candidate gain, contrast, brightness offset, and
east/north offsets are temporary inspection controls; their defaults preserve
the service image and its registration. Dark pixels retain their source alpha
and are not treated as gaps.

The URL retains the current comparison and view. Optional assessments stay in
browser storage and export as a JSON study record. Lunaserv previews include
service-side processing and may differ from the corresponding archived TIFF;
verify the selected archival source before admission to the texture pipeline.
Chandrayaan-2 OHRC observations are linked for discovery but are not served as
registered overlays by this page.

Regional registration and coverage are generated by
`scripts/build-apollo-regional-preview-metadata.py`, using system GDAL and NumPy:

```sh
/usr/bin/python3 scripts/build-apollo-regional-preview-metadata.py \
  --native-label .cache/apollo-study/sources/native-label.lbl \
  --browse .cache/apollo-study/sources/browse-20m.tif \
  --image-properties .cache/apollo-study/sources/ImageProperties.xml \
  --output apps/pas-de-geant/src/data/apollo11-regional.json
```

Each generated JSON records public input URLs and hashes. Registration includes
the lunar standard parallel and pixel-edge offsets, and handles western longitudes.
Coverage is polygonized from the published 20 m browse GeoTIFF's explicit no-data
mask; native dark terrain pixels remain valid. These approximate edge masks are
for visual source selection. When Zoomify dimensions differ from the PDS raster,
the generator requires `--pyramid-registration` with actual GDAL GeoTIFF header
metadata, rather than assuming the registration of a different product. This
applies to Apollo 16. Raw inputs stay outside Git.

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

The server-side tile cache is owned by the independent private `kws/tile-cache`
repository. Pas de Géant forwards tile requests over HTTP; it contains no
upstream downloader or disk-cache implementation. AI, geocoding, local lunar
products, and application APIs remain owned here.

When running application APIs locally, configure the separate service:

```sh
PAS_DE_GEANT_TILE_CACHE_URL=https://tile-cache.int.k-si.com
```

Application APIs, AI token issuance and admitted lunar products stay on the
development machine. The cache host runs only the independent upstream tile
cache/proxy. Whole-API forwarding with `PAS_DE_GEANT_API_BACKEND_URL` is retired.
Source metadata comes from the cache's public provider manifest. Upstream
templates, credentials, headers, throttling and disk paths belong only to the
cache service's private configuration.

Development MapTiler source URLs are rejected at startup and in client source
configuration, including injected imagery settings. An unavailable or missing
cache returns a clear non-cacheable 503; it never falls back to direct upstream
requests. Deliberate emergency access requires the exact explicit setting:

```sh
PAS_DE_GEANT_ALLOW_DIRECT_MAPTILER=I_ACCEPT_MAPTILER_RATE_LIMIT_RISK
```

Leaving this unset is the supported development configuration. A public CDN or
other explicitly configured source can be used without the helper. Production
accepts `VITE_IMAGERY_XYZ_TEMPLATE` and `VITE_ELEVATION_XYZ_TEMPLATE`, source
attribution, provider identity, dimensions, and zoom coverage. Source URLs are
consumed as configured rather than unconditionally rewritten through the cache.

Existing `/api/tiles/{provider}/{z}/{x}/{y}` routes, provider namespaces, and
disk identities are preserved during extraction. MapTiler's default 256-pixel
variant uses the cache's `textures` provider; the diagnostic 512-pixel source
uses `textures-source`. Both routes remain persistent browser cache keys.
Local admitted lunar products remain served by the application API.

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

Live Flight Follower traffic is opt-in and only streams during an immersive VR
session. Leaving VR, hiding the page, or disabling the layer closes the stream.
The client follows Flight Follower's predicted trajectories, renders reported
surface-vehicle categories distinctly, and anchors explicit on-ground reports
to the physical elevation sampled from the same Mapterhorn tiles used by the
terrain surface. Terrain exaggeration does not change traffic altitude.

CelesTrak satellite tracking is also opt-in. The 100 brightest, space-station,
and combined science/education groups can be enabled independently from the
page or by asking the voice guide. Orbital elements are cached for CelesTrak's
two-hour update interval, while SGP4 propagation moves the markers locally.
Satellite altitude remains at the universal global scale and is independent of
terrain exaggeration.

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
Realtime token issuance, geocoding, knowledge, satellite feeds and prepared
lunar products use that machine's configuration and files. Set `OPENAI_API_KEY`
in its private `apps/pas-de-geant/.env.local` when voice is required, and start
the app with `npm run dev -- --port 4197`.

Only upstream tile requests are forwarded to the independent cache at
`https://tile-cache.int.k-si.com`. Configure it with
`PAS_DE_GEANT_TILE_CACHE_URL` as described above. The cache host serves no
application APIs or local lunar products. Vite rejects the retired
`PAS_DE_GEANT_API_BACKEND_URL` setting.

Browser requests stay on the development site's origin, including its HTTPS
proxy. `/api/supervision` and the supervisor console stay with the local Vite
server, so each development server retains its own headset sessions.

For local HTTP integration checks, build the standalone application API server
with `npm run api:build` and run it with `npm run api:serve`. Supply its private
configuration through the process environment; the command does not load Vite's
environment files. `PAS_DE_GEANT_API_HOST` defaults to `127.0.0.1` and
`PAS_DE_GEANT_API_PORT` defaults to `4198`. This local helper returns 404 for app
pages and source code. `/healthz` reports readiness and `/api/config` exposes
public source metadata and availability. Upstream credentials and the OpenAI
API key remain server-side.
