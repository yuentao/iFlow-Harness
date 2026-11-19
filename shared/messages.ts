/**
 * Extension Host ↔ WebView message protocol (type-safe both sides).
 * Snapshot model per plan §2.1: the Extension Host owns the full session
 * state; the WebView is a projection that receives throttled snapshots.
 */

import type {
  SessionModeState,
  SlashCommand,
  SkillInfo,
  ToolCallStatus,
  ToolKind,
  ToolLocation,
  StopReason,
  UserQuestion,
  McpServerStatusView,
  McpToolView,
  McpPromptView,
} from "../src/acp/protocol.js";
import {
  normalizeQqAllowEntries,
  type QqAllowEntry,
  type QqAllowEntryInput,
} from "./qq-access.js";
import type { SuperActionReceipt, SuperDirectiveAction, SuperIntegrationMode, SuperSessionUi } from "./super-agent.js";

// Webview components import wire types from this module — re-export the
// protocol types they need.
export type { SlashCommand, UserQuestion, SkillInfo };
// MCP status wire types (mcp-status-refactor Mod): the settings card renders
// the per-server view and the detail sub-page consume tools/prompts directly.
// The report envelope itself is consumed host-side from src/acp/protocol.js.
export type { McpServerStatusView, McpToolView, McpPromptView };


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
 * M4 P0-2 — one hunk of a whole-file old→new change (computed by
 * `shared/hunks.ts#computeHunks`, never persisted to disk — always derived
 * from the diff text so it can never drift from it). `rowStart`/`rowEnd`
 * index the shared `diffRows` sequence (the renderer's line list) so the
 * keep/revert header lands on the right rows; the old/new ranges drive the
 * deterministic replay.
 */
export interface DiffHunkUi {
  /** First `diffRows` row index belonging to this hunk. */
  rowStart: number;
  /** One past the last row index. */
  rowEnd: number;
  /** 0-based start line in oldText's split("\n"). */
  oldStart: number;
  /** Lines replaced in oldText (0 = pure insertion). */
  oldLines: number;
  /** 0-based start line in newText's split("\n"). */
  newStart: number;
  /** Lines inserted from newText (0 = pure deletion). */
  newLines: number;
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
  /** Host-observed lifecycle timestamps. Legacy transcripts omit these. */
  startedAt?: number;
  completedAt?: number;
  /**
   * P1 incremental token estimation: cached token count of this block's
   * text (host-side only; the webview ignores it). Written by the reducer
   * when content definitively changes, accumulated incrementally on streaming
   * appends, and lazily established for blocks without one — so the cache
   * stays valid throughout a turn and both the turn-end and the throttled
   * real-time usage refreshes are pure sums over these caches.
   */
  tokens?: number;
  /**
   * Webview-only memory eviction marker (long-session bloat, 2026-10):
   * `evictBlockPayloads` released this block's heavy payload (tool output /
   * diff, thought text, attached images, compression summary) because it sat
   * far outside the render window. The HOST never sets this — its state stays
   * complete for revert / openDiff / export / transcript persistence — so the
   * flag only ever appears in the webview projection, where the UI renders an
   * honest "released" marker instead of an empty card.
   */
  evicted?: boolean;
}

export interface TextBlock extends BlockBase {
  kind: "text";
  text: string;
  /**
   * Host-classified status text, not an assistant reply: CLI compression
   * chatter ("正在压缩…", "压缩聊天历史失败：…") and approval
   * resolution notes. The webview renders these as muted system lines
   * without copy/regenerate actions.
   */
  system?: boolean;
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
  /**
   * 这条用户消息的来源渠道（宿主写入，webview 只渲染徽标）。
   *
   * `qq` = 由 QQ 机器人转来、固定注入主会话的外部消息：它在本机
   * 用户眼里必须与亲手输入的消息可区分 —— 徽标 + 来源包裹是安全边界的一部分，
   * 不能靠正文内容自行判断。
   */
  origin?: "qq";
}

/** Webview DOM cap for one tool-output pane (3.5 ②). The host store keeps
 * up to `MAX_TOOL_OUTPUT_STORE_CHARS` (512K, shared/session-state.ts); this
 * constant only bounds what the collapsed output <pre> renders. Copy-full /
 * open-as-file recover everything the store kept beyond it. */
export const MAX_TOOL_OUTPUT_DISPLAY_CHARS = 64 * 1024;

/**
 * One delegated task of a `super-agent` dispatch call, as the HOST parsed it.
 *
 * The card renders from this structure rather than from the lossy `input`
 * display string — see {@link ToolBlock.superTasks} for the full rationale.
 *
 * `attachmentCount` is a COUNT on purpose: attachment bodies (file contents,
 * inlined base64 images) must never enter the snapshot (pitfall #27 discipline
 * — a pasted image is ≤8MB and would blow the snapshot up).
 */
export interface SuperDelegatedTaskUi {
  /** Task title (the model may omit it; the host falls back to the task's first line). */
  title: string;
  /** The full task brief handed to the child session. */
  task: string;
  /** How many attachments the task carried (names/bodies never enter the snapshot). */
  attachmentCount: number;
}

export interface ToolBlock extends BlockBase {
  kind: "tool";
  toolCallId: string;
  toolName: string;
  title: string;
  toolKind: ToolKind;
  status: ToolCallStatus;
  output: string;
  /**
   * Formatted display text of the tool's raw invocation args (wire
   * `tool_call_update(in_progress).args`, probed CLI 0.5.19): shell/search
   * cards showed only the tool name and users could not audit WHAT was
   * executed. The host pre-formats (execute → the command line itself;
   * otherwise compact JSON with per-value truncation) and caps the length,
   * so raw args — which can carry a whole-file `content` payload — never
   * linger in memory (pitfall #27 discipline). Null/absent = nothing to show.
   *
   * NOTE: it is a LOSSY display string on purpose — the delegation card must
   * NOT parse it back (see `superTasks`).
   */
  input?: string | null;
  /**
   * Delegated tasks of a `super-agent` dispatch call, as parsed BY THE HOST.
   *
   * Why the card cannot parse `input` back: `input` is a lossy display string
   * (per-value truncation at 300 chars, whole payload capped at 4096 chars) —
   * a long task brief gets cut in the middle and the JSON stops being JSON.
   * On top of that the model sometimes omits `title` (wire evidence), which
   * the dispatcher tolerates (falls back to the task's first line) while a
   * stricter card reader would call the whole delegation unparseable — a false
   * alarm about a delegation that really happened.
   *
   * So the host parses the RAW args once and ships the structure; the card
   * renders it. Null/absent = this is not a dispatch call (or the payload was
   * unusable) — the card then falls back to parsing `input` for legacy
   * transcripts, and finally to the honest "unparseable" notice.
   */
  superTasks?: SuperDelegatedTaskUi[] | null;
  /**
   * 宿主解析 `super-agent` 委派载荷时遇到的格式问题（可诊断的失败原因）。
   *
   * 与 `superTasks` 同源：都来自宿主对**原始 args** 的解析，绝不是对展示串
   * `input` 回解的结果。两种情形会写入：
   *  - 载荷整体不可用（如 `tasks` 是字符串数组）→ `superTasks` 缺省，本字段
   *    是「哪一条字段写错了」的具体说明；
   *  - 混合载荷（部分条目畸形）→ `superTasks` 只含合法项，本字段说明被忽略
   *    的条目及原因 —— 不能让畸形条目静默消失。
   *
   * null/absent = 载荷没有格式问题（或这不是派发调用）。合并时后续不带 args
   * 的 completed 帧不得把它擦掉（见 `upsertToolBlock`）。
   */
  superTasksError?: string | null;
  /**
   * 宿主执行 `super-agent` **管理动作**后的真实结果（每条动作一份 ok/reason）。
   *
   * 为什么需要它：`block.status === "completed"` 只表示工具帧返回了（内核对
   * super-agent 工具只回一句 ack），不表示动作真的生效 —— cancel 抄错 id 报
   * not-found 时工具帧同样是 completed。动作卡必须以本字段为准显示：全 ok
   * 才是「已完成」，not-found / 失败显示警告色并给出原因摘要。宿主在
   * `runSuperActions` 收尾时按 toolCallId 回填；null/absent = 还没回填（流式中
   * 或旧转录），卡片不得因此谎报「已完成」。
   */
  superActionResult?: SuperActionReceipt[] | null;
  /**
   * 宿主构造的子会话管理动作（含每项目标子会话的 `title`）。与 `superTasks`
   * 同理：卡片优先渲染本字段而不是回解有损的 `input`，因为标题只存在于宿主的
   * super-session 记录里，`input` 里只有裸 id。宿主在 `runSuperActions` 收尾时
   * 按 toolCallId 回填；null/absent = 还没回填（流式中或旧转录），卡片退回
   * 解析 `input`（此时无标题，只显示 id —— 诚实降级，不伪造占位符）。
   */
  superActions?: SuperDirectiveAction[] | null;
  /**
   * P-1 follow-up: present when `output` exceeded the host STORE cap
   * (`MAX_TOOL_OUTPUT_STORE_CHARS`, 512K, shared/session-state.ts) and was
   * capped — the number of dropped characters. The webview renders at most
   * `MAX_TOOL_OUTPUT_DISPLAY_CHARS` (64K) and surfaces both facts: a
   * truncation notice plus copy-full / open-as-file actions that recover
   * everything the store kept (3.5 ②).
   */
  truncatedChars?: number;
  locations: ToolLocation[];
  /** Present when the update carried a structured diff (`type: "diff"`). */
  diff: ToolDiffUi | null;
  /**
   * Webview-only: set by `evictBlockPayloads` when it releases `diff` (the
   * host keeps the full record). Lets the turn-review entry stay available
   * for old turns whose diff payload is no longer in the webview state.
   */
  hadDiff?: boolean;
  /**
   * C4: the tool succeeded but its change was reverted (UI-only marker).
   * Orthogonal to `status` — marking reverted tools as `failed` leaked the
   * "failed" aggregate into SubAgent cards nesting successful tools.
   */
  reverted?: boolean;
  /**
   * M4 P0-2 — per-hunk keep/revert decisions after `applyHunkSelection`
   * committed (index-aligned with `computeHunks(diff.oldText, diff.newText)`;
   * true = keep the new-side change, false = revert that hunk). Persisted so
   * a re-render restores the hunk headers' state. Cleared when a NEW diff
   * arrives for the same tool call (the decisions anchor to the old text).
   */
  hunkDecisions?: boolean[];
  /**
   * M4 P0-2 — a partial (per-hunk) revert landed: the file now holds the
   * replayed text, neither the diff's newText nor its oldText. Distinct from
   * `reverted` (whole-file revert).
   */
  partiallyReverted?: boolean;
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
  /**
   * Host-set (optimistic, never from the wire): the user stopped this agent
   * via `_iflow/agent/cancel` and the CLI confirmed. The adapter still emits
   * AGENT_FAILED for an aborted agent, so without this flag the card would
   * read "failed" where the user meant "stopped".
   */
  stopped?: boolean;
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
  /** Authoritative post-compression context size from the CLI event (the
   * summary the model actually carries; null on the pending card). The usage
   * estimator folds everything before the last completed compression card
   * into this number instead of re-counting the discarded blocks, so the
   * context counter drops to the compressed context. */
  newTokenCount: number | null;
}

/** One entry of an InjectedContextBlock: a source auto-injected into the
 * session's requests, with its FULL body (the panel promises complete
 * transparency — the CLI-side acp-context-report Mod surfaces what the wire
 * never carries). */
export interface InjectedContextItem {
  /** Source kind: the CLI's assembled system instruction, the global memory
   * body, one project memory file (AGENTS.md/IFLOW.md/...), one project
   * knowledge document expanded from an `@.iflow/knowledge/...` import, or
   * one MCP server's tool declarations (the CLI turns every connected
   * server's tools into `functionDeclarations` carried on EVERY request —
   * the wire never reports them, the mcp-status Mod does). */
  kind: "system" | "memory" | "context-file" | "knowledge" | "mcp";
  /** Display name, e.g. "系统提示词", "AGENTS.md", "apipost-mcp". */
  label: string;
  /** Absolute path for file-backed sources (absent for the system prompt). */
  path?: string;
  /** Knowledge only: the memory file this import was expanded from. */
  from?: string;
  /** Full body as the model receives it (MCP: one compact JSON declaration
   * per line, the same shape the CLI serializes into functionDeclarations).
   * MCP bodies are hidden in the UI but still feed the card's token estimate.
   * Empty for servers whose tools never rode the request — never fabricated. */
  content: string;
  /** MCP only: false = the server had not finished connecting when the
   * request started, so its tools are NOT part of the request — shown as
   * unloaded and counted at 0 tokens. Absent = carried. */
  connected?: boolean;
  /** MCP only: which settings scope(s) define this server. The CLI merges
   * `{ ...user, ...workspace }` (probed CLI 0.5.19 bundle), so `both` means
   * the two files declare the same name and the PROJECT entry is the one
   * actually running. Absent = the host could not read either scope file. */
  scope?: McpScope | "both";
}

/**
 * Auto-injected context explainer (inserted before the FIRST user prompt of
 * a session): the CLI silently prepends its system instruction, the joined
 * hierarchical memory and the context files to every request. The host
 * reads the acp-context-report Mod's snapshot (IFLOW_HARNESS_CONTEXT_FILE,
 * written at startChat — i.e. the moment the request context is assembled)
 * and inserts this card so the user always sees exactly what the model saw.
 * Folded by default; the header lists what was injected. Falls back to a
 * disk-side collection (memory.md + context files, system prompt marked
 * unavailable) when the bundled CLI carries no Mod (plain upstream CLI).
 */
export interface InjectedContextBlock extends BlockBase {
  kind: "injected";
  /** One-line summary, e.g. "这次请求还自动带上了 3 项内容：系统提示词、全局记忆、1 个项目记忆文件". */
  notice: string;
  items: InjectedContextItem[];
  /** Estimated tokens of ALL injected bodies (host-side BPE over the full
   * content). Shown on the collapsed header so the user sees the fixed
   * per-request cost without expanding; survives payload eviction. */
  tokens?: number;
}

/** One visual segment of a system prompt (see splitSystemPromptSections). */
export interface InjectedPromptSection {
  /** "core" = the CLI's core instruction; "memory" = global memory.md body
   * (between P0e's `---` separator and the first file block); "context-file"
   * = one hierarchical context file inlined by the memory joiner. */
  kind: "core" | "memory" | "context-file";
  /** File path for context-file sections; "" for core/memory. */
  path: string;
  content: string;
}

/**
 * Split the reported system prompt into visual sections. Pure display helper
 * — the block still stores the single verbatim body (transparency promise);
 * this only slices it for rendering. Format provenance (CLI 0.5.19 bundle):
 *   - P0e returns `${core}\n\n---\n${userMemory.trim()}`
 *   - the memory joiner Gva() emits one block per context file:
 *     `--- Context from: <rel-path> ---\r\n<body>\r\n--- End of Context from: <rel-path> ---`
 *     joined by blank lines; anything outside the markers is global memory.md.
 * Text without markers (fallback-collected items, evicted bodies) returns a
 * single core section, so callers can render uniformly.
 */
export function splitSystemPromptSections(text: string): InjectedPromptSection[] {
  const first = text.indexOf("--- Context from:");
  if (first === -1) return [{ kind: "core", path: "", content: text }];
  // P0e's separator between the core prompt and the memory region: the last
  // standalone `---` line before the first file marker.
  const before = text.slice(0, first);
  const sep = before.lastIndexOf("\n---\n");
  const coreEnd = sep === -1 ? 0 : sep;
  const sections: InjectedPromptSection[] = [];
  const core = text.slice(0, coreEnd).trim();
  if (core) sections.push({ kind: "core", path: "", content: core });
  const re = /--- Context from: ([\s\S]*?) ---\r?\n([\s\S]*?)\r?\n--- End of Context from:[^\r\n]*---/g;
  let lastEnd = sep === -1 ? 0 : sep + "\n---\n".length;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const lead = text.slice(lastEnd, m.index).trim();
    if (lead) sections.push({ kind: "memory", path: "", content: lead });
    sections.push({ kind: "context-file", path: m[1]!.trim(), content: m[2]! });
    lastEnd = m.index + m[0].length;
  }
  const tail = text.slice(lastEnd).trim();
  if (tail) sections.push({ kind: "core", path: "", content: tail });
  return sections;
}

