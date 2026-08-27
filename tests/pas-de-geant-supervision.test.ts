import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createConnection } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import {
  earthMapCoordinates,
  earthMapPoint,
  parseEarthCoordinatePair,
} from "../apps/pas-de-geant/src/earth-map.js";
import {
  applySupervisorLocationPinMutation,
  applySupervisorNavigationMutation,
  applyVoiceScaleDenominatorMutation,
  applyVoiceRemovePinMutation,
  applyVoiceRenamePinMutation,
  applyVoiceSetPinGuidanceMutation,
  applyVoiceSetPinMutation,
  applyVoiceSetPinVisibilityMutation,
  applyVoiceWarpMutation,
  type CanonicalLocationPinMutations,
  type CanonicalNavigationMutations,
} from "../apps/pas-de-geant/src/navigation-mutation-adapters.js";
import { LocationPinStore } from "../apps/pas-de-geant/src/location-pin.js";
import {
  parseSupervisionCommand,
  parseSupervisionMessage,
  SUPERVISION_PROTOCOL_VERSION,
  SUPERVISION_SUBPROTOCOL,
  type SupervisionMessage,
  type SupervisionControlState,
  type SupervisionNavigationState,
} from "../apps/pas-de-geant/src/supervision-protocol.js";
import {
  attachSupervisionRelay,
} from "../apps/pas-de-geant/src/supervision-server.js";

function protocolMessage(
  value: Omit<Record<string, unknown>, "protocolVersion">,
): Record<string, unknown> {
  return { protocolVersion: SUPERVISION_PROTOCOL_VERSION, ...value };
}

const initialState: SupervisionNavigationState = {
  sequence: 0,
  mode: "surface",
  focusBody: "earth",
  latitudeDegrees: 51.5074,
  longitudeDegrees: -0.1278,
  scaleDenominator: 60_000,
  radialMultiplier: 1,
  headingDegrees: 42.5,
};

const initialControls: SupervisionControlState = {
  aircraft: {
    aircraft: true,
    labels: false,
  },
  satellites: {
    brightest: true,
    space_stations: false,
    science_education: true,
  },
  eclipse: {
    active: false,
    playing: false,
    eventId: null,
    eventKind: null,
    peakUtc: null,
    contactStartUtc: null,
    contactEndUtc: null,
    atUtc: null,
    playbackRate: null,
  },
};

