# Found in Space Worlds

`@found-in-space/pas-de-geant/worlds` is the reusable world capability owned by Pas de Géant.
Earth, Moon, and the other registered Solar System bodies use the same runtime.
Independent browser consumers and isolated development cases consume the public
package rather than maintaining copies of its surface and coordinate code.
This is an alpha workspace package; it has not been published to npm.

It provides body definitions, physical ephemerides, reference geometry, contact
frames, scale conversion, streamed terrain and imagery, and an optional Skykit
lifecycle adapter. Cameras, navigation inputs, page UI, atmospheres, live feeds,
and the render loop belong to the host application. Skykit remains the composer;
worlds does not depend on Skykit internals or move world-specific logic into its
core.

## Placement boundary

The world runtime supplies geometry and rendering.
The world runtime does not select a movement model or change the camera orientation.
The composition plugin applies the transform supplied by the movement adapter.
The same transform applies to every selected body.

The [movement architecture](movement.md) defines the model interface and integration procedure.
Surface, observation, ship, and desktop models are optional implementations.
A host can supply another model through the public interface.
A custom surface adapter can supply geometry without a world renderer.
The [composition contract](composition.md) defines the shared path from a
complete pose and rendered camera to measured planner inputs.

## Create a world

```ts
import {
  celestialBody,
  createWorldRuntime,
  MOON_SURFACE_MODEL,
  type TerrainSurfaceView,
} from "@found-in-space/pas-de-geant/worlds";
import * as THREE from "three";

// Construction seed only. Live views are measured by updateFromCamera().
const initialView: TerrainSurfaceView = {
  latitudeDegrees: 18,
  longitudeDegrees: -24,
  displayRadiusM: 2.25,
  observerHeightWorldM: 3.55,
  focalLengthPixels: 1_000,
  terrainMultiplier: 1,
};
const world = createWorldRuntime({
  body: celestialBody("moon"),
  renderer,
  initialView,
  surface: {
    baseTexture,
    surfaceModel: MOON_SURFACE_MODEL,
    imageryProvider,
    elevationProvider,
    albedoToneExponent: 0.8,
    displayPresentation: {
      lighting: "neutral", gain: 1.3, contrast: 2, contrastPivot: 0.4,
    },
  },
});
scene.add(world.object3d);
const pose = {
  position: new THREE.Vector3(0, 0, -4),
  orientation: new THREE.Quaternion(),
  displayRadiusM: 2.25,
};

// Each host frame, before rendering:
world.processFrame(); // publish before any ground-anchored pose calculation
world.updateFromCamera({ camera, pose, terrainMultiplier: 1 });
world.beforeRender(renderer.xr.isPresenting ? renderer.xr.getCamera() : camera);
renderer.render(scene, camera);
```

Supply the host's desktop perspective camera to `updateFromCamera()` during
both desktop and XR rendering. The runtime applies the full pose, refreshes XR
eyes from the final rig and measures its own terrain. `world.getView()` returns
the last measured planner inputs. Keep `initialView` as a construction seed.
Use `update(view)` only when the host already owns a coherent measured view.

Omit `surface` to create a plain globe for any registered body. Supply a base
texture to use the same streamed-surface implementation on another body;
`createBodySurfaceModel(body, source)` derives its geometry from the body's
shape and radius. Omitting an elevation provider gives a flat reference surface
without contacting an Earth service. Hosts explicitly configure measured
elevation and its model. Lunar sources may use their reference sphere with
Mercator grids and LOLA red/green height encoding. `MOON_GEOGRAPHIC_SURFACE_MODEL` is the explicit compatibility model
for existing geographic products.

`WorldSurfaceSource` supplies source-specific projection, height decoding,
attribution, bounds, imagery, and display choices through the surface model and
providers. Hosts admit datasets and retain their release/provenance records;
worlds consumes them. It does not produce tiles or bundle data payloads.
The texture pipeline remains the display-texture producer, with scientific
elevation following its own contract. Relief exaggeration and the lunar tone
curve are presentation choices, not measurements or changes to source data.

Optional `displayPresentation` applies linear-light gain, explicitly converts to
the renderer's output colour space, then applies a sigmoid contrast curve that
preserves black, white and `contrastPivot`. `contrast: 1` leaves output contrast
unchanged. `lighting: "neutral"` replaces the final solar modulation and blue
fill with the existing balanced imagery; photographed shadows remain, and the
adaptive balance still uses the light direction. Hosts can select this
presentation for base, polar caps and streamed detail and should account for
renderer-wide tone mapping. Omitting the option retains the default presentation.

