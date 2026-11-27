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
 * 作用域纪律（2026-11-25 修复的第二半）：写入固定落 Global（机器级设置），
 * 读侧同时改为 **Global 优先** —— 每个键先看 `inspect().globalValue`，缺失
 * 才回退到旧版本写在 Workspace / WorkspaceFolder 的残留值，最后才是声明
 * 默认值（见 {@link pickQqSettingValue}）。旧值只**检测**、只提示，不迁移、
 * 不写盘、不删除（用户可能同时打开多个工作区）。
 *
 * 白名单存储是联合格式（裸 openid 字符串 或 `{ openid, note }`）。写入侧把
 * 两种输入都归一后落盘：对象条目按 `note` 原样写（空串=清空备注），裸字符串
 * 条目视为「只关心 id」，磁盘上同名 openid 已有的备注会被保留 —— 扫码绑定 /
 * 放行待审核这类只追加 id 的路径因此不会抹掉用户填的备注。openid 一律 `trim`
 * 并按完整值去重（保留首次出现顺序），与读侧 `normalizeQqAllowEntries` 同口径。
 * 脱敏串（含 `*`）绝不进入配置，它只在 webview 渲染时生成。
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
 * 单键在各配置作用域的原始值（`WorkspaceConfiguration.inspect()` 的窄投影）。
 *
 * `readAll()` 返回的是**合并后**的值（工作区覆盖用户级），无法区分「用户级
 * 设置」与「旧版本残留的工作区级覆盖」。读侧改为 Global 优先后必须靠这份
 * 分层快照：`globalValue` 有值时它永远胜出，缺失时才回退到工作区 / 文件夹
 * 级旧值，最后才是声明默认值。
 */
export interface QqSettingScopes {
  /** 用户级（Global）值；未设置即 `undefined`。 */
  globalValue?: unknown;
  /** 工作区级旧值（单根窗口的 `.vscode/settings.json`）。 */
  workspaceValue?: unknown;
  /** 多根工作区：每个文件夹的 folder 级旧值（顺序同 `workspaceFolders`）。 */
  workspaceFolderValues?: readonly unknown[];
  /** 注册表声明的默认值（可选；`readAll()` 的合并值通常已包含它）。 */
  defaultValue?: unknown;
}

/**
 * 宿主侧 IO 抽象：设置区（`iflow.qq.*`）与 SecretStorage。
 *
 * `readAll()` 返回 9 个设置键的**合并后原始值**（键缺失即 `undefined`），由
 * `pickQqSettingsUi` 归一；`writeAll(patch)` 逐键落盘，`patch` 里的值已经过
 * 校验/裁剪，是可序列化的最终值。
 *
 * `inspect()` 是**可选**能力：实现它的 IO 才能让读侧按「Global 优先」解析
 * （见 {@link readEffectiveQqSettings}）并检测旧工作区覆盖；纯内存 fake /
 * 旧实现不实现时退回 `readAll()` 的合并值，行为与改动前一致。
 */
