// Public surface re-exported for downstream packages (cli, web).

export {
  Orchestrator,
  type StartResult,
  type PendingQuestionView,
  type PendingApprovalView,
  type HookEnv,
  type OrchestratorOptions,
} from './orchestrator/index.js';

export type {
  FsmState,
  FsmEvent,
  FsmTag,
  Phase,
} from './orchestrator/state-machine.js';

export {
  StreamJsonParser,
  StreamEventSchema,
  extractAssistantText,
  extractSessionId,
  extractStreamTextDelta,
  extractToolUses,
  extractToolResults,
  type StreamEvent,
  type ToolUseBlock,
  type ToolResultBlock,
  type ParseError,
} from './orchestrator/stream-parser.js';

export { extractDeveloperTasks } from './orchestrator/tag-parser.js';

export {
  runDualAgentTurn,
  loadSupervisorSystemPrompt,
  type LoopRunOptions,
  type LoopTurnResult,
} from './orchestrator/loop.js';

export {
  runConversationTurn,
  type ConversationOptions,
  type ConversationResult,
  type ConversationEndedReason,
} from './orchestrator/conversation.js';

export {
  runClaudeTurn,
  buildClaudeArgs,
  buildPromptEnvelope,
  type SpawnOptions,
  type TurnResult,
  type Role,
  type PermissionMode,
} from './claude-code/spawn.js';

export {
  evaluatePolicy,
  type ToolCall,
  type PolicyAction,
  type PolicyDecision,
} from './orchestrator/policy.js';

export { extractSignals, type SignalKind } from './orchestrator/signals.js';

export { TelegramBridge } from './telegram/bridge.js';
export { GrammyTelegramAdapter } from './telegram/grammy-adapter.js';
export { parseApprovalReply } from './telegram/parser.js';
export type { IncomingMessage, TelegramAdapter } from './telegram/adapter.js';
export {
  generatePairingCode,
  runLinkFlow,
  type LinkResult,
} from './telegram/link.js';

export {
  loadEnv,
  hasTelegram,
  setEnvVar,
  findRepoRoot,
  ENV_PATH,
  ENV_EXAMPLE_PATH,
  type Env,
} from './lib/env.js';
export { log, configureLogFile, setLogLevel, type LogLevel } from './lib/log.js';

export { detectProject, type ProjectDetection } from './project/detect.js';
export {
  ProjectStateSchema,
  newProjectState,
  readProjectState,
  writeProjectState,
  type ProjectState,
  type ProjectPhase,
} from './project/state.js';

export {
  installWorkspace,
  workspacePaths,
  type WorkspacePaths,
  type ScriptName,
} from './hooks/installer.js';

export {
  appendChatLogEntry,
  readChatLog,
  chatLogPath,
  ChatLogEntrySchema,
  type ChatLogEntry,
} from './project/chat-log.js';

export {
  SessionManager,
  type SessionContext,
  type SessionMeta,
  type SessionSnapshot,
  type SessionEvent,
} from './server/session-manager.js';

export {
  buildWebApi,
  startWebApi,
  type WebApiOptions,
  type WebApiHandle,
} from './server/web-api.js';

export { streamSseFromEmitter } from './server/sse.js';

export {
  addFavorite,
  listFavorites,
  removeFavorite,
  FavoriteSchema,
  type Favorite,
} from './server/favorites.js';
