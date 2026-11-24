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
 * 布局：当前节点居中的聚焦视窗（纯逻辑，webview 只负责画）
 *
 * 2026-11-24：时间轴从「横向单行 + 窗口化压缩」改成**当前节点居中**的聚焦
 * 视图：外层视窗 `overflow-hidden`，内层轨道用 `transform: translateX()` 平移，
 * 让当前节点落在视窗正中，左右各露出上一步 / 下一步并渐隐。窗口化（上限 N 个
 * 节点 + 「…」省略段）随之删除 —— 所有节点都还在轨道上，靠平移展示。
 *
 * 两条语义必须保留：
 *
 *  1. 当前步**落在视窗中央**（首末节点时 clamp，宁可偏一点也不拉出空白）；
 *  2. 关键节点（等待回答 / 失败 / 合并冲突）**不能被平移到视窗外而彻底消失**：
 *     落在视窗外的关键节点由边缘提示兜底，点击即平移过去（只平移，不弹窗）。
 *
 * 平移量与边缘提示都收在这里，单测直接跑，组件不复制第二套判定。
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
 * 轨道上单个节点的占位尺寸（px）。
 *
 * 节点是 `p-1` 包裹的 `ICON_INLINE`（14px）圆点 → 14 + 4×2 = 22px。这个数字是
 * 纯逻辑与组件共用的**几何契约**：居中平移要算节点中心，首帧 / jsdom 没有布局
 * 时也要给出可用的等距模型。改节点内边距时必须同步这里，否则平移会偏。
 */
export const SUPER_TIMELINE_NODE_SIZE = 22;

/** 相邻节点的中心间距（px）：节点 22 + 连接段 8（`w-2`）。 */
export const SUPER_TIMELINE_NODE_PITCH = 30;

/** 轨道几何：节点中心的轨道内坐标 + 轨道总宽（px）。 */
export interface SuperTimelineGeometry {
  /** 每个节点中心在轨道坐标系里的 x 偏移，按时间顺序。 */
  centers: number[];
  /** 轨道总宽（px）。 */
  trackWidth: number;
}

/**
 * 等距模型（无布局环境 / 首帧兜底）。
 *
 * 节点尺寸与连接段都是固定类名，真实 DOM 里也是等距的 —— 所以这个模型不是
 * 估算，而是同一份几何契约的解析式。组件优先用实测矩形（字体缩放 / 自定义
 * 密度可能改变实际像素），量不到（jsdom 全 0）时才退回这里。
 *
 * `padding` 是轨道内层为渐隐带预留的水平内边距（见
 * {@link superTimelineTrackPadding}）：它是几何的一部分，节点中心整体右移
 * `padding`，轨道宽两端各加 `padding`。组件必须把同一个值传给真实 DOM 的
 * `padding-left/right`，否则实测几何与本模型不一致。
 */
export function estimateSuperTimelineGeometry(
  count: number,
  padding = 0,
): SuperTimelineGeometry {
  if (count <= 0) return { centers: [], trackWidth: 0 };
  const pad = Number.isFinite(padding) && padding > 0 ? padding : 0;
  return {
    centers: Array.from(
      { length: count },
      (_, index) => pad + index * SUPER_TIMELINE_NODE_PITCH + SUPER_TIMELINE_NODE_SIZE / 2,
    ),
    trackWidth: (count - 1) * SUPER_TIMELINE_NODE_PITCH + SUPER_TIMELINE_NODE_SIZE + pad * 2,
  };
}

/**
 * 让 `focusCenter` 落在视窗水平中央所需的 `translateX`（px，负值 = 轨道左移）。
 *
 * 两条分支，取舍写在代码里而不是靠肉眼调：
 *
 *  1. **整条轨装得下**（`trackWidth ≤ viewportWidth`）：把**整条轨道**居中。
 *     逐节点居中在短轨上会把一大块空白全推到一侧（3 个节点、当前在首时左侧
 *     要空出 140px），看起来像布局坏了；轨道居中把空白均分到两侧，奇数节点、
 *     当前步在正中时仍然精确居中。
 *  2. **装不下**：按焦点节点居中算，再 clamp 到 `[viewportWidth - trackWidth, 0]`
 *     —— 上界 0 保证左侧不露白，下界保证右侧不露白。当前步在首 / 末时因此
 *     **不会**严格居中（宁可偏一点，也不拉出大块空白）。
 */
