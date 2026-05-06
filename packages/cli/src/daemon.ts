import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';

/**
 * Ports the daemon binds. Anything alive on these is a stray we need to
 * reap before (or after) starting/stopping the daemon — orphan Next.js
 * workers in particular have a habit of holding port 3000 even after the
 * parent dies.
 */
const MANAGED_PORTS = [7423, 3000];

/**
 * Best-effort lsof: list PIDs holding any of the given ports. Empty array
 * if lsof is unavailable, none of the ports are in use, or any lookup
 * error — we do not want a port-probe failure to abort start/stop.
 */
function pidsHoldingPorts(ports: number[]): number[] {
  try {
    const out = execFileSync('lsof', ['-tiTCP', `-i:${ports.join(',')}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = out
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
    return Array.from(new Set(pids));
  } catch {
    return [];
  }
}

/**
 * Kill a list of PIDs with SIGKILL (no grace period — caller already gave
 * SIGTERM time). Silently ignores already-dead processes.
 */
function hardKill(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * Send a signal to a process group. The daemon child is spawned with
 * `detached: true`, which makes it a process group leader; signalling
 * `-pid` reaches every descendant in that group (including Next.js dev
 * workers spawned by the foreground process).
 *
 * Falls back to a single-PID signal if the process-group send fails — for
 * instance if the leader has already exited but children are still around.
 */
function killGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Open a URL in the default browser. Works on Windows (start), macOS (open),
 * and Linux (xdg-open). On Windows, Node's spawn cannot resolve .cmd files,
 * so we route through cmd.exe.
 */
function spawnOpen(url: string): void {
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

/** Resolves to the packages/cli/src directory at runtime (ts/tsx -> .ts file). */
const HERE = dirname(fileURLToPath(import.meta.url));

const RUN_DIR = join(homedir(), '.selfclaude');
export const PID_FILE = join(RUN_DIR, 'run.pid');
/** Daemon stdout/stderr — Next.js compile output, listen errors, etc. */
export const LOG_FILE = join(RUN_DIR, 'run.log');
/** Structured orchestrator events (turn starts, message assembly, wakeups). */
export const ORCHESTRATOR_LOG_FILE = join(RUN_DIR, 'orchestrator.log');

function ensureRunDir(): void {
  if (!existsSync(RUN_DIR)) mkdirSync(RUN_DIR, { recursive: true });
}

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, 'utf8').trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearStalePid(): number | null {
  const pid = readPid();
  if (pid === null) return null;
  if (isAlive(pid)) return pid;
  try {
    unlinkSync(PID_FILE);
  } catch {
    /* ignore */
  }
  return null;
}

const WEB_UI_URL = (port: number) => `http://127.0.0.1:${port}/`;

export interface DaemonStartOptions {
  apiPort?: number;
  webPort?: number;
  openBrowser?: boolean;
}

export async function daemonStart(opts: DaemonStartOptions = {}): Promise<void> {
  ensureRunDir();
  const apiPort = opts.apiPort ?? 7423;
  const webPort = opts.webPort ?? 3000;
  const openBrowser = opts.openBrowser !== false;

  const existing = clearStalePid();
  if (existing) {
    console.log(`SelfClaude already running (pid ${existing}).`);
    console.log(`  Web UI: ${WEB_UI_URL(webPort)}`);
    console.log('  Stop:   selfclaude stop');
    if (openBrowser) spawnOpen(WEB_UI_URL(webPort));
    return;
  }

  // Reap orphan processes still holding our ports. Without this a previous
  // crash/SIGKILL leaves Next.js workers behind and the new daemon hits
  // EADDRINUSE on every retry.
  const stragglers = pidsHoldingPorts([apiPort, webPort]);
  if (stragglers.length > 0) {
    console.log(`Cleaning up orphan processes on ports ${apiPort}, ${webPort}: ${stragglers.join(', ')}`);
    hardKill(stragglers);
    await wait(300);
  }

  const out = openSync(LOG_FILE, 'a');
  const err = openSync(LOG_FILE, 'a');

  // Re-spawn ourselves in --foreground mode, fully detached.
  // We cannot rely on `selfclaude` being on PATH (never linked in dev).
  // Resolve selfclaude.mjs to an absolute path using __dirname — this is
  // the packages/cli dir at runtime, so the launcher is one level up.
  // We pass it as an absolute path so the child process doesn't need to
  // do any path resolution of its own.
  const LAUNCHER_ABS = join(dirname(fileURLToPath(import.meta.url)), '..', 'selfclaude.mjs');

  // On Windows, cmd /c is required so node.exe can be resolved through PATH
  // (spawn can't resolve .cmd/.bat files on its own).
  const child = process.platform === 'win32'
    ? spawn('cmd', ['/c', process.execPath, LAUNCHER_ABS, 'start', '--foreground', '--no-open', '--port', String(apiPort), '--web-port', String(webPort)], {
        detached: true,
        stdio: ['ignore', out, err],
        env: { ...process.env, SELFCLAUDE_DAEMON: '1' },
      })
    : spawn(process.execPath, [LAUNCHER_ABS, 'start', '--foreground', '--no-open', '--port', String(apiPort), '--web-port', String(webPort)], {
        detached: true,
        stdio: ['ignore', out, err],
        env: { ...process.env, SELFCLAUDE_DAEMON: '1' },
      });
  child.unref();

  if (!child.pid) {
    console.error('Failed to spawn the daemon process.');
    process.exit(1);
  }
  writeFileSync(PID_FILE, String(child.pid));

  // Wait briefly to confirm the child is still alive (catches immediate
  // crashes from port conflicts, missing deps, etc).
  await wait(1500);
  if (!isAlive(child.pid)) {
    try {
      unlinkSync(PID_FILE);
    } catch {
      /* ignore */
    }
    console.error('SelfClaude crashed during startup.');
    console.error(`  Logs: ${LOG_FILE}`);
    process.exit(1);
  }

  if (openBrowser) spawnOpen(WEB_UI_URL(webPort));

  console.log(`✓ SelfClaude started (pid ${child.pid})`);
  console.log(`  Web UI: ${WEB_UI_URL(webPort)}`);
  console.log('  Logs:   selfclaude logs');
  console.log('  Stop:   selfclaude stop');
}

export async function daemonStop(): Promise<void> {
  const pid = readPid();
  if (pid === null) {
    console.log('SelfClaude is not running.');
    return;
  }
  if (!isAlive(pid)) {
    try {
      unlinkSync(PID_FILE);
    } catch {
      /* ignore */
    }
    console.log(`Stale PID file (pid ${pid}) cleaned up.`);
    return;
  }

  // Signal the entire process group so Next.js dev workers + Fastify API
  // + any spawned subprocess all receive SIGTERM together. Falls back to
  // a single-PID signal inside killGroup if the group send fails.
  if (!killGroup(pid, 'SIGTERM')) {
    console.error(`Failed to signal pid ${pid} (process group already gone)`);
  }

  // Up to 5 s to exit gracefully.
  for (let i = 0; i < 50; i++) {
    if (!isAlive(pid)) break;
    await wait(100);
  }

  if (isAlive(pid)) {
    console.warn(`pid ${pid} did not exit; sending SIGKILL`);
    killGroup(pid, 'SIGKILL');
    await wait(300);
  }

  // Final sweep: anything still listening on our managed ports is an
  // orphan from this daemon's process tree. Reap it so the next start
  // doesn't EADDRINUSE.
  const stragglers = pidsHoldingPorts(MANAGED_PORTS);
  if (stragglers.length > 0) {
    console.warn(`Reaping orphan port holders: ${stragglers.join(', ')}`);
    hardKill(stragglers);
    await wait(200);
  }

  try {
    unlinkSync(PID_FILE);
  } catch {
    /* ignore */
  }
  console.log(`✓ SelfClaude stopped (pid ${pid})`);
}

export function daemonStatus(): void {
  const pid = readPid();
  if (pid === null) {
    console.log('SelfClaude is not running.');
    return;
  }
  if (!isAlive(pid)) {
    console.log(`Stale PID file (pid ${pid}). Run \`selfclaude stop\` to clean up.`);
    return;
  }
  console.log(`✓ SelfClaude running (pid ${pid})`);
  console.log('  Web UI: http://127.0.0.1:3000/');
  console.log('  Logs:   selfclaude logs');
  console.log('  Stop:   selfclaude stop');
}

/**
 * Tail a log file (default: daemon stdout/stderr at run.log; pass
 * `orchestrator: true` to follow structured orchestrator events instead).
 */
export function daemonLogs(opts: {
  follow?: boolean;
  lines?: number;
  orchestrator?: boolean;
} = {}): void {
  const target = opts.orchestrator ? ORCHESTRATOR_LOG_FILE : LOG_FILE;
  if (!existsSync(target)) {
    console.log('No log file yet.');
    return;
  }
  const lines = opts.lines ?? 100;
  const args = opts.follow ? ['-n', String(lines), '-f', target] : ['-n', String(lines), target];
  const child = spawn('tail', args, { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}