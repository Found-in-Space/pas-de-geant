# Found in Space — Shadowline

Part of [Found in Space](https://foundin.space/), a project that turns real
astronomical measurements into interactive explorations. See all repositories
at [github.com/Found-in-Space](https://github.com/Found-in-Space).

Shadowline is a renderer-independent solar-eclipse toolkit with a browser-native
planning application. It calculates complete central tracks, reports
circumstances for an observer, and exports portable GeoJSON or KML. The
visualizer discovers events on demand through the selected search provider.

Canonical geometry is global and retains the full WGS 84 track, including
polar coordinates. Projection-specific display changes happen only inside the
visualizer's independent map renderers.

Like the other Found in Space toolkits, Shadowline is package-first: the
reusable geometry and ephemeris integration live in focused
`@found-in-space/*` packages, while the visualizer is an application that
consumes their public APIs.

## Install

Install the renderer-independent geometry package with the companion Astronomy
Engine capability provider:

```bash
npm install @found-in-space/shadowline \
  @found-in-space/shadowline-astronomy-engine
```

Applications with their own Earth-fixed Sun and Moon ephemerides need only
`@found-in-space/shadowline`.

## Architecture

```text
@found-in-space/shadowline
  dependency-free geometry, discovery facade, and GIS exporters
            │
            ├── @found-in-space/shadowline-astronomy-engine
            │     ephemerides, eclipse search, and observer circumstances
            │
            └── apps/visualizer
                  Vanilla TypeScript, Vite, Leaflet, MapLibre,
                  OpenStreetMap, and NASA GIBS
```

`@found-in-space/shadowline` owns the public model and accepts separate
Earth-fixed ephemeris, eclipse-search, and observer-circumstances
capabilities. Geometry requires only the ephemeris capability. Astronomy
Engine is isolated in a separate adapter so a future foundin.space native
provider can replace any capability without changing the geometry, exporter,
or application APIs.

## Development

Node.js 22 or later is the only requirement for package and visualizer
development:

```bash
npm install
npm run dev          # Vite dev server → http://127.0.0.1:5173/
npm run typecheck    # workspace and tool TypeScript contracts
npm test             # unit and integration tests
npm run build        # packages and production visualizer
npm run test:browser # Playwright application scenarios
```

Open `http://127.0.0.1:5173`. The application and eclipse calculations run
locally. Standard OpenStreetMap raster tiles are requested over the network for
the two interactive top views, and the fixed whole-Earth view requests NASA
Blue Marble imagery from GIBS.

The production output is written to `dist/site`. The equivalent convenience
commands are available through [`just`](https://just.systems/):

```bash
just setup
just validate
```

## Projection testbed

The visualizer deliberately renders every calculated feature through two
separate map engines and three projections:

| Panel | Renderer | Projection and purpose |
|---|---|---|
| Top left | Leaflet | Web Mercator OpenStreetMap planning view |
| Top right | MapLibre GL JS | Interactive spherical OpenStreetMap globe |
| Bottom | Leaflet | Fixed EPSG:4326/equirectangular NASA whole-Earth view |

All three receive the same `EclipseScene`. ECEF WGS 84 points and their
physical curve/region topology are canonical; longitude/latitude is a derived
convenience on each point. Flat renderers call `toGeoJson` with their own seam
and latitude policy. The globe uses signed cross-track limits, horizon-cap
strips, partial-eclipse extent, instantaneous regions, and sunrise/sunset
limits directly, so it does not reconstruct topology from RFC 7946 shards.
Its custom fill, line, and point layers also
retain latitudes above 85.051128° instead of feeding them through MapLibre's
Web-Mercator-tiled GeoJSON path. The Mercator adapter alone selects an
event-centred display seam and clips at the Web Mercator latitude limit. A
click in any panel selects one observer, updates every marker, and starts one
local-circumstances calculation. Layer visibility is shared, but the two
interactive cameras remain independent.

MapLibre's globe is an Earth-surface renderer. Its projection-aware custom
WebGL layers provide a future route to nearby 3D effects, but a correctly scaled
Sun–Moon–Earth or XR scene will remain a separate astronomical Three.js
consumer of the provider's frame-labelled state vectors.

## Reproducible pipeline

The JavaScript dependency graph is recorded in `package-lock.json`. Eclipse
discovery is requested on demand through the selected provider.

```bash
just test           # type checks and unit/integration tests
just test-browser   # real-browser SPA tests
just validate       # complete deterministic validation
```

The visualizer queries only requested years and a short window for its next
eclipse list, then caches those results for the current browser session.

## Package API

```ts
import {
  EclipseEngine,
  GeoJsonExporter,
} from "@found-in-space/shadowline";
import {
  astronomyEngineCapabilities,
} from "@found-in-space/shadowline-astronomy-engine";

const engine = new EclipseEngine(astronomyEngineCapabilities());

const event = engine.events({
  startUtc: "2026-08-01T00:00:00Z",
  endUtc: "2026-09-01T00:00:00Z",
})[0];
if (!event) throw new Error("No eclipse found in the requested range.");

const scene = engine.calculateEvent(event, {
  centralPath: true,
  globalVisibility: true,
  instantaneousAtUtc: [event.peakUtc],
});
const download = new GeoJsonExporter().export(scene);

const observer = { latitudeDeg: 41.8167, longitudeDeg: -3.185 };
const localMaximum = engine.localCircumstances(event, observer);
const shadow = localMaximum
  ? engine.calculateInstantaneousShadow(event, localMaximum.peak.utc)
  : null;
```

A central-and-partial Leaflet example is checked in at
[`packages/shadowline/examples/leaflet-scenes.ts`](packages/shadowline/examples/leaflet-scenes.ts);
it is under 50 nonblank lines, uses only published APIs, and clips derived
display geometry at Web Mercator's latitude limit without changing the scene.

The public units are explicit:

- UTC instants are serializable ISO 8601 strings;
- canonical surface positions are Earth-fixed Cartesian kilometres on WGS 84;
- each surface point also includes derived longitude/latitude degrees;
- surface distances are kilometres;
- ephemeris positions are AU and velocities are AU/day;
- every state vector names its origin and reference frame.

Local searches accept an observer and a bounded range:

```ts
const local = engine.localEclipses(
  { latitudeDeg: 41.39, longitudeDeg: 2.17, elevationMeters: 20 },
  {
    startUtc: "2000-01-01T00:00:00Z",
    endUtc: "2100-01-01T00:00:00Z",
  },
);
```

The maximum local-search window is 200 years. When a map point is selected, the
SPA searches 50 years before and after the selected eclipse for nearby visible
events.

## Geometry and GIS

For total, annular and hybrid eclipses the engine:

1. obtains geocentric Sun and Moon state vectors;
2. transforms them into a rotating, geocentric Earth-fixed 3D frame;
3. constructs the umbral/antumbral shadow cone;
4. intersects exact cone generators with the implicit WGS 84 ellipsoid;
5. finds swept limits from `C = 0` and `∂C/∂t = 0` at fixed ECEF points;
6. transports a rotation-minimizing surface frame along the centreline;
7. labels limits by signed cross-track, not geographic north or south;
8. joins cone and solar-limb segments into explicit physical regions;
9. converts ECEF points to geodetic coordinates only for convenience; and
10. derives GeoJSON/KML later, with explicit seam and latitude-clip policy.

No path, contact, limb, or penumbral-limit calculation is performed in a map
projection. The core never sees Web Mercator coordinates. Its canonical
features can therefore retain the 2026 path through the high Arctic and can be
reprojected by a GIS or planar renderer. Central-path and global-visibility
results also expose projection-neutral `surface` models for a globe or future
XR scene. The Mercator Leaflet adapter alone derives a temporary
latitude-clipped display copy, rotates the complete geometry into one
event-centred Leaflet world, and then re-splits lines and polygons at that
display world's seam. The MapLibre globe meshes bounded local facets directly
between physical limit and cap samples and renders its vectors from unsplit,
unclipped geographic coordinates; it never triangulates the long serialized
polygon boundary or reuses a Web-Mercator-clamped display copy.

`toGeoJson(scene)` derives these interchange features:

| `feature_type` | Meaning |
|---|---|
| `central_path` | Total, annular, or hybrid central-eclipse polygon |
| `centerline` | Shadow-axis ground track |
| `positive_cross_track_limit` | Limit on the positive side of the transported frame |
| `negative_cross_track_limit` | Limit on the negative side of the transported frame |
| `time_marker` | Calculated UTC, solar angles, width, and centre duration |
| `instantaneous_umbra` | Umbra footprint at a caller-selected UTC instant |
| `instantaneous_antumbra` | Antumbra footprint at a caller-selected UTC instant |
| `instantaneous_penumbra` | Penumbra footprint at the same UTC instant |
| `penumbral_contact` | P1/P4 external and, when present, P2/P3 internal tangencies |
| `penumbra_horizon` | Eclipse-begins/ends-at-sunrise or sunset curve |
| `penumbra_extent` | Swept outer limit of partial-eclipse visibility |

Partial-only eclipses return `centralPath: null`, a complete penumbral
visibility surface, and instantaneous penumbra regions with `central: null`.
`calculateCentralPath`, `calculateGlobalVisibility`,
`calculateInstantaneousShadow`, and `calculateTimeMarkers` remain available as
granular advanced methods. None depends on Leaflet or another renderer.
Magnitude contours remain future work.

P1 and P4 are the first and last external tangencies of the penumbral cone with
Earth. P2 and P3 are the internal tangencies where the complete penumbral
footprint first fits, and last fits, on Earth; high-gamma and partial eclipses
do not always have them. The associated horizon curves are two closed loops
when both penumbral extent limits exist, or a connected figure-eight-style
curve otherwise.

GeoJSON and KML exporters are deterministic pure JavaScript implementations.
The `EclipseExporter` interface is the extension point for future GeoPackage
and Shapefile packages.

### Folium

Folium can consume the downloaded GeoJSON without an eclipse-specific adapter:

```python
import json
import folium

with open("solar-2026-08-12-total.geojson", encoding="utf-8") as source:
    eclipse = json.load(source)

map_ = folium.Map(location=[50, -10], zoom_start=3, tiles="OpenStreetMap")
folium.GeoJson(eclipse, name="Eclipse track").add_to(map_)
folium.LayerControl().add_to(map_)
map_.save("eclipse.html")
```

Leaflet, MapLibre, OpenLayers, Cesium, QGIS, Google Earth and other GIS clients
can use the same canonical output. A renderer may derive its own projection
view; it must not replace the canonical coordinates.

## Accuracy and validation

This is a **planning-grade, centre-of-figure** model. Astronomy Engine uses a
compact VSOP87/NOVAS-derived ephemeris designed for approximately one-arcminute
astronomical accuracy. The path implementation is tested against NASA's WGS 84
table for 12 August 2026:

- interior centre and limit checkpoints within 25 km;
- local maximum within 10 seconds;
- central duration within 3 seconds;
- solar altitude and azimuth within 1 degree.

Accuracy degrades over long historical/future timescales as ΔT becomes
uncertain. Lunar mountains and valleys are not modelled and can move practical
limits by kilometres. The results are not suitable for surveying,
safety-critical navigation, or sub-second scientific prediction.

See `NOTICE.md` for source acknowledgements and third-party licences.

## Releases

The public packages use Changesets for versioning. See
[`docs/releasing.md`](docs/releasing.md) for validation, packed-consumer, and
publishing steps.

## Licence

Shadowline is available under the [MIT License](LICENSE). The visualizer's
deployed `THIRD_PARTY_LICENSES.txt` contains the complete notices required by
its bundled dependencies.

## Docs

- [`packages/shadowline/README.md`](packages/shadowline/README.md): core scene,
  geometry, and serialization APIs
- [`packages/shadowline-astronomy-engine/README.md`](packages/shadowline-astronomy-engine/README.md):
  Astronomy Engine capability adapter
- [`docs/releasing.md`](docs/releasing.md): package release procedure
- [`NOTICE.md`](NOTICE.md): data sources and third-party acknowledgements
