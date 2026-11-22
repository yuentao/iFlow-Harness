/**
 * Chat panel: owns the AcpClient lifecycle and the WebView. Host-side routing:
 * WebView messages → ACP calls; ACP events → store → throttled snapshots.
 */

import * as vscode from "vscode";
import os from "node:os";
import path from "node:path";
import { inspect, promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile, writeFile, rm, rename } from "node:fs/promises";
import { AcpClient } from "../acp/client.js";
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
import type { McpBrokerStatus } from "../acp/mcp-broker.js";
import { deleteKernelApiProfile, migrateKernelApiProfiles, readKernelApiProfiles, setKernelActiveProfile, writeKernelApiProfile } from "../acp/api-profiles.js";
import { tokensLimitEnvFromSettings } from "../acp/cli-tokens-limit.js";
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
} from "../acp/protocol.js";
import type { PendingApprovalUi, PendingProfileSwitchUi, AssetKind, Block, CheckpointUi, ContextKind, ContextRefUi, InjectedContextItem, McpScope, McpStatusUi, ModelMetadataSource, QueuedPromptUi, SessionState, SessionSummaryUi, SuperResidueBranchUi, ToolBlock, ToolDiffUi, WebviewToHost, WorkspaceRootUi } from "../../shared/messages.js";
import { extractCorePrompt, normalizeUserPromptText, splitReportedContextSections, AGENT_ATTACHMENT_HEADER } from "../../shared/messages.js";
import { buildAssetGenPrompt, normalizeGeneratedAsset } from "../../shared/asset-gen.js";
import { loadPrompt, renderPrompt } from "../../prompts/index.js";
import { canReviewTurn, collectTurnChanges } from "../../shared/turn-changes.js";
import {
  clearQueue as clearQueueUi,
  moveQueued as moveQueuedUi,
  removeQueued as removeQueuedUi,
  shiftQueued as shiftQueuedUi,
} from "../../shared/queue.js";
import { checkpointLabelFromText } from "../../shared/checkpoints.js";
import { ToolDiffService } from "./tool-diff-service.js";
import { StatusPresenter } from "./status-presenter.js";
import {
  buildAddDirs,
  buildWorkspaceRootsUi,
  normalizeSelection,
  rewriteRootMentions,
  workspaceRootsFrom,
} from "./workspace-roots.js";
import { SessionPersistenceService, type PersistedTranscript } from "./session-persistence.js";
import { CheckpointService } from "./checkpoint-service.js";
import { SessionRestoreService, type RestoreOutcome } from "./session-restore.js";
import { SuperAgentHost } from "./super-agent-host.js";
import {
  clampMaxConcurrentSuperSessions,
  clampMaxSuperWorktrees,
  DEFAULT_MAX_CONCURRENT_SUPER_SESSIONS,
  DEFAULT_MAX_SUPER_WORKTREES,
  MAX_SUPER_ATTACHMENTS,
  normalizeSuperTitle,
  type SuperIntegrationMode,
} from "../../shared/super-agent.js";
import {
  awaitSuperSessionArchiveWrite,
  deleteSuperSessionArchive,
  deleteSuperTranscriptSnapshot,
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
import type { ParsedEditArgs, PreEditSnapshot, UsageContext } from "../../shared/session-state.js";
import {
  canStopSubAgent,
  clampSessionLabel,
  estimateMcpContextTokens,
  dropSessionUpdate,
  extractRerunnableCommand,
  findCliHistoryCut,
  findToolBlockById,
  isAgentOutputUpdate,
  isSubAgentToolCall,
  newSessionState,
  parseEditArgs,
  renameSessionSummary,
  SESSION_LABEL_MAX,
  toAgentPromptText,
} from "../../shared/session-state.js";
import { SessionStore } from "./store.js";
import { getTerminalRecorder, openInTerminal } from "./terminal.js";
import { MemoryService } from "../memory/service.js";
import { AssetsService } from "../assets/service.js";
import { resolveSkill, skillRoots } from "../skills/service.js";
import { buildSkillPrompt, parseSkillInvocation, type SkillInvocation } from "../../shared/skills.js";
import { isWithin, memoryHome } from "../memory/files.js";
import type { WorkspaceFile, WorkspaceScan } from "../memory/knowledge.js";
import { attachmentSessionDir, sweepStaleAttachmentDirs } from "./attachments.js";
import { normalizeModelId, parseContextWindowOverrides, parseCostTable, resolveContextWindowWithSource, resolveCostWithSource } from "../../shared/context-window.js";
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
  type MetadataAdditions,
  type MetadataSource,
  type ModelMetadataEntry,
} from "../../shared/model-metadata.js";
import { fetchPageText, searchWeb, type WebSearchHit } from "../acp/web-search.js";
import { WireRingBuffer } from "./wire-log.js";
import {
  sanitizeQqReportFallback,
  clipQqTakeoverReport,
  QqHost,
} from "./qq-host.js";
// QQ module-level helpers remain part of panel.ts's public surface (tests import them).
export { isQqHealthHealthy, capQqTaskProjection } from "./qq-host.js";

import type { QqSettingsIo } from "../qq/settings-host.js";
import type { QqBotBindRuntimeDeps, QqChannelDispatchDeps } from "./qqbot-host.js";

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
 * likewise per PROCESS: the main session's spawn gets the sentinel
 * (`--allowed-mcp-server-names __iflow_harness_no_mcp__`, zero MCP), while
 * child spawns get the host broker's server names only
 * (`--allowed-mcp-server-names <broker name>` per brokered server) — so a child
 * can reach the broker's HTTP MCP endpoints but never spawns the user's own
 * stdio servers. See `createSuperClient` → `buildAcpCommand(..., { mcpServerNames: broker?.names() ?? [] })`.
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
 * `disableMcpServers`.
 *
 * `addDirs`（多仓库协作）: 只有「用户为这个会话选了严格子集」时才传，见
 * `buildAddDirs`。实证（vendor/iflow-fork/bundle/iflow.js）：
 *   • `includeDirectories:o?.add_dirs`（ACP adapter 把 settings.add_dirs 直接
 *     映射成会话 config 的 includeDirectories）；
 *   • Config 构造 `new Yct(this.targetDir,e.includeDirectories??[])`；
 *   • 配置工厂 `includeDirectories:A.includeDirectories||r.includeDirectories`
 *     —— 缺省 add_dirs 时回退到 argv 的 `--include-directories`（全量根，
 *     即今天的行为）；显式数组（含 `[]`）胜出并收紧该会话的 WorkspaceContext。
 * 所以 `undefined` 必须保持「完全不写这个键」，否则默认行为会被改变。 */
