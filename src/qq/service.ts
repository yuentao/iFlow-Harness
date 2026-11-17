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
 *  - 白名单不通过时**不回包、不执行任务**（防止探测通道是否存在），只写本地
 *    日志，并把这个人交给宿主的待审核队列（`onPendingUser`）—— 只有私聊，
 *    或「允许列表内的群」里的消息才会入队，避免任意群刷记录。
 *  - 白名单只有两个来源：扫码者本人（宿主在扫码成功时自动写入）与面板人工
 *    放行；没有任何聊天命令能把自己加进白名单。
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
import type { QqPendingUserInput } from "./pending-users.js";
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
  type QqTaskChannel,
  type QqTaskError,
  type QqTaskResult,
  type QqTaskStatus,
  type QqTaskUsage,
} from "../../shared/qq-task.js";
import { QQ_APPROVAL_TIMEOUT_MINUTES, maskQqOpenId } from "../../shared/qq-access.js";
import {
  buildQqHelpText,
  normalizeCommandText,
  parseQqCommand,
  type QqCommandIntent,
} from "../../shared/qq-command.js";
import type { Block, QqTaskUi, TurnChangeUi } from "../../shared/messages.js";

/**
 * 固定适配器前缀。阶段4 收敛为仅 QQBot 后，`iflow.qq.adapter` 设置项已移除，
 * 幂等键与任务来源统一用此常量，不再从配置读取。
 */
const QQ_ADAPTER = "qqbot";
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

/** 宿主派发结果：子会话 id，以及（worktree 隔离时的）分支名与工作目录。 */
export interface QqServiceDispatchResult {
  superSessionId: string;
  branch?: string;
  /**
   * worktree 的绝对路径（隔离执行时）。落进任务记录，供 manager 记录缺失时
   * 凭磁盘事实做合并 / 丢弃兜底。
   */
  worktreePath?: string;
}

/** 宿主对任务执行情况的只读快照（不知道的字段就别填）。 */
export interface QqServiceTaskOutcome {
  summary: string;
  stopReason?: string;
  /** 执行体自身的状态快照（如 running / merged / interrupted），原样透传。 */
  status?: string;
  changes?: Array<{ path: string; additions: number; deletions: number }>;
  usage?: unknown;
  branch?: string;
}

/** 一次投递的完整结果：`ok` 之外还带适配器的可重试判定（4xx 拒绝不重试）。 */
export interface QqDeliveryOutcome {
  ok: boolean;
  /** 适配器明确判定失败不值得重试（确定性拒绝）时才有值；缺省视为可重试。 */
  retryable?: boolean;
}

/** 发往 QQ 的文本消息。 */
export interface QqServiceDeliverInput {
  chatType: "private" | "group";
  chatId: string;
  text: string;
  replyToMsgId?: string;
  /**
   * 逻辑消息去重键：同一逻辑消息（含其全部重试）共用一个键，adapter 据此
   * 复用同一个 `msg_seq`，让 QQ 平台按 `(msg_id, msg_seq)` 去重 —— 网络
   * 超时但其实已送达的重试不会刷出重复消息。
   */
  dedupeKey?: string;
}

/**
 * 主会话注入：一次把消息投进主会话并等那一轮结束的完整输入。
 *
 * 排队/等待空闲由宿主实现（同一 ACP 会话上并发两个回合会把转录与上下文
 * 搅乱），服务只关心「是否真的投出去了」与「那一轮的 assistant 文本」。
 */
export interface QqMainInjectInput {
  /** 完整任务记录（宿主可读 source / payload，不得改写它）。 */
  task: QqTask;
  /** 模型可见正文（已含来源包裹）。 */
  text: string;
  /** 转录气泡正文（不含来源包裹；来源由 `origin` 标记）。 */
  displayText: string;
  /** 转录块来源标记，webview 据此渲染 QQ 徽标。 */
  origin: "qq";
  /**
   * 消息**真的投进主会话**时回调（这一轮已经开始）。服务据此把任务从
   * queued 切到 injected —— 排队等空闲不算注入。
   */
  onInjected: () => void | Promise<void>;
  /** 取消信号（`/qq stop`、服务停止）。宿主必须尽快放弃等待。 */
  signal: AbortSignal;
  /** 等待主会话空闲的上限（毫秒）；超时如实失败，不静默丢失。 */
  timeoutMs: number;
}

/** 一次主会话注入的结果（缺项保持 undefined，绝不编造）。 */
export interface QqMainInjectResult {
  /** 消息是否真的投进主会话并跑完了那一轮。 */
  injected: boolean;
  /** 那一轮 assistant 的正文（不含思考过程）；没有正文就是空串。 */
  text?: string;
  /** 那一轮的停止原因（end_turn / cancelled / error…）。 */
  stopReason?: string;
  /** 该轮以错误收尾（宿主状态为 error）。 */
  failed?: boolean;
  /** 未注入 / 失败的可读原因（如实报告给 QQ）。 */
  reason?: string;
  /** 被取消（`/qq stop` 或通道停止）：调用方不当作失败投递。 */
  canceled?: boolean;
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
  /**
   * 主会话渠道：把消息排队注入主会话，等这一轮结束后返回该轮 assistant 文本。
   *
   * 可选：只有 `iflow.qq.route = "main"` 的部署需要实现它；缺失时主会话渠道
   * 的任务会如实失败（`main_route_unavailable`），绝不退化成子会话。
   */
  injectIntoMainSession?(input: QqMainInjectInput): Promise<QqMainInjectResult>;
  /**
   * 停止某个主会话渠道路径上的任务：取消「等待空闲」与正在跑的那一轮。
   *
   * 返回是否真的命中（false = 该任务不在注入流程里，调用方按队列项处理）。
   */
  cancelMainInjection?(taskId: string): Promise<boolean> | boolean;
  /**
   * 回复一条 QQ 消息。返回完整投递结果：除 `ok` 外还透传适配器的
   * `retryable` 判定 —— 4xx 类确定性拒绝不该被上层重试循环再烧一遍。
   */
  deliver(msg: QqServiceDeliverInput): Promise<QqDeliveryOutcome>;
  /**
   * 白名单外的人发来消息：交给宿主的待审核队列。
   *
   * 语义是「**只记录**」——服务不会执行任务、也不会回执；宿主负责去重累积、
   * 落盘并在面板里展示，由用户决定放行（写进 `allowedUsers`）或拒绝。
   * 只有私聊，或「`allowedGroups` 内的群」的消息才会走到这里。
   *
   * 实现**不得抛错**（这里是消息处理路径，抛错会打断整条入站流程）。
   */
  onPendingUser(info: QqPendingUserInput): void;
  /** 解除当前账号绑定。 */
  unbindAccount(): Promise<{ ok: boolean; message: string }>;
  /** 本地通知（面板 toast / 日志），不发给 QQ。 */
  notify(text: string): void;
}

