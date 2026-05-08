'use client';

import { useSessionStore } from '@/lib/store';
import { getFailureModeUI } from '@/lib/failure-modes';
import { useTranslation } from '@/lib/i18n';
import { SessionBanner } from './session-banner';

/**
 * Phase 7 sprint 2 — turn-error banner.
 *
 * Listens to the per-session `lastTurnError` slot in the store. When
 * a `turn-error` SSE event lands, the slot fills + this banner pops
 * in above the session content with structured, catalogue-driven
 * copy: title = code label, body = description + suggested action.
 *
 * Designed to *complement*, not replace, the failure rollup in the
 * bottom toolbar. The toolbar shows cumulative counts; this banner
 * surfaces the most recent failure with what to do about it. The
 * operator dismisses via the X (sets `lastTurnError` back to null);
 * the next failure overwrites the slot on its own.
 *
 * Severity mapping pulls from the catalogue entry — `info` for
 * routine events (aborted, hook-denied), `warn` for soft failures
 * (network, tool error), `error` for hard failures (timeout,
 * unknown).
 */
export function TurnErrorBanner({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const error = useSessionStore((s) => s.sessions[sessionId]?.lastTurnError ?? null);
  const dismiss = useSessionStore((s) => s.dismissTurnError);

  if (!error) return null;
  const mode = getFailureModeUI(error.code);
  const roleLabel = error.role
    ? `${error.role} · `
    : '';

  return (
    <SessionBanner
      open
      severity={mode.severity}
      title={`${roleLabel}${mode.label}`}
      body={
        <div className="space-y-1.5">
          <div>{mode.description}</div>
          <div className="text-zinc-300/80">
            <span className="font-semibold text-zinc-200">{t('turnErrorBanner.whatToDo')}</span>
            {mode.suggestedAction}
          </div>
          {error.message && error.message !== mode.label && (
            <details className="text-[10px] text-zinc-400 pt-1">
              <summary className="cursor-pointer hover:text-zinc-200 select-none">
                {t('turnErrorBanner.showRaw')}
              </summary>
              <pre className="mt-1 whitespace-pre-wrap font-mono text-[10px] bg-bg-elevated/40 rounded p-1.5 border border-border/30 max-h-40 overflow-y-auto">
                {error.message}
              </pre>
            </details>
          )}
        </div>
      }
      onDismiss={() => dismiss(sessionId)}
    />
  );
}
