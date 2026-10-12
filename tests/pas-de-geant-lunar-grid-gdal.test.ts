import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, it } from "vitest";
import { displayTextureSource, elevationSource, requireCompatibleSurfaceSources } from "../packages/worlds/src/surface-product.js";
import { celestialBody } from "../packages/worlds/src/solar-system.js";

const installed = (name: string) => (process.env.PATH ?? "").split(delimiter).some((path) => existsSync(join(path, name)));
const tools = ["gdalinfo", "gdalsrsinfo", "gdal_translate", "gdalwarp", "gdal_calc.py", "gdal2tiles.py"];
it.skipIf(!tools.every(installed))("round-trips real GDAL XYZ heights, including negative heights and channel 255", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdg-grid-gdal-"));
  const run = (command: string, args: string[]) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    const values = Buffer.alloc(1024 * 1024 * 2);
    for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) {
      let value = y < 512 ? x < 512 ? 18000 : 20000 : x < 512 ? 22000 : 65535;
      if (x >= 100 && x < 200 && y >= 100 && y < 200) value = 0;
      if (x >= 100 && x < 200 && y >= 300 && y < 400) value = 255;
      values.writeUInt16LE(value, (y * 1024 + x) * 2);
    }
    await writeFile(join(root, "samples.raw"), values);
    const half = Math.PI * 1737400;
    await writeFile(join(root, "height.vrt"), `<VRTDataset rasterXSize="1024" rasterYSize="1024">
<SRS>+proj=merc +R=1737400 +units=m +no_defs +type=crs</SRS>
<GeoTransform>${-half},${2 * half / 1024},0,${half},0,${-2 * half / 1024}</GeoTransform>
<VRTRasterBand dataType="UInt16" band="1" subClass="VRTRawRasterBand">
<SourceFilename relativeToVRT="1">samples.raw</SourceFilename><ImageOffset>0</ImageOffset>
<PixelOffset>2</PixelOffset><LineOffset>2048</LineOffset><ByteOrder>LSB</ByteOrder>
</VRTRasterBand></VRTDataset>`);
    run("gdal_translate", ["-of", "GTiff", join(root, "height.vrt"), join(root, "height.tif")]);
    const output = join(root, "product");
    run(process.execPath, ["scripts/build-lunar-tiles.mjs", "--elevation", join(root, "height.tif"), "--output", output, "--max-zoom", "1"]);
    const descriptor = JSON.parse(readFileSync(join(output, "elevation/product.json"), "utf8"));
    const source = elevationSource(descriptor, celestialBody("moon"));
    expect(source.grid.projection).toBe("web-mercator");
    expect(source.metadata.maxSourceZoom).toBe(1);
    for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 2; tx++) {
      const tile = join(output, `elevation/1/${tx}/${ty}.png`), bands = join(root, `bands-${tx}-${ty}.raw`);
      // The byte assertions below read whole bands; do not inherit PNG pixel interleaving.
      run("gdal_translate", ["-of", "ENVI", "-co", "INTERLEAVE=BSQ", "-b", "1", "-b", "2", tile, bands]);
      const bytes = readFileSync(bands);
      expect(bytes.length).toBe(2 * 512 * 512);
      for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
        const index = y * 512 + x;
        const decoded = bytes[index]! * 256 + bytes[512 * 512 + index]!;
        if (decoded !== values.readUInt16LE(((ty * 512 + y) * 1024 + tx * 512 + x) * 2)) {
          throw new Error(`Height changed at XYZ 1/${tx}/${ty} pixel ${x},${y}`);
        }
      }
    }
    const runEvidence = readFileSync(join(output, "run.json"), "utf8");
    expect(runEvidence).not.toContain(root);
    expect(descriptor.payload.count).toBe(5);
    // Display generation is independent of the numeric height contract.
    run("gdal_translate", ["-ot", "Byte", "-scale", "0", "65535", "0", "255", join(root, "height.tif"), join(root, "display.tif")]);
    const displayOutput = join(root, "display-product");
    run(process.execPath, ["scripts/build-lunar-tiles.mjs", "--imagery", join(root, "display.tif"), "--output", displayOutput, "--max-zoom", "0"]);
    const imagery = displayTextureSource(JSON.parse(readFileSync(join(displayOutput, "product.json"), "utf8")), celestialBody("moon"));
    expect(imagery.basePath).toBe("base.png");
    expect(() => requireCompatibleSurfaceSources(imagery, source)).not.toThrow();
    run("gdal_translate", ["-srcwin", "0", "0", "512", "1024", join(root, "height.tif"), join(root, "partial.tif")]);
    expect(() => run(process.execPath, ["scripts/build-lunar-tiles.mjs", "--elevation", join(root, "partial.tif"),
      "--output", join(root, "partial-product"), "--max-zoom", "0"])).toThrow(/does not cover/);
    expect(existsSync(join(root, "partial-product"))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);