export function computeSuperTimelineTranslateX(params: {
  /** 要居中的节点中心（轨道内坐标，px）。 */
  focusCenter: number;
  /** 轨道总宽（px）。 */
  trackWidth: number;
  /** 视窗宽度（px）；0 / 负数表示还没有布局。 */
  viewportWidth: number;
}): number {
  const { focusCenter, trackWidth, viewportWidth } = params;
  if (!Number.isFinite(focusCenter) || !Number.isFinite(trackWidth) || !Number.isFinite(viewportWidth)) {
    return 0;
  }
  if (viewportWidth <= 0 || trackWidth <= 0) return 0;
  if (trackWidth <= viewportWidth) return Math.round((viewportWidth - trackWidth) / 2);
  const desired = viewportWidth / 2 - focusCenter;
  const min = viewportWidth - trackWidth;
  return Math.round(Math.min(0, Math.max(min, desired)));
}

/**
 * 边缘提示里的一条节点标签。
 *
 * 关键节点目前都是**阶段**节点（等待回答 / 失败 / 合并冲突），标签是内置状态词，
 * 英文界面必须过字典；但接口不假设这一点：`rawLabel` 为真的节点（子会话自己
 * 写的 todolist 原文）必须原样渲染 —— 用户文本不得进翻译表，也不得被 `t()`
 * 改写。组件按这个标记逐条决定是否翻译，不盲调 `t()`。
 */
export interface SuperTimelineEdgeHintLabel {
  /** 标签原文（中文是源语言）。 */
  label: string;
  /** true = 子会话写入的动态原文，webview 必须原样渲染、不得过字典。 */
  rawLabel?: boolean;
}

/** 视窗某一侧屏外关键节点的提示。 */
export interface SuperTimelineEdgeHint {
  side: "left" | "right";
  /** 该侧**完全落在视窗外**的关键节点数。 */
  count: number;
  /** 离视窗最近的那个关键节点索引 —— 点击后轨道平移到它。 */
  index: number;
  /**
   * 这些关键节点的标签（带 `rawLabel` 标记，webview 据此逐条决定是否过字典）。
   */
  labels: SuperTimelineEdgeHintLabel[];
  /**
   * 色调：等待回答是「等你」，用警告色；失败 / 合并冲突用错误色。同一侧有多种
   * 关键节点时，靠近视窗的那个决定色调（用户最先要处理的就是它）。
   */
  tone: "warning" | "danger";
}

/**
 * 视窗两侧渐隐带的宽度占比 —— 必须与 `styles.css` 里 `.timeline-viewport` 的
 * `mask-image` 断点（15% / 85%）保持一致。落在渐隐带里的节点虽然几何上还在
 * 视窗内，实际已经淡到几乎看不见，按「不可见」处理。
 */
export const SUPER_TIMELINE_FADE_RATIO = 0.15;

/**
 * 轨道内层为左右渐隐带预留的水平内边距（px）。
 *
 * 遮罩在视窗左右各 `SUPER_TIMELINE_FADE_RATIO` 的宽度上从透明渐变到不透明。
 * 轨道不加内边距时，首 / 末节点 clamp 后中心距视窗边缘只有半个节点（11px），
 * 正落在渐隐带里 —— 最该看清的那个节点反而发灰。给轨道内层垫上与渐隐带等宽
 * 的内边距后，clamp 到首 / 末时节点中心距边缘 ≥ `padding + 11px`，稳稳落在
 * 实心带内。这段 padding 是几何模型的一部分（`trackWidth` 与 `centers` 同步
 * 偏移），组件按同一个函数取值，绝不自己另算一份。
 */
export function superTimelineTrackPadding(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return 0;
  return Math.round(viewportWidth * SUPER_TIMELINE_FADE_RATIO);
}

/**
 * 视窗外关键节点的边缘提示。
 *
 * 居中当前步的代价是：别的步骤会被平移到视窗外。普通节点消失无所谓（轨道
 * 本身就是「聚焦当前」），但**关键节点代表需要用户介入**，不能因为居中当前步
 * 就看不见。这里按侧汇总「看不见」的关键节点，给出数量与最近的一个 —— 组件
 * 据此渲染一个可点的提示，点它只做平移（把那个关键节点移到视窗中央）。
 *
 * 「看不见」的判定**包含渐隐带**：节点中心落在
 * `[visibleStart + fade, visibleEnd - fade]` 之外就算。只按「完全出界」判定会
 * 漏掉半截卡在 15% 渐隐带里的节点 —— 那种节点几何上还在视窗内，但已经被遮罩
 * 淡到读不出来，用户同样会以为它消失了。
 */
