'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, TerminalSquare, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';
import { useTranslation } from '../lib/i18n';
import type { ScriptProposal } from '@/lib/types';

/**
 * Centered alert dialog that demands attention when the supervisor
 * proposes a new Bash script. Replaces the previous corner toast
 * because the toast was easy to miss (and had a brittle "first sight"
 * detection that swallowed the first proposal). The modal is driven
 * by the `pendingProposalAlert` slot in the session store, which is
 * set deterministically by the `scripts-updated { action: 'proposed' }`
 * SSE handler — no inference, no timing race.
 *
 * Three operator paths:
 *   - **Approve** — calls `api.approveScript` directly with optional
 *     note, closes; the orchestrator wakes sup with an ack synthetic.
 *   - **Reject…** — expands an inline reason form (required), then
 *     submits via `api.rejectScript`, closes.
 *   - **Review later** — closes the dialog only. The proposal stays
 *     in the rail's pending queue so the operator can come back.
 *
 * Esc / backdrop = "Review later" (no destructive default).
 */

export function ScriptProposalToast({
  sessionId,
  proposal,
  onClose,
  onOpenPanel,
}: {
  sessionId: string;
  /** Set by the store; the modal is hidden when null. */
  proposal: ScriptProposal | null;
  /** Called to clear `pendingProposalAlert` in the store. */
  onClose: () => void;
  /** Reveal the full Scripts panel (right rail) — used by "Review in panel". */
  onOpenPanel: () => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'view' | 'reject-form'>('view');
  const [approveNotes, setApproveNotes] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [pending, setPending] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset form state every time a new proposal arrives.
  useEffect(() => {
    if (!proposal) return;
    setMode('view');
    setApproveNotes('');
    setRejectReason('');
    setPending(null);
    setError(null);
  }, [proposal?.slug]);

  // Esc dismisses; mid-pending state ignores it to prevent half-saved
  // closes during a network round-trip.
  useEffect(() => {
    if (!proposal) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && pending === null) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [proposal, pending, onClose]);

  if (!proposal) return null;

  const handleApprove = async () => {
    setPending('approve');
    setError(null);
    try {
      await api.approveScript(sessionId, proposal.slug, approveNotes.trim() || undefined);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setPending(null);
    }
  };

  const handleReject = async () => {
    if (rejectReason.trim().length === 0) {
      setError(t('scriptProposal.error.rejectRequiresReason'));
      return;
    }
    setPending('reject');
    setError(null);
    try {
      await api.rejectScript(sessionId, proposal.slug, rejectReason.trim());
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setPending(null);
    }
  };

  const handleReviewLater = () => {
    onOpenPanel();
    onClose();
  };

  return (
    <div
      role="alertdialog"
      aria-labelledby="script-proposal-title"
      className="fixed inset-0 z-[80] bg-black/75 backdrop-blur-sm flex items-center justify-center p-6 animate-[fadeIn_0.15s_ease-out]"
      onClick={(e) => {
        if (e.target === e.currentTarget && pending === null) onClose();
      }}
    >
      <div
        className="bg-bg border-2 border-amber-700/60 rounded-lg w-[min(720px,100%)] max-h-[88vh] flex flex-col overflow-hidden shadow-2xl shadow-amber-900/40"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — bold amber accent so it reads as "demands attention". */}
        <header className="px-5 py-4 border-b-2 border-amber-700/40 bg-amber-950/30 flex items-start gap-3">
          <span className="shrink-0 w-9 h-9 rounded-full bg-amber-900/50 border border-amber-700/50 flex items-center justify-center">
            <AlertTriangle size={18} className="text-amber-300" />
          </span>
          <div className="flex-1 min-w-0">
            <h2
              id="script-proposal-title"
              className="text-[15px] font-mono font-semibold text-amber-100"
            >
              {t('scriptProposal.title')}
            </h2>
            <div className="flex items-center gap-2 mt-1">
              <TerminalSquare size={11} className="text-amber-400 shrink-0" />
              <code className="text-[12px] font-mono text-amber-200">
                {proposal.slug}.sh
              </code>
              <span className="text-[10px] font-mono text-amber-400/70">
                {t('scriptProposal.proposedBy', { proposedBy: proposal.proposedBy })}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={pending !== null}
            className="text-amber-400/70 hover:text-amber-100 w-7 h-7 flex items-center justify-center rounded hover:bg-amber-900/40 disabled:opacity-40"
            aria-label={t('common.dismiss')}
            title={t('scriptProposal.dismiss.title')}
          >
            <X size={14} />
          </button>
        </header>

        {/* Body — reason + body preview, scrollable. */}
        <div className="flex-1 overflow-y-auto scrollbar-thin px-5 py-4 space-y-4">
          <section>
            <h3 className="text-[10px] uppercase tracking-widest font-mono text-zinc-500 mb-1.5">
              {t('scriptProposal.section.reason')}
            </h3>
            <p className="text-[12px] leading-relaxed font-mono text-zinc-200 whitespace-pre-wrap break-words">
              {proposal.reason}
            </p>
          </section>
          <section>
            <h3 className="text-[10px] uppercase tracking-widest font-mono text-zinc-500 mb-1.5">
              {t('scriptProposal.section.scriptBody')}
            </h3>
            <pre className="text-[11px] leading-relaxed font-mono text-zinc-100 whitespace-pre-wrap break-words bg-bg-subtle border border-border rounded p-3 max-h-[240px] overflow-y-auto scrollbar-thin">
{proposal.body}
            </pre>
          </section>
        </div>

        {/* Footer — three operator paths. */}
        <footer className="px-5 py-3 border-t-2 border-border-strong bg-bg-subtle/30 space-y-2">
          {error && (
            <p className="text-[11px] font-mono text-red-400">⚠ {error}</p>
          )}
          {mode === 'view' ? (
            <>
              <input
                type="text"
                value={approveNotes}
                onChange={(e) => setApproveNotes(e.target.value)}
                placeholder={t('scriptProposal.approveNote.placeholder')}
                disabled={pending !== null}
                className="w-full bg-bg-subtle border border-border rounded-md px-3 py-1.5 text-[12px] font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-cyan-600 disabled:opacity-50"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleReviewLater}
                  disabled={pending !== null}
                  className="text-[11px] font-mono text-zinc-400 hover:text-zinc-100 px-2 py-1.5 disabled:opacity-50"
                >
                  {t('scriptProposal.reviewLater')}
                </button>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => setMode('reject-form')}
                  disabled={pending !== null}
                  className="text-[11px] font-mono px-3 py-1.5 rounded border border-rose-800/50 bg-rose-950/30 text-rose-200 hover:bg-rose-950/60 disabled:opacity-50"
                >
                  {t('scriptProposal.reject')}
                </button>
                <button
                  type="button"
                  onClick={handleApprove}
                  disabled={pending !== null}
                  className={cn(
                    'text-[11px] font-mono font-semibold px-4 py-1.5 rounded border',
                    pending === 'approve'
                      ? 'border-zinc-700 bg-zinc-900/40 text-zinc-500 cursor-wait'
                      : 'border-emerald-600 bg-emerald-700 text-white hover:bg-emerald-600',
                  )}
                >
                  {pending === 'approve' ? t('scriptProposal.approve.pending') : t('scriptProposal.approve.idle')}
                </button>
              </div>
            </>
          ) : (
            <>
              <textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder={t('scriptProposal.rejectForm.placeholder')}
                disabled={pending !== null}
                rows={3}
                autoFocus
                className="w-full bg-bg-subtle border border-rose-700/40 rounded-md px-3 py-2 text-[12px] font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-rose-500 resize-none leading-relaxed disabled:opacity-50"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setMode('view');
                    setError(null);
                  }}
                  disabled={pending !== null}
                  className="text-[11px] font-mono text-zinc-400 hover:text-zinc-100 px-2 py-1.5 disabled:opacity-50"
                >
                  {t('common.back')}
                </button>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={handleReject}
                  disabled={pending !== null || rejectReason.trim().length === 0}
                  className={cn(
                    'text-[11px] font-mono font-semibold px-4 py-1.5 rounded border',
                    rejectReason.trim().length > 0 && pending === null
                      ? 'border-rose-600 bg-rose-700 text-white hover:bg-rose-600'
                      : 'border-zinc-700 bg-zinc-900/40 text-zinc-600 cursor-not-allowed',
                  )}
                >
                  {pending === 'reject' ? t('scriptProposal.confirmReject.pending') : t('scriptProposal.confirmReject.idle')}
                </button>
              </div>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
