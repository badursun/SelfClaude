'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Code,
  FlaskConical,
  Layers,
  Plus,
  Send,
  Shield,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useTranslation } from '../lib/i18n';
import { computeAgentStatus } from './agent-status';
import { AgentTimeline } from './agent-timeline';
import type { ChatLogEntry, SessionMeta } from '@/lib/types';
import type { DerivedState } from '@/lib/api';

/**
 * Known specialist roles — always present in the tab strip even when
 * none are currently summoned, so the operator can propose dispatching
 * an inactive agent without needing sup to summon it first. The
 * `developer` slot stays first because it's the default `<TASK_FOR_DEVELOPER>`
 * target. Order matches the registry `BUILTIN_AGENTS` semantics.
 */
const KNOWN_SPECIALISTS = ['developer', 'ui-dev', 'security', 'tester', 'refactorer'] as const;

/**
 * Multi-agent dev pane. Renders a horizontal tab strip across all known
 * specialists (active = bright, inactive = faded) and below it either
 * the selected tab's timeline (for active agents) or a "propose to sup"
 * mini-form (for inactive ones). Operator can ask sup to dispatch an
 * inactive specialist by typing a request; sup reads it and decides —
 * see the OPERATOR_AGENT_PROPOSAL handler in supervisor.md.
 *
 * Capabilities for active timelines — scroll, sticky-bottom, lazy load,
 * tool cards, thinking, scroll-to-bottom, per-tab input — are delegated
 * to `AgentTimeline`; only the accent colour and label differ here.
 * The supervisor itself is never represented here; it has its own pane.
 */
