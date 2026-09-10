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
  type PendingQuestionsUi,
  type SessionState,
  type SessionSummaryUi,
  type SubAgentBlock,
  type ToolBlock,
  type ToolDiffUi,
} from "./messages.js";

// --- merging helpers -------------------------------------------------------

/**
 * Stable block-id generator (P4): monotonically increasing across sessions
 * and restores, so ids stay unique within any live blocks array. The React
 * key falls back to the index only for legacy data (host backfills those).
 */
let blockSeq = 0;
export function nextBlockId(): string {
  return `b${(++blockSeq).toString(36)}`;
}

function lastBlock(blocks: Block[]): Block | undefined {
  return blocks[blocks.length - 1];
}

function appendTextToLast(blocks: Block[], kind: "text" | "thought" | "user", text: string): void {
  const last = lastBlock(blocks);
  if (last && last.kind === kind) {
    last.text += text;
    return;
  }
  blocks.push({ kind, text, id: nextBlockId() } as Block);
}

function upsertToolBlock(blocks: Block[], patch: ToolBlock): void {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.kind === "tool" && block.toolCallId === patch.toolCallId) {
      // `patch` carries no `id` key (creation sites below omit it), so the
      // spread keeps the existing block's id stable across updates. A patch
      // bringing a NEW diff means the file was edited again — the stale
      // revert marker no longer applies (C4).
      blocks[i] = {
        ...block,
        ...patch,
        output: patch.output || block.output,
        // A new update without a diff must not erase the previous diff.
        diff: patch.diff ?? block.diff,
        reverted: patch.diff ? false : block.reverted,
      };
      return;
    }
  }
  blocks.push({ ...patch, id: nextBlockId() });
}

// --- SubAgent grouping (iFlow: nested updates carry `agentId`) --------------

/**
 * Where the agentId may live on the wire: top-level `agentId` (documented) or
 * inside the update's `_meta` (defensive fallback).
 */
function extractAgentId(notification: SessionNotification): string | undefined {
  if (notification.agentId) return notification.agentId;
  const meta = (notification.update as { _meta?: { agentId?: unknown } })._meta;
  if (meta && typeof meta.agentId === "string" && meta.agentId) return meta.agentId;
  return undefined;
}

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

/**
 * Aggregate SubAgent status from its spawning tool_call + nested entries.
 * A nested tool failure must NOT flip the card to terminal "failed": the
 * subagent may recover and keep running, and a terminal status would close
 * the strategy-2 interval (`findActiveSubAgent` only matches
 * pending/in_progress), leaking subsequent nested events to the top level
 * and making the later `task` completed update spawn a duplicate card.
 * Card-level failure comes only from the spawning `task` call's own status;
 * failed nested steps stay visible per-step (red icon + log line).
 */
function refreshSubAgentStatus(sub: SubAgentBlock): void {
  if (sub.status === "completed" || sub.status === "failed") return; // terminal wins
  const nested = sub.entries.filter((b): b is ToolBlock => b.kind === "tool");
  if (nested.some((b) => b.status === "pending" || b.status === "in_progress")) sub.status = "in_progress";
  else if (sub.taskToolCallId === null && nested.length > 0) sub.status = "completed";
}

/** Extract the SubAgent type from a task title ("Launch agent(X): ..." or "X Agent started"). */
function extractAgentType(title: string): string | null {
  const m = /Launch agent\(([^)]*)\)/.exec(title) ?? /(?:^|\s)([A-Za-z0-9_-]+) Agent started/.exec(title);
  return m ? m[1] || null : null;
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

/** Wire check (0.5.19, verified live): the SubAgent's spawning tool_call.
 * Lowercased — CLI versions differ in casing ("task" vs "Task"). */
function isTaskToolCall(update: SessionUpdate): boolean {
  return (
    (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
    typeof update.toolName === "string" &&
    update.toolName.toLowerCase() === "task"
  );
}

/**
 * The SubAgent interval currently open, i.e. the newest subagent card whose
 * spawning `task` call has not reached a terminal status. Verified on live
 * wire 0.5.19: events carry NO agentId — the flat nested activity between
 * `tool_call task` (pending/in_progress) and `tool_call_update task`
 * (completed/failed) belongs to that SubAgent.
 */
function findActiveSubAgent(blocks: Block[]): SubAgentBlock | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.kind === "subagent" && (block.status === "pending" || block.status === "in_progress")) {
      return block;
    }
  }
  return undefined;
}

