/**
 * QQ 宿主适配器（Wave3-B2a）：把 panel 无法单测的能力抽成端口，这里只做编排。
 *
 * 职责边界：
 *  - 本模块 **不 import vscode、不 spawn 进程、不读磁盘**，全部能力经
 *    {@link QqHostPorts} 注入 —— 于是派发 / 等待 / 取消 / 合并 / 投递这些
 *    「面板专属」动作都能在纯内存假端口上回归。
 *  - 与 `QqService`（B1）的唯一耦合是 {@link QqServiceHost} 契约：服务负责
 *    命令解析、队列、审批桥与结果回传，适配器只把契约逐个映射到端口。
 *
 * 不伪造纪律：
 *  - 读不到执行摘要时返回占位文案 {@link QQ_MISSING_SUMMARY_TEXT}，**绝不**
 *    编造内容；`stopReason` 没有来源就省略（服务侧会按自己的缺省值处理）。
 *  - 等待超时抛 {@link QqSettleTimeoutError}，不吞错、不返回成功 —— 由服务
 *    记 failed，绝不谎称任务跑完了。
 *  - 派发失败（`spawnTask` 抛错）原样向上抛，不做「尽力而为」的降级。
 *  - 本模块不打印任何日志、不接触任何凭据。
 */

import { shortTaskId } from "../../shared/qq-task.js";
import type { QqPendingUserInput } from "./pending-users.js";
import type {
  SuperApprovalMode,
  SuperPermissionDecision,
  SuperPermissionRequest,
} from "../panel/super-agent.js";
import type {
  QqServiceDeliverInput,
  QqServiceDispatchInput,
  QqServiceDispatchResult,
  QqServiceHost,
  QqServiceTaskOutcome,
} from "./service.js";

// ---------------------------------------------------------------------------
// 端口面（由 panel 在 B2b 实现）
// ---------------------------------------------------------------------------

/** 派发一个子会话时的标题与任务正文。 */
export interface QqHostSpawnSpec {
  /** 看板标题（`QQ <短任务 id>`）。 */
  title: string;
  /** 交给子会话的任务正文（逐字来自 QQ 消息，不改写）。 */
  task: string;
}

/** 派发策略：审批模式、工具黑名单与审批回调（与 Super Agent 同口径）。 */
export interface QqHostSpawnOptions {
  approval: SuperApprovalMode;
  disallowedTools: string[];
  onPermission: (request: SuperPermissionRequest) => Promise<SuperPermissionDecision>;
}

/** 子会话的只读快照；端口不知道的字段就别填（缺省即「不知道」）。 */
export interface QqHostSuperSnapshot {
  /** 子会话最终汇报摘要。 */
  summary?: string;
  /** worktree 隔离时的分支名。 */
  branch?: string;
  /** 子会话状态（如 `running` / `merged` / `interrupted`），原样透传。 */
  status?: string;
  /** 是否已合并回当前分支（已知才填）。 */
  merged?: boolean;
}

/**
 * 宿主能力端口。
 *
 * 每一项都对应一个 panel 侧能力；适配器只负责把它们串成
 * {@link QqServiceHost} 需要的样子，不含任何业务判断。
 */