export function AgentPane({
  meta,
  chatLog,
  selectedToolUseId,
  streamingDevTs,
  onSelectTool,
  busy,
  onSubmitDev,
  onSubmitAgent,
  onProposeAgent,
  onLoadMoreHistory,
  hasMoreHistory,
  loadingHistory,
  wakeups,
  derived,
}: {
  meta: SessionMeta | null;
  chatLog: ChatLogEntry[];
  selectedToolUseId: string | null;
  streamingDevTs: number | null;
  onSelectTool: (toolUseId: string | null) => void;
  busy: boolean;
  onSubmitDev: (text: string) => void;
  onSubmitAgent: (agent: string, text: string) => void;
  /** Propose dispatching an inactive specialist — sup decides. */
  onProposeAgent: (agent: string, text: string) => Promise<void> | void;
  onLoadMoreHistory: () => void;
  hasMoreHistory: boolean;
  loadingHistory: boolean;
  wakeups: DerivedState['wakeups'] | null;
  derived: DerivedState | null;
}) {
  // Active = currently-summoned by sup. We track this separately from
  // KNOWN_SPECIALISTS so the tab strip can render inactive agents in a
  // muted "propose" state.
  const summonedSet = useMemo(() => {
    const set = new Set(derived?.activeAgents ?? ['developer']);
    set.add('developer'); // Developer always counts as active even when idle.
    return set;
  }, [derived?.activeAgents]);

  const allAgents = useMemo(() => {
    // Anchor with KNOWN_SPECIALISTS, then append any project-custom
    // agents that show up in the runtime list (future-proof against
    // user-defined specialists in `<cwd>/.selfclaude/agents.json`).
    const base = [...KNOWN_SPECIALISTS] as string[];
    for (const a of derived?.activeAgents ?? []) {
      if (!base.includes(a)) base.push(a);
    }
    return base;
  }, [derived?.activeAgents]);

  // Kept for downstream timeline lookups that expect the legacy shape
  // (developer first, then others). Drives status indicators only —
  // tab visibility now comes from `allAgents`.
  const activeAgents = useMemo(
    () => ['developer', ...allAgents.filter((a) => a !== 'developer' && summonedSet.has(a))],
    [allAgents, summonedSet],
  );

  // Last activity ts per agent — used both for the green-pulse indicator
  // on the tab AND for the smart-default landing tab.
  const lastAgentTs = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of chatLog) {
      if (e.type === 'dev-tool-call' || e.type === 'dev-text' || e.type === 'dev-thinking') {
        map.set('developer', Math.max(map.get('developer') ?? 0, e.ts));
      } else if (
        e.type === 'agent-tool-call' ||
        e.type === 'agent-text' ||
        e.type === 'agent-thinking' ||
        e.type === 'agent-tool-result'
      ) {
        map.set(e.agent, Math.max(map.get(e.agent) ?? 0, e.ts));
      }
    }
    return map;
  }, [chatLog]);

  // Smart-default tab: most-recently-active. If no agent has activity in
  // the visible window (cold reload + everything in older history), fall
  // back to the last-summoned specialist (developer is at index 0).
  const defaultActiveTab = useMemo(() => {
    let bestAgent: string | null = null;
    let bestTs = 0;
    for (const agent of activeAgents) {
      const ts = lastAgentTs.get(agent) ?? 0;
      if (ts > bestTs) {
        bestTs = ts;
        bestAgent = agent;
      }
    }
    if (bestAgent) return bestAgent;
    if (activeAgents.length > 1) return activeAgents[activeAgents.length - 1]!;
    return 'developer';
  }, [activeAgents, lastAgentTs]);

  // Tick state to refresh tab activity indicators (live/recent/idle)
  // even when chatLog doesn't change. Keeps the "running" pulse honest:
  // without it, an agent that finished 4 seconds ago would still show
  // as "live" until the next event lands.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const [activeTab, setActiveTab] = useState<string | null>(null);
  // The selected tab can be any known agent (including inactive ones —
  // operator may have clicked an inactive tab to propose dispatching it).
  // Only fall back to the default when the current selection is gone
  // entirely (e.g. operator never clicked anywhere yet, or a custom
  // agent disappeared from the list).
  const effectiveTab =
    activeTab && allAgents.includes(activeTab) ? activeTab : defaultActiveTab;
  const effectiveTabIsActive = summonedSet.has(effectiveTab);

  /**
   * Auto-jump to a newly-summoned specialist. When `activeAgents` grows
   * (sup just summoned ui-dev / security / etc.), we switch the operator
   * over so they see the new agent's work immediately. The previous
   * activeAgents list is held in a ref so we only react to growth, not
   * to every chatLog tick.
   */
  const prevActiveAgentsRef = useRef<string[]>(activeAgents);
  useEffect(() => {
    const prev = prevActiveAgentsRef.current;
    const newcomers = activeAgents.filter((a) => !prev.includes(a));
    prevActiveAgentsRef.current = activeAgents;
    if (newcomers.length === 0) return;
    // Pick the LAST newcomer (most recently summoned). Skip pure
    // 'developer' bumps — that's the default state, not a new specialist.
    const target = newcomers[newcomers.length - 1]!;
    if (target === 'developer') return;
    setActiveTab(target);
  }, [activeAgents]);

  // Phase 7 fix: status is now meaningful for any agent — not just the
  // default developer. `computeAgentStatus` routes the developer
  // through the existing `computeDevStatus` path and scans
  // `agent-tool-call` entries scoped to the agent name for
  // specialists. The Stop button at the bottom of every agent
  // timeline is what this powers.
  const agentStatus = useMemo(
    () =>
      computeAgentStatus(
        effectiveTab,
        meta,
        chatLog,
        effectiveTab === 'developer' ? streamingDevTs : null,
      ),
    [meta, chatLog, streamingDevTs, effectiveTab],
  );

  /**
   * Submit handler for the unified timeline's input bar. Dispatches to
   * the right back-channel based on which agent owns the active tab.
   */
  const handleSubmit = (text: string) => {
    if (effectiveTab === 'developer') onSubmitDev(text);
    else onSubmitAgent(effectiveTab, text);
  };

  return (
    <div className="h-full flex flex-col min-w-0">
      <div className="flex items-stretch border-b border-border bg-bg-subtle h-7 shrink-0">
        {allAgents.map((agent) => (
          <AgentTab
            key={agent}
            agent={agent}
            active={agent === effectiveTab}
            summoned={summonedSet.has(agent)}
            lastTs={lastAgentTs.get(agent) ?? 0}
            onClick={() => setActiveTab(agent)}
          />
        ))}
      </div>
      <div className="flex-1 min-h-0">
        {effectiveTabIsActive ? (
          <AgentTimeline
            // The key forces a remount on tab change so the timeline's
            // sticky-bottom + scroll position resets cleanly per agent —
            // otherwise switching between two long timelines would carry
            // the previous tab's scroll offset over.
            key={effectiveTab}
            agent={effectiveTab}
            chatLog={chatLog}
            selectedToolUseId={selectedToolUseId}
            streamingTs={effectiveTab === 'developer' ? streamingDevTs : null}
            onSelectTool={onSelectTool}
            busy={busy}
            onSubmit={handleSubmit}
            onLoadMoreHistory={onLoadMoreHistory}
            hasMoreHistory={hasMoreHistory}
            loadingHistory={loadingHistory}
            wakeups={wakeups}
            status={agentStatus}
          />
        ) : (
          <ProposeAgentPanel
            agent={effectiveTab}
            onPropose={(text) => onProposeAgent(effectiveTab, text)}
          />
        )}
      </div>
    </div>
  );
}

