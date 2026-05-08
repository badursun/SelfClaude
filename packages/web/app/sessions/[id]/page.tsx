'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useTranslation } from '@/lib/i18n';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { TabBar } from '@/components/tab-bar';
import { StatusBar } from '@/components/status-bar';
import { computeSupStatus } from '@/components/agent-status';
import { SupChat } from '@/components/sup-chat';
import { AgentPane } from '@/components/agent-pane';
import { BottomToolbar } from '@/components/bottom-toolbar';
import { FileSidebar } from '@/components/file-sidebar';
import { RightRail, RightPanelContent, type RightTab } from '@/components/right-sidebar';
import { IdleToast } from '@/components/idle-toast';
import { ScriptProposalToast } from '@/components/script-proposal-toast';
import { Drawer } from '@/components/drawer';
import { ApprovalDialog } from '@/components/approval-dialog';
import { TurnErrorBanner } from '@/components/turn-error-banner';
import { StuckBanner } from '@/components/stuck-banner';
import { FilePreviewModal } from '@/components/file-preview-modal';
import { useSessionStore } from '@/lib/store';
import { subscribeSession } from '@/lib/sse';
import { api, type DerivedState } from '@/lib/api';

const PANEL_LAYOUT_KEY = 'selfclaude.panelLayout.v1';

// Whitelist for localStorage validation — defends against stale or
// hand-edited values restoring an unsupported tab key.
const RIGHT_TAB_VALUES = new Set<RightTab>([
  'tool-detail',
  'tasks',
  'schedule',
  'files-touched',
  'phases',
  'audit',
  'memory',
  'decisions',
  'room',
  'stack',
  'scripts',
]);

