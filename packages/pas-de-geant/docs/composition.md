# Compose a rendered world

Use `createGeantBrowser()` for the standard composition. An explicit Geant host
installs worlds, movement and controls through their public plugins. A host that
places bodies directly uses `world.updateFromCamera()` or the SkyKit adapter's
`getFrame` callback. These paths share the same view measurement.

## Responsibilities

| Owner | Supplies |
| --- | --- |
| Host or movement model | Body position, orientation, display radius and terrain multiplier |
| Renderer and XR runtime | Camera projection, framebuffer dimensions, tracked eye matrices and eye viewports |
| World runtime | Complete pose application, eye-height measurement against its own surface, and tile-view construction |
| Terrain and imagery planners | Detail selection, source refinement, hysteresis, resource admission and publication |
| Controls | Input bindings and changes to navigation state |

The host supplies a complete pose. The world runtime applies position,
orientation and scale before it measures the surface. A scale change takes
effect in that frame. A replacement world measures its own elevation at the
same pose as the active world.

Camera-driven consumers do not calculate tile zoom or construct live
`TerrainSurfaceView` values. The runtime supplies those values from the rendered
view. `world.getView()` returns a copy of the last view used for tile selection.
Before the first update, it returns the construction seed.

## Direct placement

```ts
// world was constructed with renderer and an initialView seed.
// Run in the host's existing frame loop, before rendering.
world.processFrame();
const view = world.updateFromCamera({
  camera, // The host's desktop camera; keep passing it during XR.
  pose: { position, orientation, displayRadiusM },
  terrainMultiplier,
});
world.beforeRender(renderer.xr.isPresenting ? renderer.xr.getCamera() : camera);
renderer.render(scene, camera);
```

Position and orientation use the body's parent coordinates. Display radius and
eye height use render metres. Use unscaled scene parents for metre-based
placement. The geometry inside the body root is normalized by its reference
radius; physical source heights remain metres.

Publish completed terrain before a movement model queries ground height or a
host computes a ground-anchored pose. `updateFromCamera()` then:

1. Applies the complete body pose.
2. Refreshes XR eye matrices from the desktop perspective camera and its final rig.
3. Measures the eye position against this world's current terrain and multiplier.
4. Calculates focal length from the current rendered projection and viewport.
5. Supplies that measured view to the existing terrain and imagery planners.

For desktop, focal length uses drawing-buffer height and the camera projection
matrix, including camera zoom. For XR, it uses the greatest focal length from
the individual eye projections and viewport heights. The desktop canvas size
does not establish XR density. XR eye positions come from their world matrices;
calling `getWorldPosition()` on an unparented XR camera can replace the rig pose.

Pointer gestures use CSS pixels. Tile density uses framebuffer pixels. The
movement frame's `viewportHeight` and `focalLengthPixels` describe pointer input;
they are not tile-view inputs. Physical altitude, eye height above terrain,
reference-surface height and distance to the body centre are distinct quantities.

## SkyKit placement

```ts
const unregister = await viewer.addPlugin(createWorldSkykitPlugin({
  world,
  getFrame(frame) {
    return {
      pose: bodyPoseAt(frame), // Complete position, orientation and display radius.
      terrainMultiplier: 1,
    };
  },
  disposeWorld: true,
}));
```

The adapter publishes completed resources before `getFrame()` and calls the
same `updateFromCamera()` operation. It owns no camera or animation loop.

The explicit `world.update(view)` and SkyKit `getView`/`present` path remain
available for hosts with a separately measured view or a diagnostic simulation.
Those hosts own units, projection and frame coherence. `update(view)` cannot
repair an eye height measured before a pose change. In the explicit SkyKit path,
`getView` and `update` run before `present`; do not observe a new pose from that
callback pair. Use `getFrame` when measurement must follow placement.

## Geant frame order

The plugins use SkyKit part priorities. These priorities establish update order
independently of plugin installation order.

The viewer samples simulation time before these parts run. Movement placement
and world presentation use that same sample for body positions and attitudes.
Models that read navigation again for updated location input must retain
`frame.state.time` for ephemerides: `navigation.getSnapshot().time` advances with
the wall clock, so slow frame work would otherwise move the body between the
placement and rendering calculations.

| Priority | Operation |
| --- | --- |
| -200 | Publish completed active-world resources |
| -150 | Select the movement model and process tracking changes |
| -100 | Invoke manual input actions |
| -50 | Apply movement placement and the final camera rig |
| 0 | Apply each complete world pose, measure its view and update its planners |
| Before render | Update resource admission and render visibility from the current eyes |

A host that disables Geant movement supplies placement before world updates.
The world runtime still refreshes XR eyes from that host's final rig. Optional
input and movement features must not become conditions for correct tile density.

## Validate a composition change

Agree the intended behavior and acceptance criteria with the owner before
writing or extending tests. Review visible behavior, quantities, units and
ownership first. The boundary cases below are review candidates; they do not
establish acceptance merely because the implementation or historic demo uses
them.

After that agreement, test the public composition path as well as any changed algorithm. Supply
controlled cameras, source heights and platform fixtures. Check observable
height, location, display radius and selected detail after the first update.

| Change or boundary | Behavior to review |
| --- | --- |
| Scale changes | Current pose and current eye height reach the planner in the same frame |
| Crouching and physical altitude | Both affect measured height through their respective units |
| Desktop zoom and pixel ratio | Detail follows the rendered projection and framebuffer density |
| XR with unequal eye projections or viewport sizes | Detail satisfies the more demanding eye |
| Rig translation or rotation | Eye world matrices retain the final rig transform |
| Sphere and ellipsoid | The same composition works with each body's geometry |
| Surface replacement | Each candidate measures its own ground before readiness and activation |
| Plugin installation order | Declared frame priorities retain the same behavior |

`tests/pas-de-geant-world-view.test.ts` exercises these boundaries without a
browser, network or GPU. The expanded checks from this review are unapproved
drafts pending agreement on the behavior being tested. Component tests remain responsible for source decoding,
tile transitions and geometry. Physical Quest checks establish visual quality
and performance; a passing unit suite does not establish that acceptance.

When moving a capability from an application into a package, identify which
rendering invariants belonged to the application. Transfer their implementation
and behavioral coverage before removing that path. Record intended control or
experience changes separately from rendering invariants. The historic app is a
useful source of evidence; it does not require every experience choice to return.

## Shared panel input

`createGeantPanelPlugin` now mounts a TouchOS UI environment (or borrows a
supplied one). Provide `root`, `action`, `placement`, and optional `inputs`,
`desktop`, `initialize`, and `frame`. The old `createDriver` callback has been
removed. Desktop and spatial views have separate runtime/input state, with
navigation subscriptions publishing the same applied values. `initialize`
allocates view-local assets; `root(snapshot, runtime)` can look them up.

The environment prepares panel transforms, resolves panel and scene ownership,
delivers ordered semantic events, applies synchronous bindings, advances runtime
timing, then renders UI and feedback. It runs at priority 200 after movement
and world placement. Supplying an environment delegates frame scheduling and
input ownership to its host, allowing scene targets and other panels to share
that same context. The plugin owns only its mounted views in that mode.