export function computeSuperTimelineEdgeHints(params: {
  nodes: readonly SuperTimelineNode[];
  centers: readonly number[];
  translateX: number;
  viewportWidth: number;
  /** 节点占位尺寸（px），默认 {@link SUPER_TIMELINE_NODE_SIZE}。 */
  nodeSize?: number;
}): SuperTimelineEdgeHint[] {
  const { nodes, centers, translateX, viewportWidth } = params;
  const nodeSize = params.nodeSize ?? SUPER_TIMELINE_NODE_SIZE;
  if (viewportWidth <= 0 || nodes.length === 0) return [];

  const visibleStart = -translateX;
  const visibleEnd = visibleStart + viewportWidth;
  const half = nodeSize / 2;
  // 渐隐带宽度；节点半宽也算进去，避免「中心刚过线、半截还亮着」来回跳。
  const fade = Math.max(0, viewportWidth * SUPER_TIMELINE_FADE_RATIO);
  const solidStart = visibleStart + Math.max(0, fade - half);
  const solidEnd = visibleEnd - Math.max(0, fade - half);

  /** 关键节点的色调（等回答=警告，其余=错误）。 */
  const toneOf = (node: SuperTimelineNode): "warning" | "danger" =>
    node.kind === "awaiting_input" ? "warning" : "danger";

  const left: SuperTimelineEdgeHint = {
    side: "left",
    count: 0,
    index: -1,
    labels: [],
    tone: "danger",
  };
  const right: SuperTimelineEdgeHint = {
    side: "right",
    count: 0,
    index: -1,
    labels: [],
    tone: "danger",
  };

  /** 关键节点的标签：带上 `rawLabel` 标记，交给 webview 决定是否过字典。 */
  const labelOf = (node: SuperTimelineNode): SuperTimelineEdgeHintLabel =>
    node.rawLabel ? { label: node.label, rawLabel: true } : { label: node.label };

  nodes.forEach((node, index) => {
    if (!isCriticalTimelineNode(node)) return;
    const center = centers[index];
    if (center === undefined || !Number.isFinite(center)) return;
    if (center < solidStart) {
      left.count += 1;
      // 升序遍历：越靠后的索引越贴近视窗，最后一个就是最近的那个。
      left.index = index;
      left.tone = toneOf(node);
      left.labels.push(labelOf(node));
    } else if (center > solidEnd) {
      right.count += 1;
      // 第一个（最靠左）就是右侧最近的那个 —— 只有它决定色调。
      if (right.index < 0) {
        right.index = index;
        right.tone = toneOf(node);
      }
      right.labels.push(labelOf(node));
    }
  });

  const hints: SuperTimelineEdgeHint[] = [];
  if (left.count > 0) hints.push(left);
  if (right.count > 0) hints.push(right);
  return hints;
}

/** 聚焦视图的完整布局结果。 */
export interface SuperTimelineFocusLayout {
  /** 轨道平移量（px）。 */
  translateX: number;
  /** 屏外关键节点的边缘提示。 */
  hints: SuperTimelineEdgeHint[];
}

/**
 * 一次算出「平移量 + 边缘提示」。
 *
 * 两者同源（同一份节点中心 + 同一个视窗宽度），但**互不干扰**：提示按钮渲染在
 * 轨道下方单独一行（见组件），不浮在轨道上，所以不需要为它预留沟槽，平移量
 * 也不必为提示让步。这比「按提示收窄居中窗口」的不动点迭代稳得多 —— 收窄会
 * 把节点推得更靠外，进而改变提示集合，来回振荡。
 */
export function layoutSuperTimelineFocus(params: {
  nodes: readonly SuperTimelineNode[];
  centers: readonly number[];
  trackWidth: number;
  viewportWidth: number;
  /** 要居中的节点索引。 */
  focusIndex: number;
}): SuperTimelineFocusLayout {
  const { nodes, centers, trackWidth, viewportWidth, focusIndex } = params;
  const focusCenter = centers[focusIndex] ?? 0;
  const translateX = computeSuperTimelineTranslateX({
    focusCenter,
    trackWidth,
    viewportWidth,
  });
  return {
    translateX,
    hints: computeSuperTimelineEdgeHints({ nodes, centers, translateX, viewportWidth }),
  };
}
