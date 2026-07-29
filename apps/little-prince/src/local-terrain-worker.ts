import Martini from "@mapbox/martini";
import {
  EARTH_MEAN_RADIUS_KM,
  WGS84_A_KM,
  WGS84_B_KM,
} from "./planet-state.js";
import {
  LOCAL_GRID_SIZE,
  LOCAL_HEIGHT_CACHE_LIMIT,
  LOCAL_TILE_SIZE,
  RTIN_ERROR_BUCKETS_M,
  RTIN_FALLBACK_ERROR_BUCKETS_M,
  LruCache,
  buildHeightGrid513,
  decodeTerrariumPixels,
  forceFullRtinBoundary,
  isOceanOnlyHeightTile,
  mercatorCoordinatesForTilePoint,
  mercatorTileKey,
  wrapMercatorX,
  type DecodedHeightTile,
  type LocalTerrainWorkerRequest,
  type LocalTerrainWorkerResult,
  type MercatorTileAddress,
} from "./local-terrain-core.js";

type CachedHeightTile = DecodedHeightTile | "ocean";

const decoded = new LruCache<CachedHeightTile>(LOCAL_HEIGHT_CACHE_LIMIT);
const martini = new Martini(LOCAL_GRID_SIZE);
const worker = self as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<LocalTerrainWorkerRequest>) => void,
  ): void;
  postMessage(message: LocalTerrainWorkerResult, transfer?: Transferable[]): void;
  close(): void;
};

function adjacentAddress(
  address: MercatorTileAddress,
  deltaX: number,
  deltaY: number,
): MercatorTileAddress {
  return {
    z: address.z,
    x: wrapMercatorX(address.x + deltaX, address.z),
    y: address.y + deltaY,
  };
}

function decodedHeights(
  address: MercatorTileAddress,
): DecodedHeightTile | undefined {
  const value = decoded.get(mercatorTileKey(address));
  return value === "ocean" ? undefined : value;
}

async function decodeTile(
  request: Extract<LocalTerrainWorkerRequest, { type: "decode" }>,
): Promise<void> {
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(
      new Blob([request.bytes], {
        type: request.contentType || "image/webp",
      }),
    );
    if (
      bitmap.width !== LOCAL_TILE_SIZE ||
      bitmap.height !== LOCAL_TILE_SIZE
    ) {
      throw new Error("The elevation image is not a 512 × 512 tile.");
    }
    const canvas = new OffscreenCanvas(LOCAL_TILE_SIZE, LOCAL_TILE_SIZE);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Worker canvas decoding is unavailable.");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(
      0,
      0,
      LOCAL_TILE_SIZE,
      LOCAL_TILE_SIZE,
    ).data;
    const heights = decodeTerrariumPixels(pixels);
    const oceanOnly = isOceanOnlyHeightTile(heights);
    decoded.set(
      mercatorTileKey(request.address),
      oceanOnly ? "ocean" : heights,
    );
    worker.postMessage({
      type: "decoded",
      requestId: request.requestId,
      generation: request.generation,
      address: request.address,
      oceanOnly,
    });
  } catch (error) {
    worker.postMessage({
      type: "error",
      requestId: request.requestId,
      generation: request.generation,
      address: request.address,
      message:
        error instanceof Error ? error.message : "Elevation decoding failed.",
    });
  } finally {
    bitmap?.close();
  }
}

/**
 * Martini calculates source errors in its constructor. After forcing the edge
 * samples, only the parent maxima need another bottom-up pass.
 */
function propagateForcedBoundaryErrors(
  errors: Float32Array,
  source: Martini,
): void {
  const { coords, gridSize: size, numParentTriangles } = source;
  for (let index = numParentTriangles - 1; index >= 0; index -= 1) {
    const offset = index * 4;
    const ax = coords[offset] ?? 0;
    const ay = coords[offset + 1] ?? 0;
    const bx = coords[offset + 2] ?? 0;
    const by = coords[offset + 3] ?? 0;
    const middleX = (ax + bx) >> 1;
    const middleY = (ay + by) >> 1;
    const oppositeX = middleX + middleY - ay;
    const oppositeY = middleY + ax - middleX;
    const middle = middleY * size + middleX;
    const left =
      ((ay + oppositeY) >> 1) * size + ((ax + oppositeX) >> 1);
    const right =
      ((by + oppositeY) >> 1) * size + ((bx + oppositeX) >> 1);
    errors[middle] = Math.max(
      errors[middle] ?? 0,
      errors[left] ?? 0,
      errors[right] ?? 0,
    );
  }
}

function bucketCandidates(requestedErrorM: number): number[] {
  const buckets = [
    ...RTIN_ERROR_BUCKETS_M,
    ...RTIN_FALLBACK_ERROR_BUCKETS_M,
  ];
  const requestedIndex = buckets.findIndex(
    (candidate) => candidate >= requestedErrorM,
  );
  const first = requestedIndex < 0 ? buckets.length - 1 : requestedIndex;
  return buckets.slice(first);
}

