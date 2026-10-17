# Retiring the private master demo

On 17 October 2026 the owner agreed to remove the private development app
before refactoring controls. Its accumulated integration choices were becoming
requirements for the reusable package. The last revision before retirement is
`171eb87c03ae99ffede94402a3e4ba9ef8b778f4`; the old app is recoverable there.

The main build now produces only `@found-in-space/pas-de-geant`. Independent
consumer examples remain in `examples/`. Explicit development cases live in
`integration/`, consume public exports and have separate builds. The former
GitHub Pages app deployment has been removed.

## Inventory

| Area | Disposition |
| --- | --- |
| Bodies, frames, ephemerides, surface contact, scale, streaming, source admission and workers | Remain in the public package with their unit tests. |
| Navigation model, actions, policy functions and timed transitions | Remain in the package. Controls architecture is a subsequent task; existing workbench behaviour is not a compatibility target. |
| Browser, embed, SkyKit lifecycle, stars, panels and XR adapters | Remain in the package; isolated pages and consumer examples exercise the public composition paths. |
| Tile-onion visual inspection | Moved to an isolated integration page using `/worlds`. The deterministic provider fixture moved to unit-test fixtures. |
| Walking app, duplicate input/render loops, focused Moon/Apollo pages, eclipse observatory, supervisor, authored journeys, forest overlays, location pins, geolocation and page UI | Retired with app-only tests. No automatic migration into package defaults; future capabilities need explicit ownership and requirements. |
| API server, token issuer, authored voice profiles/tools, knowledge/location services and local dataset server | Removed. VoiceOS and externally configured services own these integrations. The optional Geant AI adapter remains a domain bridge to published VoiceOS. |
| Texture preparation, Apollo metadata and preview scripts, and their GDAL producer tests | Removed from this runtime repository. Planetary Surfaces owns production; the tile proxy owns acquisition/serving. Consumer source-admission, sampling and grid-fixture tests remain. |
| Satellite and aircraft runtimes/examples | Remain solely in their independent projects; no runtime examples are installed here. |
| Old browser/emulator suites | Removed with their app-specific debug hooks. Static embed acceptance remains optional; integration cases document manual checks. |

Ignored operator files and local data were not migrated or deleted. The new
integration area uses its own small ignored config and has no access to old
session configuration through application code. Existing running processes
were not stopped or reconfigured.

## Next controls task

Define standard controls and composable schemes against package capabilities.
Use the isolated controls/XR pages as consumers. Select useful navigation
behaviour deliberately from the historical implementation. Planner diagnostics,
terrain adjustment and voice shortcuts are optional features; the former demo
does not decide default bindings or require its complete behaviour to survive.
