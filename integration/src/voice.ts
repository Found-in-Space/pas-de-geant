import { button, element, mountViewer, runCase } from "./case.js";
import { loadVoiceConfiguration, localConfigurationUrl } from "./configuration.js";

runCase(async () => {
  const browser = await mountViewer("world", { bodies: ["earth"], controls: false });
  let remove: (() => void | Promise<void>) | undefined;
  button("configure-voice", async () => {
    if (remove) {
      await remove(); remove = undefined;
      element("configure-voice").textContent = "Enable configured VoiceOS";
      return;
    }
    const voice = await loadVoiceConfiguration(localConfigurationUrl());
    const { createGeantAiPlugin } = await import("@found-in-space/pas-de-geant/ai");
    remove = await browser.install(createGeantAiPlugin(voice));
    element("configure-voice").textContent = "Remove VoiceOS";
  });
});
