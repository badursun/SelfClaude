'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FolderOpen, Loader2, Sparkles } from 'lucide-react';
import { TabBar } from '@/components/tab-bar';
import { FolderPicker } from '@/components/folder-picker';
import { InfoBanners } from '@/components/info-banners';
import {
  NewProjectWizard,
  buildBootstrapBrief,
  buildDiscoveryBrief,
  type WizardSubmission,
} from '@/components/new-project-wizard';
import { LanguageSwitcher } from '@/components/language-switcher';
import { SelfClaudeLogo } from '@/components/selfclaude-logo';
import { PinnedList, RecentList, SessionsList } from '@/components/sessions-list';
import { api } from '@/lib/api';
import { filterClosing, useClosingTick } from '@/lib/closing-sessions';
import { useTranslation } from '@/lib/i18n';
import type { Favorite, RecentEntry, SessionMeta } from '@/lib/types';

export default function Home() {
  const { t, plural } = useTranslation();
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [picking, setPicking] = useState(false);
  // Wizard runs after a folder pick — operator either fills the brief
  // (sup gets structured kickoff) or skips (sup runs cold Discovery).
  // `null` = no wizard active. The pickedCwd is persisted while the
  // wizard renders so we can `createSession` on launch/skip.
  const [wizardCwd, setWizardCwd] = useState<string | null>(null);
  // Distinct loading states: `loading` is the initial fetch (skeleton),
  // `error` covers any subsequent refresh failure (banner). After the
  // first fetch resolves, the layout settles and only banners surface.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const [health, setHealth] = useState<{
    version: string;
    uptime: number;
    sessions: number;
  } | null>(null);

  // Subscribe to the shared closing-id store so a click in TabBar
  // reflects here too — the "Active sessions" card on this page would
  // otherwise keep showing a session that's mid-destroy until the next
  // refresh cycle clears it.
  const closingTick = useClosingTick();
  // Visible list filters out anything currently being torn down. The
  // raw list (from listSessions) might still include them while the
  // server-side destroy is in flight.
  const visibleSessions = useMemo(
    () => filterClosing(sessions),
    // closingTick is the dep that signals "the set changed, re-filter."
    // sessions itself triggers a recompute too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, closingTick],
  );

  const refresh = useCallback(async () => {
    try {
      const [s, f, r, h] = await Promise.all([
        api.listSessions(),
        api.listFavorites(),
        api.listRecents(),
        api.health().catch(() => null),
      ]);
      setSessions(s.sessions);
      setFavorites(f.favorites);
      setRecents(r.recents);
      if (h) setHealth(h);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Lightweight 4s polling to keep "Active sessions" fresh when the
  // operator returns to the home tab — without it, closing a session
  // elsewhere (or starting one in another tab) wouldn't reflect here
  // until a manual reload.
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 4_000);
    return () => clearInterval(t);
  }, [refresh]);

  const openCwd = async (path: string, label?: string) => {
    setPicking(false);
    setError(null);
    // Already-loaded session — jump to it. Use visibleSessions so we
    // don't try to "reuse" one that's mid-destroy.
    const existing = visibleSessions.find((s) => s.cwd === path);
    if (existing) {
      router.push(`/sessions/${existing.id}`);
      return;
    }
    // Probe disk: does this cwd already have a `.selfclaude/state.json`?
    // If yes, it's a returning project — skip the wizard, go straight
    // to a session create + navigate. Only truly-fresh cwds (no
    // state.json) get the wizard.
    try {
      const probe = await api.probeProject(path);
      if (probe.exists) {
        const meta = await api.createSession(path, label);
        router.push(`/sessions/${meta.id}`);
        return;
      }
    } catch (e) {
      // Probe failure shouldn't block — fall through to wizard which
      // can still handle the launch path. Surface as a soft error.
      console.warn('probeProject failed:', (e as Error).message);
    }
    setWizardCwd(path);
    void label; // label fields aren't part of v1 wizard wiring
  };

  const handleWizardLaunch = async (submission: WizardSubmission) => {
    if (!wizardCwd) return;
    const meta = await api.createSession(wizardCwd, submission.projectName);
    // Send the structured bootstrap brief as the operator's first
    // message; sup's prompt knows to parse it (see supervisor.md).
    await api.sendMessage(meta.id, buildBootstrapBrief(submission));
    setWizardCwd(null);
    router.push(`/sessions/${meta.id}`);
  };

  const handleWizardSkip = async () => {
    if (!wizardCwd) return;
    const meta = await api.createSession(wizardCwd);
    setWizardCwd(null);
    router.push(`/sessions/${meta.id}`);
  };

  const handleWizardDiscover = async () => {
    if (!wizardCwd) return;
    // Same shape as the wizard launch path, but the first message is
    // a DISCOVERY_BRIEF instead of a BOOTSTRAP_BRIEF — sup's prompt
    // routes on the prefix and explores the codebase autonomously.
    const meta = await api.createSession(wizardCwd);
    await api.sendMessage(meta.id, buildDiscoveryBrief(wizardCwd));
    setWizardCwd(null);
    router.push(`/sessions/${meta.id}`);
  };

  const togglePin = async (cwd: string, label: string) => {
    const isPinned = favorites.some((f) => f.cwd === cwd);
    try {
      if (isPinned) {
        await api.removeFavorite(cwd);
      } else {
        await api.addFavorite(cwd, label);
      }
      void refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const unpin = async (cwd: string) => {
    try {
      await api.removeFavorite(cwd);
      void refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const forgetRecent = async (cwd: string) => {
    try {
      await api.removeRecent(cwd);
      void refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const pinnedCwds = new Set(favorites.map((f) => f.cwd));
  const activeCwds = new Set(visibleSessions.map((s) => s.cwd));

  const isEmpty =
    visibleSessions.length === 0 && favorites.length === 0 && recents.length === 0;

  return (
    <>
      <TabBar />
      <main className="p-8 max-w-5xl mx-auto relative">
        {/* Subtle hero glow — sits behind the logo, fades to nothing
            below the fold. Pure decoration, pointer-events-none so it
            doesn't intercept clicks. */}
        <div
          aria-hidden
          className="absolute -top-20 -left-10 w-[480px] h-[320px] pointer-events-none"
          style={{
            background:
              'radial-gradient(closest-side, rgba(6, 182, 212, 0.10), rgba(6, 182, 212, 0.04) 50%, transparent 80%)',
          }}
        />
        <header className="relative mb-10 flex items-start justify-between gap-6">
          <div className="flex-1 min-w-0">
            <SelfClaudeLogo
              variant="wordmark"
              size="xl"
              caption={t('home.caption')}
            />
            <p className="mt-3 text-sm text-zinc-500 max-w-md leading-relaxed">
              {t('home.hero.description')}
            </p>
            {health && (
              <div className="mt-4 flex items-center gap-3 text-[10px] font-mono text-zinc-600 uppercase tracking-widest">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  {t('home.status.apiOnline')}
                </span>
                <span className="text-zinc-700">·</span>
                <span>v{health.version}</span>
                <span className="text-zinc-700">·</span>
                <span>{formatUptime(health.uptime)}</span>
                <span className="text-zinc-700">·</span>
                <span>
                  {plural('home.status.session', health.sessions)}
                </span>
                <span className="text-zinc-700">·</span>
                <BaselineRatioControl />
              </div>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <LanguageSwitcher />
            {!loading && (
              <button
                type="button"
                onClick={() => setPicking(true)}
                className="rounded-md bg-cyan-600 hover:bg-cyan-500 px-4 py-2 text-sm font-medium flex items-center gap-2 shrink-0 shadow-lg shadow-cyan-900/30"
              >
                <FolderOpen size={15} />
                {t('home.button.openProject')}
              </button>
            )}
          </div>
        </header>

        <div className="relative">
          {error && (
            <div className="mb-4 rounded-md border border-red-900/40 bg-red-950/40 p-3 text-sm text-red-300 flex items-center gap-2">
              <span className="shrink-0">⚠</span>
              <span className="flex-1 truncate" title={error}>{error}</span>
              <button
                type="button"
                onClick={() => void refresh()}
                className="text-xs underline text-red-200 hover:text-white shrink-0"
              >
                {t('common.retry')}
              </button>
            </div>
          )}

          {loading ? (
            <LandingSkeleton />
          ) : (
            <>
              <InfoBanners />
              <SessionsList
                sessions={visibleSessions}
                pinnedCwds={pinnedCwds}
                onTogglePin={togglePin}
              />
              <PinnedList
                favorites={favorites}
                activeCwds={activeCwds}
                onOpen={openCwd}
                onUnpin={unpin}
              />
              <RecentList
                recents={recents}
                activeCwds={activeCwds}
                pinnedCwds={pinnedCwds}
                onOpen={openCwd}
                onForget={forgetRecent}
              />
              {isEmpty && (
                <EmptyState onPick={() => setPicking(true)} />
              )}
            </>
          )}
        </div>

        {picking && (
          <FolderPicker onSelect={(p) => openCwd(p)} onCancel={() => setPicking(false)} />
        )}
        {wizardCwd && (
          <NewProjectWizard
            cwd={wizardCwd}
            onLaunch={handleWizardLaunch}
            onSkip={handleWizardSkip}
            onDiscoverExisting={handleWizardDiscover}
            onCancel={() => setWizardCwd(null)}
          />
        )}
      </main>
    </>
  );
}

/**
 * Skeleton placeholders sized to roughly match the post-load layout
 * (1 pinned grid row + 2 active-session rows). Keeps the page from
 * jumping when data arrives, and signals "loading, not blank" without
 * a centred spinner that hides the upcoming layout.
 */
function LandingSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="space-y-6 animate-pulse">
      <div>
        <div className="h-3 w-20 bg-zinc-800 rounded mb-2" />
        <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-14 rounded-md border border-border bg-bg-panel/40"
            />
          ))}
        </div>
      </div>
      <div>
        <div className="h-3 w-24 bg-zinc-800 rounded mb-2" />
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-16 rounded-lg border border-border bg-bg-panel/40"
            />
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2 text-xs text-zinc-600 pt-2">
        <Loader2 size={12} className="animate-spin" />
        <span>{t('home.loading.sessions')}</span>
      </div>
    </div>
  );
}

/**
 * First-run landing block — Phase 3 onboarding. Two paths side by
 * side: (1) the canned 5-minute demo for first-time visitors who
 * just want a "this actually works" moment, and (2) the real folder
 * picker for operators who arrived with their own project.
 *
 * Per ROADMAP calibration #3: the demo must produce a *visible*
 * artifact — here a single self-contained `index.html` the operator
 * opens in their browser. The wow factor is the result, not the file
 * tree.
 */
function EmptyState({ onPick }: { onPick: () => void }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);

  const startDemo = async () => {
    if (demoBusy) return;
    setDemoBusy(true);
    setDemoError(null);
    try {
      const r = await api.startDemo();
      // Pass the canned brief through the URL so the session page
      // auto-fills the chat box on mount. The operator clicks Send to
      // kick off the orchestration — gives them a beat to read the
      // brief instead of running it autopilot.
      const qs = new URLSearchParams({ firstMessage: r.prompt }).toString();
      router.push(`/sessions/${r.sessionId}?${qs}`);
    } catch (e) {
      setDemoError((e as Error).message);
      setDemoBusy(false);
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <div className="rounded-lg border-2 border-cyan-800/40 bg-gradient-to-b from-cyan-950/20 to-transparent p-6 flex flex-col">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-cyan-950/60 border border-cyan-700/50 mb-3">
          <Sparkles size={18} className="text-cyan-400" />
        </div>
        <h2 className="text-base font-medium text-zinc-100 mb-1">
          {t('home.demo.title')}
        </h2>
        <p className="text-xs text-zinc-500 leading-relaxed mb-4 flex-1">
          {t('home.demo.description')}
        </p>
        {demoError && (
          <div className="mb-3 text-[11px] text-rose-300 bg-rose-950/30 border border-rose-900/40 rounded px-2 py-1">
            {demoError}
          </div>
        )}
        <button
          type="button"
          onClick={startDemo}
          disabled={demoBusy}
          className="inline-flex items-center justify-center gap-2 rounded-md bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-800 disabled:cursor-wait px-4 py-2 text-sm font-medium text-white shadow-lg shadow-cyan-900/30"
        >
          {demoBusy ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              {t('home.demo.button.loading')}
            </>
          ) : (
            <>
              <Sparkles size={14} />
              {t('home.demo.button.start')}
            </>
          )}
        </button>
      </div>
      <div className="rounded-lg border border-dashed border-border bg-bg-subtle/30 p-6 flex flex-col">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-zinc-900 border border-border mb-3">
          <FolderOpen size={18} className="text-zinc-300" />
        </div>
        <h2 className="text-base font-medium text-zinc-100 mb-1">
          {t('home.realProject.title')}
        </h2>
        <p className="text-xs text-zinc-500 leading-relaxed mb-4 flex-1">
          {t('home.realProject.description')}
        </p>
        <button
          type="button"
          onClick={onPick}
          className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-bg-elevated hover:bg-bg-panel px-4 py-2 text-sm font-medium text-zinc-100"
        >
          <FolderOpen size={14} />
          {t('home.realProject.button')}
        </button>
      </div>
    </div>
  );
}

/**
 * Format the daemon's uptime (seconds, from `/api/health`) as a
 * human-friendly string. Used in the landing status strip.
 */
function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/**
 * Phase 2 telemetry — operator control for the "estimated time saved"
 * baseline ratio shown on pinned project cards. Value persists in
 * localStorage; setting "off" (1×) hides the estimate panel entirely.
 *
 * Per ROADMAP calibration #2: estimates are secondary, labelled, and
 * configurable. The operator decides whether to trust the assumption,
 * and the dropdown makes the assumption visible at all times.
 */
const BASELINE_KEY = 'selfclaude:baseline-ratio';
const BASELINE_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: 'off' },
  { value: 2, label: '2×' },
  { value: 3, label: '3×' },
  { value: 5, label: '5×' },
  { value: 10, label: '10×' },
];

function BaselineRatioControl() {
  const { t } = useTranslation();
  const [value, setValue] = useState<number>(3);
  useEffect(() => {
    const raw = window.localStorage.getItem(BASELINE_KEY);
    const n = raw ? Number.parseFloat(raw) : NaN;
    if (Number.isFinite(n) && n >= 1 && n <= 10) setValue(n);
  }, []);
  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = Number.parseFloat(e.currentTarget.value);
    setValue(next);
    window.localStorage.setItem(BASELINE_KEY, String(next));
    // Sibling cards listen for this so they re-render with the new
    // baseline without needing a page reload.
    window.dispatchEvent(new Event('selfclaude:baseline-changed'));
  };
  return (
    <span
      className="inline-flex items-center gap-1"
      title={t('home.baseline.tooltip')}
    >
      <span>{t('home.baseline.estimate')}</span>
      <select
        value={value}
        onChange={onChange}
        className="bg-transparent border border-zinc-700/50 hover:border-zinc-500 rounded px-1 py-0.5 text-[10px] font-mono uppercase tracking-widest text-zinc-400 focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
      >
        {BASELINE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.value === 1 ? t('home.baseline.off') : opt.label}
          </option>
        ))}
      </select>
    </span>
  );
}
