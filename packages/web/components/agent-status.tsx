'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Octagon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useTranslation } from '../lib/i18n';
import { api } from '@/lib/api';
import { ConfirmDialog } from './confirm-dialog';
import type { ChatLogEntry, SessionMeta } from '@/lib/types';

export type StatusKind = 'thinking' | 'writing' | 'tool' | 'working';

export interface AgentStatusInfo {
  kind: StatusKind;
  toolName?: string;
  toolDetail?: string;
}


const ROTATION_MS = 14_000;

export function computeSupStatus(
  meta: SessionMeta | null,
  streamingTs: number | null,
): AgentStatusInfo | null {
  if (!meta?.supActive) return null;
  if (streamingTs !== null) return { kind: 'writing' };
  return { kind: 'thinking' };
}

export function computeDevStatus(
  meta: SessionMeta | null,
  chatLog: ChatLogEntry[],
  streamingTs: number | null,
): AgentStatusInfo | null {
  if (!meta?.devActive) return null;
  // Surface the in-flight tool, if any.
  for (let i = chatLog.length - 1; i >= 0; i--) {
    const e = chatLog[i]!;
    if (e.type === 'dev-tool-call') {
      const resolved = chatLog.some(
        (r) => r.type === 'dev-tool-result' && r.toolUseId === e.toolUseId,
      );
      if (!resolved) {
        return {
          kind: 'tool',
          toolName: e.name,
          toolDetail: summarizeToolInput(e.name, e.input),
        };
      }
      break;
    }
    if (e.type === 'dev-text' || e.type === 'sup-message') break;
  }
  if (streamingTs !== null) return { kind: 'writing' };
  return { kind: 'working' };
}

/**
 * Specialist agents (ui-dev, security, …) flow through the same
 * `dev-running` FSM state as the default developer, so we use
 * `meta.devActive` as the running gate. The unresolved-tool scan
 * filters by the agent's name so a ui-dev tab shows ui-dev's tool,
 * not the developer's.
 *
 * Phase 7 fix: this is what mounts the stop button on dev/specialist
 * timelines. Before this, only sup had the abort affordance — every
 * other agent silently ran to completion.
 */
export function computeAgentStatus(
  agent: string,
  meta: SessionMeta | null,
  chatLog: ChatLogEntry[],
  streamingTs: number | null,
): AgentStatusInfo | null {
  if (agent === 'developer') {
    return computeDevStatus(meta, chatLog, streamingTs);
  }
  if (!meta?.devActive) return null;
  for (let i = chatLog.length - 1; i >= 0; i--) {
    const e = chatLog[i]!;
    if (e.type === 'agent-tool-call' && e.agent === agent) {
      const resolved = chatLog.some(
        (r) =>
          r.type === 'agent-tool-result' &&
          r.agent === agent &&
          r.toolUseId === e.toolUseId,
      );
      if (!resolved) {
        return {
          kind: 'tool',
          toolName: e.name,
          toolDetail: summarizeToolInput(e.name, e.input),
        };
      }
      break;
    }
    if (
      (e.type === 'agent-text' && e.agent === agent) ||
      e.type === 'sup-message'
    ) {
      break;
    }
  }
  if (streamingTs !== null) return { kind: 'writing' };
  return { kind: 'working' };
}

function summarizeToolInput(name: string, input: Record<string, unknown>): string | undefined {
  if (name === 'Bash') {
    const cmd = String(input.command ?? '');
    return cmd.length > 60 ? `${cmd.slice(0, 57)}…` : cmd;
  }
  if (name === 'Read' || name === 'Edit' || name === 'Write') {
    const p = String(input.file_path ?? '');
    return p.length > 60 ? `…${p.slice(-57)}` : p;
  }
  if (name === 'Grep' || name === 'Glob') {
    return String(input.pattern ?? '');
  }
  return undefined;
}

