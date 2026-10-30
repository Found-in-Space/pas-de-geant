import { resolveSurfaceUrl, type BodySurfaceDatasets, type SolarSystemBodyId, type XyzImageryConfiguration } from "@found-in-space/pas-de-geant/worlds";
import type { GeantAiOptions } from "@found-in-space/pas-de-geant/ai";

export interface IntegrationConfiguration {
  readonly datasets?: { readonly body: SolarSystemBodyId; readonly sources: BodySurfaceDatasets };
  readonly standardImagery?: XyzImageryConfiguration;
  readonly voice?: GeantAiOptions;
}

/** The standard imagery override is optional; service-specific cases require configuration. */
async function loadConfiguration(url: string, fetcher: typeof fetch, optional = false): Promise<IntegrationConfiguration> {
  const response = await fetcher(url, { cache: "no-store", headers: { Accept: "application/json" } });
  if (optional && response.status === 404) return {};
  if (!response.ok) throw new Error("Create integration/config.local.json from config.local.example.json before running this case.");
  return response.json();
}

export async function loadStandardImageryConfiguration(url: string, fetcher: typeof fetch = fetch) {
  const { standardImagery } = await loadConfiguration(url, fetcher, true);
  return standardImagery && { ...standardImagery, urlTemplate: resolveSurfaceUrl(standardImagery.urlTemplate, url) };
}

export async function loadDatasetConfiguration(url: string, fetcher: typeof fetch = fetch) {
  const { datasets } = await loadConfiguration(url, fetcher);
  if (!datasets) throw new Error("Set datasets.body and datasets.sources in config.local.json.");
  return { ...datasets, sources: Object.fromEntries(
    Object.entries(datasets.sources).map(([kind, binding]) => [kind, { ...binding, productUrl: resolveSurfaceUrl(binding.productUrl, url) }]),
  ) };
}

export async function loadVoiceConfiguration(url: string, fetcher: typeof fetch = fetch) {
  const { voice } = await loadConfiguration(url, fetcher);
  if (!voice) throw new Error("Set voice.sessionEndpoint in config.local.json to your external VoiceOS token service.");
  return { ...voice, sessionEndpoint: new URL(voice.sessionEndpoint, url).href };
}

export function localConfigurationUrl() {
  return new URL("./config.local.json", window.location.href).href;
}
