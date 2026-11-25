/**
 * Host-side MCP broker (`src/acp/mcp-broker.ts`).
 *
 * The product requirement is: child sessions DO get MCP, and every configured
 * MCP server process exists exactly ONCE no matter how many children run. These
 * tests exercise both halves against real processes/transports:
 *
 *  - the fake stdio server writes one line per spawn, so "two concurrent child
 *    sessions" must leave exactly one line per server;
 *  - each simulated child speaks streamable-HTTP to the broker (initialize,
 *    tools/list, tools/call) — the same shape the CLI's `type: "http"`
 *    transport produces;
 *  - upstream `http` and `sse` transports are covered by in-process servers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { McpBroker, MCP_BROKER_TOKEN_HEADER, normalizeBrokerServers } from "../src/acp/mcp-broker.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeServer = path.join(here, "fixtures", "fake-mcp-server.mjs");

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    try {
      await cleanup?.();
    } catch {
      // best-effort
    }
  }
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

function spawnLogFile(dir: string): string {
  const file = path.join(dir, "spawns.log");
  fs.writeFileSync(file, "");
  return file;
}

function spawnLines(file: string): string[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition not met in time");
}

/** The broker rewrites every configured server into a remote HTTP proxy entry. */
type RemoteProxyEntry = { name?: string; type: string; url?: string; headers?: Record<string, string> };
function remoteServers(broker: McpBroker): RemoteProxyEntry[] {
  return broker.sessionServers() as RemoteProxyEntry[];
}

function tokenOf(broker: McpBroker): string {
  const headers = remoteServers(broker)[0]?.headers;
  const token = headers?.[MCP_BROKER_TOKEN_HEADER];
  if (!token) throw new Error("broker session servers carry no token");
  return token;
}

async function postRpc(
  url: string,
  token: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", [MCP_BROKER_TOKEN_HEADER]: token },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

/** One simulated child CLI's MCP client session against the broker. */
async function childSession(url: string, token: string, toolName: string) {
  const init = await postRpc(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fake-child", version: "1.0.0" },
    },
  });
  const initialized = await postRpc(url, token, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  const list = await postRpc(url, token, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const call = await postRpc(url, token, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: toolName, arguments: { text: "hi" } },
  });
  return { init, initialized, list, call };
}

function toolNames(list: { json: Record<string, unknown> | null }): string[] {
  const result = list.json?.result as { tools?: { name?: string }[] } | undefined;
  return (result?.tools ?? []).map((tool) => tool.name ?? "");
}

function callText(call: { json: Record<string, unknown> | null }): string {
  const result = call.json?.result as { content?: { text?: string }[] } | undefined;
  return (result?.content ?? []).map((part) => part.text ?? "").join("");
}

describe("normalizeBrokerServers", () => {
  it("推导 transport、整理 env/headers，并跳过无法共享的条目", () => {
    const { servers, skipped } = normalizeBrokerServers({
      stdio: { command: "npx", args: ["-y", "server"], env: [{ name: "A", value: "1" }] },
      legacyEnv: { command: "node", env: { B: 2, C: true } },
      remoteHttp: { httpUrl: "https://example.test/mcp", headers: { Authorization: "Bearer x" } },
      remoteSse: { url: "https://example.test/sse" },
      explicitHttp: { type: "streamable-http", url: "https://example.test/mcp" },
      off: { command: "node", disabled: true },
      noTarget: { args: ["x"] },
      ws: { type: "sse", url: "wss://example.test/ws" },
      explicitWs: { type: "websocket", url: "wss://example.test/socket", headers: { Authorization: "Bearer y" } },
      noCommand: { type: "stdio" },
    });

    expect(servers.map((server) => server.name)).toEqual([
      "stdio",
      "legacyEnv",
      "remoteHttp",
      "remoteSse",
      "explicitHttp",
      "ws",
      "explicitWs",
    ]);
    expect(servers.find((server) => server.name === "stdio")).toMatchObject({
      type: "stdio",
      command: "npx",
      args: ["-y", "server"],
      env: { A: "1" },
    });
    expect(servers.find((server) => server.name === "legacyEnv")?.env).toEqual({ B: "2", C: "true" });
    expect(servers.find((server) => server.name === "remoteHttp")).toMatchObject({
      type: "http",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer x" },
    });
    expect(servers.find((server) => server.name === "remoteSse")?.type).toBe("sse");
    expect(servers.find((server) => server.name === "explicitHttp")?.type).toBe("http");
    // ws/wss targets are websocket even when a stale config says `sse`.
    expect(servers.find((server) => server.name === "ws")).toMatchObject({
      type: "websocket",
      url: "wss://example.test/ws",
    });
    expect(servers.find((server) => server.name === "explicitWs")).toMatchObject({
      type: "websocket",
      url: "wss://example.test/socket",
      headers: { Authorization: "Bearer y" },
    });

    const skippedNames = skipped.map((entry) => entry.name);
    expect(skippedNames).toEqual(["off", "noTarget", "noCommand"]);
  });
});

