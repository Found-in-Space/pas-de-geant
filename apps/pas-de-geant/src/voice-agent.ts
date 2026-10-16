import { bindVoiceTools, type VoiceRuntime, type VoiceSnapshot, type VoiceState, type VoiceToolHandlers } from '@found-in-space/voice-os';
import { createGeantVoiceRuntime } from '@found-in-space/pas-de-geant/ai';
import { EARTH_VOICE_TOOLS, ECLIPSE_VOICE_TOOLS } from './voice-contracts.js';

export interface RealtimeAgentStatus { state: VoiceState; detail: string }

/** Experience policy and labels remain here; VoiceOS owns media and protocol. */
type GeantVoiceAgentOptions = {
  greetingInstructions?: string;
  host?: HTMLElement;
  onStatus(status: RealtimeAgentStatus): void;
  onAudioState?: (state: 'off' | 'starting' | 'playing' | 'blocked') => void;
} & ({ experience?: 'earth'; tools: VoiceToolHandlers<typeof EARTH_VOICE_TOOLS> }
  | { experience: 'eclipse'; tools: VoiceToolHandlers<typeof ECLIPSE_VOICE_TOOLS> });

export function createGeantVoiceAgent(options: GeantVoiceAgentOptions): VoiceRuntime {
  const experience = options.experience ?? 'earth';
  const voice = createGeantVoiceRuntime({
    sessionEndpoint: '/api/realtime/token', profile: experience, host: options.host,
    onAudioState: options.onAudioState,
    tools: options.experience === 'eclipse'
      ? bindVoiceTools(ECLIPSE_VOICE_TOOLS, options.tools)
      : bindVoiceTools(EARTH_VOICE_TOOLS, options.tools),
    greetingInstructions: options.greetingInstructions ??
      'Greet the user warmly in one short sentence and invite them to ask about the world. Do not call a tool in this greeting.',
  });
  let first = true;
  voice.subscribe(snapshot => {
    if (first) { first = false; return; }
    options.onStatus({ state: snapshot.state, detail: voiceDetail(snapshot) });
  });
  return {
    ...voice,
    get active() { return voice.active; },
    async toggle() {
      if (voice.getSnapshot().playback === 'blocked') await voice.resumePlayback();
      else await voice.toggle();
    },
    async dispose() { await voice.dispose(); },
  };
}

function voiceDetail(snapshot: VoiceSnapshot): string {
  if (snapshot.error) return snapshot.error;
  if (snapshot.playback === 'blocked') return 'Tap to enable voice audio';
  switch (snapshot.reason) {
    case 'disabled': return 'Press A to wake';
    case 'connecting': return 'Requesting microphone…';
    case 'hearing': return 'Hearing you…';
    case 'greeting': return 'Greeting…';
    case 'tools': return 'Using app controls…';
    case 'playback': return 'Speaking';
    case 'response': return 'Thinking…';
    default: return 'Listening';
  }
}