/** One source carried by the reported system prompt, ready for the
 * auto-injected-context card. `path` is the context-file path as reported
 * (relative to the session cwd) or the knowledge import spec; `from` is the
 * project memory file a knowledge import was expanded into. */
export interface ReportedContextSection {
  kind: "system" | "memory" | "context-file" | "knowledge";
  path?: string;
  from?: string;
  content: string;
}

const KNOWLEDGE_IMPORT_PATH = /(?:^|\/)\.iflow\/knowledge\//i;
/** The CLI import processor (sfr in the bundle): inlines every `@import` as
 * this marker pair. Backreference keeps nested imports inside the body. */
const IMPORT_MARKER = /<!-- Imported from: ([\s\S]*?) -->\r?\n([\s\S]*?)\r?\n<!-- End of import from: \1 -->/g;

function isKnowledgeImportPath(spec: string): boolean {
  return KNOWLEDGE_IMPORT_PATH.test(spec.replace(/\\/g, "/").replace(/^\.\//, "").trim());
}

/**
 * Slice the reported system prompt into card sources. The memory joiner
 * already marks project memory files (`--- Context from: … ---`), and the
 * import processor inlines knowledge-base imports inside those bodies; peel
 * the latter out as `knowledge` sections so the card can show 全局记忆 /
 * 项目记忆 / 项目知识库 separately. Display-level slicing only — the
 * concatenated section bodies cover the same prompt bytes.
 */
export function splitReportedContextSections(text: string): ReportedContextSection[] {
  const out: ReportedContextSection[] = [];
  for (const section of splitSystemPromptSections(text)) {
    if (section.kind === "core") {
      out.push({ kind: "system", content: section.content });
      continue;
    }
    if (section.kind === "memory") {
      out.push({ kind: "memory", content: section.content });
      continue;
    }
    const raw = section.content;
    IMPORT_MARKER.lastIndex = 0;
    let last = 0;
    let found = false;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_MARKER.exec(raw))) {
      const spec = match[1]!.trim();
      if (!isKnowledgeImportPath(spec)) continue;
      found = true;
      const before = raw.slice(last, match.index).trim();
      if (before) out.push({ kind: "context-file", path: section.path, content: before });
      out.push({ kind: "knowledge", path: spec, from: section.path, content: match[0] });
      last = match.index + match[0].length;
    }
    if (!found) {
      out.push({ kind: "context-file", path: section.path, content: raw });
      continue;
    }
    const tail = raw.slice(last).trim();
    if (tail) out.push({ kind: "context-file", path: section.path, content: tail });
  }
  // No context-file markers (no AGENTS.md/IFLOW.md at all): P0e still appends
  // the joined user memory after `\n\n---\n`. Surface that trailing body as
  // global memory instead of folding it into the system prompt.
  if (out.length === 1 && out[0]!.kind === "system") {
    const sep = out[0]!.content.lastIndexOf("\n\n---\n");
    if (sep > 0) {
      const core = out[0]!.content.slice(0, sep).trim();
      const memory = out[0]!.content.slice(sep + "\n\n---\n".length).trim();
      if (core && memory) return [{ kind: "system", content: core }, { kind: "memory", content: memory }];
    }
  }
  return out;
}

/** Extract the core instruction(s) from a reported system prompt (everything
 * splitSystemPromptSections tags as Core; memory and inlined context files
 * excluded). Developer-only channel: the host writes this to disk so the
 * prompt can be iterated without surfacing its body in the user UI. */
export function extractCorePrompt(text: string): string {
  return splitSystemPromptSections(text)
    .filter((s) => s.kind === "core")
    .map((s) => s.content)
    .join("\n\n---\n\n");
}

export type Block =
  | TextBlock
  | ThoughtBlock
  | UserBlock
  | ToolBlock
  | SubAgentBlock
  | CompressionBlock
  | InjectedContextBlock
  | PlanBlock;

// ---------------------------------------------------------------------------
// Full session state (owned by Extension Host store)
// ---------------------------------------------------------------------------

export interface ModelInfoUi {
  id: string;
  name: string;
  thinking?: boolean;
}

/** User-facing reasoning effort, mapped to iFlow's think configuration. */
export type ThinkLevel = "auto" | "fast" | "balanced" | "deep";

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
  /**
   * Read-only diff preview for edit-type approvals. Wire behavior (probed,
   * CLI 0.5.19 fork bundle): edit tools' `session/request_permission` carries
   * `{type:"diff", path, oldText, newText}` on `toolCall.content` BEFORE the
   * tool runs — the host forwards the first entry so the card can show WHAT
   * the tool is about to write. Null when the request carries no structured
   * diff (shell tools, MCP) or either side exceeds the preview size cap.
   * Optional for older hosts / mock fixtures — absent renders the title-only
   * card.
   */
  diff?: ToolDiffUi | null;
  options: PermissionOptionUi[];
  /** Host-side auto-answer deadline (epoch ms). The webview renders a live
   * countdown so the user knows the card expires on its own. */
  deadline: number;
  /** Total answer window in ms (APPROVAL_TIMEOUT_MS) — used to render a
   * proportional countdown bar. */
  timeoutMs: number;
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
  /** Host-side auto-answer deadline (epoch ms); drives the countdown UI. */
  deadline: number;
  /** Total answer window in ms (APPROVAL_TIMEOUT_MS). */
  timeoutMs: number;
}

/**
 * A pending API-profile switch awaiting the user's choice, rendered as a
 * custom centered modal in the webview (the native showWarningMessage dialog
 * would break the panel's acrylic visual language). The user picks "start a
 * new session" or "keep the current conversation"; dismissing the dialog
 * cancels the entire switch. No deadline: unlike approval cards this blocks
 * no agent, so it waits for the user indefinitely.
 */
export interface PendingProfileSwitchUi {
  id: string;
  /** Display name of the profile being switched TO. */
  profileName: string;
}

/** One entry of the per-workspace recent-session list (M4). */
export interface SessionSummaryUi {
  id: string;
  label: string;
  updatedAt: number;
  /** M4 P1-8: pinned sessions sort above the rest in the switcher. */
  pinned?: boolean;
  /** M4 P1-8: archived sessions move to a collapsed second section and are
   * kept out of the default (active) results. */
  archived?: boolean;
}

/**
 * M2 P0-3 — one queued prompt (typed while a turn is streaming). The queue's
 * truth lives in the Extension Host; this is the UI projection riding the
 * blockPatch tail channel. The full payload (images/files/contexts) stays
 * host-side in a parallel map keyed by `id` — base64 images must never ride
 * every snapshot.
 */
export interface QueuedPromptUi {
  id: string;
  /** The typed text; the UI truncates for display. */
  text: string;
  /** Attachment display names (images + files) — badge only. */
  attachments: string[];
  /** Host-side enqueue time (epoch ms). */
  enqueuedAt: number;
}

/**
 * M3 P0-1 — one turn-level workspace checkpoint (shadow-git snapshot taken
 * before the turn's prompt). The UI projection rides the blockPatch tail
 * channel like the queue; the shadow commits live on disk under
 * `storageUri/checkpoints/<sessionId>/git`. Anchored to the stable id (P4) of
 * the user block that opened the turn — the same key `deleteUserMessage`
 * truncates by, so "restore to this turn" and "delete from this turn" line up.
 */
export interface CheckpointUi {
  /** Stable id of the user block that opened the turn (restore anchor). */
  userBlockId: string;
  /** 0-based turn ordinal (order of user prompts in the session). */
  turnIndex: number;
  /** Shadow commit sha; null when the capture failed or was skipped (partial). */
  sha: string | null;
  /** Host-side capture time (epoch ms). */
  createdAt: number;
  /** True when the snapshot is incomplete (git unavailable / timed out /
   * over the file-count cap) — file restore is unavailable for this turn. */
  partial: boolean;
  /** First line of the turn's prompt (≤30 chars) for the restore dialog. */
  label: string;
}

/** M2 P0-4 — context-source kinds the composer can attach. */
export type ContextKind = "code" | "folder" | "problems" | "git" | "url" | "terminal";

/**
 * M2 P0-4 — one context card above the composer (generalizes the single
 * right-click code-context card). The host resolves `content` (already
 * truncated to the per-kind limit) and assembles every card into a titled
 * fenced section ahead of the typed text at send time.
 */
export interface ContextRefUi {
  id: string;
  kind: ContextKind;
  /** Card title: path / "工作区诊断" / the URL. */
  label: string;
  /** Card subtitle: range / item counts / branch info. */
  detail: string;
  /** The injected body (host-truncated; the composer folds it). */
  content: string;
}

/** Cumulative token usage for the active session. `contextUsed` is the CLI's
 * authoritative occupancy when the acp-usage-report-refactor Mod reported one
 * this turn (see `usageAuthoritative`); the input/output split and everything
 * else stay host estimates from the transcript (the ACP wire carries no split —
 * the generator's real usage never reaches PromptResponse upstream, probed CLI
 * 0.5.19 bundle). Coarse — not for billing.
 * Always present (zeroed at session start) so the UI chip shows from the first
 * paint, not only after the first content turn. */
export interface SessionUsageUi {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /**
   * P0-6 context-occupancy bar: model context window in tokens (host-resolved
   * from the built-in table + `iflow.contextWindowOverrides`; null when the
   * model is unknown and no override matches — the bar then shows the raw
   * count without a percentage).
   */
  contextWindow?: number | null;
  /** Current context occupancy in tokens (post-compression fold; equals the
   * model's actual carried context, not cumulative consumption). */
  contextUsed?: number;
  /**
   * Fixed per-request prefill the model carries on EVERY request, independent
   * of the conversation history: the CLI's assembled system instruction (its
   * built-in template + our override template + the joined hierarchical
   * memory + the project context files + the expanded knowledge docs) plus
   * every connected MCP server's tool declarations.
   *
   * Measured byte-exact from the acp-context-report Mod's snapshot (the same
   * o200k_base BPE as the rest of the estimate), so the occupancy bar stops
   * ignoring the tens of thousands of tokens the model actually reads. The
   * estimate path adds it to the occupancy; the kernel-reported path
   * (`usageAuthoritative`) already contains it inside
   * `lastRequestInputTokens`, so it is NOT added a second time there.
   */
  prefillTokens?: number;
  /** True when `contextWindow` is a conservative fallback guess rather than a
   * table/override hit — the UI labels the percentage "估算". Orthogonal to
   * `usageAuthoritative` (window source vs token source). */
  estimated?: boolean;
  /** True when `inputTokens`/`outputTokens`/`contextUsed` come from the CLI's
   * authoritative turn usage (acp-usage-report-refactor Mod reported them at
   * least once this transcript and nothing has invalidated the numbers since).
   * False/absent = transcript estimation (the fallback while the Mod is missing
   * or the gateway swallowed `stream_options.include_usage`). */
  usageAuthoritative?: boolean;
  /** P0-6 hover breakdown by block kind (only the post-fold tail counts). */
  breakdown?: UsageBreakdownUi;
  /**
   * P1-6 estimated cost in USD from `iflow.costTable` unit prices (per-million
   * tokens × cached token sums). Null when the active model has no unit price.
   */
  estimatedCost?: number | null;
}

