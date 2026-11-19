/**
 * 结构化工具调用式派发 / 管理的宿主兜底（纯逻辑，零 VS Code / Node / 文件系统依赖）。
 *
 * 动因：模型偶尔不按 ` ```super-agent ` / ` ```super-agent-actions ` 围栏输出，
 * 而是把它们写成**工具调用**（`tool_call` 帧，工具名 `super-agent` /
 * `super-agent-actions`，参数就是载荷 JSON）。这两个工具**不在内核 registry
 * 里** —— CLI 找不到工具，宿主原来既不执行也不提示，用户以为「已经派了」，
 * 实际上什么都没有发生。
 *
 * 兜底做法：从工具帧的 `args` 里取出载荷，按现有协议**重新包成围栏文本**，
 * 交给现有解析器（`extractSuperDirectives` / `extractSuperActions`）判定。
 * 这里刻意不复制任何校验逻辑：载荷合法性、任务 / 动作结构、占位符过滤、
 * 上限截断全部沿用协议解析器，两条通道的语义因此不会漂移。
 *
 * 名字判定**严格归一**（见 {@link classifySuperToolName}）：先把
 * `_` / `-` / `.` / `/` / `:` / 空白折叠掉再整串比较 `superagent` /
 * `superagentactions`；整串不命中时才把 `__` / `.` 当作命名空间分隔符，取最后
 * 一段再比较。不做包含 / 前缀匹配 —— `super-agent-guard`、`super-agent-tool-v2`
 * 这类名字必须落空（前者是 shell 护栏的模块名，误判成派发会把正常工具帧当载荷）。
 */

import {
  extractSuperActions,
  extractSuperDirectives,
  parseJsonLoose,
  parseSuperDelegationPayload,
  type SuperAction,
  type SuperTaskSpec,
} from "./super-agent.js";

/** 兜底支持的两类结构化工具调用。 */
export type SuperToolCallKind = "dispatch" | "actions";

/**
 * 把工具名归一成协议类别。
 *
 * 归一化分两步，两步都是**整串比较**（不做包含 / 前缀匹配）：
 *  1. 整串折叠（小写 + 去掉 `_` / `-` / `.` / `/` / `:` / 空白）后等于
 *     `superagent` / `superagentactions` —— 覆盖裸名、snake / camel，以及
 *     `super.agent` 这种纯分隔符拆写；
 *  2. 整串不命中时，把 `__` 与 `.` 当作**命名空间分隔符**，取最后一段再按
 *     第 1 步折叠比较 —— 覆盖 `iflow__super-agent`、`server.super-agent`
 *     这类带前缀的工具名（内置工具上线后注册名可能带命名空间）。
 *
 * 仍然严格：`super-agent-guard`、`super-agent-tool-v2` 这类名字落空（见模块
 * 头注释），命名空间前缀也不会把它们的最后一段救回来。
 */
export function classifySuperToolName(name: string): SuperToolCallKind | null {
  if (typeof name !== "string") return null;
  const lower = name.trim().toLowerCase();
  if (!lower) return null;

  const kindOf = (collapsed: string): SuperToolCallKind | null => {
    if (collapsed === "superagent") return "dispatch";
    if (collapsed === "superagentactions") return "actions";
    return null;
  };
  const collapse = (value: string): string => value.replace(/[_\-\s.\/:]+/g, "");

  const whole = kindOf(collapse(lower));
  if (whole) return whole;

  // 命名空间形态：只认 `__` / `.`，取最后一段。单段名字已经在上面判过，
  // 这里不再重复（也避免把 `superagent` 本身拆坏）。
  const segments = lower.split(/__|\./);
  if (segments.length < 2) return null;
  const last = segments[segments.length - 1] ?? "";
  return kindOf(collapse(last));
}

/**
 * 从工具调用的**标题**识别协议类别。
 *
 * 内置 `super-agent` 工具的 `getDescription()` 返回的是短标签，不是工具名：
 * `Delegate N task(s)` / `Manage N child session action(s)`。而 CLI 的
 * **智能审批（SMART）权限请求**只带 `{toolCallId,status,title,content,locations,kind}`
 * —— 没有 `toolName`，也**没有 `args`**（bundle 实证 0.5.19：
 * `[...].evaluateToolCall(...)` 的 RISKY 分支构造 toolCall 时只填 title）。
 * 只按名字判定会让这类请求落进普通审批卡，5 分钟超时后按「拒绝」回给内核
 * （表现为派发静默消失）。
 *
 * 匹配是锚定的整串比较（允许任意空白），不做包含匹配 —— 其它工具的标题
 * 里碰巧出现 "delegate" 也不会被误判成派发。
 */
export function classifySuperToolTitle(title: string): SuperToolCallKind | null {
  if (typeof title !== "string") return null;
  const compact = title.trim().replace(/\s+/g, " ");
  if (!compact) return null;
  if (/^delegate \d+ tasks?$/i.test(compact)) return "dispatch";
  if (/^manage \d+ child session actions?$/i.test(compact)) return "actions";
  return null;
}

