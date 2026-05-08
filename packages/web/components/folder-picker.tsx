'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  ChevronRight,
  Code2,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Home,
  Loader2,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';
import type { BrowseEntry, BrowseResult, ProjectSignal } from '@/lib/types';
import { cn } from '@/lib/cn';
import { useTranslation } from '../lib/i18n';

/**
 * Folder picker — landing-screen entry point for "Open project". Three
 * regions:
 *
 *   1. **Quick shortcuts** (left rail): Home, Desktop, Documents, ~/Developer
 *      so the operator doesn't have to navigate up from `/`. Recently-used
 *      sessions also appear here once we have an MRU list to pull from.
 *
 *   2. **Path breadcrumb + filter** (top): each segment is a clickable
 *      button so you can jump up multiple levels in one click. Filter
 *      input narrows the visible entries by name.
 *
 *   3. **Folder list**: each row shows the folder name plus project-
 *      signal badges (git, package.json, .selfclaude…). Single click
 *      navigates into the folder (or selects, with Enter to commit).
 *      Operator confirms via the bottom "Open this folder" button or
 *      double-clicks any row to open + create.
 */

interface Shortcut {
  label: string;
  path: string;
  icon: React.ReactNode;
}

export function FolderPicker({
  onSelect,
  onCancel,
}: {
  onSelect: (path: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);
  // Inline mkdir affordance — operator hits the FolderPlus button to
  // open a small input, types a name, Enter creates + navigates into
  // the new folder. Server-side regex catches invalid names; we
  // surface its error message verbatim so the rule is discoverable.
  const [creating, setCreating] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingError, setCreatingError] = useState<string | null>(null);
  const [creatingPending, setCreatingPending] = useState(false);
  const newFolderRef = useRef<HTMLInputElement>(null);

  const browse = async (path?: string) => {
    setLoading(true);
    setError(null);
    setFilter('');
    try {
      const result = await api.browse(path);
      setData(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void browse();
  }, []);

  // Esc closes; / focuses the filter; Enter on a single match opens it.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        filterRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  const shortcuts: Shortcut[] = useMemo(() => {
    const home = data?.path?.match(/^(\/Users\/[^/]+)/)?.[1] ?? '';
    if (!home) return [];
    return [
      { label: t('folderPicker.shortcuts.home'), path: home, icon: <Home size={13} /> },
      { label: t('folderPicker.shortcuts.desktop'), path: `${home}/Desktop`, icon: <Box size={13} /> },
      { label: t('folderPicker.shortcuts.documents'), path: `${home}/Documents`, icon: <FolderOpen size={13} /> },
      { label: t('folderPicker.shortcuts.developer'), path: `${home}/Developer`, icon: <Code2 size={13} /> },
      { label: t('folderPicker.shortcuts.projects'), path: `${home}/Developer/projects`, icon: <FolderGit2 size={13} /> },
    ];
  }, [data?.path, t]);

  const breadcrumb = useMemo(() => {
    if (!data?.path) return [];
    const parts = data.path.split('/').filter(Boolean);
    const segs: { label: string; path: string }[] = [{ label: '/', path: '/' }];
    let acc = '';
    for (const p of parts) {
      acc += `/${p}`;
      segs.push({ label: p, path: acc });
    }
    return segs;
  }, [data?.path]);

  const visibleEntries = useMemo(() => {
    if (!data) return [];
    const base = data.entries.filter((e) => e.isDir && !e.isHidden);
    if (filter.trim().length === 0) return base;
    const f = filter.trim().toLowerCase();
    return base.filter((e) => e.name.toLowerCase().includes(f));
  }, [data, filter]);

  const handleEntryClick = (e: BrowseEntry) => {
    if (!data) return;
    void browse(joinPath(data.path, e.name));
  };

  const handleEntryDoubleClick = (e: BrowseEntry) => {
    if (!data) return;
    onSelect(joinPath(data.path, e.name));
  };

  const openCreate = () => {
    setCreating(true);
    setNewFolderName('');
    setCreatingError(null);
    // Focus on next tick so the input is mounted.
    setTimeout(() => newFolderRef.current?.focus(), 0);
  };

  const cancelCreate = () => {
    setCreating(false);
    setNewFolderName('');
    setCreatingError(null);
  };

  const submitCreate = async () => {
    if (!data || creatingPending) return;
    const name = newFolderName.trim();
    if (name.length === 0) return;
    setCreatingPending(true);
    setCreatingError(null);
    try {
      const created = await api.mkdir(data.path, name);
      // Refresh the listing so the new folder shows up + then
      // navigate into it (most likely intent for "new project root").
      await browse(created.path);
      setCreating(false);
      setNewFolderName('');
    } catch (e) {
      setCreatingError((e as Error).message);
    } finally {
      setCreatingPending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
      onClick={onCancel}
    >
      <div
        className="bg-bg border border-border-strong w-[820px] max-w-full h-[640px] max-h-[90vh] flex rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sidebar — quick shortcuts */}
        <aside className="w-44 shrink-0 bg-bg-subtle/50 border-r border-border-strong flex flex-col">
          <div className="px-3 py-3 border-b border-border-strong">
            <h3 className="text-[10px] uppercase tracking-widest font-mono font-semibold text-zinc-400">
              {t('folderPicker.sidebar.heading')}
            </h3>
          </div>
          <ul className="flex-1 overflow-y-auto scrollbar-thin py-1">
            {shortcuts.map((s) => (
              <li key={s.path}>
                <button
                  type="button"
                  onClick={() => browse(s.path)}
                  className={cn(
                    'group w-full flex items-center gap-2 px-3 py-1.5 text-[12px] font-mono text-zinc-300 hover:bg-bg-elevated hover:text-zinc-100 transition-colors',
                    data?.path === s.path && 'bg-cyan-950/30 text-cyan-200',
                  )}
                >
                  <span className="text-zinc-500 group-hover:text-cyan-300 shrink-0">
                    {s.icon}
                  </span>
                  <span className="truncate">{s.label}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="px-3 py-2 border-t border-border-strong text-[10px] font-mono text-zinc-600 leading-relaxed">
            <span className="block mb-0.5">{t('folderPicker.sidebar.keys')}</span>
            <span className="block">
              <kbd className="px-1 bg-bg-elevated rounded text-zinc-400">/</kbd> {t('folderPicker.sidebar.keys.filter')}
            </span>
            <span className="block">
              <kbd className="px-1 bg-bg-elevated rounded text-zinc-400">↵</kbd> {t('folderPicker.sidebar.keys.openFolder')}
            </span>
            <span className="block">
              <kbd className="px-1 bg-bg-elevated rounded text-zinc-400">esc</kbd> {t('folderPicker.sidebar.keys.cancel')}
            </span>
          </div>
        </aside>

        {/* Main */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header */}
          <header className="px-5 py-3 border-b border-border-strong flex items-center gap-2">
            <FolderOpen size={16} className="text-cyan-400 shrink-0" />
            <h2 className="text-[14px] font-mono font-semibold text-zinc-100">
              {t('folderPicker.title')}
            </h2>
            <span className="flex-1" />
            <button
              type="button"
              onClick={onCancel}
              className="text-zinc-500 hover:text-zinc-100 w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated"
              aria-label={t('common.close')}
            >
              <X size={14} />
            </button>
          </header>

          {/* Breadcrumb */}
          <div className="px-5 py-2 border-b border-border bg-bg-subtle/30 flex items-center gap-0.5 text-[11px] font-mono overflow-x-auto scrollbar-thin">
            {breadcrumb.map((seg, i) => (
              <span key={seg.path} className="flex items-center gap-0.5 shrink-0">
                <button
                  type="button"
                  onClick={() => browse(seg.path)}
                  className={cn(
                    'px-1.5 py-0.5 rounded hover:bg-bg-elevated transition-colors',
                    i === breadcrumb.length - 1
                      ? 'text-zinc-100 font-semibold'
                      : 'text-zinc-400 hover:text-zinc-100',
                  )}
                >
                  {seg.label}
                </button>
                {i < breadcrumb.length - 1 && (
                  <ChevronRight size={11} className="text-zinc-700" />
                )}
              </span>
            ))}
          </div>

          {/* Filter / new-folder bar */}
          <div className="border-b border-border">
            <div className="px-5 py-2 flex items-center gap-2">
              {creating ? (
                <>
                  <FolderPlus size={12} className="text-cyan-400 shrink-0" />
                  <input
                    ref={newFolderRef}
                    type="text"
                    value={newFolderName}
                    onChange={(e) => {
                      setNewFolderName(e.target.value);
                      setCreatingError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void submitCreate();
                      if (e.key === 'Escape') cancelCreate();
                    }}
                    placeholder={t('folderPicker.newFolder.placeholder')}
                    disabled={creatingPending}
                    className={cn(
                      'flex-1 bg-transparent text-[12px] font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none disabled:opacity-50',
                      newFolderName.length > 0 &&
                        !isValidFolderName(newFolderName) &&
                        'text-red-300',
                    )}
                  />
                  <button
                    type="button"
                    onClick={() => void submitCreate()}
                    disabled={
                      creatingPending ||
                      newFolderName.trim().length === 0 ||
                      !isValidFolderName(newFolderName)
                    }
                    className="shrink-0 px-2 py-0.5 rounded text-[10px] font-mono border border-cyan-700 bg-cyan-900/40 text-cyan-200 hover:bg-cyan-900/60 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {creatingPending ? t('folderPicker.newFolder.creating') : t('folderPicker.newFolder.create')}
                  </button>
                  <button
                    type="button"
                    onClick={cancelCreate}
                    disabled={creatingPending}
                    className="shrink-0 text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
                    aria-label={t('folderPicker.footer.cancel')}
                  >
                    <X size={11} />
                  </button>
                </>
              ) : (
              <>
                <Search size={12} className="text-zinc-500 shrink-0" />
                <input
                  ref={filterRef}
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && visibleEntries.length === 1) {
                      handleEntryClick(visibleEntries[0]!);
                    }
                  }}
                  placeholder={t('folderPicker.filter.placeholder')}
                  className="flex-1 bg-transparent text-[12px] font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none"
                />
                {filter && (
                  <button
                    type="button"
                    onClick={() => setFilter('')}
                    className="text-zinc-500 hover:text-zinc-200 shrink-0"
                    aria-label={t('folderPicker.filter.clear')}
                  >
                    <X size={11} />
                  </button>
                )}
                <span className="text-[10px] font-mono text-zinc-600 tabular-nums shrink-0">
                  {visibleEntries.length}
                </span>
                <button
                  type="button"
                  onClick={openCreate}
                  disabled={!data}
                  className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono border border-border bg-bg-elevated/40 text-zinc-300 hover:bg-bg-elevated/70 disabled:opacity-50"
                  title={t('folderPicker.newFolder.title')}
                >
                  <FolderPlus size={11} />
                  {t('folderPicker.newFolder.label')}
                </button>
              </>
            )}
            </div>
            {/* Hint / live validation strip — only when creating. Shows
                the rule + the cleaned slug suggestion + any server
                error in one consistent row. */}
            {creating && (
              <div className="px-5 pb-2 -mt-1 flex items-center gap-2 text-[10px] font-mono">
                {creatingError ? (
                  <span className="text-red-400 truncate" title={creatingError}>
                    ⚠ {creatingError}
                  </span>
                ) : newFolderName.length > 0 &&
                  !isValidFolderName(newFolderName) ? (
                  <span className="text-amber-400">
                    {t('folderPicker.validation.invalidChars')}
                  </span>
                ) : (
                  <span className="text-zinc-600">
                    {t('folderPicker.validation.example')}{' '}
                    <code className="text-zinc-400">kick-crm</code>,{' '}
                    <code className="text-zinc-400">my new project</code>,{' '}
                    <code className="text-zinc-400">api_v2</code>
                  </span>
                )}
                {/* Slug suggestion when the name has spaces/uppercase/etc. */}
                {newFolderName.length > 0 &&
                  isValidFolderName(newFolderName) &&
                  newFolderName !== slugifyFolderName(newFolderName) && (
                    <span className="ml-auto text-zinc-500 inline-flex items-center gap-1.5">
                      {t('folderPicker.validation.use')}
                      <button
                        type="button"
                        onClick={() => setNewFolderName(slugifyFolderName(newFolderName))}
                        className="text-cyan-400 hover:text-cyan-300 underline"
                      >
                        {slugifyFolderName(newFolderName)}
                      </button>
                      ?
                    </span>
                  )}
              </div>
            )}
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto scrollbar-thin">
            {loading && (
              <div className="p-6 flex items-center gap-2 text-[12px] font-mono text-zinc-500">
                <Loader2 size={14} className="animate-spin" />
                {t('common.loading')}
              </div>
            )}
            {error && (
              <div className="p-6 text-[12px] font-mono text-red-400">{error}</div>
            )}
            {!loading && !error && visibleEntries.length === 0 && (
              <div className="p-6 text-[12px] font-mono text-zinc-500 italic">
                {filter ? t('folderPicker.list.noMatches', { filter }) : t('folderPicker.list.noSubfolders')}
              </div>
            )}
            {!loading && !error && (
              <ul>
                {visibleEntries.map((e) => (
                  <FolderRow
                    key={e.name}
                    entry={e}
                    onClick={() => handleEntryClick(e)}
                    onDoubleClick={() => handleEntryDoubleClick(e)}
                  />
                ))}
              </ul>
            )}
          </div>

          {/* Footer */}
          <footer className="px-5 py-3 border-t border-border-strong bg-bg-subtle/30 flex items-center gap-3">
            <code className="flex-1 min-w-0 text-[11px] font-mono text-zinc-400 truncate" title={data?.path}>
              {data?.path ?? '…'}
            </code>
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 text-[11px] font-mono rounded border border-border bg-bg-elevated/40 text-zinc-300 hover:bg-bg-elevated/70"
            >
              {t('folderPicker.footer.cancel')}
            </button>
            <button
              type="button"
              onClick={() => data && onSelect(data.path)}
              disabled={!data}
              className="px-3 py-1.5 text-[11px] font-mono font-medium rounded border border-cyan-600 bg-cyan-700 text-white hover:bg-cyan-600 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <FolderOpen size={12} />
              {t('folderPicker.footer.open')}
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}

function FolderRow({
  entry,
  onClick,
  onDoubleClick,
}: {
  entry: BrowseEntry;
  onClick: () => void;
  onDoubleClick: () => void;
}) {
  const isProject = entry.signals.length > 0;
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        className={cn(
          'group w-full flex items-center gap-2.5 px-5 py-2 text-left hover:bg-bg-elevated transition-colors border-l-2',
          isProject ? 'border-l-cyan-700/50' : 'border-l-transparent',
        )}
      >
        {isProject ? (
          <FolderGit2 size={14} className="shrink-0 text-cyan-400" />
        ) : (
          <Folder size={14} className="shrink-0 text-zinc-500 group-hover:text-zinc-300" />
        )}
        <span className="flex-1 min-w-0 text-[12px] font-mono text-zinc-200 truncate">
          {entry.name}
        </span>
        <SignalBadges signals={entry.signals} />
      </button>
    </li>
  );
}

