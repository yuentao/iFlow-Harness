/**
 * Chat panel: owns the AcpClient lifecycle and the WebView. Host-side routing:
 * WebView messages → ACP calls; ACP events → store → throttled snapshots.
 */

import * as vscode from "vscode";
import os from "node:os";
import path from "node:path";
import { inspect, promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readFile, readdir, writeFile, mkdir, rm, rename, stat } from "node:fs/promises";
import { AcpClient, type AcpClientCallbacks } from "../acp/client.js";
import {
  errorMessage,
  isContextOverflowError,
  isRateLimitError,
  isRequestTimeoutError,
  isThinkingUnsupportedError,
  isTransientStreamError,
} from "../acp/jsonrpc.js";
import { buildAcpCommand, concealNodeExecutable, configureLocatorPersistence, ensureIflowDefaultConfigs, ensureVendorBinariesExecutable, locateNodeExecutable, resolveVendoredEntry, type LocatorPaths } from "../acp/cli-locator.js";
import { acpSessionFilePath, applyThinkingRules, mcpScopeOf, projectSettingsFor, queryModelIds, readActiveEndpoint, readMcpServers, resolveActiveProfileName, retireStaleOAuthCreds, settingsFilePath, thinkingForModelRules, thinkingRulesFilePath, updateCliSettings, sanitizeThinkingRules, type ThinkingRuleEntry } from "../acp/models-query.js";
import { deleteKernelApiProfile, migrateKernelApiProfiles, readKernelApiProfiles, setKernelActiveProfile, writeKernelApiProfile } from "../acp/api-profiles.js";
import {
  getActiveProfileName,
  loadCredentials,
  loadProfiles,
  maskKey,
  saveProfiles,
  validateCredentials,
  type OpenAiCompatCredentials,
} from "../acp/auth.js";
import { readCliSettings, type CliSettingsShape } from "../acp/models-query.js";
import { streamChatCompletion } from "../acp/complete.js";
import type { AuthUiState } from "../../shared/messages.js";
import type {
  ContentBlock,
  NewSessionMeta,
  PermissionOption,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  UserQuestionsRequest,
  UserQuestionsResponse,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  McpStatusReport,
  McpServerStatusView,
  SessionSettings,
  ToolCallBase,
} from "../acp/protocol.js";
import type { PendingApprovalUi, PendingPlanExitUi, PendingProfileSwitchUi, AssetKind, Block, CheckpointUi, ContextKind, ContextRefUi, InjectedContextItem, McpScope, McpStatusUi, QqSettingsUi, QueuedPromptUi, SessionState, SessionSummaryUi, ToolBlock, ToolDiffUi, WebviewToHost } from "../../shared/messages.js";
import { extractCorePrompt, isPlanMode, normalizeUserPromptText, splitReportedContextSections, AGENT_ATTACHMENT_HEADER } from "../../shared/messages.js";
import { buildAssetGenPrompt, normalizeGeneratedAsset } from "../../shared/asset-gen.js";
import { loadPrompt, renderPrompt } from "../../prompts/index.js";
import { canReviewTurn, collectTurnChanges, collectTurnToolBlocks, isLatestTurn, turnChangeKey } from "../../shared/turn-changes.js";
import {
  clearQueue as clearQueueUi,
  moveQueued as moveQueuedUi,
  removeQueued as removeQueuedUi,
  shiftQueued as shiftQueuedUi,
} from "../../shared/queue.js";
import {
  checkpointLabelFromText,
  parseCheckpointIndex,
  planCheckpointRetention,
  pruneCheckpointsForBlocks,
  reanchorCheckpoints,
  serializeCheckpointIndex,
  upsertCheckpoint,
} from "../../shared/checkpoints.js";
import { CheckpointManager } from "./checkpoints.js";
import { SuperAgentManager } from "./super-agent.js";
import {
  buildSuperActionReceiptPrompt,
  buildSuperDigest,
  buildDelegatedUserTurnPrompt,
  buildSuperMergeRequestPrompt,
  clampMaxConcurrentSuperSessions,
  clampMaxSuperWorktrees,
  DEFAULT_MAX_CONCURRENT_SUPER_SESSIONS,
  DEFAULT_MAX_SUPER_WORKTREES,
  extractSuperActions,
  fromPersistedSuperSession,
  isTerminalSuperStatus,
  MAX_SUPER_ATTACHMENTS,
  normalizeSuperTitle,
  superArchiveFingerprint,
  superDirectiveDedupeKey,
  SuperDirectiveScanner,
  SuperReportBuffer,
  type SuperAction,
  type SuperActionReceipt,
  type SuperAttachment,
  type SuperReportEntry,
  type SuperSessionUi,
  type SuperStatus,
  type SuperTaskSpec,
} from "../../shared/super-agent.js";
import {
  classifySuperToolName,
  parseSuperToolCall,
} from "../../shared/super-tool-call.js";
import {
  deleteSuperSessionArchive,
  listSuperSessionArchiveFiles,
  readSuperSessionArchive,
  superSessionFileName,
  superSessionsDir,
  writeSuperSessionArchive,
} from "./super-store.js";
import {
  assembleContextSections,
  buildFolderListing,
  buildGitReport,
  buildTerminalReport,
  decodeResponseText,
  extractHtmlText,
  formatDiagnosticsReport,
  isHttpUrl,
  normalizeFolderRel,
  truncateChars,
} from "../../shared/context-source.js";
import type { ParsedEditArgs, PreEditSnapshot } from "../../shared/session-state.js";
import {
  backfillBlockIds,
  canStopSubAgent,
  beginReplay,
  clampSessionLabel,
  estimateMcpContextTokens,
  dropSessionUpdate,
  endReplay,
  extractRerunnableCommand,
  findCliHistoryCut,
  findToolBlockById,
  isAgentOutputUpdate,
  isSubAgentToolCall,
  MAX_SYNTH_DIFF_CHARS,
  newSessionState,
  parseEditArgs,
  parseToolFilePath,
  parseTranscriptJsonl,
  reassignBlockIds,
  renameSessionSummary,
  SESSION_LABEL_MAX,
  setQqTasks,
  snapshotEditDiff,
  sortSessionSummaries,
  synthesizeEditDiff,
  toAgentPromptText,
} from "../../shared/session-state.js";
import { computeHunks, replayHunks } from "../../shared/hunks.js";
import {
  APPROVAL_RULES_MAX,
  decideApproval,
  deriveAllowRule,
  hardDenyReason,
  isSuperAgentToolRequest,
  normalizeApprovalRule,
  parseApprovalPolicy,
  serializeApprovalPolicy,
  type ApprovalRequestInfo,
  type ApprovalRule,
} from "../../shared/approval-policy.js";
import { SessionStore } from "./store.js";
import { getTerminalRecorder, openInTerminal } from "./terminal.js";
import { MemoryService } from "../memory/service.js";
import { AssetsService } from "../assets/service.js";
import { resolveSkill, skillRoots } from "../skills/service.js";
import { buildSkillPrompt, parseSkillInvocation, type SkillInvocation } from "../../shared/skills.js";
import { isWithin, memoryHome } from "../memory/files.js";
import type { WorkspaceFile, WorkspaceScan } from "../memory/knowledge.js";
import { attachmentSessionDir, sweepStaleAttachmentDirs } from "./attachments.js";
import { parseContextWindowOverrides, parseCostTable, resolveContextWindow, resolveCost } from "../../shared/context-window.js";
import {
  gateOsNotification,
  initOsNotifyGate,
  isDuplicateNotificationBlock,
  type OsNotifyDecision,
  type OsNotifyEvent,
  type OsNotifyGate,
} from "../../shared/notifications.js";
import { sendOsNotification } from "../acp/os-notify.js";
import { transcriptToMarkdown, transcriptToJson } from "../../shared/export.js";
import { planSpecContent, planSpecFileName, planChecklistEntries } from "../../shared/plan-spec.js";
import {
  buildFollowupPrompt,
  parseFollowupResponse,
  type FollowupInput,
  type FollowupNextStepsInput,
  type FollowupTaskKind,
} from "../../shared/turn-followup.js";
import {
  buildMetadataQueries,
  buildModelMetadataPrompt,
  parseModelMetadata,
  planMetadataAdditions,
  type MetadataSource,
} from "../../shared/model-metadata.js";
import { fetchPageText, searchWeb, type WebSearchHit } from "../acp/web-search.js";
import { WireRingBuffer } from "./wire-log.js";
import { QqService, type QqTaskAction } from "../qq/service.js";
import { QqTaskStore } from "../qq/store.js";
import {
  createQqServiceHost,
  QQ_DEFAULT_SETTLE_TIMEOUT_MS,
  QqSettleTimeoutError,
  type QqHostPorts,
  type QqHostSuperSnapshot,
} from "../qq/panel-host.js";
import {
  applyQqSettingsPatch,
  createVscodeQqSettingsIo,
  readQqSettings,
  writeQqSecrets,
  type QqSettingsIo,
} from "../qq/settings-host.js";
import {
  checkQqStartupGate,
  normalizeQqConfig,
  validateQqConfig,
  type QqConfig,
} from "../qq/config.js";
import {
  generateBindCode,
  isBindCodeValid,
  isTerminalSuperStatus as isQqTerminalSuperStatus,
  QQ_SETTLE_POLL_MS,
  shouldRestartOnPatch,
} from "../qq/wiring.js";
import type { InboundMessage } from "../qq/adapter/types.js";
import {
  buildClearedQrMessage,
  createQqBotBindRuntime,
  createQqChannelDispatch,
  deliverViaQqBotAdapter,
  qrFailureMessage,
  qrProgressMessage,
  qrReadyMessage,
  readQqBotCredentials,
  sanitizeQrLoginMessage,
  storeQqBotCredentials,
  toManagedStatusMessage,
  type QqBotAdapterLike,
  type QqBotBindRuntimeDeps,
  type QqChannelDispatchDeps,
} from "./qqbot-host.js";

const WEBVIEW_DIST = "webview/dist/index.html";
/** M2 P0-4: async execFile (never sync — trap #18: external process probes
 * must not block the extension host). */
const execFileAsync = promisify(execFileCb);
/** M2 P0-4 @git: per-command timeout and combined output cap. */
const GIT_CONTEXT_TIMEOUT_MS = 5_000;
const GIT_CONTEXT_MAX_CHARS = 32_000;
/** Diagnostics watch: settle window before comparing against the turn
 * baseline — the agent's edit bursts fire many change events per second. */
const DIAG_WATCH_DEBOUNCE_MS = 4_000;
/** M2 P0-4 @url: fetch timeout / response cap / final text cap. */
const URL_FETCH_TIMEOUT_MS = 10_000;
const URL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** User answer window for a tool-approval card. */
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
/** Re-check window for the deferred card toasts (policy 2026-10-16): the OS
 * reminder for an approval / plan / question card is scheduled this long and
 * fires only if the card still owns its webview pending slot when the check
 * runs — parallel permission requests replace each other's card (CLI runs a
 * turn's function calls through Promise.allSettled), and a card that has been
 * replaced (or answered) must never announce itself (screenshot 2026-10-16).
 * Short enough to stay instantaneous for the notification center, long enough
 * to catch same-tick slot collisions. */
const CARD_TOAST_CONFIRM_MS = 1_500;
/**
 * 子会话归档的节流写窗口（毫秒）。
 *
 * 只有「展示性字段变了」（进度、汇报历史、时间戳）时才走这条节流路径；终态、
 * 改动去向、归档归属这些关键变化一律立刻写。800ms 足够把一串进度帧合成一次
 * 写，又短到不会让「重启后记录丢了」有可感知的窗口。
 */
const SUPER_ARCHIVE_THROTTLE_MS = 800;
/**
 * Size cap for the approval card's diff preview (per side). The wire diff is
 * the tool's FULL old/new text — a whole-file rewrite of a large file would
 * otherwise ride every snapshot push. Same 256KB discipline as the MCP diff
 * synthesis cap; over the cap the card degrades to the title-only form.
 */
const APPROVAL_DIFF_PREVIEW_MAX_CHARS = 256 * 1024;
/**
 * Post-rejection liveness window (user-reported 2026-10-06: "审批超时自动拒绝
 * 之后就一直卡在正在生成"). After a timeout auto-reject the CLI continues the
 * turn with a FRESH model request; a wedged gateway can leave that request
 * hanging with zero `session/update` events forever — the host prompt has no
 * timeout by design (pitfall #13) and the CLI's SSE has none either, so the
 * panel strands on "generating" with no escape. Wire repro (real CLI, 8s/2min/
 * 5min delayed-cancelled responses) shows the healthy path settles in seconds,
 * so total silence past this window after a rejection means the turn is dead:
 * cancel it and surface the error so the composer unlocks.
 */
const POST_REJECTION_IDLE_MS = 120_000;
/** Cap for discardedSessionIds (hot re-auth abandons at most one session per
 * profile switch; the cap only guards pathological unbounded growth). */
const DISCARDED_SESSION_IDS_CAP = 8;
/**
 * Outcome of one restore attempt — the settle handle resolves with it so a
 * 新会话 request that interrupted the restore can word its notice truthfully
 * ("已取消…" vs "恢复完成后将自动新建会话").
 */
type RestoreOutcome = "aborted" | "completed" | "failed";
/** Cap for abandonedRestoreSessionIds (one entry per abandoned restore). */
const ABANDONED_RESTORE_IDS_CAP = 8;
/** A promise whose resolver is captured for later (settle handles). */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
/** Hard cap on how long the @iflow participant waits for a prompt to finish
 * (P3). The wait loop ends on idle/error/cancel; this timeout is the last
 * resort if none of those ever fire. */
const CHAT_FORWARD_TIMEOUT_MS = 10 * 60_000;
/** R3: stderr lines kept for crash/hang diagnostics. */
const STDERR_TAIL_LINES = 200;
/** Escalating backoff before each automatic retry of a rate-limited prompt
 * (one entry per retry, capped at the last). Platform rate-limit windows
 * routinely outlive a single 5s wait: with the old one-shot retry the second
 * attempt failed too and the turn landed on the error banner with no further
 * recovery — user-visible as "没有触发自动重试" (reported 2026-09-10). */
const RATE_LIMIT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
/** Retries for transient mid-stream connection drops (undici "terminated"
 * etc. — see isTransientStreamError). Shorter ladder than rate limits: a
 * dropped stream is a one-off socket death, not a quota window, so two quick
 * retries cover the overwhelming majority without stalling a genuinely dead
 * network for minutes. */
const TRANSIENT_STREAM_RETRY_DELAYS_MS = [3_000, 10_000];
/** Retries for an EMPTY model response: the gateway answers 200 with no
 * content, the CLI records an empty model turn and returns `end_turn` with
 * zero output (verified in `~/.iflow/acp/sessions/*.json` — the stuck sessions
 * carry runs of `{"role":"model","parts":[]}` entries, one per user retry).
 * The panel would otherwise show the user bubble with nothing after it and no
 * error — the "会话莫名中断、发消息没反应，切 API 配置才恢复" report (the
 * profile switch rotates the endpoint/gateway, which is why it "fixes" it).
 * Transient in most cases (a session recovers on its own minutes later), so
 * retry with a short ladder before surfacing the error. */
const EMPTY_RESPONSE_RETRY_DELAYS_MS = [3_000, 8_000];
/** M1 P1-5/P0-7: hard ceiling for an INTERNAL prompt (enhance / AI title).
 * Unlike a user turn (no timeout by design, pitfall #13) these are
 * fire-and-forget conveniences — a wedged gateway must not hold their
 * internal session open forever; on timeout we cancel and give up silently.
 * Third-wave revision (gateway-probed 2026-10-09): 60s was too tight for
 * slow gateways — tencent/hy3 via Y-API spent 60-75s in reasoning before the
 * first content chunk (and CLI-internal rate-limit backoff pauses the update
 * stream with the wall clock still running), so the ceiling killed turns
 * whose enhanced text was in fact being produced. 180s + the idle abort
 * below covers slow-but-progressing turns while still reaping wedged ones. */
const INTERNAL_PROMPT_TIMEOUT_MS = 180_000;
/** Turn-end memory extraction is a small JSON task; shorter ceilings keep it
 * from competing with the user's next turn on a slow gateway. */
const MEMORY_EXTRACT_TIMEOUT_MS = 90_000;
const MEMORY_EXTRACT_IDLE_MS = 45_000;
/** Knowledge index generation summarizes a whole workspace; allow a longer
 * turn while still bounding a wedged gateway. */
const KNOWLEDGE_PROMPT_TIMEOUT_MS = 180_000;
const KNOWLEDGE_PROMPT_IDLE_MS = 90_000;
/** F4 asset generation: a user-initiated single-file draft (frontmatter +
 * body). Longer than memory extraction because a skill/agent body can run to
 * a page, still tight enough that a wedged gateway cannot hold the dialog. */
const ASSET_GEN_TIMEOUT_MS = 120_000;
const ASSET_GEN_IDLE_MS = 60_000;
/** 「联网补充模型数据」: one host-side search sweep (one query per model id
 * plus two market-wide ones) followed by ONE plain completion that extracts
 * the metadata from the retrieved snippets. No CLI agent session: an agent
 * turn drags in the whole system prompt + project memory + tool schemas
 * (measured 2026-10-23: 56,287 input tokens for a trivial prompt) and the
 * bundled CLI exposes no web-search tool for third-party gateway keys anyway. */
const MODEL_METADATA_SEARCH_TIMEOUT_MS = 8_000;
/** Wall-clock ceiling for the whole search sweep. */
const MODEL_METADATA_SEARCH_PHASE_MS = 60_000;
/** Extraction ceilings: the model reads the fetched pages, so it needs more
 * wall-clock than a one-line rewrite (measured: ~95s on a slow gateway for a
 * 15k-token source set). */
const MODEL_METADATA_TIMEOUT_MS = 240_000;
const MODEL_METADATA_IDLE_MS = 120_000;
/** Concurrent search requests (a profile with a dozen models would otherwise
 * fire a dozen requests at once and trip the engine's rate limit). */
const MODEL_METADATA_SEARCH_CONCURRENCY = 4;
/** Hits kept per query. */
const MODEL_METADATA_HITS_PER_QUERY = 6;
/** Total characters of source text handed to the model — the page bodies are
 * read by the model itself (it does the extraction), so this budget is the
 * dominant cost of the flow. Measured on a slow gateway: 20k tokens → 140s,
 * ~6k tokens → well inside the ceiling. Raised from 30k after a real run
 * (2026-10-23) showed two fetched pages + duplicate snippets carried no
 * figures at all: the official pricing table is the only source of numbers,
 * so the budget has to fit several real pages. */
const MODEL_METADATA_SOURCE_CHARS = 48_000;
/** Result pages fetched per sweep — the pricing/context tables live in the
 * page body, not in the search snippet. Four covers the official docs page
 * plus the comparison sites that usually rank next to it. */
const MODEL_METADATA_PAGES = 4;
/** Characters kept per fetched page. */
const MODEL_METADATA_PAGE_CHARS = 8_000;
/** Search hits whose snippet is handed to the model, and the per-snippet
 * character cap — the result TITLE carries most of the signal ("GLM-5 …
 * 200K上下文"), the snippet tail is mostly boilerplate. */
const MODEL_METADATA_SNIPPET_HITS = 40;
const MODEL_METADATA_SNIPPET_CHARS = 200;
/** Abort an internal prompt whose session stream went silent for this long.
 * A healthy stream emits chunks every few seconds; the CLI's rate-limit
 * backoff pauses were observed well under this. Catches a mid-stream wedge
 * without waiting out the full wall-clock ceiling. */
const INTERNAL_PROMPT_IDLE_MS = 90_000;
/**
 * Super Agent heartbeat interval.
 *
 * Once the main session's turn is over it is IDLE while its children keep
 * working — nothing in the ACP protocol will wake it again. The host therefore
 * keeps a heartbeat alive for as long as there is unfinished Super Agent work:
 * it refreshes the 「waiting for children」 pill and retries delivery of the
 * consolidated child report (and any queued agent-merge request) the moment the
 * main session is free. This is what makes the overall flow uninterrupted:
 * a finished delegation always comes back as a new main-session turn, even if
 * that turn's trigger raced a replay / a streaming turn / an error.
 */
const SUPER_HEARTBEAT_MS = 1_500;
/**
 * Tools the MAIN panel session must never receive.
 *
 * The user directive is that the main session only DELEGATES: it plans, writes
 * task briefs, watches the board and reports — every implementation step AND
 * every investigation (reading files, searching code, running commands) belongs
 * to a Super Agent child session. The system prompt already says so, but the
 * model kept calling `task`, `read_file` and `run_shell_command` in the main
 * session (2026-11-15 / 2026-11-16 user reports), so the constraint is now
 * mechanical instead of advisory.
 *
 * Wire behavior (verified against the vendored CLI bundle,
 * vendor/iflow-cli/bundle/iflow.js):
 *  - `session/new` / `session/load` map the request's `settings.disallowed_tools`
 *    onto the Config's `excludeTools`
 *    (`u = {...this.settings.merged, ..., excludeTools: o?.disallowed_tools, ...}`);
 *    `loadSession` builds its config through the same `newSessionConfig(...,
 *    settings)`, and its not-found fallback calls `newSession` (settings
 *    forwarded too).
 *  - `Config.createToolRegistry()`'s registrar
 *    (`t = (r, ...n) => { let s = r.name, a = r.Name || s, l = this.getExcludeTools(), ...;
 *    (l?.includes(s) || l?.includes(a)) && (u = !1); u && register }`) skips
 *    registration when `excludeTools` matches either the static `Name` or the
 *    class name.
 *
 * Provenance of the names below (scanned 2026-11-16 across
 * vendor/iflow-fork/bundle/iflow.js). Each one is a `static Name = "<name>"` in
 * the bundle, but "declared" is not "registered" — this comment must not claim
 * a tool is withheld when the registrar never creates it:
 *  - registered by `createToolRegistry()`'s `t(...)` calls: read_file (L1246),
 *    read_many_files (L1453), glob (L1323), search_file_content (L1259,
 *    L1317), list_directory (L950), image_read (L1247), web_fetch (L2153,
 *    L2466), web_search (L2108, L4131), ReadCommandOutput (L2444),
 *    write_file (L1452), replace (L1631, L4335), xml_escape (L4256),
 *    run_shell_command (L1719), task (L4138)
 *  - `lsp_goto_definition` / `lsp_find_references` / `lsp_hover` (L4417 /
 *    L4421 / L4425): conditionally registered — the registration site is
 *    `this.lspManager && (t(Vut, this, this.lspManager), t(Wut, ...),
 *    t(zut, ...))`. `lspManager` is constructed unconditionally in the Config
 *    constructor (`this.lspManager = new H0e(this.getProjectRoot())`), so in
 *    practice the three are always registered; the guard is still real, so they
 *    are described as conditional rather than unconditional.
 *  - `multi_edit` (L3160): declared but NOT registered in this bundle version —
 *    its class `Aut` is never passed to `t(...)` inside `createToolRegistry()`
 *    (its only other reference is `Aut.Name` in a write-tool detector at
 *    L3222). This entry is therefore a silent no-op today; it is kept
 *    deliberately as a defensive one, so that a future CLI version which does
 *    register `multi_edit` is gated automatically. Do not read it as proof that
 *    the tool is currently being withheld.
 * Names that do NOT exist in the bundle are deliberately absent — `"grep"` and
 * `"ls"` are not registered tool names (the search/list tools are
 * `search_file_content` / `list_directory`), so listing them would be a silent
 * no-op as well.
 *
 * Kept available on purpose: `todo_write` / `todo_read` (the orchestrator's own
 * planning), `ask_user_question` (requirements), and the `super-agent` tool
 * itself — it is the dispatch channel and is registered by the loader
 * (`super-agent-loader.cjs`, `static Name = "super-agent"`), not by the bundle.
 *
 * The exclusion is per session: child sessions (SuperAgentManager) deliberately
 * do NOT pass settings and therefore keep every tool — the main session hands
 * both the implementation and the investigation down to them.
 *
 * Side effect (deliberate, not hidden): the `@iflow` chat participant and
 * `iflow.askSelection` reuse this panel session, so they lose file reads and
 * shell commands too; slash commands that need to inspect the workspace (e.g.
 * `/init`) likewise have to be delegated.
 */
export const MAIN_SESSION_DISALLOWED_TOOLS = [
  // in-process sub-agents — the main session delegates to Super Agent children
  "task",
  // reading / exploring
  "read_file",
  "read_many_files",
  "glob",
  "search_file_content",
  "list_directory",
  "image_read",
  "web_fetch",
  "web_search",
  "ReadCommandOutput",
  "lsp_goto_definition",
  "lsp_find_references",
  "lsp_hover",
  // writing
  "write_file",
  "replace",
  // defensive: declared at L3160 but not registered in this bundle version
  // (class `Aut` is never passed to `t(...)`); kept for future CLI versions
  "multi_edit",
  "xml_escape",
  // executing
  "run_shell_command",
] as const;
/** Fresh settings object for one main-session `session/new` / `session/load`.
 * A factory (not a shared object) so no caller can mutate another's copy. */
export function mainSessionSettings(): SessionSettings {
  return { disallowed_tools: [...MAIN_SESSION_DISALLOWED_TOOLS] };
}
/** Next-step prediction: another fire-and-forget internal prompt, but with a
 * much tighter budget. The user turn already settled, so a slow gateway only
 * delays the chips — it must never hold the panel in a pseudo-busy state.
 * 25s ceiling / 12s idle keeps the extra call cheap and bounded. */
const NEXT_STEP_TIMEOUT_MS = 25_000;
const NEXT_STEP_IDLE_MS = 12_000;
/** Hard cap on rendered candidates — more than three chips starts competing
 * with the composer itself for attention. */
const NEXT_STEP_MAX_SUGGESTIONS = 3;
/** Per-side transcript budget fed to the predictor (user request / assistant
 * reply). Keep the call small: this is a next-action guess, not a summary. */
const NEXT_STEP_EXCERPT_CHARS = 6_000;
/** First user request fed to the title task — enough to name the topic, short
 * enough that a long pasted dump cannot inflate the merged prompt. */
const TITLE_REQUEST_MAX_CHARS = 2_000;
/** Per-task ceilings for the merged turn-end request. The request runs with
 * the LOOSEST ceiling among the tasks it actually carries: a title-only call
 * keeps the 180s window, a next-step-only call stays at 25s, and a batch that
 * includes memory extraction gets memory's 90s window.
 *
 * `timeoutMs` is the built-in DEFAULT for the nextSteps/memory tasks — the
 * live values come from `iflow.nextStepTimeoutSeconds` /
 * `iflow.memoryExtractTimeoutSeconds` (read in followupCeiling, 0 = 不限制).
 * `idleMs` stays the per-task idle window. */
const FOLLOWUP_CEILINGS: Record<FollowupTaskKind, { timeoutMs: number; idleMs: number }> = {
  title: { timeoutMs: INTERNAL_PROMPT_TIMEOUT_MS, idleMs: INTERNAL_PROMPT_IDLE_MS },
  nextSteps: { timeoutMs: NEXT_STEP_TIMEOUT_MS, idleMs: NEXT_STEP_IDLE_MS },
  memory: { timeoutMs: MEMORY_EXTRACT_TIMEOUT_MS, idleMs: MEMORY_EXTRACT_IDLE_MS },
};
/**
 * Neutralise `@path` file references in an internal-prompt draft (enhance /
 * AI title) by dropping the `@` and keeping the path text (user-reported
 * 2026-10-09, gateway-probed). Enhancement is a pure text rewrite — the file
 * content is irrelevant, and a reference is the documented agentic-drift
 * trigger (pitfall #26); on thinking models the `@` additionally invites a
 * "should I read the file first" reasoning loop that never converges
 * (tencent/hy3 streamed `reasoning_content` for 150s+ without ever emitting
 * content or finish_reason on "@docs/…md 开始实施M2"). The bare path converges
 * in 33s, and a bracketed placeholder does NOT (probed) — so the fix is to
 * drop the `@` marker itself while keeping the path words, preserving the
 * draft's meaning. Only word-initial `@`-tokens that look like paths (a
 * slash, or a file extension) are touched — emails like user@example.com and
 * @word mentions survive.
 */
export function stripFileMentions(text: string): string {
  return text.replace(
    /(^|[\s(（【“"'])@((?:[^\s()（）【】“”"'`，。；]*[/\\][^\s()（）【】“”"'`，。；]*|[^\s()（）【】“”"'`，。；]+\.[A-Za-z]{2,8}))(?=$|[\s)）】”"',。；;:!?])/g,
    "$1$2",
  );
}
/** OS toast text must stay ONE short line: `run_shell_command` titles carry
 * the WHOLE command — a 40-line python script flooded the native approval
 * toast verbatim (user report 2026-10-13). Collapse every whitespace run
 * (newlines included) to a single space and cap the length; the approval
 * CARD keeps the full text (that is where the command is reviewed), only
 * the toast gets the summary. */
function notifySummary(raw: string, max = 80): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
/**
 * Last two labels of an endpoint host (`https://api.deepseek.com/v1` →
 * `deepseek.com`), used to rank the vendor's own documentation above
 * third-party comparison pages. Returns "" for an unparseable URL — callers
 * treat that as "no affinity signal".
 */
function registrableHost(baseUrl: string | undefined): string {
  if (!baseUrl) return "";
  try {
    const host = new URL(baseUrl.includes("://") ? baseUrl : `https://${baseUrl}`).hostname.toLowerCase().replace(/^www\./, "");
    const parts = host.split(".").filter(Boolean);
    if (parts.length < 2) return host;
    const take = /^(com|net|org|gov|edu|ac)\.cn$/.test(parts.slice(-2).join(".")) && parts.length >= 3 ? 3 : 2;
    return parts.slice(-take).join(".");
  } catch {
    return "";
  }
}
/** M1 P0-6: occupancy ratio at which the context-warning pill fires
 * (≥100% is handled by the existing overflow auto-compress path). */
const CONTEXT_WARN_RATIO = 0.9;
/** M1 P0-6: hysteresis floor — the warning pill only clears below this ratio,
 * so a ratio jittering around 90% doesn't flap the pill on and off. */
const CONTEXT_WARN_EXIT_RATIO = 0.85;
/** Turn-end auto-compress threshold (see maybeAutoCompressOnIdle). Sits above
 * CONTEXT_WARN_RATIO so the user gets a 90–95% manual window (the warning
 * pill's 立即压缩) before the system compresses on its own. An `estimated`
 * (guessed) window never triggers it — the 2026-10-11 hy3 report proved a
 * missing table row (32K fallback vs a real 256K window) misreports 100% and
 * would otherwise compress a perfectly healthy session every turn.
 * DEFAULT only: the live threshold comes from `iflow.autoCompressThresholdPercent`. */
const CONTEXT_AUTOCOMPRESS_RATIO = 0.95;
/** Thrown by promptWithRetry when the empty-response retry ladder is
 * exhausted. The catch chain re-throws it untouched: its user-facing wording
 * would otherwise trip the rate-limit heuristic ("稍后重试" ∈ RATE_LIMIT_RE)
 * and send the turn through another pointless retry round. */
class EmptyResponseError extends Error {}
/** Thrown when a `/compress` turn blows the user-configured ceiling
 * (`iflow.compressTimeoutSeconds`). The JSON-RPC request was abandoned but
 * the CLI turn keeps running, so the throw site cancels it first; the
 * compress call sites turn this into a warning toast instead of the generic
 * 「压缩失败」 wording. */
class CompressTimeoutError extends Error {
  constructor(readonly seconds: number) {
    super(vscode.l10n.t("压缩超时（超过 {0} 秒），已取消压缩。", seconds));
  }
}
/** Cap on base64 payload of an openImage attachment (~6MB decoded) — a
 * webview-supplied data URL is untrusted input; an oversized one must be
 * rejected before it is materialized to disk. */
const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
/** Picked images above this size fall back to plain file attachments. */
const ATTACHMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Extension → MIME for picked images (the picker gives no MIME type). */
const IMAGE_MIME_BY_EXT = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".svg", "image/svg+xml"],
]);

/** 路径比较键（Windows 文件系统大小写不敏感）。 */
function normalizePathKey(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Reusable abortable delay: resolves after `ms`, or early once
 * `shouldAbort()` returns true (polled every 100ms — plenty for a 5s wait). */
function abortableDelay(ms: number, shouldAbort: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const tick = 100;
    let waited = 0;
    const timer = setInterval(() => {
      waited += tick;
      if (shouldAbort() || waited >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, tick);
  });
}

/** workspaceState key: recent sessions for this workspace (M4). */
const SESSIONS_KEY = "iflow.recentSessions";
/** workspaceState key: session id to restore on panel open (M4). */
const ACTIVE_SESSION_KEY = "iflow.activeSessionId";
/** workspaceState key: the API profile this workspace last activated. The
 * SecretStorage active-profile pointer is global (shared across windows), so
 * multi-workspace users kept losing their per-project config on restart —
 * this per-workspace record restores it. Name only; credentials stay in
 * SecretStorage / CLI settings.json. */
const WORKSPACE_PROFILE_KEY = "iflow.workspaceActiveProfile";
/** workspaceState key: the last model selected in this workspace. */
const WORKSPACE_MODEL_KEY = "iflow.workspaceActiveModel";
/** workspaceState key: first-run wizard skipped/finished (never auto-open it
 * again in this workspace once true). */
const ONBOARDING_DISMISSED_KEY = "iflow.onboardingDismissed";
/** globalState key: cross-window cache of the resolved node runtime
 * (the CLI entry is no longer probed — the vendored fork is the only one). */
const LOCATOR_PATHS_KEY = "iflow.locator.paths";
/** M4 P1-1 globalState key: the serialized global approval pre-review rule
 * table (`{version, rules}` — see shared/approval-policy.ts). */
const APPROVAL_POLICY_KEY = "iflow.approvalPolicy";
/** M4 P1-1: workspace-relative project override, matched BEFORE the global
 * table so a repo can tighten (or loosen, within the hard-veto floor) the
 * user's rules. Read-only from the panel's side — never written back. */
const APPROVAL_POLICY_PROJECT_FILE = ".iflow/approval.json";
/** `iflow.uiFontSize` presets — kept in sync with shared/messages.ts. */
const UI_FONT_SIZES = ["compact", "standard", "large"] as const;
/** `iflow.uiDensity` presets — kept in sync with shared/messages.ts. */
const UI_DENSITIES = ["compact", "standard", "comfortable"] as const;

/** settings.json is user-editable — fall back to the default on a stale value. */
function asUiFontSize(value: unknown): (typeof UI_FONT_SIZES)[number] {
  return UI_FONT_SIZES.includes(value as (typeof UI_FONT_SIZES)[number])
    ? (value as (typeof UI_FONT_SIZES)[number])
    : "standard";
}

function asUiDensity(value: unknown): (typeof UI_DENSITIES)[number] {
  return UI_DENSITIES.includes(value as (typeof UI_DENSITIES)[number])
    ? (value as (typeof UI_DENSITIES)[number])
    : "standard";
}

/** `iflow.defaultMode` values — kept in sync with shared/messages.ts. */
const DEFAULT_MODES = ["default", "smart", "yolo", "plan"] as const;

/** settings.json / VSCode config is user-editable — fall back to `smart`. */
function asDefaultMode(value: unknown): (typeof DEFAULT_MODES)[number] {
  return DEFAULT_MODES.includes(value as (typeof DEFAULT_MODES)[number])
    ? (value as (typeof DEFAULT_MODES)[number])
    : "smart";
}

/** `iflow.theme` values — kept in sync with shared/messages.ts. */
const UI_THEMES = ["auto", "light", "dark"] as const;
function asUiTheme(value: unknown): (typeof UI_THEMES)[number] {
  return UI_THEMES.includes(value as (typeof UI_THEMES)[number])
    ? (value as (typeof UI_THEMES)[number])
    : "auto";
}

/** `iflow.osNotifications` values. */
const OS_NOTIFICATION_MODES = ["off", "approvals", "all"] as const;
function asOsNotifications(value: unknown): (typeof OS_NOTIFICATION_MODES)[number] {
  return OS_NOTIFICATION_MODES.includes(value as (typeof OS_NOTIFICATION_MODES)[number])
    ? (value as (typeof OS_NOTIFICATION_MODES)[number])
    : "approvals";
}

/** `iflow.language` values; empty = do not override the CLI's own value. */
const CLI_LANGUAGES = ["", "zh-CN", "en-US"] as const;
function asCliLanguage(value: unknown): (typeof CLI_LANGUAGES)[number] {
  return CLI_LANGUAGES.includes(value as (typeof CLI_LANGUAGES)[number])
    ? (value as (typeof CLI_LANGUAGES)[number])
    : "";
}

/** `iflow.approvalMode` values; empty = do not override the CLI's own value. */
const CLI_APPROVAL_MODES = ["", ...DEFAULT_MODES] as const;
function asCliApprovalMode(value: unknown): (typeof CLI_APPROVAL_MODES)[number] {
  return CLI_APPROVAL_MODES.includes(value as (typeof CLI_APPROVAL_MODES)[number])
    ? (value as (typeof CLI_APPROVAL_MODES)[number])
    : "";
}

/** Cap on the per-workspace recent-session list. */
const MAX_RECENT_SESSIONS = 20;
/** Label until the first user prompt names the session. */
const DEFAULT_SESSION_LABEL = vscode.l10n.t("（无标题会话）");
/** Legacy workspaceState key: transcripts used to live in one monolithic map
 * here (P2 — every persist meant read-all + structuredClone + write-all, and
 * the map grew without bound). Transcripts now persist as per-session JSON
 * files under storageUri; this key survives only as the one-shot migration
 * source and is deleted after migration. */
const TRANSCRIPTS_KEY = "iflow.transcripts";

/** Persisted transcript payload for one session. */
interface PersistedTranscript {
  label: string;
  blocks: SessionState["blocks"];
}

/** Structural shape of a vscode.FileSystemWatcher (the test stub has none). */
interface PanelWatcher {
  dispose: () => void;
  onDidCreate: (listener: () => void) => vscode.Disposable;
  onDidChange: (listener: () => void) => vscode.Disposable;
  onDidDelete: (listener: () => void) => vscode.Disposable;
}

export interface PanelServices {
  entryOverride?: string | undefined;
  /** Test hook: workspace root used by ensureClient (else workspaceFolders[0]). */
  workspaceRoot?: string | undefined;
  /**
   * Test hook: when set, the vscode file-system watchers are NOT created
   * (the stub has no watcher API) and these are used instead.
   */
  watchers?: PanelWatcher[] | undefined;
  /**
   * Test hook: overrides the OS-notification transport (default: sendOsNotification
   * spawning the vendored toast binaries). Injected so tests stay hermetic —
   * the real path would pop a system toast on the machine running the suite.
   */
  osNotify?: (title: string, message: string) => Promise<boolean>;
  /** Test hook: QQ 设置 / SecretStorage 的注入式 IO（缺省走 vscode 实现）。 */
  qqSettingsIo?: QqSettingsIo;
  /**
   * Test hook: QQBot 官方路线的可注入依赖（真网络 / 二维码渲染 / adapter）。
   * 缺省走 node:https + node:crypto + 内联 QR PNG + 真 QqBotAdapter。
   */
  qqbotDeps?: {
    bind?: QqBotBindRuntimeDeps;
    transport?: QqChannelDispatchDeps["transport"];
    adapterFactory?: QqChannelDispatchDeps["adapterFactory"];
    gatewayUrl?: string;
  };
}

/**
 * Review A3: thrown when an operation resumes after the panel was disposed.
 * The handshake's post-connect steps and the session/prompt entry points check
 * it at their checkpoints so a destroyed store is never touched again.
 */
/**
 * QQ 通道单项收尾上限：关面板不能被一个卡住的 adapter/socket 拖死。
 * （通道重启上限与退避阶梯已随收敛移除。）
 */
const QQ_BRIDGE_STOP_TIMEOUT_MS = 2_000;
/** 设置改动 → 重启 QQ 服务的防抖窗口（settings.json 一次编辑会触发多帧）。 */
const QQ_SETTINGS_RESTART_DEBOUNCE_MS = 500;

export class DisposedError extends Error {
  constructor(message = "panel disposed") {
    super(message);
    this.name = "DisposedError";
  }
}

export class ChatPanel implements vscode.Disposable {
  public static readonly viewId = "iflow.chatPanel";

  private editorPanel: vscode.WebviewPanel | undefined;
  private client: AcpClient | null = null;
  /** One-shot guard for copying SecretStorage-only profiles into the kernel
   * settings.json (the migration itself is idempotent; this only keeps the
   * per-snapshot auth build from re-reading/re-writing the file). */
  private authProfilesMigrated = false;
  private store: SessionStore;
  /** F3 Phase 1: global/project memory files (read/edit, not the CLI agent). */
  private readonly memory: MemoryService;
  private readonly assets: AssetsService;
  private connecting: Promise<void> | null = null;
  /**
   * Handshake generation counter (P0-3 restart escape). restartCli bumps it
   * before spawning a replacement CLI, so a wedged handshake being torn down
   * recognises itself as superseded: its catch/finally then skip every shared
   * -state mutation (store error, this.client, restartRestoreId, clearing
   * `connecting`) that would otherwise clobber the successor's fresh
   * handshake running concurrently.
   */
  private connectGeneration = 0;
  private disposed = false;
  /** Diagnostics trail visible in the Output panel (helps locate connect issues). */
  private readonly log: vscode.LogOutputChannel;
  /** M5: agent status at a glance (idle / streaming / approval / error + model).
   * Its tooltip doubles as the session-info entry for usage: the composer's
   * model chip only carries the compact occupancy bar, so the full breakdown
   * (context / split / cache / cost) lives here, one hover away. */
  private readonly statusBar: vscode.StatusBarItem;
  /** Last rendered tooltip text — the status bar is refreshed on every state
   * push, and rebuilding the Markdown for identical numbers is pure churn. */
  private statusBarTooltipText = "";
  /** cwd the current ACP session was created with (base for relative paths). */
  private sessionCwd: string | null = null;
  /**
   * Super Agent — the orchestrator for child sessions spawned by the MAIN
   * session. Each child runs its own CLI process inside its own git worktree,
   * so several of them can touch the same project without colliding. Created
   * lazily (the first delegation pays the setup cost).
   */
  private superAgent: SuperAgentManager | null = null;
  /**
   * QQ 远程任务通道的运行期现场（QQBot 单一路径）。
   *
   * 现场 = QqService + 任务落盘 + 启动时的配置快照 + 设置 IO + 官方 adapter
   * （+ 一次性配对码）。它是**唯一**的「通道是否在跑」判据 —— 所有入口都以
   * `this.qq` 是否存在为闸门，没有任何入口能在半初始化状态下继续。
   *
   * `config` 与 QqService 内部持有的是**同一个对象**：非连接类字段（白名单 /
   * 策略 / 并发 / 限流 / 详略 / 自动合并）由面板就地热更新，改完即时生效。
   * 历史遗留的 IPC / bridge / 托管 manager / 二维码轮询桥字段已随收敛移除。
   */
  private qq?: {
    service: QqService;
    store: QqTaskStore;
    config: QqConfig;
    io: QqSettingsIo;
    bindCode?: { code: string; expiresAt: number };
    /** QQBot 官方路线：不 spawn bridge，直接持有 adapter + 扫码会话。 */
    qqbot: {
      adapter: QqBotAdapterLike;
      /** 扫码会话在绑定成功后即停并清空，只在绑定进行中短驻留。 */
      bindSession?: { stop(): void };
    };
  };
  /** 主动停止中：防止与在飞的启停重叠。 */
  private qqStopping = false;
  /** 最近一次推给 webview 的连接状态（用于「面板重新打开时」的立即回显）。 */
  private qqConnected = false;
  private qqLastDetail: string | null = null;
  /** 设置变更 → 重启服务的防抖定时器。 */
  private qqRestartTimer: ReturnType<typeof setTimeout> | null = null;
  /** 进行中的启动（并发调用 startQqIfEnabled 时共享同一份工作）。 */
  private qqStarting: Promise<void> | null = null;
  /**
   * QQBot 官方扫码会话：绑定进行中短驻留，成功/失败/stop 后立即清空。
   * 独立于 `this.qq`（扫码时尚无服务现场），避免把半绑定现场塞进主通道。
   */
  private qqbotBinding: { stop(): void } | null = null;
  /**
   * 启动代次：`stopQq` 每次递增。异步启动在关键节点复核它 —— 启动途中被
   * 停用 / 重启时，慢半拍的那个启动必须把自己造出来的现场拆掉，而不是把
   * 一份陈旧通道装回 `this.qq`。
   */
  private qqGeneration = 0;
  /**
   * 待「让智能体合并」的子会话队列。
   *
   * 自动集成没能把改动带回主分支时，宿主自动把子会话排进来（不再等用户点
   * 看板上的按钮）；主会话正忙时留在队列里，等它空闲后**串行**派发合并
   * 子会话 —— 合并必须发生在主工作区里，并发合并同一个仓库会把状态搅乱。
   */
  private pendingSuperMerges: Array<{ id: string; reason: string }> = [];
  /** 合并队列正在跑（drain 的重入锁）。 */
  private superMergeRunning = false;
  /**
   * Rolling buffer of the MAIN session's assistant text, scanned for
   * delegation directives (`super-agent` fenced blocks). Scanned per chunk,
   * so a delegation takes effect mid-turn — the main session can open child
   * sessions at any time, not only at turn end.
   *
   * 扫描器自带**有界缓冲**：扫完就把死区（已经消费、已经扫过且不会再产出
   * 指令的前缀）丢掉，只留下「未消费的部分 + 尾巴保护 + 正在写的围栏」。
   * 宿主自己攒字符串的话缓冲会随会话长度线性增长（长会话几百 KB 起，每来
   * 一个 chunk 还要把整段重扫一遍）—— 公开的 `extractSuperDirectives` 不吐
   * 死区位置，宿主无从裁剪，只有扫描器内部知道哪些前缀可以安全丢掉。
   */
  private readonly superScan = new SuperDirectiveScanner();
  /**
   * 本主会话已派发过的委派载荷指纹（`superDirectiveDedupeKey` 的 SHA-256 摘要）。
   *
   * 同一份载荷在正文通道里被重复写出时只派发一次 —— 否则会开出重复的
   * 子会话（双倍 token、两张看板卡）。换会话 / 恢复会话 / 热重认证时清空：
   * 新会话可以重新派发同样的任务。
   *
   * **有界**：载荷数量不设界，账本必须有上限（见
   * {@link SUPER_DISPATCHED_DIRECTIVES_CAP}），否则长时间运行的会话会一直涨；
   * 每条只存 32 个 hex 字符的摘要（原始键会带上附件的 base64 内联数据，
   * 单条可达 MB 级）。
   */
  private readonly superDispatchedDirectives = new Set<string>();
  /** {@link superDispatchedDirectives} 的容量上限（同 `superToolCallActionsDone` 的做法）。 */
  private static readonly SUPER_DISPATCHED_DIRECTIVES_CAP = 100;
  /**
   * 已为「名字命中但载荷取不出来」的结构化工具调用弹过提示的 toolCallId。
   *
   * 模型把派发写成 `super-agent` / `super-agent-actions` 工具调用时，内核
   * registry 里根本没有这两个工具 —— 旧实现既不执行也不提示，用户以为已经
   * 派了。兜底解析失败要留痕，但同一条工具帧会在 pending / in_progress /
   * completed 之间来回推，按 toolCallId 去重才不会刷屏。集合有上限（超了丢
   * 最早一条），换会话 / 恢复会话 / 热重认证时清空。
   */
  private readonly superToolCallWarned = new Set<string>();
  /** {@link superToolCallWarned} 的容量上限（工具帧数量不设界，Set 必须有界）。 */
  private static readonly SUPER_TOOL_CALL_WARN_CAP = 100;
  /**
   * 已执行过管理动作的结构化工具调用（`toolCallId` + 载荷指纹）。
   *
   * 派发侧有 `superDispatchedDirectives` 载荷账本兜底，动作侧没有 —— 同一条
   * 工具帧在 pending / in_progress 两帧各带一次载荷时，`cancel` 靠管理器幂等
   * 不会出大事，但 `cleanup` / `retry` 的第二次会报「未生效」（假失败），
   * `cleanup` 甚至可能并发操作同一个 worktree。按「工具调用 + 载荷」去重：
   * 同一次调用只执行一次，不同调用即使载荷相同也各自执行（那是模型的真实
   * 意图，不能吞）。集合有上限，换会话时清空。
   */
  private readonly superToolCallActionsDone = new Set<string>();
  /** {@link superToolCallActionsDone} 的容量上限。 */
  private static readonly SUPER_TOOL_CALL_ACTIONS_CAP = 100;
  /**
   * Rolling buffer of the same MAIN-session text, scanned for management
   * actions (`super-agent-actions` fenced blocks). Kept separate from the
   * delegation buffer: the two protocols have independent fences and
   * independent consume offsets, so one can never swallow the other.
   */
  private superActionScanText = "";
  /** How much of `superActionScanText` has already been executed. */
  private superActionScanOffset = 0;
  /**
   * 本轮还有一个动作围栏停在「未闭合」状态（围栏开了没收）。
   *
   * 流式期间这是正常中间态（载荷可能下一帧才到），所以不在每帧报警；
   * 但**回合都结束了还停在这里**，说明这个动作块永远不会被执行 ——
   * 旧实现对此完全静默（零日志、零 toast），故障只能靠用户复述「我发过啊」。
   * 回合收尾时用它复核并留痕（见 `auditSuperActionsAtSettle`）。
   */
  private superActionPending = false;
  /** 未闭合围栏里那段没收完的正文（日志用，别让痕迹变成一句空话）。 */
  private superActionPendingBody = "";
  /**
   * 最后一条已排队的动作回执文本（去重）。
   *
   * 回执是投给主会话的一次 hidden prompt；同一份回执重复排队会让主会话
   * 反复收到一模一样的「已生效」，白白多跑几轮。
   */
  private superActionReceiptLast = "";
  /**
   * 「扫到围栏却零动作」的告警是否已经记过（去重）。
   *
   * 这条通道每来一段文本都会扫一次，不去重就是同一个问题刷一屏日志。
   */
  private superActionZeroWarned = false;
  /**
   * 子会话汇报的缓冲：**逐个即时交付** —— 某个子会话一进入终态，它的汇报
   * 就被取走交给主会话（不必等同一批全部结束）。同一子会话只保留最后一条
   * （blocked → ready 之类的中途状态不重复转述），中途进展只更新看板。
   *
   * **按归属主会话分桶**：汇报是投给某个主会话的一次真实 prompt，别人家
   * 子会话的汇报投进当前会话就是串台（模型会读到不属于自己的孩子，转录
   * 里也会冒出别的会话的结论）。分桶之后，B 的子会话收尾时它的汇报留在
   * B 那个桶里等用户切过去。
   */
  private readonly pendingSuperReports = new Map<string, SuperReportBuffer>();
  /**
   * 已经合并好、等着交给主会话的子会话汇报提示词（先进先出）。
   *
   * 交付方式是**主会话上的一次真实 prompt**（hidden：转录里不出现用户气泡），
   * 不是旁路直连调用 —— 只有让主会话自己读到这批结果，它才能接着推进任务，
   * 而不是把汇报折叠成一条用户看得到、智能体却不知道的系统注记。
   *
   * 每条都带**归属主会话**：排队期间用户可能切了会话，A 的汇报不能投进
   * B 的对话（投错会话 = 串台）。
   */
  private pendingSuperReportPrompts: Array<{ mainSessionId: string | null; text: string }> = [];
  /**
   * 已经执行完、等着回执给主会话的子会话管理动作（先进先出）。
   *
   * **为什么要回执**：主会话的看板摘要是**每轮开篇冻结**的 —— 同一轮里它
   * 看不到自己刚发的动作有没有生效，于是会**重复发同一个动作**（真实故障：
   * cancel 了一个早已结束的子会话，看板没变化，智能体又发一次）。
   * 回执把结果直接送回主会话的上下文，让它当场知道「这次生效了，别再发」。
   *
   * 交付方式与子会话汇报一致：**主会话上的一次 hidden prompt**（转录里不出现
   * 用户气泡），主会话空闲时才投（与汇报共用同一条车道，互斥执行）。
   * 单独记账而不混进汇报队列：「等待子会话汇报」的忙碌标记不该被一条动作
   * 回执点亮。
   */
  private pendingSuperActionReceipts: Array<{ mainSessionId: string | null; text: string }> = [];
  /** 汇报 turn 正在跑（drain 的重入锁，与合并队列互斥）。 */
  private superReportRunning = false;
  /**
   * 主会话车道（同步互斥）：同一时刻只允许**一个**回合在准备阶段。
   *
   * 「用户回合」与「hidden 汇报回合」都跑在同一个 ACP 会话上：两个回合并发
   * 会让转录顺序错乱、上下文互相污染、token 重复计费。状态位
   * （status === "streaming"）挡不住这个竞态 —— 状态要等 store.userPrompt()
   * 才翻成 streaming，而回合在翻状态**之前**还有几个 await 窗口
   * （ensureClient / assertModeForPrompt）：汇报回合正好能从那个窗口插进来。
   *
   * 车道是**同步**申领的（申领与检查之间没有 await）：谁先申领谁先跑。用户
   * 回合优先 —— 它一进 sendPrompt（那时还没有任何 await）就申领，汇报回合
   * 看到车道被占就继续排队，等本轮结束再投。状态翻成 streaming 之后车道就
   * 释放（此后状态位足以挡住第二个回合）。
   */
  private mainLane: symbol | null = null;
  /**
   * 等待子会话的心跳。
   *
   * 主会话回合结束后只剩子会话在跑时，没有任何协议事件会再次唤醒主会话；
   * 这个定时器负责 ①维持「等待 N 个子会话」的常驻提示 ②一旦主会话空闲就把
   * 排队的汇报 / 合并请求发出去。没有待办且没有活着的子会话时自动停表。
   */
  private superHeartbeatTimer: NodeJS.Timeout | null = null;
  /** 常驻「等待子会话」提示的 toast id（null = 当前没显示）。 */
  private superWaitToastId: number | null = null;
  /** 常驻提示的状态指纹：子会话进度帧高频触发，指纹不变就不重发。 */
  private superWaitToastKey: string | null = null;
  /** 「已停止 · N 项待处理」常驻带动作提示的 toast id（null = 当前没显示）。 */
  private deferredAutoTurnsToastId: number | null = null;
  /**
   * 子会话归档的节流写定时器（null = 没有待写的节流写）。
   *
   * 归档的写放大主要来自高频的进度帧：看板每变一次就整份重写一次，而进度
   * 根本不在归档里。关键变更（终态 / 改动去向 / 归属）仍然立刻写。
   */
  private superArchiveTimer: NodeJS.Timeout | null = null;
  /**
   * 上次落盘时的归档「关键内容」指纹。
   *
   * 指纹变了 = 有必须立刻落盘的变化（子会话集合 / 状态 / 集成结果 / 归属）；
   * 指纹没变 = 只有展示性字段变了，节流写即可。
   */
  private superArchiveFingerprint = "";
  /**
   * 已经把汇报交给宿主的子会话 id。
   *
   * 子会话进入终态（completed / failed / cancelled）之后，宿主还要等它把汇报
   * 交上来 —— 中间隔着宿主代提交与自动合并（git 操作，可能好几秒）。这段时间
   * 里子会话「已经终态」但汇报还没进汇报队列，所以「还在等」不能只看子会话
   * 状态：终态但没交接汇报的子会话同样算未完成。
   */
  private readonly superReportedChildIds = new Set<string>();
  /**
   * 每个子会话上一次被宿主看到的 SuperStatus（key = childId）。
   *
   * 完成提示按**子会话逐个**判定：只有「上一次非终态、这一次终态」才是真实
   * 的收尾事件。旧的聚合实现（非终态数 >0 → 0 时提示「子会话已全部结束」）
   * 把两个子会话的完成混成一次、还会在恢复归档/刚打开看板时把早已终态的
   * 事实当成新事件；按 id 记状态后：首次看到就终态 = 没有事件（不提示）、
   * 重复 sync = 状态没变（不重复提示）、子会话从 list 消失 = 清记录。
   */
  private superLastStatus = new Map<string, SuperStatus>();
  /**
   * 本轮用户消息的附件（图片 base64 + 带路径的文件）。子会话看不到对话，委派
   * 发生时若不带上它们，用户附的截图/日志会在子任务里静默消失。只在本轮流式
   * 期间有效：回合结束即清空，避免下一次派发拿到上一轮的旧附件。
   */
  private currentTurnAttachments: {
    images: { data: string; mimeType: string }[];
    files: { name: string; path: string }[];
  } | null = null;
  /**
   * 主会话 streaming（含 laneBusy 窗口）时被改道给子会话的用户消息，等本
   * 回合结束后再以 hidden 回合补投回主会话。
   *
   * 背景（2026-11-15 用户实测）：那一路 `sendPrompt` 在 manager.spawn 之后
   * 直接 return false —— 主会话既收不到 prompt、UI 也没有用户气泡；回合末的
   * 子会话汇报又明确「不是用户消息」，队列入队路径也已下线，这条消息在主
   * 会话里就永久丢失。这里只缓存内容形态（原文 + 图片/文件/上下文），**绝不**
   * 在派发时碰 client.prompt（会与正在跑的回合并发）或 store.userPrompt
   * （会凭空造一个主会话从未处理过的用户气泡）。
   *
   * 交付走 drainDelegatedUserTurns：与子会话汇报 / 动作回执 / 合并请求共用
   * superReportRunning 这条车道、互斥执行，排队等主会话空闲；每次只投一条，
   * sendPrompt 真的跑起来才出队，失败/被占用时留着等心跳重投，不丢也不重复。
   */
  private pendingDelegatedUserTurns: Array<{
    mainSessionId: string | null;
    text: string;
    images: { data: string; mimeType: string }[];
    files: { name: string; path: string }[];
    contexts?: ContextRefUi[];
    /** 超过子会话附件上限、没交给子会话的数量（补投文本里如实写明）。 */
    droppedByChild: number;
  }> = [];
  /**
   * Freshness baseline for the Mod context report BEFORE the next session
   * creation/load. The report is written at startChat (inside session/new /
   * session/load), so the first prompt's baseline is THIS timestamp — a
   * report written after it is the current session's startChat output.
   */
  private contextReportBaseline = 0;
  /** Awaiting user answers for `session/request_permission`, keyed by approval id. */
  private readonly pendingApprovals = new Map<
    string,
    {
      options: PermissionOption[];
      toolName: string;
      /** M4 P1-1: the original request — needed to derive an allow rule when
       * the user upgrades an approval to 「始终允许」. */
      req: RequestPermissionRequest;
      resolve: (response: RequestPermissionResponse) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private approvalSeq = 0;
  /** M4 P1-1: cached global pre-review rule table (null = not loaded yet).
   * Invalidated on save and on panel dispose only — globalState is ours. */
  private approvalRules: ApprovalRule[] | null = null;
  /** M4 P1-1: cached workspace `.iflow/approval.json` rules (read-only).
   * Invalidated by the workspace file watcher, on session start and on card
   * open — an external tool (or the user's editor) owns that file. */
  private approvalProjectRules: ApprovalRule[] | null = null;
  /** M4 P1-1: a 「始终允许」 click derived this rule; it is NOT persisted until
   * the user names it in the policy card (or it is dismissed). */
  private approvalDraft: ApprovalRule | null = null;
  private approvalRuleSeq = 0;
  /** Awaiting user confirmation for `_iflow/plan/exit`, keyed by plan-exit id. */
  private readonly pendingPlanExits = new Map<
    string,
    {
      resolve: (response: ExitPlanModeResponse) => void;
      timer: NodeJS.Timeout;
      /** Full plan text — persisted to `.iflow/specs/` on approval. */
      plan: string;
    }
  >();
  private planExitSeq = 0;
  /**
   * Mode to return to after a Plan exit is approved. The CLI does NOT switch
   * modes itself when `_iflow/plan/exit` is approved (verified 2026-09: agent
   * stays in plan mode), so the client must issue `session/set_mode` after
   * approval. Captured in setMode() right before switching INTO a plan mode.
   */
  private planReturnModeId: string | null = null;
  /** Awaiting user answers for `_iflow/user/questions`, keyed by card id. */
  private readonly pendingQuestions = new Map<
    string,
    {
      resolve: (response: UserQuestionsResponse) => void;
      timer: NodeJS.Timeout;
    }
  >();
  /**
   * Awaiting the user's choice in the profile-switch dialog, keyed by dialog id.
   * No timer: the dialog blocks no agent (unlike approval/plan/question cards),
   * so it waits for the user indefinitely — every cancel path (panel dispose,
   * session teardown) resolves it explicitly instead.
   */
  private readonly pendingProfileSwitches = new Map<string, { resolve: (keepSession: boolean | null) => void }>();
  private profileSwitchSeq = 0;
  /** Serializes per-session transcript file writes (P2): overlapping persists
   * must not interleave inside one file's temp+rename sequence. */
  private persistChain: Promise<void> = Promise.resolve();
  /** P6: workspace file list for the @-mention popup — `findFiles` is a full
   * workspace scan; cache it and invalidate on file-system changes. */
  private fileSearchCache: { rels: string[] } | null = null;
  /** P6: coalesce concurrent @-search keystrokes into one findFiles scan. */
  private fileSearchInFlight: Promise<string[]> | null = null;
  /** R3: last N stderr lines from the CLI (diagnostics for crashes/hangs). */
  private readonly stderrTail: string[] = [];
  /**
   * Set by any user-facing cancel while a prompt turn is in flight, reset at
   * the next sendPrompt. The auto-retry paths consult it so a Stop pressed
   * during a retry wait never resurrects the prompt behind the user's back.
   * `promptWithRetry` also consults it at the top of every attempt: a Stop
   * pressed before the request went out settles the turn as cancelled
   * instead of starting it (see `promptRequestSessionId`).
   */
  private cancelSeen = false;
  /**
   * `session/prompt` 请求真正发出的那一刻记录会话 id（null = 本轮还没发出）。
   *
   * `session/cancel` 打的是 CLI 里**当前在飞的请求**：bundle 实证
   * `cancelPendingPrompt()` 在 `pendingPrompt` 为空时直接抛
   * `Not currently generating`，而 `pendingPrompt` 只在 `prompt()` 里赋值。
   * 宿主的回合在状态翻成 streaming 之后还要先拍一轮 checkpoint 快照
   * （`captureWorkspaceSnapshot`）才发请求 —— 用户在这个窗口点停止，cancel
   * 落在「上一轮早已结束的控制器」上被静默丢掉，本轮随后照常开跑。这正是
   * 「点好几次才停得下来」的根因之一：`cancelSeen` 让未发出的回合就地收尾，
   * 这个字段只用来判断「该不该给 CLI 发 cancel」。
   */
  private promptRequestSessionId: string | null = null;
  /** 本轮在飞请求是否已经发过一次 `session/cancel`（同一回合内不重复发）。 */
  private cancelSentForPrompt = false;
  /**
   * 用户按过停止的**主会话** id（null = 没有压住）。
   *
   * 停止的语义是「先停下来」：宿主的自动回合（子会话汇报 / 被改道的用户
   * 消息补投）会在这一轮结束后立刻接上下一轮，用户于是看到「刚点停止又在
   * 生成」，只能反复点（实测：一条排队汇报就是一次点击）。这里把自动回合
   * 压到用户下一次主动发消息为止 —— 排队内容一条都不丢，只是不再自动开跑。
   *
   * 看板动作回执不在此列：那是用户刚在看板上操作的回执，用户期望它立刻送达。
   */
  private autoTurnsStoppedFor: string | null = null;
  /**
   * Whether the CURRENT prompt attempt produced any visible agent output
   * (text / thought / tool call / plan — see `isAgentOutputUpdate`). Set in
   * onSessionUpdate, reset per attempt inside promptWithRetry; read by the
   * completion gate to detect the empty-response failure (the CLI returns
   * `end_turn` with zero output when the gateway answers empty).
   */
  private turnHadAgentOutput = false;
  /**
   * Armed after a timeout auto-reject (approval / plan-exit / question) while
   * a turn is in flight. If the CLI's follow-up model request wedges (zero
   * `session/update` for POST_REJECTION_IDLE_MS — see the constant), the
   * watchdog cancels the dead turn instead of stranding the panel on
   * "generating" forever. Cleared by the next session/update, at turn end,
   * and on dispose.
   */
  private postRejectionWatchdog: NodeJS.Timeout | null = null;
  /**
   * Parsed edit args (shared/parseEditArgs) keyed by toolCallId, kept for the
   * arg-reversal diff fallback (strategy 2) when no pre-run snapshot exists.
   * Transient by design: never persisted, capped, cleared with the transcript.
   */
  private readonly toolArgs = new Map<string, ParsedEditArgs>();
  /**
   * Pre-run disk content per toolCallId (strategy 1): captured synchronously
   * at `in_progress` — the CLI emits it immediately before `execute` (probed,
   * CLI 0.5.19 bundle) — and compared after completion to synthesize a real
   * before/after diff for ANY editing tool. `content: null` = file absent
   * before the run (creation candidate).
   */
  private readonly preSnapshots = new Map<string, PreEditSnapshot>();
  private static readonly TOOL_ARGS_CAP = 128;

  // --- M1 state ---------------------------------------------------------------
  /** M1 P0-5: last known webview-panel visibility (the OS-notification gate).
   * `retainContextWhenHidden` means the webview document NEVER reports
   * hidden, so the host must track `WebviewPanel.visible` itself. Absent
   * panel = not visible = notifications allowed. */
  private panelVisible = false;
  /** M1 P0-5: pure gate state (throttle timestamps per event kind). */
  private osNotifyGate: OsNotifyGate = initOsNotifyGate();
  /** M1: one internal prompt at a time (the user-initiated enhance call; a
   * second request while one runs fails fast). */
  private internalPromptBusy = false;
  /** Turn-end follow-up: ONE merged request for AI title + next-step
   * prediction + memory extraction. Their old three lanes meant a settled turn
   * could fire three gateway calls regardless of how many features were on.
   * Knowledge and asset drafting keep their own lanes (user-initiated, long). */
  private followupBusy = false;
  /** F3 Phase 3: knowledge generation is user-initiated and long; own lane. */
  private knowledgePromptBusy = false;
  /** F4: asset drafting is user-initiated from the settings dialog; own lane so
   * it neither blocks nor is blocked by enhance/followup/knowledge. */
  private assetGenBusy = false;
  /** P1-5 anti-footgun: the in-flight enhance (requestId + abort + the
   * session it was started on). `cancelEnhance` aborts it; the reply is also
   * dropped when the requestId is stale or the session changed meanwhile. */
  private pendingEnhance: { requestId: number; cancel: () => void; sessionId: string | null } | null = null;
  /** 「联网补充模型数据」: own busy lane (user-initiated, long — same class
   * as knowledge/asset drafting). `metadataCancel` aborts the in-flight
   * sweep/completion when the user presses 「停止检索」. */
  private metadataBusy = false;
  private metadataCancel: (() => void) | null = null;
  /** Completion ceilings for the extraction call: it reads a large source
   * set, so it needs more wall-clock than a one-line rewrite. */
  private metadataTimeoutMs = MODEL_METADATA_TIMEOUT_MS;
  private metadataIdleMs = MODEL_METADATA_IDLE_MS;
  /** Instance fields for the search sweep budget (constants as defaults). */
  private metadataSearchTimeoutMs = MODEL_METADATA_SEARCH_TIMEOUT_MS;
  private metadataSearchPhaseMs = MODEL_METADATA_SEARCH_PHASE_MS;
  private metadataSourceChars = MODEL_METADATA_SOURCE_CHARS;
  /** M1 P0-6: true while the ≥90% occupancy warning pill is shown (the
   * state machine fires once per entry into the warn zone). */
  private contextWarnActive = false;
  /** M1 P0-7: sessions whose AI title was already generated (or attempted —
   * a failure never retries in a storm). */
  private readonly titledSessionIds = new Set<string>();
  /** M1 P1-4: bounded ACP wire ring buffer (exported via the command). */
  private readonly wireLog = new WireRingBuffer();

  // --- M2 state ---------------------------------------------------------------
  /**
   * M2 P0-3: the prompt queue's full payloads, keyed by entry id. The UI
   * projection (`QueuedPromptUi`) rides the snapshot tail; the heavy payload
   * (images base64, files, contexts) stays here so it never serializes onto
   * every blockPatch. Insertion order is irrelevant — the store's `queue`
   * array is the FIFO order; this map only resolves id → payload.
   */
  private readonly queuePayloads = new Map<
    string,
    { images?: { data: string; mimeType: string }[]; files?: { name: string; path: string }[]; contexts?: ContextRefUi[] }
  >();
  /**
   * M2 P0-3: when the user clicks 立即发送 on a queued entry, we cancel the
   * in-flight turn and set this to that entry's id; the turn's completion
   * handler dispatches THAT entry first (bypassing FIFO order) then clears it.
   */
  private queueSendNowId: string | null = null;

  /**
   * M3 P0-1: shadow-git snapshotter (one shadow repo per session under
   * `storageUri/checkpoints/`). Lazily consulted per turn; disabled per
   * session when git is missing / init failed / the workspace is too big.
   */
  private readonly checkpoints = new CheckpointManager({
    log: { info: (m) => this.log.info(m), warn: (m) => this.log.warn(m) },
  });
  /** Sessions whose disable-reason toast was already shown (avoid repeats). */
  private readonly checkpointWarnedSessions = new Set<string>();
  /** Sessions whose large-file skip toast was already shown (avoid repeats). */
  private readonly checkpointSkippedWarnedSessions = new Set<string>();
  /** Persist chain for checkpoint index files (same discipline as transcripts). */
  private checkpointPersistChain: Promise<void> = Promise.resolve();
  /** Index loaded before a restore's id re-mint; consumed by finalizeCheckpointIndex. */
  private pendingCheckpointIndex: { sessionId: string; checkpoints: CheckpointUi[] } | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly services: PanelServices = {},
  ) {
    this.log = vscode.window.createOutputChannel(vscode.l10n.t("心流·驭光"), { log: true });
    this.memory = new MemoryService({
      log: { info: (m) => this.log.info(m), warn: (m) => this.log.warn(m) },
      getCwd: () => this.sessionCwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
      getWorkspaceRoots: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      getContextFileName: () =>
        readCliSettings(path.join(os.homedir(), ".iflow", "settings.json"))?.contextFileName ?? null,
      isAutoCaptureEnabled: () =>
        vscode.workspace.getConfiguration("iflow").get<boolean>("autoMemoryCapture", true),
      getSessionId: () => this.store.getState().sessionId,
      scanWorkspace: () => this.scanKnowledgeWorkspace(),
      readWorkspaceFile: (file) => this.readKnowledgeFile(file),
      runKnowledgePrompt: (prompt) => this.runKnowledgePrompt(prompt),
      getModelName: () => this.store.getState().currentModelId ?? null,
      post: (m) => this.postToWebview(m),
      sendToast: (level, message, opts) => this.store.sendToast(level, message, opts),
      dismissToast: (toastId) => this.store.dismissToast(toastId),
      openFile: (file) => {
        void vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
      },
    });
    this.assets = new AssetsService({
      log: { info: (m) => this.log.info(m), warn: (m) => this.log.warn(m) },
      getCwd: () => this.sessionCwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
      getWorkspaceRoots: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      post: (m) => this.postToWebview(m),
    });
    this.store = new SessionStore({ post: (m) => this.postToWebview(m), language: vscode.env.language });
    this.store.onStateChange = (state) => {
      this.updateStatusBar(state);
      // M1 P0-6: occupancy-warning state machine (pure numeric compare per
      // push; toast/dismiss are post-only, no re-entrancy into the store).
      this.evaluateContextWarning();
      // Diagnostics watch arms on the first streaming push of a turn and
      // disarms when the turn settles (baseline + once-per-turn flag reset).
      this.trackDiagnosticsWatch(state.status);
    };
    // M1 P0-6/P1-6: the store consults this on every usage refresh, so a
    // model switch or a settings edit lands on the occupancy bar without
    // per-call-site wiring (the push itself is the invalidation signal).
    this.store.getUsageContext = () => this.resolveUsageContext();
    this.store.onStateReplaced = () => {
      this.clearToolCaches();
      // F3: a session swap can change cwd (multi-root / restored session), so
      // the discovered global+project file list must be recomputed lazily.
      this.memory.invalidate();
      // M2 P0-3: every wholesale state swap (new session / restore / hot
      // re-auth / restart) drops the queue — a queued prompt belongs to the
      // outgoing session only.
      this.clearQueue();
    };
    // Cross-window cache for the node-probe result (the probe shells out —
    // hundreds of ms per window). The locator re-validates the hydrated path
    // with existsSync, so a removed node re-probes. The CLI entry needs no
    // cache: it is the vendored fork, resolved synchronously in resolveEntry.
    configureLocatorPersistence({
      load: () => this.context.globalState.get<LocatorPaths>(LOCATOR_PATHS_KEY),
      save: (paths) => void this.context.globalState.update(LOCATOR_PATHS_KEY, paths),
    });
    // API-config isolation (user directive 2026-10-06) lives CLI-side: the
    // vendored/forked bundle carries the api-config-isolation patch which,
    // under IFLOW_HARNESS=1 (see the spawn env below), keeps the panel-owned
    // auth fields out of the shared ~/.iflow/settings.json write-back. The
    // extension therefore uses the SHARED home for everything else (slash
    // commands, agents, skills, memory, acp/sessions) — no private dir.
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBar.command = "iflow.openPanel";
    this.statusBar.tooltip = vscode.l10n.t("心流·驭光 — 点击打开聊天面板");
    // Let the panel follow the editor color theme (the webview ignores this
    // once the user picked a theme manually).
    this.context.subscriptions.push(
      vscode.window.onDidChangeActiveColorTheme(() => this.postTheme()),
          vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("iflow.auroraIntensity")) this.postTheme();
            // Every mirrored setting lives in the same settings panel; a
            // direct VSCode-side edit must repaint it too.
            if (e.affectsConfiguration("iflow")) this.postHostSettings();
        if (
          e.affectsConfiguration("iflow.language")
          || e.affectsConfiguration("iflow.approvalMode")
        ) {
          this.syncCliSettingsToDisk();
        }
        // Setting-owned thinking rules: re-merge into ~/.iflow/thinking-models.json
        // on edit (additive, user DSL entries untouched; the CLI picks them up
        // at its next startup — the toast in applyThinkingModelRules says so).
        if (e.affectsConfiguration("iflow.thinkingModelRules")) this.applyThinkingModelRules();
        // M1 P0-6/P1-6: the usage resolver reads these fresh on every push —
        // one flush is enough to repaint the occupancy bar / cost chip.
        if (
          e.affectsConfiguration("iflow.contextWindowOverrides")
          || e.affectsConfiguration("iflow.costTable")
        ) {
          this.usageOverridesCache = null;
          this.store.pushSnapshot();
        }
      }),
    );
    // Diagnostics watch: fires on every lint pass, but the evaluation only
    // acts while a turn streams (armed/disarmed by trackDiagnosticsWatch).
    this.context.subscriptions.push(
      vscode.languages.onDidChangeDiagnostics(() => this.onDiagnosticsChanged()),
    );
    // P6: file-system changes invalidate the @-mention file-list cache.
    const watchRoot = vscode.workspace.workspaceFolders?.[0]?.uri ?? this.context.extensionUri;
    const fileWatcher = this.services.watchers?.[0] ?? vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(watchRoot, "**/*"));
    const invalidateFileCache = () => {
      this.fileSearchCache = null;
      // M4 P1-1: the project override lives inside the workspace, so the same
      // watcher covers it — drop the cache and the next pre-review re-reads.
      this.approvalProjectRules = null;
    };
    fileWatcher.onDidCreate(invalidateFileCache);
    fileWatcher.onDidDelete(invalidateFileCache);
    this.context.subscriptions.push(fileWatcher);
    // QQ 远程任务通道（Wave3-B2b）：设置区的任何改动都可能要求重建服务。
    // 监听整个 `iflow.qq` 段（等价于 `iflow.qq.` 前缀），再按「是否碰到连接类
    // 字段」决定重启 —— 改白名单 / 策略这类热更新字段不应打断在跑的任务。
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("iflow.qq")) return;
        void this.onQqSettingsChanged().catch((error: unknown) => {
          this.log.warn(`QQ 设置变更处理失败：${errorMessage(error)}`);
        });
      }),
    );
    // 异步启动，不阻塞激活：设置未启用时只读一次配置就返回。
    void this.startQqIfEnabled();
    // Status bar entry is the always-visible launcher (no sidebar view anymore).
    this.statusBar.show();
  }

  private updateStatusBar(state: SessionState): void {
    const model = state.currentModelId ? ` · ${state.currentModelId}` : "";
    const mode = state.modes ? ` · ${state.modes.currentModeId}` : "";
    let text: string;
    let background: vscode.ThemeColor | undefined;
    switch (state.status) {
      case "connecting":
        text = `$(sync~spin) iFlow${model}`;
        break;
      case "streaming": {
        const label = state.compressing
          ? vscode.l10n.t("正在压缩")
          : isPlanMode(state.modes)
            ? vscode.l10n.t("正在规划")
            : vscode.l10n.t("生成中");
        text = `$(sync~spin) iFlow: ${label}${model}`;
        break;
      }
      case "error":
        text = `$(error) iFlow: ${vscode.l10n.t("出错")}${model}`;
        background = new vscode.ThemeColor("statusBarItem.errorBackground");
        break;
      default:
        if (state.pendingApproval) {
          text = `$(bell) iFlow: ${vscode.l10n.t("等待审批")}${model}`;
          background = new vscode.ThemeColor("statusBarItem.warningBackground");
        } else if (state.superWaiting && state.superHeld) {
          // 用户按了停止：汇报被压在队列里，主会话并没有在生成。旧实现把它和
          // 真 streaming 渲染成同一串「生成中」+ 转圈，而 composer 明明显示
          // 「发送」—— 用户看到的就是「卡住了」。如实写已停止 + 待处理数量，
          // 不转圈；下一步动作放在 hover tooltip 与常驻提示里。
          const pending = state.superPendingCount ?? 0;
          text = pending > 0
            ? `$(history) iFlow: ${vscode.l10n.t("已停止 · {0} 项待处理", pending)}${model}`
            : `$(history) iFlow: ${vscode.l10n.t("已停止")}${model}`;
        } else if (state.superWaiting) {
          // 子会话确实还在跑 / 在等你回答：如实用「进行中 / 等待你处理」，
          // 不能说「生成中」——那是主回合的语义，此刻主会话是 idle。
          const kids = state.superSessions ?? [];
          const awaiting = kids.some((session) => session.status === "awaiting_input");
          text = awaiting
            ? `$(bell) iFlow: ${vscode.l10n.t("等待你处理")}${model}`
            : `$(sync~spin) iFlow: ${vscode.l10n.t("子会话进行中")}${model}`;
        } else {
          text = `$(check) iFlow${mode}${model}`;
        }
    }
    if (this.statusBar.text !== text || this.statusBar.backgroundColor !== background) {
      this.statusBar.text = text;
      this.statusBar.backgroundColor = background;
    }
    const tip = this.statusBarTooltip(state);
    if (tip !== this.statusBarTooltipText) {
      this.statusBarTooltipText = tip;
      this.statusBar.tooltip = tip;
    }
  }

  /**
   * Status-bar hover content: launcher hint plus the session's token usage.
   * UI-audit 4.6 moved the usage breakdown out of the composer (a section
   * appended to the model menu was unreachable behind a gateway's long model
   * list); the status bar is always visible, so its tooltip is the on-demand
   * "session info" view. Plain strings in StatusBarItem.tooltip render as
   * Markdown.
   */
  private statusBarTooltip(state: SessionState): string {
    const base = vscode.l10n.t("心流·驭光 — 点击打开聊天面板");
    // 压住态必须告诉用户「下一步是什么」，否则「已停止 · N 项待处理」照样像
    // 死锁。它比用量信息更重要，所以即使没有用量也要出现在 tooltip 里。
    const heldTip = state.superHeld
      ? vscode.l10n.t(
          "已停止：还有 {0} 项子会话结果待处理。发送下一条消息，或点提示条上的「继续处理」来收取汇报",
          state.superPendingCount ?? 0,
        )
      : null;
    const u = state.usage;
    if (!u || u.totalTokens <= 0) return heldTip ? `${base}\n\n${heldTip}` : base;
    const used = u.contextUsed ?? u.inputTokens;
    const rows: string[] = [];
    if (u.contextWindow) {
      const pct = Math.min(100, Math.round((used / u.contextWindow) * 100));
      rows.push(
        vscode.l10n.t(
          "上下文 {0} / {1}（{2}%）",
          used.toLocaleString(),
          u.contextWindow.toLocaleString(),
          `${u.estimated ? "≈" : ""}${pct}`,
        ),
      );
    } else {
      rows.push(vscode.l10n.t("上下文约 {0} tokens", used.toLocaleString()));
    }
    rows.push(
      vscode.l10n.t("输入 {0} tokens · 输出 {1} tokens", u.inputTokens.toLocaleString(), u.outputTokens.toLocaleString()),
    );
    // Fixed prefill: the instructions / memory / tool declarations the model
    // re-reads on EVERY request. Without this row the occupancy looks like
    // "the conversation so far" while the model actually carries tens of
    // thousands of tokens of fixed input.
    if (u.prefillTokens && u.prefillTokens > 0) {
      rows.push(
        vscode.l10n.t(
          "每次请求固定携带 {0} tokens（系统提示词、记忆与工具说明）",
          u.prefillTokens.toLocaleString(),
        ),
      );
    }
    if (u.cacheReadTokens > 0) {
      rows.push(vscode.l10n.t("缓存读取 {0} tokens", u.cacheReadTokens.toLocaleString()));
    }
    if (u.breakdown) {
      rows.push(
        vscode.l10n.t(
          "用户 {0} · 助手 {1} · 工具 {2} · 思考 {3}",
          u.breakdown.user.toLocaleString(),
          u.breakdown.assistant.toLocaleString(),
          u.breakdown.tool.toLocaleString(),
          u.breakdown.thought.toLocaleString(),
        ),
      );
    }
    if (u.estimatedCost !== null && u.estimatedCost !== undefined) {
      const cost = u.estimatedCost > 0 && u.estimatedCost < 0.01
        ? `$${u.estimatedCost.toFixed(4)}`
        : `$${u.estimatedCost.toFixed(2)}`;
      rows.push(vscode.l10n.t("预估成本 {0}（按公开单价估算）", cost));
    }
    const usageTip = `${base}\n\n**${vscode.l10n.t("会话用量")}**\n\n${rows.map((r) => `- ${r}`).join("\n")}`;
    return heldTip ? `${usageTip}\n\n${heldTip}` : usageTip;
  }

  /**
   * R6: async so callers (notably `deactivate` via subscriptions) can await
   * the CLI child actually exiting (kill + SIGKILL fallback takes up to 3s)
   * instead of abandoning it mid-teardown.
   */
  async dispose(): Promise<void> {
    // Idempotent: `deactivate` awaits it explicitly and VSCode also disposes
    // it as a subscription, so a second call must be a no-op rather than
    // re-running teardown against an already-destroyed panel.
    if (this.disposed) return;
    this.disposed = true;
    // Final flush: a turn interrupted by window close / extension reload has
    // no later persist point (completion never runs) — write the tail now so
    // the session survives a restart intact. No-op when blocks are empty.
    try {
      await this.persistActiveTranscript(true);
    } catch {
      // best-effort; teardown must proceed even if the write failed
    }
    // A3: kill the client FIRST, then settle the in-flight handshake. The
    // order matters: awaiting `connecting` before the kill would hang here
    // until the child's own initialize timeout (up to 120s) — the exact node
    // process leak this closes. The kill rejects the pending initialize
    // request, so the handshake bails at its disposed checkpoint and
    // `connecting` settles promptly; its catch skips the destroyed store.
    try {
      await this.client?.dispose();
    } catch {
      // best-effort teardown; nothing to do if the kill itself failed
    }
    if (this.connecting) {
      try {
        await this.connecting;
      } catch {
        // expected: the handshake bailed on the disposed flag
      }
    }
    this.cancelAllApprovals(vscode.l10n.t("扩展已停用"));
    this.cancelAllPlanExits(vscode.l10n.t("扩展已停用，计划审批已跳过"));
    this.cancelAllPendingQuestions("");
    // Super Agent: kill the child sessions' CLI processes too — each one is
    // its own process tree, and leaving them behind would leak node
    // processes (and MCP server fleets) on every window close. Their
    // worktrees are NOT removed: they may still hold work the user has not
    // merged yet.
    try {
      const kept = (await this.superAgent?.dispose()) ?? [];
      for (const entry of kept) {
        this.log.info(
          `super agent: child ${entry.id} stopped; worktree kept at ${entry.path}${
            entry.branch ? ` (branch ${entry.branch})` : ""
          }`,
        );
      }
      // Final archive flush: dispose() just marked the in-flight children
      // 「已中断」, and this is the last chance to record it — the host exits
      // right after, so a fire-and-forget write would likely be lost. The
      // records are what let the next restore show these children (and their
      // unmerged branches) instead of an empty board. `force` — the host exits
      // right after, so a throttled write would never land.
      await this.persistSuperSessions({ force: true });
    } catch {
      // best-effort teardown
    }
    this.superAgent = null;
    this.pendingSuperReports.clear();
    this.pendingSuperReportPrompts = [];
    this.pendingSuperActionReceipts = [];
    this.pendingDelegatedUserTurns = [];
    this.autoTurnsStoppedFor = null;
    this.clearDeferredAutoTurnsToast();
    this.promptRequestSessionId = null;
    this.stopSuperHeartbeat();
    // 面板要没了，等待子会话的忙碌标记也一并清掉（别把忙碌态留在快照里）。
    this.store.setSuperWaiting(false);
    this.cancelAllProfileSwitches();
    this.clearPostRejectionWatchdog();
    if (this.diagDebounce) {
      clearTimeout(this.diagDebounce);
      this.diagDebounce = null;
    }
    this.diagBaselineErrors = null;
    // QQ 通道：bridge 进程、宿主 IPC 监听与任务服务必须一起收掉 —— 否则窗口
    // 关闭后会留下一个孤立的 node 进程和占用的端口。最多等 2s（见
    // QQ_BRIDGE_STOP_TIMEOUT_MS），关闭流程不能被一个卡住的 socket 拖死。
    await this.raceQqTeardown(this.stopQq());
    this.client = null;
    this.memory.dispose();
    this.assets.dispose();
    this.editorPanel?.dispose();
    this.editorPanel = undefined;
    this.statusBar.dispose();
    this.log.dispose();
  }

  // --- Editor-tab container (WebviewPanel) ------------------------------------
  // The chat lives in a wide, resizable editor tab opened via `openEditorTab`
  // (command palette / status bar / editor title icon). There is no sidebar
  // view: VSCode always opens a view in the sidebar, which is too narrow as
  // the primary surface.

  /**
   * Warm start: spawn + initialize the CLI in the background right after
   * window activation (`iflow.warmStart`, default on). The panel's first open
   * then rides the already-connecting/live client — ensureClient is idempotent
   * and hands back the in-flight connect — instead of paying the ~6s
   * initialize handshake visibly. No webview exists yet; snapshots posted
   * before it simply no-op, and the panel pushes a fresh snapshot on open.
   * Failures land in the log and store; the panel shows them when opened.
   */
  warmStart(): void {
    const enabled = vscode.workspace.getConfiguration("iflow").get<boolean>("warmStart", true);
    if (!enabled) return;
    void this.ensureClient().catch((error) => {
      this.log.error("warm start failed", errorMessage(error));
    });
  }

  /**
   * A7: staged drop/paste attachments pile up under the OS temp dir with no
   * in-band cleanup (review 2026-09-19) — sweep session dirs idle for over a
   * week. Fire-and-forget once per window activation (invoked next to
   * warmStart); the sweep only touches our own namespaced temp root.
   */
  sweepStaleAttachments(): void {
    void sweepStaleAttachmentDirs({ log: (m) => this.log.info(m) }).catch((error) => {
      this.log.warn(`attachment sweep failed: ${errorMessage(error)}`);
    });
  }

  /** Open (or reveal) the chat as an editor tab with a generous width. */
  openEditorTab(): void {
    if (this.editorPanel) {
      void this.editorPanel.reveal(undefined, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "iflow.chatEditor",
      vscode.l10n.t("心流·驭光"),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        localResourceRoots: [this.context.extensionUri],
        retainContextWhenHidden: true,
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "media", "iflow.svg");
    this.editorPanel = panel;
    // M1 P0-5: the OS-notification gate needs the panel's visibility. The
    // webview document never reports hidden (retainContextWhenHidden), so
    // `WebviewPanel.visible` is the only truth — track it here.
    this.panelVisible = panel.visible;
    panel.onDidChangeViewState(
      (e) => {
        this.panelVisible = e.webviewPanel.visible;
        // 面板重新可见：QQ 通道可能在被隐藏期间变化（任务推进 / bridge 重连），
        // 补一次全量推送，避免设置卡与看板停在旧画面。
        if (e.webviewPanel.visible) this.pushQqState();
      },
      null,
      this.context.subscriptions,
    );
    this.wireWebview(panel.webview);
    panel.onDidDispose(
      () => {
        if (this.editorPanel === panel) this.editorPanel = undefined;
      },
      null,
      this.context.subscriptions,
    );
    this.postSnapshot();
    this.postTheme();
    this.pushQqState();
    void this.ensureClient().catch((error) => {
      this.log.error("initial connect failed", errorMessage(error));
    });
  }

  /** Shared webview setup. */
  private wireWebview(webview: vscode.Webview): void {
    webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    webview.html = this.buildHtml(webview);
    // One catch for the whole route: a rejected branch (workspaceState.update,
    // persistSessions, a transcript/attachment write, …) used to become a
    // silent unhandled rejection — the user saw nothing at all. Log it and
    // surface it as a toast; never swallow it.
    webview.onDidReceiveMessage((msg: WebviewToHost) => {
      void this.handleWebviewMessage(msg).catch((error: unknown) => {
        const detail = errorMessage(error);
        this.log.error(`webview message failed (${msg.type}): ${detail}`);
        this.store.sendToast("error", vscode.l10n.t("操作失败：{0}", detail));
      });
    });
  }

  private buildHtml(webview: vscode.Webview): string {
    const absIndex = this.context.asAbsolutePath(WEBVIEW_DIST);
    let raw: string;
    try {
      raw = readFileSync(absIndex, "utf8");
    } catch {
      return `<html><body><h3>webview assets missing</h3><p>Run <code>npm run build</code> in iflow-harness/</p></body></html>`;
    }
    const nonce = Array.from({ length: 24 }, () => Math.random().toString(36).slice(2)).join("");
    // Rewrite relative asset refs (./assets/...) to webview URIs, then nonce scripts.
    const rewritten = raw.replace(/(src|href)="\.?\/?(assets\/[^"]+)"/g, (_m, attr: string, rel: string) => {
      const uri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "webview", "dist", rel));
      return `${attr}="${uri}"`;
    });
    const withNonce = rewritten.replace(/<script/g, `<script nonce="${nonce}"`);
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      // P1-7: mermaid loads as a lazy dynamic-import chunk. Vite's
      // modulepreload helper emits a <link rel=modulepreload> that carries no
      // nonce, so a nonce-only script-src would block it. cspSource scopes the
      // allowance to this extension's own dist (vscode-webview-resource
      // scheme) — no external script is ever permitted.
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
    ].join("; ");
    // The built index.html already has <html>/<head>/<body>; inject CSP as the first head child.
    return withNonce.replace("<head>", `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);
  }

  /**
   * M5: @iflow chat participant — run a prompt through the shared session and
   * return the assistant text produced this turn (text-only fallback).
   */
  async chatForward(prompt: string, token: vscode.CancellationToken): Promise<string> {
    // A3: the panel was disposed — do not start a turn into a destroyed store.
    if (this.disposed) return "";
    const stateBefore = this.store.getState();
    const textCountBefore = stateBefore.blocks.filter((b) => b.kind === "text").length;
    // sendPrompt never rejects (it catches internally and marks the store
    // error) — a failure surfaces here as status "error", which ends the
    // wait below (P3/R2: only "idle" was checked before, so a failed prompt
    // hung this promise and the participant forever).
    void this.sendPrompt(prompt);
    // Wait for completion (idle), failure (error), cancellation or timeout,
    // polling the small store.
    await new Promise<void>((resolve) => {
      let done = false;
      let cancelSent = false;
      let pollTimer: NodeJS.Timeout | null = null;
      let timeoutTimer: NodeJS.Timeout | null = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (pollTimer) clearInterval(pollTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        resolve();
      };
      timeoutTimer = setTimeout(finish, CHAT_FORWARD_TIMEOUT_MS);
      pollTimer = setInterval(() => {
        if (token.isCancellationRequested) {
          // P3: send cancel exactly once — the old loop re-sent it on every
          // 200ms tick. Ending the wait does not kill the prompt in the
          // panel; cancel here does (the user asked for it).
          if (!cancelSent) {
            cancelSent = true;
            this.cancelSeen = true;
            const sessionId = this.store.getState().sessionId;
            if (sessionId) this.client?.cancel(sessionId);
          }
          finish();
          return;
        }
        const status = this.store.getState().status;
        if (status === "idle" || status === "error") finish();
      }, 200);
    });
    const blocks = this.store.getState().blocks;
    const newTexts = blocks.filter((b) => b.kind === "text").slice(textCountBefore);
    return newTexts.map((b) => (b.kind === "text" ? b.text : "")).join("\n").trim() || vscode.l10n.t("（本轮无文本输出）");
  }

  // --- Editor selection entry points (M5) ---------------------------------------

  /** Right-click "Ask iFlow": send the selection as a prompt immediately. */
  async askSelection(relPath: string, range: string, code: string): Promise<void> {
    await vscode.commands.executeCommand("iflow.chatPanel.focus");
    await this.sendPrompt(renderPrompt("ask-selection", { path: relPath, range, code }));
  }

  /**
   * Right-click "加入 iFlow 上下文": attach the selection as a structured
   * code-context card above the composer (webview renders it styled and
   * removable — a plain textarea cannot). The card rides `sendPrompt` back
   * and is assembled into the agent-facing prompt here at send time.
   */
  addToContext(relPath: string, range: string, code: string): void {
    void vscode.commands.executeCommand("iflow.chatPanel.focus");
    this.postToWebview({ type: "setCodeContext", path: relPath, range, code });
  }

  /**
   * Right-click "记住选中内容": append one fact to the global or project
   * memory file. Native QuickPick/InputBox keep this usable with the panel
   * closed; the rich editor lives in the settings memory tab.
   */
  async rememberSelection(relPath: string, range: string, code: string): Promise<void> {
    const firstLine =
      code
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "";
    const suggestion = `${relPath}:${range} ${firstLine}`.trim().slice(0, 200);
    const globalLabel = vscode.l10n.t("全局记忆");
    const projectLabel = vscode.l10n.t("项目记忆");
    const scopePick = await vscode.window.showQuickPick(
      [
        {
          label: globalLabel,
          description: vscode.l10n.t("所有项目通用（保存在本机 iFlow 配置里）"),
        },
        {
          label: projectLabel,
          description: vscode.l10n.t("仅当前项目（保存在项目目录里）"),
        },
      ],
      { placeHolder: vscode.l10n.t("这条记忆保存到哪里？") },
    );
    if (!scopePick) return;
    const scope = scopePick.label === projectLabel ? "project" : "global";
    const fact = await vscode.window.showInputBox({
      prompt: vscode.l10n.t("描述要记住的偏好或约定（可编辑）"),
      value: suggestion,
      ignoreFocusOut: true,
    });
    if (!fact?.trim()) return;
    const result = await this.memory.appendFact({ scope, fact });
    if (!result.ok) {
      void vscode.window.showWarningMessage(result.error ?? vscode.l10n.t("写入记忆失败"));
      return;
    }
    const restart = vscode.l10n.t("立即重启内核");
    void vscode.window
      .showInformationMessage(
        vscode.l10n.t("已加入记忆，新建会话或恢复会话后生效"),
        restart,
      )
      .then((choice) => {
        if (choice === restart) void this.restartCli();
      });
  }

  /**
   * Persist non-image files dropped/pasted into the composer. The webview only
   * holds File objects (no real filesystem path), so the host writes the bytes
   * into a session temp dir and replies with absolute paths — the agent then
   * reads them with its own file tools. Names are sanitized (basename only,
   * separators/controls stripped) so a renderer-supplied name can never escape
   * the attachment dir; writes go through vscode.workspace.fs.
   */
  private async stageDroppedFiles(
    msg: Extract<WebviewToHost, { type: "stageFiles" }>,
  ): Promise<void> {
    const MAX_BASE64_LEN = 50 * 1024 * 1024 * 1.34; // ~50MB decoded + base64 slack
    const sessionId = this.store.getState().sessionId ?? "adhoc";
    // A7: the layout lives in attachments.ts so the sweeper and the
    // session-delete cleanup resolve the exact same dir.
    const dirUri = vscode.Uri.file(attachmentSessionDir(sessionId));
    await vscode.workspace.fs.createDirectory(dirUri);
    const dir = dirUri.fsPath;
    const paths: Array<string | null> = [];
    for (const file of msg.files) {
      try {
        if (file.data.length > MAX_BASE64_LEN) throw new Error("attachment too large");
        const safeName =
          path
            .basename(file.name)
            .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
            .trim() || "attachment";
        const ext = path.extname(safeName);
        const stem = safeName.slice(0, safeName.length - ext.length);
        let target = path.join(dir, safeName);
        let n = 2;
        while (existsSync(target)) target = path.join(dir, `${stem}-${n++}${ext}`);
        await vscode.workspace.fs.writeFile(vscode.Uri.file(target), Buffer.from(file.data, "base64"));
        paths.push(target);
      } catch (error) {
        this.log.warn(`staging dropped file failed: ${errorMessage(error)}`);
        paths.push(null);
      }
    }
    this.postToWebview({ type: "stagedFiles", requestId: msg.requestId, paths });
  }

  /**
   * OS file picker → attachments. Images are read as base64 (the webview has
   * no fs access); other files keep their real disk paths — no temp-dir
   * staging needed because the picker guarantees an absolute path.
   */
  private async pickAttachments(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFolders: false,
      title: vscode.l10n.t("添加附件"),
    });
    if (!picked || picked.length === 0) return;
    const images: { name: string; data: string; mimeType: string }[] = [];
    const files: { name: string; path: string }[] = [];
    for (const uri of picked) {
      const fsPath = uri.fsPath;
      const name = path.basename(fsPath);
      const mime = IMAGE_MIME_BY_EXT.get(path.extname(fsPath).toLowerCase());
      if (mime) {
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          if (bytes.byteLength <= ATTACHMENT_IMAGE_MAX_BYTES) {
            images.push({ name, data: Buffer.from(bytes).toString("base64"), mimeType: mime });
            continue;
          }
          // Over-limit image: NO continue — intentional fall-through to the
          // files.push below, degrading it to a plain file attachment
          // instead of silently skipping it (review 2026-09-19 A6 misread
          // this as a drop; the webview drop/paste path now mirrors it).
        } catch (error) {
          this.log.warn(`reading picked image failed: ${errorMessage(error)}`);
          continue;
        }
      }
      files.push({ name, path: fsPath });
    }
    this.postToWebview({ type: "filesPicked", images, files });
  }

  // --- WebView message routing -------------------------------------------------

  private async handleWebviewMessage(msg: WebviewToHost): Promise<void> {
    this.log.trace(`webview → host: ${msg.type}`);
    // `qqConfigAction`（连测试 / 生成配对码 / 解绑）是 webview→host 命令；
    // 它历史上只声明在 HostToWebview 上（方向写反），Wave3-C2 已在
    // WebviewToHost 补上声明，「修正消息方向」这次又把 HostToWebview 上的
    // 误声明移除，下面 switch 里的 `case "qqConfigAction"` 是类型检查过的
    // 正规通道。这段运行时形状守卫保留，兼容尚未重建、仍按旧声明发送的
    // 旧 webview（先于 switch 命中，行为与原先一致）。
    const qqAction = (msg as { type?: unknown; action?: unknown });
    if (
      qqAction.type === "qqConfigAction" &&
      (qqAction.action === "testConnection" ||
        qqAction.action === "generateBindCode" ||
        qqAction.action === "unbind" ||
        qqAction.action === "startQrLogin" ||
        qqAction.action === "refreshQr" ||
        qqAction.action === "cancelQrLogin")
    ) {
      await this.handleQqConfigAction(qqAction.action);
      return;
    }
    switch (msg.type) {
      case "ready":
        // The webview (re)booted and lost its transcript anchor: resync()
        // forces the next push to be a full snapshot (P-1 blockPatch would
        // apply on top of a transcript the webview no longer holds).
        this.store.resync();
        this.store.pushSnapshot();
        // Child transcripts are NOT part of the snapshot (their own channel),
        // so a rebooted webview must get them re-sent or the detail pane is
        // blank until the child emits its next chunk.
        for (const entry of this.superAgent?.transcriptEntries() ?? []) {
          this.postToWebview({
            type: "superTranscript",
            sessionId: entry.sessionId,
            from: 0,
            blocks: entry.blocks,
          });
        }
        // Wire race (verified): the initial postTheme() in openEditorTab fires
        // before the webview's React message listener exists, so the first
        // theme/auroraIntensity push is dropped and the aurora stays at its
        // CSS default until the setting is touched again. Re-post now that
        // `ready` proves the listener is live.
        this.postTheme();
        this.postHostSettings();
        this.pushQqState();
        break;
      case "sendPrompt":
        await this.sendPrompt(msg.text, msg.images, msg.files, msg.contexts);
        break;
      case "queueAction":
        this.handleQueueAction(msg);
        break;
      case "resolveContext":
        void this.resolveContext(msg.requestId, msg.kind, msg.query);
        break;
      case "stopSubagent": {
        if (!canStopSubAgent(this.store.getState(), msg.sessionId, msg.agentId)) break;
        const agentClient = this.client;
        if (!agentClient) break;
        try {
          // agent-cancel-refactor Mod (vendored fork): aborts ONLY this
          // agent's signal chain; the parent turn keeps running with an
          // interrupted-task result (verified on wire, probe 2026-10-12).
          const res = await agentClient.cancelAgent(msg.sessionId, msg.agentId);
          if (res?.stopped) {
            this.store.markSubagentStopped(msg.agentId);
          } else if (res?.reason === "not_found") {
            this.store.sendToast("info", vscode.l10n.t("该子代理已结束"));
          } else {
            this.store.sendToast("warning", vscode.l10n.t("停止子代理失败"));
          }
        } catch {
          this.store.sendToast("warning", vscode.l10n.t("停止子代理失败"));
        }
        break;
      }
      case "superAgent":
        await this.handleSuperAgentAction(msg);
        break;
      case "cancel":
        this.cancelCurrentTurn();
        break;
      case "newSession":
        await this.startNewSession();
        break;
      case "setMode":
        await this.setMode(msg.modeId);
        break;
      case "setModel":
        await this.setModel(msg.modelId);
        break;
      case "setThink":
        await this.setThink(msg.level);
        break;
      case "openLocation": {
        // C1: webview FileRefs may carry session-relative paths — resolve
        // against the session cwd instead of the drive root.
        // The CLI's wire diff path is often a bare basename (probed, CLI
        // 0.5.19: confirmation details send `basename(file_path)`), which
        // resolves to a nonexistent file at the session root — reuse the
        // same multi-candidate resolution as revert/openDiff (pitfall #6)
        // whenever the chip belongs to a diff-carrying tool block.
        let target = this.resolveAgentPathToAbsolute(msg.path);
        if (msg.toolCallId) {
          const block = findToolBlockById(this.store.getState().blocks, msg.toolCallId);
          if (block?.diff) {
            // locateDiffFile ends in a user-facing picker, so null = cancelled.
            const chosen = await this.locateDiffFile(block);
            if (!chosen) return;
            target = chosen;
          }
        }
        let doc: vscode.TextDocument;
        try {
          doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
        } catch (error) {
          // handleWebviewMessage is fire-and-forget — without this the
          // failed open was completely silent (the Windows bug report).
          void vscode.window.showWarningMessage(
            vscode.l10n.t("无法打开 {0}: {1}", target, errorMessage(error)),
          );
          return;
        }
        const line = Math.min(
          Math.max(0, (msg.line ?? 1) - 1),
          Math.max(0, doc.lineCount - 1),
        );
        await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0) });
        break;
      }
      case "openExternal":
        if (/^https?:\/\//.test(msg.uri)) {
          await vscode.env.openExternal(vscode.Uri.parse(msg.uri));
        }
        break;
      case "respondApproval":
        this.handleApprovalResponse(msg.id, msg.optionId);
        break;
      case "respondPlanExit":
        await this.handlePlanExitResponse(msg.id, msg.approved, msg.reason, msg.replan === true);
        break;
      case "answerQuestions":
        this.handleQuestionAnswers(msg.id, msg.answers);
        break;
      case "respondProfileSwitch":
        this.handleProfileSwitchResponse(msg.id, msg.keepSession);
        break;
      case "revertTool":
        await this.revertToolDiff(msg.toolCallId);
        break;
      case "applyHunkSelection":
        await this.applyHunkSelection(msg.toolCallId, msg.keep);
        break;
      case "restoreCheckpoint":
        await this.restoreCheckpoint(msg.userBlockId, msg.mode);
        break;
      case "requestTurnChanges": {
        const state = this.store.getState();
        const available = state.sessionId === msg.sessionId && canReviewTurn(state, msg.userBlockId);
        this.postToWebview({ type: "turnChanges", sessionId: msg.sessionId,
          userBlockId: msg.userBlockId, requestId: msg.requestId,
          records: available ? collectTurnChanges(state.blocks, msg.userBlockId) : [], unavailable: !available });
        break;
      }
      case "revertTurnFile":
        await this.revertTurnFile(msg.sessionId, msg.userBlockId, msg.key);
        break;
      case "openDiff":
        if (msg.sessionId !== undefined && msg.sessionId !== this.store.getState().sessionId) break;
        await this.openToolDiff(msg.toolCallId);
        break;
      case "runInTerminal":
        this.runToolInTerminal(msg.toolCallId, msg.execute);
        break;
      case "searchFiles":
        void this.searchWorkspaceFiles(msg.requestId, msg.query, msg.kind ?? "file");
        break;
      case "stageFiles":
        void this.stageDroppedFiles(msg);
        break;
      case "pickAttachments":
        void this.pickAttachments();
        break;
      case "openImage":
        void this.openImageAttachment(msg.dataUrl);
        break;
      case "saveAuth":
        await this.saveAuthAndReconnect(
          msg.baseUrl,
          msg.apiKey,
          msg.modelName,
          msg.profileName ?? null,
          msg.replaceName ?? null,
        );
        break;
      case "clearAuth":
        await this.context.workspaceState.update(WORKSPACE_PROFILE_KEY, undefined);
        await this.context.workspaceState.update(WORKSPACE_MODEL_KEY, undefined);
        this.store.setAuth(await this.buildAuthState(false, true));
        break;
      case "activateProfile":
        await this.activateProfile(msg.name);
        break;
      case "deleteProfile":
        await this.deleteProfile(msg.name);
        break;
      case "setOnboardingDismissed":
        await this.context.workspaceState.update(ONBOARDING_DISMISSED_KEY, msg.dismissed === true);
        this.store.setAuth(
          await this.buildAuthState(
            this.store.getState().auth.authenticated,
            this.store.getState().auth.needsSetup,
          ),
        );
        break;
      case "loadSession":
        await this.restoreSession(msg.sessionId);
        break;
      case "deleteSession":
        await this.deleteSession(msg.sessionId);
        break;
      case "setSessionFlags":
        this.setSessionFlags(msg.sessionId, msg.pinned, msg.archived);
        break;
      case "renameSession":
        await this.renameSession(msg.sessionId, msg.label);
        break;
      case "refreshAuth": {
        // Dropdown/card opened: recompute the profile list fresh (SecretStorage
        // + settings.json) without touching the connection-scoped flags.
        const auth = this.store.getState().auth;
        this.store.setAuth(await this.buildAuthState(auth.authenticated, auth.needsSetup));
        break;
      }
      case "refreshModels":
        // Dropdown opened: re-query /models (may take seconds — fire and forget;
        // the store pushes a snapshot when the fresh list lands).
        void this.refreshLiveModels();
        break;
      case "restartCli":
        await this.restartCli();
        break;
      case "openSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "iflow");
        break;
      case "setHostSettings": {
        // Panel edits always land in USER settings: ConfigurationTarget.Global
        // is the scope VSCode Settings Sync carries across machines. Writing
        // workspace/folder scope here would make them machine-local.
        const writes: Array<[string, unknown]> = [];
        if (typeof msg.nextStepSuggestions === "boolean") writes.push(["nextStepSuggestions", msg.nextStepSuggestions]);
        if (typeof msg.autoCompressOnIdle === "boolean") writes.push(["autoCompressOnIdle", msg.autoCompressOnIdle]);
        if (typeof msg.autoMemoryCapture === "boolean") writes.push(["autoMemoryCapture", msg.autoMemoryCapture]);
        if (typeof msg.autoTitle === "boolean") writes.push(["autoTitle", msg.autoTitle]);
        // Timeout ceilings in seconds; 0 = 「不限制」 for all three.
        if (msg.memoryExtractTimeoutSeconds !== undefined && Number.isFinite(msg.memoryExtractTimeoutSeconds)) {
          writes.push([
            "memoryExtractTimeoutSeconds",
            Math.min(600, Math.max(0, Math.trunc(msg.memoryExtractTimeoutSeconds))),
          ]);
        }
        if (msg.nextStepTimeoutSeconds !== undefined && Number.isFinite(msg.nextStepTimeoutSeconds)) {
          writes.push([
            "nextStepTimeoutSeconds",
            Math.min(300, Math.max(0, Math.trunc(msg.nextStepTimeoutSeconds))),
          ]);
        }
        if (msg.compressTimeoutSeconds !== undefined && Number.isFinite(msg.compressTimeoutSeconds)) {
          writes.push([
            "compressTimeoutSeconds",
            Math.min(600, Math.max(0, Math.trunc(msg.compressTimeoutSeconds))),
          ]);
        }
        if (msg.autoCompressThresholdPercent !== undefined && Number.isFinite(msg.autoCompressThresholdPercent)) {
          writes.push([
            "autoCompressThresholdPercent",
            Math.min(100, Math.max(50, Math.trunc(msg.autoCompressThresholdPercent))),
          ]);
        }
        if (typeof msg.restoreLastSession === "boolean") writes.push(["restoreLastSession", msg.restoreLastSession]);
        if (typeof msg.autoOpenPanel === "boolean") writes.push(["autoOpenPanel", msg.autoOpenPanel]);
        if (typeof msg.warmStart === "boolean") writes.push(["warmStart", msg.warmStart]);
        if (typeof msg.soundFeedback === "boolean") writes.push(["soundFeedback", msg.soundFeedback]);
        if (typeof msg.checkpoints === "boolean") writes.push(["checkpoints", msg.checkpoints]);
        if (msg.osNotifications !== undefined && OS_NOTIFICATION_MODES.includes(msg.osNotifications)) {
          writes.push(["osNotifications", msg.osNotifications]);
        }
        if (msg.language !== undefined && CLI_LANGUAGES.includes(msg.language)) {
          writes.push(["language", msg.language]);
        }
        if (msg.defaultMode !== undefined && DEFAULT_MODES.includes(msg.defaultMode)) {
          writes.push(["defaultMode", msg.defaultMode]);
        }
        if (msg.approvalMode !== undefined && CLI_APPROVAL_MODES.includes(msg.approvalMode)) {
          writes.push(["approvalMode", msg.approvalMode]);
        }
        if (msg.theme !== undefined && UI_THEMES.includes(msg.theme)) writes.push(["theme", msg.theme]);
        if (msg.auroraIntensity !== undefined && Number.isFinite(msg.auroraIntensity)) {
          writes.push(["auroraIntensity", Math.min(100, Math.max(0, Math.round(msg.auroraIntensity)))]);
        }
        if (msg.uiFontSize !== undefined && UI_FONT_SIZES.includes(msg.uiFontSize)) {
          writes.push(["uiFontSize", msg.uiFontSize]);
        }
        if (msg.uiDensity !== undefined && UI_DENSITIES.includes(msg.uiDensity)) {
          writes.push(["uiDensity", msg.uiDensity]);
        }
        if (typeof msg.nodePath === "string") writes.push(["nodePath", msg.nodePath]);
        if (typeof msg.checkpointDir === "string") writes.push(["checkpointDir", msg.checkpointDir]);
        if (msg.checkpointMaxFiles !== undefined && Number.isFinite(msg.checkpointMaxFiles) && msg.checkpointMaxFiles >= 1) {
          writes.push(["checkpointMaxFiles", Math.trunc(msg.checkpointMaxFiles)]);
        }
        if (msg.checkpointMaxFileMB !== undefined && Number.isFinite(msg.checkpointMaxFileMB) && msg.checkpointMaxFileMB >= 0) {
          writes.push(["checkpointMaxFileMB", Math.trunc(msg.checkpointMaxFileMB)]);
        }
        if (msg.checkpointMaxTurns !== undefined && Number.isFinite(msg.checkpointMaxTurns) && msg.checkpointMaxTurns >= 0) {
          writes.push(["checkpointMaxTurns", Math.trunc(msg.checkpointMaxTurns)]);
        }
        if (msg.checkpointMaxSizeMB !== undefined && Number.isFinite(msg.checkpointMaxSizeMB) && msg.checkpointMaxSizeMB >= 0) {
          writes.push(["checkpointMaxSizeMB", Math.trunc(msg.checkpointMaxSizeMB)]);
        }
        if (Array.isArray(msg.contextWindowOverrides) && msg.contextWindowOverrides.every((v) => typeof v === "string")) {
          writes.push(["contextWindowOverrides", msg.contextWindowOverrides]);
        }
        if (Array.isArray(msg.costTable) && msg.costTable.every((v) => typeof v === "string")) {
          writes.push(["costTable", msg.costTable]);
        }
        if (Array.isArray(msg.thinkingModelRules)) {
          writes.push(["thinkingModelRules", sanitizeThinkingRules(msg.thinkingModelRules)]);
        }
        // 子会话并发上限：先归一化再落盘，面板不该把 0 / 越界值写进 settings.json。
        if (msg.superAgentMaxConcurrent !== undefined && Number.isFinite(msg.superAgentMaxConcurrent)) {
          writes.push(["superAgent.maxConcurrent", clampMaxConcurrentSuperSessions(msg.superAgentMaxConcurrent)]);
        }
        for (const [key, value] of writes) await this.writeUserSetting(key, value);
        // 调高上限后排队的子会话立刻有机会起跑；调低不影响已在运行的会话，
        // 但 pump 本身是幂等且只按新上限放行，所以两种情况都能直接调。
        if (msg.superAgentMaxConcurrent !== undefined) this.superAgent?.pumpQueue();
        // Turning suggestions off must also retract the chips already on screen.
        if (msg.nextStepSuggestions === false) this.store.suggestNextSteps([]);
        // The theme message carries the aurora opacity; repaint immediately
        // instead of waiting for the configuration listener round trip.
        if (msg.auroraIntensity !== undefined) this.postTheme();
        this.postHostSettings();
        break;
      }
      case "listMcpServers":
        this.sendMcpServers();
        break;
      case "saveMcpServers":
        this.saveMcpServers(msg.scope, msg.servers);
        break;
      case "mcpStatus":
        void this.sendMcpStatus();
        break;
      case "fetchModelMetadata":
        void this.fetchModelMetadata();
        break;
      case "cancelModelMetadata":
        this.cancelModelMetadata();
        break;
      case "listAssets":
        void this.assets.sendState(msg.requestId);
        break;
      case "readAsset":
        void this.assets.readFile(msg.path, msg.requestId);
        break;
      case "saveAsset":
        void this.assets.saveFile({
          path: msg.path,
          content: msg.content,
          ...(msg.expectedHash !== undefined ? { expectedHash: msg.expectedHash } : {}),
          ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}),
        });
        break;
      case "createAsset":
        void this.assets.createFile({
          kind: msg.kind,
          scope: msg.scope,
          name: msg.name,
          content: msg.content,
          ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}),
        });
        break;
      case "deleteAsset":
        void this.assets.deleteFile(msg.path, msg.requestId);
        break;
      case "generateAsset":
        void this.generateAsset(msg.requestId, msg.kind, msg.name, msg.requirement);
        break;
      case "listMemory":
        void this.memory.sendState(msg.requestId);
        break;
      case "readMemoryFile":
        void this.memory.readFile(msg.path);
        break;
      case "saveMemoryFile":
        void this.memory.saveFile({
          path: msg.path,
          content: msg.content,
          ...(msg.expectedHash !== undefined ? { expectedHash: msg.expectedHash } : {}),
        });
        break;
      case "appendMemoryFact":
        void this.memory.appendFact({
          scope: msg.scope,
          fact: msg.fact,
          ...(msg.path ? { path: msg.path } : {}),
          ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}),
        });
        break;
      case "deleteMemoryFacts":
        void this.memory.deleteFacts({ path: msg.path, factIds: msg.factIds });
        break;
      case "createProjectMemory":
        void this.memory.createProjectMemory(msg.fileName);
        break;
      case "applyMemoryCandidates":
        void this.memory.applyCandidates(msg.candidates, msg.sessionId);
        break;
      case "dismissMemoryCandidates":
        this.memory.dismissCandidates(msg.sessionId);
        break;
      case "openMemoryFile":
        void this.memory.openFile(msg.path);
        break;
      case "generateKnowledge":
        void this.memory.generateKnowledge(msg.jobId, msg.mode ?? "incremental");
        break;
      case "setKnowledgeInjection":
        void this.memory.setKnowledgeInjection(msg.path, msg.injected);
        break;
      case "openKnowledgeFile":
        void this.memory.openKnowledgeFile(msg.path);
        break;
      case "listApprovalPolicy":
        void this.sendApprovalPolicy();
        break;
      case "saveApprovalPolicy":
        await this.saveApprovalPolicy(msg.rules);
        break;
      case "dismissApprovalRuleDraft":
        this.approvalDraft = null;
        void this.sendApprovalPolicy();
        break;
      case "regenerate":
        await this.regenerate();
        break;
      case "deleteUserMessage":
        await this.deleteUserMessage(msg.blockId);
        break;
      case "editAndResend":
        await this.editAndResend(msg.blockId, msg.text);
        break;
      case "exportSession":
        await this.exportActiveSession(msg.format);
        break;
      case "enhancePrompt":
        await this.enhancePrompt(msg.requestId, msg.text);
        break;
      case "cancelEnhance":
        this.cancelEnhance(msg.requestId);
        break;
      case "toastAction":
        this.handleToastAction(msg.actionId, msg.toastId);
        break;
      case "togglePlanItem":
        this.store.togglePlanItem(msg.blockId, msg.index);
        break;
      case "exportToolOutput":
        await this.exportToolOutput(msg.blockId);
        break;
      case "qqSettingsPatch":
        await this.handleQqSettingsPatch(msg.patch);
        break;
      case "qqSecretsWrite":
        await this.handleQqSecretsWrite(msg.botToken, msg.appSecret);
        break;
      case "qqTaskAction":
        await this.handleQqTaskAction(msg.taskId, msg.action, msg.text);
        break;
      case "qqConfigAction":
        await this.handleQqConfigAction(msg.action);
        break;
      case "qqManagedSetup":
        await this.handleQqManagedSetup(msg.action);
        break;
      default:
        // C10: version-mismatch tripwire — a webview built from a different
        // commit can send message kinds this host does not know; without a
        // default they would be dropped silently.
        this.log.warn(`webview → host: unknown message type "${(msg as { type?: string }).type}"`);
        break;
    }
  }

  private postToWebview(message: unknown): void {
    // Single container: the editor tab. Snapshots/theme/etc. all go here.
    if (this.editorPanel) void this.editorPanel.webview.postMessage(message);
  }

  private postSnapshot(): void {
    // Delegate to the store: it stamps `blockVersion` and maintains the P-1
    // patch anchors; a snapshot pushed here bypassing those would corrupt the
    // webview's blockPatch anchoring.
    this.store.pushSnapshot();
  }

  /** Forward the editor color theme so the panel can follow it by default.
   * Also carries the iflow.auroraIntensity setting — the webview scales the
   * background aurora light-spot opacity with it. */
  private postTheme(): void {
    const kind = vscode.window.activeColorTheme.kind;
    const light = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
    const auroraIntensity = vscode.workspace.getConfiguration("iflow").get<number>("auroraIntensity", 35);
    this.postToWebview({ type: "theme", kind: light ? "light" : "dark", auroraIntensity });
  }

  /** Write one panel-owned setting to USER settings (the scope VSCode
   * Settings Sync carries). Validation happens at the call site. */
  private async writeUserSetting(key: string, value: unknown): Promise<void> {
    try {
      await vscode.workspace.getConfiguration("iflow").update(key, value, vscode.ConfigurationTarget.Global);
    } catch (error) {
      const detail = errorMessage(error);
      this.log.warn(`failed to update ${key}: ${detail}`);
      // A silent failure made the control look like it "snapped back" on its
      // own — say which setting could not be written (the value the user sees
      // is the one VSCode still has on disk).
      this.store.sendToast("warning", vscode.l10n.t("设置写入失败：{0}", key));
    }
  }

  // --- configurable ceilings (iflow.* settings) ------------------------------

  /**
   * Read one timeout setting (seconds) and clamp it to [0, maxSeconds].
   * A missing / non-numeric / negative value falls back to the built-in
   * default — a hand-edited settings.json must never wedge the panel. 0 is
   * returned as-is: it is the 「不限制」 value of every ceiling here.
   */
  private timeoutSeconds(key: string, fallbackSeconds: number, maxSeconds: number): number {
    const raw = vscode.workspace.getConfiguration("iflow").get<number>(key, fallbackSeconds);
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return fallbackSeconds;
    return Math.min(maxSeconds, Math.trunc(raw));
  }

  /** Turn-end memory-extraction ceiling (ms). `iflow.memoryExtractTimeoutSeconds`
   * — 0 means 「不限制」, which also lifts the idle watchdog (see
   * followupCeiling): a wedged gateway then holds the lane until it answers. */
  private memoryExtractTimeoutMs(): number {
    return this.timeoutSeconds("memoryExtractTimeoutSeconds", MEMORY_EXTRACT_TIMEOUT_MS / 1000, 600) * 1000;
  }

  /** Next-step prediction ceiling (ms). `iflow.nextStepTimeoutSeconds` —
   * 0 means 「不限制」 (same idle-watchdog coupling as above). */
  private nextStepTimeoutMs(): number {
    return this.timeoutSeconds("nextStepTimeoutSeconds", NEXT_STEP_TIMEOUT_MS / 1000, 300) * 1000;
  }

  /** `/compress` turn ceiling (ms). `iflow.compressTimeoutSeconds` — 0 means
   * 「不限制」, which is the historical behaviour: compressing a huge session
   * can legitimately take minutes (pitfall #13 forbids killing it silently). */
  private compressTimeoutMs(): number {
    return this.timeoutSeconds("compressTimeoutSeconds", 0, 600) * 1000;
  }

  /** Context occupancy (ratio) that triggers the turn-end auto-compress.
   * `iflow.autoCompressThresholdPercent` — percent in the settings, ratio
   * here. The band starts at 50%: below that the panel would compress a
   * healthy session on nearly every turn. */
  private autoCompressThresholdRatio(): number {
    const raw = vscode.workspace.getConfiguration("iflow").get<number>(
      "autoCompressThresholdPercent",
      Math.round(CONTEXT_AUTOCOMPRESS_RATIO * 100),
    );
    if (typeof raw !== "number" || !Number.isFinite(raw)) return CONTEXT_AUTOCOMPRESS_RATIO;
    return Math.min(100, Math.max(50, Math.trunc(raw))) / 100;
  }

  /** Mirror every extension setting the settings panel renders. VSCode
   * configuration stays authoritative; a direct edit in VSCode re-pushes via
   * the onDidChangeConfiguration listener. */
  private postHostSettings(): void {
    const config = vscode.workspace.getConfiguration("iflow");
    const stringList = (key: string): string[] => {
      const raw = config.get<unknown>(key, []);
      return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
    };
    this.postToWebview({
      type: "hostSettings",
      nextStepSuggestions: config.get<boolean>("nextStepSuggestions", true),
      autoCompressOnIdle: config.get<boolean>("autoCompressOnIdle", false),
      autoMemoryCapture: config.get<boolean>("autoMemoryCapture", true),
      autoTitle: config.get<boolean>("autoTitle", true),
      memoryExtractTimeoutSeconds: this.timeoutSeconds(
        "memoryExtractTimeoutSeconds",
        MEMORY_EXTRACT_TIMEOUT_MS / 1000,
        600,
      ),
      nextStepTimeoutSeconds: this.timeoutSeconds("nextStepTimeoutSeconds", NEXT_STEP_TIMEOUT_MS / 1000, 300),
      compressTimeoutSeconds: this.timeoutSeconds("compressTimeoutSeconds", 0, 600),
      autoCompressThresholdPercent: Math.round(this.autoCompressThresholdRatio() * 100),
      restoreLastSession: config.get<boolean>("restoreLastSession", false),
      autoOpenPanel: config.get<boolean>("autoOpenPanel", false),
      warmStart: config.get<boolean>("warmStart", true),
      soundFeedback: config.get<boolean>("soundFeedback", true),
      osNotifications: asOsNotifications(config.get<string>("osNotifications", "approvals")),
      language: asCliLanguage(config.get<string>("language", "")),
      defaultMode: asDefaultMode(config.get<string>("defaultMode", "smart")),
      approvalMode: asCliApprovalMode(config.get<string>("approvalMode", "")),
      theme: asUiTheme(config.get<string>("theme", "auto")),
      auroraIntensity: Math.min(100, Math.max(0, config.get<number>("auroraIntensity", 35))),
      uiFontSize: asUiFontSize(config.get<string>("uiFontSize", "standard")),
      uiDensity: asUiDensity(config.get<string>("uiDensity", "standard")),
      nodePath: config.get<string>("nodePath", ""),
      checkpoints: config.get<boolean>("checkpoints", true),
      checkpointMaxFiles: config.get<number>("checkpointMaxFiles", 50_000),
      checkpointMaxFileMB: config.get<number>("checkpointMaxFileMB", 300),
      checkpointDir: config.get<string>("checkpointDir", ""),
      checkpointMaxTurns: config.get<number>("checkpointMaxTurns", 0),
      checkpointMaxSizeMB: config.get<number>("checkpointMaxSizeMB", 0),
      contextWindowOverrides: stringList("contextWindowOverrides"),
      costTable: stringList("costTable"),
      thinkingModelRules: sanitizeThinkingRules(config.get<unknown>("thinkingModelRules", [])),
      // 子会话并发上限：手改 settings.json 可能留下 0 / Infinity，归一化后再给 UI。
      superAgentMaxConcurrent: clampMaxConcurrentSuperSessions(
        config.get<number>("superAgent.maxConcurrent", DEFAULT_MAX_CONCURRENT_SUPER_SESSIONS),
      ),
    });
  }

  /**
   * Turn-finished / turn-failed sound cue — the UNIVERSAL completion signal:
   * it plays in every panel/focus state and only `iflow.soundFeedback`
   * (default on) gates it. History: 8441788 shipped it ungated; cd1c406 added
   * a watching gate (visible panel AND focused window) plus toast-exclusivity
   * at the call sites, which together left the chime reachable only in
   * hidden-panel+focused-window — i.e. effectively never, and users reported
   * the cue as vanished (2026-10-13 「生成完成的通知音效消失了」). A watching
   * user hearing the chime is the familiar pre-1.5.0 confirmation, not noise.
   * OS toasts stay ADDITIVE away-notifications with their own gate; when both
   * fire (away + unfocused + `osNotifications: all`) the brief toast system
   * sound + chime overlap is the accepted price of the cue never vanishing
   * again (set `osNotifications: approvals` for a chime-only away cue).
   * Synthesized in the webview (Web Audio), no asset files.
   *
   * `child` is the third, deliberately lighter cue: ONE child session settled
   * (completed / failed / cancelled). It must be distinguishable from `done`
   * by ear — a child finishing is progress, not the main session finishing.
   */
  private postSound(kind: "done" | "error" | "child"): void {
    const cfg = vscode.workspace.getConfiguration("iflow");
    if (cfg.get<boolean>("soundFeedback", true) === false) return;
    this.postToWebview({ type: "playSound", kind });
  }

  // --- M1: OS notifications (P0-5) --------------------------------------------

  /**
   * System-level notification for a user-blocking/attention event, gated on
   * setting × panel-visibility × window-focus (turnDone only) × per-kind
   * throttle (shared/notifications.ts). A visible panel already shows the
   * card — the notification exists exactly for when the user switched away.
   * Delivery itself is fire-and-forget (native toast → in-IDE fallback, see
   * deliverOsNotification). Returns whether the gate fired; callers that also
   * ring a chime must use `notifyOsDecision` — the completion cue needs the
   * block REASON (a duplicate dropped by throttle/cooldown must not leave a
   * lone chime, see `announceTurnDone`).
   */
  private notifyOs(event: OsNotifyEvent, text: string): boolean {
    return this.notifyOsDecision(event, text).fire;
  }

  /**
   * Full gate result — `fire` plus, when it did not fire, WHY. The chime
   * needs the distinction: a notification dropped because the user is
   * watching (or because they turned system toasts off) still leaves the
   * chime as a meaningful cue, while one dropped as a duplicate (throttle /
   * content cooldown) carries no new information at all.
   */
  private notifyOsDecision(event: OsNotifyEvent, text: string): OsNotifyDecision {
    const setting = vscode.workspace.getConfiguration("iflow").get<string>("osNotifications", "approvals");
    const gate = gateOsNotification({
      event,
      setting,
      panelVisible: this.panelVisible,
      windowFocused: vscode.window.state.focused,
      nowMs: Date.now(),
      gate: this.osNotifyGate,
      // Content cooldown: an agent retrying the same tool re-fires the
      // byte-identical approval line every >5s (screenshot 2026-10-15);
      // identical text within the cooldown window is dropped.
      contentKey: text,
    });
    if (!gate.fire) return gate;
    this.osNotifyGate = gate.gate;
    void this.deliverOsNotification(text);
    return gate;
  }

  /**
   * Shared completion cue: native toast (gated) + chime (universal, subject-
   * specific).
   *
   * Symmetry rule (2026-11-15): the chime must accompany something the user
   * can perceive. `notifyOsDecision` decides whether the away-toast fires;
   * when it did not, the chime still rings unless the drop reason was
   * "duplicate" (throttle / content cooldown) — those mean an identical line
   * was delivered moments ago and the user got no new signal, so a lone
   * chime would read as "a notification appeared" while the UI shows
   * nothing. Every other drop reason (watching, osNotifications off, focused
   * window) leaves the chime as the user's only cue and must still ring.
   *
   * The three wrappers below are DIFFERENT subjects and must stay separate
   * (2026-11-16 user request) — same event/chime for all of them made 「一个
   * 子会话干完」 and 「主会话汇报完」 indistinguishable:
   *   - announceTurnDone    → `turnDone`,    done 音, 「iFlow 已完成本轮回复」
   *   - announceSuperReport → `superReport`, done 音, 「主会话已汇报子会话结果」
   *   - announceChildDone   → `childDone`,   child 音, 「子会话「{0}」已…」
   * Host bookkeeping turns that are NOT reports (action receipts, delegated
   * user-turn backfill) never call any of these — they stay silent.
   */
  private announceCue(event: OsNotifyEvent, text: string, kind: "done" | "child"): void {
    const decision = this.notifyOsDecision(event, text);
    if (!decision.fire && isDuplicateNotificationBlock(decision.reason)) return;
    this.postSound(kind);
  }

  /** A REAL user turn (typed prompt or regenerate) finished. */
  private announceTurnDone(text: string): void {
    this.announceCue("turnDone", text, "done");
  }

  /**
   * The main session's hidden Super Agent report turn settled: the main agent
   * has read the child results and reported back. That IS main-session work
   * finishing, so it keeps the regular completion chime — but on its own OS
   * event (`superReport`) so it is never conflated with a child settling.
   */
  private announceSuperReport(text: string): void {
    this.announceCue("superReport", text, "done");
  }

  /** ONE child session reached a terminal state (per-child light cue). */
  private announceChildDone(text: string): void {
    this.announceCue("childDone", text, "child");
  }

  /**
   * Deferred card toast (policy 2026-10-16: OS reminders exist only while the
   * question/approval/plan card is displayed). `cardStillDisplayed` answers
   * "still pending AND still owning its webview slot" at FIRE time — the
   * synchronous call site cannot see a same-tick slot replacement from a
   * parallel permission request, but the deferred check does. A toast for an
   * invisible card is what stranded the user (three 「等待审批」 toasts, no
   * card in the panel); the short confirm delay costs an away user nothing,
   * a notification is not an interaction.
   */
  private toastWhileDisplayed(
    cardStillDisplayed: () => boolean,
    event: OsNotifyEvent,
    text: () => string,
  ): void {
    setTimeout(() => {
      if (this.disposed) return;
      if (!cardStillDisplayed()) return;
      this.notifyOs(event, text());
    }, CARD_TOAST_CONFIRM_MS);
  }

  /**
   * Toast transport policy: OS-level notification first (macOS terminal-notifier
   * with vscode:// click-through, Windows SnoreToast — src/acp/os-notify.ts),
   * in-IDE vscode.window.showInformationMessage ONLY as the fallback when the
   * native path is unavailable (Linux, missing/failing binary). The in-IDE form
   * keeps the "打开面板" pick; the macOS toast click-through rides the URI
   * handler registered in extension.ts instead.
   */
  private async deliverOsNotification(text: string): Promise<void> {
    const notify = this.services.osNotify ?? ((title: string, message: string) => sendOsNotification(this.context.extensionPath, title, message));
    let fired = false;
    try {
      fired = await notify("iFlow", text);
    } catch {
      fired = false; // delivery must never break the flow that produced it
    }
    if (fired) return;
    const openLabel = vscode.l10n.t("打开面板");
    void vscode.window.showInformationMessage(text, openLabel).then((pick) => {
      if (pick === openLabel) this.openEditorTab();
    });
  }

  // --- M1: internal prompts (P1-5 enhance / turn-end follow-up batch) ----
  //
  // Isolation discipline: an internal prompt must NOT enter the transcript,
  // the CLI chatHistory of the user session, or the regenerate chain.
  // Fourth-wave revision (gateway-probed 2026-10-09, pitfall #26): it no
  // longer runs on a CLI session at all — the CLI's ~61K-token fixed input
  // (system prompt + every tool schema) pushes thinking models into 180s+
  // reasoning loops that never produce content, while the same enhance task
  // sent DIRECTLY to the endpoint converged in 60.3s. A plain text rewrite
  // never needed the agent session; streamChatCompletion talks to the
  // OpenAI-compatible endpoint itself, so there is no session to intercept,
  // no tool-call surface to guard, and nothing to cancel server-side.

  /** Wall-clock ceiling / idle window for the in-flight internal prompt.
   * Instance fields (constants as defaults) so tests can inject small values. */
  private internalPromptTimeoutMs = INTERNAL_PROMPT_TIMEOUT_MS;
  private internalPromptIdleMs = INTERNAL_PROMPT_IDLE_MS;

  /** F3 Phase 3: knowledge-index completion on its own lane. */
  private async runKnowledgePrompt(text: string): Promise<string | null> {
    if (this.disposed || this.knowledgePromptBusy) return null;
    this.knowledgePromptBusy = true;
    try {
      return await this.completeInternalPrompt(
        text,
        KNOWLEDGE_PROMPT_TIMEOUT_MS,
        KNOWLEDGE_PROMPT_IDLE_MS,
      );
    } finally {
      this.knowledgePromptBusy = false;
    }
  }

  /**
   * F4: draft one asset file (command / agent / skill) from a free-text
   * requirement. Reply: `assetGenerated`.
   *
   * Own busy lane, and a direct gateway completion rather than an agent
   * session (pitfall #26 — a plain text draft needs no tools, and the CLI's
   * fixed ~61K-token input derails thinking models). The answer is normalized
   * by shared/asset-gen.ts so the CLI's loader will actually pick the file up
   * (fences stripped, required frontmatter keys guaranteed). NOTHING is
   * written here: the draft only fills the card's editor, and the user's
   * 「创建」 click is what reaches disk.
   */
  private async generateAsset(
    requestId: number,
    kind: AssetKind,
    name: string,
    requirement: string,
  ): Promise<void> {
    const reply = (content: string, error?: string): void => {
      if (this.disposed) return;
      this.postToWebview({
        type: "assetGenerated",
        requestId,
        content,
        ...(error !== undefined ? { error } : {}),
      });
    };
    if (this.assetGenBusy) {
      reply("", vscode.l10n.t("已有生成请求进行中，请稍后再试"));
      return;
    }
    this.assetGenBusy = true;
    try {
      const raw = await this.completeInternalPrompt(
        buildAssetGenPrompt(kind, name, requirement),
        ASSET_GEN_TIMEOUT_MS,
        ASSET_GEN_IDLE_MS,
      );
      if (this.disposed) return;
      if (!raw) {
        this.log.warn(`asset generation returned nothing (kind=${kind})`);
        reply("", vscode.l10n.t("生成失败（服务无响应，或没有配置模型），请重试或直接手写内容"));
        return;
      }
      this.log.info(`asset draft generated (kind=${kind}, ${raw.length} chars)`);
      reply(normalizeGeneratedAsset(raw, kind, name));
    } finally {
      this.assetGenBusy = false;
    }
  }

  /** Workspace scan for the knowledge digest. Uses findFiles so .gitignore /
   * search excludes apply; `.iflow` itself is skipped (knowledge is generated
   * from source, not from its own output). */
  private async scanKnowledgeWorkspace(): Promise<WorkspaceScan> {
    const cwd = this.sessionCwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const root = cwd
      ? roots.find((candidate) => isWithin(candidate, cwd)) ?? cwd
      : roots[0]
        ? path.resolve(roots[0])
        : null;
    if (!root) return { files: [], truncated: false };
    const limit = 2_000;
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(root, "**/*"),
      "**/{node_modules,.git,dist,build,out,coverage,vendor,.next,.venv,target,__pycache__,.iflow}/**",
      limit + 1,
    );
    const out: WorkspaceFile[] = [];
    // Stat in small batches: 2000 concurrent vscode.workspace.fs.stat calls can
    // swamp the extension host (and remote workspaces), while sequential calls
    // take too long for a refresh.
    const batchSize = 32;
    for (let i = 0; i < uris.length; i += batchSize) {
      const batch = uris.slice(i, i + batchSize);
      const entries = await Promise.all(
        batch.map(async (uri): Promise<WorkspaceFile | null> => {
          const rel = path.relative(root, uri.fsPath).replace(/\\/g, "/");
          if (!rel || rel.startsWith("../")) return null;
          try {
            const info = await vscode.workspace.fs.stat(uri);
            if ((info.type & vscode.FileType.File) === 0) return null;
            return { path: uri.fsPath, rel, size: info.size, mtimeMs: info.mtime };
          } catch {
            return null;
          }
        }),
      );
      for (const entry of entries) if (entry) out.push(entry);
    }
    out.sort((a, b) => a.rel.localeCompare(b.rel));
    const truncated = uris.length > limit || out.length > limit;
    return { files: out.slice(0, limit), truncated };
  }

  private async readKnowledgeFile(file: string): Promise<string | null> {
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
      return Buffer.from(data).toString("utf8");
    } catch {
      return null;
    }
  }

  /** Run one internal prompt directly against the active endpoint; resolves
   * with the model's text (trimmed) or null on any failure. Never throws.
   * `signal` lets a caller (enhance cancel) abort the gateway stream.
   * `opts` overrides the shared ceilings for callers that need their own
   * budget (the metadata sweep reads a large source set and needs more
   * wall-clock than a one-line rewrite). */
  private async runInternalPrompt(
    text: string,
    signal?: { aborted: boolean; onAbort?: (cancel: () => void) => void },
    opts?: { timeoutMs?: number; idleMs?: number },
  ): Promise<string | null> {
    if (this.disposed || this.internalPromptBusy) return null;
    this.internalPromptBusy = true;
    try {
      return await this.completeInternalPrompt(
        text,
        opts?.timeoutMs ?? this.internalPromptTimeoutMs,
        opts?.idleMs ?? this.internalPromptIdleMs,
        signal,
      );
    } finally {
      this.internalPromptBusy = false;
    }
  }

  /** Shared body of every internal prompt: resolve the panel-owned endpoint
   * and model, stream one direct completion, and apply the salvage policy.
   * Callers own the busy lane and the request lifecycle. */
  private async completeInternalPrompt(
    text: string,
    timeoutMs: number,
    idleMs: number,
    signal?: { aborted: boolean; onAbort?: (cancel: () => void) => void },
  ): Promise<string | null> {
    if (this.disposed) return null;
    // Endpoint: panel-owned credentials (SecretStorage) first — the same
    // source the user session authenticates with; the CLI's settings.json
    // profile is the fallback (terminal-configured gateway). Never rely on
    // the CLI process env: internal prompts bypass it entirely now.
    const endpoint = (await this.resolveWorkspaceHandshakeCreds().catch(() => null)) ?? (await loadCredentials(this.context.secrets).catch(() => null)) ?? readActiveEndpoint();
    if (!endpoint || this.disposed) return null;
    // Model: the panel's current selection (enhancement quality, pitfall #23
    // — store value is authoritative); fall back to the profile's model.
    const model = this.store.getState().currentModelId || endpoint.modelName;
    if (!model) {
      this.log.warn("internal prompt skipped: no model configured");
      return null;
    }
    const panel = this;
    const result = await streamChatCompletion(endpoint, model, text, {
      timeoutMs,
      idleMs,
      signal: {
        get aborted() {
          return panel.disposed || (signal?.aborted ?? false);
        },
        // Forward the caller's synchronous-cancel hook (enhance uses it to
        // release the busy lane the same tick a cancel arrives).
        onAbort: signal?.onAbort,
      },
    });
    if (this.disposed) return null;
    // Partial-result salvage: on a slow gateway the ceiling can fire after
    // the content already streamed (gateway-probed 2026-10-09: tencent/hy3
    // streams the full rewrite at 60-75s but the turn stop arrives late).
    // timeout/stalled salvage what streamed; a transport failure discards
    // (its partial is not trustworthy) and a user cancel is silent.
    const trimmed = result.text.trim();
    const salvageable = result.reason === "complete" || result.reason === "timeout" || result.reason === "stalled";
    if (salvageable && trimmed) {
      if (result.reason !== "complete") {
        this.log.info(`internal prompt salvaged (${result.reason}) with ${trimmed.length} chars`);
      }
      return trimmed;
    }
    this.log.info(`internal prompt ${result.reason === "cancelled" ? "cancelled" : `failed (${result.reason})`}`);
    return null;
  }

  /** P1-5: enhance the composer draft. Reply: `enhancedPrompt`. */
  private async enhancePrompt(requestId: number, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      this.postToWebview({ type: "enhancedPrompt", requestId, text: "", error: vscode.l10n.t("没有可增强的内容") });
      return;
    }
    if (this.internalPromptBusy) {
      this.postToWebview({ type: "enhancedPrompt", requestId, text: "", error: vscode.l10n.t("已有内部请求进行中，请稍后再试") });
      return;
    }
    // Anti-footgun tracking: `cancelEnhance` flips `control.cancelled` and
    // invokes the stream's abort hook (synchronous settle → the busy lane is
    // free the same tick, so re-clicking enhance is not busy-rejected, and
    // the socket is destroyed immediately). The reply is additionally dropped
    // when this entry was superseded (stale requestId) or the session changed
    // while the rewrite was in flight — otherwise the enhancement would
    // ghost-fill into a different session's composer after a switch.
    const control = { cancelled: false };
    let abortStream: () => void = () => {};
    const state = this.store.getState();
    this.pendingEnhance = {
      requestId,
      cancel: () => {
        control.cancelled = true;
        abortStream();
      },
      sessionId: state.activeSessionId ?? state.sessionId,
    };
    const enhanced = await this.runInternalPrompt(renderPrompt("enhance", { request: stripFileMentions(trimmed) }), {
      get aborted() {
        return control.cancelled;
      },
      onAbort: (cancel) => {
        abortStream = cancel;
      },
    });
    const pending = this.pendingEnhance;
    if (pending?.requestId === requestId) this.pendingEnhance = null;
    if (this.disposed) return;
    const current = this.store.getState();
    const currentSession = current.activeSessionId ?? current.sessionId;
    if (pending?.requestId !== requestId || currentSession !== pending.sessionId) {
      // Cancelled, superseded, or the user switched sessions mid-rewrite:
      // the composer already reset itself — a late reply would ghost-fill.
      return;
    }
    if (enhanced) {
      this.postToWebview({ type: "enhancedPrompt", requestId, text: enhanced });
    } else {
      this.postToWebview({ type: "enhancedPrompt", requestId, text: "", error: vscode.l10n.t("增强失败，已保留原文") });
    }
  }

  /** P1-5: user dismissed an in-flight enhancement (re-clicked the wand,
   * submitted, or switched()). Aborts the gateway stream; sends NO reply —
   * the composer resets its pending state locally. */
  private cancelEnhance(requestId: number): void {
    const pending = this.pendingEnhance;
    if (pending?.requestId !== requestId) return;
    this.pendingEnhance = null;
    pending.cancel();
  }

  // --- 「联网补充模型数据」 (settings-panel web-search fetch) ------------------
  //
  // The panel searches the web ITSELF and asks the model to extract the
  // metadata from the retrieved snippets:
  //   endpoint + live model ids → one search query per model id (+ two
  //   market-wide ones) → snippets become cited sources (S1, S2, …) → ONE
  //   direct completion extracts the JSON envelope → only grounded entries
  //   are APPENDED (shared/model-metadata.ts dedups + validates).
  //
  // Why not a CLI agent session (the first implementation): the bundled CLI
  // only exposes `web_search` when a platform search key is configured and
  // carries no search backend for third-party gateway keys (probed
  // 2026-10-23: the tool is not even in the tool list, and an agent turn
  // answered `{"models":[]}`), while an agent turn drags in the whole system
  // prompt + project memory + tool schemas — measured 56,287 input tokens
  // for a trivial prompt (39,992 system/memory, 12,160 tool schemas). This
  // flow sends a few thousand tokens and needs no CLI session at all.

  private async fetchModelMetadata(): Promise<void> {
    if (this.disposed) return;
    if (this.metadataBusy) {
      this.store.sendToast("info", vscode.l10n.t("已有联网检索进行中，请稍后再试"));
      return;
    }
    // Endpoint: panel-owned credentials first (same chain as internal prompts).
    const endpoint =
      (await this.resolveWorkspaceHandshakeCreds().catch(() => null))
      ?? (await loadCredentials(this.context.secrets).catch(() => null))
      ?? readActiveEndpoint();
    if (!endpoint) {
      this.postToWebview({ type: "modelMetadataState", state: "error", error: vscode.l10n.t("还没有配置 API Key，无法联网检索模型数据。请先在设置里填写 API Key 并保存。") });
      return;
    }
    this.metadataBusy = true;
    this.postToWebview({ type: "modelMetadataState", state: "searching" });
    this.store.sendToast("info", vscode.l10n.t("正在联网检索模型数据…"));
    const control = { cancelled: false };
    let abortCompletion: () => void = () => {};
    this.metadataCancel = () => {
      control.cancelled = true;
      abortCompletion();
    };
    try {
      const liveIds = await queryModelIds(endpoint, 12_000).catch(() => [] as string[]);
      const ids = [...new Set(
        [endpoint.modelName, this.store.getState().currentModelId, ...liveIds].filter((id): id is string => Boolean(id)),
      )];
      if (ids.length === 0) throw new Error(vscode.l10n.t("当前 API 配置未返回模型列表"));
      if (control.cancelled) {
        this.postToWebview({ type: "modelMetadataState", state: "idle" });
        this.store.sendToast("info", vscode.l10n.t("联网检索已取消"));
        return;
      }
      // 1) search sweep — the panel's own HTTP calls, no model involved yet.
      const queries = buildMetadataQueries(ids);
      const hits = await this.runMetadataSearch(queries, control);
      if (control.cancelled) {
        this.postToWebview({ type: "modelMetadataState", state: "idle" });
        this.store.sendToast("info", vscode.l10n.t("联网检索已取消"));
        return;
      }
      const sources = await this.collectMetadataSources(hits, ids, endpoint.baseUrl);
      if (sources.length === 0) {
        const reasonText = vscode.l10n.t("未获取到检索结果，请检查网络后重试");
        this.postToWebview({ type: "modelMetadataState", state: "error", error: reasonText });
        this.store.sendToast("error", reasonText);
        return;
      }
      // 2) extraction — one plain completion over the snippets (no system
      // prompt, no tool schemas, no project memory).
      const answer = await this.runInternalPrompt(
        buildModelMetadataPrompt(ids, sources),
        {
          get aborted() {
            return control.cancelled;
          },
          onAbort: (cancel) => {
            abortCompletion = cancel;
          },
        },
        { timeoutMs: this.metadataTimeoutMs, idleMs: this.metadataIdleMs },
      );
      if (this.disposed) return;
      if (control.cancelled) {
        this.postToWebview({ type: "modelMetadataState", state: "idle" });
        this.store.sendToast("info", vscode.l10n.t("联网检索已取消"));
        return;
      }
      // 3) validate + merge. An entry must cite a source that really mentions
      // the model — an ungrounded row is dropped, never written to settings.
      const entries = parseModelMetadata(answer, sources);
      if (entries.length === 0) {
        const reasonText = vscode.l10n.t("联网检索没有返回可用的数据");
        this.postToWebview({ type: "modelMetadataState", state: "error", error: reasonText });
        this.store.sendToast("error", reasonText);
        return;
      }
      const cfg = vscode.workspace.getConfiguration("iflow");
      const existingRules = sanitizeThinkingRules(cfg.get<unknown>("thinkingModelRules", []));
      const additions = planMetadataAdditions(entries, {
        contextWindowOverrides: cfg.get<string[]>("contextWindowOverrides", []),
        costTable: cfg.get<string[]>("costTable", []),
        thinkingModelRules: existingRules,
      });
      if (additions.total > 0) {
        await this.writeUserSetting("contextWindowOverrides", [...cfg.get<string[]>("contextWindowOverrides", []), ...additions.windows]);
        await this.writeUserSetting("costTable", [...cfg.get<string[]>("costTable", []), ...additions.costs]);
        await this.writeUserSetting("thinkingModelRules", [...existingRules, ...additions.rules]);
        // The thinkingModelRules write triggers the config listener, which
        // re-merges ~/.iflow/thinking-models.json and toasts the sync result.
        this.postHostSettings();
      }
      const doneText = additions.total > 0
        ? vscode.l10n.t("已补充模型元数据：上下文窗口 {0} 条、成本单价 {1} 条、思考规则 {2} 条", additions.windows.length, additions.costs.length, additions.rules.length)
        : vscode.l10n.t("联网检索完成，未发现可补充的新数据");
      this.postToWebview({
        type: "modelMetadataState",
        state: "done",
        added: { windows: additions.windows.length, costs: additions.costs.length, rules: additions.rules.length },
      });
      this.store.sendToast("info", doneText);
      this.log.info(`metadata fetch: ${sources.length} sources → +${additions.windows.length} windows, +${additions.costs.length} costs, +${additions.rules.length} rules`);
    } catch (error) {
      if (this.disposed) return;
      const text = errorMessage(error);
      this.postToWebview({ type: "modelMetadataState", state: "error", error: vscode.l10n.t("联网检索失败：{0}", text) });
      this.store.sendToast("error", vscode.l10n.t("联网检索失败：{0}", text));
      this.log.warn(`metadata fetch failed: ${text}`);
    } finally {
      this.metadataCancel = null;
      this.metadataBusy = false;
    }
  }

  /**
   * Search sweep: one HTTP request per query, capped concurrency, capped
   * per-request time and a wall-clock ceiling for the whole phase. A failed
   * query contributes nothing — the extraction still runs on what came back.
   */
  private async runMetadataSearch(
    queries: readonly string[],
    control: { cancelled: boolean },
  ): Promise<WebSearchHit[]> {
    const deadline = Date.now() + this.metadataSearchPhaseMs;
    const hits: WebSearchHit[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < queries.length) {
        if (control.cancelled || Date.now() >= deadline) return;
        const query = queries[cursor++];
        if (!query) return;
        const found = await searchWeb(query, {
          timeoutMs: this.metadataSearchTimeoutMs,
          limit: MODEL_METADATA_HITS_PER_QUERY,
          snippetChars: MODEL_METADATA_SNIPPET_CHARS,
        }).catch(() => [] as WebSearchHit[]);
        hits.push(...found);
      }
    };
    const workers = Array.from(
      { length: Math.min(MODEL_METADATA_SEARCH_CONCURRENCY, Math.max(1, queries.length)) },
      () => worker(),
    );
    await Promise.all(workers);
    return hits;
  }

  /**
   * Retrieved hits → the citable source list handed to the model.
   *
   * Search snippets alone are thin: measured on a real sweep, only 3 of 70
   * hits carried a context-window or price figure. So the most promising
   * pages are fetched and reduced to their evidence lines (the pricing table
   * usually sits far below the fold, and the page head is nav prose). The
   * remaining snippets fill the budget as context. Every source gets a
   * stable id (S1, S2, …) the answer must cite.
   */
  private async collectMetadataSources(
    hits: readonly WebSearchHit[],
    ids: readonly string[],
    endpointBaseUrl?: string,
  ): Promise<MetadataSource[]> {
    const sources: MetadataSource[] = [];
    let chars = 0;
    const budget = this.metadataSourceChars;
    // One source per page: Bing happily returns the same URL several times
    // (three query variants hit the same pricing page), and a real sweep
    // measured 25 of 37 sources as duplicates of the vendor homepage — pure
    // budget waste that also dilutes the citations the model can choose.
    const claimed = new Set<string>();
    const urlKey = (url: string): string => url.split("#")[0]!.split("?")[0]!.toLowerCase();
    const push = (title: string, url: string, body: string): void => {
      if (chars >= budget) return;
      const key = urlKey(url);
      if (claimed.has(key)) return;
      const room = budget - chars;
      const snippet = body.slice(0, room);
      if (!snippet && !title) return;
      claimed.add(key);
      chars += snippet.length + title.length + url.length;
      sources.push({ id: `S${sources.length + 1}`, title, url, snippet });
    };
    // Hits whose title/snippet mention a requested model id are the relevant
    // ones; among those, the pages that document prices or context windows
    // are the ones worth reading. (This only picks WHICH pages to read — the
    // model still extracts the values.)
    const keys = ids.map((id) => id.toLowerCase()).filter(Boolean);
    const mentions = (hit: WebSearchHit): boolean => {
      const haystack = `${hit.title} ${hit.snippet}`.toLowerCase();
      return keys.some((key) => haystack.includes(key));
    };
    const documentation = /pricing|price|价格|定价|计费|费用|上下文|context ?(window|length)|tokens/i;
    // The official provider site beats third-party comparison pages when both
    // match the query: the same registrable domain as the configured API
    // endpoint (api-docs.deepseek.com vs api.deepseek.com) is the strongest
    // signal that a page is the vendor's own documentation.
    const endpointHost = registrableHost(endpointBaseUrl);
    const score = (hit: WebSearchHit): number => {
      let value = 0;
      if (mentions(hit)) value += 2;
      if (documentation.test(`${hit.title} ${hit.url}`)) value += 1;
      if (endpointHost && urlKey(hit.url).includes(endpointHost)) value += 2;
      return value;
    };
    const ranked = [...hits].sort((a, b) => score(b) - score(a));
    // Dedupe the candidates only; claiming happens in push() when a page
    // actually contributes text. (Claiming up-front made push() skip every
    // successfully fetched page — the official pricing page ranked first and
    // still vanished from the source list.)
    const pages: WebSearchHit[] = [];
    const pageKeys = new Set<string>();
    for (const hit of ranked) {
      if (!hit.url.startsWith("http")) continue;
      const key = urlKey(hit.url);
      if (claimed.has(key) || pageKeys.has(key)) continue;
      pageKeys.add(key);
      pages.push(hit);
      if (pages.length >= MODEL_METADATA_PAGES) break;
    }
    const texts = await Promise.all(
      pages.map((hit) =>
        fetchPageText(hit.url, { timeoutMs: this.metadataSearchTimeoutMs, maxChars: MODEL_METADATA_PAGE_CHARS })
          .catch(() => ""),
      ),
    );
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const text = texts[i] ?? "";
      if (!page || !text) continue;
      push(page.title, page.url, text);
    }
    // Snippets of the top hits — context for pages that failed to load.
    for (const hit of ranked.slice(0, MODEL_METADATA_SNIPPET_HITS)) {
      if (chars >= budget) break;
      push(hit.title, hit.url, hit.snippet.slice(0, MODEL_METADATA_SNIPPET_CHARS));
    }
    return sources;
  }

  /** Settings-panel 「停止检索」: abort the in-flight sweep / completion. The
   * fetch's cancelled branch settles the UI state; the finally clears the
   * busy lane. */
  private cancelModelMetadata(): void {
    this.metadataCancel?.();
  }

  /**
   * Turn-end follow-up: ONE merged internal request covering whichever
   * conveniences are enabled — AI title, next-step prediction and memory
   * extraction. They used to be three separate gateway calls fired from the
   * same completion point, so a settled turn burned up to three model calls
   * regardless of how many settings were on; the reply is one JSON envelope
   * split back apart here (shared/turn-followup.ts).
   *
   * Isolation follows the internal-prompt discipline (pitfall #26): direct
   * endpoint call, no transcript block, no CLI chatHistory entry, no tool
   * surface. Silent on every failure — a missing title, chip batch or memory
   * candidate must never turn a healthy turn red.
   *
   * `allowTitle` is false on a regenerated turn (title generation stays a
   * first-send concern, as before). `conversationTasks` gates the two
   * conversation-derived tasks: a `/compress` turn or a turn-end auto-compress
   * is housekeeping, not new conversation, and must not seed 下一步 chips or
   * memory candidates from compression chatter (2026-10-19 report).
   */
  private async runTurnFollowup(
    sessionId: string,
    opts: { allowTitle: boolean; conversationTasks: boolean },
  ): Promise<void> {
    // Lane discipline: an in-flight enhance means the whole batch is skipped
    // NOW — the title id is NOT registered, so the next turn's completion
    // retries it (the busy check must come before the registration).
    if (this.disposed || this.followupBusy || this.internalPromptBusy) return;
    const state = this.store.getState();
    if (state.sessionId !== sessionId) return;
    const blocks = state.blocks;

    // 主会话回合先结束、子会话还在跑时，对话里没有它们的结果——此时提炼
    // 「下一步建议」与「自动记忆」都基于残缺内容，而且子会话汇报会再触发
    // 一轮 followup 把同样的东西重做一遍。子会话全部结束后宿主会以 hidden
    // 汇报 prompt 唤醒主会话，那一轮结束时自然补上这两项，所以这里跳过即可，
    // 不要另做补触发。标题不受影响：它是首轮会话标签，与子会话结果无关。
    const childrenRunning = this.hasRunningSuperSessions();
    if (childrenRunning && opts.conversationTasks) {
      this.log.info("turn followup: skipped next-steps/memory while child sessions are still running");
    }

    const input: FollowupInput = {};
    const tasks: FollowupTaskKind[] = [];
    const titleTask = opts.allowTitle ? this.titleTaskFor(sessionId) : null;
    if (titleTask) {
      input.title = { request: titleTask.request };
      tasks.push("title");
      this.titledSessionIds.add(sessionId);
    }
    const prediction =
      opts.conversationTasks && !childrenRunning ? this.nextStepTaskFor(sessionId) : null;
    if (prediction) {
      input.nextSteps = prediction.input;
      tasks.push("nextSteps");
    }
    let memory: { conversation: string; existingFacts: string[] } | null = null;
    if (
      opts.conversationTasks &&
      !childrenRunning &&
      this.memory.isExtractionEligible(sessionId, blocks)
    ) {
      memory = await this.memory.buildExtractionInput(blocks);
      if (memory) {
        input.memory = memory;
        tasks.push("memory");
      }
    }
    if (tasks.length === 0) return;

    const ceiling = this.followupCeiling(tasks);
    // The extraction rate-limit slot is taken only once the batch is really
    // going out — a gated or empty batch must not consume the 2-minute window.
    const extractingToastId = memory ? this.memory.beginExtraction() : null;
    this.followupBusy = true;
    if (prediction) this.store.setNextStepLoading(true);
    try {
      const raw = await this.completeInternalPrompt(
        buildFollowupPrompt(input),
        ceiling.timeoutMs,
        ceiling.idleMs,
      );
      if (!raw || this.disposed) return;
      const result = parseFollowupResponse(raw, tasks, NEXT_STEP_MAX_SUGGESTIONS);
      if (titleTask) await this.applyFollowupTitle(sessionId, titleTask, result.title);
      if (prediction) this.applyFollowupSuggestions(sessionId, prediction, result.nextSteps);
      if (memory) this.memory.applyExtractionResult(raw, sessionId, memory.existingFacts);
    } finally {
      this.followupBusy = false;
      // Every settle path (empty reply, stale anchor, session switch, timeout)
      // must retire the pill — a stuck spinner reads as "the model died".
      if (prediction && !this.disposed) this.store.setNextStepLoading(false);
      this.memory.finishExtraction(extractingToastId);
    }
  }

  /**
   * Ceiling for a merged batch: the loosest window among the tasks it carries.
   *
   * Each task's wall-clock budget comes from its setting
   * (`iflow.memoryExtractTimeoutSeconds` / `iflow.nextStepTimeoutSeconds`;
   * the title task keeps its fixed 180s), and the idle watchdog is clamped to
   * at most half of that budget — with a short ceiling the wall-clock guard
   * would always fire first and the salvage path ("stalled" vs "timeout")
   * would change.
   *
   * A task configured as 0 (「不限制」) lifts the WHOLE batch: the three
   * turn-end tasks share ONE HTTP request, so a per-task budget cannot be
   * enforced on it — the batch then runs without a wall-clock ceiling and
   * without the idle watchdog (a wedged gateway then holds the lane until it
   * answers; that is what 「不限制」 means).
   *
   * With the default settings the result is identical to the previous
   * hard-coded pair (180s ceiling / 90s idle).
   */
  private followupCeiling(tasks: readonly FollowupTaskKind[]): { timeoutMs: number; idleMs: number } {
    let timeoutMs = 0;
    let idleMs = 0;
    let unlimited = false;
    for (const task of tasks) {
      const def = FOLLOWUP_CEILINGS[task];
      const taskTimeoutMs =
        task === "memory"
          ? this.memoryExtractTimeoutMs()
          : task === "nextSteps"
            ? this.nextStepTimeoutMs()
            : def.timeoutMs;
      if (taskTimeoutMs <= 0) {
        unlimited = true;
        continue;
      }
      timeoutMs = Math.max(timeoutMs, taskTimeoutMs);
      idleMs = Math.max(idleMs, Math.min(def.idleMs, Math.floor(taskTimeoutMs / 2)));
    }
    if (unlimited) return { timeoutMs: 0, idleMs: 0 };
    return { timeoutMs, idleMs };
  }

  /**
   * P0-7 title task input: eligible only while the session label is still the
   * mechanical first-message truncation (or the untitled default) — a label the
   * user could not have produced mechanically is left alone. Labels persisted
   * before the ellipsis was added to clampSessionLabel carry the bare 48-char
   * slice; accept that form too so old sessions can still be titled.
   */
  private titleTaskFor(
    sessionId: string,
  ): { request: string; mechanicalLabel: string; legacyMechanical: string } | null {
    if (vscode.workspace.getConfiguration("iflow").get<boolean>("autoTitle", true) === false) return null;
    if (this.titledSessionIds.has(sessionId)) return null;
    const state = this.store.getState();
    if (state.sessionId !== sessionId && state.activeSessionId !== sessionId) return null;
    const target = state.sessions.find((s) => s.id === sessionId);
    if (!target) return null;
    const firstUser = state.blocks.find((b) => b.kind === "user");
    if (!firstUser || firstUser.kind !== "user") return null;
    const mechanicalLabel = clampSessionLabel(firstUser.text);
    const legacyMechanical = firstUser.text.trim().slice(0, SESSION_LABEL_MAX);
    if (
      target.label !== mechanicalLabel &&
      target.label !== legacyMechanical &&
      target.label !== DEFAULT_SESSION_LABEL
    ) {
      return null;
    }
    return {
      request: stripFileMentions(firstUser.text).slice(0, TITLE_REQUEST_MAX_CHARS),
      mechanicalLabel,
      legacyMechanical,
    };
  }

  /**
   * Next-step task input: the last-turn excerpt (user request plus the
   * assistant's closing text — walking backwards keeps the tail when the reply
   * is long; tool titles carry what the agent actually did when the turn
   * produced no prose). Anti-stale anchoring: hold the last user block by
   * REFERENCE plus the block count.
   */
  private nextStepTaskFor(sessionId: string): {
    input: FollowupNextStepsInput;
    anchorUserBlock: Block;
    anchorBlockCount: number;
  } | null {
    if (vscode.workspace.getConfiguration("iflow").get<boolean>("nextStepSuggestions", true) === false) return null;
    const state = this.store.getState();
    if (state.sessionId !== sessionId) return null;
    const blocks = state.blocks;
    let lastUserIndex = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]?.kind === "user") {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex < 0) return null;
    const anchorUserBlock = blocks[lastUserIndex]!;
    if (anchorUserBlock.kind !== "user") return null;
    let reply = "";
    const toolTitles: string[] = [];
    for (let i = blocks.length - 1; i > lastUserIndex; i--) {
      const block = blocks[i]!;
      if (block.kind === "text" && reply.length < NEXT_STEP_EXCERPT_CHARS) {
        reply = `${block.text}\n${reply}`;
      } else if (block.kind === "tool" && toolTitles.length < 8) {
        toolTitles.push(block.title);
      }
    }
    const user = anchorUserBlock.text.slice(0, Math.floor(NEXT_STEP_EXCERPT_CHARS / 3)).trim();
    const assistant = reply.slice(-Math.floor((NEXT_STEP_EXCERPT_CHARS * 2) / 3)).trim();
    if (!user) return null;
    return {
      input: { user: stripFileMentions(user), assistant, toolTitles },
      anchorUserBlock,
      anchorBlockCount: blocks.length,
    };
  }

  /** Apply the merged reply's title, re-checking the session and the label. */
  private async applyFollowupTitle(
    sessionId: string,
    task: { mechanicalLabel: string; legacyMechanical: string },
    title: string | null,
  ): Promise<void> {
    if (!title || this.disposed) return;
    const label = clampSessionLabel(title);
    if (!label) return;
    const current = this.store.getState();
    if (current.sessionId !== sessionId && current.activeSessionId !== sessionId) return;
    const entry = current.sessions.find((s) => s.id === sessionId);
    if (!entry) return;
    // The user may have renamed the session while the call was in flight:
    // only the mechanical form we asked to replace is overwritten.
    if (
      entry.label !== task.mechanicalLabel &&
      entry.label !== task.legacyMechanical &&
      entry.label !== DEFAULT_SESSION_LABEL
    ) {
      return;
    }
    const sessions = current.sessions.map((s) => (s.id === sessionId ? { ...s, label } : s));
    this.store.setSessions(sessions, current.activeSessionId);
    await this.persistSessions(sessions, current.activeSessionId);
    // Keep the transcript file's label in sync with the new title.
    void this.persistActiveTranscript(true);
  }

  /** Apply the merged reply's chips, dropping them when the transcript moved. */
  private applyFollowupSuggestions(
    sessionId: string,
    prediction: { anchorUserBlock: Block; anchorBlockCount: number },
    suggestions: string[],
  ): void {
    if (suggestions.length === 0) return;
    const current = this.store.getState();
    if (current.sessionId !== sessionId) return;
    let currentLastUser: (typeof current.blocks)[number] | null = null;
    for (let i = current.blocks.length - 1; i >= 0; i--) {
      const block = current.blocks[i]!;
      if (block.kind === "user") {
        currentLastUser = block;
        break;
      }
    }
    // Only settle into the exact transcript the prediction was made for: a
    // reply that lands after a new user turn, a session swap, a rollback or a
    // `/compress` turn (status flips to streaming) is dropped.
    if (currentLastUser !== prediction.anchorUserBlock) return;
    if (current.blocks.length !== prediction.anchorBlockCount || current.status !== "idle") return;
    // The user may have turned the feature off while the call was in flight.
    if (vscode.workspace.getConfiguration("iflow").get<boolean>("nextStepSuggestions", true) === false) return;
    this.store.suggestNextSteps(suggestions);
  }

  // --- M1: session export (P0-7) -----------------------------------------------

  /** Export the active transcript (Markdown / JSON) via a native save dialog. */
  private async exportActiveSession(format: "markdown" | "json"): Promise<void> {
    const state = this.store.getState();
    const id = state.activeSessionId ?? state.sessionId;
    if (!id || state.blocks.length === 0) {
      this.store.appendNotice(vscode.l10n.t("当前会话没有可导出的内容"));
      return;
    }
    const label = state.sessions.find((s) => s.id === id)?.label ?? DEFAULT_SESSION_LABEL;
    const content =
      format === "markdown"
        ? transcriptToMarkdown({ label, sessionId: state.sessionId, modelId: state.currentModelId, blocks: state.blocks, usage: state.usage })
        : transcriptToJson({ label, sessionId: state.sessionId, blocks: state.blocks });
    const safeLabel = label.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 60) || "iflow-session";
    const defaultDir = vscode.workspace.workspaceFolders?.[0]?.uri ?? this.context.extensionUri;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(defaultDir, `${safeLabel}.${format === "markdown" ? "md" : "json"}`),
      filters: format === "markdown" ? { Markdown: ["md"] } : { JSON: ["json"] },
    });
    if (!uri) return;
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
      this.store.sendToast("info", vscode.l10n.t("会话已导出：{0}", uri.fsPath), { durationMs: 8000 });
    } catch (error) {
      this.store.sendToast("error", vscode.l10n.t("导出失败：{0}", errorMessage(error)));
    }
  }

  /**
   * M1 P1-4: export the bounded ACP wire log (redacted NDJSON, harness
   * `--record` shape) via a native save dialog. Command-palette entry; the
   * buffer is always-on (capped), so whatever the current CLI process has
   * exchanged is available without a repro flag.
   */
  async exportWireLog(): Promise<void> {
    const defaultDir = vscode.workspace.workspaceFolders?.[0]?.uri ?? this.context.extensionUri;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(defaultDir, `iflow-acp-log-${stamp}.ndjson`),
      filters: { [vscode.l10n.t("通信日志")]: ["ndjson", "log", "txt"] },
    });
    if (!uri) return;
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(this.wireLog.dump(), "utf8"));
      void vscode.window.showInformationMessage(
        vscode.l10n.t("通信日志已导出（{0} 条记录，敏感信息已隐去）：{1}", this.wireLog.size, uri.fsPath),
      );
    } catch (error) {
      void vscode.window.showErrorMessage(vscode.l10n.t("导出通信日志失败：{0}", errorMessage(error)));
    }
  }

  // --- M1: context occupancy (P0-6) + cost (P1-6) ------------------------------

  /** Resolve the store's usage context: settings overrides → curated tables →
   * conservative fallback. Synchronous and cheap (runs per push). */
  /** Cached parse of the two usage settings (invalidated on config change —
   * `resolveUsageContext` runs on EVERY store push, so re-parsing the arrays
   * per push would waste work during streaming). */
  private usageOverridesCache: { overrides: Record<string, number>; cost: Record<string, { input: number; output: number }> } | null = null;

  private resolveUsageContext(): { contextWindow: number | null; estimated: boolean; costPrice: { input: number; output: number } | null } {
    const cfg = vscode.workspace.getConfiguration("iflow");
    let cached = this.usageOverridesCache;
    if (!cached) {
      cached = {
        overrides: parseContextWindowOverrides(cfg.get<string[]>("contextWindowOverrides", [])),
        cost: parseCostTable(cfg.get<string[]>("costTable", [])),
      };
      this.usageOverridesCache = cached;
    }
    const modelId = this.store.getState().currentModelId;
    const { window, estimated } = resolveContextWindow(modelId, cached.overrides);
    return { contextWindow: window, estimated, costPrice: resolveCost(modelId, cached.cost) };
  }

  /**
   * Occupancy-warning state machine (runs on every store push). Fires ONE
   * persistent pill with a 立即压缩 action when usage crosses
   * CONTEXT_WARN_RATIO; hysteretic exit at 85% (a compression or a session
   * switch drops the ratio and removes the pill). ≥100% stays owned by the
   * existing overflow auto-compress path.
   *
   * Two display-truthfulness rules (2026-10-11):
   * - An `estimated` context window (fallback guess for an unlisted model)
   *   never warns: the ratio would present a guessed denominator as fact.
   *   If a warning is already up and the window becomes estimated (model
   *   switch), the pill is dismissed instead of left stale.
   * - The toast text carries NO percentage. The pill is persistent until the
   *   hysteresis exit, so a frozen trigger-time number drifts against the
   *   live usage chip after a compression (99% pill vs 91% chip, reported
   *   2026-10-11). The chip owns all live numbers; the pill only signals.
   */
  private contextWarnToastId: number | null = null;

  private evaluateContextWarning(): void {
    // A compress turn in flight must not re-arm the warning: the ratio still
    // reads pre-compression high until the fold lands, and re-sending here is
    // exactly what flashed the pill back right after the 立即压缩 click
    // dismissed it (2026-10-14 report). Hysteresis exit owns dismissal once
    // the compression settles; a failed one re-arms on the next push.
    if (this.store.getState().compressing) return;
    const usage = this.store.getState().usage;
    const window = usage?.contextWindow ?? null;
    const used = usage?.contextUsed ?? 0;
    const ratio = window !== null && window > 0 ? used / window : 0;
    if (usage?.estimated) {
      // Estimated window: withdraw any live warning rather than warn on a
      // guessed denominator (also covers model-switch-away mid-warning).
      if (this.contextWarnActive) {
        this.contextWarnActive = false;
        if (this.contextWarnToastId !== null) {
          this.store.dismissToast(this.contextWarnToastId);
          this.contextWarnToastId = null;
        }
      }
      return;
    }
    if (this.contextWarnActive) {
      // Exit below the hysteresis floor — a compression or a session switch
      // drops the ratio and removes the pill.
      if (ratio < CONTEXT_WARN_EXIT_RATIO) {
        this.contextWarnActive = false;
        if (this.contextWarnToastId !== null) {
          this.store.dismissToast(this.contextWarnToastId);
          this.contextWarnToastId = null;
        }
      }
    } else if (ratio >= CONTEXT_WARN_RATIO) {
      this.contextWarnActive = true;
      this.contextWarnToastId = this.store.sendToast(
        "warning",
        vscode.l10n.t("上下文接近上限，建议压缩"),
        {
          persistent: true,
          action: { actionId: "compress", label: vscode.l10n.t("立即压缩") },
        },
      );
    }
  }

  /** Toast inline-action dispatch (currently only P0-6's compress action). */
  private handleToastAction(actionId: string, toastId?: number): void {
    if (actionId === "compress") {
      // Warning-state bookkeeping and pill dismissal live inside
      // runCompressTurn: a guard that early-returns (busy/no session) must
      // leave the warning exactly as it was, otherwise the next push would
      // re-arm a second pill while the first still renders.
      void this.runCompressTurn(toastId);
      return;
    }
    if (actionId === "memory-review") {
      if (typeof toastId === "number") this.store.dismissToast(toastId);
      this.memory.reviewCandidates();
      return;
    }
    if (actionId === "queue-diagnostics") {
      if (typeof toastId === "number") this.store.dismissToast(toastId);
      void this.sendDiagnosticsFix();
      return;
    }
    if (actionId === "resume-super-turns") {
      // 常驻「已停止 · N 项待处理」提示的「继续处理」：用户明确要放开压制。
      // 队列里的汇报一条不丢，这里只是把闸门打开并立刻恢复投递。
      const deferredId = this.deferredAutoTurnsToastId;
      this.clearDeferredAutoTurnsToast();
      if (typeof toastId === "number" && toastId !== deferredId) {
        // 兜住异常回包：动作来自别的 toast 时也把它收掉（会被 clear 收掉的那条不再重复）。
        this.store.dismissToast(toastId);
      }
      if (this.autoTurnsHeld()) {
        this.autoTurnsStoppedFor = null;
        this.syncSuperWaitingState();
        void this.drainSuperReports();
        void this.drainDelegatedUserTurns();
      }
      return;
    }
    if (typeof toastId === "number") this.store.dismissToast(toastId);
  }

  /**
   * Drive the `/compress` slash command on the active session (same bridge
   * the overflow path uses, but user-initiated from the warning pill). No
   * user block is recorded — the compression result surfaces as the usual
   * collapsible CompressionBlock. `dismissToastId` removes the warning pill
   * that carried this action, right as the compress turn opens.
   */
  private async runCompressTurn(dismissToastId?: number): Promise<void> {
    if (this.historySyncBusy) return;
    const state = this.store.getState();
    if (state.initializing || state.status === "streaming") return;
    const sessionId = state.sessionId;
    if (!sessionId) return;
    const client = await this.ensureClient().catch(() => null);
    if (!client || this.disposed || this.client !== client) return;
    if (this.store.getState().sessionId !== sessionId) return;
    // State-machine flip and pill removal move together, immediately before
    // beginCompressTurn's flush: no push can observe the half-dismissed
    // intermediate (the 2026-10-14 flicker).
    this.contextWarnActive = false;
    if (typeof dismissToastId === "number") this.store.dismissToast(dismissToastId);
    // Stream the session for the duration of the turn: without this the
    // whole `/compress` runs inside `idle` and the webview's 正在压缩 pill
    // never renders (2026-10-14 report). Status flips via the reducer; the
    // success path closes through promptCompleted like any other turn.
    this.store.beginCompressTurn();
    try {
      const result = await this.promptWithRetry(client, sessionId, [{ type: "text", text: "/compress" }]);
      if (this.store.getState().sessionId === sessionId) this.store.promptCompleted(result.stopReason, result.usage);
    } catch (error) {
      if (this.disposed || this.store.getState().sessionId !== sessionId) return;
      this.log.warn(`manual compress failed: ${errorMessage(error)}`);
      this.store.sendToast(
        "warning",
        error instanceof CompressTimeoutError
          ? error.message
          : vscode.l10n.t("压缩失败：{0}", errorMessage(error)),
      );
      // The turn is over on the failure path too — leaving 状态 streaming
      // would strand the panel in a phantom generating state.
      this.store.endCompressTurn();
    }
  }

  /** Re-entrancy guard for the turn-end auto-compress (one compress turn at a time). */
  private autoCompressInFlight = false;

  /**
   * Turn-end PROACTIVE compression. The overflow path in promptWithRetry is
   * strictly reactive: it only fires once the gateway REJECTS a turn with an
   * overflow error. A session that creeps up on its window (or a host-side
   * estimate that says so) never trips it — the turn just keeps streaming
   * until something finally dies (2026-10-11 report: chip at 100%, pill up,
   * "自动压缩" never happened, because no rejection ever arrived).
   *
   * This closes the gap at the idle boundary: after a turn settles, if the
   * occupancy estimate is ≥ CONTEXT_AUTOCOMPRESS_RATIO, drive one `/compress`
   * turn before the next prompt (queued or typed) starts. Guards:
   * - `estimated` windows never trigger (a guessed denominator must not
   *   compress a healthy session — the hy3 32K-fallback misreport was the
   *   exact false-positive this guard prevents);
   * - only a truly idle session (streaming/connecting/init/replay windows
   *   and pending approval/question/plan cards stay untouched);
   * - `autoCompressInFlight` keeps one compress turn at a time; a failed
   *   compression is logged + warned, never escalated to the error banner
   *   (the user's next real prompt still has the reactive overflow path).
   *
   * Returns true when a `/compress` turn actually ran. Callers use this to
   * skip turn-end memory extraction: a compression turn must not trigger
   * automatic memory capture (the user's next real turn still will).
   */
  private async maybeAutoCompressOnIdle(sessionId: string): Promise<boolean> {
    if (this.disposed || this.autoCompressInFlight || this.historySyncBusy) return false;
    // Opt-in (default off): a turn-end compress adds a whole extra turn and
    // rewrites the model's context, so the user must enable it explicitly in
    // the settings panel. The reactive overflow path in promptWithRetry is
    // unaffected — it only fires when the gateway rejects a turn.
    if (vscode.workspace.getConfiguration("iflow").get<boolean>("autoCompressOnIdle", false) === false) return false;
    const state = this.store.getState();
    if (state.sessionId !== sessionId) return false;
    if (state.initializing || state.replaying || state.status !== "idle") return false;
    if (state.pendingApproval || state.pendingPlanExit || state.pendingQuestions) return false;
    const usage = state.usage;
    const window = usage?.contextWindow ?? null;
    if (!usage || usage.estimated || window === null || window <= 0) return false;
    const ratio = (usage.contextUsed ?? 0) / window;
    // Threshold is user-configurable (`iflow.autoCompressThresholdPercent`).
    const threshold = this.autoCompressThresholdRatio();
    if (ratio < threshold) return false;
    this.autoCompressInFlight = true;
    const toastId = this.store.sendToast(
      "info",
      vscode.l10n.t("上下文接近上限，自动压缩会话…"),
      { displayOnly: true, persistent: true },
    );
    let compressed = false;
    try {
      const client = await this.ensureClient().catch(() => null);
      if (!client || this.disposed || this.client !== client) return false;
      if (this.store.getState().sessionId !== sessionId) return false;
      // Same display-truth pairing as the manual path: the turn streams so
      // the webview renders 正在压缩 (this session crept up on its window
      // without ever tripping the reactive overflow, so nothing else set
      // the flag), and the finally dismisses the waiting pill once over.
      this.store.beginCompressTurn();
      const result = await this.promptWithRetry(client, sessionId, [{ type: "text", text: "/compress" }]);
      if (this.disposed || this.store.getState().sessionId !== sessionId) return false;
      this.store.promptCompleted(result.stopReason, result.usage);
      compressed = true;
      this.log.info(
        `turn-end auto-compress on session ${sessionId} (context ratio ${Math.round(ratio * 100)}%)`,
      );
      void this.persistActiveTranscript();
    } catch (error) {
      // The reactive overflow path still guards the next real prompt, so a
      // failed proactive compress is a warning, not an error banner.
      if (this.disposed || this.store.getState().sessionId !== sessionId) return false;
      this.log.warn(`turn-end auto-compress failed: ${errorMessage(error)}`);
      this.store.sendToast(
        "warning",
        error instanceof CompressTimeoutError
          ? error.message
          : vscode.l10n.t("压缩失败：{0}", errorMessage(error)),
      );
      this.store.endCompressTurn();
    } finally {
      this.autoCompressInFlight = false;
      this.store.dismissToast(toastId);
    }
    return compressed;
  }


  // --- M4 P1-1: approval pre-review rule table --------------------------------

  /** Auto-decision transcript notes already emitted this turn, keyed by
   * `ruleId|toolName`. An "allow all reads" rule would otherwise add a system
   * line per read_file call; cleared at every prompt attempt (see
   * promptWithRetry's `turnHadAgentOutput` reset). */
  private readonly autoApprovalNoted = new Set<string>();

  /** Workspace file the project override is read from (null = no workspace). */
  private approvalProjectUri(): vscode.Uri | null {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return null;
    return vscode.Uri.joinPath(root, ...APPROVAL_POLICY_PROJECT_FILE.split("/"));
  }

  /**
   * Load (and cache) both rule tables. Async on purpose: the approval path
   * must never do sync I/O in the extension host (trap #18 discipline), and
   * the project file is owned by the user / external tools.
   */
  private async loadApprovalRules(): Promise<{ global: ApprovalRule[]; project: ApprovalRule[] }> {
    if (!this.approvalRules) {
      const raw = this.context.globalState.get<string>(APPROVAL_POLICY_KEY);
      this.approvalRules = raw ? parseApprovalPolicy(raw) ?? [] : [];
    }
    if (!this.approvalProjectRules) this.approvalProjectRules = await this.readProjectApprovalRules();
    return { global: this.approvalRules, project: this.approvalProjectRules };
  }

  private async readProjectApprovalRules(): Promise<ApprovalRule[]> {
    const uri = this.approvalProjectUri();
    if (!uri) return [];
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const rules = parseApprovalPolicy(Buffer.from(bytes).toString("utf8"));
      if (!rules) {
        this.log.warn(`approval policy: ignoring malformed ${APPROVAL_POLICY_PROJECT_FILE}`);
        return [];
      }
      return rules;
    } catch {
      return []; // absent is the normal case — global rules only
    }
  }

  /** Precedence order for matching: project rules override global ones. */
  private approvalRuleChain(global: readonly ApprovalRule[], project: readonly ApprovalRule[]): ApprovalRule[] {
    return [...project, ...global];
  }

  /**
   * Persist the global rule table. Returns false when the write rejected —
   * the in-memory table is rolled back so the panel never acts on rules that
   * would be gone after a window reload (the caller answers with a toast /
   * a saveResult:"failed" push instead of claiming 已保存).
   */
  private async persistApprovalRules(rules: ApprovalRule[]): Promise<boolean> {
    const previous = this.approvalRules;
    this.approvalRules = rules;
    try {
      await this.context.globalState.update(APPROVAL_POLICY_KEY, serializeApprovalPolicy(rules));
      return true;
    } catch (error) {
      this.approvalRules = previous;
      this.log.warn(`approval policy write failed: ${errorMessage(error)}`);
      return false;
    }
  }

  /** Bump a matched GLOBAL rule's hit counter (project rules are read-only —
   * the panel never writes a file the user owns). */
  private noteApprovalRuleHit(ruleId: string | undefined, project: readonly ApprovalRule[]): void {
    if (!ruleId || !this.approvalRules) return;
    if (project.some((r) => r.id === ruleId)) return;
    let changed = false;
    const next = this.approvalRules.map((r) => {
      if (r.id !== ruleId) return r;
      changed = true;
      return { ...r, hits: (r.hits ?? 0) + 1 };
    });
    if (changed) void this.persistApprovalRules(next);
  }

  /** The wire facts a decision is made from (see ApprovalRequestInfo: CLI
   * 0.5.19 permission requests carry kind/title/locations, not toolName/args). */
  private approvalRequestInfo(req: RequestPermissionRequest): ApprovalRequestInfo {
    const toolCall = req.toolCall;
    return {
      toolName: toolCall.toolName ?? "",
      toolKind: toolCall.kind ?? "other",
      title: toolCall.title ?? "",
      paths: (toolCall.locations ?? []).map((l) => l.path),
      cwd: this.sessionCwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
    };
  }

  /**
   * Super Agent 内置工具（`super-agent` / `super-agent-actions`）的权限请求
   * 直接放行，不弹审批卡。
   *
   * 理由：该工具本身**只回 ack**，真正干活的是宿主 —— `handleSuperToolCall`
   * 从 `args` 取载荷，交给与正文围栏完全相同的派发 / 动作链路。正文围栏派发
   * 从来不经审批，所以同一条信任级别的内置工具也不额外加卡；否则模型每派一次
   * 子会话就要用户点一次，把「随时开启」变成「每次确认」，安全边界却没有任何
   * 增量（工具不执行任何东西）。
   *
   * 只对这一个工具生效：其它工具仍走规则表 / 审批卡，用户的 approvalMode
   * 语义不变。响应里的 `optionId` **必须是 agent 真正给出的** —— CLI 用
   * `nativeEnum` 解析，伪造会抛错并卡死回合；没有 allow 选项时按现有取消
   * 路径回 `cancelled`，绝不伪造批准。
   */
  private autoApproveSuperAgentTool(req: RequestPermissionRequest): RequestPermissionResponse | null {
    if (!isSuperAgentToolRequest(this.approvalRequestInfo(req))) return null;
    const label = req.toolCall.toolName || req.toolCall.title || "super-agent";
    const option =
      req.options.find((o) => o.kind === "allow_always") ??
      req.options.find((o) => o.kind.startsWith("allow"));
    if (!option) {
      this.log.warn(`super agent: "${label}" permission request offers no allow option — cancelling`);
      return { outcome: { outcome: "cancelled" } };
    }
    this.log.info(`super agent: auto-allowed built-in tool "${label}" (${option.kind})`);
    return { outcome: { outcome: "selected", optionId: option.optionId } };
  }

  /**
   * Run the rule table over an incoming permission request BEFORE surfacing a
   * card. Returns the wire response to send, or null when the user must still
   * decide (no rule matched, or a hard veto downgraded an allow to ask).
   *
   * Discipline: the response's `optionId` is ALWAYS one the agent offered —
   * the CLI parses it with `nativeEnum(...)` (probed, CLI 0.5.19 bundle), so a
   * fabricated id throws and strands the turn. When the wanted shape is
   * missing, allow falls back to the card and deny falls back to `cancelled`
   * (the same response the 5-minute timeout produces).
   */
  private async preReviewApproval(req: RequestPermissionRequest): Promise<RequestPermissionResponse | null> {
    const { global, project } = await this.loadApprovalRules();
    const chain = this.approvalRuleChain(global, project);
    if (chain.length === 0) return null;
    const info = this.approvalRequestInfo(req);
    const decision = decideApproval(chain, info);
    if (decision.action === "ask") return null;

    const pick = (kinds: readonly string[]): PermissionOption | undefined => {
      for (const kind of kinds) {
        const found = req.options.find((o) => o.kind === kind);
        if (found) return found;
      }
      return undefined;
    };

    let response: RequestPermissionResponse;
    if (decision.action === "allow") {
      const option = pick(["allow_once", "allow_always"]);
      if (!option) {
        this.log.warn(
          `approval policy: rule "${decision.ruleLabel ?? decision.ruleId}" matched but the request offers no allow option — showing the card`,
        );
        return null;
      }
      response = { outcome: { outcome: "selected", optionId: option.optionId } };
    } else {
      const option = pick(["reject_once", "reject_always"]);
      response = option
        ? { outcome: { outcome: "selected", optionId: option.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }

    this.noteApprovalRuleHit(decision.ruleId, project);
    // One transcript trace per rule per tool per turn (see autoApprovalNoted).
    const noteKey = `${decision.ruleId ?? ""}|${info.toolName}`;
    if (!this.autoApprovalNoted.has(noteKey)) {
      this.autoApprovalNoted.add(noteKey);
      const ruleName = decision.ruleLabel ?? decision.ruleId ?? "";
      this.store.approvalResolutionNote(
        info.toolName || info.title || "tool",
        decision.action === "allow"
          ? vscode.l10n.t("按策略自动允许（{0}）", ruleName)
          : vscode.l10n.t("按策略自动拒绝（{0}）", ruleName),
      );
    }
    return response;
  }

  /**
   * 「始终允许」 upgrade (roadmap P1-1): derive the narrowest rule for THIS
   * request and hand it to the policy card for naming. Nothing is persisted
   * until the user saves — a rule that silently auto-approves future turns
   * must be a deliberate, visible act. Returns false when no rule can be
   * derived (hard-vetoed command, or the request carries nothing to match on).
   */
  private offerAlwaysAllowRule(req: RequestPermissionRequest): boolean {
    const info = this.approvalRequestInfo(req);
    if (hardDenyReason(info)) return false;
    const draft = deriveAllowRule(info, `rule-${Date.now().toString(36)}-${++this.approvalRuleSeq}`);
    if (!draft) return false;
    this.approvalDraft = draft;
    return true;
  }

  /** Push the current tables (+ any pending draft) to the policy card.
   * `saveResult` is only set when this push answers a save request: the card
   * waits for it before flashing 已保存 (a fire-and-forget send used to flash
   * success before the host had written anything). */
  private async sendApprovalPolicy(saveResult?: "ok" | "failed"): Promise<void> {
    const { global, project } = await this.loadApprovalRules();
    this.postToWebview({
      type: "approvalPolicy",
      rules: global,
      projectRules: project,
      draft: this.approvalDraft,
      ...(saveResult ? { saveResult } : {}),
    });
  }

  /** Save the global table (replace semantics — see shared/messages.ts). */
  private async saveApprovalPolicy(rules: readonly ApprovalRule[]): Promise<void> {
    const clean: ApprovalRule[] = [];
    for (const raw of rules.slice(0, APPROVAL_RULES_MAX)) {
      const rule = normalizeApprovalRule(raw, `rule-${clean.length + 1}`);
      if (rule && !clean.some((r) => r.id === rule.id)) clean.push(rule);
    }
    // Saving from the card resolves the draft either way (the user either
    // kept it in `rules` or threw it away).
    this.approvalDraft = null;
    const ok = await this.persistApprovalRules(clean);
    if (!ok) {
      this.store.sendToast("warning", vscode.l10n.t("审批规则保存失败，已保留原规则"));
    }
    // Push the (possibly rolled-back) table either way: the card uses this
    // reply to stop its saving state, and on failure it must show what is
    // actually persisted rather than the user's unsaved draft.
    await this.sendApprovalPolicy(ok ? "ok" : "failed");
  }


  // --- Tool approval flow (session/request_permission) --------------------------

  private async requestPermissionFromUser(req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const id = `ap-${++this.approvalSeq}`;
    const toolCall = req.toolCall;
    const now = Date.now();
    // Edit-type tools carry their pending change on the permission request
    // itself (probed, CLI 0.5.19 fork bundle: `shouldConfirmExecute` pushes
    // `{type:"diff", path, oldText, newText}` into toolCall.content BEFORE
    // the tool runs). Forwarding it lets the card show WHAT will be written
    // instead of asking the user to approve blind. Over-cap sides drop the
    // preview entirely (never truncate — a partial diff is a lying diff).
    let diff: ToolDiffUi | null = null;
    for (const entry of toolCall.content ?? []) {
      if (entry.type !== "diff") continue;
      const oldText = entry.oldText ?? null;
      const newText = entry.newText ?? null;
      if (
        (oldText !== null && oldText.length > APPROVAL_DIFF_PREVIEW_MAX_CHARS) ||
        (newText !== null && newText.length > APPROVAL_DIFF_PREVIEW_MAX_CHARS)
      ) {
        break;
      }
      diff = { path: entry.path, oldText, newText };
      break;
    }
    const approval: PendingApprovalUi = {
      id,
      toolName: toolCall.toolName ?? "",
      title: toolCall.title ?? "",
      toolKind: toolCall.kind ?? "other",
      locations: toolCall.locations ?? [],
      diff,
      options: req.options,
      deadline: now + APPROVAL_TIMEOUT_MS,
      timeoutMs: APPROVAL_TIMEOUT_MS,
    };

    return await new Promise<RequestPermissionResponse>((resolve) => {
      const timer = setTimeout(() => {
        // Safety: an unanswered card must not block the agent forever.
        this.pendingApprovals.delete(id);
        // Resolve FIRST: the wire response is what unblocks the agent — a
        // throwing UI-layer store call must never swallow it (the turn would
        // strand with the card gone and the agent still waiting).
        resolve({ outcome: { outcome: "cancelled" } });
        this.store.clearApproval(id);
        this.store.approvalResolutionNote(approval.toolName, vscode.l10n.t("审批超时，已自动拒绝"));
        this.armPostRejectionWatchdog();
      }, APPROVAL_TIMEOUT_MS);

      this.pendingApprovals.set(id, {
        options: req.options,
        toolName: approval.toolName,
        req,
        resolve,
        timer,
      });
      this.store.showApproval(approval);
      // SubAgent approvals remain actionable in the panel, but must not wake
      // the user through an OS notification. The wire agentId is preferred;
      // the transcript lookup covers permission requests whose toolCall omits
      // that extension field but whose nested tool call is already recorded.
      // (Wire evidence, CLI 0.5.19 fork bundle: the permission request's toolCall
      // carries only {toolCallId,status,title,content,locations,kind} — agentId
      // never arrives on this channel, so the transcript lookup is the live path.)
      const isSubAgentApproval = Boolean(
        toolCall.agentId || isSubAgentToolCall(this.store.getState().blocks, toolCall.toolCallId),
      );
      // Policy (user restated 2026-10-16): the OS reminder may fire only while
      // an approval card is actually displayed. The pendingApproval slot holds
      // ONE card, and the CLI executes a turn's function calls in parallel
      // (bundle: `A.map((R,P)=>this.runTool(...))` awaited with Promise.allSettled)
      // — concurrent permission requests replace each other's card in the slot.
      // A replaced card is invisible yet still pending on the wire: it silently
      // auto-rejected at 300s, the agent retried the same tool, and every retry
      // re-toasted a line whose card was long gone (screenshot 2026-10-16: three
      // 「等待审批 Write a.ts」 toasts, no card in the panel). Defer + re-check
      // slot ownership at fire time instead of toasting blind.
      if (!isSubAgentApproval) {
        this.toastWhileDisplayed(
          () => this.pendingApprovals.has(id) &&
            this.store.getState().pendingApproval?.id === approval.id,
          "approval",
          () =>
            vscode.l10n.t(
              "iFlow 等待审批：{0}（{1} 秒后自动拒绝）",
              notifySummary(approval.title || approval.toolName),
              Math.round(APPROVAL_TIMEOUT_MS / 1000),
            ),
        );
      }
    });
  }

  private handleApprovalResponse(id: string, optionId: string | null): void {
    const pending = this.pendingApprovals.get(id);
    if (!pending) return;
    this.pendingApprovals.delete(id);
    clearTimeout(pending.timer);
    this.store.clearApproval(id);

    if (optionId === null) {
      // User dismissed the card — treat as cancel (agent decides what that means).
      this.store.approvalResolutionNote(pending.toolName, vscode.l10n.t("已取消"));
      pending.resolve({ outcome: { outcome: "cancelled" } });
      return;
    }
    const option = pending.options.find((o) => o.optionId === optionId);
    const isReject = option?.kind.startsWith("reject") ?? false;
    this.store.approvalResolutionNote(
      pending.toolName,
      isReject ? vscode.l10n.t("已拒绝") : vscode.l10n.t("已允许（{0}）", option?.name ?? optionId),
    );
    pending.resolve({ outcome: { outcome: "selected", optionId } });
    // M4 P1-1: 「始终允许」 upgrades to a named rule. The approval itself is
    // already resolved — rule creation is a deliberate second step in the
    // policy card (pre-filled draft, user names & saves).
    if (option?.kind === "allow_always") {
      if (this.offerAlwaysAllowRule(pending.req)) void this.sendApprovalPolicy();
      else this.log.info("allow-always offered but no rule could be derived — kept as one-time approval");
    }
  }

  /** Shared complete user-stop chain: unblock cards, suppress retries/watchdog. */
  private cancelCurrentTurn(): void {
    const client = this.client;
    this.cancelAllApprovals(vscode.l10n.t("用户取消"));
    const skippedPlanExits = this.cancelAllPlanExits(vscode.l10n.t("用户取消，计划审批已跳过"));
    this.cancelAllPendingQuestions(vscode.l10n.t("用户取消"));
    this.cancelSeen = true;
    this.clearPostRejectionWatchdog();
    const sessionId = this.store.getState().sessionId;
    if (!sessionId) return;
    // Stop means "stop". Host-driven turns (child-session reports / re-delivered
    // user messages) would otherwise start the NEXT turn the instant this one
    // settles, flipping the panel straight back to 正在生成 — a single click
    // then reads as "nothing happened" and users click again and again
    // (measured: one cancel per queued report turn). Hold those automatic
    // turns until the user sends the next message; nothing is dropped.
    if (this.store.getState().status === "streaming") {
      this.autoTurnsStoppedFor = this.currentMainSessionId();
      this.announceDeferredAutoTurns();
    }
    this.sendTurnCancel(sessionId, client);
    // Stopping a Plan-exit card must leave the session in the mode the panel
    // shows. `session/set_mode` has no echo notification, so nothing would
    // notice the CLI drifting out of Plan mode here — the user-reported
    // symptom was the composer still saying 计划 while the agent had already
    // gained write access (session 439fd54b). Re-assert the stored mode; a
    // push of the mode the CLI already holds is a no-op on its side.
    if (skippedPlanExits > 0 && client) {
      void this.assertModeForPrompt(client, sessionId);
    }
  }

  /**
   * Tell the session to stop — but only when it actually owns a request.
   *
   * The CLI's `session/cancel` acts on the request currently in flight
   * (`AcpSession.pendingPrompt`, verified in the vendor bundle): when nothing
   * is in flight `cancelPendingPrompt()` throws `Not currently generating`,
   * and aborting a finished controller changes nothing. The host's turn is
   * "streaming" before the request goes out (the checkpoint snapshot runs in
   * between), so a Stop in that window used to be silently dropped and the
   * turn ran to completion anyway — the user had to click again once the
   * request was really in flight. `cancelSeen` makes the pending turn settle
   * as cancelled without issuing it (see `promptWithRetry`), and this method
   * keeps the wire clean by sending at most one cancel per in-flight request.
   */
  private sendTurnCancel(sessionId: string, client: AcpClient | null): void {
    if (this.promptRequestSessionId !== sessionId) return;
    if (this.cancelSentForPrompt) return;
    this.cancelSentForPrompt = true;
    try {
      client?.cancel(sessionId);
    } catch (error) {
      // A dying client must never swallow the click (and must not surface as
      // an unhandled rejection out of the webview message router).
      this.log.warn(`session/cancel failed: ${errorMessage(error)}`);
    }
  }

  /**
   * 用户停止后如实告诉用户还有多少自动回合被压住。
   *
   * 静默压制会让「我明明点了停止，怎么还有东西在等」变成新的困惑；数量为 0
   * 时保持安静（每次停止都弹一条会变成噪声）。提示常驻并带「继续处理」动作：
   * 一次性的 toast 转瞬即逝，用户看到的就是「点了停止、按钮还禁着、没人告诉我
   * 出路」的死锁。压制解除（下一条消息 / 新建会话 / 面板关闭 / 点了动作）时
   * 由 clearDeferredAutoTurnsToast 收掉，绝不常驻到下一轮。
   */
  private announceDeferredAutoTurns(): void {
    const pending = this.pendingAutoTurnCount();
    if (pending === 0) return;
    this.clearDeferredAutoTurnsToast();
    this.deferredAutoTurnsToastId = this.store.sendToast(
      "info",
      vscode.l10n.t("已停止；还有 {0} 项子会话结果待处理。发送下一条消息，或点「继续处理」来收取汇报", pending),
      {
        persistent: true,
        action: { actionId: "resume-super-turns", label: vscode.l10n.t("继续处理") },
      },
    );
    // 常驻「等待子会话」提示的文案也要跟着变（它默认写着「会自动继续」）。
    this.refreshSuperWaitHeartbeat();
  }

  /** 收掉「已停止 · N 项待处理」常驻提示（压制解除的各条路径共用）。 */
  private clearDeferredAutoTurnsToast(): void {
    if (this.deferredAutoTurnsToastId !== null) {
      this.store.dismissToast(this.deferredAutoTurnsToastId);
      this.deferredAutoTurnsToastId = null;
    }
  }

  private cancelAllApprovals(reason: string): void {
    for (const [id, pending] of this.pendingApprovals) {
      clearTimeout(pending.timer);
      this.store.clearApproval(id);
      this.store.approvalResolutionNote(pending.toolName, reason);
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingApprovals.clear();
  }

  /**
   * Arm the post-rejection liveness watchdog (see POST_REJECTION_IDLE_MS).
   * Only timeout auto-rejections arm it: a manual reject/allow means the user
   * is watching, and long-running tools keep the event stream alive anyway —
   * any session/update disarms this. A fire therefore means the follow-up
   * model request after our rejection is wedged: cancel the turn (a live CLI
   * answers `cancelled` and the turn settles normally) and mark the error so
   * a dead CLI cannot strand the panel on "generating" forever.
   */
  private armPostRejectionWatchdog(): void {
    this.clearPostRejectionWatchdog();
    const sessionId = this.store.getState().sessionId;
    if (!sessionId) return;
    this.postRejectionWatchdog = setTimeout(() => {
      this.postRejectionWatchdog = null;
      const state = this.store.getState();
      if (this.disposed || state.sessionId !== sessionId || state.status !== "streaming") return;
      this.log.warn(
        `post-rejection turn silent for ${POST_REJECTION_IDLE_MS / 1000}s on session ${sessionId} — cancelling dead turn`,
      );
      this.client?.cancel(sessionId);
      this.store.markError(
        vscode.l10n.t("审批超时自动拒绝后，模型长时间无响应，已自动中断本轮。可重新发送或切换 API 配置后重试。"),
      );
    }, POST_REJECTION_IDLE_MS);
  }

  private clearPostRejectionWatchdog(): void {
    if (this.postRejectionWatchdog) {
      clearTimeout(this.postRejectionWatchdog);
      this.postRejectionWatchdog = null;
    }
  }

  // --- Plan-mode exit flow (_iflow/plan/exit) ---------------------------------

  /**
   * Surface a Plan-mode exit request as a confirmation card in the webview and
   * resolve once the user answers (or the timeout auto-rejects). Reuses the
   * approval-card visual form so the panel stays consistent.
   */
  private requestPlanExitFromUser(req: ExitPlanModeRequest): Promise<ExitPlanModeResponse> {
    const id = `plan-${++this.planExitSeq}`;
    const now = Date.now();
    const pending: PendingPlanExitUi = {
      id,
      plan: req.plan ?? "",
      deadline: now + APPROVAL_TIMEOUT_MS,
      timeoutMs: APPROVAL_TIMEOUT_MS,
    };
    return new Promise<ExitPlanModeResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPlanExits.delete(id);
        // Resolve FIRST — see the approval-timeout comment above.
        resolve({ approved: false, reason: vscode.l10n.t("超时未确认，已拒绝") });
        this.store.clearPlanExit(id);
        this.store.resolveExitPlanModeBlock(false);
        this.store.planExitResolutionNote(vscode.l10n.t("计划审批超时，已自动拒绝"));
        this.armPostRejectionWatchdog();
      }, APPROVAL_TIMEOUT_MS);
      this.pendingPlanExits.set(id, { resolve, timer, plan: pending.plan });
      this.store.showPlanExit(pending);
      // M1 P0-5 + policy 2026-10-16: Plan approval is the user's fourth OS
      // trigger (card displayed) — same slot-mirror re-check as approvals so a
      // replaced card never announces itself.
      this.toastWhileDisplayed(
        () => this.pendingPlanExits.has(id) &&
          this.store.getState().pendingPlanExit?.id === pending.id,
        "plan",
        () => vscode.l10n.t("iFlow 等待计划审批（{0} 秒后自动拒绝）", Math.round(APPROVAL_TIMEOUT_MS / 1000)),
      );
    });
  }

  /** Resolve a pending Plan-mode exit from the webview's answer. */
  private async handlePlanExitResponse(
    id: string,
    approved: boolean,
    reason?: string,
    replan = false,
  ): Promise<void> {
    const pending = this.pendingPlanExits.get(id);
    if (!pending) return;
    this.pendingPlanExits.delete(id);
    clearTimeout(pending.timer);
    this.store.clearPlanExit(id);
    // The CLI never sends a terminal update for the exit_plan_mode call itself
    // (bundle: handleExitPlanMode returns a functionResponse only) — settle it
    // here so the card doesn't linger at 等待执行 until the turn-end sweep
    // mislabels an approved plan's call as failed. Replan answered
    // success:false too, so it settles as failed like a rejection.
    this.store.resolveExitPlanModeBlock(approved);
    // The agent is blocked on this response: compute it first and resolve in
    // `finally`, so a note/mode/write failure can never leave the CLI waiting
    // for the 5-minute timeout.
    const response: ExitPlanModeResponse = {
      approved,
      reason: approved ? undefined : reason ?? vscode.l10n.t("用户拒绝了该计划"),
    };
    try {
      // Replan with edited plan text: the reason IS the revised plan the user
      // wrote in the card's edit mode — surface a truncated excerpt in the
      // resolution note so the transcript records what changed (the full text
      // goes to the agent via the resolve below; the note is display-only).
      let note: string;
      if (replan) {
        note = reason
          ? vscode.l10n.t("重新规划：{0}", reason.length > 80 ? `${reason.slice(0, 80)}…` : reason)
          : vscode.l10n.t("重新规划");
      } else if (approved) {
        // Approved plans are project artifacts: `.iflow/specs/<timestamp>-<slug>.md`.
        // The write must not block approval — a failure is logged and the note
        // simply omits the path.
        let savedPath: string | null = null;
        try {
          savedPath = await this.persistPlanSpec(pending.plan);
        } catch (error) {
          this.log.warn(`failed to persist plan spec: ${errorMessage(error)}`);
        }
        note = savedPath
          ? vscode.l10n.t("已批准计划，已保存到 {0}", savedPath)
          : vscode.l10n.t("已批准计划");
        // 3.5 ①: give the approved round a task-level progress view from the
        // start — the TaskList otherwise only appears once the agent itself
        // calls the todo tool. Parser returns null for plans without a
        // usable item list (a one-item card is noise); a later todo_write
        // still replaces the seeded items (the agent's bookkeeping wins).
        const checklist = planChecklistEntries(pending.plan);
        if (checklist) this.store.seedPlanChecklist(checklist);
      } else {
        note = reason ?? vscode.l10n.t("已拒绝计划");
      }
      this.store.planExitResolutionNote(note);
      // Wire behavior (verified 2026-09): the CLI does not leave plan mode on
      // its own after `_iflow/plan/exit` resolves — switch back explicitly on
      // BOTH approval and rejection (rejection must not strand the session in
      // plan mode either; the agent continues in the returned mode). Replan is
      // the exception: it rejects the plan but keeps the session in plan mode
      // so the agent can revise it.
      if (!replan) {
        const modes = this.store.getState().modes;
        const fallback = modes?.availableModes.find((m) => m.kind != null && m.kind !== "plan")?.id;
        const target = this.planReturnModeId ?? fallback ?? "smart";
        this.planReturnModeId = null;
        void this.setMode(target).catch(() => undefined);
      }
    } catch (error) {
      this.log.warn(`failed to finish plan exit: ${errorMessage(error)}`);
    } finally {
      pending.resolve(response);
    }
  }

  /**
   * Persist an approved plan under the active workspace's `.iflow/specs/`.
   * Returns the workspace-relative display path, or null when there is no
   * workspace folder / the write fails (approval still proceeds).
   */
  private async persistPlanSpec(plan: string): Promise<string | null> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) return null;
    const folder = folders.find((candidate) => candidate.uri.fsPath === this.sessionCwd) ?? folders[0]!;
    const createdAt = new Date();
    const dir = vscode.Uri.joinPath(folder.uri, ".iflow", "specs");
    try {
      const fileName = planSpecFileName(plan, createdAt);
      await vscode.workspace.fs.createDirectory(dir);
      let target = vscode.Uri.joinPath(dir, fileName);
      // Timestamps are second-granular; keep two approvals in the same second
      // from clobbering each other.
      for (let n = 2; ; n += 1) {
        try {
          await vscode.workspace.fs.stat(target);
        } catch {
          break;
        }
        target = vscode.Uri.joinPath(dir, fileName.replace(/\.md$/, `-${n}.md`));
      }
      await vscode.workspace.fs.writeFile(
        target,
        Buffer.from(
          planSpecContent(plan, { sessionId: this.store.getState().sessionId, createdAt }),
          "utf8",
        ),
      );
      return path.posix.join(".iflow", "specs", path.basename(target.fsPath));
    } catch (error) {
      this.log.warn(`failed to persist plan spec: ${errorMessage(error)}`);
      return null;
    }
  }

  /** Cancel every pending Plan exit (client died / replaced) without hanging the agent. */
  private cancelAllPlanExits(reason: string): number {
    const cancelled = this.pendingPlanExits.size;
    for (const [id, pending] of this.pendingPlanExits) {
      clearTimeout(pending.timer);
      this.store.clearPlanExit(id);
      this.store.resolveExitPlanModeBlock(false);
      this.store.planExitResolutionNote(reason);
      pending.resolve({ approved: false, reason });
    }
    this.pendingPlanExits.clear();
    return cancelled;
  }

  // --- User questions flow (_iflow/user/questions, ask_user_question tool) ----

  /**
   * Surface the `ask_user_question` tool's questions as a card. Resolves with
   * the user's answers (keyed by question `header`) — the wire contract the
   * CLI's tool bridge expects (probed, CLI 0.5.19: `s.answers` is read
   * directly; a missing map means "no answer").
   */
  private userQuestionsFromAgent(req: UserQuestionsRequest): Promise<UserQuestionsResponse> {
    const id = `q-${++this.approvalSeq}`;
    const now = Date.now();

    return new Promise<UserQuestionsResponse>((resolve) => {
      const timer = setTimeout(() => {
        // Safety: an unanswered card must not block the agent forever.
        this.pendingQuestions.delete(id);
        // Resolve FIRST — see the approval-timeout comment above.
        resolve({ answers: {} });
        this.store.clearQuestions(id);
        this.store.appendNotice(vscode.l10n.t("提问超时，已按未回答继续"));
        this.armPostRejectionWatchdog();
      }, APPROVAL_TIMEOUT_MS);

      this.pendingQuestions.set(id, { resolve, timer });
      this.store.showQuestions({
        id,
        questions: req.questions,
        deadline: now + APPROVAL_TIMEOUT_MS,
        timeoutMs: APPROVAL_TIMEOUT_MS,
      });
      // M1 P0-5 + policy 2026-10-16: the question card is an OS trigger only
      // while it is the displayed card — same slot-mirror re-check as approvals.
      this.toastWhileDisplayed(
        () => this.pendingQuestions.has(id) &&
          this.store.getState().pendingQuestions?.id === id,
        "question",
        () => vscode.l10n.t("iFlow 有问题需要你回答（{0} 秒后自动继续）", Math.round(APPROVAL_TIMEOUT_MS / 1000)),
      );
    });
  }

  /** Webview answers (or dismisses) the pending question card. */
  private handleQuestionAnswers(id: string, answers: Record<string, string | string[]>): void {
    const pending = this.pendingQuestions.get(id);
    if (!pending) return;
    this.pendingQuestions.delete(id);
    clearTimeout(pending.timer);
    this.store.clearQuestions(id);
    const answered = Object.keys(answers).length;
    this.store.appendNotice(
      answered > 0
        ? vscode.l10n.t("已回答 {0} 个问题", answered)
        : vscode.l10n.t("已跳过提问"),
    );
    pending.resolve({ answers });
  }

  /** Tear down pending question cards (session reset / dispose / CLI exit). */
  private cancelAllPendingQuestions(reason: string): void {
    for (const [, pending] of this.pendingQuestions) {
      clearTimeout(pending.timer);
      if (reason) this.store.appendNotice(reason);
      pending.resolve({ answers: {} });
    }
    this.pendingQuestions.clear();
  }

  // --- Profile-switch choice dialog (extension-side, custom webview modal) ----

  /**
   * Ask the user how a profile switch should treat the current conversation,
   * rendered as a custom centered modal in the webview (the native
   * showWarningMessage dialog breaks the panel's acrylic visual language).
   * Resolves `true` = keep & reload the session, `false` = start a new
   * session, `null` = the user cancelled the entire switch. No timeout: the
   * dialog blocks no agent, so it waits for the user; every teardown path
   * resolves pending dialogs as cancelled (see cancelAllProfileSwitches).
   */
  private requestProfileSwitchChoice(profileName: string): Promise<boolean | null> {
    // The webview's optimistic switch chip expires after 10s, so the profile
    // dropdown is clickable again while this dialog is open — a second switch
    // would overwrite the store's single dialog slot and orphan the first
    // promise. Cancel any open dialog first (its switch is abandoned).
    this.cancelAllProfileSwitches();
    const id = `pswitch-${++this.profileSwitchSeq}`;
    const pending: PendingProfileSwitchUi = { id, profileName };
    return new Promise<boolean | null>((resolve) => {
      this.pendingProfileSwitches.set(id, { resolve });
      this.store.showProfileSwitch(pending);
    });
  }

  /** Resolve a pending profile-switch dialog from the webview's answer. */
  private handleProfileSwitchResponse(id: string, keepSession: boolean | null): void {
    const pending = this.pendingProfileSwitches.get(id);
    if (!pending) return;
    this.pendingProfileSwitches.delete(id);
    this.store.clearProfileSwitch(id);
    pending.resolve(keepSession);
  }

  /**
   * Resolve every open profile-switch dialog as cancelled (panel dispose /
   * session teardown). Without this the activateProfile promise would hang
   * forever on a webview that can no longer answer, keeping its reconnect
   * chain alive behind a dead panel.
   */
  private cancelAllProfileSwitches(): void {
    for (const [id, pending] of this.pendingProfileSwitches) {
      this.store.clearProfileSwitch(id);
      pending.resolve(null);
    }
    this.pendingProfileSwitches.clear();
  }

  // --- Diff revert ----------------------------------------------------------------

  /**
   * Open an attached image (data URL) in VSCode's built-in image preview.
   * The webview iframe is sandboxed without allow-popups, so window.open is
   * blocked by the browser — the host materializes the data URL into a temp
   * file and opens that instead. The payload is untrusted webview input:
   * size is capped before any disk I/O, and the write is async so a large
   * payload cannot block the extension host's event loop.
   */
  private async openImageAttachment(dataUrl: string): Promise<void> {
    const match = /^data:image\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
    if (!match) {
      void vscode.window.showWarningMessage(vscode.l10n.t("无法打开该图片附件（数据格式异常）"));
      return;
    }
    if (match[2]!.length > MAX_IMAGE_ATTACHMENT_BYTES) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("图片附件过大（超过 {0} MB），已拒绝打开", Math.floor(MAX_IMAGE_ATTACHMENT_BYTES / 1024 / 1024)),
      );
      return;
    }
    const ext = match[1]!.toLowerCase().replace("jpeg", "jpg");
    try {
      const file = path.join(os.tmpdir(), `iflow-image-${Date.now()}.${ext}`);
      await writeFile(file, Buffer.from(match[2]!, "base64"));
      void vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file));
    } catch (error) {
      const message = errorMessage(error);
      void vscode.window.showWarningMessage(vscode.l10n.t("打开图片失败: {0}", message));
    }
  }

  /**
   * M5: fuzzy workspace file search for the @-mention popup. Plain
   * `findFiles` (glob-excludes) + a simple relevance score is plenty at this
   * scale and avoids pulling in a fuzzy-matching dependency.
   */
  private async searchWorkspaceFiles(requestId: number, query: string, kind: "file" | "folder" = "file"): Promise<void> {
    try {
      const rels = await this.loadWorkspaceFileRels();
      // M2 P0-4: folder search derives the directory set from the same file
      // cache — every ancestor prefix of every file, deduped, trailing "/".
      let candidates = rels;
      if (kind === "folder") {
        const dirs = new Set<string>();
        for (const rel of rels) {
          const parts = rel.split("/");
          let acc = "";
          for (let i = 0; i < parts.length - 1; i++) {
            acc = acc ? `${acc}/${parts[i]}` : parts[i]!;
            if (!acc.split("/").some((seg) => seg.startsWith("."))) dirs.add(`${acc}/`);
          }
        }
        candidates = [...dirs];
      }
      const q = query.trim().toLowerCase();
      const scored = candidates.map((rel) => {
        let score = 0;
        if (q) {
          const lower = rel.toLowerCase();
          const idx = lower.indexOf(q);
          if (idx >= 0) score += 100 - Math.min(50, idx); // earlier match = better
          else {
            // subsequence match (fuzzy) — weaker signal
            let qi = 0;
            for (const ch of lower) {
              if (ch === q[qi]) qi++;
              if (qi >= q.length) break;
            }
            if (qi >= q.length) score += 20;
            else score = -1;
          }
          // Prefer shallower paths and source files.
          score += Math.max(0, 10 - rel.split("/").length);
        }
        return { rel, score };
      })
        .filter((s) => s.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 12);
      this.postToWebview({ type: "fileList", requestId, hits: scored.map((s) => ({ path: s.rel })) });
    } catch (error) {
      this.log.warn(`file search failed: ${errorMessage(error)}`);
      this.postToWebview({ type: "fileList", requestId, hits: [] });
    }
  }

  /**
   * P6: the relative-path list behind the @-mention popup. The first
   * keystroke pays for one `findFiles` scan; afterwards keystrokes score the
   * cached list in memory. Invalidated by workspace file-system changes
   * (watcher registered in the constructor).
   */
  private async loadWorkspaceFileRels(): Promise<string[]> {
    if (this.fileSearchCache) return this.fileSearchCache.rels;
    if (!this.fileSearchInFlight) {
      this.fileSearchInFlight = (async () => {
        const exclude = "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/coverage/**,**/.iflow/**}";
        const uris = await vscode.workspace.findFiles("**/*", exclude, 500);
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
        return uris.map((uri) => path.relative(root, uri.fsPath).replace(/\\/g, "/"));
      })();
      this.fileSearchInFlight.finally(() => {
        this.fileSearchInFlight = null;
      });
    }
    const rels = await this.fileSearchInFlight;
    this.fileSearchCache = { rels };
    return rels;
  }

  /**
   * M5: open the tool's change in VSCode's native diff editor
   * (left: temp file with the pre-edit content, right: current disk file).
   */
  private async openToolDiff(toolCallId: string): Promise<void> {
    const block = findToolBlockById(this.store.getState().blocks, toolCallId);
    if (!block || !block.diff) return;
    const { oldText } = block.diff;
    if (oldText === null) {
      void vscode.window.showWarningMessage(vscode.l10n.t("无法打开 diff：缺少编辑前内容"));
      return;
    }
    const chosen =
      block.diff.newText === null && path.isAbsolute(block.diff.path)
        ? // Deletion diff on a known-absolute path: the native diff editor
          // shows the pre-delete content vs the missing file — the right
          // visualization, and locateDiffFile's probe cannot match a gone file.
          this.resolveAgentPathToAbsolute(block.diff.path)
        : await this.locateDiffFile(block);
    if (!chosen) return;

    // Left side: a temp file holding the pre-edit content. Files live in the
    // OS temp dir (cleaned by the system); the .ts suffix gives highlighting.
    const suffix = path.extname(chosen) || ".txt";
    const tmpOld = path.join(os.tmpdir(), `iflow-old-${Date.now()}-${path.basename(chosen)}`);
    const tmpUri = vscode.Uri.file(tmpOld + (suffix ? "" : suffix));
    try {
      await vscode.workspace.fs.writeFile(tmpUri, Buffer.from(oldText, "utf8"));
    } catch (error) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t("打开 diff 失败: {0}", errorMessage(error)),
      );
      return;
    }
    const title = `${path.basename(chosen)} (${block.toolName || "edit"})`;
    await vscode.commands.executeCommand("vscode.diff", tmpUri, vscode.Uri.file(chosen), title);
  }

  /**
   * 3.5 ②: "查看完整输出" — write a tool block's FULL stored output (up to
   * the 512K store cap) to a temp file and open it in the editor, same
   * temp-file pattern as `openToolDiff`. The webview renders every stored
   * char up to the display cap, so this recovers what the collapsed pane
   * scrolls past; beyond the store cap the honest `truncatedChars` notice
   * stays on the card. Stale block ids (old snapshot after a transcript
   * swap) drop the click silently.
   */
  private async exportToolOutput(blockId: string): Promise<void> {
    const block = this.store.getState().blocks.find(
      (b): b is ToolBlock => b.kind === "tool" && b.id === blockId,
    );
    if (!block) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const slug = (block.title || block.toolName || "tool").replace(/[^\w.-]+/g, "-").slice(0, 40);
    const tmpUri = vscode.Uri.file(path.join(os.tmpdir(), `iflow-output-${stamp}-${slug}.txt`));
    try {
      await vscode.workspace.fs.writeFile(tmpUri, Buffer.from(block.output, "utf8"));
      const doc = await vscode.workspace.openTextDocument(tmpUri);
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (error) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t("导出工具输出失败: {0}", errorMessage(error)),
      );
    }
  }

  /**
   * Resolve a wire-relative path against the cwd the session was created
   * with (AGENTS.md pitfall #8 — the Extension Host's process.cwd() is not
   * necessarily the workspace). Absolute paths pass through unchanged.
   */
  private resolveAgentPathToAbsolute(p: string): string {
    if (path.isAbsolute(p)) return p;
    const base =
      this.sessionCwd
      ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      ?? this.context.extensionUri.fsPath;
    return path.join(base, p);
  }

  /** Resolve which file on disk a tool diff refers to (shared by diff/revert). */
  private async locateDiffFile(block: ToolBlock): Promise<string | null> {
    const { path: rawPath, newText } = block.diff!;
    // The CLI may send workspace-relative paths; resolve them against the cwd
    // the session was created with (the Extension Host's process.cwd() is not
    // necessarily the workspace).
    const sessionBase = this.sessionCwd
      ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      ?? this.context.extensionUri.fsPath;
    const toAbsolute = (p: string) => (path.isAbsolute(p) ? p : path.join(sessionBase, p));

    // diff.path is what the tool was invoked with and may NOT be anchored to
    // the session root (observed: "Home.vue" for src/views/Home.vue). The
    // tool_call locations usually carry the real path — try all candidates,
    // preferring the one whose disk content matches the diff's newText.
    const candidates: string[] = [];
    const seen = new Set<string>();
    const addCandidate = (p?: string | null) => {
      if (!p) return;
      const abs = toAbsolute(p);
      const key = abs.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(abs);
      }
    };
    addCandidate(rawPath);
    for (const loc of block.locations ?? []) addCandidate(loc.path);

    for (const candidate of candidates) {
      const decisive = await this.probeRevertCandidate(candidate, newText);
      if (decisive) return candidate; // disk content === diff newText: the edited file
    }

    // All direct candidates failed (CLI sent a tool-relative path without a
    // usable locations entry). Fall back to a bounded basename search under
    // the session root and workspace folders.
    const basename = path.basename(rawPath.replace(/\\/g, "/"));
    const roots = new Set<string>();
    if (sessionBase) roots.add(sessionBase);
    for (const folder of vscode.workspace.workspaceFolders ?? []) roots.add(folder.uri.fsPath);
    const matches: string[] = [];
    for (const root of roots) {
      matches.push(...(await this.findFileByBasename(root, basename)));
      if (matches.length > 1) break; // enough for a picker
    }
    // Prefer the match whose content equals the diff's newText.
    for (const match of matches) {
      if (newText !== null && (await this.fileContentEquals(match, newText))) {
        return match;
      }
    }
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      const pick = await vscode.window.showQuickPick(matches, {
        placeHolder: vscode.l10n.t('找到多个 "{0}"，选择目标文件', basename),
      });
      return pick ?? null;
    }
    // Last resort: let the user point at the file.
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: vscode.l10n.t("选择目标文件"),
      defaultUri: sessionBase ? vscode.Uri.file(sessionBase) : undefined,
    });
    return picked?.[0]?.fsPath ?? null;
  }

  /**
   * Attach a host-synthesized diff to a completed tool block that never
   * received one on the wire. MCP tools never carry structured diffs (CLI
   * 0.5.19 flattens MCP results to plain text — verified in the bundle), so
   * without this their edits render as a bare output card.
   *
   * Strategy 1 (tool-agnostic): compare the pre-run disk snapshot captured at
   * `in_progress` with the post-completion content — any editing tool
   * (replace-style, write-style, delete, or an MCP editor with unknown arg
   * shape) produces a real before/after diff.
   * Strategy 2 (fallback, no snapshot — e.g. the panel attached mid-session):
   * reverse recognized replacement args on the post-edit file
   * (shared/synthesizeEditDiff).
   * Fire-and-forget: any mismatch (file moved on, ambiguous fragments, read
   * failure) leaves the card unchanged — never a guessed diff (pitfall #6
   * discipline).
   */
  private async maybeSynthesizeToolDiff(toolCallId: string): Promise<void> {
    // Consume both caches up front: a completed tool must never leave stale
    // entries behind (the wire-diff early-return below would otherwise leak
    // them until cap eviction).
    const snapshot = this.preSnapshots.get(toolCallId);
    this.preSnapshots.delete(toolCallId);
    const parsed = this.toolArgs.get(toolCallId);
    this.toolArgs.delete(toolCallId);

    const block = findToolBlockById(this.store.getState().blocks, toolCallId);
    if (!block || block.diff !== null) return;

    if (snapshot) {
      let postContent: string | null = null;
      try {
        const buf = await readFile(snapshot.path);
        if (buf.length <= MAX_SYNTH_DIFF_CHARS && !ChatPanel.isBinary(buf)) postContent = buf.toString("utf8");
      } catch {
        postContent = null; // deleted (or unreadable) — deletion diff below
      }
      if (postContent === null && snapshot.content !== null) {
        // A read error is indistinguishable from a deletion here; only claim a
        // deletion when the file is truly gone (a fabricated revert target is
        // worse than a missing diff). A binary/oversized post-file still
        // exists on disk — existsSync fails those cases closed.
        if (!existsSync(snapshot.path)) {
          const diff = snapshotEditDiff(snapshot, null);
          if (diff) this.store.toolDiffSynthesized(toolCallId, diff);
        }
        return;
      }
      const diff = snapshotEditDiff(snapshot, postContent);
      if (diff) {
        this.store.toolDiffSynthesized(toolCallId, diff);
        return;
      }
      // Content identical (or oversized): fall through to arg reversal in
      // case the tool edited a DIFFERENT path than its args' primary field.
    }

    if (parsed === undefined) return;
    const candidates: string[] = [];
    const seen = new Set<string>();
    const addCandidate = (p?: string | null) => {
      if (!p) return;
      const abs = this.resolveAgentPathToAbsolute(p);
      const key = abs.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(abs);
      }
    };
    addCandidate(parsed.path);
    for (const loc of block.locations ?? []) addCandidate(loc.path);
    for (const candidate of candidates) {
      let postEdit: string;
      try {
        const buf = await readFile(candidate);
        if (ChatPanel.isBinary(buf)) continue;
        postEdit = buf.toString("utf8");
      } catch {
        continue;
      }
      const diff = synthesizeEditDiff(parsed, postEdit);
      if (!diff) continue;
      // Keep the diff path anchored to the resolved absolute location so the
      // revert/diff-editor paths skip the basename-search fallback.
      this.store.toolDiffSynthesized(toolCallId, { ...diff, path: candidate });
      return;
    }
  }

  /**
   * Undo one file's changes in the LATEST completed turn by restoring the
   * pre-edit text of its first recorded diff (the turn-start content).
   * Multiple diffs grouped under the same location-aware identity are undone
   * together.
   *
   * Safety: refuses during generation, on historical turns, when the first
   * diff has no old text, or when the file has unsaved editor changes; asks
   * before recreating a missing file or overwriting content that moved on.
   * The disk is re-read immediately before writing, and session/status are
   * revalidated after every dialog. Editor reloading is left to the file
   * watcher — the dirty-buffer case was refused up front.
   */
  private async revertTurnFile(sessionId: string, userBlockId: string, key: string): Promise<void> {
    const state = this.store.getState();
    if (state.sessionId !== sessionId || !canReviewTurn(state, userBlockId)) return;
    if (!isLatestTurn(state.blocks, userBlockId)) {
      void vscode.window.showWarningMessage(vscode.l10n.t("仅可撤销最近一轮的文件修改"));
      return;
    }
    if (state.status === "streaming" || state.status === "connecting") {
      void vscode.window.showWarningMessage(vscode.l10n.t("当前正在生成，无法撤销文件修改"));
      return;
    }
    const edits = collectTurnToolBlocks(state.blocks, userBlockId)
      .filter((block) => block.diff && turnChangeKey(block) === key);
    if (edits.length === 0) {
      void vscode.window.showWarningMessage(vscode.l10n.t("本轮没有该文件的修改记录"));
      return;
    }
    const first = edits[0]!;
    const last = edits[edits.length - 1]!;
    const oldText = first.diff!.oldText;
    if (oldText === null) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("无法撤销：该文件缺少编辑前内容（可能是本轮新建的文件）"),
      );
      return;
    }
    const lastNew = last.diff!.newText;
    const chosen =
      lastNew === null && path.isAbsolute(last.diff!.path)
        ? this.resolveAgentPathToAbsolute(last.diff!.path)
        : await this.locateDiffFile(last);
    if (!chosen) return;

    const fileUri = vscode.Uri.file(chosen);
    let currentText: string | null = null;
    try {
      currentText = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString("utf8");
    } catch {
      // Missing on disk: writing oldText recreates it.
    }
    const openDoc = vscode.workspace.textDocuments.find(
      (d) => d.uri.fsPath.toLowerCase() === fileUri.fsPath.toLowerCase(),
    );
    if (openDoc?.isDirty) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("该文件在编辑器中有未保存的修改，请先保存或还原后再撤销"),
      );
      return;
    }

    const markReverted = (): void => {
      // The store must still be the same session; a switch during a dialog
      // must never stamp tool ids in the new transcript.
      if (this.store.getState().sessionId !== sessionId) return;
      for (const edit of edits) {
        const current = findToolBlockById(this.store.getState().blocks, edit.toolCallId);
        if (current && !current.reverted) this.store.toolReverted(edit.toolCallId);
      }
    };

    if (currentText === oldText) {
      markReverted();
      void vscode.window.showInformationMessage(vscode.l10n.t("已是本轮开始前的内容，无需撤销: {0}", chosen));
      this.postToWebview({ type: "turnFileReverted", sessionId, userBlockId, key });
      return;
    }
    const chained = edits.every((edit, index) =>
      index === 0 || edit.diff!.oldText === edits[index - 1]!.diff!.newText);
    if (edits.length > 1 && !chained && (currentText === null || currentText === lastNew)) {
      const pick = await vscode.window.showWarningMessage(
        vscode.l10n.t("本轮对该文件有 {0} 次修改记录且内容不连续，撤销将恢复到本轮开始前的内容。继续？", edits.length),
        { modal: true },
        vscode.l10n.t("仍然撤销"),
      );
      if (pick !== vscode.l10n.t("仍然撤销")) return;
    }
    if (currentText === null && lastNew !== null) {
      const pick = await vscode.window.showWarningMessage(
        vscode.l10n.t("该文件当前不存在，撤销将按本轮开始前的内容重建。继续？"),
        { modal: true },
        vscode.l10n.t("重建文件"),
      );
      if (pick !== vscode.l10n.t("重建文件")) return;
    }
    if (currentText !== null && currentText !== lastNew) {
      const pick = await vscode.window.showWarningMessage(
        vscode.l10n.t("文件内容与记录不一致（可能已被继续修改）。仍恢复到本轮开始前的内容？"),
        { modal: true },
        vscode.l10n.t("仍然撤销"),
      );
      if (pick !== vscode.l10n.t("仍然撤销")) return;
    }

    // The dialogs (and locateDiffFile's picker) can wait indefinitely: abort
    // if the file or session changed underneath us, instead of overwriting a
    // newer state with a stale decision.
    let latestText: string | null = null;
    try {
      latestText = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString("utf8");
    } catch {
      // Still missing.
    }
    if (latestText !== currentText) {
      void vscode.window.showWarningMessage(vscode.l10n.t("文件在撤销确认期间被修改，请重试"));
      return;
    }
    const after = this.store.getState();
    if (after.sessionId !== sessionId || after.status === "streaming" || after.status === "connecting" ||
        !isLatestTurn(after.blocks, userBlockId)) {
      void vscode.window.showWarningMessage(vscode.l10n.t("会话状态已变化，撤销已取消"));
      return;
    }

    try {
      // Write through the VSCode file service so watchers stay consistent.
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(oldText, "utf8"));
      markReverted();
      void vscode.window.showInformationMessage(vscode.l10n.t("已撤销本轮对该文件的全部修改: {0}", chosen));
      this.postToWebview({ type: "turnFileReverted", sessionId, userBlockId, key });
    } catch (error) {
      vscode.window.showErrorMessage(
        vscode.l10n.t("撤销文件修改失败: {0}", errorMessage(error)),
      );
    }
  }

  private async revertToolDiff(toolCallId: string): Promise<void> {
    const block = findToolBlockById(this.store.getState().blocks, toolCallId);
    if (!block || !block.diff) return;
    const { oldText, newText } = block.diff;
    if (oldText === null) {
      vscode.window.showWarningMessage(
        vscode.l10n.t("无法回退：该 diff 缺少原始内容（可能是新建文件以外的信息缺失）"),
      );
      return;
    }
    const chosen =
      newText === null && path.isAbsolute(block.diff.path)
        ? // Deletion diff on a known-absolute path (synthesized deletions
          // always record one): revert recreates the file there —
          // locateDiffFile's disk-content probe can never match a missing
          // file and would dead-end at the manual picker. Relative paths
          // keep the full locateDiffFile resolution (pitfall #6).
          this.resolveAgentPathToAbsolute(block.diff.path)
        : await this.locateDiffFile(block);
    if (!chosen) return;

    const fileUri = vscode.Uri.file(chosen);
    let currentText: string | null = null;
    try {
      currentText = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString("utf8");
    } catch {
      // File missing on disk — writing oldText will (re)create it; that is the
      // best-possible revert for a deleted file.
    }
    try {
      const openDoc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath.toLowerCase() === fileUri.fsPath.toLowerCase(),
      );
      if (openDoc?.isDirty) {
        const pick = await vscode.window.showWarningMessage(
          vscode.l10n.t("该文件在编辑器中有未保存的修改。回退将从磁盘重新加载并丢弃这些修改。"),
          { modal: true },
          vscode.l10n.t("丢弃并回退"),
        );
        if (pick !== vscode.l10n.t("丢弃并回退")) return;
      }

      if (newText !== null && currentText === oldText) {
        // Already reverted (e.g. the CLI undid it, or a previous retry landed).
        this.store.toolReverted(toolCallId);
        void vscode.window.showInformationMessage(vscode.l10n.t("已是原始内容，无需回退: {0}", chosen));
        return;
      }
      if (newText !== null && currentText !== null && currentText !== newText) {
        const pick = await vscode.window.showWarningMessage(
          vscode.l10n.t("文件内容与 diff 记录不一致（可能已被继续修改）。仍按 diff 原始内容回退？"),
          { modal: true },
          vscode.l10n.t("仍然回退"),
        );
        if (pick !== vscode.l10n.t("仍然回退")) return;
      }

      // Write through the VSCode file service so watchers stay consistent
      // (raw fs.writeFile bypasses them).
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(oldText, "utf8"));
      // Reveal + reload the document so the user immediately sees the revert.
      const doc = openDoc ?? (await vscode.workspace.openTextDocument(fileUri));
      await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
      if (doc.isDirty) {
        // Reload the editor from disk, discarding the stale unsaved buffer.
        await vscode.commands.executeCommand("workbench.action.files.revert");
      }
      this.store.toolReverted(toolCallId);
      void vscode.window.showInformationMessage(vscode.l10n.t("已回退: {0}", chosen));
    } catch (error) {
      vscode.window.showErrorMessage(
        vscode.l10n.t("回退失败: {0}", errorMessage(error)),
      );
    }
  }

  /**
   * M4 P0-2 — apply a per-hunk keep/revert decision. Deterministic: the target
   * text is replayed from the diff's oldText with only the kept hunks applied
   * (shared/hunks.ts), so no fuzzy patching ever touches the file. The op is
   * REFUSED when disk content no longer equals the diff's newText — the file
   * moved on since the edit, and a partial write would be guesswork (the
   * roadmap routes that case to the turn checkpoint instead).
   */
  private async applyHunkSelection(toolCallId: string, keep: boolean[]): Promise<void> {
    const block = findToolBlockById(this.store.getState().blocks, toolCallId);
    if (!block || !block.diff) return;
    const { oldText, newText } = block.diff;
    if (oldText === null || newText === null) {
      // Creation/deletion diffs have no per-hunk semantics — whole-file revert
      // (or nothing) is the only meaningful action there.
      vscode.window.showWarningMessage(
        vscode.l10n.t("无法逐块回退：新建或删除文件只能整文件处理"),
      );
      return;
    }
    const hunks = computeHunks(oldText, newText);
    if (!hunks || hunks.length === 0) {
      vscode.window.showWarningMessage(vscode.l10n.t("该改动无法逐块回退，请使用整文件回退"));
      return;
    }
    if (keep.length !== hunks.length) {
      this.log.warn(`applyHunkSelection: decision length ${keep.length} ≠ hunk count ${hunks.length}`);
      return;
    }
    if (!keep.some((k) => k)) {
      // Nothing kept = whole-file revert; route through the battle-tested path
      // (it owns the already-reverted short-circuit and messaging).
      await this.revertToolDiff(toolCallId);
      return;
    }
    if (keep.every((k) => k)) {
      void vscode.window.showInformationMessage(vscode.l10n.t("未回退任何改动"));
      return;
    }

    const chosen = await this.locateDiffFile(block);
    if (!chosen) return;
    const fileUri = vscode.Uri.file(chosen);
    let currentText: string | null = null;
    try {
      currentText = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString("utf8");
    } catch {
      currentText = null;
    }
    if (currentText !== newText) {
      // Refuse rather than fuzzy-merge: the diff's line ranges no longer map
      // onto the file. The user can restore the whole turn via the checkpoint.
      void vscode.window.showWarningMessage(
        vscode.l10n.t("文件内容与 diff 记录不一致（可能已被继续修改）。请先回退整份改动，或使用「回滚到此轮之前」。"),
      );
      return;
    }

    try {
      const openDoc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath.toLowerCase() === fileUri.fsPath.toLowerCase(),
      );
      if (openDoc?.isDirty) {
        const pick = await vscode.window.showWarningMessage(
          vscode.l10n.t("该文件在编辑器中有未保存的修改。逐块回退将从磁盘重新加载并丢弃这些修改。"),
          { modal: true },
          vscode.l10n.t("丢弃并回退"),
        );
        if (pick !== vscode.l10n.t("丢弃并回退")) return;
      }

      const targetText = replayHunks(oldText, newText, hunks, keep);
      // Write through the VSCode file service so watchers stay consistent
      // (raw fs.writeFile bypasses them — pitfall #9).
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(targetText, "utf8"));
      const doc = openDoc ?? (await vscode.workspace.openTextDocument(fileUri));
      await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
      if (doc.isDirty) {
        await vscode.commands.executeCommand("workbench.action.files.revert");
      }
      const revertedCount = keep.filter((k) => !k).length;
      this.store.toolHunkDecisions(toolCallId, keep, true);
      void vscode.window.showInformationMessage(
        vscode.l10n.t("已回退 {0} 处改动（保留 {1} 处）: {2}", revertedCount, keep.length - revertedCount, chosen),
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        vscode.l10n.t("逐块回退失败: {0}", errorMessage(error)),
      );
    }
  }

  /** True when disk content === diff newText (decisive "this is the edited file"). */
  private async probeRevertCandidate(candidate: string, newText: string | null): Promise<boolean> {
    if (newText === null) return false;
    try {
      const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(candidate));
      return Buffer.from(buf).toString("utf8") === newText;
    } catch {
      return false;
    }
  }

  private async fileContentEquals(file: string, expected: string): Promise<boolean> {
    try {
      const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
      return Buffer.from(buf).toString("utf8") === expected;
    } catch {
      return false;
    }
  }

  /** Bounded case-insensitive basename search; skips heavy dirs, capped. */
  private async findFileByBasename(root: string, basename: string, maxDepth = 6): Promise<string[]> {
    const results: string[] = [];
    const target = basename.toLowerCase();
    const skip = new Set(["node_modules", ".git", "dist", "out", "build", "coverage", ".iflow", ".vscode"]);
    // C8: budget by directories walked, not entries seen — readdir cost is
    // dominated by the directory count, and per-entry counting exhausted the
    // old 20k budget prematurely in wide directories.
    let dirsVisited = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > maxDepth || dirsVisited > 2_000 || results.length >= 10) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // unreadable / not a dir
      }
      dirsVisited++;
      for (const entry of entries) {
        if (results.length >= 10) return;
        const full = path.join(dir, entry.name);
        if (entry.isFile() && entry.name.toLowerCase() === target) {
          results.push(full);
        } else if (entry.isDirectory() && !skip.has(entry.name.toLowerCase())) {
          await walk(full, depth + 1);
        }
      }
    };
    await walk(root, 0);
    return results;
  }

  // --- Auth (M3: openai-compatible credentials in SecretStorage) ----------------

  private maskOf(creds: OpenAiCompatCredentials): AuthUiState["saved"] {
    return { baseUrl: creds.baseUrl, modelName: creds.modelName, keyTail: maskKey(creds.apiKey) };
  }

  /**
   * Mirror the CLI-bound extension settings (language / approvalMode) into
   * `~/.iflow/settings.json`. The CLI reads both only at startup (probed,
   * CLI 0.5.19 bundle: Config loads settings once, the `/language` command
   * itself prints "restartRequired"), so an empty value means "don't touch
   * the CLI's own entry" and a successful write offers an immediate hot
   * restart. Deliberately one-way: reading these back into the VSCode config
   * would ping-pong against the CLI's own settings rewrites (it serializes
   * its whole in-memory copy on authenticate). MCP servers are NOT part of
   * this path — the MCP management card reads/writes settings.json directly
   * (a text setting would be a second source of truth overwriting the card).
   */
  private cliSettingsSyncTimer: NodeJS.Timeout | undefined;
  private syncCliSettingsToDisk(): void {
    // The Settings UI applies string edits per keystroke — debounce so only
    // the settled value syncs (and prompts a restart) once.
    if (this.cliSettingsSyncTimer) clearTimeout(this.cliSettingsSyncTimer);
    this.cliSettingsSyncTimer = setTimeout(() => {
      this.cliSettingsSyncRun();
    }, 600);
  }

  private cliSettingsSyncRun(): void {
    const cfg = vscode.workspace.getConfiguration("iflow");
    const patch: Partial<CliSettingsShape> = {};
    const language = cfg.get<string>("language", "");
    if (language) patch.language = language;
    const approvalMode = cfg.get<string>("approvalMode", "");
    if (approvalMode) patch.approvalMode = approvalMode;
    if (Object.keys(patch).length === 0) return;
    if (!updateCliSettings(patch)) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("无法写入 {0}（文件缺失或不可读），内核配置未同步", settingsFilePath()),
      );
      return;
    }
    this.log.info(`CLI settings synced to settings.json: ${Object.keys(patch).join(", ")}`);
    const restartLabel = vscode.l10n.t("立即重启");
    void vscode.window
      .showInformationMessage(
        vscode.l10n.t("已写入内核配置，重启内核后生效"),
        restartLabel,
      )
      .then((choice) => {
        if (choice === restartLabel) void this.restartCli();
      });
  }

  /**
   * Hot-restart the CLI child (settings-page / command palette): kill the
   * process, spawn a fresh one, and re-establish the session. Mirrors the
   * profile-switch cold path — the transcript survives (persisted first),
   * and the handshake's startup branch restores the CURRENT session via
   * `restartRestoreId` regardless of `iflow.restoreLastSession` (a restart
   * must not silently drop the conversation the user was looking at).
   */
  async restartCli(): Promise<void> {
    if (this.disposed) return;
    if (this.historySyncBusy) {
      // A silent refusal here is indistinguishable from a dead button — the
      // splash's 「重启内核」 and the error banner's 「重试」 are the only escape
      // hatches in a wedged state, so say why the restart did not run.
      void vscode.window.showWarningMessage(
        vscode.l10n.t("正在同步会话历史，请等待完成后再重启内核"),
      );
      return;
    }
    const state = this.store.getState();
    if (state.status === "streaming" || state.initializing) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("正在生成中，请等待完成或先停止，再重启内核"),
      );
      return;
    }
    const outgoingId = state.activeSessionId ?? state.sessionId;
    if (outgoingId) {
      // A restart must NOT drop the conversation the user is looking at: the
      // handshake's startup branch restores this id regardless of
      // iflow.restoreLastSession.
      this.restartRestoreId = outgoingId;
    }
    this.cancelAllApprovals(vscode.l10n.t("内核已重启"));
    this.cancelAllPlanExits(vscode.l10n.t("内核已重启，计划审批已跳过"));
    this.cancelAllPendingQuestions("");
    // Tail rescue BEFORE the state swap (same rationale as the profile
    // switch): the in-memory blocks are discarded by replaceState below.
    void this.persistActiveTranscript();
    const oldClient = this.client;
    this.client = null;
    // P0-3: a handshake still in flight owns its own child. ensureClient
    // assigns `this.client = client` BEFORE awaiting connect(), so oldClient
    // above already holds the wedged in-flight child whose dispose() (below)
    // rejects its pending initialize immediately instead of waiting out the
    // 120s timeout. But `connecting` would be handed straight back to the
    // ensureClient call below — the restart would silently no-op onto the
    // wedged promise. Supersede it: bump the generation (the old handshake's
    // catch/finally guards then neutralize its shared-state writes) and detach
    // `connecting` so ensureClient spawns a fresh CLI.
    if (this.connecting) {
      this.connectGeneration++;
      this.connecting = null;
    }
    this.store.replaceState(newSessionState(this.store.getState()));
    this.store.markConnecting();
    // Kill the old child while the new one boots (independent processes).
    const teardown = oldClient?.dispose().catch(() => {}) ?? Promise.resolve();
    const tRestart = Date.now();
    try {
      await this.ensureClient();
      this.log.info(`CLI restarted in ${Date.now() - tRestart}ms`);
    } catch {
      // ensureClient already marked the error in the store.
      this.restartRestoreId = null;
    } finally {
      await teardown;
    }
  }

  /** The project root the CLI's Workspace-scope settings hang off (same
   * resolution the asset/memory services use: session cwd first, then the
   * first workspace folder). */
  private mcpProjectCwd(): string | null {
    return this.sessionCwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  }

  /** Both MCP scopes as they stand on disk. `project` is null when there is no
   * project scope at all (no cwd, or cwd IS the home dir — the CLI skips its
   * Workspace file there too). `error` is only set for a file that EXISTS but
   * could not be parsed: a missing project file is the normal case, and
   * reporting it would put a red banner on every project without one. */
  private readMcpScopes(): {
    global: Record<string, unknown>;
    project: Record<string, unknown> | null;
    error?: string;
  } {
    const globalFile = settingsFilePath();
    const projectFile = projectSettingsFor(this.mcpProjectCwd());
    const global = readMcpServers(globalFile);
    const project = projectFile ? readMcpServers(projectFile) : null;
    const unreadable = [globalFile, projectFile].filter(
      (file, i) => file && (i === 0 ? global === null : project === null),
    );
    return {
      global: global ?? {},
      project,
      ...(unreadable.length > 0
        ? { error: vscode.l10n.t("无法读取 {0}（文件缺失或不可读）", unreadable.join("、")) }
        : {}),
    };
  }

  /** MCP card opened: reply with the CURRENT mcpServers dicts of BOTH scopes.
   * A missing/absent field is an empty dict (a fresh CLI install simply has
   * none), not an error. */
  private sendMcpServers(): void {
    this.postToWebview({ type: "mcpServers", ...this.readMcpScopes() });
  }

  /** MCP card saved: replace the whole dict of ONE scope in that scope's
   * settings.json (see the replace-semantics note on the WebviewToHost
   * message), then offer the same hot-restart affordance as the
   * language/approvalMode sync path — the CLI only reads mcpServers at
   * startup. The project file is created when absent (the CLI's own
   * `mcp add --scope project` does the same); the global file is not, so a
   * broken global config surfaces instead of being silently rebuilt. */
  private saveMcpServers(scope: McpScope, servers: Record<string, unknown>): void {
    const file = scope === "global" ? settingsFilePath() : projectSettingsFor(this.mcpProjectCwd());
    if (!file) {
      this.postToWebview({
        type: "mcpServers",
        ...this.readMcpScopes(),
        error: vscode.l10n.t("没有打开工作区，无法保存项目级 MCP 配置"),
      });
      return;
    }
    if (!updateCliSettings({ mcpServers: servers }, file, { createIfMissing: scope === "project" })) {
      this.postToWebview({
        type: "mcpServers",
        ...this.readMcpScopes(),
        error: vscode.l10n.t("无法写入 {0}（文件缺失或不可读），MCP 配置未保存", file),
      });
      return;
    }
    this.log.info(`MCP servers saved (${scope}): ${Object.keys(servers).join(", ") || "(none)"}`);
    this.sendMcpServers();
    const restartLabel = vscode.l10n.t("立即重启");
    void vscode.window
      .showInformationMessage(
        vscode.l10n.t("已写入内核配置，重启内核后生效"),
        restartLabel,
      )
      .then((choice) => {
        if (choice === restartLabel) void this.restartCli();
      });
  }

  /**
   * MCP card asked for live connection state: query the CLI's `_iflow/mcp/status`
   * (mcp-status-refactor Mod) and append the host-computed `contextTokens` per
   * server — the BPE of the tool declarations the CLI injects into every request
   * (the CLI itself has no such estimate, and re-tokenizing on the webview per
   * render would be wasteful). Every failure mode degrades to `status: null`
   * (CLI not running, Mod missing → methodNotFound, Mod disabled → available:false,
   * session not started yet): the card shows NO indicator rather than a wrong one.
   */
  private async sendMcpStatus(): Promise<void> {
    const client = this.client;
    const sessionId = this.store.getState().sessionId;
    if (!client || !sessionId) {
      this.postToWebview({ type: "mcpStatus", status: null });
      return;
    }
    let report: McpStatusReport | null = null;
    try {
      report = await client.mcpStatus(sessionId);
    } catch (error) {
      this.log.warn(`mcpStatus unavailable: ${errorMessage(error)}`);
    }
    if (!report || !report.available) {
      this.postToWebview({ type: "mcpStatus", status: null });
      return;
    }
    const scopes = this.readMcpScopes();
    const servers: Record<
      string,
      McpServerStatusView & { contextTokens?: number; scope?: McpScope | "both" }
    > = {};
    for (const [name, view] of Object.entries(report.servers ?? {})) {
      servers[name] = {
        ...view,
        contextTokens: estimateMcpContextTokens(view.tools ?? []),
        scope: mcpScopeOf(name, scopes.global, scopes.project),
      };
    }
    const status: McpStatusUi = {
      discoveryState: report.discoveryState,
      servers,
    };
    this.postToWebview({ type: "mcpStatus", status });
  }

  /**
   * The API profile list, read from the kernel's settings.json `apiProfiles`
   * (the single persistence authority). SecretStorage entries are only shown
   * for names the kernel does not have yet — that happens when the one-time
   * migration could not write (e.g. an unreadable kernel file); the kernel
   * entry wins on a collision and an upgrade never hides the user's config.
   */
  private async buildAuthLists(): Promise<AuthUiState["profiles"]> {
    const kernelProfiles = readKernelApiProfiles();
    const legacyProfiles = await loadProfiles(this.context.secrets);
    const cli = readCliSettings();
    // The kernel pointer is authoritative (resolveActiveProfileName), with the
    // panel record as fallback; this workspace's own selection wins locally.
    const workspaceName = this.context.workspaceState.get<string>(WORKSPACE_PROFILE_KEY)?.trim();
    const activeName = workspaceName || resolveActiveProfileName(cli, await getActiveProfileName(this.context.secrets));
    const list: AuthUiState["profiles"] = [];
    const push = (name: string, p: OpenAiCompatCredentials) => {
      list.push({
        name,
        baseUrl: p.baseUrl,
        modelName: p.modelName,
        keyTail: maskKey(p.apiKey),
        active: name === activeName,
      });
    };
    for (const [name, p] of Object.entries(kernelProfiles)) push(name, p);
    for (const [name, p] of Object.entries(legacyProfiles)) {
      if (!kernelProfiles[name]) push(name, p);
    }
    return list;
  }

  private async buildAuthState(authenticated: boolean, needsSetup: boolean): Promise<AuthUiState> {
    // One-time upgrade of SecretStorage-only profiles into the kernel file.
    // Idempotent and never overwrites a same-named kernel entry; a write
    // failure is logged and swallowed (the SecretStorage record still shows
    // up in the list and keeps working as the runtime cache).
    if (!this.authProfilesMigrated) {
      this.authProfilesMigrated = true;
      const migrated = migrateKernelApiProfiles(await loadProfiles(this.context.secrets));
      if (migrated.length > 0) {
        this.log.info(
          `migrated ${migrated.length} API profile(s) into the kernel settings: ${migrated.join(", ")}`,
        );
      }
    }
    // P7: computed fresh every call — the old cache went stale between write
    // points (e.g. `saved` outliving a deleted profile until the next save).
    // Resolve this workspace's profile first; the SecretStorage credentials
    // slot is shared by all windows and is not a per-panel source of truth.
    const creds = (await this.resolveWorkspaceHandshakeCreds()) ?? (await loadCredentials(this.context.secrets));
    const profiles = await this.buildAuthLists();
    return {
      authenticated,
      needsSetup,
      saved: creds ? this.maskOf(creds) : null,
      profiles,
      onboardingDismissed: this.context.workspaceState.get<boolean>(
        ONBOARDING_DISMISSED_KEY,
        false,
      ),
    };
  }

  private async saveAuthAndReconnect(
    baseUrl: string,
    apiKey: string | null,
    modelName: string,
    profileName: string | null,
    replaceName: string | null = null,
  ): Promise<void> {
    // `replaceName` is the name this profile had BEFORE the edit (absent for a
    // brand-new profile). Editing is NOT a profile switch: only the edited row
    // may change — the active pointer, the live CLI and this workspace's model
    // record stay untouched unless the edited row is the one the panel is
    // actually running on (user-reported "编辑别的配置把面板重启了").
    const stored = (await this.resolveWorkspaceHandshakeCreds()) ?? (await loadCredentials(this.context.secrets));
    const replaced = replaceName?.trim() || null;
    const profiles = await loadProfiles(this.context.secrets);
    // The row being edited: the kernel profile of that name (the authority),
    // falling back to the SecretStorage cache for not-yet-migrated entries.
    const previous = replaced ? this.kernelProfileCredentials(replaced) ?? profiles[replaced] ?? null : null;
    // A blank key on an EDIT means "keep THIS row's key". Falling back to the
    // live/global credentials here would silently copy the active profile's
    // key into an unrelated row (user-reported). No key anywhere → the user
    // has to type one; never borrow another profile's secret.
    const effectiveKey = apiKey ?? (replaced ? previous?.apiKey ?? null : stored?.apiKey ?? null);
    if (replaced && !effectiveKey) {
      this.store.markError(vscode.l10n.t("编辑 API 配置时请填写 API Key"));
      return;
    }
    const validation = validateCredentials({
      baseUrl,
      apiKey: effectiveKey,
      modelName,
    });
    if (!validation.ok) {
      this.store.markError(validation.error);
      return;
    }
    const creds = validation.value;

    // Upsert as a named profile. Default name: the model (distinct enough for
    // most setups; users can rename by re-saving under a custom name).
    const name = profileName?.trim() || creds.modelName;
    // Renaming onto an existing row would overwrite that row's credentials and
    // delete the old key (user-reported). Refuse and leave SecretStorage
    // untouched — a silent clobber is unrecoverable for the user. The kernel
    // file is checked too: a profile that lives only there (written by the CLI
    // or not yet migrated into SecretStorage) must not be clobbered either.
    const kernelNames = new Set(
      Object.keys(readCliSettings()?.apiProfiles ?? {}).map((key) => key.trim()),
    );
    if (replaced && replaced !== name && (profiles[name] || kernelNames.has(name))) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("已存在同名 API 配置: {0}，请换一个名称", name),
      );
      const auth = this.store.getState().auth;
      this.store.setAuth(await this.buildAuthState(auth.authenticated, auth.needsSetup));
      return;
    }
    if (replaced && replaced !== name) {
      delete profiles[replaced];
    }
    profiles[name] = { baseUrl: creds.baseUrl, apiKey: creds.apiKey, modelName: creds.modelName };
    await saveProfiles(this.context.secrets, profiles);
    // The kernel settings.json is the persistence authority; the SecretStorage
    // write above remains the runtime cache used for hot re-authentication.
    const kernelWritten = writeKernelApiProfile(name, creds);
    if (kernelWritten && replaced && replaced !== name) deleteKernelApiProfile(replaced);
    if (!kernelWritten) {
      // Never report a silent success: the profile only lives in this
      // window's SecretStorage until the kernel file becomes writable.
      void vscode.window.showWarningMessage(vscode.l10n.t("无法写入内核配置 {0}", name));
    }

    // "Is this the row the panel is running on?" — by credential IDENTITY,
    // never by the final name: a new profile defaulting to the current model,
    // or a rename landing on the active name, must not be mistaken for an edit
    // of the active profile. The identity is what the handshake actually uses
    // (`resolveWorkspaceHandshakeCreds` → global slot), not the CLI settings'
    // or an old secret's profile name.
    const isEdit = replaced !== null;
    const isActiveProfile = isEdit && this.sameCredentials(stored, previous);

    if (!isEdit) {
      // Brand-new profile (incl. OnboardingWizard): unchanged behavior — it
      // becomes this workspace's selected profile and the panel reconnects
      // under it (explicit `keepSession = false`: never an in-place edit).
      await this.context.workspaceState.update(WORKSPACE_PROFILE_KEY, name);
      setKernelActiveProfile(name);
      await this.rememberWorkspaceModelFor(name, creds.modelName);
      await this.reconnectWithCredentials(creds, false);
      return;
    }

    if (!isActiveProfile) {
      // Editing some OTHER row: save + refresh the list only. No activation,
      // no reconnect, no pointer move — the panel keeps running as it was.
      const auth = this.store.getState().auth;
      this.store.setAuth(await this.buildAuthState(auth.authenticated, auth.needsSetup));
      return;
    }

    // The edited row is the live one: follow a rename in the pointer, then
    // re-authenticate hot and reload the SAME conversation in place.
    await this.context.workspaceState.update(WORKSPACE_PROFILE_KEY, name);
    setKernelActiveProfile(name);
    await this.rememberWorkspaceModelFor(name, creds.modelName);
    if (this.restoring || this.connecting || this.historySyncBusy) {
      // A connect/restore/history reload is in flight and owns the process:
      // tearing it down would kill the handshake the user is waiting for (and
      // `reconnectWithCredentials` would bail out silently on
      // `historySyncBusy`, leaving the list showing the OLD values with zero
      // feedback — the user reads that as "保存失败"). Persist + refresh, and
      // say plainly which credentials this connection still uses.
      const auth = this.store.getState().auth;
      this.store.setAuth(await this.buildAuthState(auth.authenticated, auth.needsSetup));
      void vscode.window.showInformationMessage(
        vscode.l10n.t("API 配置已保存；本次连接仍在用旧凭据，重新连接后生效"),
      );
      return;
    }
    await this.reconnectWithCredentials(creds, true);
  }

  /** True when two credential sets describe the same endpoint ("current
   * profile" identity: name is NOT part of it — the same credentials may be
   * saved under a different name, and a fresh profile may default to the
   * active name without being the active profile). Normalized the way
   * `validateCredentials` stores values. */
  private sameCredentials(
    a: OpenAiCompatCredentials | null,
    b: OpenAiCompatCredentials | null,
  ): boolean {
    if (!a || !b) return false;
    const norm = (c: OpenAiCompatCredentials) => ({
      baseUrl: c.baseUrl.trim().replace(/\/+$/, ""),
      apiKey: c.apiKey.trim(),
      modelName: c.modelName.trim(),
    });
    const x = norm(a);
    const y = norm(b);
    return x.baseUrl === y.baseUrl && x.apiKey === y.apiKey && x.modelName === y.modelName;
  }

  /** Switch the active API profile and re-authenticate the session. */
  private async activateProfile(name: string): Promise<void> {
    if (this.historySyncBusy) return;
    const profiles = await loadProfiles(this.context.secrets);
    const kernelCreds = this.kernelProfileCredentials(name);
    const creds: OpenAiCompatCredentials | null = kernelCreds ?? (profiles[name] ? { ...profiles[name] } : null);
    if (!creds) {
      vscode.window.showWarningMessage(vscode.l10n.t("未找到 API 配置: {0}", name));
      return;
    }
    // User directive (2026-10-06): a profile switch must not silently drop
    // the conversation — ask first. The live ACP session id is the usual
    // signal, but a visible transcript must gate the switch too: sessionId
    // is still null while the panel is connecting/restoring, and re-authing
    // immediately would drop the conversation the user is looking at.
    // "Stay" reloads the SAME conversation via session/load under the new
    // credentials — a live ACP session keeps the OLD endpoint after hot
    // authenticate, only new/load rebuild config from the updated authOptions
    // (bundle-verified, CLI 0.5.19, see reloadSessionUnderCreds).
    const state = this.store.getState();
    const liveSessionId = state.sessionId;
    const hasConversation = state.blocks.some((block) => block.kind === "user");
    let keepSession = false;
    if (liveSessionId || hasConversation) {
      const choice = await this.requestProfileSwitchChoice(name);
      // null = user cancelled the entire switch: no secret writes, no
      // settings.json pointer change, no reconnect. The dialog already
      // cleared itself from the store; pushSnapshot clears the webview's
      // pending chip (it would otherwise sit until its 10s timeout).
      if (choice === null) {
        this.store.pushSnapshot();
        return;
      }
      keepSession = choice;
    }
    // Do not update the global SecretStorage active pointer or credentials
    // slot: those values are shared by other VS Code windows. This panel's
    // workspace record and explicit `creds` remain isolated instead. The
    // kernel pointer (settings.json currentApiProfile) is the durable record
    // every window and the terminal CLI agree on.
    await this.context.workspaceState.update(WORKSPACE_PROFILE_KEY, name);
    setKernelActiveProfile(name);
    if (!this.workspaceModelId(name)) {
      await this.rememberWorkspaceModelFor(name, creds.modelName);
    }
    await this.reconnectWithCredentials(creds, keepSession);
  }

  /** Read a profile from the kernel settings.json — the persistence authority. */
  private kernelProfileCredentials(name: string): OpenAiCompatCredentials | null {
    return readKernelApiProfiles()[name] ?? null;
  }

  /** Resolve the active profile label for THIS window. */
  private async workspaceActiveProfileName(): Promise<string | null> {
    const workspaceName = this.context.workspaceState.get<string>(WORKSPACE_PROFILE_KEY)?.trim();
    return workspaceName || (await getActiveProfileName(this.context.secrets));
  }

  /**
   * Credentials of the profile THIS workspace last activated, or null when
   * there is no record / the record is stale. SecretStorage's active pointer
   * and credentials slot are global, so this function must be read-only: a
   * second VS Code window may be using a different profile at the same time.
   */
  private async resolveWorkspaceHandshakeCreds(): Promise<OpenAiCompatCredentials | null> {
    const name = this.context.workspaceState.get<string>(WORKSPACE_PROFILE_KEY);
    if (!name?.trim()) return null;
    const trimmed = name.trim();
    const profiles = await loadProfiles(this.context.secrets);
    const creds = this.kernelProfileCredentials(trimmed) ?? (profiles[trimmed] ? { ...profiles[trimmed] } : null);
    if (!creds) return null;
    this.log.info(`workspace API profile restored: ${trimmed}`);
    return creds;
  }

  /** Return the last model selected for a workspace profile, if any. */
  private workspaceModelId(profileName?: string): string | null {
    const name = profileName?.trim() || this.context.workspaceState.get<string>(WORKSPACE_PROFILE_KEY)?.trim();
    if (!name) return null;
    const saved = this.context.workspaceState.get<Record<string, unknown>>(WORKSPACE_MODEL_KEY);
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      const model = saved[name];
      return typeof model === "string" ? model.trim() || null : null;
    }
    // Compatibility with the first implementation, which stored one string.
    const legacy = this.context.workspaceState.get<string>(WORKSPACE_MODEL_KEY);
    return legacy?.trim() || null;
  }

  private async rememberWorkspaceModelFor(profileName: string, modelId: string): Promise<void> {
    if (!profileName.trim() || !modelId.trim()) return;
    const saved = this.context.workspaceState.get<Record<string, unknown>>(WORKSPACE_MODEL_KEY);
    const models = saved && typeof saved === "object" && !Array.isArray(saved) ? { ...saved } : {};
    models[profileName.trim()] = modelId.trim();
    await this.context.workspaceState.update(WORKSPACE_MODEL_KEY, models);
  }

  private async rememberWorkspaceModel(modelId: string): Promise<void> {
    const profileName = this.context.workspaceState.get<string>(WORKSPACE_PROFILE_KEY)?.trim();
    if (profileName) await this.rememberWorkspaceModelFor(profileName, modelId);
  }

  private async deleteProfile(name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    const profiles = await loadProfiles(this.context.secrets);
    const inSecrets = Object.hasOwn(profiles, trimmed);
    const inKernel = Object.hasOwn(readKernelApiProfiles(), trimmed);
    if (!inSecrets && !inKernel) {
      this.postToWebview({ type: "profileDeleteResult", name: trimmed, ok: false });
      return;
    }
    let kernelWriteFailed = false;
    if (inSecrets) {
      delete profiles[trimmed];
      await saveProfiles(this.context.secrets, profiles);
    }
    if (inKernel) {
      const deleted = deleteKernelApiProfile(trimmed);
      if (!deleted) {
        kernelWriteFailed = true;
        // In-panel receipt: the profile is still in the kernel file, so the
        // row stays listed and the user must learn why (the old
        // showWarningMessage landed outside the panel's notification stack).
        this.store.sendToast("warning", vscode.l10n.t("无法写入内核配置 {0}", trimmed));
      }
    }
    // Drop the kernel's active pointer when it names the deleted row so the
    // next handshake cannot resolve a profile that no longer exists.
    if (readCliSettings()?.currentApiProfile?.trim() === trimmed) {
      setKernelActiveProfile(null);
    }
    // Drop this workspace's memory of the deleted profile so the next
    // handshake doesn't resolve a stale name (falls back to the global slot).
    if (this.context.workspaceState.get<string>(WORKSPACE_PROFILE_KEY)?.trim() === trimmed) {
      await this.context.workspaceState.update(WORKSPACE_PROFILE_KEY, undefined);
      this.store.setAuth(await this.buildAuthState(false, true));
      this.postToWebview({ type: "profileDeleteResult", name: trimmed, ok: !kernelWriteFailed });
      return; // this workspace's profile was deleted → choose another profile
    }
    this.store.setAuth(await this.buildAuthState(this.store.getState().auth.authenticated, false));
    this.postToWebview({ type: "profileDeleteResult", name: trimmed, ok: !kernelWriteFailed });
  }

  /** Tear down the current CLI connection and start fresh with new credentials.
   * `keepSession` (user chose 停留在当前会话 at the switch prompt): the hot
   * path reloads the SAME conversation in place via `reloadSessionUnderCreds`
   * (seamless — the transcript never clears); the cold path can only restore
   * after the process restart, routed through `restartRestoreId` like a CLI
   * restart. Both fall back to a new session when the reload fails — a
   * silently ineffective switch would be worse than a visible one. */
  private async reconnectWithCredentials(
    creds: OpenAiCompatCredentials,
    keepSession = false,
  ): Promise<void> {
    if (this.historySyncBusy) return;
    // A first connect still in flight owns the `connecting` promise —
    // ensureClient would hand it straight back, skipping the reconnect and
    // keeping the OLD credentials. Settle it (success or failure) first.
    if (this.connecting) await this.connecting.catch(() => {});
    // A3: a window close during the settle above would otherwise drive the
    // hot re-auth / restart path against a destroyed store.
    if (this.disposed) return;
    this.cancelAllApprovals(vscode.l10n.t("重新认证"));
    this.cancelAllPlanExits(vscode.l10n.t("重新认证，计划审批已跳过"));
    this.cancelAllPendingQuestions(vscode.l10n.t("重新认证，提问已跳过"));
    // 热重认证的 keepSession 路径原地重载同一个会话（不经过新会话 / 恢复），
    // 扫描缓冲与去重账本属于旧凭据下的那段对话，这里显式清空。
    this.resetSuperDirectiveScans();
    // Detach the old client FIRST: dispose() kills its child process, and the
    // resulting exit event must not be mistaken for a crashed session.
    const oldClient = this.client;
    // --- Hot re-auth fast path (bundle-verified, CLI 0.5.19) ---
    // The ACP authenticate handler updates the agent's instance-level
    // `authOptions` (via config.refreshAuth), and session/new re-applies
    // authOptions to every NEW session config — so a running CLI picks up
    // new credentials on its next session/new WITHOUT a restart. That skips
    // the whole spawn + initialize round trip (~6s under plain node, 30-60s
    // with many MCP servers). Known trade-off: the CLI keeps the old session
    // object in its sessions map (memory only; the process dies with the
    // panel anyway). Any failure falls back to the full restart below.
    if (oldClient) {
      const tHot = Date.now();
      // Session id for the hot path: the live one, or — while a restore is
      // still settling — the session the visible transcript belongs to. The
      // keepSession reload below reuses the same id: entry and reload MUST
      // agree, otherwise an edit during restore falls into the cold path and
      // kills the process that is being restored.
      const liveState = this.store.getState();
      const hotSessionId = liveState.sessionId ?? liveState.activeSessionId;
      if (hotSessionId) {
        // Stop a possibly-still-running turn (an errored turn is exactly why
        // users switch profiles; cancel is a no-op on an idle session) and
        // drop the dying session's trailing updates (onSessionUpdate consumes
        // discardedSessionIds delete-style). keepSession skips the discard:
        // the SAME session is reloaded in place, its updates stay legitimate.
        try {
          oldClient.cancel(hotSessionId);
        } catch {
          // dying client — the restart path handles it
        }
        if (!keepSession) {
          if (this.discardedSessionIds.size >= DISCARDED_SESSION_IDS_CAP) this.discardedSessionIds.clear();
          this.discardedSessionIds.add(hotSessionId);
        }
      }
      try {
        // Same OAuth-cache guard as the cold path (reversible archive).
        const archived = retireStaleOAuthCreds();
        if (archived) this.log.info(`archived stale OAuth credential cache: ${archived}`);
        const tAuth = Date.now();
        await oldClient.authenticate({
          methodId: "openai-compatible",
          methodInfo: { apiKey: creds.apiKey, baseUrl: creds.baseUrl, modelName: creds.modelName },
        });
        this.log.info(`hot re-authenticate ok in ${Date.now() - tAuth}ms (CLI kept running)`);
        // (The old re-stamp of currentApiProfile is gone: the panel writes the
        // pointer into settings.json itself, and the CLI-side
        // api-config-isolation patch keeps whatever is already on disk — which
        // is the value written here. resolveActiveProfileName is kernel-first.)
        // keepSession: reload the SAME conversation in place under the new
        // credentials — the transcript never clears (seamless). Only the
        // CLI-side session object is rebuilt (session/load, same id). The id
        // is exactly the one resolved at entry (`sessionId ?? activeSessionId`),
        // so an edit during a restore reloads the session the transcript shows.
        const keepId = keepSession ? hotSessionId : null;
        if (keepId) {
          const reloaded = await this.reloadSessionUnderCreds(keepId, creds);
          if (reloaded) {
            // Write the reloaded id back to the store — an edit during restore
            // reloaded `activeSessionId` while `sessionId` was still null.
            // Any OTHER live session that was not preserved is booked into
            // `discardedSessionIds` (same semantics as the switch path) so its
            // trailing updates cannot leak into the fresh state.
            const staleId = this.store.getState().sessionId;
            if (staleId && staleId !== keepId) {
              if (this.discardedSessionIds.size >= DISCARDED_SESSION_IDS_CAP) this.discardedSessionIds.clear();
              this.discardedSessionIds.add(staleId);
            }
            this.store.sessionMeta({ sessionId: keepId });
            this.store.setAuth(await this.buildAuthState(true, false));
            this.log.info(
              `profile switch finished in ${Date.now() - tHot}ms (hot re-auth, session reloaded in place)`,
            );
            void vscode.window.showInformationMessage(
              vscode.l10n.t(
                "已切换 API 配置: {0}，当前对话已改用新配置",
                (await this.workspaceActiveProfileName()) ?? "",
              ),
            );
            return;
          }
          // Reload failed (CLI refused the load, or the session file is
          // gone). Degrade visibly to the new-session flow below — a
          // silently ineffective switch would be worse.
          this.log.warn("keep-session reload failed, falling back to a new session");
          if (this.discardedSessionIds.size >= DISCARDED_SESSION_IDS_CAP) this.discardedSessionIds.clear();
          this.discardedSessionIds.add(keepId);
        }
        // Tail rescue BEFORE the state swap (same rationale as below).
        void this.persistActiveTranscript();
        this.store.replaceState(newSessionState(this.store.getState()));
        // The stale currentModelId belongs to the previous endpoint — keep it
        // out of restoreSession's fallback chain.
        this.store.getState().currentModelId = null;
        // startNewSession applies this (the NEW profile's model) via set_model.
        this.pendingSwitchModel = creds.modelName;
        this.store.markConnecting();
        // startNewSession reuses the same live client (ensureClient hands it
        // straight back) and runs session/new against the new credentials.
        // bypassSuperWait: 切换 Profile 必须能换会话 —— 状态已经被换掉了，
        // 「等待子会话汇报」的守卫若生效，会把面板留在没有会话的坏状态。
        await this.startNewSession({ bypassSuperWait: true });
        // Only markConnected/markError may move the status off "connecting"
        // (newSessionState deliberately preserves it) — the restart path gets
        // this from ensureClient's post-handshake, but the hot path never
        // re-enters ensureClient, so the webview would sit on its splash
        // screen (status === "connecting") forever.
        this.store.markConnected();
        this.store.setAuth(await this.buildAuthState(true, false));
        this.log.info(
          `profile switch finished in ${Date.now() - tHot}ms (hot re-auth, no CLI restart)`,
        );
        void vscode.window.showInformationMessage(
          vscode.l10n.t("已切换 API 配置: {0}", (await this.workspaceActiveProfileName()) ?? ""),
        );
        return;
      } catch (error) {
        // Fall through to the restart path; ensureClient's client-identity
        // guards already tolerate a replaced/dying client.
        this.log.warn(`hot re-auth failed, falling back to CLI restart: ${errorMessage(error)}`);
      }
    }
    this.client = null;
    // keepSession on the cold path: the process restart makes a seamless
    // reload impossible, but the conversation is restored after the
    // handshake from the transcript tail-rescued below (same mechanism as
    // restartCli — restartRestoreId outranks the explicitSwitch no-restore
    // rule in ensureClient's startup branch).
    if (keepSession) {
      const coldSessionId = this.store.getState().activeSessionId ?? this.store.getState().sessionId;
      if (coldSessionId) this.restartRestoreId = coldSessionId;
    }
    // Tail rescue BEFORE the state swap: the outgoing session's transcript is
    // typically mid-turn here (an errored turn is exactly why the user is
    // switching profiles), and replaceState below drops the in-memory blocks.
    // persistActiveTranscript serializes synchronously at call time, so it
    // must run before the swap; the file write itself lands on the persist
    // chain and targets the old session's file — no race with the new state.
    void this.persistActiveTranscript();
    // Splash + "连接中" chip BEFORE the teardown: the old child's kill can
    // wait up to 3s and the new CLI boot 10-60s — feedback must be immediate.
    this.store.replaceState(newSessionState(this.store.getState()));
    // The stale currentModelId belongs to the previous endpoint — keep it out
    // of restoreSession's fallback chain.
    this.store.getState().currentModelId = null;
    // Next session start defaults to the NEW profile's configured modelName
    // (user directive) and pushes it to the CLI via set_model.
    this.pendingSwitchModel = creds.modelName;
    this.store.markConnecting();
    // Remember for the next handshake (ensureClient reads these).
    this.pendingHandshakeCredentials = creds;
    // Kill the old CLI in the background while the new one boots: the two
    // processes are independent, and a stubborn child's 3s graceful-kill
    // window must not extend the switch path. Late events from the dying
    // client are filtered by the `this.client !== client` guards in
    // ensureClient's callbacks; the finally below still waits for the kill,
    // so a failed reconnect never leaks the old process.
    const teardown = oldClient?.dispose().catch(() => {}) ?? Promise.resolve();
    const tSwitch = Date.now();
    const coldKeeps = this.restartRestoreId !== null;
    try {
      // ensureClient's post-handshake starts a NEW session by default (the
      // abandoned session belongs to the OLD credentials) — unless this
      // switch chose keepSession, which armed restartRestoreId above so the
      // same conversation is restored instead. Either way pendingSwitchModel
      // (the NEW profile's model) is applied via set_model.
      await this.ensureClient();
      this.store.setAuth(await this.buildAuthState(true, false));
      this.log.info(`profile switch finished in ${Date.now() - tSwitch}ms (incl. parallel old-CLI teardown)`);
      void vscode.window.showInformationMessage(
        coldKeeps
          ? vscode.l10n.t(
              "已切换 API 配置: {0}，当前对话已改用新配置",
              (await this.workspaceActiveProfileName()) ?? "",
            )
          : vscode.l10n.t("已切换 API 配置: {0}", (await this.workspaceActiveProfileName()) ?? ""),
      );
    } catch {
      // ensureClient already marked the error in the store; nothing to add.
    } finally {
      await teardown;
    }
    this.store.setInitializing(false);
  }

  /**
   * Seamless keep-session profile switch (hot re-auth path): reload the
   * SAME conversation under the new credentials WITHOUT touching the
   * transcript — no replaceState, no replay, no splash; the panel never
   * blinks, only the success toast confirms.
   *
   * Why a reload is required at all: a live ACP session keeps the OLD
   * endpoint in its config after `authenticate` updates the agent-level
   * authOptions — only session/new / session/load rebuild the config from
   * the updated authOptions (bundle-verified, CLI 0.5.19). session/load with
   * the SAME id rebuilds the CLI session from its own
   * `~/.iflow/acp/sessions/<id>.json` (setHistory restores the model
   * context) and does NOT replay session/update (pitfall #4) — so the
   * panel's transcript stays exactly right as it stands.
   *
   * The window holds `historySyncBusy` (the same gate deleteUserMessage's
   * reload uses): sendPrompt / startNewSession / setModel refuse while the
   * old session object is about to be replaced. The model alignment runs
   * AFTER the gate releases — setModel refuses while it is held.
   *
   * Returns false on any failure; the caller falls back to the visible
   * new-session flow — a silently ineffective switch is the worse failure.
   */
  private async reloadSessionUnderCreds(
    sessionId: string,
    creds: OpenAiCompatCredentials,
  ): Promise<boolean> {
    const client = this.client;
    if (!client || this.disposed) return false;
    const init = client.getInitializeResult();
    if (!init?.agentCapabilities.loadSession) {
      this.log.warn("keep-session switch refused: CLI does not declare loadSession");
      return false;
    }
    const cwd =
      this.sessionCwd ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      this.context.extensionUri.fsPath;
    this.historySyncBusy = true;
    try {
      await client.loadSession({
        cwd,
        mcpServers: [],
        sessionId,
        settings: mainSessionSettings(),
      });
      if (this.disposed || this.client !== client) return false;
    } catch (error) {
      this.log.warn(`keep-session session/load failed: ${errorMessage(error)}`);
      return false;
    } finally {
      this.historySyncBusy = false;
    }
    // Model alignment to the NEW endpoint (pitfalls #23/#25): modes/commands
    // survive untouched (the CLI replays nothing on load), but the model
    // dropdown must follow the switch — default to the NEW profile's
    // configured model, validated against the live /models before pushing
    // (set_model validates nothing itself).
    const modelsPromise = this.queryLiveModels();
    const desired = this.pendingSwitchModel ?? creds.modelName;
    this.pendingSwitchModel = null;
    this.store.sessionMeta({ currentModelId: desired });
    this.applyLiveModels(modelsPromise, client, sessionId, desired);
    const pushId = await this.validateModelForPush(modelsPromise, desired, null);
    if (pushId) await this.setModel(pushId);
    this.log.info(`session ${sessionId} reloaded under the new credentials (in place)`);
    return true;
  }

  /** Credentials to push via authenticate on the next handshake, if any. */
  private pendingHandshakeCredentials: OpenAiCompatCredentials | null = null;
  /**
   * Session id the ensureClient handshake must restore after a hot CLI
   * restart (restartCli sets it BEFORE ensureClient). A restart must not
   * silently drop the conversation the user was looking at, so this overrides
   * the iflow.restoreLastSession branch for exactly one handshake; consumed
   * (cleared) by the branch itself, including on failure.
   */
  private restartRestoreId: string | null = null;
  /**
   * Sessions abandoned by a hot re-auth (profile switch). The dying session
   * may still emit trailing session_update notifications on the SAME live
   * client; onSessionUpdate drops those so they cannot leak into the fresh
   * state. Consumed delete-style on first sight.
   */
  private discardedSessionIds = new Set<string>();
  /**
   * True from the moment `startNewSession` clears the transcript until the new
   * session is established (or the attempt fails). The abandoned turn keeps
   * streaming server-side during this window, and updates WITHOUT a sessionId
   * pass both id guards in `onSessionUpdate` (the discarded set is keyed by
   * the old uuid, the cross-session guard skips empty ids) — they repopulated
   * the freshly cleared transcript (user-reported "新会话显示异常: 残留旧会话
   * 内容 + usage 归零"). The window drops everything not already addressed
   * to the store's own session; history restore is exempt because replayed
   * updates legitimately arrive while `store.sessionId` is still null.
   */
  private droppingForReset = false;
  /**
   * Set by a profile switch; consumed by the next session start (new or
   * restored). Holds the NEW profile's configured modelName — the default
   * model must be the one written in the profile (user directive), not the
   * CLI's stale current model from the previous endpoint.
   */
  private pendingSwitchModel: string | null = null;

  /** Replay-title extraction state for the session currently being loaded. */
  private replayTitle: string | null = null;
  /** True while a `session/load` restore is in flight. */
  private restoring = false;
  /**
   * True while deleteUserMessage rewrites the CLI's session-state file and
   * reloads the session (`session/load`). The reload replaces the CLI's
   * session object, so a prompt that slips into this window would run on the
   * about-to-be-retired one — and its `finally { saveSessionState() }` would
   * overwrite the freshly truncated file with the OLD untruncated history.
   * sendPrompt / startNewSession refuse while it is set.
   */
  private historySyncBusy = false;
  /**
   * The session being restored. During the restore window, replayed updates
   * arrive tagged with THIS id — an abandoned turn still streaming on a
   * FOREIGN session must not ride the restoring exemption into the restored
   * transcript (the replay itself repopulates the cleared state, so a leak
   * here reads as "restored session shows another conversation's content").
   */
  private restoringSessionId: string | null = null;
  /**
   * Abort request for the in-flight restore: set when the user asks for a
   * 新会话 while the history is still being restored. The restore checks it
   * at every checkpoint (after each await) and, when it fires, abandons the
   * restore WITHOUT writing anything to the store — the 新会话 flow takes
   * over from there.
   */
  private restoreAbort = false;
  /**
   * The 新会话 intent recorded while a restore was in flight. The restore
   * may be too far along to abort (it already wrote to the store), so the
   * intent is honored as soon as the restore settles — the user never has
   * to click 新会话 twice.
   */
  private pendingNewSession = false;
  /**
   * Settle handle of the in-flight restore: resolves with the restore's
   * outcome ("aborted" | "completed" | "failed") when the restore is done.
   * Non-null exactly while a restore is in flight (created right after
   * `restoring` is set, resolved in the restore's finally).
   */
  private restoreSettle: { promise: Promise<RestoreOutcome>; resolve: (o: RestoreOutcome) => void } | null = null;
  /** Outcome of the last restore attempt (read when the settle fires). */
  private lastRestoreOutcome: RestoreOutcome = "completed";
  /**
   * The in-flight 新会话 flow. Concurrent requests share ONE run: the click
   * that interrupts a restore and the restore's own fallback both funnel
   * here, so a second `session/new` is never issued (and the destructive
   * side effects — cleanupEmptySession / cancelAllApprovals /
   * persistActiveTranscript — run exactly once).
   */
  private newSessionRun: Promise<void> | null = null;
  /**
   * Sessions whose restore was abandoned. Late `session/update` traffic for
   * them (the CLI's replay of the history we gave up on) must never reach
   * the store — it would repopulate the fresh transcript. Entries are
   * removed again when the same session is restored for real, so a later
   * legitimate restore is not poisoned.
   */
  private abandonedRestoreSessionIds = new Set<string>();

  private onSessionUpdate(n: Parameters<SessionStore["onSessionUpdate"]>[0]): void {
    // An abandoned restore (the user asked for a 新会话 while the history was
    // being restored): the CLI may still replay the history we gave up on —
    // those updates belong to the abandoned session and must never reach the
    // store (they would repopulate the fresh transcript). The id is removed
    // from the set again when the same session is restored for real.
    if (n.sessionId && this.abandonedRestoreSessionIds.has(n.sessionId)) return;
    // Hot re-auth (profile switch) abandons the old session on the SAME live
    // client — drop its trailing updates so they can't leak into the fresh
    // state. delete-style: the entry is consumed on first sight.
    if (this.discardedSessionIds.delete(n.sessionId)) return;
    // Everything else is the pure guard chain (shared/session-state.ts
    // dropSessionUpdate): reset-window drops (incl. sessionId-less updates,
    // which slipped through the earlier id-only guards — user-reported leak
    // twice), cross-session drops, and unattributable drops during restore
    // setup / idle sessions. Restore is exempt (replayed updates arrive with
    // `restoring` set and a foreign/null sessionId by design).
    const s = this.store.getState();
    if (
      dropSessionUpdate({
        sessionId: n.sessionId ?? null,
        storeSessionId: s.sessionId,
        status: s.status,
        restoring: this.restoring,
        resetting: this.droppingForReset,
        restoringSessionId: this.restoringSessionId,
        // SubAgent adapter events carry agentId on the update and a sentinel
        // sessionId ("default-session", CLI 0.5.19 bundle) — the guard needs
        // the marker to exempt them from the cross-session drop.
        agentId: (n.update as { agentId?: string }).agentId,
      })
    ) {
      return;
    }
    // During restore, the first user turn names the session in the switcher.
    if (this.restoring && this.replayTitle === null && n.update.sessionUpdate === "user_message_chunk") {
      if (n.update.content.type === "text" && n.update.content.text.trim()) {
        this.replayTitle = n.update.content.text.trim().slice(0, 60);
      }
    }
    this.store.onSessionUpdate(n, { replaying: this.restoring });
    // Super Agent: watch the MAIN agent's own text for delegation
    // directives. Nested SubAgent events carry an `agentId` (the CLI's own
    // `task` tool) and are skipped — v1 supports one level of children only.
    if (
      !this.restoring &&
      n.update.sessionUpdate === "agent_message_chunk" &&
      !(n.update as { agentId?: string }).agentId
    ) {
      this.scanSuperDirectives(n.update.content);
      this.scanSuperActions(n.update.content);
    }
    // 结构化工具调用兜底：模型有时把派发 / 管理写成 `super-agent` /
    // `super-agent-actions` 工具调用（内核 registry 里没有这两个工具），
    // 旧实现既不执行也不提示，用户以为已经派了。这里从 args 取载荷，按
    // 同一套协议执行。只认主会话自己的工具帧（带 agentId 的 SubAgent 事件
    // 跳过），且只看「即将执行」的两帧 —— completed / failed 帧重放同一份
    // 载荷没有意义。
    if (
      !this.restoring &&
      (n.update.sessionUpdate === "tool_call" || n.update.sessionUpdate === "tool_call_update") &&
      !(n.update as { agentId?: string }).agentId &&
      (n.update.status === "pending" || n.update.status === "in_progress")
    ) {
      this.handleSuperToolCall(n.update);
    }
    // 思考通道（`agent_thought_chunk`）只进转录：思考里写出的委派围栏不是
    // 指令，不派发任务、不执行动作，也不因写坏的载荷弹「无法解析」提示。
    // 模型边想边写出同一份载荷时，只有正文里的那一份会被上面的扫描消费。
    // Empty-response detection: any visible agent output during the live turn
    // disqualifies it from the "gateway answered empty" retry. Replay updates
    // (session/load) are excluded — they belong to a past turn.
    // Visible output ALSO proves the follow-up model request after a timeout
    // auto-rejection is alive — disarm the post-rejection watchdog (tool
    // status events alone do not: the CLI can emit a lone tool_call_update
    // for the rejected tool and then wedge on the next model request).
    if (!this.restoring && isAgentOutputUpdate(n.update)) {
      this.turnHadAgentOutput = true;
      this.clearPostRejectionWatchdog();
    }
    // Edit-tool diff synthesis for tools the wire gives no structured diff to
    // (all MCP tools — CLI 0.5.19 flattens MCP results to plain text). Two
    // strategies, in priority order (see `maybeSynthesizeToolDiff`):
    // 1. Pre/post disk snapshot: capture the args' file content NOW, while
    //    `in_progress` is emitted immediately before `execute` in the CLI
    //    bundle, then compare after completion. Tool-agnostic — works for any
    //    editor regardless of name or arg shape.
    // 2. Arg reversal fallback (restored/late sessions with no snapshot):
    //    rebuild oldText by reversing recognized replacement args on the
    //    post-edit file.
    // Replay (session/load) is skipped — those transcripts are rebuilt from
    // files, not from live events.
    if (!this.restoring && (n.update.sessionUpdate === "tool_call" || n.update.sessionUpdate === "tool_call_update")) {
      const update = n.update;
      if (update.toolCallId) {
        if (update.status === "in_progress" && update.args !== undefined) {
          this.capturePreEditSnapshot(update.toolCallId, update.args);
        }
        // Strategy-2 input: keep only the PARSED edit args (raw args may carry a
        // whole-file `content` payload — never let that linger in memory).
        if (update.args !== undefined && !this.toolArgs.has(update.toolCallId)) {
          const parsed = parseEditArgs(update.args);
          if (parsed) {
            if (this.toolArgs.size >= ChatPanel.TOOL_ARGS_CAP) {
              const oldest = this.toolArgs.keys().next().value;
              if (oldest !== undefined) this.toolArgs.delete(oldest);
            }
            this.toolArgs.set(update.toolCallId, parsed);
          }
        }
        if (update.status === "completed") {
          void this.maybeSynthesizeToolDiff(update.toolCallId);
        } else if (update.status === "failed") {
          // A failed tool produces no diff — drop its caches so a whole run of
          // failures can't pin snapshots until cap eviction.
          this.preSnapshots.delete(update.toolCallId);
          this.toolArgs.delete(update.toolCallId);
        }
      }
    }
  }

  /**
   * Binary detection via a NUL byte in the first 1KB (same heuristic as the
   * CLI-locator's shim probe, pitfall #7). utf8 round-trips are LOSSY for
   * binary content (invalid sequences → U+FFFD), so a synthesized diff's
   * oldText would be corrupted — reverting would write the corruption back.
   * Binary files are therefore never snapshotted or diffed.
   */
  private static isBinary(buf: Buffer): boolean {
    return buf.subarray(0, 1024).includes(0);
  }

  /** Drop all transient per-tool-call caches (session switch / restore / hot
   * re-auth): a stale snapshot from the previous session must never be
   * compared against a same-id tool call in the new one. */
  private clearToolCaches(): void {
    this.preSnapshots.clear();
    this.toolArgs.clear();
  }

  /**
   * Snapshot the target file's disk content before the tool runs. Runs
   * synchronously on purpose: the CLI starts executing the tool the moment it
   * finishes emitting this update, so an async read could race the write and
   * capture post-edit content (silently losing the diff). Bounded by
   * MAX_SYNTH_DIFF_CHARS via stat; unreadable/large/binary paths record
   * nothing.
   */
  private capturePreEditSnapshot(toolCallId: string, args: unknown): void {
    if (this.preSnapshots.has(toolCallId)) return;
    const rawPath = parseToolFilePath(args);
    if (!rawPath) return;
    const abs = this.resolveAgentPathToAbsolute(rawPath);
    try {
      const stat = statSync(abs);
      if (!stat.isFile() || stat.size > MAX_SYNTH_DIFF_CHARS) return;
      const buf = readFileSync(abs);
      if (ChatPanel.isBinary(buf)) return;
      this.preSnapshots.set(toolCallId, { path: abs, content: buf.toString("utf8") });
    } catch (error) {
      // ENOENT is meaningful (a creation is coming). Any other error (EPERM,
      // unreadable dir…) records nothing — a failed read must never masquerade
      // as "file will be created" and fabricate an all-additions diff.
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.preSnapshots.set(toolCallId, { path: abs, content: null });
      }
    }
    if (this.preSnapshots.size > ChatPanel.TOOL_ARGS_CAP) {
      const oldest = this.preSnapshots.keys().next().value;
      if (oldest !== undefined) this.preSnapshots.delete(oldest);
    }
  }

  // --- Session persistence (M4) --------------------------------------------------

  private readPersistedSessions(): SessionSummaryUi[] {
    return this.context.workspaceState.get<SessionSummaryUi[]>(SESSIONS_KEY, []);
  }

  private async persistSessions(sessions: SessionSummaryUi[], activeId: string | null): Promise<void> {
    // M4 P1-8: canonical order (pinned first, newest activity) on EVERY
    // persist — stored index and rendered list can never drift. The cap
    // drops from the tail, which after sorting means oldest non-pinned
    // first (archived sessions are old by nature, so they leave first).
    const sorted = sortSessionSummaries(sessions);
    await this.context.workspaceState.update(SESSIONS_KEY, sorted.slice(0, MAX_RECENT_SESSIONS));
    await this.context.workspaceState.update(ACTIVE_SESSION_KEY, activeId);
  }

  /** Upsert a session into the recent list (newest first) and persist it.
   * `updatedAt` is the session's last-activity time: re-recording an existing
   * session (restore/switch, label rename) keeps its prior stamp — only
   * touchActiveSession() (a real turn ending) moves it. New entries stamp
   * now (creation time). */
  private async recordSession(id: string, label: string | null): Promise<void> {
    if (!id) return;
    const existing = this.readPersistedSessions();
    // clamp: legacy persisted entries may carry uncapped labels.
    const capped = label ? clampSessionLabel(label) : null;
    const prior = existing.find((s) => s.id === id);
    const sessions = [
      {
        id,
        label: capped ?? prior?.label ?? DEFAULT_SESSION_LABEL,
        // Restoring/switching is not activity — keep the last-end stamp.
        updatedAt: prior?.updatedAt ?? Date.now(),
        // M4 P1-8: a pin is deliberate and survives a restore; archived does
        // not — using the session again means it is active again.
        ...(prior?.pinned ? { pinned: true } : {}),
      },
      ...existing.filter((s) => s.id !== id),
    ];
    this.store.setSessions(sessions, id);
    await this.persistSessions(sessions, id);
  }

  /**
   * Stamp the active session with "now" — called when a turn ENDS (success
   * or failure), so the switcher shows when the session was last used
   * instead of a time bumped by mere switching or restoring.
   */
  private async touchActiveSession(): Promise<void> {
    const state = this.store.getState();
    const id = state.activeSessionId ?? state.sessionId;
    if (!id) return;
    const sessions = state.sessions.map((s) =>
      s.id === id ? { ...s, updatedAt: Date.now() } : s,
    );
    this.store.setSessions(sessions, id);
    await this.persistSessions(sessions, id);
  }

  /** Forgetter: drop one session from the persisted list (e.g. load failed). */
  private async forgetSession(id: string): Promise<void> {
    const sessions = this.readPersistedSessions().filter((s) => s.id !== id);
    const activeId = sessions[0]?.id ?? null;
    this.store.setSessions(sessions, activeId);
    await this.persistSessions(sessions, activeId);
    // The session is gone — its title-ledger entry must go with it, otherwise
    // the set keeps one string per deleted session forever (unbounded growth
    // over a long-lived panel), and a session id that ever came back would
    // silently lose its AI title.
    this.titledSessionIds.delete(id);
  }

  /** M4 P1-8: toggle pinned / archived on a persisted session (switcher
   * buttons). False flags delete the property — the index stays clean and
   * legacy readers (which never set these) see exactly what they expect. */
  private setSessionFlags(sessionId: string, pinned: boolean, archived: boolean): void {
    const state = this.store.getState();
    const target = state.sessions.find((s) => s.id === sessionId);
    if (!target) return;
    const sessions = state.sessions.map((s) => {
      if (s.id !== sessionId) return s;
      const next: SessionSummaryUi = { ...s };
      if (pinned) next.pinned = true;
      else delete next.pinned;
      if (archived) next.archived = true;
      else delete next.archived;
      return next;
    });
    this.store.setSessions(sessions, state.activeSessionId);
    void this.persistSessions(sessions, state.activeSessionId ?? state.sessionId);
  }

  /**
   * Rename a session from the switcher. The label lives in the persisted index
   * AND in the extension transcript; restoreSession re-derives the label from
   * the transcript, so updating only the index would silently revert the
   * rename on the next restore.
   */
  private async renameSession(sessionId: string, label: string): Promise<void> {
    const state = this.store.getState();
    const renamed = renameSessionSummary(state.sessions, sessionId, label);
    if (renamed === state.sessions) return;
    const sessions = [...renamed];
    this.store.setSessions(sessions, state.activeSessionId);
    await this.persistSessions(sessions, state.activeSessionId ?? state.sessionId);
    const nextLabel = sessions.find((s) => s.id === sessionId)?.label;
    if (!nextLabel) return;
    // Active session: force a transcript write so its stored label matches.
    const liveId = state.activeSessionId ?? state.sessionId;
    if (sessionId === liveId && state.blocks.length > 0) {
      void this.persistActiveTranscript(true);
      return;
    }
    // Inactive session: rewrite that transcript's label in place.
    const transcript = await this.readTranscript(sessionId);
    if (transcript) {
      await this.enqueueTranscriptWrite(sessionId, () => this.serializeTranscript(nextLabel, transcript.blocks));
    }
  }

  /**
   * Forget a session that never carried content: no in-memory blocks, no
   * extension transcript file, no CLI jsonl. startNewSession records every
   * fresh session up front (switcher highlighting), so one abandoned by
   * 新会话 / a profile switch / a session switch would otherwise strand an
   * unrestorable "(无标题会话)" husk in the list until the next reconnect.
   */
  private async cleanupEmptySession(id: string | null | undefined): Promise<void> {
    if (!id) return;
    // Settle the persist chain first: a profile switch tail-rescues the
    // outgoing transcript as a fire-and-forget enqueued write BEFORE the
    // state swap clears the blocks — an existsSync check here would race
    // that write and misread a real session as empty.
    await this.persistChain.catch(() => {});
    const state = this.store.getState();
    const liveId = state.activeSessionId ?? state.sessionId;
    // The live session with blocks on screen is never "empty" — its
    // transcript just hasn't been seeded yet (first turn in flight).
    if (id === liveId && state.blocks.length > 0) return;
    if (this.hasPersistedTranscript(id)) return;
    this.log.info(`forgetting empty session: ${id}`);
    await this.forgetSession(id);
  }

  /** User-invoked delete from the session switcher: forget + drop transcript. */
  private async deleteSession(sessionId: string): Promise<void> {
    if (this.disposed || this.historySyncBusy) return;
    const lockState = this.store.getState();
    const lockClient = this.client;
    this.historySyncBusy = true;
    this.store.setInitializing(true, "deleteSession");
    // Only the ACTIVE session's pending cards belong to what is being deleted.
    // Cancelling them unconditionally (all sessions) silently rejected a live
    // approval while the user deleted an unrelated session from the switcher.
    const activeId = lockState.activeSessionId ?? lockState.sessionId;
    if (sessionId === activeId) {
      this.cancelAllApprovals(vscode.l10n.t("会话已删除"));
      this.cancelAllPlanExits(vscode.l10n.t("会话已删除，计划审批已跳过"));
      this.cancelAllPendingQuestions(vscode.l10n.t("会话已删除，提问已跳过"));
    }
    try {
      await this.forgetSession(sessionId);
      await this.clearTranscript(sessionId);
      // The child-session archive is this session's too: keeping it would
      // resurrect the deleted session's children (and their branches) the
      // next time anyone restores anything.
      await deleteSuperSessionArchive(this.superStoreDir(), sessionId);
      // M3 P0-1: drop the session's shadow repo + checkpoint index too.
      await this.removeCheckpointsForSession(sessionId);
      // A7: drop the session's staged-attachment dir too — the transcript that
      // referenced those paths is gone, so the temp copies are pure residue.
      await rm(attachmentSessionDir(sessionId), { recursive: true, force: true }).catch((error) => {
        this.log.warn(`removing attachment dir failed: ${errorMessage(error)}`);
      });
    } finally {
      this.historySyncBusy = false;
      if (!this.disposed && this.store.getState() === lockState && this.client === lockClient) {
        this.store.setInitializing(false);
      }
    }
  }

  /**
   * Restore a persisted session via `session/load`. Wire behavior (CLI
   * 0.5.19): load succeeds (sessionId + modes returned) but the CLI does NOT
   * replay history through `session/update` — the transcript is rebuilt from
   * the CLI's own session file instead.
   */
  private async restoreSession(sessionId: string): Promise<boolean> {
    if (this.historySyncBusy) return false;
    // A3: the panel was disposed — the store is gone.
    if (this.disposed) return false;
    // Fast path: the CLI only persists jsonl transcripts for sessions that
    // actually had a conversation. A "dead" session (auto-created on panel
    // open, never used) would burn 60s+ on new+load for nothing.
    this.sessionCwd =
      this.services.workspaceRoot ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      this.context.extensionUri.fsPath;
    if (!this.hasPersistedTranscript(sessionId)) {
      // Dead switcher entry (recorded but never used): clicking it would
      // fail on every attempt and the husk would sit in the list forever —
      // forget it instead. Clicking the LIVE active session (no transcript
      // until its first prompt lands) stays a plain no-op.
      const liveId = this.store.getState().activeSessionId ?? this.store.getState().sessionId;
      if (sessionId !== liveId) {
        this.log.warn(`forget dead entry: no persisted transcript for ${sessionId}`);
        await this.forgetSession(sessionId);
      } else {
        this.log.warn(`skip restore: no persisted transcript for ${sessionId}`);
      }
      return false;
    }

    const client = await this.ensureClient();
    // A3: a dispose during the handshake rejects ensureClient with
    // DisposedError; a dispose AFTER it must not write into the destroyed
    // store either.
    if (this.disposed) return false;
    const workspaceRoot = this.sessionCwd;
    const init = client.getInitializeResult();
    if (init && !init.agentCapabilities.loadSession) {
      this.log.warn("loadSession capability not declared by CLI");
      void vscode.window.showWarningMessage(
        vscode.l10n.t("当前内核不支持恢复历史会话"),
      );
      return false;
    }

    // Mutual exclusion: a 新会话 is in flight (initializing) — its
    // session/new can take 30-60s with MCP servers, and running a restore
    // CONCURRENTLY let the replayed updates repopulate the transcript the
    // reset just cleared (user-reported: old content + "正在创建新会话…" +
    // empty-state all on screen). Refuse until the reset settles; the user
    // can retry the restore once the switcher unlocks.
    if (this.store.getState().initializing || this.droppingForReset) {
      this.log.warn(`restore ${sessionId} refused: a new-session switch is in flight`);
      void vscode.window.showWarningMessage(
        vscode.l10n.t("正在创建新会话，请稍后再恢复历史会话"),
      );
      return false;
    }
    if (this.restoring) return false; // a restore is already in flight

    // Race the /models HTTP query with the probe + loadSession below (it only
    // reads the endpoint from settings.json — independent of the session).
    const modelsPromise = this.queryLiveModels();
    // An abandoned restore never calls applyLiveModels — keep the rejection
    // handled so the query cannot become an unhandled rejection.
    modelsPromise.catch(() => {});
    // Capture before the state swap: if the switch succeeds, an abandoned
    // empty active session must not linger in the switcher.
    const outgoingId = this.store.getState().activeSessionId ?? this.store.getState().sessionId;
    const tRestore = Date.now();
    this.log.info(`restoring session ${sessionId} …`);
    this.restoring = true;
    this.restoringSessionId = sessionId;
    this.replayTitle = null;
    this.sessionCwd = workspaceRoot;
    // A fresh attempt: neither an abort request nor a queued 新会话 intent
    // may survive from an earlier restore.
    this.restoreAbort = false;
    this.pendingNewSession = false;
    this.lastRestoreOutcome = "completed";
    // Settle handle — a 新会话 requested while the restore runs waits on it
    // and may ask the restore to abort through `restoreAbort`.
    const settle = deferred<RestoreOutcome>();
    this.restoreSettle = settle;
    // This session is being restored FOR REAL: drop the abandoned marker a
    // previous aborted attempt may have left, otherwise its replayed updates
    // would be swallowed by the late-traffic guard.
    this.abandonedRestoreSessionIds.delete(sessionId);
    const fresh = newSessionState(this.store.getState());
    beginReplay(fresh);
    fresh.activeSessionId = sessionId;
    this.store.replaceState(fresh);
    // 看板跟着主会话走：切到 B 就不能还显示着 A 的历史子会话。
    this.publishSuperSessions();
    // 委派扫描状态也换人：上一个会话的助手文本（以及里面没收口的围栏）、
    // 已派发载荷的账本都跟新会话无关 —— 留着会让新会话的扫描基线落在别人的
    // 文本上，还会把本该重新派发的指令误判成重复。
    this.resetSuperDirectiveScans();
    try {
      // CLI 0.5.19 wire behavior: an empty/short session's loadSession response
      // carries ONLY {sessionId} — no modes, no _meta. A prior session/new does
      // return the full meta, so fetch it first (also warms up the CLI).
      // R4: the probe session itself is deliberately discarded — only its
      // meta/modes are used. The CLI owns that session's lifecycle (ACP-mode
      // sessions are not persisted and die with the CLI process); this is not
      // a leak.
      //
      // Concurrency (probed 2026-11-12 against the vendored CLI,
      // test/fixtures/probe-restore-concurrency.mjs): running the probe
      // `session/new` and the `session/load` CONCURRENTLY on one client is
      // SAFE (both resolve, the loaded session keeps its id, a later load
      // still works, the loaded session still answers a prompt — no
      // crosstalk), but it is NOT meaningfully faster: serial 1541ms/1750ms
      // vs concurrent 1489ms/1574ms — the CLI does the heavy work serially
      // internally, only ~50ms of the ~1.5s overlap. The serial order stays:
      // no measurable win, and the probe's meta/modes ordering stays obvious.
      this.contextReportBaseline = Date.now();
      const tProbe = Date.now();
      const probe = await client.newSession({
        cwd: workspaceRoot,
        mcpServers: [],
        settings: mainSessionSettings(),
      });
      this.log.info(`restore: probe session/new ok in ${Date.now() - tProbe}ms`);
      // Abort checkpoint 1 — nothing has been written to the store yet.
      if (this.abortRestoreIfRequested(sessionId, outgoingId)) return false;
      const probeMeta: NewSessionMeta | undefined = probe._meta;
      const tLoad = Date.now();
      const session = await client.loadSession({
        cwd: workspaceRoot,
        mcpServers: [],
        sessionId,
        settings: mainSessionSettings(),
      });
      this.log.info(`restore: session/load ok in ${Date.now() - tLoad}ms`);
      // Abort checkpoint 2 — still nothing written to the store.
      if (this.abortRestoreIfRequested(sessionId, outgoingId)) return false;
      const meta: NewSessionMeta | undefined = probeMeta ?? session._meta;
      const modes = session.modes ?? probe.modes;
      endReplay(this.store.getState());

      // Rebuild the transcript from the CLI's session file (NDJSON).
      const loadedId = session.sessionId;
      const tTranscript = Date.now();
      const restored = await this.loadPersistedTranscript(loadedId);
      this.log.info(`restore: transcript loaded in ${Date.now() - tTranscript}ms (${restored.blocks.length} blocks)`);
      // Abort checkpoint 3 — the transcript is rebuilt but not yet written.
      if (this.abortRestoreIfRequested(sessionId, outgoingId)) return false;
      if (restored.blocks.length === 0) {
        restored.blocks.push({
          kind: "text",
          text: vscode.l10n.t("已恢复会话。内核没有保存这条会话的历史记录，所以这里看不到之前的消息，但可以继续对话。"),
        });
      }
      // Structural isolation (user directive): a restored transcript carries
      // ids minted by PREVIOUS host lifetimes this process can never know —
      // entering the live array with them collided with fresh minting (404
      // duplicate ids measured). Re-mint every id from THIS host's counter so
      // a restored session shares NOTHING with the live namespace; the
      // original ids stay untouched in the persisted file (lossless).
      // backfillBlockIds (inside loadPersistedTranscript) already seeded the
      // counter past the originals, so the re-mints are collision-free.
      // M3 P0-1 phase 1: the persisted checkpoint index anchors to the
      // ORIGINAL ids (the transcript file is lossless), so read it + reopen
      // the shadow repo BEFORE the re-mint happens.
      const tCheckpoint = Date.now();
      await this.loadCheckpointIndex(loadedId);
      this.log.info(`restore: checkpoint index loaded in ${Date.now() - tCheckpoint}ms`);
      // Abort checkpoint 4 — the LAST await before the first store write
      // (sessionStarted / replaceTranscript). Beyond this point the restore
      // has already committed to the store and can no longer be abandoned;
      // a 新会话 request waits for it to settle instead.
      if (this.abortRestoreIfRequested(sessionId, outgoingId)) return false;
      const preRemintUserIds = restored.blocks
        .filter((b) => b.kind === "user" && b.id)
        .map((b) => b.id as string);
      reassignBlockIds(restored.blocks);
      this.store.replaceTranscript(restored.blocks);
      // M3 P0-1 phase 2: the re-mint changed every user id in place (same
      // order, same array) — re-anchor the loaded index to the live ids.
      const postRemintUserIds = restored.blocks
        .filter((b) => b.kind === "user" && b.id)
        .map((b) => b.id as string);
      if (preRemintUserIds.length === postRemintUserIds.length) {
        const remap = new Map<string, string>();
        for (let i = 0; i < preRemintUserIds.length; i++) {
          const from = preRemintUserIds[i];
          const to = postRemintUserIds[i];
          if (from && to) remap.set(from, to);
        }
        this.finalizeCheckpointIndex(remap);
      }

      // Model list: same live-endpoint-only source as a fresh session,
      // otherwise the model dropdown would vanish after a restore. Fetched
      // concurrently with probe/loadSession above and late-pushed via
      // applyLiveModels AFTER sessionStarted — a slow endpoint must not stall
      // the already-rebuilt transcript (it paints above before models land).
      // After a profile switch the default model is the one written in the
      // NEW profile (its configured modelName), not the previous endpoint's
      // stale current model (user directive).
      const switchModel = this.pendingSwitchModel;
      this.pendingSwitchModel = null;
      const currentModelId =
        switchModel ??
        this.store.getState().currentModelId ??
        this.workspaceModelId() ??
        meta?.models?.currentModelId ??
        null;

      this.store.sessionStarted({
        sessionId: loadedId,
        modes,
        commands: meta?.availableCommands ?? [],
        skills: meta?.availableSkills ?? [],
        currentModelId,
      });
      this.applyLiveModels(modelsPromise, client, loadedId, meta?.models?.currentModelId ?? null);
      // Same wire behavior as startNewSession (probed against CLI 0.5.19
      // bundle): session/new reports the CLI's BOOT-time model because
      // set_model never writes back to Config.model, while the shared
      // contentGeneratorConfig still carries the last dropdown switch.
      // Re-push whenever the panel's selection differs — after validating
      // the selection is still offered by the live endpoint.
      const restoreCliModelId = meta?.models?.currentModelId ?? null;
      const tModel = Date.now();
      if (currentModelId && currentModelId !== restoreCliModelId) {
        const pushId = await this.validateModelForPush(modelsPromise, currentModelId, restoreCliModelId);
        if (pushId) await this.setModel(pushId);
      }
      await this.applyThinkLevel(client, loadedId, this.store.getState().thinkLevel);
      this.log.info(`restore: model push done in ${Date.now() - tModel}ms`);
      this.log.info(
        `session restored: ${loadedId} (${restored.blocks.length} blocks) in ${Date.now() - tRestore}ms total`,
      );
      await this.cleanupEmptySession(outgoingId);
      await this.recordSession(loadedId, restored.firstUserText ? clampSessionLabel(restored.firstUserText) : null);
      void this.persistActiveTranscript(true); // seed the extension-owned copy
      // 该主会话当年派发的子会话（重启后进程已亡，但分支与工作目录还在）：
      // 把它们取回看板，用户才知道有哪些分支等着合并或清理。
      await this.restoreSuperSessions(loadedId);
      void vscode.window.showInformationMessage(vscode.l10n.t("已恢复会话"));
      return true;
    } catch (error) {
      const message = errorMessage(error);
      endReplay(this.store.getState());
      this.log.error(`session restore failed: ${message} (after ${Date.now() - tRestore}ms)`);
      this.store.markError(vscode.l10n.t("会话恢复失败：{0}", message));
      // Async failure — the user is likely in the editor; cue it.
      this.postSound("error");
      // Do NOT forget the session here: the transcript file still exists and
      // the failure is often transient (CLI boot hiccup, endpoint down, auth
      // not ready). Forgetting would drop it from the switcher, and the next
      // pruneUnrestorableSessions would delete the orphaned transcript file —
      // turning a retryable failure into irreversible content loss. The user
      // can still remove it explicitly via the switcher's delete.
      this.lastRestoreOutcome = "failed";
      return false;
    } finally {
      this.restoring = false;
      this.restoringSessionId = null;
      this.replayTitle = null;
      // Release everyone waiting on this restore (a 新会话 request that
      // interrupted it) with the truthful outcome.
      const settleHandle = this.restoreSettle;
      this.restoreSettle = null;
      settleHandle?.resolve(this.lastRestoreOutcome);
    }
  }

  /**
   * Abort checkpoint of an in-flight restore.
   *
   * True → the restore was abandoned: the user asked for a 新会话 while the
   * history was still being restored. Every store write of a restore happens
   * AFTER the last checkpoint, so abandoning here leaves the store untouched:
   * no sessionStarted, no replaceTranscript, no applyLiveModels, no
   * restoreSuperSessions, no "已恢复会话" toast. The state is reset to a
   * clean idle (the replay marker must not survive) and the abandoned
   * session id is remembered so its late traffic cannot leak into the fresh
   * session.
   *
   * False → no abort was requested: the restore continues.
   */
  private abortRestoreIfRequested(sessionId: string, outgoingId: string | null): boolean {
    if (!this.restoreAbort) return false;
    // Both flags are set together by the 新会话 flow: the abort REQUEST and
    // the queued INTENT. The restore only gives up when the intent is really
    // there — otherwise the request was stale.
    if (!this.pendingNewSession) return false;
    this.restoreAbort = false;
    this.lastRestoreOutcome = "aborted";
    // The replayed history of the abandoned session must never reach the
    // store again — even the tail that arrives after the abort.
    this.abandonedRestoreSessionIds.add(sessionId);
    while (this.abandonedRestoreSessionIds.size > ABANDONED_RESTORE_IDS_CAP) {
      const oldest = this.abandonedRestoreSessionIds.values().next().value;
      if (oldest === undefined) break;
      this.abandonedRestoreSessionIds.delete(oldest);
    }
    // Clean idle: the replay marker (status "streaming" + replaying) must not
    // survive the abandoned restore, and the switcher must point back at the
    // session we came from (the 新会话 flow cleans THAT one up).
    const state = this.store.getState();
    endReplay(state);
    state.sessionId = null;
    state.activeSessionId = outgoingId;
    this.store.setInitializing(false);
    this.store.replaceState(state);
    this.log.warn(`session restore of ${sessionId} abandoned: the user asked for a 新会话`);
    return true;
  }

  /**
   * Locate the CLI's NDJSON transcript file for a session id. The CLI stores
   * one file per project dir: `~/.iflow/projects/<cwd-as-slug>/session-<id>.jsonl`.
   */
  private cliTranscriptFilePath(sessionId: string): string | null {
    const fileBase = sessionId.startsWith("session-") ? sessionId : `session-${sessionId}`;
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const base = path.join(home, ".iflow", "projects");
    const cwdSlug = (this.sessionCwd ?? "").replace(/[^A-Za-z0-9-]/g, "-");
    if (cwdSlug) {
      const candidate = path.join(base, cwdSlug, `${fileBase}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
    // Fallback: session ids are globally unique — scan every project dir.
    try {
      for (const dir of readdirSync(base)) {
        const candidate = path.join(base, dir, `${fileBase}.jsonl`);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // projects dir missing
    }
    return null;
  }

  private async loadPersistedTranscript(sessionId: string): Promise<{ blocks: SessionState["blocks"]; firstUserText: string | null }> {
    // Source 1: the extension's own persisted copy (ACP mode writes no files).
    const own = await this.readTranscript(sessionId);
    if (own) {
      // P4: files written before block ids existed lack stable keys.
      backfillBlockIds(own.blocks);
      this.log.info(`transcript source: extension store (${own.blocks.length} blocks)`);
      return { blocks: own.blocks, firstUserText: own.label !== DEFAULT_SESSION_LABEL ? own.label : null };
    }
    // Source 2: the CLI's interactive-mode jsonl (only exists for terminal sessions).
    const file = this.cliTranscriptFilePath(sessionId);
    if (!file) {
      this.log.warn(`no persisted transcript found for ${sessionId}`);
      return { blocks: [], firstUserText: null };
    }
    try {
      const text = await readFile(file, "utf8");
      this.log.info(`transcript source: ${file}`);
      return parseTranscriptJsonl(text);
    } catch (error) {
      this.log.warn(`transcript read failed: ${errorMessage(error)}`);
      return { blocks: [], firstUserText: null };
    }
  }

  // --- Super Agent (child sessions of the main session) ----------------------

  /**
   * 把看板投影推给 webview（按当前主会话取历史子会话）。
   *
   * 会话切换后必须重推一次：看板的归属跟着主会话走，A 的历史子会话不能在
   * B 的看板上出现。管理器只在子会话状态变化时 emit，纯切换不会触发。
   */
  private publishSuperSessions(): void {
    const sessions = this.superAgent?.list(this.currentMainSessionId()) ?? [];
    this.store.setSuperSessions(sessions);
    // 看板换了归属，等待态也得跟着重算（否则切完会话还留着旧的忙碌标记）。
    this.syncSuperWaitingState();
  }

  /**
   * 当前主会话 id —— 子会话归属它。
   *
   * 用 `activeSessionId`（切换器里的那个 id）而不是 `sessionId`：归档是按
   * 「用户能看到的那个会话」分文件的，恢复历史会话时拿同一个 id 就能取回来。
   */
  private currentMainSessionId(): string | null {
    const state = this.store.getState();
    return state.activeSessionId ?? state.sessionId;
  }

  /**
   * 把子会话记录落盘（重启后据此恢复看板）。
   *
   * 只存**记录**：分支、工作目录、结束状态、汇报历史。子会话的实时转录本来
   * 就不落盘（既定边界），待应答的提问随进程一起没了 —— 恢复出来也答不了，
   * 所以不存。
   *
   * 按**归属的主会话**逐个写：子会话是异步跑的，用户随时可能切到别的会话
   * 去，只写当前会话会把别人的归档覆盖成空。
   *
   * 返回 Promise：面板关闭时要 await 它 —— 那时宿主随时会退出，fire-and-forget
   * 的写很可能来不及落盘，子会话记录就此丢失。
   *
   * **写放大控制**：看板每变一次就会触发一次落盘，而实时进度每秒能变好几次
   * —— 每次都整份重写归档是纯粹的磁盘 IO 浪费（子会话多时能把 IO 拉满）。
   * 但**关键变更不能拖**：终态、改动去向、归档归属是「重启后必须还在」的
   * 事实，扩展随时可能被重启，拖到最后就等于那次运行发生过什么彻底丢了。
   * 所以按内容分两类：关键内容变了立刻写，只有展示性字段变化时合并到一次
   * 节流写里（`force` = true 时无视节流，直接写）。
   */
  private persistSuperSessions(options: { force?: boolean } = {}): Promise<void> {
    const manager = this.superAgent;
    if (!manager) return Promise.resolve();
    const fingerprint = superArchiveFingerprint(
      manager.archivableMainSessionIds().map((mainSessionId) => ({
        mainSessionId,
        sessions: manager.archivableSessions(mainSessionId),
      })),
    );
    const urgent = options.force === true || fingerprint !== this.superArchiveFingerprint;
    if (urgent) {
      this.superArchiveFingerprint = fingerprint;
      // 关键变更立刻写：还没跑的节流写也就不需要了（它写的是同一份内容）。
      if (this.superArchiveTimer) {
        clearTimeout(this.superArchiveTimer);
        this.superArchiveTimer = null;
      }
      return this.writeSuperArchives();
    }
    if (!this.superArchiveTimer) {
      const timer = setTimeout(() => {
        this.superArchiveTimer = null;
        void this.writeSuperArchives();
      }, SUPER_ARCHIVE_THROTTLE_MS);
      if (typeof timer.unref === "function") timer.unref();
      this.superArchiveTimer = timer;
    }
    return Promise.resolve();
  }

  /** 真正写归档（每个归属主会话一个文件）。 */
  private writeSuperArchives(): Promise<void> {
    const manager = this.superAgent;
    if (!manager) return Promise.resolve();
    const writes = manager.archivableMainSessionIds().map((mainSessionId) =>
      writeSuperSessionArchive(
        this.superStoreDir(),
        mainSessionId,
        manager.archivableSessions(mainSessionId),
      ).catch((error) => {
        this.log.warn(`super agent archive write failed: ${errorMessage(error)}`);
      }),
    );
    return Promise.all(writes).then(() => undefined);
  }

  /** 子会话归档的存放目录（扩展自己的存储，不进用户的仓库）。 */
  private superStoreDir(): string {
    return (this.context.storageUri ?? this.context.globalStorageUri).fsPath;
  }

  /**
   * 恢复某个主会话的子会话历史（重启后恢复该会话时调用）。
   *
   * 归档里是「那次运行发生过什么」的记录，进程早已不存在，所以状态归一在
   * `fromPersistedSuperSession` 里做（运行中 → 已中断）。分支与工作目录照旧
   * 保留 —— 它们还在磁盘上，用户照样能清理或让智能体合并。
   */
  private async restoreSuperSessions(mainSessionId: string): Promise<void> {
    const archive = await readSuperSessionArchive(this.superStoreDir(), mainSessionId);
    // 归档**读不出来**是故障，不是「这个会话没有子会话」。必须如实告诉用户
    // —— 旧实现把两者都当成空数组，用户重启后只看到空板子，完全看不出发生过
    // 什么。损坏的原件已由读侧留底（.corrupt-<时间戳>），路径一并报出。
    if (archive.damaged) {
      this.log.warn(
        `super agent: 子会话归档读不出来（${archive.damage ?? "unknown"}），备份：${archive.backupPath ?? "-"}`,
      );
      this.store.sendToast(
        "warning",
        vscode.l10n.t(
          "子会话记录已损坏，原文件已备份；这条会话的子会话记录无法恢复（{0}）",
          archive.backupPath ?? archive.damage ?? "unknown",
        ),
      );
    }
    const records = archive.sessions;
    if (records.length > 0) {
      const restored = records.map((record) => fromPersistedSuperSession(record));
      this.log.info(`super agent: restored ${restored.length} historical child session(s) for ${mainSessionId}`);
      this.getSuperAgent()?.restoreSessions(mainSessionId, restored);
    }
    // 恢复归档时顺带清扫磁盘上的残留 worktree（只在恢复时触发，不是每次
    // 快照都跑）：上次运行遗留的、已经并入当前分支的空 worktree 与分支，
    // 在这里被收掉 —— 否则它们会一直堆在 `.iflow/super/worktrees/` 下。
    // 超过 `iflow.superAgent.maxWorktrees` 的干净残留（含未合并的）按目录
    // mtime 从旧到新回收目录、保留分支。
    const maxKeep = clampMaxSuperWorktrees(
      vscode.workspace
        .getConfiguration("iflow")
        .get<number>("superAgent.maxWorktrees", DEFAULT_MAX_SUPER_WORKTREES),
    );
    const swept = await this.getSuperAgent()?.sweepStaleWorktrees?.({ maxKeep });
    if (swept && (swept.removed > 0 || swept.kept > 0 || swept.orphans.length > 0)) {
      this.log.info(
        `super agent: 残留清扫 — 删除 ${swept.removed} 个，保留 ${swept.kept} 个，疑似残留 ${swept.orphans.length} 个（需人工确认）`,
      );
    }
  }

  /**
   * 主仓根目录（worktree 的来源，也是委派附件路径的允许边界）。
   *
   * 没有打开的工作区时返回 null：隔离目录现在建在项目内，回退到扩展自己的
   * 安装目录会在那里堆 worktree，必须由调用方直接拒绝委派。
   */
  private superRepoRoot(): string | null {
    return (
      this.services.workspaceRoot ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      null
    );
  }

  /**
   * 把一个委派说明补全成交给子会话的最终 spec。
   *
   * 附件有两个来源：
   *  - 本轮用户附件（图片 base64 / 文件路径）—— 自动带上，子会话看不到对话，
   *    不带给它等于静默丢用户上下文；
   *  - 指令里显式写的 `attachments` 路径 —— 只放行工作区内的路径与暂存目录，
   *    以及用户本轮亲自附上的文件；模型不能借这条通道把任意磁盘文件复制出去。
   *
   * 超过上限的部分丢弃并计数（调用方据此提示，不静默裁掉）。
   */
  private prepareSuperSpec(spec: SuperTaskSpec, onDropped: (count: number) => void): SuperTaskSpec {
    const repoRoot = this.superRepoRoot();
    const attachments: SuperAttachment[] = [];
    const seen = new Set<string>();
    const carried = this.currentTurnAttachments;
    const userPaths = new Set<string>();
    if (carried) {
      let imageIndex = 0;
      for (const image of carried.images) {
        attachments.push({
          // The name becomes the file name in the child's attachment dir and is
          // listed in the child's task prompt — model-facing, so English.
          name: `image${++imageIndex}`,
          data: image.data,
          mimeType: image.mimeType,
        });
      }
      for (const file of carried.files) {
        attachments.push({ name: file.name, path: file.path });
        userPaths.add(normalizePathKey(file.path));
        seen.add(normalizePathKey(file.path));
      }
    }
    let dropped = 0;
    for (const candidate of spec.attachments ?? []) {
      if (candidate.data) {
        attachments.push(candidate);
        continue;
      }
      if (!candidate.path) continue;
      if (!repoRoot) {
        // 没有工作区就没有解析基准：只保留随任务附带的 base64 图片。
        dropped++;
        continue;
      }
      const resolved = this.resolveSuperAttachmentPath(candidate.path, repoRoot, userPaths);
      if (!resolved) {
        dropped++;
        continue;
      }
      const key = normalizePathKey(resolved);
      if (seen.has(key)) continue; // 用户附件已在列表里，模型重复引用不再加一份
      seen.add(key);
      attachments.push({ name: candidate.name, path: resolved });
    }
    if (dropped > 0) onDropped(dropped);
    if (attachments.length > MAX_SUPER_ATTACHMENTS) {
      onDropped(attachments.length - MAX_SUPER_ATTACHMENTS);
      attachments.length = MAX_SUPER_ATTACHMENTS;
    }
    const next: SuperTaskSpec = { title: spec.title, task: spec.task };
    if (attachments.length > 0) next.attachments = attachments;
    return next;
  }

  /**
   * 本轮用户附件 → 子会话可携带的形态。
   *
   * 图片走内联 base64（用户粘贴的截图从来没有磁盘路径），文件留源路径、由
   * `SuperAgentManager` 复制到子会话自己的附件目录 —— 子会话在独立 worktree
   * 里，主工作区的路径它读不到，所以必须复制而不是引用。超过
   * `MAX_SUPER_ATTACHMENTS` 的部分丢弃并回报数量（调用方提示，不静默裁掉）。
   */
  private collectSuperAttachments(
    images: { data: string; mimeType: string }[] | undefined,
    files: { name: string; path: string }[] | undefined,
    onDropped: (count: number) => void,
  ): SuperAttachment[] {
    const attachments: SuperAttachment[] = [];
    let imageIndex = 0;
    for (const image of images ?? []) {
      attachments.push({
        // The name becomes the file name in the child's attachment dir and is
        // listed in the child's task prompt — model-facing, so English.
        name: `image${++imageIndex}`,
        data: image.data,
        mimeType: image.mimeType,
      });
    }
    for (const file of files ?? []) {
      attachments.push({ name: file.name, path: file.path });
    }
    if (attachments.length > MAX_SUPER_ATTACHMENTS) {
      onDropped(attachments.length - MAX_SUPER_ATTACHMENTS);
      attachments.length = MAX_SUPER_ATTACHMENTS;
    }
    return attachments;
  }

  /**
   * 解析指令里的附件路径：相对路径按主仓根解析；只有工作区内、暂存目录内、
   * 或用户本轮亲自附上的文件才放行（其余一律拒绝，不把任意磁盘文件复制给子会话）。
   */
  private resolveSuperAttachmentPath(
    raw: string,
    repoRoot: string,
    userPaths: ReadonlySet<string>,
  ): string | null {
    // 模型常把提示词里的 `@path` 原样抄回来 —— 去掉标记再解析。
    const value = raw.trim().replace(/^@/, "");
    if (!value) return null;
    const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(repoRoot, value);
    if (userPaths.has(normalizePathKey(absolute))) return absolute;
    if (isWithin(repoRoot, absolute)) return absolute;
    // 只有**本会话**的暂存目录（用户拖入/粘贴的文件落在这里）。
    const stageRoot = attachmentSessionDir(this.store.getState().sessionId ?? "adhoc");
    if (isWithin(stageRoot, absolute)) return absolute;
    return null;
  }

  /**
   * The Super Agent orchestrator, created on first delegation.
   *
   * `createClient` mirrors the main session's spawn path (same vendored
   * entry, same node runtime, same credentials) but narrows the boundary to
   * the worktree: `cwd` and `allowedRoots` are the worktree root ONLY, so
   * neither the CLI's own workspace check nor our fs-callback boundary can
   * reach the main working copy. That is the whole point of the isolation.
   */
  private getSuperAgent(): SuperAgentManager | null {
    if (this.superAgent) return this.superAgent;
    const repoRoot = this.superRepoRoot();
    if (!repoRoot) {
      this.log.warn("super agent unavailable: no workspace folder open");
      return null;
    }
    this.superAgent = new SuperAgentManager({
      repoRoot,
      createClient: (params) => this.createSuperClient(params),
      onSessionsChanged: (sessions) => {
        this.store.setSuperSessions(sessions);
        // 子会话状态一变就把记录落盘：扩展随时可能被重启（窗口关闭、宿主
        // 崩溃），不落盘就等于「那次运行发生过什么」永远丢了。
        this.persistSuperSessions();
        // Child progress frames arrive continuously; the heartbeat is what
        // turns "main turn ended, children still working" into a visible
        // waiting state and keeps the report delivery retrying.
        if (sessions.some((session) => !isTerminalSuperStatus(session.status))) {
          this.ensureSuperHeartbeat();
        }
        this.refreshSuperWaitHeartbeat();
      },
      // A child's transcript rides its OWN channel: putting it in the main
      // `blocks` would pollute the main transcript and break the blockPatch
      // anchor. `from` is the incremental start index.
      onTranscript: (sessionId, from, blocks) =>
        this.postToWebview({ type: "superTranscript", sessionId, from, blocks }),
      onReport: (entries) => this.queueSuperReport(entries),
      // 子会话在等你回答：与主会话的提问卡同一档通知（`question` 属
      // approvals 默认档），只弹系统通知、不发提示音 —— 子会话的汇报回合
      // 已经统一静音，提问是唯一需要当场惊动用户的子会话事件。
      onNeedInput: (session) =>
        this.notifyOs("question", vscode.l10n.t("子会话「{0}」在等你回答", session.title)),
      // 自动集成没能把子会话的改动带回主分支 → 自动请智能体合并，
      // 不再把这件事留给用户点看板上的按钮。
      onNeedAgentMerge: (session, reason) => this.scheduleSuperMerge(session.id, reason),
      // 合并子会话跑完：宿主用只读 git 检测的结果如实告知（成功 / 失败 /
      // 分支仍保留），并把队列里的下一个合并请求放出去。
      onMergeResult: (info) => {
        if (info.merged) {
          this.store.sendToast(
            "info",
            vscode.l10n.t(
              "合并子会话已把子会话「{0}」的分支 {1} 合入当前分支",
              info.title,
              info.branch,
            ),
          );
        } else {
          this.store.sendToast(
            "warning",
            vscode.l10n.t(
              "合并子会话没能完成合并，分支仍保留：{0}（{1}）",
              info.branch,
              info.detail,
            ),
          );
        }
        void this.drainSuperMerges();
      },
      currentModel: () => this.store.getState().currentModelId,
      // 子会话归属当前主会话：归档按它分文件，恢复历史会话时按它取回。
      currentMainSessionId: () => this.currentMainSessionId(),
      // Child sessions spend the same money as the main session: reuse the
      // exact same price resolution (`iflow.costTable` overrides → curated
      // table → null) so the two surfaces can never disagree.
      priceFor: (modelId) =>
        resolveCost(modelId, parseCostTable(vscode.workspace.getConfiguration("iflow").get<string[]>("costTable", []))),
      // Read on every integration, so flipping the setting applies to the
      // next finished child without a restart.
      integrationMode: () => {
        const mode = vscode.workspace
          .getConfiguration("iflow")
          .get<string>("superAgent.integration");
        return mode === "pr" || mode === "manual" ? mode : "merge";
      },
      // 同样实时读：pump 每次都取当前值，设置页改完不需要重启面板。
      maxConcurrentSessions: () =>
        clampMaxConcurrentSuperSessions(
          vscode.workspace
            .getConfiguration("iflow")
            .get<number>("superAgent.maxConcurrent", DEFAULT_MAX_CONCURRENT_SUPER_SESSIONS),
        ),
      // 默认关闭 = 子会话正常完成后回收工作目录（分支一律保留）。失败/中断
      // 从不回收，重试要复用现场。每次实时读，改完对下一个结束的子会话生效。
      keepWorktree: () =>
        vscode.workspace
          .getConfiguration("iflow")
          .get<boolean>("superAgent.keepWorktree", false),
      // 磁盘上最多保留多少个已结束子会话的工作目录（0 = 不限制）。
      maxWorktrees: () =>
        clampMaxSuperWorktrees(
          vscode.workspace
            .getConfiguration("iflow")
            .get<number>("superAgent.maxWorktrees", DEFAULT_MAX_SUPER_WORKTREES),
        ),
      log: this.log,
    });
    return this.superAgent;
  }

  /** Spawn a CLI client for a child session (own process, own worktree). */
  private async createSuperClient(params: {
    cwd: string;
    allowedRoots: string[];
    includeDirectories: string[];
    label: string;
    callbacks: AcpClientCallbacks;
  }): Promise<AcpClient> {
    const entry = this.resolveEntry();
    const nodePathConfigured = vscode.workspace.getConfiguration("iflow").get<string>("nodePath");
    const locatedNode = nodePathConfigured ? null : await locateNodeExecutable();
    const node = nodePathConfigured || locatedNode || process.execPath;
    const runtime = await concealNodeExecutable(node, this.context.globalStorageUri.fsPath);
    // The child's cwd is its worktree (or, for a merge child, the main
    // workspace). The extra roots come from the manager, which knows the
    // isolation kind: worktree children get only their attachment dir, while
    // a merge child gets the main repo root so the CLI's own workspace check
    // and our fs boundary agree on what it may read.
    const includeDirectories = params.includeDirectories;
    const { args } = buildAcpCommand(entry, includeDirectories);
    const systemPromptFile = await this.materializeSystemPrompt();
    const spawnEnv: NodeJS.ProcessEnv = {
      IFLOW_HARNESS: "1",
      IFLOW_HARNESS_CONTEXT_FILE: this.contextReportFile(),
      // 子会话绝不能拿到主会话的内置 `super-agent` 工具开关：那个工具负责
      // 派发子会话，给了子会话就等于允许无限套娃。AcpClient 把 process.env
      // 铺在 options.env 之下，这里用 undefined 显式抹掉该键（Node 的 spawn
      // 会跳过值为 undefined 的环境变量），即便用户 shell 里设了也不继承。
      IFLOW_SUPER_TOOL: undefined,
    };
    if (systemPromptFile) spawnEnv.IFLOW_SYSTEM_MD = systemPromptFile;
    const client = new AcpClient(
      {
        command: runtime,
        args,
        cwd: params.cwd,
        env: spawnEnv,
        requestTimeoutMs: 120_000,
        allowedRoots: params.allowedRoots,
      },
      params.callbacks,
    );
    await client.connect();
    const creds =
      (await this.resolveWorkspaceHandshakeCreds().catch(() => null)) ??
      (await loadCredentials(this.context.secrets).catch(() => null));
    if (creds) {
      await client.authenticate({
        methodId: "openai-compatible",
        methodInfo: { apiKey: creds.apiKey, baseUrl: creds.baseUrl, modelName: creds.modelName },
      });
    }
    return client;
  }

  /**
   * 换会话 / 恢复会话 / 热重认证时重置委派扫描状态。
   *
   * 滚动缓冲里是上一个会话的助手文本（可能还有没收口的围栏），去重账本里是
   * 上一个会话派发过的载荷 —— 两者都跟新会话无关：不清掉会让新会话的扫描
   * 基线落在别人的文本上，还会把本该重新派发的指令误判成重复。
   */
  private resetSuperDirectiveScans(): void {
    this.superScan.reset();
    this.superDispatchedDirectives.clear();
    this.superToolCallWarned.clear();
    this.superToolCallActionsDone.clear();
  }

  /**
   * Scan the MAIN session's assistant text for delegation directives.
   *
   * The directive is a `super-agent` fenced block carrying JSON:
   * `{ "tasks": [{ "title", "task" }] }`. Scanning happens per chunk, so a
   * delegation takes effect mid-turn — the main session can open child
   * sessions at any time, not only at turn end.
   *
   * Only the main agent's OWN text is scanned: nested SubAgent events (the
   * CLI's own `task` tool) carry an `agentId` and are ignored — v1 supports
   * exactly one level of children.
   */
  private scanSuperDirectives(content: unknown): void {
    const text = ChatPanel.chunkText(content);
    if (!text) return;
    // 扫描器自己持有滚动缓冲与消费偏移：扫完就把死区丢掉，缓冲因此不随
    // 会话长度增长（宿主自己攒字符串的话是无界的）。只有正文通道会调用。
    const scan = this.superScan.push(text);
    if (scan.invalidBlocks.length > 0) {
      // 只报「无法解析」等于让用户和模型都没法自查；带上失败原因与正文长度，
      // 才能一眼看出是 JSON 写坏了还是任务书太长被截断。
      const first = scan.invalidBlocks[0]!;
      this.store.sendToast(
        "warning",
        vscode.l10n.t("子会话派发指令无法解析（{0}，内容共 {1} 字符），已忽略", first.reason, first.body.length),
      );
    }
    if (scan.blocks.length === 0) return;
    this.dispatchSuperTasks(scan.blocks);
  }

  /**
   * 把解析出的委派任务交给子会话管理器。
   *
   * 正文围栏（{@link scanSuperDirectives}）与结构化工具调用
   * （{@link handleSuperToolCall}）共用这一段：去重键、附件丢弃计数、
   * toast 文案都不允许两条通道各写一份 —— 同一份载荷从两条路径同时到达时，
   * `superDirectiveDedupeKey` 必须能看见同一个账本，否则会双开子会话。
   */
  private dispatchSuperTasks(blocks: readonly SuperTaskSpec[][]): void {
    const manager = this.getSuperAgent();
    if (!manager) {
      this.store.sendToast("warning", vscode.l10n.t("没有打开的工作区，无法派发子会话"));
      return;
    }
    let dispatched = 0;
    let droppedAttachments = 0;
    for (const tasks of blocks) {
      for (const task of tasks) {
        // 同一份载荷在正文里被重复写出时只派发第一次。
        const dedupeKey = ChatPanel.superDirectiveFingerprint(superDirectiveDedupeKey([task]));
        if (this.superDispatchedDirectives.has(dedupeKey)) {
          this.log.info(`super agent: skipped-duplicate directive 「${task.title}」`);
          continue;
        }
        const spec = this.prepareSuperSpec(task, (count) => {
          droppedAttachments += count;
        });
        const session = manager.spawn(spec);
        this.rememberDispatchedDirective(dedupeKey);
        dispatched++;
        this.log.info(`super agent: dispatched ${session.id} 「${spec.title}」`);
      }
    }
    if (droppedAttachments > 0) {
      this.store.sendToast(
        "warning",
        vscode.l10n.t("子会话派发指令中有 {0} 个附件不可用（不在工作区或暂存目录），已忽略", droppedAttachments),
      );
    }
    // 全部命中重复时没有「已经派发」这件事可报 ——
    // 发一条「已派发 0 个」只会让用户以为出了错。
    if (dispatched === 0) return;
    // 提示里报实际生效的上限（设置页可调），而不是写死的常量。
    const concurrency = clampMaxConcurrentSuperSessions(
      vscode.workspace
        .getConfiguration("iflow")
        .get<number>("superAgent.maxConcurrent", DEFAULT_MAX_CONCURRENT_SUPER_SESSIONS),
    );
    this.store.sendToast(
      "info",
      vscode.l10n.t("已派发 {0} 个子会话（并发上限 {1}）", dispatched, concurrency),
    );
  }

  /**
   * 结构化工具调用兜底。
   *
   * 模型把派发 / 管理写成 `super-agent` / `super-agent-actions` 工具调用时，
   * 内核 registry 里没有这两个工具 —— 旧实现既不执行也不提示，用户以为已经
   * 派了，实际什么都没发生。这里从 `args` 取载荷、包成对应围栏文本，再交给
   * 现有解析器（`shared/super-tool-call.ts` 复用 `extractSuperDirectives` /
   * `extractSuperActions`，不复制校验逻辑）。
   *
   * 失败**必须留痕**：名字命中了却取不出可用载荷时记一条日志并弹一次 toast
   * （按 toolCallId 去重）。绝不伪造派发 —— 载荷坏了就当没派，明确告诉用户。
   *
   * 工具帧本身仍照常进 store（失败的工具卡是可见性，不能屏蔽）。
   */
  private handleSuperToolCall(update: ToolCallBase): void {
    const name = (update.toolName ?? update.title ?? "").trim();
    const kind = classifySuperToolName(name);
    if (!kind) return;
    // Wire 实证（CLI 0.5.19，见 protocol.ts 的 `args` 注释）：原始参数只随
    // `tool_call_update(in_progress)` 到达，pending 帧通常没有 args。此时还
    // 不能下结论 —— 下一帧就会带载荷；在这里弹「未派发子会话」是误报
    // （用户先看到「没派」，紧接着又看到真的派了）。
    if (update.status === "pending" && (update.args === undefined || update.args === null)) return;
    const parsed = parseSuperToolCall(kind, update.args);
    if (!parsed.ok) {
      this.warnUnsupportedSuperToolCall(update, name, parsed.reason);
      return;
    }
    // 载荷纠偏：新版 `super-agent` 工具同时收 tasks / actions，模型做管理动作
    // 时可能只传 `{"actions":[…]}`（名字仍是 dispatch）。分流以解析器纠偏后的
    // kind 为准 —— 管理动作走动作链路，既不派发子会话，也不是「未派发」失败。
    this.log.info(
      `super agent: accepted structured ${parsed.kind} tool call (${update.toolCallId || "no-id"})`,
    );
    if (parsed.kind === "dispatch") {
      this.dispatchSuperTasks(parsed.tasks);
      return;
    }
    // 同一工具帧会在 pending / in_progress 两帧各带一次载荷；动作没有载荷
    // 账本（派发侧有 `superDispatchedDirectives`），不去重就会执行两次 ——
    // `cleanup` / `retry` 的第二次会报假失败，`cleanup` 还可能并发操作同一个
    // worktree。按「工具调用 + 载荷」去重，不同调用照常各自执行。
    const actionKey = `${update.toolCallId || "no-id"}#${parsed.text}`;
    if (this.superToolCallActionsDone.has(actionKey)) {
      this.log.info(
        `super agent: skipped-duplicate structured actions tool call (${update.toolCallId || "no-id"})`,
      );
      return;
    }
    this.rememberSuperToolCallActions(actionKey);
    // 带上 toolCallId：runSuperActions 收尾时把每条动作的真实结果回填到这张
    // 工具帧，动作卡才能显示「中断成功 / not-found」而不是绿色「已完成」。
    void this.runSuperActions(parsed.actions, update.toolCallId);
  }

  /** 记住一条已执行的动作工具调用（有界 Set，超了丢最早一条）。 */
  private rememberSuperToolCallActions(key: string): void {
    if (this.superToolCallActionsDone.size >= ChatPanel.SUPER_TOOL_CALL_ACTIONS_CAP) {
      const oldest = this.superToolCallActionsDone.values().next().value;
      if (oldest !== undefined) this.superToolCallActionsDone.delete(oldest);
    }
    this.superToolCallActionsDone.add(key);
  }

  /**
   * 委派载荷指纹：账本只存 SHA-256 摘要，不存整份载荷键。
   *
   * `superDirectiveDedupeKey` 会把附件的内联数据（base64 图片/文件，可达
   * MB 级）一起序列化进键 —— 直接把键存进集合等于把附件内容在内存里再留
   * 一份。摘要后每条账目只有 32 个 hex 字符（16 字节摘要），两条不同载荷
   * 撞车的概率 ~2⁻¹²⁸，可以当作「同键即同载荷」。
   */
  private static superDirectiveFingerprint(dedupeKey: string): string {
    return createHash("sha256").update(dedupeKey).digest("hex").slice(0, 32);
  }

  /**
   * 记住一条已派发的委派载荷（有界 FIFO 账本，超了丢最早一条）。
   *
   * 与 {@link superToolCallActionsDone} / {@link superToolCallWarned} 同一套
   * 有界集合做法：载荷数量不设界，账本必须有上限，否则长时间运行的会话会
   * 一直涨。
   *
   * 淘汰的代价（诚实说明）：被淘汰的载荷若再次出现在正文里，会被当成新
   * 载荷**再派发一次**（多开一个子会话）。触发条件很窄 —— 先有 100 条不同
   * 载荷被派发过，模型再逐字重写其中一条；那时会话早已有上百个子会话，
   * 多开一个的代价比账本无限增长小。跨通道去重（思考里写一遍、正文里再写
   * 一遍）的真实场景发生在同一轮内，落在窗口之内，不受影响。
   */
  private rememberDispatchedDirective(fingerprint: string): void {
    if (this.superDispatchedDirectives.size >= ChatPanel.SUPER_DISPATCHED_DIRECTIVES_CAP) {
      const oldest = this.superDispatchedDirectives.values().next().value;
      if (oldest !== undefined) this.superDispatchedDirectives.delete(oldest);
    }
    this.superDispatchedDirectives.add(fingerprint);
  }

  /**
   * 名字命中但载荷不可用：日志 + 一次性 toast。
   *
   * 同一条工具帧会在 pending / in_progress / completed 之间反复推送，按
   * toolCallId 去重（没有 id 时退化为「名字 + 状态」）。集合有上限：工具帧
   * 数量本身不设界，不能让它无限增长；换会话时由
   * {@link resetSuperDirectiveScans} 清空。
   */
  private warnUnsupportedSuperToolCall(update: ToolCallBase, name: string, reason: string): void {
    const key = update.toolCallId || `${name}#${update.status ?? ""}`;
    if (this.superToolCallWarned.has(key)) return;
    if (this.superToolCallWarned.size >= ChatPanel.SUPER_TOOL_CALL_WARN_CAP) {
      const oldest = this.superToolCallWarned.values().next().value;
      if (oldest !== undefined) this.superToolCallWarned.delete(oldest);
    }
    this.superToolCallWarned.add(key);
    this.log.warn(
      `super agent: tool call 「${name}」 (${update.toolCallId || "no-id"}) yielded no usable payload: ${reason}`,
    );
    this.store.sendToast(
      "warning",
      vscode.l10n.t(
        "模型调用了不存在的 super-agent 工具（{0}，工具列表里没有它），未派发子会话",
        name,
      ),
    );
  }

  /**
   * Scan the MAIN session's assistant text for child-session management
   * actions (`super-agent-actions` fenced blocks).
   *
   * Same channel and same guard as delegation scanning: only the main
   * agent's own text is read, so a child can never steer another child.
   * Actions execute as soon as the block closes — the main session can
   * retry / cancel / answer / merge / clean up mid-turn instead of waiting
   * for the user to click the board.
   */
  private scanSuperActions(content: unknown): void {
    const text = ChatPanel.chunkText(content);
    if (!text) return;
    this.superActionScanText += text;
    const scan = extractSuperActions(this.superActionScanText, this.superActionScanOffset);
    if (scan.end > this.superActionScanOffset) this.superActionScanOffset = scan.end;
    if (scan.invalidBlocks.length > 0) {
      this.store.sendToast("warning", vscode.l10n.t("子会话管理指令无法解析，已忽略"));
    }
    if (scan.actions.length > 0) void this.runSuperActions(scan.actions);
    // 围栏开了没收：记住它。流式期间这是正常中间态（载荷下一帧才到），不在
    // 每帧报警；但**回合都结束了还停在这里**，说明这个动作块永远不会被执行
    // —— 回合收尾时复核并留痕（见 `auditSuperActionsAtSettle`）。
    if (scan.pending) {
      this.superActionPending = true;
      this.superActionPendingBody = scan.pendingBody ?? "";
    } else if (this.superActionPending) {
      // 后来补齐了（或者被后面那个完整围栏顶掉了）—— 不是问题。
      this.superActionPending = false;
      this.superActionPendingBody = "";
    }
    // 静默失败变可见：围栏确实出现过、这一轮也扫完了（不是还在流式等收栏），
    // 却既没有动作也没有非法块 —— 主会话下过指令，宿主什么都没执行。旧实现
    // 在这里什么都不留，故障只能靠用户复述「我发过啊」。只记日志、不弹 toast：
    // 这条通道每来一段文本都会扫一次，弹窗会变成噪音。
    //
    // 去重：同一处「零动作」只记一次（每来一段文本都会扫一次，不去重就是刷屏）。
    const zeroFence =
      scan.sawFence && !scan.pending && scan.actions.length === 0 && scan.invalidBlocks.length === 0;
    if (zeroFence && !this.superActionZeroWarned) {
      this.superActionZeroWarned = true;
      this.log.warn(
        `super-agent-actions fence produced no actions (scan buffer ${this.superActionScanText.length} chars, consumed offset ${this.superActionScanOffset})`,
      );
    } else if (!zeroFence) {
      this.superActionZeroWarned = false;
    }
  }

  /**
   * 回合收尾时复核动作围栏：把「停在未闭合围栏上」变成一条**有内容**的日志。
   *
   * 流式期间 pending 是正常中间态（围栏还没写完），每帧都报警只会变成噪音；
   * 但回合都结束了还停在 pending，说明这个动作块**永远不会被执行** —— 旧实现
   * 对此完全静默（零日志、零 toast），主会话只能靠重发一次才发现动作没生效。
   *
   * 这里**再扫一次**再下结论：回合结束时缓冲里的文本是最终形态，重新扫能
   * 确认「确实没收栏」而不是「最后一帧恰好还没到」。
   */
  private auditSuperActionsAtSettle(): void {
    if (!this.superActionPending) return;
    const body = this.superActionPendingBody;
    this.superActionPending = false;
    this.superActionPendingBody = "";
    try {
      const scan = extractSuperActions(this.superActionScanText, this.superActionScanOffset);
      // 后来补齐了 → 不是问题（动作已经执行或已被后面那个完整围栏顶掉）。
      if (!scan.pending) return;
      this.log.warn(
        `super-agent-actions fence never closed — the action block was NOT executed (unfinished payload: ${body || "(empty)"}; scan buffer ${this.superActionScanText.length} chars, consumed offset ${this.superActionScanOffset})`,
      );
    } catch (error) {
      this.log.warn(`super agent action audit failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Execute parsed management actions in output order.
   *
   * Failures are never silent: an action aimed at a stale id or inapplicable
   * state is counted as ignored and reported once, so the main session can
   * correct itself on the next turn (the board snapshot shows the real state).
   *
   * **「未生效」的口径要诚实**：对一个**已经是终态**的子会话再发一次 cancel
   * 是幂等重复 —— 意图（「别再跑了」）已经达成，宿主什么都不用做。那不是
   * 「未生效」，报成未生效会让主会话以为动作失败并**重复发同一个动作**
   * （真实故障）。只有「目标根本不存在」或「状态不适用」才是真的没生效。
   *
   * 每个动作的结果汇成一份**回执**投回主会话（hidden prompt）：主会话的
   * 看板摘要是每轮开篇冻结的，同一轮里它看不到自己动作的效果 —— 没有回执它
   * 就会重复发同一个动作。
   */
  private async runSuperActions(
    actions: readonly SuperAction[],
    toolCallId?: string,
  ): Promise<void> {
    const manager = this.getSuperAgent();
    if (!manager) return;
    let applied = 0;
    let ignored = 0;
    const receipts: SuperActionReceipt[] = [];
    for (const action of actions) {
      try {
        let receipt: SuperActionReceipt | undefined;
        switch (action.action) {
          case "retry": {
            const ok = await manager.retry(action.sessionId);
            receipt = {
              action: "retry",
              sessionId: action.sessionId,
              ok,
              reason: ok ? "applied" : "not-applicable",
              ...(ok ? {} : { detail: "the child session is not in a retryable state" }),
            };
            break;
          }
          case "cancel": {
            const outcome = await manager.cancel(action.sessionId);
            receipt = {
              action: "cancel",
              sessionId: action.sessionId,
              ok: outcome.ok,
              reason: outcome.reason === "cancelled" ? "applied" : outcome.reason,
              ...(outcome.reason === "already-terminal"
                ? { detail: `the child session was already ${outcome.status}` }
                : outcome.reason === "not-found"
                  ? { detail: "no such child session (it may have been cleaned up already)" }
                  : {}),
            };
            // hidden 回执只进主会话上下文，用户看不到。主 Agent 从每轮冻结的
            // 看板摘要里抄 id，抄错时 cancel 返回 not-found —— 这正是「中断没
            // 生效」的真实故障现场。这里额外给用户一条带 id 的明确提示。
            if (!outcome.ok && outcome.reason === "not-found") {
              this.store.sendToast(
                "warning",
                vscode.l10n.t(
                  "中断失败：找不到子会话 {0}，可能已被清理或 id 有误",
                  action.sessionId,
                ),
              );
            }
            break;
          }
          case "answer": {
            const ok = manager.respond(action.sessionId, { answers: action.answers });
            receipt = {
              action: "answer",
              sessionId: action.sessionId,
              ok,
              reason: ok ? "applied" : "not-applicable",
              ...(ok ? {} : { detail: "the child session has no pending question" }),
            };
            break;
          }
          case "cleanup": {
            const result = await manager.cleanup(action.sessionId, { keepBranch: action.keepBranch });
            receipt = {
              action: "cleanup",
              sessionId: action.sessionId,
              ok: result.ok,
              reason: result.ok ? "applied" : "not-applicable",
              ...(result.ok
                ? {}
                : { detail: result.reason ?? "the child session could not be cleaned up" }),
            };
            break;
          }
        }
        if (!receipt) {
          receipt = {
            action: action.action,
            sessionId: action.sessionId,
            ok: false,
            reason: "not-applicable",
            detail: "unknown action",
          };
        }
        receipts.push(receipt);
        if (receipt.ok) applied++;
        else ignored++;
      } catch (error) {
        ignored++;
        receipts.push({
          action: action.action,
          sessionId: action.sessionId,
          ok: false,
          reason: "not-applicable",
          detail: `the host failed to run the action: ${errorMessage(error)}`,
        });
        this.log.warn(`super agent action ${action.action} failed: ${errorMessage(error)}`);
      }
    }
    if (applied > 0) {
      this.store.sendToast("info", vscode.l10n.t("已按主会话指令管理子会话：成功 {0} 个", applied));
    }
    if (ignored > 0) {
      this.store.sendToast(
        "warning",
        vscode.l10n.t("{0} 个子会话管理动作未生效（目标不存在或状态不适用）", ignored),
      );
    }
    // 工具调用触发的动作：把真实结果回填到那张工具帧，动作卡据此显示
    // 「完成 / 未找到 / 失败」而不是把「工具调用完成」当成动作成功。
    if (toolCallId) this.store.superActionResult(toolCallId, receipts);
    this.queueSuperActionReceipt(receipts);
  }

  /**
   * 把动作执行结果排进主会话的回执队列。
   *
   * 走的是与子会话汇报同一条通道：**主会话上的一次 hidden prompt**（转录里
   * 不出现用户气泡）。主会话正忙着时它留在队列里等空闲时重投 —— 回执绝不
   * 丢：丢了主会话就永远不知道自己刚发的动作到底生效没有（于是重复发）。
   */
  private queueSuperActionReceipt(receipts: readonly SuperActionReceipt[]): void {
    if (receipts.length === 0 || this.disposed) return;
    const text = buildSuperActionReceiptPrompt(receipts);
    if (!text) return;
    // 同一份回执不重复排队（否则主会话会反复收到一模一样的「已生效」）。
    if (text === this.superActionReceiptLast) return;
    this.superActionReceiptLast = text;
    this.pendingSuperActionReceipts.push({ mainSessionId: this.currentMainSessionId(), text });
    this.ensureSuperHeartbeat();
    void this.drainSuperActionReceipts();
  }

  /**
   * 投递一条动作回执（与子会话汇报共用同一条车道，互斥执行）。
   *
   * 只在主会话**空闲**时投：主会话正忙着的时候它只能排队（hidden 回合不能
   * 插进正在跑的回合 —— 同一条 ACP 会话上并发两个回合会乱序）。
   */
  private async drainSuperActionReceipts(): Promise<void> {
    if (this.disposed || this.superReportRunning) return;
    const owner = this.currentMainSessionId();
    const index = this.pendingSuperActionReceipts.findIndex(
      (item) => item.mainSessionId === owner,
    );
    if (index === -1) return;
    if (!this.mainSessionFree()) return;
    if (this.superMergeRunning || this.pendingSuperMerges.length > 0 || this.superMergeChildRunning()) {
      return;
    }
    const item = this.pendingSuperActionReceipts[index]!;
    this.superReportRunning = true;
    try {
      this.clearSuperWaitHeartbeat();
      this.log.info("super agent: delivering the child-session action receipt as a fresh main-session turn");
      const started = await this.sendPrompt(item.text, undefined, undefined, undefined, {
        delegateOnBusy: false,
        hidden: true,
      });
      // 回合没跑起来（主会话被别的回合占着）：这条回执**留在队列里**，等空闲
      // 时重投 —— 回执丢了主会话就会重复发同一个动作。
      if (!started) return;
      this.pendingSuperActionReceipts.splice(index, 1);
    } catch (error) {
      this.log.warn(`super agent action receipt delivery failed: ${errorMessage(error)}`);
    } finally {
      this.superReportRunning = false;
    }
  }

  /**
   * 把 streaming 期间被改道给子会话的用户消息补投回主会话（hidden 回合）。
   *
   * 与子会话汇报 / 动作回执 / 合并请求共用同一条车道：`superReportRunning`
   * 是重入锁（这几个 drain 都在第一个 await 之前同步申领，谁先申领谁跑），
   * 主会话空闲（mainSessionFree，含 mainLane 空闲）才投，合并队列在跑时先
   * 让路。心跳会反复调用，所以「被占用 / 失败」的条目只是留在缓冲里等下一
   * 拍，绝不丢失、绝不重复派发。
   *
   * 补投走 `hidden:true + delegateOnBusy:false`：hidden 保证不伪造用户气泡、
   * 不改名、不拍 checkpoint；`delegateOnBusy:false` 保证它即便撞上 busy 窗口
   * 也只是被拒（留在缓冲里等下一拍），**不会二次派发子会话**。附件按原始
   * 形态重新附上（image 块 + AGENT_ATTACHMENT_HEADER 路径清单），文本由
   * buildDelegatedUserTurnPrompt 如实标注来源，不伪装成子会话汇报、不伪造
   * 附件内容（全部原件都带回，missingCount 因此恒为 0）。
   */
  private async drainDelegatedUserTurns(): Promise<void> {
    if (this.disposed || this.superReportRunning) return;
    // 用户按过停止：自动回合不许在这一轮结束后立刻接上（否则一次停止看起来
    // 毫无作用，用户只能反复点）。条目留在队列里，用户下次主动发消息即恢复。
    if (this.autoTurnsHeld()) return;
    if (this.pendingDelegatedUserTurns.length === 0) return;
    const owner = this.currentMainSessionId();
    if (!this.pendingDelegatedUserTurns.some((item) => item.mainSessionId === owner)) return;
    this.superReportRunning = true;
    try {
      while (true) {
        if (this.disposed) return;
        // 与 drainSuperReports 同因：drain 在跑的时候用户按了停止，循环不能
        // 立刻把下一条补投接上。
        if (this.autoTurnsHeld()) break;
        if (!this.mainSessionFree()) break;
        // 与汇报 turn 同款门控：一轮失败后别在心跳里连续喂下一条。
        if (this.store.getState().status === "error") break;
        // 合并子会话在主仓工作区里跑 git：与它互斥，等合并走完再投。
        if (
          this.superMergeRunning ||
          this.pendingSuperMerges.length > 0 ||
          this.superMergeChildRunning()
        ) {
          break;
        }
        const index = this.pendingDelegatedUserTurns.findIndex(
          (item) => item.mainSessionId === owner,
        );
        if (index === -1) break;
        const item = this.pendingDelegatedUserTurns[index]!;
        const text = buildDelegatedUserTurnPrompt({
          text: item.text,
          images: item.images,
          files: item.files,
          droppedByChild: item.droppedByChild,
        });
        this.log.info(
          "super agent: backfilling a delegated user turn as a fresh main-session hidden turn",
        );
        const started = await this.sendPrompt(
          text,
          item.images.length > 0 ? item.images : undefined,
          item.files.length > 0 ? item.files : undefined,
          item.contexts,
          { delegateOnBusy: false, hidden: true },
        );
        // 没跑起来（主会话被别的回合占着 / 被拒）：留在缓冲里等下一拍重投，
        // 既不丢这条消息，也不会重复派发子会话。
        if (!started) break;
        const pos = this.pendingDelegatedUserTurns.indexOf(item);
        if (pos !== -1) this.pendingDelegatedUserTurns.splice(pos, 1);
      }
    } catch (error) {
      this.log.warn(`delegated user turn backfill failed: ${errorMessage(error)}`);
    } finally {
      this.superReportRunning = false;
    }
  }

  /**
   * Live child-session board injected into every main-session turn.
   *
   * Without it the main agent has no way to know a child's state — it would
   * dispatch and then be blind until the user narrates the board.
   *
   * Never empty: the system prompt tells the agent that a turn WITHOUT a
   * `[子会话看板]` section is a CHILD session, so an empty board on the first
   * turn would make the main agent classify itself as a child and do the work
   * itself instead of delegating. The board marker is the role signal.
   */
  private superAgentsDigest(): string {
    const sessions = this.store.getState().superSessions;
    return buildSuperDigest(sessions ?? []);
  }

  /**
   * Buffer a child-session status update and hand it to the MAIN session as
   * soon as THAT child has settled.
   *
   * 逐个即时汇报（2026-11-12）：谁先结束谁先汇报，不必等同一批全部跑完 ——
   * 主会话不必守着最慢的那个孩子。Reports are accumulated (one latest
   * report per child) and the settled ones are handed over right away; the
   * children still running keep their entry in the buffer.
   *
   * Delivery is a **real prompt on the main ACP session** (`hidden`, so no
   * user bubble appears), NOT a side-channel completion appended as a muted
   * note. The main turn has usually already ended by then (delegation is
   * mid-turn, children outlive it), so that prompt is what restarts the
   * conversation: the agent reads the reports from its OWN context and can
   * take the next step. A side note would leave the agent blind to its own
   * children — exactly the "主会话停了 / 流程断了" symptom.
   *
   * The prompt is queued and drained when the main session is free; the
   * Super Agent heartbeat retries until it lands.
   */
  private queueSuperReport(entries: SuperReportEntry[]): void {
    if (entries.length === 0 || this.disposed) return;
    // 这些子会话已经把汇报交上来了：终态不再等于「已完成」。
    for (const entry of entries) this.superReportedChildIds.add(entry.session.id);
    // 按**归属主会话**分桶：汇报是投给某个主会话的一次真实 prompt，B 的
    // 子会话收尾时它的汇报不能投进 A 的对话（串台）。
    for (const entry of entries) {
      const key = this.superReportOwnerKey(entry.session);
      let buffer = this.pendingSuperReports.get(key);
      if (!buffer) {
        buffer = new SuperReportBuffer();
        this.pendingSuperReports.set(key, buffer);
      }
      buffer.add([entry]);
    }
    this.settleSuperReportsIfReady();
    this.syncSuperWaitingState();
  }

  /**
   * 汇报缓冲的桶键 = 归属主会话 id。
   *
   * 子会话没有归属（派发时面板还没有主会话 id）时跟随当前会话 —— 否则它的
   * 汇报永远没人接。
   */
  private superReportOwnerKey(session: SuperSessionUi): string {
    return session.mainSessionId ?? this.currentMainSessionId() ?? "";
  }

  /**
   * 子会话是否属于**当前**主会话。
   *
   * 汇报必须按归属投递：用户在会话 A 开着的时候，会话 B 的子会话收尾，它
   * 的汇报不能作为一次真实 prompt 投进 A —— 那会把别的会话的结果插进 A
   * 的上下文（模型读到自己没有的孩子，转录里也冒出别的会话的结论）。
   */
  private superBelongsToCurrentMain(session: SuperSessionUi): boolean {
    const owner = session.mainSessionId;
    if (!owner) return true; // 没有归属：跟随当前会话
    return owner === this.currentMainSessionId();
  }

  /**
   * 取走缓冲里**已经终态**的子会话汇报并投递（逐个即时汇报）。
   *
   * 门槛是「来源子会话已终态」，不是「这一批全部结束」—— 一个子会话跑完
   * 就交一次，主会话可以立刻接着推进；还在跑的子会话的汇报继续留在缓冲里。
   *
   * 只取**当前主会话**的子会话：别的会话的孩子还在跑（或者刚跑完），它的
   * 汇报要等用户切到那个会话再投。
   *
   * 来源子会话已经被清理（用户点清理 / 合并完释放）时，它的汇报再也没人能
   * 接 —— 如实记一笔然后丢掉，不能让面板卡在忙碌态。
   *
   * 心跳与看板变化时都补一次重算：子会话被清理之后可能再没有人来触发取件
   * （它的 onReport 不会再来第二次）。
   */
  private settleSuperReportsIfReady(): void {
    if (this.disposed || this.superReportRunning) return;
    if (this.pendingSuperReports.size === 0) return;
    const live = this.superAgent?.list() ?? [];
    // 来源子会话已不存在：这份汇报没人能接，丢掉（否则面板永久忙碌）。
    // 用**全部**活子会话判：别的会话的汇报也得保住（只是现在没人接）。
    for (const buffer of this.pendingSuperReports.values()) {
      const dropped = buffer.dropMissing(live);
      if (dropped.length > 0) {
        this.log.warn(
          `super agent: dropped ${dropped.length} child report(s) whose session(s) were cleaned up before delivery: ${dropped.join(", ")}`,
        );
      }
    }
    // 只取当前主会话那一桶：别的会话的汇报留在它自己的桶里等用户切过去。
    const buffer = this.pendingSuperReports.get(this.currentMainSessionId() ?? "");
    if (!buffer || buffer.size === 0) return;
    const mine = live.filter((session) => this.superBelongsToCurrentMain(session));
    const batch = buffer.takeSettled(mine);
    if (!batch) return; // 全都还在跑：继续积累。
    const text = this.superAgent?.reportPrompt(batch) ?? "";
    if (!text) return;
    this.log.info(`super agent: queued report for ${batch.length} settled child session(s)`);
    this.pendingSuperReportPrompts.push({ mainSessionId: this.currentMainSessionId(), text });
    this.ensureSuperHeartbeat();
    void this.drainSuperReports();
  }

  /**
   * Deliver queued child reports to the main session, one turn at a time.
   *
   * Only runs when the main session is free. The merge queue owns the same
   * single lane (a merge request is also a main-session turn), so the two are
   * mutually exclusive — otherwise two concurrent `sendPrompt` calls would
   * interleave on one ACP session.
   *
   * 逐个即时汇报：每个终态子会话各占一轮（不是一批合并成一轮）—— 后续
   * 子会话结束时会再排一轮。
   *
   * 只投**归属当前主会话**的汇报：排队期间用户可能切了会话，A 的汇报不能
   * 投进 B 的对话。
   */
  private async drainSuperReports(): Promise<void> {
    if (this.disposed || this.superReportRunning) return;
    // Stop means "stop": do not auto-start the next child-report turn the
    // instant the cancelled one settles (that is what made a single click look
    // ineffective and users click several times). Reports stay queued — the
    // user's next message releases the hold — so nothing is lost.
    if (this.autoTurnsHeld()) return;
    this.superReportRunning = true;
    try {
      while (this.pendingSuperReportPrompts.length > 0) {
        if (this.disposed) return;
        // The loop may already be running when the user presses Stop on the
        // report turn it just delivered — re-check every iteration, or the
        // next queued report would start the instant this one settles.
        if (this.autoTurnsHeld()) break;
        if (!this.mainSessionFree()) break;
        // 合并子会话在**主仓工作区**里跑 git merge：主会话这时若也去改主仓
        // 的文件，两边会互相踩（合并提交可能卷进主会话的半成品改动）。
        // 所以有合并子会话在跑（或还有排队的合并请求）时先让合并走完。
        if (
          this.superMergeRunning ||
          this.pendingSuperMerges.length > 0 ||
          this.superMergeChildRunning()
        ) {
          break;
        }
        // 只投当前主会话的汇报：别的会话的汇报等用户切过去再投（串台）。
        const owner = this.currentMainSessionId();
        const index = this.pendingSuperReportPrompts.findIndex(
          (item) => item.mainSessionId === owner,
        );
        if (index === -1) break;
        const item = this.pendingSuperReportPrompts[index]!;
        this.clearSuperWaitHeartbeat();
        this.log.info("super agent: delivering the settled child report as a fresh main-session turn");
        const started = await this.sendPrompt(item.text, undefined, undefined, undefined, {
          delegateOnBusy: false,
          hidden: true,
          // 这一轮是「主会话汇报子会话结果」：收尾时用 superReport 事件 +
          // done 音（与单个子会话收尾的 childDone + child 音区分开）。
          reportTurn: true,
        });
        if (!started) {
          // 回合没跑起来（主会话被别的回合占着）：这条汇报**留在队列里**，
          // 等空闲时重投 —— 汇报丢了主会话就永远读不到自己孩子的结果。
          break;
        }
        const pos = this.pendingSuperReportPrompts.indexOf(item);
        if (pos !== -1) this.pendingSuperReportPrompts.splice(pos, 1);
        // 这一轮失败了（端点 / 内核报错）：别在心跳里连续喂下一批，留给用户
        // 处理错误后自然的下一轮。
        if (this.store.getState().status === "error") break;
      }
    } catch (error) {
      this.log.warn(`super agent report delivery failed: ${errorMessage(error)}`);
    } finally {
      this.superReportRunning = false;
      // 汇报已经投出去（或投失败）：重算忙碌标记 —— 还有子会话在跑时面板保持
      // 忙碌态，全部结束且汇报已投出时才回到 idle。
      this.syncSuperWaitingState();
    }
  }

  /**
   * The main session can accept a host-driven turn right now.
   *
   * Mirrors the gate `sendPrompt` applies, evaluated BEFORE anything is
   * shifted off a queue so a rejected turn can never swallow a report.
   *
   * 车道也必须在空闲状态：用户回合还在准备阶段（状态还没翻成 streaming）
   * 时，汇报回合不能插进来 —— 那是同一时刻第二个回合跑在同一个 ACP 会话上。
   */
  private mainSessionFree(): boolean {
    const state = this.store.getState();
    return (
      !!state.sessionId &&
      !state.initializing &&
      state.status !== "streaming" &&
      !state.replaying &&
      !this.historySyncBusy &&
      this.mainLane === null
    );
  }

  /**
   * 用户的停止是否还压着宿主自动回合（子会话汇报 / 被改道消息补投）。
   *
   * 只看**当前主会话**：A 会话被停止不该影响 B 会话的汇报投递。解除点是用户
   * 下一次主动发消息（sendPrompt / regenerate），此前排队内容一条不丢。
   */
  private autoTurnsHeld(): boolean {
    return this.autoTurnsStoppedFor !== null && this.autoTurnsStoppedFor === this.currentMainSessionId();
  }

  /**
   * 当前主会话被压住 / 待投递的自动回合数（子会话汇报 + 被改道用户消息补投）。
   * `announceDeferredAutoTurns` 的提示数量、`syncSuperWaitingState` 写给 webview
   * 的 `superPendingCount` 与状态栏文案共用这一处口径 —— 分开数迟早会漂移。
   */
  private pendingAutoTurnCount(): number {
    const owner = this.currentMainSessionId();
    return (
      this.pendingSuperReportPrompts.filter((item) => item.mainSessionId === owner).length +
      this.pendingDelegatedUserTurns.filter((item) => item.mainSessionId === owner).length
    );
  }

  /**
   * Keep the heartbeat alive while any Super Agent work is outstanding.
   *
   * Without it, a child finishing while the main session is replaying history
   * (or right after a failed turn) would leave its report stranded: nothing
   * else fires the delivery hook again.
   */
  private ensureSuperHeartbeat(): void {
    if (this.disposed || this.superHeartbeatTimer) return;
    const timer = setInterval(() => this.superHeartbeatTick(), SUPER_HEARTBEAT_MS);
    // Never keep the extension host alive just for the heartbeat.
    if (typeof timer.unref === "function") timer.unref();
    this.superHeartbeatTimer = timer;
  }

  private superHeartbeatTick(): void {
    if (this.disposed) {
      this.stopSuperHeartbeat();
      return;
    }
    this.refreshSuperWaitHeartbeat();
    void this.drainSuperReports();
    void this.drainSuperActionReceipts();
    void this.drainDelegatedUserTurns();
    void this.drainSuperMerges();
    if (!this.hasSuperWork()) this.stopSuperHeartbeat();
  }

  /** Outstanding Super Agent work (queued turns, or children still running). */
  private hasSuperWork(): boolean {
    if (this.disposed) return false;
    if (this.pendingSuperReportPrompts.length > 0) return true;
    // 待投递的动作回执也算「还有活儿」：心跳停了回执就永远投不出去，主会话
    // 于是不知道自己刚发的动作生效没有（→ 重复发同一个动作）。
    if (this.pendingSuperActionReceipts.length > 0) return true;
    // 待补投的「被改道用户消息」同样是欠着主会话的一轮：心跳停了它就永远
    // 投不出去，那条消息又会像修复前一样在主会话里丢失。
    if (this.pendingDelegatedUserTurns.length > 0) return true;
    if (this.pendingSuperMerges.length > 0) return true;
    // 汇报已交上来但来源子会话还没终态：它的汇报还欠着主会话，心跳必须
    // 继续跑，否则既没有汇报也没有忙碌态刷新。
    // 缓冲按归属分桶，**任何**桶有欠账都要续命（用户随时可能切到那个
    // 会话，汇报得能投出去）。
    for (const buffer of this.pendingSuperReports.values()) {
      if (buffer.size > 0) return true;
    }
    return (this.store.getState().superSessions ?? []).some(
      (session) => !isTerminalSuperStatus(session.status),
    );
  }

  /**
   * 是否还有子会话没进入终态。
   *
   * 主会话回合先结束而子会话仍在跑时，对话里没有它们的结果，此时提炼
   * 「下一步建议」/「自动记忆」只能基于残缺内容；子会话全部结束后宿主会以
   * hidden 汇报 prompt 重新唤醒主会话，那一轮自然补上。因此 runTurnFollowup
   * 用这里跳过 conversation-derived 的两项（标题不受影响）。
   */
  private hasRunningSuperSessions(): boolean {
    return (this.store.getState().superSessions ?? []).some(
      (session) => !isTerminalSuperStatus(session.status),
    );
  }

  private stopSuperHeartbeat(): void {
    if (this.superHeartbeatTimer) {
      clearInterval(this.superHeartbeatTimer);
      this.superHeartbeatTimer = null;
    }
    this.clearSuperWaitHeartbeat();
  }

  /**
   * 主会话此刻是否还在等子会话的结果。
   *
   * 五种「还在等」：
   *  ①还有子会话没进终态；
   *  ②子会话已终态但还没把汇报交给宿主（终态与汇报交接之间隔着代提交与
   *    自动合并的 git 操作，可能好几秒）；
   *  ③汇报缓冲里还有欠账（有汇报，但来源子会话还没终态 —— 它一结束就会
   *    被交回主会话）；
   *  ④汇报提示词已备好、还在队列里等主会话空闲；
   *  ⑤汇报正在投进主会话（那一轮是 hidden prompt，status 会变 streaming）。
   *
   * 只看子会话状态是不够的：汇报真正投出去之前，「新会话」都该锁住 ——
   * 否则用户会在这个窗口点它，把排队里的汇报落到已被替换的会话上（面板上
   * 此时只有看板计数能看出还在等，顶栏不再有忙碌 chip）。
   *
   * **只看当前主会话的子会话**：别的会话的子会话在跑（或者它的汇报还欠着）
   * 不该让当前会话显示忙碌 —— 当前会话并不在等它们，它们的汇报会等用户
   * 切过去再投。
   */
  private superWaitingForReports(liveChildren?: SuperSessionUi[]): boolean {
    const owner = this.currentMainSessionId();
    if (this.pendingSuperReportPrompts.some((item) => item.mainSessionId === owner)) return true;
    if (this.superReportRunning) return true;
    const buffer = this.pendingSuperReports.get(owner ?? "");
    if (buffer && buffer.size > 0) return true;
    // 只看**活着的**子会话：归档里的历史子会话早就终态，也永远不会再汇报，
    // 算进来会让忙碌态永远关不掉。
    const live = liveChildren ?? this.superAgent?.list() ?? [];
    for (const session of live) {
      if (!this.superBelongsToCurrentMain(session)) continue;
      if (!isTerminalSuperStatus(session.status)) return true;
      if (!this.superReportedChildIds.has(session.id)) return true;
    }
    return false;
  }

  /**
   * 把「正在等子会话」这个忙碌标记同步给 webview。
   *
   * 等待期主会话的 `status` 仍然是 "idle" —— 用户还要能发消息并由主会话响应，
   * 所以不能借用 "streaming"（那会把用户消息派发成子会话）。但面板必须把
   * 「新会话」锁住：等待期新建会话会让排队里的汇报落到已被替换的会话上。
   * 顶栏不再为它渲染忙碌 chip（忙碌信号由转录底部浮动 pill 与子会话看板计数
   * 承担）。
   *
   * 例外：用户按了「停止」压住汇报时（`superHeld`），「新会话」必须放行 ——
   * 否则用户点完停止就再无出路（唯一的解锁是发下一条消息，而那条一次性 toast
   * 转瞬即逝），面板看起来就是永久卡住。状态栏也不再把压住态谎报成「生成中」。
   */
  private syncSuperWaitingState(): void {
    // 子会话被清理后它的 id 不再有意义 —— 顺手剪掉，别让集合无限增长。
    // 剪的时候看**全部**活子会话：别的会话的孩子也在这集合里（汇报是按
    // 归属记的），按当前会话剪会把它们的「已汇报」标记误删。
    const live = this.superAgent?.list() ?? [];
    const liveIds = new Set(live.map((session) => session.id));
    for (const id of [...this.superReportedChildIds]) {
      if (!liveIds.has(id)) this.superReportedChildIds.delete(id);
    }
    this.store.setSuperWaiting(
      this.superWaitingForReports(live),
      this.autoTurnsHeld(),
      this.pendingAutoTurnCount(),
    );
    this.syncChildSettledAnnouncements(live);
  }

  /**
   * 子会话逐个完成提示：每个子会话**各自**从非终态迁移到终态
   * （completed / failed / cancelled）时提示一次。
   *
   * 为什么放弃聚合判定（旧的「非终态数 >0 掉到 0 → 子会话已全部结束」）：
   *  ①聚合把多个子会话的收尾混成一次 —— 用户要的是「每个子会话各提示一次」，
   *    两个子会话先后完成应各响一声，而不是等到最后一个才响。
   *  ②聚合无法区分「刚刚结束」与「早就结束」：恢复归档、刚打开看板时非终态数
   *    本来就是 0，任何额外一次 sync 都可能误报一个过期事实。
   *  ③「全部结束」的文案与用户回合完成共用 turnDone 事件和 done 音，导致
   *    「子会话干完」与「主会话干完」在通知通道上无法区分（2026-11-16 需求）。
   *
   * 判据用**全部活子会话**（不分主会话）：看板对活着的子会话一律可见，提示
   * 与用户能看到的内容保持一致。状态记录按 childId 保存，子会话被清理后
   * 顺手剪掉，避免集合无限增长。
   */
  private syncChildSettledAnnouncements(live: SuperSessionUi[]): void {
    if (this.disposed) return;
    const liveIds = new Set(live.map((session) => session.id));
    for (const id of [...this.superLastStatus.keys()]) {
      if (!liveIds.has(id)) this.superLastStatus.delete(id);
    }
    for (const session of live) {
      const previous = this.superLastStatus.get(session.id);
      this.superLastStatus.set(session.id, session.status);
      // 首次看到它（恢复归档 / 刚打开看板）：这不是「刚刚结束」，是过期事实。
      if (previous === undefined) continue;
      // 上次就已经终态：重复 sync（心跳每 1.5s 一次）不能重复提示。
      if (isTerminalSuperStatus(previous)) continue;
      // preparing / running / awaiting_input 都还不是完成。
      if (!isTerminalSuperStatus(session.status)) continue;
      this.announceChildSettled(session);
    }
  }

  /** 一个子会话刚刚收尾：按终态分别给文案（事件与音色由 announceChildDone 统一）。 */
  private announceChildSettled(session: SuperSessionUi): void {
    const title = session.title;
    if (session.status === "completed") {
      this.announceChildDone(vscode.l10n.t("子会话「{0}」已完成", title));
    } else if (session.status === "failed") {
      this.announceChildDone(vscode.l10n.t("子会话「{0}」已失败", title));
    } else {
      // 终态只剩 cancelled（isTerminalSuperStatus 已过滤）。
      this.announceChildDone(vscode.l10n.t("子会话「{0}」已中断", title));
    }
  }

  /**
   * The 「waiting for children」 pill.
   *
   * The main turn is over while children still run, so the panel would look
   * idle/stopped even though work continues. A persistent, display-only toast
   * states that the host is waiting and will continue on its own. Refreshed by
   * the heartbeat; re-sent only when the live/awaiting counts change (progress
   * frames arrive continuously and must not churn the toast stack).
   *
   * 计数只算**当前主会话**的子会话：别的会话的孩子在跑，当前会话并不在等
   * 它们（它们的汇报会等用户切过去再投）—— 混在一起数会让提示与提示词里的
   * pendingCount 对不上当前会话。
   */
  private refreshSuperWaitHeartbeat(): void {
    if (this.disposed) return;
    // 子会话被清理后「所有子会话都终态」可能已经成立、却再没有人来触发取
    // 批次（它的 onReport 不会再来）—— 心跳与看板变化时补一次重算。
    this.settleSuperReportsIfReady();
    // 忙碌标记跟常驻提示同源：心跳每 1.5s 刷一次，等待期面板一直是忙碌态。
    this.syncSuperWaitingState();
    const sessions = this.store.getState().superSessions ?? [];
    const live = sessions
      .filter((session) => this.superBelongsToCurrentMain(session))
      .filter((session) => !isTerminalSuperStatus(session.status));
    const awaiting = live.filter((session) => session.status === "awaiting_input").length;
    if (live.length === 0 || !this.mainSessionFree()) {
      this.clearSuperWaitHeartbeat();
      return;
    }
    // 用户按过停止：自动投递被压住，提示必须如实改写 —— 此时还写「会自动
    // 继续」就是在骗人（用户会盯着面板等一个永远不会来的自动回合）。
    const held = this.autoTurnsHeld();
    const key = `${live.length}:${awaiting}:${held ? "held" : "auto"}`;
    if (key === this.superWaitToastKey && this.superWaitToastId !== null) return;
    this.clearSuperWaitHeartbeat();
    const message = held
      ? awaiting > 0
        ? vscode.l10n.t(
            "已停止；{0} 个子会话仍在运行（其中 {1} 个等待你的回答），发送下一条消息后继续收取汇报",
            live.length,
            awaiting,
          )
        : vscode.l10n.t(
            "已停止；{0} 个子会话仍在运行，发送下一条消息后继续收取汇报",
            live.length,
          )
      : awaiting > 0
        ? vscode.l10n.t(
            "正在等待 {0} 个子会话汇报（其中 {1} 个等待你的回答），完成一个即汇报一个，会自动继续",
            live.length,
            awaiting,
          )
        : vscode.l10n.t(
            "正在等待 {0} 个子会话汇报（完成一个即汇报一个，会自动继续）",
            live.length,
          );
    this.superWaitToastKey = key;
    this.superWaitToastId = this.store.sendToast("info", message, {
      persistent: true,
      displayOnly: true,
    });
  }

  private clearSuperWaitHeartbeat(): void {
    if (this.superWaitToastId !== null) {
      this.store.dismissToast(this.superWaitToastId);
      this.superWaitToastId = null;
    }
    this.superWaitToastKey = null;
  }

  /** Route a Super Agent action from the board. */
  private async handleSuperAgentAction(msg: Extract<WebviewToHost, { type: "superAgent" }>): Promise<void> {
    const manager = this.getSuperAgent();
    if (!manager) return;
    switch (msg.action) {
      case "transcript": {
        if (!msg.sessionId) return;
        this.postToWebview({
          type: "superTranscript",
          sessionId: msg.sessionId,
          from: 0,
          blocks: manager.transcriptBlocks(msg.sessionId),
        });
        break;
      }
      case "cancel": {
        if (!msg.sessionId) return;
        const outcome = await manager.cancel(msg.sessionId);
        // 与 cancelAll / cleanup / retry 一致，单个中断也要有可见回执。
        // 按 SuperCancelOutcome 的真实 reason 区分文案：幂等重复（已终态）
        // 不是失败，但要如实告诉用户「无需中断」，避免以为刚才那下没生效。
        if (outcome.reason === "cancelled") {
          this.store.sendToast("info", vscode.l10n.t("已中断子会话"));
        } else if (outcome.reason === "already-terminal") {
          this.store.sendToast("info", vscode.l10n.t("这个子会话已经结束了，不用再中断"));
        } else {
          this.store.sendToast("warning", vscode.l10n.t("该子会话不存在或已被清理"));
        }
        break;
      }
      case "cancelAll": {
        const count = await manager.cancelAll();
        this.store.sendToast("info", vscode.l10n.t("已中断 {0} 个子会话", count));
        break;
      }
      case "respond": {
        if (!msg.sessionId) return;
        const ok = manager.respond(msg.sessionId, { answers: msg.answers });
        if (!ok) this.store.sendToast("warning", vscode.l10n.t("该子会话没有待处理的请求"));
        break;
      }
      case "cleanup": {
        if (!msg.sessionId) return;
        const result = await manager.cleanup(msg.sessionId, { keepBranch: msg.keepBranch });
        if (result.branchKept) {
          this.store.sendToast(
            "info",
            vscode.l10n.t("已清理工作目录，分支已保留：{0}", result.reason ?? ""),
          );
        } else {
          this.store.sendToast("info", vscode.l10n.t("已清理子会话"));
        }
        break;
      }
      case "cleanupBatch": {
        const ids = msg.sessionIds ?? [];
        if (ids.length === 0) return;
        // 串行清理：每个目标都要删 worktree / 跑 git 探测，并发只会互相抢锁。
        // 逐条 toast 会把转录刷满（N 条重复），因此这里只聚合结果、发**一条**
        // 汇总回执；单个清理仍走上面的 `cleanup` 分支，回执保持原样。
        let cleaned = 0;
        let branchesKept = 0;
        let failed = 0;
        for (const id of ids) {
          try {
            const result = await manager.cleanup(id, { keepBranch: msg.keepBranch });
            if (result.ok) {
              cleaned += 1;
              if (result.branchKept) branchesKept += 1;
            } else {
              failed += 1;
              this.log.warn(
                `super agent: 批量清理未能完成 ${id}：${result.reason ?? "未知原因"}`,
              );
            }
          } catch (error) {
            failed += 1;
            this.log.warn(`super agent: 批量清理 ${id} 失败：${errorMessage(error)}`);
          }
        }
        this.reportSuperCleanupBatch(cleaned, failed, branchesKept);
        break;
      }
      case "merge": {
        if (!msg.sessionId) return;
        await this.requestSuperMerge(msg.sessionId);
        break;
      }
      case "retry": {
        if (!msg.sessionId) return;
        const ok = await manager.retry(msg.sessionId);
        if (ok) {
          this.store.sendToast("info", vscode.l10n.t("已重新派发子会话（沿用原工作目录）"));
        } else {
          this.store.sendToast("warning", vscode.l10n.t("该子会话当前无法重试"));
        }
        break;
      }
    }
  }

  // --- QQ 远程任务通道 -------------------------------------------------------
  //
  // 一条通道 = 一份 QqService + QQBot 官方 adapter（直连官方网关，无子进程）。
  // 面板只做编排：命令解析 / 白名单 / 审批桥 / 结果回传全在 QqService 里；本节
  // 负责把它们接起来、把生命周期管住、把状态投影给 UI。
  //
  // 纪律：
  //  - 所有入口先判 `this.qq` 是否存在 —— 半启动的现场绝不能被消息驱动；
  //  - 主动停止走 `qqStopping` 标记，防止与在飞的启停重叠；
  //  - 连接类设置改动重建服务，其余字段就地热更新（见 src/qq/wiring.ts）。

  /** 设置启用 → 启动通道；任何失败都把半启动现场收干净并如实提示。 */
  private startQqIfEnabled(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.qqStarting) return this.qqStarting;
    const task = this.doStartQq()
      .catch(async (error: unknown) => {
        const detail = errorMessage(error);
        if (!this.disposed) this.log.warn(`QQ 通道启动失败：${detail}`);
        if (!this.disposed) {
          this.store.sendToast("warning", vscode.l10n.t("QQ 通道启动失败：{0}", detail));
          this.pushQqStatus(false, detail);
        }
        // 半启动的现场必须收干净：不留 adapter 连接或扫码绑定残留。
        await this.stopQq().catch(() => undefined);
      })
      .finally(() => {
        this.qqStarting = null;
      });
    this.qqStarting = task;
    return task;
  }

  /**
   * 读设置 → 校验 → 建 IPC / 服务 / bridge。
   *
   * `enabled=false` 时只读一次配置就返回（不产生任何进程）；校验里有 error
   * 级问题时**一个零件都不启动**，只提示 —— 半启动的通道比不启动更难排查。
   */
  private async doStartQq(): Promise<void> {
    if (this.qq) return;
    const generation = this.qqGeneration;
    const io = this.qqIo();
    const snapshot = await readQqSettings(io);
    const { config, warnings } = normalizeQqConfig({ ...snapshot } as Record<string, unknown>);
    for (const warning of warnings) this.log.warn(`QQ 设置：${warning}`);
    if (!config.enabled) {
      this.log.info("QQ 通道未启用，跳过启动");
      return;
    }

    const roots = this.qqWorkspaceRoots();
    const issues = validateQqConfig(config, roots);
    for (const issue of issues) {
      const line = `QQ 配置${issue.severity === "error" ? "错误" : "提示"}（${issue.code}）：${issue.message}`;
      if (issue.severity === "error") this.log.warn(line);
      else this.log.info(line);
    }
    const errors = issues.filter((issue) => issue.severity === "error");
    if (errors.length > 0) {
      const first = errors[0]!;
      this.store.sendToast("warning", vscode.l10n.t("QQ 通道未启动：{0}", first.message));
      this.pushQqStatus(false, first.message);
      return;
    }

    // 硬门控：workspace 必须落在当前工作区根（远程任务由主仓 worktree 执行）。
    const gateIssues = checkQqStartupGate(config, this.superRepoRoot());
    if (gateIssues.length > 0) {
      const first = gateIssues[0]!;
      this.log.warn(`QQ 配置错误（${first.code}）：${first.message}`);
      this.store.sendToast("warning", vscode.l10n.t("QQ 通道未启动：{0}", first.message));
      this.pushQqStatus(false, first.message);
      return;
    }

    await this.startQqBotChannel(config, io, generation);
  }

  // --- QQBot 官方路线（M3-C）-----------------------------------------------

  /**
   * QQBot 官方通道的常规启动：不建 IPC、不 spawn bridge、不下载外部组件。
   *
   * 用 SecretStorage 里扫码写入的 appId/appSecret 建官方 adapter，入站事件
   * 经 `setEventCallback` 直接进 QqService，出站由 adapter.send 完成。没有
   * 凭据时如实提示先绑定，绝不退化成其它通道。
   */
  private async startQqBotChannel(
    config: QqConfig,
    io: QqSettingsIo,
    generation: number,
  ): Promise<void> {
    const creds = await readQqBotCredentials(io);
    if (!creds) {
      const detail = "QQBot 尚未扫码绑定，请先在设置页完成扫码绑定";
      this.store.sendToast("warning", vscode.l10n.t(detail));
      this.pushQqStatus(false, detail);
      this.postToWebview(qrFailureMessage(detail));
      return;
    }

    const root = path.join(
      this.context.storageUri?.fsPath ?? this.context.globalStorageUri.fsPath,
      "qq",
    );
    const taskStore = new QqTaskStore(root);
    const service = new QqService({
      config,
      store: taskStore,
      host: createQqServiceHost(this.createQqHostPorts()),
      log: (line) => this.log.info(line),
    });
    const deps = this.services.qqbotDeps ?? {};
    const dispatch = createQqChannelDispatch(config, {
      appId: creds.appId,
      appSecret: creds.appSecret,
      onInbound: (msg) => {
        const live = this.qq?.service;
        if (!live) return;
        void live.handleInboundMessage(msg).catch((error: unknown) => {
          this.log.warn(`QQBot 入站处理失败：${errorMessage(error)}`);
        });
        this.refreshQqTasks();
      },
      log: (line) => this.log.info(line),
      ...(deps.transport ? { transport: deps.transport } : {}),
      ...(deps.adapterFactory ? { adapterFactory: deps.adapterFactory } : {}),
      ...(deps.gatewayUrl ? { gatewayUrl: deps.gatewayUrl } : {}),
    });
    const owner: NonNullable<ChatPanel["qq"]> = {
      service,
      store: taskStore,
      config,
      io,
      qqbot: { adapter: dispatch.adapter },
    };
    this.qq = owner;
    try {
      await dispatch.adapter.connect();
      if (generation !== this.qqGeneration || this.disposed) {
        if (this.qq === owner) this.qq = undefined;
        await this.disposeQqOwner(owner);
        return;
      }
      await service.start();
    } catch (error) {
      if (this.qq === owner) this.qq = undefined;
      await this.disposeQqOwner(owner);
      throw error;
    }
    if (generation !== this.qqGeneration || this.disposed) {
      if (this.qq === owner) this.qq = undefined;
      await this.disposeQqOwner(owner);
      return;
    }
    this.pushQqStatus(true, "QQBot 官方网关已连接");
    this.refreshQqTasks();
    this.log.info("QQBot 官方通道已启动（无 bridge / 无外部托管进程）");
  }

  /** 当前 QQ 配置（测试 IO 优先，读失败回默认）。 */
  private async currentQqConfig(): Promise<QqConfig> {
    const snapshot = await readQqSettings(this.qqIo());
    const { config } = normalizeQqConfig({ ...snapshot } as Record<string, unknown>);
    return config;
  }

  /** 停掉在飞的扫码会话（幂等；成功/失败/stop 都调用）。 */
  private stopQqBotBinding(): void {
    const binding = this.qqbotBinding;
    this.qqbotBinding = null;
    if (this.qq?.qqbot?.bindSession) {
      this.qq.qqbot.bindSession.stop();
      this.qq.qqbot.bindSession = undefined;
    }
    binding?.stop();
  }

  /**
   * 官方扫码绑定：协议 → 会话 → webview 消息 / 凭据落盘 → 启动官方通道。
   * 这条路径完全不碰外部托管进程的下载、端口探测与 manager。
   */
  private async startQqBotBind(config: QqConfig): Promise<void> {
    if (this.disposed) return;
    this.stopQqBotBinding();
    const runtime = createQqBotBindRuntime(this.services.qqbotDeps?.bind ?? {});
    this.qqbotBinding = runtime.session;
    this.postManagedStatus({ phase: "checking", message: "正在获取 QQBot 登录二维码" });
    try {
      await runtime.session.start({
        onQr: (dataUrl, expiresAt) => {
          if (this.disposed) return;
          this.postToWebview(sanitizeQrLoginMessage(qrReadyMessage(dataUrl, expiresAt)));
          this.postManagedStatus({ phase: "waiting_login", message: "请用 QQ 扫码绑定机器人" });
        },
        onProgress: (phase) => {
          if (this.disposed) return;
          this.postToWebview(qrProgressMessage(phase));
        },
        onSuccess: (creds) => {
          if (this.disposed) return;
          void this.onQqBotBound(creds, config);
        },
        onFailure: (message) => {
          if (this.disposed) return;
          this.stopQqBotBinding();
          this.postToWebview(qrFailureMessage(message));
        },
      });
    } catch (error) {
      this.stopQqBotBinding();
      this.postToWebview(qrFailureMessage(errorMessage(error)));
    }
  }

  /** 扫码成功：凭据写 SecretStorage → 停扫码 → 重建官方通道。 */
  private async onQqBotBound(creds: Parameters<typeof storeQqBotCredentials>[1], config: QqConfig): Promise<void> {
    try {
      const io = this.qqIo();
      await storeQqBotCredentials(io, creds);
      this.stopQqBotBinding();
      if (this.qq) await this.stopQq();
      await this.startQqBotChannel(config, io, this.qqGeneration);
      this.postManagedStatus({ phase: "logged_in", message: "QQBot 绑定成功，官方网关已连接" });
      await this.pushQqSettings();
    } catch (error) {
      this.stopQqBotBinding();
      this.postToWebview(qrFailureMessage(errorMessage(error)));
    }
  }

  // --- 一键托管 / 窗口内扫码（Wave5-C）------------------------------------

  /** QQ 设置 IO：测试注入优先，否则用真实 vscode 实现。 */
  private qqIo(): QqSettingsIo {
    return this.services.qqSettingsIo ?? createVscodeQqSettingsIo(this.context.secrets);
  }

  /** 扫码阶段 → qqManagedStatus（message 过 token 脱敏）。 */
  private postManagedStatus(status: Parameters<typeof toManagedStatusMessage>[0], token?: string): void {
    if (this.disposed) return;
    this.postToWebview(toManagedStatusMessage(status, token));
  }

  /** qqManagedSetup 消息入口：QQBot 单一路径，start 走官方扫码、stop 停扫码会话。 */
  private async handleQqManagedSetup(action: "start" | "stop"): Promise<void> {
    if (action === "stop") {
      this.stopQqBotBinding();
      if (!this.disposed) {
        this.postToWebview({ type: "qqManagedStatus", phase: "idle", message: "QQBot 扫码已停止" });
      }
      return;
    }
    const config = await this.currentQqConfig();
    await this.startQqBotBind(config);
  }

  /** 停掉整条通道（QQBot adapter → 服务），每一项都有 2s 上限。 */
  private async stopQq(): Promise<void> {
    // 任何停止意图都必须让在飞的启动失效 —— 哪怕这次因为已有停止在进行而
    // 直接返回：那个慢启动不能在 stop 之后把一份陈旧通道装回 this.qq。
    this.qqGeneration += 1;
    this.stopQqBotBinding();
    if (this.qqStopping) return;
    this.qqStopping = true;
    try {
      if (this.qqRestartTimer) {
        clearTimeout(this.qqRestartTimer);
        this.qqRestartTimer = null;
      }
      const owner = this.qq;
      this.qq = undefined;
      if (!owner) return;
      await this.disposeQqOwner(owner);
      this.pushQqStatus(false, "QQ 通道已停止");
    } finally {
      this.qqStopping = false;
    }
  }

  /**
   * 只拆**这一份** owner（QQBot adapter → 服务）。
   *
   * 与 stopQq 分开是为了「启动途中被停用」那条路径：那时 `this.qq` 可能已经
   * 属于另一份现场（或已被 stopQq 清空），我们不能用 stopQq 去动它，只能把
   * 自己造出来的这份拆干净。
   */
  private async disposeQqOwner(owner: NonNullable<ChatPanel["qq"]>): Promise<void> {
    // 关 adapter（socket + 心跳）；扫码会话由 stopQqBotBinding 负责停。
    this.stopQqBotBinding();
    await this.raceQqTeardown(owner.qqbot.adapter.close());
    await this.raceQqTeardown(owner.service.stop());
  }

  /** 单项收尾的硬上限：一个卡住的 socket 不能拖住窗口关闭。 */
  private async raceQqTeardown(work: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, QQ_BRIDGE_STOP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async restartQq(): Promise<void> {
    // 先等在飞的启动落定：否则 startQqIfEnabled 会把它那个（即将被作废的）
    // promise 直接还给我们，重启就成了空转。
    const inFlight = this.qqStarting;
    if (inFlight) await inFlight.catch(() => undefined);
    await this.stopQq();
    await this.startQqIfEnabled();
  }

  /** 500ms 防抖的整服务重启（settings.json 一次编辑会触发多帧事件）。 */
  private scheduleQqRestart(): void {
    if (this.qqRestartTimer) clearTimeout(this.qqRestartTimer);
    this.qqRestartTimer = setTimeout(() => {
      this.qqRestartTimer = null;
      if (this.disposed) return;
      void this.restartQq().catch((error: unknown) => {
        const detail = errorMessage(error);
        this.log.warn(`QQ 服务重启失败：${detail}`);
        this.store.sendToast("warning", vscode.l10n.t("QQ 服务重启失败：{0}", detail));
      });
    }, QQ_SETTINGS_RESTART_DEBOUNCE_MS);
    this.qqRestartTimer.unref?.();
  }

  // --- QQ 入口校验工具 -------------------------------------------------------
  //
  // 收敛到 QQBot 单一路径后，入站消息由 setEventCallback 直接给出已归一化的
  // InboundMessage，下面两个校验工具不再被 live 路径调用；保留为 public 供
  // 既有接线测试使用。

  isQqRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  isQqTaskAction(value: unknown): value is QqTaskAction {
    return (
      value === "approve" ||
      value === "deny" ||
      value === "answer" ||
      value === "stop" ||
      value === "merge" ||
      value === "discard" ||
      value === "refresh"
    );
  }

  /**
   * 把 wire 上的入站消息收敛成 `InboundMessage`。
   *
   * bridge 是另一个进程：坏帧不能用 `as` 硬转 —— 缺 `attachments` 会让服务
   * 在 `.map` 上直接抛错。这里逐字段兜底，`mentionsBot` 只在明确为 true 时算
   * true（无法证明被 @ 就不算，群聊会因此静默丢弃，这是安全的一侧）。
   */
  coerceQqInboundMessage(value: unknown): InboundMessage | null {
    if (!this.isQqRecord(value)) return null;
    const chatType = value["chatType"];
    if (chatType !== "private" && chatType !== "group") return null;
    const chatId = value["chatId"];
    const senderId = value["senderId"];
    const msgId = value["msgId"];
    const text = value["text"];
    if (
      typeof chatId !== "string" ||
      typeof senderId !== "string" ||
      typeof msgId !== "string" ||
      typeof text !== "string"
    ) {
      return null;
    }
    const rawAttachments = value["attachments"];
    const attachments = Array.isArray(rawAttachments)
      ? rawAttachments.filter(
          (item): item is InboundMessage["attachments"][number] =>
            this.isQqRecord(item) &&
            (item["kind"] === "image" || item["kind"] === "file"),
        )
      : [];
    const timestamp = value["timestamp"];
    return {
      chatType,
      chatId,
      senderId,
      msgId,
      text,
      mentionsBot: value["mentionsBot"] === true,
      attachments,
      timestamp: typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : Date.now(),
    };
  }

  // --- QQ 宿主端口（QqServiceHost 的实现在这里） -----------------------------

  /**
   * 把面板能力映射成 `QqHostPorts`。
   *
   * 取消 / 合并 / 丢弃全部复用既有的 Super Agent 方法（`cancel` /
   * `requestSuperMerge` / `cleanup`），本模块**不写第二套 git 逻辑**。
   */
  private createQqHostPorts(): QqHostPorts {
    return {
      workspaceRoots: () => this.qqWorkspaceRoots(),

      spawnTask: (spec, opts) => {
        const manager = this.getSuperAgent();
        if (!manager) throw new Error("Super Agent 不可用（未打开工作区）");
        const session = manager.spawn(
          { title: spec.title, task: spec.task },
          {
            policy: {
              approval: opts.approval,
              disallowedTools: opts.disallowedTools,
              onPermissionRequest: opts.onPermission,
            },
          },
        );
        // spawn 是同步登记：worktree 与分支在 prepare 里才落地，此刻可能还
        // 没有 branch —— 缺省即可，最终结果由 readSuper 里的分支补齐。
        const branch = session.isolation.branch;
        return branch
          ? { superSessionId: session.id, branch }
          : { superSessionId: session.id };
      },

      /**
       * 等子会话收尾。
       *
       * **为什么是轮询**：`SuperAgentManager` 只暴露一个 `onSessionsChanged`
       * 回调（面板已经用来把投影写进 store），没有按订阅者分发的事件面；
       * 为 QQ 通道去改它的公开接口会把「一次 emit → N 个监听」的生命周期
       * 复杂度带进管理层。轮询 store 里的投影是零侵入的那条路。
       *
       * 上限：调用方（适配器）本来就有 2h 兜底；这里再封一层，保证即便被
       * 单独调用也不会永远挂着。子会话曾被看到、之后又消失 = 被清理，直接
       * 返回；从未被任何一方看到 = id 无效，抛错让服务记 failed。
       */
      waitForSettle: async (superSessionId, timeoutMs) => {
        const cap =
          typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
            ? Math.min(timeoutMs, QQ_DEFAULT_SETTLE_TIMEOUT_MS)
            : QQ_DEFAULT_SETTLE_TIMEOUT_MS;
        const deadline = Date.now() + cap;
        let appeared = false;
        for (;;) {
          const session = this.findQqSuperSession(superSessionId);
          if (session) {
            appeared = true;
            if (isQqTerminalSuperStatus(session.status)) return;
          } else if (appeared) {
            return;
          } else if (!this.getSuperAgent()?.get(superSessionId)) {
            throw new Error(`QQ 任务指向的子会话不存在：${superSessionId}`);
          }
          const remain = deadline - Date.now();
          if (remain <= 0) throw new QqSettleTimeoutError(superSessionId, cap);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Math.min(QQ_SETTLE_POLL_MS, remain));
            timer.unref?.();
          });
        }
      },

      cancel: async (superSessionId) => {
        const manager = this.getSuperAgent();
        if (!manager) throw new Error("Super Agent 不可用（未打开工作区）");
        // 对已终态的子会话再取消是幂等重复，管理器自己会如实返回。
        await manager.cancel(superSessionId);
      },

      /**
       * 合并回当前分支。
       *
       * 合并由**专用合并子会话**在主仓工作区里执行（冲突需要有人读代码），
       * 因此这是一个异步动作：派发成功也只回报「已派出」，合并结果稍后写进
       * 看板的 integration。**绝不**在这里谎报 ok=true。
       */
      merge: async (superSessionId) => {
        const manager = this.getSuperAgent();
        if (!manager) return { ok: false, detail: "Super Agent 不可用（未打开工作区）" };
        const session = manager.get(superSessionId);
        if (!session) return { ok: false, detail: "子会话不存在或已被清理" };
        if (session.integration?.state === "merged") {
          return { ok: true, detail: "改动已经在当前分支上" };
        }
        if (!isQqTerminalSuperStatus(session.status)) {
          return { ok: false, detail: "子会话还没结束，完成后再合并" };
        }
        if (session.isolation.kind !== "git_worktree" || !session.isolation.branch) {
          return { ok: false, detail: "该子会话没有可合并的分支（仅目录隔离）" };
        }
        const state = this.store.getState();
        if (
          state.status === "streaming" ||
          state.initializing ||
          state.replaying ||
          this.historySyncBusy
        ) {
          return { ok: false, detail: "主会话正在生成，请稍后再合并" };
        }
        await this.requestSuperMerge(superSessionId);
        return {
          ok: false,
          detail: "已派出合并子会话（异步执行），合并结果稍后在看板确认",
        };
      },

      discard: async (superSessionId) => {
        const manager = this.getSuperAgent();
        if (!manager) throw new Error("Super Agent 不可用（未打开工作区）");
        await manager.cleanup(superSessionId, { keepBranch: false });
      },

      readSuper: (superSessionId) => {
        const session = this.findQqSuperSession(superSessionId);
        if (!session) return null;
        const snapshot: QqHostSuperSnapshot = { status: session.status };
        const lastReport =
          session.reports.length > 0 ? session.reports[session.reports.length - 1] : undefined;
        // 「最后一条汇报」优先；没有汇报时退回会话摘要。都取不到就不填 ——
        // 适配器会用占位文案，绝不编造内容。
        const summary = (lastReport?.summary ?? session.summary ?? "").trim();
        if (summary.length > 0) snapshot.summary = summary;
        const branch = session.isolation.branch;
        if (branch) snapshot.branch = branch;
        if (session.integration) snapshot.merged = session.integration.state === "merged";
        return snapshot;
      },

      notify: (text) => {
        if (this.disposed) return;
        this.store.sendToast("info", text);
      },

      deliver: async (msg) => {
        const adapter = this.qq?.qqbot?.adapter;
        if (!adapter) return false; // 入口防御：通道未起 / 未绑定
        return deliverViaQqBotAdapter(adapter, msg);
      },

      bindAccount: (code, senderId) => this.bindQqAccount(code, senderId),
      unbindAccount: () => this.unbindQqAccount(),
    };
  }

  /** 子会话快照：优先 store 的投影（webview 看到的那份），再退回管理器。 */
  private findQqSuperSession(id: string): SuperSessionUi | null {
    const projected = this.store.getState().superSessions;
    const fromState = projected?.find((session) => session.id === id);
    if (fromState) return fromState;
    return this.getSuperAgent()?.get(id) ?? null;
  }

  // --- QQ 账号绑定 -----------------------------------------------------------

  /**
   * 完成一次配对：校验码 → 把发送者写进白名单 → 落盘并热更新。
   *
   * 返回的 `message` 只作本地日志（服务侧统一改写回执文案，绝不回显名单）。
   * 同一发送者重复绑定按幂等成功处理（去重，不重复占位）。
   */
  private async bindQqAccount(
    code: string,
    senderId: string,
  ): Promise<{ ok: boolean; message: string }> {
    const owner = this.qq;
    if (!owner) return { ok: false, message: "QQ 通道未启动" };
    if (!isBindCodeValid(owner.bindCode, code, Date.now())) {
      const expired = owner.bindCode !== undefined && owner.bindCode.expiresAt <= Date.now();
      return { ok: false, message: expired ? "绑定码已过期" : "绑定码无效" };
    }
    const id = senderId.trim();
    if (id.length === 0) return { ok: false, message: "缺少发送者标识" };

    const fresh = await readQqSettings(owner.io);
    const users = fresh.allowedUsers.includes(id)
      ? fresh.allowedUsers
      : [...fresh.allowedUsers, id];
    await applyQqSettingsPatch(owner.io, { allowedUsers: users });
    // 与服务共享同一个 config 对象：白名单立刻生效，不必等重启。
    owner.config.allowedUsers = users;
    await this.pushQqSettings();
    this.log.info(`QQ 账号已绑定：${id}（当前 ${users.length} 个账号）`);
    return { ok: true, message: `已绑定 ${id}` };
  }

  /** 解除绑定：清空用户白名单（群白名单不动）。 */
  private async unbindQqAccount(): Promise<{ ok: boolean; message: string }> {
    const io = this.qq?.io ?? createVscodeQqSettingsIo(this.context.secrets);
    await applyQqSettingsPatch(io, { allowedUsers: [] });
    if (this.qq) this.qq.config.allowedUsers = [];
    await this.pushQqSettings();
    return { ok: true, message: "已解除账号绑定" };
  }

  // --- QQ 设置 / 凭据 / 状态消息 --------------------------------------------

  /**
   * 设置区改动 → 落盘 + 推快照 + 同步运行中的服务。
   *
   * 落盘走 `applyQqSettingsPatch`（白名单键 + 拒绝脏值）；是否重启由
   * `syncQqServiceWithSettings` 按连接类字段判定。
   */
  private async handleQqSettingsPatch(patch: Partial<QqSettingsUi>): Promise<void> {
    const io = this.qq?.io ?? createVscodeQqSettingsIo(this.context.secrets);
    const result = await applyQqSettingsPatch(io, patch);
    if (result.ignored.length > 0) {
      this.log.warn(`QQ 设置补丁忽略了：${result.ignored.join(", ")}`);
    }
    await this.onQqSettingsChanged();
  }

  /** 凭据写入（单向：明文只进 SecretStorage，快照里只有布尔投影）。 */
  private async handleQqSecretsWrite(botToken?: string, appSecret?: string): Promise<void> {
    const io = this.qq?.io ?? createVscodeQqSettingsIo(this.context.secrets);
    const changed = await writeQqSecrets(io, { botToken, appSecret });
    if (changed.length > 0) this.log.info(`QQ 凭据已更新：${changed.join(", ")}`);
    await this.pushQqSettings();
    // 官方 adapter 持有启动时的凭据快照：换了凭据必须重建服务。
    if (changed.length > 0 && this.qq) this.scheduleQqRestart();
  }

  /** 设置页 QQ 卡片的动作。扫码登录三动作在 Wave5-C 落地：二维码桥随托管
   * 现场（this.qq）生灭，未启动时安静返回。 */
  private async handleQqConfigAction(
    action: "testConnection" | "generateBindCode" | "unbind" | "startQrLogin" | "refreshQr" | "cancelQrLogin",
  ): Promise<void> {
    switch (action) {
      case "testConnection": {
        const adapter = this.qq?.qqbot?.adapter;
        if (!adapter) {
          this.pushQqStatus(false, "QQBot 未连接");
          return;
        }
        const health = await adapter.health();
        this.pushQqStatus(
          health.connected,
          health.connected
            ? vscode.l10n.t("QQBot 官方网关已连接")
            : vscode.l10n.t("QQBot 未连接（{0}）", String(health.detail ?? "")),
        );
        return;
      }
      case "generateBindCode": {
        if (!this.qq) {
          this.store.sendToast("warning", vscode.l10n.t("QQ 通道未启动，无法生成绑定码"));
          return;
        }
        const bind = generateBindCode();
        this.qq.bindCode = bind;
        this.postToWebview({ type: "qqBindCode", code: bind.code, expiresAt: bind.expiresAt });
        this.store.sendToast("info", vscode.l10n.t("绑定码已生成，5 分钟内有效"));
        return;
      }
      case "unbind": {
        const result = await this.unbindQqAccount();
        this.store.sendToast(result.ok ? "info" : "warning", result.message);
        return;
      }
      case "startQrLogin": {
        const config = this.qq?.config ?? (await this.currentQqConfig());
        await this.startQqBotBind(config);
        return;
      }
      case "refreshQr": {
        // QQBot 扫码会话不可原地刷新：重新发起一次扫码绑定。
        const config = this.qq?.config ?? (await this.currentQqConfig());
        await this.startQqBotBind(config);
        return;
      }
      case "cancelQrLogin": {
        if (!this.qqbotBinding && !this.qq?.qqbot?.bindSession) return;
        this.stopQqBotBinding();
        this.postToWebview(buildClearedQrMessage(Date.now()));
        return;
      }
    }
  }

  /** 看板 / IPC 的任务操作：交给服务执行，然后刷新投影。 */
  private async handleQqTaskAction(
    taskId: string,
    action: QqTaskAction,
    text?: string,
  ): Promise<void> {
    const service = this.qq?.service;
    if (!service) {
      this.store.sendToast("warning", vscode.l10n.t("QQ 通道未启动"));
      return;
    }
    await service.handleTaskAction(taskId, action, text);
    this.refreshQqTasks();
  }

  /**
   * 配置变更后的统一处理：推快照 → 按需重启或热更新。
   *
   * 非连接类字段（白名单 / 策略 / 并发 / 限流 / 详略 / 自动合并）直接写进
   * 运行中的 config 对象 —— QqService 在每次使用时读它，所以即时生效且不
   * 打断在跑的任务；连接类字段交给 500ms 防抖的重启。
   */
  private async onQqSettingsChanged(): Promise<void> {
    if (this.disposed) return;
    await this.pushQqSettings();
    await this.syncQqServiceWithSettings();
    this.refreshQqTasks();
  }

  private async syncQqServiceWithSettings(): Promise<void> {
    if (this.disposed) return;
    const io = this.qq?.io ?? createVscodeQqSettingsIo(this.context.secrets);
    const snapshot = await readQqSettings(io);
    const { config, warnings } = normalizeQqConfig({ ...snapshot } as Record<string, unknown>);
    for (const warning of warnings) this.log.warn(`QQ 设置：${warning}`);

    if (!config.enabled) {
      if (this.qq) await this.stopQq();
      this.pushQqStatus(false, "QQ 通道已停用");
      return;
    }
    if (!this.qq) {
      await this.startQqIfEnabled();
      return;
    }
    if (
      shouldRestartOnPatch(this.qq.config, {
        enabled: config.enabled,
      })
    ) {
      this.scheduleQqRestart();
      return;
    }
    // 热更新：QqService 持有的就是这个对象，改字段即改行为。
    const live = this.qq.config;
    live.allowedUsers = [...config.allowedUsers];
    live.allowedGroups = [...config.allowedGroups];
    live.workspace = config.workspace;
    live.remotePolicy = config.remotePolicy;
    live.maxConcurrentTasks = config.maxConcurrentTasks;
    live.rateLimitPerMin = config.rateLimitPerMin;
    live.resultDetail = config.resultDetail;
    live.autoMerge = config.autoMerge;
  }

  /** 面板打开 / webview 重连 / 设置变更后的一次性全量推送。 */
  private pushQqState(): void {
    this.refreshQqTasks();
  }

  /** QQ 设置快照（无明文凭据，只有 hasBotToken / hasAppSecret 布尔）。 */
  private async pushQqSettings(): Promise<void> {
    if (this.disposed) return;
    const io = this.qq?.io ?? createVscodeQqSettingsIo(this.context.secrets);
    try {
      const values = await readQqSettings(io);
      this.postToWebview({ type: "qqSettings", values });
    } catch (error) {
      this.log.warn(`QQ 设置读取失败：${errorMessage(error)}`);
    }
  }

  /** 连接状态。`detail` 省略 = 沿用上一次的说明（不把它擦成空）。 */
  private pushQqStatus(connected: boolean, detail?: string): void {
    if (this.disposed) return;
    this.qqConnected = connected;
    if (detail !== undefined) this.qqLastDetail = detail;
    const message: { type: "qqStatus"; connected: boolean; detail?: string } = {
      type: "qqStatus",
      connected,
    };
    if (this.qqLastDetail !== null) message.detail = this.qqLastDetail;
    this.postToWebview(message);
  }

  /**
   * 任务看板投影：服务里的任务列表 → `SessionState.qqTasks`。
   *
   * 与 `superSessions` 一样是**非 blocks 元数据**，因此复用 store 既有的
   * 节流快照 / blockPatch 通道（`pushSnapshot`），不自建推送。
   */
  private refreshQqTasks(): void {
    if (this.disposed) return;
    const service = this.qq?.service;
    setQqTasks(this.store.getState(), service ? service.listTasks() : []);
    this.store.pushSnapshot();
    // 「一次刷新 = 三样都推」：看板条目变化往往伴随状态/设置变化（桥接上、
    // 任务新建），分开推只会让设置卡与看板短暂不同步。读设置是内存 + 一次
    // SecretStorage 探测，QQ 消息频率下这点开销可以忽略。
    void this.pushQqSettings();
    this.pushQqStatus(this.qqConnected);
  }

  private qqWorkspaceRoots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  }

  /**
   * 批量清理的**唯一一条**回执。
   *
   * 看板的「清理已结束」一次清一整批；旧实现让 host 逐个 `cleanup`，于是
   * 用户看到 N 条一模一样的「已清理子会话」，既不知道整批到哪了、也不知道
   * 有没有失败。这里按真实聚合结果措辞：全部成功才说「已清理 N 个」，
   * 有失败一律 warning 级并给出未能清理的数量，分支被保留时如实补一句 ——
   * **绝不谎报全部成功**。
   */
  private reportSuperCleanupBatch(cleaned: number, failed: number, branchesKept: number): void {
    if (cleaned === 0 && failed === 0) return;
    if (failed === 0) {
      if (branchesKept === 0) {
        this.store.sendToast("info", vscode.l10n.t("已清理 {0} 个子会话", cleaned));
      } else {
        this.store.sendToast(
          "info",
          vscode.l10n.t("已清理 {0} 个子会话，{1} 个分支已保留", cleaned, branchesKept),
        );
      }
      return;
    }
    if (cleaned === 0) {
      this.store.sendToast("warning", vscode.l10n.t("未能清理这 {0} 个子会话", failed));
      return;
    }
    if (branchesKept === 0) {
      this.store.sendToast(
        "warning",
        vscode.l10n.t("已清理 {0} 个子会话，{1} 个未能清理", cleaned, failed),
      );
    } else {
      this.store.sendToast(
        "warning",
        vscode.l10n.t(
          "已清理 {0} 个子会话，{1} 个未能清理，{2} 个分支已保留",
          cleaned,
          failed,
          branchesKept,
        ),
      );
    }
  }

  /**
   * The board's merge button asks the AGENT to merge.
   *
   * The merge is done by a **dedicated child session that runs in the main
   * repository workspace** (isolation kind `repo`): the host no longer runs
   * `git merge` itself (a conflict needs someone to read the code), and the
   * main session no longer merges either (it only delegates, plans and
   * reports — it must not touch git).
   *
   * A merge child has no worktree and no branch of its own: merging has to
   * happen in the workspace that holds the target branch, and its product IS
   * the merge commit on the main branch. When it finishes, the host verifies
   * with a read-only `git merge-base --is-ancestor` that the branch actually
   * landed and records the integration — reporting the truth either way
   * instead of assuming success.
   */
  private async requestSuperMerge(
    id: string,
    options?: { auto?: boolean; reason?: string },
  ): Promise<void> {
    const manager = this.getSuperAgent();
    if (!manager) return;
    const session = manager.get(id);
    if (!session) {
      this.store.sendToast("warning", vscode.l10n.t("该子会话不存在或已被清理"));
      return;
    }
    if (session.isolation.kind !== "git_worktree" || !session.isolation.branch) {
      this.store.sendToast("warning", vscode.l10n.t("该子会话没有可合并的分支（仅目录隔离）"));
      return;
    }
    if (session.integration?.state === "merged") {
      this.store.sendToast("info", vscode.l10n.t("该子会话的改动已经合并"));
      return;
    }
    if (!isTerminalSuperStatus(session.status)) {
      this.store.sendToast("warning", vscode.l10n.t("子会话还没结束，完成后再让智能体合并"));
      return;
    }
    const state = this.store.getState();
    if (
      state.initializing ||
      state.status === "streaming" ||
      state.replaying ||
      this.historySyncBusy
    ) {
      if (options?.auto) {
        // 主会话正忙着：留在队列里等它空闲。自动路径不能就此丢掉 —— 丢掉就
        // 等于把这件事又推回给用户手动点按钮，那正是这次要改掉的行为。
        this.scheduleSuperMerge(id, options.reason ?? "");
        return;
      }
      this.store.sendToast(
        "warning",
        vscode.l10n.t("主会话正在生成，等本轮结束后再让智能体合并"),
      );
      return;
    }
    if (!state.sessionId) {
      if (options?.auto) {
        this.scheduleSuperMerge(id, options.reason ?? "");
        return;
      }
      this.store.sendToast("warning", vscode.l10n.t("会话未就绪，无法让智能体合并"));
      return;
    }
    // 派一个跑在主仓工作区的合并子会话：任务书就是合并任务书本身。
    const branch = session.isolation.branch;
    const child = await manager.spawnMerge({
      source: session,
      task: buildSuperMergeRequestPrompt(session, {
        auto: options?.auto === true,
        reason: options?.reason,
      }),
      title: vscode.l10n.t("合并分支 {0}", branch),
    });
    if (!child) {
      if (options?.auto) {
        // 已有合并子会话在跑（主仓工作区没有版本隔离）：自动路径不能就此丢掉
        // —— 重新排队，等前一个合并子会话跑完再派。
        this.scheduleSuperMerge(id, options.reason ?? "");
        return;
      }
      this.store.sendToast(
        "warning",
        vscode.l10n.t("已有合并子会话在跑，等它结束后再合并：{0}", branch),
      );
      return;
    }
    this.store.sendToast(
      "info",
      options?.auto
        ? vscode.l10n.t("子会话「{0}」的改动没能自动合并，已派出合并子会话", session.title)
        : vscode.l10n.t("已派出合并子会话，合并子会话「{0}」的分支", session.title),
    );
  }

  /**
   * 排入「让智能体合并」队列并立刻尝试发起。
   *
   * 队列按子会话去重：同一个子会话只排一次（自动触发与手动点击可能撞车）。
   * 队列里排的是**待派发的合并子会话**，不是发给主会话的提示词。
   */
  private scheduleSuperMerge(id: string, reason: string): void {
    if (!this.pendingSuperMerges.some((item) => item.id === id)) {
      this.pendingSuperMerges.push({ id, reason });
    }
    void this.drainSuperMerges();
  }

  /**
   * 串行派发待合并的子会话。
   *
   * 合并必须发生在主工作区里，并发合并同一个仓库会把状态搅乱，所以一次只
   * 跑一个。主会话正忙 / 正在恢复历史时留在队列里，等空闲后由回合结束钩子
   * 再叫一次。
   *
   * 合并子会话是**异步**的（它有自己的 CLI 进程）：派出去之后本轮就结束，
   * 下一个排队的合并等它跑完（`onMergeResult` 回调）再派。
   */
  private async drainSuperMerges(): Promise<void> {
    if (this.superMergeRunning) return;
    this.superMergeRunning = true;
    try {
      while (this.pendingSuperMerges.length > 0) {
        const state = this.store.getState();
        if (
          state.status === "streaming" ||
          state.initializing ||
          state.replaying ||
          this.historySyncBusy
        ) {
          break;
        }
        // 合并子会话跑在**主仓工作区**里：主会话正忙着（哪怕还在准备阶段）
        // 时先让它走完 —— 两边同时改主仓会互相踩。
        if (this.mainLane !== null) break;
        // 汇报 turn 也占用主会话这同一条车道，等它结束（心跳会再叫我们）。
        if (this.superReportRunning) break;
        // 主仓工作区没有版本隔离：同一时刻只能有一个合并子会话在跑。
        if (this.superMergeChildRunning()) break;
        const next = this.pendingSuperMerges.shift();
        if (!next) break;
        await this.requestSuperMerge(next.id, { auto: true, reason: next.reason });
        // 合并子会话跑完才派下一个（onMergeResult 会再叫一次 drain）。
        break;
      }
    } finally {
      this.superMergeRunning = false;
    }
  }

  /**
   * 是否已有一个合并子会话在跑。
   *
   * 合并子会话跑在**主仓工作区**里（没有版本隔离）：两个合并同时改同一个
   * 工作区会把仓库状态搅乱，所以同一时刻只能有一个。
   */
  private superMergeChildRunning(): boolean {
    return (this.store.getState().superSessions ?? []).some(
      (session) =>
        session.isolation.kind === "repo" && !isTerminalSuperStatus(session.status),
    );
  }

  /** Text of an agent message chunk (the wire carries a single ContentBlock). */
  private static chunkText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      let out = "";
      for (const block of content) out += ChatPanel.chunkText(block);
      return out;
    }
    if (content && typeof content === "object") {
      const block = content as { type?: string; text?: unknown };
      if (block.type === "text" && typeof block.text === "string") return block.text;
    }
    return "";
  }

  // --- Agent lifecycle ----------------------------------------------------------

  private async ensureClient(): Promise<AcpClient> {
    // A3: never spawn a new client after the panel is gone — the handshake's
    // post-connect steps would run against a destroyed store.
    if (this.disposed) throw new DisposedError();
    if (this.client) return this.client;
    if (this.connecting) {
      return this.connecting.then(() => {
        // A3: dispose() may have settled the handshake and nulled the client
        // before this continuation runs.
        if (!this.client) throw new DisposedError();
        return this.client;
      });
    }

    this.connecting = (async () => {
      // P0-3: capture the generation so a restartCli supersession (which bumps
      // the counter and nulls `connecting`) is visible to this closure's
      // catch/finally below.
      const generation = this.connectGeneration;
      // The entry resolves synchronously (vendored fork, no probe). The node
      // probe still shells out (where.exe / node --version) and is cached.
      const nodePathConfigured = vscode.workspace.getConfiguration("iflow").get<string>("nodePath");
      let entry: string;
      let locatedNode: string | null;
      try {
        entry = this.resolveEntry();
        locatedNode = nodePathConfigured ? null : await locateNodeExecutable();
      } catch (error) {
        // Vendored CLI missing: surface it in the panel instead of leaving it
        // on the loading screen (this used to throw before the try/catch below).
        const message = errorMessage(error);
        this.log.error(message);
        this.store.markError(message);
        throw error;
      }
      // A standalone node boots the CLI ~2x faster than the Electron host
      // binary (no Chromium runtime to start); fall back to execPath when
      // none is found or iflow.nodePath is explicitly configured.
      const node = nodePathConfigured || locatedNode || process.execPath;
      if (!nodePathConfigured && !locatedNode) {
        // Silent before 2026-09-11: a stale host PATH (GUI-launched VSCode,
        // version-manager rewrites) made every spawn pay the Code.exe boot
        // (~2x slower initialize) with nothing in the log. Surface it.
        this.log.info(
          "no standalone node found — spawning the CLI with the Electron host binary (slower initialize); set iflow.nodePath to override",
        );
      }
      // Run the CLI under a renamed copy of the node binary (`iflow-rt`):
      // dev cleanup scripts (`pkill node` / `killall node`) match on the
      // process name and were killing active sessions. Concealment is
      // best-effort — any failure returns the original path (see locator).
      const runtime = await concealNodeExecutable(node, this.context.globalStorageUri.fsPath);
      const workspaceRoot =
        this.services.workspaceRoot ??
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
        this.context.extensionUri.fsPath;

      // A1: the fs callbacks (fs/read_text_file, fs/write_text_file) are
      // confined to the union of all open workspace roots — the CLI
      // legitimately edits files outside the session dir in multi-root
      // workspaces, but `..` traversal and arbitrary absolute paths are
      // rejected (see AcpClient.resolveAgentPath). The SAME roots are handed
      // to the CLI as --include-directories: its file tools validate paths
      // against `targetDir + includeDirectories` before delegating to our
      // callbacks, so the two sets must match (probed, CLI 0.5.19 bundle).
      const allowedRoots = (vscode.workspace.workspaceFolders ?? [])
        .map((f) => f.uri.fsPath)
        .filter((p) => p !== workspaceRoot);

      const { args } = buildAcpCommand(entry, allowedRoots);
      // Log the ACTUAL spawn executable (node, not buildAcpCommand's
      // process.execPath default): the old line printed buildAcpCommand's
      // command while AcpClient received `node`, so the log showed
      // "Code.exe ... entry.js" even when a standalone node was used —
      // actively misleading when debugging which CLI/host booted.
      this.log.info(
        runtime === node
          ? `spawning CLI: ${runtime} ${args.join(" ")} (cwd=${workspaceRoot})`
          : `spawning CLI: ${runtime} (renamed copy of ${node}) ${args.join(" ")} (cwd=${workspaceRoot})`,
      );

      // System-prompt override for the CLI's IFLOW_SYSTEM_MD. The template ships
      // inlined inside extension.cjs (the VSIX has no readable prompts/ dir), and
      // the CLI only accepts a file path — so materializeSystemPrompt() writes the
      // text into our own storage dir, next to context-report.json.
      // The CLI reads IFLOW_SYSTEM_MD on every startChat (probed, CLI 0.5.19
      // bundle: P0e() re-reads the file per session, session/load included), so
      // a full replacement covers new AND restored sessions — unlike the wire
      // settings.system_prompt, which the ACP adapter only applies on
      // session/new. Null guard: the CLI throws on a missing override file, so
      // never hand it a path that isn't there — a failed write simply means no
      // override (upstream template). The bundled template leans on the
      // system-prompt-refactor MOD (vendor bundle, custom.12): its
      // {{iflow:Environment Information}}/{{iflow:gitStatus}}/{{iflow:Git
      // Repository}}/{{iflow:Sandbox}} tokens are spliced from the built-in
      // template rendered moments earlier in the same startChat, so cwd / git
      // remote + HEAD SHA / platform / OS version / date / current model name
      // and the branch snapshot stay live. Without that MOD the file still
      // works, only those sections freeze (no token -> byte-identical upstream
      // behaviour). Windows-compat warning and user-memory are appended by the
      // CLI after the file body (the `h`/`v` suffixes in P0e), so the override
      // file only replaces the core template.
      const systemPromptFile = await this.materializeSystemPrompt();
      const spawnEnv: NodeJS.ProcessEnv = { IFLOW_HARNESS: "1", IFLOW_HARNESS_CONTEXT_FILE: this.contextReportFile() };
      if (systemPromptFile) spawnEnv.IFLOW_SYSTEM_MD = systemPromptFile;
      // Vendored CLI 内置 `super-agent` 工具的注册开关（工具实现以
      // `process.env.IFLOW_SUPER_TOOL === "1"` 为门控；当前 bundle 尚未包含
      // 该工具，所以这一行暂时是惰性的）。只有主会话该拿到派发能力 ——
      // 子会话的 spawnEnv 显式抹掉这个键（见 createSuperClient），否则
      // 子会话也能再派子会话。
      spawnEnv.IFLOW_SUPER_TOOL = "1";

      const client = new AcpClient(
        // Generous control-plane timeout: a CLI with many MCP servers can take
        // 30-60s+ before its first initialize response.
        // IFLOW_HARNESS=1 marks our subprocess tree so local cleanup scripts
        // can exclude it (the renamed binary only defeats name-based kills),
        // and switches on the CLI-side api-config-isolation patch — without
        // it (plain CLI / TUI / -p) the settings write-back is untouched.
        { command: runtime, args, cwd: workspaceRoot, env: spawnEnv, requestTimeoutMs: 120_000, allowedRoots, wireTap: this.wireLog.tap },
        {
          // A detached client (profile switch overlaps the new spawn with the
          // old child's teardown) must not leak its dying events into the
          // fresh session state. Same guard rationale as onExit below.
          onSessionUpdate: (n) => {
            if (this.client !== client) return;
            this.onSessionUpdate(n);
          },
          // R5: banners/noise on stdout — invisible at the default log level,
          // visible when the Output panel is set to Debug.
          onUnparseableStdout: (line) => {
            this.log.debug(`CLI stdout (unparsed): ${line.slice(0, 200)}`);
          },
          // R3: keep the last lines for crash/hang diagnostics instead of
          // discarding everything (the old `() => {}`).
          onStderr: (line) => {
            this.stderrTail.push(line);
            if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
          },
          onExit: () => {
            // Ignore exits of clients that were replaced on purpose (profile
            // switch / reconnect): their exit is expected, and marking an error
            // here would flash a global "错误" while the new CLI is connecting.
            // A stale instance exiting late must also not clobber this.client.
            if (this.disposed || this.client !== client) return;
            if (this.stderrTail.length > 0) {
              this.log.warn(`CLI stderr tail (${this.stderrTail.length} lines):\n${this.stderrTail.join("\n")}`);
            }
            // Crash tail rescue: persist whatever streamed before the CLI died
            // — the next persist point (prompt completion) will never run.
            void this.persistActiveTranscript();
            this.client = null;
            this.cancelAllApprovals(vscode.l10n.t("内核进程已退出"));
            this.cancelAllPlanExits(vscode.l10n.t("内核进程已退出，计划审批已跳过"));
            this.cancelAllPendingQuestions(vscode.l10n.t("内核进程已退出，提问已跳过"));
            this.store.markError(vscode.l10n.t("内核进程已退出，重新打开面板可重试"));
            // Async failure — the user is likely in the editor; cue it.
            this.postSound("error");
          },
          onRequestPermission: async (req: RequestPermissionRequest) => {
            // Dying client's approval cards would hang on the fresh state —
            // auto-cancel instead (the process is being torn down anyway).
            if (this.client !== client || this.disposed) {
              return { outcome: { outcome: "cancelled" } as const };
            }
            // Super Agent 内置工具（dispatch / actions）只回 ack，真正干活的是
            // 宿主；与正文围栏派发同一信任级别，直接放行、不弹卡（见
            // autoApproveSuperAgentTool）。其它工具不受影响。
            const superTool = this.autoApproveSuperAgentTool(req);
            if (superTool) return superTool;
            // M4 P1-1: the rule table answers matching requests without a card.
            // A failing pre-review must NEVER strand the agent — degrade to the
            // card (the pre-P1-1 behaviour) instead of rejecting or throwing.
            const auto = await this.preReviewApproval(req).catch((error: unknown) => {
              this.log.warn(`approval pre-review failed: ${errorMessage(error)}`);
              return null;
            });
            if (auto) return auto;
            // Re-check after the await: the client may have been torn down
            // while the policy files were read (A3 discipline).
            if (this.client !== client || this.disposed) {
              return { outcome: { outcome: "cancelled" } as const };
            }
            return this.requestPermissionFromUser(req);
          },
          onUserQuestions: (req: UserQuestionsRequest) => {
            if (this.client !== client) return Promise.resolve({ answers: {} });
            return this.userQuestionsFromAgent(req);
          },
          onExitPlanMode: async (req: ExitPlanModeRequest) => {
            // Route Plan-mode exit through the unified webview confirmation card
            // (mirrors session/request_permission) instead of a native
            // QuickPick: the card lives inside the panel where the user is
            // looking, so it can't be dismissed by a stray click the way a
            // native popup could (which silently rejected and stranded Plan mode).
            if (this.client !== client) return { approved: false, reason: "client busy" };
            return this.requestPlanExitFromUser(req);
          },
        },
      );
      // P0-3: superseded during the prelude (async node probe) — publishing
      // our client would clobber the successor's; throw before connecting so
      // the outer catch's generation guard ends this handshake silently.
      if (generation !== this.connectGeneration) {
        throw new Error("CLI restart requested while connecting");
      }
      this.client = client;
      try {
        const tInit = Date.now();
        const init = await client.connect();
        // A3: dispose() may have settled this handshake while initialize ran.
        // Throw so the catch below disposes the child and rejects `connecting`
        // — a resolved handshake would leave awaiting callers holding a
        // client that dispose() is about to kill.
        if (this.disposed) throw new DisposedError();
        // P0-3: restartCli superseded this handshake while initialize ran —
        // abandon before authenticate/session work races the successor's own
        // post-handshake sequence on the shared store.
        if (generation !== this.connectGeneration) {
          throw new Error("CLI restart requested while connecting");
        }
        this.log.info(
          `initialize ok in ${Date.now() - tInit}ms: authenticated=${init.isAuthenticated ?? false}, loadSession=${init.agentCapabilities.loadSession ?? false}`,
        );
        // Explicit credentials from a profile switch take priority; otherwise
        // the profile THIS workspace last activated; otherwise the global
        // active slot.
        const explicitSwitch = this.pendingHandshakeCredentials !== null;
        let workspaceRestored = false;
        let storedCreds: OpenAiCompatCredentials | null = this.pendingHandshakeCredentials;
        this.pendingHandshakeCredentials = null;
        if (!storedCreds) {
          storedCreds = await this.resolveWorkspaceHandshakeCreds();
          workspaceRestored = storedCreds !== null;
        }
        if (!storedCreds) storedCreds = await loadCredentials(this.context.secrets);
        // A profile switch must ALWAYS re-push authenticate: the CLI caches
        // auth across spawns and reports isAuthenticated=true for the PREVIOUS
        // profile's endpoint (observed: BUZZ→商汤 switch skipped authenticate,
        // prompts hit the BUZZ gateway with SenseTime models → model_not_found).
        // A workspace-restored profile forces it too: a cold child reads the
        // shared ~/.iflow/settings.json at startup, so its isAuthenticated=true
        // can reflect the TERMINAL CLI's config rather than this workspace's
        // remembered profile — trusting it would show profile A while running
        // profile B (same class of stale flag as above).
        if (!init.isAuthenticated || explicitSwitch || workspaceRestored) {
          // M3 flow: push stored openai-compatible credentials to the agent.
          if (storedCreds) {
            try {
              // The CLI's authenticate consults ~/.iflow/oauth_creds.json
              // first; an expired cache (iFlow OAuth login is retired —
              // hardcoded 2026-04-16 deadline in the 0.5.19 bundle) makes it
              // block ~60s on a dead Google OAuth refresh before the
              // swallowed exception falls through to openai-compatible auth
              // (probed: 63962ms with the file vs 210ms archived aside).
              // Archive it once, reversibly — never delete.
              const archived = retireStaleOAuthCreds();
              if (archived) this.log.info(`archived stale OAuth credential cache: ${archived}`);
              const tAuth = Date.now();
              await client.authenticate({
                methodId: "openai-compatible",
                methodInfo: {
                  apiKey: storedCreds.apiKey,
                  baseUrl: storedCreds.baseUrl,
                  modelName: storedCreds.modelName,
                },
              });
              this.log.info(`authenticate ok in ${Date.now() - tAuth}ms (openai-compatible)`);
              this.store.setAuth(await this.buildAuthState(true, false));
            } catch (error) {
              const message = errorMessage(error);
              this.log.error(`authenticate failed: ${message}`);
              this.store.setAuth(await this.buildAuthState(false, true));
              this.store.markError(vscode.l10n.t("认证失败：{0}", message));
              // Async failure — the user is likely in the editor; cue it.
              this.postSound("error");
              this.store.markConnected();
              return; // session cannot start; setup banner is the remedy
            }
          } else {
            this.store.setAuth(await this.buildAuthState(false, true));
            this.store.markConnected();
            return; // no credentials yet — setup banner guides the user
          }
        } else {
          this.store.setAuth(await this.buildAuthState(true, false));
        }
        // P0-3: authenticate can itself take minutes on a wedged endpoint; a
        // restart that landed during it must not have this generation mark the
        // store connected or start sessions — the successor owns the UI now.
        if (generation !== this.connectGeneration) {
          throw new Error("CLI restart requested while connecting");
        }
        this.store.markConnected();
        // Startup session strategy (iflow.restoreLastSession): by default open
        // on a NEW session — the panel is usable as soon as session/new
        // returns; previous sessions stay in the switcher for manual restore.
        // With the setting on (and a restorable record) the last session is
        // replayed instead. A hot restart (restartCli) always restores the
        // CURRENT session via restartRestoreId, overriding the setting for
        // exactly one handshake. (The old flow always restored, which blocked
        // first paint on session/load + transcript replay.)
        const restartTarget = this.restartRestoreId;
        this.restartRestoreId = null;
        // Profile switches default to a NEW session — the abandoned session
        // belongs to the OLD credentials endpoint. A switch made with the
        // keepSession choice arms restartRestoreId (same one-handshake
        // override as restartCli), and restartTarget already outranks the
        // explicitSwitch guard, so the restore wins for exactly that
        // handshake.
        let restoreTarget: string | undefined = restartTarget ?? undefined;
        if (
          !restoreTarget &&
          !explicitSwitch &&
          vscode.workspace.getConfiguration("iflow").get<boolean>("restoreLastSession", false)
        ) {
          // The active slot is overwritten by EVERY startNewSession — including
          // the panel-open auto session that never received a prompt (its
          // transcript only lands with the first completed turn). Restoring
          // that husk always fails on hasPersistedTranscript and silently
          // fell through to a new session (user-reported: setting on, still a
          // fresh chat). Fall back to the most recently used session that
          // actually owns a transcript.
          const active = await this.context.workspaceState.get<string | null>(ACTIVE_SESSION_KEY, null);
          if (active && this.hasPersistedTranscript(active)) {
            restoreTarget = active;
          } else {
            if (active) {
              this.log.info(
                `active session ${active} has no persisted transcript; falling back to the most recent restorable session`,
              );
            }
            const restorable = this.readPersistedSessions()
              .filter((s) => this.hasPersistedTranscript(s.id))
              .sort((a, b) => b.updatedAt - a.updatedAt);
            restoreTarget = restorable[0]?.id;
          }
        }
        const restored =
          !!restoreTarget &&
          (await this.restoreSession(restoreTarget).catch((error: unknown) => {
            this.log.error(`startup session restore failed: ${errorMessage(error)}`);
            return false;
          }));
        if (!restored) {
          await this.startNewSession();
        }
        // History list in the background: prune dead entries + push the
        // switcher list without touching activeSessionId. Fire-and-forget —
        // failures only degrade the switcher.
        void this.refreshSessionList().catch((error) => {
          this.log.warn(`session list refresh failed: ${errorMessage(error)}`);
        });
      } catch (error) {
        // C5: second safety net — connect() kills the child when initialize
        // itself fails, but a failure in the post-handshake steps (restore,
        // prune, new session) leaves a healthy child with no owner. dispose()
        // is idempotent, so this is safe even after connect()'s own cleanup.
        void client.dispose().catch(() => {});
        // P0-3: restartCli already owns the recovery — the successor handshake
        // runs with its own error/status handling. Touching shared state here
        // (client, restartRestoreId, store error) would clobber it mid-flight;
        // the wedged child above is all this generation still owns.
        if (generation !== this.connectGeneration) {
          this.log.info("superseded handshake aborted by CLI restart");
          throw error;
        }
        this.client = null;
        // Consume a pending restart-restore target: a failed handshake must
        // not leak the id into the NEXT successful handshake (e.g. a profile
        // switch, which deliberately never restores history).
        this.restartRestoreId = null;
        // A3: the handshake bailed on the disposed flag (window close during
        // initialize) — the store is destroyed, so there is nothing to mark.
        // The child above still needs killing; the rest is skipped. Surface
        // DisposedError rather than the raw JSON-RPC "Client disposed" error
        // so ensureClient's rejection matches its other disposed checkpoints.
        if (this.disposed) throw new DisposedError(errorMessage(error));
        this.store.setAuth(await this.buildAuthState(false, true));
        const message = errorMessage(error);
        this.log.error(`connect failed: ${message}`);
        this.store.markError(message);
        // Async failure — the user is likely in the editor; cue it.
        this.postSound("error");
        throw error;
      } finally {
        // P0-3: `connecting` now belongs to the successor handshake (restartCli
        // nulled it before spawning the replacement) — only the current
        // generation may clear it, or it would erase the successor's promise.
        if (generation === this.connectGeneration) this.connecting = null;
      }
    })();

    return this.connecting.then(() => this.client!);
  }

  // The vendored fork (scripts/vendor-cli.mjs) is the ONLY execution body —
  // no local-CLI probing, no env/settings override (the loader patches live
  // only in that bundle; see resolveVendoredEntry). entryOverride stays as
  // the test seam for the mock ACP agent. Synchronous by design: a single
  // existsSync inside the package, nothing to await.
  private resolveEntry(): string {
    const override = this.services.entryOverride;
    if (override) return path.resolve(override);
    const vendoredCliDir = path.join(this.context.extensionPath, "vendor", "iflow-cli");
    // Seed missing ~/.iflow/ rule configs (loader externals). Idempotent:
    // existing user files are never overwritten, so running on every
    // connect is safe. Best effort — failures never block the connect.
    ensureIflowDefaultConfigs(path.join(this.context.extensionPath, "vendor", "iflow-defaults"));
    // Sync the setting-owned thinking-capability rules into the (seeded)
    // ~/.iflow/thinking-models.json right after seeding, so a first-ever
    // connect lands the mainstream defaults next to the template rules.
    this.applyThinkingModelRules();
    // Restore the exec bit on vendored binaries (ripgrep) — the VSIX zip
    // chain drops unix mode bits and the CLI's search tools then fail with
    // EACCES when spawning rg (seen on 1.2.3 / macOS).
    ensureVendorBinariesExecutable(vendoredCliDir);
    try {
      return resolveVendoredEntry(this.context.extensionPath);
    } catch (error) {
      throw new Error(
        vscode.l10n.t("内核缺失，扩展包不完整，请重新安装：{0}", errorMessage(error)),
      );
    }
  }

  /**
   * Merge the `iflow.thinkingModelRules` setting into the CLI's
   * ~/.iflow/thinking-models.json — the file the vendored fork's
   * thinking-model-loader reads AT CLI STARTUP (config rules take
   * precedence over built-ins, first pattern match wins; enable path of
   * session/set_think rejects models the table does not mark as
   * thinking-capable). Additive only: missing patterns append, gate-only
   * entries update in place when fields differ, entries with hand-authored
   * request-DSL are NEVER clobbered, and unparseable existing JSON is kept
   * with a warning. Toasts only when something actually changed, so
   * repeat connects (warmStart included) stay quiet.
   */
  private applyThinkingModelRules(): void {
    try {
      const raw = vscode.workspace.getConfiguration("iflow").get<Array<unknown>>("thinkingModelRules", []);
      const rules = sanitizeThinkingRules(raw);
      if (rules.length === 0) return;
      const result = applyThinkingRules(rules);
      if (result.skippedInvalid) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t("思考能力规则同步失败：本机 iFlow 配置里的思考能力规则格式有误，已保留原文件"),
        );
        return;
      }
      if (result.added + result.changed > 0) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t("已同步 {0} 条思考能力规则到本机 iFlow 配置，下次会话启动时生效", result.added + result.changed),
        );
      }
    } catch {
      // best effort — never block the connect path
    }
  }

  // --- Mode / model switching ---------------------------------------------------
  // Wire behavior (probed, CLI 0.5.19): both return `{success, currentModeId |
  // currentModelId}` and the agent does NOT emit `current_mode_update`, so the
  // response must be written back into the store or the dropdown snaps back.

  /**
   * Push the panel's authoritative mode to the CLI before a turn starts.
   *
   * The CLI keeps the mode only in `Config.approvalMode` and never notifies us
   * (no `current_mode_update`), so the panel's copy is an optimistic echo that
   * nothing used to re-sync. Two drift faces were observed in real sessions:
   * - stopping a pending Plan-exit card left the composer showing 计划 while
   *   the CLI had left Plan mode, so the agent silently gained write access
   *   (session 439fd54b: the next "继续" turn's `replace`/`write_file` all
   *   completed even though `write_file` had just been rejected with
   *   "Cannot execute write_file in PLAN mode");
   * - after approving a plan the CLI could stay in Plan mode while the panel
   *   showed the return mode (same transcript family: every edit rejected).
   *
   * Pushing the stored mode right before each prompt makes the CLI follow what
   * the user sees; pushing the mode it already holds is a no-op CLI-side. A
   * failure here must never block the prompt — the turn still runs as before.
   */
  private async assertModeForPrompt(client: AcpClient, sessionId: string): Promise<void> {
    const modeId = this.store.getState().modes?.currentModeId;
    if (!modeId) return;
    try {
      await client.setMode(sessionId, modeId);
    } catch (error) {
      this.log.warn(`mode re-assert failed (${modeId}): ${errorMessage(error)}`);
    }
  }

  private async setMode(modeId: string): Promise<void> {
    if (this.historySyncBusy) return;
    const sessionId = this.store.getState().sessionId;
    // C2: an empty sessionId would make the CLI bind the mode to a bogus
    // session — refuse until a session actually exists.
    if (!sessionId) {
      vscode.window.showWarningMessage(vscode.l10n.t("会话未就绪"));
      return;
    }
    try {
      // Capture the mode we're leaving so plan approval can switch back to it.
      const modesBefore = this.store.getState().modes;
      if (modesBefore) {
        if (modesBefore.currentModeId === modeId) {
          // no-op switch; keep existing memo
        } else if (modesBefore.availableModes.find((m) => m.id === modeId)?.kind === "plan") {
          this.planReturnModeId = modesBefore.currentModeId;
        } else {
          this.planReturnModeId = null;
        }
      }
      const resp = (await this.client?.setMode(sessionId, modeId)) as
        | { success?: boolean; currentModeId?: string }
        | undefined;
      if (resp?.success && resp.currentModeId) {
        const modes = this.store.getState().modes;
        if (modes) this.store.sessionMeta({ modes: { ...modes, currentModeId: resp.currentModeId } });
        return;
      }
      vscode.window.showWarningMessage(
        vscode.l10n.t("切换模式失败：{0}", JSON.stringify(resp ?? vscode.l10n.t("无响应"))),
      );
    } catch (error) {
      vscode.window.showWarningMessage(
        vscode.l10n.t("切换模式失败：{0}", errorMessage(error)),
      );
    }
  }

  private async setModel(modelId: string): Promise<void> {
    if (this.historySyncBusy) return;
    const sessionId = this.store.getState().sessionId;
    // C2: same empty-sessionId guard as setMode.
    if (!sessionId) {
      vscode.window.showWarningMessage(vscode.l10n.t("会话未就绪"));
      return;
    }
    try {
      const resp = (await this.client?.setModel(sessionId, modelId)) as
        | { success?: boolean; currentModelId?: string }
        | undefined;
      if (resp?.success && resp.currentModelId) {
        this.store.sessionMeta({ currentModelId: resp.currentModelId });
        await this.rememberWorkspaceModel(resp.currentModelId);
        return;
      }
      vscode.window.showWarningMessage(
        vscode.l10n.t("切换模型失败：{0}", JSON.stringify(resp ?? vscode.l10n.t("无响应"))),
      );
      // Keep the dropdown consistent with the agent's actual model.
      this.store.pushSnapshot();
    } catch (error) {
      vscode.window.showWarningMessage(
        vscode.l10n.t("切换模型失败：{0}", errorMessage(error)),
      );
      this.store.pushSnapshot();
    }
  }

  private async applyThinkLevel(client: AcpClient, sessionId: string, level: SessionState["thinkLevel"]): Promise<void> {
    const thinkConfig = level === "fast" ? "think" : level === "balanced" ? "megathink" : level === "deep" ? "ultrathink" : undefined;
    if (level === "auto") return;
    try {
      const resp = (await client.setThink(sessionId, true, thinkConfig)) as
        | { success?: boolean; currentThinkEnabled?: boolean; currentThinkConfig?: string }
        | undefined;
      if (!resp?.success) {
        this.log.warn(`failed to reapply think level ${level} after session switch`);
      }
    } catch (error) {
      this.log.warn(`failed to reapply think level ${level}: ${errorMessage(error)}`);
    }
  }

  private async setThink(level: SessionState["thinkLevel"]): Promise<void> {
    if (this.historySyncBusy) return;
    const sessionId = this.store.getState().sessionId;
    if (!sessionId) {
      vscode.window.showWarningMessage(vscode.l10n.t("会话未就绪"));
      return;
    }
    const thinkConfig = level === "fast" ? "think" : level === "balanced" ? "megathink" : level === "deep" ? "ultrathink" : undefined;
    try {
      const resp = (await this.client?.setThink(sessionId, level !== "auto", thinkConfig)) as
        | { success?: boolean; currentThinkEnabled?: boolean; currentThinkConfig?: string }
        | undefined;
      if (resp?.success) {
        const confirmed = resp.currentThinkEnabled === false
          ? "auto"
          : resp.currentThinkConfig === "ultrathink"
            ? "deep"
            : resp.currentThinkConfig === "megathink"
              ? "balanced"
              : resp.currentThinkConfig === "think"
                ? "fast"
                : level;
        this.store.sessionMeta({ thinkLevel: confirmed });
        return;
      }
      vscode.window.showWarningMessage(
        vscode.l10n.t("切换思考级别失败：{0}", JSON.stringify(resp ?? vscode.l10n.t("无响应"))),
      );
      this.store.pushSnapshot();
    } catch (error) {
      if (isThinkingUnsupportedError(error)) {
        // CLI setThink enable-path rejection: the model is not marked
        // thinking-capable in its capability table (built-ins +
        // ~/.iflow/thinking-models.json). The raw envelope ("Invalid
        // request · {"details":…}") buries the actionable advice, so
        // surface a friendly prompt — the dropdown's greyed options and
        // iflow.thinkingModelRules tell the user which models DO support
        // thinking. (Disable path never validates and never hits this.)
        void vscode.window.showWarningMessage(vscode.l10n.t("当前模型不支持思考模式，请切换模型后重试"));
      } else {
        vscode.window.showWarningMessage(
          vscode.l10n.t("切换思考级别失败：{0}", errorMessage(error)),
        );
      }
      this.store.pushSnapshot();
    }
  }

  /**
   * Validate the model about to be re-pushed on a session start (see the
   * wire-behavior note in startNewSession) against the live /models list.
   * The CLI's session/set_model does NOT validate modelId (probed, CLI 0.5.19
   * bundle: it assigns blindly and returns success), so a model delisted
   * mid-session would otherwise poison every prompt of the new session with
   * model_not_found. Returns the id to push, or null when no push is needed.
   * On a confirmed delist the dropdown falls back to the CLI's boot model
   * (or the live list head) with a visible warning — explicit degradation,
   * never a silently wrong model. An empty/failed live query cannot disprove
   * the selection (endpoint down ≠ model gone), so the push proceeds.
   */
  private async validateModelForPush(
    modelsPromise: Promise<SessionState["models"]>,
    desired: string,
    cliModelId: string | null,
  ): Promise<string | null> {
    const live = await modelsPromise.catch(() => [] as SessionState["models"]);
    if (live.length === 0) return desired;
    if (live.some((m) => m.id === desired)) return desired;
    const fallback = cliModelId ?? live[0]!.id;
    this.store.sessionMeta({ currentModelId: fallback });
    void vscode.window.showWarningMessage(
      vscode.l10n.t("模型 {0} 已不在当前可用列表中，已回退为 {1}", desired, fallback),
    );
    // The CLI's boot model is already what the shared contentGeneratorConfig
    // uses — no push needed when that is the fallback.
    return fallback === cliModelId ? null : fallback;
  }

  // --- Extension-owned transcripts (M4) ------------------------------------------

  /**
   * The CLI's ACP mode does NOT write session files (verified: interactive
   * mode does, `--experimental-acp` doesn't). For "restart VSCode → get the
   * conversation back" the extension therefore persists transcripts itself —
   * one JSON file per session under storageUri (P2: the old workspaceState
   * map made every persist a read-all + clone + write-all of every session).
   */
  private transcriptDir(): string {
    // workspaceState falls back to global state when no workspace is open;
    // mirror that fallback for the file store.
    return path.join((this.context.storageUri ?? this.context.globalStorageUri).fsPath, "transcripts");
  }

  // --- System-prompt override for the CLI (IFLOW_SYSTEM_MD) ------------------

  /**
   * The system-prompt template ships as text inside extension.cjs (no readable
   * prompt files in the VSIX), but the CLI reads `IFLOW_SYSTEM_MD` from disk —
   * so materialise it in our own storage dir, the same place context-report.json
   * lives. Skips the write when the file already holds the current template.
   * Returns null on failure so the spawn omits the override instead of pointing
   * the CLI at a path that does not exist (it throws on a missing file).
   */
  private async materializeSystemPrompt(): Promise<string | null> {
    const fileUri = vscode.Uri.joinPath(this.context.storageUri ?? this.context.globalStorageUri, "system-prompt.md");
    const text = loadPrompt("system-prompt");
    try {
      let existing: Uint8Array | null;
      try {
        existing = await vscode.workspace.fs.readFile(fileUri);
      } catch {
        existing = null;
      }
      if (existing === null || Buffer.from(existing).toString("utf8") !== text) {
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(text, "utf8"));
      }
      return fileUri.fsPath;
    } catch (error) {
      this.log.warn(`system prompt override unavailable: ${errorMessage(error)}`);
      return null;
    }
  }

  // --- Auto-injected context transparency (acp-context-report Mod) ----------

  /**
   * Report file handed to the CLI as IFLOW_HARNESS_CONTEXT_FILE. The bundled
   * fork's acp-context-report Mod atomically overwrites it on every
   * startChat (session/new, session/load, approval-mode switch) with the
   * FULL request context the ACP wire never carries: assembled system
   * instruction, joined hierarchical memory, and every context file's path +
   * content. One file per window; the panel reads it at the first prompt of a
   * session, when the file holds exactly this session's startChat report.
   */
  private contextReportFile(): string {
    return path.join((this.context.storageUri ?? this.context.globalStorageUri).fsPath, "context-report.json");
  }

  private readContextReport(): { systemPrompt: string } | null {
    try {
      const raw = JSON.parse(readFileSync(this.contextReportFile(), "utf8")) as {
        version?: number;
        systemPrompt?: string | null;
      };
      if (raw.version !== 2) return null;
      return typeof raw.systemPrompt === "string" ? { systemPrompt: raw.systemPrompt } : null;
    } catch {
      return null;
    }
  }

  /**
   * Collect what the model will see beyond the user's typed text. Mod report
   * first (full body, byte-exact): the reported systemPrompt is the final
   * systemInstruction, and P0e already appends the full joined hierarchical
   * memory (every AGENTS.md/IFLOW.md with its body inline, probed) — one item
   * covers prompt + memory + context files without duplicating the same
   * bytes. Disk fallback when the bundled CLI carries no Mod (plain upstream
   * CLI): MemoryService's discovered global + hierarchical files (the same
   * files the CLI loader reads, CLI 0.5.19 probe). The system prompt is
   * honestly marked uncapturable in fallback; we never fabricate its body.
   * Legacy `memory.md` is deliberately excluded — it is NOT loaded by the
   * current CLI (probe: test/fixtures/probe-memory.mjs).
   */
  private async collectInjectedContext(reportFresh: boolean): Promise<InjectedContextItem[]> {
    const report = reportFresh ? this.readContextReport() : null;
    if (report) {
      this.exportCorePrompt(report.systemPrompt);
      return this.reportedContextItems(report.systemPrompt);
    }
    const items: InjectedContextItem[] = [];
    items.push({
      kind: "system",
      label: vscode.l10n.t("系统提示词（本次会话没有捕获到）"),
      content: vscode.l10n.t("当前内核没有提供上下文报告，无法展示系统提示词的完整内容。"),
    });
    items.push(...(await this.memory.injectedContextItems()));
    return items;
  }

  /**
   * Turn the Mod's final system prompt into per-source card items. The join
   * markers are the CLI's own (`--- Context from:` for every hierarchical
   * memory file, `<!-- Imported from: -->` for `@import` expansions), so this
   * is a display-level slice of bytes the model actually receives —
   * global memory, project memory files and knowledge docs each get a row.
   * Context files are classified by their resolved path: the CLI's memory
   * home (`~/.iflow`, hardcoded in its loader) is global; everything else is
   * project memory.
   */
  private reportedContextItems(systemPrompt: string): InjectedContextItem[] {
    const cwd = this.sessionCwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    const home = memoryHome();
    const items: InjectedContextItem[] = [];
    for (const section of splitReportedContextSections(systemPrompt)) {
      if (section.kind === "system") {
        items.push({ kind: "system", label: vscode.l10n.t("系统提示词"), content: section.content });
        continue;
      }
      if (section.kind === "memory") {
        items.push({ kind: "memory", label: vscode.l10n.t("全局记忆"), content: section.content });
        continue;
      }
      if (section.kind === "knowledge") {
        const from = section.from ? this.resolveReportedPath(section.from, cwd) : "";
        const abs = this.resolveReportedPath(section.path ?? "", from ? path.dirname(from) : cwd);
        items.push({
          kind: "knowledge",
          label: vscode.l10n.t("项目知识库"),
          ...(abs ? { path: abs } : {}),
          ...(from ? { from } : {}),
          content: section.content,
        });
        continue;
      }
      const abs = this.resolveReportedPath(section.path ?? "", cwd);
      const global = abs ? isWithin(home, abs) : false;
      items.push({
        kind: global ? "memory" : "context-file",
        label: global ? vscode.l10n.t("全局记忆") : path.basename(abs || section.path || ""),
        ...(abs ? { path: abs } : {}),
        content: section.content,
      });
    }
    return items;
  }

  private resolveReportedPath(raw: string, base: string | null): string {
    if (!raw) return "";
    if (path.isAbsolute(raw)) return path.normalize(raw);
    return base ? path.resolve(base, raw) : raw;
  }

  /**
   * MCP tool declarations the request carries: the CLI turns every connected
   * server's tools into `functionDeclarations` on EVERY request (bundle:
   * `bAo` builds them from the tool registry and the whole set rides
   * `contents[].functionDeclarations`), and the ACP wire never reports them —
   * the mcp-status Mod does. Query it at card-insert time and fold each server
   * into one injected-context item, so the card's token total stays comparable
   * with the MCP card's context chip (`estimateMcpContextTokens` uses the same
   * declaration shape and the same o200k_base tokenizer).
   *
   * Honest degradation, same discipline as the MCP card's status lights: a
   * server that had not finished connecting when the request started did NOT
   * carry its tools, so it rides as a 0-token unloaded entry (no fabricated
   * body, no invented tool names); a missing/disabled Mod (`available:false`)
   * contributes nothing and the card stays exactly as honest as before. MCP
   * discovery runs in the background (mcp-background-loader Mod), so at the
   * FIRST prompt several servers can still report `connecting` — this card is
   * a snapshot of that one request, the MCP settings card keeps live lights.
   */
  private async collectMcpContext(): Promise<InjectedContextItem[]> {
    const client = this.client;
    const sessionId = this.store.getState().sessionId;
    if (!client || !sessionId) return [];
    let report: McpStatusReport | null = null;
    try {
      report = await client.mcpStatus(sessionId);
    } catch (error) {
      this.log.warn(`injected card: mcpStatus unavailable: ${errorMessage(error)}`);
      return [];
    }
    if (!report || !report.available) return [];
    const scopes = this.readMcpScopes();
    const items: InjectedContextItem[] = [];
    for (const [name, view] of Object.entries(report.servers ?? {})) {
      const tools = view.tools ?? [];
      const scope = mcpScopeOf(name, scopes.global, scopes.project);
      if (view.status === "connected") {
        // A connected server that exposes no tools still rides the request
        // (its registry entry exists); the old guard required tools.length > 0,
        // so such a server vanished from the card entirely and the count lied.
        // Honest shape: carried, with an empty body — never a fabricated tool.
        items.push({
          kind: "mcp",
          label: name,
          ...(scope ? { scope } : {}),
          // One compact JSON declaration per line — the same bytes the CLI
          // serializes into functionDeclarations.
          content: tools
            .map((tool) =>
              JSON.stringify({
                name: tool.name,
                ...(tool.description ? { description: tool.description } : {}),
                ...(tool.schemaOmitted || tool.schema === undefined ? {} : { parameters: tool.schema }),
              }),
            )
            .join("\n"),
        });
      } else {
        items.push({ kind: "mcp", label: name, ...(scope ? { scope } : {}), content: "", connected: false });
      }
    }
    return items;
  }

  /**
   * Developer-only channel: write the core instruction (the reported system
   * prompt minus the joined memory / inlined context files, per
   * extractCorePrompt) to `storageUri/core-prompt.md`, overwritten on every
   * fresh Mod report. The UI deliberately hides the core body (byte count
   * only); this file is how the prompt gets extracted for iteration without
   * exposing it to users. Best-effort: a failed write never affects the card.
   */
  private exportCorePrompt(systemPrompt: string): void {
    try {
      const core = extractCorePrompt(systemPrompt);
      if (!core) return;
      const dir = (this.context.storageUri ?? this.context.globalStorageUri).fsPath;
      void writeFile(path.join(dir, "core-prompt.md"), core, "utf8").catch(() => {
        /* best effort */
      });
    } catch {
      /* best effort */
    }
  }

  /**
   * Insert the injected-context card BEFORE the first user block so the user
   * sees what the model sees the moment the request starts. The report file
   * is written at session/new (startChat) — seconds before the user types —
   * so the poll only covers the cold-start race and never delays a prompt
   * meaningfully. `since` is the session-creation baseline
   * (contextReportBaseline): the file survives session switches, so only a
   * report written AFTER it is this session's startChat output; a stale file
   * falls through to the disk collection rather than showing the previous
   * session's system prompt.
   */
  private async insertInjectedContextCard(since: number): Promise<void> {
    const file = this.contextReportFile();
    const isFresh = (): boolean => {
      try {
        return statSync(file).mtimeMs > since;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 2_000;
    while (!isFresh() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      if (this.disposed) return;
    }
    const items = await this.collectInjectedContext(isFresh());
    // The same request also carries every connected MCP server's tool
    // declarations (mcp-status Mod channel, best effort): fold them in so the
    // card answers "which MCP tools did this request carry" next to the
    // system prompt it already explains.
    const mcpItems = await this.collectMcpContext();
    if (this.disposed) return;
    items.push(...mcpItems);
    if (items.length === 0) return;
    // Null = the reducer skipped (card already present) — nothing to persist.
    if (this.store.injectedContext(items) === null) return;
    void this.persistActiveTranscript();
  }

  // --- Turn-level checkpoints (M3 P0-1) ------------------------------------------

  /**
   * Root of the shadow-git stores: `storageUri/checkpoints/<sessionId>/git`,
   * or `<iflow.checkpointDir>/<workspace-hash>/<sessionId>/git` when the
   * setting is set (move stores off workspaceStorage — e.g. huge GGUF-heavy
   * workspaces filled C:). Read fresh per call so the setting applies to the
   * next capture without a window reload.
   */
  private checkpointRoot(): string {
    const defaultRoot = path.join(
      (this.context.storageUri ?? this.context.globalStorageUri).fsPath,
      "checkpoints",
    );
    const custom = vscode.workspace.getConfiguration("iflow").get<string>("checkpointDir", "");
    return CheckpointManager.resolveCheckpointRoot(custom, this.sessionCwd ?? null, defaultRoot);
  }

  private checkpointIndexPath(sessionId: string): string {
    return path.join(this.checkpointRoot(), CheckpointManager.safeSessionId(sessionId), "index.json");
  }

  private ownTranscriptFileName(sessionId: string): string {
    // Session ids come from the CLI and webview messages — restrict to a
    // filesystem-safe charset so a hostile id cannot escape the directory.
    const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "-");
    return `${safe}.json`;
  }

  private ownTranscriptFilePath(sessionId: string): string {
    return path.join(this.transcriptDir(), this.ownTranscriptFileName(sessionId));
  }

  /** Read one session's transcript file; null when absent or corrupt. */
  private async readTranscript(sessionId: string): Promise<PersistedTranscript | null> {
    try {
      const raw = await readFile(this.ownTranscriptFilePath(sessionId), "utf8");
      const parsed = JSON.parse(raw) as PersistedTranscript;
      if (!Array.isArray(parsed.blocks)) return null;
      return parsed;
    } catch {
      return null; // ENOENT (never persisted) or corrupt (crash mid-write)
    }
  }

  /**
   * Serialize a transcript payload synchronously, at call time. Blocks are
   * mutated in place by the shared reducer; stringifying here captures a
   * coherent snapshot even though the actual file write runs later on the
   * persist chain. (Also replaces the old per-persist structuredClone.)
   */
  private serializeTranscript(label: string, blocks: SessionState["blocks"]): string {
    return JSON.stringify({ label, blocks } satisfies PersistedTranscript);
  }

  private async writeTranscriptFile(sessionId: string, payload: string): Promise<void> {
    const target = this.ownTranscriptFilePath(sessionId);
    const tmp = `${target}.tmp`;
    await mkdir(this.transcriptDir(), { recursive: true });
    await writeFile(tmp, payload, "utf8");
    await rename(tmp, target);
  }

  /**
   * Queue a transcript file write on the persist chain: overlapping persists
   * (e.g. prompt-start seeding and the previous prompt's completion) run
   * back-to-back instead of interleaving inside one file's write sequence.
   * The payload factory runs on the chain (after a setImmediate yield), so
   * the synchronous JSON.stringify no longer sits on the event path (P1).
   */
  private enqueueTranscriptWrite(sessionId: string, payloadFactory: () => string): Promise<void> {
    const run = this.persistChain
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(() => this.writeTranscriptFile(sessionId, payloadFactory()));
    this.persistChain = run.catch(() => {});
    return run;
  }

  private async clearTranscript(sessionId: string): Promise<void> {
    await rm(this.ownTranscriptFilePath(sessionId), { force: true });
  }

  /** Restorable = the extension holds a transcript OR the CLI wrote a file. */
  private hasPersistedTranscript(sessionId: string): boolean {
    if (existsSync(this.ownTranscriptFilePath(sessionId))) return true;
    return this.cliTranscriptFilePath(sessionId) !== null;
  }

  /**
   * Drop persisted sessions the CLI has no transcript for (auto-created but
   * never used). Returns the surviving list (already persisted). Orphaned
   * transcript files (session forgotten/dead, file left behind) are deleted.
   */
  private async pruneUnrestorableSessions(): Promise<SessionSummaryUi[]> {
    this.sessionCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.context.extensionUri.fsPath;
    // Migrate BEFORE filtering: hasPersistedTranscript is file-based now, and
    // unmigrated transcripts would otherwise look unrestorable.
    await this.migrateLegacyTranscripts();
    const before = this.readPersistedSessions();
    // The CURRENTLY ACTIVE session must never be pruned: a panel-open
    // auto-session has no transcript until its first prompt lands. Dropping
    // it from the list here poisons the state — the user then chats into a
    // session the switcher no longer contains, nothing ever re-adds it, and
    // the orphan cleanup below deletes its transcript file on the next
    // refresh (close / profile switch) = total content loss.
    const liveActiveId = this.store.getState().activeSessionId;
    const kept = before.filter((s) => this.hasPersistedTranscript(s.id) || s.id === liveActiveId);
    if (kept.length !== before.length) {
      this.log.info(`pruned ${before.length - kept.length} unrestorable session(s)`);
    }
    // P2: drop transcript files whose session is no longer in the list —
    // the old workspaceState map could only grow; the per-session files get
    // garbage-collected here instead. Filename-based comparison: the on-disk
    // name is the sanitized id, so kept ids must go through the same mapping.
    const keptFileNames = new Set(kept.map((s) => this.ownTranscriptFileName(s.id)));
    for (const name of await this.listOwnTranscriptFileNames()) {
      if (name.endsWith(".json") && !keptFileNames.has(name)) {
        await rm(path.join(this.transcriptDir(), name), { force: true });
      }
    }
    // Same garbage collection for the Super Agent child-session archives: an
    // archive whose session left the list is pure residue — nothing would
    // ever read it again, and leaving it behind resurrects the dead session's
    // children (and their unmerged branches) on the next restore.
    const keptArchiveNames = new Set(kept.map((s) => superSessionFileName(s.id)));
    for (const name of await listSuperSessionArchiveFiles(this.superStoreDir())) {
      if (name.endsWith(".json") && !keptArchiveNames.has(name)) {
        await rm(path.join(superSessionsDir(this.superStoreDir()), name), { force: true });
      }
    }
    // M3 P0-1: same garbage collection for shadow-repo dirs — a checkpoint
    // store whose session left the list is pure residue (dirs are keyed by
    // the same sanitized id as the transcript files, minus the extension).
    const keptDirNames = new Set(kept.map((s) => CheckpointManager.safeSessionId(s.id)));
    try {
      for (const name of await readdir(this.checkpointRoot())) {
        if (!keptDirNames.has(name)) {
          await rm(path.join(this.checkpointRoot(), name), { recursive: true, force: true });
        }
      }
    } catch {
      // ENOENT: no session ever captured a checkpoint — nothing to prune.
    }
    const activeId = this.store.getState().activeSessionId
      ?? (await this.context.workspaceState.get<string | null>(ACTIVE_SESSION_KEY, null))
      ?? kept[0]?.id
      ?? null;
    await this.persistSessions(kept, kept.some((s) => s.id === activeId) ? activeId : kept[0]?.id ?? null);
    return kept;
  }

  /**
   * Background refresh of the recent-session switcher: prune unrestorable
   * entries, then push the list WITHOUT touching activeSessionId (used after
   * a fresh session start — the new session must stay active).
   */
  private async refreshSessionList(): Promise<void> {
    this.sessionCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.context.extensionUri.fsPath;
    const kept = await this.pruneUnrestorableSessions();
    const activeId = this.store.getState().activeSessionId;
    this.store.setSessions(kept, activeId);
  }

  /**
   * Transcript file names on disk under the extension's transcript store
   * (for orphan cleanup). Empty when the store directory doesn't exist yet.
   */
  private async listOwnTranscriptFileNames(): Promise<string[]> {
    try {
      return await readdir(this.transcriptDir());
    } catch {
      return []; // transcripts dir not created yet
    }
  }

  /**
   * P2 migration: move transcripts out of the legacy workspaceState map into
   * per-session files, then delete the legacy key. One-shot; a no-op when
   * the key is absent (fresh installs, already-migrated workspaces).
   */
  private async migrateLegacyTranscripts(): Promise<void> {
    const legacy = this.context.workspaceState.get<Record<string, PersistedTranscript>>(TRANSCRIPTS_KEY);
    if (!legacy) return;
    for (const [sessionId, transcript] of Object.entries(legacy)) {
      if (!transcript || !Array.isArray(transcript.blocks) || transcript.blocks.length === 0) continue;
      await this.enqueueTranscriptWrite(
        sessionId,
        () => this.serializeTranscript(transcript.label ?? DEFAULT_SESSION_LABEL, transcript.blocks),
      );
    }
    await this.context.workspaceState.update(TRANSCRIPTS_KEY, undefined);
    this.log.info(`migrated ${Object.keys(legacy).length} legacy transcript(s) from workspaceState to files`);
  }

  /**
   * Live model list from the active endpoint (`GET {baseUrl}/models`).
   * Per user directive the CLI's hardcoded `_meta` catalog is NEVER used as a
   * fallback: an unreachable or empty endpoint yields an empty list (the CLI's
   * current model stays selectable so the dropdown isn't blank).
   *
   * The detailed variant exists because "no endpoint configured", "endpoint
   * unreachable" and "endpoint reachable but returned zero models" all used to
   * collapse into `[]` — a user-triggered refresh could then neither explain
   * itself nor avoid lying about the cause.
   */
  private async queryLiveModelsDetailed(): Promise<
    | { ok: true; models: SessionState["models"] }
    | { ok: false; reason: "no-endpoint" | "unreachable"; message?: string }
  > {
    // Kernel-first: the panel persists its profiles into the shared
    // settings.json, so the workspace handshake / SecretStorage cache is the
    // live credential source and `readActiveEndpoint` (the kernel file) is the
    // final fallback for setups configured outside the panel.
    const endpoint = (await this.resolveWorkspaceHandshakeCreds()) ?? (await loadCredentials(this.context.secrets)) ?? readActiveEndpoint();
    if (!endpoint) return { ok: false, reason: "no-endpoint" };
    try {
      return { ok: true, models: (await queryModelIds(endpoint)).map((id) => ({ id, name: id })) };
    } catch (error) {
      const message = errorMessage(error);
      this.log.warn(
        vscode.l10n.t("模型列表查询失败（不回退内置目录）: {0}", message),
      );
      return { ok: false, reason: "unreachable", message };
    }
  }

  private async queryLiveModels(): Promise<SessionState["models"]> {
    const result = await this.queryLiveModelsDetailed();
    return result.ok ? result.models : [];
  }

  /** Capability rules as stored in ~/.iflow/thinking-models.json (seeded
   * template + user DSL + setting-synced entries), sanitized the loader's
   * way (truthy pattern + boolean supportsThinking + compilable regex). */
  private thinkingCapabilityRules(): ThinkingRuleEntry[] {
    try {
      const parsed = JSON.parse(readFileSync(thinkingRulesFilePath(), "utf8"));
      return sanitizeThinkingRules(Array.isArray(parsed.models) ? parsed.models : []);
    } catch {
      return [];
    }
  }

  /**
   * Annotate the dropdown with thinking capability (ModelInfoUi.thinking):
   * first-match-wins case-insensitive regex over the rules file, same
   * semantics as the CLI's thinking-model-loader. Unmatched ids stay
   * unannotated — UNKNOWN, not "unsupported": the CLI's built-in table may
   * still allow (or forbid) thinking, and a wrong guess is covered by the
   * friendly setThink rejection toast, so the Composer only greys options
   * when a rule explicitly says supportsThinking:false.
   */
  private withThinking(models: SessionState["models"]): SessionState["models"] {
    const rules = this.thinkingCapabilityRules();
    if (rules.length === 0) return models;
    return models.map((m) => {
      const verdict = thinkingForModelRules(m.id, rules);
      return verdict === undefined ? m : { ...m, thinking: verdict };
    });
  }

  /**
   * Model dropdown opened (webview `refreshModels`): re-query the live list
   * and push it. A failed / empty query keeps the already-shown list — a
   * transient endpoint failure must not collapse the dropdown to a single
   * entry — and `initializing` is skipped so a late result from the OLD
   * endpoint cannot clobber the fresh list a profile-switch session start
   * just pushed.
   */
  private async refreshLiveModels(): Promise<void> {
    if (this.store.getState().initializing) return;
    const result = await this.queryLiveModelsDetailed();
    if (!result.ok || result.models.length === 0) {
      // The old list stays on screen (a transient failure must not collapse
      // the dropdown), so the user needs a receipt explaining that nothing
      // was refreshed — and which of the three causes it was.
      const message =
        !result.ok && result.reason === "no-endpoint"
          ? vscode.l10n.t("还没有配置 API 端点，无法刷新模型列表。请先在设置里填写 API 端点并保存。")
          : !result.ok
            ? vscode.l10n.t("模型列表刷新失败，仍显示上次结果")
            : vscode.l10n.t("端点未返回任何模型，仍显示上次结果");
      this.store.sendToast("warning", message);
      return;
    }
    const models = result.models;
    const currentModelId = this.store.getState().currentModelId;
    if (currentModelId && !models.some((m) => m.id === currentModelId)) {
      models.unshift({ id: currentModelId, name: currentModelId });
    }
    this.store.sessionMeta({ models: this.withThinking(models) });
  }

  /**
   * Late-push the live /models result so the HTTP round trip never gates the
   * session's first paint (a slow or dead endpoint previously stalled the
   * splash for up to the full 10s query timeout AFTER session/new had already
   * returned). Stale results are dropped: a profile switch replaces the CLI
   * client (identity check) and another session start replaces the active
   * session — in both cases the old endpoint's list must not clobber the new
   * state. A failed query clears the preserved list to [], matching what
   * sessionStarted used to push on failure.
   */
  private applyLiveModels(
    modelsPromise: Promise<SessionState["models"]>,
    client: AcpClient,
    sessionId: string,
    fallbackModelId: string | null,
  ): void {
    void modelsPromise
      .then((models) => {
        if (this.client !== client) return;
        const state = this.store.getState();
        if (state.sessionId !== sessionId && state.activeSessionId !== sessionId) return;
        if (models.length === 0) {
          // Even a failed/empty /models query keeps the active model
          // selectable (dropdown-must-not-vanish rule): the webview gates the
          // dropdown button on `models.length > 0`, so pushing a bare []
          // here made the button disappear entirely after a transient
          // endpoint failure (e.g. socket hang up).
          const currentModelId = state.currentModelId ?? fallbackModelId;
          this.store.sessionMeta({
            models: currentModelId ? this.withThinking([{ id: currentModelId, name: currentModelId }]) : [],
            ...(currentModelId ? { currentModelId } : {}),
          });
          return;
        }
        // The active model may be absent from the live list; add it so the
        // controlled dropdown doesn't render blank.
        const currentModelId = state.currentModelId ?? fallbackModelId;
        if (currentModelId && !models.some((m) => m.id === currentModelId)) {
          models.unshift({ id: currentModelId, name: currentModelId });
        }
        this.store.sessionMeta({ models: this.withThinking(models), ...(currentModelId ? { currentModelId } : {}) });
      })
      .catch((error: unknown) => {
        // queryLiveModels swallows endpoint errors into []; only unexpected
        // storage failures reject — never let them become unhandled.
        this.log.warn(vscode.l10n.t("模型列表查询失败（不回退内置目录）: {0}", errorMessage(error)));
      });
  }

  /**
   * Start a fresh session.
   *
   * Concurrent requests share ONE run: a 新会话 clicked while the startup
   * restore was being abandoned and the restore's own fallback both funnel
   * through here, so the CLI sees a single `session/new` and the destructive
   * side effects (cleanupEmptySession / cancelAllApprovals /
   * persistActiveTranscript) run exactly once.
   */
  private async startNewSession(options?: { bypassSuperWait?: boolean }): Promise<void> {
    const running = this.newSessionRun;
    if (running) {
      this.log.info("new session: joining the in-flight run");
      await running;
      return;
    }
    const run = this.runStartNewSession(options);
    this.newSessionRun = run;
    try {
      await run;
    } finally {
      if (this.newSessionRun === run) this.newSessionRun = null;
    }
  }

  private async runStartNewSession(options?: { bypassSuperWait?: boolean }): Promise<void> {
    if (this.historySyncBusy) return;
    // A3: never start a session into a destroyed panel.
    if (this.disposed) throw new DisposedError();
    // 等待子会话汇报期间不能新建会话：排队里的汇报与在飞的汇报回合会落到
    // **已被替换**的会话上（sendPrompt 的 session-replaced 守卫会丢弃结果），
    // 子会话的归属（mainSessionId）也对不上 —— 用户看到的是汇报丢失 + 归属
    // 错位。命令面板的 iflow.newSession 绕过 webview 的禁用按钮，所以守卫
    // 必须在宿主侧，不能只靠 UI 禁用。
    // 例外：用户按了「停止」压住汇报时没有任何回合在飞，排队内容按归属留在
    // 队列里（切回原会话才投递）—— 此时新建会话不会串台，反而必须放行，
    // 否则用户点完停止就再无出路（唯一解锁是发消息，而那条 toast 转瞬即逝）。
    // Profile 切换必须能换会话（它走的是另一条路：状态已经被换掉了），用
    // bypassSuperWait 放行。
    if (!options?.bypassSuperWait && !this.autoTurnsHeld() && this.superWaitingForReports()) {
      this.log.warn("new session refused: the host is still waiting for child session reports");
      this.store.appendNotice(
        vscode.l10n.t("还有子会话在运行并等待汇报，请等它们结束（或在看板上中断）后再新建会话"),
      );
      return;
    }
    // A restore is in flight: the user asked for a 新会话 while the history
    // was still being restored. Ask the restore to abandon itself (it has
    // not written anything to the store yet) and continue with the 新会话
    // flow once it settles — the user does not have to click twice.
    // If the restore is already too far along to be abandoned, the intent
    // is recorded and honored right after it settles.
    const restoreSettle = this.restoreSettle;
    if (restoreSettle) {
      this.restoreAbort = true;
      this.pendingNewSession = true;
      this.log.info("new session requested during a restore: asking the restore to abort");
      const outcome = await restoreSettle.promise;
      this.pendingNewSession = false;
      if (outcome === "aborted") {
        this.store.appendNotice(vscode.l10n.t("已取消正在进行的恢复，正在新建会话"));
      } else if (outcome === "completed") {
        this.store.appendNotice(vscode.l10n.t("恢复完成后将自动新建会话"));
      } else {
        this.store.appendNotice(vscode.l10n.t("恢复未完成，正在新建会话"));
      }
      // The panel may have been closed while we waited for the restore.
      if (this.disposed) return;
    }
    // Anchor the CLI-transcript lookup before the empty-session cleanup (its
    // hasPersistedTranscript check scans ~/.iflow/projects/<cwd-slug>/).
    this.sessionCwd =
      this.services.workspaceRoot ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      this.context.extensionUri.fsPath;
    // Tail rescue: a manual reset discards the active session's in-memory
    // blocks below — persist whatever the last (possibly errored) turn left
    // unsaved first. No-op on first connect (blocks are empty).
    void this.persistActiveTranscript();
    // Drop the outgoing session if it never carried content: startNewSession
    // records every fresh session up front, so without this each reset /
    // profile switch would strand an empty "(无标题会话)" husk in the
    // switcher (empty sessions have no transcript → unrestorable).
    await this.cleanupEmptySession(
      this.store.getState().activeSessionId ?? this.store.getState().sessionId,
    );
    // Cancel an in-flight turn before anything else: `session/cancel` is a
    // no-op on an idle session, and without this the abandoned turn keeps
    // streaming server-side — its trailing updates would repopulate the
    // fresh transcript (onSessionUpdate filters them per session, but stop
    // the source too). This also closes the command-palette entry, which
    // bypasses the webview's disabled 新会话 button.
    // 新会话不继承上一个会话的「用户已停止」压制。
    this.autoTurnsStoppedFor = null;
    this.clearDeferredAutoTurnsToast();
    const inFlight = this.store.getState().sessionId;
    if (inFlight) {
      // 还在准备阶段（还没发出 session/prompt）的回合：cancel 到不了 CLI
      // （同 sendTurnCancel 的理由），用 cancelSeen 让它就地收尾，否则它会
      // 在我们刚放弃的会话上照常开跑。
      this.cancelSeen = true;
      try {
        this.client?.cancel(inFlight);
      } catch {
        // dying client — the restart path handles it
      }
      // Abandoned-session guard (mirrors the profile-switch path): drop any
      // trailing session_update from the outgoing session so it cannot leak
      // into the freshly cleared transcript — including updates that arrive
      // during the reset window (sessionId=null) or without a sessionId,
      // which the cross-session guard at onSessionUpdate would otherwise let
      // through. Consumed delete-style on first sight.
      this.discardedSessionIds.add(inFlight);
    }
    // Settle pending approval/question cards BEFORE the clear: their
    // resolution notes belong to the old transcript and are cleared with it.
    this.cancelAllApprovals(vscode.l10n.t("会话已重置"));
    this.cancelAllPlanExits(vscode.l10n.t("会话已重置，计划审批已跳过"));
    this.cancelAllPendingQuestions("");
    // Defensive: a restore that STARTED after the abort request above (the
    // switcher can fire one while the panel is idle) must not interleave its
    // replayed updates with the fresh session. This is the rare path — the
    // normal case was handled at the top of this method.
    if (this.restoring) {
      this.log.warn("new session: a session restore started concurrently — waiting for it to settle");
      const settle = this.restoreSettle;
      if (settle) {
        this.restoreAbort = true;
        this.pendingNewSession = true;
        await settle.promise;
        this.pendingNewSession = false;
      }
      if (this.disposed) return;
    }
    // Clear the transcript IMMEDIATELY. Clearing only after `session/new`
    // returned left the old transcript visibly in place for the whole CLI
    // round trip (~5s measured), reading as "新会话残留了旧会话历史".
    const fresh = newSessionState(this.store.getState());
    // The abandoned turn's completion handler is dropped by sendPrompt's
    // session-replaced guard, so settle the status here: a manual reset
    // always lands idle, never stuck "streaming" with a locked composer.
    if (fresh.status === "streaming") fresh.status = "idle";
    // Detach the switcher from the outgoing session: newSessionState
    // preserves activeSessionId, which left the dropdown showing the OLD
    // session's label during the whole CLI boot — reading as "the new session
    // kept the old conversation". recordSession re-points it to the new id.
    fresh.activeSessionId = null;
    this.store.replaceState(fresh);
    // 看板跟着主会话走：新会话没有历史子会话（活着的子会话仍然可见 ——
    // 它们是正在跑的进程，用户还得能中断它们）。
    this.publishSuperSessions();
    // 委派扫描状态也换人：上一个会话的助手文本（以及里面没收口的围栏）、
    // 已派发载荷的账本都跟新会话无关。
    this.resetSuperDirectiveScans();
    // Open the reset window: until the new session is established (finally),
    // onSessionUpdate drops everything not addressed to the store's own
    // session — this is what catches the abandoned turn's trailing updates
    // that arrive WITHOUT a sessionId (they pass both id guards otherwise).
    this.droppingForReset = true;
    // Lock the UI while the CLI spins up the new session (sessions/mode/model
    // switches must not race the in-flight `session/new`).
    this.store.setInitializing(true, "newSession");
    try {
    const client = await this.ensureClient();
    // A3: a dispose during the handshake rejects ensureClient with
    // DisposedError; a dispose AFTER it must not write into the destroyed
    // store either.
    if (this.disposed) throw new DisposedError();
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.context.extensionUri.fsPath;
    this.sessionCwd = workspaceRoot;
    // The live /models HTTP query is independent of session/new — race them
    // concurrently (queryLiveModels swallows its own errors into []). A slow
    // endpoint previously serialized behind the CLI's 30-60s boot, adding up
    // to its full 10s timeout on every session start.
    const modelsPromise = this.queryLiveModels();
    const tNewSession = Date.now();
    this.contextReportBaseline = tNewSession;
    const session = await client.newSession({
      cwd: workspaceRoot,
      mcpServers: [],
      settings: mainSessionSettings(),
    });
    this.log.info(`session/new ok in ${Date.now() - tNewSession}ms`);
    const meta: NewSessionMeta | undefined = session._meta;
    const store = this.store;
    const cliModelId = meta?.models?.currentModelId ?? null;
    // After a profile switch the CLI's current model belongs to the previous
    // endpoint — default to the model configured in the NEW profile (user
    // directive) and push it to the CLI so prompts actually use it.
    const switchModel = this.pendingSwitchModel;
    this.pendingSwitchModel = null;
    // Wire behavior (probed against CLI 0.5.19 bundle, 2026-09-17):
    // `session/set_model` only rewrites the in-memory contentGeneratorConfig
    // (the model prompts actually use) — it never writes back to Config.model
    // / settings.json, and `session/new` reports `_meta.models.currentModelId`
    // from Config.model, i.e. the model read from settings.json at CLI BOOT.
    // So after a dropdown switch, the next session/new reports the OLD boot
    // model while the shared contentGeneratorConfig still uses the switched-to
    // one: the dropdown showed a model prompts did NOT use (user-reported).
    // Treat the panel's current selection as authoritative and re-push it
    // below whenever it differs from the CLI's boot-time id.
    const currentModelId =
      switchModel ??
      this.store.getState().currentModelId ??
      this.workspaceModelId() ??
      cliModelId;
    // A failed restore leaves an error banner behind — clear it for the fresh
    // session so the stale message doesn't follow the user around.
    store.getState().errorMessage = null;
    if (store.getState().status === "error") store.getState().status = "idle";
    // First paint WITHOUT waiting on the /models HTTP round trip. sessionStarted
    // omits `models` (setMeta keeps the list preserved by newSessionState; []
    // on cold start) — the live list lands via applyLiveModels below, so a
    // slow endpoint can no longer stretch the splash to its 10s timeout.
    store.sessionStarted({
      sessionId: session.sessionId,
      modes: session.modes,
      commands: meta?.availableCommands ?? [],
      skills: meta?.availableSkills ?? [],
      currentModelId,
    });
    this.applyLiveModels(modelsPromise, client, session.sessionId, cliModelId);
    // See the wire-behavior note above: the new session inherits the CLI's
    // boot-time model unless we push the panel's selection, so any mismatch
    // (profile switch OR plain dropdown switch) must be re-applied — after
    // validating the selection is still offered by the live endpoint.
    if (currentModelId && currentModelId !== cliModelId) {
      const pushId = await this.validateModelForPush(modelsPromise, currentModelId, cliModelId);
      if (pushId) await this.setModel(pushId);
    }
    // iflow.defaultMode: the CLI boots with its own mode (session/new
    // reports it in modes.currentModeId), so the configured default must be
    // pushed explicitly on every fresh session — the setting was previously
    // declared but never read (trap #14 class). Skip silently when the CLI
    // does not offer the configured id (e.g. an older agent without "plan");
    // a setMode that is actually attempted surfaces its own failure warning.
    const configuredMode = vscode.workspace.getConfiguration("iflow").get<string>("defaultMode");
    if (
      configuredMode &&
      session.modes &&
      configuredMode !== session.modes.currentModeId &&
      session.modes.availableModes.some((m) => m.id === configuredMode)
    ) {
      await this.setMode(configuredMode).catch(() => undefined);
    }
    await this.applyThinkLevel(client, session.sessionId, this.store.getState().thinkLevel);
    this.log.info(`session started: ${session.sessionId}`);
    await this.recordSession(session.sessionId, null);
    } finally {
      // Close the reset window (see the flag's declaration): from here on the
      // store carries the new sessionId, so the regular cross-session guard
      // takes over. On failure the store's sessionId stays null and the old
      // guards behave exactly as before this window existed.
      this.droppingForReset = false;
      this.store.setInitializing(false);
    }
  }

  private async sendPrompt(
    text: string,
    images?: { data: string; mimeType: string }[],
    files?: { name: string; path: string }[],
    contexts?: ContextRefUi[],
    /**
     * `internal: true` marks a HOST-driven turn (bookkeeping, not user work).
     * Such a turn must not rename the session, must not capture a workspace
     * checkpoint, and must not carry the child-session board digest.
     *
     * `delegateOnBusy: false` forbids the "streaming → dispatch this text as
     * a child session" fallback. A merge request is one of those: it must run
     * in the MAIN workspace (the child's worktree cannot merge into it), so
     * the host refuses instead of silently delegating it.
     *
     * `hidden: true` — an internal instruction that must NOT show up in the
     * transcript: no user bubble, no session rename, no checkpoint. The agent
     * still receives the prompt, and its answer still streams into the
     * transcript as an assistant message.
     *
     * `reportTurn: true` — this hidden turn is the Super Agent report delivery
     * (the main agent reading child results and reporting back). Only that
     * flavour of hidden turn earns a completion cue (`announceSuperReport`):
     * action receipts and delegated-user-turn backfills are bookkeeping and
     * stay silent.
     *
     * 返回值：true = 这一回合真的在主会话上跑起来了；false = 被拒了（主会话
     * 正忙 / 正在恢复历史 / 已销毁）或被派发成了子会话。汇报队列靠它决定
     * 「这条汇报是投出去了」还是「还欠着」—— 汇报丢了主会话就永远读不到
     * 自己孩子的结果。
     */
    options?: { internal?: boolean; delegateOnBusy?: boolean; hidden?: boolean; reportTurn?: boolean },
  ): Promise<boolean> {
    const internal = options?.internal === true;
    const hidden = options?.hidden === true;
    const reportTurn = options?.reportTurn === true;
    const trimmed = text.trim();
    const hasContexts = (contexts?.length ?? 0) > 0;
    if (!trimmed && !hasContexts) return false;
    // A `/compress` turn is housekeeping, not conversation: it must not
    // trigger automatic memory extraction. Auto-compression after a real turn
    // is covered separately by maybeAutoCompressOnIdle's return value.
    const isCompressTurn = !hasContexts && trimmed === "/compress";
    // A3: the panel was disposed (window close / extension reload) — the
    // store is gone, so there is nothing to send.
    if (this.disposed) return false;
    // 用户自己开口 = 明确「继续」：解除 Stop 对宿主自动回合的压制
    // （见 autoTurnsStoppedFor）。排队内容一直在队列里，这里只是放开闸门。
    if (!internal && !hidden) {
      this.autoTurnsStoppedFor = null;
      this.clearDeferredAutoTurnsToast();
    }
    // ── 主会话车道 ────────────────────────────────────────────────
    // 「用户回合」与「hidden 汇报回合」都跑在同一个 ACP 会话上：两个回合
    // 并发会让转录顺序错乱、上下文互相污染、token 重复计费。
    //
    // 状态位（status === "streaming"）挡不住这个竞态：状态要等
    // store.userPrompt() 才翻成 streaming，而回合在翻状态**之前**还有几个
    // await 窗口（expandSkillCall / ensureClient / assertModeForPrompt）——
    // 汇报回合正好能从那个窗口插进来。
    //
    // 车道**同步**申领（申领与检查之间没有 await）：用户回合优先，它一进
    // sendPrompt（那时还没有任何 await）就占住车道；汇报回合看到车道被占
    // 就留在队列里等（见 drainSuperReports）。状态翻成 streaming 之后车道
    // 就释放 —— 那之后状态位足以挡住第二个回合。
    const laneToken = Symbol("main-lane");
    const laneBusy = this.mainLane !== null;
    const releaseLane = (): void => {
      if (this.mainLane === laneToken) this.mainLane = null;
    };
    // The main session only DELEGATES: while a turn is streaming, a new user
    // prompt is not queued behind it — it is dispatched as a child session
    // (own CLI process, own worktree), so the main turn is never interleaved
    // and the user never waits on a FIFO. replaying/historySyncBusy stay
    // rejected: beginReplay also reports "streaming", and spawning during a
    // restore would race the transcript the restore is rebuilding.
    // Host-driven reports (`internal`) never delegate — a report arriving
    // while the main session is busy is dropped, not turned into a child.
    const gateState = this.store.getState();
    if (gateState.status === "streaming" || laneBusy) {
      if (gateState.replaying || this.historySyncBusy) {
        this.log.info("sendPrompt rejected: replay/history-sync in flight");
        return false;
      }
      if (internal) return false;
      // hidden 回合（子会话汇报）：主会话正忙着 —— 这一轮**不跑**，由调用方
      // 把它留在队列里等空闲时重投。绝不能把它派发成子会话（汇报得投给
      // 主会话），也绝不能悄悄丢掉（丢了主会话就永远读不到孩子的结果）。
      if (hidden) return false;
      // A merge request must run in the MAIN workspace, so delegating it to
      // an isolated child session would be wrong (the child's worktree has
      // its own branch). Refuse and say why instead of doing something else.
      if (options?.delegateOnBusy === false) {
        this.store.sendToast(
          "warning",
          vscode.l10n.t("主会话正在生成，等本轮结束后再让智能体合并"),
        );
        return false;
      }
      const contextBlock = hasContexts
        ? assembleContextSections(contexts!, (c) => this.contextSectionTitleEn(c))
        : "";
      // Attachments ride along in the child's OWN staging dir: images become
      // inline image blocks (they never have a path), files are copied there.
      // Quoting a main-workspace path in the task text would be useless — the
      // child works inside its own worktree and cannot read the parent tree.
      let droppedAttachments = 0;
      const attachments = this.collectSuperAttachments(images, files, (count) => {
        droppedAttachments += count;
      });
      const task = [contextBlock, trimmed].filter(Boolean).join("\n\n");
      const title = normalizeSuperTitle(trimmed.split("\n")[0] ?? "");
      const manager = this.getSuperAgent();
      if (!manager) {
        this.store.sendToast("warning", vscode.l10n.t("没有打开的工作区，无法派发子会话"));
        return false;
      }
      manager.spawn({ title, task, ...(attachments.length > 0 ? { attachments } : {}) });
      // 主会话此刻收不到这条消息（本分支马上 return false）：先把原文与附件
      // 缓存下来，等本回合结束后由 drainDelegatedUserTurns 以 hidden 回合补投。
      // 绝不在这里碰 client.prompt（会与正在跑的回合并发）或 store.userPrompt
      // （会造一条主会话从未处理过的用户气泡）。
      this.pendingDelegatedUserTurns.push({
        mainSessionId: this.currentMainSessionId(),
        text: trimmed,
        images: (images ?? []).map((img) => ({ data: img.data, mimeType: img.mimeType })),
        files: (files ?? []).map((file) => ({ name: file.name, path: file.path })),
        ...(contexts?.length ? { contexts } : {}),
        droppedByChild: droppedAttachments,
      });
      // 心跳是「主会话一直没空闲 / 补投失败」时的重试通道：这里就把它点着，
      // 免得子会话瞬间结束时没有任何事件再唤醒补投。
      this.ensureSuperHeartbeat();
      this.store.sendToast(
        "info",
        vscode.l10n.t("主会话正在生成，已把这条消息派发为子会话「{0}」", title),
      );
      if (droppedAttachments > 0) {
        this.store.sendToast(
          "warning",
          vscode.l10n.t(
            "每个子会话最多携带 {0} 个附件，超出上限的 {1} 个已忽略",
            MAX_SUPER_ATTACHMENTS,
            droppedAttachments,
          ),
        );
      }
      return false;
    }
    // Context cards (right-click selection + @folder/@problems/@git/@url):
    // each becomes a titled fenced section ahead of the typed text. Sections
    // ride RAW — the composed text starts with a section title, never with
    // "/", so the CLI's command gate cannot misfire; only the typed part
    // goes through toAgentPromptText (its "/"-escape must not touch code).
    //
    // Two title variants on purpose: the transcript keeps the Chinese titles
    // (the user reads that bubble), the agent gets the English ones (the
    // model-facing prompt is English throughout).
    const contextBlock = hasContexts
      ? assembleContextSections(contexts!, (c) => this.contextSectionTitle(c))
      : "";
    const agentContextBlock = hasContexts
      ? assembleContextSections(contexts!, (c) => this.contextSectionTitleEn(c))
      : "";
    const fullText = [contextBlock, trimmed].filter(Boolean).join("\n\n");
    // The agent sees the attachment list inline: absolute paths it can read
    // with its own tools. The transcript block (beginUserPrompt) mirrors the
    // same list so the UI matches what was actually sent.
    //
    // **English**: this line only ever reaches the model (the transcript gets
    // its own file note), so it must not be an l10n string — a translated
    // header would flip the language in the middle of an English prompt.
    //
    // The header is the SHARED protocol literal (`AGENT_ATTACHMENT_HEADER`):
    // the CLI records this text verbatim, and the delete-message flow has to
    // recognise the block to locate the turn in the CLI history. Keeping the
    // producer and the consumer on one constant is what stops the two from
    // drifting apart when the wording changes.
    const attachmentBlock =
      files && files.length > 0
        ? `\n\n${AGENT_ATTACHMENT_HEADER}\n${files
            .map((f) => `- ${f.name} → ${f.path}`)
            .join("\n")}`
        : "";
    // The agent-facing text escapes "/"-leading non-commands in the TYPED
    // part (CLI would otherwise answer "Unknown command" and the model never
    // sees the text); the transcript keeps the composed verbatim input.
    // A `/skill <name> …` invocation is NOT a CLI command — the panel
    // resolves the skill itself and injects the payload the CLI's Skill tool
    // would have produced (that tool is model-invoked and asks for a
    // confirmation the default approval policy denies, so the model cannot be
    // relied on to run it).
    // 申领车道（**第一个 await 之前**）：从这一刻起，汇报回合不能再插进来。
    this.mainLane = laneToken;
    const skillCall = parseSkillInvocation(trimmed);
    let typedText = toAgentPromptText(trimmed, this.store.getState().commands);
    if (skillCall) {
      let expanded: string | null = null;
      try {
        expanded = await this.expandSkillCall(skillCall);
      } catch (error) {
        // 抛出去之前把车道还回去：否则主会话会被一把没人持有的锁卡住
        // （之后任何回合都进不来）。
        releaseLane();
        throw error;
      }
      if (expanded) typedText = expanded;
    }
    // The orchestrator's eyes: every main-session turn starts with the live
    // child-session board (host state, NOT user text — it is never written to
    // the user bubble). Internal helper requests (titles / enhance / reports)
    // must not carry it: they are not turns of the conversation.
    const superDigest = internal ? "" : this.superAgentsDigest();
    const promptText =
      [superDigest, agentContextBlock, typedText].filter(Boolean).join("\n\n") + attachmentBlock;
    // C3/C9: the webview's busy lock cannot guard the command channels
    // (`iflow.askSelection`, `@iflow` participant). A prompt during a session
    // reset would hit the about-to-be-discarded sessionId; two overlapping
    // prompts interleave in the transcript. The webview already disables its
    // composer in both states — this gate closes the side doors.
    const state = this.store.getState();
    if (state.initializing || state.status === "streaming" || this.historySyncBusy) {
      this.log.info(
        `sendPrompt rejected: initializing=${state.initializing}, status=${state.status}, historySync=${this.historySyncBusy}`,
      );
      releaseLane();
      return false;
    }
    this.cancelSeen = false;
    // Hoisted for the catch: a profile switch (hot re-auth or full restart)
    // cancels an in-flight prompt, whose rejection then lands here AFTER the
    // fresh state is already in place.
    let promptSessionId: string | null = null;
    try {
      const client = await this.ensureClient();
      // A3: a dispose during the handshake rejects ensureClient with
      // DisposedError; a dispose AFTER it must not write into the destroyed
      // store either.
      if (this.disposed) throw new DisposedError();
      promptSessionId = this.store.getState().sessionId;
      if (!promptSessionId) throw new Error(vscode.l10n.t("会话未就绪"));
      // The CLI's mode is invisible to us (no `current_mode_update`), so a
      // drift introduced by a Plan-exit interrupt would otherwise surface as
      // the agent silently writing while the composer still says 计划 — make
      // the CLI follow the mode the user sees before every turn.
      await this.assertModeForPrompt(client, promptSessionId);
      // First turn of this session: show what the request auto-injects
      // (system prompt / memory / context files) BEFORE the user bubble.
      // Fire-and-forget — the card rides the next snapshot; a slow CLI
      // startChat never delays the prompt. The injected-card check matters
      // because deleting/edit-resending the first user message truncates
      // FROM the user block — the card before it survives, and without this
      // guard the next send would insert a duplicate.
      const promptBlocks = this.store.getState().blocks;
      if (
        !promptBlocks.some((b) => b.kind === "user") &&
        !promptBlocks.some((b) => b.kind === "injected")
      ) {
        void this.insertInjectedContextCard(this.contextReportBaseline);
      }
      if (!internal) {
        this.currentTurnAttachments =
          (images?.length ?? 0) + (files?.length ?? 0) > 0
            ? { images: images ?? [], files: files ?? [] }
            : null;
      }
      // `hidden`: the prompt goes to the agent but must not show up in the
      // transcript — no user bubble, no session rename. The agent's answer
      // still streams in as an assistant message.
      if (!hidden) {
        this.store.userPrompt(
          fullText,
          (images ?? []).map((img) => `data:${img.mimeType};base64,${img.data}`),
          files,
        );
        if (!internal) void this.labelSessionWithPrompt(fullText);
        void this.persistActiveTranscript(); // user turn lands even on a crash
      } else {
        // hidden 回合（子会话汇报）：不写用户块 → beginUserPrompt 不会把状态
        // 翻成 streaming → 那一轮在面板上不显示「正在生成」浮动 pill，顶栏
        // 「新会话」也不禁用，用户点它会把在飞的汇报回合废掉。这里显式开启：
        // 状态翻成 streaming，转录底部浮动 pill 按「正在生成」渲染。
        this.store.beginHiddenTurn();
      }
      // 状态已经翻成 streaming：从这一刻起状态位足以挡住第二个回合，车道
      // 可以还回去 —— 否则回合收尾的家务（队列里的下一条消息、汇报投递）
      // 会被自己的车道挡住。
      releaseLane();
      // M3 P0-1: snapshot the workspace BEFORE the agent runs so this turn's
      // file changes are revertible. Awaited — a parallel capture would race
      // the agent's writes and bake them into the "before" snapshot. Best
      // effort: a partial capture never blocks the prompt. Host-driven turns
      // (Super Agent reports) skip it: they change no files, and a snapshot
      // per report would tax every child-session completion.
      if (!internal && !hidden) {
        const afterUser = this.store.getState().blocks;
        const userIndex = afterUser.length - 1;
        const userBlockId = afterUser[userIndex]?.id;
        const sha = await this.captureWorkspaceSnapshot(promptSessionId, fullText);
        if (userBlockId) {
          const turnIndex = afterUser
            .slice(0, userIndex + 1)
            .filter((b) => b.kind === "user").length - 1;
          this.recordCheckpoint(promptSessionId, {
            userBlockId,
            turnIndex,
            sha,
            createdAt: Date.now(),
            partial: sha === null,
            label: checkpointLabelFromText(fullText),
          });
        }
      }
      const prompt: ContentBlock[] = [{ type: "text", text: promptText }];
      for (const img of images ?? []) {
        prompt.push({ type: "image", data: img.data, mimeType: img.mimeType });
      }
      const result = await this.promptWithRetry(client, promptSessionId, prompt);
      // 本轮已结束：委派指令只在流式期间出现，之后不该再把旧附件带给新子会话。
      if (!internal) this.currentTurnAttachments = null;
      // Session replaced mid-flight (新会话/profile switch cancelled the
      // in-flight turn): the completion must not settle the NEW session's
      // state (or overwrite its usage estimate) — drop like the catch path.
      if (this.store.getState().sessionId !== promptSessionId) {
        this.log.info(`prompt completed after session switch — dropped (session replaced)`);
        return false;
      }
      this.store.promptCompleted(result.stopReason, result.usage);
      // 回合收尾：复核动作围栏 —— 回合都结束了还停在未闭合围栏上，说明这个
      // 动作块永远不会被执行。旧实现对此完全静默（零日志、零 toast）。
      this.auditSuperActionsAtSettle();
      // Completion cue, but a user stop/cancel stays silent. The chime is the
      // universal cue (postSound); the native toast is the ADDITIVE
      // away-notification (M1 P0-5) with its own gate — no longer mutually
      // exclusive, the exclusivity made the chime unreachable for away users
      // on `osNotifications: all` (user report 2026-10-13).
      if (result.stopReason !== "cancelled") {
        if (!hidden) {
          // 用户回合：照旧「iFlow 已完成本轮回复」+ done 音（见 announceCue
          // 的可见信号对称规则）。
          this.announceTurnDone(vscode.l10n.t("iFlow 已完成本轮回复"));
        } else if (reportTurn) {
          // 主会话汇报回合：主 Agent 读完子会话结果并汇报回来，那是主会话
          // 真实的收尾工作，用**独立事件** superReport + 常规 done 音 —— 与
          // 单个子会话收尾（childDone + child 音）明确分开。
          this.announceSuperReport(vscode.l10n.t("主会话已汇报子会话结果"));
        }
        // 其余 hidden 回合（动作回执 / 被改道用户消息补投）**完全静音**：
        // 那是宿主自己的记账回合，转录里没有用户气泡，也不对应任何新事件。
        // 单个子会话的完成提示挂在状态迁移上（syncChildSettledAnnouncements）。
      }
      void this.persistActiveTranscript();
      void this.touchActiveSession();
      // Turn-end proactive compression (see maybeAutoCompressOnIdle): a user
      // Stop (cancelled) skips it — the user is steering, and firing a
      // compress turn right after they pressed Stop reads as "won't stop".
      // Awaited so a queued next message rides the SMALLER context.
      let autoCompressed = false;
      if (result.stopReason !== "cancelled") {
        autoCompressed = await this.maybeAutoCompressOnIdle(promptSessionId);
      }
      // Turn-end follow-up (ONE merged request: AI title + next-step chips +
      // memory candidates; silent on failure, fire-and-forget so it never
      // delays the queue). The housekeeping discipline still applies to the
      // conversation-derived tasks: a compression turn — typed `/compress` or
      // a turn-end auto-compress — must not seed 下一步 chips or memory
      // candidates from housekeeping chatter (2026-10-19 report: chips like
      // "查看压缩结果" after a compress turn). The batch is fired AFTER the
      // auto-compress decision on purpose: pre-fold firing burned a call whose
      // anchor the compression fold invalidates anyway.
      if (promptSessionId && result.stopReason !== "cancelled") {
        void this.runTurnFollowup(promptSessionId, {
          allowTitle: true,
          conversationTasks: !isCompressTurn && !autoCompressed,
        });
      }
      // M2 P0-3: the turn settled — the idle slot is free, feed it the next
      // queued message (no-op when the queue is empty). A user Stop
      // (cancelled) also drains: Stop interrupts the CURRENT turn, the queue
      // keeps steering (roadmap Steer semantics).
      void this.dispatchQueue();
      // 主会话空闲了 → 发起排队的「让智能体合并」（子会话完成后自动合并的
      // 那一路）。串行执行，一次只合并一个。
      void this.drainSuperMerges();
      // 同理：子会话汇报可能在别的事件里就绪（流式期间 / 恢复历史期间），
      // 回合结束时补一次投递，并刷新「等待子会话」心跳 —— 主会话空闲而子会话
      // 仍在跑时，这条常驻提示就是「流程没断，宿主在等」的唯一可见证据。
      void this.drainSuperReports();
      // 本回合里若有用户消息被改道给子会话，现在主会话空闲了 → 补投成下一
      // 回合（hidden，不伪造用户气泡）。与汇报/合并共用同一条车道，谁先申领
      // superReportRunning 谁跑；没抢到的留给心跳重投。
      void this.drainDelegatedUserTurns();
      this.refreshSuperWaitHeartbeat();
      if (this.hasSuperWork()) this.ensureSuperHeartbeat();
    } catch (error) {
      if (!internal) this.currentTurnAttachments = null;
      // A3: the panel was disposed mid-flight — the store is gone, so there
      // is nothing to mark and nothing to persist.
      if (this.disposed) {
        this.log.info(`prompt dropped after dispose: ${errorMessage(error)}`);
        releaseLane();
        return false;
      }
      // Session replaced mid-flight (profile switch cancels the in-flight
      // prompt): the rejection lands after the fresh state is in place, so
      // the old turn's failure must not mark the new session errored — and
      // persistActiveTranscript would serialize the emptied blocks over the
      // NEW session's file. Drop everything but the log line.
      if (this.store.getState().sessionId !== promptSessionId) {
        this.log.info(`prompt failed after session switch — dropped (session replaced)`);
        releaseLane();
        return false;
      }
      // R1 (final): prompts run without a timeout — failures here are real
      // errors (CLI died, connection closed), not slow turns. Long turns are
      // stopped by the user via Stop (`session/cancel`).
      // The banner shows the extracted message; the log gets the full
      // envelope + recent CLI stderr so "[object Object]-shaped" failures
      // remain diagnosable from the Output panel.
      this.log.error(`prompt failed: ${this.formatErrorForLog(error)}`);
      this.store.markError(errorMessage(error));
      // Policy 2026-10-16 (user restated): OS reminders exist for exactly the
      // four triggers — question/approval/plan card displayed, turn completed.
      // A failed turn keeps its in-panel banner (markError above) + the error
      // chime (postSound below) but earns no system toast.
      // M2 P0-3: a real failure pauses auto-dispatch — every queued message
      // would hit the same broken endpoint/CLI. The composer's queue strip
      // shows 继续/清空; dispatch resumes on `queueAction: resume`.
      this.pauseQueueOnError();
      // Errored-turn rescue: the completion-time persist never runs for a
      // failed prompt, so whatever streamed before the failure exists only in
      // memory. Write it now or a restart / profile switch loses it for good.
      void this.persistActiveTranscript();
      void this.touchActiveSession();
      this.postSound("error");
      releaseLane();
      return false;
    }
    releaseLane();
    return true;
  }

  /**
   * Resolve a `/skill <name> …` invocation into the text the agent receives:
   * the skill's base directory + its SKILL.md body (what the CLI's Skill
   * tool injects) + the user's own instruction.
   *
   * Host-owned on purpose: the CLI's Skill tool is MODEL-invoked and asks for
   * a confirmation that the default approval policy denies, so asking the
   * model to run it is not a dependable trigger. Resolving it here makes the
   * invocation deterministic.
   *
   * Returns null when the skill cannot be found — the caller then sends the
   * text as ordinary prose (never swallowed) and the user is told why.
   */
  private async expandSkillCall(call: SkillInvocation): Promise<string | null> {
    const roots = skillRoots(memoryHome(), this.sessionCwd);
    const skill = await resolveSkill(roots, call.name);
    if (!skill) {
      this.store.sendToast("warning", vscode.l10n.t("未找到技能「{0}」，已按普通文本发送", call.name));
      return null;
    }
    this.log.info(`skill invoked: ${skill.name} (${skill.scope})`);
    return buildSkillPrompt({
      baseDirectory: skill.baseDirectory,
      content: skill.content,
      args: call.args,
    });
  }

  /**
   * Regenerate the last assistant turn: re-run the most recent user prompt
   * through the same pipeline as sendPrompt, but WITHOUT recording a new user
   * block (the prompt already exists in the transcript). Host-owned because the
   * webview is a projection and must not reach into transcript state to extract
   * the last prompt. No-op when there is no prior user prompt or a turn is
   * already in flight.
   */
  private async regenerate(): Promise<void> {
    if (this.historySyncBusy) return;
    const state = this.store.getState();
    if (state.initializing || state.status === "streaming") return;
    // A3: the panel was disposed — the store is gone.
    if (this.disposed) return;
    // Walk back to the last user block — that's the prompt we re-run.
    let lastUserBlock: Extract<Block, { kind: "user" }> | null = null;
    for (let i = state.blocks.length - 1; i >= 0; i--) {
      const b = state.blocks[i];
      if (!b) continue;
      if (b.kind === "user") {
        lastUserBlock = b;
        break;
      }
    }
    const lastUserText = lastUserBlock?.text ?? null;
    if (!lastUserText || !lastUserText.trim()) return;
    // beginUserPrompt 把文件写成「（文件：name → path）」注记行、图片存成
    // data URL —— 这两处是转录里唯一留存的附件形态。规范化后的文本才是原轮
    // 的纯 prompt（与正常发送时 typedText 的口径一致）。
    const regenText = normalizeUserPromptText(lastUserText);
    if (!regenText) return;
    const isCompressTurn = regenText === "/compress";
    this.cancelSeen = false;
    // 用户主动发起的一轮同样算「继续」：解除 Stop 对自动回合的压制。
    this.autoTurnsStoppedFor = null;
    this.clearDeferredAutoTurnsToast();
    let promptSessionId: string | null = null;
    try {
      const client = await this.ensureClient();
      if (this.historySyncBusy) return;
      // A3: a dispose during the handshake rejects ensureClient with
      // DisposedError; a dispose AFTER it must not write into the destroyed
      // store either.
      if (this.disposed) throw new DisposedError();
      promptSessionId = this.store.getState().sessionId;
      if (!promptSessionId) throw new Error(vscode.l10n.t("会话未就绪"));
      // Same turn-start mode sync as sendPrompt: a regenerated turn must obey
      // the mode the composer shows, not a possibly drifted CLI copy.
      await this.assertModeForPrompt(client, promptSessionId);
      // 重新生成必须把原轮的图片/文件一起带回：正常发送会 push image 块并
      // 追加 AGENT_ATTACHMENT_HEADER 清单，旧实现只发一段 text，模型重跑时
      // 看不到截图/日志。只从 user 块既有形态取回（data URL + 文件注记行），
      // 解析不出来就如实不带，绝不伪造附件。
      const regenImages: { data: string; mimeType: string }[] = [];
      for (const url of lastUserBlock?.images ?? []) {
        const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
        if (!match) continue;
        const mimeType = match[1];
        const data = match[2];
        if (mimeType && data !== undefined) regenImages.push({ mimeType, data });
      }
      const regenFiles: { name: string; path: string }[] = [];
      for (const line of (lastUserBlock?.text ?? "").split("\n")) {
        const match = /^（文件：(.*) → (.*)）$/.exec(line);
        if (!match) continue;
        const name = match[1];
        const filePath = match[2];
        if (name && filePath) regenFiles.push({ name, path: filePath });
      }
      const regenAttachmentBlock =
        regenFiles.length > 0
          ? `\n\n${AGENT_ATTACHMENT_HEADER}\n${regenFiles
              .map((f) => `- ${f.name} → ${f.path}`)
              .join("\n")}`
          : "";
      // A regenerated turn must carry the SAME agent-facing text the original
      // turn did — including a `/skill <name>` expansion (the raw command
      // would be escaped into prose by toAgentPromptText).
      const regenSkill = parseSkillInvocation(regenText);
      const regenExpanded = regenSkill ? await this.expandSkillCall(regenSkill) : null;
      const regenDigest = this.superAgentsDigest();
      const prompt: ContentBlock[] = [
        {
          type: "text",
          text:
            [regenDigest, regenExpanded ?? toAgentPromptText(regenText, this.store.getState().commands)]
              .filter(Boolean)
              .join("\n\n") + regenAttachmentBlock,
        },
      ];
      for (const img of regenImages) {
        prompt.push({ type: "image", data: img.data, mimeType: img.mimeType });
      }
      const result = await this.promptWithRetry(client, promptSessionId, prompt);
      // Session replaced mid-flight: the completion must not settle the NEW
      // session's state — drop like the sendPrompt success path.
      if (this.store.getState().sessionId !== promptSessionId) {
        this.log.info(`regenerate completed after session switch — dropped (session replaced)`);
        return;
      }
      this.store.promptCompleted(result.stopReason, result.usage);
      // Same completion cue policy as sendPrompt (see announceTurnDone) — a
      // regenerated turn landing while the user is away must announce itself
      // too, but a duplicate notification dropped by the content cooldown
      // must not leave a lone chime behind.
      if (result.stopReason !== "cancelled") {
        this.announceTurnDone(vscode.l10n.t("iFlow 已完成本轮回复"));
        // Same turn-end proactive compression policy as sendPrompt.
        const autoCompressed = await this.maybeAutoCompressOnIdle(promptSessionId);
        // Same turn-end follow-up batch as sendPrompt (one merged request),
        // with the same housekeeping gate: a `/compress` turn or a turn-end
        // auto-compress must not seed 下一步 chips or memory candidates from
        // compression chatter. No title task — a regenerated turn is not the
        // first-turn title window.
        if (promptSessionId) {
          void this.runTurnFollowup(promptSessionId, {
            allowTitle: false,
            conversationTasks: !isCompressTurn && !autoCompressed,
          });
        }
      }
      void this.persistActiveTranscript();
      void this.touchActiveSession();
    } catch (error) {
      // A3: the panel was disposed mid-flight — the store is gone.
      if (this.disposed) return;
      if (this.store.getState().sessionId !== promptSessionId) {
        this.log.info(`regenerate failed after session switch — dropped (session replaced)`);
        return;
      }
      this.log.error(`regenerate failed: ${this.formatErrorForLog(error)}`);
      this.store.markError(errorMessage(error));
      // Same failure policy as sendPrompt (policy 2026-10-16): banner + chime,
      // no OS toast — the four card/completion triggers are the only ones.
      void this.persistActiveTranscript();
      void this.touchActiveSession();
      this.postSound("error");
    }
  }

  /**
   * M2 P0-3: consume the queue when a slot is free. Dispatch order: the
   * `queueSendNowId` entry (Steer) if still present, else the FIFO head.
   * Gates: paused (error-pause), streaming/connecting (the next settle
   * re-dispatches), init/replay/history-sync windows. "error" status is
   * dispatchable — that is exactly what 继续 (resume) needs; the next
   * userPrompt clears the error banner itself.
   */
  private async dispatchQueue(): Promise<void> {
    if (this.disposed) return;
    const state = this.store.getState();
    if (state.queuePaused) return;
    const queue = state.queue ?? [];
    if (queue.length === 0) {
      this.queueSendNowId = null;
      return;
    }
    if (state.status === "streaming" || state.status === "connecting") return;
    if (state.initializing || state.replaying || this.historySyncBusy) return;
    let head: QueuedPromptUi | null = null;
    let next = queue;
    if (this.queueSendNowId) {
      const idx = queue.findIndex((q) => q.id === this.queueSendNowId);
      if (idx >= 0) {
        head = queue[idx]!;
        next = queue.filter((_, i) => i !== idx);
      }
      this.queueSendNowId = null;
    }
    if (!head) {
      const shifted = shiftQueuedUi(queue);
      head = shifted.head;
      next = shifted.queue;
    }
    if (!head) return;
    const payload = this.queuePayloads.get(head.id);
    this.queuePayloads.delete(head.id);
    this.store.setQueue(next, false);
    await this.sendPrompt(head.text, payload?.images, payload?.files, payload?.contexts);
  }

  /**
   * M2 P0-3: a real turn failure halts auto-dispatch (roadmap: every queued
   * message would hit the same broken endpoint — pause + warning, the queue
   * strip offers 继续/清空). No-op when nothing is queued.
   */
  private pauseQueueOnError(): void {
    const state = this.store.getState();
    const queue = state.queue ?? [];
    if (queue.length === 0) return;
    this.store.setQueue(queue, true);
    this.store.sendToast(
      "warning",
      vscode.l10n.t("本轮失败，队列已暂停（{0} 条待发送），可在队列条继续或清空", queue.length),
    );
  }

  /**
   * M2 P0-3: single clear point for the queue. Wired to `store.onStateReplaced`
   * (covers newSession / restoreSession / restartCli / profile-switch — every
   * wholesale state swap) and called explicitly by the delete-truncate path
   * (roadmap: truncating the transcript clears the queue, first version).
   */
  private clearQueue(): void {
    this.queuePayloads.clear();
    this.queueSendNowId = null;
    const state = this.store.getState();
    if ((state.queue?.length ?? 0) === 0 && !state.queuePaused) return;
    this.store.setQueue(clearQueueUi(), false);
  }

  /** M2 P0-3: webview queue-strip actions (edit/delete/move/sendNow/resume/clear). */
  private handleQueueAction(msg: Extract<WebviewToHost, { type: "queueAction" }>): void {
    const state = this.store.getState();
    const queue = state.queue ?? [];
    switch (msg.action) {
      case "edit": {
        const id = msg.id;
        const idx = id ? queue.findIndex((q) => q.id === id) : -1;
        if (!id || idx < 0) {
          if (msg.requestId !== undefined) {
            this.postToWebview({
              type: "queueEdited",
              requestId: msg.requestId,
              text: "",
              error: vscode.l10n.t("该队列消息已发送或清空"),
            });
          }
          return;
        }
        const entry = queue[idx]!;
        const payload = this.queuePayloads.get(id);
        this.queuePayloads.delete(id);
        this.store.setQueue(removeQueuedUi(queue, id), state.queuePaused ?? false);
        this.postToWebview({
          type: "queueEdited",
          requestId: msg.requestId ?? 0,
          text: entry.text,
          images: payload?.images,
          files: payload?.files,
          contexts: payload?.contexts,
        });
        break;
      }
      case "delete": {
        if (msg.id) this.queuePayloads.delete(msg.id);
        this.store.setQueue(removeQueuedUi(queue, msg.id ?? ""), state.queuePaused ?? false);
        break;
      }
      case "move": {
        if (msg.id && msg.delta) {
          this.store.setQueue(moveQueuedUi(queue, msg.id, msg.delta), state.queuePaused ?? false);
        }
        break;
      }
      case "sendNow": {
        if (!msg.id || !queue.some((q) => q.id === msg.id)) return;
        this.queueSendNowId = msg.id;
        if (state.status === "streaming") {
          // Steer: interrupt the current turn exactly like the Stop button
          // (settle the blocking cards first, then cancel the session); the
          // completion handler dispatches the marked entry first.
          this.cancelAllApprovals(vscode.l10n.t("用户打断并立即发送"));
          this.cancelAllPlanExits(vscode.l10n.t("用户打断并立即发送，计划审批已跳过"));
          this.cancelAllPendingQuestions(vscode.l10n.t("用户打断并立即发送"));
          this.cancelSeen = true;
          this.clearPostRejectionWatchdog();
          this.client?.cancel(state.sessionId ?? "");
        } else {
          void this.dispatchQueue();
        }
        break;
      }
      case "resume": {
        this.store.setQueue(queue, false);
        void this.dispatchQueue();
        break;
      }
      case "clear": {
        this.clearQueue();
        break;
      }
    }
  }

  /** M2 P0-4: per-kind section title for the prompt prefix (host l10n). */
  private contextSectionTitle(ctx: ContextRefUi): string {
    switch (ctx.kind) {
      case "code":
        return vscode.l10n.t("关于 `{0}:{1}`：", ctx.label, ctx.detail);
      case "folder":
        return vscode.l10n.t("文件夹 `{0}` 的直接子项清单：", ctx.label);
      case "problems":
        return vscode.l10n.t("工作区诊断（{0}）：", ctx.detail);
      case "git":
        return vscode.l10n.t("工作区 Git 状态与变更：");
      case "url":
        return vscode.l10n.t("网页内容（{0}）：", ctx.label);
      case "terminal":
        return vscode.l10n.t("终端最近命令与输出（{0}）：", ctx.detail);
    }
  }

  /**
   * Per-kind section title for the **agent-facing** prompt (English).
   *
   * The Chinese titles above are what the user reads in the transcript (the
   * composed context prefix is part of the user bubble) — they stay Chinese.
   * The model, however, gets an English prompt: the child session runs the
   * same English system prompt, so a Chinese header in the middle of it
   * reads like a language switch. Same discipline as the Super Agent labels
   * (Chinese for the board, English for the model).
   */
  private contextSectionTitleEn(ctx: ContextRefUi): string {
    switch (ctx.kind) {
      case "code":
        return `About \`${ctx.label}:${ctx.detail}\`:`;
      case "folder":
        return `Direct children of the folder \`${ctx.label}\`:`;
      case "problems":
        return `Workspace diagnostics (${ctx.detail}):`;
      case "git":
        return "Workspace git status and changes:";
      case "url":
        return `Web page content (${ctx.label}):`;
      case "terminal":
        return `Recent terminal commands and their output (${ctx.detail}):`;
    }
  }

  /**
   * Shared @problems body builder: the resolveContext card and the
   * diagnostics-watch "排队修复" action must inject the exact same report.
   * Returns `{error}` when there is nothing to report (the card would be
   * silently dropped by assembleContextSections otherwise).
   */
  private collectProblemsBody():
    | { label: string; detail: string; content: string }
    | { error: string } {
    const SEVERITY_LABELS = [vscode.l10n.t("错误"), vscode.l10n.t("警告"), vscode.l10n.t("信息"), vscode.l10n.t("提示")];
    const rows: { sev: number; path: string; line: number; message: string }[] = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      const rel = vscode.workspace.asRelativePath(uri.fsPath, false).replace(/\\/g, "/");
      for (const d of diags) {
        rows.push({
          sev: d.severity,
          path: rel,
          line: d.range.start.line + 1,
          message: d.message.replace(/\s+/g, " ").trim(),
        });
      }
    }
    if (rows.length === 0) return { error: vscode.l10n.t("当前没有诊断信息") };
    rows.sort((a, b) => a.sev - b.sev || a.path.localeCompare(b.path) || a.line - b.line);
    const capped = rows.slice(0, 200);
    let content = formatDiagnosticsReport(
      capped.map((r) => ({
        path: r.path,
        line: r.line,
        severityLabel: SEVERITY_LABELS[r.sev] ?? vscode.l10n.t("其他"),
        message: r.message,
      })),
    );
    if (rows.length > capped.length) {
      content += `\n${vscode.l10n.t("…（共 {0} 条，仅列出前 200 条）", rows.length)}`;
    }
    return {
      label: vscode.l10n.t("工作区诊断"),
      detail: vscode.l10n.t("{0} 条", rows.length),
      content,
    };
  }

  /**
   * Tool-card "在终端中打开/重跑": re-run the tool's shell command in a real
   * integrated terminal. The CLI's own execution is not attachable (its child
   * shell dies with the tool call, and dev-server style long processes are
   * killed by its timeouts), so interactive/long-running commands belong in a
   * user terminal — where the output also keeps streaming into the terminal
   * recorder for @terminal. `execute: false` prefills without running.
   */
  private runToolInTerminal(toolCallId: string, execute: boolean): void {
    const block = findToolBlockById(this.store.getState().blocks, toolCallId);
    const isShell =
      block !== null
      && (block.toolKind === "execute" || block.toolName.trim().toLowerCase() === "run_shell_command");
    if (!block || !isShell) {
      this.store.sendToast("warning", vscode.l10n.t("该工具卡没有可重跑的命令"));
      return;
    }
    const command = extractRerunnableCommand(block.input);
    if (!command) {
      this.store.sendToast("warning", vscode.l10n.t("命令缺失或过长已被截断，无法安全重跑"));
      return;
    }
    const cwd = this.sessionCwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    openInTerminal(command, cwd ?? undefined, execute);
  }

  // --- Diagnostics watch (评估结论 2026-10-19) ---------------------------------
  // "诊断变化自动推送给进行中的会话" is protocol-impossible in the literal
  // sense: ACP has no mid-turn injection channel — the CLI accepts exactly one
  // session/prompt per turn, and a queued prompt only dispatches after the
  // running turn settles. The feasible conservative form implemented here:
  // while a turn streams, watch the workspace error-diagnostic count against
  // the turn-start baseline (a rise is likely the agent's own half-finished
  // edit); surface ONE sticky toast per turn whose action enqueues a fix
  // request carrying a fresh @problems card (or sends it directly when the
  // turn already ended). Never auto-send: silently injecting a prompt burns
  // tokens and can derail the user's task.

  /** Error-diagnostic count at turn start; null = no turn streaming. */
  private diagBaselineErrors: number | null = null;
  /** One toast per turn (the count keeps fluctuating while edits land). */
  private diagNotifiedThisTurn = false;
  private diagDebounce: ReturnType<typeof setTimeout> | null = null;

  /** Called from store.onStateChange: arm/disarm the watch on status flips. */
  private trackDiagnosticsWatch(status: string): void {
    if (status === "streaming") {
      if (this.diagBaselineErrors === null) {
        this.diagBaselineErrors = this.countErrorDiagnostics();
        this.diagNotifiedThisTurn = false;
      }
    } else if (this.diagBaselineErrors !== null) {
      this.diagBaselineErrors = null;
      this.diagNotifiedThisTurn = false;
    }
  }

  private countErrorDiagnostics(): number {
    let count = 0;
    for (const [, diags] of vscode.languages.getDiagnostics()) {
      for (const d of diags) {
        if (d.severity === vscode.DiagnosticSeverity.Error) count++;
      }
    }
    return count;
  }

  /** Debounced evaluation behind `vscode.languages.onDidChangeDiagnostics`. */
  private onDiagnosticsChanged(): void {
    if (this.disposed || this.diagBaselineErrors === null || this.diagNotifiedThisTurn) return;
    if (this.diagDebounce) clearTimeout(this.diagDebounce);
    this.diagDebounce = setTimeout(() => {
      this.diagDebounce = null;
      const baseline = this.diagBaselineErrors;
      if (this.disposed || baseline === null || this.diagNotifiedThisTurn) return;
      if (this.store.getState().status !== "streaming") return;
      const now = this.countErrorDiagnostics();
      if (now <= baseline) return;
      this.diagNotifiedThisTurn = true;
      this.store.sendToast(
        "warning",
        vscode.l10n.t("检测到 {0} 条新增错误诊断（可能由本轮编辑引入）", now - baseline),
        { sticky: true, action: { actionId: "queue-diagnostics", label: vscode.l10n.t("排队修复") } },
      );
    }, DIAG_WATCH_DEBOUNCE_MS);
  }

  /** Toast action: enqueue (streaming) or directly send (idle) a fix request
   * carrying a fresh @problems card. */
  private async sendDiagnosticsFix(): Promise<void> {
    const res = this.collectProblemsBody();
    if ("error" in res) {
      this.store.sendToast("info", res.error);
      return;
    }
    // Model-facing request (it becomes the agent's prompt): English, and not
    // an l10n string — a translated instruction would flip the language in
    // the middle of an English prompt.
    const text =
      "Fix the error-level diagnostics in the current workspace (see the attached diagnostics list), then briefly describe what you changed.";
    const ctx: ContextRefUi = {
      id: `ctx-diag-${Date.now().toString(36)}`,
      kind: "problems",
      label: res.label,
      detail: res.detail,
      content: res.content,
    };
    // sendPrompt owns the busy path: while streaming it dispatches the
    // request as a child session (the main session only delegates).
    await this.sendPrompt(text, undefined, undefined, [ctx]);
  }

  /**
   * M2 P0-4: resolve an @mention context source into a card body. All four
   * sources are host-side (zero CLI dependency, roadmap). git goes through
   * async execFile (trap #18 — never sync); URL uses native node:http(s)
   * (trap #2 — the extension host patches global fetch with a proxy agent
   * that breaks on SOCKS/plain-host proxies).
   */
  private async resolveContext(requestId: number, kind: ContextKind, query: string): Promise<void> {
    const reply = (label: string, detail: string, content: string, error?: string): void => {
      this.postToWebview({ type: "contextResolved", requestId, kind, label, detail, content, error });
    };
    try {
      if (kind === "folder") {
        const rels = await this.loadWorkspaceFileRels();
        const folder = normalizeFolderRel(query);
        const body = buildFolderListing(rels, folder);
        if (body.trim() === "") {
          reply(query, "", "", vscode.l10n.t("该文件夹为空或不存在"));
          return;
        }
        const count = body.split("\n").filter((l) => l.startsWith("- ")).length;
        reply(folder === "" ? "./" : folder, vscode.l10n.t("{0} 个子项", count), body);
        return;
      }
      if (kind === "problems") {
        const res = this.collectProblemsBody();
        if ("error" in res) {
          reply("", "", "", res.error);
          return;
        }
        reply(res.label, res.detail, res.content);
        return;
      }
      if (kind === "terminal") {
        const recorder = getTerminalRecorder();
        if (!recorder.isAvailable()) {
          reply(
            "",
            "",
            "",
            vscode.l10n.t(
              "终端输出捕获不可用：需要 VS Code ≥ 1.93 且启用终端 Shell Integration（terminal.integrated.shellIntegration.enabled）",
            ),
          );
          return;
        }
        // Last 5 commands keep the card readable; the per-kind char cap in
        // assembleContextSections bounds the injected size anyway.
        const entries = recorder.snapshot().slice(-5);
        if (entries.length === 0) {
          reply("", "", "", vscode.l10n.t("尚无终端命令记录（在集成终端运行命令后重试）"));
          return;
        }
        reply(
          vscode.l10n.t("终端最近输出"),
          vscode.l10n.t("{0} 条命令", entries.length),
          buildTerminalReport(entries),
        );
        return;
      }
      if (kind === "git") {
        const cwd = this.sessionCwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!cwd) {
          reply("", "", "", vscode.l10n.t("没有打开的工作区"));
          return;
        }
        const run = async (args: string[]): Promise<string> => {
          const { stdout } = await execFileAsync("git", args, {
            cwd,
            timeout: GIT_CONTEXT_TIMEOUT_MS,
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024,
            encoding: "utf8",
          });
          return stdout;
        };
        let status: string;
        let diff: string;
        try {
          status = await run(["status", "--porcelain"]);
          diff = await run(["diff"]);
        } catch (error) {
          reply("", "", "", vscode.l10n.t("git 查询失败（工作区可能不是 git 仓库）：{0}", errorMessage(error)));
          return;
        }
        const truncated = diff.length > GIT_CONTEXT_MAX_CHARS;
        const body = buildGitReport(status, truncateChars(diff, GIT_CONTEXT_MAX_CHARS), truncated);
        reply(vscode.l10n.t("工作区 Git"), vscode.l10n.t("status + diff"), body);
        return;
      }
      if (kind === "url") {
        const raw = query.trim();
        const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
        if (!isHttpUrl(withScheme)) {
          reply(raw, "", "", vscode.l10n.t("仅支持 http/https 链接"));
          return;
        }
        const body = await this.fetchUrlText(withScheme);
        if (body.trim() === "") {
          // An empty card would be silently dropped by assembleContextSections
          // at send time — tell the user instead (SPA with no meta fallback).
          reply(withScheme, "", "", vscode.l10n.t("未能提取到文本内容（页面可能依赖 JS 渲染且无标题/描述）"));
          return;
        }
        const host = new URL(withScheme).hostname;
        reply(withScheme, host, body);
        return;
      }
      reply("", "", "", vscode.l10n.t("不支持的上下文类型"));
    } catch (error) {
      reply("", "", "", errorMessage(error));
    }
  }

  /**
   * M2 P0-4: fetch a URL as text (native node:http(s), trap #2). Follows at
   * most 3 redirects, caps the response at URL_MAX_RESPONSE_BYTES, extracts
   * text from HTML (crude tag-stripping), truncates to the @url char limit.
   */
  private fetchUrlText(url: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };
      const attempt = (target: string, redirectsLeft: number): void => {
        const mod = target.startsWith("https:") ? httpsGet : httpGet;
        const req = mod(target, {
          headers: {
            "user-agent": "iFlow-Harness/1.x (context fetch)",
            // identity: some servers gzip by default even unasked, and the
            // raw bytes would decode to binary garbage below.
            "accept-encoding": "identity",
          },
        }, (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume();
            let next: string;
            try {
              next = new URL(res.headers.location, target).toString();
            } catch {
              finish(() => reject(new Error(vscode.l10n.t("重定向地址无效"))));
              return;
            }
            if (!isHttpUrl(next)) {
              finish(() => reject(new Error(vscode.l10n.t("仅支持 http/https 链接"))));
              return;
            }
            attempt(next, redirectsLeft - 1);
            return;
          }
          if (status < 200 || status >= 300) {
            res.resume();
            finish(() => reject(new Error(vscode.l10n.t("HTTP {0}", status))));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size <= URL_MAX_RESPONSE_BYTES) chunks.push(c);
            else res.resume(); // keep draining; the cap truncates, the timeout must not fire
          });
          res.on("end", () => {
            const raw = decodeResponseText(Buffer.concat(chunks), res.headers["content-type"] ?? "");
            const isHtml = (res.headers["content-type"] ?? "").includes("html");
            const text = isHtml ? extractHtmlText(raw) : raw;
            finish(() => resolve(truncateChars(text, 64_000)));
          });
          res.on("error", (e) => finish(() => reject(e)));
        });
        req.setTimeout(URL_FETCH_TIMEOUT_MS, () => {
          req.destroy();
          finish(() => reject(new Error(vscode.l10n.t("抓取超时（{0}s）", URL_FETCH_TIMEOUT_MS / 1000))));
        });
        req.on("error", (e) => finish(() => reject(e)));
      };
      attempt(url, 3);
    });
  }

  /**
   * Delete a user message and its whole tail. The CLI history is truncated
   * first (verified, rewritten, reloaded, model/mode restored) so the model
   * forgets the deleted turns; the host transcript commits last, so any failed
   * step leaves the visible transcript intact. When the deleted tail is not in
   * the model context at all (compressed away, slash command, or the CLI
   * session file was never written), the transcript deletion stands on its own
   * — the model has nothing to forget.
   */
  private async deleteUserMessage(
    blockId: string,
    reason: "deleteMessage" | "rollback" = "deleteMessage",
  ): Promise<void> {
    if (this.disposed || this.historySyncBusy) return;
    const state = this.store.getState();
    if (
      state.initializing || state.replaying || state.status === "streaming" || state.status === "connecting" ||
      state.pendingApproval || state.pendingQuestions || state.pendingPlanExit
    ) {
      this.store.appendNotice(vscode.l10n.t("正在生成、连接或等待确认，请先完成当前操作后再删除消息"));
      return;
    }
    const removed = this.store.deleteUserMessage(blockId, false);
    if (!removed) return;
    // Transcript-only delete: nothing to verify when the CLI session does not
    // exist (never prompted / file lost), so the model cannot be holding turns
    // the transcript is about to drop.
    const sessionId = state.sessionId;
    const client = this.client;
    if (!sessionId || !client) {
      this.commitTranscriptOnlyDeletion(blockId);
      return;
    }
    const cwd = this.sessionCwd ?? this.services.workspaceRoot ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.context.extensionUri.fsPath;
    const file = acpSessionFilePath(sessionId);
    this.historySyncBusy = true;
    this.store.setInitializing(true, reason);
    // No cancelAll* here: the entry gate above excludes every pending card and
    // the lock (plus the webview's locked composer) keeps new ones from
    // arriving mid-sync — the agent only pushes cards in response to a prompt.
    let raw: string | null = null;
    let reloadAttempted = false;
    try {
      let truncated = false;
      try {
        raw = await readFile(file, "utf8");
        const parsed = JSON.parse(raw) as { chatHistory?: unknown };
        const cut = findCliHistoryCut(parsed.chatHistory, removed.allUserTexts, removed.targetIndex);
        if (cut.kind === "refuse") throw new Error("CLI history cannot be matched exactly");
        if (cut.kind === "truncate") {
          if (!Array.isArray(parsed.chatHistory)) throw new Error("CLI history is malformed");
          parsed.chatHistory.splice(cut.index);
          const tmp = `${file}.tmp`;
          await writeFile(tmp, JSON.stringify(parsed), "utf8");
          await rename(tmp, file);
          truncated = true;
          reloadAttempted = true;
          await client.loadSession({
            cwd,
            mcpServers: [],
            sessionId,
            settings: mainSessionSettings(),
          });
          if (this.disposed || this.client !== client || this.store.getState().sessionId !== sessionId) {
            throw new Error("session changed during history synchronization");
          }
          const after = this.store.getState();
          if (after.modes?.currentModeId) await client.setMode(sessionId, after.modes.currentModeId);
          if (after.currentModelId) await client.setModel(sessionId, after.currentModelId);
        }
      } catch (error) {
        if (raw !== null) {
          try {
            await writeFile(file, raw, "utf8");
            if (reloadAttempted && !this.disposed && this.client === client) {
              await client.loadSession({
                cwd,
                mcpServers: [],
                sessionId,
                settings: mainSessionSettings(),
              });
            }
          } catch (rollbackError) {
            this.log.error(`deleteUserMessage: rollback FAILED: ${this.formatErrorForLog(rollbackError)}`);
          }
        }
        this.log.warn(`deleteUserMessage failed; transcript retained: ${errorMessage(error)}`);
        this.store.sendToast("warning", vscode.l10n.t("无法在模型上下文中验证该消息，已保留原转录。"));
        return;
      }
      if (truncated) {
        if (!this.store.commitUserMessageDeletion(blockId)) throw new Error("message changed during deletion");
        // M2 P0-3: the transcript was truncated — queued prompts belong to
        // the deleted tail's future, drop them (roadmap: 截断即清空队列).
        this.clearQueue();
        // M3 P0-1: the deleted turns' checkpoints anchor to gone user blocks.
        this.pruneCheckpointIndexAfterTruncation();
      } else {
        // skip: the deleted tail never reached (or already left) the model
        // context — drop it from the transcript and say so plainly.
        this.log.info(`deleteUserMessage: target not in CLI context — transcript-only delete`);
        this.commitTranscriptOnlyDeletion(blockId);
        this.store.appendNotice(vscode.l10n.t("该消息已不在模型上下文中，仅从当前转录移除。"));
        return;
      }
      // The deleted turn may have been the only content — an empty transcript
      // is the durable tombstone proving the deletion (force + allowEmpty is
      // the ONLY place an empty write is legal, see persistActiveTranscript).
      await this.persistActiveTranscript(true, true);
      void this.touchActiveSession();
    } finally {
      this.historySyncBusy = false;
      if (!this.disposed && this.store.getState() === state && this.client === client) {
        this.store.setInitializing(false);
      }
    }
  }

  /** Commit a transcript-only user-message deletion (no CLI history involved)
   * and persist it with the same empty-transcript rules as the full path. */
  private commitTranscriptOnlyDeletion(blockId: string): void {
    if (!this.store.commitUserMessageDeletion(blockId)) return;
    // M2 P0-3: same truncate-clears-queue rule as the full delete path.
    this.clearQueue();
    // M3 P0-1: same checkpoint prune as the full delete path.
    this.pruneCheckpointIndexAfterTruncation();
    void this.persistActiveTranscript(true, true);
    void this.touchActiveSession();
  }

  /**
   * M4 P1-9 — edit a historical user message and re-send it (Cline semantics,
   * roadmap P1-9). Three steps, each reusing an existing chain:
   * 1. restore the turn's checkpoint files FIRST (when the snapshot is
   *    complete) so the re-run starts from the pre-turn workspace — same
   *    unsaved-editor / modal confirmations as restoreCheckpoint "files";
   *    cancelling the modal aborts the whole operation. Without a usable
   *    checkpoint the flow degrades to truncate-and-resend with a warning
   *    toast (roadmap: 无 checkpoint 时降级为纯截断重发并提示).
   * 2. truncate the turn and everything after it via deleteUserMessage
   *    (transcript + CLI chatHistory + reload, queue/Checkpoint prune inside).
   * 3. re-send the edited text through sendPrompt — the normal turn pipeline
   *    (context assembly, checkpoint capture, auto-retry) applies unchanged.
   * If step 2 refused (history unverifiable → the block is still in the
   * transcript) the resend is skipped: firing on top of a stale turn would
   * duplicate it.
   */
  private async editAndResend(blockId: string, text: string): Promise<void> {
    if (this.disposed || this.historySyncBusy) return;
    const trimmed = text.trim();
    if (!trimmed) {
      this.store.appendNotice(vscode.l10n.t("编辑后的消息为空，未发送"));
      return;
    }
    const state = this.store.getState();
    if (
      state.initializing || state.replaying || state.status === "streaming" || state.status === "connecting" ||
      state.pendingApproval || state.pendingQuestions || state.pendingPlanExit
    ) {
      this.store.appendNotice(vscode.l10n.t("正在生成、连接或等待确认，请先完成当前操作后再编辑消息"));
      return;
    }
    const target = state.blocks.find((b) => b.kind === "user" && b.id === blockId);
    if (!target || target.kind !== "user") return;
    // 1. Files first — the same order and confirmations as restoreCheckpoint
    //    "both", so a cancelled modal leaves transcript and CLI untouched.
    const sessionId = state.activeSessionId ?? state.sessionId;
    const entry = sessionId ? (state.checkpoints ?? []).find((c) => c.userBlockId === blockId) : undefined;
    if (sessionId && entry && entry.sha && !entry.partial) {
      const restored = await this.confirmAndRestoreCheckpointFiles(sessionId, entry);
      if (!restored) return;
    } else {
      this.store.sendToast("warning", vscode.l10n.t("该轮没有可用的工作区文件快照，仅截断对话后重发。"));
    }
    // 2. Full truncation (transcript + CLI history + session reload).
    await this.deleteUserMessage(blockId, "rollback");
    if (this.disposed) return;
    if (this.store.getState().blocks.some((b) => b.kind === "user" && b.id === blockId)) {
      // The delete refused (or the session moved on mid-sync) — the turn is
      // still in the transcript; resending would duplicate it.
      this.log.info(`editAndResend: truncation of ${blockId} did not land — resend skipped`);
      return;
    }
    // 3. Edited text rides the normal prompt pipeline (new user block, fresh
    //    checkpoint, queue/retry semantics all apply).
    await this.sendPrompt(trimmed);
  }

  /**
   * Prompt with bounded reactive auto-retry (rate limits get several
   * escalating attempts — see RATE_LIMIT_RETRY_DELAYS_MS for why one was
   * not enough).
   *
   * Why this exists — Wire behavior (probed, CLI 0.5.19 bundle):
   * - The interactive CLI retries a turn after the gateway rejects it with
   *   "Content length exceed LLM Limit": `RY.run`'s catch calls
   *   `tryCompressChat(promptId, true, true)` (forced full compression) and
   *   loops once.
   * - The ACP adapter (`v2t.prompt`) has NO such catch: its turn loop
   *   rethrows non-429 errors, so an over-long session surfaces here as a
   *   rejected `session/prompt` and the UI just errors out.
   * - The adapter's per-turn `tryCompressChat` gate can also mis-gate: in
   *   openai-compatible mode `countTokens` is a chars/4 estimate over
   *   request text (or the last response's usage), so the 0.6/0.8 ratio
   *   thresholds against `tokensLimit` may never be reached before the real
   *   gateway limit trips.
   * - Gateway rate limits (provider 429 / 平台速率限制 phrasing) surface the
   *   same way as a rejected `session/prompt` — the CLI's own retry loop
   *   only covers a subset of shapes, and a dead turn must be manually
   *   re-sent otherwise.
   *
   * Recovery:
   * - context overflow (once per send) → drive the `/compress` slash command
   *   (`handleAcpSlashCommand` bridges it to the forced full compression,
   *   bypassing the ratio gate; its result leaks as a compression JSON chunk
   *   that the transcript sanitizer renders as a card) → resend the original
   *   prompt.
   * - rate limit (up to RATE_LIMIT_RETRY_DELAYS_MS.length per send) →
   *   notify the user, wait the escalating delay, resend whatever turn was
   *   pending — the `/compress` turn included: it runs through this same
   *   loop (`compressNext`), so a rate-limited compression no longer falls
   *   straight to the error banner. A Stop pressed during the wait aborts
   *   the retry (the loop re-checks `cancelSeen`; the sendPrompt catch still
   *   shows the rate-limit error banner).
   * - transient mid-stream drop (up to TRANSIENT_STREAM_RETRY_DELAYS_MS.length
   *   per send) → the gateway killing the SSE stream mid-turn surfaces as
   *   `Internal Error: terminated` (undici body-stream abort, see
   *   isTransientStreamError); long sessions trip it most. Same retry shape
   *   as rate limits with a shorter ladder.
   * - empty response (up to EMPTY_RESPONSE_RETRY_DELAYS_MS.length per send) →
   *   the gateway answers 200 with no content: the CLI records an empty model
   *   turn and returns `end_turn` with zero output, which the panel used to
   *   render as a silent no-op (the "发消息没反应" report). Detected via
   *   `turnHadAgentOutput`; after the ladder the turn lands on the error
   *   banner (EmptyResponseError) instead of staying silent.
   * All paths are bounded, so a prompt that keeps failing lands on the
   * normal error path after the last attempt.
   *
   * Compress ceiling: a `/compress` attempt (the overflow recovery below, the
   * manual 立即压缩 action, the turn-end auto-compress) may be bounded by
   * `iflow.compressTimeoutSeconds`. 0 (the default) means no ceiling — a huge
   * session can legitimately take minutes to compress. On expiry the local
   * watchdog abandons the JSON-RPC request; the CLI turn keeps running, so the
   * catch chain cancels it and re-throws a CompressTimeoutError.
   */
  private async promptWithRetry(
    client: AcpClient,
    sessionId: string,
    prompt: ContentBlock[],
  ): Promise<PromptResponse> {
    let compressNext = false; // next attempt sends /compress instead of prompt
    let overflowRecovered = false;
    let rateLimitRetries = 0;
    let transientStreamRetries = 0;
    let emptyResponseRetries = 0;
    // Persistent display-only pill shown while the auto-compress turn runs;
    // dismissed once that turn ends (or the loop gives up) so it never lingers.
    let compressToastId: number | null = null;
    try {
      for (;;) {
        // A Stop pressed while this turn was still being prepared (the
        // checkpoint snapshot runs between `userPrompt` — which flips the
        // status to streaming — and the request going out) must not be lost.
        // The CLI has nothing in flight yet, so `session/cancel` cannot reach
        // it; settle the turn locally as cancelled instead of starting it.
        if (this.cancelSeen) return { stopReason: "cancelled" };
        const blocks: ContentBlock[] = compressNext
          ? [{ type: "text", text: "/compress" }]
          : prompt;
        // "Compressing" indicator: true for the overflow retry's /compress
        // attempt AND for turns that ARE a /compress from the start
        // (runCompressTurn pill action, maybeAutoCompressOnIdle). Cleared in
        // the finally below and on every non-compress attempt.
        const firstBlock = blocks[0];
        const isCompressAttempt =
          compressNext ||
          (firstBlock?.type === "text" && firstBlock.text.trimStart() === "/compress");
        this.store.setCompressing(isCompressAttempt);
        // Fresh output flag per attempt: the gate below judges THIS attempt
        // only (a compress turn's own output must not mask an empty resend).
        this.turnHadAgentOutput = false;
        // M4 P1-1: auto-approval transcript notes dedupe per turn — a new
        // attempt (or turn) may legitimately re-note the same rule hit.
        this.autoApprovalNoted.clear();
        try {
          // A `/compress` turn may be given a wall-clock ceiling
          // (`iflow.compressTimeoutSeconds`); 0 keeps the historical
          // behaviour of an unbounded turn (a huge session can legitimately
          // take minutes to compress — pitfall #13). Regular turns pass no
          // per-call timeout at all, so they keep the AcpClient option's
          // behaviour (unset = no ceiling: a user task may run for hours).
          const compressTimeoutMs = isCompressAttempt ? this.compressTimeoutMs() : undefined;
          const result = await this.awaitPrompt(client, sessionId, blocks, compressTimeoutMs);
          if (!compressNext) {
            // Empty-response gate (see EMPTY_RESPONSE_RETRY_DELAYS_MS): the
            // gateway answered 200 with no content, the CLI recorded an empty
            // model turn and returned end_turn — the panel would show the user
            // bubble with nothing after it and NO error (the "发消息没反应"
            // report). Slash commands are exempt: the CLI handles them locally
            // and legitimately returns end_turn with no agent output.
            // (toAgentPromptText prefixes a zero-width space to unknown
            // "/"-leading text, which trimStart keeps — only real commands
            // still start with "/" here.)
            const first = blocks[0];
            const isSlash = first?.type === "text" && first.text.trimStart().startsWith("/");
            if (
              result.stopReason === "end_turn" &&
              !isSlash &&
              !this.turnHadAgentOutput &&
              !this.cancelSeen
            ) {
              if (emptyResponseRetries < EMPTY_RESPONSE_RETRY_DELAYS_MS.length) {
                const delayMs = EMPTY_RESPONSE_RETRY_DELAYS_MS[emptyResponseRetries]!;
                emptyResponseRetries++;
                this.log.warn(
                  `empty model response on session ${sessionId}, auto-retry ${emptyResponseRetries}/${EMPTY_RESPONSE_RETRY_DELAYS_MS.length} in ${delayMs / 1000}s`,
                );
                this.store.sendToast(
                  "warning",
                  vscode.l10n.t(
                    "模型返回了空响应，自动重试中（第 {0}/{1} 次）",
                    emptyResponseRetries,
                    EMPTY_RESPONSE_RETRY_DELAYS_MS.length,
                  ),
                  { countdownDeadline: Date.now() + delayMs },
                );
                await abortableDelay(delayMs, () => this.cancelSeen);
                if (this.cancelSeen) return result; // user pressed Stop during the wait
                continue;
              }
              // Ladder exhausted: surface it loudly instead of the silent
              // no-output turn the user used to be stuck with.
              throw new Error(
                vscode.l10n.t("模型连续返回空响应，自动重试后仍未恢复。可稍后重试，或切换其他 API 配置。"),
              );
            }
            return result;
          }
          // Compress turn finished: fall through to resending the original
          // prompt. User hit Stop while it ran: do not resurrect the prompt
          // behind their back — surface the cancellation as the final
          // stopReason instead.
          if (compressToastId !== null) {
            this.store.dismissToast(compressToastId);
            compressToastId = null;
          }
          compressNext = false;
          if (result.stopReason === "cancelled") return result;
        } catch (error) {
          // The empty-response ladder already ran; never re-classify it as a
          // rate limit (its wording contains "稍后重试").
          if (error instanceof EmptyResponseError) throw error;
          if (isCompressAttempt && isRequestTimeoutError(error)) {
            // The compress turn blew `iflow.compressTimeoutSeconds`. The
            // local watchdog abandoned the JSON-RPC request, but the CLI turn
            // is STILL running — cancel it, or the session keeps streaming a
            // compression nobody waits for.
            this.log.warn(
              `compress turn timed out on session ${sessionId}: ${this.formatErrorForLog(error)}`,
            );
            client.cancel(sessionId);
            throw new CompressTimeoutError(Math.round(this.compressTimeoutMs() / 1000));
          }
          if (isContextOverflowError(error) && !overflowRecovered) {
            overflowRecovered = true;
            compressNext = true;
            this.log.warn(
              `context overflow on session ${sessionId}, auto-compressing and retrying: ${this.formatErrorForLog(error)}`,
            );
            compressToastId = this.store.sendToast(
              "info",
              vscode.l10n.t("上下文长度已达模型上限，自动压缩会话后重试…"),
              { displayOnly: true, persistent: true },
            );
            continue;
          }
          if (
            isRateLimitError(error) &&
            rateLimitRetries < RATE_LIMIT_RETRY_DELAYS_MS.length
          ) {
            const delayMs = RATE_LIMIT_RETRY_DELAYS_MS[rateLimitRetries]!;
            rateLimitRetries++;
            this.log.warn(
              `rate limit on session ${sessionId}, auto-retry ${rateLimitRetries}/${RATE_LIMIT_RETRY_DELAYS_MS.length} in ${delayMs / 1000}s: ${this.formatErrorForLog(error)}`,
            );
            this.store.sendToast(
              "warning",
              vscode.l10n.t(
                "模型触发平台速率限制，自动重试中（第 {0}/{1} 次）",
                rateLimitRetries,
                RATE_LIMIT_RETRY_DELAYS_MS.length,
              ),
              { countdownDeadline: Date.now() + delayMs },
            );
            await abortableDelay(delayMs, () => this.cancelSeen);
            if (this.cancelSeen) throw error; // user pressed Stop during the wait
            continue;
          }
          if (
            isTransientStreamError(error) &&
            transientStreamRetries < TRANSIENT_STREAM_RETRY_DELAYS_MS.length
          ) {
            const delayMs = TRANSIENT_STREAM_RETRY_DELAYS_MS[transientStreamRetries]!;
            transientStreamRetries++;
            this.log.warn(
              `transient stream drop on session ${sessionId}, auto-retry ${transientStreamRetries}/${TRANSIENT_STREAM_RETRY_DELAYS_MS.length} in ${delayMs / 1000}s: ${this.formatErrorForLog(error)}`,
            );
            this.store.sendToast(
              "warning",
              vscode.l10n.t(
                "模型响应流中断，自动重试中（第 {0}/{1} 次）",
                transientStreamRetries,
                TRANSIENT_STREAM_RETRY_DELAYS_MS.length,
              ),
              { countdownDeadline: Date.now() + delayMs },
            );
            await abortableDelay(delayMs, () => this.cancelSeen);
            if (this.cancelSeen) throw error; // user pressed Stop during the wait
            continue;
          }
          throw error;
        }
      }
    } finally {
      // Belt-and-braces: any exit path that didn't dismiss the compress pill
      // (final failure, cancellation) removes it here so it never lingers.
      if (compressToastId !== null) {
        this.store.dismissToast(compressToastId);
      }
      // The turn is over on every exit path — a post-rejection watchdog armed
      // mid-turn has nothing left to guard.
      this.clearPostRejectionWatchdog();
      // The "正在压缩" indicator must never outlive the loop (a failed
      // compress or a Stop mid-compress would otherwise strand the pill).
      this.store.setCompressing(false);
    }
  }

  /**
   * Issue one `session/prompt` and track that the CLI now owns a request for
   * this session — the gate `sendTurnCancel` needs before it may write
   * `session/cancel` (see `promptRequestSessionId`).
   */
  private async awaitPrompt(
    client: AcpClient,
    sessionId: string,
    blocks: ContentBlock[],
    timeoutMs?: number,
  ): Promise<PromptResponse> {
    this.promptRequestSessionId = sessionId;
    this.cancelSentForPrompt = false;
    try {
      return await client.prompt({ sessionId, prompt: blocks }, timeoutMs);
    } finally {
      this.promptRequestSessionId = null;
    }
  }

  /** Full error detail for the Output log: inspect() keeps JSON-RPC envelope
   * shapes (code/data) readable, plus the recent CLI stderr tail if any. */
  private formatErrorForLog(error: unknown): string {
    let text: string;
    try {
      text = inspect(error, { depth: 5, maxArrayLength: 50, breakLength: Infinity });
    } catch {
      text = String(error);
    }
    if (this.stderrTail.length > 0) {
      text += `\nCLI stderr tail:\n${this.stderrTail.join("\n")}`;
    }
    return text;
  }

  /**
   * Snapshot the active session's transcript into the extension-owned file
   * store (M4). P2: the payload is written as this session's own file on the
   * persist chain — the old workspaceState map made each persist a read-all +
   * clone + write-all of every session.
   * P1 debounce: 11 call sites used to stringify the whole transcript
   * synchronously per event (a long session = several MB per stringify on
   * the host's event loop). Now the stringify is coalesced: one run per
   * PERSIST_DEBOUNCE_MS window (dirty flag), executed on the persist chain
   * after a setImmediate yield. `force: true` bypasses the debounce for
   * must-not-lose moments (restore seeding, pre-dispose flush).
   */
  private persistTimer: NodeJS.Timeout | null = null;
  private persistDirty = false;
  private static readonly PERSIST_DEBOUNCE_MS = 500;

  private persistActiveTranscript(force = false, allowEmpty = false): Promise<void> {
    const state = this.store.getState();
    const id = state.activeSessionId ?? state.sessionId;
    // Empty transcripts are only durable where a deletion left them (tombstone,
    // `allowEmpty`); every other caller (dispose flush, restore seed, turn end)
    // must keep skipping empty writes — otherwise an unused auto-session would
    // gain a transcript file, defeating hasPersistedTranscript's "dead husk"
    // detection (prune keeps it, restoreLastSession restores a broken empty
    // shell instead of falling back to the last real conversation).
    if (!id || (state.blocks.length === 0 && !allowEmpty)) return Promise.resolve();
    if (force) {
      // Cancel any pending debounced run — this forced write supersedes it.
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      this.persistDirty = false;
      const label = state.sessions.find((s) => s.id === id)?.label ?? DEFAULT_SESSION_LABEL;
      return this.enqueueTranscriptWrite(id, () =>
        this.serializeTranscript(label, this.store.getState().blocks),
      );
    }
    this.persistDirty = true;
    if (this.persistTimer) return this.persistChain;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (!this.persistDirty) return;
      this.persistDirty = false;
      void this.flushDirtyTranscript();
    }, ChatPanel.PERSIST_DEBOUNCE_MS);
    return this.persistChain;
  }

  /** Debounced flush: serialize + enqueue on the persist chain. */
  private flushDirtyTranscript(): void {
    const state = this.store.getState();
    const id = state.activeSessionId ?? state.sessionId;
    if (!id || state.blocks.length === 0) return;
    const label = state.sessions.find((s) => s.id === id)?.label ?? DEFAULT_SESSION_LABEL;
    this.enqueueTranscriptWrite(id, () => this.serializeTranscript(label, state.blocks));
  }

  // --- Turn-level checkpoints (M3 P0-1) ------------------------------------------

  private checkpointSettingEnabled(): boolean {
    return vscode.workspace.getConfiguration("iflow").get<boolean>("checkpoints", true);
  }

  /** Work tree the shadow repo mirrors = the session cwd (pitfall #8). */
  private checkpointCwd(): string {
    return this.sessionCwd ?? this.services.workspaceRoot ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.context.extensionUri.fsPath;
  }

  /**
   * Snapshot the workspace for the turn about to start. Awaited by sendPrompt
   * BEFORE the CLI prompt is issued — a parallel capture would race the
   * agent's own writes and bake them into the "before" snapshot. Returns the
   * commit sha (null = partial: git missing / init failed / timed out / over
   * the file cap); the reason is toasted once per session.
   */
  private async captureWorkspaceSnapshot(sessionId: string, text: string): Promise<string | null> {
    if (!this.checkpointSettingEnabled()) return null;
    const cfg = vscode.workspace.getConfiguration("iflow");
    this.checkpoints.setMaxFiles(cfg.get<number>("checkpointMaxFiles", 50_000));
    const maxFileMB = cfg.get<number>("checkpointMaxFileMB", 300);
    this.checkpoints.setMaxFileBytes(maxFileMB * 1024 * 1024);
    const reason = await this.checkpoints.ensureReady(sessionId, this.checkpointRoot(), this.checkpointCwd());
    if (reason) {
      if (!this.checkpointWarnedSessions.has(sessionId)) {
        this.checkpointWarnedSessions.add(sessionId);
        this.store.sendToast("warning", vscode.l10n.t("本轮起工作区快照不可用（{0}），回滚将只处理对话。", reason));
      }
      return null;
    }
    const label = checkpointLabelFromText(text);
    const sha = await this.checkpoints.captureTurn(sessionId, label || vscode.l10n.t("轮次快照"));
    const skipped = this.checkpoints.skippedFiles(sessionId);
    if (sha && skipped > 0 && !this.checkpointSkippedWarnedSessions.has(sessionId)) {
      this.checkpointSkippedWarnedSessions.add(sessionId);
      this.store.sendToast(
        "warning",
        vscode.l10n.t("本轮快照已跳过 {0} 个超过大小限制的文件；这些文件不会参与文件回滚。", skipped),
      );
    }
    return sha;
  }

  /** Record one turn's checkpoint into the store projection + index file. */
  private recordCheckpoint(sessionId: string, entry: CheckpointUi): void {
    if (this.disposed) return;
    const state = this.store.getState();
    // Session switched (or the panel moved on) while the capture was running.
    if ((state.activeSessionId ?? state.sessionId) !== sessionId) return;
    const next = upsertCheckpoint(state.checkpoints ?? [], entry);
    this.store.setCheckpoints(next);
    void this.persistCheckpointIndex(sessionId, next);
    void this.enforceCheckpointRetention(sessionId);
  }

  /**
   * Post-capture retention (settings: checkpointMaxTurns / checkpointMaxSizeMB,
   * 0 = off). Runs fire-and-forget after a turn's checkpoint is recorded —
   * never blocks the prompt, failures only log (the next capture retries).
   *
   * Turn cap: prune the shadow repo to the newest N captures (rewritten
   * chain + gc) and rewrite the live index with the new shas.
   * Size cap: whole-session LRU eviction under the global byte budget —
   * per-turn gc cannot shrink a single huge capture (one GGUF set IS one
   * snapshot), only dropping stale sessions reclaims that. The active
   * session is never evicted. Orphan stores (no index after an idle window,
   * or an index without a single restorable sha — the partial-only /
   * corrupt-repo residue) are reclaimed unconditionally.
   */
  private async enforceCheckpointRetention(sessionId: string): Promise<void> {
    if (this.disposed) return;
    const cfg = vscode.workspace.getConfiguration("iflow");
    const maxTurns = cfg.get<number>("checkpointMaxTurns", 0);
    const maxSizeMB = cfg.get<number>("checkpointMaxSizeMB", 0);
    const state = this.store.getState();
    const activeId = state.activeSessionId ?? state.sessionId;

    if (maxTurns > 0 && activeId === sessionId) {
      const list = state.checkpoints ?? [];
      const { kept, dropped } = planCheckpointRetention(list, maxTurns);
      if (dropped.length > 0) {
        const keptShas = [...new Set(kept.map((c) => c.sha).filter((s): s is string => !!s))];
        try {
          const mapping = keptShas.length > 0
            ? await this.checkpoints.pruneToKeptShas(sessionId, keptShas)
            : [];
          if (this.disposed) return;
          const live = this.store.getState();
          if ((live.activeSessionId ?? live.sessionId) !== sessionId) return;
          const remap = new Map(mapping.map((m) => [m.oldSha, m.newSha]));
          const rewritten = kept.map((c) =>
            c.sha && remap.has(c.sha) ? { ...c, sha: remap.get(c.sha)! } : c);
          this.store.setCheckpoints(rewritten);
          void this.persistCheckpointIndex(sessionId, rewritten);
          this.log.info(`checkpoint retention: dropped ${dropped.length} turn(s) for ${sessionId}`);
        } catch (error) {
          this.log.warn(`checkpoint retention failed for ${sessionId}: ${errorMessage(error)}`);
        }
      }
    }

    if (maxSizeMB <= 0) return;
    const root = this.checkpointRoot();
    let names: string[];
    try {
      const entries = await readdir(root, { withFileTypes: true });
      names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return; // no store dir yet
    }
    const scored: Array<{ name: string; bytes: number; lastUsed: number }> = [];
    for (const name of names) {
      const dir = path.join(root, name);
      const bytes = await CheckpointManager.dirSizeBytes(dir);
      let lastUsed = 0;
      try {
        lastUsed = (await stat(path.join(dir, "index.json"))).mtimeMs;
      } catch {
        try {
          lastUsed = (await stat(dir)).mtimeMs;
        } catch {
          // vanished mid-scan
        }
      }
      scored.push({ name, bytes, lastUsed });
    }
    const activeDir = activeId ? CheckpointManager.safeSessionId(activeId) : null;
    // Orphans: index-less stores idle >10 min (crashed capture / corrupt repo
    // — the idle guard avoids racing a brand-new session's first capture),
    // or an index whose entries have no restorable sha at all.
    const removed = new Set<string>();
    for (const s of scored) {
      if (s.name === activeDir) continue;
      try {
        const parsed = parseCheckpointIndex(await readFile(path.join(root, s.name, "index.json"), "utf8"));
        if (!parsed || !parsed.some((c) => c.sha)) removed.add(s.name);
      } catch {
        if (Date.now() - s.lastUsed > 10 * 60 * 1000) removed.add(s.name);
      }
    }
    let total = scored.reduce((sum, s) => sum + (removed.has(s.name) ? 0 : s.bytes), 0);
    const budget = maxSizeMB * 1024 * 1024;
    for (const s of [...scored].sort((a, b) => a.lastUsed - b.lastUsed)) {
      if (total <= budget) break;
      if (removed.has(s.name) || s.name === activeDir) continue;
      removed.add(s.name);
      total -= s.bytes;
    }
    if (removed.size === 0) return;
    const freedBytes = scored
      .filter((s) => removed.has(s.name))
      .reduce((sum, s) => sum + s.bytes, 0);
    for (const name of removed) {
      await rm(path.join(root, name), { recursive: true, force: true }).catch(() => undefined);
    }
    this.log.info(`checkpoint retention: removed ${removed.size} store dir(s), freed ${Math.round(freedBytes / (1024 * 1024))} MB`);
    this.store.sendToast(
      "info",
      vscode.l10n.t("已按上限清理 {0} 份旧快照（释放约 {1} MB）", removed.size, Math.round(freedBytes / (1024 * 1024))),
      { durationMs: 8000 },
    );
  }

  /** Atomic index write (temp + rename), serialized on its own chain. */
  private persistCheckpointIndex(sessionId: string, checkpoints: readonly CheckpointUi[]): Promise<void> {
    const run = this.checkpointPersistChain
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(async () => {
        const target = this.checkpointIndexPath(sessionId);
        await mkdir(path.dirname(target), { recursive: true });
        const tmp = `${target}.tmp`;
        await writeFile(tmp, serializeCheckpointIndex(checkpoints), "utf8");
        await rename(tmp, target);
      });
    this.checkpointPersistChain = run.catch(() => {});
    return run;
  }

  /**
   * Phase 1 of the restore wiring: read the persisted index (whose anchors
   * are the ORIGINAL block ids — the transcript file is lossless) and reopen
   * the shadow repo so file restores work. Must run BEFORE
   * `reassignBlockIds` re-mints the ids; the raw list is kept for
   * {@link finalizeCheckpointIndex}. Silent no-op when the session predates
   * the feature.
   */
  private async loadCheckpointIndex(sessionId: string): Promise<void> {
    this.pendingCheckpointIndex = null;
    let raw: string;
    try {
      raw = await readFile(this.checkpointIndexPath(sessionId), "utf8");
    } catch {
      return; // no index — nothing to restore
    }
    const parsed = parseCheckpointIndex(raw);
    if (!parsed || parsed.length === 0) return;
    if (this.checkpointSettingEnabled()) {
      const lastSha = [...parsed].reverse().find((c) => c.sha)?.sha ?? null;
      await this.checkpoints.reopen(sessionId, this.checkpointRoot(), this.checkpointCwd(), lastSha);
    }
    this.pendingCheckpointIndex = { sessionId, checkpoints: parsed };
  }

  /**
   * Phase 2: after `replaceTranscript` re-minted the block ids, re-anchor the
   * loaded index to the live ids (old→new map captured by the caller around
   * the re-mint) and push the projection. No-op when phase 1 found nothing
   * or the session changed meanwhile.
   */
  private finalizeCheckpointIndex(remap: ReadonlyMap<string, string>): void {
    const pending = this.pendingCheckpointIndex;
    this.pendingCheckpointIndex = null;
    if (!pending) return;
    const state = this.store.getState();
    if (state.activeSessionId !== pending.sessionId) return;
    const reanchored = reanchorCheckpoints(pending.checkpoints, remap);
    if (reanchored.length > 0) this.store.setCheckpoints(reanchored);
  }

  /** Drop checkpoints whose anchor user block no longer exists (truncation). */
  private pruneCheckpointIndexAfterTruncation(): void {
    const state = this.store.getState();
    const sessionId = state.activeSessionId ?? state.sessionId;
    const list = state.checkpoints ?? [];
    if (!sessionId || list.length === 0) return;
    const pruned = pruneCheckpointsForBlocks(list, state.blocks);
    if (pruned.length === list.length) return;
    this.store.setCheckpoints(pruned);
    void this.persistCheckpointIndex(sessionId, pruned);
  }

  /** Delete a session's shadow repo (session deleted / pruned as dead). */
  private async removeCheckpointsForSession(sessionId: string): Promise<void> {
    this.checkpointWarnedSessions.delete(sessionId);
    this.checkpointSkippedWarnedSessions.delete(sessionId);
    await this.checkpoints.removeSession(sessionId, this.checkpointRoot());
  }

  /**
   * M3 P0-1 restore entry point (three modes, roadmap §1 P0-1): "files" =
   * shadow-git checkout of the turn's pre-turn snapshot; "conversation" =
   * truncate the transcript at that user message (reuses the deleteUserMessage
   * chain incl. CLI chatHistory truncation); "both" = files first, then
   * conversation. Gates mirror deleteUserMessage (no mid-turn restores).
   */
  private async restoreCheckpoint(
    userBlockId: string,
    mode: "files" | "conversation" | "both",
  ): Promise<void> {
    if (this.disposed || this.historySyncBusy) return;
    const state = this.store.getState();
    if (
      state.initializing || state.replaying || state.status === "streaming" || state.status === "connecting" ||
      state.pendingApproval || state.pendingQuestions || state.pendingPlanExit
    ) {
      this.store.appendNotice(vscode.l10n.t("正在生成、连接或等待确认，请先完成当前操作后再回滚"));
      return;
    }
    const sessionId = state.activeSessionId ?? state.sessionId;
    if (!sessionId) return;
    const entry = (state.checkpoints ?? []).find((c) => c.userBlockId === userBlockId);
    if (!entry) {
      this.store.appendNotice(vscode.l10n.t("该轮没有可用的工作区快照"));
      return;
    }
    if (mode === "files" || mode === "both") {
      if (!entry.sha) {
        this.store.appendNotice(vscode.l10n.t("该轮快照不完整，无法恢复文件（可选择仅回滚对话）"));
        return;
      }
      const restored = await this.confirmAndRestoreCheckpointFiles(sessionId, entry);
      if (!restored) return;
    }
    if (mode === "conversation" || mode === "both") {
      // Reuses the full delete chain: transcript truncation + CLI history
      // truncation + reload, plus the checkpoint-index prune inside it.
      await this.deleteUserMessage(userBlockId, "rollback");
    }
  }

  /**
   * Confirm + perform the workspace checkout. Two guard rails mirror
   * revertToolDiff: dirty editors (unsaved buffers) and an explicit modal
   * (this is a whole-workspace overwrite). Returns false when the user
   * cancels or the checkout fails.
   */
  private async confirmAndRestoreCheckpointFiles(sessionId: string, entry: CheckpointUi): Promise<boolean> {
    const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === "file");
    if (dirty.length > 0) {
      const pick = await vscode.window.showWarningMessage(
        vscode.l10n.t("有 {0} 个文件在编辑器中有未保存的修改。回滚将从磁盘重新加载并丢弃这些修改。", dirty.length),
        { modal: true },
        vscode.l10n.t("丢弃并回滚"),
      );
      if (pick !== vscode.l10n.t("丢弃并回滚")) return false;
    }
    const title = entry.label || vscode.l10n.t("该轮");
    const pick = await vscode.window.showWarningMessage(
      vscode.l10n.t("将工作区文件回滚到「{0}」之前的状态？已跟踪文件会被覆盖；该快照之后新建的文件会保留。", title),
      { modal: true },
      vscode.l10n.t("回滚文件"),
    );
    if (pick !== vscode.l10n.t("回滚文件")) return false;
    try {
      await this.checkpoints.restoreFiles(sessionId, entry.sha!);
    } catch (error) {
      void vscode.window.showErrorMessage(vscode.l10n.t("工作区回滚失败: {0}", errorMessage(error)));
      return false;
    }
    // Reload the editors we just overwrote from disk so the restored content
    // is what the user sees (same trick as revertToolDiff).
    for (const doc of dirty) {
      try {
        await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
        await vscode.commands.executeCommand("workbench.action.files.revert");
      } catch {
        // best-effort reload
      }
    }
    void vscode.window.showInformationMessage(vscode.l10n.t("工作区文件已回滚到该轮之前的状态。"));
    return true;
  }

  /**
   * Name the active session after its first user prompt (switcher label).
   * No-op once the session has a real title.
   */
  private async labelSessionWithPrompt(text: string): Promise<void> {
    const state = this.store.getState();
    const id = state.activeSessionId;
    if (!id) return;
    const target = state.sessions.find((s) => s.id === id);
    if (target && target.label !== DEFAULT_SESSION_LABEL) return;
    // Upsert, not map-only: the active session can be missing from the list
    // (e.g. pruned as "dead" before its first prompt landed). Re-adding it is
    // what stops its transcript file from becoming an orphan that the next
    // refresh deletes — and it self-heals sessions poisoned by the old bug.
    const label = clampSessionLabel(text) || target?.label || DEFAULT_SESSION_LABEL;
    // M4 P1-8: keep the user's flags — a title refresh must not silently
    // un-pin or un-archive the session.
    const entry: SessionSummaryUi = {
      id,
      label,
      updatedAt: Date.now(),
      ...(target?.pinned ? { pinned: true } : {}),
      ...(target?.archived ? { archived: true } : {}),
    };
    const sessions = target
      ? state.sessions.map((s) => (s.id === id ? entry : s))
      : [entry, ...state.sessions].slice(0, MAX_RECENT_SESSIONS);
    this.store.setSessions(sessions, id);
    await this.persistSessions(sessions, id);
  }
}
