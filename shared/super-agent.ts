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

/** 同时运行的子会话数量默认值（设置项 `iflow.superAgent.maxConcurrent`）。 */
export const DEFAULT_MAX_CONCURRENT_SUPER_SESSIONS = 5;
/** 可调范围下限：至少允许一个子会话，0 会把池子彻底卡死。 */
export const MIN_CONCURRENT_SUPER_SESSIONS = 1;
/** 可调范围上限：再多孩子会话同时跑会把本机与网关一起压垮。 */
export const MAX_CONCURRENT_SUPER_SESSIONS = 20;

/**
 * 把任意来源的并发上限收敛成合法值。
 *
 * 设置可能来自面板输入、手改 settings.json 或旧版本残留：非有限数
 * （NaN / Infinity / 字符串等运行时脏值）回落到默认 5，其余截断取整后
 * 夹到 1..20 —— 「超出上限的派发进 FIFO 排队（不拒绝）」这个语义要求上限
 * 恒为正整数，0 或 Infinity 都会让它失真。
 */
export function clampMaxConcurrentSuperSessions(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_CONCURRENT_SUPER_SESSIONS;
  return Math.min(
    MAX_CONCURRENT_SUPER_SESSIONS,
    Math.max(MIN_CONCURRENT_SUPER_SESSIONS, Math.trunc(value)),
  );
}

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
  | "directory"
  /**
   * 主仓工作区：没有 worktree 隔离，子会话直接在主仓根目录里干活。
   *
   * 合并子会话必须落在这一档：合并只能在目标分支所在的工作区发生 ——
   * 在子会话自己的 worktree 里 merge 并不会把改动并进主仓当前分支。
   * 代价是没有版本隔离（同一个工作区同时只能有一个这种子会话在跑），
   * 所以它的任务书必须把边界写死。
   */
  | "repo";

export interface SuperIsolation {
  kind: SuperIsolationKind;
  /**
   * 子会话的工作目录（worktree 路径、独立目录，或主仓根）。
   *
   * `repo` 这一档的 path 是主仓根：它不是隔离产物，清理时不能删。
   */
  path: string;
  /** git 分支名（仅 worktree；`repo` 档没有自己的分支）。 */
  branch?: string;
  /** worktree 的起点 ref（仅 worktree）。 */
  baseRef?: string;
  /**
   * worktree 与本地分支已随合并成功清理；`path` 仅用于追溯，磁盘上已不存在。
   *
   * 记录（分支名 / 路径 / 集成结果）刻意保留：看板要能说清「改动去了哪里」，
   * 而重复清理必须幂等 —— 看到这个标记就跳过磁盘操作，不能拿一条已经不存在的
   * 路径去删。
   */
  released?: boolean;
  /** 隔离强度的诚实说明（降级时必填）—— 面向用户（中文），只出现在看板气泡里。 */
  note?: string;
  /**
   * 降级原因（面向模型，英文）—— 进子会话的委派提示词。
   *
   * 与 note 分开：`note` 是给用户看的中文说明，`degradeReason` 是模型读到的
   * 事实（worktree 创建失败的 git 真实报错、非 git 仓库等）。委派提示词整体是
   * 英文的（子会话跑的是同一份英文系统提示），所以这里不能塞中文 note。
   */
  degradeReason?: string;
}

/**
 * 隔离种类的看板标签（如实说明隔离强度，不伪造分支）。
 *
 * 「repo」档必须说成「主仓工作区（无隔离）」：这类子会话跑在主仓工作区里，
 * 没有自己的分支 —— 显示一个不存在的分支名，看板上就会指向一个谁也找不到的
 * 分支。worktree 档的分支名由看板单独显示，这里只说隔离方式。
 */
export function superIsolationLabel(isolation: SuperIsolation): string {
  switch (isolation.kind) {
    case "git_worktree":
      return "独立 worktree";
    case "directory":
      return "仅目录隔离";
    case "repo":
      return "主仓工作区（无隔离）";
  }
}

/**
 * 落盘 / 恢复前的隔离信息归一。
 *
 * 「repo」档没有自己的分支（它跑在主仓当前分支上）：归档里若带上了分支名
 * （手改过的记录、旧版本残留），一律丢掉 —— 看板上显示一个并不存在的分支，
 * 比什么都不显示更糟。
 */
