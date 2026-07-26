import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.abort(),
  );
  await page.route("https://gibs.earthdata.nasa.gov/**", (route) =>
    route.abort(),
  );
});

test("initializes three coordinated projection panels", async ({ page }) => {
  await page.goto("/?eclipse=solar-2026-08-12-total");
  await expect(
    page.getByText("track calculated from", { exact: false }),
  ).toBeVisible();

  await expect(
    page.getByRole("article", { name: "OpenStreetMap · Web Mercator" }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: "OpenStreetMap · 3D globe" }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", {
      name: "NASA Blue Marble · Equirectangular",
    }),
  ).toBeVisible();
  for (const id of ["mercator-map", "globe-map", "world-map"]) {
    await expect(page.locator(`#${id}`)).toHaveAttribute(
      "data-renderer-ready",
      "true",
    );
    await expect
      .poll(async () =>
        Number(
          (await page
            .locator(`#${id}`)
            .getAttribute("data-path-feature-count")) ?? 0,
        ),
      )
      .toBeGreaterThan(0);
  }
  await expect(page.locator("#globe-map")).toHaveAttribute(
    "data-projection",
    "globe",
  );
});

test("lets every map fill its projection panel edge to edge", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?eclipse=solar-2026-08-12-total");
  await expect(
    page.getByText("track calculated from", { exact: false }),
  ).toBeVisible();

  const layout = await page.evaluate(() => ({
    panels: Array.from(document.querySelectorAll(".map-panel")).map(
      (panel: Element) => {
        const map = panel.querySelector(".map-viewport")!;
        const panelBox = panel.getBoundingClientRect();
        const mapBox = map.getBoundingClientRect();
        return {
          panel: {
            top: panelBox.top,
            right: panelBox.right,
            bottom: panelBox.bottom,
            left: panelBox.left,
          },
          map: {
            top: mapBox.top,
            right: mapBox.right,
            bottom: mapBox.bottom,
            left: mapBox.left,
          },
        };
      },
    ),
  }));

  expect(layout.panels).toHaveLength(3);
  for (const { panel, map } of layout.panels) {
    expect(map.top).toBeCloseTo(panel.top, 5);
    expect(map.right).toBeCloseTo(panel.right, 5);
    expect(map.bottom).toBeCloseTo(panel.bottom, 5);
    expect(map.left).toBeCloseTo(panel.left, 5);
  }
  expect(layout.panels[0]!.panel.right).toBeCloseTo(
    layout.panels[1]!.panel.left,
    5,
  );
  expect(layout.panels[0]!.panel.bottom).toBeCloseTo(
    layout.panels[2]!.panel.top,
    5,
  );
});

test("keeps polar Web Mercator fits inside the projected world", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?eclipse=solar-2026-08-12-total");
  await expect(
    page.getByText("track calculated from", { exact: false }),
  ).toBeVisible();

  const mapBox = await page.locator("#mercator-map").boundingBox();
  const match = new URL(page.url()).hash.match(
    /^#map=([0-9.]+)\/(-?[0-9.]+)\/(-?[0-9.]+)$/,
  );
  expect(mapBox).not.toBeNull();
  expect(match).not.toBeNull();

  const zoom = Number(match![1]);
  const latitude = Number(match![2]);
  const worldSize = 256 * 2 ** zoom;
  const latitudeRadians = (latitude * Math.PI) / 180;
  const centerY =
    ((1 -
      Math.log(
        Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians),
      ) /
        Math.PI) /
      2) *
    worldSize;

  expect(centerY - mapBox!.height / 2).toBeGreaterThanOrEqual(-0.5);
  expect(centerY + mapBox!.height / 2).toBeLessThanOrEqual(
    worldSize + 0.5,
  );
});

