import { button, disposeViewer, mountViewer, runCase } from "./case.js";

runCase(async () => {
  const earth = await mountViewer("earth", { bodies: ["earth"] });
  const moonOptions = { bodies: ["moon"] as const, location: { latitudeDegrees: 18, longitudeDegrees: -24 } };
  let moon = await mountViewer("moon", moonOptions);
  button("scale", () => moon.actions.invoke("geant:scale.set", { scaleDenominator: moon.getSnapshot().scaleDenominator / 2 }));
  button("dispose", () => disposeViewer("moon"));
  button("remount", async () => { await disposeViewer("moon"); moon = await mountViewer("moon", moonOptions); });
  button("pause", () => { if (earth.running) earth.stop(); else earth.start(); });
});
