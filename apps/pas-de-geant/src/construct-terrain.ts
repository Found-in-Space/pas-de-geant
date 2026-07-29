import * as THREE from "three";
import { loadCachedElevation } from "./elevation-cache.js";
import { normalizedRadialOffsetForMetres } from "./planet-state.js";
import {
  LOCAL_TILE_SIZE,
  TileRequestQueue,
  mercatorPointForCoordinates,
  mercatorTileKey,
  terrainEdgeInterpolation,
  wrapMercatorX,
  type LocalTerrainWorkerRequest,
  type LocalTerrainWorkerResult,
  type MercatorTileAddress,
  type TileLoadTask,
} from "./local-terrain-core.js";
import {
  selectConstructTerrainPlan,
  type ConstructTerrainTile,
  type ConstructTerrainPlan,
} from "./construct-core.js";

type PreparedTile = Extract<LocalTerrainWorkerResult, { type: "mesh" }>;

interface PendingWorkerRequest {
  kind: "decode" | "mesh";
  address: MercatorTileAddress;
  generation: number;
  geometrySignature?: string;
  finishDecode?: () => void;
}

interface ConstructTerrainStatus {
  zoom: number;
  tileWidthM: number;
  rendered: number;
  expected: number;
  required: number;
  decoded: number;
  unavailable: number;
  activeRequests: number;
  queuedRequests: number;
  vertices: number;
  meshBuilds: number;
  contactHeightM: number;
  contactHeightAvailable: boolean;
  seamChecks: number;
  seamPositionError: number;
  seamOffsetErrorM: number;
  ready: boolean;
}

const CONSTRUCT_SKIRT_DEPTH_M = 750;

function tileGeometrySignature(tile: ConstructTerrainTile): string {
  const constraints = Object.entries(tile.edgeConstraints)
    .map(
      ([edge, constraint]) =>
        `${edge}:${mercatorTileKey(constraint.address)}:` +
        `${constraint.edge}:${constraint.segments}`,
    )
    .sort()
    .join(",");
  return (
    `${tile.meshSegments}:` +
    `${tile.skirtEdges.north}${tile.skirtEdges.east}` +
    `${tile.skirtEdges.south}${tile.skirtEdges.west}:` +
    constraints
  );
}

function constructMaterial(texture: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    // The worker's Mercator grid winds inward. Rendering only that outward-
    // visible face prevents far-side terrain from showing through the onion.
    side: THREE.BackSide,
    depthTest: true,
    depthWrite: true,
    uniforms: {
      imageMap: { value: texture },
      normalizedRadialMetres: { value: 0 },
      normalizedSkirtDepth: { value: 0 },
      oceanSurface: { value: 1 },
      sunlight: {
        value: new THREE.Vector3(-0.38, 0.82, 0.42).normalize(),
      },
    },
    vertexShader: `
      attribute vec2 heightUv;
      attribute float detailHeightM;
      attribute vec3 detailOffsetM;
      attribute float skirtEdge;
      uniform float normalizedRadialMetres;
      uniform float normalizedSkirtDepth;
      uniform float oceanSurface;
      varying vec2 vImageUv;
      varying vec3 vBaseNormal;
      void main() {
        vec3 displayedDetailOffsetM = detailOffsetM;
        if (oceanSurface > 0.5 && detailHeightM < 0.0) {
          displayedDetailOffsetM = vec3(0.0);
        }
        vec3 displaced =
          position +
          displayedDetailOffsetM * normalizedRadialMetres -
          normal * normalizedSkirtDepth * step(0.5, skirtEdge);
        vec4 worldPosition = modelMatrix * vec4(displaced, 1.0);
        vImageUv = heightUv;
        vBaseNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform sampler2D imageMap;
      uniform vec3 sunlight;
      varying vec2 vImageUv;
      varying vec3 vBaseNormal;
      void main() {
        vec3 albedo = pow(texture2D(imageMap, vImageUv).rgb, vec3(0.72));
        float direct = max(
          0.0,
          dot(normalize(vBaseNormal), normalize(sunlight))
        );
        float ambient = 0.62 + 0.12 * max(0.0, vBaseNormal.y);
        gl_FragColor = vec4(albedo * (ambient + direct * 0.58), 1.0);
      }
    `,
  });
}

