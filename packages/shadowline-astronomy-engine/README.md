# @found-in-space/shadowline-astronomy-engine

Status: current 0.2 provider package.

Astronomy Engine 2.1.19 capabilities for
`@found-in-space/shadowline`.

This adapter supplies Earth-fixed Sun and Moon ephemerides, eclipse search, and
observer circumstances through Shadowline's public capability interfaces.

## Install

```bash
npm install @found-in-space/shadowline \
  @found-in-space/shadowline-astronomy-engine
```

## Use

```ts
import { EclipseEngine } from "@found-in-space/shadowline";
import {
  astronomyEngineCapabilities,
} from "@found-in-space/shadowline-astronomy-engine";

const engine = new EclipseEngine(astronomyEngineCapabilities());
const events = engine.events({
  startUtc: "2026-01-01T00:00:00Z",
  endUtc: "2027-01-01T00:00:00Z",
});
```

Use `AstronomyEngineProvider` directly when an application needs the individual
interfaces or frame-labelled state vectors:

```ts
import {
  AstronomyEngineProvider,
} from "@found-in-space/shadowline-astronomy-engine";

const provider = new AstronomyEngineProvider();
const sun = provider.stateVector(
  "sun",
  "2026-08-12T17:46:00Z",
  "geocentric-earth-fixed",
);
```

## Capabilities

`astronomyEngineCapabilities()` returns one provider split into the three
capability lanes accepted by `EclipseEngine`:

- `EarthFixedEphemeris`
- `EclipseSearch`
- `ObserverCircumstances`

The provider also exposes frame-labelled geocentric, heliocentric, and
barycentric state vectors for consumers that need them directly.

## Boundary

This is the only workspace package that depends on Astronomy Engine. It
normalizes provider output but does not calculate shadow cones, surface paths,
penumbral topology, GeoJSON, KML, or renderer state. Those remain in
`@found-in-space/shadowline` or downstream applications.
