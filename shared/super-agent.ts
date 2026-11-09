/**
 * Super Agent — 主会话派发的子会话模型、状态机与委派指令协议（纯逻辑）。
 *
 * 设计取自三份参考资料的共同骨架，但按本项目的硬约束做了裁剪：
 *  - Orca：worktree 一等公民 + `worker_done` 幂等护栏（终态不可回退）+ 保留分支审查。
 *  - dsh-superagent：Report 五态 + 结构化 `human_action` + 「内部进展不打扰主会话」。
 *  - DeepSeek：Router 只分派不执行。
 *
 * 与参考实现的关键差异（诚实边界）：CLI 内核的 agent→client 方法表是固定集合
 * （`fs/read_text_file`、`fs/write_text_file`、`session/request_permission`、
 * `_iflow/user/questions`、`_iflow/plan/exit`），新增一个「向宿主开子会话」的原生
 * 工具必须改 vendored fork 的 bundle（锚点重生成、vendor 重打包）。本模块因此
 * 走**宿主侧委派指令协议**：主 Agent 在回复里输出一个 `super-agent` 代码块，宿主
 * 流式扫描并派发。子会话因此**没有**内核级的 report 工具 —— 它的 Report 由宿主
 * 观察到的生命周期事件推导（完成 / 失败 / 待应答 / 中断）。
 */

import type { UserQuestion } from "../src/acp/protocol.js";

/** 同时运行的子会话上限。超出上限的派发请求进 FIFO 排队（不拒绝）。 */
export const MAX_CONCURRENT_SUPER_SESSIONS = 4;

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

export type SuperStatus =
  /** 正在准备隔离环境（建 worktree / 起 CLI 进程）。 */
  | "preparing"
  /** 子会话执行中。 */
  | "running"
  /** 子会话在等用户应答（审批 / 提问 / Plan 退出）。 */
  | "awaiting_input"
  /** 已完成（终态）。 */
  | "completed"
  /** 失败（终态）。 */
  | "failed"
  /** 被中断（终态）。 */
  | "cancelled";

const TERMINAL_STATUSES: readonly SuperStatus[] = ["completed", "failed", "cancelled"];

/** 终态判定。终态之后的所有事件都被忽略 —— 这是 `worker_done`「恰好发一次」语义的
 * 宿主侧等价物：迟到的进度帧 / 重复的完成帧不能把已完成的子会话改回运行中。 */
