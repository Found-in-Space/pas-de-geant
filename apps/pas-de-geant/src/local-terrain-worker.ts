import {
  EARTH_MEAN_RADIUS_KM,
  WGS84_A_KM,
  WGS84_B_KM,
} from "./planet-state.js";
import {
  LOCAL_HEIGHT_CACHE_LIMIT,
  LOCAL_TILE_SIZE,
  LruCache,
  clampOceanSurfaceOffsetM,
  decodeTerrariumPixels,
  interpolateOceanSurfaceOffsetM,
  interpolateTerrainOffsetM,
  isOceanOnlyHeightTile,
  mercatorCoordinatesForTilePoint,
  mercatorTileKey,
  terrainEdgeInterpolation,
  terrainSourceDependencies,
  terrainSourcePixelCoordinates,
  type DecodedHeightTile,
  type LocalEdgeMask,
  type LocalTerrainWorkerRequest,
  type LocalTerrainWorkerResult,
  type MercatorTileAddress,
  type TerrainEdgeConstraint,
  type TerrainEdgeConstraints,
} from "./local-terrain-core.js";

type CachedHeightTile = DecodedHeightTile | "ocean";

const decoded = new LruCache<CachedHeightTile>(LOCAL_HEIGHT_CACHE_LIMIT);
const WGS84_ECCENTRICITY_SQUARED =
  1 - (WGS84_B_KM * WGS84_B_KM) / (WGS84_A_KM * WGS84_A_KM);
const worker = self as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<LocalTerrainWorkerRequest>) => void,
  ): void;
  postMessage(message: LocalTerrainWorkerResult, transfer?: Transferable[]): void;
  close(): void;
};

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
    if (request.zeroHeight) {
      decoded.set(
        mercatorTileKey(request.address),
        new Int16Array(LOCAL_TILE_SIZE * LOCAL_TILE_SIZE),
      );
      worker.postMessage({
        type: "decoded",
        requestId: request.requestId,
        generation: request.generation,
        address: request.address,
        oceanOnly: true,
      });
      return;
    }
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
      oceanOnly && !request.retainOcean ? "ocean" : heights,
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

function boundaryDuplicateCount(
  vertices: Uint16Array,
  edges: LocalEdgeMask,
): number {
  let count = 0;
  for (let index = 0; index < vertices.length; index += 2) {
    const x = vertices[index] ?? 0;
    const y = vertices[index + 1] ?? 0;
    if (edges.north > 0 && y === 0) count += 1;
    if (edges.east > 0 && x === LOCAL_TILE_SIZE) count += 1;
    if (edges.south > 0 && y === LOCAL_TILE_SIZE) count += 1;
    if (edges.west > 0 && x === 0) count += 1;
  }
  return count;
}

function regularGridMesh(segments: number): {
  vertices: Uint16Array;
  triangles: Uint32Array;
} {
  const selectedSegments = Math.max(1, Math.min(LOCAL_TILE_SIZE, segments));
  if (LOCAL_TILE_SIZE % selectedSegments !== 0) {
    throw new Error("The fixed terrain grid must divide the source tile.");
  }
  const side = selectedSegments + 1;
  const step = LOCAL_TILE_SIZE / selectedSegments;
  const vertices = new Uint16Array(side * side * 2);
  for (let row = 0; row < side; row += 1) {
    for (let column = 0; column < side; column += 1) {
      const vertex = row * side + column;
      vertices[vertex * 2] = column * step;
      vertices[vertex * 2 + 1] = row * step;
    }
  }
  const triangles = new Uint32Array(selectedSegments ** 2 * 6);
  let offset = 0;
  for (let row = 0; row < selectedSegments; row += 1) {
    for (let column = 0; column < selectedSegments; column += 1) {
      const northWest = row * side + column;
      const northEast = northWest + 1;
      const southWest = northWest + side;
      const southEast = southWest + 1;
      triangles[offset++] = northWest;
      triangles[offset++] = northEast;
      triangles[offset++] = southWest;
      triangles[offset++] = northEast;
      triangles[offset++] = southEast;
      triangles[offset++] = southWest;
    }
  }
  return { vertices, triangles };
}

