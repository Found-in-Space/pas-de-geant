#!/usr/bin/env python3
"""Build a local, lossless deep-zoom comparison of three lunar image products.

Requires GDAL's Python bindings and NumPy. On the development Mac:
  /opt/homebrew/opt/python@3.14/bin/python3.14 scripts/build-lunar-preview.py --download
  python3 -m http.server 4198 --bind 127.0.0.1 --directory .cache/lunar-preview/site
"""

import argparse
import json
import math
from pathlib import Path
import re
import shutil
import subprocess

import numpy as np
from osgeo import gdal, osr

gdal.UseExceptions()
ROOT = Path(__file__).resolve().parents[1]
METRES_PER_DEGREE = math.pi * 1737400 / 180
TILE_SIZE = 512
JAXA = "https://data.darts.isas.jaxa.jp/pub/pds3/"
WAC_ID = "WAC_GLOBAL_E300N0450_100M"
WAC_URL = (
    "https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/"
    f"LROLRC_2001/DATA/BDR/WAC_GLOBAL/{WAC_ID}.IMG"
)
PRODUCTS = [
    dict(id="seamless", name="Kaguya · Seamless v2", stem="TCO_MAPs02_N03E000N00E003SC",
         collection="sln-l-tc-5-ortho-map-seamless-v2.0"),
    dict(id="standard", name="Kaguya · Standard ortho v2", stem="TCO_MAP_02_N03E000N00E003SC",
         collection="sln-l-tc-5-ortho-map-v2.0"),
]


def value(label, key):
    return float(re.search(rf"^\s*{re.escape(key)}\s*=\s*([-+\d.Ee]+)", label, re.M)[1])


def curl(url, path, byte_range=None):
    command = ["curl", "-fLsS", "--retry", "3", "--connect-timeout", "30"]
    command += ["-r", byte_range] if byte_range else ["-C", "-"]
    print(f"Downloading {path.name}", flush=True)
    subprocess.run([*command, "-o", str(path), url], check=True)


def download(sources):
    sources.mkdir(parents=True, exist_ok=True)
    for product in PRODUCTS:
        for suffix in ("lbl", "img"):
            name = f"{product['stem']}.{suffix}"
            curl(f"{JAXA}{product['collection']}/lon000/data/{name}", sources / name)
    header = sources / f"{WAC_ID}.header.lbl"
    curl(WAC_URL, header, "0-65535")
    label = header.read_text()
    rows = int(value(label, "LINES"))
    row_bytes = int(value(label, "RECORD_BYTES"))
    image_offset = (int(value(label, "^IMAGE")) - 1) * row_bytes
    crop_rows = math.ceil(3 * value(label, "MAP_RESOLUTION"))
    start = image_offset + (rows - crop_rows) * row_bytes
    stop = image_offset + rows * row_bytes - 1
    curl(WAC_URL, sources / f"{WAC_ID}-bottom{crop_rows}.f32", f"{start}-{stop}")


def png(array, path):
    """Write opaque grayscale display pixels without JPEG loss or sharpening."""
    path.parent.mkdir(parents=True, exist_ok=True)
    bands, height, width = array.shape
    memory = gdal.GetDriverByName("MEM").Create("", width, height, bands, gdal.GDT_Byte)
    for index in range(bands):
        memory.GetRasterBand(index + 1).WriteArray(array[index])
    memory.GetRasterBand(1).SetColorInterpretation(gdal.GCI_GrayIndex)
    memory.GetRasterBand(2).SetColorInterpretation(gdal.GCI_AlphaBand)
    gdal.GetDriverByName("PNG").CreateCopy(str(path), memory, options=["ZLEVEL=3"])


def kaguya_input(product, sources):
    path = sources / f"{product['stem']}.lbl"
    label = path.read_text()
    dataset = gdal.Open(str(path))
    expected = dataset.RasterXSize * dataset.RasterYSize * 2
    actual = path.with_suffix(".img").stat().st_size
    if actual != expected:
        raise ValueError(f"Incomplete source {path.stem}: {actual} bytes, expected {expected}")
    return dict(**product, dataset=dataset, label=label,
                scale=value(label, "SCALING_FACTOR"), offset=value(label, "OFFSET"),
                valid_min=value(label, "VALID_MINIMUM"), valid_max=value(label, "VALID_MAXIMUM"),
                low_saturation=value(label, "LOW_REPR_SATURATION"),
                high_saturation=value(label, "HIGH_REPR_SATURATION"),
                url=f"{JAXA}{product['collection']}/lon000/data/{product['stem']}.lbl",
                attribution="ISAS/JAXA · SELENE/Kaguya TC team · SELENE Data Archive")