describe("McpBroker · 共享 stdio 进程", () => {
  it("两个并发超流体只让每个 server 启动一次，且两边都能拿到工具", async () => {
    const dir = tempDir("iflow-mcp-broker-");
    const logFile = spawnLogFile(dir);
    const broker = await McpBroker.start({
      servers: {
        alpha: {
          command: process.execPath,
          args: [fakeServer, "--name", "alpha"],
          env: { FAKE_MCP_SPAWN_LOG: logFile },
        },
        beta: {
          command: process.execPath,
          args: [fakeServer, "--name", "beta"],
          env: { FAKE_MCP_SPAWN_LOG: logFile },
        },
      },
    });
    cleanups.push(() => broker.dispose());

    const entries = remoteServers(broker);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.type).toBe("http");
      expect(entry.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\//u);
      expect(entry.headers?.[MCP_BROKER_TOKEN_HEADER]).toBeTruthy();
    }
    expect(broker.names()).toEqual(["alpha", "beta"]);

    const token = tokenOf(broker);
    const alpha = remoteServers(broker).find((entry) => entry.name === "alpha");
    const beta = remoteServers(broker).find((entry) => entry.name === "beta");
    expect(alpha?.url).toBeTruthy();
    expect(beta?.url).toBeTruthy();

    // Two "children", both starting at the same time, both hitting both servers.
    const [childOne, childTwo] = await Promise.all([
      Promise.all([
        childSession(alpha!.url!, token, "alpha_echo"),
        childSession(beta!.url!, token, "beta_echo"),
      ]),
      Promise.all([
        childSession(alpha!.url!, token, "alpha_slow"),
        childSession(beta!.url!, token, "beta_slow"),
      ]),
    ]);

    for (const session of [...childOne, ...childTwo]) {
      expect(session.init.status).toBe(200);
      expect(session.initialized.status).toBe(202);
      expect(session.list.status).toBe(200);
      expect(session.call.status).toBe(200);
    }

    const alphaTools = [...toolNames(childOne[0]!.list), ...toolNames(childTwo[0]!.list)];
    expect(alphaTools).toContain("alpha_echo");
    expect(alphaTools).toContain("alpha_slow");
    expect(toolNames(childOne[1]!.list)).toContain("beta_echo");
    expect(callText(childOne[0]!.call)).toBe("echo:hi");
    expect(callText(childTwo[1]!.call)).toBe("echo:hi");

    // THE assertion this whole module exists for: one process per server, not
    // one per child session.
    const lines = spawnLines(logFile);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.split(" ")[0]).sort()).toEqual(["alpha", "beta"]);

    expect(broker.statuses().map((status) => status.connected)).toEqual([true, true]);
  }, 30000);

  it("上游启动失败如实暴露（初始化返回 JSON-RPC 错误，statuses 记录原因）", async () => {
    const broker = await McpBroker.start({
      servers: { broken: { command: "__iflow_missing_mcp_binary__", args: [] } },
      requestTimeoutMs: 5_000,
    });
    cleanups.push(() => broker.dispose());
    await broker.prewarm();

    const entry = remoteServers(broker)[0]!;
    const token = tokenOf(broker);
    const response = await postRpc(entry.url!, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } },
    });

    expect(response.status).toBe(200);
    const error = response.json?.error as { code?: number; message?: string } | undefined;
    expect(error?.code).toBe(-32000);
    expect(error?.message).toContain("broken");
    expect(error?.message).toMatch(/不可用/u);

    const status = broker.statuses()[0]!;
    expect(status.connected).toBe(false);
    expect(status.error).toBeTruthy();
  }, 30000);

  it("错误 token 被拒绝，GET 返回 405（客户端把 405 当作无 SSE 流）", async () => {
    const broker = await McpBroker.start({
      servers: { alpha: { command: process.execPath, args: [fakeServer, "--name", "alpha"] } },
    });
    cleanups.push(() => broker.dispose());
    const entry = remoteServers(broker)[0]!;

    const unauthorized = await fetch(entry.url!, {
      method: "POST",
      headers: { "content-type": "application/json", [MCP_BROKER_TOKEN_HEADER]: "wrong" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(unauthorized.status).toBe(401);
    await unauthorized.text();

    const getResponse = await fetch(entry.url!, {
      method: "GET",
      headers: { accept: "text/event-stream", [MCP_BROKER_TOKEN_HEADER]: tokenOf(broker) },
    });
    expect(getResponse.status).toBe(405);
    await getResponse.text();
  }, 30000);

  it("dispose 会收掉上游进程并关闭本地端口", async () => {
    const dir = tempDir("iflow-mcp-broker-dispose-");
    const logFile = spawnLogFile(dir);
    const broker = await McpBroker.start({
      servers: {
        alpha: {
          command: process.execPath,
          args: [fakeServer, "--name", "alpha"],
          env: { FAKE_MCP_SPAWN_LOG: logFile },
        },
      },
    });
    await broker.prewarm();
    await waitFor(() => spawnLines(logFile).length === 1);
    const pid = Number(spawnLines(logFile)[0]!.split(" ")[1]);
    const url = remoteServers(broker)[0]!.url!;

    await broker.dispose();

    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    await expect(fetch(url, { method: "POST", body: "{}" })).rejects.toThrow();
  }, 30000);
});

describe("McpBroker · 远程上游", () => {
  /** In-process streamable-HTTP MCP server (records how often it was initialized). */
  async function startHttpUpstream(): Promise<{ server: Server; url: string; inits: () => number }> {
    let inits = 0;
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (body += chunk));
      request.on("end", () => {
        const message = JSON.parse(body || "{}") as {
          id?: number;
          method?: string;
          params?: { name?: string; arguments?: { text?: string } };
        };
        const reply = (result: unknown): void => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        };
        if (message.method === "initialize") {
          inits += 1;
          reply({
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "remote", version: "1.0.0" },
          });
          return;
        }
        if (message.method === "notifications/initialized") {
          response.writeHead(202);
          response.end();
          return;
        }
        if (message.method === "tools/list") {
          reply({ tools: [{ name: "remote_echo", description: "remote", inputSchema: { type: "object" } }] });
          return;
        }
        if (message.method === "tools/call") {
          reply({ content: [{ type: "text", text: `remote:${message.params?.arguments?.text ?? ""}` }] });
          return;
        }
        response.writeHead(404);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || !address) throw new Error("no address");
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );
    return { server, url: `http://127.0.0.1:${address.port}/mcp`, inits: () => inits };
  }

  it("http 上游：两个超流体共享一次 initialize，工具可见可调用", async () => {
    const upstream = await startHttpUpstream();
    const broker = await McpBroker.start({
      servers: { remote: { type: "http", url: upstream.url } },
    });
    cleanups.push(() => broker.dispose());
    await broker.prewarm();

    const entry = remoteServers(broker)[0]!;
    const token = tokenOf(broker);
    const [first, second] = await Promise.all([
      childSession(entry.url!, token, "remote_echo"),
      childSession(entry.url!, token, "remote_echo"),
    ]);

    expect(toolNames(first.list)).toContain("remote_echo");
    expect(toolNames(second.list)).toContain("remote_echo");
    expect(callText(first.call)).toBe("remote:hi");
    expect(callText(second.call)).toBe("remote:hi");
    expect(upstream.inits()).toBe(1);
  }, 30000);

  it("sse 上游：endpoint 事件 + 消息流上的响应可被代理", async () => {
    const sessions = new Map<string, (payload: string) => void>();
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/sse") {
        const id = `s${sessions.size + 1}`;
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        response.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`);
        sessions.set(id, (payload) => {
          response.write(`event: message\ndata: ${payload}\n\n`);
        });
        request.on("close", () => sessions.delete(id));
        return;
      }
      if (request.method === "POST" && url.pathname === "/messages") {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => (body += chunk));
        request.on("end", () => {
          response.writeHead(202);
          response.end();
          const message = JSON.parse(body) as { id?: number; method?: string };
          if (message.id === undefined) return;
          const result =
            message.method === "initialize"
              ? {
                  protocolVersion: "2024-11-05",
                  capabilities: { tools: {} },
                  serverInfo: { name: "sse-remote", version: "1.0.0" },
                }
              : message.method === "tools/list"
                ? { tools: [{ name: "sse_echo", description: "sse", inputSchema: { type: "object" } }] }
                : {};
          const payload = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
          for (const write of sessions.values()) write(payload);
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || !address) throw new Error("no address");
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );

    const broker = await McpBroker.start({
      servers: { remote: { type: "sse", url: `http://127.0.0.1:${address.port}/sse` } },
    });
    cleanups.push(() => broker.dispose());

    const entry = remoteServers(broker)[0]!;
    const token = tokenOf(broker);
    const init = await postRpc(entry.url!, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } },
    });
    expect(init.status).toBe(200);
    expect((init.json?.result as { serverInfo?: { name?: string } } | undefined)?.serverInfo?.name).toBe(
      "sse-remote",
    );

    const list = await postRpc(entry.url!, token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(toolNames(list)).toContain("sse_echo");
  }, 30000);
});