const AGENT_ICON: Record<string, React.ElementType> = {
  developer: Code,
  'ui-dev': Layers,
  security: Shield,
  tester: FlaskConical,
  refactorer: Wrench,
};

const AGENT_LABEL: Record<string, string> = {
  developer: 'developer',
  'ui-dev': 'ui-dev',
  security: 'security',
  tester: 'tester',
  refactorer: 'refactorer',
};


const AGENT_TAB_ACCENT: Record<string, { active: string; idle: string; dot: string }> = {
  developer: {
    active: 'border-amber-500 text-amber-200 bg-amber-950/30',
    idle: 'border-transparent text-zinc-400 hover:text-zinc-100',
    dot: 'bg-amber-400',
  },
  'ui-dev': {
    active: 'border-violet-500 text-violet-200 bg-violet-950/30',
    idle: 'border-transparent text-zinc-400 hover:text-zinc-100',
    dot: 'bg-violet-400',
  },
  security: {
    active: 'border-rose-500 text-rose-200 bg-rose-950/30',
    idle: 'border-transparent text-zinc-400 hover:text-zinc-100',
    dot: 'bg-rose-400',
  },
  tester: {
    active: 'border-emerald-500 text-emerald-200 bg-emerald-950/30',
    idle: 'border-transparent text-zinc-400 hover:text-zinc-100',
    dot: 'bg-emerald-400',
  },
  refactorer: {
    active: 'border-zinc-500 text-zinc-200 bg-zinc-800/40',
    idle: 'border-transparent text-zinc-400 hover:text-zinc-100',
    dot: 'bg-zinc-400',
  },
};

function AgentTab({
  agent,
  active,
  summoned,
  lastTs,
  onClick,
}: {
  agent: string;
  active: boolean;
  /** Currently-summoned by sup. Inactive agents render dimmed + with a propose icon. */
  summoned: boolean;
  lastTs: number;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const Icon = AGENT_ICON[agent] ?? Plus;
  const accent = AGENT_TAB_ACCENT[agent] ?? AGENT_TAB_ACCENT.developer!;

  // Three activity tiers based on most-recent event timestamp:
  //   live    — last 3s; agent is currently producing output → "running"
  //   recent  — last 30s; just finished, fading out → solid dot
  //   idle    — older or never; no indicator
  const ageMs = lastTs > 0 ? Date.now() - lastTs : Number.POSITIVE_INFINITY;
  const live = ageMs < 3_000;
  const recent = !live && ageMs < 30_000;

  // Inactive (not summoned by sup yet) — render in a muted style with
  // a small "+" affordance to signal "click to propose dispatching."
  if (!summoned) {
    return (
      <button
        onClick={onClick}
        className={cn(
          'flex items-center gap-1.5 px-3 border-b-2 text-[11px] font-mono uppercase tracking-wide transition-colors',
          active
            ? 'border-zinc-500 text-zinc-300 bg-bg-elevated/40'
            : 'border-transparent text-zinc-600 hover:text-zinc-300 hover:bg-bg-elevated/30',
        )}
        title={t('agentPane.tab.notActive.title', { agent })}
      >
        <Icon size={11} className="opacity-60" />
        <span className="opacity-80">{agent}</span>
        <Plus size={10} className="opacity-50" />
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 px-3 border-b-2 text-[11px] font-mono uppercase tracking-wide transition-colors',
        active ? accent.active : accent.idle,
      )}
    >
      <Icon size={12} />
      {agent}
      {live && (
        <>
          <span
            className={cn(
              'inline-block w-2 h-2 rounded-full animate-pulse',
              accent.dot,
            )}
            title={t('agentPane.tab.streamingNow')}
          />
          <span className={cn('lowercase tracking-normal italic', accent.idle.includes('text-') ? '' : '')}>
            {t('agentPane.tab.running')}
          </span>
        </>
      )}
      {recent && !live && (
        <span
          className={cn('inline-block w-1.5 h-1.5 rounded-full', accent.dot)}
          title={t('agentPane.tab.recentActivity')}
        />
      )}
    </button>
  );
}

