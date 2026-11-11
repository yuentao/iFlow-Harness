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

/**
 * 记录子会话的 token 用量。
 *
 * 与 `withIntegration` 同理：这是对已结束会话的元数据补记，不经过状态机 ——
 * 走 `applySuperEvent` 会被终态粘性直接丢弃，而用量恰恰是在终态之后才结算的。
 */
export function withUsage(
  session: SuperSessionUi,
  tokens: SuperTokenUsage,
  at: number,
): SuperSessionUi {
  return { ...session, tokens, updatedAt: at };
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
// Token 用量
// ---------------------------------------------------------------------------

/**
 * 子会话的 token 开销。
 *
 * 口径与主会话一致（见 `TurnUsageReport` / `SessionUsageUi`）：CLI 的
 * acp-usage-report Mod 只上报**末次请求**的输入，因此 `input` 是那一轮的
 * 上下文（权威），`output` 是宿主从子会话流式文本估算的全轮输出（含思考
 * 文本，保守地取 `completionTokens` 与文本估算的较大值）。多轮工具循环的
 * 输入总量 wire 不带，所以这是「可解释的下界」，不是账单级精确值。
 */
export interface SuperTokenUsage {
  input: number;
  output: number;
  /** 末次请求命中缓存的输入 token（已包含在 `input` 里）。 */
  cachedRead?: number;
  /** 按 `iflow.costTable` / 内置单价估算的美元成本；null = 该模型无单价。 */
  estimatedCost?: number | null;
  /** true = `input` 来自内核上报；false = 宿主按任务提示估算。 */
  authoritative?: boolean;
}

/** 所有子会话的合计开销（看板汇总）。`estimatedCost` 只有在每个产生了用量
 * 的子会话都能算出成本时才给数值 —— 混入无单价模型时宁可不显示，也不给一个
 * 偏小的总数。 */
export function sumSuperUsage(sessions: readonly SuperSessionUi[]): {
  input: number;
  output: number;
  estimatedCost: number | null;
} {
  let input = 0;
  let output = 0;
  let cost = 0;
  let costComplete = true;
  let anyUsage = false;
  for (const session of sessions) {
    const usage = session.tokens;
    if (!usage) continue;
    anyUsage = true;
    input += usage.input;
    output += usage.output;
    if (typeof usage.estimatedCost === "number") cost += usage.estimatedCost;
    else costComplete = false;
  }
  return {
    input,
    output,
    estimatedCost: anyUsage && costComplete ? cost : null,
  };
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
  /** 子会话实际使用的模型 id（null/缺省 = 沿用 CLI 默认）。 */
  model?: string;
  /**
   * 实时进度：子会话助手文本的**尾部**快照（宿主节流写入，最长
   * `SUPER_PROGRESS_MAX_CHARS`）。只用于看板的「进度详情」，不是完整转录。
   */
  progress?: string;
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
  /** 子会话的 token 开销（回合结束后结算，见 SuperTokenUsage）。 */
  tokens?: SuperTokenUsage;
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

/** 一个子会话任务最多携带的附件数（提示词与复制成本都要有上限）。 */
export const MAX_SUPER_ATTACHMENTS = 10;

/**
 * 随任务交给子会话的一份文件或图片。
 *
 * 子会话看不到主会话的对话，也读不到主工作区与暂存目录，所以附件必须由宿主
 * **复制**到它可见的位置：`path` 是宿主磁盘上的源文件；`data` 是用户粘贴图片
 * 的内联 base64（这类图片从来没有磁盘路径）。两者恰好有一个。
 */
export interface SuperAttachment {
  /** 展示名（默认取路径 basename）。 */
  name: string;
  /** 宿主机上的源文件路径（由宿主复制）。 */
  path?: string;
  /** 内联图片载荷（base64，不含 `data:` 前缀）。 */
  data?: string;
  /** 内联图片的 MIME 类型。 */
  mimeType?: string;
}

export interface SuperTaskSpec {
  title: string;
  task: string;
  /** 随任务交给子会话的附件（指令里只允许写路径，内联图片由宿主补）。 */
  attachments?: SuperAttachment[];
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
 *
 * 围栏块之外还有一条**兜底路径**：模型有时不按围栏块输出，而是把载荷写成
 * 「工具调用」语法（见 {@link findToolStylePayloads}）。两条路径解析出同一份
 * 任务列表，且互不重复派发。
 */
export function extractSuperDirectives(text: string, fromOffset = 0): SuperDirectiveScan {
  const blocks: SuperTaskSpec[][] = [];
  const invalidBlocks: string[] = [];
  let end = fromOffset;

  let cursor = fromOffset;
  let fenceUnclosed = false;
  while (cursor < text.length) {
    const open = findFence(text, cursor, FENCE_OPEN);
    if (!open) break;
    const close = findFence(text, open.bodyStart, FENCE_CLOSE);
    if (!close) {
      // 还没闭合（流式中间态）—— 停在这里，等后续 chunk 补齐。
      end = open.lineStart;
      fenceUnclosed = true;
      break;
    }
    const body = text.slice(open.bodyStart, close.lineStart).trim();
    const parsed = parseDirectiveBody(body);
    if (parsed) blocks.push(parsed);
    else if (body) invalidBlocks.push(body);
    cursor = close.lineEnd;
    end = close.lineEnd;
  }

  // 工具调用式载荷：只在围栏扫描没吃掉的区域里找，否则同一个 JSON 会被
  // 派发两次（围栏路径先走，已经消费过的区域不会进兜底扫描）。
  // 围栏未闭合时不做兜底 —— 那段文本归围栏路径管（等收栏再解析），
  // 否则「载荷已完整但围栏还没收栏」的流式中间态会被提前派发。
  if (!fenceUnclosed) {
    for (const match of findToolStylePayloads(text, Math.max(fromOffset, end))) {
      if (match.tasks) blocks.push(match.tasks);
      else invalidBlocks.push(match.body);
      if (match.end > end) end = match.end;
    }
  }

  return { blocks, invalidBlocks, end };
}

/** 委派标记：模型在「工具调用式」输出里用它点名要委派子会话。 */
const TOOL_STYLE_MARKER = "super-agent";
/** 标记与载荷之间允许的最大间隔（字符）—— 模型通常在标记后一两行内给出载荷。 */
const TOOL_STYLE_PAYLOAD_GAP = 80;

interface ToolStylePayload {
  /** 解析出的任务；null = 看起来是委派载荷但内容非法（宿主据此提示用户）。 */
  tasks: SuperTaskSpec[] | null;
  /** 载荷原文。 */
  body: string;
  /** 载荷起始偏移。 */
  start: number;
  /** 载荷结束偏移（不含）。 */
  end: number;
}

/**
 * 找「工具调用式」的委派载荷。
 *
 * 背景（实测 2026-11-10）：sensenova-6.8-flash-lite 收到「并行委派两个子会话」
 * 的要求后，输出的是 `<｜DSML｜tool-super-agent>{"tasks":[...]}</tool-super-agent>`
 * —— 载荷仍是合法的 tasks JSON，只是包裹标记是工具调用而不是 markdown 围栏。
 * 本扩展允许接入任意 OpenAI 兼容端点，各家模型的工具调用写法并不一致
 * （`<｜DSML｜tool-xxx>`、`<tool_call>{...}</tool_call>`……），所以宿主不能
 * 只认一种写法。
 *
 * 锚点是**标记本身**而不是某种固定语法：标记 → 不远处的一个 `{` / `[` →
 * 配对的 JSON → 严格的任务校验。判定链任一环不成立就不派发，模型把协议
 * 示例原样抄回来（占位符任务）同样不会误派发。
 */
function findToolStylePayloads(text: string, from: number): ToolStylePayload[] {
  const out: ToolStylePayload[] = [];
  let searchFrom = from;
  while (searchFrom < text.length) {
    const marker = text.indexOf(TOOL_STYLE_MARKER, searchFrom);
    if (marker === -1) break;
    const after = marker + TOOL_STYLE_MARKER.length;
    const start = findPayloadStart(text, after);
    if (start === -1) {
      // 标记后面还没有载荷（流式中间态）—— 等后续 chunk。
      break;
    }
    const close = matchJsonValue(text, start);
    if (close === -1) {
      // JSON 还没收全（流式中间态）—— 跳过这个标记，继续找后面的。
      searchFrom = after;
      continue;
    }
    const tasks = parseToolStylePayload(text.slice(start, close + 1));
    if (tasks.tasks) {
      out.push({ tasks: tasks.tasks, body: text.slice(start, close + 1), start, end: close + 1 });
      searchFrom = close + 1;
      continue;
    }
    if (tasks.looksLikeDelegation) {
      // 确实是委派载荷但内容非法 —— 交给宿主提示用户，而不是静默丢弃。
      out.push({ tasks: null, body: text.slice(start, close + 1), start, end: close + 1 });
      searchFrom = close + 1;
      continue;
    }
    searchFrom = after;
  }
  return out;
}

/** 标记之后的第一个 `{` / `[`（超过间隔就当没有载荷）。 */
function findPayloadStart(text: string, after: number): number {
  const limit = Math.min(text.length, after + TOOL_STYLE_PAYLOAD_GAP);
  for (let i = after; i < limit; i++) {
    const ch = text.charAt(i);
    if (ch === "{" || ch === "[") return i;
  }
  return -1;
}

/**
 * 从 `{` / `[` 开始找配对的结束符（跳过字符串字面量与转义）。
 * 找不到返回 -1 —— 流式中间态的半截 JSON。
 */
function matchJsonValue(text: string, start: number): number {
  const open = text.charAt(start);
  if (open !== "{" && open !== "[") return -1;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }
    if (ch === "}" || ch === "]") {
      const expected = ch === "}" ? "{" : "[";
      if (stack.pop() !== expected) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/**
 * 解析工具调用式的载荷。除了直接的 `{"tasks":[...]}` / 裸数组，还认得模型
 * 常用的参数包装体（`{"name":"super-agent","arguments":{"tasks":[...]}}`）。
 *
 * 返回 `looksLikeDelegation` 区分「这不是委派载荷」（例如 `super-agent-actions`
 * 的动作块）与「是委派载荷但内容非法」—— 后者要被宿主提示，前者要静默忽略。
 */
function parseToolStylePayload(body: string): {
  tasks: SuperTaskSpec[] | null;
  looksLikeDelegation: boolean;
} {
  const direct = parseDirectiveBody(body);
  if (direct) return { tasks: direct, looksLikeDelegation: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { tasks: null, looksLikeDelegation: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { tasks: null, looksLikeDelegation: false };
  }
  const record = parsed as Record<string, unknown>;
  if ("tasks" in record) return { tasks: null, looksLikeDelegation: true };
  for (const key of ["arguments", "parameters", "input", "args"]) {
    const inner = record[key];
    if (typeof inner !== "object" || inner === null || Array.isArray(inner)) continue;
    const tasks = parseDirectiveBody(JSON.stringify(inner));
    if (tasks) return { tasks, looksLikeDelegation: true };
    if ("tasks" in (inner as Record<string, unknown>)) {
      return { tasks: null, looksLikeDelegation: true };
    }
  }
  return { tasks: null, looksLikeDelegation: false };
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
    const record = entry as { title?: unknown; task?: unknown; attachments?: unknown };
    const task = typeof record.task === "string" ? record.task.trim() : "";
    // A task that is still a placeholder (the model echoed the documented
    // example back) is skipped — opening a child session for "<任务说明>"
    // would burn a process for nothing.
    if (!task || isPlaceholderTask(task)) continue;
    const rawTitle = typeof record.title === "string" ? record.title.trim() : "";
    const title = rawTitle && !isPlaceholderTask(rawTitle) ? rawTitle : "";
    const attachments = parseDirectiveAttachments(record.attachments);
    tasks.push({
      title: normalizeSuperTitle(title, task.split("\n")[0] ?? "子会话"),
      task,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  }
  return tasks.length > 0 ? tasks : null;
}

/**
 * 委派指令里的附件列表。只接受路径 —— base64 图片不可能由模型可靠地写出，
 * 而一段被流式扫描的巨型 base64 只会拖垮协议。用户的粘贴图片由宿主自己补
 * 进同一个列表（见 `ChatPanel.currentTurnAttachments`）。
 */
function parseDirectiveAttachments(raw: unknown): SuperAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: SuperAttachment[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_SUPER_ATTACHMENTS) break;
    if (typeof entry === "string") {
      const target = entry.trim();
      if (target && !isPlaceholderTask(target)) out.push({ name: attachmentBaseName(target), path: target });
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { path?: unknown; name?: unknown };
    if (typeof record.path !== "string" || !record.path.trim()) continue;
    const target = record.path.trim();
    if (isPlaceholderTask(target)) continue;
    const rawName = typeof record.name === "string" ? record.name.trim() : "";
    out.push({
      name: normalizeAttachmentName(rawName || attachmentBaseName(target)),
      path: target,
    });
  }
  return out;
}

/** 路径的末段（不引 node:path —— 本模块被 webview 一起打包）。 */
function attachmentBaseName(target: string): string {
  const trimmed = target.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || "附件";
}

/** 展示名清洗：压空白、去掉控制字符、截断到 80 字。 */
function normalizeAttachmentName(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return "附件";
  return cleaned.length > 80 ? `${cleaned.slice(0, 79)}…` : cleaned;
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

/**
 * 主会话汇报的合并门槛：所有子会话都已进入终态。
 *
 * 主会话只在**全部**子会话结束后收到一次合并汇报 —— 中途的 blocked /
 * ready 只更新看板，否则 N 个子会话会灌出 N 条互相打断的汇报，主会话也
 * 没机会给出完整结论。空列表没有可汇报的内容。
 */
export function allSuperSessionsSettled(sessions: readonly SuperSessionUi[]): boolean {
  return sessions.length > 0 && sessions.every((s) => isTerminalSuperStatus(s.status));
}

/** 一条待转述的子会话汇报。 */
export interface SuperReportEntry {
  session: SuperSessionUi;
  report: SuperReport;
}

/**
 * 主会话合并汇报的缓冲区。
 *
 * 同一子会话只保留**最后一条**汇报：中途的 blocked（等用户回答）会被随后
 * 的 ready 覆盖，合并汇报里不该出现互相矛盾的中间状态。缓冲区里的条目
 * 只有在全部子会话都进入终态后才被取走 —— 否则继续积累。
 */
export class SuperReportBuffer {
  private readonly pending = new Map<string, SuperReportEntry>();

  add(entries: readonly SuperReportEntry[]): void {
    for (const entry of entries) this.pending.set(entry.session.id, entry);
  }

  /**
   * 全部子会话都已进入终态时取走并清空缓冲区；否则返回 null（继续积累）。
   * 空缓冲区不产出批次（没有东西可汇报）。
   */
  takeSettled(sessions: readonly SuperSessionUi[]): SuperReportEntry[] | null {
    if (this.pending.size === 0 || !allSuperSessionsSettled(sessions)) return null;
    const batch = [...this.pending.values()];
    this.pending.clear();
    return batch;
  }

  clear(): void {
    this.pending.clear();
  }
}

/**
 * 看板顶部的计数摘要。
 *
 * `cancelled` 单独计数、不计入 `failed`：用户主动停止（或面板关闭时被终止）
 * 不是失败，把它染成红色「未成功」会让人误以为子会话出了故障。
 */
export function summarizeSuperSessions(sessions: readonly SuperSessionUi[]): {
  total: number;
  running: number;
  awaiting: number;
  done: number;
  /** 真失败：提示词报错 / 内核崩溃 / 进程意外退出。 */
  failed: number;
  /** 用户中断。 */
  cancelled: number;
} {
  let running = 0;
  let awaiting = 0;
  let done = 0;
  let failed = 0;
  let cancelled = 0;
  for (const s of sessions) {
    if (s.status === "preparing" || s.status === "running") running++;
    else if (s.status === "awaiting_input") awaiting++;
    else if (s.status === "completed") done++;
    else if (s.status === "failed") failed++;
    else if (s.status === "cancelled") cancelled++;
  }
  return { total: sessions.length, running, awaiting, done, failed, cancelled };
}

// ---------------------------------------------------------------------------
// 看板分组（排序 + 折叠）
// ---------------------------------------------------------------------------

/**
 * 看板分组结果。
 *
 * `visible` 是逐行展开的子会话（已排序）；`folded` 是收成一行历史的那些 ——
 * 已完成且改动已自动合并，看板上再没有可执行动作（合并按钮本来就是灰的）。
 */
export interface SuperBoardGroups {
  visible: SuperSessionUi[];
  folded: SuperSessionUi[];
}

/**
 * 是否是「已完成且改动已自动合并」的子会话 —— 看板把它折叠起来。
 *
 * 只认 `merged`：`pr_created`（改动在 PR 里）与 `skipped` / `conflict` /
 * `failed`（改动还留在分支上）都还需要人看一眼，不该藏起来。
 */
export function isSuperSessionMerged(session: SuperSessionUi): boolean {
  return session.status === "completed" && session.integration?.state === "merged";
}

/**
 * 排序权重（越小越靠前）。
 *
 *  - 0 等用户应答：只有人在等它，别的都在自己跑。
 *  - 1 进行中（准备中 / 运行中 / 排队中）。
 *  - 2 失败 / 被中断：还能重试，需要人看一眼。
 *  - 3 已完成但改动还没落地（未自动合并 / 合并冲突 / 集成失败 / 没有集成记录）。
 *  - 4 已完成且改动已自动合并 —— 纯历史，折叠到末尾。
 */
function superBoardRank(session: SuperSessionUi): number {
  if (session.status === "awaiting_input") return 0;
  if (session.status === "preparing" || session.status === "running") return 1;
  if (session.status === "failed" || session.status === "cancelled") return 2;
  if (isSuperSessionMerged(session)) return 4;
  return 3;
}

/**
 * 看板排序 + 折叠分组（纯逻辑）。
 *
 * 同一权重内按创建时间升序（派发顺序），再按 id 兜底 —— 排序是稳定的，
 * 状态一变不会让整列卡片跳来跳去。
 */
export function groupSuperSessionsForBoard(sessions: readonly SuperSessionUi[]): SuperBoardGroups {
  const visible: SuperSessionUi[] = [];
  const folded: SuperSessionUi[] = [];
  for (const session of sessions) {
    if (isSuperSessionMerged(session)) folded.push(session);
    else visible.push(session);
  }
  const byRank = (a: SuperSessionUi, b: SuperSessionUi): number =>
    superBoardRank(a) - superBoardRank(b) ||
    a.createdAt - b.createdAt ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  visible.sort(byRank);
  folded.sort(byRank);
  return { visible, folded };
}

// ---------------------------------------------------------------------------
// 看板摘要（每轮注入主会话的感知层）
// ---------------------------------------------------------------------------

/**
 * 摘要的字符预算。它在**每一轮**主会话请求里出现，必须可控：超预算时从尾部
 * 丢弃条目并明确注明省略了几个，绝不把半截句子喂给模型。
 */
export const SUPER_DIGEST_MAX_CHARS = 4000;

const SUPER_STATUS_LABEL: Record<SuperStatus, string> = {
  preparing: "准备中",
  running: "运行中",
  awaiting_input: "等待用户处理",
  completed: "已完成",
  failed: "失败",
  cancelled: "已中断",
};

/** 压成一行并截断（看板摘要里每条信息只占一行，避免 JSON 式嵌套）。 */
function truncateInline(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 子会话一行摘要（`buildSuperDigest` 的内部构件，导出供测试断言）。 */
export function describeSuperSessionLine(session: SuperSessionUi): string {
  const status = `${SUPER_STATUS_LABEL[session.status]}${
    session.queued && session.status === "preparing" ? "（排队中）" : ""
  }${(session.attempts ?? 1) > 1 ? `（第 ${session.attempts} 次）` : ""}`;
  const parts = [`- ${session.id}「${session.title}」${status}`];
  if (session.isolation.branch) parts.push(`分支 ${session.isolation.branch}`);
  if (session.status === "awaiting_input" && session.pending) {
    parts.push(`待答提问（请求 ${session.pending.requestId}）：${truncateInline(describePending(session.pending), 160)}`);
  } else if (session.status === "failed") {
    parts.push(`失败原因：${truncateInline(session.error ?? "未知", 160)}`);
  } else if (session.summary) {
    parts.push(`摘要：${truncateInline(session.summary, 160)}`);
  }
  if (session.integration) {
    parts.push(
      `改动去向：${superIntegrationLabel(session.integration)}${
        session.integration.detail ? `（${truncateInline(session.integration.detail, 120)}）` : ""
      }${session.integration.url ? ` ${session.integration.url}` : ""}`,
    );
  }
  return parts.join("｜");
}

const SUPER_DIGEST_FOOTER = [
  "",
  "可管理上述子会话：输出 ```super-agent-actions 代码块，正文为 {\"actions\":[...]}；",
  "动作 retry（重试失败/中断，复用原工作目录）、cancel（停止运行中）、answer（回答待答提问）、cleanup（清理工作目录）。",
  "合并由宿主按集成模式自动完成（默认 merge，可能改为 PR）：「改动去向」显示已自动合并就不要重复合并；",
  "只有显示分支被保留（未自动合并 / 合并冲突 / 没有 gh CLI）时，才自己执行 git merge --no-ff <分支名>（分支名见上面每一行），需要解决冲突就按代码判断。",
  "answer 的 answers 以问题 header 为键：单选给字符串，多选给字符串数组。sessionId 必须逐字使用上面的 id。",
].join("\n");

/**
 * 主会话每轮看到的结构化看板快照。
 *
 * 这是「主会话管理子会话」的感知层：没有它，主会话派发完就与子会话失联，
 * 只能靠用户转述。内容刻意做成逐行结构化文本 —— id 可被管理动作逐字引用，
 * 摘要按字符预算截断，保证每轮的固定成本可控。
 *
 * **空看板也必须带 `[子会话看板]` 标记**：系统提示用「输入里有没有这块看板」
 * 来区分主会话与子会话（没有 = 子会话 = 忽略编排指令，只做自己的任务）。
 * 首轮还没有任何子会话，若这里返回空串，主会话就会被误判成子会话而自己
 * 动手干活 —— 委派根本没机会发生，模型还「看起来一切正常」。
 */
export function buildSuperDigest(sessions: readonly SuperSessionUi[]): string {
  if (sessions.length === 0) {
    return "[子会话看板]（宿主自动注入的实时状态，不是用户发言。当前没有子会话。）";
  }
  const counts = summarizeSuperSessions(sessions);
  const header =
    `[子会话看板]（宿主自动注入的实时状态，不是用户发言。共 ${counts.total} 个：` +
    `进行中 ${counts.running}、待处理 ${counts.awaiting}、已完成 ${counts.done}、` +
    `失败 ${counts.failed}、已中断 ${counts.cancelled}）`;
  const lines = sessions.map((session) => describeSuperSessionLine(session));
  const omittedNote = (count: number): string => `…（其余 ${count} 个子会话因预算省略，可用动作前先请用户确认）`;
  const render = (kept: readonly string[], omitted: number): string =>
    [
      header,
      ...kept,
      ...(omitted > 0 ? [omittedNote(omitted)] : []),
    ].join("\n") + SUPER_DIGEST_FOOTER;

  let kept = lines;
  while (kept.length > 1 && render(kept, lines.length - kept.length).length > SUPER_DIGEST_MAX_CHARS) {
    kept = kept.slice(0, -1);
  }
  return render(kept, lines.length - kept.length);
}

// ---------------------------------------------------------------------------
// 管理动作协议（super-agent-actions）
// ---------------------------------------------------------------------------

/** 一个动作块里最多执行多少个动作（防止一次输出引发动作风暴）。 */
export const MAX_SUPER_ACTIONS = 20;

export type SuperAction =
  | { action: "retry"; sessionId: string }
  | { action: "cancel"; sessionId: string }
  | {
      action: "cleanup";
      sessionId: string;
      /** 显式保留分支（默认：分支上有未合并提交时宿主自己也会保留）。 */
      keepBranch?: boolean;
    }
  | { action: "answer"; sessionId: string; answers: Record<string, string | string[]> };

export interface SuperActionScan {
  /** 解析成功的动作，按输出顺序（执行也按这个顺序）。 */
  actions: SuperAction[];
  /** 解析失败的块正文（宿主据此提示用户，不静默吞掉）。 */
  invalidBlocks: string[];
  /** 扫描结束位置（消费偏移，同一段文本不会被执行两次）。 */
  end: number;
}

/** 动作块的开栏标记（必须独占一行）。 */
const ACTION_FENCE_OPEN = /^```super-agent-actions[ \t]*$/;

/**
 * 从主 Agent 的回复文本里扫出管理动作块。
 *
 * 与委派指令同构：逐块解析、未闭合就停在开栏处等待后续 chunk、解析失败只
 * 记不入执行。刻意**静默忽略**「占位符 id」（模型把协议示例原样抄回来）：
 * 这种块不是错误，不该给用户弹警告。
 */
export function extractSuperActions(text: string, fromOffset = 0): SuperActionScan {
  const actions: SuperAction[] = [];
  const invalidBlocks: string[] = [];
  let end = fromOffset;
  let cursor = fromOffset;

  while (cursor < text.length) {
    const open = findFence(text, cursor, ACTION_FENCE_OPEN);
    if (!open) break;
    const close = findFence(text, open.bodyStart, FENCE_CLOSE);
    if (!close) {
      // 还没闭合（流式中间态）—— 等后续 chunk 补齐，不能提前执行半截动作。
      end = open.lineStart;
      break;
    }
    const body = text.slice(open.bodyStart, close.lineStart).trim();
    const parsed = parseActionBody(body);
    if (parsed === null) invalidBlocks.push(body);
    else actions.push(...parsed);
    cursor = close.lineEnd;
    end = close.lineEnd;
  }

  return { actions: actions.slice(0, MAX_SUPER_ACTIONS), invalidBlocks, end };
}

/** 解析动作块正文。null = 格式非法（要提示），[] = 合法但无可执行动作（静默）。 */
function parseActionBody(body: string): SuperAction[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const raw = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.actions)
      ? parsed.actions
      : null;
  if (!raw) return null;

  const out: SuperAction[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const action = typeof entry.action === "string" ? entry.action.trim() : "";
    const sessionId = typeof entry.sessionId === "string" ? entry.sessionId.trim() : "";
    // 占位符（`<id>` 之类）是文档示例被回显 —— 不是错误，静默跳过。
    if (!sessionId || isPlaceholderTask(sessionId)) continue;
    switch (action) {
      case "retry":
      case "cancel":
        out.push({ action, sessionId });
        break;
      case "cleanup":
        out.push(entry.keepBranch === true ? { action, sessionId, keepBranch: true } : { action, sessionId });
        break;
      case "answer": {
        const answers = parseActionAnswers(entry.answers);
        if (answers) out.push({ action, sessionId, answers });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function parseActionAnswers(raw: unknown): Record<string, string | string[]> | null {
  if (!isRecord(raw)) return null;
  const answers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = key.trim();
    if (!name) continue;
    if (typeof value === "string") answers[name] = value;
    else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      answers[name] = value as string[];
    }
  }
  return Object.keys(answers).length > 0 ? answers : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
 * 子会话最终状态注记的生成提示词。
 *
 * 由宿主旁路直连调用（不是主会话的一轮），产物以**系统注记**呈现给用户，
 * 因此措辞不能自称主会话、也不能要求它「继续对话」——只做客观转述。
 * 宿主只在 `allSuperSessionsSettled` 之后调用它，把这一批子会话的最终
 * 汇报合成一条，避免 N 个子会话把主会话灌爆（dsh 的 relay 保序 + 合并）。
 */
export function buildSuperReportPrompt(entries: SuperReportEntry[]): string {
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
    "以下是宿主观察到的子会话最终状态（不是用户发言，也不是你之前说过的话）。当前这批子会话都已结束。",
    ...lines,
    "",
    "请先自行处理这些结果：判断每个子会话是否达成目标、改动去向（自动合并 / PR / 保留分支），以及是否还有遗留问题。不要逐条打断用户。",
    "只有在你无法判断、或确实需要用户决策时，才提出那一个具体问题；其余情况不要提问。",
    "最后向用户做一次完整汇报：每个子会话做了什么、结论、改动去向、失败或遗留的问题。不要编造上报里没有的结果，也不要声称自己执行过这些改动。",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 「让智能体合并」的请求文本
// ---------------------------------------------------------------------------

/**
 * 交给主会话智能体的合并请求文本。
 *
 * 两条触发路径共用同一段执行步骤，**开头措辞不同**：
 *  - 自动（`auto: true`）：宿主在子会话完成后发现改动没能自动合并，于是自动
 *    请智能体合并 —— 这时不能说「用户在看板点击了」（用户并没有点）。
 *  - 手动：用户在看板上点了「让智能体合并」。
 *
 * 合并不再由宿主机械执行 `git merge`：冲突需要读懂代码，宿主只会把仓库留在
 * 冲突态（或原样放弃并让用户去终端里手工收拾）。这里把分支、工作目录与边界
 * 写给主智能体，让它用自己的工具完成合并、解决冲突并总结 —— 动手的是智能体。
 *
 * 提示词刻意写明「不要只给建议」「不要推送 / 删分支 / 切分支」：这是对一条
 * 执行类请求的边界声明，不是让模型自由发挥的任务。
 */
export function buildSuperMergeRequestPrompt(
  session: SuperSessionUi,
  options?: { auto?: boolean; reason?: string },
): string {
  const branch = session.isolation.branch ?? "";
  const reason = options?.reason?.trim();
  const lead = options?.auto
    ? `子会话「${session.title}」的改动没能自动合并到当前分支${reason ? `（${reason}）` : ""}。请你自己把它的分支 ${branch} 合并到当前分支，不要只给建议、也不要让我手动执行。`
    : `用户在看板点击了「让智能体合并」。请你自己把子会话「${session.title}」的分支 ${branch} 合并到当前分支，不要只给建议、也不要让我手动执行。`;
  return [
    "[子会话合并请求]",
    lead,
    `该子会话的工作目录：${session.isolation.path}（分支上的改动已经提交）。`,
    "步骤：",
    "1. 先跑 `git status` 确认主工作区状态；",
    `2. 执行 \`git merge --no-ff ${branch}\`（保留合并提交）；`,
    "3. 若出现冲突，逐个阅读冲突文件并自行解决，然后完成这次合并提交；无法安全解决时停下来如实说明，不要留下未完成的合并；",
    "4. 合并后用 `git log --oneline -3` 与 `git status` 确认结果；",
    "5. 不要推送、不要删除分支、不要切换到其它分支。最后用一两句话总结这次合并带入了哪些改动。",
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

