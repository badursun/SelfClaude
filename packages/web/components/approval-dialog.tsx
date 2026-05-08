'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ShieldCheck, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useTranslation } from '../lib/i18n';
import type { PendingApproval } from '@/lib/types';

const ALWAYS_ALLOW_KEY = (sessionId: string) => `selfclaude.alwaysAllow.${sessionId}`;

/**
 * Centred approval modal — replaces the previous bottom-anchored drawer
 * for `request_user_approval` events. Two reasons it's a modal:
 *
 *   1. Approvals are *destructive operations* (rm -rf, git push --force,
 *      drop table, etc.). The dialog interrupts the operator's flow on
 *      purpose so a wrong tab focus can't accept a destructive action.
 *
 *   2. The bottom drawer was easy to miss when the chat panes had a lot
 *      of streaming content — operators reported scrolling past it.
 *
 * **Always-Allow toggle** (operator-scoped, per-session): when checked,
 * subsequent approval requests are auto-approved on arrival without a
 * dialog. The toggle is persisted in `localStorage` keyed by session id
 * so refreshes preserve the operator's stance, and never hits the
 * server — it's purely a UI shortcut for trusted sessions where the
 * operator wants the agents to "just go."
 *
 * Safety note: Always-Allow bypasses the policy engine's curated list
 * of destructive operations. The dialog warns about this in red text.
 * The toggle stays per-session; opening a new project keeps it off by
 * default.
 */
export function ApprovalDialog({
  sessionId,
  approval,
  onDecide,
}: {
  sessionId: string;
  approval: PendingApproval | null;
  onDecide: (approvalId: string, decision: 'allow' | 'deny') => void;
}) {
  const { t } = useTranslation();
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  // Re-load the toggle on session change. We default to off — the
  // operator must explicitly opt in per session.
  useEffect(() => {
    if (!sessionId) return;
    try {
      setAlwaysAllow(localStorage.getItem(ALWAYS_ALLOW_KEY(sessionId)) === '1');
    } catch {
      setAlwaysAllow(false);
    }
  }, [sessionId]);

  // Auto-approve incoming requests when the toggle is on. Single-shot
  // per approval id (the ref tracks ones we've already auto-decided so a
  // re-render with the same approval doesn't double-fire).
  const autoDecidedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!approval) return;
    if (!alwaysAllow) return;
    if (autoDecidedRef.current.has(approval.id)) return;
    autoDecidedRef.current.add(approval.id);
    onDecide(approval.id, 'allow');
  }, [approval, alwaysAllow, onDecide]);

  // Esc cancels (deny). Operator who can't immediately answer should
  // close → that's the safe default for destructive ops.
  useEffect(() => {
    if (!approval) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDecide(approval.id, 'deny');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [approval, onDecide]);

  if (!approval) return null;
  // When always-allow is on, we've already auto-decided; don't render
  // the modal at all.
  if (alwaysAllow) return null;

  const persistAlwaysAllow = (next: boolean) => {
    setAlwaysAllow(next);
    try {
      if (next) localStorage.setItem(ALWAYS_ALLOW_KEY(sessionId), '1');
      else localStorage.removeItem(ALWAYS_ALLOW_KEY(sessionId));
    } catch {
      /* no-op — private mode / disabled storage */
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] bg-black/75 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={() => onDecide(approval.id, 'deny')}
    >
      <div
        className="bg-bg border-2 border-red-700/60 rounded-lg max-w-lg w-full overflow-hidden shadow-2xl shadow-red-950/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b-2 border-red-800/50 bg-red-950/30">
          <AlertTriangle size={18} className="text-red-400 shrink-0" />
          <h3 className="text-sm font-semibold text-red-200 flex-1">{t('approvalDialog.title')}</h3>
          <span
            className="text-[10px] uppercase tracking-widest font-bold text-red-300"
            title={t('approvalDialog.from', { role: approval.role })}
          >
            {approval.role}
          </span>
          <button
            onClick={() => onDecide(approval.id, 'deny')}
            className="text-red-300 hover:text-white p-0.5"
            aria-label={t('approvalDialog.cancelDeny')}
          >
            <X size={14} />
          </button>
        </div>
        <div className="px-4 py-3 space-y-2">
          <code className="text-xs text-zinc-100 block bg-bg-subtle border border-border rounded px-2 py-1 break-all">
            {approval.action}
          </code>
          <p className="text-xs text-zinc-300">
            <span className="text-zinc-500">{t('approvalDialog.reason')} </span>
            {approval.reason}
          </p>
          {approval.summary && (
            <p className="text-xs text-zinc-500 italic">{approval.summary}</p>
          )}
        </div>
        <div className="px-4 py-3 border-t border-border bg-bg-subtle">
          <label className="flex items-center gap-2 cursor-pointer text-[11px] text-zinc-400 hover:text-zinc-200">
            <input
              type="checkbox"
              checked={alwaysAllow}
              onChange={(e) => persistAlwaysAllow(e.target.checked)}
              className="accent-red-600"
            />
            <ShieldCheck size={12} className="text-zinc-500" />
            <span>
              {t('approvalDialog.alwaysAllow')}
              <span className="block text-[10px] text-red-400 mt-0.5">
                {t('approvalDialog.alwaysAllowWarning')}
              </span>
            </span>
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <button
            onClick={() => onDecide(approval.id, 'deny')}
            className="px-3 py-1.5 text-xs rounded border border-border hover:bg-bg-elevated text-zinc-300"
          >
            {t('common.deny')}
          </button>
          <button
            onClick={() => onDecide(approval.id, 'allow')}
            className={cn(
              'px-3 py-1.5 text-xs rounded font-semibold border',
              'bg-red-600 hover:bg-red-500 border-red-700 text-white',
            )}
            autoFocus
          >
            {t('common.allow')}
          </button>
        </div>
      </div>
    </div>
  );
}
