import { mountViewer, runCase } from "./case.js";

runCase(async () => {
  await mountViewer("world", { bodies: ["moon"], xr: true });
});
