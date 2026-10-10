# Pas de Géant

_Walk around worlds, one small step at a time._

Pas de Géant is a room-scale WebXR experience that puts a relief globe beneath
your feet. Walk through the room or use a controller to roll the world through
the floor contact point, changing planetary scale while the terrain,
atmosphere, sky, and optional live aircraft move with it.

Earth and Moon have streamed ground surfaces, and the other registered major
Solar System bodies have plain globes for orbit and free navigation. All use
the shared [`@found-in-space/worlds` package](packages/worlds/README.md), which
also provides a public Skykit lifecycle adapter for other Found in Space hosts.

Part of [Found in Space](https://foundin.space/), a project that turns real
astronomical measurements into interactive explorations.

## Run locally

Pas de Géant requires Node.js 22 or later:

```sh
npm ci
npm run dev -- --port 4197
```

Open `http://127.0.0.1:4197`. The desktop fallback uses WASD to travel, Z/X to
change planet scale, C/V to change the terrain multiplier, and Backspace to
reset.

Open `http://127.0.0.1:4197/moon/` for the focused Moon viewer. Its imagery,
elevation, and display configuration are shared with the main experience.
Open `http://127.0.0.1:4197/?world=moon` to start the walking experience on the
Moon. In a headset, select **Enter VR** and use the same room-scale walking and
controller controls as Earth.

WebXR requires a secure context. A USB-connected Quest can use an Android
reverse tunnel so its browser sees the local server as device-local:

Before running any ADB command, open Meta Quest Developer Hub and confirm that
the headset is connected and authorized there. Use the ADB associated with
that working Developer Hub connection before trying another ADB installation;
`adb` below refers to that executable.

```sh
adb reverse tcp:4197 tcp:4197
```

Then open `http://localhost:4197` in the headset.

The detailed app README documents the repository helper and how to open the
Quest Browser JavaScript console through its DevTools connection.

## Quest controls

- Left stick: head-relative travel
- Left trigger + left stick left/right: turn the view
- Left grip: faster travel
- Right stick vertical: whole-planet scale
- Right stick horizontal: orbital altitude, or surface terrain exaggeration
- X: toggle committed terrain-tile tint and boundary outlines
- Y: toggle photographic source-tile boundaries
- Hold B: reset location and scale

## What is modelled

- A WGS 84 Earth whose sea-level ellipsoid meets the physical floor
- Mapterhorn / Copernicus GLO-30 terrain with atomic quadtree transitions
- Embedded NASA Blue Marble imagery with optional atomic XYZ refinement
- A Gaia DR3 / Hipparcos celestial sphere through Found in Space SkyKit
- Optional Flight Follower traffic during an active immersive session
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
The reusable package is built to `packages/worlds/dist`. When editing its source
with the app already running, use `npm run dev --workspace @found-in-space/worlds`
in another terminal to rebuild it as files change.

## Data, licences, and limitations

Source, licence, datum, DOI, checksum, and service-attribution details live in
[`apps/pas-de-geant/public/THIRD_PARTY_LICENSES.txt`](apps/pas-de-geant/public/THIRD_PARTY_LICENSES.txt).

Live aircraft are an opt-in proof of concept and are disabled on each page
load. Terrain and imagery are not suitable for navigation or safety-critical
use.

The software is available under the [MIT License](LICENSE).