`SparseImageryProvider` selects one available opaque tile from providers sharing
the same XYZ grid and tile size. Source indexes declare exact coverage; the best
available resolution wins, with priority deciding ties. Its `resolveSource`
hook runs before the shared source queue so requests above a local resolution
cap share the same parent acquisition and decode. The texture tree and shader
sample that parent normally. Reprojection and masked compositing belong in the
producer, before the tiles enter this runtime.

Rendering and resource admission share `surfaceModel.visibilityGeometry` and
`surfaceDisplacementBounds`. Body-local coordinates are physical metres divided
by the body's reference radius; the geometry normalizes the actual sphere or
ellipsoid rather than assuming WGS84. Elevation bounds are decoded metres,
scaled by the terrain multiplier; skirts use render metres. The conservative
inner occluding shell accounts for negative elevation and mesh chord error,
while the outer shell includes raised terrain and temporarily flat meshes.
Unknown bounds retain planner candidates conservatively. These are geometric
bounds, not a measured terrain horizon.

`world.beforeRender(camera)` supplies actual body-local eye positions to both
terrain and imagery admission, enclosing the XR eyes in an observer sphere. Head direction
and frusta affect only render visibility. Admission hydrates the existing
complete planner cut and replacement dependencies; it does not create tiles or
change the planner's grid or LOD. `updateFromCamera()` measures eye height from
the actual posed terrain, independently of the selected movement model.

`TileGrid` identifies projection, version and reference radius. Display format
2 products must declare it; `displayTextureSource` admits their opaque XYZ
metadata and separate authenticated equirectangular `base.png`. Format 1 lunar
products retain geographic interpretation and their zoom-0 base. Scientific
heights use the separate `elevationSource` contract (metres, reference surface,
encoding, global bounds). `requireCompatibleSurfaceSources` rejects mixing
grids. Provider identities include product/grid identity; migration requires new
payload paths. Mercator covers ±85.05112878°; the shared polar caps use the
equirectangular base and flat reference height beyond that limit.

Mesh elevation UVs and CPU ground sampling both use projected coordinates,
matching imagery. The mesh layout and height shader remain shared across bodies.

Render visibility scans the texels that contribute to each decoded elevation
crop, including its bilinear halo, using the surface's height encoding. Bounds
are cached by image and crop; buffers used only for bounds are released after
the turn. Ground-sampling buffers remain reusable. Measured extrema tighten
each mesh's frustum and target-horizon bounds, while the occluding shell and
resource admission retain the provider's conservative global envelope. Pending
sources use that envelope; confirmed flat meshes use zero heights. Runtime
metrics report measured and provider-fallback bound counts. This refinement
adapts the measured-bounds work from commit `34c4e339fcc2dc2c5e6167a4e6251818730f2ca2`
to both Terrarium and RG16 surfaces.

For a surface beneath an observer, use `solveBodySurfacePose` with the runtime's
`surfaceModel` and the loaded `surface.sampleElevationMetres(latitude, longitude)`
as its fifth argument. The solver applies the state's terrain multiplier and
pins that displaced contact to the host floor; with no elevation argument it
pins the reference surface. It preserves the transported contact frame used for
travel, on spherical and ellipsoidal bodies. `solvePlanetPose` remains the legacy WGS84
wrapper. Physical positions and reference radii are metres; display radii and
observer heights use the host's render units. Body-fixed axes are X at latitude
0/longitude 0, Y north, and negative Z east.

## Readiness and ownership

`world.getReadiness()` reports `base`, `loading`, `ready`, or `fallback` imagery.
A streamed surface becomes ready after a terrain cut is committed and either
the imagery cut is complete or a source failure allows its base fallback.
Streaming can subsequently recover. `loadWorldBaseTexture` loads a source base
with a bundled fallback and records the source failure for this readiness check.

Call `world.dispose()` when finished. It disposes its terrain, providers, worker
schedulers, and owned globe meshes, and removes its content from the supplied
root. Other children of a borrowed root remain intact. Base textures are
borrowed unless `disposeBaseTexture: true` transfers ownership to the runtime.
The host removes the root from its scene and disposes its camera/renderer.

## Use with Skykit

The optional `@found-in-space/pas-de-geant/worlds/skykit` entry point uses Skykit's public
part/plugin lifecycle. It has no separate camera, renderer, or animation loop.
The host supplies a complete pose and terrain multiplier through `getFrame`:

