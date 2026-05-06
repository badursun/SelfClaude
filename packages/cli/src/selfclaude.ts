#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { daemonLogs, daemonStart, daemonStatus, daemonStop } from './daemon.js';
import { ensurePreflight } from './preflight.js';

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

const program = new Command();

program
  .name('selfclaude')
  .description('Two-agent Claude Code orchestration')
  .version('0.0.1');

program
  .command('start', { isDefault: true })
  .description('Start SelfClaude (daemon by default; --foreground for debug)')
  .option('--demo', 'Render the legacy TUI with synthetic events (no real claude subprocess)')
  .option('--tui', 'Use the legacy Ink TUI instead of the web UI')
  .option('--foreground', 'Run in the foreground (Ctrl+C exits) — daemon is the default')
  .option('--no-open', "Don't auto-open the browser")
  .option('--port <port>', 'Web API port', '7423')
  .option('--web-port <port>', 'Next.js dev server port', '3000')
  .option('--cwd <dir>', 'Working directory the orchestrator operates in (TUI mode only)')
  .action(
    async (opts: {
      demo?: boolean;
      tui?: boolean;
      foreground?: boolean;
      open?: boolean;
      port?: string;
      webPort?: string;
      cwd?: string;
    }) => {
      if (opts.demo) {
        const { startDemo } = await import('@selfclaude/tui');
        await startDemo();
        return;
      }

      // Real-runtime paths require the Claude Code CLI. Demo mode skips
      // this check on purpose (it's pure synthetic events, no spawn).
      ensurePreflight();

      // Web mode is the default. Daemon unless explicitly --foreground.
      if (!opts.tui) {
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
        return;
      }

      const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd();
    const {
      Orchestrator,
      TelegramBridge,
      GrammyTelegramAdapter,
      loadEnv,
      hasTelegram,
    } = await import('@selfclaude/core');
    const { startInteractive } = await import('@selfclaude/tui');

    const orch = new Orchestrator({ cwd });
    const env = loadEnv();
    let bridge: InstanceType<typeof TelegramBridge> | null = null;

    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try {
        if (bridge) await bridge.stop();
      } catch {
        /* ignore */
      }
      try {
        await orch.stop();
      } catch {
        /* ignore */
      }
    };
    process.on('SIGINT', () => {
      void stop().then(() => process.exit(0));
    });
    process.on('SIGTERM', () => {
      void stop().then(() => process.exit(0));
    });

    const startResult = await orch.start();

    if (hasTelegram(env)) {
      const adapter = new GrammyTelegramAdapter(env.TELEGRAM_BOT_TOKEN!, env.TELEGRAM_CHAT_ID!);
      bridge = new TelegramBridge({ orchestrator: orch, adapter });
      await bridge.start();
    }

    try {
      await startInteractive(orch, startResult);
    } finally {
      await stop();
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
  //
  // On Windows, spawn a .bin/next.cmd file by routing through cmd /c —
  // Node's spawn cannot resolve .cmd files through PATH, so we explicitly
  // invoke cmd.exe to handle it.
  const nextBin = process.platform === 'win32'
    ? ['cmd', '/c', NEXT_BIN]
    : [NEXT_BIN];
  const nextArgs = process.platform === 'win32'
    ? ['dev', '--port', String(opts.nextPort)]
    : ['dev', '--port', String(opts.nextPort)];
  const nextProc = spawn(nextBin[0]!, [...nextBin.slice(1), ...nextArgs], {
    stdio: 'inherit',
    cwd: WEB_DIR,
    detached: true,
  });

  const browserUrl = `http://127.0.0.1:${opts.nextPort}/`;
  if (opts.openBrowser) {
    setTimeout(() => {
      try {
        spawnOpen(browserUrl);
      } catch {
        /* best effort */
      }
    }, 3500);
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
