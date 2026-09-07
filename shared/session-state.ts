/**
 * Pure session-state reducer, shared by the Extension Host store and unit
 * tests. WebView never runs protocol logic — it only renders snapshots
 * (plan §2.1: state lives in the host, webview is a projection).
 */

import type {
  SessionNotification,
  SessionUpdate,
  SlashCommand,
  StopReason,
  ToolCallStatus,
} from "../src/acp/protocol.js";
import { l10n } from "vscode";
import {
  initialSessionState,
  type Block,
  type ModelInfoUi,
  type PendingApprovalUi,
  type SessionState,
  type SessionSummaryUi,
  type SubAgentBlock,
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

// --- SubAgent grouping (iFlow: nested updates carry `agentId`) --------------

function findSubAgent(blocks: Block[], agentId: string): SubAgentBlock | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.kind === "subagent" && (block.agentId === agentId || block.taskToolCallId === agentId)) {
      return block;
    }
  }
  return undefined;
}

/** Fallback binding: a `task` tool_call arrived without an agentId — adopt the
 * newest unfinished such block once the real agentId shows up. */
function adoptUnboundSubAgent(blocks: Block[], agentId: string): SubAgentBlock | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (
      block.kind === "subagent" &&
      block.agentId === block.taskToolCallId &&
      block.taskToolCallId !== null &&
      (block.status === "pending" || block.status === "in_progress")
    ) {
      block.agentId = agentId;
      return block;
    }
  }
  return undefined;
}

/** Aggregate SubAgent status from its spawning tool_call + nested entries. */
function refreshSubAgentStatus(sub: SubAgentBlock): void {
  if (sub.status === "completed" || sub.status === "failed") return; // terminal wins
  const nested = sub.entries.filter((b): b is ToolBlock => b.kind === "tool");
  if (nested.some((b) => b.status === "failed")) sub.status = "failed";
  else if (nested.some((b) => b.status === "pending" || b.status === "in_progress")) sub.status = "in_progress";
  else if (sub.taskToolCallId === null && nested.length > 0) sub.status = "completed";
}

/** Whether this update belongs inside a SubAgent (nested) rather than top-level. */
function isNestedUpdate(update: SessionUpdate): boolean {
  const kind = update.sessionUpdate;
  return (
    kind === "tool_call" ||
    kind === "tool_call_update" ||
    kind === "agent_message_chunk" ||
    kind === "agent_thought_chunk" ||
    kind === "plan"
  );
}

/** Apply one session update to a block list (top-level transcript or a
 * SubAgent's entries). Mutates the list. */