```ts
import {
  bodyFixedToIcrsQuaternion,
  bodyPositionJ2000M,
  bodyRotation,
} from "@found-in-space/pas-de-geant/worlds";
import {
  createWorldSkykitPlugin,
  physicalJ2000MetresToSkykitPosition,
  WORLD_METRES_PER_PARSEC,
} from "@found-in-space/pas-de-geant/worlds/skykit";

const unregister = await viewer.addPlugin(createWorldSkykitPlugin({
  world,
  getFrame(frame) {
    const unitsPerMetre = frame.view.coordinateUnitsPerParsec / WORLD_METRES_PER_PARSEC;
    const at = simulationDate();
    const position = physicalJ2000MetresToSkykitPosition(
      bodyPositionJ2000M(world.body.id, at), frame.view.coordinateUnitsPerParsec,
    );
    return { pose: {
      position: new THREE.Vector3(position.x, position.y, position.z),
      orientation: bodyFixedToIcrsQuaternion(bodyRotation(world.body.id, at)),
      displayRadiusM: world.body.referenceRadiusM * unitsPerMetre,
    }, terrainMultiplier: 1 };
  },
  disposeWorld: true,
}));
```

Skykit uses raw J2000/ICRS axes and parsec-based coordinates; these helpers
retain those axes while converting physical metres to render units. Pas de
Géant's Y-up mapping stays at its own presentation boundary. Observer altitude,
surface location, physical versus illustrative scale, time, and lighting remain
explicit host choices. A close-range host may supply a different display scale
or camera-relative position through this callback. `getView`/`present` remains
the explicit path for a host that owns its view measurement; see the composition
contract for its ordering requirements.

The default parent is `originContentRoot`; `parent: "observer"` mounts on
`observerContentRoot` for an observer-relative experience. The adapter uses the
XR camera for render visibility when Skykit's renderer is presenting. Worlds
are borrowed by default; `disposeWorld: true` transfers lifecycle ownership.
Calling `unregister()` removes the part and applies that ownership rule.

## Develop and package

From the repository root:

```sh
npm run build --workspace @found-in-space/pas-de-geant
npm run dev --workspace @found-in-space/pas-de-geant # watch shared package changes
npm run typecheck
npm test
npm run build
npm pack --workspace @found-in-space/pas-de-geant --pack-destination /tmp
```

The package ships ESM JavaScript, TypeScript declarations, and both worker
modules in `dist`. A browser bundler must support module workers constructed
with `new URL(..., import.meta.url)`; the embed and integration builds exercise
this contract. Consumers supply one shared Three.js instance (Vite hosts can
use `resolve.dedupe: ["three"]`). The optional adapter uses SkyKit's public lifecycle; the
composition layer reuses the published SkyKit package directly.

Use `/worlds` for model, surface and runtime composition and `/worlds/skykit`
for the lifecycle adapter. Internal modules are deliberately absent from the
package export map. Tests of individual algorithms use repository source paths;
application consumers use supported exports.

## Persistent tile caching

Configured imagery and elevation use browser Cache Storage before direct provider
requests. Good responses remain reusable
indefinitely, independent of HTTP freshness headers; browser storage eviction
and explicit invalidation still apply. Legacy synthetic fallback responses are
rejected and retried rather than retained as imagery or elevation. Source URLs
(including product/grid identity) distinguish versions; change that identity
or explicitly invalidate retained entries when replacing source content.
`TerrainSurface` uses a flat elevation provider unless its host supplies a
configured one. The browser convenience factory supplies Mapterhorn terrain for
Earth; lower-level world construction still requires explicit providers.

## Shared spatial alpha

Generic vector/quaternion operations, unit conversion, interpolation, and relative
frame transforms use published spatial `0.3.0-alpha.1` with SkyKit
`0.3.0-alpha.0`. Body definitions, ephemerides,
datums, and transported surface contact remain in worlds.

The physical frame is heliocentric equatorial J2000 in metres. Its Y-up mapping
retains the same origin; neither mapping establishes a catalog origin or an ICRS
correction. A caller must explicitly establish those astronomical relationships.
The raw body-attitude helper is named `bodyFixedToJ2000Quaternion` accordingly.

The package and root tooling pin the same exact spatial version; SkyKit uses
that version as well. Direct star dependencies follow the compatible alpha
batch. There are no local package archives or sibling links. Run `npm ci` and
`npm run check:spatial-package` at the repository root to verify installed
registry versions, shared resolution and the domain conversion/preload adapters.
Root tooling and integration cases share the Three.js 0.170 peer with SkyKit
and Geant. Vite consumers deduplicate Three.js.

