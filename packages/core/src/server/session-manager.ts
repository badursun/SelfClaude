import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { Orchestrator, type PendingApprovalView, type PendingQuestionView } from '../orchestrator/index.js';
import { runConversationTurn } from '../orchestrator/conversation.js';
import { loadDeveloperSystemPrompt } from '../orchestrator/loop.js';
import { getAgent, loadAgentPrompt } from '../agents/registry.js';
import { runClaudeTurn } from '../claude-code/spawn.js';
import { recordRecent } from './recents.js';
import {
  extractAssistantText,
  extractAssistantThinking,
  extractResultMetrics,
  extractStreamTextDelta,
  extractStreamThinkingDelta,
  extractToolResults,
  extractToolUses,
  type StreamEvent,
} from '../orchestrator/stream-parser.js';
import { extractDeveloperTasks } from '../orchestrator/tag-parser.js';
import {
  appendChatLogEntry,
  readChatLog,
  type ChatLogEntry,
} from '../project/chat-log.js';
import { readMetrics, writeMetrics } from '../project/metrics-store.js';
import {
  appendSessionMetricsEvent,
  type SessionMetricsEvent,
} from '../project/session-metrics-store.js';
import {
  bumpLastCommitAt,
  readGitIsolation,
} from '../project/git-isolation-store.js';
import { commitTurn } from './git-isolation.js';
import type { PhaseContractAttemptEvent } from '../orchestrator/phase-contracts.js';
import { classifyFailure } from '../orchestrator/failure-modes.js';
import {
  detectStuck,
  isProgressMarker,
  type StuckCheckResult,
} from '../orchestrator/stuck-detector.js';
import {
  readPhases,
  type ConfirmEvidence,
  type PhasesFile,
} from '../project/phases-store.js';
import type { FsmState } from '../orchestrator/state-machine.js';
import { log } from '../lib/log.js';
import {
  WakeupRunner,
  parseScheduleWakeupInput,
  type ScheduledWakeup,
  type WakeupRole,
} from './wakeup-runner.js';

export interface SessionMeta {
  id: string;
  cwd: string;
  label: string;
  createdAt: number;
  phase: string;
  supActive: boolean;
  devActive: boolean;
  busy: boolean;
}

export type SessionEvent =
  | { kind: 'state-changed'; state: FsmState }
  | { kind: 'user-message'; text: string; ts: number }
  | { kind: 'sup-message'; text: string; ts: number }
  | { kind: 'dev-text'; text: string; ts: number }
  | {
      kind: 'dev-tool-call';
      id: string;
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
      ts: number;
    }
  | { kind: 'dev-tool-result'; toolUseId: string; text: string; isError: boolean; ts: number }
  | {
      kind: 'sup-tool-call';
      id: string;
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
      ts: number;
    }
  | { kind: 'sup-tool-result'; toolUseId: string; text: string; isError: boolean; ts: number }
  | { kind: 'task-marker'; summary: string; ts: number }
  | { kind: 'phase-doc-written'; filename: string; ts: number }
  | { kind: 'question'; question: PendingQuestionView }
  | { kind: 'question-resolved'; id: string; answer: string }
  | { kind: 'approval'; approval: PendingApprovalView }
  | { kind: 'approval-resolved'; id: string; decision: 'allow' | 'deny' }
  | { kind: 'iteration-end'; iteration: number }
  /**
   * Turn-level failure event. Renamed from `error` to `turn-error` so
   * EventSource's native connection-error listener doesn't fire on
   * server-sent custom 'error' frames — that collision used to surface
   * a spurious "Lost connection" toast every time a turn aborted.
   *
   * Phase 7 sprint 2: payload now carries the classified `code` from
   * the failure-mode catalogue. The frontend uses this to render a
   * structured banner with the description + suggested action instead
   * of just printing the raw message.
   */
  | { kind: 'turn-error'; message: string; code: string; role: string | null }
  /**
   * Phase 7 sprint 2B — stuck detector transition. Emitted only on
   * transitions (entered-stuck or recovered) so the frontend sees
   * the change without being spammed every tick. When `stuck=true`,
   * `reason` carries the heuristic branch that fired and
   * `minutesSinceProgress` is the (informational) age of the last
   * progress marker (null when none has been seen yet).
   */
  | {
      kind: 'session-stuck';
      stuck: boolean;
      reason: string;
      minutesSinceProgress: number | null;
      ts: number;
    }
  | { kind: 'turn-busy'; busy: boolean }
  | { kind: 'user-note-dev'; text: string; ts: number }
  | { kind: 'user-message-dev'; text: string; ts: number }
  | { kind: 'sup-message-delta'; delta: string; ts: number }
  | { kind: 'dev-text-delta'; delta: string; ts: number }
  | { kind: 'sup-thinking-delta'; delta: string; ts: number }
  | { kind: 'dev-thinking-delta'; delta: string; ts: number }
  | { kind: 'sup-thinking'; text: string; ts: number }
  | { kind: 'dev-thinking'; text: string; ts: number }
  | {
      kind: 'role-metrics';
      /**
       * Either a built-in role (`supervisor`, `developer`) or a
       * specialist agent name (`ui-dev`, `security`, …). The web side
       * keys the bottom-toolbar / cost split off this string.
       */
      role: string;
      metrics: RoleMetrics;
      ts: number;
    }
  | {
      kind: 'wakeup-scheduled';
      wakeupId: string;
      role: WakeupRole;
      fireAt: number;
      prompt: string;
      reason: string;
      ts: number;
    }
  | { kind: 'wakeup-fired'; wakeupId: string; role: WakeupRole; ts: number }
  | {
      kind: 'wakeup-cancelled';
      wakeupId: string;
      role: WakeupRole;
      reason: 'replaced' | 'user-input' | 'shutdown';
      ts: number;
    }
  | {
      kind: 'turn-aborted';
      role: WakeupRole;
      ts: number;
    }
  /**
   * Generic per-agent stream events for specialist agents (ui-dev,
   * security, future roles). The default developer keeps its `dev-*`
   * stream so existing UI code paths don't rebuild from scratch.
   */
  | { kind: 'agent-text'; agent: string; text: string; ts: number }
  | { kind: 'agent-text-delta'; agent: string; delta: string; ts: number }
  | { kind: 'agent-thinking'; agent: string; text: string; ts: number }
  | { kind: 'agent-thinking-delta'; agent: string; delta: string; ts: number }
  | {
      kind: 'agent-tool-call';
      agent: string;
      id: string;
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
      ts: number;
    }
  | {
      kind: 'agent-tool-result';
      agent: string;
      toolUseId: string;
      text: string;
      isError: boolean;
      ts: number;
    }
  | { kind: 'agent-summoned'; agent: string; ts: number }
  | { kind: 'agent-dismissed'; agent: string; ts: number }
  | { kind: 'verdict'; id: number; text: string; ts: number }
  | { kind: 'room-message'; agent: string; text: string; ts: number }
  /**
   * Phase tracker mutation. Carries the post-mutation snapshot inline
   * so the UI can update without an extra fetch — the snapshot is
   * small (a JSON tree, ≤ a few KB in practice). `logEntry` is the
   * matching chat-log entry the orchestrator just appended; the store
   * appends it to `chatLog` so the Audit Log panel sees the mutation
   * live (chat-log file write + SSE event arrive in the same handler,
   * keeping the frontend in lockstep with disk).
   */
  | {
      kind: 'phase-tracker-updated';
      action:
        | 'registered'
        | 'proposed'
        | 'confirmed'
        | 'rejected'
        | 'external-edit'
        | 'operator-verified';
      slug: string;
      itemId?: string;
      agent?: string;
      file: PhasesFile;
      /** null on `external-edit` — no per-item context to log. */
      logEntry: ChatLogEntry | null;
      ts: number;
    }
  /**
   * Bash macro / script proposal mutation. Carries the file snapshot
   * inline so the Scripts panel updates without a refetch.
   */
  | {
      kind: 'scripts-updated';
      action: 'proposed' | 'approved' | 'rejected';
      slug: string;
      // biome-ignore lint/suspicious/noExplicitAny: structural type — matches scripts-store ScriptsFile
      file: unknown;
      ts: number;
    };

/**
 * Cumulative cost / time metrics for one role within a session. Updated on
 * every `result` stream event. The bottom-toolbar UI reads these to show
 * the operator how expensive the run has been so far.
 */
export interface RoleMetrics {
  /** Sum of `total_cost_usd` across all turns. */
  totalCostUsd: number;
  /** Sum of `num_turns` across all turns. */
  totalTurns: number;
  /** `duration_ms` of the most recent turn (UI shows "last turn: 4.2s"). */
  lastTurnMs: number;
  /** Cumulative wall-clock time spent in this role's turns. */
  totalDurationMs: number;
  /** Wall-clock timestamp of the last result event (ms since epoch). */
  lastResultAt: number | null;
}

function emptyMetrics(): RoleMetrics {
  return {
    totalCostUsd: 0,
    totalTurns: 0,
    lastTurnMs: 0,
    totalDurationMs: 0,
    lastResultAt: null,
  };
}

export interface SessionContext {
  id: string;
  cwd: string;
  label: string;
  createdAt: number;
  orchestrator: Orchestrator;
  emitter: EventEmitter;
  supervisorSessionId: string | null;
  developerSessionId: string | null;
  busy: Promise<void> | null;
  /** Token-delta counters per role, reset on assistant-complete events. */
  supDeltaCount: number;
  devDeltaCount: number;
  /** Thinking-delta counters per role; same lifecycle as text deltas. */
  supThinkingDeltaCount: number;
  devThinkingDeltaCount: number;
  supMetrics: RoleMetrics;
  devMetrics: RoleMetrics;
  /**
   * Cumulative metrics per specialist agent (`ui-dev`, `security`,
   * future custom roles). The supervisor and the default developer
   * keep their dedicated buckets above so existing UI / persistence
   * code paths stay untouched; everyone else lands here keyed by
   * agent name. Persisted to `.selfclaude/metrics.json` on every update.
   */
  agentMetrics: Map<string, RoleMetrics>;
  /**
   * AbortController of the currently in-flight turn (if any). Set by every
   * code path that calls `runConversationTurn` / `runClaudeTurn`, cleared
   * in `finally`. The operator-facing emergency-stop button calls
   * `controller.abort()` to SIGTERM the underlying CC subprocess. The
   * `role` field is purely informational — only one turn is active at a
   * time so there is no ambiguity about which subprocess gets killed.
   */
  currentAbort: { role: WakeupRole; controller: AbortController } | null;
  /**
   * Set of specialist agents currently summoned for this session. Always
   * contains `developer` (default team member); others (`ui-dev`,
   * `security`, …) are added when the supervisor emits `<SUMMON …/>`
   * and removed on `<DISMISS …/>`. The UI reads this to render the
   * active agent tabs.
   */
  activeAgents: Set<string>;
  /**
   * Per-agent token-delta counters for the generic specialist agents.
   * The supervisor and the default developer keep their own legacy
   * counters (`supDeltaCount` / `devDeltaCount`); everything else lands
   * here keyed by agent name.
   */
  agentDeltaCount: Map<string, number>;
  /**
   * Phase 5 (Trust v1) — git isolation state for this session, when
   * the operator has enabled it. `null` when no isolation is active
   * (or when the workspace isn't a git repo). When set, every
   * agent-completed turn auto-commits to `branch`; Accept/Discard
   * use `originalBranch` to know where to merge or return.
   *
   * Persisted to `<cwd>/.selfclaude/git-isolation.json` so a daemon
   * restart resumes the session on the same SC branch without
   * forgetting which branch the operator was originally on.
   */
  gitIsolation: {
    enabled: boolean;
    branch: string;
    originalBranch: string;
    startedAt: number;
    lastCommitAt: number | null;
  } | null;
  /**
   * Phase 7 sprint 2B — stuck detection state. `lastProgressTs` is
   * updated whenever an event lands that counts as forward motion
   * (file write, phase mutation, verdict, task delegation —
   * `isProgressMarker` is the source of truth). `currentlyStuck`
   * tracks the last result of `detectStuck` so the periodic check
   * can emit `session-stuck` only on transitions, not on every tick.
   */
  lastProgressTs: number | null;
  currentlyStuck: boolean;
  agentThinkingDeltaCount: Map<string, number>;
}

export interface SessionSnapshot {
  meta: SessionMeta;
  chatLog: ChatLogEntry[];
  pendingQuestions: PendingQuestionView[];
  pendingApprovals: PendingApprovalView[];
  /**
   * Cumulative metrics per role. `sup` and `dev` are always present
   * (zero when never run). `agents` keys are specialist names — only
   * agents that have actually run a turn are included.
   */
  metrics: {
    sup: RoleMetrics;
    dev: RoleMetrics;
    agents: Record<string, RoleMetrics>;
  };
  /** True when the snapshot was sliced (older entries remain server-side). */
  hasMoreHistory: boolean;
}

/**
 * Multi-session orchestrator registry. Each entry owns its own Orchestrator
 * (with its own hook server, MCP config, message bus); inter-session
 * isolation is provided naturally by per-instance state.
 *
 * Sessions emit a unified `SessionEvent` stream over their `emitter` —
 * consumed by the SSE bridge to stream changes to a connected web client.
 *
 * The manager also owns a {@link WakeupRunner} that materialises
 * `ScheduleWakeup` tool calls from either agent into real timers. CC's
 * runtime ignores these calls outside of `/loop` mode, so without this
 * runner the agent would just sleep forever; here the orchestrator itself
 * re-prompts the agent at the requested time.
 */
