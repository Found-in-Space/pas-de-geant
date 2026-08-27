import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { isAllowedRequestOrigin } from "./realtime-token-server.js";
import {
  DEFAULT_SUPERVISION_CONTROL_STATE,
  parseSupervisionMessage,
  SUPERVISION_PATH,
  SUPERVISION_PROTOCOL_VERSION,
  SUPERVISION_SUBPROTOCOL,
  type CommandResultMessage,
  type SupervisionMessage,
  type SupervisionSession,
} from "./supervision-protocol.js";

interface HeadsetPeer {
  readonly socket: WebSocket;
  session: SupervisionSession;
}

interface PendingCommand {
  readonly supervisor: WebSocket;
  readonly sessionId: string;
}

interface UpgradeServer {
  on(
    event: "upgrade",
    listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): unknown;
  off(
    event: "upgrade",
    listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): unknown;
}

function send(socket: WebSocket, message: SupervisionMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function failure(commandId: string, error: string): CommandResultMessage {
  return {
    protocolVersion: SUPERVISION_PROTOCOL_VERSION,
    type: "command.result",
    commandId,
    ok: false,
    error,
  };
}

function invalidSupervisorCommandId(data: string): string | undefined {
  try {
    const value = JSON.parse(data) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const candidate = value as Record<string, unknown>;
    return candidate.protocolVersion === SUPERVISION_PROTOCOL_VERSION &&
        candidate.type === "session.command" &&
        typeof candidate.commandId === "string" &&
        candidate.commandId.trim()
      ? candidate.commandId
      : undefined;
  } catch {
    return undefined;
  }
}

export class SupervisionRelay {
  private readonly server = new WebSocketServer({
    noServer: true,
    handleProtocols(protocols) {
      return protocols.has(SUPERVISION_SUBPROTOCOL)
        ? SUPERVISION_SUBPROTOCOL
        : false;
    },
  });
  private readonly headsets = new Map<string, HeadsetPeer>();
  private readonly supervisors = new Set<WebSocket>();
  private readonly pendingCommands = new Map<string, PendingCommand>();

  readonly handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname !== SUPERVISION_PATH) return;
    const protocols = (request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((entry) => entry.trim());
    if (
      !isAllowedRequestOrigin(request.headers.origin) ||
      !protocols.includes(SUPERVISION_SUBPROTOCOL)
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    this.server.handleUpgrade(request, socket, head, (client) => {
      this.server.emit("connection", client, request);
    });
  };

  constructor() {
    this.server.on("connection", (socket) => this.connect(socket));
  }

  close(): void {
    for (const peer of this.headsets.values()) peer.socket.close(1001, "Server closing");
    for (const supervisor of this.supervisors) supervisor.close(1001, "Server closing");
    this.headsets.clear();
    this.supervisors.clear();
    this.pendingCommands.clear();
    this.server.close();
  }

  private connect(socket: WebSocket): void {
    let role: "headset" | "supervisor" | undefined;
    let sessionId: string | undefined;
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "Text messages required");
        return;
      }
      try {
        const message = parseSupervisionMessage(data.toString());
        if (!role) {
          if (message.type === "headset.hello") {
            role = "headset";
            sessionId = message.sessionId;
            this.registerHeadset(socket, message);
            return;
          }
          if (message.type === "supervisor.hello") {
            role = "supervisor";
            this.registerSupervisor(socket);
            return;
          }
          throw new Error("The first message must identify the peer.");
        }
        if (role === "headset" && sessionId) {
          this.handleHeadsetMessage(sessionId, socket, message);
        } else if (role === "supervisor") {
          this.handleSupervisorMessage(socket, message);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Invalid message";
        const commandId = role === "supervisor"
          ? invalidSupervisorCommandId(data.toString())
          : undefined;
        if (commandId) {
          send(socket, failure(commandId, detail));
          return;
        }
        socket.close(1002, detail.slice(0, 120));
      }
    });
    socket.on("close", () => {
      if (role === "headset" && sessionId) {
        this.removeHeadset(sessionId, socket);
      } else if (role === "supervisor") {
        this.supervisors.delete(socket);
        for (const [commandId, pending] of this.pendingCommands) {
          if (pending.supervisor === socket) this.pendingCommands.delete(commandId);
        }
      }
    });
  }

  private registerHeadset(
    socket: WebSocket,
    hello: Extract<SupervisionMessage, { type: "headset.hello" }>,
  ): void {
    const existing = this.headsets.get(hello.sessionId);
    const peer: HeadsetPeer = {
      socket,
      session: {
        sessionId: hello.sessionId,
        label: hello.label?.trim() || null,
        connectedAtMs: hello.startedAtMs,
        state: existing?.session.state ?? null,
        controls: existing?.session.controls ?? DEFAULT_SUPERVISION_CONTROL_STATE,
        pins: existing?.session.pins ?? [],
        guidedPinIds: existing?.session.guidedPinIds ?? [],
      },
    };
    this.headsets.set(hello.sessionId, peer);
    existing?.socket.close(4000, "Session reconnected");
    send(socket, {
      protocolVersion: SUPERVISION_PROTOCOL_VERSION,
      type: "session.ready",
      sessionId: hello.sessionId,
    });
    this.broadcastSession(peer.session);
  }

  private registerSupervisor(socket: WebSocket): void {
    this.supervisors.add(socket);
    send(socket, {
      protocolVersion: SUPERVISION_PROTOCOL_VERSION,
      type: "sessions.snapshot",
      sessions: [...this.headsets.values()].map(({ session }) => session),
    });
  }

  private handleHeadsetMessage(
    sessionId: string,
    socket: WebSocket,
    message: SupervisionMessage,
  ): void {
    const peer = this.headsets.get(sessionId);
    if (!peer || peer.socket !== socket) return;
    if (message.type === "headset.state") {
      peer.session = {
        ...peer.session,
        state: message.state,
        controls: message.controls,
        pins: message.pins,
        guidedPinIds: message.guidedPinIds,
      };
      this.broadcastSession(peer.session);
      return;
    }
    if (message.type === "command.result") {
      const pending = this.pendingCommands.get(message.commandId);
      if (!pending || pending.sessionId !== sessionId) return;
      this.pendingCommands.delete(message.commandId);
      if (message.ok) {
        peer.session = {
          ...peer.session,
          state: message.state,
          controls: message.controls,
          pins: message.pins,
          guidedPinIds: message.guidedPinIds,
        };
        this.broadcastSession(peer.session);
      }
      send(pending.supervisor, message);
      return;
    }
    throw new Error("Unexpected headset message.");
  }

  private handleSupervisorMessage(
    socket: WebSocket,
    message: SupervisionMessage,
  ): void {
    if (message.type !== "session.command") {
      throw new Error("Unexpected supervisor message.");
    }
    if (this.pendingCommands.has(message.commandId)) {
      send(socket, failure(message.commandId, "Command ID is already pending."));
      return;
    }
    const headset = this.headsets.get(message.sessionId);
    if (!headset || headset.socket.readyState !== WebSocket.OPEN) {
      send(socket, failure(message.commandId, "The selected session is unavailable."));
      return;
    }
    this.pendingCommands.set(message.commandId, {
      supervisor: socket,
      sessionId: message.sessionId,
    });
    send(headset.socket, {
      protocolVersion: SUPERVISION_PROTOCOL_VERSION,
      type: "command",
      commandId: message.commandId,
      command: message.command,
    });
  }

  private removeHeadset(sessionId: string, socket: WebSocket): void {
    const current = this.headsets.get(sessionId);
    if (!current || current.socket !== socket) return;
    this.headsets.delete(sessionId);
    for (const [commandId, pending] of this.pendingCommands) {
      if (pending.sessionId !== sessionId) continue;
      send(pending.supervisor, failure(commandId, "The selected session disconnected."));
      this.pendingCommands.delete(commandId);
    }
    this.broadcast({
      protocolVersion: SUPERVISION_PROTOCOL_VERSION,
      type: "session.removed",
      sessionId,
    });
  }

  private broadcastSession(session: SupervisionSession): void {
    this.broadcast({
      protocolVersion: SUPERVISION_PROTOCOL_VERSION,
      type: "session.updated",
      session,
    });
  }

  private broadcast(message: SupervisionMessage): void {
    for (const supervisor of this.supervisors) send(supervisor, message);
  }
}

export function attachSupervisionRelay(httpServer: UpgradeServer): () => void {
  const relay = new SupervisionRelay();
  httpServer.on("upgrade", relay.handleUpgrade);
  return () => {
    httpServer.off("upgrade", relay.handleUpgrade);
    relay.close();
  };
}
