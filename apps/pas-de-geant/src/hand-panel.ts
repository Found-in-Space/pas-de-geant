import {
  createButton,
  createColumn,
  createNode,
  type BitmapHandle,
  type DisplayComponent,
  type DisplayNode,
  type DrawCommand,
  type Rect,
  type SurfaceMetrics,
  type ThemeTokens,
  type RuntimeOutput,
} from "@found-in-space/touch-os";
import {
  earthMapImageRects,
  earthMapPoint,
} from "./earth-map.js";
import type { RealtimeAgentState } from "./realtime-agent.js";
import {
  DEFAULT_SCALE_DENOMINATOR,
  formatScaleRatio,
} from "./world-scale.js";

export { earthMapImageRects, earthMapPoint } from "./earth-map.js";

export const HAND_PANEL_SURFACE: Partial<SurfaceMetrics> = {
  width: 480,
  height: 600,
  pixelDensity: 1,
  safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
};

export const HAND_PANEL_THEME: Partial<ThemeTokens> = {
  backgroundColor: "#03101a",
  surfaceColor: "#0a2230",
  textColor: "#eef8fb",
  mutedTextColor: "#79a8b7",
  accentColor: "#76ddf1",
  accentTextColor: "#03101a",
  borderColor: "#24566a",
  focusColor: "#f7d36f",
  overlayColor: "rgba(1, 8, 14, 0.78)",
  controlHeight: 48,
  spacing: 6,
  padding: 10,
  radius: 8,
  typography: {
    fontFamily: "Inter, ui-sans-serif, system-ui",
    fontSize: 16,
    lineHeight: 20,
    fontWeight: 650,
  },
};

export interface HandPanelLocation {
  latitudeDegrees: number;
  longitudeDegrees: number;
}

export interface HandPanelDirection {
  x: number;
  y: number;
}

export interface HandPanelStatus {
  scaleDenominator: number;
  radialMultiplier: number;
  minimumTerrainZoom: number;
  maximumTerrainZoom: number;
  terrainBudgetLimited: boolean;
  agentState: RealtimeAgentState;
  navigationMode?: "surface" | "orbit" | "free";
  focusBody?: string;
  focusAltitudePhysicalM?: number;
}

export const HAND_PANEL_ACTION = {
  cycleMode: "world.navigation.cycle-mode",
  toggleEarthMoon: "world.navigation.toggle-earth-moon",
} as const;

export function handPanelNavigationAction(
  output: RuntimeOutput,
): "cycle-mode" | "toggle-earth-moon" | null {
  if (output.type !== "action") return null;
  if (output.actionId === HAND_PANEL_ACTION.cycleMode) return "cycle-mode";
  if (output.actionId === HAND_PANEL_ACTION.toggleEarthMoon) {
    return "toggle-earth-moon";
  }
  return null;
}

interface EarthLocationMapProps extends HandPanelLocation {
  map: BitmapHandle;
  height: number;
  northDirection: HandPanelDirection;
  coordinateLabel: string;
}

interface HandPanelStatusProps extends HandPanelStatus {
  height: number;
}

const EARTH_MAP_BORDER_WIDTH = 12;

export function formatPhysicalAltitude(metres: number): string {
  if (!Number.isFinite(metres)) return "—";
  const nonnegative = Math.max(0, metres);
  if (nonnegative < 1_000) return `${nonnegative.toFixed(0)} m`;
  return `${(nonnegative / 1_000).toLocaleString("en-GB", {
    maximumFractionDigits: nonnegative < 1_000_000 ? 1 : 0,
  })} km`;
}

const DEFAULT_HAND_PANEL_STATUS: HandPanelStatus = {
  scaleDenominator: DEFAULT_SCALE_DENOMINATOR,
  radialMultiplier: 1,
  minimumTerrainZoom: 0,
  maximumTerrainZoom: 0,
  terrainBudgetLimited: false,
  agentState: "off",
};

