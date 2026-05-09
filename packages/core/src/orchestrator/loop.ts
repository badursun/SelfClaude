import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaudeTurn } from '../claude-code/spawn.js';
import { extractAssistantText, type StreamEvent } from './stream-parser.js';
import { extractDeveloperTasks, type DelegatedTask } from './tag-parser.js';
import { extractSignals, type SignalKind } from './signals.js';
import { getAgent, loadAgentPrompt, type AgentConfig } from '../agents/registry.js';
import type { Phase } from './state-machine.js';
import type { Orchestrator } from './index.js';
import { log } from '../lib/log.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUP_PROMPT_PATH = resolve(HERE, '..', 'claude-code', 'system-prompts', 'supervisor.md');
const DEV_PROMPT_PATH = resolve(HERE, '..', 'claude-code', 'system-prompts', 'developer.md');
let cachedSupervisorPrompt: string | null = null;
let cachedDeveloperPrompt: string | null = null;

/**
 * Load and cache the developer's appended system prompt. The developer
 * inherits CC's default system prompt (toolset, conventions); this append
 * adds SelfClaude-specific rules — Bash safety, reporting expectations,
 * orchestrator-managed wakeups.
 */
export function loadDeveloperSystemPrompt(): string {
  if (cachedDeveloperPrompt === null) {
    cachedDeveloperPrompt = readFileSync(DEV_PROMPT_PATH, 'utf8');
  }
  return cachedDeveloperPrompt;
}

export function loadSupervisorSystemPrompt(): string {
  if (cachedSupervisorPrompt) return cachedSupervisorPrompt;
  cachedSupervisorPrompt = readFileSync(SUP_PROMPT_PATH, 'utf8');
  return cachedSupervisorPrompt;
}

const SIGNAL_TO_PHASE: Partial<Record<SignalKind, Phase>> = {
  'discovery-complete': 'docs',
  'ready-to-execute': 'phase-loop',
};

export interface LoopRunOptions {
  orchestrator: Orchestrator;
  userPrompt: string;
  supervisorSessionId?: string;
  /**
   * Per-agent CC session ids carried across turns so each specialist
   * agent's conversation persists. Keyed by agent name (`developer`,
   * `ui-dev`, `security`, …). Default `developer` slot still ships when
   * absent — callers using the legacy `developerSessionId` field keep
   * working unchanged.
   */
  agentSessions?: Record<string, string | null>;
  /** Backward-compat alias: when set, populates `agentSessions.developer`. */
  developerSessionId?: string;
  supervisorSystemPrompt?: string;
  /** Backward-compat alias: when set, used as the `developer` agent's prompt. */
  developerSystemPrompt?: string;
  onSupervisorEvent?: (e: StreamEvent) => void;
  /**
   * Backward-compat: receives stream events from the `developer` agent.
   * For non-default agents use `onAgentEvent` instead.
   */
  onDeveloperEvent?: (e: StreamEvent) => void;
  /**
   * Multi-agent stream callback. Fires for every agent's stream events
   * including the default developer (agent === 'developer'). Prefer this
   * over `onDeveloperEvent` for new code.
   */
  onAgentEvent?: (agent: string, e: StreamEvent) => void;
  /**
   * Optional cancellation signal. When aborted, the in-flight Claude Code
   * subprocess receives SIGTERM and the surrounding promise rejects with
   * an AbortError — caller treats this like any other turn failure.
   * Used by the operator emergency-stop button.
   */
  signal?: AbortSignal;
}

export interface AgentTurnSummary {
  agent: string;
  /** CC session id after this turn (null if subprocess never wrote one). */
  sessionId: string | null;
  /** Concatenated assistant text from this agent's turn. */
  text: string;
  /** Number of `<TASK_FOR_DEVELOPER agent="X">` blocks targeted at this agent. */
  tasksReceived: number;
}

export interface LoopTurnResult {
  supervisorSessionId: string | null;
  /** Backward-compat alias for `agentSessions.developer`. */
  developerSessionId: string | null;
  /** Per-agent CC session ids after this turn (incl. agents that didn't run). */
  agentSessions: Record<string, string | null>;
  supervisorText: string;
  supervisorRemainingText: string;
  tasksDelegated: number;
  /** Backward-compat alias: was the `developer` agent invoked this turn? */
  developerExecuted: boolean;
  /** Backward-compat alias: assistant text from the `developer` agent. */
  developerText: string;
  /** True if **any** agent (developer or specialist) ran this turn. */
  anyAgentExecuted: boolean;
  /** Per-agent summary for everyone who actually ran this turn. */
  agents: AgentTurnSummary[];
  /** Phase signals extracted from the supervisor's text this turn. */
  signals: SignalKind[];
  /** Phase the orchestrator is in after this turn (post-signal application). */
  phase: Phase;
}

