import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'geant-packed-'));
const offline = process.argv.includes('--offline') ? ['--offline'] : [];
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const threeTypes = lock.packages['node_modules/@types/three'].resolved;
try {
  await exec('npm', ['pack', '--workspace', '@found-in-space/pas-de-geant', '--pack-destination', directory], { cwd: root });
  const archives = (await readdir(directory)).filter(name => name.endsWith('.tgz'));
  assert.equal(archives.length, 1, 'Packing must produce one Geant archive.');
  const [filename] = archives;
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'geant-external-consumer', private: true, type: 'module',
    dependencies: { '@found-in-space/pas-de-geant': `file:${join(directory, filename)}`, three: '0.170.0' },
    devDependencies: { '@types/three': threeTypes } }));
  await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...offline], { cwd: directory });
  const library = join(directory, 'node_modules/@found-in-space/pas-de-geant');
  const manifest = JSON.parse(await readFile(join(library, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.exports).sort(), ['.', './worlds', './worlds/skykit', './browser', './embed', './ai'].sort());
  for (const entry of Object.values(manifest.exports)) { await access(join(library, entry.default)); await access(join(library, entry.types)); }
  for (const name of ['assets/bluemarble-2048.png', 'assets/lroc-color-2k.jpg', 'worlds/tile-scheduler.worker.js', 'worlds/imagery-decoder.worker.js']) await access(join(library, 'dist', name));
  await writeFile(join(directory, 'check.mjs'), `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as THREE from 'three';
import { createGeantViewer, createGeantWorldsPlugin, createGeantMovementPlugin, createGeantSurfaceMovementModel, GEANT_ACTIONS } from '@found-in-space/pas-de-geant';
import { createGeantBrowser } from '@found-in-space/pas-de-geant/browser';
import { mount } from '@found-in-space/pas-de-geant/embed';
import { createWorldSkykitPlugin } from '@found-in-space/pas-de-geant/worlds/skykit';
import { celestialBody } from '@found-in-space/pas-de-geant/worlds';
const require = createRequire(import.meta.url);
const geant = createRequire(require.resolve('@found-in-space/pas-de-geant'));
const skykit = createRequire(require.resolve('@found-in-space/skykit'));
assert.equal(geant.resolve('three'), require.resolve('three'));
assert.equal(skykit.resolve('three'), require.resolve('three'));
assert.throws(() => require.resolve('@found-in-space/pas-de-geant/worlds/terrain-surface'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
assert.equal(celestialBody('moon').id, 'moon');
const renderer = { render() {}, xr: { isPresenting: false }, getDrawingBufferSize(target) { return target.set(640, 480); } };
const viewer = await createGeantViewer({ renderer, bodies: ['moon'] });
assert.ok(viewer.scene instanceof THREE.Scene);
await viewer.install(createGeantWorldsPlugin());
await viewer.install(createGeantMovementPlugin({ model: createGeantSurfaceMovementModel() }));
viewer.viewer.frame(0);
const result = await viewer.actions.invoke(GEANT_ACTIONS.setScale, { scaleDenominator: 50 });
assert.equal(result[0].status, 'fulfilled');
assert.equal(viewer.getSnapshot().scaleDenominator, 50);
await viewer.dispose();
console.log('Packed ESM exports, public lifecycle and one shared Three.js 0.170.0 passed.');
`);
  const result = await exec(process.execPath, ['check.mjs'], { cwd: directory });
  process.stdout.write(result.stdout);
  // Optional VoiceOS is not needed to import core, worlds, browser or embed.
  await exec('npm', ['install', '@found-in-space/voice-os@0.1.0-alpha.1', '--ignore-scripts', '--no-audit', '--no-fund', ...offline], { cwd: directory });
  await writeFile(join(directory, 'consumer.ts'), `import { createGeantViewer, createGeantPanelPlugin } from '@found-in-space/pas-de-geant';\nimport { createGeantBrowser } from '@found-in-space/pas-de-geant/browser';\nimport { createGeantAiPlugin } from '@found-in-space/pas-de-geant/ai';\nimport { Geant } from '@found-in-space/pas-de-geant/embed';\nconst start = () => createGeantBrowser({ host: document.createElement('div'), bodies: ['moon'], controls: { pointer: 'grab' } });\n`);
  await exec(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--skipLibCheck', '--strict', '--module', 'NodeNext', '--target', 'ES2022', 'consumer.ts'], { cwd: directory });
  const ai = await exec(process.execPath, ['--input-type=module', '-e', "await import('@found-in-space/pas-de-geant/ai'); console.log('Packed optional AI and external TypeScript consumer passed.');"], { cwd: directory });
  process.stdout.write(ai.stdout);
  console.log('Packed consumer exports, shared Three.js, lifecycle, optional VoiceOS and TypeScript checks passed.');
} finally { await rm(directory, { recursive: true, force: true }); }
