/**
 * 子会话工具 / MCP 白名单的纯逻辑（零 VSCode 依赖，可单测）。
 *
 * 设计纪律（与 `MAIN_SESSION_ALLOWED_TOOLS` 一致）：
 *  - **默认不限制**：两个白名单都空时 `buildChildSessionSettings` 返回
 *    `undefined`，`effectiveMcpServerNames` 也返回 `undefined` —— 调用方据此
 *    完全不传 settings / 不给 `buildAcpCommand` 附加 MCP 过滤参数，子会话的
 *    请求形状与既有行为逐字节一致（既有测试断言子会话缺省不传 settings）。
 *  - MCP 过滤走**进程级** `--allowed-mcp-server-names`（见 cli-locator），不进
 *    `SessionSettings`：session 请求里的 `mcpServers` 是「叠加」而非「收窄」。
 *  - 白名单元素来自用户配置，可能带空白 / 重复 / 空串，一律先归一化。
 */
import type { SessionSettings } from "../src/acp/protocol.js";

/**
 * 归一化一份白名单：trim + 去空串 + 去重，保持首次出现的顺序。
 */
export function normalizeAllowlist(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    // 配置来源理论上只会给 string，但脏值（null/数字）不能让白名单静默变大。
    if (typeof value !== "string") continue;
    const name = value.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * 构造子会话 `session/new` 的 settings。
 *
 * 两个白名单都空 → `undefined`（= 不传 settings，保持现状）。
 * 否则 → 一个 settings 对象；只有工具白名单非空时才写 `allowed_tools`。
 * MCP 不在这里表达，由 `effectiveMcpServerNames` 在 spawn 层面处理。
 */
export function buildChildSessionSettings(
  toolAllowlist: readonly string[] | undefined,
  mcpAllowlist: readonly string[] | undefined,
): SessionSettings | undefined {
  const tools = normalizeAllowlist(toolAllowlist);
  const mcp = normalizeAllowlist(mcpAllowlist);
  if (tools.length === 0 && mcp.length === 0) return undefined;
  const settings: SessionSettings = {};
  if (tools.length > 0) settings.allowed_tools = tools;
  return settings;
}

/**
 * 计算传给 `buildAcpCommand(..., { mcpServerNames })` 的服务器名。
 *
 * 白名单为空 → `undefined`（= 不加过滤参数，CLI 保留全部已配置服务器）。
 * 否则 → 白名单与 broker 实际提供的服务器名的交集：用户写错 / 写了一个宿主
 * 根本没有的名字时不会把它传给 CLI（避免无意义的进程参数），也不会因此让
 * 其它合法名字失效。交集为空时返回 `[]`，`buildAcpCommand` 会把它翻成
 * 永不匹配的哨兵 —— 即「配了白名单但一个都不存在」= 子会话无 MCP。
 */
export function effectiveMcpServerNames(
  mcpAllowlist: readonly string[] | undefined,
  brokerNames: readonly string[] | undefined,
): string[] | undefined {
  const allowed = normalizeAllowlist(mcpAllowlist);
  if (allowed.length === 0) return undefined;
  const available = new Set(normalizeAllowlist(brokerNames));
  return allowed.filter((name) => available.has(name));
}

/**
 * 完全信任模式下的子会话 settings：不做任何工具收窄。
 *
 * `fullTrust=false` 时逐字委托 {@link buildChildSessionSettings}，默认行为与
 * 接线前完全一致；`fullTrust=true` 时返回 `undefined`，即 `session/new` 不带
 * settings（与两个白名单都为空时同形），子会话保留全部内置工具。
 */
export function buildChildSessionSettingsForTrust(
  fullTrust: boolean,
  toolAllowlist: readonly string[] | undefined,
  mcpAllowlist: readonly string[] | undefined,
): SessionSettings | undefined {
  if (fullTrust) return undefined;
  return buildChildSessionSettings(toolAllowlist, mcpAllowlist);
}

/**
 * 完全信任模式下的 MCP 进程作用域：使用 broker 的全量 server，绝不传哨兵。
 *
 * `fullTrust=false` 时逐字沿用既有表达式（白名单 ∩ broker，空则回退 broker
 * 全量），默认零变化；`fullTrust=true` 时忽略用户配置的白名单，broker 有
 * server 就传全量，broker 为空则传 `undefined` —— `buildAcpCommand` 因此不加
 * allowlist 参数，不会退化成「无 MCP」的哨兵。
 */
export function effectiveMcpServerNamesForTrust(
  fullTrust: boolean,
  mcpAllowlist: readonly string[] | undefined,
  brokerNames: readonly string[] | undefined,
): string[] | undefined {
  if (fullTrust) {
    const names = normalizeAllowlist(brokerNames);
    return names.length > 0 ? names : undefined;
  }
  return effectiveMcpServerNames(mcpAllowlist, brokerNames) ?? normalizeAllowlist(brokerNames);
}
