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
 * 把工具调用的参数归一成 JSON 文本。
 *
 * 接受对象 / 数组，以及装着 JSON 的字符串（先 trim；空串与非法 JSON 返回
 * null）。标量与 `null` 一律返回 null —— 协议载荷必须是对象或数组，`"5"`
 * 这种值即使能 parse 也不是载荷。循环引用（JSON.stringify 抛错）同样 null。
 */
function normalizeArgsJson(args: unknown): string | null {
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object") return null;
      return JSON.stringify(parsed);
    } catch {
      return null;
    }
  }
  if (!args || typeof args !== "object") return null;
  try {
    return JSON.stringify(args) ?? null;
  } catch {
    return null;
  }
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
}

/** 解析失败：`reason` 直接进日志（英文短语），宿主据此留痕。 */
export interface SuperToolCallFailure {
  ok: false;
  reason: string;
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
 * 注意：`{"actions":[]}` 这类语法合法但空载的载荷同样按失败返回 —— 宿主会
 * 留一条痕迹，而不是让用户以为指令已经生效。
 */
export function parseSuperToolCall(
  kind: SuperToolCallKind,
  args: unknown,
): SuperToolCallResult {
  const text = synthesizeSuperToolCallBlock(kind, args);
  if (!text) return { ok: false, reason: "the tool arguments are not a JSON payload" };
  if (kind === "dispatch") {
    const scan = extractSuperDirectives(text, 0);
    if (scan.blocks.length === 0) {
      const reason = scan.invalidBlocks[0]?.reason ?? "the payload contains no delegation tasks";
      return { ok: false, reason };
    }
    return { ok: true, kind, text, tasks: scan.blocks, actions: [] };
  }
  const scan = extractSuperActions(text, 0);
  if (scan.actions.length === 0) {
    return {
      ok: false,
      reason:
        scan.invalidBlocks.length > 0
          ? "the payload is not a valid actions block"
          : "the payload contains no management actions",
    };
  }
  return { ok: true, kind, text, tasks: [], actions: scan.actions };
}
