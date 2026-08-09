/** A whole XYZ tile. The planner assigns no meaning to its contents. */
export interface TileIdentity {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

export interface ReplacementGroup {
  /** Stable identifier for the smallest quadtree region changed as one unit. */
  readonly id: string;
  /** The spatial region covered exactly by both `before` and `after`. */
  readonly region: TileIdentity;
  /** Committed leaves held until this group commits. */
  readonly before: readonly TileIdentity[];
  /** Requested leaves that must all be ready before this group commits. */
  readonly after: readonly TileIdentity[];
}

export interface TransitionBatch {
  /** Stable identifier derived from the batch's sorted group identifiers. */
  readonly id: string;
  /** Groups that must commit together to preserve an admissible cut. */
  readonly groupIds: readonly string[];
  /** Batches that must have committed before this batch is safe. */
  readonly dependsOn: readonly string[];
}

export interface TransitionGraph {
  readonly retained: readonly TileIdentity[];
  readonly groups: readonly ReplacementGroup[];
  readonly batches: readonly TransitionBatch[];
}

interface QuadNode {
  readonly address: TileIdentity;
  leaf?: TileIdentity;
  readonly children: Map<number, QuadNode>;
}

export function tileIdentityKey(identity: TileIdentity): string {
  return `${identity.z}/${identity.x}/${identity.y}`;
}

export function compareTileIdentities(
  first: TileIdentity,
  second: TileIdentity,
): number {
  return first.z - second.z || first.y - second.y || first.x - second.x;
}

function copyIdentity(identity: TileIdentity): TileIdentity {
  return Object.freeze({ z: identity.z, x: identity.x, y: identity.y });
}

function sortedFrozen(
  identities: Iterable<TileIdentity>,
): readonly TileIdentity[] {
  return Object.freeze([...identities].sort(compareTileIdentities));
}

function assertValidAddress(identity: TileIdentity): void {
  const width = 2 ** identity.z;
  if (
    !Number.isSafeInteger(identity.z) ||
    identity.z < 0 ||
    !Number.isSafeInteger(identity.x) ||
    !Number.isSafeInteger(identity.y) ||
    identity.x < 0 ||
    identity.y < 0 ||
    identity.x >= width ||
    identity.y >= width
  ) {
    throw new Error(`Invalid XYZ tile identity ${tileIdentityKey(identity)}.`);
  }
}

function childIndexFor(identity: TileIdentity, depth: number): number {
  const divisor = 2 ** (identity.z - depth - 1);
  const xBit = Math.floor(identity.x / divisor) % 2;
  const yBit = Math.floor(identity.y / divisor) % 2;
  return yBit * 2 + xBit;
}

function childAddress(parent: TileIdentity, index: number): TileIdentity {
  return {
    z: parent.z + 1,
    x: parent.x * 2 + index % 2,
    y: parent.y * 2 + Math.floor(index / 2),
  };
}

function buildCut(layout: Iterable<TileIdentity>, name: string): QuadNode {
  const root: QuadNode = {
    address: { z: 0, x: 0, y: 0 },
    children: new Map(),
  };
  const seen = new Set<string>();

  for (const sourceIdentity of layout) {
    assertValidAddress(sourceIdentity);
    const identity = copyIdentity(sourceIdentity);
    const key = tileIdentityKey(identity);
    if (seen.has(key)) continue;
    seen.add(key);

    let node = root;
    for (let depth = 0; depth < identity.z; depth += 1) {
      if (node.leaf) {
        throw new Error(
          `${name} overlaps ancestor ${tileIdentityKey(node.leaf)}.`,
        );
      }
      const index = childIndexFor(identity, depth);
      let child = node.children.get(index);
      if (!child) {
        child = {
          address: childAddress(node.address, index),
          children: new Map(),
        };
        node.children.set(index, child);
      }
      node = child;
    }
    if (node.children.size > 0) {
      throw new Error(`${name} overlaps descendants of ${key}.`);
    }
    node.leaf = identity;
  }

  const assertComplete = (node: QuadNode): void => {
    if (node.leaf) return;
    if (node.children.size !== 4) {
      throw new Error(
        `${name} does not completely cover region ${tileIdentityKey(node.address)}.`,
      );
    }
    for (let index = 0; index < 4; index += 1) {
      assertComplete(node.children.get(index)!);
    }
  };
  assertComplete(root);
  return root;
}

function collectLeaves(node: QuadNode, destination: TileIdentity[]): void {
  if (node.leaf) {
    destination.push(node.leaf);
    return;
  }
  for (let index = 0; index < 4; index += 1) {
    collectLeaves(node.children.get(index)!, destination);
  }
}

/**
 * Returns whether two closed tile regions touch by an edge or corner.
 * Longitude wraps at the antimeridian. Latitude is clipped and never wraps.
 */
export function tilesTouch(
  first: TileIdentity,
  second: TileIdentity,
): boolean {
  const commonZoom = Math.max(first.z, second.z);
  const worldWidth = 2 ** commonZoom;
  const firstScale = 2 ** (commonZoom - first.z);
  const secondScale = 2 ** (commonZoom - second.z);
  const firstWest = first.x * firstScale;
  const firstEast = (first.x + 1) * firstScale;
  const firstNorth = first.y * firstScale;
  const firstSouth = (first.y + 1) * firstScale;
  const secondWest = second.x * secondScale;
  const secondEast = (second.x + 1) * secondScale;
  const secondNorth = second.y * secondScale;
  const secondSouth = (second.y + 1) * secondScale;

  if (firstNorth > secondSouth || secondNorth > firstSouth) return false;
  return [-worldWidth, 0, worldWidth].some(
    (offset) =>
      firstWest <= secondEast + offset &&
      secondWest + offset <= firstEast,
  );
}

export function assertAdmissibleCut(
  layout: Iterable<TileIdentity>,
  name = "Tile cut",
): void {
  const identities = [...layout];
  buildCut(identities, name);
  for (let firstIndex = 0; firstIndex < identities.length; firstIndex += 1) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < identities.length;
      secondIndex += 1
    ) {
      const first = identities[firstIndex]!;
      const second = identities[secondIndex]!;
      if (
        tileIdentityKey(first) !== tileIdentityKey(second) &&
        tilesTouch(first, second) &&
        Math.abs(first.z - second.z) > 1
      ) {
        throw new Error(
          `${name} is not 2:1 balanced: ${tileIdentityKey(first)} touches ${tileIdentityKey(second)}.`,
        );
      }
    }
  }
}

