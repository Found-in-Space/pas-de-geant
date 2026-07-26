import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import type {
  CentralPathSurface,
  Feature,
  Geometry,
  Position,
  SurfaceRegion,
} from "@found-in-space/shadowline";
import { geometryForGlobeFill } from "./display-geometry.js";
import {
  globePathTriangles,
  GLOBE_PATH_FILL_ELEVATION_METRES,
} from "./globe-path-mesh.js";
import { globeMercatorPosition } from "./globe-vector-layer.js";

interface CompiledProgram {
  program: WebGLProgram;
  position: number;
  color: WebGLUniformLocation | null;
  projectionMatrix: WebGLUniformLocation | null;
  tileMercatorCoordinates: WebGLUniformLocation | null;
  clippingPlane: WebGLUniformLocation | null;
  projectionTransition: WebGLUniformLocation | null;
  fallbackMatrix: WebGLUniformLocation | null;
}

const GENERIC_GLOBE_FILL_ELEVATION_METRES = 6_000;

function triangleRings(geometry: Geometry): Position[][] {
  const fill = geometryForGlobeFill(geometry);
  if (fill.type === "Polygon") return [fill.coordinates[0]!];
  if (fill.type === "MultiPolygon") {
    return fill.coordinates
      .map((polygon) => polygon[0])
      .filter((ring): ring is Position[] => Boolean(ring));
  }
  return [];
}

function colorComponents(color: string, opacity: number): Float32Array {
  const match = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) throw new RangeError(`Unsupported globe fill color: ${color}`);
  const red = Number.parseInt(match[1]!, 16) / 255;
  const green = Number.parseInt(match[2]!, 16) / 255;
  const blue = Number.parseInt(match[3]!, 16) / 255;
  return new Float32Array([
    red * opacity,
    green * opacity,
    blue * opacity,
    opacity,
  ]);
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create globe fill shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "Unknown shader error.";
    gl.deleteShader(shader);
    throw new Error(`Unable to compile globe fill shader: ${message}`);
  }
  return shader;
}

/**
 * Renders a pre-triangulated polygon as one shared mesh.
 *
 * MapLibre's GeoJSON worker triangulates each polygon in projected lon/lat
 * space. Near a pole that can reconnect a concave ribbon and blend overlapping
 * pieces. This custom layer keeps the polar-plane triangulation intact and
 * feeds its vertices through MapLibre's own active projection shader.
 */
export class GlobeFillLayer implements CustomLayerInterface {
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private buffer: WebGLBuffer | null = null;
  private readonly programs = new Map<string, CompiledProgram>();
  private vertices = new Float32Array();
  private visible = true;
  private readonly color: Float32Array;

  constructor(
    readonly id: string,
    color: string,
    opacity: number,
    private readonly elevationMetres =
      GENERIC_GLOBE_FILL_ELEVATION_METRES,
  ) {
    this.color = colorComponents(color, opacity);
  }

  setFeatures(features: Feature[]): void {
    const coordinates = features.flatMap((feature) =>
      triangleRings(feature.geometry).flatMap((ring) =>
        ring.slice(0, 3).flatMap(globeMercatorPosition),
      ),
    );
    this.vertices = new Float32Array(coordinates);
    this.upload();
  }

  setPathSurface(surface: CentralPathSurface): void {
    this.vertices = new Float32Array(
      globePathTriangles(surface).flatMap((triangle) =>
        triangle.flatMap(globeMercatorPosition),
      ),
    );
    this.upload();
  }

  setSurfaceRegion(region: SurfaceRegion): void {
    const coordinates = region.rings.flatMap((ring) => {
      const points = ring.points
        .slice(0, -1)
        .map(
          (point) =>
            [
              point.geographic.longitudeDeg,
              point.geographic.latitudeDeg,
            ] as Position,
        );
      if (points.length < 3) return [];
      const triangles: Position[][] = [];
      for (let index = 2; index < points.length; index += 1) {
        triangles.push([points[0]!, points[index - 1]!, points[index]!]);
      }
      return triangles.flatMap((triangle) =>
        triangle.flatMap(globeMercatorPosition),
      );
    });
    this.vertices = new Float32Array(coordinates);
    this.upload();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.map?.triggerRepaint();
  }

