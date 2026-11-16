import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createBridgeDeliveryClient } from "../src/qq/bridge-client.js";
import type { DeliveryMessage } from "../src/qq/bridge/delivery-server.js";
import { signBody, verifySignedRequest } from "../src/qq/ipc.js";

const TOKEN = "bridge-token";
const SECRET = "bridge-secret";

interface CapturedDelivery {
  message: unknown;
  raw: string;
  headers: http.IncomingHttpHeaders;
}

interface TestServer {
  port: number;
  captured: CapturedDelivery[];
  close(): Promise<void>;
}

const openServers: TestServer[] = [];
const openClients: Array<{ close(): void }> = [];

afterEach(async () => {
  while (openClients.length > 0) openClients.pop()!.close();
  while (openServers.length > 0) await openServers.pop()!.close();
});

function sendJson(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => resolve());
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return (address as AddressInfo).port;
}

function closable(server: http.Server): () => Promise<void> {
  return async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    });
  };
}

/**
 * 真实 http server + `verifySignedRequest` 验签，捕获通过鉴权的投递。
 * `onDeliver` 决定响应形态（默认 204，与 delivery server 一致）。
 */
async function startSignedServer(
  onDeliver: (message: unknown) => { status: number; body?: string } = () => ({ status: 204 }),
): Promise<TestServer> {
  const nonces = new Map<string, number>();
  const captured: CapturedDelivery[] = [];

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/v1/health") {
        sendJson(res, 200, JSON.stringify({ ok: true }));
        return;
      }
      if (req.method !== "POST" || url.pathname !== "/v1/deliver") {
        sendJson(res, 404, JSON.stringify({ ok: false, code: "not_found" }));
        return;
      }
      const verification = await verifySignedRequest(req, {
        token: TOKEN,
        hmacSecret: SECRET,
        nonces,
      });
      if (!verification.ok) {
        sendJson(res, verification.status, JSON.stringify({ ok: false, code: verification.code }));
        return;
      }
      captured.push({
        message: verification.payload,
        raw: verification.raw,
        headers: req.headers,
      });
      const outcome = onDeliver(verification.payload);
      if (outcome.status === 204) {
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
        return;
      }
      sendJson(res, outcome.status, outcome.body ?? "");
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, JSON.stringify({ ok: false, code: "internal_error" }));
      else res.end();
    });
  });

  const port = await listen(server);
  const entry: TestServer = { port, captured, close: closable(server) };
  openServers.push(entry);
  return entry;
}

/** 不验签的桩服务：排空请求体后直接回固定状态与响应体。 */
async function startStubServer(status: number, body: string): Promise<TestServer> {
  const server = http.createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => sendJson(res, status, body));
    req.on("error", () => res.destroy());
  });
  const port = await listen(server);
  const entry: TestServer = { port, captured: [], close: closable(server) };
  openServers.push(entry);
  return entry;
}

/** 拿一个刚被释放的端口（其上没有服务在听）。 */
async function reserveDeadPort(): Promise<number> {
  const placeholder = await startSignedServer();
  await placeholder.close();
  openServers.splice(openServers.indexOf(placeholder), 1);
  return placeholder.port;
}

function makeClient(
  port: number,
  overrides: Partial<Parameters<typeof createBridgeDeliveryClient>[0]> = {},
): ReturnType<typeof createBridgeDeliveryClient> {
  const client = createBridgeDeliveryClient({
    port,
    token: TOKEN,
    hmacSecret: SECRET,
    timeoutMs: 3_000,
    ...overrides,
  });
  openClients.push(client);
  return client;
}

const MESSAGE: DeliveryMessage = {
  chatType: "group",
  chatId: "123456",
  text: "构建完成 ✅\n请查看日志",
  replyToMsgId: "msg-42",
  filePath: "C:\\tmp\\build.log",
};

