import { cp } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
await cp(new URL('../src/assets', import.meta.url), new URL('../dist/assets', import.meta.url), { recursive: true });
// Standalone module graphs also work when loaded through a cross-origin Blob bootstrap.
for (const worker of ['tile-scheduler', 'imagery-decoder']) {
  await build({ entryPoints: [fileURLToPath(new URL(`../src/worlds/${worker}.worker.ts`, import.meta.url))],
    outfile: fileURLToPath(new URL(`../dist/worlds/${worker}.worker.js`, import.meta.url)), bundle: true,
    platform: 'browser', format: 'esm', target: 'es2022' });
}
