import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const root = new URL('../', import.meta.url);
const source = fileURLToPath(new URL('../../skykit/packages/spatial/', import.meta.url));
const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
if (metadata.name !== '@found-in-space/spatial') throw new Error('Expected the sibling spatial package.');
const staging = await mkdtemp(join(tmpdir(), 'geant-spatial-'));
try {
  const result = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', staging,
    '--cache', join(tmpdir(), 'fis-spatial-npm-cache')], { cwd: source, encoding: 'utf8' });
  const [packed] = JSON.parse(result.stdout);
  const archive = join(staging, packed.filename);
  const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
  const filename = `spatial-${metadata.version}-${hash.slice(0, 12)}.tgz`;
  const vendor = new URL('vendor/npm/', root);
  await mkdir(vendor, { recursive: true });
  await copyFile(archive, new URL(filename, vendor));
  for (const workspace of ['packages/worlds/', 'apps/pas-de-geant/', '']) {
    const dependency = `@found-in-space/spatial@file:${workspace ? '../../' : ''}vendor/npm/${filename}`;
    const installed = await run('npm', ['install', dependency, ...(workspace ? [] : ['--save-dev']),
      '--ignore-scripts', '--no-audit', '--fund=false', '--prefer-offline',
      '--cache', join(tmpdir(), 'fis-spatial-npm-cache')], {
      cwd: fileURLToPath(new URL(workspace, root)), encoding: 'utf8',
    });
    process.stdout.write(installed.stdout);
    process.stderr.write(installed.stderr);
  }
  for (const previous of await readdir(vendor)) {
    if (previous.startsWith('spatial-') && previous.endsWith('.tgz') && previous !== filename) {
      await rm(new URL(previous, vendor));
    }
  }
  process.stdout.write(`Installed packed spatial ${metadata.version}; SHA-256 ${hash}\n`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