const EarthLocationMapComponent: DisplayComponent<EarthLocationMapProps> = {
  kind: "pas-de-geant-earth-location-map",
  measure(ctx) {
    return {
      width: ctx.constraints.maxWidth,
      height: Math.min(ctx.props.height, ctx.constraints.maxHeight),
    };
  },
  render(ctx) {
    const theme = ctx.services.theme.getTokens();
    const mapRect = containAspectRatio(ctx.bounds, 2);
    const imageRects = earthMapImageRects(
      ctx.props.latitudeDegrees,
      ctx.props.longitudeDegrees,
      mapRect,
    );
    const marker = {
      x: mapRect.x + mapRect.width / 2,
      y: mapRect.y + mapRect.height / 2,
    };
    const borderRect = insetRect(mapRect, EARTH_MAP_BORDER_WIDTH / 2);
    const northPointer = compassBorderPoint(
      ctx.props.northDirection,
      borderRect,
    );
    const coordinateRect: Rect = {
      x: mapRect.x + EARTH_MAP_BORDER_WIDTH + 6,
      y: mapRect.y + EARTH_MAP_BORDER_WIDTH + 6,
      width: 212,
      height: 32,
    };
    const coordinateTextRect = insetRect(coordinateRect, 9);
    const commands: DrawCommand[] = [
      {
        type: "rect",
        componentId: ctx.id,
        role: "earth-map-frame",
        rect: ctx.bounds,
        fill: theme.backgroundColor,
        stroke: theme.borderColor,
        strokeWidth: 1,
        radius: theme.radius,
      },
      ...imageRects.map<DrawCommand>((rect) => ({
        type: "bitmap",
        componentId: ctx.id,
        role: "earth-map-image",
        clipRect: mapRect,
        rect,
        handle: ctx.props.map,
        fit: "stretch",
        sampling: "linear",
      })),
      {
        type: "rect",
        componentId: ctx.id,
        role: "earth-map-border",
        rect: borderRect,
        stroke: "#000000",
        strokeWidth: EARTH_MAP_BORDER_WIDTH,
        radius: 3,
      },
      {
        type: "rect",
        componentId: ctx.id,
        role: "earth-map-coordinates-background",
        rect: coordinateRect,
        fill: theme.overlayColor,
        stroke: theme.borderColor,
        strokeWidth: 1,
        radius: 6,
      },
      {
        type: "text",
        componentId: ctx.id,
        role: "earth-map-coordinates",
        rect: coordinateTextRect,
        text: ctx.props.coordinateLabel,
        color: theme.accentColor,
        align: "left",
        verticalAlign: "middle",
        fontSize: 14,
        fontWeight: 750,
      },
      {
        type: "circle",
        componentId: ctx.id,
        role: "earth-map-marker-halo",
        clipRect: mapRect,
        cx: marker.x,
        cy: marker.y,
        radius: 12,
        fill: "rgba(1, 8, 14, 0.78)",
        stroke: theme.textColor,
        strokeWidth: 2,
      },
      {
        type: "circle",
        componentId: ctx.id,
        role: "earth-map-marker",
        clipRect: mapRect,
        cx: marker.x,
        cy: marker.y,
        radius: 5,
        fill: theme.accentColor,
        stroke: theme.accentTextColor,
        strokeWidth: 1,
      },
      {
        type: "circle",
        componentId: ctx.id,
        role: "earth-map-north-pointer-halo",
        cx: northPointer.x,
        cy: northPointer.y,
        radius: 10,
        fill: "#000000",
      },
      {
        type: "circle",
        componentId: ctx.id,
        role: "earth-map-north-pointer",
        cx: northPointer.x,
        cy: northPointer.y,
        radius: 7,
        fill: "#ff3b30",
        stroke: "#5c0804",
        strokeWidth: 2,
      },
    ];
    return commands;
  },
  hitTest() {
    return null;
  },
};

const HandPanelStatusComponent: DisplayComponent<HandPanelStatusProps> = {
  kind: "pas-de-geant-status",
  measure(ctx) {
    return {
      width: ctx.constraints.maxWidth,
      height: Math.min(ctx.props.height, ctx.constraints.maxHeight),
    };
  },
  render(ctx) {
    const theme = ctx.services.theme.getTokens();
    const fields: Array<{
      label: string;
      value: string;
      valueColor?: string;
    }> = [
      {
        label: "SCALE",
        value: formatScaleRatio(ctx.props.scaleDenominator),
      },
      {
        label: ctx.props.navigationMode === "orbit" ? "ALTITUDE" : "RADIAL",
        value: ctx.props.navigationMode === "orbit" &&
            ctx.props.focusAltitudePhysicalM !== undefined
          ? formatPhysicalAltitude(ctx.props.focusAltitudePhysicalM)
          : `${ctx.props.radialMultiplier.toFixed(1)}×`,
      },
      {
        label: "AUTO LOD · X TILES",
        value:
          `z${ctx.props.minimumTerrainZoom}–${ctx.props.maximumTerrainZoom}` +
          (ctx.props.terrainBudgetLimited ? " · CAP" : ""),
      },
      {
        label: "VOICE AGENT · A",
        value: ctx.props.agentState.toUpperCase(),
        valueColor:
          ctx.props.agentState === "error"
            ? theme.focusColor
            : ctx.props.agentState === "off"
              ? theme.mutedTextColor
              : theme.accentColor,
      },
    ];
    const commands: DrawCommand[] = [];
    for (const [index, field] of fields.entries()) {
      const y =
        ctx.bounds.y + ctx.bounds.height * index / fields.length;
      const nextY =
        ctx.bounds.y + ctx.bounds.height * (index + 1) / fields.length;
      const rect: Rect = {
        x: ctx.bounds.x,
        y,
        width: ctx.bounds.width,
        height: nextY - y,
      };
      const labelRect: Rect = {
        x: rect.x + 12,
        y: rect.y,
        width: rect.width * 0.52 - 12,
        height: rect.height,
      };
      const valueRect: Rect = {
        x: rect.x + rect.width * 0.52,
        y: rect.y,
        width: rect.width * 0.48 - 12,
        height: rect.height,
      };
      commands.push(
        {
          type: "rect",
          componentId: ctx.id,
          role: "planet-status-cell",
          rect,
          fill: theme.surfaceColor,
          stroke: theme.borderColor,
          strokeWidth: 1,
          radius:
            index === 0 || index === fields.length - 1
              ? theme.radius
              : 0,
        },
        {
          type: "text",
          componentId: ctx.id,
          role: "planet-status-label",
          rect: labelRect,
          text: field.label,
          color: theme.mutedTextColor,
          align: "left",
          verticalAlign: "middle",
          fontSize: 12,
          fontWeight: 700,
        },
        {
          type: "text",
          componentId: ctx.id,
          role: "planet-status-value",
          rect: valueRect,
          text: field.value,
          color: field.valueColor ?? theme.textColor,
          align: "right",
          verticalAlign: "middle",
          fontSize: 16,
          fontWeight: 750,
        },
      );
    }
    return commands;
  },
  hitTest() {
    return null;
  },
};

