# Synthetic Earth PMTiles fixture

These are mathematical test pixels, not downloaded Mapterhorn measurements.
The acquisition test substitutes a local range reader, including the synthetic
upstream ETag and acquisition producer identity retained in `product.json`.

Both files were generated without modification by Planetary Surfaces commit
`f0634afc11bf2c698ac0856a149c7bdc4ce51a34`, from a clean checkout:

```sh
cd elevation
UV_CACHE_DIR=.cache/uv uv run --frozen pytest -q \
  tests/test_mapterhorn_footprint.py::test_snapshot_preserves_bytes_sparse_absence_and_existing_conversion \
  --basetemp /tmp/earth-pmtiles-fixture
```

Copy `test_snapshot_preserves_bytes_0/product/{earth.pmtiles,product.json}` from
the test output. Dependencies/platform versions are recorded in the descriptor;
regeneration on another platform may change archive compression bytes. The
producer test independently verifies scalar conversion and sparse coverage.
The fixture has 13 PNG tiles through z2: z0, all z1 tiles, and two diagonally
opposite 2-by-2 child patches at z2. One patch contains valid encoded zero;
the other two z2 quadrants are absent. Source heights include positive/negative
values and byte carries, with a scalar mean for z0.

- `earth.pmtiles`: 59,372 bytes; SHA-256
  `6b8c0fabf1f022c1caa927ce7c113929e1f8c4f7a184137c2532ee84b59eb864`
- `product.json`: 4,721 bytes; SHA-256
  `e361b0a8c06ddfb681411c5a48274edd9b19c3b5996ea25e95f734964e93ec68`

The producer's independent Python PMTiles reader reports tile payload hashes
`794622265bbc7f41a77c26c066d48c8a49228b401eed36db674b7d1207827426`
for `(z,x,y) = (1,1,0)` and
`4fcfdd8fbc702879e491242fc08d77e6305ca6c6847fb360c6e0994e40adf9bc`
for the zero-valued `(2,0,0)` tile. Runtime checks compare returned PNG bytes
against these independent values, including an overzoomed fallback request.

Runtime tests use the actual archive reader and bytes. Node simulates image
allocation and reads PNG dimensions; it does not claim browser/GPU decoding or
headset acceptance. All generated fixture code/data is covered by the producing
repository's MIT licence.
