import * as THREE from "three";
import {
  amazonForestOutlineColor,
  normalizeAmazonForestOutlineYears,
} from "./amazon-forest-outline-control.js";
import { EARTH_MEAN_RADIUS_KM } from "@found-in-space/worlds/planet-state";
import {
  decodeSurfacePolylines,
  type SurfacePolylineData,
} from "./surface-polyline-format.js";

interface OutlineManifestRecord {
  readonly url: string;
  readonly bounds: readonly [number, number, number, number];
}

interface OutlineManifestYear {
  readonly year: number;
  readonly lods: Readonly<Record<string, OutlineManifestRecord>>;
}

interface OutlineManifestLod {
  readonly id: string;
  readonly resolutionMetres: number;
}

interface OutlineManifest {
  readonly schema: string;
  readonly lods: readonly OutlineManifestLod[];
  readonly years: readonly OutlineManifestYear[];
}

export interface AmazonForestSurfaceOverlayTarget {
  setSurfaceOverlay(
    texture: THREE.Texture | null,
    uvTransform?: THREE.Vector4,
  ): void;
}

interface OverlayLayout {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
  readonly width: number;
  readonly height: number;
  readonly uvTransform: THREE.Vector4;
}

interface OverlayPaths {
  readonly fill: Path2D;
  readonly stroke: Path2D;
}

const FILL_OPACITY = 0.24;
const STROKE_OPACITY = 0.96;

function finiteBounds(
  value: unknown,
): value is readonly [number, number, number, number] {
  return Array.isArray(value) &&
    value.length === 4 &&
    value.every(Number.isFinite) &&
    value[0]! < value[2]! &&
    value[1]! < value[3]!;
}

function overlayLayout(manifest: OutlineManifest): OverlayLayout {
  const globeLod = manifest.lods.find(({ id }) => id === "globe");
  if (
    !globeLod ||
    !Number.isFinite(globeLod.resolutionMetres) ||
    globeLod.resolutionMetres <= 0
  ) {
    throw new Error("Amazon forest manifest requires a globe LOD resolution.");
  }

  const bounds = manifest.years.map(({ lods, year }) => {
    const record = lods.globe;
    if (!record || !finiteBounds(record.bounds)) {
      throw new Error(`Amazon forest outline ${year} has invalid globe bounds.`);
    }
    return record.bounds;
  });
  if (bounds.length === 0) {
    throw new Error("Amazon forest manifest contains no outline years.");
  }

  const west = Math.min(...bounds.map((value) => value[0]));
  const south = Math.min(...bounds.map((value) => value[1]));
  const east = Math.max(...bounds.map((value) => value[2]));
  const north = Math.max(...bounds.map((value) => value[3]));
  const centreLatitudeRadians = THREE.MathUtils.degToRad((south + north) / 2);
  const metresPerLatitudeDegree = THREE.MathUtils.degToRad(1) *
    EARTH_MEAN_RADIUS_KM * 1_000;
  const metresPerLongitudeDegree = metresPerLatitudeDegree *
    Math.cos(centreLatitudeRadians);
  const longitudePadding = globeLod.resolutionMetres / metresPerLongitudeDegree;
  const latitudePadding = globeLod.resolutionMetres / metresPerLatitudeDegree;
  const paddedWest = west - longitudePadding;
  const paddedSouth = south - latitudePadding;
  const paddedEast = east + longitudePadding;
  const paddedNorth = north + latitudePadding;
  const width = Math.ceil(
    (paddedEast - paddedWest) * metresPerLongitudeDegree /
      globeLod.resolutionMetres,
  );
  const height = Math.ceil(
    (paddedNorth - paddedSouth) * metresPerLatitudeDegree /
      globeLod.resolutionMetres,
  );

  const westUv = (paddedWest + 180) / 360;
  const northUv = (90 - paddedNorth) / 180;
  const longitudeUvSpan = (paddedEast - paddedWest) / 360;
  const latitudeUvSpan = (paddedNorth - paddedSouth) / 180;
  return {
    west: paddedWest,
    south: paddedSouth,
    east: paddedEast,
    north: paddedNorth,
    width,
    height,
    uvTransform: new THREE.Vector4(
      1 / longitudeUvSpan,
      1 / latitudeUvSpan,
      -westUv / longitudeUvSpan,
      -northUv / latitudeUvSpan,
    ),
  };
}

function canvasPoint(
  longitudeDegrees: number,
  latitudeDegrees: number,
  layout: OverlayLayout,
): readonly [number, number] {
  return [
    (longitudeDegrees - layout.west) /
      (layout.east - layout.west) * layout.width,
    (layout.north - latitudeDegrees) /
      (layout.north - layout.south) * layout.height,
  ];
}

function closedLine(line: Float32Array): boolean {
  const finalOffset = line.length - 2;
  return Math.abs(line[0]! - line[finalOffset]!) < 1e-5 &&
    Math.abs(line[1]! - line[finalOffset + 1]!) < 1e-5;
}

function pathsForData(
  data: SurfacePolylineData,
  layout: OverlayLayout,
): OverlayPaths {
  const fill = new Path2D();
  const stroke = new Path2D();
  for (const line of data.lines) {
    const first = canvasPoint(line[0]!, line[1]!, layout);
    stroke.moveTo(first[0], first[1]);
    const isClosed = closedLine(line);
    if (isClosed) fill.moveTo(first[0], first[1]);
    for (let offset = 2; offset < line.length; offset += 2) {
      const next = canvasPoint(line[offset]!, line[offset + 1]!, layout);
      stroke.lineTo(next[0], next[1]);
      if (isClosed) fill.lineTo(next[0], next[1]);
    }
    if (isClosed) {
      fill.closePath();
      stroke.closePath();
    }
  }
  return { fill, stroke };
}

