import type { TileIdentity } from "./tile-transition-planner.js";

export const BLUE_MARBLE_IMAGERY_KEY = "";

export interface ImageryImageNode {
  readonly image: string;
}

export interface ImageryChildrenNode {
  readonly children: readonly [
    ImageryTreeNode,
    ImageryTreeNode,
    ImageryTreeNode,
    ImageryTreeNode,
  ];
}

export type ImageryTreeNode = ImageryImageNode | ImageryChildrenNode;

export interface DesiredImageryLeaf {
  readonly image: string;
  readonly fallbackFromNotFound: boolean;
}

export interface DesiredImageryChildren {
  readonly children: readonly [
    DesiredImageryTree,
    DesiredImageryTree,
    DesiredImageryTree,
    DesiredImageryTree,
  ];
}

export type DesiredImageryTree = DesiredImageryLeaf | DesiredImageryChildren;

export interface ImageryTreeReconcileOptions {
  isResident(image: string): boolean;
  sourceZoom(image: string): number;
  imageNode(image: string): ImageryImageNode;
}

export interface ImageryGpuReference {
  readonly poolGeneration: number;
  readonly layer: number;
  readonly revision: number;
  readonly sourceTile: TileIdentity;
}

export interface EncodedImageryTree {
  readonly nodeData: Uint32Array;
  readonly imageData: Uint32Array;
  readonly nodeCount: number;
  readonly imageCount: number;
  readonly maximumDepth: number;
  readonly poolGeneration: number;
  readonly sourceKeys: ReadonlySet<string>;
}

export const BLUE_MARBLE_IMAGERY_NODE: ImageryImageNode = Object.freeze({
  image: BLUE_MARBLE_IMAGERY_KEY,
});

interface MutableDesiredNode {
  leaf?: DesiredImageryLeaf;
  children?: [
    MutableDesiredNode | undefined,
    MutableDesiredNode | undefined,
    MutableDesiredNode | undefined,
    MutableDesiredNode | undefined,
  ];
}

export function buildDesiredImageryTree(
  cut: readonly TileIdentity[],
  resolve: (tile: TileIdentity) => DesiredImageryLeaf,
): DesiredImageryTree {
  const root: MutableDesiredNode = {};
  for (const tile of cut) {
    let node = root;
    for (let depth = 0; depth < tile.z; depth += 1) {
      if (node.leaf) {
        throw new Error("The imagery cut contains an ancestor and descendant.");
      }
      node.children ??= [undefined, undefined, undefined, undefined];
      const shift = tile.z - depth - 1;
      const xBit = Math.floor(tile.x / 2 ** shift) % 2;
      const yBit = Math.floor(tile.y / 2 ** shift) % 2;
      const quadrant = yBit * 2 + xBit;
      node.children[quadrant] ??= {};
      node = node.children[quadrant]!;
    }
    if (node.children) {
      throw new Error("The imagery cut contains a descendant and ancestor.");
    }
    if (node.leaf) {
      throw new Error("The imagery cut contains a duplicate leaf.");
    }
    node.leaf = Object.freeze({ ...resolve(tile) });
  }
  return finalizeDesired(root, cut.length === 0);
}

function finalizeDesired(
  node: MutableDesiredNode,
  allowEmpty = false,
): DesiredImageryTree {
  if (node.leaf) return node.leaf;
  if (!node.children) {
    if (!allowEmpty) {
      throw new Error("The imagery cut does not cover the complete globe.");
    }
    return Object.freeze({
      image: BLUE_MARBLE_IMAGERY_KEY,
      fallbackFromNotFound: false,
    });
  }
  if (node.children.some((child) => child === undefined)) {
    throw new Error("The imagery cut does not cover the complete globe.");
  }
  return Object.freeze({
    children: Object.freeze(
      node.children.map((child) => finalizeDesired(child!)),
    ) as unknown as DesiredImageryChildren["children"],
  });
}

