#!/usr/bin/env node
// Small display fixtures and explicit elevation migration; publication imagery
// belongs to pas-de-geant-texture-pipeline. Outputs here are scratch evidence.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, writeFile, rename, rm, readdir, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const imagery = option("--imagery"), elevation = option("--elevation"), output = option("--output");
const sourceCrs = option("--source-crs");
const projection = option("--projection", "web-mercator");
const maxZoom = Number(option("--max-zoom", "5"));
const radiusMetres = 1_737_400, tileSize = 512;
if ((!imagery && !elevation) || !output || !["geographic", "web-mercator"].includes(projection) || !Number.isSafeInteger(maxZoom) || maxZoom < 0) {
  throw new Error("Usage: npm run lunar:tiles -- [--imagery fixture.tif] [--elevation ldem.tif] --output NEW_DIRECTORY [--source-crs reviewed.wkt] [--projection web-mercator|geographic] [--max-zoom 5]");
}
const grid = { formatVersion: 1, projection, radiusMetres };
const geographicCrs = `+proj=longlat +R=${radiusMetres} +no_defs +type=crs`;
const targetCrs = projection === "geographic" ? geographicCrs : `+proj=merc +lon_0=0 +k=1 +x_0=0 +y_0=0 +R=${radiusMetres} +units=m +no_defs +type=crs`;
const half = Math.PI * radiusMetres;
const extent = projection === "geographic" ? [-180, -90, 180, 90] : [-half, -half, half, half];
const latitudeLimit = projection === "geographic" ? 90 : Math.atan(Math.sinh(Math.PI)) * 180 / Math.PI;
const destination = resolve(output);
await mkdir(dirname(destination), { recursive: true });
const staging = await mkdtemp(join(dirname(destination), ".lunar-grid-staging-"));
const scratch = await mkdtemp(join(tmpdir(), "pas-de-geant-lunar-"));
const commands = [], inputs = [];
function run(command, args) {
  commands.push({ command, args: args.map((a) => {
    let portable = String(a).replaceAll(scratch, "<work>").replaceAll(staging, "<output>");
    for (const path of [imagery, elevation, sourceCrs].filter(Boolean)) portable = portable.replaceAll(resolve(path), `<input>/${basename(path)}`);
    return portable;
  }) });
  return execFileSync(command, args.map(String), { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
}
async function checksum(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function source(path, kind) {
  const info = JSON.parse(run("gdalinfo", ["-json", resolve(path)]));
  const srs = sourceCrs ? resolve(sourceCrs) : info.coordinateSystem?.wkt;
  if (!srs) throw new Error("Supply the reviewed source CRS with --source-crs when it is not embedded.");
  const proj = run("gdalsrsinfo", ["-o", "proj4", srs]);
  const match = proj.match(/\+R=([\d.]+)/);
  if (!match || Number(match[1]) !== radiusMetres) throw new Error("Source CRS must declare the lunar sphere at 1737400 metres.");
  if (kind === "elevation" && (info.bands.length !== 1 || info.bands[0].type !== "UInt16" || info.bands[0].noDataValue !== undefined ||
    (info.bands[0].scale !== undefined && info.bands[0].scale !== 0.5) || (info.bands[0].offset !== undefined && info.bands[0].offset !== -10_000))) {
    throw new Error("Elevation requires complete UInt16 LOLA samples: h = value * 0.5 - 10000 metres.");
  }
  if (kind === "imagery" && (info.bands.some((band) => band.type !== "Byte") || ![1, 3].includes(info.bands.length))) {
    throw new Error("Display fixtures require opaque Byte grayscale or RGB.");
  }
  const dependencies = [];
  for (const file of info.files ?? []) {
    if (resolve(file) !== resolve(path)) dependencies.push({ file: basename(file), sha256: await checksum(file) });
  }
  inputs.push({ kind, file: basename(path), sha256: await checksum(resolve(path)), dependencies,
    raster: { size: info.size, bands: info.bands, geoTransform: info.geoTransform }, sourceCrs: proj.trim(),
    ...(sourceCrs ? { sourceCrsFile: { file: basename(sourceCrs), sha256: await checksum(resolve(sourceCrs)) } } : {}) });
  return srs;
}
async function* files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((first, second) => first.name.localeCompare(second.name, "en"));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile() && entry.name.endsWith(".png")) yield path;
  }
}
async function authenticate(directory) {
  const manifest = join(directory, "checksums.sha256");
  await writeFile(manifest, "");
  let count = 0;
  for await (const path of files(directory)) {
    await appendFile(manifest, `${await checksum(path)}  ${path.slice(directory.length + 1)}\n`);
    count += 1;
  }
  return { count, sha256: await checksum(manifest) };
}
function warp(path, srs, outputPath, type, resampling, target = targetCrs, bounds = extent, dimensions = [tileSize * 2 ** maxZoom, tileSize * 2 ** maxZoom], coverage = false) {
  // Heights are point samples of the bilinear source surface. GDAL's adaptive
  // kernel scale can vary with the requested window at the wrap boundary;
  // fixed scale and exact transforms make global and tile-window values agree.
  run("gdalwarp", ["-overwrite", "-of", "GTiff", "-ot", type, ...(coverage ? ["-dstalpha", "-et", "0", "-wo", "XSCALE=1", "-wo", "YSCALE=1"] : []), "-s_srs", srs, "-t_srs", target, "-te", ...bounds,
    "-ts", ...dimensions, "-r", resampling, "-wm", "128", "-co", "TILED=YES", "-co", "BIGTIFF=IF_SAFER", resolve(path), outputPath]);
}
const tiling = ["--profile=raster", "--xyz", `--zoom=0-${maxZoom}`, `--tilesize=${tileSize}`, "--webviewer=none", "--processes=1"];
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
try {
  if (imagery) {
    const srs = await source(imagery, "imagery"), base = join(scratch, "imagery.tif");
    warp(imagery, srs, base, "Byte", "bilinear");
    await mkdir(join(staging, "imagery"));
    run("gdal2tiles.py", [...tiling, "--resampling=average", base, join(staging, "imagery")]);
    const overview = join(scratch, "base.tif");
    warp(imagery, srs, overview, "Byte", "average", geographicCrs, [-180, -90, 180, 90], [2048, 1024]);
    run("gdal_translate", ["-of", "PNG", overview, join(staging, "base.png")]);
    const payload = await authenticate(join(staging, "imagery"));
    const identity = createHash("sha256").update(JSON.stringify({ grid, inputs, payload })).digest("hex");
    await json(join(staging, "product.json"), { format_version: 2, product_id: "lunar-display-fixture", product_identity_sha256: identity,
      target: { id: "moon", bounds: [-180, -latitudeLimit, 180, latitudeLimit] }, grid,
      tiles: { addressing: "XYZ", matrix: "2^z x 2^z", tile_size: tileSize, minimum_zoom: 0, maximum_zoom: maxZoom,
        format: "png", opaque: true, path_template: "imagery/{z}/{x}/{y}.png" },
      baseTexture: { path: "base.png", projection: "equirectangular", width: 2048, height: 1024, sha256: await checksum(join(staging, "base.png")) },
      payload, scratch: true });
  }
  if (elevation) {
    const srs = await source(elevation, "elevation"), base = join(scratch, "elevation.tif"), raw = join(scratch, "elevation-channels.tif"), encoded = join(scratch, "elevation-rg16.tif");
    warp(elevation, srs, base, "UInt16", "bilinear", targetCrs, extent, undefined, true);
    const warped = JSON.parse(run("gdalinfo", ["-json", "-stats", base]));
    if (warped.bands[1]?.minimum !== 65535) {
      throw new Error("Elevation source does not cover the complete target grid; missing heights cannot be encoded as valid zero samples.");
    }
    run("gdal_calc.py", ["-A", base, "--calc=floor(A/256)", "--calc=A%256", "--calc=0*A", "--type=Byte", "--format=GTiff", "--co=INTERLEAVE=PIXEL", "--co=TILED=YES", "--co=BLOCKXSIZE=512", "--co=BLOCKYSIZE=512", `--outfile=${raw}`]);
    // Every channel value, including 255, is data. Remove gdal_calc's default
    // nodata tag before any tiler interprets it as transparency.
    run("gdal_translate", ["-of", "GTiff", "-a_nodata", "none", "-colorinterp", "red,green,blue", "-co", "TILED=YES", "-co", "BLOCKXSIZE=512", "-co", "BLOCKYSIZE=512", raw, encoded]);
    const directory = join(staging, "elevation");
    await mkdir(directory);
    run("gdal2tiles.py", [...tiling, "--resampling=near", encoded, directory]);
    const payload = await authenticate(directory);
    const identity = createHash("sha256").update(JSON.stringify({ grid, inputs, payload })).digest("hex");
    await json(join(directory, "product.json"), { kind: "elevation-xyz", formatVersion: 2, identity, target: "moon", grid,
      units: "metres", verticalDatum: { kind: "reference-surface", radiusMetres }, encoding: { kind: "rg16", scaleM: 0.5, offsetM: -10_000 },
      tileSize, maximumZoom: maxZoom, elevationBoundsMetres: { minimum: -10_000, maximum: 22_767.5 },
      resampling: { target: "point bilinear UInt16 (0.5 m quantization; exact transform, unit kernel scale)", pyramid: "nearest encoded sample" }, attribution: "NASA LRO / LOLA", payload, scratch: true });
  }
  await json(join(staging, "run.json"), { grid, inputs, commands,
    producerCodeSha256: await checksum(fileURLToPath(import.meta.url)), producerGitSha: run("git", ["rev-parse", "HEAD"]).trim(),
    producerDirty: Boolean(run("git", ["status", "--porcelain"]).trim()), gdalVersion: run("gdalinfo", ["--version"]).trim(), scratch: true });
  await rename(staging, destination);
  console.log(`Lunar ${projection} fixtures/elevation and descriptors written to ${destination}`);
} catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
finally { await rm(scratch, { recursive: true, force: true }); }
