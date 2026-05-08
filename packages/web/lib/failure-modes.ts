/**
 * Phase 7 sprint 2 — web-side mirror of the failure-mode catalog.
 *
 * The authoritative source lives in
 * `packages/core/src/orchestrator/failure-modes.ts`. We duplicate the
 * user-facing strings here (instead of fetching via REST) because:
 *   - The catalog is small (8 entries) and stable.
 *   - Bundling avoids a network round-trip on session page load.
 *   - Codes are part of the storage contract; renaming on either
 *     side requires a coordinated change.
 *
 * If a code arrives that isn't in this map, callers fall back to
 * UNKNOWN_MODE so the UI still renders something sensible — better
 * to show a generic "unknown" entry than to crash on an unfamiliar
 * code (e.g. older session with a removed catalog entry).
 *
 * **Sync rule:** when `failure-modes.ts` in core changes, mirror it
 * here. The fields below are exactly what the catalog entry exposes
 * minus the `code` field (used as the map key).
 */

import { getTranslation } from './i18n';

export type FailureSeverity = 'info' | 'warn' | 'error';

export interface FailureModeUI {
  /** Short human label (≤30 chars). Used in chips/badges. */
  label: string;
  /** One-paragraph operator-facing description. */
  description: string;
  /** What the operator can do about it — concrete, not generic. */
  suggestedAction: string;
  severity: FailureSeverity;
}

function buildCatalog(): Record<string, FailureModeUI> {
  return {
    'tool-error': {
      label: getTranslation('failureMode.toolError.label'),
      description: getTranslation('failureMode.toolError.description'),
      suggestedAction: getTranslation('failureMode.toolError.suggestedAction'),
      severity: 'warn',
    },
    'agent-timeout': {
      label: getTranslation('failureMode.agentTimeout.label'),
      description: getTranslation('failureMode.agentTimeout.description'),
      suggestedAction: getTranslation('failureMode.agentTimeout.suggestedAction'),
      severity: 'error',
    },
    'context-overflow': {
      label: getTranslation('failureMode.contextOverflow.label'),
      description: getTranslation('failureMode.contextOverflow.description'),
      suggestedAction: getTranslation('failureMode.contextOverflow.suggestedAction'),
      severity: 'warn',
    },
    'hook-validation': {
      label: getTranslation('failureMode.hookValidation.label'),
      description: getTranslation('failureMode.hookValidation.description'),
      suggestedAction: getTranslation('failureMode.hookValidation.suggestedAction'),
      severity: 'info',
    },
    'network-error': {
      label: getTranslation('failureMode.networkError.label'),
      description: getTranslation('failureMode.networkError.description'),
      suggestedAction: getTranslation('failureMode.networkError.suggestedAction'),
      severity: 'warn',
    },
    'mcp-crash': {
      label: getTranslation('failureMode.mcpCrash.label'),
      description: getTranslation('failureMode.mcpCrash.description'),
      suggestedAction: getTranslation('failureMode.mcpCrash.suggestedAction'),
      severity: 'warn',
    },
    'agent-aborted': {
      label: getTranslation('failureMode.agentAborted.label'),
      description: getTranslation('failureMode.agentAborted.description'),
      suggestedAction: getTranslation('failureMode.agentAborted.suggestedAction'),
      severity: 'info',
    },
    unknown: {
      label: getTranslation('failureMode.unknown.label'),
      description: getTranslation('failureMode.unknown.description'),
      suggestedAction: getTranslation('failureMode.unknown.suggestedAction'),
      severity: 'error',
    },
  };
}

/**
 * Resolve the catalog entry for a given code. Falls back to the
 * `unknown` entry when the code isn't recognised — keeps the UI from
 * crashing on a stale chat-log entry whose catalog entry was removed.
 */
export function getFailureModeUI(code: string): FailureModeUI {
  const catalog = buildCatalog();
  return catalog[code] ?? catalog.unknown!;
}
