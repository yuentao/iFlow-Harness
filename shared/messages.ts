/**
 * Extension Host ↔ WebView message protocol (type-safe both sides).
 * Snapshot model per plan §2.1: the Extension Host owns the full session
 * state; the WebView is a projection that receives throttled snapshots.
 */

import type {
  NewSessionMeta,
  SessionModeState,
  SlashCommand,
  ToolCallStatus,
  ToolKind,
  ToolLocation,
  StopReason,
  UserQuestion,
  UserQuestionOption,
} from "../src/acp/protocol.js";

// Webview components import wire types from this module — re-export the
// protocol types they need.
export type { SlashCommand, UserQuestion, UserQuestionOption };

// ---------------------------------------------------------------------------
// Transcript blocks (rendered in order)
// ---------------------------------------------------------------------------

/** Structured diff carried by `tool_call_update` content blocks. */
export interface ToolDiffUi {
  path: string;
  oldText: string | null;
  newText: string | null;
}

/**
 * Fields shared by every transcript block. `id` is assigned by the reducer at
 * creation and backfilled on restore (P4): it anchors the block list's React
 * keys and memo, so in-place middle-list updates (`upsertToolBlock`,
 * `adoptUnboundSubAgent`) can no longer misalign component instances. It is
 * optional only for transcripts persisted before P4 — the host backfills
 * those on load.
 */
export interface BlockBase {
  id?: string;
}

export interface TextBlock extends BlockBase {
  kind: "text";
  text: string;
}

export interface ThoughtBlock extends BlockBase {
  kind: "thought";
  text: string;
}

export interface UserBlock extends BlockBase {
  kind: "user";
  text: string;
  /** Attached images as data URLs (M5 image input), absent for text-only prompts. */
  images?: string[];
}

export interface ToolBlock extends BlockBase {
  kind: "tool";
  toolCallId: string;
  toolName: string;
  title: string;
  toolKind: ToolKind;
  status: ToolCallStatus;
  output: string;
  locations: ToolLocation[];
  /** Present when the update carried a structured diff (`type: "diff"`). */
  diff: ToolDiffUi | null;
  /**
   * C4: the tool succeeded but its change was reverted (UI-only marker).
   * Orthogonal to `status` — marking reverted tools as `failed` leaked the
   * "failed" aggregate into SubAgent cards nesting successful tools.
   */
  reverted?: boolean;
}

/**
 * iFlow SubAgent (`task` tool): its lifecycle events and all nested updates
 * carry an `agentId` on the wire. One block per SubAgent; nested tool calls
 * and message chunks are grouped into `entries`.
 */
export interface SubAgentBlock extends BlockBase {
  kind: "subagent";
  /** Wire grouping key (the real agentId; a task tool_call without one uses its toolCallId until bound). */
  agentId: string;
  /** toolCallId of the spawning `task` tool_call, when seen. */
  taskToolCallId: string | null;
  title: string;
  status: ToolCallStatus;
  /** SubAgent type parsed from the task title, e.g. "general-purpose" — drives the card accent color. */
  agentType: string | null;
  entries: Block[];
}

export interface PlanBlock extends BlockBase {
  kind: "plan";
  entries: PlanEntryUi[];
}

export interface PlanEntryUi {
  content: string;
  status?: "pending" | "in_progress" | "completed";
  priority?: "high" | "medium" | "low";
}

/**
 * Context compression (slash `/compress`, CLI 0.5.19): the ACP bridge leaks
 * the compression history item as a JSON text chunk; the host sanitizer turns
 * it into this collapsible card instead of raw JSON garbage.
 */
export interface CompressionBlock extends BlockBase {
  kind: "compression";
  /** One-line human notice, e.g. "上下文已压缩：98134 → 7855 tokens". */
  notice: string;
  /** Conversation summary carried by the item — long, so the webview folds it. */
  summary: string | null;
}

export type Block = TextBlock | ThoughtBlock | UserBlock | ToolBlock | SubAgentBlock | CompressionBlock | PlanBlock;

// ---------------------------------------------------------------------------
// Full session state (owned by Extension Host store)
// ---------------------------------------------------------------------------

export interface ModelInfoUi {
  id: string;
  name: string;
  thinking?: boolean;
}

export type AgentStatus = "connecting" | "idle" | "streaming" | "error";