describe("supervision protocol", () => {
  it("rejects incompatible versions and unknown message types", () => {
    expect(() => parseSupervisionMessage({
      protocolVersion: 1,
      type: "supervisor.hello",
    })).toThrow(/version/i);
    expect(() => parseSupervisionMessage(protocolMessage({
      type: "future.message",
    }))).toThrow(/type/i);
  });

  it("validates coordinates and accepts positive finite scales without a ceiling", () => {
    expect(parseSupervisionCommand({
      kind: "warp",
      latitudeDegrees: 90,
      longitudeDegrees: 180,
      time: 2.5,
    })).toEqual({
      kind: "warp",
      latitudeDegrees: 90,
      longitudeDegrees: 180,
      time: 2.5,
    });
    expect(() => parseSupervisionCommand({
      kind: "warp",
      latitudeDegrees: 90.001,
      longitudeDegrees: 0,
    })).toThrow(/latitude/i);
    expect(() => parseSupervisionCommand({
      kind: "warp",
      latitudeDegrees: 0,
      longitudeDegrees: -180.001,
    })).toThrow(/longitude/i);

    expect(parseSupervisionCommand({
      kind: "setScaleDenominator",
      scaleDenominator: Number.MAX_VALUE,
      time: 0,
    })).toEqual({
      kind: "setScaleDenominator",
      scaleDenominator: Number.MAX_VALUE,
      time: 0,
    });
    for (const scaleDenominator of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => parseSupervisionCommand({
        kind: "setScaleDenominator",
        scaleDenominator,
      })).toThrow();
    }
    expect(() => parseSupervisionCommand({
      kind: "setDisplayRadius",
      displayRadiusM: 10,
    })).toThrow(/displayRadiusM/i);
    expect(() => parseSupervisionCommand({
      kind: "setScaleDenominator",
      scaleDenominator: 60_000,
      displayRadiusM: 10,
    })).toThrow(/displayRadiusM/i);
    expect(parseSupervisionCommand({
      kind: "setRadialMultiplier",
      radialMultiplier: 12.5,
    })).toEqual({
      kind: "setRadialMultiplier",
      radialMultiplier: 12.5,
    });
    for (const radialMultiplier of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => parseSupervisionCommand({
        kind: "setRadialMultiplier",
        radialMultiplier,
      })).toThrow();
    }
    expect(parseSupervisionCommand({
      kind: "setHeading",
      headingDegrees: 270,
      time: 0.5,
    })).toEqual({
      kind: "setHeading",
      headingDegrees: 270,
      time: 0.5,
    });
    for (const headingDegrees of [Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => parseSupervisionCommand({
        kind: "setHeading",
        headingDegrees,
      })).toThrow(/heading/i);
    }
    for (const time of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => parseSupervisionCommand({
        kind: "warp",
        latitudeDegrees: 0,
        longitudeDegrees: 0,
        time,
      })).toThrow(/time/i);
    }

    expect(parseSupervisionCommand({
      kind: "setPin",
      pin: {
        pinId: "florence",
        label: "Florence",
        latitudeDegrees: 43.7696,
        longitudeDegrees: 11.2558,
      },
    })).toMatchObject({ kind: "setPin", pin: { label: "Florence" } });
    expect(() => parseSupervisionCommand({
      kind: "setPin",
      pin: {
        pinId: "florence",
        label: "",
        latitudeDegrees: 43.7696,
        longitudeDegrees: 11.2558,
      },
    })).toThrow(/label/i);
    expect(parseSupervisionCommand({
      kind: "setPinGuidance",
      enabled: true,
      pin: {
        pinId: "florence",
        label: "Florence",
        latitudeDegrees: 43.7696,
        longitudeDegrees: 11.2558,
      },
    })).toMatchObject({
      kind: "setPinGuidance",
      enabled: true,
      pin: { pinId: "florence" },
    });
    expect(() => parseSupervisionCommand({
      kind: "setPinGuidance",
      enabled: "yes",
      pin: {
        pinId: "florence",
        label: "Florence",
        latitudeDegrees: 43.7696,
        longitudeDegrees: 11.2558,
      },
    })).toThrow(/boolean/i);

    expect(parseSupervisionCommand({
      kind: "setAircraftDisplay",
      target: "labels",
      enabled: true,
    })).toEqual({
      kind: "setAircraftDisplay",
      target: "labels",
      enabled: true,
    });
    expect(() => parseSupervisionCommand({
      kind: "setAircraftDisplay",
      target: "contrails",
      enabled: true,
    })).toThrow(/aircraft display target/i);
    expect(parseSupervisionCommand({
      kind: "setSatelliteGroupVisibility",
      group: "space_stations",
      enabled: false,
    })).toEqual({
      kind: "setSatelliteGroupVisibility",
      group: "space_stations",
      enabled: false,
    });
    expect(() => parseSupervisionCommand({
      kind: "setSatelliteGroupVisibility",
      group: "weather",
      enabled: true,
    })).toThrow(/satellite group/i);
    expect(parseSupervisionCommand({
      kind: "setEclipsePlayback",
      playing: true,
    })).toEqual({ kind: "setEclipsePlayback", playing: true });
    expect(parseSupervisionCommand({
      kind: "setEclipseTime",
      utc: "2026-08-12T17:47:00Z",
    })).toEqual({
      kind: "setEclipseTime",
      utc: "2026-08-12T17:47:00.000Z",
    });
    expect(() => parseSupervisionCommand({
      kind: "setEclipseTime",
      utc: "not-a-date",
    })).toThrow(/UTC/i);
  });

  it("validates full navigation state sequences and nullable heading", () => {
    expect(parseSupervisionMessage(protocolMessage({
      type: "headset.state",
      state: { ...initialState, headingDegrees: null },
      controls: initialControls,
    }))).toMatchObject({
      type: "headset.state",
      state: { sequence: 0, headingDegrees: null },
      controls: initialControls,
    });
    expect(() => parseSupervisionMessage(protocolMessage({
      type: "headset.state",
      state: { ...initialState, displayRadiusM: 10 },
    }))).toThrow(/displayRadiusM/i);
    expect(() => parseSupervisionMessage(protocolMessage({
      type: "headset.state",
      state: { ...initialState, sequence: 1.5 },
    }))).toThrow(/sequence/i);
    expect(() => parseSupervisionMessage(protocolMessage({
      type: "headset.state",
      state: { ...initialState, headingDegrees: 360 },
    }))).toThrow(/heading/i);
    expect(() => parseSupervisionMessage(protocolMessage({
      type: "headset.state",
      state: initialState,
      pins: [],
      guidedPinIds: ["missing"],
    }))).toThrow(/guided pin/i);
    expect(() => parseSupervisionMessage(protocolMessage({
      type: "headset.state",
      state: initialState,
      controls: {
        ...initialControls,
        aircraft: { aircraft: "yes", labels: false },
      },
    }))).toThrow(/aircraft symbols/i);
  });

  it("validates active eclipse telemetry", () => {
    const eclipse = {
      active: true,
      playing: true,
      eventId: "solar-2026-08-12-total",
      eventKind: "total",
      peakUtc: "2026-08-12T17:47:00Z",
      contactStartUtc: "2026-08-12T15:34:00Z",
      contactEndUtc: "2026-08-12T19:58:00Z",
      atUtc: "2026-08-12T17:45:30Z",
      playbackRate: 180,
    };
    expect(parseSupervisionMessage(protocolMessage({
      type: "headset.state",
      state: initialState,
      controls: { ...initialControls, eclipse },
    }))).toMatchObject({
      controls: {
        eclipse: {
          ...eclipse,
          peakUtc: "2026-08-12T17:47:00.000Z",
          contactStartUtc: "2026-08-12T15:34:00.000Z",
          contactEndUtc: "2026-08-12T19:58:00.000Z",
          atUtc: "2026-08-12T17:45:30.000Z",
        },
      },
    });
    expect(() => parseSupervisionMessage(protocolMessage({
      type: "headset.state",
      state: initialState,
      controls: {
        ...initialControls,
        eclipse: { ...eclipse, atUtc: null },
      },
    }))).toThrow(/active eclipse/i);
    expect(() => parseSupervisionMessage(protocolMessage({
      type: "headset.state",
      state: initialState,
      controls: {
        ...initialControls,
        eclipse: {
          ...eclipse,
          contactStartUtc: eclipse.contactEndUtc,
          contactEndUtc: eclipse.contactStartUtc,
        },
      },
    }))).toThrow(/contact end/i);
  });
});