function collectAssistantText(events: StreamEvent[]): string {
  return events
    .filter((e) => e.type === 'assistant')
    .map(extractAssistantText)
    .filter((t) => t.length > 0)
    .join('\n');
}

/**
 * Run one round of the multi-agent loop:
 *   user → supervisor → (extract `<TASK_FOR_DEVELOPER agent="…">` blocks)
 *        → for each unique target agent in series, run that agent's turn
 *        → enqueue per-agent reports back into the supervisor's inbox.
 *
 * The caller drives iteration externally (`runConversationTurn`). Tasks
 * for unknown agents fall back to the default `developer` role so a
 * stale supervisor prompt doesn't drop work on the floor.
 *
 * Per-agent execution is currently **serial** — sup decides which work
 * to delegate this turn; we run each agent's batch in subprocess-spawn
 * order. Parallel multi-agent will land once we have a file-lock manager
 * to prevent concurrent edits.
 */
export async function runDualAgentTurn(opts: LoopRunOptions): Promise<LoopTurnResult> {
  const orch = opts.orchestrator;
  const ws = orch.getWorkspace();
  const baseSupPrompt = opts.supervisorSystemPrompt ?? loadSupervisorSystemPrompt();
  // Operator-attached references manifest. Built fresh each turn so
  // adds/removes the operator made between turns become visible to sup
  // on its very next response — no daemon restart, no chat-log scrape.
  // When no refs exist the helper returns an empty string and the
  // append is a no-op, so the prompt stays exactly the legacy shape.
  const { buildRefsManifest } = await import('../project/refs-store.js');
  const refsManifest = await buildRefsManifest(ws.cwd);
  const supSystemPrompt = refsManifest
    ? `${baseSupPrompt}\n\n${refsManifest}`
    : baseSupPrompt;

  // Build the working agent-session map. Inputs:
  //   • opts.agentSessions (multi-agent caller) — preferred
  //   • opts.developerSessionId (legacy single-agent caller) — back-compat
  // We mutate this in-place as each agent's subprocess returns its session id.
  const agentSessions: Record<string, string | null> = {
    ...(opts.agentSessions ?? {}),
  };
  if (opts.developerSessionId && !agentSessions.developer) {
    agentSessions.developer = opts.developerSessionId;
  }

  orch.dispatch({ kind: 'sup-turn-start' });
  // Agent identity flows to the hook server via env → query param so
  // file locks + PreToolUse decisions stay correctly attributed even
  // under parallel dispatch (no shared mutable orchestrator state).
  const supResult = await runClaudeTurn(
    {
      role: 'supervisor',
      cwd: ws.cwd,
      prompt: opts.userPrompt,
      resumeSessionId: opts.supervisorSessionId,
      settingsPath: ws.settingsPath,
      mcpConfig: ws.mcpConfigPath,
      systemPromptAppend: supSystemPrompt,
      // Sup needs `acceptEdits` for the same reason specialists do: our
      // orchestrator's PreToolUse hook (policy engine + bash safety +
      // file-lock manager) is the real gate. CC's default mode would
      // surface a per-tool approval prompt for every Write/Edit which
      // breaks the bootstrap (CLAUDE.md, stack.json, etc.) and has no
      // security benefit since the destructive ones already escalate
      // to the operator via `request_user_approval` MCP.
      permissionMode: 'acceptEdits',
      envOverrides: orch.hookEnv('supervisor', 'supervisor'),
      // Chrome integration is on for the supervisor specifically — sup
      // is the conversational agent the operator talks to, so it
      // benefits most from being able to peek at running pages, inspect
      // a deploy, or fetch up-to-date docs from a URL. Specialists stay
      // off because they often run in parallel and would race the
      // single Chrome session attached to the operator's browser.
      enableChrome: true,
      signal: opts.signal,
    },
    opts.onSupervisorEvent,
  );
  const supervisorText = collectAssistantText(supResult.events);
  const { signals, remainingText: textAfterSignals } = extractSignals(supervisorText);
  const { tasks, remainingText } = extractDeveloperTasks(textAfterSignals);
  log('info', 'loop.supervisor.parsed', {
    tasks: tasks.length,
    signals,
    sessionId: supResult.sessionId,
  });
  orch.dispatch({ kind: 'sup-turn-end' });

  // Apply phase signals (set-phase events). Order matters: discovery-complete
  // → docs, ready-to-execute → phase-loop. If both fire in one turn we end
  // up in phase-loop, which is the most-advanced state and matches intent.
  for (const sig of signals) {
    const phase = SIGNAL_TO_PHASE[sig];
    if (phase) {
      orch.dispatch({ kind: 'set-phase', phase });
    }
  }

  // Group tasks by target agent. Unknown agent names degrade to the
  // default developer (logged) so a typo in the sup's tag doesn't lose
  // work — better to over-deliver than to silently drop the request.
  const tasksByAgent = new Map<string, DelegatedTask[]>();
  for (const task of tasks) {
    let resolved = getAgent(task.agent);
    if (!resolved) {
      log('warn', 'loop.unknown_agent_fallback', {
        requested: task.agent,
        fallback: 'developer',
      });
      resolved = getAgent('developer')!;
    }
    const arr = tasksByAgent.get(resolved.name);
    if (arr) arr.push({ agent: resolved.name, body: task.body, parallel: task.parallel });
    else
      tasksByAgent.set(resolved.name, [
        { agent: resolved.name, body: task.body, parallel: task.parallel },
      ]);
  }

  // Decide which agents run concurrently. An agent runs in parallel
  // only when *every* task targeted at it is `parallel="true"`. If just
  // one parallel-eligible agent exists we still run it serially — no
  // concurrency benefit, and keeps event ordering deterministic when
  // the operator has nothing to fan out against.
  type AgentBatchPlan = { config: AgentConfig; tasks: DelegatedTask[] };
  const parallelBatch: AgentBatchPlan[] = [];
  const serialBatch: AgentBatchPlan[] = [];
  for (const [agentName, agentTasks] of tasksByAgent) {
    const config = getAgent(agentName);
    if (!config) continue;
    const allParallel = agentTasks.every((t) => t.parallel);
    if (allParallel) parallelBatch.push({ config, tasks: agentTasks });
    else serialBatch.push({ config, tasks: agentTasks });
  }
  if (parallelBatch.length === 1 && parallelBatch[0]) {
    serialBatch.push(parallelBatch[0]);
    parallelBatch.length = 0;
  }

  const agentSummaries: AgentTurnSummary[] = [];
  let totalTasksDelegated = 0;

  // Serial first: preserves the legacy ordering when sup didn't opt into
  // parallel, and gives the parallel batch a clean handoff (no half-
  // finished serial work racing against the fan-out).
  for (const plan of serialBatch) {
    const summary = await runAgentBatch(opts, plan.config, plan.tasks, agentSessions);
    agentSummaries.push(summary);
    totalTasksDelegated += plan.tasks.length;
  }

  // Parallel batch: kicks off all flagged agents at once. The
  // FileLockManager + per-subprocess SELFCLAUDE_AGENT identity make it
  // safe — colliding edits get denied at the hook layer with a useful
  // reason the model can react to next turn.
  if (parallelBatch.length > 0) {
    log('info', 'loop.parallel_dispatch', {
      agents: parallelBatch.map((p) => p.config.name),
      count: parallelBatch.length,
    });
    const results = await Promise.all(
      parallelBatch.map((plan) =>
        runAgentBatch(opts, plan.config, plan.tasks, agentSessions),
      ),
    );
    for (let i = 0; i < parallelBatch.length; i++) {
      const summary = results[i];
      const plan = parallelBatch[i];
      if (!summary || !plan) continue;
      agentSummaries.push(summary);
      totalTasksDelegated += plan.tasks.length;
    }
  }

  // Backward-compat aliases derived from the developer slot.
  const developerSummary = agentSummaries.find((s) => s.agent === 'developer');
  const developerExecuted = developerSummary !== undefined;
  const developerText = developerSummary?.text ?? '';
  const developerSessionId = agentSessions.developer ?? null;

  const finalState = orch.getState();
  const finalPhase: Phase =
    finalState.tag === 'shutdown' ? 'shutdown' : finalState.phase;

  // Persist the new session ids and phase so a future `selfclaude start`
  // resumes from here. We only persist workflow phases (no `paused`/`shutdown`).
  if (finalPhase === 'discovery' || finalPhase === 'docs' || finalPhase === 'phase-loop') {
    await orch.updateProjectState({
      phase: finalPhase,
      supervisorSessionId: supResult.sessionId ?? orch.getProjectState().supervisorSessionId,
      developerSessionId: developerSessionId ?? orch.getProjectState().developerSessionId,
    });
  }

  return {
    supervisorSessionId: supResult.sessionId ?? null,
    developerSessionId,
    agentSessions,
    supervisorText,
    supervisorRemainingText: remainingText,
    tasksDelegated: totalTasksDelegated,
    developerExecuted,
    developerText,
    anyAgentExecuted: agentSummaries.length > 0,
    agents: agentSummaries,
    signals,
    phase: finalPhase,
  };
}

