import { randomBytes } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { signBody, verifySignedRequest } from "../src/qq/ipc.js";
import {
  createDeliveryServer,
  type DeliveryMessage,
  type DeliveryServer,
} from "../src/qq/bridge/delivery-server.js";
import { createHostClient } from "../src/qq/bridge/host-client.js";
import {
  createOneBotSink,
  type OneBotSink,
  type OneBotSinkOptions,
} from "../src/qq/bridge/onebot-sink.js";
import type { InboundMessage } from "../src/qq/adapter/types.js";

const TOKEN = "test-token";
const SECRET = "test-secret";

const sinks: OneBotSink[] = [];
const deliveries: DeliveryServer[] = [];
const rawServers: http.Server[] = [];

afterEach(async () => {
  while (sinks.length > 0) await sinks.pop()!.close();
  while (deliveries.length > 0) await deliveries.pop()!.close();
  while (rawServers.length > 0) {
    const server = rawServers.pop()!;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    });
  }
});

interface RequestOptions {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

interface ResponseResult {
  status: number;
  body: string;
  json: Record<string, unknown> | null;
}

function request(port: number, options: RequestOptions): Promise<ResponseResult> {
  return new Promise<ResponseResult>((resolve, reject) => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.body !== undefined) {
      headers["content-length"] = String(Buffer.byteLength(options.body));
    }
    const req = http.request(
      { host: "127.0.0.1", port, method: options.method, path: options.path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let json: Record<string, unknown> | null = null;
          try {
            const parsed = body.length > 0 ? (JSON.parse(body) as unknown) : null;
            json = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, body, json });
        });
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

interface AuthOverrides {
  timestamp?: number;
  nonce?: string;
  token?: string;
  signature?: string;
}

function authHeaders(body: string, overrides: AuthOverrides = {}): Record<string, string> {
  const timestamp = overrides.timestamp ?? Date.now();
  const nonce = overrides.nonce ?? randomBytes(8).toString("hex");
  return {
    authorization: `Bearer ${overrides.token ?? TOKEN}`,
    "x-timestamp": String(timestamp),
    "x-nonce": nonce,
    "x-signature": overrides.signature ?? signBody(body, SECRET, timestamp, nonce),
    "content-type": "application/json",
  };
}

// ---------------------------------------------------------------------------
// 假宿主：用真实的 verifySignedRequest 验收 bridge 的签名头
// ---------------------------------------------------------------------------

interface FakeHost {
  port: number;
  captured: Array<{ body: unknown }>;
}

async function startFakeHost(options: { status?: number } = {}): Promise<FakeHost> {
  const nonces = new Map<string, number>();
  const captured: Array<{ body: unknown }> = [];
  const status = options.status ?? 200;
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method !== "POST" || url.pathname !== "/v1/events") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, code: "not_found" }));
        return;
      }
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      const verification = await verifySignedRequest(req, {
        token: TOKEN,
        hmacSecret: SECRET,
        nonces,
      });
      if (!verification.ok) {
        res.writeHead(verification.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, code: verification.code }));
        return;
      }
      captured.push({ body: verification.payload });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    })().catch(() => {
      try {
        res.writeHead(500);
        res.end();
      } catch {
        // 连接已断，忽略。
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  rawServers.push(server);
  return { port: (server.address() as AddressInfo).port, captured };
}

async function startSink(overrides: Partial<OneBotSinkOptions> = {}): Promise<{
  sink: OneBotSink;
  events: InboundMessage[];
}> {
  const events: InboundMessage[] = [];
  const sink = await createOneBotSink({
    port: 0,
    token: TOKEN,
    selfId: "10000",
    onEvent: (event) => {
      events.push(event);
    },
    ...overrides,
  });
  sinks.push(sink);
  return { sink, events };
}

async function startDelivery(): Promise<{ server: DeliveryServer; delivered: DeliveryMessage[] }> {
  const delivered: DeliveryMessage[] = [];
  const server = await createDeliveryServer({
    port: 0,
    token: TOKEN,
    hmacSecret: SECRET,
    onDeliver: (message) => {
      delivered.push(message);
    },
  });
  deliveries.push(server);
  return { server, delivered };
}

describe("host-client", () => {
  it("把事件体与可验签的鉴权头投递给假宿主", async () => {
    const host = await startFakeHost();
    const client = createHostClient({ hostPort: host.port, bridgeToken: TOKEN, hmacSecret: SECRET });
    const payload = { type: "bridge_ready", incomingPort: 4321, pid: 99, startedAt: 1_700_000_000_000 };

    const result = await client.postEvents(payload);

    expect(result).toEqual({ ok: true, status: 200 });
    expect(host.captured).toEqual([{ body: payload }]);
  });

  it("5xx 返回 { ok:false, status } 且不抛错", async () => {
    const host = await startFakeHost({ status: 503 });
    const client = createHostClient({ hostPort: host.port, bridgeToken: TOKEN, hmacSecret: SECRET });

    const result = await client.postEvents({ type: "x" });

    expect(result).toEqual({ ok: false, status: 503 });
  });

  it("宿主不可达时返回 status 0 且不抛错", async () => {
    const client = createHostClient({ hostPort: 1, bridgeToken: TOKEN, hmacSecret: SECRET, timeoutMs: 500 });
    const result = await client.postEvents({ type: "x" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
  });
});

describe("onebot-sink", () => {
  it("只监听 127.0.0.1", async () => {
    const { sink } = await startSink();
    const address = sink.server.address();
    expect(typeof address).not.toBe("string");
    expect((address as AddressInfo).address).toBe("127.0.0.1");
  });

  it("缺失 token → 401", async () => {
    const { sink, events } = await startSink();
    const res = await request(sink.port, {
      method: "POST",
      path: "/onebot/event",
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(events).toEqual([]);
  });

  it("错误 token → 401", async () => {
    const { sink, events } = await startSink();
    const res = await request(sink.port, {
      method: "POST",
      path: "/onebot/event",
      headers: { authorization: `Bearer wrong-${TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(events).toEqual([]);
  });

  it("坏 JSON → 400", async () => {
    const { sink, events } = await startSink();
    const res = await request(sink.port, {
      method: "POST",
      path: "/onebot/event",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
    expect(res.json?.code).toBe("bad_request");
    expect(events).toEqual([]);
  });

  it("超过 1MB 的 body → 413", async () => {
    const { sink, events } = await startSink();
    const body = JSON.stringify({ data: "x".repeat(1024 * 1024 + 16) });
    const res = await request(sink.port, {
      method: "POST",
      path: "/onebot/event",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(413);
    expect(res.json?.code).toBe("payload_too_large");
    expect(events).toEqual([]);
  });

  it("notice 事件 → 204 且不回调", async () => {
    const { sink, events } = await startSink();
    const res = await request(sink.port, {
      method: "POST",
      path: "/onebot/event",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ post_type: "notice", notice_type: "group_increase" }),
    });
    expect(res.status).toBe(204);
    expect(events).toEqual([]);
  });

  it("正常 message → 204 且回调收到归一化对象", async () => {
    const { sink, events } = await startSink();
    const raw = {
      post_type: "message",
      message_type: "private",
      user_id: 123456,
      message_id: 77,
      time: 1_700_000_000,
      sender: { user_id: 123456 },
      message: [{ type: "at", data: { qq: "10000" } }, { type: "text", data: { text: " hello" } }],
    };

    const res = await request(sink.port, {
      method: "POST",
      path: "/onebot/event",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(raw),
    });

    expect(res.status).toBe(204);
    expect(events).toEqual([
      {
        chatType: "private",
        chatId: "123456",
        senderId: "123456",
        msgId: "77",
        text: "hello",
        mentionsBot: true,
        attachments: [],
        timestamp: 1_700_000_000_000,
      },
    ]);
  });
});

describe("delivery-server", () => {
  it("正签名投递 → 204 且回调收到消息", async () => {
    const { server, delivered } = await startDelivery();
    const message = { chatType: "group", chatId: "555", text: "任务完成", replyToMsgId: "42" };
    const body = JSON.stringify(message);

    const res = await request(server.port, {
      method: "POST",
      path: "/v1/deliver",
      headers: authHeaders(body),
      body,
    });

    expect(res.status).toBe(204);
    expect(delivered).toEqual([message]);
  });

  it("同一 nonce 重放 → 409", async () => {
    const { server, delivered } = await startDelivery();
    const body = JSON.stringify({ chatType: "private", chatId: "1", text: "hi" });
    const headers = authHeaders(body, { nonce: "fixed-nonce" });

    const first = await request(server.port, { method: "POST", path: "/v1/deliver", headers, body });
    expect(first.status).toBe(204);

    const second = await request(server.port, { method: "POST", path: "/v1/deliver", headers, body });
    expect(second.status).toBe(409);
    expect(second.json?.code).toBe("replayed");
    expect(delivered).toHaveLength(1);
  });

  it("过期时间戳 → 401", async () => {
    const { server, delivered } = await startDelivery();
    const body = JSON.stringify({ chatType: "private", chatId: "1", text: "hi" });
    const res = await request(server.port, {
      method: "POST",
      path: "/v1/deliver",
      headers: authHeaders(body, { timestamp: Date.now() - 60_000 }),
      body,
    });
    expect(res.status).toBe(401);
    expect(res.json?.code).toBe("stale_timestamp");
    expect(delivered).toEqual([]);
  });

  it("错误签名 → 401", async () => {
    const { server, delivered } = await startDelivery();
    const body = "{}";
    const res = await request(server.port, {
      method: "POST",
      path: "/v1/deliver",
      headers: authHeaders(body, { signature: "0".repeat(64) }),
      body,
    });
    expect(res.status).toBe(401);
    expect(res.json?.code).toBe("bad_signature");
    expect(delivered).toEqual([]);
  });

  it("health → 200 且带 uptimeMs", async () => {
    const { server } = await startDelivery();
    const res = await request(server.port, { method: "GET", path: "/v1/health" });
    expect(res.status).toBe(200);
    expect(res.json?.ok).toBe(true);
    expect(typeof res.json?.uptimeMs).toBe("number");
  });
});
