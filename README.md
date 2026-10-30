# Pas de Géant

Composable planetary worlds, navigation, and browser experiences for
[Found in Space](https://foundin.space/).

The reusable [`@found-in-space/pas-de-geant` package](packages/pas-de-geant/README.md)
provides Solar System bodies, physical coordinate frames, streamed surfaces,
navigation, SkyKit plugins, browser viewers and an HTML embed. Defaults use
medium-resolution NASA Blue Marble and measured Mapterhorn elevation for Earth,
with bundled imagery as a disconnected fallback. Other bodies retain their
reference sources; hosts can replace surface datasets explicitly.
Static sky imagery and SkyKit catalog stars are separate optional
[background plugins](packages/pas-de-geant/docs/sky-backgrounds.md); neither
loads by default, and the image option needs no star packages.
This is a local alpha implementation, with no npm publication implied.

The former private master demo has been retired. This repository builds a
package; [`integration/`](integration/README.md) contains isolated development
cases and is excluded from the default build and package distribution. Its first
case, `standard.html`, combines the default Earth surface, TouchOS map, location
detection, scale sliders and VR.
The [retirement inventory](docs/workbench-retirement.md) records what remains
and what was removed.

The [architecture](docs/architecture.md) defines the component boundaries.
The [movement contract](packages/pas-de-geant/docs/movement.md) describes custom models and integration.
The [composition contract](packages/pas-de-geant/docs/composition.md) defines how
rendered poses, XR eyes and terrain measurements reach tile selection.
The [journey adapter](packages/pas-de-geant/docs/journeys.md) shares its chapter
controller and controls with SkyKit; `integration/earth-journey.html` is the
paired geographic example.

## Develop

Use Node.js 22 or later:

A clean checkout can reconstruct its ignored dependency archives from exact
public TouchOS, SkyKit (including the shared guided-journey package) and VoiceOS
commits. Use Node 24 for this reproducible
preparation; it verifies that the manifests and lock remain unchanged. No
unpublished npm versions or sibling checkouts are required.

For active sibling development, `npm run prepare:interaction` builds and packs
the sibling sources and updates npm lock integrity. Review those changes after
producer edits.

To reconstruct exactly the pinned commits from local Git repositories, use
`npm run prepare:development -- --sources-root /path/to/workspace`. This reads
committed objects, not working-tree edits; the same manifest/lock identity check
still applies. The new journey source commit must be pushed before the default
GitHub reconstruction can fetch it.

```sh
npm run prepare:development
npm ci
npm run build                 # reusable package only
npm run dev:integration       # local cases at http://127.0.0.1:4197
```

`npm run dev` is an alias for the integration server. It binds to loopback and
has no API middleware or service proxy. Dataset and VoiceOS cases consume
explicit external URLs from an ignored local configuration file. Existing
development servers are not automatically stopped or replaced.

When changing package source with a case open, run
`npm run dev --workspace @found-in-space/pas-de-geant` in another terminal
to rebuild the package as files change.

```sh
npm run check                # package, tests, tools and integration types
npm test                     # package behaviour and local fixtures
npm run check:spatial-package # pinned dependencies and shared spatial contract
npm run check:sky-isolation   # default/image module graphs have no star dependencies
npm run build:embed          # standalone static embed in dist/embed
npm run build:examples       # small consumer examples in dist/examples
npm run build:integration    # explicit development build in dist/integration
npm run check:package -- --offline
```

`npm run examples` serves the minimal consumer examples. The optional
`npm run check:embed` requires a built embed and an installed Chromium; use it
when browser verification is needed. Physical Quest acceptance is separate.
There is no application deployment workflow.

## Ownership

- [Satellite](https://github.com/Found-in-Space/satellites) and
  [aircraft](https://github.com/Found-in-Space/aircraft) runtimes and examples
  belong in their independent repositories.
- The [tile-cache service](https://github.com/kws/tile-cache) owns upstream
  texture acquisition and proxying. Geant supplies dataset URL configuration
  and owns loading, scientific source admission, browser persistence and rendering.
- [Planetary Surfaces](https://github.com/Found-in-Space/planetary-surfaces)
  owns imagery/elevation production, descriptors and validation. Geant contains
  no tile producer or local product server.
- [VoiceOS](https://github.com/Found-in-Space/voice-os) owns AI sessions, audio,
  transport and token-service tooling. Geant's optional `/ai` adapter maps
  domain state/actions to VoiceOS; no token server or authored agent lives here.

Software: [MIT](LICENSE). Bundled source attribution and limitations:
[`NOTICE.txt`](packages/pas-de-geant/NOTICE.txt). Terrain and imagery are not
suitable for navigation or safety-critical use.

The Geant development batch also prepares the sibling VoiceOS 0.1.0-alpha.2
archive, whose optional peer admits TouchOS 0.4.0-alpha.0. Its published
predecessor only admits TouchOS 0.3; coordinated publication must include this
metadata update. Voice transport behavior is unchanged and tested offline.