describe("equirectangular supervisor map", () => {
  const rect = { x: 17, y: 23, width: 720, height: 360 };

  it.each([
    { latitudeDegrees: 90, longitudeDegrees: -180 },
    { latitudeDegrees: -90, longitudeDegrees: 179.999 },
    { latitudeDegrees: 0, longitudeDegrees: 0 },
    { latitudeDegrees: 51.5074, longitudeDegrees: -0.1278 },
  ])("round-trips $latitudeDegrees°, $longitudeDegrees°", (coordinates) => {
    const point = earthMapPoint(
      coordinates.latitudeDegrees,
      coordinates.longitudeDegrees,
      rect,
    );
    const roundTrip = earthMapCoordinates(point.x, point.y, rect);
    expect(roundTrip.latitudeDegrees).toBeCloseTo(coordinates.latitudeDegrees, 10);
    expect(roundTrip.longitudeDegrees).toBeCloseTo(coordinates.longitudeDegrees, 10);
  });

  it("maps both antimeridian edges and both poles exactly", () => {
    expect(earthMapCoordinates(rect.x, rect.y, rect)).toEqual({
      latitudeDegrees: 90,
      longitudeDegrees: -180,
    });
    expect(earthMapCoordinates(
      rect.x + rect.width,
      rect.y + rect.height,
      rect,
    )).toEqual({
      latitudeDegrees: -90,
      longitudeDegrees: 180,
    });
    expect(earthMapPoint(0, 180, rect).x).toBe(rect.x);
  });
});

describe("supervisor coordinate paste", () => {
  it("parses a Google Maps latitude/longitude pair without losing precision", () => {
    expect(parseEarthCoordinatePair(
      "28.27103351877764, 85.37820569619699",
    )).toEqual({
      latitudeDegrees: 28.27103351877764,
      longitudeDegrees: 85.37820569619699,
    });
  });

  it("leaves ordinary or invalid coordinate text alone", () => {
    expect(parseEarthCoordinatePair("28.27103351877764")).toBeUndefined();
    expect(parseEarthCoordinatePair("91, 85.3782")).toBeUndefined();
    expect(parseEarthCoordinatePair("28.271, west")).toBeUndefined();
  });
});

