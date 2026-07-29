import { expect, test } from "@playwright/test";

test("starts terrain loading and exposes the scale controls", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    Reflect.set(window, "__constructTerrainRequests", 0);
    window.fetch = (input, init) => {
      const source = input instanceof Request ? input.url : String(input);
      if (!source.startsWith("https://tiles.mapterhorn.com/")) {
        return nativeFetch(input, init);
      }
      Reflect.set(
        window,
        "__constructTerrainRequests",
        Number(Reflect.get(window, "__constructTerrainRequests")) + 1,
      );
      return Promise.resolve(new Response(null, { status: 404 }));
    };
  });

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
  await expect(body).toHaveAttribute(
    "data-construct-topography-source",
    "mapterhorn",
  );
  await expect(body).toHaveAttribute(
    "data-construct-texture-source",
    "blue-marble",
  );
  await expect(body).toHaveAttribute("data-construct-xr-foveation", "0");
  await expect(body).toHaveAttribute("data-construct-scale-factor", "1.00");
  await expect(body).toHaveAttribute("data-construct-zoom", "6");
  await expect(page.locator("[data-scale-factor]")).toHaveCount(5);
  await expect(
    page.locator('[data-scale-factor="1"]'),
  ).toHaveAttribute("data-active", "true");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Number(Reflect.get(window, "__constructTerrainRequests")),
      ),
    )
    .toBeGreaterThan(0);
});
