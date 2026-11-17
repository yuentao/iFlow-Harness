/**
 * 官方 QQBot 的 node 侧真实 transport：实现 M2 定义的 `QqBotTransport` /
 * `QqBotSocket`（见 ./adapter.ts）。
 *
 * 设计纪律：
 *  - **ws 静态打包**：`ws` 用顶层静态 `import`，由 esbuild 打进 `dist/extension.cjs`
 *    （host bundle 只把 `vscode` 标 external；VSIX 里没有 node_modules/ws，绝不能
 *    在运行期 require 外部包，否则用户机器上就会 Cannot find module 'ws'）。单测仍
 *    可注入 WebSocketImpl 假实现驱动，不连真实网关。
 *  - **禁全局 fetch**（AGENTS 陷阱 #2）：post 走 node:http(s) 直连，按 URL
 *    协议选模块；只有 2xx 才解析 JSON，非 2xx / 超时 / 非法 JSON 一律 reject。
 *  - **token 不进错误文本**：错误信息只带 method / path / status / 原因，
 *    绝不回显响应体或请求头（access_token 响应体本身含凭据）。
 *  - 入站文本帧统一 JSON.parse 成对象再回调（adapter 的 handleRaw 只认 record）；
 *    已是对象则原样转发；解析失败的文本按原文转发，不静默吞帧。
 */

import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import WebSocket from "ws";
import type { QqBotSocket, QqBotTransport } from "./adapter.js";

/** 工厂依赖；所有项都可选，便于测试注入。 */
export interface NodeQqBotTransportDeps {
  /**
   * ws 包风格的 WebSocket 构造器（`new Impl(url, { headers })`）。
   * 缺省时使用顶层静态导入的 `ws` 构造器（已随 host bundle 打进产物）。
   */
  WebSocketImpl?: unknown;
  /** post 超时（毫秒）；缺省 15000，<=0 时取缺省。 */
  timeoutMs?: number;
  /** 保留字段：与 adapter 工厂签名一致的注入时钟（transport 本身不读时间）。 */
  now?: () => number;
}

export const DEFAULT_QQBOT_HTTP_TIMEOUT_MS = 15_000;

/**
 * OpenAPI 非 2xx 错误：携带 HTTP status 供适配器分类重试。
 *
 * 旧实现只抛一个没有 status 的普通 Error，适配器只能一律按「可重试」处理；
 * 4xx（参数非法 / 消息被拒 / 鉴权失败）因此会被上层重试 3 轮，每轮都注定
 * 失败。错误文本仍只带 method / path / status，绝不回显响应体。
 */
export class QqBotHttpError extends Error {
  readonly status: number;
  /** 平台业务错误码（响应体 code/errcode/retcode），仅用于诊断。 */
  readonly code?: number;
  /** 平台业务错误文案（已截断），仅用于诊断；token 端点不会带上它。 */
  readonly businessMessage?: string;

  constructor(
    status: number,
    path: string,
    detail?: { code?: number; message?: string },
  ) {
    const pieces: string[] = [];
    if (detail?.code !== undefined) pieces.push(`code ${detail.code}`);
    if (detail?.message) pieces.push(detail.message);
    const suffix = pieces.length > 0 ? ` (${pieces.join(": ")})` : "";
    super(`QQBot: HTTP ${status} from ${path}${suffix}`);
    this.name = "QqBotHttpError";
    this.status = status;
    if (detail?.code !== undefined) this.code = detail.code;
    if (detail?.message) this.businessMessage = detail.message;
  }
}

/** 只列本模块实际用到的 ws 能力；注入的假实现也按此形状鸭子类型识别。 */
interface WsLike {
  readyState?: number;
  on?: (event: string, listener: (arg?: unknown) => void) => unknown;
  addEventListener?: (event: string, listener: (event?: unknown) => void) => unknown;
  send: (data: string) => unknown;
  close: () => unknown;
  /** ws 的强制关闭；连接超时用它兜底（可能不存在，测试假实现可省略）。 */
  terminate?: () => unknown;
}

type WsCtor = new (url: string, options?: { headers?: Record<string, string> }) => WsLike;

function toError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  const text = typeof value === "string" && value.length > 0 ? value : fallback;
  return new Error(text);
}

/** 诊断文案截断上限：错误信息只用于区分限流 / 白名单 / 额度，不搬运整段响应体。 */
const MAX_HTTP_DIAG_CHARS = 200;

/**
 * 从非 2xx 响应体里提炼诊断信息。
 *
 * 平台把「限流 / 白名单 / 额度耗尽 / 参数非法」都塞在响应体的 `code` 与
 * `message` 里；旧实现只报 HTTP status，上层无法区分这些语义。这里**只取**
 * 错误码与文案，且截断到 {@link MAX_HTTP_DIAG_CHARS}，绝不回显原始 body
 * （token 端点连这个函数都不会调用，见 post 的端点判定）。
 */