function boundaryDuplicateCount(vertices: Uint16Array): number {
  let count = 0;
  for (let index = 0; index < vertices.length; index += 2) {
    const x = vertices[index] ?? 0;
    const y = vertices[index + 1] ?? 0;
    if (y === 0) count += 1;
    if (x === LOCAL_TILE_SIZE) count += 1;
    if (y === LOCAL_TILE_SIZE) count += 1;
    if (x === 0) count += 1;
  }
  return count;
}

function buildFinalGeometry(
  address: MercatorTileAddress,
  grid: Float32Array,
  vertices: Uint16Array,
  triangles: Uint32Array,
): Omit<
  Extract<LocalTerrainWorkerResult, { type: "mesh" }>,
  | "type"
  | "requestId"
  | "generation"
  | "address"
  | "requestedErrorM"
  | "actualErrorM"
> {
  const baseVertexCount = vertices.length / 2;
  const finalVertexCount =
    baseVertexCount + boundaryDuplicateCount(vertices);
  const positions = new Float32Array(finalVertexCount * 3);
  const normals = new Float32Array(finalVertexCount * 3);
  const uvs = new Float32Array(finalVertexCount * 2);
  const heightUvs = new Float32Array(finalVertexCount * 2);
  const detailHeightsM = new Float32Array(finalVertexCount);
  const skirtEdges = new Float32Array(finalVertexCount);
  const edgeSets: Array<Array<{ vertex: number; coordinate: number }>> = [
    [],
    [],
    [],
    [],
  ];
  const eccentricitySquared =
    1 - (WGS84_B_KM * WGS84_B_KM) / (WGS84_A_KM * WGS84_A_KM);

  for (let index = 0; index < baseVertexCount; index += 1) {
    const pixelX = vertices[index * 2] ?? 0;
    const pixelY = vertices[index * 2 + 1] ?? 0;
    const coordinates = mercatorCoordinatesForTilePoint(
      address,
      pixelX,
      pixelY,
    );
    const latitude = coordinates.latitudeDegrees * Math.PI / 180;
    const longitude = coordinates.longitudeDegrees * Math.PI / 180;
    const sineLatitude = Math.sin(latitude);
    const cosineLatitude = Math.cos(latitude);
    const primeVerticalRadius =
      WGS84_A_KM /
      Math.sqrt(1 - eccentricitySquared * sineLatitude * sineLatitude);
    const normalX = cosineLatitude * Math.cos(longitude);
    const normalY = sineLatitude;
    const normalZ = -cosineLatitude * Math.sin(longitude);
    const positionOffset = index * 3;
    positions[positionOffset] =
      primeVerticalRadius * normalX / EARTH_MEAN_RADIUS_KM;
    positions[positionOffset + 1] =
      primeVerticalRadius *
      (1 - eccentricitySquared) *
      sineLatitude /
      EARTH_MEAN_RADIUS_KM;
    positions[positionOffset + 2] =
      primeVerticalRadius * normalZ / EARTH_MEAN_RADIUS_KM;
    normals[positionOffset] = normalX;
    normals[positionOffset + 1] = normalY;
    normals[positionOffset + 2] = normalZ;
    const uvOffset = index * 2;
    uvs[uvOffset] = pixelX / LOCAL_TILE_SIZE;
    uvs[uvOffset + 1] = pixelY / LOCAL_TILE_SIZE;
    heightUvs[uvOffset] = (coordinates.longitudeDegrees + 180) / 360;
    heightUvs[uvOffset + 1] = (90 - coordinates.latitudeDegrees) / 180;
    detailHeightsM[index] =
      grid[pixelY * LOCAL_GRID_SIZE + pixelX] ?? 0;
    if (pixelY === 0) {
      edgeSets[0]!.push({ vertex: index, coordinate: pixelX });
    }
    if (pixelX === LOCAL_TILE_SIZE) {
      edgeSets[1]!.push({ vertex: index, coordinate: pixelY });
    }
    if (pixelY === LOCAL_TILE_SIZE) {
      edgeSets[2]!.push({ vertex: index, coordinate: -pixelX });
    }
    if (pixelX === 0) {
      edgeSets[3]!.push({ vertex: index, coordinate: -pixelY });
    }
  }

  const skirtIndexCount = edgeSets.reduce(
    (total, edge) => total + Math.max(0, edge.length - 1) * 6,
    0,
  );
  const indices = new Uint32Array(triangles.length + skirtIndexCount);
  indices.set(triangles);
  let nextVertex = baseVertexCount;
  let nextIndex = triangles.length;
  for (let edgeIndex = 0; edgeIndex < edgeSets.length; edgeIndex += 1) {
    const edge = edgeSets[edgeIndex]!;
    edge.sort((first, second) => first.coordinate - second.coordinate);
    const duplicates: number[] = [];
    for (const { vertex } of edge) {
      const duplicate = nextVertex++;
      duplicates.push(duplicate);
      positions.set(
        positions.subarray(vertex * 3, vertex * 3 + 3),
        duplicate * 3,
      );
      normals.set(
        normals.subarray(vertex * 3, vertex * 3 + 3),
        duplicate * 3,
      );
      uvs.set(uvs.subarray(vertex * 2, vertex * 2 + 2), duplicate * 2);
      heightUvs.set(
        heightUvs.subarray(vertex * 2, vertex * 2 + 2),
        duplicate * 2,
      );
      detailHeightsM[duplicate] = detailHeightsM[vertex] ?? 0;
      skirtEdges[duplicate] = edgeIndex + 1;
    }
    for (let index = 0; index < edge.length - 1; index += 1) {
      const first = edge[index]!.vertex;
      const second = edge[index + 1]!.vertex;
      indices[nextIndex++] = first;
      indices[nextIndex++] = duplicates[index]!;
      indices[nextIndex++] = second;
      indices[nextIndex++] = second;
      indices[nextIndex++] = duplicates[index]!;
      indices[nextIndex++] = duplicates[index + 1]!;
    }
  }

  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis] ?? 0;
      minimum[axis] = Math.min(minimum[axis]!, value);
      maximum[axis] = Math.max(maximum[axis]!, value);
    }
  }
  const boundingCentre = new Float32Array([
    (minimum[0]! + maximum[0]!) * 0.5,
    (minimum[1]! + maximum[1]!) * 0.5,
    (minimum[2]! + maximum[2]!) * 0.5,
  ]);
  let boundingRadiusSquared = 0;
  for (let index = 0; index < positions.length; index += 3) {
    const deltaX = (positions[index] ?? 0) - boundingCentre[0]!;
    const deltaY = (positions[index + 1] ?? 0) - boundingCentre[1]!;
    const deltaZ = (positions[index + 2] ?? 0) - boundingCentre[2]!;
    boundingRadiusSquared = Math.max(
      boundingRadiusSquared,
      deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ,
    );
  }
  const geometryBytes =
    positions.byteLength +
    normals.byteLength +
    uvs.byteLength +
    heightUvs.byteLength +
    detailHeightsM.byteLength +
    skirtEdges.byteLength +
    indices.byteLength;
  return {
    positions,
    normals,
    uvs,
    heightUvs,
    detailHeightsM,
    skirtEdges,
    indices,
    boundingCentre,
    boundingRadius: Math.sqrt(boundingRadiusSquared),
    geometryBytes,
  };
}

