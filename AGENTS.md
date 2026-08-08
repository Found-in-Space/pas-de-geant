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
- Do not run browser tests unless visual verification is genuinely necessary.
  When visual verification is necessary, prefer the embedded viewer. The user
  performs visual testing far faster than automated browser tests.
- Do not add defensive guards or artificial size limits by default. Most size
  bugs in this project have come from agent-invented limits. Add size
  safeguards only after consulting with the user.
- Avoid meaningless tests. Add unit tests only when they exercise meaningful
  function behavior; do not add regression tests that merely lock down
  constants, strings, or other incidental implementation details.
