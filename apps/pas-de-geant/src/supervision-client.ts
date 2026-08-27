import {
  parseSupervisionMessage,
  SUPERVISION_PATH,
  SUPERVISION_PROTOCOL_VERSION,
  SUPERVISION_SUBPROTOCOL,
  type CommandResultMessage,
  type SupervisionCommand,
  type SupervisionNavigationSnapshot,
  type SupervisionNavigationState,
} from "./supervision-protocol.js";

export type SupervisionConnectionStatus =
  | "inactive"
  | "connecting"
  | "connected"
  | "reconnecting";

interface SupervisionSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "close" | "error" | "message",
    listener: (event: Event | MessageEvent) => void,
  ): void;
}

export interface SupervisionClientOptions {
  readonly readState: () => SupervisionNavigationSnapshot;
  readonly applyCommand: (command: SupervisionCommand) => void;
  readonly onStatus?: (status: SupervisionConnectionStatus) => void;
  readonly createSocket?: (url: string, protocol: string) => SupervisionSocket;
  readonly createSessionId?: () => string;
  readonly now?: () => number;
}

const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;
const STATE_INTERVAL_MS = 100;
const SOCKET_OPEN = 1;

function supervisionUrl(): string {
  const url = new URL(SUPERVISION_PATH, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export class SupervisionClient {
  private readonly readState: () => SupervisionNavigationSnapshot;
  private readonly applyCommand: (command: SupervisionCommand) => void;
  private readonly onStatus?: (status: SupervisionConnectionStatus) => void;
  private readonly createSocket: (url: string, protocol: string) => SupervisionSocket;
  private readonly createSessionId: () => string;
  private readonly now: () => number;
  private socket: SupervisionSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private generation = 0;
  private active = false;
  private ready = false;
  private sessionId = "";
  private sessionLabel: string | undefined;
  private startedAtMs = 0;
  private stateSequence = -1;
  private lastStateSentAtMs = Number.NEGATIVE_INFINITY;

  constructor(options: SupervisionClientOptions) {
    this.readState = options.readState;
    this.applyCommand = options.applyCommand;
    this.onStatus = options.onStatus;
    this.createSocket = options.createSocket ??
      ((url, protocol) => new WebSocket(url, protocol));
    this.createSessionId = options.createSessionId ??
      (() => crypto.randomUUID());
    this.now = options.now ?? (() => performance.now());
  }

  start(sessionLabel?: string): void {
    this.stop();
    this.active = true;
    this.sessionId = this.createSessionId();
    this.sessionLabel = sessionLabel?.trim() || undefined;
    this.startedAtMs = Date.now();
    this.stateSequence = -1;
    this.lastStateSentAtMs = Number.NEGATIVE_INFINITY;
    this.reconnectAttempt = 0;
    this.generation += 1;
    this.connect(this.generation, false);
  }

  stop(): void {
    this.active = false;
    this.ready = false;
    this.generation += 1;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "XR session ended");
    this.setStatus("inactive");
  }

  update(nowMs = this.now()): void {
    if (
      !this.ready ||
      !this.socket ||
      this.socket.readyState !== SOCKET_OPEN ||
      nowMs - this.lastStateSentAtMs < STATE_INTERVAL_MS
    ) return;
    this.publishState(nowMs);
  }

  private connect(generation: number, reconnecting: boolean): void {
    if (!this.active || generation !== this.generation) return;
    this.ready = false;
    this.setStatus(reconnecting ? "reconnecting" : "connecting");
    let socket: SupervisionSocket;
    try {
      socket = this.createSocket(supervisionUrl(), SUPERVISION_SUBPROTOCOL);
    } catch (error) {
      console.debug("Supervision socket could not be created.", error);
      this.scheduleReconnect(generation);
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (!this.isCurrent(socket, generation)) return;
      socket.send(JSON.stringify({
        protocolVersion: SUPERVISION_PROTOCOL_VERSION,
        type: "headset.hello",
        sessionId: this.sessionId,
        ...(this.sessionLabel ? { label: this.sessionLabel } : {}),
        startedAtMs: this.startedAtMs,
      }));
    });
    socket.addEventListener("message", (event) => {
      if (!this.isCurrent(socket, generation) || !("data" in event)) return;
      try {
        const message = parseSupervisionMessage(String(event.data));
        if (message.type === "session.ready") {
          if (message.sessionId !== this.sessionId) {
            throw new Error("The relay acknowledged a different XR session.");
          }
          this.ready = true;
          this.reconnectAttempt = 0;
          this.setStatus("connected");
          this.publishState(this.now());
          return;
        }
        if (message.type === "command") this.handleCommand(message.commandId, message.command);
      } catch (error) {
        console.debug("Ignoring invalid supervision relay message.", error);
      }
    });
    socket.addEventListener("error", () => {
      if (this.isCurrent(socket, generation)) {
        console.debug("Supervision connection failed; the XR experience remains active.");
      }
    });
    socket.addEventListener("close", () => {
      if (!this.isCurrent(socket, generation)) return;
      this.socket = undefined;
      this.ready = false;
      this.scheduleReconnect(generation);
    });
  }

  private handleCommand(commandId: string, command: SupervisionCommand): void {
    let result: CommandResultMessage;
    try {
      this.applyCommand(command);
      result = {
        protocolVersion: SUPERVISION_PROTOCOL_VERSION,
        type: "command.result",
        commandId,
        ok: true,
        state: this.nextState(),
      };
      this.lastStateSentAtMs = this.now();
    } catch (error) {
      result = {
        protocolVersion: SUPERVISION_PROTOCOL_VERSION,
        type: "command.result",
        commandId,
        ok: false,
        error: error instanceof Error ? error.message : "Command failed.",
      };
    }
    this.send(result);
  }

  private publishState(nowMs: number): void {
    this.send({
      protocolVersion: SUPERVISION_PROTOCOL_VERSION,
      type: "headset.state",
      state: this.nextState(),
    });
    this.lastStateSentAtMs = nowMs;
  }

  private nextState(): SupervisionNavigationState {
    this.stateSequence += 1;
    return { ...this.readState(), sequence: this.stateSequence };
  }

  private send(message: CommandResultMessage | {
    readonly protocolVersion: typeof SUPERVISION_PROTOCOL_VERSION;
    readonly type: "headset.state";
    readonly state: SupervisionNavigationState;
  }): void {
    if (this.socket?.readyState === SOCKET_OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private scheduleReconnect(generation: number): void {
    if (!this.active || generation !== this.generation) return;
    const delay = RECONNECT_DELAYS_MS[
      Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
    ];
    this.reconnectAttempt += 1;
    this.setStatus("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect(generation, true);
    }, delay);
  }

  private isCurrent(socket: SupervisionSocket, generation: number): boolean {
    return this.active && generation === this.generation && socket === this.socket;
  }

  private setStatus(status: SupervisionConnectionStatus): void {
    this.onStatus?.(status);
  }
}
