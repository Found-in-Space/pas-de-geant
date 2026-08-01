# The Construct: transition architecture

The Construct is a resource-neutral experiment for changing a complete
quadtree tile cut without ever exposing partial coverage. It separates layout
calculation, topology, time/resource ownership, provider behaviour, and
presentation.

## Layer boundaries

### Layout source

A layout source implements:

```ts
interface LayoutSource<Target> {
  calculate(target: Readonly<Target>): readonly TileIdentity[];
}
```

It alone turns a target such as `x/y/z` into a requested quadtree cut. The
interactive Construct composes a `TileOnionLayoutSource`, which converts the
target tile centre to a coordinate and calls the existing provider-independent
balanced tile-onion calculator. This adapter is UI composition code. Tests can
inject finite fixture sources.

Neither the transition planner nor scheduler imports the tile-onion
calculator. Recalculating the requested layout remains outside both modules.

### Stateless transition planner

```ts
planTransition(committedCut, requestedCut): TransitionGraph
```

The planner knows topology only. It accepts any admissible committed cut,
including a hybrid produced by earlier partial commits; the cut need not be a
canonical result for any location. Both inputs must be:

- complete world coverage by whole XYZ leaves;
- non-overlapping, with no active ancestor and descendant;
- 2:1 balanced across every edge and corner;
- cylindrical in longitude (x wraps at the antimeridian);
- clipped in latitude (y never wraps across north/south).

The planner recursively compares both quadtree cuts from `z0`:

1. The same leaf in both cuts is retained.
2. If one side is a leaf and the other is subdivided, that region becomes one
   minimal replacement group.
3. If both sides are subdivided, comparison recurses into their four children.

Each replacement group has `before` leaves held through commit and `after`
leaves required before commit. Both collections cover exactly the group's
quadtree region. Refining an old leaf to a descendant cut and coarsening a
descendant cut to a new leaf are therefore symmetric atomic operations.

Minimal spatial groups are not automatically independently committable. For
each ordered pair of groups, the planner tests the mixed state in which the
first group is requested while the neighbour remains committed. If edge or
diagonal contact would exceed the 2:1 zoom difference, the first depends on the
neighbour. Strongly connected dependency components become one atomic batch;
the remaining component graph is a deterministic DAG. This is the smallest
principled correction for cycles: groups in a dependency cycle cannot be
committed separately without creating an illegal intermediate cut.

The output is deterministic and immutable. The planner does not calculate a
layout, fetch, track readiness, schedule, retry, cancel, own resources, render,
measure time, or cache.

### Stateful scheduler

`TileTransitionScheduler<Target, Resource>` owns:

- the actual committed cut;
- the latest target and requested cut;
- the active transition graph;
- current exact tile requirements;
- requested, in-flight, ready/staged, and failed states;
- committed resource ownership;
- atomic batch execution and replanning.

The committed cut is always visible, complete, non-overlapping, and balanced.
Partially loaded replacements are scheduler state only; they never replace
committed leaves one at a time.

On a target update the scheduler:

1. asks its injected layout source for the newest requested cut;
2. replans from the actual committed (possibly hybrid) cut;
3. retains an exact in-flight or staged requirement still needed by identity;
4. cancels obsolete requested/in-flight work;
5. discards obsolete ready or failed requirements;
6. requests newly required exact identities;
7. commits any dependency-free batch whose complete `after` set is ready.

After every atomic batch swap the scheduler replaces all of that batch's
`before` leaves with all of its `after` leaves, transfers ready resource
ownership, releases the old identities, and replans from the resulting hybrid
cut toward the latest target. A ready independent batch may commit while other
regions are still loading or failed.

Request callbacks are associated with monotonically unique request IDs. A
callback can affect state only when its request still owns the exact current
requirement, so a stale response from a cancelled or superseded request cannot
commit.

### Fake async provider

`FakeTileProvider` implements a generic XYZ request interface. Its explicit
clock produces the observable lifecycle:

```text
request -> in-flight -> response
                     \-> failure
```

Latency and symmetric jitter are deterministic. Failure modes are:

- none;
- transient first attempt (manual retry succeeds);
- persistent exact selected `z/x/y`;
- persistent deterministic rate, hashing identity rather than using random
  sampling.

Cancellation removes a pending request. The provider returns identity tokens,
not imagery, elevation, decoded pixels, meshes, or textures.

### Real image providers

`ConstructImageTileProvider` adapts the configured imagery provider and the
Mapterhorn elevation Cache API loader to the same request protocol. Both return
decoded tile images; elevation remains the encoded Terrarium image rather than
becoming a mesh. Provider maximum zoom resolves to a cropped source ancestor
without capping the requested draw layout. Identical ancestor loads are
coalesced, concurrency matches the production loaders, and decoded source
images remain available for measurable session-memory cache hits.

The scheduler can hydrate an initial committed fallback cut. Hydration changes
only the resource attached to an existing committed identity, never its
topology. A failed hydration therefore appears as an explicit retryable gap;
later replacement batches still wait for every required resource before their
atomic swap.

## Failure and retry semantics

A failed tile leaves its requirement failed and its replacement batch blocked.
Every old leaf for that region remains committed. Other independent,
dependency-free batches can still commit. `retryFailed()` creates new requests
for failed requirements in the current graph.

A permanent failure is not resolved by the planner inventing an ancestor or
fallback layout. If fallback is desired, the layout source must calculate a
different requested cut and the scheduler must receive that new target/layout.

## Notifications

Scheduler subscribers receive immutable snapshots and events for:

- request;
- in-flight;
- response/ready;
- failure;
- cancellation;
- staged-resource discard;
- atomic swap, including batch/group IDs and complete before/after addresses.

Snapshots expose committed and requested cuts, the current transition graph,
and active requirement states. They expose no provider content.

## Resource and cache policy

The scheduler itself has no warm cache. A scheduled resource may exist only
because it is:

- owned by the committed cut;
- actively requested/in flight for the current transition; or
- ready and staged for the current transition.

Exact in-flight or staged continuity across replanning is ownership continuity,
not scheduler caching. The raw provider creates a new request after release.
The real-image adapters deliberately add provider-level source caching so the
Construct can measure coalesced requests, decoded-memory hits, browser HTTP
cache behaviour, and Mapterhorn Cache API hits/writes without changing
scheduler ownership semantics.

## Interactive globe

`/construct/` displays the actual committed cut on a Three.js globe and a
requested outline plus overlays for requested, in-flight, staged, failed, and
just-swapped tiles. Raw mode visualizes topology. Imagery mode renders the
configured photographic tiles, and terrain mode renders the loaded Terrarium
tiles as images so loader behaviour is visible without mesh generation.

Dragging orbits and retargets the centre view; clicking targets the selected
surface tile. Explicit x/y controls wrap x modulo world width and clip y at the
Web Mercator north/south bounds. Z is derived from radial observer height,
latitude, render-buffer focal length, and the configured source-tile edge in
pixels; changing height, tile resolution, or viewport size preserves the exact
underfoot geographic coordinate. Raw-provider controls change deterministic
latency, jitter and failure policy; a shared retry control resubmits current
failed requirements in every mode. Diagnostics expose source loads, cache and
coalescing hits, transfer bytes, average load time, and failures. The event log
remains a projection of scheduler snapshots/events rather than additional
transition state.
