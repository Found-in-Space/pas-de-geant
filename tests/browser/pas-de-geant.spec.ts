import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__PAS_DE_GEANT_ENABLE_TEST_HOOKS__ = true;
  });
  await page.goto("/");
  await expect(page.locator("#loading-state")).toBeHidden({ timeout: 20_000 });
});

test("keeps the terrain-cut debug overlay hook", async ({ page }) => {
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-tile-overlay",
    "false",
  );
  await page.evaluate(() => {
    window.__PAS_DE_GEANT_TEST_SET_TILE_OVERLAY__?.(true);
  });
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-tile-overlay",
    "true",
  );
});

test("keeps the texture-source debug overlay hook", async ({ page }) => {
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-texture-tile-overlay",
    "false",
  );
  await page.evaluate(() => {
    window.__PAS_DE_GEANT_TEST_SET_TEXTURE_TILE_OVERLAY__?.(true);
  });
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-texture-tile-overlay",
    "true",
  );
});
