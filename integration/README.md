# Isolated Geant integration cases

This private development workspace exercises the built public package. Each
page starts only its selected capability and owns its lifetime. The index
starts no viewer. Nothing here is imported by the package, included by the
default build, packed for npm, or automatically published.

From the repository root:

```sh
npm ci
npm run dev:integration
```

Open `http://127.0.0.1:4197`. `npm run build:integration` explicitly builds these
cases into `dist/integration` for local static-host checks. It does not deploy.
`config.local.json` is fetched at runtime only by the datasets/voice pages;
Vite has no public directory and does not copy that private file into builds.

## Cases and manual acceptance

| Page | Check |
| --- | --- |
| `lifecycle.html` | Scale Moon independently; dispose/remount it while Earth remains usable. Pause/resume Earth. Leaving the page disposes viewers. |
| `controls.html` | Focus, keyboard, pointer and wheel affect the enabled viewer; the disabled viewer stays fixed. Leaving clears input through package teardown. |
| `xr.html` | Enter/exit VR, tracked head motion, travel and scale using the public XR plugin. No service configuration is required. |
| `datasets.html` | Source admission, external imagery/elevation, attribution and browser caching. Try an invalid descriptor and a temporarily unavailable proxy. |
| `voice.html` | VoiceOS remains inactive until selected; check state queries/actions and teardown against an external token service. |
| `embed.html` | Declarative attributes, focus, resizing and teardown through `/embed`. |
| `planner.html` | Inspect the provider-independent tile cut and polar anchor using only `/worlds`, without remote tiles or WebGL. |

The controls cases exercise the current implementation. Extendable schemes,
unified desktop/XR commands and optional diagnostic bindings remain the next
controls architecture task. These pages implement no navigation or input loops.

Browser cases expose `window.geantIntegration.snapshot()` and
`window.geantIntegration.invoke(viewerId, actionName, payload)` for inspection.
Both use public package APIs; this helper is development code only. The planner
has its own visible readouts. Add future cases as separate pages and register
them in `vite.config.ts`; avoid growing a shared master application.

## External services

```sh
cp integration/config.local.example.json integration/config.local.json
```

Replace the example URLs with your service URLs; remove unused sections.
This file is ignored. It contains browser-visible configuration, so keep
upstream API credentials and token-service secrets on their owning servers.

`datasets.body` selects a body and `datasets.sources` accepts the public
`BodySurfaceDatasets` configuration: `imagery` and/or `elevation`, each with
`productUrl`, `urlTemplate`, `attribution`, and optional `addressing`.
Descriptor URLs resolve relative to this config file; relative tile templates
resolve relative to their descriptor through the package's existing contract.
Use admitted 256 × 256 display imagery for Quest; elevation keeps its own dimensions.

The independent tile proxy serves configured tile URLs. Product descriptors and
payloads are hosted externally. Geant adds no relay, provider registry, token
issuer, tile generator, server credential handling, or direct-provider fallback.
Configure CORS at those services for the integration origin. VoiceOS owns the
token service; set `voice.sessionEndpoint` and the matching `voice.profile`.
That service must advertise the Geant tool contracts supplied by the adapter.

Satellite and aircraft examples belong in their own repositories and are not
installed here. Cross-project changes should be tested from the owning project.

## Quest and DevTools

WebXR needs a secure context. A USB reverse tunnel lets Quest Browser use
`http://localhost:4197/xr.html`. Confirm the headset is connected and authorized
in Meta Quest Developer Hub, then use its ADB executable:

```sh
"/Applications/Meta Quest Developer Hub.app/Contents/Resources/bin/adb" reverse tcp:4197 tcp:4197
```

`npm run quest:debug -- targets`, `device`, and `snapshot` use the repository's
ADB/DevTools helper. The helper expects an open integration case for snapshots.
For example, invoke a public action in `xr.html`:

```sh
npm run quest:debug -- call invoke '["world","geant:scale.set",{"scaleDenominator":80000}]'
```

The default ADB path above is the Developer Hub binary. Existing explicit
`PAS_DE_GEANT_ADB` and `PAS_DE_GEANT_DEVTOOLS_PORT` overrides remain supported
for an established connection. Do not start or replace servers to inspect them.
