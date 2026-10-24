import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createGeantViewer, createGeantPanelPlugin, GEANT_ACTIONS } from '@found-in-space/pas-de-geant';
import { createSlider, createButton } from '@found-in-space/touch-os';
import { createThreeUIEnvironment } from '@found-in-space/touch-os/hosts/three';

const renderer = { render() {}, xr: { isPresenting: false, getSession: () => null } };
let viewer = await createGeantViewer({ renderer, scaleDenominator: 1000 });
let ui = createThreeUIEnvironment({ parent: viewer.scene });
function canvas(metrics) {
  const context = new Proxy({ measureText: text => ({ width: text.length * 8 }) }, { get: (object, key) => object[key] ?? (() => {}) });
  return { width: metrics.width, height: metrics.height, getContext: () => context };
}
const placement = { panelWidth: 1, panelHeight: 0.5, createCanvas: canvas };
let runtime;
await viewer.install(createGeantPanelPlugin({ id: 'settings', environment: ui, surface: { width: 200, height: 100 }, placement,
  root: snapshot => createSlider('scale', { label: 'Scale', field: 'scale', value: snapshot.scaleDenominator, min: 1000, max: 10000 }),
  initialize: value => { runtime = value; },
  action: output => output.type === 'change-request' && output.phase === 'update' ? { id: GEANT_ACTIONS.setScale, payload: { scaleDenominator: output.value } } : null
}));
ui.update({ timestamp: 0 });
const track = runtime.render().commands.find(command => command.role === 'slider-track');
const source = { id: 'right', tracked: true, pointerType: 'controller', space: 'world-metres',
  ray: { origin: { x: track.rect.x / 200 - 0.5, y: 0.25 - (track.rect.y + track.rect.height / 2) / 200, z: 2 }, direction: { x: 0, y: 0, z: -1 } } };
function send(timestamp, phase) { ui.update({ timestamp, sources: [source], edges: phase ? [{ timestamp, phase, source }] : [] }); }
send(1, 'begin'); source.ray.origin.x = 1; send(2); send(3, 'complete'); await Promise.resolve();
assert.equal(viewer.navigation.scaleDenominator, 10000);
assert.equal(ui.interaction.getSnapshot('right').capture, undefined);
// Plugin-registered resources belong to the viewer's lifetime.
await viewer.dispose(); ui.dispose();
viewer = await createGeantViewer({ renderer, scaleDenominator: 10000 });
ui = createThreeUIEnvironment({ parent: viewer.scene });
await viewer.install(createGeantPanelPlugin({ id: 'button', environment: ui, surface: { width: 200, height: 100 }, placement,
  root: () => createButton('reset', { label: 'Reset', actionId: GEANT_ACTIONS.setScale, payload: { scaleDenominator: 2000 } }),
  action: output => output.type === 'action' ? { id: output.actionId, payload: output.payload } : null
}));
source.ray.origin.x = source.ray.origin.y = 0;
send(4, 'begin');
const modal = ui.mountPanel({ id: 'modal', mode: 'overlay', placement, content: createButton('close', { label: 'Close', actionId: 'close' }) });
send(5, 'complete'); await Promise.resolve(); assert.equal(viewer.navigation.scaleDenominator, 10000);
modal.hide();
const wall = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicMaterial()); wall.position.z = 1; viewer.scene.add(wall);
send(6, 'begin'); send(7, 'complete'); await Promise.resolve(); assert.equal(viewer.navigation.scaleDenominator, 10000);
wall.visible = false; send(8, 'begin'); send(9, 'complete'); await Promise.resolve(); assert.equal(viewer.navigation.scaleDenominator, 2000);
await viewer.dispose(); ui.dispose(); wall.geometry.dispose(); wall.material.dispose();
console.log('Packed Geant: continuous scale edit, blocked release, scene occlusion, recovery and disposal passed.');