/**
 * Centred mini-form shown in place of an agent timeline when the
 * operator clicks an inactive agent tab. Submits a "please consider
 * dispatching X for this work" message to sup, who decides whether
 * to actually `<TASK_FOR_DEVELOPER agent="X">` or push back.
 *
 * The message gets routed through the regular sendMessage pipeline
 * (sup's chat shows the operator's intent), so the audit trail is the
 * normal user-message → sup-turn flow — no new chat-log entry types.
 */
function ProposeAgentPanel({
  agent,
  onPropose,
}: {
  agent: string;
  onPropose: (text: string) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const Icon = AGENT_ICON[agent] ?? Sparkles;
  const accent = AGENT_TAB_ACCENT[agent] ?? AGENT_TAB_ACCENT.developer!;

  const descriptionKey = (
    agent === 'developer' ? 'agentPane.desc.developer'
    : agent === 'ui-dev' ? 'agentPane.desc.uiDev'
    : agent === 'security' ? 'agentPane.desc.security'
    : agent === 'tester' ? 'agentPane.desc.tester'
    : agent === 'refactorer' ? 'agentPane.desc.refactorer'
    : 'agentPane.desc.custom'
  ) as Parameters<typeof t>[0];
  const description = t(descriptionKey);
  const label = AGENT_LABEL[agent] ?? agent;

  const handleSubmit = async () => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || pending) return;
    setPending(true);
    try {
      await onPropose(trimmed);
      setText('');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="h-full flex flex-col items-center justify-center px-6 py-8 overflow-y-auto scrollbar-thin">
      <div className="w-full max-w-md">
        <div className="flex items-start gap-3 mb-4">
          <span
            className={cn(
              'shrink-0 w-9 h-9 rounded-md border flex items-center justify-center',
              accent.active,
            )}
          >
            <Icon size={16} />
          </span>
          <div className="flex-1 min-w-0">
            <h3 className="text-[13px] font-mono font-semibold text-zinc-100">
              {label} <span className="text-[10px] uppercase tracking-widest text-zinc-500 ml-1">{t('agentPane.tab.notActive')}</span>
            </h3>
            <p className="text-[11px] text-zinc-400 leading-relaxed mt-0.5">{description}</p>
          </div>
        </div>
        <div className="rounded-md border border-border bg-bg-panel/50 p-3 mb-3">
          <p className="text-[11px] text-zinc-300 leading-relaxed">
            {t('agentPane.propose.tellSup', { label })}
          </p>
          <p className="text-[10px] text-zinc-500 leading-relaxed mt-1.5">
            {t('agentPane.propose.detail', { label })}
          </p>
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder={t('agentPane.propose.placeholder', { label })}
          rows={5}
          disabled={pending}
          autoFocus
          className="w-full bg-bg-subtle border border-border rounded-md px-3 py-2 text-[12px] font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-cyan-600 resize-none leading-relaxed disabled:opacity-50"
        />
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[10px] font-mono text-zinc-600">
            {t('agentPane.propose.shortcut')}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={text.trim().length === 0 || pending}
            className={cn(
              'text-[11px] font-mono font-medium px-3 py-1.5 rounded inline-flex items-center gap-1.5 border',
              text.trim().length > 0 && !pending
                ? 'border-cyan-600 bg-cyan-700 text-white hover:bg-cyan-600'
                : 'border-zinc-700 bg-zinc-900/40 text-zinc-600 cursor-not-allowed',
            )}
          >
            {pending ? (
              <>{t('agentPane.propose.button.sending')}</>
            ) : (
              <>
                <Send size={11} /> {t('agentPane.propose.button.propose')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

