export type ImageryDecoderCommand =
  | {
      readonly kind: "decode";
      readonly requestId: number;
      readonly blob: Blob;
      readonly tileSize: number;
      readonly gutter: number;
    }
  | { readonly kind: "cancel"; readonly requestId: number };

export type ImageryDecoderMessage =
  | {
      readonly kind: "decoded";
      readonly requestId: number;
      readonly pixels: ArrayBuffer;
    }
  | {
      readonly kind: "failure";
      readonly requestId: number;
      readonly reason: string;
    };
