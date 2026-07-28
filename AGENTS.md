# Project workflow

- Treat local development as the default. Do not save, publish, or deploy a
  version with OpenAI Sites unless the user explicitly asks for a Sites
  deployment in the current request.
- When the user already has the development server running, reuse it. Do not
  start, stop, or replace it unless asked or unless local validation requires
  a separate process.
