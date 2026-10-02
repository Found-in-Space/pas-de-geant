#!/usr/bin/env python3
"""Extend the lunar preview with equatorial and north/south polar-region joins.

Use the same GDAL/NumPy interpreter as build-lunar-preview.py. --plan records
source windows; --build compiles cached sources. --download fetches the labels
and original image rows listed in JAXA's archive inventory.
The sampled polar regions cross 84 and 88 degrees; they do not cover the
entire caps at 90 degrees. JAXA's host does not honor byte-range requests.
"""
import argparse
import importlib.util
import json
import math
from pathlib import Path
import re
import shutil
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from osgeo import gdal, osr

spec = importlib.util.spec_from_file_location("preview", Path(__file__).with_name("build-lunar-preview.py"))
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)
gdal.UseExceptions()
ROOT = preview.ROOT / ".cache/lunar-preview"
SOURCES = ROOT / "join-sources"
OUTPUT = ROOT / "site"
RADIUS = 1737400
DEGREE = preview.METRES_PER_DEGREE
EQC = f"+proj=eqc +lat_ts=0 +lon_0=0 +R={RADIUS} +units=m +no_defs"


def srs(proj):
    result = osr.SpatialReference()
    result.ImportFromProj4(proj)
    result.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    return result


def stereographic(hemisphere):
    return f"+proj=stere +lat_0={hemisphere * 90} +lon_0=0 +k=1 +R={RADIUS} +units=m +no_defs"


def polar_radius(latitude):
    return 2 * RADIUS * math.tan(math.radians(90 - abs(latitude)) / 2)


def scenes():
    result = [dict(id="equatorial-join", name="Equator · four-tile junction", projection="eqc",
                   proj=EQC, centre=[3 * DEGREE, 3 * DEGREE],
                   bounds=[3 * DEGREE - 13000, 3 * DEGREE - 13000, 3 * DEGREE + 13000, 3 * DEGREE + 13000],
                   description="Four adjoining source tiles meet at 3° N, 3° E. Native grids retained; no seam blending.")]
    for hemisphere, word in [(1, "north"), (-1, "south")]:
        for latitude, name, half_width, half_height in [
            (84, "84° transition", 3000, 6000),
            (88, "88° tile join", 2000, 5000),
        ]:
            y = -hemisphere * polar_radius(latitude)
            result.append(dict(id=f"{word}-{latitude}", name=f"{word.title()} · {name}",
                               projection="polar", hemisphere=hemisphere, latitude=latitude,
                               proj=stereographic(hemisphere), centre=[0, y],
                               bounds=[-half_width, y - half_height, half_width, y + half_height],
                               description=("Common 10 m polar grid. Seamless switches from cylindrical to polar imagery at 84°; no blending or fallback filling."
                                            if latitude == 84 else
                                            "Common 10 m polar grid. Source tile joins are exposed; low saturation and blank data display as black, high saturation as white.")))
    return result


def metadata(path):
    label = path.read_text()
    v = lambda key: preview.value(label, key)
    step = v("MAP_SCALE") * 1000
    gt = [(-v("SAMPLE_PROJECTION_OFFSET") - .5) * step, step, 0,
          (v("LINE_PROJECTION_OFFSET") + .5) * step, 0, -step]
    polar = path.stem.endswith("PS")
    proj = (f"+proj=stere +lat_0={v('CENTER_LATITUDE')} +lon_0={v('CENTER_LONGITUDE')} +k=1 +R={RADIUS} +units=m +no_defs"
            if polar else EQC)
    if not polar and -v("SAMPLE_PROJECTION_OFFSET") >= 180 * v("MAP_RESOLUTION"):
        gt[0] -= 360 * DEGREE
    kind = "seamless" if path.stem.startswith("TCO_MAPs") else "standard"
    longitude = re.search(r"[NS]\d\dE(\d\d\d)", path.stem)[1]
    collection = f"sln-l-tc-5-ortho-map-{'seamless-' if kind == 'seamless' else ''}v2.0"
    return dict(stem=path.stem, kind=kind, polar=polar, proj=proj, gt=gt,
                width=int(v("LINE_SAMPLES")), height=int(v("LINES")),
                scale=v("SCALING_FACTOR"), offset=v("OFFSET"),
                valid_min=v("VALID_MINIMUM"), valid_max=v("VALID_MAXIMUM"),
                url=f"{preview.JAXA}{collection}/lon{longitude}/data/{path.stem}.img")


