import { BlockList, isIP } from 'node:net';
import { createOpenAIVoiceTokenMiddleware, requestOpenAIClientSecret } from '@found-in-space/voice-os/server/openai';
import { EARTH_VOICE_TOOLS, ECLIPSE_VOICE_TOOLS } from './voice-contracts.js';
import { realtimeSessionConfiguration, type RealtimeExperience } from './voice-profiles.js';
export { realtimeSessionConfiguration } from './voice-profiles.js';
export type { RealtimeExperience } from './voice-profiles.js';
type FetchImplementation = typeof fetch;
export const REALTIME_TOKEN_PATH = '/api/realtime/token';

export function realtimeExperienceFromUrl(url: URL): RealtimeExperience | null {
  const legacy = url.searchParams.get('experience');
  const profile = url.searchParams.get('profile');
  if (legacy !== null && profile !== null && legacy !== profile) return null;
  const value = profile ?? legacy ?? 'earth';
  return value === 'earth' || value === 'eclipse' ? value : null;
}

const PRIVATE_NETWORKS = new BlockList();
PRIVATE_NETWORKS.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_NETWORKS.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE_NETWORKS.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE_NETWORKS.addSubnet("169.254.0.0", 16, "ipv4");
PRIVATE_NETWORKS.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_NETWORKS.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_NETWORKS.addAddress("::1", "ipv6");
PRIVATE_NETWORKS.addSubnet("fc00::", 7, "ipv6");
PRIVATE_NETWORKS.addSubnet("fe80::", 10, "ipv6");

export function isAllowedConnectionHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }
  if (normalized === "k-si.com" || normalized.endsWith(".k-si.com")) {
    return true;
  }
  const additionalHostname = process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS
    ?.trim().toLowerCase().replace(/\.$/, "");
  if (additionalHostname && normalized === additionalHostname) return true;
  const address = normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
  const version = isIP(address);
  return version !== 0 && PRIVATE_NETWORKS.check(
    address,
    version === 4 ? "ipv4" : "ipv6",
  );
}

export function isAllowedRequestOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      isAllowedConnectionHostname(url.hostname);
  } catch {
    return false;
  }
}


export function requestRealtimeClientSecret(
  apiKey: string,
  experienceOrFetch: RealtimeExperience | FetchImplementation = 'earth',
  fetchImplementation: FetchImplementation = fetch,
): Promise<{status: number; body: string}> {
  const experience = typeof experienceOrFetch === 'function' ? 'earth' : experienceOrFetch;
  return requestOpenAIClientSecret({ apiKey,
    configuration: realtimeSessionConfiguration(experience),
    fetch: typeof experienceOrFetch === 'function' ? experienceOrFetch : fetchImplementation,
  });
}

export function createRealtimeTokenMiddleware(apiKey: string | undefined) {
  return createOpenAIVoiceTokenMiddleware({ path: REALTIME_TOKEN_PATH, apiKey,
    profiles: {
      earth: { configuration: realtimeSessionConfiguration('earth'), tools: EARTH_VOICE_TOOLS },
      eclipse: { configuration: realtimeSessionConfiguration('eclipse'), tools: ECLIPSE_VOICE_TOOLS },
    },
    authorize: request => isAllowedRequestOrigin(request.headers.get('origin') ?? undefined),
    resolveProfile: request => realtimeExperienceFromUrl(new URL(request.url)),
  });
}
