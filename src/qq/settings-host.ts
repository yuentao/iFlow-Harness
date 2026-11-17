/**
 * QQ 设置的宿主侧读写层（Wave3-B0.5）。
 *
 * 职责边界：
 *  - `readQqSettings` / `applyQqSettingsPatch` / `ensureBridgeSecrets` 全部只
 *    依赖注入的 {@link QqSettingsIo}，不 import vscode 的任何运行时对象，
 *    因此可以在纯内存假 IO 上单测；
 *  - `createVscodeQqSettingsIo` 是**唯一**接触 vscode 的函数（薄封装：
 *    `getConfiguration("iflow.qq")` 读写 + 扩展传入的 SecretStorage）。
 *
 * 归一化纪律：读出来的原始值统一交给 `shared/messages.ts` 的
 * `pickQqSettingsUi`（与 `src/qq/config.ts` 的 `normalizeQqConfig` 同口径：
 * 字符串 trim、数字取整后裁剪、非法枚举回退默认、白名单去空/去重）。写入
 * 侧只做「拒绝脏值 + 数字再 clamp 一次」，不做静默修正 —— 非法枚举与类型
 * 不符一律进 `ignored`，绝不把脏值写进用户的 settings.json。
 *
 * 白名单存储是联合格式（裸 openid 字符串 或 `{ openid, note }`）。写入侧把
 * 两种输入都归一后落盘：对象条目按 `note` 原样写（空串=清空备注），裸字符串
 * 条目视为「只关心 id」，磁盘上同名 openid 已有的备注会被保留 —— 扫码绑定 /
 * 放行待审核这类只追加 id 的路径因此不会抹掉用户填的备注。脱敏串（含 `*`）
 * 绝不进入配置，它只在 webview 渲染时生成。
 *
 * 凭据纪律：凭据只在扫码成功后由宿主单向写入 SecretStorage（appId 用
 * `qqbot-host.ts` 的键、appSecret 用 `QQ_SECRET_KEYS.appSecret`）；快照里只有
 * `hasAppSecret` 一个布尔投影。`signing-secret` 与 `bridge-token`（内部 HMAC /
 * bridge Bearer）由 `ensureBridgeSecrets` 自动生成，既不进 UI 也不回传。本模块
 * 不打印任何日志。
 */

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  pickQqSettingsUi,
  type QqSettingsPatch,
  type QqSettingsUi,
} from "../../shared/messages.js";
import {
  normalizeQqAllowEntries,
  normalizeQqAllowEntry,
  type QqAllowEntryStored,
} from "../../shared/qq-access.js";
import { QQ_SECRET_KEYS } from "./config.js";

// ---------------------------------------------------------------------------
// IO 注入面
// ---------------------------------------------------------------------------

/**
 * 宿主侧 IO 抽象：设置区（`iflow.qq.*`）与 SecretStorage。
 *
 * `readAll()` 返回 9 个设置键的**原始值**（键缺失即 `undefined`），由
 * `pickQqSettingsUi` 归一；`writeAll(patch)` 逐键落盘，`patch` 里的值已经过
 * 校验/裁剪，是可序列化的最终值。
 */
export interface QqSettingsIo {
  /** 读出 9 个 `iflow.qq.*` 键的原始值（缺失为 `undefined`）。 */
  readAll(): Record<string, unknown>;
  /** 逐键写入（值已是可序列化的最终值）。 */
  writeAll(patch: Record<string, unknown>): Promise<void>;
  /** 读 SecretStorage（键名见 `QQ_SECRET_KEYS`）。 */
  getSecret(key: string): Promise<string | undefined>;
  /** 写 SecretStorage。 */
  setSecret(key: string, value: string): Promise<void>;
  /** 删 SecretStorage 条目。 */
  deleteSecret(key: string): Promise<void>;
}

/**
 * `vscode.SecretStorage` 的最小结构面（注入式）。
 *
 * 用 `PromiseLike` 而不是 `Promise`，这样 `vscode.SecretStorage` 的
 * `Thenable` 返回值可以直接传入，测试里的内存实现也照样满足。
 */
export interface QqSecretStorageLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

// ---------------------------------------------------------------------------
// 12 个设置键与允许取值（与 package.json 的 iflow.qq.* 声明逐字一致）
// ---------------------------------------------------------------------------

/** 可写的 9 个设置键（`hasAppSecret` 是派生字段，不在此列）。 */
export const QQ_SETTING_KEYS = [
  "enabled",
  "allowedUsers",
  "allowedGroups",
  "workspace",
  "remotePolicy",
  "maxConcurrentTasks",
  "rateLimitPerMin",
  "resultDetail",
  "autoMerge",
] as const;

export type QqSettingKey = (typeof QQ_SETTING_KEYS)[number];

const SETTING_KEY_SET: ReadonlySet<string> = new Set(QQ_SETTING_KEYS);