def download_labels():
    SOURCES.mkdir(parents=True, exist_ok=True)
    equatorial = ["N03E000N00E003", "N03E003N00E006", "N06E000N03E003", "N06E003N03E006"]
    for kind, prefix in [("seamless", "TCO_MAPs02"), ("standard", "TCO_MAP_02")]:
        footprints = equatorial.copy()
        bands = [("N84", "N81"), ("S81", "S84")]
        if kind == "standard":
            bands += [("N87", "N84"), ("N90", "N87"), ("S84", "S87"), ("S87", "S90")]
        footprints += [f"{top}E{lon:03d}{bottom}E{lon+3:03d}" for top, bottom in bands for lon in [0, 357]]
        names = [f"{prefix}_{footprint}SC.lbl" for footprint in footprints]
        if kind == "seamless":
            names += [f"{prefix}_{footprint}PS.lbl" for footprint in
                      ["N82E045N90E180", "N84E000N84E270", "S82E315S90E000", "S84E000S84E090"]]
        collection = f"sln-l-tc-5-ortho-map-{'seamless-' if kind == 'seamless' else ''}v2.0"
        for name in names:
            path = SOURCES / name
            if path.exists():
                continue
            longitude = re.search(r"[NS]\d\dE(\d\d\d)", name)[1]
            preview.curl(f"{preview.JAXA}{collection}/lon{longitude}/data/{name}", path)


def output_grid(scene, kind):
    if scene["projection"] == "eqc":
        step = 8.42315289562 if kind == "seamless" else 7.4031617246699
        # Match the source grids, including their half-pixel map offsets.
        x = round(3 * DEGREE / step) * step - step / 2
        y = round(3 * DEGREE / step) * step + step / 2
        return [x - 1536 * step, y - 1536 * step, x + 1536 * step, y + 1536 * step], step
    return scene["bounds"], 10


def source_window(source, scene):
    if scene["projection"] == "polar":
        north = "_N" in source["stem"]
        if north != (scene["hemisphere"] == 1):
            return None
    elif source["polar"]:
        return None
    bounds, _ = output_grid(scene, source["kind"])
    x0, y0, x1, y1 = bounds
    points = []
    for t in np.linspace(0, 1, 65):
        points.extend([(x0 + (x1 - x0) * t, y0), (x0 + (x1 - x0) * t, y1),
                       (x0, y0 + (y1 - y0) * t), (x1, y0 + (y1 - y0) * t)])
    transform = osr.CoordinateTransformation(srs(scene["proj"]), srs(source["proj"]))
    points = np.array(transform.TransformPoints(points))[:, :2]
    gt = source["gt"]
    pixels = (points[:, 0] - gt[0]) / gt[1]
    lines = (points[:, 1] - gt[3]) / gt[5]
    left, right = max(0, math.floor(pixels.min()) - 3), min(source["width"], math.ceil(pixels.max()) + 3)
    top, bottom = max(0, math.floor(lines.min()) - 3), min(source["height"], math.ceil(lines.max()) + 3)
    return [left, top, right - left, bottom - top] if right > left and bottom > top else None


def plan():
    sources = [metadata(p) for p in sorted(SOURCES.glob("TCO*.lbl"))]
    catalogue = scenes()
    for source in sources:
        source["windows"] = {scene["id"]: window for scene in catalogue
                             if (window := source_window(source, scene)) is not None}
    sources = [source for source in sources if source["windows"]]
    requests = []
    total = 0
    for source in sources:
        full = ROOT / "sources" / f"{source['stem']}.img"
        whole_size = source["width"] * source["height"] * 2
        rows = max(w[1] + w[3] for w in source["windows"].values())
        expected = source["width"] * rows * 2
        if not full.exists():
            full = SOURCES / f"{source['stem']}.img"
        if full.exists() and full.stat().st_size == whole_size:
            source.update(full=str(full), storedRows=source["height"])
            continue
        prefix = SOURCES / f"{source['stem']}.prefix.img"
        # Range requests are ignored by this archive. A normal GET can still
        # be closed after the last required row; no later bytes are needed.
        if full.exists() and full.stat().st_size >= expected and not prefix.exists():
            with full.open('rb') as src, prefix.open('wb') as dst:
                remaining = expected
                while remaining:
                    block = src.read(min(1024 * 1024, remaining))
                    dst.write(block); remaining -= len(block)
        source.update(full=str(prefix), storedRows=rows)
        if not prefix.exists() or prefix.stat().st_size != expected:
            total += expected
            requests.append(source["stem"])
    (SOURCES / "plan.json").write_text(json.dumps(dict(scenes=catalogue, sources=sources), indent=2) + "\n")
    print(f"Planned {len(sources)} source products, {len(requests)} remaining downloads, {total/1e6:.1f} MB through the last required rows", flush=True)
    for scene in catalogue:
        print(scene["id"], {k:sum(s["kind"] == k and scene["id"] in s["windows"] for s in sources) for k in ["seamless", "standard"]})


