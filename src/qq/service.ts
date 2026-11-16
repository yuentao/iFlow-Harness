/**
 * QQ 任务编排器（Wave3-B1）：命令路由、队列调度、审批桥与结果回传。
 *
 * 职责边界：
 *  - **只做编排**。真正的执行体（Super Agent 子会话 / CLI 进程）、分支合并、
 *    账号绑定都由宿主通过 {@link QqServiceHost} 提供；适配器只把
 *    {@link InboundMessage} 交进来，把回复经 host 发出去。
 *  - 不 import vscode：配置由调用方注入 {@link QqConfig}，测试不需要编辑器。
 *  - 状态机与摘要/分片全部复用 `shared/qq-task.ts`，命令解析复用
 *    `shared/qq-command.ts` —— 本模块不重复造词表，也不就地改任务对象
 *    （每一步都经 `transitionQqTask` 生成新对象再落盘）。
 *
 * 安全默认：
 *  - 白名单不通过时**不回包**（防止探测通道是否存在），只写本地日志。
 *  - `/qq bind` 是唯一例外：它必须在白名单之前解析（配对码的用途正是让名单
 *    外的人完成绑定），但仍受频道边界约束（私聊，或允许列表内的群 + @ 机器人），
 *    且失败文案固定、成功只报账号数，绝不回显白名单。
 *  - 审批超时 / 停止 / 任何异常都按 `deny` 处理，绝不伪造批准。
 *  - 远程策略 `readonly` 会把写入类工具直接放进 `disallowedTools`，而不是
 *    依赖 agent 自觉。
 *
 * 持久化纪律：每次状态变化都 `store.saveTask` + `store.appendEvent`，宿主重启
 * 后 `start()` 会把所有非终态任务**如实**标记为失败（reason=host_restarted），
 * 绝不谎称它们还在跑。
 */

import type { InboundAttachment, InboundMessage } from "./adapter/types.js";
import type { QqConfig } from "./config.js";
import type { QqTaskEvent, QqTaskRecord, QqTaskStore } from "./store.js";
import {
  buildQqTaskResult,
  chunkQqText,
  createQqTask,
  DEFAULT_QQ_TASK_LIMITS,
  formatQqTaskSummary,
  isTerminalStatus,
  makeIdempotencyKey,
  qqTaskStatusLabel,
  shortTaskId,
  transitionQqTask,
  validateQqTaskRequest,
  type QqRemotePolicy,
  type QqResultDetail,
  type QqTask,
  type QqTaskError,
  type QqTaskResult,
  type QqTaskStatus,
  type QqTaskUsage,
} from "../../shared/qq-task.js";
import {
  buildQqHelpText,
  normalizeCommandText,
  parseQqCommand,
  type QqCommandIntent,
} from "../../shared/qq-command.js";
import type { Block, QqTaskUi, TurnChangeUi } from "../../shared/messages.js";
import type {
  SuperApprovalMode,
  SuperPermissionDecision,
  SuperPermissionRequest,
} from "../panel/super-agent.js";

// ---------------------------------------------------------------------------
// 宿主契约（由 panel 实现，本模块只消费）
// ---------------------------------------------------------------------------

/** 派发任务时交给宿主的策略与审批回调。 */
export interface QqServiceDispatchInput {
  task: QqTask;
  approval: SuperApprovalMode;
  disallowedTools: string[];
  onPermission: (request: SuperPermissionRequest) => Promise<SuperPermissionDecision>;
}

/** 宿主派发结果：子会话 id，以及（worktree 隔离时的）分支名。 */
export interface QqServiceDispatchResult {
  superSessionId: string;
  branch?: string;
}

/** 宿主对任务执行情况的只读快照（不知道的字段就别填）。 */
export interface QqServiceTaskOutcome {
  summary: string;
  stopReason?: string;
  changes?: Array<{ path: string; additions: number; deletions: number }>;
  usage?: unknown;
  branch?: string;
}

/** 发往 QQ 的文本消息。 */
export interface QqServiceDeliverInput {
  chatType: "private" | "group";
  chatId: string;
  text: string;
  replyToMsgId?: string;
}

/**
 * 宿主能力面。
 *
 * 实现在 `panel.ts`；本任务只定义契约，便于 B2 接线与单测注入假实现。
 */
export interface QqServiceHost {
  /** 当前窗口的工作区根列表（配置未指定 workspace 时取第一个）。 */
  workspaceRoots(): string[];
  /** 把一个 QQ 任务交给执行体（Super Agent 子会话）。 */
  dispatchTask(input: QqServiceDispatchInput): Promise<QqServiceDispatchResult>;
  /** 请求停止一个正在跑的子会话。 */
  cancelTask(superSessionId: string): Promise<void>;
  /** 把任务分支合并回当前分支。 */
  mergeTask(superSessionId: string): Promise<{ ok: boolean; detail: string }>;
  /** 丢弃任务分支 / 工作目录。 */
  discardTask(superSessionId: string): Promise<void>;
  /** 读取任务的最终观测数据；读不到时返回 null。 */
  readTaskOutcome(superSessionId: string): QqServiceTaskOutcome | null;
  /** 回复一条 QQ 消息；返回是否成功送达。 */
  deliver(msg: QqServiceDeliverInput): Promise<boolean>;
  /**
   * 完成一次账号绑定。
   *
   * `code` 是用户在面板里取到的配对码，`senderId` 是**发起绑定的 QQ 号**
   * （由服务从入站消息里取出）——宿主必须把它写进白名单，否则绑定毫无作用。
   * 对同一 `senderId` 重复绑定时应幂等成功（不重复占位、不报错）。
   *
   * 返回的 `message` 只作本地日志用：发往 QQ 的回执由 {@link QqService}
   * 统一生成（失败一律「绑定码无效或已过期」，成功只报账号数），宿主文案
   * 里带什么都不会外发，避免把白名单内容回显到群聊。
   */
  bindAccount(code: string, senderId: string): Promise<{ ok: boolean; message: string }>;
  /** 解除当前账号绑定。 */
  unbindAccount(): Promise<{ ok: boolean; message: string }>;
  /** 本地通知（面板 toast / 日志），不发给 QQ。 */
  notify(text: string): void;
}

/** 构造参数。`now` / `log` 可注入，便于单测确定化。 */
export interface QqServiceOptions {
  config: QqConfig;
  store: QqTaskStore;
  host: QqServiceHost;
  now?: () => number;
  log?: (line: string) => void;
}

/** 任务操作（IPC 与命令处理共用）。 */
export type QqTaskAction =
  | "approve"
  | "deny"
  | "answer"
  | "stop"
  | "merge"
  | "discard"
  | "refresh";

// ---------------------------------------------------------------------------
// 常量与映射
// ---------------------------------------------------------------------------

/** 审批码有效期：4 分钟（与 Super Agent 的审批卡超时同口径）。 */
export const QQ_APPROVAL_TIMEOUT_MS = 4 * 60_000;
/** 验证码最多尝试次数：第一次错误后仍保留 2 次机会。 */
export const QQ_APPROVAL_MAX_ATTEMPTS = 3;
/** `status` 无编号时回显的最近任务条数。 */
export const QQ_RECENT_TASK_LIMIT = 5;
/** 看板条目里提示词预览的字符上限。 */
export const QQ_PROMPT_PREVIEW_CHARS = 80;

