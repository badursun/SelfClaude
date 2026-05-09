import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { SessionManager } from './session-manager.js';
import { resolveSseOrigin, streamSseFromEmitter } from './sse.js';
import { addFavorite, listFavorites, removeFavorite } from './favorites.js';
import { listRecents, removeRecent } from './recents.js';
import { configureLogFile, log } from '../lib/log.js';

export interface WebApiOptions {
  port?: number;
  host?: string;
  manager?: SessionManager;
}

export interface WebApiHandle {
  server: FastifyInstance;
  manager: SessionManager;
  url: string;
  port: number;
}

const VERSION = '0.1.0';

export function buildWebApi(manager: SessionManager): FastifyInstance {
  const server = Fastify({ logger: false });

  // Buffer raw uploads (operator reference docs land here as
  // `application/octet-stream`). Default body parser only handles
  // JSON / urlencoded, so refs uploads would otherwise 415 out.
  server.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  // CORS — localhost-bound API, accept any origin so the Next dev server
  // (port 3000) can talk directly to the API (port 7423). This bypasses
  // Next.js's rewrite proxy, which buffers SSE responses in dev and
  // breaks token streaming.
  server.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'DELETE', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    credentials: false,
  });

  // Rate limiting — a thin guard against runaway loops, not against
  // adversarial traffic (the API binds 127.0.0.1, so the actual
  // attack surface is local processes only). Defaults are generous;
  // hot endpoints get tighter caps below at the per-route level.
  // Tests hit fastify.inject() which goes through this hook — under
  // the global cap of 200/min we never collide in practice.
  //
  // Suggested by PR #1 (Ersin KOÇ — security pass).
  server.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      const fwd = req.headers['x-forwarded-for'];
      if (typeof fwd === 'string') return fwd.split(',')[0]!.trim();
      return req.ip ?? '127.0.0.1';
    },
  });

  /** Per-route rate-limit overrides — applied on the routes that can spike. */
  const SESSION_CREATE_LIMIT = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  const MESSAGE_LIMIT = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

  server.get('/api/health', async () => ({
    version: VERSION,
    uptime: process.uptime(),
    sessions: manager.listSessions().length,
  }));

  server.get('/api/sessions', async () => ({ sessions: manager.listSessions() }));

  server.post('/api/sessions', { ...SESSION_CREATE_LIMIT }, async (req, reply) => {
    const Schema = z.object({ cwd: z.string().min(1), label: z.string().optional() });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const meta = await manager.createSession(parsed.data);
      return meta;
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  /**
   * Probe whether a cwd is a previously-initialized SelfClaude project.
   * The wizard only appears for fresh projects — without this probe
   * the frontend would show it after every daemon restart for
   * already-onboarded folders (the in-memory session list is empty
   * post-restart even when `.selfclaude/state.json` exists on disk).
   */
  server.get('/api/projects/probe', async (req, reply) => {
    const Schema = z.object({ cwd: z.string().min(1) });
    const parsed = Schema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const statePath = join(parsed.data.cwd, '.selfclaude', 'state.json');
    let exists = false;
    try {
      const st = await stat(statePath);
      exists = st.isFile();
    } catch {
      /* missing → fresh project */
    }
    return { cwd: parsed.data.cwd, exists };
  });

  server.delete('/api/sessions/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      await manager.destroySession(id);
      return reply.code(204).send();
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  server.get('/api/sessions/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const Q = z.object({
      // Cap at 1000 to prevent accidental "give me everything" requests
      // that defeat the lazy-load purpose.
      limit: z.coerce.number().int().min(1).max(1000).optional(),
    });
    const parsed = Q.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const snap = await manager.getSnapshot(id, { limit: parsed.data.limit });
    if (!snap) return reply.code(404).send({ error: 'session not found' });
    return snap;
  });

  /**
   * Project tech-stack manifest at `<cwd>/.selfclaude/stack.json`.
   * Schema-driven structured store so the operator + all agents share
   * one source of truth on framework / language / runtime / library
   * choices. Agents query individual categories via MCP (token saver);
   * operator edits via the Stack sidebar tab.
   */
  server.get('/api/sessions/:id/stack', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ctx = manager.getSession(id);
    if (!ctx) return reply.code(404).send({ error: 'session not found' });
    const { readStack } = await import('../project/stack-store.js');
    const stack = await readStack(ctx.cwd);
    return stack;
  });

  server.put('/api/sessions/:id/stack', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ctx = manager.getSession(id);
    if (!ctx) return reply.code(404).send({ error: 'session not found' });
    const { StackFileSchema, writeStack } = await import('../project/stack-store.js');
    const parsed = StackFileSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    await writeStack(ctx.cwd, parsed.data);
    return { ok: true };
  });

  /**
   * Phase progress for the left sidebar. Walks `docs/phases/*.md`,
   * parses markdown checkbox DoD items, returns per-phase completion.
   */
  server.get('/api/sessions/:id/phases', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = await manager.getPhaseProgress(id);
    if (!r) return reply.code(404).send({ error: 'session not found' });
    return r;
  });

  /**
   * Phase 6 (Replay & audit) sprint 2 — markdown decision report.
   * Reads the full chat-log for this session, runs it through the
   * decision-report formatter, and serves the result as a downloadable
   * `.md` file. The frontend's "Export" button on the Decision Trail
   * panel triggers this endpoint and saves the response with the
   * suggested filename.
   *
   * No auth (loopback-bound API). The chat-log is the operator's own
   * data — they're the only consumer.
   */
  server.get('/api/sessions/:id/decision-report', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ctx = manager.getSession(id);
    if (!ctx) return reply.code(404).send({ error: 'session not found' });
    const { readChatLog } = await import('../project/chat-log.js');
    const { decisionReportFilename, formatDecisionReport } = await import(
      './decision-report.js'
    );
    const chatLog = await readChatLog(ctx.cwd);
    const firstEntryAt = chatLog.length > 0 ? chatLog[0]!.ts : null;
    const lastEntryAt = chatLog.length > 0 ? chatLog[chatLog.length - 1]!.ts : null;
    const meta = {
      label: ctx.label,
      cwd: ctx.cwd,
      sessionId: id,
      generatedAt: Date.now(),
      firstEntryAt,
      lastEntryAt,
    };
    const md = formatDecisionReport(chatLog, meta);
    const filename = decisionReportFilename(meta);
    reply
      .type('text/markdown; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(md);
    return reply;
  });

  /**
   * Phase 2 telemetry — per-session rollup of activity metrics.
   * Reads the `<cwd>/.selfclaude/session-metrics.jsonl` event log,
   * filters to this session id, and returns a rollup with raw
   * counters: turns, tool calls, files touched, duration, and the
   * phase-contract first-pass / ultimate-pass aggregate. Per ROADMAP
   * calibration #2: the API exposes RAW numbers; the UI is responsible
   * for any "estimate" panel and must label estimates as such.
   */
  server.get('/api/sessions/:id/metrics', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ctx = manager.getSession(id);
    if (!ctx) return reply.code(404).send({ error: 'session not found' });
    const { computeSessionRollup, readSessionMetrics } = await import(
      '../project/session-metrics-store.js'
    );
    const events = await readSessionMetrics(ctx.cwd, id);
    return computeSessionRollup(events, id);
  });

  /**
   * Phase 2 telemetry — project-wide rollup across every session for a
   * cwd. Used by the home-page project card to show cumulative
   * activity ("you've worked X turns / touched Y files in this
   * project total"). Path is keyed on `cwd` (query param) rather than
   * a session id because the rollup spans sessions, including
   * destroyed ones.
   */
  server.get('/api/projects/metrics', async (req, reply) => {
    const Q = z.object({ cwd: z.string().min(1) });
    const parsed = Q.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { computeProjectRollup, readSessionMetrics } = await import(
      '../project/session-metrics-store.js'
    );
    const events = await readSessionMetrics(parsed.data.cwd);
    return computeProjectRollup(events);
  });

  /**
   * Phase 5 (Trust v1) — git branch isolation endpoints. Each operates
   * on a session's cwd. The module is intentionally stateless:
   * caller passes branch + originalBranch on every call (the next
   * sub-sprint persists the pair into a per-session isolation file
   * and adds a status-bar widget that drives these from the UI).
   *
   * NOTHING here pushes, force-pushes, or modifies branches the
   * operator created. See the safety contract at the top of
   * git-isolation.ts.
   */
  server.get('/api/sessions/:id/git/repo-state', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ctx = manager.getSession(id);
    if (!ctx) return reply.code(404).send({ error: 'session not found' });
    const { detectRepoState } = await import('./git-isolation.js');
    return detectRepoState(ctx.cwd);
  });

  /**
   * Combined state endpoint the UI polls every few seconds. Returns
   * both repo metadata AND the persisted isolation state in one
   * round-trip so the status-bar widget doesn't render a flicker
   * waiting on two separate calls. When isolation is active and the
   * branch exists, also includes live `branchStatus` so the badge
   * can show commit counts without a third call.
   */
  server.get('/api/sessions/:id/git/isolation-state', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ctx = manager.getSession(id);
    if (!ctx) return reply.code(404).send({ error: 'session not found' });
    const { detectRepoState, getBranchStatus, branchExists } = await import(
      './git-isolation.js'
    );
    const [repoState, persisted] = await Promise.all([
      detectRepoState(ctx.cwd),
      Promise.resolve(ctx.gitIsolation),
    ]);
    let branchStatus: Awaited<ReturnType<typeof getBranchStatus>> | null = null;
    let branchExistsOnDisk = false;
    if (persisted?.enabled) {
      branchExistsOnDisk = await branchExists(ctx.cwd, persisted.branch);
      if (branchExistsOnDisk) {
        try {
          branchStatus = await getBranchStatus(
            ctx.cwd,
            persisted.branch,
            persisted.originalBranch,
          );
        } catch {
          /* drift — branch exists but originalBranch was deleted */
        }
      }
    }
    return {
      repoState,
      isolation: persisted,
      branchStatus,
      /** True when persisted state claims isolation but the branch is gone (drift). */
      branchExistsOnDisk: persisted?.enabled ? branchExistsOnDisk : null,
    };
  });

  server.get('/api/sessions/:id/git/branch-status', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ctx = manager.getSession(id);
    if (!ctx) return reply.code(404).send({ error: 'session not found' });
    const Q = z.object({ branch: z.string().min(1), originalBranch: z.string().min(1) });
    const parsed = Q.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { getBranchStatus } = await import('./git-isolation.js');
    return getBranchStatus(ctx.cwd, parsed.data.branch, parsed.data.originalBranch);
  });

  server.post('/api/sessions/:id/git/start', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ctx = manager.getSession(id);
    if (!ctx) return reply.code(404).send({ error: 'session not found' });
    const Body = z.object({ branch: z.string().min(1) });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { createSessionBranch } = await import('./git-isolation.js');
    const { writeGitIsolation } = await import('../project/git-isolation-store.js');
    const r = await createSessionBranch(ctx.cwd, parsed.data.branch);
    if (!r.ok) return reply.code(409).send(r);
    // Persist the {branch, originalBranch} pair + hydrate the
    // SessionContext so the auto-commit hook and the UI see consistent
    // state on the very next turn.
    const startedAt = Date.now();
    await writeGitIsolation(ctx.cwd, {
      version: 1,
      enabled: true,
      branch: r.branch,
      originalBranch: r.originalBranch,
      startedAt,
      lastCommitAt: null,
    });
    ctx.gitIsolation = {
      enabled: true,
      branch: r.branch,
      originalBranch: r.originalBranch,
      startedAt,
      lastCommitAt: null,
    };
    return r;
  });

  server.post('/api/sessions/:id/git/commit', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ctx = manager.getSession(id);
    if (!ctx) return reply.code(404).send({ error: 'session not found' });
    const Body = z.object({ message: z.string().min(1).max(500) });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { commitTurn } = await import('./git-isolation.js');
    try {
      const r = await commitTurn(ctx.cwd, parsed.data.message);
      return r;
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  server.post('/api/sessions/:id/git/accept', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ctx = manager.getSession(id);
    if (!ctx) return reply.code(404).send({ error: 'session not found' });
    const Body = z.object({
      branch: z.string().min(1),
      originalBranch: z.string().min(1),
      message: z.string().min(1).max(500),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { acceptIntoOriginal } = await import('./git-isolation.js');
    const { clearGitIsolation } = await import('../project/git-isolation-store.js');
    const r = await acceptIntoOriginal(
      ctx.cwd,
      parsed.data.branch,
      parsed.data.originalBranch,
      parsed.data.message,
    );
    if (!r.ok) return reply.code(409).send(r);
    await clearGitIsolation(ctx.cwd);
    ctx.gitIsolation = null;
    return r;
  });

  server.post('/api/sessions/:id/git/discard', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ctx = manager.getSession(id);
    if (!ctx) return reply.code(404).send({ error: 'session not found' });
    const Body = z.object({
      branch: z.string().min(1),
      originalBranch: z.string().min(1),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { discardBranch } = await import('./git-isolation.js');
    const { clearGitIsolation } = await import('../project/git-isolation-store.js');
    const r = await discardBranch(ctx.cwd, parsed.data.branch, parsed.data.originalBranch);
    if (!r.ok) return reply.code(409).send(r);
    await clearGitIsolation(ctx.cwd);
    ctx.gitIsolation = null;
    return r;
  });

  /**
   * Operator-attached reference documents.
   *
   * Files persist under `<cwd>/.selfclaude/refs/`; the supervisor sees
   * a manifest (filename + size) appended to its system prompt every
   * turn, and reads file contents lazily with the regular Read tool.
   * Adds and removes journal into chat-log so the decision-report can
   * show what context the operator handed the session, and when.
   *
   * Upload format is `application/octet-stream` with the desired
   * filename in the `?name=` query param — no multipart parser needed,
   * no base64 inflation. The route's bodyLimit overrides the API
   * default (1 MB) to match the storage cap (5 MB).
   */
  server.get('/api/sessions/:id/refs', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ctx = manager.getSession(id);
    if (!ctx) return reply.code(404).send({ error: 'session not found' });
    const { listRefs } = await import('../project/refs-store.js');
    return { refs: await listRefs(ctx.cwd) };
  });

  server.post(
    '/api/sessions/:id/refs',
    {
      bodyLimit: 6 * 1024 * 1024,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const ctx = manager.getSession(id);
      if (!ctx) return reply.code(404).send({ error: 'session not found' });
      const Query = z.object({ name: z.string().min(1).max(200) });
      const parsed = Query.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }
      if (!Buffer.isBuffer(req.body)) {
        return reply
          .code(400)
          .send({ error: 'body must be application/octet-stream bytes' });
      }
      const { addRef } = await import('../project/refs-store.js');
      const { appendChatLogEntry } = await import('../project/chat-log.js');
      const r = await addRef(ctx.cwd, parsed.data.name, req.body);
      if (!r.ok) {
        const code = r.reason === 'too-large' ? 413 : 400;
        return reply.code(code).send(r);
      }
      // Audit trail. Best-effort: a chat-log write failure here must
      // not roll back the upload — the file is on disk and the
      // operator can see it in the next list call.
      void appendChatLogEntry(ctx.cwd, {
        type: 'ref-added',
        name: r.meta.name,
        sizeBytes: r.meta.sizeBytes,
        ts: Date.now(),
      }).catch(() => {});
      return r;
    },
  );

  server.delete('/api/sessions/:id/refs/:name', async (req, reply) => {
    const params = req.params as { id: string; name: string };
    const ctx = manager.getSession(params.id);
    if (!ctx) return reply.code(404).send({ error: 'session not found' });
    const { removeRef, isValidRefName } = await import('../project/refs-store.js');
    if (!isValidRefName(params.name)) {
      return reply.code(400).send({ error: 'invalid filename' });
    }
    const removed = await removeRef(ctx.cwd, params.name);
    if (!removed) return reply.code(404).send({ error: 'ref not found' });
    const { appendChatLogEntry } = await import('../project/chat-log.js');
    void appendChatLogEntry(ctx.cwd, {
      type: 'ref-removed',
      name: params.name,
      ts: Date.now(),
    }).catch(() => {});
    return { ok: true };
  });

  server.get('/api/sessions/:id/refs/:name', async (req, reply) => {
    const params = req.params as { id: string; name: string };
    const ctx = manager.getSession(params.id);
    if (!ctx) return reply.code(404).send({ error: 'session not found' });
    const { readRef, isValidRefName } = await import('../project/refs-store.js');
    if (!isValidRefName(params.name)) {
      return reply.code(400).send({ error: 'invalid filename' });
    }
    const buf = await readRef(ctx.cwd, params.name);
    if (!buf) return reply.code(404).send({ error: 'ref not found' });
    reply
      .type('application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${params.name}"`)
      .send(buf);
    return reply;
  });

  /**
   * Phase tracker — the structured progress source (`<cwd>/.selfclaude/phases.json`).
   * Supersedes the markdown-checkbox parser for sessions where the
   * supervisor has registered phase items via `register_phase_items`.
   * The frontend reads this on mount and on the `phase-tracker-updated`
   * SSE event to refresh.
   */
  server.get('/api/sessions/:id/phase-tracker', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = await manager.getPhaseTracker(id);
    if (!r) return reply.code(404).send({ error: 'session not found' });
    return r;
  });

  /**
   * MCP tool telemetry — usage counts + recent calls per tool. Backs
   * the Settings modal's "MCP Tools" tab so the operator can see at a
   * glance which tools the supervisor actually uses (and which prompt
   * directives are being skipped).
   */
  server.get('/api/sessions/:id/mcp-telemetry', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = await manager.getMcpTelemetry(id);
    if (!r) return reply.code(404).send({ error: 'session not found' });
    return r;
  });

  /**
   * Bash macro / script proposal endpoints. The supervisor proposes
   * via the MCP path (`/mcp/propose_script`); the operator reviews
   * and approves/rejects through these REST handlers from the
   * Scripts panel UI.
   */
  server.get('/api/sessions/:id/scripts', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = await manager.getSessionScripts(id);
    if (!r) return reply.code(404).send({ error: 'session not found' });
    return r;
  });

  server.post('/api/sessions/:id/scripts/approve', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const Body = z.object({
      slug: z.string().min(1),
      operator: z.string().default('operator'),
      notes: z.string().optional(),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid' });
    }
    const r = await manager.approveSessionScript(
      id,
      parsed.data.slug,
      parsed.data.operator,
      parsed.data.notes,
    );
    if (!r) return reply.code(404).send({ error: 'session not found' });
    if (!r.ok) return reply.code(400).send({ error: r.message });
    return r;
  });

  server.post('/api/sessions/:id/scripts/reject', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const Body = z.object({
      slug: z.string().min(1),
      operator: z.string().default('operator'),
      reason: z.string().min(1),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid' });
    }
    const r = await manager.rejectSessionScript(
      id,
      parsed.data.slug,
      parsed.data.operator,
      parsed.data.reason,
    );
    if (!r) return reply.code(404).send({ error: 'session not found' });
    if (!r.ok) return reply.code(400).send({ error: r.message });
    return r;
  });

  /**
   * Operator-verify a confirmed-but-empty-evidence item — clears the
   * ⚠ flag the UI shows for drive-by confirms. Operator clicks
   * "Mark as operator-verified" in the phase item detail modal.
   */
  server.post('/api/sessions/:id/phase-tracker/operator-verify', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = req.body as {
      slug?: unknown;
      itemId?: unknown;
      notes?: unknown;
    } | null;
    const slug = typeof body?.slug === 'string' ? body.slug : '';
    const itemId = typeof body?.itemId === 'string' ? body.itemId : '';
    const notes = typeof body?.notes === 'string' ? body.notes : undefined;
    if (!slug || !itemId) {
      return reply.code(400).send({ error: 'slug and itemId required' });
    }
    const r = await manager.operatorVerifyPhaseItem(id, slug, itemId, notes);
    if (!r) return reply.code(404).send({ error: 'session not found' });
    if (!r.ok) return reply.code(400).send({ error: r.message });
    return r;
  });

  /**
   * One-shot derived state for the right-hand detail tabs (Tasks /
   * Schedule / Files). Reads the session's full chat-log and aggregates
   * todos, wakeups, crons, and file ops in a single pass — independent
   * of the lazy-loaded chatLog window the chat panes display.
   */
  server.get('/api/sessions/:id/derived', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = await manager.getDerivedState(id);
    if (!r) return reply.code(404).send({ error: 'session not found' });
    return r;
  });

  /**
   * Aggregated file activity for the session: every Read/Edit/Write the
   * developer has issued, deduped per path, latest action wins. Powers
   * the Files tab — independent of the lazy-loaded chatLog window so the
   * operator sees the full session history, not just the visible page.
   */
  server.get('/api/sessions/:id/files-touched', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ops = await manager.getFileOperations(id);
    if (!ops) return reply.code(404).send({ error: 'session not found' });
    return ops;
  });

  /**
   * Older chat-log window for the session view's lazy-load. Returns up to
   * `limit` entries with `ts < before`, ascending. Frontend prepends them
   * to the current chatLog and bumps its `oldestLoadedTs`.
   */
  server.get('/api/sessions/:id/history', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const Q = z.object({
      before: z.coerce.number().int().positive(),
      limit: z.coerce.number().int().min(1).max(500).default(50),
    });
    const parsed = Q.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const history = await manager.getHistory(id, parsed.data.before, parsed.data.limit);
    if (!history) return reply.code(404).send({ error: 'session not found' });
    return history;
  });

  server.post('/api/sessions/:id/message', { ...MESSAGE_LIMIT }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const Schema = z.object({ text: z.string().min(1) });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      await manager.sendMessage(id, parsed.data.text);
      return reply.code(202).send({ accepted: true });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  server.post('/api/sessions/:id/dev-message', { ...MESSAGE_LIMIT }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const Schema = z.object({ text: z.string().min(1) });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      await manager.messageDeveloper(id, parsed.data.text);
      return reply.code(202).send({ accepted: true });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /**
   * Direct-message any specialist agent (ui-dev, security, future custom
   * roles). Same shape as `/dev-message` but takes the target `agent`
   * name. Used by the per-tab input bars in the agent pane.
   */
  server.post('/api/sessions/:id/agent-message', { ...MESSAGE_LIMIT }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const Schema = z.object({
      agent: z.string().min(1),
      text: z.string().min(1),
    });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      await manager.messageAgent(id, parsed.data.agent, parsed.data.text);
      return reply.code(202).send({ accepted: true });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  server.post('/api/sessions/:id/answer-question', { ...MESSAGE_LIMIT }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const Schema = z.object({ questionId: z.string(), answer: z.string() });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const ok = await manager.resolveQuestion(id, parsed.data.questionId, parsed.data.answer);
    return { ok };
  });

  server.post('/api/sessions/:id/decide-approval', { ...MESSAGE_LIMIT }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const Schema = z.object({
      approvalId: z.string(),
      decision: z.enum(['allow', 'deny']),
    });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const ok = await manager.resolveApproval(id, parsed.data.approvalId, parsed.data.decision);
    return { ok };
  });

  /**
   * Operator emergency stop: SIGTERM the in-flight CC subprocess. The
   * `role` field is informational; we always abort whatever turn is
   * currently running (sup OR dev — only one runs at a time).
   */
  server.post('/api/sessions/:id/abort', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const Schema = z.object({ role: z.enum(['supervisor', 'developer']) });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const result = manager.abortTurn(id, parsed.data.role);
      return result;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /**
   * Manually trigger an agent's pending wakeup. Useful when the operator
   * doesn't want to wait for the scheduled timer or when a legacy wakeup
   * (recorded before the orchestrator-level runner existed) is stuck.
   */
  server.post('/api/sessions/:id/wake', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const Schema = z.object({ role: z.enum(['supervisor', 'developer']) });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const fired = await manager.triggerWakeup(id, parsed.data.role);
      return { fired };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  server.get('/api/sessions/:id/events', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ctx = manager.getSession(id);
    if (!ctx) {
      return reply.code(404).send({ error: 'session not found' });
    }
    // Validate Origin against the localhost allowlist; the SSE response
    // carries `Access-Control-Allow-Origin: <origin>` only for matches.
    streamSseFromEmitter(reply, ctx.emitter, resolveSseOrigin(req));
  });

  /**
   * List every known agent's system-prompt source: bundled default vs
   * user-override (`~/.selfclaude/system-prompts/<file>`). Powers the
   * Settings modal's prompt editor — operator sees who's currently
   * customised vs running the shipped default, and edits live in the
   * override directory so the package source stays clean.
   */
  server.get('/api/system-prompts', async () => {
    const { listAgents, agentPromptOverridePath, agentPromptDefaultPath } = await import(
      '../agents/registry.js'
    );
    const fs = await import('node:fs/promises');
    const out: Array<{
      agent: string;
      label: string;
      accent: string;
      readOnly: boolean;
      description: string;
      source: 'override' | 'default';
      defaultContent: string;
      currentContent: string;
    }> = [];
    for (const cfg of listAgents()) {
      const overridePath = agentPromptOverridePath(cfg.systemPromptFile);
      const defaultPath = agentPromptDefaultPath(cfg.systemPromptFile);
      let defaultContent = '';
      try {
        defaultContent = await fs.readFile(defaultPath, 'utf8');
      } catch {
        /* shouldn't happen for built-ins */
      }
      let currentContent = defaultContent;
      let source: 'override' | 'default' = 'default';
      try {
        currentContent = await fs.readFile(overridePath, 'utf8');
        source = 'override';
      } catch {
        // No override — currentContent stays as the bundled default.
      }
      out.push({
        agent: cfg.name,
        label: cfg.label,
        accent: cfg.accent,
        readOnly: cfg.readOnly,
        description: cfg.description,
        source,
        defaultContent,
        currentContent,
      });
    }
    return { prompts: out };
  });

  /**
   * Write an override prompt to `~/.selfclaude/system-prompts/<file>`.
   * The next agent turn picks it up automatically (registry's
   * `loadAgentPrompt` is mtime-cached and re-reads on change).
   */
  server.put('/api/system-prompts/:agent', async (req, reply) => {
    const agentName = (req.params as { agent: string }).agent;
    const Body = z.object({ content: z.string().min(1).max(64 * 1024) });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { getAgent, agentPromptOverridePath, clearPromptCache } = await import(
      '../agents/registry.js'
    );
    const cfg = getAgent(agentName);
    if (!cfg) return reply.code(404).send({ error: `unknown agent: ${agentName}` });
    const overridePath = agentPromptOverridePath(cfg.systemPromptFile);
    const fs = await import('node:fs/promises');
    await fs.mkdir(dirname(overridePath), { recursive: true });
    await fs.writeFile(overridePath, parsed.data.content, 'utf8');
    clearPromptCache();
    return { ok: true, path: overridePath, size: parsed.data.content.length };
  });

  /**
   * Drop the override and revert the agent to its bundled default. The
   * registry's resolution falls back transparently once the override
   * file disappears.
   */
  server.delete('/api/system-prompts/:agent', async (req, reply) => {
    const agentName = (req.params as { agent: string }).agent;
    const { getAgent, agentPromptOverridePath, clearPromptCache } = await import(
      '../agents/registry.js'
    );
    const cfg = getAgent(agentName);
    if (!cfg) return reply.code(404).send({ error: `unknown agent: ${agentName}` });
    const overridePath = agentPromptOverridePath(cfg.systemPromptFile);
    const fs = await import('node:fs/promises');
    try {
      await fs.unlink(overridePath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') return reply.code(500).send({ error: (e as Error).message });
    }
    clearPromptCache();
    return { ok: true };
  });

  server.get('/api/favorites', async () => ({ favorites: listFavorites() }));

  server.post('/api/favorites', async (req, reply) => {
    const Schema = z.object({ cwd: z.string().min(1), label: z.string().optional() });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const fav = addFavorite(parsed.data.cwd, parsed.data.label);
    return fav;
  });

  server.delete('/api/favorites', async (req, reply) => {
    const Schema = z.object({ cwd: z.string().min(1) });
    const parsed = Schema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const removed = removeFavorite(parsed.data.cwd);
    return { removed };
  });

  server.get('/api/recents', async () => ({ recents: listRecents() }));

  server.delete('/api/recents', async (req, reply) => {
    const Schema = z.object({ cwd: z.string().min(1) });
    const parsed = Schema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const removed = removeRecent(parsed.data.cwd);
    return { removed };
  });

  /**
   * Phase 3 — Quickstart demo. Creates a fresh demo workspace under
   * `~/.selfclaude/demos/demo-<ts>/`, opens a session against it, and
   * returns the canned demo prompt for the frontend to auto-fill in
   * the chat box. The operator clicks send and watches the
   * orchestration produce a single-file portfolio HTML in 2-3 turns.
   *
   * The demo dir is created lazily by Orchestrator.start() — we just
   * pass the path; SessionManager handles the rest.
   */
  server.post('/api/demo/start', async (_req, reply) => {
    const { newDemoWorkspaceDir, DEMO_PROMPT } = await import('./demo-template.js');
    const { mkdir } = await import('node:fs/promises');
    const cwd = newDemoWorkspaceDir();
    try {
      await mkdir(cwd, { recursive: true });
      const meta = await manager.createSession({ cwd, label: 'Demo — Portfolio HTML' });
      return { sessionId: meta.id, cwd: meta.cwd, prompt: DEMO_PROMPT };
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  /**
   * Phase 3 — probe whether the demo artifact exists on disk yet.
   * The frontend's "Open Result" button polls this every few seconds
   * while sup + dev are working, and shows the button once the file
   * appears. Path is constrained to the demos root for the same
   * reason `/api/demo/open` is.
   */
  server.get('/api/demo/artifact-exists', async (req, reply) => {
    const Schema = z.object({ path: z.string().min(1) });
    const parsed = Schema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { homedir } = await import('node:os');
    const { join: joinPath } = await import('node:path');
    const demosRoot = await realpath(joinPath(homedir(), '.selfclaude', 'demos')).catch(
      () => null,
    );
    if (!demosRoot) return { exists: false };
    let resolved: string;
    try {
      resolved = await realpath(parsed.data.path);
    } catch {
      return { exists: false };
    }
    const rel = relative(demosRoot, resolved);
    if (rel.startsWith('..') || rel.startsWith('/') || rel.length === 0) {
      return reply.code(400).send({ error: 'path is outside the demos directory' });
    }
    try {
      const st = await stat(resolved);
      return { exists: st.isFile() };
    } catch {
      return { exists: false };
    }
  });

  /**
   * Phase 3 — open the demo artifact in the operator's default app
   * (browser for `.html`). Path is restricted to
   * `~/.selfclaude/demos/`-rooted files to prevent the endpoint
   * becoming an arbitrary-file launcher. Validates via realpath, not
   * string-startsWith — symlinks must not bypass the boundary.
   */
  server.post('/api/demo/open', async (req, reply) => {
    const Schema = z.object({ path: z.string().min(1) });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { homedir } = await import('node:os');
    const { join: joinPath } = await import('node:path');
    const { spawn } = await import('node:child_process');
    const demosRoot = await realpath(joinPath(homedir(), '.selfclaude', 'demos')).catch(
      () => null,
    );
    if (!demosRoot) {
      return reply.code(400).send({ error: 'demo root does not exist yet' });
    }
    let resolved: string;
    try {
      resolved = await realpath(parsed.data.path);
    } catch {
      return reply.code(404).send({ error: 'file not found' });
    }
    const rel = relative(demosRoot, resolved);
    if (rel.startsWith('..') || rel.startsWith('/') || rel.length === 0) {
      return reply.code(400).send({ error: 'path is outside the demos directory' });
    }
    const cmd =
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'start'
          : 'xdg-open';
    const args = process.platform === 'win32' ? ['', resolved] : [resolved];
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true, opened: resolved };
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  /**
   * Curated project-file index for the left sidebar. Returns a tree limited
   * to interesting top-level directories (`docs`, `prompts`, `.selfclaude`,
   * `.claude` if present) plus root-level Markdown / config so the operator
   * can browse without seeing node_modules and friends. Each session is
   * isolated to its own cwd; cross-session reads aren't allowed.
   */
  server.get('/api/sessions/:id/files', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ctx = manager.getSession(id);
    if (!ctx) return reply.code(404).send({ error: 'session not found' });
    const tree = await buildProjectTree(ctx.cwd);
    return tree;
  });

  /**
   * Unified memory overview — all memory layers for this session in
   * a single roundtrip with content previews. The Memory panel uses
   * this so it can render at-a-glance previews without per-file
   * fetches and without losing the supervisor's edits to CC's auto-
   * memory bucket (which lives outside cwd).
   *
   * Layers:
   *
   *   - `project` (`<cwd>/CLAUDE.md`, `<cwd>/AGENTS.md`) — editable
   *   - `shared` (`<cwd>/.selfclaude/memory/*.md`) — editable
   *   - `auto` (`~/.claude/projects/<encoded-cwd>/memory/*.md`) — editable
   *   - `userGlobal` (`~/.claude/CLAUDE.md`) — read-only
   *
   * Each entry includes a `preview` (~200 chars, first paragraph) so
   * the panel can show the gist without round-tripping for every row.
   */
  server.get('/api/sessions/:id/memory-overview', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ctx = manager.getSession(id);
    if (!ctx) return reply.code(404).send({ error: 'session not found' });
    return readMemoryOverview(ctx.cwd);
  });

  /**
   * Claude Code's per-cwd auto-memory directory (`~/.claude/projects/
   * <encoded-cwd>/memory/`) plus the user-global `~/.claude/CLAUDE.md`.
   * Read/write of individual files uses `.../auto-memory/file/:name`,
   * sandboxed to the bucket via filename validation.
   */
  server.get('/api/sessions/:id/auto-memory', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ctx = manager.getSession(id);
    if (!ctx) return reply.code(404).send({ error: 'session not found' });
    const result = await readAutoMemory(ctx.cwd);
    return result;
  });

  server.get('/api/sessions/:id/auto-memory/file/:name', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ctx = manager.getSession(id);
    if (!ctx) return reply.code(404).send({ error: 'session not found' });
    const name = (req.params as { name: string }).name;
    if (!isSafeAutoMemoryName(name)) {
      return reply.code(400).send({ error: 'invalid filename' });
    }
    const dir = autoMemoryDir(ctx.cwd);
    const target = join(dir, name);
    try {
      const st = await stat(target);
      if (!st.isFile()) return reply.code(400).send({ error: 'not a regular file' });
      if (st.size > 256 * 1024) {
        return reply.code(413).send({ error: 'file too large' });
      }
      const content = await readFile(target, 'utf8');
      return { name, size: st.size, content };
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  server.put('/api/sessions/:id/auto-memory/file/:name', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ctx = manager.getSession(id);
    if (!ctx) return reply.code(404).send({ error: 'session not found' });
    const name = (req.params as { name: string }).name;
    if (!isSafeAutoMemoryName(name)) {
      return reply.code(400).send({ error: 'invalid filename' });
    }
    const Body = z.object({ content: z.string().max(64 * 1024) });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const { writeFile, mkdir } = await import('node:fs/promises');
    const dir = autoMemoryDir(ctx.cwd);
    const target = join(dir, name);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(target, parsed.data.content, 'utf8');
      return { ok: true, name, size: parsed.data.content.length };
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  /**
   * Write a file's contents from the UI memory/prompts editor. Same
   * sandbox as `GET /file` (path must resolve under the session's cwd
   * post-realpath), plus an extension whitelist (`.md` / `.txt` / `.json`
   * / `.yaml` / `.yml`) and a 64 KB cap. Refuses to overwrite directories.
   */
  server.put('/api/sessions/:id/file', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ctx = manager.getSession(id);
    if (!ctx) return reply.code(404).send({ error: 'session not found' });
    const Body = z.object({
      path: z.string().min(1),
      content: z.string().max(64 * 1024),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const ALLOWED_EXT = ['.md', '.txt', '.json', '.yaml', '.yml'];
    const lower = parsed.data.path.toLowerCase();
    if (!ALLOWED_EXT.some((e) => lower.endsWith(e))) {
      return reply.code(400).send({
        error: `extension not allowed; permitted: ${ALLOWED_EXT.join(', ')}`,
      });
    }

    const { writeFile, mkdir, stat: fsStat } = await import('node:fs/promises');
    const requested = resolve(ctx.cwd, parsed.data.path);
    const realRoot = await realpath(ctx.cwd);
    // We can't realpath a not-yet-existing target, so realpath the parent
    // dir instead and rebuild the full path from there. If the parent
    // doesn't exist we bail (refuse to mkdir arbitrary paths via the API).
    let realParent: string;
    try {
      realParent = await realpath(dirname(requested));
    } catch {
      return reply.code(400).send({ error: 'parent directory does not exist' });
    }
    const realTarget = join(realParent, requested.slice(dirname(requested).length).replace(/^\//, ''));
    const rel = relative(realRoot, realTarget);
    if (rel.startsWith('..') || resolve(realRoot, rel) !== realTarget) {
      return reply.code(403).send({ error: 'path escapes session cwd' });
    }
    try {
      // If a directory exists at the target we'd corrupt the FS by writing.
      try {
        const st = await fsStat(realTarget);
        if (st.isDirectory()) {
          return reply.code(400).send({ error: 'target is a directory' });
        }
      } catch {
        /* file doesn't exist yet — that's fine, we'll create it */
      }
      await mkdir(dirname(realTarget), { recursive: true });
      await writeFile(realTarget, parsed.data.content, 'utf8');
      return { ok: true, path: rel, size: parsed.data.content.length };
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  /**
   * Read a single file's contents for the modal preview. The requested
   * path must resolve (after symlink expansion) to a location under the
   * session's cwd — defends against `..` traversal and symlink escapes,
   * since the daemon binds 127.0.0.1 and a hostile `path` query would
   * otherwise expose any file the daemon process can read.
   */
  server.get('/api/sessions/:id/file', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ctx = manager.getSession(id);
    if (!ctx) return reply.code(404).send({ error: 'session not found' });
    const Q = z.object({ path: z.string().min(1) });
    const parsed = Q.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const requested = resolve(ctx.cwd, parsed.data.path);
    let realRoot: string;
    let realTarget: string;
    try {
      realRoot = await realpath(ctx.cwd);
      realTarget = await realpath(requested);
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
    const rel = relative(realRoot, realTarget);
    if (rel.startsWith('..') || resolve(realRoot, rel) !== realTarget) {
      return reply.code(403).send({ error: 'path escapes session cwd' });
    }
    try {
      const st = await stat(realTarget);
      if (!st.isFile()) return reply.code(400).send({ error: 'not a regular file' });
      // 1 MiB cap — UI doesn't render giant files well and we don't want
      // to ship a multi-megabyte JSON over SSE-adjacent channels.
      if (st.size > 1024 * 1024) {
        return reply.code(413).send({ error: `file too large (${st.size} bytes)` });
      }
      const content = await readFile(realTarget, 'utf8');
      return { path: rel, size: st.size, content };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  server.get('/api/browse', async (req, reply) => {
    const Schema = z.object({ path: z.string().optional() });
    const parsed = Schema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const path = parsed.data.path ?? homedir();
    try {
      const entries = await readdir(path, { withFileTypes: true });
      const sorted = entries
        .map((e) => ({
          name: e.name,
          isDir: e.isDirectory(),
          isHidden: e.name.startsWith('.'),
        }))
        .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));

      // Project-signal probe: for each visible directory in this view,
      // check for the presence of well-known anchors so the picker can
      // badge git repos, Node/Python/Rust projects, and folders that
      // already have a SelfClaude session. Capped at 60 dirs to keep
      // big home-folder browses snappy.
      const VISIBLE_DIRS = sorted
        .filter((e) => e.isDir && !e.isHidden)
        .slice(0, 60);
      const SIGNAL_FILES: Array<[string, ProjectSignal]> = [
        ['.git', 'git'],
        ['.selfclaude/state.json', 'selfclaude'],
        ['package.json', 'node'],
        ['Cargo.toml', 'rust'],
        ['pyproject.toml', 'python'],
        ['go.mod', 'go'],
      ];
      const signalsByName = new Map<string, ProjectSignal[]>();
      await Promise.all(
        VISIBLE_DIRS.map(async (d) => {
          const folderPath = join(path, d.name);
          const found: ProjectSignal[] = [];
          for (const [marker, signal] of SIGNAL_FILES) {
            try {
              const st = await stat(join(folderPath, marker));
              if (st) found.push(signal);
            } catch {
              /* not present — skip */
            }
          }
          if (found.length > 0) signalsByName.set(d.name, found);
        }),
      );

      const enriched = sorted.map((e) => ({
        ...e,
        signals: signalsByName.get(e.name) ?? [],
      }));

      return {
        path,
        parent: path === '/' ? null : dirname(path),
        entries: enriched,
      };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /**
   * Create a new directory inside an existing parent. Used by the
   * FolderPicker's inline "new folder" affordance when the operator
   * wants to scaffold a fresh project root without leaving the picker.
   *
   * Safety:
   *
   *   - The parent must already exist + be a directory we can readdir.
   *   - The name is regex-validated: `[A-Za-z0-9._][A-Za-z0-9._-]*` —
   *     no slashes, no traversal segments (`..`), no leading hyphen
   *     (which fights CLI tools), max 64 chars.
   *   - The target may not already exist (refuses overwrite).
   *   - Realpath check: post-create, the new dir must resolve under
   *     the parent's realpath — defends against symlink shenanigans
   *     in the parent's name resolution.
   */
  server.post('/api/browse/mkdir', async (req, reply) => {
    const Schema = z.object({
      parent: z.string().min(1),
      // Permissive: letters / digits / dots / underscores / hyphens /
      // spaces, max 64. Slashes + traversal segments rejected
      // separately below so the operator gets a friendlier message
      // than the raw regex sees. Leading dot OK (hidden dirs allowed).
      name: z.string().min(1).max(64),
    });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) {
      // Pull the first issue's message instead of the raw zod array
      // so the frontend can surface a clean string. Multiple issues
      // are unlikely here (single field, single validator chain).
      const first = parsed.error.issues[0];
      const msg = first?.message ?? 'invalid request';
      return reply.code(400).send({ error: msg });
    }
    const { parent, name } = parsed.data;
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      return reply.code(400).send({ error: 'name cannot be empty' });
    }
    if (trimmed === '..' || trimmed === '.') {
      return reply.code(400).send({ error: 'name cannot be "." or ".."' });
    }
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      return reply.code(400).send({ error: 'name cannot contain slashes' });
    }
    if (!/^[A-Za-z0-9._ -]+$/.test(trimmed)) {
      return reply.code(400).send({
        error:
          'name can only contain letters, digits, spaces, dots, underscores, and hyphens',
      });
    }
    try {
      const parentReal = await realpath(parent);
      const stParent = await stat(parentReal);
      if (!stParent.isDirectory()) {
        return reply.code(400).send({ error: 'parent is not a directory' });
      }
      const target = join(parentReal, trimmed);
      // Refuse overwrite — the operator has to pick a fresh name.
      try {
        await stat(target);
        return reply
          .code(409)
          .send({ error: `"${trimmed}" already exists` });
      } catch {
        /* doesn't exist — good */
      }
      const { mkdir } = await import('node:fs/promises');
      await mkdir(target);
      // Sanity: target must still resolve under parent post-create
      // (cheap defense against post-creation symlink swaps).
      const resolvedTarget = await realpath(target);
      const rel = relative(parentReal, resolvedTarget);
      if (rel.startsWith('..')) {
        return reply.code(500).send({ error: 'created directory escapes parent' });
      }
      return { path: resolvedTarget, parent: parentReal, name: trimmed };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  return server;
}

/**
 * Curated subset of project files surfaced to the left sidebar. We
 * deliberately don't walk the whole tree (no `node_modules`, no `.git`,
 * no `dist`) — the operator wants to see project artifacts (docs,
 * prompts, phase briefs) and SelfClaude internals, not transitive deps.
 */
const PROJECT_TREE_DIRS: ReadonlyArray<{
  /** Path relative to cwd. */
  path: string;
  /** Group label surfaced to the UI. */
  group: 'project' | 'selfclaude';
  /** Walk recursively (`true`) or list only direct children. */
  recursive: boolean;
  /** Skip files matching these patterns even if recursive. */
  skip?: ReadonlyArray<RegExp>;
}> = [
  { path: 'docs', group: 'project', recursive: true },
  { path: 'prompts', group: 'project', recursive: true },
  // Agent-archived reports (security audits, dev/ui-dev deliverables).
  // Walked recursively so each `<agent>/` subdir surfaces its files
  // grouped under one collapsible row in the sidebar.
  { path: 'reports', group: 'project', recursive: true },
  { path: '.claude', group: 'project', recursive: true, skip: [/projects\//] },
  // Recursive so hooks/, scripts/, memory/, agent-prompts/ subdirs all
  // show up — operator wants visibility into the orchestrator
  // workspace, not just the top-level config files.
  { path: '.selfclaude', group: 'selfclaude', recursive: true },
];

const ROOT_FILES = ['README.md', 'CHANGELOG.md', 'package.json', 'pnpm-workspace.yaml'];

interface TreeFile {
  /** Path relative to the session cwd (used as the `?path=` arg later). */
  path: string;
  /** Just the basename for display. */
  name: string;
  size: number;
}

interface TreeGroup {
  group: 'project' | 'selfclaude' | 'root';
  /** Top-level folder name or empty string for `root`. */
  label: string;
  files: TreeFile[];
}

interface ProjectTree {
  cwd: string;
  groups: TreeGroup[];
}

async function buildProjectTree(cwd: string): Promise<ProjectTree> {
  const groups: TreeGroup[] = [];

  // Root-level standalone files (README, etc.) — show only the ones present.
  const rootFiles: TreeFile[] = [];
  for (const name of ROOT_FILES) {
    const full = join(cwd, name);
    if (!existsSync(full)) continue;
    try {
      const st = await stat(full);
      if (st.isFile()) rootFiles.push({ path: name, name, size: st.size });
    } catch {
      /* ignore unreadable */
    }
  }
  if (rootFiles.length > 0) {
    groups.push({ group: 'root', label: '', files: rootFiles });
  }

  // Curated directories.
  for (const cfg of PROJECT_TREE_DIRS) {
    const dirPath = join(cwd, cfg.path);
    if (!existsSync(dirPath)) continue;
    const files = await listFiles(dirPath, cfg.recursive, cfg.skip);
    if (files.length === 0) continue;
    groups.push({
      group: cfg.group,
      label: cfg.path,
      files: files.map((rel) => ({
        path: join(cfg.path, rel.relative),
        name: rel.relative,
        size: rel.size,
      })),
    });
  }

  return { cwd, groups };
}

async function listFiles(
  dir: string,
  recursive: boolean,
  skip: ReadonlyArray<RegExp> | undefined,
): Promise<{ relative: string; size: number }[]> {
  const out: { relative: string; size: number }[] = [];
  const walk = async (sub: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(sub, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (skip?.some((re) => re.test(rel))) continue;
      const full = join(sub, e.name);
      if (e.isDirectory()) {
        if (!recursive) continue;
        await walk(full, rel);
      } else if (e.isFile()) {
        try {
          const st = await stat(full);
          out.push({ relative: rel, size: st.size });
        } catch {
          /* skip unreadable */
        }
      }
    }
  };
  await walk(dir, '');
  out.sort((a, b) => a.relative.localeCompare(b.relative));
  return out;
}

/**
 * Markers the browse endpoint surfaces per directory so the folder
 * picker can badge "this looks like a project" entries. Detection is
 * shallow (anchor-file presence in the first level), not actual repo
 * inspection — fast enough to run for every visible dir on browse.
 */
type ProjectSignal = 'git' | 'selfclaude' | 'node' | 'rust' | 'python' | 'go';

/* ───── CC auto-memory helpers ─────
 *
 * CC stores a per-project auto-memory bucket at
 * `~/.claude/projects/<encoded-cwd>/memory/` where `<encoded-cwd>` is
 * the cwd with `/` replaced by `-`. We don't control that location;
 * we just surface its contents so the operator can see what the
 * supervisor (or CC itself) wrote there.
 *
 * Filename safety: agents and the operator can edit existing files
 * but can't traverse out of the memory bucket — the regex permits
 * `[\w.-]+\.(md|txt|json)` only, no slashes.
 */

interface AutoMemoryEntry {
  name: string;
  size: number;
  /** First ~200 chars (or first paragraph) for at-a-glance preview. */
  preview: string;
}

interface AutoMemoryListing {
  /** Encoded cwd that keys the CC bucket — surfaced for debug / display. */
  encodedCwd: string;
  /** Absolute directory path; empty string when missing. */
  dir: string;
  /** All `.md` / `.txt` / `.json` files inside the bucket, alpha-sorted. */
  entries: AutoMemoryEntry[];
  /** User-global `~/.claude/CLAUDE.md` if present (read-only). */
  userClaudeMd: { path: string; size: number; preview: string } | null;
}

function encodeCwdForClaude(cwd: string): string {
  // CC's encoding rule: replace every `/` with `-`. Leading `/` becomes a
  // leading `-`. We don't trim or normalise — preserves CC's exact key.
  return cwd.replace(/\//g, '-');
}

function autoMemoryDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', encodeCwdForClaude(cwd), 'memory');
}

const AUTO_MEMORY_NAME_RE = /^[\w][\w.-]*\.(md|txt|json)$/;
function isSafeAutoMemoryName(name: string): boolean {
  return AUTO_MEMORY_NAME_RE.test(name) && !name.includes('/') && !name.includes('\\');
}

/** Take ~200 chars or the first non-empty paragraph, whichever is shorter. */
function buildPreview(content: string): string {
  const firstPara = content.split(/\n\s*\n/, 1)[0] ?? content;
  const trimmed = firstPara.trim();
  if (trimmed.length <= 200) return trimmed;
  return `${trimmed.slice(0, 200).trim()}…`;
}

/**
 * Single-shot aggregate of every memory layer the operator can see for
 * this session, each entry tagged with its `kind` so the Memory panel
 * can route clicks to the right read/write endpoints. Aggregating
 * server-side keeps the panel simple (one fetch, one render) and lets
 * us keep adding layers (e.g. user-global subdirs) without touching
 * the frontend.
 */
interface MemoryOverviewEntry {
  /** Slug for the layer; routes click → read/write API on the frontend. */
  kind: 'project' | 'shared' | 'auto' | 'user-global';
  /** Display name (basename for project/shared/auto, full path for user-global). */
  name: string;
  /** Identifier the frontend uses for read/write (relative path or bare name). */
  ref: string;
  size: number;
  preview: string;
  editable: boolean;
}

interface MemoryOverview {
  project: MemoryOverviewEntry[];
  shared: MemoryOverviewEntry[];
  auto: MemoryOverviewEntry[];
  userGlobal: MemoryOverviewEntry[];
  /** Surfaces the encoded-cwd key for debug + UI subtext. */
  encodedCwd: string;
}

async function readMemoryOverview(cwd: string): Promise<MemoryOverview> {
  const project: MemoryOverviewEntry[] = [];
  const shared: MemoryOverviewEntry[] = [];

  // Project root: CLAUDE.md, AGENTS.md (case-insensitive match)
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'Claude.md', 'claude.md', 'agents.md']) {
    const full = join(cwd, name);
    if (!existsSync(full)) continue;
    try {
      const st = await stat(full);
      if (!st.isFile() || st.size > 256 * 1024) continue;
      const content = await readFile(full, 'utf8');
      project.push({
        kind: 'project',
        name,
        ref: name,
        size: st.size,
        preview: buildPreview(content),
        editable: true,
      });
    } catch {
      /* skip */
    }
  }

  // Shared sup-managed memory: <cwd>/.selfclaude/memory/*.md
  const sharedDir = join(cwd, '.selfclaude', 'memory');
  try {
    const entries = await readdir(sharedDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!/\.(md|txt|json)$/i.test(ent.name)) continue;
      const full = join(sharedDir, ent.name);
      try {
        const st = await stat(full);
        if (!st.isFile() || st.size > 256 * 1024) continue;
        const content = await readFile(full, 'utf8');
        shared.push({
          kind: 'shared',
          name: ent.name,
          ref: join('.selfclaude/memory', ent.name),
          size: st.size,
          preview: buildPreview(content),
          editable: true,
        });
      } catch {
        /* skip */
      }
    }
  } catch {
    /* dir missing */
  }
  shared.sort((a, b) => a.name.localeCompare(b.name));

  // CC auto-memory bucket — uses the same readAutoMemory helper.
  const autoListing = await readAutoMemory(cwd);
  const auto: MemoryOverviewEntry[] = autoListing.entries.map((e) => ({
    kind: 'auto',
    name: e.name,
    ref: e.name,
    size: e.size,
    preview: e.preview,
    editable: true,
  }));

  // User-global ~/.claude/CLAUDE.md (read-only — not session-scoped).
  const userGlobal: MemoryOverviewEntry[] = autoListing.userClaudeMd
    ? [
        {
          kind: 'user-global',
          name: '~/.claude/CLAUDE.md',
          ref: autoListing.userClaudeMd.path,
          size: autoListing.userClaudeMd.size,
          preview: autoListing.userClaudeMd.preview,
          editable: false,
        },
      ]
    : [];

  return {
    project,
    shared,
    auto,
    userGlobal,
    encodedCwd: autoListing.encodedCwd,
  };
}

async function readAutoMemory(cwd: string): Promise<AutoMemoryListing> {
  const dir = autoMemoryDir(cwd);
  const entries: AutoMemoryEntry[] = [];
  let dirExists = false;
  try {
    const dirents = await readdir(dir, { withFileTypes: true });
    dirExists = true;
    for (const ent of dirents) {
      if (!ent.isFile()) continue;
      if (!isSafeAutoMemoryName(ent.name)) continue;
      const full = join(dir, ent.name);
      try {
        const st = await stat(full);
        if (st.size > 256 * 1024) {
          entries.push({ name: ent.name, size: st.size, preview: '(file too large to preview)' });
          continue;
        }
        const content = await readFile(full, 'utf8');
        entries.push({ name: ent.name, size: st.size, preview: buildPreview(content) });
      } catch {
        /* skip unreadable */
      }
    }
  } catch {
    /* dir missing — entries stays [] */
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  let userClaudeMd: AutoMemoryListing['userClaudeMd'] = null;
  const userPath = join(homedir(), '.claude', 'CLAUDE.md');
  try {
    const st = await stat(userPath);
    if (st.isFile() && st.size <= 256 * 1024) {
      const content = await readFile(userPath, 'utf8');
      userClaudeMd = { path: userPath, size: st.size, preview: buildPreview(content) };
    }
  } catch {
    /* not present */
  }

  return {
    encodedCwd: encodeCwdForClaude(cwd),
    dir: dirExists ? dir : '',
    entries,
    userClaudeMd,
  };
}

export async function startWebApi(opts: WebApiOptions = {}): Promise<WebApiHandle> {
  const port = opts.port ?? 7423;
  const host = opts.host ?? '127.0.0.1';

  // Wire structured logs to a dedicated file so we have a real audit trail
  // for orchestrator-side events (turn starts/ends, sup/dev message
  // assembly, wakeup lifecycle, hook activity). Lives next to the daemon's
  // run.log but keeps Next.js compile noise out of orchestrator history.
  configureLogFile(join(homedir(), '.selfclaude', 'orchestrator.log'));

  const manager = opts.manager ?? new SessionManager();
  const server = buildWebApi(manager);
  await server.listen({ host, port });
  const url = `http://${host}:${port}`;
  log('info', 'web-api.started', { url });
  return { server, manager, url, port };
}
