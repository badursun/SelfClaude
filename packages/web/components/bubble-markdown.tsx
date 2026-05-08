'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { ChevronRight, Compass } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useTranslation } from '@/lib/i18n';
import { CodeBlock } from './code-block';

/**
 * Render a markdown string inside a chat bubble.
 *
 * Two extras on top of plain markdown:
 *
 * 1. `<TASK_FOR_DEVELOPER>...</TASK_FOR_DEVELOPER>` blocks render as
 *    collapsible cards, default collapsed — the operator scans the sup
 *    chat for "what was delegated" without drowning in the full task body.
 *    A still-streaming open tag (no matching close yet) renders as an
 *    "in-flight" badge with a typing indicator so it's clear the model is
 *    mid-write rather than hung.
 *
 * 2. `streaming` appends a blinking caret to the tail of the bubble.
 */
export function BubbleMarkdown({
  children,
  streaming = false,
}: {
  children: string;
  streaming?: boolean;
}) {
  const segments = splitTaskBlocks(children);
  const lastIdx = segments.length - 1;

  return (
    <div className="bubble-md">
      {segments.map((seg, i) => {
        if (seg.kind === 'text') {
          return (
            <ReactMarkdown
              key={i}
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={{
                a: ({ href, children, ...props }) => (
                  <SmartLink href={href}>{children}</SmartLink>
                ),
                pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
              }}
            >
              {seg.text}
            </ReactMarkdown>
          );
        }
        if (seg.kind === 'task') {
          return <TaskBlock key={i} body={seg.body} agent={seg.agent} />;
        }
        if (seg.kind === 'task-pending') {
          return <TaskBlockPending key={i} body={seg.body} agent={seg.agent} />;
        }
        // 'lifecycle' — SUMMON / DISMISS tag.
        return <LifecyclePill key={i} event={seg.event} agent={seg.agent} />;
      })}
      {streaming && segments[lastIdx]?.kind !== 'task-pending' && (
        <span className="streaming-cursor" />
      )}
    </div>
  );
}

type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'task'; body: string; agent: string }
  | { kind: 'task-pending'; body: string; agent: string }
  | { kind: 'lifecycle'; event: 'summon' | 'dismiss'; agent: string };

/**
 * Anchor renderer that intercepts project-relative links (`docs/...`,
 * `reports/...`, `.selfclaude/...`, plain relative `.md` paths, etc.)
 * and opens them in the in-app FilePreviewModal instead of navigating.
 *
 * The dispatch goes through a `window` CustomEvent so the consumer
 * (page-level `useEffect`) doesn't need to thread props down through
 * deeply nested markdown — keeps this component standalone.
 */
function SmartLink({
  href,
  children,
}: {
  href: string | undefined;
  children: React.ReactNode;
}) {
  const isExternal =
    !!href &&
    /^(?:https?:|mailto:|tel:|sms:|file:|#)/i.test(href.trim());
  const looksLikeProjectPath =
    !!href &&
    !isExternal &&
    !href.startsWith('/') &&
    !href.includes('://');

  if (isExternal || !looksLikeProjectPath) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        window.dispatchEvent(
          new CustomEvent('selfclaude:open-file', {
            detail: { path: href! },
          }),
        );
      }}
      className="cursor-pointer"
    >
      {children}
    </a>
  );
}

/**
 * Open tag matcher accepting optional `agent="..."` attribute. The
 * regex captures the agent name (group 1) so the renderer can colour
 * the card and label it `task → ui-dev`. Anchored at `<TASK_FOR_DEVELOPER`
 * so plain `<TASK_FOR_DEVELOPER>` (no attribute) still matches with the
 * agent slot empty.
 */
const TASK_OPEN_RE = /<TASK_FOR_DEVELOPER(?:\s+agent\s*=\s*"([\w-]+)")?\s*>/g;
const CLOSE = '</TASK_FOR_DEVELOPER>';

/** Lifecycle (summon / dismiss) self-closing tag matcher. */
const LIFECYCLE_RE = /<(SUMMON|DISMISS)\s+agent\s*=\s*"([\w-]+)"\s*\/?>(?:\s*<\/(?:SUMMON|DISMISS)>)?/g;

/**
 * Walk the source text and split it into ordered segments. Plain text
 * between task blocks becomes `text`; balanced TASK_FOR_DEVELOPER blocks
 * become `task`; an open tag without a matching close (the model is still
 * generating the body) becomes `task-pending` and consumes everything to
 * end-of-string.
 *
 * We deliberately ignore TASK_FOR_DEVELOPER occurrences that fall inside
 * a markdown code span / fenced block — when the supervisor writes
 * something like "the `<TASK_FOR_DEVELOPER>` mechanism is..." (talking
 * *about* the syntax in prose) we don't want to render that quoted
 * literal as a real task card.
 */
