import { mountViewer, runCase } from "./case.js";

runCase(async () => {
  await mountViewer("enabled", { bodies: ["moon"], controls: { pointer: "grab" } });
  await mountViewer("disabled", { bodies: ["moon"], controls: false });
});
