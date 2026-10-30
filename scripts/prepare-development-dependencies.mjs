import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = {
  skykit: '74ea437bbaf551b646a1b7d22f65a29430d06191',
  'touch-os': 'a18e75b71727bdd71cfe95b1d456b0ca625ad606',
  'voice-os': '383f51702f2ad92713ec89913fa00d784d3de1fe',
};
const originals = new Map(['package.json', 'package-lock.json'].map(file => [
  file, readFileSync(path.join(root, file), 'utf8'),
]));
const temporary = mkdtempSync(path.join(tmpdir(), 'geant-development-dependencies-'));
const run = (command, args, cwd) => execFileSync(command, args, {
  cwd, stdio: 'inherit', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
});

try {
  for (const [name, revision] of Object.entries(sources)) {
    const source = path.join(temporary, name);
    mkdirSync(source);
    run('git', ['init', '--quiet'], source);
    run('git', ['remote', 'add', 'origin', `https://github.com/Found-in-Space/${name}.git`], source);
    run('git', ['fetch', '--quiet', '--depth=1', '--no-tags', 'origin', revision], source);
    run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], source);
  }
  run(process.execPath, [
    path.join(temporary, 'skykit/scripts/stage-interaction-development.mjs'),
    path.join(temporary, 'touch-os'), root,
  ], path.join(temporary, 'skykit'));
  for (const [file, expected] of originals) {
    if (readFileSync(path.join(root, file), 'utf8') !== expected) {
      throw new Error(`${file} changed while reconstructing the pinned dependencies; review the archive identities before updating the lock.`);
    }
  }
  console.log('Prepared the pinned public dependency sources without changing the recorded dependency graph.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
