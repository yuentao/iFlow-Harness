/**
 * QQ 远程任务 —— 任务模型、状态机、校验、结果聚合与纯文本渲染（纯逻辑）。
 *
 * 设计边界（Wave1-A，只做 shared 层）：
 *  - 本模块不认识 QQ 适配器，也不读文件 / 不访问网络 / 不 import vscode。
 *    「授权 / 群聊开关 / @ 提及 / 限流判定 / 重复投递」全部由调用方判定后
 *    作为纯数据传进来，这里只做结构化校验，不猜、不查。
 *  - 状态机返回新对象（不就地改），终态粘性；非法转移用**返回码**表达而不是
 *    抛错（见 `transitionQqTask` 的 JSDoc）——适配器在重连重放 / 心跳补发时
 *    必须能把迟到的迁移安全地当作 no-op 消化，抛错会打断整条处理链。
 *  - 结果聚合只搬运已有观测：没有 usage / PR 地址就给 undefined / 空数组，
 *    绝不补造摘要、改动或产物（与 shared/turn-followup.ts 的「绝不伪造」同一纪律）。
 */

import type { Block, TurnChangeUi } from "./messages.js";
import type { SuperIntegration } from "./super-agent.js";

// ---------------------------------------------------------------------------
// 任务模型
// ---------------------------------------------------------------------------

/** 消息来源会话类型。群聊与私聊的准入规则不同（见 `validateQqTaskRequest`）。 */
export type QqChatType = "private" | "group";

/**
 * 任务生命周期状态。
 *
 * 线性主干：received → validated → queued → dispatched → running → 终态；
 * 运行期可以进出 `waiting_approval` / `waiting_answer` 两个等待态。
 * 终态集合见 `TERMINAL_STATUSES`（`isTerminalStatus`）。
 */
export type QqTaskStatus =
  /** 收到消息、尚未校验。 */
  | "received"
  /** 校验通过、已解析成任务。 */
  | "validated"
  /** 等待并发槽位（排队中）。 */
  | "queued"
  /** 已交给执行体（子会话 / CLI 进程），尚未观察到运行。 */
  | "dispatched"
  /** 执行中。 */
  | "running"
  /** 等待审批（远程策略要求人工确认）。 */
  | "waiting_approval"
  /** 等待用户回答 agent 的提问。 */
  | "waiting_answer"
  /** 成功（终态）。 */
  | "succeeded"
  /** 失败（终态）。 */
  | "failed"
  /** 用户取消（终态）。 */
  | "canceled"
  /** 超时（终态）。 */
  | "timeout"
  /** 结果不可直接采信、需要人工复核（终态）。 */
  | "needs_review";

/** 消息来源标识：哪条会话、谁发的、哪条消息。 */
export interface QqTaskSource {
  chatType: QqChatType;
  chatId: string;
  senderId: string;
  /** 适配器侧消息 id（参与幂等键，见 `makeIdempotencyKey`）。 */
  msgId: string;
}

/** 执行目标。workspace 是绝对路径或适配器可解析的工作区标识。 */
export interface QqTaskTarget {
  workspace: string;
  /** 期望的 agent 模式（plan / default / yolo…），缺省沿用宿主默认。 */
  mode?: string;
  /** 期望的模型 id，缺省沿用宿主当前模型。 */
  model?: string;
}

/** 任务载荷。attachments / contexts 是引用（路径或适配器句柄），不是内容本体。 */
export interface QqTaskPayload {
  prompt: string;
  attachments: string[];
  contexts: string[];
}

/** 远程执行策略：只读 / 需监督 / 可信任。 */
export type QqRemotePolicy = "readonly" | "supervised" | "trusted";

/** 结果详略档位（决定 `formatQqTaskSummary` 输出多少内容，也决定回传体积）。 */
export type QqResultDetail = "summary" | "standard" | "full";

export interface QqTaskPolicy {
  remotePolicy: QqRemotePolicy;
  resultDetail: QqResultDetail;
}

/** 任务与宿主内部对象的关联（子会话 id、转录块 id、分支、提交）。 */
export interface QqTaskCorrelation {
  /** 执行该任务的 Super Agent 子会话 id。 */
  superSessionId?: string;
  /** 主转录里对应 user 块的 id（复盘 / 重新生成用）。 */
  userBlockId?: string;
  /** 执行所在分支（worktree 隔离时）。 */
  branch?: string;
  /** 集成后的提交 sha（已知才写）。 */
  commit?: string;
}