interface TerrainSurfacePoint {
  position: [number, number, number];
  normal: [number, number, number];
  heightM: number;
  detailOffsetM: [number, number, number];
  oceanSurfaceOffsetM: [number, number, number];
}

function terrainSurfacePoint(
  address: MercatorTileAddress,
  pixelX: number,
  pixelY: number,
  heightM: number,
): TerrainSurfacePoint {
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
    Math.sqrt(
      1 - WGS84_ECCENTRICITY_SQUARED * sineLatitude * sineLatitude,
    );
  const normal: [number, number, number] = [
    cosineLatitude * Math.cos(longitude),
    sineLatitude,
    -cosineLatitude * Math.sin(longitude),
  ];
  const detailOffsetM: [number, number, number] = [
    normal[0] * heightM,
    normal[1] * heightM,
    normal[2] * heightM,
  ];
  return {
    position: [
      primeVerticalRadius * normal[0] / EARTH_MEAN_RADIUS_KM,
      primeVerticalRadius *
        (1 - WGS84_ECCENTRICITY_SQUARED) *
        sineLatitude /
        EARTH_MEAN_RADIUS_KM,
      primeVerticalRadius * normal[2] / EARTH_MEAN_RADIUS_KM,
    ],
    normal,
    heightM,
    detailOffsetM,
    oceanSurfaceOffsetM: clampOceanSurfaceOffsetM(heightM, detailOffsetM),
  };
}

function decodedHeightAtSourcePixel(
  sourceZoom: number,
  globalPixelX: number,
  globalPixelY: number,
): number {
  const pixelWorldWidth = 2 ** sourceZoom * LOCAL_TILE_SIZE;
  const x =
    ((globalPixelX % pixelWorldWidth) + pixelWorldWidth) % pixelWorldWidth;
  const y = Math.max(0, Math.min(pixelWorldWidth - 1, globalPixelY));
  const integerX = Math.floor(x);
  const integerY = Math.floor(y);
  const address = {
    z: sourceZoom,
    x: Math.floor(integerX / LOCAL_TILE_SIZE),
    y: Math.floor(integerY / LOCAL_TILE_SIZE),
  };
  const heights = decodedHeights(address);
  if (!heights) {
    throw new Error("The decoded elevation source is no longer cached.");
  }
  const pixelX = integerX % LOCAL_TILE_SIZE;
  const pixelY = integerY % LOCAL_TILE_SIZE;
  return heights[pixelY * LOCAL_TILE_SIZE + pixelX] ?? 0;
}

function decodedHeightForTerrainPoint(
  address: MercatorTileAddress,
  pixelX: number,
  pixelY: number,
): number {
  const source = terrainSourcePixelCoordinates(address, pixelX, pixelY);
  const sourceZoom = source.zoom;
  const sourcePixelX = source.x;
  const sourcePixelY = source.y;
  const west = Math.floor(sourcePixelX);
  const north = Math.floor(sourcePixelY);
  const fractionX = sourcePixelX - west;
  const fractionY = sourcePixelY - north;
  const northWest = decodedHeightAtSourcePixel(sourceZoom, west, north);
  if (fractionX === 0 && fractionY === 0) return northWest;
  const northEast = decodedHeightAtSourcePixel(sourceZoom, west + 1, north);
  const southWest = decodedHeightAtSourcePixel(sourceZoom, west, north + 1);
  const southEast = decodedHeightAtSourcePixel(
    sourceZoom,
    west + 1,
    north + 1,
  );
  const northern = northWest + (northEast - northWest) * fractionX;
  const southern = southWest + (southEast - southWest) * fractionX;
  return northern + (southern - northern) * fractionY;
}

