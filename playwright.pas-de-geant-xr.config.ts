import { defineConfig } from "@playwright/test";

const port = process.env.PAS_DE_GEANT_XR_PORT ?? "4197";
const baseURL = `http://127.0.0.1:${port}`;
const viewportWidth = Number(process.env.PAS_DE_GEANT_XR_VIEWPORT_WIDTH ?? "800");
const viewportHeight = Number(process.env.PAS_DE_GEANT_XR_VIEWPORT_HEIGHT ?? "450");

export default defineConfig({
  testDir: "tests/browser",
  testMatch: "pas-de-geant.xr-emulator.spec.ts",
  timeout: 600_000,
  expect: {
    timeout: 20_000,
  },
  fullyParallel: false,
  workers: 1,
  outputDir: ".cache/pas-de-geant-xr-testbed",
  use: {
    baseURL,
    geolocation: {
      latitude: 43.722952,
      longitude: 10.396597,
    },
    permissions: ["geolocation"],
    viewport: {
      width: viewportWidth,
      height: viewportHeight,
    },
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      `npm run dev --workspace @found-in-space/pas-de-geant -- --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