/** token 用量（字段与宿主 `SessionUsageUi` 同口径，仅保留任务需要的部分）。 */
export interface QqTaskUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  contextUsed?: number;
}

/** 一处文件改动，来自 `TurnChangeUi` 的映射（不重新计算行数）。 */
export interface QqTaskChange {
  path: string;
  additions: number;
  deletions: number;
  status?: TurnChangeUi["status"];
}

/** 任务结果。缺项保持 undefined / 空数组，绝不补造。 */
export interface QqTaskResult {
  /** 执行体返回的停止原因（如 end_turn / max_tokens / canceled）。 */
  stopReason: string;
  /** 最后一条非 system 的助手文本；没有就空串。 */
  summary: string;
  changes: QqTaskChange[];
  usage?: QqTaskUsage;
  /** 可打开的产物引用（例如 PR 地址）；没有就空数组。 */
  artifacts: string[];
  /** 任务执行所在分支（调用方已知时才有）。 */
  branch?: string;
}

/** 等待中的应答（审批 / 提问）。 */
export interface QqTaskPending {
  kind: "approval" | "answer";
  /** 人类可读的等待原因（工具名、问题标题等）。 */
  text: string;
  /** 等待开始时间（毫秒时间戳）。 */
  at: number;
}

/** 结构化失败原因。 */
export interface QqTaskError {
  code: string;
  message: string;
}

/** 一条远程任务。纯数据，可落盘、可序列化。 */
export interface QqTask {
  taskId: string;
  /** `${adapter}:${msgId}` 形态的幂等键（见 `makeIdempotencyKey`）。 */
  idempotencyKey: string;
  source: QqTaskSource;
  target: QqTaskTarget;
  payload: QqTaskPayload;
  policy: QqTaskPolicy;
  status: QqTaskStatus;
  /** 毫秒时间戳。 */
  createdAt: number;
  updatedAt: number;
  correlation: QqTaskCorrelation;
  result?: QqTaskResult;
  pending?: QqTaskPending;
  failure?: QqTaskError;
}

// ---------------------------------------------------------------------------
// 创建与幂等
// ---------------------------------------------------------------------------

/** `createQqTask` 的输入。adapter 参与幂等键（不同适配器的同名 msgId 不互通）。 */
export interface CreateQqTaskInput {
  adapter: string;
  source: QqTaskSource;
  target: QqTaskTarget;
  payload: QqTaskPayload;
  policy: QqTaskPolicy;
}

/** 可注入的时钟与随机源（测试用；生产缺省 Date.now / Math.random）。 */
export interface CreateQqTaskOptions {
  now?: () => number;
  /** 返回 [0, 1) 的随机数。 */
  random?: () => number;
}

/**
 * 幂等键。
 *
 * 语义是「同一适配器收到的同一条消息只对应一个任务」：格式固定为
 * `${adapter}:${msgId}`，两端都不做归一化（大小写 / 空白差异由适配器在
 * 投递前统一，宿主不替它猜）。同一个 (adapter, msgId) 必然产生同键。
 */
export function makeIdempotencyKey(adapter: string, msgId: string): string {
  return `${adapter}:${msgId}`;
}

/** taskId 的随机段长度（base36 字符数）。 */
const TASK_ID_RANDOM_LENGTH = 6;
const BASE36_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** 用注入的随机源生成定长 base36 串；非法随机值按 0 处理（不让 NaN 漏进 id）。 */
function randomBase36(length: number, random: () => number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    const raw = random();
    const normalized = Number.isFinite(raw) ? Math.min(0.999999999, Math.max(0, raw)) : 0;
    out += BASE36_ALPHABET[Math.floor(normalized * 36)] ?? "0";
  }
  return out;
}

/**
 * 建一个新任务（status = "received"）。
 *
 * taskId 形态 `T-<毫秒时间戳 base36>-<6 位随机 base36>`：时间戳段让 id 天然
 * 可比、便于日志按时间排序；随机段避免同一毫秒内碰撞。时钟与随机源可注入，
 * 测试可得到完全确定的 id。payload 的数组做浅拷贝，调用方后续改数组不会
 * 影响已建任务。
 */