def wac_input(sources):
    label = (sources / f"{WAC_ID}.header.lbl").read_text()
    rows = math.ceil(3 * value(label, "MAP_RESOLUTION"))
    columns = int(value(label, "LINE_SAMPLES"))
    source = sources / f"{WAC_ID}-bottom{rows}.f32"
    if source.stat().st_size != rows * columns * 4:
        raise ValueError(f"Incomplete WAC source strip: {source}")
    strip = np.memmap(source, dtype="<f4", mode="r", shape=(rows, columns))
    dataset = gdal.GetDriverByName("MEM").Create("", rows, rows, 1, gdal.GDT_Float32)
    dataset.GetRasterBand(1).WriteArray(strip[:, :rows])
    # The PDS label locates sample (1,1) at the upper-left pixel centre.
    step = value(label, "MAP_SCALE")
    x0 = (-value(label, "SAMPLE_PROJECTION_OFFSET") - 0.5) * step
    y0 = (value(label, "LINE_PROJECTION_OFFSET") + 0.5) * step
    y0 -= (int(value(label, "LINES")) - rows) * step
    dataset.SetGeoTransform([x0, step, 0, y0, 0, -step])
    srs = osr.SpatialReference()
    srs.ImportFromProj4("+proj=eqc +lat_ts=0 +lon_0=0 +R=1737400 +units=m +no_defs")
    dataset.SetSpatialRef(srs)
    # ISIS special float values are all large negative sentinels.
    return dict(id="wac", name="LROC WAC · Global 100 m", stem=WAC_ID,
                dataset=dataset, label=label, scale=1, offset=0,
                valid_min=0, valid_max=float("inf"), url=WAC_URL,
                attribution="NASA/GSFC · Arizona State University · LROC team")


def valid_pixels(array, product):
    return np.isfinite(array) & (array >= product["valid_min"]) & (array <= product["valid_max"])


def display_range(products):
    samples = []
    for product in products:
        dataset = product["dataset"]
        a = dataset.ReadAsArray(buf_xsize=900, buf_ysize=900)
        samples.append(a[valid_pixels(a, product)] * product["scale"] + product["offset"])
    pooled = np.concatenate(samples)
    # An entirely masked polar scene has no meaningful display interval.
    # Its display uses black/white endpoints rather than this interval.
    return [float(x) for x in np.percentile(pooled, [0.5, 99.5])] if pooled.size else [0, 1]


