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
import { countTokens as gptCountTokens } from "gpt-tokenizer";
import {
  emptySessionUsage,
  initialSessionState,
  type Block,
  type ModelInfoUi,
  type PendingApprovalUi,
  type PendingPlanExitUi,
  type PendingQuestionsUi,
  type SessionState,
  type SessionSummaryUi,
  type SessionUsageUi,
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

/** Append `text` to the last block when it has the same kind, else push a new
 * block. Returns the index of the mutated/appended block (P-1 change
 * reporting), or undefined when nothing changed (empty text). A streaming
 * append INVALIDATES the target block's token cache (P1): the text grew, so
 * the next turn end re-tokenizes it — once, not per chunk.
 * `system` marks host-classified status text (see TextBlock.system): the flag
 * acts as a merge boundary, so a status line never absorbs the assistant
 * reply that follows it (and normal text never dilutes a status block). */
function appendTextToLast(
  blocks: Block[],
  kind: "text" | "thought" | "user",
  text: string,
  system = false,
): number | undefined {
  if (!text) return undefined;
  const last = lastBlock(blocks);
  if (
    last &&
    last.kind === kind &&
    (kind !== "text" || last.kind !== "text" || Boolean(last.system) === system)
  ) {
    last.text += text;
    // Incremental token accumulation (real-time usage): add the appended
    // chunk's tokens to the block's cache instead of invalidating it, so a
    // streaming block keeps a VALID count at all times and a live usage
    // refresh is a pure O(blocks) sum with zero BPE. Sum-of-chunks differs
    // from whole-text BPE only at token boundaries — acceptable for a usage
    // ESTIMATE (same stance as the SubAgent entry-sum note below), and
    // strictly cheaper than re-scanning the growing block on every throttled
    // refresh. A block without a cache yet (e.g. restored transcript) falls
    // back to one full count of the merged text so the total never
    // under-counts.
    last.tokens =
      last.tokens !== undefined ? last.tokens + estimateTokens(text) : estimateTokens(blockText(last));
    return blocks.length - 1;
  }
  blocks.push({
    kind,
    text,
    id: nextBlockId(),
    tokens: estimateTokens(text),
    ...(system ? { system: true } : {}),
  } as Block);
  return blocks.length - 1;
}

/**
 * CLI compression status lines (probed, CLI 0.5.19 bundle): the compress
 * command streams its progress/failure as plain agent_message_chunks
 * (nls keys compressingHistory / failedToCompress / failedWithError, plus
 * the "Compressing context…" info line). Recognized here so the webview
 * renders them as muted system lines instead of assistant replies carrying
 * copy/regenerate actions. Matched at chunk start — the CLI emits each
 * status line as its own chunk (same behavior the compression JSON blob
 * relies on).
 */
const SYSTEM_STATUS_PREFIXES = [
  "正在压缩",
  "压缩聊天历史失败",
  "Compressing chat history",
  "Compressing context",
  "Failed to compress chat history",
];

function isSystemStatusText(text: string): boolean {
  const t = text.trimStart();
  return SYSTEM_STATUS_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * Legacy backfill matcher: appendApprovalResolution's exact whole-text shape
 * (`*label — resolution*`). Only used for transcripts persisted before the
 * system flag existed — the live path flags notes explicitly at creation, so
 * a false positive here would need an assistant reply that is nothing but
 * one fully-italic line containing " — ".
 */
const LEGACY_RESOLUTION_NOTE = /^\*[^*\n]+ — [^*\n]+\*$/;

/**
 * P-1 follow-up (2026-09): cap a tool block's output at 64K chars. Tool
 * output is the dominant transcript-size driver (shell dumps, file reads),
 * and every downstream O(size) path — snapshot serialization, transcript
 * persistence, token estimation — pays for it on every push. The dropped
 * tail is only recorded as a count; the webview surfaces it.
 * Diff payloads are NOT capped: revert matches the disk content against
 * `diff.newText` verbatim (panel.probeRevertCandidate), truncation there
 * would silently break the revert flow.
 */
export const MAX_TOOL_OUTPUT_CHARS = 64 * 1024;

/** Upsert the tool block for `patch.toolCallId`. Returns the index of the
 * mutated/appended block (P-1 change reporting). */
function upsertToolBlock(blocks: Block[], patch: ToolBlock): number {
  let output = patch.output || "";
  let truncatedChars: number | undefined;
  if (output.length > MAX_TOOL_OUTPUT_CHARS) {
    truncatedChars = output.length - MAX_TOOL_OUTPUT_CHARS;
    output = output.slice(0, MAX_TOOL_OUTPUT_CHARS);
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.kind === "tool" && block.toolCallId === patch.toolCallId) {
      // `patch` carries no `id` key (creation sites below omit it), so the
      // spread keeps the existing block's id stable across updates. A patch
      // bringing a NEW diff means the file was edited again — the stale
      // revert marker no longer applies (C4).
      const merged: ToolBlock = {
        ...block,
        ...patch,
        output: output || block.output,
        // An update without fresh output keeps the previous truncation marker.
        truncatedChars: output ? truncatedChars : block.truncatedChars,
        // A new update without a diff must not erase the previous diff.
        diff: patch.diff ?? block.diff,
        reverted: patch.diff ? false : block.reverted,
      };
      // P1: recount only when token-bearing content actually changed — pure
      // status flips (pending → completed) ride the existing cache, keeping
      // the hot tool-update path BPE-free. `tokens` survives the spread above
      // (wire patches never carry it); a real change recounts in place.
      const contentChanged =
        merged.diff?.path !== block.diff?.path ||
        merged.diff?.oldText !== block.diff?.oldText ||
        merged.diff?.newText !== block.diff?.newText ||
        merged.title !== block.title ||
        merged.output !== block.output;
      if (contentChanged) recountBlockTokens(merged);
      blocks[i] = merged;
      return i;
    }
  }
  blocks.push({ ...patch, output, truncatedChars, id: nextBlockId() });
  return blocks.length - 1;
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

/** Index of the SubAgent block bound to `agentId` (P-1: index instead of the
 * block reference so the caller can report the mutation position). */
function findSubAgentIndex(blocks: Block[], agentId: string): number | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.kind === "subagent" && (block.agentId === agentId || block.taskToolCallId === agentId)) {
      return i;
    }
  }
  return null;
}

