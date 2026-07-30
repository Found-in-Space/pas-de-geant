# Pas de Géant

_Walk around worlds, one small step at a time._

Pas de Géant is a room-scale WebXR experience that puts a relief globe beneath
your feet. Walk through the room or use a controller to roll the world through
the floor contact point, changing planetary scale while the terrain,
atmosphere, sky, and optional live aircraft move with it.

The current world is Earth. Its architecture is intended to support the Moon,
Mars, and smaller bodies as the project grows.

Part of [Found in Space](https://foundin.space/), a project that turns real
astronomical measurements into interactive explorations.

## Run locally

Pas de Géant requires Node.js 22 or later:

```sh
npm ci
npm run dev -- --port 4197
```

Open `http://127.0.0.1:4197`. The desktop fallback uses WASD to travel, Z/X to
change planet scale, C/V to change the radial multiplier, and Backspace to
reset.

WebXR requires a secure context. A USB-connected Quest can use an Android
reverse tunnel so its browser sees the local server as device-local:

```sh
adb reverse tcp:4197 tcp:4197
```

Then open `http://localhost:4197` in the headset.

## Quest controls

- Left stick: head-relative travel
- Left trigger: faster travel
- Right stick horizontal: whole-planet scale
- Right stick vertical: terrain and altitude exaggeration
- X / Y: use one coarser / finer topography source level
- Hold B: reset location, scale, and automatic terrain selection
- Right-stick press: toggle the left-hand Earth map panel

## What is modelled

- A WGS 84 Earth whose mean-sea-level contact stays at the physical floor
- Global GEBCO 2026 relief and bathymetry with local Copernicus GLO-30 detail
- Embedded NASA Blue Marble imagery with optional atomic XYZ refinement
- A Gaia DR3 / Hipparcos celestial sphere through Found in Space SkyKit
- Optional Airplanes.live traffic during an active immersive session
- Browser geolocation with an approximate network fallback

The detailed terrain, imagery, and rendering design is documented in
[`apps/pas-de-geant/README.md`](apps/pas-de-geant/README.md).

## Development

```sh
npm run check              # TypeScript project references
npm test                   # Focused unit regressions
npm run build              # Pas de Géant production build
npm run test:browser       # Pas de Géant browser suite
```

The production application is written to `dist/pas-de-geant`.

## Data, licences, and limitations

Source, licence, datum, DOI, checksum, and service-attribution details live in
[`apps/pas-de-geant/public/THIRD_PARTY_LICENSES.txt`](apps/pas-de-geant/public/THIRD_PARTY_LICENSES.txt).

Live aircraft are an opt-in proof of concept and are disabled on each page
load. Terrain and imagery are not suitable for navigation or safety-critical
use.

The software is available under the [MIT License](LICENSE).
