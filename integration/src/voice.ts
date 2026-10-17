import { mountViewer, runCase } from "./case.js";
import { loadVoiceConfiguration, localConfigurationUrl } from "./configuration.js";

runCase(async () => {
  const voice = await loadVoiceConfiguration(localConfigurationUrl());
  await mountViewer("world", { bodies: ["moon"], controls: false, ai: voice });
});