function geometryForTile(result: PreparedTile): THREE.BufferGeometry {
  if (!result.detailOffsetsM) {
    throw new Error("Construct terrain requires vector height offsets.");
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(result.positions, 3),
  );
  geometry.setAttribute(
    "normal",
    new THREE.BufferAttribute(result.normals, 3),
  );
  geometry.setAttribute("uv", new THREE.BufferAttribute(result.uvs, 2));
  geometry.setAttribute(
    "heightUv",
    new THREE.BufferAttribute(result.heightUvs, 2),
  );
  geometry.setAttribute(
    "detailHeightM",
    new THREE.BufferAttribute(result.detailHeightsM, 1),
  );
  geometry.setAttribute(
    "detailOffsetM",
    new THREE.BufferAttribute(result.detailOffsetsM, 3),
  );
  geometry.setAttribute(
    "skirtEdge",
    new THREE.BufferAttribute(result.skirtEdges, 1),
  );
  geometry.setIndex(new THREE.BufferAttribute(result.indices, 1));
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3().fromArray(result.boundingCentre),
    result.boundingRadius,
  );
  return geometry;
}

function adjacent(
  address: MercatorTileAddress,
  deltaX: number,
  deltaY: number,
): MercatorTileAddress {
  const width = 2 ** address.z;
  return {
    z: address.z,
    x: ((address.x + deltaX) % width + width) % width,
    y: address.y + deltaY,
  };
}

export class ConstructTerrainRenderer {
  readonly group = new THREE.Group();
  private readonly worker: Worker;
  private readonly material: THREE.ShaderMaterial;
  private readonly loadQueue: TileRequestQueue<{
    bytes: ArrayBuffer;
    contentType: string;
    zeroHeight: boolean;
  }>;
  private readonly decoded = new Set<string>();
  private readonly unavailable = new Set<string>();
  private readonly pendingWorker = new Map<number, PendingWorkerRequest>();
  private readonly rendered = new Map<string, THREE.Mesh>();
  private readonly meshQueue = new Map<string, ConstructTerrainTile>();
  private plan: ConstructTerrainPlan | undefined;
  private generation = 0;
  private requestId = 0;
  private installedMeshBuilds = 0;
  private meshInFlight = false;
  private meshInFlightKey: string | undefined;
  private previousZoom: number | undefined;
  private contactHeightM = 0;
  private contactHeightAvailable = false;
  private zoomTransitionPending = false;
  private seamDiagnosticsDirty = true;
  private seamChecks = 0;
  private seamPositionError = 0;
  private seamOffsetErrorM = 0;

  constructor(texture: THREE.Texture) {
    this.group.name = "construct-terrain";
    this.material = constructMaterial(texture);
    this.worker = new Worker(
      new URL("./local-terrain-worker.ts", import.meta.url),
      { type: "module" },
    );
    this.worker.addEventListener(
      "message",
      (event: MessageEvent<LocalTerrainWorkerResult>) =>
        this.handleWorkerResult(event.data),
    );
    this.loadQueue = new TileRequestQueue(
      async (address, signal) => {
        const payload = await loadCachedElevation(address, signal);
        if (payload.status === 404) {
          return {
            bytes: new ArrayBuffer(0),
            contentType: "",
            zeroHeight: true,
          };
        }
        if (payload.status < 200 || payload.status >= 300) {
          throw new Error(`Mapterhorn returned ${payload.status}.`);
        }
        return {
          bytes: payload.bytes,
          contentType: payload.contentType,
          zeroHeight: false,
        };
      },
      (task, payload) => this.decode(task, payload),
      (task) => {
        this.unavailable.add(mercatorTileKey(task.address));
        this.queueMeshes();
      },
    );
  }

