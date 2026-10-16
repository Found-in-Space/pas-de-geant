import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
const root = fileURLToPath(new URL('../', import.meta.url));
const html = `<!doctype html><meta charset="utf-8"><title>Geant static-host acceptance</title>
<style>body{margin:20px;background:#17212a;color:white;font:16px system-ui}main{display:flex;gap:20px}.world{width:480px;height:420px}input{position:absolute;top:0}</style>
<h1>Independent Earth and Moon</h1><main><div id="earth" class="world" data-geant-browser data-geant-bodies="earth"></div><div id="moon" class="world" data-geant-browser data-geant-bodies="moon" data-geant-location="18,-24"></div></main>
<script type="module">import {Geant} from '/embed/geant.js';
window.geantTest={Geant,earth:await Geant.whenReady(document.querySelector('#earth')),moon:await Geant.whenReady(document.querySelector('#moon'))};</script>`;
const mime = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://local').pathname;
  if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
  if (path === '/app/session-config.json') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ formatVersion: 1, providers: {}, bindings: {} })); return; }
  const kind = path.startsWith('/app/') ? 'pas-de-geant' : 'embed';
  const relative = path.startsWith('/app/') ? path.slice(5) || 'index.html' : path.slice('/embed/'.length);
  const directory = resolve(root, 'dist', kind); const file = resolve(directory, relative);
  if (!file.startsWith(directory + '/')) { response.writeHead(404).end(); return; }
  try { response.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream'); response.end(await readFile(file)); }
  catch { response.writeHead(404).end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const port = server.address().port;
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.GEANT_BROWSER_EXECUTABLE, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 600 } });
  const errors = [], requests = [], workers = new Set();
  page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message); });
  page.on('request', request => requests.push(request.url()));
  page.on('worker', worker => { workers.add(worker); worker.on('close', () => workers.delete(worker)); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.geantTest?.moon.worlds.get('moon').getReadiness().ready && window.geantTest.earth.worlds.get('earth').getReadiness().ready);
  console.log('Both reference surfaces are ready.');
  assert.deepEqual(await page.evaluate(() => [Array.from(geantTest.earth.worlds.keys()), Array.from(geantTest.moon.worlds.keys())]), [['earth'], ['moon']]);
  await page.evaluate(async () => { await geantTest.moon.actions.invoke('geant:scale.set', { scaleDenominator: 30000 }); });
  assert.deepEqual(await page.evaluate(() => [geantTest.earth.getSnapshot().scaleDenominator, geantTest.moon.getSnapshot().scaleDenominator]), [60000, 30000]);
  await page.evaluate(() => { document.querySelector('#moon').style.width = '360px'; });
  await page.waitForFunction(() => Math.abs(geantTest.moon.camera.aspect - 360 / 420) < 1e-6);
  const before = await page.evaluate(() => geantTest.moon.getSnapshot().locations.moon.longitudeDegrees);
  await page.focus('#moon .geant-browser'); await page.keyboard.down('KeyD'); await page.waitForTimeout(80); await page.keyboard.up('KeyD');
  assert.notEqual(await page.evaluate(() => geantTest.moon.getSnapshot().locations.moon.longitudeDegrees), before);
  console.log('Checking atomic surface replacement.');
  let replacementTimeout;
  try { await Promise.race([page.evaluate(async () => {
    const {moon} = geantTest; const old = moon.worlds.get('moon');
    try { await moon.setSurface('moon', async () => { throw new Error('source unavailable'); }); } catch {}
    if (moon.worlds.get('moon') !== old) throw new Error('Failed replacement retired the active world.');
    const texture = new moon.three.DataTexture(new Uint8Array([180, 180, 180, 255]), 1, 1); texture.needsUpdate = true;
    await moon.setSurface('moon', async () => ({ baseTexture: texture, disposeBaseTexture: true }));
    if (moon.worlds.get('moon') === old || old.object3d.parent) throw new Error('Replacement did not commit and retire the previous world.');
  }), new Promise((_, reject) => { replacementTimeout = setTimeout(() => reject(new Error('Surface replacement stalled.')), 10000); })]); } finally { clearTimeout(replacementTimeout); }
  console.log('Surface replacement committed.');
  await page.screenshot({ path: '/tmp/geant-independent-worlds.png' });
  await page.evaluate(async () => { await geantTest.Geant.unmount(document.querySelector('#earth')); });
  assert.equal(await page.locator('#earth canvas').count(), 0); assert.equal(await page.locator('#moon canvas').count(), 1);
  await page.evaluate(async () => {
    const {Geant} = geantTest; const host = document.createElement('div'); host.style.cssText='width:300px;height:200px'; document.body.append(host);
    host.dataset.geantBodies='moon'; host.dataset.geantFocusBody='earth';
    let failed=false; try { await Geant.mount(host); } catch { failed=true; }
    if (!failed || host.children.length) throw new Error('Failed startup leaked DOM.');
    delete host.dataset.geantFocusBody;
    const minimal = document.createElement('div'); minimal.dataset.geantBodies = 'moon'; document.body.append(minimal);
    const noOptions = await Geant.mount(minimal);
    if (noOptions.element.clientHeight < 400 || noOptions.camera.aspect <= 0) throw new Error('Unstyled declarative host has no usable default size.');
    await Geant.unmount(minimal); minimal.remove();
    const recovered = await Geant.mount(host); if (await Geant.mount(host) !== recovered) throw new Error('Duplicate startup.');
    await Geant.unmount(host);
    const pending = Geant.mount(host, { surfaces: { moon: ({signal}) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('cancelled','AbortError')), {once:true});
    }) } });
    await new Promise(resolve => setTimeout(resolve, 30)); await Geant.unmount(host); await pending.catch(() => {});
    if (host.children.length) throw new Error('Unmount during startup leaked DOM.'); host.remove();
    await Geant.unmount(document.querySelector('#moon'));
    // Borrowed GPU resources remain usable after an instance's teardown.
    const borrowed = new geantTest.moon.three.WebGLRenderer();
    const dispose = borrowed.dispose.bind(borrowed); let calls = 0; borrowed.dispose = () => { calls++; dispose(); };
    const borrowedHost = document.createElement('div'); borrowedHost.style.cssText = 'width:200px;height:200px'; document.body.append(borrowedHost);
    borrowedHost.dataset.geantBodies = 'moon';
    let updates = 0, renderHooks = 0;
    await Geant.mount(borrowedHost, { renderer: borrowed, compose: async viewer => {
      await viewer.install({ setup(context) { context.addPart({ update() { updates++; }, beforeRender() { renderHooks++; } }); } });
      return { frame() { viewer.render(); } };
    } });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!updates || !renderHooks) throw new Error('Authored composition skipped plugin lifecycle hooks.');
    await Geant.unmount(borrowedHost);
    if (calls) throw new Error('Viewer disposed a borrowed renderer.');
    borrowed.render(new geantTest.moon.three.Scene(), new geantTest.moon.three.PerspectiveCamera());
    borrowed.dispose(); borrowedHost.remove();
  });
  await page.waitForFunction(() => document.querySelectorAll('canvas').length === 0);
  if (workers.size) {
    let timeout;
    try { await Promise.race([Promise.all([...workers].map(worker => new Promise(resolve => worker.once('close', resolve)))),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Owned workers survived teardown.')), 5000); })]); }
    finally { clearTimeout(timeout); }
  }
  assert.equal(requests.some(url => /api\/|stars\.octree|spatial-star-pass-|\/ai-/.test(url)), false, 'Disabled capabilities performed acquisition.');
  assert.deepEqual(errors, []);
  // The authored Moon launch also succeeds with no Earth provider configuration.
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${port}/app/?world=moon&debug=1`);
  await page.waitForFunction(() => document.querySelector('#world-check')?.dataset.state === 'ready');
  await page.waitForFunction(() => window.pasDeGeantDebug?.snapshot().frame.sampleCount >= 3);
  assert.deepEqual(errors, []);
  console.log('Static embed: independent worlds, actions, focus, resize, replacement, failure/retry, teardown and disabled acquisition passed.');
  console.log('Authored Moon application starts with empty provider bindings. Screenshot: /tmp/geant-independent-worlds.png');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