export function AgentStatus({
  status,
  variant,
}: {
  status: AgentStatusInfo | null;
  /**
   * `'sup'` for supervisor, `'dev'` for the default developer, or any
   * specialist agent name (`'ui-dev'`, `'security'`, custom) for the
   * agent timeline. The variant drives the label + accent + the abort
   * routing — specialists share the developer abort controller in
   * the orchestrator, so non-sup variants all map to role='developer'
   * for the abort endpoint.
   */
  variant: 'sup' | 'dev' | string;
}) {
  const { t, tArray } = useTranslation();
  const params = useParams<{ id: string }>();
  const sessionId = params?.id;
  const [tick, setTick] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [aborting, setAborting] = useState(false);

  useEffect(() => {
    if (!status) return;
    const id = setInterval(() => setTick((tk) => tk + 1), ROTATION_MS);
    return () => clearInterval(id);
  }, [status]);

  if (!status) return null;

  const isSup = variant === 'sup';
  const colorClass = isSup ? 'text-cyan-400' : 'text-amber-400';

  // Resolve phrases from i18n catalog.
  const prefix = isSup ? 'agentStatus.sup' : 'agentStatus.dev';
  const phrases: Record<StatusKind, string[]> = {
    thinking: tArray(`${prefix}.thinking` as Parameters<typeof tArray>[0]),
    writing:  tArray(`${prefix}.writing`  as Parameters<typeof tArray>[0]),
    tool:     tArray(`${prefix}.tool`     as Parameters<typeof tArray>[0]),
    working:  tArray(`${prefix}.working`  as Parameters<typeof tArray>[0]),
  };

  // Variant labels: sup → 'supervisor', dev → 'developer', anything
  // else (specialist) → the agent name verbatim. Falls back cleanly
  // for any future custom agent.
  const variantLabel =
    variant === 'sup'
      ? t('agentStatus.variantLabel.supervisor')
      : variant === 'dev'
        ? t('agentStatus.variantLabel.developer')
        : variant;

  let labelText: string;
  let detail: string | undefined;
  if (status.kind === 'tool') {
    labelText = `${phrases.tool[tick % phrases.tool.length]} ${status.toolName ?? ''}`.trim();
    detail = status.toolDetail;
  } else {
    const arr = phrases[status.kind];
    labelText = arr[tick % arr.length] ?? arr[0]!;
  }

  // Specialists share the developer abort controller — sending
  // role='developer' from a ui-dev/security tab kills the active turn,
  // which is correct since only one agent runs at a time.
  const role: 'supervisor' | 'developer' = isSup ? 'supervisor' : 'developer';

  /** Fire the abort. The status bar disappears as soon as the SSE
   *  `turn-busy false` event lands; we don't need any local state for it. */
  const handleAbort = async () => {
    if (!sessionId) return;
    setAborting(true);
    setConfirming(false);
    try {
      await api.abortTurn(sessionId, role);
    } catch (e) {
      console.warn('abortTurn failed:', (e as Error).message);
    } finally {
      setAborting(false);
    }
  };

  return (
    <>
      <div
        className={cn(
          'px-3 py-1.5 text-[11px] flex items-center gap-2 border-t border-border bg-bg-subtle/60',
          colorClass,
        )}
      >
        <span className="typing-dots">
          <span />
          <span />
          <span />
        </span>
        <span>{variantLabel}</span>
        <span className="text-zinc-500">·</span>
        <span>{labelText}</span>
        {detail && (
          <>
            <span className="text-zinc-500">·</span>
            <code className="text-zinc-300 truncate max-w-[400px]">{detail}</code>
          </>
        )}
        <button
          onClick={() => setConfirming(true)}
          disabled={aborting}
          className={cn(
            'ml-auto shrink-0 flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-medium transition-colors',
            'border-red-800/60 bg-red-950/30 text-red-300 hover:bg-red-900/50 hover:border-red-700',
            'disabled:opacity-50',
          )}
          title={t('agentStatus.stop.title', { role })}
        >
          <Octagon size={10} />
          {t('agentStatus.stop')}
        </button>
      </div>
      <ConfirmDialog
        open={confirming}
        title={t('agentStatus.confirm.title', { role })}
        message={t('agentStatus.confirm.message', { variantLabel })}
        confirmLabel={t('agentStatus.confirm.stop')}
        cancelLabel={t('agentStatus.confirm.keepRunning')}
        variant="danger"
        onConfirm={handleAbort}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
