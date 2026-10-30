# Movement architecture

This document defines the movement contract and the host integration procedures.
The prose uses ASD-STE100 controlled English.
API names and the terms in the table below are technical nouns.

## Terms

| Term | Meaning |
| --- | --- |
| Movement model | An object that accepts movement commands and calculates placement |
| Placement | The transform from the physical system to the room, with an optional rig pose |
| Movement adapter | The plugin that connects a model to tracking, actions, and world presentation |
| Rig | The parent coordinate system of the camera and the tracked user |
| Tracking pose | The measured headset position and orientation in the XR reference space |
| Contact | A body location and its transported tangent frame |
| Tangent plane | The plane perpendicular to the reference surface normal at a contact |
| Observation anchor | The position and orientation of the observed contact in the room |
| Reference surface | The sphere or ellipsoid specified by the body model |
| Navigation label | A host-defined string that can select input bindings and host behavior |

## Independence and selection

The library supplies surface, observation, ship, and desktop models.
These models are optional implementations of `GeantMovementModel`.
The interface does not contain a list of model types.
An application can supply another object without a library change.

The world renderer does not contain movement policy.
The system transform is the world's only movement input.
Body geometry remains available through a separate surface adapter.
A host can supply that adapter without constructing a world renderer.

A viewer uses one movement adapter to apply its final placement.
This rule prevents two components from writing conflicting transforms.
The rule does not restrict the available models or other viewers.
A custom model can combine several calculations before it returns one placement.

The host selects objects through `model` or `setModel()`.
The host can supply a selection function instead of one object.
The function returns an existing object for each frame.
The function does not construct a new stateful model on each call.
Each viewer has its own stateful model instances.

`mode` stores an unrestricted navigation label.
`geant:navigation.setMode` changes that label.
The label does not select behavior inside the viewer, movement adapter, or worlds.
The host selection function can use the label, the XR state, or another application condition.

## Model contract

| Member | Contract |
| --- | --- |
| `id` | An identifier for the model object |
| `enter(frame)` | Optional synchronous initialization when selection, focus, or tracking context changes |
| `leave(frame)` | Optional synchronous cleanup before replacement or adapter removal |
| `update(frame)` | A synchronous calculation that returns `GeantPlacement` |
| `command(action, payload, frame)` | Optional command processing for semantic actions |

The adapter does not own the model object after removal.
`leave()` releases active model resources.
The host retains the object and can select the object again.

`GeantMovementFrame` supplies a state snapshot and the navigation API.
The frame also supplies tracking, the rig pose, elapsed frame time, and the preceding physical observer position.
`previousSystemRotation` supplies the preceding transform rotation.
The frame does not supply a renderer or a world scene root.
`surface(body)` supplies body geometry and an elevation query.
`invoke()` calls the public action registry and reports rejected action results.

Manual commands use `invoke()` for canonical navigation changes.
This route preserves host action adapters.
Tracked walking can update a contact directly during the model update.
Input handlers do not write camera poses or world transforms.

`GeantPlacement` supplies these fields:

| Field | Units or meaning |
| --- | --- |
| `originJ2000M` | Physical origin in heliocentric J2000 metres |
| `systemRotation` | Rotation from the rendered J2000 axes to the room axes |
| `translation` | System translation in room metres |
| `rig` | Optional rig position in room metres and rig orientation |
| `desktopPosition` | Optional desktop camera position in room metres |
| `desktopOrientation` | Optional desktop camera orientation |

The transform applies in this order:

```text
room position = systemRotation * J2000ToYUp(physical position - originJ2000M)
                / scaleDenominator + translation
```

The desktop fields do not apply during an XR session.
The XR runtime retains control of the headset pose.
The adapter calculates the physical eye position from tracking and the final placement.
Star presentation uses that same physical eye position.

## Surface model

`createGeantSurfaceMovementModel()` places the contact below the user's floor anchor.
Tracked horizontal movement transports the contact across the body.
Head height remains independent of the floor anchor.
Crouching does not change physical altitude.

`heightReference: "terrain"` uses the available elevation at the contact.
The default value is `"terrain"`.
`heightReference: "reference"` uses the body's reference surface.
Neither choice changes the displayed terrain multiplier.
The surface normal defines local up, regardless of terrain slope.

