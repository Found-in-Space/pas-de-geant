#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const HEADER_BYTES = 40;
const FORMAT_VERSION = 1;
const MAGIC = Uint8Array.from([0x50, 0x44, 0x47, 0x4c, 0x49, 0x4e, 0x45, 0]);
const DEFAULT_FOREST_CLASSES = [1, 3, 4, 5, 6];
const DEFAULT_FIRST_YEAR = 1985;
const DEFAULT_MAX_SEGMENT_METRES = 25_000;
const EARTH_MEAN_RADIUS_METRES = 6_371_008.8;

const HELP = `Build render-ready Amazon forest outlines from MapBiomas GeoTIFFs.

Usage:
  npm run amazon:outlines -- \\
    --input-dir /data/mapbiomas-amazonia-collection-6 \\
    --output apps/pas-de-geant/public/data/amazon-forest \\
    --years 1985,1995,2005,2015,2023 \\
    --lod globe:4000:8000 \\
    --lod regional:500:1000

Inputs:
  --input PATH               Add a GeoTIFF tile (repeatable).
  --input-dir PATH           Add every .tif/.tiff beneath a directory (repeatable).
  --year-input YEAR=PATH     Add a single-band annual GeoTIFF (repeatable). This
                             cannot be combined with --input or --input-dir.
  --output PATH              Output directory (required).
  --first-year YEAR          Year represented by GDAL band 1 (default: 1985).
  --years SPEC               Comma-separated years/ranges, e.g. 1985,2000-2005.
                             Omit to convert every raster band.
  --forest-classes IDS       Pixel values treated as forest (default: 1,3,4,5,6).

Outline LODs:
  --lod ID:RESAMPLE:SIMPLIFY Add an output LOD (repeatable, required). Distances
                             are metres. RESAMPLE is the working raster cell size;
                             SIMPLIFY is the topology-preserving line tolerance.
  --max-segment-metres N     Densify long simplified segments so lines follow the
                             globe (default: 25000; 0 disables densification).

Output:
  --source-label TEXT        Human-readable source name stored in the manifest.
  --keep-geojson             Retain newline-delimited GeoJSON beside binary files.
  --dry-run                  Print GDAL commands without writing anything. Requires
                             --years because raster metadata is not inspected.
  --help                     Show this help.

MapBiomas Amazonia Collection 6 uses 1 for aggregated natural forest and its
subclasses 3 (forest formation), 4 (savanna/open forest), 5 (mangrove), and 6
(flooded forest). Pass --forest-classes for another collection or definition.
`;

function fail(message) {
  console.error(message);
  process.exit(2);
}

function optionValues(argumentsValue, name) {
  const values = [];
  for (let index = 0; index < argumentsValue.length; index += 1) {
    if (argumentsValue[index] !== name) continue;
    const value = argumentsValue[index + 1];
    if (!value || value.startsWith("--")) fail(`${name} requires a value.`);
    values.push(value);
    index += 1;
  }
  return values;
}

function option(argumentsValue, name) {
  const values = optionValues(argumentsValue, name);
  if (values.length > 1) fail(`${name} may only be specified once.`);
  return values[0];
}