function freezesGroup(
  region: TileIdentity,
  before: TileIdentity[],
  after: TileIdentity[],
): ReplacementGroup {
  return Object.freeze({
    id: `group:${tileIdentityKey(region)}`,
    region: copyIdentity(region),
    before: sortedFrozen(before),
    after: sortedFrozen(after),
  });
}

function mixedBoundaryIsUnsafe(
  committed: readonly TileIdentity[],
  requested: readonly TileIdentity[],
): boolean {
  return requested.some((after) =>
    committed.some(
      (before) =>
        tilesTouch(after, before) && Math.abs(after.z - before.z) > 1,
    ),
  );
}

function stronglyConnectedComponents(
  groups: readonly ReplacementGroup[],
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
): readonly (readonly string[])[] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (id: string): void => {
    const index = nextIndex;
    nextIndex += 1;
    indices.set(id, index);
    lowLinks.set(id, index);
    stack.push(id);
    onStack.add(id);

    for (const dependency of dependencies.get(id) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency);
        lowLinks.set(
          id,
          Math.min(lowLinks.get(id)!, lowLinks.get(dependency)!),
        );
      } else if (onStack.has(dependency)) {
        lowLinks.set(
          id,
          Math.min(lowLinks.get(id)!, indices.get(dependency)!),
        );
      }
    }

    if (lowLinks.get(id) !== indices.get(id)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    component.sort();
    components.push(component);
  };

  for (const group of groups) {
    if (!indices.has(group.id)) visit(group.id);
  }
  return components;
}

function buildBatches(
  groups: readonly ReplacementGroup[],
): readonly TransitionBatch[] {
  const dependencies = new Map<string, Set<string>>(
    groups.map((group) => [group.id, new Set<string>()]),
  );

  for (const group of groups) {
    for (const neighbour of groups) {
      if (group === neighbour) continue;
      // If `group` changed while `neighbour` remained committed, the mixed cut
      // would be illegal. The neighbour must therefore precede it or share its
      // atomic batch.
      if (mixedBoundaryIsUnsafe(neighbour.before, group.after)) {
        dependencies.get(group.id)!.add(neighbour.id);
      }
    }
  }

  const components = stronglyConnectedComponents(groups, dependencies);
  const componentByGroup = new Map<string, number>();
  components.forEach((component, index) => {
    for (const groupId of component) componentByGroup.set(groupId, index);
  });
  const batchId = (component: readonly string[]): string =>
    `batch:${component.join("+")}`;

  const batches = components.map((component, componentIndex) => {
    const batchDependencies = new Set<string>();
    for (const groupId of component) {
      for (const dependency of dependencies.get(groupId) ?? []) {
        const dependencyComponent = componentByGroup.get(dependency)!;
        if (dependencyComponent !== componentIndex) {
          batchDependencies.add(batchId(components[dependencyComponent]!));
        }
      }
    }
    return Object.freeze({
      id: batchId(component),
      groupIds: Object.freeze([...component]),
      dependsOn: Object.freeze([...batchDependencies].sort()),
    });
  });
  return Object.freeze(batches.sort((first, second) => first.id.localeCompare(second.id)));
}

/**
 * Computes a deterministic topology-only transition graph.
 *
 * Both inputs may be canonical tiler output or admissible hybrid cuts created
 * by earlier partial commits. The function owns no time or resource state.
 */
export function planTransition(
  committedCut: Iterable<TileIdentity>,
  requestedCut: Iterable<TileIdentity>,
): TransitionGraph {
  const committed = [...committedCut];
  const requested = [...requestedCut];
  assertAdmissibleCut(committed, "Committed cut");
  assertAdmissibleCut(requested, "Requested cut");
  const committedRoot = buildCut(committed, "Committed cut");
  const requestedRoot = buildCut(requested, "Requested cut");
  const retained: TileIdentity[] = [];
  const groups: ReplacementGroup[] = [];

  const compareNodes = (before: QuadNode, after: QuadNode): void => {
    if (before.leaf && after.leaf) {
      retained.push(after.leaf);
      return;
    }
    if (before.leaf || after.leaf) {
      const beforeLeaves: TileIdentity[] = [];
      const afterLeaves: TileIdentity[] = [];
      collectLeaves(before, beforeLeaves);
      collectLeaves(after, afterLeaves);
      groups.push(freezesGroup(before.address, beforeLeaves, afterLeaves));
      return;
    }
    for (let index = 0; index < 4; index += 1) {
      compareNodes(before.children.get(index)!, after.children.get(index)!);
    }
  };
  compareNodes(committedRoot, requestedRoot);
  groups.sort((first, second) =>
    compareTileIdentities(first.region, second.region),
  );

  return Object.freeze({
    retained: sortedFrozen(retained),
    groups: Object.freeze(groups),
    batches: buildBatches(groups),
  });
}