/** P0-6 hover breakdown: token sums per block kind (post-compression fold). */
export interface UsageBreakdownUi {
  user: number;
  assistant: number;
  tool: number;
  thought: number;
  /** Fixed prefill (system prompt / memory / tool declarations) — counted
   * outside the compression fold, because the model carries it on every
   * request. Absent on older hosts. */
  prefill?: number;
}

/** Authoritative context occupancy the CLI reported at the last turn end
 * (acp-usage-report-refactor Mod). `atBlockCount` is the transcript length when
 * the report landed — it ANCHORS the number rather than expiring it: the report
 * describes the model's carried context AT that point, and the blocks appended
 * after it are the only thing that context gained since. The CLI replays
 * assistant parts into every later request (thought text included — probed in
 * a real `~/.iflow/acp/sessions/<id>.json` chatHistory), so those appended
 * blocks re-enter the next request's input as prefill and add onto the anchor.
 * A completed compression card INSIDE that delta range supersedes the anchor
 * outright (the fold's floor is the CLI's own `newTokenCount`), and
 * `deleteUserMessageById` truncates chatHistory in lockstep, so it clears the
 * report explicitly. Re-folding the whole transcript instead drifts with the
 * transcript's own biases (SubAgent internals never re-enter the parent
 * window, the fixed system prompt + tool-schema overhead is absent).
 * Only `contextUsed` (and the cache split) is overlaid from this; the
 * input/output split stays estimated (the wire carries no split — roadmap
 * P2-7 第二档). Transcript-scoped: cleared by `clearTranscriptFields`. */
export interface TurnUsageState {
  lastRequestInputTokens: number;
  atBlockCount: number;
  /** Prompt tokens already counted INSIDE `lastRequestInputTokens` (OpenAI-
   * compat `prompt_tokens` folds cache hits in). Informational: occupancy
   * must not add it again, cost would bill it at the cheaper cached rate. */
  cachedReadTokens?: number;
  /** That final request's generated tokens. They are NOT part of
   * `lastRequestInputTokens` but the CLI appends them to history, so they
   * replay into the NEXT request's prompt — occupancy adds this prefill term
   * once, and the blocks carrying the same text are NOT double counted (the
   * delta range starts after the anchor, which already includes them). */
  completionTokens?: number;
}

/**
 * Why the host holds the `initializing` busy lock. The header chip used to
 * claim 「正在创建新会话…」 for every one of these flows (delete session,
 * delete message, rollback) — the label must name the operation that is
 * actually in flight.
 */
export type InitializingReason =
  | "newSession"
  | "deleteSession"
  | "deleteMessage"
  | "rollback"
  | "restore";

/**
 * 「新建会话」流程的宿主投影（从用户点击到新会话就绪、被拒或失败）。
 *
 * `initializing` 只覆盖流程的后半段（真正发 `session/new` 时持有），而点击后
 * 先要等后台落盘链 / 在飞的恢复收尾 / 已有握手，这段时间过去完全没有反馈，
 * 按钮也仍可点（用户实测「新建会话无加载反馈、可重复点击」）。因此单独投影
 * 整个窗口：
 * - `starting`：正在新建会话（准备 / `session/new` / 收尾）。
 * - `waiting`：正在等待后台任务结束（落盘链、在飞的恢复或握手）。
 * null 表示没有新建流程在跑。webview 据此禁用按钮、显示对应文案并置
 * `aria-busy`；宿主在流程结束（成功 / 被拒 / 失败）时一律清回 null。
 */
export type NewSessionPhase = "starting" | "waiting";

/**
 * QQ 远程任务（Wave2-B）的前端投影：一个来自 QQ 的任务从「收到」走到终态的
 * 看板条目。它是**非 blocks 元数据**，搭 blockPatch 的 tail 通道，绝不进入
 * `blocks`——远程任务的转录不污染主会话的渲染真值，也不破坏 blockPatch 的
 * 尾部锚定。
 *
 * 这一波只做投影与设置声明：字段是后续波次（适配层、任务执行、审批）的契约，
 * 宿主尚未写入运行时数据。自包含类型，刻意不 import 任何 QQ 专属模块。
 */
export interface QqTaskUi {
  /** 宿主内唯一的任务 id（幂等 upsert 的键）。 */
  taskId: string;
  /** 展示用短 id（看板/通知里代替长 id）。 */
  shortId: string;
  /** 来源会话类型：单聊或群聊。 */
  chatType: "private" | "group";
  /** 来源会话 id（QQ 侧 chat id）。 */
  chatId: string;
  /** 发起任务的用户 id。 */
  senderId: string;
  /** 任务状态机（终态粘性由宿主维护；投影只如实渲染）。 */
  status:
    | "received"
    | "validated"
    | "queued"
    | "dispatched"
    | "injected"
    | "running"
    | "waiting_approval"
    | "waiting_answer"
    | "succeeded"
    | "failed"
    | "canceled"
    | "timeout"
    | "needs_review"
    /**
     * 用户显式丢弃（工作目录/分支已处置）。终态：看板收起所有动作按钮，
     * 只保留状态与处置说明 —— 分支可能已经不存在，再提供「合并」只会失败。
     */
    | "discarded";
  /**
   * 任务创建时的执行策略（宿主回填）。`trusted` = 免确认，`supervised` = 工具
   * 调用需在 QQ 审批，`readonly` = 只读。缺省表示宿主尚未回填（旧记录）——
   * 投影只如实渲染，绝不自行推导策略。
   */
  policy?: "readonly" | "supervised" | "trusted";
  /**
   * 执行渠道：`main` = 注入主会话（看板标注「渠道：主会话」，状态里能看到
   * 「已注入待回复」）；`child` = Super Agent 子会话（旧行为，也是旧归档的
   * 解释）。
   */
  channel: "main" | "child";
  /** 任务提示词的截断预览（完整正文不进快照）。 */
  promptPreview: string;
  /** 收到任务的时间（epoch ms）。 */
  createdAt: number;
  /** 最近一次状态变更的时间（epoch ms）。 */
  updatedAt: number;
  /** 任务工作分支（隔离执行时由宿主填写）。 */
  branch?: string;
  /** 改动统计：文件数 / 新增行 / 删除行。 */
  changes?: number;
  additions?: number;
  deletions?: number;
  /** 轮次停止原因（CLI 上报，如 end_turn）。 */
  stopReason?: string;
  /** 失败/异常时的可读错误（含「丢弃被拒绝 / 丢弃失败」的原因）。 */
  errorMessage?: string;
  /**
   * 丢弃处置的说明（`status === "discarded"` 时才有）：工作目录是否删掉、
   * 分支是否因未合并提交被保留。看板据此如实展示，不把「分支还在」说成没了。
   */
  discardNote?: string;
  /** 等待用户处置时的摘要（审批或提问）；不含完整载荷。 */
  pending?: { kind: "approval" | "answer"; summary: string };
}

export interface SessionState {
  blocks: Block[];
  status: AgentStatus;
  errorMessage: string | null;
  stopReason: StopReason | null;
  sessionId: string | null;
  modes: SessionModeState | null;
  commands: SlashCommand[];
  /**
   * Skills the CLI reported on `session/new` (`_meta.availableSkills`).
   * The composer renders one `/skill <name>` entry per skill; the host
   * resolves the skill body when such an invocation is sent.
   */
  skills: SkillInfo[];
  models: ModelInfoUi[];
  currentModelId: string | null;
  /** Current user-facing reasoning effort for the active ACP session. */
  thinkLevel: ThinkLevel;
  /** Non-null while the host awaits the user's answer for a tool approval. */
  pendingApproval: PendingApprovalUi | null;
  /** Non-null while the host awaits the user's answers for ask_user_question. */
  pendingQuestions: PendingQuestionsUi | null;
  /** Non-null while the profile-switch choice dialog is open (see PendingProfileSwitchUi). */
  pendingProfileSwitch: PendingProfileSwitchUi | null;
  /** Auth config state (M3): drives the setup banner / form. */
  auth: AuthUiState;
  /** Recent sessions (per-workspace, persisted host-side) for the switcher. */
  sessions: SessionSummaryUi[];
  activeSessionId: string | null;
  /** True while history is being replayed after `session/load` (M4). */
  replaying: boolean;
  /** True while a host-driven busy flow holds the UI (host busy; UI locks switches). */
  initializing: boolean;
  /**
   * Which flow owns the `initializing` lock — drives the busy chip's label
   * (创建会话 / 删除会话 / 删除消息 / 回滚对话 / 恢复会话). Null whenever
   * `initializing` is false; absent in older hosts/mock snapshots (the chip
   * falls back to the new-session wording).
   */
  initializingReason?: InitializingReason | null;
  /**
   * 「新建会话」整个流程的宿主投影：从点击那一刻起就是非 null，直到新会话
   * 就绪 / 被拒 / 失败才清回 null。`initializing` 只覆盖流程后半段，这个
   * 字段补上「点击后立刻有反馈 + 期间禁止重复点击」的窗口，并区分
   * `waiting`（在等后台任务收尾）与 `starting`。缺失（旧宿主 / mock）= null。
   */
  newSessionPhase?: NewSessionPhase | null;
  /**
   * Monotonic count of Core boot attempts that re-entered `connecting` (hot
   * restart / profile-switch reconnect). A restart keeps the splash on
   * `connecting` — the successor handshake owns the same screen — so without
   * this marker the splash's elapsed timer keeps counting the SUPERSEDED
   * boot and the 「重启内核」 escape reads as a dead button. Non-blocks
   * metadata, so it rides the existing blockPatch tail channel; absent in
   * mock hosts and pre-restart snapshots (treated as 0 by the webview).
   */
  connectEpoch?: number;
  /** True while the host drives a `/compress` turn (overflow auto-compress,
   * turn-end proactive compress, or the 立即压缩 pill action). The webview
   * renders the streaming indicator as 正在压缩 instead of plain generating. */
  compressing: boolean;
  /**
   * Monotonic counter of transcript-block mutations, stamped by the host on
   * every full snapshot. Anchors `blockPatch` messages (P-1 incremental
   * snapshots); absent in mock hosts, treated as 0 by the webview.
   */
  blockVersion?: number;
  /** Cumulative token usage for the active session, estimated by the host from
   * the transcript (the CLI's generator layer captures usage but the ACP layer
   * never surfaces it — PromptResponse carries only stopReason, probed CLI
   * 0.5.19 bundle). Zeroed at session
   * start and refreshed live while streaming, so the UI chip is visible from
   * the first paint. Nullable only for wire-compat with older hosts/mock data. */
  usage?: SessionUsageUi | null;
  /**
   * Authoritative context occupancy reported by the CLI at the last turn end
   * (acp-usage-report-refactor Mod: the FINAL model request's input tokens =
   * exactly what the model carried). `atBlockCount` is the transcript length
   * when the report landed — any new block (next turn streaming, or a fresh
   * compression card) makes the number stale, and the fold estimate takes
   * over again (post-compression the fold's floor is the CLI's own
   * newTokenCount, still authoritative). Only `contextUsed` is overlaid;
   * the input/output split stays estimated (the wire carries no split).
   */
  usageReport?: TurnUsageState | null;
  /**
   * M2 P0-3 — prompts typed while a turn streams, waiting for their turn
   * (host-owned FIFO; the webview renders the queue strip). Non-blocks
   * metadata, so it rides the existing blockPatch tail channel.
   */
  queue?: QueuedPromptUi[];
  /**
   * M2 P0-3 — true when the last turn ENDED IN ERROR and auto-dispatch is
   * halted (every queued message would hit the same failure). The composer
   * shows 继续/清空 controls; dispatch resumes on `queueAction: resume`.
   */
  queuePaused?: boolean;
  /**
   * M3 P0-1 — turn-level workspace checkpoints (host-owned shadow-git index;
   * the webview renders a "回滚到此轮" affordance on each anchored user
   * bubble). Non-blocks metadata, so it rides the existing blockPatch tail
   * channel. Absent = checkpointing disabled / nothing captured yet.
   */
  checkpoints?: CheckpointUi[];
  /**
   * Super Agent — the main session's child sessions (sub-sessions). Each one
   * runs in its OWN CLI process inside its own git worktree, so several of
   * them can edit the same project without stepping on each other. The
   * transcript of a sub-session never enters `blocks` (it would pollute the
   * main transcript and break the blockPatch anchor) — the main session only
   * sees this projection. Non-blocks metadata, so it rides the blockPatch
   * tail channel.
   */
  superSessions?: SuperSessionUi[];
  /**
   * 宿主正在等子会话的结果（还有子会话没进终态，或它们的汇报还没投进主会话）。
   *
   * 这是一个**正交**的忙碌标记：它不改 `status`，所以「等待期间用户仍然可以
   * 发消息、并且由主会话响应」这条语义不受影响 —— `status` 一旦变成
   * "streaming"，`sendPrompt` 就会把用户的消息派发成子会话（那是「主会话正在
   * 生成」的语义，不是「主会话在等子会话」）。
   *
   * 面板用它做一件事：禁用「新会话」——等待期点「新会话」会让排队里的汇报
   * 落到已被替换的会话上（汇报丢失 / 归属错位）。顶栏不再为它渲染忙碌 chip，
   * 忙碌信号由转录底部浮动 pill 与子会话看板计数承担。
   * 非 blocks 元数据，所以它搭 blockPatch 的 tail 通道。
   */
  superWaiting?: boolean;
  /**
   * 用户按过「停止」：`superWaiting` 是被显式压住的（排队里的汇报还在，等
   * 下一条消息 / 常驻提示的「继续处理」才投递），不是真的在生成。webview
   * 据此把「新会话」从死锁里放出来（弹如实确认后允许新建），宿主状态栏也
   * 不再谎称「生成中」。由 `syncSuperWaitingState()` 与 superWaiting 同源写入。
   */
  superHeld?: boolean;
  /** `superHeld` 时被压住的自动回合数（汇报 + 被改道消息补投），只算当前主会话。 */
  superPendingCount?: number;
  /**
   * QQ 远程任务看板（Wave2-B）：每条来自 QQ 的任务的投影，宿主维护、webview
   * 只渲染。与 superSessions 同属非 blocks 元数据（搭 blockPatch tail 通道），
   * 并且在会话切换时保留（任务归属面板/工作区，不随转录替换清空）。
   */
  qqTasks: QqTaskUi[];
  /**
   * Next-step candidates predicted by one dedicated model call at the end of
   * a turn (the host runs it directly against the OpenAI-compatible endpoint,
   * outside the agent session). Non-blocks metadata: it rides the blockPatch
   * tail and the webview renders the entries as chips above the composer.
   * Cleared when a new user turn starts or the transcript is swapped, so a
   * stale prediction never survives into another turn/session.
   */
  nextStepSuggestions?: string[];
  /**
   * True while the turn-end prediction is IN FLIGHT (the dedicated model call
   * has started but its candidates have not landed). The composer renders this
   * as a loading pill in the exact slot the chips will occupy, so a slow
   * prediction is visible instead of "nothing happened". Same lifecycle rules
   * as `nextStepSuggestions`: cleared when the call settles, when a new user
   * turn starts, and on a wholesale transcript swap.
   */
  nextStepLoading?: boolean;
  /**
   * 3.6 (2026-10-19): structured next-step guidance attached when the host
   * marks the session errored (shared/error-advice.ts classifies the raw
   * message). The ErrorToast renders `hint` as a guidance line and, when
   * `openSettingsTab` is set, a button that jumps to that settings tab.
   * Cleared whenever the status leaves `error`.
   */
  errorAdvice?: ErrorAdviceUi | null;
}

