/**
 * 宿主 → bridge 的投递客户端（回环 HTTP，零 vscode 依赖）。
 *
 * 与 `src/qq/bridge/host-client.ts` 互为反方向：那边是 bridge 把事件推给宿主，
 * 这边是宿主把「要发到 QQ 的正文」推给 bridge 的 `POST /v1/deliver`。
 * 鉴权头与 `src/qq/ipc.ts` 的 `verifySignedRequest` / `signBody` 完全配对：
 * Bearer token + 毫秒时间戳 + nonce + `hex(HMAC-SHA256(原始 body))`。
 *
 * 纪律：
 *  - 用原生 `node:http` 直连，**不用全局 `fetch`**（扩展宿主 patch 过 fetch，
 *    系统代理为 SOCKS 时抛 "Invalid URL protocol"，见 AGENTS.md 陷阱 #2）。
 *  - 永不 reject：bridge 可能正在重启，网络失败 / 超时都是正常态，
 *    调用方按 `{ ok, status }` 决定是否重试。
 *  - 网络失败与超时的 `status` 记为 0（没有 HTTP 状态可言）。
 *  - 不打印日志、不记录 token：载荷含用户正文，日志纪律与 `ipc.ts` 一致。
 */

import { randomUUID } from "node:crypto";
import * as http from "node:http";
import type { DeliveryMessage } from "./bridge/delivery-server.js";
import { signBody } from "./ipc.js";

/** 默认单次请求上限：对端是本机进程，10s 足够。 */
export const DEFAULT_BRIDGE_TIMEOUT_MS = 10_000;

/** 错误响应体只保留前 8KB —— 只为取 `{ code }`，不缓存整段正文。 */
const ERROR_BODY_LIMIT_BYTES = 8 * 1024;

export interface BridgeDeliverResult {
  ok: boolean;
  /** HTTP 状态码；网络失败 / 超时为 0。 */
  status: number;
  /** 失败原因：优先取响应体 `{ code }`（如 unauthorized / replayed），否则为状态码。 */
  error?: string;
}

export interface BridgeHealthResult {
  ok: boolean;
  /** HTTP 状态码；网络失败 / 超时为 0。 */
  status: number;
}

export interface BridgeDeliveryClient {
  /** 投递一条消息；永不 reject。 */
  deliver(message: DeliveryMessage): Promise<BridgeDeliverResult>;
  /** 探活；永不 reject。 */
  health(): Promise<BridgeHealthResult>;
  /** 销毁底层 keep-alive agent，可重复调用。 */
  close(): void;
}

export interface BridgeDeliveryClientOptions {
  /** bridge delivery server 的端口（来自 `bridge_ready.deliveryPort`）。 */
  port: number;
  /** 与 bridge 共用的 Bearer token。 */
  token: string;
  /** 与 bridge 共用的 HMAC 密钥。 */
  hmacSecret: string;
  /** 目标地址，默认 `127.0.0.1`（不对外网卡发请求）。 */
  host?: string;
  /** 单次请求上限，默认 10s。 */
  timeoutMs?: number;
  /** 时钟来源（测试可注入）；默认 `Date.now`。 */
  now?: () => number;
  /** nonce 来源（测试可注入）；默认 `randomUUID()`。 */
  nonce?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从错误响应体里挖 `{ code }`；解析失败返回 undefined。 */
function extractErrorCode(raw: string): string | undefined {
  const text = raw.trim();
  if (text.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return undefined;
    const code = parsed["code"];
    return typeof code === "string" && code.length > 0 ? code : undefined;
  } catch {
    return undefined;
  }
}

export function createBridgeDeliveryClient(
  options: BridgeDeliveryClientOptions,
): BridgeDeliveryClient {
  const host = options.host ?? "127.0.0.1";
  const timeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? Math.max(1, options.timeoutMs)
      : DEFAULT_BRIDGE_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const makeNonce = options.nonce ?? randomUUID;

  // keep-alive：投递是高频小请求，复用连接；close() 时可一并销毁。
  const agent = new http.Agent({ keepAlive: true });

  /** 发一个请求并读回状态 + 限量响应体；永不 reject。 */
  const send = (
    method: "GET" | "POST",
    path: string,
    body: string | null,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string } | null> => {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: { status: number; body: string } | null): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let req: http.ClientRequest;
      try {
        req = http.request(
          {
            host,
            port: options.port,
            method,
            path,
            headers,
            agent,
          },
          (res) => {
            const status = res.statusCode ?? 0;
            const chunks: Buffer[] = [];
            let kept = 0;
            res.on("data", (chunk: Buffer) => {
              if (kept >= ERROR_BODY_LIMIT_BYTES) return;
              const slice = chunk.length > ERROR_BODY_LIMIT_BYTES - kept
                ? chunk.subarray(0, ERROR_BODY_LIMIT_BYTES - kept)
                : chunk;
              kept += slice.length;
              chunks.push(slice);
            });
            res.on("end", () => {
              settle({ status, body: Buffer.concat(chunks).toString("utf8") });
            });
            res.on("error", () => settle(null));
          },
        );
      } catch {
        // 非法端口等构造期错误：按网络失败处理（没有状态码）。
        settle(null);
        return;
      }

      req.setTimeout(timeoutMs, () => {
        req.destroy();
        settle(null);
      });
      req.on("error", () => settle(null));

      req.end(body ?? undefined);
    });
  };

  return {
    async deliver(message: DeliveryMessage): Promise<BridgeDeliverResult> {
      let raw: string;
      let timestamp: number;
      let nonce: string;
      let signature: string;
      try {
        raw = JSON.stringify(message);
        timestamp = now();
        nonce = makeNonce();
        signature = signBody(raw, options.hmacSecret, timestamp, nonce);
      } catch {
        // 序列化失败（循环引用）或签名前置条件缺失：没有可发送的载荷。
        return { ok: false, status: 0 };
      }

      const response = await send("POST", "/v1/deliver", raw, {
        authorization: `Bearer ${options.token}`,
        "x-timestamp": String(timestamp),
        "x-nonce": nonce,
        "x-signature": signature,
        "content-type": "application/json; charset=utf-8",
        "content-length": String(Buffer.byteLength(raw)),
      });
      if (!response) return { ok: false, status: 0 };

      if (response.status >= 200 && response.status < 300) {
        return { ok: true, status: response.status };
      }
      const code = extractErrorCode(response.body);
      return {
        ok: false,
        status: response.status,
        error: code ?? String(response.status),
      };
    },

    async health(): Promise<BridgeHealthResult> {
      // `/v1/health` 在 delivery server 侧不鉴权（本机回环存活探针）。
      const response = await send("GET", "/v1/health", null, {});
      if (!response) return { ok: false, status: 0 };
      return { ok: response.status === 200, status: response.status };
    },

    close(): void {
      agent.destroy();
    },
  };
}