/**
 * 把工具调用的参数归一成 JSON 文本。
 *
 * 接受对象 / 数组，以及装着 JSON 的字符串（先 trim；空串与非法 JSON 返回
 * null）。标量与 `null` 一律返回 null —— 协议载荷必须是对象或数组，`"5"`
 * 这种值即使能 parse 也不是载荷。循环引用（JSON.stringify 抛错）同样 null。
 */
/** 把参数归一成 JSON 值（对象 / 数组），供围栏合成与载荷形态判定共用。 */
function normalizeArgsValue(args: unknown): unknown {
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed) return null;
    // 与围栏通道 parseSuperDelegationPayload 同源：字符串载荷一律走宽松解析
    // （修原始换行 / 尾逗号 / 非法转义）。否则同一份脏 JSON 字符串围栏能派发、
    // 工具通道却严格 parse 失败返回 null → 静默零派发。
    const loose = parseJsonLoose(trimmed);
    if (!loose.ok) return null;
    const parsed = loose.value;
    return parsed && typeof parsed === "object" ? parsed : null;
  }
  return args && typeof args === "object" ? args : null;
}

function normalizeArgsJson(args: unknown): string | null {
  const value = normalizeArgsValue(args);
  if (!value) return null;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/**
 * 综合工具名与载荷决定真正的协议类别。
 *
 * 新版内置 `super-agent` 工具的 schema 同时接受 `tasks` 与 `actions`（见
 * `vendor/iflow-fork/bundle/super-agent-loader.cjs`）。模型做管理动作时经常
 * 仍调用这个工具，只传 `{"actions":[…]}`、不带 tasks —— 此时名字归一结果是
 * dispatch，若照派发解析就「找不到任务」→ 宿主误报「未派发子会话」。因此只
 * 在「有非空 actions 且没有非空 tasks」时改判成 actions。反向不改判：
 * `super-agent-actions` 工具历史上只带 actions，保持原语义、避免误吞派发载荷。
 */
export function resolveSuperToolCallKind(
  kind: SuperToolCallKind,
  args: unknown,
): SuperToolCallKind {
  if (kind !== "dispatch") return kind;
  const value = normalizeArgsValue(args);
  if (!value || typeof value !== "object" || Array.isArray(value)) return kind;
  const record = value as Record<string, unknown>;
  const hasActions = Array.isArray(record.actions) && record.actions.length > 0;
  const hasTasks = Array.isArray(record.tasks) && record.tasks.length > 0;
  return hasActions && !hasTasks ? "actions" : kind;
}

/** 管理动作的合法名字（与 `shared/super-agent.ts` 的解析器一致）。 */
const SUPER_ACTION_KINDS = new Set(["retry", "cancel", "answer", "cleanup"]);

/**
 * 只凭**载荷结构**识别协议类别（名字完全缺失时的最后一道依据）。
 *
 * 权限请求在智能审批形态下既没有 `toolName` 也没有 `args`，但旧版 / 其它
 * 适配器可能带上 args 而不带名字。这里按结构严格判定：派发要求 `tasks`
 * 非空且每个元素是带非空字符串 `task` 的对象；管理要求 `actions` 非空且
 * 每个元素带合法 `action` 与非空 `sessionId`。**不做宽松匹配** —— 这只是
 * 「名字缺失」时的兜底，误判会跳过对真实工具的审批，宁可漏认让它走审批卡。
 */
export function classifySuperToolArgs(args: unknown): SuperToolCallKind | null {
  const value = normalizeArgsValue(args);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const isRecord = (item: unknown): item is Record<string, unknown> =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item);
  const tasks = record.tasks;
  if (
    Array.isArray(tasks) &&
    tasks.length > 0 &&
    tasks.every(
      (task) => isRecord(task) && typeof task.task === "string" && task.task.trim().length > 0,
    )
  ) {
    return "dispatch";
  }
  const actions = record.actions;
  if (
    Array.isArray(actions) &&
    actions.length > 0 &&
    actions.every(
      (action) =>
        isRecord(action) &&
        typeof action.action === "string" &&
        SUPER_ACTION_KINDS.has(action.action) &&
        typeof action.sessionId === "string" &&
        action.sessionId.trim().length > 0,
    )
  ) {
    return "actions";
  }
  return null;
}

/**
 * 把工具参数包成对应协议的围栏文本。
 *
 * 只负责「包装」，不负责判定载荷是否可用 —— 判定交给
 * {@link parseSuperToolCall}（内部复用现有解析器）。返回 null 表示参数根本
 * 不是可用的 JSON 载荷（空 / 非法 / 标量）。
 */
export function synthesizeSuperToolCallBlock(
  kind: SuperToolCallKind,
  args: unknown,
): string | null {
  const json = normalizeArgsJson(args);
  if (!json) return null;
  const language = kind === "dispatch" ? "super-agent" : "super-agent-actions";
  return "```" + language + "\n" + json + "\n```";
}