export function isTerminalSuperStatus(status: SuperStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// 汇报（抄 dsh 的 Report 五态）
// ---------------------------------------------------------------------------

export type SuperReportState =
  /** 内部进展 —— 只更新看板，不打扰主会话。 */
  | "progress"
  /** 完成，产出可用。 */
  | "ready"
  /** 卡住，需要人行动。 */
  | "blocked"
  /** 失败。 */
  | "failed"
  /** 放弃。 */
  | "dropped";

export interface SuperReport {
  state: SuperReportState;
  /** 一句话摘要：做了什么 / 发现了什么 / 还剩什么。 */
  summary: string;
  at: number;
  /**
   * 结构化的「需要人行动」描述（dsh 的 `human_action`）。刻意与 `summary` 分开：
   * 「是否在等人」必须是结构化事实，不能从自由文本里推断。
   */
  humanAction?: string;
}

// ---------------------------------------------------------------------------
// 待应答
// ---------------------------------------------------------------------------

export type SuperPendingKind = "question";

/**
 * 子会话正在等用户回答的一个问题。
 *
 * 子会话的**审批不产生待办**：子会话始终跑在免确认模式（`yolo`），
 * `session/request_permission` 与 `_iflow/plan/exit` 都由宿主直接放行
 * （见 `src/panel/super-agent.ts` 的 `callbacksFor`）。只有 `_iflow/user/questions`
 * 是真正的信息缺口 —— 那是只有人才能回答的，落到这里由看板就地作答，不弹到
 * 主会话（主会话的 pending 槽位是单数，多子会话并发会互相覆盖）。
 */
export interface SuperPending {
  kind: SuperPendingKind;
  /** 宿主侧请求 id：应答按它路由回该子会话挂起的请求。 */
  requestId: string;
  questions: UserQuestion[];
  /** 自动按「未回答」继续的绝对截止时间（epoch ms），看板渲染倒计时。 */
  deadline: number;
}

// ---------------------------------------------------------------------------
// 隔离
// ---------------------------------------------------------------------------

export type SuperIsolationKind =
  /** 真 git worktree：分支独立，文件互不干扰。 */
  | "git_worktree"
  /** 非 git 仓库的降级方案：只是一个独立空目录，没有版本隔离。 */
  | "directory";

export interface SuperIsolation {
  kind: SuperIsolationKind;
  /** 子会话的工作目录（worktree 路径或独立目录）。 */
  path: string;
  /** git 分支名（仅 worktree）。 */
  branch?: string;
  /** worktree 的起点 ref。 */
  baseRef?: string;
  /** 隔离强度的诚实说明（降级时必填）。 */
  note?: string;
}

// ---------------------------------------------------------------------------
// 集成（把子会话的改动带回主工作区）
// ---------------------------------------------------------------------------

/** 子会话完成后如何把它的分支带回主工作区（对应 `iflow.superAgent.integration`）。 */
export type SuperIntegrationMode = "merge" | "pr" | "manual";

export type SuperIntegrationState =
  /** 已自动合并到主工作区的当前分支。 */
  | "merged"
  /** 自动合并冲突 —— 已 `merge --abort` 撤销，仓库没有被留在冲突态。 */
  | "conflict"
  /** 已推送分支并用 gh 创建 PR。 */
  | "pr_created"
  /** 集成失败（推送失败 / gh 不可用等），分支保留。 */
  | "failed"
  /** 没有可集成的改动，或主工作区不满足自动合并条件。 */
  | "skipped";

export interface SuperIntegration {
  mode: SuperIntegrationMode;
  state: SuperIntegrationState;
  /** 人话说明（skipped / failed / conflict 时必填）。 */
  detail?: string;
  /** PR 地址（pr_created 时）。 */
  url?: string;
  /** 这一条是否需要用户动手（合并冲突 / 工作区脏导致跳过 / 集成失败）。 */
  needsAction?: boolean;
  at: number;
}

/**
 * 记录集成结果。
 *
 * 刻意**不经过状态机**：这是对已结束会话的元数据补记，不是状态迁移；
 * 走 `applySuperEvent` 会被终态粘性直接丢弃。
 */
export function withIntegration(
  session: SuperSessionUi,
  integration: SuperIntegration,
): SuperSessionUi {
  return { ...session, integration, updatedAt: integration.at };
}

/** 集成结果的中文短标签（看板与主会话汇报共用，避免两处措辞漂移）。 */
export function superIntegrationLabel(integration: SuperIntegration): string {
  switch (integration.state) {
    case "merged":
      return "已自动合并";
    case "conflict":
      return "合并冲突";
    case "pr_created":
      return "PR 已创建";
    case "failed":
      return "集成失败";
    case "skipped":
      return "未自动合并";
  }
}

// ---------------------------------------------------------------------------
// 子会话
// ---------------------------------------------------------------------------

export interface SuperSessionUi {
  id: string;
  /** 人类可读标题（模型给的或用户给的）。 */
  title: string;
  /** 交给子会话的完整任务说明（自包含 —— 子会话看不到主会话的上下文）。 */
  task: string;
  status: SuperStatus;
  /**
   * True while the request waits for a free concurrency slot. The record
   * exists from the moment the delegation is parsed, so the board can show
   * it as 「排队中」 instead of pretending it started.
   */
  queued?: boolean;
  /** 执行次数（1 = 首次）。意外中断后重试会 +1 —— 看板据此显示「第 N 次」。 */
  attempts?: number;
  isolation: SuperIsolation;
  /** 子会话的 ACP sessionId。 */
  cliSessionId?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  endedAt?: number;
  /** 最近一次汇报摘要。 */
  summary?: string;
  /** 失败原因。 */
  error?: string;
  /** 正在等待的应答。 */
  pending?: SuperPending;
  /** 末次上报的 token 用量（CLI 的 usage 报告，缺失则不显示）。 */
  tokens?: { input: number; output: number };
  /** 完成后把分支带回主工作区的结果（自动合并 / PR 流程写入）。 */
  integration?: SuperIntegration;
  /** 汇报历史（审计用，按时间升序）。 */
  reports: SuperReport[];
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

export type SuperEvent =
  | { type: "started"; cliSessionId: string; at: number }
  | { type: "progress"; summary: string; at: number }
  | { type: "needs_input"; pending: SuperPending; at: number }
  | { type: "input_resolved"; at: number }
  | { type: "report"; report: SuperReport; at: number }
  | { type: "failed"; error: string; at: number }
  | { type: "cancelled"; at: number };

/** Report 状态 → 子会话状态。 */
function statusForReport(state: SuperReportState): SuperStatus {
  switch (state) {
    case "progress":
      return "running";
    case "ready":
      return "completed";
    case "blocked":
      return "awaiting_input";
    case "failed":
      return "failed";
    case "dropped":
      return "cancelled";
  }
}

/**
 * 纯状态机。终态是粘的：终态会话收到任何事件都原样返回（同一引用），因此
 * 「迟到的事件把已完成的子会话改回运行中」这种竞态在类型层面就不可能发生。
 */
export function applySuperEvent(session: SuperSessionUi, event: SuperEvent): SuperSessionUi {
  if (isTerminalSuperStatus(session.status)) return session;

  switch (event.type) {
    case "started":
      if (session.status === "running") return session;
      return {
        ...session,
        status: "running",
        queued: false,
        cliSessionId: event.cliSessionId,
        startedAt: session.startedAt ?? event.at,
        updatedAt: event.at,
      };

    case "progress":
      if (session.status === "awaiting_input") return session;
      return {
        ...session,
        status: "running",
        summary: event.summary,
        updatedAt: event.at,
        reports: [...session.reports, { state: "progress", summary: event.summary, at: event.at }],
      };

    case "needs_input":
      return {
        ...session,
        status: "awaiting_input",
        pending: event.pending,
        updatedAt: event.at,
        reports: [
          ...session.reports,
          {
            state: "blocked",
            summary: describePending(event.pending),
            at: event.at,
            humanAction: describePending(event.pending),
          },
        ],
      };

    case "input_resolved":
      if (session.status !== "awaiting_input") return session;
      return { ...session, status: "running", pending: undefined, updatedAt: event.at };

    case "report": {
      const status = statusForReport(event.report.state);
      const next: SuperSessionUi = {
        ...session,
        status,
        summary: event.report.summary,
        updatedAt: event.at,
        reports: [...session.reports, event.report],
      };
      if (status === "completed" || status === "failed" || status === "cancelled") {
        next.endedAt = event.at;
        // 终态不再等应答：卡死在那里的审批对用户没有意义。
        next.pending = undefined;
      }
      if (status === "awaiting_input" && event.report.humanAction) {
        next.summary = event.report.summary;
      }
      return next;
    }

    case "failed":
      return {
        ...session,
        status: "failed",
        error: event.error,
        endedAt: event.at,
        updatedAt: event.at,
        pending: undefined,
        reports: [...session.reports, { state: "failed", summary: event.error, at: event.at }],
      };

    case "cancelled":
      return {
        ...session,
        status: "cancelled",
        endedAt: event.at,
        updatedAt: event.at,
        pending: undefined,
        reports: [...session.reports, { state: "dropped", summary: "已被中断", at: event.at }],
      };
  }
}

/** 待应答的人话描述（看板与主会话汇报共用）。 */
export function describePending(pending: SuperPending): string {
  return pending.questions[0]?.question ?? "子会话提出了一个问题";
}

// ---------------------------------------------------------------------------
// 重试（意外中断后的补救）
// ---------------------------------------------------------------------------

/**
 * 能否重试。
 *
 * 只有「非正常结束」的子会话可重试：`failed`（提示词报错 / 内核崩溃 /
 * 进程意外退出）与 `cancelled`（用户中断、面板关闭时被终止）。`completed`
 * 是正常终态，重跑它属于「再来一遍」而不是「恢复中断」，不在本能力范围内。
 */
export function canRetrySuperSession(session: SuperSessionUi): boolean {
  return session.status === "failed" || session.status === "cancelled";
}

/**
 * 把终态子会话重置为「准备中」，供重试使用。
 *
 * 刻意保留 `id` / 标题 / 任务说明 / **隔离环境**：worktree 与分支里可能有
 * 中断前留下的未提交改动，管理层会优先复用它（新建一个空 worktree 等于把
 * 那些工作藏起来）。只清掉上一轮的终态残留（错误、摘要、待应答、集成结果、
 * 旧 CLI 会话 id），并把 `attempts` +1。汇报历史保留 —— 审计上能看到
 * 「失败 → 重试 → 完成」的完整轨迹。
 */
export function retrySuperSession(session: SuperSessionUi, at: number): SuperSessionUi {
  const attempt = (session.attempts ?? 1) + 1;
  return {
    ...session,
    status: "preparing",
    queued: true,
    attempts: attempt,
    cliSessionId: undefined,
    startedAt: undefined,
    endedAt: undefined,
    summary: undefined,
    error: undefined,
    pending: undefined,
    integration: undefined,
    updatedAt: at,
    reports: [...session.reports, { state: "progress", summary: `重试中（第 ${attempt} 次）`, at }],
  };
}

// ---------------------------------------------------------------------------
// 委派指令协议
// ---------------------------------------------------------------------------

export interface SuperTaskSpec {
  title: string;
  task: string;
}

/** 委派代码块的开栏标记（必须独占一行）。 */
const FENCE_OPEN = /^```super-agent[ \t]*$/;
/** 收栏标记（必须独占一行）。 */
const FENCE_CLOSE = /^```[ \t]*$/;

export interface SuperDirectiveScan {
  /** 解析成功的指令块，每个块一组任务。 */
  blocks: SuperTaskSpec[][];
  /** 解析失败的块正文（宿主据此提示用户，不静默吞掉）。 */
  invalidBlocks: string[];
  /**
   * 扫描结束位置（消费偏移）。调用方把它当作下一轮的起点 —— 已消费的块不会
   * 被二次派发，即使同一段文本在后续 chunk 里再次出现。
   */
  end: number;
}

/** 标题清洗：压空白、截断到 40 字（看板一行放得下）。 */
export function normalizeSuperTitle(raw: string, fallback = "子会话"): string {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return fallback;
  return cleaned.length > 40 ? `${cleaned.slice(0, 39)}…` : cleaned;
}

/**
 * 从主 Agent 的回复文本里扫出委派指令块。
 *
 * 逐块解析：开栏 → 收集正文直到收栏 → JSON.parse。JSON 必须是
 * `{ "tasks": [{ "title", "task" }] }` 或直接的数组；`task` 必填非空，
 * `title` 可省（用任务首行兜底）。
 *
 * 解析失败的块不会中断扫描 —— 它们被收集进 `invalidBlocks`，宿主据此给用户
 * 一条明确提示，而不是假装什么都没发生。
 */
export function extractSuperDirectives(text: string, fromOffset = 0): SuperDirectiveScan {
  const blocks: SuperTaskSpec[][] = [];
  const invalidBlocks: string[] = [];
  let end = fromOffset;

  let cursor = fromOffset;
  while (cursor < text.length) {
    const open = findFence(text, cursor, FENCE_OPEN);
    if (!open) break;
    const close = findFence(text, open.bodyStart, FENCE_CLOSE);
    if (!close) {
      // 还没闭合（流式中间态）—— 停在这里，等后续 chunk 补齐。
      end = open.lineStart;
      break;
    }
    const body = text.slice(open.bodyStart, close.lineStart).trim();
    const parsed = parseDirectiveBody(body);
    if (parsed) blocks.push(parsed);
    else if (body) invalidBlocks.push(body);
    cursor = close.lineEnd;
    end = close.lineEnd;
  }

  return { blocks, invalidBlocks, end };
}

interface FenceMatch {
  /** 围栏所在行的行首偏移。 */
  lineStart: number;
  /** 围栏行之后的正文起始偏移。 */
  bodyStart: number;
  /** 围栏行之后的行尾偏移。 */
  lineEnd: number;
}

/** 找下一个独占一行的围栏。 */
function findFence(text: string, from: number, pattern: RegExp): FenceMatch | null {
  let pos = from;
  while (pos <= text.length) {
    let lineEnd = text.indexOf("\n", pos);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(pos, lineEnd).replace(/\r$/, "");
    if (pattern.test(line)) {
      return { lineStart: pos, bodyStart: Math.min(lineEnd + 1, text.length), lineEnd: Math.min(lineEnd + 1, text.length) };
    }
    if (lineEnd === text.length) return null;
    pos = lineEnd + 1;
  }
  return null;
}

/** 解析指令块正文。返回 null 表示格式非法。 */
function parseDirectiveBody(body: string): SuperTaskSpec[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const rawTasks = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { tasks?: unknown }).tasks)
      ? (parsed as { tasks: unknown[] }).tasks
      : null;
  if (!rawTasks) return null;

  const tasks: SuperTaskSpec[] = [];
  for (const entry of rawTasks) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as { title?: unknown; task?: unknown };
    const task = typeof record.task === "string" ? record.task.trim() : "";
    // A task that is still a placeholder (the model echoed the documented
    // example back) is skipped — opening a child session for "<任务说明>"
    // would burn a process for nothing.
    if (!task || isPlaceholderTask(task)) continue;
    const rawTitle = typeof record.title === "string" ? record.title.trim() : "";
    const title = rawTitle && !isPlaceholderTask(rawTitle) ? rawTitle : "";
    tasks.push({ title: normalizeSuperTitle(title, task.split("\n")[0] ?? "子会话"), task });
  }
  return tasks.length > 0 ? tasks : null;
}