function buildMesh(
  request: Extract<LocalTerrainWorkerRequest, { type: "mesh" }>,
): void {
  const key = mercatorTileKey(request.address);
  const centre = decodedHeights(request.address);
  if (!centre) {
    worker.postMessage({
      type: "error",
      requestId: request.requestId,
      generation: request.generation,
      address: request.address,
      message: "The decoded elevation tile is no longer cached.",
      missing: true,
    });
    return;
  }
  try {
    const grid = buildHeightGrid513(
      centre,
      decodedHeights(adjacentAddress(request.address, 1, 0)),
      decodedHeights(adjacentAddress(request.address, 0, 1)),
      decodedHeights(adjacentAddress(request.address, 1, 1)),
    );
    const tile = martini.createTile(grid);
    forceFullRtinBoundary(tile.errors);
    propagateForcedBoundaryErrors(tile.errors, martini);
    let selected:
      | {
          actualErrorM: number;
          vertices: Uint16Array;
          triangles: Uint32Array;
        }
      | undefined;
    let lastVertexCount = 0;
    for (const actualErrorM of bucketCandidates(request.errorM)) {
      const mesh = tile.getMesh(actualErrorM);
      lastVertexCount =
        mesh.vertices.length / 2 + boundaryDuplicateCount(mesh.vertices);
      if (lastVertexCount <= request.vertexLimit) {
        selected = { actualErrorM, ...mesh };
        break;
      }
    }
    if (!selected) {
      worker.postMessage({
        type: "overbudget",
        requestId: request.requestId,
        generation: request.generation,
        address: request.address,
        requestedErrorM: request.errorM,
        vertexCount: lastVertexCount,
      });
      return;
    }
    const geometry = buildFinalGeometry(
      request.address,
      grid,
      selected.vertices,
      selected.triangles,
    );
    const result: LocalTerrainWorkerResult = {
      type: "mesh",
      requestId: request.requestId,
      generation: request.generation,
      address: request.address,
      requestedErrorM: request.errorM,
      actualErrorM: selected.actualErrorM,
      ...geometry,
    };
    worker.postMessage(result, [
      result.positions.buffer,
      result.normals.buffer,
      result.uvs.buffer,
      result.heightUvs.buffer,
      result.detailHeightsM.buffer,
      result.skirtEdges.buffer,
      result.indices.buffer,
      result.boundingCentre.buffer,
    ]);
  } catch (error) {
    worker.postMessage({
      type: "error",
      requestId: request.requestId,
      generation: request.generation,
      address: request.address,
      message:
        error instanceof Error ? error.message : "RTIN mesh generation failed.",
    });
  }
}

worker.addEventListener("message", (event) => {
  const request = event.data;
  if (request.type === "decode") {
    void decodeTile(request);
  } else if (request.type === "mesh") {
    buildMesh(request);
  } else {
    decoded.clear();
    worker.close();
  }
});
