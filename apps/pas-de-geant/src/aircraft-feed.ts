export const FLIGHT_FOLLOWER_STREAM_URL =
  import.meta.env.VITE_FLIGHT_FOLLOWER_STREAM_URL?.trim() ||
  "wss://flight-follower.dev.k-si.com/v1/stream";
export const FLIGHT_FOLLOWER_SUBPROTOCOL = "flight-follower.v1";
export const FLIGHT_FOLLOWER_PROTOCOL_VERSION = 1;
export const AIRCRAFT_QUERY_RADIUS_NM = 250;
export const AIRCRAFT_SUBSCRIPTION_REFRESH_INTERVAL_MS = 30_000;
export const AIRCRAFT_RETARGET_DURATION_MS = 1_200;

export interface AircraftTrajectory {
  readonly generatedAtMs: number;
  readonly validUntilMs: number;
  readonly offsetMs: readonly number[];
  readonly latitudeDegrees: readonly number[];
  readonly longitudeDegrees: readonly number[];
  readonly altitudeFt: readonly (number | null)[];
  readonly courseDegrees: readonly number[];
  readonly headingDegrees: readonly number[];
}

export interface TrackedAircraft {
  readonly id: string;
  readonly revision: number;
  readonly observedAtMs: number;
  readonly callsign: string;
  readonly registration?: string;
  readonly aircraftType?: string;
  readonly emitterCategory?: string;
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  readonly altitudeFt: number | null;
  readonly onGround: boolean | null;
  readonly groundSpeedKt: number;
  readonly courseDegrees: number;
  readonly headingDegrees: number;
  readonly verticalRateFeetPerMinute: number;
  readonly trajectory: AircraftTrajectory;
}

export interface AircraftSample {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  readonly altitudeFt: number | null;
  readonly courseDegrees: number;
  readonly headingDegrees: number;
  readonly trackRateDegreesPerSecond: number;
}

export interface AircraftSubscriptionCenter {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
}

export type FlightFollowerConnectionState =
  | "stopped"
  | "connecting"
  | "live"
  | "retrying"
  | "error";

export interface FlightFollowerConnectionStatus {
  readonly state: FlightFollowerConnectionState;
  readonly detail: string;
}

