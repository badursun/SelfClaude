'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  Brain,
  Compass,
  FileText,
  MessageSquare,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useTranslation } from '../lib/i18n';
import { AgentStatus, type AgentStatusInfo } from './agent-status';
import { BubbleMarkdown } from './bubble-markdown';
import { InputBar } from './input-bar';
import { ToolCard } from './tool-card';
import { useStickyBottom } from './use-sticky-bottom';
import { WakeupOverlay, findPendingWakeupFromDerived } from './wakeup-overlay';
import type { ChatLogEntry } from '@/lib/types';
import type { DerivedState } from '@/lib/api';

/**
 * **Single, reusable agent timeline.** Renders the dev-pane stream for
 * any non-supervisor agent — developer (default), ui-dev, security, or
 * any future specialist. The capabilities (scroll, sticky-bottom, lazy
 * load, tool cards, thinking bubbles, scroll-to-bottom button, per-tab
 * input bar, wakeup overlay) are identical across agents; only the
 * accent colour and label differ via the `agent` prop.
 *
 * Internally it normalises the two chat-log dialects (legacy `dev-*`
 * for the default developer, generic `agent-*` for specialists) into a
 * single item list, so the rendering loop is the same for everyone.
 *
 * Replaces the older `DevTimeline` + `SpecialistAgentTimeline` pair.
 */
