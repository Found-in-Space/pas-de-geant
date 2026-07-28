import { expect, test } from "@playwright/test";

test("loads and updates the physical Spacefarer model", async ({ page }) => {
  await page.goto("/spacefarer/");
  await expect(page.locator("#loading-state")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator("#error-state")).toBeHidden();
  await expect(page.locator("#scene-root canvas")).toHaveCount(1);
  await expect(page.locator("#shadow-kind")).toContainText("umbra");

  const timeSlider = page.locator("#time-slider");
  await expect
    .poll(async () => Number(await timeSlider.getAttribute("max")))
    .toBeGreaterThan(15_000);
  const extentSeconds = Number(await timeSlider.getAttribute("max"));
  expect(extentSeconds).toBeLessThan(16_000);

  await timeSlider.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = input.min;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#time-label")).toContainText("15:34:05");
  await expect(page.locator("#shadow-kind")).toContainText("tangent");

  await timeSlider.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = input.max;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#time-label")).toContainText("19:57:49");
  await expect(page.locator("#shadow-kind")).toContainText("tangent");

  await page.getByRole("button", { name: /Shadow corridor/ }).click();
  await expect(
    page.getByRole("button", { name: /Shadow corridor/ }),
  ).toHaveAttribute("aria-pressed", "true");
});