test("searches a year and calculates the complete 2026 path", async ({
  page,
}) => {
  const catalogueRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("eclipse-catalogue.json")) {
      catalogueRequests.push(request.url());
    }
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Shadowline" })).toBeVisible();
  await expect(
    page.getByText("track calculated from", { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("Partial-eclipse extent")).toBeChecked();
  await expect(page.getByLabel("Sunrise / sunset limits")).toBeChecked();
  await expect(page.getByLabel("P1–P4 contacts")).toBeChecked();
  await expect(page.getByRole("tab", { name: "By date" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tab", { name: "By place" })).toBeVisible();
  await expect(page.getByText("Upcoming solar eclipses")).toBeVisible();
  await expect(page.locator("[data-event-id]")).toHaveCount(5);
  await page
    .getByRole("button", { name: "Show 5 later eclipses" })
    .click();
  await expect(page.locator("[data-event-id]")).toHaveCount(10);
  const firstLoadedId = await page
    .locator("[data-event-id]")
    .first()
    .getAttribute("data-event-id");
  expect(firstLoadedId).not.toBeNull();
  await page.locator("#sidebar").evaluate((element) => {
    element.scrollTop = 0;
  });
  const firstLoadedBefore = await page
    .locator(`[data-event-id="${firstLoadedId}"]`)
    .boundingBox();
  await page
    .getByRole("button", { name: "Show 5 earlier eclipses" })
    .click();
  await expect(page.locator("[data-event-id]")).toHaveCount(15);
  const firstLoadedAfter = await page
    .locator(`[data-event-id="${firstLoadedId}"]`)
    .boundingBox();
  expect(firstLoadedBefore).not.toBeNull();
  expect(firstLoadedAfter).not.toBeNull();
  expect(firstLoadedAfter!.y).toBeCloseTo(firstLoadedBefore!.y, 0);
  const initialPeaks = await page
    .locator("[data-event-id]")
    .evaluateAll((buttons) =>
      buttons.map((button) =>
        button.getAttribute("data-event-id"),
      ),
    );
  expect(new Set(initialPeaks).size).toBe(initialPeaks.length);
  const yearInput = page.getByLabel("Calendar year");
  await expect(yearInput).not.toHaveAttribute("min");
  await expect(yearInput).not.toHaveAttribute("max");
  await yearInput.fill("3500");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("Solar eclipses · 3500")).toBeVisible();
  await yearInput.fill("2023");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("Solar eclipses · 2023")).toBeVisible();
  const hybrid = page.getByRole("button", { name: /20 April 2023/ });
  await expect(hybrid).toContainText("Hybrid");
  await hybrid.click();
  await expect(
    page.getByText("Hybrid track calculated from", { exact: false }),
  ).toBeVisible();
  expect(catalogueRequests).toEqual([]);
});

test("keeps discovery results stable when selecting an eclipse", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByText("track calculated from", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Show 5 later eclipses" })
    .click();
  await expect(page.locator("[data-event-id]")).toHaveCount(10);

  const eventIds = await page
    .locator("[data-event-id]")
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("data-event-id")),
    );
  await page.locator("[data-event-id]").nth(1).click();
  await expect(
    page.getByText("calculated from", { exact: false }),
  ).toBeVisible();

  await expect(page.locator("[data-event-id]")).toHaveCount(10);
  expect(
    await page
      .locator("[data-event-id]")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("data-event-id")),
      ),
  ).toEqual(eventIds);
});

test("keeps the newest event search when an older search finishes later", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByText("track calculated from", { exact: false }),
  ).toBeVisible();

  await page.getByLabel("Calendar year").fill("2023");
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByLabel("Calendar year").fill("2026");
  await page.getByRole("button", { name: "Search" }).click();

  await expect(page.getByText("Solar eclipses · 2026")).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(page.getByText("Solar eclipses · 2026")).toBeVisible();
  await expect(page.getByText("Solar eclipses · 2023")).toHaveCount(0);
});

