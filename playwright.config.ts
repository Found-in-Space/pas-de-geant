import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  testIgnore: "little-prince.spec.ts",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: "http://127.0.0.1:4196",
    geolocation: {
      latitude: 35.6762,
      longitude: 139.6503,
    },
    permissions: ["geolocation"],
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "npm run preview --workspace @found-in-space/shadowline-visualizer -- --port 4196",
    url: "http://127.0.0.1:4196",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
