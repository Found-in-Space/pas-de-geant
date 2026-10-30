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

`camera.kind: 'body-pose'` accepts the same frame-labelled `SpatialPose` used by
SkyKit's spatial tools. Use `geantBodyFixedSpace(body)`: body-centred metres,
x at longitude zero, +y north and -z east. The camera looks along local -Z with
local +Y up. Transform source coordinates explicitly before combining them;
incompatible frames/units fail. Physical position interpolates linearly from the
live eye, orientation interpolates through the current body attitude, and scale
remains logarithmic. This is a direct transfer, not terrain avoidance or an
inter-body flight planner. Authored shots must choose suitable offsets and entry
paths. No terrain adjustment is applied to the tracked target.

Successful direct navigation dispatches and action-registry commands release
journey ownership. Invalid commands leave it intact. A newer explicit mode or
movement model remains selected after release/disposal. Callers coordinating
their own state writers can use `navigation.subscribeCommands`; its optional
`source` identity distinguishes those writers without depending on action names.

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
Surface chapters do not acquire sequence behavior merely by setting a world-clock
rate. Use the shared `/sequence` player for explicit presentation time.

## Sequence playback and tracked targets

```ts
import { createJourneySequencePlayer } from '@found-in-space/guided-journey/sequence';
import { mountSequenceControls } from '@found-in-space/guided-journey/dom';
import { createGeantJourneyNavigation, createGeantSequenceParticipant,
  createGeantSequencePlugin, createGeantTrackingSequence } from '@found-in-space/pas-de-geant/journey';

const navigation = createGeantJourneyNavigation(browser);
const participant = createGeantSequenceParticipant({browser, navigation});
const sequence = createGeantTrackingSequence({sequence: targetSequence, shot});
const player = createJourneySequencePlayer({sequence, participant});
const remove = await browser.install(createGeantSequencePlugin({player,
  onFrame(frame) { presentTarget(frame.value.target); },
}));
const controls = mountSequenceControls({root, player});
// Explicitly player.join(), then player.play(); neither happens on installation.
// Cleanup: controls.destroy(); await remove(); player.dispose();
// participant.dispose(); navigation.dispose(); then dispose the host.
```

Use one journey navigation object per host; share it with chapter and sequence
participants. The generic participant accepts `{camera, atMs?}` values and may
also consume any other domain fields. The optional clock mapping uses explicit
UTC milliseconds, held at rate zero. Presentation time, mission time and the
world's display epoch remain distinct. An omitted mapping leaves the world clock
alone. Releasing an owned clock restores its prior rate at the current instant;
a later explicit clock edit wins. Arrival and playback end have distinct
operations; the latter resolves after the endpoint reaches world measurement.

The plugin runs the shared player's `update(deltaSecs)` at priority -175, after
resource publication and before movement selection. Its synchronous `onFrame`
callback receives that same evaluated sample for targets/captions. Movement and
worlds then consume the same sampled epoch. No extra timer or render loop is
installed. The plugin borrows the player; removal stops scheduling, and the owner
disposes the player and participant. Pause retains the shot, cancellation frees
the live scene, detached seeks never acquire it, and rejoin captures the new live
pose. Negative rates and repeated/out-of-order seeks use the same evaluator.

`createGeantTrackingSequence` composes a pure target evaluator with an authored
`GeantTrackingShot`. Targets declare body, body-fixed space, position in metres
and rotating-frame velocity in metres per source second. Shot data declares
right/up/behind offsets, radial or explicit up, look-ahead seconds and scale.
Heading follows an explicit reference tangent or the tangent-plane velocity.
Velocity heading requires an explicit positive `blendSpeedMPerSec`: below that
speed a smooth angular blend approaches the reference tangent, so stationary
targets do not depend on the previous frame or seek order. These are camera
choices; no source position, velocity or attitude is modified. Degenerate authored
up/tangent/aim combinations fail instead of choosing an unreported orientation.

The optional `worldTime(timeSecs, target)` mapping supplies the scene epoch. Apollo
can therefore retain nominal GET and a deliberately fixed illustrative lighting
epoch without pretending that pre-1972 UTC labels are an ephemeris conversion.

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

`integration/earth-sequence.html` pairs with SkyKit's stellar sequence example:
both import `createJourneySequencePlayer` and `mountSequenceControls` from the
same package. The Earth example follows an explicitly authored marker through
the public tracking evaluator and participant. Additional controlled desktop/XR
checks verify body-relative pose, measured height, target/camera/epoch coherence,
reverse playback, independent head motion, manual rejoin, newer-owner survival,
clock cleanup, host disposal and separate arrival/end acknowledgement.