const REMOTE_POLICIES = ["readonly", "supervised", "trusted"] as const;
const RESULT_DETAILS = ["summary", "standard", "full"] as const;

/** 数字项的允许范围（闭区间，先取整再裁剪）——与 src/qq/config.ts 的 RANGES 一致。 */
const RANGES = {
  maxConcurrentTasks: { min: 1, max: 10 },
  rateLimitPerMin: { min: 1, max: 60 },
} as const;

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

/** SecretStorage 里的值是否算「已配置」：非空字符串（纯空白不算）。 */
function hasSecretValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 读取 QQ 设置快照（9 项 + App Secret 布尔）。
 *
 * 只探测扫码写入的 `app-secret` 是否存在；`signing-secret` 与
 * `bridge-token` 是宿主内部自举的密钥，不对外暴露。返回结构里没有明文，
 * 即便 SecretStorage 里存了值也只投影成布尔。机器人 Token 已不再手填，
 * 历史 `iflow.qq.bot-token` 是死键，不再探测。
 */
export async function readQqSettings(io: QqSettingsIo): Promise<QqSettingsUi> {
  const raw = io.readAll();
  const appSecret = await io.getSecret(QQ_SECRET_KEYS.appSecret);
  return pickQqSettingsUi(raw, {
    hasAppSecret: hasSecretValue(appSecret),
  });
}

// ---------------------------------------------------------------------------
// 写设置
// ---------------------------------------------------------------------------

type CoercedValue = { ok: true; value: unknown } | { ok: false };

function coerceEnum<T extends string>(value: unknown, allowed: readonly T[]): CoercedValue {
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  return (allowed as readonly string[]).includes(trimmed)
    ? { ok: true, value: trimmed }
    : { ok: false };
}

function coerceInteger(
  value: unknown,
  range: { readonly min: number; readonly max: number },
): CoercedValue {
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false };
  const adjusted = Math.min(range.max, Math.max(range.min, Math.round(value)));
  return { ok: true, value: adjusted };
}

/**
 * 白名单数组：接受裸 openid（旧格式 / 宿主内部只追加 id）与 `{ openid, note }`
 * 条目，结构非法则整键拒绝（不写半截脏值）。
 *
 * 备注合并纪律：**裸字符串条目**表示「只关心 id」，磁盘上同名 openid 已有备注
 * 时原样保留 —— 否则扫码绑定 / 放行待审核这类只追加 id 的写路径会把用户填的
 * 备注一次性抹掉。对象条目里 `note` 是权威值（空串 = 清空备注）。
 */
function coerceAllowList(value: unknown, existing: unknown): CoercedValue {
  if (!Array.isArray(value)) return { ok: false };

  const preserved = new Map<string, string>();
  for (const entry of normalizeQqAllowEntries(existing)) {
    if (entry.note) preserved.set(entry.openid, entry.note);
  }

  const out: QqAllowEntryStored[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const note = preserved.get(item.trim()) ?? "";
      out.push(note.length > 0 ? { openid: item.trim(), note } : item);
      continue;
    }
    const entry = normalizeQqAllowEntry(item);
    if (!entry) return { ok: false };
    out.push(entry.note ? { openid: entry.openid, note: entry.note } : entry.openid);
  }
  return { ok: true, value: out };
}

/** 单键校验：类型不符 / 非法枚举 → `{ ok: false }`（调用方记入 ignored）。 */
function coerceSettingValue(
  key: QqSettingKey,
  value: unknown,
  existing: Record<string, unknown>,
): CoercedValue {
  switch (key) {
    case "enabled":
    case "autoMerge":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false };
    case "workspace":
      return typeof value === "string" ? { ok: true, value } : { ok: false };
    case "remotePolicy":
      return coerceEnum(value, REMOTE_POLICIES);
    case "resultDetail":
      return coerceEnum(value, RESULT_DETAILS);
    case "maxConcurrentTasks":
      return coerceInteger(value, RANGES.maxConcurrentTasks);
    case "rateLimitPerMin":
      return coerceInteger(value, RANGES.rateLimitPerMin);
    case "allowedUsers":
    case "allowedGroups":
      return coerceAllowList(value, existing[key]);
  }
}

export interface QqSettingsPatchResult {
  /** 实际写入的设置键（按 patch 里的出现顺序）。 */
  applied: string[];
  /** 被拒绝的键：不在白名单、派生字段、类型不符、非法枚举 / 非有限数。 */
  ignored: string[];
}

/**
 * 应用一个设置补丁。
 *
 * 规则：
 *  - 只允许 9 个白名单键；`hasAppSecret` 是派生字段，任何其它键（含
 *    `appSecret` 这类明文凭据）一律进 `ignored`，不写；
 *  - `undefined` 表示「本次不改」，既不写也不记入 ignored；
 *  - 字符串 / 布尔按原值写；数组必须是全字符串数组才写（浅拷贝原值）；
 *    数字先取整再 clamp 到允许范围；非法枚举整键拒绝；
 *  - 没有任何可写键时不调用 `writeAll`（避免空写入触发配置变更事件）。
 */
