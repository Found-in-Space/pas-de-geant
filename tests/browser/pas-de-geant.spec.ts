import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function flatTerrariumPng(heightM = 100): Buffer {
  const size = 512;
  const encoded = heightM + 32_768;
  const red = Math.floor(encoded / 256);
  const green = Math.floor(encoded % 256);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row += 1) {
    const rowOffset = row * (size * 4 + 1);
    for (let column = 0; column < size; column += 1) {
      const offset = rowOffset + 1 + column * 4;
      raw[offset] = red;
      raw[offset + 1] = green;
      raw[offset + 2] = 0;
      raw[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function flatColourPng(
  size: number,
  red: number,
  green: number,
  blue: number,
): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row += 1) {
    const rowOffset = row * (size * 4 + 1);
    for (let column = 0; column < size; column += 1) {
      const offset = rowOffset + 1 + column * 4;
      raw[offset] = red;
      raw[offset + 1] = green;
      raw[offset + 2] = blue;
      raw[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function reachImageryRefinement(
  page: Page,
  activation: "prefetching" | "active",
): Promise<void> {
  await page.evaluate((nextActivation) => {
    window.__PAS_DE_GEANT_TEST_SET_SCALE__?.(
      nextActivation === "prefetching" ? 450 : 520,
    );
  }, activation);
  await expect(page.locator("body")).toHaveAttribute(
    "data-imagery-refinement",
    activation,
    { timeout: 30_000 },
  );
}

async function reachImageryBase(
  page: Page,
  activation: "prefetching" | "active",
): Promise<void> {
  await page.evaluate((nextActivation) => {
    window.__PAS_DE_GEANT_TEST_SET_SCALE__?.(
      nextActivation === "prefetching" ? 1.75 : 2.1,
    );
  }, activation);
  await expect(page.locator("body")).toHaveAttribute(
    "data-imagery-activation",
    activation,
    { timeout: 30_000 },
  );
}

async function deactivateImageryBase(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__PAS_DE_GEANT_TEST_SET_SCALE__?.(1);
  });
  await expect(page.locator("body")).toHaveAttribute(
    "data-imagery-activation",
    "inactive",
    { timeout: 30_000 },
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-imagery-visible-sources",
    "0",
    { timeout: 30_000 },
  );
}

async function routeFlatTerrain(page: Page): Promise<void> {
  const terrainImage = flatTerrariumPng();
  await page.route("https://tiles.mapterhorn.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: terrainImage,
    });
  });
}

test("keeps complete GEBCO coverage while Mapterhorn commits atomically", async ({
  page,
}) => {
  test.setTimeout(420_000);
  const terrainImage = flatTerrariumPng();
  const remoteImageUrls: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.resourceType() === "image" &&
      ["http:", "https:"].includes(url.protocol) &&
      !["127.0.0.1", "localhost"].includes(url.hostname)
    ) {
      remoteImageUrls.push(request.url());
    }
  });
  const missingTiles = new Set([
    "6/54/21",
    "6/55/21",
    "6/54/22",
    "6/55/22",
    "6/54/25",
    "6/54/30",
  ]);
  await page.route("https://tiles.mapterhorn.com/**", async (route) => {
    const parts = new URL(route.request().url()).pathname.split("/");
    const key = `${parts[1]}/${parts[2]}/${parts[3]?.split(".")[0]}`;
    if (missingTiles.has(key)) {
      await route.fulfill({
        status: 404,
        contentType: "text/plain",
        body: "No elevation tile",
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: terrainImage,
    });
  });
  await page.goto("/");
  await expect(page.locator("#loading-state")).toBeHidden({
    timeout: 20_000,
  });
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-relief",
    "ready",
    { timeout: 60_000 },
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-window-size",
    "160",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-coverage-mesh-count",
    "160",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-source-zoom-range",
    "4-6",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-fallback-cells",
    "5",
    { timeout: 60_000 },
  );
  await expect
    .poll(
      async () =>
        Number(
          await page
            .locator("body")
            .getAttribute("data-detail-atomic-swap-total"),
        ),
      { timeout: 120_000 },
    )
    .toBeGreaterThan(0);
  await expect
    .poll(async () =>
      Number(
        await page.locator("body").getAttribute("data-detail-mesh-count"),
      ),
    )
    .toBeGreaterThan(0);
  const tileStates = await page
    .locator("body")
    .getAttribute("data-detail-tile-states");
  expect(tileStates).toHaveLength(160);
  expect(tileStates?.replace(/[rfdpo]/g, "")).toBe("");
  expect(tileStates?.split("f")).toHaveLength(6);
  expect(
    await page.locator("body").getAttribute("data-detail-centre-state"),
  ).toMatch(/[rd]/);
  expect(remoteImageUrls).toEqual([]);
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-material-side",
    "double",
  );
  await page.waitForTimeout(500);
  const frameHashes: string[] = [];
  for (let frame = 0; frame < 4; frame += 1) {
    const screenshot = await page.screenshot({
      clip: { x: 400, y: 360, width: 480, height: 240 },
    });
    frameHashes.push(createHash("sha256").update(screenshot).digest("hex"));
    await page.waitForTimeout(100);
  }
  expect(new Set(frameHashes).size).toBe(1);
});

