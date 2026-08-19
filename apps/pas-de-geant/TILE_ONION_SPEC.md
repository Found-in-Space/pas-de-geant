# Tile Onion Specification

## Status

This document specifies the provider-independent tile-onion algorithm used by
Pas de Géant and its standalone visual debugging page.

The interactive implementation is the standalone `/demos/tile-onion.html`
page. It accepts coordinates or clicks on a flat Mercator world and its polar
selection gutters, and exposes maximum zoom, mode, the retained anchor,
underfoot row and column, active zoom counts, pole lock, and the complete
committed XYZ leaf list.

## Purpose

The tile-onion demo makes the established provider-independent tile calculation
visible and testable without involving terrain or imagery providers.

The page contains only:

- a flat Web Mercator world with north and south polar selection gutters; and
- an overlay of the currently calculated tile coverage.

The calculator must not import, call, or otherwise depend on a terrain,
imagery, scheduler, or renderer implementation.

## Scope

This algorithm specifies:

- provider-independent Web Mercator XYZ addressing;
- one shared calculation of the finest active tile mesh;
- a fixed inner coverage invariant;
- a dynamic, non-overlapping quadtree cover outside the inner mesh;
- immutable plans and whole-tile atomic transitions;
- antimeridian behaviour; and
- stable behaviour outside the Web Mercator latitude range.

It does not specify:

- terrain or imagery providers;
- network loading, decoding, textures, elevation, or mesh detail;
- a polar data source or a second polar projection;
- application-specific rendering integration; or
- final numerical screen-space LOD and hysteresis thresholds.

## Geographic and geometric models

### Tile coordinates

All calculated addresses use the conventional Web Mercator XYZ hierarchy:

- a tile address is `(z, x, y)`;
- zoom `z` contains `2^z` columns and `2^z` rows;
- `x` increases from west to east and wraps at the antimeridian;
- `y` increases from north to south and does not wrap; and
- the latitude domain ends at approximately `+/-85.05112878 degrees`.

At the same `(z, x, y)`, terrain, imagery, or another payload has the same
geographic footprint. Providers may impose their own zoom range, coverage,
tile size, encoding, and loading rules, but those properties do not participate
in the calculator.

The tile hierarchy is exact. For a tile `(z, x, y)`, its parent is:

```text
(z - 1, floor(x / 2), floor(y / 2))
```

and its four children are the corresponding `2x2` addresses at `z + 1`.

### Earth distance model

The reference display is a flat normalized Web Mercator world. The north and
south polar gutters are coordinate-selection surfaces only; they do not imply
a polar tile projection or coverage beyond the Mercator edges.

Boundary-mode distances are measured over the sea-level WGS 84 ellipsoid,
using:

- semi-major equatorial radius `6378.137 km`;
- semi-minor polar radius `6356.752314245 km`; and
- mean-radius scale reference `6371.0088 km`.

Terrain elevation is not part of this calculation.

## Coverage invariants

Every committed plan must satisfy all of the following:

1. Every valid point in the Web Mercator domain is covered by exactly one
   active tile.
2. Active tiles never overlap geographically.
3. An active tile and any of its ancestors or descendants cannot coexist in
   the same committed plan.
4. Every active address is a complete XYZ tile. Tiles are not clipped to make
   an onion boundary.
5. In normal mode, the tile containing the user has at least one complete tile
   at the same finest zoom in each of the eight neighbouring directions.
6. Each consumer may run the calculator independently with its own finest z
   and provider cap. Terrain owns the mesh cut; imagery maps its independent
   hierarchy to terrain fragments through Web Mercator coordinates.
7. Any two active tiles whose closed footprints touch, including at only a
   corner, differ by at most one zoom level.

The fifth invariant cannot apply in the outermost Web Mercator row, where a
north or south neighbour does not exist, or at zooms too coarse to contain the
required number of distinct tiles. Those cases use the boundary behaviour
specified below.

## Stateful inner mesh

The normal inner mesh is an `8x8` block at the selected finest zoom. The tile
containing the user remains within rows and columns `1` through `6` of the
retained anchor:

```text
........
.XXXXXX.
.XXXXXX.
.XXXXXX.
.XXXXXX.
.XXXXXX.
.XXXXXX.
........
```

`X` marks every permitted position of the underfoot tile within one anchored
inner mesh. Initialization places the observer in a middle row and column
(normally index `3`; edge clamping can select the other retained rows). This
always preserves the required complete finest-resolution neighbour in every
cardinal and diagonal direction.

The anchor is state, not a bucket recalculated independently for each
coordinate. Movement within rows and columns `1` through `6` retains the
anchor and produces the same topology signature. Entering outer column or row
`7` shifts that axis forward by four tiles, placing the underfoot tile at
index `3`. Entering outer column or row `0` shifts that axis backward by four
tiles, placing the underfoot tile at index `4`. A diagonal entry shifts both
axes in the same plan. Moving back after a shift remains inside the new dead
band and must not restore the old anchor.

