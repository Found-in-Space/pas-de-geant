import {
  createColumn,
  createNode,
  createValueReadout,
  type BitmapHandle,
  type DisplayComponent,
  type DisplayNode,
  type DrawCommand,
  type Rect,
  type SurfaceMetrics,
  type ThemeTokens,
} from "@found-in-space/touch-os";

export const HAND_PANEL_SURFACE: Partial<SurfaceMetrics> = {
  width: 640,
  height: 360,
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
  controlHeight: 40,
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
  globalScaleFactor: number;
  radialMultiplier: number;
  minimumTerrainZoom: number;
  maximumTerrainZoom: number;
  terrainBudgetLimited: boolean;
}

interface EarthLocationMapProps extends HandPanelLocation {
  map: BitmapHandle;
  height: number;
  northDirection: HandPanelDirection;
}

interface HandPanelStatusProps extends HandPanelStatus {
  height: number;
}

const EARTH_MAP_ZOOM = 4;
const EARTH_MAP_BORDER_WIDTH = 12;
const DEFAULT_HAND_PANEL_STATUS: HandPanelStatus = {
  globalScaleFactor: 1,
  radialMultiplier: 1,
  minimumTerrainZoom: 0,
  maximumTerrainZoom: 0,
  terrainBudgetLimited: false,
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
    const labelRect: Rect = {
      x: mapRect.x + EARTH_MAP_BORDER_WIDTH + 6,
      y: mapRect.y + EARTH_MAP_BORDER_WIDTH + 6,
      width: 132,
      height: 28,
    };
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
        role: "earth-map-label-background",
        rect: labelRect,
        fill: theme.overlayColor,
        stroke: theme.borderColor,
        strokeWidth: 1,
        radius: 6,
      },
      {
        type: "text",
        componentId: ctx.id,
        role: "earth-map-label",
        rect: labelRect,
        text: "UNDERFOOT",
        color: theme.accentColor,
        align: "center",
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
    const fields = [
      {
        label: "GLOBAL SCALE",
        value: `${ctx.props.globalScaleFactor.toFixed(2)}×`,
      },
      {
        label: "RADIAL",
        value: `${ctx.props.radialMultiplier.toFixed(1)}×`,
      },
      {
        label: "AUTO LOD · X TILES",
        value:
          `z${ctx.props.minimumTerrainZoom}–${ctx.props.maximumTerrainZoom}` +
          (ctx.props.terrainBudgetLimited ? " · CAP" : ""),
      },
    ];
    const commands: DrawCommand[] = [];
    for (const [index, field] of fields.entries()) {
      const x =
        ctx.bounds.x + ctx.bounds.width * index / fields.length;
      const nextX =
        ctx.bounds.x + ctx.bounds.width * (index + 1) / fields.length;
      const rect: Rect = {
        x,
        y: ctx.bounds.y,
        width: nextX - x,
        height: ctx.bounds.height,
      };
      const labelRect: Rect = {
        x: rect.x + 6,
        y: rect.y + 2,
        width: rect.width - 12,
        height: rect.height * 0.42,
      };
      const valueRect: Rect = {
        x: rect.x + 6,
        y: rect.y + rect.height * 0.38,
        width: rect.width - 12,
        height: rect.height * 0.6,
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
          align: "center",
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
          color: theme.textColor,
          align: "center",
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
        height: 238,
      }),
      createValueReadout("pas-de-geant-coordinates", {
        label: "Underfoot",
        value: formatCoordinates(
          location.latitudeDegrees,
          location.longitudeDegrees,
        ),
      }),
      createNode(
        "pas-de-geant-status",
        HandPanelStatusComponent,
        {
          ...status,
          height: 48,
        },
      ),
    ],
  });
}

export function earthMapImageRects(
  latitudeDegrees: number,
  longitudeDegrees: number,
  rect: Rect,
  zoom = EARTH_MAP_ZOOM,
): Rect[] {
  const latitude = Math.max(-90, Math.min(90, latitudeDegrees));
  const longitude =
    ((longitudeDegrees + 180) % 360 + 360) % 360 - 180;
  const resolvedZoom = Math.max(1, zoom);
  const width = rect.width * resolvedZoom;
  const height = width / 2;
  const centreX = rect.x + rect.width / 2;
  const centreY = rect.y + rect.height / 2;
  const x = centreX - (longitude + 180) / 360 * width;
  const y = centreY - (90 - latitude) / 180 * height;
  return [0, -1, 1].map((wrap) => ({
    x: x + wrap * width,
    y,
    width,
    height,
  }));
}

export function earthMapPoint(
  latitudeDegrees: number,
  longitudeDegrees: number,
  rect: Rect,
): { x: number; y: number } {
  const latitude = Math.max(-90, Math.min(90, latitudeDegrees));
  const longitude =
    ((longitudeDegrees + 180) % 360 + 360) % 360 - 180;
  return {
    x: rect.x + (longitude + 180) / 360 * rect.width,
    y: rect.y + (90 - latitude) / 180 * rect.height,
  };
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