export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, SessionContext>();
  private readonly wakeups = new WakeupRunner();
  /**
   * Phase 7 sprint 2B — global timer that runs the stuck detector
   * across every active session. 30s cadence is conservative
   * (cheaper than per-session timers; cheap enough that the UI
   * banner appears within ~30s of crossing the threshold).
   */
  private stuckCheckTimer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.stuckCheckTimer = setInterval(() => {
      for (const ctx of this.sessions.values()) {
        try {
          this.checkStuck(ctx);
        } catch (e) {
          log('warn', 'session.stuck_check_failed', {
            id: ctx.id,
            error: (e as Error).message,
          });
        }
      }
    }, 30_000);
    // Don't keep the Node process alive just because of this timer —
    // the daemon's lifecycle is owned by the web server.
    this.stuckCheckTimer.unref?.();
    // Single shared listener: every wakeup state change becomes a chat-log
    // entry + SSE event for the owning session.
    this.wakeups.onEvent((sessionId, event) => {
      const ctx = this.sessions.get(sessionId);
      if (!ctx) return;
      const ts = Date.now();
      if (event.kind === 'scheduled') {
        const w = event.wakeup;
        void this.appendLog(ctx, {
          type: 'wakeup-scheduled',
          wakeupId: w.id,
          role: w.role,
          fireAt: w.fireAt,
          prompt: w.prompt,
          reason: w.reason,
          ts,
        });
        this.emitEvent(ctx, {
          kind: 'wakeup-scheduled',
          wakeupId: w.id,
          role: w.role,
          fireAt: w.fireAt,
          prompt: w.prompt,
          reason: w.reason,
          ts,
        });
      } else if (event.kind === 'fired') {
        void this.appendLog(ctx, {
          type: 'wakeup-fired',
          wakeupId: event.wakeup.id,
          role: event.wakeup.role,
          ts,
        });
        this.emitEvent(ctx, {
          kind: 'wakeup-fired',
          wakeupId: event.wakeup.id,
          role: event.wakeup.role,
          ts,
        });
      } else if (event.kind === 'cancelled') {
        void this.appendLog(ctx, {
          type: 'wakeup-cancelled',
          wakeupId: event.wakeup.id,
          role: event.wakeup.role,
          reason: event.reason,
          ts,
        });
        this.emitEvent(ctx, {
          kind: 'wakeup-cancelled',
          wakeupId: event.wakeup.id,
          role: event.wakeup.role,
          reason: event.reason,
          ts,
        });
      }
    });
  }

  async createSession(opts: { cwd: string; label?: string }): Promise<SessionMeta> {
    // Idempotent open: if a session is already running in the same
    // working directory, return its meta instead of spawning a duplicate.
    // We compare on realpath so symlinks / `.`-relative paths normalise.
    let canonical = opts.cwd;
    try {
      canonical = await realpath(opts.cwd);
    } catch {
      // realpath fails if the path doesn't exist — let Orchestrator surface
      // the underlying error a few lines down with a clearer message.
    }
    for (const existing of this.sessions.values()) {
      let existingCanonical = existing.cwd;
      try {
        existingCanonical = await realpath(existing.cwd);
      } catch {
        /* ignore */
      }
      if (existingCanonical === canonical) {
        log('info', 'session.reused', { id: existing.id, cwd: canonical });
        return this.toMeta(existing);
      }
    }

    const id = randomUUID();
    const orch = new Orchestrator({ cwd: opts.cwd });
    const startResult = await orch.start();

    const ctx: SessionContext = {
      id,
      cwd: opts.cwd,
      label: opts.label ?? (basename(opts.cwd) || opts.cwd),
      createdAt: Date.now(),
      orchestrator: orch,
      emitter: new EventEmitter(),
      supervisorSessionId: startResult.projectState.supervisorSessionId,
      developerSessionId: startResult.projectState.developerSessionId,
      busy: null,
      supDeltaCount: 0,
      devDeltaCount: 0,
      supThinkingDeltaCount: 0,
      devThinkingDeltaCount: 0,
      supMetrics: emptyMetrics(),
      devMetrics: emptyMetrics(),
      agentMetrics: new Map(),
      currentAbort: null,
      activeAgents: new Set(['developer']),
      agentDeltaCount: new Map(),
      agentThinkingDeltaCount: new Map(),
      gitIsolation: null,
      lastProgressTs: null,
      currentlyStuck: false,
    };
    this.sessions.set(id, ctx);
    this.attachOrchestratorEvents(ctx);
    await this.restoreWakeups(ctx);
    await this.restoreActiveAgents(ctx);
    await this.restoreMetrics(ctx);
    await this.restoreLastProgress(ctx);
    await this.restoreGitIsolation(ctx);

    // Phase 2 telemetry — session boundary marker. Goes into the JSONL
    // event log so cross-session rollups can compute per-session
    // duration. Fire-and-forget; collector failures don't block boot.
    void this.recordMetric(ctx, {
      kind: 'session-start',
      sessionId: id,
      ts: Date.now(),
    });

    // Record into the recents log so the landing page's "Recent" rail
    // can surface this cwd next time. Best-effort, non-fatal.
    try {
      recordRecent(opts.cwd, ctx.label);
    } catch (e) {
      log('warn', 'recents.record_failed', { cwd: opts.cwd, error: (e as Error).message });
    }

    log('info', 'session.created', { id, cwd: opts.cwd });
    this.emit('session-created', this.toMeta(ctx));
    return this.toMeta(ctx);
  }

  async destroySession(id: string): Promise<void> {
    const ctx = this.sessions.get(id);
    if (!ctx) return;
    // Eagerly remove from the map BEFORE we run any async cleanup. The
    // operator has clicked X — the session must disappear from
    // listSessions on the very next poll, even if orchestrator.stop()
    // throws or the in-flight turn rejects partway. Previously a throw
    // anywhere below would leave the entry in the map, the frontend's
    // tombstone would eventually expire, and the tab would reappear.
    this.sessions.delete(id);
    // Phase 2 telemetry — session boundary marker. Recorded BEFORE the
    // async cleanup so a stop() that hangs doesn't lose the end ts.
    void this.recordMetric(ctx, {
      kind: 'session-end',
      sessionId: id,
      ts: Date.now(),
      reason: 'destroy',
    });
    this.wakeups.cancelAll(id, 'shutdown');
    // Abort any in-flight turn so we're not stuck waiting on a CC
    // subprocess that may not honor a soft signal quickly.
    if (ctx.currentAbort) {
      try {
        ctx.currentAbort.controller.abort();
      } catch (e) {
        log('warn', 'session.destroy.abort_failed', { id, error: (e as Error).message });
      }
    }
    if (ctx.busy) {
      // Best-effort wait — but never let a rejection from the in-flight
      // turn bubble up and skip the orchestrator stop below.
      try {
        await Promise.race([ctx.busy, new Promise((r) => setTimeout(r, 5_000))]);
      } catch (e) {
        log('warn', 'session.destroy.busy_rejected', { id, error: (e as Error).message });
      }
    }
    try {
      await ctx.orchestrator.stop();
    } catch (e) {
      log('warn', 'session.destroy.stop_failed', { id, error: (e as Error).message });
    }
    log('info', 'session.destroyed', { id });
    this.emit('session-destroyed', id);
  }

  getSession(id: string): SessionContext | undefined {
    return this.sessions.get(id);
  }

  listSessions(): SessionMeta[] {
    return Array.from(this.sessions.values()).map((c) => this.toMeta(c));
  }

  async sendMessage(id: string, text: string): Promise<void> {
    const ctx = this.sessions.get(id);
    if (!ctx) throw new Error(`session not found: ${id}`);
    if (ctx.busy) throw new Error('session is busy with another turn');

    // User is taking over the supervisor — its pending wakeup (if any) is
    // moot. Dev's wakeup is independent so we leave that alone.
    this.wakeups.cancel(id, 'supervisor', 'user-input');

    const ts = Date.now();
    await this.appendLog(ctx, { type: 'user-message', text, ts });
    this.emitEvent(ctx, { kind: 'user-message', text, ts });
    this.emitEvent(ctx, { kind: 'turn-busy', busy: true });

    const controller = new AbortController();
    ctx.currentAbort = { role: 'supervisor', controller };
    const run = (async () => {
      try {
        const result = await runConversationTurn({
          orchestrator: ctx.orchestrator,
          userPrompt: text,
          supervisorSessionId: ctx.supervisorSessionId ?? undefined,
          developerSessionId: ctx.developerSessionId ?? undefined,
          onSupervisorEvent: (e) => this.onSupervisorStreamEvent(ctx, e),
          onAgentEvent: (agent, e) => this.onAgentStreamEvent(ctx, agent, e),
          signal: controller.signal,
        });
        ctx.supervisorSessionId = result.supervisorSessionId ?? ctx.supervisorSessionId;
        ctx.developerSessionId = result.developerSessionId ?? ctx.developerSessionId;
      } catch (e) {
        this.surfaceFailure(ctx, 'supervisor', (e as Error).message);
      } finally {
        ctx.currentAbort = null;
        ctx.busy = null;
        this.emitEvent(ctx, { kind: 'turn-busy', busy: false });
      }
    })();
    ctx.busy = run;
  }

  /**
   * Send a direct message to the developer agent, bypassing the supervisor.
   * Triggers a dev-only turn so the developer responds immediately. The
   * supervisor receives an informational copy (in its inbox) so its next
   * turn knows the side conversation happened.
   */
  /**
   * Direct-message a specialist agent. Same flow as `messageDeveloper`
   * but routed to any active agent in the registry — operator types in
   * the ui-dev tab, the message lands in the ui-dev's CC session.
   *
   * The supervisor receives an informational copy so it knows the
   * operator went around it (preserves the existing "sup is in the loop"
   * invariant from the dev-direct path).
   */
  async messageAgent(id: string, agent: string, text: string): Promise<void> {
    if (agent === 'developer') {
      // Default path is fully covered by messageDeveloper; reuse it so
      // existing event shapes / chat-log entries are unchanged.
      return this.messageDeveloper(id, text);
    }
    const ctx = this.sessions.get(id);
    if (!ctx) throw new Error(`session not found: ${id}`);
    if (ctx.busy) throw new Error('session is busy with another turn');
    if (!ctx.activeAgents.has(agent)) {
      throw new Error(`agent "${agent}" is not active in this session`);
    }
    const config = getAgent(agent);
    if (!config) throw new Error(`unknown agent: ${agent}`);

    // User taking over a specialist cancels its pending wakeup (stored
    // under the developer role for now since the wakeup runner is
    // role-based, not agent-based — see `onAgentStreamEvent`).
    this.wakeups.cancel(id, 'developer', 'user-input');

    const ts = Date.now();
    // No `user-message-dev` analogue for specialists yet — we record the
    // operator's message as a generic agent-text event sourced from the
    // user. Reusing the existing schema keeps replay behaviour consistent.
    void this.appendLog(ctx, {
      type: 'agent-text',
      agent,
      text: `[user → ${agent}] ${text}`,
      ts,
    });
    this.emitEvent(ctx, {
      kind: 'agent-text',
      agent,
      text: `[user → ${agent}] ${text}`,
      ts,
    });

    ctx.orchestrator.messages.enqueue({
      to: 'developer',
      source: 'user',
      body: `USER_DIRECT_MESSAGE:\n${text}`,
    });
    ctx.orchestrator.messages.enqueue({
      to: 'supervisor',
      source: 'user',
      body: `USER_AGENT_DIALOG (informational): user said directly to ${agent}: "${text}"`,
    });

    this.emitEvent(ctx, { kind: 'turn-busy', busy: true });
    const controller = new AbortController();
    ctx.currentAbort = { role: 'developer', controller };
    const run = (async () => {
      try {
        const orch = ctx.orchestrator;
        const ws = orch.getWorkspace();
        orch.dispatch({ kind: 'dev-turn-start' });
        // Look up the agent's prompt from the registry. Cache invalidation
        // is mtime-based inside `loadAgentPrompt`. Passing cwd lets the
        // loader append a project-level DNA addendum on top of the base
        // prompt when one exists.
        const systemPrompt = loadAgentPrompt(config, ws.cwd);
        const sessions: Record<string, string | null> = {};
        // Use the agent's existing CC session id if we've spawned them
        // before — keeps conversation continuity across direct messages.
        // We store specialists' session ids inside ctx.developerSessionId
        // for now (single shared slot). Future polish: a Map per agent.
        // For this first cut, accept the cost: every direct message to a
        // specialist starts a fresh CC session, which is correct
        // behaviour for one-off operator nudges.
        sessions[agent] = null;
        const result = await runClaudeTurn(
          {
            role: 'developer',
            cwd: ws.cwd,
            prompt:
              `A direct user message has been injected into your context (USER_DIRECT_MESSAGE). ` +
              `Respond clearly and concisely. The supervisor is aware of this side conversation.`,
            settingsPath: ws.settingsPath,
            systemPromptAppend: systemPrompt,
            permissionMode: config.readOnly ? 'plan' : 'acceptEdits',
            envOverrides: orch.hookEnv('developer', agent),
            enableChrome: false,
            signal: controller.signal,
          },
          (e) => this.onAgentStreamEvent(ctx, agent, e),
        );
        orch.dispatch({ kind: 'dev-turn-end' });

        const replyText = result.events
          .filter((e) => e.type === 'assistant')
          .map((e) => extractAssistantText(e))
          .join('\n');
        if (replyText) {
          ctx.orchestrator.messages.enqueue({
            to: 'supervisor',
            source: 'developer',
            body: `USER_AGENT_DIALOG (informational): ${agent} replied: ${replyText.slice(0, 800)}`,
          });
          // Wake the supervisor on the side-channel — same dual of
          // sup-uyuyor as messageDeveloper.
          ctx.currentAbort = { role: 'supervisor', controller };
          await this.followUpSupervisor(ctx, SUP_FOLLOWUP_AFTER_DEV_DIRECT, controller.signal);
        }
      } catch (e) {
        this.surfaceFailure(ctx, agent, (e as Error).message);
      } finally {
        ctx.currentAbort = null;
        ctx.busy = null;
        this.emitEvent(ctx, { kind: 'turn-busy', busy: false });
      }
    })();
    ctx.busy = run;
  }

  async messageDeveloper(id: string, text: string): Promise<void> {
    const ctx = this.sessions.get(id);
    if (!ctx) throw new Error(`session not found: ${id}`);
    if (ctx.busy) throw new Error('session is busy with another turn');

    // User is taking over the developer — its pending wakeup (if any) is moot.
    this.wakeups.cancel(id, 'developer', 'user-input');

    const ts = Date.now();
    await this.appendLog(ctx, { type: 'user-message-dev', text, ts });
    this.emitEvent(ctx, { kind: 'user-message-dev', text, ts });

    ctx.orchestrator.messages.enqueue({
      to: 'developer',
      source: 'user',
      body: `USER_DIRECT_MESSAGE:\n${text}`,
    });
    // Keep the supervisor in the loop without disrupting its planning.
    ctx.orchestrator.messages.enqueue({
      to: 'supervisor',
      source: 'user',
      body: `USER_DEV_DIALOG (informational): user said directly to developer: "${text}"`,
    });

    this.emitEvent(ctx, { kind: 'turn-busy', busy: true });
    const controller = new AbortController();
    ctx.currentAbort = { role: 'developer', controller };
    const run = (async () => {
      try {
        const orch = ctx.orchestrator;
        const ws = orch.getWorkspace();
        orch.dispatch({ kind: 'dev-turn-start' });
        const devResult = await runClaudeTurn(
          {
            role: 'developer',
            cwd: ws.cwd,
            prompt:
              'A direct user message has been injected into your context (USER_DIRECT_MESSAGE). ' +
              'Respond to the user clearly and concisely. Use tools if appropriate, but plain ' +
              'text replies are also fine. The supervisor is aware of this side conversation.',
            resumeSessionId: ctx.developerSessionId ?? undefined,
            settingsPath: ws.settingsPath,
            systemPromptAppend: loadDeveloperSystemPrompt(),
            permissionMode: 'acceptEdits',
            envOverrides: orch.hookEnv('developer', 'developer'),
            enableChrome: false,
            signal: controller.signal,
          },
          (e) => this.onDeveloperStreamEvent(ctx, e),
        );
        ctx.developerSessionId = devResult.sessionId ?? ctx.developerSessionId;
        orch.dispatch({ kind: 'dev-turn-end' });

        const devText = devResult.events
          .filter((e) => e.type === 'assistant')
          .map((e) => extractAssistantText(e))
          .join('\n');
        if (devText) {
          ctx.orchestrator.messages.enqueue({
            to: 'supervisor',
            source: 'developer',
            body: `USER_DEV_DIALOG (informational): developer replied: ${devText.slice(0, 800)}`,
          });
          // Switch the abort target to supervisor for the follow-up turn.
          ctx.currentAbort = { role: 'supervisor', controller };
          await this.followUpSupervisor(ctx, SUP_FOLLOWUP_AFTER_DEV_DIRECT, controller.signal);
        }
      } catch (e) {
        this.surfaceFailure(ctx, 'developer', (e as Error).message);
      } finally {
        ctx.currentAbort = null;
        ctx.busy = null;
        this.emitEvent(ctx, { kind: 'turn-busy', busy: false });
      }
    })();
    ctx.busy = run;
  }

  /**
   * Operator-initiated emergency stop: SIGTERM the CC subprocess of the
   * currently-running turn. Returns true if a turn was actually aborted,
   * false if the session was idle. The expected role argument is mostly
   * advisory (only one role can be running at a time) — we still return
   * what role was actually aborted so the UI can confirm.
   *
   * After abort, `runClaudeTurn`'s promise rejects; the wrapping `run`
   * promise in `sendMessage` / `messageDeveloper` / `fire*Wakeup` catches
   * the error, emits an `error` event, and clears `ctx.busy` in its
   * `finally`. The session returns to idle automatically.
   */
  abortTurn(id: string, role?: WakeupRole): { aborted: boolean; role: WakeupRole | null } {
    const ctx = this.sessions.get(id);
    if (!ctx) throw new Error(`session not found: ${id}`);
    const active = ctx.currentAbort;
    if (!active) return { aborted: false, role: null };
    log('warn', 'session.turn_aborted', {
      id,
      requestedRole: role,
      activeRole: active.role,
    });
    active.controller.abort();
    this.emitEvent(ctx, { kind: 'turn-aborted', role: active.role, ts: Date.now() });
    return { aborted: true, role: active.role };
  }

  /**
   * Manually fire the most recent unsettled wakeup for `role` (if any).
   * Used when the operator wants to wake an agent immediately rather than
   * waiting for the scheduled timer. Returns true if a wakeup was found
   * and dispatched, false if nothing to wake.
   *
   * The lookup walks the chat-log (not the in-memory runner) so it also
   * recovers legacy `ScheduleWakeup` tool calls recorded before this
   * runner existed: a `dev-tool-call` whose name is `ScheduleWakeup` and
   * which has no matching `wakeup-scheduled` entry in the same role.
   */
  async triggerWakeup(id: string, role: WakeupRole): Promise<boolean> {
    const ctx = this.sessions.get(id);
    if (!ctx) throw new Error(`session not found: ${id}`);
    const entries = await readChatLog(ctx.cwd);

    // First pass: any unsettled wakeup-scheduled entry?
    let pending: { fireAt: number; prompt: string; reason: string } | null = null;
    const settled = new Set<string>();
    for (const entry of entries) {
      if (
        entry.type === 'wakeup-scheduled' ||
        entry.type === 'wakeup-fired' ||
        entry.type === 'wakeup-cancelled'
      ) {
        if (entry.role !== role) continue;
        if (entry.type === 'wakeup-scheduled') {
          pending = {
            fireAt: entry.fireAt,
            prompt: entry.prompt,
            reason: entry.reason,
          };
        } else {
          settled.add(entry.wakeupId);
          if (
            pending &&
            entries.find(
              (e) => e.type === 'wakeup-scheduled' && e.wakeupId === entry.wakeupId,
            )
          ) {
            pending = null;
          }
        }
      }
    }

    // Legacy fallback: old runs recorded ScheduleWakeup as a dev-tool-call.
    // Only meaningful for the developer role.
    if (!pending && role === 'developer') {
      let legacy: { fireAt: number; prompt: string; reason: string } | null = null;
      for (const entry of entries) {
        if (entry.type === 'dev-tool-call' && entry.name === 'ScheduleWakeup') {
          const inp = entry.input as {
            delaySeconds?: unknown;
            prompt?: unknown;
            reason?: unknown;
          };
          const delay = Number(inp.delaySeconds);
          if (!Number.isFinite(delay) || delay <= 0) continue;
          legacy = {
            fireAt: entry.ts + delay * 1000,
            prompt: typeof inp.prompt === 'string' ? inp.prompt : '',
            reason: typeof inp.reason === 'string' ? inp.reason : '',
          };
        }
      }
      if (legacy && legacy.prompt) pending = legacy;
    }

    if (!pending) return false;

    // Synthesise a one-off ScheduledWakeup descriptor for the dispatcher.
    // We don't go through the runner (no timer to install — fire is now);
    // emit the wakeup-fired event directly so chat-log records it.
    const wakeupId = randomUUID();
    const now = Date.now();
    const synthetic: ScheduledWakeup = {
      id: wakeupId,
      role,
      scheduledAt: now,
      fireAt: now,
      prompt: pending.prompt,
      reason: pending.reason || '(manual trigger)',
    };
    void this.appendLog(ctx, {
      type: 'wakeup-fired',
      wakeupId,
      role,
      ts: now,
    });
    this.emitEvent(ctx, { kind: 'wakeup-fired', wakeupId, role, ts: now });
    void this.dispatchWakeup(id, synthetic);
    return true;
  }

  async resolveQuestion(id: string, questionId: string, answer: string): Promise<boolean> {
    const ctx = this.sessions.get(id);
    if (!ctx) return false;
    const ok = ctx.orchestrator.resolveUserQuestion(questionId, answer);
    if (ok) {
      const ts = Date.now();
      await this.appendLog(ctx, { type: 'question-resolved', id: questionId, answer, ts });
    }
    return ok;
  }

  async resolveApproval(
    id: string,
    approvalId: string,
    decision: 'allow' | 'deny',
  ): Promise<boolean> {
    const ctx = this.sessions.get(id);
    if (!ctx) return false;
    const ok = ctx.orchestrator.resolveApproval(approvalId, decision);
    if (ok) {
      const ts = Date.now();
      await this.appendLog(ctx, { type: 'approval-resolved', id: approvalId, decision, ts });
    }
    return ok;
  }

  /**
   * Snapshot for the session view. When `limit` is supplied we return only
   * the last N chat-log entries and signal `hasMoreHistory` so the
   * frontend can lazy-load older history on demand. Long-running sessions
   * routinely accumulate thousands of entries; loading them all at boot
   * froze the browser for several seconds, hence the cutoff.
   */
  async getSnapshot(
    id: string,
    opts: { limit?: number } = {},
  ): Promise<SessionSnapshot | null> {
    const ctx = this.sessions.get(id);
    if (!ctx) return null;
    const fullLog = await readChatLog(ctx.cwd);
    const limit = opts.limit;
    let chatLog = fullLog;
    let hasMoreHistory = false;
    if (typeof limit === 'number' && limit > 0 && fullLog.length > limit) {
      chatLog = fullLog.slice(-limit);
      hasMoreHistory = true;
    }
    return {
      meta: this.toMeta(ctx),
      chatLog,
      pendingQuestions: ctx.orchestrator.listPendingQuestions(),
      pendingApprovals: ctx.orchestrator.listPendingApprovals(),
      metrics: {
        sup: ctx.supMetrics,
        dev: ctx.devMetrics,
        agents: Object.fromEntries(ctx.agentMetrics.entries()),
      },
      hasMoreHistory,
    };
  }

  /**
   * Walk `docs/phases/*.md` and parse markdown-checkbox DoD items so the
   * left sidebar can render phase-by-phase progress. The supervisor
   * writes phase docs as the project enters Documentation; dev flips
   * `- [ ]` items to `- [x]` as it completes them. Everything is plain
   * markdown — no separate state file, no schema risk.
   */
  async getPhaseProgress(id: string): Promise<{
    phases: Array<{
      filename: string;
      title: string;
      totalItems: number;
      completedItems: number;
      tree: PhaseNode[];
    }>;
  } | null> {
    const ctx = this.sessions.get(id);
    if (!ctx) return null;
    const { join } = await import('node:path');
    const { readdir, readFile, stat } = await import('node:fs/promises');
    const phasesDir = join(ctx.cwd, 'docs', 'phases');
    let entries: string[];
    try {
      const dirents = await readdir(phasesDir, { withFileTypes: true });
      entries = dirents
        .filter((d) => d.isFile() && d.name.endsWith('.md'))
        .map((d) => d.name)
        .sort();
    } catch {
      return { phases: [] };
    }
    const phases: Array<{
      filename: string;
      title: string;
      totalItems: number;
      completedItems: number;
      tree: PhaseNode[];
    }> = [];
    for (const filename of entries) {
      const full = join(phasesDir, filename);
      let raw: string;
      try {
        const st = await stat(full);
        if (st.size > 256 * 1024) continue; // skip enormous files
        raw = await readFile(full, 'utf8');
      } catch {
        continue;
      }
      const lines = raw.split('\n');
      // Title = first H1 if present, else basename without extension.
      const h1 = lines.find((l) => l.startsWith('# '))?.replace(/^#\s+/, '').trim();
      const title = h1 || filename.replace(/\.md$/, '');
      const tree = parsePhaseTree(lines);
      const { total, completed } = countCheckboxes(tree);
      phases.push({
        filename,
        title,
        totalItems: total,
        completedItems: completed,
        tree,
      });
    }
    return { phases };
  }

  /**
   * Read the structured phase tracker (`<cwd>/.selfclaude/phases.json`).
   * Returns an empty file shape when the project has no tracker yet so
   * the frontend can render a useful empty state without 404 handling.
   */
  async getPhaseTracker(id: string): Promise<PhasesFile | null> {
    const ctx = this.sessions.get(id);
    if (!ctx) return null;
    return readPhases(ctx.cwd);
  }

  /**
   * Operator-side override for an empty-evidence done item. Routes to
   * the orchestrator and surfaces the result; the orchestrator emits
   * `phase-tracker-updated` so the UI refreshes via the normal flow.
   */
  async operatorVerifyPhaseItem(
    id: string,
    slug: string,
    itemId: string,
    notes?: string,
  ): Promise<{ ok: boolean; message: string } | null> {
    const ctx = this.sessions.get(id);
    if (!ctx) return null;
    return ctx.orchestrator.operatorVerifyItem({ slug, itemId, notes });
  }

  /**
   * Per-project MCP tool telemetry — every supervisor + specialist
   * MCP call is counted in `<cwd>/.selfclaude/mcp-telemetry.json`.
   * Used by the Settings modal's "MCP Tools" tab to surface usage
   * patterns and recent calls.
   */
  async getMcpTelemetry(id: string): Promise<unknown | null> {
    const ctx = this.sessions.get(id);
    if (!ctx) return null;
    return ctx.orchestrator.getMcpTelemetry();
  }

  /* ───── Bash macro / script proposal passthroughs ─────
   *
   * The supervisor proposes via the MCP path; operator review uses
   * these REST passthroughs. The orchestrator owns the lifecycle +
   * file writes; we just route session id → orchestrator + wake sup
   * with a synthetic followup so it processes the SCRIPT_APPROVED /
   * SCRIPT_REJECTED inbox entry it just got, instead of waiting for
   * the operator's next message to drain the queue.
   */
  async getSessionScripts(id: string) {
    const ctx = this.sessions.get(id);
    if (!ctx) return null;
    return ctx.orchestrator.getScripts();
  }
  async approveSessionScript(
    id: string,
    slug: string,
    operator: string,
    notes?: string,
  ) {
    const ctx = this.sessions.get(id);
    if (!ctx) return null;
    const result = await ctx.orchestrator.approveScriptProposal(slug, operator, notes);
    if (result.ok && !ctx.busy) {
      // Fire-and-forget sup turn so it sees the SCRIPT_APPROVED entry.
      // Skipped when sup is already busy — the inbox will drain on its
      // current turn.
      void this.followUpSupervisor(ctx, SUP_FOLLOWUP_AFTER_SCRIPT_REVIEW).catch(
        () => {
          /* error already surfaces via emitEvent in followUpSupervisor */
        },
      );
    }
    return result;
  }
  async rejectSessionScript(
    id: string,
    slug: string,
    operator: string,
    reason: string,
  ) {
    const ctx = this.sessions.get(id);
    if (!ctx) return null;
    const result = await ctx.orchestrator.rejectScriptProposal(slug, operator, reason);
    if (result.ok && !ctx.busy) {
      void this.followUpSupervisor(ctx, SUP_FOLLOWUP_AFTER_SCRIPT_REVIEW).catch(
        () => {
          /* silent */
        },
      );
    }
    return result;
  }

  /**
   * Single shot of every chat-log-derived view the right-hand detail
   * tabs need (Tasks / Schedule / Files). The frontend reads this once
   * on mount and refetches when SSE signals new tool / wakeup activity
   * — this is the only way to render data from the *full* session
   * history when the chat panes themselves are lazy-loaded windows.
   */
  async getDerivedState(id: string): Promise<{
    todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }> | null;
    files: {
      created: { path: string; ts: number }[];
      modified: { path: string; ts: number }[];
      read: { path: string; ts: number }[];
    };
    wakeups: Array<{
      id: string;
      role: 'supervisor' | 'developer';
      scheduledAt: number;
      fireAt: number;
      reason: string;
      status: 'pending' | 'fired' | 'cancelled';
    }>;
    crons: Array<{
      id: string;
      scheduledAt: number;
      schedule: string;
      description: string;
      cronId: string | null;
      status: 'active' | 'deleted';
    }>;
    /** Specialist agents currently summoned for this session (always includes 'developer'). */
    activeAgents: string[];
  } | null> {
    const ctx = this.sessions.get(id);
    if (!ctx) return null;
    const fullLog = await readChatLog(ctx.cwd);

    // ── Tasks: latest TodoWrite from ANY agent (developer OR specialist)
    //    wins. Each agent maintains its own todo list internally; we pick
    //    whichever was written most recently.
    let todos:
      | Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }>
      | null = null;
    for (let i = fullLog.length - 1; i >= 0; i--) {
      const e = fullLog[i]!;
      const isTodoWrite =
        (e.type === 'dev-tool-call' || e.type === 'agent-tool-call') &&
        e.name === 'TodoWrite';
      if (!isTodoWrite) continue;
      const raw = (e.input as { todos?: unknown }).todos;
      if (!Array.isArray(raw)) break;
      const valid: Array<{
        content: string;
        status: 'pending' | 'in_progress' | 'completed';
        activeForm?: string;
      }> = [];
      for (const t of raw) {
        if (
          typeof t === 'object' &&
          t !== null &&
          typeof (t as { content?: unknown }).content === 'string' &&
          ['pending', 'in_progress', 'completed'].includes(
            String((t as { status?: unknown }).status),
          )
        ) {
          const cast = t as {
            content: string;
            status: 'pending' | 'in_progress' | 'completed';
            activeForm?: string;
          };
          valid.push({
            content: cast.content,
            status: cast.status,
            activeForm: cast.activeForm,
          });
        }
      }
      todos = valid;
      break;
    }

    // ── Files: same logic as getFileOperations.
    type Action = 'created' | 'modified' | 'read';
    const filePriority: Record<Action, number> = { read: 0, modified: 1, created: 2 };
    const byPath = new Map<string, { action: Action; ts: number }>();

    // ── Wakeups: walk scheduled/fired/cancelled events keyed on wakeupId.
    const wakeupMap = new Map<
      string,
      {
        id: string;
        role: 'supervisor' | 'developer';
        scheduledAt: number;
        fireAt: number;
        reason: string;
        status: 'pending' | 'fired' | 'cancelled';
      }
    >();

    // ── Crons: pair CronCreate with the eventual id from tool-result, then
    //    flip to 'deleted' if a CronDelete arrives.
    const cronByToolUseId = new Map<
      string,
      {
        id: string;
        scheduledAt: number;
        schedule: string;
        description: string;
        cronId: string | null;
        status: 'active' | 'deleted';
      }
    >();
    const cronByCronId = new Map<string, { cronId: string }>();

    for (const e of fullLog) {
      if (e.type === 'dev-tool-call' || e.type === 'agent-tool-call') {
        // Files: Read/Edit/Write — both default-developer and specialist
        // agents touch the same project filesystem, so their tool calls
        // both feed the Files panel. Without this every Write the
        // ui-dev agent issues was invisible to the operator.
        const path = String((e.input as { file_path?: unknown })?.file_path ?? '');
        if (path) {
          let action: Action | null = null;
          if (e.name === 'Write') action = 'created';
          else if (e.name === 'Edit') action = 'modified';
          else if (e.name === 'Read') action = 'read';
          if (action) {
            const existing = byPath.get(path);
            if (!existing || filePriority[action] >= filePriority[existing.action]) {
              byPath.set(path, { action, ts: e.ts });
            }
          }
        }
        // Crons: CronCreate
        if (e.name === 'CronCreate') {
          const input = e.input as {
            schedule?: unknown;
            cron?: unknown;
            cronExpression?: unknown;
            prompt?: unknown;
            reason?: unknown;
            description?: unknown;
          };
          const schedule = String(input.schedule ?? input.cron ?? input.cronExpression ?? '');
          const description = String(input.description ?? input.reason ?? input.prompt ?? '');
          if (schedule) {
            cronByToolUseId.set(e.toolUseId, {
              id: e.toolUseId,
              scheduledAt: e.ts,
              schedule,
              description,
              cronId: null,
              status: 'active',
            });
          }
        }
        // Crons: CronDelete
        if (e.name === 'CronDelete') {
          const input = e.input as { id?: unknown; cronId?: unknown };
          const cronId = String(input.id ?? input.cronId ?? '');
          if (cronId) {
            const ref = cronByCronId.get(cronId);
            if (ref) {
              const cron = cronByToolUseId.get(ref.cronId);
              if (cron) cron.status = 'deleted';
            }
          }
        }
      } else if (e.type === 'dev-tool-result') {
        const job = cronByToolUseId.get(e.toolUseId);
        if (job) {
          const m =
            e.text.match(/\b(?:id[:=]?\s*|cron(?:[\s_-]?id)?[:=]?\s*)([\w-]{6,})/i) ??
            e.text.match(/`([\w-]{6,})`/);
          if (m && m[1]) {
            job.cronId = m[1];
            cronByCronId.set(m[1], { cronId: e.toolUseId });
          }
        }
      } else if (e.type === 'wakeup-scheduled') {
        wakeupMap.set(e.wakeupId, {
          id: e.wakeupId,
          role: e.role,
          scheduledAt: e.ts,
          fireAt: e.fireAt,
          reason: e.reason,
          status: 'pending',
        });
      } else if (e.type === 'wakeup-fired') {
        const w = wakeupMap.get(e.wakeupId);
        if (w) w.status = 'fired';
      } else if (e.type === 'wakeup-cancelled') {
        const w = wakeupMap.get(e.wakeupId);
        if (w) w.status = 'cancelled';
      }
    }

    const sortDesc = (a: { ts: number }, b: { ts: number }) => b.ts - a.ts;
    const created: { path: string; ts: number }[] = [];
    const modified: { path: string; ts: number }[] = [];
    const read: { path: string; ts: number }[] = [];
    for (const [path, info] of byPath) {
      const entry = { path, ts: info.ts };
      if (info.action === 'created') created.push(entry);
      else if (info.action === 'modified') modified.push(entry);
      else read.push(entry);
    }
    created.sort(sortDesc);
    modified.sort(sortDesc);
    read.sort(sortDesc);

    const wakeups = Array.from(wakeupMap.values()).sort(
      (a, b) => b.scheduledAt - a.scheduledAt,
    );
    const crons = Array.from(cronByToolUseId.values()).sort(
      (a, b) => b.scheduledAt - a.scheduledAt,
    );

    return {
      todos,
      files: { created, modified, read },
      wakeups,
      crons,
      activeAgents: Array.from(ctx.activeAgents),
    };
  }

  /**
   * Aggregate every file operation in the session's full chat-log into
   * three buckets: Created (Write), Modified (Edit), Read (Read). The
   * Files tab needs this independently of the lazy-loaded chatLog
   * window — the operator wants to see *every* file the developer
   * touched, not just the ones in the last 50 messages.
   *
   * Latest-action-wins per path: a path that was first read and later
   * written shows up under Created (the most-impactful action). Within
   * each bucket, paths are sorted by most-recent-first.
   */
  async getFileOperations(id: string): Promise<{
    created: { path: string; ts: number }[];
    modified: { path: string; ts: number }[];
    read: { path: string; ts: number }[];
  } | null> {
    const ctx = this.sessions.get(id);
    if (!ctx) return null;
    const fullLog = await readChatLog(ctx.cwd);
    type Action = 'created' | 'modified' | 'read';
    const priority: Record<Action, number> = { read: 0, modified: 1, created: 2 };
    const byPath = new Map<string, { action: Action; ts: number }>();
    for (const e of fullLog) {
      if (e.type !== 'dev-tool-call') continue;
      const path = String((e.input as { file_path?: unknown })?.file_path ?? '');
      if (!path) continue;
      let action: Action | null = null;
      if (e.name === 'Write') action = 'created';
      else if (e.name === 'Edit') action = 'modified';
      else if (e.name === 'Read') action = 'read';
      if (!action) continue;
      const existing = byPath.get(path);
      if (!existing || priority[action] >= priority[existing.action]) {
        byPath.set(path, { action, ts: e.ts });
      }
    }
    const sortDesc = (a: { ts: number }, b: { ts: number }) => b.ts - a.ts;
    const created: { path: string; ts: number }[] = [];
    const modified: { path: string; ts: number }[] = [];
    const read: { path: string; ts: number }[] = [];
    for (const [path, info] of byPath) {
      const entry = { path, ts: info.ts };
      if (info.action === 'created') created.push(entry);
      else if (info.action === 'modified') modified.push(entry);
      else read.push(entry);
    }
    created.sort(sortDesc);
    modified.sort(sortDesc);
    read.sort(sortDesc);
    return { created, modified, read };
  }

  /**
   * Fetch a window of older chat-log entries for lazy-load. Returns the
   * `limit` entries whose `ts` is strictly less than `before`. Sorted
   * ascending so the caller can prepend directly. `hasMoreHistory` flags
   * whether more older entries remain past the returned window.
   */
  async getHistory(
    id: string,
    before: number,
    limit: number,
  ): Promise<{ entries: ChatLogEntry[]; hasMoreHistory: boolean } | null> {
    const ctx = this.sessions.get(id);
    if (!ctx) return null;
    const fullLog = await readChatLog(ctx.cwd);
    const earlier = fullLog.filter((e) => e.ts < before);
    if (earlier.length === 0) return { entries: [], hasMoreHistory: false };
    const sliceStart = Math.max(0, earlier.length - limit);
    return {
      entries: earlier.slice(sliceStart),
      hasMoreHistory: sliceStart > 0,
    };
  }

  async destroyAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.destroySession(id)));
  }

  // --- internal ---

  private toMeta(ctx: SessionContext): SessionMeta {
    const fsmState = ctx.orchestrator.getState();
    return {
      id: ctx.id,
      cwd: ctx.cwd,
      label: ctx.label,
      createdAt: ctx.createdAt,
      phase: fsmState.tag === 'shutdown' ? 'shutdown' : fsmState.phase,
      supActive: fsmState.tag === 'sup-running',
      devActive: fsmState.tag === 'dev-running',
      busy: ctx.busy !== null,
    };
  }

  private async appendLog(ctx: SessionContext, entry: ChatLogEntry): Promise<void> {
    // Phase 7 sprint 2B — sniff progress markers as events flow
    // through. We never need to scan the chat-log later; the
    // periodic stuck check just reads ctx.lastProgressTs.
    const toolName = (entry as { name?: string }).name;
    if (isProgressMarker(entry.type, toolName)) {
      ctx.lastProgressTs = entry.ts;
    }
    try {
      await appendChatLogEntry(ctx.cwd, entry);
    } catch (e) {
      log('warn', 'session.chat_log_append_failed', {
        id: ctx.id,
        error: (e as Error).message,
      });
    }
  }

  /**
   * Phase 7 sprint 2B — run the stuck detector against this session
   * and emit `session-stuck` only on transitions. Cheap (pure
   * function over a 6-field input), so the periodic timer can call
   * it freely.
   */
  private checkStuck(ctx: SessionContext): void {
    const fsm = ctx.orchestrator.getState();
    // FsmState.shutdown has no `phase` field (terminal state); for
    // shutdown sessions stuck-detection is moot anyway. Fall back to
    // a benign label that maps to "no special handling" inside the
    // detector.
    const phase = 'phase' in fsm ? fsm.phase : 'shutdown';
    const result: StuckCheckResult = detectStuck({
      nowMs: Date.now(),
      lastProgressTs: ctx.lastProgressTs,
      supTurnCount: ctx.supMetrics.totalTurns,
      fsmPhase: phase,
      hasPending:
        ctx.orchestrator.listPendingQuestions().length > 0 ||
        ctx.orchestrator.listPendingApprovals().length > 0,
      busy: ctx.busy !== null,
    });
    if (result.stuck === ctx.currentlyStuck) return;
    ctx.currentlyStuck = result.stuck;
    log('info', 'session.stuck_transition', {
      id: ctx.id,
      stuck: result.stuck,
      reason: result.reason,
      minutesSinceProgress: result.minutesSinceProgress,
    });
    this.emitEvent(ctx, {
      kind: 'session-stuck',
      stuck: result.stuck,
      reason: result.reason,
      minutesSinceProgress: result.minutesSinceProgress,
      ts: Date.now(),
    });
  }

  private emitEvent(ctx: SessionContext, event: SessionEvent): void {
    ctx.emitter.emit('event', event);
  }

  private attachOrchestratorEvents(ctx: SessionContext): void {
    const orch = ctx.orchestrator;
    orch.on('state-changed', (state: FsmState) => {
      this.emitEvent(ctx, { kind: 'state-changed', state });
    });
    orch.on('user-question', (q: PendingQuestionView) => {
      const ts = Date.now();
      void this.appendLog(ctx, {
        type: 'question',
        id: q.id,
        text: q.question,
        options: q.options,
        ts,
      });
      this.emitEvent(ctx, { kind: 'question', question: q });
    });
    orch.on('user-question-resolved', ({ id, answer }: { id: string; answer: string }) => {
      this.emitEvent(ctx, { kind: 'question-resolved', id, answer });
    });
    orch.on('approval-requested', (a: PendingApprovalView) => {
      const ts = Date.now();
      void this.appendLog(ctx, {
        type: 'approval',
        id: a.id,
        action: a.action,
        reason: a.reason,
        ts,
      });
      this.emitEvent(ctx, { kind: 'approval', approval: a });
    });
    orch.on(
      'approval-resolved',
      ({ id, decision }: { id: string; decision: 'allow' | 'deny' }) => {
        this.emitEvent(ctx, { kind: 'approval-resolved', id, decision });
      },
    );
    orch.on('phase-doc-written', (e: { filename: string }) => {
      const ts = Date.now();
      void this.appendLog(ctx, { type: 'phase-doc-written', filename: e.filename, ts });
      this.emitEvent(ctx, { kind: 'phase-doc-written', filename: e.filename, ts });
    });
    // Phase 2 telemetry — every contract validation attempt feeds the
    // first-pass / ultimate-pass rate rollup. Both valid AND invalid
    // attempts are recorded so the rate math has a denominator.
    orch.on('phase-contract-attempt', (e: PhaseContractAttemptEvent) => {
      void this.recordMetric(ctx, {
        kind: 'phase-contract-attempt',
        sessionId: ctx.id,
        filename: e.filename,
        contractName: e.contractName,
        attemptNumber: e.attemptNumber,
        valid: e.valid,
        override: e.override,
        ts: e.ts,
      });
    });
    // Phase 4 telemetry — every supervisor inbox drain reports its
    // before/after token count plus the marker labels it preserved
    // through compression. Aggregated into the inboxCompression rollup
    // so operators (and future regression tests) can see how much
    // narrative is being trimmed without losing decisions.
    orch.on(
      'inbox-compressed',
      (e: {
        role: string;
        messageCount: number;
        originalTokens: number;
        compressedTokens: number;
        preservedMarkers: string[];
        ts: number;
      }) => {
        void this.recordMetric(ctx, {
          kind: 'tokens-estimated',
          sessionId: ctx.id,
          role: e.role,
          messageCount: e.messageCount,
          originalTokens: e.originalTokens,
          compressedTokens: e.compressedTokens,
          preservedMarkers: e.preservedMarkers,
          ts: e.ts,
        });
      },
    );
    orch.on(
      'phase-tracker-updated',
      (
        e:
          | {
              kind: 'registered';
              slug: string;
              title: string;
              itemCount: number;
              isReregistration: boolean;
              file: PhasesFile;
            }
          | {
              kind: 'proposed';
              slug: string;
              itemId: string;
              itemTitle: string;
              agent: string;
              notes: string;
              file: PhasesFile;
            }
          | {
              kind: 'confirmed';
              slug: string;
              itemId: string;
              itemTitle: string;
              confirmer: string;
              proposer: string | null;
              evidence: ConfirmEvidence | null;
              notes: string;
              file: PhasesFile;
            }
          | {
              kind: 'rejected';
              slug: string;
              itemId: string;
              itemTitle: string;
              rejector: string;
              proposer: string | null;
              reason: string;
              file: PhasesFile;
            }
          | {
              /**
               * External-edit: the file changed via something other than
               * the four MCP handlers — typically the supervisor used
               * `Write` directly. We push the new snapshot through SSE
               * but skip chat-log append (no per-item context to log).
               */
              kind: 'external-edit';
              slug: string;
              file: PhasesFile;
            }
          | {
              /**
               * Operator marked an empty-evidence done item as verified
               * out-of-band via the web UI's "Mark operator-verified"
               * button. Mirror chat-log entry as
               * `phase-item-operator-verified`.
               */
              kind: 'operator-verified';
              slug: string;
              itemId: string;
              itemTitle: string;
              operator: string;
              notes: string;
              file: PhasesFile;
            },
      ) => {
        const ts = Date.now();
        // External-edit: file changed outside the MCP path (sup wrote
        // it directly with `Write`). Push snapshot through SSE only —
        // there's no per-item context to record in chat-log. Frontend
        // store treats `logEntry: null` as "snapshot only, skip append".
        if (e.kind === 'external-edit') {
          this.emitEvent(ctx, {
            kind: 'phase-tracker-updated',
            action: 'external-edit',
            slug: '',
            file: e.file,
            logEntry: null,
            ts,
          });
          return;
        }
        // Build the matching chat-log entry once; the same shape lands
        // in chat-log.jsonl AND ships out on the SSE event so the UI's
        // Audit Log panel sees the mutation live without re-fetching.
        let logEntry: ChatLogEntry;
        if (e.kind === 'registered') {
          logEntry = {
            type: 'phase-registered',
            slug: e.slug,
            title: e.title,
            itemCount: e.itemCount,
            isReregistration: e.isReregistration,
            ts,
          };
        } else if (e.kind === 'proposed') {
          logEntry = {
            type: 'phase-item-proposed',
            slug: e.slug,
            itemId: e.itemId,
            itemTitle: e.itemTitle,
            agent: e.agent,
            notes: e.notes,
            ts,
          };
        } else if (e.kind === 'confirmed') {
          logEntry = {
            type: 'phase-item-confirmed',
            slug: e.slug,
            itemId: e.itemId,
            itemTitle: e.itemTitle,
            confirmer: e.confirmer,
            proposer: e.proposer,
            evidence: e.evidence,
            notes: e.notes,
            ts,
          };
        } else if (e.kind === 'rejected') {
          logEntry = {
            type: 'phase-item-rejected',
            slug: e.slug,
            itemId: e.itemId,
            itemTitle: e.itemTitle,
            rejector: e.rejector,
            proposer: e.proposer,
            reason: e.reason,
            ts,
          };
        } else {
          // operator-verified
          logEntry = {
            type: 'phase-item-operator-verified',
            slug: e.slug,
            itemId: e.itemId,
            itemTitle: e.itemTitle,
            operator: e.operator,
            notes: e.notes,
            ts,
          };
        }
        // Persist to disk; failures are logged but never propagated —
        // the SSE event still fires and the snapshot is consistent.
        void this.appendLog(ctx, logEntry).catch((err: unknown) => {
          // biome-ignore lint/suspicious/noConsole: orchestrator-side warning
          console.warn('phase-tracker chat-log append failed:', err);
        });
        this.emitEvent(ctx, {
          kind: 'phase-tracker-updated',
          action: e.kind,
          slug: e.slug,
          itemId: 'itemId' in e ? e.itemId : undefined,
          agent:
            e.kind === 'proposed'
              ? e.agent
              : e.kind === 'confirmed'
                ? e.confirmer
                : e.kind === 'rejected'
                  ? e.rejector
                  : e.kind === 'operator-verified'
                    ? e.operator
                    : undefined,
          file: e.file,
          logEntry,
          ts,
        });
      },
    );
    orch.on('conversation-completed', (info: { iterations: number }) => {
      this.emitEvent(ctx, { kind: 'iteration-end', iteration: info.iterations });
    });
    orch.on(
      'scripts-updated',
      (e: { kind: 'proposed' | 'approved' | 'rejected'; slug: string; file: unknown }) => {
        this.emitEvent(ctx, {
          kind: 'scripts-updated',
          action: e.kind,
          slug: e.slug,
          file: e.file,
          ts: Date.now(),
        });
      },
    );
  }

  /**
   * Stream-event handler for specialist agents (everyone except sup and
   * the default developer). Mirrors `onSupervisorStreamEvent` /
   * `onDeveloperStreamEvent` but emits generic `agent-*` SSE events with
   * an explicit `agent` field so the UI can render multiple tabs from
   * one stream.
   *
   * The default developer still flows through `onDeveloperStreamEvent`
   * to preserve the existing `dev-*` event surface and chat-log entries.
   */
  private onAgentStreamEvent(ctx: SessionContext, agent: string, e: StreamEvent): void {
    if (agent === 'developer') {
      this.onDeveloperStreamEvent(ctx, e);
      return;
    }
    const ts = Date.now();
    const delta = extractStreamTextDelta(e);
    if (delta) {
      ctx.agentDeltaCount.set(agent, (ctx.agentDeltaCount.get(agent) ?? 0) + 1);
      this.emitEvent(ctx, { kind: 'agent-text-delta', agent, delta, ts });
      return;
    }
    const thinkingDelta = extractStreamThinkingDelta(e);
    if (thinkingDelta) {
      ctx.agentThinkingDeltaCount.set(
        agent,
        (ctx.agentThinkingDeltaCount.get(agent) ?? 0) + 1,
      );
      this.emitEvent(ctx, {
        kind: 'agent-thinking-delta',
        agent,
        delta: thinkingDelta,
        ts,
      });
      return;
    }
    const metrics = extractResultMetrics(e);
    if (metrics) {
      // Each specialist now gets its own bucket keyed by agent name.
      this.applyMetrics(ctx, agent, metrics, ts);
      return;
    }
    for (const tu of extractToolUses(e)) {
      const id = randomUUID();
      void this.appendLog(ctx, {
        type: 'agent-tool-call',
        agent,
        id,
        toolUseId: tu.id,
        name: tu.name,
        input: tu.input,
        ts,
      });
      this.emitEvent(ctx, {
        kind: 'agent-tool-call',
        agent,
        id,
        toolUseId: tu.id,
        name: tu.name,
        input: tu.input,
        ts,
      });
      void this.recordMetric(ctx, {
        kind: 'tool-call',
        sessionId: ctx.id,
        agent,
        tool: tu.name,
        filePath: this.extractToolFilePath(tu.input),
        ts,
      });
      // Specialist agents can also schedule wakeups for themselves; map
      // them through the existing wakeup runner using the agent's name
      // as the role label so the UI can attribute the wakeup correctly.
      if (tu.name === 'ScheduleWakeup') {
        // Wakeup runner only knows 'supervisor' / 'developer'; route any
        // specialist back to the developer bucket so the timer fires
        // through `messageDeveloper` — close enough for now, full
        // per-agent wakeup support is future work.
        this.scheduleAgentWakeup(ctx, 'developer', tu.input);
      }
    }
    for (const tr of extractToolResults(e)) {
      void this.appendLog(ctx, {
        type: 'agent-tool-result',
        agent,
        toolUseId: tr.toolUseId,
        text: tr.text,
        isError: tr.isError,
        ts,
      });
      this.emitEvent(ctx, {
        kind: 'agent-tool-result',
        agent,
        toolUseId: tr.toolUseId,
        text: tr.text,
        isError: tr.isError,
        ts,
      });
    }
    if (e.type === 'assistant') {
      const thinking = extractAssistantThinking(e);
      if (thinking) {
        ctx.agentThinkingDeltaCount.set(agent, 0);
        void this.appendLog(ctx, { type: 'agent-thinking', agent, text: thinking, ts });
        this.emitEvent(ctx, { kind: 'agent-thinking', agent, text: thinking, ts });
      }
      const text = extractAssistantText(e);
      if (text) {
        log('info', 'agent.text.assembled', {
          id: ctx.id,
          agent,
          deltas: ctx.agentDeltaCount.get(agent) ?? 0,
          chars: text.length,
        });
        ctx.agentDeltaCount.set(agent, 0);
        // Pull any `<ROOM>…</ROOM>` posts out of the agent's reply
        // BEFORE archiving the reply itself — keeps the agent timeline
        // clean (those tags otherwise read as raw text) and lets the
        // operator see room posts in their dedicated AgentsRoom feed.
        const roomBlocks = extractRoomMessages(text);
        for (const body of roomBlocks) {
          void this.appendLog(ctx, { type: 'room-message', agent, text: body, ts });
          this.emitEvent(ctx, { kind: 'room-message', agent, text: body, ts });
          // Forward to the supervisor's inbox — sup is the moderator;
          // it may issue a verdict, ask the user, or just acknowledge.
          // Single-recipient delivery dodges the multi-cast headache.
          ctx.orchestrator.messages.enqueue({
            to: 'supervisor',
            source: 'developer',
            body: `ROOM_MESSAGE [${agent}]: ${body}`,
          });
        }
        const cleanText = stripRoomBlocks(text).trim();
        if (cleanText) {
          void this.appendLog(ctx, { type: 'agent-text', agent, text: cleanText, ts });
          this.emitEvent(ctx, { kind: 'agent-text', agent, text: cleanText, ts });
        }
      }
    }
  }

  /**
   * Apply summon/dismiss decisions parsed from the supervisor's text.
   * Updates `ctx.activeAgents` and emits lifecycle events so the UI can
   * add/remove agent tabs in real time.
   */
  private applyAgentLifecycle(
    ctx: SessionContext,
    summoned: string[],
    dismissed: string[],
  ): void {
    const ts = Date.now();
    for (const agent of summoned) {
      if (ctx.activeAgents.has(agent)) continue;
      // Only summon known agents. Unknown names land in chat-log as a
      // warn-level orchestrator log but do NOT mutate the active set —
      // saves us from a sup typo populating ghost tabs.
      const known = ['developer', 'ui-dev', 'security'];
      if (!known.includes(agent)) {
        log('warn', 'session.summon_unknown_agent', { id: ctx.id, agent });
        continue;
      }
      ctx.activeAgents.add(agent);
      void this.appendLog(ctx, { type: 'agent-summoned', agent, ts });
      this.emitEvent(ctx, { kind: 'agent-summoned', agent, ts });
    }
    for (const agent of dismissed) {
      if (!ctx.activeAgents.has(agent)) continue;
      // Refuse to dismiss the default developer — that would leave the
      // session with no implementation agent, which is never what the
      // supervisor wants. We log and ignore.
      if (agent === 'developer') {
        log('warn', 'session.refuse_dismiss_developer', { id: ctx.id });
        continue;
      }
      ctx.activeAgents.delete(agent);
      void this.appendLog(ctx, { type: 'agent-dismissed', agent, ts });
      this.emitEvent(ctx, { kind: 'agent-dismissed', agent, ts });
    }
  }

  private onSupervisorStreamEvent(ctx: SessionContext, e: StreamEvent): void {
    const ts = Date.now();
    const delta = extractStreamTextDelta(e);
    if (delta) {
      ctx.supDeltaCount += 1;
      this.emitEvent(ctx, { kind: 'sup-message-delta', delta, ts });
      return;
    }
    const thinkingDelta = extractStreamThinkingDelta(e);
    if (thinkingDelta) {
      ctx.supThinkingDeltaCount += 1;
      this.emitEvent(ctx, { kind: 'sup-thinking-delta', delta: thinkingDelta, ts });
      return;
    }
    const metrics = extractResultMetrics(e);
    if (metrics) {
      this.applyMetrics(ctx, 'supervisor', metrics, ts);
      return;
    }
    // Surface sup tool calls into the chat-log + SSE stream. Sup is allowed
    // to call read-only/orchestration tools (Read, Bash for smoke tests,
    // ask_user, write_phase_doc, ScheduleWakeup) and the operator should
    // be able to see them just like dev's tool activity.
    for (const tu of extractToolUses(e)) {
      const id = randomUUID();
      void this.appendLog(ctx, {
        type: 'sup-tool-call',
        id,
        toolUseId: tu.id,
        name: tu.name,
        input: tu.input,
        ts,
      });
      this.emitEvent(ctx, {
        kind: 'sup-tool-call',
        id,
        toolUseId: tu.id,
        name: tu.name,
        input: tu.input,
        ts,
      });
      void this.recordMetric(ctx, {
        kind: 'tool-call',
        sessionId: ctx.id,
        agent: 'supervisor',
        tool: tu.name,
        filePath: this.extractToolFilePath(tu.input),
        ts,
      });
      if (tu.name === 'ScheduleWakeup') {
        this.scheduleAgentWakeup(ctx, 'supervisor', tu.input);
      }
    }
    for (const tr of extractToolResults(e)) {
      void this.appendLog(ctx, {
        type: 'sup-tool-result',
        toolUseId: tr.toolUseId,
        text: tr.text,
        isError: tr.isError,
        ts,
      });
      this.emitEvent(ctx, {
        kind: 'sup-tool-result',
        toolUseId: tr.toolUseId,
        text: tr.text,
        isError: tr.isError,
        ts,
      });
    }
    if (e.type !== 'assistant') return;
    // Pull thinking out of the assembled assistant message so the chat-log
    // gets a final (non-streaming) record, even if the operator missed
    // the live deltas. Persist before the regular text so replays show
    // thinking → message in chronological order.
    const thinking = extractAssistantThinking(e);
    if (thinking) {
      ctx.supThinkingDeltaCount = 0;
      void this.appendLog(ctx, { type: 'sup-thinking', text: thinking, ts });
      this.emitEvent(ctx, { kind: 'sup-thinking', text: thinking, ts });
    }
    const text = extractAssistantText(e);
    if (!text) return;
    log('info', 'sup.message.assembled', {
      id: ctx.id,
      deltas: ctx.supDeltaCount,
      chars: text.length,
    });
    ctx.supDeltaCount = 0;
    void this.appendLog(ctx, { type: 'sup-message', text, ts });
    this.emitEvent(ctx, { kind: 'sup-message', text, ts });
    const { tasks, summonedAgents, dismissedAgents, verdicts } = extractDeveloperTasks(text);
    // Apply lifecycle decisions BEFORE task markers so the agent tabs
    // are visible by the time their first task lands.
    this.applyAgentLifecycle(ctx, summonedAgents, dismissedAgents);
    // Broadcast verdicts to every active specialist + persist them so
    // the operator sees a Yargısal Karar feed in the chatroom view.
    if (verdicts.length > 0) this.applyVerdicts(ctx, verdicts);
    for (const task of tasks) {
      // Auto-summon the target agent if the supervisor delegated to one
      // without an explicit <SUMMON/> tag. Keeps the UI tab set in sync
      // with what's actually running.
      if (!ctx.activeAgents.has(task.agent)) {
        this.applyAgentLifecycle(ctx, [task.agent], []);
      }
      const summary = (task.body.split('\n')[0] ?? '').slice(0, 120);
      if (!summary) continue;
      // Prefix the agent (`ui-dev → ` etc.) when it's not the default
      // developer; the timeline render then reads "sup → ui-dev" instead
      // of an ambiguous "sup → dev".
      const labelled =
        task.agent === 'developer' ? summary : `[${task.agent}] ${summary}`;
      void this.appendLog(ctx, { type: 'task-marker', summary: labelled, ts });
      this.emitEvent(ctx, { kind: 'task-marker', summary: labelled, ts });
    }
  }

  private onDeveloperStreamEvent(ctx: SessionContext, e: StreamEvent): void {
    const ts = Date.now();
    const delta = extractStreamTextDelta(e);
    if (delta) {
      ctx.devDeltaCount += 1;
      this.emitEvent(ctx, { kind: 'dev-text-delta', delta, ts });
      return;
    }
    const thinkingDelta = extractStreamThinkingDelta(e);
    if (thinkingDelta) {
      ctx.devThinkingDeltaCount += 1;
      this.emitEvent(ctx, { kind: 'dev-thinking-delta', delta: thinkingDelta, ts });
      return;
    }
    const metrics = extractResultMetrics(e);
    if (metrics) {
      this.applyMetrics(ctx, 'developer', metrics, ts);
      return;
    }
    for (const tu of extractToolUses(e)) {
      const id = randomUUID();
      void this.appendLog(ctx, {
        type: 'dev-tool-call',
        id,
        toolUseId: tu.id,
        name: tu.name,
        input: tu.input,
        ts,
      });
      this.emitEvent(ctx, {
        kind: 'dev-tool-call',
        id,
        toolUseId: tu.id,
        name: tu.name,
        input: tu.input,
        ts,
      });
      void this.recordMetric(ctx, {
        kind: 'tool-call',
        sessionId: ctx.id,
        agent: 'developer',
        tool: tu.name,
        filePath: this.extractToolFilePath(tu.input),
        ts,
      });
      if (tu.name === 'ScheduleWakeup') {
        this.scheduleAgentWakeup(ctx, 'developer', tu.input);
      }
    }
    for (const tr of extractToolResults(e)) {
      void this.appendLog(ctx, {
        type: 'dev-tool-result',
        toolUseId: tr.toolUseId,
        text: tr.text,
        isError: tr.isError,
        ts,
      });
      this.emitEvent(ctx, {
        kind: 'dev-tool-result',
        toolUseId: tr.toolUseId,
        text: tr.text,
        isError: tr.isError,
        ts,
      });
    }
    if (e.type === 'assistant') {
      const thinking = extractAssistantThinking(e);
      if (thinking) {
        ctx.devThinkingDeltaCount = 0;
        void this.appendLog(ctx, { type: 'dev-thinking', text: thinking, ts });
        this.emitEvent(ctx, { kind: 'dev-thinking', text: thinking, ts });
      }
      const text = extractAssistantText(e);
      if (text) {
        log('info', 'dev.text.assembled', {
          id: ctx.id,
          deltas: ctx.devDeltaCount,
          chars: text.length,
        });
        ctx.devDeltaCount = 0;
        void this.appendLog(ctx, { type: 'dev-text', text, ts });
        this.emitEvent(ctx, { kind: 'dev-text', text, ts });
      }
    }
  }

  /**
   * Fold a per-turn `result` metrics block into the session's cumulative
   * counters and broadcast the new totals over SSE so the bottom-toolbar
   * UI can render them live. Cost is summed (Anthropic returns the
   * cumulative for that subprocess invocation), durations are summed, and
   * the most-recent turn duration is kept separately so the UI can show
   * "last turn: 4.2s" without averaging.
   */
  /**
   * Fold a per-turn `result` metrics block into the target bucket.
   * `role` is the agent identity:
   *   • `supervisor` → ctx.supMetrics
   *   • `developer`  → ctx.devMetrics
   *   • anything else (`ui-dev`, `security`, custom) → ctx.agentMetrics map
   *
   * Specialists used to fold into the developer bucket as a TODO; with
   * per-agent buckets each specialist now gets its own cost / turn /
   * duration line in the bottom toolbar.
   */
  private applyMetrics(
    ctx: SessionContext,
    role: string,
    metrics: { costUsd: number; durationMs: number; numTurns: number },
    ts: number,
  ): void {
    const target =
      role === 'supervisor'
        ? ctx.supMetrics
        : role === 'developer'
          ? ctx.devMetrics
          : ((): RoleMetrics => {
              const existing = ctx.agentMetrics.get(role);
              if (existing) return existing;
              const fresh = emptyMetrics();
              ctx.agentMetrics.set(role, fresh);
              return fresh;
            })();
    target.totalCostUsd += metrics.costUsd;
    target.totalTurns += metrics.numTurns;
    target.lastTurnMs = metrics.durationMs;
    target.totalDurationMs += metrics.durationMs;
    target.lastResultAt = ts;
    log('info', 'session.role_metrics', {
      id: ctx.id,
      role,
      cost: target.totalCostUsd.toFixed(4),
      turns: target.totalTurns,
      lastMs: target.lastTurnMs,
    });
    this.emitEvent(ctx, { kind: 'role-metrics', role, metrics: { ...target }, ts });
    // Persist after every update so a daemon crash mid-session doesn't
    // lose accumulated counters.
    void writeMetrics(ctx.cwd, {
      version: 1,
      updatedAt: new Date().toISOString(),
      sup: { ...ctx.supMetrics },
      dev: { ...ctx.devMetrics },
      agents: Object.fromEntries(
        Array.from(ctx.agentMetrics.entries()).map(([k, v]) => [k, { ...v }]),
      ),
    }).catch((e) => {
      log('warn', 'session.metrics_write_failed', {
        id: ctx.id,
        error: (e as Error).message,
      });
    });
    // Phase 2 telemetry — emit a `turn` event per CC result. Specialists
    // (ui-dev, security, …) are bucketed with `dev` for the v1 rollup;
    // the frontend can split via `toolCallsByAgent` if it wants finer
    // granularity. Fire-and-forget; persistence isn't load-bearing.
    void this.recordMetric(ctx, {
      kind: 'turn',
      sessionId: ctx.id,
      who: role === 'supervisor' ? 'sup' : 'dev',
      turnIndex: target.totalTurns,
      ts,
    });
    // Phase 5 (Trust v1) — auto-commit to the session branch when
    // git-isolation is active. Fire-and-forget: a commit failure is
    // logged but never breaks the session. The commit only happens
    // when there are actual file changes — `commitTurn` no-ops on
    // a clean tree (most "result" events from sup that didn't touch
    // disk).
    if (ctx.gitIsolation?.enabled) {
      void this.autoCommitTurn(ctx, role, target.totalTurns, ts);
    }
  }

  /**
   * Phase 5 — auto-commit hook fired after every CC result event when
   * isolation is active. Errors swallowed + logged: a flaky commit
   * shouldn't surface as a fake session failure to the operator.
   *
   * The commit message includes role + turn index + file count so a
   * `git log` on the session branch reads as a clear timeline of
   * who-did-what.
   */
  private async autoCommitTurn(
    ctx: SessionContext,
    role: string,
    turnIndex: number,
    ts: number,
  ): Promise<void> {
    try {
      const result = await commitTurn(
        ctx.cwd,
        `[selfclaude] ${role} turn ${turnIndex}`,
      );
      if (result.committed) {
        log('info', 'git-isolation.commit', {
          id: ctx.id,
          role,
          turn: turnIndex,
          sha: result.sha,
          files: result.filesChanged,
        });
        await bumpLastCommitAt(ctx.cwd, ts);
        if (ctx.gitIsolation) ctx.gitIsolation.lastCommitAt = ts;
      }
    } catch (e) {
      log('warn', 'git-isolation.commit_failed', {
        id: ctx.id,
        role,
        turn: turnIndex,
        error: (e as Error).message,
      });
    }
  }

  /**
   * Phase 5 — rehydrate git isolation state on session boot. Reads
   * `<cwd>/.selfclaude/git-isolation.json`, populates ctx.gitIsolation.
   * If the file is missing the session simply has no isolation; that
   * is the default shape and explicitly fine.
   *
   * We deliberately do NOT verify against the live git state here —
   * the persisted record might claim isolation is enabled while the
   * branch was deleted out-of-band. The frontend's polling loop reads
   * branch-status separately and surfaces drift to the operator.
   */
  private async restoreGitIsolation(ctx: SessionContext): Promise<void> {
    try {
      const file = await readGitIsolation(ctx.cwd);
      if (!file) return;
      ctx.gitIsolation = {
        enabled: file.enabled,
        branch: file.branch,
        originalBranch: file.originalBranch,
        startedAt: file.startedAt,
        lastCommitAt: file.lastCommitAt,
      };
      log('info', 'git-isolation.restored', {
        id: ctx.id,
        branch: file.branch,
        originalBranch: file.originalBranch,
      });
    } catch (e) {
      log('warn', 'git-isolation.restore_failed', {
        id: ctx.id,
        error: (e as Error).message,
      });
    }
  }

  /**
   * Append a Phase 2 telemetry event to `<cwd>/.selfclaude/session-metrics.jsonl`.
   * Errors are logged but never propagated — telemetry is best-effort
   * and must not break the user-facing flow.
   */
  private async recordMetric(
    ctx: SessionContext,
    event: SessionMetricsEvent,
  ): Promise<void> {
    try {
      await appendSessionMetricsEvent(ctx.cwd, event);
    } catch (e) {
      log('warn', 'session.metric_append_failed', {
        id: ctx.id,
        kind: event.kind,
        error: (e as Error).message,
      });
    }
  }

  /**
   * Phase 7 — surface a caught error to the operator AND record the
   * failure in the metrics store with a classified `FailureCode`.
   *
   * Replaces the bare `emitEvent({kind: 'turn-error', message})` pattern
   * scattered throughout the catch blocks: every error path now lands
   * in the failure rollup, so the bottom-toolbar badge + project
   * rollup show an honest count instead of an underestimate (per
   * ROADMAP calibration #7: "publicly visible").
   *
   * Truncation: caller messages can be giant (CC stack traces, JSON
   * blobs); 1KB is enough for triage, more would inflate the JSONL.
   */
  private surfaceFailure(
    ctx: SessionContext,
    role: string | null,
    rawMessage: string,
  ): void {
    const code = classifyFailure(rawMessage);
    const message = rawMessage.length > 1024 ? `${rawMessage.slice(0, 1024)}…` : rawMessage;
    this.emitEvent(ctx, { kind: 'turn-error', message: rawMessage, code, role });
    void this.recordMetric(ctx, {
      kind: 'failure',
      sessionId: ctx.id,
      code,
      role,
      message,
      ts: Date.now(),
    });
  }

  /**
   * Heuristic: pull a file path out of a tool input record. Different
   * Claude Code tools name the field differently (`file_path`, `path`,
   * `notebook_path`, `filename`); we check the common ones in priority
   * order and return the first non-empty string. Returns `undefined`
   * when the tool didn't carry a path (Bash, ScheduleWakeup, ask_user…).
   */
  private extractToolFilePath(input: Record<string, unknown>): string | undefined {
    const candidates = ['file_path', 'path', 'notebook_path', 'filename'];
    for (const key of candidates) {
      const v = input[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return undefined;
  }

  /**
   * Convert a `ScheduleWakeup` tool call into a real timer. Validates the
   * raw input (silently dropping malformed calls) and registers the timer
   * with the WakeupRunner. The runner's listener (set up in the constructor)
   * persists a chat-log entry and emits an SSE event.
   */
  private scheduleAgentWakeup(
    ctx: SessionContext,
    role: WakeupRole,
    rawInput: Record<string, unknown>,
  ): void {
    const parsed = parseScheduleWakeupInput(rawInput);
    if (!parsed) {
      log('warn', 'wakeup.invalid_input', { id: ctx.id, role });
      return;
    }
    this.wakeups.schedule(ctx.id, role, parsed, async (wakeup) =>
      this.dispatchWakeup(ctx.id, wakeup),
    );
  }

  /**
   * Replay unfired wakeups from the chat-log when a session is (re)opened.
   *
   * Walks the log in order, pairing every `wakeup-scheduled` with the most
   * recent `wakeup-fired`/`wakeup-cancelled` for the same `wakeupId`. If no
   * terminal entry exists, the wakeup is still pending. Past-due wakeups
   * fire immediately on a 1s setTimeout (so the schedule emit happens
   * inside the normal event flow); future-dated ones rejoin the runner
   * with their original delay.
   *
   * Without this, daemon restart silently drops every pending wakeup —
   * agents would think they scheduled a resume that will never come.
   */
  /**
   * Reload the persisted role metrics for this session's cwd. Without
   * this, every daemon restart resets the bottom toolbar's cumulative
   * cost / turn / duration counters to zero — masking how expensive the
   * project has actually been across sessions.
   *
   * Persisted metrics live at `<cwd>/.selfclaude/metrics.json` and are
   * rewritten by `applyMetrics` on every CC `result` event.
   */
  private async restoreMetrics(ctx: SessionContext): Promise<void> {
    const file = await readMetrics(ctx.cwd);
    if (!file) return;
    ctx.supMetrics = { ...file.sup };
    ctx.devMetrics = { ...file.dev };
    ctx.agentMetrics = new Map(
      Object.entries(file.agents ?? {}).map(([k, v]) => [k, { ...v }]),
    );
    log('info', 'session.metrics_restored', {
      id: ctx.id,
      sup: ctx.supMetrics.totalCostUsd.toFixed(4),
      dev: ctx.devMetrics.totalCostUsd.toFixed(4),
      agents: Array.from(ctx.agentMetrics.keys()),
    });
  }

  /**
   * Replay `agent-summoned` / `agent-dismissed` events from the chat-log
   * to rebuild `ctx.activeAgents` after a daemon restart. Without this,
   * a project that had ui-dev / security summoned in a previous run
   * would lose those tabs on reboot until the supervisor re-summons.
   *
   * The replay is plain set-add / set-delete in chat-log order; whatever
   * the last decision was wins.
   */
  /**
   * Apply numbered "Yargısal Karar" verdicts the supervisor declared in
   * its chat. Each verdict is persisted to chat-log + emitted to the UI
   * (so the AgentsRoom feed updates) AND broadcast as a system message
   * into every active specialist's inbox so the agents pick it up on
   * their next turn ("decision #N: …").
   *
   * The broadcast preserves the autonomous-by-default contract: sup
   * doesn't need user approval to bind specialists to a decision.
   */
  private applyVerdicts(
    ctx: SessionContext,
    verdicts: { id: number; text: string }[],
  ): void {
    const ts = Date.now();
    for (const verdict of verdicts) {
      void this.appendLog(ctx, {
        type: 'verdict',
        id: verdict.id,
        text: verdict.text,
        ts,
      });
      this.emitEvent(ctx, {
        kind: 'verdict',
        id: verdict.id,
        text: verdict.text,
        ts,
      });
      // Inject the decision into every active specialist's inbox. The
      // default developer is part of activeAgents from session start;
      // specialists are added on summon. Each agent sees the message bus
      // in-context on its next turn.
      const body = `[VERDICT #${verdict.id}] ${verdict.text}`;
      for (const _agent of ctx.activeAgents) {
        // Message bus only knows the legacy 'developer' channel today;
        // every specialist's CC subprocess pulls from it via the same
        // hook, so a single enqueue distributes to whichever subprocess
        // runs next. Keeps the wire shape minimal.
        ctx.orchestrator.messages.enqueue({
          to: 'developer',
          source: 'supervisor',
          body,
        });
      }
    }
  }

  /**
   * Seed `ctx.lastProgressTs` from the chat-log on session boot.
   *
   * Without this, a restart leaves `lastProgressTs = null` while the
   * persisted `supMetrics.totalTurns` is restored to whatever it was
   * before (often ≥ 3 from real work). The next stuck-detector tick
   * then mistakes a freshly-resumed session for a "no-progress-yet"
   * stuck case and fires the banner immediately, even though the
   * operator hasn't done anything new yet.
   *
   * Scan latest-first and stop at the first progress marker found.
   * If the log has none (brand-new project, no real work yet), leave
   * `lastProgressTs` null — the detector still suppresses on
   * `too-few-turns` until the operator actually drives the session
   * past the threshold.
   */
  private async restoreLastProgress(ctx: SessionContext): Promise<void> {
    let entries: ChatLogEntry[];
    try {
      entries = await readChatLog(ctx.cwd);
    } catch {
      return;
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      const toolName = (e as { name?: string }).name;
      if (isProgressMarker(e.type, toolName)) {
        ctx.lastProgressTs = e.ts;
        log('info', 'session.last_progress_restored', {
          id: ctx.id,
          ts: e.ts,
          type: e.type,
        });
        return;
      }
    }
  }

  private async restoreActiveAgents(ctx: SessionContext): Promise<void> {
    let entries: ChatLogEntry[];
    try {
      entries = await readChatLog(ctx.cwd);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.type === 'agent-summoned') {
        ctx.activeAgents.add(e.agent);
      } else if (e.type === 'agent-dismissed') {
        if (e.agent !== 'developer') ctx.activeAgents.delete(e.agent);
      }
    }
    log('info', 'session.active_agents_restored', {
      id: ctx.id,
      agents: Array.from(ctx.activeAgents),
    });
  }

  private async restoreWakeups(ctx: SessionContext): Promise<void> {
    let entries: ChatLogEntry[];
    try {
      entries = await readChatLog(ctx.cwd);
    } catch (e) {
      log('warn', 'wakeup.restore_read_failed', {
        id: ctx.id,
        error: (e as Error).message,
      });
      return;
    }

    interface PendingWakeup {
      role: WakeupRole;
      fireAt: number;
      prompt: string;
      reason: string;
    }
    const pending = new Map<string, PendingWakeup>();
    /**
     * Legacy ScheduleWakeup tool calls recorded before the runner existed.
     * We track each one by its CC tool_use_id so we can:
     *   1. Skip ones already converted to a real `wakeup-scheduled` in a
     *      prior boot (recorded as `wakeup-legacy-consumed`).
     *   2. Mark the latest unmigrated one for migration THIS boot.
     *
     * Without (1), every `selfclaude restart` would re-fire the same stale
     * wakeup forever — exactly the bug the operator just hit.
     */
    interface LegacyWakeup extends PendingWakeup {
      legacyToolUseId: string;
    }
    const legacyDev: LegacyWakeup[] = [];
    const consumedLegacyIds = new Set<string>();

    for (const entry of entries) {
      if (entry.type === 'wakeup-scheduled') {
        pending.set(entry.wakeupId, {
          role: entry.role,
          fireAt: entry.fireAt,
          prompt: entry.prompt,
          reason: entry.reason,
        });
      } else if (entry.type === 'wakeup-fired' || entry.type === 'wakeup-cancelled') {
        pending.delete(entry.wakeupId);
      } else if (entry.type === 'wakeup-legacy-consumed') {
        consumedLegacyIds.add(entry.legacyToolUseId);
      } else if (entry.type === 'dev-tool-call' && entry.name === 'ScheduleWakeup') {
        const inp = entry.input as {
          delaySeconds?: unknown;
          prompt?: unknown;
          reason?: unknown;
        };
        const delay = Number(inp.delaySeconds);
        const prompt = typeof inp.prompt === 'string' ? inp.prompt : '';
        if (!Number.isFinite(delay) || delay <= 0 || !prompt) continue;
        legacyDev.push({
          role: 'developer',
          fireAt: entry.ts + delay * 1000,
          prompt,
          reason: typeof inp.reason === 'string' ? inp.reason : '',
          legacyToolUseId: entry.toolUseId,
        });
      }
    }

    // Stale legacy ScheduleWakeup tool calls accumulate over time — every
    // time the dev calls `ScheduleWakeup`, the orchestrator (now) emits a
    // proper `wakeup-scheduled`, but BEFORE the runner existed those just
    // sat in the chat-log as `dev-tool-call` entries.
    //
    // First migration boot: pick the latest of those stale entries to
    // fire, then write `wakeup-legacy-consumed` markers for **every**
    // legacy entry we saw — not just the one we're firing. Otherwise
    // each subsequent restart picks the NEXT-latest, and we re-fire the
    // entire stale history one wakeup per restart. (That was the bug
    // the operator hit twice in a row.)
    const unconsumed = legacyDev.filter((w) => !consumedLegacyIds.has(w.legacyToolUseId));
    if (unconsumed.length > 0) {
      const latest = unconsumed[unconsumed.length - 1]!;
      pending.set(`legacy-${latest.legacyToolUseId}`, latest);
      const now = Date.now();
      // Mark every observed legacy entry consumed so future boots skip
      // the lot. The earlier ones are stale by definition (a newer
      // ScheduleWakeup superseded them at the time).
      for (const w of legacyDev) {
        if (consumedLegacyIds.has(w.legacyToolUseId)) continue;
        void this.appendLog(ctx, {
          type: 'wakeup-legacy-consumed',
          legacyToolUseId: w.legacyToolUseId,
          wakeupId:
            w.legacyToolUseId === latest.legacyToolUseId
              ? `legacy-mig-${w.legacyToolUseId}`
              : `legacy-stale-${w.legacyToolUseId}`,
          ts: now,
        });
      }
    }

    if (pending.size === 0) return;

    const now = Date.now();
    for (const [, w] of pending) {
      // Cap restored delay at 1s minimum so past-due wakeups fire promptly
      // (without bypassing the normal scheduled→fired event sequence).
      const remainingSec = Math.max(1, Math.ceil((w.fireAt - now) / 1000));
      this.wakeups.schedule(
        ctx.id,
        w.role,
        { delaySeconds: remainingSec, prompt: w.prompt, reason: w.reason },
        async (fired) => this.dispatchWakeup(ctx.id, fired),
      );
    }
    log('info', 'wakeup.restored', { id: ctx.id, count: pending.size });
  }

  /**
   * Run a wakeup once its timer fires: wait for any in-flight turn to
   * finish, then re-prompt the appropriate agent with the synthetic prompt
   * the agent itself supplied at schedule time.
   *
   * For sup we go through `runConversationTurn` (so dev follow-up still
   * works); for dev we use the dev-only message path (`messageDeveloper`'s
   * underlying turn). User input never collides because both sup-side
   * and dev-side entry points cancel pending wakeups before scheduling
   * their own work.
   */
  private async dispatchWakeup(sessionId: string, wakeup: ScheduledWakeup): Promise<void> {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return;
    // Defer until any in-progress turn has settled. We use a cap so a stuck
    // turn doesn't pin the wakeup forever.
    if (ctx.busy) {
      try {
        await Promise.race([ctx.busy, new Promise((r) => setTimeout(r, 60_000))]);
      } catch {
        // ignore — busy promise rejected, but we still want to attempt fire
      }
    }
    if (ctx.busy) {
      log('warn', 'wakeup.skipped_session_busy', {
        id: sessionId,
        role: wakeup.role,
        wakeupId: wakeup.id,
      });
      return;
    }
    if (wakeup.role === 'supervisor') {
      await this.fireSupervisorWakeup(ctx, wakeup);
    } else {
      await this.fireDeveloperWakeup(ctx, wakeup);
    }
  }

  /**
   * Run a supervisor wakeup turn. Mirrors `sendMessage` but logs nothing as
   * a user message — the originating event is `wakeup-fired`, already
   * emitted by the runner's listener.
   */
  private async fireSupervisorWakeup(
    ctx: SessionContext,
    wakeup: ScheduledWakeup,
  ): Promise<void> {
    this.emitEvent(ctx, { kind: 'turn-busy', busy: true });
    const controller = new AbortController();
    ctx.currentAbort = { role: 'supervisor', controller };
    const run = (async () => {
      try {
        const result = await runConversationTurn({
          orchestrator: ctx.orchestrator,
          userPrompt: wakeup.prompt,
          supervisorSessionId: ctx.supervisorSessionId ?? undefined,
          developerSessionId: ctx.developerSessionId ?? undefined,
          onSupervisorEvent: (e) => this.onSupervisorStreamEvent(ctx, e),
          onAgentEvent: (agent, e) => this.onAgentStreamEvent(ctx, agent, e),
          signal: controller.signal,
        });
        ctx.supervisorSessionId = result.supervisorSessionId ?? ctx.supervisorSessionId;
        ctx.developerSessionId = result.developerSessionId ?? ctx.developerSessionId;
      } catch (e) {
        this.surfaceFailure(ctx, 'supervisor', (e as Error).message);
      } finally {
        ctx.currentAbort = null;
        ctx.busy = null;
        this.emitEvent(ctx, { kind: 'turn-busy', busy: false });
      }
    })();
    ctx.busy = run;
    await run;
  }

  /**
   * Run a developer wakeup turn. Mirrors `messageDeveloper` minus the
   * user-message log entries — the wakeup itself is the audit record.
   */
  private async fireDeveloperWakeup(
    ctx: SessionContext,
    wakeup: ScheduledWakeup,
  ): Promise<void> {
    const orch = ctx.orchestrator;
    orch.messages.enqueue({
      to: 'developer',
      source: 'user',
      body: `WAKEUP_RESUME:\n${wakeup.prompt}`,
    });
    orch.messages.enqueue({
      to: 'supervisor',
      source: 'user',
      body:
        `WAKEUP (informational): developer's scheduled wakeup fired. ` +
        `Original reason: ${wakeup.reason || '(none)'}.`,
    });

    this.emitEvent(ctx, { kind: 'turn-busy', busy: true });
    const controller = new AbortController();
    ctx.currentAbort = { role: 'developer', controller };
    const run = (async () => {
      try {
        const ws = orch.getWorkspace();
        orch.dispatch({ kind: 'dev-turn-start' });
        const devResult = await runClaudeTurn(
          {
            role: 'developer',
            cwd: ws.cwd,
            prompt:
              'Your previously scheduled WAKEUP_RESUME prompt has been injected into your context. ' +
              'Resume the work it describes. The supervisor has been notified that you woke up.',
            resumeSessionId: ctx.developerSessionId ?? undefined,
            settingsPath: ws.settingsPath,
            systemPromptAppend: loadDeveloperSystemPrompt(),
            permissionMode: 'acceptEdits',
            envOverrides: orch.hookEnv('developer', 'developer'),
            enableChrome: false,
            signal: controller.signal,
          },
          (e) => this.onDeveloperStreamEvent(ctx, e),
        );
        ctx.developerSessionId = devResult.sessionId ?? ctx.developerSessionId;
        orch.dispatch({ kind: 'dev-turn-end' });

        const devText = devResult.events
          .filter((e) => e.type === 'assistant')
          .map((e) => extractAssistantText(e))
          .join('\n');
        if (devText) {
          orch.messages.enqueue({
            to: 'supervisor',
            source: 'developer',
            body: `WAKEUP_REPORT (informational): developer post-wakeup output: ${devText.slice(0, 1200)}`,
          });
          ctx.currentAbort = { role: 'supervisor', controller };
          await this.followUpSupervisor(ctx, SUP_FOLLOWUP_AFTER_WAKEUP, controller.signal);
        }
      } catch (e) {
        this.surfaceFailure(ctx, 'developer', (e as Error).message);
      } finally {
        ctx.currentAbort = null;
        ctx.busy = null;
        this.emitEvent(ctx, { kind: 'turn-busy', busy: false });
      }
    })();
    ctx.busy = run;
    await run;
  }

  /**
   * After a dev-only turn (direct user message or wakeup), run a single
   * supervisor turn so it can read the dev report from its inbox. This is
   * the dual of the supervisor sup-uyuyor fix: there the sup sleeps after
   * dev finishes its delegated task; here the sup sleeps because dev was
   * not invoked through the normal sup→dev→sup loop at all.
   *
   * We reuse `runConversationTurn` so that if the sup decides to delegate
   * follow-up work, the loop can naturally continue dev→sup again. Note:
   * `ctx.busy` is already held by the caller — we don't re-set it here.
   */
  private async followUpSupervisor(
    ctx: SessionContext,
    syntheticPrompt: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const result = await runConversationTurn({
        orchestrator: ctx.orchestrator,
        userPrompt: syntheticPrompt,
        supervisorSessionId: ctx.supervisorSessionId ?? undefined,
        developerSessionId: ctx.developerSessionId ?? undefined,
        onSupervisorEvent: (e) => this.onSupervisorStreamEvent(ctx, e),
        onAgentEvent: (agent, e) => this.onAgentStreamEvent(ctx, agent, e),
        signal,
      });
      ctx.supervisorSessionId = result.supervisorSessionId ?? ctx.supervisorSessionId;
      ctx.developerSessionId = result.developerSessionId ?? ctx.developerSessionId;
    } catch (e) {
      this.surfaceFailure(ctx, 'supervisor', (e as Error).message);
    }
  }
}

