# Geant integration cases

This private development workspace exercises the built public package. Each
page owns its lifetime. The first case combines the standard experience; the
remaining pages focus on individual capabilities. The index
starts no viewer. Nothing here is imported by the package, included by the
default build, packed for npm, or automatically published.

From the repository root:

```sh
npm ci
npm run dev:integration
```

Open `http://127.0.0.1:4197`. `npm run build:integration` explicitly builds these
cases into `dist/integration` for local static-host checks. It does not deploy.
`config.local.json` supplies an optional imagery override for the standard demo,
and is also fetched when custom datasets or VoiceOS are selected on their pages,
or when the Earth journey is opened with `?datasets=configured`.
Vite has no public directory and does not copy that private file into builds.

## Cases and manual acceptance

| Page | Check |
| --- | --- |
| `standard.html` | Blue Marble or configured proxy imagery, Mapterhorn terrain, automatic device/IP location, clickable TouchOS map and logarithmic scale slider, standard navigation modes and VR. No local configuration required for Blue Marble. |
| `earth-day-night.html` | Orbit the terminator; inspect night city lights and polar caps. Seek UTC, play at 600×, pause, compare day-only, and enter/exit VR. Both products use 256-pixel tiles. Block external data and reload to check the bundled day fallback and dark night side. |
| `earth-journey.html` | Select overview, Himalaya, Andes and terminator chapters using the same controller and DOM controls as SkyKit's stellar example. Interrupt, reverse, revisit and explore freely; check that rejoining begins at the current view. Night-chapter clock rate is released without rewinding. The left-controller panel uses the shared TouchOS controls. Add `?datasets=configured` to review an explicit Earth terrain product through the same journey. Physical Quest acceptance remains pending. |
| `earth-sequence.html` | Follow an explicitly illustrative Earth-fixed target using the same sequence player and DOM controls as SkyKit's stellar sequence. Rejoin, play/pause, scrub, reverse, replay and interrupt through ordinary controls. The package schedules camera/target/world samples in one host frame. Fixed world epoch; standard Earth imagery/elevation; physical Quest and immersive controls pending. |
| `lifecycle.html` | Scale Moon independently; dispose/remount it while Earth remains usable. Pause/resume Earth. Leaving the page disposes viewers. |
| `size-comparison.html` | Compare Moon, Earth and Sun at one size scale, using authored positions and lighting. Enter VR, walk/lean closer, and check that the lineup stays fixed in the room and labels remain legible. |
| `backgrounds.html` | Starts with no sky code/assets requested. Select the image and verify only the main map and two polar caps load, without catalog/renderer modules or octree requests; select catalog stars explicitly. Use Enter VR to preview the selected background in the headset; exit VR to switch or remove it. Inspect both celestial poles and the cap transitions while rotating. Confirm celestial orientation and no translational parallax for the image. |
| `planner-overlays.html` | Inspect Earth terrain tile boundaries and Blue Marble source overlays across location, scale and navigation modes. Compare with a fixed reference; optionally adjust terrain exaggeration. No local configuration is required. |
| `xr.html` | Check surface altitude, stable observation placement, and ship controls. The host supplies an explicit model selection function. |
| `datasets.html` | Starts with the default Earth surface. Load configured datasets to check source admission, attribution, caching, invalid descriptors and unavailable proxies; restore default Earth afterward. |
| `voice.html` | VoiceOS remains inactive until selected; check state queries/actions and teardown against an external token service. |
| `embed.html` | Declarative attributes, focus, resizing and teardown through `/embed`. |
| `planner.html` | Inspect the provider-independent tile cut and polar anchor using only `/worlds`, without remote tiles or WebGL. |

Controls use the package's standard scheme and shared desktop/XR motion actions.
Camera-driven cases use the package's [composition contract](../packages/pas-de-geant/docs/composition.md).
Authored placement uses the SkyKit adapter's `getFrame`; cases do not calculate
live tile views from desktop dimensions or navigation state.

`window.geantIntegration.snapshot()` reads current public state. Worlds owned
by the Geant world plugin include `worlds.<body>.view`, `readiness` and `tiles`.
The view exposes measured eye height, display radius, location and focal length;
the tile readback exposes effective terrain and imagery targets. For example,
`window.geantIntegration.snapshot().world.worlds.earth` inspects the standard
Earth case after a frame update. These values help distinguish a wrong measured
view from source resolution or pending loading. The authored SkyKit adapter
includes its measured view in its own part snapshot.

For terrain geometry investigations, `window.geantIntegration.terrain("world")`
also reports the committed mesh grids, visible patches, triangle counts and
actual elevation source zoom bound to each mesh, alongside the measured view
and terrain planner state. It runs only when called. Capture it through the
existing Quest connection with
`npm run quest:debug -- call terrain '["world"]'` near a feature and again after
retreating. Compare loaded geometry and elevation with the requested terrain
cut; imagery zoom is a separate quantity. Do not increase quality settings to
conceal a bad measured view or incomplete resource publication.