  update(options: {
    latitudeDegrees: number;
    longitudeDegrees: number;
    displayRadiusM: number;
    radialMultiplier: number;
    oceanSurface: boolean;
    lodBias: number;
  }): void {
    const next = selectConstructTerrainPlan({
      latitudeDegrees: options.latitudeDegrees,
      longitudeDegrees: options.longitudeDegrees,
      displayRadiusM: options.displayRadiusM,
      previousZoom: this.previousZoom,
      lodBias: options.lodBias,
    });
    if (!this.plan || next.signature !== this.plan.signature) {
      this.previousZoom = next.zoom - options.lodBias;
      this.applyPlan(next);
    }
    const sampledHeightM = this.sampleContactHeight(
      options.latitudeDegrees,
      options.longitudeDegrees,
      options.oceanSurface,
    );
    if (sampledHeightM !== undefined) {
      this.contactHeightM = sampledHeightM;
      this.contactHeightAvailable = true;
    }
    this.material.uniforms.normalizedRadialMetres!.value =
      normalizedRadialOffsetForMetres(1, options.radialMultiplier);
    this.material.uniforms.normalizedSkirtDepth!.value =
      normalizedRadialOffsetForMetres(
        CONSTRUCT_SKIRT_DEPTH_M,
        options.radialMultiplier,
      );
    this.material.uniforms.oceanSurface!.value =
      options.oceanSurface ? 1 : 0;
  }

  status(): ConstructTerrainStatus {
    const plan = this.plan;
    const desiredTiles = new Map(
      (plan?.rendered ?? []).map((tile) => [mercatorTileKey(tile), tile]),
    );
    const renderedVertices = [...desiredTiles].reduce(
      (total, [key, tile]) => {
        const mesh = this.rendered.get(key);
        return total +
          (mesh && this.meshMatches(mesh, tile)
            ? (mesh.geometry.getAttribute("position")?.count ?? 0)
            : 0);
      },
      0,
    );
    const expected = plan?.rendered.length ?? 0;
    const settledTargets = (plan?.rendered ?? []).filter((address) => {
      const key = mercatorTileKey(address);
      const mesh = this.rendered.get(key);
      return (
        (mesh && this.meshMatches(mesh, address)) ||
        this.unavailable.has(key)
      );
    }).length;
    const rendered = expected === 0
      ? 0
      : (plan?.rendered ?? []).filter((tile) => {
          const mesh = this.rendered.get(mercatorTileKey(tile));
          return mesh && this.meshMatches(mesh, tile);
        }).length;
    const planKeys = new Set(plan?.required.map(mercatorTileKey) ?? []);
    const ready =
      expected > 0 &&
      settledTargets === expected &&
      !this.meshInFlight &&
      !this.zoomTransitionPending;
    if (ready) this.refreshSeamDiagnostics();
    return {
      zoom: plan?.zoom ?? 0,
      tileWidthM: plan?.tileWidthM ?? 0,
      rendered,
      expected,
      required: plan?.required.length ?? 0,
      decoded: [...planKeys].filter((key) => this.decoded.has(key)).length,
      unavailable: [...planKeys].filter((key) =>
        this.unavailable.has(key)
      ).length,
      activeRequests: this.loadQueue.activeCount,
      queuedRequests: this.loadQueue.queuedCount,
      vertices: renderedVertices,
      meshBuilds: this.installedMeshBuilds,
      contactHeightM: this.contactHeightM,
      contactHeightAvailable: this.contactHeightAvailable,
      seamChecks: this.seamChecks,
      seamPositionError: this.seamPositionError,
      seamOffsetErrorM: this.seamOffsetErrorM,
      ready,
    };
  }

  dispose(): void {
    this.loadQueue.dispose();
    this.worker.postMessage({ type: "dispose" } satisfies LocalTerrainWorkerRequest);
    this.worker.terminate();
    this.clearMeshes();
    this.material.dispose();
  }

