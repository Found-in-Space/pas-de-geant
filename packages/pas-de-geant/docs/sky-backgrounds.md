# Optional sky backgrounds

Geant starts with no sky background. Its root, `/browser` and `/embed` entry
points import neither background implementation nor reference either asset.
Choose one through an explicit subpath and install the ordinary plugin.
The browser and embed accept these objects through `plugins` or `install`.

## Static image

```ts
import { createGeantBrowser } from "@found-in-space/pas-de-geant/browser";
import { createGeantSkyImagePlugin } from "@found-in-space/pas-de-geant/sky-image";

const browser = await createGeantBrowser({
  host: document.querySelector<HTMLElement>("#world")!,
  bodies: ["earth"],
  plugins: [createGeantSkyImagePlugin()],
});
await browser.dispose();
```

For an on-demand choice, dynamically import `/sky-image` inside the host's
selection handler, then `await browser.install(plugin)`. Keep the returned
teardown to remove the background before installing another. Importing the
subpath or constructing a plugin does not fetch or decode an image.

The separately published 4096 × 2048 WebP derives from NASA SVS's
[Deep Star Maps 2020](https://svs.gsfc.nasa.gov/4851/). Its celestial ICRF/J2000
plate-carree projection has RA 0 at the centre, RA increasing left, north at
the top. The plugin applies Geant's celestial rotation and each eye's camera
orientation without observer/eye translation. It has no positional parallax,
individual star selection, or adjustable catalog depth. This is display
imagery, not a value-preserving scientific product.

Installing the plugin fetches the image from the immutable
[catalog release 20261017.2](https://github.com/Found-in-Space/catalogs/tree/9d8c93365984e1eabf29819cc297678072839ab8/publications/20261017.2),
under `https://data.foundin.space/textures/sky/deep-star-maps-2020/20261017.2/`.
It loads the main map and two matching 1024 × 1024 polar caps concurrently.
The caps are reprojected directly from the original linear EXR and encoded
as lossless WebP. Each uses a gnomonic projection centred on its celestial
pole, avoiding longitude's singularity and stretched filtering footprint.
The renderer blends into the caps across absolute declinations 60–65 degrees.
The image, source EXR, conversion tools and publication metadata are absent
from the Geant package. App builds perform no image downloads. The CDN caches
this version independently of application deployments.

Total image transfer is about 5 MB; decoded RGBA storage is 40 MiB before mipmaps
(32 MiB for the main map and 8 MiB for the two caps).
Physical headset acceptance remains separate. The 256-pixel surface-tile
policy concerns tiled body imagery, not this whole-sky texture.

`createGeantSkyImagePlugin({ url })` accepts an image with the same projection,
including a self-hosted copy for offline deployments or hosts with restricted
network policies. The default URL needs network access when not browser-cached.
`texture` instead borrows a decoded `THREE.Texture`; the caller owns disposal
and colour-space configuration (`THREE.SRGBColorSpace`, north at v=1).
Custom `url` or `texture` inputs use only that map unless matching `polarCaps`
are supplied. `polarCaps: { north, south }` accepts URLs or borrowed textures;
each cap must have a 35-degree half-angle, +J2000 X right, +Y top, and be centred
on +Z (north) or -Z (south). Use clamp-to-edge wrapping for borrowed caps.
`deepStarMapPolarUv(directionJ2000)` gives the matching cap coordinates.
`polarCaps: false` disables the default caps for comparison or a smaller transfer.
`signal` cancels loading or removes an installed image. Loading failure rejects
installation, releases all acquired images and leaves the viewer usable.

Credit: NASA/Goddard Space Flight Center Scientific Visualization Studio;
Gaia DR2: ESA/Gaia/DPAC. See the source page and
[SVS usage guidance](https://svs.gsfc.nasa.gov/help/).

## Catalog stars

Install the optional peers explicitly:

```sh
npm install @found-in-space/star-octree-provider@0.3.0-alpha.0 \
  @found-in-space/star-trees@0.2.1-alpha.0 \
  @found-in-space/three-star-field@0.3.0-alpha.0
```

```ts
const { createGeantStarsPlugin } = await import("@found-in-space/pas-de-geant/stars");
const removeStars = await browser.install(createGeantStarsPlugin());
// Later:
await removeStars();
```

This uses the real SkyKit octree provider, cell strategies and Three.js star
renderer. Acquisition starts on installation. An unavailable catalog updates
the part's snapshot without blocking the worlds. A supplied `provider` remains
caller-owned; the plugin disposes its session. Its own default provider is
disposed on removal. `createGeantStarPass` and its view/snapshot/options types
also live on `/stars` for explicit multipass composition.

The former root star exports, `stars` browser option and `data-geant-stars`
attribute have been removed. Use the plugin API. Earth-to-stars journey
restoration is outside this change.

## Dependency boundary and verification

SkyKit's published aggregate combines lifecycle and star helpers. Geant bundles
only the needed public lifecycle/control/session exports from its exact
build-time SkyKit dependency. The build selects their reachable declarations
and rejects emitted star implementation/type dependencies. This is the actual
SkyKit implementation, not another lifecycle. Three.js remains external;
spatial remains shared. Consumers need no SkyKit aggregate or star packages
for core Geant or the image plugin. Star packages are optional peers for `/stars`.

`npm run check:sky-isolation` checks the full default and image module graphs.
`npm run check:package -- --offline` checks runtime and declarations in a packed
consumer without star packages before explicitly installing the catalog peers.

## Texture publication

`catalogs/publications/20261017.2/` owns the preparation recipe, pinned build
dependencies, admitted source hash, generated `product.json`, checksums,
upstream terms and S3/CDN verification receipt. Its payload remains outside
Git and npm. Reproduction instructions live with that publication. Geant owns
only the optional runtime rendering plugin; it does not produce the texture.
