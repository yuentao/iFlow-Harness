/**
 * 子会话阶段轨 —— 只画真实发生过的节点。
 *
 * 看板上的进度必须由**事实**推导，不能渲染一份固定模板（「准备 → 运行 →
 * 收尾 → 完成」）。宿主没有任务级百分比，也没有阶段事件流：能用的只有
 * `SuperSessionUi` 上真实写入的标记与时间戳（createdAt / queued / attempts /
 * startedAt / pending / endedAt / status / integration）。本模块把它们映射成
 * 一条按时间先后排列的节点序列：
 *
 *  - 只有发生过（或正在进行）的阶段才有节点；
 *  - 尚未发生的阶段绝不预置灰点 —— 还在跑就只有「派发 → 启动」，不会出现
 *    「收尾」「完成」这种占位；
 *  - `restored`（扩展重启后恢复的历史记录）不额外造节点：进程已经没了，剩下
 *    的只有磁盘上的分支与结束状态，多画一个「上次运行」就是伪造。
 *
 * 纯逻辑：零 VSCode / 零 React 依赖，看板与单测共用。
 */
import type { SuperSessionUi } from "./super-agent.js";
import { superIntegrationLabel } from "./super-agent.js";

/**
 * 节点色调（视觉只是第三重编码，形状与文案才是主编码）。
 *
 *  - `done`   已发生的节点（实心）
 *  - `current` 正在进行的那个节点（高亮 ring / 脉冲）
 *  - `failed`  失败与被中断（错误色）
 *  - `idle`    已发生但不需要动作的事实（如集成被跳过，静音色）
 */
export type SuperTimelineTone = "done" | "current" | "failed" | "idle";

export type SuperTimelineKind =
  /** 派发：`createdAt` 恒有，永远是新轨的第一个节点。 */
  | "dispatched"
  /** 排队等并发名额（`queued` 为真）。 */
  | "queued"
  /** 第 N 次尝试（`attempts > 1`）。 */
  | "attempt"
  /** 子会话真的启动了（`startedAt` 存在）。 */
  | "started"
  /** 正在等用户回答（`pending` 存在）。 */
  | "awaiting_input"
  /** 正常完成。 */
  | "completed"
  /** 失败。 */
  | "failed"
  /** 被用户中断 / 进程随宿主退出。 */
  | "cancelled"
  /** 结束后把分支带回主工作区的结果。 */
  | "integration";

export interface SuperTimelineNode {
  kind: SuperTimelineKind;
  /**
   * 该节点真实发生的时间（epoch ms），没有可靠时间戳时省略。
   *
   * 只用于 title / aria-label：看板一行放不下六个时间戳，铺开就是噪音。
   */
  at?: number;
  tone: SuperTimelineTone;
  /** 中文标签（中文是源语言）。webview 侧再过 `t()` 字典。 */
  label: string;
  /** 次要说明（如集成被跳过的原因），同样只进 title。 */
  detail?: string;
  /** 第几次尝试（仅 `attempt` 节点；webview 用它套 i18n 模板）。 */
  attempt?: number;
}