/** 占位符形态的任务 / 标题（模型把协议示例原样抄了回来）。 */
function isPlaceholderTask(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/^<[^<>]{1,60}>$/.test(trimmed)) return true;
  return trimmed === "..." || trimmed === "…" || trimmed === "TODO";
}

// ---------------------------------------------------------------------------
// 汇报文本
// ---------------------------------------------------------------------------

/** 看板顶部的计数摘要。 */
export function summarizeSuperSessions(sessions: readonly SuperSessionUi[]): {
  total: number;
  running: number;
  awaiting: number;
  done: number;
  failed: number;
} {
  let running = 0;
  let awaiting = 0;
  let done = 0;
  let failed = 0;
  for (const s of sessions) {
    if (s.status === "preparing" || s.status === "running") running++;
    else if (s.status === "awaiting_input") awaiting++;
    else if (s.status === "completed") done++;
    else if (s.status === "failed" || s.status === "cancelled") failed++;
  }
  return { total: sessions.length, running, awaiting, done, failed };
}

/** Report 状态 → 中文短标签（主会话汇报与看板共用，避免两处措辞漂移）。 */
export function superReportLabel(state: SuperReportState): string {
  switch (state) {
    case "progress":
      return "进行中";
    case "ready":
      return "已完成";
    case "blocked":
      return "等待用户处理";
    case "failed":
      return "失败";
    case "dropped":
      return "已中断";
  }
}

