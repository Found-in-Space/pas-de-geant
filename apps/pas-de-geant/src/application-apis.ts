import { createLocationGeocodeMiddleware } from "./location-context-server.js";
import { createRealtimeTokenMiddleware } from "./realtime-token-server.js";
import { createExternalKnowledgeMiddleware } from "./external-knowledge-server.js";

export function createApplicationApis(
  serverEnvironment: Record<string, string | undefined>,
  _appDirectory: string,
) {
  const apiKey = process.env.OPENAI_API_KEY || serverEnvironment.OPENAI_API_KEY;
  return {
    middlewares: [
      createRealtimeTokenMiddleware(apiKey),
      createLocationGeocodeMiddleware(
        process.env.PAS_DE_GEANT_GEOCODER_URL || serverEnvironment.PAS_DE_GEANT_GEOCODER_URL,
        process.env.PAS_DE_GEANT_FORWARD_GEOCODER_URL || serverEnvironment.PAS_DE_GEANT_FORWARD_GEOCODER_URL,
      ),
      createExternalKnowledgeMiddleware(apiKey),
    ],
  };
}