/** 只接受有限的数值时间戳 —— 脏数据不生成「1970 年」这种假节点。 */
function finiteAt(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 终态判定（与 `shared/super-agent.ts` 的状态机语义一致，刻意不 import
 * 那里的私有常量：这里只关心「还有没有下一步会发生」）。 */
function isTerminalStatus(session: SuperSessionUi): boolean {
  return (
    session.status === "completed" || session.status === "failed" || session.status === "cancelled"
  );
}

/**
 * 从真实字段推导阶段轨。
 *
 * 节点顺序：派发 → （第 N 次）→ （排队）→ （启动）→ （等待应答 | 终态）→
 * （集成结果）。括号里的节点只在对应事实存在时出现。
 *
 * 「当前」语义：非终态时最后一个节点标 `current`；终态时最后一个节点带对应
 * 终态色调（完成 → done / 失败或中断 → failed）—— 已经结束的子会话没有
 * 「正在进行」的阶段，不该继续高亮。
 */
export function deriveSuperTimeline(session: SuperSessionUi): SuperTimelineNode[] {
  const nodes: SuperTimelineNode[] = [];

  const createdAt = finiteAt(session.createdAt);
  nodes.push({
    kind: "dispatched",
    ...(createdAt === undefined ? {} : { at: createdAt }),
    tone: "done",
    label: "派发",
  });

  const attempts = session.attempts ?? 1;
  if (attempts > 1) {
    // 重试会重置 startedAt 并让 attempts +1：这个节点说明「现在这条轨是第
    // 几次跑」，不是一次新的派发。
    nodes.push({ kind: "attempt", tone: "done", label: `第 ${attempts} 次`, attempt: attempts });
  }

  if (session.queued) {
    // 排队没有自己的时间戳（只有布尔标记），因此不给 `at` —— 不猜时间。
    nodes.push({ kind: "queued", tone: "done", label: "排队" });
  }

  const startedAt = finiteAt(session.startedAt);
  if (startedAt !== undefined) {
    nodes.push({ kind: "started", at: startedAt, tone: "done", label: "启动" });
  }

  if (session.pending) {
    // 提问的到达时间可以从宿主自己的超时窗口反推：deadline 是绝对截止时间，
    // timeoutMs 是窗口长度 —— 两者之差就是问题抛出的时刻（精确，不是估算）。
    const deadline = finiteAt(session.pending.deadline);
    const timeoutMs = finiteAt(session.pending.timeoutMs);
    const at = deadline !== undefined && timeoutMs !== undefined && timeoutMs > 0
      ? deadline - timeoutMs
      : undefined;
    nodes.push({
      kind: "awaiting_input",
      ...(at === undefined ? {} : { at }),
      tone: "current",
      label: "等待应答",
    });
  }

  // 终态节点：`endedAt` 是状态机写入的真实结束时间；恢复出来的历史记录可能
  // 只有 updatedAt，用它兜底（同样是磁盘上的事实）。
  const endedAt = finiteAt(session.endedAt) ?? finiteAt(session.updatedAt);
  if (session.status === "completed") {
    nodes.push({
      kind: "completed",
      ...(endedAt === undefined ? {} : { at: endedAt }),
      tone: "done",
      label: "已完成",
    });
  } else if (session.status === "failed") {
    nodes.push({
      kind: "failed",
      ...(endedAt === undefined ? {} : { at: endedAt }),
      tone: "failed",
      label: "失败",
      ...(session.error ? { detail: session.error } : {}),
    });
  } else if (session.status === "cancelled") {
    nodes.push({
      kind: "cancelled",
      ...(endedAt === undefined ? {} : { at: endedAt }),
      tone: "failed",
      label: "已中断",
    });
  }

  const integration = session.integration;
  if (integration) {
    // 集成发生在子会话结束之后，所以它是轨的最后一节；色调由结果本身决定
    // （已合并/PR = 落地、冲突/失败 = 错误、跳过 = 静音），不再被下面的
    // 「终态色调」覆盖 —— 「完成了但没合并」不该显示成绿色的成功。
    const tone: SuperTimelineTone =
      integration.state === "merged" || integration.state === "pr_created"
        ? "done"
        : integration.state === "skipped" || integration.state === "not_needed"
          ? "idle"
          : "failed";
    const detail = integration.url ?? integration.detail;
    const integrationAt = finiteAt(integration.at);
    nodes.push({
      kind: "integration",
      ...(integrationAt === undefined ? {} : { at: integrationAt }),
      tone,
      label: superIntegrationLabel(integration),
      ...(detail ? { detail } : {}),
    });
  }

  const lastIndex = nodes.length - 1;
  const terminal = isTerminalStatus(session);
  return nodes.map((node, index) => {
    if (index !== lastIndex) return node;
    if (!terminal) return { ...node, tone: "current" };
    // 终态：最后一个节点是集成结果时保留它自己的色调（见上），否则按终态
    // 上色 —— 已完成的子会话没有「当前」阶段可高亮。
    if (node.kind === "integration") return node;
    return { ...node, tone: session.status === "completed" ? "done" : "failed" };
  });
}
