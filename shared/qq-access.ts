/**
 * QQ 访问控制名单的纯逻辑：openid 脱敏 + 存储格式归一。
 *
 * 存储格式（`iflow.qq.allowedUsers` / `iflow.qq.allowedGroups`）是**联合**：
 *  - `string`：裸 openid（历史配置的形状，原样兼容）；
 *  - `{ openid, note? }`：带备注的新格式。
 *
 * 读路径一律经 {@link normalizeQqAllowEntries} 归一成 `QqAllowEntry[]`；写路径
 * 经 `src/qq/settings-host.ts` 输出联合数组 —— 没备注的条目仍写裸字符串，
 * 因此「从不填备注」的配置保持旧形状，老版本与外部工具照样能读。
 *
 * 脱敏纪律：{@link maskQqOpenId} **只在 UI 层**使用。宿主与运行期匹配必须拿
 * 完整 openid（`QqConfig.allowedUsers` 是 `string[]`），绝不能把脱敏串写回
 * 配置，否则授权直接失效。
 */

/** 脱敏时固定的星号个数：与原始长度无关，不能据此反推完整长度。 */
const MASK_STARS = 8;
/** 正常长度下保留的头尾字符数。 */
const MASK_EDGE = 4;
/** 不超过该长度的值视为异常，整体用星号覆盖（原样保留会泄露全部内容）。 */
const MASK_SAFE_LENGTH = MASK_EDGE * 2;

/** 一个访问控制条目：完整 openid + 可选备注。 */
export interface QqAllowEntry {
  /** 完整 openid（QQ 官方接口给的标识，不是 QQ 号）。 */
  openid: string;
  /** 用户自定义备注；空串/缺省都表示没有备注。 */
  note?: string;
}

/** 存储与补丁里能接受的条目形态：裸字符串（旧格式）或带备注的对象。 */
export type QqAllowEntryInput = string | QqAllowEntry;

/** 写回 settings.json 的条目：没有备注写裸字符串，有备注写对象。 */
export type QqAllowEntryStored = string | { openid: string; note: string };

/**
 * openid 脱敏：前 4 位 + 固定 8 个 `*` + 后 4 位（例：`D754********8D11`）。
 *
 * - 星号个数**恒为 8**，与原始长度无关（不能用星号数量推断长度）；
 * - 长度不超过 8 的异常值整体覆盖成 8 个 `*`，绝不原样返回；
 * - 空串 / `undefined` / 非字符串返回空串（调用方自行决定占位文案）。
 */
export function maskQqOpenId(value: string | null | undefined): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw.length === 0) return "";
  if (raw.length <= MASK_SAFE_LENGTH) return "*".repeat(MASK_STARS);
  return `${raw.slice(0, MASK_EDGE)}${"*".repeat(MASK_STARS)}${raw.slice(-MASK_EDGE)}`;
}

/** 单个条目归一；结构非法或 openid 为空返回 `null`。 */
export function normalizeQqAllowEntry(value: unknown): QqAllowEntry | null {
  if (typeof value === "string") {
    const openid = value.trim();
    return openid.length > 0 ? { openid } : null;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const openid = typeof record.openid === "string" ? record.openid.trim() : "";
    if (openid.length === 0) return null;
    const note = typeof record.note === "string" ? record.note.trim() : "";
    return note.length > 0 ? { openid, note } : { openid };
  }
  return null;
}

/**
 * 把任意配置值归一成条目列表：字符串与 `{ openid, note? }` 都接受，非法项
 * 跳过，按 openid 去重（保持首次出现顺序）。非数组输入返回空列表。
 */
export function normalizeQqAllowEntries(value: unknown): QqAllowEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const entries: QqAllowEntry[] = [];
  for (const item of value) {
    const entry = normalizeQqAllowEntry(item);
    if (!entry || seen.has(entry.openid)) continue;
    seen.add(entry.openid);
    entries.push(entry);
  }
  return entries;
}

/**
 * 把条目列表序列化成存储形态：有备注写 `{ openid, note }`，没备注写裸字符串。
 *
 * 这是「新写路径」的规范形状；宿主写入时会再叠加一层「旧配置已有备注保留」
 * 的合并（见 `src/qq/settings-host.ts` 的 `coerceAllowList`）。
 */
export function serializeQqAllowEntries(
  entries: readonly QqAllowEntry[],
): QqAllowEntryStored[] {
  return entries.map((entry) => {
    const note = entry.note?.trim() ?? "";
    return note.length > 0 ? { openid: entry.openid, note } : entry.openid;
  });
}
