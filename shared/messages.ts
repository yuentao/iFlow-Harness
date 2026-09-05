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

// ---------------------------------------------------------------------------
// Transcript blocks (rendered in order)
// ---------------------------------------------------------------------------

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
  };
}

// ---------------------------------------------------------------------------
// Host → WebView messages
// ---------------------------------------------------------------------------

export type HostToWebview =
  | { type: "snapshot"; state: SessionState }
  | { type: "toast"; level: "info" | "warning" | "error"; message: string };

// ---------------------------------------------------------------------------
// WebView → Host commands
// ---------------------------------------------------------------------------

export type WebviewToHost =
  | { type: "ready" }
  | { type: "sendPrompt"; text: string }
  | { type: "cancel" }
  | { type: "newSession" }
  | { type: "setMode"; modeId: string }
  | { type: "setModel"; modelId: string }
  | { type: "openLocation"; path: string; line?: number | null }
  | { type: "openExternal"; uri: string }
  | { type: "revealOutput"; toolCallId: string };