/** 构造参数。`now` / `log` / `onChanged` 可注入，便于单测确定化。 */
export interface QqServiceOptions {
  config: QqConfig;
  store: QqTaskStore;
  host: QqServiceHost;
  now?: () => number;
  log?: (line: string) => void;
  /**
   * 任务记录发生变化后的通知（宿主据此刷新 `SessionState.qqTasks` 投影）。
   *
   * 没有这条通道时看板只在「收到消息 / 改设置 / 重开面板」时刷新，于是任务
   * 被派发后卡片永远停在「已校验 · 耗时 0 秒 · 停止」——终态、真实耗时与
   * 动作按钮都不会跟随服务里的真实状态。实现在 `panel.ts`，只做投影重算。
   */
  onChanged?: () => void;
  /** 结果回包重试的基础间隔（毫秒，缺省 {@link QQ_DELIVERY_RETRY_DELAY_MS}）。 */
  deliveryRetryDelayMs?: number;
  /**
   * 终态任务的保留天数（`start()` 时按它清理归档）。
   *
   * 缺省 {@link QQ_DEFAULT_RETENTION_DAYS}；`<= 0` 表示关闭清理（一条都不删）。
   * 只删「终态 + 超期」的任务，非终态永远不动。
   */
  taskRetentionDays?: number;
  /**
   * 单调时钟（毫秒）。限流滑动窗口与进度节流只关心时间差，必须免疫系统
   * 时间回拨（NTP / 手动改表能把「60 秒窗口」变成永久窗口或瞬间重置）。
   * 缺省 `performance.now()`，环境没有时退回 `Date.now()`。
   */
  monotonicNow?: () => number;
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

/**
 * 审批码有效期：与 UI 文案同源（`shared/qq-access.ts` 的
 * {@link QQ_APPROVAL_TIMEOUT_MINUTES}），不在两处各写一份分钟数。
 */
export const QQ_APPROVAL_TIMEOUT_MS = QQ_APPROVAL_TIMEOUT_MINUTES * 60_000;
/** 验证码最多尝试次数：第一次错误后仍保留 2 次机会。 */
export const QQ_APPROVAL_MAX_ATTEMPTS = 3;
/** `status` 无编号时回显的最近任务条数。 */
export const QQ_RECENT_TASK_LIMIT = 5;
/** 看板条目里提示词预览的字符上限。 */
export const QQ_PROMPT_PREVIEW_CHARS = 80;
/** 结果回包最多尝试次数（含首次）。 */
export const QQ_DELIVERY_ATTEMPTS = 3;
/** 结果回包重试的基础退避（毫秒，逐次递增）。 */
export const QQ_DELIVERY_RETRY_DELAY_MS = 400;
/** 执行体没有产出任何摘要正文时的如实说明（不编造内容）。 */
export const QQ_EMPTY_SUMMARY_NOTICE = "（执行体未返回摘要内容）";
/** 结果彻底没能送达 QQ 时记录在任务上的文案。 */
export const QQ_RESULT_UNDELIVERED = "结果未能送达 QQ（被动回复与主动消息均失败）";
/**
 * 运行中刷新的进度消息最小投递间隔（毫秒）。
 *
 * QQ 同一个 `msg_id` 的被动回复条数有上限（常见口径 5 条，见
 * {@link deliverTaskText}），「已受理 + 审批请求 + 审批结果 + 终态结果」已经
 * 占掉 4 条；用户连点几次 `/qq refresh` 就会把配额烧光，终态结果只能靠主动
 * 消息额度（同样受限）。因此同一任务的进度快照在本地按此间隔节流：间隔内的
 * 重复刷新复用上一次投递，不再新开被动回复序号。
 */
export const QQ_PROGRESS_REFRESH_MIN_INTERVAL_MS = 60_000;
/**
 * 重启后补发「终态但未送达」结果的最小重试间隔（毫秒）。
 *
 * 已送达的任务由 `resultDeliveredAt` 挡住（永不重发）；投递失败的任务需要
 * 在下次开窗时补一次，但连续开关面板不能每次都把失败重试一遍 —— 用持久化
 * 的 `resultDeliveryAttemptAt`（见 `shared/qq-task.ts`）设最小间隔。
 */
export const QQ_RESULT_RESTORE_RETRY_MS = 10 * 60_000;
/** 投递窗口内结果被刷新改写时的可观测提示（不写锚点，下次刷新会重投）。 */
export const QQ_RESULT_CHANGED_WHILE_DELIVERING =
  "投递期间结果已被更新，本次不记为已送达（下次刷新会重投）";
/**
 * 终态任务的默认保留天数（`start()` 时清理超期的终态归档）。
 *
 * 归档只增不减会让 `tasks/` 无限膨胀；30 天足够覆盖「回来看看上周干了什么」，
 * 又不会把近期任务清掉。非终态任务从不清理。
 */
export const QQ_DEFAULT_RETENTION_DAYS = 30;

/**
 * 主会话渠道等待「主会话空闲」的上限。
 *
 * 本地回合可能跑很久（真实任务没有超时），所以这个上限只是「永远等不到」
 * 的兜底：超时按失败如实回包（含原因），绝不静默丢弃这条 QQ 消息。
 */
export const QQ_MAIN_INJECT_TIMEOUT_MS = 2 * 60 * 60_000;

/**
 * 主会话注入的模型可见正文：来源包裹 + 正文。
 *
 * 为什么必须有包裹：QQ 消息是**外部渠道**输入，可信度不能等同于本机用户
 * 亲手敲的字。模型据此把它当任务描述处理（而不是系统指令），同时知道本轮
 * 回复会原样发回 QQ。发送方 id 一律脱敏（`maskQqOpenId`），不回显完整
 * openid；正文逐字保留，宿主不改写用户内容。
 */
export function buildQqMainPrompt(task: QqTask): string {
  const sender = maskQqOpenId(task.source.senderId) || "（未知用户）";
  const header =
    task.source.chatType === "group"
      ? `[来自 QQ 群 ${maskQqOpenId(task.source.chatId)} 的用户 ${sender} 的消息]`
      : `[来自 QQ 用户 ${sender} 的消息]`;
  const lines = [
    header,
    "（这是通过 QQ 机器人转来的外部消息，不是本机用户的直接输入。请把它当作任务描述来处理；" +
      "本轮的最终回复会原样发回 QQ，因此回复里不要包含本机路径、凭据或与任务无关的本地信息。）",
  ];
  if (task.payload.attachments.length > 0) {
    lines.push("", "附件引用（QQ 侧，仅供说明）：");
    for (const attachment of task.payload.attachments) lines.push(`- ${attachment}`);
  }
  lines.push("", task.payload.prompt);
  return lines.join("\n");
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

/**
 * 停止原因的归一化形式（trim + 小写 + 取消拼写归一），供终态映射与失败判定
 * 共用。
 *
 * 执行体可能上报 `canceled`（美式）或 `cancelled`（英式）：两者是同一次取消，
 * 必须在归一化层收敛，否则 `cancelled` 会落进 {@link FAILURE_STOP_REASONS}
 * 被记成 `failed`，同一个动作在两种拼写下得到不同终态。
 */
function normalizedStopReason(reason: string): string {
  const normalized = reason.trim().toLowerCase();
  return normalized === "cancelled" ? "canceled" : normalized;
}

function isFailureStopReason(reason: string): boolean {
  return FAILURE_STOP_REASONS.has(normalizedStopReason(reason));
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

/**
 * 分片内容的稳定指纹（djb2，非加密用途）。
 *
 * 参与指纹的是「片数 + 每片全文」：任一片文本变化（结果更新 / 详略档位调整
 * 都会改变分片序列）就得到不同指纹，防止部分送达锚点基于过期内容截断新结果。
 * 导出仅供单测验证语义。
 */
export function fingerprintChunks(chunks: readonly string[]): string {
  let hash = 5381;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      hash = ((hash * 33) ^ chunk.charCodeAt(i)) >>> 0;
    }
    hash = (hash * 33) >>> 0;
  }
  return `${chunks.length}:${hash.toString(36)}`;
}

/**
 * 两条任务记录是否在看板投影上有可见差异。
 *
 * 覆盖看板会展示的全部字段（状态、时间、等待项、结果、失败、关联、回包锚点
 * 与部分送达进度）。复合字段用稳定序列化（JSON 字符串）做深比较：同一记录
 * 被 spread / 落盘读回重建（深等价、对象引用不同）不重复推快照，只有任一
 * 字段**内容**变化（含同毫秒内仅 pending 从有到无）才推 —— 不漏推也不
 * 噪音推送。导出仅供单测验证两向语义。
 */
export function qqTaskProjectionChanged(a: QqTask, b: QqTask): boolean {
  return (
    a.status !== b.status ||
    a.updatedAt !== b.updatedAt ||
    a.resultDeliveredAt !== b.resultDeliveredAt ||
    a.deliveryError !== b.deliveryError ||
    signature(a.resultDeliveredChunks) !== signature(b.resultDeliveredChunks) ||
    signature(a.pending) !== signature(b.pending) ||
    signature(a.result) !== signature(b.result) ||
    signature(a.failure) !== signature(b.failure) ||
    signature(a.correlation) !== signature(b.correlation)
  );
}

/** 复合字段的稳定签名（undefined 与缺失键统一为 "null"）。 */
function signature(value: unknown): string {
  return JSON.stringify(value ?? null);
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
    // 渠道是任务自己的事实（跨重启保留）；旧归档没有该键 → 缺省（child）。
    ...(raw.channel === "main" || raw.channel === "child" ? { channel: raw.channel } : {}),
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
      ...(typeof correlation.worktreePath === "string"
        ? { worktreePath: correlation.worktreePath }
        : {}),
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
  // 回包幂等锚点与回包失败记录必须一起还原：丢了 resultDeliveredAt，重启后
  // 已成功投递过的终态任务会被再发一遍；丢了 deliveryError，失败痕迹就消失。
  if (typeof raw.resultDeliveredAt === "number" && Number.isFinite(raw.resultDeliveredAt)) {
    task.resultDeliveredAt = raw.resultDeliveredAt;
  }
  if (typeof raw.deliveryError === "string" && raw.deliveryError.length > 0) {
    task.deliveryError = raw.deliveryError;
  }
  // 回包尝试时刻：重启补发用它做最小间隔节流，丢了就退化成「每次开窗重试」。
  if (
    typeof raw.resultDeliveryAttemptAt === "number" &&
    Number.isFinite(raw.resultDeliveryAttemptAt)
  ) {
    task.resultDeliveryAttemptAt = raw.resultDeliveryAttemptAt;
  }
  // 部分送达续发锚点也要还原：丢了它，重启后已经送达的几片会被重发一遍。
  if (
    isRecord(raw.resultDeliveredChunks) &&
    typeof raw.resultDeliveredChunks.count === "number" &&
    Number.isFinite(raw.resultDeliveredChunks.count) &&
    typeof raw.resultDeliveredChunks.fingerprint === "string"
  ) {
    task.resultDeliveredChunks = {
      count: Math.max(0, Math.floor(raw.resultDeliveredChunks.count)),
      fingerprint: raw.resultDeliveredChunks.fingerprint,
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
  /** 单调时钟：只用于时间差（限流窗口 / 进度节流），不写进任何持久化字段。 */
  private readonly monotonic: () => number;
  /** 终态任务保留天数（<=0 关闭启动清理）。 */
  private readonly taskRetentionDays: number;
  private readonly log: (line: string) => void;
  private readonly onChanged: () => void;
  private readonly deliveryRetryDelayMs: number;

  private readonly tasks = new Map<string, QqTask>();
  private readonly idempotency = new Map<string, string>();
  private readonly queue: string[] = [];
  private readonly jobs = new Set<Promise<void>>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  /** 每个发送者的滑动窗口（毫秒时间戳，保留最近 60s）。 */
  private readonly rateWindows = new Map<string, number[]>();

  private runningCount = 0;
  /**
   * 主会话注入是否有一轮在跑 / 在等空闲。
   *
   * 同一 ACP 会话上不能并发两个回合，所以主会话渠道**串行**：队列里只要还有
   * 一轮注入没结束，后面的任务（含子会话渠道）都留在队列里等 —— 严格 FIFO，
   * 不插队。
   */
  private mainInFlight = false;
  /**
   * 主会话注入的取消信号。`stop()` 时 abort：正在等空闲的注入立刻放弃，
   * 绝不把消息投进一个已经停用的通道。
   */
  private abortController = new AbortController();
  private stopped = false;
  private started = false;
  /** 验证码随机源（测试可以替换成确定值）。 */
  private random: () => number = Math.random;
  /**
   * 正在投递终态结果的任务：taskId → 该次投递的 promise。
   *
   * 幂等锚点（resultDeliveredAt）要等全部分片发完才落盘 —— 只靠锚点挡不住
   * 投递窗口内的并发触发（单次发送 10s 超时 + 重试退避，窗口可达数十秒），
   * 期间再刷新 / 重复事件会读到「未投递」而二次发送。这里存的是 promise
   * 而不是纯标记：并发触发 await 同一次投递，拿到的是真实收尾后的任务
   * （旧实现直接返回内存快照，并发刷新等于静默无效）。
   */
  private readonly deliveringResults = new Map<string, Promise<QqTask>>();
  /**
   * 运行中进度回包的节流记账（taskId → 上次进度投递时刻）。
   *
   * 同状态在 {@link QQ_PROGRESS_REFRESH_MIN_INTERVAL_MS} 内的重复刷新直接
   * 复用上一次投递（同一个稳定 dedupeKey → adapter 复用同一个 msg_seq），
   * 不让每次点击都新开一条被动回复。
   */
  private readonly progressRefreshes = new Map<string, number>();
  /** 逻辑投递去重键的递增序号（配合 taskId 生成全局唯一的 dedupeKey）。 */
  private deliverySeqCounter = 0;

  constructor(options: QqServiceOptions) {
    this.config = options.config;
    this.store = options.store;
    this.host = options.host;
    this.now = options.now ?? (() => Date.now());
    this.monotonic =
      options.monotonicNow ??
      (typeof performance !== "undefined" && typeof performance.now === "function"
        ? () => performance.now()
        : () => Date.now());
    this.taskRetentionDays =
      typeof options.taskRetentionDays === "number" && Number.isFinite(options.taskRetentionDays)
        ? options.taskRetentionDays
        : QQ_DEFAULT_RETENTION_DAYS;
    this.log = options.log ?? (() => undefined);
    this.onChanged = options.onChanged ?? (() => undefined);
    this.deliveryRetryDelayMs =
      typeof options.deliveryRetryDelayMs === "number" &&
      Number.isFinite(options.deliveryRetryDelayMs) &&
      options.deliveryRetryDelayMs >= 0
        ? options.deliveryRetryDelayMs
        : QQ_DELIVERY_RETRY_DELAY_MS;
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
    // 上一次 stop() 可能已经 abort 过：新的一轮生命周期必须拿到新信号，
    // 否则主会话注入会在启动瞬间被自己判成「已取消」。
    this.abortController = new AbortController();

    // 启动时先清理超期的终态归档：只在加载前做，内存里就不会再出现刚被删掉
    // 的任务。清理失败只记日志，不挡启动。
    await this.pruneArchivedTasks();

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

    const interrupted = new Set<string>();
    for (const task of [...this.tasks.values()]) {
      if (isTerminalStatus(task.status)) continue;
      const at = this.now();
      // 重启时任务停在哪一步决定 QQ 该收到什么：还在排队（从未投出）的要
      // 明确说「没执行，请重发」；已经注入/执行中的只能如实说「中断」。
      const wasQueued = task.status === "received" || task.status === "validated" || task.status === "queued";
      const outcome = transitionQqTask(task, "failed", at);
      const base = outcome.noop ? task : outcome.task;
      const interruptedTask: QqTask = {
        ...base,
        updatedAt: Math.max(base.updatedAt, at),
        failure: {
          code: "host_restarted",
          message: wasQueued
            ? "扩展宿主已重启，任务未执行（请重发）。"
            : "扩展宿主已重启，任务中断。",
        },
        pending: undefined,
      };
      try {
        await this.persist(interruptedTask);
        await this.appendEvent("task_interrupted", interruptedTask.taskId, {
          reason: "host_restarted",
          wasQueued,
        });
      } catch (error) {
        this.log(`QQ 任务 ${interruptedTask.taskId} 中断回写失败：${errorText(error)}`);
      }
      interrupted.add(interruptedTask.taskId);
      this.notify(`QQ 任务 ${shortTaskId(interruptedTask.taskId)} 因宿主重启标记为失败`);
      // 进程换了，QQ 那侧不能只剩一条「已受理」：中断本身也要有一条回包。
      await this.deliverInterruption(interruptedTask, { neverRan: wasQueued }).catch(
        (error: unknown) => {
          this.log(`QQ 任务 ${interruptedTask.taskId} 中断通知发送失败：${errorText(error)}`);
        },
      );
    }

    // 重启补发：终态但结果没送达的任务（进程在投递中途退出、配额耗尽、
    // 主动消息额度用完…）在下次开窗时补一次。幂等由 resultDeliveredAt 保证
    // （已送达的永不重发），失败重试由持久化的 resultDeliveryAttemptAt 设
    // 最小间隔 —— 否则「每次开窗都重试一遍」会变成另一种刷屏。
    for (const task of [...this.tasks.values()]) {
      if (this.stopped) return;
      if (!isTerminalStatus(task.status)) continue;
      if (interrupted.has(task.taskId)) continue;
      if (task.resultDeliveredAt !== undefined) continue;
      const lastAttempt = task.resultDeliveryAttemptAt;
      if (
        typeof lastAttempt === "number" &&
        Number.isFinite(lastAttempt) &&
        // 单调化：系统时间回拨时 `now - lastAttempt` 会变成负数，直接比较会
        // 把「刚失败过」误判成「很久没试」；夹到 0 即保持节流语义。
        Math.max(0, this.now() - lastAttempt) < QQ_RESULT_RESTORE_RETRY_MS
      ) {
        continue;
      }
      try {
        // 重启补发走主动消息：adapter 的 replySeq 是纯内存的，进程换了以后
        // 从 1 重开，与重启前已用的 (msg_id, seq) 撞车会被平台静默去重
        // —— 结果缺尾却写成「已送达」。主动消息不带 msg_id，天然绕开该去重键。
        await this.deliverResult(task, { forceActive: true });
      } catch (error) {
        this.log(`QQ 任务 ${task.taskId} 重启补发终态结果失败：${errorText(error)}`);
      }
    }
  }

  /**
   * 按 `taskRetentionDays` 清理超期的终态归档（`<=0` 关闭）。
   *
   * 只清「终态 + 超期」：store 在删除前会再读一次任务文件核对状态与更新时间，
   * 索引陈旧也不会误删在跑的任务（见 `QqTaskStore.pruneTasks`）。清理失败只
   * 记日志，绝不挡启动。
   */
  private async pruneArchivedTasks(): Promise<void> {
    const days = this.taskRetentionDays;
    if (!(days > 0)) return;
    try {
      const result = await this.store.pruneTasks(days);
      if (result.deleted.length > 0) {
        this.log(
          `QQ 归档清理：删除 ${result.deleted.length} 个超过 ${days} 天的终态任务` +
            (result.skipped.length > 0 ? `，跳过 ${result.skipped.length} 个` : ""),
        );
        await this.appendEvent("tasks_pruned", undefined, {
          days,
          deleted: result.deleted.length,
          skipped: result.skipped.length,
        });
      } else if (result.skipped.length > 0) {
        this.log(`QQ 归档清理：跳过 ${result.skipped.length} 个无法读取的任务文件`);
      }
    } catch (error) {
      this.log(`QQ 归档清理失败：${errorText(error)}`);
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
    // 正在等空闲 / 正在注入的任务：立刻放弃（宿主侧看到 signal 就 unwait）。
    // 队列是内存态，未投出的条目由宿主重启路径如实告知（见 start()）。
    this.abortController.abort();
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
   * 白名单是唯一的执行闸门：命中才解析命令 / 建任务；未命中时**不回包、不建
   * 任务**，只把发送者交给宿主的待审核队列（`onPendingUser`）。入队条件与频道
   * 边界同源——私聊，或「`allowedGroups` 内的群」；其余群直接忽略，避免任何人
   * 把机器人拉进群就能刷出记录。
   *
   * 命令解析失败与未知子命令会回一句可读错误（用户自己打错的字，不是探测）。
   */
  async handleInboundMessage(msg: InboundMessage): Promise<void> {
    const rawText = typeof msg?.text === "string" ? msg.text : "";
    const accepted = this.acceptInbound(msg);
    if (!accepted.ok) {
      if (accepted.pending) {
        this.host.onPendingUser(accepted.pending);
        this.notify(
          `QQ 消息来自白名单外的用户 ${maskQqOpenId(accepted.pending.openid)}，已记入待审核`,
        );
        this.log(`QQ 入站消息待审核：${accepted.reason}`);
      } else {
        this.notify(`QQ 消息被忽略：${accepted.reason}`);
        this.log(`QQ 入站消息被忽略：${accepted.reason}`);
      }
      return;
    }

    const parsed = parseQqCommand(normalizeCommandText(rawText));
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

  /**
   * 入站准入。
   *
   * 命中白名单才放行；未命中时若消息来自「私聊」或「`allowedGroups` 内的群」，
   * 额外返回一条待审核记录（`pending`）——服务不执行任务也不回执，由宿主
   * 决定放行（写进白名单）还是拒绝。其余群直接忽略，不做记录。
   */
  private acceptInbound(
    msg: InboundMessage,
  ): { ok: true } | { ok: false; reason: string; pending?: QqPendingUserInput } {
    if (!msg || (msg.chatType !== "private" && msg.chatType !== "group")) {
      return { ok: false, reason: "无效的会话类型" };
    }
    const openid = typeof msg.senderId === "string" ? msg.senderId.trim() : "";
    if (openid.length === 0) {
      return { ok: false, reason: "缺少发送者标识" };
    }
    if (!this.config.allowedUsers.includes(openid)) {
      return this.pendingDecision(msg, openid, `发送者 ${maskQqOpenId(openid)} 不在白名单`);
    }
    if (msg.chatType === "group") {
      if (!this.config.allowedGroups.includes(msg.chatId)) {
        return { ok: false, reason: `群 ${maskQqOpenId(msg.chatId)} 不在允许列表` };
      }
      if (msg.mentionsBot !== true) {
        return { ok: false, reason: `群 ${maskQqOpenId(msg.chatId)} 的消息没有 @ 机器人` };
      }
    }
    return { ok: true };
  }

  /**
   * 白名单未命中的分流：能入待审核队列的给出记录，其余只给忽略原因。
   *
   * 记录范围严格收窄到「私聊」与「`allowedGroups` 内的群」——否则任何人把
   * 机器人拉进自己的群，就能往面板里刷待审核记录。
   */
  private pendingDecision(
    msg: InboundMessage,
    openid: string,
    reason: string,
  ): { ok: false; reason: string; pending?: QqPendingUserInput } {
    const preview = typeof msg.text === "string" ? msg.text : "";
    const at = this.now();
    if (msg.chatType === "group") {
      if (!this.config.allowedGroups.includes(msg.chatId)) {
        return { ok: false, reason: `${reason}（群 ${maskQqOpenId(msg.chatId)} 不在允许列表）` };
      }
      return {
        ok: false,
        reason,
        pending: { openid, chatType: "group", groupId: msg.chatId, preview, at },
      };
    }
    return {
      ok: false,
      reason,
      pending: { openid, chatType: "private", preview, at },
    };
  }

  // -------------------------------------------------------------------------
  // 建任务 / 限流 / 调度
  // -------------------------------------------------------------------------

  private async createTaskFromMessage(msg: InboundMessage, prompt: string): Promise<void> {
    const key = makeIdempotencyKey(QQ_ADAPTER, msg.msgId);
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
      this.notify(
        `QQ 用户 ${maskQqOpenId(msg.senderId)} 触发限流（每分钟 ${limit} 条）`,
      );
      await this.deliver(msg, `请求过于频繁，每分钟最多 ${limit} 条任务，请稍后再试。`);
      return;
    }

    const attachments = msg.attachments
      .map(attachmentRef)
      .filter((ref): ref is string => typeof ref === "string" && ref.length > 0);

    const created = createQqTask(
      {
        adapter: QQ_ADAPTER,
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
        channel: this.channelForNewTask(),
      },
      { now: this.now },
    );

    let task = await this.commitStatus(created, "validated");
    task = await this.commitStatus(task, "queued");
    await this.appendEvent("task_created", task.taskId, {
      chatType: msg.chatType,
    });

    if (this.taskChannel(task) === "main") {
      // 主会话渠道：先入队（位次才能算准），**立刻**回一条排队确认 ——
      // 用户不必等主会话空闲就能知道消息被接住了、排在第几位。
      // 去重键与被动回复的 msg_id 沿用现有回包通道（重试不会刷出第二条）。
      this.queue.push(task.taskId);
      const position = this.mainQueuePosition(task.taskId);
      await this.deliver(
        msg,
        `任务 ${shortTaskId(task.taskId)} 已排队（第 ${position} 位），主会话空闲后开始执行。`,
        msg.msgId,
        `qq-queued:${task.taskId}`,
      );
      this.pump();
      return;
    }

    await this.deliver(msg, `已受理任务 ${shortTaskId(task.taskId)}，排队中。`, msg.msgId);
    this.enqueue(task.taskId);
  }

  /** 新任务该走的渠道（`iflow.qq.route`；未知值按旧行为 child）。 */
  private channelForNewTask(): QqTaskChannel {
    return this.config.route === "main" ? "main" : "child";
  }

  /** 任务自己的渠道（旧归档没有该字段 → child，与历史行为一致）。 */
  private taskChannel(task: QqTask): QqTaskChannel {
    return task.channel === "main" ? "main" : "child";
  }

  /**
   * 主会话渠道的排队位次（1 = 下一条；已有一轮在注入时它占第 1 位）。
   *
   * 只数**主会话渠道**的非终态项：子会话任务不占主会话这一条线，把它们算进
   * 位次会让用户以为要等很久。
   */
  private mainQueuePosition(taskId: string): number {
    let position = this.mainInFlight ? 2 : 1;
    for (const id of this.queue) {
      if (id === taskId) break;
      const task = this.tasks.get(id);
      if (task && this.taskChannel(task) === "main" && !isTerminalStatus(task.status)) {
        position += 1;
      }
    }
    return position;
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
    // 单调时钟：窗口是「过去 60 秒」的相对量，用墙上时钟会在回拨时把整个
    // 窗口瞬间清空（等于放开限流）。这里的时间戳只在内存里比较，不落盘。
    const at = this.monotonic();
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

  /**
   * 按 FIFO 启动排队任务。
   *
   * 两条纪律：
   *  - **主会话渠道串行**：同一 ACP 会话上并发两个回合会乱序，所以只要有一轮
   *    注入在跑/在等空闲，队列整体停住（严格 FIFO，后面的子会话任务也不超车）；
   *  - 子会话渠道沿用并发上限（`maxConcurrentTasks`），与旧行为一致。
   */
  private pump(): void {
    if (this.stopped) return;
    const limit = Math.max(1, this.config.maxConcurrentTasks);
    while (this.queue.length > 0) {
      const taskId = this.queue[0]!;
      const task = this.tasks.get(taskId);
      if (!task || isTerminalStatus(task.status)) {
        this.queue.shift();
        continue;
      }

      const main = this.taskChannel(task) === "main";
      if (main) {
        if (this.mainInFlight) return;
      } else if (this.runningCount >= limit) {
        return;
      }

      this.queue.shift();
      if (main) this.mainInFlight = true;
      else this.runningCount += 1;

      const job = this.runTask(taskId)
        .catch((error: unknown) => {
          this.log(`QQ 任务 ${taskId} 调度异常：${errorText(error)}`);
        })
        .finally(() => {
          if (main) this.mainInFlight = false;
          else this.runningCount = Math.max(0, this.runningCount - 1);
          this.jobs.delete(job);
          this.pump();
        });
      this.jobs.add(job);

      // 队首的主会话任务已占用唯一那条注入线：后面的任务必须等它结束。
      if (main) return;
    }
  }

  // -------------------------------------------------------------------------
  // 单任务执行
  // -------------------------------------------------------------------------

  private async runTask(taskId: string): Promise<void> {
    const initial = this.tasks.get(taskId);
    if (!initial || isTerminalStatus(initial.status)) return;

    if (this.taskChannel(initial) === "main") {
      await this.runMainTask(initial);
      return;
    }

    let task = initial;
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
          ...(dispatched.worktreePath ? { worktreePath: dispatched.worktreePath } : {}),
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

  /**
   * 主会话渠道：把消息排队注入主会话，等那一轮的 assistant 回复，回传 QQ。
   *
   * 轮次锚定（最容易错的地方）：
   *  - 注入由 `host.injectIntoMainSession` **一次只发一轮**，返回的就是那一轮
   *    的正文 —— 宿主在轮次开始时记下文本块基线，轮次结束后只取基线之后的
   *    assistant 文本（不含思考），因此不会把上一轮或后续无关轮次的输出当
   *    本轮结果；
   *  - `onInjected` 只在消息**真的投出**时触发（排队等空闲不算），看板据此
   *    从「排队中」切到「已注入待回复」；
   *  - 任务一旦被 `/qq stop` / 看板停止收尾（终态），这里不再写结果、不再
   *    回包 —— 结果只回传一次，且只属于它自己那一轮。
   */
  private async runMainTask(task: QqTask): Promise<void> {
    const taskId = task.taskId;
    try {
      const inject = this.host.injectIntoMainSession;
      if (!inject) {
        await this.failTask(
          task,
          "main_route_unavailable",
          "当前宿主未实现主会话注入（iflow.qq.route=main），请改用 child 渠道或更新扩展。",
        );
        return;
      }

      const result = await inject({
        task,
        text: buildQqMainPrompt(task),
        displayText: task.payload.prompt,
        origin: "qq",
        signal: this.abortController.signal,
        timeoutMs: QQ_MAIN_INJECT_TIMEOUT_MS,
        onInjected: async () => {
          const current = this.tasks.get(taskId);
          if (!current || isTerminalStatus(current.status)) return;
          await this.commitStatus(current, "injected");
        },
      });

      if (this.stopped) return;
      const latest = this.tasks.get(taskId) ?? task;
      // 已被停止（/qq stop / 看板）收尾并回包：这一轮的任何输出都不再回传。
      if (isTerminalStatus(latest.status)) return;
      if (result.canceled) {
        // 正常情况下 `/qq stop` 已经把任务收在 canceled 并回过一条状态（上面
        // 的终态检查会直接返回）。这里兜住「取消来自宿主、但没有对应的用户
        // 停止」的情形：任务不能永远停在排队中。
        this.log(`QQ 任务 ${taskId} 主会话注入被取消`);
        const cleared = await this.commitStatus(
          { ...latest, pending: undefined },
          "canceled",
          { pending: undefined },
        );
        await this.appendEvent("task_canceled", cleared.taskId, { channel: "main" });
        await this.deliverTask(cleared, `已取消任务 ${shortTaskId(cleared.taskId)}。`);
        return;
      }
      if (!result.injected) {
        await this.failTask(
          latest,
          "main_inject_failed",
          result.reason && result.reason.trim().length > 0
            ? result.reason
            : "消息未能注入主会话。",
        );
        return;
      }

      const rawStop = (result.stopReason ?? "").trim();
      const stopReason = rawStop.length > 0 ? rawStop : result.failed ? "error" : "end_turn";
      const summary = (result.text ?? "").trim();
      const qqResult = this.buildResult({ summary, stopReason }, stopReason, latest, undefined);

      let status: QqTaskStatus;
      let failure: QqTaskError | undefined;
      // ACP 的停止原因是英式拼写 `cancelled`；本仓库其它路径用 `canceled`。
      // 两种都按「用户取消」收尾 —— 取消不是执行故障，不该在 QQ 侧报失败。
      const stopKey = normalizedStopReason(stopReason);
      if (stopKey === "canceled" || stopKey === "cancelled") {
        status = "canceled";
        failure = { code: "agent_canceled", message: `执行结束：${stopReason}` };
      } else if (result.failed === true || isFailureStopReason(stopReason)) {
        status = "failed";
        failure = {
          code: "main_turn_failed",
          message: result.reason && result.reason.trim().length > 0
            ? result.reason
            : `执行结束：${stopReason}`,
        };
      } else {
        status = "succeeded";
      }

      // 防御：面板已在轮次开始时回调过 onInjected，但那次落盘可能没走到。
      // 仍停在 queued 就直接收终态会让迁移表拒绝（queued→succeeded 非法），
      // 结果永远是「排队中」。先补一次 injected。
      const base = latest.status === "queued"
        ? await this.commitStatus(latest, "injected")
        : latest;

      const at = this.now();
      const patched: QqTask = {
        ...base,
        result: qqResult,
        failure,
        pending: undefined,
        updatedAt: Math.max(base.updatedAt, at),
      };
      const updated = await this.commitStatus(patched, status, {
        result: qqResult,
        failure,
        pending: undefined,
      });
      await this.appendEvent(
        status === "succeeded" ? "task_succeeded" : "task_finished",
        updated.taskId,
        { status, stopReason, channel: "main" },
      );
      await this.deliverResult(updated);
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
    // 执行体确认取消（子会话被 cancel 后的终态 / 停止原因 "canceled"）：
    // 终态与 `/qq stop` 直接路径对齐为 canceled，不再记成 failed —— 取消是
    // 用户主动动作，不是执行故障，看板与失败告警都不该把它当失败。其余
    // 失败类停止原因（error / failed / interrupted…）仍按失败处理。
    if (normalizedStopReason(stopReason) === "canceled") {
      status = "canceled";
      // 取消是用户主动动作：`failure.code` 保留给状态机判别，消息本身是中性的
      // 「停止原因」，看板/摘要各自渲染成「已取消（…）」，不再显示「执行失败」。
      failure = { code: "agent_canceled", message: `停止原因：${stopReason}` };
    } else if (isFailureStopReason(stopReason)) {
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
    const ok = await this.deliverTaskTextWithRetry(
      updated,
      `任务 ${shortTaskId(updated.taskId)} 失败：${message}`,
    );
    if (ok) return;
    const undelivered: QqTask = {
      ...(this.tasks.get(updated.taskId) ?? updated),
      deliveryError: QQ_RESULT_UNDELIVERED,
    };
    await this.persist(undelivered);
    await this.appendEvent("task_result_undelivered", updated.taskId, {
      error: QQ_RESULT_UNDELIVERED,
    });
    this.notify(`QQ 任务 ${shortTaskId(updated.taskId)} 的失败通知未能送达 QQ`);
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
    await this.deliverTaskNotice(
      waiting,
      [
        `任务 ${shortTaskId(taskId)} 请求审批${detail}`,
        `回复 /qq approve ${shortTaskId(taskId)} ${code} 批准，`,
        `/qq deny ${shortTaskId(taskId)} 拒绝（${QQ_APPROVAL_TIMEOUT_MINUTES} 分钟内有效）。`,
      ].join("\n"),
      `approval:${taskId}:${code}`,
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
    await this.deliverTaskNotice(
      updated,
      `任务 ${shortTaskId(taskId)} 审批超时（${QQ_APPROVAL_TIMEOUT_MINUTES} 分钟），已按拒绝处理。`,
      `approval-result:${taskId}:${code}:timeout`,
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
    options?: { force?: boolean },
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
        await this.discardTask(task, options?.force === true);
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
      await this.deliverTaskNotice(
        updated,
        `任务 ${shortTaskId(task.taskId)} 已批准。`,
        `approval-result:${task.taskId}:${entry.code}:approved`,
      );
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
    await this.deliverTaskNotice(
      updated,
      `验证码错误次数过多，任务 ${shortTaskId(task.taskId)} 已按拒绝处理。`,
      `approval-result:${task.taskId}:${entry.code}:denied`,
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
    await this.deliverTaskNotice(
      updated,
      `任务 ${shortTaskId(task.taskId)} 已拒绝。`,
      `approval-result:${task.taskId}:${entry.code}:denied`,
    );
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
    // 主会话渠道的任务可能已被取出、正「等空闲」，状态仍是 queued —— 对用户
    // 来说那同样是排队项，取消文案要说「已取消排队」而不是「已请求停止」。
    const wasQueued = queuedAt >= 0 || current.status === "queued";
    if (queuedAt >= 0) this.queue.splice(queuedAt, 1);

    const superSessionId = current.correlation.superSessionId;
    const failures: string[] = [];
    if (superSessionId) {
      try {
        await this.host.cancelTask(superSessionId);
      } catch (error) {
        const detail = errorText(error);
        failures.push(`子会话取消失败：${detail}`);
        this.log(`QQ 任务 ${current.taskId} 取消失败：${detail}`);
      }
    }

    // 主会话渠道：任务可能正「等空闲」或正跑在唯一那条注入线上。宿主要
    // 立刻放弃等待 / 打断那一轮；否则用户以为停了，QQ 却还会收到结果。
    if (this.taskChannel(current) === "main") {
      try {
        await this.host.cancelMainInjection?.(current.taskId);
      } catch (error) {
        const detail = errorText(error);
        failures.push(`主会话注入取消失败：${detail}`);
        this.log(`QQ 任务 ${current.taskId} 主会话注入取消失败：${detail}`);
      }
    }

    if (failures.length > 0) {
      // 取消失败不能写成 canceled：执行体可能还在跑（甚至会完成并自动合并），
      // 谎称「已取消」会让用户失去唯一的干预窗口。保持原状态，把失败原因写
      // 在任务上（看板可见）并如实回包。
      const message = `${failures.join("；")}（任务可能仍在运行，请重试 /qq stop）`;
      const at = this.now();
      const failed: QqTask = {
        ...current,
        failure: { code: "cancel_failed", message },
        pending: undefined,
        updatedAt: Math.max(current.updatedAt, at),
      };
      await this.persist(failed);
      await this.appendEvent("task_cancel_failed", failed.taskId, {
        reason: failures.join("; "),
      });
      await this.deliverTask(
        failed,
        `任务 ${shortTaskId(failed.taskId)} 取消失败（${failures.join("；")}）。` +
          "任务可能仍在运行，请重试 /qq stop。",
      );
      return;
    }

    const at = this.now();
    const patched: QqTask = {
      ...current,
      pending: undefined,
      updatedAt: Math.max(current.updatedAt, at),
    };
    const updated = await this.commitStatus(patched, "canceled", { pending: undefined });
    await this.appendEvent("task_canceled", updated.taskId);
    await this.deliverTask(
      updated,
      wasQueued
        ? `已取消排队中的任务 ${shortTaskId(updated.taskId)}。`
        : `已请求停止任务 ${shortTaskId(updated.taskId)}。`,
    );
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

  private async discardTask(task: QqTask, force: boolean = false): Promise<void> {
    const current = this.tasks.get(task.taskId) ?? task;
    const superSessionId = current.correlation.superSessionId;
    if (!superSessionId) {
      await this.deliverTask(
        current,
        `任务 ${shortTaskId(current.taskId)} 没有可丢弃的工作分支。`,
      );
      return;
    }

    // 非终态任务可能仍在执行：删 worktree 会连未提交改动一起抹掉，且无法恢复。
    // 默认拒绝，要求先 /qq stop；显式 --force 才继续，并在回包里写明代价。
    const running = !isTerminalStatus(current.status);
    if (running && !force) {
      await this.deliverTask(
        current,
        `任务 ${shortTaskId(current.taskId)} 尚未结束（${qqTaskStatusLabel(current.status)}），` +
          "不能直接丢弃。请先 /qq stop 停止它；如确需强制丢弃，请用 " +
          `/qq discard ${shortTaskId(current.taskId)} --force（未提交的改动会丢失）。`,
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
    await this.appendEvent("task_discarded", current.taskId, { forced: running && force });
    await this.deliverTask(
      current,
      running
        ? `任务 ${shortTaskId(current.taskId)} 已被强制丢弃（未提交的改动已随之丢失）。`
        : `任务 ${shortTaskId(current.taskId)} 的工作分支已丢弃。`,
    );
  }

  private async refreshTask(task: QqTask): Promise<void> {
    const current = this.tasks.get(task.taskId) ?? task;
    if (this.taskChannel(current) === "main") {
      // 主会话渠道没有子会话可读：按任务自己的真实状态回一条摘要。排队中 /
      // 已注入待回复时明确说还要等，绝不把「没结果」说成「已完成」。
      const profile = qqDetailProfile(this.config.resultDetail);
      await this.deliverTask(current, formatQqTaskSummary(current, profile.detail));
      return;
    }
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

    if (!isTerminalStatus(current.status)) {
      // 非终态：只回进度快照，**不写 result、不写 resultDeliveredAt**。
      //
      // 为什么要拦：运行中任务的子会话还没有摘要，readTaskOutcome 会用占位
      // 文案凑数、stopReason 缺省成 end_turn —— 旧实现把这份「中间结果」
      // buildResult 后落盘并写上幂等锚点，之后 finalize 的 deliverResult 看
      // 到锚点已存在直接早返回，真正的终态结果永远送不到用户手上；且中间
      // result（含伪造的 end_turn）还会污染看板。进度文本走普通投递通道，
      // 不碰任何锚点字段。
      const statusNote =
        typeof outcome.status === "string" && outcome.status.length > 0
          ? `（执行体状态：${outcome.status}）`
          : "";
      // QQ 同一 msg_id 的被动回复条数有上限（常见口径 5 条）：已受理 + 审批
      // 请求 + 审批结果 + 终态结果已经占 4 条，进度消息再每次新开一条，用户
      // 点几次刷新就把终态结果的配额烧光（这是「收不到结果」的另一条回法）。
      // 因此：①最小间隔内的重复刷新直接复用上一次投递；②投递用稳定
      // dedupeKey，adapter 复用同一个 msg_seq，平台按 (msg_id, msg_seq) 去重。
      const fingerprint = `${current.status}|${typeof outcome.status === "string" ? outcome.status : ""}`;
      // 节流窗口同样是相对时间：走单调时钟，避免系统时间回拨导致「刚发过」
      // 被读成「很久没发」而连发，或反之永久压住。
      const at = this.monotonic();
      const previous = this.progressRefreshes.get(current.taskId);
      if (previous !== undefined && at - previous < QQ_PROGRESS_REFRESH_MIN_INTERVAL_MS) {
        this.log(
          `QQ 任务 ${current.taskId}：${QQ_PROGRESS_REFRESH_MIN_INTERVAL_MS}ms 内的重复刷新复用上一次进度投递`,
        );
        return;
      }
      const dedupeKey = `progress:${current.taskId}:${fingerprint}`;
      this.progressRefreshes.set(current.taskId, at);
      await this.deliverTaskNotice(
        current,
        `任务 ${shortTaskId(current.taskId)} 尚未结束${statusNote}，结束后结果会自动送达；如需查询可回复 /qq status ${current.taskId}。`,
        dedupeKey,
      );
      return;
    }

    const stopReason =
      typeof outcome.stopReason === "string" && outcome.stopReason.length > 0
        ? outcome.stopReason
        : "end_turn";
    const branch = outcome.branch ?? current.correlation.branch;
    const result = this.buildResult(outcome, stopReason, current, branch);
    // result 深等价（同一终态重复刷新）时复用现有对象：不写盘、不推进
    // updatedAt —— 摘要文本（含耗时行）逐字节稳定，deliverResult 的部分送达
    // 锚点指纹才不会因一次刷新就失配而整份重发。
    const unchanged =
      current.result !== undefined && signature(current.result) === signature(result);
    const patched: QqTask = unchanged
      ? current
      : { ...current, result, updatedAt: Math.max(current.updatedAt, this.now()) };
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
        await this.handleTaskAction(
          resolved.task.taskId,
          intent.kind,
          text,
          intent.kind === "discard" && intent.force === true ? { force: true } : undefined,
        );
        return;
      }
    }
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
      // 看板投影是 UI 面：openid / 群号一律脱敏（完整值只留在任务记录与授权
      // 存储里）。webview 也做过一次 mask，两次结果一致（幂等）。
      chatId: maskQqOpenId(task.source.chatId),
      senderId: maskQqOpenId(task.source.senderId),
      status: task.status,
      policy: task.policy.remotePolicy,
      channel: this.taskChannel(task),
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
    // 两个错误维度并存可见：执行失败与回包失败是独立事件（任务可以同时执行
    // 失败且回包失败），用互斥覆盖会把回包失败从看板上抹掉，只剩 toast。
    // 取消是用户主动动作，不是执行故障：`failure` 字段保留给状态机，展示
    // 文案走中性分支（「已取消（…）」），不再显示「执行失败」。
    const errors: string[] = [];
    if (task.failure?.message) {
      errors.push(
        task.status === "canceled"
          ? `已取消（${task.failure.message}）`
          : task.failure.code === "cancel_failed"
            ? `取消失败：${task.failure.message}`
            : `执行失败：${task.failure.message}`,
      );
    }
    if (task.deliveryError) errors.push(`回包失败：${task.deliveryError}`);
    if (errors.length > 0) ui.errorMessage = errors.join("；");
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

    // 终态粘性优先：任务一旦收尾，任何后续提交（迟到的执行体事件、重复的
    // 刷新、带 status 的补丁）都不得改写它 —— 否则一个 noop 分支里的 patch
    // 就能把 terminated 的任务改回 pending / running。这里直接拒绝并留痕。
    if (isTerminalStatus(latest.status)) {
      this.log(
        `QQ 任务 ${task.taskId}：终态 ${latest.status} 粘性，忽略 ${next} 提交` +
          (patch && Object.keys(patch).length > 0 ? "（含补丁）" : ""),
      );
      return latest;
    }

    // 空补丁（undefined 或无任何键）没有可写内容：直接返回，绝不为了「提交」
    // 再落一次盘。
    if (!patch || Object.keys(patch).length === 0) {
      const at = this.now();
      const outcome = transitionQqTask(latest, next, at);
      if (outcome.noop) {
        if (outcome.error) this.log(`QQ 任务 ${task.taskId}：${outcome.error.message}`);
        return latest;
      }
      const updated = outcome.task;
      await this.persist(updated);
      this.notify(
        `QQ 任务 ${shortTaskId(updated.taskId)} → ${qqTaskStatusLabel(updated.status)}`,
      );
      return updated;
    }

    const at = this.now();
    const outcome = transitionQqTask(latest, next, at);
    // 补丁不允许携带 status：状态只能经由 next 迁移，避免「迁移是 noop、
    // 补丁却把状态改了」这条隐式通道。
    const safePatch: Partial<QqTask> = { ...patch };
    delete safePatch.status;
    let updated: QqTask;
    if (outcome.noop) {
      if (outcome.error) {
        this.log(`QQ 任务 ${task.taskId}：${outcome.error.message}`);
      }
      updated = { ...latest, ...safePatch, updatedAt: Math.max(latest.updatedAt, at) };
    } else {
      updated = { ...outcome.task, ...safePatch };
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
    const previous = this.tasks.get(task.taskId);
    this.tasks.set(task.taskId, task);
    this.idempotency.set(task.idempotencyKey, task.taskId);
    await this.store.saveTask(task as unknown as QqTaskRecord);
    // 只有真变了才通知：同一份记录被重复 persist（例如收尾后的回包写回）
    // 不该再推一次快照。比较的是「看板会展示的关键字段集合」：updatedAt 是
    // 必变项，但同毫秒内只有 pending / result / failure / correlation 变化的
    // 迁移也要推一次 —— 这些字段只在真变化时被替换成新对象，引用比较足够。
    if (!previous || qqTaskProjectionChanged(previous, task)) {
      this.changed();
    }
  }

  /** 通知宿主刷新投影；回调抛错不能打断任务链路。 */
  private changed(): void {
    try {
      this.onChanged();
    } catch (error) {
      this.log(`QQ 任务投影刷新失败：${errorText(error)}`);
    }
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
    dedupeKey?: string,
  ): Promise<boolean> {
    return (await this.deliverOutcome(msg, text, replyToMsgId, dedupeKey)).ok;
  }

  /** 底层投递：完整返回 `ok` 与适配器的 `retryable` 判定，供重试循环短路。 */
  private async deliverOutcome(
    msg: Pick<InboundMessage, "chatType" | "chatId">,
    text: string,
    replyToMsgId?: string,
    dedupeKey?: string,
  ): Promise<QqDeliveryOutcome> {
    const payload: QqServiceDeliverInput = {
      chatType: msg.chatType,
      chatId: msg.chatId,
      text,
    };
    if (replyToMsgId) payload.replyToMsgId = replyToMsgId;
    if (dedupeKey) payload.dedupeKey = dedupeKey;
    try {
      return await this.host.deliver(payload);
    } catch (error) {
      this.log(`QQ 消息投递失败：${errorText(error)}`);
      // host 抛错无法判定确定性：按可重试处理（保守一侧）。
      return { ok: false, retryable: true };
    }
  }

  private async deliverTask(
    task: QqTask,
    text: string,
    dedupeKey?: string,
  ): Promise<boolean> {
    return (
      await this.deliverOutcome(
        { chatType: task.source.chatType, chatId: task.source.chatId },
        text,
        task.source.msgId,
        dedupeKey,
      )
    ).ok;
  }

  /**
   * 审批 / 进度类通知的投递：失败时本地提示并**重试一次**。
   *
   * 为什么单独一条：`deliverTask` 只尝试一次，而审批请求、审批结果、进度快照
   * 这类消息发不出去时用户全程无感（审批还会在 4 分钟后被自动拒绝）。重试
   * 沿用同一个 `dedupeKey`（adapter 复用同一 `msg_seq`），平台按
   * `(msg_id, msg_seq)` 去重，重试不会刷出重复消息。
   */
  private async deliverTaskNotice(
    task: QqTask,
    text: string,
    dedupeKey?: string,
  ): Promise<boolean> {
    if (await this.deliverTask(task, text, dedupeKey)) return true;
    this.notify(`QQ 任务 ${shortTaskId(task.taskId)} 的通知未能送达，正在重试一次`);
    if (await this.deliverTask(task, text, dedupeKey)) return true;
    this.notify(`QQ 任务 ${shortTaskId(task.taskId)} 的通知仍未送达 QQ`);
    return false;
  }

  /**
   * 任务侧文本的投递：先走 QQ 的「被动回复」（带 `msg_id`），失败再退回
   * 「主动消息」（不带 `msg_id`）。
   *
   * 为什么要两条路：QQ 的被动回复绑定在用户那条消息上，回复窗口有限；长任务
   * 跑完时窗口往往已经关掉，只有主动消息还能送到。没有主动消息额度的机器人
   * 会被平台拒绝 —— 那就如实返回 false，由调用方记录，绝不假装送达。
   *
   * 平台边界（口径来自 QQ 开放平台机器人消息 API 的社区/文档共识，**未实测
   * 核验**，具体数字以官方文档为准）：同一个 `msg_id` 的被动回复条数有限
   * （常见口径 5 条，超限后平台拒绝该次发送）。一条任务的完整回包链
   * （已受理 ack + 审批请求 + 审批结果 + 终态结果，还可能多片分片）可能撞上
   * 这个上限；超限后只能退回主动消息额度 —— 主动消息没有 `(msg_id, msg_seq)`
   * 去重键，重试失败时可能重复，这是已知且如实接受的取舍。
   */
  private async deliverTaskText(
    task: QqTask,
    text: string,
    dedupeKey?: string,
    options?: { passive?: boolean },
  ): Promise<QqDeliveryOutcome> {
    // passive === false：跳过被动回复，直接走主动消息（不带 msg_id）。用于
    // 「续发分片」与「重启后补发」—— 这两条路径上的 (msg_id, msg_seq) 可能
    // 与进程重启前用过的键撞车，被平台静默去重；主动消息没有这个键。
    if (options?.passive !== false && task.source.msgId) {
      const passive = await this.deliverOutcome(
        { chatType: task.source.chatType, chatId: task.source.chatId },
        text,
        task.source.msgId,
        dedupeKey,
      );
      if (passive.ok) return passive;
      const active = await this.deliverOutcome(
        { chatType: task.source.chatType, chatId: task.source.chatId },
        text,
      );
      // 主动消息也失败时把被动回复的 retryable 透传：被动回复是确定性拒绝
      // 的话，重试整个 attempt 只会原样再失败一遍，调用方据此短路。
      if (!active.ok && passive.retryable === false) {
        return { ok: false, retryable: false };
      }
      return active;
    }
    // 没有 msg_id（或显式要求主动消息）就直接主动投递（dedupeKey 无处安放）。
    return this.deliverOutcome(
      { chatType: task.source.chatType, chatId: task.source.chatId },
      text,
    );
  }

  /**
   * 带有限重试的投递。
   *
   * 取舍：只对适配器返回的失败重试，无法绝对判定「超时但其实已送达」的情形。
   * 两条去重防线：
   *  1. 同一次逻辑投递（含全部重试）共用一个 `dedupeKey`，adapter 复用同一个
   *     `msg_seq` —— 平台按 `(msg_id, msg_seq)` 去重，重试是幂等的，不会把
   *     「超时但其实已送达」的重试刷成第二条消息；
   *  2. 适配器明确判定 `retryable === false`（4xx / 参数不合法这类确定性
   *     拒绝）时直接短路，不再烧重试窗口 —— 重试只会得到同一份拒绝。
   */
  private async deliverTaskTextWithRetry(
    task: QqTask,
    text: string,
    dedupeKey?: string,
    options?: { passive?: boolean },
  ): Promise<boolean> {
    // 调用方没给 key 时，为这一条逻辑消息分配一个新的递增 key（同一逻辑消息
    // 的全部重试共用它，adapter 据此复用同一个 msg_seq）。
    const key = dedupeKey ?? `task:${task.taskId}:${++this.deliverySeqCounter}`;
    for (let attempt = 1; attempt <= QQ_DELIVERY_ATTEMPTS; attempt += 1) {
      const outcome = await this.deliverTaskText(task, text, key, options);
      if (outcome.ok) return true;
      if (outcome.retryable === false) return false;
      if (attempt < QQ_DELIVERY_ATTEMPTS && this.deliveryRetryDelayMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.deliveryRetryDelayMs * attempt);
          timer.unref?.();
        });
      }
    }
    return false;
  }

  /**
   * 终态结果回包（**幂等**）。
   *
   * `resultDeliveredAt` 一旦写上就说明同一份结果已经送达，自动路径（收尾 /
   * 刷新 / 重启恢复）直接跳过 —— 重试、重复事件与宿主重启都不会把结果重复
   * 推给用户；投递失败则写入 `deliveryError` 并本地提示（不静默丢弃），此时
   * 后续刷新会再次尝试，成功后才补上 `resultDeliveredAt`。
   *
   * 并发纪律：锚点**不是锁** —— 它要等全部分片发完才落盘，投递窗口（单次
   * 发送 10s 超时 + 重试退避）内再触发会被读到「未投递」。所以这里用
   * `deliveringResults` 在飞标记兜底：投递进行中的再次触发直接复用同一次
   * 投递（返回内存里的当前任务），绝不重复发送。
   */
  private async deliverResult(
    task: QqTask,
    options?: { forceActive?: boolean },
  ): Promise<QqTask> {
    if (task.resultDeliveredAt !== undefined) return task;
    // 纵深防御：只有终态任务才允许走回包。非终态任务没有可信的摘要与停止
    // 原因，把「中间结果」写进锚点会让真正的终态结果永远送不出去（旧实现的
    // 运行中刷新就是这么抑制最终回包的）。
    if (!isTerminalStatus(task.status)) return task;
    const inflight = this.deliveringResults.get(task.taskId);
    // 并发触发（提交收尾 / 刷新 / 重启补发交叠）await 同一次投递：拿到的是
    // 真正收尾后的任务。旧实现直接返回内存快照，调用方以为刷新生效，实际
    // 什么也没发生。
    if (inflight) return await inflight;
    const run = this.deliverResultLocked(task, options).finally(() => {
      this.deliveringResults.delete(task.taskId);
    });
    this.deliveringResults.set(task.taskId, run);
    return await run;
  }

  /** 分片内容的稳定指纹（djb2，非加密用途）：识别「同一份结果的分片序列」。 */
  private async deliverResultLocked(
    task: QqTask,
    options?: { forceActive?: boolean },
  ): Promise<QqTask> {
    const profile = qqDetailProfile(this.config.resultDetail);
    // 投递开始时给 result 拍指纹：收尾时只有内容没被改写，才允许把这次投递
    // 记成「新结果已送达」。否则投递窗口（可达数十秒）里刷新换上的新内容会
    // 被旧内容的成功回包顺带标成已送达，永远不再发出去。
    const resultSignature = signature(task.result);
    // 空摘要也要有一条如实的说明，不能只回一行「状态 成功」看着像丢了内容。
    const base = formatQqTaskSummary(task, profile.detail);
    const text =
      task.result && task.result.summary.trim().length === 0
        ? `${base}\n摘要  ${QQ_EMPTY_SUMMARY_NOTICE}`
        : base;
    const chunks = chunkQqText(text, profile.chunkChars);
    const fingerprint = fingerprintChunks(chunks);
    // 上一轮部分失败时已送达的片数：内容指纹一致才续发（跳过已确认送达的
    // 片，不把收到的几片重复推给用户）；结果文本或分片档位变了就从头重发
    // —— 宁可重复也不让摘要缺一块。
    const anchor = task.resultDeliveredChunks;
    const skip =
      anchor && anchor.fingerprint === fingerprint
        ? Math.min(Math.max(0, Math.floor(anchor.count)), chunks.length)
        : 0;

    let ok = chunks.length > 0;
    let deliveredCount = skip;
    for (let i = skip; i < chunks.length; i += 1) {
      // 第一片（且非重启补发）走被动回复；续发分片一律主动消息。
      //
      // 为什么：adapter 的 `replySeq` 是纯内存的，进程重启后从 1 重开，续发
      // 时算出的 seq 与重启前已用过的 (msg_id, seq) 撞车会被平台**静默去重**
      // —— 结果缺尾却仍写成「已送达」。主动消息不带 msg_id，没有这个去重键，
      // 续发片段因此不可能被吞。重启补发整份都走主动消息（同样原因）。
      const passive = i === 0 && options?.forceActive !== true;
      if (await this.deliverTaskTextWithRetry(task, chunks[i]!, undefined, { passive })) {
        deliveredCount = i + 1;
      } else {
        ok = false;
        break;
      }
    }

    const current = this.tasks.get(task.taskId) ?? task;
    const at = this.now();
    if (signature(current.result) !== resultSignature) {
      const stale: QqTask = {
        ...current,
        resultDeliveryAttemptAt: at,
        deliveryError: QQ_RESULT_CHANGED_WHILE_DELIVERING,
      };
      await this.persist(stale);
      await this.appendEvent("task_result_undelivered", stale.taskId, {
        error: stale.deliveryError,
      });
      this.notify(`QQ 任务 ${shortTaskId(task.taskId)} ${QQ_RESULT_CHANGED_WHILE_DELIVERING}`);
      return stale;
    }
    const patched: QqTask = ok
      ? {
          ...current,
          resultDeliveredAt: Math.max(current.updatedAt, at),
          resultDeliveredChunks: undefined,
          resultDeliveryAttemptAt: at,
          deliveryError: undefined,
        }
      : {
          ...current,
          resultDeliveryAttemptAt: at,
          deliveryError:
            deliveredCount > 0
              ? `${QQ_RESULT_UNDELIVERED}（已送达 ${deliveredCount}/${chunks.length} 片，下次投递将从第 ${deliveredCount + 1} 片续发）`
              : QQ_RESULT_UNDELIVERED,
          // 锚点与错误一起写：只有确认送达的片才计数，绝不虚构送达状态。
          resultDeliveredChunks:
            deliveredCount > 0 ? { count: deliveredCount, fingerprint } : undefined,
        };
    await this.persist(patched);

    if (ok) {
      await this.appendEvent("task_result_delivered", task.taskId);
    } else {
      await this.appendEvent("task_result_undelivered", task.taskId, {
        error: patched.deliveryError,
      });
      this.notify(`QQ 任务 ${shortTaskId(task.taskId)} ${QQ_RESULT_UNDELIVERED}`);
    }
    return patched;
  }

  /**
   * 宿主重启造成的中断也要有回包：QQ 那侧不能只剩一条「已受理」。
   * 失败同样记录 `deliveryError` 并本地提示。
   */
  private async deliverInterruption(
    task: QqTask,
    options: { neverRan?: boolean } = {},
  ): Promise<void> {
    const label = shortTaskId(task.taskId);
    const text =
      options.neverRan === true
        ? `任务 ${label} 因扩展宿主重启**未执行**（排队消息不会保留），请重新发送。`
        : `任务 ${label} 因扩展宿主重启而中断（未完成）。`;
    // 主动消息：这条通知只在「进程换了一茬」之后发，被动回复的 seq 会从 1
    // 重开，与重启前的已受理回执撞键会被平台静默去重。
    if (await this.deliverTaskTextWithRetry(task, text, undefined, { passive: false })) return;
    const current = this.tasks.get(task.taskId) ?? task;
    await this.persist({ ...current, deliveryError: QQ_RESULT_UNDELIVERED });
    await this.appendEvent("task_result_undelivered", task.taskId, {
      error: QQ_RESULT_UNDELIVERED,
    });
    this.notify(`QQ 任务 ${shortTaskId(task.taskId)} 的中断通知未能送达 QQ`);
  }
}
