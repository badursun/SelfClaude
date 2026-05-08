'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlarmClock,
  Boxes,
  Brain,
  CalendarClock,
  Check,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  Copy,
  Download,
  ExternalLink,
  FileEdit,
  FileText,
  Gavel,
  History,
  Info,
  ListChecks,
  ListTodo,
  Loader2,
  Lock,
  MessagesSquare,
  Pencil,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  PlusCircle,
  Send,
  Settings,
  ShieldCheck,
  ShieldX,
  TerminalSquare,
  Trash2,
  Unlock,
  UserCheck,
  Wrench,
  X,
} from 'lucide-react';
import hljs from 'highlight.js/lib/common';
import { cn } from '@/lib/cn';
import {
  api,
  type DerivedState,
  type MemoryOverviewEntry,
  type ProjectTree,
  type StackFile,
  type StackItem,
} from '@/lib/api';
import type {
  ChatLogEntry,
  ConfirmEvidence,
  PhaseItem,
  PhaseItemStatus,
  PhaseTrackerFile,
  PhaseTrackerPhase,
} from '@/lib/types';
import { useSessionStore } from '@/lib/store';
import { useTranslation, getTranslation, type TranslationKey } from '../lib/i18n';
import { FilePreviewModal } from './file-preview-modal';
import { SettingsModal } from './settings-modal';

/**
 * Right-side activity-bar pattern (VS Code style, but pinned right). A
 * narrow vertical icon rail toggles a wide content pane that swaps
 * between every "context" tab the operator might want — tool detail,
 * task lists, schedule, files-touched, phases, memory, decisions,
 * agents-room, stack manifest. The pane is resizable horizontally via
 * the parent PanelGroup; here we own only the rail + tab routing.
 *
 * Why one component instead of nine: every tab mounts on icon click,
 * unmounts on switch, so they share a single `derived` fetcher and
 * preview-modal slot. Splitting felt like premature decomposition.
 *
 * Auto-switch behaviour: clicking a tool call in the agent timeline
 * sets `selectedToolUseId` upstream; we react to that by snapping the
 * active tab to `tool-detail` so the operator sees the detail without
 * an extra click. Manually switching tabs disables the auto-snap until
 * a *new* tool is selected (we track the last-snapped id).
 */
export type RightTab =
  | 'tool-detail'
  | 'tasks'
  | 'schedule'
  | 'files-touched'
  | 'phases'
  | 'audit'
  | 'memory'
  | 'decisions'
  | 'room'
  | 'stack'
  | 'scripts';

/**
 * Vertical rail — always-visible icon strip on the far right. Pure
 * controlled component: parent owns `activeTab` and `expanded`. Settings
 * modal toggles a private piece of state because nothing else cares.
 *
 * The rail lives **outside** the PanelGroup in `page.tsx` so when the
 * operator collapses the wide pane, the freed horizontal space goes
 * back to SupChat + AgentPane (which is what they want — they hid the
 * pane to give the chats room to breathe).
 */
export function RightRail({
  expanded,
  activeTab,
  onToggleExpanded,
  onActivateTab,
  pendingScripts,
}: {
  expanded: boolean;
  activeTab: RightTab;
  onToggleExpanded: () => void;
  onActivateTab: (tab: RightTab) => void;
  /** Pending-script count → drives the red dot on the scripts rail button. */
  pendingScripts: number;
}) {
  const { t, plural } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <>
      <div className="w-[58px] shrink-0 bg-zinc-900 border-l-2 border-border-strong flex flex-col items-center py-1.5 gap-0.5 h-full">
        <RailButton
          active={expanded}
          icon={expanded ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
          label={expanded ? t('rightSidebar.rail.hide') : t('rightSidebar.rail.show')}
          title={expanded ? t('rightSidebar.rail.collapse') : t('rightSidebar.rail.expand')}
          onClick={onToggleExpanded}
        />
        <RailButton
          active={expanded && activeTab === 'tool-detail'}
          icon={<Wrench size={15} />}
          label={t('rightSidebar.rail.tool.label')}
          title={t('rightSidebar.rail.tool.title')}
          onClick={() => onActivateTab('tool-detail')}
        />
        <RailButton
          active={expanded && activeTab === 'tasks'}
          icon={<ListChecks size={15} />}
          label={t('rightSidebar.rail.tasks.label')}
          title={t('rightSidebar.rail.tasks.title')}
          onClick={() => onActivateTab('tasks')}
        />
        <RailButton
          active={expanded && activeTab === 'schedule'}
          icon={<AlarmClock size={15} />}
          label={t('rightSidebar.rail.schedule.label')}
          title={t('rightSidebar.rail.schedule.title')}
          onClick={() => onActivateTab('schedule')}
        />
        <RailButton
          active={expanded && activeTab === 'files-touched'}
          icon={<FileEdit size={15} />}
          label={t('rightSidebar.rail.files.label')}
          title={t('rightSidebar.rail.files.title')}
          onClick={() => onActivateTab('files-touched')}
        />
        {/* Visual separator between live-execution panels and project-context panels. */}
        <div className="w-7 h-px bg-border my-1" />
        <RailButton
          active={expanded && activeTab === 'phases'}
          icon={<ListTodo size={15} />}
          label={t('rightSidebar.rail.phases.label')}
          title={t('rightSidebar.rail.phases.title')}
          onClick={() => onActivateTab('phases')}
        />
        <RailButton
          active={expanded && activeTab === 'audit'}
          icon={<History size={15} />}
          label={t('rightSidebar.rail.audit.label')}
          title={t('rightSidebar.rail.audit.title')}
          onClick={() => onActivateTab('audit')}
        />
        <RailButton
          active={expanded && activeTab === 'memory'}
          icon={<Brain size={15} />}
          label={t('rightSidebar.rail.memory.label')}
          title={t('rightSidebar.rail.memory.title')}
          onClick={() => onActivateTab('memory')}
        />
        <RailButton
          active={expanded && activeTab === 'decisions'}
          icon={<Gavel size={15} />}
          label={t('rightSidebar.rail.decisions.label')}
          title={t('rightSidebar.rail.decisions.title')}
          onClick={() => onActivateTab('decisions')}
        />
        <RailButton
          active={expanded && activeTab === 'room'}
          icon={<MessagesSquare size={15} />}
          label={t('rightSidebar.rail.room.label')}
          title={t('rightSidebar.rail.room.title')}
          onClick={() => onActivateTab('room')}
        />
        <RailButton
          active={expanded && activeTab === 'stack'}
          icon={<Boxes size={15} />}
          label={t('rightSidebar.rail.stack.label')}
          title={t('rightSidebar.rail.stack.title')}
          onClick={() => onActivateTab('stack')}
        />
        <RailButton
          active={expanded && activeTab === 'scripts'}
          icon={<TerminalSquare size={15} />}
          label={t('rightSidebar.rail.scripts.label')}
          title={
            pendingScripts > 0
              ? t('rightSidebar.rail.scripts.titleWithPending', { count: pendingScripts })
              : t('rightSidebar.rail.scripts.title')
          }
          badge={pendingScripts > 0 ? pendingScripts : undefined}
          onClick={() => onActivateTab('scripts')}
        />
        {/* Spacer pushes Settings to the bottom of the rail. */}
        <div className="flex-1" />
        <RailButton
          active={settingsOpen}
          icon={<Settings size={15} />}
          label={t('rightSidebar.rail.settings.label')}
          title={t('rightSidebar.rail.settings.title')}
          onClick={() => setSettingsOpen(true)}
        />
      </div>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </>
  );
}

/**
 * The wide content pane — what's currently selected by the rail. Lives
 * **inside** the PanelGroup as a resizable Panel (rendered conditionally
 * by the page when the rail is expanded). The rail is rendered next to
 * it but outside the PanelGroup, so collapsing this pane gives all
 * horizontal space back to the chat panes.
 */
export function RightPanelContent({
  sessionId,
  chatLog,
  selectedToolUseId,
  derived,
  activeTab,
}: {
  sessionId: string;
  chatLog: ChatLogEntry[];
  selectedToolUseId: string | null;
  derived: DerivedState | null;
  activeTab: RightTab;
}) {
  const { t } = useTranslation();
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [editPath, setEditPath] = useState<string | null>(null);

  return (
    <>
      <div className="h-full flex flex-col bg-zinc-900/70 border-l-2 border-border-strong min-w-0">
        <div className="h-7 flex items-center px-2.5 border-b-2 border-border-strong bg-zinc-900">
          <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-300 font-semibold">
            {RIGHT_TAB_LABELS[activeTab](t)}
          </span>
          {activeTab === 'decisions' && (
            <ExportDecisionsButton chatLog={chatLog} sessionId={sessionId} />
          )}
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {activeTab === 'tool-detail' && (
            <ToolDetailPanel
              chatLog={chatLog}
              selectedToolUseId={selectedToolUseId}
            />
          )}
          {activeTab === 'tasks' && <TasksPanel todos={derived?.todos ?? null} />}
          {activeTab === 'schedule' && <SchedulePanel derived={derived} />}
          {activeTab === 'files-touched' && (
            <FilesTouchedPanel sessionId={sessionId} derived={derived} />
          )}
          {activeTab === 'phases' && <PhasesPanel sessionId={sessionId} />}
          {activeTab === 'audit' && <AuditPanel chatLog={chatLog} />}
          {activeTab === 'memory' && (
            <MemoryPanel
              sessionId={sessionId}
              onPreview={(p) => setPreviewPath(p)}
              onEdit={(p) => setEditPath(p)}
            />
          )}
          {activeTab === 'decisions' && (
            <DecisionRoomPanel chatLog={chatLog} sessionId={sessionId} />
          )}
          {activeTab === 'room' && <AgentsRoomPanel chatLog={chatLog} />}
          {activeTab === 'stack' && <StackPanel sessionId={sessionId} />}
          {activeTab === 'scripts' && <ScriptsPanel sessionId={sessionId} />}
        </div>
      </div>
      {previewPath && (
        <FilePreviewModal
          sessionId={sessionId}
          path={previewPath}
          onClose={() => setPreviewPath(null)}
        />
      )}
      {editPath && (
        <FilePreviewModal
          sessionId={sessionId}
          path={editPath}
          editable
          onClose={() => setEditPath(null)}
        />
      )}
    </>
  );
}

const RIGHT_TAB_LABELS: Record<RightTab, (t: (key: TranslationKey) => string) => string> = {
  'tool-detail': (t) => t('rightSidebar.tab.toolDetail'),
  tasks: (t) => t('rightSidebar.tab.tasks'),
  schedule: (t) => t('rightSidebar.tab.schedule'),
  'files-touched': (t) => t('rightSidebar.tab.filesTouched'),
  phases: (t) => t('rightSidebar.tab.phases'),
  audit: (t) => t('rightSidebar.tab.audit'),
  memory: (t) => t('rightSidebar.tab.memory'),
  decisions: (t) => t('rightSidebar.tab.decisions'),
  room: (t) => t('rightSidebar.tab.room'),
  stack: (t) => t('rightSidebar.tab.stack'),
  scripts: (t) => t('rightSidebar.tab.scripts'),
};

function RailButton({
  active,
  icon,
  label,
  title,
  badge,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  /** Short tag rendered below the icon (≤6 chars fits cleanly in the 56px rail). */
  label: string;
  /** Full tooltip — used when the short label is ambiguous. */
  title: string;
  /** Optional pending-count badge — small red dot + count on the icon corner. */
  badge?: number;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'relative w-12 py-1 rounded flex flex-col items-center justify-center gap-0.5 transition-colors',
        active
          ? 'bg-cyan-900/40 text-cyan-300 hover:bg-cyan-900/60'
          : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800',
      )}
    >
      <span className="relative">
        {icon}
        {badge !== undefined && badge > 0 && (
          <span className="absolute -top-1.5 -right-2 min-w-[14px] h-[14px] px-1 rounded-full bg-red-500 text-white text-[9px] font-mono font-bold flex items-center justify-center tabular-nums shadow-md shadow-red-900/40">
            {badge > 9 ? t('rightSidebar.badgeOverflow') : badge}
          </span>
        )}
      </span>
      <span className="text-[9px] font-mono uppercase tracking-wide leading-none">
        {label}
      </span>
    </button>
  );
}

/* ───────────────── Tool Detail panel ───────────────── */

function ToolDetailPanel({
  chatLog,
  selectedToolUseId,
}: {
  chatLog: ChatLogEntry[];
  selectedToolUseId: string | null;
}) {
  const { t } = useTranslation();
  if (!selectedToolUseId) {
    return (
      <div className="h-full p-4 text-sm text-zinc-500 space-y-2">
        <p className="text-zinc-400">
          {t('rightSidebar.toolDetail.empty')}
        </p>
      </div>
    );
  }

  const call = chatLog.find(
    (e) =>
      (e.type === 'dev-tool-call' ||
        e.type === 'agent-tool-call' ||
        e.type === 'sup-tool-call') &&
      e.toolUseId === selectedToolUseId,
  ) as
    | Extract<ChatLogEntry, { type: 'dev-tool-call' }>
    | Extract<ChatLogEntry, { type: 'agent-tool-call' }>
    | Extract<ChatLogEntry, { type: 'sup-tool-call' }>
    | undefined;
  const result = chatLog.find(
    (e) =>
      (e.type === 'dev-tool-result' ||
        e.type === 'agent-tool-result' ||
        e.type === 'sup-tool-result') &&
      e.toolUseId === selectedToolUseId,
  ) as
    | Extract<ChatLogEntry, { type: 'dev-tool-result' }>
    | Extract<ChatLogEntry, { type: 'agent-tool-result' }>
    | Extract<ChatLogEntry, { type: 'sup-tool-result' }>
    | undefined;

  if (!call) {
    return <div className="p-4 text-sm text-zinc-500">{t('rightSidebar.toolDetail.notFound')}</div>;
  }

  const inputLang = guessInputLanguage(call.name);
  const inputText = formatToolInput(call.name, call.input);
  const resultLang = guessResultLanguage(call.name, call.input, result?.text ?? '');

  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-3 space-y-3 text-xs">
      <div className="flex items-center gap-2">
        <Wrench size={14} className="text-blue-400" />
        <code className="font-medium text-blue-300">{call.name}</code>
      </div>

      <CodeBlock label={t('rightSidebar.toolDetail.input')} language={inputLang} code={inputText} />

      {result ? (
        <CodeBlock
          label={result.isError ? t('rightSidebar.toolDetail.resultError') : t('rightSidebar.toolDetail.resultOk')}
          labelColor={result.isError ? 'text-red-400' : 'text-emerald-400'}
          language={resultLang}
          code={result.text || t('rightSidebar.toolDetail.resultEmpty')}
        />
      ) : (
        <div className="text-[11px] text-zinc-500 italic">{t('rightSidebar.toolDetail.awaitingResult')}</div>
      )}
    </div>
  );
}

function CodeBlock({
  label,
  labelColor,
  language,
  code,
}: {
  label: string;
  labelColor?: string;
  language: string;
  code: string;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    try {
      const html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
      ref.current.innerHTML = html;
    } catch {
      ref.current.textContent = code;
    }
  }, [code, language]);

  return (
    <div>
      <div
        className={`text-[10px] uppercase tracking-wide mb-1 ${labelColor ?? 'text-zinc-500'}`}
      >
        {label}
      </div>
      <pre className="bg-bg-subtle border border-border rounded p-2 text-[10px] leading-[13px] whitespace-pre-wrap break-words font-mono text-zinc-200 max-h-[60vh] overflow-y-auto scrollbar-thin">
        <code ref={ref} className={`hljs language-${language}`}>
          {code}
        </code>
      </pre>
    </div>
  );
}

