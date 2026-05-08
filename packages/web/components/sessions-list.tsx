'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Boxes,
  ChevronRight,
  Clock,
  Cog,
  Folder,
  Layers,
  Package,
  Pin,
  PinOff,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { api, type ProjectMetricsRollup } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { Favorite, RecentEntry, SessionMeta } from '@/lib/types';
import { useTranslation } from '../lib/i18n';

/**
 * Landing-page project lists. Three sections share a visual language
 * (premium card chrome, subtle hover lift, accent rail on the left)
 * but differ on what they emphasise:
 *
 *  - Pinned   → grid, persistent shortcuts, gold accent
 *  - Active   → list, live status pills, cyan accent
 *  - Recent   → list, openedAt timestamps, zinc accent
 *
 * `<ProjectIcon>` and `<ProjectMeta>` are the shared atoms.
 */

/* ─── Section: Active sessions ──────────────────────────────────── */

export function SessionsList({
  sessions,
  pinnedCwds,
  onTogglePin,
}: {
  sessions: SessionMeta[];
  pinnedCwds: Set<string>;
  onTogglePin: (cwd: string, label: string) => void;
}) {
  const { t } = useTranslation();
  if (sessions.length === 0) return null;
  return (
    <section className="mb-8">
      <SectionHeader
        accent="cyan"
        label={t('sessionsList.active.label')}
        count={sessions.length}
        hint={t('sessionsList.active.hint')}
      />
      <div className="space-y-1.5">
        {sessions.map((s) => (
          <ActiveCard
            key={s.id}
            session={s}
            pinned={pinnedCwds.has(s.cwd)}
            onTogglePin={() => onTogglePin(s.cwd, s.label)}
          />
        ))}
      </div>
    </section>
  );
}

function ActiveCard({
  session,
  pinned,
  onTogglePin,
}: {
  session: SessionMeta;
  pinned: boolean;
  onTogglePin: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="group relative">
      {/* Cyan accent rail on the left — appears on hover, marks the live row. */}
      <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-cyan-500/0 group-hover:bg-cyan-500/70 transition-colors rounded-l" />
      <Link
        href={`/sessions/${session.id}`}
        className="flex items-center gap-3 rounded-md border border-border bg-bg-panel/70 hover:bg-bg-elevated hover:border-cyan-700/50 p-3 pl-3.5 transition-colors"
      >
        <ProjectIcon cwd={session.cwd} variant="active" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-zinc-100 truncate">{session.label}</span>
            <PhaseChip phase={session.phase} />
            <ActivityPill sup={session.supActive} dev={session.devActive} busy={session.busy} />
          </div>
          <code className="text-[11px] font-mono text-zinc-500 truncate block mt-0.5">
            {session.cwd}
          </code>
        </div>
        <button
          onClick={(e) => {
            e.preventDefault();
            onTogglePin();
          }}
          className="p-1.5 rounded text-zinc-500 hover:text-amber-300 hover:bg-bg-elevated"
          aria-label={pinned ? t('sessionsList.unpin.ariaLabel') : t('sessionsList.pin.ariaLabel')}
          title={pinned ? t('sessionsList.unpin.title') : t('sessionsList.pin.title')}
        >
          {pinned ? (
            <Pin size={13} className="text-amber-400 fill-amber-400" />
          ) : (
            <Pin size={13} />
          )}
        </button>
        <ChevronRight size={14} className="text-zinc-600 group-hover:text-cyan-400 transition-colors" />
      </Link>
    </div>
  );
}

/* ─── Section: Pinned ───────────────────────────────────────────── */

export function PinnedList({
  favorites,
  activeCwds,
  onOpen,
  onUnpin,
}: {
  favorites: Favorite[];
  activeCwds: Set<string>;
  onOpen: (cwd: string, label: string) => void;
  onUnpin: (cwd: string) => void;
}) {
  const { t } = useTranslation();
  if (favorites.length === 0) return null;
  return (
    <section className="mb-8">
      <SectionHeader
        accent="amber"
        label={t('sessionsList.pinned.label')}
        count={favorites.length}
        hint={t('sessionsList.pinned.hint')}
        icon={<Pin size={11} className="fill-amber-400 text-amber-400" />}
      />
      <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {favorites.map((fav) => {
          const isActive = activeCwds.has(fav.cwd);
          return (
            <PinnedCard
              key={fav.cwd}
              favorite={fav}
              isActive={isActive}
              onOpen={() => onOpen(fav.cwd, fav.label)}
              onUnpin={() => onUnpin(fav.cwd)}
            />
          );
        })}
      </div>
    </section>
  );
}