def download_sources():
    sources = json.loads((SOURCES / "plan.json").read_text())["sources"]
    def fetch(source):
        path = Path(source["full"])
        expected = source["storedRows"] * source["width"] * 2
        if path.exists() and path.stat().st_size == expected:
            return
        for attempt in range(3):
            try:
                part = path.with_suffix(path.suffix + ".part")
                with urllib.request.urlopen(source["url"] + "?preview=join-prefix", timeout=60) as response, part.open('wb') as dst:
                    remaining = expected
                    while remaining:
                        block = response.read(min(512 * 1024, remaining))
                        if not block:
                            raise OSError(f"Source stream ended {remaining} bytes early")
                        dst.write(block); remaining -= len(block)
                part.replace(path)
                print(f"Ready: {source['stem']} ({expected/1e6:.1f} MB)", flush=True)
                return
            except Exception as error:
                if attempt == 2:
                    raise
                print(f"Retrying {source['stem']}: {error}", flush=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(fetch, sources))


def crop_source(source, scene, folder, saturation=False):
    x, y, width, height = source["windows"][scene["id"]]
    full = Path(source.get("full", SOURCES / f"{source['stem']}.img"))
    expected = source["storedRows"] * source["width"] * 2
    if full.stat().st_size != expected:
        raise ValueError(f"Incomplete source image: {full}; expected {expected} bytes")
    raw = np.memmap(full, dtype=">u2", mode="r", shape=(source["storedRows"], source["width"]))
    a = raw[y:y + height, x:x + width]
    if saturation:
        a = np.where(a == 1, 1, np.where(a == 32767, 2, 0)).astype(np.float32)
    else:
        valid = preview.valid_pixels(a, source)
        a = np.where(valid, a.astype(np.float32) * source["scale"] + source["offset"], np.nan)
    path = folder / f"{source['stem']}.tif"
    dst = gdal.GetDriverByName("GTiff").Create(str(path), width, height, 1, gdal.GDT_Float32,
                                             options=["TILED=YES", "COMPRESS=DEFLATE"])
    gt = source["gt"].copy()
    gt[0] += x * gt[1]; gt[3] += y * gt[5]
    dst.SetGeoTransform(gt); dst.SetSpatialRef(srs(source["proj"]))
    dst.GetRasterBand(1).SetNoDataValue(float("nan")); dst.GetRasterBand(1).WriteArray(a)
    dst.FlushCache()
    return str(path)


def warp_group(paths, scene, kind, name, folder, saturation=False):
    bounds, step = output_grid(scene, kind)
    vrt = gdal.BuildVRT(str(folder / f"{name}.vrt"), paths, srcNodata="nan", VRTNodata="nan")
    result = gdal.Warp("", vrt, format="MEM", dstSRS=scene["proj"], outputBounds=bounds,
                       xRes=step, yRes=step, resampleAlg="near" if saturation else "bilinear", srcNodata="nan", dstNodata="nan",
                       outputType=gdal.GDT_Float32)
    return result


def mosaic_sources(scene, kind, selected, saturation=False):
    folder = ROOT / "join-derived" / scene["id"] / kind
    if saturation:
        folder = folder / "saturation"
    folder.mkdir(parents=True, exist_ok=True)
    groups = {polar:[crop_source(s, scene, folder, saturation) for s in selected if s["polar"] == polar]
              for polar in [False, True]}
    warped = {polar:warp_group(paths, scene, kind, str(polar), folder, saturation) for polar, paths in groups.items() if paths}
    if len(warped) == 2:
        dataset = warped[False]
        gt = dataset.GetGeoTransform()
        x = gt[0] + (np.arange(dataset.RasterXSize) + .5) * gt[1]
        y = gt[3] + (np.arange(dataset.RasterYSize) + .5) * gt[5]
        poleward = np.hypot(x[None, :], y[:, None]) <= polar_radius(84)
        a = np.where(poleward, warped[True].ReadAsArray(), dataset.ReadAsArray())
        dataset.GetRasterBand(1).WriteArray(a)
    else:
        dataset = next(iter(warped.values()))
    return dataset


