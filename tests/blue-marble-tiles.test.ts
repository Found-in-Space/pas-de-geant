import { describe, expect, it } from "vitest";
import {
  blueMarbleTileFragments,
  blueMarbleTileUrl,
} from "../apps/visualizer/src/blue-marble-tiles.js";

describe("Blue Marble WMTS adapter", () => {
  it("uses the cacheable GIBS geographic WMTS URL", () => {
    expect(blueMarbleTileUrl(2, 1, 3)).toBe(
      "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/" +
        "BlueMarble_ShadedRelief_Bathymetry/default/500m/2/1/3.jpeg",
    );
  });

  it("maps the north-west Leaflet tile into one GIBS tile", () => {
    expect(blueMarbleTileFragments({ x: 0, y: 0, z: 0 })).toEqual([
      {
        url: blueMarbleTileUrl(0, 0, 0),
        sourceX: 0,
        sourceY: 0,
        sourceWidth: 320,
        sourceHeight: 320,
        destinationX: 0,
        destinationY: 0,
        destinationWidth: 256,
        destinationHeight: 256,
      },
    ]);
  });

  it("stitches fragments when a Leaflet tile crosses GIBS boundaries", () => {
    const fragments = blueMarbleTileFragments({ x: 1, y: 1, z: 1 });

    expect(fragments).toHaveLength(4);
    expect(fragments.map(({ url }) => url)).toEqual([
      blueMarbleTileUrl(1, 0, 0),
      blueMarbleTileUrl(1, 0, 1),
      blueMarbleTileUrl(1, 1, 0),
      blueMarbleTileUrl(1, 1, 1),
    ]);
    expect(
      fragments.reduce(
        (maximum, fragment) =>
          Math.max(
            maximum,
            fragment.destinationX + fragment.destinationWidth,
          ),
        0,
      ),
    ).toBe(256);
    expect(
      fragments.reduce(
        (maximum, fragment) =>
          Math.max(
            maximum,
            fragment.destinationY + fragment.destinationHeight,
          ),
        0,
      ),
    ).toBe(256);
  });
});