test("renders global visibility for a partial-only eclipse", async ({
  page,
}) => {
  await page.goto("/?eclipse=solar-2025-03-29-partial&year=2025");
  await expect(
    page.getByText("Partial-eclipse visibility calculated", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download GeoJSON" }),
  ).toBeEnabled();
});

test("restores a selected place from shareable state", async ({ page }) => {
  await page.goto(
    "/?eclipse=solar-2026-08-12-total&lat=41.81670&lon=-3.18500",
  );
  await expect(page.getByText("Total at this point")).toBeVisible();
  await expect(
    page
      .getByRole("heading", { name: "At selected place" })
      .locator("..")
      .getByText("41.81670°, -3.18500°"),
  ).toBeVisible();
  await expect(page.getByText("Sun azimuth")).toBeVisible();
  await expect(
    page.getByText("penumbra outlines shown", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "At selected place" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "By date" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page).toHaveURL(/lat=41\.81670/);
  await expect(page).toHaveURL(/locator=date/);
  await expect(page).toHaveURL(/around=2026-08-12/);
});

test("restores and pages one chronological place timeline", async ({
  page,
}) => {
  await page.goto(
    "/?eclipse=solar-2026-08-12-total&year=2026&locator=place&around=2026-08-12&lat=41.81670&lon=-3.18500",
  );
  await expect(page.getByText("Total at this point")).toBeVisible();
  await expect(page.getByRole("tab", { name: "By place" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByLabel("Around date")).toHaveValue("2026-08-12");
  await expect(page.getByText("Visible eclipses around 12 August 2026")).toBeVisible();
  await expect(page.locator("[data-local-peak]")).toHaveCount(11);
  await expect(page.getByText("1976–2076")).toHaveCount(0);
  await expect(page.getByText("Nearby visible eclipses", { exact: false })).toHaveCount(0);

  await page
    .getByRole("button", { name: "Show 5 earlier eclipses" })
    .click();
  await expect(page.locator("[data-local-peak]")).toHaveCount(16);
  await page
    .getByRole("button", { name: "Show 5 later eclipses" })
    .click();
  await expect(page.locator("[data-local-peak]")).toHaveCount(21);
  const peaks = await page
    .locator("[data-local-peak]")
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("data-local-peak")!),
    );
  expect(peaks).toEqual([...peaks].sort());
  expect(new Set(peaks).size).toBe(peaks.length);

  const selectedList = [...peaks];
  await page
    .locator("[data-local-peak]")
    .filter({ hasText: "2 August 2027" })
    .click();
  await expect(page).not.toHaveURL(/eclipse=solar-2026-08-12-total/);
  await expect(page).toHaveURL(/lat=41\.81670/);
  await expect(page).toHaveURL(/locator=place/);
  await expect(page).toHaveURL(/around=2026-08-12/);
  await expect(
    page
      .getByRole("heading", { name: "At selected place" })
      .locator("..")
      .getByText("Selected point"),
  ).toBeVisible();
  await expect(page.locator("[data-local-peak]")).toHaveCount(21);
  expect(
    await page
      .locator("[data-local-peak]")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("data-local-peak")!),
      ),
  ).toEqual(selectedList);
});

test("retains each locator timeline while switching modes", async ({
  page,
}) => {
  await page.goto(
    "/?eclipse=solar-2026-08-12-total&year=2026&locator=place&around=2026-08-12&lat=41.81670&lon=-3.18500",
  );
  await expect(page.locator("[data-local-peak]")).toHaveCount(11);
  const placePeaks = await page
    .locator("[data-local-peak]")
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("data-local-peak")),
    );

  await page.getByRole("tab", { name: "By date" }).click();
  await expect(page.locator("[data-event-id]")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Show 5 later eclipses" })
    .click();
  await expect(page.locator("[data-event-id]")).toHaveCount(7);
  const dateIds = await page
    .locator("[data-event-id]")
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("data-event-id")),
    );

  await page.getByRole("tab", { name: "By place" }).click();
  expect(
    await page
      .locator("[data-local-peak]")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("data-local-peak")),
      ),
  ).toEqual(placePeaks);

  const placePanel = page.getByRole("tabpanel", { name: "By place" });
  await placePanel.getByLabel("Around date").fill("2027-08-02");
  await placePanel.getByRole("button", { name: "Search" }).click();
  await expect(
    page.getByText("Visible eclipses around 2 August 2027"),
  ).toBeVisible();
  await expect(page.locator("[data-local-peak]")).toHaveCount(11);
  await expect(page).toHaveURL(/around=2027-08-02/);

  await page.getByRole("tab", { name: "By date" }).click();
  expect(
    await page
      .locator("[data-event-id]")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("data-event-id")),
      ),
  ).toEqual(dateIds);
});

test("refreshes place discovery after changing the map location in date mode", async ({
  page,
}) => {
  await page.goto(
    "/?eclipse=solar-2026-08-12-total&year=2026&locator=place&around=2026-08-12&lat=41.81670&lon=-3.18500",
  );
  await expect(page.locator("[data-local-peak]")).toHaveCount(11);
  const originalPeaks = await page
    .locator("[data-local-peak]")
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("data-local-peak")),
    );

  await page.getByRole("tab", { name: "By date" }).click();
  const mercator = page.locator("#mercator-map");
  await mercator.click();
  await expect
    .poll(() => mercator.getAttribute("data-selected-latitude"))
    .not.toBe("41.81670");

  await page.getByRole("tab", { name: "By place" }).click();
  await expect(page.locator("[data-local-peak]")).toHaveCount(10);
  expect(
    await page
      .locator("[data-local-peak]")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("data-local-peak")),
      ),
  ).not.toEqual(originalPeaks);
});