/**
 * 3.6: next-step guidance for an error state. `kind` lets the UI pick an
 * icon/affordance; `hint` is the localized one-line suggestion (Chinese
 * source string, translated via the webview i18n dictionary);
 * `openSettingsTab` names the settings tab that fixes it, when one does.
 */
export interface ErrorAdviceUi {
  kind: "auth" | "network" | "model" | "cli" | "rateLimit" | "overflow";
  hint: string;
  openSettingsTab?: "api" | "runtime";
}

export interface AuthUiState {
  /** CLI initialized successfully and reported a usable persisted credential. */
  authenticated: boolean;
  /** True once the CLI handshake itself failed (auth form is the remedy). */
  needsSetup: boolean;
  /** Masked info of stored credentials (never the raw key). */
  saved: { baseUrl: string; modelName: string; keyTail: string } | null;
  /** All API profiles, persisted in the kernel's `~/.iflow/settings.json`
   * (`apiProfiles`) and masked for display. */
  profiles: AuthProfileUi[];
  /** The user skipped or finished the first-run wizard (persisted per
   * workspace). Once true the wizard never auto-opens again; the settings
   * modal stays available as the long-term home for everything it covered. */
  onboardingDismissed: boolean;
}

/**
 * Single source of truth for the auth-form rules shared by the webview
 * AuthCard and the host's `validateCredentials` (review B3: the two used to
 * mirror each other's regexes by hand). Returns the first violation as a
 * Chinese source string — the webview translates it through its i18n
 * dictionary, the host shows it verbatim. `apiKey: undefined` skips the key
 * check (the edit-profile flow may leave the field empty; the host falls
 * back to the stored key).
 */
export function validateAuthForm(input: {
  baseUrl: string;
  modelName: string;
  apiKey?: string | null;
}): string | null {
  if (!/^https?:\/\//i.test(input.baseUrl.trim())) {
    return "接口地址要以 http:// 或 https:// 开头";
  }
  if (input.apiKey !== undefined && !(input.apiKey ?? "").trim()) {
    return "请填写 API Key";
  }
  if (!input.modelName.trim()) return "请填写模型名称";
  return null;
}

export interface AuthProfileUi {
  name: string;
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
    skills: [],
    models: [],
    currentModelId: null,
    thinkLevel: "auto",
    pendingApproval: null,
    pendingQuestions: null,
    pendingProfileSwitch: null,
    auth: { authenticated: false, needsSetup: false, saved: null, profiles: [], onboardingDismissed: false },
    sessions: [],
    activeSessionId: null,
    replaying: false,
    initializing: false,
    initializingReason: null,
    newSessionPhase: null,
    compressing: false,
    usage: emptySessionUsage(),
    queue: [],
    queuePaused: false,
    superWaiting: false,
    superHeld: false,
    superPendingCount: 0,
    qqTasks: [],
    checkpoints: [],
    nextStepSuggestions: [],
    nextStepLoading: false,
  };
}

/** Zeroed usage so the token chip renders from the first paint (a session
 * with no content yet shows ↑0 ↓0 rather than hiding the indicator). */
export function emptySessionUsage(): SessionUsageUi {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    prefillTokens: 0,
  };
}

/**
 * Plan mode 已移除（2026-11-18）。
 *
 * CLI 的 `_meta.modes` 仍然会上报 `plan`（vendor bundle 刻意不改），但面板不再
 * 提供该模式。host 每次把 modes 写进 store 都过这里：从 `availableModes` 里
 * 剔掉 plan 项，并把落在 plan 上的 `currentModeId` 归一到可用的非 plan 模式
 * （优先 smart / default，否则列表第一项）。旧会话归档、外部
 * `~/.iflow/settings.json` 的 `approvalMode: "plan"` 因此都不会让已移除的模式
 * 重新出现在模式菜单里。
 *
 * 没有可用的非 plan 模式时原样返回（不伪造模式，交由调用方处理）。
 */
export function withoutPlanModes(modes: SessionModeState | null | undefined): SessionModeState | null {
  if (!modes) return null;
  const isPlanMode = (mode: SessionModeState["availableModes"][number]): boolean =>
    mode.kind === "plan" || (mode.kind === undefined && mode.id === "plan");
  const availableModes = modes.availableModes.filter((mode) => !isPlanMode(mode));
  if (availableModes.length === 0) return modes;
  if (availableModes.some((mode) => mode.id === modes.currentModeId)) {
    return { ...modes, availableModes };
  }
  const preferred =
    availableModes.find((mode) => mode.id === "smart") ??
    availableModes.find((mode) => mode.id === "default");
  return { ...modes, availableModes, currentModeId: (preferred ?? availableModes[0]!).id };
}