  private applyPlan(plan: ConstructTerrainPlan): void {
    const previousZoom = this.plan?.zoom;
    const hasVisibleTerrain = [...this.rendered.values()].some(
      (mesh) => mesh.visible,
    );
    this.plan = plan;
    this.generation += 1;
    this.meshQueue.clear();
    if (
      previousZoom !== undefined &&
      previousZoom !== plan.zoom &&
      hasVisibleTerrain
    ) {
      this.zoomTransitionPending = true;
      this.removeInvisibleObsoleteMeshes();
    } else if (!this.zoomTransitionPending) {
      this.removeObsoleteMeshes();
    }
    this.syncHeightLoads();
    this.queueMeshes();
  }

  private syncHeightLoads(): void {
    if (!this.plan) return;
    const tasks = this.plan.required
      .filter((address) => {
        const key = mercatorTileKey(address);
        return !this.decoded.has(key) && !this.unavailable.has(key);
      })
      .map((address, priority): TileLoadTask => ({
        address,
        priority,
      }));
    this.loadQueue.sync(tasks);
  }

  private decode(
    task: TileLoadTask,
    payload: {
      bytes: ArrayBuffer;
      contentType: string;
      zeroHeight: boolean;
    },
  ): Promise<void> {
    const requestId = ++this.requestId;
    return new Promise<void>((resolve) => {
      this.pendingWorker.set(requestId, {
        kind: "decode",
        address: task.address,
        generation: this.generation,
        finishDecode: resolve,
      });
      this.worker.postMessage(
        {
          type: "decode",
          requestId,
          generation: this.generation,
          address: task.address,
          bytes: payload.bytes,
          contentType: payload.contentType,
          retainOcean: true,
          zeroHeight: payload.zeroHeight,
        } satisfies LocalTerrainWorkerRequest,
        [payload.bytes],
      );
    });
  }

  private queueMeshes(): void {
    if (!this.plan) return;
    for (const tile of this.plan.rendered) {
      const key = mercatorTileKey(tile);
      const existing = this.rendered.get(key);
      if (
        (existing && this.meshMatches(existing, tile)) ||
        this.meshQueue.has(key) ||
        this.meshInFlightKey === key ||
        this.unavailable.has(key)
      ) {
        continue;
      }
      if (this.decoded.has(key)) {
        const sourceTiles = [
          tile,
          ...Object.values(tile.edgeConstraints).map(
            (constraint) => constraint.address,
          ),
        ];
        const prerequisites = sourceTiles.flatMap((source) => [
          source,
          adjacent(source, 1, 0),
          adjacent(source, 0, 1),
          adjacent(source, 1, 1),
        ]);
        if (
          prerequisites.every((item) => {
            const prerequisiteKey = mercatorTileKey(item);
            return (
              this.decoded.has(prerequisiteKey) ||
              this.unavailable.has(prerequisiteKey)
            );
          })
        ) {
          this.meshQueue.set(key, tile);
        }
      }
    }
    if (this.zoomTransitionPending && this.replacementReady()) {
      this.commitZoomTransition();
    } else if (!this.zoomTransitionPending) {
      this.removeObsoleteMeshes();
    }
    this.dispatchMesh();
  }

  private dispatchMesh(): void {
    if (this.meshInFlight) return;
    const next = this.meshQueue.entries().next().value as
      | [string, ConstructTerrainTile]
      | undefined;
    if (!next) return;
    const [key, tile] = next;
    this.meshQueue.delete(key);
    const requestId = ++this.requestId;
    this.meshInFlight = true;
    this.meshInFlightKey = key;
    this.pendingWorker.set(requestId, {
      kind: "mesh",
      address: tile,
      generation: this.generation,
      geometrySignature: tileGeometrySignature(tile),
    });
    this.worker.postMessage({
      type: "mesh",
      requestId,
      generation: this.generation,
      address: tile,
      segments: tile.meshSegments,
      skirtEdges: tile.skirtEdges,
      edgeConstraints: tile.edgeConstraints,
      includeDetailOffsets: true,
    } satisfies LocalTerrainWorkerRequest);
  }

