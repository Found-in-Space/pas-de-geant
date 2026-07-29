import { expect, test } from "@playwright/test";
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

function onePixelPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4" +
      "2mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
}

test("feathers partial Mapterhorn coverage into stable GEBCO fallback", async ({
  page,
}) => {
  test.setTimeout(420_000);
  const terrainImage = flatTerrariumPng();
  const imageryPixel = onePixelPng();
  const missingTiles = new Set([
    "6/54/21",
    "6/55/21",
    "6/54/22",
    "6/55/22",
    "6/54/25",
    "6/54/30",
  ]);
  const localImageryUrls: string[] = [];
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
  await page.route("https://gibs.earthdata.nasa.gov/**", async (route) => {
    if (route.request().url().includes("/wmts/epsg3857/")) {
      localImageryUrls.push(route.request().url());
    }
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: imageryPixel,
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
    "data-detail-source-zoom-range",
    "4-6",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-streaming-state",
    "steady",
    { timeout: 360_000 },
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-mesh-count",
    "155",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-fallback-cells",
    "5",
  );
  const tileStates = await page
    .locator("body")
    .getAttribute("data-detail-tile-states");
  expect(tileStates).toHaveLength(160);
  expect(tileStates?.replaceAll("r", "").replaceAll("f", "")).toBe("");
  expect(tileStates?.split("f")).toHaveLength(6);
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-imagery-requests",
    "0",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-centre-state",
    "r",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-material-side",
    "double",
  );
  expect(localImageryUrls).toEqual([]);
  await expect
    .poll(async () =>
      Number(
        await page.locator("body").getAttribute("data-detail-imagery-patches"),
      ),
    )
    .toBeGreaterThan(0);

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
