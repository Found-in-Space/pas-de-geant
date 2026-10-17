import { describe, expect, it, vi } from "vitest";
import { loadDatasetConfiguration, loadVoiceConfiguration } from "../integration/src/configuration.js";

const url = "https://integration.example.test/checks/config.local.json";

describe("isolated external service configuration", () => {
  it("resolves descriptors from the config location and leaves tile templates to the public dataset contract", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      datasets: { body: "moon", sources: { imagery: {
        productUrl: "./products/moon.json", urlTemplate: "./tiles/{z}/{x}/{y}", attribution: "Fixture",
      } } },
      // Unused voice configuration must not affect the dataset case.
      voice: { sessionEndpoint: "http://[" },
    }));
    const configuration = await loadDatasetConfiguration(url, fetcher);
    expect(configuration.sources.imagery).toEqual({
      productUrl: "https://integration.example.test/checks/products/moon.json",
      urlTemplate: "./tiles/{z}/{x}/{y}", attribution: "Fixture",
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(url, { cache: "no-store", headers: { Accept: "application/json" } });
  });

  it("resolves an external voice endpoint without inspecting unused dataset configuration", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      voice: { sessionEndpoint: "../token", profile: "fixture" }, datasets: { sources: null },
    }));
    expect(await loadVoiceConfiguration(url, fetcher)).toEqual({
      sessionEndpoint: "https://integration.example.test/token", profile: "fixture",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports a missing local config or missing capability instead of starting a service", async () => {
    await expect(loadDatasetConfiguration(url, async () => new Response(null, { status: 404 }))).rejects.toThrow("Create integration/config.local.json");
    await expect(loadVoiceConfiguration(url, async () => Response.json({}))).rejects.toThrow("voice.sessionEndpoint");
    await expect(loadDatasetConfiguration(url, async () => Response.json({}))).rejects.toThrow("datasets.body");
  });
});
