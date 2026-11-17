/**
 * M3-B：node 侧真实 QQBot transport 的单测。
 *
 * 纪律：不起真实网关、不依赖 ws 是否已安装——所有 WebSocket 用注入的假实现，
 * HTTP 用本机临时 server；access token 只作为断言值出现，不打印到日志。
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { QqBotSocket } from "../src/qq/qqbot/adapter.js";
import {
  createNodeQqBotTransport,
  DEFAULT_QQBOT_HTTP_TIMEOUT_MS,
} from "../src/qq/qqbot/ws-transport.js";

/** ws 包风格的最小假实现：记录构造参数、手动触发事件。 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly headers: Record<string, string>;
  readonly sent: string[] = [];
  closed = false;
  readyState = 0;
  private readonly listeners = new Map<string, Array<(arg?: unknown) => void>>();

  constructor(url: string, options?: { headers?: Record<string, string> }) {
    this.url = url;
    this.headers = options?.headers ?? {};
    FakeWebSocket.instances.push(this);
  }

  on(event: string, cb: (arg?: unknown) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
  }

  emit(event: string, arg?: unknown): void {
    for (const cb of [...(this.listeners.get(event) ?? [])]) cb(arg);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }

  static reset(): void {
    FakeWebSocket.instances.length = 0;
  }
}

const servers: http.Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    });
  }
  FakeWebSocket.reset();
});

async function connectFake(
  headers: Record<string, string> = { Authorization: "QQBot fake-token" },
): Promise<{ socket: QqBotSocket; ws: FakeWebSocket }> {
  FakeWebSocket.reset();
  const transport = createNodeQqBotTransport({ WebSocketImpl: FakeWebSocket });
  const pending = transport.connect("wss://api.sgroup.qq.com/websocket", headers);
  const ws = FakeWebSocket.instances[0];
  if (!ws) throw new Error("fake WebSocket 未被构造");
  ws.open();
  return { socket: await pending, ws };
}

interface CapturedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Reply {
  status: number;
  body?: string;
}

async function startPostServer(
  responder: (req: CapturedRequest) => Reply | Promise<Reply>,
): Promise<{ baseUrl: string; captured: CapturedRequest[] }> {
  const captured: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const record: CapturedRequest = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      captured.push(record);
      const reply = await responder(record);
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(reply.body ?? "");
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => resolve());
    server.listen(0, "127.0.0.1");
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return { baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`, captured };
}

describe("createNodeQqBotTransport.connect", () => {
  it("用注入的构造器建连，原样透传 url 与 headers，open 后 resolve", async () => {
    const headers = { Authorization: "QQBot fake-token", "X-Trace": "t-1" };
    const { socket, ws } = await connectFake(headers);
    expect(ws.url).toBe("wss://api.sgroup.qq.com/websocket");
    expect(ws.headers).toEqual(headers);
    expect(socket).toBeDefined();
  });

  it("onMessage 转发对象帧、解析 JSON 文本帧，并补发早到帧", async () => {
    const { socket, ws } = await connectFake();
    const seen: unknown[] = [];

    // 早于 onMessage 注册的帧（真实网关可能 open 后立即推 Hello）先缓冲。
    const hello = { op: 10, d: { heartbeat_interval: 41_250 } };
    ws.emit("message", hello);

    socket.onMessage((raw) => seen.push(raw));
    expect(seen).toEqual([hello]);

    ws.emit("message", '{"op":0,"t":"C2C_MESSAGE_CREATE","s":7}');
    expect(seen[1]).toEqual({ op: 0, t: "C2C_MESSAGE_CREATE", s: 7 });

    const ack = { op: 11 };
    ws.emit("message", ack);
    expect(seen[2]).toBe(ack);

    ws.emit("message", "not-json-text");
    expect(seen[3]).toBe("not-json-text");
  });

  it("send 把载荷序列化成 JSON 字符串，close 关闭底层连接且可重复调用", async () => {
    const { socket, ws } = await connectFake();
    socket.send({ op: 1, d: null });
    expect(ws.sent).toEqual(['{"op":1,"d":null}']);

    socket.send({ op: 2, d: { token: "QQBot fake-token" } });
    expect(JSON.parse(ws.sent[1]!)).toEqual({
      op: 2,
      d: { token: "QQBot fake-token" },
    });

    socket.close();
    socket.close();
    expect(ws.closed).toBe(true);
  });

  it("构造器不可用（非函数）时 reject 而不是同步抛错", async () => {
    const transport = createNodeQqBotTransport({ WebSocketImpl: {} });
    await expect(
      transport.connect("wss://api.sgroup.qq.com/websocket", {}),
    ).rejects.toThrow(/构造器不可用/);
  });
});

describe("createNodeQqBotTransport.post", () => {
  it("POST JSON 到 endpoint，仅 2xx 解析 JSON，并带调用方 headers", async () => {
    const { baseUrl, captured } = await startPostServer(() => ({
      status: 200,
      body: JSON.stringify({ access_token: "fake-token", expires_in: 7200 }),
    }));
    const transport = createNodeQqBotTransport();
    const result = await transport.post(
      `${baseUrl}/app/getAppAccessToken`,
      { "content-type": "application/json", Authorization: "QQBot fake-token" },
      { appId: "app", clientSecret: "secret" },
    );

    expect(result).toEqual({ access_token: "fake-token", expires_in: 7200 });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.path).toBe("/app/getAppAccessToken");
    expect(captured[0]?.headers.authorization).toBe("QQBot fake-token");
    expect(String(captured[0]?.headers["content-type"])).toContain("application/json");
    expect(captured[0]?.body).toBe(JSON.stringify({ appId: "app", clientSecret: "secret" }));
  });

  it("204 空响应体解析为 undefined", async () => {
    const { baseUrl } = await startPostServer(() => ({ status: 204 }));
    const transport = createNodeQqBotTransport();
    await expect(transport.post(`${baseUrl}/empty`, {}, {})).resolves.toBeUndefined();
  });

  it("非 2xx reject，且错误文本不回显响应体（避免凭据泄漏）", async () => {
    const { baseUrl } = await startPostServer(() => ({
      status: 500,
      body: "secret-body-should-not-leak",
    }));
    const transport = createNodeQqBotTransport();
    await expect(transport.post(`${baseUrl}/fail`, {}, {})).rejects.toThrow(/HTTP 500/);
    await expect(transport.post(`${baseUrl}/fail`, {}, {})).rejects.not.toThrow(
      /secret-body-should-not-leak/,
    );
  });

  it("2xx 但不是合法 JSON 时 reject", async () => {
    const { baseUrl } = await startPostServer(() => ({ status: 200, body: "not-json" }));
    const transport = createNodeQqBotTransport();
    await expect(transport.post(`${baseUrl}/bad`, {}, {})).rejects.toThrow(/不是合法 JSON/);
  });

  it("超时按注入的 timeoutMs reject（默认常量作为对照）", async () => {
    expect(DEFAULT_QQBOT_HTTP_TIMEOUT_MS).toBeGreaterThan(0);
    // 永不回包，模拟网关/代理挂住。
    const { baseUrl } = await startPostServer(
      () => new Promise<Reply>(() => undefined),
    );
    const transport = createNodeQqBotTransport({ timeoutMs: 40 });
    await expect(transport.post(`${baseUrl}/hang`, {}, {})).rejects.toThrow(/超时/);
  });

  it("非 http(s) 协议直接 reject", async () => {
    const transport = createNodeQqBotTransport();
    await expect(transport.post("ftp://example.com/x", {}, {})).rejects.toThrow(/不支持的协议/);
  });
});