/**
 * Spawn one CC subprocess for `config` agent, hand it the batch of
 * delegated task bodies (each pre-injected via the orchestrator's
 * message bus), and capture its assistant text + session id. Used by
 * `runDualAgentTurn` to fan out per-agent work serially.
 *
 * Mutates `agentSessions` so the next iteration resumes from this
 * agent's CC session rather than spawning a fresh one.
 */
async function runAgentBatch(
  opts: LoopRunOptions,
  config: AgentConfig,
  tasks: DelegatedTask[],
  agentSessions: Record<string, string | null>,
): Promise<AgentTurnSummary> {
  const orch = opts.orchestrator;
  const ws = orch.getWorkspace();

  // Resolve system prompt: legacy override for developer, registry for
  // everyone else. The registry's layered loader appends a project-level
  // DNA addendum (when present at <cwd>/.selfclaude/agent-prompts/) on
  // top of the bundled / user-overridden base prompt.
  let systemPrompt: string;
  if (config.name === 'developer' && opts.developerSystemPrompt) {
    systemPrompt = opts.developerSystemPrompt;
  } else {
    systemPrompt = loadAgentPrompt(config, ws.cwd);
  }

  for (const task of tasks) {
    // For backward-compat keep the existing `to: 'developer'` path for
    // the default developer; specialist agents land in their own keyed
    // mailbox the message bus didn't formally know about — that's fine,
    // the body is also passed through `--append-system-prompt` context.
    orch.messages.enqueue({
      to: config.name === 'developer' ? 'developer' : 'developer', // legacy bus only knows 'developer'
      source: 'supervisor',
      body: task.body,
    });
  }

  // Use a fresh per-turn dispatch event for the developer slot (preserves
  // existing FSM transitions); other agents skip it for now (state-machine
  // change deferred to its own diff).
  if (config.name === 'developer') orch.dispatch({ kind: 'dev-turn-start' });

  const onEvent = opts.onAgentEvent
    ? (e: StreamEvent) => opts.onAgentEvent!(config.name, e)
    : config.name === 'developer'
      ? opts.onDeveloperEvent
      : undefined;

  // Specialist identity flows to the hook server via env → query param
  // (CC's hook layer only knows `role='developer'` for every non-sup
  // subprocess — we surface real identity through SELFCLAUDE_AGENT so
  // the orchestrator can attribute file locks + PreToolUse decisions
  // correctly even when two subprocesses run concurrently).
  const turn = await runClaudeTurn(
    {
      role: 'developer', // CC's spawn API only knows two roles; the
      // append-system-prompt + permission-mode below is what actually
      // specialises this subprocess.
      cwd: ws.cwd,
      prompt:
        `You have ${tasks.length} new task(s) in your context (injected by the supervisor). ` +
        'Read carefully, execute using the tools available, and summarize what you did in your final reply.',
      resumeSessionId: agentSessions[config.name] ?? undefined,
      settingsPath: ws.settingsPath,
      systemPromptAppend: systemPrompt,
      permissionMode: config.readOnly ? 'plan' : 'acceptEdits',
      signal: opts.signal,
      envOverrides: orch.hookEnv('developer', config.name),
      enableChrome: false,
    },
    onEvent,
  );

  const text = collectAssistantText(turn.events);
  agentSessions[config.name] = turn.sessionId ?? agentSessions[config.name] ?? null;

  if (text) {
    // All agents report back to the supervisor inbox. The label mentions
    // the source agent so the supervisor can attribute findings.
    const label = config.name === 'developer' ? 'DEVELOPER_REPORT' : `${config.name.toUpperCase()}_REPORT`;
    orch.messages.enqueue({
      to: 'supervisor',
      source: 'developer',
      body: `${label}:\n${text}`,
    });
  }

  if (config.name === 'developer') orch.dispatch({ kind: 'dev-turn-end' });

  return {
    agent: config.name,
    sessionId: turn.sessionId ?? null,
    text,
    tasksReceived: tasks.length,
  };
}
