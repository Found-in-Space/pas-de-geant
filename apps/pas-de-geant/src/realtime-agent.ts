export type RealtimeAgentState =
  | "off"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

export interface RealtimeAgentStatus {
  state: RealtimeAgentState;
  detail: string;
}

export interface RealtimeAgentToolCall {
  name: string;
  arguments: string;
  call_id: string;
}

export interface RealtimeAgentOptions {
  tokenEndpoint?: string;
  onStatus: (status: RealtimeAgentStatus) => void;
  onRemoteStream: (stream: MediaStream | null) => void;
  tools: Record<string, (argumentsValue: unknown) => unknown | Promise<unknown>>;
}

interface RealtimeServerEvent {
  type?: string;
  error?: { message?: string };
  response?: {
    output?: Array<Partial<RealtimeAgentToolCall> & { type?: string }>;
  };
}

interface RealtimeTokenResponse {
  value?: string;
  error?: string;
}

export class RealtimeVoiceAgent {
  private readonly tokenEndpoint: string;
  private readonly onStatus: RealtimeAgentOptions["onStatus"];
  private readonly onRemoteStream: RealtimeAgentOptions["onRemoteStream"];
  private readonly tools: RealtimeAgentOptions["tools"];
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private microphoneStream: MediaStream | null = null;
  private starting = false;
  private speaking = false;

  constructor(options: RealtimeAgentOptions) {
    this.tokenEndpoint = options.tokenEndpoint ?? "/api/realtime/token";
    this.onStatus = options.onStatus;
    this.onRemoteStream = options.onRemoteStream;
    this.tools = options.tools;
  }

  get active(): boolean {
    return this.starting || this.peerConnection !== null;
  }

  async toggle(): Promise<void> {
    if (this.active) {
      this.disable();
      return;
    }
    await this.enable();
  }

  async enable(): Promise<void> {
    if (this.active) return;
    this.starting = true;
    this.setStatus("connecting", "Requesting microphone…");
    try {
      const [microphoneStream, token] = await Promise.all([
        navigator.mediaDevices.getUserMedia({
          audio: {
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: true,
          },
        }),
        this.fetchToken(),
      ]);
      if (!this.starting) {
        for (const track of microphoneStream.getTracks()) track.stop();
        return;
      }
      this.microphoneStream = microphoneStream;
      await this.connect(microphoneStream, token);
    } catch (error) {
      const cancelled = !this.starting;
      this.cleanup();
      if (!cancelled) {
        this.setStatus(
          "error",
          error instanceof Error ? error.message : "Voice connection failed.",
        );
      }
    } finally {
      this.starting = false;
    }
  }

  disable(): void {
    this.starting = false;
    this.cleanup();
    this.setStatus("off", "Press A to wake");
  }

