import { button, disposeViewer, element, mountViewer, runCase } from "./case.js";
import { loadDatasetConfiguration, localConfigurationUrl } from "./configuration.js";
import { offerControlExtensions } from "./control-extensions.js";

runCase(async () => {
  let pending = Promise.resolve();
  const select = (change: () => Promise<void>) => {
    const next = pending.then(change);
    pending = next.catch(() => {});
    return next;
  };
  const defaults = async () => {
    await disposeViewer("world");
    offerControlExtensions(await mountViewer("world", { bodies: ["earth"], xr: true }));
    element("status").textContent = "Default Blue Marble imagery and Mapterhorn elevation.";
  };
  await defaults();
  button("load-datasets", () => select(async () => {
    const datasets = await loadDatasetConfiguration(localConfigurationUrl());
    await disposeViewer("world");
    offerControlExtensions(await mountViewer("world", { bodies: [datasets.body], datasets: { [datasets.body]: datasets.sources }, xr: true }));
    element("status").textContent = "Configured datasets loaded.";
  }));
  button("restore-defaults", () => select(defaults));
});