/** Synthetic prompt used to wake the supervisor after a direct dev message. */
const SUP_FOLLOWUP_AFTER_DEV_DIRECT =
  'A USER_DEV_DIALOG entry has been added to your inbox: the user spoke directly to the ' +
  'developer and the developer replied. Read both messages, decide whether any action is ' +
  'needed (continue the plan, ask the user, mark the phase complete), and respond accordingly.';

/** Synthetic prompt used to wake the supervisor after a developer wakeup fired. */
const SUP_FOLLOWUP_AFTER_WAKEUP =
  'A WAKEUP_REPORT entry has been added to your inbox: the developer\'s scheduled wakeup ' +
  'fired and it produced new output. Review the report and decide the next step (delegate ' +
  'further work via <TASK_FOR_DEVELOPER>, ask the user via ask_user, or mark the phase ' +
  'complete with <<PHASE_COMPLETE>>).';

/**
 * Synthetic prompt fired after the operator approves or rejects a
 * proposed script. Drains the SCRIPT_APPROVED / SCRIPT_REJECTED inbox
 * entry into sup's context and asks for a brief acknowledgement so
 * the operator gets visible confirmation that sup processed it.
 */
const SUP_FOLLOWUP_AFTER_SCRIPT_REVIEW =
  'A SCRIPT_APPROVED or SCRIPT_REJECTED entry has been added to your inbox: the operator ' +
  'reviewed your script proposal. Acknowledge briefly (one short sentence — do not call any ' +
  'tools, do not delegate). For approvals: confirm you can now invoke ' +
  '`Bash ./.selfclaude/scripts/<slug>.sh`. For rejections: read the reason carefully and ' +
  'either propose a corrected variant (different slug or revised body) or note that you will ' +
  'find another approach. Then end your turn — let the operator drive what comes next.';

