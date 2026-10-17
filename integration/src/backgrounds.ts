import { button, element, mountViewer, runCase } from "./case.js";

runCase(async () => {
  const browser = await mountViewer("world", { bodies: ["earth"], xr: true });
  let remove: (() => void | Promise<void>) | undefined;
  let pending = Promise.resolve();
  const select = (choice: "none" | "image" | "catalog") => {
    // Serialize deliberate selections so a slow load cannot overwrite a later one.
    const selection = pending.then(async () => {
      await remove?.(); remove = undefined;
      if (choice === "image") {
        const { createGeantSkyImagePlugin } = await import("@found-in-space/pas-de-geant/sky-image");
        remove = await browser.install(createGeantSkyImagePlugin());
      } else if (choice === "catalog") {
        const { createGeantStarsPlugin } = await import("@found-in-space/pas-de-geant/stars");
        remove = await browser.install(createGeantStarsPlugin());
      }
      element("status").textContent = choice === "none" ? "No sky background." : choice === "image"
        ? "Static Deep Star Maps background." : "Catalog stars selected; acquisition runs asynchronously.";
    });
    pending = selection.catch(() => {});
    return selection;
  };
  button("none", () => select("none"));
  button("image", () => select("image"));
  button("catalog", () => select("catalog"));
});