def compile_product(product, contrast, output):
    name = product["id"]
    print(f"Compiling {name} at its output grid resolution", flush=True)
    folder = output / name
    folder.mkdir(parents=True, exist_ok=True)
    source = product["dataset"]
    width, height = source.RasterXSize, source.RasterYSize
    gt = source.GetGeoTransform()
    # Keep the original values, PDS scale/offset and lunar projection in the TIFF.
    gdal.SetConfigOption("GDAL_TIFF_INTERNAL_MASK", "YES")
    raw = gdal.Translate(str(folder / "source.tif"), source, format="GTiff",
                         creationOptions=["TILED=YES", "COMPRESS=DEFLATE"])
    raw.CreateMaskBand(gdal.GMF_PER_DATASET)
    display = gdal.GetDriverByName("MEM").Create("", width, height, 2, gdal.GDT_Byte)
    display.GetRasterBand(1).SetColorInterpretation(gdal.GCI_GrayIndex)
    display.GetRasterBand(2).SetColorInterpretation(gdal.GCI_AlphaBand)
    invalid_count = 0
    for y in range(0, height, TILE_SIZE):
        a = source.ReadAsArray(0, y, width, min(TILE_SIZE, height - y))
        valid = valid_pixels(a, product)
        invalid_count += np.count_nonzero(~valid)
        reflectance = a.astype(np.float32) * product["scale"] + product["offset"]
        normalized = np.where(valid, (reflectance - contrast[0]) / (contrast[1] - contrast[0]), 0)
        gray = np.rint(np.clip(normalized, 0, 1) * 255).astype(np.uint8)
        if "saturation" in product:
            # Category values were reprojected with nearest-neighbour sampling,
            # separately from the calibrated scientific raster.
            saturation = product["saturation"].ReadAsArray(0, y, width, min(TILE_SIZE, height - y))
            gray[saturation == 1] = 0
            gray[saturation == 2] = 255
        else:
            if "low_saturation" in product:
                gray[a == product["low_saturation"]] = 0
            if "high_saturation" in product:
                gray[a == product["high_saturation"]] = 255
        display.GetRasterBand(1).WriteArray(gray, 0, y)
        display.GetRasterBand(2).WriteArray(np.full(gray.shape, 255, dtype=np.uint8), 0, y)
        raw.GetRasterBand(1).GetMaskBand().WriteArray(valid.astype(np.uint8) * 255, 0, y)
    raw.FlushCache()
    raw = None
    levels = []
    level = 0
    while True:
        factor = 2 ** level
        w, h = math.ceil(width / factor), math.ceil(height / factor)
        # Native level is an exact pixel copy; only overview levels are averaged.
        reduced = (display if level == 0 else
                   gdal.Translate("", display, format="MEM", width=w, height=h, resampleAlg="average"))
        for y in range(0, h, TILE_SIZE):
            for x in range(0, w, TILE_SIZE):
                a = reduced.ReadAsArray(x, y, min(TILE_SIZE, w - x), min(TILE_SIZE, h - y))
                png(a, folder / "tiles" / str(level) / f"{x // TILE_SIZE}_{y // TILE_SIZE}.png")
        levels.append(dict(level=level, width=w, height=h))
        print(f"  level {level}: {w} × {h}", flush=True)
        if max(w, h) <= TILE_SIZE:
            break
        level += 1
    overview_width = min(1536, width)
    overview = gdal.Translate("", display, format="MEM", width=overview_width,
                              height=round(height * overview_width / width), resampleAlg="average")
    png(overview.ReadAsArray(), folder / "overview.png")
    # A native-resolution central sample is useful outside the interactive viewer.
    crop_size = min(1024, width, height)
    crop_x, crop_y = (width - crop_size) // 2, (height - crop_size) // 2
    png(display.ReadAsArray(crop_x, crop_y, crop_size, crop_size), folder / "native-crop.png")
    return dict(id=name, name=product["name"], product=product["stem"],
                width=width, height=height, metresPerPixel=gt[1],
                left=gt[0] / METRES_PER_DEGREE, top=gt[3] / METRES_PER_DEGREE,
                step=gt[1] / METRES_PER_DEGREE, levels=levels,
                contrast=contrast, sourceScale=product["scale"], sourceOffset=product["offset"],
                invalidPixels=int(invalid_count), sourceUrl=product["url"],
                attribution=product["attribution"], raw=f"{name}/source.tif",
                overview=f"{name}/overview.png", crop=f"{name}/native-crop.png")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, default=ROOT / ".cache/lunar-preview/sources")
    parser.add_argument("--output", type=Path, default=ROOT / ".cache/lunar-preview/site")
    parser.add_argument("--download", action="store_true")
    args = parser.parse_args()
    if args.download:
        download(args.sources)
    args.output.mkdir(parents=True, exist_ok=True)
    kaguya = [kaguya_input(p, args.sources) for p in PRODUCTS]
    contrast = display_range(kaguya)
    print(f"Shared Kaguya display interval after PDS scale/offset: {contrast}", flush=True)
    results = [compile_product(p, contrast, args.output) for p in kaguya]
    wac = wac_input(args.sources)
    results.append(compile_product(wac, display_range([wac]), args.output))
    manifest = dict(tileSize=TILE_SIZE, radiusMetres=1737400, products=results,
                    modification="Lossless native PNG tiles, 8-bit linear display stretch at pooled "
                    "0.5–99.5 percentiles for Kaguya; separate WAC stretch. "
                    "Display images are opaque: low saturation is black, high saturation is white, and blank data is black. "
                    "Original scaled values retained in masked lunar GeoTIFFs. "
                    "No sharpening or AI enhancement. Overview levels use area averaging.")
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    shutil.copyfile(Path(__file__).with_name("lunar-preview.html"), args.output / "index.html")
    print(f"Preview written to {args.output}", flush=True)


if __name__ == "__main__":
    main()