  private handleWorkerResult(result: LocalTerrainWorkerResult): void {
    const pending = this.pendingWorker.get(result.requestId);
    if (!pending) return;
    this.pendingWorker.delete(result.requestId);
    const key = mercatorTileKey(pending.address);
    if (pending.kind === "decode") {
      if (result.type === "decoded") {
        this.decoded.add(key);
        this.unavailable.delete(key);
      } else {
        this.unavailable.add(key);
      }
      pending.finishDecode?.();
    } else {
      this.meshInFlight = false;
      this.meshInFlightKey = undefined;
      if (
        result.type === "mesh" &&
        result.generation === this.generation &&
        this.plan?.rendered.some(
          (tile) =>
            mercatorTileKey(tile) === key &&
            tile.meshSegments === result.requestedSegments &&
            tileGeometrySignature(tile) === pending.geometrySignature,
        )
      ) {
        this.installMesh(result, pending.geometrySignature ?? "");
      } else if (result.type === "error") {
        if (result.missing) {
          // The worker keeps decoded heights in a bounded LRU, while the
          // renderer's index spans every tile visited during the session.
          // A missing mesh source means that index is stale, not that the
          // source is permanently unavailable. Reload it (normally from the
          // browser cache) and let the mesh request run again.
          const missingKey = mercatorTileKey(
            result.missingAddress ?? pending.address,
          );
          this.decoded.delete(missingKey);
          this.unavailable.delete(missingKey);
          this.syncHeightLoads();
        } else {
          this.unavailable.add(key);
        }
      }
    }
    this.queueMeshes();
  }

  private installMesh(
    result: PreparedTile,
    geometrySignature: string,
  ): void {
    const key = mercatorTileKey(result.address);
    this.removeMesh(key);
    const mesh = new THREE.Mesh(geometryForTile(result), this.material);
    mesh.frustumCulled = false;
    mesh.visible = !this.zoomTransitionPending;
    mesh.userData.meshSegments = result.actualSegments;
    mesh.userData.geometrySignature = geometrySignature;
    this.installedMeshBuilds += 1;
    this.rendered.set(key, mesh);
    this.group.add(mesh);
    this.seamDiagnosticsDirty = true;
  }

  private sampleContactHeight(
    latitudeDegrees: number,
    longitudeDegrees: number,
    oceanSurface: boolean,
  ): number | undefined {
    const plan = this.plan;
    if (!plan) return undefined;
    const point = mercatorPointForCoordinates(
      latitudeDegrees,
      longitudeDegrees,
      plan.zoom,
    );
    const tileX = Math.floor(point.x);
    const tileY = Math.floor(point.y);
    const address = {
      z: plan.zoom,
      x: wrapMercatorX(tileX, plan.zoom),
      y: tileY,
    };
    const mesh = this.rendered.get(mercatorTileKey(address));
    if (!mesh?.visible) return undefined;
    const pixelX = Math.max(
      0,
      Math.min(LOCAL_TILE_SIZE, (point.x - tileX) * LOCAL_TILE_SIZE),
    );
    const pixelY = Math.max(
      0,
      Math.min(LOCAL_TILE_SIZE, (point.y - tileY) * LOCAL_TILE_SIZE),
    );
    const west = Math.floor(pixelX);
    const east = Math.min(LOCAL_TILE_SIZE, west + 1);
    const north = Math.floor(pixelY);
    const south = Math.min(LOCAL_TILE_SIZE, north + 1);
    const fractionX = pixelX - west;
    const fractionY = pixelY - north;
    const heights = mesh.geometry.getAttribute("detailHeightM");
    if (!heights) return undefined;
    const side = LOCAL_TILE_SIZE + 1;
    const northWest = heights.getX(north * side + west);
    const northEast = heights.getX(north * side + east);
    const southWest = heights.getX(south * side + west);
    const southEast = heights.getX(south * side + east);
    const northHeight =
      northWest + (northEast - northWest) * fractionX;
    const southHeight =
      southWest + (southEast - southWest) * fractionX;
    const heightM =
      northHeight + (southHeight - northHeight) * fractionY;
    return oceanSurface ? Math.max(0, heightM) : heightM;
  }