The stored `altitudeM` adds a physical offset above the selected height reference.
The offset applies along the reference normal.
The offset does not change scale.
For an ellipsoid, the reference normal can differ from the direction to the centre.
The reference surface does not necessarily represent sea level or solid ground.

`geant:navigation.setAltitude` accepts `altitudeM` and an optional selected `body`.
`geant:navigation.adjustAltitude` accepts `value` and `deltaSeconds`.
The default adjustment rate is 0.5 room metres per second, converted to physical metres.
`altitudeSpeedMPerSecond` supplies an explicit physical rate instead.

The model supports every registered body with reference geometry.
Measured terrain is optional.
The model does not require an imagery source.
At scale 1:50, a physical altitude of 100 m produces a room offset of 2 m.

Model entry uses the stored location and altitude by default.
`retainObserverOnEntry: true` reconstructs a contact from the preceding physical eye position after a model selection change.
This option can change both location and altitude.
The desktop model uses this option to retain its existing transition behavior.

## Observation model

`createGeantObservationMovementModel()` presents the tangent plane as an upright map.
On entry, the model captures the eye position and horizontal facing.
The default contact position is two room metres ahead at eye height.
Head pitch and roll do not tilt the default plane.

The surface normal points toward the initial observing position.
The plane remains fixed when the user walks, leans, or turns their head.
The model does not continuously align the plane with the current head position.
Available terrain supplies the default ground height, matching surface mode.
`heightReference: "reference"` explicitly uses the reference surface instead.

The movement command changes the contact on the body.
Right input moves east in the transported contact frame.
Forward input moves north, toward the top of the map.
At zero altitude the selected ground contact lies at the observation anchor.
Positive physical altitude moves the ground behind that anchor along its normal.
Current head direction does not change this input frame.

The altitude command changes physical altitude above planetary ground, matching
surface mode. The default rate is 0.5 room metres per second converted through
the current scale. Decreasing altitude brings the ground closer along the
observation normal; increasing it moves the ground farther away. The observation
anchor, contact latitude/longitude, scale and headset pose remain fixed.

`getAnchor()` returns a copy of the current anchor, or `null` before initial placement.
`setAnchor(pose)` supplies an application-defined position and orientation.
Local +Z is the outward surface normal.
Local +Y is the top of the map.
An explicit anchor persists across model entry and tracking context changes.

`geant:navigation.recenter` captures a new default observing position.
Automatic placement also runs on entry and after a reference-space reset.
There is no standard binding for plane orientation or recentering.
An application can supply those controls through its own actions or user interface.

## Ship model

`createGeantShipMovementModel()` uses an independent ship orientation.
Travel follows the ship's forward and right axes.
Head rotation and physical movement do not steer the ship.
The user can look around while the ship continues in its selected direction.

The model accepts direct translation, yaw, pitch, and roll commands.
The controls follow the SkyKit XR free-roam convention.
An explicit speed uses room metres per second.
The default speed depends on the displayed body radius and focus distance.
The default boost multiplier is four.

Entry from another model retains the preceding physical eye position.
The ship orientation also retains the preceding physical viewing direction.
Headset motion remains local to the ship rig.
The model does not simulate thrust, inertia, or a physical orbit.
An application can supply another model for those behaviors.

## Controls and desktop policy

The control scheme and the movement model are separate objects.
`createGeantControlsPlugin()` invokes semantic actions.
`GEANT_MOTION_ACTIONS` defines the supplied movement command names.
A custom plugin can register additional actions through SkyKit.

| Input | Surface and observation | Ship |
| --- | --- | --- |
| Left stick | Contact travel | Pitch and yaw |
| Left grip | Faster contact travel | Roll modifier |
| Right stick | Horizontal snap turn and vertical altitude above ground | Forward, backward, and sideways travel |
| Right grip | No standard command | Faster ship travel |

The default snap angle is 30 degrees.
A snap requires a new stick deflection after neutral.
A diagonal surface gesture selects one right-stick function until both axes return to neutral.
The standard XR bindings do not change scale.
Applications can replace the bindings and provide another turn method.

Input resets after model, label, focus, scheme, session, or controller changes.
The user releases held inputs before a new interaction.
Reference-space resets do not count as walking.
The surface model also discards walking deltas during tracking loss.

`createGeantDesktopMovementModel()` retains separate desktop behavior.
Desktop orbit uses a body-centred observer and distance controls. Its observer
follows the focused body’s ephemeris translation during playback and UTC seeks,
preserving the current orbital offset. Free flight retains inertial placement.
Desktop free travel follows the view direction.
The desktop model does not run in an immersive session.

