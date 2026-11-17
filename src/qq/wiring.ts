/**
 * QQ 面板接线的**纯逻辑**（Wave3-B2b）。
 *
 * `panel.ts` 里那段接线本身没法单测（要起 vscode、要 spawn bridge、要读写
 * SecretStorage），所以凡是「有判断」的部分都搬到此处，保持零 vscode 依赖、
 * 零副作用：
 *
 *  - {@link generateBindCode}：6 位大写字母数字配对码 + 5 分钟有效期；
 *  - {@link isBindCodeValid}：过期 / 不存在 / 大小写差异的判定（唯一一处）；
 *  - {@link isTerminalSuperStatus}：等待子会话收尾时的终态口径（字符串入参，
 *    端口拿到的可能是一个陌生值，不能被 `SuperStatus` 的类型断言骗过去）；
 *  - {@link shouldRestartOnPatch}：**哪些设置改动必须重建 QQ 服务**。
 *
 * 关于「必须重启」的取舍（与 panel 里的热更新路径配套）：
 * `QqService` 在构造时拿走一份 `config` 快照，但白名单 / 策略 / 并发 / 限流 /
 * 详略 / 自动合并这些字段都是在**使用时**从同一个对象里读的，因此面板可以
 * 直接改字段让它们即时生效；而 `enabled`（起停）只能靠重建 QQ 服务才能生效
 * —— 这就是 {@link QQ_CONNECTION_FIELDS}。阶段4 移除了 OneBot 专属的
 * `adapter` / `endpoint` / `bridgePort`，连接类字段现在只剩 `enabled`。
 */

import { randomBytes } from "node:crypto";
import type { QqConfig } from "./config.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 配对码长度（与设置页展示的输入框一致）。 */
export const QQ_BIND_CODE_LENGTH = 6;
/** 配对码有效期：5 分钟。 */
export const QQ_BIND_CODE_TTL_MS = 5 * 60_000;
/**
 * 轮询子会话终态的间隔。
 *
 * `SuperAgentManager` 只对外暴露**一个** `onSessionsChanged` 回调（面板已经
 * 用它把投影写进 store），没有「按订阅者分发」的事件面；为了不为了 QQ 通道
 * 就改动它的公开接口，这里退化为轮询 store 里的 `superSessions` 投影。
 * 1.5s 对「等一个可能跑几十分钟的子会话」绰绰有余，又不会让看板延迟可感。
 */
export const QQ_SETTLE_POLL_MS = 1_500;

/** 配对码字符集：大写字母 + 数字（不含小写，避免朗读/输入歧义）。 */
const BIND_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * 只有 `enabled` 的改动需要重建 QQ 服务（见文件头注释）。
 *
 * 其余字段（allowedUsers / allowedGroups / workspace / remotePolicy /
 * maxConcurrentTasks / rateLimitPerMin / resultDetail / autoMerge）由面板
 * 直接热更新到运行中的 config 对象上，改完即时生效、不打断在跑的任务。
 */
export const QQ_CONNECTION_FIELDS = [
  "enabled",
] as const;

export type QqConnectionField = (typeof QQ_CONNECTION_FIELDS)[number];

// ---------------------------------------------------------------------------
// 配对码
// ---------------------------------------------------------------------------

export interface QqBindCode {
  /** 6 位大写字母数字。 */
  code: string;
  /** 过期时间（epoch ms）。 */
  expiresAt: number;
}

/** 默认随机源：密码学安全。 */
function secureRandom(): number {
  return randomBytes(4).readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * 生成配对码。
 *
 * `rng` 只为可测性注入（测试传常量即可得到确定码）；`now` 同理。
 * 越界 / 非有限值的随机数一律按 0 处理 —— 脏随机源不能产出一个空码。
 * 字符逐位抽取，不存在「把整个随机数取模」带来的偏置放大。
 */
export function generateBindCode(
  rng: () => number = secureRandom,
  now: number = Date.now(),
): QqBindCode {
  let code = "";
  for (let index = 0; index < QQ_BIND_CODE_LENGTH; index += 1) {
    const sample = rng();
    const bounded = Number.isFinite(sample)
      ? Math.min(1 - Number.EPSILON, Math.max(0, sample))
      : 0;
    const at = Math.floor(bounded * BIND_ALPHABET.length);
    code += BIND_ALPHABET[at] ?? BIND_ALPHABET[0];
  }
  return { code, expiresAt: now + QQ_BIND_CODE_TTL_MS };
}

/**
 * 配对码是否可用。
 *
 * 判定顺序刻意是「记录存在 → 未过期 → 码匹配」：过期与不存在对用户是同一句
 * 文案（见 `QqService` 的 `QQ_BIND_FAILURE_TEXT`），但本地日志需要分清是哪一种，
 * 所以这里只返回布尔，原因由调用点自己补。
 *
 * 用户从 QQ 里手打码时大小写经常不对：比较前统一转大写（码本身只含大写）。
 */
export function isBindCodeValid(
  record: QqBindCode | null | undefined,
  code: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!record || typeof record.code !== "string" || record.code.length === 0) return false;
  if (typeof code !== "string") return false;
  const candidate = code.trim().toUpperCase();
  if (candidate.length === 0) return false;
  if (typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)) return false;
  if (record.expiresAt <= now) return false;
  return candidate === record.code.toUpperCase();
}

// ---------------------------------------------------------------------------
// 服务重启判定
// ---------------------------------------------------------------------------

/** 字段值比较：数组按元素逐位比较，其余按严格相等。 */
function sameFieldValue(previous: unknown, next: unknown): boolean {
  if (Array.isArray(previous) && Array.isArray(next)) {
    return (
      previous.length === next.length &&
      previous.every((item, index) => item === next[index])
    );
  }
  return previous === next;
}

/**
 * 这次设置补丁是否要求重建 QQ 服务。
 *
 * - 只认 {@link QQ_CONNECTION_FIELDS}；白名单 / 策略等热更新字段一律返回 false。
 * - `undefined` 表示「本次不改」，不参与判定（与 `applyQqSettingsPatch` 同语义）。
 * - `previous` 缺失（服务没在跑，或调用方还没有快照）时，只要补丁碰到连接类
 *   字段就返回 true —— 交给调用方决定「该起还是该停」。
 * - 值没变（例如回写同一份 enabled）不算改动，避免无谓地重启 QQ 服务。
 */
export function shouldRestartOnPatch(
  previous: QqConfig | null | undefined,
  patch: Record<string, unknown> | null | undefined,
): boolean {
  if (!patch || typeof patch !== "object") return false;
  for (const field of QQ_CONNECTION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    const next = patch[field];
    if (next === undefined) continue;
    if (!previous) return true;
    if (!sameFieldValue(previous[field], next)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 子会话终态
// ---------------------------------------------------------------------------

/**
 * 子会话是否已到终态。
 *
 * 入参刻意是 `string`：状态来自 wire / 归档，可能带着旧版本或脏值；用
 * `SuperStatus` 断言会让「未知值」被当成终态或非终态的其中一边。这里只认
 * 三个明确的终态（与 `shared/super-agent.ts` 的 `TERMINAL_STATUSES` 同源）。
 */
export function isTerminalSuperStatus(status: string | null | undefined): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
