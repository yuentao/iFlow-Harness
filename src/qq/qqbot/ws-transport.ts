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

/** 只列本模块实际用到的 ws 能力；注入的假实现也按此形状鸭子类型识别。 */
interface WsLike {
  readyState?: number;
  on?: (event: string, listener: (arg?: unknown) => void) => unknown;
  addEventListener?: (event: string, listener: (event?: unknown) => void) => unknown;
  send: (data: string) => unknown;
  close: () => unknown;
}

type WsCtor = new (url: string, options?: { headers?: Record<string, string> }) => WsLike;

function toError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  const text = typeof value === "string" && value.length > 0 ? value : fallback;
  return new Error(text);
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

  attach(ws, "message", (arg?: unknown) => {
    const raw = normalizeFrame(arg);
    if (handler) handler(raw);
    else pending.push(raw);
  });

  return {
    onMessage(cb: (raw: unknown) => void): void {
      handler = cb;
      if (pending.length > 0) {
        const buffered = pending.splice(0, pending.length);
        for (const raw of buffered) cb(raw);
      }
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
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      resolve(socket);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(toError(error, "QQBot: WebSocket 打开失败"));
    };

    attach(ws, "error", (arg?: unknown) => fail(arg));
    attach(ws, "open", () => succeed());
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
      return buildSocket(injected, url, headers);
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

        const req = send(options, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          res.on("end", () => {
            if (timer !== undefined) clearTimeout(timer);
            const status = res.statusCode ?? 0;
            // 错误文本只带 status/path，不回显响应体（可能含 access_token）。
            if (status < 200 || status >= 300) {
              reject(new Error(`QQBot: HTTP ${status} from ${url.pathname}`));
              return;
            }
            const text = Buffer.concat(chunks).toString("utf8");
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