export function AgentTimeline({
  agent,
  chatLog,
  selectedToolUseId,
  streamingTs,
  onSelectTool,
  busy,
  onSubmit,
  onLoadMoreHistory,
  hasMoreHistory,
  loadingHistory,
  wakeups,
  status,
}: {
  agent: string;
  chatLog: ChatLogEntry[];
  selectedToolUseId: string | null;
  /**
   * Timestamp of the agent bubble currently receiving streaming deltas
   * (for cursor / "writing…" rendering). Only meaningful for the
   * developer in practice; specialists render their own streaming via
   * agent-* deltas which the store already merges into a single bubble.
   */
  streamingTs: number | null;
  onSelectTool: (toolUseId: string | null) => void;
  busy: boolean;
  onSubmit: (text: string) => void;
  onLoadMoreHistory: () => void;
  hasMoreHistory: boolean;
  loadingHistory: boolean;
  /** Server-derived wakeup list (full session). Drives the wakeup overlay. */
  wakeups: DerivedState['wakeups'] | null;
  /**
   * Live status info for the active agent. Drives the bottom strip
   * with the running label + the Stop button. Phase 7 fix:
   * specialists now also receive a real status from `computeAgentStatus`,
   * so every agent timeline gets the abort affordance — not just sup.
   */
  status?: AgentStatusInfo | null;
}) {
  const { t } = useTranslation();
  const items = useMemo(() => buildAgentItems(chatLog, agent), [chatLog, agent]);
  const ref = useRef<HTMLDivElement>(null);
  const { isAtBottom, scrollToBottom } = useStickyBottom(
    ref,
    [items, agent, streamingTs],
    { onNearTop: hasMoreHistory ? onLoadMoreHistory : undefined },
  );

  // Wakeup overlay applies only to roles the wakeup runner manages (sup
  // and developer). For specialist agents we don't render the overlay
  // at all; their wakeup, if any, is logged as a developer-role wakeup.
  const pendingWakeup = useMemo(() => {
    if (!wakeups) return null;
    if (agent !== 'developer') return null;
    return findPendingWakeupFromDerived(wakeups, 'developer');
  }, [wakeups, agent]);
  const showOverlay = status === null && pendingWakeup !== null;

  // Auto-load older history when this tab has nothing in the visible
  // window — the operator just lands on a quiet tab, we keep paginating
  // until content arrives or hasMoreHistory is false.
  useEffect(() => {
    if (items.length > 0) return;
    if (!hasMoreHistory) return;
    if (loadingHistory) return;
    onLoadMoreHistory();
  }, [items.length, hasMoreHistory, loadingHistory, onLoadMoreHistory, agent]);

  const accent = AGENT_ACCENT[agent] ?? AGENT_ACCENT.developer!;

  return (
    <div className="h-full flex flex-col bg-bg-subtle relative min-w-0 overflow-hidden">
      {showOverlay && pendingWakeup && (
        <WakeupOverlay wakeup={pendingWakeup} variant="developer" />
      )}
      <div
        ref={ref}
        className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin px-2 py-2 min-w-0"
      >
        {hasMoreHistory && (
          <div className="text-center py-1.5">
            <button
              onClick={onLoadMoreHistory}
              disabled={loadingHistory}
              className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 hover:text-zinc-100 px-2 py-1 rounded border border-border hover:border-border-strong disabled:opacity-50 disabled:cursor-wait"
            >
              {loadingHistory ? t('common.loading') : t('agentTimeline.loadOlder')}
            </button>
          </div>
        )}
        {items.length === 0 && !loadingHistory && !hasMoreHistory && (
          <div className="h-full flex items-center justify-center p-6 text-center">
            <p className="text-[11px] text-zinc-500 italic max-w-md leading-relaxed">
              {agent === 'developer'
                ? t('agentTimeline.empty.developer')
                : agent === 'security'
                  ? t('agentTimeline.empty.security')
                  : t('agentTimeline.empty.agent', { agent })}
            </p>
          </div>
        )}
        {items.map((item) => {
          if (item.kind === 'tool') {
            return (
              <div key={item.toolUseId} style={{ margin: '10px 0' }}>
                <ToolCard
                  name={item.name}
                  summary={item.summary}
                  result={item.result}
                  isError={item.isError}
                  selected={item.toolUseId === selectedToolUseId}
                  startedAt={item.ts}
                  onClick={() =>
                    onSelectTool(
                      item.toolUseId === selectedToolUseId ? null : item.toolUseId,
                    )
                  }
                />
              </div>
            );
          }
          if (item.kind === 'text') {
            const isStreaming = item.ts === streamingTs;
            return (
              <div
                key={item.key}
                className="flex items-start gap-1.5 px-2 text-zinc-200"
                style={{ margin: '6px 0' }}
              >
                <MessageSquare size={11} className="text-zinc-500 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <BubbleMarkdown streaming={isStreaming}>{item.text}</BubbleMarkdown>
                </div>
                <TimeLabel ts={item.ts} />
              </div>
            );
          }
          if (item.kind === 'thinking') {
            return <ThinkingBubble key={item.key} text={item.text} />;
          }
          if (item.kind === 'task-marker') {
            return (
              <div
                key={item.key}
                className={cn(
                  'flex items-stretch rounded-md border overflow-hidden',
                  accent.markerBorder,
                  accent.markerBg,
                )}
                style={{ margin: '20px 0' }}
              >
                <div
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1.5 border-r shrink-0',
                    accent.markerHeaderBg,
                    accent.markerBorder,
                  )}
                >
                  <Compass size={12} className={accent.iconColor} />
                  <span
                    className={cn(
                      'text-[10px] font-mono uppercase tracking-widest font-bold',
                      accent.titleColor,
                    )}
                  >
                    {t('agentTimeline.taskMarker', { agent })}
                  </span>
                </div>
                <div className="flex-1 px-3 py-1.5 min-w-0 flex items-center">
                  <span className={cn('text-[12px] font-mono truncate', accent.bodyColor)}>
                    {item.summary}
                  </span>
                </div>
              </div>
            );
          }
          if (item.kind === 'phase-doc') {
            return (
              <div
                key={item.key}
                className="flex items-center gap-1.5 px-2 text-[10px] text-emerald-500 italic font-mono"
                style={{ margin: '6px 0' }}
              >
                <FileText size={11} />
                <span>{t('agentTimeline.phaseDoc.wrote', { filename: item.filename })}</span>
              </div>
            );
          }
          if (item.kind === 'user-message' || item.kind === 'user-note') {
            return (
              <div
                key={item.key}
                className="w-full rounded bg-amber-600/15 border-l-2 border-amber-500 border-r border-y border-amber-700/40 px-3 py-1.5 min-w-0"
                style={{ margin: '20px 0' }}
              >
                <div className="text-[10px] text-amber-300/80 mb-0.5 uppercase tracking-wide font-semibold">
                  {item.kind === 'user-message'
                    ? t('agentTimeline.userMessage', { agent })
                    : t('agentTimeline.userNote', { agent })}
                </div>
                <p className="whitespace-pre-wrap break-words text-amber-50 bubble-text">
                  {item.text}
                </p>
              </div>
            );
          }
          if (item.kind === 'lifecycle') {
            return (
              <div
                key={item.key}
                className={cn(
                  'text-[10px] italic px-2 font-mono',
                  item.event === 'summoned' ? 'text-emerald-400' : 'text-zinc-500',
                )}
                style={{ margin: '6px 0' }}
              >
                {item.event === 'summoned' ? '▶' : '◼'} {agent} {item.event === 'summoned' ? t('agentTimeline.lifecycle.summoned') : t('agentTimeline.lifecycle.dismissed')}
              </div>
            );
          }
          if (item.kind === 'verdict') {
            // Sup's "Yargısal Karar" — broadcast to every agent. Renders
            // prominently red so the operator can spot binding decisions
            // at a glance, regardless of which agent's tab they're on.
            return (
              <div
                key={item.key}
                className="w-full rounded border-l-4 border-red-500 border-r border-y border-red-700/50 bg-red-950/30 px-3 py-2"
                style={{ margin: '20px 0' }}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-[10px] uppercase tracking-widest font-bold text-red-300">
                    {t('agentTimeline.verdict')}
                  </span>
                  <span className="text-[10px] text-red-400 font-mono tabular-nums">
                    #{item.id.toString().padStart(3, '0')}
                  </span>
                </div>
                <p className="text-[12px] leading-snug whitespace-pre-wrap text-red-50 font-mono">
                  {item.text}
                </p>
              </div>
            );
          }
          return null;
        })}
      </div>
      {!isAtBottom && (
        <button
          onClick={scrollToBottom}
          className={cn(
            'absolute bottom-24 right-4 z-20 rounded-full text-white p-2 shadow-lg shadow-black/40 transition-transform hover:scale-105',
            accent.scrollBtn,
          )}
          aria-label={t('agentTimeline.scrollToBottom')}
          title={t('agentTimeline.scrollToBottom')}
        >
          <ArrowDown size={14} />
        </button>
      )}
      <AgentStatus status={status ?? null} variant={agent} />
      <InputBar variant={agent} busy={busy} onSubmit={onSubmit} />
    </div>
  );
}

