/**
 * 上下文窗口覆写行的纯逻辑（`iflow.contextWindowOverrides`）。
 *
 * 覆写行的格式是 `模型名=纯token数`（例：`deepseek-v4.1-flash=960000`），
 * 宿主侧的最终解释权在 `parseContextWindowOverrides`
 * （shared/context-window.ts）——它做两件事：
 *  ① 模型名经 `normalizeModelId` 归一化（去掉最后一个 `/` 前缀 + 小写），
 *     因此 `auto/deepseek-v4` 与 `deepseek-v4` 命中同一条目；
 *  ② 值必须是**纯数字**：`"960K"` → NaN → 该行被**静默丢弃**。
 *
 * 设置页的结构化编辑器必须让用户在这两条规则落地之前就看见问题，所以
 * 这里把「解析 / 归一化 / 校验」抽成共享纯函数：webview 用它做行内校验，
 * 宿主用同一份规则归一化后再写盘 —— 两边不会各自漂移出一套判定。
 *
 * 零 VSCode 依赖（纯逻辑，可单测）。
 */

import { normalizeModelId } from "./context-window.js";

/** 一条已解析的覆写行。`raw` 保留用户原始写法（仅用于展示未归一化的行）。 */
export interface ContextWindowRow {
  /** 归一化后的模型名（小写、无 `/` 前缀）——与运行时查找用的键一致。 */
  model: string;
  /** 窗口长度（token）。已向下取整，与宿主的 `Math.floor` 一致。 */
  window: number;
  /** 原始行文本。 */
  raw: string;
}

/** 行内校验失败的原因（webview 据此选文案，不直接拼字符串）。 */
export type ContextWindowDraftError = "model" | "window";

/**
 * 解析一行覆写。**与宿主解析器同规则**：模型名归一化后为空、值不是正数
 * （含 `"960K"` 这类带单位的写法）都判为无效——无效行不是「错误」，只是
 * 「这条不生效」，UI 仍然把它列出来（用户要能看到并删掉它），但标明无效。
 */
export function parseContextWindowRow(row: string): ContextWindowRow | null {
  const text = (row ?? "").trim();
  const idx = text.indexOf("=");
  if (idx <= 0) return null;
  const model = normalizeModelId(text.slice(0, idx));
  const value = Number(text.slice(idx + 1).trim());
  if (!model || !Number.isFinite(value) || value <= 0) return null;
  return { model, window: Math.floor(value), raw: text };
}

/** 拼回规范行：`归一化模型名=窗口`。 */
export function formatContextWindowRow(model: string, window: number): string {
  return `${normalizeModelId(model)}=${Math.floor(window)}`;
}

/**
 * 校验新增行的两个输入框。返回 `row` 时即为可直接写盘的规范行。
 *
 * 规则（与运行时一致，比运行时更严一档：运行时接受小数，这里要求正整数）：
 *  - 模型名非空；
 *  - 窗口值必须是**纯数字**且为正整数——`960K` / `1.5M` / `abc` 一律拒绝，
 *    因为它们在运行时会被静默丢弃，用户会以为自己配好了。
 */
export function validateContextWindowDraft(
  model: string,
  window: string,
): { ok: true; row: string } | { ok: false; reason: ContextWindowDraftError } {
  const normalized = normalizeModelId(model);
  if (!normalized) return { ok: false, reason: "model" };
  const text = (window ?? "").trim();
  if (!text) return { ok: false, reason: "window" };
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    return { ok: false, reason: "window" };
  }
  return { ok: true, row: formatContextWindowRow(normalized, value) };
}

/**
 * 归一化整张表：能解析的行改写成规范形式（`auto/x` → `x`），**不能解析的
 * 行逐字保留**——它们在运行时会被忽略，但用户必须还能在设置页里看到并
 * 删掉它们，绝不能因为一次保存就凭空消失。
 */
export function normalizeContextWindowRows(rows: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of rows ?? []) {
    const parsed = parseContextWindowRow(raw);
    out.push(parsed ? formatContextWindowRow(parsed.model, parsed.window) : (raw ?? "").trim());
  }
  return out;
}
