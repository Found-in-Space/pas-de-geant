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

export function realtimeGreetingEvent(): Record<string, unknown> {
  return {
    type: "response.create",
    response: {
      instructions:
        "Greet the user warmly in one short sentence and invite them to ask " +
        "about the world. Do not call a tool in this greeting.",
      output_modalities: ["audio"],
    },
  };
}

interface RealtimeServerEvent {
  type?: string;
  error?: { message?: string };
  response?: {
    status?: string;
    status_details?: unknown;
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
  private userSpeechActive = false;
  private greetingStarted = false;
  private statusAfterPlayback: RealtimeAgentStatus | null = null;
  private activeResponseCount = 0;
  private responseRequestPending = false;
  private toolBatchesInFlight = 0;
  private continuationPending = false;

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
      this.reportMicrophoneProcessing(microphoneStream);
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
      this.setStatus("connecting", "Preparing voice guide…");
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
      case "session.created":
        this.startGreeting();
        break;
      case "input_audio_buffer.speech_started":
        this.userSpeechActive = true;
        this.setStatus("listening", "Hearing you…");
        break;
      case "input_audio_buffer.speech_stopped":
        this.userSpeechActive = false;
        // With create_response enabled, speech_stopped schedules an automatic
        // response before response.created arrives over the data channel.
        this.responseRequestPending = true;
        this.setStatus("thinking", "Thinking…");
        break;
      case "response.created":
        this.activeResponseCount += 1;
        this.responseRequestPending = false;
        if (!this.speaking && !this.userSpeechActive) {
          this.setStatus("thinking", "Thinking…");
        }
        break;
      case "output_audio_buffer.started":
      case "response.output_audio.delta":
        this.speaking = true;
        if (!this.userSpeechActive) this.setStatus("speaking", "Speaking");
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        this.speaking = false;
        this.applyStatusAfterPlayback();
        this.flushContinuation();
        break;
      case "response.done":
        await this.handleResponseDone(event);
        break;
      case "error": {
        console.error("Realtime API error:", event.error);
        this.responseRequestPending = false;
        const detail = event.error?.message ?? "Realtime API error.";
        if (this.speaking) {
          this.deferStatusAfterPlayback({ state: "error", detail });
        } else {
          this.setStatus("error", detail);
        }
        break;
      }
    }
  }

  private async handleResponseDone(event: RealtimeServerEvent): Promise<void> {
    this.activeResponseCount = Math.max(0, this.activeResponseCount - 1);
    const responseStatus = event.response?.status;
    const responseStatusDetails = event.response?.status_details;
    if (responseStatus !== undefined && responseStatus !== "completed") {
      const diagnostic = {
        status: responseStatus,
        statusDetails: responseStatusDetails,
      };
      if (responseStatus === "cancelled") {
        console.info("Realtime response cancelled:", diagnostic);
      } else {
        console.warn("Realtime response did not complete:", diagnostic);
      }
    }

    const calls = (event.response?.output ?? []).filter(
      (item): item is RealtimeAgentToolCall & { type: "function_call" } =>
        item.type === "function_call" &&
        typeof item.name === "string" &&
        typeof item.arguments === "string" &&
        typeof item.call_id === "string",
    );
    if (responseStatus !== undefined && responseStatus !== "completed") {
      this.settleTerminalResponse(responseStatus, responseStatusDetails);
      this.flushContinuation();
      return;
    }
    if (calls.length === 0) {
      this.settleTerminalResponse(responseStatus, responseStatusDetails);
      this.flushContinuation();
      return;
    }

    this.toolBatchesInFlight += 1;
    if (!this.speaking && !this.userSpeechActive) {
      this.setStatus("thinking", "Using app controls…");
    }
    try {
      const outputs: Array<{ call: RealtimeAgentToolCall; output: unknown }> = [];
      for (const call of calls) {
        outputs.push({ call, output: await this.executeTool(call) });
      }
      for (const { call, output } of outputs) {
        this.send({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify(output),
          },
        });
      }
      this.continuationPending = true;
    } finally {
      this.toolBatchesInFlight -= 1;
      this.flushContinuation();
    }
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

  private send(event: unknown): boolean {
    if (this.dataChannel?.readyState !== "open") return false;
    this.dataChannel.send(JSON.stringify(event));
    return true;
  }

  private startGreeting(): void {
    if (this.greetingStarted) return;
    this.greetingStarted = true;
    this.setStatus("thinking", "Greeting…");
    if (this.send(realtimeGreetingEvent())) {
      this.responseRequestPending = true;
    }
  }

  private settleTerminalResponse(
    status: string | undefined,
    statusDetails: unknown,
  ): void {
    const nextStatus = terminalResponseStatus(status, statusDetails);
    // response.done ends generation, but WebRTC may still be playing buffered
    // audio. Keep the speaking state until the output buffer stops or is cleared.
    if (this.speaking) {
      this.deferStatusAfterPlayback(nextStatus);
      return;
    }
    if (
      nextStatus.state !== "error" &&
      (this.userSpeechActive || this.hasResponseOrToolActivity())
    ) {
      return;
    }
    this.setStatus(nextStatus.state, nextStatus.detail);
  }

  private applyStatusAfterPlayback(): void {
    const nextStatus = this.statusAfterPlayback;
    this.statusAfterPlayback = null;
    if (nextStatus?.state === "error") {
      this.setStatus(nextStatus.state, nextStatus.detail);
      return;
    }
    if (this.userSpeechActive) return;
    if (this.hasResponseOrToolActivity()) {
      this.setStatus("thinking", "Thinking…");
      return;
    }
    this.setStatus(
      nextStatus?.state ?? "listening",
      nextStatus?.detail ?? "Listening",
    );
  }

  private deferStatusAfterPlayback(status: RealtimeAgentStatus): void {
    if (
      this.statusAfterPlayback?.state === "error" &&
      status.state !== "error"
    ) {
      return;
    }
    this.statusAfterPlayback = status;
  }

  private hasResponseOrToolActivity(): boolean {
    return (
      this.activeResponseCount > 0 ||
      this.responseRequestPending ||
      this.toolBatchesInFlight > 0
    );
  }

  private flushContinuation(): void {
    if (
      !this.continuationPending ||
      this.hasResponseOrToolActivity() ||
      this.speaking ||
      this.userSpeechActive
    ) {
      return;
    }
    if (!this.send({ type: "response.create" })) return;
    this.continuationPending = false;
    // Hold this state through the data-channel gap until response.created.
    this.responseRequestPending = true;
  }

  private reportMicrophoneProcessing(stream: MediaStream): void {
    for (const track of stream.getAudioTracks()) {
      const settings = track.getSettings();
      const processing = {
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl,
      };
      console.info("Realtime microphone processing:", processing);
      const disabled = Object.entries(processing)
        .filter(([, enabled]) => enabled === false)
        .map(([name]) => name);
      if (disabled.length > 0) {
        console.warn(
          `Requested microphone processing is disabled: ${disabled.join(", ")}.`,
        );
      }
    }
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
    this.userSpeechActive = false;
    this.greetingStarted = false;
    this.statusAfterPlayback = null;
    this.activeResponseCount = 0;
    this.responseRequestPending = false;
    this.toolBatchesInFlight = 0;
    this.continuationPending = false;
  }
}

function terminalResponseStatus(
  status: string | undefined,
  statusDetails: unknown,
): RealtimeAgentStatus {
  if (status === "failed") {
    return {
      state: "error",
      detail:
        responseStatusMessage(statusDetails) ?? "Voice response failed. Try again.",
    };
  }
  if (status === "incomplete") {
    const reason = responseStatusReason(statusDetails);
    return {
      state: "error",
      detail: reason
        ? `Voice response ended early (${reason}). Try again.`
        : "Voice response ended early. Try again.",
    };
  }
  return { state: "listening", detail: "Listening" };
}

function responseStatusMessage(statusDetails: unknown): string | undefined {
  if (!statusDetails || typeof statusDetails !== "object") return undefined;
  const error = (statusDetails as { error?: unknown }).error;
  if (!error || typeof error !== "object") return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

function responseStatusReason(statusDetails: unknown): string | undefined {
  if (!statusDetails || typeof statusDetails !== "object") return undefined;
  const reason = (statusDetails as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
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