/** One fuzzy-search file hit for the @-mention popup (M5). */
export interface FileHitUi {
  path: string;
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

/**
 * Webview-only memory eviction (long-session bloat, 2026-10): release the
 * heavy payload of blocks sitting far outside the render window. The DOM
 * mount window (MessageList TAIL_WINDOW/MAX_WINDOW) already bounds what is
 * RENDERED, but the webview store kept every block's full payload for the
 * whole session — tool outputs (64K chars cap), structured diffs (256KB cap),
 * attached images (≤8MB data URLs) and compression summaries accumulate
 * without bound in the renderer heap as the session grows.
 *
 * Only the WEBVIEW projection is trimmed: the host state stays complete
 * (revert / openDiff / export / transcript persistence all read it), and a
 * full snapshot on restore re-evicts deterministically. Blocks newer than
 * the keep window are never touched (the block cap exceeds the max mount
 * window, so every mounted card of a normal session has its payload).
 *
 * TWO caps on the keep window, whichever binds first (second wave, 2026-10):
 * a block COUNT (`keepRecent`) and a char BUDGET (`budgetChars`) measured by
 * `payloadChars` over the tail. The count cap alone proved useless on the
 * real bloat shape — a probed session had only 249 blocks but 23.4MB of
 * payload (eight 590KB tool diffs at the 256KB cap × old+new), so "keep 200
 * blocks" kept 22.2MB and the eviction was evicting nothing. The budget
 * walks the tail newest-first and stops once the cumulative releasable
 * payload would exceed it; `minKeep` floors the window so a session of only
 * monster blocks still shows its newest turns.
 *
 * Pure and idempotent: already-evicted blocks carry no payload left, so a
 * second pass changes nothing and returns the SAME array/block references —
 * the store can run it after every snapshot/patch without defeating zustand
 * selectors or React memo. `evicted` marks the trimmed blocks so the UI can
 * render an honest "released" marker instead of an empty card.
 */
/** Char budget for the fully-kept tail (≈8MB of UTF-16 string heap). */
export const EVICT_BUDGET_CHARS = 4_000_000;
/** Tail blocks kept regardless of the budget (newest turns always render).
 * Must exceed the webview's mount window (MessageList MAX_WINDOW) so every
 * mounted card keeps its payload; the host applies the same window to child
 * transcripts. */
export const EVICT_KEEP_BLOCKS = 200;
/** Tail blocks kept regardless of the budget (newest turns always render). */
export const EVICT_MIN_KEEP = 20;

/**
 * Releasable payload size of one block in UTF-16 chars — exactly what
 * `evictOneBlock` would free, so the budget walks the same metric it enforces
 * (tool output + both diff texts, thought text, image data URLs, compression
 * summary; recursive over SubAgent entries).
 */
export function payloadChars(block: Block): number {
  switch (block.kind) {
    case "tool":
      return (
        block.output.length +
        (block.diff
          ? (block.diff.oldText?.length ?? 0) + (block.diff.newText?.length ?? 0)
          : 0)
      );
    case "thought":
      return block.text.length;
    case "user":
      return block.images?.reduce((sum, url) => sum + url.length, 0) ?? 0;
    case "compression":
      return block.summary?.length ?? 0;
    case "injected":
      return block.items.reduce((sum, item) => sum + item.content.length, 0);
    case "subagent":
      return block.entries.reduce((sum, entry) => sum + payloadChars(entry), 0);
    default:
      return 0;
  }
}

export function evictBlockPayloads(
  blocks: readonly Block[],
  keepRecent: number,
  budgetChars: number = EVICT_BUDGET_CHARS,
  minKeep: number = EVICT_MIN_KEEP,
): Block[] {
  const maxKeep = Math.max(0, Math.floor(keepRecent));
  const floor = Math.min(blocks.length, Math.max(0, Math.floor(minKeep)));
  let kept = 0;
  let cum = 0;
  while (kept < maxKeep && kept < blocks.length) {
    const size = payloadChars(blocks[blocks.length - 1 - kept]!);
    if (kept >= floor && cum + size > budgetChars) break;
    cum += size;
    kept++;
  }
  const cutoff = blocks.length - kept;
  if (cutoff === 0) return blocks as Block[];
  let changed = false;
  const out = blocks.slice();
  for (let i = 0; i < cutoff; i++) {
    const next = evictOneBlock(blocks[i]!);
    if (next !== blocks[i]) {
      out[i] = next;
      changed = true;
    }
  }
  return changed ? out : (blocks as Block[]);
}

/** One block's payload release; identity-stable when there is nothing to drop. */
function evictOneBlock(block: Block): Block {
  switch (block.kind) {
    case "tool": {
      if (block.output === "" && block.diff === null) return block;
      return { ...block, output: "", truncatedChars: undefined, diff: null, hadDiff: block.hadDiff === true || block.diff !== null, evicted: true };
    }
    case "thought": {
      if (block.text === "") return block;
      return { ...block, text: "", evicted: true };
    }
    case "user": {
      if (!block.images || block.images.length === 0) return block;
      return { ...block, images: undefined, evicted: true };
    }
    case "compression": {
      if (block.summary === null) return block;
      return { ...block, summary: null, evicted: true };
    }
    case "injected": {
      if (block.items.every((item) => item.content === "")) return block;
      return {
        ...block,
        items: block.items.map((item) => ({ ...item, content: "" })),
        evicted: true,
      };
    }
    case "subagent": {
      let entriesChanged = false;
      const entries = block.entries.map((entry) => {
        const next = evictOneBlock(entry);
        if (next !== entry) entriesChanged = true;
        return next;
      });
      if (!entriesChanged) return block;
      return { ...block, entries };
    }
    default:
      return block;
  }
}

/**
 * Host-enriched payload of the `mcpStatus` reply: the CLI report (mcp-status-
 * refactor Mod) minus the availability envelope, with each server's injected-
 * context length appended — `contextTokens` is a BPE estimate
 * (shared/session-state.ts#estimateMcpContextTokens, the same o200k_base
 * tokenizer as the occupancy bar) of the tool declarations this server puts
 * into the model context. The CLI itself never estimates (no such source in
 * the bundle), the host must not re-fetch schemas per render, so the host
 * computes it once per reply.
 *
 * Super Agent 语义:主面板会话带 `disableMcpServers` 启动,CLI 会把每个 server
 * 报成 `{status:"disconnected", blocked:true}`——那是设计性屏蔽,不是服务器
 * 故障。服务器实际由子会话经 host 的共享 MCP broker 使用,所以 `status` 与
 * `childConnected` 以 broker 的 `statuses()` 为权威覆盖:
 *   - `childConnected: true`  → 子会话已连通(即使 `blocked` 仍为 true);
 *   - `childConnected: false` → 子会话连接确实失败(带 `error`);
 *   - `childConnected: undefined` → broker 未就绪 / 无上报,只能退回 `blocked`
 *     展示「主会话未加载」,绝不能读成「服务器坏了」。
 * 详情子页仍消费 CLI 视图的 tools/schema/prompts(被屏蔽时为空),不丢字段。
 */
export interface McpStatusUi {
  discoveryState?: string;
  /** `scope` is host-computed (the CLI's status report carries merged names
   * only): which settings file(s) declare the server, so the card can say
   * whether a row is the global entry, the project entry, or a name the
   * project overrides. `childConnected` is host-computed from the shared MCP
   * broker that Super Agent child sessions use (see the interface doc). */
  servers: Record<
    string,
    McpServerStatusView & {
      contextTokens?: number;
      scope?: McpScope | "both";
      childConnected?: boolean;
    }
  >;
}

/**
 * MCP config scope. The CLI keeps two settings files and merges their
 * `mcpServers` dicts (`{ ...user, ...workspace }`, probed CLI 0.5.19 bundle),
 * so a project entry with the same name OVERRIDES the global one. `global` =
 * `~/.iflow/settings.json` (the CLI's User scope), `project` =
 * `<cwd>/.iflow/settings.json` (the CLI's Workspace scope, written by
 * `iflow mcp add --scope project`).
 */
export type McpScope = "global" | "project";

/**
 * F3 memory manager (Phase 1): the CLI auto-injects global + hierarchical
 * `AGENTS.md` / `IFLOW.md`, but the panel had no way to see or edit them. The
 * host reads the same files (memoryHome() mirrors the loader's hardcoded
 * `os.homedir()/.iflow`) and exposes them as an editable list.
 *
 * `injected` is the honest flag: only files the CLI's memory loader actually
 * reads count (legacy `memory.md` is shown but never injected). A save takes
 * effect on the next session/new or session/load; the current chat keeps its
 * already-assembled system instruction.
 */
export type MemoryScope = "global" | "project";
export type MemoryFileRole = "primary" | "additional" | "hierarchy" | "legacy";

export interface MemoryFactUi {
  /** Stable within one file revision (line + text hash). */
  id: string;
  text: string;
}

export type MemoryCategory = "preference" | "convention" | "decision" | "gotcha" | "other";

/** One auto-extracted fact awaiting user confirmation. Never written until
 * the user selects it in the review dialog. */
export interface MemoryCandidateUi {
  id: string;
  text: string;
  scope: MemoryScope;
  category: MemoryCategory;
  /** 0..1 model-reported confidence; the host drops < 0.6. */
  confidence: number;
}

export interface MemoryFileUi {
  path: string;
  /** `~/.iflow/AGENTS.md` or a workspace-relative path. */
  displayPath: string;
  scope: MemoryScope;
  role: MemoryFileRole;
  exists: boolean;
  editable: boolean;
  injected: boolean;
  bytes: number;
  /** Host-side BPE estimate (shared/session-state.ts#estimateTokens). */
  tokens: number;
  updatedAt: number | null;
  /** sha256 of the content; save requests echo this for conflict detection. */
  hash: string | null;
  /** Parsed `## iFlow Added Memories` entries (global/user memory). */
  facts?: MemoryFactUi[];
}

export interface KnowledgeDocUi {
  path: string;
  /** Workspace-relative display path, e.g. `.iflow/knowledge/index.md`. */
  displayPath: string;
  title: string;
  injected: boolean;
  bytes: number;
  tokens: number;
  updatedAt: number | null;
  hash: string | null;
}

export interface KnowledgeStateUi {
  dir: string;
  index: KnowledgeDocUi | null;
  docs: KnowledgeDocUi[];
  /** Project memory file whose managed block controls the imports. */
  managedBy: string | null;
  /** Sum of tokens for docs currently imported into the memory. */
  injectedTokens: number;
  /** A generation job is running in the host (survives settings re-open). */
  generating?: boolean;
  /** Last manifest summary, when `.iflow/knowledge/manifest.json` is readable. */
  manifest?: {
    generatedAt: string;
    mode: "full" | "incremental";
    sourceCount: number;
    truncated?: boolean;
  };
}

export interface MemoryStateUi {
  /** Hardcoded CLI memory home (`~/.iflow`), independent of IFLOW_HOME. */
  home: string;
  cwd: string | null;
  workspaceRoots: string[];
  files: MemoryFileUi[];
  globalPrimary: string | null;
  projectPrimary: string | null;
  /** F3 Phase 3: generated project knowledge (always workspace-local). */
  knowledge?: KnowledgeStateUi;
  error?: string;
}

/**
 * F4 (2026-10-19): CLI user-level assets — custom slash commands, subagent
 * definitions and skills. Contract probed from the vendor bundle (CLI 0.5.19,
 * readable artifacts in iflow-fork `reverse/`):
 *   - commands: FileCommandLoader globs `** /*.{toml,md}` (recursive) under
 *     `join(Tn(),"commands")` and `join(projectRoot,".iflow","commands")`;
 *     name = relative path minus extension, path segments joined with ":"
 *     (each segment's own ":" replaced by "_"); `.md` = frontmatter
 *     description + body prompt (or first `#` heading as description), `.toml`
 *     = { prompt (required), description }.
 *   - agents: AgentScanner scans TOP-LEVEL `*.md` only under
 *     `join(Tn(),"agents")` / `join(root,".iflow","agents")`; frontmatter
 *     `agent-type`/`name` (required), `description`, `when-to-use`,
 *     `allowed-tools`/`tools` (comma list or `*`), body = system prompt.
 *   - skills: SkillScanner scans `<dir>/SKILL.md` one level deep; frontmatter
 *     `name` (required), `description`, `license`; global wins over project
 *     for the same skill name (Map semantics — a project skill shadowed by a
 *     global one is NOT loaded, we surface it flagged rather than hiding it).
 * Harness injects no IFLOW_HOME, so the global dirs sit under the same
 * hardcoded `os.homedir()/.iflow` as `memoryHome()`.
 */
export type AssetKind = "command" | "agent" | "skill";
export type AssetScope = "global" | "project";

export interface AssetUi {
  kind: AssetKind;
  scope: AssetScope;
  /** Command name (":"-joined path form) / agent file basename / skill dir name. */
  name: string;
  /** The editable file itself (for skills: its SKILL.md, not the directory). */
  path: string;
  displayPath: string;
  /** Parsed best-effort for display only — the CLI's zod validation is authoritative. */
  description: string | null;
  /** Agents only: allowed-tools list (`["*"]` = inherit everything); null = not parsed/absent. */
  tools: string[] | null;
  bytes: number;
  updatedAt: number | null;
  /** sha256 of the content; save requests echo this for conflict detection. */
  hash: string | null;
  editable: boolean;
  /** Skills only: a project skill sharing a global skill's name — the CLI does
   * NOT load it (global wins), the card flags it so the user is not misled. */
  shadowed?: boolean;
}

export interface AssetsStateUi {
  /** Hardcoded CLI asset home (`~/.iflow`), mirrors memoryHome(). */
  home: string;
  /** Session cwd — the project asset roots hang off it (CLI projectRoot). */
  cwd: string | null;
  workspaceRoots: string[];
  commands: AssetUi[];
  agents: AssetUi[];
  skills: AssetUi[];
  error?: string;
}

export type TurnChangeUi = Pick<ToolBlock, "toolCallId" | "title" | "status" | "reverted" | "partiallyReverted"> & {
  /** Grouping/undo identity: location path when available, else diff path. */
  key: string;
  /** Display + open path from the latest recorded diff. */
  path: string;
  additions: number;
  deletions: number;
  /** Number of recorded tool diffs aggregated into this file entry. */
  edits: number;
  /** False when the first recorded diff has no pre-edit text (new/unknown file). */
  canUndo: boolean;
};

/** Panel typography preset, mirrored from `iflow.uiFontSize`. */
export type UiFontSize = "compact" | "standard" | "large";

/** Panel spacing density preset, mirrored from `iflow.uiDensity`. */
export type UiDensity = "compact" | "standard" | "comfortable";

/** Panel color theme, mirrored from `iflow.theme`. "auto" follows the editor. */
export type UiThemeMode = "auto" | "light" | "dark";

/** OS notification preset, mirrored from `iflow.osNotifications`. */
export type UiOsNotifications = "off" | "approvals" | "all";

/** CLI interface language written to ~/.iflow/settings.json; empty leaves it untouched. */
export type UiCliLanguage = "" | "zh-CN" | "en-US";

/** One thinking-capability rule mirrored from `iflow.thinkingModelRules`. */
export interface ThinkingModelRuleUi {
  pattern: string;
  supportsThinking: boolean;
  supportedReasoningLevels?: string[];
  maxThinkingTokens?: number;
}

/** Lifecycle of the 「联网补充模型数据」 web-search fetch (settings panel).
 * `done` carries how many rows were APPENDED to each metadata table (zero
 * across the board means the search found nothing new to add); `error` is the
 * user-visible reason on failure. `idle` = cancelled, lane free again. */
export interface ModelMetadataStateUi {
  state: "idle" | "searching" | "done" | "error";
  added?: { windows: number; costs: number; rules: number };
  error?: string;
}

/** Extension settings mirrored into the settings panel. VSCode configuration
 * is the source of truth; the panel writes user settings
 * (ConfigurationTarget.Global) so VSCode Settings Sync can carry them across
 * machines. API keys stay in SecretStorage and never appear here. */
export interface HostSettingsUi {
  nextStepSuggestions: boolean;
  autoCompressOnIdle: boolean;
  autoMemoryCapture: boolean;
  autoTitle: boolean;
  /** Wall-clock ceiling (seconds) for the turn-end memory extraction.
   * 0 = no limit. */
  memoryExtractTimeoutSeconds: number;
  /** Wall-clock ceiling (seconds) for the next-step prediction.
   * 0 = no limit. */
  nextStepTimeoutSeconds: number;
  /** Wall-clock ceiling (seconds) for a `/compress` turn. 0 = no limit. */
  compressTimeoutSeconds: number;
  /** Context occupancy (%) that triggers the turn-end auto-compress. */
  autoCompressThresholdPercent: number;
  restoreLastSession: boolean;
  autoOpenPanel: boolean;
  warmStart: boolean;
  soundFeedback: boolean;
  osNotifications: UiOsNotifications;
  /** CLI UI language written to ~/.iflow/settings.json (restart required). */
  language: UiCliLanguage;
  theme: UiThemeMode;
  auroraIntensity: number;
  uiFontSize: UiFontSize;
  uiDensity: UiDensity;
  nodePath: string;
  checkpoints: boolean;
  checkpointMaxFiles: number;
  checkpointMaxFileMB: number;
  checkpointDir: string;
  checkpointMaxTurns: number;
  checkpointMaxSizeMB: number;
  contextWindowOverrides: string[];
  costTable: string[];
  thinkingModelRules: ThinkingModelRuleUi[];
  /** Simultaneously running child sessions (`iflow.superAgent.maxConcurrent`).
   * Extra dispatches queue in FIFO order instead of being rejected. */
  superAgentMaxConcurrent: number;
  /** How a finished child session's branch is integrated
   * (`iflow.superAgent.integration`). */
  superAgentIntegration: SuperIntegrationMode;
  /** Max kept worktree directories of finished child sessions
   * (`iflow.superAgent.maxWorktrees`); 0 = unlimited. */
  superAgentMaxWorktrees: number;
  /** Keep the worktree directory after a child session finishes
   * (`iflow.superAgent.keepWorktree`); default false = clean up. */
  superAgentKeepWorktree: boolean;
}

/**
 * QQ 远程任务设置快照（`iflow.qq.*` 的 9 项 + App Secret「已配置」标志）。
 *
 * **绝不携带明文凭据**：`hasAppSecret` 只是「SecretStorage 里有没有扫码写入的
 * App Secret」的布尔投影；凭据只在扫码成功后由宿主单向写入，永不回传、永不进
 * 快照。机器人 Token 已不再手填（历史 `iflow.qq.bot-token` 是死键）。
 *
 * 枚举取值与 `package.json` 的 `iflow.qq.*` 声明逐字一致，也是
 * `shared/qq-task.ts` 的 `QqRemotePolicy` / `QqResultDetail`。
 */
export interface QqSettingsUi {
  enabled: boolean;
  /**
   * 访问控制条目：完整 openid + 可选备注。存储里兼容旧的裸字符串数组
   * （`pickQqSettingsUi` 归一），脱敏只在 webview 渲染时做。
   */
  allowedUsers: QqAllowEntry[];
  allowedGroups: QqAllowEntry[];
  workspace: string;
  remotePolicy: "readonly" | "supervised" | "trusted";
  maxConcurrentTasks: number;
  rateLimitPerMin: number;
  resultDetail: "summary" | "standard" | "full";
  autoMerge: boolean;
  /** App Secret 是否已由扫码写入。只有布尔，没有明文。 */
  hasAppSecret: boolean;
}

/**
 * QQ 设置补丁。
 *
 * 白名单字段放宽到 {@link QqAllowEntryInput}：webview 交回带备注的完整条目，
 * 宿主内部的「只追加一个 openid」写路径（扫码绑定 / 放行待审核）仍然可以传
 * 裸字符串。两种形态都在 `applyQqSettingsPatch` 里归一后落盘。
 */
export type QqSettingsPatch = Partial<Omit<QqSettingsUi, "allowedUsers" | "allowedGroups">> & {
  allowedUsers?: readonly QqAllowEntryInput[];
  allowedGroups?: readonly QqAllowEntryInput[];
};

/**
 * QQ 授权模型（2026-11-17）：待审核用户的一条记录。
 *
 * 语义：白名单（`allowedUsers`）只由「扫码者本人」与「面板里人工放行」写入；
 * 名单外的人发来消息时**不执行任务、不回执**，只把这条记录推到面板由用户
 * 决定放行或拒绝。`openid` 是 QQ 官方接口给的 openid（私聊 author.id /
 * 群聊 member_openid），**不是 QQ 号**——官方 API 不提供 QQ 号。
 *
 * 脱敏只在 UI 侧做：存储与消息都保留原值，否则面板无法据此写回白名单。
 */
export interface QqPendingUserUi {
  openid: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  preview: string;
  chatType: "private" | "group";
  groupId?: string;
}

/**
 * 默认值与裁剪范围 —— **与 src/qq/config.ts 保持同步**（那边是宿主侧权威
 * 归一化：`normalizeQqConfig`）。shared 层不能 import src/，所以这里只复刻
 * 默认值、整数四舍五入 + 闭区间裁剪、字符串 trim、白名单去空白/去重，
 * 非法枚举回退默认；不产出 warnings（告警由宿主侧负责）。
 */
const QQ_SETTINGS_DEFAULTS = {
  enabled: false,
  workspace: "",
  remotePolicy: "supervised",
  maxConcurrentTasks: 2,
  rateLimitPerMin: 6,
  resultDetail: "standard",
  autoMerge: false,
} as const;

/** 数字项允许范围（闭区间，先取整再裁剪）——与 src/qq/config.ts 的 RANGES 一致。 */
const QQ_SETTINGS_RANGES = {
  maxConcurrentTasks: { min: 1, max: 10 },
  rateLimitPerMin: { min: 1, max: 60 },
} as const;

/** 枚举取值（与 package.json 的 iflow.qq.* enum 一致）。 */
const QQ_REMOTE_POLICIES = ["readonly", "supervised", "trusted"] as const;
const QQ_RESULT_DETAILS = ["summary", "standard", "full"] as const;

function qqReadString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function qqReadBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function qqReadEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return (allowed as readonly string[]).includes(trimmed) ? (trimmed as T) : fallback;
}