test("uses the maps as the place picker while keeping date discovery active", async ({
  page,
}) => {
  await page.goto("/?eclipse=solar-2026-08-12-total");
  await expect(
    page.getByText("track calculated from", { exact: false }),
  ).toBeVisible();

  await expect(page.getByLabel("Latitude, longitude")).toHaveCount(0);
  await expect(page.getByText("Local history window")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "At selected place" })).toBeVisible();
  await expect(
    page.getByText("Click any map to see local circumstances for the selected eclipse."),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: "By date" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("calculates shadows by clicking an eclipse overlay", async ({ page }) => {
  await page.goto("/?eclipse=solar-2026-08-12-total");
  await expect(
    page.getByText("track calculated from", { exact: false }),
  ).toBeVisible();
  await expect(page).toHaveURL(/#map=\d+\//);

  const [, zoomText, centerLatitudeText, centerLongitudeText] =
    new URL(page.url()).hash.match(
      /^#map=(\d+)\/([-\d.]+)\/([-\d.]+)$/,
    )!;
  const zoom = Number(zoomText);
  const worldSize = 256 * 2 ** zoom;
  const project = (latitude: number, longitude: number) => {
    const latitudeRadians = (latitude * Math.PI) / 180;
    return {
      x: ((longitude + 180) / 360) * worldSize,
      y:
        ((1 -
          Math.log(
            Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians),
          ) /
            Math.PI) /
          2) *
        worldSize,
    };
  };
  const center = project(
    Number(centerLatitudeText),
    Number(centerLongitudeText),
  );
  const target = project(65.219, -25.252);
  let deltaX = target.x - center.x;
  if (deltaX > worldSize / 2) deltaX -= worldSize;
  if (deltaX < -worldSize / 2) deltaX += worldSize;
  const mapBox = await page.locator("#mercator-map").boundingBox();
  expect(mapBox).not.toBeNull();
  await page.mouse.click(
    mapBox!.x + mapBox!.width / 2 + deltaX,
    mapBox!.y + mapBox!.height / 2 + target.y - center.y,
  );

  await expect(page.getByText("Total at this point")).toBeVisible();
  await expect(
    page.getByText("penumbra outlines shown", { exact: false }),
  ).toBeVisible();
  await expect(page).toHaveURL(/lat=65\./);
});

test("selects one synchronized observer from every projection", async ({
  page,
}) => {
  await page.goto("/?eclipse=solar-2026-08-12-total");
  await expect(
    page.getByText("track calculated from", { exact: false }),
  ).toBeVisible();

  for (const id of ["mercator-map", "globe-map", "world-map"]) {
    await page.locator(`#${id}`).click();
    const latitude = await page
      .locator(`#${id}`)
      .getAttribute("data-selected-latitude");
    const longitude = await page
      .locator(`#${id}`)
      .getAttribute("data-selected-longitude");
    expect(latitude).not.toBeNull();
    expect(longitude).not.toBeNull();
    for (const synchronizedId of [
      "mercator-map",
      "globe-map",
      "world-map",
    ]) {
      await expect(page.locator(`#${synchronizedId}`)).toHaveAttribute(
        "data-selected-latitude",
        latitude!,
      );
      await expect(page.locator(`#${synchronizedId}`)).toHaveAttribute(
        "data-selected-longitude",
        longitude!,
      );
    }
  }
});

test("renders and round-trips a selected location at the pole", async ({
  page,
}) => {
  await page.goto(
    "/?eclipse=solar-2026-08-12-total&lat=89.90000&lon=0.00000",
  );
  await expect(
    page.getByText("track calculated from", { exact: false }),
  ).toBeVisible();

  for (const id of ["mercator-map", "globe-map", "world-map"]) {
    await expect(page.locator(`#${id}`)).toHaveAttribute(
      "data-selected-latitude",
      "89.90000",
    );
    await expect(page.locator(`#${id}`)).toHaveAttribute(
      "data-selected-longitude",
      "0.00000",
    );
  }

  const globe = page.locator("#globe-map");
  const screenshot = await globe.screenshot();
  const marker = await page.evaluate(
    async (source) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D context unavailable.");
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      let count = 0;
      let totalX = 0;
      let totalY = 0;
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          const index = (y * canvas.width + x) * 4;
          if (
            Math.abs(pixels[index]! - 37) <= 3 &&
            Math.abs(pixels[index + 1]! - 109) <= 3 &&
            Math.abs(pixels[index + 2]! - 103) <= 3
          ) {
            count += 1;
            totalX += x;
            totalY += y;
          }
        }
      }
      return {
        count,
        x: totalX / count,
        y: totalY / count,
      };
    },
    `data:image/png;base64,${screenshot.toString("base64")}`,
  );
  expect(marker.count).toBeGreaterThan(20);

  const box = await globe.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + marker.x, box!.y + marker.y);
  await expect
    .poll(async () =>
      Number(
        (await globe.getAttribute("data-selected-latitude")) ?? -90,
      ),
    )
    .toBeGreaterThan(89.5);

  const latitude = await globe.getAttribute("data-selected-latitude");
  const longitude = await globe.getAttribute("data-selected-longitude");
  for (const id of ["mercator-map", "world-map"]) {
    await expect(page.locator(`#${id}`)).toHaveAttribute(
      "data-selected-latitude",
      latitude!,
    );
    await expect(page.locator(`#${id}`)).toHaveAttribute(
      "data-selected-longitude",
      longitude!,
    );
  }
});