/** 解析成功：合成文本与解析器给出的结构化结果。 */
export interface SuperToolCallPayload {
  kind: SuperToolCallKind;
  /** 合成出的围栏文本（与正文围栏通道逐字节同构）。 */
  text: string;
  /** dispatch：每个围栏块一组任务（与 `extractSuperDirectives().blocks` 同形）。 */
  tasks: SuperTaskSpec[][];
  /** actions：解析出的动作，按输出顺序（dispatch 时为空）。 */
  actions: SuperAction[];
  /**
   * 字段级诊断：混合载荷里被丢弃的畸形条目（如 `tasks[1] 必须是对象`）。
   *
   * 空数组 = 载荷完全合法；非空时宿主仍派发 `tasks` 里的合法项，并补一条
   * warning，绝不静默丢掉一半。
   */
  issues: string[];
}

/** 解析失败：`reason` 直接进日志（英文短语），宿主据此留痕。 */
export interface SuperToolCallFailure {
  ok: false;
  reason: string;
  /** 字段级诊断（如 `tasks[0].task 必须是字符串`），供宿主 toast 给出具体原因。 */
  issues: string[];
}

export type SuperToolCallResult = ({ ok: true } & SuperToolCallPayload) | SuperToolCallFailure;

/**
 * 合成 + 解析一次结构化工具调用。
 *
 * 复用现有协议解析器（不复制校验逻辑）：dispatch 走 `extractSuperDirectives`，
 * actions 走 `extractSuperActions`。合成文本是一个**完整**围栏块，因此不会
 * 出现 pending 中间态；解析器给不出任何任务 / 动作时按失败返回 —— 「名字命中了
 * 却什么都没派发」正是这次兜底要消灭的静默故障，不能当成成功。
 *
 * 合并载荷纠偏：新版 `super-agent` 工具同时收 tasks / actions，模型做管理动作
 * 时可能把它写成 `{"actions":[…]}`（名字仍是 dispatch）。这里先经
 * {@link resolveSuperToolCallKind} 按载荷改判，返回值的 `kind` 也是纠偏后的值，
 * 宿主据此分流到动作执行，而不是把空任务当成「未派发」。
 *
 * 注意：`{"actions":[]}` 这类语法合法但空载的载荷同样按失败返回 —— 宿主会
 * 留一条痕迹，而不是让用户以为指令已经生效。
 */
export function parseSuperToolCall(
  kind: SuperToolCallKind,
  args: unknown,
): SuperToolCallResult {
  const effectiveKind = resolveSuperToolCallKind(kind, args);
  const text = synthesizeSuperToolCallBlock(effectiveKind, args);
  if (!text) {
    return { ok: false, reason: "the tool arguments are not a JSON payload", issues: [] };
  }
  if (effectiveKind === "dispatch") {
    const scan = extractSuperDirectives(text, 0);
    if (scan.blocks.length === 0) {
      const reason = scan.invalidBlocks[0]?.reason ?? "the payload contains no delegation tasks";
      return { ok: false, reason, issues: scan.issues };
    }
    return {
      ok: true,
      kind: effectiveKind,
      text,
      tasks: scan.blocks,
      actions: [],
      issues: scan.issues,
    };
  }
  const scan = extractSuperActions(text, 0);
  if (scan.actions.length === 0) {
    return {
      ok: false,
      reason:
        scan.invalidBlocks.length > 0
          ? "the payload is not a valid actions block"
          : "the payload contains no management actions",
      issues: [],
    };
  }
  return { ok: true, kind: effectiveKind, text, tasks: [], actions: scan.actions, issues: [] };
}

/**
 * 从内置 `super-agent` 工具调用的参数里解析出任务列表。
 *
 * 这是**转录卡片**与**宿主 reducer**共用的入口：两者都从「宿主实际派发了
 * 什么」这一唯一真源取结构，不再各自回解那份有损的展示串（见
 * `shared/session-state.ts` 的 `formatToolInput`：单个字符串值截断 300 字符、
 * 整串上限 4096 字符 —— 长任务书会被从中间切断，回解必然失败）。
 *
 * 两种输入形态都收：
 *  - **对象**（wire 的 `tool_call.args` 就是它）：直接进公共解析入口；
 *  - **JSON 字符串**：先走宽松解析（修原始换行 / 尾逗号 / 非法转义），修不好
 *    就返回 null —— 绝不编造内容。
 *
 * 口径与派发器**完全一致**（复用 {@link parseSuperDelegationPayload}，不复制
 * 校验）：`title` 必填，缺 / 空白 / 占位符的条目会被拒绝并给出字段级诊断，
 * 绝不用 task 首行当标题；附件同时接受 `string[]` 与 `{path,name}`
 * 对象、占位符任务跳过、空任务判失败；混合载荷里畸形条目被丢弃、合法条目照常
 * 返回（诊断原因见 `parseSuperDelegationPayload` 的 `issues`）。因此「宿主派发
 * 出去了」与「卡片说有任务」不会再出现分叉。
 *
 * @returns 解析出的任务列表；载荷不可用（如所有任务都缺 title）时为 null
 * （调用方据此诚实降级）。
 */
export function parseSuperDelegationTasks(args: unknown): SuperTaskSpec[] | null {
  const parsed = parseSuperDelegationPayload(args);
  return parsed.ok ? parsed.tasks : null;
}