Every Earth viewer uses the same medium-resolution Blue Marble day product
(256-pixel tiles, zoom 0–9) and measured Mapterhorn Terrarium elevation
(512-pixel height tiles, zoom 0–12), unless a diagnostic case explicitly supplies
other datasets. The standard demo also accepts the local proxy imagery override
described below. Moon-specific views retain their lunar reference source.

Start with `standard.html`. The page requests device location while the viewer
loads; permission denial or an unavailable device location falls back to an
approximate IP location through GeoJS. The status identifies the source. If both
fail, the viewer stays usable and the map selects a location manually. Location
detection belongs to this example, not the library. Use localhost or HTTPS for
device location and XR. The same TouchOS runtime renders the desktop canvas and
the left-controller panel in VR. Aim the right controller and use its trigger
to select the map, move the scale slider or cycle navigation mode. The panel
reflects keyboard and XR scale actions; changing scale retains the selected
location.

For manual acceptance, allow device location, retry after denying it, and block
GeoJS to check the unavailable status and manual map selection. Change scale
from the panel slider and Z/X, then enter VR and test the panel map/slider with the
right trigger. Walk and turn in observation mode to check the world remains
fixed. Exit VR and confirm the desktop panel still works.

The extension checkboxes start off. They install ordinary feature plugins and
compose application-owned binding fragments through `extendGeantControlScheme`;
no case implements navigation or input loops.
The size-comparison case explicitly omits movement and manual controls. It
composes the public `/worlds` runtime and `/worlds/skykit` lifecycle adapter with
independent body poses. No ephemeris placement is installed. All three bodies
use 1:63,781,370; Earth is 20 cm across its equator, the Moon is 5.4 cm across,
and the Sun is about 22 m across off to the right. The starting eye is about
85 cm in front of the Earth/Moon plane. Spacing and lighting are authored.
The page and scene show body names without physical or display-size readouts.
The Sun uses the public `createGeantBodyAppearancePlugin` with
`createSunAppearance` from `/appearances`. Its stable root receives the authored
pose and shared size scale. The factory can be replaced without changing that
root. It supplies animated granulation and a soft additive corona. This is an artistic
illustration, with exaggerated cells and animation, rather than measured solar
imagery or a convection simulation. A small generated, repeating texture and
two sphere draws supply the effect without external assets or postprocessing.
This case explicitly chooses `{ animationTime: "presentation" }` for motion
independent of its paused simulation clock. The public factory defaults to
simulation time and supports pause, reverse playback and seeks. Both the frame
input and factory subscription use the viewer's shared simulation-time source;
no second render loop is installed. See the package's
[appearance contract](../packages/pas-de-geant/docs/appearances.md). Check the surface
motion, smooth limb and glow in both eyes, including near the sphere's poles.
Check the desktop view at narrow and wide widths, then enter VR and inspect
both small bodies up close. Check the Moon's round outline as you lean and
look around; terrain seam skirts must stay inside the body even at miniature
scales. Exit VR to check that the desktop view returns. Leaving
the page releases surfaces, base textures, Sun geometry/materials/texture,
labels, grid and session resources.
The [movement architecture](../packages/pas-de-geant/docs/movement.md) defines the integration contract.
`src/xr.ts` supplies ordinary model objects through the browser's `movement` option.
The library has no registry of all possible movement metaphors. `src/control-bindings.ts` selects
F8/F9 and XR X/Y for planner actions, and C/V or right-grip-modified input for
terrain adjustment. These associations belong only to this integration app;
the package feature plugins expose actions without assigning keys or buttons.
Active help derives from the resolved scheme.

Planner overlay and interaction acceptance:

- On `planner-overlays.html`, enable planner diagnostics and toggle terrain and
  imagery overlays separately. Navigate and change scale to inspect the tile
  cut, with the fixed reference alongside. Switch surface/orbit/free modes. In
  orbit, movement rotates around the focused body and C/V/wheel changes distance
  independently of scale. The default Blue Marble source provides streamed
  source-tile boundaries without local configuration.
- Standard controls leave F8/F9, XR X/Y and surface C/V terrain adjustment
  unbound. Enable planner tools, toggle overlays, then disable the extension;
  overlays and shortcuts must stop. Re-enable it to check a fresh lifecycle.
- Enable terrain tools and change the multiplier with the panel or C/V outside
  orbit. Restore 1× explicitly. Removing the tools preserves the multiplier.
  The Earth inspection case uses measured Mapterhorn elevation; its starting
  location in the Alps makes relief visible without extra configuration.
- In XR surface mode, verify left-stick travel and right-stick altitude.
  The horizontal right stick produces one snap turn after neutral.
  Physical altitude changes must preserve scale.
