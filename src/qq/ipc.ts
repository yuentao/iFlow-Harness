/**
 * QQ 通道的宿主侧本地 IPC（loopback HTTP，零 vscode 依赖，便于单测）。
 *
 * 使用方：QQ bridge 是一个独立进程，通过本机回环 HTTP 把「入站事件」「投递
 * 结果」「任务操作」「健康检查」交给扩展宿主。服务端只监听 `127.0.0.1`，
 * 不对外网卡暴露（`listen` 的第二参硬编码为 "127.0.0.1"）。
 *
 * 每个请求（含健康检查）都要过四道校验：
 *  1. `Authorization: Bearer <token>` —— 定长摘要比较（`timingSafeEqual`），
 *     长度不同也不会因提前返回而泄漏长度；
 *  2. `X-Timestamp` —— 毫秒时间戳，与 `now()` 同一单位，偏移超过 ±30s 拒绝；
 *  3. `X-Signature` —— `hex(HMAC-SHA256(rawBody, hmacSecret))`，按**原始请求
 *     体**计算（协议约定见 `signBody`）；
 *  4. `X-Nonce` —— 进程内 Map 缓存 5 分钟，重复出现即判定重放。
 *
 * 失败响应统一 `{ ok: false, code }`，code 取值：
 *   unauthorized | bad_signature | stale_timestamp | replayed |
 *   bad_request | payload_too_large | not_found | internal_error
 *
 * 日志纪律：本模块**不打印任何日志** —— token 与请求体都不许进日志。
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

/** 请求体上限：1MB。超过直接 413，交给上层重传更小的载荷。 */
export const MAX_BODY_BYTES = 1024 * 1024;
/** 允许的时钟偏移（前后各 30s）。 */
export const CLOCK_SKEW_MS = 30_000;
/** nonce 保留时长。 */
export const NONCE_TTL_MS = 5 * 60 * 1000;

export interface QqIpcHandlers {
  /** POST /v1/events —— 入站消息 / 平台事件（已解析的 JSON）。 */
  onEvents(body: unknown): Promise<unknown>;
  /** POST /v1/deliver —— 投递回执 / 结果上报。 */
  onDeliver(body: unknown): Promise<unknown>;
  /** POST /v1/tasks/:id/action —— 针对某个任务的用户操作。 */
  onTaskAction(taskId: string, body: unknown): Promise<unknown>;
  /** GET /v1/health —— 健康检查（同样需要鉴权）。 */
  onHealth(): Promise<unknown>;
}

export interface QqIpcServerOptions {
  /** 监听端口，0 = 由系统分配。 */
  port?: number;
  token: string;
  hmacSecret: string;
  handlers: QqIpcHandlers;
  /** 时钟来源（测试可注入）；默认 `Date.now`。 */
  now?: () => number;
  /** 允许的时钟偏移，默认 30s（测试可收紧）。 */
  clockSkewMs?: number;
}

export interface QqIpcServer {
  /** 实际监听的端口（传入 0 时由系统分配）。 */
  readonly port: number;
  /** 底层 server，测试用它断言 `address()`。 */
  readonly server: http.Server;
  close(): Promise<void>;
}

/**
 * 计算请求签名，供客户端（QQ bridge）复用。
 *
 * 协议契约：HMAC-SHA256 覆盖**原始请求体**。时间戳与 nonce 走独立请求头，
 * 由服务端用「时钟窗口 + 重放缓存」各自校验，因此不并入摘要；这里仍要求
 * 二者必填，是为了让调用点无法漏掉鉴权头。
 */
