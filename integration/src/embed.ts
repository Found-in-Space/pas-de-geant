import { Geant } from "@found-in-space/pas-de-geant/embed";
import { element, observeBrowser, runCase } from "./case.js";

runCase(async () => {
  const host = element("world");
  observeBrowser("world", await Geant.whenReady(host), () => Geant.unmount(host));
});
