/**
 * 宿主 → bridge 的投递入口（回环 HTTP，零 vscode 依赖）。
 *
 * `POST /v1/deliver` 承载宿主想发到 QQ 的正文；鉴权**完全复用** `ipc.ts` 的
 * `verifySignedRequest`（Bearer + HMAC + ±30s 时间戳 + nonce 重放），因此
 * 两个方向共用同一套签名协议，没有第二份实现可以漂移。
 *
 * `GET /v1/health` 只回 `{ ok: true, uptimeMs }`，**不鉴权**：它是本机回环的
 * 存活探针，不含任何用户数据；真正的数据面（deliver）仍然强鉴权。
 *
 * 不打印日志：投递正文可能含用户内容。
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { ChatType } from "../adapter/types.js";
import { verifySignedRequest } from "../ipc.js";

/** 一条待投递消息（与 `OutboundMessage` 同形，但只含 bridge 需要的字段）。 */
export interface DeliveryMessage {
  chatType: ChatType;
  chatId: string;
  text: string;
  /** 引用回复目标消息 id。 */
  replyToMsgId?: string;
  /** 本地文件路径（当前 OneBot HTTP transport 不支持上传，bridge 会如实失败）。 */
  filePath?: string;
}

export interface DeliveryServerOptions {
  /** 监听端口，0 = 系统分配。 */
  port?: number;
  /** 与宿主共用的 Bearer token。 */
  token: string;
  /** 与宿主共用的 HMAC 密钥。 */
  hmacSecret: string;
  /** 鉴权通过后的投递回调。 */
  onDeliver(message: DeliveryMessage): void | Promise<void>;
  /** 时钟来源（测试可注入）；默认 `Date.now`。 */
  now?: () => number;
  /** 允许的时钟偏移，默认 30s（测试可收紧）。 */
  clockSkewMs?: number;
  /** 请求体上限，默认 1MB。 */
  maxBodyBytes?: number;
}

export interface DeliveryServer {
  /** 实际监听端口（传 0 时由系统分配）。 */
  readonly port: number;
  readonly server: http.Server;
  close(): Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function sendNoContent(res: http.ServerResponse): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(204, { "cache-control": "no-store" });
  res.end();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验投递载荷；未知字段忽略，错误类型一律返回 null（→ 400）。 */
function parseDeliveryMessage(payload: unknown): DeliveryMessage | null {
  if (!isRecord(payload)) return null;
  const chatType = payload["chatType"];
  if (chatType !== "private" && chatType !== "group") return null;
  const chatId = payload["chatId"];
  if (typeof chatId !== "string" || chatId.trim().length === 0) return null;
  const text = payload["text"];
  if (typeof text !== "string") return null;
  const message: DeliveryMessage = { chatType, chatId, text };
  const replyToMsgId = payload["replyToMsgId"];
  if (replyToMsgId !== undefined) {
    if (typeof replyToMsgId !== "string") return null;
    if (replyToMsgId.length > 0) message.replyToMsgId = replyToMsgId;
  }
  const filePath = payload["filePath"];
  if (filePath !== undefined) {
    if (typeof filePath !== "string") return null;
    if (filePath.length > 0) message.filePath = filePath;
  }
  return message;
}

/**
 * 启动投递服务。
 *
 * 只绑 `127.0.0.1`；返回实际端口与幂等的 `close()`。
 */
export async function createDeliveryServer(
  options: DeliveryServerOptions,
): Promise<DeliveryServer> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  /** nonce → 过期时间；每个 server 独占一份，close 时清空。 */
  const nonces = new Map<string, number>();

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (method === "GET" && url.pathname === "/v1/health") {
      sendJson(res, 200, { ok: true, uptimeMs: Math.max(0, now() - startedAt) });
      return;
    }

    if (method !== "POST" || url.pathname !== "/v1/deliver") {
      sendJson(res, 404, { ok: false, code: "not_found" });
      return;
    }

    const verification = await verifySignedRequest(req, {
      token: options.token,
      hmacSecret: options.hmacSecret,
      now,
      clockSkewMs: options.clockSkewMs,
      maxBodyBytes: options.maxBodyBytes,
      nonces,
    });
    if (!verification.ok) {
      sendJson(res, verification.status, { ok: false, code: verification.code });
      return;
    }

    const message = parseDeliveryMessage(verification.payload);
    if (!message) {
      sendJson(res, 400, { ok: false, code: "bad_request" });
      return;
    }

    try {
      await options.onDeliver(message);
    } catch {
      sendJson(res, 500, { ok: false, code: "internal_error" });
      return;
    }
    sendNoContent(res);
  };

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      try {
        sendJson(res, 500, { ok: false, code: "internal_error" });
      } catch {
        res.destroy();
      }
    });
  });

  const port = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    // 硬编码回环地址：绝不绑 0.0.0.0。
    server.listen(port, "127.0.0.1");
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("DeliveryServer: failed to resolve the listening address");
  }
  const actualPort = (address as AddressInfo).port;

  // 绑定成功后的运行时错误（客户端 socket 异常等）不应让进程崩溃。
  server.on("error", () => undefined);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    nonces.clear();
    if (!server.listening) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Node 18.2+：主动断开 keep-alive 连接，避免 close 永远等不到。
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    });
  };

  return { port: actualPort, server, close };
}