function qqReadInteger(
  value: unknown,
  range: { readonly min: number; readonly max: number },
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

/**
 * 把任意设置快照归一成 {@link QqSettingsUi}。
 *
 * 纯函数（零依赖、无副作用）：宿主读 settings.json / VSCode 配置后交给它，
 * webview 的 demo 快照也用它兜底。**默认值与 clamp 范围与 src/qq/config.ts
 * 保持同步**；枚举非法回退默认值，数字取整后裁剪，字符串 trim，白名单去
 * 空白/去重。
 *
 * 凭据只以 `hasAppSecret` 布尔透传（来自 `secrets`），输入里即便混进
 * `botToken` / `appSecret` 明文也**不会**进入返回值。
 */
export function pickQqSettingsUi(
  raw: Record<string, unknown>,
  secrets: { hasAppSecret: boolean },
): QqSettingsUi {
  const source: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    enabled: qqReadBoolean(source.enabled, QQ_SETTINGS_DEFAULTS.enabled),
    allowedUsers: normalizeQqAllowEntries(source.allowedUsers),
    allowedGroups: normalizeQqAllowEntries(source.allowedGroups),
    workspace: qqReadString(source.workspace, QQ_SETTINGS_DEFAULTS.workspace),
    remotePolicy: qqReadEnum(
      source.remotePolicy,
      QQ_REMOTE_POLICIES,
      QQ_SETTINGS_DEFAULTS.remotePolicy,
    ),
    maxConcurrentTasks: qqReadInteger(
      source.maxConcurrentTasks,
      QQ_SETTINGS_RANGES.maxConcurrentTasks,
      QQ_SETTINGS_DEFAULTS.maxConcurrentTasks,
    ),
    rateLimitPerMin: qqReadInteger(
      source.rateLimitPerMin,
      QQ_SETTINGS_RANGES.rateLimitPerMin,
      QQ_SETTINGS_DEFAULTS.rateLimitPerMin,
    ),
    resultDetail: qqReadEnum(
      source.resultDetail,
      QQ_RESULT_DETAILS,
      QQ_SETTINGS_DEFAULTS.resultDetail,
    ),
    autoMerge: qqReadBoolean(source.autoMerge, QQ_SETTINGS_DEFAULTS.autoMerge),
    hasAppSecret: secrets.hasAppSecret === true,
  };
}

export type HostToWebview =
  | { type: "turnChanges"; sessionId: string; userBlockId: string; requestId: string; records: TurnChangeUi[]; unavailable: boolean }
  /** A single file's turn changes were reverted; refetch the turn records. */
  | { type: "turnFileReverted"; sessionId: string; userBlockId: string; key: string }
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
  /**
   * Super Agent — one child session's live transcript.
   *
   * A child session runs in its OWN CLI process, so its transcript never
   * enters the main `blocks` (that would pollute the main transcript and
   * break the blockPatch anchor). This message carries it on a separate
   * channel instead: blocks from index `from` to the end are re-sent, so the
   * webview keeps merging incrementally. `from === 0` means full replacement
   * (first open / resync / request).
   */
  | { type: "superTranscript"; sessionId: string; from: number; blocks: Block[] }
  /**
   * 新建会话时检测到跨历史会话的 Super Agent 残留 → 宿主请求 webview 弹出
   * 一个阻断式二次确认框（「清空并新建」/「取消」）。
   *
   * 所有给用户看的字符串都由宿主用 `vscode.l10n.t` 组装好随消息下发，webview
   * 只负责渲染，不需要新增 i18n key —— 与另一条正在改 i18n.ts 的线解耦。
   * `message` 已经醒目警示「包含未合并 worktree 在内的全部残留会被永久清空、
   * 未提交/未合并工作不可恢复」，webview 不得改写或弱化它。
   */
  | {
      type: "superResidueConfirm";
      requestId: string;
      title: string;
      message: string;
      confirmLabel: string;
      cancelLabel: string;
    }
  | {
      type: "toast";
      level: "info" | "warning" | "error";
      message: string;
      durationMs?: number;
      countdownDeadline?: number;
      displayOnly?: boolean;
      /** Host-assigned id; echoed back in `dismissToast` to remove this pill. */
      toastId?: number;
      /** Host owns the pill's lifetime (e.g. the auto-compress notice): the
       * webview never auto-dismisses it — only a matching `dismissToast` does. */
      persistent?: boolean;
      /** Keep the pill until the user closes it or the host dismisses it.
       * Unlike `persistent`, the webview renders a close control and lets the
       * user dismiss it locally (auto-memory candidate notices). */
      sticky?: boolean;
      /** Optional inline action button (M1 P0-6: "立即压缩" on the
       * context-warning pill). Clicking it sends `toastAction` with this id;
       * the host performs the action and owns pill removal (persistent
       * semantics unchanged — a non-persistent action pill still
       * auto-dismisses). */
      action?: { actionId: string; label: string };
      /** Preview lines for a decision-card notice (auto-memory candidates): the
       * card shows WHAT would be written before the review dialog opens. The
       * host caps the list; absence keeps the plain pill rendering. */
      preview?: { text: string; scope: MemoryScope }[];
    }
  | { type: "dismissToast"; toastId: number }
  /** Reply to `searchFiles` (matched by requestId, newest wins in the UI). */
  | { type: "fileList"; requestId: number; hits: FileHitUi[] }
  /** Reply to `stageFiles`: absolute temp paths aligned with the request's
   * `files` array (`null` = that file failed to stage). The webview inserts
   * the paths into the composer so the agent can read them with its tools. */
  | { type: "stagedFiles"; requestId: number; paths: Array<string | null> }
  /** Reply to `pickAttachments`: `images` are base64 attachment payloads,
   * `files` carry real disk paths (no staging needed). */
  | { type: "filesPicked"; images: { name: string; data: string; mimeType: string }[]; files: { name: string; path: string }[] }
  /** Reply to `listMcpServers` / `saveMcpServers`: BOTH scopes' MCP server
   * dicts (name → config) as they stand on disk after the operation, so the
   * card can switch scope locally without another round trip. `error`
   * non-empty means the read/write failed (the dicts are then the last-known
   * or best-effort values, not a confirmed save).
   *
   * Wire behavior (probed, CLI 0.5.19 bundle): the settings manager loads the
   * User file (`~/.iflow/settings.json`) and the Workspace file
   * (`<cwd>/.iflow/settings.json`) and merges
   * `mcpServers: { ...user, ...workspace }` — a project entry with the same
   * name OVERRIDES the global one (the opposite of skills, where global wins).
   * `project` is null when there is no project context (no session cwd), and
   * the CLI also skips the workspace file when cwd resolves to the home dir. */
  | {
      type: "mcpServers";
      global: Record<string, unknown>;
      /** null = no project context (the scope tab is then disabled). */
      project: Record<string, unknown> | null;
      error?: string;
    }
  /** Reply to `mcpStatus`: the live per-server connection view (state light,
   * tool/prompt declarations, connection error, + host-computed contextTokens).
   * `status` null = no channel — CLI not connected, the mcp-status Mod missing/
   * disabled, or the query failed; the card then shows NO indicator rather than
   * guessing. Deliberately a separate channel from `mcpServers` (config truth):
   * a status refresh never touches the card's edit/save guards. */
  | { type: "mcpStatus"; status: McpStatusUi | null }
  /** Reply to `listAssets`: CLI user-level asset files (custom commands,
   * subagent definitions, skills) as they stand on disk under the six asset
   * roots (global `~/.iflow/{commands,agents,skills}` + project
   * `<cwd>/.iflow/{...}`). Always re-read on open — the CLI and the agent's
   * own tools write these files behind our back. */
  | {
      type: "assetsState";
      requestId?: number;
      state: AssetsStateUi;
    }
  /** Reply to `readAsset`: full body + hash for the inline editor. */
  | { type: "assetContent"; path: string; content: string; hash: string | null; error?: string; requestId?: number }
  /** Reply to `saveAsset` / `createAsset`: `conflict` means the file changed
   * on disk since the card read it (or, for create, already exists) — the
   * write did NOT happen and the caller must reload. `requestId` echoes the
   * request so a concurrent write's ack cannot be mistaken for ours. */
  | { type: "assetSaved"; path: string; ok: boolean; conflict?: boolean; error?: string; requestId?: number }
  /** Reply to `deleteAsset`. Skills delete their SKILL.md (plus the skill
   * directory when it ends up empty). */
  | { type: "assetDeleted"; path: string; ok: boolean; error?: string; requestId?: number }
  /** Reply to `generateAsset`: the drafted file body (frontmatter + markdown,
   * code fences stripped and the kind's required frontmatter keys guaranteed
   * by shared/asset-gen.ts#normalizeGeneratedAsset), or `error` when the
   * gateway call failed / another generation is already in flight. This is a
   * DRAFT for the editor — nothing was written to disk. */
  | { type: "assetGenerated"; requestId: number; content: string; error?: string }
  /** Reply to `listMemory`: global + project memory files with token/hash
   * metadata. The memory card always opens on disk truth (the CLI and the
   * agent's save_memory tool write the same files behind our back). */
  | { type: "memoryState"; requestId?: number; state: MemoryStateUi }
  /** Reply to a memory write: `conflict` means the file changed on disk since
   * the card read it — the write did NOT happen and the caller must reload. */
  | { type: "memorySaved"; path: string; ok: boolean; conflict?: boolean; file?: MemoryFileUi; error?: string; requestId?: number }
  /** Reply to `readMemoryFile`: full body + hash for the inline editor. */
  | { type: "memoryFileContent"; path: string; content: string; hash: string | null; error?: string }
  /** Auto-extraction produced candidates and the user asked to review them
   * (toast action). Nothing has been written yet. */
  | { type: "memoryCandidates"; sessionId: string | null; candidates: MemoryCandidateUi[] }
  /** Project-knowledge generation progress (fast path, no agent tools). */
  | {
      type: "knowledgeJob";
      jobId: string;
      stage: "scanning" | "summarizing" | "writing" | "done" | "error";
      message?: string;
    }
  /** Reply to `deleteProfile`: the row clears its pending chip on receipt.
   * `ok:false` means the profile is still present (the host also toasts). */
  | { type: "profileDeleteResult"; name: string; ok: boolean }
  /** Editor color theme changed ("dark" | "light"); the webview follows it
   * unless the user picked a theme manually in the panel. `auroraIntensity`
   * (0–100) mirrors the `iflow.auroraIntensity` setting — the webview scales
   * the background aurora light-spot opacity with it. */
  | { type: "theme"; kind: "dark" | "light"; auroraIntensity?: number }
  | ({ type: "hostSettings" } & HostSettingsUi)
  /** Turn finished ("done") / failed ("error") / one child session settled
   * ("child") — the webview plays a short synthesized cue. The three are
   * deliberately distinct sounds: a child finishing is NOT the main turn
   * finishing, so it gets a lighter single note. Host gates on the
   * `iflow.soundFeedback` setting; the webview only synthesizes on receipt. */
  | { type: "playSound"; kind: "done" | "error" | "child" }
  /** Reply to `enhancePrompt` (M1 P1-5): the host ran one internal prompt
   * (never recorded in the transcript) and returns the enhanced text so the
   * composer can fill it back in. `requestId` matches the request; `error`
   * non-empty means the enhancement failed (the composer keeps the original
   * text). */
  | { type: "enhancedPrompt"; requestId: number; text: string; error?: string }
  /** Reply to `queueAction: edit` (M2 P0-3): the entry's full payload is
   * handed back to the composer (the queue entry is removed host-side).
   * `error` non-empty means the id was already gone (consumed / cleared). */
  | { type: "queueEdited"; requestId: number; text: string; images?: { data: string; mimeType: string }[]; files?: { name: string; path: string }[]; contexts?: ContextRefUi[]; error?: string }
  /** Reply to {@link WebviewToHost resolveContext} (M2 P0-4): the host read
   * the source and returns the (truncated) card body. `error` non-empty
   * means resolution failed (the composer shows the reason as a note). */
  | { type: "contextResolved"; requestId: number; kind: ContextKind; label: string; detail: string; content: string; error?: string }
  /** Lifecycle of the settings-panel 「联网补充模型数据」 fetch: the host runs
   * one throwaway agent turn (web_search only) and reports searching / done /
   * error / idle (cancelled). On `done` the appended rows are already written
   * to the settings, so the following `hostSettings` refresh carries them. */
  | ({ type: "modelMetadataState" } & ModelMetadataStateUi)
  /**
   * QQ 授权模型：待审核用户列表（每次变更全量重发，顺序按 lastSeenAt 倒序）。
   * 白名单外的人发来消息只会落到这里，不会执行任务、不会收到回执。
   */
  | { type: "qqPendingUsers"; users: QqPendingUserUi[] }
  /** QQ 远程任务（Wave3-B）：设置页的配置快照。明文凭据绝不在这条消息里，
   * 只用 `hasAppSecret` 表达扫码写入的 App Secret 是否已配置。 */
  | { type: "qqSettings"; values: QqSettingsUi }
  /** QQ 远程任务（Wave3-B）：bridge / 适配器的连接状态；`detail` 是给人看的
   * 补充说明（例如端点地址或失败原因）。 */
  | { type: "qqStatus"; connected: boolean; detail?: string }
  /**
   * 扫码登录（Wave5-C0）：宿主从 QQ 官方扫码接口取二维码 →
   * base64 data URL → webview 用 `<img>` 显示，避免 CSP 禁止的 iframe。
   * `dataUrl` 必须是 `data:image/png;base64,...`（webview 可用
   * `isQrDataUrl` 护栏校验）；`expiresAt` 是二维码过期时间（epoch ms）；
   * `phase` 是扫码生命周期；`detail` 是给人看的补充说明（例如失败原因）。
   */
  | {
      type: "qqLoginQr";
      dataUrl: string;
      expiresAt: number;
      phase: "waiting_scan" | "scanned" | "confirmed" | "expired";
      detail?: string;
    }
  /**
   * 一键托管（Wave5-C0）：宿主把 QQBot 接入（准备环境 / 配置 / 启动 / 等待授权）
   * 的各阶段进度推给设置页。`phase` 是阶段机；`message` 是给人看的说明；
   * `progress`（0–100）仅下载等可度量阶段携带，缺省表示不确定进度。
   */
  | {
      type: "qqManagedStatus";
      phase: "idle" | "checking" | "downloading" | "configuring" | "starting" | "waiting_login" | "logged_in" | "error";
      message: string;
      progress?: number;
    };

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
      /** M2 P0-4: context cards (right-click selection, @folder/@problems/
       * @git/@url) — the host assembles each into a titled fenced section
       * ahead of the typed text. Replaces the old single `codeContext`. */
      contexts?: ContextRefUi[];
    }
  /**
   * M2 P0-3 — operate on the host-owned prompt queue. `edit` pops the entry
   * back into the composer (the host replies via `queueEdited`), `delete`
   * drops it, `move` swaps it with its neighbour (`delta` = -1 up / +1 down),
   * `sendNow` cancels the in-flight turn and dispatches THIS entry first,
   * `resume` clears the error-pause, `clear` empties the queue.
   */
  | { type: "queueAction"; action: "edit" | "delete" | "move" | "sendNow" | "resume" | "clear"; id?: string; delta?: number; requestId?: number }
  /**
   * M2 P0-4 — resolve a context source into a card body. `query` is the
   * folder rel-path / URL / empty (problems & git are workspace-wide).
   * Reply: `contextResolved` matched by requestId.
   */
  | { type: "resolveContext"; requestId: number; kind: ContextKind; query: string }
  | { type: "regenerate" }
  /** Delete one user message AND everything after it (truncate the
   * transcript at that block). Host-owned: the transcript lives in the
   * Extension Host, the webview only names the block by its stable id (P4).
   * The host additionally truncates the CLI's own conversation history
   * (`~/.iflow/acp/sessions/<sessionId>.json` + `session/load` reload) so the
   * model genuinely stops seeing the deleted turn — when that sync is
   * impossible (history compressed away / text unlocatable) the host says so
   * via a toast instead of silently pretending. */
  | { type: "deleteUserMessage"; blockId: string }
  /**
   * M4 P1-9 — edit a historical user message and re-send it (Cline semantics).
   * The host truncates the turn and everything after it (the full
   * deleteUserMessage chain: transcript + CLI chatHistory + reload), then
   * sends `text` as a fresh prompt. When the turn carries a complete
   * checkpoint, its file snapshot is restored FIRST (same unsaved-editor /
   * modal confirmations as restoreCheckpoint "files") so the re-run starts
   * from the pre-turn workspace; without a checkpoint the host degrades to a
   * pure truncate-and-resend and says so via a toast.
   */
  | { type: "editAndResend"; blockId: string; text: string }
  | { type: "cancel" }
  /** CLI 0.5.19 only supports whole-turn cancellation. */
  | { type: "stopSubagent"; sessionId: string; agentId: string }
  /**
   * Super Agent — operate on a child session of the main session.
   *
   * Child sessions are created ONLY by the agent's own delegation protocol
   * (a `super-agent` fenced block in its reply — the host dispatches it), so
   * this message carries management actions only; there is no manual create
   * path.
   *  - `cancel` / `cancelAll`: interrupt one or every child session.
   *  - `respond`: answer an ask_user_question raised BY a child session.
   *    Approvals are NOT part of this loop — child sessions always run in
   *    no-confirmation mode, so the host allows their tool calls itself.
   *  - `cleanup`: drop the child session and its worktree; `keepBranch`
   *    preserves the git branch (the default keeps it when the branch still
   *    carries unmerged commits).
   *  - `cleanupBatch`: the same cleanup for several children in one request
   *    (`sessionIds`). The host runs them serially and reports ONE aggregate
   *    receipt toast instead of one per child — a bulk action should not
   *    bury the transcript under N identical toasts. A single `cleanup`
   *    keeps its own per-action receipt.
   *  - `merge`: ask the MAIN AGENT to merge the child's branch back into the
   *    current branch — the agent runs the git command itself and resolves
   *    conflicts. The host only verifies (`git merge-base --is-ancestor`)
   *    that the branch landed and records the integration; it never runs a
   *    mechanical `git merge` on the user's working copy. Completed children
   *    are otherwise merged automatically according to
   *    `iflow.superAgent.integration`.
   *  - `transcript`: fetch a child's live transcript on demand (the board's
   *    read-only panel opens, or its local cache is shorter than the host's).
   *    It never touches the main transcript.
   *  - `retry`: re-run a child that was interrupted (`failed` / `cancelled`).
   *    The host reuses the same record and working directory so any
   *    uncommitted work left by the interrupted run stays visible; the new
   *    child is told it is a retry and to inspect the current state first.
   */
  | {
      type: "superAgent";
      action:
        | "cancel"
        | "cancelAll"
        | "respond"
        | "cleanup"
        | "cleanupBatch"
        | "merge"
        | "transcript"
        | "retry";
      /** Target child session (absent for cancelAll / cleanupBatch). */
      sessionId?: string;
      /** cleanupBatch: the children to clean up in one serial batch. */
      sessionIds?: string[];
      /** respond: the answers map (ask_user_question), keyed by header. */
      answers?: Record<string, string | string[]>;
      /** cleanup / cleanupBatch: keep the git branch. */
      keepBranch?: boolean;
    }
  | { type: "newSession" }
  | { type: "setModel"; modelId: string }
  | { type: "setThink"; level: ThinkLevel }
  /** Open a file location in the editor; `toolCallId` (when the chip belongs
   * to a tool card with a diff) lets the host resolve a bare-basename wire
   * path via the same multi-candidate lookup as revert/openDiff (pitfall #6). */
  | { type: "openLocation"; path: string; line?: number | null; toolCallId?: string }
  | { type: "openExternal"; uri: string }
  /** Answer a pending approval; `optionId: null` cancels the request. */
  | { type: "respondApproval"; id: string; optionId: string | null }
  /** Answer the pending ask_user_question card; `answers` is keyed by
   * question `header`. An empty answers object = dismissed (the agent
   * proceeds with "no answer"). */
  | { type: "answerQuestions"; id: string; answers: Record<string, string | string[]> }