test("progresses through photographic ancestors and gates precise sibling groups", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    window.__PAS_DE_GEANT_ENABLE_TEST_HOOKS__ = true;
    window.__PAS_DE_GEANT_IMAGERY_CONFIG__ = {
      id: "fault-injected-xyz",
      urlTemplate: "https://imagery.test/{z}/{x}/{y}.png",
      attribution: "Synthetic browser-test imagery",
      tileSize: 256,
      minZoom: 0,
      maxZoom: 20,
    };
  });
  await routeFlatTerrain(page);
  const imagery = flatColourPng(256, 30, 150, 70);
  let lowestRequestedZoom: number | undefined;
  let malformedParent: string | undefined;
  await page.route("https://imagery.test/**", async (route) => {
    const parts = new URL(route.request().url()).pathname.split("/");
    const z = Number(parts[1]);
    const x = Number(parts[2]);
    const y = Number(parts[3]?.split(".")[0]);
    lowestRequestedZoom ??= z;
    await new Promise((resolve) => setTimeout(resolve, 60));
    if (z === lowestRequestedZoom && malformedParent === undefined) {
      malformedParent = `${z}/${x}/${y}`;
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from("malformed imagery"),
      });
      return;
    }
    if (
      z > lowestRequestedZoom &&
      x % 2 === 0 &&
      y % 2 === 0
    ) {
      await route.fulfill({
        status: 404,
        contentType: "text/plain",
        body: "No photographic tile",
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: imagery,
    });
  });

  await page.goto("/");
  await expect(page.locator("#loading-state")).toBeHidden({
    timeout: 20_000,
  });
  await expect(page.locator("body")).toHaveAttribute(
    "data-imagery-provider",
    "fault-injected-xyz",
  );

  await deactivateImageryBase(page);
  const prefetchEpoch = await page
    .locator("body")
    .getAttribute("data-imagery-page-table-epoch");
  await reachImageryBase(page, "prefetching");
  await expect
    .poll(
      async () =>
        Number(
          await page.locator("body").getAttribute("data-imagery-request-total"),
        ),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  await page.waitForTimeout(1_000);
  await expect(page.locator("body")).toHaveAttribute(
    "data-imagery-page-table-epoch",
    prefetchEpoch ?? "0",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-imagery-visible-sources",
    "0",
  );

  await reachImageryBase(page, "active");
  await expect
    .poll(
      async () =>
        Number(
          await page.locator("body").getAttribute("data-imagery-commit-total"),
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  await expect
    .poll(
      async () =>
        Number(
          await page
            .locator("body")
            .getAttribute("data-imagery-visible-sources"),
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  await reachImageryRefinement(page, "prefetching");
  await expect
    .poll(
      async () => {
        const desired = Number(
          await page
            .locator("body")
            .getAttribute("data-imagery-desired-zoom"),
        );
        const visible = Number(
          await page
            .locator("body")
            .getAttribute("data-imagery-visible-zoom"),
        );
        return desired > visible;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect(page.locator("body")).toHaveAttribute(
    "data-imagery-visible-exact",
    "0",
  );

  await reachImageryRefinement(page, "active");
  await expect
    .poll(
      async () =>
        Number(
          await page
            .locator("body")
            .getAttribute("data-imagery-visible-sources"),
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  await expect
    .poll(
      async () =>
        Number(
          await page
            .locator("body")
            .getAttribute("data-imagery-permanent-failures"),
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  await expect(page.locator("body")).toHaveAttribute(
    "data-imagery-visible-exact",
    "0",
  );
  await expect
    .poll(
      async () =>
        Number(
          await page
            .locator("body")
            .getAttribute("data-imagery-malformed-total"),
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
});

test("drops delayed imagery from stale geographic generations", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    window.__PAS_DE_GEANT_ENABLE_TEST_HOOKS__ = true;
    window.__PAS_DE_GEANT_IMAGERY_PROVIDER__ = {
      id: "stale-test-provider",
      attribution: "Synthetic browser-test imagery",
      tileSize: 256,
      minZoom: 0,
      maxZoom: 20,
      async load(address) {
        const normalizedX = (address.x + 0.5) / 2 ** address.z;
        await new Promise((resolve) =>
          setTimeout(resolve, normalizedX > 0.75 ? 4_000 : 1_500),
        );
        const response = await fetch(
          `https://imagery.test/${address.z}/${address.x}/${address.y}.png`,
        );
        return response.blob();
      },
    };
  });
  await routeFlatTerrain(page);
  const imagery = flatColourPng(256, 40, 80, 180);
  await page.route("https://imagery.test/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: imagery,
    });
  });

  await page.goto("/");
  await expect(page.locator("#loading-state")).toBeHidden({
    timeout: 20_000,
  });
  await reachImageryRefinement(page, "prefetching");
  await expect
    .poll(
      async () =>
        Number(
          await page.locator("body").getAttribute("data-imagery-requests"),
        ),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);

  const previousWindow = await page
    .locator("body")
    .getAttribute("data-imagery-window");
  const staleBefore = Number(
    await page.locator("body").getAttribute("data-imagery-stale-total"),
  );
  await page.evaluate(() => {
    window.__PAS_DE_GEANT_TEST_SET_LOCATION__?.(35.6762, 141.25);
  });
  await expect
    .poll(
      async () =>
        await page.locator("body").getAttribute("data-imagery-window"),
      { timeout: 20_000 },
    )
    .not.toBe(previousWindow);
  const epochAfterMove = await page
    .locator("body")
    .getAttribute("data-imagery-page-table-epoch");
  await expect
    .poll(
      async () =>
        Number(
          await page.locator("body").getAttribute("data-imagery-stale-total"),
        ),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(staleBefore);
  await expect(page.locator("body")).toHaveAttribute(
    "data-imagery-page-table-epoch",
    epochAfterMove ?? "0",
  );
});
