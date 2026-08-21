import { installRequestedXrEmulation } from "./xr-emulation.js";
export type { PasDeGeantXrEmulatorApi } from "./xr-emulation.js";

await installRequestedXrEmulation();
await import("./main.js");