describe("McpBroker · 状态上报（面板刷新数据源）", () => {
  it("statuses 暴露 connecting 三态与缓存的 tools/list，并在连接完成时回调 onStatusChange", async () => {
    const onChange = vi.fn();
    const broker = await McpBroker.start({
      servers: { alpha: { command: process.execPath, args: [fakeServer, "--name", "alpha"] } },
      onStatusChange: onChange,
    });
    cleanups.push(() => broker.dispose());

    const before = broker.statuses()[0]!;
    expect(before).toMatchObject({ name: "alpha", connected: false, connecting: false, tools: [] });

    await broker.prewarm();
    await waitFor(() => onChange.mock.calls.length > 0);
    await waitFor(() => broker.statuses()[0]!.connected === true);

    const after = broker.statuses()[0]!;
    expect(after.connected).toBe(true);
    expect(after.connecting).toBe(false);
    expect(after.tools.map((tool) => tool.name)).toEqual(["alpha_echo", "alpha_slow"]);
    // 标准 MCP 的 inputSchema 被归一化成 McpToolView.schema（token 估算可用）。
    expect(after.tools[0]!.schema).toMatchObject({ type: "object" });
  }, 30000);

  it("握手未完成时 connecting=true，完成后归零（不误报失败）", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (body += chunk));
      request.on("end", () => {
        const message = JSON.parse(body || "{}") as { id?: number; method?: string };
        if (message.method === "notifications/initialized") {
          response.writeHead(202); response.end(); return;
        }
        if (message.method === "initialize") {
          void gate.then(() => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({
              jsonrpc: "2.0", id: message.id,
              result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "slow" } },
            }));
          });
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || !address) throw new Error("no address");
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const broker = await McpBroker.start({ servers: { slow: { type: "http", url: `http://127.0.0.1:${address.port}/mcp` } } });
    cleanups.push(() => broker.dispose());

    const prewarm = broker.prewarm();
    // ensure() 在第一个 await 之前就登记了 connecting，立即可见。
    expect(broker.statuses()[0]).toMatchObject({ connected: false, connecting: true });
    release!();
    await prewarm;
    expect(broker.statuses()[0]).toMatchObject({ connected: true, connecting: false });
  }, 30000);
});

