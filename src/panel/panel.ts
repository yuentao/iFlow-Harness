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
import { McpBroker, normalizeBrokerServers, type McpBrokerStatus } from "../acp/mcp-broker.js";
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
  UserQuestion,
  UserQuestionsRequest,
  UserQuestionsResponse,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  McpStatusReport,
  McpServerStatusView,
  SessionSettings,
  ToolCallBase,
} from "../acp/protocol.js";
import type { PendingApprovalUi, PendingProfileSwitchUi, AssetKind, Block, CheckpointUi, ContextKind, ContextRefUi, InjectedContextItem, McpScope, McpStatusUi, QqSettingsPatch, QqTaskUi, QueuedPromptUi, SessionState, SessionSummaryUi, ToolBlock, ToolDiffUi, WebviewToHost } from "../../shared/messages.js";
import { extractCorePrompt, normalizeUserPromptText, splitReportedContextSections, AGENT_ATTACHMENT_HEADER } from "../../shared/messages.js";
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
import { SuperAgentManager, type SuperResidueCount } from "./super-agent.js";
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
  type SuperDirectiveAction,
  type SuperIntegrationMode,
  type SuperReportEntry,
  type SuperSessionUi,
  type SuperStatus,
  type SuperTaskSpec,
} from "../../shared/super-agent.js";
import {
  classifySuperToolArgs,
  classifySuperToolName,
  classifySuperToolTitle,
  parseSuperToolCall,
} from "../../shared/super-tool-call.js";
import {
  awaitSuperSessionArchiveWrite,
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
import {
  QqService,
  qqSpawnPolicyFor,
  type QqMainInjectInput,
  type QqMainInjectResult,
  type QqTaskAction,
} from "../qq/service.js";
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
  type QqSettingsIo,
} from "../qq/settings-host.js";
import {
  checkQqStartupGate,
  normalizeQqConfig,
  QQ_SECRET_KEYS,
  validateQqConfig,
  type QqConfig,
} from "../qq/config.js";
import {
  isTerminalSuperStatus as isQqTerminalSuperStatus,
  QQ_SETTLE_POLL_MS,
  shouldRestartOnPatch,
} from "../qq/wiring.js";
import {
  QqPendingUserStore,
  QQ_PENDING_DROPPED_TOAST_COOLDOWN_MS,
  QQ_PENDING_MAX_USERS,
  type QqPendingUser,
  type QqPendingUserInput,
} from "../qq/pending-users.js";
import { maskQqOpenId } from "../../shared/qq-access.js";
import type { InboundMessage } from "../qq/adapter/types.js";
import {
  buildClearedQrMessage,
  buildConfirmedQrMessage,
  createQqBotBindRuntime,
  createQqChannelDispatch,
  deliverViaQqBotAdapter,
  QQBOT_APP_ID_SECRET_KEY,
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
 * reminder for an approval / question card is scheduled this long and
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
/**
 * 结构化 super-agent 工具调用（`super-agent` / `super-agent-actions`）的
 * 宿主侧处理结果，按 toolCallId 记账：
 *  - `dispatched`：载荷可用，已交给派发链路；
 *  - `actions`：载荷可用，已交给管理动作链路；
 *  - `rejected`：载荷不可用，已 toast + 入队纠错提示；
 *  - `dropped`：直到 completed 帧都没拿到可用载荷，已 toast + 入队纠错提示。
 *
 * 存在的意义：工具层对任何合法参数都回 ack，模型因此以为派发成功。若宿主
 * 因为「帧里没带 args」而静默跳过，completed 帧必须能把这件事查出来并回话。
 */
type SuperToolCallOutcome = "dispatched" | "actions" | "rejected" | "dropped";
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
 * 已归档子会话迟到结论提示的正文上限：toast 是浮层胶囊不是转录卡，长 summary
 * 必须截断，否则一条汇报能把 toast 栈撑爆。
 */
const SUPER_ARCHIVED_REPORT_MAX_CHARS = 480;
/**
 * Tool gating for the MAIN panel session: a WHITELIST for built-in tools plus a
 * process-level MCP scope — never a blacklist of names.
 *
 * Why not a blacklist (2026-11-17 user report): the main session could still
 * call MCP tools (`new_page` / `take_screenshot` / `evaluate_script`) because
 * `disallowed_tools` only ever named BUILT-IN tools. MCP tool names are
 * per-installation — every user configures different servers — so any
 * enumeration is both incomplete (a server added later walks straight through)
 * and wrong (it would withhold a tool the user legitimately has). The
 * structural answer has two halves, and neither contains an MCP name:
 *  1. `MAIN_SESSION_ALLOWED_TOOLS` → `settings.allowed_tools` → Config
 *     `coreTools`: a tool is registered ONLY when it is listed, so every other
 *     built-in tool (and any tool a future CLI version adds) never exists in
 *     this session.
 *  2. `buildAcpCommand(..., { disableMcpServers: true })` starts the main
 *     session's CLI process with zero MCP servers, so `discoverAllTools()` — the
 *     path that bypasses `coreTools` — has nothing to register.
 * Adding or removing an MCP server therefore needs NO code change here.
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
 * vendor/iflow-fork/bundle/iflow.js):
 *  - `session/new` / `session/load` map the request's `settings.disallowed_tools`
 *    onto the Config's `excludeTools`, and `settings.allowed_tools` onto
 *    `coreTools` (`u = {...this.settings.merged, ..., excludeTools:
 *    o?.disallowed_tools, ..., coreTools: o?.allowed_tools, ...}`);
 *    `loadSession` builds its config through the same `newSessionConfig(...,
 *    settings)`, and its not-found fallback calls `newSession` (settings
 *    forwarded too).
 *  - `coreTools` is a WHITELIST: `createToolRegistry()`'s registrar computes
 *    `u = o === void 0 ? true : o.some(g => g === s || g === a ||
 *    g.startsWith(`${s}(`) || g.startsWith(`${a}(`))` and registers the class
 *    only when `u` is true (`excludeTools` can still veto). `allowed_tools`
 *    therefore withholds tools by never creating them — including tools a
 *    future bundle adds, with no list to maintain here.
 *  - MCP tools are NOT part of that registrar: they arrive later through
 *    `ToolRegistry.discoverAllTools()` → `mcpClientManager.discoverAllMcpTools()`,
 *    which does not consult `coreTools`. That is why the main session also
 *    removes the MCP servers from its CLI process (see `buildAcpCommand`'s
 *    `disableMcpServers`); the whitelist alone would leave them callable.
 *  - The same registrar applies `excludeTools` on top of the whitelist
 *    (`(l?.includes(s) || l?.includes(a)) && (u = !1)`, where `l` is
 *    `this.getExcludeTools()`), matching either the static `Name` or the class
 *    name. That is why the second-layer list below strengthens, and never
 *    replaces, `allowed_tools`.
 *
 * Provenance of the names below (scanned 2026-11-16 / 2026-11-17 across
 * vendor/iflow-fork/bundle/iflow.js). Each one is a `static Name` in the
 * bundle — a `"<name>"` literal, or for `save_memory` the
 * schema object's name (`static Name = jzn.name`) — but "declared"
 * is not "registered": this comment must not claim a tool is withheld when the
 * registrar never creates it:
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
 * What the main session KEEPS is decided by the whitelist below, not by this
 * list: `super-agent` (the dispatch channel — registered by the loader,
 * `super-agent-loader.cjs`, `static Name = "super-agent"`, and it goes through
 * the same registrar), `todo_write` / `todo_read` (the orchestrator's own
 * planning) and `ask_user_question` (requirements).
 *
 * The list below is the SECOND layer. It is redundant with the whitelist in
 * this bundle version — both are consumed by the same registrar, and a name that
 * is not in `coreTools` is never created in the first place — but it is kept
 * because it states the intent explicitly (these are the tools the main session
 * must never hold) and it survives a phantom future where `allowed_tools` is
 * renamed or stops being honored. It names BUILT-IN tools only; MCP tool names
 * must never appear here or anywhere else (see the header: they are per-user).
 *
 * The exclusion is per session: child sessions (SuperAgentManager) deliberately
 * do NOT pass settings and therefore keep every tool — the main session hands
 * both the implementation and the investigation down to them. The MCP scope is
 * likewise per PROCESS: only the main session's spawn gets
 * `--allowed-mcp-server-names`, child spawns do not.
 *
 * Side effect (deliberate, not hidden): the `@iflow` chat participant and
 * `iflow.askSelection` reuse this panel session, so they lose file reads and
 * shell commands too; slash commands that need to inspect the workspace (e.g.
 * `/init`) likewise have to be delegated.
 */
export const MAIN_SESSION_ALLOWED_TOOLS = [
  // the ONLY dispatch channel (loader-registered; must be listed or the main
  // session cannot delegate at all)
  "super-agent",
  // the orchestrator's own planning surface
  "todo_write",
  "todo_read",
  // requirements clarification — the answers become the task briefs
  "ask_user_question",
] as const;
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
  // writes ~/.iflow/memory.md; the panel persists memory host-side instead
  "save_memory",
  // defensive: declared at L3160 but not registered in this bundle version
  // (class `Aut` is never passed to `t(...)`); kept for future CLI versions
  "multi_edit",
  "xml_escape",
  // executing
  "run_shell_command",
] as const;
/** The main session's mode is fixed (2026-11-18). Every tool it holds
 * (`super-agent` / `todo_write` / `todo_read` / `ask_user_question`) has
 * `shouldConfirmExecute() === false` and its CLI process runs without MCP
 * servers, so no permission request can ever reach the approval card — the
 * user-selectable mode had no observable effect and was removed. `smart` is
 * the product default (vendor bundle: `(function(A){A.DEFAULT="default",
 * A.SMART="smart",A.YOLO="yolo",A.PLAN="plan"})(dn||(dn={}))` and
 * `getAvailableModes()` lists `{id:"smart"}` first). Child sessions push
 * `yolo` themselves and QQ tasks use their own supervised policy. */
export const MAIN_SESSION_MODE = "smart";

/** Fresh settings object for one main-session `session/new` / `session/load`,
 * A factory (not a shared object) so no caller can mutate another's copy.
 *
 * `allowed_tools` is the structural gate (only these names are registered at
 * all); `disallowed_tools` is the explicit second layer. Sending only the
 * whitelist would already be sufficient in this bundle version, but the belt
 * costs nothing and keeps the intent legible.
 *
 * MCP is NOT addressed here on purpose: `settings` has no per-session MCP scope
 * (the request's `mcpServers` array is merged ON TOP of the user's configured
 * servers, so an empty array removes nothing). The main session's MCP servers
 * are removed at process level instead — see `buildAcpCommand`'s
 * `disableMcpServers`. */
export function mainSessionSettings(): SessionSettings {
  return {
    allowed_tools: [...MAIN_SESSION_ALLOWED_TOOLS],
    disallowed_tools: [...MAIN_SESSION_DISALLOWED_TOOLS],
  };
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

/** `iflow.superAgent.integration` values — stale settings.json values fall
 * back to `merge`, matching the runtime guard in `integrationMode()`. */
function asSuperIntegrationMode(value: unknown): SuperIntegrationMode {
  return value === "pr" || value === "manual" ? value : "merge";
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
/**
 * 设置事件合并窗口：一次补丁会逐键写多条配置，`onDidChangeConfiguration`
 * 因此连发多轮。50ms 内的事件合并成一轮完整同步，避免一次编辑触发 N 次。
 */
const QQ_SETTINGS_SYNC_DEBOUNCE_MS = 50;
/** 单次「失活 → 自动重启」的硬上限：绝不允许无限重启（重扫是人工兜底）。 */
const QQ_HEALTH_RESTART_LIMIT = 1;
/**
 * 任务看板投影上限。
 *
 * 任务记录本身由 `QqTaskStore` 落盘管理，这里限的是**投影到 webview 的行数**
 * ——长跑通道会把几百条终态任务一起塞进每一帧快照。活跃（非终态）任务全
 * 保留（用户要能看到正在跑的任务并停止它），剩余名额给最近的终态任务。
 */
export const QQ_TASK_PROJECTION_LIMIT = 100;
/** `QqTaskUi.status` 中的终态集合（与 `src/qq/service.ts` 的状态机一致）。 */
const QQ_TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "canceled",
  "timeout",
  "needs_review",
]);
/**
 * 健康 detail 里出现这些片段即视为「失活 / 出错」，不能继续显示「正常」。
 *
 * 只匹配明确表示链路不可用的措辞：`op=9 invalid session` 由 adapter 记录成
 * 「会话已失效（op=9 invalid session）」，断线与重连失败同理；**不**匹配
 * 「断线区间可能丢消息」这类「当前已连上、只是提示历史缺口」的 notice。
 */
const QQ_HEALTH_FAILURE_MARKERS = [
  "invalid session",
  "会话已失效",
  "连接断开",
  "已断开",
  "重连失败",
  "心跳发送失败",
  "发送失败",
  "disconnected",
] as const;

/** adapter 健康快照是否代表「可正常收发」。 */
export function isQqHealthHealthy(health: {
  connected: boolean;
  detail?: string | null;
}): boolean {
  if (!health.connected) return false;
  const detail = (health.detail ?? "").toLowerCase();
  if (detail.length === 0) return true;
  return !QQ_HEALTH_FAILURE_MARKERS.some((marker) => detail.includes(marker.toLowerCase()));
}

/**
 * 裁剪 QQ 任务投影：活跃任务永不丢弃，剩余名额按原顺序（service 已按
 * updatedAt 降序）补足终态任务；返回保持原行序（看板不回跳）。
 */
export function capQqTaskProjection(
  tasks: readonly QqTaskUi[],
  limit: number = QQ_TASK_PROJECTION_LIMIT,
): QqTaskUi[] {
  if (tasks.length <= limit) return [...tasks];
  const keep = new Set<string>();
  for (const task of tasks) {
    if (keep.size >= limit) break;
    if (!QQ_TERMINAL_TASK_STATUSES.has(task.status)) keep.add(task.taskId);
  }
  for (const task of tasks) {
    if (keep.size >= limit) break;
    keep.add(task.taskId);
  }
  return tasks.filter((task) => keep.has(task.taskId));
}

/** `requestSuperMerge` 的真实结果（供 QQ 端口如实回传 detail）。 */
export type SuperMergeDispatchResult =
  | { dispatched: true; mergeSessionId: string }
  | { dispatched: false; queued: boolean; reason: string };

/**
 * 主会话渠道等待「主会话空闲」的轮询间隔。
 *
 * 比子会话收尾轮询（1.5s）短得多：这里等的是本地回合结束，用户按下回车后
 * 往往几秒内就空闲，注入延迟必须可感知地小。
 */
const QQ_MAIN_IDLE_POLL_MS = 300;

/**
 * QQ 最终答复「迟到补发」阈值（R2）。
 *
 * 汇报轮的 final 标记由 pendingCount===0 决定；当同会话里还有别的非终态子会话
 * （典型是主 Agent 派出的复核子会话）时 pendingCount 长期 >0，汇总轮会被判成
 * 非 final，QQ 于是永远停在「已受理」。这里给等最终答复的 awaiter 两道兜底：
 *  - 软阈值：awaiter 已等超过 QQ_FINAL_RESCUE_MS 且本会话已无活跃子会话 → 补发；
 *  - 硬上限：即使还有子会话卡在非终态，等超过 QQ_FINAL_HARD_RESCUE_MS 也补发
 *    （宁可给一条如实兜底，也不让 QQ 永久停在已受理）。
 * 轮询间隔远小于阈值，仅为让补发在阈值到点后尽快发生。
 */
const QQ_FINAL_RESCUE_MS = 120_000;
const QQ_FINAL_HARD_RESCUE_MS = 600_000;
const QQ_FINAL_RESCUE_POLL_MS = 10_000;
/**
 * 硬上限补发遇到「本会话汇报轮正在投递 / 排队」时最多让出的轮询拍数。
 *
 * 让真实最终汇报（finalReport 收尾投递）优先收尾：抢在它前面补发会把兜底
 * 文案当结论写死，并让随后迟到的真实正文被丢弃（2026-11-19 用户实测）。
 * 只让出有限拍数，超过仍未收尾就强制补发 —— 保留「真正卡死」时的兜底，
 * 绝不永久推迟。
 */
const QQ_FINAL_RESCUE_MAX_DEFERS = 6;

/**
 * 注入轮结束时判定 delegated 的宽限期（R3）：子会话登记可能与回合收尾差错一拍，
 * 留一个很短的窗口再核对子会话列表，避免把「已派子会话」误判成直答而提前撤销
 * 等最终答复的记账。测试可注入更小值。
 */
const QQ_DELEGATION_GRACE_MS = 120;

/**
 * QQ 最终答复兜底用的子会话汇报正文上限。QQ 单条消息有字符预算（见
 * `src/qq/service.ts` 的 `QQ_CHUNK_MAX_CHARS`），这里先截到远小于它的长度，
 * 既保留结论又不会把整段子会话转录灌给外部渠道。
 */
const QQ_REPORT_FALLBACK_MAX_CHARS = 1_500;

/**
 * 把子会话汇报正文（`report.summary`）清洗成可安全转发给 QQ 的纯文本。
 *
 * 汇报是子会话自己写的自由文本，可能带 super-agent 委派围栏 / ACP 工具与角色
 * 标签（协议标记）、本机绝对路径、token/密钥与长 id。发到外部渠道前一律去掉：
 *  - 保留项目相对路径（用户要知道「改了哪些文件、验证了什么」），只抹本机绝对路径；
 *  - 凭据与 id 用占位替代，避免把本机信息泄漏到聊天记录；
 *  - 折叠空白并按上限截断。
 * 空串代表这条正文不可用，调用方据此再退到如实占位文案。
 */
