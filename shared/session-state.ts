/**
 * Pure session-state reducer, shared by the Extension Host store and unit
 * tests. WebView never runs protocol logic — it only renders snapshots
 * (plan §2.1: state lives in the host, webview is a projection).
 */

import type {
  SessionNotification,
  SlashCommand,
  StopReason,
  ToolCallStatus,
} from "../src/acp/protocol.js";
import {
  initialSessionState,
  type Block,
  type ModelInfoUi,
  type PendingApprovalUi,
  type SessionState,
  type ToolBlock,
  type ToolDiffUi,
} from "./messages.js";

// --- merging helpers -------------------------------------------------------

function lastBlock(blocks: Block[]): Block | undefined {
  return blocks[blocks.length - 1];
}

function appendTextToLast(blocks: Block[], kind: "text" | "thought" | "user", text: string): void {
  const last = lastBlock(blocks);
  if (last && last.kind === kind) {
    last.text += text;
    return;
  }
  blocks.push({ kind, text } as Block);
}

function upsertToolBlock(blocks: Block[], patch: ToolBlock): void {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.kind === "tool" && block.toolCallId === patch.toolCallId) {
      blocks[i] = {
        ...block,
        ...patch,
        output: patch.output || block.output,
        // A new update without a diff must not erase the previous diff.
        diff: patch.diff ?? block.diff,
      };
      return;
    }
  }
  blocks.push(patch);
}

// --- protocol update application -------------------------------------------

/**
 * Apply one `session/update` notification to the state (mutates `state`,
 * which the store owns between snapshots).
 */
export function applySessionUpdate(state: SessionState, notification: SessionNotification): void {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type === "text") appendTextToLast(state.blocks, "text", update.content.text);
      break;
    case "agent_thought_chunk":
      if (update.content.type === "text") appendTextToLast(state.blocks, "thought", update.content.text);
      break;
    case "user_message_chunk":
      // The host appends user blocks itself when a prompt is sent; agent echo
      // is only relevant for loadSession replay (M4).
      if (state.blocks.length === 0 && update.content.type === "text") {
        appendTextToLast(state.blocks, "user", update.content.text);
      }
      break;
    case "tool_call":
      upsertToolBlock(state.blocks, {
        kind: "tool",
        toolCallId: update.toolCallId,
        toolName: update.toolName ?? "",
        title: update.title ?? "",
        toolKind: update.kind ?? "other",
        status: update.status ?? "pending",
        output: "",
        locations: update.locations ?? [],
        diff: extractDiff(update.content),
      });
      break;
    case "tool_call_update":
      upsertToolBlock(state.blocks, {
        kind: "tool",
        toolCallId: update.toolCallId,
        toolName: update.toolName ?? "",
        title: update.title ?? "",
        toolKind: update.kind ?? "other",
        status: update.status ?? "pending",
        output: extractTextOutput(update.content),
        locations: update.locations ?? [],
        diff: extractDiff(update.content),
      });
      break;
    case "plan":
      state.blocks.push({
        kind: "plan",
        entries: update.entries.map((e) => ({ content: e.content, status: e.status, priority: e.priority })),
      });
      break;
    case "available_commands_update":
      state.commands = update.availableCommands;
      break;
    case "current_mode_update":
      if (state.modes) state.modes = { ...state.modes, currentModeId: update.currentModeId };
      break;
    default:
      break;
  }
}

export function extractTextOutput(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const item of content as Array<{ type: string; content?: { type?: string; text?: string } }>) {
    if (item?.type === "content" && item.content?.type === "text" && typeof item.content.text === "string") {
      text += item.content.text;
    }
  }
  return text;
}

/** First structured diff block (`{type:"diff", path, oldText, newText}`), if any. */
export function extractDiff(content: unknown): ToolDiffUi | null {
  if (!Array.isArray(content)) return null;
  for (const item of content as Array<{ type?: string; path?: unknown; oldText?: unknown; newText?: unknown }>) {
    if (item?.type === "diff" && typeof item.path === "string") {
      return {
        path: item.path,
        oldText: typeof item.oldText === "string" ? item.oldText : null,
        newText: typeof item.newText === "string" ? item.newText : null,
      };
    }
  }
  return null;
}

// --- host-level transitions -------------------------------------------------

export function beginUserPrompt(state: SessionState, text: string): void {
  state.blocks.push({ kind: "user", text });
  state.status = "streaming";
  state.stopReason = null;
  state.errorMessage = null;
}

export function completePrompt(state: SessionState, stopReason: StopReason): void {
  state.stopReason = stopReason;
  state.status = "idle";
}

export function setMeta(
  state: SessionState,
  meta: {
    sessionId?: string | null;
    modes?: SessionState["modes"];
    models?: ModelInfoUi[];
    currentModelId?: string | null;
    commands?: SlashCommand[];
  },
): void {
  if (meta.sessionId !== undefined) state.sessionId = meta.sessionId;
  if (meta.modes !== undefined) state.modes = meta.modes;
  if (meta.models !== undefined) state.models = meta.models;
  if (meta.currentModelId !== undefined) state.currentModelId = meta.currentModelId;
  if (meta.commands !== undefined) state.commands = meta.commands;
}

export function newSessionState(state: SessionState): SessionState {
  const fresh = initialSessionState();
  // The connection survives a transcript reset — only markConnected/markError
  // may change the status. Resetting it here would flash the panel back to
  // "connecting" right after a successful connect.
  fresh.status = state.status;
  // Auth state (incl. the profile list) is connection-scoped too; clearing it
  // here would make the topbar profile dropdown vanish mid-session.
  fresh.auth = state.auth;
  fresh.modes = state.modes;
  fresh.commands = state.commands;
  fresh.models = state.models;
  fresh.currentModelId = state.currentModelId;
  // Approval requests are session-scoped; a new session has none pending.
  return fresh;
}

export function markToolCancelled(state: SessionState): void {
  // A cancelled prompt leaves its last assistant turn without stopReason;
  // no-op for now — visual hint handled via status.
  void state;
}

// --- approval (session/request_permission) ----------------------------------

/** Show an approval card. The WebView answers via `respondApproval`. */
export function setPendingApproval(state: SessionState, approval: PendingApprovalUi): void {
  state.pendingApproval = approval;
}

/** Clear the card once answered (or timed out / cancelled host-side). */
export function clearPendingApproval(state: SessionState, id: string): boolean {
  if (state.pendingApproval?.id !== id) return false;
  state.pendingApproval = null;
  return true;
}

/**
 * Append a resolution note below the approval so the transcript records what
 * the user chose (the card itself is transient).
 */
export function appendApprovalResolution(state: SessionState, toolName: string, resolution: string): void {
  const label = toolName || "tool";
  state.blocks.push({ kind: "text", text: `*${label} — ${resolution}*` });
}

/** Mark a tool's diff as reverted (visual only; the file write happens host-side). */
export function markToolReverted(state: SessionState, toolCallId: string): boolean {
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const block = state.blocks[i]!;
    if (block.kind === "tool" && block.toolCallId === toolCallId) {
      block.status = "failed";
      block.output = block.output ? `${block.output}\n[已回退]` : "[已回退]";
      return true;
    }
  }
  return false;
}

export type { ToolDiffUi };

export type { ToolCallStatus };
