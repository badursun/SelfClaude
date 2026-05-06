import { execFileSync } from 'node:child_process';

/**
 * Lightweight environment sanity check run at the top of every
 * SelfClaude command path that boots an orchestrator. Surfaces a
 * clear, actionable error before the user lands in a confusing
 * runtime failure (claude subprocess not found, blank web UI, etc.).
 *
 * The single hard requirement is the `claude` CLI (Anthropic Claude
 * Code) — SelfClaude is a wrapper around it, not a replacement. If
 * that's missing, we exit early with an install link.
 *
 * This runs synchronously and exits the process on failure; that's
 * intentional — the CLI shouldn't try to recover from a missing
 * dependency, just tell the operator what to do and bail.
 */
export function ensurePreflight(): void {
  ensureClaudeCli();
  ensureStreamJsonSupport();
}

/**
 * Invoke `claude` in a way that works on both Unix (shebang lookup)
 * and Windows (where the npm-installed binary is a .cmd wrapper that
 * Node's execFileSync can't resolve through PATH).
 *
 * On Windows (process.platform === 'win32') we call
 *   cmd /c claude [args ...]
 * which correctly resolves the .cmd launcher. On other platforms we
 * invoke `claude` directly.
 *
 * When a timeout fires the subprocess is killed and an exception is
 * thrown, matching the behaviour of plain execFileSync.
 */
function claudeSync(args: string[], opts?: { timeout?: number; stdio?: 'pipe' | 'ignore' }): void {
  const timeout = opts?.timeout ?? 0;
  if (process.platform === 'win32') {
    execFileSync('cmd', ['/c', 'claude', ...args], {
      stdio: opts?.stdio ?? 'ignore',
      timeout,
    });
  } else {
    execFileSync('claude', args, {
      stdio: opts?.stdio ?? 'ignore',
      timeout,
    });
  }
}

function ensureClaudeCli(): void {
  try {
    claudeSync(['--version'], { stdio: 'ignore' });
  } catch {
    process.stderr.write(
      [
        '',
        '✗ The `claude` CLI is not installed (or not on PATH).',
        '',
        'SelfClaude orchestrates Claude Code subprocesses — it needs Anthropic\'s',
        'official CLI. Install it, then re-run:',
        '',
        '  https://docs.claude.com/en/docs/claude-code/quickstart',
        '',
        'After install, run `claude` once to sign in (it links to your Anthropic',
        'or Claude account). Then `selfclaude start` will pick it up automatically.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
}

/**
 * Verify that the installed `claude` CLI supports `--output-format stream-json`,
 * which SelfClaude requires for IPC communication with supervisor + specialist
 * agents. Early versions of Claude Code had `stream-json` output but not input;
 * SelfClaude needs `--input-format stream-json` too, which landed in a later
 * release. We detect this by invoking `claude -p --input-format stream-json`
 * with a minimal probe payload and checking the error message.
 *
 * Note: we use `claude -p` (print mode) so the subprocess exits immediately
 * without waiting for interactive input or opening a browser.
 */
function ensureStreamJsonSupport(): void {
  try {
    claudeSync(
      ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json'],
      { stdio: 'pipe', timeout: 5_000 },
    );
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    const stderr = err.stderr ?? '';

    if (stderr.includes('--input-format')) {
      process.stderr.write(
        [
          '',
          '✗ The `claude` CLI is too old for SelfClaude.',
          '',
          'SelfClaude requires Claude Code with `--input-format stream-json` support.',
          'Your current version is missing this flag. Update:',
          '',
          '  npm update -g @anthropic-ai/claude-code',
          '  # or follow the install guide:',
          '  #   https://docs.claude.com/en/docs/claude-code/quickstart',
          '',
          'After updating, run `claude` once to sign in, then `selfclaude start`.',
          '',
        ].join('\n'),
      );
      process.exit(1);
    }
    // Any other error (network timeout, auth, etc.) is not a version problem —
    // let the orchestrator surface the real issue at runtime.
  }
}