/**
 * 把子会话汇报拼成一条给**主会话**的提示词。
 *
 * 刻意做成结构化文本而不是自由叙述：主 Agent 需要据此（a）向用户转述、
 * （b）决定下一步（例如是否再派一个子会话去修）。多条汇报合成一条，避免
 * N 个子会话同时完成时把主会话灌爆（dsh 的 relay 保序 + 合并）。
 */
export function buildSuperReportPrompt(entries: { session: SuperSessionUi; report: SuperReport }[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map(({ session, report }) => {
    const human = report.humanAction ? `\n   需要用户处理：${report.humanAction}` : "";
    const integration = session.integration
      ? `\n   改动去向：${superIntegrationLabel(session.integration)}${
          session.integration.detail ? `（${session.integration.detail}）` : ""
        }${session.integration.url ? ` ${session.integration.url}` : ""}`
      : "";
    return `- 子会话 #${session.id}「${session.title}」${superReportLabel(report.state)}：${report.summary}${human}${integration}`;
  });
  return [
    "[子会话状态上报]",
    "以下是你派发的子会话的状态更新（由宿主自动上报，不是用户发言）。",
    ...lines,
    "",
    "请据此向用户简明转述结果；若有需要用户决策的事项，明确提出那一个具体问题。",
  ].join("\n");
}

/**
 * 宿主观察到子会话进入某状态时，推导出的 Report。
 *
 * v1 没有内核级 report 工具（那需要改 fork bundle），所以汇报完全由宿主
 * 观察到的生命周期事件推导 —— 摘要取子会话最后的助手文本。
 */
export function reportForSession(
  session: SuperSessionUi,
  at: number,
  fallbackSummary: string,
): SuperReport | null {
  switch (session.status) {
    case "completed":
      return { state: "ready", summary: session.summary ?? fallbackSummary, at };
    case "failed":
      return { state: "failed", summary: session.error ?? fallbackSummary, at };
    case "cancelled":
      return { state: "dropped", summary: session.summary ?? "已被中断", at };
    case "awaiting_input":
      return session.pending
        ? {
            state: "blocked",
            summary: describePending(session.pending),
            at,
            humanAction: describePending(session.pending),
          }
        : null;
    default:
      return null;
  }
}

