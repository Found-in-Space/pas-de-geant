import { mountViewer, runCase } from "./case.js";
import { loadDatasetConfiguration, localConfigurationUrl } from "./configuration.js";

runCase(async () => {
  const datasets = await loadDatasetConfiguration(localConfigurationUrl());
  await mountViewer("world", { bodies: [datasets.body], datasets: { [datasets.body]: datasets.sources } });
});