/** One option of a pending `session/request_permission` call, as offered by the agent. */
export interface PermissionOptionUi {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

/** A tool-execution approval the user must answer before the agent continues. */
export interface PendingApprovalUi {
  id: string;
  toolName: string;
  title: string;
  toolKind: ToolKind;
  locations: ToolLocation[];
  options: PermissionOptionUi[];
}

/**
 * The `ask_user_question` tool's questions awaiting user answers (iFlow
 * extension). Rendered like an approval card; the user answers per question
 * (single choice / multi-select / free text), the host replies on the
 * `_iflow/user/questions` request with an answers map keyed by `header`.
 */
export interface PendingQuestionsUi {
  id: string;
  questions: UserQuestion[];
}

/** One user answer: selected labels, or a free-text "Other" answer. */
export type UserAnswerValue = string | string[];

/** One entry of the per-workspace recent-session list (M4). */
export interface SessionSummaryUi {
  id: string;
  label: string;
  updatedAt: number;
}

export interface SessionState {
  blocks: Block[];
  status: AgentStatus;
  errorMessage: string | null;
  stopReason: StopReason | null;
  sessionId: string | null;
  modes: SessionModeState | null;
  commands: SlashCommand[];
  models: ModelInfoUi[];
  currentModelId: string | null;
  /** Non-null while the host awaits the user's answer for a tool approval. */
  pendingApproval: PendingApprovalUi | null;
  /** Non-null while the host awaits the user's answers for ask_user_question. */
  pendingQuestions: PendingQuestionsUi | null;
  /** Auth config state (M3): drives the setup banner / form. */
  auth: AuthUiState;
  /** Recent sessions (per-workspace, persisted host-side) for the switcher. */
  sessions: SessionSummaryUi[];
  activeSessionId: string | null;
  /** True while history is being replayed after `session/load` (M4). */
  replaying: boolean;
  /** True while a new session is being created (host busy; UI locks switches). */
  initializing: boolean;
  /**
   * Monotonic counter of transcript-block mutations, stamped by the host on
   * every full snapshot. Anchors `blockPatch` messages (P-1 incremental
   * snapshots); absent in mock hosts, treated as 0 by the webview.
   */
  blockVersion?: number;
}

export interface AuthUiState {
  /** CLI initialized successfully and reported a usable persisted credential. */
  authenticated: boolean;
  /** True once the CLI handshake itself failed (auth form is the remedy). */
  needsSetup: boolean;
  /** Masked info of stored credentials (never the raw key). */
  saved: { baseUrl: string; modelName: string; keyTail: string } | null;
  /** All known API profiles (extension-owned + read-only CLI ones), masked. */
  profiles: AuthProfileUi[];
}

export interface AuthProfileUi {
  name: string;
  source: "extension" | "cli";
  baseUrl: string;
  modelName: string;
  keyTail: string;
  active: boolean;
}

export function initialSessionState(): SessionState {
  return {
    blocks: [],
    status: "connecting",
    errorMessage: null,
    stopReason: null,
    sessionId: null,
    modes: null,
    commands: [],
    models: [],
    currentModelId: null,
    pendingApproval: null,
    pendingQuestions: null,
    auth: { authenticated: false, needsSetup: false, saved: null, profiles: [] },
    sessions: [],
    activeSessionId: null,
    replaying: false,
    initializing: false,
  };
}

/** One fuzzy-search file hit for the @-mention popup (M5). */
export interface FileHitUi {
  path: string;
}

/** Editor selection attached via right-click "加入 iFlow 上下文" (M5).
 * `range` is the `L<start>` / `L<start>-L<end>` display form built by the host. */
export interface CodeContextUi {
  path: string;
  range: string;
  code: string;
}

// ---------------------------------------------------------------------------
// Host → WebView messages
// ---------------------------------------------------------------------------

/**
 * P-1 incremental snapshot payload: everything EXCEPT `blocks`. Non-block
 * fields are tiny but can all change mid-stream (optimistic mode/model
 * write-back, `available_commands_update`, approval cards), so the patch
 * piggybacks the whole remainder to stay unconditionally correct.
 */
export type SessionSnapshotTail = Omit<SessionState, "blocks">;

/**
 * Merge a `blockPatch` into the webview's transcript. Returns the new block
 * array; the current one when the patch carries no blocks (metadata-only
 * flush); or null when the patch cannot be anchored (no snapshot yet, version
 * mismatch, `tailStart` out of bounds) — the caller must then request a full
 * re-sync via `ready`.
 */
export function applyBlockPatch(
  current: SessionState | null,
  patch: { baseVersion: number; tailStart: number; blocks: Block[] },
): Block[] | null {
  if (!current) return null;
  if ((current.blockVersion ?? 0) !== patch.baseVersion) return null;
  if (patch.tailStart < 0 || patch.tailStart > current.blocks.length) return null;
  if (patch.blocks.length === 0) return current.blocks;
  return [...current.blocks.slice(0, patch.tailStart), ...patch.blocks];
}

export type HostToWebview =
  | { type: "snapshot"; state: SessionState; locale?: string }
  /**
   * P-1 incremental snapshot: the transcript tail range plus the small
   * metadata fields that commonly change mid-stream. Applied on top of the
   * last anchored snapshot (see `applyBlockPatch`); anchor mismatch → the
   * webview re-syncs via `ready`. `blocks` re-sends everything from
   * `tailStart` to the end — the anchored tail block itself plus any blocks
   * appended since the last push — and is empty for metadata-only flushes.
   */
  | {
      type: "blockPatch";
      /** blockVersion the receiver's transcript must currently be anchored at. */
      baseVersion: number;
      /** First transcript index being re-sent. */
      tailStart: number;
      /** Transcript tail from `tailStart` on; empty = metadata-only flush. */
      blocks: Block[];
      /** Current non-blocks metadata (status, approvals, modes, …). */
      tail: SessionSnapshotTail;
    }
  | { type: "toast"; level: "info" | "warning" | "error"; message: string }
  /** Reply to `searchFiles` (matched by requestId, newest wins in the UI). */
  | { type: "fileList"; requestId: number; hits: FileHitUi[] }
  /** Reply to `stageFiles`: absolute temp paths aligned with the request's
   * `files` array (`null` = that file failed to stage). The webview inserts
   * the paths into the composer so the agent can read them with its tools. */
  | { type: "stagedFiles"; requestId: number; paths: Array<string | null> }
  /** Reply to `pickAttachments`: `images` are base64 attachment payloads,
   * `files` carry real disk paths (no staging needed). */
  | { type: "filesPicked"; images: { name: string; data: string; mimeType: string }[]; files: { name: string; path: string }[] }
  /** Editor color theme changed ("dark" | "light"); the webview follows it
   * unless the user picked a theme manually in the panel. */
  | { type: "theme"; kind: "dark" | "light" }
  /** Turn finished ("done") or failed ("error") — the webview plays a short
   * synthesized cue. Host gates on the `iflow.soundFeedback` setting and on
   * panel visibility; the webview only synthesizes on receipt. */
  | { type: "playSound"; kind: "done" | "error" };

// ---------------------------------------------------------------------------
// WebView → Host commands
// ---------------------------------------------------------------------------

export type WebviewToHost =
  | { type: "ready" }
  /** `images`: base64 (no data: prefix) screenshots/pasted images. `files`:
   * non-image attachments with real paths (picked or staged); the host
   * appends the list to the agent-facing prompt text. `codeContext`: the
   * right-click "加入 iFlow 上下文" selection — the host prepends it as a
   * fenced block ahead of the typed text. */
  | {
      type: "sendPrompt";
      text: string;
      images?: { data: string; mimeType: string }[];
      files?: { name: string; path: string }[];
      codeContext?: CodeContextUi;
    }
  | { type: "cancel" }
  | { type: "newSession" }
  | { type: "setMode"; modeId: string }
  | { type: "setModel"; modelId: string }
  | { type: "openLocation"; path: string; line?: number | null }
  | { type: "openExternal"; uri: string }
  | { type: "revealOutput"; toolCallId: string }
  /** Answer a pending approval; `optionId: null` cancels the request. */
  | { type: "respondApproval"; id: string; optionId: string | null }
  /** Answer the pending ask_user_question card; `answers` is keyed by
   * question `header`. An empty answers object = dismissed (the agent
   * proceeds with "no answer"). */
  | { type: "answerQuestions"; id: string; answers: Record<string, string | string[]> }
  /** Revert a completed tool call that carried a structured diff. */
  | { type: "revertTool"; toolCallId: string }
  /** M5: open the tool's change in VSCode's native diff editor. */
  | { type: "openDiff"; toolCallId: string }
  /** M5: fuzzy-search workspace files for the @-mention popup. */
  | { type: "searchFiles"; requestId: number; query: string }
  /** Right-click "加入 iFlow 上下文": attach the editor selection as a
   * structured code-context card above the composer (styled, removable) —
   * a plain textarea cannot render a fenced block. At most one card; the
   * host assembles the final prompt text at send time. */
  | { type: "setCodeContext"; path: string; range: string; code: string }
  /** Non-image files dropped/pasted into the composer: the webview only has
   * File objects it cannot persist, so the host writes them into a session
   * temp dir and replies `stagedFiles` with absolute paths. */
  | { type: "stageFiles"; requestId: number; files: { name: string; data: string }[] }
  /** Open the OS file picker; results arrive as `filesPicked`. Images come
   * back as base64 attachment slots, other files as real disk paths. */
  | { type: "pickAttachments" }
  /** Open a user-attached image (data URL) in VSCode's image preview. */
  | { type: "openImage"; dataUrl: string }
  /** M3: store openai-compatible credentials and authenticate a fresh session. */
  | { type: "saveAuth"; baseUrl: string; apiKey: string | null; modelName: string; profileName?: string | null }
  /** M3: forget stored credentials (CLI keeps its own). */
  | { type: "clearAuth" }
  /** M3: switch the active API profile and re-authenticate. */
  | { type: "activateProfile"; name: string }
  /** M3: delete an extension-owned profile. */
  | { type: "deleteProfile"; name: string }
  /** M4: load a persisted session by id (history replays into the transcript). */
  | { type: "loadSession"; sessionId: string }
  /** M4: forget a persisted session (switcher entry + transcript). */
  | { type: "deleteSession"; sessionId: string }
  /** Re-read the API profile list (SecretStorage + CLI settings.json) when the
   * profile dropdown / auth card opens — external tools rewrite settings.json
   * behind our back, so the shown list must be recomputed on open. */
  | { type: "refreshAuth" }
  /** Re-query `GET {baseUrl}/models` when the model dropdown opens — the list
   * captured at session start goes stale (new gateway models appear). */
  | { type: "refreshModels" };