/** Fallback binding: a `task` tool_call arrived without an agentId — adopt the
 * newest unfinished such block once the real agentId shows up. Returns the
 * block index (P-1 change reporting). */
function adoptUnboundSubAgent(blocks: Block[], agentId: string): number | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (
      block.kind === "subagent" &&
      block.agentId === block.taskToolCallId &&
      block.taskToolCallId !== null &&
      (block.status === "pending" || block.status === "in_progress")
    ) {
      block.agentId = agentId;
      return i;
    }
  }
  return null;
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
function findActiveSubAgentIndex(blocks: Block[]): number | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.kind === "subagent" && (block.status === "pending" || block.status === "in_progress")) {
      return i;
    }
  }
  return null;
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
 * Returns the lowest mutated/appended block index (P-1 change reporting).
 */
function appendAgentChunk(blocks: Block[], text: string): number | null {
  const MARKER = '{"type":"compression"';
  let rest = text;
  let first: number | null = null;
  const note = (i: number | undefined): void => {
    if (i !== undefined && (first === null || i < first)) first = i;
  };
  const append = (segment: string): number | undefined =>
    appendTextToLast(blocks, "text", segment, isSystemStatusText(segment));
  for (;;) {
    const idx = rest.indexOf(MARKER);
    if (idx < 0) break;
    const parsed = parseCompressionItem(rest, idx);
    if (!parsed) break; // torn or foreign — remainder stays verbatim
    if (idx > 0) note(append(rest.slice(0, idx)));
    blocks.push({
      kind: "compression",
      id: nextBlockId(),
      notice: formatCompressionNotice(parsed.item),
      summary: compressionSummaryOf(parsed.item),
    });
    note(blocks.length - 1);
    rest = rest.slice(parsed.end);
  }
  if (rest) note(append(rest));
  return first;
}

