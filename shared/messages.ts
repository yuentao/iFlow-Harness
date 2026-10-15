/**
 * Extension Host ↔ WebView message protocol (type-safe both sides).
 * Snapshot model per plan §2.1: the Extension Host owns the full session
 * state; the WebView is a projection that receives throttled snapshots.
 */

import type {
  SessionModeState,
  SlashCommand,
  ToolCallStatus,
  ToolKind,
  ToolLocation,
  StopReason,
  UserQuestion,
} from "../src/acp/protocol.js";
import type { ApprovalRule } from "./approval-policy.js";

// Webview components import wire types from this module — re-export the
// protocol types they need.
export type { SlashCommand, UserQuestion };
// M4 P1-1: the approval-policy card edits these directly (the rule shape is
// shared pure data, not session state — it never rides a snapshot).
export type { ApprovalRule, ApprovalAction } from "./approval-policy.js";

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
   * chatter ("正在压缩…", "压缩聊天历史失败：…") and approval/plan
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
   * P-1 follow-up: present when `output` exceeded MAX_TOOL_OUTPUT_CHARS
   * (64K chars) and was capped — the number of dropped characters. The
   * webview surfaces it as a truncation notice on the output pane.
   */
  truncatedChars?: number;
  locations: ToolLocation[];
  /** Present when the update carried a structured diff (`type: "diff"`). */
  diff: ToolDiffUi | null;
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
  /** Source kind: the CLI's assembled system instruction, the joined
   * hierarchical memory, or one context file (AGENTS.md/IFLOW.md/...). */
  kind: "system" | "memory" | "context-file";
  /** Display name, e.g. "系统提示词", "AGENTS.md". */
  label: string;
  /** Absolute path for file-backed sources (absent for the system prompt). */
  path?: string;
  /** Full body as the model receives it. */
  content: string;
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
  /** One-line summary, e.g. "本次请求自动注入了 3 项内容：系统提示词、记忆、1 个上下文文件". */
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
 * A Plan-mode exit request awaiting user confirmation (iFlow extension
 * `_iflow/plan/exit`). Rendered with the same approval-card visual form as
 * `pendingApproval` so the panel stays visually consistent; the user approves
 * or rejects, and the host replies `{ approved, reason }`.
 */
export interface PendingPlanExitUi {
  id: string;
  /** The plan the agent wants to execute once Plan mode is exited. May be long. */
  plan: string;
  /** Host-side auto-answer deadline (epoch ms); drives the countdown UI. */
  deadline: number;
  /** Total answer window in ms (APPROVAL_TIMEOUT_MS). */
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

/** One user answer: selected labels, or a free-text "Other" answer. */
export type UserAnswerValue = string | string[];

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
export type ContextKind = "code" | "folder" | "problems" | "git" | "url";

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
  /** Non-null while the host awaits the user's confirmation to exit Plan mode. */
  pendingPlanExit: PendingPlanExitUi | null;
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
  /** True while a new session is being created (host busy; UI locks switches). */
  initializing: boolean;
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
    return "Base URL 必须以 http:// 或 https:// 开头";
  }
  if (input.apiKey !== undefined && !(input.apiKey ?? "").trim()) {
    return "API Key 不能为空";
  }
  if (!input.modelName.trim()) return "模型名称不能为空";
  return null;
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
    pendingPlanExit: null,
    pendingQuestions: null,
    pendingProfileSwitch: null,
    auth: { authenticated: false, needsSetup: false, saved: null, profiles: [] },
    sessions: [],
    activeSessionId: null,
    replaying: false,
    initializing: false,
    compressing: false,
    usage: emptySessionUsage(),
    queue: [],
    queuePaused: false,
    checkpoints: [],
  };
}

/** Zeroed usage so the token chip renders from the first paint (a session
 * with no content yet shows ↑0 ↓0 rather than hiding the indicator). */
export function emptySessionUsage(): SessionUsageUi {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
}

/**
 * Whether the session currently sits in Plan mode. Matched by the mode's
 * `kind` (the CLI's semantic tag, probed CLI 0.5.19 `session/new` `_meta`);
 * falls back to the literal id "plan" for agents that omit `kind`. Shared by
 * host (status bar) and webview (streaming indicator wording) so both agree
 * on when to say 规划 instead of 生成.
 */
