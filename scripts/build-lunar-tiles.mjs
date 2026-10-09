#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const imagerySource = option("--imagery");
const elevationSource = option("--elevation");
const output = option("--output");
const maxZoom = Number(option("--max-zoom") ?? 5);
if (
  (!imagerySource && !elevationSource) || !output ||
  !Number.isInteger(maxZoom) || maxZoom < 0
) {
  console.error(
    "Usage: npm run lunar:tiles -- [--imagery color.tif] [--elevation ldem_64_uint.tif] --output ./tiles [--max-zoom 5]",
  );
  process.exit(2);
}

const destination = resolve(output);
const scratch = mkdtempSync(join(tmpdir(), "pas-de-geant-lunar-"));
const size = String(512 * 2 ** maxZoom);
const imagerySquare = join(scratch, "imagery-square.tif");
const elevationSquare = join(scratch, "elevation-square.tif");
const elevationRgb = join(scratch, "elevation-rg16.tif");

function run(command, argumentsValue) {
  console.log(command, ...argumentsValue);
  execFileSync(command, argumentsValue, { stdio: "inherit" });
}

// The geographic runtime pyramid has equal X/Y tile counts. The deliberate
// square resample stores linear longitude and latitude without Mercator's
// missing poles; the sphere geometry restores the correct angular mapping.
const common = [
  "--profile=raster", "--xyz", `--zoom=0-${maxZoom}`, "--tilesize=512",
  "--webviewer=none", "--processes=1",
];
try {
  if (imagerySource) {
    mkdirSync(join(destination, "imagery"), { recursive: true });
    run("gdal_translate", [
      "-of", "GTiff", "-outsize", size, size, "-r", "cubic",
      resolve(imagerySource), imagerySquare,
    ]);
    run("gdal2tiles.py", [
      ...common, "--resampling=average", imagerySquare,
      join(destination, "imagery"),
    ]);
    console.log("Imagery template:   <base>/imagery/{z}/{x}/{y}.png");
  }

  if (elevationSource) {
    mkdirSync(join(destination, "elevation"), { recursive: true });
    run("gdal_translate", [
      "-of", "GTiff", "-outsize", size, size, "-r", "bilinear",
      resolve(elevationSource), elevationSquare,
    ]);

    // NASA's unsigned LOLA global DEM uses h = value * 0.5 - 10,000 metres.
    // Preserve every source bit in PNG R/G so the vertex shader reconstructs it.
    run("gdal_calc.py", [
      "-A", elevationSquare,
      "--calc=floor(A/256)", "--calc=A%256", "--calc=0*A",
      "--type=Byte", "--format=GTiff", "--co=INTERLEAVE=PIXEL",
      `--outfile=${elevationRgb}`,
    ]);
    run("gdal2tiles.py", [
      ...common, "--resampling=near", elevationRgb,
      join(destination, "elevation"),
    ]);
    console.log("Elevation template: <base>/elevation/{z}/{x}/{y}.png");
  }
  console.log(`Lunar XYZ tiles written beneath ${destination}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
