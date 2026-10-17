import { resolveSurfaceUrl, type BodySurfaceDatasets, type SolarSystemBodyId } from "@found-in-space/pas-de-geant/worlds";
import type { GeantAiOptions } from "@found-in-space/pas-de-geant/ai";

export interface IntegrationConfiguration {
  readonly datasets?: { readonly body: SolarSystemBodyId; readonly sources: BodySurfaceDatasets };
  readonly voice?: GeantAiOptions;
}

/** Only service-specific cases call this; ordinary cases need no local configuration. */
async function loadConfiguration(url: string, fetcher: typeof fetch): Promise<IntegrationConfiguration> {
  const response = await fetcher(url, { cache: "no-store", headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("Create integration/config.local.json from config.local.example.json before running this case.");
  return response.json();
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
