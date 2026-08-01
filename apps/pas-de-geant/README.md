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

## Controls

- Left stick: head-relative travel
- Left trigger: faster travel
- Right stick horizontal: whole-planet scale
- Right stick vertical: radial terrain and altitude exaggeration
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
- the scheduler owns the committed resources, cancels superseded work, and
  publishes only complete atomic swaps;
- cancellable image providers coalesce source requests and reuse decoded
  overzoom ancestors;
- a composite surface provider joins Terrarium elevation and optional XYZ
  photography into one resource for each draw tile;
- `TerrainSurface` is the only application-facing integration point.

The requested z level comes from observer height above the flat, un-displaced
Earth surface, latitude, render-buffer focal length, and source tile
resolution. Terrain elevation never feeds back into LOD selection. Changing
the displayed Earth radius converts the same room-space eye height to a new
physical observer height and therefore selects a new cut.

The embedded Blue Marble is immediate, complete fallback imagery. Mapterhorn
Terrarium pages hydrate the committed cut, while a configured photographic
provider can replace the corresponding texture regions. Elevation is required
before a new terrain replacement commits. Missing photographic imagery uses
Blue Marble and cannot create a surface hole. Failed elevation hydration keeps
the initial flat tile; failed replacement leaves the previous committed tile
visible.

Terrarium displacement is decoded and bilinearly sampled in the vertex shader.
Draw tiles sample cropped regions of source ancestors after the provider's
maximum zoom. Shallow skirts hide unavoidable raster/LOD edge differences.
There is no hidden inner globe: only the committed Web Mercator surface and
flat Blue Marble polar caps are rendered.

Photographic source textures use clamped edge sampling, linear magnification,
trilinear mipmapped minification, and the device's available anisotropy.
Overzoomed children share a single source texture and continuous cropped source
UVs, so a draw-tile join within the same ancestor samples the same coordinate
from both sides. Press Y to inspect the actual source boundaries; press X to
inspect the committed draw cut.

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

## Other layers

The celestial sphere loads the default Found in Space SkyKit catalogue and
uses Astronomy Engine to rotate J2000 directions into the current Earth-fixed
frame. Catalogue failure leaves an empty sky without blocking the surface.

Live Airplanes.live traffic is opt-in and only polls during an immersive VR
session. Leaving VR, hiding the page, or disabling the layer stops requests.

## Validation

```sh
npm run check
npm test
npm run build
```

Source and licence details are in `public/THIRD_PARTY_LICENSES.txt`. Terrain
and imagery are not suitable for navigation or safety-critical use.
