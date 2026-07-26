import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import type { Position } from "@found-in-space/shadowline";

interface ProjectionUniforms {
  projectionMatrix: WebGLUniformLocation | null;
  tileMercatorCoordinates: WebGLUniformLocation | null;
  clippingPlane: WebGLUniformLocation | null;
  projectionTransition: WebGLUniformLocation | null;
  fallbackMatrix: WebGLUniformLocation | null;
}

interface LineProgram extends ProjectionUniforms {
  program: WebGLProgram;
  start: number;
  end: number;
  endpoint: number;
  side: number;
  color: WebGLUniformLocation | null;
  viewport: WebGLUniformLocation | null;
  halfWidth: WebGLUniformLocation | null;
  dash: WebGLUniformLocation | null;
}

interface PointProgram extends ProjectionUniforms {
  program: WebGLProgram;
  position: number;
  color: WebGLUniformLocation | null;
  strokeColor: WebGLUniformLocation | null;
  pointSize: WebGLUniformLocation | null;
  innerRadius: WebGLUniformLocation | null;
}

const MAX_GLOBE_RENDER_LATITUDE = 89.999999;
const GLOBE_VECTOR_ELEVATION_METRES = 2_000;
const LINE_VERTEX_FLOATS = 6;

/**
 * MapLibre's projection shader accepts world-Mercator coordinates, including
 * values beyond the Web-Mercator tile range. Keeping those values outside
 * [0, 1] is what preserves real latitudes above 85.051128° on a globe.
 */
export function globeMercatorPosition([
  longitude,
  latitude,
]: Position): Position {
  if (
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90
  ) {
    throw new RangeError("Invalid globe vector coordinate.");
  }
  const safeLatitude = Math.max(
    -MAX_GLOBE_RENDER_LATITUDE,
    Math.min(MAX_GLOBE_RENDER_LATITUDE, latitude),
  );
  const latitudeRadians = (safeLatitude * Math.PI) / 180;
  return [
    (longitude + 180) / 360,
    (180 -
      (180 / Math.PI) *
        Math.log(Math.tan(Math.PI / 4 + latitudeRadians / 2))) /
      360,
  ];
}

function colorComponents(color: string, opacity = 1): Float32Array {
  const match = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) throw new RangeError(`Unsupported globe vector color: ${color}`);
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
  if (!shader) throw new Error("Unable to create globe vector shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "Unknown shader error.";
    gl.deleteShader(shader);
    throw new Error(`Unable to compile globe vector shader: ${message}`);
  }
  return shader;
}

function linkProgram(
  gl: WebGL2RenderingContext,
  vertex: WebGLShader,
  fragment: WebGLShader,
): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error("Unable to create globe vector program.");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? "Unknown link error.";
    gl.deleteProgram(program);
    throw new Error(`Unable to link globe vector program: ${message}`);
  }
  return program;
}

function projectionUniforms(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
): ProjectionUniforms {
  return {
    projectionMatrix: gl.getUniformLocation(program, "u_projection_matrix"),
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
}

function bindProjection(
  gl: WebGL2RenderingContext,
  program: ProjectionUniforms,
  input: CustomRenderMethodInput,
): void {
  const projection = input.defaultProjectionData;
  gl.uniformMatrix4fv(
    program.projectionMatrix,
    false,
    projection.mainMatrix as unknown as Float32List,
  );
  gl.uniform4fv(
    program.tileMercatorCoordinates,
    projection.tileMercatorCoords,
  );
  gl.uniform4fv(program.clippingPlane, projection.clippingPlane);
  gl.uniform1f(
    program.projectionTransition,
    projection.projectionTransition,
  );
  gl.uniformMatrix4fv(
    program.fallbackMatrix,
    false,
    projection.fallbackMatrix as unknown as Float32List,
  );
}

function prepareDrawing(gl: WebGL2RenderingContext): void {
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.CULL_FACE);
}

function appendLineVertex(
  output: number[],
  start: Position,
  end: Position,
  endpoint: 0 | 1,
  side: -1 | 1,
): void {
  output.push(
    start[0],
    start[1],
    end[0],
    end[1],
    endpoint,
    side,
  );
}

export interface GlobeLineStyle {
  color: string;
  width: number;
  opacity?: number;
  dash?: [number, number];
  elevationMetres?: number;
}

/**
 * Draws geographic lines without passing them through MapLibre's tiled
 * GeoJSON pipeline. Each segment becomes a screen-space quad, so line width
 * remains stable while the endpoints follow the active globe projection.
 */
export class GlobeLineLayer implements CustomLayerInterface {
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private buffer: WebGLBuffer | null = null;
  private readonly programs = new Map<string, LineProgram>();
  private vertices = new Float32Array();
  private visible = true;
  private readonly color: Float32Array;
  private readonly dash: Float32Array;
  private readonly elevationMetres: number;