export interface QqHostPorts {
  /** 当前窗口的工作区根列表（配置未指定 workspace 时取第一个）。 */
  workspaceRoots(): string[];
  /**
   * 启动一个 Super Agent 子会话。
   *
   * 同步返回子会话 id（与可选分支）；失败直接抛错。宿主必须在返回前就把
   * 子会话登记好，因为这之后服务可能立刻收到 `/qq stop`。
   */
  spawnTask(spec: QqHostSpawnSpec, opts: QqHostSpawnOptions): {
    superSessionId: string;
    branch?: string;
  };
  /** 等待子会话收尾；`timeoutMs` 是建议上限（端口应自行兜底）。 */
  waitForSettle(superSessionId: string, timeoutMs?: number): Promise<void>;
  /** 请求停止子会话。 */
  cancel(superSessionId: string): Promise<void>;
  /** 把子会话分支合并回当前分支；失败原因放在 `detail` 里原样返回。 */
  merge(superSessionId: string): Promise<{ ok: boolean; detail: string }>;
  /** 丢弃子会话分支 / 工作目录。 */
  discard(superSessionId: string): Promise<void>;
  /** 读取子会话快照；读不到返回 null。 */
  readSuper(superSessionId: string): QqHostSuperSnapshot | null;
  /** 本地通知（面板 toast / 日志），不发往 QQ。 */
  notify(text: string): void;
  /** 回复一条 QQ 消息；返回是否成功送达。 */
  deliver(msg: QqServiceDeliverInput): Promise<boolean>;
  /** 白名单外的人发来消息：只记录，不执行、不回执（面板据此审核）。 */
  onPendingUser(info: QqPendingUserInput): void;
  /** 解除账号绑定。 */
  unbindAccount(): Promise<{ ok: boolean; message: string }>;
}

// ---------------------------------------------------------------------------
// 常量与错误
// ---------------------------------------------------------------------------

/** 默认等待上限：2 小时（真实任务可能跑很久，但绝不无限挂起）。 */
export const QQ_DEFAULT_SETTLE_TIMEOUT_MS = 2 * 60 * 60_000;

/** 子会话没有返回摘要时的占位文案（不得编造内容）。 */
export const QQ_MISSING_SUMMARY_TEXT = "（子会话未返回摘要）";

/**
 * 等待子会话收尾超时。
 *
 * 刻意不返回「成功」：超时意味着执行结果未知，服务会据此把任务记为失败。
 */
export class QqSettleTimeoutError extends Error {
  readonly code = "timeout";

  constructor(
    readonly superSessionId: string,
    readonly timeoutMs: number,
  ) {
    super(`等待子会话 ${superSessionId} 收尾超时（${timeoutMs}ms）`);
    this.name = "QqSettleTimeoutError";
  }
}

/** 适配器可注入的参数（仅测试与特殊部署需要）。 */
export interface QqHostOptions {
  /** 等待收尾上限，缺省 {@link QQ_DEFAULT_SETTLE_TIMEOUT_MS}。 */
  settleTimeoutMs?: number;
}

/** 读到的任务快照：在服务契约之上保留 `status` / `merged` 两个观测位。 */
export interface QqHostTaskOutcome extends QqServiceTaskOutcome {
  /** 子会话状态（端口提供的原文，不解释）。 */
  status?: string;
  /** 是否已合并（端口明确给出时才有值）。 */
  merged?: boolean;
}

/**
 * 子会话终态 → 任务停止原因。
 *
 * 只映射**观察到的事实**：完成 = `end_turn`、失败 = `error`、被中断 =
 * `canceled`。其余状态（准备中 / 运行中 / 等待应答）没有可靠的停止原因，
 * 返回 `undefined`（不编造）。
 *
 * 为什么必须有这层：服务侧按 `stopReason` 决定任务终态。没有映射时，被中断
 * 的子会话会被当成「正常结束」记成成功 —— QQ 会收到一份假成功结果。
 */
