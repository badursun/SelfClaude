import type {
  BrowseResult,
  ChatLogEntry,
  Favorite,
  PhaseTrackerFile,
  RecentEntry,
  ScriptsFile,
  SessionMeta,
  SessionSnapshot,
} from './types';

export interface ProjectTreeFile {
  path: string;
  name: string;
  size: number;
}

export interface ProjectTreeGroup {
  group: 'project' | 'selfclaude' | 'root';
  label: string;
  files: ProjectTreeFile[];
}

export interface ProjectTree {
  cwd: string;
  groups: ProjectTreeGroup[];
}

export interface ProjectFile {
  path: string;
  size: number;
  content: string;
}

export interface StackItem {
  category: string;
  name: string;
  value: string;
  version: string;
  locked: boolean;
  notes: string;
}

export interface StackFile {
  version: 1;
  updatedAt: string;
  items: StackItem[];
}

export interface PhaseProgress {
  filename: string;
  title: string;
  /** Total number of `- [ ]` / `- [x]` checkboxes in the phase doc. */
  totalItems: number;
  /** Number of those that are checked off. */
  completedItems: number;
  /** Outline tree built from headings + checkboxes (no plain prose). */
  tree: PhaseNode[];
}

/* Phase tracker types live in `./types.ts` so SessionEvent can reference
 * them without an import cycle. Re-exported here for consumer ergonomics. */
export type {
  ConfirmEvidence,
  PhaseItem,
  PhaseItemStatus,
  PhaseTrackerFile,
  PhaseTrackerPhase,
} from './types';

/** One row in the unified memory overview. Mirrors the server shape. */
export interface MemoryOverviewEntry {
  /** Layer this entry belongs to; routes click → read/write API. */
  kind: 'project' | 'shared' | 'auto' | 'user-global';
  /** Display name (basename for project/shared/auto, full path for user-global). */
  name: string;
  /** Identifier used for read/write — relative path for project/shared, bare name for auto, absolute path for user-global. */
  ref: string;
  size: number;
  /** First ~200 chars of content (or first paragraph) for at-a-glance UI. */
  preview: string;
  editable: boolean;
}

/**
 * One node in a phase-doc outline. Either a heading (`section`) which
 * groups children, or a checkbox (`checkbox`) which is a leaf with a
 * done flag. Plain bullets and prose are dropped on the server side so
 * the tree stays an actionable outline, not a re-render.
 */
export interface PhaseNode {
  kind: 'section' | 'checkbox';
  text: string;
  /** For sections: 2 (`##`), 3 (`###`), 4 (`####`)… */
  level?: number;
  /** For checkboxes only. */
  done?: boolean;
  /** Source line index in the markdown for traceability. */
  line: number;
  children: PhaseNode[];
}

/**
 * One row in the Settings modal's prompt-editor list. `currentContent`
 * is what the agent actually loads at runtime; `defaultContent` is the
 * bundled shipped version used as the diff baseline / "reset to default"
 * target.
 */
export interface SystemPromptInfo {
  agent: string;
  label: string;
  accent: string;
  readOnly: boolean;
  description: string;
  source: 'override' | 'default';
  defaultContent: string;
  currentContent: string;
}

/**
 * Server-aggregated view of a session's full chat-log: todos from the
 * latest TodoWrite, every file touched, every wakeup ever scheduled,
 * every cron job. Powers the right-hand detail tabs without needing the
 * full chat-log loaded client-side.
 */
export interface DerivedState {
  todos:
    | Array<{
        content: string;
        status: 'pending' | 'in_progress' | 'completed';
        activeForm?: string;
      }>
    | null;
  files: {
    created: { path: string; ts: number }[];
    modified: { path: string; ts: number }[];
    read: { path: string; ts: number }[];
  };
  wakeups: Array<{
    id: string;
    role: 'supervisor' | 'developer';
    scheduledAt: number;
    fireAt: number;
    reason: string;
    status: 'pending' | 'fired' | 'cancelled';
  }>;
  crons: Array<{
    id: string;
    scheduledAt: number;
    schedule: string;
    description: string;
    cronId: string | null;
    status: 'active' | 'deleted';
  }>;
  /** Specialist agents currently summoned for this session (always includes 'developer'). */
  activeAgents: string[];
}

