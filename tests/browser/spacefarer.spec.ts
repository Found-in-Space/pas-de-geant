import { expect, test } from "@playwright/test";

test("loads and updates the physical Spacefarer model", async ({ page }) => {
  await page.goto("/spacefarer/");
  await expect(page.locator("#loading-state")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator("#error-state")).toBeHidden();
  await expect(page.locator("#scene-root canvas")).toHaveCount(1);
  await expect(page.locator("#shadow-kind")).toContainText("umbra");

  const initialTime = await page.locator("#time-label").textContent();
  await page.locator("#time-slider").evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = String(Number(input.value) + 120);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#time-label")).not.toHaveText(initialTime!);

  await page.getByRole("button", { name: /Shadow corridor/ }).click();
  await expect(
    page.getByRole("button", { name: /Shadow corridor/ }),
  ).toHaveAttribute("aria-pressed", "true");
});