  constructor(
    readonly id: string,
    private readonly style: GlobeLineStyle,
  ) {
    this.color = colorComponents(style.color, style.opacity);
    this.dash = new Float32Array(style.dash ?? [0, 0]);
    this.elevationMetres =
      style.elevationMetres ?? GLOBE_VECTOR_ELEVATION_METRES;
  }

  setLines(lines: Position[][]): void {
    const coordinates: number[] = [];
    for (const line of lines) {
      for (let index = 1; index < line.length; index += 1) {
        const start = globeMercatorPosition(line[index - 1]!);
        const end = globeMercatorPosition(line[index]!);
        appendLineVertex(coordinates, start, end, 0, -1);
        appendLineVertex(coordinates, start, end, 0, 1);
        appendLineVertex(coordinates, start, end, 1, -1);
        appendLineVertex(coordinates, start, end, 1, -1);
        appendLineVertex(coordinates, start, end, 0, 1);
        appendLineVertex(coordinates, start, end, 1, 1);
      }
    }
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
      throw new Error("Globe vector lines require WebGL 2.");
    }
    this.map = map;
    this.gl = context;
    this.buffer = context.createBuffer();
    if (!this.buffer) {
      throw new Error("Unable to create globe vector line buffer.");
    }
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
      !this.map ||
      !(context instanceof WebGL2RenderingContext)
    ) {
      return;
    }
    const compiled = this.programFor(context, input);
    const stride = LINE_VERTEX_FLOATS * Float32Array.BYTES_PER_ELEMENT;
    context.useProgram(compiled.program);
    context.bindBuffer(context.ARRAY_BUFFER, this.buffer);
    context.enableVertexAttribArray(compiled.start);
    context.vertexAttribPointer(
      compiled.start,
      2,
      context.FLOAT,
      false,
      stride,
      0,
    );
    context.enableVertexAttribArray(compiled.end);
    context.vertexAttribPointer(
      compiled.end,
      2,
      context.FLOAT,
      false,
      stride,
      2 * Float32Array.BYTES_PER_ELEMENT,
    );
    context.enableVertexAttribArray(compiled.endpoint);
    context.vertexAttribPointer(
      compiled.endpoint,
      1,
      context.FLOAT,
      false,
      stride,
      4 * Float32Array.BYTES_PER_ELEMENT,
    );
    context.enableVertexAttribArray(compiled.side);
    context.vertexAttribPointer(
      compiled.side,
      1,
      context.FLOAT,
      false,
      stride,
      5 * Float32Array.BYTES_PER_ELEMENT,
    );
    context.uniform4fv(compiled.color, this.color);
    context.uniform2fv(compiled.dash, this.dash);
    context.uniform1f(compiled.halfWidth, this.style.width / 2);
    context.uniform2f(
      compiled.viewport,
      this.map.getCanvas().clientWidth,
      this.map.getCanvas().clientHeight,
    );
    bindProjection(context, compiled, input);
    prepareDrawing(context);
    context.drawArrays(
      context.TRIANGLES,
      0,
      this.vertices.length / LINE_VERTEX_FLOATS,
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
  ): LineProgram {
    const cached = this.programs.get(input.shaderData.variantName);
    if (cached) return cached;
    const vertex = compileShader(
      gl,
      gl.VERTEX_SHADER,
      `#version 300 es
${input.shaderData.vertexShaderPrelude}
${input.shaderData.define}
in vec2 a_start;
in vec2 a_end;
in float a_endpoint;
in float a_side;
uniform vec2 u_viewport;
uniform float u_half_width;
out float v_distance_px;
void main() {
  vec4 start_clip = projectTileFor3D(a_start, ${this.elevationMetres.toFixed(1)});
  vec4 end_clip = projectTileFor3D(a_end, ${this.elevationMetres.toFixed(1)});
  vec2 start_ndc = start_clip.xy / start_clip.w;
  vec2 end_ndc = end_clip.xy / end_clip.w;
  vec2 direction_px = (end_ndc - start_ndc) * u_viewport * 0.5;
  float length_px = max(length(direction_px), 0.001);
  vec2 normal = vec2(-direction_px.y, direction_px.x) / length_px;
  vec4 selected = mix(start_clip, end_clip, a_endpoint);
  vec2 offset_ndc = normal * (2.0 * u_half_width / u_viewport);
  selected.xy += offset_ndc * selected.w * a_side;
  gl_Position = selected;
  v_distance_px = a_endpoint * length_px;
}`,
    );
    const fragment = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      `#version 300 es
precision mediump float;
uniform vec4 u_color;
uniform vec2 u_dash;
in float v_distance_px;
out vec4 fragColor;
void main() {
  float period = u_dash.x + u_dash.y;
  if (period > 0.0 && mod(v_distance_px, period) > u_dash.x) discard;
  fragColor = u_color;
}`,
    );
    const program = linkProgram(gl, vertex, fragment);
    const compiled: LineProgram = {
      program,
      start: gl.getAttribLocation(program, "a_start"),
      end: gl.getAttribLocation(program, "a_end"),
      endpoint: gl.getAttribLocation(program, "a_endpoint"),
      side: gl.getAttribLocation(program, "a_side"),
      color: gl.getUniformLocation(program, "u_color"),
      viewport: gl.getUniformLocation(program, "u_viewport"),
      halfWidth: gl.getUniformLocation(program, "u_half_width"),
      dash: gl.getUniformLocation(program, "u_dash"),
      ...projectionUniforms(gl, program),
    };
    this.programs.set(input.shaderData.variantName, compiled);
    return compiled;
  }
}

