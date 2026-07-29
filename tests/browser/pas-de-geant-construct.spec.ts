import { expect, test } from "@playwright/test";
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

function constructTerrariumPng(): Buffer {
  const size = 512;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row += 1) {
    const rowOffset = row * (size * 4 + 1);
    for (let column = 0; column < size; column += 1) {
      const u = column / (size - 1);
      const v = row / (size - 1);
      const periodicX = Math.sin(Math.PI * u) ** 2;
      const periodicY = Math.sin(Math.PI * v) ** 2;
      const heightM = Math.round(
        120 +
          1_900 * periodicX ** 2 * periodicY ** 2 +
          450 * periodicX * periodicY,
      );
      const encoded = heightM + 32_768;
      const offset = rowOffset + 1 + column * 4;
      raw[offset] = Math.floor(encoded / 256);
      raw[offset + 1] = Math.floor(encoded % 256);
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

test("loads the underfoot terrain first and exposes every scale preset", async ({
  page,
}, testInfo) => {
  const terrainImage = constructTerrariumPng();
  const requestedSources = new Set<string>();
  await page.route("https://tiles.mapterhorn.com/**", async (route) => {
    requestedSources.add(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: terrainImage,
    });
  });

  const previews = [
    { factor: 1, zoom: 6 },
    { factor: 100, zoom: 12 },
    { factor: 250, zoom: 14 },
    { factor: 500, zoom: 14 },
    { factor: 1000, zoom: 14 },
  ] as const;

  await page.goto("/construct/?scale=1");
  const body = page.locator("body");
  await expect(body).toHaveAttribute(
    "data-construct-expected-meshes",
    "160",
  );
  await expect(body).toHaveAttribute(
    "data-construct-required-tiles",
    "225",
  );
  await expect
    .poll(async () =>
      Number(await body.getAttribute("data-construct-mesh-count")),
    )
    .toBeGreaterThanOrEqual(4);
  await expect(body).toHaveAttribute(
    "data-construct-topography-source",
    "mapterhorn",
  );
  await expect(body).toHaveAttribute(
    "data-construct-texture-source",
    "blue-marble",
  );
  await expect(body).toHaveAttribute("data-construct-xr-foveation", "0");
  const screenshot = await page.screenshot();
  await testInfo.attach("construct-start-1x", {
    body: screenshot,
    contentType: "image/png",
  });
  await expect(body).toHaveAttribute("data-construct-ready", "true", {
    timeout: 30_000,
  });
  expect(
    Number(await body.getAttribute("data-construct-seam-checks")),
  ).toBeGreaterThan(0);
  expect(
    Number(await body.getAttribute("data-construct-seam-position-error")),
  ).toBeLessThan(1e-6);
  expect(
    Number(await body.getAttribute("data-construct-seam-offset-error")),
  ).toBeLessThan(0.001);

  for (const preview of previews) {
    if (preview.factor !== 1) {
      await page
        .locator(`[data-scale-factor="${preview.factor}"]`)
        .click();
    }
    await expect(body).toHaveAttribute(
      "data-construct-scale-factor",
      preview.factor === 1 ? "1.00" : String(preview.factor),
    );
    await expect(body).toHaveAttribute(
      "data-construct-zoom",
      String(preview.zoom),
    );
    await expect(
      page.locator(`[data-scale-factor="${preview.factor}"]`),
    ).toHaveAttribute("data-active", "true");
  }

  expect(requestedSources.size).toBeGreaterThan(0);
});