export function reconcileImageryTree(
  committed: ImageryTreeNode,
  desired: DesiredImageryTree,
  options: ImageryTreeReconcileOptions,
): ImageryTreeNode {
  const satisfiesLeaf = (
    current: ImageryTreeNode,
    leaf: DesiredImageryLeaf,
  ): boolean => {
    if (isImage(current)) {
      if (leaf.image === BLUE_MARBLE_IMAGERY_KEY) return true;
      return current.image !== BLUE_MARBLE_IMAGERY_KEY &&
        options.sourceZoom(current.image) >= options.sourceZoom(leaf.image);
    }
    return current.children.every((child) => satisfiesLeaf(child, leaf));
  };

  const ready = (
    current: ImageryTreeNode,
    next: DesiredImageryTree,
  ): boolean => {
    if (isDesiredLeaf(next)) {
      return satisfiesLeaf(current, next) ||
        options.isResident(next.image);
    }
    if (isImage(current)) {
      return next.children.every((child) => ready(current, child));
    }
    return next.children.every((child, index) =>
      ready(current.children[index]!, child),
    );
  };

  const merge = (
    current: ImageryTreeNode,
    next: DesiredImageryTree,
  ): ImageryTreeNode => {
    if (isDesiredLeaf(next)) {
      return mergeLeaf(current, next);
    }
    if (isImage(current)) {
      if (!ready(current, next)) return current;
      return Object.freeze({
        children: Object.freeze(
          next.children.map((child) => merge(current, child)),
        ) as unknown as ImageryChildrenNode["children"],
      });
    }
    const children = next.children.map((child, index) =>
      merge(current.children[index]!, child),
    ) as unknown as ImageryChildrenNode["children"];
    return children.every((child, index) => child === current.children[index])
      ? current
      : Object.freeze({ children: Object.freeze(children) });
  };

  const mergeLeaf = (
    current: ImageryTreeNode,
    next: DesiredImageryLeaf,
  ): ImageryTreeNode => {
    // The planner owns active detail. Keep existing photography only while its
    // exact planned replacement is unavailable or represents a missing-tile
    // fallback; once a normal replacement is resident, coarsening must collapse
    // the old fine subtree instead of leaving it active indefinitely.
    if (
      next.image === BLUE_MARBLE_IMAGERY_KEY ||
      next.fallbackFromNotFound ||
      !options.isResident(next.image)
    ) return current;
    const replacement = options.imageNode(next.image);
    return isImage(current) && current.image === replacement.image
      ? current
      : replacement;
  };

  return merge(committed, desired);
}

export function imageryTreeSourceKeys(root: ImageryTreeNode): Set<string> {
  const result = new Set<string>();
  visitImageryTree(root, (node) => {
    if (isImage(node) && node.image !== BLUE_MARBLE_IMAGERY_KEY) {
      result.add(node.image);
    }
  });
  return result;
}

export function imageryTreeNodeCount(root: ImageryTreeNode): number {
  let count = 0;
  visitImageryTree(root, () => {
    count += 1;
  });
  return count;
}

export function imageryTreeMaximumDepth(root: ImageryTreeNode): number {
  if (isImage(root)) return 0;
  return 1 + Math.max(...root.children.map(imageryTreeMaximumDepth));
}

export function imageryTreeImageAtGlobalUv(
  root: ImageryTreeNode,
  u: number,
  v: number,
): string {
  let node = root;
  let localX = ((u % 1) + 1) % 1;
  let localY = Math.max(0, Math.min(1 - Number.EPSILON, v));
  while (!isImage(node)) {
    const xBit = Math.floor(localX * 2);
    const yBit = Math.floor(localY * 2);
    node = node.children[yBit * 2 + xBit]!;
    localX = localX * 2 - xBit;
    localY = localY * 2 - yBit;
  }
  return node.image;
}

export function encodeImageryTree(
  root: ImageryTreeNode,
  poolGeneration: number,
  reference: (image: string) => ImageryGpuReference | undefined,
): EncodedImageryTree | undefined {
  const nodeValues: number[] = [0, 0];
  const imageValues: number[] = [];
  const imageIndices = new Map<string, number>();
  const sourceKeys = new Set<string>();
  let failed = false;

  const encodeAt = (node: ImageryTreeNode, index: number): void => {
    if (isImage(node)) {
      if (node.image === BLUE_MARBLE_IMAGERY_KEY) return;
      let imageIndex = imageIndices.get(node.image);
      if (imageIndex === undefined) {
        const resolved = reference(node.image);
        if (!resolved || resolved.poolGeneration !== poolGeneration) {
          failed = true;
          return;
        }
        imageIndex = imageIndices.size;
        imageIndices.set(node.image, imageIndex);
        sourceKeys.add(node.image);
        imageValues.push(
          resolved.layer,
          resolved.sourceTile.z,
          resolved.sourceTile.x,
          resolved.sourceTile.y,
        );
      }
      nodeValues[index * 2 + 1] = imageIndex + 1;
      return;
    }
    const firstChild = nodeValues.length / 2;
    nodeValues[index * 2] = firstChild;
    for (let child = 0; child < 4; child += 1) nodeValues.push(0, 0);
    for (let child = 0; child < 4; child += 1) {
      encodeAt(node.children[child]!, firstChild + child);
    }
  };

  encodeAt(root, 0);
  if (failed) return undefined;
  return {
    nodeData: new Uint32Array(nodeValues),
    imageData: new Uint32Array(imageValues.length > 0 ? imageValues : [0, 0, 0, 0]),
    nodeCount: nodeValues.length / 2,
    imageCount: imageIndices.size,
    maximumDepth: imageryTreeMaximumDepth(root),
    poolGeneration,
    sourceKeys,
  };
}

function visitImageryTree(
  root: ImageryTreeNode,
  visit: (node: ImageryTreeNode) => void,
): void {
  visit(root);
  if (!isImage(root)) {
    for (const child of root.children) visitImageryTree(child, visit);
  }
}

function isImage(node: ImageryTreeNode): node is ImageryImageNode {
  return "image" in node;
}

function isDesiredLeaf(node: DesiredImageryTree): node is DesiredImageryLeaf {
  return "image" in node;
}

export function tileCentreGlobalUv(tile: TileIdentity): { u: number; v: number } {
  const width = 2 ** tile.z;
  return { u: (tile.x + 0.5) / width, v: (tile.y + 0.5) / width };
}
