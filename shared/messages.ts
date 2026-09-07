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
} from "../src/acp/protocol.js";

// Webview components import wire types from this module — re-export the
// protocol types they need.
export type { SlashCommand };

// ---------------------------------------------------------------------------
// Transcript blocks (rendered in order)
// ---------------------------------------------------------------------------

/** Structured diff carried by `tool_call_update` content blocks. */
export interface ToolDiffUi {
  path: string;
  oldText: string | null;
  newText: string | null;
}

export interface TextBlock {
  kind: "text";
  text: string;
}

export interface ThoughtBlock {
  kind: "thought";
  text: string;
}

export interface UserBlock {
  kind: "user";
  text: string;
}

export interface ToolBlock {
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
}

export interface PlanBlock {
  kind: "plan";
  entries: PlanEntryUi[];
}

export interface PlanEntryUi {
  content: string;
  status?: "pending" | "in_progress" | "completed";
  priority?: "high" | "medium" | "low";
}

export type Block = TextBlock | ThoughtBlock | UserBlock | ToolBlock | PlanBlock;

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
  /** Auth config state (M3): drives the setup banner / form. */
  auth: AuthUiState;
  /** Recent sessions (per-workspace, persisted host-side) for the switcher. */
  sessions: SessionSummaryUi[];
  activeSessionId: string | null;
  /** True while history is being replayed after `session/load` (M4). */
  replaying: boolean;
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
    auth: { authenticated: false, needsSetup: false, saved: null, profiles: [] },
    sessions: [],
    activeSessionId: null,
    replaying: false,
  };
}

/** One fuzzy-search file hit for the @-mention popup (M5). */
export interface FileHitUi {
  path: string;
}

// ---------------------------------------------------------------------------
// Host → WebView messages
// ---------------------------------------------------------------------------

export type HostToWebview =
  | { type: "snapshot"; state: SessionState }
  | { type: "toast"; level: "info" | "warning" | "error"; message: string }
  /** Reply to `searchFiles` (matched by requestId, newest wins in the UI). */
  | { type: "fileList"; requestId: number; hits: FileHitUi[] };

// ---------------------------------------------------------------------------
// WebView → Host commands
// ---------------------------------------------------------------------------

export type WebviewToHost =
  | { type: "ready" }
  /** `images`: base64 (no data: prefix) screenshots/pasted images. */
  | { type: "sendPrompt"; text: string; images?: { data: string; mimeType: string }[] }
  | { type: "cancel" }
  | { type: "newSession" }
  | { type: "setMode"; modeId: string }
  | { type: "setModel"; modelId: string }
  | { type: "openLocation"; path: string; line?: number | null }
  | { type: "openExternal"; uri: string }
  | { type: "revealOutput"; toolCallId: string }
  /** Answer a pending approval; `optionId: null` cancels the request. */
  | { type: "respondApproval"; id: string; optionId: string | null }
  /** Revert a completed tool call that carried a structured diff. */
  | { type: "revertTool"; toolCallId: string }
  /** M5: open the tool's change in VSCode's native diff editor. */
  | { type: "openDiff"; toolCallId: string }
  /** M5: fuzzy-search workspace files for the @-mention popup. */
  | { type: "searchFiles"; requestId: number; query: string }
  /** M5: prefill the composer (right-click "Add to iFlow Context"). */
  | { type: "setDraft"; text: string }
  /** M3: store openai-compatible credentials and authenticate a fresh session. */
  | { type: "saveAuth"; baseUrl: string; apiKey: string | null; modelName: string; profileName?: string | null }
  /** M3: forget stored credentials (CLI keeps its own). */
  | { type: "clearAuth" }
  /** M3: switch the active API profile and re-authenticate. */
  | { type: "activateProfile"; name: string }
  /** M3: delete an extension-owned profile. */
  | { type: "deleteProfile"; name: string }
  /** M4: load a persisted session by id (history replays into the transcript). */
  | { type: "loadSession"; sessionId: string };