it.skipIf(!tools.every(installed))("samples the documented geographic height surface at Mercator centres near the wrap boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdg-grid-points-"));
  const run = (command: string, args: string[]) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    const width = 512, height = 256;
    const values = Buffer.alloc(width * height * 2);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const value = Math.round(20000 + 8000 * Math.sin(x / 7) * Math.cos(y / 9));
      values.writeUInt16LE(value, (y * width + x) * 2);
    }
    await writeFile(join(root, "samples.raw"), values);
    await writeFile(join(root, "source.vrt"), `<VRTDataset rasterXSize="${width}" rasterYSize="${height}">
<SRS>+proj=longlat +R=1737400 +no_defs +type=crs</SRS>
<GeoTransform>-180,${360 / width},0,90,0,${-180 / height}</GeoTransform>
<VRTRasterBand dataType="UInt16" band="1" subClass="VRTRawRasterBand">
<SourceFilename relativeToVRT="1">samples.raw</SourceFilename><ImageOffset>0</ImageOffset>
<PixelOffset>2</PixelOffset><LineOffset>${width * 2}</LineOffset><ByteOrder>LSB</ByteOrder>
</VRTRasterBand></VRTDataset>`);
    const output = join(root, "product");
    run(process.execPath, ["scripts/build-lunar-tiles.mjs", "--elevation", join(root, "source.vrt"), "--output", output, "--max-zoom", "1"]);
    const raw = join(root, "decoded.raw");
    run("gdal_translate", ["-of", "ENVI", "-co", "INTERLEAVE=BSQ", "-b", "1", "-b", "2", join(output, "elevation/1/0/0.png"), raw]);
    const pixels = readFileSync(raw);
    for (const py of [3, 100, 256, 400, 511]) for (const px of [0, 1, 100, 256, 510]) {
      const longitude = -180 + (px + 0.5) / 512 / 2 * 360;
      const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * (py + 0.5) / 512 / 2))) * 180 / Math.PI;
      const sx = Math.max(0, Math.min(width - 1, (longitude + 180) / 360 * width - 0.5));
      const sy = Math.max(0, Math.min(height - 1, (90 - latitude) / 180 * height - 0.5));
      const left = Math.floor(sx), top = Math.floor(sy), ax = sx - left, ay = sy - top;
      const sample = (x: number, y: number) => values.readUInt16LE((y * width + x) * 2);
      const expected = (sample(left, top) * (1 - ax) + sample(left + 1, top) * ax) * (1 - ay) +
        (sample(left, top + 1) * (1 - ax) + sample(left + 1, top + 1) * ax) * ay;
      const index = py * 512 + px, actual = pixels[index]! * 256 + pixels[512 * 512 + index]!;
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(0.51);
    }
    const evidence = JSON.parse(readFileSync(join(output, "run.json"), "utf8"));
    expect(evidence.inputs[0].dependencies.map((input: { file: string }) => input.file)).toContain("samples.raw");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);
