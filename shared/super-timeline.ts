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
 * **todolist 优先（2026-11-13）**：子会话自己用 `todo_write` 建的 todolist 是
 * 用户真正想看的步骤，比宿主观察到的阶段事实贴切。只要 `session.todos` 非空，
 * 轨上的**节点**就只画这些条目（原文 + 完成状态），派发 / 启动 / 集成等阶段
 * 事实不再占节点，改由 `describeSuperTimelineFacts` 拼成串放进 title/aria-label。
 * `todos` 为空或缺省时完整保留上面的阶段轨逻辑（兼容性降级：不空白、不伪造）。
 *
 * 纯逻辑：零 VSCode / 零 React 依赖，看板与单测共用。
 */
import type { SuperSessionUi, SuperTodoUi } from "./super-agent.js";
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
  | "integration"
  /** 子会话自己建的 todolist 条目（原文 label，不翻译）。 */
  | "todo";

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
  /**
   * true = `label` 是子会话写入的动态原文（todolist 条目），webview 必须原样
   * 渲染，**不得**过 `t()` 字典（字典里没有、也不该有用户文本）。
   */
  rawLabel?: boolean;
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
 * 从真实字段推导**阶段**轨（宿主观察到的生命周期事实）。
 *
 * 节点顺序：已派出 → （第 N 次）→ （排队）→ （已启动）→ （在等你回答 | 终态）→
 * （集成结果）。括号里的节点只在对应事实存在时出现。
 *
 * 「当前」语义：非终态时最后一个节点标 `current`；终态时最后一个节点带对应
 * 终态色调（完成 → done / 失败或中断 → failed）—— 已经结束的子会话没有
 * 「正在进行」的阶段，不该继续高亮。
 *
 * 这是唯一一份阶段判定：看板降级轨与 `describeSuperTimelineFacts`（title 用）
 * 都调它，绝不复制第二套规则。
 */