## Continuous grid coordinates for adapters

`projectedTilePoint(latitudeDegrees, longitudeDegrees, zoom, projection)` and
`tilePointToGeographic(x, y, zoom, projection)` are public `/worlds` functions.
Coordinates are continuous tile units with a north-west origin; zoom zero is a
normalized grid. The forward function wraps longitude and clamps latitude to
the grid domain. The inverse preserves the distinct -180/+180 degree edges.
`tileBounds(tile, projection)` is public for adapters that do not need a body mesh.
These conversions do not change vertical datums or apply a local map projection.

## Earth day and night imagery

The browser convenience preset now uses the separately hosted NASA Blue Marble
Next Generation July 2004 product: 256 × 256 opaque RGB PNG tiles, XYZ Web Mercator,
zoom 0–9. Its 4096 × 2048 equirectangular `base.png` covers the complete globe,
including polar caps outside Mercator. The bundled 2048-pixel Blue Marble remains
the disconnected fallback. `createReferenceSurfaceFactory()` explicitly selects
that bundled reference with flat height; `createDefaultSurfaceFactory()` selects
the online day product with reference fallback and measured Mapterhorn terrain.
Authored compositions, including the size
comparison case, use the latter. Other bodies retain their reference sources.
Explicit `surfaces` or `datasets` bindings still take precedence.

The default elevation is the former main application's Mapterhorn Terrarium
source at `https://tiles.mapterhorn.com/{z}/{x}/{y}.webp`, XYZ Web Mercator,
512 × 512 elevation tiles through zoom 12. It uses `EARTH_SURFACE_MODEL`'s
Terrarium encoding and elevation metadata, independent of the 256-pixel display
imagery contract. The binding is exported as `EARTH_MAPTERHORN_ELEVATION`.
Tile requests remain lazy and use persistent browser caching. A failed Blue
Marble descriptor does not remove the elevation provider. Disconnected terrain
depends on retained elevation tiles; the bundled fallback contains imagery only.

For a day/night Earth, use public browser exports:

```ts
import { createGeantBrowser, createDefaultSurfaceFactory } from "@found-in-space/pas-de-geant/browser";

const browser = await createGeantBrowser({
  host, bodies: ["earth"], mode: "orbit", xr: true,
  surfaces: { earth: createDefaultSurfaceFactory({ night: true }) },
});
```

Alternatively, configure `BodySurfaceDatasets.imagery` and `.nightImagery` with
`EARTH_BLUE_MARBLE_DATASET` and `EARTH_BLACK_MARBLE_DATASET` (both exported by
`/browser`), or supply independent product bindings. The resolver admits all
sources and checks day/night/elevation grid compatibility before acquiring base
textures. It loads each admitted equirectangular base and distinct tile provider;
custom `loadTexture` supports hosts with their own image loading. A failed day
base retains the supplied fallback; a failed night base is black. Valid tile
providers remain available to recover detail. Invalid explicit descriptors fail
admission rather than being reinterpreted. The convenience default can fall back
to the bundled reference if descriptors are unavailable.

Night imagery is optional. It uses the same visible hemisphere, source queue,
256-pixel decoding, virtual texture, mesh UVs, suspension and disposal path as day
imagery, with a separate pool and product cache identity. It adds no shell mesh,
second scene pass or render loop. Close views can therefore stream both pyramids;
the extra night texture pool also consumes GPU memory. `disposeNightTexture: true`
transfers ownership of a supplied night base to the world runtime.

The signed dot product of the smooth world-space geodetic normal and sunlight
direction drives the global terminator. The world plugin already derives sunlight
and body rotation from the shared simulation time. A soft blend over solar
incidence −0.10 to +0.06 is an illustrative twilight band, independent of terrain
normals. Day albedo receives solar lighting; the night composite retains its own
brightness instead of being multiplied by daylight. Polar caps sample the night
base, never wrapped Mercator tiles.

Black Marble is NASA's 2016 **display composite**, including background geography
and city lights. It is not a calibrated lights-only emission product or current
light-use data. Blue Marble is a July 2004 composite. Neither source simulates
clouds, weather, seasonal changes or changing city illumination. The independent
`integration/earth-day-night.html` case exposes UTC seeking, accelerated playback,
pause, day-only comparison and VR using only public APIs.