export function signBody(
  body: string,
  secret: string,
  timestamp: number | string,
  nonce: string,
): string {
  const timestampOk =
    (typeof timestamp === "number" && Number.isFinite(timestamp)) ||
    (typeof timestamp === "string" && timestamp.length > 0);
  if (!timestampOk) throw new Error("signBody: timestamp is required");
  if (!nonce) throw new Error("signBody: nonce is required");
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

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

type Route =
  | { kind: "events" }
  | { kind: "deliver" }
  | { kind: "health" }
  | { kind: "task"; taskId: string };

function resolveRoute(method: string, pathname: string): Route | null {
  if (method === "GET" && pathname === "/v1/health") return { kind: "health" };
  if (method === "POST" && pathname === "/v1/events") return { kind: "events" };
  if (method === "POST" && pathname === "/v1/deliver") return { kind: "deliver" };
  if (method === "POST") {
    const match = /^\/v1\/tasks\/([^/]+)\/action\/?$/.exec(pathname);
    const rawId = match?.[1];
    if (rawId) {
      let taskId = rawId;
      try {
        taskId = decodeURIComponent(rawId);
      } catch {
        // 非法百分号编码：按原样使用（后续处理器会拒绝未知任务）。
      }
      if (taskId.length > 0) return { kind: "task", taskId };
    }
  }
  return null;
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

/**
 * 读请求体。
 *
 * 超限后**继续排空但不保存**（`chunk.length = 0`），确保客户端把请求写完、
 * 能稳定收到 413，而不是被中途掐断连接只看到 ECONNRESET。
 */
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
      resolve({
        raw: tooLarge ? "" : Buffer.concat(chunks).toString("utf8"),
        tooLarge,
      });
    });
    req.on("error", (error) => reject(error));
  });
}

/** `verifySignedRequest` 失败时的原因码（HTTP 状态由函数一并给出）。 */
export type SignedRequestFailureCode =
  | "unauthorized"
  | "stale_timestamp"
  | "bad_signature"
  | "payload_too_large"
  | "bad_request"
  | "replayed";

/** `verifySignedRequest` 的校验参数。 */
export interface SignedRequestVerifyOptions {
  token: string;
  hmacSecret: string;
  /** 时钟来源（测试可注入）；默认 `Date.now`。 */
  now?: () => number;
  /** 允许的时钟偏移，默认 30s（测试可收紧）。 */
  clockSkewMs?: number;
  /** 请求体上限，默认 1MB。 */
  maxBodyBytes?: number;
  /**
   * nonce 缓存（nonce → 过期时间）。调用方必须在多个请求之间复用同一个 Map，
   * 否则重放保护不生效；IPC 服务与 bridge 的 delivery server 各自持有一份。
   */
  nonces: Map<string, number>;
}

export type SignedRequestVerification =
  | { ok: true; raw: string; payload: unknown }
  | { ok: false; status: number; code: SignedRequestFailureCode };

/** 清掉已过期的 nonce 记录（懒清扫，调用点在每个请求与定时器上）。 */
function sweepNonces(nonces: Map<string, number>, at: number): void {
  for (const [nonce, expiresAt] of nonces) {
    if (expiresAt <= at) nonces.delete(nonce);
  }
}

/**
 * 校验一个已到达的 HTTP 请求：Bearer → 时间戳窗口 → nonce 头 → 读 body →
 * HMAC 签名 → 解析 JSON → 重放登记。
 *
 * 校验顺序与 `createQqIpcServer` 历史实现逐条一致，换用本函数不改变既有行为。
 * 失败时返回状态码与原因码，**不写响应**（由调用方决定回复格式）。
 */
