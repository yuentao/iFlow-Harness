import { randomBytes } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQqIpcServer,
  signBody,
  type QqIpcHandlers,
  type QqIpcServer,
} from "../src/qq/ipc.js";

const TOKEN = "test-token";
const SECRET = "test-secret";

const running: QqIpcServer[] = [];

afterEach(async () => {
  while (running.length > 0) {
    const server = running.pop()!;
    await server.close();
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

interface HandlerCalls {
  calls: Array<{ kind: string; body?: unknown; taskId?: string }>;
}

function makeHandlers(): QqIpcHandlers & HandlerCalls {
  const calls: HandlerCalls["calls"] = [];
  return {
    calls,
    onEvents: async (body) => {
      calls.push({ kind: "events", body });
      return { accepted: true };
    },
    onDeliver: async (body) => {
      calls.push({ kind: "deliver", body });
      return { delivered: true };
    },
    onTaskAction: async (taskId, body) => {
      calls.push({ kind: "task", taskId, body });
      return { handled: true };
    },
    onHealth: async () => {
      calls.push({ kind: "health" });
      return { alive: true };
    },
  };
}

async function start(handlers: QqIpcHandlers = makeHandlers()): Promise<QqIpcServer> {
  const server = await createQqIpcServer({ port: 0, token: TOKEN, hmacSecret: SECRET, handlers });
  running.push(server);
  return server;
}

describe("signBody", () => {
  it("产出 hex HMAC-SHA256，且同一原始体得到同一签名", () => {
    const first = signBody('{"a":1}', SECRET, 1_700_000_000_000, "nonce-1");
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(signBody('{"a":1}', SECRET, 1, "nonce-2")).toBe(first);
    expect(signBody('{"a":2}', SECRET, 1_700_000_000_000, "nonce-1")).not.toBe(first);
  });
});

describe("QqIpcServer — 鉴权", () => {
  it("签名正确的请求返回 200，处理器收到解析后的 JSON", async () => {
    const handlers = makeHandlers();
    const server = await start(handlers);
    const body = JSON.stringify({ type: "message", text: "hi" });

    const res = await request(server.port, {
      method: "POST",
      path: "/v1/events",
      headers: authHeaders(body),
      body,
    });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, data: { accepted: true } });
    expect(handlers.calls).toEqual([{ kind: "events", body: { type: "message", text: "hi" } }]);
  });

  it("health 走 GET 且空 body 也要签名", async () => {
    const handlers = makeHandlers();
    const server = await start(handlers);

    const res = await request(server.port, {
      method: "GET",
      path: "/v1/health",
      headers: authHeaders(""),
    });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, data: { alive: true } });
    expect(handlers.calls).toEqual([{ kind: "health" }]);
  });

  it("health 同样需要鉴权", async () => {
    const server = await start();
    const res = await request(server.port, { method: "GET", path: "/v1/health" });
    expect(res.status).toBe(401);
    expect(res.json?.code).toBe("unauthorized");
  });

  it("token 错误返回 401 unauthorized", async () => {
    const server = await start();
    const body = "{}";
    const res = await request(server.port, {
      method: "POST",
      path: "/v1/events",
      headers: authHeaders(body, { token: "wrong-token" }),
      body,
    });
    expect(res.status).toBe(401);
    expect(res.json?.code).toBe("unauthorized");
  });

  it("签名错误返回 401 bad_signature", async () => {
    const server = await start();
    const body = "{}";
    const res = await request(server.port, {
      method: "POST",
      path: "/v1/events",
      headers: authHeaders(body, { signature: "0".repeat(64) }),
      body,
    });
    expect(res.status).toBe(401);
    expect(res.json?.code).toBe("bad_signature");
  });

  it("时间戳过期返回 401 stale_timestamp", async () => {
    const server = await start();
    const body = "{}";
    const res = await request(server.port, {
      method: "POST",
      path: "/v1/events",
      headers: authHeaders(body, { timestamp: Date.now() - 60_000 }),
      body,
    });
    expect(res.status).toBe(401);
    expect(res.json?.code).toBe("stale_timestamp");
  });

  it("同一 nonce 重放返回 409 replayed", async () => {
    const server = await start();
    const body = "{}";
    const headers = authHeaders(body, { nonce: "fixed-nonce" });

    const first = await request(server.port, { method: "POST", path: "/v1/events", headers, body });
    expect(first.status).toBe(200);

    const second = await request(server.port, { method: "POST", path: "/v1/events", headers, body });
    expect(second.status).toBe(409);
    expect(second.json?.code).toBe("replayed");
  });
});

