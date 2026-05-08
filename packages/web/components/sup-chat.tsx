'use client';

import { useMemo, useRef, useState } from 'react';
import { useTranslation } from '../lib/i18n';
import {
  ArrowDown,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Search,
  Sparkles,
  Terminal,
  Timer,
  Wrench,
} from 'lucide-react';
import { AgentStatus, type AgentStatusInfo } from './agent-status';
import { BubbleMarkdown } from './bubble-markdown';
import { InputBar } from './input-bar';
import { useStickyBottom } from './use-sticky-bottom';
import {
  WakeupOverlay,
  findPendingWakeup,
  findPendingWakeupFromDerived,
} from './wakeup-overlay';
import { cn } from '@/lib/cn';
import type { ChatLogEntry } from '@/lib/types';
import type { DerivedState } from '@/lib/api';

export function SupChat({
  chatLog,
  streamingTs,
  status,
  busy,
  hasPendingQuestion,
  hasPendingApproval,
  onSubmit,
  onSelectTool,
  onLoadMoreHistory,
  hasMoreHistory,
  loadingHistory,
  wakeups,
  initialInput,
}: {
  chatLog: ChatLogEntry[];
  streamingTs: number | null;
  status: AgentStatusInfo | null;
  busy: boolean;
  hasPendingQuestion: boolean;
  hasPendingApproval: boolean;
  onSubmit: (text: string) => void;
  /** Click handler for tool strips — opens the right pane Tool Detail tab. */
  onSelectTool: (toolUseId: string) => void;
  onLoadMoreHistory: () => void;
  hasMoreHistory: boolean;
  loadingHistory: boolean;
  /** Server-derived wakeup list (full session). Falls back to chatLog when null. */
  wakeups: DerivedState['wakeups'] | null;
  /**
   * Phase 3 demo — seed the chat textarea on first mount with the
   * canned brief so the operator doesn't have to type anything to
   * kick off the orchestration. Empty string by default.
   */
  initialInput?: string;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const { isAtBottom, scrollToBottom } = useStickyBottom(
    ref,
    [chatLog, streamingTs, status],
    { onNearTop: hasMoreHistory ? onLoadMoreHistory : undefined },
  );

  // Filter to supervisor-pane-relevant entries, then build a clustered
  // render list — consecutive sup-tool-call entries with the same
  // `name` collapse into one stacked strip (operator can expand to
  // see each one). Tool-results are dropped here; they're folded into
  // the right pane on click.
  const renderItems = useMemo(() => buildSupRenderList(chatLog), [chatLog]);
  const pendingWakeup = useMemo(
    () =>
      wakeups
        ? findPendingWakeupFromDerived(wakeups, 'supervisor')
        : findPendingWakeup(chatLog, 'supervisor'),
    [wakeups, chatLog],
  );
  const showOverlay = status === null && pendingWakeup !== null;

  return (
    <div className="h-full flex flex-col relative min-w-0 overflow-hidden">
      {showOverlay && pendingWakeup && (
        <WakeupOverlay wakeup={pendingWakeup} variant="supervisor" />
      )}
      <div
        ref={ref}
        className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin px-3 py-2.5 space-y-2 min-w-0"
      >
        {hasMoreHistory && (
          <div className="text-center py-1.5">
            <button
              onClick={onLoadMoreHistory}
              disabled={loadingHistory}
              className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 hover:text-zinc-100 px-2 py-1 rounded border border-border hover:border-border-strong disabled:opacity-50 disabled:cursor-wait"
            >
              {loadingHistory ? t('common.loading') : t('supChat.loadOlder')}
            </button>
          </div>
        )}
        {renderItems.length === 0 && (
          <p className="text-xs text-zinc-500 italic">
            {t('supChat.empty')}
          </p>
        )}
        {renderItems.map((item, idx) => {
          if (item.kind === 'entry') {
            return (
              <Bubble
                key={`${item.entry.ts}-${idx}`}
                entry={item.entry}
                streaming={
                  item.entry.type === 'sup-message' && item.entry.ts === streamingTs
                }
                onSelectTool={onSelectTool}
              />
            );
          }
          // tool-cluster
          return (
            <ToolClusterStrip
              key={`cluster-${item.entries[0]!.ts}-${idx}`}
              entries={item.entries}
              onSelectTool={onSelectTool}
            />
          );
        })}
      </div>
      {!isAtBottom && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-24 right-4 z-20 rounded-full bg-cyan-600 hover:bg-cyan-500 text-white p-2 shadow-lg shadow-black/40 transition-transform hover:scale-105"
          aria-label={t('supChat.scrollToBottom')}
          title={t('supChat.scrollToBottom')}
        >
          <ArrowDown size={14} />
        </button>
      )}
      <AgentStatus status={status} variant="sup" />
      <InputBar
        variant="sup"
        busy={busy}
        hasPendingQuestion={hasPendingQuestion}
        hasPendingApproval={hasPendingApproval}
        onSubmit={onSubmit}
        initialValue={initialInput}
      />
    </div>
  );
}

