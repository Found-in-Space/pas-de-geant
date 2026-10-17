# Body appearances and simulation time

`BodyAppearanceFactory` is the replaceable visual boundary for a body. It can
create procedural geometry, shaders, image-based visuals or a group of parts.
It receives the body definition, a borrowed renderer, the read-only simulation
clock and a lifetime `AbortSignal`. The factory returns a fresh appearance, or
a promise that resolves when its first usable representation is ready.

```ts
import { createGeantBodyAppearancePlugin } from "@found-in-space/pas-de-geant";
import { createSunAppearance } from "@found-in-space/pas-de-geant/appearances";
import { celestialBody } from "@found-in-space/pas-de-geant/worlds";

const sun = createGeantBodyAppearancePlugin({
  body: celestialBody("sun"),
  appearance: createSunAppearance,
});
sun.object3d.position.set(12, 1.5, -1);
sun.object3d.scale.setScalar(celestialBody("sun").referenceRadiusM / scaleDenominator);
const removeSun = await viewer.install(sun);

// A host-supplied factory implements exactly the same interface.
await sun.setAppearance(mySolarObservationAppearance);
await removeSun();
```

The generic plugin and interfaces are root exports. First-party implementations
are opt-in through `/appearances`; importing the viewer/browser/embed does not
import Sun shaders or generate textures. The initial implementation supplies
the Sun. Other bodies can use application-owned factories with no registry or
additional package required.

## Coordinates, composition and ownership

An appearance supplies `object3d`, optional `update(frame)` and
`beforeRender(camera)` hooks, and `dispose()`. Local axes are body-fixed
X/ north Y/ minus-east Z. Local lengths are physical metres divided by
`body.referenceRadiusM`. Geometry follows the supplied body definition. Rings
and glow may extend beyond the reference radius without redefining it.

The plugin owns a stable outer group exposed as `plugin.object3d`. The host
sets its pose and display scale. An appearance only changes its own children.
The plugin introduces no orbital placement, camera motion, body rotation,
terrain, imagery service or additional render loop. It uses the existing
SkyKit setup/part/teardown lifecycle. The render hook receives the active XR
ArrayCamera when presenting; shaders use each eye's view/projection matrices.

`setAppearance(factory)` leaves the active model visible while the new factory
loads. After successful construction and its initial update, replacement
attaches the new model and retires the old one. The outer pose and scale stay
unchanged. A construction failure preserves the old model. Superseding a load
or removing the plugin aborts pending work. Late results are disposed without
attachment. Each instance owns its GPU resources; borrowed resources remain
owned by the caller. A factory that rejects must release partial allocations.

## Shared simulation time

Every Geant viewer exposes `viewer.time`; ordinary plugins can also access
`getGeantContext(context).time`. All appearances receive that same source in
their factory context and a shared sample in `frame.time`.

The viewer samples its navigation clock before frame parts run. The sample is
immutable and contains:

| Field | Meaning |
| --- | --- |
| `atMs` | Absolute simulation timestamp, UTC Unix milliseconds |
| `rate` | Signed simulation seconds per real second; zero is paused |
| `deltaMs` | Signed change since the previous viewer frame, including seeks |
| `revision` | Clock-setting generation, incremented on seeks/re-anchoring/rate changes |
| `discontinuity` | A seek occurred since the previous frame |

World placement and star-observer fallback also use this source. Navigation
retains the existing `geant:time.set` action and `getClock()`/`setClock()` API.
No appearance can change the clock through the read-only time interface.

```ts
const unsubscribe = context.time.subscribe((time, reason) => {
  // Select/cache observations by time.atMs; do not download on every tick.
  selectObservation(time.atMs, time.revision);
}, { signal: context.signal });
```

Subscription immediately delivers the current sample with reason `initial`.
Advancing playback delivers `advance`; setting the clock delivers `clock`,
including changes made while the renderer is stopped or playback is paused.
Paused frames do not repeatedly notify unchanged time. Seeking is visible
immediately to subscribers and on the next frame through `discontinuity` and
`deltaMs`. Unsubscribe, abort the supplied signal, or dispose the viewer to
release a subscription.

An observation provider owns acquisition, caching and selection policy. It
retains actual observation times, provenance, projection and viewpoint
metadata, reports missing coverage, and distinguishes the requested time from
the selected observation time. Use clock revision and observation request
identity to discard obsolete asynchronous results. The current package does
not include a SOHO/STEREO acquisition service.

## Procedural Sun

`createSunAppearance(context, options?)` supplies illustrative animated
granulation and a thin additive corona. Default animation uses absolute
simulation time: it pauses, reverses and reproduces the same timestamp after a
seek. Bounded shader phases are calculated in double precision on the CPU so
modern UTC timestamps retain sub-second animation precision on the GPU.

`{ animationTime: "presentation" }` explicitly selects the frame's
`elapsedSeconds` instead. The size-comparison integration case uses this
artistic choice to retain gentle motion while its simulation clock is paused.
Providers selecting timestamped observations should use simulation time.

The Sun generates one small repeating texture and draws a photosphere and
corona without external assets or postprocessing. Its cells, animation and
colour treatment are illustrative, not measured imagery or a convection
simulation. Physical headset appearance and performance require separate
manual acceptance.
