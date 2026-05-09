import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const ChatLogEntrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user-message'), text: z.string(), ts: z.number() }),
  z.object({ type: z.literal('sup-message'), text: z.string(), ts: z.number() }),
  z.object({ type: z.literal('dev-text'), text: z.string(), ts: z.number() }),
  /**
   * Extended-thinking content emitted by Claude before it produces final
   * assistant text. Surfacing these lets the operator watch the model
   * reason in real time and audit unexpected behaviour after the fact.
   */
  z.object({ type: z.literal('sup-thinking'), text: z.string(), ts: z.number() }),
  z.object({ type: z.literal('dev-thinking'), text: z.string(), ts: z.number() }),
  z.object({
    type: z.literal('dev-tool-call'),
    id: z.string(),
    toolUseId: z.string(),
    name: z.string(),
    input: z.record(z.unknown()),
    ts: z.number(),
  }),
  z.object({
    type: z.literal('dev-tool-result'),
    toolUseId: z.string(),
    text: z.string(),
    isError: z.boolean(),
    ts: z.number(),
  }),
  /**
   * Supervisor tool calls (Read, Bash, ask_user, write_phase_doc, etc.).
   * Surfaced separately from dev so the UI can render them in the sup
   * pane without polluting the dev timeline. Sup *can* read files and run
   * read-only checks; logging it gives the operator visibility.
   */
  z.object({
    type: z.literal('sup-tool-call'),
    id: z.string(),
    toolUseId: z.string(),
    name: z.string(),
    input: z.record(z.unknown()),
    ts: z.number(),
  }),
  z.object({
    type: z.literal('sup-tool-result'),
    toolUseId: z.string(),
    text: z.string(),
    isError: z.boolean(),
    ts: z.number(),
  }),
  z.object({ type: z.literal('task-marker'), summary: z.string(), ts: z.number() }),
  z.object({
    type: z.literal('turn-marker'),
    turnIndex: z.number(),
    who: z.enum(['sup', 'dev']),
    ts: z.number(),
  }),
  z.object({ type: z.literal('phase-doc-written'), filename: z.string(), ts: z.number() }),
  z.object({
    type: z.literal('question'),
    id: z.string(),
    text: z.string(),
    options: z.array(z.string()).optional(),
    ts: z.number(),
  }),
  z.object({
    type: z.literal('question-resolved'),
    id: z.string(),
    answer: z.string(),
    ts: z.number(),
  }),
  z.object({
    type: z.literal('approval'),
    id: z.string(),
    action: z.string(),
    reason: z.string(),
    ts: z.number(),
  }),
  z.object({
    type: z.literal('approval-resolved'),
    id: z.string(),
    decision: z.enum(['allow', 'deny']),
    ts: z.number(),
  }),
  z.object({ type: z.literal('iteration-end'), iteration: z.number(), ts: z.number() }),
  z.object({
    type: z.literal('user-note-dev'),
    text: z.string(),
    ts: z.number(),
  }),
  z.object({
    type: z.literal('user-message-dev'),
    text: z.string(),
    ts: z.number(),
  }),
  /**
   * A `ScheduleWakeup` tool call from sup or dev was received and converted
   * into an orchestrator-managed timer. `wakeupId` is the runner's UUID
   * (not CC's tool_use_id) so cancelled/fired entries can be paired with
   * the originating schedule deterministically across replay.
   */
  z.object({
    type: z.literal('wakeup-scheduled'),
    wakeupId: z.string(),
    role: z.enum(['supervisor', 'developer']),
    fireAt: z.number(),
    prompt: z.string(),
    reason: z.string(),
    ts: z.number(),
  }),
  /** Timer fired and the synthetic prompt was injected into the agent. */
  z.object({
    type: z.literal('wakeup-fired'),
    wakeupId: z.string(),
    role: z.enum(['supervisor', 'developer']),
    ts: z.number(),
  }),
  /** Wakeup cancelled before firing (replaced by a newer schedule, user took over, or shutdown). */
  z.object({
    type: z.literal('wakeup-cancelled'),
    wakeupId: z.string(),
    role: z.enum(['supervisor', 'developer']),
    reason: z.enum(['replaced', 'user-input', 'shutdown']),
    ts: z.number(),
  }),
  /**
   * Marker that a legacy `dev-tool-call` ScheduleWakeup (recorded before
   * the orchestrator-level runner existed) has been migrated into a
   * proper `wakeup-scheduled`. Without this the next daemon boot would
   * find the same legacy entry and migrate it AGAIN — re-firing a stale
   * wakeup forever every restart. Keyed by the legacy tool_use_id so the
   * mapping is deterministic.
   */
  z.object({
    type: z.literal('wakeup-legacy-consumed'),
    legacyToolUseId: z.string(),
    /** New runner wakeupId we replaced it with, for cross-reference. */
    wakeupId: z.string(),
    ts: z.number(),
  }),
  /**
   * Generic per-agent event types — used for any specialist agent that
   * isn't the default `developer` (ui-dev, security, future custom roles).
   * The default developer keeps its own `dev-*` entries for backward
   * compat with existing chat logs; everyone else lives under these
   * generic kinds with an explicit `agent` tag.
   */
  z.object({
    type: z.literal('agent-text'),
    agent: z.string(),
    text: z.string(),
    ts: z.number(),
  }),
  z.object({
    type: z.literal('agent-thinking'),
    agent: z.string(),
    text: z.string(),
    ts: z.number(),
  }),
  z.object({
    type: z.literal('agent-tool-call'),
    agent: z.string(),
    id: z.string(),
    toolUseId: z.string(),
    name: z.string(),
    input: z.record(z.unknown()),
    ts: z.number(),
  }),
  z.object({
    type: z.literal('agent-tool-result'),
    agent: z.string(),
    toolUseId: z.string(),
    text: z.string(),
    isError: z.boolean(),
    ts: z.number(),
  }),
  /** Lifecycle events for the active-agent set, sourced from supervisor SUMMON/DISMISS tags. */
  z.object({
    type: z.literal('agent-summoned'),
    agent: z.string(),
    ts: z.number(),
  }),
  z.object({
    type: z.literal('agent-dismissed'),
    agent: z.string(),
    ts: z.number(),
  }),
  /**
   * Supervisor's "Yargısal Karar" — a numbered binding decision broadcast
   * to every active agent. The operator's mental model is a moderator
   * declaring the outcome of a discussion; in practice the supervisor
   * emits `<VERDICT id="N">…</VERDICT>` blocks in its chat reply and the
   * orchestrator persists each one here + injects the text into every
   * specialist's inbox so they see the decision on their next turn.
   *
   * The numbered id lets the operator (and the agents) reference past
   * verdicts: "honour decision #3" / "this contradicts #5".
   */
  z.object({
    type: z.literal('verdict'),
    id: z.number().int().positive(),
    text: z.string(),
    ts: z.number(),
  }),
  /**
   * Inter-agent free chat — when a specialist (ui-dev / security /
   * developer) posts a `<ROOM>…</ROOM>` block in its reply, the
   * orchestrator extracts the body, archives it here, and forwards it
   * to the supervisor's inbox. Sup is the moderator: it observes the
   * room, decides whether to act, and may close a thread by issuing a
   * verdict (red envelope, broadcast).
   *
   * We deliberately don't fan-out to other specialists' contexts —
   * tokens stay bounded and the "moderator collects, decides, broadcasts"
   * mental model matches what the operator asked for.
   */
  z.object({
    type: z.literal('room-message'),
    agent: z.string(),
    text: z.string(),
    ts: z.number(),
  }),
  /* ───── Phase tracker audit log entries ─────
   *
   * Every phase-tracker mutation lands in chat-log so the audit panel
   * can replay the full project-progress history without parsing the
   * mutable `phases.json` snapshot. The snapshot is the *current*
   * state; these entries are the *journal* of how it got there.
   */
  z.object({
    type: z.literal('phase-registered'),
    slug: z.string(),
    title: z.string(),
    /** Number of items the supervisor declared in this registration. */
    itemCount: z.number(),
    /** True when this re-registers an existing phase (merge happened). */
    isReregistration: z.boolean().default(false),
    ts: z.number(),
  }),
  z.object({
    type: z.literal('phase-item-proposed'),
    slug: z.string(),
    itemId: z.string(),
    itemTitle: z.string(),
    /** Specialist agent that proposed completion (`developer`, `ui-dev`, …). */
    agent: z.string(),
    /** Free-form notes the proposer attached. */
    notes: z.string().default(''),
    ts: z.number(),
  }),
  z.object({
    type: z.literal('phase-item-confirmed'),
    slug: z.string(),
    itemId: z.string(),
    itemTitle: z.string(),
    /** Always `supervisor` today; kept generic for future moderator agents. */
    confirmer: z.string(),
    /** Original proposer; null if confirmed without a prior proposal. */
    proposer: z.string().nullable(),
    /** Auto-captured tool-call trail; empty arrays mean drive-by confirm. */
    evidence: z
      .object({
        reads: z.array(z.object({ path: z.string(), ts: z.number() })).default([]),
        bashes: z
          .array(
            z.object({
              command: z.string(),
              ts: z.number(),
              isError: z.boolean().default(false),
            }),
          )
          .default([]),
        edits: z.array(z.object({ path: z.string(), ts: z.number() })).default([]),
        tsFrom: z.number(),
        tsTo: z.number(),
        totalCount: z.number().default(0),
      })
      .nullable(),
    /** Optional sup confirmation note. */
    notes: z.string().default(''),
    ts: z.number(),
  }),
  z.object({
    type: z.literal('phase-item-rejected'),
    slug: z.string(),
    itemId: z.string(),
    itemTitle: z.string(),
    rejector: z.string(),
    proposer: z.string().nullable(),
    reason: z.string(),
    ts: z.number(),
  }),
  z.object({
    /**
     * Operator marked a confirmed-but-empty-evidence item as verified
     * out-of-band — they inspected the work themselves. Pairs with the
     * `operatorVerifiedAt` field on the PhaseItem; resolves the ⚠ flag
     * the UI shows for drive-by confirms.
     */
    type: z.literal('phase-item-operator-verified'),
    slug: z.string(),
    itemId: z.string(),
    itemTitle: z.string(),
    operator: z.string(),
    notes: z.string().default(''),
    ts: z.number(),
  }),
  /**
   * Operator-attached reference document landed in `.selfclaude/refs/`.
   * Surfaced to the supervisor via a system-prompt manifest on every
   * turn (the file content itself is loaded lazily by sup via Read).
   * We keep the per-add / per-remove journal so the decision-report
   * can show "operator added BRIEF.md before phase 2" without scraping
   * the filesystem at render time.
   */
  z.object({
    type: z.literal('ref-added'),
    name: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    ts: z.number(),
  }),
  z.object({
    type: z.literal('ref-removed'),
    name: z.string(),
    ts: z.number(),
  }),
]);

export type ChatLogEntry = z.infer<typeof ChatLogEntrySchema>;

export function chatLogPath(cwd: string): string {
  return join(cwd, '.selfclaude', 'chat-log.jsonl');
}

export async function appendChatLogEntry(cwd: string, entry: ChatLogEntry): Promise<void> {
  const path = chatLogPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`);
}

/**
 * Read all entries from the chat-log. Malformed/unparseable lines are
 * skipped silently — the log is append-only and we must not lose newer
 * entries because of one bad earlier line.
 */
export async function readChatLog(cwd: string): Promise<ChatLogEntry[]> {
  const path = chatLogPath(cwd);
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  const entries: ChatLogEntry[] = [];
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      const result = ChatLogEntrySchema.safeParse(parsed);
      if (result.success) entries.push(result.data);
    } catch {
      // skip malformed line
    }
  }
  return entries;
}