describe("QqIpcServer — 路由与边界", () => {
  it("未知路由返回 404", async () => {
    const server = await start();
    const body = "{}";
    const res = await request(server.port, {
      method: "POST",
      path: "/v1/nope",
      headers: authHeaders(body),
      body,
    });
    expect(res.status).toBe(404);
    expect(res.json?.code).toBe("not_found");
  });

  it("任务操作路由把路径里的 taskId 交给处理器", async () => {
    const handlers = makeHandlers();
    const server = await start(handlers);
    const body = JSON.stringify({ action: "cancel" });

    const res = await request(server.port, {
      method: "POST",
      path: "/v1/tasks/task-42/action",
      headers: authHeaders(body),
      body,
    });

    expect(res.status).toBe(200);
    expect(handlers.calls).toEqual([
      { kind: "task", taskId: "task-42", body: { action: "cancel" } },
    ]);
  });

  it("deliver 路由走 onDeliver", async () => {
    const handlers = makeHandlers();
    const server = await start(handlers);
    const body = JSON.stringify({ msgId: "1", ok: true });

    const res = await request(server.port, {
      method: "POST",
      path: "/v1/deliver",
      headers: authHeaders(body),
      body,
    });

    expect(res.status).toBe(200);
    expect(handlers.calls[0]).toEqual({ kind: "deliver", body: { msgId: "1", ok: true } });
  });

  it("超过 1MB 的 body 返回 413", async () => {
    const handlers = makeHandlers();
    const server = await start(handlers);
    const body = JSON.stringify({ data: "x".repeat(1024 * 1024 + 16) });

    const res = await request(server.port, {
      method: "POST",
      path: "/v1/events",
      headers: authHeaders(body),
      body,
    });

    expect(res.status).toBe(413);
    expect(res.json?.code).toBe("payload_too_large");
    expect(handlers.calls).toEqual([]);
  });

  it("处理器抛错返回 500 且不泄露错误信息", async () => {
    const handlers: QqIpcHandlers = {
      onEvents: async () => {
        throw new Error("secret-internal-detail");
      },
      onDeliver: async () => null,
      onTaskAction: async () => null,
      onHealth: async () => null,
    };
    const server = await start(handlers);
    const body = "{}";

    const res = await request(server.port, {
      method: "POST",
      path: "/v1/events",
      headers: authHeaders(body),
      body,
    });

    expect(res.status).toBe(500);
    expect(res.json?.code).toBe("internal_error");
    expect(res.body).not.toContain("secret-internal-detail");
  });
});

describe("QqIpcServer — 生命周期", () => {
  it("只监听 127.0.0.1", async () => {
    const server = await start();
    const address = server.server.address();
    expect(address).not.toBeNull();
    expect(typeof address).not.toBe("string");
    expect((address as AddressInfo).address).toBe("127.0.0.1");
    expect(server.port).toBe((address as AddressInfo).port);
  });

  it("close() 之后端口释放", async () => {
    const server = await start();
    const port = server.port;
    await server.close();

    await expect(
      request(port, { method: "GET", path: "/v1/health", headers: authHeaders("") }),
    ).rejects.toBeTruthy();
  });

  it("close() 可重复调用", async () => {
    const server = await start();
    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
  });
});