/** Answer the profile-switch choice dialog; `keepSession: null` cancels the
 * entire switch (dialog dismissed / 取消 — no credential or reconnect side
 * effects, the active profile pointer stays where it was). */
| { type: "respondProfileSwitch"; id: string; keepSession: boolean | null }
/** 回答 `superResidueConfirm`：`confirmed=true` = 先全量清空再新建；false = 只新建不清空。 */
| { type: "respondSuperResidueConfirm"; requestId: string; confirmed: boolean }
  /** Revert a completed tool call that carried a structured diff. */
  | { type: "revertTool"; toolCallId: string }
  /**
   * M4 P0-2 — commit per-hunk keep/revert decisions for a tool diff.
   * `keep` is the index-aligned bitmap over `computeHunks(oldText, newText)`
   * (true = keep the change, false = revert that hunk). The host replays the
   * kept hunks deterministically and writes the result — refusing outright
   * when the file drifted from the diff's newText (no fuzzy patching).
   */
  | { type: "applyHunkSelection"; toolCallId: string; keep: boolean[] }
  /**
   * M3 P0-1 — restore the workspace / conversation to a turn checkpoint.
   * `mode`: "files" = shadow-git checkout of that turn's snapshot (with the
   * same unsaved-editor / disk-drift confirmations as revertTool);
   * "conversation" = truncate the transcript at that user message (reuses the
   * deleteUserMessage chain incl. the CLI chatHistory truncation);
   * "both" = files first, then conversation.
   */
  | { type: "restoreCheckpoint"; userBlockId: string; mode: "files" | "conversation" | "both" }
  /** M5: open the tool's change in VSCode's native diff editor. */
  | { type: "openDiff"; toolCallId: string; sessionId?: string }
  /** Tool-card "在终端中打开/重跑": re-run the tool's shell command in a real
   * integrated terminal. `execute: false` prefills the command without a
   * trailing newline (the user presses Enter); `true` runs it immediately.
   * The host re-extracts the command from its own tool-block state and
   * refuses truncated/absent commands with a toast. */
  | { type: "runInTerminal"; toolCallId: string; execute: boolean }
  | { type: "requestTurnChanges"; sessionId: string; userBlockId: string; requestId: string }
  /** Undo every recorded diff for one file in the latest completed turn. */
  | { type: "revertTurnFile"; sessionId: string; userBlockId: string; key: string }
  /** M5: fuzzy-search workspace files for the @-mention popup. M2 P0-4:
   * `kind: "folder"` searches directories instead (the popup shows folder
   * paths; selecting one attaches a @folder context card). */
  | { type: "searchFiles"; requestId: number; query: string; kind?: "file" | "folder" }
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
  /** M3: store openai-compatible credentials and authenticate a fresh session.
   * `replaceName` is the name the edited profile had BEFORE this save (absent
   * for a new profile): the host deletes that stale key when the profile was
   * renamed, so editing never leaves a duplicate row behind. */
  | {
      type: "saveAuth";
      baseUrl: string;
      apiKey: string | null;
      modelName: string;
      profileName?: string | null;
      replaceName?: string | null;
    }
  /** M3: forget stored credentials (CLI keeps its own). */
  | { type: "clearAuth" }
  /** M3: switch the active API profile and re-authenticate. */
  | { type: "activateProfile"; name: string }
  /** M3: delete a profile (kernel settings.json + SecretStorage cache). */
  | { type: "deleteProfile"; name: string }
  /** First-run wizard finished or skipped. Persisted in workspaceState so the
   * wizard never auto-opens again in this workspace. */
  | { type: "setOnboardingDismissed"; dismissed: boolean }
  /** M4: load a persisted session by id (history replays into the transcript). */
  | { type: "loadSession"; sessionId: string }
  /** M4: forget a persisted session (switcher entry + transcript). */
  | { type: "deleteSession"; sessionId: string }
  /** M4 P1-8: toggle a session's pinned / archived flags (persisted with the
   * session index; the switcher renders archived ones in a second section). */
  | { type: "setSessionFlags"; sessionId: string; pinned: boolean; archived: boolean }
  /** Rename a session's switcher label (persisted with the index and the
   * extension transcript, so a later restore keeps the user's title). */
  | { type: "renameSession"; sessionId: string; label: string }
  /** Re-read the API profile list (SecretStorage + CLI settings.json) when the
   * profile dropdown / auth card opens — external tools rewrite settings.json
   * behind our back, so the shown list must be recomputed on open. */
  | { type: "refreshAuth" }
  /** Re-query `GET {baseUrl}/models` when the model dropdown opens — the list
   * captured at session start goes stale (new gateway models appear). */
  | { type: "refreshModels" }
  /** Settings-page hot restart: tear the CLI child down and spawn a fresh
   * one so startup-only changes (language / mcpServers written
   * to settings.json) take effect without reloading VSCode. */
  | { type: "restartCli" }
  /** Open the VSCode Settings UI filtered to the iFlow extension section. */
  | { type: "openSettings" }
  /** Update mirrored extension settings from the settings panel. The host
   * validates each field, writes VSCode user settings (ConfigurationTarget
   * .Global — the scope Settings Sync carries), and echoes `hostSettings`
   * with the effective values. Partial: omitted fields stay untouched. */
  | ({ type: "setHostSettings" } & Partial<HostSettingsUi>)
  /** MCP management card opened: read the CURRENT `mcpServers` dicts from BOTH
   * settings files (`~/.iflow/settings.json` and `<cwd>/.iflow/settings.json`)
   * — the CLI / external tools own those files, so the card must show disk
   * truth, not a cached copy. Reply: `mcpServers`. */
  | { type: "listMcpServers" }
  /** Save one scope's full MCP server dict (replace semantics — the card edits
   * a fresh copy read via `listMcpServers`, so a concurrent external write is
   * at worst lost, never silently merged). The host writes that scope's
   * settings.json (creating the project file when absent) and offers a hot
   * restart. Reply: `mcpServers` with `error` on failure. */
  | { type: "saveMcpServers"; scope: McpScope; servers: Record<string, unknown> }
  /** Ask the CLI for the live per-server MCP connection state (state light,
   * declarations, error) — `_iflow/mcp/status` via the mcp-status-refactor Mod.
   * Reply: `mcpStatus` (null when the CLI is not running or the Mod is
   * missing/disabled). */
  | { type: "mcpStatus" }
  /** Settings-panel 「联网补充模型数据」: run one throwaway agent turn that
   * web-searches the newest model data plus this profile's live `/models`
   * list, then APPEND validated rows to the three metadata tables. Reply:
   * `modelMetadataState` (searching → done/error; busy lane refuses a second
   * concurrent fetch). */
  | { type: "fetchModelMetadata" }
  /** Abort the in-flight metadata fetch (its agent turn is cancelled, nothing
   * is written). Reply: `modelMetadataState` with state `idle`. */
  | { type: "cancelModelMetadata" }
  /** Memory card opened / refreshed: read the current global and project
   * `AGENTS.md` / `IFLOW.md` from disk. Reply: `memoryState`. */
  | { type: "listMemory"; requestId?: number }
  /** Load one memory file's full body for the inline editor. Reply:
   * `memoryFileContent`. */
  | { type: "readMemoryFile"; path: string }
  /** Save one memory file. `expectedHash` is the sha256 from the last
   * `memoryState`; a mismatch returns `memorySaved` with `conflict: true`
   * and never overwrites. */
  | { type: "saveMemoryFile"; path: string; content: string; expectedHash?: string | null }
  /** Append one fact under `## iFlow Added Memories` (same format as the
   * CLI's save_memory tool). `path` overrides the scope's primary file. */
  | { type: "appendMemoryFact"; scope: MemoryScope; fact: string; path?: string; requestId?: number }
  /** Remove parsed facts by id (global factual list). */
  | { type: "deleteMemoryFacts"; path: string; factIds: string[] }
  /** Create the missing project memory file at the session cwd. */
  | { type: "createProjectMemory"; fileName: "AGENTS.md" | "IFLOW.md" }
  /** Write the selected auto-extracted candidates (review dialog). `sessionId`
   * guards against applying a stale review after a session switch. */
  | { type: "applyMemoryCandidates"; sessionId: string | null; candidates: MemoryCandidateUi[] }
  /** Drop pending candidates without writing. */
  | { type: "dismissMemoryCandidates"; sessionId: string | null }
  /** Generate/refresh the project knowledge index. `jobId` correlates the
   * `knowledgeJob` stage updates so a stale job cannot unlock the UI.
   * `mode: "incremental"` (default) reuses the previous index + source diff
   * and falls back to a full rebuild when no valid base exists; `"full"`
   * always re-analyzes the workspace. */
  | { type: "generateKnowledge"; jobId: string; mode?: "incremental" | "full" }
  /** Toggle one knowledge doc's `@` import in the managed block of the
   * project memory file (no injection when false). */
  | { type: "setKnowledgeInjection"; path: string; injected: boolean }
  /** F4: asset card opened / refreshed — re-scan the six CLI asset roots.
   * Reply: `assetsState`. */
  | { type: "listAssets"; requestId?: number }
  /** Load one asset file's full body for the inline editor. Reply:
   * `assetContent`. */
  | { type: "readAsset"; path: string; requestId?: number }
  /** Save one asset file (commands/agents `.md`, skills `SKILL.md`). `expectedHash`
   * is the sha256 from the last `assetsState`; mismatch returns `assetSaved`
   * with `conflict: true` and never overwrites. */
  | { type: "saveAsset"; path: string; content: string; expectedHash?: string | null; requestId?: number }
  /** Create a missing asset file. The host builds the path from kind/scope/name
   * (never trusts a client-supplied new path); an existing target returns
   * `assetSaved` with `conflict: true`. Reply: `assetSaved`. */
  | { type: "createAsset"; kind: AssetKind; scope: AssetScope; name: string; content: string; requestId?: number }
  /** F4: ask the model to draft one asset file from a free-text requirement.
   * Runs as a direct gateway completion on its own busy lane (never an agent
   * session — pitfall #26), and only fills the editor: NOTHING is written to
   * disk until the user reviews the draft and clicks 创建. Reply:
   * `assetGenerated`. */
  | { type: "generateAsset"; kind: AssetKind; name: string; requirement: string; requestId: number }
  /** Delete one asset file (skills: its SKILL.md + the skill directory when
   * it ends up empty). Reply: `assetDeleted`. */
  | { type: "deleteAsset"; path: string; requestId?: number }
  /** Open a knowledge doc in the editor. */
  | { type: "openKnowledgeFile"; path: string }
  /** Open a discovered memory file in the editor. */
  | { type: "openMemoryFile"; path: string }
  /** M1 P0-7: export the ACTIVE session's transcript. `format` picks the
   * serializer; the host shows a native save dialog and writes the file
   * (Markdown renders every block type, JSON copies the transcript file). */
  | { type: "exportSession"; format: "markdown" | "json" }
  /** M1 P1-5: ask the host to enhance the composer draft with one internal
   * prompt (never enters the transcript / queue and does not participate in
   * regenerate). Reply: `enhancedPrompt` matched by `requestId`. */
  | { type: "enhancePrompt"; requestId: number; text: string }
  /** Cancel an in-flight `enhancePrompt` (re-clicking the wand, submitting,
   * or switching sessions while an enhancement is pending). The host aborts
   * the gateway stream and sends NO reply — the composer resets its own
   * pending state locally, so a late result has nothing to fill into. */
  | { type: "cancelEnhance"; requestId: number }
  /** M1 P0-6: a toast's inline action button was clicked (see the `toast`
   * message's `action`). The host dispatches on `actionId` (e.g. "compress"
   * drives the /compress bridge) and dismisses the pill. */
  | { type: "toastAction"; actionId: string; toastId?: number }
  /** The user ticked/unticked one item of a TaskList card (`PlanBlock`).
   * `blockId` is the stable block id (P4), `index` the entry position; the
   * host flips pending↔completed via `setPlanEntryStatus` and drops stale
   * clicks silently. */
  | { type: "togglePlanItem"; blockId: string; index: number }
  /** 3.5 ②: "查看完整输出" on a truncated tool card — the host writes the
   * block's FULL stored output (up to the 512K store cap) to a temp file
   * and opens it in the editor. `blockId` is the stable block id (P4). */
  | { type: "exportToolOutput"; blockId: string }
  /**
   * QQ 远程任务（Wave2-B）：看板/通知对单条任务的操作。`taskId` 是宿主分配的
   * 任务 id；`text` 只在 `answer` 时携带（用户对提问的自由文本作答）。
   * 本波只声明协议，webview 处理逻辑与宿主执行属后续波次。
   */
  | {
      type: "qqTaskAction";
      taskId: string;
      action: "stop" | "approve" | "deny" | "answer" | "merge" | "discard" | "refresh";
      text?: string;
    }
  /** QQ 远程任务（Wave3-C 补声明 / Wave2-B 方向修正）：设置页 QQ 卡片的动作——
   * 连测试、解绑，以及扫码登录（Wave5-C0）的开始取码、刷新二维码、取消登录。
   * 这是 webview 发给宿主的**请求**（早期误声明在 HostToWebview 上，方向写反，
   * panel 只能用运行时形状守卫兜底接收；现已从 HostToWebview 移除、只在此处
   * 声明）。回执不是同名消息：状态走 `qqStatus`、二维码走 `qqLoginQr`，解绑
   * 结果走 toast。配对码机制（`generateBindCode`）已随授权模型改造移除。 */
  | {
      type: "qqConfigAction";
      action: "testConnection" | "unbind" | "startQrLogin" | "refreshQr" | "cancelQrLogin";
    }
  /**
   * QQ 授权模型：面板对某个待审核用户的处置。`approve` 会把他写进
   * `iflow.qq.allowedUsers`（去重追加）并移出待审核；`reject` 只移出并记入
   * 拒绝集合（同一 openid 不会再冒出来）。openid 是官方接口标识，非 QQ 号。
   */
  | { type: "qqUserAction"; openid: string; action: "approve" | "reject" }
  /** QQ 远程任务（Wave3-B）：设置页把用户改动交回宿主（局部补丁语义）。
   * `hasAppSecret` 是宿主回传的投影，这里只会被忽略——凭据只在扫码成功后
   * 由宿主写入 SecretStorage，不走设置补丁。 */
  | { type: "qqSettingsPatch"; patch: QqSettingsPatch }
  /**
   * 一键托管（Wave5-C0）：设置页请求宿主开始接入 / 停止 QQBot 托管。
   * `start` 触发准备→配置→启动→等待扫码授权流程，`stop` 停止并清理。
   * 进度经 `qqManagedStatus` 回推，登录二维码经 `qqLoginQr` 回推。
   */
  | { type: "qqManagedSetup"; action: "start" | "stop" };

