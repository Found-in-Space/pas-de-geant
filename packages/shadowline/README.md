# @found-in-space/shadowline

Status: current 0.2 package.

Dependency-free, renderer-independent solar-eclipse geometry for Found in Space
applications, browser maps, and back ends.

The package turns Earth-fixed Sun and Moon state vectors into physical eclipse
scenes. It does not depend on Astronomy Engine, Leaflet, MapLibre, Three.js, a
DOM, or a map projection.

## Install

```bash
npm install @found-in-space/shadowline \
  @found-in-space/shadowline-astronomy-engine
```

The Astronomy Engine adapter is optional. Applications can provide any
`EarthFixedEphemeris` implementation instead.

## Minimal scene

```ts
import {
  EclipseEngine,
  toGeoJson,
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

const geoJson = toGeoJson(scene);
```

`EclipseScene` is the hand-off between physical calculation and presentation.
A custom Canvas, SVG, globe, GIS, or XR renderer can consume its surface
topology directly. A flat map can serialize the same scene with its own seam
and latitude policy.

## Physical scene

The canonical 0.2 model uses Earth-fixed Cartesian WGS 84 positions:

- `SurfacePoint.ecefKm` is the physical coordinate;
- `SurfacePoint.geographic` is a derived longitude/latitude convenience;
- `centralPath` contains the centreline and signed cross-track limits;
- `globalVisibility` contains penumbral extent and horizon curves;
- `instantaneousShadows` contains explicit central and penumbral regions; and
- `contacts` contains the applicable P1–P4 tangencies.

Partial-only eclipses have `centralPath: null` and instantaneous shadows with
`central: null`. Their penumbral regions remain complete and exportable.

## Granular calculations

`calculateEvent()` is the beginner-facing facade. Lower-level consumers can use:

- `calculateCentralPath()`
- `calculateGlobalVisibility()`
- `calculateInstantaneousShadow()`
- `calculateTimeMarkers()`

Time markers are optional enrichment. They are not part of the physical path
calculation.

## Serialization

Use `toGeoJson(scene, options)`, `GeoJsonExporter`, or `KmlExporter` at the
serialization boundary:

```ts
const webMap = toGeoJson(scene, {
  seam: "split",
  latitudeClipDeg: 85.051128,
});
```

GeoJSON is a derived interchange view, not the scene model. Renderers must not
reconstruct physical rings from antimeridian-split GeoJSON.

## Capability boundary

Construct `EclipseEngine` with an `EclipseCapabilities` object. Geometry needs
only `ephemeris: EarthFixedEphemeris`. Global eclipse search and observer
circumstances are optional capabilities; methods that need a missing optional
service throw `EclipseCapabilityError`.

This keeps provider selection independent of geometry, serialization, and
rendering.

## Example

[`examples/leaflet-scenes.ts`](examples/leaflet-scenes.ts) renders one central
and one partial-only eclipse in Leaflet. It stays under 50 nonblank lines and
uses only published package APIs. Install the example's renderer separately:

```bash
npm install leaflet
npm install --save-dev @types/leaflet
```

The consuming page supplies a sized `#map` container; the example imports
Leaflet's stylesheet and clips its derived display geometry at the Web Mercator
latitude limit.

## Boundary

This package owns eclipse geometry, physical scene topology, WGS 84 coordinate
conversion, and portable serialization. Ephemeris models belong in provider
packages. Map projections, tiles, styling, interaction, and renderer-specific
clipping belong in applications or renderer adapters.