A jump across multiple boundaries is coalesced directly to one anchor around
the latest underfoot tile. It does not create or replay intermediate plans.
Changing zoom or entering or leaving a planner mode resets and recentres the
normal anchor.

The inner mesh anchor moves on a four-tile cadence. Consecutive horizontal or
vertical anchors therefore share half of their finest tiles. A diagonal move
shares a `4x4` block. Shared addresses retain their identity across plans.

Longitude is kept unwrapped while calculating anchors. It is wrapped into the
valid XYZ range only when emitting an address. Wrapped duplicates are removed,
which is also required when low zooms contain fewer than eight distinct
columns.

## Dynamic outer cover

Only the inner `8x8` mesh has a prescribed rectangular shape. There is no
fixed number or fixed geometry of outer shells.

The complete plan is the least balanced quadtree cut implied by the finest
targets. It is constructed by monotone family and balance closure:

1. Materialize the `z0` root and seed every distinct tile in the finest mesh as
   a minimum required depth.
2. To materialize a tile, first materialize its ancestors. Opening its parent
   always materializes the complete four-child family. A materialized sibling
   is a provisional leaf: it can be opened later, but can never coarsen
   independently of its family.
3. Every newly materialized tile `(z, x, y)` with `z > 0` propagates a balance
   requirement to the aligned tiles at `z - 1` whose closed footprints touch
   it. Along each axis these are the containing coarse coordinate and the
   exterior coarse coordinate on the side faced by the child. Their Cartesian
   product includes cardinal and corner-only neighbours.
4. Coarse `x` coordinates wrap at the antimeridian. Coarse `y` coordinates are
   clipped at the north and south Web Mercator boundaries and never wrap.
   Wrapped aliases, especially at low zoom, are deduplicated.
5. Continue processing newly materialized tiles until no requirement can open
   another parent. The active cut consists of every materialized node whose
   children were never materialized.

Opening a parent is the quadtree equivalent of a mine-sweep operation: if one
part of a `z - 1` tile requires depth `z`, the parent cannot remain active, so
all four of its depth-`z` children are immediately materialized. Propagating
from their exposed boundaries produces whatever `z - 1`, `z - 2`, and further
transition regions the alignment requires. There is no fixed shell count.

The construction is a fixed-point calculation, not first-discovery
finalization. Materialization and opening are monotone and memoized, so the
order in which equivalent requirements arrive does not change the result.
Each operation is forced either by a finest target, complete-family closure,
or the one-level touching constraint. The fixed point is therefore the unique
coarsest cut satisfying those requirements.

Completeness and non-overlap follow because refinement only replaces one leaf
with all four children. Balance follows because a depth-`z` tile materializes
every touching aligned depth-`z - 1` region; a touching leaf at `z - 2` or
coarser would contain one of those materialized regions and therefore could
not remain a leaf.

Tile identities, materialized nodes, opened nodes, and pending work are hashed
and deduplicated. Each node is materialized and processed at most once, so
expected time and memory are proportional to the resulting quadtree. The
algorithm never enumerates the finest-resolution world grid.

## Plan changes and atomicity

A plan is immutable after calculation. Updating coverage creates a complete
next plan and compares it with the committed plan by `(z, x, y)` identity.

- Addresses shared by both plans remain in place.
- Newly required addresses are staged before the plan changes.
- Obsolete addresses remain active until the replacement plan is ready.
- The renderer switches the committed plan as one transaction.
- Parent-to-children refinement commits one parent versus all four children,
  never a partial family.
- Children-to-parent coarsening follows the inverse rule.

Old and new resources may coexist temporarily in memory. This residency
overlap is required for an atomic transition. They must not overlap in the
committed rendered coverage.

The calculator can always produce the desired next plan immediately. A loader
cannot guarantee readiness under unbounded movement or unavailable data; it
must keep the previous committed plan until the required replacement is ready.

The plan signature describes the emitted topology only. Observer coordinates
within a retained anchor are diagnostic state and do not alter that signature.

## Web Mercator boundary mode

### Intent

Moving outside the Web Mercator latitude domain must not discard valid detail
that remains visible inside the domain. It must also not generate a complete
high-zoom latitude row or chase an unstable longitude near a pole.

Boundary mode therefore anchors a local, one-sided finest mesh to the nearest
point on the valid Mercator edge.

### Nearest boundary point

For a position north of the Mercator domain, the boundary latitude is
`+85.05112878 degrees`. South of the domain it is
`-85.05112878 degrees`.

Away from the exact pole, the nearest boundary point is on the same meridian
as the user. It must be calculated from the horizontal direction of the
user's Earth-fixed vector rather than repeatedly converting a nearly vertical
vector to raw longitude.

At an exact pole, every longitude on the boundary is equally near. Boundary
mode resolves this ambiguity by retaining the last stable Earth-fixed boundary
direction. It does not derive a new direction from numerical noise or head
orientation.

### One-sided inner mesh