/**
 * `<ROOM>…</ROOM>` matcher used by `onAgentStreamEvent` to peel free-chat
 * posts out of a specialist's assistant reply. Non-greedy so multiple
 * room posts in one turn are extracted independently; case-sensitive.
 */
const ROOM_RE = /<ROOM>([\s\S]*?)<\/ROOM>/g;

function extractRoomMessages(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ROOM_RE)) {
    const body = m[1]?.trim();
    if (body) out.push(body);
  }
  return out;
}

function stripRoomBlocks(text: string): string {
  return text.replace(ROOM_RE, '').replace(/\n{3,}/g, '\n\n');
}

/* ───────────────── Phase doc tree parser ───────────────── */

/**
 * One node in the phase-doc outline. Two flavours:
 *
 *   - `kind: 'section'` — a markdown heading (`##`, `###`, `####`).
 *     Carries `level` so the renderer can indent and a `children`
 *     array holding everything that lives "under" that heading until
 *     a sibling-or-shallower heading appears.
 *
 *   - `kind: 'checkbox'` — a markdown checkbox (`- [ ]` / `- [x]`).
 *     Carries `done`. Always a leaf — nested children are not
 *     supported (an indented checkbox under another checkbox is
 *     uncommon in phase docs and the noise isn't worth modelling).
 *
 * Plain bullets and prose are intentionally dropped so the tree stays
 * an actionable outline, not a re-render of the whole document.
 */
