import assert from 'node:assert/strict';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSpatialPose, transformSpatialDisplacement, SPATIAL_Z_UP_TO_Y_UP } from '@found-in-space/spatial';
import { createSkykitStarPreloadRequestsFromSpatialHints, SKYKIT_ICRS_SPACE } from '@found-in-space/skykit';
import { relativeJ2000MetresToRender, WORLD_J2000_METRES, WORLD_Y_UP_METRES } from '@found-in-space/pas-de-geant/worlds';

const root = fileURLToPath(new URL('../', import.meta.url));
const worlds = join(root, 'packages/pas-de-geant');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const manifest = await json(join(root, 'package.json'));
const worldsManifest = await json(join(worlds, 'package.json'));
const lock = await json(join(root, 'package-lock.json'));
const fromWorlds = createRequire(join(worlds, 'package.json'));
const skykitEntry = fromWorlds.resolve('@found-in-space/skykit');
const fromSkykit = createRequire(skykitEntry);
const skykitManifest = await json(join(dirname(dirname(skykitEntry)), 'package.json'));

for (const name of ['@found-in-space/skykit', '@found-in-space/spatial',
  '@found-in-space/star-octree-provider', '@found-in-space/star-trees', '@found-in-space/three-star-field']) {
  const expected = worldsManifest.dependencies[name];
  assert.match(expected, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `${name} must use an exact registry version.`);
  const entry = fromWorlds.resolve(name);
  const installedRoot = dirname(dirname(entry));
  assert.equal((await lstat(installedRoot)).isSymbolicLink(), false);
  assert.ok((await realpath(installedRoot)).startsWith((await realpath(root)) + sep));
  const installed = await json(join(installedRoot, 'package.json'));
  assert.equal(installed.name, name);
  assert.equal(installed.version, expected);
  const locked = lock.packages[relative(root, installedRoot).split(sep).join('/')];
  assert.equal(locked.version, expected);
  assert.ok(locked.resolved.startsWith('https://registry.npmjs.org/'));
  assert.ok(locked.integrity.startsWith('sha512-'));
  if (name !== '@found-in-space/skykit') {
    assert.equal(skykitManifest.dependencies[name], expected);
    assert.equal(fromSkykit.resolve(name), entry, `${name} must be shared with SkyKit.`);
  }
}

const spatialVersion = worldsManifest.dependencies['@found-in-space/spatial'];
const fromRoot = createRequire(join(root, 'package.json'));
assert.equal(manifest.devDependencies['@found-in-space/spatial'], spatialVersion);
assert.equal(manifest.devDependencies['@found-in-space/skykit'], worldsManifest.dependencies['@found-in-space/skykit']);
assert.equal(fromRoot.resolve('@found-in-space/skykit'), skykitEntry);
assert.equal(fromRoot.resolve('@found-in-space/spatial'), fromWorlds.resolve('@found-in-space/spatial'));

const pose = normalizeSpatialPose({ space: WORLD_J2000_METRES, position: { x: 12.5, y: -3.25, z: 8 } });
const axes = transformSpatialDisplacement({ from: pose.space, to: WORLD_Y_UP_METRES,
  rotation: SPATIAL_Z_UP_TO_Y_UP }, pose.position);
const rendered = relativeJ2000MetresToRender(pose.position, 10);
for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(rendered[axis] - axes[axis] / 10) < 1e-12);

const [preload] = createSkykitStarPreloadRequestsFromSpatialHints([{
  space: { frameId: SKYKIT_ICRS_SPACE.frameId, metersPerUnit: 1 },
  kind: 'sphereVolume', center: { x: 0, y: 0, z: 0 }, radius: SKYKIT_ICRS_SPACE.metersPerUnit,
}]);
const evaluator = preload.strategy.createEvaluator(preload.strategy.createAnchor({}));
const cell = { centerX: 0.5, centerY: 0, centerZ: 0, halfSize: 0, level: 0, mortonCode: '0' };
assert.equal(evaluator.evaluateCell(cell).include, true);
assert.equal(evaluator.evaluateCell({ ...cell, centerX: 2 }).include, false);
console.log(`Registry SkyKit ${worldsManifest.dependencies['@found-in-space/skykit']} and shared spatial ${spatialVersion} verified in Geant.`);