  private meshSegments(mesh: THREE.Mesh): number {
    return Number(mesh.userData.meshSegments ?? 0);
  }

  private meshMatches(
    mesh: THREE.Mesh,
    tile: ConstructTerrainTile,
  ): boolean {
    return (
      this.meshSegments(mesh) === tile.meshSegments &&
      mesh.userData.geometrySignature === tileGeometrySignature(tile)
    );
  }

  private refreshSeamDiagnostics(): void {
    if (!this.seamDiagnosticsDirty || !this.plan) return;
    let checks = 0;
    let maximumPositionError = 0;
    let maximumOffsetErrorM = 0;
    for (const tile of this.plan.rendered) {
      const sourceMesh = this.rendered.get(mercatorTileKey(tile));
      if (!sourceMesh || !this.meshMatches(sourceMesh, tile)) continue;
      const sourcePositions = sourceMesh.geometry.getAttribute("position");
      const sourceOffsets =
        sourceMesh.geometry.getAttribute("detailOffsetM");
      const sourceSide = tile.meshSegments + 1;
      const sourceStep = LOCAL_TILE_SIZE / tile.meshSegments;
      for (const [edge, constraint] of Object.entries(
        tile.edgeConstraints,
      )) {
        const targetTile = this.plan.rendered.find(
          (candidate) =>
            mercatorTileKey(candidate) ===
              mercatorTileKey(constraint.address) &&
            candidate.meshSegments === constraint.segments,
        );
        const targetMesh = targetTile
          ? this.rendered.get(mercatorTileKey(targetTile))
          : undefined;
        if (!targetMesh || !targetTile) continue;
        const targetPositions = targetMesh.geometry.getAttribute("position");
        const targetOffsets =
          targetMesh.geometry.getAttribute("detailOffsetM");
        const targetSide = constraint.segments + 1;
        const targetStep = LOCAL_TILE_SIZE / constraint.segments;
        for (
          let sourceCoordinate = 0;
          sourceCoordinate <= tile.meshSegments;
          sourceCoordinate += 1
        ) {
          const pixelAlongSource = sourceCoordinate * sourceStep;
          const pixelX =
            edge === "west"
              ? 0
              : edge === "east"
                ? LOCAL_TILE_SIZE
                : pixelAlongSource;
          const pixelY =
            edge === "north"
              ? 0
              : edge === "south"
                ? LOCAL_TILE_SIZE
                : pixelAlongSource;
          const sourceColumn = Math.round(pixelX / sourceStep);
          const sourceRow = Math.round(pixelY / sourceStep);
          const sourceVertex = sourceRow * sourceSide + sourceColumn;
          const zoomScale = 2 ** (constraint.address.z - tile.z);
          const targetWorldWidth = 2 ** constraint.address.z;
          let targetTileX =
            (tile.x + pixelX / LOCAL_TILE_SIZE) * zoomScale -
            constraint.address.x;
          targetTileX -=
            Math.round(targetTileX / targetWorldWidth) * targetWorldWidth;
          const targetTileY =
            (tile.y + pixelY / LOCAL_TILE_SIZE) * zoomScale -
            constraint.address.y;
          const targetPixelX = Math.max(
            0,
            Math.min(LOCAL_TILE_SIZE, targetTileX * LOCAL_TILE_SIZE),
          );
          const targetPixelY = Math.max(
            0,
            Math.min(LOCAL_TILE_SIZE, targetTileY * LOCAL_TILE_SIZE),
          );
          const targetAlong =
            constraint.edge === "north" || constraint.edge === "south"
              ? targetPixelX
              : targetPixelY;
          const interpolation = terrainEdgeInterpolation(
            constraint.segments,
            targetAlong,
          );
          const targetVertex = (pixelAlongEdge: number): number => {
            const column =
              constraint.edge === "west"
                ? 0
                : constraint.edge === "east"
                  ? constraint.segments
                  : Math.round(pixelAlongEdge / targetStep);
            const row =
              constraint.edge === "north"
                ? 0
                : constraint.edge === "south"
                  ? constraint.segments
                  : Math.round(pixelAlongEdge / targetStep);
            return row * targetSide + column;
          };
          const firstTarget = targetVertex(interpolation.firstPixel);
          const secondTarget = targetVertex(interpolation.secondPixel);
          const compareAttribute = (
            source: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
            target:
              | THREE.BufferAttribute
              | THREE.InterleavedBufferAttribute,
          ): number => {
            const sourceValue = [
              source.getX(sourceVertex),
              source.getY(sourceVertex),
              source.getZ(sourceVertex),
            ];
            const targetValue = [
              target.getX(firstTarget) +
                (target.getX(secondTarget) - target.getX(firstTarget)) *
                  interpolation.fraction,
              target.getY(firstTarget) +
                (target.getY(secondTarget) - target.getY(firstTarget)) *
                  interpolation.fraction,
              target.getZ(firstTarget) +
                (target.getZ(secondTarget) - target.getZ(firstTarget)) *
                  interpolation.fraction,
            ];
            return Math.hypot(
              sourceValue[0]! - targetValue[0]!,
              sourceValue[1]! - targetValue[1]!,
              sourceValue[2]! - targetValue[2]!,
            );
          };
          maximumPositionError = Math.max(
            maximumPositionError,
            compareAttribute(sourcePositions, targetPositions),
          );
          maximumOffsetErrorM = Math.max(
            maximumOffsetErrorM,
            compareAttribute(sourceOffsets, targetOffsets),
          );
          checks += 1;
        }
      }
    }
    this.seamChecks = checks;
    this.seamPositionError = maximumPositionError;
    this.seamOffsetErrorM = maximumOffsetErrorM;
    this.seamDiagnosticsDirty = false;
  }

