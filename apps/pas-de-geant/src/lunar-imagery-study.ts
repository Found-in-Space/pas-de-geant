import { APOLLO_REGIONAL_IMAGERY } from "./lunar-regional-imagery-metadata.js";
export { APOLLO_STUDY_SITES, type ApolloStudySite } from "./lunar-sites.js";
import type { ApolloStudySite } from "./lunar-sites.js";

/** The same lunar sphere and geographic XYZ grid as the published WAC product. */
export const LUNAR_STUDY_RADIUS_METRES = 1_737_400;
export const LUNAR_STUDY_TILE_WIDTH = 512;
export const LUNAR_STUDY_TILE_HEIGHT = 256;
export const LROC_WMS_URL = "https://wms.im-ldi.com/";
export const APOLLO_COORDINATE_SOURCE =
  "https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_sites.html";

export interface ApolloImageryVersion {
  readonly id: string;
  readonly label: string;
  readonly layer: string;
  readonly description: string;
  readonly regional?: boolean;
  readonly sourceUrl?: string;
  readonly pyramid?: boolean;
}

/** Imagery layers advertised by Lunaserv GetCapabilities, checked 2026-10-11.
 * These are service-rendered previews, not a claim of identity with a PDS TIFF.
 */
export function apolloImageryVersions(mission: number): ApolloImageryVersion[] {
  const prefix = `luna_apollo_${mission}_`;
  const versions: ApolloImageryVersion[] = [
    {
      id: "high-resolution", label: "High-resolution site image",
      layer: `${prefix}high_resolution_nac_mosaic`,
      description: "A close view of the landing site. Coverage and native sampling vary by mission.",
    },
    {
      id: "high-sun", label: "High-Sun mosaic",
      layer: `${prefix}high_sun_nac_mosaic`,
      description: "Shorter shadows emphasise surface brightness. Useful for comparing the texture join.",
    },
    {
      id: "low-sun", label: "Low-Sun mosaic",
      layer: `${prefix}low_sun_nac_mosaic`,
      description: "Longer shadows emphasise craters and relief. Inspect the lighting difference against WAC.",
    },
  ];
  if (mission === 11) versions.unshift({
    id: "pyramid", label: "100 km variable-resolution pyramid", layer: "apollo11-variable-resolution-preview",
    pyramid: true, sourceUrl: "https://darts.isas.jaxa.jp/en/datasets/sln-l-tc-5-ortho-map-seamless-v2.0",
    description: "Kaguya context across 100 × 100 km (8.4 m/px), regional NAC within 25 km (1.3 m/px), and landing-site NAC within 5 km (0.52 m/px). Actual source masks determine coverage; gaps retain coarser imagery. Seams and lighting are unadjusted.",
  });
  const region = APOLLO_REGIONAL_IMAGERY[mission];
  if (region) versions.push({
    id: "regional", label: `Regional ${region.illumination === "high-sun" ? "High-Sun" : "Low-Sun"} · ${Number(region.metresPerPixel.toFixed(2))} m/px`,
    layer: region.product,
    regional: true,
    sourceUrl: region.sourceUrl,
    description: `Archive regional preview at ${Number(region.metresPerPixel.toFixed(2))} m/pixel, with a raster about ${Math.round(region.width * region.metresPerPixel / 1000)} × ${Math.round(region.height * region.metresPerPixel / 1000)} km. Coverage is irregular; the base fills gaps.`,
  });
  if (mission === 11 || mission === 14) versions.push({
    id: "moderate-sun", label: "Moderate-Sun mosaic",
    layer: `${prefix}moderate_sun_nac_mosaic`,
    description: "An additional illumination alternative served by LROC.",
  });
  if (mission === 15) versions.push(
    {
      id: "roi-high-sun", label: "Regional High-Sun mosaic",
      layer: `${prefix}roi_high_sun`,
      description: "A regional image for inspecting the landscape around the landing site.",
    },
    {
      id: "roi-low-sun", label: "Regional Low-Sun mosaic",
      layer: `${prefix}roi_low_sun`,
      description: "A regional illumination alternative around the landing site.",
    },
  );
  if (mission === 16) versions.push({
    id: "orthomosaic", label: "50 cm orthomosaic",
    layer: `${prefix}nac_dtm_mosaic_50cm`,
    description: "The imagery mosaic accompanying the NAC stereo terrain product, advertised at 50 cm/pixel.",
  });
  return versions;
}

