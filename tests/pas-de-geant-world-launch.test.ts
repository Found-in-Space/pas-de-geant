import { describe, expect, it } from "vitest";
import { APOLLO11_VR_ENTRY, worldLaunchFromQuery } from "../apps/pas-de-geant/src/world-launch.js";

describe("world launch presets", () => {
  it("starts the Apollo entry at the LM on the Moon at 1:50 with its detail pyramid", () => {
    const launch = worldLaunchFromQuery(new URL(APOLLO11_VR_ENTRY, "https://example.com").searchParams);
    expect(launch.body).toBe("moon");
    expect(launch.location).toEqual({ latitudeDegrees: .67416, longitudeDegrees: 23.47314, source: "preset" });
    expect(launch.scaleDenominator).toBe(50);
    expect(launch.lunarPreview).toBe(true);
  });

  it("keeps ordinary Earth and Moon starts and ignores unusable scale inputs", () => {
    expect(worldLaunchFromQuery(new URLSearchParams())).toEqual({ body: "earth", lunarPreview: false });
    const moon = worldLaunchFromQuery(new URLSearchParams("world=moon&scale=-50"));
    expect(moon.location).toBeUndefined();
    expect(moon.scaleDenominator).toBeUndefined();
    expect(moon.lunarPreview).toBe(false);
    expect(worldLaunchFromQuery(new URLSearchParams("world=earth&site=apollo11")).location).toBeUndefined();
  });

  it("lets the same Apollo surface launch use a chosen scale or compare global imagery", () => {
    const launch = worldLaunchFromQuery(new URLSearchParams("world=moon&site=apollo11&scale=100&imagery=global"));
    expect(launch.scaleDenominator).toBe(100);
    expect(launch.lunarPreview).toBe(false);
  });
});
