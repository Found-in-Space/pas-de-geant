import {
  parseSupervisionMessage,
  SUPERVISION_PATH,
  SUPERVISION_PROTOCOL_VERSION,
  SUPERVISION_SUBPROTOCOL,
  type CommandResultMessage,
  type SupervisionCommand,
  type SupervisionSession,
} from "./supervision-protocol.js";

export type SupervisorConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting";

export interface SupervisorClientOptions {
  readonly onStatus: (status: SupervisorConnectionStatus) => void;
  readonly onSessions: (sessions: readonly SupervisionSession[]) => void;
  readonly onCommandResult: (result: CommandResultMessage) => void;
}

const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

function supervisionUrl(): string {
  const url = new URL(SUPERVISION_PATH, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export class SupervisorClient {
  private readonly options: SupervisorClientOptions;
  private readonly sessions = new Map<string, SupervisionSession>();
  private socket: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private stopped = false;

  constructor(options: SupervisorClientOptions) {
    this.options = options;
  }

  start(): void {
    this.stopped = false;
    this.connect(false);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.close(1000, "Dashboard closed");
    this.socket = undefined;
  }

  sendCommand(sessionId: string, command: SupervisionCommand): string {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("The supervision relay is disconnected.");
    }
    const commandId = crypto.randomUUID();
    this.socket.send(JSON.stringify({
      protocolVersion: SUPERVISION_PROTOCOL_VERSION,
      type: "session.command",
      sessionId,
      commandId,
      command,
    }));
    return commandId;
  }

  private connect(reconnecting: boolean): void {
    if (this.stopped) return;
    this.options.onStatus(reconnecting ? "reconnecting" : "connecting");
    const socket = new WebSocket(supervisionUrl(), SUPERVISION_SUBPROTOCOL);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (socket !== this.socket) return;
      socket.send(JSON.stringify({
        protocolVersion: SUPERVISION_PROTOCOL_VERSION,
        type: "supervisor.hello",
      }));
    });
    socket.addEventListener("message", (event) => {
      if (socket !== this.socket) return;
      try {
        const message = parseSupervisionMessage(String(event.data));
        if (message.type === "sessions.snapshot") {
          this.sessions.clear();
          for (const session of message.sessions) {
            this.sessions.set(session.sessionId, session);
          }
          this.reconnectAttempt = 0;
          this.options.onStatus("connected");
          this.publishSessions();
        } else if (message.type === "session.updated") {
          this.sessions.set(message.session.sessionId, message.session);
          this.publishSessions();
        } else if (message.type === "session.removed") {
          this.sessions.delete(message.sessionId);
          this.publishSessions();
        } else if (message.type === "command.result") {
          this.options.onCommandResult(message);
        }
      } catch (error) {
        console.error("Invalid supervision relay message.", error);
      }
    });
    socket.addEventListener("close", () => {
      if (socket !== this.socket) return;
      this.socket = undefined;
      this.sessions.clear();
      this.publishSessions();
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = RECONNECT_DELAYS_MS[
      Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
    ];
    this.reconnectAttempt += 1;
    this.options.onStatus("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect(true);
    }, delay);
  }

  private publishSessions(): void {
    this.options.onSessions([...this.sessions.values()]);
  }
}
