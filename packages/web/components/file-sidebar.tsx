'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  RefreshCw,
  Settings,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useTranslation } from '../lib/i18n';
import {
  api,
  type ProjectTree,
  type ProjectTreeGroup,
} from '@/lib/api';
import { useSessionStore } from '@/lib/store';
import { FilePreviewModal } from './file-preview-modal';

/**
 * Left sidebar — curated project file tree only. The "context" tabs
 * (phases, memory, decisions, agents-room, stack, …) live in the right
 * activity-bar (`<RightSidebar>`) where they have horizontal room to
 * breathe; this rail stays narrow and focused on filesystem nav.
 *
 * Two modes:
 *
 *  - Collapsed (default rail): a thin 36px column with one toggle icon.
 *  - Expanded: 240px panel showing the grouped tree.
 *
 * Sidebar state is component-local — toggled from the rail icon.
 */
export function FileSidebar({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  // Manual refresh — increments to trigger FilesTab's useEffect.
  // SSE-driven auto-refresh covers most cases (Write/Edit/MultiEdit
  // tool calls + phase-doc-written), but a button is useful for the
  // odd case where the operator edits files outside the agent flow
  // and wants the tree without waiting for the 30s polling fallback.
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = () => {
    setRefreshing(true);
    setRefreshKey((k) => k + 1);
    // Match the typical fetch round-trip + a beat for visual feedback.
    setTimeout(() => setRefreshing(false), 600);
  };

  return (
    <>
      <aside
        className={cn(
          'h-full flex transition-[width] duration-150 shrink-0',
          expanded ? 'w-[280px]' : 'w-[58px]',
        )}
      >
        <div className="w-[58px] shrink-0 bg-zinc-900 border-r-2 border-border-strong flex flex-col items-center py-1.5 gap-0.5">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            title={expanded ? t('fileSidebar.collapse') : t('fileSidebar.expand')}
            className={cn(
              'w-12 py-1 rounded flex flex-col items-center justify-center gap-0.5 transition-colors',
              expanded
                ? 'bg-cyan-900/40 text-cyan-300 hover:bg-cyan-900/60'
                : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800',
            )}
          >
            {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
            <span className="text-[9px] font-mono uppercase tracking-wide leading-none">
              {t('fileSidebar.label')}
            </span>
          </button>
        </div>
        {expanded && (
          <div className="flex-1 flex flex-col bg-zinc-900/70 border-r-2 border-border-strong min-w-0">
            <div className="h-7 flex items-center gap-2 px-2.5 border-b-2 border-border-strong bg-zinc-900">
              <span className="flex-1 text-[10px] font-mono uppercase tracking-widest text-zinc-300 font-semibold">
                {t('fileSidebar.label')}
              </span>
              <button
                type="button"
                onClick={handleRefresh}
                disabled={refreshing}
                title={t('fileSidebar.refresh')}
                aria-label={t('fileSidebar.refresh.ariaLabel')}
                className="text-zinc-500 hover:text-zinc-200 disabled:opacity-50 transition-colors"
              >
                <RefreshCw
                  size={11}
                  className={cn(refreshing && 'animate-spin')}
                />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto scrollbar-thin">
              <FilesTab
                sessionId={sessionId}
                refreshKey={refreshKey}
                onPreview={(p) => setPreviewPath(p)}
              />
            </div>
          </div>
        )}
      </aside>
      {previewPath && (
        <FilePreviewModal
          sessionId={sessionId}
          path={previewPath}
          onClose={() => setPreviewPath(null)}
        />
      )}
    </>
  );
}

function FilesTab({
  sessionId,
  refreshKey,
  onPreview,
}: {
  sessionId: string;
  /** Bumped by the parent's manual refresh button to force a refetch. */
  refreshKey: number;
  onPreview: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [tree, setTree] = useState<ProjectTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Trigger a re-fetch whenever an agent writes/edits a file or sup
  // emits a phase-doc-written event. The chat-log is already synced
  // in real time via SSE; we just compute the max timestamp of
  // file-mutation entries and re-run the fetch when that bumps.
  const chatLog = useSessionStore((s) => s.sessions[sessionId]?.chatLog);
  const lastFileMutationTs = useMemo(() => {
    if (!chatLog) return 0;
    let max = 0;
    for (const e of chatLog) {
      if (e.type === 'phase-doc-written') {
        if (e.ts > max) max = e.ts;
        continue;
      }
      // Filter file-writing tool calls (sup, dev, specialists).
      if (
        e.type === 'dev-tool-call' ||
        e.type === 'sup-tool-call' ||
        e.type === 'agent-tool-call'
      ) {
        if (e.name === 'Write' || e.name === 'Edit' || e.name === 'MultiEdit') {
          if (e.ts > max) max = e.ts;
        }
      }
    }
    return max;
  }, [chatLog]);

  useEffect(() => {
    let cancelled = false;
    api
      .listProjectFiles(sessionId)
      .then((t) => {
        if (!cancelled) setTree(t);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    // 30s polling fallback for file changes outside the agent flow
    // (operator-initiated edits via the editor or external tools).
    const t = setInterval(() => {
      api
        .listProjectFiles(sessionId)
        .then((res) => {
          if (!cancelled) setTree(res);
        })
        .catch(() => {
          /* keep last good */
        });
    }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [sessionId, lastFileMutationTs, refreshKey]);

  return (
    <>
      {error && <div className="p-2 text-[10px] text-red-400 italic">{error}</div>}
      {!tree && !error && (
        <div className="p-2 text-[10px] text-zinc-500 italic">{t('common.loading')}</div>
      )}
      {tree?.groups.length === 0 && (
        <div className="p-2 text-[10px] text-zinc-500 italic">
          {t('fileSidebar.noFiles')}
        </div>
      )}
      {tree?.groups.map((g, i) => (
        <FileGroup key={i} group={g} onPick={onPreview} />
      ))}
    </>
  );
}

function FileGroup({
  group,
  onPick,
}: {
  group: ProjectTreeGroup;
  onPick: (path: string) => void;
}) {
  // Operator preference: every group expanded by default — they want
  // visibility, not auto-folded internals. Operator can still collapse
  // any group manually via the chevron.
  const [open, setOpen] = useState(true);

  if (group.group === 'root') {
    return (
      <ul className="py-1">
        {group.files.map((f) => (
          <FileEntry key={f.path} path={f.path} name={f.name} onPick={onPick} indent={1} />
        ))}
      </ul>
    );
  }

  // Files come in with `name` containing any subdir prefix
  // (e.g. `hooks/pretool.sh`). Build a recursive subtree on the
  // frontend so subfolders render as nested collapsible folders
  // — much easier to scan a 20-file `.selfclaude/` listing this way
  // than as a flat alpha-sorted blob.
  const tree = useMemo(() => buildSubTree(group.files), [group.files]);
  const Icon = group.group === 'selfclaude' ? Settings : Folder;
  const accent = group.group === 'selfclaude' ? 'text-amber-400' : 'text-zinc-300';

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          'w-full flex items-center gap-1.5 px-2 py-1 text-left hover:bg-bg-panel/40',
          accent,
        )}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <Icon size={11} />
        <span className="text-[10px] font-mono uppercase tracking-wide font-semibold">
          {group.label}
        </span>
        <span className="text-[10px] text-zinc-500 tabular-nums">({group.files.length})</span>
      </button>
      {open && <SubTreeNode node={tree} onPick={onPick} indent={2} />}
    </div>
  );
}

/* ───────────────── Recursive subtree ─────────────────
 *
 * Backend returns a flat file list per group; each `name` field is
 * `relative/path/to/file.ext` so subfolders are encoded in the
 * separator. Splitting on `/` and inserting into a directory map
 * gives us a nested render tree. Folders auto-expand by default
 * (matches the operator-preference of "show everything").
 */
interface SubTreeNode {
  /** Folders keyed by name. Sorted alphabetically when rendered. */
  dirs: Map<string, SubTreeNode>;
  /** Files at this level. */
  files: { name: string; path: string }[];
}

function buildSubTree(files: ProjectTreeGroup['files']): SubTreeNode {
  const root: SubTreeNode = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.name.split('/').filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      let next = node.dirs.get(seg);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(seg, next);
      }
      node = next;
    }
    const leaf = parts[parts.length - 1]!;
    node.files.push({ name: leaf, path: f.path });
  }
  return root;
}

function SubTreeNode({
  node,
  onPick,
  indent,
}: {
  node: SubTreeNode;
  onPick: (path: string) => void;
  indent: number;
}) {
  const dirs = Array.from(node.dirs.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const files = node.files.slice().sort((a, b) => a.name.localeCompare(b.name));
  return (
    <ul>
      {dirs.map(([name, child]) => (
        <SubTreeFolder
          key={`d-${name}`}
          name={name}
          child={child}
          onPick={onPick}
          indent={indent}
        />
      ))}
      {files.map((f) => (
        <FileEntry
          key={`f-${f.path}`}
          path={f.path}
          name={f.name}
          onPick={onPick}
          indent={indent}
        />
      ))}
    </ul>
  );
}

function SubTreeFolder({
  name,
  child,
  onPick,
  indent,
}: {
  name: string;
  child: SubTreeNode;
  onPick: (path: string) => void;
  indent: number;
}) {
  const [open, setOpen] = useState(true);
  const totalCount = countSubTreeFiles(child);
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1 py-0.5 text-left hover:bg-bg-panel/30 text-zinc-400 hover:text-zinc-200"
        style={{ paddingLeft: `${indent * 12 + 4}px` }}
      >
        {open ? (
          <ChevronDown size={10} className="shrink-0" />
        ) : (
          <ChevronRight size={10} className="shrink-0" />
        )}
        <Folder size={10} className="shrink-0 text-zinc-500" />
        <span className="text-[10px] font-mono">{name}</span>
        <span className="text-[10px] text-zinc-600 tabular-nums">
          ({totalCount})
        </span>
      </button>
      {open && <SubTreeNode node={child} onPick={onPick} indent={indent + 1} />}
    </li>
  );
}

function countSubTreeFiles(node: SubTreeNode): number {
  let n = node.files.length;
  for (const child of node.dirs.values()) {
    n += countSubTreeFiles(child);
  }
  return n;
}

function FileEntry({
  path,
  name,
  onPick,
  indent,
}: {
  path: string;
  name: string;
  onPick: (path: string) => void;
  indent: number;
}) {
  return (
    <li>
      <button
        onClick={() => onPick(path)}
        className="w-full flex items-center gap-1.5 px-2 py-0.5 hover:bg-bg-panel/50 text-left"
        style={{ paddingLeft: `${indent * 12 + 4}px` }}
        title={path}
      >
        <FileText size={10} className="shrink-0 text-zinc-500" />
        <span className="text-[10px] font-mono text-zinc-300 truncate">{name}</span>
      </button>
    </li>
  );
}