- In XR observation mode, walk, crouch, and turn your head.
  The map must remain fixed in the room.
  The left stick changes the surface contact.
  The vertical right stick changes physical altitude above the ground, just as in
  surface mode: approach and retreat along the observation normal, without
  shifting the anchor vertically or changing scale.
- In XR ship mode, verify right-stick travel and left-stick pitch/yaw.
  Hold the left grip to substitute roll for yaw.
  Hold the right grip for faster travel.
  Looking around must not steer the ship.
- With terrain tools enabled, hold the right grip and move the horizontal right stick in surface or observation mode.
  The modifier replaces snap turning for that interaction.
  A diagonal gesture retains one function until both axes return to neutral.
- Change schemes/modes while holding an input, blur the viewer, exit/re-enter
  XR and reconnect controllers. Release before starting another interaction;
  no held motion or button edge should carry into the next context. Leaving
  the page releases input and feature resources.

Built-in tool panels are HTML. Enable extensions before entering immersive XR;
the supplied controller bindings operate there. Custom immersive panels can use
Touch OS and the same public actions. Type/unit/package checks do not establish
physical Quest or visual acceptance.

Browser cases expose `window.geantIntegration.snapshot()` and
`window.geantIntegration.invoke(viewerId, actionName, payload)` for inspection.
Both use public package APIs; this helper is development code only. The planner
has its own visible readouts. Add future cases as separate pages and register
them in `vite.config.ts`; avoid growing a shared master application.

Earth cases use the hosted Blue Marble day product by default, including the
size-comparison composition. The bundled low-resolution reference is retained
for disconnected use. The day/night case additionally loads Black Marble 2016;
it needs no private configuration or provider key. These historical composites
are described in the package's [world contract](../packages/pas-de-geant/docs/worlds.md#earth-day-and-night-imagery).
Check time-dependent terminator motion and stable city locations across day/night
switches, pole crossings and zoom changes. After switching, leaving the page must
release both imagery pools, workers and owned base bitmaps. Physical Quest
performance and appearance still require headset acceptance.

## External services

```sh
cp integration/config.local.example.json integration/config.local.json
```

Replace the example URLs with your service URLs; remove unused sections.
This file is ignored. It contains browser-visible configuration, so keep
upstream API credentials and token-service secrets on their owning servers.

`standardImagery` binds an XYZ imagery source to `standard.html`. The example
uses the independent proxy's `textures` provider: satellite imagery with
256-pixel tiles and zoom levels 0–22. Set its URL to the existing cache service;
its public `/api/providers` metadata supplies the provider identity, attribution,
tile size and zoom range. Only display imagery changes: Mapterhorn terrain,
the Blue Marble base/map, default scale and VR navigation remain the same.
Open `standard.html?imagery=blue-marble` for the original imagery comparison.
Without `standardImagery` (or without the local file), the demo uses Blue Marble.
An unavailable configured proxy is never bypassed with direct provider requests.

`datasets.body` selects a body and `datasets.sources` accepts the public
`BodySurfaceDatasets` configuration: `imagery`, `nightImagery` and/or `elevation`.
XYZ bindings have `productUrl`, `urlTemplate`, `attribution`, optional
`productSha256` and optional `addressing`. Earth PMTiles elevation instead has
`transport: "pmtiles"`, `productUrl`, required `productSha256`, `attribution`
and explicit `verticalReference: "preserve-upstream"`.
Descriptor URLs resolve relative to this config file; relative tile templates
resolve relative to their descriptor through the package's existing contract.
Use admitted 256 × 256 display imagery for Quest; elevation keeps its own dimensions.

For `earth-journey.html?datasets=configured`, set `datasets.body` to `earth`
and supply `datasets.sources.elevation`. Day and night imagery keep the pinned
defaults unless also supplied in `datasets.sources`. The unqualified journey
URL keeps all standard sources and does not read the local file. A configured
admission error is shown on the page; it does not silently select default terrain.
The same chapter definition, shared controller, desktop/XR controls and
current-view readiness apply to either source selection.

For example, replace the URL and descriptor hash in this local configuration
with the exact identity of a reviewed, externally hosted bounded product:

```json
{
  "datasets": {
    "body": "earth",
    "sources": {
      "elevation": {
        "transport": "pmtiles",
        "productUrl": "https://terrain.example.test/earth-landscapes/product.json",
        "productSha256": "REPLACE_WITH_64_LOWERCASE_HEX_CHARACTERS",
        "verticalReference": "preserve-upstream",
        "attribution": "Mapterhorn source heights; upstream vertical reference is unresolved and encoded zeros may include missing data."
      }
    }
  }
}
```

