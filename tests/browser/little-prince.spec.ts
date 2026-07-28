import { expect, test } from "@playwright/test";

test("loads and operates the Little Planet desktop fallback", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  let aircraftRequests = 0;
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
  await page.route("https://api.airplanes.live/**", (route) => {
    aircraftRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ac: [
          {
            hex: "484abc",
            flight: "KLM123",
            lat: 40.1,
            lon: -3.9,
            alt_baro: 32_000,
            gs: 430,
            track: 91,
            seen_pos: 0.2,
          },
        ],
      }),
    });
  });
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
  await expect(page.locator("#scale-readout")).toContainText(
    "1 km = 1.0 cm",
  );
  await expect(page.locator("#radial-readout")).toContainText("1.0×");
  await expect(page.locator("#radial-readout")).toContainText(
    "1 km = 1.0 cm",
  );
  await expect(page.locator("#aircraft-readout")).toHaveText(
    "Off · optional",
  );
  await page.waitForTimeout(250);
  expect(aircraftRequests).toBe(0);

  await page.getByRole("button", { name: "Reveal seabed" }).click();
  await expect(page.locator("#ocean-readout")).toHaveText("Seabed revealed");
  await expect(
    page.getByRole("button", { name: "Restore ocean" }),
  ).toBeVisible();

  await page.keyboard.down("KeyX");
  await page.waitForTimeout(250);
  await page.keyboard.up("KeyX");
  await expect(page.locator("#scale-readout")).not.toContainText("10.0 m");

  await page.getByRole("button", { name: "Reset Iberia" }).click();
  await expect(page.locator("#scale-readout")).toContainText("10.0 m");
  await expect(page.locator("#ocean-readout")).toHaveText("Surface");

  const aircraftToggle = page.getByRole("checkbox", {
    name: "Live aircraft",
  });
  await aircraftToggle.check();
  await expect(page.locator("#aircraft-readout")).toHaveText("Ready for VR");
  expect(aircraftRequests).toBe(0);
  await aircraftToggle.uncheck();
  await expect(page.locator("#aircraft-readout")).toHaveText("Off · optional");
  expect(consoleErrors).toEqual([]);
});
