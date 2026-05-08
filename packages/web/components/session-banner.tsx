'use client';

import { AlertOctagon, AlertTriangle, Info, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useTranslation } from '../lib/i18n';

/**
 * Phase 7 sprint 2 — themed banner atom for session-level surfaces
 * (turn-error, stuck detection, future operator nudges).
 *
 * Renders a single horizontal strip with a severity-driven accent,
 * an icon, a title + body slot, and a dismiss X. Caller controls
 * visibility (banners are usually mounted permanently and toggled
 * via `open`).
 *
 * Severity mapping is conservative — we don't want every transient
 * tool-error painting the screen red:
 *   - info  → cyan, "FYI" tone
 *   - warn  → amber, "look at this" tone
 *   - error → rose, "something needs attention" tone
 *
 * Body accepts ReactNode so callers can include action buttons or
 * structured content; for plain prose, just pass a string.
 */
export type BannerSeverity = 'info' | 'warn' | 'error';

export function SessionBanner({
  open,
  severity,
  title,
  body,
  actions,
  onDismiss,
}: {
  open: boolean;
  severity: BannerSeverity;
  title: string;
  body?: React.ReactNode;
  /** Optional action chips on the right side, before the dismiss X. */
  actions?: React.ReactNode;
  /** Operator clicked X. Caller can also use this for action callbacks. */
  onDismiss?: () => void;
}) {
  const { t } = useTranslation();
  if (!open) return null;
  const icon =
    severity === 'info' ? (
      <Info size={14} className="text-cyan-300 shrink-0" />
    ) : severity === 'warn' ? (
      <AlertTriangle size={14} className="text-amber-300 shrink-0" />
    ) : (
      <AlertOctagon size={14} className="text-rose-300 shrink-0" />
    );
  const palette = {
    info: 'border-cyan-700/40 bg-cyan-950/30 text-cyan-100',
    warn: 'border-amber-700/40 bg-amber-950/30 text-amber-100',
    error: 'border-rose-700/40 bg-rose-950/30 text-rose-100',
  }[severity];
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2.5 px-3 py-2 border-b text-xs',
        palette,
      )}
    >
      <span className="mt-0.5">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-[11px] uppercase tracking-wider mb-0.5">
          {title}
        </div>
        {body && (
          <div className="text-[11px] leading-relaxed text-zinc-200/90 whitespace-pre-wrap">
            {body}
          </div>
        )}
      </div>
      {actions && <div className="shrink-0 flex items-center gap-1">{actions}</div>}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 p-0.5 rounded text-current opacity-70 hover:opacity-100 hover:bg-white/10"
          aria-label={t('sessionBanner.dismiss')}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
