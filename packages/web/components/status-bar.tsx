'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, ChevronLeft, Copy, ExternalLink, Pin, PinOff, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { IsolationWidget } from '@/components/isolation-widget';
import type { SessionMeta } from '@/lib/types';
import { cn } from '@/lib/cn';
import { useTranslation } from '../lib/i18n';

/**
 * Phase 3 demo: derive both whether this is a demo session and the
 * absolute path of the artifact (`<cwd>/index.html`) from the meta.
 * Hardcoded filename matches `DEMO_ARTIFACT_FILENAME` in core's
 * demo-template.ts — when that changes, update both ends.
 */
const DEMO_DIR_PREFIX = '/.selfclaude/demos/';
const DEMO_ARTIFACT_FILENAME = 'index.html';
function demoArtifactPath(cwd: string): string | null {
  if (!cwd.includes(DEMO_DIR_PREFIX)) return null;
  return `${cwd.replace(/\/$/, '')}/${DEMO_ARTIFACT_FILENAME}`;
}

/**
 * Session header strip — back link, project label/cwd, and quick
 * actions. Phase + sup/dev liveness indicators were moved to the
 * BottomToolbar (single source of truth for runtime telemetry); the
 * freed space now hosts operator actions: copy cwd, toggle pin. Pin
 * lets the operator promote a returning project to the home-page
 * favorites list without having to navigate back home and find it.
 */
export function StatusBar({ meta }: { meta: SessionMeta | null; busy?: boolean }) {
  const { t } = useTranslation();
  const [pinned, setPinned] = useState<boolean | null>(null);
  const [pinPending, setPinPending] = useState(false);
  const [copied, setCopied] = useState(false);

  // Resolve initial pinned state from the favorites list. Refetched on
  // mount and whenever the cwd changes (rare — operator switching tabs).
  useEffect(() => {
    if (!meta?.cwd) {
      setPinned(null);
      return;
    }
    let cancelled = false;
    api
      .listFavorites()
      .then((r) => {
        if (cancelled) return;
        setPinned(r.favorites.some((f) => f.cwd === meta.cwd));
      })
      .catch(() => {
        if (!cancelled) setPinned(false);
      });
    return () => {
      cancelled = true;
    };
  }, [meta?.cwd]);

  const togglePin = async () => {
    if (!meta?.cwd || pinPending || pinned === null) return;
    setPinPending(true);
    try {
      if (pinned) {
        await api.removeFavorite(meta.cwd);
        setPinned(false);
      } else {
        await api.addFavorite(meta.cwd, meta.label);
        setPinned(true);
      }
    } catch (e) {
      console.warn('toggle pin failed:', (e as Error).message);
    } finally {
      setPinPending(false);
    }
  };

  const copyCwd = async () => {
    if (!meta?.cwd) return;
    try {
      await navigator.clipboard.writeText(meta.cwd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* silent */
    }
  };

  return (
    <div className="flex items-center gap-3 border-b-2 border-border-strong bg-bg-subtle px-4 py-2 text-sm">
      <Link
        href="/"
        className="text-zinc-400 hover:text-zinc-200"
        aria-label={t('statusBar.backToHome.ariaLabel')}
        title={t('statusBar.backToHome.title')}
      >
        <ChevronLeft size={16} />
      </Link>
      <span className="font-medium truncate">{meta?.label ?? '…'}</span>
      <button
        type="button"
        onClick={copyCwd}
        className="group flex items-center gap-1.5 min-w-0 text-xs text-zinc-500 hover:text-zinc-200 px-1 py-0.5 rounded hover:bg-bg-elevated"
        title={copied ? t('common.copied') : t('statusBar.copyPath')}
      >
        <code className="truncate">{meta?.cwd ?? ''}</code>
        {copied ? (
          <Check size={11} className="shrink-0 text-emerald-400" />
        ) : (
          <Copy size={11} className="shrink-0 opacity-0 group-hover:opacity-60" />
        )}
      </button>

      <div className="ml-auto flex items-center gap-1 shrink-0">
        {meta?.id && <IsolationWidget sessionId={meta.id} />}
        {meta?.cwd && <DemoOpenButton cwd={meta.cwd} />}
        <button
          type="button"
          onClick={togglePin}
          disabled={!meta || pinned === null || pinPending}
          className={cn(
            'flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors',
            pinned
              ? 'text-amber-300 hover:bg-amber-950/30'
              : 'text-zinc-400 hover:text-amber-300 hover:bg-bg-elevated',
            pinPending && 'opacity-50 cursor-wait',
          )}
          title={pinned ? t('statusBar.unpinFromHome') : t('statusBar.pinToHome')}
          aria-pressed={pinned ?? false}
        >
          {pinned ? (
            <>
              <Pin size={13} className="fill-amber-400 text-amber-400" />
              <span className="hidden sm:inline">{t('statusBar.pinned')}</span>
            </>
          ) : (
            <>
              <PinOff size={13} />
              <span className="hidden sm:inline">{t('statusBar.pin')}</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}

/**
 * Phase 3 demo — "Open Result" button. Surfaces only when the session's
 * cwd lives under `~/.selfclaude/demos/` (so it's a demo workspace)
 * AND the artifact `index.html` exists. Click → backend opens the
 * file in the operator's default browser via OS shell.
 *
 * The existence probe runs every 4s while the session is open. Once
 * the file appears, the button stays visible — even if the operator
 * deletes the file, they can still click and get a "file not found"
 * error from the API rather than a silently disabled button.
 */
function DemoOpenButton({ cwd }: { cwd: string }) {
  const { t } = useTranslation();
  const artifactPath = demoArtifactPath(cwd);
  const [exists, setExists] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!artifactPath) return;
    let cancelled = false;
    const probe = async () => {
      try {
        const r = await api.demoArtifactExists(artifactPath);
        if (!cancelled && r.exists) setExists(true);
      } catch {
        /* silent */
      }
    };
    void probe();
    const id = setInterval(() => {
      if (!exists) void probe();
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [artifactPath, exists]);

  if (!artifactPath || !exists) return null;

  const onClick = async () => {
    if (pending) return;
    setPending(true);
    try {
      await api.openDemoArtifact(artifactPath);
    } catch (e) {
      console.warn('open demo artifact failed:', (e as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="relative flex items-center">
      {/* Pulsing ring draws the eye for the first few seconds after the
          file appears. `pointer-events-none` so it never blocks the
          click. The animation keeps running — minimal cost, and a
          steady glow stays helpful as the operator looks around the
          UI for the first time. */}
      <span
        aria-hidden
        className="absolute inset-0 rounded-md bg-cyan-400/30 animate-ping pointer-events-none"
      />
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className={cn(
          'relative inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-semibold',
          'bg-cyan-500 hover:bg-cyan-400 text-white shadow-lg shadow-cyan-900/40',
          'ring-1 ring-cyan-300/60 transition-colors',
          pending && 'opacity-70 cursor-wait',
        )}
        title={t('statusBar.demo.title')}
      >
        <Sparkles size={14} className="text-cyan-100" />
        <span>{t('statusBar.demo.openResult')}</span>
        <ExternalLink size={12} className="opacity-90" />
      </button>
    </div>
  );
}
