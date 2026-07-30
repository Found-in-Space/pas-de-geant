# Pas de Géant

_Walk around worlds, one small step at a time._

Pas de Géant is a room-scale WebXR relief globe. Mean sea level starts at the
physical-floor apex beneath the headset, and the floor datum can be reset to
the current terrain elevation. Walking or controller travel rolls the planet
through that contact point.

## Run locally

From the repository root:

```sh
npm run dev -- --port 4197
```

Open `http://127.0.0.1:4197`. The desktop fallback uses WASD to travel,
Z/X to change planet scale, C/V to change the radial multiplier, and
Backspace to reset.

### The Construct

Open `http://127.0.0.1:4197/construct/` for the isolated terrain test over the
Alps–Po valley transition at 45.90° N, 9.25° E. It renders a fixed two-level
Mapterhorn stencil with one bundled NASA Blue Marble texture. It does not
instantiate the GEBCO globe, stars, aircraft, or another terrain fallback.

The finest level is an 8×8 block. Its four underfoot pages retain the complete
512×512 grid while the other 60 use 64×64 cells. Two clean, two-tile-wide
parent rings add 48 pages each at the next two source levels, using 32×32 and
16×16 cells. The complete 160-mesh construct therefore steps gradually through
z, z−1, and z−2 and spans 32 finest-tile widths. The snapped anchor changes
while the user is still several tiles from the visible edge. Shared meshes
remain in place across an anchor change; a source-level change keeps the old
construct until the four new underfoot meshes are ready. Ground height is
bilinearly sampled and filtered over eight seconds with a
four-centimetre-per-second world-space speed limit.

The five preview buttons load the same fixed 2×2 construct at 1×, 100×, 250×,
500×, and 1000× global scale. At this latitude those scales select Mapterhorn
z6, z12, and then the verified local source cap of z14. The 250×, 500×, and
1000× previews therefore reuse the same source addresses. The existing Quest
and desktop controller mappings are unchanged.

Run the fixed-pattern and automated visual previews with:

```sh
npm test -- --run tests/pas-de-geant-construct.test.ts
npm run build
npm run test:construct:browser
```

WebXR requires a secure context. For a USB-connected Quest 2, an Android
reverse tunnel lets Oculus Browser treat the app as device-local:

```sh
adb reverse tcp:4197 tcp:4197
```

Then open `http://localhost:4197` on the headset. Any shared or deployed
build should be served over HTTPS.

## Quest controls

- Left stick: head-relative travel
- Left trigger: faster travel
- X: toggle tinted native-tile surfaces and boundary outlines
- Right stick horizontal: whole-planet scale
- Right stick vertical: radial multiplier
- Hold B: reset to the detected starting location and initial scale
- Right-stick press: set the current terrain underfoot to physical floor level

The hand panel uses touch-os and the bundled NASA Blue Marble image to show the
current underfoot position on a whole-Earth map. It remains available offline;
the latitude and longitude appear directly beneath the map, followed by the
planet-root global scale factor, radial multiplier, and selected topography
zoom range. Terrain LOD is selected automatically. Each X press toggles
alternating tile-surface tints and high-contrast boundary outlines. Hold B
resets the planet. The map readout is throttled and hosted under an isolated
scene node so it does not traverse or invalidate the terrain scene.

The camera and XR reference space are never moved to simulate travel. The
planet root is rolled and translated so the selected contact point remains
beneath the headset. A right-stick press captures the native underfoot
elevation (or global relief while native detail is unavailable) as the floor
datum.

At startup, the app asks the browser for the device location. If that is
unavailable or denied, it uses an approximate IP location from GeoJS; if both
methods fail, it falls back to the intersection of the equator and prime
meridian. Reset returns to whichever starting location was resolved. Location
discovery runs entirely in the browser and is not stored by the app.

