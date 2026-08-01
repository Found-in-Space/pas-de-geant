import {
  isValidImageryAddress,
  type ImageryAddress,
} from "./imagery-core.js";

export interface ImageryProvider {
  readonly id: string;
  readonly attribution: string;
  readonly tileSize: number;
  readonly minZoom: number;
  readonly maxZoom: number;
  load(address: ImageryAddress, signal: AbortSignal): Promise<Blob>;
}

export interface XyzImageryConfiguration {
  id?: string;
  urlTemplate: string;
  attribution: string;
  tileSize?: number;
  minZoom?: number;
  maxZoom?: number;
}

declare global {
  interface Window {
    __PAS_DE_GEANT_IMAGERY_CONFIG__?: XyzImageryConfiguration;
    __PAS_DE_GEANT_IMAGERY_PROVIDER__?: ImageryProvider;
  }
}

export class ImageryRequestError extends Error {
  constructor(
    message: string,
    readonly kind: "not-found" | "transient" | "malformed",
    readonly status?: number,
  ) {
    super(message);
    this.name = "ImageryRequestError";
  }
}

export class XyzImageryProvider implements ImageryProvider {
  readonly id: string;
  readonly attribution: string;
  readonly tileSize: number;
  readonly minZoom: number;
  readonly maxZoom: number;

  constructor(private readonly configuration: XyzImageryConfiguration) {
    if (
      !configuration.urlTemplate.includes("{z}") ||
      !configuration.urlTemplate.includes("{x}") ||
      !configuration.urlTemplate.includes("{y}")
    ) {
      throw new Error(
        "The imagery URL template must contain {z}, {x}, and {y}.",
      );
    }
    if (!configuration.attribution.trim()) {
      throw new Error("Photographic imagery requires provider attribution.");
    }
    this.id = configuration.id?.trim() || "configured-xyz";
    this.attribution = configuration.attribution.trim();
    this.tileSize = Math.max(
      1,
      Math.min(1_024, Math.floor(configuration.tileSize ?? 256)),
    );
    this.minZoom = Math.max(0, Math.floor(configuration.minZoom ?? 0));
    this.maxZoom = Math.max(
      this.minZoom,
      Math.floor(configuration.maxZoom ?? 20),
    );
  }

  async load(address: ImageryAddress, signal: AbortSignal): Promise<Blob> {
    if (
      !isValidImageryAddress(address) ||
      address.z < this.minZoom ||
      address.z > this.maxZoom
    ) {
      throw new ImageryRequestError(
        "The imagery address is outside provider coverage.",
        "not-found",
      );
    }
    const url = this.configuration.urlTemplate
      .replaceAll("{z}", String(address.z))
      .replaceAll("{x}", String(address.x))
      .replaceAll("{y}", String(address.y));
    const response = await fetch(url, {
      cache: "default",
      mode: "cors",
      signal,
    });
    if (!response.ok) {
      throw new ImageryRequestError(
        `Imagery tile request failed with ${response.status}.`,
        response.status === 404 ? "not-found" : "transient",
        response.status,
      );
    }
    const blob = await response.blob();
    if (!blob.type.toLowerCase().startsWith("image/")) {
      throw new ImageryRequestError(
        "The imagery response is not an image.",
        "malformed",
      );
    }
    return blob;
  }
}

export function configuredXyzImageryProvider(
  configuration: XyzImageryConfiguration | undefined,
): ImageryProvider | undefined {
  return configuration ? new XyzImageryProvider(configuration) : undefined;
}
