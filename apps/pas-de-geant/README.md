# Pas de Géant

_Walk around worlds, one small step at a time._

Pas de Géant is a room-scale WebXR relief globe. Mean sea level stays at the
physical-floor apex beneath the headset while walking or controller travel
rolls the planet through that contact point.

## Run locally

From the repository root:

```sh
npm run dev -- --port 4197
```

Open `http://127.0.0.1:4197`. The desktop fallback uses WASD to travel,
Z/X to change planet scale, C/V to change the radial multiplier, O to reveal
the seabed, and Backspace to reset.

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
- X / Y: bias terrain LOD one screen-space step coarser / finer
- Right stick horizontal: whole-planet scale
- Right stick vertical: radial multiplier
- A: toggle sea surface / bathymetry
- Hold B: reset to the detected starting location and initial scale
- Right-stick press: toggle the left-hand Earth map panel

The hand panel uses touch-os and the bundled NASA Blue Marble image to show the
current underfoot position on a whole-Earth map. It remains available offline;
the latitude and longitude appear directly beneath the map, followed by the
planet-root global scale factor, radial multiplier, and selected topography
zoom range. The terrain readout says `AUTO` at zero bias. Each Y press halves
the permitted source-sample and mesh error, while each X press doubles it;
hold B to reset the planet and return to zero bias. `CAP` appears only when the
decoded-tile or geometry safety budget has forced part of the plan coarser. Its
map readout is throttled and hosted under an isolated scene node so it does not
traverse or invalidate the terrain scene.

The camera and XR reference space are never moved to simulate travel. The
planet root is rolled and translated so the selected mean-sea-level contact
point remains beneath the headset.

At startup, the app asks the browser for the device location. If that is
unavailable or denied, it uses an approximate IP location from GeoJS; if both
methods fail, it falls back to the intersection of the equator and prime
meridian. Reset returns to whichever starting location was resolved. Location
discovery runs entirely in the browser and is not stored by the app.

Planet scale uniformly converts geographic kilometres into room metres.
It has a 1 m rendered-radius lower bound and no application-imposed upper
bound.
The separate radial multiplier applies after that conversion to terrain,
aircraft altitude, bathymetry, and the 100 km atmosphere. The mean-sea-level
WGS84 ellipsoid remains the floor contact even when radial features are
exaggerated.

## Terrain and imagery

The checked-in `public/relief/gebco-2026-r16.bin` is a 4096×2048,
metre-quantized derivative of the GEBCO 2026 grid. To regenerate it from an
official stride-21 NetCDF subset:

```sh
npm run prepare:relief --workspace @found-in-space/pas-de-geant
```

Around the current contact point, the renderer asynchronously requests mixed
zoom levels from Mapterhorn's global 512 px Terrarium pyramid. A quadtree first
clips candidates to the eye-height spherical horizon, then estimates each
source sample in the current eye buffer:

```text
samplePixels =
  scaledSourceSampleMetres × focalLengthPixels / nearestTileDistance
```

In WebXR, focal length comes from each eye's real framebuffer viewport and
projection matrix rather than CSS pixels. Desktop uses the WebGL drawing
buffer. Source samples target 0.5 px, refine above 0.65 px, and coarsen below
0.35 px; the gap supplies hysteresis. Latitude-dependent Web Mercator sample
spacing is scaled by the current rendered planet radius, and nearest distance
includes the actual eye height above the globe. This naturally creates fine
tiles underfoot, progressively coarser onion layers with distance, and GEBCO
at and beyond the local horizon. Mapterhorn refinement stops at z12; regional
z13–17 LiDAR is intentionally not requested. LOD planning also holds a
cumulative 4 cm three-dimensional head-pose deadzone: rendering and physical
travel remain continuous, but small horizontal or vertical headset jitter does
not move the planning anchor.

A worker decodes elevations and builds adaptive 513×513 RTIN meshes with
`@mapbox/martini`. Source zoom and triangle density are separate decisions:
each tile chooses the coarsest RTIN metre-error bucket whose exaggerated
vertical error stays below a 0.75 px eye-buffer target. RTIN refinement and
coarsening use their own 0.9/0.6 px hysteresis thresholds, so a distant z12
source tile does not imply a dense mesh. Same-zoom active neighbours share
decoded boundary samples and forced full-resolution RTIN borders. Mixed-zoom
T-junctions retain shallow skirts. The outer plan boundary blends back to
GEBCO, and unavailable neighbours receive a shorter edge fade.

At most four elevation requests run concurrently, and up to 128 decoded tiles
and active source tiles are retained. If the screen-space plan exceeds that
limit, quadtree branches are collapsed from farthest to nearest; the 96 MiB
geometry cap applies the same policy as a secondary safety valve. Successful
Mapterhorn responses are also written to the browser's
named Cache API storage and checked there before the network; malformed images
are evicted as soon as worker decoding rejects them. Browser storage quotas and
eviction policy still apply. Prepared local meshes write an exact stencil
before the coarse globe renders, so missing, malformed, ocean-only, polar, and
offline tiles remain continuous GEBCO terrain and bathymetry without
approximate mask edges.
During a scale or radial-LOD change, the renderer waits 250 ms for the control
to settle before requesting only the final source plan. It no longer retires
the complete local layer when one LOD decision changes. RTIN-only updates
replace geometry in place; coarsening atomically replaces descendants with
their prepared parent; refinement keeps the live parent until every replacement
child in that region is prepared or has reached a terminal GEBCO fallback.
Only obsolete, non-overlapping tiles fade individually after the desired plan
is settled. One
generation-tagged RTIN job runs at a time and completed GPU-ready meshes install
one per frame. Each mesh is capped at 16,384 vertices and all active local
geometry is capped at 96 MiB. The worker progressively relaxes RTIN error only
when needed to keep a tile within its vertex ceiling, and the nearest tile is
queued first. A tile that still cannot meet those limits remains GEBCO. GEBCO
always continues beyond the local patch. Runtime body-data diagnostics report
the horizon, source zoom range, source-sample pixel range, LOD bias, budget
state, and requested and actual RTIN errors. A depth-only shell below
the deepest exaggerated seabed prevents distant terrain and ocean faces from
showing through transient seams.

NASA GIBS supplies up to 32 nearby 512 px Blue Marble images from its native
500 m geographic WMTS pyramid. Shared two-level-coarser previews load before
the nearest full-detail tiles, with no more than six image fetches and decodes
active at once. Levels 0–7 are selected from their projected texel size at the
current planet scale and latitude, capped at the native 500 m level. Failed
imagery requests retry after 1, 5, and then 30 seconds while the tile remains
relevant. GIBS marks these pre-generated tiles as browser-cacheable, so repeat
headset visits can reuse them without bundling a global imagery archive. Local
RTIN meshes reuse the highest available cached preview or exact geographic
image selection and texture lease. The selected GIBS coverage patches are
mirrored onto the detailed geometry, while the bundled Blue Marble texture
remains the common fallback. There is no separate EPSG:3857 imagery requester
or local imagery cache, so local relief cannot conceal the global layer with a
coarser or competing image pyramid.

The checked-in 2048×1024 Blue Marble image is displayed immediately beneath
the progressive tiles and remains usable when offline. Detailed global imagery
still requires a network connection the first time a location is viewed.
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