Planet scale uniformly converts geographic kilometres into room metres.
It has a 1 m rendered-radius lower bound and no application-imposed upper
bound.
The separate radial multiplier applies after that conversion to terrain,
aircraft altitude, and the 100 km atmosphere. The mean-sea-level WGS84
ellipsoid is the default floor contact; a right-stick press replaces that
datum with the current underfoot terrain elevation.
There is currently no synthetic sea surface: negative source elevations
remain negative terrain and are not interpreted as water.

## Terrain and imagery

The checked-in `public/relief/gebco-2026-r16.bin` is a 4096×2048,
metre-quantized derivative of the GEBCO 2026 grid. To regenerate it from an
official stride-21 NetCDF subset:

```sh
npm run prepare:relief --workspace @found-in-space/pas-de-geant
```

Around the current contact point, the renderer requests native tiles from
Mapterhorn's global 512 px Terrarium pyramid. Source selection is a fixed
render-space clipmap rather than a screen-space quadtree search. The finest
level is one complete 8×8 tile square. Each of the next two coarser levels is
the same 8×8 square with its central 4×4 tiles removed, producing a repeating
two-tile-wide ring. Each finer square exactly fills the parent ring's hole.
The complete three-level stencil therefore contains 64 + 48 + 48 = 160
addresses.

The target native tile width is 5.12 room metres, or about 1 cm per source
pixel. The selected source zoom changes only when the current tile becomes
smaller than 3.5 m or larger than 7.5 m; the wider-than-two hysteresis band
prevents a level change from immediately reversing itself. Mapterhorn
refinement stops at z12, and regional z13–17 LiDAR is intentionally not
requested. At z0–2 the renderer simply uses every available world tile because
an 8×8 footprint cannot yet exist.

All tile offsets, ring membership, skirts, priorities, and mesh density are
fixed. Four tiles around the contact point retain the complete
512×512 source grid. The rest of the finest level uses 128×128 cells, and the
two parent rings use 64×64 and 32×32 cells. Same-zoom neighbours share decoded
boundary samples; a shallow skirt closes changes in mesh density and source
zoom without blending Mapterhorn and GEBCO at the same surface point. There is
no terrain-planning worker, RTIN simplification, per-tile screen-space
calculation, budget collapse, or per-frame neighbour search. Movement inside
the snapped quadtree anchor does not alter the ring addresses; the four
full-resolution tiles move only when the contact point crosses their stable
2×2 anchor. Crossing a scale threshold shifts the same stencil up or down one
source level.

At most four elevation pages are active across the complete fetch-and-decode
pipeline. Successful Mapterhorn responses are written to the browser's named
Cache API storage and checked there before the network; malformed images are
evicted as soon as worker decoding rejects them. The worker retains up to 192
decoded pages, which covers the full 160-tile stencil plus overlap while the
anchor moves. Browser storage quotas and eviction policy still apply.

Before any network request completes, every active Mapterhorn address gets a
coarse virtual tile whose vertex shader samples the embedded GEBCO raster.
That tile writes the same stencil and owns the same footprint as the eventual
native mesh. A completed Mapterhorn mesh replaces its GEBCO geometry in place;
there are never two elevation providers drawing the same point. Missing,
malformed, zero-only, polar, and offline pages simply keep their GEBCO tile.
Any rasterization crack falls through to the complete geographic GEBCO globe
beneath it, which uses the same elevation and texture rather than an unrelated
sea-level plane.

Native geometry is staged in coherent groups: the four underfoot cells, the
rest of the finest ring, and each of the two parent rings. A group remains
entirely on GEBCO until all of its available Mapterhorn meshes are ready, then
commits once. Missing cells remain GEBCO during that commit. This preserves the
construct's generation-and-commit principle without delaying the first Earth
render.