function applyUpdateToBlocks(blocks: Block[], update: SessionUpdate): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type === "text") appendTextToLast(blocks, "text", update.content.text);
      break;
    case "agent_thought_chunk":
      if (update.content.type === "text") appendTextToLast(blocks, "thought", update.content.text);
      break;
    case "user_message_chunk":
      // Live prompts: the host appends user blocks itself, so agent echo is
      // ignored. During `session/load` replay (M4) user turns arrive through
      // this notification and must be rendered.
      if (update.content.type === "text") appendTextToLast(blocks, "user", update.content.text);
      break;
    case "tool_call":
      upsertToolBlock(blocks, {
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
      upsertToolBlock(blocks, {
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
      blocks.push({
        kind: "plan",
        entries: update.entries.map((e) => ({ content: e.content, status: e.status, priority: e.priority })),
      });
      break;
    default:
      break;
  }
}

// --- protocol update application -------------------------------------------

/**
 * Apply one `session/update` notification to the state (mutates `state`,
 * which the store owns between snapshots).
 *
 * iFlow SubAgent (`task` tool): nested updates carry `agentId` and are
 * grouped into one SubAgentBlock per agent instead of top-level blocks.
 */
export function applySessionUpdate(
  state: SessionState,
  notification: SessionNotification,
  options: { replaying?: boolean } = {},
): void {
  const update = notification.update;

  // SubAgent grouping: everything nested under an agentId lands in that
  // agent's block (or in the `task` tool_call's block, matched by id).
  if (notification.agentId) {
    const agentId = notification.agentId;
    let sub = findSubAgent(state.blocks, agentId) ?? adoptUnboundSubAgent(state.blocks, agentId);
    if (!sub) {
      // No spawning `task` tool_call seen — synthesize the card from context.
      const title =
        (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update"
          ? update.title || update.toolName
          : undefined) ?? l10n.t("子智能体");
      sub = { kind: "subagent", agentId, taskToolCallId: null, title, status: "in_progress", entries: [] };
      state.blocks.push(sub);
    }
    if (isNestedUpdate(update)) applyUpdateToBlocks(sub.entries, update);
    // Terminal status for the card comes from the spawning tool_call's update.
    if (
      (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
      update.toolCallId === sub.taskToolCallId &&
      update.status
    ) {
      sub.status = update.status;
    } else {
      refreshSubAgentStatus(sub);
    }
    return;
  }

  // The spawning `task` tool_call itself (no agentId yet): a SubAgent card is
  // born here; nested updates bind to it once they carry the agentId.
  if (
    (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
    update.toolName === "task"
  ) {
    const existing = findSubAgent(state.blocks, update.toolCallId);
    if (existing) {
      if (update.status) existing.status = update.status;
    } else {
      state.blocks.push({
        kind: "subagent",
        agentId: update.toolCallId,
        taskToolCallId: update.toolCallId,
        title: update.title || update.toolName || l10n.t("子智能体"),
        status: update.status ?? "pending",
        entries: [],
      });
    }
    return;
  }

  const replaying = options.replaying;
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      // Live prompts: the host appends user blocks itself, so agent echo is
      // ignored. During `session/load` replay (M4) user turns arrive through
      // this notification and must be rendered.
      if ((replaying || state.blocks.length === 0) && update.content.type === "text") {
        appendTextToLast(state.blocks, "user", update.content.text);
      }
      break;
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "tool_call":
    case "tool_call_update":
    case "plan":
      applyUpdateToBlocks(state.blocks, update);
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

export function beginUserPrompt(state: SessionState, text: string, images?: string[]): void {
  state.blocks.push(images && images.length > 0 ? { kind: "user", text, images } : { kind: "user", text });
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
  // The recent-session list is workspace-scoped and must survive resets.
  fresh.sessions = state.sessions;
  fresh.activeSessionId = state.activeSessionId;
  fresh.replaying = state.replaying;
  // Approval requests are session-scoped; a new session has none pending.
  return fresh;
}

/** Replace the recent-session list (M4 switcher, ordered newest-first). */
export function setSessions(state: SessionState, sessions: SessionSummaryUi[]): void {
  state.sessions = sessions;
}

/**
 * Begin history restore after `session/load`: the transcript is cleared and
 * incoming updates re-populate it; `endReplay` flips the flag back.
 * A placeholder block makes the (potentially ~60s) wait visible — CLI startup
 * plus session/load have both been measured at tens of seconds.
 */
export function beginReplay(state: SessionState): void {
  state.blocks = [];
  state.pendingApproval = null;
  state.replaying = true;
  state.status = "streaming";
  state.errorMessage = null;
  state.stopReason = null;
  state.blocks.push({
    kind: "text",
    text: l10n.t("⏳ 正在恢复会话历史…（CLI 启动与会话加载可能需要 30–60 秒，请稍候）"),
  });
}

export function endReplay(state: SessionState): void {
  state.replaying = false;
  state.status = "idle";
}

export function markToolCancelled(state: SessionState): void {
  // A cancelled prompt leaves its last assistant turn without stopReason;
  // no-op for now — visual hint handled via status.
  void state;
}

// --- transcript restore (M4: CLI does not replay history on session/load) ----

/**
 * Rebuild UI blocks from the CLI's persisted session file (NDJSON, one entry
 * per line: `{type:"user"|"assistant", message:{content}, isSidechain}`).
 * Tool results on user entries are noise; assistant `tool_use` becomes a
 * completed tool card. Returns the first user text for the switcher label.
 */
export function parseTranscriptJsonl(text: string): { blocks: Block[]; firstUserText: string | null } {
  const blocks: Block[] = [];
  let firstUserText: string | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: {
      type?: string;
      isSidechain?: boolean;
      message?: { content?: unknown };
    };
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // torn write / partial line
    }
    if (entry.isSidechain) continue;
    const content = entry.message?.content;

    if (entry.type === "user") {
      const texts: string[] = [];
      if (typeof content === "string") {
        texts.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content as Array<{ type?: string; text?: string }>) {
          if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
          // tool_result entries are dropped: the tool card carries the output.
        }
      }
      const text = texts.join("\n").trim();
      if (!text) continue;
      if (firstUserText === null) firstUserText = text;
      blocks.push({ kind: "user", text });
      continue;
    }

    if (entry.type === "assistant" && Array.isArray(content)) {
      for (const block of content as Array<{
        type?: string;
        text?: string;
        id?: string;
        name?: string;
      }>) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          blocks.push({ kind: "text", text: block.text });
        } else if (block?.type === "tool_use" && typeof block.id === "string") {
          blocks.push({
            kind: "tool",
            toolCallId: block.id,
            toolName: block.name ?? "",
            title: block.name ?? "",
            toolKind: "other",
            status: "completed",
            output: "",
            locations: [],
            diff: null,
          });
        }
      }
    }
  }
  return { blocks, firstUserText };
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
      const reverted = l10n.t("[已回退]");
      block.output = block.output ? `${block.output}\n${reverted}` : reverted;
      return true;
    }
  }
  return false;
}

export type { ToolDiffUi };

export type { ToolCallStatus };
