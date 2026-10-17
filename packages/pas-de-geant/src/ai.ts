import { createVoiceRuntime, type VoiceRuntimeOptions, type VoiceSnapshot } from "@found-in-space/voice-os";
import { createOpenAIRealtimeTransport } from "@found-in-space/voice-os/openai";
import { bindVoiceButton, createBrowserVoiceAudio, type BrowserVoiceAudioOptions } from "@found-in-space/voice-os/browser";
import type { SkykitPlugin } from "./skykit-runtime.js";
import { getGeantContext } from "./viewer.js";
import { geantAiCapabilities } from "./ai-tools.js";

export interface GeantVoiceOptions extends Omit<VoiceRuntimeOptions, "transport"> {
  readonly sessionEndpoint: string;
  readonly profile?: string;
  readonly host?: HTMLElement;
  readonly onAudioState?: BrowserVoiceAudioOptions["onState"];
  readonly onStatus?: (snapshot: VoiceSnapshot) => void;
}
/** Shared browser integration; VoiceOS owns the connection, microphone and protocol. */
export function createGeantVoiceRuntime(options: GeantVoiceOptions) {
  const audio = createBrowserVoiceAudio({ host: options.host, onState: options.onAudioState });
  const runtime = createVoiceRuntime({ ...options,
    transport: createOpenAIRealtimeTransport({ sessionEndpoint: options.sessionEndpoint, profile: options.profile, audio }),
  });
  const unsubscribe = options.onStatus ? runtime.subscribe(options.onStatus) : () => {};
  return { ...runtime, get active() { return runtime.active; },
    async toggle() { if (runtime.getSnapshot().playback === "blocked") await runtime.resumePlayback(); else await runtime.toggle(); },
    async dispose() { unsubscribe(); try { await runtime.dispose(); } finally { audio.dispose(); } },
  };
}
export type { GeantAiOptions } from "./config.js";
import type { GeantAiOptions } from "./config.js";
/** Optional service capability. It never starts a microphone or connection during setup. */
export function createGeantAiPlugin(options: GeantAiOptions): SkykitPlugin {
  if (!options.sessionEndpoint.trim()) throw new Error("AI requires a session endpoint.");
  return { id: "geant:ai", setup(context) {
    const geant = getGeantContext(context);
    const actions = geantAiCapabilities(geant.navigation.getSnapshot().bodies);
    const voice = createGeantVoiceRuntime({ ...options, host: geant.host ?? undefined,
      stateSources: [{ key: "geant", snapshot: () => geant.navigation.getSnapshot() }],
      tools: actions.map(tool => ({ contract: tool.contract,
        async execute(args, toolContext) {
          toolContext.signal.throwIfAborted();
          if (!tool.action) return geant.navigation.getSnapshot();
          const results = await context.actions.invoke(tool.action, args, { source: "voice" });
          for (const result of results) if (result.status === "rejected") throw result.reason;
          return geant.navigation.getSnapshot();
        } })),
    });
    context.addDisposable(() => voice.dispose());
    if (options.button !== false && geant.host) {
      const button = geant.host.ownerDocument.createElement("button"); button.type = "button"; button.textContent = "Talk about this world";
      button.style.cssText = "position:absolute;right:1rem;bottom:1rem;z-index:1";
      const status = geant.host.ownerDocument.createElement("span"); status.setAttribute("role", "status"); button.append(status);
      geant.host.append(button); const unbind = bindVoiceButton({ voice, button, status });
      context.addDisposable(() => { unbind(); button.remove(); });
    }
  } };
}