/**
 * 绑定失败统一文案。
 *
 * 码错、过期、已被使用一律回同一句：区分原因等于告诉对方「这个码存在过」，
 * 会被拿去枚举探测。宿主返回的真实原因只写本地日志。
 */
export const QQ_BIND_FAILURE_TEXT = "绑定码无效或已过期。";

/** 绑定成功的回执：只报账号数，绝不回显白名单内容。 */
export function qqBindReceipt(accountCount: number): string {
  return `已绑定，当前共 ${accountCount} 个账号。`;
}
/** `readonly` 策略禁用的写入 / 执行类工具（与主会话黑名单同源）。 */
export const QQ_READONLY_DISALLOWED_TOOLS: readonly string[] = [
  "write_file",
  "replace",
  "multi_edit",
  "run_shell_command",
  "xml_escape",
];

interface QqDetailProfile {
  detail: QqResultDetail;
  /** 单条 QQ 消息的字符预算（超出按 `chunkQqText` 分片）。 */
  chunkChars: number;
}

/**
 * 结果详略档位映射。
 *
 * 配置层（`iflow.qq.resultDetail`）用 compact / standard / detailed，
 * shared 层用 summary / standard / full；两套词表都在这里收敛，避免调用点
 * 各写一份 switch。字符预算按任务约定：800 / 3000 / 12000。
 */
const DETAIL_PROFILES: Readonly<Record<string, QqDetailProfile>> = {
  compact: { detail: "summary", chunkChars: 800 },
  summary: { detail: "summary", chunkChars: 800 },
  standard: { detail: "standard", chunkChars: 3000 },
  detailed: { detail: "full", chunkChars: 12_000 },
  full: { detail: "full", chunkChars: 12_000 },
};

const DEFAULT_DETAIL_PROFILE: QqDetailProfile = { detail: "standard", chunkChars: 3000 };

/** 把配置 / 调用方给的档位归一成 shared 词表与分片预算。 */
export function qqDetailProfile(value: string | undefined): QqDetailProfile {
  if (typeof value === "string") {
    const profile = DETAIL_PROFILES[value.trim().toLowerCase()];
    if (profile) return profile;
  }
  return DEFAULT_DETAIL_PROFILE;
}

/**
 * 远程策略 → Super Agent spawn 策略。
 *
 * `trusted` 免确认；`supervised` 逐次人工确认；`readonly` 走 deny 并把写入/执行
 * 工具从注册表里剔除（双保险：模型即使想调也拿不到工具）。未知值按
 * `supervised`（更严格的一侧）处理。
 */
export function qqSpawnPolicyFor(remotePolicy: string | undefined): {
  approval: SuperApprovalMode;
  disallowedTools: string[];
} {
  switch (remotePolicy) {
    case "trusted":
      return { approval: "auto", disallowedTools: [] };
    case "readonly":
      return { approval: "deny", disallowedTools: [...QQ_READONLY_DISALLOWED_TOOLS] };
    case "supervised":
    default:
      return { approval: "supervised", disallowedTools: [] };
  }
}

const TASK_STATUSES: readonly QqTaskStatus[] = [
  "received",
  "validated",
  "queued",
  "dispatched",
  "running",
  "waiting_approval",
  "waiting_answer",
  "succeeded",
  "failed",
  "canceled",
  "timeout",
  "needs_review",
];

/** 这些停止原因代表执行没有正常收尾，终态映射为 failed。 */
const FAILURE_STOP_REASONS: ReadonlySet<string> = new Set([
  "error",
  "failed",
  "failure",
  "canceled",
  "cancelled",
  "aborted",
  "interrupted",
]);

function isQqTaskStatus(value: unknown): value is QqTaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

function isFailureStopReason(reason: string): boolean {
  return FAILURE_STOP_REASONS.has(reason.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// 内部类型
// ---------------------------------------------------------------------------

interface PendingApproval {
  code: string;
  attemptsLeft: number;
  resolve: (decision: SuperPermissionDecision) => void;
  timer: NodeJS.Timeout;
}

type TaskRefResolution =
  | { kind: "found"; task: QqTask }
  | { kind: "not_found" }
  | { kind: "ambiguous"; matches: QqTask[] };

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return typeof error === "string" ? error : "未知错误";
}

/** 把提示词压成单行预览（不改变含义，只折叠空白并截断）。 */
function previewPrompt(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length <= QQ_PROMPT_PREVIEW_CHARS) return flat;
  return `${flat.slice(0, QQ_PROMPT_PREVIEW_CHARS - 1)}…`;
}

/** 附件引用：优先 URL，其次平台 fileId，最后原文件名。 */
function attachmentRef(attachment: InboundAttachment): string | undefined {
  if (attachment.url) return attachment.url;
  if (attachment.fileId) return attachment.fileId;
  if (attachment.name) return attachment.name;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 宽松地把落盘数据还原成 QqTask。
 *
 * 归档可能来自旧版本或人手改坏；字段不全就跳过（由 start 记日志），绝不把
 * 半截对象塞进运行时 —— 后面每个 `task.source.chatId` 都会炸。
 */
function coerceQqTask(raw: unknown): QqTask | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.taskId !== "string" || raw.taskId.length === 0) return null;
  if (typeof raw.idempotencyKey !== "string" || raw.idempotencyKey.length === 0) return null;
  if (!isQqTaskStatus(raw.status)) return null;
  if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) return null;
  if (typeof raw.updatedAt !== "number" || !Number.isFinite(raw.updatedAt)) return null;

  const source = raw.source;
  if (!isRecord(source)) return null;
  if (source.chatType !== "private" && source.chatType !== "group") return null;
  if (typeof source.chatId !== "string") return null;
  if (typeof source.senderId !== "string") return null;
  if (typeof source.msgId !== "string") return null;

  const target = raw.target;
  if (!isRecord(target) || typeof target.workspace !== "string") return null;

  const payload = raw.payload;
  if (!isRecord(payload) || typeof payload.prompt !== "string") return null;
  if (!Array.isArray(payload.attachments) || !Array.isArray(payload.contexts)) return null;
  if (!payload.attachments.every((item) => typeof item === "string")) return null;
  if (!payload.contexts.every((item) => typeof item === "string")) return null;

  const policy = raw.policy;
  if (!isRecord(policy)) return null;
  if (typeof policy.remotePolicy !== "string" || typeof policy.resultDetail !== "string") {
    return null;
  }

  const correlation = isRecord(raw.correlation) ? raw.correlation : {};
  const task: QqTask = {
    taskId: raw.taskId,
    idempotencyKey: raw.idempotencyKey,
    source: {
      chatType: source.chatType,
      chatId: source.chatId,
      senderId: source.senderId,
      msgId: source.msgId,
    },
    target: {
      workspace: target.workspace,
      ...(typeof target.mode === "string" ? { mode: target.mode } : {}),
      ...(typeof target.model === "string" ? { model: target.model } : {}),
    },
    payload: {
      prompt: payload.prompt,
      attachments: [...payload.attachments],
      contexts: [...payload.contexts],
    },
    policy: {
      remotePolicy: policy.remotePolicy as QqRemotePolicy,
      resultDetail: policy.resultDetail as QqResultDetail,
    },
    status: raw.status,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    correlation: {
      ...(typeof correlation.superSessionId === "string"
        ? { superSessionId: correlation.superSessionId }
        : {}),
      ...(typeof correlation.userBlockId === "string"
        ? { userBlockId: correlation.userBlockId }
        : {}),
      ...(typeof correlation.branch === "string" ? { branch: correlation.branch } : {}),
      ...(typeof correlation.commit === "string" ? { commit: correlation.commit } : {}),
    },
  };

  if (isRecord(raw.result)) {
    const result = raw.result;
    if (typeof result.stopReason === "string" && typeof result.summary === "string") {
      const changes = Array.isArray(result.changes) ? result.changes : [];
      task.result = {
        stopReason: result.stopReason,
        summary: result.summary,
        changes: changes
          .filter(
            (change): change is Record<string, unknown> =>
              isRecord(change) &&
              typeof change.path === "string" &&
              typeof change.additions === "number" &&
              typeof change.deletions === "number",
          )
          .map((change) => ({
            path: change.path as string,
            additions: change.additions as number,
            deletions: change.deletions as number,
          })),
        artifacts: Array.isArray(result.artifacts)
          ? result.artifacts.filter((item): item is string => typeof item === "string")
          : [],
        ...(typeof result.branch === "string" ? { branch: result.branch } : {}),
        ...(isRecord(result.usage) ? { usage: result.usage as unknown as QqTaskUsage } : {}),
      };
    }
  }
  if (isRecord(raw.pending) && typeof raw.pending.text === "string") {
    const kind = raw.pending.kind === "answer" ? "answer" : "approval";
    task.pending = {
      kind,
      text: raw.pending.text,
      at: typeof raw.pending.at === "number" ? raw.pending.at : raw.updatedAt,
    };
  }
  if (isRecord(raw.failure) && typeof raw.failure.code === "string") {
    task.failure = {
      code: raw.failure.code,
      message: typeof raw.failure.message === "string" ? raw.failure.message : "",
    };
  }
  return task;
}