export function stopReasonForSuperStatus(
  status: string | null | undefined,
): string | undefined {
  switch (status) {
    case "completed":
      return "end_turn";
    case "failed":
      return "error";
    case "cancelled":
      return "canceled";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

/**
 * 用端口构造 {@link QqServiceHost}。
 *
 * 每个方法都是薄映射，唯一带逻辑的三处是：
 *  1. `dispatchTask`：派发后立刻把 `superSessionId` / `branch` 写回
 *     `input.task.correlation` —— `/qq stop` 与 `/qq merge` 都靠这个字段定位
 *     子会话，晚一步写就等于丢掉了正在跑的任务。
 *  2. `readTaskOutcome`：缺摘要时给占位文案，其余字段有才透传。
 *  3. `readTaskOutcome` 里的终态映射：完成/失败/被中断分别给出 `end_turn` /
 *     `error` / `canceled`，让服务能把任务收在正确的终态上（否则被中断的任务
 *     会被记成「成功」）。
 */
export function createQqServiceHost(
  ports: QqHostPorts,
  options: QqHostOptions = {},
): QqServiceHost {
  const settleTimeoutMs =
    typeof options.settleTimeoutMs === "number" && Number.isFinite(options.settleTimeoutMs)
      ? Math.max(0, options.settleTimeoutMs)
      : QQ_DEFAULT_SETTLE_TIMEOUT_MS;

  /** 等端口收尾，并用本地计时器兜底超时（端口自身也可以限时）。 */
  async function waitForSettle(superSessionId: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new QqSettleTimeoutError(superSessionId, settleTimeoutMs)),
        settleTimeoutMs,
      );
    });
    try {
      await Promise.race([ports.waitForSettle(superSessionId, settleTimeoutMs), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    workspaceRoots(): string[] {
      return ports.workspaceRoots();
    },

    async dispatchTask(input: QqServiceDispatchInput): Promise<QqServiceDispatchResult> {
      // spawnTask 抛错时保持原样上抛：调用方（QqService）会记 failed。
      const spawned = ports.spawnTask(
        { title: `QQ ${shortTaskId(input.task.taskId)}`, task: input.task.payload.prompt },
        {
          approval: input.approval,
          disallowedTools: input.disallowedTools,
          onPermission: input.onPermission,
        },
      );

      // 同步回填：这一步必须早于任何 await，否则 `/qq stop` 可能读不到 id。
      input.task.correlation.superSessionId = spawned.superSessionId;
      if (spawned.branch) input.task.correlation.branch = spawned.branch;

      await waitForSettle(spawned.superSessionId);

      return spawned.branch
        ? { superSessionId: spawned.superSessionId, branch: spawned.branch }
        : { superSessionId: spawned.superSessionId };
    },

    async cancelTask(superSessionId: string): Promise<void> {
      await ports.cancel(superSessionId);
    },

    async mergeTask(superSessionId: string): Promise<{ ok: boolean; detail: string }> {
      return ports.merge(superSessionId);
    },

    async discardTask(superSessionId: string): Promise<void> {
      await ports.discard(superSessionId);
    },

    readTaskOutcome(superSessionId: string): QqHostTaskOutcome | null {
      const snapshot = ports.readSuper(superSessionId);
      if (!snapshot) return null;

      const summary =
        typeof snapshot.summary === "string" && snapshot.summary.trim().length > 0
          ? snapshot.summary
          : QQ_MISSING_SUMMARY_TEXT;

      const outcome: QqHostTaskOutcome = { summary };
      // 终态子会话给出可核对的停止原因；非终态（或陌生值）不编造，直接省略。
      const stopReason = stopReasonForSuperStatus(snapshot.status);
      if (stopReason) outcome.stopReason = stopReason;
      if (typeof snapshot.branch === "string" && snapshot.branch.length > 0) {
        outcome.branch = snapshot.branch;
      }
      if (typeof snapshot.status === "string" && snapshot.status.length > 0) {
        outcome.status = snapshot.status;
      }
      if (typeof snapshot.merged === "boolean") {
        outcome.merged = snapshot.merged;
      } else if (snapshot.status === "merged") {
        outcome.merged = true;
      }
      return outcome;
    },

    async deliver(msg: QqServiceDeliverInput): Promise<boolean> {
      return ports.deliver(msg);
    },

    onPendingUser(info: QqPendingUserInput): void {
      ports.onPendingUser(info);
    },

    async unbindAccount(): Promise<{ ok: boolean; message: string }> {
      return ports.unbindAccount();
    },

    notify(text: string): void {
      ports.notify(text);
    },
  };
}
