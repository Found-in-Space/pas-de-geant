export type ImageryDecoderCommand =
  | {
      readonly kind: "decode";
      readonly requestId: number;
      readonly blob: Blob;
      readonly tileSize: number;
      readonly gutter: number;
    }
  | {
      readonly kind: "mip";
      readonly requestId: number;
      readonly key: string;
      readonly revision: number;
      readonly pixels: ArrayBuffer;
      readonly width: number;
      readonly height: number;
    }
  | { readonly kind: "cancel"; readonly requestId: number };

export interface ImageryMipLevelMessage {
  readonly width: number;
  readonly height: number;
  readonly pixels: ArrayBuffer;
}

export type ImageryDecoderMessage =
  | {
      readonly kind: "decoded";
      readonly requestId: number;
      readonly pixels: ArrayBuffer;
    }
  | {
      readonly kind: "mipped";
      readonly requestId: number;
      readonly key: string;
      readonly revision: number;
      readonly levels: readonly ImageryMipLevelMessage[];
    }
  | {
      readonly kind: "failure";
      readonly requestId: number;
      readonly reason: string;
    };
