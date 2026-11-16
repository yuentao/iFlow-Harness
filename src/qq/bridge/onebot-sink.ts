/**
 * OneBot v11 反向 HTTP 事件入口（bridge 侧，零 vscode 依赖）。
 *
 * QQ 后端（go-cqhttp / NapCat 等）把事件 POST 到本服务；这里只做三件事：
 *  1. 鉴权（`Authorization: Bearer <token>`，定长摘要比较）；
 *  2. 读体（≤1MB）并 JSON 解析；
 *  3. 交给 adapter 的 `normalizeOneBotEvent` 归一化，成功则回调 `onEvent`。
 *
 * **命令解析 / 发送者白名单 / 群聊开关一律不在这里**：那是宿主职责，bridge
 * 只负责把平台事件忠实地搬过去（与 shared/qq-task.ts 的纯数据分界一致）。
 *
 * 不打印日志：事件体含用户消息。
 */

import { createHash, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { normalizeOneBotEvent } from "../adapter/onebot.js";
import type { InboundMessage } from "../adapter/types.js";

/** 入站事件体上限：1MB（与宿主 IPC 同口径）。 */
export const ONEBOT_MAX_BODY_BYTES = 1024 * 1024;

/** 默认路由，与 OneBot 反向 HTTP 配置里的上报路径一致。 */
export const DEFAULT_ONEBOT_PATH = "/onebot/event";

/** 定长比较：先做 SHA-256 摘要（32 字节），再 `timingSafeEqual`。 */
function safeEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left, "utf8").digest();
  const b = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(a, b);
}

function headerValue(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

/** 读请求体；超限后继续排空但不保存（让客户端能稳定收到 413）。 */
function readBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<{ raw: string; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (tooLarge) return;
      if (bytes > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve({ raw: tooLarge ? "" : Buffer.concat(chunks).toString("utf8"), tooLarge });
    });
    req.on("error", (error) => reject(error));
  });
}

function sendStatus(res: http.ServerResponse, status: number, payload?: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (payload === undefined) {
    res.writeHead(status, { "cache-control": "no-store" });
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

export interface OneBotSinkOptions {
  /** 监听端口，0 = 系统分配。 */
  port?: number;
  /** 事件路径，默认 `/onebot/event`。 */
  path?: string;
  /** OneBot access token；请求必须带 `Authorization: Bearer <token>`。 */
  token: string;
  /**
   * 机器人自身 QQ 号，用于判定 `mentionsBot`。缺省为空串（一律视为未 @，
   * 因为无法证明被提及；宿主仍会收到 `mentionsBot: false`）。
   */
  selfId?: string;
  /** 归一化成功的入站消息回调。 */
  onEvent(inbound: InboundMessage): void | Promise<void>;
  /** 事件体上限，默认 1MB（测试可调）。 */
  maxBodyBytes?: number;
}

export interface OneBotSink {
  /** 实际监听端口（传 0 时由系统分配）。 */
  readonly port: number;
  readonly server: http.Server;
  close(): Promise<void>;
}

/**
 * 启动 OneBot 反向 HTTP 事件服务。
 *
 * 只绑 `127.0.0.1`（QQ 后端与 bridge 同机）；端口占用会让 `listen` 抛
 * `EADDRINUSE`，由调用方决定如何上报（main.ts 据此 exit 1）。
 */
export async function createOneBotSink(options: OneBotSinkOptions): Promise<OneBotSink> {
  const routePath = options.path ?? DEFAULT_ONEBOT_PATH;
  const maxBodyBytes =
    typeof options.maxBodyBytes === "number" && Number.isFinite(options.maxBodyBytes)
      ? Math.max(0, options.maxBodyBytes)
      : ONEBOT_MAX_BODY_BYTES;
  const selfId = options.selfId ?? "";

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (method !== "POST" || url.pathname !== routePath) {
      sendStatus(res, 404, { ok: false, code: "not_found" });
      return;
    }

    // 1) Bearer token（定长比较；缺失与错误一律 401，不泄漏细节）
    const authorization = headerValue(req.headers, "authorization");
    const bearer = authorization ? /^Bearer\s+(.+)$/i.exec(authorization.trim())?.[1] : undefined;
    if (!bearer || !safeEqual(bearer, options.token)) {
      sendStatus(res, 401, { ok: false, code: "unauthorized" });
      return;
    }

    // 2) 读体 + 1MB 上限
    let body: { raw: string; tooLarge: boolean };
    try {
      body = await readBody(req, maxBodyBytes);
    } catch {
      sendStatus(res, 400, { ok: false, code: "bad_request" });
      return;
    }
    if (body.tooLarge) {
      sendStatus(res, 413, { ok: false, code: "payload_too_large" });
      return;
    }

    // 3) JSON 解析
    let raw: unknown;
    try {
      raw = body.raw.trim().length > 0 ? JSON.parse(body.raw) : null;
    } catch {
      sendStatus(res, 400, { ok: false, code: "bad_request" });
      return;
    }

    // 4) 归一化：非消息事件（notice / meta_event / 无法定位聊天）→ 204 静默丢弃
    const inbound = normalizeOneBotEvent(raw, { selfId });
    if (!inbound) {
      sendStatus(res, 204);
      return;
    }

    // 5) 回调；抛错只回 500，不把堆栈写回给 QQ 后端。
    try {
      await options.onEvent(inbound);
    } catch {
      sendStatus(res, 500, { ok: false, code: "internal_error" });
      return;
    }
    sendStatus(res, 204);
  };

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      try {
        sendStatus(res, 500, { ok: false, code: "internal_error" });
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
    throw new Error("OneBotSink: failed to resolve the listening address");
  }
  const actualPort = (address as AddressInfo).port;

  // 绑定成功后的运行时错误（客户端 socket 异常等）不应让进程崩溃。
  server.on("error", () => undefined);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (!server.listening) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Node 18.2+：主动断开 keep-alive 连接，避免 close 永远等不到。
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    });
  };

  return { port: actualPort, server, close };
}
