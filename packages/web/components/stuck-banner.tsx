'use client';

import { useSessionStore } from '@/lib/store';
import { useTranslation } from '@/lib/i18n';
import { SessionBanner } from './session-banner';

/**
 * Phase 7 sprint 2B — stuck-detection banner.
 *
 * Reads the per-session `stuckStatus` slot. When the orchestrator's
 * detector flips a session to stuck, the slot updates to
 * `{stuck: true, reason, minutesSinceProgress}` and this banner pops
 * in below the StatusBar (above the turn-error banner) with an
 * amber tint and a concrete suggestion for what to do next.
 *
 * When the detector flips back (operator nudged sup, sup made
 * progress), `stuck` goes false and the banner unmounts. We don't
 * persist a "history" of stuck transitions — only the current state
 * matters for the operator-facing nudge.
 *
 * Per ROADMAP calibration #7: this is a *trust-signalling* feature.
 * It surfaces silent failures the operator would otherwise miss,
 * but never blocks the session itself.
 */
export function StuckBanner({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const stuckStatus = useSessionStore((s) => s.sessions[sessionId]?.stuckStatus ?? null);

  if (!stuckStatus || !stuckStatus.stuck) return null;

  const { reason, minutesSinceProgress } = stuckStatus;
  const ageLabel =
    minutesSinceProgress === null
      ? t('stuckBanner.ageLabel.noProgress')
      : t('stuckBanner.ageLabel.withMinutes', { minutes: Math.round(minutesSinceProgress) });

  // Reason-tuned copy. The catalogue stays small — every operator-
  // facing string is here, in one place, so a heuristic-tweak diff
  // surfaces clearly in review.
  const body =
    reason === 'no-progress-yet'
      ? t('stuckBanner.body.noProgressYet')
      : t('stuckBanner.body.alive', { ageLabel });

  return (
    <SessionBanner
      open
      severity="warn"
      title={t('stuckBanner.title')}
      body={body}
    />
  );
}
