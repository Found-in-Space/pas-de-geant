# Tile Onion Specification

## Status

This document specifies the standalone tile-onion algorithm and its visual
debugging page. It is intentionally independent of the tile onion calculations
currently used by the main Pas de Géant application.

The interactive implementation is the standalone `/demos/tile-onion.html`
page. It accepts coordinates or clicks on a flat Mercator world and its polar
selection gutters, and exposes maximum zoom, mode, anchor, active zoom counts,
pole lock, and the complete committed XYZ leaf list.

## Purpose

The tile-onion demo makes the established provider-independent tile calculation
visible and testable without involving terrain or imagery providers.

The page contains only:

- a flat Web Mercator world with north and south polar selection gutters; and
- an overlay of the currently calculated tile coverage.

The calculator must not import, call, or otherwise depend on the main
application's terrain or imagery onion planners.

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
- integration with the main application's existing onion implementations; or
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
6. Terrain and imagery would consume the same finest mesh and the same derived
   tile hierarchy. They must not make independent base-tile selections.

The fifth invariant cannot apply in the outermost Web Mercator row, where a
north or south neighbour does not exist, or at zooms too coarse to contain the
required number of distinct tiles. Those cases use the boundary behaviour
specified below.

## Fixed inner mesh

The normal inner mesh is an `8x8` block at the selected finest zoom. The tile
containing the user is constrained to the central `4x4` area:

```text
........
........
..XXXX..
..XXXX..
..XXXX..
..XXXX..
........
........
```

`X` marks every permitted position of the underfoot tile within one anchored
inner mesh. This provides at least two complete finest-resolution tiles in
every cardinal and diagonal direction, exceeding the required one-tile
minimum.

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

The complete plan is an exact quadtree cut constructed from `z0`:

1. Begin with the `z0` root tile.
2. If a tile does not intersect the finest target mesh, keep it as an active
   leaf.
3. If a tile intersects the target and is coarser than the target zoom,
   replace it with its four children.
4. Apply the same rule recursively to the intersecting children.
5. At the target zoom, keep the target tiles as active leaves.

The non-intersecting siblings produced along the refined branches form the
outer coverage. Their count, zooms, and outline depend on the target's exact
position in the global quadtree. They are not repeated `8x8` rings with
centred holes.

This process reaches toward `z0`, but `z0` is not rendered underneath finer
descendants. Once any part of `z0` is refined, its retained descendants and
siblings collectively cover the rest of the Web Mercator surface.

The algorithm uses integer range intersection and parent/child operations. Its
cost is proportional to the emitted plan and its zoom depth, rather than the
number of tiles that exist at the finest zoom.

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

This is an established algorithm reference and is deliberately separate from
The Construct, which remains a place for testing new ideas.

## Acceptance criteria

The experiment is successful when all of the following are demonstrable:

1. At an interior location, the underfoot tile always has complete finest-zoom
   neighbours in all eight directions.
2. During a four-tile anchor change, shared finest tiles retain their identity
   and the committed plan never shows a gap or overlap.
3. The active addresses form a complete non-overlapping quadtree cut of the
   Web Mercator domain.
4. No active plan contains both an ancestor and one of its descendants.
5. Outer coverage changes shape as required by quadtree alignment and is not
   limited to a hardcoded shell count.
6. Crossing the antimeridian does not replace equivalent wrapped coverage or
   produce duplicate addresses.
7. Entering boundary mode preserves a local patch of visible Mercator detail
   without requesting a full latitude row.
8. Approaching or crossing a pole cannot cause rapid anchor or zoom churn.
9. Returning to the Mercator domain produces one staged, atomic transition
   back to normal coverage.
10. The tile-onion calculator has no dependency on the main application's
    existing terrain or imagery onion calculations.

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