export async function verifySignedRequest(
  req: http.IncomingMessage,
  options: SignedRequestVerifyOptions,
): Promise<SignedRequestVerification> {
  const now = options.now ?? (() => Date.now());
  const clockSkewMs =
    typeof options.clockSkewMs === "number" && Number.isFinite(options.clockSkewMs)
      ? Math.max(0, options.clockSkewMs)
      : CLOCK_SKEW_MS;
  const maxBodyBytes =
    typeof options.maxBodyBytes === "number" && Number.isFinite(options.maxBodyBytes)
      ? Math.max(0, options.maxBodyBytes)
      : MAX_BODY_BYTES;

  // 1) Bearer token
  const authorization = headerValue(req.headers, "authorization");
  const bearer = authorization ? /^Bearer\s+(.+)$/i.exec(authorization.trim())?.[1] : undefined;
  if (!bearer || !safeEqual(bearer, options.token)) {
    return { ok: false, status: 401, code: "unauthorized" };
  }

  // 2) 时间戳 + nonce 必填（时间戳单位与 now() 一致：毫秒）
  const timestampRaw = headerValue(req.headers, "x-timestamp");
  const timestamp = timestampRaw ? Number(timestampRaw) : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    return { ok: false, status: 401, code: "unauthorized" };
  }
  if (Math.abs(now() - timestamp) > clockSkewMs) {
    return { ok: false, status: 401, code: "stale_timestamp" };
  }
  const nonce = headerValue(req.headers, "x-nonce");
  if (!nonce) {
    return { ok: false, status: 401, code: "unauthorized" };
  }

  // 3) 读 body（1MB 上限）
  let body: { raw: string; tooLarge: boolean };
  try {
    body = await readBody(req, maxBodyBytes);
  } catch {
    return { ok: false, status: 400, code: "bad_request" };
  }
  if (body.tooLarge) {
    return { ok: false, status: 413, code: "payload_too_large" };
  }

  // 4) 签名（覆盖原始 body）
  const signature = headerValue(req.headers, "x-signature");
  const expected = signBody(body.raw, options.hmacSecret, timestamp, nonce);
  if (!signature || !safeEqual(signature.trim().toLowerCase(), expected)) {
    return { ok: false, status: 401, code: "bad_signature" };
  }

  // 5) 解析 JSON（签名通过之后再做，坏 body 不消耗 nonce）
  let payload: unknown = null;
  const method = req.method ?? "GET";
  if (method !== "GET" && body.raw.trim().length > 0) {
    try {
      payload = JSON.parse(body.raw);
    } catch {
      return { ok: false, status: 400, code: "bad_request" };
    }
  }

  // 6) 重放检查（通过即登记，TTL 5 分钟）
  sweepNonces(options.nonces, now());
  if (options.nonces.has(nonce)) {
    return { ok: false, status: 409, code: "replayed" };
  }
  options.nonces.set(nonce, now() + NONCE_TTL_MS);

  return { ok: true, raw: body.raw, payload };
}

/**
 * 启动本地 IPC 服务。
 *
 * 只绑 `127.0.0.1`；返回解析出的端口与幂等的 `close()`。
 */
export async function createQqIpcServer(options: QqIpcServerOptions): Promise<QqIpcServer> {
  const token = options.token;
  const hmacSecret = options.hmacSecret;
  const handlers = options.handlers;
  const now = options.now ?? (() => Date.now());
  const clockSkewMs =
    typeof options.clockSkewMs === "number" && Number.isFinite(options.clockSkewMs)
      ? Math.max(0, options.clockSkewMs)
      : CLOCK_SKEW_MS;

  /** nonce → 过期时间（毫秒）。 */
  const nonces = new Map<string, number>();

  // 定期清理：每个请求前也会懒清扫一次，这里的定时器只是防止长期空闲时
  // 映射无限增长。unref 让定时器不阻塞进程退出，close() 时显式清掉。
  const sweepTimer = setInterval(() => sweepNonces(nonces, now()), 60_000);
  sweepTimer.unref?.();

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = resolveRoute(method, url.pathname);
    if (!route) {
      sendJson(res, 404, { ok: false, code: "not_found" });
      return;
    }

    // 鉴权 + 读体 + 签名 + 解析 + 重放，全部与 delivery server 共用同一实现。
    const verification = await verifySignedRequest(req, {
      token,
      hmacSecret,
      now,
      clockSkewMs,
      nonces,
    });
    if (!verification.ok) {
      sendJson(res, verification.status, { ok: false, code: verification.code });
      return;
    }
    const payload = verification.payload;

    // 7) 交给处理器；抛错只回 500，绝不把堆栈/原始错误写回给调用方。
    try {
      let result: unknown;
      switch (route.kind) {
        case "health":
          result = await handlers.onHealth();
          break;
        case "events":
          result = await handlers.onEvents(payload);
          break;
        case "deliver":
          result = await handlers.onDeliver(payload);
          break;
        case "task":
          result = await handlers.onTaskAction(route.taskId, payload);
          break;
      }
      sendJson(res, 200, { ok: true, data: result ?? null });
    } catch {
      sendJson(res, 500, { ok: false, code: "internal_error" });
    }
  };

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      // 兜底：处理器之外的意外失败（如 URL 解析）也不能让连接悬挂。
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
    throw new Error("QqIpcServer: failed to resolve the listening address");
  }
  const actualPort = (address as AddressInfo).port;

  // 绑定成功后的运行时错误（客户端 socket 异常等）不应让进程崩溃。
  server.on("error", () => undefined);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(sweepTimer);
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