  private replacementReady(): boolean {
    if (!this.plan) return false;
    return this.plan.rendered.length > 0 &&
      this.plan.rendered.every((tile) => {
        const mesh = this.rendered.get(mercatorTileKey(tile));
        return mesh && this.meshMatches(mesh, tile);
      });
  }

  private removeObsoleteMeshes(): void {
    if (!this.plan) return;
    const desired = new Set(this.plan.rendered.map(mercatorTileKey));
    for (const key of [...this.rendered.keys()]) {
      if (!desired.has(key)) this.removeMesh(key);
    }
  }

  private removeInvisibleObsoleteMeshes(): void {
    if (!this.plan) return;
    const desired = new Set(this.plan.rendered.map(mercatorTileKey));
    for (const [key, mesh] of [...this.rendered]) {
      if (!mesh.visible && !desired.has(key)) this.removeMesh(key);
    }
  }

  private commitZoomTransition(): void {
    if (!this.plan) return;
    this.removeObsoleteMeshes();
    const desired = new Set(this.plan.rendered.map(mercatorTileKey));
    for (const [key, mesh] of this.rendered) {
      if (desired.has(key)) mesh.visible = true;
    }
    this.zoomTransitionPending = false;
  }

  private removeMesh(key: string): void {
    const mesh = this.rendered.get(key);
    if (!mesh) return;
    this.group.remove(mesh);
    mesh.geometry.dispose();
    this.rendered.delete(key);
    this.seamDiagnosticsDirty = true;
  }

  private clearMeshes(): void {
    for (const key of [...this.rendered.keys()]) this.removeMesh(key);
  }
}