// Direct connection to the SelfClaude Web API. Bypassing the Next.js dev
// rewrite avoids dev-time SSE buffering that breaks token streaming.
export const API_BASE =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_BASE) ||
  'http://127.0.0.1:7423';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  // Only set Content-Type when there's actually a body. Fastify rejects
  // bodyless requests that claim `application/json` because parsing the
  // empty string as JSON throws — manifests as a 400 with no handler
  // ever running. DELETE in particular hit this since it sends no body.
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> ?? {}) };
  if (init?.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${API_BASE}${url}`, {
    ...init,
    headers,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${message}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  health() {
    return jsonFetch<{ version: string; uptime: number; sessions: number }>('/api/health');
  },
  listSessions() {
    return jsonFetch<{ sessions: SessionMeta[] }>('/api/sessions');
  },
  createSession(cwd: string, label?: string) {
    return jsonFetch<SessionMeta>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ cwd, label }),
    });
  },
  destroySession(id: string) {
    return jsonFetch<void>(`/api/sessions/${id}`, { method: 'DELETE' });
  },
  getSession(id: string, opts: { limit?: number } = {}) {
    const q = opts.limit ? `?limit=${opts.limit}` : '';
    return jsonFetch<SessionSnapshot>(`/api/sessions/${id}${q}`);
  },
  getHistory(id: string, before: number, limit = 50) {
    return jsonFetch<{ entries: ChatLogEntry[]; hasMoreHistory: boolean }>(
      `/api/sessions/${id}/history?before=${before}&limit=${limit}`,
    );
  },
  sendMessage(id: string, text: string) {
    return jsonFetch<{ accepted: boolean }>(`/api/sessions/${id}/message`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  },
  sendDevMessage(id: string, text: string) {
    return jsonFetch<{ accepted: boolean }>(`/api/sessions/${id}/dev-message`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  },
  sendAgentMessage(id: string, agent: string, text: string) {
    return jsonFetch<{ accepted: boolean }>(`/api/sessions/${id}/agent-message`, {
      method: 'POST',
      body: JSON.stringify({ agent, text }),
    });
  },
  answerQuestion(id: string, questionId: string, answer: string) {
    return jsonFetch<{ ok: boolean }>(`/api/sessions/${id}/answer-question`, {
      method: 'POST',
      body: JSON.stringify({ questionId, answer }),
    });
  },
  listProjectFiles(id: string) {
    return jsonFetch<ProjectTree>(`/api/sessions/${id}/files`);
  },
  listFilesTouched(id: string) {
    return jsonFetch<{
      created: { path: string; ts: number }[];
      modified: { path: string; ts: number }[];
      read: { path: string; ts: number }[];
    }>(`/api/sessions/${id}/files-touched`);
  },
  getDerivedState(id: string) {
    return jsonFetch<DerivedState>(`/api/sessions/${id}/derived`);
  },
  readProjectFile(id: string, path: string) {
    return jsonFetch<ProjectFile>(`/api/sessions/${id}/file?path=${encodeURIComponent(path)}`);
  },
  writeProjectFile(id: string, path: string, content: string) {
    return jsonFetch<{ ok: true; path: string; size: number }>(
      `/api/sessions/${id}/file`,
      {
        method: 'PUT',
        body: JSON.stringify({ path, content }),
      },
    );
  },
  getPhaseProgress(id: string) {
    return jsonFetch<{ phases: PhaseProgress[] }>(`/api/sessions/${id}/phases`);
  },
  getPhaseTracker(id: string) {
    return jsonFetch<PhaseTrackerFile>(`/api/sessions/${id}/phase-tracker`);
  },
  /* Bash macro / script proposal endpoints. */
  getSessionScripts(id: string) {
    return jsonFetch<ScriptsFile>(`/api/sessions/${id}/scripts`);
  },
  approveScript(id: string, slug: string, notes?: string, operator = 'operator') {
    return jsonFetch<{ ok: true; message: string }>(
      `/api/sessions/${id}/scripts/approve`,
      { method: 'POST', body: JSON.stringify({ slug, operator, notes }) },
    );
  },
  rejectScript(id: string, slug: string, reason: string, operator = 'operator') {
    return jsonFetch<{ ok: true; message: string }>(
      `/api/sessions/${id}/scripts/reject`,
      { method: 'POST', body: JSON.stringify({ slug, operator, reason }) },
    );
  },
  /**
   * Per-project MCP tool telemetry — usage counts + recent calls per
   * tool, used by the Settings "MCP Tools" tab.
   */
  getMcpTelemetry(id: string) {
    return jsonFetch<{
      version: 1;
      updatedAt: string;
      tools: Record<
        string,
        {
          name: string;
          total: number;
          success: number;
          failure: number;
          lastCalledAt: string | null;
          lastFailedAt: string | null;
          recent: {
            ts: number;
            agent: string;
            success: boolean;
            message: string;
          }[];
        }
      >;
    }>(`/api/sessions/${id}/mcp-telemetry`);
  },
  /**
   * Aggregated overview of every memory layer for this session — used
   * by the Memory panel to render previews in a single roundtrip.
   * See `web-api.ts:readMemoryOverview`.
   */
  getMemoryOverview(id: string) {
    return jsonFetch<{
      project: MemoryOverviewEntry[];
      shared: MemoryOverviewEntry[];
      auto: MemoryOverviewEntry[];
      userGlobal: MemoryOverviewEntry[];
      encodedCwd: string;
    }>(`/api/sessions/${id}/memory-overview`);
  },
  /**
   * CC's per-cwd auto-memory bucket (`~/.claude/projects/<encoded>/memory/`)
   * plus user-global `~/.claude/CLAUDE.md`. The supervisor sometimes
   * writes directly here when the user says "add to memory"; the
   * project tree wouldn't surface it because it's outside cwd.
   */
  getAutoMemory(id: string) {
    return jsonFetch<{
      encodedCwd: string;
      dir: string;
      entries: { name: string; size: number; preview: string }[];
      userClaudeMd: { path: string; size: number; preview: string } | null;
    }>(`/api/sessions/${id}/auto-memory`);
  },
  getAutoMemoryFile(id: string, name: string) {
    return jsonFetch<{ name: string; size: number; content: string }>(
      `/api/sessions/${id}/auto-memory/file/${encodeURIComponent(name)}`,
    );
  },
  putAutoMemoryFile(id: string, name: string, content: string) {
    return jsonFetch<{ ok: true; name: string; size: number }>(
      `/api/sessions/${id}/auto-memory/file/${encodeURIComponent(name)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ content }),
      },
    );
  },
  operatorVerifyPhaseItem(
    id: string,
    slug: string,
    itemId: string,
    notes?: string,
  ) {
    return jsonFetch<{ ok: true; message: string }>(
      `/api/sessions/${id}/phase-tracker/operator-verify`,
      {
        method: 'POST',
        body: JSON.stringify({ slug, itemId, notes }),
      },
    );
  },
  getStack(id: string) {
    return jsonFetch<StackFile>(`/api/sessions/${id}/stack`);
  },
  saveStack(id: string, stack: StackFile) {
    return jsonFetch<{ ok: true }>(`/api/sessions/${id}/stack`, {
      method: 'PUT',
      body: JSON.stringify(stack),
    });
  },
  listSystemPrompts() {
    return jsonFetch<{ prompts: SystemPromptInfo[] }>('/api/system-prompts');
  },
  saveSystemPrompt(agent: string, content: string) {
    return jsonFetch<{ ok: true; path: string; size: number }>(
      `/api/system-prompts/${encodeURIComponent(agent)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ content }),
      },
    );
  },
  resetSystemPrompt(agent: string) {
    return jsonFetch<{ ok: true }>(
      `/api/system-prompts/${encodeURIComponent(agent)}`,
      { method: 'DELETE' },
    );
  },
  triggerWakeup(id: string, role: 'supervisor' | 'developer') {
    return jsonFetch<{ fired: boolean }>(`/api/sessions/${id}/wake`, {
      method: 'POST',
      body: JSON.stringify({ role }),
    });
  },
  abortTurn(id: string, role: 'supervisor' | 'developer') {
    return jsonFetch<{ aborted: boolean; role: 'supervisor' | 'developer' | null }>(
      `/api/sessions/${id}/abort`,
      {
        method: 'POST',
        body: JSON.stringify({ role }),
      },
    );
  },
  decideApproval(id: string, approvalId: string, decision: 'allow' | 'deny') {
    return jsonFetch<{ ok: boolean }>(`/api/sessions/${id}/decide-approval`, {
      method: 'POST',
      body: JSON.stringify({ approvalId, decision }),
    });
  },
  browse(path?: string) {
    const q = path ? `?path=${encodeURIComponent(path)}` : '';
    return jsonFetch<BrowseResult>(`/api/browse${q}`);
  },
  /**
   * Lightweight check: does this cwd already have a SelfClaude
   * project state on disk? Used by the home page to decide whether
   * to surface the onboarding wizard (fresh project) or jump
   * straight into the session (returning project).
   */
  probeProject(cwd: string) {
    return jsonFetch<{ cwd: string; exists: boolean }>(
      `/api/projects/probe?cwd=${encodeURIComponent(cwd)}`,
    );
  },
  /**
   * Create a new directory inside `parent`. Used by the FolderPicker's
   * inline "new folder" UI so the operator can scaffold a fresh
   * project root without leaving the picker. Server validates the
   * name + refuses overwrite — surface the error to the operator.
   */
  mkdir(parent: string, name: string) {
    return jsonFetch<{ path: string; parent: string; name: string }>(
      '/api/browse/mkdir',
      {
        method: 'POST',
        body: JSON.stringify({ parent, name }),
      },
    );
  },
  listFavorites() {
    return jsonFetch<{ favorites: Favorite[] }>('/api/favorites');
  },
  addFavorite(cwd: string, label?: string) {
    return jsonFetch<Favorite>('/api/favorites', {
      method: 'POST',
      body: JSON.stringify({ cwd, label }),
    });
  },
  removeFavorite(cwd: string) {
    return jsonFetch<{ removed: boolean }>(
      `/api/favorites?cwd=${encodeURIComponent(cwd)}`,
      { method: 'DELETE' },
    );
  },
  listRecents() {
    return jsonFetch<{ recents: RecentEntry[] }>('/api/recents');
  },
  removeRecent(cwd: string) {
    return jsonFetch<{ removed: boolean }>(
      `/api/recents?cwd=${encodeURIComponent(cwd)}`,
      { method: 'DELETE' },
    );
  },
  /**
   * Phase 2 telemetry — live session rollup. Raw counters first, no
   * estimates. Frontend renders `turns / tools / files / duration` in
   * the session header strip; the project landing card may compose a
   * labelled estimate from these primitives, but the API itself only
   * serves raw numbers.
   */
  getSessionMetrics(id: string) {
    return jsonFetch<SessionMetricsRollup>(`/api/sessions/${id}/metrics`);
  },
  /**
   * Phase 2 telemetry — project rollup across every session for a
   * given cwd. Used by the home-page project card.
   */
  getProjectMetrics(cwd: string) {
    return jsonFetch<ProjectMetricsRollup>(
      `/api/projects/metrics?cwd=${encodeURIComponent(cwd)}`,
    );
  },
  /**
   * Phase 3 — kick off the quickstart demo. Server creates a fresh
   * workspace under `~/.selfclaude/demos/demo-<ts>/`, opens a session
   * against it, and returns the canned brief for the chat box. The
   * frontend navigates to the session and auto-fills the brief; the
   * operator clicks send to start the orchestration.
   */
  startDemo() {
    return jsonFetch<{ sessionId: string; cwd: string; prompt: string }>(
      '/api/demo/start',
      { method: 'POST' },
    );
  },
  /**
   * Phase 3 — open the demo artifact (typically `index.html`) in the
   * operator's default app via the OS shell. Server enforces that
   * `path` is rooted under `~/.selfclaude/demos/`.
   */
  openDemoArtifact(path: string) {
    return jsonFetch<{ ok: boolean; opened: string }>('/api/demo/open', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  },
  /**
   * Phase 3 — probe whether the demo artifact has been written yet.
   * The session header polls this so the "Open Result" button only
   * appears once there is something to open.
   */
  demoArtifactExists(path: string) {
    return jsonFetch<{ exists: boolean }>(
      `/api/demo/artifact-exists?path=${encodeURIComponent(path)}`,
    );
  },
  /**
   * Phase 5 (Trust v1) — combined repo + isolation snapshot used by
   * the status-bar widget. One round-trip per poll instead of three
   * separate calls.
   */
  getIsolationState(sessionId: string) {
    return jsonFetch<IsolationStateView>(
      `/api/sessions/${sessionId}/git/isolation-state`,
    );
  },
  /** Phase 5 — create the SC branch from current HEAD; persists state. */
  startIsolation(sessionId: string, branch: string) {
    return jsonFetch<
      | { ok: true; branch: string; originalBranch: string; startSha: string }
      | { ok: false; reason: string; message: string }
    >(`/api/sessions/${sessionId}/git/start`, {
      method: 'POST',
      body: JSON.stringify({ branch }),
    });
  },
  /** Phase 5 — squash-merge the SC branch into original; clears state. */
  acceptIsolation(
    sessionId: string,
    branch: string,
    originalBranch: string,
    message: string,
  ) {
    return jsonFetch<
      | { ok: true; mergeSha?: string }
      | { ok: false; reason: string; message: string }
    >(`/api/sessions/${sessionId}/git/accept`, {
      method: 'POST',
      body: JSON.stringify({ branch, originalBranch, message }),
    });
  },
  /** Phase 5 — drop the SC branch and restore original; clears state. */
  discardIsolation(sessionId: string, branch: string, originalBranch: string) {
    return jsonFetch<
      | { ok: true }
      | { ok: false; reason: string; message: string }
    >(`/api/sessions/${sessionId}/git/discard`, {
      method: 'POST',
      body: JSON.stringify({ branch, originalBranch }),
    });
  },
  /**
   * Operator-attached reference docs. Files live under
   * `<cwd>/.selfclaude/refs/`; the supervisor sees a manifest in its
   * system prompt every turn and reads files lazily with the Read tool.
   */
  listRefs(sessionId: string) {
    return jsonFetch<{ refs: Array<{ name: string; sizeBytes: number; mtimeMs: number }> }>(
      `/api/sessions/${sessionId}/refs`,
    );
  },
  async uploadRef(sessionId: string, file: File) {
    // Raw octet-stream — filename rides as a query param so we don't
    // pull in @fastify/multipart server-side just for one upload route.
    const url = `/api/sessions/${sessionId}/refs?name=${encodeURIComponent(file.name)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    if (!r.ok) {
      let message = `${r.status} ${r.statusText}`;
      try {
        const body = (await r.json()) as { error?: string; message?: string };
        message = body.error ?? body.message ?? message;
      } catch {
        /* non-JSON body — keep default */
      }
      throw new Error(message);
    }
    return (await r.json()) as {
      ok: true;
      meta: { name: string; sizeBytes: number; mtimeMs: number };
      renamed: boolean;
    };
  },
  removeRef(sessionId: string, name: string) {
    return jsonFetch<{ ok: true }>(
      `/api/sessions/${sessionId}/refs/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    );
  },
  refDownloadUrl(sessionId: string, name: string) {
    return `/api/sessions/${sessionId}/refs/${encodeURIComponent(name)}`;
  },
};

/* ───── Phase 5 isolation types ───── */

export interface IsolationRepoState {
  isRepo: boolean;
  currentBranch: string | null;
  headSha: string | null;
  dirty: boolean;
}

export interface IsolationPersisted {
  enabled: boolean;
  branch: string;
  originalBranch: string;
  startedAt: number;
  lastCommitAt: number | null;
}

export interface IsolationBranchStatus {
  commitCount: number;
  filesChanged: number;
  dirty: boolean;
}

export interface IsolationStateView {
  repoState: IsolationRepoState;
  isolation: IsolationPersisted | null;
  branchStatus: IsolationBranchStatus | null;
  /**
   * `null` when isolation isn't active. `true` when the branch the
   * persisted state names actually exists in git. `false` indicates
   * drift — the operator (or another process) deleted the SC branch
   * out-of-band; the UI surfaces this as a warning.
   */
  branchExistsOnDisk: boolean | null;
}

/* ───── Phase 2 telemetry types ───── */

export interface PhaseContractMetrics {
  totalAttempts: number;
  firstPassRate: number;
  ultimateFilenames: number;
  overrides: number;
  distinctFilenames: number;
}

export interface SessionMetricsRollup {
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  turns: { sup: number; dev: number };
  toolCalls: Record<string, number>;
  toolCallsByAgent: Record<string, number>;
  filesTouched: number;
  filesTouchedByTool: Record<string, number>;
  phaseContract: PhaseContractMetrics;
  /**
   * Phase 4 inbox-compressor aggregate. All numbers are *estimates*
   * from the char-based heuristic — they're informational, not
   * billing values. `compressionRatio` is `compressed / original`
   * (0–1), so 0.5 means the compressor halved the injected payload.
   */
  inboxCompression: {
    drainEvents: number;
    estimatedOriginalTokens: number;
    estimatedCompressedTokens: number;
    estimatedTokensSaved: number;
    compressionRatio: number;
  };
  /**
   * Phase 7 failure aggregate. Per ROADMAP calibration #7, the rate
   * is publicly visible — the bottom-toolbar badge surfaces `total`
   * and the tooltip breaks it down by `byCode`.
   */
  failures: {
    total: number;
    byCode: Record<string, number>;
  };
}

export interface ProjectMetricsRollup {
  totalSessions: number;
  totalTurns: { sup: number; dev: number };
  toolCalls: Record<string, number>;
  filesTouched: number;
  phaseContract: PhaseContractMetrics;
  activeDurationMs: number;
  /** Phase 7 — cumulative failure aggregate across every session. */
  failures: {
    total: number;
    byCode: Record<string, number>;
  };
}