The checked-in 2048×1024 Blue Marble image is the immutable complete terrain
texture and is available immediately offline. An optional photographic XYZ
provider refines it through an imagery quadtree that is independent from the
terrain stencil. The virtual window is at most 8×8 and is snapped in four-page
strides; its requested zoom comes from projected texel size and is capped only
by the provider. A texture array holds at most 96 decoded pages and is reduced
automatically to stay within a 64 MiB pixel budget and the device's array-layer
limit.

Low-resolution photographic ancestors prefetch at 1.5×, may commit at 2×,
and release below 1.25×. The planner requests a coarse-to-fine ancestor ladder
so scaling progresses from Blue Marble through resident photographic parents
instead of jumping directly to local imagery. Below the local-detail gate,
visible photographic pages are capped at z11.

Precise local pages prefetch at 400×, may commit at 500×, and release below
375×. The visible page table always resolves each page to a complete exact
sibling group, a resident photographic ancestor, or Blue Marble. Downloads,
decodes and GPU uploads only populate staging. Two page-table textures swap
after successful uploads, so missing, malformed, aborted, stale, or GPU-failed
pages cannot alter the visible mapping. Web Mercator requests stop at
±85.05112878° while Blue Marble continues across both poles.

No network imagery provider is hard-coded. Configure one at build time with:

```sh
VITE_IMAGERY_XYZ_TEMPLATE='https://example.test/{z}/{x}/{y}.jpg'
VITE_IMAGERY_ATTRIBUTION='Required provider attribution'
VITE_IMAGERY_PROVIDER_ID='provider-id'
VITE_IMAGERY_TILE_SIZE=256
VITE_IMAGERY_MIN_ZOOM=0
VITE_IMAGERY_MAX_ZOOM=20
```

The URL and attribution variables are required together. Without them,
startup and rendering remain exactly the complete embedded Blue Marble path.
Source, license, datum, DOI, and checksum details live beside the relief asset
and in `public/THIRD_PARTY_LICENSES.txt`.

Mapterhorn publishes its tile format, endpoint, and complete source-level
attribution at <https://mapterhorn.com/data-access/> and
<https://mapterhorn.com/attribution/>. Its global source catalog identifies
Copernicus GLO-30 as a 30 m source produced by DLR and Airbus Defence and Space
and provided under Copernicus by the European Union and ESA.

## Celestial sphere

The sky loads the default Found in Space SkyKit catalogue from
`data.foundin.space` without delaying the relief Earth. Stars through apparent
magnitude 6.5 are flattened from their ICRS catalogue positions onto a
fixed-radius celestial sphere. The sphere feeds adjusted magnitude and
temperature attributes into SkyKit's own WebGL core-and-halo star shader, so
its point size, colour, bright core, and soft glow match the main SkyKit
renderer. The catalogue's zero-distance Sun row is intentionally omitted until
solar-system bodies are modelled separately.

Astronomy Engine converts the J2000 star directions into the Earth-fixed frame
for the device's current UTC time. That frame is composed with the same full
rolling-Earth orientation used by the terrain, so walking or controller travel
rotates the sky with the planet while the sphere remains centred on the active
desktop or XR camera. The sidereal-time component is refreshed once per second.

SkyKit range requests use browser-persistent caching where available. If the
catalogue cannot be reached, the Earth remains operational with an empty sky;
the application does not substitute invented stars.

## Live aircraft proof of concept

The aircraft layer queries the public Airplanes.live point API for traffic
within 250 NM of the current underfoot coordinates. It polls every 30 seconds
only during an active immersive VR session, then dead-reckons positions
between reports from groundspeed, track, and track rate. Aircraft altitude
uses the same radial exaggeration as the terrain. Hiding the layer,
backgrounding the page, or leaving VR stops requests immediately.

Live aircraft are an optional feature, off by default on each page load.
Enable the checkbox before entering VR to use them. The setting remains in
effect for repeated VR sessions until the page is reloaded.

This refresh rate is intended only for short proof-of-concept sessions. The
published free allowance is not sufficient for an unattended or production
deployment; agree suitable commercial access before using the layer that
way.