  onAdd(
    map: MapLibreMap,
    context: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    if (!(context instanceof WebGL2RenderingContext)) {
      throw new Error("The globe fill requires WebGL 2.");
    }
    this.map = map;
    this.gl = context;
    this.buffer = context.createBuffer();
    if (!this.buffer) throw new Error("Unable to create globe fill buffer.");
    this.upload();
  }

  onRemove(
    _map: MapLibreMap,
    context: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    if (this.buffer) context.deleteBuffer(this.buffer);
    for (const compiled of this.programs.values()) {
      context.deleteProgram(compiled.program);
    }
    this.programs.clear();
    this.buffer = null;
    this.gl = null;
    this.map = null;
  }

  render(
    context: WebGLRenderingContext | WebGL2RenderingContext,
    input: CustomRenderMethodInput,
  ): void {
    if (
      !this.visible ||
      this.vertices.length === 0 ||
      !this.buffer ||
      !(context instanceof WebGL2RenderingContext)
    ) {
      return;
    }
    const compiled = this.programFor(context, input);
    const projection = input.defaultProjectionData;
    context.useProgram(compiled.program);
    context.bindBuffer(context.ARRAY_BUFFER, this.buffer);
    context.enableVertexAttribArray(compiled.position);
    context.vertexAttribPointer(
      compiled.position,
      2,
      context.FLOAT,
      false,
      0,
      0,
    );
    context.uniform4fv(compiled.color, this.color);
    context.uniformMatrix4fv(
      compiled.projectionMatrix,
      false,
      projection.mainMatrix as unknown as Float32List,
    );
    context.uniform4fv(
      compiled.tileMercatorCoordinates,
      projection.tileMercatorCoords,
    );
    context.uniform4fv(
      compiled.clippingPlane,
      projection.clippingPlane,
    );
    context.uniform1f(
      compiled.projectionTransition,
      projection.projectionTransition,
    );
    context.uniformMatrix4fv(
      compiled.fallbackMatrix,
      false,
      projection.fallbackMatrix as unknown as Float32List,
    );
    context.disable(context.CULL_FACE);
    context.drawArrays(
      context.TRIANGLES,
      0,
      this.vertices.length / 2,
    );
  }

  private upload(): void {
    if (!this.gl || !this.buffer) {
      this.map?.triggerRepaint();
      return;
    }
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      this.vertices,
      this.gl.STATIC_DRAW,
    );
    this.map?.triggerRepaint();
  }

  private programFor(
    gl: WebGL2RenderingContext,
    input: CustomRenderMethodInput,
  ): CompiledProgram {
    const cached = this.programs.get(input.shaderData.variantName);
    if (cached) return cached;
    const vertex = compileShader(
      gl,
      gl.VERTEX_SHADER,
      `#version 300 es
${input.shaderData.vertexShaderPrelude}
${input.shaderData.define}
in vec2 a_pos;
void main() {
  gl_Position = projectTileFor3D(a_pos, ${this.elevationMetres.toFixed(1)});
}`,
    );
    const fragment = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 fragColor;
void main() {
  fragColor = u_color;
}`,
    );
    const program = gl.createProgram();
    if (!program) throw new Error("Unable to create globe fill program.");
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) ?? "Unknown link error.";
      gl.deleteProgram(program);
      throw new Error(`Unable to link globe fill program: ${message}`);
    }
    const compiled: CompiledProgram = {
      program,
      position: gl.getAttribLocation(program, "a_pos"),
      color: gl.getUniformLocation(program, "u_color"),
      projectionMatrix: gl.getUniformLocation(
        program,
        "u_projection_matrix",
      ),
      tileMercatorCoordinates: gl.getUniformLocation(
        program,
        "u_projection_tile_mercator_coords",
      ),
      clippingPlane: gl.getUniformLocation(
        program,
        "u_projection_clipping_plane",
      ),
      projectionTransition: gl.getUniformLocation(
        program,
        "u_projection_transition",
      ),
      fallbackMatrix: gl.getUniformLocation(
        program,
        "u_projection_fallback_matrix",
      ),
    };
    this.programs.set(input.shaderData.variantName, compiled);
    return compiled;
  }
}