function splitTaskBlocks(src: string): Segment[] {
  const protectedRanges = findProtectedRanges(src);

  // First pass: find every `<TASK_FOR_DEVELOPER ...>` open and every
  // `<SUMMON ...>` / `<DISMISS ...>` outside protected ranges, with their
  // exact char offsets. Sort by start offset so we can walk linearly.
  interface Match {
    start: number;
    end: number;
    kind: 'task-open' | 'lifecycle';
    agent: string;
    event?: 'summon' | 'dismiss';
  }
  const matches: Match[] = [];

  TASK_OPEN_RE.lastIndex = 0;
  for (let m = TASK_OPEN_RE.exec(src); m; m = TASK_OPEN_RE.exec(src)) {
    if (isInside(m.index, protectedRanges)) continue;
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      kind: 'task-open',
      agent: m[1] ?? 'developer',
    });
  }
  LIFECYCLE_RE.lastIndex = 0;
  for (let m = LIFECYCLE_RE.exec(src); m; m = LIFECYCLE_RE.exec(src)) {
    if (isInside(m.index, protectedRanges)) continue;
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      kind: 'lifecycle',
      agent: m[2] ?? 'unknown',
      event: m[1]?.toLowerCase() === 'summon' ? 'summon' : 'dismiss',
    });
  }
  matches.sort((a, b) => a.start - b.start);

  const out: Segment[] = [];
  let i = 0;
  for (const match of matches) {
    if (match.start < i) continue; // overlap with a previously consumed task block
    if (match.start > i) {
      out.push({ kind: 'text', text: src.slice(i, match.start) });
    }
    if (match.kind === 'lifecycle') {
      out.push({
        kind: 'lifecycle',
        event: match.event!,
        agent: match.agent,
      });
      i = match.end;
      continue;
    }
    // task-open: find balanced </TASK_FOR_DEVELOPER>.
    const close = findUnprotected(src, CLOSE, match.end, protectedRanges);
    if (close === -1) {
      out.push({
        kind: 'task-pending',
        body: src.slice(match.end).trim(),
        agent: match.agent,
      });
      i = src.length;
      break;
    }
    out.push({
      kind: 'task',
      body: src.slice(match.end, close).trim(),
      agent: match.agent,
    });
    i = close + CLOSE.length;
  }
  if (i < src.length) {
    out.push({ kind: 'text', text: src.slice(i) });
  }
  return out;
}

function isInside(idx: number, ranges: Range[]): boolean {
  return ranges.some((r) => idx >= r.start && idx < r.end);
}

interface Range {
  start: number;
  end: number;
}

/**
 * Pre-pass that finds every span of source we should not look inside
 * for task tags: triple-backtick fenced code blocks first, then single
 * and double-backtick inline spans that don't overlap a fence.
 *
 * The matching is deliberately permissive — a fenced block may be
 * unclosed (the model is still streaming) so we let the regex match
 * up to end-of-string for an open ``` without a close. Same trick for
 * inline backticks: a still-streaming pending span shouldn't accidentally
 * resurrect TASK_FOR_DEVELOPER detection mid-word.
 */
function findProtectedRanges(src: string): Range[] {
  const ranges: Range[] = [];
  // Triple-backtick fenced blocks. If unclosed, swallow to end-of-string.
  const fenceRe = /```[\s\S]*?(?:```|$)/g;
  for (let m = fenceRe.exec(src); m; m = fenceRe.exec(src)) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  // Inline backtick spans (one or two backticks). Skip ones inside fences.
  const inlineRe = /(``[^`\n]+(?:``|$))|(`[^`\n]+(?:`|$))/g;
  for (let m = inlineRe.exec(src); m; m = inlineRe.exec(src)) {
    const start = m.index;
    const end = start + m[0].length;
    if (ranges.some((r) => start >= r.start && end <= r.end)) continue;
    ranges.push({ start, end });
  }
  ranges.sort((a, b) => a.start - b.start);
  return ranges;
}

/**
 * Find the next occurrence of `needle` at or after `from` whose start
 * does NOT fall inside any protected range. Returns -1 if not found.
 */
function findUnprotected(src: string, needle: string, from: number, ranges: Range[]): number {
  let cursor = from;
  while (cursor <= src.length) {
    const idx = src.indexOf(needle, cursor);
    if (idx === -1) return -1;
    const inside = ranges.some((r) => idx >= r.start && idx < r.end);
    if (!inside) return idx;
    cursor = idx + 1;
  }
  return -1;
}

/** Per-target accent colour pack for task blocks and lifecycle pills. */
const AGENT_THEME: Record<
  string,
  { border: string; bg: string; bgSoft: string; text: string; textSoft: string; pill: string }