function sanitizeQqReportFallback(raw: string | undefined): string {
  if (!raw || !raw.trim()) return "";
  let text = raw;
  // 协议标记：super-agent 委派围栏 / ACP 工具与角色标签 / 纯 JSON 信封行。
  text = text.replace(/```(?:super-agent|json)\b[\s\S]*?```/gi, "");
  text = text.replace(
    /<\/?(?:tool_call|function_call|function|thinking|system|user|assistant)\b[^>]*>/gi,
    "",
  );
  text = text.replace(/^\s*\{[^\n]*"(?:type|tool_call_id)"\s*:[^\n]*\}\s*$/gm, "");
  // 凭据：常见 token 前缀直写，以及 key=value 形式。
  text = text.replace(/\b(?:sk|gho|ghs|ghp|github_pat)-[A-Za-z0-9_-]{8,}/gi, "[已隐藏]");
  text = text.replace(
    /(["']?(?:api[_-]?key|app[_-]?secret|password|token|access[_-]?key)["']?\s*[:=]\s*)(["']?)([^"'\s,;&})]+)\2/gi,
    "$1$2[已隐藏]$2",
  );
  // 本机绝对路径（Windows 盘符 / UNC / POSIX home/tmp），保留项目相对路径。
  text = text.replace(/\b[A-Za-z]:[\\/][^\s,;)\]"']*/g, "[路径]");
  text = text.replace(/\\\\[^\s\\/]+\\[^\s,;)\]"']*/g, "[路径]");
  text = text.replace(/(?:^|[\s(])\/(?:home|Users|root|tmp|var)\/[^\s,;)\]"']*/g, " [路径]");
  // 长 id / UUID（openid、session id、随机串）。
  text = text.replace(
    /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/gi,
    "[ID]",
  );
  text = text.replace(/\b[0-9a-fA-F]{16,}\b/g, "[ID]");
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > QQ_REPORT_FALLBACK_MAX_CHARS
    ? `${text.slice(0, QQ_REPORT_FALLBACK_MAX_CHARS - 1)}…`
    : text;
}

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
   * Host-side MCP broker: ONE process per configured MCP server, shared by all
   * Super Agent children (they reach it over loopback streamable HTTP). Started
   * lazily on the first child spawn; disposed with the panel.
   *
   * Without it every child CLI process would spawn its own copy of every
   * configured server (Windows: ~3 node processes per server per child), which
   * is exactly why child MCP used to be switched off entirely.
   */
  private mcpBroker: McpBroker | null = null;
  /** Single-flight guard for broker startup (several children can spawn at once). */
  private mcpBrokerStarting: Promise<McpBroker | null> | null = null;
  /**
   * QQ 远程任务通道的运行期现场（QQBot 单一路径）。
   *
   * 现场 = QqService + 任务落盘 + 启动时的配置快照 + 设置 IO + 官方 adapter。
   * 它是**唯一**的「通道是否在跑」判据 —— 所有入口都以 `this.qq` 是否存在
   * 为闸门，没有任何入口能在半初始化状态下继续。
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
    /** QQBot 官方路线：不 spawn bridge，直接持有 adapter + 扫码会话。 */
    qqbot: {
      adapter: QqBotAdapterLike;
      /** 扫码会话在绑定成功后即停并清空，只在绑定进行中短驻留。 */
      bindSession?: { stop(): void };
    };
  };
  /**
   * 主会话渠道（QQ 消息固定去向）的注入控制面。
   *
   * `qqInjectAborts` 按 taskId 保存「放弃等待空闲」的取消信号（`/qq stop`
   * 与通道停止都要能立刻放手）；`qqInjectedTaskId` 是当前真正跑在主会话上的
   * 那一轮属于哪个任务 —— 停止时要打断的是**这一轮**，不能误伤本地回合。
   */
  private readonly qqInjectAborts = new Map<string, AbortController>();
  private qqInjectedTaskId: string | null = null;
  /**
   * 远程接续开关（纯内存态，不持久化）：开启 = 远程继续干活 —— QQ 消息照常
   * 注入主会话、agent 继续执行，只冻结本地干预入口（转录保持只读可观察），
   * 防止两边同时操作造成混淆；关闭 = 本地恢复 + 断开远程 —— 在本次接管的
   * sessionId 上设「不再接收 QQ 注入」的门，并取消在跑的注入回合。
   *
   * `qqTakeoverActive` / `qqTakeoverSessionId` 是本地冻结态；
   * `qqRemoteDetachedSessions` 是「已断开远程接管的会话集合」，只有它命中才
   * 拦截 QQ 注入（start / 默认状态一律放行）。冻结态在 stop / 会话切换 /
   * webview 重连 / dispose 时清；断开门不因 webview 重连而清（同一 panel
   * 进程里远程关系仍在，清了会让已断开的会话意外恢复注入），只在会话切换
   * / 重建（newSession / restore / dispose）时清。toastId 只是 toast 的 host
   * id，不是凭据。
   */
  private qqTakeoverActive = false;
  private qqTakeoverSessionId: string | null = null;
  private qqTakeoverToastId: number | null = null;
  /** 已断开远程接管的会话集合：命中即拒绝 QQ 主会话注入；不持久化。 */
  private readonly qqRemoteDetachedSessions = new Set<string>();
  /**
   * QQ 主渠道「等最终答复」记账：注入轮已把任务派给子会话的任务 id → 归属
   * 主会话 id。
   *
   * 主会话只委派不执行：注入轮的 assistant 文本只是「已安排」的占位，真正
   * 答复在子会话汇报汇总轮（hidden/reportTurn、pendingCount=0）产生。该轮
   * 结束时按归属会话找到这里的任务，把那一轮文本作为最终答复回传 QQ。停止
   * / 会话切换时摘除，避免迟到的汇报回错任务。
   */
  private readonly qqMainFinalAwaiters = new Map<string, string>();
  /**
   * 每个 awaiter 的登记时刻（taskId → Date.now()）：迟到补发（R2）按等待时长判定。
   * 与 qqMainFinalAwaiters 同生命周期，同增同删；缺省视为「刚登记」（不触发补发）。
   */
  private readonly qqMainFinalAwaiterSince = new Map<string, number>();
  /**
   * 每个归属主会话最近一次汇报回合产出的 assistant 文本（sessionId → text）。
   * 补发时优先用它（保留真实结论），没有才退回如实兜底文案。仅作补发缓存，
   * 不参与正常 final 回执；awaiter 清空时一并清理。
   */
  private readonly qqFinalRescueText = new Map<string, string>();
  /**
   * 每个归属主会话最近一次子会话汇报正文（report.summary 清洗后）作为补发兜底。
   *
   * 与 `qqFinalRescueText` 分离：后者会被非 final 的进度汇报轮正文覆盖，硬上限
   * 补发时可能为空；这条只在汇报入队时写入，保证补发即便缓存正文为空也能回
   * 真实汇报正文而不是一句占位文案（2026-11-19 补发抢跑 bug）。
   */
  private readonly qqReportFallbackText = new Map<string, string>();
  /**
   * 每个 awaiter 因「在途汇报轮」让出的补发拍数（taskId → 次数）。达到
   * `QQ_FINAL_RESCUE_MAX_DEFERS` 后强制补发，避免真正卡死时永久等待。
   */
  private readonly qqFinalRescueDefers = new Map<string, number>();
  /** 迟到补发的轮询定时器（仅在有 awaiter 时存活）。 */
  private qqFinalRescueTimer: ReturnType<typeof setInterval> | null = null;
  /** 注入轮 delegated 判定的宽限期；测试可注入更小值。 */
  private qqDelegationGraceMs = QQ_DELEGATION_GRACE_MS;
  /** 迟到补发的软 / 硬阈值；测试可注入更小值。 */
  private qqFinalRescueMs = QQ_FINAL_RESCUE_MS;
  private qqFinalHardRescueMs = QQ_FINAL_HARD_RESCUE_MS;
  /**
   * 属于 QQ 主渠道对话的本地提问卡（卡片 id → 归属 QQ 任务 id）。
   *
   * 主会话/子会话的 `_iflow/user/questions` 与本地回合共用同一个单数提问卡槽位，
   * 这里单独记账：QQ 用户的 `/qq answer` 只回灌这里登记的卡，绝不误答本地提问；
   * 本地用户先作答时也从这里摘除，避免同一问题被 QQ 再答一次（双重应答）。
   * 记 taskId 而非只用 Set，是为了回灌时不依赖「当前回合」这个易变状态 ——
   * 回合结束后 qqInjectedTaskId 会清空，但那张卡仍属于诞生它的那个任务。
   */
  private readonly qqMainQuestionIds = new Map<string, string>();
  /**
   * QQ 主渠道任务派生的子会话 → 发起它的 QQ 主任务 id。
   *
   * main 渠道任务没有 `correlation.superSessionId`（那是 child 渠道专属），子会话
   * 的提问因此无法按旧路径匹配到 QQ 任务。这里在派发子会话的当场打上归属标签，
   * `onNeedInput` 据此把提问提醒回灌到正确的 QQ 任务。
   */
  private readonly qqTaskBySuperSession = new Map<string, string>();
  /**
   * QQ 主任务「自己那一轮」的汇报正文（taskId → 清洗后的子会话汇报）。
   *
   * 同一主会话里连发多条 QQ 消息时，各任务派生各自的超流体子会话；一轮汇总
   * 结论若广播给该会话所有 awaiter，就会出现「摘要相同、taskId 不同」的重复
   * 卡。这里在汇报入队时按 {@link qqTaskBySuperSession} 把每个子会话的汇报归
   * 到它的主任务，最终回执时逐 task 取回自己那份，绝不共享别人的结论。
   * 与 awaiter 同生命周期：投递 / 撤销 / 停通道时清理。
   */
  private readonly qqTaskFinalText = new Map<string, string>();
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
   * 进行中的「建通道」占位。
   *
   * `startQqBotChannel` 既有 `doStartQq`（配置事件路径）也有扫码成功
   * （绑定路径）两个调用方；两条路径若各建一套 owner，会互相覆盖/反杀。
   * 这里在**任何 await 之前同步占位**，后来者直接复用同一份启动。
   */
  private qqChannelStarting: Promise<void> | null = null;
  /** 健康检查驱动的自动重启次数（上限 {@link QQ_HEALTH_RESTART_LIMIT}）。 */
  private qqHealthRestarts = 0;
  /** 设置事件合并定时器（一次补丁逐键写配置会连发多轮事件）。 */
  private qqSettingsSyncTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * QQBot 官方扫码会话：绑定进行中短驻留，成功/失败/stop 后立即清空。
   * 独立于 `this.qq`（扫码时尚无服务现场），避免把半绑定现场塞进主通道。
   */
  private qqbotBinding: { stop(): void } | null = null;
  /**
   * QQ 待审核用户（授权模型 2026-11-17）：白名单外的人发来消息时落一条记录，
   * 面板审核后决定放行（写进 `allowedUsers`）或拒绝。
   *
   * 独立于 `this.qq`：通道没启动 / 没绑定时也要能展示历史记录，因此存储由
   * 面板懒建、与通道生命周期无关。
   */
  private qqPendingUsers: QqPendingUserStore | null = null;
  /**
   * 队列满丢弃提示的冷却记账（openid → 上次 warning toast 时刻）。
   *
   * 满队时外部每条消息都会触发一次丢弃事件，同一 openid 连续刷消息会把
   * 面板刷满屏；按 {@link QQ_PENDING_DROPPED_TOAST_COOLDOWN_MS} 冷却，
   * 每 10 分钟最多一条。不同 openid 的首次丢弃仍各自提示。
   */
  private readonly qqPendingDropToastAt = new Map<string, number>();
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
   * 结构化 super-agent 工具调用的处理结果，key = toolCallId。
   *
   * 工具层对合法参数一律回 ack（`execute()` 只校验形状，不做任何 I/O），
   * 所以「模型收到 accepted」不等于「宿主真的派了」。载荷只随 in_progress
   * 帧到达，pending 帧通常没有 args；如果某次调用从头到尾都没带载荷，
   * completed 帧就会是唯一的补救点 —— 这里按 id 记账，completed 帧据此
   * 判断要不要留痕（见 {@link auditSuperToolCallCompletion}）。
   *
   * 有界：工具帧数量不设界；换会话 / 恢复会话 / 热重认证时清空。
   */
  private readonly superToolCallOutcomes = new Map<string, SuperToolCallOutcome>();
  /** {@link superToolCallOutcomes} 的容量上限（工具帧数量不设界，Map 必须有界）。 */
  private static readonly SUPER_TOOL_CALL_OUTCOME_CAP = 100;
  /**
   * 同一个主会话、同一轮里最多发几次「super-agent 参数纠错提示」。
   *
   * 工具层现在会抛错让模型自己修，宿主这条 hidden prompt 是兜底：两者叠加
   * 若不加限次，模型坚持写同样的错误参数时宿主会无限喂纠错回合。2 次足够
   * 覆盖「模型没读懂错误 / 换一种写法又错」两种情况，之后只留 toast ——
   * 把决定权交回用户，而不是让面板自转。
   */
  private static readonly SUPER_TOOL_CALL_CORRECTION_CAP = 2;
  /**
   * 当前轮次已发出的纠错提示数（key = 主会话 id）。
   *
   * 「一轮」以用户下一次主动发消息为界（`sendPrompt` 的 !internal && !hidden
   * 分支清掉本条记录）；宿主自己投的 hidden 回合不重置 —— 否则纠错提示自己
   * 触发的新一轮会重新获得配额，限次形同虚设。换会话 / 恢复会话 / 热重认证
   * 时由 {@link resetSuperDirectiveScans} 清空。
   */
  private readonly superToolCallCorrections = new Map<string, number>();
  /**
   * 等待主会话空闲的纠错提示（hidden prompt）。
   *
   * 工具调用必然发生在主会话生成中，所以入队时几乎总是忙的；投递复用子会话
   * 汇报那条「排队等空闲」的车道（`drainSuperToolCallCorrections`，与汇报/
   * 动作回执互斥执行）。每条带归属主会话：排队期间用户切了会话，A 的纠错
   * 提示不能投进 B 的对话。
   */
  private pendingSuperToolCallCorrections: Array<{ mainSessionId: string | null; text: string }> = [];
  /**
   * 合并 drain 的一次性唤醒定时器（见 drainSuperMerges）。
   *
   * 合并队列的派发与汇报车道互锁：一次派发没成功时不能只等外部回调 ——
   * 合并子会话可能压根没派出去，于是永远不会有人回调。这个定时器在下一拍
   * 自己再叫一次 drain，心跳之外多一道保险；有定时器在就不再叠加新的。
   */
  private superMergeWakeupTimer: ReturnType<typeof setTimeout> | null = null;
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
  private pendingSuperReportPrompts: Array<{ mainSessionId: string | null; text: string; final?: boolean; fallbackText?: string }> = [];
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
   * 5 条宿主自动回合队列的**明确优先级**（数组先后即投递先后）。
   *
   * 旧实现把 5 个 drain 逐个 fire-and-forget，调用顺序（汇报在最前）事实上
   * 成了隐式优先级；配合汇报 drain 的 while 一次投多条，任一队列卡在 error /
   * Stop 上时其它队列只能等「用户下次发消息」这个唯一解除点。这里把优先级
   * 显式化，并配合 {@link superAutoTurnCursor} 轮转，保证每条队列每几拍都能
   * 拿到一次车道，不会饿死。
   *
   * 汇报优先是刻意保持既有语义（只有汇报在排队时行为与旧版一致）；其后依次
   * 是动作回执（防主会话重复发同一动作）、被改道的用户消息（用户原话）、
   * 参数纠错（让卡住的调用往前走）、合并（要动主工作区，最保守）。
   */
  private static readonly SUPER_AUTO_TURN_PRIORITY = [
    "reports",
    "actionReceipts",
    "delegated",
    "corrections",
    "merges",
  ] as const;
  /** 轮转游标：下一次仲裁从 {@link SUPER_AUTO_TURN_PRIORITY} 的哪一位起步。 */
  private superAutoTurnCursor = 0;
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
   * 后台残留 worktree 清扫的在飞标记。
   *
   * 清扫**不在**会话恢复 / 新建会话的关键路径上（见
   * `sweepStaleWorktreesInBackground`）；这个闸门只保证同一时刻最多一份在跑，
   * 切会话 / 反复恢复不会叠出多条 `git status` 子进程链。
   */
  private sweepInFlight = false;
  /**
   * 后台残留清扫的延时（ms）。恢复会话时 CLI 正在跑 session/new、
   * loadSession 与 MCP 发现，此刻三类 sweep 一起读盘 / 跑 git 会争抢 I/O，
   * 拖慢恢复（2026-11-19 用户实测）。延时到恢复窗口之后再触发，值 0 供测试
   * 立即触发验证「清扫挂住也不阻塞恢复」。
   */
  private superSweepDelayMs = 3_000;
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
      resolve: (response: RequestPermissionResponse) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private approvalSeq = 0;
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
   * No timer: the dialog blocks no agent (unlike approval/question cards),
   * so it waits for the user indefinitely — every cancel path (panel dispose,
   * session teardown) resolves it explicitly instead.
   */
  private readonly pendingProfileSwitches = new Map<string, { resolve: (keepSession: boolean | null) => void }>();
  private profileSwitchSeq = 0;
  /**
   * 新建会话时的「清空并新建」二次确认框：按 requestId 存 promise resolver。
   *
   * 与 profile-switch 对话同源（webview 弹框 → 回传 host），但多一道超时兜底：
   * 若 webview 没有渲染这个确认框（旧版前端 / 另一条线尚未合并），新建会话
   * 不能永久卡在等一个永远不会来的回答 —— 超时按「取消」处理（只新建、不清空）。
   */
  private readonly pendingSuperResidueConfirms = new Map<string, {
    resolve: (confirmed: boolean) => void;
    timer: NodeJS.Timeout;
  }>();
  private superResidueConfirmSeq = 0;
  /** Serializes per-session transcript file writes (P2): overlapping persists
   * must not interleave inside one file's temp+rename sequence. */
  private persistChain: Promise<void> = Promise.resolve();
  /**
   * Transcript writes currently queued or in flight on `persistChain`.
   * `cleanupEmptySession` awaits the chain before the new-session state swap;
   * while that wait is non-trivial the new-session projection must say
   * 「正在等待后台任务结束」 instead of looking frozen (see NewSessionPhase).
   */
  private persistPending = 0;
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
   * Armed after a timeout auto-reject (approval / question) while
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
        if (e.affectsConfiguration("iflow.language")) {
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
        // 合并同一批写入产生的多轮事件（见 QQ_SETTINGS_SYNC_DEBOUNCE_MS）。
        this.scheduleQqSettingsChanged();
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
        // beginReplay 也会把 status 置成 "streaming"，但那是恢复转录而不是
        // 模型在生成：转圈配「生成中」会让用户以为卡在生成（webview 同一
        // 时刻显示的是「正在恢复会话…」）。replaying 优先于 compressing 与
        // 生成中，文案与 webview 的 restore 态保持一致。
        const label = state.replaying
          ? vscode.l10n.t("正在恢复会话…")
          : state.compressing
            ? vscode.l10n.t("正在压缩")
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
            : `$(sync~spin) iFlow: ${vscode.l10n.t("超流体进行中")}${model}`;
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
          "已停止：还有 {0} 项超流体结果待处理。发送下一条消息，或点提示条上的「继续处理」来收取汇报",
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
    // QQ 主会话渠道：等空闲的注入立刻放手。否则它会在宿主销毁后继续排空，
    // 往已销毁的 store 写一轮 prompt（服务侧看到 canceled 会自行收尾）。
    for (const controller of this.qqInjectAborts.values()) controller.abort();
    this.qqInjectAborts.clear();
    this.qqInjectedTaskId = null;
    // 远程接续是纯内存态：宿主销毁时必须清冻结态并撤掉常驻 toast。
    this.clearQqTakeover();
    this.clearQqRemoteDetachedSessions();
    this.stopQqFinalRescueTimer();
    this.qqMainFinalAwaiters.clear();
    this.qqMainFinalAwaiterSince.clear();
    this.qqFinalRescueText.clear();
    this.qqReportFallbackText.clear();
    this.qqFinalRescueDefers.clear();
    this.qqTaskBySuperSession.clear();
    this.qqTaskFinalText.clear();
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
    // MCP broker: kill the shared server processes now that no child can use
    // them. Best-effort — teardown must not be blocked by a wedged server.
    try {
      await this.mcpBroker?.dispose();
    } catch (error) {
      this.log.warn(`MCP broker dispose failed: ${errorMessage(error)}`);
    }
    this.mcpBroker = null;
    this.mcpBrokerStarting = null;
    this.pendingSuperReports.clear();
    this.pendingSuperReportPrompts = [];
    this.pendingSuperActionReceipts = [];
    this.pendingDelegatedUserTurns = [];
    // 面板销毁后这四个 drain 可能正卡在 await sendPrompt 上；把队列与车道全
    // 清掉，避免它们在 finally 里把「已销毁实例」的锁/标志重新写回（也避免
    // 残留的合并请求在销毁后还能触发一次唤醒）。
    this.pendingSuperToolCallCorrections = [];
    this.pendingSuperMerges = [];
    this.superReportRunning = false;
    this.superMergeRunning = false;
    this.mainLane = null;
    if (this.superMergeWakeupTimer) {
      clearTimeout(this.superMergeWakeupTimer);
      this.superMergeWakeupTimer = null;
    }
    this.autoTurnsStoppedFor = null;
    this.clearDeferredAutoTurnsToast();
    this.promptRequestSessionId = null;
    this.stopSuperHeartbeat();
    // 面板要没了，等待子会话的忙碌标记也一并清掉（别把忙碌态留在快照里）。
    this.store.setSuperWaiting(false);
    this.cancelAllProfileSwitches();
    this.cancelAllSuperResidueConfirms();
    this.clearPostRejectionWatchdog();
    if (this.diagDebounce) {
      clearTimeout(this.diagDebounce);
      this.diagDebounce = null;
    }
    if (this.qqSettingsSyncTimer) {
      clearTimeout(this.qqSettingsSyncTimer);
      this.qqSettingsSyncTimer = null;
    }
    if (this.qqRestartTimer) {
      clearTimeout(this.qqRestartTimer);
      this.qqRestartTimer = null;
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
    // 项目内 `.iflow/super/` 的附件副本与降级目录此前无人清扫（OS 临时目录
    // 的 sweep 只扫 temp root）。并列 fire-and-forget，失败只记日志。
    const manager = this.superAgent;
    if (!manager) return;
    void Promise.all([
      manager.sweepStaleSuperAttachmentDirs(),
      manager.sweepStaleSuperDirs(),
    ]).catch((error) => {
      this.log.warn(`super agent: 附件/目录残留清扫失败：${errorMessage(error)}`);
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
    // `qqConfigAction`（连测试 / 解绑 / 扫码三动作）是 webview→host 命令；
    // 它历史上只声明在 HostToWebview 上（方向写反），Wave3-C2 已在
    // WebviewToHost 补上声明，「修正消息方向」这次又把 HostToWebview 上的
    // 误声明移除，下面 switch 里的 `case "qqConfigAction"` 是类型检查过的
    // 正规通道。这段运行时形状守卫保留，兼容尚未重建、仍按旧声明发送的
    // 旧 webview（先于 switch 命中，行为与原先一致）。配对码动作已随授权
    // 模型改造移除，旧 webview 发来会被静默丢弃。
    const qqAction = (msg as { type?: unknown; action?: unknown });
    if (
      qqAction.type === "qqConfigAction" &&
      (qqAction.action === "testConnection" ||
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
        // 本地冻结态随 webview 重连失效（重连即无干预面），连带撤掉常驻 toast。
        // 注意：这里只清冻结态，不清 `qqRemoteDetachedSessions` —— 重连不换会话，
        // 同一 panel 进程里「已断开远程」的关系仍在，清了会让该会话意外恢复 QQ
        // 注入。断开门只在会话切换 / 重建（newSession / restore / dispose）时清。
        this.clearQqTakeover();
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
      case "answerQuestions":
        this.handleQuestionAnswers(msg.id, msg.answers);
        break;
      case "respondProfileSwitch":
        this.handleProfileSwitchResponse(msg.id, msg.keepSession);
        break;
      case "respondSuperResidueConfirm":
        this.handleSuperResidueConfirmResponse(msg.requestId, msg.confirmed);
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
        if (msg.superAgentIntegration !== undefined) {
          writes.push(["superAgent.integration", asSuperIntegrationMode(msg.superAgentIntegration)]);
        }
        if (msg.superAgentMaxWorktrees !== undefined && Number.isFinite(msg.superAgentMaxWorktrees)) {
          writes.push(["superAgent.maxWorktrees", clampMaxSuperWorktrees(msg.superAgentMaxWorktrees)]);
        }
        if (typeof msg.superAgentKeepWorktree === "boolean") {
          writes.push(["superAgent.keepWorktree", msg.superAgentKeepWorktree]);
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
      case "qqTaskAction":
        await this.handleQqTaskAction(msg.taskId, msg.action, msg.text);
        break;
      case "qqConfigAction":
        await this.handleQqConfigAction(msg.action);
        break;
      case "qqUserAction":
        await this.handleQqUserAction(msg.openid, msg.action);
        break;
      case "qqManagedSetup":
        await this.handleQqManagedSetup(msg.action);
        break;
      case "qqTakeover":
        this.handleQqTakeover(msg.action);
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
      superAgentIntegration: asSuperIntegrationMode(config.get<string>("superAgent.integration", "merge")),
      superAgentMaxWorktrees: clampMaxSuperWorktrees(
        config.get<number>("superAgent.maxWorktrees", DEFAULT_MAX_SUPER_WORKTREES),
      ),
      superAgentKeepWorktree: config.get<boolean>("superAgent.keepWorktree", false),
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
   *
   * QQ 远程接管态本机静音(2026-11-19):接管时用户已离开本机、反馈只走 QQ 转发
   * (`deliverQqMainFinalAnswer` / 子会话 QQ 回执)。这里是最小的统一出口 —— 在入口
   * 一步挡住 OS 原生通知 + done/child 提示音,同时覆盖 turnDone / superReport /
   * childDone 三类完成提示。切勿上移到 sendPrompt 收尾的 finalReport 块:那里还放着
   * QQ 转发调用,误伤会让远程用户永远收不到最终答复。错误音 `postSound("error")`
   * 不经此出口,保持原样。
   */
  private announceCue(event: OsNotifyEvent, text: string, kind: "done" | "child"): void {
    if (this.qqTakeoverActive) return;
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
   * question/approval card is displayed). `cardStillDisplayed` answers
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
        void this.drainSuperAutoTurns();
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
   *   and pending approval/question cards stay untouched);
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
    if (state.pendingApproval || state.pendingQuestions) return false;
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
   * 只对这一个工具生效：其它工具仍走审批卡。响应里的 `optionId` **必须是
   * agent 真正给出的** —— CLI 用 `nativeEnum` 解析，伪造会抛错并卡死回合；
   * 没有 allow 选项时按现有取消路径回 `cancelled`，绝不伪造批准。
   */
  private autoApproveSuperAgentTool(req: RequestPermissionRequest): RequestPermissionResponse | null {
    // 识别顺序按证据强度从强到弱（全部只对「命中即放行」生效，未命中仍走
    // 规则表 / 审批卡）：
    //  1. 工具名归一（含命名空间前缀与分隔符变体）；
    //  2. 标题里直接写着工具名（CLI 0.5.19 的权限请求经常省略 toolName）；
    //  3. 标题是内置工具的短标签 —— 智能审批（SMART）的 RISKY 分支构造
    //     toolCall 时只填 `title: getDescription(params)`，派发形态是
    //     `Delegate 1 task`、管理形态是 `Manage 1 child session action`
    //     （bundle 实证 0.5.19，见 shared/super-tool-call.ts 的
    //     classifySuperToolTitle）；
    //  4. 以上都没有时按**真实载荷结构**兜底（tasks / actions 严格校验）。
    // 只看 title 会漏掉无标题形态、只看载荷会漏掉智能审批（它不带 args），
    // 两者叠加才覆盖当前已知的全部形态。
    const toolName = (req.toolCall.toolName ?? "").trim();
    const title = (req.toolCall.title ?? "").trim();
    const kind =
      (toolName ? classifySuperToolName(toolName) : null) ??
      (title ? classifySuperToolName(title) : null) ??
      (title ? classifySuperToolTitle(title) : null) ??
      classifySuperToolArgs(req.toolCall.args);
    if (!kind) return null;
    const label = toolName || title || "super-agent";
    const option =
      req.options.find((o) => o.kind === "allow_always") ??
      req.options.find((o) => o.kind.startsWith("allow"));
    if (!option) {
      this.log.warn(`super agent: "${label}" permission request offers no allow option — cancelling`);
      return { outcome: { outcome: "cancelled" } };
    }
    this.log.info(`super agent: auto-allowed built-in tool "${label}" (${kind}, ${option.kind})`);
    return { outcome: { outcome: "selected", optionId: option.optionId } };
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
  }

  /** Shared complete user-stop chain: unblock cards, suppress retries/watchdog. */
  private cancelCurrentTurn(): void {
    const client = this.client;
    this.cancelAllApprovals(vscode.l10n.t("用户取消"));
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
      vscode.l10n.t("已停止；还有 {0} 项超流体结果待处理。发送下一条消息，或点「继续处理」来收取汇报", pending),
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

  // --- Plan mode (removed) — minimal defensive fallback ------------------------

  /**
   * 计划模式已移除（2026-11-18）。
   *
   * CLI 内部仍然保留 `permission_mode: plan` 与 `exit_plan_mode` 工具（vendor
   * bundle 刻意不改）。旧会话归档、外部 `~/.iflow/settings.json` 的
   * `approvalMode: "plan"`、或 CLI 自身的启动默认都可能让
   * `_iflow/plan/exit` 再次到达宿主。**不能挂死**：这里不弹卡、不入待办、不写
   * specs，记一条警告后直接放行（wire 契约仍是 `{approved, reason?}`），让
   * agent 继续跑，而不是阻塞到 5 分钟审批超时。
   */
  private handleRemovedPlanExit(req: ExitPlanModeRequest): ExitPlanModeResponse {
    const planChars = (req.plan ?? "").length;
    this.log.warn(`plan mode removed: auto-approving stale _iflow/plan/exit (${planChars} chars of plan text)`);
    return { approved: true, reason: vscode.l10n.t("计划模式已移除，自动继续") };
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
    // QQ 主渠道注入回合里 agent 的提问：本地卡照常显示，但额外转发给发起者。
    // 捕获快照而非实时读 qqInjectedTaskId —— 回合结束后它会清空，回灌必须按
    // 提问诞生时所属的那一个任务寻址。
    const qqMainTaskId = this.qqInjectedTaskId;

    return new Promise<UserQuestionsResponse>((resolve) => {
      const timer = setTimeout(() => {
        // Safety: an unanswered card must not block the agent forever.
        this.pendingQuestions.delete(id);
        this.qqMainQuestionIds.delete(id);
        // Resolve FIRST — see the approval-timeout comment above.
        resolve({ answers: {} });
        this.store.clearQuestions(id);
        this.store.appendNotice(vscode.l10n.t("提问超时，已按未回答继续"));
        this.armPostRejectionWatchdog();
      }, APPROVAL_TIMEOUT_MS);

      this.pendingQuestions.set(id, { resolve, timer });
      if (qqMainTaskId) this.qqMainQuestionIds.set(id, qqMainTaskId);
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
      // 转发是异步的，不阻塞提问挂起；接线异常只记日志，本地卡始终可用。
      if (qqMainTaskId) this.forwardQqMainTaskQuestion(qqMainTaskId, req.questions);
    });
  }

  /** Webview answers (or dismisses) the pending question card. */
  private handleQuestionAnswers(id: string, answers: Record<string, string | string[]>): void {
    const pending = this.pendingQuestions.get(id);
    if (!pending) return;
    // 用卡片诞生时记录的 taskId，不读实时 qqInjectedTaskId —— 后者在回合收尾
    // 后会清空，本机作答若发生在那时候就撤不掉 QQ 侧的等待槽位。
    const wasQqTaskId = this.qqMainQuestionIds.get(id);
    this.qqMainQuestionIds.delete(id);
    this.pendingQuestions.delete(id);
    clearTimeout(pending.timer);
    this.store.clearQuestions(id);
    // 本机先作答 → 撤销 QQ 侧那条等待槽位，避免 `/qq answer` 二次回灌同一个问题。
    if (wasQqTaskId) {
      try {
        this.qq?.service.clearQuestionWait(wasQqTaskId);
      } catch (error) {
        this.log.warn(`QQ 提问等待槽位清理失败：${errorMessage(error)}`);
      }
    }
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
    this.qqMainQuestionIds.clear();
  }

  /**
   * 远程派发的子会话提问 → 转发给 QQ 发起者。
   *
   * 服务侧会按 `QqTask.correlation.superSessionId` 判定任务是否真的来自 QQ，
   * 本地子会话在这里就会被忽略，因此无需重复判断任务来源。转发是异步的，
   * 不阻塞子会话的提问挂起；接线层异常只记日志，不打断看板作答通道。
   */
  private forwardQqTaskQuestion(superSessionId: string, questions: readonly UserQuestion[]): void {
    const service = this.qq?.service;
    if (!service) return;
    try {
      void service
        .forwardTaskQuestion({
          superSessionId,
          questions: questions.map((question) => ({
            header: question.header,
            question: question.question,
            ...(question.options
              ? {
                  options: question.options.map((option) => ({
                    label: option.label,
                    description: option.description,
                  })),
                }
              : {}),
            multiSelect: question.multiSelect === true,
          })),
        })
        .catch((error: unknown) => {
          this.log.warn(`QQ 提问提醒转发失败：${errorMessage(error)}`);
        });
    } catch (error) {
      this.log.warn(`QQ 提问提醒转发失败：${errorMessage(error)}`);
    }
  }

  /**
   * QQ 主渠道注入回合里 agent 的提问 → 转发给发起者。
   *
   * 与 child 渠道复用服务的 `waiting_answer` / `pendingAnswers` / `/qq answer`
   * 状态机，只按 taskId 定位（main 任务没有子会话 id）。服务找不到对应 main
   * 任务（本地回合被误标）时会安静忽略，不会给无关的 QQ 用户发消息。
   */
  private forwardQqMainTaskQuestion(taskId: string, questions: readonly UserQuestion[]): void {
    const service = this.qq?.service;
    if (!service) return;
    try {
      void service
        .forwardMainTaskQuestion({
          taskId,
          questions: questions.map((question) => ({
            header: question.header,
            question: question.question,
            ...(question.options
              ? {
                  options: question.options.map((option) => ({
                    label: option.label,
                    description: option.description,
                  })),
                }
              : {}),
            multiSelect: question.multiSelect === true,
          })),
        })
        .catch((error: unknown) => {
          this.log.warn(`QQ 主会话提问提醒转发失败：${errorMessage(error)}`);
        });
    } catch (error) {
      this.log.warn(`QQ 主会话提问提醒转发失败：${errorMessage(error)}`);
    }
  }

  /**
   * QQ 主渠道任务派生的子会话提问 → 转发给发起者，答案回灌到该子会话。
   *
   * 主会话是纯委派者，真正干活的提问多来自子会话。旧路径 `forwardTaskQuestion`
   * 只认 `correlation.superSessionId && channel !== "main"` 的任务，而 main 渠道
   * QQ 任务两者都没有 —— 提问卡因此只在看板显示、QQ 永远收不到。这里按派生时
   * 记录的 QQ 主任务 id 定位任务（与 forwardMainTaskQuestion 同口径），但把应答
   * 端口指向 child：答案经 `answerRemoteQuestion(superSessionId)` 回到真正提问的
   * 子会话（`SuperAgentManager.respond`），不是主会话那张不存在的卡。
   */
  private forwardQqMainTaskChildQuestion(
    taskId: string,
    superSessionId: string,
    questions: readonly UserQuestion[],
  ): void {
    const service = this.qq?.service;
    if (!service) return;
    try {
      void service
        .forwardMainTaskChildQuestion({
          taskId,
          superSessionId,
          questions: questions.map((question) => ({
            header: question.header,
            question: question.question,
            ...(question.options
              ? {
                  options: question.options.map((option) => ({
                    label: option.label,
                    description: option.description,
                  })),
                }
              : {}),
            multiSelect: question.multiSelect === true,
          })),
        })
        .catch((error: unknown) => {
          this.log.warn(`QQ 超流体提问提醒转发失败：${errorMessage(error)}`);
        });
    } catch (error) {
      this.log.warn(`QQ 超流体提问提醒转发失败：${errorMessage(error)}`);
    }
  }

  /**
   * QQ 用户的 `/qq answer` 回灌：命中本回合的提问卡并 resolve，agent 继续。
   * 只认 `qqMainQuestionIds` 里的卡 —— 本地回合的提问绝不会被 QQ 回答误答。
   * 端口被服务超时 / 停止调用时 answers 是 `{}`（按未回答继续），语义一致。
   * 返回是否真的命中，供服务如实回执（绝不假装提交成功）。
   */
  private answerQqMainQuestion(taskId: string, answers: Record<string, string | string[]>): boolean {
    // 只认「诞生时归属这个任务」的卡 —— 本地回合的提问绝不会被 QQ 回答误答。
    // 不读实时 qqInjectedTaskId：回合收尾后它会清空，迟到的合法回答应仍可命中。
    let answered = false;
    for (const [id, ownerTaskId] of [...this.qqMainQuestionIds]) {
      if (ownerTaskId !== taskId) continue;
      const pending = this.pendingQuestions.get(id);
      if (!pending) {
        this.qqMainQuestionIds.delete(id);
        continue;
      }
      this.pendingQuestions.delete(id);
      this.qqMainQuestionIds.delete(id);
      clearTimeout(pending.timer);
      this.store.clearQuestions(id);
      pending.resolve({ answers });
      answered = true;
    }
    if (answered) {
      this.store.appendNotice(
        Object.keys(answers).length > 0
          ? vscode.l10n.t("已通过 QQ 回答 {0} 个问题", Object.keys(answers).length)
          : vscode.l10n.t("QQ 提问已按未回答继续"),
      );
    }
    return answered;
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

  /**
   * 请求 webview 弹出「清空并新建」二次确认框。
   *
   * 警示文案在宿主侧组装（含明确写出「未合并 worktree 的未提交/未合并工作
   * 永久丢失且不可恢复」），webview 只渲染、不改写。所有 teardown 路径都要
   * 收口未答的 promise：无 webview 应答时 60s 超时按「取消」处理，绝不擅自
   * 清空用户磁盘。
   */
  private requestSuperResidueConfirm(count: SuperResidueCount): Promise<boolean> {
    this.cancelAllSuperResidueConfirms();
    const requestId = `super-residue-${++this.superResidueConfirmSeq}`;
    const title = vscode.l10n.t("清空并新建会话？");
    const message = vscode.l10n.t(
      "检测到 {0} 个历史超流体残留目录（worktree {1} 个 / 降级目录 {2} 个 / 附件 {3} 个）。继续将清空全部残留，包括未合并的 worktree——其中未提交/未合并的代码改动将永久丢失且不可恢复。请确认这些工作不再需要。",
      count.total,
      count.worktrees,
      count.dirs,
      count.attachments,
    );
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        // 超时 = 用户没答：按取消处理，只新建不清空。
        this.pendingSuperResidueConfirms.delete(requestId);
        resolve(false);
      }, 60_000);
      this.pendingSuperResidueConfirms.set(requestId, { resolve, timer });
      this.postToWebview({
        type: "superResidueConfirm",
        requestId,
        title,
        message,
        confirmLabel: vscode.l10n.t("清空并新建"),
        cancelLabel: vscode.l10n.t("取消"),
      });
    });
  }

  private handleSuperResidueConfirmResponse(requestId: string, confirmed: boolean): void {
    const pending = this.pendingSuperResidueConfirms.get(requestId);
    if (!pending) return;
    this.pendingSuperResidueConfirms.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(confirmed);
  }

  private cancelAllSuperResidueConfirms(): void {
    for (const pending of this.pendingSuperResidueConfirms.values()) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.pendingSuperResidueConfirms.clear();
  }

  /**
   * 新建会话前的残留检测 + 用户授权下的全量清空（跨全部历史会话）。
   *
   * 检测只读目录计数，不跑 git 探测；没有 webview（命令面板入口）时跳过 ——
   * 没有弹框就无从确认，不能拿一个永远没人答的 promise 挡住新建会话。
   * 用户取消 / 检测失败 / 清空失败都只记日志，继续正常新建会话。
   */
  private async confirmAndPurgeSuperResidue(): Promise<void> {
    if (this.disposed || !this.editorPanel) return;
    const manager = this.getSuperAgent();
    if (!manager) return;
    const count = await manager.countResidue().catch((error: unknown) => {
      this.log.warn(`super agent: 残留检测失败（不影响新建会话）：${errorMessage(error)}`);
      return null;
    });
    if (!count || count.total === 0) return;
    const confirmed = await this.requestSuperResidueConfirm(count);
    if (this.disposed) return;
    if (!confirmed) {
      this.log.info(`super agent: 用户取消清空（残留 ${count.total} 个），只新建会话`);
      return;
    }
    const purged = await manager.purgeAllResidue().catch((error: unknown) => {
      this.log.warn(`super agent: 全量清空失败（继续新建会话）：${errorMessage(error)}`);
      return null;
    });
    if (purged) {
      this.log.info(
        `super agent: 已清空残留（worktree ${purged.worktrees} / 目录 ${purged.dirs} / 附件 ${purged.attachments}，失败 ${purged.failed}）`,
      );
      if (purged.failed > 0) {
        this.store.sendToast(
          "warning",
          vscode.l10n.t("已清空历史超流体残留，但有 {0} 个目录未能删除（请手动检查）", purged.failed),
        );
      }
    }
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
   * Mirror the CLI-bound extension setting (language) into
   * `~/.iflow/settings.json`. The CLI reads it only at startup (probed,
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
   * language sync path — the CLI only reads mcpServers at
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
   * MCP card asked for live connection state. Super Agent changes the meaning
   * of the CLI's `_iflow/mcp/status` on the MAIN session: because it starts
   * with `disableMcpServers`, every configured server is reported as
   * `{status:"disconnected", blocked:true}` — that is a deliberate design,
   * NOT a broken server. The servers are actually connected and used by the
   * child sessions through the host's shared MCP broker (`this.mcpBroker`).
   *
   * So the broker is the authority for the live connection state. We still
   * query the CLI report because it is the only source of the tools/prompts
   * declarations shown in the detail sub-page; its status/error are then
   * overridden per server from `mcpBroker.statuses()`:
   *   - broker connected    → status "connected", childConnected true, no error
   *   - broker disconnected → status "disconnected", childConnected false, error
   *   - broker not ready    → childConnected undefined; a CLI-blocked server
   *     falls back to a NEUTRAL "main session does not load MCP" (no red dot),
   *     never "server is broken".
   *
   * `contextTokens` is the host-computed BPE of the tool declarations (the
   * CLI itself has no such estimate, and re-tokenizing per render in the
   * webview would be wasteful). Any total failure (no CLI report AND no
   * broker) degrades to `status: null` — the card shows NO indicator rather
   * than a guessed one.
   */
  private async sendMcpStatus(): Promise<void> {
    const client = this.client;
    const sessionId = this.store.getState().sessionId;
    let report: McpStatusReport | null = null;
    if (client && sessionId) {
      try {
        report = await client.mcpStatus(sessionId);
      } catch (error) {
        this.log.warn(`mcpStatus unavailable: ${errorMessage(error)}`);
      }
    }

    // Child-session view: the shared broker owns the real connections.
    const brokerBy = new Map<string, McpBrokerStatus>();
    for (const entry of this.mcpBroker?.statuses() ?? []) brokerBy.set(entry.name, entry);
    if ((!report || !report.available) && brokerBy.size === 0) {
      this.postToWebview({ type: "mcpStatus", status: null });
      return;
    }

    const scopes = this.readMcpScopes();
    const servers: Record<
      string,
      McpServerStatusView & { contextTokens?: number; scope?: McpScope | "both"; childConnected?: boolean }
    > = {};
    const names = new Set<string>([...Object.keys(report?.servers ?? {}), ...brokerBy.keys()]);
    for (const name of names) {
      const cliView = report?.servers?.[name];
      const broker = brokerBy.get(name);
      // Start from the CLI view to keep tools/schema/prompts for the detail
      // sub-page; synthesize a minimal view when only the broker knows it.
      const view: McpServerStatusView & {
        contextTokens?: number;
        scope?: McpScope | "both";
        childConnected?: boolean;
      } = {
        status: "disconnected",
        toolCount: 0,
        promptCount: 0,
        tools: [],
        prompts: [],
        ...cliView,
      };
      if (broker) {
        view.status = broker.connected ? "connected" : "disconnected";
        view.childConnected = broker.connected;
        if (broker.connected) {
          delete view.error;
          delete view.errorKind;
        } else if (broker.error) {
          view.error = broker.error;
          view.errorKind = "unknown";
        }
      } else if (cliView?.blocked) {
        // Broker not ready: `blocked` only means the main session never loads
        // MCP by design. Drop any CLI "spawn failed" noise so the card renders
        // a neutral dot instead of a false red one.
        delete view.error;
        delete view.errorKind;
      }
      view.contextTokens = estimateMcpContextTokens(view.tools ?? []);
      view.scope = mcpScopeOf(name, scopes.global, scopes.project);
      servers[name] = view;
    }
    const status: McpStatusUi = {
      discoveryState: report?.discoveryState,
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
    // 跳过）。**completed 帧也要过一遍**：工具层对合法参数一律回 ack，
    // 若载荷整轮都没到达（pending 帧无 args、in_progress 帧缺失），
    // completed 是最后一次核对「到底派没派」的机会（见 handleSuperToolCall）。
    if (
      !this.restoring &&
      (n.update.sessionUpdate === "tool_call" || n.update.sessionUpdate === "tool_call_update") &&
      !(n.update as { agentId?: string }).agentId &&
      (n.update.status === "pending" ||
        n.update.status === "in_progress" ||
        n.update.status === "completed" ||
        n.update.status === "failed")
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
      this.cancelAllPendingQuestions(vscode.l10n.t("会话已删除，提问已跳过"));
    }
    try {
      await this.forgetSession(sessionId);
      await this.clearTranscript(sessionId);
      // 子会话属于这段对话：删除会话等于这段对话不存在 —— 它派发的子会话
      // 进程不能继续跑（跑完也没人接汇报），看板记录与归档归属必须一起消失。
      // 旧实现只删归档文件、不管活着的子会话：进程继续跑、心跳常驻，而且
      // 下一次落盘会把这个会话的归档重新写回磁盘。
      const forgotten = await this.superAgent?.forgetMainSession(sessionId);
      for (const entry of forgotten?.worktrees ?? []) {
        this.log.info(
          `super agent: session ${sessionId} deleted; child ${entry.id} stopped, worktree kept at ${entry.path}${
            entry.branch ? ` (branch ${entry.branch})` : ""
          }`,
        );
      }
      // 属于这个会话的待投递内容（汇报 / 动作回执 / 被改道消息 / 参数纠错 /
      // 排队的合并请求）都是「欠一段已不存在会话的回合」：留着既投不出去，
      // 又会让 hasSuperWork() 永远为真（心跳停不下来）。
      const goneIds = new Set(forgotten?.ids ?? []);
      this.pendingSuperReports.delete(sessionId);
      this.pendingSuperReportPrompts = this.pendingSuperReportPrompts.filter(
        (item) => item.mainSessionId !== sessionId,
      );
      this.pendingSuperActionReceipts = this.pendingSuperActionReceipts.filter(
        (item) => item.mainSessionId !== sessionId,
      );
      this.pendingDelegatedUserTurns = this.pendingDelegatedUserTurns.filter(
        (item) => item.mainSessionId !== sessionId,
      );
      this.pendingSuperToolCallCorrections = this.pendingSuperToolCallCorrections.filter(
        (item) => item.mainSessionId !== sessionId,
      );
      this.pendingSuperMerges = this.pendingSuperMerges.filter((item) => !goneIds.has(item.id));
      for (const id of goneIds) {
        this.superReportedChildIds.delete(id);
        this.superLastStatus.delete(id);
      }
      // The child-session archive is this session's too: keeping it would
      // resurrect the deleted session's children (and their branches) the
      // next time anyone restores anything.
      //
      // 顺序有讲究：先 force 落盘（清掉节流定时器，并且不再包含这个归属），
      // 再等在飞的写落定，最后才 rm —— 否则一个排队的写会在 rm 之后 rename，
      // 把刚删掉的归档复活。
      await this.persistSuperSessions({ force: true });
      await awaitSuperSessionArchiveWrite(this.superStoreDir(), sessionId);
      await deleteSuperSessionArchive(this.superStoreDir(), sessionId);
      // M3 P0-1: drop the session's shadow repo + checkpoint index too.
      await this.removeCheckpointsForSession(sessionId);
      // A7: drop the session's staged-attachment dir too — the transcript that
      // referenced those paths is gone, so the temp copies are pure residue.
      await rm(attachmentSessionDir(sessionId), { recursive: true, force: true }).catch((error) => {
        this.log.warn(`removing attachment dir failed: ${errorMessage(error)}`);
      });
      // 看板与忙碌态跟着删除后的现状重算：子会话全没了就不该再显示「等待
      // 汇报」，没有待办时心跳必须停表（旧实现让它常驻）。
      this.publishSuperSessions();
      this.syncSuperWaitingState();
      if (!this.hasSuperWork()) this.stopSuperHeartbeat();
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
    // 远程接续绑定在旧会话上：切走即失效。
    this.clearQqTakeover();
    this.clearQqRemoteDetachedSessions();
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
      //
      // 单独兜错：看板是**附加信息**，它坏了不能把「会话已恢复」判成失败 ——
      // 那会连带丢掉刚重建好的转录并让用户以为恢复失败。失败可见（toast +
      // 日志）但不阻断（新建会话、继续对话都照常）。
      await this.restoreSuperSessions(loadedId).catch((error: unknown) => {
        this.log.warn(`super agent: 恢复超流体记录失败（不影响会话恢复）：${errorMessage(error)}`);
        this.store.sendToast(
          "warning",
          vscode.l10n.t("超流体记录恢复失败（不影响会话）：{0}", errorMessage(error)),
        );
      });
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
    // 什么。损坏的原件已由读侧留底（归档名.corrupt），路径一并报出。
    if (archive.damaged) {
      this.log.warn(
        `super agent: 超流体归档读不出来（${archive.damage ?? "unknown"}），备份：${archive.backupPath ?? "-"}`,
      );
      this.store.sendToast(
        "warning",
        vscode.l10n.t(
          "超流体记录已损坏，原文件已备份；这条会话的超流体记录无法恢复（{0}）",
          archive.backupPath ?? archive.damage ?? "unknown",
        ),
      );
    }
    const records = archive.sessions;
    if (records.length > 0) {
      // 归档里的隔离目录可能已被外部手工删除，或上次失败的清理留下半删残迹。
      // 恢复前核对磁盘事实，让 fromPersistedSuperSession 如实校正 released /
      // recycled —— 否则看板会对一个早就不存在的目录显示「待清理」。
      // **必须用原始 isolation.path 判存在性**：comparisonPathKey 为路径比较做了
      // toLowerCase，Linux 大小写敏感，用它 existsSync 会把 mkdtemp 随机后缀含大写
      // 字母的现存目录误判为不存在（ubuntu CI 实测），进而错误保留 released:true。
      // 核对失败时不猜（留 undefined = 保留归档原样）；这里只读盘，**绝不自动删**
      // 任何孤儿目录或分支。
      const restored = await Promise.all(
        records.map(async (record) => {
          const kind = record.isolation.kind;
          if (kind === "repo") return fromPersistedSuperSession(record);
          try {
            return fromPersistedSuperSession(record, {
              worktreePresent: existsSync(record.isolation.path),
            });
          } catch {
            return fromPersistedSuperSession(record);
          }
        }),
      );
      this.log.info(`super agent: restored ${restored.length} historical child session(s) for ${mainSessionId}`);
      this.getSuperAgent()?.restoreSessions(mainSessionId, restored);
    }
    // 恢复归档时顺带清扫磁盘上的残留 worktree（只在恢复时触发，不是每次
    // 快照都跑）：上次运行遗留的、已经并入当前分支的空 worktree 与分支，
    // 在这里被收掉 —— 否则它们会一直堆在 `.iflow/super/worktrees/` 下。
    // 超过 `iflow.superAgent.maxWorktrees` 的干净残留（含未合并的）按目录
    // mtime 从旧到新回收目录、保留分支。
    //
    // **绝不 await**：这一步要逐个残留目录跑 `git status` + merge-base 探测，
    // 而本方法处于 connect() 的启动序列里（restoreSession 被 await），新建
    // 会话又要先等在飞的恢复 settle —— 串起来就是用户实测的「点新建会话
    // 毫无反应，只在控制台反复打 new session: joining the in-flight run」。
    this.sweepStaleWorktreesInBackground();
  }

  /**
   * 后台清扫磁盘上的残留 worktree（**绝不阻塞会话恢复 / 新建会话**）。
   *
   * 因果链（2026-11-18 用户实测）：`connect()` → `restoreSession()` →
   * `restoreSuperSessions()` → `await sweepStaleWorktrees()`。每个残留目录都要
   * 跑 `git status --porcelain` 与 `merge-base --is-ancestor`，工程一大（或磁盘
   * 被索引器/杀软占着）就是几十秒；期间用户点「新建会话」→ `startNewSession`
   * 发现恢复在飞 → 停在恢复的 settle 上 → 后续点击全部 join 同一次 run。
   *
   * 纪律：
   *  - fire-and-forget，但**必须有 catch**：清扫失败只记警告 + 一条提示，
   *    绝不变 unhandled rejection，也绝不影响新建会话；
   *  - 同一时刻只跑一次（`sweepInFlight`）：恢复被反复触发时不叠多份 git 子进程；
   *  - 清扫本身幂等（见 `SuperAgentManager.sweepStaleWorktrees`），晚一点跑与
   *    早一点跑结果相同，代价只是磁盘残留多留一会儿。
   */
  private sweepStaleWorktreesInBackground(): void {
    if (this.disposed || this.sweepInFlight) return;
    const manager = this.getSuperAgent();
    if (!manager) return;
    const maxKeep = clampMaxSuperWorktrees(
      vscode.workspace
        .getConfiguration("iflow")
        .get<number>("superAgent.maxWorktrees", DEFAULT_MAX_SUPER_WORKTREES),
    );
    // 同步占位：延时窗口内反复恢复 / 新建会话也只排一份 sweep。manager 的
    // 同步抛错仍在调用点按原语义冒泡（由上层 catch 兜住），不推迟到定时器里。
    this.sweepInFlight = true;
    const timer = setTimeout(() => {
      if (this.disposed) {
        this.sweepInFlight = false;
        return;
      }
      void Promise.resolve()
        // 用一个已 resolve 的 promise 起链：manager 的同步抛错也落进 catch，
        // 不会在定时器回调里炸出去变成 unhandled rejection。
        .then(async () => {
          // 三类残留同在 `.iflow/super/` 下：worktrees（既有清扫）、attachments、
          // dirs（降级目录）。并排跑，任何一类失败都落进下面的 catch，不影响会话。
          // 每一项都经 Promise.resolve().then() 包一层：即便某个 manager 方法同步
          // 抛错（stub 未实现 / 未来改动），也只是该项变成 rejected，不会在数组
          // 求值时打断其余项的 handler 绑定 —— 否则先返回的 rejected promise 会
          // 变成 unhandled rejection（Vitest Errors 1）。
          const [swept] = await Promise.all([
            Promise.resolve().then(() => manager.sweepStaleWorktrees({ maxKeep })),
            Promise.resolve().then(() => manager.sweepStaleSuperAttachmentDirs()),
            Promise.resolve().then(() => manager.sweepStaleSuperDirs()),
          ]);
          return swept;
        })
        .then((swept) => {
          if (this.disposed) return;
          if (swept.removed > 0 || swept.kept > 0 || swept.orphans.length > 0) {
            this.log.info(
              `super agent: 残留清扫（后台）— 删除 ${swept.removed} 个，保留 ${swept.kept} 个，疑似残留 ${swept.orphans.length} 个（需人工确认）`,
            );
          }
        })
        .catch((error: unknown) => {
          // 背景清扫失败不是会话故障：可观测（日志 + 提示），但绝不冒泡。
          this.log.warn(`super agent: 后台残留清扫失败（不影响会话）：${errorMessage(error)}`);
          if (!this.disposed) {
            this.store.sendToast(
              "warning",
              vscode.l10n.t("后台清理残留工作目录失败（不影响会话）：{0}", errorMessage(error)),
            );
          }
        })
        .finally(() => {
          this.sweepInFlight = false;
        });
    }, this.superSweepDelayMs);
    // 定时器本身不该把扩展宿主 / 测试进程吊住。
    timer.unref?.();
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
      // createSuperClient awaits ensureMcpBroker() first, so by the time the
      // manager asks for entries the broker (when any server is configured) is
      // already listening. Read lazily: a child spawned later still sees it.
      childMcpServers: () => this.mcpBroker?.sessionServers() ?? [],
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
      // 远程派发的任务还要把这条提问提醒转发给 QQ 发起者（本地任务不受影响：
      // 服务侧找不到对应的 QQ 任务就会直接忽略）。
      onNeedInput: (session) => {
        this.notifyOs("question", vscode.l10n.t("超流体「{0}」在等你回答", session.title));
        if (session.pending?.kind === "question") {
          // main 渠道 QQ 任务派生的子会话：按 QQ 主任务寻址，答案回灌子会话。
          // 旧 child 渠道仍走 superSessionId 匹配，两者互不干扰。
          const qqMainTaskId = this.qqTaskBySuperSession.get(session.id);
          if (qqMainTaskId) {
            this.forwardQqMainTaskChildQuestion(qqMainTaskId, session.id, session.pending.questions);
          } else {
            this.forwardQqTaskQuestion(session.id, session.pending.questions);
          }
        }
      },
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
              "合并超流体已把超流体「{0}」的分支 {1} 合入当前分支",
              info.title,
              info.branch,
            ),
          );
        } else {
          this.store.sendToast(
            "warning",
            vscode.l10n.t(
              "合并超流体没能完成合并，分支仍保留：{0}（{1}）",
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

  /**
   * Start (once) the host MCP broker for the configured servers.
   *
   * Merging mirrors the CLI: `{...user, ...workspace}` — the project entry of a
   * name wins. Disabled / unusable entries are skipped and logged; because the
   * child's `--allowed-mcp-server-names` list comes from the broker's names, a
   * skipped server is also absent from the child instead of being silently
   * spawned per child.
   *
   * Returns null when there is nothing to broker, or when startup itself
   * failed — callers then scope the child to the sentinel (no MCP). A broker
   * whose UPSTREAM fails is not a startup failure: the failure surfaces on the
   * child's first request and in the panel log, and never blocks spawning.
   */
  private async ensureMcpBroker(): Promise<McpBroker | null> {
    if (this.mcpBroker) return this.mcpBroker;
    if (this.mcpBrokerStarting) return this.mcpBrokerStarting;
    this.mcpBrokerStarting = (async (): Promise<McpBroker | null> => {
      const scopes = this.readMcpScopes();
      const servers: Record<string, unknown> = { ...scopes.global, ...(scopes.project ?? {}) };
      const { servers: usable, skipped } = normalizeBrokerServers(servers);
      for (const entry of skipped) {
        this.log.warn(`MCP broker: 跳过 "${entry.name}"（${entry.reason}）`);
      }
      if (usable.length === 0) return null;
      try {
        const broker = await McpBroker.start({
          servers,
          cwd: this.mcpProjectCwd() ?? undefined,
          log: (level, message) => this.log[level](`[mcp-broker] ${message}`),
        });
        this.mcpBroker = broker;
        // Eager handshake so failures land in the log early instead of only on
        // the first tool call; never awaited — a slow `npx` must not delay the
        // child spawn (the child's own initialize waits on the same promise).
        void broker.prewarm();
        this.log.info(
          `MCP broker listening on ${broker.baseUrl} for: ${broker.names().join(", ")}`,
        );
        return broker;
      } catch (error) {
        this.log.error(`MCP broker failed to start: ${errorMessage(error)}`);
        this.store.sendToast(
          "error",
          vscode.l10n.t("MCP 共享代理启动失败，超流体将无 MCP 工具：{0}", errorMessage(error)),
        );
        return null;
      }
    })().finally(() => {
      this.mcpBrokerStarting = null;
    });
    return this.mcpBrokerStarting;
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
    // 子会话必须能用 MCP，但**不能**每个子会话各起一套服务器：宿主 broker
    // 先认领每个配置的 server（每 server 只一份进程），子会话经 loopback
    // streamable-HTTP 连它。这里把子会话的 CLI 进程作用域收窄到 broker 的
    // server 名，用户配置里的 stdio server 因此在子会话进程里根本不会被拉起。
    // broker 为空（没有配置 / 启动失败）时传空数组 → 哨兵 → 子会话无 MCP，
    // 与启动失败时的 toast 一起如实暴露，绝不伪造共享。
    const broker = await this.ensureMcpBroker();
    const { args } = buildAcpCommand(entry, includeDirectories, {
      mcpServerNames: broker?.names() ?? [],
    });
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
   * 换会话 / 恢复会话 / 热重认证时重置委派与动作扫描状态。
   *
   * 滚动缓冲里是上一个会话的助手文本（可能还有没收口的围栏），去重账本里是
   * 上一个会话派发过的载荷 —— 两者都跟新会话无关：不清掉会让新会话的扫描
   * 基线落在别人的文本上，还会把本该重新派发的指令误判成重复。
   *
   * 动作通道同理：`superActionScanText/Offset` 是上一个会话的助手文本与消费
   * 偏移；`superActionReceiptLast` 是**上一个会话**最后一条回执文本。
   * 后者不清会让另一个主会话里**一模一样**的动作回执被当成重复丢弃 ——
   * 那个会话根本没收到过这条回执，主会话因此以为动作没生效、反复重发。
   */
  private resetSuperDirectiveScans(): void {
    this.superScan.reset();
    this.superDispatchedDirectives.clear();
    this.superToolCallWarned.clear();
    this.superToolCallActionsDone.clear();
    this.superToolCallOutcomes.clear();
    this.superToolCallCorrections.clear();
    this.superActionScanText = "";
    this.superActionScanOffset = 0;
    this.superActionPending = false;
    this.superActionPendingBody = "";
    this.superActionZeroWarned = false;
    this.superActionReceiptLast = "";
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
        vscode.l10n.t("超流体派发指令无法解析（{0}，内容共 {1} 字符），已忽略", first.reason, first.body.length),
      );
    }
    if (scan.blocks.length === 0) return;
    this.dispatchSuperTasks(scan.blocks, scan.issues);
  }

  /**
   * 把解析出的委派任务交给子会话管理器。
   *
   * 正文围栏（{@link scanSuperDirectives}）与结构化工具调用
   * （{@link handleSuperToolCall}）共用这一段：去重键、附件丢弃计数、
   * toast 文案都不允许两条通道各写一份 —— 同一份载荷从两条路径同时到达时，
   * `superDirectiveDedupeKey` 必须能看见同一个账本，否则会双开子会话。
   */
  private dispatchSuperTasks(
    blocks: readonly SuperTaskSpec[][],
    issues: readonly string[] = [],
  ): void {
    const manager = this.getSuperAgent();
    if (!manager) {
      this.store.sendToast("warning", vscode.l10n.t("没有打开的工作区，无法派发超流体"));
      return;
    }
    if (issues.length > 0) {
      // 混合载荷：合法任务照常派发，但被丢掉的畸形条目必须可见 —— 静默丢一半
      // 正是「用户只看到一堵 JSON 墙」的来源。只报首条原因，避免 toast 过长。
      this.store.sendToast(
        "warning",
        vscode.l10n.t(
          "已忽略 {0} 个格式错误的任务条目（{1}）",
          issues.length,
          issues[0] ?? "",
        ),
      );
      // 被丢掉的条目不会自己回来：把原因送回主会话，让模型重发完整条目。
      // 与「整体不可解析」共用同一限次账本（同一轮最多 2 次）。
      this.queueSuperToolCallCorrection(issues[0] ?? "");
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
        // 注入回合（qqInjectedTaskId 非空）里派生的子会话归属该 QQ 主任务：记下
        // 映射，子会话随后 ask_user_question 时才能把提醒转发给同一个 QQ 用户。
        // 本地回合派生（qqInjectedTaskId 为空）不登记，保持本地提问不转发。
        if (this.qqInjectedTaskId) {
          this.qqTaskBySuperSession.set(session.id, this.qqInjectedTaskId);
        }
        this.rememberDispatchedDirective(dedupeKey);
        dispatched++;
        this.log.info(`super agent: dispatched ${session.id} 「${spec.title}」`);
      }
    }
    if (droppedAttachments > 0) {
      this.store.sendToast(
        "warning",
        vscode.l10n.t("超流体派发指令中有 {0} 个附件不可用（不在工作区或暂存目录），已忽略", droppedAttachments),
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
      vscode.l10n.t("已派发 {0} 个超流体（并发上限 {1}）", dispatched, concurrency),
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
    // 名字归一之外也认 getDescription 的短标签：智能审批形态的权限请求 /
    // 工具帧可能只带标题（`Delegate 1 task` / `Manage 1 child session action`），
    // 见 shared/super-tool-call.ts 的 classifySuperToolTitle。
    const kind = classifySuperToolName(name) ?? classifySuperToolTitle(name);
    if (!kind) return;
    // 账本键与 superToolCallWarned 用同一个原始 id（不裁剪），否则同一个
    // 工具调用的告警记录与结果记录会被当成两个键。
    const toolCallId = update.toolCallId ?? "";
    // 失败帧已经由内核把真实错误回给模型（functionResponse.error），宿主
    // 不需要再核对 —— 再说一遍只会制造重复噪音。
    if (update.status === "failed") return;
    // 同一条调用已经处理过（派发 / 动作 / 已留痕），后续帧一律跳过：
    // 否则 in_progress 与 completed 各带一次载荷会各派一遍。
    if (toolCallId && this.superToolCallOutcomes.has(toolCallId)) return;
    const hasArgs = update.args !== undefined && update.args !== null;
    if (!hasArgs) {
      // Wire 实证（CLI 0.5.19，见 protocol.ts 的 `args` 注释）：原始参数只随
      // `tool_call_update(in_progress)` 到达，pending 帧通常没有 args。此时还
      // 不能下结论 —— 下一帧就会带载荷；在 pending 帧弹「未派发子会话」是
      // 误报。但 completed 帧仍然没有载荷，就说明这次调用整轮都没把东西交给
      // 宿主，必须核对（工具层只回 ack，模型会以为派成功）。
      if (update.status === "completed") this.auditSuperToolCallCompletion(update, name);
      return;
    }
    const parsed = parseSuperToolCall(kind, update.args);
    if (!parsed.ok) {
      this.warnUnsupportedSuperToolCall(update, name, parsed.reason, parsed.issues);
      return;
    }
    // 载荷纠偏：新版 `super-agent` 工具同时收 tasks / actions，模型做管理动作
    // 时可能只传 `{"actions":[…]}`（名字仍是 dispatch）。分流以解析器纠偏后的
    // kind 为准 —— 管理动作走动作链路，既不派发子会话，也不是「未派发」失败。
    this.log.info(
      `super agent: accepted structured ${parsed.kind} tool call (${update.toolCallId || "no-id"})`,
    );
    if (parsed.kind === "dispatch") {
      this.dispatchSuperTasks(parsed.tasks, parsed.issues);
      // 记账放在派发之后：dispatchSuperTasks 是同步的，完成后才写终态，
      // 避免「记了已派发、实际抛错」的假账。
      this.recordSuperToolCallOutcome(toolCallId, "dispatched");
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
      this.recordSuperToolCallOutcome(toolCallId, "actions");
      return;
    }
    this.rememberSuperToolCallActions(actionKey);
    // 记账在启动前：runSuperActions 是异步的，completed 帧可能在它 settle 前
    // 到达，先记才能保证不重复执行同一条动作。
    this.recordSuperToolCallOutcome(toolCallId, "actions");
    // 带上 toolCallId：runSuperActions 收尾时把每条动作的真实结果回填到这张
    // 工具帧，动作卡才能显示「中断成功 / not-found」而不是绿色「已完成」。
    void this.runSuperActions(parsed.actions, update.toolCallId);
  }

  /**
   * completed 帧核对：这次结构化工具调用到底有没有把载荷交给宿主。
   *
   * 触发条件是「载荷整轮都没到达」（见 {@link handleSuperToolCall} 的
   * `!hasArgs` 分支）。此时工具层已经向模型回了 `Delegation request accepted.`，
   * 但宿主什么都没做 —— 用户会看到「模型说已派发、看板空空如也」。这里补上
   * 两条留痕：用户可见 toast + 回给主会话的纠错提示（带原因与正确格式），
   * 让模型能在同一轮里重发。
   *
   * 之前报过「载荷不合法」的调用不再重复报（toast 已经在
   * {@link warnUnsupportedSuperToolCall} 里弹过），只补记终态。
   */
  private auditSuperToolCallCompletion(update: ToolCallBase, name: string): void {
    const id = update.toolCallId ?? "";
    if (id && this.superToolCallOutcomes.has(id)) return;
    if (id && this.superToolCallWarned.has(id)) {
      this.recordSuperToolCallOutcome(id, "rejected");
      return;
    }
    this.recordSuperToolCallOutcome(id, "dropped");
    this.log.warn(
      `super agent: tool call 「${name}」 (${id || "no-id"}) completed without a usable payload — NOTHING was dispatched`,
    );
    this.store.sendToast(
      "warning",
      vscode.l10n.t("super-agent 工具调用已完成，但宿主没有收到派发载荷，未派发任何超流体"),
    );
    this.queueSuperToolCallCorrection(
      "the tool call completed without a usable payload — no tasks/actions ever reached the host, so nothing was dispatched",
    );
  }

  /**
   * 记一条结构化工具调用的终态（有界 Map，超了丢最早一条）。
   *
   * 与 {@link superToolCallWarned} / {@link superToolCallActionsDone} 同一套
   * 有界做法：工具帧数量本身不设界，账本必须有上限；换会话 / 恢复会话 /
   * 热重认证时由 {@link resetSuperDirectiveScans} 清空。
   */
  private recordSuperToolCallOutcome(
    toolCallId: string,
    outcome: SuperToolCallOutcome,
  ): void {
    if (!toolCallId) return;
    if (this.superToolCallOutcomes.size >= ChatPanel.SUPER_TOOL_CALL_OUTCOME_CAP) {
      const oldest = this.superToolCallOutcomes.keys().next().value;
      if (oldest !== undefined) this.superToolCallOutcomes.delete(oldest);
    }
    this.superToolCallOutcomes.set(toolCallId, outcome);
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
  private warnUnsupportedSuperToolCall(
    update: ToolCallBase,
    name: string,
    reason: string,
    issues: readonly string[] = [],
  ): void {
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
      vscode.l10n.t("super-agent 调用载荷不合法（{0}），未派发超流体", reason),
    );
    // 宿主能看见「这次没派出去」，模型却只收到一个 failed 工具帧 —— 补一条
    // hidden prompt 把原因和正确格式送回主会话上下文，让它在同一轮里自行修正。
    this.queueSuperToolCallCorrection(issues[0] ?? reason);
  }

  /**
   * 入队一条「super-agent 参数不合法」的纠错提示（hidden prompt）。
   *
   * 限次是硬约束：同一主会话同一轮最多 {@link SUPER_TOOL_CALL_CORRECTION_CAP}
   * 次，超出只留 toast 与日志 —— 工具层已经会让这次调用 failed，模型若坚持
   * 写同样的错误参数，宿主不能无限给自己喂回合。
   *
   * 提示词只带**原因**与**正确格式示例**，绝不回贴畸形原文：原文可能就是
   * 一大段错位 JSON，贴回上下文既浪费 token，又可能诱导模型照抄。
   */
  private queueSuperToolCallCorrection(detail: string): void {
    const owner = this.currentMainSessionId();
    const key = owner ?? "";
    const used = this.superToolCallCorrections.get(key) ?? 0;
    if (used >= ChatPanel.SUPER_TOOL_CALL_CORRECTION_CAP) {
      this.log.info(
        `super agent: parameter-correction prompt suppressed (${used}/${ChatPanel.SUPER_TOOL_CALL_CORRECTION_CAP} used this round)`,
      );
      return;
    }
    this.superToolCallCorrections.set(key, used + 1);
    const text = [
      "[super-agent tool call rejected]",
      `Reason: ${detail}`,
      "Required format:",
      '{"tasks":[{"title":"short title","task":"self-contained brief"}]}',
      "请修正后重新调用 super-agent（不要重复提交同样的参数）。",
    ].join("\n");
    this.pendingSuperToolCallCorrections.push({ mainSessionId: owner, text });
    this.log.info("super agent: queued a parameter-correction prompt for the main session");
    // 工具调用必然发生在主会话生成中，几乎一定等不到空闲 —— 点着心跳，
    // 回合结束后由统一仲裁补投；心跳也会在没有其它待办时自行停表。
    this.ensureSuperHeartbeat();
    void this.drainSuperAutoTurns();
  }

  /**
   * 把排队的纠错提示逐条投给主会话。
   *
   * 与子会话汇报 / 动作回执 / 合并请求共用同一条「主会话空闲」车道：同一时刻
   * 只能有一个回合跑在同一个 ACP 会话上。条件不满足就把提示留在队列里，
   * 由心跳重试 —— 丢了它模型就永远不知道自己错在哪。
   */
  private async drainSuperToolCallCorrections(): Promise<void> {
    if (this.disposed || this.superReportRunning) return;
    if (this.autoTurnsHeld()) return;
    // 与汇报 / 动作回执 / 改道消息补投共用 superReportRunning 这一条车道：
    // mainLane 的同步申领才是「同一时刻只有一个回合」的实际保证，四个 drain
    // 用同一把重入锁即可，不需要另立一把（那只会让注释与实现漂移）。
    this.superReportRunning = true;
    try {
      while (this.pendingSuperToolCallCorrections.length > 0) {
        if (this.disposed) return;
        if (this.autoTurnsHeld()) break;
        if (!this.mainSessionFree()) break;
        // 合并子会话在主仓工作区跑 git：主会话此时再跑回合会互相踩。
        if (
          this.superMergeRunning ||
          this.pendingSuperMerges.length > 0 ||
          this.superMergeChildRunning()
        ) {
          break;
        }
        // 只投当前主会话的提示：别的会话等用户切过去再投（串台）。
        const owner = this.currentMainSessionId();
        const index = this.pendingSuperToolCallCorrections.findIndex(
          (item) => item.mainSessionId === owner,
        );
        if (index === -1) break;
        const item = this.pendingSuperToolCallCorrections[index]!;
        this.log.info("super agent: delivering the parameter-correction prompt as a hidden main-session turn");
        const started = await this.sendPrompt(item.text, undefined, undefined, undefined, {
          delegateOnBusy: false,
          hidden: true,
        });
        if (!started) break; // 主会话被占：留在队列里等心跳重投。
        const pos = this.pendingSuperToolCallCorrections.indexOf(item);
        if (pos !== -1) this.pendingSuperToolCallCorrections.splice(pos, 1);
        // 这一轮端点 / 内核报错：别在心跳里连续喂下一条，留给用户处理。
        if (this.store.getState().status === "error") break;
      }
    } catch (error) {
      this.log.warn(`super agent correction delivery failed: ${errorMessage(error)}`);
    } finally {
      this.superReportRunning = false;
    }
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
      this.store.sendToast("warning", vscode.l10n.t("超流体管理指令无法解析，已忽略"));
    }
    if (scan.actions.length > 0) {
      void this.runSuperActions(scan.actions);
    }
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
            const outcome = await manager.cancel(action.sessionId, "agent");
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
                  "中断失败：找不到超流体 {0}，可能已被清理或 id 有误",
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
      this.store.sendToast("info", vscode.l10n.t("已按主会话指令管理超流体：成功 {0} 个", applied));
    }
    if (ignored > 0) {
      this.store.sendToast(
        "warning",
        vscode.l10n.t("{0} 个超流体管理动作未生效（目标不存在或状态不适用）", ignored),
      );
    }
    // 工具调用触发的动作：把真实结果回填到那张工具帧，动作卡据此显示
    // 「完成 / 未找到 / 失败」而不是把「工具调用完成」当成动作成功。
    // 同时把每条动作的目标子会话标题一并回填 —— 标题只存在于宿主的
    // super-session 记录里（webview 无权查表），带下去卡片才能显示
    // 「标题（id）」而不是裸 id。取不到标题（记录已清理）就留空，
    // 卡片优雅退回只显示 id。
    if (toolCallId) {
      const enriched: SuperDirectiveAction[] = actions.map((action) => {
        const title = manager.get?.(action.sessionId)?.title?.trim() || undefined;
        switch (action.action) {
          case "answer":
            return {
              action: action.action,
              sessionId: action.sessionId,
              ...(title ? { title } : {}),
              answerCount: Object.keys(action.answers ?? {}).length,
            };
          case "cleanup":
            return {
              action: action.action,
              sessionId: action.sessionId,
              ...(title ? { title } : {}),
              ...(action.keepBranch ? { keepBranch: true } : {}),
            };
          default:
            return {
              action: action.action,
              sessionId: action.sessionId,
              ...(title ? { title } : {}),
            };
        }
      });
      this.store.superActionResult(toolCallId, receipts, enriched);
    }
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
    void this.drainSuperAutoTurns();
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
      // 等 sendPrompt 的这几分钟里 deleteSession / dispose 会并发改写队列，
      // 之前 findIndex 拿到的 index 可能已经指向别人。按对象身份重定位，
      // 与 drainSuperReports / drainDelegatedUserTurns 同一套出队纪律：
      // 宁可找不到（已被删除会话清掉）也不误删别的会话刚投出的回执。
      const pos = this.pendingSuperActionReceipts.indexOf(item);
      if (pos !== -1) this.pendingSuperActionReceipts.splice(pos, 1);
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
   * 来源子会话已经被清理（用户点清理 / 合并完释放）时，它的汇报没法再作为
   * 一次「实时汇报」投进主会话 —— 但结论不静默丢失：以「已归档子会话的迟到
   * 结论」提示落到看板（见 {@link announceArchivedLateReports}），既不伪造活
   * 跃子会话的汇报，也让用户真正看到那个结论。面板不会卡在忙碌态。
   *
   * 心跳与看板变化时都补一次重算：子会话被清理之后可能再没有人来触发取件
   * （它的 onReport 不会再来第二次）。
   */
  private settleSuperReportsIfReady(): void {
    if (this.disposed || this.superReportRunning) return;
    if (this.pendingSuperReports.size === 0) return;
    const live = this.superAgent?.list() ?? [];
    // 来源子会话已不存在：结论不能静默丢 —— 用**全部**活子会话判（别的会话
    // 的汇报也得保住，只是现在没人接），取回完整条目交给看板提示。
    for (const buffer of this.pendingSuperReports.values()) {
      const archived = buffer.takeMissing(live);
      if (archived.length > 0) {
        this.log.warn(
          `super agent: ${archived.length} child report(s) arrived after their session(s) were cleaned up; surfacing as archived late conclusion(s)`,
        );
        this.announceArchivedLateReports(archived);
      }
    }
    // 只取当前主会话那一桶：别的会话的汇报留在它自己的桶里等用户切过去。
    const buffer = this.pendingSuperReports.get(this.currentMainSessionId() ?? "");
    if (!buffer || buffer.size === 0) return;
    const mine = live.filter((session) => this.superBelongsToCurrentMain(session));
    const batch = buffer.takeSettled(mine);
    if (!batch) return; // 全都还在跑：继续积累。
    const manager = this.superAgent;
    // 汇报归属会话：pendingCount 与 QQ awaiter 归属都用它，避免从 entries[0]
    // 推断时因异步归属回填而与 awaiter 漂移（R2）。
    const reportOwner = this.currentMainSessionId();
    // 迟到补发判定必须早于提示词生成：pendingCount>0 却被放宽为 final 的回合，
    // 提示词也要同步改成「本次给最终汇报」，否则模型照常压制最终正文，标记与
    // 提示词自相矛盾（2026-11-19 补发抢跑 bug）。
    const rescueDue = this.qqFinalRescueDue(reportOwner);
    let text = "";
    let pendingCount: number | undefined;
    if (manager && typeof manager.reportPromptWithPending === "function") {
      const prompt = manager.reportPromptWithPending(batch, {
        pendingOwner: reportOwner,
        finalOverride: rescueDue,
      });
      text = prompt.text;
      pendingCount = prompt.pendingCount;
    } else {
      // 兼容只提供 reportPrompt 的假实现（测试夹具）：文本逐字节照旧，
      // pendingCount 在下面按同一口径用 list() 重算。
      text = manager?.reportPrompt(batch) ?? "";
    }
    if (!text) return;
    if (pendingCount === undefined) {
      const owner = batch[0]?.session.mainSessionId ?? this.currentMainSessionId() ?? null;
      pendingCount = (manager?.list() ?? []).filter(
        (session) =>
          !isTerminalSuperStatus(session.status) && (session.mainSessionId ?? owner) === owner,
      ).length;
    }
    this.log.info(`super agent: queued report for ${batch.length} settled child session(s)`);
    // pendingCount=0 即「所有子会话都已结束」的汇总轮 —— 主 Agent 在这一轮
    // 给出最终完整汇报，是 QQ 最终回执应当采用的那一轮文本。
    // R2 迟到补发：若该会话的 QQ awaiter 已等过阈值，而 pendingCount 因别的
    // 非终态子会话（复核子会话等）长期 >0，就别让 final 永远=false —— 以本轮
    // 文本作为最终回执（空文本再由 deliverQqMainFinalAnswer 兜底）。
    if (rescueDue && pendingCount !== 0) {
      this.log.warn(`QQ 最终回执迟到补发：汇报轮 pendingCount=${pendingCount}，仍按 final 投递`);
    }
    // 子会话汇报正文：二次转述（主 Agent 汇总轮）确为空时，兜底回给用户看的是
    // 子会话实际做了什么，而不是一句占位文案。取本批终态汇报的 summary（失败 /
    // 中断的取 error 或「已中断」），清洗在消费端做（见 sanitizeQqReportFallback）。
    const fallbackText = batch
      .map((entry) => {
        const summary = entry.report?.summary ?? entry.session.summary ?? "";
        const error = entry.session.error ?? "";
        return summary.trim() || error.trim() || (entry.report?.state === "dropped" ? "已中断" : "");
      })
      .filter((value) => value.length > 0)
      .join("\n")
      .trim();
    // QQ task 级归属：把本批每个子会话的汇报正文归到派生它的主任务（见
    // qqTaskBySuperSession）。deliverQqMainFinalAnswer 据此逐 task 投递各自的
    // 结论，同会话多条消息不再共用一份汇总文本（重复卡根因）。只记仍在等的
    // 任务，避免给已收尾的任务留陈旧缓存。
    for (const entry of batch) {
      const taskId = this.qqTaskBySuperSession.get(entry.session.id);
      if (!taskId || !this.qqMainFinalAwaiters.has(taskId)) continue;
      const own = sanitizeQqReportFallback(
        entry.report?.summary ||
          entry.session.summary ||
          entry.session.error ||
          (entry.report?.state === "dropped" ? "已中断" : ""),
      );
      if (!own) continue;
      const prev = this.qqTaskFinalText.get(taskId);
      this.qqTaskFinalText.set(taskId, prev ? `${prev}\n${own}` : own);
    }
    this.pendingSuperReportPrompts.push({
      mainSessionId: reportOwner,
      text,
      final: pendingCount === 0 || rescueDue,
      fallbackText,
    });
    this.ensureSuperHeartbeat();
    // 用户按过停止时补一次常驻「继续处理」提示：此后才结束的子会话此前不会
    // 触发 announceDeferredAutoTurns（那时待处理数还是 0），于是恢复只剩「下
    // 条消息」这一个解除点。这里让新到的汇报也点亮那个可点动作。
    if (this.autoTurnsHeld()) this.announceDeferredAutoTurns();
    void this.drainSuperAutoTurns();
  }

  /**
   * 已归档（被清理 / 合并释放）子会话的迟到结论：以可关闭的 `sticky` 提示落到
   * 看板，明确标注来源已不存在，绝不伪装成活跃子会话的实时汇报或 hidden 回合
   * （那会伪造用户气泡 / 会话标题 / checkpoint）。
   *
   * 每条结论单独一条提示并截断到摘要长度，避免长 summary 把 toast 栈撑爆；
   * 文案只含本地标题与汇报正文，不含 id / 路径 / 凭据。
   */
  private announceArchivedLateReports(entries: readonly SuperReportEntry[]): void {
    if (entries.length === 0 || this.disposed) return;
    for (const entry of entries) {
      const summary = entry.report.summary.trim() || vscode.l10n.t("（该汇报没有正文）");
      const clipped =
        summary.length > SUPER_ARCHIVED_REPORT_MAX_CHARS
          ? `${summary.slice(0, SUPER_ARCHIVED_REPORT_MAX_CHARS)}…`
          : summary;
      this.store.sendToast(
        "info",
        vscode.l10n.t("已归档超流体「{0}」的迟到结论（该超流体已被清理，主会话未能在当时收取）：{1}", entry.session.title, clipped),
        { sticky: true },
      );
    }
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
        // R2 迟到补发缓存：记下本轮开始前的可见文本锚点，回合结束后提取本轮
        // 新增的 assistant 文本。正常 final 投递不受影响；仅当 QQ  awaiter 迟到
        // 补发时才用到它（而没有真实正文时由兜底文案接管）。
        const visibleBefore = this.store.getState().blocks.filter(
          (block) => block.kind === "text" && !block.system,
        );
        const reportAnchor = visibleBefore[visibleBefore.length - 1];
        const reportAnchorId = reportAnchor?.id;
        const reportAnchorLen = reportAnchor?.kind === "text" ? reportAnchor.text.length : 0;
        const reportTextBefore = visibleBefore.length;
        // 子会话汇报正文（report.summary）作为「二次转述确实为空」时的兜底：
        // 先清洗（去协议标记 / 脱敏 / 截断），预置进 R2 缓存，并透传给 sendPrompt
        // 的最终回执收尾。宿主本就持有这段正文，绝不只发一句占位文案。
        const cleanFallback = sanitizeQqReportFallback(item.fallbackText);
        if (cleanFallback && owner && this.qqFinalRescueOwnerPending(owner)) {
          this.qqFinalRescueText.set(owner, cleanFallback);
          // 独立缓存：不会被下面非 final 进度轮的 reportTurnText 覆盖，硬上限
          // 补发时即使缓存正文为空也能回真实汇报正文（2026-11-19 补发抢跑 bug）。
          this.qqReportFallbackText.set(owner, cleanFallback);
        }
        const started = await this.sendPrompt(item.text, undefined, undefined, undefined, {
          delegateOnBusy: false,
          hidden: true,
          // 这一轮是「主会话汇报子会话结果」：收尾时用 superReport 事件 +
          // done 音（与单个子会话收尾的 childDone + child 音区分开）。
          reportTurn: true,
          // pendingCount=0 的汇总轮：收尾时把这一轮 assistant 文本作为 QQ
          // 任务的真正最终答复回传（中途进度汇报轮不带此标记）。
          finalReport: item.final === true,
          // 汇总轮二次转述为空时，用子会话真实汇报正文兜底（见 deliverQqMainFinalAnswer）。
          finalFallbackText: item.fallbackText,
        });
        if (!started) {
          // 回合没跑起来（主会话被别的回合占着）：这条汇报**留在队列里**，
          // 等空闲时重投 —— 汇报丢了主会话就永远读不到自己孩子的结果。
          break;
        }
        const pos = this.pendingSuperReportPrompts.indexOf(item);
        if (pos !== -1) this.pendingSuperReportPrompts.splice(pos, 1);
        // 本轮 assistant 正文：只含 agent 的 text 块（thought / tool / diff /
        // 子会话卡都不在其中），与最终结果取文本同口径。
        const reportTurnText = this.captureQqReportTurnText(
          reportAnchorId,
          reportTextBefore,
          reportAnchorLen,
        );
        // R2：缓存本轮正文供迟到补发复用（只在该会话仍有 awaiter 时才有意义）。
        if (reportTurnText && owner && this.qqFinalRescueOwnerPending(owner)) {
          this.qqFinalRescueText.set(owner, reportTurnText);
        }
        // 中间正文轮同步：非汇总的汇报轮正文只是进度，转发给该会话所有在等
        // 最终答复的 QQ 任务。汇总轮（final=true）绝不在这里转发 —— 它的正文
        // 由 sendPrompt 收尾时的 deliverQqMainFinalAnswer 作为最终结果投递，
        // 两边同时发就是重复。
        if (!item.final && reportTurnText) {
          void this.deliverQqMainIntermediateText(owner, reportTurnText);
        }
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

  /**
   * 5 条宿主自动回合队列的**统一仲裁点**。
   *
   * 心跳 / 回合收尾 / 压制解除都只调它，不再各自按固定顺序 fire-and-forget 5
   * 个 drain：每一拍只仲裁**一条**队列并把轮转游标挪到下一位；被选中的队列
   * 仍沿用自己原有的顺序投递语义（一次可投完自己队列里当前可投的几条）。于是：
   *  - **明确优先级**：数组先后即投递先后（见 {@link SUPER_AUTO_TURN_PRIORITY}）；
   *  - **不饿死**：卡在 error / Stop / 主会话忙的高优先级队列只占一拍，下一拍
   *    轮到别人 —— 不再把「用户下次发消息」当成唯一恢复点；
   *  - **不破坏单回合不变量**：每个 drain 内部照旧同步申领 `superReportRunning`，
   *    `mainLane` 仍是「同一 ACP 会话同时只有一个回合」的唯一保证；这里只决定
   *    「先叫谁」，一条回合在飞时其余 drain 仍被重入锁挡在门外。
   *
   * 合并队列不带主会话归属、用独立的 `superMergeRunning` 锁，因此同样由它仲裁
   * （选中时让它的既有互斥门控生效），但不改变合并串行执行、主工作区单一窗口
   * 的纪律。
   */
  private async drainSuperAutoTurns(): Promise<void> {
    if (this.disposed || this.superReportRunning) return;
    const order = ChatPanel.SUPER_AUTO_TURN_PRIORITY;
    const owner = this.currentMainSessionId();
    for (let i = 0; i < order.length; i++) {
      if (this.disposed || this.superReportRunning) return;
      const slot = (this.superAutoTurnCursor + i) % order.length;
      const kind = order[slot]!;
      if (!this.superAutoTurnHasWork(kind, owner)) continue;
      // 给过机会就往后挪：卡住的队列（error / Stop 压住 / 主会话忙 / 合并
      // 互斥）下一拍不再排在最前，其余队列因此有稳定的唤醒机会。
      this.superAutoTurnCursor = (slot + 1) % order.length;
      switch (kind) {
        case "reports":
          await this.drainSuperReports();
          break;
        case "actionReceipts":
          await this.drainSuperActionReceipts();
          break;
        case "delegated":
          await this.drainDelegatedUserTurns();
          break;
        case "corrections":
          await this.drainSuperToolCallCorrections();
          break;
        case "merges":
          await this.drainSuperMerges();
          break;
      }
      return; // 一条队列一拍：其余队列交给下一拍 / 回合收尾的再次仲裁。
    }
  }

  /**
   * 某条自动回合队列此刻是否有「属于当前主会话」的待投递项。
   *
   * 只做轻量非空判断（真正的门控 —— mainSessionFree / error / Stop / 合并互斥
   * —— 仍留在各 drain 里，避免两处规则漂移）。合并队列不带主会话归属，只看
   * 非空。
   */
  private superAutoTurnHasWork(
    kind: (typeof ChatPanel.SUPER_AUTO_TURN_PRIORITY)[number],
    owner: string | null,
  ): boolean {
    switch (kind) {
      case "reports":
        return this.pendingSuperReportPrompts.some((item) => item.mainSessionId === owner);
      case "actionReceipts":
        return this.pendingSuperActionReceipts.some((item) => item.mainSessionId === owner);
      case "delegated":
        return this.pendingDelegatedUserTurns.some((item) => item.mainSessionId === owner);
      case "corrections":
        return this.pendingSuperToolCallCorrections.some((item) => item.mainSessionId === owner);
      case "merges":
        return this.pendingSuperMerges.length > 0;
    }
  }

  private superHeartbeatTick(): void {
    if (this.disposed) {
      this.stopSuperHeartbeat();
      return;
    }
    // 心跳是 fire-and-forget 的 interval 回调：任何一步同步抛错都必须吞掉，
    // 否则下面的 auto-stop 判断不执行，interval 会永久存活（且错误只在
    // console 里一闪而过）。drain 自身都有 catch，这里主要护住
    // refreshSuperWaitHeartbeat / syncSuperWaitingState 这类同步 UI 刷新。
    try {
      this.refreshSuperWaitHeartbeat();
      void this.drainSuperAutoTurns();
    } catch (error) {
      this.log.warn(`super agent heartbeat tick failed: ${errorMessage(error)}`);
    }
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
    // 排队的参数纠错提示也是一轮欠账：模型不知道自己的调用为何失败，就会
    // 在下一轮继续重复同一份错误载荷。
    if (this.pendingSuperToolCallCorrections.length > 0) return true;
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
      this.announceChildDone(vscode.l10n.t("超流体「{0}」已完成", title));
    } else if (session.status === "failed") {
      this.announceChildDone(vscode.l10n.t("超流体「{0}」已失败", title));
    } else {
      // 终态只剩 cancelled（isTerminalSuperStatus 已过滤）。
      this.announceChildDone(vscode.l10n.t("超流体「{0}」已中断", title));
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
            "已停止；{0} 个超流体仍在运行（其中 {1} 个等待你的回答），发送下一条消息后继续收取汇报",
            live.length,
            awaiting,
          )
        : vscode.l10n.t(
            "已停止；{0} 个超流体仍在运行，发送下一条消息后继续收取汇报",
            live.length,
          )
      : awaiting > 0
        ? vscode.l10n.t(
            "正在等待 {0} 个超流体汇报（其中 {1} 个等待你的回答），完成一个即汇报一个，会自动继续",
            live.length,
            awaiting,
          )
        : vscode.l10n.t(
            "正在等待 {0} 个超流体汇报（完成一个即汇报一个，会自动继续）",
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
        const outcome = await manager.cancel(msg.sessionId, "user");
        // 与 cancelAll / cleanup / retry 一致，单个中断也要有可见回执。
        // 按 SuperCancelOutcome 的真实 reason 区分文案：幂等重复（已终态）
        // 不是失败，但要如实告诉用户「无需中断」，避免以为刚才那下没生效。
        if (outcome.reason === "cancelled") {
          this.store.sendToast("info", vscode.l10n.t("已中断超流体"));
        } else if (outcome.reason === "already-terminal") {
          this.store.sendToast("info", vscode.l10n.t("这个超流体已经结束了，不用再中断"));
        } else {
          this.store.sendToast("warning", vscode.l10n.t("该超流体不存在或已被清理"));
        }
        break;
      }
      case "cancelAll": {
        const count = await manager.cancelAll("user");
        this.store.sendToast("info", vscode.l10n.t("已中断 {0} 个超流体", count));
        break;
      }
      case "respond": {
        if (!msg.sessionId) return;
        const ok = manager.respond(msg.sessionId, { answers: msg.answers });
        if (!ok) this.store.sendToast("warning", vscode.l10n.t("该超流体没有待处理的请求"));
        break;
      }
      case "cleanup": {
        if (!msg.sessionId) return;
        const result = await manager.cleanup(msg.sessionId, { keepBranch: msg.keepBranch });
        if (!result.ok) {
          // 拒绝清理（还在跑 / 工作目录有未提交改动）时目录其实还在磁盘上，
          // 谎报「已清理」会让用户以为工作已经被回收。
          this.store.sendToast(
            "warning",
            vscode.l10n.t("未能清理：{0}", result.reason ?? "未知原因"),
          );
        } else if (result.branchKept) {
          this.store.sendToast(
            "info",
            vscode.l10n.t("已清理工作目录，分支已保留：{0}", result.reason ?? ""),
          );
        } else {
          this.store.sendToast("info", vscode.l10n.t("已清理超流体"));
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
          this.store.sendToast("info", vscode.l10n.t("已重新派发超流体（沿用原工作目录）"));
        } else {
          this.store.sendToast("warning", vscode.l10n.t("该超流体当前无法重试"));
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
    // 待审核记录与通道是否启用无关：启动时先推一次，面板打开即可看到历史。
    void this.pushQqPendingUsers();
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
   * QQBot 通道启动的**并发闸门**。
   *
   * 两个调用方（配置事件路径的 `doStartQq`、扫码成功路径的 `onQqBotBound`）
   * 都可能同时到达；同步占位保证只有一份启动在跑，后来者复用它。发现通道
   * 已经在跑时直接返回（配置事件路径在 enable 落盘后重入）。
   */
  private startQqBotChannel(
    config: QqConfig,
    io: QqSettingsIo,
    generation: number,
  ): Promise<void> {
    if (this.qqChannelStarting) return this.qqChannelStarting;
    if (this.qq) return Promise.resolve();
    let task!: Promise<void>;
    task = this.doStartQqBotChannel(config, io, generation).finally(() => {
      if (this.qqChannelStarting === task) this.qqChannelStarting = null;
    });
    this.qqChannelStarting = task;
    return task;
  }

  /**
   * QQBot 官方通道的常规启动：不建 IPC、不 spawn bridge、不下载外部组件。
   *
   * 用 SecretStorage 里扫码写入的 appId/appSecret 建官方 adapter，入站事件
   * 经 `setEventCallback` 直接进 QqService，出站由 adapter.send 完成。没有
   * 凭据时如实提示先绑定，绝不退化成其它通道。
   */
  private async doStartQqBotChannel(
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
      // 服务里每一次任务状态变化（派发 / 运行 / 终态 / 回包）都要回写到看板
      // 投影：否则卡片永远停在「已校验 · 耗时 0 秒 · 停止」。
      onChanged: () => this.refreshQqTaskProjection(),
    });
    const deps = this.services.qqbotDeps ?? {};
    const dispatch = createQqChannelDispatch(config, {
      appId: creds.appId,
      appSecret: creds.appSecret,
      onInbound: (msg) => {
        const live = this.qq?.service;
        // F3：服务 start() 尚未完成时（connect→start 窗口）不接消息 —— 否则
        // 建出的任务会被紧随其后的「非终态标 failed(host_restarted)」误杀，
        // 甚至派出孤儿子会话。窗口很短，丢弃优于错处理，QQ 侧会重发。
        if (!live?.isReady()) return;
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
    // F3：现场在 connect 前发布（既有「配置事件不反杀半成品通道」的语义依赖
    // 这一点），但窗口期的入站消息由 QqService 的 ready 标志挡住 —— start()
    // 成功前 handleInboundMessage 一律丢弃，不会被「非终态标 failed」误杀、也
    // 不会派出孤儿子会话。
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

  /**
   * 扫码成功：凭据写 SecretStorage → **扫码者 openid 去重写入白名单**（以磁盘
   * 最新值为基准合并，另一个窗口新增的条目与备注不会被内存快照覆盖）→
   * 内存置 enabled → 停扫码 → 重建官方通道 → 首次绑定把 enabled 落盘 →
   * 推已连接回执。
   *
   * **顺序是刻意的**：`writeAll` 走 Workspace 作用域，会触发
   * `onDidChangeConfiguration` 的 QQ 监听；若先落盘再启动，监听会在
   * `this.qq` 还没赋值时并发发起一次启动，而首次绑定时白名单通常还是空的，
   * 那一次启动会被 `allowlist_empty` 拦下（现在降为 warning，但并发启动
   * 本身仍会制造两套现场）。先启动则监听看到的是同一份运行中的配置，
   * `shouldRestartOnPatch` 判定无需重启。
   */
  private async onQqBotBound(creds: Parameters<typeof storeQqBotCredentials>[1], config: QqConfig): Promise<void> {
    try {
      const io = this.qqIo();
      const wasEnabled = config.enabled === true;
      await storeQqBotCredentials(io, creds);
      // 扫码者自动入白名单（授权模型 2026-11-17）：官方接口只给 openid，
      // 扫码结果里的 `userOpenid` 就是扫码者本人。不写进去，扫码完仍然谁也
      // 派不了任务。写入刻意在启动通道之前——QqService 持有的就是这份
      // config 对象，通道一起来就能命中。落盘失败不静默：内存里照常放行
      // （本次可用），但如实说明重启后会丢。
      const openid = typeof creds.userOpenid === "string" ? creds.userOpenid.trim() : "";
      if (openid.length > 0) {
        // 与「放行待审核」（handleQqUserAction）同构：以**磁盘最新值**为基准
        // 合并，绝不用内存快照整体覆盖 —— `allowedUsers` 是整体替换语义，
        // 另一个 VSCode 窗口在磁盘上加过的用户（含备注）必须原样保住。
        // 本窗口内存里的条目一并并进去（它们可能来自尚未落盘的放行），但交给
        // `applyQqSettingsPatch` 的只有裸 openid：coerceAllowList 会保留磁盘上
        // 同名条目的 note，内存里从未有过备注意图，不能替用户清空它。
        let users: string[];
        try {
          const fresh = await readQqSettings(io);
          const seen = new Set<string>();
          const merged: string[] = [];
          for (const entry of fresh.allowedUsers) {
            if (seen.has(entry.openid)) continue;
            seen.add(entry.openid);
            merged.push(entry.openid);
          }
          for (const entry of config.allowedUsers) {
            const id = entry.trim();
            if (id.length === 0 || seen.has(id)) continue;
            seen.add(id);
            merged.push(id);
          }
          if (!seen.has(openid)) merged.push(openid);
          users = merged;
        } catch (error) {
          // 读盘失败时**不能**改回「凭内存覆盖磁盘」的旧行为（那正是丢数据的
          // 路径），只在内存态上追加扫码者并如实记录。
          this.log.warn(`QQ 白名单读取失败，仅更新内存白名单：${errorMessage(error)}`);
          users = config.allowedUsers.includes(openid)
            ? config.allowedUsers
            : [...config.allowedUsers, openid];
        }
        config.allowedUsers = users;
        try {
          await applyQqSettingsPatch(io, { allowedUsers: users });
        } catch (error) {
          this.log.warn(`QQ 白名单写入失败：${errorMessage(error)}`);
          this.store.sendToast(
            "warning",
            vscode.l10n.t("扫码者未能写入白名单（重启后会丢失）：{0}", errorMessage(error)),
          );
        }
      } else {
        // 没有 openid 就无法自动授权：如实记日志，绝不假装已授权。
        this.log.warn("扫码结果没有 userOpenid，未自动加入白名单");
      }
      // 内存里先置启用：QqService 读的就是这个对象（私聊自由文本任务要求
      // enabled），落盘刻意放在启动之后。
      config.enabled = true;
      // 新凭据建立的新通道拥有完整的失败预算。
      this.qqHealthRestarts = 0;
      this.stopQqBotBinding();
      // 成功即清掉 webview 里的二维码旧帧。`qqLoginQr` 是独立于快照的通道，
      // 宿主不覆盖的话，上一帧 waiting_scan 会连同倒计时一直挂着（用户实测：
      // 底部已显示「已连接 QQBot 官方网关」，中间仍是大二维码 +「剩余 40s」）。
      // 空 dataUrl 过不了 isQrDataUrl，因此 webview 侧也不会把它送进 <img>。
      this.postToWebview(buildConfirmedQrMessage());
      if (this.qq) await this.stopQq();
      await this.startQqBotChannel(config, io, this.qqGeneration);
      if (!wasEnabled) {
        // 首次绑定自动开启远程任务。写失败不能谎报成功：通道已经连上，
        // 只是开关没落盘，明确让用户手动打开。
        try {
          await applyQqSettingsPatch(io, { enabled: true });
        } catch (error) {
          this.log.warn(`QQ 设置写入失败：${errorMessage(error)}`);
          this.store.sendToast(
            "warning",
            vscode.l10n.t("已连接，但无法自动开启远程任务，请手动打开开关"),
          );
        }
      }
      this.postManagedStatus({ phase: "logged_in", message: "QQBot 绑定成功，官方网关已连接" });
      // 连接状态显式再推一次：startQqBotChannel 成功路径已推过，这里保证即便
      // 该路径因代际变化提前返回、只要本面板仍持有通道，webview 也拿到已连接。
      if (this.qq) this.pushQqStatus(true, "QQBot 官方网关已连接");
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
    const generation = ++this.qqGeneration;
    // F6：停通道 = 立刻放手主会话注入。只 abort 服务信号不够 —— 已经开始的
    // ACP 回合不会被它打断，会继续流式跑完且 QQ 早已停止、收不到结果。这里
    // 对「当前真正跑在主会话上的那一轮」发 session/cancel，并撤掉所有等待者。
    this.cancelAllQqMainInjections();
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
      // 拆旧 owner 是异步的（socket 关闭 + 服务停止），期间可能有一条新通道
      // 已经装回 this.qq，或又有一次 stop 把 generation 推进。那一刻再清空
      // 看板/推「已停止」，就会把**新通道**的看板抹掉。
      if (
        this.disposed ||
        generation !== this.qqGeneration ||
        this.qq !== undefined
      ) {
        return;
      }
      // 显式停用：清空看板投影并推一次（不留幽灵条目）。被动刷新
      // （refreshQqTaskProjection 的 onChanged 竞态）不经过这里、也不会清空。
      setQqTasks(this.store.getState(), []);
      this.store.pushSnapshot();
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

  /**
   * 面板重新可见时的一次静默健康检查。
   *
   * `op=9 invalid session` 之后 adapter 只是丢掉了会话，socket 可能仍显示
   * connected 且永远不会再收到事件 —— 只看 `connected` 会一直「正常」。
   * 这里按 health.detail 判定失活，并触发一次有限重启。
   */
  private async checkQqChannelHealth(): Promise<void> {
    if (this.disposed) return;
    const adapter = this.qq?.qqbot?.adapter;
    if (!adapter) return;
    let health: { connected: boolean; detail?: string };
    try {
      health = await adapter.health();
    } catch (error) {
      this.log.warn(`QQ 通道健康检查失败：${errorMessage(error)}`);
      return;
    }
    if (this.disposed || this.qq?.qqbot?.adapter !== adapter) return;
    if (isQqHealthHealthy(health)) {
      this.qqHealthRestarts = 0;
      return;
    }
    const detail =
      typeof health.detail === "string" && health.detail.trim().length > 0
        ? health.detail.trim()
        : "unknown";
    this.pushQqStatus(false, detail);
    await this.recoverQqChannel(detail);
  }

  /**
   * 失活后的恢复：**有限次**自动重启（{@link QQ_HEALTH_RESTART_LIMIT}），
   * 用尽后如实要求重新扫码，绝不无限重启。
   *
   * 返回是否恢复出一条活着的通道。
   */
  private async recoverQqChannel(detail: string): Promise<boolean> {
    if (this.disposed) return false;
    // 正在绑定 / 启动 / 停止：这些路径自己会收尾，别抢。
    if (this.qqbotBinding || this.qqChannelStarting || this.qqStopping) return false;
    if (this.qqHealthRestarts >= QQ_HEALTH_RESTART_LIMIT) {
      this.store.sendToast(
        "warning",
        vscode.l10n.t("QQ 通道已失活且自动重启次数已用尽，请重新扫码绑定"),
      );
      this.pushQqStatus(false, "QQ 通道已失活，请重新扫码绑定");
      return false;
    }
    this.qqHealthRestarts += 1;
    this.log.warn(
      `QQ 通道健康检查失活（${detail}），尝试自动重启（${this.qqHealthRestarts}/${QQ_HEALTH_RESTART_LIMIT}）`,
    );
    try {
      await this.restartQq();
    } catch (error) {
      this.log.warn(`QQ 通道自动重启失败：${errorMessage(error)}`);
    }
    const alive = !this.disposed && this.qq !== undefined;
    if (alive) {
      this.store.sendToast(
        "info",
        vscode.l10n.t("QQ 通道已失活，已自动重启一次；若仍无法收发消息，请重新扫码绑定"),
      );
      this.pushQqStatus(true, "QQ 通道已重启");
    } else {
      this.store.sendToast(
        "warning",
        vscode.l10n.t("QQ 通道已失活且无法自动恢复，请重新扫码绑定"),
      );
      this.pushQqStatus(false, "QQ 通道已失活，请重新扫码绑定");
    }
    return alive;
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
        if (!manager) throw new Error("超流不可用（未打开工作区）");
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
        // 没有 branch / path —— 缺省即可，最终结果由 readSuper 里的快照补齐。
        const isolation = session.isolation;
        const branch = isolation.branch;
        const worktreePath =
          isolation.kind === "git_worktree" && isolation.path ? isolation.path : undefined;
        return {
          superSessionId: session.id,
          ...(branch ? { branch } : {}),
          ...(worktreePath ? { worktreePath } : {}),
        };
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
            throw new Error(`QQ 任务指向的超流体不存在：${superSessionId}`);
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
        if (!manager) throw new Error("超流不可用（未打开工作区）");
        // 对已终态的子会话再取消是幂等重复，管理器自己会如实返回。
        await manager.cancel(superSessionId, "agent");
      },

      /**
       * 合并回当前分支。
       *
       * 合并由**专用合并子会话**在主仓工作区里执行（冲突需要有人读代码），
       * 因此这是一个异步动作：派发成功也只回报「已派出」，合并结果稍后写进
       * 看板的 integration。**绝不**在这里谎报 ok=true；`requestSuperMerge`
       * 没派出子会话时必须把真实原因回给 QQ（排队 / 主会话忙 / 已有合并在跑）。
       */
      merge: async (superSessionId) => {
        const manager = this.getSuperAgent();
        if (!manager) return { ok: false, detail: "超流不可用（未打开工作区）" };
        const session = manager.get(superSessionId);
        if (!session) return { ok: false, detail: "超流体不存在或已被清理" };
        if (session.integration?.state === "merged") {
          return { ok: true, detail: "改动已经在当前分支上" };
        }
        if (!isQqTerminalSuperStatus(session.status)) {
          return { ok: false, detail: "超流体还没结束，完成后再合并" };
        }
        if (session.isolation.kind !== "git_worktree" || !session.isolation.branch) {
          return { ok: false, detail: "该超流体没有可合并的分支（仅目录隔离）" };
        }
        const outcome = await this.requestSuperMerge(superSessionId);
        if (outcome.dispatched) {
          return {
            ok: false,
            detail: "已派出合并超流体（异步执行），合并结果稍后在看板确认",
          };
        }
        if (outcome.queued) {
          return { ok: false, detail: `合并请求已排队，空闲后自动派发：${outcome.reason}` };
        }
        return { ok: false, detail: outcome.reason };
      },

      discard: async (superSessionId) => {
        const manager = this.getSuperAgent();
        if (!manager) throw new Error("超流不可用（未打开工作区）");
        // 如实回传 cleanup 的观测：分支还带未合并提交时 git 会保下分支
        // （只删工作目录），QQ 回执与看板都要把这件事说清楚。
        const result = await manager.cleanup(superSessionId, { keepBranch: false });
        return {
          ok: result.ok,
          ...(result.branchKept === true ? { branchKept: true } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
        };
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
        // worktree 路径同样只在「真的还有目录」时给：released / recycled 表示
        // 目录已经被清理，回传一个磁盘上不存在的路径只会误导合并/丢弃兜底。
        const isolation = session.isolation;
        if (
          isolation.kind === "git_worktree" &&
          isolation.path &&
          isolation.released !== true &&
          isolation.recycled !== true
        ) {
          snapshot.worktreePath = isolation.path;
        }
        if (session.integration) snapshot.merged = session.integration.state === "merged";
        return snapshot;
      },

      injectIntoMain: (input) => this.injectQqMainTurn(input),
      cancelMainInjection: (taskId) => this.cancelQqMainInjection(taskId),

      /**
       * 把 QQ 用户的回答送回远程子会话。`SuperAgentManager.respond` 会命中该
       * 子会话挂起的 `_iflow/user/questions` 并让 agent 继续；已超时 / 已回答
       * 时返回 false，服务侧据此如实回执。
       */
      answerRemoteQuestion: (superSessionId, answers) => {
        const manager = this.getSuperAgent();
        return manager ? manager.respond(superSessionId, { answers }) : false;
      },

      /**
       * main 渠道任务的回答回灌：按 taskId 命中本注入回合的提问卡。超时 / 停止
       * 时服务送来空答案（按未回答继续），语义与本地提问卡一致。
       */
      answerMainQuestion: (taskId, answers) => this.answerQqMainQuestion(taskId, answers),

      notify: (text) => {
        if (this.disposed) return;
        this.store.sendToast("info", text);
      },

      deliver: async (msg) => {
        const adapter = this.qq?.qqbot?.adapter;
        if (!adapter) return { ok: false }; // 入口防御：通道未起 / 未绑定
        return deliverViaQqBotAdapter(adapter, msg);
      },

      onPendingUser: (info) =>
        this.handleQqPendingUser(info).catch((error: unknown) => {
          this.log.warn(`QQ 待审核记录写入失败：${errorMessage(error)}`);
          // 写失败 = 未记入：如实回报 dropped，服务侧不得虚称「已记入」。
          return { dropped: true };
        }),
      unbindAccount: () => this.unbindQqAccount(),
    };
  }

  // --- QQ 主会话渠道（QQ 消息固定去向）---------------------------------------

  /**
   * 把一条 QQ 消息注入主会话，等那一轮结束，返回该轮 assistant 正文。
   *
   * 四条硬纪律：
   *  1. **remotePolicy 闸门**：与 child 渠道走同一个 `qqSpawnPolicyFor` 判定，
   *     readonly 策略下主会话渠道（无法保证只读）一律拒绝注入；
   *  2. **等空闲再投**：`mainSessionFree()` 是 sendPrompt 自己那道门的镜像
   *     （status / initializing / replaying / historySync / mainLane），所以
   *     不会与本地回合或宿主回合并发跑在同一 ACP 会话上；
   *  3. **转录可区分**：正常 user 气泡（`hidden:false`）+ `origin:"qq"` 徽标；
   *     模型看到的是带来源包裹的正文（服务生成），本机用户看到的是原文；
   *  4. **轮次锚定**：记下回合开始时的 sessionId 与末尾可见 text 块的稳定 id，
   *     结束时 sessionId 必须一致、锚块必须仍在，只取锚块之后的 assistant 文本
   *     —— 上一轮、后续轮次与「会话被替换后的无关文本」都不会被回给 QQ。
   *
   * 忙（撞上本地回合刚抢到车道）时不会失败：短暂等待后重试，直到超时上限。
   * 排队等空闲期间被 `/qq stop` 打断就返回 canceled，由服务侧收尾。
   */
  private async injectQqMainTurn(input: QqMainInjectInput): Promise<QqMainInjectResult> {
    // 远程接续断开门：只有「已断开远程接管」的会话才拒绝 QQ 注入。接管期间
    // （start）QQ 消息照常进入会话、agent 继续执行；门是会话级的，机器人仍
    // 可把其它会话的任务注入它们自己的主会话。
    if (this.isQqRemoteDetachedFor(this.store.getState().sessionId)) {
      return {
        injected: false,
        reason: "当前会话已断开远程接续，QQ 消息不再注入本地。",
      };
    }
    const taskId = input.task.taskId;
    // F1：main 渠道跑在用户自己的主会话里，不能像 child 那样剔除写工具。
    // 与 child 走同源策略判定：readonly（deny）一律拒绝，绝不注入。
    if (qqSpawnPolicyFor(input.task.policy.remotePolicy).approval === "deny") {
      return {
        injected: false,
        reason: "当前远程策略为只读，主会话渠道无法保证只读约束，任务未注入。请改用 child 渠道或调整远程策略。",
      };
    }
    const controller = new AbortController();
    const onServiceAbort = (): void => controller.abort();
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener("abort", onServiceAbort, { once: true });
    this.qqInjectAborts.set(taskId, controller);

    const deadline = Date.now() + Math.max(0, input.timeoutMs);
    // 本轮是否真的把任务派给了子会话：finally 也要据此决定是否撤销预登记的
    // 等最终答复记账，因此必须在 try 之外声明。
    let delegated = false;
    try {
      // 阶段一：等主会话空闲（被取消 / 超时都如实返回，绝不硬塞）。
      const free = await this.waitForQqMainFree(controller.signal, deadline);
      if (free !== "free") {
        return free === "canceled"
          ? { injected: false, canceled: true }
          : {
              injected: false,
              reason: "主会话长时间未空闲，消息未注入（可在主会话空闲后重发）。",
            };
      }

      // 阶段二：发一轮。撞上忙窗口（本地回合先抢到车道）不算失败，等一拍
      // 再来；一旦这一轮真的开始（started），后续只收本轮文本、不再重试。
      while (true) {
        if (this.disposed || controller.signal.aborted) {
          return { injected: false, canceled: true };
        }
        // 等空闲期间会话被断开远程接管（用户关闭接续）：不再把这条 QQ 消息
        // 投进本地。接管中（start）不拦，QQ 照常驱动 agent 继续干活。
        if (this.isQqRemoteDetachedFor(this.store.getState().sessionId)) {
          return {
            injected: false,
            reason: "当前会话已断开远程接续，QQ 消息不再注入本地。",
          };
        }
        if (Date.now() > deadline) {
          return {
            injected: false,
            reason: "主会话长时间未空闲，消息未注入（可在主会话空闲后重发）。",
          };
        }

        // 轮次锚点：sessionId + 「基线末尾那一个可见 text 块的稳定 id」。
        // 基线口径与取结果口径一致（都排除 system 块），避免数量错位；块 id
        // 让「会话被替换后同样数量的文本」也能被识别成串包而非本轮结果。
        const before = this.store.getState();
        const sessionIdBefore = before.sessionId;
        const visibleTextBefore = before.blocks.filter(
          (block) => block.kind === "text" && !block.system,
        );
        const textCountBefore = visibleTextBefore.length;
        const anchorBlock = visibleTextBefore[visibleTextBefore.length - 1];
        const anchorId = anchorBlock?.id;
        const anchorLen = anchorBlock?.kind === "text" ? anchorBlock.text.length : 0;

        let started = false;
        // 子会话基线：这一轮开始时该主会话已有的子会话 id。轮末若出现新 id，
        // 说明主 Agent 把任务派了出去 —— 本轮文本只是「已安排」的占位，真正
        // 答复要等子会话汇报汇总轮（见 delegated / qqMainFinalAwaiters）。
        let superIdsBefore: ReadonlySet<string> = new Set();
        await this.sendPrompt(input.text, undefined, undefined, undefined, {
          // 宿主驱动回合：不改会话标题、不拍 checkpoint（QQ 正文不写进
          // 会话标签/工作区快照）；但**不 hidden** —— 转录里要有用户气泡。
          internal: true,
          delegateOnBusy: false,
          quietBusy: true,
          origin: "qq",
          displayText: input.displayText,
          onTurnStarted: async () => {
            started = true;
            this.qqInjectedTaskId = taskId;
            // 先登记再发：汇报轮可能在注入轮收尾的同一拍就被仲裁投递，记账
            // 必须在这之前存在。轮末若确认没派生子会话会撤销（见 finally）。
            if (sessionIdBefore) {
              this.qqMainFinalAwaiters.set(taskId, sessionIdBefore);
              this.qqMainFinalAwaiterSince.set(taskId, Date.now());
              // 新一轮开始：清掉上一轮遗留的补发缓存，避免迟到补发误用旧结论。
              this.qqFinalRescueText.delete(sessionIdBefore);
              this.qqReportFallbackText.delete(sessionIdBefore);
              this.qqFinalRescueDefers.delete(taskId);
              this.qqTaskFinalText.delete(taskId);
              this.ensureQqFinalRescueTimer();
            }
            superIdsBefore = new Set(
              (this.getSuperAgent()?.list() ?? [])
                .filter((s) => (s.mainSessionId ?? sessionIdBefore) === sessionIdBefore)
                .map((s) => s.id),
            );
            await input.onInjected();
          },
        });

        if (!started) {
          // 车道被别的回合抢走（本地回合优先）：等下一拍重试。
          await this.waitForMainFreeTick(controller.signal, deadline);
        } else {
          // 这一轮真的跑过：无论成败，结果都属于它。
          const state = this.store.getState();
          // F5：会话在回合中被替换（切会话 / 新会话 / 恢复）时基线来自旧会话，
          // 结果读自新会话 —— 绝不把无关文本当成本轮结果回给 QQ。
          if (state.sessionId !== sessionIdBefore) {
            return {
              injected: true,
              text: "",
              failed: true,
              reason: "会话在本轮执行期间被切换，未能取回本轮结果。",
            };
          }
          const { text: resultText, anchorLost } = this.extractQqTurnTextFromAnchor(
            anchorId,
            anchorLen,
            textCountBefore,
          );
          if (anchorLost) {
            // 基线锚块消失（转录被清空/重排）：同样不能安全地按数量切片。
            return {
              injected: true,
              text: "",
              failed: true,
              reason: "本轮转录基线已失效，未能取回本轮结果。",
            };
          }
          const text = resultText;
          const failed = state.status === "error";
          // 本轮是否派生了子会话（相对轮初基线出现新 id）。派生了就把本任务
          // 登记为「等最终答复」：这一轮文本只是占位，真正的答复将在子会话
          // 汇报汇总轮结束时经 completeMainFinalAnswer 回传 QQ。
          if (!failed && sessionIdBefore) {
            // R3：子会话的登记（onSessionsChanged → list()）可能与回合收尾差错一拍，
            // 立刻判定会把「已派子会话」误判成直答、在 finally 里提前摘掉 awaiter。
            // 留一个很短的宽限期再核对一次（不阻塞主机、只延迟本轮结果一小段）。
            if (this.qqDelegationGraceMs > 0 && !controller.signal.aborted) {
              await new Promise<void>((resolve) =>
                setTimeout(resolve, this.qqDelegationGraceMs),
              );
            }
            delegated = (this.getSuperAgent()?.list() ?? []).some(
              (s) =>
                (s.mainSessionId ?? sessionIdBefore) === sessionIdBefore &&
                !superIdsBefore.has(s.id),
            );
            this.log.info(
              `QQ 注入轮 delegated 判定：task=${taskId} delegated=${delegated} baseline=${superIdsBefore.size} current=${this.getSuperAgent()?.list().length ?? 0}`,
            );
          }
          // 中间正文轮同步：派生子会话的注入轮，其 assistant 正文只是「已安排」
          // 的占位说明，永远不会被当成最终结果（真正答复在汇报汇总轮经
          // completeMainFinalAnswer 回传）。这里把这段正文作为进度文本转发一次，
          // 让 QQ 发起者看到主会话真实说了什么。直答轮（未派生）不转发 —— 那段
          // 正文马上由 finalizeMainTask 作为最终结果投递，再转一次就是重复。
          if (delegated && !failed) {
            void this.deliverQqMainIntermediateText(sessionIdBefore, text, [taskId]);
          }
          return {
            injected: true,
            text,
            ...(state.stopReason ? { stopReason: state.stopReason } : {}),
            ...(delegated ? { delegated: true } : {}),
            ...(failed
              ? { failed: true, reason: state.errorMessage ?? "主会话本轮执行失败。" }
              : {}),
          };
        }
      }
    } finally {
      // 只有确认派生了子会话才保留记账等最终答复；其余（未派生 / 失败 /
      // 会话切换 / 取消 / 注入未成功）一律撤销，避免迟到的汇报回错任务。
      if (!delegated) {
        this.qqMainFinalAwaiters.delete(taskId);
        this.qqMainFinalAwaiterSince.delete(taskId);
        this.qqFinalRescueDefers.delete(taskId);
        this.qqTaskFinalText.delete(taskId);
      }
      if (this.qqMainFinalAwaiters.size === 0) this.stopQqFinalRescueTimer();
      this.qqInjectAborts.delete(taskId);
      if (this.qqInjectedTaskId === taskId) this.qqInjectedTaskId = null;
      input.signal.removeEventListener("abort", onServiceAbort);
    }
  }

  /**
   * 子会话汇报**汇总轮**（pendingCount=0）结束时，把结论回传给对应的 QQ 任务。
   *
   * 按 task 归属投递：同一主会话可叠加多条 QQ 消息、各自派生子会话，绝不能把
   * 一轮汇总结论广播给该会话所有 awaiter（那正是「摘要相同、taskId 不同」的
   * 重复卡根因）。每个任务取自己派生子会话的汇报正文（qqTaskFinalText），取
   * 不到且会话里还有别的 awaiter 时走如实兜底、绝不共享别人的结论；单任务
   * 或 R2 精确补发（onlyTaskIds）时沿用本轮文本 / `fallbackText` / 空文本兜底。
   * 无论哪条路径都摘除记账，不让 QQ 停在「已受理」（R1）。单次投递 / 幂等由
   * 服务的 resultDeliveredAt 保证；补发与汇总轮命中同一 task 时靠「删 awaiter
   * + resultDeliveredAt」双保险避免各投一次。
   */
  private async deliverQqMainFinalAnswer(
    sessionId: string | null,
    rawText: string,
    stopReason: string,
    onlyTaskIds?: ReadonlySet<string>,
    fallbackText?: string,
  ): Promise<void> {
    if (this.disposed || !sessionId) return;
    const honestFallback = vscode.l10n.t(
      "超流体任务已完成，但未产生可转发的正文摘要。",
    );
    // R1：汇总轮可能只调了合并/复核动作而没有 assistant 正文。旧实现在这里
    // 静默 return 且不摘记账 —— QQ 永远停在「已受理」。改为如实兜底：摘除记账
    // 并回传一条明确文案（走 completeMainFinalAnswer 的 forceActive 主动消息，
    // 长任务下也真能发出），绝不伪造「已完成」之类内容。
    //
    // 2026-11-19：二次转述确为空时优先用宿主已持有的子会话汇报正文
    // （report.summary），让用户看到子会话实际做了什么；只有连汇报正文也为空
    // 才退回占位文案。清洗后文本必为非空，服务侧不会再追加一条占位通知。
    const cleanFallback = sanitizeQqReportFallback(fallbackText);
    const sessionTaskIds = [...this.qqMainFinalAwaiters.entries()]
      .filter(([, owner]) => owner === sessionId)
      .map(([taskId]) => taskId);
    const taskIds = sessionTaskIds.filter((taskId) =>
      onlyTaskIds ? onlyTaskIds.has(taskId) : true,
    );
    // 多任务叠加时禁止广播：只有「单任务（无歧义）」或「R2 精确补发」才可沿用
    // 本轮共享结论；其余每个 awaiter 只取自己那份归属正文，取不到就如实兜底，
    // 绝不把别人的汇总结论投给它（重复卡根因）。
    const shareable = onlyTaskIds !== undefined || sessionTaskIds.length <= 1;
    for (const taskId of taskIds) {
      const own = this.qqTaskFinalText.get(taskId)?.trim() ?? "";
      // 单任务：主 Agent 汇总正文 > 归属正文 > 汇报正文兜底 > 如实占位。
      // 多任务：只用自己那份归属正文，缺则如实占位（不共享汇总/兜底正文）。
      const answer = shareable
        ? rawText.trim() || own || cleanFallback || honestFallback
        : own || honestFallback;
      this.qqMainFinalAwaiters.delete(taskId);
      this.qqMainFinalAwaiterSince.delete(taskId);
      this.qqFinalRescueDefers.delete(taskId);
      this.qqTaskFinalText.delete(taskId);
      try {
        await this.qq?.service.completeMainFinalAnswer({ taskId, text: answer, stopReason });
      } catch (error) {
        this.log.warn(`QQ 主会话最终答复回传失败：${errorMessage(error)}`);
      }
    }
    // 该会话已无 awaiter：清掉补发缓存，避免下一条任务误用上一轮的旧结论。
    if (![...this.qqMainFinalAwaiters.values()].includes(sessionId)) {
      this.qqFinalRescueText.delete(sessionId);
      this.qqReportFallbackText.delete(sessionId);
    }
    if (this.qqMainFinalAwaiters.size === 0) this.stopQqFinalRescueTimer();
  }

  /** 该归属会话是否还有 QQ awaiter（决定是否值得缓存汇报正文供补发）。 */
  private qqFinalRescueOwnerPending(owner: string): boolean {
    return [...this.qqMainFinalAwaiters.values()].includes(owner);
  }

  /** 该归属会话是否存在已等过软阈值的 QQ awaiter（R2 汇报轮 final 放宽的依据）。 */
  private qqFinalRescueDue(owner: string | null): boolean {
    if (!owner) return false;
    const now = Date.now();
    for (const [taskId, taskOwner] of this.qqMainFinalAwaiters.entries()) {
      if (taskOwner !== owner) continue;
      const since = this.qqMainFinalAwaiterSince.get(taskId) ?? now;
      if (now - since >= this.qqFinalRescueMs) return true;
    }
    return false;
  }

  /** 迟到补发定时器：仅在有 awaiter 时存活，避免无谓唤醒宿主。 */
  private ensureQqFinalRescueTimer(): void {
    if (this.disposed || this.qqFinalRescueTimer) return;
    const timer = setInterval(() => this.rescueStaleQqFinalAwaiters(), QQ_FINAL_RESCUE_POLL_MS);
    if (typeof timer.unref === "function") timer.unref();
    this.qqFinalRescueTimer = timer;
  }

  private stopQqFinalRescueTimer(): void {
    if (this.qqFinalRescueTimer) {
      clearInterval(this.qqFinalRescueTimer);
      this.qqFinalRescueTimer = null;
    }
  }

  /**
   * R2 迟到补发：等最终答复的 awaiter 若等得太久，强制以「最近一次汇报文本（或兜底）」
   * 收尾，避免 QQ 永久停在「已受理」。
   *  - 软阈值：已超 qqFinalRescueMs 且本会话已无活跃子会话（正常长任务的收尾窗口）；
   *  - 硬上限：已超 qqFinalHardRescueMs，即便还有子会话卡在非终态也补发
   *    （复核子会话卡在等输入时不能让发起者永远等下去）。
   * 只补发到点的那一个 taskId（onlyTaskIds 过滤），不误伤同会话刚开始的其它 awaiter。
   *
   * 2026-11-19 补发抢跑修复：到点时若本会话的汇报轮正在投递（`superReportRunning`）
   * 或还排在队列里，先让出有限拍数，让 finalReport 收尾投递真实最终正文；抢在它
   * 前面补发会把兜底文案写死、并让随后迟到的真实正文被丢弃。让路有上限（见
   * `QQ_FINAL_RESCUE_MAX_DEFERS`），真正卡死时仍强制补发，绝不永久推迟。
   */
  private rescueStaleQqFinalAwaiters(): void {
    if (this.disposed || this.qqMainFinalAwaiters.size === 0) return;
    const now = Date.now();
    const live = this.getSuperAgent()?.list() ?? [];
    for (const [taskId, owner] of [...this.qqMainFinalAwaiters.entries()]) {
      const since = this.qqMainFinalAwaiterSince.get(taskId) ?? now;
      const age = now - since;
      const activeChildren = live.filter(
        (s) => (s.mainSessionId ?? owner) === owner && !isTerminalSuperStatus(s.status),
      ).length;
      const due =
        age >= this.qqFinalHardRescueMs ||
        (age >= this.qqFinalRescueMs && activeChildren === 0);
      if (!due) continue;
      // 汇报轮在途 / 排队时先让路：真实最终汇报马上就会由 finalReport 收尾投递。
      const reportInFlight =
        this.superReportRunning ||
        this.pendingSuperReportPrompts.some((item) => item.mainSessionId === owner);
      if (reportInFlight) {
        const defers = (this.qqFinalRescueDefers.get(taskId) ?? 0) + 1;
        if (defers <= QQ_FINAL_RESCUE_MAX_DEFERS) {
          this.qqFinalRescueDefers.set(taskId, defers);
          continue;
        }
        this.log.warn(
          `QQ 主会话最终答复补发：task=${taskId} 已让出 ${defers - 1} 拍，汇报轮仍未收尾，强制补发`,
        );
      }
      this.qqFinalRescueDefers.delete(taskId);
      this.log.warn(
        `QQ 主会话最终答复迟到补发：task=${taskId} waited=${age}ms activeChildren=${activeChildren}`,
      );
      void this.deliverQqMainFinalAnswer(
        owner,
        this.qqFinalRescueText.get(owner) ?? "",
        "end_turn",
        new Set([taskId]),
        this.qqReportFallbackText.get(owner),
      );
    }
    if (this.qqMainFinalAwaiters.size === 0) this.stopQqFinalRescueTimer();
  }

  /**
   * 从「回合开始时末尾可见 text 块」（锚点）提取本轮新增的 assistant 正文。
   *
   * 流式 `appendTextToLast` 会把新 chunk 就地拼进最后一个 text 块并复用它的 id。
   * hidden 汇报回合没有 user 块做边界，新正文必然被并进锚块；只按 id
   * `slice(anchorIndex + 1)` 会整段丢掉，转发出空摘要（2026-11-19 回归）。因此
   * 锚点除 id 外必须记录回合开始时的块内文本长度：先取锚块 `slice(旧长度)`，
   * 再接锚块之后的新 text 块。system 状态行由 reducer 的合并边界挡开，不会混入。
   *
   * `anchorLost` 供调用方区分「本轮确实没有正文」（text=""）与「转录被清空/重排，
   * 按 id 切片不安全」（anchorLost=true）。此时返回的 text 是按 `fallbackCount`
   * （回合开始时的可见块数）切片的结果；配合汇报正文兜底（finalFallbackText）
   * 仍能给出真实结论，绝不再静默放弃（2026-11-19 补发抢跑 bug）。
   */
  private extractQqTurnTextFromAnchor(
    anchorId: string | undefined,
    anchorLen: number,
    fallbackCount: number,
  ): { text: string; anchorLost: boolean } {
    const visible = this.store.getState().blocks.filter(
      (block) => block.kind === "text" && !block.system,
    );
    const countText = (): string =>
      visible
        .slice(fallbackCount)
        .map((block) => (block.kind === "text" ? block.text : ""))
        .join("\n")
        .trim();
    if (anchorId === undefined) return { text: countText(), anchorLost: false };
    const anchorIndex = visible.findIndex((block) => block.id === anchorId);
    if (anchorIndex < 0) return { text: countText(), anchorLost: true };
    const parts: string[] = [];
    const anchor = visible[anchorIndex]!;
    if (anchor.kind === "text") parts.push(anchor.text.slice(anchorLen));
    for (const block of visible.slice(anchorIndex + 1)) {
      if (block.kind === "text") parts.push(block.text);
    }
    return { text: parts.join("\n").trim(), anchorLost: false };
  }

  /** 汇报回合收尾后提取「本轮新增」的 assistant 文本，供迟到补发复用。 */
  private captureQqReportTurnText(
    anchorId: string | undefined,
    beforeCount: number,
    anchorLen = 0,
  ): string {
    return this.extractQqTurnTextFromAnchor(anchorId, anchorLen, beforeCount).text;
  }

  /**
   * 把主会话某一轮的 assistant 正文经 QQ 进度通道转发一次。
   *
   * 只投给该归属会话里仍在等最终答复的 QQ 任务 —— `qqMainFinalAwaiters` 就是
   * 权威记账，任务取消 / 通道停止 / 会话切换 / dispose 都会清它，天然不串台；
   * 服务侧再以 status=injected + 独立分支节流 / 指纹去重 + 终态短路作二次防线。
   * 最终汇报轮的正文不走这里（由 {@link deliverQqMainFinalAnswer} 投递），
   * 因此同一段正文绝不会被当成中间正文再发一次。
   */
  private async deliverQqMainIntermediateText(
    owner: string | null,
    text: string,
    taskIds?: readonly string[],
  ): Promise<void> {
    if (this.disposed || !owner || !text.trim()) return;
    const service = this.qq?.service;
    // 部分测试夹具只提供最终答复通道：没有中间正文通道就安静跳过，不误伤。
    if (!service || typeof service.deliverMainTurnText !== "function") return;
    const targets =
      taskIds ??
      [...this.qqMainFinalAwaiters.entries()]
        .filter(([, sessionId]) => sessionId === owner)
        .map(([taskId]) => taskId);
    for (const taskId of targets) {
      try {
        await service.deliverMainTurnText(taskId, text);
      } catch (error) {
        this.log.warn(`QQ 主会话中间正文回传失败：${errorMessage(error)}`);
      }
    }
  }

  /** 等主会话进入可注入状态。
   *
   * 判定口径与 `sendPrompt` 自己的门一致（`mainSessionFree`：会话就绪、非
   * streaming / initializing / replaying / historySync、且主会话车道空闲）。
   * 被取消或超过 deadline 就返回对应状态，由调用方如实收尾。
   */
  private async waitForQqMainFree(
    signal: AbortSignal,
    deadline: number,
  ): Promise<"free" | "canceled" | "timeout"> {
    while (true) {
      if (this.disposed || signal.aborted) return "canceled";
      if (this.mainSessionFree()) return "free";
      if (Date.now() > deadline) return "timeout";
      await this.waitForMainFreeTick(signal, deadline);
    }
  }

  /** 等一拍再看主会话是否空闲；取消/销毁/超时立刻返回。 */
  private async waitForMainFreeTick(signal: AbortSignal, deadline: number): Promise<void> {
    const remain = deadline - Date.now();
    if (remain <= 0) return;
    const ms = Math.min(QQ_MAIN_IDLE_POLL_MS, remain);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, ms);
      const onAbort = (): void => finish();
      function finish(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      }
      if (signal.aborted) {
        finish();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      timer.unref?.();
    });
  }

  /** 会话是否已断开远程接续（关闭接管后）：命中即拦截 QQ 注入。 */
  private isQqRemoteDetachedFor(sessionId: string | null): boolean {
    return sessionId !== null && this.qqRemoteDetachedSessions.has(sessionId);
  }

  /**
   * 底部输入区「远程接续」开关（语义按用户澄清反转）：
   * - start：远程继续干活 —— QQ 消息照常注入主会话、agent 继续执行；只冻结
   *   本地干预入口（转录保持只读可观察），并把该会话从「已断开」集合移除
   *   （重新接上远程）。发常驻只读 toast + 回推 active=true。
   * - stop：本地恢复 + 断开远程 —— 在本次接管的 sessionId 上设「不再接收 QQ
   *   注入」的门、取消在跑的注入回合、撤掉 toast、回推 active=false。
   * 门是会话级的：机器人仍服务其它会话；断开态不持久化，只在会话切换 /
   * 重建（newSession / restore / dispose）时清，webview 重连不清。
   */
  private handleQqTakeover(action: "start" | "stop"): void {
    if (this.disposed) return;
    if (action === "stop") {
      // 只有走到 stop 才断开远程：先记下本次接管的会话（清冻结态后会置空），
      // 设断开门 → 取消在跑的 QQ 主会话注入回合 → 清本地冻结态与 toast。
      const detachedSession = this.qqTakeoverSessionId;
      if (detachedSession !== null) this.qqRemoteDetachedSessions.add(detachedSession);
      this.cancelAllQqMainInjections();
      this.clearQqTakeover();
      return;
    }
    // start 不设任何暂停门：重新接上远程 + 冻结本地干预，QQ 注入照常放行。
    const sessionId = this.store.getState().sessionId;
    this.qqTakeoverActive = true;
    this.qqTakeoverSessionId = sessionId;
    if (sessionId !== null) this.qqRemoteDetachedSessions.delete(sessionId);
    if (this.qqTakeoverToastId === null) {
      this.qqTakeoverToastId = this.store.sendToast("info", vscode.l10n.t("远程接管中…"), {
        persistent: true,
        displayOnly: true,
      });
    }
    this.postToWebview({ type: "qqTakeoverState", active: this.qqTakeoverActive });
  }

  /** 清掉本地冻结态与常驻 toast；不碰「已断开远程」的会话集合。 */
  private clearQqTakeover(): void {
    this.qqTakeoverActive = false;
    this.qqTakeoverSessionId = null;
    if (this.qqTakeoverToastId !== null) {
      this.store.dismissToast(this.qqTakeoverToastId);
      this.qqTakeoverToastId = null;
    }
    this.postToWebview({ type: "qqTakeoverState", active: this.qqTakeoverActive });
  }

  /** 会话切换 / 重建时清掉「已断开远程」集合，避免旧会话永久收不到 QQ。 */
  private clearQqRemoteDetachedSessions(): void {
    this.qqRemoteDetachedSessions.clear();
  }

  /**
   * 停止整条 QQ 通道时的一次性放手（F6）：撤掉所有「等空闲」的注入，并打断
   * 当前真正跑在主会话上的那一轮。与单任务 {@link cancelQqMainInjection} 同源
   * 的 session/cancel 语义 —— 只有 qqInjectedTaskId 命中才打，绝不误伤本地回合。
   */
  private cancelAllQqMainInjections(): void {
    const activeTaskId = this.qqInjectedTaskId;
    for (const controller of this.qqInjectAborts.values()) controller.abort();
    this.qqInjectAborts.clear();
    // 只有「整条 QQ 通道停止」才会走到这里（stopQq）：撤销全部等最终答复的
    // 记账是正确语义。R3 不变量：普通任务收尾 / 汇报轮绝不调本方法，绝不因
    // 本地回合收尾而把 delegated=true 的 awaiter 误摘。
    this.qqMainFinalAwaiters.clear();
    this.qqMainFinalAwaiterSince.clear();
    this.qqFinalRescueText.clear();
    this.qqReportFallbackText.clear();
    this.qqFinalRescueDefers.clear();
    this.qqTaskBySuperSession.clear();
    this.qqTaskFinalText.clear();
    this.stopQqFinalRescueTimer();
    if (activeTaskId !== null) {
      this.qqInjectedTaskId = null;
      this.cancelSeen = true;
      const sessionId = this.store.getState().sessionId;
      if (sessionId) this.sendTurnCancel(sessionId, this.client);
    }
  }

  /**
   * 停止某个主会话渠道任务：放弃等待空闲，必要时打断正在跑的那一轮。
   *
   * 只有当前注入的就是这个任务时才 `session/cancel` —— 绝不能因为 QQ 的任务
   * 被停，把用户本地正在跑的回合一起打掉。
   */
  private cancelQqMainInjection(taskId: string): boolean {
    const controller = this.qqInjectAborts.get(taskId);
    const isActiveTurn = this.qqInjectedTaskId === taskId;
    const wasAwaitingFinal = this.qqMainFinalAwaiters.delete(taskId);
    if (wasAwaitingFinal) this.qqMainFinalAwaiterSince.delete(taskId);
    this.qqFinalRescueDefers.delete(taskId);
    if (this.qqMainFinalAwaiters.size === 0) this.stopQqFinalRescueTimer();
    if (!controller && !isActiveTurn && !wasAwaitingFinal) return false;
    controller?.abort();
    if (isActiveTurn) {
      this.cancelSeen = true;
      const sessionId = this.store.getState().sessionId;
      if (sessionId) this.sendTurnCancel(sessionId, this.client);
    }
    return true;
  }

  /** 子会话快照：优先 store 的投影（webview 看到的那份），再退回管理器。 */
  private findQqSuperSession(id: string): SuperSessionUi | null {
    const projected = this.store.getState().superSessions;
    const fromState = projected?.find((session) => session.id === id);
    if (fromState) return fromState;
    return this.getSuperAgent()?.get(id) ?? null;
  }

  // --- QQ 待审核用户 / 账号授权 ---------------------------------------------

  /** 待审核用户存储（懒建；与通道生命周期无关，通道没起也能看历史记录）。 */
  private qqPendingStore(): QqPendingUserStore {
    if (!this.qqPendingUsers) {
      const root = path.join(
        this.context.storageUri?.fsPath ?? this.context.globalStorageUri.fsPath,
        "qq",
      );
      this.qqPendingUsers = new QqPendingUserStore(root);
    }
    return this.qqPendingUsers;
  }

  /**
   * 服务上报一条白名单外消息：累加记录并推全量列表。
   *
   * 返回 `{dropped}`：队列满（{@link QQ_PENDING_MAX_USERS}）或写入失败时为
   * true，服务侧据此不虚称「已记入待审核」。丢弃提示里只出现脱敏 openid
   * （`maskQqOpenId`），完整值只留在存储里作为放行依据。
   *
   * 丢弃 warning 按 openid 冷却（{@link QQ_PENDING_DROPPED_TOAST_COOLDOWN_MS}）：
   * 满队时外部每条消息都触发一次丢弃事件，没有冷却会把操作者的面板刷满屏；
   * 不同用户的首次丢弃仍各自提示，不吞真实信号。
   */
  private async handleQqPendingUser(info: QqPendingUserInput): Promise<{ dropped: boolean }> {
    if (this.disposed) return { dropped: false };
    let outcome: { users: QqPendingUser[]; dropped: boolean; openid: string };
    try {
      outcome = await this.qqPendingStore().record(info);
    } catch (error) {
      this.log.warn(`QQ 待审核记录写入失败：${errorMessage(error)}`);
      // 写失败 = 未记入：如实回报 dropped，服务侧不得虚称「已记入」。
      return { dropped: true };
    }
    this.postQqPendingUsers(outcome.users);
    if (outcome.dropped) {
      const key = typeof info.openid === "string" ? info.openid.trim() : "";
      const at = Date.now();
      const last = this.qqPendingDropToastAt.get(key);
      if (last === undefined || at - last >= QQ_PENDING_DROPPED_TOAST_COOLDOWN_MS) {
        this.qqPendingDropToastAt.set(key, at);
        const masked = maskQqOpenId(outcome.openid) || "（未知用户）";
        this.store.sendToast(
          "warning",
          vscode.l10n.t(
            "待审核队列已满（上限 {0} 条），已丢弃来自 {1} 的新请求；请先处理现有记录",
            QQ_PENDING_MAX_USERS,
            masked,
          ),
        );
      }
    }
    return { dropped: outcome.dropped };
  }

  /** 推待审核列表（每次全量，webview 直接替换）。 */
  private postQqPendingUsers(users: QqPendingUser[]): void {
    if (this.disposed) return;
    this.postToWebview({ type: "qqPendingUsers", users });
  }

  /** 读存储后推一次（面板重开 / 通道启动时）。 */
  private async pushQqPendingUsers(): Promise<void> {
    if (this.disposed) return;
    try {
      this.postQqPendingUsers(await this.qqPendingStore().list());
    } catch (error) {
      this.log.warn(`QQ 待审核列表读取失败：${errorMessage(error)}`);
    }
  }

  /**
   * 面板对一条待审核记录的处置。
   *
   * approve → 移出队列 + 去重追加进 `allowedUsers`（落盘 + 热更新运行中的
   * config）+ 推设置快照；reject → 移出队列并记入拒绝集合（同一 openid 不会
   * 再冒出来）。写盘失败时**不删记录**并如实提示 —— 否则用户点了「放行」
   * 记录就消失，而白名单里其实没有他。
   */
  private async handleQqUserAction(
    openid: string,
    action: "approve" | "reject",
  ): Promise<void> {
    if (this.disposed) return;
    const id = typeof openid === "string" ? openid.trim() : "";
    if (id.length === 0) {
      this.store.sendToast("warning", vscode.l10n.t("待审核记录缺少用户标识"));
      return;
    }
    const pending = this.qqPendingStore();
    if (action === "reject") {
      this.postQqPendingUsers(await pending.reject(id));
      return;
    }

    const io = this.qq?.io ?? createVscodeQqSettingsIo(this.context.secrets);
    try {
      const fresh = await readQqSettings(io);
      // 快照里是带备注的条目；匹配与下面同步给运行中 config 的必须是完整 openid。
      const users = fresh.allowedUsers.some((entry) => entry.openid === id)
        ? fresh.allowedUsers
        : [...fresh.allowedUsers, { openid: id }];
      await applyQqSettingsPatch(io, { allowedUsers: users });
      // 与服务共享同一个 config 对象：白名单立刻生效，不必等重启。
      if (this.qq) this.qq.config.allowedUsers = users.map((entry) => entry.openid);
      this.postQqPendingUsers(await pending.approve(id));
      await this.pushQqSettings();
      this.log.info(`QQ 已放行用户 ${id}（当前 ${users.length} 个账号）`);
    } catch (error) {
      this.log.warn(`QQ 白名单写入失败：${errorMessage(error)}`);
      this.store.sendToast(
        "warning",
        vscode.l10n.t("无法写入 QQ 白名单：{0}", errorMessage(error)),
      );
    }
  }

  /**
   * 解除绑定并清除本地授权：删除扫码写入的 appId / appSecret、清空用户白名单
   * （群白名单不动）、把 enabled 落盘为 false，然后停掉通道。
   *
   * 手填凭据移除后这是唯一「忘掉机器人」的入口，所以必须连 SecretStorage
   * 里的凭据一起删 —— 只清白名单会让用户以为已经解绑，实际机器人凭据仍在。
   */
  private async unbindQqAccount(): Promise<{ ok: boolean; message: string }> {
    const io = this.qq?.io ?? createVscodeQqSettingsIo(this.context.secrets);
    await io.deleteSecret(QQBOT_APP_ID_SECRET_KEY);
    await io.deleteSecret(QQ_SECRET_KEYS.appSecret);
    try {
      await applyQqSettingsPatch(io, { allowedUsers: [], enabled: false });
    } catch (error) {
      // writeAll 走 Workspace 作用域：没打开工作区时会抛错。凭据已经删除，
      // 这里只记日志 —— 不谎报设置已落盘。
      this.log.warn(`QQ 设置写入失败：${errorMessage(error)}`);
    }
    if (this.qq) this.qq.config.allowedUsers = [];
    await this.stopQq();
    await this.pushQqSettings();
    return { ok: true, message: "已解除绑定并清除本地授权" };
  }

  // --- QQ 设置 / 凭据 / 状态消息 --------------------------------------------

  /**
   * 设置区改动 → 落盘 + 推快照 + 同步运行中的服务。
   *
   * 落盘走 `applyQqSettingsPatch`（白名单键 + 拒绝脏值）；是否重启由
   * `syncQqServiceWithSettings` 按连接类字段判定。
   */
  private async handleQqSettingsPatch(patch: QqSettingsPatch): Promise<void> {
    const io = this.qq?.io ?? createVscodeQqSettingsIo(this.context.secrets);
    let result: Awaited<ReturnType<typeof applyQqSettingsPatch>>;
    try {
      result = await applyQqSettingsPatch(io, patch);
    } catch (error) {
      // writeAll 走 Workspace 作用域：没打开工作区时会抛错。与
      // unbindQqAccount 一致如实提示，绝不让它冒泡出 handleWebviewMessage
      // 变成一次静默失败（用户以为设置生效了，实际一个字都没落盘）。
      this.log.warn(`QQ 设置写入失败：${errorMessage(error)}`);
      this.store.sendToast(
        "warning",
        vscode.l10n.t("无法写入 QQ 设置：{0}（请在已打开的工作区中设置）", errorMessage(error)),
      );
      return;
    }
    if (result.ignored.length > 0) {
      this.log.warn(`QQ 设置补丁忽略了：${result.ignored.join(", ")}`);
    }
    // 落盘会触发 `onDidChangeConfiguration` → `scheduleQqSettingsChanged`，
    // 由它统一做一轮快照 + 重启/热更新。这里**不再**直接调
    // `onQqSettingsChanged`，否则一次补丁会同步两轮（直接调用 + 事件回显）。
    // 立即回推归一化快照只是让设置页马上看到裁剪后的值。
    await this.pushQqSettings();
  }

  /** 设置页 QQ 卡片的动作。扫码登录三动作在 Wave5-C 落地：二维码桥随托管
   * 现场（this.qq）生灭，未启动时安静返回。 */
  private async handleQqConfigAction(
    action: "testConnection" | "unbind" | "startQrLogin" | "refreshQr" | "cancelQrLogin",
  ): Promise<void> {
    switch (action) {
      case "testConnection": {
        const adapter = this.qq?.qqbot?.adapter;
        if (!adapter) {
          this.pushQqStatus(false, "QQBot 未连接");
          return;
        }
        const health = await adapter.health();
        if (isQqHealthHealthy(health)) {
          // 健康即清零：下一次失活仍有一次自动重启的机会。
          this.qqHealthRestarts = 0;
          this.pushQqStatus(true, vscode.l10n.t("QQBot 官方网关已连接"));
          return;
        }
        const detail =
          typeof health.detail === "string" && health.detail.trim().length > 0
            ? health.detail.trim()
            : vscode.l10n.t("QQBot 未连接");
        // 先如实显示失活状态（绝不显示「正常」），再尝试恢复。
        this.pushQqStatus(false, detail);
        await this.recoverQqChannel(detail);
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
   * 设置事件合并入口（`onDidChangeConfiguration` 的唯一调用点）。
   *
   * 一次补丁会逐键 `writeAll`，事件会连发多轮；每轮都做读设置 + 推送 +
   * 重启判定纯属浪费。窗口内的多轮合并成一次完整同步。
   */
  private scheduleQqSettingsChanged(): void {
    if (this.disposed) return;
    if (this.qqSettingsSyncTimer) clearTimeout(this.qqSettingsSyncTimer);
    this.qqSettingsSyncTimer = setTimeout(() => {
      this.qqSettingsSyncTimer = null;
      if (this.disposed) return;
      void this.onQqSettingsChanged().catch((error: unknown) => {
        this.log.warn(`QQ 设置变更处理失败：${errorMessage(error)}`);
      });
    }, QQ_SETTINGS_SYNC_DEBOUNCE_MS);
    this.qqSettingsSyncTimer.unref?.();
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
    // 扫码绑定进行中 / 通道正在启动：绑定路径与启动路径自己会收尾，此刻任何
    // 按磁盘配置做的停/起都会把刚建好的 owner 反杀（首绑 enable 尚未落盘，
    // 配置事件读到 false 就会 stopQq）。等它们结束后由事件/心跳补一次同步。
    if (this.qqbotBinding || this.qqChannelStarting || this.qqStopping) return;
    const io = this.qq?.io ?? createVscodeQqSettingsIo(this.context.secrets);
    const snapshot = await readQqSettings(io);
    const { config, warnings } = normalizeQqConfig({ ...snapshot } as Record<string, unknown>);
    for (const warning of warnings) this.log.warn(`QQ 设置：${warning}`);

    if (!config.enabled) {
      // 只停仍在跑的通道：内存里的 enabled 已经是 false（刚停过 / 从未起过）
      // 时再调 stopQq 会白白推进代次并打断正在收尾的启动。
      if (this.qq && this.qq.config.enabled !== false) await this.stopQq();
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

  /**
   * 面板打开 / webview 重连 / 设置变更后的一次性全量推送。
   *
   * 二维码（`qqLoginQr`）是独立的一次性通道，**刻意不在这里补推**：宿主
   * 从不缓存二维码帧，补推只会把已经清屏的旧码重新塞回 webview。扫码状态
   * 由 `startQqBotBind` / `onQqBotBound` 主动推送。
   */
  private pushQqState(): void {
    this.refreshQqTasks();
    void this.pushQqPendingUsers();
    // 面板打开/重新可见时检查一次通道健康：op=9 之后 socket 可能仍「看着
    // 活着」但永远不会再来事件，只在用户点「测试连接」时才检查就太晚了。
    void this.checkQqChannelHealth();
  }

  /** QQ 设置快照（无明文凭据，只有 hasAppSecret 布尔）。 */
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
   * 只刷新任务看板投影（服务状态一变就调用）。
   *
   * 任务从「已校验」走到终态期间会 persist 好几次，每次都连带读设置 / 推连接
   * 状态是纯浪费（还要碰 SecretStorage）；这里只做 `setQqTasks` + 快照。
   */
  private refreshQqTaskProjection(): void {
    if (this.disposed) return;
    const service = this.qq?.service;
    // 通道为空（dispose / 重建竞态）时保持现状：清空看板会闪出一帧空列表，
    // 而显式停用路径（stopQq）不经过这里，不需要「空推送」。
    if (!service) return;
    setQqTasks(this.store.getState(), capQqTaskProjection(service.listTasks()));
    this.scheduleQqSnapshotFlush();
  }

  /**
   * 节流推送（而非立即 `pushSnapshot`）。
   *
   * 一个任务从 received 走到终态会 persist 多次，`onChanged` 每次都立即
   * push 会把整份快照风暴式推给 webview。`SessionStore` 的 `scheduleFlush`
   * 正是同一套节流器；它目前是私有方法（`store.ts` 不在本次改动边界内），
   * 这里用窄类型桥接，方法缺失时退回立即推送。
   */
  private scheduleQqSnapshotFlush(): void {
    const store = this.store as unknown as { scheduleFlush?: () => void };
    if (typeof store.scheduleFlush === "function") store.scheduleFlush();
    else this.store.pushSnapshot();
  }

  /**
   * 任务看板投影：服务里的任务列表 → `SessionState.qqTasks`。
   *
   * 与 `superSessions` 一样是**非 blocks 元数据**，因此复用 store 既有的
   * 节流快照 / blockPatch 通道（`pushSnapshot`），不自建推送。
   */
  private refreshQqTasks(): void {
    if (this.disposed) return;
    this.refreshQqTaskProjection();
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
        this.store.sendToast("info", vscode.l10n.t("已清理 {0} 个超流体", cleaned));
      } else {
        this.store.sendToast(
          "info",
          vscode.l10n.t("已清理 {0} 个超流体，{1} 个分支已保留", cleaned, branchesKept),
        );
      }
      return;
    }
    if (cleaned === 0) {
      this.store.sendToast("warning", vscode.l10n.t("未能清理这 {0} 个超流体", failed));
      return;
    }
    if (branchesKept === 0) {
      this.store.sendToast(
        "warning",
        vscode.l10n.t("已清理 {0} 个超流体，{1} 个未能清理", cleaned, failed),
      );
    } else {
      this.store.sendToast(
        "warning",
        vscode.l10n.t(
          "已清理 {0} 个超流体，{1} 个未能清理，{2} 个分支已保留",
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
  ): Promise<SuperMergeDispatchResult> {
    const manager = this.getSuperAgent();
    if (!manager) {
      return {
        dispatched: false,
        queued: false,
        reason: "超流不可用（未打开工作区）",
      };
    }
    const session = manager.get(id);
    if (!session) {
      this.store.sendToast("warning", vscode.l10n.t("该超流体不存在或已被清理"));
      return { dispatched: false, queued: false, reason: "该超流体不存在或已被清理" };
    }
    if (session.isolation.kind !== "git_worktree" || !session.isolation.branch) {
      this.store.sendToast("warning", vscode.l10n.t("该超流体没有可合并的分支（仅目录隔离）"));
      return {
        dispatched: false,
        queued: false,
        reason: "该超流体没有可合并的分支（仅目录隔离）",
      };
    }
    if (session.integration?.state === "merged") {
      this.store.sendToast("info", vscode.l10n.t("该超流体的改动已经合并"));
      return { dispatched: false, queued: false, reason: "该超流体的改动已经合并" };
    }
    if (!isTerminalSuperStatus(session.status)) {
      this.store.sendToast("warning", vscode.l10n.t("超流体还没结束，完成后再让智能体合并"));
      return {
        dispatched: false,
        queued: false,
        reason: "超流体还没结束，完成后再让智能体合并",
      };
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
        return {
          dispatched: false,
          queued: true,
          reason: "主会话正忙，合并请求已排队，空闲后自动派发",
        };
      }
      const reason = "主会话正在生成，未派出合并超流体，请等本轮结束后重试";
      this.store.sendToast(
        "warning",
        vscode.l10n.t("主会话正在生成，未派出合并超流体，请等本轮结束后重试"),
      );
      return { dispatched: false, queued: false, reason };
    }
    if (!state.sessionId) {
      if (options?.auto) {
        this.scheduleSuperMerge(id, options.reason ?? "");
        return {
          dispatched: false,
          queued: true,
          reason: "会话未就绪，合并请求已排队，就绪后自动派发",
        };
      }
      this.store.sendToast("warning", vscode.l10n.t("会话未就绪，无法让智能体合并"));
      return { dispatched: false, queued: false, reason: "会话未就绪，无法让智能体合并" };
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
        return {
          dispatched: false,
          queued: true,
          reason: "已有合并超流体在跑，合并请求已排队，等它结束后派发",
        };
      }
      this.store.sendToast(
        "warning",
        vscode.l10n.t("已有合并超流体在跑，等它结束后再合并：{0}", branch),
      );
      return {
        dispatched: false,
        queued: false,
        reason: `已有合并超流体在跑，未派出新的合并超流体（分支 ${branch}），请稍后重试`,
      };
    }
    this.store.sendToast(
      "info",
      options?.auto
        ? vscode.l10n.t("超流体「{0}」的改动没能自动合并，已派出合并超流体", session.title)
        : vscode.l10n.t("已派出合并超流体，合并超流体「{0}」的分支", session.title),
    );
    return { dispatched: true, mergeSessionId: child.id };
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
        // 先把队首**取下**再 request：派发失败时 requestSuperMerge 的 auto
        // 路径会用 scheduleSuperMerge 把 id 重新排到**队尾**（按 id 去重），
        // 绝不再把同一个 id 塞回队首反复挡住后面的合并请求。
        const next = this.pendingSuperMerges.shift();
        if (!next) break;
        const result = await this.requestSuperMerge(next.id, { auto: true, reason: next.reason });
        if (!result.dispatched && this.pendingSuperMerges.length > 0) {
          // 没派出去：合并子会话可能压根没起，onMergeResult 永远不会来 ——
          // 只靠外部回调会卡住整条队列。登记一次性唤醒，下一拍自己再试。
          this.scheduleSuperMergeWakeup();
        }
        // 合并子会话跑完才派下一个（onMergeResult 会再叫一次 drain）。
        break;
      }
    } finally {
      this.superMergeRunning = false;
    }
  }

  /**
   * 合并队列的一次性唤醒（与心跳并行的一道保险，见 superMergeWakeupTimer）。
   *
   * 有定时器在就不再叠加新的：多次失败重投只留一拍，避免定时器风暴。
   */
  private scheduleSuperMergeWakeup(): void {
    if (this.disposed || this.superMergeWakeupTimer) return;
    this.superMergeWakeupTimer = setTimeout(() => {
      this.superMergeWakeupTimer = null;
      if (this.disposed) return;
      void this.drainSuperMerges();
    }, SUPER_HEARTBEAT_MS);
    // 与心跳同理：别为一个唤醒把扩展宿主钉在内存里。
    if (typeof this.superMergeWakeupTimer.unref === "function") {
      this.superMergeWakeupTimer.unref();
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

      // Main-session MCP scope. This CLI process must not hold ANY MCP server:
      // MCP tools are registered by `discoverAllTools()` AFTER
      // `createToolRegistry()`, so the `allowed_tools` whitelist cannot stop
      // them — and their names are per-user (every install configures different
      // servers), so they must never be enumerated. `--allowed-mcp-server-names`
      // with a never-matching sentinel filters the resolved server map down to
      // nothing: nothing is spawned and no MCP tool is ever registered.
      // Child spawns (createSuperClient) pass the host BROKER's server names
      // instead: one shared server process per configuration, reached over
      // loopback HTTP — never a per-child copy.
      const { args } = buildAcpCommand(entry, allowedRoots, { disableMcpServers: true });
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
            return this.requestPermissionFromUser(req);
          },
          onUserQuestions: (req: UserQuestionsRequest) => {
            if (this.client !== client) return Promise.resolve({ answers: {} });
            return this.userQuestionsFromAgent(req);
          },
          onExitPlanMode: async (req: ExitPlanModeRequest) => {
            // 计划模式已移除（2026-11-18）。CLI 仍可能从旧会话归档或外部
            // `~/.iflow/settings.json` 的 approvalMode=plan 进入 plan 模式并发来
            // `_iflow/plan/exit`；这里不弹卡、不阻塞，直接放行（见
            // handleRemovedPlanExit）。
            if (this.client !== client) return { approved: false, reason: "client busy" };
            return this.handleRemovedPlanExit(req);
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
          // 启动自动新建：跳过子会话残留检测（confirmAndPurgeSuperResidue 里
          // countResidue 要读全工作区目录，冷启动和恢复窗口里同步 await 会明显
          // 拖慢面板）。残留确认框只在用户显式点「新建会话」时出现。
          await this.startNewSession({ bypassSuperWait: true });
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
   * Push the fixed main-session mode after `session/new` / `session/load`.
   *
   * Same-value pushes are CLI-side no-ops, so calling this on every session
   * start is idempotent. The store's optimistic echo is updated only when it
   * actually changed. Never throws: a failure only logs — the turn still
   * runs under whatever mode the CLI booted with.
   */
  private async applyMainSessionMode(client: AcpClient, sessionId: string): Promise<void> {
    try {
      const resp = (await client.setMode(sessionId, MAIN_SESSION_MODE)) as
        | { success?: boolean; currentModeId?: string }
        | undefined;
      const modes = this.store.getState().modes;
      if (!modes) return;
      const currentModeId = resp?.currentModeId ?? MAIN_SESSION_MODE;
      if (modes.currentModeId !== currentModeId) {
        this.store.sessionMeta({ modes: { ...modes, currentModeId } });
      }
    } catch (error) {
      this.log.warn(`main session mode push failed (${MAIN_SESSION_MODE}): ${errorMessage(error)}`);
    }
  }

  /**
   * Re-assert the fixed mode before a turn starts.
   *
   * The CLI keeps the mode only in its config and never notifies us (no
   * `current_mode_update`), so an external drift (stale archived session,
   * external `~/.iflow/settings.json`) must be pulled back before the turn
   * goes out. Pushing the mode it already holds is a no-op CLI-side; a
   * failure here must never block the prompt.
   */
  private async assertModeForPrompt(client: AcpClient, sessionId: string): Promise<void> {
    try {
      await client.setMode(sessionId, MAIN_SESSION_MODE);
    } catch (error) {
      this.log.warn(`mode re-assert failed (${MAIN_SESSION_MODE}): ${errorMessage(error)}`);
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
    if (this.disposed) return;
    // No MCP items here on purpose. The main panel session's CLI process runs
    // with every MCP server removed at process level (`buildAcpCommand`'s
    // `disableMcpServers`), so it can never carry an MCP tool. Asking mcp-status
    // only surfaced the user's configured-but-disabled servers as "N not
    // connected" — a meaningless warning inside a card that lists what the
    // model actually sees (2026-11-18 user report). The MCP settings card keeps
    // the live server list and status.
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
    this.persistPending += 1;
    const run = this.persistChain
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(() => this.writeTranscriptFile(sessionId, payloadFactory()));
    this.persistChain = run
      .catch(() => {})
      .finally(() => {
        this.persistPending = Math.max(0, this.persistPending - 1);
      });
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
      // 归档本体（<name>.json）与损坏备份（<name>.json.corrupt）都要 GC。
      // 备份名是归档名再加 .corrupt：剥掉后缀后按同一份 kept 集合比对——
      // 正常归档（含仍归属的会话）一律不动，只有其会话已离开列表的残留
      // 才回收，避免误删正在用的归档或把备份当独立会话。
      const isBackup = name.endsWith(".corrupt");
      const archiveName = isBackup ? name.slice(0, -".corrupt".length) : name;
      if ((isBackup || archiveName.endsWith(".json")) && !keptArchiveNames.has(archiveName)) {
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
    // 远程接续绑定在旧会话上：切走即失效，不能把冻结态带进新会话。
    // 断开门同样按会话归属：旧会话的「不再接收 QQ」标记随会话一起作废。
    if (!this.disposed) {
      this.clearQqTakeover();
      this.clearQqRemoteDetachedSessions();
    }
    const running = this.newSessionRun;
    if (running) {
      // 进行中重复点击：直接忽略，不重复发 `session/new`（join 同一个 run
      // 只为让调用方的 await 语义保持一致），也不改写投影。
      this.log.info("new session: joining the in-flight run");
      await running;
      return;
    }
    // 投影必须在第一个 await 之前落库：webview 收到快照后立刻禁用按钮并显示
    // 「正在新建会话…」（webview 侧另有一层本地乐观锁覆盖 IPC 往返窗口）。
    if (!this.disposed) this.store.setNewSessionPhase("starting");
    const run = this.runStartNewSession(options);
    this.newSessionRun = run;
    try {
      await run;
    } catch (error) {
      // 失败要可见：错误横幅（status=error）之外，继续抛给
      // handleWebviewMessage 的统一 catch 打 toast —— 静默失败会让用户以为
      // 按钮只是「点了没反应」。
      if (!this.disposed && !(error instanceof DisposedError)) {
        this.store.markError(errorMessage(error));
      }
      throw error;
    } finally {
      if (this.newSessionRun === run) this.newSessionRun = null;
      // 成功 / 被拒 / 失败一律收回 idle，否则按钮会永久锁在加载态。
      if (!this.disposed) this.store.setNewSessionPhase(null);
    }
  }

  private async runStartNewSession(options?: { bypassSuperWait?: boolean }): Promise<void> {
    if (this.historySyncBusy) {
      // 不静默：命令面板会绕过 webview 的禁用按钮，点了却毫无反应会被读成
      // 「按钮坏了」。投影由 startNewSession 的 finally 收回。
      this.store.appendNotice(vscode.l10n.t("正在处理其他会话操作，请稍后再新建会话"));
      return;
    }
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
        vscode.l10n.t("还有超流体在运行并等待汇报，请等它们结束（或在看板上中断）后再新建会话"),
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
      // 在等一个后台恢复收尾：明确告诉用户不是卡住了。
      if (!this.disposed) this.store.setNewSessionPhase("waiting");
      const outcome = await restoreSettle.promise;
      this.pendingNewSession = false;
      if (!this.disposed) this.store.setNewSessionPhase("starting");
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
    // 跨全部历史会话的 Super Agent 残留检测：轻量读目录计数，命中才弹二次
    // 确认框（「清空并新建」/「取消」）。profile 切换复用这条新建流程，但它
    // 已有自己的对话框，不叠加这一层。
    if (!options?.bypassSuperWait) {
      await this.confirmAndPurgeSuperResidue();
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
    // 清空转录前要先等落盘链收尾（profile 切换 / 上一轮的 transcript 写可能
    // 还在飞）。真的在等就投影成 waiting —— 否则这段等待在 UI 上和卡死没区别。
    const waitingOnPersist = this.persistPending > 0;
    if (waitingOnPersist && !this.disposed) this.store.setNewSessionPhase("waiting");
    await this.cleanupEmptySession(
      this.store.getState().activeSessionId ?? this.store.getState().sessionId,
    );
    if (waitingOnPersist && !this.disposed) this.store.setNewSessionPhase("starting");
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
    // 已有握手在飞（warmStart / 重启 / 首次连接）：ensureClient 会等它完成，
    // 这段等待同样要如实投影，不能让面板看起来停在「正在新建会话」。
    const waitingOnConnect = !this.client && this.connecting !== null;
    if (waitingOnConnect && !this.disposed) this.store.setNewSessionPhase("waiting");
    const client = await this.ensureClient();
    if (waitingOnConnect && !this.disposed) this.store.setNewSessionPhase("starting");
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
    // 主会话模式固定为 smart：CLI 会按自己的启动模式（外部 settings.json
    // 的 approvalMode 或内置默认）开新会话，必须显式推回 smart。set_mode
    // 同值推送在 CLI 侧是 no-op，因此每次新建会话都推送是幂等的。
    await this.applyMainSessionMode(client, session.sessionId);
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
     * `finalReport: true` — 仅对 reportTurn 生效：这是 pendingCount=0 的汇总轮，
     * 收尾时把该轮 assistant 文本作为 QQ 任务的真正最终答复回传（见
     * {@link deliverQqMainFinalAnswer}）。中途进度汇报轮不带此标记。
     *
     * 返回值：true = 这一回合真的在主会话上跑起来了；false = 被拒了（主会话
     * 正忙 / 正在恢复历史 / 已销毁）或被派发成了子会话。汇报队列靠它决定
     * 「这条汇报是投出去了」还是「还欠着」—— 汇报丢了主会话就永远读不到
     * 自己孩子的结果。
     *
     * QQ 主会话注入（QQ 消息固定去向）用到四个额外选项：
     *  - `origin: "qq"`：user 块带来源标记，转录里渲染 QQ 徽标（外部渠道
     *    消息必须与本机输入可区分）；
     *  - `displayText`：转录气泡正文（QQ 原文），而 `text` 是模型可见的
     *    带来源包裹版本 —— 本机用户看到的就是对方发来的内容；
     *  - `quietBusy`：撞上忙窗口时安静返回 false（调用方排队重试），不要弹
     *    「等本轮结束后再让智能体合并」那种误导性提示；
     *  - `onTurnStarted`：这一轮真的开始后回调（服务据此把 QQ 任务从
     *    「排队中」切到「已注入待回复」）。
     */
    options?: {
      internal?: boolean;
      delegateOnBusy?: boolean;
      hidden?: boolean;
      reportTurn?: boolean;
      finalReport?: boolean;
      /** 汇总轮二次转述为空时兜底回 QQ 的子会话汇报正文（由 drainSuperReports 透传）。 */
      finalFallbackText?: string;
      origin?: "qq";
      displayText?: string;
      quietBusy?: boolean;
      onTurnStarted?: () => void | Promise<void>;
    },
  ): Promise<boolean> {
    const internal = options?.internal === true;
    const hidden = options?.hidden === true;
    const reportTurn = options?.reportTurn === true;
    const finalReport = reportTurn && options?.finalReport === true;
    const finalFallbackText = options?.finalFallbackText;
    /** QQ 主会话注入回合：对话派生的回合末任务（下一步 / 记忆）必须跳过。 */
    const qqTurn = options?.origin === "qq";
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
      // 用户真正开了一轮新对话：super-agent 参数纠错的每轮配额重新给满。
      // 绝不能放在 hidden 分支：纠错提示自己会触发一次 hidden 回合，重置
      // 配额就等于让限次失效（模型每错一次都能再拿 2 次提醒）。
      this.superToolCallCorrections.delete(this.currentMainSessionId() ?? "");
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
        // `quietBusy`：调用方（QQ 主会话注入）自己会排队重试，弹一条
        // 「让智能体合并」的提示纯属误导。
        if (options?.quietBusy !== true) {
          this.store.sendToast(
            "warning",
            vscode.l10n.t("主会话正在生成，等本轮结束后再让智能体合并"),
          );
        }
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
        this.store.sendToast("warning", vscode.l10n.t("没有打开的工作区，无法派发超流体"));
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
        vscode.l10n.t("主会话正在生成，已把这条消息派发为超流体「{0}」", title),
      );
      if (droppedAttachments > 0) {
        this.store.sendToast(
          "warning",
          vscode.l10n.t(
            "每个超流体最多携带 {0} 个附件，超出上限的 {1} 个已忽略",
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
      // The CLI's mode is invisible to us (no `current_mode_update`), so any
      // drift would otherwise surface as the agent silently acting under a
      // different mode than the composer shows — make the CLI follow the mode
      // the user sees before every turn.
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
        // QQ 注入：气泡显示对方原文，模型拿到的是带来源包裹的版本（服务
        // 生成），来源标记另走 `origin` —— 三者不得混为一谈。
        const bubbleText = options?.displayText ?? fullText;
        this.store.userPrompt(
          bubbleText,
          (images ?? []).map((img) => `data:${img.mimeType};base64,${img.data}`),
          files,
          options?.origin,
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
      // QQ 注入的「已注入」锚点：user 气泡已落地、这一轮确定要跑。回调失败
      // 只记日志 —— 它只是投影状态，不能把一整轮真实工作打红。
      if (options?.onTurnStarted) {
        try {
          await options.onTurnStarted();
        } catch (error) {
          this.log.warn(`turn-started callback failed: ${errorMessage(error)}`);
        }
      }
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
      // 最终汇报轮的 assistant 文本锚点：与 injectQqMainTurn 同口径（可见
      // text 块、排除 system），轮末只取基线之后的文本，避免把上一轮内容
      // 当成本轮结论回给 QQ。除了 id 还要记下锚块**当前文本长度**：hidden
      // 回合没有 user 块边界，流式正文会被并进这个块且 id 不变，只按 id
      // slice 会整段漏掉（2026-11-19 空摘要回归）。
      let finalReportAnchorId: string | undefined;
      let finalReportAnchorLen = 0;
      let finalReportFallbackCount = 0;
      if (finalReport) {
        const visible = this.store.getState().blocks.filter(
          (block) => block.kind === "text" && !block.system,
        );
        finalReportFallbackCount = visible.length;
        const anchor = visible[visible.length - 1];
        finalReportAnchorId = anchor?.id;
        finalReportAnchorLen = anchor?.kind === "text" ? anchor.text.length : 0;
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
      // QQ 最终回执：pendingCount=0 的汇报汇总轮收尾后，把本轮 assistant 文本
      // 作为等待中的 QQ 任务的真正答复回传（fire-and-forget，不挡回合收尾）。
      // 锚点失效（转录被清空/重排）时按「回合开始时的块数」切片取本轮新增文本；
      // 切片为空则由 finalFallbackText（子会话汇报正文）接管 —— 绝不静默放弃，
      // 那会让 awaiter 一直挂到空缓存补发、最终只发一句占位文案。
      if (finalReport && result.stopReason !== "cancelled") {
        const { text: answer } = this.extractQqTurnTextFromAnchor(
          finalReportAnchorId,
          finalReportAnchorLen,
          finalReportFallbackCount,
        );
        void this.deliverQqMainFinalAnswer(
          promptSessionId,
          answer,
          result.stopReason,
          undefined,
          finalFallbackText,
        );
      }
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
          this.announceSuperReport(vscode.l10n.t("主会话已汇报超流体结果"));
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
          // QQ 消息是外部渠道内容：绝不从中提炼「下一步」或写入自动记忆
          // （记忆会进后续系统提示）。标题只是本地会话标签，不涉安全边界。
          conversationTasks: !qqTurn && !isCompressTurn && !autoCompressed,
        });
      }
      // M2 P0-3: the turn settled — the idle slot is free, feed it the next
      // queued message (no-op when the queue is empty). A user Stop
      // (cancelled) also drains: Stop interrupts the CURRENT turn, the queue
      // keeps steering (roadmap Steer semantics).
      void this.dispatchQueue();
      // 主会话空闲了 → 统一仲裁 5 条自动回合队列（汇报 / 动作回执 / 被改道
      // 消息 / 纠错 / 合并），按明确优先级 + 轮转每拍取一条队列投出（该队列
      // 沿用既有顺序投递语义）。剩下的交给下一次仲裁或心跳 —— 任一队列卡住
      // 都不会挡死其余。
      void this.drainSuperAutoTurns();
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
      // blocking-card triggers — question/approval card displayed — plus turn
      // completion. A failed turn keeps its in-panel banner (markError above) +
      // the error chime (postSound below) but earns no system toast.
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
      state.pendingApproval || state.pendingQuestions
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
          await client.setMode(sessionId, MAIN_SESSION_MODE);
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
      state.pendingApproval || state.pendingQuestions
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
      state.pendingApproval || state.pendingQuestions
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
