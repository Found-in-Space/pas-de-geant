# Project workflow

## Quest debugging

- Before debugging the Quest, read the ADB and DevTools setup in
  `apps/pas-de-geant/README.md` and use the repository helper in
  `scripts/quest-debug.mjs`.
- Use the Meta Quest Developer Hub ADB binary directly:
  `/Applications/Meta Quest Developer Hub.app/Contents/Resources/bin/adb`.
  Do not assume `adb` is available on `PATH` and do not substitute a different
  Android SDK installation.

- Treat local development as the default. Do not save, publish, or deploy a
  version with OpenAI Sites unless the user explicitly asks for a Sites
  deployment in the current request.
- When the user already has the development server running, reuse it. Do not
  start, stop, or replace it unless asked or unless local validation requires
  a separate process.
- Development tile acquisition uses the independent cache service. Never
  bypass a missing or unavailable cache with direct MapTiler requests. Direct
  access requires the documented deliberate override; keep upstream provider
  credentials out of application configuration.
- Good imagery and elevation persist indefinitely in browser Cache Storage.
  Upstream freshness must not expire retained tiles. Tile provider tests use
  local fixtures or fake fetchers rather than live paid endpoints.
- Quest display imagery uses 256 × 256 tiles across all bodies and providers,
  including the Moon and Apollo products. Prior physical Quest testing found
  performance problems with 512 × 512 imagery; do not reintroduce it as a
  normal runtime default through a new source or product descriptor. A 512-pixel
  source is an explicit diagnostic choice. This decision concerns display
  imagery, not scientific elevation. Read `docs/quest-imagery-tile-size.md`
  before changing imagery sources, tile preparation, or tile-size defaults.
- Local imagery, elevation, and prepared Apollo products used by a running
  server must live on durable storage outside Git. Never point live dataset
  configuration at `/tmp` or a disposable build directory. Verify completed
  products before switching their configured roots.
- The shared cache host runs only the upstream tile cache/proxy. Application
  APIs, AI token issuance and local lunar products stay on development machines.
  Never forward all application APIs to the cache host or deploy local product
  datasets there.
- Do not run browser tests unless visual verification is genuinely necessary.
  When visual verification is necessary, prefer the embedded viewer. The user
  performs visual testing far faster than automated browser tests.
- Do not add defensive guards or artificial size limits by default. Most size
  bugs in this project have come from agent-invented limits. Add size
  safeguards only after consulting with the user.
- Avoid meaningless tests. Add unit tests only when they exercise meaningful
  function behavior; do not add regression tests that merely lock down
  constants, strings, or other incidental implementation details.