/* ─────────────────────────── helpers ─────────────────────────── */

interface AgentAccent {
  iconColor: string;
  titleColor: string;
  bodyColor: string;
  markerBorder: string;
  markerBg: string;
  markerHeaderBg: string;
  scrollBtn: string;
}

const AGENT_ACCENT: Record<string, AgentAccent> = {
  developer: {
    iconColor: 'text-cyan-300',
    titleColor: 'text-cyan-200',
    bodyColor: 'text-cyan-100',
    markerBorder: 'border-cyan-700/60',
    markerBg: 'bg-cyan-950/30',
    markerHeaderBg: 'bg-cyan-900/50',
    scrollBtn: 'bg-amber-600 hover:bg-amber-500',
  },
  'ui-dev': {
    iconColor: 'text-violet-300',
    titleColor: 'text-violet-200',
    bodyColor: 'text-violet-100',
    markerBorder: 'border-violet-700/60',
    markerBg: 'bg-violet-950/30',
    markerHeaderBg: 'bg-violet-900/50',
    scrollBtn: 'bg-violet-600 hover:bg-violet-500',
  },
  security: {
    iconColor: 'text-rose-300',
    titleColor: 'text-rose-200',
    bodyColor: 'text-rose-100',
    markerBorder: 'border-rose-700/60',
    markerBg: 'bg-rose-950/30',
    markerHeaderBg: 'bg-rose-900/50',
    scrollBtn: 'bg-rose-600 hover:bg-rose-500',
  },
};

