# Pas de Géant architecture

This document describes the package boundaries.
The [movement architecture](../packages/pas-de-geant/docs/movement.md) defines placement, input, and host integration.
The [composition contract](../packages/pas-de-geant/docs/composition.md) defines
rendered-view ownership, units, frame order and behavioral validation.

The prose uses ASD-STE100 controlled English.
API names and the defined software terms are technical nouns.
Code examples retain the syntax of their programming language.

## Package boundaries

| Component | Responsibility |
| --- | --- |
| Worlds | Body geometry, ephemerides, surface data, tile selection, and rendering |
| Navigation state | Locations, physical altitude, observer position, scale, and time |
| Movement model | Movement commands and the relation between the user and the physical system |
| Movement adapter | Tracking input, model selection, model life cycle, and placement output |
| Controls | Device input, conditions, input reset, and action calls |
| Browser | Optional default composition and a local animation loop |
| Integration case | Host policy, model selection, optional tools, and external service configuration |

The world runtime's `updateFromCamera()` applies a complete body pose and
measures its own surface from the rendered camera before tile selection.
Both the normal Geant world plugin and the authored SkyKit `getFrame` path use
this operation. An integration case supplies placement without reproducing
camera projection or eye-height calculations.

Worlds do not select a movement model.
Worlds do not read the navigation label.
Worlds do not change the camera orientation.
The movement adapter supplies one transform for the physical system.
Each body retains its position and attitude within that system.

The navigation label is a host-defined string.
The label can select input bindings.
The label does not identify a factory in a library registry.
The host supplies a model object or a function that selects a model object.

## Coordinate boundary

The physical system uses heliocentric equatorial J2000 coordinates in metres.
The presentation uses room coordinates in metres.
The scale denominator gives the physical metres in one room metre.
One rotation and one translation relate the two systems.

XR tracking retains the headset pose in its reference space.
The rig pose is separate from the headset pose.
The movement adapter changes the rig pose when the model supplies a new pose.
The model does not change headset measurements.

## Host integration

`createGeantViewer()` supplies state, actions, and the SkyKit plugin life cycle.
The viewer installs no movement model.
An explicit host installs worlds, movement, and controls as separate plugins.

`createGeantBrowser()` supplies an optional default composition.
The browser selects the supplied models for its standard labels.
The host can replace that selection through the `movement` option.
The host can supply a different control scheme independently.

The integration workspace consumes public exports only.
The XR case supplies an explicit model selection function.
The case does not implement a second input loop or renderer.

## Source documents

- [Movement architecture and procedures](../packages/pas-de-geant/docs/movement.md)
- [World data and renderer contracts](../packages/pas-de-geant/docs/worlds.md)
- [Rendered-world composition](../packages/pas-de-geant/docs/composition.md)
- [18 October surface composition review](composition-review-20261018.md)
- [Public package API](../packages/pas-de-geant/README.md)
- [Integration procedures](../integration/README.md)
- [ASD-STE100](https://www.asd-ste100.org/)