describe("McpBroker · websocket 上游与上游入站请求（全离线）", () => {
  function spawnFakeWsUpstream(opts: {
    portFile: string;
    replyLog: string;
    inboundMethods: string;
  }): ChildProcess {
    const child = spawn(process.execPath, [fakeServer, "--name", "ws", "--ws"], {
      env: {
        ...process.env,
        FAKE_MCP_WS_PORT_FILE: opts.portFile,
        FAKE_MCP_REPLY_LOG: opts.replyLog,
        FAKE_MCP_INBOUND_METHODS: opts.inboundMethods,
      },
      stdio: "ignore",
      windowsHide: true,
    });
    cleanups.push(() => {
      if (!child.killed) child.kill();
    });
    return child;
  }

  async function waitPort(file: string): Promise<number> {
    let port = 0;
    await waitFor(() => {
      try {
        port = Number(fs.readFileSync(file, "utf8").trim());
        return Number.isInteger(port) && port > 0;
      } catch {
        return false;
      }
    });
    return port;
  }

  function readReplies(file: string): { id?: unknown; result?: unknown; error?: { code?: number; message?: string } }[] {
    try {
      return fs
        .readFileSync(file, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) =>
          JSON.parse(line) as { id?: unknown; result?: unknown; error?: { code?: number; message?: string } },
        );
    } catch {
      return [];
    }
  }

  it("websocket 上游：连接可见可调用，入站请求经钩子接收并回包（不伪装真实子 CLI 路由）", async () => {
    const dir = tempDir("iflow-mcp-broker-ws-");
    const portFile = path.join(dir, "ws.port");
    const replyLog = path.join(dir, "replies.log");
    spawnFakeWsUpstream({ portFile, replyLog, inboundMethods: "ping,sampling/createMessage" });
    const port = await waitPort(portFile);

    const seen: { name?: string; method?: string; id?: unknown }[] = [];
    const broker = await McpBroker.start({
      servers: { remote: { type: "websocket", url: `ws://127.0.0.1:${port}` } },
      onUpstreamRequest: (name, request) => {
        seen.push({ name, method: request.method, id: request.id });
        if (request.method === "sampling/createMessage") return { result: { handled: true } };
        // ping falls through to the broker's generic `{}` reply.
      },
    });
    cleanups.push(() => broker.dispose());
    await broker.prewarm();

    const entry = remoteServers(broker)[0]!;
    const token = tokenOf(broker);
    const session = await childSession(entry.url!, token, "ws_echo");
    expect(session.init.status).toBe(200);
    expect(toolNames(session.list)).toContain("ws_echo");
    expect(callText(session.call)).toBe("echo:hi");
    expect(broker.statuses()[0]).toMatchObject({ connected: true, type: "websocket" });

    await waitFor(() => readReplies(replyLog).length === 2);
    const replies = readReplies(replyLog);
    expect(replies.find((reply) => reply.id === "inbound-1")?.result).toEqual({});
    expect(replies.find((reply) => reply.id === "inbound-2")?.result).toEqual({ handled: true });
    expect(seen).toEqual([
      { name: "remote", method: "ping", id: "inbound-1" },
      { name: "remote", method: "sampling/createMessage", id: "inbound-2" },
    ]);
  }, 30000);

  it("webSocketImpl 注入：进程内假构造器即可驱动上游，不打开真实 socket", async () => {
    class FakeWebSocket {
      static instances: FakeWebSocket[] = [];
      readyState = 0;
      private readonly handlers = new Map<string, ((arg?: unknown) => void)[]>();
      readonly sent: string[] = [];

      constructor(
        readonly url: string,
        readonly options?: { headers?: Record<string, string> },
      ) {
        FakeWebSocket.instances.push(this);
        queueMicrotask(() => {
          this.readyState = 1;
          this.emit("open");
        });
      }

      on(event: string, listener: (arg?: unknown) => void): this {
        const list = this.handlers.get(event) ?? [];
        list.push(listener);
        this.handlers.set(event, list);
        return this;
      }

      send(data: string): void {
        this.sent.push(data);
        const message = JSON.parse(data) as { id?: number; method?: string };
        if (message.id === undefined) return;
        const result =
          message.method === "initialize"
            ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "injected" } }
            : message.method === "tools/list"
              ? { tools: [{ name: "injected_echo", inputSchema: { type: "object" } }] }
              : message.method === "tools/call"
                ? { content: [{ type: "text", text: "injected:ok" }] }
                : {};
        queueMicrotask(() =>
          this.emit("message", JSON.stringify({ jsonrpc: "2.0", id: message.id, result })),
        );
      }

      close(): void {
        this.readyState = 3;
        this.emit("close");
      }

      private emit(event: string, arg?: unknown): void {
        for (const listener of this.handlers.get(event) ?? []) listener(arg);
      }
    }

    const broker = await McpBroker.start({
      servers: { injected: { type: "websocket", url: "ws://injected.test/ws" } },
      webSocketImpl: FakeWebSocket,
    });
    cleanups.push(() => broker.dispose());
    await broker.prewarm();

    const entry = remoteServers(broker)[0]!;
    const session = await childSession(entry.url!, tokenOf(broker), "injected_echo");
    expect(session.init.status).toBe(200);
    expect(toolNames(session.list)).toContain("injected_echo");
    expect(callText(session.call)).toBe("injected:ok");
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toBe("ws://injected.test/ws");
    expect(FakeWebSocket.instances[0]?.options?.headers).toBeTruthy();
  }, 30000);

  it("stdio 上游也转发入站请求；无 host 钩子时未知方法回 -32601（如实声明未路由到子 CLI）", async () => {
    const dir = tempDir("iflow-mcp-broker-stdinbound-");
    const replyLog = path.join(dir, "replies.log");
    const broker = await McpBroker.start({
      servers: {
        alpha: {
          command: process.execPath,
          args: [fakeServer, "--name", "alpha"],
          env: {
            FAKE_MCP_INBOUND_METHODS: "sampling/createMessage",
            FAKE_MCP_REPLY_LOG: replyLog,
          },
        },
      },
    });
    cleanups.push(() => broker.dispose());
    await broker.prewarm();

    const entry = remoteServers(broker)[0]!;
    const token = tokenOf(broker);
    const session = await childSession(entry.url!, token, "alpha_echo");
    expect(session.init.status).toBe(200);
    expect(toolNames(session.list)).toContain("alpha_echo");
    expect(callText(session.call)).toBe("echo:hi");

    await waitFor(() => readReplies(replyLog).length === 1);
    const reply = readReplies(replyLog)[0]!;
    expect(reply.id).toBe("inbound-1");
    expect(reply.error?.code).toBe(-32601);
    expect(reply.error?.message).toContain("sampling/createMessage");
  }, 30000);
});
