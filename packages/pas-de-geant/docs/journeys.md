# Guided journeys

The optional `/journey` adapter uses the same
`@found-in-space/guided-journey` controller as SkyKit. It interprets geographic
scene data and drives the host's existing movement adapter. Chapter lifecycle,
latest-wins requests, cleanup, operation outcomes and presentation controls are
implemented once in the shared package, not copied into Geant.

```ts
import { createGeantJourneyDriver } from '@found-in-space/pas-de-geant/journey';
import { defineGuidedJourney, createGuidedJourneyController } from '@found-in-space/guided-journey';
import { mountJourneyControls } from '@found-in-space/guided-journey/dom';

const driver = createGeantJourneyDriver({ browser });
const definition = defineGuidedJourney({
  id: 'earth', transition: { durationSecs: 5 },
  chapters: [{ id: 'himalaya', title: 'Himalaya', scene: {
    camera: { kind: 'surface' as const, body: 'earth' as const,
      latitudeDegrees: 28, longitudeDegrees: 86, altitudeM: 1_500_000,
      altitudeReference: 'reference' as const, scaleDenominator: 900_000 },
  } }],
});
const journey = createGuidedJourneyController({ definition, driver });
const controls = mountJourneyControls({ root, definition, journey });
// Select a chapter explicitly to begin, especially in immersive mode.
// On unmount: controls.destroy(); await journey.dispose(); driver.dispose();
```

`start`, `goTo`, `next` and `previous` return operations whose `finished` promise
resolves to `completed`, `cancelled`, `superseded` or `failed`. `goTo` finishes
after navigation arrival and arrival hooks. It is not an action acknowledgement.
The snapshot separates requested, entered and arrived chapters. Invalid IDs fail
without changing the current scene; endpoints do not wrap; selecting a chapter
again re-enters it from the live view. `cancel` enters free exploration at the
current pose. Reset must be an explicit authored destination.

## Geographic intent and placement

`camera.kind: 'surface'` takes a configured body, latitude/longitude in degrees,
eye altitude in physical metres, `altitudeReference: 'reference' | 'terrain'`,
and a positive scale denominator. Terrain altitude is above the sampled displayed
terrain, including the host terrain multiplier. A reference altitude is relative
to the body's reference geometry. Neither is room height or centre distance.

Travel starts at the rendered physical observer and orientation, follows a
great-circle geographic interpolation and smooth physical-height interpolation,
and changes scale logarithmically. The destination looks down with north up
relative to the captured viewing direction. The navigation rig and world
placement perform this movement; tracked headset orientation is never authored.
Zero duration requests an explicit immediate transition. Otherwise the first
zero/tiny-time frame preserves the live pose, including after interruption.

The movement adapter remains the only placement writer. Journey arrival settles
after movement and world updates in the host frame, so the destination already
reaches world view measurement. Arrival holds the geographic location as world
time advances. Manual input releases travel to the existing ship movement model;
the current placement is retained. Driver disposal borrows rather than disposes
the viewer. Dispose the journey, then its driver, before disposing the host.

This first adapter covers surface destinations. Inter-body route design,
moving-target following and scripted sequence ownership are later capabilities;
the adapter does not reinterpret stellar parsecs as planetary metres.

## Readiness and time

Default preparation waits for `world.getReadiness().ready`, reports that public
readiness through the journey snapshot and aborts when superseded. This means
usable world content, which may be fallback imagery. It does not promise the
desired high-resolution terrain, route coverage or night tiles. An additional
`prepare(scene, context)` hook can await provider-owned readiness and register
scoped cleanup. `readiness: 'none'` explicitly skips the usability gate for an
independently prepared host or a controlled fixture.

`scene.time: {atMs, rate?}` adopts UTC milliseconds and world-clock rate at
arrival. The next host frame uses that epoch for both movement and body placement.
Leaving/cancelling restores the previous rate at the current instant, without
rewinding the clock. A later explicit clock edit is left intact. This is not
presentation-sequence playback; `durationSecs` remains presentation seconds.
The shared `/sequence` player now provides pause/seek/rate/rejoin separately;
its protocol is documented in SkyKit's guided-journey package. A Geant sequence
participant, including moving-target following, is still required before those
controls can drive planetary camera sequences. Surface chapters do not acquire
sequence behavior merely by setting a world-clock rate.

## Paired example and validation

`integration/earth-journey.html` contains overview, Himalaya, Andes and terminator
chapters. It uses the standard Blue Marble/Mapterhorn defaults and optional night
imagery. Authored coordinates, scales and time are in
`integration/src/earth-journey-chapters.ts`; no page-owned camera loop is needed.
SkyKit's `packages/skykit/examples/guided-journey` uses the same controller,
chapter envelope and DOM controls with a stellar driver.

The common `/testing` fixture runs against each real host. Geant additionally
checks rendered camera/world continuity at zero/tiny time, geographic arrival,
interruption, clock cleanup and unchanged headset orientation with desktop and
emulated-XR fixtures. These checks establish runtime behavior, not physical Quest
comfort or imagery quality. The current controls are desktop DOM controls; an
immersive chapter panel is still required for a complete headset presentation.