describe("createBridgeDeliveryClient — deliver", () => {
  it("204 时 ok，且服务端收到完整载荷与可验签的头", async () => {
    const server = await startSignedServer();
    const client = makeClient(server.port);

    const result = await client.deliver(MESSAGE);

    expect(result).toEqual({ ok: true, status: 204 });
    expect(server.captured).toHaveLength(1);

    const captured = server.captured[0]!;
    expect(captured.message).toEqual(MESSAGE);
    // 签名必须覆盖客户端实际发送的原始字节（中文按 UTF-8 计）。
    expect(captured.raw).toBe(JSON.stringify(MESSAGE));

    expect(captured.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(captured.headers["content-type"]).toContain("application/json");
    const timestamp = String(captured.headers["x-timestamp"]);
    const nonce = String(captured.headers["x-nonce"]);
    expect(timestamp).toMatch(/^\d+$/);
    expect(nonce.length).toBeGreaterThan(0);
    expect(captured.headers["x-signature"]).toBe(signBody(captured.raw, SECRET, timestamp, nonce));
  });

  it("token 错误返回 401 且 error 取响应体 code（unauthorized），不 reject", async () => {
    const server = await startSignedServer();
    const client = makeClient(server.port, { token: "wrong-token" });

    const result = await client.deliver(MESSAGE);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toBe("unauthorized");
    expect(server.captured).toHaveLength(0);
  });

  it("同一 nonce 二次投递被判定重放（409 replayed）", async () => {
    const server = await startSignedServer();
    const client = makeClient(server.port, { nonce: () => "fixed-nonce" });

    const first = await client.deliver(MESSAGE);
    const second = await client.deliver(MESSAGE);

    expect(first).toEqual({ ok: true, status: 204 });
    expect(second.ok).toBe(false);
    expect(second.status).toBe(409);
    expect(second.error).toBe("replayed");
    expect(server.captured).toHaveLength(1);
  });

  it("服务端 500 返回 ok:false 且不 reject", async () => {
    const server = await startSignedServer(() => ({
      status: 500,
      body: JSON.stringify({ ok: false, code: "internal_error" }),
    }));
    const client = makeClient(server.port);

    const result = await client.deliver(MESSAGE);

    expect(result).toEqual({ ok: false, status: 500, error: "internal_error" });
  });

  it("响应体读不到 code 时用状态码兜底", async () => {
    const server = await startStubServer(401, "");
    const client = makeClient(server.port);

    const result = await client.deliver(MESSAGE);

    expect(result).toEqual({ ok: false, status: 401, error: "401" });
  });

  it("端口不可达时 status 为 0 且不 reject", async () => {
    const deadPort = await reserveDeadPort();
    const client = makeClient(deadPort, { timeoutMs: 1_500 });

    const result = await client.deliver(MESSAGE);

    expect(result).toEqual({ ok: false, status: 0 });
  });
});

describe("createBridgeDeliveryClient — health", () => {
  it("200 时 ok:true", async () => {
    const server = await startSignedServer();
    const client = makeClient(server.port);

    const result = await client.health();

    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("不可达时 ok:false status 0", async () => {
    const deadPort = await reserveDeadPort();
    const client = makeClient(deadPort, { timeoutMs: 1_500 });

    const result = await client.health();

    expect(result).toEqual({ ok: false, status: 0 });
  });
});

describe("createBridgeDeliveryClient — 生命周期", () => {
  it("close() 可重复调用，之后再次投递不崩", async () => {
    const server = await startSignedServer();
    const client = makeClient(server.port);

    client.close();
    expect(() => client.close()).not.toThrow();

    const result = await client.deliver(MESSAGE);
    expect(typeof result.ok).toBe("boolean");
    expect(typeof result.status).toBe("number");
  });

  it("close() 之后 health 也不崩", async () => {
    const server = await startSignedServer();
    const client = makeClient(server.port);

    client.close();

    const result = await client.health();
    expect(typeof result.ok).toBe("boolean");
    expect(typeof result.status).toBe("number");
  });
});