function formatToolInput(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash') return String(input.command ?? '');
  if (name === 'Write' && typeof input.content === 'string') return String(input.content);
  return JSON.stringify(input, null, 2);
}

function guessInputLanguage(name: string): string {
  if (name === 'Bash') return 'bash';
  if (name === 'Write') return 'plaintext';
  return 'json';
}

function guessResultLanguage(
  name: string,
  input: Record<string, unknown>,
  text: string,
): string {
  if (name === 'Bash') return 'bash';
  if (name === 'Read' || name === 'Edit' || name === 'Write') {
    return languageFromPath(String(input.file_path ?? ''));
  }
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    return 'json';
  }
  return 'plaintext';
}

function languageFromPath(p: string): string {
  const lower = p.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs')) return 'javascript';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.java')) return 'java';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  if (lower.endsWith('.md')) return 'markdown';
  if (lower.endsWith('.sh') || lower.endsWith('.bash')) return 'bash';
  if (lower.endsWith('.css')) return 'css';
  if (lower.endsWith('.html')) return 'xml';
  if (lower.endsWith('.sql')) return 'sql';
  return 'plaintext';
}

/* ───────────────── Tasks (TodoWrite) panel ───────────────── */

interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

function TasksPanel({ todos }: { todos: Todo[] | null }) {
  const { t } = useTranslation();
  if (!todos) {
    return <Empty>{t('rightSidebar.tasks.noList')}</Empty>;
  }
  if (todos.length === 0) return <Empty>{t('rightSidebar.tasks.empty')}</Empty>;
  return (
    <ul className="p-2 space-y-1">
      {todos.map((t, i) => (
        <li key={i} className="flex items-start gap-1.5">
          <TodoIcon status={t.status} />
          <span
            className={cn(
              'text-[11px] leading-[15px] font-mono',
              t.status === 'completed' && 'line-through text-zinc-500',
              t.status === 'in_progress' && 'text-cyan-200',
              t.status === 'pending' && 'text-zinc-300',
            )}
          >
            {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
          </span>
        </li>
      ))}
    </ul>
  );
}

function TodoIcon({ status }: { status: Todo['status'] }) {
  if (status === 'completed') {
    return <CheckCircle2 size={11} className="text-emerald-400 shrink-0 mt-0.5" />;
  }
  if (status === 'in_progress') {
    return <CircleDot size={11} className="text-cyan-400 shrink-0 mt-0.5" />;
  }
  return <Circle size={11} className="text-zinc-600 shrink-0 mt-0.5" />;
}

/* ───────────────── Schedule panel (wakeups + crons) ───────────────── */

interface Wakeup {
  toolUseId: string;
  scheduledAt: number;
  fireAt: number;
  delaySeconds: number;
  reason: string;
  status: 'pending' | 'fired' | 'cancelled';
}

interface CronJob {
  toolUseId: string;
  scheduledAt: number;
  schedule: string;
  description: string;
  cronId: string | null;
  status: 'active' | 'deleted';
}

function SchedulePanel({ derived }: { derived: DerivedState | null }) {
  const { t } = useTranslation();
  // Live-tick `now` so countdowns refresh every second when at least one
  // wakeup is pending. Cheap and isolated to this panel.
  const [now, setNow] = useState(() => Date.now());
  const wakeups: Wakeup[] = useMemo(() => {
    if (!derived) return [];
    return derived.wakeups.map((w) => ({
      toolUseId: w.id,
      scheduledAt: w.scheduledAt,
      fireAt: w.fireAt,
      delaySeconds: Math.max(0, Math.round((w.fireAt - w.scheduledAt) / 1000)),
      reason: w.reason,
      status: w.status,
    }));
  }, [derived]);
  const hasPendingWakeup = wakeups.some(
    (w) => w.status === 'pending' && w.fireAt > now,
  );
  useEffect(() => {
    if (!hasPendingWakeup) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasPendingWakeup]);

  const crons: CronJob[] = useMemo(() => {
    if (!derived) return [];
    return derived.crons.map((c) => ({
      toolUseId: c.id,
      scheduledAt: c.scheduledAt,
      schedule: c.schedule,
      description: c.description,
      cronId: c.cronId,
      status: c.status,
    }));
  }, [derived]);

  const upcomingWakeups = wakeups.filter(
    (w) => w.status === 'pending' && w.fireAt > now,
  );
  const firedWakeups = wakeups.filter(
    (w) => w.status !== 'pending' || w.fireAt <= now,
  );
  const activeCrons = crons.filter((c) => c.status === 'active');
  const deletedCrons = crons.filter((c) => c.status === 'deleted');

  if (
    upcomingWakeups.length === 0 &&
    firedWakeups.length === 0 &&
    crons.length === 0
  ) {
    return <Empty>{t('rightSidebar.schedule.empty')}</Empty>;
  }

  return (
    <div className="p-2 space-y-3 text-xs">
      {upcomingWakeups.length > 0 && (
        <div>
          <SubHeader
            label={t('rightSidebar.schedule.pendingWakeups', { count: upcomingWakeups.length })}
            color="text-rose-400"
            icon={<AlarmClock size={11} />}
          />
          <ul className="space-y-1">
            {upcomingWakeups.map((w) => (
              <WakeupRow key={w.toolUseId} wakeup={w} now={now} />
            ))}
          </ul>
        </div>
      )}
      {activeCrons.length > 0 && (
        <div>
          <SubHeader
            label={t('rightSidebar.schedule.activeCrons', { count: activeCrons.length })}
            color="text-violet-400"
            icon={<CalendarClock size={11} />}
          />
          <ul className="space-y-1">
            {activeCrons.map((c) => (
              <CronRow key={c.toolUseId} cron={c} />
            ))}
          </ul>
        </div>
      )}
      {firedWakeups.length > 0 && (
        <div>
          <SubHeader label={t('rightSidebar.schedule.wakeupHistory')} color="text-zinc-500" />
          <ul className="space-y-1">
            {firedWakeups.slice(0, 6).map((w) => (
              <WakeupRow key={w.toolUseId} wakeup={w} now={now} />
            ))}
          </ul>
        </div>
      )}
      {deletedCrons.length > 0 && (
        <div>
          <SubHeader label={t('rightSidebar.schedule.removedCrons')} color="text-zinc-500" />
          <ul className="space-y-1">
            {deletedCrons.slice(0, 6).map((c) => (
              <CronRow key={c.toolUseId} cron={c} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CronRow({ cron }: { cron: CronJob }) {
  const removed = cron.status === 'deleted';
  return (
    <li className="flex items-start gap-1.5">
      <CalendarClock
        size={11}
        className={cn(
          'shrink-0 mt-0.5',
          removed ? 'text-zinc-600' : 'text-violet-400',
        )}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 text-[11px] leading-[15px] font-mono">
          <span
            className={cn(
              'tabular-nums font-semibold truncate',
              removed ? 'text-zinc-500 line-through' : 'text-violet-300',
            )}
          >
            {cron.schedule}
          </span>
          {cron.cronId && (
            <span className="text-zinc-600 truncate" title={cron.cronId}>
              #{cron.cronId.slice(0, 8)}
            </span>
          )}
        </div>
        {cron.description && (
          <div
            className={cn(
              'text-[11px] leading-[15px] truncate',
              removed ? 'text-zinc-600' : 'text-zinc-300',
            )}
            title={cron.description}
          >
            {cron.description}
          </div>
        )}
      </div>
    </li>
  );
}

function WakeupRow({ wakeup, now }: { wakeup: Wakeup; now: number }) {
  const { t } = useTranslation();
  const remainingMs = wakeup.fireAt - now;
  const settled = wakeup.status !== 'pending' || remainingMs <= 0;
  const fireDate = new Date(wakeup.fireAt);
  const hh = String(fireDate.getHours()).padStart(2, '0');
  const mm = String(fireDate.getMinutes()).padStart(2, '0');
  const ss = String(fireDate.getSeconds()).padStart(2, '0');
  let label: string;
  if (wakeup.status === 'cancelled') label = t('rightSidebar.schedule.cancelled');
  else if (wakeup.status === 'fired' || remainingMs <= 0) label = t('rightSidebar.schedule.fired');
  else label = formatCountdown(remainingMs);
  return (
    <li className="flex items-start gap-1.5">
      <AlarmClock
        size={11}
        className={cn(
          'shrink-0 mt-0.5',
          settled ? 'text-zinc-600' : 'text-rose-400',
        )}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 text-[10px] font-mono leading-[13px]">
          <span
            className={cn(
              'tabular-nums font-semibold',
              settled ? 'text-zinc-500 line-through' : 'text-rose-300',
            )}
          >
            {label}
          </span>
          <span className="text-zinc-600">
            @ {hh}:{mm}:{ss}
          </span>
        </div>
        {wakeup.reason && (
          <div
            className={cn(
              'text-[11px] leading-[15px] truncate',
              settled ? 'text-zinc-600' : 'text-zinc-300',
            )}
            title={wakeup.reason}
          >
            {wakeup.reason}
          </div>
        )}
      </div>
    </li>
  );
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/* ───────────────── Files Touched panel ───────────────── */

function FilesTouchedPanel({
  sessionId,
  derived,
}: {
  sessionId: string;
  derived: DerivedState | null;
}) {
  const { t } = useTranslation();
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  if (!derived) return <Empty>loading…</Empty>;
  const data = derived.files;
  if (!data) return <Empty>{t('rightSidebar.filesTouched.empty')}</Empty>;
  const { created, modified, read } = data;
  if (created.length === 0 && modified.length === 0 && read.length === 0) {
    return <Empty>{t('rightSidebar.filesTouched.empty')}</Empty>;
  }
  return (
    <>
      <div className="grid grid-cols-3 gap-2 p-2">
        <FileColumn
          label={t('rightSidebar.filesTouched.created')}
          count={created.length}
          color="text-purple-300"
          icon={<PlusCircle size={11} />}
          files={created}
          onPreview={setPreviewPath}
        />
        <FileColumn
          label={t('rightSidebar.filesTouched.modified')}
          count={modified.length}
          color="text-orange-300"
          icon={<Pencil size={11} />}
          files={modified}
          onPreview={setPreviewPath}
        />
        <FileColumn
          label={t('rightSidebar.filesTouched.read')}
          count={read.length}
          color="text-cyan-300"
          icon={<FileText size={11} />}
          files={read}
          onPreview={setPreviewPath}
        />
      </div>
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

function FileColumn({
  label,
  count,
  color,
  icon,
  files,
  onPreview,
}: {
  label: string;
  count: number;
  color: string;
  icon: React.ReactNode;
  files: { path: string; ts: number }[];
  onPreview: (path: string) => void;
}) {
  return (
    <div className="min-w-0">
      <div className={cn('flex items-center gap-1 mb-1.5', color)}>
        {icon}
        <span className="text-[10px] font-mono uppercase tracking-wide font-semibold">
          {label}
        </span>
        <span className="text-[10px] text-zinc-500 tabular-nums">({count})</span>
      </div>
      {files.length === 0 ? (
        <div className="text-[10px] text-zinc-600 italic px-1">—</div>
      ) : (
        <ul className="space-y-0.5">
          {files.slice(0, 50).map((f) => (
            <FileColumnRow key={f.path} file={f} onPreview={onPreview} />
          ))}
        </ul>
      )}
    </div>
  );
}

function FileColumnRow({
  file,
  onPreview,
}: {
  file: { path: string; ts: number };
  onPreview: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(file.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* silent */
    }
  };
  return (
    <li className="group flex items-center gap-1 min-w-0" title={file.path}>
      <button
        onClick={() => onPreview(file.path)}
        className="flex-1 flex items-center gap-1 min-w-0 text-left px-1 py-0.5 rounded hover:bg-bg-elevated"
      >
        <FileText size={10} className="shrink-0 text-zinc-500" />
        <span className="text-[11px] leading-[15px] font-mono text-zinc-200 truncate">
          {basename(file.path)}
        </span>
      </button>
      <button
        onClick={handleCopy}
        className="shrink-0 p-0.5 rounded text-zinc-500 hover:text-zinc-100 hover:bg-bg-elevated opacity-0 group-hover:opacity-100 transition-opacity"
        title={t('rightSidebar.filesTouched.copyPath')}
      >
        {copied ? <Check size={10} className="text-emerald-400" /> : <Copy size={10} />}
      </button>
    </li>
  );
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}

/* ───────────────── Phases panel ───────────────── */

function PhasesPanel({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  // Single source of truth: the structured tracker
  // (`<cwd>/.selfclaude/phases.json`). Markdown phase docs are still
  // useful as the prose brief but they're no longer parsed here — the
  // parser-fallback was unreliable on doc styles that didn't use
  // markdown checkboxes, and the tracker is now the canonical place
  // for "is this done?". The store stays fresh via SSE; we just
  // hydrate once on mount.
  const tracker = useSessionStore((s) => s.sessions[sessionId]?.phaseTracker ?? null);
  const setPhaseTracker = useSessionStore((s) => s.setPhaseTracker);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getPhaseTracker(sessionId)
      .then((t) => {
        if (!cancelled) setPhaseTracker(sessionId, t);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
  }, [sessionId, setPhaseTracker]);

  if (error) {
    return <div className="p-2 text-[10px] text-red-400 italic">{error}</div>;
  }
  if (tracker === null) {
    return <div className="p-2 text-[10px] text-zinc-500 italic">loading…</div>;
  }
  if (tracker.phases.length === 0) {
    return (
      <div className="p-3 text-[11px] text-zinc-500 italic leading-relaxed space-y-2">
        <p className="font-mono not-italic text-zinc-400">
          <code className="text-amber-400">{t('rightSidebar.phases.empty.heading')}</code>{' '}
          not set
        </p>
        <p>
          {t('rightSidebar.phases.empty.body')}
        </p>
      </div>
    );
  }

  return (
    <div className="p-2 space-y-2">
      {tracker.phases.map((p) => (
        <TrackerPhaseCard key={p.slug} phase={p} sessionId={sessionId} />
      ))}
    </div>
  );
}

/**
 * One phase tracker card — the structured, supervisor-managed view.
 * Status icons: ⚪ pending, 🟡 proposed (review needed), ✅ done. Item
 * notes (proposer trail + sup confirm/reject reasons) collapse open
 * for the proposed items so the operator sees what's awaiting review.
 */
/**
 * One phase rendered as a flat checklist — heading row + items list,
 * no nested cards. Heading is collapsible; items are click-to-detail
 * (modal opens) so the panel stays compact and todo-list-shaped at
 * rest. Click "view doc" or "?" to preview the prose brief.
 */
function TrackerPhaseCard({
  phase,
  sessionId,
}: {
  phase: PhaseTrackerPhase;
  sessionId: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const total = phase.items.length;
  const done = phase.items.filter((it) => it.status === 'done').length;
  const proposed = phase.items.filter((it) => it.status === 'proposed').length;
  // Empty-evidence done items that the operator hasn't verified yet —
  // surfaced as a red dot in the heading so the operator notices the
  // phase has unverified ✅s without scanning every row.
  const unverified = phase.items.filter(
    (it) =>
      it.status === 'done' &&
      it.confirmEvidence !== null &&
      it.confirmEvidence.totalCount === 0 &&
      !it.operatorVerifiedAt,
  ).length;
  const allDone = total > 0 && done === total;
  const selectedItem = selectedItemId
    ? phase.items.find((it) => it.id === selectedItemId) ?? null
    : null;

  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 hover:text-zinc-100 text-zinc-300 px-1 py-0.5 rounded -ml-1"
        >
          {open ? (
            <ChevronDown size={12} className="shrink-0" />
          ) : (
            <ChevronRight size={12} className="shrink-0" />
          )}
          <span
            className={cn(
              'text-[12px] font-mono font-semibold leading-tight',
              allDone ? 'text-emerald-300' : 'text-zinc-200',
            )}
          >
            {phase.title}
          </span>
        </button>
        <span className="flex-1 h-px bg-border/40" />
        {unverified > 0 && (
          <span
            className="inline-flex items-center gap-0.5 text-[9px] tabular-nums font-mono text-red-300 px-1.5 py-0.5 rounded-full bg-red-950/40 border border-red-700/40"
            title={t('rightSidebar.phases.unverified.title', { unverified })}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
            {unverified}
          </span>
        )}
        {proposed > 0 && (
          <span
            className="text-[9px] tabular-nums font-mono text-amber-300 shrink-0"
            title={t('rightSidebar.phases.proposed.title', { proposed })}
          >
            🟡 {proposed}
          </span>
        )}
        <span className="text-[10px] tabular-nums font-mono text-zinc-500 shrink-0">
          {done}/{total}
        </span>
        <button
          type="button"
          onClick={() => setPreviewing(true)}
          className="text-[10px] text-zinc-600 hover:text-zinc-300 px-1"
          title={t('rightSidebar.phases.viewPhaseDoc')}
        >
          ?
        </button>
      </div>
      {open && (
        <ul className="space-y-px ml-2">
          {phase.items.length === 0 ? (
            <li className="text-[11px] text-zinc-600 italic px-1.5 py-1">
              {t('rightSidebar.phases.noItems')}
            </li>
          ) : (
            phase.items.map((it) => (
              <TrackerItemRow
                key={it.id}
                item={it}
                onClick={() => setSelectedItemId(it.id)}
              />
            ))
          )}
        </ul>
      )}
      {previewing && (
        <FilePreviewModal
          sessionId={sessionId}
          path={`docs/phases/${phase.slug}.md`}
          onClose={() => setPreviewing(false)}
        />
      )}
      {selectedItem && (
        <PhaseItemDetailModal
          sessionId={sessionId}
          phase={phase}
          item={selectedItem}
          onClose={() => setSelectedItemId(null)}
        />
      )}
    </div>
  );
}

/**
 * Single-line clickable row — minimal chrome, todo-list shape. Click
 * opens the detail modal for full notes + evidence + actions. The
 * empty-evidence ⚠ is rendered as a red pulsing dot so it's
 * impossible to miss without nesting.
 */
function TrackerItemRow({
  item,
  onClick,
}: {
  item: PhaseItem;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const emptyConfirm =
    item.status === 'done' &&
    item.confirmEvidence !== null &&
    item.confirmEvidence.totalCount === 0 &&
    !item.operatorVerifiedAt;
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'group w-full flex items-center gap-1.5 px-1.5 py-[3px] rounded text-left',
          'hover:bg-bg-elevated/60 transition-colors',
          emptyConfirm && 'bg-red-950/20 hover:bg-red-950/30',
        )}
      >
        <StatusIcon status={item.status} />
        <span
          className={cn(
            'flex-1 text-[12px] leading-[18px] font-mono truncate',
            item.status === 'done'
              ? 'text-emerald-200/90 line-through decoration-emerald-800/70 decoration-1'
              : item.status === 'proposed'
                ? 'text-amber-200'
                : 'text-zinc-300',
          )}
        >
          {item.title}
        </span>
        {emptyConfirm && (
          <span
            className="shrink-0 w-2 h-2 rounded-full bg-red-400 ring-2 ring-red-400/30 animate-pulse"
            title={t('rightSidebar.audit.confirmedWithoutEvidence')}
          />
        )}
        {item.operatorVerifiedAt && (
          <span
            className="shrink-0 text-[9px] uppercase font-mono tracking-wide text-cyan-400"
            title={t('rightSidebar.phases.opVerifiedAt', { datetime: new Date(item.operatorVerifiedAt).toLocaleString() })}
          >
            op✓
          </span>
        )}
        {item.status === 'proposed' && item.proposedBy && (
          <span className="shrink-0 text-[9px] uppercase font-mono tracking-wide text-amber-400/80">
            {item.proposedBy}
          </span>
        )}
        {item.status === 'done' && item.confirmedBy && !emptyConfirm && (
          <span className="shrink-0 text-[9px] uppercase font-mono tracking-wide text-emerald-500/70">
            {item.confirmedBy}
          </span>
        )}
      </button>
    </li>
  );
}

/**
 * Compact list of supervisor tool calls captured between proposal and
 * confirmation. Empty trail renders as a red callout — that's the
 * operator's signal a confirmation went through without verification.
 */
function EvidenceTrail({ evidence }: { evidence: ConfirmEvidence }) {
  const { t } = useTranslation();
  if (evidence.totalCount === 0) {
    return (
      <div className="rounded border border-red-700/50 bg-red-950/30 px-2 py-1.5">
        <p className="text-[10px] font-mono text-red-300 leading-relaxed">
          {t('rightSidebar.phases.emptyAuditTrail')}
        </p>
      </div>
    );
  }
  return (
    <div className="rounded border border-emerald-800/30 bg-emerald-950/15 px-2 py-1.5 space-y-1">
      <div className="text-[9px] uppercase tracking-widest font-mono font-semibold text-emerald-300">
        {t('rightSidebar.phases.evidence.verified', { count: evidence.totalCount })}
      </div>
      {evidence.reads.length > 0 && (
        <div>
          <div className="text-[9px] font-mono text-cyan-300 uppercase tracking-wide">
            {t('rightSidebar.phases.evidence.read', { count: evidence.reads.length })}
          </div>
          <ul className="space-y-px">
            {evidence.reads.map((r, i) => (
              <li
                key={i}
                className="text-[10px] font-mono text-zinc-300 truncate"
                title={r.path}
              >
                {basename(r.path)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {evidence.bashes.length > 0 && (
        <div>
          <div className="text-[9px] font-mono text-amber-300 uppercase tracking-wide">
            {t('rightSidebar.phases.evidence.bash', { count: evidence.bashes.length })}
          </div>
          <ul className="space-y-px">
            {evidence.bashes.map((b, i) => (
              <li
                key={i}
                className={cn(
                  'text-[10px] font-mono truncate',
                  b.isError ? 'text-red-300' : 'text-zinc-300',
                )}
                title={b.command}
              >
                {b.isError ? '✗ ' : '✓ '}
                {b.command.length > 60 ? `${b.command.slice(0, 60)}…` : b.command}
              </li>
            ))}
          </ul>
        </div>
      )}
      {evidence.edits.length > 0 && (
        <div>
          <div className="text-[9px] font-mono text-orange-300 uppercase tracking-wide">
            {t('rightSidebar.phases.evidence.edit', { count: evidence.edits.length })}
          </div>
          <ul className="space-y-px">
            {evidence.edits.map((e, i) => (
              <li
                key={i}
                className="text-[10px] font-mono text-zinc-300 truncate"
                title={e.path}
              >
                {basename(e.path)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: PhaseItemStatus }) {
  if (status === 'done') {
    return <CircleCheck size={13} className="shrink-0 text-emerald-400" />;
  }
  if (status === 'proposed') {
    return <CircleDot size={13} className="shrink-0 text-amber-400" />;
  }
  return <CircleDashed size={13} className="shrink-0 text-zinc-600" />;
}

/**
 * Focused detail modal for a single phase item — full notes, evidence
 * trail, operator actions. Opens on row click; closes on Esc / X /
 * backdrop. The "Mark operator-verified" button is the operator's
 * explicit override for empty-evidence ⚠ items: clicking it records
 * the override on the item and clears the red dot.
 */
function PhaseItemDetailModal({
  sessionId,
  phase,
  item,
  onClose,
}: {
  sessionId: string;
  phase: PhaseTrackerPhase;
  item: PhaseItem;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [verifyState, setVerifyState] = useState<'idle' | 'pending' | 'error'>('idle');
  const [verifyNotes, setVerifyNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Esc-to-close.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const emptyConfirm =
    item.status === 'done' &&
    item.confirmEvidence !== null &&
    item.confirmEvidence.totalCount === 0;
  const needsOperatorVerify = emptyConfirm && !item.operatorVerifiedAt;

  const handleVerify = async () => {
    setVerifyState('pending');
    setError(null);
    try {
      await api.operatorVerifyPhaseItem(
        sessionId,
        phase.slug,
        item.id,
        verifyNotes.trim() || undefined,
      );
      // SSE will update the tracker — modal stays open showing the new state.
      setVerifyState('idle');
      setVerifyNotes('');
    } catch (e) {
      setError((e as Error).message);
      setVerifyState('error');
    }
  };

  const trail = useMemo(() => parseNotesTrail(item.notes), [item.notes]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-[2px] p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[min(720px,100%)] max-h-[min(85vh,820px)] flex flex-col rounded-lg border border-border-strong bg-bg shadow-2xl">
        {/* Header — phase + id as breadcrumb (small + muted), item title big */}
        <header className="px-6 py-5 border-b border-border-strong relative">
          <button
            type="button"
            onClick={onClose}
            className="absolute top-4 right-4 text-zinc-500 hover:text-zinc-100 w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated"
            aria-label={t('common.close')}
          >
            ✕
          </button>
          <div className="flex items-center gap-2 mb-2 text-[10px] uppercase tracking-widest font-mono text-zinc-500">
            <StatusIcon status={item.status} />
            <span className="text-zinc-400">{phase.title}</span>
            <span className="text-zinc-700">/</span>
            <span>{item.id}</span>
          </div>
          <h2 className="text-[15px] leading-relaxed font-mono text-zinc-100 break-words pr-8">
            {item.title}
          </h2>
        </header>

        {/* Metadata — vertical stack with label/value alignment so the eye can scan */}
        <div className="px-6 py-3 border-b border-border bg-bg-subtle/30">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[11px] font-mono">
            <dt className="text-zinc-500 uppercase tracking-wide">{t('rightSidebar.phases.section.status')}</dt>
            <dd>
              <StatusBadge status={item.status} />
            </dd>
            {item.proposedBy && (
              <>
                <dt className="text-zinc-500 uppercase tracking-wide">{t('rightSidebar.phases.section.proposed')}</dt>
                <dd className="text-zinc-300">
                  <span className="text-amber-300">{item.proposedBy}</span>
                  {item.proposedAt && (
                    <span className="text-zinc-500"> · {timeAgo(item.proposedAt)}</span>
                  )}
                </dd>
              </>
            )}
            {item.confirmedBy && (
              <>
                <dt className="text-zinc-500 uppercase tracking-wide">{t('rightSidebar.phases.section.confirmed')}</dt>
                <dd className="text-zinc-300">
                  <span className="text-emerald-300">{item.confirmedBy}</span>
                  {item.confirmedAt && (
                    <span className="text-zinc-500"> · {timeAgo(item.confirmedAt)}</span>
                  )}
                </dd>
              </>
            )}
            {item.operatorVerifiedAt && (
              <>
                <dt className="text-zinc-500 uppercase tracking-wide">{t('rightSidebar.phases.section.opVerified')}</dt>
                <dd className="text-cyan-300">
                  {item.operatorVerifiedBy ?? 'operator'}
                  <span className="text-zinc-500"> · {timeAgo(item.operatorVerifiedAt)}</span>
                </dd>
              </>
            )}
          </dl>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin px-6 py-5 space-y-5">
          {/* Empty-evidence callout — softer prose, ikonlu options instead of numbered list */}
          {needsOperatorVerify && (
            <section className="rounded-lg border border-red-700/50 bg-red-950/20 overflow-hidden">
              <div className="px-4 py-3 border-b border-red-700/30 bg-red-950/30 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse shrink-0" />
                <h3 className="text-[12px] font-mono font-semibold text-red-100 leading-tight">
                  {t('rightSidebar.phases.emptyConfirm.heading')}
                </h3>
              </div>
              <div className="px-4 py-4 space-y-4">
                <p className="text-[12px] leading-relaxed text-red-100/85">
                  {t('rightSidebar.phases.emptyConfirm.body')}
                </p>
                <div className="grid gap-2 text-[12px] leading-relaxed text-red-100/85">
                  <div className="flex gap-2.5 items-start">
                    <span className="shrink-0 mt-0.5 text-zinc-500">→</span>
                    <p>{t('rightSidebar.phases.emptyConfirm.askSup')}</p>
                  </div>
                  <div className="flex gap-2.5 items-start">
                    <span className="shrink-0 mt-0.5 text-zinc-500">→</span>
                    <p>{t('rightSidebar.phases.emptyConfirm.markVerified')}</p>
                  </div>
                </div>
                <div className="space-y-2 pt-2 border-t border-red-700/30">
                  <textarea
                    value={verifyNotes}
                    onChange={(e) => setVerifyNotes(e.target.value)}
                    placeholder={t('rightSidebar.phases.verifyPlaceholder')}
                    rows={2}
                    className="w-full text-[12px] font-mono bg-bg-subtle border border-border rounded-md px-3 py-2 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-red-500"
                  />
                  {error && (
                    <p className="text-[11px] font-mono text-red-400">{error}</p>
                  )}
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={handleVerify}
                      disabled={verifyState === 'pending'}
                      className={cn(
                        'text-[12px] font-mono font-medium px-4 py-1.5 rounded-md border transition-colors',
                        verifyState === 'pending'
                          ? 'border-zinc-700 bg-zinc-900/50 text-zinc-500 cursor-not-allowed'
                          : 'border-red-600 bg-red-900/50 text-red-100 hover:bg-red-800/60',
                      )}
                    >
                      {verifyState === 'pending' ? t('rightSidebar.phases.verifying') : t('rightSidebar.phases.markVerified')}
                    </button>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Evidence trail */}
          {item.confirmEvidence !== null && item.confirmEvidence.totalCount > 0 && (
            <section className="space-y-2">
              <h3 className="text-[10px] uppercase tracking-widest font-mono text-zinc-500">
                {t('rightSidebar.phases.section.verificationTrail')}
              </h3>
              <EvidenceTrail evidence={item.confirmEvidence} />
            </section>
          )}

          {/* Notes — parsed into structured cards (one per trail entry) */}
          {trail.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-[10px] uppercase tracking-widest font-mono text-zinc-500">
                {t('rightSidebar.phases.section.activity', { count: trail.length })}
              </h3>
              <ul className="space-y-2">
                {trail.map((e, i) => (
                  <NoteEntry key={i} entry={e} />
                ))}
              </ul>
            </section>
          )}

          {item.status === 'pending' && trail.length === 0 && (
            <div className="text-center py-8">
              <p className="text-[12px] font-mono text-zinc-500 italic">
                {t('rightSidebar.phases.pendingNoActivity')}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One activity card built from a parsed `notes` trail entry. Renders
 * the actor + verb + relative time on a header row, body text below,
 * with verb-specific colour accents (proposed = amber, confirmed =
 * emerald, rejected = rose, operator-verified = cyan).
 */
function NoteEntry({
  entry,
}: {
  entry: { ts: string; actor: string; verb: string; body: string };
}) {
  const verbAccent: Record<string, { border: string; bg: string; text: string }> = {
    proposed: { border: 'border-amber-700/40', bg: 'bg-amber-950/15', text: 'text-amber-300' },
    confirmed: { border: 'border-emerald-700/40', bg: 'bg-emerald-950/15', text: 'text-emerald-300' },
    rejected: { border: 'border-rose-700/40', bg: 'bg-rose-950/15', text: 'text-rose-300' },
    'operator-verified': {
      border: 'border-cyan-700/40',
      bg: 'bg-cyan-950/15',
      text: 'text-cyan-300',
    },
  };
  const accent = verbAccent[entry.verb] ?? {
    border: 'border-border/40',
    bg: 'bg-bg-subtle/50',
    text: 'text-zinc-400',
  };
  return (
    <li className={cn('rounded-md border px-3 py-2 space-y-1.5', accent.border, accent.bg)}>
      <div className="flex items-baseline gap-2 flex-wrap text-[11px] font-mono">
        <span className={cn('font-semibold', accent.text)}>{entry.actor}</span>
        {entry.verb && (
          <span className="text-zinc-500 lowercase">{entry.verb}</span>
        )}
        {entry.ts && (
          <span className="ml-auto text-[10px] text-zinc-600 tabular-nums" title={entry.ts}>
            {timeAgo(entry.ts)}
          </span>
        )}
      </div>
      <p className="text-[12px] leading-relaxed font-mono text-zinc-200 whitespace-pre-wrap break-words">
        {entry.body}
      </p>
    </li>
  );
}

/**
 * Parse the JSON-style notes trail (one or more entries of the form
 *
 *   [2026-05-05T20:10:54.932Z] supervisor (proposed): body...
 *
 * separated by newlines) into structured records. The body may itself
 * span multiple lines — we split on the timestamp boundary, not raw
 * newlines, so multi-line bodies stay intact.
 *
 * Falls back to a single record with empty actor/verb when the line
 * doesn't match the expected shape — handles legacy or hand-edited
 * notes gracefully.
 */
function parseNotesTrail(
  notes: string,
): Array<{ ts: string; actor: string; verb: string; body: string }> {
  const trimmed = notes.trim();
  if (!trimmed) return [];
  // Split on lines that begin with `[ISO`, keeping the timestamp at
  // the start of each chunk. The leading split returns an empty first
  // element when the string starts with a timestamp; filter it.
  const chunks = trimmed
    .split(/\n(?=\[\d{4}-\d{2}-\d{2}T)/)
    .map((c) => c.trim())
    .filter(Boolean);
  const re = /^\[([^\]]+)\]\s+([^()]+?)\s*(?:\(([^)]+)\))?\s*:\s*([\s\S]*)$/;
  return chunks.map((chunk) => {
    const m = chunk.match(re);
    if (!m) return { ts: '', actor: '', verb: '', body: chunk };
    return {
      ts: m[1] ?? '',
      actor: (m[2] ?? '').trim(),
      verb: (m[3] ?? '').trim(),
      body: (m[4] ?? '').trim(),
    };
  });
}

function StatusBadge({ status }: { status: PhaseItemStatus }) {
  const { t } = useTranslation();
  if (status === 'done') {
    return (
      <span className="text-[10px] font-mono uppercase tracking-wide px-2 py-0.5 rounded bg-emerald-950/40 text-emerald-300 border border-emerald-700/40">
        {t('rightSidebar.phases.status.done')}
      </span>
    );
  }
  if (status === 'proposed') {
    return (
      <span className="text-[10px] font-mono uppercase tracking-wide px-2 py-0.5 rounded bg-amber-950/40 text-amber-300 border border-amber-700/40">
        {t('rightSidebar.phases.status.proposed')}
      </span>
    );
  }
  return (
    <span className="text-[10px] font-mono uppercase tracking-wide px-2 py-0.5 rounded bg-zinc-900/50 text-zinc-400 border border-zinc-700/40">
      {t('rightSidebar.phases.status.pending')}
    </span>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/* ───────────────── Audit log panel ─────────────────
 *
 * Chronological feed of every phase-tracker mutation in the session
 * (register / propose / confirm / reject), reverse-sorted with newest
 * on top. Each entry surfaces enough to spot anomalies at a glance:
 * actor, item title, evidence trail (for confirms), reason (for
 * rejects). Empty-evidence confirms get a ⚠ banner so drive-by
 * approvals are obvious.
 *
 * Data source is the lazy-loaded chat-log window (same as everything
 * else in the UI). Older history paginates in via the parent's
 * `loadMoreHistory` — operator clicks the "load older" hint in the
 * AgentTimeline to drag in more.
 */

type AuditEntry =
  | Extract<ChatLogEntry, { type: 'phase-registered' }>
  | Extract<ChatLogEntry, { type: 'phase-item-proposed' }>
  | Extract<ChatLogEntry, { type: 'phase-item-confirmed' }>
  | Extract<ChatLogEntry, { type: 'phase-item-rejected' }>
  | Extract<ChatLogEntry, { type: 'phase-item-operator-verified' }>;

function isAuditEntry(e: ChatLogEntry): e is AuditEntry {
  return (
    e.type === 'phase-registered' ||
    e.type === 'phase-item-proposed' ||
    e.type === 'phase-item-confirmed' ||
    e.type === 'phase-item-rejected' ||
    e.type === 'phase-item-operator-verified'
  );
}

function AuditPanel({ chatLog }: { chatLog: ChatLogEntry[] }) {
  const { t } = useTranslation();
  const entries = useMemo(() => {
    const out = chatLog.filter(isAuditEntry);
    return out.slice().sort((a, b) => b.ts - a.ts);
  }, [chatLog]);
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  if (entries.length === 0) {
    return (
      <div className="p-3 text-[11px] text-zinc-500 italic leading-relaxed space-y-2">
        <p className="font-mono not-italic text-zinc-400">{t('rightSidebar.audit.empty.heading')}</p>
        <p>
          {t('rightSidebar.audit.empty.body')}
        </p>
      </div>
    );
  }

  return (
    <div className="p-2">
      <ul className="divide-y divide-border/30">
        {entries.map((e, i) => (
          <AuditRowCompact
            key={`${e.ts}-${i}`}
            entry={e}
            onClick={() => setSelected(e)}
          />
        ))}
      </ul>
      {selected && (
        <AuditEntryDetailModal entry={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

interface AuditMeta {
  verb: string;
  color: string;
  bg: string;
  icon: React.ReactNode;
  /** True for empty-evidence confirm — overrides the default emerald. */
  warn?: boolean;
}

function deriveAuditMeta(entry: AuditEntry): AuditMeta {
  if (entry.type === 'phase-registered') {
    return {
      verb: getTranslation('rightSidebar.audit.verb.registered'),
      color: 'text-cyan-300',
      bg: 'bg-cyan-500/40',
      icon: <ListTodo size={11} className="text-cyan-400" />,
    };
  }
  if (entry.type === 'phase-item-proposed') {
    return {
      verb: getTranslation('rightSidebar.audit.verb.proposed'),
      color: 'text-amber-300',
      bg: 'bg-amber-500/40',
      icon: <CircleDot size={11} className="text-amber-400" />,
    };
  }
  if (entry.type === 'phase-item-confirmed') {
    const empty = (entry.evidence?.totalCount ?? 0) === 0;
    return {
      verb: getTranslation('rightSidebar.audit.verb.confirmed'),
      color: empty ? 'text-red-300' : 'text-emerald-300',
      bg: empty ? 'bg-red-500/40' : 'bg-emerald-500/40',
      icon: (
        <CircleCheck
          size={11}
          className={empty ? 'text-red-400' : 'text-emerald-400'}
        />
      ),
      warn: empty,
    };
  }
  if (entry.type === 'phase-item-rejected') {
    return {
      verb: getTranslation('rightSidebar.audit.verb.rejected'),
      color: 'text-rose-300',
      bg: 'bg-rose-500/40',
      icon: <CircleDashed size={11} className="text-rose-400" />,
    };
  }
  // operator-verified
  return {
    verb: getTranslation('rightSidebar.audit.verb.opVerified'),
    color: 'text-cyan-300',
    bg: 'bg-cyan-500/40',
    icon: <CircleCheck size={11} className="text-cyan-400" />,
  };
}

function describeEntryTitle(entry: AuditEntry): string {
  if (entry.type === 'phase-registered') return entry.title;
  return entry.itemTitle;
}

function describeEntryRef(entry: AuditEntry): string {
  if (entry.type === 'phase-registered') return entry.slug;
  return `${entry.slug}/${entry.itemId}`;
}

function formatHm(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
}

function AuditRowCompact({
  entry,
  onClick,
}: {
  entry: AuditEntry;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const meta = deriveAuditMeta(entry);
  const time = formatHm(entry.ts);
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-bg-elevated/60 text-left"
      >
        <span className="shrink-0 text-[10px] tabular-nums font-mono text-zinc-500 w-10">
          {time}
        </span>
        <span className="shrink-0">{meta.icon}</span>
        <span
          className={cn(
            'shrink-0 text-[9px] uppercase tracking-widest font-mono font-bold w-[78px]',
            meta.color,
          )}
        >
          {meta.verb}
        </span>
        <span className="flex-1 min-w-0 text-[11px] font-mono text-zinc-200 truncate">
          {describeEntryTitle(entry)}
        </span>
        {meta.warn && (
          <span
            className="shrink-0 w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse"
            title={t('rightSidebar.audit.confirmedWithoutEvidence')}
          />
        )}
        <span className="shrink-0 text-[9px] font-mono text-zinc-600 truncate max-w-[120px]">
          {describeEntryRef(entry)}
        </span>
      </button>
    </li>
  );
}

/**
 * Focus modal for one audit entry — full details by verb. Reuses the
 * same `<EvidenceTrail>` for confirm entries that have one. Closed via
 * Esc / X / backdrop.
 */
function AuditEntryDetailModal({
  entry,
  onClose,
}: {
  entry: AuditEntry;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const meta = deriveAuditMeta(entry);
  const ts = new Date(entry.ts);

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-bg border border-border-strong rounded-lg w-[min(620px,100%)] max-h-[85vh] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-border-strong relative">
          <button
            type="button"
            onClick={onClose}
            className="absolute top-3 right-3 text-zinc-500 hover:text-zinc-100 w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated"
            aria-label={t('common.close')}
          >
            ✕
          </button>
          <div className="flex items-center gap-2 mb-2">
            {meta.icon}
            <span
              className={cn(
                'text-[10px] uppercase tracking-widest font-mono font-bold',
                meta.color,
              )}
            >
              {meta.verb}
            </span>
            {meta.warn && (
              <span className="text-[10px] font-mono text-red-300">
                {t('rightSidebar.audit.emptyTrail')}
              </span>
            )}
            <span className="ml-auto text-[10px] font-mono text-zinc-500 tabular-nums">
              {ts.toLocaleString()}
            </span>
          </div>
          <h3 className="text-[14px] font-mono leading-relaxed text-zinc-100 break-words pr-8">
            {describeEntryTitle(entry)}
          </h3>
          <p className="mt-1 text-[10px] font-mono text-zinc-500 truncate">
            {describeEntryRef(entry)}
          </p>
        </header>

        <div className="flex-1 overflow-y-auto scrollbar-thin px-5 py-4 space-y-4">
          {/* Actor-line per verb — gives the "who" at a glance. */}
          {entry.type === 'phase-registered' && (
            <p className="text-[12px] font-mono text-zinc-300">
              {t('rightSidebar.audit.detail.declared', { count: entry.itemCount, title: entry.title })}
              {entry.isReregistration && (
                <span className="text-zinc-500"> {t('rightSidebar.audit.detail.reRegistration')}</span>
              )}
            </p>
          )}
          {entry.type === 'phase-item-proposed' && (
            <p className="text-[12px] font-mono text-zinc-300">
              {t('rightSidebar.audit.detail.proposedBy', { agent: entry.agent })}
            </p>
          )}
          {entry.type === 'phase-item-confirmed' && (
            <p className="text-[12px] font-mono text-zinc-300">
              {t('rightSidebar.audit.detail.confirmedBy', { confirmer: entry.confirmer })}
              {entry.proposer && (
                <> {t('rightSidebar.audit.detail.originallyProposed', { proposer: entry.proposer })}</>
              )}
            </p>
          )}
          {entry.type === 'phase-item-rejected' && (
            <p className="text-[12px] font-mono text-zinc-300">
              {t('rightSidebar.audit.detail.rejectedBy', { rejector: entry.rejector })}
              {entry.proposer && (
                <> {t('rightSidebar.audit.detail.originallyProposed', { proposer: entry.proposer })}</>
              )}
            </p>
          )}
          {entry.type === 'phase-item-operator-verified' && (
            <p className="text-[12px] font-mono text-zinc-300">
              {t('rightSidebar.audit.detail.opVerifiedBy', { operator: entry.operator })}
            </p>
          )}

          {/* Verb-specific bodies */}
          {entry.type === 'phase-item-proposed' && entry.notes.trim().length > 0 && (
            <Section title={t('rightSidebar.phases.section.proposerNotes')}>
              <pre className="text-[12px] leading-relaxed font-mono text-zinc-200 whitespace-pre-wrap break-words bg-bg-subtle/50 rounded border border-border/40 px-3 py-2">
                {entry.notes}
              </pre>
            </Section>
          )}
          {entry.type === 'phase-item-confirmed' && (
            <>
              {entry.evidence && entry.evidence.totalCount > 0 && (
                <Section title={t('rightSidebar.phases.section.verificationTrail')}>
                  <EvidenceTrail evidence={entry.evidence} />
                </Section>
              )}
              {meta.warn && (
                <div className="rounded border border-red-700/50 bg-red-950/20 px-3 py-2.5">
                  <p className="text-[12px] leading-relaxed text-red-200">
                    {t('rightSidebar.audit.detail.rubberStamp')}
                  </p>
                </div>
              )}
              {entry.notes.trim().length > 0 && (
                <Section title={t('rightSidebar.phases.section.confirmerNotes')}>
                  <pre className="text-[12px] leading-relaxed font-mono text-zinc-200 whitespace-pre-wrap break-words bg-bg-subtle/50 rounded border border-border/40 px-3 py-2">
                    {entry.notes}
                  </pre>
                </Section>
              )}
            </>
          )}
          {entry.type === 'phase-item-rejected' && (
            <Section title={t('rightSidebar.phases.section.rejectionReason')}>
              <pre className="text-[12px] leading-relaxed font-mono text-rose-100 whitespace-pre-wrap break-words bg-rose-950/20 border border-rose-700/40 rounded px-3 py-2">
                {entry.reason}
              </pre>
            </Section>
          )}
          {entry.type === 'phase-item-operator-verified' && entry.notes.trim().length > 0 && (
            <Section title={t('rightSidebar.phases.section.operatorNotes')}>
              <pre className="text-[12px] leading-relaxed font-mono text-zinc-200 whitespace-pre-wrap break-words bg-bg-subtle/50 rounded border border-border/40 px-3 py-2">
                {entry.notes}
              </pre>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="text-[10px] uppercase tracking-widest font-mono text-zinc-500 mb-1.5">
        {title}
      </h4>
      {children}
    </section>
  );
}


/* ───────────────── Memory panel ───────────────── */

function MemoryPanel({
  sessionId,
  onPreview,
  onEdit,
}: {
  sessionId: string;
  /** Project + shared paths route through the existing FilePreviewModal. */
  onPreview: (path: string) => void;
  /** Same — modal opens in edit mode. */
  onEdit: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<{
    project: MemoryOverviewEntry[];
    shared: MemoryOverviewEntry[];
    auto: MemoryOverviewEntry[];
    userGlobal: MemoryOverviewEntry[];
    encodedCwd: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Auto-memory files use a different read/write API; we open a
  // dedicated modal scoped to that bucket. Track which name is open.
  const [autoEditName, setAutoEditName] = useState<string | null>(null);
  // User-global ~/.claude/CLAUDE.md is read-only and lives outside cwd;
  // a dedicated viewer surfaces it.
  const [userGlobalPath, setUserGlobalPath] = useState<string | null>(null);
  const [userGlobalContent, setUserGlobalContent] = useState<string | null>(null);

  // Refresh trigger — fetched on mount, refetched when an auto-memory
  // edit lands (modal closes with a save) so the preview stays fresh.
  const [refreshTick, setRefreshTick] = useState(0);
  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    api
      .getMemoryOverview(sessionId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshTick]);

  if (error) return <div className="p-3 text-[11px] text-red-400 italic">{error}</div>;
  if (!data) return <div className="p-3 text-[11px] text-zinc-500 italic">loading…</div>;

  const handleClick = (entry: MemoryOverviewEntry) => {
    if (entry.kind === 'project' || entry.kind === 'shared') {
      // Both sit under cwd — existing FilePreviewModal handles them.
      if (entry.editable) onEdit(entry.ref);
      else onPreview(entry.ref);
      return;
    }
    if (entry.kind === 'auto') {
      setAutoEditName(entry.name);
      return;
    }
    // user-global ~/.claude/CLAUDE.md — outside session sandbox; we
    // already have the preview from the overview, but a full viewer
    // needs the complete file. The backend's `/file?path=...` is
    // cwd-sandboxed and would reject here, so we just surface the
    // preview as the body. If the operator wants the full file they
    // can open it in their own editor.
    setUserGlobalPath(entry.ref);
    setUserGlobalContent(entry.preview);
  };

  return (
    <div className="p-3 space-y-4">
      <MemorySection
        title={t('rightSidebar.memory.section.projectRules')}
        kind="project"
        hint={t('rightSidebar.memory.section.projectRules.hint')}
        entries={data.project}
        emptyText={t('rightSidebar.memory.section.projectRules.empty')}
        onClick={handleClick}
      />
      <MemorySection
        title={t('rightSidebar.memory.section.sharedMemory')}
        kind="shared"
        hint={t('rightSidebar.memory.section.sharedMemory.hint')}
        entries={data.shared}
        emptyText={t('rightSidebar.memory.section.sharedMemory.empty')}
        onClick={handleClick}
      />
      <MemorySection
        title={t('rightSidebar.memory.section.ccAutoMemory')}
        kind="auto"
        hint={`~/.claude/projects/${data.encodedCwd}/memory/*.md`}
        entries={data.auto}
        emptyText={t('rightSidebar.memory.section.ccAutoMemory.empty')}
        onClick={handleClick}
      />
      <MemorySection
        title={t('rightSidebar.memory.section.userGlobal')}
        kind="user-global"
        hint={t('rightSidebar.memory.section.userGlobal.hint')}
        entries={data.userGlobal}
        emptyText={t('rightSidebar.memory.section.userGlobal.empty')}
        onClick={handleClick}
      />

      {autoEditName && (
        <AutoMemoryFileModal
          sessionId={sessionId}
          name={autoEditName}
          onClose={() => {
            setAutoEditName(null);
            refresh();
          }}
        />
      )}
      {userGlobalPath && (
        <UserGlobalViewerModal
          path={userGlobalPath}
          content={userGlobalContent}
          onClose={() => {
            setUserGlobalPath(null);
            setUserGlobalContent(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Per-section colour palette — same hue family as the title accent
 * but applied as a subtle bg + border so the four memory layers stay
 * visually distinct even when they're all empty or all packed with
 * rows. Title-only single-line header with the path moved into a
 * tooltip keeps the chrome compact regardless of path length.
 */
const SECTION_THEME: Record<
  MemoryOverviewEntry['kind'],
  { title: string; container: string }
> = {
  project: {
    title: 'text-cyan-300',
    container: 'border-cyan-900/40 bg-cyan-950/15',
  },
  shared: {
    title: 'text-violet-300',
    container: 'border-violet-900/40 bg-violet-950/15',
  },
  auto: {
    title: 'text-amber-300',
    container: 'border-amber-900/40 bg-amber-950/15',
  },
  'user-global': {
    title: 'text-zinc-400',
    container: 'border-zinc-700/40 bg-zinc-900/30',
  },
};

function MemorySection({
  title,
  kind,
  hint,
  entries,
  emptyText,
  onClick,
}: {
  title: string;
  /** Layer kind drives the bg/border colour palette. */
  kind: MemoryOverviewEntry['kind'];
  /** Path string surfaced via the title tooltip. */
  hint: string;
  entries: MemoryOverviewEntry[];
  emptyText: string;
  onClick: (entry: MemoryOverviewEntry) => void;
}) {
  const { t } = useTranslation();
  const theme = SECTION_THEME[kind];
  return (
    <section className={cn('rounded-lg border overflow-hidden', theme.container)}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-current/10">
        <h3
          className={cn(
            'text-[10px] font-mono uppercase tracking-widest font-semibold',
            theme.title,
          )}
          title={hint}
        >
          {title}
        </h3>
        <span
          className="shrink-0 text-zinc-600 cursor-help"
          title={hint}
          aria-label={t('rightSidebar.memory.pathLabel', { hint })}
        >
          <Info size={11} />
        </span>
        {entries.length > 0 && (
          <span className="ml-auto text-[10px] tabular-nums font-mono text-zinc-500">
            {entries.length}
          </span>
        )}
      </div>
      <div className="p-2">
        {entries.length === 0 ? (
          <p className="text-[11px] text-zinc-500 italic leading-relaxed px-1 py-0.5">
            {emptyText}
          </p>
        ) : (
          <ul className="space-y-1">
            {entries.map((e) => (
              <MemoryRow key={`${e.kind}-${e.ref}`} entry={e} onClick={() => onClick(e)} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function MemoryRow({
  entry,
  onClick,
}: {
  entry: MemoryOverviewEntry;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  // Compact default — title row only (1 line). Click row toggles an
  // inline preview block; the dedicated open-icon (right side) goes
  // straight to the full viewer / editor modal. Two distinct
  // affordances, both single-click — no ambiguity, and dense lists
  // scan fast at the title level.
  const [open, setOpen] = useState(false);
  const hasPreview = entry.preview.trim().length > 0;
  return (
    <li className="rounded border border-border/40 bg-bg-elevated/30 overflow-hidden">
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={() => hasPreview && setOpen(!open)}
          disabled={!hasPreview}
          className={cn(
            'group flex-1 flex items-center gap-2 px-2.5 py-1.5 text-left min-w-0',
            hasPreview && 'hover:bg-bg-elevated/60',
          )}
          title={hasPreview ? (open ? t('rightSidebar.memory.collapsePreview') : t('rightSidebar.memory.showPreview')) : t('rightSidebar.memory.emptyFile')}
        >
          {hasPreview ? (
            open ? (
              <ChevronDown size={11} className="shrink-0 text-zinc-500" />
            ) : (
              <ChevronRight size={11} className="shrink-0 text-zinc-500" />
            )
          ) : (
            <FileText size={11} className="shrink-0 text-zinc-600" />
          )}
          <span className="flex-1 text-[12px] font-mono font-semibold text-zinc-200 truncate">
            {entry.name}
          </span>
          <span className="shrink-0 text-[10px] font-mono tabular-nums text-zinc-500">
            {formatSize(entry.size)}
          </span>
          {!entry.editable && (
            <span className="shrink-0 text-[9px] font-mono uppercase tracking-wide text-zinc-600">
              {t('rightSidebar.memory.readOnly')}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={onClick}
          className="shrink-0 px-2.5 text-zinc-500 hover:text-zinc-100 hover:bg-bg-elevated/60 border-l border-border/40"
          title={entry.editable ? t('rightSidebar.memory.openEditor') : t('rightSidebar.memory.openViewer')}
        >
          <ExternalLink size={11} />
        </button>
      </div>
      {open && hasPreview && (
        <div className="px-3 pb-2 pt-1.5 border-t border-border/30 bg-bg-subtle/30">
          <p className="text-[11px] leading-relaxed font-mono text-zinc-400 whitespace-pre-wrap break-words line-clamp-6">
            {entry.preview}
          </p>
          <button
            type="button"
            onClick={onClick}
            className="mt-1.5 text-[10px] underline text-zinc-500 hover:text-zinc-200"
          >
            {entry.editable ? t('rightSidebar.memory.openEditorLink') : t('rightSidebar.memory.openViewerLink')}
          </button>
        </div>
      )}
    </li>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

/**
 * Edit modal for CC auto-memory files. Mirrors FilePreviewModal's
 * edit affordances but uses the dedicated `/auto-memory/file/:name`
 * endpoints since those files live outside cwd.
 */
function AutoMemoryFileModal({
  sessionId,
  name,
  onClose,
}: {
  sessionId: string;
  name: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [content, setContent] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [size, setSize] = useState(0);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getAutoMemoryFile(sessionId, name)
      .then((f) => {
        if (cancelled) return;
        setContent(f.content);
        setDraft(f.content);
        setSize(f.size);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, name]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editing) onClose();
      if (e.key === 's' && (e.metaKey || e.ctrlKey) && editing) {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, editing, draft]);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api.putAutoMemoryFile(sessionId, name, draft);
      setContent(draft);
      setSize(r.size);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const dirty = content !== null && draft !== content;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-bg border border-border rounded-lg w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <FileText size={14} className="text-amber-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <code className="block text-[12px] font-mono text-zinc-200 truncate">
              {name}
            </code>
            <code className="block text-[10px] font-mono text-zinc-500 truncate">
              ~/.claude/projects/.../memory/
            </code>
          </div>
          <span className="text-[10px] text-zinc-500 tabular-nums">
            {formatSize(editing ? draft.length : size)}
            {dirty && <span className="ml-1 text-amber-400">●</span>}
          </span>
          {!editing && content !== null && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-zinc-400 hover:text-zinc-100 p-1.5 rounded hover:bg-zinc-800/60"
              title={t('rightSidebar.memory.openEditor')}
            >
              ✎
            </button>
          )}
          {editing && (
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || saving}
              className={cn(
                'px-3 py-1 rounded text-[11px] font-medium font-mono',
                dirty && !saving
                  ? 'bg-cyan-600 hover:bg-cyan-500 text-white'
                  : 'bg-zinc-800 text-zinc-500 cursor-not-allowed',
              )}
              title={t('settings.prompts.saveTitle')}
            >
              {saving ? t('rightSidebar.stack.save.saving') : t('rightSidebar.stack.save.idle')}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-100 w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated"
            aria-label={t('common.close')}
          >
            ✕
          </button>
        </header>
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {error && (
            <p className="px-4 pt-3 text-[11px] text-red-400 font-mono">{error}</p>
          )}
          {content === null && !error ? (
            <div className="p-6 text-[12px] font-mono text-zinc-500 italic">loading…</div>
          ) : editing ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="w-full h-full min-h-[60vh] bg-bg p-4 text-[12px] leading-relaxed font-mono text-zinc-100 focus:outline-none resize-none"
              autoFocus
            />
          ) : (
            <pre className="p-4 text-[12px] leading-relaxed font-mono text-zinc-200 whitespace-pre-wrap break-words">
              {content || <span className="italic text-zinc-500">{t('rightSidebar.memory.emptyFileIndicator')}</span>}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Read-only viewer for `~/.claude/CLAUDE.md`. Lives outside the session
 * sandbox so we don't expose write APIs for it from this UI.
 */
function UserGlobalViewerModal({
  path,
  content,
  onClose,
}: {
  path: string;
  content: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-bg border border-border rounded-lg w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <FileText size={14} className="text-zinc-500 shrink-0" />
          <code className="flex-1 text-[12px] font-mono text-zinc-300 truncate" title={path}>
            {path}
          </code>
          <span className="text-[9px] font-mono uppercase tracking-wide text-zinc-600">
            {t('rightSidebar.memory.readOnlyBadge')}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-100 w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated"
            aria-label={t('common.close')}
          >
            ✕
          </button>
        </header>
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {content === null ? (
            <div className="p-6 text-[12px] font-mono text-zinc-500 italic">loading…</div>
          ) : (
            <pre className="p-4 text-[12px] leading-relaxed font-mono text-zinc-200 whitespace-pre-wrap break-words">
              {content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

/* ───────────────── Decision trail (Phase 6 — Replay & audit) ───────────────── */

/**
 * Unified decision trail. Surfaces every chat-log entry that
 * represents a *decision moment* — sup verdicts, phase-tracker
 * mutations, approval requests + resolutions, delegation handoffs.
 *
 * Per ROADMAP Phase 6 calibration: this is a trust-signalling
 * feature, not a high-traffic one. ~80% of operators won't
 * actively scrub through it. So we ship the minimum that's actually
 * useful — a chronological card list with filter chips — and skip
 * the gold-plating (search across sessions, side-by-side
 * comparison, syntax-highlighted diffs).
 *
 * Entries land in time order (oldest first). The chip strip
 * narrows the feed without re-fetching; "All" is the default.
 */

type DecisionFilter = 'all' | 'verdicts' | 'phase' | 'approvals' | 'delegations';

interface DecisionEntry {
  /** Time-ordered key for React. */
  key: string;
  /** Stable group; drives icon, accent, and filter routing. */
  kind: 'verdict' | 'phase' | 'approval' | 'delegation';
  ts: number;
  /** Underlying chat-log entry — the renderer narrows on `entry.type`. */
  entry: ChatLogEntry;
}

function buildDecisionTrail(chatLog: ChatLogEntry[]): DecisionEntry[] {
  const out: DecisionEntry[] = [];
  for (let i = 0; i < chatLog.length; i++) {
    const e = chatLog[i]!;
    let kind: DecisionEntry['kind'] | null = null;
    switch (e.type) {
      case 'verdict':
        kind = 'verdict';
        break;
      case 'phase-doc-written':
      case 'phase-registered':
      case 'phase-item-confirmed':
      case 'phase-item-rejected':
      case 'phase-item-operator-verified':
        kind = 'phase';
        break;
      case 'approval':
      case 'approval-resolved':
        kind = 'approval';
        break;
      case 'task-marker':
        kind = 'delegation';
        break;
      default:
        kind = null;
    }
    if (kind) {
      out.push({ key: `${e.ts}-${i}`, kind, ts: e.ts, entry: e });
    }
  }
  return out;
}

function DecisionRoomPanel({
  chatLog,
}: {
  chatLog: ChatLogEntry[];
  /**
   * Sprint 2 wires the Export button at the parent header level
   * (`ExportDecisionsButton`); the panel no longer needs sessionId.
   * Keeping the prop name in the parent's call-site for future use
   * if the panel ever needs to re-fetch something on its own.
   */
  sessionId?: string;
}) {
  const { t } = useTranslation();
  const trail = useMemo(() => buildDecisionTrail(chatLog), [chatLog]);
  const [filter, setFilter] = useState<DecisionFilter>('all');

  const filtered = useMemo(() => {
    if (filter === 'all') return trail;
    if (filter === 'verdicts') return trail.filter((e) => e.kind === 'verdict');
    if (filter === 'phase') return trail.filter((e) => e.kind === 'phase');
    if (filter === 'approvals') return trail.filter((e) => e.kind === 'approval');
    return trail.filter((e) => e.kind === 'delegation');
  }, [trail, filter]);

  // Counts per group — drives the chip badges so the operator can see
  // at a glance whether a category has any entries before clicking it.
  const counts = useMemo(() => {
    const c = { all: trail.length, verdicts: 0, phase: 0, approvals: 0, delegations: 0 };
    for (const e of trail) {
      if (e.kind === 'verdict') c.verdicts += 1;
      else if (e.kind === 'phase') c.phase += 1;
      else if (e.kind === 'approval') c.approvals += 1;
      else if (e.kind === 'delegation') c.delegations += 1;
    }
    return c;
  }, [trail]);

  if (trail.length === 0) {
    return (
      <div className="p-2 text-[11px] text-zinc-500 italic leading-relaxed">
        {t('rightSidebar.decisions.empty')}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <DecisionFilterChips filter={filter} onFilter={setFilter} counts={counts} />
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {filtered.length === 0 ? (
          <div className="p-3 text-[11px] text-zinc-500 italic">
            {t('rightSidebar.decisions.noEntries')}
          </div>
        ) : (
          <div className="p-2 space-y-1.5">
            {filtered.map((e) => (
              <DecisionCard key={e.key} entry={e} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Mini Export button rendered inside the right-sidebar's tab title
 * bar. Triggered by `RightPanelContent` when `activeTab === 'decisions'`
 * so the button takes up zero space when the operator is viewing any
 * other panel. Disabled when the trail is empty (nothing to export).
 *
 * Keeping it standalone (instead of inside DecisionRoomPanel) means
 * the panel's filter chip strip can use the full row width without
 * fighting the export button for space.
 */
function ExportDecisionsButton({
  chatLog,
  sessionId,
}: {
  chatLog: ChatLogEntry[];
  sessionId: string;
}) {
  const { t } = useTranslation();
  const trail = useMemo(() => buildDecisionTrail(chatLog), [chatLog]);
  const [exporting, setExporting] = useState(false);

  const onExport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/decision-report`);
      if (!res.ok) {
        // biome-ignore lint/suspicious/noConsole: surface failure visibly
        console.warn('decision report export failed:', res.status, res.statusText);
        return;
      }
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] ?? `decision-report-${sessionId.slice(0, 8)}.md`;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }, [exporting, sessionId]);

  const disabled = exporting || trail.length === 0;
  return (
    <button
      type="button"
      onClick={onExport}
      disabled={disabled}
      className={cn(
        'ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wider transition-colors',
        disabled
          ? 'text-zinc-600 cursor-not-allowed'
          : 'text-zinc-400 hover:text-cyan-200 hover:bg-bg-elevated',
      )}
      title={
        trail.length === 0
          ? t('rightSidebar.decisions.export.empty')
          : t('rightSidebar.decisions.export.title')
      }
    >
      {exporting ? (
        <Loader2 size={10} className="animate-spin" />
      ) : (
        <Download size={10} />
      )}
      <span>{t('rightSidebar.decisions.export')}</span>
    </button>
  );
}

function DecisionFilterChips({
  filter,
  onFilter,
  counts,
  embedded = false,
}: {
  filter: DecisionFilter;
  onFilter: (f: DecisionFilter) => void;
  counts: { all: number; verdicts: number; phase: number; approvals: number; delegations: number };
  /**
   * When true, the chip strip is rendered inside a parent that
   * already supplies the bottom border + background — drops its own
   * border styling so the seam isn't doubled.
   */
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const chips: { key: DecisionFilter; label: string; count: number }[] = [
    { key: 'all', label: t('rightSidebar.decisions.filter.all'), count: counts.all },
    { key: 'verdicts', label: t('rightSidebar.decisions.filter.verdicts'), count: counts.verdicts },
    { key: 'phase', label: t('rightSidebar.decisions.filter.phase'), count: counts.phase },
    { key: 'approvals', label: t('rightSidebar.decisions.filter.approvals'), count: counts.approvals },
    { key: 'delegations', label: t('rightSidebar.decisions.filter.delegations'), count: counts.delegations },
  ];
  return (
    <div
      className={cn(
        'flex items-center gap-1 px-2 py-1.5 overflow-x-auto scrollbar-thin',
        !embedded && 'border-b border-border/50 bg-bg-subtle/40',
      )}
    >
      {chips.map((chip) => {
        const active = filter === chip.key;
        return (
          <button
            key={chip.key}
            type="button"
            onClick={() => onFilter(chip.key)}
            className={cn(
              'shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wider transition-colors',
              active
                ? 'bg-cyan-700/40 text-cyan-100 border border-cyan-600/40'
                : 'text-zinc-400 hover:text-zinc-100 hover:bg-bg-elevated border border-transparent',
            )}
          >
            <span>{chip.label}</span>
            <span
              className={cn(
                'tabular-nums text-[9px]',
                active ? 'text-cyan-300' : 'text-zinc-500',
              )}
            >
              {chip.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function formatDecisionTime(ts: number): { time: string; full: string } {
  const d = new Date(ts);
  const time = `${d.getHours().toString().padStart(2, '0')}:${d
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
  return { time, full: d.toLocaleString() };
}

/**
 * Per-entry card. The shape is union'd on `entry.type` so each kind
 * gets its own icon, accent, and body — instead of one generic card
 * that loses information across types.
 */
function DecisionCard({ entry }: { entry: DecisionEntry }) {
  const { t } = useTranslation();
  const e = entry.entry;
  const { time, full } = formatDecisionTime(entry.ts);

  if (e.type === 'verdict') {
    return (
      <div className="rounded border-l-4 border-red-500 border-r border-y border-red-700/50 bg-red-950/30 px-2.5 py-2">
        <div className="flex items-center gap-1.5 mb-1">
          <Gavel size={12} className="text-red-300 shrink-0" />
          <span className="text-[10px] uppercase tracking-widest font-bold text-red-300">
            {t('rightSidebar.decisions.label.verdict')}
          </span>
          <span className="text-[10px] text-red-400 font-mono tabular-nums">
            #{e.id.toString().padStart(3, '0')}
          </span>
          <span
            className="ml-auto text-[10px] font-mono text-red-500 tabular-nums"
            title={full}
          >
            {time}
          </span>
        </div>
        <p className="text-[12px] leading-relaxed whitespace-pre-wrap text-red-50 font-mono">
          {e.text}
        </p>
      </div>
    );
  }

  if (e.type === 'phase-doc-written') {
    return (
      <DecisionRow
        icon={<FileText size={11} className="text-cyan-300" />}
        accent="cyan"
        label={t('rightSidebar.decisions.label.phaseDoc')}
        title={
          <span>
            wrote <code className="text-cyan-100">{e.filename}</code>
          </span>
        }
        time={time}
        fullTime={full}
      />
    );
  }

  if (e.type === 'phase-registered') {
    return (
      <DecisionRow
        icon={<ListChecks size={11} className="text-cyan-300" />}
        accent="cyan"
        label={e.isReregistration ? t('rightSidebar.decisions.label.reRegistered') : t('rightSidebar.decisions.label.registered')}
        title={
          <span>
            <code className="text-cyan-100">{e.slug}</code>
            <span className="text-zinc-500"> · </span>
            <span className="text-zinc-300">
              {e.itemCount} item{e.itemCount === 1 ? '' : 's'}
            </span>
            <span className="text-zinc-500"> · </span>
            <span className="text-zinc-400">{e.title}</span>
          </span>
        }
        time={time}
        fullTime={full}
      />
    );
  }

  if (e.type === 'phase-item-confirmed') {
    const evidenceCount = e.evidence?.totalCount ?? 0;
    return (
      <DecisionRow
        icon={<CheckCircle2 size={11} className="text-emerald-400" />}
        accent="emerald"
        label={t('rightSidebar.decisions.label.confirmed')}
        title={
          <span>
            <code className="text-emerald-100">{e.slug}/{e.itemId}</code>
            <span className="text-zinc-500"> · </span>
            <span className="text-zinc-300">{e.itemTitle}</span>
            {evidenceCount > 0 && (
              <span className="ml-1 text-[10px] text-emerald-400">
                ({evidenceCount} verification call{evidenceCount === 1 ? '' : 's'})
              </span>
            )}
          </span>
        }
        body={e.notes ? e.notes : null}
        time={time}
        fullTime={full}
      />
    );
  }

  if (e.type === 'phase-item-rejected') {
    return (
      <DecisionRow
        icon={<X size={11} className="text-rose-400" />}
        accent="rose"
        label={t('rightSidebar.decisions.label.rejected')}
        title={
          <span>
            <code className="text-rose-100">{e.slug}/{e.itemId}</code>
            <span className="text-zinc-500"> · </span>
            <span className="text-zinc-300">{e.itemTitle}</span>
          </span>
        }
        body={e.reason}
        time={time}
        fullTime={full}
      />
    );
  }

  if (e.type === 'phase-item-operator-verified') {
    return (
      <DecisionRow
        icon={<UserCheck size={11} className="text-amber-300" />}
        accent="amber"
        label={t('rightSidebar.decisions.label.opVerified')}
        title={
          <span>
            <code className="text-amber-100">{e.slug}/{e.itemId}</code>
            <span className="text-zinc-500"> · </span>
            <span className="text-zinc-300">{e.itemTitle}</span>
          </span>
        }
        body={e.notes ? e.notes : null}
        time={time}
        fullTime={full}
      />
    );
  }

  if (e.type === 'approval') {
    return (
      <DecisionRow
        icon={<ShieldCheck size={11} className="text-amber-300" />}
        accent="amber"
        label={t('rightSidebar.decisions.label.approvalRequested')}
        title={<span className="text-zinc-200">{e.action}</span>}
        body={e.reason}
        time={time}
        fullTime={full}
      />
    );
  }

  if (e.type === 'approval-resolved') {
    const allow = e.decision === 'allow';
    return (
      <DecisionRow
        icon={
          allow ? (
            <ShieldCheck size={11} className="text-emerald-400" />
          ) : (
            <ShieldX size={11} className="text-rose-400" />
          )
        }
        accent={allow ? 'emerald' : 'rose'}
        label={allow ? t('rightSidebar.decisions.label.approved') : t('rightSidebar.decisions.label.denied')}
        title={
          <span className="text-zinc-200 font-mono text-[10px]">
            request id {e.id.slice(0, 8)}
          </span>
        }
        time={time}
        fullTime={full}
      />
    );
  }

  if (e.type === 'task-marker') {
    return (
      <DecisionRow
        icon={<Send size={11} className="text-violet-300" />}
        accent="violet"
        label={t('rightSidebar.decisions.label.delegated')}
        title={<span className="text-zinc-200">{e.summary}</span>}
        time={time}
        fullTime={full}
      />
    );
  }

  // Defensive — should never hit because buildDecisionTrail filters tightly.
  return null;
}

function DecisionRow({
  icon,
  accent,
  label,
  title,
  body,
  time,
  fullTime,
}: {
  icon: React.ReactNode;
  accent: 'cyan' | 'emerald' | 'amber' | 'violet' | 'rose';
  label: string;
  title: React.ReactNode;
  body?: string | null;
  time: string;
  fullTime: string;
}) {
  const accentBorder = {
    cyan: 'border-cyan-700/40 bg-cyan-950/20',
    emerald: 'border-emerald-700/40 bg-emerald-950/20',
    amber: 'border-amber-700/40 bg-amber-950/20',
    violet: 'border-violet-700/40 bg-violet-950/20',
    rose: 'border-rose-700/40 bg-rose-950/20',
  }[accent];
  const labelTone = {
    cyan: 'text-cyan-300',
    emerald: 'text-emerald-300',
    amber: 'text-amber-300',
    violet: 'text-violet-300',
    rose: 'text-rose-300',
  }[accent];
  return (
    <div className={cn('rounded border px-2.5 py-1.5', accentBorder)}>
      <div className="flex items-center gap-1.5">
        <span className="shrink-0">{icon}</span>
        <span
          className={cn(
            'text-[10px] uppercase tracking-widest font-semibold',
            labelTone,
          )}
        >
          {label}
        </span>
        <span
          className="ml-auto text-[10px] font-mono text-zinc-500 tabular-nums"
          title={fullTime}
        >
          {time}
        </span>
      </div>
      <div className="text-[12px] leading-snug mt-0.5 text-zinc-200">{title}</div>
      {body && (
        <div className="text-[11px] text-zinc-400 mt-1 whitespace-pre-wrap leading-snug">
          {body}
        </div>
      )}
    </div>
  );
}

/* ───────────────── Agents Room (free chat) ───────────────── */

/**
 * AgentsRoom — chronological feed of `<ROOM>…</ROOM>` posts. Polished
 * pass: messages are grouped into clusters when the same agent posts
 * multiple times within a short window (CLUSTER_WINDOW_MS), so a
 * back-and-forth doesn't dilute into N separate cards. Each cluster
 * gets a circular agent avatar (initial letter, color-coded), a
 * mention chip when the body opens with `<other-agent> —` (a common
 * pattern in our agent prompts to address a peer), and a hover
 * timestamp for fine-grained review.
 *
 * Filter chip strip at the top lets the operator narrow to one agent
 * — useful when several specialists are talking at once.
 */
function AgentsRoomPanel({ chatLog }: { chatLog: ChatLogEntry[] }) {
  const { t } = useTranslation();
  const messages = useMemo(
    () =>
      chatLog.filter(
        (e): e is Extract<ChatLogEntry, { type: 'room-message' }> =>
          e.type === 'room-message',
      ),
    [chatLog],
  );

  // Distinct agents in the feed — drives the filter chip strip.
  const agents = useMemo(() => {
    const set = new Set<string>();
    for (const m of messages) set.add(m.agent);
    return Array.from(set);
  }, [messages]);

  const [filter, setFilter] = useState<string | null>(null);
  const filtered = filter === null ? messages : messages.filter((m) => m.agent === filter);

  // Cluster: consecutive messages from the same agent within the
  // window collapse into one card with N body paragraphs.
  const CLUSTER_WINDOW_MS = 5 * 60 * 1000;
  const clusters = useMemo(() => {
    const out: { agent: string; items: typeof filtered }[] = [];
    for (const m of filtered) {
      const last = out[out.length - 1];
      if (
        last &&
        last.agent === m.agent &&
        m.ts - last.items[last.items.length - 1]!.ts <= CLUSTER_WINDOW_MS
      ) {
        last.items.push(m);
      } else {
        out.push({ agent: m.agent, items: [m] });
      }
    }
    return out;
  }, [filtered]);

  if (messages.length === 0) {
    return (
      <div className="p-3 text-[11px] text-zinc-500 italic leading-relaxed">
        {t('rightSidebar.room.empty')}
      </div>
    );
  }

  return (
    <div className="p-2 space-y-2">
      {/* Filter chip strip — only when 2+ agents have posted. */}
      {agents.length >= 2 && (
        <div className="flex items-center gap-1 flex-wrap pb-1.5 border-b border-border/40 -mx-1 px-1">
          <span className="text-[10px] uppercase tracking-widest font-mono text-zinc-600 mr-1">
            {t('rightSidebar.room.filter')}
          </span>
          <button
            type="button"
            onClick={() => setFilter(null)}
            className={cn(
              'text-[10px] font-mono px-2 py-0.5 rounded border',
              filter === null
                ? 'border-zinc-500 bg-zinc-700/40 text-zinc-100'
                : 'border-zinc-700/40 text-zinc-400 hover:bg-zinc-800/40',
            )}
          >
            {t('rightSidebar.room.filter.all', { count: messages.length })}
          </button>
          {agents.map((agent) => {
            const accent = AGENT_BUBBLE_THEME[agent] ?? AGENT_BUBBLE_THEME._default!;
            const count = messages.filter((m) => m.agent === agent).length;
            return (
              <button
                key={agent}
                type="button"
                onClick={() => setFilter(filter === agent ? null : agent)}
                className={cn(
                  'inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded border',
                  filter === agent
                    ? `${accent.border.split(' ')[0]} ${accent.bg} ${accent.label}`
                    : 'border-zinc-700/40 text-zinc-400 hover:bg-zinc-800/40',
                )}
              >
                {agent} ({count})
              </button>
            );
          })}
        </div>
      )}

      {clusters.map((c, i) => (
        <RoomCluster key={`${c.items[0]!.ts}-${i}`} agent={c.agent} items={c.items} />
      ))}
    </div>
  );
}

function RoomCluster({
  agent,
  items,
}: {
  agent: string;
  items: Extract<ChatLogEntry, { type: 'room-message' }>[];
}) {
  const { t } = useTranslation();
  const accent = AGENT_BUBBLE_THEME[agent] ?? AGENT_BUBBLE_THEME._default!;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const firstTime = formatHmS(first.ts);
  const lastTime = formatHmS(last.ts);
  const range = items.length > 1 ? `${firstTime} → ${lastTime}` : firstTime;
  return (
    <div
      className={cn(
        'rounded border-l-2 border-r border-y',
        accent.border,
        accent.bg,
      )}
    >
      <header className="flex items-center gap-2 px-2.5 py-1.5">
        <AgentAvatar agent={agent} />
        <span
          className={cn(
            'text-[11px] uppercase tracking-widest font-bold',
            accent.label,
          )}
        >
          {agent}
        </span>
        {items.length > 1 && (
          <span className="text-[9px] uppercase tracking-wide font-mono text-zinc-500">
            {t('rightSidebar.room.posts', { count: items.length })}
          </span>
        )}
        <span
          className="ml-auto text-[10px] font-mono text-zinc-600 tabular-nums"
          title={`${new Date(first.ts).toLocaleString()} → ${new Date(last.ts).toLocaleString()}`}
        >
          {range}
        </span>
      </header>
      <div className="px-2.5 pb-2 space-y-2">
        {items.map((m, i) => (
          <RoomMessage key={`${m.ts}-${i}`} body={m.text} />
        ))}
      </div>
    </div>
  );
}

function RoomMessage({ body }: { body: string }) {
  const { t } = useTranslation();
  // Detect a leading "<agent-name> — " mention pattern. The agent
  // prompts encourage opening posts with the addressee, e.g.
  //   "ui-dev — proposing we expose /api/foo".
  // Surface that as a chip so the operator scans recipient at a glance.
  const MENTION_RE = /^\s*([\w-]{2,40})\s*[—–-]\s+/;
  const m = body.match(MENTION_RE);
  const mention = m?.[1] ?? null;
  const rest = mention ? body.slice(m![0]!.length) : body;
  return (
    <div>
      {mention && (
        <span
          className={cn(
            'inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded mb-1',
            (AGENT_BUBBLE_THEME[mention] ?? AGENT_BUBBLE_THEME._default!).bg,
            (AGENT_BUBBLE_THEME[mention] ?? AGENT_BUBBLE_THEME._default!).label,
          )}
          title={t('rightSidebar.room.mention', { mention })}
        >
          @{mention}
        </span>
      )}
      <p className="text-[12px] leading-relaxed whitespace-pre-wrap break-words text-zinc-200 font-mono">
        {rest}
      </p>
    </div>
  );
}

function AgentAvatar({ agent }: { agent: string }) {
  const accent = AGENT_BUBBLE_THEME[agent] ?? AGENT_BUBBLE_THEME._default!;
  // Take the first alpha character; fallback to '?'.
  const initial = (agent.match(/[a-zA-Z]/)?.[0] ?? '?').toUpperCase();
  return (
    <span
      className={cn(
        'shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full border font-mono font-bold text-[10px]',
        accent.bg,
        accent.label,
        accent.border.split(' ')[1] ?? 'border-zinc-700/40',
      )}
      aria-hidden
    >
      {initial}
    </span>
  );
}

function formatHmS(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
}

const AGENT_BUBBLE_THEME: Record<
  string,
  { border: string; bg: string; icon: string; label: string }
> = {
  developer: {
    border: 'border-l-amber-500 border-amber-800/40',
    bg: 'bg-amber-950/15',
    icon: 'text-amber-400',
    label: 'text-amber-200',
  },
  'ui-dev': {
    border: 'border-l-violet-500 border-violet-800/40',
    bg: 'bg-violet-950/15',
    icon: 'text-violet-400',
    label: 'text-violet-200',
  },
  security: {
    border: 'border-l-rose-500 border-rose-800/40',
    bg: 'bg-rose-950/15',
    icon: 'text-rose-400',
    label: 'text-rose-200',
  },
  _default: {
    border: 'border-l-zinc-500 border-zinc-700/40',
    bg: 'bg-bg-elevated',
    icon: 'text-zinc-400',
    label: 'text-zinc-200',
  },
};

/* ───────────────── Stack manifest ───────────────── */

function StackPanel({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<StackItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingState, setSavingState] = useState<'idle' | 'saving' | 'saved'>(
    'idle',
  );
  // Accordion: one open category at a time. Click the same head to
  // collapse; click another head and we swap. Default-open is the
  // first non-empty category so the panel doesn't look like a wall
  // of closed rows.
  const [openCategory, setOpenCategory] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getStack(sessionId)
      .then((s) => {
        if (cancelled) return;
        if (s.items.length === 0) setItems(seedStackItems());
        else setItems(s.items);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Pick the first category with at least one filled row as the
  // default-open accordion head — otherwise the seed shape opens with
  // every row blank, which looks unhelpful.
  useEffect(() => {
    if (!items || openCategory !== null) return;
    const filled = items.find((it) => it.value.trim().length > 0);
    if (filled) setOpenCategory(filled.category);
    else if (items[0]) setOpenCategory(items[0].category);
  }, [items, openCategory]);

  const handleSave = useCallback(async () => {
    if (!items) return;
    setSavingState('saving');
    setError(null);
    try {
      const clean = items.filter((it) => it.value.trim().length > 0);
      const file: StackFile = {
        version: 1,
        updatedAt: new Date().toISOString(),
        items: clean,
      };
      await api.saveStack(sessionId, file);
      setSavingState('saved');
      setTimeout(() => setSavingState('idle'), 2000);
    } catch (e) {
      setError((e as Error).message);
      setSavingState('idle');
    }
  }, [items, sessionId]);

  if (error) return <div className="p-2 text-[10px] text-red-400 italic">{error}</div>;
  if (!items) return <div className="p-2 text-[10px] text-zinc-500 italic">loading…</div>;

  // Preserve the items[] declaration order for category rendering —
  // the seed list is curated (language → frontend → backend → db → …)
  // and the operator's intuition matches that flow.
  const categoryOrder: string[] = [];
  const byCategory = new Map<string, StackItem[]>();
  for (const it of items) {
    if (!byCategory.has(it.category)) {
      byCategory.set(it.category, []);
      categoryOrder.push(it.category);
    }
    byCategory.get(it.category)!.push(it);
  }

  const updateItem = (idx: number, patch: Partial<StackItem>) => {
    setItems((cur) => (cur ? cur.map((it, i) => (i === idx ? { ...it, ...patch } : it)) : cur));
  };
  const removeItem = (idx: number) => {
    setItems((cur) => (cur ? cur.filter((_, i) => i !== idx) : cur));
  };
  const addItem = (category: string) => {
    setItems((cur) =>
      cur
        ? [...cur, { category, name: '', value: '', version: '', locked: false, notes: '' }]
        : cur,
    );
  };
  const addCategory = () => {
    const name = prompt(t('rightSidebar.stack.addCategory'));
    if (!name) return;
    setItems((cur) =>
      cur
        ? [
            ...cur,
            { category: name, name: '', value: '', version: '', locked: false, notes: '' },
          ]
        : cur,
    );
    setOpenCategory(name);
  };

  return (
    <div className="p-2 pb-3">
      <div className="flex items-center gap-2 px-2 py-1.5 mb-2 border-b border-border/60">
        <span className="flex-1 text-[10px] uppercase tracking-widest text-zinc-400 font-mono font-semibold">
          {t('rightSidebar.stack.header')}
        </span>
        <button
          type="button"
          onClick={() => setSummaryOpen(true)}
          className="text-[10px] font-mono px-2 py-0.5 rounded border border-border bg-bg-elevated/40 text-zinc-300 hover:bg-bg-elevated/70"
          title={t('rightSidebar.stack.summary.subtitle')}
        >
          {t('rightSidebar.stack.summaryButton')}
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={savingState === 'saving'}
          className={cn(
            'text-[10px] font-mono px-2 py-0.5 rounded border',
            savingState === 'saved'
              ? 'border-emerald-700 bg-emerald-950/30 text-emerald-300'
              : 'border-cyan-800 bg-cyan-900/40 text-cyan-200 hover:bg-cyan-900/60',
          )}
        >
          {savingState === 'saving' ? t('rightSidebar.stack.save.saving') : savingState === 'saved' ? t('rightSidebar.stack.save.saved') : t('rightSidebar.stack.save.idle')}
        </button>
      </div>
      <ul className="space-y-1">
        {categoryOrder.map((category) => {
          const rows = byCategory.get(category) ?? [];
          return (
            <CategorySection
              key={category}
              category={category}
              rows={rows}
              allItems={items}
              isOpen={openCategory === category}
              onToggle={() =>
                setOpenCategory((cur) => (cur === category ? null : category))
              }
              onUpdate={updateItem}
              onRemove={removeItem}
              onAdd={() => addItem(category)}
            />
          );
        })}
      </ul>
      <button
        type="button"
        onClick={addCategory}
        className="w-full mt-2 px-2 py-1 text-[10px] font-mono text-zinc-400 border border-dashed border-border hover:border-zinc-500 hover:text-zinc-200 rounded"
      >
        {t('rightSidebar.stack.addCategory')}
      </button>
      {summaryOpen && (
        <StackSummaryModal items={items} onClose={() => setSummaryOpen(false)} />
      )}
    </div>
  );
}

function CategorySection({
  category,
  rows,
  allItems,
  isOpen,
  onToggle,
  onUpdate,
  onRemove,
  onAdd,
}: {
  category: string;
  rows: StackItem[];
  allItems: StackItem[];
  /** Controlled by the parent so accordion behaviour stays consistent. */
  isOpen: boolean;
  onToggle: () => void;
  onUpdate: (absoluteIdx: number, patch: Partial<StackItem>) => void;
  onRemove: (absoluteIdx: number) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  // Build a single-line category summary for the head — what's
  // actually filled in, e.g. "Next.js, shadcn, Tailwind". Lets the
  // operator scan all categories without expanding.
  const filledValues = rows
    .filter((r) => r.value.trim().length > 0)
    .map((r) => r.value.trim());
  const summaryStr = filledValues.length > 0 ? filledValues.join(', ') : '—';
  const lockedCount = rows.filter((r) => r.locked).length;
  return (
    <li className="rounded border border-border/60 bg-bg-elevated/30 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-bg-elevated/60 text-left"
      >
        {isOpen ? (
          <ChevronDown size={11} className="shrink-0 text-zinc-400" />
        ) : (
          <ChevronRight size={11} className="shrink-0 text-zinc-400" />
        )}
        <span className="shrink-0 text-[10px] font-mono uppercase tracking-wide font-semibold text-zinc-200">
          {category}
        </span>
        {!isOpen && (
          <span className="flex-1 min-w-0 text-[11px] font-mono text-zinc-400 truncate">
            {summaryStr}
          </span>
        )}
        {isOpen && <span className="flex-1" />}
        {lockedCount > 0 && (
          <span
            className="shrink-0 text-[9px] font-mono text-amber-400"
            title={t('rightSidebar.stack.lockedItems', { count: lockedCount })}
          >
            🔒 {lockedCount}
          </span>
        )}
        <span className="shrink-0 text-[10px] tabular-nums text-zinc-500">
          {rows.length}
        </span>
      </button>
      {isOpen && (
        <div className="px-1.5 pb-1.5 pt-1 space-y-1 border-t border-border/40">
          {rows.map((row) => {
            const idx = allItems.findIndex(
              (it) =>
                it.category === row.category &&
                it.name === row.name &&
                it.value === row.value &&
                it.version === row.version,
            );
            return (
              <StackItemRow
                key={`${category}-${idx}`}
                item={row}
                onUpdate={(patch) => onUpdate(idx, patch)}
                onRemove={() => onRemove(idx)}
              />
            );
          })}
          <button
            type="button"
            onClick={onAdd}
            className="w-full flex items-center justify-center gap-1 px-2 py-0.5 text-[10px] font-mono text-zinc-500 hover:text-zinc-200 rounded"
          >
            <Plus size={10} /> {t('rightSidebar.stack.addItem')}
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * Plain-language summary of the manifest — generated client-side from
 * the items array. Useful for a quick "what's the stack again?" peek
 * the operator can copy into a doc/PR description without scrolling
 * through the form.
 */
function StackSummaryModal({
  items,
  onClose,
}: {
  items: StackItem[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const summary = useMemo(() => buildStackSummary(items), [items]);
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* silent */
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-bg border border-border-strong rounded-lg w-[min(640px,100%)] max-h-[85vh] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 px-5 py-4 border-b border-border-strong">
          <div className="flex-1">
            <h3 className="text-[14px] font-mono text-zinc-100">{t('rightSidebar.stack.summary.title')}</h3>
            <p className="text-[10px] font-mono text-zinc-500 mt-0.5">
              {t('rightSidebar.stack.summary.subtitle')}
            </p>
          </div>
          <button
            type="button"
            onClick={handleCopy}
            className={cn(
              'text-[11px] font-mono px-3 py-1.5 rounded border',
              copied
                ? 'border-emerald-700 bg-emerald-950/40 text-emerald-300'
                : 'border-border bg-bg-elevated/40 text-zinc-300 hover:bg-bg-elevated/70',
            )}
            title={t('rightSidebar.stack.summary.copy.title')}
          >
            {copied ? t('rightSidebar.stack.summary.copy.copied') : t('rightSidebar.stack.summary.copy.idle')}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-100 w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated"
            aria-label={t('common.close')}
          >
            ✕
          </button>
        </header>
        <div className="flex-1 overflow-y-auto scrollbar-thin px-5 py-4">
          {items.every((it) => it.value.trim().length === 0) ? (
            <p className="text-[12px] font-mono italic text-zinc-500">
              {t('rightSidebar.stack.summary.empty')}
            </p>
          ) : (
            <pre className="text-[12px] leading-relaxed font-mono text-zinc-200 whitespace-pre-wrap break-words">
              {summary}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Build a human-readable summary string from the manifest. Groups by
 * category in the order the items appear, lists `name: value (version,
 * locked)` triples, and prepends a one-line elevator pitch when at
 * least one of the canonical anchors (`language`, `frontend.framework`,
 * `backend.runtime`) is filled.
 */
function buildStackSummary(items: StackItem[]): string {
  const filled = items.filter((it) => it.value.trim().length > 0);
  if (filled.length === 0) return '';
  const byCategory = new Map<string, StackItem[]>();
  const categoryOrder: string[] = [];
  for (const it of filled) {
    if (!byCategory.has(it.category)) {
      byCategory.set(it.category, []);
      categoryOrder.push(it.category);
    }
    byCategory.get(it.category)!.push(it);
  }

  const lines: string[] = [];

  // Elevator-pitch line — picks the most likely anchors so the first
  // sentence reads like a 1-line stack description.
  const anchors: string[] = [];
  const lang = filled.find((it) => it.category === 'language');
  if (lang) anchors.push(lang.value);
  const frontend = filled.find(
    (it) => it.category === 'frontend' && it.name === 'framework',
  );
  if (frontend) anchors.push(`${frontend.value} frontend`);
  const backend = filled.find(
    (it) => it.category === 'backend' && (it.name === 'runtime' || it.name === 'framework'),
  );
  if (backend) anchors.push(`${backend.value} backend`);
  const db = filled.find((it) => it.category === 'database');
  if (db) anchors.push(`${db.value}`);
  if (anchors.length > 0) {
    lines.push(`Stack: ${anchors.join(' · ')}.`);
    lines.push('');
  }

  for (const category of categoryOrder) {
    const rows = byCategory.get(category) ?? [];
    const parts = rows.map((r) => {
      const head = r.name ? `${r.name}: ${r.value}` : r.value;
      const meta: string[] = [];
      if (r.version) meta.push(r.version);
      if (r.locked) meta.push('locked');
      return meta.length > 0 ? `${head} (${meta.join(', ')})` : head;
    });
    lines.push(`• ${category}: ${parts.join('; ')}`);
    const notes = rows.filter((r) => r.notes.trim().length > 0);
    for (const n of notes) {
      lines.push(`    note (${n.name || n.value}): ${n.notes.trim()}`);
    }
  }

  return lines.join('\n');
}

function StackItemRow({
  item,
  onUpdate,
  onRemove,
}: {
  item: StackItem;
  onUpdate: (patch: Partial<StackItem>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'rounded border bg-bg-subtle/60 px-1.5 py-1 space-y-1',
        item.locked ? 'border-amber-800/60' : 'border-border/40',
      )}
    >
      <div className="flex items-center gap-1">
        <input
          type="text"
          value={item.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          placeholder={t('rightSidebar.stack.dimension.placeholder')}
          className="flex-1 min-w-0 bg-transparent border-b border-border/40 text-[11px] font-mono text-zinc-300 px-1 py-0.5 placeholder-zinc-600 focus:outline-none focus:border-cyan-600"
        />
        <button
          onClick={() => onUpdate({ locked: !item.locked })}
          className={cn(
            'p-0.5 rounded',
            item.locked
              ? 'text-amber-300 hover:text-amber-100'
              : 'text-zinc-500 hover:text-zinc-200',
          )}
          title={item.locked ? t('rightSidebar.stack.unlock.title') : t('rightSidebar.stack.lock.title')}
        >
          {item.locked ? <Lock size={10} /> : <Unlock size={10} />}
        </button>
        <button
          onClick={onRemove}
          className="p-0.5 rounded text-zinc-500 hover:text-red-400"
          title={t('rightSidebar.stack.remove.title')}
        >
          <Trash2 size={10} />
        </button>
      </div>
      <div className="flex items-center gap-1">
        <input
          type="text"
          value={item.value}
          onChange={(e) => onUpdate({ value: e.target.value })}
          placeholder={t('rightSidebar.stack.value.placeholder')}
          className="flex-1 min-w-0 bg-bg-subtle border border-border/40 rounded text-[12px] font-mono text-zinc-100 px-1.5 py-0.5 placeholder-zinc-600 focus:outline-none focus:border-cyan-600"
        />
        <input
          type="text"
          value={item.version}
          onChange={(e) => onUpdate({ version: e.target.value })}
          placeholder={t('rightSidebar.stack.version.placeholder')}
          className="w-20 shrink-0 bg-bg-subtle border border-border/40 rounded text-[11px] font-mono text-zinc-300 px-1.5 py-0.5 placeholder-zinc-600 focus:outline-none focus:border-cyan-600"
        />
      </div>
      <input
        type="text"
        value={item.notes}
        onChange={(e) => onUpdate({ notes: e.target.value })}
        placeholder={t('rightSidebar.stack.notes.placeholder')}
        className="w-full bg-transparent text-[10px] font-mono text-zinc-500 italic px-1 py-0.5 placeholder-zinc-700 focus:outline-none focus:text-zinc-300"
      />
    </div>
  );
}

function seedStackItems(): StackItem[] {
  const blank = (category: string, name: string): StackItem => ({
    category,
    name,
    value: '',
    version: '',
    locked: false,
    notes: '',
  });
  return [
    blank('language', 'primary'),
    blank('frontend', 'framework'),
    blank('frontend', 'ui-lib'),
    blank('frontend', 'styling'),
    blank('backend', 'runtime'),
    blank('backend', 'framework'),
    blank('database', 'primary'),
    blank('auth', 'provider'),
    blank('hosting', 'platform'),
    blank('ci', 'platform'),
    blank('testing', 'framework'),
  ];
}

/* ───────────────── Shared helpers ───────────────── */

function SubHeader({
  label,
  color,
  icon,
}: {
  label: string;
  color: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className={cn('flex items-center gap-1.5 mb-1', color)}>
      {icon}
      <span className="text-[10px] font-mono uppercase tracking-wide font-semibold">
        {label}
      </span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="p-3 text-[11px] text-zinc-500 italic">{children}</p>;
}

/* ───────────────── Scripts panel (Bash macros) ───────────────── */

/**
 * Scripts panel — surfaces the Bash macro proposals the supervisor
 * has submitted via `propose_script`. Three groups:
 *
 *   - **Pending** (top, amber accent): sup's open proposals waiting
 *     for operator review. Click to open the review modal with the
 *     full body + reason, then approve or reject.
 *   - **Approved** (emerald): scripts that already live in
 *     `<cwd>/.selfclaude/scripts/<slug>.sh` and sup can call.
 *   - **Rejected** (rose): historical record of what was turned down,
 *     so re-proposed slugs surface as a re-attempt rather than fresh.
 *
 * Hydrates lazily on tab open + via SSE `scripts-updated` events.
 */
function ScriptsPanel({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const file = useSessionStore((s) => s.sessions[sessionId]?.scripts ?? null);
  const setScripts = useSessionStore((s) => s.setScripts);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getSessionScripts(sessionId)
      .then((r) => {
        if (!cancelled) setScripts(sessionId, r);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
  }, [sessionId, setScripts]);

  if (error) return <div className="p-3 text-[11px] text-red-400 italic">{error}</div>;
  if (!file) return <div className="p-3 text-[11px] text-zinc-500 italic">loading…</div>;

  const pending = file.scripts.filter((s) => s.status === 'pending');
  const approved = file.scripts.filter((s) => s.status === 'approved');
  const rejected = file.scripts.filter((s) => s.status === 'rejected');

  if (file.scripts.length === 0) {
    return (
      <div className="p-3 text-[11px] text-zinc-500 italic leading-relaxed space-y-2">
        <p className="font-mono not-italic text-zinc-400">{t('rightSidebar.scripts.empty')}</p>
        <p>
          {t('rightSidebar.scripts.emptyBody')}
        </p>
      </div>
    );
  }

  const selectedProposal = selected
    ? file.scripts.find((s) => s.slug === selected) ?? null
    : null;

  return (
    <div className="p-2 space-y-3">
      {pending.length > 0 && (
        <ScriptsGroup
          title={t('rightSidebar.scripts.group.pendingReview')}
          accent="text-amber-300"
          empty={null}
        >
          {pending.map((p) => (
            <ScriptRow key={p.slug} proposal={p} onClick={() => setSelected(p.slug)} />
          ))}
        </ScriptsGroup>
      )}
      {approved.length > 0 && (
        <ScriptsGroup title={t('rightSidebar.scripts.group.approved')} accent="text-emerald-300" empty={null}>
          {approved.map((p) => (
            <ScriptRow key={p.slug} proposal={p} onClick={() => setSelected(p.slug)} />
          ))}
        </ScriptsGroup>
      )}
      {rejected.length > 0 && (
        <ScriptsGroup title={t('rightSidebar.scripts.group.rejected')} accent="text-rose-300" empty={null}>
          {rejected.map((p) => (
            <ScriptRow key={p.slug} proposal={p} onClick={() => setSelected(p.slug)} />
          ))}
        </ScriptsGroup>
      )}
      {selectedProposal && (
        <ScriptDetailModal
          sessionId={sessionId}
          proposal={selectedProposal}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function ScriptsGroup({
  title,
  accent,
  empty,
  children,
}: {
  title: string;
  accent: string;
  empty: string | null;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3
        className={cn(
          'text-[10px] font-mono uppercase tracking-widest font-semibold mb-1.5',
          accent,
        )}
      >
        {title}
      </h3>
      {empty ? (
        <p className="text-[11px] text-zinc-500 italic px-1">{empty}</p>
      ) : (
        <ul className="space-y-1">{children}</ul>
      )}
    </section>
  );
}

function ScriptRow({
  proposal,
  onClick,
}: {
  proposal: import('@/lib/types').ScriptProposal;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const accent =
    proposal.status === 'pending'
      ? 'border-l-amber-500 hover:bg-amber-950/15'
      : proposal.status === 'approved'
        ? 'border-l-emerald-600 hover:bg-emerald-950/10'
        : 'border-l-rose-500 hover:bg-rose-950/10';
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'group w-full text-left rounded border-l-2 border-r border-y border-border/40 bg-bg-elevated/30 px-2.5 py-2 transition-colors',
          accent,
        )}
      >
        <div className="flex items-center gap-2 mb-0.5">
          <TerminalSquare size={11} className="shrink-0 text-zinc-500" />
          <code className="flex-1 text-[12px] font-mono font-semibold text-zinc-100 truncate">
            {proposal.slug}
          </code>
          <span className="shrink-0 text-[9px] uppercase tracking-wide font-mono text-zinc-500">
            {t('rightSidebar.scripts.proposedBy', { proposedBy: proposal.proposedBy })}
          </span>
        </div>
        <p className="text-[11px] leading-relaxed font-mono text-zinc-400 line-clamp-2 break-words">
          {proposal.reason}
        </p>
      </button>
    </li>
  );
}

function ScriptDetailModal({
  sessionId,
  proposal,
  onClose,
}: {
  sessionId: string;
  proposal: import('@/lib/types').ScriptProposal;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [mode, setMode] = useState<'view' | 'reject-form'>('view');

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const isPending = proposal.status === 'pending';

  const handleApprove = async () => {
    setPending('approve');
    setError(null);
    try {
      await api.approveScript(sessionId, proposal.slug, reviewNotes.trim() || undefined);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setPending(null);
    }
  };

  const handleReject = async () => {
    if (rejectReason.trim().length === 0) {
      setError(t('rightSidebar.scripts.modal.rejectError'));
      return;
    }
    setPending('reject');
    setError(null);
    try {
      await api.rejectScript(sessionId, proposal.slug, rejectReason.trim());
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setPending(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="bg-bg border border-border-strong rounded-lg w-[min(720px,100%)] max-h-[85vh] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-border-strong flex items-start gap-3">
          <TerminalSquare size={16} className="text-zinc-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <code className="text-[14px] font-mono font-semibold text-zinc-100">
                {proposal.slug}.sh
              </code>
              <span
                className={cn(
                  'text-[9px] uppercase tracking-widest font-mono px-1.5 py-0.5 rounded border',
                  proposal.status === 'pending'
                    ? 'bg-amber-950/40 text-amber-300 border-amber-700/40'
                    : proposal.status === 'approved'
                      ? 'bg-emerald-950/40 text-emerald-300 border-emerald-700/40'
                      : 'bg-rose-950/40 text-rose-300 border-rose-700/40',
                )}
              >
                {proposal.status}
              </span>
            </div>
            <p className="text-[10px] font-mono text-zinc-500 mt-1">
              {t('rightSidebar.scripts.modal.proposedBy', { proposer: proposal.proposedBy, date: new Date(proposal.proposedAt).toLocaleString() })}
              {proposal.reviewedBy && (
                <>
                  {' · '}{t('rightSidebar.scripts.modal.reviewedBy', { reviewer: proposal.reviewedBy })}
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-100 w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated"
            aria-label={t('common.close')}
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto scrollbar-thin px-5 py-4 space-y-4">
          <section>
            <h4 className="text-[10px] uppercase tracking-widest font-mono text-zinc-500 mb-1.5">
              {t('rightSidebar.scripts.modal.section.reason')}
            </h4>
            <p className="text-[12px] leading-relaxed font-mono text-zinc-200 whitespace-pre-wrap break-words">
              {proposal.reason}
            </p>
          </section>
          <section>
            <h4 className="text-[10px] uppercase tracking-widest font-mono text-zinc-500 mb-1.5">
              {t('rightSidebar.scripts.modal.section.body')}
            </h4>
            <pre className="text-[11px] leading-relaxed font-mono text-zinc-100 whitespace-pre-wrap break-words bg-bg-subtle border border-border rounded p-3 overflow-x-auto">
{proposal.body}
            </pre>
          </section>
          {proposal.reviewerNotes && (
            <section>
              <h4 className="text-[10px] uppercase tracking-widest font-mono text-zinc-500 mb-1.5">
                {proposal.status === 'approved'
                  ? t('rightSidebar.scripts.modal.section.approvalNotes')
                  : t('rightSidebar.scripts.modal.section.rejectionReason')}
              </h4>
              <pre
                className={cn(
                  'text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-words rounded p-3 border',
                  proposal.status === 'approved'
                    ? 'bg-emerald-950/15 border-emerald-700/30 text-emerald-100'
                    : 'bg-rose-950/15 border-rose-700/30 text-rose-100',
                )}
              >
                {proposal.reviewerNotes}
              </pre>
            </section>
          )}
        </div>

        {/* Footer — review actions only when pending */}
        {isPending && (
          <footer className="px-5 py-3 border-t border-border-strong bg-bg-subtle/30 space-y-2">
            {error && <p className="text-[11px] font-mono text-red-400">{error}</p>}
            {mode === 'view' ? (
              <>
                <input
                  type="text"
                  value={reviewNotes}
                  onChange={(e) => setReviewNotes(e.target.value)}
                  placeholder={t('rightSidebar.scripts.modal.approvalNote.placeholder')}
                  className="w-full bg-bg-subtle border border-border rounded-md px-3 py-1.5 text-[12px] font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-cyan-600"
                />
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setMode('reject-form')}
                    disabled={pending !== null}
                    className="text-[11px] font-mono px-3 py-1.5 rounded border border-rose-800/50 bg-rose-950/30 text-rose-200 hover:bg-rose-950/60 disabled:opacity-50"
                  >
                    {t('rightSidebar.scripts.modal.reject')}
                  </button>
                  <button
                    type="button"
                    onClick={handleApprove}
                    disabled={pending !== null}
                    className="text-[11px] font-mono px-3 py-1.5 rounded border border-emerald-700 bg-emerald-700/40 text-emerald-100 hover:bg-emerald-700/60 disabled:opacity-50"
                  >
                    {pending === 'approve' ? t('rightSidebar.scripts.modal.approve.pending') : t('rightSidebar.scripts.modal.approve.idle')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder={t('rightSidebar.scripts.modal.rejectReason.placeholder')}
                  rows={3}
                  className="w-full bg-bg-subtle border border-rose-700/40 rounded-md px-3 py-2 text-[12px] font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-rose-500 resize-none leading-relaxed"
                />
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setMode('view')}
                    disabled={pending !== null}
                    className="text-[11px] font-mono text-zinc-400 hover:text-zinc-200 px-2"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={handleReject}
                    disabled={pending !== null || rejectReason.trim().length === 0}
                    className="text-[11px] font-mono px-3 py-1.5 rounded border border-rose-700 bg-rose-700/40 text-rose-100 hover:bg-rose-700/60 disabled:opacity-50"
                  >
                    {pending === 'reject' ? t('rightSidebar.scripts.modal.confirmReject.pending') : t('rightSidebar.scripts.modal.confirmReject.idle')}
                  </button>
                </div>
              </>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}
