import { afterEach, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector2, Vector3 } from 'three';
import { createGeantViewer, createGeantWorldsPlugin, createGeantMovementPlugin,
  createGeantDesktopMovementModel, GEANT_MOTION_ACTIONS, type GeantViewer } from '@found-in-space/pas-de-geant';
import { celestialBody, createBodySurfaceModel, translatedObserverJ2000M } from '@found-in-space/pas-de-geant/worlds';

const viewers:GeantViewer[]=[];
afterEach(async()=>{for(const viewer of viewers.splice(0))await viewer.dispose();});
const up=new Vector3(.4,.3,.8).normalize();
const direction=new Vector3(-.3,.8,-.4).normalize();
const orientation=()=>new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(new Vector3(),direction,up));
async function fixture(roll=0){
  const viewer=await createGeantViewer({renderer:{xr:{isPresenting:false},render(){},getDrawingBufferSize:(v:Vector2)=>v.set(800,600)} as never,
    bodies:['moon'],focusBody:'moon',mode:'free',scaleDenominator:1000,time:'1969-07-20T20:17:40Z',timeRate:0});
  viewers.push(viewer);await viewer.install(createGeantWorldsPlugin());
  viewer.camera.quaternion.copy(orientation()).multiply(new Quaternion().setFromAxisAngle(new Vector3(0,0,1),roll));
  await viewer.install(createGeantMovementPlugin({model:createGeantDesktopMovementModel({freeUp:()=>up}),
    surface:id=>({body:celestialBody(id),geometry:createBodySurfaceModel(celestialBody(id)),sampleElevationMetres:()=>0})}));
  viewer.update(.1);
  return {viewer,async command(payload:Record<string,number>,action:string=GEANT_MOTION_ACTIONS.look){
    const results=await viewer.actions.invoke(action,payload);
    for(const result of results)if(result.status==='rejected')throw result.reason;
    viewer.update(.1);
  }};
}
const forward=(viewer:GeantViewer)=>new Vector3(0,0,-1).applyQuaternion(viewer.camera.quaternion);
function level(viewer:GeantViewer){
  expect(Math.abs(new Vector3(1,0,0).applyQuaternion(viewer.camera.quaternion).dot(up))).toBeLessThan(1e-9);
  expect(new Vector3(0,1,0).applyQuaternion(viewer.camera.quaternion).dot(up)).toBeGreaterThan(0);
}
it('turns around the supplied lunar up and tilts around camera right without rolling or orbiting',async()=>{
  const f=await fixture(),observer={...f.viewer.navigation.observerJ2000M!};
  const expected=forward(f.viewer).applyAxisAngle(up,.6);
  await f.command({yawRadians:.6});
  expect(forward(f.viewer).distanceTo(expected)).toBeLessThan(1e-10);level(f.viewer);
  const right=new Vector3(1,0,0).applyQuaternion(f.viewer.camera.quaternion);
  expected.applyAxisAngle(right,.35);
  await f.command({pitchRadians:.35});
  expect(forward(f.viewer).distanceTo(expected)).toBeLessThan(1e-10);level(f.viewer);
  expect(f.viewer.navigation.observerJ2000M).toEqual(observer);
});
it('levels a rolled entry while preserving its view direction and handles vertical limits',async()=>{
  const f=await fixture(.7);
  expect(forward(f.viewer).distanceTo(direction)).toBeLessThan(1e-10);level(f.viewer);
  for(const pitchRadians of [10,-20,20,-20]){
    await f.command({pitchRadians,yawRadians:.3});level(f.viewer);
    expect(f.viewer.camera.quaternion.toArray().every(Number.isFinite)).toBe(true);
  }
});
it('ascends and descends along lunar up with the same scale and boost policy as free travel',async()=>{
  const f=await fixture(),before={...f.viewer.navigation.observerJ2000M!},heading=f.viewer.camera.quaternion.clone();
  await f.command({up:1,deltaSeconds:2,speedHeadsetMPerSecond:1.35},GEANT_MOTION_ACTIONS.move);
  const expected=translatedObserverJ2000M(before,up.clone().multiplyScalar(2.7),1000);
  const actual=f.viewer.navigation.observerJ2000M!;
  expect(new Vector3(actual.x,actual.y,actual.z).distanceTo(new Vector3(expected.x,expected.y,expected.z))).toBeLessThan(1e-4);
  await f.command({up:-1,deltaSeconds:.5,speedHeadsetMPerSecond:1.35,boost:1},GEANT_MOTION_ACTIONS.move);
  const returned=f.viewer.navigation.observerJ2000M!;
  expect(new Vector3(returned.x,returned.y,returned.z).distanceTo(new Vector3(before.x,before.y,before.z))).toBeLessThan(1e-4);
  expect(f.viewer.camera.quaternion.angleTo(heading)).toBeLessThan(1e-7);
  expect(f.viewer.navigation.mode).toBe('free');
});