function Bubble({
  entry,
  streaming = false,
  onSelectTool,
}: {
  entry: ChatLogEntry;
  streaming?: boolean;
  onSelectTool?: (toolUseId: string) => void;
}) {
  const { t } = useTranslation();
  // Full-width message rows. Solid teal/navy backgrounds (per operator's
  // request) with no border — high contrast, clear sender separation.
  // Header strip carries the role label on the left + a copy button on
  // the right; copying yanks the raw text, not the rendered markdown.
  if (entry.type === 'user-message') {
    return (
      <MessageBlock
        label={t('supChat.you')}
        labelColor="text-cyan-100"
        bgColor="#00434e"
        copyText={entry.text}
      >
        <p className="whitespace-pre-wrap bubble-text text-cyan-50">{entry.text}</p>
      </MessageBlock>
    );
  }
  if (entry.type === 'sup-message') {
    return (
      <MessageBlock
        label={t('supChat.supervisor')}
        labelColor="text-blue-100"
        bgColor="#192640"
        copyText={entry.text}
      >
        <BubbleMarkdown streaming={streaming}>{entry.text}</BubbleMarkdown>
      </MessageBlock>
    );
  }
  if (entry.type === 'phase-doc-written') {
    // Render in the same strip family as tool calls (file-op palette)
    // so the visual rhythm of agent-actions stays consistent.
    return (
      <ToolStrip
        family="filesystem"
        name="write_phase_doc"
        detail={`docs/phases/${entry.filename}`}
        onClick={null}
      />
    );
  }
  if (entry.type === 'sup-thinking') {
    return <ThinkingBubble text={entry.text} />;
  }
  if (entry.type === 'sup-tool-call') {
    return (
      <ToolStrip
        family={getToolFamily(entry.name)}
        name={prettyToolName(entry.name)}
        detail={summariseToolInput(entry.name, entry.input)}
        onClick={onSelectTool ? () => onSelectTool(entry.toolUseId) : null}
      />
    );
  }
  // sup-tool-result is folded into the call's right-pane detail view
  // when the operator clicks the strip. We don't render it inline.
  if (entry.type === 'sup-tool-result') return null;
  if (entry.type === 'verdict') {
    return <VerdictCard id={entry.id} text={entry.text} />;
  }
  return null;
}

/**
 * "Yargısal Karar" red-envelope card — supervisor's binding decision
 * declared via `<VERDICT id="N">…</VERDICT>`. Renders prominently in
 * the sup chat (and future AgentsRoom feed); the orchestrator also
 * broadcasts the text into every active specialist's inbox so the
 * agents pick it up on their next turn.
 */
function VerdictCard({ id, text }: { id: number; text: string }) {
  const { t } = useTranslation();
  return (
    <div className="w-full rounded border-l-4 border-red-500 border-r border-y border-red-700/50 bg-red-950/30 px-3 py-2">
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-[10px] uppercase tracking-widest font-bold text-red-300">
          {t('supChat.verdict')}
        </span>
        <span className="text-[10px] text-red-400 font-mono tabular-nums">
          #{id.toString().padStart(3, '0')}
        </span>
      </div>
      <p className="text-[12px] leading-snug whitespace-pre-wrap text-red-50 font-mono">
        {text}
      </p>
    </div>
  );
}

/**
 * Shared layout for sup pane messages — solid background, header bar
 * (sender label on the left, copy button on the right), body underneath.
 * Background is supplied as a literal hex via inline style because the
 * exact tones (`#192640` for sup, `#00434e` for user) are operator-tuned
 * and outside Tailwind's palette.
 */
