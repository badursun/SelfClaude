/**
 * Platform-safe process spawning utilities for SelfClaude.
 *
 * On Windows, Node's `spawn` cannot resolve .cmd/.bat files through PATH
 * (ENOENT even when the binary is installed). This module provides wrappers
 * that route through cmd.exe on Windows — the same way `cmd /c <command>`
 * resolves .cmd launchers correctly.
 *
 * All spawn wrappers are best-effort (errors are swallowed silently) since
 * they are used for non-critical side effects (opening a browser, tailing a
 * log). Critical failures (daemon spawn, orchestrator subprocess) use direct
 * spawn calls that surface proper errors.
 */

import { spawn } from 'node:child_process';

/**
 * Open a URL in the default browser.
 * - Windows: cmd /c start <url>
 * - macOS:   open <url>
 * - Linux:   xdg-open <url>
 */
export function openUrl(url: string): void {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* best effort */
  }
}

/**
 * Spawn a command via cmd.exe on Windows (for .cmd/.bat resolution),
 * directly on other platforms.
 *
 * On Windows: cmd /c <cmd> [args...]
 * Otherwise:  <cmd> [args...]
 */
export function spawnViaCmd(
  cmd: string,
  args: string[],
  opts?: Parameters<typeof spawn>[2],
): ReturnType<typeof spawn> {
  if (process.platform === 'win32') {
    return spawn('cmd', ['/c', cmd, ...args], opts);
  }
  return spawn(cmd, args, opts);
}

/**
 * Spawn the SelfClaude CLI entrypoint (selfclaude.mjs) via Node, fully
 * detached. Used by daemon.ts to re-spawn itself in daemon mode.
 *
 * HERE should point to packages/cli/src/ — we resolve selfclaude.mjs from
 * its parent directory.
 */
export function spawnSelfclaudeForeground(
  cwd: string,
  apiPort: number,
  webPort: number,
  extraEnv?: Record<string, string>,
) {
  // At runtime (tsx), import.meta.url resolves to the .ts source file,
  // so the launcher lives one directory up from HERE.
  return spawnViaCmd(
    process.execPath,
    [
      '--eval',
      `import { spawn } from 'node:child_process';` +
        `import { fileURLToPath } from 'node:url';` +
        `import { dirname, join } from 'node:path';` +
        `const HERE=dirname(fileURLToPath(import.meta.url));` +
        `const LAUNCHER=join(dirname(HERE),'selfclaude.mjs');` +
        `spawn(process.execPath,[LAUNCHER,'start','--foreground','--no-open','--port','${apiPort}','--web-port','${webPort}'],{detached:true,stdio:'ignore',env:{...process.env,'SELFCLAUDE_DAEMON':'1'}}).unref();`,
    ],
    {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...extraEnv },
    },
  );
}