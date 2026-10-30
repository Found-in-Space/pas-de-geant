# Surface composition review, 18 October 2026

The standard Earth integration case exposed coarse terrain in Quest VR. The
comparison baseline was the last main demo at `171eb87`. Two regressions were
reproduced with controlled cameras before they were corrected: desktop
projection values were used for XR detail, and scale changes were measured
against the previous body-root scale.

## Evidence and cause

The main demo's `terrainViewMetrics()` used each XR eye's projection matrix and
viewport height. Its presentation path applied body position, orientation and
scale before observing the surface. The initial public worlds plugin in
`9389e6e` reconstructed those responsibilities in a separate implementation. Its
view function used the desktop drawing buffer and `camera.fov` for every mode.
The main demo still ran through its custom `compose` implementation, so it did
not exercise that default worlds-plugin calculation.

The movement extraction at `e99d756` made surface measurement independent of the
navigation label. The world plugin set position and orientation before observing
the surface, while `world.update(view)` applied scale after observation. The API
accepted a measured view and also changed part of the pose used to measure it.
There was no operation that owned the complete ordering requirement.

The existing composition tests checked lifecycle, actions, observer continuity
and cleanup. Geometry and LOD tests supplied already-correct numeric views.
Movement tests checked placement using simulated tracking. These tests did not
verify the projection and height supplied by the assembled composition. The
same desktop-only focal calculation was subsequently copied into the independent
size-comparison case.

This evidence supports an architectural explanation: the extraction preserved
the component algorithms but left rendering invariants to adapter authors.
Documentation described responsibility boundaries and logical frame order, but
the primary APIs and examples still required callers to reconstruct that order.
Review and validation accepted component coverage as evidence for the new path.
The history does not establish an individual author's reasoning.

## Changes

- `WorldRuntime.updateFromCamera()` owns complete pose application, XR rig
  synchronization, source-specific terrain measurement, rendered projection and
  planner input construction. The normal worlds plugin and authored SkyKit
  `getFrame` path use this operation.
- Active and pending surfaces receive the same pose and measure their own
  elevation. The size-comparison case supplies its authored pose through the
  same package path.
- `world.getView()` exposes the actual retained planner inputs. Integration
  snapshots include this view, readiness and tile-control readback.
- Public composition documentation defines units, ownership, frame order,
  construction seeds, the explicit low-level API and migration acceptance.
  Examples use the camera-driven operation.
- Public-path tests cover asymmetric XR eyes, crouching, camera zoom,
  framebuffer density, desktop/XR changes, immediate scale changes on Earth and
  Moon, reversed plugin installation, moved camera rigs and distinct terrain
  sources. Platform services are local fixtures; measurement and planning use
  the package implementation. These expanded tests were written before the
  owner confirmed the acceptance criteria. They remain unapproved drafts and
  must not be treated as an agreed behavior contract. Further test work is
  paused until that agreement.

The rig test also reproduced stale eye matrices when an authored host moved its
rig without Geant movement. The shared operation now refreshes those matrices
itself. An isolated `getFrame` consumer does not depend on the standard movement
plugin for correct observation.

## Future extraction and review

Use the [public composition contract](../packages/pas-de-geant/docs/composition.md)
when changing placement, cameras or tile-view construction. Review the complete
path from a state or tracking change to the measured planner input. A lifecycle
test establishes lifecycle behavior; it does not establish rendered detail.
Agree the intended behavior and acceptance criteria before writing tests.
Preserve a small set of behavioral checks at that boundary instead of copying
the old application or making every old control a compatibility requirement.

These changes address the demonstrated failures and duplicated calculations.
They do not establish physical Quest visual or performance acceptance. That
remains a separate check of the running integration case.