function PinnedCard({
  favorite,
  isActive,
  onOpen,
  onUnpin,
}: {
  favorite: Favorite;
  isActive: boolean;
  onOpen: () => void;
  onUnpin: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="group relative">
      <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-amber-500/0 group-hover:bg-amber-500/70 transition-colors rounded-l" />
      <button
        onClick={onOpen}
        className="w-full text-left flex items-start gap-2.5 rounded-md border border-border bg-bg-panel/70 hover:bg-bg-elevated hover:border-amber-700/40 p-3 pl-3.5 transition-colors"
      >
        <ProjectIcon cwd={favorite.cwd} variant="pinned" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium text-zinc-100 truncate">{favorite.label}</span>
            {isActive && (
              <span className="text-[9px] uppercase tracking-wider font-mono text-emerald-300 bg-emerald-950/40 border border-emerald-700/30 rounded px-1 py-px">
                {t('sessionsList.pinned.liveChip')}
              </span>
            )}
          </div>
          <code className="text-[10px] font-mono text-zinc-500 truncate block">
            {favorite.cwd}
          </code>
          <ProjectMetricsRow cwd={favorite.cwd} />
        </div>
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onUnpin();
          }}
          className="shrink-0 mt-0.5 p-1 rounded text-zinc-600 hover:text-zinc-200 opacity-0 group-hover:opacity-100 transition-opacity"
          aria-label={t('sessionsList.unpin.ariaLabel')}
          title={t('sessionsList.unpin.title')}
        >
          <PinOff size={11} />
        </button>
      </button>
    </div>
  );
}

/**
 * Phase 2 telemetry — compact metrics row beneath a pinned card. Shows
 * RAW counters (turns / files / first-pass rate) primary, and an
 * explicitly-labelled "Estimate (Nx baseline)" chip secondary. Per
 * ROADMAP calibration #2: the estimate is *not* the headline number.
 * Operators see actuals first; the estimate is a derived comparison
 * with the baseline ratio surfaced in the tooltip so it can never
 * masquerade as a measured value.
 *
 * Hidden entirely when a project has no metrics yet (fresh pin, never
 * opened) — no point showing zeroes.
 */
