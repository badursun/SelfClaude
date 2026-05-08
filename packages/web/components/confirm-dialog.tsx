'use client';

import { useEffect } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useTranslation } from '../lib/i18n';

/**
 * Lightweight modal confirm dialog. Rendered inline (no portal) — the
 * fixed-positioning + z-index puts it above all panes. Closes on Esc, on
 * backdrop click, or on the Cancel/X buttons. The Confirm button is
 * coloured by the `variant` prop: `danger` (red) for destructive actions
 * like aborting a turn, `default` (cyan) for neutral confirmations.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  variant = 'default',
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const resolvedConfirmLabel = confirmLabel ?? t('confirmDialog.defaultConfirm');
  const resolvedCancelLabel = cancelLabel ?? t('common.cancel');
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  const confirmStyle =
    variant === 'danger'
      ? 'bg-red-600 hover:bg-red-500 border-red-700 text-white'
      : 'bg-cyan-600 hover:bg-cyan-500 border-cyan-700 text-white';
  const iconColor = variant === 'danger' ? 'text-red-400' : 'text-cyan-400';

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onCancel}
    >
      <div
        className="bg-bg border border-border rounded-lg max-w-md w-full overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <AlertTriangle size={16} className={iconColor} />
          <h3 className="text-sm font-semibold text-zinc-100 flex-1">{title}</h3>
          <button
            onClick={onCancel}
            className="text-zinc-500 hover:text-zinc-200 p-0.5"
            aria-label={t('common.cancel')}
          >
            <X size={14} />
          </button>
        </div>
        <div className="px-4 py-3 text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap">
          {message}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border bg-bg-subtle">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded border border-border hover:bg-bg-elevated text-zinc-300"
          >
            {resolvedCancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={cn('px-3 py-1.5 text-xs rounded border font-medium', confirmStyle)}
          >
            {resolvedConfirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
