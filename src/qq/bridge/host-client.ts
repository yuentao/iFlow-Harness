/**
 * bridge → 扩展宿主的事件上行客户端（回环 HTTP，零 vscode 依赖）。
 *
 * 只做一件事：`POST http://127.0.0.1:<hostPort>/v1/events`，带上与宿主侧
 * `verifySignedRequest` 完全配对的鉴权头（Bearer + 毫秒时间戳 + nonce +
 * HMAC-SHA256 原始体签名）。协议细节见 `src/qq/ipc.ts` 顶部注释。
 *
 * 纪律：
 *  - 永远不抛错。宿主短暂不可达 / 超时 / 5xx 都是 bridge 的正常运行态
 *    （宿主可能正在重启），调用方按 `{ ok, status }` 决定是否记日志或重试。
 *  - 网络失败与超时的 `status` 记为 0（没有 HTTP 状态可言），与真实 5xx
 *    区分开，但同样 `ok: false`。
 *  - 不打印日志：载荷可能含用户消息，日志纪律与 `ipc.ts` 一致。
 */

import { randomUUID } from "node:crypto";
import * as http from "node:http";
import { signBody } from "../ipc.js";

/** 默认单次请求上限：宿主是本地进程，10s 足够。 */
export const DEFAULT_HOST_TIMEOUT_MS = 10_000;

export interface PostEventsResult {
  ok: boolean;
  /** HTTP 状态码；网络失败 / 超时为 0。 */
  status: number;
}

export interface HostClient {
  /** 把一条事件投递给宿主；永不 reject。 */
  postEvents(body: unknown): Promise<PostEventsResult>;
}

export interface HostClientOptions {
  /** 宿主 IPC 端口。 */
  hostPort: number;
  /** Batch 鉴权 token（`Authorization: Bearer …`）。 */
  bridgeToken: string;
  /** HMAC 密钥。 */
  hmacSecret: string;
  /** 宿主地址，默认 `127.0.0.1`（不对外网卡发请求）。 */
  host?: string;
  /** 单次请求上限，默认 10s。 */
  timeoutMs?: number;
  /** 时钟来源（测试可注入）；默认 `Date.now`。 */
  now?: () => number;
  /** nonce 来源（测试可注入）；默认 `randomUUID()`。 */
  nonce?: () => string;
}

export function createHostClient(options: HostClientOptions): HostClient {
  const host = options.host ?? "127.0.0.1";
  const timeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? Math.max(1, options.timeoutMs)
      : DEFAULT_HOST_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const makeNonce = options.nonce ?? randomUUID;

  return {
    postEvents(body: unknown): Promise<PostEventsResult> {
      let raw: string;
      try {
        raw = JSON.stringify(body);
      } catch {
        // 循环引用等序列化失败：没有可发送的载荷，按网络失败处理。
        return Promise.resolve({ ok: false, status: 0 });
      }
      const timestamp = now();
      const nonce = makeNonce();
      const headers: Record<string, string> = {
        authorization: `Bearer ${options.bridgeToken}`,
        "x-timestamp": String(timestamp),
        "x-nonce": nonce,
        "x-signature": signBody(raw, options.hmacSecret, timestamp, nonce),
        "content-type": "application/json; charset=utf-8",
        "content-length": String(Buffer.byteLength(raw)),
      };

      return new Promise<PostEventsResult>((resolve) => {
        let settled = false;
        const settle = (result: PostEventsResult): void => {
          if (settled) return;
          settled = true;
          resolve(result);
        };

        const req = http.request(
          {
            host,
            port: options.hostPort,
            method: "POST",
            path: "/v1/events",
            headers,
          },
          (res) => {
            const status = res.statusCode ?? 0;
            // 响应体不参与判定，但必须排空，否则 socket 不会释放。
            res.on("data", () => undefined);
            res.on("end", () => {
              settle({ ok: status >= 200 && status < 300, status });
            });
            res.on("error", () => {
              settle({ ok: false, status });
            });
          },
        );

        req.setTimeout(timeoutMs, () => {
          req.destroy();
          settle({ ok: false, status: 0 });
        });

        req.on("error", () => {
          settle({ ok: false, status: 0 });
        });

        req.end(raw);
      });
    },
  };
}
