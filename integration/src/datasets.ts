import { mountViewer, runCase } from "./case.js";
import { loadDatasetConfiguration, localConfigurationUrl } from "./configuration.js";
import { offerControlExtensions } from "./control-extensions.js";

runCase(async () => {
  const datasets = await loadDatasetConfiguration(localConfigurationUrl());
  offerControlExtensions(await mountViewer("world", { bodies: [datasets.body], datasets: { [datasets.body]: datasets.sources }, xr: true }));
});