export async function applyQqSettingsPatch(
  io: QqSettingsIo,
  patch: QqSettingsPatch,
): Promise<QqSettingsPatchResult> {
  const applied: string[] = [];
  const ignored: string[] = [];
  const next: Record<string, unknown> = {};

  const entries = Object.entries(patch ?? {}) as [string, unknown][];
  // 白名单写入需要磁盘上的旧值来保留已有备注（只读一次，避免重复 IO）。
  const touchesAllowlist = entries.some(
    ([key]) => key === "allowedUsers" || key === "allowedGroups",
  );
  const existing: Record<string, unknown> = touchesAllowlist ? io.readAll() : {};
  for (const [key, value] of entries) {
    if (!SETTING_KEY_SET.has(key)) {
      ignored.push(key);
      continue;
    }
    if (value === undefined) continue;
    const coerced = coerceSettingValue(key as QqSettingKey, value, existing);
    if (!coerced.ok) {
      ignored.push(key);
      continue;
    }
    next[key] = coerced.value;
    applied.push(key);
  }

  if (applied.length > 0) {
    await io.writeAll(next);
  }
  return { applied, ignored };
}

// ---------------------------------------------------------------------------
// bridge 密钥自举
// ---------------------------------------------------------------------------

/** 生成 32 字节随机数的十六进制串（64 个 hex 字符）。 */
function randomHex(rng?: () => number): string {
  if (!rng) return randomBytes(32).toString("hex");
  // 注入式随机源只为可测性存在：每个 hex 半字节消费一次 rng()。
  let out = "";
  for (let i = 0; i < 64; i += 1) {
    const sample = rng();
    const bounded = Number.isFinite(sample) ? Math.min(0.999999, Math.max(0, sample)) : 0;
    out += Math.floor(bounded * 16).toString(16);
  }
  return out;
}

/** 取现有 secret；不存在（或纯空白）则生成并写入，返回最终值。 */
async function ensureSecret(
  io: QqSettingsIo,
  key: string,
  rng: (() => number) | undefined,
): Promise<string> {
  const existing = await io.getSecret(key);
  if (hasSecretValue(existing)) return existing as string;
  const generated = randomHex(rng);
  await io.setSecret(key, generated);
  return generated;
}

/**
 * 确保 bridge 所需的两个密钥存在（宿主启动 bridge **之前**必须调用）。
 *
 * `bridge-token` 是 bridge → 宿主的 Bearer token（`IFLOW_QQ_BRIDGE_TOKEN`），
 * `signing-secret` 是请求签名的 HMAC 密钥（`IFLOW_QQ_HMAC_SECRET`）。两者都
 * 由宿主自动生成（32 字节 hex），已有值原样复用（幂等）；返回值只用于构造
 * bridge 环境变量，不打印、不进设置快照。
 */
export async function ensureBridgeSecrets(
  io: QqSettingsIo,
  rng?: () => number,
): Promise<{ bridgeToken: string; hmacSecret: string }> {
  const bridgeToken = await ensureSecret(io, QQ_SECRET_KEYS.bridgeToken, rng);
  const hmacSecret = await ensureSecret(io, QQ_SECRET_KEYS.signingSecret, rng);
  return { bridgeToken, hmacSecret };
}

// ---------------------------------------------------------------------------
// vscode 薄封装（本模块唯一接触 vscode 的地方）
// ---------------------------------------------------------------------------

/**
 * 用真实 VSCode 配置区与扩展传入的 SecretStorage 构造 IO。
 *
 * `secrets` 由扩展在激活时传入（`context.secrets`），**不要**在这里自己取
 * 扩展上下文。写入目标是 Workspace 作用域（QQ 通道是工作区级能力）。
 */
export function createVscodeQqSettingsIo(secrets: QqSecretStorageLike): QqSettingsIo {
  return {
    readAll(): Record<string, unknown> {
      const section = vscode.workspace.getConfiguration("iflow.qq");
      const raw: Record<string, unknown> = {};
      for (const key of QQ_SETTING_KEYS) {
        raw[key] = section.get(key);
      }
      return raw;
    },
    async writeAll(patch: Record<string, unknown>): Promise<void> {
      const section = vscode.workspace.getConfiguration("iflow.qq");
      for (const [key, value] of Object.entries(patch)) {
        await section.update(key, value, vscode.ConfigurationTarget.Workspace);
      }
    },
    async getSecret(key: string): Promise<string | undefined> {
      return secrets.get(key);
    },
    async setSecret(key: string, value: string): Promise<void> {
      await secrets.store(key, value);
    },
    async deleteSecret(key: string): Promise<void> {
      await secrets.delete(key);
    },
  };
}