export type GeographicBounds = readonly [west: number, south: number, east: number, north: number];

export function lunarStudyAreaBounds(site: ApolloStudySite, kilometres: number): GeographicBounds {
  const latitudeHalf = kilometres * 1000 / 2 * 180 / (Math.PI * LUNAR_STUDY_RADIUS_METRES);
  const longitudeHalf = latitudeHalf / Math.cos(site.latitude * Math.PI / 180);
  return [site.longitude - longitudeHalf, site.latitude - latitudeHalf, site.longitude + longitudeHalf, site.latitude + latitudeHalf];
}

export function lunarStudyTileBounds(z: number, x: number, y: number): GeographicBounds {
  const count = 2 ** z;
  return [
    -180 + x * 360 / count,
    90 - (y + 1) * 180 / count,
    -180 + (x + 1) * 360 / count,
    90 - y * 180 / count,
  ];
}

export function lunarStudyWmsUrl(
  layer: string,
  bounds: GeographicBounds,
  width = LUNAR_STUDY_TILE_WIDTH,
  height = LUNAR_STUDY_TILE_HEIGHT,
): string {
  const url = new URL(LROC_WMS_URL);
  url.search = new URLSearchParams({
    SERVICE: "WMS", VERSION: "1.1.1", REQUEST: "GetMap",
    LAYERS: layer, STYLES: "", SRS: "IAU2000:30100",
    BBOX: bounds.join(","), WIDTH: String(width), HEIGHT: String(height),
    FORMAT: "image/png", TRANSPARENT: "TRUE",
  }).toString();
  return url.href;
}

/** Apply the terrain shader's linear-light exponent to encoded display pixels.
 * Lighting and the 3D viewer's ACES exposure are intentionally absent here.
 */
export function lunarStudyToneTable(exponent: number, gain = 1, contrast = 1, offset = 0): Uint8ClampedArray {
  const table = new Uint8ClampedArray(256);
  for (let index = 0; index < table.length; index++) {
    const encoded = index / 255;
    const linear = lunarStudyLinearLight(encoded);
    const curved = Math.max(0, Math.min(1, (linear ** exponent * gain - 0.18) * contrast + 0.18 + offset));
    const output = curved <= 0.0031308 ? 12.92 * curved : 1.055 * curved ** (1 / 2.4) - 0.055;
    table[index] = Math.round(output * 255);
  }
  return table;
}

export function lunarStudyLinearLight(encoded: number): number {
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}

/** A robust display match, using corresponding terrain samples in linear light.
 * The median ratio leaves the candidate's texture contrast intact. Fully
 * transparent and clipped black/white samples carry no useful brightness ratio.
 */
export function lunarStudyBrightnessMatch(
  candidate: ArrayLike<number>, base: ArrayLike<number>, exponent: number,
): { gain: number; samples: number; beforeError: number; afterError: number } | undefined {
  const pairs: [number, number][] = [];
  for (let index = 0; index < candidate.length; index += 4) {
    if (candidate[index + 3]! < 250 || base[index + 3]! < 250) continue;
    const candidateGray = Math.round(0.2126 * candidate[index]! + 0.7152 * candidate[index + 1]! + 0.0722 * candidate[index + 2]!) / 255;
    const baseGray = Math.round(0.2126 * base[index]! + 0.7152 * base[index + 1]! + 0.0722 * base[index + 2]!) / 255;
    if (candidateGray <= 0 || candidateGray >= 1 || baseGray <= 0 || baseGray >= 1) continue;
    pairs.push([lunarStudyLinearLight(candidateGray) ** exponent, lunarStudyLinearLight(baseGray) ** exponent]);
  }
  if (!pairs.length) return undefined;
  const median = (values: number[]): number => {
    values.sort((first, second) => first - second);
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
  };
  const gain = median(pairs.map(([source, target]) => target / source));
  return {
    gain, samples: pairs.length,
    beforeError: median(pairs.map(([source, target]) => Math.abs(source - target))),
    afterError: median(pairs.map(([source, target]) => Math.abs(source * gain - target))),
  };
}

export function lunarStudyMetresPerPixel(latitude: number, zoom: number): number {
  return 2 * Math.PI * LUNAR_STUDY_RADIUS_METRES * Math.cos(latitude * Math.PI / 180) /
    (LUNAR_STUDY_TILE_WIDTH * 2 ** zoom);
}
