import * as THREE from "three";
import {
  amazonForestOutlineColor,
  normalizeAmazonForestOutlineYears,
} from "./amazon-forest-outline-control.js";
import {
  decodeSurfacePolylines,
  surfacePolylineLineSegmentPositions,
} from "./surface-polyline-format.js";

interface OutlineManifestRecord {
  readonly url: string;
}

interface OutlineManifestYear {
  readonly year: number;
  readonly lods: Readonly<Record<string, OutlineManifestRecord>>;
}

interface OutlineManifest {
  readonly schema: string;
  readonly years: readonly OutlineManifestYear[];
}

/** Loads the small, continent-scale POC outlines only when the user enables them. */
export class AmazonForestOutlineLayer {
  readonly group = new THREE.Group();
  private readonly manifestUrl: URL;
  private readonly lines = new Map<number, THREE.LineSegments>();
  private readonly requests = new Map<number, Promise<THREE.LineSegments>>();
  private manifestRequest: Promise<OutlineManifest> | undefined;
  private displayGeneration = 0;
  private visibleYears: readonly number[] = [];

  constructor(manifestUrl: string, baseUrl = window.location.href) {
    this.manifestUrl = new URL(manifestUrl, baseUrl);
    this.group.name = "amazon-forest-outlines";
    this.group.visible = false;
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
    const previousYears = this.visibleYears;
    this.group.visible = false;
    for (const [year, line] of this.lines) line.visible = years.includes(year);
    if (years.length === 0) {
      this.visibleYears = [];
      return;
    }

    try {
      await Promise.all(years.map((year) => this.loadYear(year)));
    } catch (error) {
      if (generation === this.displayGeneration) {
        for (const [year, line] of this.lines) {
          line.visible = previousYears.includes(year);
        }
        this.group.visible = previousYears.length > 0;
      }
      throw error;
    }
    if (generation !== this.displayGeneration) return;
    for (const [year, line] of this.lines) line.visible = years.includes(year);
    this.visibleYears = years;
    this.group.visible = true;
  }

  dispose(): void {
    for (const line of this.lines.values()) {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.lines.clear();
    this.requests.clear();
    this.group.clear();
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
          !Array.isArray(manifest.years)
        ) {
          throw new Error("Amazon forest manifest has an unsupported format.");
        }
        return manifest;
      });
    return this.manifestRequest;
  }

  private loadYear(year: number): Promise<THREE.LineSegments> {
    const loaded = this.lines.get(year);
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
        const data = decodeSurfacePolylines(await response.arrayBuffer());
        if (data.year !== year) {
          throw new Error(`Amazon forest outline expected ${year} but contains ${data.year}.`);
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          "position",
          new THREE.BufferAttribute(
            surfacePolylineLineSegmentPositions(data, 0.0015),
            3,
          ),
        );
        geometry.computeBoundingSphere();
        const material = new THREE.LineBasicMaterial({
          color: amazonForestOutlineColor(
            year,
            manifest.years.map(({ year: manifestYear }) => manifestYear),
          ),
          depthTest: true,
          depthWrite: false,
          opacity: 0.94,
          transparent: true,
          toneMapped: false,
        });
        const line = new THREE.LineSegments(geometry, material);
        line.name = `amazon-forest-outline-${year}`;
        line.renderOrder = 20;
        this.lines.set(year, line);
        this.group.add(line);
        return line;
      })
      .finally(() => this.requests.delete(year));
    this.requests.set(year, request);
    return request;
  }
}
