#!/usr/bin/env python3
"""Record a browse mosaic's lunar registration and coverage for the study page.

This generates metadata only, not production display tiles. Requires the system
GDAL Python bindings and NumPy. Inputs are a ranged PDS label and the official
20 m browse GeoTIFF; the large native mosaic remains at the archive.
"""

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET

from osgeo import gdal, ogr, osr
import numpy as np

ARCHIVE = "https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001"


def value(label, key):
    return float(re.search(rf"^\s*{re.escape(key)}\s*=\s*([-+\d.Ee]+)", label, re.M)[1])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native-label", type=Path, required=True)
    parser.add_argument("--browse", type=Path, required=True)
    parser.add_argument("--image-properties", type=Path, required=True)
    parser.add_argument("--pyramid-registration", type=Path, help="GDAL JSON header metadata, required when the browse pyramid was resampled")
    parser.add_argument("--pyramid-header-range", action="append", default=[], help="START:FILE for each ranged GeoTIFF header input")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    label = re.split(rb"\r?\nEND\r?\n", args.native_label.read_bytes(), maxsplit=1)[0].decode("ascii")
    product = re.search(r"^PRODUCT_ID\s*=\s*(\S+)", label, re.M)[1]
    folder = product.removeprefix("NAC_ROI_").split("_")[0]
    mission = int(re.search(r"APOLLO(\d+)", product)[1])
    illumination = "high-sun" if "HI" in folder else "low-sun"
    width, height = int(value(label, "LINE_SAMPLES")), int(value(label, "LINES"))
    properties = ET.parse(args.image_properties).getroot().attrib
    preview_width, preview_height = int(properties["WIDTH"]), int(properties["HEIGHT"])
    step = value(label, "MAP_SCALE")
    radius = value(label, "A_AXIS_RADIUS") * 1000
    degrees = math.pi * radius / 180
    # PDS line/sample (1,1) identifies the upper-left pixel centre.
    west = value(label, "CENTER_LONGITUDE") - (value(label, "SAMPLE_PROJECTION_OFFSET") + .5) * step / (degrees * math.cos(math.radians(value(label, "CENTER_LATITUDE"))))
    north = (value(label, "LINE_PROJECTION_OFFSET") + .5) * step / degrees
    longitude_step = step / (degrees * math.cos(math.radians(value(label, "CENTER_LATITUDE"))))
    latitude_step = step / degrees
    if west > 180:
        west -= 360
    bounds = [west, north - height * latitude_step, west + width * longitude_step, north]
    preview_step = step
    registration_input = []
    if (preview_width, preview_height) != (width, height):
        if args.pyramid_registration is None:
            raise ValueError("Resampled browse pyramid: verify its actual GeoTIFF registration first.")
        registration = json.loads(args.pyramid_registration.read_text())
        if registration["size"] != [preview_width, preview_height]:
            raise ValueError("GeoTIFF and Zoomify dimensions differ.")
        corners = registration["extent"]["coordinates"][0]
        bounds = [min(p[0] for p in corners), min(p[1] for p in corners), max(p[0] for p in corners), max(p[1] for p in corners)]
        preview_step = max(abs(registration["geoTransform"][1]), abs(registration["geoTransform"][5]))
        pyramid_url = f"{ARCHIVE}/EXTRAS/BROWSE/NAC_ROI/{folder}/{product}.PYR.TIF"
        public_registration = {key: registration[key] for key in ("size", "coordinateSystem", "geoTransform", "extent")}
        canonical_registration = json.dumps(public_registration, sort_keys=True, separators=(",", ":")).encode()
        registration_input = [{"url": pyramid_url, "headerMetadataSha256": hashlib.sha256(canonical_registration).hexdigest(), "method": "Canonical GDAL header metadata (size, coordinateSystem, geoTransform, extent), excluding local file paths. No raster payload downloaded."}]
        for item in args.pyramid_header_range:
            start, filename = item.split(":", 1)
            data = Path(filename).read_bytes()
            registration_input.append({"url": pyramid_url, "byteRange": f"{int(start)}-{int(start) + len(data) - 1}", "sha256": hashlib.sha256(data).hexdigest()})
    dataset = gdal.Open(str(args.browse))
    mask = dataset.GetRasterBand(1).GetMaskBand().ReadAsArray()
    memory = gdal.GetDriverByName("MEM").Create("", dataset.RasterXSize, dataset.RasterYSize, 1, gdal.GDT_Byte)
    memory.SetGeoTransform(dataset.GetGeoTransform())
    memory.SetProjection(dataset.GetProjection())
    memory.GetRasterBand(1).WriteArray(np.where(mask, 1, 0).astype(np.uint8))
    vector = ogr.GetDriverByName("Memory").CreateDataSource("")
    layer = vector.CreateLayer("coverage", srs=dataset.GetSpatialRef(), geom_type=ogr.wkbPolygon)
    layer.CreateField(ogr.FieldDefn("valid", ogr.OFTInteger))
    gdal.Polygonize(memory.GetRasterBand(1), None, layer, 0)
    geographic = dataset.GetSpatialRef().CloneGeogCS()
    geographic.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    transform = osr.CoordinateTransformation(dataset.GetSpatialRef(), geographic)
    polygons = []
    for feature in layer:
        if feature.GetField("valid") != 1:
            continue
        geometry = feature.GetGeometryRef().Clone()
        geometry.Transform(transform)
        rings = json.loads(geometry.ExportToJson())["coordinates"]
        for ring in rings:
            for point in ring:
                if point[0] > 180:
                    point[0] -= 360
        polygons.append(rings)
    result = {
        "id": product.lower().replace("_", "-"), "mission": mission,
        "illumination": illumination, "product": product,
        "sourceUrl": f"https://data.lroc.im-ldi.com/lroc/view_rdr/NAC_ROI_{folder}",
        "zoomifyUrl": f"https://data.lroc.im-ldi.com/ptif/zoomify/ser/estore/lroc/web/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/EXTRAS/BROWSE/NAC_ROI/{folder}/{product}.PYR.TIF",
        "width": preview_width, "height": preview_height, "tileSize": 256,
        "metresPerPixel": preview_step, "nativeMetresPerPixel": step,
        "bounds": bounds,
        "coverage": polygons,
        "coverageMetresPerPixel": 20,
        "inputs": [
            {"url": f"{ARCHIVE}/DATA/BDR/NAC_ROI/{folder}/{product}.IMG", "byteRange": f"0-{args.native_label.stat().st_size - 1}", "sha256": hashlib.sha256(args.native_label.read_bytes()).hexdigest()},
            {"url": f"{ARCHIVE}/EXTRAS/BROWSE/NAC_ROI/{folder}/{product}_20M.TIF", "sha256": hashlib.sha256(args.browse.read_bytes()).hexdigest()},
            {"url": f"https://data.lroc.im-ldi.com/ptif/zoomify/ser/estore/lroc/web/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/EXTRAS/BROWSE/NAC_ROI/{folder}/{product}.PYR.TIF/ImageProperties.xml", "sha256": hashlib.sha256(args.image_properties.read_bytes()).hexdigest()},
        ] + registration_input,
        "method": "Registration from the PDS equirectangular label, including pixel-edge offsets and standard parallel, or the actual GeoTIFF header when its browse pyramid was resampled. Coverage polygonized from the published 20 m GeoTIFF no-data mask. Zoomify dimensions independently checked against ImageProperties.xml. No imagery pixels included in this metadata.",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, separators=(",", ":")) + "\n")
    print(f"Recorded {width} × {height} mosaic; {len(polygons)} coverage polygons.")


if __name__ == "__main__":
    main()
