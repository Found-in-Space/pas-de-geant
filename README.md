# Pas de Géant

Composable planetary worlds, navigation, and browser experiences for
[Found in Space](https://foundin.space/).

The reusable [`@found-in-space/pas-de-geant` package](packages/pas-de-geant/README.md)
provides Solar System bodies, physical coordinate frames, streamed surfaces,
navigation, SkyKit plugins, browser viewers and an HTML embed. Defaults use
bundled Earth/Moon imagery and reference surfaces; external services are opt-in.
This is a local alpha implementation, with no npm publication implied.

The former private master demo has been retired. This repository builds a
package; [`integration/`](integration/README.md) contains isolated development
cases and is excluded from the default build and package distribution.
The [retirement inventory](docs/workbench-retirement.md) records what remains
and what was removed.

The [architecture](docs/architecture.md) defines the component boundaries.
The [movement contract](packages/pas-de-geant/docs/movement.md) describes custom models and integration.

## Develop

Use Node.js 22 or later:

```sh
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
