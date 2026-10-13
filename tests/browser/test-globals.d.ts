import type {
  PasDeGeantXrEmulatorApi,
} from "../../apps/pas-de-geant/src/bootstrap.js";

declare global {
  interface Window {
    __PAS_DE_GEANT_ENABLE_TEST_HOOKS__?: boolean;
    __PAS_DE_GEANT_TEST_SET_SCALE_DENOMINATOR__?: (
      scaleDenominator: number,
    ) => void;
    __PAS_DE_GEANT_TEST_SET_TILE_OVERLAY__?: (visible: boolean) => void;
    __PAS_DE_GEANT_TEST_SET_TEXTURE_TILE_OVERLAY__?: (
      visible: boolean,
    ) => void;
    __PAS_DE_GEANT_TEST_SET_LOCATION__?: (
      latitudeDegrees: number,
      longitudeDegrees: number,
    ) => void;
    pasDeGeantXrEmulator?: PasDeGeantXrEmulatorApi;
    pasDeGeantDebug?: {
      snapshot(): Record<string, unknown>;
      clearMetrics(): void;
      beginBenchmark(options?: {
        latitudeDegrees?: number;
        longitudeDegrees?: number;
        scaleDenominator?: number;
        terrainMultiplier?: number;
      }): Record<string, unknown>;
      endBenchmark(): Record<string, unknown>;
      setScaleDenominator(scaleDenominator: number): Record<string, unknown>;
      setTerrainRenderCulling(enabled: boolean): Record<string, unknown>;
      setTileRecalculation(
        target: "terrain" | "textures" | "both",
        enabled: boolean,
      ): unknown;
    };
  }
}

export {};