test("applies one layer toggle to all renderers", async ({ page }) => {
  await page.goto("/?eclipse=solar-2026-08-12-total");
  await expect(
    page.getByText("track calculated from", { exact: false }),
  ).toBeVisible();

  await page.getByLabel("Central path", { exact: true }).uncheck();
  for (const id of ["mercator-map", "globe-map", "world-map"]) {
    await expect(page.locator(`#${id}`)).toHaveAttribute(
      "data-layer-central-path",
      "false",
    );
  }
});

test("keeps the equirectangular whole-Earth camera fixed", async ({
  page,
}) => {
  await page.goto("/?eclipse=solar-2026-08-12-total");
  await expect(
    page.getByText("track calculated from", { exact: false }),
  ).toBeVisible();
  const world = page.locator("#world-map");
  await expect(world.locator(".leaflet-control-zoom")).toHaveCount(0);
  const pane = world.locator(".leaflet-map-pane");
  const before = await pane.getAttribute("style");
  const box = await world.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box!.x + box!.width / 2 + 80,
    box!.y + box!.height / 2 + 40,
  );
  await page.mouse.up();
  await page.mouse.wheel(0, -500);
  expect(await pane.getAttribute("style")).toBe(before);
});

test("keeps Leaflet maps usable when WebGL is unavailable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      contextId: string,
      ...args: unknown[]
    ) {
      if (contextId.startsWith("webgl")) return null;
      return Reflect.apply(original, this, [contextId, ...args]);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  await page.goto("/?eclipse=solar-2026-08-12-total");
  await expect(
    page.locator("#globe-map").getByText("globe is unavailable", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.locator("#mercator-map")).toHaveAttribute(
    "data-renderer-ready",
    "true",
  );
  await expect(page.locator("#world-map")).toHaveAttribute(
    "data-renderer-ready",
    "true",
  );
});

test("downloads deterministic browser-generated GIS files", async ({
  page,
}) => {
  await page.goto("/?eclipse=solar-2026-08-12-total");
  const geoJsonButton = page.getByRole("button", { name: "Download GeoJSON" });
  await expect(geoJsonButton).toBeEnabled();
  const downloadPromise = page.waitForEvent("download");
  await geoJsonButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    "solar-2026-08-12-total.geojson",
  );
});

test("renders both 2027 central tracks through horizon singularities", async ({
  page,
}) => {
  await page.goto("/?eclipse=solar-2027-02-06-annular&year=2027");
  await expect(
    page.getByText("Annular track calculated from", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Total 2 August 2027/ }).click();
  await expect(
    page.getByText("Total track calculated from", { exact: false }),
  ).toBeVisible();
});

test("fits antimeridian tracks in one continuous Leaflet world", async ({
  page,
}) => {
  await page.goto("/?eclipse=solar-2016-03-09-total&year=2016");
  await expect(
    page.getByText("Total track calculated from", { exact: false }),
  ).toBeVisible();
  await expect
    .poll(() => Number(new URL(page.url()).hash.split("/")[2]))
    .toBeGreaterThan(100);
  const longitude = Number(new URL(page.url()).hash.split("/")[2]);
  expect(longitude).toBeGreaterThan(100);
  expect(longitude).toBeLessThan(200);
});

test("stacks the projection panels on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 900 });
  await page.goto("/?eclipse=solar-2026-08-12-total");
  await expect(page.locator("#globe-map")).toHaveAttribute(
    "data-renderer-ready",
    "true",
  );
  const mercator = await page.locator(".mercator-panel").boundingBox();
  const globe = await page.locator(".globe-panel").boundingBox();
  const world = await page.locator(".world-panel").boundingBox();
  expect(mercator).not.toBeNull();
  expect(globe).not.toBeNull();
  expect(world).not.toBeNull();
  expect(globe!.y).toBeGreaterThan(mercator!.y + mercator!.height - 2);
  expect(world!.y).toBeGreaterThan(globe!.y + globe!.height - 2);
});