describe("voice and supervisor navigation parity", () => {
  it("routes warp and scale through the same canonical mutations and returns exact state", () => {
    let state = { ...initialState };
    const calls: Array<readonly [string, number | undefined]> = [];
    const mutations: CanonicalNavigationMutations = {
      warp(latitudeDegrees, longitudeDegrees, time) {
        calls.push(["warp", time]);
        state = { ...state, latitudeDegrees, longitudeDegrees };
      },
      setScaleDenominator(scaleDenominator, time) {
        calls.push(["scale", time]);
        state = { ...state, scaleDenominator };
      },
      setRadialMultiplier(radialMultiplier) {
        calls.push(["radial", undefined]);
        state = { ...state, radialMultiplier };
      },
      setHeading(headingDegrees, time) {
        calls.push(["heading", time]);
        state = { ...state, headingDegrees };
      },
      readState() {
        const { sequence: _sequence, ...snapshot } = state;
        return snapshot;
      },
    };

    const voiceWarpState = applyVoiceWarpMutation(
      { latitudeDegrees: 35.6762, longitudeDegrees: 139.6503, time: 1.5 },
      mutations,
    );
    const supervisorWarpState = applySupervisorNavigationMutation(
      {
        kind: "warp",
        latitudeDegrees: -33.8688,
        longitudeDegrees: 151.2093,
        time: 2,
      },
      mutations,
    );
    const voiceScaleState = applyVoiceScaleDenominatorMutation(
      37.25,
      mutations,
      2.5,
    );
    const supervisorScaleState = applySupervisorNavigationMutation(
      { kind: "setScaleDenominator", scaleDenominator: 1e12, time: 3 },
      mutations,
    );
    const supervisorRadialState = applySupervisorNavigationMutation(
      { kind: "setRadialMultiplier", radialMultiplier: 15 },
      mutations,
    );
    const supervisorHeadingState = applySupervisorNavigationMutation(
      { kind: "setHeading", headingDegrees: 270, time: 0.5 },
      mutations,
    );

    expect(calls).toEqual([
      ["warp", 1.5],
      ["warp", 2],
      ["scale", 2.5],
      ["scale", 3],
      ["radial", undefined],
      ["heading", 0.5],
    ]);
    expect(voiceWarpState).toMatchObject({
      latitudeDegrees: 35.6762,
      longitudeDegrees: 139.6503,
    });
    expect(supervisorWarpState).toMatchObject({
      latitudeDegrees: -33.8688,
      longitudeDegrees: 151.2093,
    });
    expect(voiceScaleState.scaleDenominator).toBe(37.25);
    expect(supervisorScaleState.scaleDenominator).toBe(1e12);
    expect(supervisorRadialState.radialMultiplier).toBe(15);
    expect(supervisorHeadingState.headingDegrees).toBe(270);
  });

  it("routes voice and supervisor pin operations through one canonical store", () => {
    const store = new LocationPinStore();
    const mutations: CanonicalLocationPinMutations = {
      setPin: (pin) => store.set(pin),
      removePin: (pinId) => store.remove(pinId),
      setPinVisibility: (pinId, visible) => store.setVisibility(pinId, visible),
      renamePin: (pinId, label) => store.rename(pinId, label),
      setPinGuidance: (pinId, enabled) => store.setGuidance(pinId, enabled),
      readPinState: () => store.snapshot(),
    };
    const florence = {
      pinId: "florence",
      label: "Florence",
      latitudeDegrees: 43.7696,
      longitudeDegrees: 11.2558,
    };
    const pisa = {
      pinId: "pisa",
      label: "Pisa",
      latitudeDegrees: 43.7228,
      longitudeDegrees: 10.4017,
    };
    expect(applyVoiceSetPinMutation(florence, mutations)).toMatchObject({
      pins: [florence],
      guidedPinIds: [],
    });
    expect(applySupervisorLocationPinMutation(
      { kind: "setPinGuidance", pin: pisa, enabled: true },
      mutations,
    ).guidedPinIds).toEqual(["pisa"]);
    expect(applyVoiceSetPinGuidanceMutation("florence", true, mutations).guidedPinIds)
      .toEqual(["pisa", "florence"]);
    expect(applyVoiceSetPinVisibilityMutation(
      "florence",
      false,
      mutations,
    )).toEqual({ pins: [pisa], guidedPinIds: ["pisa"] });
    expect(store.catalogSnapshot().visiblePinIds).toEqual(["pisa"]);
    applyVoiceRenamePinMutation("florence", "Stop 1", mutations);
    expect(store.catalogSnapshot().pins[0]).toEqual({
      ...florence,
      label: "Stop 1",
    });
    applyVoiceSetPinVisibilityMutation("florence", true, mutations);
    expect(applyVoiceRemovePinMutation("florence", mutations)).toEqual({
      pins: [pisa],
      guidedPinIds: ["pisa"],
    });
  });
});