function describeHttpFailureBody(text: string): { code?: number; message?: string } | undefined {
  if (text.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const detail: { code?: number; message?: string } = {};
  for (const key of ["code", "errcode", "retcode"] as const) {
    const value = record[key];
    const numeric =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim() !== ""
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(numeric) && numeric !== 0) {
      detail.code = numeric;
      break;
    }
  }
  for (const key of ["message", "msg", "errmsg", "error"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      const trimmed = value.trim();
      detail.message =
        trimmed.length > MAX_HTTP_DIAG_CHARS ? `${trimmed.slice(0, MAX_HTTP_DIAG_CHARS)}…` : trimmed;
      break;
    }
  }
  return detail.code === undefined && detail.message === undefined ? undefined : detail;
}

/**
 * token 端点判定：其错误响应体可能回显 clientSecret / access_token，绝不能
 * 把业务码文案拼进错误（连 `message` 也可能是凭据回显）。发消息端点则相反
 * ——没有诊断信息就无法区分限流 / 白名单 / 额度。
 */
function isTokenEndpoint(pathname: string): boolean {
  return pathname.includes("getAppAccessToken");
}

function resolveCtor(injected: unknown): WsCtor {
  const ctor = injected !== undefined ? injected : WebSocket;
  if (typeof ctor !== "function") {
    throw new Error("QQBot: WebSocket 构造器不可用（请注入 WebSocketImpl）");
  }
  return ctor as WsCtor;
}

/** 注册底层事件；同时兼容 ws 的 `.on` 与 whatwg 的 `addEventListener`。 */
function attach(
  ws: WsLike,
  event: string,
  listener: (arg?: unknown) => void,
): void {
  if (typeof ws.on === "function") {
    ws.on(event, (arg?: unknown) => listener(arg));
    return;
  }
  if (typeof ws.addEventListener === "function") {
    ws.addEventListener(event, (ev?: unknown) => {
      if (event === "message" && ev !== null && typeof ev === "object") {
        listener((ev as { data?: unknown })["data"]);
      } else {
        listener(ev);
      }
    });
  }
}

/** 把一帧落地数据归一成 adapter 认识的形态：JSON 文本解析、对象直通。 */
function normalizeFrame(data: unknown): unknown {
  if (Buffer.isBuffer(data)) {
    const text = data.toString("utf8");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  if (typeof data === "string") {
    try {
      return JSON.parse(data) as unknown;
    } catch {
      return data;
    }
  }
  return data;
}

/** 把底层 ws 包成 M2 的 QqBotSocket；早到的帧先缓冲，等 onMessage 注册后补发。 */
function wrapSocket(ws: WsLike): QqBotSocket {
  let handler: ((raw: unknown) => void) | undefined;
  const pending: unknown[] = [];
  let closeHandler: ((error?: unknown) => void) | undefined;
  let closeFired = false;
  let closeArg: unknown;

  attach(ws, "message", (arg?: unknown) => {
    const raw = normalizeFrame(arg);
    if (handler) handler(raw);
    else pending.push(raw);
  });

  // 底层断开通知：ws 的 "close" 与 "error" 都可能是终态（网络断开时 ws 通常
  // 先 error 后 close），只上报一次；open 之前的 error 归于 buildSocket 的
  // reject 路径，不会让已 resolve 的 socket 收到（那时尚无 closeHandler）。
  const fireClose = (arg?: unknown): void => {
    if (closeFired) return;
    closeFired = true;
    closeArg = arg;
    closeHandler?.(arg);
  };
  attach(ws, "close", (arg?: unknown) => fireClose(arg));
  attach(ws, "error", (arg?: unknown) => fireClose(arg));

  return {
    onMessage(cb: (raw: unknown) => void): void {
      handler = cb;
      if (pending.length > 0) {
        const buffered = pending.splice(0, pending.length);
        for (const raw of buffered) cb(raw);
      }
    },
    onClose(cb: (error?: unknown) => void): void {
      closeHandler = cb;
      if (closeFired) cb(closeArg);
    },
    send(data: unknown): void {
      ws.send(JSON.stringify(data));
    },
    close(): void {
      ws.close();
    },
  };
}

function buildSocket(
  injected: unknown,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<QqBotSocket> {
  let Ctor: WsCtor;
  try {
    Ctor = resolveCtor(injected);
  } catch (error) {
    return Promise.reject(toError(error, "QQBot: WebSocket 构造器不可用"));
  }
  let ws: WsLike;
  try {
    ws = new Ctor(url, { headers });
  } catch (error) {
    return Promise.reject(toError(error, "QQBot: WebSocket 建连失败"));
  }

  // 尽早挂 message，避免 open 与首个 Hello 同帧到达时丢帧。
  const socket = wrapSocket(ws);
  return new Promise<QqBotSocket>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(toError(error, "QQBot: WebSocket 打开失败"));
    };

    attach(ws, "error", (arg?: unknown) => fail(arg));
    attach(ws, "open", () => succeed());

    // 连接超时：TCP/TLS 挂住或对端不回 101 时必须失败，否则 connect() 永久
    // pending（宿主侧会一直停在「连接中」）。terminate 兜底关闭底层连接，
    // 避免超时 reject 之后仍留着一条会自己重连/占句柄的 socket。
    timer = setTimeout(() => {
      timer = undefined;
      fail(new Error(`QQBot: WebSocket 连接超时（${timeoutMs}ms）`));
      try {
        if (typeof ws.terminate === "function") ws.terminate();
        else ws.close();
      } catch {
        // 关闭失败不影响已 reject 的结果
      }
    }, timeoutMs);
    timer.unref?.();

    // 同步 open（构造器内即触发，或 fake 起始就是 OPEN）用 readyState 兜底。
    if (ws.readyState === 1) succeed();
  });
}

