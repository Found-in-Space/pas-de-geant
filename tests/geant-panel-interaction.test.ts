import { expect, it, vi } from "vitest";
import * as THREE from "three";
import { createGeantPanelPlugin, createGeantViewer, formatScaleRatio } from "@found-in-space/pas-de-geant";
import { createThreeUIEnvironment, type CanvasContextLike } from "@found-in-space/touch-os/hosts/three";
import type { DisplayRuntime, InteractionSource } from "@found-in-space/touch-os";
import { panelAction, standardPanelRoot } from "../integration/src/standard-panel.js";

it("applies a held standard-panel edit through public composition before release and redraws applied state", async () => {
  const renderer = { xr: { isPresenting: false, getSession: () => null }, render: vi.fn() } as unknown as THREE.WebGLRenderer;
  const viewer = await createGeantViewer({ renderer, scaleDenominator: 1e3 });
  const ui = createThreeUIEnvironment({ parent: viewer.scene });
  let runtime: DisplayRuntime | undefined;
  const context = new Proxy({ measureText: (text: string) => ({ width: text.length * 8 }) }, {
    get(object, key) { return key === "measureText" ? object.measureText : () => {}; }
  }) as unknown as CanvasContextLike;
  await viewer.install(createGeantPanelPlugin({ id: "standard", environment: ui,
    root: snapshot => standardPanelRoot(snapshot), action: panelAction, surface: { width: 480, height: 480 },
    initialize(value) { runtime = value; },
    placement: { createCanvas: metrics => ({ width: metrics.width, height: metrics.height, getContext: () => context }) } }));
  ui.update({ timestamp: 0 });
  const track = runtime!.render().commands.find(command => command.role === "slider-track");
  if (track?.type !== "rect") throw new Error("Missing scale track");
  const input = (fraction: number): InteractionSource => ({ id: "right", space: "world-metres", tracked: true,
    pointerType: "controller", surface: { targetId: "standard", x: track.rect.x + track.rect.width * fraction, y: track.rect.y + track.rect.height / 2 } });
  const begin = input(1 / 3);
  ui.update({ timestamp: 1, sources: [begin], edges: [{ phase: "begin", timestamp: 1, source: begin }] });
  const drag = input(0.75);
  ui.update({ timestamp: 2, sources: [drag] });
  await Promise.resolve();
  expect(viewer.navigation.scaleDenominator).toBeCloseTo(10 ** 6.75);
  expect(ui.interaction.getSnapshot("right")?.capture).toBeDefined();
  expect(runtime!.render().commands).toContainEqual(expect.objectContaining({ role: "slider-value", text: formatScaleRatio(viewer.navigation.scaleDenominator) }));
  ui.update({ timestamp: 3, sources: [] });
  expect(ui.interaction.getSnapshot("right")).toBeUndefined();
  expect(viewer.navigation.scaleDenominator).toBeCloseTo(10 ** 6.75);
  await viewer.dispose(); ui.dispose();
});
