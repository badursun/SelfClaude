'use client';

import { useEffect, useState } from 'react';
import {
  FileCode,
  FilePlus,
  FileText,
  FolderSearch,
  Globe,
  Sparkles,
  ListChecks,
  Search,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useTranslation } from '../lib/i18n';

interface ToolStyle {
  icon: LucideIcon;
  iconColor: string;
  nameColor: string;
  borderL: string;
  bg: string;
}

const TOOL_STYLES: Record<string, ToolStyle> = {
  Bash: {
    icon: Terminal,
    iconColor: 'text-blue-400',
    nameColor: 'text-blue-300',
    borderL: 'border-l-blue-500',
    bg: 'bg-blue-950/15 hover:bg-blue-950/25',
  },
  Write: {
    icon: FilePlus,
    iconColor: 'text-purple-400',
    nameColor: 'text-purple-300',
    borderL: 'border-l-purple-500',
    bg: 'bg-purple-950/15 hover:bg-purple-950/25',
  },
  Edit: {
    icon: FileCode,
    iconColor: 'text-orange-400',
    nameColor: 'text-orange-300',
    borderL: 'border-l-orange-500',
    bg: 'bg-orange-950/15 hover:bg-orange-950/25',
  },
  Read: {
    icon: FileText,
    iconColor: 'text-cyan-400',
    nameColor: 'text-cyan-300',
    borderL: 'border-l-cyan-500',
    bg: 'bg-cyan-950/15 hover:bg-cyan-950/25',
  },
  Grep: {
    icon: Search,
    iconColor: 'text-emerald-400',
    nameColor: 'text-emerald-300',
    borderL: 'border-l-emerald-500',
    bg: 'bg-emerald-950/15 hover:bg-emerald-950/25',
  },
  Glob: {
    icon: FolderSearch,
    iconColor: 'text-violet-400',
    nameColor: 'text-violet-300',
    borderL: 'border-l-violet-500',
    bg: 'bg-violet-950/15 hover:bg-violet-950/25',
  },
  TodoWrite: {
    icon: ListChecks,
    iconColor: 'text-yellow-400',
    nameColor: 'text-yellow-300',
    borderL: 'border-l-yellow-500',
    bg: 'bg-yellow-950/15 hover:bg-yellow-950/25',
  },
  WebFetch: {
    icon: Globe,
    iconColor: 'text-pink-400',
    nameColor: 'text-pink-300',
    borderL: 'border-l-pink-500',
    bg: 'bg-pink-950/15 hover:bg-pink-950/25',
  },
  WebSearch: {
    icon: Globe,
    iconColor: 'text-pink-400',
    nameColor: 'text-pink-300',
    borderL: 'border-l-pink-500',
    bg: 'bg-pink-950/15 hover:bg-pink-950/25',
  },
  Task: {
    icon: Sparkles,
    iconColor: 'text-indigo-400',
    nameColor: 'text-indigo-300',
    borderL: 'border-l-indigo-500',
    bg: 'bg-indigo-950/15 hover:bg-indigo-950/25',
  },
};

const DEFAULT_STYLE: ToolStyle = {
  icon: Wrench,
  iconColor: 'text-zinc-400',
  nameColor: 'text-zinc-300',
  borderL: 'border-l-zinc-600',
  bg: 'bg-bg-panel hover:bg-bg-elevated',
};

function styleFor(name: string): ToolStyle {
  return TOOL_STYLES[name] ?? DEFAULT_STYLE;
}

function firstLine(s: string | undefined): string {
  if (!s) return '';
  const i = s.indexOf('\n');
  const line = (i === -1 ? s : s.slice(0, i)).trim();
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

export function ToolCard({
  name,
  summary,
  result,
  isError,
  selected,
  startedAt,
  onClick,
}: {
  name: string;
  summary: string;
  result?: string;
  isError?: boolean;
  selected: boolean;
  /**
   * Wall-clock ms-since-epoch when the tool call was dispatched. Used to
   * tick an elapsed-time indicator while the call is in flight (no
   * `result` yet). Optional for legacy callers; if absent we fall back
   * to a static "running…" label.
   */
  startedAt?: number;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const style = styleFor(name);
  const Icon = style.icon;
  const resultLine = firstLine(result);
  const inFlight = result === undefined;

  // Live elapsed counter — re-renders every 500 ms while the tool is
  // still running. Stops as soon as a result lands so we don't keep a
  // dead timer alive for completed cards.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!inFlight) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [inFlight]);

  const elapsedMs = startedAt && inFlight ? Math.max(0, now - startedAt) : 0;

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left rounded-md border border-border/40 border-l-2 px-2 py-1 transition-colors',
        'flex flex-col gap-0.5 relative overflow-hidden',
        style.borderL,
        style.bg,
        selected && 'ring-1 ring-cyan-500/60 border-l-cyan-400',
      )}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <Icon size={11} className={cn('shrink-0', style.iconColor)} />
        <span
          className={cn(
            'shrink-0 font-bold uppercase tracking-wide text-[10px]',
            style.nameColor,
          )}
        >
          {name}
        </span>
        <code className="truncate text-zinc-300 text-[11px] leading-[15px] font-mono flex-1">
          {summary}
        </code>
        {inFlight && startedAt && (
          <span
            className={cn(
              'shrink-0 tabular-nums text-[10px] font-mono ml-1',
              style.iconColor,
            )}
            title={t('toolCard.elapsed.title')}
          >
            {formatElapsed(elapsedMs)}
          </span>
        )}
      </div>
      {!inFlight && (
        <div
          className={cn(
            'flex items-start gap-1 pl-4 text-[11px] leading-[15px] font-mono truncate',
            isError ? 'text-red-400' : 'text-emerald-400',
          )}
        >
          <span className="shrink-0">{isError ? '✗' : '✓'}</span>
          <span className="truncate">{resultLine || (isError ? t('toolCard.error') : t('toolCard.ok'))}</span>
        </div>
      )}
      {inFlight && (
        <>
          <div className="pl-4 text-[10px] text-zinc-500 italic flex items-center gap-2">
            <span className="typing-dots">
              <span />
              <span />
              <span />
            </span>
            <span>{t('toolCard.running')}</span>
          </div>
          {/* Indeterminate progress strip: a 33%-wide sliver shimmies
              left-to-right under the card while we wait on the tool result.
              Width-only animation so it doesn't disturb scroll position. */}
          <div className="absolute bottom-0 left-0 right-0 h-[2px] overflow-hidden">
            <div className={cn('h-full w-1/3 progress-shimmer', style.iconColor.replace('text-', 'bg-'))} />
          </div>
        </>
      )}
    </button>
  );
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}
