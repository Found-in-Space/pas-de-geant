import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { openSync, closeSync, readFileSync } from 'node:fs';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
async function exec(command, args, options) {
  const output = join(directory, 'command-output.txt'), fd = openSync(output, 'w');
  try { execFileSync(command, args, { ...options, stdio: ['ignore', fd, fd] }); }
  catch (error) { process.stderr.write(readFileSync(output, 'utf8')); throw error; }
  finally { closeSync(fd); }
  return { stdout: readFileSync(output, 'utf8') };
}
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'geant-packed-'));
const offline = process.argv.includes('--offline') ? ['--offline'] : [];
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const threeTypes = lock.packages['node_modules/@types/three'].version;
try {
  await exec('npm', ['pack', '--workspace', '@found-in-space/pas-de-geant', '--pack-destination', directory], { cwd: root });
  const archives = (await readdir(directory)).filter(name => name.endsWith('.tgz'));
  assert.equal(archives.length, 1, 'Packing must produce one Geant archive.');
  const [filename] = archives;
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'geant-external-consumer', private: true, type: 'module',
    dependencies: { '@found-in-space/pas-de-geant': `file:${join(directory, filename)}`, three: '0.170.0',
      '@found-in-space/guided-journey': `file:${join(root, '.packages/guided-journey.tgz')}`,
      '@found-in-space/touch-os': `file:${join(root, '.packages/touch-os.tgz')}`, '@pmndrs/pointer-events': '6.6.32' },
    devDependencies: { '@types/three': threeTypes } }));
  await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...offline], { cwd: directory });
  const library = join(directory, 'node_modules/@found-in-space/pas-de-geant');
  const manifest = JSON.parse(await readFile(join(library, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.exports).sort(), ['.', './worlds', './worlds/skykit', './browser', './embed', './ai', './stars', './sky-image', './appearances', './journey'].sort());
  for (const entry of Object.values(manifest.exports)) { await access(join(library, entry.default)); await access(join(library, entry.types)); }
  for (const name of ['assets/bluemarble-2048.png', 'assets/lroc-color-2k.jpg',
    'worlds/tile-scheduler.worker.js', 'worlds/imagery-decoder.worker.js']) await access(join(library, 'dist', name));
  assert.ok((await readdir(library, { recursive: true })).every(path => !/deep-star-map.*\.(?:webp|json)$/.test(path)),
    'The separately published sky texture and metadata must not be packed.');
  await writeFile(join(directory, 'check.mjs'), `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as THREE from 'three';
import { createGeantViewer, createGeantWorldsPlugin, createGeantMovementPlugin, createGeantSurfaceMovementModel, createGeantBodyAppearancePlugin, GEANT_ACTIONS } from '@found-in-space/pas-de-geant';
import { createGeantBrowser } from '@found-in-space/pas-de-geant/browser';
import { mount } from '@found-in-space/pas-de-geant/embed';
import { createWorldSkykitPlugin } from '@found-in-space/pas-de-geant/worlds/skykit';
import { celestialBody, assessSurfaceReadiness } from '@found-in-space/pas-de-geant/worlds';
import { createGeantSkyImagePlugin } from '@found-in-space/pas-de-geant/sky-image';
import { createSunAppearance } from '@found-in-space/pas-de-geant/appearances';
import { createGeantJourneyDriver, createGeantTrackingSequence, createGeantSequenceParticipant,
  createGeantSequencePlugin, geantBodyFixedSpace, waitForGeantSurface, GeantSurfaceReadinessError } from '@found-in-space/pas-de-geant/journey';
import { exerciseJourneyDriver } from '@found-in-space/guided-journey/testing';
import { createJourneySequencePlayer } from '@found-in-space/guided-journey/sequence';
const require = createRequire(import.meta.url);
const geant = createRequire(require.resolve('@found-in-space/pas-de-geant'));
assert.equal(geant.resolve('three'), require.resolve('three'));
for (const name of ['skykit', 'star-trees', 'star-octree-provider', 'three-star-field', 'hr-diagram', 'meta-sidecar-provider']) {
  assert.throws(() => require.resolve('@found-in-space/' + name), { code: 'MODULE_NOT_FOUND' }, name + ' was installed by default');
}
assert.throws(() => require.resolve('@found-in-space/pas-de-geant/worlds/terrain-surface'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
assert.equal(celestialBody('moon').id, 'moon');
const renderer = { render() {}, clearDepth() {}, xr: { isPresenting: false }, getDrawingBufferSize(target) { return target.set(640, 480); } };
const viewer = await createGeantViewer({ renderer, bodies: ['moon'] });
assert.ok(viewer.scene instanceof THREE.Scene);
await viewer.install(createGeantWorldsPlugin());
const movement = createGeantMovementPlugin({ model: createGeantSurfaceMovementModel() });
await viewer.install(movement);
viewer.viewer.frame(0);
const surface = viewer.worlds.get('moon').getSurfaceReadiness();
assert.equal(assessSurfaceReadiness(surface, []).status, 'ready');
assert.equal(assessSurfaceReadiness(surface, ['terrain']).status, 'degraded');
const partCount = viewer.viewer.getSnapshot().partCount;
await assert.rejects(waitForGeantSurface({ browser: viewer, body: 'moon', required: ['imagery'],
  signal: new AbortController().signal, onDegraded: 'fail' }), GeantSurfaceReadinessError);
assert.equal(viewer.viewer.getSnapshot().partCount, partCount);
const driver = createGeantJourneyDriver({ browser: { ...viewer, movement } });
await exerciseJourneyDriver({ driver, scenes: [0, 20, -35].map(latitudeDegrees => ({ readiness: 'none',
  camera: { kind: 'surface', body: 'moon', latitudeDegrees, longitudeDegrees: 25,
    altitudeM: 1e6, altitudeReference: 'reference', scaleDenominator: 1e6 } })),
  async advance() { for (let i = 0; i < 30; i++) await Promise.resolve();
    viewer.frame(0); viewer.frame(.2); viewer.frame(0);
    for (let i = 0; i < 30; i++) await Promise.resolve(); },
});
const sequence = createGeantTrackingSequence({ sequence: { durationSecs: 1, evaluate: timeSecs => ({ body: 'moon',
  space: geantBodyFixedSpace('moon'), position: { x: 1747400, y: 0, z: -1000 * timeSecs }, velocityMPerSec: { x: 0, y: 0, z: -1000 } }) },
  shot: { up: 'radial', heading: { kind: 'reference', forward: { x: 0, y: 0, z: -1 } },
    offset: { rightM: 100, upM: 300, behindM: 600 }, lookAheadSecs: 0, scaleDenominator: 100000 } });
const participant = createGeantSequenceParticipant({ browser: { ...viewer, movement }, navigation: driver.navigation, durationSecs: 0 });
const player = createJourneySequencePlayer({ sequence, participant });
let presented;
const removeSequence = await viewer.install(createGeantSequencePlugin({ player, onFrame: sample => { presented = sample; } }));
const joined = player.join(); viewer.frame(0); await joined.finished;
const ended = player.play(); viewer.frame(1); await ended.finished;
assert.equal(player.getSnapshot().frame.timeSecs, 1);
assert.equal(presented, player.getSnapshot().frame);
const body = viewer.worlds.get('moon').object3d;
const eye = viewer.camera.getWorldPosition(new THREE.Vector3()).applyMatrix4(body.matrixWorld.clone().invert()).multiplyScalar(celestialBody('moon').referenceRadiusM);
assert(eye.distanceTo(new THREE.Vector3().copy(presented.value.camera.pose.position)) < .002);
await removeSequence(); player.dispose(); participant.dispose(); driver.dispose();
const result = await viewer.actions.invoke(GEANT_ACTIONS.setScale, { scaleDenominator: 50 });
assert.equal(result[0].status, 'fulfilled');
assert.equal(viewer.getSnapshot().scaleDenominator, 50);
const texture = new THREE.Texture();
const removeSky = await viewer.install(createGeantSkyImagePlugin({ texture }));
viewer.render(); await removeSky();
const sun = createGeantBodyAppearancePlugin({ body: celestialBody('sun'), appearance: createSunAppearance });
const removeSun = await viewer.install(sun); viewer.frame(0); await removeSun();
await viewer.dispose();
console.log('Packed core and image lifecycle passed with no SkyKit aggregate or star packages installed.');
`);
  const result = await exec(process.execPath, ['check.mjs'], { cwd: directory });
  process.stdout.write(result.stdout);
  await writeFile(join(directory, 'image-consumer.ts'), `import { createGeantViewer, createGeantBodyAppearancePlugin, type BodyAppearanceFactory } from '@found-in-space/pas-de-geant';\nimport { createSunAppearance } from '@found-in-space/pas-de-geant/appearances';\nimport { celestialBody } from '@found-in-space/pas-de-geant/worlds';\nimport { createGeantSkyImagePlugin } from '@found-in-space/pas-de-geant/sky-image';\nconst factory: BodyAppearanceFactory = createSunAppearance;\nconst plugin = createGeantSkyImagePlugin();\nconst sun = createGeantBodyAppearancePlugin({ body: celestialBody('sun'), appearance: factory });\nconst start = (renderer: import('three').WebGLRenderer) => createGeantViewer({ renderer, plugins: [plugin, sun] });\n`);
  // The pinned spatial alpha has a duplicate declaration; keep the existing
  // consumer skipLibCheck policy, and separately verify Geant's declarations
  // have no back-reference to the optional aggregate SkyKit package.
  for (const path of await readdir(join(library, 'dist'), { recursive: true })) {
    if (path.endsWith('.d.ts')) assert.doesNotMatch(await readFile(join(library, 'dist', path), 'utf8'), /["']@found-in-space\/skykit(?:["'])/);
  }
  await exec(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--skipLibCheck', '--strict', '--module', 'NodeNext', '--target', 'ES2022', 'image-consumer.ts'], { cwd: directory });
  await writeFile(join(directory, 'readiness-consumer.ts'), `import type {GeantViewer} from '@found-in-space/pas-de-geant';
import {assessSurfaceReadiness, type SurfaceLayer} from '@found-in-space/pas-de-geant/worlds';
import {waitForGeantSurface} from '@found-in-space/pas-de-geant/journey';
declare const browser: GeantViewer;
const required: SurfaceLayer[] = ['imagery', 'terrain', 'nightImagery'];
const assessment = assessSurfaceReadiness(browser.worlds.get('moon')!.getSurfaceReadiness(), required);
void waitForGeantSurface({browser, body: 'moon', required, onDegraded: 'continue', signal: new AbortController().signal,
  onProgress(result) { const currentHeight: number = result.readiness.view.observerHeightWorldM; }});
`);
  await exec(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--skipLibCheck', '--strict', '--module', 'NodeNext', '--target', 'ES2022', 'readiness-consumer.ts'], { cwd: directory });
  await exec('npm', ['install', '@found-in-space/star-octree-provider@0.3.0-alpha.0',
    '@found-in-space/star-trees@0.2.1-alpha.0', `file:${join(root, '.packages/three-star-field.tgz')}`,
    '--ignore-scripts', '--no-audit', '--no-fund', ...offline], { cwd: directory });
  await exec(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createGeantStarPass } from '@found-in-space/pas-de-geant/stars';
    let disposed = false;
    const session = { subscribe() { return () => {}; }, dispose() { disposed = true; } };
    const pass = await createGeantStarPass({ provider: { createSession() { return session; } } });
    await pass.dispose(); assert.ok(disposed);
  `], { cwd: directory });
  console.log('Packed catalog plugin imports and disposes with explicitly installed star peers.');
  // Optional VoiceOS is not needed to import core, worlds, browser or embed.
  await exec('npm', ['install', `file:${join(root, '.packages/voice-os.tgz')}`, '--ignore-scripts', '--no-audit', '--no-fund', ...offline], { cwd: directory });
  await writeFile(join(directory, 'consumer.ts'), `import { createGeantViewer, createGeantPanelPlugin } from '@found-in-space/pas-de-geant';\nimport { createGeantBrowser } from '@found-in-space/pas-de-geant/browser';\nimport { createGeantAiPlugin } from '@found-in-space/pas-de-geant/ai';\nimport { Geant } from '@found-in-space/pas-de-geant/embed';\nconst start = () => createGeantBrowser({ host: document.createElement('div'), bodies: ['moon'], controls: { pointer: 'grab' } });\n`);
  await exec(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--skipLibCheck', '--strict', '--module', 'NodeNext', '--target', 'ES2022', 'consumer.ts'], { cwd: directory });
  const ai = await exec(process.execPath, ['--input-type=module', '-e', "await import('@found-in-space/pas-de-geant/ai'); console.log('Packed optional AI and external TypeScript consumer passed.');"], { cwd: directory });
  process.stdout.write(ai.stdout);
  await exec('npm', ['ls', '--all'], { cwd: directory });
  console.log('Packed consumer exports, shared Three.js, lifecycle, optional VoiceOS and TypeScript checks passed.');
} finally { await rm(directory, { recursive: true, force: true }); }