export interface GlobePointStyle {
  color: string;
  radius: number;
  strokeColor: string;
  strokeWidth: number;
  opacity?: number;
  elevationMetres?: number;
}

/**
 * Draws point markers from their true geographic coordinates. MapLibre's
 * GeoJSON circle source clamps points to 85.051128° before its globe stage;
 * this layer deliberately bypasses that Web-Mercator-only conversion.
 */
export class GlobePointLayer implements CustomLayerInterface {
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private buffer: WebGLBuffer | null = null;
  private readonly programs = new Map<string, PointProgram>();
  private vertices = new Float32Array();
  private visible = true;
  private readonly color: Float32Array;
  private readonly strokeColor: Float32Array;
  private readonly elevationMetres: number;

  constructor(
    readonly id: string,
    private readonly style: GlobePointStyle,
  ) {
    this.color = colorComponents(style.color, style.opacity);
    this.strokeColor = colorComponents(style.strokeColor, style.opacity);
    this.elevationMetres =
      style.elevationMetres ?? GLOBE_VECTOR_ELEVATION_METRES + 500;
  }

  setPositions(positions: Position[]): void {
    this.vertices = new Float32Array(
      positions.flatMap(globeMercatorPosition),
    );
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
      throw new Error("Globe vector points require WebGL 2.");
    }
    this.map = map;
    this.gl = context;
    this.buffer = context.createBuffer();
    if (!this.buffer) {
      throw new Error("Unable to create globe vector point buffer.");
    }
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
      !this.map ||
      !(context instanceof WebGL2RenderingContext)
    ) {
      return;
    }
    const compiled = this.programFor(context, input);
    const devicePixelRatio =
      this.map.getCanvas().width / this.map.getCanvas().clientWidth;
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
    context.uniform4fv(compiled.strokeColor, this.strokeColor);
    context.uniform1f(
      compiled.pointSize,
      this.style.radius * 2 * devicePixelRatio,
    );
    context.uniform1f(
      compiled.innerRadius,
      Math.max(
        0,
        (this.style.radius - this.style.strokeWidth) / this.style.radius,
      ),
    );
    bindProjection(context, compiled, input);
    prepareDrawing(context);
    const depthTestWasEnabled = context.isEnabled(context.DEPTH_TEST);
    context.disable(context.DEPTH_TEST);
    context.drawArrays(context.POINTS, 0, this.vertices.length / 2);
    if (depthTestWasEnabled) context.enable(context.DEPTH_TEST);
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
  ): PointProgram {
    const cached = this.programs.get(input.shaderData.variantName);
    if (cached) return cached;
    const vertex = compileShader(
      gl,
      gl.VERTEX_SHADER,
      `#version 300 es
${input.shaderData.vertexShaderPrelude}
${input.shaderData.define}
in vec2 a_pos;
uniform float u_point_size;
void main() {
  gl_Position = projectTileWithElevation(a_pos, ${this.elevationMetres.toFixed(1)});
  gl_PointSize = u_point_size;
}`,
    );
    const fragment = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      `#version 300 es
precision mediump float;
uniform vec4 u_color;
uniform vec4 u_stroke_color;
uniform float u_inner_radius;
out vec4 fragColor;
void main() {
  float radius = length(gl_PointCoord * 2.0 - 1.0);
  if (radius > 1.0) discard;
  fragColor = radius > u_inner_radius ? u_stroke_color : u_color;
}`,
    );
    const program = linkProgram(gl, vertex, fragment);
    const compiled: PointProgram = {
      program,
      position: gl.getAttribLocation(program, "a_pos"),
      color: gl.getUniformLocation(program, "u_color"),
      strokeColor: gl.getUniformLocation(program, "u_stroke_color"),
      pointSize: gl.getUniformLocation(program, "u_point_size"),
      innerRadius: gl.getUniformLocation(program, "u_inner_radius"),
      ...projectionUniforms(gl, program),
    };
    this.programs.set(input.shaderData.variantName, compiled);
    return compiled;
  }
}
