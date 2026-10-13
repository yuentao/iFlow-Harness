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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readFile, readdir, writeFile, mkdir, rm, rename, stat } from "node:fs/promises";
import { AcpClient } from "../acp/client.js";
import {
  errorMessage,
  isContextOverflowError,
  isRateLimitError,
  isTransientStreamError,
} from "../acp/jsonrpc.js";
import { buildAcpCommand, concealNodeExecutable, configureLocatorPersistence, ensureIflowDefaultConfigs, ensureVendorBinariesExecutable, locateNodeExecutable, resolveVendoredEntry, type LocatorPaths } from "../acp/cli-locator.js";
import { acpSessionFilePath, queryModelIds, readActiveEndpoint, resolveActiveProfileName, retireStaleOAuthCreds, settingsFilePath, updateCliSettings } from "../acp/models-query.js";
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
} from "../acp/protocol.js";
import type { PendingApprovalUi, PendingPlanExitUi, PendingProfileSwitchUi, CheckpointUi, ContextKind, ContextRefUi, QueuedPromptUi, SessionState, SessionSummaryUi, ToolBlock, ToolDiffUi, WebviewToHost } from "../../shared/messages.js";
import {
  clearQueue as clearQueueUi,
  enqueuePrompt as enqueuePromptUi,
  moveQueued as moveQueuedUi,
  removeQueued as removeQueuedUi,
  shiftQueued as shiftQueuedUi,
  QUEUE_MAX,
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
import {
  assembleContextSections,
  buildFolderListing,
  buildGitReport,
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
  dropSessionUpdate,
  endReplay,
  findCliHistoryCut,
  findToolBlockById,
  isAgentOutputUpdate,
  isTaskToolCall,
  MAX_SYNTH_DIFF_CHARS,
  newSessionState,
  parseEditArgs,
  parseToolFilePath,
  parseTranscriptJsonl,
  reassignBlockIds,
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
  normalizeApprovalRule,
  parseApprovalPolicy,
  serializeApprovalPolicy,
  type ApprovalRequestInfo,
  type ApprovalRule,
} from "../../shared/approval-policy.js";
import { SessionStore } from "./store.js";
import { attachmentSessionDir, sweepStaleAttachmentDirs } from "./attachments.js";
import { parseContextWindowOverrides, parseCostTable, resolveContextWindow, resolveCost } from "../../shared/context-window.js";
import { gateOsNotification, initOsNotifyGate, type OsNotifyEvent, type OsNotifyGate } from "../../shared/notifications.js";
import { transcriptToMarkdown, transcriptToJson } from "../../shared/export.js";
import { WireRingBuffer } from "./wire-log.js";

const WEBVIEW_DIST = "webview/dist/index.html";
/** M2 P0-4: async execFile (never sync — trap #18: external process probes
 * must not block the extension host). */
const execFileAsync = promisify(execFileCb);
/** M2 P0-4 @git: per-command timeout and combined output cap. */
const GIT_CONTEXT_TIMEOUT_MS = 5_000;
const GIT_CONTEXT_MAX_CHARS = 32_000;
/** M2 P0-4 @url: fetch timeout / response cap / final text cap. */
const URL_FETCH_TIMEOUT_MS = 10_000;
const URL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** User answer window for a tool-approval card. */
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
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
/** Abort an internal prompt whose session stream went silent for this long.
 * A healthy stream emits chunks every few seconds; the CLI's rate-limit
 * backoff pauses were observed well under this. Catches a mid-stream wedge
 * without waiting out the full wall-clock ceiling. */
const INTERNAL_PROMPT_IDLE_MS = 90_000;
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
/** M1 P0-5: an execute-class tool still running after this long earns an OS
 * notification when it finally lands (only while the panel is hidden). */
const LONG_TOOL_NOTIFY_MS = 30_000;
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
 * would otherwise compress a perfectly healthy session every turn. */
const CONTEXT_AUTOCOMPRESS_RATIO = 0.95;
/** Thrown by promptWithRetry when the empty-response retry ladder is
 * exhausted. The catch chain re-throws it untouched: its user-facing wording
 * would otherwise trip the rate-limit heuristic ("稍后重试" ∈ RATE_LIMIT_RE)
 * and send the turn through another pointless retry round. */
class EmptyResponseError extends Error {}
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

  private editorPanel: vscode.WebviewPanel | undefined;
  private client: AcpClient | null = null;
  private store: SessionStore;
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
  /** M5: agent status at a glance (idle / streaming / approval / error + model). */
  private readonly statusBar: vscode.StatusBarItem;
  /** cwd the current ACP session was created with (base for relative paths). */
  private sessionCwd: string | null = null;
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
    { resolve: (response: ExitPlanModeResponse) => void; timer: NodeJS.Timeout }
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
   */
  private cancelSeen = false;
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
  /** M1 P0-5: toolCallId → start epoch + title of execute-class tools still
   * running (recorded always; the notification-time gate re-checks
   * visibility). The title rides only the initial tool_call (same wire trait
   * as kind, probed CLI 0.5.19), so it must be captured there — otherwise
   * the notification shows the raw toolCallId. Capped FIFO like toolArgs — a
   * long execute-heavy session must not grow it unboundedly if terminal
   * events are ever missed. */
  private readonly runningToolStarts = new Map<string, { startedAt: number; title: string | null }>();
  private static readonly RUNNING_TOOL_CAP = 128;
  /** M1: one internal prompt at a time (enhance and title generation share
   * the lane; a second request while one runs fails fast). */
  private internalPromptBusy = false;
  /** P1-5 anti-footgun: the in-flight enhance (requestId + abort + the
   * session it was started on). `cancelEnhance` aborts it; the reply is also
   * dropped when the requestId is stale or the session changed meanwhile. */
  private pendingEnhance: { requestId: number; cancel: () => void; sessionId: string | null } | null = null;
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
  private queueSeqSeed = 0;
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
    this.store = new SessionStore({ post: (m) => this.postToWebview(m), language: vscode.env.language });
    this.store.onStateChange = (state) => {
      this.updateStatusBar(state);
      // M1 P0-6: occupancy-warning state machine (pure numeric compare per
      // push; toast/dismiss are post-only, no re-entrancy into the store).
      this.evaluateContextWarning();
    };
    // M1 P0-6/P1-6: the store consults this on every usage refresh, so a
    // model switch or a settings edit lands on the occupancy bar without
    // per-call-site wiring (the push itself is the invalidation signal).
    this.store.getUsageContext = () => this.resolveUsageContext();
    this.store.onStateReplaced = () => {
      this.clearToolCaches();
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
        if (
          e.affectsConfiguration("iflow.language")
          || e.affectsConfiguration("iflow.approvalMode")
        ) {
          this.syncCliSettingsToDisk();
        }
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
      case "streaming":
        text = `$(sync~spin) iFlow: ${vscode.l10n.t("生成中")}${model}`;
        break;
      case "error":
        text = `$(error) iFlow: ${vscode.l10n.t("出错")}${model}`;
        background = new vscode.ThemeColor("statusBarItem.errorBackground");
        break;
      default:
        text = state.pendingApproval
          ? `$(bell) iFlow: ${vscode.l10n.t("等待审批")}${model}`
          : `$(check) iFlow${mode}${model}`;
        background = state.pendingApproval
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
    }
    if (this.statusBar.text !== text || this.statusBar.backgroundColor !== background) {
      this.statusBar.text = text;
      this.statusBar.backgroundColor = background;
    }
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
    this.cancelAllProfileSwitches();
    this.clearPostRejectionWatchdog();
    this.client = null;
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
    void this.ensureClient().catch((error) => {
      this.log.error("initial connect failed", errorMessage(error));
    });
  }

  /** Shared webview setup. */
  private wireWebview(webview: vscode.Webview): void {
    webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    webview.html = this.buildHtml(webview);
    webview.onDidReceiveMessage((msg: WebviewToHost) => void this.handleWebviewMessage(msg));
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
    const prompt = [
      vscode.l10n.t("请解释/处理这段代码（`{0}:{1}`）：", relPath, range),
      "",
      "```",
      code,
      "```",
    ].join("\n");
    await this.sendPrompt(prompt);
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
    switch (msg.type) {
      case "ready":
        // The webview (re)booted and lost its transcript anchor: resync()
        // forces the next push to be a full snapshot (P-1 blockPatch would
        // apply on top of a transcript the webview no longer holds).
        this.store.resync();
        this.store.pushSnapshot();
        // Wire race (verified): the initial postTheme() in openEditorTab fires
        // before the webview's React message listener exists, so the first
        // theme/auroraIntensity push is dropped and the aurora stays at its
        // CSS default until the setting is touched again. Re-post now that
        // `ready` proves the listener is live.
        this.postTheme();
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
        this.handlePlanExitResponse(msg.id, msg.approved, msg.reason, msg.replan === true);
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
      case "openDiff":
        await this.openToolDiff(msg.toolCallId);
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
        await this.saveAuthAndReconnect(msg.baseUrl, msg.apiKey, msg.modelName, msg.profileName ?? null);
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
      case "loadSession":
        await this.restoreSession(msg.sessionId);
        break;
      case "deleteSession":
        await this.deleteSession(msg.sessionId);
        break;
      case "setSessionFlags":
        this.setSessionFlags(msg.sessionId, msg.pinned, msg.archived);
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
      case "listMcpServers":
        this.sendMcpServers();
        break;
      case "saveMcpServers":
        this.saveMcpServers(msg.servers);
        break;
      case "listApprovalPolicy":
        void this.sendApprovalPolicy();
        break;
      case "saveApprovalPolicy":
        this.saveApprovalPolicy(msg.rules);
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
   */
  private postSound(kind: "done" | "error"): void {
    const cfg = vscode.workspace.getConfiguration("iflow");
    if (cfg.get<boolean>("soundFeedback", true) === false) return;
    this.postToWebview({ type: "playSound", kind });
  }

  // --- M1: OS notifications (P0-5) --------------------------------------------

  /**
   * Native notification for a user-blocking event, gated on
   * setting × panel-visibility × window-focus (turnDone only) × per-kind
   * throttle (shared/notifications.ts). A visible panel already shows the
   * card — the notification exists exactly for when the user switched to the
   * editor and the agent is blocked. Returns whether it fired (informational
   * since the chime became universal — the toast is additive, not an
   * either/or with the sound cue).
   */
  private notifyOs(event: OsNotifyEvent, text: string): boolean {
    const setting = vscode.workspace.getConfiguration("iflow").get<string>("osNotifications", "approvals");
    const gate = gateOsNotification({
      event,
      setting,
      panelVisible: this.panelVisible,
      windowFocused: vscode.window.state.focused,
      nowMs: Date.now(),
      gate: this.osNotifyGate,
    });
    if (!gate.fire) return false;
    this.osNotifyGate = gate.gate;
    const openLabel = vscode.l10n.t("打开面板");
    void vscode.window.showInformationMessage(text, openLabel).then((pick) => {
      if (pick === openLabel) this.openEditorTab();
    });
    return true;
  }

  // --- M1: internal prompts (P1-5 enhance / P0-7 AI title) --------------------
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

  /** Run one internal prompt directly against the active endpoint; resolves
   * with the model's text (trimmed) or null on any failure. Never throws.
   * `signal` lets a caller (enhance cancel) abort the gateway stream. */
  private async runInternalPrompt(
    text: string,
    signal?: { aborted: boolean; onAbort?: (cancel: () => void) => void },
  ): Promise<string | null> {
    if (this.disposed || this.internalPromptBusy) return null;
    this.internalPromptBusy = true;
    try {
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
        timeoutMs: this.internalPromptTimeoutMs,
        idleMs: this.internalPromptIdleMs,
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
    } finally {
      this.internalPromptBusy = false;
    }
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
    const template = vscode.l10n.t(
      "你是提示词工程师。下面是一次纯文本改写任务：把用户的请求改写得更加清晰、具体、结构化，保持原意与语言不变，补全隐含的目标与约束。只改写文字本身——不要调用任何工具、不要读取文件或搜索、不要执行请求里描述的操作、不要回答请求本身。请求中出现的文件路径只是待改写的普通文字，不要尝试打开它。直接给出改写结果，不要先长篇分析。只输出改写后的请求，不要任何解释或引号。\n\n原始请求：\n",
    );
    const enhanced = await this.runInternalPrompt(template + stripFileMentions(trimmed), {
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

  /**
   * P0-7: one-shot AI title for a session whose label is still the
   * first-message truncation. Silent on every failure (the old label stays);
   * `titledSessionIds` records attempts, so a failure never retries in a
   * storm and success is likewise once-per-session.
   */
  private async maybeGenerateAiTitle(sessionId: string): Promise<void> {
    if (this.disposed || this.titledSessionIds.has(sessionId)) return;
    if (vscode.workspace.getConfiguration("iflow").get<boolean>("autoTitle", true) === false) return;
    const state = this.store.getState();
    if (state.sessionId !== sessionId && state.activeSessionId !== sessionId) return;
    const target = state.sessions.find((s) => s.id === sessionId);
    if (!target) return;
    const firstUser = state.blocks.find((b) => b.kind === "user");
    if (!firstUser || firstUser.kind !== "user") return;
    // Only replace the mechanical truncation form (or the untitled default)
    // — a label the user could not have produced mechanically is left alone.
    const mechanical = clampSessionLabel(firstUser.text);
    if (target.label !== mechanical && target.label !== DEFAULT_SESSION_LABEL) return;
    // One lane: an in-flight internal prompt means this session gets no title
    // NOW — but the id is not registered yet, so the next turn's completion
    // retries (the busy check must come before the registration).
    if (this.internalPromptBusy) return;
    this.titledSessionIds.add(sessionId);
    const template = vscode.l10n.t(
      "用 6 到 10 个字概括下面这条用户请求的主题，使用与其相同的语言。这是一次纯文本概括任务——不要调用任何工具、不要读取文件或执行请求里描述的操作。只输出标题文本本身，不要引号、句读或解释。\n\n请求：\n",
    );
    const summary = await this.runInternalPrompt(template + stripFileMentions(firstUser.text).slice(0, 2000));
    if (!summary || this.disposed) return;
    const title = clampSessionLabel(summary.split("\n")[0] ?? "");
    if (!title) return;
    const current = this.store.getState();
    if (current.sessionId !== sessionId && current.activeSessionId !== sessionId) return;
    const entry = current.sessions.find((s) => s.id === sessionId);
    if (!entry) return;
    const sessions = current.sessions.map((s) => (s.id === sessionId ? { ...s, label: title } : s));
    this.store.setSessions(sessions, current.activeSessionId);
    await this.persistSessions(sessions, current.activeSessionId);
    // Keep the transcript file's label in sync with the new title.
    void this.persistActiveTranscript(true);
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
      filters: { "NDJSON log": ["ndjson", "log", "txt"] },
    });
    if (!uri) return;
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(this.wireLog.dump(), "utf8"));
      void vscode.window.showInformationMessage(
        vscode.l10n.t("ACP 日志已导出（{0} 帧，已脱敏）：{1}", this.wireLog.size, uri.fsPath),
      );
    } catch (error) {
      void vscode.window.showErrorMessage(vscode.l10n.t("导出 ACP 日志失败：{0}", errorMessage(error)));
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
    if (typeof toastId === "number") this.store.dismissToast(toastId);
    if (actionId === "compress") {
      this.contextWarnActive = false;
      void this.runCompressTurn();
    }
  }

  /**
   * Drive the `/compress` slash command on the active session (same bridge
   * the overflow path uses, but user-initiated from the warning pill). No
   * user block is recorded — the compression result surfaces as the usual
   * collapsible CompressionBlock.
   */
  private async runCompressTurn(): Promise<void> {
    if (this.historySyncBusy) return;
    const state = this.store.getState();
    if (state.initializing || state.status === "streaming") return;
    const sessionId = state.sessionId;
    if (!sessionId) return;
    const client = await this.ensureClient().catch(() => null);
    if (!client || this.disposed || this.client !== client) return;
    if (this.store.getState().sessionId !== sessionId) return;
    try {
      const result = await this.promptWithRetry(client, sessionId, [{ type: "text", text: "/compress" }]);
      if (this.store.getState().sessionId === sessionId) this.store.promptCompleted(result.stopReason, result.usage);
    } catch (error) {
      if (this.disposed || this.store.getState().sessionId !== sessionId) return;
      this.log.warn(`manual compress failed: ${errorMessage(error)}`);
      this.store.sendToast("warning", vscode.l10n.t("压缩失败：{0}", errorMessage(error)));
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
   */
  private async maybeAutoCompressOnIdle(sessionId: string): Promise<void> {
    if (this.disposed || this.autoCompressInFlight || this.historySyncBusy) return;
    const state = this.store.getState();
    if (state.sessionId !== sessionId) return;
    if (state.initializing || state.replaying || state.status !== "idle") return;
    if (state.pendingApproval || state.pendingPlanExit || state.pendingQuestions) return;
    const usage = state.usage;
    const window = usage?.contextWindow ?? null;
    if (!usage || usage.estimated || window === null || window <= 0) return;
    const ratio = (usage.contextUsed ?? 0) / window;
    if (ratio < CONTEXT_AUTOCOMPRESS_RATIO) return;
    this.autoCompressInFlight = true;
    const toastId = this.store.sendToast(
      "info",
      vscode.l10n.t("上下文接近上限，自动压缩会话…"),
      { displayOnly: true, persistent: true },
    );
    try {
      const client = await this.ensureClient().catch(() => null);
      if (!client || this.disposed || this.client !== client) return;
      if (this.store.getState().sessionId !== sessionId) return;
      const result = await this.promptWithRetry(client, sessionId, [{ type: "text", text: "/compress" }]);
      if (this.disposed || this.store.getState().sessionId !== sessionId) return;
      this.store.promptCompleted(result.stopReason, result.usage);
      this.log.info(
        `turn-end auto-compress on session ${sessionId} (context ratio ${Math.round(ratio * 100)}%)`,
      );
      void this.persistActiveTranscript();
    } catch (error) {
      // The reactive overflow path still guards the next real prompt, so a
      // failed proactive compress is a warning, not an error banner.
      if (this.disposed || this.store.getState().sessionId !== sessionId) return;
      this.log.warn(`turn-end auto-compress failed: ${errorMessage(error)}`);
      this.store.sendToast("warning", vscode.l10n.t("压缩失败：{0}", errorMessage(error)));
    } finally {
      this.autoCompressInFlight = false;
      this.store.dismissToast(toastId);
    }
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

  private persistApprovalRules(rules: ApprovalRule[]): void {
    this.approvalRules = rules;
    void this.context.globalState.update(APPROVAL_POLICY_KEY, serializeApprovalPolicy(rules));
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
    if (changed) this.persistApprovalRules(next);
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

  /** Push the current tables (+ any pending draft) to the policy card. */
  private async sendApprovalPolicy(): Promise<void> {
    const { global, project } = await this.loadApprovalRules();
    this.postToWebview({
      type: "approvalPolicy",
      rules: global,
      projectRules: project,
      draft: this.approvalDraft,
    });
  }

  /** Save the global table (replace semantics — see shared/messages.ts). */
  private saveApprovalPolicy(rules: readonly ApprovalRule[]): void {
    const clean: ApprovalRule[] = [];
    for (const raw of rules.slice(0, APPROVAL_RULES_MAX)) {
      const rule = normalizeApprovalRule(raw, `rule-${clean.length + 1}`);
      if (rule && !clean.some((r) => r.id === rule.id)) clean.push(rule);
    }
    this.persistApprovalRules(clean);
    // Saving from the card resolves the draft either way (the user either
    // kept it in `rules` or threw it away).
    this.approvalDraft = null;
    void this.sendApprovalPolicy();
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
      // M1 P0-5: the agent is BLOCKED until the card is answered — when the
      // panel is hidden this is the notification that matters most.
      this.notifyOs(
        "approval",
        vscode.l10n.t(
          "iFlow 等待审批：{0}（{1} 秒后自动拒绝）",
          notifySummary(approval.title || approval.toolName),
          Math.round(APPROVAL_TIMEOUT_MS / 1000),
        ),
      );
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
    this.cancelAllApprovals(vscode.l10n.t("用户取消"));
    this.cancelAllPlanExits(vscode.l10n.t("用户取消，计划审批已跳过"));
    this.cancelAllPendingQuestions(vscode.l10n.t("用户取消"));
    this.cancelSeen = true;
    this.clearPostRejectionWatchdog();
    const sessionId = this.store.getState().sessionId;
    if (sessionId) this.client?.cancel(sessionId);
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
        this.store.planExitResolutionNote(vscode.l10n.t("计划审批超时，已自动拒绝"));
        this.armPostRejectionWatchdog();
      }, APPROVAL_TIMEOUT_MS);
      this.pendingPlanExits.set(id, { resolve, timer });
      this.store.showPlanExit(pending);
      // M1 P0-5: Plan approval blocks the agent too.
      this.notifyOs(
        "plan",
        vscode.l10n.t("iFlow 等待计划审批（{0} 秒后自动拒绝）", Math.round(APPROVAL_TIMEOUT_MS / 1000)),
      );
    });
  }

  /** Resolve a pending Plan-mode exit from the webview's answer. */
  private handlePlanExitResponse(id: string, approved: boolean, reason?: string, replan = false): void {
    const pending = this.pendingPlanExits.get(id);
    if (!pending) return;
    this.pendingPlanExits.delete(id);
    clearTimeout(pending.timer);
    this.store.clearPlanExit(id);
    // Replan with edited plan text: the reason IS the revised plan the user
    // wrote in the card's edit mode — surface a truncated excerpt in the
    // resolution note so the transcript records what changed (the full text
    // goes to the agent via the resolve below; the note is display-only).
    this.store.planExitResolutionNote(
      replan
        ? reason
          ? vscode.l10n.t("重新规划：{0}", reason.length > 80 ? `${reason.slice(0, 80)}…` : reason)
          : vscode.l10n.t("重新规划")
        : approved
          ? vscode.l10n.t("已批准计划")
          : reason ?? vscode.l10n.t("已拒绝计划"),
    );
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
    pending.resolve({
      approved,
      reason: approved ? undefined : reason ?? vscode.l10n.t("用户拒绝了该计划"),
    });
  }

  /** Cancel every pending Plan exit (client died / replaced) without hanging the agent. */
  private cancelAllPlanExits(reason: string): void {
    for (const [id, pending] of this.pendingPlanExits) {
      clearTimeout(pending.timer);
      this.store.clearPlanExit(id);
      this.store.planExitResolutionNote(reason);
      pending.resolve({ approved: false, reason });
    }
    this.pendingPlanExits.clear();
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
      // M1 P0-5: the agent blocks on the answers too.
      this.notifyOs(
        "question",
        vscode.l10n.t("iFlow 有问题需要你回答（{0} 秒后自动继续）", Math.round(APPROVAL_TIMEOUT_MS / 1000)),
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
        vscode.l10n.t("无法写入 {0}（文件缺失或不可读），CLI 配置未同步", settingsFilePath()),
      );
      return;
    }
    this.log.info(`CLI settings synced to settings.json: ${Object.keys(patch).join(", ")}`);
    const restartLabel = vscode.l10n.t("立即重启");
    void vscode.window
      .showInformationMessage(
        vscode.l10n.t("已写入 CLI 配置，重启 CLI 后生效"),
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
    if (this.historySyncBusy) return;
    const state = this.store.getState();
    if (state.status === "streaming" || state.initializing) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("正在生成中，请等待完成或先停止，再重启 CLI"),
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
    this.cancelAllApprovals(vscode.l10n.t("CLI 已重启"));
    this.cancelAllPlanExits(vscode.l10n.t("CLI 已重启，计划审批已跳过"));
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

  /** MCP card opened: reply with the CURRENT mcpServers dict from
   * settings.json. A missing/absent field is an empty dict (a fresh CLI
   * install simply has none), not an error. */
  private sendMcpServers(): void {
    const settings = readCliSettings();
    if (!settings) {
      this.postToWebview({
        type: "mcpServers",
        servers: {},
        error: vscode.l10n.t("无法读取 {0}（文件缺失或不可读）", settingsFilePath()),
      });
      return;
    }
    this.postToWebview({ type: "mcpServers", servers: settings.mcpServers ?? {} });
  }

  /** MCP card saved: replace the whole dict in settings.json (see the
   * replace-semantics note on the WebviewToHost message), then offer the
   * same hot-restart affordance as the language/approvalMode sync path —
   * the CLI only reads mcpServers at startup. */
  private saveMcpServers(servers: Record<string, unknown>): void {
    if (!updateCliSettings({ mcpServers: servers })) {
      this.postToWebview({
        type: "mcpServers",
        servers,
        error: vscode.l10n.t("无法写入 {0}（文件缺失或不可读），MCP 配置未保存", settingsFilePath()),
      });
      return;
    }
    this.log.info(`MCP servers saved: ${Object.keys(servers).join(", ") || "(none)"}`);
    this.postToWebview({ type: "mcpServers", servers });
    const restartLabel = vscode.l10n.t("立即重启");
    void vscode.window
      .showInformationMessage(
        vscode.l10n.t("已写入 CLI 配置，重启 CLI 后生效"),
        restartLabel,
      )
      .then((choice) => {
        if (choice === restartLabel) void this.restartCli();
      });
  }

  /**
   * All known API profiles: extension-owned (SecretStorage, editable) merged
   * with the CLI settings.json ones (read-only source, the user's existing
   * configs). The active profile name drives the `active` flag.
   */
  private async buildProfileList(): Promise<AuthUiState["profiles"]> {
    const extProfiles = await loadProfiles(this.context.secrets);
    const cli = readCliSettings();
    // Active-name resolution is CLI-first: settings.json is what the CLI
    // loads on startup and what external tools (profile manager / cloud sync)
    // rewrite behind our back. The extension's own record only fills in for
    // fresh installs where currentApiProfile isn't set yet.
    const workspaceName = this.context.workspaceState.get<string>(WORKSPACE_PROFILE_KEY)?.trim();
    const activeName = workspaceName || resolveActiveProfileName(cli, await getActiveProfileName(this.context.secrets));
    const list: AuthUiState["profiles"] = [];
    const push = (name: string, source: "extension" | "cli", p: OpenAiCompatCredentials) => {
      list.push({
        name,
        source,
        baseUrl: p.baseUrl,
        modelName: p.modelName,
        keyTail: maskKey(p.apiKey),
        active: name === activeName,
      });
    };
    for (const [name, p] of Object.entries(extProfiles)) {
      push(name, "extension", p);
    }
    for (const [name, p] of Object.entries(cli?.apiProfiles ?? {})) {
      // CLI profiles whose name collides with an extension profile are shadowed
      // (the extension one is what authenticate will use).
      if (!extProfiles[name] && p.baseUrl && p.apiKey && p.modelName) {
        push(name, "cli", { baseUrl: p.baseUrl, apiKey: p.apiKey, modelName: p.modelName });
      }
    }
    return list;
  }

  private async buildAuthState(authenticated: boolean, needsSetup: boolean): Promise<AuthUiState> {
    // P7: computed fresh every call — the old cache went stale between write
    // points (e.g. `saved` outliving a deleted profile until the next save).
    // Resolve this workspace's profile first; the SecretStorage credentials
    // slot is shared by all windows and is not a per-panel source of truth.
    const creds = (await this.resolveWorkspaceHandshakeCreds()) ?? (await loadCredentials(this.context.secrets));
    return {
      authenticated,
      needsSetup,
      saved: creds ? this.maskOf(creds) : null,
      profiles: await this.buildProfileList(),
    };
  }

  private async saveAuthAndReconnect(
    baseUrl: string,
    apiKey: string | null,
    modelName: string,
    profileName: string | null,
  ): Promise<void> {
    const stored = (await this.resolveWorkspaceHandshakeCreds()) ?? (await loadCredentials(this.context.secrets));
    const validation = validateCredentials({
      baseUrl,
      apiKey: apiKey ?? stored?.apiKey ?? null,
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
    const profiles = await loadProfiles(this.context.secrets);
    profiles[name] = { baseUrl: creds.baseUrl, apiKey: creds.apiKey, modelName: creds.modelName };
    await saveProfiles(this.context.secrets, profiles);
    // The active-profile pointer and credentials slot are global SecretStorage
    // values shared by every VS Code window. The workspace record plus the
    // explicit credentials passed below are the authority for this panel.
    await this.context.workspaceState.update(WORKSPACE_PROFILE_KEY, name);
    await this.rememberWorkspaceModelFor(name, creds.modelName);

    await this.reconnectWithCredentials(creds);
  }

  /** Switch the active API profile and re-authenticate the session. */
  private async activateProfile(name: string): Promise<void> {
    if (this.historySyncBusy) return;
    const profiles = await loadProfiles(this.context.secrets);
    let creds: OpenAiCompatCredentials | null = profiles[name]
      ? { ...profiles[name] }
      : this.cliProfileCredentials(name);
    if (!creds) {
      vscode.window.showWarningMessage(vscode.l10n.t("未找到 API 配置: {0}", name));
      return;
    }
    // User directive (2026-10-06): a profile switch must not silently drop
    // the conversation — ask first. Only meaningful with a live session;
    // without one the switch is just the initial connect. "Stay" reloads the
    // SAME conversation via session/load under the new credentials — a live
    // ACP session keeps the OLD endpoint after hot authenticate, only
    // new/load rebuild config from the updated authOptions (bundle-verified,
    // CLI 0.5.19, see reloadSessionUnderCreds).
    const liveSessionId = this.store.getState().sessionId;
    let keepSession = false;
    if (liveSessionId) {
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
    // workspace record and explicit `creds` remain isolated instead.
    // CLI-sourced profiles are recorded by name too — the next handshake
    // re-resolves them from settings.json.
    await this.context.workspaceState.update(WORKSPACE_PROFILE_KEY, name);
    if (!this.workspaceModelId(name)) {
      await this.rememberWorkspaceModelFor(name, creds.modelName);
    }
    await this.reconnectWithCredentials(creds, keepSession);
  }

  /** Read a profile from CLI settings.json (read-only source). */
  private cliProfileCredentials(name: string): OpenAiCompatCredentials | null {
    const cli = readCliSettings();
    const p = cli?.apiProfiles?.[name];
    if (!p?.baseUrl || !p?.apiKey || !p?.modelName) return null;
    return { baseUrl: p.baseUrl, apiKey: p.apiKey, modelName: p.modelName };
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
    const creds = profiles[trimmed] ? { ...profiles[trimmed] } : this.cliProfileCredentials(trimmed);
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
    const profiles = await loadProfiles(this.context.secrets);
    if (!profiles[name]) return; // CLI-sourced profiles are read-only
    delete profiles[name];
    await saveProfiles(this.context.secrets, profiles);
    // Drop this workspace's memory of the deleted profile so the next
    // handshake doesn't resolve a stale name (falls back to the global slot).
    if (this.context.workspaceState.get<string>(WORKSPACE_PROFILE_KEY) === name) {
      await this.context.workspaceState.update(WORKSPACE_PROFILE_KEY, undefined);
    }
    const workspaceName = this.context.workspaceState.get<string>(WORKSPACE_PROFILE_KEY)?.trim();
    if (workspaceName === name) {
      this.store.setAuth(await this.buildAuthState(false, true));
      return; // this workspace's profile was deleted → choose another profile
    }
    this.store.setAuth(await this.buildAuthState(this.store.getState().auth.authenticated, false));
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
      const hotSessionId = this.store.getState().sessionId;
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
        // (The old re-stamp of currentApiProfile is gone: the CLI-side
        // api-config-isolation patch keeps the panel-owned fields out of the
        // settings write-back entirely, and the active pointer's authority is
        // the SecretStorage record — resolveActiveProfileName is
        // extension-first.)
        // keepSession: reload the SAME conversation in place under the new
        // credentials — the transcript never clears (seamless). Only the
        // CLI-side session object is rebuilt (session/load, same id).
        if (keepSession && hotSessionId) {
          const reloaded = await this.reloadSessionUnderCreds(hotSessionId, creds);
          if (reloaded) {
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
          this.discardedSessionIds.add(hotSessionId);
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
        await this.startNewSession();
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
      await client.loadSession({ cwd, mcpServers: [], sessionId });
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

  private onSessionUpdate(n: Parameters<SessionStore["onSessionUpdate"]>[0]): void {
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
        // M1 P0-5: long-running execute-class tools earn a native notification
        // when they finally land AND the user is not watching the panel.
        // `kind` rides only the initial tool_call (probed, CLI 0.5.19 — the
        // update events omit it), so timing starts there (pending→in_progress
        // drift is milliseconds). Record UNCONDITIONALLY: the common case is
        // a tool that starts while the user watches and finishes after they
        // switch away — gating the recording on current visibility would drop
        // exactly those. The terminal event clears the entry either way; the
        // notification itself re-passes the full gate (visibility may have
        // changed mid-tool).
        // The SubAgent-spawning `task` call is EXCLUDED: its terminal update
        // lands MID-TURN — the parent keeps generating after the subagent
        // returns — so the toast fired at subagent landing while the panel
        // still showed 正在生成, reading as a premature "your task finished"
        // (user report 2026-10-13: 「长任务已完成（运行 306 秒）：Task」 mid-turn;
        // the opaque title "Task" reinforces the misreading). Subagent progress
        // has its own card; real completion is trigger 3 (turnDone).
        if (
          update.sessionUpdate === "tool_call" &&
          update.kind === "execute" &&
          !isTaskToolCall(update) &&
          update.status !== "completed" &&
          update.status !== "failed"
        ) {
          if (this.runningToolStarts.size >= ChatPanel.RUNNING_TOOL_CAP) {
            const oldest = this.runningToolStarts.keys().next().value;
            if (oldest !== undefined) this.runningToolStarts.delete(oldest);
          }
          this.runningToolStarts.set(update.toolCallId, {
            startedAt: Date.now(),
            title: typeof update.title === "string" && update.title ? update.title : null,
          });
        } else if (update.status === "completed" || update.status === "failed") {
          const entry = this.runningToolStarts.get(update.toolCallId);
          if (entry !== undefined) {
            this.runningToolStarts.delete(update.toolCallId);
            if (Date.now() - entry.startedAt >= LONG_TOOL_NOTIFY_MS) {
              const rawTitle =
                (typeof update.title === "string" && update.title ? update.title : entry.title) ?? update.toolCallId;
              const title = notifySummary(rawTitle);
              const secs = Math.round((Date.now() - entry.startedAt) / 1000);
              // A failed tool must never be announced as 已完成 — the parent
              // agent usually keeps going (retry / recovery), so a "completed"
              // toast for an errored tool is doubly wrong.
              this.notifyOs(
                "longTool",
                update.status === "failed"
                  ? vscode.l10n.t("长任务失败（运行 {0} 秒）：{1}", secs, title)
                  : vscode.l10n.t("长任务已完成（运行 {0} 秒）：{1}", secs, title),
              );
            }
          }
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
   * re-auth): a stale snapshot or long-tool start timestamp from the previous
   * session must never be compared against a same-id tool call in the new
   * one. */
  private clearToolCaches(): void {
    this.preSnapshots.clear();
    this.toolArgs.clear();
    this.runningToolStarts.clear();
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
    this.store.setInitializing(true);
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
        vscode.l10n.t("当前 iFlow CLI 不支持会话恢复（loadSession 能力未声明）"),
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
    // Capture before the state swap: if the switch succeeds, an abandoned
    // empty active session must not linger in the switcher.
    const outgoingId = this.store.getState().activeSessionId ?? this.store.getState().sessionId;
    this.log.info(`restoring session ${sessionId} …`);
    this.restoring = true;
    this.restoringSessionId = sessionId;
    this.replayTitle = null;
    this.sessionCwd = workspaceRoot;
    const fresh = newSessionState(this.store.getState());
    beginReplay(fresh);
    fresh.activeSessionId = sessionId;
    this.store.replaceState(fresh);
    try {
      // CLI 0.5.19 wire behavior: an empty/short session's loadSession response
      // carries ONLY {sessionId} — no modes, no _meta. A prior session/new does
      // return the full meta, so fetch it first (also warms up the CLI).
      // R4: the probe session itself is deliberately discarded — only its
      // meta/modes are used. The CLI owns that session's lifecycle (ACP-mode
      // sessions are not persisted and die with the CLI process); this is not
      // a leak.
      const probe = await client.newSession({ cwd: workspaceRoot, mcpServers: [] });
      const probeMeta: NewSessionMeta | undefined = probe._meta;
      const session = await client.loadSession({ cwd: workspaceRoot, mcpServers: [], sessionId });
      const meta: NewSessionMeta | undefined = probeMeta ?? session._meta;
      const modes = session.modes ?? probe.modes;
      endReplay(this.store.getState());

      // Rebuild the transcript from the CLI's session file (NDJSON).
      const loadedId = session.sessionId;
      const restored = await this.loadPersistedTranscript(loadedId);
      if (restored.blocks.length === 0) {
        restored.blocks.push({
          kind: "text",
          text: vscode.l10n.t("已恢复会话上下文（CLI 未持久化该会话的历史记录，故此处无历史消息，但对话可继续）。"),
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
      await this.loadCheckpointIndex(loadedId);
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
      if (currentModelId && currentModelId !== restoreCliModelId) {
        const pushId = await this.validateModelForPush(modelsPromise, currentModelId, restoreCliModelId);
        if (pushId) await this.setModel(pushId);
      }
      this.log.info(`session restored: ${loadedId} (${restored.blocks.length} blocks)`);
      await this.cleanupEmptySession(outgoingId);
      await this.recordSession(loadedId, restored.firstUserText ? clampSessionLabel(restored.firstUserText) : null);
      void this.persistActiveTranscript(true); // seed the extension-owned copy
      void vscode.window.showInformationMessage(vscode.l10n.t("已恢复会话"));
      return true;
    } catch (error) {
      const message = errorMessage(error);
      endReplay(this.store.getState());
      this.log.error(`session restore failed: ${message}`);
      this.store.markError(vscode.l10n.t("会话恢复失败：{0}", message));
      // Async failure — the user is likely in the editor; cue it.
      this.postSound("error");
      // Do NOT forget the session here: the transcript file still exists and
      // the failure is often transient (CLI boot hiccup, endpoint down, auth
      // not ready). Forgetting would drop it from the switcher, and the next
      // pruneUnrestorableSessions would delete the orphaned transcript file —
      // turning a retryable failure into irreversible content loss. The user
      // can still remove it explicitly via the switcher's delete.
      return false;
    } finally {
      this.restoring = false;
      this.restoringSessionId = null;
      this.replayTitle = null;
    }
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

      const client = new AcpClient(
        // Generous control-plane timeout: a CLI with many MCP servers can take
        // 30-60s+ before its first initialize response.
        // IFLOW_HARNESS=1 marks our subprocess tree so local cleanup scripts
        // can exclude it (the renamed binary only defeats name-based kills),
        // and switches on the CLI-side api-config-isolation patch — without
        // it (plain CLI / TUI / -p) the settings write-back is untouched.
        { command: runtime, args, cwd: workspaceRoot, env: { IFLOW_HARNESS: "1" }, requestTimeoutMs: 120_000, allowedRoots, wireTap: this.wireLog.tap },
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
            this.cancelAllApprovals(vscode.l10n.t("CLI 进程已退出"));
            this.cancelAllPlanExits(vscode.l10n.t("CLI 进程已退出，计划审批已跳过"));
            this.cancelAllPendingQuestions(vscode.l10n.t("CLI 进程已退出，提问已跳过"));
            this.store.markError(vscode.l10n.t("iFlow CLI 进程已退出，重新打开面板可重试"));
            // Async failure — the user is likely in the editor; cue it.
            this.postSound("error");
          },
          onRequestPermission: async (req: RequestPermissionRequest) => {
            // Dying client's approval cards would hang on the fresh state —
            // auto-cancel instead (the process is being torn down anyway).
            if (this.client !== client || this.disposed) {
              return { outcome: { outcome: "cancelled" } as const };
            }
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
    // Restore the exec bit on vendored binaries (ripgrep) — the VSIX zip
    // chain drops unix mode bits and the CLI's search tools then fail with
    // EACCES when spawning rg (seen on 1.2.3 / macOS).
    ensureVendorBinariesExecutable(vendoredCliDir);
    try {
      return resolveVendoredEntry(this.context.extensionPath);
    } catch (error) {
      throw new Error(
        vscode.l10n.t("内置 iFlow CLI 缺失，扩展包不完整，请重新安装：{0}", errorMessage(error)),
      );
    }
  }

  // --- Mode / model switching ---------------------------------------------------
  // Wire behavior (probed, CLI 0.5.19): both return `{success, currentModeId |
  // currentModelId}` and the agent does NOT emit `current_mode_update`, so the
  // response must be written back into the store or the dropdown snaps back.

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
   */
  private async queryLiveModels(): Promise<SessionState["models"]> {
    // Extension-first: the panel's active endpoint is its SecretStorage
    // credentials — the CLI-side api-config-isolation patch keeps them out of
    // the shared settings.json, so the shared currentApiProfile is no longer
    // what this panel's child authenticates with (the old CLI-first rule existed because external
    // tools rewrote the SHARED currentApiProfile behind our back — that no
    // longer reaches us). The CLI settings read stays as a fallback for
    // setups where only CLI-side profiles exist.
    const endpoint = (await this.resolveWorkspaceHandshakeCreds()) ?? (await loadCredentials(this.context.secrets)) ?? readActiveEndpoint();
    if (!endpoint) return [];
    try {
      return (await queryModelIds(endpoint)).map((id) => ({ id, name: id }));
    } catch (error) {
      const message = errorMessage(error);
      this.log.warn(
        vscode.l10n.t("模型列表查询失败（不回退 CLI 内置目录）: {0}", message),
      );
      return [];
    }
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
    const models = await this.queryLiveModels();
    if (models.length === 0) return;
    const currentModelId = this.store.getState().currentModelId;
    if (currentModelId && !models.some((m) => m.id === currentModelId)) {
      models.unshift({ id: currentModelId, name: currentModelId });
    }
    this.store.sessionMeta({ models });
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
            models: currentModelId ? [{ id: currentModelId, name: currentModelId }] : [],
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
        this.store.sessionMeta({ models, ...(currentModelId ? { currentModelId } : {}) });
      })
      .catch((error: unknown) => {
        // queryLiveModels swallows endpoint errors into []; only unexpected
        // storage failures reject — never let them become unhandled.
        this.log.warn(vscode.l10n.t("模型列表查询失败（不回退 CLI 内置目录）: {0}", errorMessage(error)));
      });
  }

  private async startNewSession(): Promise<void> {
    if (this.historySyncBusy) return;
    // A3: never start a session into a destroyed panel.
    if (this.disposed) throw new DisposedError();
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
    const inFlight = this.store.getState().sessionId;
    if (inFlight) {
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
    // Mutual exclusion: a session restore is in flight — running a reset
    // CONCURRENTLY let the restore's replayed updates (and the in-flight
    // session/new's late sessionStarted) interleave into one transcript
    // (user-reported: old content + "正在创建新会话…" + empty-state on screen
    // together). Refuse until the restore settles.
    if (this.restoring) {
      this.log.warn("new session refused: a session restore is in flight");
      this.store.appendNotice(vscode.l10n.t("正在恢复历史会话，请稍后再新建会话"));
      return;
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
    // Open the reset window: until the new session is established (finally),
    // onSessionUpdate drops everything not addressed to the store's own
    // session — this is what catches the abandoned turn's trailing updates
    // that arrive WITHOUT a sessionId (they pass both id guards otherwise).
    this.droppingForReset = true;
    // Lock the UI while the CLI spins up the new session (sessions/mode/model
    // switches must not race the in-flight `session/new`).
    this.store.setInitializing(true);
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
    const session = await client.newSession({ cwd: workspaceRoot, mcpServers: [] });
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
  ): Promise<void> {
    const trimmed = text.trim();
    const hasContexts = (contexts?.length ?? 0) > 0;
    if (!trimmed && !hasContexts) return;
    // A3: the panel was disposed (window close / extension reload) — the
    // store is gone, so there is nothing to send.
    if (this.disposed) return;
    // M2 P0-3: a turn is streaming — the composer no longer blocks typing,
    // so this is the QUEUE path (roadmap: Enter while generating = enqueue).
    // replaying/historySyncBusy stay rejected: beginReplay also reports
    // "streaming", and a queue entry typed during a restore would race the
    // transcript the restore is rebuilding.
    const gateState = this.store.getState();
    if (gateState.status === "streaming") {
      if (gateState.replaying || this.historySyncBusy) {
        this.log.info("sendPrompt rejected: replay/history-sync in flight");
        return;
      }
      this.enqueuePrompt(trimmed, images, files, contexts);
      return;
    }
    // Context cards (right-click selection + @folder/@problems/@git/@url):
    // each becomes a titled fenced section ahead of the typed text. Sections
    // ride RAW — the composed text starts with a section title, never with
    // "/", so the CLI's command gate cannot misfire; only the typed part
    // goes through toAgentPromptText (its "/"-escape must not touch code).
    const contextBlock = hasContexts
      ? assembleContextSections(contexts!, (c) => this.contextSectionTitle(c))
      : "";
    const fullText = [contextBlock, trimmed].filter(Boolean).join("\n\n");
    // The agent sees the attachment list inline: absolute paths it can read
    // with its own tools. The transcript block (beginUserPrompt) mirrors the
    // same list so the UI matches what was actually sent.
    const attachmentBlock =
      files && files.length > 0
        ? `\n\n${vscode.l10n.t("用户附带以下本地文件（可按需读取）：")}\n${files
            .map((f) => `- ${f.name} → ${f.path}`)
            .join("\n")}`
        : "";
    // The agent-facing text escapes "/"-leading non-commands in the TYPED
    // part (CLI would otherwise answer "Unknown command" and the model never
    // sees the text); the transcript keeps the composed verbatim input.
    const promptText =
      [contextBlock, toAgentPromptText(trimmed, this.store.getState().commands)]
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
      return;
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
      this.store.userPrompt(
        fullText,
        (images ?? []).map((img) => `data:${img.mimeType};base64,${img.data}`),
        files,
      );
      void this.labelSessionWithPrompt(fullText);
      void this.persistActiveTranscript(); // user turn lands even on a crash
      // M3 P0-1: snapshot the workspace BEFORE the agent runs so this turn's
      // file changes are revertible. Awaited — a parallel capture would race
      // the agent's writes and bake them into the "before" snapshot. Best
      // effort: a partial capture never blocks the prompt.
      {
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
      // Session replaced mid-flight (新会话/profile switch cancelled the
      // in-flight turn): the completion must not settle the NEW session's
      // state (or overwrite its usage estimate) — drop like the catch path.
      if (this.store.getState().sessionId !== promptSessionId) {
        this.log.info(`prompt completed after session switch — dropped (session replaced)`);
        return;
      }
      this.store.promptCompleted(result.stopReason, result.usage);
      // Completion cue, but a user stop/cancel stays silent. The chime is the
      // universal cue (postSound); the native toast is the ADDITIVE
      // away-notification (M1 P0-5) with its own gate — no longer mutually
      // exclusive, the exclusivity made the chime unreachable for away users
      // on `osNotifications: all` (user report 2026-10-13).
      if (result.stopReason !== "cancelled") {
        // M1 P0-5: the turn landed while the user is away — tell them it's
        // ready.
        this.notifyOs("turnDone", vscode.l10n.t("iFlow 已完成本轮回复"));
        this.postSound("done");
        // M1 P0-7: the first completed turn is the AI-title window (no-op
        // unless the label is still the mechanical truncation).
        if (promptSessionId) void this.maybeGenerateAiTitle(promptSessionId);
      }
      void this.persistActiveTranscript();
      void this.touchActiveSession();
      // Turn-end proactive compression (see maybeAutoCompressOnIdle): a user
      // Stop (cancelled) skips it — the user is steering, and firing a
      // compress turn right after they pressed Stop reads as "won't stop".
      // Awaited so a queued next message rides the SMALLER context.
      if (result.stopReason !== "cancelled") {
        await this.maybeAutoCompressOnIdle(promptSessionId);
      }
      // M2 P0-3: the turn settled — the idle slot is free, feed it the next
      // queued message (no-op when the queue is empty). A user Stop
      // (cancelled) also drains: Stop interrupts the CURRENT turn, the queue
      // keeps steering (roadmap Steer semantics).
      void this.dispatchQueue();
    } catch (error) {
      // A3: the panel was disposed mid-flight — the store is gone, so there
      // is nothing to mark and nothing to persist.
      if (this.disposed) {
        this.log.info(`prompt dropped after dispose: ${errorMessage(error)}`);
        return;
      }
      // Session replaced mid-flight (profile switch cancels the in-flight
      // prompt): the rejection lands after the fresh state is in place, so
      // the old turn's failure must not mark the new session errored — and
      // persistActiveTranscript would serialize the emptied blocks over the
      // NEW session's file. Drop everything but the log line.
      if (this.store.getState().sessionId !== promptSessionId) {
        this.log.info(`prompt failed after session switch — dropped (session replaced)`);
        return;
      }
      // R1 (final): prompts run without a timeout — failures here are real
      // errors (CLI died, connection closed), not slow turns. Long turns are
      // stopped by the user via Stop (`session/cancel`).
      // The banner shows the extracted message; the log gets the full
      // envelope + recent CLI stderr so "[object Object]-shaped" failures
      // remain diagnosable from the Output panel.
      this.log.error(`prompt failed: ${this.formatErrorForLog(error)}`);
      this.store.markError(errorMessage(error));
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
    }
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
    let lastUserText: string | null = null;
    for (let i = state.blocks.length - 1; i >= 0; i--) {
      const b = state.blocks[i];
      if (!b) continue;
      if (b.kind === "user") {
        lastUserText = b.text;
        break;
      }
    }
    if (!lastUserText || !lastUserText.trim()) return;
    this.cancelSeen = false;
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
      const prompt: ContentBlock[] = [
        { type: "text", text: toAgentPromptText(lastUserText.trim(), this.store.getState().commands) },
      ];
      const result = await this.promptWithRetry(client, promptSessionId, prompt);
      // Session replaced mid-flight: the completion must not settle the NEW
      // session's state — drop like the sendPrompt success path.
      if (this.store.getState().sessionId !== promptSessionId) {
        this.log.info(`regenerate completed after session switch — dropped (session replaced)`);
        return;
      }
      this.store.promptCompleted(result.stopReason, result.usage);
      // Same completion cue policy as sendPrompt (chime universal, toast
      // additive) — a regenerated turn landing while the user is away must
      // announce itself too.
      if (result.stopReason !== "cancelled") {
        this.notifyOs("turnDone", vscode.l10n.t("iFlow 已完成本轮回复"));
        this.postSound("done");
        // Same turn-end proactive compression policy as sendPrompt.
        await this.maybeAutoCompressOnIdle(promptSessionId);
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
      void this.persistActiveTranscript();
      void this.touchActiveSession();
      this.postSound("error");
    }
  }

  /**
   * M2 P0-3: queue a prompt typed while a turn streams (roadmap: Enter during
   * generation = enqueue; the queue is host-owned, FIFO, capped at
   * QUEUE_MAX). The UI projection rides the snapshot tail; the heavy payload
   * (images/files/contexts) stays in `queuePayloads` so base64 never
   * serializes onto every blockPatch.
   */
  private enqueuePrompt(
    text: string,
    images?: { data: string; mimeType: string }[],
    files?: { name: string; path: string }[],
    contexts?: ContextRefUi[],
  ): void {
    const state = this.store.getState();
    const id = `q-${Date.now().toString(36)}-${++this.queueSeqSeed}`;
    const attachments = [
      ...(images ?? []).map((_, i) => vscode.l10n.t("图片{0}", i + 1)),
      ...(files ?? []).map((f) => f.name),
    ];
    const entry: QueuedPromptUi = { id, text, attachments, enqueuedAt: Date.now() };
    const { queue, ok } = enqueuePromptUi(state.queue ?? [], entry);
    if (!ok) {
      this.store.sendToast("warning", vscode.l10n.t("队列已满（最多 {0} 条），本条未加入", QUEUE_MAX));
      return;
    }
    this.queuePayloads.set(id, { images, files, contexts });
    this.store.setQueue(queue, state.queuePaused ?? false);
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
    }
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
        if (rows.length === 0) {
          reply("", "", "", vscode.l10n.t("当前没有诊断信息"));
          return;
        }
        rows.sort((a, b) => a.sev - b.sev || a.path.localeCompare(b.path) || a.line - b.line);
        const capped = rows.slice(0, 200);
        let body = formatDiagnosticsReport(
          capped.map((r) => ({
            path: r.path,
            line: r.line,
            severityLabel: SEVERITY_LABELS[r.sev] ?? vscode.l10n.t("其他"),
            message: r.message,
          })),
        );
        if (rows.length > capped.length) {
          body += `\n${vscode.l10n.t("…（共 {0} 条，仅列出前 200 条）", rows.length)}`;
        }
        reply(vscode.l10n.t("工作区诊断"), vscode.l10n.t("{0} 条", rows.length), body);
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
  private async deleteUserMessage(blockId: string): Promise<void> {
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
    this.store.setInitializing(true);
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
          await client.loadSession({ cwd, mcpServers: [], sessionId });
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
              await client.loadSession({ cwd, mcpServers: [], sessionId });
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
    await this.deleteUserMessage(blockId);
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
        const blocks: ContentBlock[] = compressNext
          ? [{ type: "text", text: "/compress" }]
          : prompt;
        // Fresh output flag per attempt: the gate below judges THIS attempt
        // only (a compress turn's own output must not mask an empty resend).
        this.turnHadAgentOutput = false;
        // M4 P1-1: auto-approval transcript notes dedupe per turn — a new
        // attempt (or turn) may legitimately re-note the same rule hit.
        this.autoApprovalNoted.clear();
        try {
          const result = await client.prompt({ sessionId, prompt: blocks });
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
      vscode.l10n.t("已按快照上限清理 {0} 个快照仓库（释放约 {1} MB）", removed.size, Math.round(freedBytes / (1024 * 1024))),
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
      await this.deleteUserMessage(userBlockId);
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
