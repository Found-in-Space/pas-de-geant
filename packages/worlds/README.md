# Found in Space Worlds

`@found-in-space/worlds` is the reusable world capability owned by Pas de Géant.
Earth, Moon, and the other registered Solar System bodies use the same runtime.
The main experience, focused Moon demo, and Eclipse Observatory consume this
package rather than maintaining copies of its surface and coordinate code.
This is an alpha workspace package; it has not been published to npm.

It provides body definitions, physical ephemerides, reference geometry, contact
frames, scale conversion, streamed terrain and imagery, and an optional Skykit
lifecycle adapter. Cameras, navigation inputs, page UI, atmospheres, live feeds,
and the render loop belong to the host application. Skykit remains the composer;
worlds does not depend on Skykit internals or move world-specific logic into its
core.

## Create a world

```ts
import {
  celestialBody,
  createWorldRuntime,
  MOON_SURFACE_MODEL,
  type TerrainSurfaceView,
} from "@found-in-space/worlds";

const view: TerrainSurfaceView = {
  latitudeDegrees: 18,
  longitudeDegrees: -24,
  displayRadiusM: 2.25,
  observerHeightWorldM: 3.55,
  focalLengthPixels: 1_000, // drawing-buffer pixels, including pixel ratio
  terrainMultiplier: 1,
};
const world = createWorldRuntime({
  body: celestialBody("moon"),
  renderer,
  initialView: view,
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

// Each host frame, before rendering:
world.update(view);
world.processFrame(); // advances asynchronous publication even when stationary
world.beforeRender(camera); // supply the XR ArrayCamera when presenting
renderer.render(scene, camera);
```

Omit `surface` to create a plain globe for any registered body. Supply a base
texture to use the same streamed-surface implementation on another body;
`createBodySurfaceModel(body, source)` derives its geometry from the body's
shape and radius. Omitting an elevation provider gives a flat reference surface
without contacting an Earth service. The Earth application explicitly supplies
its Mapterhorn provider and WGS84/Mercator model. The lunar source uses its
reference sphere, the same Mercator scheme as Earth, and LOLA red/green height
encoding. `MOON_GEOGRAPHIC_SURFACE_MODEL` is the explicit compatibility model
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
adaptive balance still uses the light direction. The application uses this
presentation for the Moon's base, polar caps and streamed detail. It does not
apply renderer-wide tone mapping on top. Omitting the option retains the existing
surface presentation, including Earth's current appearance.

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
change the planner's grid or LOD. In surface mode, eye height is measured above
the terrain contact pinned to the host floor.

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
The main and focused Moon views share `lunarSurfaceSource` in the application,
including their base image, providers, and tone curve.

Call `world.dispose()` when finished. It disposes its terrain, providers, worker
schedulers, and owned globe meshes, and removes its content from the supplied
root. Other children of a borrowed root remain intact. Base textures are
borrowed unless `disposeBaseTexture: true` transfers ownership to the runtime.
The host removes the root from its scene and disposes its camera/renderer.

## Use with Skykit

The optional `@found-in-space/worlds/skykit` entry point uses Skykit's public
part/plugin lifecycle. It has no separate camera, renderer, or animation loop.
The host supplies an explicit view mapping and presentation callback:

```ts
import {
  bodyFixedToIcrsQuaternion,
  bodyPositionJ2000M,
  bodyRotation,
} from "@found-in-space/worlds";
import {
  createWorldSkykitPlugin,
  physicalJ2000MetresToSkykitPosition,
  WORLD_METRES_PER_PARSEC,
} from "@found-in-space/worlds/skykit";

const unregister = await viewer.addPlugin(createWorldSkykitPlugin({
  world,
  getView(frame) {
    const unitsPerMetre = frame.view.coordinateUnitsPerParsec / WORLD_METRES_PER_PARSEC;
    return {
      ...view,
      displayRadiusM: world.body.referenceRadiusM * unitsPerMetre,
      observerHeightWorldM: physicalObserverAltitudeM * unitsPerMetre,
    };
  },
  present(frame, runtime) {
    const at = simulationDate();
    const position = physicalJ2000MetresToSkykitPosition(
      bodyPositionJ2000M(runtime.body.id, at), frame.view.coordinateUnitsPerParsec,
    );
    runtime.object3d.position.set(position.x, position.y, position.z);
    runtime.object3d.quaternion.copy(bodyFixedToIcrsQuaternion(bodyRotation(runtime.body.id, at)));
  },
  disposeWorld: true,
}));
```

Skykit uses raw J2000/ICRS axes and parsec-based coordinates; these helpers
retain those axes while converting physical metres to render units. Pas de
Géant's Y-up mapping stays at its own presentation boundary. Observer altitude,
surface location, physical versus illustrative scale, time, and lighting remain
explicit host choices. A close-range host may supply a different display scale
or camera-relative position through these same callbacks.

The default parent is `originContentRoot`; `parent: "observer"` mounts on
`observerContentRoot` for an observer-relative experience. The adapter uses the
XR camera for render visibility when Skykit's renderer is presenting. Worlds
are borrowed by default; `disposeWorld: true` transfers lifecycle ownership.
Calling `unregister()` removes the part and applies that ownership rule.

## Develop and package

From the repository root:

```sh
npm run build --workspace @found-in-space/worlds
npm run dev --workspace @found-in-space/worlds # watch shared package changes
npm run typecheck
npm test
npm run build
npm pack --workspace @found-in-space/worlds --pack-destination /tmp
```

The package ships ESM JavaScript, TypeScript declarations, and both worker
modules in `dist`. A browser bundler must support module workers constructed
with `new URL(..., import.meta.url)`; the app's Vite production build exercises
this contract. Consumers supply one shared Three.js instance (Vite hosts can
use `resolve.dedupe: ["three"]`). Skykit is an optional peer used only by the
adapter's type contract.

Use the root entry point for runtime composition. Subpaths such as
`/terrain-surface`, `/imagery-provider`, `/image-tile-provider`, `/terrain-lod`,
and `/tile-debug-controls` expose the existing lower-level capabilities used
by the applications, diagnostics, and tests. These alpha contracts may evolve
together; implementation changes should preserve the Earth and Moon regressions.

## Persistent tile caching

Configured imagery and elevation use browser Cache Storage before direct provider
requests. Good responses remain reusable
indefinitely, independent of HTTP freshness headers; browser storage eviction
and explicit invalidation still apply. Legacy synthetic fallback responses are
rejected and retried rather than retained as imagery or elevation. Source URLs
(including product/grid identity) distinguish versions; change that identity
or explicitly invalidate retained entries when replacing source content.
`TerrainSurface` uses a flat elevation provider unless its host supplies a
configured one; the package has no application tile-service default.
