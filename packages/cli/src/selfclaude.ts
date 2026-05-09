#!/usr/bin/env node
import { Command } from 'commander';
import { daemonLogs, daemonStart, daemonStatus, daemonStop, isAlive, readPid } from './daemon.js';
import { openUrl } from './open-url.js';
import { ensurePreflight } from './preflight.js';

const program = new Command();

program
  .name('selfclaude')
  .description('Two-agent Claude Code orchestration')
  .version('0.0.1');

program
  .command('start', { isDefault: true })
  .description('Start SelfClaude (daemon by default; --foreground for debug)')
  .option('--foreground', 'Run in the foreground (Ctrl+C exits) — daemon is the default')
  .option('--no-open', "Don't auto-open the browser")
  .option('--port <port>', 'Web API port', '7423')
  .option('--web-port <port>', 'Next.js dev server port', '3000')
  .action(
    async (opts: {
      foreground?: boolean;
      open?: boolean;
      port?: string;
      webPort?: string;
    }) => {
      ensurePreflight();
      if (opts.foreground) {
        await runWebMode({
          apiPort: Number(opts.port ?? 7423),
          nextPort: Number(opts.webPort ?? 3000),
          openBrowser: opts.open !== false,
        });
      } else {
        await daemonStart({
          apiPort: Number(opts.port ?? 7423),
          webPort: Number(opts.webPort ?? 3000),
          openBrowser: opts.open !== false,
        });
      }
    },
  );

