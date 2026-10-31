import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { IMAGERY_FRAGMENT_DECLARATIONS } from '../packages/pas-de-geant/dist/worlds/imagery.js';
import { buildDesiredImageryTree, encodeImageryTree } from '../packages/pas-de-geant/dist/worlds/imagery-tree.js';

// Execute the production lookup shader. CPU assertions compare the returned
// source coordinates with the geographic point, without duplicating traversal.
const fixtures = [];
function fixture(name, leaves, sourceFor, samples) {
  const sources = new Map();
  const desired = buildDesiredImageryTree(leaves, tile => {
    const source = sourceFor(tile), key = `${source.z}/${source.x}/${source.y}`;
    if (!sources.has(key)) sources.set(key, {layer: sources.size, sourceTile: source, poolGeneration: 1, revision: 1});
    return {image: key, fallbackFromNotFound: false};
  });
  const encoding = encodeImageryTree(desired, 1, key => sources.get(key));
  assert(encoding);
  fixtures.push({name, nodeData: [...encoding.nodeData], imageData: [...encoding.imageData],
    depth: encoding.maximumDepth, sources: [...sources.values()].map(row => row.sourceTile), samples});
}
const grid = z => Array.from({length: 4 ** z}, (_, i) => ({z, x: i % (2 ** z), y: Math.floor(i / (2 ** z))}));
const nearEdge = [0, 2 ** -24, .5, 1 - 2 ** -24, 1];
const samples = (origin, scale) => nearEdge.flatMap(u => nearEdge.map(v => ({origin, scale, uv: [u, v]})));
fixture('finer imagery across a terrain tile south edge', grid(5), tile => tile,
  samples([4 / 16, 8 / 16], [1 / 16, 1 / 16]));
fixture('coarser imagery and the south world edge', grid(2), tile => ({z: 1, x: tile.x >> 1, y: tile.y >> 1}),
  samples([3 / 4, 3 / 4], [1 / 4, 1 / 4]));
fixture('root image and both world edges', [{z: 0, x: 0, y: 0}], tile => tile,
  samples([0, 0], [1, 1]));
const z = 22, x = 1234567, y = 2345678, width = 2 ** z;
const neighbours = [-1, 0, 1].flatMap(dy => [-1, 0, 1].map(dx => ({z, x: x + dx, y: y + dy})));
function coveringCut(targets) {
  const leaves = [];
  function visit(tile) {
    const descendants = targets.filter(target => target.z > tile.z
      && Math.floor(target.x / (2 ** (target.z - tile.z))) === tile.x
      && Math.floor(target.y / (2 ** (target.z - tile.z))) === tile.y);
    if (!descendants.length) {leaves.push(tile); return;}
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) visit({z: tile.z + 1, x: tile.x * 2 + x, y: tile.y * 2 + y});
  }
  visit({z: 0, x: 0, y: 0}); return leaves;
}
fixture('high zoom preserves local precision', coveringCut(neighbours), tile => tile,
  samples([x / width, y / width], [1 / width, 1 / width]));
fixture('longitude wrap at high zoom', coveringCut([-1, 0, 1].flatMap(dy => [width - 1, 0].map(x => ({z, x, y: y + dy})))), tile => tile,
  samples([(width - 1) / width, y / width], [1 / width, 1 / width]));

const browser = await chromium.launch({headless: true, executablePath: process.env.GEANT_BROWSER_EXECUTABLE,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage']});
try {
  const page = await browser.newPage();
  const rows = await page.evaluate(({declarations, fixtures}) => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) throw new Error('WebGL2 float render targets are required.');
    function shader(type, source) {
      const value = gl.createShader(type); gl.shaderSource(value, source); gl.compileShader(value);
      if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value));
      return value;
    }
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, `#version 300 es
      precision highp float;
      uniform vec2 sampleUv;
      out vec2 vBlueMarbleUv; out vec2 vImageryUv;
      void main() {
        vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
        gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
        vImageryUv = sampleUv; vBlueMarbleUv = sampleUv;
      }`));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float; precision highp int;
      ${declarations}
      out vec4 colour;
      void main() {
        float layer; vec2 uv; vec2 dx; vec2 dy;
        bool found = resolvedImageryLeaf(layer, uv, dx, dy);
        colour = found ? vec4(uv, layer, 1.0) : vec4(-1.0);
      }`));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const target = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, null);
    const framebuffer = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete float framebuffer');
    gl.viewport(0, 0, 1, 1);
    function texture(values, channels, unit, uniform) {
      const texture = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, channels === 2 ? gl.RG32UI : gl.RGBA32UI, values.length / channels, 1, 0,
        channels === 2 ? gl.RG_INTEGER : gl.RGBA_INTEGER, gl.UNSIGNED_INT, new Uint32Array(values));
      gl.uniform1i(gl.getUniformLocation(program, uniform), unit);
      return texture;
    }
    const rows = [];
    for (const fixture of fixtures) {
      const nodes = texture(fixture.nodeData, 2, 0, 'imageryTree');
      const images = texture(fixture.imageData, 4, 1, 'imageryImages');
      gl.uniform1i(gl.getUniformLocation(program, 'imageryTreeTextureWidth'), fixture.nodeData.length / 2);
      gl.uniform1i(gl.getUniformLocation(program, 'imageryImageTextureWidth'), fixture.imageData.length / 4);
      gl.uniform1i(gl.getUniformLocation(program, 'imageryTreeDepth'), fixture.depth);
      for (const sample of fixture.samples) {
        gl.uniform2fv(gl.getUniformLocation(program, 'sampleUv'), sample.uv);
        gl.uniform4fv(gl.getUniformLocation(program, 'imageryGlobalOriginScale'), [...sample.origin, ...sample.scale]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const pixel = new Float32Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, pixel);
        rows.push({name: fixture.name, sample, source: fixture.sources[pixel[2]], pixel: [...pixel]});
      }
      gl.deleteTexture(nodes); gl.deleteTexture(images);
    }
    if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL error in imagery lookup check');
    return rows;
  }, {declarations: IMAGERY_FRAGMENT_DECLARATIONS, fixtures});
  const failures = [];
  for (const row of rows) {
    if (row.pixel[3] !== 1 || !row.source) {failures.push({...row, reason: 'No source at a covered point'}); continue;}
    const width = 2 ** row.source.z;
    const expected = row.sample.origin.map((origin, i) => (origin + row.sample.uv[i] * row.sample.scale[i]) * width - (i ? row.source.y : row.source.x));
    // Longitude is periodic. Latitude is not: the bottom edge must stay at v=1.
    if (expected[0] < -1e-6) expected[0] += width;
    else if (expected[0] > 1 + 1e-6) expected[0] -= width;
    const xError = Math.abs(expected[0] - row.pixel[0]);
    const periodicXError = Math.min(xError, Math.abs(xError - width));
    const outsideSource = row.pixel.slice(0, 2).some(value => value < -(2 ** -19) || value > 1 + 2 ** -19);
    if (outsideSource || periodicXError > 2 ** -19 || Math.abs(expected[1] - row.pixel[1]) > 2 ** -19) failures.push({...row, expected});
  }
  assert.deepEqual(failures, [], 'GPU source UV must refer to the selected image at the requested geographic point.');
  console.log(`${rows.length} GPU imagery-edge checks passed: fine/coarse sources, world edges and zoom-22 local precision.`);
} finally {await browser.close();}