function constrainedSurfacePoint(
  sourceAddress: MercatorTileAddress,
  pixelX: number,
  pixelY: number,
  constraint: TerrainEdgeConstraint,
): TerrainSurfacePoint | undefined {
  const zoomScale = 2 ** (constraint.address.z - sourceAddress.z);
  const targetWorldWidth = 2 ** constraint.address.z;
  let targetTileX =
    (sourceAddress.x + pixelX / LOCAL_TILE_SIZE) * zoomScale -
    constraint.address.x;
  targetTileX -= Math.round(targetTileX / targetWorldWidth) * targetWorldWidth;
  const targetTileY =
    (sourceAddress.y + pixelY / LOCAL_TILE_SIZE) * zoomScale -
    constraint.address.y;
  const targetPixelX = Math.max(
    0,
    Math.min(LOCAL_TILE_SIZE, targetTileX * LOCAL_TILE_SIZE),
  );
  const targetPixelY = Math.max(
    0,
    Math.min(LOCAL_TILE_SIZE, targetTileY * LOCAL_TILE_SIZE),
  );
  const along =
    constraint.edge === "north" || constraint.edge === "south"
      ? targetPixelX
      : targetPixelY;
  const interpolation = terrainEdgeInterpolation(
    constraint.segments,
    along,
  );
  const endpoint = (pixelAlongEdge: number): TerrainSurfacePoint => {
    const endpointX =
      constraint.edge === "west"
        ? 0
        : constraint.edge === "east"
          ? LOCAL_TILE_SIZE
          : pixelAlongEdge;
    const endpointY =
      constraint.edge === "north"
        ? 0
        : constraint.edge === "south"
          ? LOCAL_TILE_SIZE
          : pixelAlongEdge;
    const heightM = decodedHeightForTerrainPoint(
      constraint.address,
      endpointX,
      endpointY,
    );
    return terrainSurfacePoint(
      constraint.address,
      endpointX,
      endpointY,
      heightM,
    );
  };
  const first = endpoint(interpolation.firstPixel);
  const second = endpoint(interpolation.secondPixel);
  const interpolate = (firstValue: number, secondValue: number): number =>
    firstValue +
    (secondValue - firstValue) * interpolation.fraction;
  const normal: [number, number, number] = [
    interpolate(first.normal[0], second.normal[0]),
    interpolate(first.normal[1], second.normal[1]),
    interpolate(first.normal[2], second.normal[2]),
  ];
  const normalLength = Math.hypot(...normal) || 1;
  normal[0] /= normalLength;
  normal[1] /= normalLength;
  normal[2] /= normalLength;
  return {
    position: [
      interpolate(first.position[0], second.position[0]),
      interpolate(first.position[1], second.position[1]),
      interpolate(first.position[2], second.position[2]),
    ],
    normal,
    heightM: interpolate(first.heightM, second.heightM),
    detailOffsetM: interpolateTerrainOffsetM(
      first.detailOffsetM,
      second.detailOffsetM,
      interpolation.fraction,
    ),
    oceanSurfaceOffsetM: interpolateOceanSurfaceOffsetM(
      first.heightM,
      first.detailOffsetM,
      second.heightM,
      second.detailOffsetM,
      interpolation.fraction,
    ),
  };
}

function buildFinalGeometry(
  address: MercatorTileAddress,
  vertices: Uint16Array,
  triangles: Uint32Array,
  enabledSkirtEdges: LocalEdgeMask,
  edgeConstraints: TerrainEdgeConstraints,
  includeDetailOffsets: boolean,
): Omit<
  Extract<LocalTerrainWorkerResult, { type: "mesh" }>,
  | "type"
  | "requestId"
  | "generation"
  | "address"
  | "requestedSegments"
  | "actualSegments"