// --- compression history-item leak sanitizer (slash /compress) ---------------

/**
 * Wire behavior (probed, CLI 0.5.19 bundle): the ACP adapter bridges the
 * interactive UI's `addItem` as `agent_message_chunk` text, but items without
 * a `text` field are emitted as `JSON.stringify(item)` — the `/compress`
 * command (altNames summarize/compact) pushes exactly such an item:
 * `{"type":"compression","compression":{"isPending":false,
 * "originalTokenCount":98134,"newTokenCount":7855,"summary":"…"}}`. The raw
 * JSON renders as garbage in the transcript, so it is detected and replaced
 * with a readable notice; the carried-over conversation summary (the
 * `summary` field) is preserved as markdown text. A JSON blob torn across
 * chunks cannot be parsed and is left verbatim — the live CLI emits the blob
 * in a single chunk.
 */
interface CompressionHistoryItem {
  type?: unknown;
  compression?: {
    isPending?: unknown;
    originalTokenCount?: unknown;
    newTokenCount?: unknown;
    summary?: unknown;
  };
}

/** Scan the balanced JSON object starting at `start`, then shape-check it.
 * Returns null for torn JSON (no balanced end in this chunk) or a foreign
 * payload — callers keep the text verbatim in that case. */
function parseCompressionItem(text: string, start: number): { end: number; item: CompressionHistoryItem } | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === "\\") i++; // skip the escaped char inside the string
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        let item: CompressionHistoryItem;
        try {
          item = JSON.parse(text.slice(start, i + 1)) as CompressionHistoryItem;
        } catch {
          return null;
        }
        const c = item.compression;
        if (
          item.type === "compression" &&
          c !== null && typeof c === "object" &&
          typeof c.isPending === "boolean" &&
          (c.originalTokenCount === null || typeof c.originalTokenCount === "number") &&
          (c.newTokenCount === null || typeof c.newTokenCount === "number") &&
          (c.summary === undefined || typeof c.summary === "string")
        ) {
          return { end: i + 1, item };
        }
        return null;
      }
    }
  }
  return null; // torn JSON
}

function formatCompressionNotice(item: CompressionHistoryItem): string {
  const c = item.compression!;
  if (c.isPending) return l10n.t("正在压缩上下文…");
  return l10n.t(
    "上下文已压缩：{0} → {1} tokens",
    String(c.originalTokenCount ?? "?"),
    String(c.newTokenCount ?? "?"),
  );
}

function compressionSummaryOf(item: CompressionHistoryItem): string | null {
  const s = typeof item.compression!.summary === "string" ? item.compression!.summary.trim() : "";
  return s || null;
}

/**
 * Append one streaming agent text chunk. Complete compression history items
 * become their own collapsible CompressionBlock (the summary is long — the
 * webview folds it); the remaining text merges normally. Torn or foreign JSON
 * stays verbatim (see parseCompressionItem).
 */
function appendAgentChunk(blocks: Block[], text: string): void {
  const MARKER = '{"type":"compression"';
  let rest = text;
  for (;;) {
    const idx = rest.indexOf(MARKER);
    if (idx < 0) break;
    const parsed = parseCompressionItem(rest, idx);
    if (!parsed) break; // torn or foreign — remainder stays verbatim
    if (idx > 0) appendTextToLast(blocks, "text", rest.slice(0, idx));
    blocks.push({
      kind: "compression",
      id: nextBlockId(),
      notice: formatCompressionNotice(parsed.item),
      summary: compressionSummaryOf(parsed.item),
    });
    rest = rest.slice(parsed.end);
  }
  if (rest) appendTextToLast(blocks, "text", rest);
}

/** Apply one session update to a block list (top-level transcript or a
 * SubAgent's entries). Mutates the list. */
