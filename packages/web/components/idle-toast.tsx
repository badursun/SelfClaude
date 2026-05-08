'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, X } from 'lucide-react';
import { useTranslation } from '@/lib/i18n';

/**
 * Floating top-right toast that pops up whenever ALL agents in the
 * session transition from busy to idle. Drawn from the operator note:
 * "tüm agentler işini bitirdiğinde ekranda bir uyarı çıkarsa
 * kullanıcıyı bilgilendirmek için iyi olur."
 *
 * Intentionally minimal: a single emerald tile, dismissible, auto-fades
 * after 6 s. The toast is only meaningful for transitions where the
 * session WAS busy — boot-time idle doesn't fire anything.
 */
export function IdleToast({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  // Track the previous busy value so we only fire on a true→false edge.
  const prevBusyRef = useRef<boolean | null>(null);
  // Track the dismiss timer so a fresh transition resets the countdown.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const prev = prevBusyRef.current;
    prevBusyRef.current = busy;
    if (prev === true && busy === false) {
      setShow(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setShow(false), 6_000);
    }
    if (busy) {
      // Cancel any in-flight idle toast — a new turn is starting.
      if (timerRef.current) clearTimeout(timerRef.current);
      setShow(false);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [busy]);

  if (!show) return null;

  return (
    <div
      role="status"
      className="fixed top-12 right-4 z-50 flex items-center gap-2 rounded-lg border border-emerald-700/60 bg-emerald-950/80 backdrop-blur-sm px-3 py-2 text-emerald-100 shadow-lg shadow-black/50 max-w-sm"
    >
      <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />
      <div className="flex-1 text-[12px] leading-tight">
        <div className="font-semibold">{t('idleToast.title')}</div>
        <div className="text-[11px] text-emerald-300/80">
          {t('idleToast.body')}
        </div>
      </div>
      <button
        onClick={() => setShow(false)}
        aria-label={t('common.dismiss')}
        className="text-emerald-300 hover:text-white p-1 rounded hover:bg-emerald-900/50"
      >
        <X size={12} />
      </button>
    </div>
  );
}
