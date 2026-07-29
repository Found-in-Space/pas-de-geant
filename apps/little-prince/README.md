# Little Planet

A room-scale WebXR relief Earth inspired by _Le Petit Prince_. Mean sea
level stays at the physical-floor apex beneath the headset while walking or
controller travel rolls the planet through that contact point.

## Run locally

From the repository root:

```sh
npm run dev:little-prince -- --port 4197
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
- Right stick horizontal: whole-planet scale
- Right stick vertical: radial multiplier
- A: toggle sea surface / bathymetry
- Hold B: reset to the detected starting location and initial scale
- Right-stick press: toggle the left-hand Earth map panel

The hand panel uses touch-os and the bundled NASA Blue Marble image to show the
current underfoot position on a whole-Earth map. It remains available offline;
the latitude and longitude appear directly beneath the map. Its map readout is
limited to 10 updates per second and hosted under an isolated scene node so it
does not traverse or invalidate the terrain scene.

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
npm run prepare:relief --workspace @found-in-space/little-prince
```

Around the current contact point, the renderer asynchronously requests a
logical 5×5 window of Mapterhorn's global 512 px Terrarium tiles. Its source
zoom is calculated rather than mapped to named scales: a fixed 2 m observer
height gives the sea-level spherical horizon
`acos(radius / (radius + 2 m))`, that cap is converted to clipped Web Mercator
bounds, and zooms 12–0 are tested until the finest actual user-centred window
contains the complete cap. This accounts for tile alignment, latitude
distortion, unequal north/south extents, polar clipping, and antimeridian
wrapping. At zooms 0–2 the logical window collapses to the unique valid
whole-world cells, without wrapped duplicates or polar halo requests. The
underlying global source is Copernicus GLO-30; the checked-in GEBCO terrain
remains the continuous globe beyond the local patch and across the distant
horizon. Regional zoom 13–17 LiDAR is intentionally not requested.

A worker decodes elevations and builds adaptive 513×513 RTIN meshes with
`@mapbox/martini`. A full 5×5 active window contains 2560×2560 height samples
before RTIN simplification. Its valid east/south halo keeps shared heights
aligned, and forced full-resolution RTIN borders prevent cracks between
simplification levels. The outer ring blends back to GEBCO; unavailable
neighbours receive a shorter edge fade and only patch or fallback boundaries
retain shallow skirts.

At most four elevation requests run concurrently, and up to 64 decoded tiles
are retained. Prepared local meshes write an exact stencil before the coarse
globe renders, so missing, malformed, ocean-only, polar, and offline tiles
remain continuous GEBCO terrain and bathymetry without approximate mask edges.
Overlapping meshes survive window movement. During a scale or radial-LOD
change, obsolete detail fades to exact GEBCO and the renderer waits 250 ms for
the control to settle before requesting only the final source window. One
generation-tagged RTIN job runs at a time and completed GPU-ready meshes install
one per frame. Each mesh is capped at 16,384 vertices and all active local
geometry is capped at 32 MiB. The worker progressively relaxes RTIN error only
when needed to keep a tile within its vertex ceiling, and the centre tile is
queued first. A cell that still cannot meet those limits remains GEBCO. GEBCO
always continues beyond the local patch. Its projected error target is 2 mm,
calculated independently from planet scale and radial multiplier, so cached
height data is retained while RTIN meshes rebuild into finer buckets even when
the source-tile zoom does not cross a boundary. Runtime body-data diagnostics
report horizon angle and source distance, selected zoom, actual window coverage,
requested and actual RTIN error, and imagery level. A depth-only shell below
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