export default function SessionPage() {
  const { t } = useTranslation();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const searchParams = useSearchParams();
  // Phase 3 demo CTA → home page navigates with the canned brief in
  // `?firstMessage=...`. Captured ONCE on mount and only on first
  // render — we don't want the URL change to repopulate the textarea
  // after the operator has already typed something.
  const [demoInitialInput, setDemoInitialInput] = useState<string>('');
  useEffect(() => {
    const fm = searchParams.get('firstMessage');
    if (fm) {
      setDemoInitialInput(fm);
      // Strip the query so a refresh doesn't refill the input.
      const url = new URL(window.location.href);
      url.searchParams.delete('firstMessage');
      window.history.replaceState({}, '', url.toString());
    }
    // Intentionally empty deps — read-once on mount.
    // biome-ignore lint/correctness/useExhaustiveDependencies: read-once intentional
  }, []);
  const session = useSessionStore((s) => s.sessions[id]);
  const setSnapshot = useSessionStore((s) => s.setSnapshot);
  const applyEvent = useSessionStore((s) => s.applyEvent);
  const selectTool = useSessionStore((s) => s.selectTool);
  const setActive = useSessionStore((s) => s.setActive);
  const prependHistory = useSessionStore((s) => s.prependHistory);
  const setLoadingHistory = useSessionStore((s) => s.setLoadingHistory);
  const clearProposalAlert = useSessionStore((s) => s.clearProposalAlert);
  const [error, setError] = useState<string | null>(null);
  // Project-relative file path the operator clicked in a chat link.
  // BubbleMarkdown's SmartLink dispatches a `selfclaude:open-file`
  // CustomEvent for any link that points inside the project; we
  // listen here and render the existing FilePreviewModal.
  const [chatPreviewPath, setChatPreviewPath] = useState<string | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ path: string }>).detail;
      if (detail?.path) setChatPreviewPath(detail.path);
    };
    window.addEventListener('selfclaude:open-file', handler);
    return () => window.removeEventListener('selfclaude:open-file', handler);
  }, []);

  // Derived-state fetcher. Lives at page level so SupChat, AgentTimeline,
  // and the right-rail panels (Tasks, Schedule, FilesTouched) all share
  // the same source of truth — pending-wakeup info has to come from the
  // FULL chat-log, not just the lazy-loaded window, or an old wakeup
  // wouldn't pop the wakeup overlay.
  const [derived, setDerived] = useState<DerivedState | null>(null);
  const lastDerivedTs = useMemo(() => {
    if (!session) return 0;
    let max = 0;
    for (const e of session.chatLog) {
      if (
        e.type === 'dev-tool-call' ||
        e.type === 'wakeup-scheduled' ||
        e.type === 'wakeup-fired' ||
        e.type === 'wakeup-cancelled' ||
        // Multi-agent lifecycle / activity also has to bump the trigger
        // so the agent tab strip + activeAgents listing stay live.
        e.type === 'agent-summoned' ||
        e.type === 'agent-dismissed' ||
        e.type === 'agent-tool-call' ||
        e.type === 'agent-text' ||
        e.type === 'agent-thinking'
      ) {
        if (e.ts > max) max = e.ts;
      }
    }
    return max;
  }, [session?.chatLog]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api
      .getDerivedState(id)
      .then((r) => {
        if (!cancelled) setDerived(r);
      })
      .catch(() => {
        /* silent — RightSidebar panels surface errors locally */
      });
    return () => {
      cancelled = true;
    };
  }, [id, lastDerivedTs]);

  /**
   * Fetch the next older window of chat-log entries for this session.
   * No-op if we already know there's no more or if a request is in flight.
   * Both panes (sup + dev) call this when their scroll nears the top —
   * the loading flag prevents overlap.
   */
  const loadMoreHistory = useCallback(async () => {
    if (!session) return;
    if (!session.hasMoreHistory) return;
    if (session.loadingHistory) return;
    const oldest = session.chatLog[0]?.ts;
    if (!oldest) return;
    setLoadingHistory(id, true);
    try {
      const r = await api.getHistory(id, oldest, 50);
      prependHistory(id, r.entries, r.hasMoreHistory);
    } catch (e) {
      setLoadingHistory(id, false);
      console.warn('loadMoreHistory failed:', (e as Error).message);
    }
  }, [id, session, prependHistory, setLoadingHistory]);

  useEffect(() => {
    if (!id) return;
    setActive(id);
    let active = true;

    (async () => {
      try {
        // Lazy initial load: fetch only the most recent window so big
        // sessions don't drag the browser. Older entries paginate in on
        // scroll-near-top.
        const snap = await api.getSession(id, { limit: 50 });
        if (!active) return;
        setSnapshot(id, snap);
      } catch (e) {
        if (!active) return;
        setError((e as Error).message);
        return;
      }
    })();

    const sub = subscribeSession(
      id,
      (event) => applyEvent(id, event),
      () => setError(t('session.error.lostConnection')),
    );
    return () => {
      active = false;
      sub.close();
    };
  }, [id, setSnapshot, applyEvent, setActive]);

  const handleSupSubmit = async (text: string) => {
    if (!session) return;
    try {
      if (session.pendingQuestion) {
        await api.answerQuestion(id, session.pendingQuestion.id, text);
        return;
      }
      if (session.pendingApproval) {
        const decision = /^y(es)?$/i.test(text.trim()) ? 'allow' : 'deny';
        await api.decideApproval(id, session.pendingApproval.id, decision);
        return;
      }
      await api.sendMessage(id, text);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleDevSubmit = async (text: string) => {
    try {
      await api.sendDevMessage(id, text);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * Direct-message any specialist agent active in this session (ui-dev,
   * security, …). Wired to the per-tab input bar in the agent pane so
   * each specialist gets its own conversation channel.
   */
  const handleAgentSubmit = async (agent: string, text: string) => {
    try {
      await api.sendAgentMessage(id, agent, text);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * Operator-initiated proposal to dispatch an inactive specialist.
   * The agent tab strip surfaces unsummoned agents in a faded state;
   * clicking one drops the operator into a "tell sup what you want"
   * mini-form instead of a timeline. We wrap the request in a clear
   * preamble so sup recognises this is a structured proposal (handled
   * in supervisor.md → "Operator agent proposal") and routes through
   * the normal sendMessage path so the audit trail is just user → sup.
   */
  const handleProposeAgent = async (agent: string, text: string) => {
    const wrapped =
      `OPERATOR_AGENT_PROPOSAL — agent: ${agent}\n\n` +
      `The operator clicked the ${agent} tab and submitted this request. Decide whether ` +
      `dispatching ${agent} is the right move; if yes, dispatch with a complete brief via ` +
      `<TASK_FOR_DEVELOPER agent="${agent}">…</TASK_FOR_DEVELOPER>. If no, explain to ` +
      `the operator why and suggest the better path.\n\n` +
      `Operator's request:\n${text}`;
    try {
      await api.sendMessage(id, wrapped);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Right-rail state lifted to the page so the rail can render outside
  // the PanelGroup (always visible) while the wide content pane is just
  // a Panel inside — collapsing the wide pane returns the freed space
  // to SupChat + AgentPane instead of leaving a gap. Both pieces of
  // state persist to localStorage so a refresh keeps the operator's
  // last layout choice (hidden pane stays hidden, tab stays active).
  const [rightExpanded, setRightExpanded] = useState(true);
  const [rightActiveTab, setRightActiveTab] = useState<RightTab>('tool-detail');
  // Hydrate from localStorage on mount only — running this in a useState
  // initializer would crash on the server (no `window`) and trigger a
  // hydration mismatch warning when the values disagreed with the SSR
  // default.
  useEffect(() => {
    try {
      const exp = localStorage.getItem('selfclaude.rightExpanded');
      if (exp !== null) setRightExpanded(exp === 'true');
      const tab = localStorage.getItem('selfclaude.rightActiveTab');
      if (tab && RIGHT_TAB_VALUES.has(tab as RightTab)) {
        setRightActiveTab(tab as RightTab);
      }
    } catch {
      /* localStorage unavailable (private mode) — stick with defaults */
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('selfclaude.rightExpanded', String(rightExpanded));
    } catch {
      /* ignored */
    }
  }, [rightExpanded]);
  useEffect(() => {
    try {
      localStorage.setItem('selfclaude.rightActiveTab', rightActiveTab);
    } catch {
      /* ignored */
    }
  }, [rightActiveTab]);

  // Tool-click handler: when the user explicitly clicks a tool card in
  // the agent timeline, both store the selection AND snap the right
  // pane to the Tool Detail tab. Wired through a single handler
  // (instead of a useEffect watching selectedToolUseId) so SSE-driven
  // auto-selection of the first tool call doesn't override the
  // operator's persisted tab choice on session load.
  const handleSelectTool = useCallback(
    (toolUseId: string | null) => {
      selectTool(id, toolUseId);
      if (toolUseId) {
        setRightActiveTab('tool-detail');
        setRightExpanded(true);
      }
    },
    [id, selectTool],
  );

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 gap-4">
        <p className="text-red-300">{error}</p>
        <button
          onClick={() => router.push('/')}
          className="px-3 py-1 text-sm rounded border border-border hover:bg-bg-elevated"
        >
          {t('session.backToProjects')}
        </button>
      </div>
    );
  }

  if (!session) {
    return <div className="p-8 text-zinc-500">{t('session.loading')}</div>;
  }

  return (
    <div className="flex flex-col h-screen bg-bg">
      <TabBar />
      <StatusBar meta={session.meta} busy={session.busy} />
      <StuckBanner sessionId={id} />
      <TurnErrorBanner sessionId={id} />
      <div className="flex-1 min-h-0 flex">
        <FileSidebar sessionId={id} />
        {/* PanelGroup autoSaveId varies with the right-pane open state so
            the resize-handle layout each side persists independently —
            otherwise toggling the right pane would clobber whichever
            sizing the user last tweaked in the other mode. */}
        <PanelGroup
          direction="horizontal"
          autoSaveId={
            rightExpanded ? `${PANEL_LAYOUT_KEY}.expanded` : `${PANEL_LAYOUT_KEY}.collapsed`
          }
          className="flex-1"
        >
          <Panel defaultSize={rightExpanded ? 32 : 45} minSize={20}>
            <SupChat
              chatLog={session.chatLog}
              streamingTs={session.streamingSupTs}
              status={computeSupStatus(session.meta, session.streamingSupTs)}
              busy={session.busy}
              hasPendingQuestion={!!session.pendingQuestion}
              hasPendingApproval={!!session.pendingApproval}
              onSubmit={handleSupSubmit}
              onSelectTool={handleSelectTool}
              onLoadMoreHistory={loadMoreHistory}
              hasMoreHistory={session.hasMoreHistory}
              loadingHistory={session.loadingHistory}
              wakeups={derived?.wakeups ?? null}
              initialInput={demoInitialInput}
            />
          </Panel>
          <PanelResizeHandle className="PanelResizeHandle" />
          <Panel defaultSize={rightExpanded ? 36 : 55} minSize={20}>
            <AgentPane
              meta={session.meta}
              chatLog={session.chatLog}
              selectedToolUseId={session.selectedToolUseId}
              streamingDevTs={session.streamingDevTs}
              onSelectTool={handleSelectTool}
              busy={session.busy}
              onSubmitDev={handleDevSubmit}
              onSubmitAgent={handleAgentSubmit}
              onProposeAgent={handleProposeAgent}
              onLoadMoreHistory={loadMoreHistory}
              hasMoreHistory={session.hasMoreHistory}
              loadingHistory={session.loadingHistory}
              wakeups={derived?.wakeups ?? null}
              derived={derived}
            />
          </Panel>
          {rightExpanded && (
            <>
              <PanelResizeHandle className="PanelResizeHandle" />
              <Panel defaultSize={32} minSize={20}>
                <RightPanelContent
                  sessionId={id}
                  chatLog={session.chatLog}
                  selectedToolUseId={session.selectedToolUseId}
                  derived={derived}
                  activeTab={rightActiveTab}
                />
              </Panel>
            </>
          )}
        </PanelGroup>
        <RightRail
          expanded={rightExpanded}
          activeTab={rightActiveTab}
          pendingScripts={
            session.scripts?.scripts.filter((s) => s.status === 'pending').length ?? 0
          }
          onToggleExpanded={() => setRightExpanded((v) => !v)}
          onActivateTab={(tab) => {
            setRightActiveTab(tab);
            setRightExpanded(true);
          }}
        />
      </div>
      <Drawer
        question={session.pendingQuestion}
        onAnswer={(qid, answer) => api.answerQuestion(id, qid, answer)}
      />
      <ApprovalDialog
        sessionId={id}
        approval={session.pendingApproval}
        onDecide={(aid, decision) => api.decideApproval(id, aid, decision)}
      />
      <BottomToolbar
        meta={session.meta}
        metrics={session.metrics}
        chatLog={session.chatLog}
        busy={session.busy}
      />
      <IdleToast busy={session.busy} />
      <ScriptProposalToast
        sessionId={id}
        proposal={session.pendingProposalAlert}
        onClose={() => clearProposalAlert(id)}
        onOpenPanel={() => {
          setRightActiveTab('scripts');
          setRightExpanded(true);
        }}
      />
      {chatPreviewPath && (
        <FilePreviewModal
          sessionId={id}
          path={chatPreviewPath}
          onClose={() => setChatPreviewPath(null)}
        />
      )}
    </div>
  );
}
