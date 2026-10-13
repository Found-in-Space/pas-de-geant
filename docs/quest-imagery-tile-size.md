# Quest display imagery: 256-pixel baseline

## Decision

Use **256 × 256 display imagery tiles for normal Quest sessions**, across Earth,
the Moon, Apollo detail products, and other bodies and providers. Earlier
physical Quest testing found performance problems with 512 × 512 imagery. The
owner reconfirmed that finding on 13 October 2026. Do not silently reintroduce
512-pixel imagery when adding a provider, admitting a producer descriptor, or
changing grids. A 512-pixel source is an explicit diagnostic choice.

This applies to display imagery. Scientific elevation tiles have a separate
encoding and validation contract; their dimensions are not changed by this
decision. It also does not prohibit retaining existing 512-pixel reference or
archive products.

## How Apollo returned to 512

The 7 August 2026 commit
`375e936fd15f75ad8a914a635ec45f0ddbbb7a6c` (`Persist MapTiler imagery and default
to 256px`) recorded 256 as the MapTiler default and `?imageryVariant=maptiler-512`
as an explicit diagnostic override. The documentation did not explain the
performance finding or state a rule across bodies and providers.

The implementation in `apps/pas-de-geant/src/imagery-variants.ts` applies the
256 selection to the recognised MapTiler satellite source. Other sources pass
through. `apps/pas-de-geant/src/lunar-configuration.ts` takes `tileSize` from the
admitted lunar product. The texture producer's baseline and
`projects/moon/apollo11-preview-mercator-v2/preview.toml` specify 512 pixels.
Together these allowed Apollo imagery to use 512 despite the existing Quest
finding. This is a source/product integration gap. The documentation correction
does not convert the current products or implement a runtime policy check.

## Why a shared renderer does not mean equal work

At application revision `c0279ace689d0d06811d588bc3c9b3a2644b3cd9`, Earth and
Moon imagery use the shared acquisition queue, decoder worker, padded RGBA
pages, mip generation, GPU texture arrays, page-table sampling, terrain shader,
and WebXR render loop. Apollo selects prepared source tiles before that common
path; it has no separate compositor or extra render pass.

A 512-pixel tile contains four times as many pixels as a 256-pixel tile. With
the shared eight-pixel gutter on each edge, page dimensions are 528 versus 272;
the larger page has about 3.77 times the base-level RGBA storage. For the same
number of pages it also increases decode, mip generation, staging, and upload
work. Total scene cost additionally depends on resident page count, committed
imagery detail, visible terrain, and allocation history. These are reasons to
preserve the known 256 baseline, not a measurement of the contribution of tile
size to any particular slowdown.

On 13 October, one live Quest 3 session at scale 1:50 reported:

| Metric | Apollo 11 | Asciano near Pisa |
| --- | ---: | ---: |
| Frame rate | 16.23 fps | 52.31 fps |
| Draw calls | 548 | 312 |
| Visible terrain meshes | 272 | 152 |
| Active body's imagery pool allocation | 830.88 MiB | 235.16 MiB |

This was **not a controlled 256-versus-512 comparison**. Earth's finer imagery
was deferred after 503 responses, head direction was not fixed, and switching
bodies retained the existing Moon allocation. The Moon sample had no active
imagery jobs or migration and its recorded tile lookups were cache hits: the
slowdown persisted after loading. No numerical results from the earlier
512-pixel experiment were located in the checked documentation; do not present
these later scene measurements as that experiment.

## Preparing a compliant runtime product

Produce and validate an actual 256-pixel runtime derivative with explicit grid,
coverage, zoom range, and sampling. Changing tile size at the same zoom changes
metres per pixel; review source caps and addressing to preserve the intended
detail. Do not relabel 512-pixel payloads as 256 or imply that downsampling at
unchanged zoom preserves resolution. Use new product/cache identities and
generated descriptors, checksums, and provenance. Existing immutable products
retain their authentic metadata.

The producer's structural validation is separate from physical Quest
performance acceptance. Keep Earth and Moon on the common renderer and loading
path when preparing the runtime derivatives.