  private async fetchToken(): Promise<string> {
    const response = await fetch(this.tokenEndpoint, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    const payload = (await response.json().catch(() => ({}))) as
      RealtimeTokenResponse;
    if (!response.ok || !payload.value) {
      throw new Error(payload.error ?? `Voice server returned ${response.status}.`);
    }
    return payload.value;
  }

  private async connect(stream: MediaStream, token: string): Promise<void> {
    const peerConnection = new RTCPeerConnection();
    this.peerConnection = peerConnection;
    peerConnection.addEventListener("track", (event) => {
      // Some WebRTC implementations omit `streams` for a remote track even
      // though the track itself is valid. Always expose a playable stream.
      const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
      this.onRemoteStream(remoteStream);
    });
    peerConnection.addEventListener("connectionstatechange", () => {
      if (peerConnection !== this.peerConnection) return;
      if (peerConnection.connectionState === "failed") {
        this.cleanup();
        this.setStatus("error", "Voice connection failed.");
      } else if (peerConnection.connectionState === "disconnected") {
        this.setStatus("connecting", "Reconnecting…");
      }
    });
    for (const track of stream.getAudioTracks()) {
      peerConnection.addTrack(track, stream);
    }

    const dataChannel = peerConnection.createDataChannel("oai-events");
    this.dataChannel = dataChannel;
    dataChannel.addEventListener("open", () => {
      this.setStatus("listening", "Listening");
    });
    dataChannel.addEventListener("message", (event) => {
      void this.handleServerEvent(event.data);
    });
    dataChannel.addEventListener("close", () => {
      if (this.dataChannel !== dataChannel) return;
      this.cleanup();
      this.setStatus("error", "Voice connection closed.");
    });

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    const response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/sdp",
      },
    });
    if (!response.ok) {
      throw new Error(`OpenAI Realtime returned ${response.status}.`);
    }
    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: await response.text(),
    });
  }

  private async handleServerEvent(rawEvent: unknown): Promise<void> {
    if (typeof rawEvent !== "string") return;
    let event: RealtimeServerEvent;
    try {
      event = JSON.parse(rawEvent) as RealtimeServerEvent;
    } catch {
      return;
    }
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        this.setStatus("listening", "Hearing you…");
        break;
      case "input_audio_buffer.speech_stopped":
      case "response.created":
        this.setStatus("thinking", "Thinking…");
        break;
      case "output_audio_buffer.started":
      case "response.output_audio.delta":
        this.speaking = true;
        this.setStatus("speaking", "Speaking");
        break;
      case "output_audio_buffer.stopped":
        this.speaking = false;
        this.setStatus("listening", "Listening");
        break;
      case "response.done":
        await this.handleResponseDone(event);
        break;
      case "error":
        this.setStatus("error", event.error?.message ?? "Realtime API error.");
        break;
    }
  }

  private async handleResponseDone(event: RealtimeServerEvent): Promise<void> {
    const calls = (event.response?.output ?? []).filter(
      (item): item is RealtimeAgentToolCall & { type: "function_call" } =>
        item.type === "function_call" &&
        typeof item.name === "string" &&
        typeof item.arguments === "string" &&
        typeof item.call_id === "string",
    );
    if (calls.length === 0) {
      if (!this.speaking) this.setStatus("listening", "Listening");
      return;
    }

    this.setStatus("thinking", "Using app controls…");
    for (const call of calls) {
      const output = await this.executeTool(call);
      this.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(output),
        },
      });
    }
    this.send({ type: "response.create" });
  }

  private async executeTool(call: RealtimeAgentToolCall): Promise<unknown> {
    const handler = this.tools[call.name];
    if (!handler) return { error: `Unknown tool: ${call.name}` };
    try {
      const argumentsValue = JSON.parse(call.arguments) as unknown;
      return await handler(argumentsValue);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Tool execution failed.",
      };
    }
  }

  private send(event: unknown): void {
    if (this.dataChannel?.readyState !== "open") return;
    this.dataChannel.send(JSON.stringify(event));
  }

  private setStatus(state: RealtimeAgentState, detail: string): void {
    this.onStatus({ state, detail });
  }

  private cleanup(): void {
    this.onRemoteStream(null);
    this.dataChannel?.close();
    this.dataChannel = null;
    this.peerConnection?.close();
    this.peerConnection = null;
    for (const track of this.microphoneStream?.getTracks() ?? []) track.stop();
    this.microphoneStream = null;
    this.speaking = false;
  }
}

export function parseLocationToolArguments(value: unknown): {
  latitudeDegrees: number;
  longitudeDegrees: number;
} {
  if (!value || typeof value !== "object") {
    throw new Error("Location arguments must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const latitudeDegrees = candidate.latitude_degrees;
  const longitudeDegrees = candidate.longitude_degrees;
  if (
    typeof latitudeDegrees !== "number" ||
    !Number.isFinite(latitudeDegrees) ||
    latitudeDegrees < -90 ||
    latitudeDegrees > 90
  ) {
    throw new Error("Latitude must be between -90 and 90 degrees.");
  }
  if (
    typeof longitudeDegrees !== "number" ||
    !Number.isFinite(longitudeDegrees) ||
    longitudeDegrees < -180 ||
    longitudeDegrees > 180
  ) {
    throw new Error("Longitude must be between -180 and 180 degrees.");
  }
  return { latitudeDegrees, longitudeDegrees };
}