export function createQqTask(input: CreateQqTaskInput, opts: CreateQqTaskOptions = {}): QqTask {
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const createdAt = now();
  return {
    taskId: `T-${createdAt.toString(36)}-${randomBase36(TASK_ID_RANDOM_LENGTH, random)}`,
    idempotencyKey: makeIdempotencyKey(input.adapter, input.source.msgId),
    source: { ...input.source },
    target: { ...input.target },
    payload: {
      prompt: input.payload.prompt,
      attachments: [...input.payload.attachments],
      contexts: [...input.payload.contexts],
    },
    policy: { ...input.policy },
    status: "received",
    createdAt,
    updatedAt: createdAt,
    correlation: {},
  };
}

/** 最短的人类可读 task id：取末 6 个字符（不足 6 位原样返回）。 */
export function shortTaskId(taskId: string): string {
  return taskId.length <= 6 ? taskId : taskId.slice(-6);
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES: readonly QqTaskStatus[] = [
  "succeeded",
  "failed",
  "canceled",
  "timeout",
  "needs_review",
];

/** 终态判定：终态之后的一切迁移都按 no-op 处理（重连重放 / 心跳补发的兜底）。 */
export function isTerminalStatus(status: QqTaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * 合法迁移表。
 *
 * 除了主干，显式允许执行体「一帧都没观察到 running 就完成」的情形
 * （dispatched → succeeded），以及任何非终态 → failed / canceled / timeout
 * ——这些是外部中断路径，不能要求先回到某个中间态。
 */
const TRANSITIONS: Record<QqTaskStatus, readonly QqTaskStatus[]> = {
  received: ["validated", "failed", "canceled", "timeout"],
  validated: ["queued", "failed", "canceled", "timeout"],
  queued: ["dispatched", "failed", "canceled", "timeout"],
  dispatched: [
    "running",
    "waiting_approval",
    "waiting_answer",
    "succeeded",
    "failed",
    "canceled",
    "timeout",
    "needs_review",
  ],
  running: [
    "waiting_approval",
    "waiting_answer",
    "succeeded",
    "failed",
    "canceled",
    "timeout",
    "needs_review",
  ],
  waiting_approval: ["running", "failed", "canceled", "timeout", "needs_review"],
  waiting_answer: ["running", "failed", "canceled", "timeout", "needs_review"],
  // 终态：粘性，没有出边。
  succeeded: [],
  failed: [],
  canceled: [],
  timeout: [],
  needs_review: [],
};

/** 一次状态迁移的结果。 */
export interface QqTransitionOutcome {
  /** 迁移后的任务；没有任何变化时就是传入的那个对象（引用相同）。 */
  task: QqTask;
  /**
   * true = 没有产生新对象：终态粘性、同状态重复迁移、或非法迁移。
   * 调用方据此跳过落盘 / 通知。
   */
  noop: boolean;
  /** 非法迁移时给出原因；合法迁移与终态粘性都缺省。 */
  error?: QqTaskError;
}

/**
 * 迁移到 `next`，返回新对象（不就地改）。
 *
 * 错误表达方式：**返回码，不抛错**。三种「不生效」都返回原对象引用 + noop：
 *  - 当前已是终态（粘性）；
 *  - `next` 与当前状态相同（重复事件）；
 *  - 不在 `TRANSITIONS` 表里的非法边 —— 额外带 `error.code === "illegal_transition"`。
 *
 * 选返回码而不是抛错的理由：状态帧来自网络/心跳，重复与乱序是常态。抛错会迫使
 * 每个调用点写 try/catch，且错误与「去重成功」在同一层被混淆；返回码把
 * 「这是非法迁移、需要上报」与「这是有效迁移」放在同一个可判定的返回值里。
 *
 * `now` 可注入（测试）；`updatedAt` 取 `max(旧值, now)`，避免时钟回拨让耗时变负。
 */
export function transitionQqTask(
  task: QqTask,
  next: QqTaskStatus,
  now: number = Date.now(),
): QqTransitionOutcome {
  if (isTerminalStatus(task.status) || task.status === next) {
    return { task, noop: true };
  }
  const allowed = TRANSITIONS[task.status];
  if (!allowed.includes(next)) {
    return {
      task,
      noop: true,
      error: {
        code: "illegal_transition",
        message: `非法状态迁移：${task.status} → ${next}`,
      },
    };
  }
  return {
    task: {
      ...task,
      status: next,
      updatedAt: Math.max(task.updatedAt, now),
    },
    noop: false,
  };
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/** 一条待校验附件（只带元数据，不带内容 —— 本模块不读文件）。 */
export interface QqTaskAttachmentInput {
  /** 展示名，仅用于错误提示。 */
  name?: string;
  /** 字节数；缺省 0 = 未知大小，按不超限处理（不猜）。 */
  size?: number;
  /** 缺省按 file 处理。 */
  kind?: "image" | "file";
}

/** 一次远程任务请求（适配器已判定的事实 + 待校验的载荷）。 */
export interface QqTaskRequest {
  /** 发送者是否通过认证 / 白名单校验。false 一律拒绝。 */
  authorized: boolean;
  chatType: QqChatType;
  /** 群聊是否被允许派发任务。缺省 false：群聊是显式 opt-in。 */
  groupAllowed?: boolean;
  /** 群聊消息是否 @ 了机器人（私聊不需要）。 */
  mentioned?: boolean;
  /** 宿主限流判定（窗口内配额已用尽）。 */
  rateLimited?: boolean;
  /** 幂等键已存在（同一条消息重复投递）。 */
  duplicate?: boolean;
  prompt: string;
  attachments?: readonly QqTaskAttachmentInput[];
  /** 目标工作区；缺省表示由宿主解析默认工作区，不参与工作区校验。 */
  workspace?: string;
  /** 允许的工作区白名单（精确字符串比较，不做路径归一化）。 */
  allowedWorkspaces?: readonly string[];
}

/** 校验上限（全部可参数化）。 */
export interface QqValidationLimits {
  /** 提示词最大码点数（默认 4000）。 */
  maxPromptChars?: number;
  /** 附件数量上限（默认 10）。 */
  maxAttachments?: number;
  /** 单张图片字节上限（默认 8 MiB）。 */
  maxImageBytes?: number;
  /** 单个文件字节上限（默认 5 MiB）。 */
  maxFileBytes?: number;
}

/** 校验失败的 code 全集。 */
export type QqValidationCode =
  | "unauthorized"
  | "group_not_allowed"
  | "mention_required"
  | "rate_limited"
  | "duplicate"
  | "prompt_empty"
  | "prompt_too_long"
  | "too_many_attachments"
  | "attachment_too_large"
  | "workspace_not_allowed";

export type QqValidationResult =
  | { ok: true }
  | { ok: false; code: QqValidationCode; message: string };

/** 默认上限（与宿主既有附件上限对齐：图片 8 MiB，其他文件 5 MiB）。 */
export const DEFAULT_QQ_TASK_LIMITS = {
  maxPromptChars: 4000,
  maxAttachments: 10,
  maxImageBytes: 8 * 1024 * 1024,
  maxFileBytes: 5 * 1024 * 1024,
} as const;

/**
 * 校验一次任务请求。纯函数：不读文件、不查网络、不改任何状态。
 *
 * 判定顺序固定（先便宜且安全相关的，再内容相关的），保证同一请求的报错稳定：
 * unauthorized → group_not_allowed → mention_required → rate_limited →
 * duplicate → prompt_empty → prompt_too_long → too_many_attachments →
 * attachment_too_large → workspace_not_allowed。
 *
 * 提示词长度按 Unicode 码点计（`Array.from`）；组合字符 / 变体选择符仍可能让
 * 显示宽度大于码点数，这是刻意接受的近似。
 */
export function validateQqTaskRequest(
  req: QqTaskRequest,
  limits: QqValidationLimits = {},
): QqValidationResult {
  const maxPromptChars = limits.maxPromptChars ?? DEFAULT_QQ_TASK_LIMITS.maxPromptChars;
  const maxAttachments = limits.maxAttachments ?? DEFAULT_QQ_TASK_LIMITS.maxAttachments;
  const maxImageBytes = limits.maxImageBytes ?? DEFAULT_QQ_TASK_LIMITS.maxImageBytes;
  const maxFileBytes = limits.maxFileBytes ?? DEFAULT_QQ_TASK_LIMITS.maxFileBytes;

  if (!req.authorized) {
    return { ok: false, code: "unauthorized", message: "发送者未通过认证，拒绝执行远程任务" };
  }
  if (req.chatType === "group" && req.groupAllowed !== true) {
    return { ok: false, code: "group_not_allowed", message: "群聊任务未开启，请私聊或在设置中允许群聊" };
  }
  if (req.chatType === "group" && req.mentioned !== true) {
    return { ok: false, code: "mention_required", message: "群聊任务需要 @ 机器人" };
  }
  if (req.rateLimited === true) {
    return { ok: false, code: "rate_limited", message: "请求过于频繁，请稍后再试" };
  }
  if (req.duplicate === true) {
    return { ok: false, code: "duplicate", message: "同一条消息已经受理过（幂等键重复）" };
  }

  const prompt = typeof req.prompt === "string" ? req.prompt : "";
  if (prompt.trim().length === 0) {
    return { ok: false, code: "prompt_empty", message: "任务提示词为空" };
  }
  const promptChars = Array.from(prompt).length;
  if (promptChars > maxPromptChars) {
    return {
      ok: false,
      code: "prompt_too_long",
      message: `任务提示词 ${promptChars} 字符，超过上限 ${maxPromptChars}`,
    };
  }

  const attachments = req.attachments ?? [];
  if (attachments.length > maxAttachments) {
    return {
      ok: false,
      code: "too_many_attachments",
      message: `附件 ${attachments.length} 个，超过上限 ${maxAttachments}`,
    };
  }
  for (const attachment of attachments) {
    const size = typeof attachment.size === "number" && Number.isFinite(attachment.size)
      ? Math.max(0, attachment.size)
      : 0;
    const image = attachment.kind === "image";
    const cap = image ? maxImageBytes : maxFileBytes;
    if (size > cap) {
      const label = attachment.name ? `「${attachment.name}」` : "附件";
      return {
        ok: false,
        code: "attachment_too_large",
        message: `${label} ${size} 字节，超过上限 ${cap}`,
      };
    }
  }

  if (req.workspace !== undefined && req.allowedWorkspaces !== undefined) {
    if (!req.allowedWorkspaces.includes(req.workspace)) {
      return {
        ok: false,
        code: "workspace_not_allowed",
        message: `工作区 ${req.workspace} 不在允许列表中`,
      };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// 结果聚合
// ---------------------------------------------------------------------------

/** `buildQqTaskResult` 的输入：全部是宿主已观察到的数据。 */
export interface BuildQqTaskResultInput {
  stopReason: string;
  blocks: readonly Block[];
  turnChanges: readonly TurnChangeUi[];
  usage?: QqTaskUsage;
  branch?: string;
  integration?: SuperIntegration;
}

/**
 * 从宿主观测数据聚合任务结果。
 *
 * - summary：从 `blocks` 尾部反向扫最后一条**非 system** 的 `text` 块；空白块
 *   跳过（它不是内容），全无则空串 —— 不拿 user 文本或工具输出去冒充。
 * - changes：`TurnChangeUi` 逐条映射，行数**原样搬运**，不重算。
 * - artifacts：只收 `integration.url`（真实存在的 PR 地址）；其余缺项给空数组。
 * - usage / branch：有则透传（浅拷贝 usage，防止调用方后续改动穿透）。
 */
export function buildQqTaskResult(input: BuildQqTaskResultInput): QqTaskResult {
  let summary = "";
  for (let i = input.blocks.length - 1; i >= 0; i--) {
    const block = input.blocks[i]!;
    if (block.kind !== "text" || block.system === true) continue;
    const text = block.text.trim();
    if (!text) continue;
    summary = text;
    break;
  }

  const changes: QqTaskChange[] = input.turnChanges.map((change) => ({
    path: change.path,
    additions: change.additions,
    deletions: change.deletions,
    status: change.status,
  }));

  const artifacts: string[] = [];
  const url = input.integration?.url;
  if (url) artifacts.push(url);

  const result: QqTaskResult = {
    stopReason: input.stopReason,
    summary,
    changes,
    artifacts,
  };
  if (input.usage) result.usage = { ...input.usage };
  if (input.branch) result.branch = input.branch;
  return result;
}

// ---------------------------------------------------------------------------
// 纯文本渲染与分片
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<QqTaskStatus, string> = {
  received: "已接收",
  validated: "已校验",
  queued: "排队中",
  dispatched: "已派发",
  running: "执行中",
  waiting_approval: "等待审批",
  waiting_answer: "等待回答",
  succeeded: "成功",
  failed: "失败",
  canceled: "已取消",
  timeout: "已超时",
  needs_review: "需复核",
};

/** 状态的中文短标签（看板与摘要共用，避免两处措辞漂移）。 */
export function qqTaskStatusLabel(status: QqTaskStatus): string {
  return STATUS_LABELS[status];
}

/** standard 档摘要正文的字符上限（超出截断并加省略号）。 */
const STANDARD_SUMMARY_MAX_CHARS = 1200;
/** full 档改动明细 / 产物列表的上限（避免一条 QQ 消息过长）。 */
const FULL_LIST_MAX_ITEMS = 50;

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * 把 Markdown 摘录压成纯文本：去掉标题标记（`#`…）、表格行（`|`…）与代码围栏
 * 标记行，并合并多余空行。**只处理格式标记，不改写内容**（不翻译、不总结）。
 */
function toPlainText(text: string): string {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) continue;
    if (trimmed.startsWith("|")) {
      // 表格分隔行（|---|---|）整行丢弃；数据行去掉竖线，保留单元格文字。
      if (/^\|?[\s:|-]+\|?$/u.test(trimmed) && trimmed.includes("-")) {
        lines.push("");
        continue;
      }
      lines.push(trimmed.replace(/^\|/u, "").replace(/\|$/u, "").replace(/\|/gu, " ").trimEnd());
      continue;
    }
    const heading = /^#{1,6}\s+/u.exec(trimmed);
    lines.push(heading ? trimmed.slice(heading[0].length) : line);
  }
  return lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function formatDuration(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  if (safe < 1000) return `${safe} 毫秒`;
  const seconds = Math.round(safe / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

function indentBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `  ${line}` : ""))
    .join("\n");
}

/**
 * 生成发给 QQ 的纯文本任务摘要。
 *
 * 输出是多行等宽文本：标签 + 两空格对齐，**不产生** Markdown 标题（`#`）与
 * 表格（`|`）；摘要正文还会经 `toPlainText` 去掉 agent 回复里的 Markdown
 * 格式标记。
 *
 * 档位：
 *  - `summary`：短 id、状态、耗时、改动统计、分支、失败/等待、下一步；
 *  - `standard`：追加摘要正文（截断到 1200 字符）；
 *  - `full`：摘要全文 + 改动明细 + 产物列表。
 *
 * 数据缺失时如实写「未记录」，不补造 0 改动或摘要。
 */
export function formatQqTaskSummary(task: QqTask, detail: QqResultDetail): string {
  const lines: string[] = [];
  const result = task.result;
  lines.push(`QQ 任务 ${shortTaskId(task.taskId)}`);
  lines.push(`状态  ${qqTaskStatusLabel(task.status)} (${task.status})`);
  lines.push(`耗时  ${formatDuration(task.updatedAt - task.createdAt)}`);

  if (!result) {
    lines.push("改动  未记录");
  } else {
    const additions = result.changes.reduce((sum, change) => sum + change.additions, 0);
    const deletions = result.changes.reduce((sum, change) => sum + change.deletions, 0);
    lines.push(`改动  ${result.changes.length} 个文件 (+${additions} -${deletions})`);
  }

  const branch = task.correlation.branch ?? result?.branch;
  if (branch) lines.push(`分支  ${branch}`);
  if (result?.stopReason) lines.push(`结束  ${result.stopReason}`);
  if (task.pending) {
    const kind = task.pending.kind === "approval" ? "审批" : "回答";
    lines.push(`等待  ${kind}：${toPlainText(task.pending.text)}`);
  }
  if (task.failure) {
    lines.push(`失败  ${task.failure.code}：${toPlainText(task.failure.message)}`);
  }

  const summary = result ? toPlainText(result.summary) : "";
  if (detail !== "summary" && summary) {
    const body = detail === "full" ? summary : truncateText(summary, STANDARD_SUMMARY_MAX_CHARS);
    lines.push("摘要");
    lines.push(indentBlock(body));
  }

  if (detail === "full" && result && result.changes.length > 0) {
    lines.push("改动明细");
    for (const change of result.changes.slice(0, FULL_LIST_MAX_ITEMS)) {
      lines.push(`  ${change.status ?? "-"}  +${change.additions} -${change.deletions}  ${change.path}`);
    }
    if (result.changes.length > FULL_LIST_MAX_ITEMS) {
      lines.push(`  … 另有 ${result.changes.length - FULL_LIST_MAX_ITEMS} 个文件`);
    }
  }
  if (detail === "full" && result && result.artifacts.length > 0) {
    lines.push("产物");
    for (const artifact of result.artifacts.slice(0, FULL_LIST_MAX_ITEMS)) {
      lines.push(`  ${artifact}`);
    }
  }

  lines.push("下一步");
  lines.push(`  /qq status ${task.taskId}`);
  if (detail !== "summary") lines.push(`  /qq log ${task.taskId}`);
  return lines.join("\n");
}

/**
 * 按行 / 代码围栏边界切分纯文本，保证每片长度不超过 `maxChars`。
 *
 * - 空输入返回 `[]`（没有内容就没有消息）。
 * - 切点落在围栏内部时，当前片尾部补 ` ``` `，下一片头部补 ` ``` ` ——
 *   每片独立可读，不会出现「半个代码块」。
 * - 单行超过预算时按字符硬切（否则「不超长」无法保证）。
 * - `maxChars` 必须为正数，否则抛 `RangeError`（这是编程错误，不是数据问题）。
 *
 * 围栏补齐的开销（最多 8 字符：`\n``` ` 前后各一段）从预算里预留；因此
 * `maxChars` 小于 8 且文本含围栏时，分片可能略微超长 —— 这是刻意的退化，
 * 调用方（QQ 单条消息上限通常 > 1000）不会走到这里。
 */
export function chunkQqText(text: string, maxChars: number): string[] {
  if (text.length === 0) return [];
  if (!Number.isFinite(maxChars) || maxChars < 1) {
    throw new RangeError("chunkQqText: maxChars 必须是正数");
  }
  const limit = Math.floor(maxChars);
  const lines = text.split("\n");
  const chunks: string[] = [];
  let lineIndex = 0;
  let lineOffset = 0;
  /** 上一片结束时围栏是否仍然打开（打开则下一片以 ``` 开头）。 */
  let fenceOpen: boolean = false;

  while (lineIndex < lines.length) {
    const reopened: boolean = fenceOpen;
    const parts: string[] = reopened ? ["```"] : [];
    let joinedLen = reopened ? 3 : 0;
    let open: boolean = reopened;
    let hasContent = false;

    while (lineIndex < lines.length) {
      const full = lines[lineIndex]!;
      const piece = lineOffset === 0 ? full : full.slice(lineOffset);
      const fenceLine = lineOffset === 0 && piece.trimStart().startsWith("```");
      const nextOpen: boolean = fenceLine ? !open : open;
      const separator = parts.length === 0 ? 0 : 1;
      const room = limit - joinedLen - separator - (nextOpen ? 4 : 0);

      if (piece.length <= room) {
        parts.push(piece);
        joinedLen += separator + piece.length;
        open = nextOpen;
        hasContent = true;
        lineIndex++;
        lineOffset = 0;
        continue;
      }
      if (hasContent) break; // 当前片装不下这一行，先发出去

      // 还没有内容行：硬切当前行（超长单行 / 预算极小的退化情形）。
      // 至少推进 1 个字符，避免死循环；此时可能略超预算（见函数注释）。
      const take = Math.max(1, room);
      const cut = piece.slice(0, take);
      parts.push(cut);
      joinedLen += separator + cut.length;
      open = nextOpen;
      hasContent = true;
      if (take >= piece.length) {
        lineIndex++;
        lineOffset = 0;
      } else {
        lineOffset += take;
      }
      break;
    }

    if (parts.length === 0) break; // 理论上不可达：limit ≥ 1 总能放进至少 1 个字符
    chunks.push(open ? `${parts.join("\n")}\n\`\`\`` : parts.join("\n"));
    fenceOpen = open;
  }

  return chunks;
}