> {
  const baseVertexCount = vertices.length / 2;
  const finalVertexCount =
    baseVertexCount + boundaryDuplicateCount(vertices, enabledSkirtEdges);
  const positions = new Float32Array(finalVertexCount * 3);
  const normals = new Float32Array(finalVertexCount * 3);
  const uvs = new Float32Array(finalVertexCount * 2);
  const heightUvs = new Float32Array(finalVertexCount * 2);
  const detailHeightsM = new Float32Array(finalVertexCount);
  const detailOffsetsM = includeDetailOffsets
    ? new Float32Array(finalVertexCount * 3)
    : undefined;
  const oceanSurfaceOffsetsM = includeDetailOffsets
    ? new Float32Array(finalVertexCount * 3)
    : undefined;
  const skirtEdges = new Float32Array(finalVertexCount);
  const edgeSets: Array<Array<{ vertex: number; coordinate: number }>> = [
    [],
    [],
    [],
    [],
  ];

  for (let index = 0; index < baseVertexCount; index += 1) {
    const pixelX = vertices[index * 2] ?? 0;
    const pixelY = vertices[index * 2 + 1] ?? 0;
    const heightM = decodedHeightForTerrainPoint(address, pixelX, pixelY);
    const surface = terrainSurfacePoint(address, pixelX, pixelY, heightM);
    const coordinates = mercatorCoordinatesForTilePoint(
      address,
      pixelX,
      pixelY,
    );
    const positionOffset = index * 3;
    positions.set(surface.position, positionOffset);
    normals.set(surface.normal, positionOffset);
    detailOffsetsM?.set(surface.detailOffsetM, positionOffset);
    oceanSurfaceOffsetsM?.set(
      surface.oceanSurfaceOffsetM,
      positionOffset,
    );
    const uvOffset = index * 2;
    uvs[uvOffset] = pixelX / LOCAL_TILE_SIZE;
    uvs[uvOffset + 1] = pixelY / LOCAL_TILE_SIZE;
    heightUvs[uvOffset] = (coordinates.longitudeDegrees + 180) / 360;
    heightUvs[uvOffset + 1] = (90 - coordinates.latitudeDegrees) / 180;
    detailHeightsM[index] = heightM;
    if (enabledSkirtEdges.north > 0 && pixelY === 0) {
      edgeSets[0]!.push({ vertex: index, coordinate: pixelX });
    }
    if (
      enabledSkirtEdges.east > 0 &&
      pixelX === LOCAL_TILE_SIZE
    ) {
      edgeSets[1]!.push({ vertex: index, coordinate: pixelY });
    }
    if (
      enabledSkirtEdges.south > 0 &&
      pixelY === LOCAL_TILE_SIZE
    ) {
      edgeSets[2]!.push({ vertex: index, coordinate: -pixelX });
    }
    if (enabledSkirtEdges.west > 0 && pixelX === 0) {
      edgeSets[3]!.push({ vertex: index, coordinate: -pixelY });
    }
  }

  for (let index = 0; index < baseVertexCount; index += 1) {
    const pixelX = vertices[index * 2] ?? 0;
    const pixelY = vertices[index * 2 + 1] ?? 0;
    const applicable = [
      pixelY === 0 ? edgeConstraints.north : undefined,
      pixelX === LOCAL_TILE_SIZE ? edgeConstraints.east : undefined,
      pixelY === LOCAL_TILE_SIZE ? edgeConstraints.south : undefined,
      pixelX === 0 ? edgeConstraints.west : undefined,
    ].filter(
      (constraint): constraint is TerrainEdgeConstraint =>
        constraint !== undefined,
    );
    if (applicable.length === 0) continue;
    const conformed: TerrainSurfacePoint[] = [];
    for (const constraint of applicable) {
      const surface = constrainedSurfacePoint(
        address,
        pixelX,
        pixelY,
        constraint,
      );
      if (surface) conformed.push(surface);
    }
    if (conformed.length === 0) continue;
    const positionOffset = index * 3;
    const average = (
      values: TerrainSurfacePoint[],
      read: (value: TerrainSurfacePoint) => number,
    ): number =>
      values.reduce((sum, value) => sum + read(value), 0) / values.length;
    positions[positionOffset] = average(
      conformed,
      (surface) => surface.position[0],
    );
    positions[positionOffset + 1] = average(
      conformed,
      (surface) => surface.position[1],
    );
    positions[positionOffset + 2] = average(
      conformed,
      (surface) => surface.position[2],
    );
    const normal = [
      average(conformed, (surface) => surface.normal[0]),
      average(conformed, (surface) => surface.normal[1]),
      average(conformed, (surface) => surface.normal[2]),
    ];
    const normalLength = Math.hypot(...normal) || 1;
    normals[positionOffset] = normal[0]! / normalLength;
    normals[positionOffset + 1] = normal[1]! / normalLength;
    normals[positionOffset + 2] = normal[2]! / normalLength;
    detailHeightsM[index] = average(
      conformed,
      (surface) => surface.heightM,
    );
    if (detailOffsetsM) {
      detailOffsetsM[positionOffset] = average(
        conformed,
        (surface) => surface.detailOffsetM[0],
      );
      detailOffsetsM[positionOffset + 1] = average(
        conformed,
        (surface) => surface.detailOffsetM[1],
      );
      detailOffsetsM[positionOffset + 2] = average(
        conformed,
        (surface) => surface.detailOffsetM[2],
      );
    }
    if (oceanSurfaceOffsetsM) {
      oceanSurfaceOffsetsM[positionOffset] = average(
        conformed,
        (surface) => surface.oceanSurfaceOffsetM[0],
      );
      oceanSurfaceOffsetsM[positionOffset + 1] = average(
        conformed,
        (surface) => surface.oceanSurfaceOffsetM[1],
      );
      oceanSurfaceOffsetsM[positionOffset + 2] = average(
        conformed,
        (surface) => surface.oceanSurfaceOffsetM[2],
      );
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
      if (detailOffsetsM) {
        detailOffsetsM.set(
          detailOffsetsM.subarray(vertex * 3, vertex * 3 + 3),
          duplicate * 3,
        );
      }
      if (oceanSurfaceOffsetsM) {
        oceanSurfaceOffsetsM.set(
          oceanSurfaceOffsetsM.subarray(vertex * 3, vertex * 3 + 3),
          duplicate * 3,
        );
      }
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
    (detailOffsetsM?.byteLength ?? 0) +
    (oceanSurfaceOffsetsM?.byteLength ?? 0) +
    skirtEdges.byteLength +
    indices.byteLength;
  return {
    positions,
    normals,
    uvs,
    heightUvs,
    detailHeightsM,
    ...(detailOffsetsM ? { detailOffsetsM } : {}),
    ...(oceanSurfaceOffsetsM ? { oceanSurfaceOffsetsM } : {}),
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
  const requiredSources = [
    request.address,
    ...Object.values(request.edgeConstraints ?? {}).map(
      (constraint) => constraint.address,
    ),
  ].flatMap(terrainSourceDependencies);
  const missingSource = requiredSources.find(
    (address) => !decodedHeights(address),
  );
  if (missingSource) {
    worker.postMessage({
      type: "error",
      requestId: request.requestId,
      generation: request.generation,
      address: request.address,
      message: "The decoded elevation tile is no longer cached.",
      missing: true,
      missingAddress: missingSource,
    });
    return;
  }
  try {
    const selected = regularGridMesh(request.segments);
    const enabledSkirtEdges =
      request.includeSkirts === false
        ? { north: 0, east: 0, south: 0, west: 0 }
        : request.skirtEdges ??
          { north: 1, east: 1, south: 1, west: 1 };
    const geometry = buildFinalGeometry(
      request.address,
      selected.vertices,
      selected.triangles,
      enabledSkirtEdges,
      request.edgeConstraints ?? {},
      request.includeDetailOffsets ?? false,
    );
    const result: LocalTerrainWorkerResult = {
      type: "mesh",
      requestId: request.requestId,
      generation: request.generation,
      address: request.address,
      requestedSegments: request.segments,
      actualSegments: request.segments,
      ...geometry,
    };
    const transfer: Transferable[] = [
      result.positions.buffer,
      result.normals.buffer,
      result.uvs.buffer,
      result.heightUvs.buffer,
      result.detailHeightsM.buffer,
      result.skirtEdges.buffer,
      result.indices.buffer,
      result.boundingCentre.buffer,
    ];
    if (result.detailOffsetsM) {
      transfer.push(result.detailOffsetsM.buffer);
    }
    if (result.oceanSurfaceOffsetsM) {
      transfer.push(result.oceanSurfaceOffsetsM.buffer);
    }
    worker.postMessage(result, transfer);
  } catch (error) {
    worker.postMessage({
      type: "error",
      requestId: request.requestId,
      generation: request.generation,
      address: request.address,
      message:
        error instanceof Error ? error.message : "Terrain mesh generation failed.",
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