function SignalBadges({ signals }: { signals: ProjectSignal[] }) {
  const { t } = useTranslation();
  if (signals.length === 0) return null;

  const SIGNAL_META: Record<
    ProjectSignal,
    { label: string; icon: React.ReactNode; color: string; title: string }
  > = {
    git: {
      label: t('folderPicker.signals.git.label'),
      icon: <GitBranch size={9} />,
      color: 'bg-orange-950/40 text-orange-300 border-orange-800/50',
      title: t('folderPicker.signals.git.title'),
    },
    selfclaude: {
      label: t('folderPicker.signals.sc.label'),
      icon: <Sparkles size={9} />,
      color: 'bg-cyan-950/40 text-cyan-300 border-cyan-800/50',
      title: t('folderPicker.signals.sc.title'),
    },
    node: {
      label: t('folderPicker.signals.node.label'),
      icon: null,
      color: 'bg-emerald-950/40 text-emerald-300 border-emerald-800/50',
      title: t('folderPicker.signals.node.title'),
    },
    rust: {
      label: t('folderPicker.signals.rust.label'),
      icon: null,
      color: 'bg-amber-950/40 text-amber-300 border-amber-800/50',
      title: t('folderPicker.signals.rust.title'),
    },
    python: {
      label: t('folderPicker.signals.py.label'),
      icon: null,
      color: 'bg-blue-950/40 text-blue-300 border-blue-800/50',
      title: t('folderPicker.signals.py.title'),
    },
    go: {
      label: t('folderPicker.signals.go.label'),
      icon: null,
      color: 'bg-sky-950/40 text-sky-300 border-sky-800/50',
      title: t('folderPicker.signals.go.title'),
    },
  };

  // Order: selfclaude first (most relevant for our flow), then language,
  // then git. Operator scans for "already a SelfClaude project" first.
  const order: ProjectSignal[] = ['selfclaude', 'node', 'rust', 'python', 'go', 'git'];
  const sorted = signals
    .slice()
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return (
    <span className="flex items-center gap-1 shrink-0">
      {sorted.map((s) => {
        const m = SIGNAL_META[s];
        return (
          <span
            key={s}
            className={cn(
              'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-mono uppercase tracking-wide border',
              m.color,
            )}
            title={m.title}
          >
            {m.icon}
            {m.label}
          </span>
        );
      })}
    </span>
  );
}

function joinPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

/**
 * Mirror of the server-side regex (web-api.ts /api/browse/mkdir):
 * letters, digits, spaces, dots, underscores, hyphens. No slashes,
 * no traversal segments. Used for client-side pre-validation so the
 * "create" button disables before the operator hits a 400.
 */
function isValidFolderName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return false;
  if (trimmed === '.' || trimmed === '..') return false;
  if (/[/\\]/.test(trimmed)) return false;
  return /^[A-Za-z0-9._ -]+$/.test(trimmed);
}

/**
 * Suggest a kebab-case slug for the operator-typed name — useful when
 * the name has spaces or capitals and a sluggy version would be
 * shell-friendlier. Lowercase, spaces → hyphens, collapse runs.
 */
function slugifyFolderName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '');
}