type MessageType = SupervisionMessage["type"];

function waitForMessage<T extends MessageType>(
  socket: WebSocket,
  type: T,
  predicate: (
    message: Extract<SupervisionMessage, { type: T }>,
  ) => boolean = () => true,
): Promise<Extract<SupervisionMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Timed out waiting for ${type}.`));
    }, 2_000);
    const onMessage = (data: RawData): void => {
      const message = parseSupervisionMessage(data.toString());
      if (message.type !== type) return;
      const typed = message as Extract<SupervisionMessage, { type: T }>;
      if (!predicate(typed)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(typed);
    };
    socket.on("message", onMessage);
  });
}

async function connectClient(port: number): Promise<WebSocket> {
  const origin = `http://127.0.0.1:${port}`;
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/api/supervision`,
    SUPERVISION_SUBPROTOCOL,
    { origin },
  );
  await once(socket, "open");
  return socket;
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, "close");
  socket.close();
  await closed;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe("development supervision relay", () => {
  it("rejects cross-origin WebSocket upgrades", async () => {
    const server = createServer();
    const detach = attachSupervisionRelay(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP test server.");
    }
    try {
      const socket = createConnection(address.port, "127.0.0.1");
      await once(socket, "connect");
      const closed = once(socket, "close");
      const response = once(socket, "data");
      socket.write([
        "GET /api/supervision HTTP/1.1",
        `Host: 127.0.0.1:${address.port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        `Sec-WebSocket-Protocol: ${SUPERVISION_SUBPROTOCOL}`,
        "Origin: https://untrusted.example",
        "",
        "",
      ].join("\r\n"));
      const [data] = await response;
      expect(data.toString()).toMatch(/^HTTP\/1\.1 403 Forbidden/);
      socket.destroy();
      await closed;
    } finally {
      detach();
      await closeServer(server);
    }
  });

  it("broadcasts sessions, routes correlated commands, and preserves an ID across reconnect", async () => {
    const server = createServer();
    const detach = attachSupervisionRelay(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP test server.");
    }
    const port = address.port;
    const clients: WebSocket[] = [];
    try {
      const supervisor = await connectClient(port);
      clients.push(supervisor);
      const receivedBySupervisor: SupervisionMessage[] = [];
      supervisor.on("message", (data) => {
        receivedBySupervisor.push(parseSupervisionMessage(data.toString()));
      });
      const snapshot = waitForMessage(supervisor, "sessions.snapshot");
      supervisor.send(JSON.stringify(protocolMessage({ type: "supervisor.hello" })));
      await expect(snapshot).resolves.toMatchObject({ sessions: [] });

      const headset = await connectClient(port);
      clients.push(headset);
      const ready = waitForMessage(headset, "session.ready");
      const appeared = waitForMessage(
        supervisor,
        "session.updated",
        (message) => message.session.sessionId === "xr-session-1",
      );
      headset.send(JSON.stringify(protocolMessage({
        type: "headset.hello",
        sessionId: "xr-session-1",
        label: "Quest lab",
        startedAtMs: 1_000,
      })));
      await expect(ready).resolves.toMatchObject({ sessionId: "xr-session-1" });
      await expect(appeared).resolves.toMatchObject({
        session: {
          sessionId: "xr-session-1",
          label: "Quest lab",
          connectedAtMs: 1_000,
          state: null,
        },
      });

      const stateBroadcast = waitForMessage(
        supervisor,
        "session.updated",
        (message) => message.session.state?.sequence === 0,
      );
      headset.send(JSON.stringify(protocolMessage({
        type: "headset.state",
        state: initialState,
        controls: initialControls,
      })));
      await expect(stateBroadcast).resolves.toMatchObject({
        session: { state: initialState, controls: initialControls },
      });

      const invalidResult = waitForMessage(
        supervisor,
        "command.result",
        (message) => message.commandId === "invalid-command",
      );
      supervisor.send(JSON.stringify(protocolMessage({
        type: "session.command",
        sessionId: "xr-session-1",
        commandId: "invalid-command",
        command: {
          kind: "warp",
          latitudeDegrees: 91,
          longitudeDegrees: 0,
        },
      })));
      await expect(invalidResult).resolves.toMatchObject({
        commandId: "invalid-command",
        ok: false,
        error: expect.stringMatching(/latitude/i),
      });

      const routedCommand = waitForMessage(headset, "command");
      supervisor.send(JSON.stringify(protocolMessage({
        type: "session.command",
        sessionId: "xr-session-1",
        commandId: "command-1",
        command: {
          kind: "warp",
          latitudeDegrees: -33.8688,
          longitudeDegrees: 151.2093,
        },
      })));
      await expect(routedCommand).resolves.toMatchObject({
        commandId: "command-1",
        command: { kind: "warp", latitudeDegrees: -33.8688 },
      });

      headset.send(JSON.stringify(protocolMessage({
        type: "command.result",
        commandId: "not-the-pending-command",
        ok: true,
        state: { ...initialState, sequence: 1 },
        controls: initialControls,
      })));
      const resultingState = {
        ...initialState,
        sequence: 2,
        latitudeDegrees: -33.8688,
        longitudeDegrees: 151.2093,
      };
      const result = waitForMessage(
        supervisor,
        "command.result",
        (message) => message.commandId === "command-1",
      );
      headset.send(JSON.stringify(protocolMessage({
        type: "command.result",
        commandId: "command-1",
        ok: true,
        state: resultingState,
        controls: initialControls,
      })));
      await expect(result).resolves.toMatchObject({
        commandId: "command-1",
        ok: true,
        state: resultingState,
        controls: initialControls,
      });
      expect(
        receivedBySupervisor.filter(
          (message) => message.type === "command.result" &&
            message.commandId === "not-the-pending-command",
        ),
      ).toHaveLength(0);

      const florencePin = {
        pinId: "florence",
        label: "Florence",
        latitudeDegrees: 43.7696,
        longitudeDegrees: 11.2558,
      };
      const routedPinCommand = waitForMessage(
        headset,
        "command",
        (message) => message.commandId === "pin-command",
      );
      supervisor.send(JSON.stringify(protocolMessage({
        type: "session.command",
        sessionId: "xr-session-1",
        commandId: "pin-command",
        command: { kind: "setPin", pin: florencePin },
      })));
      await expect(routedPinCommand).resolves.toMatchObject({
        command: { kind: "setPin", pin: florencePin },
      });
      const pinnedState = { ...resultingState, sequence: 3 };
      const pinResult = waitForMessage(
        supervisor,
        "command.result",
        (message) => message.commandId === "pin-command",
      );
      headset.send(JSON.stringify(protocolMessage({
        type: "command.result",
        commandId: "pin-command",
        ok: true,
        state: pinnedState,
        controls: initialControls,
        pins: [florencePin],
        guidedPinIds: [florencePin.pinId],
      })));
      await expect(pinResult).resolves.toMatchObject({
        ok: true,
        pins: [florencePin],
        guidedPinIds: ["florence"],
      });

      const replacement = await connectClient(port);
      clients.push(replacement);
      const replacementReady = waitForMessage(replacement, "session.ready");
      const replacementUpdate = waitForMessage(
        supervisor,
        "session.updated",
        (message) => message.session.sessionId === "xr-session-1" &&
          message.session.state?.sequence === 3 &&
          message.session.guidedPinIds.includes("florence"),
      );
      const originalClosed = once(headset, "close");
      replacement.send(JSON.stringify(protocolMessage({
        type: "headset.hello",
        sessionId: "xr-session-1",
        label: "Quest lab",
        startedAtMs: 1_000,
      })));
      await replacementReady;
      await expect(replacementUpdate).resolves.toMatchObject({
        session: {
          state: pinnedState,
          controls: initialControls,
          pins: [florencePin],
          guidedPinIds: ["florence"],
        },
      });
      await originalClosed;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        receivedBySupervisor.filter(
          (message) => message.type === "session.removed" &&
            message.sessionId === "xr-session-1",
        ),
      ).toHaveLength(0);

      const removed = waitForMessage(
        supervisor,
        "session.removed",
        (message) => message.sessionId === "xr-session-1",
      );
      await closeSocket(replacement);
      await expect(removed).resolves.toMatchObject({ sessionId: "xr-session-1" });
      await closeSocket(supervisor);
    } finally {
      for (const client of clients) {
        if (client.readyState !== WebSocket.CLOSED) client.terminate();
      }
      detach();
      await closeServer(server);
    }
  });
});