/**
 * Tiny right-aligned time label rendered alongside chat bubbles. Hover
 * shows the full local datetime; the label itself is HH:MM so the
 * timeline is dense but still scannable.
 */
function TimeLabel({ ts }: { ts: number }) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return (
    <span
      className="shrink-0 text-[9px] font-mono text-zinc-600 tabular-nums mt-0.5 select-none"
      title={d.toLocaleString()}
    >
      {hh}:{mm}
    </span>
  );
}

/**
 * Reasoning bubble — collapsible, line-counted, mor accent.
 */
function ThinkingBubble({ text }: { text: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const firstLine = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  const preview = firstLine.length > 90 ? `${firstLine.slice(0, 87)}…` : firstLine;
  const lineCount = text.split('\n').filter((l) => l.trim().length > 0).length;
  return (
    <div
      className="rounded-md border border-violet-900/50 bg-violet-950/20 overflow-hidden"
      style={{ margin: '8px 0' }}
    >
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-2 py-1 hover:bg-violet-950/40 transition-colors text-left"
      >
        <Brain size={11} className="shrink-0 text-violet-400" />
        <span className="text-[10px] uppercase tracking-widest font-semibold text-violet-300">
          {t('agentTimeline.thinking')}
        </span>
        <span className="text-[10px] text-violet-500 tabular-nums">
          {t('agentTimeline.thinking.lineCount', { lineCount })}
        </span>
        {!open && (
          <span className="text-[11px] text-zinc-400 italic font-mono truncate">
            {preview}
          </span>
        )}
      </button>
      {open && (
        <div className="px-3 py-2 border-t border-violet-900/40">
          <p className="whitespace-pre-wrap break-words text-[11px] leading-[15px] font-mono text-zinc-300 italic">
            {text}
          </p>
        </div>
      )}
    </div>
  );
}

type AgentTimelineItem =
  | {
      kind: 'tool';
      toolUseId: string;
      name: string;
      summary: string;
      result?: string;
      isError?: boolean;
      ts: number;
    }
  | { kind: 'text'; key: string; text: string; ts: number }
  | { kind: 'thinking'; key: string; text: string; ts: number }
  | { kind: 'task-marker'; key: string; summary: string }
  | { kind: 'phase-doc'; key: string; filename: string }
  | { kind: 'user-message'; key: string; text: string }
  | { kind: 'user-note'; key: string; text: string }
  | { kind: 'lifecycle'; key: string; event: 'summoned' | 'dismissed' }
  | { kind: 'verdict'; key: string; id: number; text: string; ts: number };

/**
 * Build the unified item list for `agent`. Reads BOTH chat-log dialects:
 *
 *   • Default developer:  legacy `dev-tool-call`, `dev-tool-result`,
 *     `dev-text`, `dev-thinking`, plus `task-marker` rows that don't
 *     carry an `[other-agent]` prefix, plus `user-message-dev` /
 *     `user-note-dev`, plus `phase-doc-written`.
 *
 *   • Specialist (ui-dev / security / …):  generic `agent-tool-call`,
 *     `agent-tool-result`, `agent-text`, `agent-thinking`,
 *     `agent-summoned`, `agent-dismissed`, plus `task-marker` rows
 *     prefixed with `[agent]`.
 *
 * Tool-result entries are paired with their tool-call by `toolUseId`
 * so each `ToolCard` carries its own result inline.
 */
function buildAgentItems(chatLog: ChatLogEntry[], agent: string): AgentTimelineItem[] {
  const isDeveloper = agent === 'developer';
  const taskTagPrefix = `[${agent}]`;
  const tools = new Map<string, Extract<AgentTimelineItem, { kind: 'tool' }>>();
  const out: AgentTimelineItem[] = [];

  for (const entry of chatLog) {
    // Verdicts apply to every agent (broadcast). Render in every tab.
    if (entry.type === 'verdict') {
      out.push({
        kind: 'verdict',
        key: `${entry.ts}-verdict-${entry.id}`,
        id: entry.id,
        text: entry.text,
        ts: entry.ts,
      });
      continue;
    }
    if (isDeveloper) {
      if (entry.type === 'dev-tool-call') {
        const item: AgentTimelineItem = {
          kind: 'tool',
          toolUseId: entry.toolUseId,
          name: entry.name,
          summary: summarizeToolInput(entry.name, entry.input),
          ts: entry.ts,
        };
        tools.set(entry.toolUseId, item as Extract<AgentTimelineItem, { kind: 'tool' }>);
        out.push(item);
        continue;
      }
      if (entry.type === 'dev-tool-result') {
        const tool = tools.get(entry.toolUseId);
        if (tool) {
          tool.result = entry.text;
          tool.isError = entry.isError;
        }
        continue;
      }
      if (entry.type === 'dev-text') {
        out.push({
          kind: 'text',
          key: `${entry.ts}-text`,
          text: entry.text,
          ts: entry.ts,
        });
        continue;
      }
      if (entry.type === 'dev-thinking') {
        out.push({
          kind: 'thinking',
          key: `${entry.ts}-think`,
          text: entry.text,
          ts: entry.ts,
        });
        continue;
      }
      if (entry.type === 'phase-doc-written') {
        out.push({ kind: 'phase-doc', key: `${entry.ts}-doc`, filename: entry.filename });
        continue;
      }
      if (entry.type === 'user-message-dev') {
        out.push({ kind: 'user-message', key: `${entry.ts}-uMsg`, text: entry.text });
        continue;
      }
      if (entry.type === 'user-note-dev') {
        out.push({ kind: 'user-note', key: `${entry.ts}-note`, text: entry.text });
        continue;
      }
      if (entry.type === 'task-marker') {
        // Developer-bound task-markers are unprefixed (any `[ui-dev] …`
        // prefix means it went to a specialist, not here).
        if (entry.summary.startsWith('[')) continue;
        out.push({ kind: 'task-marker', key: `${entry.ts}-task`, summary: entry.summary });
        continue;
      }
    } else {
      if (entry.type === 'agent-tool-call' && entry.agent === agent) {
        const item: AgentTimelineItem = {
          kind: 'tool',
          toolUseId: entry.toolUseId,
          name: entry.name,
          summary: summarizeToolInput(entry.name, entry.input),
          ts: entry.ts,
        };
        tools.set(entry.toolUseId, item as Extract<AgentTimelineItem, { kind: 'tool' }>);
        out.push(item);
        continue;
      }
      if (entry.type === 'agent-tool-result' && entry.agent === agent) {
        const tool = tools.get(entry.toolUseId);
        if (tool) {
          tool.result = entry.text;
          tool.isError = entry.isError;
        }
        continue;
      }
      if (entry.type === 'agent-text' && entry.agent === agent) {
        out.push({
          kind: 'text',
          key: `${entry.ts}-text`,
          text: entry.text,
          ts: entry.ts,
        });
        continue;
      }
      if (entry.type === 'agent-thinking' && entry.agent === agent) {
        out.push({
          kind: 'thinking',
          key: `${entry.ts}-think`,
          text: entry.text,
          ts: entry.ts,
        });
        continue;
      }
      if (
        (entry.type === 'agent-summoned' || entry.type === 'agent-dismissed') &&
        entry.agent === agent
      ) {
        out.push({
          kind: 'lifecycle',
          key: `${entry.ts}-${entry.type}`,
          event: entry.type === 'agent-summoned' ? 'summoned' : 'dismissed',
        });
        continue;
      }
      if (entry.type === 'task-marker' && entry.summary.startsWith(taskTagPrefix)) {
        const summary = entry.summary.slice(taskTagPrefix.length).trim();
        out.push({ kind: 'task-marker', key: `${entry.ts}-task`, summary });
        continue;
      }
    }
  }
  return out;
}

function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash') return String(input.command ?? '');
  if (name === 'Read' || name === 'Edit' || name === 'Write') return String(input.file_path ?? '');
  if (name === 'Grep' || name === 'Glob') return String(input.pattern ?? '');
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.length < 80) return v;
  }
  return '';
}