> = {
  developer: {
    border: 'border-cyan-700/50',
    bg: 'bg-cyan-950/20',
    bgSoft: 'bg-cyan-950/10',
    text: 'text-cyan-300',
    textSoft: 'text-cyan-400',
    pill: 'bg-cyan-900/40 border-cyan-700/40 text-cyan-200',
  },
  'ui-dev': {
    border: 'border-violet-700/50',
    bg: 'bg-violet-950/25',
    bgSoft: 'bg-violet-950/15',
    text: 'text-violet-300',
    textSoft: 'text-violet-400',
    pill: 'bg-violet-900/40 border-violet-700/40 text-violet-200',
  },
  security: {
    border: 'border-rose-700/50',
    bg: 'bg-rose-950/25',
    bgSoft: 'bg-rose-950/15',
    text: 'text-rose-300',
    textSoft: 'text-rose-400',
    pill: 'bg-rose-900/40 border-rose-700/40 text-rose-200',
  },
};
const FALLBACK_THEME = AGENT_THEME.developer!;

/**
 * Settled (closed) TASK_FOR_DEVELOPER block. Default collapsed: shows
 * just the first line as a one-liner summary; click to expand the full
 * body. The header label and accent colour adapt to the target agent —
 * `task → ui-dev` (violet) for ui-dev, `task → security` (rose) for
 * audits, `task → dev` (cyan) for the default developer.
 */
function TaskBlock({ body, agent }: { body: string; agent: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const firstLine = body.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  const summary = firstLine.replace(/^#+\s*/, '').replace(/^\*\*(.+)\*\*$/, '$1');
  const theme = AGENT_THEME[agent] ?? FALLBACK_THEME;
  const label = agent === 'developer' ? 'dev' : agent;

  return (
    <div className={cn('my-1.5 rounded-md border overflow-hidden', theme.border, theme.bg)}>
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'w-full flex items-center gap-1.5 px-2 py-1 hover:opacity-90 transition-colors text-left',
        )}
      >
        <ChevronRight
          size={11}
          className={cn(
            'shrink-0 transition-transform',
            theme.textSoft,
            open && 'rotate-90',
          )}
        />
        <Compass size={11} className={cn('shrink-0', theme.textSoft)} />
        <span
          className={cn(
            'text-[10px] uppercase tracking-wider font-semibold',
            theme.text,
          )}
        >
          {t('bubbleMarkdown.task.label', { label })}
        </span>
        <span className="text-[10px] text-zinc-300 truncate font-mono italic">
          {summary || t('bubbleMarkdown.task.empty')}
        </span>
      </button>
      {open && (
        <div className={cn('px-2.5 py-1.5 border-t', theme.border, theme.bgSoft)}>
          <div className="bubble-md text-zinc-200">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={{
                pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
              }}
            >
              {body}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * In-flight (still streaming) TASK_FOR_DEVELOPER block. Shows the running
 * body with a typing indicator + "writing..." badge so the operator can
 * watch the delegation form in real time without it being indistinguishable
 * from regular sup text.
 */
function TaskBlockPending({ body, agent }: { body: string; agent: string }) {
  const { t } = useTranslation();
  const firstLine = body.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  const summary = firstLine.replace(/^#+\s*/, '').replace(/^\*\*(.+)\*\*$/, '$1');
  const theme = AGENT_THEME[agent] ?? FALLBACK_THEME;
  const label = agent === 'developer' ? 'dev' : agent;
  return (
    <div className={cn('my-1.5 rounded-md border overflow-hidden', theme.border, theme.bg)}>
      <div
        className={cn(
          'flex items-center gap-1.5 px-2 py-1 border-b',
          theme.border,
        )}
      >
        <Compass size={11} className={cn('shrink-0', theme.textSoft)} />
        <span
          className={cn(
            'text-[10px] uppercase tracking-wider font-semibold',
            theme.text,
          )}
        >
          {t('bubbleMarkdown.task.label', { label })}
        </span>
        <span className="typing-dots">
          <span />
          <span />
          <span />
        </span>
        <span className={cn('text-[10px] italic', theme.textSoft)}>{t('bubbleMarkdown.writing')}</span>
        {summary && (
          <span className="text-[10px] text-zinc-400 truncate font-mono italic ml-1">
            {summary}
          </span>
        )}
      </div>
      <div className="px-2.5 py-1.5 bubble-md text-zinc-300">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={{
            pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          }}
        >
          {body}
        </ReactMarkdown>
        <span className="streaming-cursor" />
      </div>
    </div>
  );
}

/**
 * Compact lifecycle pill — replaces raw `<SUMMON .../>` / `<DISMISS .../>`
 * tags in the supervisor's text. Inline width (not full block) so the
 * narrative around it still flows naturally.
 */
function LifecyclePill({
  event,
  agent,
}: {
  event: 'summon' | 'dismiss';
  agent: string;
}) {
  const { t } = useTranslation();
  const theme = AGENT_THEME[agent] ?? FALLBACK_THEME;
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 my-1 mr-1 rounded border text-[10px] font-mono uppercase tracking-wider font-semibold',
        theme.pill,
      )}
    >
      {event === 'summon' ? t('bubbleMarkdown.lifecycle.summon') : t('bubbleMarkdown.lifecycle.dismiss')}
      <span className="opacity-80 lowercase tracking-normal font-normal italic">
        {agent}
      </span>
    </div>
  );
}
