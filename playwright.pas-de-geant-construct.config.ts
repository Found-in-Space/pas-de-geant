import { defineConfig } from "@playwright/test";

const port = process.env.PAS_DE_GEANT_PORT ?? "4197";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "tests/browser",
  testMatch: "pas-de-geant-construct.spec.ts",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL,
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command:
      `npm run preview --workspace @found-in-space/pas-de-geant -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