export function isPlanMode(modes: SessionModeState | null | undefined): boolean {
  if (!modes) return false;
  const current = modes.availableModes.find((m) => m.id === modes.currentModeId);
  if (!current) return false;
  return current.kind === "plan" || (current.kind === undefined && current.id === "plan");
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
      return { ...block, output: "", truncatedChars: undefined, diff: null, evicted: true };
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
      /** Optional inline action button (M1 P0-6: "立即压缩" on the
       * context-warning pill). Clicking it sends `toastAction` with this id;
       * the host performs the action and owns pill removal (persistent
       * semantics unchanged — a non-persistent action pill still
       * auto-dismisses). */
      action?: { actionId: string; label: string };
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
  /** Reply to `listMcpServers` / `saveMcpServers`: the current MCP server
   * dict (name → config) as it stands on disk after the operation. `error`
   * non-empty means the read/write failed (the dict is then the last-known or
   * best-effort value, not a confirmed save). */
  | { type: "mcpServers"; servers: Record<string, unknown>; error?: string }
  /** M4 P1-1: the approval pre-review rule table. `rules` are the user's
   * global rules (editable, persisted in globalState); `projectRules` come
   * from the workspace's `.iflow/approval.json` and are READ-ONLY here (the
   * file is user-owned — the host matches them first but never writes them).
   * `draft` non-null means a 「始终允许」 click derived a rule that is now
   * waiting to be named: the webview opens the policy card in naming mode and
   * either saves it into `rules` or dismisses it. */
  | { type: "approvalPolicy"; rules: ApprovalRule[]; projectRules: ApprovalRule[]; draft?: ApprovalRule | null }
  /** Editor color theme changed ("dark" | "light"); the webview follows it
   * unless the user picked a theme manually in the panel. `auroraIntensity`
   * (0–100) mirrors the `iflow.auroraIntensity` setting — the webview scales
   * the background aurora light-spot opacity with it. */
  | { type: "theme"; kind: "dark" | "light"; auroraIntensity?: number }
  /** Turn finished ("done") or failed ("error") — the webview plays a short
   * synthesized cue. Host gates on the `iflow.soundFeedback` setting and on
   * panel visibility; the webview only synthesizes on receipt. */
  | { type: "playSound"; kind: "done" | "error" }
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
  | { type: "contextResolved"; requestId: number; kind: ContextKind; label: string; detail: string; content: string; error?: string };

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
  | { type: "newSession" }
  | { type: "setMode"; modeId: string }
  | { type: "setModel"; modelId: string }
  /** Open a file location in the editor. `toolCallId` (when the chip belongs
   * to a tool card with a diff) lets the host resolve a bare-basename wire
   * path via the same multi-candidate lookup as revert/openDiff (pitfall #6). */
  | { type: "openLocation"; path: string; line?: number | null; toolCallId?: string }
  | { type: "openExternal"; uri: string }
  /** Answer a pending approval; `optionId: null` cancels the request. */
  | { type: "respondApproval"; id: string; optionId: string | null }
  /** Confirm or reject a pending Plan-mode exit; `approved: false` rejects. */
  | { type: "respondPlanExit"; id: string; approved: boolean; reason?: string; replan?: boolean }
  /** Answer the pending ask_user_question card; `answers` is keyed by
   * question `header`. An empty answers object = dismissed (the agent
   * proceeds with "no answer"). */
  | { type: "answerQuestions"; id: string; answers: Record<string, string | string[]> }
/** Answer the profile-switch choice dialog; `keepSession: null` cancels the
 * entire switch (dialog dismissed / 取消 — no credential or reconnect side
 * effects, the active profile pointer stays where it was). */
| { type: "respondProfileSwitch"; id: string; keepSession: boolean | null }
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
  | { type: "openDiff"; toolCallId: string }
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
  /** M4 P1-8: toggle a session's pinned / archived flags (persisted with the
   * session index; the switcher renders archived ones in a second section). */
  | { type: "setSessionFlags"; sessionId: string; pinned: boolean; archived: boolean }
  /** Re-read the API profile list (SecretStorage + CLI settings.json) when the
   * profile dropdown / auth card opens — external tools rewrite settings.json
   * behind our back, so the shown list must be recomputed on open. */
  | { type: "refreshAuth" }
  /** Re-query `GET {baseUrl}/models` when the model dropdown opens — the list
   * captured at session start goes stale (new gateway models appear). */
  | { type: "refreshModels" }
  /** Settings-page hot restart: tear the CLI child down and spawn a fresh
   * one so startup-only changes (language / approvalMode / mcpServers written
   * to settings.json) take effect without reloading VSCode. */
  | { type: "restartCli" }
  /** Open the VSCode Settings UI filtered to the iFlow extension section. */
  | { type: "openSettings" }
  /** MCP management card opened: read the CURRENT `mcpServers` dict from
   * `~/.iflow/settings.json` (the CLI / external tools own that file — the
   * card must show disk truth, not a cached copy). Reply: `mcpServers`. */
  | { type: "listMcpServers" }
  /** Save the full MCP server dict (replace semantics — the card edits a
   * fresh copy read via `listMcpServers`, so a concurrent external write is
   * at worst lost, never silently merged). Host writes settings.json and
   * offers a hot restart. Reply: `mcpServers` with `error` on failure. */
  | { type: "saveMcpServers"; servers: Record<string, unknown> }
  /** M4 P1-1: approval-policy card opened — re-read the global table and the
   * workspace `.iflow/approval.json` (external tools may have rewritten it).
   * Reply: `approvalPolicy`. */
  | { type: "listApprovalPolicy" }
  /** Save the whole global rule table (replace semantics — the card edits a
   * fresh copy read via `listApprovalPolicy`). Also clears a pending `draft`
   * when the card saved it into `rules`. Reply: `approvalPolicy`. */
  | { type: "saveApprovalPolicy"; rules: ApprovalRule[] }
  /** Abandon the 「始终允许」-derived draft without adding it. The wire
   * response already went out (the CLI's own proceed_always still applies for
   * this session) — only the persistent host-side rule is dropped. */
  | { type: "dismissApprovalRuleDraft" }
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
  | { type: "toastAction"; actionId: string; toastId?: number };

// ---------------------------------------------------------------------------
// User-prompt text helpers (zero-dependency — shared by the host reducer, the
// host's CLI-history matching, and the webview composer's ↑/↓ recall)
// ---------------------------------------------------------------------------

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