interface WebSocketLike {
  readonly readyState: number;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<string>) => void,
  ): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface FlightFollowerClientOptions {
  readonly url?: string;
  readonly radiusNm?: number;
  readonly onTracks: (tracks: readonly TrackedAircraft[]) => void;
  readonly onStatus: (status: FlightFollowerConnectionStatus) => void;
  readonly createSocket?: (url: string, protocol: string) => WebSocketLike;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function nullableNumber(value: unknown): number | null {
  return finiteNumber(value) ?? null;
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function numericArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function wrappedDelta(from: number, to: number, period: number): number {
  return ((((to - from + period / 2) % period) + period) % period) -
    period / 2;
}

function interpolateDegrees(from: number, to: number, progress: number): number {
  return ((from + wrappedDelta(from, to, 360) * progress) % 360 + 360) % 360;
}

function interpolateLongitude(from: number, to: number, progress: number): number {
  return ((from + wrappedDelta(from, to, 360) * progress + 180) % 360 + 360) %
      360 -
    180;
}

function interpolationProgress(fromMs: number, toMs: number, atMs: number): number {
  if (toMs <= fromMs) return 1;
  return Math.max(0, Math.min(1, (atMs - fromMs) / (toMs - fromMs)));
}

export function parseFlightFollowerTrack(
  value: unknown,
  receivedAtMs = Date.now(),
): TrackedAircraft | undefined {
  const track = record(value);
  const current = record(track?.current);
  const rawTrajectory = record(track?.trajectory);
  const id = trimmedString(track?.id);
  const latitudeDegrees = finiteNumber(current?.latitudeDegrees);
  const longitudeDegrees = finiteNumber(current?.longitudeDegrees);
  if (!id || latitudeDegrees === undefined || longitudeDegrees === undefined) {
    return undefined;
  }

  const courseDegrees = finiteNumber(current?.courseDegrees) ?? 0;
  const headingDegrees = finiteNumber(current?.headingDegrees) ?? courseDegrees;
  const offsets = numericArray(rawTrajectory?.offsetMs);
  const latitudes = numericArray(rawTrajectory?.latitudeDegrees);
  const longitudes = numericArray(rawTrajectory?.longitudeDegrees);
  const altitudes = numericArray(rawTrajectory?.altitudeFt);
  const courses = numericArray(rawTrajectory?.courseDegrees);
  const headings = numericArray(rawTrajectory?.headingDegrees);
  const generatedAtMs = finiteNumber(rawTrajectory?.generatedAtMs) ?? receivedAtMs;
  const parsedOffsets: number[] = [];
  const parsedLatitudes: number[] = [];
  const parsedLongitudes: number[] = [];
  const parsedAltitudes: (number | null)[] = [];
  const parsedCourses: number[] = [];
  const parsedHeadings: number[] = [];
  const count = Math.min(offsets.length, latitudes.length, longitudes.length);

  for (let index = 0; index < count; index += 1) {
    const offsetMs = finiteNumber(offsets[index]);
    const latitude = finiteNumber(latitudes[index]);
    const longitude = finiteNumber(longitudes[index]);
    if (
      offsetMs === undefined ||
      latitude === undefined ||
      longitude === undefined ||
      (parsedOffsets.length > 0 && offsetMs <= parsedOffsets.at(-1)!)
    ) {
      continue;
    }
    const course = finiteNumber(courses[index]) ?? courseDegrees;
    parsedOffsets.push(offsetMs);
    parsedLatitudes.push(latitude);
    parsedLongitudes.push(longitude);
    parsedAltitudes.push(nullableNumber(altitudes[index]));
    parsedCourses.push(course);
    parsedHeadings.push(finiteNumber(headings[index]) ?? course);
  }

  if (parsedOffsets.length === 0) {
    parsedOffsets.push(0);
    parsedLatitudes.push(latitudeDegrees);
    parsedLongitudes.push(longitudeDegrees);
    parsedAltitudes.push(nullableNumber(current?.altitudeFt));
    parsedCourses.push(courseDegrees);
    parsedHeadings.push(headingDegrees);
  }

  const registration = trimmedString(track?.registration);
  const aircraftType = trimmedString(track?.aircraftType);
  const callsign = trimmedString(track?.callsign) ?? registration ?? id;
  const emitterCategory = trimmedString(track?.emitterCategory)?.toUpperCase();
  return Object.freeze({
    id: id.toUpperCase(),
    revision: finiteNumber(track?.revision) ?? 0,
    observedAtMs: finiteNumber(track?.observedAtMs) ?? receivedAtMs,
    callsign,
    ...(registration ? { registration } : {}),
    ...(aircraftType ? { aircraftType } : {}),
    ...(emitterCategory ? { emitterCategory } : {}),
    latitudeDegrees,
    longitudeDegrees,
    altitudeFt: nullableNumber(current?.altitudeFt),
    onGround: typeof current?.onGround === "boolean" ? current.onGround : null,
    groundSpeedKt: finiteNumber(current?.groundSpeedKt) ?? 0,
    courseDegrees,
    headingDegrees,
    verticalRateFeetPerMinute: finiteNumber(current?.verticalRateFpm) ?? 0,
    trajectory: Object.freeze({
      generatedAtMs,
      validUntilMs:
        finiteNumber(rawTrajectory?.validUntilMs) ??
        generatedAtMs + parsedOffsets.at(-1)!,
      offsetMs: Object.freeze(parsedOffsets),
      latitudeDegrees: Object.freeze(parsedLatitudes),
      longitudeDegrees: Object.freeze(parsedLongitudes),
      altitudeFt: Object.freeze(parsedAltitudes),
      courseDegrees: Object.freeze(parsedCourses),
      headingDegrees: Object.freeze(parsedHeadings),
    }),
  });
}

function interpolateAltitude(
  from: number | null,
  to: number | null,
  fallback: number | null,
  progress: number,
): number | null {
  if (from !== null && to !== null) return from + (to - from) * progress;
  return from ?? to ?? fallback;
}

export function sampleAircraft(
  aircraft: TrackedAircraft,
  atMs: number,
): AircraftSample {
  const trajectory = aircraft.trajectory;
  const count = trajectory.offsetMs.length;
  const elapsedMs = atMs - trajectory.generatedAtMs;
  let fromIndex = 0;
  let toIndex = 0;
  if (elapsedMs >= trajectory.offsetMs[count - 1]!) {
    fromIndex = count - 1;
    toIndex = fromIndex;
  } else if (elapsedMs > trajectory.offsetMs[0]!) {
    let low = 0;
    let high = count - 1;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (trajectory.offsetMs[middle]! <= elapsedMs) low = middle;
      else high = middle;
    }
    fromIndex = low;
    toIndex = high;
  }

  const fromOffset = trajectory.offsetMs[fromIndex]!;
  const toOffset = trajectory.offsetMs[toIndex]!;
  const progress = interpolationProgress(fromOffset, toOffset, elapsedMs);
  const fromCourse = trajectory.courseDegrees[fromIndex]!;
  const toCourse = trajectory.courseDegrees[toIndex]!;
  const intervalSeconds = (toOffset - fromOffset) / 1_000;
  return {
    latitudeDegrees:
      trajectory.latitudeDegrees[fromIndex]! +
      (trajectory.latitudeDegrees[toIndex]! -
        trajectory.latitudeDegrees[fromIndex]!) * progress,
    longitudeDegrees: interpolateLongitude(
      trajectory.longitudeDegrees[fromIndex]!,
      trajectory.longitudeDegrees[toIndex]!,
      progress,
    ),
    altitudeFt: interpolateAltitude(
      trajectory.altitudeFt[fromIndex]!,
      trajectory.altitudeFt[toIndex]!,
      aircraft.altitudeFt,
      progress,
    ),
    courseDegrees: interpolateDegrees(fromCourse, toCourse, progress),
    headingDegrees: interpolateDegrees(
      trajectory.headingDegrees[fromIndex]!,
      trajectory.headingDegrees[toIndex]!,
      progress,
    ),
    trackRateDegreesPerSecond:
      intervalSeconds > 0
        ? wrappedDelta(fromCourse, toCourse, 360) / intervalSeconds
        : 0,
  };
}

export function interpolateAircraftSamples(
  from: AircraftSample,
  to: AircraftSample,
  progress: number,
): AircraftSample {
  const amount = Math.max(0, Math.min(1, progress));
  return {
    latitudeDegrees:
      from.latitudeDegrees + (to.latitudeDegrees - from.latitudeDegrees) * amount,
    longitudeDegrees: interpolateLongitude(
      from.longitudeDegrees,
      to.longitudeDegrees,
      amount,
    ),
    altitudeFt: interpolateAltitude(from.altitudeFt, to.altitudeFt, to.altitudeFt, amount),
    courseDegrees: interpolateDegrees(from.courseDegrees, to.courseDegrees, amount),
    headingDegrees: interpolateDegrees(from.headingDegrees, to.headingDegrees, amount),
    trackRateDegreesPerSecond:
      from.trackRateDegreesPerSecond +
      (to.trackRateDegreesPerSecond - from.trackRateDegreesPerSecond) * amount,
  };
}

export class FlightFollowerClient {
  private readonly url: string;
  private readonly radiusNm: number;
  private readonly onTracks: FlightFollowerClientOptions["onTracks"];
  private readonly onStatus: FlightFollowerClientOptions["onStatus"];
  private readonly createSocket: NonNullable<FlightFollowerClientOptions["createSocket"]>;
  private readonly tracks = new Map<string, TrackedAircraft>();
  private socket: WebSocketLike | undefined;
  private center: AircraftSubscriptionCenter | undefined;
  private sentCenter: AircraftSubscriptionCenter | undefined;
  private reconnectTimer: number | undefined;
  private reconnectDelayMs = 1_000;
  private running = false;
  private ready = false;

  constructor(options: FlightFollowerClientOptions) {
    this.url = options.url ?? FLIGHT_FOLLOWER_STREAM_URL;
    this.radiusNm = options.radiusNm ?? AIRCRAFT_QUERY_RADIUS_NM;
    this.onTracks = options.onTracks;
    this.onStatus = options.onStatus;
    this.createSocket = options.createSocket ??
      ((url, protocol) => new WebSocket(url, protocol));
  }

  start(center: AircraftSubscriptionCenter): void {
    this.center = normalizedCenter(center);
    if (this.running) {
      this.sendSubscription();
      return;
    }
    this.running = true;
    this.connect();
  }

  setCenter(center: AircraftSubscriptionCenter): void {
    this.center = normalizedCenter(center);
    this.sendSubscription();
  }

  stop(): void {
    this.running = false;
    this.ready = false;
    this.sentCenter = undefined;
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "aircraft display inactive");
    this.setStatus("stopped", "Aircraft stream stopped");
  }

  private connect(): void {
    if (!this.running || this.socket) return;
    this.setStatus("connecting", "Connecting to Flight Follower…");
    const candidate = this.createSocket(this.url, FLIGHT_FOLLOWER_SUBPROTOCOL);
    this.socket = candidate;
    candidate.addEventListener("message", (event) => {
      if (this.socket !== candidate) return;
      try {
        this.handleMessage(JSON.parse(event.data) as unknown);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Invalid stream message";
        this.setStatus("error", detail);
        candidate.close(1002, "invalid Flight Follower message");
      }
    });
    candidate.addEventListener("error", () => {
      if (this.socket === candidate) {
        this.setStatus("error", "Flight Follower connection failed");
      }
    });
    candidate.addEventListener("close", () => {
      if (this.socket !== candidate) return;
      this.socket = undefined;
      this.ready = false;
      this.sentCenter = undefined;
      this.scheduleReconnect();
    });
  }

  private handleMessage(value: unknown): void {
    const message = record(value);
    if (
      !message ||
      message.protocolVersion !== FLIGHT_FOLLOWER_PROTOCOL_VERSION
    ) {
      throw new Error("Flight Follower returned an unsupported protocol version.");
    }

    if (message.type === "session.ready") {
      this.ready = true;
      this.reconnectDelayMs = 1_000;
      this.sendSubscription();
      return;
    }
    if (message.type === "track.snapshot") {
      this.tracks.clear();
      this.upsert(message.tracks);
      this.publishTracks();
      this.setStatus("live", "Flight Follower stream connected");
      return;
    }
    if (message.type === "track.delta") {
      if (Array.isArray(message.remove)) {
        for (const id of message.remove) {
          if (typeof id === "string") this.tracks.delete(id.toUpperCase());
        }
      }
      this.upsert(message.upsert);
      this.publishTracks();
      this.setStatus("live", "Flight Follower stream connected");
      return;
    }
    if (message.type === "error") {
      throw new Error(trimmedString(message.message) ?? "Flight Follower stream error.");
    }
  }

  private upsert(values: unknown): void {
    if (!Array.isArray(values)) return;
    const receivedAtMs = Date.now();
    for (const value of values) {
      const track = parseFlightFollowerTrack(value, receivedAtMs);
      if (track) this.tracks.set(track.id, track);
    }
  }

  private publishTracks(): void {
    this.onTracks([...this.tracks.values()]);
  }

  private sendSubscription(): void {
    if (
      !this.ready ||
      !this.center ||
      !this.socket ||
      this.socket.readyState !== 1 ||
      sameCenter(this.center, this.sentCenter)
    ) {
      return;
    }
    this.socket.send(JSON.stringify({
      protocolVersion: FLIGHT_FOLLOWER_PROTOCOL_VERSION,
      type: "subscribe",
      center: this.center,
      radiusNm: this.radiusNm,
    }));
    this.sentCenter = this.center;
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer !== undefined) return;
    const delayMs = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    this.setStatus(
      "retrying",
      `Flight Follower disconnected · retrying in ${Math.ceil(delayMs / 1_000)}s`,
    );
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delayMs);
  }

  private setStatus(state: FlightFollowerConnectionState, detail: string): void {
    this.onStatus({ state, detail });
  }
}

function normalizedCenter(
  center: AircraftSubscriptionCenter,
): AircraftSubscriptionCenter {
  const longitudeDegrees = center.longitudeDegrees >= -180 &&
      center.longitudeDegrees <= 180
    ? center.longitudeDegrees
    : ((center.longitudeDegrees + 180) % 360 + 360) % 360 - 180;
  return Object.freeze({
    latitudeDegrees: Math.max(-90, Math.min(90, center.latitudeDegrees)),
    longitudeDegrees,
  });
}

function sameCenter(
  first: AircraftSubscriptionCenter,
  second: AircraftSubscriptionCenter | undefined,
): boolean {
  return second !== undefined &&
    first.latitudeDegrees === second.latitudeDegrees &&
    first.longitudeDegrees === second.longitudeDegrees;
}
