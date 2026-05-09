import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildWebApi } from '../src/server/web-api.js';
import { SessionManager } from '../src/server/session-manager.js';
import { appendChatLogEntry } from '../src/project/chat-log.js';

/**
 * End-to-end web-API validation for the Sprint-2 features that shipped
 * with unit coverage but had never been exercised from the HTTP layer
 * until now: Phase 5 isolation discard, Phase 6 decision-report export,
 * Phase 7 turn-error classification, and Phase 7 stuck-detector.
 *
 * Unit tests already pin the pure functions (`discardBranch`,
 * `formatDecisionReport`, `classifyFailure`, `detectStuck`); this file
 * proves the wiring between the Fastify handler / SessionManager /
 * emitter is honest. SSE bytes-on-the-wire is its own concern — we
 * subscribe directly to `ctx.emitter`, which is the same channel
 * `streamSseFromEmitter` consumes; if the emitter fires the right
 * shape, the SSE bridge has nothing left to do but JSON-stringify it.
 */

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

async function withTempGitRepo(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'sc-validate-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 'tester');
    await writeFile(join(dir, 'seed.txt'), 'seed\n');
    // SelfClaude writes .selfclaude/{state,chat-log,…} on session
    // creation; keep the worktree clean so /git/start doesn't trip on
    // `dirty-worktree`. Real users have this rule in their global
    // ignore via the install command.
    await writeFile(join(dir, '.gitignore'), '.selfclaude/\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withApi(
  fn: (server: ReturnType<typeof buildWebApi>, mgr: SessionManager) => Promise<void>,
): Promise<void> {
  const mgr = new SessionManager();
  const server = buildWebApi(mgr);
  try {
    await fn(server, mgr);
  } finally {
    await server.close();
    await mgr.destroyAll();
  }
}

test('Phase 5 — POST /git/start → dirty file → POST /git/discard ends on original branch with clean tree', async () => {
  await withTempGitRepo(async (cwd) => {
    await withApi(async (server) => {
      const create = await server.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { 'content-type': 'application/json' },
        payload: { cwd, label: 'phase5' },
      });
      assert.equal(create.statusCode, 200);
      const { id } = create.json() as { id: string };

      const branch = `selfclaude/${id.slice(0, 8)}`;
      const start = await server.inject({
        method: 'POST',
        url: `/api/sessions/${id}/git/start`,
        headers: { 'content-type': 'application/json' },
        payload: { branch },
      });
      assert.equal(start.statusCode, 200);
      const startBody = start.json() as { ok: boolean; branch: string; originalBranch: string };
      assert.equal(startBody.ok, true);
      assert.equal(startBody.branch, branch);
      assert.equal(startBody.originalBranch, 'main');
      assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), branch);

      // Simulate dev work: untracked file + modified tracked file
      await writeFile(join(cwd, 'dirt.txt'), 'untracked\n');
      await writeFile(join(cwd, 'seed.txt'), 'modified\n');

      const discard = await server.inject({
        method: 'POST',
        url: `/api/sessions/${id}/git/discard`,
        headers: { 'content-type': 'application/json' },
        payload: { branch, originalBranch: 'main' },
      });
      assert.equal(discard.statusCode, 200);
      assert.equal((discard.json() as { ok: boolean }).ok, true);

      assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
      const branches = git(cwd, 'branch', '--format=%(refname:short)').split('\n');
      assert.ok(!branches.includes(branch), `branch ${branch} should be deleted`);
      assert.equal(git(cwd, 'status', '--porcelain'), '', 'worktree should be clean');
      assert.equal(await readFile(join(cwd, 'seed.txt'), 'utf-8'), 'seed\n');
    });
  });
});

