/**
 * 机器人自身 QQ 号（selfId）解析（bridge 侧，零 vscode 依赖）。
 *
 * 为什么需要：群聊消息里是否 @ 了机器人，只能靠 `[CQ:at,qq=<selfId>]` /
 * at 段与**自身 QQ 号比较**才能判定（见 adapter/onebot.ts 的 mentionsSelf）。
 * selfId 缺失时 mentionsBot 恒为 false，而 QqService 要求群聊必须 mentionsBot
 * ——整条群聊链路会被静默丢弃。宿主并不总是传 `IFLOW_QQ_SELF_ID`，所以
 * bridge 自己在启动 sink 前用 OneBot v11 标准的 `get_login_info` 问一次后端。
 *
 * 优先级：env `IFLOW_QQ_SELF_ID`（非空）> `get_login_info` 结果 > 空串。
 * 取不到**不**让启动失败：照常起 sink，只向 stderr 打一行可识别警告。
 * 日志一律走调用方传入的 `log`（main.ts 的 log 已带 `[qq-bridge]` 前缀），
 * 绝不写 stdout —— stdout 可能被上层当作协议管道。
 */

import type { OneBotTransport } from "../adapter/http-transport.js";

/** `get_login_info` 超时：后端不可达时不能让 bridge 启动无限期挂住。 */
export const SELF_ID_QUERY_TIMEOUT_MS = 5_000;

/** 取不到 selfId 时的固定警告（便于日志检索）。 */
export const SELF_ID_UNKNOWN_WARNING =
  "warn: selfId unknown; group @mentions will not match";

export interface ResolveSelfIdOptions {
  /** OneBot HTTP transport；未配置 `IFLOW_QQ_ONEBOT_URL` 时为 undefined。 */
  transport?: OneBotTransport;
  /** env `IFLOW_QQ_SELF_ID` 的原始值（宿主可能不传）。非空时最高优先级。 */
  envSelfId?: string;
  /** 诊断输出；main.ts 传入已带 `[qq-bridge] ` 前缀的 stderr logger。 */
  log?: (line: string) => void;
  /** `get_login_info` 超时毫秒数，默认 5000（测试可注入小值）。 */
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** QQ 号既可能是 number 也可能是 string；空串视为取不到。 */
function toSelfId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${error.message} (${code})` : error.message;
  }
  return String(error);
}

/** 给一次请求套上硬超时；超时后原 promise 的后续结果被忽略（race 已挂处理器）。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`get_login_info timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    // bridge 会因 stdin 结束退出；游离的定时器不应把进程多留住 5 秒。
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * 解析机器人自身 QQ 号。
 *
 * 永不抛错：任何失败都退化成空串 + 一行 `warn:` 日志（启动流程不应因此中断）。
 */
export async function resolveSelfId(options: ResolveSelfIdOptions = {}): Promise<string> {
  const log = options.log ?? ((): void => undefined);

  const envSelfId = options.envSelfId?.trim();
  if (envSelfId) return envSelfId;

  const transport = options.transport;
  if (!transport) {
    log(SELF_ID_UNKNOWN_WARNING);
    return "";
  }

  let selfId: string | undefined;
  try {
    const response = await withTimeout(
      transport.post("get_login_info", {}),
      options.timeoutMs ?? SELF_ID_QUERY_TIMEOUT_MS,
    );
    // OneBot v11: `{ status: "ok", retcode: 0, data: { user_id, nickname } }`。
    if (isRecord(response) && response["status"] === "ok" && isRecord(response["data"])) {
      selfId = toSelfId(response["data"]["user_id"]);
    }
  } catch (error) {
    log(`${SELF_ID_UNKNOWN_WARNING} (get_login_info failed: ${describeError(error)})`);
    return "";
  }

  if (!selfId) {
    log(`${SELF_ID_UNKNOWN_WARNING} (get_login_info returned no usable user_id)`);
    return "";
  }
  return selfId;
}
