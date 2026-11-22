/**
 * 上下文窗口覆写（`iflow.contextWindowOverrides`）的宿主侧读写与广播。
 *
 * 为什么单开一个模块：设置页的结构化编辑器需要三样东西——当前覆写表、
 * 当前会话模型、以及该模型在内建表（CONTEXT_WINDOW_TABLE）里的窗口——
 * 后两者都不是「设置项」，`hostSettings` 那条通道带不出来，所以单开一条
 * `contextWindowOverrides` 通道（见 shared/messages.ts）。
 *
 * 写盘**复用面板既有的写设置通道**（`writeUserSetting` → VSCode 用户设置
 * 的 Global 作用域，Settings Sync 能带走），本模块不另造一条写路径；写完
 * 之后主动把生效后的值推回 webview，让结构化编辑器立刻显示新表。
 */

import * as vscode from "vscode";
import { resolveContextWindowWithSource } from "../../shared/context-window.js";
import { normalizeContextWindowRows } from "../../shared/context-window-overrides.js";
import type { ContextWindowOverridesUi } from "../../shared/messages.js";

/** `iflow.contextWindowOverrides`（`getConfiguration("iflow")` 里省略前缀）。 */
const CONTEXT_WINDOW_OVERRIDES_KEY = "contextWindowOverrides";

/** 写失败提示里显示的设置项名称。 */
function settingLabel(): string {
  return vscode.l10n.t("上下文窗口覆写");
}

/** 宿主侧依赖（由 panel.ts 注入，避免这里反向依赖面板的私有字段）。 */
export interface ContextWindowOverridesHost {
  /** 写一条面板设置（VSCode 用户设置 / Global 作用域）。返回是否写成功。 */
  writeUserSetting(key: string, value: unknown, label?: string): Promise<boolean>;
  /** 把一条消息推给 webview。 */
  postToWebview(message: unknown): void;
  /** 当前会话模型 id；没有模型时返回 null。 */
  currentModelId(): string | null;
}

/** 读当前覆写表（原始行文本，顺序即用户看到的顺序）。 */
function readContextWindowOverrides(): string[] {
  const raw = vscode.workspace.getConfiguration("iflow").get<unknown>(CONTEXT_WINDOW_OVERRIDES_KEY, []);
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

/**
 * 内建表里某个模型的上下文窗口；表里没有（或模型未知）时返回 undefined
 * ——UI 据此决定给不给「一键预填」的建议值。
 *
 * 走 `resolveContextWindowWithSource` 的**同一条**解析路径（空覆写表），
 * 不自己抄一份「最长前缀匹配」：运行时用哪条规则，这里就用哪条，两者
 * 不会漂移。
 *
 * 注意：这条路径**故意只看内建表**（空覆写表 + 只认 `builtin-table` 来源）。
 * 它回答的是「内建表里这个模型是多少」，用来给覆写表填建议值；**生效**的
 * 窗口由五档权威链 `resolveContextWindowAuthority` 决定（占用条与推给 CLI
 * 的 `IFLOW_TOKENS_LIMIT` 共用那一个），两者不是同一口径，别混用。
 */
function builtinWindowFor(modelId: string | null | undefined): number | undefined {
  if (!modelId) return undefined;
  const resolution = resolveContextWindowWithSource(modelId, {});
  if (resolution.source !== "builtin-table") return undefined;
  return resolution.window ?? undefined;
}

/** 组装要发给 webview 的载荷。 */
function buildContextWindowOverridesUi(currentModelId?: string | null): ContextWindowOverridesUi {
  const id = currentModelId ?? undefined;
  const builtinWindow = builtinWindowFor(id);
  return {
    overrides: readContextWindowOverrides(),
    ...(id ? { currentModelId: id } : {}),
    ...(builtinWindow !== undefined ? { builtinWindow } : {}),
  };
}

/** 把当前覆写表推给 webview（webview 就绪时推一次）。 */
export function postContextWindowOverrides(host: ContextWindowOverridesHost): void {
  host.postToWebview({
    type: "contextWindowOverrides",
    ...buildContextWindowOverridesUi(host.currentModelId()),
  });
}

/**
 * 写入整张覆写表并回推。
 *
 * 写入前逐行归一化（`auto/x` → `x`，可解析的行改写成规范形式），**不能
 * 解析的行逐字保留**——它们在运行时会被忽略，但绝不能因为一次保存就从
 * 用户眼前消失。
 */
export async function saveContextWindowOverrides(
  host: ContextWindowOverridesHost,
  overrides: readonly string[],
): Promise<void> {
  const rows = normalizeContextWindowRows(overrides);
  const ok = await host.writeUserSetting(CONTEXT_WINDOW_OVERRIDES_KEY, rows, settingLabel());
  if (!ok) return;
  postContextWindowOverrides(host);
}