test('Phase 6 — GET /decision-report renders markdown + content-disposition with verdict + delegation', async () => {
  await withTempGitRepo(async (cwd) => {
    await withApi(async (server) => {
      const create = await server.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { 'content-type': 'application/json' },
        payload: { cwd, label: 'phase6' },
      });
      const { id } = create.json() as { id: string };

      // Pre-populate one of each decision-class entry. The endpoint
      // reads the JSONL straight from `<cwd>/.selfclaude/chat-log.jsonl`.
      const baseTs = 1_746_000_000_000;
      await appendChatLogEntry(cwd, {
        type: 'verdict',
        id: 1,
        text: 'Lock all admin endpoints behind operator-only auth.',
        ts: baseTs,
      });
      await appendChatLogEntry(cwd, {
        type: 'task-marker',
        summary: 'Implement Phase 5 discard endpoint',
        ts: baseTs + 5_000,
      });

      const res = await server.inject({
        method: 'GET',
        url: `/api/sessions/${id}/decision-report`,
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['content-type'], 'text/markdown; charset=utf-8');
      assert.match(
        String(res.headers['content-disposition'] ?? ''),
        /attachment;\s*filename="decision-report-phase6-/,
      );
      const md = res.body;
      assert.match(md, /# Decision report — phase6/);
      assert.match(md, /\*\*1\*\* verdict\b/);
      assert.match(md, /\*\*1\*\* delegation\b/);
      assert.match(md, /Verdict #001/);
      assert.match(md, /Lock all admin endpoints/);
      assert.match(md, /Implement Phase 5 discard endpoint/);
    });
  });
});

test('Phase 7 — surfaceFailure emits turn-error with the classifier code matching each failure shape', async () => {
  await withTempGitRepo(async (cwd) => {
    await withApi(async (server, mgr) => {
      const create = await server.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { 'content-type': 'application/json' },
        payload: { cwd, label: 'phase7-err' },
      });
      const { id } = create.json() as { id: string };
      const ctx = mgr.getSession(id);
      assert.ok(ctx, 'session ctx');

      type Evt = { kind: string; code?: string; message?: string; role?: string | null };
      const events: Evt[] = [];
      ctx.emitter.on('event', (e: Evt) => events.push(e));

      // One trigger per code. Strings are crafted to match exactly one
      // branch of `classifyFailure` (order matters there — see
      // `failure-modes.ts:167`).
      const cases: Array<readonly [string, string]> = [
        ['Edit tool failed: file not found', 'tool-error'],
        ['claude-code timed out after 30s', 'agent-timeout'],
        ['context window limit reached', 'context-overflow'],
        ['user-prompt-submit hook rejected the message', 'hook-validation'],
        ['ECONNREFUSED 127.0.0.1:443', 'network-error'],
        ['mcp server returned non-zero', 'mcp-crash'],
        ['operation aborted by user', 'agent-aborted'],
        ['weird random failure with no signal', 'unknown'],
      ];
      for (const [msg] of cases) {
        (mgr as unknown as {
          surfaceFailure(ctx: unknown, role: string, msg: string): void;
        }).surfaceFailure(ctx, 'developer', msg);
      }

      const errors = events.filter((e) => e.kind === 'turn-error');
      assert.equal(errors.length, cases.length);
      for (let i = 0; i < cases.length; i++) {
        const [msg, expectedCode] = cases[i]!;
        assert.equal(
          errors[i]!.code,
          expectedCode,
          `case "${msg}" → expected ${expectedCode}, got ${errors[i]!.code}`,
        );
        assert.equal(errors[i]!.message, msg);
        assert.equal(errors[i]!.role, 'developer');
      }
    });
  });
});

test('Phase 7 — checkStuck emits session-stuck only on transitions, recovery fires the inverse', async () => {
  await withTempGitRepo(async (cwd) => {
    await withApi(async (server, mgr) => {
      const create = await server.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { 'content-type': 'application/json' },
        payload: { cwd, label: 'phase7-stuck' },
      });
      const { id } = create.json() as { id: string };
      const ctx = mgr.getSession(id);
      assert.ok(ctx, 'session ctx');

      // Stuck-detector suppresses in discovery/docs by design — push the
      // FSM to phase-loop so the heuristic actually runs. Three sup turns
      // with no progress marker hits the `no-progress-yet` branch.
      ctx.orchestrator.dispatch({ kind: 'set-phase', phase: 'phase-loop' });
      ctx.supMetrics.totalTurns = 3;
      ctx.lastProgressTs = null;
      ctx.busy = null;
      ctx.currentlyStuck = false;

      type Evt = { kind: string; stuck?: boolean; reason?: string };
      const events: Evt[] = [];
      ctx.emitter.on('event', (e: Evt) => events.push(e));

      const checkStuck = (mgr as unknown as { checkStuck(ctx: unknown): void }).checkStuck.bind(
        mgr,
      );

      checkStuck(ctx);
      const stuck1 = events.filter((e) => e.kind === 'session-stuck');
      assert.equal(stuck1.length, 1, 'first transition fires once');
      assert.equal(stuck1[0]!.stuck, true);
      assert.equal(stuck1[0]!.reason, 'no-progress-yet');

      // Same conditions next tick — no transition, no event.
      checkStuck(ctx);
      assert.equal(
        events.filter((e) => e.kind === 'session-stuck').length,
        1,
        'second tick must not double-emit',
      );

      // Recovery: progress lands → stuck=false transition fires.
      ctx.lastProgressTs = Date.now();
      checkStuck(ctx);
      const allStuck = events.filter((e) => e.kind === 'session-stuck');
      assert.equal(allStuck.length, 2, 'recovery emits the inverse transition');
      assert.equal(allStuck[1]!.stuck, false);
    });
  });
});