// ---------------------------------------------------------------------------
// QQ 扫码登录安全护栏 (zero-dependency — 宿主生成 data URL、webview 渲染前共用)
// ---------------------------------------------------------------------------

/** PNG base64 data URL 的严格前缀。`isQrDataUrl` 只认这一种形态，防止把
 * `data:image/svg+xml` / `javascript:` 等任意 data URL 塞进 `<img src>`。 */
export const QR_DATA_URL_PREFIX = "data:image/png;base64,";

/**
 * 扫码登录 data URL 安全护栏：只接受严格 `data:image/png;base64,` 前缀 +
 * 非空合法 base64 串。base64 合法性判据：长度是 4 的倍数、字符集限于
 * `[A-Za-z0-9+/]`、仅末尾允许 0–2 个 `=` 填充、且填充前有非空正文。
 *
 * 零依赖（宿主与 webview 共用），纯函数，无副作用。宿主生成二维码 data URL
 * 后、webview 送进 `<img>` 前都应过这道门，避免把任意 data URL（尤其 svg /
 * javascript:）当成图片渲染。
 */
export function isQrDataUrl(value: string): boolean {
  if (typeof value !== "string") return false;
  if (!value.startsWith(QR_DATA_URL_PREFIX)) return false;
  const payload = value.slice(QR_DATA_URL_PREFIX.length);
  if (!payload || payload.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return false;
  // 去掉末尾填充后必须仍有正文（排除 "====" 等退化串；"==" 长度非 4 已被挡）。
  if (payload.replace(/=+$/, "").length === 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// User-prompt text helpers (zero-dependency — shared by the host reducer, the
// host's CLI-history matching, and the webview composer's ↑/↓ recall)
// ---------------------------------------------------------------------------

/**
 * The agent-facing attachment block header — a PROTOCOL literal.
 *
 * The host appends this header + a `- name → path` list to the prompt it
 * sends to the CLI, and the CLI records that text verbatim in
 * `~/.iflow/acp/sessions/<id>.json`. When the user later deletes a message,
 * the host matches the transcript prompt against the recorded CLI turn and
 * has to recognise the attachment block to tell "the CLI turn is this prompt
 * plus the attachment list" from "this prompt is merely a prefix of some
 * other turn".
 *
 * Producer and consumer MUST use the same literal. When only the producer is
 * translated (the model-facing prompts were switched to English), the
 * consumer stops recognising what the producer writes: the delete silently
 * degrades to a transcript-only delete and the message stays in the model's
 * context.
 *
 * English because it is model-facing text (the model reads it). The
 * transcript-side note (`（文件：name → path）`, see `normalizeUserPromptText`)
 * stays Chinese — that one is user-facing.
 */
export const AGENT_ATTACHMENT_HEADER =
  "The user attached the following local files (read them as needed):";

/**
 * Header variants written by older builds — accepted so that deleting a
 * message in a session recorded before the switch to English still finds the
 * CLI turn. The Chinese spelling is the pre-2026-11-12 host wording; the
 * "these local files" one is the English l10n bundle's translation of it.
 */
const LEGACY_AGENT_ATTACHMENT_HEADERS = [
  "用户附带以下本地文件（可按需读取）：",
  "The user attached these local files (read them as needed):",
];

/**
 * Does `text` contain an agent-facing attachment block (a header line
 * followed by a `- name → path` list)?
 *
 * Used by the host to tell "the CLI turn is this prompt plus the attachment
 * list" from "this prompt is merely a prefix of some other turn" — the
 * latter must NOT match, or a delete would cut the wrong turn out of the
 * model's context.
 */
export function hasAgentAttachmentBlock(text: string): boolean {
  const headers = [AGENT_ATTACHMENT_HEADER, ...LEGACY_AGENT_ATTACHMENT_HEADERS];
  for (const header of headers) {
    const at = text.indexOf(header);
    if (at < 0) continue;
    // The header must be followed by the `- name → path` list — a bare
    // mention of the header text is not an attachment block.
    if (/^\n- /.test(text.slice(at + header.length))) return true;
  }
  return false;
}

/**
 * Canonical form of a user prompt for cross-store matching (transcript block
 * ↔ CLI chatHistory entry ↔ composer history recall): strips the zero-width
 * escape `toAgentPromptText` prefixes to non-command "/" input (the CLI
 * persists the escaped form), drops the `（文件：name → path）` attachment
 * note lines beginUserPrompt appends, and trims.
 */
export function normalizeUserPromptText(text: string): string {
  return text
    .replace(/\u200B/g, "")
    .split("\n")
    .filter((line) => !/^（文件：.*→.*）$/.test(line))
    .join("\n")
    .trim();
}

/**
 * User-prompt texts of a transcript, oldest → newest, for the composer's
 * ↑/↓ history recall. Normalized via normalizeUserPromptText (attachment
 * notes stripped), blanks dropped, duplicates removed keeping the LAST
 * occurrence so recall shows the freshest copy first.
 */
export function collectUserPromptTexts(blocks: readonly Block[]): string[] {
  const texts: string[] = [];
  for (const b of blocks) {
    if (b.kind !== "user") continue;
    const stripped = normalizeUserPromptText(b.text);
    if (!stripped) continue;
    const dup = texts.lastIndexOf(stripped);
    if (dup >= 0) texts.splice(dup, 1);
    texts.push(stripped);
  }
  return texts;
}