/**
 * 构造 node 侧真实 transport。
 *
 * `post` 用 node:http(s) 直连而非全局 fetch（扩展宿主 patch 了 fetch，SOCKS /
 * 无 scheme 代理会抛 Invalid URL protocol）；仅 2xx 解析 JSON。
 */
export function createNodeQqBotTransport(deps: NodeQqBotTransportDeps = {}): QqBotTransport {
  const injected = deps.WebSocketImpl;
  const timeoutMs =
    typeof deps.timeoutMs === "number" && deps.timeoutMs > 0
      ? deps.timeoutMs
      : DEFAULT_QQBOT_HTTP_TIMEOUT_MS;

  return {
    connect(url: string, headers: Record<string, string>): Promise<QqBotSocket> {
      return buildSocket(injected, url, headers, timeoutMs);
    },

    async post(
      endpoint: string,
      headers: Record<string, string>,
      body: Record<string, unknown>,
    ): Promise<unknown> {
      const url = new URL(endpoint);
      const https = url.protocol === "https:";
      if (!https && url.protocol !== "http:") {
        throw new Error(`QQBot: 不支持的协议 ${url.protocol}`);
      }
      const payload = JSON.stringify(body);
      const options: RequestOptions = {
        method: "POST",
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: `${url.pathname}${url.search}`,
        headers: {
          ...headers,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      };

      return new Promise<unknown>((resolve, reject) => {
        const send = https ? httpsRequest : httpRequest;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;

        /** 响应流中途断开：与「请求超时」区分，避免把对端断开误报成超时。 */
        let responseBroken = false;

        const req = send(options, (res) => {
          const chunks: Buffer[] = [];
          const clearTimer = (): void => {
            if (timer !== undefined) {
              clearTimeout(timer);
              timer = undefined;
            }
          };
          res.on("data", (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          // 响应尚未读完就断开（对端 reset / 代理中断）：必须显式失败，否则
          // 只靠 req 的 "error" 会拿到一个语焉不详的 ECONNRESET，甚至被上层
          // 误读成「超时」。这里给出可区分的「响应中断」文案。
          res.on("error", (error: Error) => {
            responseBroken = true;
            clearTimer();
            reject(new Error(`QQBot: 响应中断 from ${url.pathname}: ${error.message}`));
          });
          res.on("aborted", () => {
            responseBroken = true;
            clearTimer();
            reject(new Error(`QQBot: 响应中断（连接被对端提前关闭）: ${url.pathname}`));
          });
          res.on("end", () => {
            clearTimer();
            const status = res.statusCode ?? 0;
            const text = Buffer.concat(chunks).toString("utf8");
            if (status < 200 || status >= 300) {
              // token 端点绝不回显响应体（可能含 access_token / clientSecret）；
              // 发消息端点回显业务 code/message，才能区分限流 / 白名单 / 额度。
              const detail = isTokenEndpoint(url.pathname)
                ? undefined
                : describeHttpFailureBody(text);
              reject(new QqBotHttpError(status, url.pathname, detail));
              return;
            }
            if (text.trim() === "") {
              resolve(undefined);
              return;
            }
            try {
              resolve(JSON.parse(text) as unknown);
            } catch {
              reject(new Error(`QQBot: 响应不是合法 JSON from ${url.pathname}`));
            }
          });
        });

        req.on("error", (error: Error) => {
          if (timer !== undefined) clearTimeout(timer);
          if (timedOut) {
            reject(new Error(`QQBot: 请求超时（${timeoutMs}ms）: ${url.pathname}`));
          } else if (responseBroken) {
            // res 通道已经给出更准确的「响应中断」，这里不覆盖它。
            return;
          } else {
            reject(error);
          }
        });

        timer = setTimeout(() => {
          timedOut = true;
          req.destroy(new Error(`QQBot: 请求超时（${timeoutMs}ms）: ${url.pathname}`));
        }, timeoutMs);
        timer.unref?.();

        req.end(payload);
      });
    },
  };
}