def assemble(scene, kind, sources):
    selected = [s for s in sources if s["kind"] == kind and scene["id"] in s["windows"]]
    dataset = mosaic_sources(scene, kind, selected)
    return dict(id=f"{scene['id']}-{kind}", name=f"Kaguya · {'Seamless' if kind == 'seamless' else 'Standard ortho'} v2",
                stem=f"{scene['id']} {kind} source mosaic", dataset=dataset,
                saturation=mosaic_sources(scene, kind, selected, saturation=True),
                scale=1, offset=0, valid_min=0, valid_max=float("inf"),
                url=f"{preview.JAXA}sln-l-tc-5-ortho-map-{'seamless-' if kind == 'seamless' else ''}v2.0/",
                attribution="ISAS/JAXA · SELENE/Kaguya TC team · SELENE Data Archive",
                sources=[dict(product=s["stem"], url=s["url"], window=s["windows"][scene["id"]],
                              scale=s["scale"], offset=s["offset"]) for s in selected])


def boundaries(scene, kind):
    x0, y0, x1, y1 = scene["bounds"]
    if scene["projection"] == "eqc":
        x, y = scene["centre"]
        return [[[x, y0], [x, y1]], [[x0, y], [x1, y]]]
    lines = [[[0, y0], [0, y1]]]
    if scene["latitude"] == 84:
        r = polar_radius(84)
        lines.append([[float(x), -scene["hemisphere"] * math.sqrt(r*r-x*x)] for x in np.linspace(x0, x1, 81)])
    return lines


def build(selected_ids, data=None):
    if data is None:
        data = json.loads((SOURCES / "plan.json").read_text())
    for scene in data["scenes"]:
        scene["description"] = next(s["description"] for s in scenes() if s["id"] == scene["id"])
        if selected_ids and scene["id"] not in selected_ids:
            continue
        print(f"Building {scene['id']}", flush=True)
        products = [assemble(scene, kind, data["sources"]) for kind in ["seamless", "standard"]]
        contrast = preview.display_range(products)
        results = []
        for product, kind in zip(products, ["seamless", "standard"]):
            result = preview.compile_product(product, contrast, OUTPUT)
            gt = product["dataset"].GetGeoTransform()
            result.update(left=gt[0], top=gt[3], step=gt[1], sources=product["sources"],
                          seams=boundaries(scene, kind), resampled=scene["projection"] != "eqc")
            result["validPercent"] = 100 * (1 - result["invalidPixels"] / (result["width"] * result["height"]))
            results.append(result)
        manifest = dict(tileSize=512, radiusMetres=RADIUS, coordinateUnits="metres", scene=scene, products=results,
                        modification="Opaque display: low saturation and blank data are black; high saturation is white. Saturation categories use nearest-neighbour reprojection. "
                        "Scientific values retain the PDS validity mask before resampling. Source scale/offset applied before a shared display stretch across both products and every join. "
                        "Equatorial grids retain source sampling; polar views use bilinear reprojection to a common 10 m lunar stereographic grid. "
                        "No seam blending, sharpening, or gap filling. Derived GeoTIFFs contain scaled Float32 values; original source rows and labels are retained in the local cache.")
        (OUTPUT / f"{scene['id']}.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print(f"  Valid pixels: {[round(p['validPercent'],2) for p in results]}", flush=True)
    catalogue = [dict(id="original", name="Original equatorial tile", manifest="manifest.json")]
    catalogue += [dict(id=s["id"], name=s["name"], manifest=f"{s['id']}.json") for s in data["scenes"] if (OUTPUT / f"{s['id']}.json").exists()]
    (OUTPUT / "scenes.json").write_text(json.dumps(catalogue, indent=2) + "\n")
    shutil.copyfile(Path(__file__).with_name("lunar-preview.html"), OUTPUT / "index.html")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", action="store_true")
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--build", action="store_true")
    parser.add_argument("--scene", action="append")
    args = parser.parse_args()
    if args.download:
        download_labels()
    if args.plan or args.download:
        plan()
    if args.download:
        download_sources()
    if args.build:
        build(args.scene)