function MessageBlock({
  label,
  labelColor,
  bgColor,
  copyText,
  children,
}: {
  label: string;
  labelColor: string;
  bgColor: string;
  copyText: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (insecure context, denied permission) — silent */
    }
  };
  return (
    <div className="w-full rounded overflow-hidden" style={{ backgroundColor: bgColor }}>
      <div className="flex items-center justify-between px-3 py-1 border-b border-white/5">
        <span
          className={`text-[10px] uppercase tracking-widest font-bold ${labelColor}`}
        >
          {label}
        </span>
        <button
          onClick={handleCopy}
          className="text-zinc-300 hover:text-white p-1 -m-1 rounded transition-colors"
          aria-label={t('supChat.copy.ariaLabel')}
          title={copied ? t('common.copied') : t('supChat.copy.title')}
        >
          {copied ? <Check size={11} className="text-emerald-300" /> : <Copy size={11} />}
        </button>
      </div>
      <div className="px-3 py-2">{children}</div>
    </div>
  );
}

/**
 * Reasoning bubble — same shape as the dev timeline's, sup-side. Default
 * collapsed; expand to read the model's full chain of thought.
 */
function ThinkingBubble({ text }: { text: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const firstLine = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  const preview = firstLine.length > 90 ? `${firstLine.slice(0, 87)}…` : firstLine;
  const lineCount = text.split('\n').filter((l) => l.trim().length > 0).length;
  return (
    <div className="rounded-md border border-violet-900/50 bg-violet-950/20 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-2 py-1 hover:bg-violet-950/40 transition-colors text-left"
      >
        <Brain size={11} className="shrink-0 text-violet-400" />
        <span className="text-[10px] uppercase tracking-widest font-semibold text-violet-300">
          {t('supChat.thinking')}
        </span>
        <span className="text-[10px] text-violet-500 tabular-nums">
          {t('supChat.thinking.lineCount', { count: lineCount })}
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

/**
 * Compact single-line representation of a supervisor tool call. Sup tools
 * are typically read-only / orchestration (Read, Bash sanity check,
 * ask_user, write_phase_doc, ScheduleWakeup) and shouldn't dominate the
 * chat — show enough to recognise what it did.
 */
/* ───────────────── Tool call strips ─────────────────
 *
 * Tool calls (and the equivalent `phase-doc-written` event) render as
 * thin solid-bordered strips in the chat. Each tool's family drives
 * the left-border + icon color so the operator can scan "what kind of
 * action sup just took" at a glance:
 *
 *   - filesystem (Read/Edit/Write/MultiEdit/write_phase_doc) → orange
 *   - search (Grep/Glob/ToolSearch)                          → cyan
 *   - bash                                                    → amber
 *   - mcp (mcp__selfclaude__*, propose_*, register_*, …)     → violet
 *   - schedule (ScheduleWakeup/CronCreate/CronDelete)        → rose
 *   - other                                                   → zinc
 *
 * Consecutive sup-tool-calls with the same `name` (e.g. 5 Reads in a
 * row while sup browses the codebase) collapse into a single
 * `<ToolClusterStrip>` — header shows count, expand toggles individual
 * detail rows. Each row is clickable to open the right-pane Tool
 * Detail view (full input + result).
 */

type ToolFamily = 'filesystem' | 'search' | 'bash' | 'mcp' | 'schedule' | 'other';

const TOOL_FAMILY_THEME: Record<
  ToolFamily,
  { border: string; bg: string; icon: string; text: string; Icon: typeof Wrench }
> = {
  filesystem: {
    border: 'border-l-orange-500/70',
    bg: 'hover:bg-orange-950/15',
    icon: 'text-orange-400',
    text: 'text-orange-200',
    Icon: FileText,
  },
  search: {
    border: 'border-l-cyan-500/70',
    bg: 'hover:bg-cyan-950/15',
    icon: 'text-cyan-400',
    text: 'text-cyan-200',
    Icon: Search,
  },
  bash: {
    border: 'border-l-amber-500/70',
    bg: 'hover:bg-amber-950/15',
    icon: 'text-amber-400',
    text: 'text-amber-200',
    Icon: Terminal,
  },
  mcp: {
    border: 'border-l-violet-500/70',
    bg: 'hover:bg-violet-950/15',
    icon: 'text-violet-400',
    text: 'text-violet-200',
    Icon: Sparkles,
  },
  schedule: {
    border: 'border-l-rose-500/70',
    bg: 'hover:bg-rose-950/15',
    icon: 'text-rose-400',
    text: 'text-rose-200',
    Icon: Timer,
  },
  other: {
    border: 'border-l-zinc-600/70',
    bg: 'hover:bg-bg-elevated/40',
    icon: 'text-zinc-400',
    text: 'text-zinc-200',
    Icon: Wrench,
  },
};

function getToolFamily(name: string): ToolFamily {
  if (
    name === 'Read' ||
    name === 'Edit' ||
    name === 'Write' ||
    name === 'MultiEdit' ||
    name === 'write_phase_doc' ||
    name.startsWith('mcp__selfclaude__write_phase_doc')
  ) {
    return 'filesystem';
  }
  if (name === 'Grep' || name === 'Glob' || name === 'ToolSearch') return 'search';
  if (name === 'Bash') return 'bash';
  if (
    name === 'ScheduleWakeup' ||
    name === 'CronCreate' ||
    name === 'CronDelete' ||
    name === 'CronList'
  ) {
    return 'schedule';
  }
  if (
    name.startsWith('mcp__') ||
    name === 'ask_user' ||
    name === 'request_user_approval' ||
    name === 'register_phase_items' ||
    name === 'propose_item_done' ||
    name === 'confirm_item_done' ||
    name === 'reject_item_done' ||
    name === 'apply_agent_dna' ||
    name === 'propose_script'
  ) {
    return 'mcp';
  }
  return 'other';
}

/** Strip the `mcp__selfclaude__` prefix for display — operator-friendly. */
function prettyToolName(name: string): string {
  return name.replace(/^mcp__[^_]+__/, '');
}

function summariseToolInput(name: string, input: Record<string, unknown>): string {
  const stripped = prettyToolName(name);
  if (name === 'Bash') return String(input.command ?? '');
  if (
    name === 'Read' ||
    name === 'Edit' ||
    name === 'Write' ||
    name === 'MultiEdit'
  ) {
    return String(input.file_path ?? '');
  }
  if (name === 'Grep' || name === 'Glob') return String(input.pattern ?? '');
  if (name === 'ScheduleWakeup') {
    const delay = input.delaySeconds ?? '?';
    const reason = String(input.reason ?? '').slice(0, 60);
    return `+${delay}s · ${reason}`;
  }
  if (stripped === 'write_phase_doc') return String(input.filename ?? '');
  if (stripped === 'ask_user') return String(input.question ?? '').slice(0, 100);
  if (stripped === 'request_user_approval') return String(input.action ?? '');
  if (stripped === 'register_phase_items') {
    const slug = String(input.slug ?? '');
    const n = Array.isArray(input.items) ? input.items.length : 0;
    return `${slug} · ${n} items`;
  }
  if (
    stripped === 'propose_item_done' ||
    stripped === 'confirm_item_done' ||
    stripped === 'reject_item_done'
  ) {
    return `${input.slug ?? ''}/${input.itemId ?? ''}`;
  }
  if (stripped === 'apply_agent_dna') return String(input.dnaSlug ?? '');
  if (stripped === 'propose_script') return String(input.slug ?? '');
  if (stripped === 'ToolSearch') return String(input.query ?? '');
  // Fallback: take the first stringy field.
  for (const v of Object.values(input)) {
    if (typeof v === 'string') return v.slice(0, 80);
  }
  return '';
}

/**
 * Single tool call row. Solid 2px left border (family-coloured) + tiny
 * icon + name + truncated detail. Click → onClick (open right-pane
 * detail). Pass `onClick: null` for non-clickable cases (e.g.
 * phase-doc-written which has no toolUseId to dereference).
 */
function ToolStrip({
  family,
  name,
  detail,
  onClick,
}: {
  family: ToolFamily;
  name: string;
  detail: string;
  onClick: (() => void) | null;
}) {
  const theme = TOOL_FAMILY_THEME[family];
  const Icon = theme.Icon;
  const interactive = onClick !== null;
  return (
    <button
      type="button"
      onClick={onClick ?? undefined}
      disabled={!interactive}
      className={cn(
        'w-full flex items-center gap-2 pl-2 pr-2.5 py-1 rounded-r border-l-2 text-left text-[11px] font-mono',
        theme.border,
        interactive && theme.bg,
        interactive ? 'cursor-pointer' : 'cursor-default',
        'group transition-colors',
      )}
    >
      <Icon size={11} className={cn('shrink-0', theme.icon)} />
      <span className={cn('shrink-0 font-semibold', theme.text)}>{name}</span>
      {detail && (
        <span className="flex-1 min-w-0 truncate text-zinc-500" title={detail}>
          {detail}
        </span>
      )}
      {interactive && (
        <ChevronRight
          size={11}
          className="shrink-0 text-zinc-600 group-hover:text-zinc-300"
        />
      )}
    </button>
  );
}

/**
 * Stacked group of consecutive sup-tool-calls with the same name. The
 * collapsed header shows `READ × 5` + the most-recent detail; clicking
 * the chevron expands the rest as individual ToolStrip rows the
 * operator can pick from.
 */
function ToolClusterStrip({
  entries,
  onSelectTool,
}: {
  entries: Array<Extract<ChatLogEntry, { type: 'sup-tool-call' }>>;
  onSelectTool: (toolUseId: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const first = entries[0]!;
  const family = getToolFamily(first.name);
  const theme = TOOL_FAMILY_THEME[family];
  const Icon = theme.Icon;
  const prettyName = prettyToolName(first.name);
  const lastDetail = summariseToolInput(
    first.name,
    entries[entries.length - 1]!.input,
  );
  return (
    <div className={cn('rounded-r border-l-2', theme.border)}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          'w-full flex items-center gap-2 pl-2 pr-2.5 py-1 text-left text-[11px] font-mono',
          theme.bg,
          'group transition-colors',
        )}
      >
        {open ? (
          <ChevronDown size={11} className="shrink-0 text-zinc-500" />
        ) : (
          <ChevronRight size={11} className="shrink-0 text-zinc-500" />
        )}
        <Icon size={11} className={cn('shrink-0', theme.icon)} />
        <span className={cn('shrink-0 font-semibold', theme.text)}>
          {prettyName}
        </span>
        <span
          className={cn(
            'shrink-0 text-[9px] uppercase tracking-widest tabular-nums',
            theme.text,
            'opacity-70',
          )}
        >
          × {entries.length}
        </span>
        {!open && (
          <span
            className="flex-1 min-w-0 truncate text-zinc-500 italic"
            title={lastDetail}
          >
            …{lastDetail || t('supChat.consecutiveCalls', { count: entries.length })}
          </span>
        )}
      </button>
      {open && (
        <div className="pl-1 pb-1 space-y-0.5">
          {entries.map((e, i) => (
            <button
              key={`${e.ts}-${i}`}
              type="button"
              onClick={() => onSelectTool(e.toolUseId)}
              className={cn(
                'w-full flex items-center gap-2 pl-3 pr-2 py-0.5 rounded text-left text-[10px] font-mono',
                theme.bg,
                'cursor-pointer group',
              )}
            >
              <span className="shrink-0 text-zinc-600 tabular-nums w-4 text-right">
                {i + 1}
              </span>
              <span
                className="flex-1 min-w-0 truncate text-zinc-300"
                title={summariseToolInput(e.name, e.input)}
              >
                {summariseToolInput(e.name, e.input) || '—'}
              </span>
              <ChevronRight
                size={10}
                className="shrink-0 text-zinc-600 group-hover:text-zinc-300"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────── Render-list builder ─────────────────
 *
 * Walks the filtered chat log and emits a render list with two kinds:
 *
 *   - `entry`   — a single chat-log entry (user msg, sup msg, thinking,
 *                  phase-doc-written, verdict, lone tool call).
 *   - `cluster` — 2+ consecutive sup-tool-call entries with the same
 *                  `name`. Renders as a stacked strip.
 *
 * Tool-results are skipped (they're folded into the right pane on
 * click). The `iteration-end` entry is dropped — no UI for it today.
 */
type SupRenderItem =
  | { kind: 'entry'; entry: ChatLogEntry }
  | {
      kind: 'cluster';
      entries: Array<Extract<ChatLogEntry, { type: 'sup-tool-call' }>>;
    };

function buildSupRenderList(chatLog: ChatLogEntry[]): SupRenderItem[] {
  const out: SupRenderItem[] = [];
  const filtered = chatLog.filter(
    (e) =>
      e.type === 'user-message' ||
      e.type === 'sup-message' ||
      e.type === 'sup-thinking' ||
      e.type === 'phase-doc-written' ||
      e.type === 'sup-tool-call' ||
      e.type === 'verdict',
  );
  let i = 0;
  while (i < filtered.length) {
    const entry = filtered[i]!;
    if (entry.type === 'sup-tool-call') {
      // Greedy cluster: while the next entry is also a sup-tool-call
      // with the SAME `name`, fold it in.
      const cluster: Array<Extract<ChatLogEntry, { type: 'sup-tool-call' }>> = [
        entry,
      ];
      let j = i + 1;
      while (j < filtered.length) {
        const next = filtered[j]!;
        if (next.type !== 'sup-tool-call') break;
        if (next.name !== entry.name) break;
        cluster.push(next);
        j += 1;
      }
      if (cluster.length >= 2) {
        out.push({ kind: 'cluster', entries: cluster });
      } else {
        out.push({ kind: 'entry', entry });
      }
      i = j;
      continue;
    }
    out.push({ kind: 'entry', entry });
    i += 1;
  }
  return out;
}

