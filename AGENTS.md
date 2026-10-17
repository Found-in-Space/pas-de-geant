# Project workflow

## Package and integration boundaries

- The default build produces only `@found-in-space/pas-de-geant`. The former
  private application was retired; see `docs/workbench-retirement.md`.
- Keep independent functionality/integration cases in `integration/`. Use only
  public package exports and explicit case builds. Do not add case code to the
  library, recreate a master demo, or publish integration cases automatically.
- Satellite and aircraft runtime examples belong in their independent projects.
- Configure external imagery/elevation services through dataset bindings. Tile
  production belongs to Planetary Surfaces; acquisition/proxying belongs to the
  tile-cache project. Do not add local tile servers or producer scripts here.
- VoiceOS owns AI transport, audio and token services. Geant owns its optional
  domain action/state adapter; keep authored agents and service code elsewhere.
- Sky backgrounds are optional plugins on `/sky-image` and `/stars`. Keep both
  outside root/browser/embed import graphs and defaults. The image option must
  work without star packages installed. SkyKit's aggregate is a build-time
  dependency; star packages are optional peers. See the package's
  `docs/sky-backgrounds.md`. Sky texture production, provenance and payloads
  belong to catalog publications; do not bundle them in Geant. Earth-to-stars
  journey restoration is separate work.

## Quest debugging

- Before debugging the Quest, read the ADB and DevTools setup in
  `integration/README.md` and use the repository helper in
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
- Headset previews use HTTPS reverse proxies with arbitrary hostnames. Keep
  wildcard hostname access enabled (`server.allowedHosts: true`) in the
  integration Vite configuration when changing or migrating dev-server setup.
- Development tile acquisition uses the independent cache service. Never
  bypass a missing or unavailable cache with direct MapTiler requests. Keep
  upstream provider credentials out of browser configuration.
- Good imagery and elevation persist indefinitely in browser Cache Storage.
  Upstream freshness must not expire retained tiles. Tile provider tests use
  local fixtures or fake fetchers rather than live paid endpoints.
- Upstream backoff or outages must not block access to server-cached imagery.
  The cache serves retained tiles first and marked black HTTP 200 placeholders
  for missing display imagery during backoff. Accept those placeholders for
  display without opening a provider-wide retry circuit, bypassing their short
  HTTP freshness, or retaining them indefinitely in browser Cache Storage.
  Verify that a server-only cache hit remains reachable after a fallback;
  checking browser-local cache hits alone does not cover this contract.
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
- The shared cache host runs only the upstream tile cache/proxy. AI token
  services and local product hosting are configured externally; never forward
  unrelated APIs to the cache host or deploy local product datasets there.
- Do not run browser tests unless visual verification is genuinely necessary.
  When visual verification is necessary, prefer the embedded viewer. The user
  performs visual testing far faster than automated browser tests.
- Do not add defensive guards or artificial size limits by default. Most size
  bugs in this project have come from agent-invented limits. Add size
  safeguards only after consulting with the user.
- Avoid meaningless tests. Add unit tests only when they exercise meaningful
  function behavior; do not add regression tests that merely lock down
  constants, strings, or other incidental implementation details.
