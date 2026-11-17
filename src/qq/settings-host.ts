/**
 * QQ 设置的宿主侧读写层（Wave3-B0.5）。
 *
 * 职责边界：
 *  - `readQqSettings` / `applyQqSettingsPatch` / `writeQqSecrets` /
 *    `ensureBridgeSecrets` 全部只依赖注入的 {@link QqSettingsIo}，不 import
 *    vscode 的任何运行时对象，因此可以在纯内存假 IO 上单测；
 *  - `createVscodeQqSettingsIo` 是**唯一**接触 vscode 的函数（薄封装：
 *    `getConfiguration("iflow.qq")` 读写 + 扩展传入的 SecretStorage）。
 *
 * 归一化纪律：读出来的原始值统一交给 `shared/messages.ts` 的
 * `pickQqSettingsUi`（与 `src/qq/config.ts` 的 `normalizeQqConfig` 同口径：
 * 字符串 trim、数字取整后裁剪、非法枚举回退默认、白名单去空/去重）。写入
 * 侧只做「拒绝脏值 + 数字再 clamp 一次」，不做静默修正 —— 非法枚举与类型
 * 不符一律进 `ignored`，绝不把脏值写进用户的 settings.json。
 *
 * 凭据纪律：明文只经 `writeQqSecrets` 单向写入 SecretStorage；快照里只有
 * `hasBotToken` / `hasAppSecret` 两个布尔投影，`signing-secret` 与
 * `bridge-token`（内部 HMAC / bridge Bearer）由 `ensureBridgeSecrets` 自动
 * 生成，既不进 UI 也不回传。本模块不打印任何日志。
 */

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { pickQqSettingsUi, type QqSettingsUi } from "../../shared/messages.js";
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

/** 可写的 9 个设置键（`hasBotToken` / `hasAppSecret` 是派生字段，不在此列）。 */
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
 * 读取 QQ 设置快照（9 项 + 两个凭据布尔）。
 *
 * 只探测 `bot-token` / `app-secret` 是否存在；`signing-secret` 与
 * `bridge-token` 是宿主内部自举的密钥，不对外暴露。返回结构里没有明文，
 * 即便 SecretStorage 里存了值也只投影成布尔。
 */
export async function readQqSettings(io: QqSettingsIo): Promise<QqSettingsUi> {
  const raw = io.readAll();
  const [botToken, appSecret] = await Promise.all([
    io.getSecret(QQ_SECRET_KEYS.botToken),
    io.getSecret(QQ_SECRET_KEYS.appSecret),
  ]);
  return pickQqSettingsUi(raw, {
    hasBotToken: hasSecretValue(botToken),
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
 * 白名单数组：必须是「全字符串」的数组，否则整键拒绝（不写半截脏值）。
 * 通过后按原值浅拷贝写入 —— 去空白/去重留给读取侧的 `pickQqSettingsUi`。
 */
function coerceIdList(value: unknown): CoercedValue {
  if (!Array.isArray(value)) return { ok: false };
  for (const item of value) {
    if (typeof item !== "string") return { ok: false };
  }
  return { ok: true, value: [...(value as string[])] };
}

/** 单键校验：类型不符 / 非法枚举 → `{ ok: false }`（调用方记入 ignored）。 */
function coerceSettingValue(key: QqSettingKey, value: unknown): CoercedValue {
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
      return coerceIdList(value);
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
 *  - 只允许 9 个白名单键；`hasBotToken` / `hasAppSecret` 是派生字段，任何
 *    其它键（含 `botToken` 这类明文凭据）一律进 `ignored`，不写；
 *  - `undefined` 表示「本次不改」，既不写也不记入 ignored；
 *  - 字符串 / 布尔按原值写；数组必须是全字符串数组才写（浅拷贝原值）；
 *    数字先取整再 clamp 到允许范围；非法枚举整键拒绝；
 *  - 没有任何可写键时不调用 `writeAll`（避免空写入触发配置变更事件）。
 */
export async function applyQqSettingsPatch(
  io: QqSettingsIo,
  patch: Partial<QqSettingsUi>,
): Promise<QqSettingsPatchResult> {
  const applied: string[] = [];
  const ignored: string[] = [];
  const next: Record<string, unknown> = {};

  const entries = Object.entries(patch ?? {}) as [string, unknown][];
  for (const [key, value] of entries) {
    if (!SETTING_KEY_SET.has(key)) {
      ignored.push(key);
      continue;
    }
    if (value === undefined) continue;
    const coerced = coerceSettingValue(key as QqSettingKey, value);
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
// 写凭据
// ---------------------------------------------------------------------------

export interface QqSecretsWriteInput {
  /** 新机器人 Token；空串表示删除该凭据，`undefined` 表示本次不动。 */
  botToken?: string;
  /** 新 App Secret；空串表示删除该凭据，`undefined` 表示本次不动。 */
  appSecret?: string;
}

/**
 * 写入 / 删除 QQ 凭据，返回**实际处理过的键名**（不返回值、不打印日志）。
 *
 * 只处理输入里出现（且为字符串）的字段：空串删除，非空写入。键名用
 * `QQ_SECRET_KEYS` 的短名（`botToken` / `appSecret`），与消息协议
 * `qqSecretsWrite` 的字段名一致，便于宿主回执。
 */
export async function writeQqSecrets(
  io: QqSettingsIo,
  input: QqSecretsWriteInput,
): Promise<string[]> {
  const changed: string[] = [];

  if (typeof input.botToken === "string") {
    if (input.botToken.length === 0) {
      await io.deleteSecret(QQ_SECRET_KEYS.botToken);
    } else {
      await io.setSecret(QQ_SECRET_KEYS.botToken, input.botToken);
    }
    changed.push("botToken");
  }

  if (typeof input.appSecret === "string") {
    if (input.appSecret.length === 0) {
      await io.deleteSecret(QQ_SECRET_KEYS.appSecret);
    } else {
      await io.setSecret(QQ_SECRET_KEYS.appSecret, input.appSecret);
    }
    changed.push("appSecret");
  }

  return changed;
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
