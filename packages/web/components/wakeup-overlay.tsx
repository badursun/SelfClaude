'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlarmClock, Zap } from 'lucide-react';
import { api } from '@/lib/api';
import { useTranslation } from '../lib/i18n';
import type { ChatLogEntry } from '@/lib/types';

/**
 * Shape of an in-flight (still-pending) wakeup. The overlay only cares about
 * one row at a time — the most recent unresolved schedule for the role —
 * so this is what `findPendingWakeup` returns.
 */
export interface PendingWakeup {
  wakeupId: string;
  fireAt: number;
  reason: string;
}

/**
 * Walk the chat-log to find the role's most recent wakeup that hasn't yet
 * fired or been cancelled. Returns null if every scheduled wakeup has a
 * matching `wakeup-fired` / `wakeup-cancelled` entry.
 *
 * The order of `wakeup-scheduled` events matters because newest-wins: a new
 * schedule cancels an older one (the runner emits a `wakeup-cancelled` with
 * reason 'replaced' for the older entry).
 */
export function findPendingWakeup(
  chatLog: ChatLogEntry[],
  role: 'supervisor' | 'developer',
): PendingWakeup | null {
  let latest: PendingWakeup | null = null;
  const settled = new Set<string>();
  for (const entry of chatLog) {
    if (
      entry.type === 'wakeup-scheduled' ||
      entry.type === 'wakeup-fired' ||
      entry.type === 'wakeup-cancelled'
    ) {
      if (entry.role !== role) continue;
      if (entry.type === 'wakeup-scheduled') {
        latest = {
          wakeupId: entry.wakeupId,
          fireAt: entry.fireAt,
          reason: entry.reason,
        };
      } else {
        settled.add(entry.wakeupId);
      }
    }
  }
  if (!latest) return null;
  if (settled.has(latest.wakeupId)) return null;
  return latest;
}

/**
 * Same job, but reading from the server-derived state (which sees the
 * FULL chat-log, not just the lazy-loaded window). Prefer this when you
 * have it — `findPendingWakeup` only sees the visible page and will miss
 * wakeups scheduled in older history.
 */
export function findPendingWakeupFromDerived(
  wakeups: ReadonlyArray<{
    id: string;
    role: 'supervisor' | 'developer';
    fireAt: number;
    reason: string;
    status: 'pending' | 'fired' | 'cancelled';
  }>,
  role: 'supervisor' | 'developer',
): PendingWakeup | null {
  // Wakeups list arrives sorted by scheduledAt desc; the first pending
  // one for this role is the most-recent — that's our overlay target.
  for (const w of wakeups) {
    if (w.role !== role) continue;
    if (w.status !== 'pending') continue;
    return { wakeupId: w.id, fireAt: w.fireAt, reason: w.reason };
  }
  return null;
}

/**
 * Full-pane overlay shown when an agent has a pending wakeup but no work
 * is currently in flight. Tints the underlying pane dark, blurs it, and
 * counts down to fire time so the operator can see exactly when the agent
 * will resume itself.
 */
export function WakeupOverlay({
  wakeup,
  variant,
}: {
  wakeup: PendingWakeup;
  variant: 'supervisor' | 'developer';
}) {
  const { t } = useTranslation();
  const params = useParams<{ id: string }>();
  const sessionId = params?.id;
  const [now, setNow] = useState(() => Date.now());
  const [firing, setFiring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  /** Manually fire the wakeup (skip the timer). Sends to the backend; the
   *  resulting `wakeup-fired` SSE event tears down this overlay. */
  const handleWakeNow = async () => {
    if (!sessionId || firing) return;
    setFiring(true);
    setError(null);
    try {
      await api.triggerWakeup(sessionId, variant);
    } catch (e) {
      setError((e as Error).message);
      setFiring(false);
    }
  };

  const remainingMs = Math.max(0, wakeup.fireAt - now);
  const total = Math.floor(remainingMs / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  const fireDate = new Date(wakeup.fireAt);
  const hh = String(fireDate.getHours()).padStart(2, '0');
  const mm = String(fireDate.getMinutes()).padStart(2, '0');

  const accent = variant === 'supervisor' ? 'text-cyan-300' : 'text-rose-300';
  const accentDim = variant === 'supervisor' ? 'text-cyan-400' : 'text-rose-400';
  const label = variant === 'supervisor' ? t('wakeupOverlay.label.supervisor') : t('wakeupOverlay.label.developer');

  return (
    <div className="absolute inset-0 z-10 bg-black/70 backdrop-blur-sm flex flex-col items-center justify-center gap-3 px-6 text-center">
      <AlarmClock size={32} className={accentDim} />
      <div className="text-[10px] uppercase tracking-widest text-zinc-400">
        {label} {t('wakeupOverlay.wakeIn')}
      </div>
      <div
        className={`font-mono tabular-nums text-3xl font-semibold ${accent}`}
      >
        {h > 0 && `${h}h `}
        {(h > 0 || m > 0) && `${String(m).padStart(2, '0')}m `}
        {`${String(s).padStart(2, '0')}s`}
      </div>
      <div className="text-[10px] font-mono text-zinc-500">
        @ {hh}:{mm}
      </div>
      {wakeup.reason && (
        <div className="text-[11px] text-zinc-300 max-w-md italic leading-tight">
          {wakeup.reason}
        </div>
      )}
      <button
        onClick={handleWakeNow}
        disabled={firing}
        className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium border border-rose-700/60 bg-rose-950/40 text-rose-200 hover:bg-rose-900/60 hover:border-rose-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Zap size={12} />
        {firing ? t('wakeupOverlay.wakeNow.firing') : t('wakeupOverlay.wakeNow.idle')}
      </button>
      {error && (
        <div className="text-[10px] text-red-400 max-w-md leading-tight">{error}</div>
      )}
    </div>
  );
}
