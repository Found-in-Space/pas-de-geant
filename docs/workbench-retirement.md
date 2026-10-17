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
| Navigation model, actions, policy functions and timed transitions | Remain in the package. Controls now use composable schemes and shared motion commands; existing workbench behaviour is not a compatibility target. |
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

## Controls after retirement

The isolated planner-overlay/XR pages now consume the standard scheme, with planner
diagnostics and terrain tools as explicit removable extensions. The dataset
case offers the same extensions for measured surfaces. The integration app owns
their keyboard/XR bindings; the package plugins expose actions without assigning
feature-specific inputs. Device input invokes
shared motion actions; the session plugin supplies tracking independently.
The former hard-coded controller intent was removed. Voice shortcuts remain
authored bindings rather than defaults. The former demo does not require its
complete behaviour to survive. See the package and integration READMEs for the
binding contract and manual acceptance checks.