The northern boundary mesh begins at Web Mercator row `y = 0` and extends
south. The southern boundary mesh ends at row `y = 2^z - 1` and extends north.
Horizontally, it uses the same eight-column width and four-tile anchor cadence
as the normal inner mesh.

When the selected zoom contains fewer than eight distinct rows or columns, the
plan uses all distinct valid tiles and removes wrapped duplicates. At `z0`,
this naturally reduces to the single root tile.

The normal dynamic-quadtree algorithm fills the remainder of the valid
Mercator domain. No tiles are invented beyond the north or south boundary.

### Boundary LOD

The finest boundary zoom is selected from the surface distance between the
user and the nearest Mercator edge, augmenting the provider-independent base
mesh criterion used in normal mode. With the requested maximum zoom otherwise
unchanged, moving farther poleward must never cause the boundary mesh to
refine. It may retain its zoom or coarsen.

Only the local eight-column boundary mesh receives finest detail. The
calculator must never preserve detail by requesting an entire latitude row,
whose size would grow as `2^z`.

Exact screen-space thresholds remain an experiment parameter. Zoom changes
must use hysteresis and immutable plan commits.

### Stability safeguards

Boundary mode uses all of the following safeguards:

1. **Earth-fixed direction:** Track the nearest-edge direction in ECEF space,
   independently of the camera's gaze.
2. **Unwrapped horizontal anchor:** Preserve longitude continuity across the
   antimeridian and wrap only emitted addresses.
3. **Four-tile cadence:** Change the horizontal inner-mesh anchor only after
   crossing the next anchored region.
4. **Anchor hysteresis:** Do not switch back and forth at an anchor boundary.
5. **Zoom hysteresis:** Do not switch back and forth at a boundary LOD
   threshold.
6. **Monotonic poleward LOD:** Increasing distance outside the Mercator domain
   cannot increase the selected zoom.
7. **Pole direction lock:** When the horizontal Earth-fixed direction is too
   small to identify a stable meridian at the selected tile resolution, retain
   the last stable direction. Release it only after crossing a wider exit
   threshold.
8. **Atomic plan replacement:** Direction, anchor, or zoom changes become
   visible only after their complete next plan is ready.

The lock and hysteresis thresholds must be derived from the active tile
footprint or screen-space criterion. They are not arbitrary provider limits.

### Entering and leaving boundary mode

Boundary mode begins when the normal inner coverage can no longer provide a
complete finest-resolution neighbour in the poleward direction. This includes
the outermost tile row and positions beyond the formal Mercator latitude
limit.

Normal mode resumes only after the user has returned far enough inside the
domain to restore the neighbour ring plus one additional finest-tile row. The
extra row is transition hysteresis. The replacement normal plan is calculated
and committed atomically.

## Demo presentation

The standalone demo must visualize the committed plan, not partially staged
work. It shows the full Web Mercator domain as a flat rectangle so the complete
tile layout, boundaries, and differing zoom levels can be inspected without
loading provider imagery or terrain.

North and south polar gutters extend the selectable latitude range to the
poles but have no invented XYZ coverage. In boundary mode, a selected polar
position is connected to its stable nearest-edge anchor while detailed tiles
remain inside the valid Mercator region.

This page is a visual reference for the same generic calculator consumed by
the production surface library.

## Acceptance criteria

The experiment is successful when all of the following are demonstrable:

1. At an interior location, the underfoot tile always has complete finest-zoom
   neighbours in all eight directions.
2. During a four-tile anchor change, shared finest tiles retain their identity
   and the committed plan never shows a gap or overlap.
3. The active addresses form a complete non-overlapping quadtree cut of the
   Web Mercator domain.
4. No active plan contains both an ancestor and one of its descendants.
5. Every edge- or corner-touching pair of active tiles differs by at most one
   zoom level, including pairs that touch across the antimeridian.
6. Outer coverage changes shape as required by quadtree alignment and is not
   limited to a hardcoded shell count.
7. Crossing the antimeridian does not replace equivalent wrapped coverage or
   produce duplicate addresses.
8. Balance propagation stops at the north and south Web Mercator boundaries;
   those edges are never treated as neighbours.
9. Entering boundary mode preserves a local patch of visible Mercator detail
   without requesting a full latitude row.
10. Approaching or crossing a pole cannot cause rapid anchor or zoom churn.
11. Returning to the Mercator domain produces one staged, atomic transition
   back to normal coverage.
12. The tile-onion calculator has no dependency on terrain or imagery
    providers, transition scheduling, or rendering.

## Parameters still to determine experimentally

The structural algorithm above is fixed. The standalone demo is intended to reveal
appropriate values for:

- the normal screen-space criterion used to select the finest zoom;
- the boundary-distance screen-space criterion;
- refine and coarsen hysteresis thresholds;
- anchor hysteresis thresholds;
- the resolution-dependent pole direction lock threshold; and
- the visual treatment used to distinguish active zoom levels.

These parameters may be tuned without changing the coverage invariants or the
quadtree algorithm.