async function runWebMode(opts: {
  apiPort: number;
  nextPort: number;
  openBrowser: boolean;
}): Promise<void> {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve: pathResolve } = await import('node:path');
  const { findRepoRoot, startWebApi } = await import('@selfclaude/core');

  const HERE = dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = findRepoRoot(HERE);
  const WEB_DIR = pathResolve(REPO_ROOT, 'packages', 'web');
  const NEXT_BIN = pathResolve(WEB_DIR, 'node_modules', '.bin', 'next');

  const api = await startWebApi({ port: opts.apiPort });
  console.log(`✓ SelfClaude Web API: ${api.url}`);

  // `detached: true` makes nextProc a process group leader so we can later
  // signal -nextProc.pid and reach every worker Next.js forks (SWC, RSC
  // compiler, etc.). Without this, killing the parent leaves orphan
  // workers holding the dev port.
  const nextProc = spawn(NEXT_BIN, ['dev', '--port', String(opts.nextPort)], {
    stdio: 'inherit',
    cwd: WEB_DIR,
    detached: true,
  });

  const browserUrl = `http://127.0.0.1:${opts.nextPort}/`;
  if (opts.openBrowser) {
    setTimeout(() => openUrl(browserUrl), 3500);
  }
  console.log(`✓ Web UI: ${browserUrl}`);

  let stopping = false;
  let forceTimer: NodeJS.Timeout | null = null;

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    // Hard fallback — if we can't shut down cleanly within 3s, just exit.
    forceTimer = setTimeout(() => {
      console.error('selfclaude: graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 3000);
    try {
      // Negative PID = signal the whole process group (SWC workers, etc.).
      if (nextProc.pid) {
        try {
          process.kill(-nextProc.pid, 'SIGTERM');
        } catch {
          // Group send failed (process already dead, or Windows): fall back to direct.
          try {
            nextProc.kill('SIGTERM');
          } catch {
            /* already gone */
          }
        }
      }
      // Escalate after 1.5s if SIGTERM didn't take.
      setTimeout(() => {
        try {
          if (nextProc.pid) process.kill(-nextProc.pid, 'SIGKILL');
        } catch {
          try {
            nextProc.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }, 1500);
    } catch {
      /* ignore */
    }
    try {
      await api.server.close();
    } catch {
      /* ignore */
    }
    try {
      await api.manager.destroyAll();
    } catch {
      /* ignore */
    }
    if (forceTimer) clearTimeout(forceTimer);
  };

  // Two Ctrl+C presses → immediate exit, even if `stop()` is stuck.
  let sigintCount = 0;
  process.on('SIGINT', () => {
    sigintCount += 1;
    if (sigintCount >= 2) {
      console.error('selfclaude: second Ctrl+C, exiting now');
      process.exit(130);
    }
    void stop().then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void stop().then(() => process.exit(0));
  });
  nextProc.on('exit', (code) => {
    void stop().then(() => process.exit(code ?? 0));
  });
}

program
  .command('stop')
  .description('Stop the SelfClaude daemon')
  .action(async () => {
    await daemonStop();
  });

program
  .command('restart')
  .description('Restart the SelfClaude daemon')
  .action(async () => {
    ensurePreflight();
    await daemonStop();
    await daemonStart();
  });

program
  .command('status')
  .description('Show SelfClaude daemon status')
  .action(() => {
    daemonStatus();
  });

program
  .command('logs')
  .description('Show SelfClaude daemon logs')
  .option('-f, --follow', 'follow log output')
  .option('-n, --lines <n>', 'number of lines to show (default 100)', '100')
  .option('-o, --orchestrator', 'show structured orchestrator events instead of daemon stdout')
  .action((opts: { follow?: boolean; lines?: string; orchestrator?: boolean }) => {
    daemonLogs({
      follow: opts.follow,
      lines: opts.lines ? Number(opts.lines) : undefined,
      orchestrator: opts.orchestrator,
    });
  });

program
  .command('link-telegram')
  .description('Pair a Telegram chat with this SelfClaude install (auto-discovers TELEGRAM_CHAT_ID)')
  .action(async () => {
    const { loadEnv, runLinkFlow } = await import('@selfclaude/core');
    const env = loadEnv();
    if (!env.TELEGRAM_BOT_TOKEN) {
      console.error('TELEGRAM_BOT_TOKEN must be set in .env first.');
      process.exit(1);
    }
    try {
      await runLinkFlow(env.TELEGRAM_BOT_TOKEN);
    } catch (e) {
      console.error(`link failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('update')
  .description('Pull latest SelfClaude and reinstall dependencies')
  .option('--no-restart', 'Skip daemon restart after update')
  .option(
    '--force',
    'Discard uncommitted local changes in the install dir (destructive)',
  )
  .action(async (opts: { restart?: boolean; force?: boolean }) => {
    const { findRepoRoot } = await import('@selfclaude/core');
    const { fileURLToPath } = await import('node:url');
    const { dirname } = await import('node:path');
    const { execFileSync } = await import('node:child_process');

    const HERE = dirname(fileURLToPath(import.meta.url));
    const appDir = findRepoRoot(HERE);

    // Guard against silently destroying operator edits. The install
    // dir is a real git repo, and `git reset --hard` below would wipe
    // any uncommitted work — including hand-tuned system prompts or
    // mid-debug tweaks. Refuse early unless the operator has opted in
    // with `--force`.
    const dirty = execFileSync('git', ['status', '--porcelain'], {
      cwd: appDir,
      encoding: 'utf8',
    }).trim();
    if (dirty.length > 0 && !opts.force) {
      console.error('Refusing to update — install dir has uncommitted changes:');
      console.error('');
      console.error(dirty);
      console.error('');
      console.error(`Install dir: ${appDir}`);
      console.error(
        'Commit or stash them first, or pass --force to discard them.',
      );
      process.exit(1);
    }

    const beforeHash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: appDir,
      encoding: 'utf8',
    }).trim();

    console.log('Fetching latest from origin/main…');
    execFileSync('git', ['fetch', '--depth', '1', 'origin', 'main'], {
      cwd: appDir,
      stdio: 'inherit',
    });
    execFileSync('git', ['reset', '--hard', 'origin/main'], {
      cwd: appDir,
      stdio: 'inherit',
    });

    const afterHash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: appDir,
      encoding: 'utf8',
    }).trim();

    if (beforeHash === afterHash) {
      console.log(`✓ Already up to date (${afterHash})`);
      return;
    }

    console.log('Installing dependencies…');
    execFileSync('pnpm', ['install', '--frozen-lockfile'], {
      cwd: appDir,
      stdio: 'inherit',
    });

    console.log(`✓ Updated ${beforeHash} → ${afterHash}`);

    if (opts.restart !== false) {
      const pid = readPid();
      if (pid !== null && isAlive(pid)) {
        console.log('Restarting daemon…');
        await daemonStop();
        await daemonStart();
      }
    }
  });

program
  .command('doctor')
  .description('Check environment and Telegram connectivity')
  .action(async () => {
    const { loadEnv, GrammyTelegramAdapter } = await import('@selfclaude/core');
    const env = loadEnv();
    console.log('--- environment ---');
    console.log(`TELEGRAM_BOT_TOKEN: ${env.TELEGRAM_BOT_TOKEN ? 'set' : 'unset'}`);
    console.log(`TELEGRAM_CHAT_ID:   ${env.TELEGRAM_CHAT_ID ? 'set' : 'unset'}`);
    if (!env.TELEGRAM_BOT_TOKEN) {
      console.log('Telegram bridge: disabled (set TELEGRAM_BOT_TOKEN in .env to enable).');
      return;
    }
    if (!env.TELEGRAM_CHAT_ID) {
      console.log('Telegram bridge: token set, chat unpaired.');
      console.log('  → run `selfclaude link-telegram` to pair a chat with this install.');
      return;
    }
    const adapter = new GrammyTelegramAdapter(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);
    try {
      const me = await adapter.getMe();
      console.log(`Telegram bot: reachable (@${me.username ?? '?'})`);
    } catch (e) {
      console.log(`Telegram bot: unreachable — ${(e as Error).message}`);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