function applyUpdateToBlocks(blocks: Block[], update: SessionUpdate): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type === "text") appendAgentChunk(blocks, update.content.text);
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
        id: nextBlockId(),
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
 * SubAgent grouping, two strategies (both verified against iFlow CLI 0.5.19):
 * 1. If the notification carries an `agentId` (documented extension), nested
 *    updates are grouped into the agent's SubAgentBlock.
 * 2. Otherwise a state machine keyed on the `task` tool_call delimits the
 *    SubAgent interval: events between `tool_call task` (pending/in_progress)
 *    and `tool_call_update task` (completed/failed) are flat top-level
 *    updates that actually belong to the SubAgent.
 */
export function applySessionUpdate(
  state: SessionState,
  notification: SessionNotification,
  options: { replaying?: boolean } = {},
): void {
  const update = notification.update;

  // Strategy 1: documented `agentId` grouping.
  const agentId = extractAgentId(notification);
  if (agentId) {
    let sub = findSubAgent(state.blocks, agentId) ?? adoptUnboundSubAgent(state.blocks, agentId);
    if (!sub) {
      const title =
        (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update"
          ? update.title || update.toolName
          : undefined) ?? l10n.t("子智能体");
      sub = { kind: "subagent", id: nextBlockId(), agentId, taskToolCallId: null, title, status: "in_progress", agentType: null, entries: [] };
      state.blocks.push(sub);
    }
    if (isNestedUpdate(update)) applyUpdateToBlocks(sub.entries, update);
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

  // Strategy 2: `task` tool_call interval state machine.
  const active = findActiveSubAgent(state.blocks);
  const isTask = isTaskToolCall(update);

  if (isTask) {
    const taskUpdate = update as {
      status?: ToolCallStatus;
      title?: string;
      toolCallId?: string;
      toolName?: string;
    };
    if (active) {
      // Interval bookkeeping: the spawning call's status drives the card.
      if (taskUpdate.status) active.status = taskUpdate.status;
      // A richer title (Launch agent(type): …) upgrades the card type.
      if (taskUpdate.title && !active.agentType) {
        const type = extractAgentType(taskUpdate.title);
        if (type) {
          active.agentType = type;
          active.title = taskUpdate.title;
        }
      }
      // Keep the update in the log so the 日志 pane shows the full trail.
      if (isNestedUpdate(update)) applyUpdateToBlocks(active.entries, update);
      return;
    }
    // Interval opens: a SubAgent card is born.
    const title = taskUpdate.title || taskUpdate.toolName || l10n.t("子智能体");
    state.blocks.push({
      kind: "subagent",
      id: nextBlockId(),
      agentId: taskUpdate.toolCallId ?? "",
      taskToolCallId: taskUpdate.toolCallId ?? null,
      title,
      status: taskUpdate.status ?? "in_progress",
      agentType: extractAgentType(title),
      entries: [],
    });
    return;
  }

  if (active) {
    // Flat nested activity inside the open interval → into the card.
    if (isNestedUpdate(update)) {
      applyUpdateToBlocks(active.entries, update);
      refreshSubAgentStatus(active);
      return;
    }
    // Non-nested updates (mode/commands) still apply top-level: fall through.
  }

  const replaying = options.replaying;
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      // Live prompts: the host appends user blocks itself (beginUserPrompt),
      // so the agent's echo is always ignored — an echo reaching an EMPTY
      // transcript can only be a stale chunk from an abandoned turn (新会话
      // cleared mid-flight), never the user's real message. During
      // `session/load` replay (M4) user turns arrive through this
      // notification and must be rendered.
      if (replaying && update.content.type === "text") {
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

// --- CLI slash-command vs. literal-text disambiguation -----------------------
// Wire behavior (probed against the iFlow CLI 0.5.19 bundle, ACP prompt
// handler `I8u` + path heuristic `T8u`): a prompt whose *trimmed* text starts
// with "/" is parsed as a slash command — an unknown first token is answered
// with "Unknown command: …" and never reaches the model. Invocations that
// look like filesystem paths are exempt. We mirror that tokenization here:
// known commands and path-like text pass through verbatim; anything else
// gets a zero-width space (U+200B) prepended so the CLI's
// `trim().startsWith("/")` gate fails and the text is delivered as a plain
// prompt. U+200B is category Cf — NOT removed by String.prototype.trim().

/** Path-shape regexes mirrored from CLI 0.5.19 (`lIe`). */
const CLI_PATH_PATTERNS = [
  /^\/[a-zA-Z0-9._-]+/, // UNIX_ABSOLUTE
  /^([a-zA-Z]:[/\\]|\\\\[a-zA-Z0-9._-]+[/\\])/, // WINDOWS_ABSOLUTE (drive / UNC)
  /^~[a-zA-Z0-9._-]*[/\\]/, // HOME_SHORTCUT
  /^(\.?\/|\.\.\/)/, // UNIX_RELATIVE
  /^(\.\\|\.\.\\)/, // WINDOWS_RELATIVE
];
/** Well-known absolute-path roots exempted by the CLI (`yso`). */
const CLI_UNIX_DIRS = [
  "bin", "sbin", "etc", "var", "usr", "opt", "tmp", "home", "root", "lib",
  "lib64", "dev", "proc", "sys", "run", "snap", "srv", "mnt", "media", "boot",
  "data", "Users", "Library", "Applications", "System",
];
const CLI_WINDOWS_DIRS = [
  "Windows", "Program Files", "Program Files (x86)", "ProgramData", "Users",
  "Documents", "Downloads", "Desktop", "Pictures", "Music", "Videos",
  "AppData", "System32", "SysWOW64", "Temp", "Programs",
];
/** Directory names exempted after "name<space>path" (`T8u` n-branch). */
const CLI_KNOWN_DIRS = [
  "Program", "Program Files", "Windows", "System32", "Users", "Documents",
  "Desktop", "Downloads",
];

function looksLikeCliPath(m: string, d: string): boolean {
  const sepAfter = d.startsWith("/") || d.startsWith("\\");
  const spaceSepAfter = d.startsWith(" ") && (d.slice(1).includes("/") || d.slice(1).includes("\\"));
  if (/^[A-Z]/.test(m) && sepAfter) return true; // Capitalized/dir + "/rest"
  if (CLI_PATH_PATTERNS.some((re) => re.test(m))) return true;
  if (spaceSepAfter && (CLI_KNOWN_DIRS.includes(m) || CLI_KNOWN_DIRS.some((u) => m.startsWith(u)))) {
    return true;
  }
  const lower = m.toLowerCase();
  return (
    ((CLI_UNIX_DIRS.includes(lower) || CLI_WINDOWS_DIRS.includes(lower)) && sepAfter) ||
    (/^[a-zA-Z]$/.test(m) && d.startsWith(":")) // "C:/…" — drive letter token
  );
}

/**
 * Text the CLI agent should receive for a user prompt. Known slash commands
 * and path-like invocations pass through verbatim (the CLI runs / exempts
 * them); every other "/"-leading text is zero-width-escaped so it cannot be
 * mistaken for a command. Non-slash text is returned unchanged.
 */
export function toAgentPromptText(text: string, commands: readonly SlashCommand[]): string {
  const s = text.trim();
  if (!s.startsWith("/") || commands.length === 0) return text;
  const a = s.slice(1);
  const sep = a.search(/[/\\]/);
  const space = a.indexOf(" ");
  let m: string;
  let d: string;
  if (sep !== -1 && (space === -1 || sep < space)) {
    m = a.slice(0, sep);
    d = a.slice(sep);
  } else if (space !== -1) {
    m = a.slice(0, space);
    d = a.slice(space);
  } else {
    m = a;
    d = "";
  }
  if (looksLikeCliPath(m, d)) return text;
  // The CLI splits by whitespace and matches the first word against command
  // names / altNames — mirror that exactly (so "/init foo" runs the command
  // while "/init/foo" — one whitespace word — does not).
  const firstWord = a.trim().split(/\s+/)[0] ?? "";
  const known = commands.some(
    (c) => c.name === firstWord || (c._meta?.altName ?? []).includes(firstWord),
  );
  if (known) return text;
  return "\u200B" + s;
}

export function beginUserPrompt(
  state: SessionState,
  text: string,
  images?: string[],
  files?: { name: string; path: string }[],
): void {
  // Mirror the agent-facing attachment list in the transcript so the user
  // message block shows exactly what the agent was told about the files.
  const fileNote =
    files && files.length > 0
      ? "\n" + files.map((f) => `（文件：${f.name} → ${f.path}）`).join("\n")
      : "";
  const full = text + fileNote;
  state.blocks.push(
    images && images.length > 0
      ? { kind: "user", text: full, images, id: nextBlockId() }
      : { kind: "user", text: full, id: nextBlockId() },
  );
  state.status = "streaming";
  state.stopReason = null;
  state.errorMessage = null;
}

export function completePrompt(state: SessionState, stopReason: StopReason): void {
  state.stopReason = stopReason;
  state.status = "idle";
}

/**
 * Host-issued transcript notice: not an agent message — appended directly so
 * the user sees why the turn "restarted" (auto-compress retry after a
 * context-overflow failure; see panel.ts `sendPrompt` for the trigger).
 */
export function appendHostNotice(state: SessionState, text: string): void {
  state.blocks.push({ kind: "text", text, id: nextBlockId() });
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

/**
 * Session-switcher label cap. Labels derive from free-form user prompts (or
 * transcript first-user-text), which can run hundreds of chars; without a
 * cap they overflow the topbar switcher (CSS truncate only works when the
 * layout constrains width) and bloat workspaceState. 48 chars ≈ the widest
 * the trigger can show before ellipsis in practice.
 */
export const SESSION_LABEL_MAX = 48;

/** Trim + hard-cap a label to SESSION_LABEL_MAX chars. */
export function clampSessionLabel(text: string): string {
  return text.trim().slice(0, SESSION_LABEL_MAX);
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
    id: nextBlockId(),
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
 * P4: assign stable ids to blocks that lack them — transcripts persisted
 * before block ids existed (legacy workspaceState map, files written by
 * earlier versions). Recurses into SubAgent entries. Mutates in place.
 */
export function backfillBlockIds(blocks: Block[]): void {
  for (const block of blocks) {
    if (!block.id) block.id = nextBlockId();
    if (block.kind === "subagent") backfillBlockIds(block.entries);
  }
}

/**
 * Rebuild UI blocks from the CLI's persisted session file (NDJSON, one entry
 * per line: `{type:"user"|"assistant", message:{content}, isSidechain}`).
 * Tool results on user entries are noise; assistant `tool_use` becomes a
 * completed tool card. Sidechain entries (`isSidechain: true`, the SubAgent's
 * `task` turns) are grouped into one SubAgentBlock per sidechain run instead
 * of being dropped. Returns the first user text for the switcher label.
 */
export function parseTranscriptJsonl(text: string): { blocks: Block[]; firstUserText: string | null } {
  const blocks: Block[] = [];
  let firstUserText: string | null = null;
  // Current sidechain grouping state: entries arrive in run order, so all
  // consecutive isSidechain lines belong to one SubAgent execution.
  let sidechain: SubAgentBlock | null = null;
  const flushSidechain = (): void => {
    if (sidechain) {
      if (sidechain.status === "in_progress" || sidechain.status === "pending") {
        sidechain.status = "completed";
      }
      sidechain = null;
    }
  };

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: {
      type?: string;
      isSidechain?: boolean;
      isCompactSummary?: boolean;
      compressionInfo?: {
        originalTokenCount?: unknown;
        newTokenCount?: unknown;
        summary?: unknown;
      };
      message?: { content?: unknown };
    };
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // torn write / partial line
    }

    const content = entry.message?.content;

    if (entry.isSidechain) {
      // C6 known limitation: consecutive isSidechain lines are treated as ONE
      // SubAgent run because the CLI (0.5.19) writes sidechain turns
      // sequentially. If a future CLI ever interleaves concurrent sidechains,
      // their entries would merge into one card — revisit with a proper
      // per-agent grouping key when that becomes observable.
      if (!sidechain) {
        sidechain = {
          kind: "subagent",
          agentId: `sidechain-${blocks.length}`,
          taskToolCallId: null,
          title: l10n.t("子智能体"),
          status: "in_progress",
          agentType: null,
          entries: [],
        };
        blocks.push(sidechain);
      }
      const current = sidechain;
      if (entry.type === "user" && typeof content === "string" && content.trim()) {
        current.entries.push({ kind: "text", text: content.trim() });
      }
      if (entry.type === "assistant" && Array.isArray(content)) {
        for (const block of content as Array<{
          type?: string;
          text?: string;
          id?: string;
          name?: string;
          input?: { description?: string; prompt?: string };
        }>) {
          if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
            current.entries.push({ kind: "text", text: block.text });
          } else if (block?.type === "tool_use" && typeof block.id === "string") {
            current.entries.push({
              kind: "tool",
              toolCallId: block.id,
              toolName: block.name ?? "",
              title: (block.input?.description as string) || block.name || "",
              toolKind: "other",
              status: "completed",
              output: "",
              locations: [],
              diff: null,
            });
          }
        }
      }
      continue;
    }

    // A main-chain entry ends the current sidechain run.
    flushSidechain();

    // /compress (and auto-compression) records a user entry flagged
    // isCompactSummary carrying compressionInfo — render it as the same
    // collapsible card as live. Not a real user turn: must not set
    // firstUserText (the switcher label).
    if (entry.type === "user" && entry.isCompactSummary && entry.compressionInfo) {
      const info = entry.compressionInfo;
      const notice = l10n.t(
        "上下文已压缩：{0} → {1} tokens",
        String(info.originalTokenCount ?? "?"),
        String(info.newTokenCount ?? "?"),
      );
      const summary = typeof info.summary === "string" ? info.summary.trim() : "";
      blocks.push({ kind: "compression", notice, summary: summary || null });
      continue;
    }

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
        input?: { description?: string; prompt?: string };
      }>) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          blocks.push({ kind: "text", text: block.text });
        } else if (block?.type === "tool_use" && typeof block.id === "string") {
          // The SubAgent-spawning `task` call renders as a SubAgent card and
          // adopts the sidechain run that follows it, if any.
          if (block.name === "task") {
            const desc = block.input?.description || block.name || l10n.t("子智能体");
            const nextSidechain: SubAgentBlock = {
              kind: "subagent",
              agentId: block.id,
              taskToolCallId: block.id,
              title: desc,
              status: "completed",
              agentType: extractAgentType(desc),
              entries: [],
            };
            blocks.push(nextSidechain);
            sidechain = nextSidechain; // subsequent isSidechain lines merge in
            continue;
          }
          blocks.push({
            kind: "tool",
            toolCallId: block.id,
            toolName: block.name ?? "",
            title: (block.input?.description as string) || block.name || "",
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
  flushSidechain();
  // P4: parsed blocks (user/text/tool/subagent across both chains) get their
  // stable ids here — one call instead of threading nextBlockId() through
  // every creation site above.
  backfillBlockIds(blocks);
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
  state.blocks.push({ kind: "text", id: nextBlockId(), text: `*${label} — ${resolution}*` });
}

// --- user questions (_iflow/user_questions) ---------------------------------

/** Show the ask_user_question card. The WebView answers via `answerQuestions`. */
export function setPendingQuestions(state: SessionState, pending: PendingQuestionsUi): void {
  state.pendingQuestions = pending;
}

/** Clear the card once answered (or timed out / cancelled host-side). */
export function clearPendingQuestions(state: SessionState, id: string): boolean {
  if (state.pendingQuestions?.id !== id) return false;
  state.pendingQuestions = null;
  return true;
}

/** Mark a tool's diff as reverted (visual only; the file write happens host-side). */
export function markToolReverted(state: SessionState, toolCallId: string): boolean {
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const block = state.blocks[i]!;
    if (block.kind === "tool" && block.toolCallId === toolCallId) {
      // C4: `reverted` is orthogonal to `status` — the tool SUCCEEDED, its
      // change was undone. The old status="failed" leaked the failure into
      // SubAgent cards nesting the tool (refreshSubAgentStatus).
      block.reverted = true;
      const reverted = l10n.t("[已回退]");
      block.output = block.output ? `${block.output}\n${reverted}` : reverted;
      return true;
    }
  }
  return false;
}

export type { ToolDiffUi };

export type { ToolCallStatus };