export interface PhaseNode {
  kind: 'section' | 'checkbox';
  text: string;
  /** For sections: heading depth (2 = `##`, 3 = `###`, …). */
  level?: number;
  /** For checkboxes only. */
  done?: boolean;
  /** Source line in the markdown (0-indexed) for traceability. */
  line: number;
  children: PhaseNode[];
}

/**
 * Build a phase-doc outline from raw markdown lines. Walks once,
 * stack-style: each new heading either nests under the current open
 * one (deeper level) or pops back up to its sibling/parent (same or
 * shallower level). Checkboxes attach to the deepest open section.
 */
function parsePhaseTree(lines: string[]): PhaseNode[] {
  // Match `## title`, `### title`, … but NOT `# title` (that's the doc H1
  // which we already use for the phase title, no need to repeat it inside).
  const headingRe = /^(#{2,6})\s+(.+?)\s*$/;
  const checkboxRe = /^\s{0,6}[-*]\s+\[([ xX])\]\s+(.+?)\s*$/;
  const root: PhaseNode[] = [];
  // Stack of currently-open section nodes, deepest last. Headings pop
  // until the top has a strictly-shallower level, then push the new one.
  const stack: PhaseNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const headingMatch = line.match(headingRe);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const text = headingMatch[2]!.trim();
      while (stack.length > 0 && stack[stack.length - 1]!.level! >= level) {
        stack.pop();
      }
      const node: PhaseNode = {
        kind: 'section',
        text,
        level,
        line: i,
        children: [],
      };
      if (stack.length === 0) root.push(node);
      else stack[stack.length - 1]!.children.push(node);
      stack.push(node);
      continue;
    }
    const cbMatch = line.match(checkboxRe);
    if (cbMatch) {
      const node: PhaseNode = {
        kind: 'checkbox',
        text: cbMatch[2]!,
        done: cbMatch[1]!.toLowerCase() === 'x',
        line: i,
        children: [],
      };
      if (stack.length === 0) root.push(node);
      else stack[stack.length - 1]!.children.push(node);
    }
  }
  return root;
}

function countCheckboxes(nodes: PhaseNode[]): { total: number; completed: number } {
  let total = 0;
  let completed = 0;
  const walk = (ns: PhaseNode[]) => {
    for (const n of ns) {
      if (n.kind === 'checkbox') {
        total += 1;
        if (n.done) completed += 1;
      }
      if (n.children.length > 0) walk(n.children);
    }
  };
  walk(nodes);
  return { total, completed };
}
