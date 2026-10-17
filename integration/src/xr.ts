import { mountViewer, runCase } from "./case.js";
import { offerControlExtensions } from "./control-extensions.js";

runCase(async () => {
  offerControlExtensions(await mountViewer("world", { bodies: ["moon"], xr: true }));
});