// ---------------------------------------------------------------------------
// QqService
// ---------------------------------------------------------------------------

export class QqService {
  readonly config: QqConfig;

  private readonly store: QqTaskStore;
  private readonly host: QqServiceHost;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  private readonly tasks = new Map<string, QqTask>();
  private readonly idempotency = new Map<string, string>();
  private readonly queue: string[] = [];
  private readonly jobs = new Set<Promise<void>>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  /** 每个发送者的滑动窗口（毫秒时间戳，保留最近 60s）。 */
  private readonly rateWindows = new Map<string, number[]>();

  private runningCount = 0;
  private stopped = false;
  private started = false;
  /** 验证码随机源（测试可以替换成确定值）。 */
  private random: () => number = Math.random;

  constructor(options: QqServiceOptions) {
    this.config = options.config;
    this.store = options.store;
    this.host = options.host;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => undefined);
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /**
   * 载入归档，并把所有非终态任务如实标记为中断。
   *
   * 进程已经换了一茬：说「还在跑」会让主会话的等待永远等不到结果。归档只存
   * 记录，不存进程 —— 所以非终态一律 `failed`，failure.code 固定
   * `host_restarted`，便于上层区分「宿主重启」与「agent 报错」。
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;

    let entries: Awaited<ReturnType<QqTaskStore["listTasks"]>> = [];
    try {
      entries = await this.store.listTasks();
    } catch (error) {
      this.log(`QQ 任务归档读取失败：${errorText(error)}`);
    }

    for (const entry of entries) {
      if (this.tasks.has(entry.taskId)) continue;
      let raw: unknown = null;
      try {
        raw = await this.store.loadTask(entry.taskId);
      } catch (error) {
        this.log(`QQ 任务 ${entry.taskId} 读取失败：${errorText(error)}`);
      }
      const task = coerceQqTask(raw);
      if (!task) {
        this.log(`QQ 任务 ${entry.taskId} 归档损坏，已跳过`);
        continue;
      }
      this.tasks.set(task.taskId, task);
      this.idempotency.set(task.idempotencyKey, task.taskId);
    }

    for (const task of [...this.tasks.values()]) {
      if (isTerminalStatus(task.status)) continue;
      const at = this.now();
      const outcome = transitionQqTask(task, "failed", at);
      const base = outcome.noop ? task : outcome.task;
      const interrupted: QqTask = {
        ...base,
        updatedAt: Math.max(base.updatedAt, at),
        failure: { code: "host_restarted", message: "扩展宿主已重启，任务中断。" },
        pending: undefined,
      };
      try {
        await this.persist(interrupted);
        await this.appendEvent("task_interrupted", interrupted.taskId, {
          reason: "host_restarted",
        });
      } catch (error) {
        this.log(`QQ 任务 ${interrupted.taskId} 中断回写失败：${errorText(error)}`);
      }
      this.notify(`QQ 任务 ${shortTaskId(interrupted.taskId)} 因宿主重启标记为失败`);
    }
  }

  /**
   * 停止服务：清空队列，并把所有等待审批的请求按拒绝放行。
   *
   * 已在跑的任务不会被等待（它们可能挂很久）；宿主关闭进程后由下一次
   * `start()` 的「非终态 → 失败」兜底。这里只保证 agent 不会永远卡在审批上。
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.queue.length = 0;
    for (const entry of this.pendingApprovals.values()) {
      clearTimeout(entry.timer);
      entry.resolve("deny");
    }
    this.pendingApprovals.clear();
  }

  // -------------------------------------------------------------------------
  // 入站消息
  // -------------------------------------------------------------------------

  /**
   * 处理一条来自适配器的入站消息。
   *
   * 解析必须**先于**白名单：`/qq bind <配对码>` 的唯一用途就是让尚未在名单里
   * 的人完成绑定，先校验白名单会让它永远无法成功（这正是此前的死锁）。绑定
   * 命令只放宽「发送者白名单」这一道门，频道边界照旧（私聊，或允许列表内的
   * 群 + @ 机器人），避免任意群都能刷绑定。
   *
   * 其余意图的白名单不通过时**不回复**（防止探测），只记本地通知；命令解析
   * 失败与未知子命令会回一句可读错误（这是用户自己打错的字，不是探测）。
   */
  async handleInboundMessage(msg: InboundMessage): Promise<void> {
    const rawText = typeof msg?.text === "string" ? msg.text : "";
    const parsed = parseQqCommand(normalizeCommandText(rawText));

    if (parsed.ok && parsed.intent.kind === "bind") {
      const channel = this.acceptBindChannel(msg);
      if (!channel.ok) {
        this.notify(`QQ 绑定请求被忽略：${channel.reason}`);
        this.log(`QQ 绑定请求被忽略：${channel.reason}`);
        return;
      }
      await this.runCommand(msg, parsed.intent);
      return;
    }

    const accepted = this.acceptInbound(msg);
    if (!accepted.ok) {
      this.notify(`QQ 消息被忽略：${accepted.reason}`);
      this.log(`QQ 入站消息被忽略：${accepted.reason}`);
      return;
    }

    let prompt: string | undefined;
    if (parsed.ok) {
      if (parsed.intent.kind === "task") {
        prompt = parsed.intent.prompt;
      } else {
        await this.runCommand(msg, parsed.intent);
        return;
      }
    } else if (parsed.code === "not_a_command") {
      // 便捷路径：私聊直接发一句话就当作任务；其余场景静默。
      if (msg.chatType !== "private" || !this.config.enabled) return;
      prompt = rawText.trim();
    } else {
      await this.deliver(msg, parsed.message);
      return;
    }

    if (!prompt) {
      await this.deliver(msg, "任务内容为空，已忽略。");
      return;
    }
    await this.createTaskFromMessage(msg, prompt);
  }