export function mainSessionSettings(addDirs?: readonly string[] | null): SessionSettings {
  const settings: SessionSettings = {
    allowed_tools: [...MAIN_SESSION_ALLOWED_TOOLS],
    disallowed_tools: [...MAIN_SESSION_DISALLOWED_TOOLS],
  };
  if (addDirs) settings.add_dirs = [...addDirs];
  return settings;
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
/** workspaceState key (多仓库协作): 用户为**之后新建**的会话选中的目标根集合
 * （绝对路径数组）。它只是「下一个会话的偏好」——当前会话的 CLI 上下文与 cwd
 * 一律不动，已有会话的根集合记在会话索引的 `roots` 字段里。 */
const SESSION_ROOTS_KEY = "iflow.sessionRoots";
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

/**
 * 多模态方案 C：模型可见的逐图顺序清单。
 *
 * 模型拿到的图片是**不带文件名**的内联块，所以「第几张图是什么」只能靠这段
 * 文本；说明为用户原文（不翻译、不改写），没有说明的图片如实写「（无说明）」，
 * 绝不编造内容。固定标签按功能规格用中文。
 *
 * 只列**实际内联发送**的图片：调用方传入的就是 `prompt` 里 push 的那些
 * image 块（与 `images` 同序同长）；超过内联上限、仅以文件路径提供的附件
 * 不在这个列表里 —— 它们由附件清单（路径行）单独说明。
 */
function buildImageCaptionPrompt(captions: readonly string[]): string {
  if (captions.length === 0) return "";
  return [
    "已附图片（按顺序）：",
    ...captions.map((caption, index) => `${index + 1}. ${caption || "（无说明）"}`),
  ].join("\n");
}

/** Cap on the per-workspace recent-session list. */
const MAX_RECENT_SESSIONS = 20;
/** Label until the first user prompt names the session. */
const DEFAULT_SESSION_LABEL = vscode.l10n.t("（无标题会话）");
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

export class DisposedError extends Error {
  constructor(message = "panel disposed") {
    super(message);
    this.name = "DisposedError";
  }
}

export class ChatPanel implements vscode.Disposable {
  public static readonly viewId = "iflow.chatPanel";

  // Super Agent caps — the runtime now lives in SuperAgentHost (阶段 6), but
  // these remain on ChatPanel as the stable public surface a guard test reads
  // (super-report-ownership.test.ts). Values mirror the host constants.
  static readonly SUPER_DISPATCHED_DIRECTIVES_CAP = 100;
  static readonly SUPER_TOOL_CALL_WARN_CAP = 100;
  static readonly SUPER_TOOL_CALL_ACTIONS_CAP = 100;
  static readonly SUPER_TOOL_CALL_OUTCOME_CAP = 100;
  static readonly SUPER_TOOL_CALL_CORRECTION_CAP = 2;

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
  /** Tool diff / revert host logic (阶段 1 下沉). All panel methods in the
   * "Diff revert" section are thin delegates to this instance, so the
   * webview-message switch and tests keep their existing contract. */
  private readonly toolDiff: ToolDiffService;
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
  /** Status-bar display (text / tooltip / lifecycle), extracted to
   * `StatusPresenter` in 阶段 2. `updateStatusBar` below is a thin delegate to
   * this instance, so the store callback / extension contract is unchanged. */
  private readonly statusPresenter: StatusPresenter;
  /** Read-only session persistence + transcript disk helpers, extracted to
   * `SessionPersistenceService` in 阶段 3. Every persistence method below is a
   * thin delegate to this instance so the webview-message switch, tests and the
   * extension contract are unchanged. The service is also the reuse surface
   * for 阶段 4 (restoreSession / checkpoint). */
  private readonly persistence: SessionPersistenceService;
  /** M5: agent status at a glance (idle / streaming / approval / error + model).
   * Its tooltip doubles as the session-info entry for usage: the composer's
   * model chip only carries the compact occupancy bar, so the full breakdown
   * (context / split / cache / cost) lives here, one hover away.
   *
   * Read-only alias to `statusPresenter.statusBar` — kept so internal call
   * sites and tests that reach into `panel.statusBar` keep the same contract. */
  private readonly statusBar: vscode.StatusBarItem;
  /** cwd the current ACP session was created with (base for relative paths). */
  private sessionCwd: string | null = null;
  /**
   * Super Agent — the orchestrator for child sessions spawned by the MAIN
   * session. Each child runs its own CLI process inside its own git worktree,
   * so several of them can touch the same project without colliding. Created
   * lazily (the first delegation pays the setup cost).
   */
  get superAgent(): SuperAgentHost["superAgent"] { return this.superHost.superAgent; }
  set superAgent(value: SuperAgentHost["superAgent"]) { this.superHost.superAgent = value; }
  /**
   * Host-side MCP broker: ONE process per configured MCP server, shared by all
   * Super Agent children (they reach it over loopback streamable HTTP). Started
   * lazily on the first child spawn; disposed with the panel.
   *
   * Without it every child CLI process would spawn its own copy of every
   * configured server (Windows: ~3 node processes per server per child), which
   * is exactly why child MCP used to be switched off entirely.
   */
  get mcpBroker(): SuperAgentHost["mcpBroker"] { return this.superHost.mcpBroker; }
  set mcpBroker(value: SuperAgentHost["mcpBroker"]) { this.superHost.mcpBroker = value; }
  /** Single-flight guard for broker startup (several children can spawn at once). */
  get mcpBrokerStarting(): SuperAgentHost["mcpBrokerStarting"] { return this.superHost.mcpBrokerStarting; }
  set mcpBrokerStarting(value: SuperAgentHost["mcpBrokerStarting"]) { this.superHost.mcpBrokerStarting = value; }
  /** SuperAgentHost owns the whole host-side Super Agent orchestration (阶段 6).
   * All `super*` state fields above are compatibility accessors onto this single
   * instance — timers/queues/locks live and are cleared only inside the host.
   * The manager body (`super-agent.ts`) is untouched.
   *
   * Lazily initialized so tests that use `Object.create(ChatPanel.prototype)`
   * and set individual fields (never calling the constructor) still work —
   * the callbacks are arrow wrappers read at CALL time, so a host built before
   * those fields exist is harmless until one of its methods actually runs. */
  private _superHost: SuperAgentHost | null = null;
  private get superHost(): SuperAgentHost {
    if (!this._superHost) this._superHost = this.buildSuperHost();
    return this._superHost;
  }

  /**
   * 残留清单的一次性令牌（批次1B：`superResidueList` ↔ `superResidueHandle`）。
   * 宿主下发清单时换发新令牌、旧令牌立即作废；webview 的「一键合并 / 丢弃」
   * 必须原样回传，校验通过即消费 —— 保证用户确实看过清单这道二次确认。
   * 映射同时把 UI 的 `sessionId` 翻译回宿主的残留 `key`（孤儿项无 sessionId
   * 时二者相同），使 webview 回传的 id 能定位到 listResidueItems 的条目。
   */
  private superResidueListToken: string | null = null;
  private superResidueListKeys = new Map<string, string>();
  private superResidueListSeq = 0;
  private buildSuperHost(): SuperAgentHost {
    return new SuperAgentHost({
      log: { info: (m) => this.log.info(m), warn: (m) => this.log.warn(m), error: (m) => this.log.error(m) },
      getContext: () => this.context,
      getServices: () => this.services,
      getStore: () => this.store,
      isDisposed: () => this.disposed,
      getEditorPanel: () => this.editorPanel,
      isHistorySyncBusy: () => this.historySyncBusy,
      getQqHost: () => this.qqHost,
      getQqFinalRescueText: () => this.qqFinalRescueText,
      announceCue: (event, text, kind) => this.announceCue(event, text, kind),
      appendQqArchiveEvent: (...args) => this.appendQqArchiveEvent(...args),
      captureQqReportTurnText: (...args) => this.captureQqReportTurnText(...args),
      currentMainSessionId: () => this.currentMainSessionId(),
      contextReportFile: () => this.contextReportFile(),
      // One-way re-delegation: these self-calls must remain observable via
      // vi.spyOn(panel, ...) (tests override them on the panel instance).
      getSuperAgent: () => this.getSuperAgent(),
      refreshSuperWaitHeartbeat: () => this.refreshSuperWaitHeartbeat(),
      deliverQqMainIntermediateText: (...args) => this.deliverQqMainIntermediateText(...args),
      forwardQqMainTaskChildQuestion: (...args) => this.forwardQqMainTaskChildQuestion(...args),
      forwardQqTaskQuestion: (...args) => this.forwardQqTaskQuestion(...args),
      materializeSystemPrompt: (variant) => this.materializeSystemPrompt(variant),
      mcpProjectCwd: () => this.mcpProjectCwd(),
      notifyOs: (event, text) => this.notifyOs(event, text),
      postToWebview: (m) => this.postToWebview(m),
      qqFinalRescueDue: (...args) => this.qqFinalRescueDue(...args),
      qqFinalRescueOwnerPending: (...args) => this.qqFinalRescueOwnerPending(...args),
      readMcpScopes: () => this.readMcpScopes(),
      refreshMcpStatusFromBroker: () => this.refreshMcpStatusFromBroker(),
      resolveEntry: () => this.resolveEntry(),
      resolveWorkspaceHandshakeCreds: () => this.resolveWorkspaceHandshakeCreds(),
      chunkText: (content) => ChatPanel.chunkText(content),
      sendPrompt: (text, images, files, contexts, options) => this.sendPrompt(text, images, files, contexts, options),
    });
  }
  /** QqHost owns the entire QQ runtime (阶段 5). All state fields below are
   * compatibility accessors onto that single instance — the Map/Set/Timer
   * objects are created and cleared only inside QqHost, never split across
   * the panel. Existing tests that poke `panel.qq*` keep working unchanged. */
  private readonly qqHost: QqHost;

  get qq() { return this.qqHost.qq; }
  set qq(value: typeof this.qqHost.qq) { this.qqHost.qq = value; }
  get qqInjectAborts() { return this.qqHost.qqInjectAborts; }
  get qqInjectedTaskId() { return this.qqHost.qqInjectedTaskId; }
  set qqInjectedTaskId(value: typeof this.qqHost.qqInjectedTaskId) { this.qqHost.qqInjectedTaskId = value; }
  get qqTakeoverActive() { return this.qqHost.qqTakeoverActive; }
  set qqTakeoverActive(value: typeof this.qqHost.qqTakeoverActive) { this.qqHost.qqTakeoverActive = value; }
  get qqTakeoverSessionId() { return this.qqHost.qqTakeoverSessionId; }
  set qqTakeoverSessionId(value: typeof this.qqHost.qqTakeoverSessionId) { this.qqHost.qqTakeoverSessionId = value; }
  get qqTakeoverToastId() { return this.qqHost.qqTakeoverToastId; }
  set qqTakeoverToastId(value: typeof this.qqHost.qqTakeoverToastId) { this.qqHost.qqTakeoverToastId = value; }
  get qqRemoteDetachedSessions() { return this.qqHost.qqRemoteDetachedSessions; }
  get qqMainFinalAwaiters() { return this.qqHost.qqMainFinalAwaiters; }
  get qqMainFinalAwaiterSince() { return this.qqHost.qqMainFinalAwaiterSince; }
  get qqFinalRescueText() { return this.qqHost.qqFinalRescueText; }
  get qqReportFallbackText() { return this.qqHost.qqReportFallbackText; }
  get qqFinalRescueDefers() { return this.qqHost.qqFinalRescueDefers; }
  get qqFinalRescueProgressAt() { return this.qqHost.qqFinalRescueProgressAt; }
  get qqFinalRescueTimer() { return this.qqHost.qqFinalRescueTimer; }
  set qqFinalRescueTimer(value: typeof this.qqHost.qqFinalRescueTimer) { this.qqHost.qqFinalRescueTimer = value; }
  get qqDelegationGraceMs() { return this.qqHost.qqDelegationGraceMs; }
  set qqDelegationGraceMs(value: typeof this.qqHost.qqDelegationGraceMs) { this.qqHost.qqDelegationGraceMs = value; }
  get qqFinalRescueMs() { return this.qqHost.qqFinalRescueMs; }
  set qqFinalRescueMs(value: typeof this.qqHost.qqFinalRescueMs) { this.qqHost.qqFinalRescueMs = value; }
  get qqFinalHardRescueMs() { return this.qqHost.qqFinalHardRescueMs; }
  set qqFinalHardRescueMs(value: typeof this.qqHost.qqFinalHardRescueMs) { this.qqHost.qqFinalHardRescueMs = value; }
  get qqMainQuestionIds() { return this.qqHost.qqMainQuestionIds; }
  get qqTaskBySuperSession() { return this.qqHost.qqTaskBySuperSession; }
  get qqTaskFinalText() { return this.qqHost.qqTaskFinalText; }
  get qqStopping() { return this.qqHost.qqStopping; }
  set qqStopping(value: typeof this.qqHost.qqStopping) { this.qqHost.qqStopping = value; }
  get qqConnected() { return this.qqHost.qqConnected; }
  set qqConnected(value: typeof this.qqHost.qqConnected) { this.qqHost.qqConnected = value; }
  get qqLastDetail() { return this.qqHost.qqLastDetail; }
  set qqLastDetail(value: typeof this.qqHost.qqLastDetail) { this.qqHost.qqLastDetail = value; }
  get qqRestartTimer() { return this.qqHost.qqRestartTimer; }
  set qqRestartTimer(value: typeof this.qqHost.qqRestartTimer) { this.qqHost.qqRestartTimer = value; }
  get qqStarting() { return this.qqHost.qqStarting; }
  set qqStarting(value: typeof this.qqHost.qqStarting) { this.qqHost.qqStarting = value; }
  get qqChannelStarting() { return this.qqHost.qqChannelStarting; }
  set qqChannelStarting(value: typeof this.qqHost.qqChannelStarting) { this.qqHost.qqChannelStarting = value; }
  get qqHealthRestarts() { return this.qqHost.qqHealthRestarts; }
  set qqHealthRestarts(value: typeof this.qqHost.qqHealthRestarts) { this.qqHost.qqHealthRestarts = value; }
  get qqSettingsSyncTimer() { return this.qqHost.qqSettingsSyncTimer; }
  set qqSettingsSyncTimer(value: typeof this.qqHost.qqSettingsSyncTimer) { this.qqHost.qqSettingsSyncTimer = value; }
  get qqbotBinding() { return this.qqHost.qqbotBinding; }
  set qqbotBinding(value: typeof this.qqHost.qqbotBinding) { this.qqHost.qqbotBinding = value; }
  get qqPendingUsers() { return this.qqHost.qqPendingUsers; }
  set qqPendingUsers(value: typeof this.qqHost.qqPendingUsers) { this.qqHost.qqPendingUsers = value; }
  get qqPendingDropToastAt() { return this.qqHost.qqPendingDropToastAt; }
  get qqGeneration() { return this.qqHost.qqGeneration; }
  set qqGeneration(value: typeof this.qqHost.qqGeneration) { this.qqHost.qqGeneration = value; }
  /**
   * 待「让智能体合并」的子会话队列。
   *
   * 自动集成没能把改动带回主分支时，宿主自动把子会话排进来（不再等用户点
   * 看板上的按钮）；主会话正忙时留在队列里，等它空闲后**串行**派发合并
   * 子会话 —— 合并必须发生在主工作区里，并发合并同一个仓库会把状态搅乱。
   */
  get pendingSuperMerges(): SuperAgentHost["pendingSuperMerges"] { return this.superHost.pendingSuperMerges; }
  set pendingSuperMerges(value: SuperAgentHost["pendingSuperMerges"]) { this.superHost.pendingSuperMerges = value; }
  /** 合并队列正在跑（drain 的重入锁）。 */
  get superMergeRunning(): SuperAgentHost["superMergeRunning"] { return this.superHost.superMergeRunning; }
  set superMergeRunning(value: SuperAgentHost["superMergeRunning"]) { this.superHost.superMergeRunning = value; }
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
  get superScan(): SuperAgentHost["superScan"] { return this.superHost.superScan; }
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
  get superDispatchedDirectives(): SuperAgentHost["superDispatchedDirectives"] { return this.superHost.superDispatchedDirectives; }
  /** {@link superDispatchedDirectives} 的容量上限（同 `superToolCallActionsDone` 的做法）。 */
  /**
   * 已为「名字命中但载荷取不出来」的结构化工具调用弹过提示的 toolCallId。
   *
   * 模型把派发写成 `super-agent` / `super-agent-actions` 工具调用时，内核
   * registry 里根本没有这两个工具 —— 旧实现既不执行也不提示，用户以为已经
   * 派了。兜底解析失败要留痕，但同一条工具帧会在 pending / in_progress /
   * completed 之间来回推，按 toolCallId 去重才不会刷屏。集合有上限（超了丢
   * 最早一条），换会话 / 恢复会话 / 热重认证时清空。
   */
  get superToolCallWarned(): SuperAgentHost["superToolCallWarned"] { return this.superHost.superToolCallWarned; }
  /** {@link superToolCallWarned} 的容量上限（工具帧数量不设界，Set 必须有界）。 */
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
  get superToolCallActionsDone(): SuperAgentHost["superToolCallActionsDone"] { return this.superHost.superToolCallActionsDone; }
  /** {@link superToolCallActionsDone} 的容量上限。 */
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
  get superToolCallOutcomes(): SuperAgentHost["superToolCallOutcomes"] { return this.superHost.superToolCallOutcomes; }
  /** {@link superToolCallOutcomes} 的容量上限（工具帧数量不设界，Map 必须有界）。 */
  /**
   * 同一个主会话、同一轮里最多发几次「super-agent 参数纠错提示」。
   *
   * 工具层现在会抛错让模型自己修，宿主这条 hidden prompt 是兜底：两者叠加
   * 若不加限次，模型坚持写同样的错误参数时宿主会无限喂纠错回合。2 次足够
   * 覆盖「模型没读懂错误 / 换一种写法又错」两种情况，之后只留 toast ——
   * 把决定权交回用户，而不是让面板自转。
   */
  /**
   * 当前轮次已发出的纠错提示数（key = 主会话 id）。
   *
   * 「一轮」以用户下一次主动发消息为界（`sendPrompt` 的 !internal && !hidden
   * 分支清掉本条记录）；宿主自己投的 hidden 回合不重置 —— 否则纠错提示自己
   * 触发的新一轮会重新获得配额，限次形同虚设。换会话 / 恢复会话 / 热重认证
   * 时由 {@link resetSuperDirectiveScans} 清空。
   */
  get superToolCallCorrections(): SuperAgentHost["superToolCallCorrections"] { return this.superHost.superToolCallCorrections; }
  /**
   * 等待主会话空闲的纠错提示（hidden prompt）。
   *
   * 工具调用必然发生在主会话生成中，所以入队时几乎总是忙的；投递复用子会话
   * 汇报那条「排队等空闲」的车道（`drainSuperToolCallCorrections`，与汇报/
   * 动作回执互斥执行）。每条带归属主会话：排队期间用户切了会话，A 的纠错
   * 提示不能投进 B 的对话。
   */
  get pendingSuperToolCallCorrections(): SuperAgentHost["pendingSuperToolCallCorrections"] { return this.superHost.pendingSuperToolCallCorrections; }
  set pendingSuperToolCallCorrections(value: SuperAgentHost["pendingSuperToolCallCorrections"]) { this.superHost.pendingSuperToolCallCorrections = value; }
  /**
   * 合并 drain 的一次性唤醒定时器（见 drainSuperMerges）。
   *
   * 合并队列的派发与汇报车道互锁：一次派发没成功时不能只等外部回调 ——
   * 合并子会话可能压根没派出去，于是永远不会有人回调。这个定时器在下一拍
   * 自己再叫一次 drain，心跳之外多一道保险；有定时器在就不再叠加新的。
   */
  get superMergeWakeupTimer(): SuperAgentHost["superMergeWakeupTimer"] { return this.superHost.superMergeWakeupTimer; }
  set superMergeWakeupTimer(value: SuperAgentHost["superMergeWakeupTimer"]) { this.superHost.superMergeWakeupTimer = value; }
  /**
   * Rolling buffer of the same MAIN-session text, scanned for management
   * actions (`super-agent-actions` fenced blocks). Kept separate from the
   * delegation buffer: the two protocols have independent fences and
   * independent consume offsets, so one can never swallow the other.
   */
  get superActionScanText(): SuperAgentHost["superActionScanText"] { return this.superHost.superActionScanText; }
  set superActionScanText(value: SuperAgentHost["superActionScanText"]) { this.superHost.superActionScanText = value; }
  /** How much of `superActionScanText` has already been executed. */
  get superActionScanOffset(): SuperAgentHost["superActionScanOffset"] { return this.superHost.superActionScanOffset; }
  set superActionScanOffset(value: SuperAgentHost["superActionScanOffset"]) { this.superHost.superActionScanOffset = value; }
  /**
   * 本轮还有一个动作围栏停在「未闭合」状态（围栏开了没收）。
   *
   * 流式期间这是正常中间态（载荷可能下一帧才到），所以不在每帧报警；
   * 但**回合都结束了还停在这里**，说明这个动作块永远不会被执行 ——
   * 旧实现对此完全静默（零日志、零 toast），故障只能靠用户复述「我发过啊」。
   * 回合收尾时用它复核并留痕（见 `auditSuperActionsAtSettle`）。
   */
  get superActionPending(): SuperAgentHost["superActionPending"] { return this.superHost.superActionPending; }
  set superActionPending(value: SuperAgentHost["superActionPending"]) { this.superHost.superActionPending = value; }
  /** 未闭合围栏里那段没收完的正文（日志用，别让痕迹变成一句空话）。 */
  get superActionPendingBody(): SuperAgentHost["superActionPendingBody"] { return this.superHost.superActionPendingBody; }
  set superActionPendingBody(value: SuperAgentHost["superActionPendingBody"]) { this.superHost.superActionPendingBody = value; }
  /**
   * 最后一条已排队的动作回执文本（去重）。
   *
   * 回执是投给主会话的一次 hidden prompt；同一份回执重复排队会让主会话
   * 反复收到一模一样的「已生效」，白白多跑几轮。
   */
  get superActionReceiptLast(): SuperAgentHost["superActionReceiptLast"] { return this.superHost.superActionReceiptLast; }
  set superActionReceiptLast(value: SuperAgentHost["superActionReceiptLast"]) { this.superHost.superActionReceiptLast = value; }
  /**
   * 「扫到围栏却零动作」的告警是否已经记过（去重）。
   *
   * 这条通道每来一段文本都会扫一次，不去重就是同一个问题刷一屏日志。
   */
  get superActionZeroWarned(): SuperAgentHost["superActionZeroWarned"] { return this.superHost.superActionZeroWarned; }
  set superActionZeroWarned(value: SuperAgentHost["superActionZeroWarned"]) { this.superHost.superActionZeroWarned = value; }
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
  get pendingSuperReports(): SuperAgentHost["pendingSuperReports"] { return this.superHost.pendingSuperReports; }
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
  get pendingSuperReportPrompts(): SuperAgentHost["pendingSuperReportPrompts"] { return this.superHost.pendingSuperReportPrompts; }
  set pendingSuperReportPrompts(value: SuperAgentHost["pendingSuperReportPrompts"]) { this.superHost.pendingSuperReportPrompts = value; }
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
  get pendingSuperActionReceipts(): SuperAgentHost["pendingSuperActionReceipts"] { return this.superHost.pendingSuperActionReceipts; }
  set pendingSuperActionReceipts(value: SuperAgentHost["pendingSuperActionReceipts"]) { this.superHost.pendingSuperActionReceipts = value; }
  /** 汇报 turn 正在跑（drain 的重入锁，与合并队列互斥）。 */
  get superReportRunning(): SuperAgentHost["superReportRunning"] { return this.superHost.superReportRunning; }
  set superReportRunning(value: SuperAgentHost["superReportRunning"]) { this.superHost.superReportRunning = value; }
  /** 轮转游标：下一次仲裁从 {@link SUPER_AUTO_TURN_PRIORITY} 的哪一位起步。 */
  get superAutoTurnCursor(): SuperAgentHost["superAutoTurnCursor"] { return this.superHost.superAutoTurnCursor; }
  set superAutoTurnCursor(value: SuperAgentHost["superAutoTurnCursor"]) { this.superHost.superAutoTurnCursor = value; }
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
  get mainLane(): SuperAgentHost["mainLane"] { return this.superHost.mainLane; }
  set mainLane(value: SuperAgentHost["mainLane"]) { this.superHost.mainLane = value; }
  /**
   * 等待子会话的心跳。
   *
   * 主会话回合结束后只剩子会话在跑时，没有任何协议事件会再次唤醒主会话；
   * 这个定时器负责 ①维持「等待 N 个子会话」的常驻提示 ②一旦主会话空闲就把
   * 排队的汇报 / 合并请求发出去。没有待办且没有活着的子会话时自动停表。
   */
  get superHeartbeatTimer(): SuperAgentHost["superHeartbeatTimer"] { return this.superHost.superHeartbeatTimer; }
  set superHeartbeatTimer(value: SuperAgentHost["superHeartbeatTimer"]) { this.superHost.superHeartbeatTimer = value; }
  /** 常驻「等待子会话」提示的 toast id（null = 当前没显示）。 */
  get superWaitToastId(): SuperAgentHost["superWaitToastId"] { return this.superHost.superWaitToastId; }
  set superWaitToastId(value: SuperAgentHost["superWaitToastId"]) { this.superHost.superWaitToastId = value; }
  /** 常驻提示的状态指纹：子会话进度帧高频触发，指纹不变就不重发。 */
  get superWaitToastKey(): SuperAgentHost["superWaitToastKey"] { return this.superHost.superWaitToastKey; }
  set superWaitToastKey(value: SuperAgentHost["superWaitToastKey"]) { this.superHost.superWaitToastKey = value; }
  /** 「已停止 · N 项待处理」常驻带动作提示的 toast id（null = 当前没显示）。 */
  get deferredAutoTurnsToastId(): SuperAgentHost["deferredAutoTurnsToastId"] { return this.superHost.deferredAutoTurnsToastId; }
  set deferredAutoTurnsToastId(value: SuperAgentHost["deferredAutoTurnsToastId"]) { this.superHost.deferredAutoTurnsToastId = value; }
  /**
   * 子会话归档的节流写定时器（null = 没有待写的节流写）。
   *
   * 归档的写放大主要来自高频的进度帧：看板每变一次就整份重写一次，而进度
   * 根本不在归档里。关键变更（终态 / 改动去向 / 归属）仍然立刻写。
   */
  get superArchiveTimer(): SuperAgentHost["superArchiveTimer"] { return this.superHost.superArchiveTimer; }
  set superArchiveTimer(value: SuperAgentHost["superArchiveTimer"]) { this.superHost.superArchiveTimer = value; }
  /**
   * 上次落盘时的归档「关键内容」指纹。
   *
   * 指纹变了 = 有必须立刻落盘的变化（子会话集合 / 状态 / 集成结果 / 归属）；
   * 指纹没变 = 只有展示性字段变了，节流写即可。
   */
  get superArchiveFingerprint(): SuperAgentHost["superArchiveFingerprint"] { return this.superHost.superArchiveFingerprint; }
  set superArchiveFingerprint(value: SuperAgentHost["superArchiveFingerprint"]) { this.superHost.superArchiveFingerprint = value; }
  /**
   * 后台残留 worktree 清扫的在飞标记。
   *
   * 清扫**不在**会话恢复 / 新建会话的关键路径上（见
   * `sweepStaleWorktreesInBackground`）；这个闸门只保证同一时刻最多一份在跑，
   * 切会话 / 反复恢复不会叠出多条 `git status` 子进程链。
   */
  get sweepInFlight(): SuperAgentHost["sweepInFlight"] { return this.superHost.sweepInFlight; }
  set sweepInFlight(value: SuperAgentHost["sweepInFlight"]) { this.superHost.sweepInFlight = value; }
  /**
   * 后台残留清扫的延时（ms）。恢复会话时 CLI 正在跑 session/new、
   * loadSession 与 MCP 发现，此刻三类 sweep 一起读盘 / 跑 git 会争抢 I/O，
   * 拖慢恢复（2026-11-19 用户实测）。延时到恢复窗口之后再触发，值 0 供测试
   * 立即触发验证「清扫挂住也不阻塞恢复」。
   */
  get superSweepDelayMs(): SuperAgentHost["superSweepDelayMs"] { return this.superHost.superSweepDelayMs; }
  set superSweepDelayMs(value: SuperAgentHost["superSweepDelayMs"]) { this.superHost.superSweepDelayMs = value; }
  /**
   * 已经把汇报交给宿主的子会话 id。
   *
   * 子会话进入终态（completed / failed / cancelled）之后，宿主还要等它把汇报
   * 交上来 —— 中间隔着宿主代提交与自动合并（git 操作，可能好几秒）。这段时间
   * 里子会话「已经终态」但汇报还没进汇报队列，所以「还在等」不能只看子会话
   * 状态：终态但没交接汇报的子会话同样算未完成。
   */
  get superReportedChildIds(): SuperAgentHost["superReportedChildIds"] { return this.superHost.superReportedChildIds; }
  /**
   * 每个子会话上一次被宿主看到的 SuperStatus（key = childId）。
   *
   * 完成提示按**子会话逐个**判定：只有「上一次非终态、这一次终态」才是真实
   * 的收尾事件。旧的聚合实现（非终态数 >0 → 0 时提示「子会话已全部结束」）
   * 把两个子会话的完成混成一次、还会在恢复归档/刚打开看板时把早已终态的
   * 事实当成新事件；按 id 记状态后：首次看到就终态 = 没有事件（不提示）、
   * 重复 sync = 状态没变（不重复提示）、子会话从 list 消失 = 清记录。
   */
  get superLastStatus(): SuperAgentHost["superLastStatus"] { return this.superHost.superLastStatus; }
  set superLastStatus(value: SuperAgentHost["superLastStatus"]) { this.superHost.superLastStatus = value; }
  /**
   * 本轮用户消息的附件（图片 base64 + 带路径的文件）。子会话看不到对话，委派
   * 发生时若不带上它们，用户附的截图/日志会在子任务里静默消失。只在本轮流式
   * 期间有效：回合结束即清空，避免下一次派发拿到上一轮的旧附件。
   */
  get currentTurnAttachments(): SuperAgentHost["currentTurnAttachments"] { return this.superHost.currentTurnAttachments; }
  set currentTurnAttachments(value: SuperAgentHost["currentTurnAttachments"]) { this.superHost.currentTurnAttachments = value; }
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
  get pendingDelegatedUserTurns(): SuperAgentHost["pendingDelegatedUserTurns"] { return this.superHost.pendingDelegatedUserTurns; }
  set pendingDelegatedUserTurns(value: SuperAgentHost["pendingDelegatedUserTurns"]) { this.superHost.pendingDelegatedUserTurns = value; }
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
  get pendingSuperResidueConfirms(): SuperAgentHost["pendingSuperResidueConfirms"] { return this.superHost.pendingSuperResidueConfirms; }
  get superResidueConfirmSeq(): SuperAgentHost["superResidueConfirmSeq"] { return this.superHost.superResidueConfirmSeq; }
  set superResidueConfirmSeq(value: SuperAgentHost["superResidueConfirmSeq"]) { this.superHost.superResidueConfirmSeq = value; }
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
  get autoTurnsStoppedFor(): SuperAgentHost["autoTurnsStoppedFor"] { return this.superHost.autoTurnsStoppedFor; }
  set autoTurnsStoppedFor(value: SuperAgentHost["autoTurnsStoppedFor"]) { this.superHost.autoTurnsStoppedFor = value; }
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
   * M3 P0-1: shadow-git snapshotter (阶段 4 下沉到 CheckpointService).
   * All checkpoint state (manager / warning gates / index chain / pending
   * re-anchor index) now lives in that service; the panel keeps a single
   * instance and same-named thin delegates for unchanged call sites.
   */
  private readonly checkpointService: CheckpointService;
  /**
   * Session restore + session-list GC (阶段 4 下沉到 SessionRestoreService).
   * Uses stage 3's SessionPersistenceService via injection, never a second
   * instance; all shared panel state is read/written through callbacks.
   */
  private readonly sessionRestoreService: SessionRestoreService;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly services: PanelServices = {},
  ) {
    this.log = vscode.window.createOutputChannel(vscode.l10n.t("心流·驭光"), { log: true });
    // SuperAgentHost (阶段 6): construct eagerly so `this` is bound to this panel;
    // all callbacks read panel state at CALL TIME (never a stale snapshot).
    this._superHost = this.buildSuperHost();
    this.qqHost = new QqHost({
      log: { info: (m) => this.log.info(m), warn: (m) => this.log.warn(m) },
      getContext: () => this.context,
      getServices: () => this.services,
      getStore: () => this.store,
      isDisposed: () => this.disposed,
      getClient: () => this.client,
      getPendingQuestions: () => this.pendingQuestions,
      getPendingSuperReportPrompts: () => this.pendingSuperReportPrompts,
      isSuperReportRunning: () => this.superReportRunning,
      getSuperRepoRoot: () => this.superRepoRoot(),
      postToWebview: (m) => this.postToWebview(m),
      getSuperAgent: () => this.getSuperAgent(),
      requestSuperMerge: (id, options) => this.requestSuperMerge(id, options),
      sendPrompt: (text, images, files, contexts, options) => this.sendPrompt(text, images, files, contexts, options),
      sendTurnCancel: (sessionId, client) => this.sendTurnCancel(sessionId, client),
      mainSessionFree: () => this.mainSessionFree(),
      getCancelSeen: () => this.cancelSeen,
      setCancelSeen: (value) => { this.cancelSeen = value; },
      pushQqSettings: () => this.pushQqSettings(),
      onQqSettingsChanged: () => this.onQqSettingsChanged(),
      cancelAllQqMainInjections: () => this.cancelAllQqMainInjections(),
      waitForQqMainFree: (signal, deadline) => this.waitForQqMainFree(signal, deadline),
    });
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
    this.toolDiff = new ToolDiffService({
      log: { warn: (m) => this.log.warn(m) },
      // sessionCwd is read at call time — never pass a context-snapshot base
      // (AGENTS.md pitfall #8). Arrow wrappers preserve `this` binding.
      getSessionCwd: () => this.sessionCwd,
      getWorkspaceRoots: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      getExtensionPath: () => this.context.extensionUri.fsPath,
      resolvePath: (p) => this.resolveAgentPathToAbsolute(p),
      getState: () => this.store.getState(),
      post: (m) => this.postToWebview(m),
      toolDiffSynthesized: (id, diff) => { this.store.toolDiffSynthesized(id, diff); },
      toolReverted: (id) => { this.store.toolReverted(id); },
      toolHunkDecisions: (id, decisions, partial) => { this.store.toolHunkDecisions(id, decisions, partial); },
      toolArgs: this.toolArgs,
      preSnapshots: this.preSnapshots,
      toolArgsCap: ChatPanel.TOOL_ARGS_CAP,
    });
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
    this.persistence = new SessionPersistenceService({
      log: { info: (m) => this.log.info(m), warn: (m) => this.log.warn(m) },
      // storageUri / sessionCwd are read at call time — never pass a snapshot
      // base (AGENTS.md pitfall #8). Arrow wrappers preserve `this` binding.
      getStorageDir: () => (this.context.storageUri ?? this.context.globalStorageUri).fsPath,
      getSessionCwd: () => this.sessionCwd,
      getWorkspaceState: () => this.context.workspaceState,
      defaultSessionLabel: DEFAULT_SESSION_LABEL,
      sessionsKey: SESSIONS_KEY,
      activeSessionKey: ACTIVE_SESSION_KEY,
      maxRecentSessions: MAX_RECENT_SESSIONS,
    });
    // 阶段 4: checkpoint + restore 服务。所有 path base 与共享状态都在调用时
    // 通过箭头回调读取（陷阱 #8：sessionCwd，不是 process.cwd()），绝不把
    // 构造时刻的快照传进去；SessionPersistenceService 直接复用上面注入的实例。
    this.checkpointService = new CheckpointService({
      log: { info: (m) => this.log.info(m), warn: (m) => this.log.warn(m) },
      getState: () => this.store.getState(),
      setCheckpoints: (checkpoints) => this.store.setCheckpoints(checkpoints),
      sendToast: (level, message, opts) => { this.store.sendToast(level, message, opts); },
      appendNotice: (text) => this.store.appendNotice(text),
      isDisposed: () => this.disposed,
      isHistorySyncBusy: () => this.historySyncBusy,
      getSessionCwd: () => this.sessionCwd,
      getWorkspaceRoot: () => this.services.workspaceRoot ?? null,
      getExtensionPath: () => this.context.extensionUri.fsPath,
      getStorageDir: () => (this.context.storageUri ?? this.context.globalStorageUri).fsPath,
      deleteUserMessage: (id, reason) => this.deleteUserMessage(id, reason),
    });
    this.sessionRestoreService = new SessionRestoreService({
      log: { info: (m) => this.log.info(m), warn: (m) => this.log.warn(m), error: (m) => this.log.error(m) },
      isHistorySyncBusy: () => this.historySyncBusy,
      isDroppingForReset: () => this.droppingForReset,
      isDisposed: () => this.disposed,
      getSessionCwd: () => this.sessionCwd,
      setSessionCwd: (cwd) => { this.sessionCwd = cwd; },
      getWorkspaceRoot: () => this.services.workspaceRoot ?? null,
      getExtensionPath: () => this.context.extensionUri.fsPath,
      isRestoring: () => this.restoring,
      setRestoring: (value) => { this.restoring = value; },
      getRestoringSessionId: () => this.restoringSessionId,
      setRestoringSessionId: (id) => { this.restoringSessionId = id; },
      getReplayTitle: () => this.replayTitle,
      setReplayTitle: (value) => { this.replayTitle = value; },
      isRestoreAbort: () => this.restoreAbort,
      setRestoreAbort: (value) => { this.restoreAbort = value; },
      isPendingNewSession: () => this.pendingNewSession,
      setPendingNewSession: (value) => { this.pendingNewSession = value; },
      getLastRestoreOutcome: () => this.lastRestoreOutcome,
      setLastRestoreOutcome: (value) => { this.lastRestoreOutcome = value; },
      getRestoreSettle: () => this.restoreSettle,
      setRestoreSettle: (value) => { this.restoreSettle = value; },
      getAbandonedRestoreIds: () => this.abandonedRestoreSessionIds,
      getContextReportBaseline: () => this.contextReportBaseline,
      setContextReportBaseline: (value) => { this.contextReportBaseline = value; },
      getPendingSwitchModel: () => this.pendingSwitchModel,
      setPendingSwitchModel: (value) => { this.pendingSwitchModel = value; },
      getWorkspaceActiveSessionId: () => this.context.workspaceState.get<string | null>(ACTIVE_SESSION_KEY, null),
      getState: () => this.store.getState(),
      replaceState: (state) => this.store.replaceState(state),
      setInitializing: (value) => this.store.setInitializing(value),
      replaceTranscript: (blocks) => this.store.replaceTranscript(blocks),
      sessionStarted: (meta) => this.store.sessionStarted(meta),
      markError: (message) => this.store.markError(message),
      sendToast: (level, message) => { this.store.sendToast(level, message); },
      setSessions: (sessions, activeId) => this.store.setSessions(sessions, activeId),
      persistence: this.persistence,
      migrateLegacyTranscripts: () => this.migrateLegacyTranscripts(),
      readPersistedSessions: () => this.readPersistedSessions(),
      persistSessions: (sessions, activeId) => this.persistSessions(sessions, activeId),
      listOwnTranscriptFileNames: () => this.listOwnTranscriptFileNames(),
      loadCheckpointIndex: (id) => this.loadCheckpointIndex(id),
      finalizeCheckpointIndex: (remap) => this.finalizeCheckpointIndex(remap),
      checkpointRoot: () => this.checkpointRoot(),
      clearQqTakeover: () => this.clearQqTakeover(),
      clearQqRemoteDetachedSessions: () => this.clearQqRemoteDetachedSessions(),
      hasPersistedTranscript: (id) => this.hasPersistedTranscript(id),
      forgetSession: (id) => this.forgetSession(id),
      ensureClient: () => this.ensureClient(),
      queryLiveModels: () => this.queryLiveModels(),
      publishSuperSessions: () => this.publishSuperSessions(),
      resetSuperDirectiveScans: () => this.resetSuperDirectiveScans(),
      getMainSessionSettings: (addDirs) => mainSessionSettings(addDirs),
      /** 多仓库协作：按某个会话已存的根集合算 add_dirs（恢复用）。 */
      sessionAddDirsFor: (roots) => {
        const all = this.workspaceRootInfos();
        if (all.length <= 1) return null;
        const cwd = this.services.workspaceRoot ?? all[0]?.path ?? null;
        return buildAddDirs(roots, all, cwd);
      },
      /** 多仓库协作：恢复完成后发布根子集投影。 */
      publishWorkspaceRoots: (applied) => this.publishWorkspaceRoots(applied),
      loadPersistedTranscript: (id) => this.loadPersistedTranscript(id),
      workspaceModelId: () => this.workspaceModelId(),
      applyLiveModels: (models, client, id, cliModelId) => this.applyLiveModels(models, client, id, cliModelId),
      validateModelForPush: (models, id, fallback) => this.validateModelForPush(models, id, fallback),
      setModel: (id) => this.setModel(id),
      applyThinkLevel: (client, id, level) => this.applyThinkLevel(client, id, level),
      cleanupEmptySession: (id) => this.cleanupEmptySession(id),
      recordSession: (id, label, roots) => this.recordSession(id, label, roots),
      persistActiveTranscript: (force) => { void this.persistActiveTranscript(force); },
      restoreSuperSessions: (id) => this.restoreSuperSessions(id),
      postSound: (kind) => this.postSound(kind),
      superStoreDir: () => this.superStoreDir(),
    });
    this.statusPresenter = new StatusPresenter();
    this.statusBar = this.statusPresenter.statusBar;
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
    // 多仓库协作：每个工作区根都要监听 —— 只监听第一个根会让其它根的新建/
    // 删除文件永远不刷新缓存（搜索结果陈旧）。
    const watchRoots = this.workspaceRootInfos();
    const invalidateFileCache = () => {
      this.fileSearchCache = null;
    };
    if (this.services.watchers && this.services.watchers.length > 0) {
      for (const watcher of this.services.watchers) {
        watcher.onDidCreate(invalidateFileCache);
        watcher.onDidDelete(invalidateFileCache);
        this.context.subscriptions.push(watcher);
      }
    } else {
      const uris =
        watchRoots.length > 0
          ? watchRoots.map((root) => vscode.Uri.file(root.path))
          : [this.context.extensionUri];
      for (const uri of uris) {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(uri, "**/*"));
        watcher.onDidCreate(invalidateFileCache);
        watcher.onDidDelete(invalidateFileCache);
        this.context.subscriptions.push(watcher);
      }
    }
    // 根集合增减（多根工作区增删文件夹）：缓存作废 + 投影刷新。当前会话的
    // CLI 上下文不动（它已经建立，改根需要新建会话）。
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.fileSearchCache = null;
        this.publishWorkspaceRoots();
      }),
    );
    // 启动即发布一次投影：多根工作区在首个会话建立前也能看到根选择器。
    this.publishWorkspaceRoots();
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

  /** Thin delegate (阶段 2): all status-bar rendering lives in StatusPresenter.
   * The signature is unchanged — the store's `onStateChange` callback and the
   * tests that call `panel.updateStatusBar(state)` keep their contract. */
  private updateStatusBar(state: SessionState): void {
    this.statusPresenter.update(state);
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
    for (const controller of this.qqHost.qqInjectAborts.values()) controller.abort();
    this.qqHost.qqInjectAborts.clear();
    this.qqHost.qqInjectedTaskId = null;
    // 远程接续是纯内存态：宿主销毁时必须清冻结态并撤掉常驻 toast。
    this.clearQqTakeover();
    this.clearQqRemoteDetachedSessions();
    this.stopQqFinalRescueTimer();
    this.qqHost.qqMainFinalAwaiters.clear();
    this.qqHost.qqMainFinalAwaiterSince.clear();
    this.qqHost.qqFinalRescueText.clear();
    this.qqHost.qqReportFallbackText.clear();
    this.qqHost.qqFinalRescueDefers.clear();
    this.qqHost.qqFinalRescueProgressAt.clear();
    this.qqHost.qqTaskBySuperSession.clear();
    this.qqHost.qqTaskFinalText.clear();
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
    if (this.qqHost.qqSettingsSyncTimer) {
      clearTimeout(this.qqHost.qqSettingsSyncTimer);
      this.qqHost.qqSettingsSyncTimer = null;
    }
    if (this.qqHost.qqRestartTimer) {
      clearTimeout(this.qqHost.qqRestartTimer);
      this.qqHost.qqRestartTimer = null;
    }
    this.diagBaselineErrors = null;
    // QQ 通道：bridge 进程、宿主 IPC 监听与任务服务必须一起收掉 —— 否则窗口
    // 关闭后会留下一个孤立的 node 进程和占用的端口。最多等 2s（见
    // QQ_BRIDGE_STOP_TIMEOUT_MS），关闭流程不能被一个卡住的 socket 拖死。
    await this.raceQqTeardown(this.stopQq());
    this.client = null;
    this.memory.dispose();
    this.assets.dispose();
    this.toolDiff.dispose();
    this.editorPanel?.dispose();
    this.editorPanel = undefined;
    this.statusPresenter.dispose();
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
    // 降级/读取失败绝不静默：用户选了一张 8MB 截图，结果它变成文件路径，
    // 必须当场说明，否则会以为图片已经作为图片块发出去了。
    const degradedImages: string[] = [];
    const unreadableImages: string[] = [];
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
          degradedImages.push(name);
        } catch (error) {
          this.log.warn(`reading picked image failed: ${errorMessage(error)}`);
          unreadableImages.push(name);
          continue;
        }
      }
      files.push({ name, path: fsPath });
    }
    if (degradedImages.length > 0) {
      this.store.sendToast(
        "warning",
        vscode.l10n.t(
          "图片超过 {0}MB，已作为文件附件发送：{1}",
          Math.floor(ATTACHMENT_IMAGE_MAX_BYTES / 1024 / 1024),
          degradedImages.join("、"),
        ),
      );
    }
    if (unreadableImages.length > 0) {
      this.store.sendToast(
        "warning",
        vscode.l10n.t("无法读取图片 {0}，已跳过", unreadableImages.join("、")),
      );
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
    // 阶段 7（行为不变等价重构）：消息路由按职责拆到 4 个分域分派函数。
    // 本 switch 只做域选择；每个 case 的处理代码逐字保留在对应分派函数内。
    // test/panel-message-routing.test.ts 固化了全部 case 类型的完整清单。
    switch (msg.type) {
      // --- 会话 / 宿主通用（含设置、MCP、资源、记忆、附件、模型与 Profile） ---
      case "ready":
      case "sendPrompt":
      case "queueAction":
      case "resolveContext":
      case "cancel":
      case "newSession":
      case "setModel":
      case "setThink":
      case "openLocation":
      case "openExternal":
      case "runInTerminal":
      case "searchFiles":
      case "setSessionRoots":
      case "stageFiles":
      case "pickAttachments":
      case "openImage":
      case "saveAuth":
      case "clearAuth":
      case "activateProfile":
      case "deleteProfile":
      case "setOnboardingDismissed":
      case "loadSession":
      case "deleteSession":
      case "setSessionFlags":
      case "renameSession":
      case "refreshAuth":
      case "refreshModels":
      case "restartCli":
      case "openSettings":
      case "setHostSettings":
      case "listMcpServers":
      case "saveMcpServers":
      case "mcpStatus":
      case "fetchModelMetadata":
      case "cancelModelMetadata":
      case "listAssets":
      case "readAsset":
      case "saveAsset":
      case "createAsset":
      case "deleteAsset":
      case "generateAsset":
      case "listMemory":
      case "readMemoryFile":
      case "saveMemoryFile":
      case "appendMemoryFact":
      case "deleteMemoryFacts":
      case "createProjectMemory":
      case "applyMemoryCandidates":
      case "dismissMemoryCandidates":
      case "openMemoryFile":
      case "generateKnowledge":
      case "setKnowledgeInjection":
      case "openKnowledgeFile":
      case "regenerate":
      case "deleteUserMessage":
      case "editAndResend":
      case "exportSession":
      case "enhancePrompt":
      case "cancelEnhance":
      case "toastAction":
      case "exportToolOutput":
        await this.handleSessionMessage(msg);
        break;
      // --- 审批 / 提问 / Plan / diff 回退确认 ---
      case "respondApproval":
      case "answerQuestions":
      case "respondProfileSwitch":
      case "revertTool":
      case "applyHunkSelection":
      case "restoreCheckpoint":
      case "requestTurnChanges":
      case "revertTurnFile":
      case "openDiff":
      case "togglePlanItem":
        await this.handleApprovalMessage(msg);
        break;
      // --- Super Agent 看板 / 动作 ---
      case "stopSubagent":
      case "superAgent":
      case "superRetryWave":
      case "superRetryFailed":
      case "requestSuperResidueList":
      case "superResidueHandle":
      case "respondSuperResidueConfirm":
        await this.handleSuperMessage(msg);
        break;
      // --- QQ ---
      case "qqSettingsPatch":
      case "qqTaskAction":
      case "qqConfigAction":
      case "qqUserAction":
      case "qqManagedSetup":
      case "qqTakeover":
        await this.handleQqMessage(msg);
        break;
      default:
        // C10: version-mismatch tripwire — a webview built from a different
        // commit can send message kinds this host does not know; without a
        // default they would be dropped silently.
        this.log.warn(`webview → host: unknown message type "${(msg as { type?: string }).type}"`);
        break;
    }
  }

  /** 会话 / 宿主通用消息域：会话生命周期、prompt、模型/思考、附件、设置、MCP、资源与记忆等宿主能力。 */
  private async handleSessionMessage(msg: WebviewToHost): Promise<void> {
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
        await this.sendPrompt(msg.text, msg.images, msg.files, msg.contexts, {
          ...(msg.imageCaptions ? { imageCaptions: msg.imageCaptions } : {}),
        });
        break;
      case "queueAction":
        this.handleQueueAction(msg);
        break;
      case "resolveContext":
        void this.resolveContext(msg.requestId, msg.kind, msg.query);
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
      case "runInTerminal":
        this.runToolInTerminal(msg.toolCallId, msg.execute);
        break;
      case "searchFiles":
        void this.searchWorkspaceFiles(msg.requestId, msg.query, msg.kind ?? "file");
        break;
      case "setSessionRoots":
        await this.setSessionRoots(msg.roots);
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
      case "saveAuth": {
        // Explicit receipt, including on an unexpected throw: without it the
        // credential editor would wait forever (or, in the old optimistic
        // design, close and throw the typed values away on failure).
        let result: { ok: boolean; error?: string };
        try {
          result = await this.saveAuthAndReconnect(
            msg.baseUrl,
            msg.apiKey,
            msg.modelName,
            msg.profileName ?? null,
            msg.replaceName ?? null,
          );
        } catch (e) {
          result = { ok: false, error: errorMessage(e) };
        }
        this.postToWebview({
          type: "saveAuthResult",
          ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}),
          ...result,
        });
        break;
      }
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
        if (typeof msg.superAgentFullTrust === "boolean") {
          writes.push(["superAgent.fullTrust", msg.superAgentFullTrust]);
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
      case "exportToolOutput":
        await this.exportToolOutput(msg.blockId);
        break;
    }
  }

  /** 审批 / 提问 / Plan / diff 回退确认消息域：所有需要用户决策的卡片回包。 */
  private async handleApprovalMessage(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case "respondApproval":
        this.handleApprovalResponse(msg.id, msg.optionId);
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
      case "togglePlanItem":
        this.store.togglePlanItem(msg.blockId, msg.index);
        break;
    }
  }

  /** Super Agent 看板 / 动作消息域：子会话派发、停止与残留清理确认。 */
  private async handleSuperMessage(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
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
      case "superRetryWave":
        await this.superHost.retrySuperWave({ runId: msg.runId, wave: msg.wave });
        break;
      case "superRetryFailed":
        await this.superHost.retrySuperFailed({ runId: msg.runId });
        break;
      case "requestSuperResidueList":
        await this.handleRequestSuperResidueList(msg.requestId);
        break;
      case "superResidueHandle":
        await this.handleSuperResidueHandle(msg);
        break;
      case "respondSuperResidueConfirm":
        this.handleSuperResidueConfirmResponse(msg.requestId, msg.confirmed);
        break;
    }
  }

  /**
   * 批次1B `requestSuperResidueList`：只读聚合残留明细，按 `requestId` 回包
   * `superResidueList`（分支清单 + 一次性 `confirmToken`）。这里只做数据整形
   * 与令牌换发；真正的 git 判定在宿主的 `listResidueItems` 里。
   */
  private async handleRequestSuperResidueList(requestId: string): Promise<void> {
    const items = await this.superHost.listSuperResidue();
    const keys = new Map<string, string>();
    const branches: SuperResidueBranchUi[] = items.map((item) => {
      // 孤儿残留没有子会话 id，回退到宿主键，保证 webview 回传时能定位。
      const uiSessionId = item.sessionId ?? item.key;
      keys.set(uiSessionId, item.key);
      return {
        sessionId: uiSessionId,
        branch: item.branch ?? "",
        worktree: item.path,
        title: item.title,
        unmerged: item.unmerged,
        worktreeExists: existsSync(item.path),
      };
    });
    const confirmToken = `super-residue-list-${++this.superResidueListSeq}`;
    this.superResidueListToken = confirmToken;
    this.superResidueListKeys = keys;
    this.postToWebview({ type: "superResidueList", requestId, branches, confirmToken });
  }

  /**
   * 批次1B `superResidueHandle`：一次性 `confirmToken` 校验后批量处置。
   *
   * - `merge`：逐条转发给宿主的 `handleSuperResidueAction`（每条派一个合并
   *   子会话，顺序执行）。
   * - `discard`：把选中的条目聚合成**一次** `handleSuperResidueDiscardBatch`
   *   —— 逐条调用会让每次丢弃确认取消上一次待确认请求，批量时只有最后一项
   *   能弹出确认框、其余被静默取消。
   *
   * 校验不过一律拒绝（旧令牌 / 未请求过清单）；丢弃的二次确认令牌与「未提交
   * 改动 / git 中间态硬拒绝」纪律完全交给宿主的 handler，这里不重写业务逻辑。
   */
  private async handleSuperResidueHandle(msg: Extract<WebviewToHost, { type: "superResidueHandle" }>): Promise<void> {
    if (!this.superResidueListToken || msg.confirmToken !== this.superResidueListToken) {
      this.log.warn("webview → host: superResidueHandle 的 confirmToken 无效（过期或未请求清单）");
      this.store.sendToast("warning", vscode.l10n.t("残留清单已过期，请重新获取后再操作"));
      return;
    }
    // 一次性：无论本次转发结果如何都立即作废，旧令牌不可复用。
    this.superResidueListToken = null;
    const keyMap = this.superResidueListKeys;
    this.superResidueListKeys = new Map();
    const ids = Array.isArray(msg.sessionIds) ? msg.sessionIds : [];
    const keys = ids.map((uiSessionId) => keyMap.get(uiSessionId) ?? uiSessionId);
    if (keys.length === 0) return;
    if (msg.action === "discard") {
      await this.superHost.handleSuperResidueDiscardBatch({ keys });
      return;
    }
    for (const key of keys) {
      await this.superHost.handleSuperResidueAction({ key, action: "merge" });
    }
  }

  /** QQ 消息域：设置、任务、授权码登录、用户动作与托管/接管。 */
  private async handleQqMessage(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
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
      superAgentFullTrust: config.get<boolean>("superAgent.fullTrust", false),
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
    const decision = this.evaluateOsNotification(event, text, setting);
    if (!decision.fire) return decision;
    void this.deliverOsNotification(text);
    return decision;
  }

  /**
   * Pure gate evaluation + gate bookkeeping — shared by the local OS toast and
   * the remote-takeover QQ cue. The takeover cue borrows the same throttle and
   * content cooldown (a burst of child completions must not spam QQ) but must
   * NOT deliver a local toast, which is why the decision and the delivery are
   * separated here.
   */
  private evaluateOsNotification(
    event: OsNotifyEvent,
    text: string,
    setting: string,
  ): OsNotifyDecision {
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
    if (gate.fire) this.osNotifyGate = gate.gate;
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
   * QQ 远程接管态(2026-11-19 静音 / 2026-11-20 改投 QQ):接管时用户已离开本机,
   * 本机不再弹 OS toast、不响 done/child 音 —— 但提示不能就此消失:QQ 任务自己的
   * 回执有专属通道(`deliverQqMainFinalAnswer` / 中间正文),而**本地发起的任务**
   * 没有 QQ 任务归属,只静音就等于一条通知都收不到(用户实测)。因此接管态下
   * 这条统一出口把提示改投到绑定者私聊({@link forwardTakeoverCue})。
   * 切勿上移到 sendPrompt 收尾的 finalReport 块:那里还放着 QQ 转发调用,误伤会让
   * 远程用户永远收不到最终答复。错误音 `postSound("error")` 不经此出口,保持原样。
   */
  private announceCue(event: OsNotifyEvent, text: string, kind: "done" | "child"): void {
    // 远程接管态：本机静音，反馈只走 QQ（用户已离开本机）。
    //
    // 旧实现在这里直接 return —— 本机确实静音了，但「QQ 转发」只覆盖 QQ 任务
    // 自己的回执；**本地发起的任务没有 QQ 任务可归属**，于是接管期间一条通知
    // 都收不到（2026-11-20 用户实测：任务进行中才开启远程接续，此后的通知在
    // QQ 上全部消失）。现在把这条完成提示改投到绑定者私聊，本机仍然不发
    // toast、不响铃。
    //
    // 去重沿用同一道 OS 通知闸门，但以 `all` 档评估：`osNotifications` 档位管
    // 的是本机 OS toast，与 QQ 提示无关；这里只借闸门的节流 + 内容冷却两条
    // 去重规则。判定与 chime 同源 —— **只有重复才丢弃**：watching / focus 在
    // 本机只是「不弹 toast」，chime 照响；接管态下 QQ 就是那条唯一的提示通道，
    // 若因为「窗口有焦点」就吞掉，用户会彻底静默。
    if (this.qqHost.qqTakeoverActive) {
      const decision = this.evaluateOsNotification(event, text, "all");
      if (!decision.fire && isDuplicateNotificationBlock(decision.reason)) return;
      this.forwardTakeoverCue(text);
      return;
    }
    const decision = this.notifyOsDecision(event, text);
    if (!decision.fire && isDuplicateNotificationBlock(decision.reason)) return;
    this.postSound(kind);
  }

  /**
   * 远程接管态下完成提示的 QQ 出口。
   *
   * QQ 注入回合自己的回执由任务通道投递（`deliverQqMainIntermediateText` /
   * `completeMainFinalAnswer`），这里跳过以免同一条完成提示被发两遍；其余
   * （本地回合 / 子会话收尾 / 汇报轮）都没有 QQ 任务归属，提示必须由这条
   * 通道送达。投递是附加信息，失败只记日志，绝不影响产生它的回合。
   */
  private forwardTakeoverCue(text: string): void {
    if (this.disposed) return;
    if (this.qqHost.qqInjectedTaskId !== null) return;
    const service = this.qqHost.qq?.service;
    if (!service || typeof service.notifyBoundUser !== "function") return;
    void service.notifyBoundUser(text).catch((error: unknown) => {
      this.log.warn(`远程接管提示投递失败：${errorMessage(error)}`);
    });
  }

  /**
   * 远程接管态下，本地发起任务的「最终汇报正文」投递。
   *
   * be79be5 让接管态的完成提示改投 QQ，但投的只是状态文案
   * 「主会话已汇报超流体结果」—— 真正的正文仍只走 `deliverQqMainFinalAnswer`
   * 的 QQ 任务通道，而本地发起的任务没有 QQ awaiter，那条通道一个任务都
   * 找不到，于是 QQ 端只收到一句元信息、看不到结果（2026-11-20 用户实测）。
   *
   * 这里只在「没有 QQ awaiter」时补投正文：有 awaiter 时任务通道已投递真实
   * 结论，绝不重复刷屏。正文优先取主会话这一轮的转述（answer），为空则退到
   * 子会话汇报正文（fallback，已清洗）；两者都空时如实说明，绝不伪造结论。
   * QQ 单条消息有字符预算，截断后标注完整结果在面板查看。
   */
  private forwardTakeoverReport(
    answer: string,
    fallbackText: string | undefined,
    context?: { awaitedHere?: boolean; stopReason?: string },
  ): void {
    // 纯可观测：每次进入补投路径都留一条决策快照，事后能一眼判定「正文到底
    // 有没有交给 QQ 通道、被哪个条件挡住」。appendQqArchiveEvent 内部吞掉归档
    // 失败且这里 fire-and-forget，绝不影响原有投递 / 静音 / 去重行为。
    const snapshot: Record<string, unknown> = {
      source: "takeover-report",
      awaitedHere: context?.awaitedHere ?? null,
      stopReason: context?.stopReason ?? null,
      qqTakeoverActive: this.qqHost.qqTakeoverActive,
      injectedTaskPresent: this.qqInjectedTaskId !== null,
      answerChars: answer.length,
      fallbackChars: fallbackText?.length ?? 0,
    };
    const suppressed = (reason: string): void => {
      void this.appendQqArchiveEvent(
        "takeover_report_suppressed",
        this.qqInjectedTaskId ?? undefined,
        { ...snapshot, reason, notifyBoundUserCalled: false },
      );
    };
    if (this.disposed) { suppressed("disposed"); return; }
    if (!this.qqHost.qqTakeoverActive) { suppressed("takeover-inactive"); return; }
    // QQ 注入回合自身有专属回执通道；跳过以免同一条结果被发两遍。
    if (this.qqInjectedTaskId !== null) { suppressed("injected-task"); return; }
    const service = this.qqHost.qq?.service;
    if (!service || typeof service.notifyBoundUser !== "function") { suppressed("no-service"); return; }
    const status = vscode.l10n.t("主会话已汇报超流体结果");
    const body = answer.trim() || sanitizeQqReportFallback(fallbackText);
    const text = body
      ? `${status}\n${clipQqTakeoverReport(body)}\n${vscode.l10n.t("（完整结果请在面板查看）")}`
      : `${status}\n${vscode.l10n.t("超流体任务已完成，但未产生可转发的正文摘要。")}`;
    void service.notifyBoundUser(text).catch((error: unknown) => {
      this.log.warn(`远程接管汇报正文投递失败：${errorMessage(error)}`);
    });
    // 记的是「面板把这段正文交给了投递通道」这一事实；通道侧真实投递失败仍由
    // 服务自己的归档事件记录，两者合起来才是完整链路。
    void this.appendQqArchiveEvent("takeover_report_delivered", undefined, {
      ...snapshot,
      notifyBoundUserCalled: true,
      chars: text.length,
    });
  }

  /** A REAL user turn (typed prompt or regenerate) finished. */
  private announceTurnDone(text: string): void {
    this.announceCue("turnDone", text, "done");
  }

  announceSuperReport(...args: Parameters<SuperAgentHost["announceSuperReport"]>): ReturnType<SuperAgentHost["announceSuperReport"]> {
    return this.superHost.announceSuperReport(...args);
  }
  announceChildDone(...args: Parameters<SuperAgentHost["announceChildDone"]>): ReturnType<SuperAgentHost["announceChildDone"]> {
    return this.superHost.announceChildDone(...args);
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
        // T-9: record which rows the AI flow is about to append so the usage
        // resolver can label them `ai-supplement` instead of `user`. Done
        // BEFORE the writes — the config-change handler invalidates the usage
        // cache synchronously and a stale `user` label could otherwise flash.
        // A failed write still can't produce a false label: the relabel also
        // requires a matching, winning `user` override value. Values / settings
        // bytes are untouched — this is in-memory provenance only.
        this.recordAiMetadataStamp(entries, sources, additions);
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

  /** Cached parse of the two usage settings (invalidated on config change —
   * `resolveUsageContext` runs on EVERY store push, so re-parsing the arrays
   * per push would waste work during streaming). */
  private usageOverridesCache: { overrides: Record<string, number>; cost: Record<string, { input: number; output: number }> } | null = null;

  /**
   * T-9 in-memory provenance for values appended by the 「联网补充模型数据」
   * flow. That flow APPENDS AI-supplied `name=value` rows into the SAME
   * `contextWindowOverrides` / `costTable` settings as hand-typed rows, so
   * T-8's `resolveContextWindowWithSource` / `resolveCostWithSource` can only
   * report `user` for both (documented in shared/context-window.ts). This map
   * is the ONLY distinction: keyed by normalized model id, it records which
   * kind of value the AI appended, its exact value (so a later hand-edit stops
   * being labeled ai-supplement), the citation URL and the capture time.
   * Purely in-memory — no settings disk format is touched, so user settings
   * stay compatible; a process restart simply drops the tags while the values
   * remain honest user overrides.
   */
  private aiMetadataStamp: Map<string, {
    window?: { value: number; sourceUrl?: string; capturedAt: number };
    cost?: { value: { input: number; output: number }; sourceUrl?: string; capturedAt: number };
  }> = new Map();

  /** Record AI-supplement provenance for the rows actually appended by
   * `planMetadataAdditions` (pre-existing user rows are never stamped). Called
   * right before the setting writes in the metadata fetch flow. */
  private recordAiMetadataStamp(
    entries: readonly ModelMetadataEntry[],
    sources: readonly MetadataSource[],
    additions: MetadataAdditions,
  ): void {
    const windowKeys = new Set(additions.windows.map((line) => normalizeModelId(line.slice(0, line.indexOf("=")))));
    const costKeys = new Set(additions.costs.map((line) => normalizeModelId(line.slice(0, line.indexOf("=")))));
    if (windowKeys.size === 0 && costKeys.size === 0) return;
    const capturedAt = Date.now();
    for (const entry of entries) {
      const key = normalizeModelId(entry.name);
      if (!key) continue;
      const sourceUrl = entry.source ? sources.find((s) => s.id === entry.source)?.url : undefined;
      const stamp = this.aiMetadataStamp.get(key) ?? {};
      if (windowKeys.has(key) && entry.contextWindow !== undefined) {
        stamp.window = { value: entry.contextWindow, capturedAt, ...(sourceUrl ? { sourceUrl } : {}) };
      }
      if (costKeys.has(key) && entry.inputPrice !== undefined && entry.outputPrice !== undefined) {
        stamp.cost = {
          value: { input: entry.inputPrice, output: entry.outputPrice },
          capturedAt,
          ...(sourceUrl ? { sourceUrl } : {}),
        };
      }
      if (stamp.window || stamp.cost) this.aiMetadataStamp.set(key, stamp);
    }
  }

  /** Resolve the store's usage context: settings overrides → curated tables →
   * conservative fallback, together with the provenance of each number (T-8)
   * and the ai-supplement relabel (T-9). Value and label come from the SAME
   * resolver call so they can never drift. Synchronous and cheap (per push). */
  private resolveUsageContext(): UsageContext {
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
    const win = resolveContextWindowWithSource(modelId, cached.overrides);
    const cost = resolveCostWithSource(modelId, cached.cost);
    let windowSource: ModelMetadataSource | null = win.source;
    let costSource: ModelMetadataSource | null = cost.source;
    let capturedAt: number | undefined;
    let sourceUrl: string | undefined;

    const key = normalizeModelId(modelId);
    if (key) {
      const aiStamp = this.aiMetadataStamp.get(key);
      // Relabel ONLY a winning "user" override whose exact value still matches
      // what the AI flow appended. A hand-typed override — or a later hand edit
      // of an AI value — stays / returns to `user`, never a false
      // `ai-supplement`. T-5's contextUsed/split sources are produced
      // downstream (estimateSessionUsage + kernel overlay) and left untouched.
      if (aiStamp?.window && win.source === "user" && cached.overrides[key] === aiStamp.window.value) {
        windowSource = "ai-supplement";
        capturedAt = aiStamp.window.capturedAt;
        if (aiStamp.window.sourceUrl) sourceUrl = aiStamp.window.sourceUrl;
      }
      if (aiStamp?.cost && cost.source === "user") {
        const live = cached.cost[key];
        if (live && live.input === aiStamp.cost.value.input && live.output === aiStamp.cost.value.output) {
          costSource = "ai-supplement";
          if (capturedAt === undefined) capturedAt = aiStamp.cost.capturedAt;
          if (sourceUrl === undefined && aiStamp.cost.sourceUrl) sourceUrl = aiStamp.cost.sourceUrl;
        }
      }
    }

    return {
      contextWindow: win.window,
      estimated: win.estimated,
      costPrice: cost.price,
      windowSource,
      costSource,
      ...(capturedAt !== undefined ? { capturedAt } : {}),
      ...(sourceUrl !== undefined ? { sourceUrl } : {}),
    };
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


  autoApproveSuperAgentTool(...args: Parameters<SuperAgentHost["autoApproveSuperAgentTool"]>): ReturnType<SuperAgentHost["autoApproveSuperAgentTool"]> {
    return this.superHost.autoApproveSuperAgentTool(...args);
  }
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

  announceDeferredAutoTurns(...args: Parameters<SuperAgentHost["announceDeferredAutoTurns"]>): ReturnType<SuperAgentHost["announceDeferredAutoTurns"]> {
    return this.superHost.announceDeferredAutoTurns(...args);
  }
  clearDeferredAutoTurnsToast(...args: Parameters<SuperAgentHost["clearDeferredAutoTurnsToast"]>): ReturnType<SuperAgentHost["clearDeferredAutoTurnsToast"]> {
    return this.superHost.clearDeferredAutoTurnsToast(...args);
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
    const qqMainTaskId = this.qqHost.qqInjectedTaskId;

    return new Promise<UserQuestionsResponse>((resolve) => {
      const timer = setTimeout(() => {
        // Safety: an unanswered card must not block the agent forever.
        this.pendingQuestions.delete(id);
        this.qqHost.qqMainQuestionIds.delete(id);
        // Resolve FIRST — see the approval-timeout comment above.
        resolve({ answers: {} });
        this.store.clearQuestions(id);
        this.store.appendNotice(vscode.l10n.t("提问超时，已按未回答继续"));
        this.armPostRejectionWatchdog();
      }, APPROVAL_TIMEOUT_MS);

      this.pendingQuestions.set(id, { resolve, timer });
      if (qqMainTaskId) this.qqHost.qqMainQuestionIds.set(id, qqMainTaskId);
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
    const wasQqTaskId = this.qqHost.qqMainQuestionIds.get(id);
    this.qqHost.qqMainQuestionIds.delete(id);
    this.pendingQuestions.delete(id);
    clearTimeout(pending.timer);
    this.store.clearQuestions(id);
    // 本机先作答 → 撤销 QQ 侧那条等待槽位，避免 `/qq answer` 二次回灌同一个问题。
    if (wasQqTaskId) {
      try {
        this.qqHost.qq?.service.clearQuestionWait(wasQqTaskId);
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
    this.qqHost.qqMainQuestionIds.clear();
  }

  // --- QQ thin delegates (阶段 5) -------------------------------------------
  // Signature is preserved: parameter/return types are derived from QqHost,
  // so the webview-message switch, extension.ts and tests keep their contract.
  forwardQqTaskQuestion(...args: Parameters<QqHost["forwardQqTaskQuestion"]>): ReturnType<QqHost["forwardQqTaskQuestion"]> {
    return this.qqHost.forwardQqTaskQuestion(...args);
  }

  forwardQqMainTaskQuestion(...args: Parameters<QqHost["forwardQqMainTaskQuestion"]>): ReturnType<QqHost["forwardQqMainTaskQuestion"]> {
    return this.qqHost.forwardQqMainTaskQuestion(...args);
  }

  forwardQqMainTaskChildQuestion(...args: Parameters<QqHost["forwardQqMainTaskChildQuestion"]>): ReturnType<QqHost["forwardQqMainTaskChildQuestion"]> {
    return this.qqHost.forwardQqMainTaskChildQuestion(...args);
  }

  answerQqMainQuestion(...args: Parameters<QqHost["answerQqMainQuestion"]>): ReturnType<QqHost["answerQqMainQuestion"]> {
    return this.qqHost.answerQqMainQuestion(...args);
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

  requestSuperResidueConfirm(...args: Parameters<SuperAgentHost["requestSuperResidueConfirm"]>): ReturnType<SuperAgentHost["requestSuperResidueConfirm"]> {
    return this.superHost.requestSuperResidueConfirm(...args);
  }
  handleSuperResidueConfirmResponse(...args: Parameters<SuperAgentHost["handleSuperResidueConfirmResponse"]>): ReturnType<SuperAgentHost["handleSuperResidueConfirmResponse"]> {
    return this.superHost.handleSuperResidueConfirmResponse(...args);
  }
  cancelAllSuperResidueConfirms(...args: Parameters<SuperAgentHost["cancelAllSuperResidueConfirms"]>): ReturnType<SuperAgentHost["cancelAllSuperResidueConfirms"]> {
    return this.superHost.cancelAllSuperResidueConfirms(...args);
  }
  async confirmAndPurgeSuperResidue(...args: Parameters<SuperAgentHost["confirmAndPurgeSuperResidue"]>): ReturnType<SuperAgentHost["confirmAndPurgeSuperResidue"]> {
    return this.superHost.confirmAndPurgeSuperResidue(...args);
  }
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

  // --- 多仓库协作：目标根子集 ------------------------------------------------

  /** 当前工作区根的单一来源（realpath + 去重 + 稳定排序，第一根保持 VSCode
   * 第一个文件夹 —— 进程 cwd 依赖它）。 */
  private workspaceRootInfos(): WorkspaceRootUi[] {
    return workspaceRootsFrom(vscode.workspace);
  }

  /** 用户为「之后的新会话」选中的根（workspaceState 持久化，未知路径被丢弃）。 */
  private selectedSessionRoots(roots: readonly WorkspaceRootUi[]): string[] {
    const stored = this.context.workspaceState.get<string[]>(SESSION_ROOTS_KEY, []);
    return normalizeSelection(stored, roots);
  }

  /** 当前会话的 CLI 实际使用的根（存于会话索引的 `roots` 字段）。 */
  private appliedSessionRoots(): string[] | null {
    const state = this.store.getState();
    const id = state.activeSessionId ?? state.sessionId;
    if (!id) return null;
    const summary = state.sessions.find((s) => s.id === id);
    return summary?.roots ?? null;
  }

  /**
   * 把根子集投影写进状态（只动 UI，不动 CLI、不动 cwd）。
   *
   * 三态：`undefined` 沿用当前 applied（用户改选择时用，当前会话的 applied
   * 不能跟着变，否则「对新会话生效」的提示会自我否认）；`null` 表示全量根；
   * 数组表示该会话真实的根集合。
   * 单根工作区不渲染选择器，投影写 null。
   */
  private publishWorkspaceRoots(applied?: readonly string[] | null): void {
    const roots = this.workspaceRootInfos();
    if (roots.length <= 1) {
      this.store.setWorkspaceRoots(null);
      return;
    }
    const selected = this.selectedSessionRoots(roots);
    const appliedRoots =
      applied === undefined
        ? this.store.getState().workspaceRoots?.applied ?? this.appliedSessionRoots() ?? null
        : applied;
    this.store.setWorkspaceRoots(buildWorkspaceRootsUi(roots, selected, appliedRoots));
  }

  /**
   * 为即将新建的会话计算 `settings.add_dirs`（null = 不写该键 = 与今天一致）。
   * cwd 与 ensureClient 同源（`services.workspaceRoot` 测试钩子优先）。
   */
  private sessionAddDirs(): string[] | null {
    const roots = this.workspaceRootInfos();
    if (roots.length <= 1) return null;
    const cwd =
      this.services.workspaceRoot ??
      roots[0]?.path ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      null;
    return buildAddDirs(this.selectedSessionRoots(roots), roots, cwd);
  }

  /**
   * 根选择器写回。只影响**之后新建**的会话：
   * - 持久化到 workspaceState，下一次 `startNewSession` 用它算 `add_dirs`；
   * - 刷新投影（`applied` 保持不变 → `pendingChange` 让 UI 提示「对新会话生效」）；
   * - 当前会话的 CLI 上下文、cwd、会话文件路径一律不动。
   *
   * 空选择归一为「全量根」：不提供「一个根都不给」的形态（那等于只剩 cwd，
   * 语义容易被误读成「工作区丢了」），UI 也会阻止取消最后一个根。
   */
  private async setSessionRoots(roots: readonly string[]): Promise<void> {
    const all = this.workspaceRootInfos();
    if (all.length <= 1) return;
    const normalized = normalizeSelection(roots, all);
    const next = normalized.length > 0 ? normalized : all.map((r) => r.path);
    await this.context.workspaceState.update(SESSION_ROOTS_KEY, next);
    this.publishWorkspaceRoots();
  }

  /**
   * 为当前会话的重载（keep-session 热重认证、删除消息后截断重载）计算
   * `add_dirs`：用该会话**已记录**的根集合，而不是根选择器里的下一次偏好 ——
   * 重载不换会话，根可见范围必须保持不变，否则收紧过的会话会被悄悄放宽。
   */
  private currentSessionAddDirs(): string[] | null {
    const all = this.workspaceRootInfos();
    if (all.length <= 1) return null;
    const cwd = this.services.workspaceRoot ?? all[0]?.path ?? null;
    return buildAddDirs(this.appliedSessionRoots(), all, cwd);
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
   *
   * 多仓库协作：每个根单独扫（旧实现只对第一个根做 path.relative，其它根的
   * 文件会变成 `../repo/x` 这种无法被模型解析的字符串）。非 cwd 根的条目带
   * 「别名/」前缀，插入文本即 `@alias/rel`，发送时由 `rewriteRootMentions`
   * 还原成绝对路径。只扫当前会话 CLI 实际可见的根（投影的 `applied`），
   * 不给 agent 发它读不到的路径。
   */
  private async loadWorkspaceFileRels(): Promise<string[]> {
    if (this.fileSearchCache) return this.fileSearchCache.rels;
    if (!this.fileSearchInFlight) {
      this.fileSearchInFlight = (async () => {
        const exclude = "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/coverage/**,**/.iflow/**}";
        const allRoots = this.workspaceRootInfos();
        if (allRoots.length === 0) return [];
        const applied = this.store.getState().workspaceRoots?.applied ?? null;
        const roots = applied ? allRoots.filter((r) => applied.includes(r.path)) : allRoots;
        const base = this.sessionCwd ?? this.services.workspaceRoot ?? roots[0]?.path ?? "";
        const perRoot = await Promise.all(
          roots.map(async (root) => {
            const uris = await vscode.workspace.findFiles(
              new vscode.RelativePattern(vscode.Uri.file(root.path), "**/*"),
              exclude,
              500,
            );
            const prefix = root.path === base ? "" : `${root.name}/`;
            return uris.map((uri) => `${prefix}${path.relative(root.path, uri.fsPath).replace(/\\/g, "/")}`);
          }),
        );
        return perRoot.flat();
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
    await this.toolDiff.open(toolCallId);
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
    return this.toolDiff.locate(block);
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
    await this.toolDiff.synthesize(toolCallId);
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
    await this.toolDiff.revertTurn(sessionId, userBlockId, key);
  }

  private async revertToolDiff(toolCallId: string): Promise<void> {
    await this.toolDiff.revertTool(toolCallId);
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
    await this.toolDiff.applyHunks(toolCallId, keep);
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

  /** The shared broker pushes status changes from its background handshake.
   * Keep this a thin wrapper so it can be wired as a callback and exercised
   * in tests without standing up a real broker. */
  private refreshMcpStatusFromBroker(): void {
    void this.sendMcpStatus();
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
   * query the CLI report for prompts/declarations and its `errorKind`, then
   * override per server from `mcpBroker.statuses()`:
   *   - broker connected     → status "connected", childConnected true
   *   - broker connecting    → status "connecting", childConnected undefined
   *                            (blue dot, never a false red failure)
   *   - broker failed(error) → status "disconnected", childConnected false,
   *                            keep the CLI's errorKind (fallback "unknown")
   *   - broker not ready     → childConnected undefined; a CLI-blocked server
   *                            falls back to NEUTRAL "main session does not
   *                            load MCP" (no red dot), never "broken".
   *
   * `contextTokens` is the host-computed BPE of the tool declarations. The
   * CLI report's `tools[]` is ALWAYS empty on the MCP-disabled main session,
   * so we substitute the broker's cached `tools/list` declarations (the same
   * ones a child actually sees) before estimating. Any total failure (no CLI
   * report AND no broker) degrades to `status: null` — the card shows NO
   * indicator rather than a guessed one.
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
      // Start from the CLI view to keep prompts/declarations for the detail
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
        // The CLI (MCP-disabled main session) reports no tools. The broker is
        // the only place with the real declarations a child injects, so use
        // them for the detail view and the token chip.
        const brokerTools = broker.tools ?? [];
        if (brokerTools.length > 0) {
          view.tools = brokerTools;
          view.toolCount = brokerTools.length;
        }
        if (broker.connecting) {
          view.status = "connecting";
          view.childConnected = undefined;
        } else if (broker.connected) {
          view.status = "connected";
          view.childConnected = true;
          // Only drop the main session's blocked/disconnected artifacts; do
          // not wipe an unrelated CLI error wholesale.
          if (!cliView || cliView.blocked || cliView.status !== "connected") {
            delete view.error;
            delete view.errorKind;
          }
        } else if (broker.error) {
          view.status = "disconnected";
          view.childConnected = false;
          view.error = broker.error;
          // Preserve the CLI's captured errorKind (spawn_failed/timeout/…);
          // only fall back to "unknown" when the CLI did not report one.
          if (!view.errorKind) view.errorKind = "unknown";
        } else {
          // Not connected, not connecting, no failure recorded: no authority
          // to claim either success or failure yet.
          view.childConnected = undefined;
        }
        if (broker.connecting && (!cliView || cliView.blocked)) {
          delete view.error;
          delete view.errorKind;
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
  ): Promise<{ ok: boolean; error?: string }> {
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
      const error = vscode.l10n.t("编辑 API 配置时请填写 API Key");
      this.store.markError(error);
      return { ok: false, error };
    }
    const validation = validateCredentials({
      baseUrl,
      apiKey: effectiveKey,
      modelName,
    });
    if (!validation.ok) {
      this.store.markError(validation.error);
      return { ok: false, error: validation.error };
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
      const error = vscode.l10n.t("已存在同名 API 配置: {0}，请换一个名称", name);
      void vscode.window.showWarningMessage(error);
      const auth = this.store.getState().auth;
      this.store.setAuth(await this.buildAuthState(auth.authenticated, auth.needsSetup));
      return { ok: false, error };
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
    // A kernel write failure is a partial success: the profile is live in
    // SecretStorage for this window but will not survive a restart. Keep the
    // editor open with the concrete reason (inline, not just the toast) —
    // same contract deleteProfile uses via `ok: !kernelWriteFailed`.
    const kernelError = kernelWritten ? undefined : vscode.l10n.t("无法写入内核配置 {0}", name);
    if (kernelError) void vscode.window.showWarningMessage(kernelError);

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
      return { ok: !kernelError, ...(kernelError ? { error: kernelError } : {}) };
    }

    if (!isActiveProfile) {
      // Editing some OTHER row: save + refresh the list only. No activation,
      // no reconnect, no pointer move — the panel keeps running as it was.
      const auth = this.store.getState().auth;
      this.store.setAuth(await this.buildAuthState(auth.authenticated, auth.needsSetup));
      return { ok: !kernelError, ...(kernelError ? { error: kernelError } : {}) };
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
      return { ok: !kernelError, ...(kernelError ? { error: kernelError } : {}) };
    }
    await this.reconnectWithCredentials(creds, true);
    return { ok: !kernelError, ...(kernelError ? { error: kernelError } : {}) };
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
        settings: mainSessionSettings(this.currentSessionAddDirs()),
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

  /** Drop all transient per-tool-call caches (session switch / restore / hot
   * re-auth): a stale snapshot from the previous session must never be
   * compared against a same-id tool call in the new one. */
  private clearToolCaches(): void {
    this.toolDiff.clearToolCaches();
  }

  /** Snapshot the target file's disk content before the tool runs (thin
   * delegate — the synchronous capture now lives in ToolDiffService). */
  private capturePreEditSnapshot(toolCallId: string, args: unknown): void {
    this.toolDiff.capturePreEditSnapshot(toolCallId, args);
  }

  // --- Session persistence (M4) --------------------------------------------------

  /** Thin delegate (阶段 3): the session-index read lives in SessionPersistenceService. */
  private readPersistedSessions(): SessionSummaryUi[] {
    return this.persistence.readPersistedSessions();
  }

  /** Thin delegate (阶段 3): canonical ordering + persist live in SessionPersistenceService. */
  private async persistSessions(sessions: SessionSummaryUi[], activeId: string | null): Promise<void> {
    await this.persistence.persistSessions(sessions, activeId);
  }

  /** Upsert a session into the recent list (newest first) and persist it.
   * `updatedAt` is the session's last-activity time: re-recording an existing
   * session (restore/switch, label rename) keeps its prior stamp — only
   * touchActiveSession() (a real turn ending) moves it. New entries stamp
   * now (creation time). */
  private async recordSession(id: string, label: string | null, roots?: readonly string[] | null): Promise<void> {
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
        // 多仓库协作：该会话 CLI 实际可见的目标根集合。恢复时按它重建
        // settings.add_dirs（绝不迁移 cwd）。未显式提供时保留旧值。
        ...(roots && roots.length > 0
          ? { roots: [...roots] }
          : prior?.roots
            ? { roots: prior.roots }
            : {}),
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
    await this.persistence.awaitPersistChain();
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
      // 转录快照与归档同一套串行写链：先把这个会话及其子会话已排队的写全部
      // 收尾，再删，避免终态写在 rm 之后 rename「复活」已删的转录。
      await awaitSuperSessionArchiveWrite(
        this.superStoreDir(),
        sessionId,
        forgotten?.ids ?? [],
      );
      await deleteSuperSessionArchive(this.superStoreDir(), sessionId);
      await Promise.all(
        (forgotten?.ids ?? []).map((id) =>
          deleteSuperTranscriptSnapshot(this.superStoreDir(), id).catch((error: unknown) => {
            this.log.warn(`super agent: transcript snapshot delete failed: ${errorMessage(error)}`);
          }),
        ),
      );
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
   * Restore a persisted session via `session/load` (阶段 4 thin delegate).
   * The replay / transcript rebuild / abort state machine now lives in
   * SessionRestoreService; the panel keeps the signature for the webview
   * switch, `extension.ts` and the restore-abort tests.
   */
  private async restoreSession(sessionId: string): Promise<boolean> {
    return this.sessionRestoreService.restoreSession(sessionId);
  }

  /**
   * Locate the CLI's NDJSON transcript file for a session id. The CLI stores
   * one file per project dir: `~/.iflow/projects/<cwd-as-slug>/session-<id>.jsonl`.
   */
  /** Thin delegate (阶段 3). Public so tests / 阶段 4 can reuse the path lookup
   * even though the panel itself no longer calls it directly. */
  cliTranscriptFilePath(sessionId: string): string | null {
    return this.persistence.cliTranscriptFilePath(sessionId);
  }

  /** Thin delegate (阶段 3): both transcript sources + backfill live in SessionPersistenceService. */
  private async loadPersistedTranscript(sessionId: string): Promise<{ blocks: SessionState["blocks"]; firstUserText: string | null }> {
    return this.persistence.loadPersistedTranscript(sessionId);
  }

  // --- Super Agent (child sessions of the main session) ----------------------

  publishSuperSessions(...args: Parameters<SuperAgentHost["publishSuperSessions"]>): ReturnType<SuperAgentHost["publishSuperSessions"]> {
    return this.superHost.publishSuperSessions(...args);
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

  persistSuperSessions(...args: Parameters<SuperAgentHost["persistSuperSessions"]>): ReturnType<SuperAgentHost["persistSuperSessions"]> {
    return this.superHost.persistSuperSessions(...args);
  }
  writeSuperArchives(...args: Parameters<SuperAgentHost["writeSuperArchives"]>): ReturnType<SuperAgentHost["writeSuperArchives"]> {
    return this.superHost.writeSuperArchives(...args);
  }
  superStoreDir(...args: Parameters<SuperAgentHost["superStoreDir"]>): ReturnType<SuperAgentHost["superStoreDir"]> {
    return this.superHost.superStoreDir(...args);
  }
  async restoreSuperSessions(...args: Parameters<SuperAgentHost["restoreSuperSessions"]>): ReturnType<SuperAgentHost["restoreSuperSessions"]> {
    return this.superHost.restoreSuperSessions(...args);
  }
  async restoreSuperTranscriptSnapshots(...args: Parameters<SuperAgentHost["restoreSuperTranscriptSnapshots"]>): ReturnType<SuperAgentHost["restoreSuperTranscriptSnapshots"]> {
    return this.superHost.restoreSuperTranscriptSnapshots(...args);
  }
  sweepStaleWorktreesInBackground(...args: Parameters<SuperAgentHost["sweepStaleWorktreesInBackground"]>): ReturnType<SuperAgentHost["sweepStaleWorktreesInBackground"]> {
    return this.superHost.sweepStaleWorktreesInBackground(...args);
  }
  superRepoRoot(...args: Parameters<SuperAgentHost["superRepoRoot"]>): ReturnType<SuperAgentHost["superRepoRoot"]> {
    return this.superHost.superRepoRoot(...args);
  }
  prepareSuperSpec(...args: Parameters<SuperAgentHost["prepareSuperSpec"]>): ReturnType<SuperAgentHost["prepareSuperSpec"]> {
    return this.superHost.prepareSuperSpec(...args);
  }
  collectSuperAttachments(...args: Parameters<SuperAgentHost["collectSuperAttachments"]>): ReturnType<SuperAgentHost["collectSuperAttachments"]> {
    return this.superHost.collectSuperAttachments(...args);
  }
  resolveSuperAttachmentPath(...args: Parameters<SuperAgentHost["resolveSuperAttachmentPath"]>): ReturnType<SuperAgentHost["resolveSuperAttachmentPath"]> {
    return this.superHost.resolveSuperAttachmentPath(...args);
  }
  getSuperAgent(...args: Parameters<SuperAgentHost["getSuperAgent"]>): ReturnType<SuperAgentHost["getSuperAgent"]> {
    return this.superHost.getSuperAgent(...args);
  }
  async ensureMcpBroker(...args: Parameters<SuperAgentHost["ensureMcpBroker"]>): ReturnType<SuperAgentHost["ensureMcpBroker"]> {
    return this.superHost.ensureMcpBroker(...args);
  }
  async createSuperClient(...args: Parameters<SuperAgentHost["createSuperClient"]>): ReturnType<SuperAgentHost["createSuperClient"]> {
    return this.superHost.createSuperClient(...args);
  }
  resetSuperDirectiveScans(...args: Parameters<SuperAgentHost["resetSuperDirectiveScans"]>): ReturnType<SuperAgentHost["resetSuperDirectiveScans"]> {
    return this.superHost.resetSuperDirectiveScans(...args);
  }
  scanSuperDirectives(...args: Parameters<SuperAgentHost["scanSuperDirectives"]>): ReturnType<SuperAgentHost["scanSuperDirectives"]> {
    return this.superHost.scanSuperDirectives(...args);
  }
  dispatchSuperTasks(...args: Parameters<SuperAgentHost["dispatchSuperTasks"]>): ReturnType<SuperAgentHost["dispatchSuperTasks"]> {
    return this.superHost.dispatchSuperTasks(...args);
  }
  handleSuperToolCall(...args: Parameters<SuperAgentHost["handleSuperToolCall"]>): ReturnType<SuperAgentHost["handleSuperToolCall"]> {
    return this.superHost.handleSuperToolCall(...args);
  }
  auditSuperToolCallCompletion(...args: Parameters<SuperAgentHost["auditSuperToolCallCompletion"]>): ReturnType<SuperAgentHost["auditSuperToolCallCompletion"]> {
    return this.superHost.auditSuperToolCallCompletion(...args);
  }
  recordSuperToolCallOutcome(...args: Parameters<SuperAgentHost["recordSuperToolCallOutcome"]>): ReturnType<SuperAgentHost["recordSuperToolCallOutcome"]> {
    return this.superHost.recordSuperToolCallOutcome(...args);
  }
  rememberSuperToolCallActions(...args: Parameters<SuperAgentHost["rememberSuperToolCallActions"]>): ReturnType<SuperAgentHost["rememberSuperToolCallActions"]> {
    return this.superHost.rememberSuperToolCallActions(...args);
  }
  rememberDispatchedDirective(...args: Parameters<SuperAgentHost["rememberDispatchedDirective"]>): ReturnType<SuperAgentHost["rememberDispatchedDirective"]> {
    return this.superHost.rememberDispatchedDirective(...args);
  }
  warnUnsupportedSuperToolCall(...args: Parameters<SuperAgentHost["warnUnsupportedSuperToolCall"]>): ReturnType<SuperAgentHost["warnUnsupportedSuperToolCall"]> {
    return this.superHost.warnUnsupportedSuperToolCall(...args);
  }
  queueSuperToolCallCorrection(...args: Parameters<SuperAgentHost["queueSuperToolCallCorrection"]>): ReturnType<SuperAgentHost["queueSuperToolCallCorrection"]> {
    return this.superHost.queueSuperToolCallCorrection(...args);
  }
  async drainSuperToolCallCorrections(...args: Parameters<SuperAgentHost["drainSuperToolCallCorrections"]>): ReturnType<SuperAgentHost["drainSuperToolCallCorrections"]> {
    return this.superHost.drainSuperToolCallCorrections(...args);
  }
  scanSuperActions(...args: Parameters<SuperAgentHost["scanSuperActions"]>): ReturnType<SuperAgentHost["scanSuperActions"]> {
    return this.superHost.scanSuperActions(...args);
  }
  auditSuperActionsAtSettle(...args: Parameters<SuperAgentHost["auditSuperActionsAtSettle"]>): ReturnType<SuperAgentHost["auditSuperActionsAtSettle"]> {
    return this.superHost.auditSuperActionsAtSettle(...args);
  }
  async runSuperActions(...args: Parameters<SuperAgentHost["runSuperActions"]>): ReturnType<SuperAgentHost["runSuperActions"]> {
    return this.superHost.runSuperActions(...args);
  }
  queueSuperActionReceipt(...args: Parameters<SuperAgentHost["queueSuperActionReceipt"]>): ReturnType<SuperAgentHost["queueSuperActionReceipt"]> {
    return this.superHost.queueSuperActionReceipt(...args);
  }
  async drainSuperActionReceipts(...args: Parameters<SuperAgentHost["drainSuperActionReceipts"]>): ReturnType<SuperAgentHost["drainSuperActionReceipts"]> {
    return this.superHost.drainSuperActionReceipts(...args);
  }
  async drainDelegatedUserTurns(...args: Parameters<SuperAgentHost["drainDelegatedUserTurns"]>): ReturnType<SuperAgentHost["drainDelegatedUserTurns"]> {
    return this.superHost.drainDelegatedUserTurns(...args);
  }
  superAgentsDigest(...args: Parameters<SuperAgentHost["superAgentsDigest"]>): ReturnType<SuperAgentHost["superAgentsDigest"]> {
    return this.superHost.superAgentsDigest(...args);
  }
  queueSuperReport(...args: Parameters<SuperAgentHost["queueSuperReport"]>): ReturnType<SuperAgentHost["queueSuperReport"]> {
    return this.superHost.queueSuperReport(...args);
  }
  superReportOwnerKey(...args: Parameters<SuperAgentHost["superReportOwnerKey"]>): ReturnType<SuperAgentHost["superReportOwnerKey"]> {
    return this.superHost.superReportOwnerKey(...args);
  }
  superBelongsToCurrentMain(...args: Parameters<SuperAgentHost["superBelongsToCurrentMain"]>): ReturnType<SuperAgentHost["superBelongsToCurrentMain"]> {
    return this.superHost.superBelongsToCurrentMain(...args);
  }
  settleSuperReportsIfReady(...args: Parameters<SuperAgentHost["settleSuperReportsIfReady"]>): ReturnType<SuperAgentHost["settleSuperReportsIfReady"]> {
    return this.superHost.settleSuperReportsIfReady(...args);
  }
  announceArchivedLateReports(...args: Parameters<SuperAgentHost["announceArchivedLateReports"]>): ReturnType<SuperAgentHost["announceArchivedLateReports"]> {
    return this.superHost.announceArchivedLateReports(...args);
  }
  async drainSuperReports(...args: Parameters<SuperAgentHost["drainSuperReports"]>): ReturnType<SuperAgentHost["drainSuperReports"]> {
    return this.superHost.drainSuperReports(...args);
  }
  mainSessionFree(...args: Parameters<SuperAgentHost["mainSessionFree"]>): ReturnType<SuperAgentHost["mainSessionFree"]> {
    return this.superHost.mainSessionFree(...args);
  }
  autoTurnsHeld(...args: Parameters<SuperAgentHost["autoTurnsHeld"]>): ReturnType<SuperAgentHost["autoTurnsHeld"]> {
    return this.superHost.autoTurnsHeld(...args);
  }
  pendingAutoTurnCount(...args: Parameters<SuperAgentHost["pendingAutoTurnCount"]>): ReturnType<SuperAgentHost["pendingAutoTurnCount"]> {
    return this.superHost.pendingAutoTurnCount(...args);
  }
  ensureSuperHeartbeat(...args: Parameters<SuperAgentHost["ensureSuperHeartbeat"]>): ReturnType<SuperAgentHost["ensureSuperHeartbeat"]> {
    return this.superHost.ensureSuperHeartbeat(...args);
  }
  async drainSuperAutoTurns(...args: Parameters<SuperAgentHost["drainSuperAutoTurns"]>): ReturnType<SuperAgentHost["drainSuperAutoTurns"]> {
    return this.superHost.drainSuperAutoTurns(...args);
  }
  superAutoTurnHasWork(...args: Parameters<SuperAgentHost["superAutoTurnHasWork"]>): ReturnType<SuperAgentHost["superAutoTurnHasWork"]> {
    return this.superHost.superAutoTurnHasWork(...args);
  }
  superHeartbeatTick(...args: Parameters<SuperAgentHost["superHeartbeatTick"]>): ReturnType<SuperAgentHost["superHeartbeatTick"]> {
    return this.superHost.superHeartbeatTick(...args);
  }
  hasSuperWork(...args: Parameters<SuperAgentHost["hasSuperWork"]>): ReturnType<SuperAgentHost["hasSuperWork"]> {
    return this.superHost.hasSuperWork(...args);
  }
  hasRunningSuperSessions(...args: Parameters<SuperAgentHost["hasRunningSuperSessions"]>): ReturnType<SuperAgentHost["hasRunningSuperSessions"]> {
    return this.superHost.hasRunningSuperSessions(...args);
  }
  stopSuperHeartbeat(...args: Parameters<SuperAgentHost["stopSuperHeartbeat"]>): ReturnType<SuperAgentHost["stopSuperHeartbeat"]> {
    return this.superHost.stopSuperHeartbeat(...args);
  }
  superWaitingForReports(...args: Parameters<SuperAgentHost["superWaitingForReports"]>): ReturnType<SuperAgentHost["superWaitingForReports"]> {
    return this.superHost.superWaitingForReports(...args);
  }
  syncSuperWaitingState(...args: Parameters<SuperAgentHost["syncSuperWaitingState"]>): ReturnType<SuperAgentHost["syncSuperWaitingState"]> {
    return this.superHost.syncSuperWaitingState(...args);
  }
  syncChildSettledAnnouncements(...args: Parameters<SuperAgentHost["syncChildSettledAnnouncements"]>): ReturnType<SuperAgentHost["syncChildSettledAnnouncements"]> {
    return this.superHost.syncChildSettledAnnouncements(...args);
  }
  announceChildSettled(...args: Parameters<SuperAgentHost["announceChildSettled"]>): ReturnType<SuperAgentHost["announceChildSettled"]> {
    return this.superHost.announceChildSettled(...args);
  }
  refreshSuperWaitHeartbeat(...args: Parameters<SuperAgentHost["refreshSuperWaitHeartbeat"]>): ReturnType<SuperAgentHost["refreshSuperWaitHeartbeat"]> {
    return this.superHost.refreshSuperWaitHeartbeat(...args);
  }
  clearSuperWaitHeartbeat(...args: Parameters<SuperAgentHost["clearSuperWaitHeartbeat"]>): ReturnType<SuperAgentHost["clearSuperWaitHeartbeat"]> {
    return this.superHost.clearSuperWaitHeartbeat(...args);
  }
  async handleSuperAgentAction(...args: Parameters<SuperAgentHost["handleSuperAgentAction"]>): ReturnType<SuperAgentHost["handleSuperAgentAction"]> {
    return this.superHost.handleSuperAgentAction(...args);
  }
  startQqIfEnabled(...args: Parameters<QqHost["startQqIfEnabled"]>): ReturnType<QqHost["startQqIfEnabled"]> {
    return this.qqHost.startQqIfEnabled(...args);
  }

  doStartQq(...args: Parameters<QqHost["doStartQq"]>): ReturnType<QqHost["doStartQq"]> {
    return this.qqHost.doStartQq(...args);
  }

  startQqBotChannel(...args: Parameters<QqHost["startQqBotChannel"]>): ReturnType<QqHost["startQqBotChannel"]> {
    return this.qqHost.startQqBotChannel(...args);
  }

  doStartQqBotChannel(...args: Parameters<QqHost["doStartQqBotChannel"]>): ReturnType<QqHost["doStartQqBotChannel"]> {
    return this.qqHost.doStartQqBotChannel(...args);
  }

  currentQqConfig(...args: Parameters<QqHost["currentQqConfig"]>): ReturnType<QqHost["currentQqConfig"]> {
    return this.qqHost.currentQqConfig(...args);
  }

  stopQqBotBinding(...args: Parameters<QqHost["stopQqBotBinding"]>): ReturnType<QqHost["stopQqBotBinding"]> {
    return this.qqHost.stopQqBotBinding(...args);
  }

  startQqBotBind(...args: Parameters<QqHost["startQqBotBind"]>): ReturnType<QqHost["startQqBotBind"]> {
    return this.qqHost.startQqBotBind(...args);
  }

  onQqBotBound(...args: Parameters<QqHost["onQqBotBound"]>): ReturnType<QqHost["onQqBotBound"]> {
    return this.qqHost.onQqBotBound(...args);
  }

  qqIo(...args: Parameters<QqHost["qqIo"]>): ReturnType<QqHost["qqIo"]> {
    return this.qqHost.qqIo(...args);
  }

  postManagedStatus(...args: Parameters<QqHost["postManagedStatus"]>): ReturnType<QqHost["postManagedStatus"]> {
    return this.qqHost.postManagedStatus(...args);
  }

  handleQqManagedSetup(...args: Parameters<QqHost["handleQqManagedSetup"]>): ReturnType<QqHost["handleQqManagedSetup"]> {
    return this.qqHost.handleQqManagedSetup(...args);
  }

  stopQq(...args: Parameters<QqHost["stopQq"]>): ReturnType<QqHost["stopQq"]> {
    return this.qqHost.stopQq(...args);
  }

  disposeQqOwner(...args: Parameters<QqHost["disposeQqOwner"]>): ReturnType<QqHost["disposeQqOwner"]> {
    return this.qqHost.disposeQqOwner(...args);
  }

  raceQqTeardown(...args: Parameters<QqHost["raceQqTeardown"]>): ReturnType<QqHost["raceQqTeardown"]> {
    return this.qqHost.raceQqTeardown(...args);
  }

  restartQq(...args: Parameters<QqHost["restartQq"]>): ReturnType<QqHost["restartQq"]> {
    return this.qqHost.restartQq(...args);
  }

  checkQqChannelHealth(...args: Parameters<QqHost["checkQqChannelHealth"]>): ReturnType<QqHost["checkQqChannelHealth"]> {
    return this.qqHost.checkQqChannelHealth(...args);
  }

  recoverQqChannel(...args: Parameters<QqHost["recoverQqChannel"]>): ReturnType<QqHost["recoverQqChannel"]> {
    return this.qqHost.recoverQqChannel(...args);
  }

  scheduleQqRestart(...args: Parameters<QqHost["scheduleQqRestart"]>): ReturnType<QqHost["scheduleQqRestart"]> {
    return this.qqHost.scheduleQqRestart(...args);
  }

  isQqRecord(...args: Parameters<QqHost["isQqRecord"]>): ReturnType<QqHost["isQqRecord"]> {
    return this.qqHost.isQqRecord(...args);
  }

  isQqTaskAction(...args: Parameters<QqHost["isQqTaskAction"]>): ReturnType<QqHost["isQqTaskAction"]> {
    return this.qqHost.isQqTaskAction(...args);
  }

  coerceQqInboundMessage(...args: Parameters<QqHost["coerceQqInboundMessage"]>): ReturnType<QqHost["coerceQqInboundMessage"]> {
    return this.qqHost.coerceQqInboundMessage(...args);
  }

  createQqHostPorts(...args: Parameters<QqHost["createQqHostPorts"]>): ReturnType<QqHost["createQqHostPorts"]> {
    return this.qqHost.createQqHostPorts(...args);
  }

  injectQqMainTurn(...args: Parameters<QqHost["injectQqMainTurn"]>): ReturnType<QqHost["injectQqMainTurn"]> {
    return this.qqHost.injectQqMainTurn(...args);
  }

  deliverQqMainFinalAnswer(...args: Parameters<QqHost["deliverQqMainFinalAnswer"]>): ReturnType<QqHost["deliverQqMainFinalAnswer"]> {
    return this.qqHost.deliverQqMainFinalAnswer(...args);
  }

  qqFinalRescueOwnerPending(...args: Parameters<QqHost["qqFinalRescueOwnerPending"]>): ReturnType<QqHost["qqFinalRescueOwnerPending"]> {
    return this.qqHost.qqFinalRescueOwnerPending(...args);
  }

  qqFinalRescueDue(...args: Parameters<QqHost["qqFinalRescueDue"]>): ReturnType<QqHost["qqFinalRescueDue"]> {
    return this.qqHost.qqFinalRescueDue(...args);
  }

  qqActiveChildrenCount(...args: Parameters<QqHost["qqActiveChildrenCount"]>): ReturnType<QqHost["qqActiveChildrenCount"]> {
    return this.qqHost.qqActiveChildrenCount(...args);
  }

  qqFinalRescueWaitedMs(...args: Parameters<QqHost["qqFinalRescueWaitedMs"]>): ReturnType<QqHost["qqFinalRescueWaitedMs"]> {
    return this.qqHost.qqFinalRescueWaitedMs(...args);
  }

  appendQqArchiveEvent(...args: Parameters<QqHost["appendQqArchiveEvent"]>): ReturnType<QqHost["appendQqArchiveEvent"]> {
    return this.qqHost.appendQqArchiveEvent(...args);
  }

  ensureQqFinalRescueTimer(...args: Parameters<QqHost["ensureQqFinalRescueTimer"]>): ReturnType<QqHost["ensureQqFinalRescueTimer"]> {
    return this.qqHost.ensureQqFinalRescueTimer(...args);
  }

  stopQqFinalRescueTimer(...args: Parameters<QqHost["stopQqFinalRescueTimer"]>): ReturnType<QqHost["stopQqFinalRescueTimer"]> {
    return this.qqHost.stopQqFinalRescueTimer(...args);
  }

  rescueStaleQqFinalAwaiters(...args: Parameters<QqHost["rescueStaleQqFinalAwaiters"]>): ReturnType<QqHost["rescueStaleQqFinalAwaiters"]> {
    return this.qqHost.rescueStaleQqFinalAwaiters(...args);
  }

  deliverQqMainRescueProgress(...args: Parameters<QqHost["deliverQqMainRescueProgress"]>): ReturnType<QqHost["deliverQqMainRescueProgress"]> {
    return this.qqHost.deliverQqMainRescueProgress(...args);
  }

  extractQqTurnTextFromAnchor(...args: Parameters<QqHost["extractQqTurnTextFromAnchor"]>): ReturnType<QqHost["extractQqTurnTextFromAnchor"]> {
    return this.qqHost.extractQqTurnTextFromAnchor(...args);
  }

  captureQqReportTurnText(...args: Parameters<QqHost["captureQqReportTurnText"]>): ReturnType<QqHost["captureQqReportTurnText"]> {
    return this.qqHost.captureQqReportTurnText(...args);
  }

  deliverQqMainIntermediateText(...args: Parameters<QqHost["deliverQqMainIntermediateText"]>): ReturnType<QqHost["deliverQqMainIntermediateText"]> {
    return this.qqHost.deliverQqMainIntermediateText(...args);
  }

  waitForQqMainFree(...args: Parameters<QqHost["waitForQqMainFree"]>): ReturnType<QqHost["waitForQqMainFree"]> {
    return this.qqHost.waitForQqMainFree(...args);
  }

  waitForMainFreeTick(...args: Parameters<QqHost["waitForMainFreeTick"]>): ReturnType<QqHost["waitForMainFreeTick"]> {
    return this.qqHost.waitForMainFreeTick(...args);
  }

  isQqRemoteDetachedFor(...args: Parameters<QqHost["isQqRemoteDetachedFor"]>): ReturnType<QqHost["isQqRemoteDetachedFor"]> {
    return this.qqHost.isQqRemoteDetachedFor(...args);
  }

  handleQqTakeover(...args: Parameters<QqHost["handleQqTakeover"]>): ReturnType<QqHost["handleQqTakeover"]> {
    return this.qqHost.handleQqTakeover(...args);
  }

  clearQqTakeover(...args: Parameters<QqHost["clearQqTakeover"]>): ReturnType<QqHost["clearQqTakeover"]> {
    return this.qqHost.clearQqTakeover(...args);
  }

  clearQqRemoteDetachedSessions(...args: Parameters<QqHost["clearQqRemoteDetachedSessions"]>): ReturnType<QqHost["clearQqRemoteDetachedSessions"]> {
    return this.qqHost.clearQqRemoteDetachedSessions(...args);
  }

  cancelAllQqMainInjections(...args: Parameters<QqHost["cancelAllQqMainInjections"]>): ReturnType<QqHost["cancelAllQqMainInjections"]> {
    return this.qqHost.cancelAllQqMainInjections(...args);
  }

  cancelQqMainInjection(...args: Parameters<QqHost["cancelQqMainInjection"]>): ReturnType<QqHost["cancelQqMainInjection"]> {
    return this.qqHost.cancelQqMainInjection(...args);
  }

  findQqSuperSession(...args: Parameters<QqHost["findQqSuperSession"]>): ReturnType<QqHost["findQqSuperSession"]> {
    return this.qqHost.findQqSuperSession(...args);
  }

  qqPendingStore(...args: Parameters<QqHost["qqPendingStore"]>): ReturnType<QqHost["qqPendingStore"]> {
    return this.qqHost.qqPendingStore(...args);
  }

  handleQqPendingUser(...args: Parameters<QqHost["handleQqPendingUser"]>): ReturnType<QqHost["handleQqPendingUser"]> {
    return this.qqHost.handleQqPendingUser(...args);
  }

  postQqPendingUsers(...args: Parameters<QqHost["postQqPendingUsers"]>): ReturnType<QqHost["postQqPendingUsers"]> {
    return this.qqHost.postQqPendingUsers(...args);
  }

  pushQqPendingUsers(...args: Parameters<QqHost["pushQqPendingUsers"]>): ReturnType<QqHost["pushQqPendingUsers"]> {
    return this.qqHost.pushQqPendingUsers(...args);
  }

  handleQqUserAction(...args: Parameters<QqHost["handleQqUserAction"]>): ReturnType<QqHost["handleQqUserAction"]> {
    return this.qqHost.handleQqUserAction(...args);
  }

  unbindQqAccount(...args: Parameters<QqHost["unbindQqAccount"]>): ReturnType<QqHost["unbindQqAccount"]> {
    return this.qqHost.unbindQqAccount(...args);
  }

  handleQqSettingsPatch(...args: Parameters<QqHost["handleQqSettingsPatch"]>): ReturnType<QqHost["handleQqSettingsPatch"]> {
    return this.qqHost.handleQqSettingsPatch(...args);
  }

  handleQqConfigAction(...args: Parameters<QqHost["handleQqConfigAction"]>): ReturnType<QqHost["handleQqConfigAction"]> {
    return this.qqHost.handleQqConfigAction(...args);
  }

  handleQqTaskAction(...args: Parameters<QqHost["handleQqTaskAction"]>): ReturnType<QqHost["handleQqTaskAction"]> {
    return this.qqHost.handleQqTaskAction(...args);
  }

  scheduleQqSettingsChanged(...args: Parameters<QqHost["scheduleQqSettingsChanged"]>): ReturnType<QqHost["scheduleQqSettingsChanged"]> {
    return this.qqHost.scheduleQqSettingsChanged(...args);
  }

  onQqSettingsChanged(...args: Parameters<QqHost["onQqSettingsChanged"]>): ReturnType<QqHost["onQqSettingsChanged"]> {
    return this.qqHost.onQqSettingsChanged(...args);
  }

  syncQqServiceWithSettings(...args: Parameters<QqHost["syncQqServiceWithSettings"]>): ReturnType<QqHost["syncQqServiceWithSettings"]> {
    return this.qqHost.syncQqServiceWithSettings(...args);
  }

  pushQqState(...args: Parameters<QqHost["pushQqState"]>): ReturnType<QqHost["pushQqState"]> {
    return this.qqHost.pushQqState(...args);
  }

  pushQqSettings(...args: Parameters<QqHost["pushQqSettings"]>): ReturnType<QqHost["pushQqSettings"]> {
    return this.qqHost.pushQqSettings(...args);
  }

  pushQqStatus(...args: Parameters<QqHost["pushQqStatus"]>): ReturnType<QqHost["pushQqStatus"]> {
    return this.qqHost.pushQqStatus(...args);
  }

  refreshQqTaskProjection(...args: Parameters<QqHost["refreshQqTaskProjection"]>): ReturnType<QqHost["refreshQqTaskProjection"]> {
    return this.qqHost.refreshQqTaskProjection(...args);
  }

  scheduleQqSnapshotFlush(...args: Parameters<QqHost["scheduleQqSnapshotFlush"]>): ReturnType<QqHost["scheduleQqSnapshotFlush"]> {
    return this.qqHost.scheduleQqSnapshotFlush(...args);
  }

  refreshQqTasks(...args: Parameters<QqHost["refreshQqTasks"]>): ReturnType<QqHost["refreshQqTasks"]> {
    return this.qqHost.refreshQqTasks(...args);
  }

  qqWorkspaceRoots(...args: Parameters<QqHost["qqWorkspaceRoots"]>): ReturnType<QqHost["qqWorkspaceRoots"]> {
    return this.qqHost.qqWorkspaceRoots(...args);
  }


  reportSuperCleanupBatch(...args: Parameters<SuperAgentHost["reportSuperCleanupBatch"]>): ReturnType<SuperAgentHost["reportSuperCleanupBatch"]> {
    return this.superHost.reportSuperCleanupBatch(...args);
  }
  async requestSuperMerge(...args: Parameters<SuperAgentHost["requestSuperMerge"]>): ReturnType<SuperAgentHost["requestSuperMerge"]> {
    return this.superHost.requestSuperMerge(...args);
  }
  scheduleSuperMerge(...args: Parameters<SuperAgentHost["scheduleSuperMerge"]>): ReturnType<SuperAgentHost["scheduleSuperMerge"]> {
    return this.superHost.scheduleSuperMerge(...args);
  }
  async drainSuperMerges(...args: Parameters<SuperAgentHost["drainSuperMerges"]>): ReturnType<SuperAgentHost["drainSuperMerges"]> {
    return this.superHost.drainSuperMerges(...args);
  }
  scheduleSuperMergeWakeup(...args: Parameters<SuperAgentHost["scheduleSuperMergeWakeup"]>): ReturnType<SuperAgentHost["scheduleSuperMergeWakeup"]> {
    return this.superHost.scheduleSuperMergeWakeup(...args);
  }
  superMergeChildRunning(...args: Parameters<SuperAgentHost["superMergeChildRunning"]>): ReturnType<SuperAgentHost["superMergeChildRunning"]> {
    return this.superHost.superMergeChildRunning(...args);
  }
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
      // 多仓库协作：工作区根的唯一来源（realpath + 去重 + 稳定排序）。
      // 列表第一项仍是 VSCode 的第一个工作区文件夹 —— 进程 cwd 必须保持它，
      // 因为 CLI 的会话文件路径依赖这个 cwd（session-persistence.ts）。
      const roots = this.workspaceRootInfos();
      const workspaceRoot =
        this.services.workspaceRoot ??
        roots[0]?.path ??
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
      //
      // 多仓库协作只收紧、绝不放宽：会话级的 `settings.add_dirs` 覆盖 argv 的
      // includeDirectories（见 mainSessionSettings），而这里的允许根集合始终
      // 是全量并集 —— CLI 侧少看几个根，宿主侧仍允许全部工作区根。
      const allowedRoots = roots
        .map((root) => root.path)
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
      // Surface the effective context window to the CLI via env (CLI's
      // zOt()/CT("tokensLimit") overlay, spread last in its settings merge),
      // so auto-compression uses the active profile's limit instead of the
      // 128000 fallback whose 102400 threshold traps super-agent children.
      // Bridge `iflow.contextWindowOverrides` into the same channel: only a
      // real USER override (source === "user") is forwarded. Builtin-table /
      // fallback numbers are UI estimates, not CLI authority — forwarding
      // them would override an explicit active-profile tokensLimit and drift
      // behaviour. An invalid/absent override falls back to settings inside
      // tokensLimitEnvFromSettings, so this is additive.
      const userWindow = resolveContextWindowWithSource(
        this.store.getState().currentModelId,
        parseContextWindowOverrides(vscode.workspace.getConfiguration("iflow").get<string[]>("contextWindowOverrides", [])),
      );
      const overrideWindow = userWindow.source === "user" ? (userWindow.window ?? undefined) : undefined;
      Object.assign(spawnEnv, tokensLimitEnvFromSettings(undefined, overrideWindow));
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
        // 方案D：`session/set_model` 只改模型名，不重算 CLI 缓存的 tokensLimit
        // （getTokensLimit()/JR() 用它算自动压缩阈值）。用户显式覆盖的窗口必须
        // 在模型切换成功后同步推送，否则热切换后压缩阈值仍停在旧模型的窗口。
        // 只推 source === "user"：内建表 / 兜底值是 UI 估算，推给 CLI 会覆盖
        // profile 里显式的 tokensLimit（与 spawnEnv 启动兜底同一口径）。
        // 串行 await：set_model 成功 → set_tokens_limit 成功之间不允许发 prompt，
        // 所以模型切换「完成」必须等到这次推送 settle（webview 的 beginPending
        // 门控在 sessionMeta 刷新快照后即释放，真正的护栏是这里的串行等待）。
        const switchedWindow = resolveContextWindowWithSource(
          resp.currentModelId,
          parseContextWindowOverrides(vscode.workspace.getConfiguration("iflow").get<string[]>("contextWindowOverrides", [])),
        );
        if (switchedWindow.source === "user" && switchedWindow.window != null) {
          try {
            await this.client?.setTokensLimit(sessionId, switchedWindow.window);
          } catch (error) {
            vscode.window.showWarningMessage(
              vscode.l10n.t("切换模型后同步上下文长度失败：{0}", errorMessage(error)),
            );
            this.store.pushSnapshot();
          }
        }
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
  /** Thin delegate (阶段 3). Public for stage-4 reuse; base is read live in
   * the service (storageUri ?? globalStorageUri), never snapshotted. */
  transcriptDir(): string {
    return this.persistence.transcriptDir();
  }

  // --- System-prompt override for the CLI (IFLOW_SYSTEM_MD) ------------------

  /**
   * The system-prompt template ships as text inside extension.cjs (no readable
   * prompt files in the VSIX), but the CLI reads `IFLOW_SYSTEM_MD` from disk —
   * so materialise it in our own storage dir, the same place context-report.json
   * lives. Skips the write when the file already holds the current template.
   * Returns null on failure so the spawn omits the override instead of pointing
   * the CLI at a path that does not exist (it throws on a missing file).
   *
   * `variant` selects which template lands on disk: "main" (the default) keeps
   * the original `system-prompt.md` byte-for-byte; "child" writes the trimmed
   * Super-Agent-child template so child sessions don't carry the main session's
   * orchestration section (~5K tokens/request saved per child).
   */
  private async materializeSystemPrompt(variant: "main" | "child" = "main"): Promise<string | null> {
    const fileName = variant === "child" ? "system-prompt-child.md" : "system-prompt.md";
    const promptName = variant === "child" ? "system-prompt-child" : "system-prompt";
    const fileUri = vscode.Uri.joinPath(this.context.storageUri ?? this.context.globalStorageUri, fileName);
    const text = loadPrompt(promptName);
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
   * Root of the shadow-git stores (阶段 4 thin delegate). Read fresh per call
   * by the service so `iflow.checkpointDir` applies without a window reload.
   */
  private checkpointRoot(): string {
    return this.checkpointService.checkpointRoot();
  }

  ownTranscriptFileName(sessionId: string): string {
    return this.persistence.ownTranscriptFileName(sessionId);
  }

  /** Thin delegate (阶段 3). Public: no static panel callers after extraction
   * (noUnusedLocals) and used by tests / 阶段 4 as a path hook. */
  ownTranscriptFilePath(sessionId: string): string {
    return this.persistence.ownTranscriptFilePath(sessionId);
  }

  /** Thin delegate (阶段 3): read one transcript file, null when absent/corrupt. */
  private async readTranscript(sessionId: string): Promise<PersistedTranscript | null> {
    return this.persistence.readTranscript(sessionId);
  }

  /** Thin delegate (阶段 3): serialization lives in SessionPersistenceService. */
  private serializeTranscript(label: string, blocks: SessionState["blocks"]): string {
    return this.persistence.serializeTranscript(label, blocks);
  }

  /** Thin delegate (阶段 3). Public for stage-4 reuse (no static panel callers). */
  writeTranscriptFile(sessionId: string, payload: string): Promise<void> {
    return this.persistence.writeTranscriptFile(sessionId, payload);
  }

  /** Thin delegate (阶段 3): the serialize + write chain lives in the service. */
  private enqueueTranscriptWrite(sessionId: string, payloadFactory: () => string): Promise<void> {
    return this.persistence.enqueueTranscriptWrite(sessionId, payloadFactory);
  }

  private async clearTranscript(sessionId: string): Promise<void> {
    await this.persistence.clearTranscript(sessionId);
  }

  /** Restorable = the extension holds a transcript OR the CLI wrote a file. */
  private hasPersistedTranscript(sessionId: string): boolean {
    return this.persistence.hasPersistedTranscript(sessionId);
  }

  /** Thin delegate (阶段 4): session-list pruning + orphan GC (transcript /
   * super-archive / shadow-repo) now lives in SessionRestoreService. */
  async pruneUnrestorableSessions(): Promise<SessionSummaryUi[]> {
    return this.sessionRestoreService.pruneUnrestorableSessions();
  }

  /** Thin delegate (阶段 4): session-list GC / switcher refresh now lives in SessionRestoreService. */
  private async refreshSessionList(): Promise<void> {
    await this.sessionRestoreService.refreshSessionList();
  }

  /**
   * Transcript file names on disk under the extension's transcript store
   * (for orphan cleanup). Empty when the store directory doesn't exist yet.
   */
  async listOwnTranscriptFileNames(): Promise<string[]> {
    return this.persistence.listOwnTranscriptFileNames();
  }

  /**
   * P2 migration: thin delegate (阶段 3) — the legacy-key read, per-file
   * enqueue and key deletion now live in SessionPersistenceService.
   */
  async migrateLegacyTranscripts(): Promise<void> {
    await this.persistence.migrateLegacyTranscripts();
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
    const waitingOnPersist = this.persistence.pendingWriteCount() > 0;
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
    // 多仓库协作：cwd 仍取工作区第一根（不迁移、不跨根），会话级目标根子集
    // 只通过 settings.add_dirs 收紧 CLI 侧可见根。
    const workspaceRoot =
      this.workspaceRootInfos()[0]?.path ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      this.context.extensionUri.fsPath;
    this.sessionCwd = workspaceRoot;
    const addDirs = this.sessionAddDirs();
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
      settings: mainSessionSettings(addDirs),
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
    // 多仓库协作：本次会话的 CLI 实际可见根 = 选中的根（add_dirs 为 null 时
    // 是全量根）。投影给 webview 做「已生效 / 对新会话生效」提示。
    const sessionRoots = this.workspaceRootInfos();
    const appliedRoots = addDirs
      ? sessionRoots.filter((r) => addDirs.includes(r.path) || r.path === workspaceRoot).map((r) => r.path)
      : sessionRoots.map((r) => r.path);
    this.publishWorkspaceRoots(appliedRoots);
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
    // 单根工作区没有「根子集」概念，索引里不留冗余字段（恢复时 null = 全量根）。
    await this.recordSession(
      session.sessionId,
      null,
      sessionRoots.length > 1 ? appliedRoots : null,
    );
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
      /**
       * 多模态方案 C：与 `images` 同下标的逐图说明。缺省/短数组按空串处理。
       * 写进转录的同时，按顺序拼进模型可见的 prompt，让模型对上「第几张图是
       * 什么」；结构化界面上模型看不到图片文件名，只有这条清单。
       */
      imageCaptions?: string[];
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
    // 多模态方案 C：把逐图说明对齐到 images 的下标（缺失按空串），一次算好，
    // 转录与模型侧清单共用同一份口径。
    const imageCaptions = (images ?? []).map((_, index) =>
      (options?.imageCaptions?.[index] ?? "").trim(),
    );
    const hasImageCaptions = imageCaptions.some((caption) => caption !== "");
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
      }, imageCaptions);
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
        imageCaptions,
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
    // 多仓库协作：`@<别名>/<rel>` 还原成绝对路径。cwd 内的提及保持原样（今天
    // 的行为），只有非 cwd 根需要还原 —— 否则模型会按 cwd 解析成不存在的路径。
    // 别名未知、相对部分为空、或结果逃出该根时一律原样保留。
    if (!internal) {
      const mentionRoots = this.workspaceRootInfos();
      if (mentionRoots.length > 1) {
        const mentionCwd = this.sessionCwd ?? this.services.workspaceRoot ?? mentionRoots[0]?.path ?? null;
        typedText = rewriteRootMentions(typedText, mentionRoots, mentionCwd);
      }
    }
    // The orchestrator's eyes: every main-session turn starts with the live
    // child-session board (host state, NOT user text — it is never written to
    // the user bubble). Internal helper requests (titles / enhance / reports)
    // must not carry it: they are not turns of the conversation.
    const superDigest = internal ? "" : this.superAgentsDigest();
    // 图片在模型眼里只是没有名字的内联块：清单必须紧贴在正文之前，模型才
    // 能把「第 2 张」对应到用户的说明。没有说明时不插入任何占位段落。
    const imageCaptionBlock = hasImageCaptions ? buildImageCaptionPrompt(imageCaptions) : "";
    const promptText =
      [superDigest, agentContextBlock, imageCaptionBlock, typedText]
        .filter(Boolean)
        .join("\n\n") + attachmentBlock;
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
          hasImageCaptions ? imageCaptions : undefined,
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
      let takeoverReportSent = false;
      if (finalReport && result.stopReason !== "cancelled") {
        const { text: answer } = this.extractQqTurnTextFromAnchor(
          finalReportAnchorId,
          finalReportAnchorLen,
          finalReportFallbackCount,
        );
        // 有 QQ awaiter 时任务通道会投递真实正文；本地发起的任务没有 QQ 归属，
        // 那条通道找不到任何任务 —— 此时改由接管态的绑定者私聊补投正文。
        const awaitedHere = [...this.qqHost.qqMainFinalAwaiters.values()].includes(promptSessionId);
        const takeoverActive = this.qqHost.qqTakeoverActive;
        // 纯可观测：无论是否补投都留一条决策快照，供 QQ 归档事后核对
        // 「这一轮为什么没投正文 / 投给了谁」。fire-and-forget，不影响回合收尾。
        void this.appendQqArchiveEvent("takeover_report_decision", undefined, {
          source: "final-report",
          sessionId: promptSessionId,
          awaitedHere,
          takeoverActive,
          stopReason: result.stopReason,
          injectedTaskPresent: this.qqInjectedTaskId !== null,
          supplemented: !awaitedHere && takeoverActive,
          answerChars: answer.length,
        });
        void this.deliverQqMainFinalAnswer(
          promptSessionId,
          answer,
          result.stopReason,
          undefined,
          finalFallbackText,
        );
        // 本地发起的任务（qqInjectedTaskId === null）即使残留 awaiter，正文也只到
        // completeMainFinalAnswer 任务通道、私聊看不到，必须补投。QQ 注入回合由
        // forwardTakeoverReport 内部 `qqInjectedTaskId !== null` 守卫(3347)跳过，不会重复。
        if (
          (!awaitedHere || this.qqInjectedTaskId === null) &&
          takeoverActive
        ) {
          this.forwardTakeoverReport(answer, finalFallbackText, {
            awaitedHere,
            stopReason: result.stopReason,
          });
          takeoverReportSent = true;
        }
        if (!takeoverReportSent && this.qqHost.qqTakeoverActive) {
          void this.appendQqArchiveEvent("takeover_report_forward_skipped", undefined, {
            awaitedHere,
            takeoverActive: this.qqHost.qqTakeoverActive,
            injectedTaskId: this.qqInjectedTaskId,
            promptSessionId,
            answerChars: answer.trim().length,
            fallbackChars: sanitizeQqReportFallback(finalFallbackText).length,
            awaitingTaskIds: [...this.qqHost.qqMainFinalAwaiters.entries()]
              .filter(([, owner]) => owner === promptSessionId)
              .map(([taskId]) => taskId),
            stopReason: result.stopReason,
          });
        }
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
          // 接管态下无 awaiter 的最终汇报已把正文（含状态抬头）投给 QQ，
          // 不再重复发一句纯状态文案；其余情形照旧走完成提示。
          if (!takeoverReportSent) {
            this.announceSuperReport(vscode.l10n.t("主会话已汇报超流体结果"));
          }
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
      // 说明按原块下标取（重跑不重写转录，但模型侧清单必须与首次发送同构）。
      const regenCaptions: string[] = [];
      for (const [index, url] of (lastUserBlock?.images ?? []).entries()) {
        const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
        if (!match) continue;
        const mimeType = match[1];
        const data = match[2];
        if (mimeType && data !== undefined) {
          regenImages.push({ mimeType, data });
          regenCaptions.push((lastUserBlock?.imageCaptions?.[index] ?? "").trim());
        }
      }
      const regenHasCaptions = regenCaptions.some((caption) => caption !== "");
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
      let regenAgentText = regenExpanded ?? toAgentPromptText(regenText, this.store.getState().commands);
      {
        const mentionRoots = this.workspaceRootInfos();
        if (mentionRoots.length > 1) {
          const mentionCwd = this.sessionCwd ?? this.services.workspaceRoot ?? mentionRoots[0]?.path ?? null;
          regenAgentText = rewriteRootMentions(regenAgentText, mentionRoots, mentionCwd);
        }
      }
      const prompt: ContentBlock[] = [
        {
          type: "text",
          text:
            [regenDigest, regenHasCaptions ? buildImageCaptionPrompt(regenCaptions) : "", regenAgentText]
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
        const cut = findCliHistoryCut(
          parsed.chatHistory,
          removed.allUserTexts,
          removed.targetIndex,
          // 多仓库协作：发送前把 @别名/rel 还原成绝对路径，转录里保留别名形态，
          // 定位 CLI 历史时必须过同一个重写（否则跨根提及的轮次匹配不上）。
          (text) => {
            const mentionRoots = this.workspaceRootInfos();
            if (mentionRoots.length <= 1) return text;
            const mentionCwd = this.sessionCwd ?? this.services.workspaceRoot ?? mentionRoots[0]?.path ?? null;
            return rewriteRootMentions(text, mentionRoots, mentionCwd);
          },
        );
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
            settings: mainSessionSettings(this.currentSessionAddDirs()),
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
                settings: mainSessionSettings(this.currentSessionAddDirs()),
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
    if (this.persistTimer) return this.persistence.currentChain();
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (!this.persistDirty) return;
      this.persistDirty = false;
      void this.flushDirtyTranscript();
    }, ChatPanel.PERSIST_DEBOUNCE_MS);
    return this.persistence.currentChain();
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
  /** Thin delegates (阶段 4): checkpoint orchestration now lives in
   * CheckpointService; signatures stay so message routing, sendPrompt /
   * deleteUserMessage call sites and every test keep the same contract. */

  private async captureWorkspaceSnapshot(sessionId: string, text: string): Promise<string | null> {
    return this.checkpointService.captureWorkspaceSnapshot(sessionId, text);
  }

  private recordCheckpoint(sessionId: string, entry: CheckpointUi): void {
    this.checkpointService.recordCheckpoint(sessionId, entry);
  }

  private async loadCheckpointIndex(sessionId: string): Promise<void> {
    return this.checkpointService.loadCheckpointIndex(sessionId);
  }

  private finalizeCheckpointIndex(remap: ReadonlyMap<string, string>): void {
    this.checkpointService.finalizeCheckpointIndex(remap);
  }

  private pruneCheckpointIndexAfterTruncation(): void {
    this.checkpointService.pruneCheckpointIndexAfterTruncation();
  }

  private async removeCheckpointsForSession(sessionId: string): Promise<void> {
    await this.checkpointService.removeCheckpointsForSession(sessionId);
  }

  private async restoreCheckpoint(
    userBlockId: string,
    mode: "files" | "conversation" | "both",
  ): Promise<void> {
    await this.checkpointService.restoreCheckpoint(userBlockId, mode);
  }

  private async confirmAndRestoreCheckpointFiles(sessionId: string, entry: CheckpointUi): Promise<boolean> {
    return this.checkpointService.confirmAndRestoreCheckpointFiles(sessionId, entry);
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