function deriveStageNodes(session: SuperSessionUi): SuperTimelineNode[] {
  const nodes: SuperTimelineNode[] = [];

  const createdAt = finiteAt(session.createdAt);
  nodes.push({
    kind: "dispatched",
    ...(createdAt === undefined ? {} : { at: createdAt }),
    tone: "done",
    label: "已派出",
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
    nodes.push({ kind: "started", at: startedAt, tone: "done", label: "已启动" });
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
      label: "在等你回答",
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

/** detail 里状态词与优先级词的分隔符；webview 按它拆开逐词过 `t()`。 */
export const SUPER_TODO_DETAIL_SEP = " · ";

/** todolist 状态的中文标签（中文是源语言；webview 侧对结果调 `t()` 翻译）。 */
export function superTodoStatusLabel(status: SuperTodoUi["status"]): string {
  switch (status) {
    case "completed":
      return "已完成";
    case "in_progress":
      return "进行中";
    case "pending":
      return "待办";
  }
}

/** todolist 优先级的中文标签（同上，可被 `t()` 翻译的静态词）。 */
export function superTodoPriorityLabel(priority: NonNullable<SuperTodoUi["priority"]>): string {
  switch (priority) {
    case "high":
      return "高优先级";
    case "medium":
      return "中优先级";
    case "low":
      return "低优先级";
  }
}

/**
 * 节点的 detail：状态 / 优先级的中文说明，**只进 title/aria-label**，不作为
 * 可见节点文本（与既有 `detail` 的语义一致）。动态 todo 文本是 `label`，不在这里。
 */
function superTodoDetail(todo: SuperTodoUi): string {
  const parts = [superTodoStatusLabel(todo.status)];
  if (todo.priority) parts.push(superTodoPriorityLabel(todo.priority));
  return parts.join(SUPER_TODO_DETAIL_SEP);
}

/**
 * 子会话自己的 todolist → 时间轴节点。
 *
 * - 每个条目恰好一个节点，`label` 是**原文**（`rawLabel`），`at` 省略 —— wire
 *   不带可靠的逐条时间戳，绝不伪造；
 * - tone 由条目自身状态决定：`completed`→done、`in_progress`→current、
 *   `pending`→idle；
 * - 终态会话与恢复出来的历史记录没有「正在进行」：残留的 `in_progress` 一律
 *   降为 done，不出现 current 高亮（沿用阶段轨的同一条纪律）。
 */
function deriveTodoNodes(session: SuperSessionUi): SuperTimelineNode[] {
  const frozen = isTerminalStatus(session) || session.restored === true;
  return (session.todos ?? []).map((todo): SuperTimelineNode => {
    let tone: SuperTimelineTone;
    if (todo.status === "completed") tone = "done";
    else if (todo.status === "in_progress") tone = frozen ? "done" : "current";
    else tone = "idle";
    return {
      kind: "todo",
      label: todo.content,
      rawLabel: true,
      detail: superTodoDetail(todo),
      tone,
    };
  });
}

/**
 * 时间轴节点：有 todolist 时**只**画子会话自己建的步骤（用户单选决策），
 * 否则完整降级回阶段轨，绝不空白、不伪造。
 */
export function deriveSuperTimeline(session: SuperSessionUi): SuperTimelineNode[] {
  const todos = session.todos;
  if (todos && todos.length > 0) return deriveTodoNodes(session);
  return deriveStageNodes(session);
}

/**
 * 阶段事实的中文串（如「派发 → 启动 → 已完成 → 无需合并」），供 webview 放进
 * title/aria-label —— 决策「只用 todo 节点」后，派发 / 启动 / 集成等事实不再占
 * 节点，但必须仍可查。复用 {@link deriveStageNodes}，不复制第二套判定。
 */
export function describeSuperTimelineFacts(session: SuperSessionUi): string {
  return deriveStageNodes(session)
    .map((node) => node.label)
    .join(" → ");
}

/* ------------------------------------------------------------------------- *
 * 布局：横向单行轨道的窗口化（纯逻辑，webview 只负责画）
 *
 * 2026-11-24：时间轴从「单列纵向 rail + 折叠」改成**横向单行轨道**。折叠交互
 * 随之删除（一行放不下时不再折成「已完成 N 步」，而是压缩），但两条语义必须
 * 保留：
 *
 *  1. 关键节点（等待回答 / 失败 / 合并冲突）**始终在轨道上可见**；
 *  2. 当前步**始终在轨道上可见**。
 *
 * 步骤一多（面板只有约 400px 宽），节点不可能全画：这里把「必须可见」的节点
 * 钉住，再以当前步为中心向外补足到 {@link SUPER_TIMELINE_MAX_VISIBLE_NODES}，
 * 其余连续节点压缩成省略段。规则收在这里，单测直接跑，组件不复制第二套判定。
 * ------------------------------------------------------------------------- */

/**
 * 关键节点：**需要用户介入**，横向轨道上必须始终可见并强调。
 *
 * - `awaiting_input`：子会话在等你回答，不回答它就永远停着；
 * - `failed`：失败原因要能一眼看到；
 * - `integration` 且色调是 failed：合并冲突 / 合并失败 —— 改动没落地，等人处理。
 *
 * `cancelled`（已中断）刻意**不算**关键：它已经结束，不需要用户做任何事；
 * 它仍可能作为普通节点出现在窗口里，只是不享受「永远可见」的待遇。
 */
export function isCriticalTimelineNode(node: SuperTimelineNode): boolean {
  if (node.kind === "awaiting_input") return true;
  if (node.kind === "failed") return true;
  if (node.kind === "integration" && node.tone === "failed") return true;
  return false;
}

/** 时间轴进度：已完成节点数 / 节点总数（用于顶部计数，如 3/6）。 */
export interface SuperTimelineProgress {
  /** `tone === "done"` 的节点数（todo 模式下即 completed 条目数）。 */
  done: number;
  /** 节点总数（只算真实发生过的节点，不预置占位）。 */
  total: number;
}

export function summarizeSuperTimelineProgress(
  nodes: readonly SuperTimelineNode[],
): SuperTimelineProgress {
  let done = 0;
  for (const node of nodes) if (node.tone === "done") done += 1;
  return { done, total: nodes.length };
}

/**
 * 横向轨道上最多画多少个真实节点。
 *
 * 面板约 400px 宽（内容行实测约 354px）。左侧「进度 8/15」占约 51px，每个节点
 * （14px 字形 + 2px 内边距）连同 4px 连接段约 20px。实测 10 个节点时右侧「当前
 * 步骤」只剩约 79px（≈5 个中文字，读不出是哪一步），收到 8 个后仍有约 115px
 * （≈9 个中文字）。再多就必须压缩（见 {@link layoutSuperTimelineRail}）——
 * 横向轨道不能出现滚动条，也不能把图标挤成重叠的一团。
 */
export const SUPER_TIMELINE_MAX_VISIBLE_NODES = 8;

/**
 * 横向轨道的一段：一个真实节点，或一段被压缩的连续节点（省略段）。
 *
 * 省略段带 `from` / `to`（闭区间），组件据此报「省略 N 步」并保留原始位置，
 * 不做「藏起来就看不见」的黑箱。
 */
export type SuperTimelineRailSegment =
  | { type: "node"; index: number }
  | { type: "gap"; from: number; to: number };

/**
 * 把节点序列压成横向轨道可渲染的段序列。
 *
 * 策略（**压缩而非折叠**）：轨道是单行、无滚动、无展开交互，因此不能像旧纵向
 * rail 那样把一段藏进可点击的折叠行。规则：
 *
 *  1. 节点数 ≤ {@link SUPER_TIMELINE_MAX_VISIBLE_NODES}：全部原样渲染，无省略段。
 *  2. 超出时先**钉住**必须可见的节点 —— 全部 {@link isCriticalTimelineNode}
 *     关键节点，加锚点（最后一个 `current` 节点；终态轨没有 current 则取最后
 *     一个节点）。
 *  3. 钉住数仍不足上限时，以锚点为中心**由近及远**补齐（同距离先左后右，让
 *     用户看到「刚走过的几步」和「马上要做的几步」）。
 *  4. 其余未选中的连续节点合成 `gap` 段，插回原本位置。
 *
 * 保证：关键节点与当前步**永不被压缩**；段序列保持原始时间顺序；`gap` 段之间
 * 不连续（相邻的未选中区间会被拆成两段，中间隔着被选中的节点）。
 */
export function layoutSuperTimelineRail(
  nodes: readonly SuperTimelineNode[],
): SuperTimelineRailSegment[] {
  const total = nodes.length;
  if (total <= SUPER_TIMELINE_MAX_VISIBLE_NODES) {
    return nodes.map((_, index): SuperTimelineRailSegment => ({ type: "node", index }));
  }

  const pinned = new Set<number>();
  let anchor = -1;
  nodes.forEach((node, index) => {
    if (node.tone === "current") anchor = index;
  });
  if (anchor < 0) anchor = total - 1;
  pinned.add(anchor);
  nodes.forEach((node, index) => {
    if (isCriticalTimelineNode(node)) pinned.add(index);
  });

  // 由近及远补齐：距离 1、2、3… 交替取锚点左右两侧。
  let distance = 1;
  while (pinned.size < SUPER_TIMELINE_MAX_VISIBLE_NODES && distance < total) {
    const left = anchor - distance;
    const right = anchor + distance;
    if (left >= 0 && pinned.size < SUPER_TIMELINE_MAX_VISIBLE_NODES) pinned.add(left);
    if (right < total && pinned.size < SUPER_TIMELINE_MAX_VISIBLE_NODES) pinned.add(right);
    distance += 1;
  }

  const segments: SuperTimelineRailSegment[] = [];
  let gapStart = -1;
  for (let index = 0; index < total; index += 1) {
    if (pinned.has(index)) {
      if (gapStart >= 0) {
        segments.push({ type: "gap", from: gapStart, to: index - 1 });
        gapStart = -1;
      }
      segments.push({ type: "node", index });
    } else if (gapStart < 0) {
      gapStart = index;
    }
  }
  if (gapStart >= 0) segments.push({ type: "gap", from: gapStart, to: total - 1 });
  return segments;
}