function ProjectMetricsRow({ cwd }: { cwd: string }) {
  const { t } = useTranslation();
  const [rollup, setRollup] = useState<ProjectMetricsRollup | null>(null);
  const [baseline, setBaseline] = useState<number>(() => readBaselineRatio());
  useEffect(() => {
    let cancelled = false;
    api
      .getProjectMetrics(cwd)
      .then((r) => {
        if (!cancelled) setRollup(r);
      })
      .catch(() => {
        if (!cancelled) setRollup(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);
  // Re-read baseline when the operator changes it from settings — the
  // change-event fires from BaselineRatioControl below.
  useEffect(() => {
    const onStorage = () => setBaseline(readBaselineRatio());
    window.addEventListener('selfclaude:baseline-changed', onStorage);
    return () => window.removeEventListener('selfclaude:baseline-changed', onStorage);
  }, []);

  if (!rollup) return null;
  const totalTurns = rollup.totalTurns.sup + rollup.totalTurns.dev;
  if (totalTurns === 0 && rollup.filesTouched === 0) return null;

  const c = rollup.phaseContract;
  const passPct = c.distinctFilenames > 0 ? Math.round(c.firstPassRate * 100) : null;
  const passColor =
    passPct === null
      ? 'text-zinc-500'
      : passPct >= 80
        ? 'text-emerald-300'
        : passPct >= 50
          ? 'text-amber-300'
          : 'text-rose-300';

  // Derived estimate. With baseline=1 the operator turned the panel
  // off — show only raw counters. Otherwise estimateMin is the
  // additional time (over wall-clock) the manual baseline would have
  // implied.
  const showEstimate = baseline > 1 && rollup.activeDurationMs > 0;
  const baselineMs = rollup.activeDurationMs * (baseline - 1);
  const estimateMin = Math.round(baselineMs / 60_000);

  return (
    <div className="flex items-center gap-2 mt-1.5 text-[10px] font-mono">
      <span className="text-zinc-400 tabular-nums" title={t('sessionsList.metrics.turns.tooltip')}>
        {t('sessionsList.metrics.turns', { count: totalTurns })}
      </span>
      <span className="text-zinc-600">·</span>
      <span className="text-zinc-400 tabular-nums" title={t('sessionsList.metrics.files.tooltip')}>
        {t('sessionsList.metrics.files', { count: rollup.filesTouched })}
      </span>
      {passPct !== null && (
        <>
          <span className="text-zinc-600">·</span>
          <span
            className={cn('tabular-nums', passColor)}
            title={
              t('sessionsList.metrics.firstPass.tooltip', {
                distinctFilenames: c.distinctFilenames,
                docSuffix: c.distinctFilenames === 1 ? '' : 's',
                totalAttempts: c.totalAttempts,
                overrides: c.overrides,
              })
            }
          >
            {t('sessionsList.metrics.firstPass', { pct: passPct })}
          </span>
        </>
      )}
      {showEstimate && (
        <span
          className="ml-auto px-1.5 py-px rounded border border-amber-900/40 bg-amber-950/20 text-amber-200/70 tabular-nums"
          title={
            t('sessionsList.metrics.estimate.tooltip', {
              baseline,
              activeDuration: formatDurationMin(rollup.activeDurationMs),
              totalDuration: formatDurationMin(rollup.activeDurationMs * baseline),
              saved: formatDurationMin(baselineMs),
            })
          }
        >
          {t('sessionsList.metrics.estimated', { amount: formatEstimate(estimateMin) })}
          <span className="ml-1 text-[9px] opacity-60 uppercase tracking-wider">
            {baseline}×
          </span>
        </span>
      )}
    </div>
  );
}

const BASELINE_KEY = 'selfclaude:baseline-ratio';

function readBaselineRatio(): number {
  if (typeof window === 'undefined') return 3;
  const raw = window.localStorage.getItem(BASELINE_KEY);
  if (!raw) return 3;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 1 || n > 10) return 3;
  return n;
}

function formatDurationMin(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function formatEstimate(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

/* ─── Section: Recent ───────────────────────────────────────────── */

export function RecentList({
  recents,
  activeCwds,
  pinnedCwds,
  onOpen,
  onForget,
}: {
  recents: RecentEntry[];
  activeCwds: Set<string>;
  pinnedCwds: Set<string>;
  onOpen: (cwd: string, label: string) => void;
  onForget: (cwd: string) => void;
}) {
  const { t } = useTranslation();
  // De-duplicate against active/pinned — those projects already have
  // their own dedicated cards, no point repeating them in Recent.
  const filtered = recents.filter(
    (r) => !activeCwds.has(r.cwd) && !pinnedCwds.has(r.cwd),
  );
  if (filtered.length === 0) return null;
  return (
    <section className="mb-8">
      <SectionHeader
        accent="zinc"
        label={t('sessionsList.recent.label')}
        count={filtered.length}
        hint={t('sessionsList.recent.hint')}
        icon={<Clock size={11} className="text-zinc-400" />}
      />
      <div className="space-y-1">
        {filtered.map((r) => (
          <RecentCard
            key={r.cwd}
            entry={r}
            onOpen={() => onOpen(r.cwd, r.label)}
            onForget={() => onForget(r.cwd)}
          />
        ))}
      </div>
    </section>
  );
}

function RecentCard({
  entry,
  onOpen,
  onForget,
}: {
  entry: RecentEntry;
  onOpen: () => void;
  onForget: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="group relative">
      <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-zinc-500/0 group-hover:bg-zinc-500/60 transition-colors rounded-l" />
      <button
        onClick={onOpen}
        className="w-full text-left flex items-center gap-2.5 rounded-md border border-border/60 bg-bg-panel/40 hover:bg-bg-elevated/80 hover:border-border p-2.5 pl-3 transition-colors"
      >
        <ProjectIcon cwd={entry.cwd} variant="recent" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-zinc-200 truncate">{entry.label}</div>
          <code className="text-[10px] font-mono text-zinc-500 truncate block">
            {entry.cwd}
          </code>
        </div>
        <span className="shrink-0 text-[10px] font-mono text-zinc-500 tabular-nums">
          {formatRelativeTime(entry.openedAt)}
        </span>
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onForget();
          }}
          className="shrink-0 p-1 rounded text-zinc-600 hover:text-rose-300 opacity-0 group-hover:opacity-100 transition-opacity"
          aria-label={t('sessionsList.forget.ariaLabel')}
          title={t('sessionsList.forget.title')}
        >
          <Trash2 size={11} />
        </button>
      </button>
    </div>
  );
}

/* ─── Atoms ─────────────────────────────────────────────────────── */

function SectionHeader({
  accent,
  label,
  count,
  hint,
  icon,
}: {
  accent: 'cyan' | 'amber' | 'zinc';
  label: string;
  count: number;
  hint: string;
  icon?: React.ReactNode;
}) {
  const accentClass =
    accent === 'cyan'
      ? 'text-cyan-300'
      : accent === 'amber'
        ? 'text-amber-300'
        : 'text-zinc-300';
  return (
    <div className="flex items-baseline gap-2 mb-2 px-0.5">
      <h2
        className={`text-[10px] font-mono uppercase tracking-widest font-semibold flex items-center gap-1.5 ${accentClass}`}
      >
        {icon}
        {label}
      </h2>
      <span className="text-[10px] font-mono text-zinc-600 tabular-nums">({count})</span>
      <span className="text-[10px] text-zinc-600 ml-auto italic">{hint}</span>
    </div>
  );
}

/**
 * Project-type icon — picks an icon based on lightweight cwd-name
 * heuristics (we don't read the filesystem from the client). Coloured
 * background varies per section variant so the eye can scan rows by
 * section without having to read labels.
 */
function ProjectIcon({
  cwd,
  variant,
}: {
  cwd: string;
  variant: 'active' | 'pinned' | 'recent';
}) {
  const Icon = pickIconFromCwd(cwd);
  const bg =
    variant === 'active'
      ? 'bg-cyan-950/40 border-cyan-800/30 text-cyan-300'
      : variant === 'pinned'
        ? 'bg-amber-950/40 border-amber-800/30 text-amber-300'
        : 'bg-zinc-800/60 border-zinc-700/60 text-zinc-400';
  const size = variant === 'pinned' ? 'w-7 h-7' : 'w-8 h-8';
  return (
    <div
      className={`shrink-0 ${size} rounded-md border flex items-center justify-center ${bg}`}
    >
      <Icon size={variant === 'pinned' ? 13 : 14} />
    </div>
  );
}

/** Heuristic icon picker. Pure function of cwd basename — we don't
 * probe the filesystem here (that's the wizard/folder-picker's job).
 * Names hit common stack signals; everything else falls back to Folder. */
function pickIconFromCwd(cwd: string): typeof Folder {
  const name = (cwd.split('/').filter(Boolean).pop() ?? '').toLowerCase();
  if (/(^|[-_])(api|server|backend|service)([-_]|$)/.test(name)) return Cog;
  if (/(^|[-_])(ui|web|frontend|app|client)([-_]|$)/.test(name)) return Layers;
  if (/(^|[-_])(lib|sdk|core|kit|utils?)([-_]|$)/.test(name)) return Package;
  if (/(^|[-_])(monorepo|workspace|platform|stack)([-_]|$)/.test(name)) return Boxes;
  if (/(^|[-_])(demo|sandbox|playground|experiment)([-_]|$)/.test(name)) return Sparkles;
  return Folder;
}

function PhaseChip({ phase }: { phase: string }) {
  return (
    <span className="text-[9px] uppercase tracking-wider font-mono text-zinc-400 bg-bg-subtle border border-border rounded px-1.5 py-px">
      {phase}
    </span>
  );
}

function ActivityPill({ sup, dev, busy }: { sup: boolean; dev: boolean; busy: boolean }) {
  const { t } = useTranslation();
  if (busy) {
    return (
      <span className="flex items-center gap-1 text-[10px] font-mono text-cyan-300">
        <span className="inline-block size-1.5 rounded-full bg-cyan-400 animate-pulse" />
        {t('sessionsList.activity.working')}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-500">
      <span className="flex items-center gap-0.5">
        <span className={`inline-block size-1.5 rounded-full ${sup ? 'bg-emerald-400' : 'bg-zinc-700'}`} />
        {t('sessionsList.activity.sup')}
      </span>
      <span className="flex items-center gap-0.5">
        <span className={`inline-block size-1.5 rounded-full ${dev ? 'bg-emerald-400' : 'bg-zinc-700'}`} />
        {t('sessionsList.activity.dev')}
      </span>
    </span>
  );
}

/**
 * Compact "X ago" formatter. Avoids importing date-fns; the precision
 * we want (hour-level for today, day-level for the past week, date
 * for older) is trivial to do inline.
 */
function formatRelativeTime(ts: number): string {
  const { t } = useTranslation();
  const diff = Date.now() - ts;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return t('sessionsList.relativeTime.justNow');
  const min = Math.round(sec / 60);
  if (min < 60) return t('sessionsList.relativeTime.minutesAgo', { count: min });
  const hr = Math.round(min / 60);
  if (hr < 24) return t('sessionsList.relativeTime.hoursAgo', { count: hr });
  const day = Math.round(hr / 24);
  if (day < 7) return t('sessionsList.relativeTime.daysAgo', { count: day });
  const date = new Date(ts);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
