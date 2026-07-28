import { expect, test } from "@playwright/test";

test("loads and operates the Little Planet desktop fallback", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    ) {
      consoleErrors.push(message.text());
    }
  });
  await page.route("https://gibs.earthdata.nasa.gov/**", (route) =>
    route.abort(),
  );
  await page.goto("/");
  await expect(page.locator("#loading-state")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator("#error-state")).toBeHidden();
  await expect(page.locator("#scene-root canvas")).toHaveCount(1);
  await expect(page.locator("body")).toHaveAttribute(
    "data-relief-fallback",
    "false",
  );
  await expect(page.locator("#coordinates")).toContainText("40.00° N");
  await expect(page.locator("#scale-readout")).toContainText("10.0 m");
  await expect(page.locator("#relief-readout")).toHaveText("1.0×");

  await page.getByRole("button", { name: "Reveal seabed" }).click();
  await expect(page.locator("#ocean-readout")).toHaveText("Seabed revealed");
  await expect(
    page.getByRole("button", { name: "Restore ocean" }),
  ).toBeVisible();

  await page.keyboard.down("KeyX");
  await page.waitForTimeout(250);
  await page.keyboard.up("KeyX");
  await expect(page.locator("#scale-readout")).not.toHaveText(
    "Iberia ≈ 10.0 m",
  );

  await page.getByRole("button", { name: "Reset Iberia" }).click();
  await expect(page.locator("#scale-readout")).toContainText("10.0 m");
  await expect(page.locator("#ocean-readout")).toHaveText("Surface");
  expect(consoleErrors).toEqual([]);
});