Preserve the product's source credits and limitations in its attribution. This
height policy performs no datum conversion; it displays upstream metre values
above the Earth model ellipsoid. Archive range responses require exact HTTP 206,
Content-Range and a consistent strong ETag; expose those response headers through
CORS. Authenticate the complete archive before serving it from an immutable
location. The runtime authenticates the descriptor but does not hash the entire
archive during range access. Configuring a scratch product does not admit its
source rights or make it ready for public delivery. See the package's
[Earth PMTiles contract](../packages/pas-de-geant/docs/worlds.md).

Review all four chapter views and their connecting travel, including sparse
terrain fallback. Capture `geantIntegration.terrain("world")` after each settled
view to compare actual elevation source zooms and planner targets. Repeat with
retained browser caches and inspect both eye views on the physical headset;
chapter-centre byte checks alone do not establish view coverage or comfort.

The landscape chapter scenes set fixed daylight times (30 October 2026 at
12:00 UTC for the overview, 06:00 for Himalaya and 18:00 for Andes). The night
chapter starts at 12:00 UTC and advances at 600×. Revisit restores the chapter's
authored lighting through the shared journey driver. These are presentation
choices; the July 2004/2016 imagery remains historical.

The independent tile proxy serves configured tile URLs. Product descriptors and
payloads are hosted externally. Geant adds no relay, provider registry, token
issuer, tile generator, server credential handling, or direct-provider fallback.
Configure CORS at those services for the integration origin. VoiceOS owns the
token service; set `voice.sessionEndpoint` and the matching `voice.profile`.
That service must advertise the Geant tool contracts supplied by the adapter.

Satellite and aircraft examples belong in their own repositories and are not
installed here. Cross-project changes should be tested from the owning project.

## Quest and DevTools

The integration dev server accepts arbitrary hostnames (`allowedHosts: true`)
so it works through the HTTPS reverse proxy used for headset previews. Keep
this setting when changing the development setup. Open the integration index
or `/backgrounds.html` through your existing secure proxy.

WebXR needs a secure context. A USB reverse tunnel lets Quest Browser use
`http://localhost:4197/xr.html`. Confirm the headset is connected and authorized
in Meta Quest Developer Hub, then use its ADB executable:

```sh
"/Applications/Meta Quest Developer Hub.app/Contents/Resources/bin/adb" reverse tcp:4197 tcp:4197
```

For the sky comparison, open `http://localhost:4197/backgrounds.html` in Quest
Browser using that same tunnel. Select **Deep Star Maps image** or **SkyKit
stars** before pressing **Enter VR**. Exit VR to change the HTML selection.
The image and star data require network access; neither is requested until
its background is selected.

`npm run quest:debug -- targets`, `device`, and `snapshot` use the repository's
ADB/DevTools helper. The helper expects an open integration case for snapshots.
For example, invoke a public action in `xr.html`:

```sh
npm run quest:debug -- call invoke '["world","geant:scale.set",{"scaleDenominator":80000}]'
```

The default ADB path above is the Developer Hub binary. Existing explicit
`PAS_DE_GEANT_ADB` and `PAS_DE_GEANT_DEVTOOLS_PORT` overrides remain supported
for an established connection. Do not start or replace servers to inspect them.

### TouchOS shared-interaction development batch

The standard panel now mounts independent desktop and XR views through the
shared TouchOS 0.4 environment. Geant supplies the map, log-scale binding and
left-grip placement; the libraries own pointer events, WebXR selection,
capture, cancellation and beam/marker feedback. Panel actions apply continuous
value requests during the `update` phase, with rendered values read back from
navigation state. Map bitmap handles are allocated separately per runtime.

Run `npm run prepare:interaction` from Geant before `npm ci`. This builds
TouchOS and packs the changed SkyKit packages into ignored `.packages` archives.
Normal npm installation records their versions and integrity; a subsequent
`npm ci` keeps the prepared batch. Re-run preparation after producer changes.
The private workspace uses explicit file dependencies and overrides, while the
public Geant manifest requires TouchOS 0.4.0-alpha.0 and the changed SkyKit
versions. Registry-only installation awaits those publications.

Run the normal typecheck, tests and integration build. For an isolated consumer
with no workspace overrides or source aliases, run from SkyKit:
`node scripts/check-interaction-packed-consumer.mjs .packages/touch-os.tgz ../pas-de-geant`.
It exercises continuous scale edits, blocked button releases, spatial occlusion
and recovery through packed Geant, SkyKit and TouchOS public exports.
The standard panel still requires a physical headset check for pointer/marker
alignment, readable targets, comfortable placement and frame cost.

The Geant development batch also prepares the sibling VoiceOS 0.1.0-alpha.2
archive, whose optional peer admits TouchOS 0.4.0-alpha.0. Its published
predecessor only admits TouchOS 0.3; coordinated publication must include this
metadata update. Voice transport behavior is unchanged and tested offline.
