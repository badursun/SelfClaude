'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  Activity,
  Check,
  Copy,
  FileText,
  Globe,
  RotateCcw,
  Save,
  Settings as SettingsIcon,
  X,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { api, type SystemPromptInfo } from '@/lib/api';
import { useTranslation, type TranslationKey } from '../lib/i18n';
import { LanguageSwitcher } from './language-switcher';

/**
 * Global settings modal. Today its single section is the agent
 * **system-prompt editor** — the operator can tune any built-in role's
 * behaviour without touching the bundled package source. Edits are
 * saved to `~/.selfclaude/system-prompts/<file>` and the next agent
 * turn picks them up (registry's `loadAgentPrompt` is mtime-cached).
 *
 * Future sections: tech stack picker (Sprint 3 polish), agent registry
 * extension (custom roles), notification preferences, theme toggles.
 * They'll slot in as additional left-rail entries; the prompt editor is
 * the v1 baseline.
 *
 * Closes on Esc, on the X button, or on backdrop click. Save / Reset
 * actions are per-agent — selecting a different agent doesn't lose
 * unsaved edits to the current one (state is held per-agent).
 */
type SettingsTab = 'prompts' | 'mcp-tools' | 'language';

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const params = useParams<{ id?: string }>();
  const sessionId = params?.id ?? null;
  const { t } = useTranslation();
  const [tab, setTab] = useState<SettingsTab>('prompts');
  const [prompts, setPrompts] = useState<SystemPromptInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  // Per-agent draft + dirty state. We keep all drafts in memory so the
  // operator can switch tabs mid-edit without losing work.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingAgent, setSavingAgent] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  // Fetch on mount.
  useEffect(() => {
    let cancelled = false;
    api
      .listSystemPrompts()
      .then((r) => {
        if (cancelled) return;
        setPrompts(r.prompts);
        setActiveAgent(r.prompts[0]?.agent ?? null);
        setDrafts(
          Object.fromEntries(r.prompts.map((p) => [p.agent, p.currentContent])),
        );
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const active = useMemo(
    () => prompts?.find((p) => p.agent === activeAgent) ?? null,
    [prompts, activeAgent],
  );
  const draft = active ? drafts[active.agent] ?? active.currentContent : '';
  const dirty = active ? draft !== active.currentContent : false;

  const handleSave = async () => {
    if (!active || !dirty || savingAgent) return;
    setSavingAgent(active.agent);
    setError(null);
    try {
      await api.saveSystemPrompt(active.agent, draft);
      // Refresh the local source-of-truth so subsequent diffs are honest.
      setPrompts((p) =>
        (p ?? []).map((row) =>
          row.agent === active.agent
            ? { ...row, currentContent: draft, source: 'override' as const }
            : row,
        ),
      );
      setSavedNotice(t('settings.prompts.savedNotice', { label: active.label }));
      setTimeout(() => setSavedNotice(null), 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingAgent(null);
    }
  };

  const handleReset = async () => {
    if (!active || savingAgent) return;
    if (active.source !== 'override') return;
    if (!confirm(t('settings.prompts.confirmReset', { label: active.label }))) return;
    setSavingAgent(active.agent);
    setError(null);
    try {
      await api.resetSystemPrompt(active.agent);
      setPrompts((p) =>
        (p ?? []).map((row) =>
          row.agent === active.agent
            ? { ...row, currentContent: row.defaultContent, source: 'default' as const }
            : row,
        ),
      );
      setDrafts((d) => ({ ...d, [active.agent]: active.defaultContent }));
      setSavedNotice(t('settings.prompts.resetNotice', { label: active.label }));
      setTimeout(() => setSavedNotice(null), 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingAgent(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[90] bg-black/75 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-bg border-2 border-border-strong rounded-lg w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b-2 border-border-strong bg-bg-elevated">
          <SettingsIcon size={16} className="text-cyan-400" />
          <h2 className="text-sm font-semibold text-zinc-100">{t('settings.title')}</h2>
          <div className="ml-3 flex items-center gap-1">
            <SettingsTabButton
              active={tab === 'prompts'}
              icon={<FileText size={12} />}
              label={t('settings.tab.agentPrompts')}
              onClick={() => setTab('prompts')}
            />
            <SettingsTabButton
              active={tab === 'mcp-tools'}
              icon={<Activity size={12} />}
              label={t('settings.tab.mcpTools')}
              onClick={() => setTab('mcp-tools')}
              disabled={!sessionId}
              tooltip={!sessionId ? t('settings.tab.mcpTools.disabled') : undefined}
            />
            <SettingsTabButton
              active={tab === 'language'}
              icon={<Globe size={12} />}
              label={t('settings.tab.language')}
              onClick={() => setTab('language')}
            />
          </div>
          <span className="flex-1" />
          {savedNotice && (
            <span className="text-[11px] text-emerald-400 flex items-center gap-1">
              <Check size={12} /> {savedNotice}
            </span>
          )}
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-100 p-0.5"
            aria-label={t('settings.close')}
          >
            <X size={16} />
          </button>
        </div>
        {/* Body — sub-tab routes */}
        {tab === 'mcp-tools' && sessionId && (
          <McpToolsTab sessionId={sessionId} />
        )}
        {tab === 'language' && (
          <div className="flex-1 flex items-center justify-center p-8">
            <LanguageSwitcher />
          </div>
        )}
        {tab === 'prompts' && (
        <div className="flex-1 flex min-h-0">
          {/* Left rail */}
          <aside className="w-[200px] shrink-0 border-r-2 border-border-strong bg-bg-subtle overflow-y-auto scrollbar-thin">
            <div className="px-3 py-2 text-[10px] uppercase tracking-widest text-zinc-500 font-mono font-semibold">
              {t('settings.prompts.railHeading')}
            </div>
            {!prompts && !error && (
              <div className="p-3 text-[11px] text-zinc-500 italic">loading…</div>
            )}
            {error && (
              <div className="p-3 text-[11px] text-red-400 italic">{error}</div>
            )}
            {prompts?.map((p) => (
              <button
                key={p.agent}
                onClick={() => setActiveAgent(p.agent)}
                className={cn(
                  'w-full text-left px-3 py-2 border-l-2 transition-colors',
                  p.agent === activeAgent
                    ? 'border-l-cyan-500 bg-bg-elevated'
                    : 'border-l-transparent hover:bg-bg-elevated/50',
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'text-[11px] font-mono font-semibold',
                      AGENT_TEXT_ACCENT[p.accent] ?? 'text-zinc-200',
                    )}
                  >
                    {p.label}
                  </span>
                  {p.source === 'override' && (
                    <span
                      className="text-[9px] uppercase tracking-wider px-1 rounded bg-amber-900/40 text-amber-300"
                      title={t('settings.prompts.badge.custom.title')}
                    >
                      {t('settings.prompts.badge.custom')}
                    </span>
                  )}
                  {drafts[p.agent] !== undefined &&
                    drafts[p.agent] !== p.currentContent && (
                      <span className="text-amber-400 text-xs" title={t('settings.prompts.badge.unsaved.title')}>
                        ●
                      </span>
                    )}
                </div>
                <p className="text-[10px] text-zinc-500 mt-0.5 leading-tight">
                  {p.description.slice(0, 80)}
                  {p.description.length > 80 && '…'}
                </p>
              </button>
            ))}
          </aside>
          {/* Right editor */}
          <div className="flex-1 flex flex-col min-w-0">
            {active && (
              <>
                <div className="px-4 py-2 border-b border-border bg-bg-subtle/60 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-mono text-zinc-200">
                      {active.label}
                      <span className="ml-2 text-[10px] text-zinc-500">
                        {active.source === 'override'
                          ? t('settings.prompts.source.override')
                          : t('settings.prompts.source.default')}
                      </span>
                    </div>
                    <div className="text-[10px] text-zinc-500 mt-0.5">
                      {t('settings.prompts.chars', { charCount: draft.length.toLocaleString(), filePath: `~/.selfclaude/system-prompts/${active.agent}.md` })}
                    </div>
                  </div>
                  <CopyButton text={draft} />
                  {active.source === 'override' && (
                    <button
                      onClick={handleReset}
                      disabled={!!savingAgent}
                      className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border hover:bg-bg-elevated text-zinc-300 disabled:opacity-50"
                      title={t('settings.prompts.resetButton.title')}
                    >
                      <RotateCcw size={11} />
                      reset
                    </button>
                  )}
                  <button
                    onClick={handleSave}
                    disabled={!dirty || !!savingAgent}
                    className={cn(
                      'flex items-center gap-1 px-3 py-1 text-[11px] rounded font-medium border',
                      dirty && !savingAgent
                        ? 'bg-cyan-600 hover:bg-cyan-500 border-cyan-700 text-white'
                        : 'bg-zinc-800 text-zinc-500 cursor-not-allowed border-zinc-700',
                    )}
                    title={t('settings.prompts.saveTitle')}
                  >
                    <Save size={11} />
                    {savingAgent === active.agent ? 'saving…' : 'save'}
                  </button>
                </div>
                <textarea
                  value={draft}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [active.agent]: e.target.value }))
                  }
                  spellCheck={false}
                  className="flex-1 bg-bg-subtle p-3 text-[12px] leading-[16px] font-mono text-zinc-100 outline-none resize-none scrollbar-thin"
                />
              </>
            )}
            {!active && !error && (
              <div className="flex-1 flex items-center justify-center text-zinc-500 text-[11px] italic">
                {t('settings.prompts.emptyState')}
              </div>
            )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

function SettingsTabButton({
  active,
  icon,
  label,
  onClick,
  disabled,
  tooltip,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tooltip?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={tooltip}
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-mono transition-colors',
        active
          ? 'bg-cyan-900/40 text-cyan-200 border border-cyan-700/50'
          : 'text-zinc-400 hover:text-zinc-100 hover:bg-bg-elevated border border-transparent',
        disabled && 'opacity-40 cursor-not-allowed hover:bg-transparent hover:text-zinc-400',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * "MCP tools" tab — per-tool usage stats + recent calls. Hydrates from
 * `/api/sessions/:id/mcp-telemetry`. Refreshable manually; otherwise
 * static (no SSE event for telemetry yet — operator opens the modal
 * to peek, doesn't watch it live).
 */
function McpToolsTab({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const [data, setData] = useState<{
    tools: Record<
      string,
      {
        name: string;
        total: number;
        success: number;
        failure: number;
        lastCalledAt: string | null;
        lastFailedAt: string | null;
        recent: { ts: number; agent: string; success: boolean; message: string }[];
      }
    >;
    updatedAt: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedTool, setSelectedTool] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getMcpTelemetry(sessionId)
      .then((r) => {
        if (cancelled) return;
        setData({ tools: r.tools, updatedAt: r.updatedAt });
        // Auto-select first tool that has any calls; fallback to first key.
        const used = Object.keys(r.tools).find(
          (k) => (r.tools[k]?.total ?? 0) > 0,
        );
        setSelectedTool((cur) => cur ?? used ?? Object.keys(r.tools)[0] ?? null);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey]);

  // Canonical list of every MCP tool the orchestrator ships — surfaced
  // even when it's never been called so the operator sees zero-usage
  // tools (a signal that the prompt directive isn't landing).
  const KNOWN_TOOLS: { name: string; description: string }[] = [
    { name: 'ask_user', description: t('settings.mcp.toolDescriptions.askUser') },
    { name: 'request_user_approval', description: t('settings.mcp.toolDescriptions.requestApproval') },
    { name: 'write_phase_doc', description: t('settings.mcp.toolDescriptions.writePhaseDoc') },
    { name: 'register_phase_items', description: t('settings.mcp.toolDescriptions.registerPhaseItems') },
    { name: 'propose_item_done', description: t('settings.mcp.toolDescriptions.proposeItemDone') },
    { name: 'confirm_item_done', description: t('settings.mcp.toolDescriptions.confirmItemDone') },
    { name: 'reject_item_done', description: t('settings.mcp.toolDescriptions.rejectItemDone') },
    { name: 'apply_agent_dna', description: t('settings.mcp.toolDescriptions.applyAgentDna') },
  ];

  const merged = KNOWN_TOOLS.map((t) => ({
    ...t,
    stat: data?.tools[t.name] ?? null,
  }));
  const selected = merged.find((m) => m.name === selectedTool) ?? null;

  return (
    <div className="flex-1 flex min-h-0">
      <aside className="w-[260px] shrink-0 border-r-2 border-border-strong bg-bg-subtle overflow-y-auto scrollbar-thin">
        <div className="px-3 py-2 border-b border-border flex items-center gap-2">
          <span className="flex-1 text-[10px] uppercase tracking-widest text-zinc-500 font-mono font-semibold">
            {t('settings.mcp.railHeading')}
          </span>
          <button
            type="button"
            onClick={() => setRefreshKey((k) => k + 1)}
            className="text-[10px] text-zinc-500 hover:text-zinc-200"
            title={t('settings.mcp.refresh')}
          >
            ↻
          </button>
        </div>
        {error && (
          <div className="p-3 text-[11px] text-red-400 italic">{error}</div>
        )}
        {!data && !error && (
          <div className="p-3 text-[11px] text-zinc-500 italic">loading…</div>
        )}
        <ul className="py-1">
          {merged.map((m) => {
            const total = m.stat?.total ?? 0;
            const fail = m.stat?.failure ?? 0;
            const isSelected = selectedTool === m.name;
            return (
              <li key={m.name}>
                <button
                  type="button"
                  onClick={() => setSelectedTool(m.name)}
                  className={cn(
                    'w-full text-left px-3 py-2 border-l-2 transition-colors',
                    isSelected
                      ? 'border-l-cyan-500 bg-bg-elevated'
                      : 'border-l-transparent hover:bg-bg-elevated/50',
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-mono text-zinc-200 truncate flex-1">
                      {m.name}
                    </span>
                    {total === 0 ? (
                      <span className="text-[9px] uppercase tracking-wide text-zinc-600">
                        {t('settings.mcp.badge.unused')}
                      </span>
                    ) : (
                      <span className="text-[10px] tabular-nums font-mono text-zinc-400">
                        {total}
                        {fail > 0 && (
                          <span className="text-red-400 ml-1">·{fail}✗</span>
                        )}
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-zinc-500 mt-0.5 leading-tight line-clamp-2">
                    {m.description}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
        {selected ? (
          <McpToolDetail
            name={selected.name}
            description={selected.description}
            stat={selected.stat}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-[11px] italic text-zinc-500">
            {t('settings.mcp.emptyState')}
          </div>
        )}
      </div>
    </div>
  );
}

function McpToolDetail({
  name,
  description,
  stat,
}: {
  name: string;
  description: string;
  stat: {
    name: string;
    total: number;
    success: number;
    failure: number;
    lastCalledAt: string | null;
    lastFailedAt: string | null;
    recent: { ts: number; agent: string; success: boolean; message: string }[];
  } | null;
}) {
  const { t } = useTranslation();
  const successRate =
    stat && stat.total > 0
      ? Math.round((stat.success / stat.total) * 100)
      : null;

  return (
    <>
      <div className="px-4 py-3 border-b border-border bg-bg-subtle/60">
        <code className="text-[13px] font-mono font-semibold text-zinc-100">
          {name}
        </code>
        <p className="text-[11px] text-zinc-400 mt-1 leading-relaxed">
          {description}
        </p>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {!stat || stat.total === 0 ? (
          <div className="p-6">
            <div className="rounded border border-zinc-800 bg-zinc-900/50 px-4 py-3">
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                <span className="text-zinc-300 font-mono">{t('settings.mcp.noCalls')}</span>{' '}
                {t('settings.mcp.noCalls.hint')}
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3 p-4 border-b border-border">
              <Stat label={t('settings.mcp.stat.total')} value={stat.total} />
              <Stat
                label={t('settings.mcp.stat.success')}
                value={`${stat.success}${successRate !== null ? ` · ${successRate}%` : ''}`}
                accent="emerald"
              />
              <Stat
                label={t('settings.mcp.stat.failure')}
                value={stat.failure}
                accent={stat.failure > 0 ? 'red' : 'zinc'}
              />
            </div>
            <div className="p-4 space-y-1.5">
              <div className="flex items-baseline gap-2 text-[10px] font-mono uppercase tracking-widest text-zinc-500 mb-1">
                <span>{t('settings.mcp.recentCalls')}</span>
                <span className="text-zinc-700">·</span>
                <span>{stat.recent.length}</span>
              </div>
              <ul className="space-y-1">
                {stat.recent.map((r, i) => (
                  <li
                    key={i}
                    className={cn(
                      'flex items-baseline gap-2 px-2 py-1 rounded text-[11px] font-mono',
                      r.success
                        ? 'bg-bg-elevated/30'
                        : 'bg-red-950/20 border-l-2 border-l-red-600',
                    )}
                  >
                    <span
                      className={cn(
                        'text-[10px] tabular-nums',
                        r.success ? 'text-emerald-400' : 'text-red-400',
                      )}
                    >
                      {r.success ? '✓' : '✗'}
                    </span>
                    <span className="shrink-0 text-zinc-500 tabular-nums w-[80px]">
                      {formatRelative(r.ts, t)}
                    </span>
                    <span className="shrink-0 text-cyan-400">{r.agent}</span>
                    {r.message && (
                      <span className="flex-1 text-zinc-400 truncate" title={r.message}>
                        {r.message}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  accent = 'cyan',
}: {
  label: string;
  value: string | number;
  accent?: 'cyan' | 'emerald' | 'red' | 'zinc';
}) {
  const color = {
    cyan: 'text-cyan-300',
    emerald: 'text-emerald-300',
    red: 'text-red-300',
    zinc: 'text-zinc-300',
  }[accent];
  return (
    <div className="rounded border border-border bg-bg-subtle/60 px-3 py-2">
      <div className="text-[9px] uppercase tracking-widest font-mono text-zinc-500 mb-0.5">
        {label}
      </div>
      <div className={cn('text-[14px] font-mono font-semibold tabular-nums', color)}>
        {value}
      </div>
    </div>
  );
}

function formatRelative(ts: number, t: (key: TranslationKey, vars?: Record<string, string | number>) => string): string {
  const ms = Date.now() - ts;
  if (ms < 60_000) return t('settings.mcp.relativeTime.seconds', { sec: Math.floor(ms / 1000) });
  if (ms < 3_600_000) return t('settings.mcp.relativeTime.minutes', { min: Math.floor(ms / 60_000) });
  if (ms < 86_400_000) return t('settings.mcp.relativeTime.hours', { hr: Math.floor(ms / 3_600_000) });
  return t('settings.mcp.relativeTime.days', { day: Math.floor(ms / 86_400_000) });
}

const AGENT_TEXT_ACCENT: Record<string, string> = {
  cyan: 'text-cyan-300',
  amber: 'text-amber-300',
  violet: 'text-violet-300',
  rose: 'text-rose-300',
  emerald: 'text-emerald-300',
  zinc: 'text-zinc-300',
};

/**
 * Copy-the-prompt-text-to-clipboard button. Mostly useful when the
 * operator wants to paste a tuned prompt elsewhere or compare side-by-
 * side with another tool.
 */
function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* silent */
        }
      }}
      className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border hover:bg-bg-elevated text-zinc-300"
      title={t('settings.mcp.copyPrompt')}
    >
      {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
    </button>
  );
}