function parsePositiveInteger(value, label, { allowZero = false } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    fail(`${label} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return parsed;
}

function parseClassValues(value) {
  const values = (value ?? DEFAULT_FOREST_CLASSES.join(","))
    .split(",")
    .map((entry) => parsePositiveInteger(entry.trim(), "--forest-classes value", {
      allowZero: true,
    }));
  if (values.length === 0) fail("--forest-classes must contain at least one value.");
  return [...new Set(values)].sort((left, right) => left - right);
}

function parseYears(value) {
  if (!value) return undefined;
  const years = new Set();
  for (const part of value.split(",")) {
    const range = part.trim().match(/^(\d{4})(?:-(\d{4}))?$/);
    if (!range) fail(`Invalid --years entry: ${part}`);
    const first = Number(range[1]);
    const last = Number(range[2] ?? range[1]);
    if (last < first) fail(`Descending --years range is not supported: ${part}`);
    for (let year = first; year <= last; year += 1) years.add(year);
  }
  return [...years].sort((left, right) => left - right);
}

function parseLod(value) {
  const [id, resolutionValue, simplificationValue, ...extra] = value.split(":");
  if (!id || !/^[a-z0-9][a-z0-9_-]*$/i.test(id) || extra.length > 0) {
    fail(`Invalid --lod '${value}'; expected ID:RESAMPLE_METRES:SIMPLIFY_METRES.`);
  }
  const resolutionMetres = Number(resolutionValue);
  const simplificationMetres = Number(simplificationValue);
  if (!Number.isFinite(resolutionMetres) || resolutionMetres <= 0) {
    fail(`Invalid resampling distance in --lod '${value}'.`);
  }
  if (!Number.isFinite(simplificationMetres) || simplificationMetres < 0) {
    fail(`Invalid simplification distance in --lod '${value}'.`);
  }
  return { id, resolutionMetres, simplificationMetres };
}

function parseYearInput(value) {
  const separator = value.indexOf("=");
  if (separator < 1 || separator === value.length - 1) {
    fail(`Invalid --year-input '${value}'; expected YEAR=PATH.`);
  }
  const year = parsePositiveInteger(
    value.slice(0, separator),
    "--year-input year",
  );
  return { year, path: resolve(value.slice(separator + 1)) };
}

function collectGeoTiffs(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectGeoTiffs(path));
    if (entry.isFile() && /\.tiff?$/i.test(entry.name)) files.push(path);
  }
  return files;
}

function shellQuote(value) {
  return /^[a-zA-Z0-9_./:=,-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

function commandText(command, argumentsValue) {
  return [command, ...argumentsValue].map(shellQuote).join(" ");
}

function requireCommand(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  if (result.error?.code === "ENOENT") {
    fail(`${command} is required. Install GDAL and make its command-line tools available on PATH.`);
  }
}

function run(command, argumentsValue, dryRun) {
  console.log(commandText(command, argumentsValue));
  if (dryRun) return "";
  return execFileSync(command, argumentsValue, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function vectorForCoordinate([longitudeDegrees, latitudeDegrees]) {
  const longitude = longitudeDegrees * Math.PI / 180;
  const latitude = latitudeDegrees * Math.PI / 180;
  const cosineLatitude = Math.cos(latitude);
  return [
    cosineLatitude * Math.cos(longitude),
    cosineLatitude * Math.sin(longitude),
    Math.sin(latitude),
  ];
}

function coordinateForVector([x, y, z]) {
  return [
    Math.atan2(y, x) * 180 / Math.PI,
    Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI,
  ];
}

function densifyLine(coordinates, maximumSegmentMetres) {
  if (maximumSegmentMetres <= 0 || coordinates.length < 2) return coordinates;
  const densified = [coordinates[0]];
  for (let index = 1; index < coordinates.length; index += 1) {
    const start = coordinates[index - 1];
    const end = coordinates[index];
    const startVector = vectorForCoordinate(start);
    const endVector = vectorForCoordinate(end);
    const dot = Math.max(-1, Math.min(1,
      startVector[0] * endVector[0] +
      startVector[1] * endVector[1] +
      startVector[2] * endVector[2],
    ));
    const angle = Math.acos(dot);
    const segmentCount = Math.max(
      1,
      Math.ceil(angle * EARTH_MEAN_RADIUS_METRES / maximumSegmentMetres),
    );
    const sineAngle = Math.sin(angle);
    for (let segment = 1; segment < segmentCount; segment += 1) {
      const fraction = segment / segmentCount;
      if (sineAngle < 1e-12) {
        densified.push([
          start[0] + (end[0] - start[0]) * fraction,
          start[1] + (end[1] - start[1]) * fraction,
        ]);
        continue;
      }
      const startWeight = Math.sin((1 - fraction) * angle) / sineAngle;
      const endWeight = Math.sin(fraction * angle) / sineAngle;
      densified.push(coordinateForVector([
        startVector[0] * startWeight + endVector[0] * endWeight,
        startVector[1] * startWeight + endVector[1] * endWeight,
        startVector[2] * startWeight + endVector[2] * endWeight,
      ]));
    }
    densified.push(end);
  }
  return densified;
}

function geometryLines(geometry) {
  if (!geometry) return [];
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  if (geometry.type === "GeometryCollection") {
    return geometry.geometries.flatMap(geometryLines);
  }
  throw new Error(`Unexpected contour geometry: ${geometry.type}`);
}

async function packageGeoJsonSequence(
  input,
  output,
  year,
  maximumSegmentMetres,
) {
  const temporaryOutput = `${output}.tmp`;
  const descriptor = openSync(temporaryOutput, "w");
  writeSync(descriptor, Buffer.alloc(HEADER_BYTES));
  let packageComplete = false;
  let lineCount = 0;
  let pointCount = 0;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  try {
    const records = createInterface({
      input: createReadStream(input, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const rawRecord of records) {
      const record = rawRecord.replace(/^\u001e/, "").trim();
      if (!record) continue;
      const feature = JSON.parse(record);
      for (const sourceLine of geometryLines(feature.geometry)) {
        const validLine = sourceLine.filter((coordinate) =>
          Array.isArray(coordinate) &&
          coordinate.length >= 2 &&
          Number.isFinite(coordinate[0]) &&
          Number.isFinite(coordinate[1])
        );
        if (validLine.length < 2) continue;
        const line = densifyLine(validLine, maximumSegmentMetres);
        const recordBuffer = Buffer.allocUnsafe(4 + line.length * 8);
        recordBuffer.writeUInt32LE(line.length, 0);
        for (let index = 0; index < line.length; index += 1) {
          const coordinate = line[index];
          const longitude = coordinate[0];
          const latitude = coordinate[1];
          recordBuffer.writeFloatLE(longitude, 4 + index * 8);
          recordBuffer.writeFloatLE(latitude, 8 + index * 8);
          west = Math.min(west, longitude);
          south = Math.min(south, latitude);
          east = Math.max(east, longitude);
          north = Math.max(north, latitude);
        }
        writeSync(descriptor, recordBuffer);
        lineCount += 1;
        pointCount += line.length;
      }
    }

    const header = Buffer.alloc(HEADER_BYTES);
    MAGIC.forEach((value, index) => header.writeUInt8(value, index));
    header.writeUInt32LE(FORMAT_VERSION, 8);
    header.writeInt32LE(year, 12);
    header.writeUInt32LE(lineCount, 16);
    header.writeUInt32LE(pointCount, 20);
    const bounds = lineCount === 0 ? [0, 0, 0, 0] : [west, south, east, north];
    bounds.forEach((value, index) => header.writeFloatLE(value, 24 + index * 4));
    writeSync(descriptor, header, 0, header.length, 0);
    packageComplete = true;
  } finally {
    closeSync(descriptor);
    if (!packageComplete) rmSync(temporaryOutput, { force: true });
  }
  renameSync(temporaryOutput, output);
  return {
    lineCount,
    pointCount,
    bounds: lineCount === 0 ? [0, 0, 0, 0] : [west, south, east, north],
    byteLength: statSync(output).size,
  };
}

const argumentsValue = process.argv.slice(2);
if (argumentsValue.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}

const knownFlags = new Set([
  "--input", "--input-dir", "--year-input", "--output", "--first-year", "--years",
  "--forest-classes", "--lod", "--max-segment-metres", "--source-label",
  "--keep-geojson", "--dry-run", "--help",
]);
for (const argument of argumentsValue) {
  if (argument.startsWith("--") && !knownFlags.has(argument)) {
    fail(`Unknown option: ${argument}`);
  }
}

const dryRun = argumentsValue.includes("--dry-run");
const keepGeoJson = argumentsValue.includes("--keep-geojson");
const outputValue = option(argumentsValue, "--output");
if (!outputValue) fail("--output is required. Use --help for an example.");
const outputDirectory = resolve(outputValue);
const firstYear = parsePositiveInteger(
  option(argumentsValue, "--first-year") ?? String(DEFAULT_FIRST_YEAR),
  "--first-year",
);
const selectedYears = parseYears(option(argumentsValue, "--years"));
const forestClasses = parseClassValues(option(argumentsValue, "--forest-classes"));
const maximumSegmentMetres = parsePositiveInteger(
  option(argumentsValue, "--max-segment-metres") ?? String(DEFAULT_MAX_SEGMENT_METRES),
  "--max-segment-metres",
  { allowZero: true },
);
const lods = optionValues(argumentsValue, "--lod").map(parseLod);
if (lods.length === 0) fail("At least one --lod is required. Use --help for examples.");
if (new Set(lods.map((lod) => lod.id)).size !== lods.length) {
  fail("Every --lod ID must be unique.");
}

const tiledInputFiles = [
  ...optionValues(argumentsValue, "--input").map((value) => resolve(value)),
  ...optionValues(argumentsValue, "--input-dir")
    .map((value) => resolve(value))
    .flatMap((directory) => {
      if (!existsSync(directory)) fail(`Input directory does not exist: ${directory}`);
      return collectGeoTiffs(directory);
    }),
];
const uniqueTiledInputFiles = [...new Set(tiledInputFiles)].sort();
const annualInputs = new Map();
for (const annualInput of optionValues(argumentsValue, "--year-input").map(parseYearInput)) {
  if (annualInputs.has(annualInput.year)) {
    fail(`--year-input specifies year ${annualInput.year} more than once.`);
  }
  annualInputs.set(annualInput.year, annualInput.path);
}
if (uniqueTiledInputFiles.length > 0 && annualInputs.size > 0) {
  fail("--year-input cannot be combined with --input or --input-dir.");
}
if (uniqueTiledInputFiles.length === 0 && annualInputs.size === 0) {
  fail("Add --year-input, --input, or --input-dir.");
}
if (dryRun && annualInputs.size === 0 && !selectedYears) {
  fail("A tiled-input --dry-run requires an explicit --years value.");
}
const uniqueInputFiles = annualInputs.size > 0
  ? [...annualInputs.values()].sort()
  : uniqueTiledInputFiles;
for (const inputFile of uniqueInputFiles) {
  if (!existsSync(inputFile)) fail(`Input file does not exist: ${inputFile}`);
}

if (!dryRun) {
  const commands = ["gdal_calc.py", "gdalwarp", "gdal_contour", "ogr2ogr"];
  if (annualInputs.size === 0) commands.push("gdalbuildvrt", "gdalinfo");
  for (const command of commands) requireCommand(command);
}

const scratch = dryRun
  ? "/tmp/pas-de-geant-amazon-dry-run"
  : mkdtempSync(join(tmpdir(), "pas-de-geant-amazon-"));
try {
  let mosaic;
  if (annualInputs.size === 0) {
    mosaic = join(scratch, "mapbiomas.vrt");
    run(
      "gdalbuildvrt",
      ["-overwrite", "-resolution", "highest", mosaic, ...uniqueInputFiles],
      dryRun,
    );
  }

  let bandCount;
  if (!dryRun && mosaic) {
    const metadata = JSON.parse(run("gdalinfo", ["-json", mosaic], false));
    bandCount = metadata.bands?.length ?? 0;
    if (bandCount === 0) throw new Error("The input mosaic contains no raster bands.");
  }
  const years = selectedYears ?? (annualInputs.size > 0
    ? [...annualInputs.keys()].sort((left, right) => left - right)
    : Array.from(
      { length: bandCount },
      (_, index) => firstYear + index,
    ));
  for (const year of years) {
    if (annualInputs.size > 0 && !annualInputs.has(year)) {
      throw new Error(`Year ${year} has no matching --year-input.`);
    }
    const band = annualInputs.size > 0 ? 1 : year - firstYear + 1;
    if (band < 1 || (!dryRun && mosaic && band > bandCount)) {
      throw new Error(`Year ${year} maps to unavailable GDAL band ${band}.`);
    }
  }

  if (!dryRun) mkdirSync(outputDirectory, { recursive: true });
  const manifest = {
    schema: "pas-de-geant.surface-polylines/v1",
    coordinateSystem: "EPSG:4326",
    source: {
      label: option(argumentsValue, "--source-label") ?? "MapBiomas Amazonia",
      inputFiles: uniqueInputFiles.map((value) => basename(value)),
      ...(annualInputs.size === 0 ? { firstYear } : { annualFiles: true }),
      forestClasses,
    },
    maximumSegmentMetres,
    lods,
    years: [],
  };

  for (const year of years) {
    const band = annualInputs.size > 0 ? 1 : year - firstYear + 1;
    const sourceRaster = annualInputs.get(year) ?? mosaic;
    if (!sourceRaster) throw new Error(`No source raster resolved for ${year}.`);
    const mask = join(scratch, `forest-${year}.tif`);
    run("gdal_calc.py", [
      "-A", sourceRaster,
      "--A_band", String(band),
      "--calc", `numpy.isin(A,[${forestClasses.join(",")}]).astype(numpy.uint8)`,
      "--hideNoData",
      "--type", "Byte",
      "--NoDataValue", "255",
      "--format", "GTiff",
      "--co", "TILED=YES",
      "--co", "COMPRESS=DEFLATE",
      "--overwrite",
      `--outfile=${mask}`,
    ], dryRun);

    const yearManifest = { year, band, lods: {} };
    for (const lod of lods) {
      const reduced = join(scratch, `${year}-${lod.id}-fraction.tif`);
      const contours = join(scratch, `${year}-${lod.id}-contours.gpkg`);
      const simplified = join(scratch, `${year}-${lod.id}-simplified.gpkg`);
      const geoJsonSequence = join(scratch, `${year}-${lod.id}.geojsonl`);
      run("gdalwarp", [
        "-overwrite",
        "-t_srs", "EPSG:3857",
        "-tr", String(lod.resolutionMetres), String(lod.resolutionMetres),
        "-tap",
        "-r", "average",
        "-srcnodata", "255",
        "-dstnodata", "255",
        "-ot", "Float32",
        "-multi",
        "-wo", "NUM_THREADS=ALL_CPUS",
        "-co", "TILED=YES",
        "-co", "COMPRESS=DEFLATE",
        mask,
        reduced,
      ], dryRun);
      run("gdal_contour", [
        "-q",
        "-f", "GPKG",
        "-nln", "outlines",
        "-fl", "0.5",
        reduced,
        contours,
      ], dryRun);

      let vectorInput = contours;
      if (lod.simplificationMetres > 0) {
        run("ogr2ogr", [
          "-f", "GPKG",
          "-overwrite",
          "-nln", "outlines",
          "-simplify", String(lod.simplificationMetres),
          simplified,
          contours,
          "outlines",
        ], dryRun);
        vectorInput = simplified;
      }
      run("ogr2ogr", [
        "-f", "GeoJSONSeq",
        "-overwrite",
        "-t_srs", "EPSG:4326",
        "-lco", "RS=NO",
        "-lco", "COORDINATE_PRECISION=7",
        geoJsonSequence,
        vectorInput,
        "outlines",
      ], dryRun);

      if (dryRun) continue;
      const yearDirectory = join(outputDirectory, String(year));
      mkdirSync(yearDirectory, { recursive: true });
      const binaryName = `${lod.id}.pdg-lines`;
      const binaryPath = join(yearDirectory, binaryName);
      const statistics = await packageGeoJsonSequence(
        geoJsonSequence,
        binaryPath,
        year,
        maximumSegmentMetres,
      );
      const outputRecord = {
        url: `${year}/${binaryName}`,
        ...statistics,
      };
      if (keepGeoJson) {
        const geoJsonName = `${lod.id}.geojsonl`;
        copyFileSync(geoJsonSequence, join(yearDirectory, geoJsonName));
        outputRecord.geoJsonUrl = `${year}/${geoJsonName}`;
      }
      yearManifest.lods[lod.id] = outputRecord;
      console.log(
        `${year} ${lod.id}: ${statistics.lineCount.toLocaleString()} lines, ` +
        `${statistics.pointCount.toLocaleString()} points, ` +
        `${statistics.byteLength.toLocaleString()} bytes`,
      );
    }
    if (!dryRun) manifest.years.push(yearManifest);
  }

  if (!dryRun) {
    const manifestPath = join(outputDirectory, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Forest outline manifest written to ${manifestPath}`);
  }
} finally {
  if (!dryRun) rmSync(scratch, { recursive: true, force: true });
}