/**
 * Lazily turns the compact contour payloads into one translucent geographic
 * texture. TerrainSurface samples it on the same displaced tiles as imagery.
 */
export class AmazonForestOutlineLayer {
  private readonly manifestUrl: URL;
  private readonly data = new Map<number, SurfacePolylineData>();
  private readonly paths = new Map<number, OverlayPaths>();
  private readonly requests = new Map<number, Promise<SurfacePolylineData>>();
  private manifestRequest: Promise<OutlineManifest> | undefined;
  private layout: OverlayLayout | undefined;
  private canvas: HTMLCanvasElement | undefined;
  private texture: THREE.CanvasTexture | undefined;
  private displayGeneration = 0;
  private visibleYears: readonly number[] = [];

  constructor(
    manifestUrl: string,
    private readonly surface: AmazonForestSurfaceOverlayTarget,
    baseUrl = window.location.href,
  ) {
    this.manifestUrl = new URL(manifestUrl, baseUrl);
  }

  async availableYears(): Promise<readonly number[]> {
    const manifest = await this.manifest();
    return manifest.years.map(({ year }) => year);
  }

  async setYears(yearValues: readonly number[]): Promise<void> {
    const generation = ++this.displayGeneration;
    const manifest = await this.manifest();
    const availableYears = manifest.years.map(({ year }) => year);
    const years = normalizeAmazonForestOutlineYears(yearValues, availableYears);
    if (years.length === 0) {
      this.visibleYears = [];
      this.surface.setSurfaceOverlay(null);
      return;
    }

    await Promise.all(years.map((year) => this.loadYear(year)));
    if (generation !== this.displayGeneration) return;
    this.visibleYears = years;
    this.renderTexture(manifest);
  }

  dispose(): void {
    this.surface.setSurfaceOverlay(null);
    this.texture?.dispose();
    this.texture = undefined;
    this.canvas = undefined;
    this.paths.clear();
    this.data.clear();
    this.requests.clear();
  }

  private manifest(): Promise<OutlineManifest> {
    this.manifestRequest ??= fetch(this.manifestUrl)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Amazon forest manifest request failed (${response.status}).`);
        }
        const manifest = await response.json() as OutlineManifest;
        if (
          manifest.schema !== "pas-de-geant.surface-polylines/v1" ||
          !Array.isArray(manifest.lods) ||
          !Array.isArray(manifest.years)
        ) {
          throw new Error("Amazon forest manifest has an unsupported format.");
        }
        return manifest;
      });
    return this.manifestRequest;
  }

  private loadYear(year: number): Promise<SurfacePolylineData> {
    const loaded = this.data.get(year);
    if (loaded) return Promise.resolve(loaded);
    const pending = this.requests.get(year);
    if (pending) return pending;

    const request = this.manifest()
      .then(async (manifest) => {
        const yearRecord = manifest.years.find((record) => record.year === year);
        const outlineRecord = yearRecord?.lods.globe;
        if (!outlineRecord) throw new Error(`Amazon forest outline ${year} is unavailable.`);
        const response = await fetch(new URL(outlineRecord.url, this.manifestUrl));
        if (!response.ok) {
          throw new Error(`Amazon forest outline ${year} request failed (${response.status}).`);
        }
        const decoded = decodeSurfacePolylines(await response.arrayBuffer());
        if (decoded.year !== year) {
          throw new Error(`Amazon forest outline expected ${year} but contains ${decoded.year}.`);
        }
        this.data.set(year, decoded);
        return decoded;
      })
      .finally(() => this.requests.delete(year));
    this.requests.set(year, request);
    return request;
  }

  private renderTexture(manifest: OutlineManifest): void {
    this.layout ??= overlayLayout(manifest);
    const layout = this.layout;
    this.canvas ??= document.createElement("canvas");
    if (this.canvas.width !== layout.width) this.canvas.width = layout.width;
    if (this.canvas.height !== layout.height) this.canvas.height = layout.height;
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("Amazon forest overlay requires a 2D canvas context.");
    context.clearRect(0, 0, layout.width, layout.height);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = 1.5;

    const availableYears = manifest.years.map(({ year }) => year);
    for (const year of this.visibleYears) {
      const data = this.data.get(year);
      if (!data) throw new Error(`Amazon forest outline ${year} is not loaded.`);
      let paths = this.paths.get(year);
      if (!paths) {
        paths = pathsForData(data, layout);
        this.paths.set(year, paths);
      }
      const colour = amazonForestOutlineColor(year, availableYears);
      context.fillStyle = colour;
      context.globalAlpha = FILL_OPACITY;
      context.fill(paths.fill, "evenodd");
      context.strokeStyle = colour;
      context.globalAlpha = STROKE_OPACITY;
      context.stroke(paths.stroke);
    }
    context.globalAlpha = 1;

    if (!this.texture) {
      this.texture = new THREE.CanvasTexture(this.canvas);
      this.texture.name = "amazon-forest-surface-overlay";
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.texture.wrapS = THREE.ClampToEdgeWrapping;
      this.texture.wrapT = THREE.ClampToEdgeWrapping;
      this.texture.magFilter = THREE.LinearFilter;
      this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    }
    this.texture.needsUpdate = true;
    this.surface.setSurfaceOverlay(this.texture, layout.uvTransform);
  }
}
