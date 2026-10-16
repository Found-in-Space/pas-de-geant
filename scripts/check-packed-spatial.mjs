import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSpatialPose, transformSpatialDisplacement, SPATIAL_Z_UP_TO_Y_UP } from '@found-in-space/spatial';
import { relativeJ2000MetresToRender, WORLD_J2000_METRES, WORLD_Y_UP_METRES } from '@found-in-space/worlds/world-navigation';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = join(root, 'apps/pas-de-geant');
const manifest = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
const dependency = manifest.dependencies['@found-in-space/spatial'];
assert.ok(dependency.startsWith('file:'), 'This check validates the local packed alpha.');
const archive = resolve(app, dependency.slice(5));
const payload = await readFile(archive);
const sha256 = createHash('sha256').update(payload).digest('hex');
assert.ok(archive.endsWith(`-${sha256.slice(0, 12)}.tgz`), 'Archive identity must match its content.');

const requireFromApp = createRequire(join(app, 'package.json'));
const entry = requireFromApp.resolve('@found-in-space/spatial');
const installedRoot = dirname(dirname(entry));
assert.equal((await lstat(installedRoot)).isSymbolicLink(), false);
assert.ok((await realpath(installedRoot)).startsWith((await realpath(root)) + sep));
const installed = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const locked = lock.packages['node_modules/@found-in-space/spatial'];
assert.equal(locked.version, installed.version);
assert.equal(locked.integrity, 'sha512-' + createHash('sha512').update(payload).digest('base64'));

// The released SkyKit runtime must resolve its own compatible dependency.
const oldEntry = createRequire(requireFromApp.resolve('@found-in-space/skykit')).resolve('@found-in-space/spatial');
const oldManifest = JSON.parse(await readFile(join(dirname(dirname(oldEntry)), 'package.json'), 'utf8'));
assert.equal(oldManifest.version, '0.2.0');
assert.notEqual(installed.version, oldManifest.version);

const pose = normalizeSpatialPose({ space: WORLD_J2000_METRES, position: { x: 12.5, y: -3.25, z: 8 } });
const axes = transformSpatialDisplacement({ from: pose.space, to: WORLD_Y_UP_METRES,
  rotation: SPATIAL_Z_UP_TO_Y_UP }, pose.position);
const rendered = relativeJ2000MetresToRender(pose.position, 10);
for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(rendered[axis] - axes[axis] / 10) < 1e-12);
console.log(`Packed spatial ${installed.version} verified in Geant; SHA-256 ${sha256}`);
