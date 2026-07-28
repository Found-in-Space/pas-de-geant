import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  testMatch: "little-prince.spec.ts",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: "http://127.0.0.1:4197",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "npm run preview --workspace @found-in-space/little-prince -- --port 4197",
    url: "http://127.0.0.1:4197",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