export interface QqSettingsIo {
  /** 读出 9 个 `iflow.qq.*` 键的原始值（缺失为 `undefined`）。 */
  readAll(): Record<string, unknown>;
  /** 逐键作用域探测（Global 优先读 + 旧工作区覆盖检测的依据）。 */
  inspect?(key: string): QqSettingScopes | undefined;
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
 * 单键生效值：**用户级（Global）永远胜出**。
 *
 * 优先级：`globalValue` → `workspaceValue` → 第一个有值的
 * `workspaceFolderValues`（多根，按根顺序）→ `defaultValue`。
 *
 * 为什么不是 VSCode 原生的 folder > workspace > global：QQ 是机器级能力，
 * 落点固定为 Global（见 `createVscodeQqSettingsIo().writeAll`）。6f0ec90 之前
 * 的版本把设置写进了 Workspace 作用域，那些旧值会压过用户级设置，导致
 * 「切换工作区行为就变、必须重存一次」。这里把 Global 提到最前，旧值只在
 * Global 缺失时兜底 —— 不丢数据、不改写用户配置。
 */
export function pickQqSettingValue(scopes: QqSettingScopes | undefined): unknown {
  if (!scopes) return undefined;
  if (scopes.globalValue !== undefined) return scopes.globalValue;
  if (scopes.workspaceValue !== undefined) return scopes.workspaceValue;
  for (const value of scopes.workspaceFolderValues ?? []) {
    if (value !== undefined) return value;
  }
  return scopes.defaultValue;
}

/**
 * 读出 9 个键的**生效值**（Global 优先）。
 *
 * IO 实现了 `inspect()` 时逐键按 {@link pickQqSettingValue} 解析，解析不出来
 * 的键退回 `readAll()` 的合并值（后者在真实 VSCode 里已包含声明默认值）；
 * 未实现 `inspect()` 的纯内存 fake 直接用 `readAll()`，行为与改动前一致。
 */
export function readEffectiveQqSettings(io: QqSettingsIo): Record<string, unknown> {
  const merged = io.readAll();
  const inspect = typeof io.inspect === "function" ? io.inspect.bind(io) : undefined;
  if (!inspect) return merged;
  const raw: Record<string, unknown> = {};
  for (const key of QQ_SETTING_KEYS) {
    const picked = pickQqSettingValue(inspect(key));
    raw[key] = picked !== undefined ? picked : merged[key];
  }
  return raw;
}

/**
 * 列出「被用户级（Global）设置压住的旧工作区 / 文件夹级覆盖」键。
 *
 * 判定：Global 有值 **且** 工作区或任一文件夹级也有值（此时低优先级那份
 * 已不再生效）。旧版本（6f0ec90 之前）把 QQ 设置写在工作区作用域，正是这些
 * 残留；本模块只**检测**，不迁移、不写盘、不删除旧值。IO 没有 `inspect()`
 * 能力时无从判断，返回空数组。
 */
export function findShadowedWorkspaceKeys(io: QqSettingsIo): string[] {
  if (typeof io.inspect !== "function") return [];
  const inspect = io.inspect.bind(io);
  const shadowed: string[] = [];
  for (const key of QQ_SETTING_KEYS) {
    const scopes = inspect(key);
    if (!scopes || scopes.globalValue === undefined) continue;
    const hasWorkspaceOverride =
      scopes.workspaceValue !== undefined ||
      (scopes.workspaceFolderValues ?? []).some((value) => value !== undefined);
    if (hasWorkspaceOverride) shadowed.push(key);
  }
  return shadowed;
}

/**
 * 「旧工作区覆盖已被用户级设置取代」的一次性提示器。
 *
 * 每个实例（= 每个窗口的 `QqHost`）只放行一次：返回命中的键并触发 `notify`，
 * 之后的调用一律返回空数组。无残留时既不触发也不消耗这一次机会，因此首次
 * 启动没检出、后续启动才检出时仍会提示。只读 —— 不迁移、不写盘、不删旧值。
 */
export function createShadowedOverrideNotice(
  notify: (keys: readonly string[]) => void,
): (io: QqSettingsIo) => string[] {
  let shown = false;
  return (io) => {
    if (shown) return [];
    const keys = findShadowedWorkspaceKeys(io);
    if (keys.length === 0) return [];
    shown = true;
    notify(keys);
    return keys;
  };
}

/**
 * 读取 QQ 设置快照（9 项 + App Secret 布尔）。
 *
 * 读侧按「Global 优先」解析生效值（见 {@link readEffectiveQqSettings}）。
 * 只探测扫码写入的 `app-secret` 是否存在；`signing-secret` 与
 * `bridge-token` 是宿主内部自举的密钥，不对外暴露。返回结构里没有明文，
 * 即便 SecretStorage 里存了值也只投影成布尔。机器人 Token 已不再手填，
 * 历史 `iflow.qq.bot-token` 是死键，不再探测。
 */
export async function readQqSettings(io: QqSettingsIo): Promise<QqSettingsUi> {
  const raw = readEffectiveQqSettings(io);
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
 * **备注语义（两种条目形态刻意不同，不要混用）**：
 *  - **对象条目**的 `note` 是**权威值** —— 有值即覆盖磁盘备注，缺省或空串即
 *    **清空**磁盘备注（对象形态由 UI 全量回传时产生，用户清空输入框就是要删备注）；
 *  - **裸字符串条目**表示「只关心 id」，磁盘上同名 openid 已有的备注**原样保留**
 *    —— 否则扫码绑定 / 放行待审核这类只追加 id 的写路径会把用户填的备注抹掉；
 *  - 因此，**只想改 id、不想动备注的调用方必须传裸字符串**（或先 `readAll()`
 *    拿到备注再回传对象形态）；传一个不带 `note` 的对象 = 显式清空备注。
 *
 * 其余归一（与读侧 `normalizeQqAllowEntries` 同口径）：openid `trim`，空 id /
 * 非字符串非对象的项一律整键拒绝；写侧也按 openid **去重并保留首次出现顺序**
 * —— 读侧虽然会收敛，但磁盘上留重复 id 会让外部工具与旧版本读到脏数据。
 */
function coerceAllowList(value: unknown, existing: unknown): CoercedValue {
  if (!Array.isArray(value)) return { ok: false };

  const preserved = new Map<string, string>();
  for (const entry of normalizeQqAllowEntries(existing)) {
    if (entry.note) preserved.set(entry.openid, entry.note);
  }

  const seen = new Set<string>();
  const out: QqAllowEntryStored[] = [];
  for (const item of value) {
    const entry = normalizeQqAllowEntry(item);
    if (!entry) return { ok: false };
    if (seen.has(entry.openid)) continue;
    seen.add(entry.openid);
    // 裸字符串：只在盘上有备注时保留；对象：用它自己的 note（空 = 清空）。
    const note =
      typeof item === "string" ? (preserved.get(entry.openid) ?? "") : (entry.note ?? "");
    out.push(note.length > 0 ? { openid: entry.openid, note } : entry.openid);
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
 *  - 只允许 10 个白名单键；`hasAppSecret` 是派生字段，任何其它键（含
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
  // 用生效值（Global 优先）：UI 展示的就是它，备注必须与展示一致。
  const touchesAllowlist = entries.some(
    ([key]) => key === "allowedUsers" || key === "allowedGroups",
  );
  const existing: Record<string, unknown> = touchesAllowlist ? readEffectiveQqSettings(io) : {};
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

/** QQ 设置所在的配置区（`iflow.qq.*` 的段名）。 */
const QQ_CONFIG_SECTION = "iflow.qq";

/**
 * 用真实 VSCode 配置区与扩展传入的 SecretStorage 构造 IO。
 *
 * `secrets` 由扩展在激活时传入（`context.secrets`），**不要**在这里自己取
 * 扩展上下文。写入目标是 Global 作用域（与面板其余设置一致；QQ 是机器级
 * 能力），写入后顺手清掉同键的存量 Workspace 覆盖。
 *
 * `inspect()` 提供读侧「Global 优先」所需的分层快照；`readAll()` 仍是合并后
 * 的原始值（键未声明时为 `undefined`），生效值解析在
 * {@link readEffectiveQqSettings} 里完成，所以本函数不碰写入语义。
 */
export function createVscodeQqSettingsIo(secrets: QqSecretStorageLike): QqSettingsIo {
  /** 逐键探测各作用域值（Global / Workspace / 每个根目录的 folder 级）。 */
  const inspectKey = (key: string): QqSettingScopes => {
    const section = vscode.workspace.getConfiguration(QQ_CONFIG_SECTION);
    const info = section.inspect(key);
    const workspaceFolderValues: unknown[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      // 多根工作区里 folder 级覆盖必须按资源探测；无资源时 workspaceFolderValue
      // 恒为 undefined。单根窗口中 get() 已把 .vscode/settings.json 归入
      // workspaceValue，这里多探一次无副作用。
      const scoped = vscode.workspace
        .getConfiguration(QQ_CONFIG_SECTION, folder.uri)
        .inspect(key);
      workspaceFolderValues.push(scoped?.workspaceFolderValue);
    }
    return {
      globalValue: info?.globalValue,
      workspaceValue: info?.workspaceValue,
      workspaceFolderValues,
    };
  };
  return {
    readAll(): Record<string, unknown> {
      const section = vscode.workspace.getConfiguration(QQ_CONFIG_SECTION);
      const raw: Record<string, unknown> = {};
      for (const key of QQ_SETTING_KEYS) {
        raw[key] = section.get(key);
      }
      return raw;
    },
    inspect: inspectKey,
    async writeAll(patch: Record<string, unknown>): Promise<void> {
      const section = vscode.workspace.getConfiguration(QQ_CONFIG_SECTION);
      for (const [key, value] of Object.entries(patch)) {
        // 与面板其余 41 个设置同一落点：Global（QQ 是机器级能力，Settings
        // Sync 可携带）。Workspace 作用域在没打开工作区时会直接抛错，且会被
        // 工作区旧值压过 Global。
        await section.update(key, value, vscode.ConfigurationTarget.Global);
        // 存量工作区覆盖优先级高于 Global：写 Global 后必须单键清掉它，否则
        // 工作区旧值继续胜出，UI 显示与实际生效分裂。单键 update，不碰整文件。
        if (section.inspect(key)?.workspaceValue !== undefined) {
          await section.update(key, undefined, vscode.ConfigurationTarget.Workspace);
        }
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