function normalizeIsolation(isolation: SuperIsolation): SuperIsolation {
  if (isolation.kind !== "repo") return isolation;
  const normalized: SuperIsolation = { kind: "repo", path: isolation.path };
  if (isolation.note) normalized.note = isolation.note;
  if (isolation.degradeReason) normalized.degradeReason = isolation.degradeReason;
  return normalized;
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
  /**
   * 派发这个子会话的**主会话** id。
   *
   * 子会话是主会话的产物，两者必须成对：主会话 A 派发的子会话在主会话 B
   * 的看板上出现是错的（分支、汇报、重试都归 A 所有）。宿主落盘时按它分文件，
   * 恢复主会话时按它取回 —— 这条字段就是「恢复历史会话时子会话被正确恢复」
   * 的归属依据。
   */
  mainSessionId?: string;
  /**
   * true = 这条记录是从磁盘恢复出来的历史子会话。
   *
   * 扩展重启后子会话的 CLI 进程已经随宿主一起没了 —— 它只剩「分支与工作目录
   * 还在」这一件事实。恢复出来的记录必须如实标成历史：不能再重试（没有进程
   * 可重启），但仍然可以清理工作目录 / 让智能体合并分支（分支确实还在 git 里）。
   */
  restored?: boolean;
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
// 归档（重启后恢复子会话）
// ---------------------------------------------------------------------------

/**
 * 落盘的子会话记录（重启后恢复看板用）。
 *
 * 只存「重启后仍然成立」的事实：它属于哪个主会话、做了什么、在哪个分支上、
 * 结束状态与汇报历史。**刻意不存**运行期字段 —— `pending`（宿主要回答的提问
 * 随进程一起没了）、`progress`（实时进度尾）、`cliSessionId`（那个 ACP 会话
 * 已经不存在了）。
 */
export interface PersistedSuperSession {
  id: string;
  title: string;
  task: string;
  status: SuperStatus;
  /** 派发它的主会话 id —— 恢复时按它归属。 */
  mainSessionId?: string;
  isolation: SuperIsolation;
  model?: string;
  attempts?: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  endedAt?: number;
  summary?: string;
  error?: string;
  tokens?: SuperTokenUsage;
  integration?: SuperIntegration;
  reports: SuperReport[];
}

/** 活着的子会话 → 落盘记录（剥掉运行期字段）。 */
export function toPersistedSuperSession(session: SuperSessionUi): PersistedSuperSession {
  return {
    id: session.id,
    title: session.title,
    task: session.task,
    status: session.status,
    mainSessionId: session.mainSessionId,
    isolation: normalizeIsolation(session.isolation),
    model: session.model,
    attempts: session.attempts,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    summary: session.summary,
    error: session.error,
    tokens: session.tokens,
    integration: session.integration,
    reports: session.reports,
  };
}

/**
 * 落盘记录 → 恢复出来的子会话。
 *
 * 恢复必须**如实**：进程已经没了，所以任何非终态（准备中 / 运行中 / 等你
 * 处理）都归一成「已中断」—— 一个永远停在「运行中」的子会话会让主会话的
 * 汇报永远等不到「全部结束」，也会让看板谎报进度。分支与工作目录照旧保留：
 * 它们在磁盘上还在，清理与合并仍然可用。
 */
export function fromPersistedSuperSession(record: PersistedSuperSession): SuperSessionUi {
  const terminal = isTerminalSuperStatus(record.status);
  return {
    id: record.id,
    title: record.title,
    task: record.task,
    status: terminal ? record.status : "cancelled",
    mainSessionId: record.mainSessionId,
    restored: true,
    isolation: normalizeIsolation(record.isolation),
    model: record.model,
    attempts: record.attempts,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt ?? (terminal ? undefined : record.updatedAt),
    summary: record.summary,
    error: record.error,
    tokens: record.tokens,
    integration: record.integration,
    reports: record.reports,
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

/** 一个解析失败的委派指令块。 */
export interface SuperInvalidBlock {
  /** 块正文原文（宿主只取长度提示用户，不把整段回灌进 toast）。 */
  body: string;
  /** 失败原因（中文短语，直接进 toast —— 只报「无法解析」等于没报）。 */
  reason: string;
}

/**
 * 围栏还没收起时的续扫锚点。
 *
 * 流式输出里一个块会横跨几十个 chunk，宿主每来一段就重扫一次整段文本；长任务
 * 书（上万字符）加上未闭合的等待期，重扫是平方级的浪费。把「开栏在哪、正文
 * 已经找到哪」带回去，下次就能从断点续扫。
 */
export interface SuperPendingFence {
  /** 开栏行的行首偏移。 */
  lineStart: number;
  /** 已经找过收栏（但没找到）的正文位置 —— 下次从这里继续往后找。 */
  scannedTo: number;
}

export interface SuperDirectiveScan {
  /** 解析成功的指令块，每个块一组任务。 */
  blocks: SuperTaskSpec[][];
  /** 解析失败的块（宿主据此提示用户，不静默吞掉）。 */
  invalidBlocks: SuperInvalidBlock[];
  /**
   * 扫描结束位置（消费偏移）。调用方把它当作下一轮的起点 —— 已消费的块不会
   * 被二次派发，即使同一段文本在后续 chunk 里再次出现。
   */
  end: number;
  /** 有围栏未闭合时的续扫锚点（宿主把它原样带进下一次扫描）。 */
  pendingOpen?: SuperPendingFence;
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
export function extractSuperDirectives(
  text: string,
  fromOffset = 0,
  pending?: SuperPendingFence,
): SuperDirectiveScan {
  const blocks: SuperTaskSpec[][] = [];
  const invalidBlocks: SuperInvalidBlock[] = [];
  let end = fromOffset;
  let pendingOpen: SuperPendingFence | undefined;

  let cursor = fromOffset;
  // 上一轮停在未闭合的开栏处时，宿主会把锚点带回来：从那里续扫，不再把已经
  // 确认不含指令的前缀（长会话里可能上百 KB）重扫一遍。
  let resume = pending && pending.lineStart >= fromOffset ? pending : undefined;
  let fenceUnclosed = false;
  while (cursor < text.length) {
    const open = findFence(text, resume ? resume.lineStart : cursor, FENCE_OPEN);
    const resumeScannedTo = resume && open && open.lineStart === resume.lineStart ? resume.scannedTo : 0;
    resume = undefined;
    if (!open) break;
    const resolved = resolveSuperDirectiveBlock(text, open, {
      language: "super-agent",
      scannedTo: resumeScannedTo,
    });
    if (resolved.kind === "unclosed") {
      // 还没闭合（流式中间态）—— 停在这里，等后续 chunk 补齐。正文里的代码
      // 围栏不会让它提前结束：收栏靠 JSON 结构定位，见 resolveSuperDirectiveBlock。
      end = open.lineStart;
      pendingOpen = { lineStart: open.lineStart, scannedTo: resolved.scannedTo };
      fenceUnclosed = true;
      break;
    }
    const parsed = parseDirectiveBody(resolved.body);
    if (parsed.ok) blocks.push(parsed.tasks);
    else if (resolved.body) invalidBlocks.push({ body: resolved.body, reason: parsed.reason });
    cursor = resolved.closeEnd;
    end = resolved.closeEnd;
  }

  // 工具调用式载荷：只在围栏扫描没吃掉的区域里找，否则同一个 JSON 会被
  // 派发两次（围栏路径先走，已经消费过的区域不会进兜底扫描）。
  // 围栏未闭合时不做兜底 —— 那段文本归围栏路径管（等收栏再解析），
  // 否则「载荷已完整但围栏还没收栏」的流式中间态会被提前派发。
  if (!fenceUnclosed) {
    for (const match of findToolStylePayloads(text, Math.max(fromOffset, end))) {
      if (match.tasks) blocks.push(match.tasks);
      else invalidBlocks.push({ body: match.body, reason: "工具调用式载荷里的任务字段非法" });
      if (match.end > end) end = match.end;
    }
  }

  return { blocks, invalidBlocks, end, ...(pendingOpen ? { pendingOpen } : {}) };
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
  /** 标记偏移（渲染侧据此把包裹标记一起纳入卡片）。 */
  marker: number;
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
      out.push({ tasks: tasks.tasks, body: text.slice(start, close + 1), marker, start, end: close + 1 });
      searchFrom = close + 1;
      continue;
    }
    if (tasks.looksLikeDelegation) {
      // 确实是委派载荷但内容非法 —— 交给宿主提示用户，而不是静默丢弃。
      out.push({ tasks: null, body: text.slice(start, close + 1), marker, start, end: close + 1 });
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

/** 是否是 JSON 里的空白。 */
function isJsonSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/** JSON 字符串之后允许出现的结构字符。 */
function isJsonStructuralChar(ch: string): boolean {
  return ch === "," || ch === "}" || ch === "]" || ch === ":";
}

/**
 * 判断 `text[index]` 处的 `"` 是不是「字符串真正的收尾」。
 *
 * 模型写长任务书时经常在正文里放**未转义的 ASCII 引号**（实测 2026-11-12：
 * 委派块因此既派发不了、也退化成一堵 JSON 墙）。朴素的「遇到引号就出串」会把
 * 结构读歪；真收尾的引号后面必然跟着结构字符（`,` `}` `]` `:`）或空白后跟结构
 * 字符 —— 合法 JSON 里字符串内部的引号必然已转义，不会满足这个条件。于是裸引号
 * 可以被安全地留在正文里。
 *
 * 文本用尽时返回 false：字符串还没收尾 —— 那是流式中间态，不是「刚好写完」。
 */
function isJsonStringTerminator(text: string, index: number, limit: number): boolean {
  let i = index + 1;
  while (i < limit && isJsonSpace(text.charAt(i))) i++;
  if (i >= limit) return false;
  return isJsonStructuralChar(text.charAt(i));
}

/** JSON 结构扫描的状态。 */
type JsonStructureStatus =
  /** 括号配对、字符串闭合 → 载荷到此结束。 */
  | "complete"
  /** 文本用尽时字符串还开着 → 载荷可能还在写（流式中间态）。 */
  | "unterminated"
  /** 字符串都闭合了但括号没配平 → 载荷写坏了。 */
  | "unbalanced"
  /** 括号类型对不上 → 载荷写坏了。 */
  | "mismatch"
  /** 根本不是 JSON（散文前缀之类）。 */
  | "notJson";

interface JsonStructure {
  status: JsonStructureStatus;
  /** `complete` 时的结束偏移（含）。 */
  end: number;
}

/**
 * 扫描一个 JSON 值的结构，并区分几种「不可用」。
 *
 * 关键在于把「载荷还在写」和「载荷写坏了」分开 —— 前者要等下一段，后者要立刻
 * 报非法（旧实现两者都当成「还在写」，于是坏载荷既派发不了、也不报错，转录那边
 * 还会退化成一堵 JSON 墙）。
 */
function scanJsonStructure(text: string, start: number, limit: number): JsonStructure {
  const open = text.charAt(start);
  if (open !== "{" && open !== "[") return { status: "notJson", end: -1 };
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < limit; i++) {
    const ch = text.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"' && isJsonStringTerminator(text, i, limit)) inString = false;
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
      if (stack.pop() !== expected) return { status: "mismatch", end: -1 };
      if (stack.length === 0) return { status: "complete", end: i };
    }
  }
  return { status: inString ? "unterminated" : "unbalanced", end: -1 };
}

/**
 * 从 `{` / `[` 开始找配对的结束符（跳过字符串字面量与转义）。
 * 找不到返回 -1 —— 流式中间态的半截 JSON。
 */
function matchJsonValue(text: string, start: number): number {
  const scan = scanJsonStructure(text, start, text.length);
  return scan.status === "complete" ? scan.end : -1;
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
  if (direct.ok) return { tasks: direct.tasks, looksLikeDelegation: true };
  const loose = parseJsonLoose(body);
  if (!loose.ok) return { tasks: null, looksLikeDelegation: false };
  const parsed = loose.value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { tasks: null, looksLikeDelegation: false };
  }
  const record = parsed as Record<string, unknown>;
  if ("tasks" in record) return { tasks: null, looksLikeDelegation: true };
  for (const key of ["arguments", "parameters", "input", "args"]) {
    const inner = record[key];
    if (typeof inner !== "object" || inner === null || Array.isArray(inner)) continue;
    const tasks = parseDirectiveBody(JSON.stringify(inner));
    if (tasks.ok) return { tasks: tasks.tasks, looksLikeDelegation: true };
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

/** 正文里的 JSON 结构不可用时最多试几个收栏候选（防病态文本拖死扫描）。 */
const MAX_CLOSE_CANDIDATES = 8;

/**
 * 载荷看起来是 JSON 但迟迟收不全时，从开栏到文本末尾最多容忍多少字符。
 *
 * 不设上限的话，一个括号永远不配对的损坏块会让扫描永久停在「等收栏」，同一
 * 段之后的任何委派指令都不会再被看到；而正常任务的载荷远小于这个尺度，超过
 * 就按损坏块处理（退回候选收口，判非法并消费），保证后续文本仍能继续扫描。
 */
const MAX_UNCLOSED_SPAN = 512 * 1024;

/** 跳过空白，返回第一个非空白字符的偏移（到底返回 -1）。 */
function skipWhitespace(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") return i;
  }
  return -1;
}

/** 解析指令块正文的结果：失败要带原因，宿主才能提示得具体。 */
type DirectiveParse = { ok: true; tasks: SuperTaskSpec[] } | { ok: false; reason: string };

/** 解析指令块正文。 */
function parseDirectiveBody(body: string): DirectiveParse {
  const parsed = parseJsonLoose(body);
  if (!parsed.ok) return { ok: false, reason: "载荷不是合法 JSON" };
  const value = parsed.value;
  const rawTasks = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && Array.isArray((value as { tasks?: unknown }).tasks)
      ? (value as { tasks: unknown[] }).tasks
      : null;
  if (!rawTasks) return { ok: false, reason: "缺少 tasks 数组" };

  const tasks: SuperTaskSpec[] = [];
  for (const entry of rawTasks) {
    if (typeof entry !== "object" || entry === null) return { ok: false, reason: "任务条目不是对象" };
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
  // 一条都派不出去不是「成功但为空」：模型可能只给了标题、或把协议示例原样
  // 抄了回来。宿主需要知道这件事（否则用户只看到「什么都没发生」）。
  if (tasks.length === 0) return { ok: false, reason: "没有可派发的任务（task 为空或全是占位符）" };
  return { ok: true, tasks };
}

/**
 * 宽松解析 JSON：先按原样 parse，失败再修一次。
 *
 * 模型写委派载荷时最常见的三种毛病（都实测出现过）：正文按原始换行铺开而
 * 不给 `\n` 转义（Windows 路径里的 `\P` 之类更会把转义写坏）、尾逗号、
 * 字符串里裸的控制字符。这些都不改变载荷的**语义**，直接判非法会让整次委派
 * 静默失效，所以先做一次保守修补再交给 JSON.parse —— 修不好照样失败，绝不
 * 编造内容。
 */
function parseJsonLoose(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    // 落到下面的修复路径。
  }
  try {
    return { ok: true, value: JSON.parse(repairJson(text)) };
  } catch {
    return { ok: false };
  }
}

/**
 * 修补常见的 JSON 写法问题。只做「保住原文含义」的变换：
 * - 字符串里的原始换行 / 回车 / 制表符 → 转义序列；
 * - 非法的转义（`\P`、`\a`…）→ 转义反斜杠本身，原文照旧可读；
 * - 尾逗号（`,}` / `,]`）→ 丢掉逗号。
 * 引号本身写坏（裸 `"` 截断字符串）不在修复范围内：那已经无法分辨边界。
 */
function repairJson(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (!inString) {
      if (ch === '"') {
        inString = true;
        out += ch;
        continue;
      }
      if (ch === ",") {
        const next = nextNonWhitespace(text, i + 1);
        if (next === "}" || next === "]") continue;
      }
      out += ch;
      continue;
    }
    if (ch === "\\") {
      const next = text.charAt(i + 1);
      if (next === '"' || next === "\\" || next === "/" || next === "b" || next === "f" || next === "n" || next === "r" || next === "t") {
        out += ch + next;
        i++;
        continue;
      }
      if (next === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += `\\u${hex}`;
          i += 5;
          continue;
        }
      }
      out += "\\\\";
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch >= " ") out += ch;
  }
  return out;
}

function nextNonWhitespace(text: string, from: number): string {
  for (let i = from; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") return ch;
  }
  return "";
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
// 协议块的统一解析（宿主派发与转录渲染共用同一份实现）
// ---------------------------------------------------------------------------
//
// 协议块（```super-agent / ```super-agent-actions）是**同一个协议**的两个读者：
// 宿主据此派发 / 执行，转录据此渲染成卡片。两边必须对「块在哪里结束、正文是
// 什么」给出**同一个**答案 —— 否则会出现「宿主已经派发了，转录却把它当普通
// 代码块」（用户看到一堵 JSON 墙，子会话其实已经在跑）或反过来。
//
// 判定链（两侧完全一致）：
//  1. JSON 结构定位收栏（任务书正文里自带的 ``` 不是收栏）；
//  2. 结构不可用时按收栏候选逐个试，取第一个正文「可用」的；
//  3. 「可用」的判定两侧同源（tasks 用 parseDirectiveBody 的同等判定，actions
//     用等价的动作形状校验）—— 判定不同 → 选到的收栏不同 → 边界就不同；
//  4. 载荷确实写坏了（结构不配对 / 散文前缀）时按候选收口并判非法，**不再**
//     无限期等下去（旧实现对 `{` 开头的坏块永远返回「未闭合」，宿主静默吞掉、
//     转录退化成 JSON 墙）；
//  5. 正文还在流式输出中（任务书没收尾）→ 判未闭合，等下一段。

/** 协议块的语言类别：决定正文怎么校验、坏掉时怎么降级。 */
export type SuperDirectiveLang = "tasks" | "actions" | "other";

/** 围栏语言 → 语言类别。 */
function directiveLangOf(language: string): SuperDirectiveLang {
  if (language === "super-agent") return "tasks";
  if (language === "super-agent-actions") return "actions";
  return "other";
}

/** 协议块的开栏信息（宿主与渲染共用同一形状）。 */
export interface SuperDirectiveOpen {
  /** 开栏行的行首偏移。 */
  lineStart: number;
  /** 正文起始偏移（开栏行之后）。 */
  bodyStart: number;
}

/** 协议块的边界判定结果。 */
export type SuperDirectiveResolution =
  | { kind: "closed"; body: string; closeEnd: number }
  | { kind: "unclosed"; scannedTo: number };

/**
 * 正文是否「可用」（宿主与渲染必须同源判定）。
 *
 * tasks 用宿主 `parseDirectiveBody` 的同等判定（能拆出至少一个真任务）；
 * actions 用等价的动作形状校验（能解析出 actions 数组）。两边判定不同 →
 * 两边选到的收栏候选就可能不同 → 转录里会出现「宿主已派发、渲染却是原始协议块」。
 */
function isUsableDirectiveBody(lang: SuperDirectiveLang, body: string): boolean {
  if (lang === "tasks") return parseDirectiveBody(body).ok;
  if (lang === "actions") return parseActionBody(body) !== null;
  return false;
}

/** 收栏候选（正文按候选收栏切分的结果）。 */
interface CloseCandidate {
  body: string;
  closeEnd: number;
}

/**
 * 收栏候选：正文之后最多试 {@link MAX_CLOSE_CANDIDATES} 个收栏。
 *
 * 从开栏往后逐个收栏切分正文 —— 任务书正文里自带的 ``` 会把正文切碎，所以
 * 「第一个收栏」未必是块真正的结尾，用候选逐个试才能找到对的那个。
 */
function collectCloseCandidates(text: string, bodyStart: number): CloseCandidate[] {
  const out: CloseCandidate[] = [];
  let searchFrom = bodyStart;
  for (let attempt = 0; attempt < MAX_CLOSE_CANDIDATES; attempt++) {
    const close = findFence(text, searchFrom, FENCE_CLOSE);
    if (!close) break;
    out.push({ body: text.slice(bodyStart, close.lineStart).trim(), closeEnd: close.lineEnd });
    searchFrom = close.lineEnd;
  }
  return out;
}

/**
 * 当前块正文的活动区域终点：下一个 `super-agent*` 围栏之前。
 *
 * 容错拆分只在这个区域里找任务书 —— 否则模型块之后的散文里出现的
 * `"title"` / `"task"` 字样会被当成下一个任务的字段。
 */
function directiveRegionEnd(text: string, bodyStart: number): number {
  const next = findSuperRenderFence(text, bodyStart);
  return next ? next.lineStart : text.length;
}

/**
 * 定位一个协议块的正文与收栏 —— 宿主派发与转录渲染的唯一入口。
 *
 * 收栏不能取「正文里的第一行 ```」：模型常把多行任务书按原始换行铺开（而不是
 * JSON 的 `\n` 转义），任务书自己就带一段 markdown 代码围栏，那一行会提前截断
 * 载荷、JSON 必然解析失败（实测 2026-11-11：长任务书 / 内嵌围栏 → 整块判非法，
 * 委派静默不生效）。所以先按 JSON 结构定位载荷的真正结束位置，再从那里往后找
 * 第一行收栏 —— 正文里的围栏落在 JSON 内部，天然不会被误当收栏。
 *
 * JSON 结构不可用（散文前缀、括号不配对、字符串里有裸引号把结构读歪）时退回
 * 按收栏候选逐个试，取第一个正文「可用」的；都不可用就按「坏块」处理：取第一
 * 个候选交给调用方报非法 —— **不再**无限期等下去（旧实现对 `{` 开头的坏块永远
 * 返回「未闭合」，宿主那一侧静默吞掉、转录那一侧退化成 JSON 墙）。
 *
 * 唯一的例外是「正文还在流式输出中」（任务书的值没收尾）：那是流式的正常中间态，
 * 判未闭合等下一段（见 `scanTaskBooks` 的 pending 判定）。
 *
 * `scannedTo` 是上一轮已经找过、确认没有收栏的位置：流式输出每来一段就重扫
 * 整段正文是平方级浪费，从断点往后找即可。
 */
export function resolveSuperDirectiveBlock(
  text: string,
  open: SuperDirectiveOpen,
  options: { language: string; scannedTo?: number },
): SuperDirectiveResolution {
  const lang = directiveLangOf(options.language);
  const scannedTo = options.scannedTo ?? 0;
  const regionEnd = directiveRegionEnd(text, open.bodyStart);
  const jsonStart = skipWhitespace(text, open.bodyStart);
  const structure =
    jsonStart === -1 || jsonStart >= regionEnd
      ? { status: "notJson" as const, end: -1 }
      : scanJsonStructure(text, jsonStart, regionEnd);

  if (structure.status === "complete") {
    const close = findFence(text, Math.max(structure.end, scannedTo), FENCE_CLOSE);
    if (!close) return { kind: "unclosed", scannedTo: text.length };
    return { kind: "closed", body: text.slice(open.bodyStart, close.lineStart).trim(), closeEnd: close.lineEnd };
  }

  // 字符串还开着 = 载荷确实还在写（流式的正常中间态）。此刻任务书正文里可能已经
  // 出现独占的 ``` 行 —— 绝不能拿它当收栏收口，否则半截 JSON 被消费掉，后续
  // chunk 补齐的载荷永远扫不回来（宿主静默吞掉、渲染半截卡片闪烁）。
  if (structure.status === "unterminated") {
    // 逃生阀：字符串超长仍不闭合的不是流式中间态，是损坏块 —— 按第一个收栏
    // 收口（沿用 MAX_UNCLOSED_SPAN 的原始语义），避免单个坏块永久停住扫描。
    if (text.length - open.bodyStart > MAX_UNCLOSED_SPAN) {
      const close = findFence(text, open.bodyStart, FENCE_CLOSE);
      if (close) {
        return { kind: "closed", body: text.slice(open.bodyStart, close.lineStart).trim(), closeEnd: close.lineEnd };
      }
    }
    return { kind: "unclosed", scannedTo: text.length };
  }

  // 结构不完整但字符串都闭合了：可能刚好停在某个值之后（流式中间态），也可能
  // 真的写坏了（少括号 / 裸引号把结构读歪）。先按收栏候选找能解析的正文 ——
  // 能解析就说明块是完整的，直接收口。
  const candidates = collectCloseCandidates(text, open.bodyStart);
  for (const candidate of candidates) {
    if (isUsableDirectiveBody(lang, candidate.body)) return { kind: "closed", ...candidate };
  }

  // 候选都不可用：用容错拆分确认载荷是否已经写完 —— 拆出完整任务书且末尾没有
  // 没收尾字段，说明模型写完了，只是 JSON 结构坏了。此时仍要求真有一行收栏，
  // 否则流式中途的暂时不平衡会被误判成结束。
  if (lang === "tasks") {
    // 只在「这个块的正文范围」里拆：第一个收栏候选之前（与交给调用方的坏块
    // 正文同一边界），没有候选才退回到下一个 super-agent 围栏之前。
    const salvageLimit = candidates[0] ? Math.min(candidates[0].closeEnd, regionEnd) : regionEnd;
    const salvaged = scanTaskBooks(text, open.bodyStart, salvageLimit);
    if (salvaged.books.length > 0 && !salvaged.pending) {
      const close = findFence(text, Math.max(salvaged.end, scannedTo), FENCE_CLOSE);
      if (close) {
        return { kind: "closed", body: text.slice(open.bodyStart, close.lineStart).trim(), closeEnd: close.lineEnd };
      }
    }
  }

  if (candidates.length === 0) return { kind: "unclosed", scannedTo: text.length };
  // 明确的坏块（有收栏却怎么写都解析不了）：取第一个候选收口，交给调用方报
  // 「非法块」或降级展示，绝不无限期等下去（旧实现对 `{` 开头的坏块永远返回
  // 「未闭合」—— 宿主静默吞掉、渲染退化成 JSON 墙）。
  return { kind: "closed", ...candidates[0]! };
}

// ---------------------------------------------------------------------------
// 容错拆分（畸形载荷的降级路径）
// ---------------------------------------------------------------------------

/** 容错拆出的一条任务书。 */
interface SalvagedTaskBook {
  title: string;
  task: string;
}

/** 容错扫描的结果。 */
interface TaskBookScan {
  /** 拆出来的任务书（占位符已剔除）。 */
  books: SalvagedTaskBook[];
  /** 末尾还有没收尾的字段 → 载荷可能还在流式输出中。 */
  pending: boolean;
  /** 最后一条任务书的结束偏移（绝对偏移）。 */
  end: number;
}

/** 协议正文里的字段（`"title"` / `"task"`）。 */
interface DirectiveField {
  key: "title" | "task";
  value: string;
  /** 字段值的结束偏移（绝对偏移）。 */
  end: number;
}

/**
 * 找出正文里的一个 `"title"` / `"task"` 字段（值还没读）。
 *
 * 只认 JSON 风格的带引号键 —— 散文里的 `title:` 不算字段（否则模型正文里的
 * 普通文字会被当成任务书）。
 */
function matchDirectiveKey(
  text: string,
  at: number,
  limit: number,
): { key: "title" | "task"; valueStart: number } | null {
  for (const key of ["title", "task"] as const) {
    const token = `"${key}"`;
    if (!text.startsWith(token, at)) continue;
    let i = at + token.length;
    while (i < limit && isJsonSpace(text.charAt(i))) i++;
    if (text.charAt(i) !== ":") continue;
    i++;
    while (i < limit && isJsonSpace(text.charAt(i))) i++;
    return { key, valueStart: i };
  }
  return null;
}

/**
 * 宽容地读一个 JSON 字符串值。
 *
 * 与严格 JSON 的差别只有一处：引号后面必须跟着结构字符（`,` `}` `]` `:`）或文本
 * 结束，才算这个字符串真的收尾；否则它是模型写在正文里的**裸引号**（任务书里
 * 写 `他说："先跑测试"` 是常事），当作正文继续读。这样既能读出完整任务书，
 * 又不会把正文里的裸引号误当成边界。
 *
 * 返回 `terminated: false` 表示值没收尾 —— 载荷还在流式输出中，或已经写坏了。
 */
function readTolerantString(
  text: string,
  start: number,
  limit: number,
): { value: string; end: number; terminated: boolean } | null {
  if (text.charAt(start) !== '"') return null;
  let i = start + 1;
  let value = "";
  while (i < limit) {
    const ch = text.charAt(i);
    if (ch === "\\") {
      const next = text.charAt(i + 1);
      if (next === "") break;
      value += decodeJsonEscape(next);
      i += 2;
      continue;
    }
    if (ch === '"') {
      const next = nextNonWhitespace(text, i + 1);
      if (next === "" || next === "," || next === "}" || next === "]" || next === ":") {
        return { value, end: i + 1, terminated: true };
      }
      value += ch;
      i++;
      continue;
    }
    value += ch;
    i++;
  }
  return { value, end: limit, terminated: false };
}

/** JSON 转义字符 → 原字符。 */
function decodeJsonEscape(ch: string): string {
  switch (ch) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case '"':
      return '"';
    case "\\":
      return "\\";
    case "/":
      return "/";
    default:
      return ch;
  }
}

/**
 * 把字段列表配成任务书。
 *
 * 配对规则（保守，绝不凭空编造内容）：
 *  - 一条任务书 = 一个 `"task"` 的值（标题可以缺，用任务书首行兜底）；
 *  - 标题取**最近**的、且与它之间没有别的任务书的 `"title"`：字段顺序颠倒
 *    （`task` 在前、`title` 在后）也认；
 *  - 正文里出现协议示例 / 占位符任务不算真任务（沿用 isPlaceholderTask）。
 */
function pairTaskBooks(
  fields: DirectiveField[],
): { books: SalvagedTaskBook[]; ends: number[] } {
  const books: SalvagedTaskBook[] = [];
  const ends: number[] = [];
  const usedTitle = new Set<number>();
  for (let f = 0; f < fields.length; f++) {
    const field = fields[f]!;
    if (field.key !== "task") continue;
    const task = field.value.trim();
    if (!task || isPlaceholderTask(task)) continue;
    let title = "";
    let titleIndex = -1;
    for (let j = f - 1; j >= 0; j--) {
      const prev = fields[j]!;
      if (prev.key === "task") break;
      if (prev.key === "title" && !usedTitle.has(j)) {
        title = prev.value.trim();
        titleIndex = j;
        break;
      }
    }
    if (!title) {
      for (let j = f + 1; j < fields.length; j++) {
        const next = fields[j]!;
        if (next.key === "task") break;
        if (next.key === "title") {
          title = next.value.trim();
          titleIndex = j;
          break;
        }
      }
    }
    if (titleIndex >= 0) usedTitle.add(titleIndex);
    const fallback = task.split("\n")[0] ?? "子会话";
    const titleText = title && !isPlaceholderTask(title) ? title : fallback;
    books.push({ title: normalizeSuperTitle(titleText, fallback), task });
    ends.push(titleIndex >= 0 ? Math.max(field.end, fields[titleIndex]!.end) : field.end);
  }
  return { books, ends };
}

/**
 * 在正文里容错扫描任务书。
 *
 * 逐个字段往前读（读完一个值就跳过它 —— 任务书正文里嵌套的协议示例因此不会被
 * 当成新的任务），末尾若还有没收尾的字段，说明载荷可能还在流式输出中。
 */
function scanTaskBooks(text: string, from: number, limit: number): TaskBookScan {
  const fields: DirectiveField[] = [];
  let pending = false;
  let i = from;
  while (i < limit) {
    const key = matchDirectiveKey(text, i, limit);
    if (!key) {
      i += 1;
      continue;
    }
    const read = readTolerantString(text, key.valueStart, limit);
    if (!read || !read.terminated) {
      // 键在、值没到 → 载荷还在写（或已经写坏）。
      pending = true;
      break;
    }
    fields.push({ key: key.key, value: read.value, end: read.end });
    i = read.end;
  }
  const { books, ends } = pairTaskBooks(fields);
  const end = ends.length > 0 ? ends[ends.length - 1]! : from;
  return { books, pending, end };
}

/**
 * 从无法完整解析的载荷正文里容错拆出任务书。
 *
 * 背景（实测 2026-11-12）：模型写委派载荷时常把长任务书按原始换行铺开、在正文里
 * 写裸引号、或者括号不配对 —— 整体 JSON 解析不了，但「哪个是标题、哪个是任务
 * 书」其实一目了然。整块因此既派发不了、又在转录里退化成一堵 JSON 墙。
 *
 * 提取刻意保守：
 *  - 只认**成对出现**的 `"title"` / `"task"` 字段（值的冒号必须在）；
 *  - 缺 title 时用任务书首行兜底，字段顺序颠倒也认；
 *  - 夹杂其它无关字段不影响；
 *  - 占位符任务（模型把协议示例原样抄回来）不算；
 *  - 绝不凭空编造内容：拆不出就返回空数组，调用方按原有的 raw 原因码降级。
 */
export function salvageSuperTasks(body: string): SuperDirectiveTask[] {
  return scanTaskBooks(body, 0, body.length).books.map((book) => ({
    title: book.title,
    task: book.task,
    attachments: [],
  }));
}

// ---------------------------------------------------------------------------
// 汇报文本
// ---------------------------------------------------------------------------

/**
 * 这一批子会话是否**全部**进入终态。
 *
 * 自 2026-11-12 起它**不再**是「向主会话交汇报」的门槛 —— 汇报改成逐个即时
 * 交付（谁先结束谁先汇报，见 {@link SuperReportBuffer.takeSettled}）。它现在
 * 只回答一个事实问题：这一批是不是全部跑完了（看板据此显示「全部结束」）。
 * 空列表没有可汇报的内容。
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
 * 主会话汇报的缓冲区（**逐个即时上报**语义）。
 *
 * 同一子会话只保留**最后一条**汇报：中途的 blocked（等用户回答）会被随后
 * 的 ready 覆盖，汇报里不该出现互相矛盾的中间状态。
 *
 * 取件门槛是**逐个子会话**的：某个子会话一进入终态，它的那条汇报就可以被
 * 取走交给主会话，不必等同一批的其它子会话全部结束。仍在跑的子会话对应的
 * 条目继续留在缓冲里，等它结束再取 —— 于是「谁先结束谁先汇报」，主会话不必
 * 守着最后一个慢子会话。
 */
export class SuperReportBuffer {
  private readonly pending = new Map<string, SuperReportEntry>();

  /**
   * 还没被取走的汇报条数。
   *
   * 非 0 = 「还有汇报欠着主会话」：要么来源子会话还没进终态（条目还得留着），
   * 要么批次已备好但还没投进主会话。宿主用它决定面板要不要呈现忙碌态。
   */
  get size(): number {
    return this.pending.size;
  }

  add(entries: readonly SuperReportEntry[]): void {
    for (const entry of entries) this.pending.set(entry.session.id, entry);
  }

  /**
   * 取走**来源子会话已经终态**的条目（逐个即时上报）。
   *
   * 状态看的是传入的**当前**会话列表（不是条目里的快照）—— 条目是汇报发生
   * 那一刻的副本，可能还停在 blocked / running。
   *
   * 仍在跑的子会话：条目**留在缓冲里**，等它结束后再取（同一个子会话的条目
   * 会被新汇报覆盖，不会重复转述）。来源子会话已经不在列表里（被清理 /
   * 合并后释放）的条目不取也不删 —— 交由 {@link dropMissing} 处理。
   *
   * 无可取时返回 null（继续积累）。
   */
  takeSettled(sessions: readonly SuperSessionUi[]): SuperReportEntry[] | null {
    if (this.pending.size === 0) return null;
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const batch: SuperReportEntry[] = [];
    for (const [id, entry] of [...this.pending]) {
      const session = byId.get(id);
      if (!session) continue; // 来源已消失：交给 dropMissing 清理。
      if (!isTerminalSuperStatus(session.status)) continue; // 还在跑：留在缓冲。
      batch.push(entry);
      this.pending.delete(id);
    }
    return batch.length > 0 ? batch : null;
  }

  /**
   * 丢掉来源子会话已经不存在的条目，返回被丢掉的子会话 id。
   *
   * 子会话被用户清理 / 合并完释放后，它的那条汇报再也没人能接 —— 如实记一
   * 笔然后丢掉，不能让面板永久停在忙碌态。
   */
  dropMissing(sessions: readonly SuperSessionUi[]): string[] {
    if (this.pending.size === 0) return [];
    const liveIds = new Set(sessions.map((session) => session.id));
    const dropped: string[] = [];
    for (const id of [...this.pending.keys()]) {
      if (liveIds.has(id)) continue;
      this.pending.delete(id);
      dropped.push(id);
    }
    return dropped;
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
  // 有分支才报分支；没有分支的子会话（如跑在主仓工作区的合并子会话）如实报
  // 隔离方式 —— 看板不能显示一个并不存在的分支名。
  if (session.isolation.branch) parts.push(`分支 ${session.isolation.branch}`);
  else parts.push(superIsolationLabel(session.isolation));
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
    const resolved = resolveSuperDirectiveBlock(text, open, { language: "super-agent-actions" });
    if (resolved.kind === "unclosed") {
      // 还没闭合（流式中间态）—— 等后续 chunk 补齐，不能提前执行半截动作。
      end = open.lineStart;
      break;
    }
    const parsed = parseActionBody(resolved.body);
    if (parsed === null) invalidBlocks.push(resolved.body);
    else actions.push(...parsed);
    cursor = resolved.closeEnd;
    end = resolved.closeEnd;
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
 * 子会话汇报的提示词（宿主把它作为主会话的一次真实 prompt 发出去）。
 *
 * 不是「旁路注记」：主会话委派完往往本轮就结束了（子会话的寿命比这一轮长），
 * 这条提示词就是**把对话接上**的那一环。所以措辞必须明确：这是同一个任务的
 * 新回合，上一轮结束是正常的，现在应基于这些结果继续动手，而不是等用户再开口。
 *
 * **逐个即时汇报**（2026-11-12）：宿主在每个子会话进入终态时就交一次汇报，
 * 不再等同一批全部结束。`pendingCount` 是「仍在跑的子会话数」—— 它决定
 * 提示词的结尾：还有人在跑时**不能**让主会话现在就向用户做最终完整汇报
 * （后面还会有新的汇报回合，那时才是收尾的时候）。
 */
export function buildSuperReportPrompt(
  entries: SuperReportEntry[],
  options?: { pendingCount?: number },
): string {
  if (entries.length === 0) return "";
  const pendingCount = Math.max(0, options?.pendingCount ?? 0);
  const lines = entries.map(({ session, report }) => {
    const human = report.humanAction ? `\n   需要用户处理：${report.humanAction}` : "";
    const integration = session.integration
      ? `\n   改动去向：${superIntegrationLabel(session.integration)}${
          session.integration.detail ? `（${session.integration.detail}）` : ""
        }${session.integration.url ? ` ${session.integration.url}` : ""}`
      : "";
    return `- 子会话 #${session.id}「${session.title}」${superReportLabel(report.state)}：${report.summary}${human}${integration}`;
  });
  const head = [
    "[子会话状态上报]",
    "以下是宿主观察到的子会话最终状态（不是用户发言，也不是你之前说过的话）。",
    `以下是本批已结束的 ${entries.length} 个子会话的最终状态。`,
    ...lines,
    "",
  ];
  // 还有子会话在跑：这一轮不是收尾 —— 主会话要先把已经结束的结果消化掉，
  // 后续完成的孩子会由宿主继续汇报。
  const pendingNote =
    pendingCount > 0
      ? `另有 ${pendingCount} 个子会话仍在运行，它们结束后宿主会继续汇报 —— 先处理这批结果（复核/后续任务照常派给子会话），不要等它们；此时不要向用户做最终完整汇报。`
      : null;
  // 全部是「被中断」时不能照常催它继续：那是用户主动停的（看板中断 / 面板
  // 关闭），自动把任务重跑一遍会像是没听话。
  const allDropped = entries.every((entry) => entry.report.state === "dropped");
  if (allDropped) {
    return [
      ...head,
      "这些子会话是**被中断**的（用户停止，或面板当时已关闭），不是失败。不要自动重跑它们，也不要假设任务还要继续 —— 先简短说明它们停在哪里、还留下什么，然后问用户是否要继续。",
      ...(pendingNote ? [pendingNote] : []),
    ].join("\n");
  }
  return [
    ...head,
    "**这是同一个任务的新回合。** 上一轮在你派发完子会话后结束是正常的 —— 宿主会在每个子会话结束时把结果交回给你。现在请接着推进，不要停下来等用户再开口。",
    "先读汇报做判断：每个子会话是否达成目标、改动去向（自动合并 / PR / 保留分支），以及是否还有遗留问题 —— 判断只看上报文本就够了，**复核不在本会话跑**。需要复核就把「跑测试 / 类型检查 / 构建并如实汇报真实输出」写成任务派给子会话。",
    "后续步骤一律派给子会话去做（复核任务、修复任务、补做未完成的步骤），不要自己跑命令、不要自己改文件；派发这些任务时直接做，不要只给建议，也不要让用户来催。",
    "只有在你无法判断、或确实需要用户决策时，才提出那一个具体问题；其余情况不要提问。",
    ...(pendingNote
      ? [pendingNote]
      : [
          "最后向用户做一次完整汇报：每个子会话做了什么、结论、改动去向、失败或遗留的问题。不要编造上报里没有的结果，也不要声称自己执行过这些改动。",
        ]),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 「让智能体合并」的请求文本
// ---------------------------------------------------------------------------

/**
 * 「让智能体合并」的任务书文本。
 *
 * **这段文本是写给子会话的，不是写给主会话的**：它会被宿主放进一个
 * `super-agent` 委派块的 task 字段，派给一个专职合并的子会话执行。
 * 主会话只负责派发与汇报，不碰 git。
 *
 * 那个子会话必须能触达**主仓工作区**（隔离种类 `repo`）：合并只能在主仓
 * 工作区发生 —— 在别的 worktree 里 merge 出来的结果落不到主仓当前分支上，
 * 等于白做。这正是 `SuperIsolationKind` 里有 `repo` 这一档的原因。
 *
 * 两条触发路径共用同一段执行步骤，**开头措辞不同**：
 *  - 自动（`auto: true`）：宿主在子会话完成后发现改动没能自动合并，于是自动
 *    请智能体合并 —— 这时不能说「用户在看板点击了」（用户并没有点）。
 *  - 手动：用户在看板上点了「让智能体合并」。
 *
 * 提示词刻意写死边界与安全阀：这是对一条执行类任务的硬约束，不是让模型
 * 自由发挥 —— 不推送、不 rebase、不删分支、不切分支、不碰无关文件；冲突
 * 解决不了就 `git merge --abort`，绝不能把仓库留在半合并状态。
 */
export function buildSuperMergeRequestPrompt(
  session: SuperSessionUi,
  options?: { auto?: boolean; reason?: string },
): string {
  const branch = session.isolation.branch ?? "";
  const reason = options?.reason?.trim();
  if (!branch) {
    // 没有自己的分支就没有可合并的目标 —— 如实说清楚，别让执行者对着
    // 一个空的 `git merge --no-ff` 猜。
    return [
      "[合并任务]",
      `子会话「${session.title}」没有自己的分支（隔离方式：${superIsolationLabel(session.isolation)}），没有可合并的目标。`,
      "不要执行任何 git 命令，也不要改动任何文件 —— 如实汇报「该子会话没有可合并的分支」即可。",
    ].join("\n");
  }
  const lead = options?.auto
    ? `子会话「${session.title}」的改动没能自动合并到主仓当前分支${reason ? `（${reason}）` : ""}。把它的分支 ${branch} 合并到主仓当前分支。`
    : `用户在看板点击了「让智能体合并」：把子会话「${session.title}」的分支 ${branch} 合并到主仓当前分支。`;
  return [
    "[合并任务]",
    lead,
    "工作目录：主仓工作区根目录（你的当前工作目录）—— 合并只能在主仓工作区发生。",
    `分支 ${branch} 上的改动已经提交完毕，不需要切分支，也不需要去子会话的工作目录里操作。`,
    "步骤：",
    "1. 先跑 `git status` 确认主仓工作区状态（有没有未提交的改动、是不是已经在 merge/rebase 中间态）；",
    `2. 执行 \`git merge --no-ff ${branch}\`（保留合并提交）；`,
    "3. 若出现冲突，逐个阅读冲突文件并按代码语义判断双方意图，解决冲突时保留双方的改动，不要丢弃任何一侧的改动，然后完成这次合并提交；",
    "4. 合并后用 `git log --oneline -3` 与 `git status` 确认结果。",
    "硬边界（不要越过）：",
    "- 不要 push、不要 rebase、不要删除分支、不要切换分支；",
    "- 不要改动与本次合并无关的文件；",
    "- 不要动用户尚未提交的其它改动。",
    "安全阀：如果冲突无法可靠解决（读不懂哪一侧是对的，或需要用户决策），执行 `git merge --abort` 撤销这次合并并如实说明原因 —— 绝不能把仓库留在半合并状态。",
    "最后如实汇报：合并 commit（哈希与标题）、被改动的文件清单、遇到的冲突与各自的处理方式；若合并失败，说明失败原因与失败时仓库的状态。",
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

// ---------------------------------------------------------------------------
// 协议块的转录投影（webview 渲染用）
// ---------------------------------------------------------------------------
//
// 主 Agent 把委派 / 管理动作写成 ```super-agent / ```super-agent-actions 围栏，
// 或者写成**工具调用式**载荷（实测各家模型写法不一：`<｜DSML｜tool-super-agent>`、
// `<tool_call>`、以及「`super-agent:` + ```json 围栏」）。宿主侧的扫描派发
// （`extractSuperDirectives` / `extractSuperActions`）与这里的渲染投影是**同一个
// 协议的两个读者**：这里只决定转录里显示成什么，不参与派发，也不改变任何宿主状态。
//
// **两条判定链必须与宿主逐字同源**（围栏走 `resolveSuperDirectiveBlock`，工具调用式
// 走 `findToolStylePayloads`）：只认围栏的渲染侧遇到工具调用式载荷时切不出卡片，
// 于是「宿主已经派发、转录仍是一堵 JSON 墙」（用户实测截图 2026-11-12 —— 看板上有
// 「等待子会话汇报」，转录里却看不到委派卡）。
//
// 流式策略：载荷收全之前不渲染卡片（整段按原样留给 Markdown），收全后才切换成
// 卡片。理由：
// ① 未收全的正文是半截 JSON，此时解析必然失败；若此刻就渲染「原始协议块」
//    卡片，流式期间会反复闪成「解析失败」，比普通代码块更糟；
// ② 宿主同样要等载荷收全才派发 —— 渲染与派发在同一时刻切换，用户看到卡片出现
//    就等于这条指令已经完整；
// ③ 没有「解析中」的临时 UI，未收全时的行为与改动前逐字节一致（普通代码
//    块），失败面最小。代价只是收栏那一瞬间文字从代码块跃变为卡片。

export interface SuperDirectiveTask {
  title: string;
  task: string;
  attachments: string[];
}

export interface SuperDirectiveAction {
  /** 原样动作名（retry / cancel / cleanup / answer / 未知）。 */
  action: string;
  sessionId: string;
  /** `cleanup` 显式要求保留分支。 */
  keepBranch?: boolean;
  /** `answer` 动作携带的回答条数。 */
  answerCount?: number;
}

/** 无法结构化展示时的原因码（文案在 webview 侧翻译，shared 保持语言中立）。 */
export type SuperDirectiveRawReason =
  | "invalid_json"
  | "missing_tasks"
  | "empty_tasks"
  | "missing_actions"
  | "empty_actions"
  | "unknown_language";

export type SuperDirectiveDisplay =
  | {
      kind: "tasks";
      tasks: SuperDirectiveTask[];
      /**
       * 这些任务书是从**无法完整解析**的载荷里容错拆出来的。
       *
       * **容错拆出 ≠ 已派发**：宿主对同一段载荷走的是严格解析（`parseDirectiveBody`），
       * 失败即进 `invalidBlocks` 并提示用户，绝不会据此开启子会话。渲染侧拿到
       * `salvaged: true` 时只能把它当「可读的降级预览」，不要显示成「已派发」。
       */
      salvaged?: boolean;
    }
  | { kind: "actions"; actions: SuperDirectiveAction[] }
  /** 非法 JSON / 未知形状 / 未知语言：卡片只显示语言与长度，不回灌整段原文。 */
  | { kind: "raw"; reason: SuperDirectiveRawReason };

export type SuperDirectiveSegment =
  | { kind: "text"; text: string }
  | {
      kind: "directive";
      /** 围栏语言（`super-agent` / `super-agent-actions` / 同前缀的其它语言）；
       *  工具调用式载荷固定报协议标记 `super-agent`（它没有围栏语言）。 */
      language: string;
      /** 协议块原文：围栏含开栏与收栏行；工具调用式含包裹标记与紧随的收栏行。 */
      raw: string;
      display: SuperDirectiveDisplay;
    };

/** 渲染侧识别的围栏：`super-agent` 及其派生语言（`super-agent-actions` 等）。 */
const SUPER_RENDER_FENCE_OPEN = /^```(super-agent(?:-[A-Za-z0-9_-]+)?)[ \t]*$/;

/**
 * 转录里识别协议块的快速探测串（避免每帧逐行扫描长回答）。
 *
 * 探测的是**协议标记本身**而不是 ` ```super-agent `：工具调用式写法（`<｜DSML｜tool-
 * super-agent>`、`super-agent:` + ```json）没有围栏前缀，只探测围栏串会让整段扫描
 * 被跳过 —— 卡片就永远出不来。扫描本身仍是精确判定，探测只是省掉无标记文本的开销。
 */
const SUPER_RENDER_PROBE = TOOL_STYLE_MARKER;

interface SuperRenderFenceMatch {
  language: string;
  /** 围栏所在行的行首偏移。 */
  lineStart: number;
  /** 围栏行之后的正文起始偏移。 */
  bodyStart: number;
}

/** 找下一个独占一行的 super-agent 系列围栏。 */
function findSuperRenderFence(text: string, from: number): SuperRenderFenceMatch | null {
  let pos = from;
  while (pos <= text.length) {
    let lineEnd = text.indexOf("\n", pos);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(pos, lineEnd).replace(/\r$/, "");
    const match = SUPER_RENDER_FENCE_OPEN.exec(line);
    if (match) {
      return {
        language: match[1] ?? "super-agent",
        lineStart: pos,
        bodyStart: Math.min(lineEnd + 1, text.length),
      };
    }
    if (lineEnd === text.length) return null;
    pos = lineEnd + 1;
  }
  return null;
}

/** 包裹标记里可以连同载荷一起吞掉的字符（不含空白、中文与散文标点）。 */
const WRAPPER_CHAR = /[`<>|｜\-_/A-Za-z0-9]/;

/**
 * 工具调用式载荷的卡片起始偏移：把紧贴标记的包裹标记（`<｜DSML｜tool-`、行首的 ``` ）
 * 一并纳入，否则转录里会留下一截 `<｜DSML｜tool-` 这样的残字。
 *
 * 散文一律留在文本段里 —— 模型写在标记前面的那句话是真给用户读的，不能吞。
 * 「紧贴标记的一串拉丁词」不算包裹（`我会用 super-agent 委派` 里的 `用` 不是标记），
 * 只有以 `<` / ``` 开头、或含 `tool` 的紧邻片段才当包裹处理。
 */
function toolStyleRegionStart(text: string, marker: number): number {
  let i = marker;
  while (i > 0 && WRAPPER_CHAR.test(text.charAt(i - 1))) i--;
  if (i === marker) return marker;
  const prefix = text.slice(i, marker);
  if (prefix.startsWith("<") || prefix.startsWith("`") || prefix.includes("tool")) return i;
  return marker;
}

/**
 * 工具调用式载荷的卡片结束偏移：载荷后面紧跟一行独占的 ``` 收栏（模型把载荷裹在
 * ```json 里）或包裹标记的收尾（`</tool-super-agent>`）时把它一并纳入 —— 留在外面
 * 就是一行孤零零的 ```，Markdown 会拿它去裹后面的正文。
 */
function toolStyleRegionEnd(text: string, payloadEnd: number): number {
  // 载荷与紧随的收栏行之间可能夹着换行（```json 块的结尾就是「}\n```」）。
  let i = payloadEnd;
  while (i < text.length && (text.charAt(i) === "\n" || text.charAt(i) === "\r")) i++;
  const lineEnd = text.indexOf("\n", i);
  const line = text.slice(i, lineEnd === -1 ? text.length : lineEnd).replace(/\r$/, "");
  if (FENCE_CLOSE.test(line) || /^<\/?[A-Za-z0-9_|｜\-/]+>$/.test(line)) {
    return lineEnd === -1 ? text.length : lineEnd + 1;
  }
  return payloadEnd;
}

/** 宿主解析出的任务 → 卡片可展示的任务书（附件取展示名）。 */
function tasksFromSpecs(tasks: SuperTaskSpec[]): SuperDirectiveDisplay {
  return {
    kind: "tasks",
    tasks: tasks.map((task) => ({
      title: task.title,
      task: task.task,
      attachments: (task.attachments ?? []).map((attachment) => attachment.name),
    })),
  };
}

/**
 * 容错展示：严格解析不出结构时，尽力把任务书拆出来给用户看。
 *
 * 拆不出返回 null —— 调用方按原有的 raw 原因码降级，语义与改动前一致。
 * 拆出来的一律带 `salvaged: true`：这是**可读的降级**，不代表宿主已经派发
 * （宿主对同一段走严格解析，失败会进 invalidBlocks）。
 */
function salvageTaskDisplay(body: string): SuperDirectiveDisplay | null {
  const tasks = salvageSuperTasks(body);
  if (tasks.length === 0) return null;
  return { kind: "tasks", tasks, salvaged: true };
}

/** 围栏正文 → 卡片可展示的结构；解析不出预期形状时退化为 raw 原因码。 */
function describeSuperDirective(language: string, body: string): SuperDirectiveDisplay {
  const parsed = parseJsonLoose(body);
  if (!parsed.ok) {
    return (language === "super-agent" ? salvageTaskDisplay(body) : null) ?? {
      kind: "raw",
      reason: "invalid_json",
    };
  }
  const value = parsed.value;

  if (language === "super-agent") {
    let rawTasks: unknown[] | null = null;
    if (Array.isArray(value)) rawTasks = value;
    else if (isRecord(value) && Array.isArray(value.tasks)) rawTasks = value.tasks;
    if (!rawTasks) {
      return salvageTaskDisplay(body) ?? { kind: "raw", reason: "missing_tasks" };
    }
    const tasks: SuperDirectiveTask[] = [];
    for (const entry of rawTasks) {
      if (!isRecord(entry)) continue;
      const task = typeof entry.task === "string" ? entry.task.trim() : "";
      const rawTitle = typeof entry.title === "string" ? entry.title.trim() : "";
      // 只有标题没有正文的条目不是可派发的任务（宿主也会跳过），但既然模型写
      // 了出来，转录里还是显示这一行标题。
      if (!task && !rawTitle) continue;
      tasks.push({
        title: normalizeSuperTitle(rawTitle || task.split("\n")[0] || ""),
        task: task || rawTitle,
        attachments: parseDirectiveAttachments(entry.attachments).map((attachment) => attachment.name),
      });
    }
    if (tasks.length > 0) return { kind: "tasks", tasks };
    return salvageTaskDisplay(body) ?? { kind: "raw", reason: "empty_tasks" };
  }

  if (language === "super-agent-actions") {
    let rawActions: unknown[] | null = null;
    if (Array.isArray(value)) rawActions = value;
    else if (isRecord(value) && Array.isArray(value.actions)) rawActions = value.actions;
    if (!rawActions) return { kind: "raw", reason: "missing_actions" };
    const actions: SuperDirectiveAction[] = [];
    for (const entry of rawActions) {
      if (!isRecord(entry)) continue;
      const action = typeof entry.action === "string" ? entry.action.trim() : "";
      const sessionId = typeof entry.sessionId === "string" ? entry.sessionId.trim() : "";
      if (!action && !sessionId) continue;
      const answers = parseActionAnswers(entry.answers);
      actions.push({
        action: action || "unknown",
        sessionId,
        ...(entry.keepBranch === true ? { keepBranch: true } : {}),
        ...(answers ? { answerCount: Object.keys(answers).length } : {}),
      });
    }
    return actions.length > 0 ? { kind: "actions", actions } : { kind: "raw", reason: "empty_actions" };
  }

  return { kind: "raw", reason: "unknown_language" };
}

/**
 * 把一段助手文本切成「普通文本段 + 协议块段」。
 *
 * 两条判定链与宿主派发逐字同源（见本节顶部注释）：
 *  - 围栏：只识别**独占一行**的 ```super-agent / ```super-agent-<name>（与宿主
 *    的围栏正则同一形状），收栏由 `resolveSuperDirectiveBlock` 按 JSON 结构定位；
 *  - 工具调用式载荷：走宿主的 `findToolStylePayloads`（标记 + 不远处的 JSON），
 *    卡片边界把包裹标记与紧随的收栏行一并吞掉（{@link toolStyleRegionStart} /
 *    {@link toolStyleRegionEnd}）。
 *
 * 围栏之外的内容原样保留给 Markdown。未闭合的围栏不切分：剩余整段仍是文本段
 * （Markdown 会照常渲染成代码块），收栏后下一次调用才切成卡片 —— 与宿主「等收栏
 * 才派发」在同一时刻切换。工具调用式载荷同理：JSON 没收全就不切。
 */
export function splitSuperDirectiveSegments(text: string): SuperDirectiveSegment[] {
  if (!text.includes(SUPER_RENDER_PROBE)) return text ? [{ kind: "text", text }] : [];
  const segments: SuperDirectiveSegment[] = [];
  let textStart = 0;
  let cursor = 0;
  let fenceUnclosed = false;
  while (cursor < text.length) {
    const open = findSuperRenderFence(text, cursor);
    if (!open) break;
    const resolved = resolveSuperDirectiveBlock(text, open, { language: open.language });
    if (resolved.kind === "unclosed") {
      fenceUnclosed = true;
      break;
    }
    if (open.lineStart > textStart) {
      segments.push({ kind: "text", text: text.slice(textStart, open.lineStart) });
    }
    segments.push({
      kind: "directive",
      language: open.language,
      raw: text.slice(open.lineStart, resolved.closeEnd),
      display: describeSuperDirective(open.language, resolved.body),
    });
    cursor = resolved.closeEnd;
    textStart = resolved.closeEnd;
  }

  // 工具调用式载荷：只在围栏没消费掉的区域里找（与宿主同一起点），围栏未闭合时
  // 同样不做兜底 —— 那段文本归围栏路径管。宿主据此派发，这里据此出卡片。
  if (!fenceUnclosed) {
    for (const match of findToolStylePayloads(text, cursor)) {
      const start = toolStyleRegionStart(text, match.marker);
      const end = toolStyleRegionEnd(text, match.end);
      if (start > textStart) segments.push({ kind: "text", text: text.slice(textStart, start) });
      segments.push({
        kind: "directive",
        language: TOOL_STYLE_MARKER,
        raw: text.slice(start, end),
        // 宿主派发出来的任务照原样展示（不带容错标记）；宿主没派发的载荷走
        // describeSuperDirective 的降级路径（容错拆出 / 原始协议块）。
        display: match.tasks ? tasksFromSpecs(match.tasks) : describeSuperDirective(TOOL_STYLE_MARKER, match.body),
      });
      cursor = end;
      textStart = end;
    }
  }

  const rest = text.slice(textStart);
  if (rest) segments.push({ kind: "text", text: rest });
  return segments;
}