  private acceptInbound(
    msg: InboundMessage,
  ): { ok: true } | { ok: false; reason: string } {
    if (!msg || (msg.chatType !== "private" && msg.chatType !== "group")) {
      return { ok: false, reason: "无效的会话类型" };
    }
    if (typeof msg.senderId !== "string" || !this.config.allowedUsers.includes(msg.senderId)) {
      return { ok: false, reason: `发送者 ${String(msg.senderId)} 不在白名单` };
    }
    if (msg.chatType === "group") {
      if (!this.config.allowedGroups.includes(msg.chatId)) {
        return { ok: false, reason: `群 ${msg.chatId} 不在允许列表` };
      }
      if (msg.mentionsBot !== true) {
        return { ok: false, reason: `群 ${msg.chatId} 的消息没有 @ 机器人` };
      }
    }
    return { ok: true };
  }

  /**
   * 绑定命令的准入：跳过发送者白名单，但保留频道边界。
   *
   * 只要不额外约束，任何群都能拉机器人去绑别人的配对码；所以群聊仍然要求
   * 「在 allowedGroups 内 + @ 机器人」，私聊则需要一个可写入白名单的发送者。
   */
  private acceptBindChannel(
    msg: InboundMessage,
  ): { ok: true } | { ok: false; reason: string } {
    if (!msg || (msg.chatType !== "private" && msg.chatType !== "group")) {
      return { ok: false, reason: "无效的会话类型" };
    }
    if (typeof msg.senderId !== "string" || msg.senderId.trim().length === 0) {
      return { ok: false, reason: "缺少发送者标识" };
    }
    if (msg.chatType === "group") {
      if (!this.config.allowedGroups.includes(msg.chatId)) {
        return { ok: false, reason: `群 ${msg.chatId} 不在允许列表` };
      }
      if (msg.mentionsBot !== true) {
        return { ok: false, reason: `群 ${msg.chatId} 的消息没有 @ 机器人` };
      }
    }
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // 建任务 / 限流 / 调度
  // -------------------------------------------------------------------------

  private async createTaskFromMessage(msg: InboundMessage, prompt: string): Promise<void> {
    const key = makeIdempotencyKey(this.config.adapter, msg.msgId);
    const existingId = this.idempotency.get(key);
    if (existingId) {
      const existing = this.tasks.get(existingId);
      const label = existing ? shortTaskId(existing.taskId) : shortTaskId(existingId);
      await this.deliver(msg, `已受理任务 ${label}，不会重复执行。`);
      return;
    }

    const workspace = this.resolveWorkspace();
    const validation = validateQqTaskRequest(
      {
        authorized: true,
        chatType: msg.chatType,
        groupAllowed: msg.chatType === "group" ? true : undefined,
        mentioned: msg.chatType === "group" ? msg.mentionsBot : undefined,
        prompt,
        attachments: msg.attachments.map((attachment) => ({
          name: attachment.name,
          size: typeof attachment.sizeBytes === "number" ? attachment.sizeBytes : undefined,
          kind: attachment.kind,
        })),
        workspace: workspace || undefined,
      },
      DEFAULT_QQ_TASK_LIMITS,
    );
    if (!validation.ok) {
      this.notify(`QQ 任务被拒绝（${validation.code}）：${validation.message}`);
      await this.deliver(msg, `任务被拒绝：${validation.message}`);
      return;
    }

    if (!this.consumeRateLimit(msg.senderId)) {
      const limit = Math.max(1, this.config.rateLimitPerMin);
      this.notify(`QQ 用户 ${msg.senderId} 触发限流（每分钟 ${limit} 条）`);
      await this.deliver(msg, `请求过于频繁，每分钟最多 ${limit} 条任务，请稍后再试。`);
      return;
    }

    const attachments = msg.attachments
      .map(attachmentRef)
      .filter((ref): ref is string => typeof ref === "string" && ref.length > 0);

    const created = createQqTask(
      {
        adapter: this.config.adapter,
        source: {
          chatType: msg.chatType,
          chatId: msg.chatId,
          senderId: msg.senderId,
          msgId: msg.msgId,
        },
        target: { workspace },
        payload: { prompt, attachments, contexts: [] },
        policy: {
          remotePolicy: this.config.remotePolicy as QqRemotePolicy,
          resultDetail: qqDetailProfile(this.config.resultDetail).detail,
        },
      },
      { now: this.now },
    );

    let task = await this.commitStatus(created, "validated");
    task = await this.commitStatus(task, "queued");
    await this.appendEvent("task_created", task.taskId, {
      chatType: msg.chatType,
      chatId: msg.chatId,
      senderId: msg.senderId,
    });

    await this.deliver(msg, `已受理任务 ${shortTaskId(task.taskId)}，排队中。`, msg.msgId);
    this.enqueue(task.taskId);
  }

  private resolveWorkspace(): string {
    const configured = this.config.workspace.trim();
    if (configured) return configured;
    const roots = this.host.workspaceRoots();
    const first = roots[0];
    return typeof first === "string" ? first.trim() : "";
  }

  /** 滑动窗口限流：返回 true 表示配额已消耗（可以继续）。 */
  private consumeRateLimit(senderId: string): boolean {
    const limit = Math.max(1, this.config.rateLimitPerMin);
    const at = this.now();
    const windowStart = at - 60_000;
    const recent = (this.rateWindows.get(senderId) ?? []).filter((ts) => ts > windowStart);
    if (recent.length >= limit) {
      this.rateWindows.set(senderId, recent);
      return false;
    }
    recent.push(at);
    this.rateWindows.set(senderId, recent);
    return true;
  }

  private enqueue(taskId: string): void {
    this.queue.push(taskId);
    this.pump();
  }

  /** 并发上限内启动排队任务（FIFO）。 */
  private pump(): void {
    if (this.stopped) return;
    const limit = Math.max(1, this.config.maxConcurrentTasks);
    while (this.runningCount < limit && this.queue.length > 0) {
      const taskId = this.queue.shift();
      if (!taskId) continue;
      const task = this.tasks.get(taskId);
      if (!task || isTerminalStatus(task.status)) continue;

      this.runningCount += 1;
      const job = this.runTask(taskId)
        .catch((error: unknown) => {
          this.log(`QQ 任务 ${taskId} 调度异常：${errorText(error)}`);
        })
        .finally(() => {
          this.runningCount = Math.max(0, this.runningCount - 1);
          this.jobs.delete(job);
          this.pump();
        });
      this.jobs.add(job);
    }
  }

  // -------------------------------------------------------------------------
  // 单任务执行
  // -------------------------------------------------------------------------

  private async runTask(taskId: string): Promise<void> {
    let task = this.tasks.get(taskId);
    if (!task || isTerminalStatus(task.status)) return;

    try {
      task = await this.commitStatus(task, "dispatched");
      if (isTerminalStatus(task.status)) return;
      task = await this.commitStatus(task, "running");
      if (isTerminalStatus(task.status)) return;

      const policy = qqSpawnPolicyFor(task.policy.remotePolicy);
      const dispatched = await this.host.dispatchTask({
        task,
        approval: policy.approval,
        disallowedTools: policy.disallowedTools,
        onPermission: (request) => this.requestApproval(taskId, request),
      });

      if (this.stopped) {
        this.log(`QQ 任务 ${taskId} 在服务停止后才完成派发，跳过收尾`);
        return;
      }

      const current = this.tasks.get(taskId) ?? task;
      const at = this.now();
      const correlated: QqTask = {
        ...current,
        updatedAt: Math.max(current.updatedAt, at),
        correlation: {
          ...current.correlation,
          superSessionId: dispatched.superSessionId,
          ...(dispatched.branch ? { branch: dispatched.branch } : {}),
        },
      };
      await this.persist(correlated);
      if (isTerminalStatus(correlated.status)) return;
      await this.finalize(correlated, dispatched);
    } catch (error) {
      if (this.stopped) return;
      const current = this.tasks.get(taskId);
      if (!current || isTerminalStatus(current.status)) return;
      await this.failTask(current, "host_error", errorText(error));
    }
  }

  private async finalize(
    task: QqTask,
    dispatched: QqServiceDispatchResult,
  ): Promise<void> {
    const outcome = this.host.readTaskOutcome(dispatched.superSessionId);
    if (!outcome) {
      await this.failTask(task, "no_outcome", "执行体没有返回任务结果。");
      return;
    }

    const stopReason =
      typeof outcome.stopReason === "string" && outcome.stopReason.length > 0
        ? outcome.stopReason
        : "end_turn";
    const branch = outcome.branch ?? task.correlation.branch;
    const result = this.buildResult(outcome, stopReason, task, branch);

    let status: QqTaskStatus;
    let failure: QqTaskError | undefined;
    if (isFailureStopReason(stopReason)) {
      status = "failed";
      failure = { code: "agent_failed", message: `执行结束：${stopReason}` };
    } else if (branch) {
      if (this.config.autoMerge) {
        let merged = false;
        let detail = "";
        try {
          const merge = await this.host.mergeTask(dispatched.superSessionId);
          merged = merge.ok;
          detail = merge.detail;
        } catch (error) {
          detail = errorText(error);
        }
        if (merged) {
          status = "succeeded";
        } else {
          status = "needs_review";
          this.notify(
            `QQ 任务 ${shortTaskId(task.taskId)} 自动合并未完成，分支保留待复核：${detail}`,
          );
        }
      } else {
        status = "needs_review";
      }
    } else {
      status = "succeeded";
    }

    const current = this.tasks.get(task.taskId) ?? task;
    const at = this.now();
    const patched: QqTask = {
      ...current,
      result,
      failure,
      pending: undefined,
      updatedAt: Math.max(current.updatedAt, at),
      correlation:
        branch && !current.correlation.branch
          ? { ...current.correlation, branch }
          : current.correlation,
    };

    const updated = await this.commitStatus(patched, status, {
      result,
      failure,
      pending: undefined,
    });
    await this.appendEvent(status === "succeeded" ? "task_succeeded" : "task_finished", updated.taskId, {
      status,
      stopReason,
    });
    await this.deliverResult(updated);
  }

  private buildResult(
    outcome: QqServiceTaskOutcome,
    stopReason: string,
    task: QqTask,
    branch: string | undefined,
  ): QqTaskResult {
    const summary = typeof outcome.summary === "string" ? outcome.summary : "";
    const blocks: Block[] = summary
      ? [{ kind: "text", id: `qq-${task.taskId}`, text: summary }]
      : [];
    const changes = Array.isArray(outcome.changes) ? outcome.changes : [];
    const turnChanges: TurnChangeUi[] = changes.map((change) => ({
      toolCallId: `${task.taskId}:${change.path}`,
      title: change.path,
      status: "completed",
      reverted: false,
      partiallyReverted: false,
      key: change.path,
      path: change.path,
      additions: change.additions,
      deletions: change.deletions,
      edits: 1,
      canUndo: false,
    }));
    const usage =
      outcome.usage && typeof outcome.usage === "object"
        ? (outcome.usage as QqTaskUsage)
        : undefined;
    return buildQqTaskResult({ stopReason, blocks, turnChanges, usage, branch });
  }

  private async failTask(task: QqTask, code: string, message: string): Promise<void> {
    const current = this.tasks.get(task.taskId) ?? task;
    if (isTerminalStatus(current.status)) return;
    const at = this.now();
    const patched: QqTask = {
      ...current,
      failure: { code, message },
      pending: undefined,
      updatedAt: Math.max(current.updatedAt, at),
    };
    const updated = await this.commitStatus(patched, "failed", {
      failure: patched.failure,
      pending: undefined,
    });
    await this.appendEvent("task_failed", updated.taskId, { code, message });
    await this.deliverTask(updated, `任务 ${shortTaskId(updated.taskId)} 失败：${message}`);
  }

  // -------------------------------------------------------------------------
  // 审批桥
  // -------------------------------------------------------------------------

  /**
   * agent 发来一次权限请求：生成 4 位一次性码、把任务切到 waiting_approval、
   * 通过 QQ 发出请求，并把 Promise 挂起等待用户操作。
   *
   * 并发请求在这里被拒绝：一个任务同时只允许一个待审批项，否则「验证码属于
   * 哪次请求」会变得无法判定。
   */
  private async requestApproval(
    taskId: string,
    request: SuperPermissionRequest,
  ): Promise<SuperPermissionDecision> {
    const task = this.tasks.get(taskId);
    if (!task || this.stopped) return "deny";

    if (this.pendingApprovals.has(taskId)) {
      await this.deliverTask(
        task,
        `任务 ${shortTaskId(taskId)} 已有待审批请求，本次请求按拒绝处理。`,
      );
      return "deny";
    }

    let resolveDecision: (decision: SuperPermissionDecision) => void = () => undefined;
    const decision = new Promise<SuperPermissionDecision>((resolve) => {
      resolveDecision = resolve;
    });

    const code = this.generateApprovalCode();
    const at = this.now();
    const toolLabel = request.toolName ?? request.summary ?? "工具调用";
    const pending = {
      kind: "approval" as const,
      text: `审批 ${toolLabel}（验证码 ${code}）`,
      at,
    };
    const waiting = await this.commitStatus(task, "waiting_approval", {
      pending,
      updatedAt: Math.max(task.updatedAt, at),
    });
    if (isTerminalStatus(waiting.status)) {
      resolveDecision("deny");
      return decision;
    }

    const timer = setTimeout(() => {
      void this.expireApproval(taskId, code);
    }, QQ_APPROVAL_TIMEOUT_MS);
    timer.unref?.();
    this.pendingApprovals.set(taskId, {
      code,
      attemptsLeft: QQ_APPROVAL_MAX_ATTEMPTS,
      resolve: resolveDecision,
      timer,
    });

    const detail = request.summary ? `：${request.summary}` : "";
    await this.deliverTask(
      waiting,
      [
        `任务 ${shortTaskId(taskId)} 请求审批${detail}`,
        `回复 /qq approve ${shortTaskId(taskId)} ${code} 批准，`,
        `/qq deny ${shortTaskId(taskId)} 拒绝（4 分钟内有效）。`,
      ].join("\n"),
    );
    return decision;
  }

  private generateApprovalCode(): string {
    const raw = this.random();
    const normalized = Number.isFinite(raw) ? Math.min(0.9999, Math.max(0, raw)) : 0;
    return String(Math.floor(normalized * 10_000)).padStart(4, "0");
  }

  private async expireApproval(taskId: string, code: string): Promise<void> {
    const entry = this.pendingApprovals.get(taskId);
    if (!entry || entry.code !== code) return;
    this.pendingApprovals.delete(taskId);
    clearTimeout(entry.timer);
    entry.resolve("deny");

    const task = this.tasks.get(taskId);
    if (!task) return;
    const at = this.now();
    const cleared: QqTask = {
      ...task,
      pending: undefined,
      updatedAt: Math.max(task.updatedAt, at),
    };
    const updated = await this.commitStatus(cleared, "running", { pending: undefined });
    await this.deliverTask(
      updated,
      `任务 ${shortTaskId(taskId)} 审批超时（4 分钟），已按拒绝处理。`,
    );
  }

  private releaseApproval(entry: PendingApproval): void {
    clearTimeout(entry.timer);
  }

  // -------------------------------------------------------------------------
  // 任务操作（IPC / 命令共用）
  // -------------------------------------------------------------------------

  async handleTaskAction(
    taskId: string,
    action: QqTaskAction,
    text?: string,
  ): Promise<void> {
    const resolved = this.resolveTaskRef(taskId);
    if (resolved.kind === "ambiguous") {
      this.notify(
        `QQ 任务操作失败：编号 ${taskId} 命中 ${resolved.matches.length} 个任务（${resolved.matches
          .map((task) => shortTaskId(task.taskId))
          .join("、")}）`,
      );
      return;
    }
    if (resolved.kind === "not_found") {
      this.notify(`QQ 任务操作失败：未找到任务 ${taskId}`);
      return;
    }

    const task = resolved.task;
    switch (action) {
      case "approve":
        await this.approveTask(task, text);
        return;
      case "deny":
        await this.denyTask(task);
        return;
      case "answer":
        await this.answerTask(task);
        return;
      case "stop":
        await this.stopTask(task);
        return;
      case "merge":
        await this.mergeTask(task);
        return;
      case "discard":
        await this.discardTask(task);
        return;
      case "refresh":
        await this.refreshTask(task);
        return;
    }
  }

  private async approveTask(task: QqTask, code: string | undefined): Promise<void> {
    const entry = this.pendingApprovals.get(task.taskId);
    if (!entry) {
      await this.deliverTask(task, `任务 ${shortTaskId(task.taskId)} 当前没有等待审批的请求。`);
      return;
    }
    if (!code) {
      await this.deliverTask(
        task,
        `请提供 4 位验证码：/qq approve ${shortTaskId(task.taskId)} <验证码>`,
      );
      return;
    }
    if (code === entry.code) {
      this.pendingApprovals.delete(task.taskId);
      this.releaseApproval(entry);
      entry.resolve("allow_once");
      const updated = await this.clearPendingAndResume(task.taskId, task);
      await this.deliverTask(updated, `任务 ${shortTaskId(task.taskId)} 已批准。`);
      return;
    }

    entry.attemptsLeft -= 1;
    if (entry.attemptsLeft > 0) {
      await this.deliverTask(
        task,
        `验证码错误，还可再试 ${entry.attemptsLeft} 次。`,
      );
      return;
    }
    this.pendingApprovals.delete(task.taskId);
    this.releaseApproval(entry);
    entry.resolve("deny");
    const updated = await this.clearPendingAndResume(task.taskId, task);
    await this.deliverTask(
      updated,
      `验证码错误次数过多，任务 ${shortTaskId(task.taskId)} 已按拒绝处理。`,
    );
  }

  private async denyTask(task: QqTask): Promise<void> {
    const entry = this.pendingApprovals.get(task.taskId);
    if (!entry) {
      await this.deliverTask(task, `任务 ${shortTaskId(task.taskId)} 当前没有等待审批的请求。`);
      return;
    }
    this.pendingApprovals.delete(task.taskId);
    this.releaseApproval(entry);
    entry.resolve("deny");
    const updated = await this.clearPendingAndResume(task.taskId, task);
    await this.deliverTask(updated, `任务 ${shortTaskId(task.taskId)} 已拒绝。`);
  }

  private async answerTask(task: QqTask): Promise<void> {
    await this.deliverTask(
      task,
      `任务 ${shortTaskId(task.taskId)} 当前没有等待回答的问题。`,
    );
  }

  private async clearPendingAndResume(taskId: string, fallback: QqTask): Promise<QqTask> {
    const current = this.tasks.get(taskId) ?? fallback;
    const at = this.now();
    const cleared: QqTask = {
      ...current,
      pending: undefined,
      updatedAt: Math.max(current.updatedAt, at),
    };
    return this.commitStatus(cleared, "running", { pending: undefined });
  }

  private async stopTask(task: QqTask): Promise<void> {
    const current = this.tasks.get(task.taskId) ?? task;
    if (isTerminalStatus(current.status)) {
      await this.deliverTask(
        current,
        `任务 ${shortTaskId(current.taskId)} 已结束（${qqTaskStatusLabel(current.status)}）。`,
      );
      return;
    }

    const pending = this.pendingApprovals.get(current.taskId);
    if (pending) {
      this.pendingApprovals.delete(current.taskId);
      this.releaseApproval(pending);
      pending.resolve("deny");
    }

    const queuedAt = this.queue.indexOf(current.taskId);
    if (queuedAt >= 0) this.queue.splice(queuedAt, 1);

    const superSessionId = current.correlation.superSessionId;
    if (superSessionId) {
      try {
        await this.host.cancelTask(superSessionId);
      } catch (error) {
        this.log(`QQ 任务 ${current.taskId} 取消失败：${errorText(error)}`);
      }
    }

    const at = this.now();
    const patched: QqTask = {
      ...current,
      pending: undefined,
      updatedAt: Math.max(current.updatedAt, at),
    };
    const updated = await this.commitStatus(patched, "canceled", { pending: undefined });
    await this.appendEvent("task_canceled", updated.taskId);
    await this.deliverTask(updated, `已请求停止任务 ${shortTaskId(updated.taskId)}。`);
  }

  private async mergeTask(task: QqTask): Promise<void> {
    const current = this.tasks.get(task.taskId) ?? task;
    const superSessionId = current.correlation.superSessionId;
    if (!superSessionId) {
      await this.deliverTask(
        current,
        `任务 ${shortTaskId(current.taskId)} 没有可合并的分支。`,
      );
      return;
    }
    let result: { ok: boolean; detail: string };
    try {
      result = await this.host.mergeTask(superSessionId);
    } catch (error) {
      result = { ok: false, detail: errorText(error) };
    }
    if (result.ok) {
      await this.deliverTask(
        current,
        `任务 ${shortTaskId(current.taskId)} 已合并：${result.detail}`,
      );
      return;
    }
    await this.deliverTask(
      current,
      `任务 ${shortTaskId(current.taskId)} 合并失败：${result.detail}`,
    );
  }

  private async discardTask(task: QqTask): Promise<void> {
    const current = this.tasks.get(task.taskId) ?? task;
    const superSessionId = current.correlation.superSessionId;
    if (!superSessionId) {
      await this.deliverTask(
        current,
        `任务 ${shortTaskId(current.taskId)} 没有可丢弃的工作分支。`,
      );
      return;
    }
    try {
      await this.host.discardTask(superSessionId);
    } catch (error) {
      await this.deliverTask(
        current,
        `任务 ${shortTaskId(current.taskId)} 丢弃失败：${errorText(error)}`,
      );
      return;
    }
    const latest = this.tasks.get(current.taskId) ?? current;
    if (!isTerminalStatus(latest.status)) {
      const at = this.now();
      await this.commitStatus(
        { ...latest, pending: undefined, updatedAt: Math.max(latest.updatedAt, at) },
        "canceled",
        { pending: undefined },
      );
    }
    await this.deliverTask(current, `任务 ${shortTaskId(current.taskId)} 的工作分支已丢弃。`);
  }

  private async refreshTask(task: QqTask): Promise<void> {
    const current = this.tasks.get(task.taskId) ?? task;
    const superSessionId = current.correlation.superSessionId;
    if (!superSessionId) {
      await this.deliverTask(
        current,
        `任务 ${shortTaskId(current.taskId)} 尚未派发，没有结果可刷新。`,
      );
      return;
    }
    const outcome = this.host.readTaskOutcome(superSessionId);
    if (!outcome) {
      await this.deliverTask(
        current,
        `任务 ${shortTaskId(current.taskId)} 暂时读取不到结果。`,
      );
      return;
    }
    const stopReason =
      typeof outcome.stopReason === "string" && outcome.stopReason.length > 0
        ? outcome.stopReason
        : "end_turn";
    const branch = outcome.branch ?? current.correlation.branch;
    const result = this.buildResult(outcome, stopReason, current, branch);
    const at = this.now();
    const patched: QqTask = {
      ...current,
      result,
      updatedAt: Math.max(current.updatedAt, at),
    };
    await this.persist(patched);
    await this.deliverResult(patched);
  }

  // -------------------------------------------------------------------------
  // 命令路由
  // -------------------------------------------------------------------------

  private async runCommand(msg: InboundMessage, intent: QqCommandIntent): Promise<void> {
    switch (intent.kind) {
      case "task":
        // 已在 handleInboundMessage 中分流，防御性兜底。
        await this.createTaskFromMessage(msg, intent.prompt);
        return;
      case "help":
        await this.deliver(msg, buildQqHelpText());
        return;
      case "bind": {
        await this.handleBindCommand(msg, intent.code);
        return;
      }
      case "unbind": {
        let result: { ok: boolean; message: string };
        try {
          result = await this.host.unbindAccount();
        } catch (error) {
          result = { ok: false, message: errorText(error) };
        }
        await this.deliver(msg, result.message);
        return;
      }
      case "status": {
        const profile = qqDetailProfile(this.config.resultDetail);
        if (!intent.taskId) {
          await this.deliver(msg, this.formatRecentTasks());
          return;
        }
        const resolved = this.resolveTaskRef(intent.taskId);
        if (resolved.kind !== "found") {
          await this.deliverResolveFailure(msg, intent.taskId, resolved);
          return;
        }
        await this.deliver(msg, formatQqTaskSummary(resolved.task, profile.detail));
        return;
      }
      case "result": {
        const resolved = this.resolveTaskRef(intent.taskId);
        if (resolved.kind !== "found") {
          await this.deliverResolveFailure(msg, intent.taskId, resolved);
          return;
        }
        const profile = qqDetailProfile(this.config.resultDetail);
        await this.deliver(msg, formatQqTaskSummary(resolved.task, profile.detail));
        return;
      }
      case "diff": {
        const resolved = this.resolveTaskRef(intent.taskId);
        if (resolved.kind !== "found") {
          await this.deliverResolveFailure(msg, intent.taskId, resolved);
          return;
        }
        await this.deliver(msg, this.formatDiff(resolved.task));
        return;
      }
      case "stop":
      case "approve":
      case "deny":
      case "answer":
      case "merge":
      case "discard": {
        const resolved = this.resolveTaskRef(intent.taskId);
        if (resolved.kind !== "found") {
          await this.deliverResolveFailure(msg, intent.taskId, resolved);
          return;
        }
        const text =
          intent.kind === "approve"
            ? intent.code
            : intent.kind === "answer"
              ? intent.text
              : undefined;
        await this.handleTaskAction(resolved.task.taskId, intent.kind, text);
        return;
      }
    }
  }

  /**
   * 绑定命令：把发送者标识一起交给宿主，回执由服务端统一生成。
   *
   * 宿主的 `message` 可能带着配对码细节或白名单内容，一律不外发——失败统一
   * 回 {@link QQ_BIND_FAILURE_TEXT}（不泄露码是否存在），成功只回账号数。
   * 同一 senderId 重复绑定的幂等性由宿主保证，这里照常回同样的回执。
   */
  private async handleBindCommand(msg: InboundMessage, code: string): Promise<void> {
    let result: { ok: boolean; message: string };
    try {
      result = await this.host.bindAccount(code, msg.senderId);
    } catch (error) {
      this.log(`QQ 绑定失败：${errorText(error)}`);
      await this.deliver(msg, QQ_BIND_FAILURE_TEXT);
      return;
    }
    if (result?.ok !== true) {
      this.log(`QQ 绑定失败（宿主）：${result?.message ?? "未知原因"}`);
      await this.deliver(msg, QQ_BIND_FAILURE_TEXT);
      return;
    }
    const count = this.boundAccountCount(msg.senderId);
    await this.deliver(msg, qqBindReceipt(count));
    this.log(`QQ 账号 ${msg.senderId} 绑定完成，当前共 ${count} 个账号`);
  }

  /** 账号数：配置快照里的白名单 + 本次发送者（重复绑定不重复计数）。 */
  private boundAccountCount(senderId: string): number {
    const accounts = new Set(this.config.allowedUsers);
    accounts.add(senderId);
    return accounts.size;
  }

  private formatRecentTasks(): string {
    const recent = this.listTasks().slice(0, QQ_RECENT_TASK_LIMIT);
    const lines = ["最近的 QQ 任务"];
    if (recent.length === 0) {
      lines.push("  （暂无任务）");
      return lines.join("\n");
    }
    for (const item of recent) {
      lines.push(
        `  ${item.shortId}  ${qqTaskStatusLabel(item.status)}  ${item.promptPreview || "（无描述）"}`,
      );
    }
    return lines.join("\n");
  }

  private formatDiff(task: QqTask): string {
    const changes = task.result?.changes ?? [];
    if (changes.length === 0) {
      return `任务 ${shortTaskId(task.taskId)} 没有记录的改动。`;
    }
    const lines = [`任务 ${shortTaskId(task.taskId)} 改动（${changes.length} 个文件）`];
    for (const change of changes.slice(0, 30)) {
      lines.push(`  +${change.additions} -${change.deletions}  ${change.path}`);
    }
    if (changes.length > 30) {
      lines.push(`  … 另有 ${changes.length - 30} 个文件`);
    }
    return lines.join("\n");
  }

  private async deliverResolveFailure(
    msg: InboundMessage,
    ref: string,
    resolved: Exclude<TaskRefResolution, { kind: "found" }>,
  ): Promise<void> {
    if (resolved.kind === "ambiguous") {
      const ids = resolved.matches.map((task) => shortTaskId(task.taskId)).join("、");
      await this.deliver(
        msg,
        `任务编号「${ref}」命中 ${resolved.matches.length} 个任务（${ids}），请输入更长的编号。`,
      );
      return;
    }
    await this.deliver(msg, `未找到任务「${ref}」。`);
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  /** 看板投影：按 updatedAt 降序。 */
  listTasks(): QqTaskUi[] {
    return [...this.tasks.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt || a.taskId.localeCompare(b.taskId))
      .map((task) => this.toUi(task));
  }

  /** 按完整 id（或唯一短 id）取任务；找不到 / 歧义返回 null。 */
  getTask(taskId: string): QqTask | null {
    const resolved = this.resolveTaskRef(taskId);
    return resolved.kind === "found" ? resolved.task : null;
  }

  private toUi(task: QqTask): QqTaskUi {
    const ui: QqTaskUi = {
      taskId: task.taskId,
      shortId: shortTaskId(task.taskId),
      chatType: task.source.chatType,
      chatId: task.source.chatId,
      senderId: task.source.senderId,
      status: task.status,
      promptPreview: previewPrompt(task.payload.prompt),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
    const branch = task.correlation.branch ?? task.result?.branch;
    if (branch) ui.branch = branch;
    if (task.result) {
      ui.changes = task.result.changes.length;
      ui.additions = task.result.changes.reduce((sum, change) => sum + change.additions, 0);
      ui.deletions = task.result.changes.reduce((sum, change) => sum + change.deletions, 0);
    }
    if (task.result?.stopReason) ui.stopReason = task.result.stopReason;
    if (task.failure?.message) ui.errorMessage = task.failure.message;
    if (task.pending) {
      ui.pending = { kind: task.pending.kind, summary: task.pending.text };
    }
    return ui;
  }

  /**
   * 编号解析：完整 id 精确命中优先；否则按 id / 短 id 前缀匹配。
   * 只有唯一命中才生效，多命中明确报歧义（不猜一个「看起来最像」的）。
   */
  private resolveTaskRef(ref: string): TaskRefResolution {
    const needle = (typeof ref === "string" ? ref : "").trim();
    if (!needle) return { kind: "not_found" };
    const lower = needle.toLowerCase();

    const exact = [...this.tasks.values()].filter(
      (task) =>
        task.taskId.toLowerCase() === lower || shortTaskId(task.taskId).toLowerCase() === lower,
    );
    if (exact.length === 1) return { kind: "found", task: exact[0]! };
    if (exact.length > 1) return { kind: "ambiguous", matches: exact };

    const prefixed = [...this.tasks.values()].filter(
      (task) =>
        task.taskId.toLowerCase().startsWith(lower) ||
        shortTaskId(task.taskId).toLowerCase().startsWith(lower),
    );
    if (prefixed.length === 1) return { kind: "found", task: prefixed[0]! };
    if (prefixed.length > 1) return { kind: "ambiguous", matches: prefixed };
    return { kind: "not_found" };
  }

  // -------------------------------------------------------------------------
  // 落盘 / 通知 / 投递
  // -------------------------------------------------------------------------

  private async commitStatus(
    task: QqTask,
    next: QqTaskStatus,
    patch?: Partial<QqTask>,
  ): Promise<QqTask> {
    const latest = this.tasks.get(task.taskId) ?? task;
    const at = this.now();
    const outcome = transitionQqTask(latest, next, at);
    let updated: QqTask;
    if (outcome.noop) {
      if (outcome.error) {
        this.log(`QQ 任务 ${task.taskId}：${outcome.error.message}`);
      }
      if (!patch) return latest;
      updated = { ...latest, ...patch, updatedAt: Math.max(latest.updatedAt, at) };
    } else {
      updated = patch ? { ...outcome.task, ...patch } : outcome.task;
    }
    if (updated.updatedAt < at) updated = { ...updated, updatedAt: at };
    await this.persist(updated);
    if (!outcome.noop) {
      this.notify(
        `QQ 任务 ${shortTaskId(updated.taskId)} → ${qqTaskStatusLabel(updated.status)}`,
      );
    }
    return updated;
  }

  private async persist(task: QqTask): Promise<void> {
    this.tasks.set(task.taskId, task);
    this.idempotency.set(task.idempotencyKey, task.taskId);
    await this.store.saveTask(task as unknown as QqTaskRecord);
  }

  private async appendEvent(type: string, taskId?: string, detail?: unknown): Promise<void> {
    const event: QqTaskEvent = { type, ts: this.now() };
    if (taskId) event.taskId = taskId;
    if (detail !== undefined) event.detail = detail;
    try {
      await this.store.appendEvent(event);
    } catch (error) {
      this.log(`QQ 事件写入失败（${type}）：${errorText(error)}`);
    }
  }

  private notify(text: string): void {
    try {
      this.host.notify(text);
    } catch (error) {
      this.log(`QQ 通知失败：${errorText(error)}`);
    }
  }

  private async deliver(
    msg: Pick<InboundMessage, "chatType" | "chatId">,
    text: string,
    replyToMsgId?: string,
  ): Promise<boolean> {
    const payload: QqServiceDeliverInput = {
      chatType: msg.chatType,
      chatId: msg.chatId,
      text,
    };
    if (replyToMsgId) payload.replyToMsgId = replyToMsgId;
    try {
      return await this.host.deliver(payload);
    } catch (error) {
      this.log(`QQ 消息投递失败：${errorText(error)}`);
      return false;
    }
  }

  private async deliverTask(task: QqTask, text: string): Promise<boolean> {
    return this.deliver(
      { chatType: task.source.chatType, chatId: task.source.chatId },
      text,
      task.source.msgId,
    );
  }

  private async deliverResult(task: QqTask): Promise<void> {
    const profile = qqDetailProfile(this.config.resultDetail);
    const text = formatQqTaskSummary(task, profile.detail);
    const chunks = chunkQqText(text, profile.chunkChars);
    for (const chunk of chunks) {
      await this.deliverTask(task, chunk);
    }
  }
}
