#!/usr/bin/env node
/**
 * Global launcher for the `selfclaude` CLI.
 *
 * Finds the repo root by walking up to pnpm-workspace.yaml, then spawns
 * `tsx` with the TypeScript entrypoint directly — no build step required.
 * Handles Windows symlinks (.bin/tsx is a .cmd wrapper, not a Unix symlink)
 * by using `cmd /c` on Windows, matching what Node's PATH resolution does
 * for .cmd files.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const SCRIPT = fileURLToPath(import.meta.url);
const HERE = dirname(SCRIPT); // packages/cli

function findRepoRoot(start) {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start, '..', '..');
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(HERE);
const TSX = resolve(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const TSCONFIG = resolve(REPO_ROOT, 'tsconfig.base.json');
const ENTRY = resolve(HERE, 'src', 'selfclaude.ts');

const child = spawn(
  process.platform === 'win32' ? 'cmd' : TSX,
  process.platform === 'win32'
    ? ['/c', TSX, '--tsconfig', TSCONFIG, ENTRY, ...process.argv.slice(2)]
    : ['--tsconfig', TSCONFIG, ENTRY, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});