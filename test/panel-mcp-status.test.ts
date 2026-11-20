/**
 * `ChatPanel.sendMcpStatus()` synthesis (previously a test blind spot).
 *
 * The main panel session is spawned with MCP disabled, so the CLI's
 * `_iflow/mcp/status` report always carries an empty `tools[]` and a
 * `blocked:true` flag. The shared MCP broker is the authority for the child
 * sessions' real connections. These tests pin the host-side merge that makes
 * the MCP card honest: real token counts from the broker's cached tools, a
 * blue "connecting" state instead of a false red failure, preserved errorKind,
 * and proactive refresh on broker state changes.
 */
import { describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../src/panel/panel.js";
import type { McpStatusReport, McpToolView } from "../src/acp/protocol.js";
import type { McpBrokerStatus } from "../src/acp/mcp-broker.js";
import type { McpStatusUi } from "../shared/messages.js";

type Internals = {
  client: { mcpStatus: (sessionId: string) => Promise<McpStatusReport | null> } | null;
  mcpBroker: { statuses: () => McpBrokerStatus[] } | null;
  store: { getState: () => { sessionId: string } };
  log: { warn: (message: string) => void };
  readMcpScopes: () => { global: Record<string, unknown>; project: Record<string, unknown> | null };
  postToWebview: (message: unknown) => void;
  sendMcpStatus: () => Promise<void>;
  refreshMcpStatusFromBroker: () => void;
};

type Posted = { type: string; status?: McpStatusUi | null };

function brokerEntry(overrides: Partial<McpBrokerStatus> & { name: string }): McpBrokerStatus {
  return { type: "stdio", connected: false, connecting: false, tools: [], ...overrides };
}

function cliView(overrides: Record<string, unknown> = {}) {
  return {
    status: "disconnected" as const,
    toolCount: 0,
    promptCount: 0,
    tools: [] as McpToolView[],
    prompts: [],
    blocked: true,
    ...overrides,
  };
}

function report(servers: Record<string, ReturnType<typeof cliView>>, discoveryState = "completed"): McpStatusReport {
  return { available: true, discoveryState, servers };
}

function declaredTool(name: string): McpToolView {
  return {
    name,
    description: "a useful tool with a non-trivial schema",
    schema: {
      type: "object",
      properties: { message: { type: "string", description: "the message to echo" } },
      required: ["message"],
    },
  };
}

function harness(opts: {
  report?: McpStatusReport | null;
  broker?: McpBrokerStatus[];
  mcpStatusThrows?: boolean;
} = {}) {
  const posted: Posted[] = [];
  // Hermetic: only the fields sendMcpStatus actually touches are installed on
  // a bare prototype object — no spawn, no SecretStorage, no VSCode window.
  const panel = Object.create(ChatPanel.prototype) as unknown as Internals;
  panel.client = {
    mcpStatus: vi.fn().mockImplementation(async () => {
      if (opts.mcpStatusThrows) throw new Error("offline");
      return opts.report ?? null;
    }),
  };
  panel.mcpBroker = opts.broker ? { statuses: () => opts.broker! } : null;
  panel.store = { getState: () => ({ sessionId: "session-1" }) };
  panel.log = { warn: vi.fn() };
  panel.readMcpScopes = () => ({ global: {}, project: null });
  panel.postToWebview = (message: unknown) => posted.push(message as Posted);
  const lastStatus = (): McpStatusUi | null | undefined =>
    posted.filter((m) => m.type === "mcpStatus").at(-1)?.status;
  return { panel, posted, lastStatus };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("sendMcpStatus · host 合成", () => {
  it("用 broker 缓存的 tools 覆盖空的 CLI 视图，token 估算非 0", async () => {
    const tools = [declaredTool("search"), declaredTool("fetch")];
    const { panel, lastStatus } = harness({
      report: report({ api: cliView() }),
      broker: [brokerEntry({ name: "api", type: "http", connected: true, tools })],
    });
    await panel.sendMcpStatus();

    const view = lastStatus()?.servers.api;
    expect(view?.tools.map((tool) => tool.name)).toEqual(["search", "fetch"]);
    expect(view?.toolCount).toBe(2);
    expect(view?.contextTokens).toBeGreaterThan(0);
    expect(view?.status).toBe("connected");
    expect(view?.childConnected).toBe(true);
  });

  it("broker 连接中 → status=connecting 且 childConnected=undefined，不误报红点", async () => {
    const { panel, lastStatus } = harness({
      report: report({
        api: cliView({ error: "spawn ENOENT", errorKind: "spawn_failed" }),
      }),
      broker: [brokerEntry({ name: "api", connected: false, connecting: true })],
    });
    await panel.sendMcpStatus();

    const view = lastStatus()?.servers.api;
    expect(view?.status).toBe("connecting");
    expect(view?.childConnected).toBeUndefined();
    // Main-session blocked noise is dropped while the broker is still connecting.
    expect(view?.error).toBeUndefined();
    expect(view?.errorKind).toBeUndefined();
  });

  it("broker 明确失败才置 childConnected=false，并保留 CLI 的 errorKind", async () => {
    const { panel, lastStatus } = harness({
      report: report({ api: cliView({ error: "cli text", errorKind: "timeout" }) }),
      broker: [brokerEntry({ name: "api", connected: false, error: "broker boom" })],
    });
    await panel.sendMcpStatus();

    const view = lastStatus()?.servers.api;
    expect(view?.childConnected).toBe(false);
    expect(view?.status).toBe("disconnected");
    expect(view?.error).toBe("broker boom");
    expect(view?.errorKind).toBe("timeout");
  });

  it("CLI 没给 errorKind 时才补 unknown", async () => {
    const { panel, lastStatus } = harness({
      report: report({ api: cliView({ error: "cli text" }) }),
      broker: [brokerEntry({ name: "api", connected: false, error: "broker boom" })],
    });
    await panel.sendMcpStatus();
    expect(lastStatus()?.servers.api?.errorKind).toBe("unknown");
  });

  it("broker 连上时不会无差别抹掉 CLI 的非屏蔽错误", async () => {
    const { panel, lastStatus } = harness({
      report: report({
        api: cliView({ status: "connected", blocked: false, error: "real cli error", errorKind: "protocol_error" }),
      }),
      broker: [brokerEntry({ name: "api", connected: true })],
    });
    await panel.sendMcpStatus();
    const view = lastStatus()?.servers.api;
    expect(view?.error).toBe("real cli error");
    expect(view?.errorKind).toBe("protocol_error");
  });

  it("没有 CLI 上报也没有 broker 时降级为 status:null（不猜状态）", async () => {
    const { panel, lastStatus } = harness({ report: null, broker: [] });
    await panel.sendMcpStatus();
    expect(lastStatus()).toBeNull();
  });

  it("broker 状态变化主动推 mcpStatus，连接完成后 token 随之更新", async () => {
    let brokerStatuses = [brokerEntry({ name: "api", connected: false, connecting: true })];
    const { panel, posted, lastStatus } = harness({ report: report({ api: cliView() }) });
    panel.mcpBroker = { statuses: () => brokerStatuses };

    panel.refreshMcpStatusFromBroker();
    await flush();
    expect(posted.filter((m) => m.type === "mcpStatus")).toHaveLength(1);
    expect(lastStatus()?.servers.api?.status).toBe("connecting");

    brokerStatuses = [brokerEntry({
      name: "api", connected: true, tools: [declaredTool("ready")],
    })];
    panel.refreshMcpStatusFromBroker();
    await flush();
    expect(posted.filter((m) => m.type === "mcpStatus")).toHaveLength(2);
    const view = lastStatus()?.servers.api;
    expect(view?.status).toBe("connected");
    expect(view?.contextTokens).toBeGreaterThan(0);
  });
});