/** Apply one session update to a block list (top-level transcript or a
 * SubAgent's entries). Mutates the list. Returns the lowest mutated/appended
 * block index, or null when the update touched no block (P-1 change
 * reporting). */
function applyUpdateToBlocks(blocks: Block[], update: SessionUpdate): number | null {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return update.content.type === "text" ? appendAgentChunk(blocks, update.content.text) : null;
    case "agent_thought_chunk":
      return update.content.type === "text" ? appendTextToLast(blocks, "thought", update.content.text) ?? null : null;
    case "user_message_chunk":
      // Live prompts: the host appends user blocks itself, so agent echo is
      // ignored. During `session/load` replay (M4) user turns arrive through
      // this notification and must be rendered.
      return update.content.type === "text" ? appendTextToLast(blocks, "user", update.content.text) ?? null : null;
    case "tool_call":
      return upsertToolBlock(blocks, {
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
    case "tool_call_update":
      return upsertToolBlock(blocks, {
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
    case "plan":
      blocks.push({
        kind: "plan",
        id: nextBlockId(),
        entries: update.entries.map((e) => ({ content: e.content, status: e.status, priority: e.priority })),
      });
      return blocks.length - 1;
    default:
      return null;
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
): number | null {
  const update = notification.update;

  // Strategy 1: documented `agentId` grouping.
  const agentId = extractAgentId(notification);
  if (agentId) {
    let subIdx = findSubAgentIndex(state.blocks, agentId) ?? adoptUnboundSubAgent(state.blocks, agentId);
    if (subIdx === null) {
      const title =
        (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update"
          ? update.title || update.toolName
          : undefined) ?? l10n.t("子智能体");
      state.blocks.push({ kind: "subagent", id: nextBlockId(), agentId, taskToolCallId: null, title, status: "in_progress", agentType: null, entries: [] });
      subIdx = state.blocks.length - 1;
    }
    const sub = state.blocks[subIdx] as SubAgentBlock;
    applyUpdateToBlocks(sub.entries, update);
    if (
      (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
      update.toolCallId === sub.taskToolCallId &&
      update.status
    ) {
      sub.status = update.status;
    } else {
      refreshSubAgentStatus(sub);
    }
    // Nested entries mutate in place, but the card rides every blockPatch
    // re-serialization with a fresh reference — reporting its index makes
    // the webview re-render it.
    return subIdx;
  }

  // Strategy 2: `task` tool_call interval state machine.
  const activeIdx = findActiveSubAgentIndex(state.blocks);
  const isTask = isTaskToolCall(update);

  if (isTask) {
    const taskUpdate = update as {
      status?: ToolCallStatus;
      title?: string;
      toolCallId?: string;
      toolName?: string;
    };
    if (activeIdx !== null) {
      const active = state.blocks[activeIdx] as SubAgentBlock;
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
      applyUpdateToBlocks(active.entries, update);
      return activeIdx;
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
    return state.blocks.length - 1;
  }

  if (activeIdx !== null) {
    // Flat nested activity inside the open interval → into the card.
    if (isNestedUpdate(update)) {
      const active = state.blocks[activeIdx] as SubAgentBlock;
      applyUpdateToBlocks(active.entries, update);
      refreshSubAgentStatus(active);
      return activeIdx;
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
        return appendTextToLast(state.blocks, "user", update.content.text) ?? null;
      }
      return null;
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "tool_call":
    case "tool_call_update":
    case "plan":
      return applyUpdateToBlocks(state.blocks, update);
    case "available_commands_update":
      state.commands = update.availableCommands;
      return null;
    case "current_mode_update":
      if (state.modes) state.modes = { ...state.modes, currentModeId: update.currentModeId };
      return null;
    default:
      return null;
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
): number {
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
  return state.blocks.length - 1;
}

/** CJK-aware fallback used only if the real tokenizer fails to load. */
function heuristicTokens(text: string): number {
  const cjk = (text.match(/[　-鿿぀-ヿ＀-￯]/g) ?? []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk * 1.5 + other * 0.25);
}

/** Token count for a string using a real BPE tokenizer (gpt-tokenizer,
 * o200k_base). Falls back to a CJK-aware heuristic if the library is unavailable.
 * The CLI is frozen and reports no usage, so the host estimates consumption from
 * the transcript itself. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  try {
    return gptCountTokens(text);
  } catch {
    return heuristicTokens(text);
  }
}

/** Flatten a block's human-readable text for token estimation. Compression
 * blocks are skipped — their summary is a derivative of already-counted content
 * and would double-count. */
function blockText(block: Block): string {
  switch (block.kind) {
    case "text":
    case "thought":
    case "user":
      return block.text;
    case "tool":
      return `${block.title}\n${block.output}${block.diff?.newText ?? ""}`;
    case "plan":
      return block.entries.map((e) => e.content).join("\n");
    case "subagent":
      return block.entries.map(blockText).join("\n");
    case "compression":
      return "";
  }
}

/**
 * P1 incremental token estimation: `tokens` caches a block's own token count
 * (written by the reducer when a block's content definitively changes, and
 * lazily for blocks without one), so each turn end only tokenizes the new
 * content instead of re-running BPE over the whole transcript (a 100k-token
 * session previously cost hundreds of ms of host CPU per turn). With
 * streaming appends accumulating incrementally and tool blocks recounting
 * only on real content changes, caches stay VALID throughout a turn — a
 * real-time usage refresh is then a pure integer fold over these caches.
 * SubAgent cards sum their entries' caches LIVE instead of caching the sum:
 * nested updates mutate entries in place (no invalidation hook reaches the
 * parent), and the fold is pure addition of already-cached values, so it is
 * cheap enough to recompute on every refresh with zero stale-cache risk.
 * The BPE sum-vs-whole boundary difference is acceptable for a usage ESTIMATE.
 */
function blockTokens(block: Block): number {
  if (block.kind === "compression") return 0;
  if (block.kind === "subagent") {
    let sum = 0;
    for (const e of block.entries) sum += blockTokens(e);
    return sum;
  }
  if (block.tokens !== undefined) return block.tokens;
  const t = estimateTokens(blockText(block));
  block.tokens = t;
  return t;
}

/** Invalidate (recompute in place) a block's token cache after the reducer
 * mutated its content. Only called from definitive change points — streaming
 * tail growth is coalesced by the store and cached lazily at turn end. */
function recountBlockTokens(block: Block): void {
  block.tokens = block.kind === "compression" ? 0 : estimateTokens(blockText(block));
}

/** Estimate cumulative token usage of the whole transcript. The CLI is frozen
 * and reports no usage, so the host estimates from the rendered blocks. Reads
 * each block's token cache (establishing it lazily); only blocks without a
 * valid cache trigger a fresh tokenize. An empty transcript yields a zeroed
 * object (not null) so the UI chip shows from the first paint. */
export function estimateSessionUsage(blocks: Block[]): SessionUsageUi {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const b of blocks) {
    const t = blockTokens(b);
    if (t === 0) continue;
    // User prompts and tool I/O are context the model consumes (input); agent
    // text/thought/plan/subagent output is generation (output).
    if (b.kind === "user" || b.kind === "tool") inputTokens += t;
    else outputTokens += t;
  }
  return { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: inputTokens + outputTokens };
}

export function completePrompt(state: SessionState, stopReason: StopReason): void {
  // The CLI is frozen and never reports usage, so the host estimates cumulative
  // consumption from the transcript itself (recomputed idempotently each turn).
  refreshSessionUsage(state);
  state.stopReason = stopReason;
  state.status = "idle";
}

/**
 * Recompute `state.usage` in place for a real-time refresh mid-turn. Cheap by
 * design: every block's token cache stays valid during streaming (appends
 * accumulate, tool blocks recount only on content changes), so this is an
 * integer fold — no tokenizer call unless a legacy block lacks a cache.
 * Reference-stable: when the numbers are unchanged the existing object is
 * kept, so the webview's zustand selector (Object.is) skips re-rendering the
 * usage chip on refreshes where nothing moved.
 */
export function refreshSessionUsage(state: SessionState): void {
  const next = estimateSessionUsage(state.blocks);
  const prev = state.usage;
  if (prev && prev.inputTokens === next.inputTokens && prev.outputTokens === next.outputTokens) {
    return;
  }
  state.usage = next;
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
  // Token usage is per-session; a new session starts from a zeroed counter
  // (the chip shows ↑0 ↓0 instead of hiding — the CLI does not yet report
  // usage, so the host's transcript estimate starts fresh here).
  fresh.usage = emptySessionUsage();
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
 * No placeholder block: the webview renders its own replay indicator while
 * `replaying` is true (a block would stream like assistant text and grow
 * copy icons).
 */
export function beginReplay(state: SessionState): void {
  state.blocks = [];
  state.pendingApproval = null;
  state.pendingPlanExit = null;
  state.replaying = true;
  state.status = "streaming";
  state.errorMessage = null;
  state.stopReason = null;
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
 * ALSO seeds the id counter past every id it sees: restored ids were minted
 * by a PREVIOUS extension-host lifetime, and the module counter restarts at
 * 0 on every host reload — without the seed the next minted id would collide
 * with a restored one (404 duplicate ids measured in a real transcript:
 * restored blocks up to `b4t` followed by fresh blocks restarting at `b1`).
 */
function seedBlockSeqPast(id: string | undefined): void {
  if (!id) return;
  const m = /^b([0-9a-z]+)$/.exec(id);
  const digits = m?.[1];
  if (!digits) return;
  const n = Number.parseInt(digits, 36);
  if (Number.isFinite(n) && n > blockSeq) blockSeq = n;
}

export function backfillBlockIds(blocks: Block[]): void {
  for (const block of blocks) {
    // Seeding MUST happen even for blocks that already carry an id: the
    // counter only guarantees uniqueness against ids it has minted itself,
    // and restored ids come from a previous host lifetime.
    seedBlockSeqPast(block.id);
    if (!block.id) block.id = nextBlockId();
    // Pre-system-classification transcripts carry no `system` flag — re-derive
    // it so restored status lines still render as muted system notes. Only
    // when absent: an explicit value (host-written) is authoritative.
    if (block.kind === "text" && block.system === undefined) {
      block.system =
        isSystemStatusText(block.text) || LEGACY_RESOLUTION_NOTE.test(block.text) || undefined;
    }
    if (block.kind === "subagent") backfillBlockIds(block.entries);
  }
}

/**
 * Re-mint EVERY id in a restored transcript before it enters the live block
 * array. Structural isolation (user directive): a new session must share
 * NOTHING with historical sessions — not even the id namespace. Restored ids
 * come from previous host lifetimes whose counters this process can never
 * know; rather than trusting them, each restored block gets a fresh id from
 * THIS host's counter (seeded past the originals by backfillBlockIds), so
 * live minting can never collide regardless of what any past lifetime
 * produced. The original ids stay untouched in the persisted file (lossless).
 * Recurses into SubAgent entries. Mutates in place; call after
 * backfillBlockIds (which seeds the counter past the old ids first).
 */
export function reassignBlockIds(blocks: Block[]): void {
  for (const block of blocks) {
    block.id = nextBlockId();
    if (block.kind === "subagent") reassignBlockIds(block.entries);
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
          blocks.push({
            kind: "text",
            text: block.text,
            ...(isSystemStatusText(block.text) ? { system: true } : {}),
          });
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

// --- plan exit (_iflow/plan/exit) --------------------------------------------

/** Show the Plan-mode exit confirmation card. The WebView answers via
 * `respondPlanExit`. */
export function setPendingPlanExit(state: SessionState, pending: PendingPlanExitUi): void {
  state.pendingPlanExit = pending;
}

/** Clear the card once answered (or timed out / cancelled host-side). */
export function clearPendingPlanExit(state: SessionState, id: string): boolean {
  if (state.pendingPlanExit?.id !== id) return false;
  state.pendingPlanExit = null;
  return true;
}

/**
 * Append a resolution note below the approval so the transcript records what
 * the user chose (the card itself is transient).
 */
export function appendApprovalResolution(state: SessionState, toolName: string, resolution: string): number {
  const label = toolName || "tool";
  state.blocks.push({
    kind: "text",
    id: nextBlockId(),
    text: `*${label} — ${resolution}*`,
    system: true,
  });
  return state.blocks.length - 1;
}

// --- session-update drop guard (pure; unit-tested) ---------------------------

/**
 * Decide whether one `session/update` notification must be dropped before it
 * reaches the reducer. Pure so the guard chain is unit-testable — the leak it
 * guards against (an abandoned turn's trailing chunks repopulating a freshly
 * cleared transcript) was user-reported twice before this became a function.
 *
 * Rules:
 * - `resetting` (the 新会话 window between replaceState and sessionStarted):
 *   drop everything not addressed to the store's own session — including
 *   updates that carry NO sessionId, which is exactly how the abandoned
 *   turn's stragglers got through the earlier id-only guards.
 * - Restore window: the replay legitimately repopulates the cleared
 *   transcript, but ONLY updates tagged with the session being restored (or
 *   untagged replayed turns) pass — an abandoned turn streaming on a foreign
 *   session must not ride the exemption.
 * - Unattributable (no sessionId): the real CLI stamps sessionId on EVERY
 *   session/update (wire fixture 2026-09-05, CLI 0.5.19 — 3/3), so a
 *   sessionId-less update cannot be tied to any session. Accept it only when
 *   a turn is verifiably in flight on the store's own session; during
 *   resets, restore setup, or an idle session it is dropped.
 */
export function dropSessionUpdate(args: {
  sessionId: string | null | undefined;
  storeSessionId: string | null;
  status: SessionState["status"];
  restoring: boolean;
  resetting: boolean;
  /** The session being restored; during the restore window only updates
   * tagged with this id (or untagged replayed turns) legitimately pass. */
  restoringSessionId?: string | null;
}): boolean {
  const { sessionId, storeSessionId, status, restoring, resetting } = args;
  const foreign = sessionId !== null && sessionId !== undefined && sessionId !== storeSessionId;
  if (resetting && sessionId !== storeSessionId) return true;
  if (restoring) {
    // Restore window: the replay legitimately repopulates the cleared
    // transcript, but ONLY for the session being restored — an abandoned turn
    // still streaming on a foreign session must not ride the exemption.
    if (sessionId && sessionId !== (args.restoringSessionId ?? null)) return true;
    return false;
  }
  if (foreign) return true;
  if ((sessionId === null || sessionId === undefined) && !restoring) {
    if (resetting || storeSessionId === null || status !== "streaming") return true;
  }
  return false;
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

/** Mark a tool's diff as reverted (visual only; the file write happens host-side).
 * Returns the mutated block index, or null when no such tool block exists. */
export function markToolReverted(state: SessionState, toolCallId: string): number | null {
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const block = state.blocks[i]!;
    if (block.kind === "tool" && block.toolCallId === toolCallId) {
      // C4: `reverted` is orthogonal to `status` — the tool SUCCEEDED, its
      // change was undone. The old status="failed" leaked the failure into
      // SubAgent cards nesting the tool (refreshSubAgentStatus).
      block.reverted = true;
      const reverted = l10n.t("[已回退]");
      block.output = block.output ? `${block.output}\n${reverted}` : reverted;
      // P1: output changed — the token cache is stale.
      recountBlockTokens(block);
      return i;
    }
  }
  return null;
}

export type { ToolDiffUi };

export type { ToolCallStatus };