export function createHandPanelRoot(
  location: HandPanelLocation,
  map: BitmapHandle,
  northDirection: HandPanelDirection = { x: 0, y: -1 },
  status: HandPanelStatus = DEFAULT_HAND_PANEL_STATUS,
): DisplayNode<unknown> {
  return createColumn("pas-de-geant-hand-panel", {
    padding: 8,
    gap: 6,
    backgroundColor: HAND_PANEL_THEME.backgroundColor,
    children: [
      createNode("pas-de-geant-earth-map", EarthLocationMapComponent, {
        ...location,
        map,
        northDirection,
        coordinateLabel: formatCoordinates(
          location.latitudeDegrees,
          location.longitudeDegrees,
        ),
        height: 232,
      }),
      createColumn("pas-de-geant-navigation-actions", {
        gap: 6,
        children: [
          createButton("pas-de-geant-mode", {
            label: `Mode · ${status.navigationMode ?? "surface"}`,
            actionId: HAND_PANEL_ACTION.cycleMode,
          }),
          createButton("pas-de-geant-world", {
            label: `World · ${status.focusBody ?? "earth"}`,
            actionId: HAND_PANEL_ACTION.toggleEarthMoon,
          }),
        ],
      }),
      createNode(
        "pas-de-geant-status",
        HandPanelStatusComponent,
        {
          ...status,
          height: 238,
        },
      ),
    ],
  });
}

export function compassBorderPoint(
  direction: HandPanelDirection,
  rect: Rect,
): { x: number; y: number } {
  let x = Number.isFinite(direction.x) ? direction.x : 0;
  let y = Number.isFinite(direction.y) ? direction.y : -1;
  const length = Math.hypot(x, y);
  if (length < 1e-8) {
    x = 0;
    y = -1;
  } else {
    x /= length;
    y /= length;
  }
  const halfWidth = rect.width / 2;
  const halfHeight = rect.height / 2;
  const horizontalScale =
    Math.abs(x) < 1e-8 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(x);
  const verticalScale =
    Math.abs(y) < 1e-8 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(y);
  const scale = Math.min(horizontalScale, verticalScale);
  return {
    x: rect.x + halfWidth + x * scale,
    y: rect.y + halfHeight + y * scale,
  };
}

export function formatCoordinates(
  latitudeDegrees: number,
  longitudeDegrees: number,
): string {
  return (
    `${Math.abs(latitudeDegrees).toFixed(2)}° ` +
    `${latitudeDegrees >= 0 ? "N" : "S"} · ` +
    `${Math.abs(longitudeDegrees).toFixed(2)}° ` +
    `${longitudeDegrees >= 0 ? "E" : "W"}`
  );
}

function insetRect(rect: Rect, inset: number): Rect {
  return {
    x: rect.x + inset,
    y: rect.y + inset,
    width: Math.max(0, rect.width - inset * 2),
    height: Math.max(0, rect.height - inset * 2),
  };
}

function containAspectRatio(rect: Rect, aspectRatio: number): Rect {
  const availableAspect = rect.width / Math.max(rect.height, 1);
  if (availableAspect > aspectRatio) {
    const width = rect.height * aspectRatio;
    return {
      x: rect.x + (rect.width - width) / 2,
      y: rect.y,
      width,
      height: rect.height,
    };
  }
  const height = rect.width / aspectRatio;
  return {
    x: rect.x,
    y: rect.y + (rect.height - height) / 2,
    width: rect.width,
    height,
  };
}
