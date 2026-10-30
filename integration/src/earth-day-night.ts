import { GEANT_ACTIONS } from "@found-in-space/pas-de-geant";
import { createDefaultSurfaceFactory } from "@found-in-space/pas-de-geant/browser";
import * as THREE from "three";
import { bodyPositionJ2000M, celestialBody } from "@found-in-space/pas-de-geant/worlds";
import { button, element, mountViewer, reportError, runCase } from "./case.js";

runCase(async () => {
  const browser = await mountViewer("world", { bodies: ["earth"], mode: "orbit", scaleDenominator: 5_000_000,
    time: "now", timeRate: 1, xr: true, autoStart: false, controls: { pointer: "orbit" },
    surfaces: { earth: createDefaultSurfaceFactory({ night: true }) } });
  const earth = bodyPositionJ2000M("earth", new Date(browser.time.getSnapshot().atMs));
  // Look across the terminator, rather than starting directly over midnight.
  const offset = new THREE.Vector3(earth.y, -earth.x, 0).normalize()
    .multiplyScalar(celestialBody("earth").referenceRadiusM * 2.5);
  await browser.actions.invoke(GEANT_ACTIONS.setObserver, {
    x: earth.x + offset.x, y: earth.y + offset.y, z: earth.z + offset.z,
  });
  browser.start();
  const time = element<HTMLInputElement>("utc-time");
  time.value = new Date(browser.time.getSnapshot().atMs).toISOString().slice(0, 16);
  const readout = element("simulation-time");
  const unsubscribe = browser.time.subscribe(snapshot => {
    readout.textContent = new Date(snapshot.atMs).toISOString();
  });
  browser.addDisposable(unsubscribe);
  readout.textContent = new Date(browser.time.getSnapshot().atMs).toISOString();
  async function setTime(atMs: number, rate = 0) {
    const results = await browser.actions.invoke(GEANT_ACTIONS.setTime, { atMs, rate });
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
  button("apply-time", async () => {
    if (!time.value || !time.validity.valid) throw new Error("Choose a valid UTC time.");
    await setTime(Date.parse(time.value + "Z"));
  });
  button("now", () => setTime(Date.now(), 1));
  button("animate", () => setTime(browser.time.getSnapshot().atMs, 600));
  button("pause", () => setTime(browser.time.getSnapshot().atMs));
  element<HTMLSelectElement>("appearance").addEventListener("change", event => {
    const night = (event.target as HTMLSelectElement).value === "day-night";
    void browser.setSurface("earth", createDefaultSurfaceFactory({ night })).catch(reportError);
  });
});
