# Shared surface grid migration

The reusable worlds runtime uses one configurable surface path. Earth keeps
its WGS84 geometry and Mercator scheme; the Moon's canonical model uses that
scheme on its own sphere. Source admission chooses the explicit compatibility
model for immutable geographic lunar products. Apollo only selects prepared
sources with exact availability and priority; it has no renderer or planner.

## Source contract

Display format 2 `product.json` declares grid projection/version/radius and
opaque XYZ dimensions/caps. A separate `baseTexture` authenticates the full
latitude equirectangular `base.png`; Mercator zoom 0 has nonlinear latitude rows
and cannot be the globe base. Display production belongs to the independent
texture pipeline. Both global and sparse products use the same grid identity.

Scientific elevation is a separate contract:

```json
{
  "kind": "elevation-xyz", "formatVersion": 2,
  "identity": "<sha256>", "target": "moon",
  "grid": {"formatVersion": 1, "projection": "web-mercator", "radiusMetres": 1737400},
  "units": "metres",
  "verticalDatum": {"kind": "reference-surface", "radiusMetres": 1737400},
  "encoding": {"kind": "rg16", "scaleM": 0.5, "offsetM": -10000},
  "tileSize": 512, "maximumZoom": 6,
  "elevationBoundsMetres": {"minimum": -10000, "maximum": 22767.5}
}
```

The descriptor's identity must authenticate its controlled inputs, processing
and payload. The app's GDAL helper records scratch evidence; it is not a citable
publication. LOLA reprojection operates on UInt16 scalar values, with point
bilinear resampling, exact transforms and a fixed unit kernel scale, plus 0.5 m
target quantization, before RG16 encoding. This keeps global and independent
tile-window samples consistent at the longitude wrap; an adaptive kernel can
otherwise change the interpreted height surface. Lower encoded
levels use nearest source samples, avoiding interpolation of encoded bytes.
Channel 255 remains data. Incomplete target height coverage is rejected.
Intermediate rasters are tiled to preserve bounded block access during channel
encoding. Source CRS, dependency hashes (including VRT source pixels), code
hash/Git state, commands, tool versions and PNG
checksums are recorded. Other height encodings/datums need a separately admitted
implementation rather than borrowing the display contract.

The loader validates body radius, units/encoding and grid agreement before
combining imagery with elevation. A failed descriptor fetch/admission retains
the bundled base and flat height provider. Incompatible admitted grids fail
explicitly. Provider identities and browser URLs include product/grid identity;
local descriptor responses revalidate. Hosted migration needs new immutable
prefixes, since neither URL query identity nor metadata can reproject old bytes.

Mercator stops at ±85.05112878°. The shared polar caps use the independent
full-latitude base and flat reference height. Scientific polar heights are not
claimed by this display policy. Base UVs remain equirectangular; elevation and
imagery UVs both use projected Y on ordinary terrain patches, matching CPU
ground sampling. Reference mesh placement and topology selection remain shared.

NASA's SVS `ldem_64_uint.tif` has no embedded georeferencing. Its documented
global, 0°-centred equirectangular registration is attached in a VRT with pixel
edges at ±180° longitude and ±90° latitude, on the 1,737,400 m sphere. Original
source bytes remain untouched. Record the source dimensions, full hash and
registration evidence before building; the helper authenticates both the VRT
and its referenced raster. The [NASA CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/)
documents the half-metre encoding and the unsigned offset. The separate PDS
signed products have different registration/encoding and must not be substituted
by filename alone.

## Measured elevation refinement

The elevation crop scan and cache lifecycle adapt commit
`34c4e339fcc2dc2c5e6167a4e6251818730f2ca2` from the Mac worktree. The same helper
decodes Earth Terrarium and Moon RG16, includes contributing bilinear edge
texels, and caches scalar extrema per image/crop. Bounds-only pixel buffers are
released after the synchronous turn; ground-sampling buffers remain reusable.

Each render mesh uses its measured range for sphere expansion and target-horizon
reach. The occluding shell and loading horizon retain the global provider
range, including negative relief, skirts, chord error and rounding margins.
Pending sources retain that conservative range. Confirmed flat meshes use zero
heights. Measurements never narrow unseen terrain's loading envelope. Packed
entry data caches horizon trigonometry when bounds/displacement change.
Metrics expose measured and provider-fallback bound counts alongside visibility
and classification timing. Correctness checks do not establish Quest speedup.

## Payload migration and activation

The new producer recipes are independent candidates:

- `projects/moon/lroc-wac-global-100m-mercator-v2/project.toml`: same admitted WAC
  source, reprojected global tiles and independent base.
- `projects/moon/apollo11-preview-mercator-v2/preview.toml`: reprojected context
  and prepared NAC detail, retaining declared native sampling in both axes.

Their READMEs provide commands, grid/sampling choices and cost considerations.
Before a large build, review source receipts, native GDAL/PROJ, distinct external
source/work/output/evidence roots, free disk and preflight estimates. Pin the
clean pushed producer before generating publication evidence. Existing payloads
and publication manifests are immutable and remain geographic.

After complete producer validation, select new global imagery and matching
scientific elevation descriptors in application configuration. Set
`PAS_DE_GEANT_LUNAR_RUNTIME_DIRECTORY` to the prepared Mercator Apollo root.
Keep `PAS_DE_GEANT_LUNAR_PREVIEW_DIRECTORY` on the geographic 2D study product;
its WAC base separately defaults to geographic release `20261011.1`. The study
reader rejects Mercator input rather than misdrawing it.

The implementation is developed in isolated worktrees. Local Quest preparation
builds and validates the complete global and Apollo payloads and matching
elevation, retaining exact source snapshots and run evidence.
These are test products, without a CDN/catalog publication. Elevation zoom 6
retains the 64-samples-per-degree source's native sampling in both directions.
The intranet service uses a new versioned directory and keeps the old payloads
and deployment for rollback. Visual acceptance still takes place on the Quest
at Apollo, the antimeridian, high latitudes and the polar base boundary.

## Verification

Producer tests exercise both formats through real GDAL emission and complete
reconstruction, target metre geotransforms, polar base authentication,
nonlinear archive/mask sampling and descriptor identity checks. The generated
producer/consumer fixture covers both projections and body radii, tile/pixel
positions, parent crops and antimeridian wrapping.

Application tests cover source admission, grid/cache mismatch rejection,
projected mesh elevation UVs, measured bounds/caches for both height encodings,
real displaced triangle coverage through normal queues, HTTP metadata routing,
and a full small GDAL numeric round-trip with negative/zero/positive/extreme
samples. Type checking and production bundling verify shared package/worker
integration. Complete payload validation authenticates every declared tile and
reconstructs the global pyramid exactly; elevation checks compare independent
point samples at Apollo, the longitude wrap and the Mercator latitude limits.
Transfer checks authenticate the served copies. The HTTPS runtime smoke verifies
admitted imagery, decoded elevation and measured render bounds without tile
failures. Physical Quest visual acceptance and performance remain headset checks.
