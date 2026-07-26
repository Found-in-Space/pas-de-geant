import L from "leaflet";
import {
  BLUE_MARBLE_MAX_ZOOM,
  blueMarbleTileFragments,
} from "./blue-marble-tiles.js";

const BLUE_MARBLE_ATTRIBUTION =
  'Imagery <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>';

export class BlueMarbleLayer extends L.GridLayer {
  private readonly sourceImages = new Map<
    string,
    Promise<HTMLImageElement>
  >();

  constructor() {
    super({
      tileSize: 256,
      minZoom: 0,
      maxZoom: BLUE_MARBLE_MAX_ZOOM,
      noWrap: true,
      bounds: [
        [-90, -180],
        [90, 180],
      ],
      attribution: BLUE_MARBLE_ATTRIBUTION,
    });
  }

  override createTile(
    coordinates: L.Coords,
    done: L.DoneCallback,
  ): HTMLCanvasElement {
    const canvas = L.DomUtil.create(
      "canvas",
      "leaflet-tile blue-marble-tile",
    );
    const tileSize = this.getTileSize();
    canvas.width = tileSize.x;
    canvas.height = tileSize.y;
    const context = canvas.getContext("2d");

    if (!context) {
      queueMicrotask(() => {
        done(new Error("Blue Marble canvas rendering is unavailable."), canvas);
      });
      return canvas;
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const fragments = blueMarbleTileFragments(coordinates);

    Promise.all(
      fragments.map(async (fragment) => ({
        fragment,
        image: await this.loadSourceImage(fragment.url),
      })),
    )
      .then((loadedFragments) => {
        for (const { fragment, image } of loadedFragments) {
          context.drawImage(
            image,
            fragment.sourceX,
            fragment.sourceY,
            fragment.sourceWidth,
            fragment.sourceHeight,
            fragment.destinationX,
            fragment.destinationY,
            fragment.destinationWidth,
            fragment.destinationHeight,
          );
        }
        done(undefined, canvas);
      })
      .catch((error: unknown) => {
        done(
          error instanceof Error
            ? error
            : new Error("A Blue Marble source tile failed to load."),
          canvas,
        );
      });

    return canvas;
  }

  private loadSourceImage(url: string): Promise<HTMLImageElement> {
    const cached = this.sourceImages.get(url);
    if (cached) return cached;

    const imagePromise = new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => {
        reject(new Error(`Failed to load Blue Marble source tile: ${url}`));
      };
      image.src = url;
    }).catch((error: unknown) => {
      this.sourceImages.delete(url);
      throw error;
    });

    this.sourceImages.set(url, imagePromise);
    return imagePromise;
  }
}

export function blueMarbleLayer(): BlueMarbleLayer {
  return new BlueMarbleLayer();
}
