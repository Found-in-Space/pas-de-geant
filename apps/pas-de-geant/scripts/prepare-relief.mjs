import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { NetCDFReader } from "netcdfjs";

const WIDTH = 4096;
const HEIGHT = 2048;
const OFFSET_METRES = -12000;
const SCALE_METRES = 1;
const SUBSET_URL =
  "https://dap.ceda.ac.uk/thredds/ncss/grid/bodc/gebco/global/" +
  "gebco_2026/ice_surface_elevation/netcdf/GEBCO_2026.nc" +
  "?var=elevation&north=90&west=-180&east=180&south=-90" +
  "&horizStride=21&accept=netcdf";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const outputDirectory = resolve(
  argument("--output-dir") ??
    new URL("../public/relief", import.meta.url).pathname,
);
const sourcePath = argument("--source-netcdf");

async function sourceBuffer() {
  if (sourcePath) return readFile(resolve(sourcePath));
  process.stdout.write("Downloading the official GEBCO_2026 stride-21 subset…\n");
  const response = await fetch(SUBSET_URL);
  if (!response.ok) {
    throw new Error(
      `GEBCO subset download failed: ${response.status} ${response.statusText}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

const reader = new NetCDFReader(await sourceBuffer());
const latitude = reader.getDataVariable("lat").map(Number);
const longitude = reader.getDataVariable("lon").map(Number);
const elevation = reader.getDataVariable("elevation").map(Number);
const sourceWidth = longitude.length;
const sourceHeight = latitude.length;
if (
  sourceWidth < 2 ||
  sourceHeight < 2 ||
  elevation.length !== sourceWidth * sourceHeight
) {
  throw new Error("The GEBCO subset has unexpected dimensions.");
}

const sourceWest = longitude[0];
const sourceEast = longitude[sourceWidth - 1];
const sourceSouth = latitude[0];
const sourceNorth = latitude[sourceHeight - 1];
if (
  sourceWest === undefined ||
  sourceEast === undefined ||
  sourceSouth === undefined ||
  sourceNorth === undefined
) {
  throw new Error("The GEBCO subset is missing coordinate values.");
}

const output = new Uint16Array(WIDTH * HEIGHT);
let minimumElevation = Infinity;
let maximumElevation = -Infinity;
for (let row = 0; row < HEIGHT; row += 1) {
  const targetLatitude = 90 - (row + 0.5) / HEIGHT * 180;
  const sourceY =
    (targetLatitude - sourceSouth) /
    (sourceNorth - sourceSouth) *
    (sourceHeight - 1);
  const y0 = Math.max(0, Math.min(sourceHeight - 1, Math.floor(sourceY)));
  const y1 = Math.min(sourceHeight - 1, y0 + 1);
  const ty = Math.max(0, Math.min(1, sourceY - y0));
  for (let column = 0; column < WIDTH; column += 1) {
    const targetLongitude = -180 + (column + 0.5) / WIDTH * 360;
    const sourceX =
      (targetLongitude - sourceWest) /
      (sourceEast - sourceWest) *
      (sourceWidth - 1);
    const x0 = Math.max(0, Math.min(sourceWidth - 1, Math.floor(sourceX)));
    const x1 = Math.min(sourceWidth - 1, x0 + 1);
    const tx = Math.max(0, Math.min(1, sourceX - x0));
    const southWest = elevation[y0 * sourceWidth + x0] ?? 0;
    const southEast = elevation[y0 * sourceWidth + x1] ?? southWest;
    const northWest = elevation[y1 * sourceWidth + x0] ?? southWest;
    const northEast = elevation[y1 * sourceWidth + x1] ?? northWest;
    const south = southWest + (southEast - southWest) * tx;
    const north = northWest + (northEast - northWest) * tx;
    const value = south + (north - south) * ty;
    minimumElevation = Math.min(minimumElevation, value);
    maximumElevation = Math.max(maximumElevation, value);
    output[row * WIDTH + column] = Math.max(
      0,
      Math.min(
        65535,
        Math.round((value - OFFSET_METRES) / SCALE_METRES),
      ),
    );
  }
}

await mkdir(outputDirectory, { recursive: true });
const data = Buffer.from(
  output.buffer,
  output.byteOffset,
  output.byteLength,
);
const checksum = createHash("sha256").update(data).digest("hex");
const metadata = {
  width: WIDTH,
  height: HEIGHT,
  offsetMetres: OFFSET_METRES,
  scaleMetres: SCALE_METRES,
  byteOrder: "little-endian",
  datum: "Mean Sea Level; grid may contain heterogeneous source datums",
  source:
    "GEBCO Bathymetric Compilation Group 2026 (2026), GEBCO_2026 Grid",
  doi: "10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa",
  checksum: `sha256:${checksum}`,
  sourceRequest: SUBSET_URL,
  sourceDimensions: {
    width: sourceWidth,
    height: sourceHeight,
  },
  outputElevationRangeMetres: [
    Math.round(minimumElevation),
    Math.round(maximumElevation),
  ],
  resampling:
    "bilinear from the official NetCDF subset requested at horizontal stride 21",
};
await Promise.all([
  writeFile(resolve(outputDirectory, "gebco-2026-r16.bin"), data),
  writeFile(
    resolve(outputDirectory, "gebco-2026-r16.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  ),
]);

process.stdout.write(
  `Wrote ${WIDTH}×${HEIGHT} relief (${data.byteLength} bytes, ${checksum}).\n`,
);