The browser preset maps these labels:

| Label | XR model | Desktop behavior |
| --- | --- | --- |
| `surface` | Surface | Surface |
| `observation` or `orbit` | Observation | Body-centred orbit |
| `ship` or `free` | Ship | View-directed free travel |

These aliases belong to the optional browser preset.
The core interfaces accept other labels.
`controls: false` removes manual input but retains movement placement and tracking.
`movement: false` omits the browser's movement adapter.
An authored `compose()` function owns the installation of all three plugins.

## Integration procedure

1. Create one instance of each required model.
2. Install the world plugin.
3. Install the movement adapter with the host selection function.
4. Install one controls plugin with the required bindings.
5. Call the viewer update and render methods from the host scheduler.

```ts
import {
  createGeantViewer, createGeantWorldsPlugin, createGeantMovementPlugin,
  createGeantSurfaceMovementModel, createGeantObservationMovementModel,
  createGeantShipMovementModel, createGeantDesktopMovementModel,
  createGeantControlsPlugin,
} from "@found-in-space/pas-de-geant";

const surface = createGeantSurfaceMovementModel({ heightReference: "terrain" });
const observation = createGeantObservationMovementModel({ distanceRoomM: 2 });
const ship = createGeantShipMovementModel({ speedRoomMPerSecond: 2 });
const desktop = createGeantDesktopMovementModel();
const viewer = await createGeantViewer({ renderer, bodies: ["moon", "mars"] });
await viewer.install(createGeantWorldsPlugin());
const movement = createGeantMovementPlugin({ model(frame) {
  if (!frame.xr) return desktop;
  if (frame.state.mode === "surface") return surface;
  if (frame.state.mode === "observation") return observation;
  return ship;
} });
await viewer.install(movement);
await viewer.install(createGeantControlsPlugin());
```

The host can replace the entire selection function with one model:

```ts
movement.setModel(observation);
observation.setAnchor({ position: mapPosition, orientation: mapOrientation });
```

The browser accepts the same selection through its `movement` option.
The XR integration case shows this public API in use.

## Custom model procedure

1. Supply an object that implements `GeantMovementModel`.
2. Return the final physical-to-room transform from `update()`.
3. Process the required semantic actions in `command()`.
4. Supply a control scheme for any application-specific navigation labels.
5. Release active resources in `leave()`.

This example keeps the system at an application-defined position:

```ts
import { Quaternion, Vector3 } from "three";
import type { GeantMovementModel } from "@found-in-space/pas-de-geant";

const exhibit: GeantMovementModel = {
  id: "exhibit:fixed-system",
  update() {
    return {
      originJ2000M: { x: 0, y: 0, z: 0 },
      systemRotation: new Quaternion(),
      translation: new Vector3(0, 1, -3),
    };
  },
};
movement.setModel(exhibit);
```

This example needs no library mode registration.
A model without `command()` rejects manual movement commands.
The host can disable manual controls or supply bindings for other actions.

## Frame order and acceptance

The world plugin publishes completed terrain data before movement selection.
Model selection precedes input processing.
Movement placement follows input processing.
World transforms and surface queries follow placement.
The XR adapter updates eye matrices before world surface queries.
World roots apply their current position, orientation and scale before measuring
eye height for tile selection. Tile detail uses the rendered projection matrix
and drawing-buffer height on desktop, or the greatest focal length from the XR
eye projections and their individual viewport heights.
The world runtime owns this sequence through `updateFromCamera()`. Authored
hosts use the same operation directly or through the SkyKit adapter's
`getFrame`. See the [composition contract](composition.md) for ownership,
pixel units, diagnostics and boundary validation.

The adapter calls `leave()` and removes its frame parts on uninstall.
The adapter restores the preceding rig and presentation state.
Model removal does not dispose borrowed renderer resources.

Unit tests cover coordinate transforms, height references, walking, stable observation placement, ship direction, custom models, and input reset.
These tests use local geometry and simulated tracking.
Physical headset acceptance remains a separate procedure.

The host controls transition presentation and comfort settings.
Terrain publication and model changes can change the apparent user position.
Headset checks include those changes, different eye heights, and seated use.
The supplied ship controls include continuous pitch and roll.
Those controls do not establish comfort for every user.
