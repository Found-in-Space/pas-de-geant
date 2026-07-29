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

interface EarthLocationMapProps extends HandPanelLocation {
  map: BitmapHandle;
  height: number;
}

const EarthLocationMapComponent: DisplayComponent<EarthLocationMapProps> = {
  kind: "little-planet-earth-location-map",
  measure(ctx) {
    return {
      width: ctx.constraints.maxWidth,
      height: Math.min(ctx.props.height, ctx.constraints.maxHeight),
    };
  },
  render(ctx) {
    const theme = ctx.services.theme.getTokens();
    const mapRect = containAspectRatio(ctx.bounds, 2);
    const marker = earthMapPoint(
      ctx.props.latitudeDegrees,
      ctx.props.longitudeDegrees,
      mapRect,
    );
    const labelRect: Rect = {
      x: mapRect.x + 8,
      y: mapRect.y + 8,
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
      {
        type: "bitmap",
        componentId: ctx.id,
        role: "earth-map-image",
        rect: mapRect,
        handle: ctx.props.map,
        fit: "stretch",
        sampling: "linear",
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
    ];
    return commands;
  },
  hitTest() {
    return null;
  },
};

export function createHandPanelRoot(
  location: HandPanelLocation,
  map: BitmapHandle,
): DisplayNode<unknown> {
  return createColumn("little-planet-hand-panel", {
    padding: 8,
    gap: 6,
    backgroundColor: HAND_PANEL_THEME.backgroundColor,
    children: [
      createNode("little-planet-earth-map", EarthLocationMapComponent, {
        ...location,
        map,
        height: 298,
      }),
      createValueReadout("little-planet-coordinates", {
        label: "Underfoot",
        value: formatCoordinates(
          location.latitudeDegrees,
          location.longitudeDegrees,
        ),
      }),
    ],
  });
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
