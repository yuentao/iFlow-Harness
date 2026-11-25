/**
 * Stability regressions for the host-side MCP broker. All transports are
 * driven by mocked node:http / node:https / node:child_process so handshake
 * failures, dangling timers and runaway buffers can be forced deterministically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { McpBroker } from "../src/acp/mcp-broker.js";

type AnyFn = (...args: any[]) => void;

interface MockEmitter {
  on: (event: string, fn: AnyFn) => unknown;
  once: (event: string, fn: AnyFn) => unknown;
  off: (event: string, fn: AnyFn) => unknown;
}

interface MockRequest extends MockEmitter {
  options: Record<string, any>;
  body?: string;
  destroyed: boolean;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: any[]) => boolean;
}

interface MockResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  setEncoding: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: any[]) => boolean;
}

interface MockServer extends MockEmitter {
  close: ReturnType<typeof vi.fn>;
  listen: ReturnType<typeof vi.fn>;
  address: () => { port: number };
  closeAllConnections: ReturnType<typeof vi.fn>;
}

interface MockChild extends MockEmitter {
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: any[]) => boolean;
  stdin: MockEmitter & { writable: boolean; write: ReturnType<typeof vi.fn>; emit: AnyFn };
  stdout: MockEmitter & { setEncoding: ReturnType<typeof vi.fn>; emit: AnyFn };
  stderr: MockEmitter & { setEncoding: ReturnType<typeof vi.fn>; emit: AnyFn };
}

type Responder = (request: MockRequest, respond: (response: MockResponse) => void) => void;

const mock = vi.hoisted(() => ({
  httpRequests: [] as MockRequest[],
  httpsRequests: [] as MockRequest[],
  servers: [] as MockServer[],
  spawnCalls: [] as MockChild[],
  execFileCalls: [] as string[][],
  autoCloseServer: true as boolean,
  respond: (() => undefined) as Responder,
}));

function makeResponse(status: number, headers: Record<string, string | string[]> = {}): MockResponse {
  return Object.assign(new EventEmitter(), {
    statusCode: status,
    headers,
    setEncoding: vi.fn(),
    resume: vi.fn(),
  }) as unknown as MockResponse;
}

function makeRequest(options: Record<string, any>, bucket: MockRequest[]): MockRequest {
  const request = Object.assign(new EventEmitter(), {
    options,
    destroyed: false,
    end: vi.fn((body?: string) => {
      (request as any).body = body;
      mock.respond(request, (response: MockResponse) => (request as any).emit("__response", response));
    }),
    destroy: vi.fn(() => {
      (request as any).destroyed = true;
    }),
  }) as unknown as MockRequest;
  bucket.push(request);
  return request;
}

vi.mock("node:http", async () => {
  const createServer = (_handler: AnyFn): MockServer => {
    const server = Object.assign(new EventEmitter(), {
      close: vi.fn((cb?: () => void) => {
        if (mock.autoCloseServer) queueMicrotask(() => cb?.());
      }),
      listen: vi.fn((_port: number, _host: string, cb: () => void) => queueMicrotask(cb)),
      address: () => ({ port: 41234 }),
      closeAllConnections: vi.fn(),
    }) as unknown as MockServer;
    mock.servers.push(server);
    return server;
  };
  const request = (options: Record<string, any>, cb: (response: MockResponse) => void): MockRequest => {
    const req = makeRequest(options, mock.httpRequests);
    req.on("__response", cb as AnyFn);
    return req;
  };
  return { createServer, request };
});

vi.mock("node:https", () => {
  const request = (options: Record<string, any>, cb: (response: MockResponse) => void): MockRequest => {
    const req = makeRequest(options, mock.httpsRequests);
    req.on("__response", cb as AnyFn);
    return req;
  };
  return { request };
});

vi.mock("node:child_process", async () => {
  const spawn = vi.fn((): MockChild => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      kill: vi.fn(),
      stdin: Object.assign(new EventEmitter(), { writable: true, write: vi.fn() }),
      stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    }) as unknown as MockChild;
    mock.spawnCalls.push(child);
    return child;
  });
  const execFile = vi.fn(
    (command: string, args: string[], _options: unknown, cb?: () => void): void => {
      mock.execFileCalls.push([command, ...args]);
      cb?.();
    },
  );
  return { spawn, execFile };
});

function killCount(child: MockChild): number {
  return child.kill.mock.calls.length + mock.execFileCalls.length;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

beforeEach(() => {
  mock.httpRequests.length = 0;
  mock.httpsRequests.length = 0;
  mock.servers.length = 0;
  mock.spawnCalls.length = 0;
  mock.execFileCalls.length = 0;
  mock.autoCloseServer = true;
  mock.respond = (request, respond) => {
    const response = makeResponse(500);
    respond(response);
    response.emit("end");
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mcp-broker 稳定性", () => {
  it("S1: stdio 握手失败会关闭底层子进程", async () => {
    const broker = await McpBroker.start({
      servers: { broken: { command: "fake-mcp", args: [] } },
      requestTimeoutMs: 1_000,
    });
    const warm = broker.prewarm();
    const child = mock.spawnCalls[0];
    expect(child).toBeDefined();
    child!.emit("error", new Error("spawn exploded"));
    await warm;

    expect(broker.statuses()[0]?.error).toMatch(/spawn exploded/u);
    expect(killCount(child!)).toBeGreaterThan(0);
    await broker.dispose();
  });

  it("S1: SSE 握手失败会销毁底层请求流", async () => {
    mock.respond = (request, respond) => {
      const response = makeResponse(500);
      respond(response);
      response.emit("end");
    };
    const broker = await McpBroker.start({ servers: { sse: { url: "http://fake.test/sse" } } });
    await broker.prewarm();

    expect(broker.statuses()[0]?.error).toMatch(/HTTP 500/u);
    expect(mock.httpRequests[0]?.destroy).toHaveBeenCalled();
    await broker.dispose();
  });

  it("S2: dispose 幂等可重入，且 server.close 有超时兜底", async () => {
    mock.autoCloseServer = false;
    vi.useFakeTimers();
    const broker = await McpBroker.start({ servers: {} });

    const first = broker.dispose();
    const second = broker.dispose();
    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all([first, second]);

    expect(mock.servers[0]?.close).toHaveBeenCalledTimes(1);
    expect(mock.servers[0]?.closeAllConnections).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("S2: dispose 会关闭仍在握手的 client", async () => {
    mock.respond = () => undefined; // handshake never answers on its own
    const broker = await McpBroker.start({
      servers: { slow: { command: "fake-mcp", args: [] } },
      requestTimeoutMs: 60_000,
    });
    const warm = broker.prewarm();
    const child = mock.spawnCalls[0];
    expect(child).toBeDefined();

    const disposal = broker.dispose();
    // Simulate the killed child exiting so the in-flight promise settles.
    child!.emit("exit", null, "SIGTERM");
    await Promise.all([warm, disposal]);

    expect(killCount(child!)).toBeGreaterThan(0);
    expect(broker.statuses()[0]?.connected).toBe(false);
  });

  it("M3: SSE 累积超长无换行数据被丢弃并上报", async () => {
    const warnings: string[] = [];
    mock.respond = (request, respond) => {
      if (request.options.method === "GET") {
        const response = makeResponse(200, { "content-type": "text/event-stream" });
        respond(response);
        const flood = "x".repeat(5 * 1024 * 1024);
        response.emit("data", flood);
        response.emit("data", flood);
        response.emit("data", "event: endpoint\ndata: http://fake.test/message\n\n");
        // Legacy SSE answers arrive on the stream, not in the POST body.
        setTimeout(() => {
          response.emit(
            "data",
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n\n`,
          );
          setTimeout(() => {
            response.emit(
              "data",
              `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } })}\n\n`,
            );
          }, 0);
        }, 0);
      } else {
        const response = makeResponse(202);
        respond(response);
        response.emit("end");
      }
    };
    const broker = await McpBroker.start({
      servers: { sse: { url: "http://fake.test/sse" } },
      log: (level, message) => {
        if (level === "warn") warnings.push(message);
      },
    });
    await broker.prewarm();

    expect(broker.statuses()[0]?.connected).toBe(true);
    expect(warnings.some((line) => line.includes("8MB"))).toBe(true);
    await broker.dispose();
  });

  it("M3: stdio 单个超长 NDJSON 行被丢弃后仍能解析后续响应", async () => {
    const warnings: string[] = [];
    mock.respond = () => undefined;
    const broker = await McpBroker.start({
      servers: { stdio: { command: "fake-mcp", args: [] } },
      requestTimeoutMs: 2_000,
      log: (level, message) => {
        if (level === "warn") warnings.push(message);
      },
    });
    const warm = broker.prewarm();
    const child = mock.spawnCalls[0];
    expect(child).toBeDefined();

    child!.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`);
    await flushMicrotasks();
    child!.stdout.emit("data", "y".repeat(9 * 1024 * 1024));
    child!.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } })}\n`);
    await warm;

    expect(broker.statuses()[0]?.connected).toBe(true);
    expect(warnings.some((line) => line.includes("8MB"))).toBe(true);
    await broker.dispose();
  });

  it("L4: SSE 非 2xx 失败后不再残留握手 timer", async () => {
    vi.useFakeTimers();
    mock.respond = (request, respond) => {
      const response = makeResponse(500);
      respond(response);
      response.emit("end");
    };
    const broker = await McpBroker.start({
      servers: { sse: { url: "http://fake.test/sse" } },
      requestTimeoutMs: 10_000,
    });
    const warm = broker.prewarm();
    await warm;
    await vi.advanceTimersByTimeAsync(100);

    expect(broker.statuses()[0]?.error).toMatch(/HTTP 500/u);
    expect(vi.getTimerCount()).toBe(0);
    await broker.dispose();
    vi.useRealTimers();
  });

  it("L5: stdin 的异步 EPIPE 错误不会变成未捕获异常", async () => {
    const broker = await McpBroker.start({
      servers: { stdio: { command: "fake-mcp", args: [] } },
      requestTimeoutMs: 2_000,
    });
    const warm = broker.prewarm();
    const child = mock.spawnCalls[0];
    expect(child).toBeDefined();

    expect(() => child!.stdin.emit("error", new Error("EPIPE"))).not.toThrow();
    await warm;

    expect(broker.statuses()[0]?.error).toMatch(/EPIPE/u);
    await broker.dispose();
  });
});
