'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Folder, Plus, X } from 'lucide-react';
import { api } from '@/lib/api';
import type { SessionMeta } from '@/lib/types';
import { cn } from '@/lib/cn';
import {
  clearClosing,
  filterClosing,
  isClosing,
  markClosing,
  useClosingTick,
} from '@/lib/closing-sessions';
import { SelfClaudeLogo } from './selfclaude-logo';
import { useTranslation } from '../lib/i18n';

const POLL_MS = 4_000;
// Tombstone lives well past the destroy round-trip. destroySession
// blocks up to 5s on a busy turn, then orchestrator.stop() runs. Some
// of those settle paths (CC subprocess SIGTERM, hook server close) can
// stretch a few extra seconds. 30s gives us ~7 polling cycles of grace.
const TOMBSTONE_MS = 30_000;

export function TabBar() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Re-render this instance whenever the shared closing-id set
  // mutates — covers the case where another component (or a previous
  // TabBar mount) marked an id closing and our render needs to update.
  useClosingTick();

  const activeId = (() => {
    const m = pathname?.match(/^\/sessions\/([^/]+)/);
    return m?.[1] ?? null;
  })();

  const refresh = async () => {
    try {
      const r = await api.listSessions();
      setSessions(filterClosing(r.sessions));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, []);

  const closeTab = async (id: string) => {
    if (isClosing(id)) return;
    markClosing(id);

    const wasActive = id === activeId;
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (wasActive) {
      const remaining = sessions.filter((s) => s.id !== id);
      const fallback = remaining[remaining.length - 1];
      router.push(fallback ? `/sessions/${fallback.id}` : '/');
    }
    try {
      await api.destroySession(id);
    } catch (e) {
      console.warn('[tab-bar] destroySession failed:', (e as Error).message);
    } finally {
      // setTimeout outlives the originating component — the tombstone
      // must lift across navigations, not bound to any one mount.
      setTimeout(() => clearClosing(id), TOMBSTONE_MS);
    }
  };

  return (
    <div className="flex items-stretch bg-bg-subtle border-b-2 border-border-strong h-9 overflow-x-auto scrollbar-thin shrink-0">
      <Link
        href="/"
        className={cn(
          'px-3 flex items-center border-r border-border hover:bg-bg-elevated/60 transition-colors',
          pathname === '/' && 'bg-bg-panel',
        )}
        aria-label={t('tabBar.home.ariaLabel')}
        title={t('tabBar.home.title')}
      >
        <SelfClaudeLogo variant="wordmark" size="xs" />
      </Link>

      {sessions.map((s) => (
        <Tab
          key={s.id}
          session={s}
          active={s.id === activeId}
          closing={isClosing(s.id)}
          onClose={() => closeTab(s.id)}
        />
      ))}

      <Link
        href="/"
        className="px-3 flex items-center text-zinc-400 hover:text-zinc-200 border-r border-border"
        title={t('tabBar.newProject')}
      >
        <Plus size={14} />
      </Link>

      {error && (
        <span className="ml-auto px-3 self-center text-xs text-red-400 truncate" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}

function Tab({
  session,
  active,
  closing,
  onClose,
}: {
  session: SessionMeta;
  active: boolean;
  closing: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // Close button MUST live as a sibling of the Link, not nested inside
  // it — Next.js intercepts navigation at a higher level than React's
  // synthetic-event preventDefault, so a nested button click would
  // still navigate. Putting them side-by-side in a flex row gives the
  // button its own click target with no ambiguity.
  return (
    <div
      className={cn(
        'group flex items-center border-r border-border min-w-0 relative',
        active
          ? 'bg-bg-panel border-b-2 border-b-cyan-500 -mb-px'
          : 'hover:bg-bg-elevated',
        closing && 'opacity-50 pointer-events-none',
      )}
      title={session.cwd}
    >
      <Link
        href={`/sessions/${session.id}`}
        className={cn(
          'flex items-center gap-2 pl-3 pr-1 py-2 text-sm min-w-0',
          active ? 'text-zinc-100' : 'text-zinc-400',
        )}
      >
        <Folder size={12} className="shrink-0 text-zinc-500" />
        <span className="truncate max-w-[160px]">{session.label}</span>
        {closing ? (
          <span className="text-[9px] uppercase tracking-wider text-rose-400 shrink-0">{t('tabBar.closing')}</span>
        ) : (
          session.busy && <span className="text-xs text-cyan-400 shrink-0">●</span>
        )}
      </Link>
      <button
        type="button"
        onMouseDown={(e) => {
          // Use mousedown instead of onClick — browsers dispatch
          // mousedown before the Link can capture-bubble navigation,
          // and we treat it as the authoritative close trigger.
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
        onClick={(e) => {
          // Defensive — if some path delivers click but not mousedown
          // (touch / accessibility tools), still fire the close.
          e.preventDefault();
          e.stopPropagation();
        }}
        className={cn(
          'shrink-0 rounded p-1 mr-1.5 ml-1 transition-colors text-zinc-300 hover:text-white hover:bg-rose-700/60 cursor-pointer',
          // Visibility: always visible on active tab, otherwise show
          // on group hover. Operators kept missing the X on the active
          // tab when it was opacity-50 — making it always visible there
          // resolves the "X doesn't close" perception.
          active ? 'opacity-90' : 'opacity-0 group-hover:opacity-70 hover:!opacity-100',
        )}
        aria-label={t('tabBar.close.ariaLabel', { label: session.label })}
        title={t('tabBar.close.title', { label: session.label })}
        disabled={closing}
      >
        <X size={13} strokeWidth={2.5} />
      </button>
    </div>
  );
}
