import { describe, it, expect, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp/client.js";
import { buildAcpCommand, MCP_SERVER_ALLOWLIST_FLAG, MCP_SERVER_ALLOWLIST_SENTINEL } from "../src/acp/cli-locator.js";
import type { SessionNotification } from "../src/acp/protocol.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const mockAgent = path.join(here, "mock-acp-agent.mjs");

const clients: AcpClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.dispose()));
}, 20000);

function createClient(mode?: string, callbacks?: ConstructorParameters<typeof AcpClient>[1], extraEnv?: Record<string, string>) {
  const client = new AcpClient(
    {
      command: process.execPath,
      args: [mockAgent],
      cwd: here,
      env: { ...(mode ? { ACP_MOCK_MODE: mode } : {}), ...(extraEnv ?? {}) },
    },
    callbacks,
  );
  clients.push(client);
  return client;
}

describe("AcpClient (integration with mock ACP agent)", () => {
  it("completes initialize handshake and exposes agent capabilities", async () => {
    const client = createClient();
    const init = await client.connect();
    expect(init.protocolVersion).toBe(1);
    expect(init.agentInfo?.name).toBe("mock-agent");
    expect(init.agentCapabilities.loadSession).toBe(true);
    expect(init.agentCapabilities.promptCapabilities?.image).toBe(true);
    expect(init.authMethods).toHaveLength(1);
  });

  it("round-trips thinking levels through session/set_think", async () => {
    const client = createClient();
    await client.connect();
    const session = await client.newSession({ cwd: "/repo", mcpServers: [] });

    await expect(client.setThink(session.sessionId, true, "ultrathink")).resolves.toEqual({
      success: true,
      currentThinkEnabled: true,
      currentThinkConfig: "ultrathink",
    });
    await expect(client.setThink(session.sessionId, false)).resolves.toEqual({
      success: true,
      currentThinkEnabled: false,
      currentThinkConfig: "think",
    });
  });

  it("creates a session and receives the full streaming prompt flow", async () => {
    const updates: SessionNotification[] = [];
    const client = createClient(undefined, { onSessionUpdate: (n) => updates.push(n) });
    await client.connect();
    const session = await client.newSession({ cwd: here, mcpServers: [] });

    expect(session.sessionId).toBe("mock-session-1");
    expect(session.modes?.currentModeId).toBe("default");

    const result = await client.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hi" }] });
    expect(result.stopReason).toBe("end_turn");
    // No ACP_MOCK_USAGE → the agent answered upstream-style {stopReason} only;
    // the iFlow usage extension must surface as absent, never a fabricated 0.
    expect(result.usage).toBeUndefined();

    const labels = updates.map((u) => u.update.sessionUpdate);
    expect(labels).toContain("agent_thought_chunk");
    expect(labels).toContain("tool_call");
    expect(labels).toContain("tool_call_update");
    expect(labels).toContain("plan");

    const text = updates
      .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
      .map((u) => (u.update.content as { text?: string }).text ?? "")
      .join("");
    expect(text).toBe("Hello world");
  });

  it("surfaces the authoritative usage report on PromptResponse (iFlow extension)", async () => {
    // ACP_MOCK_USAGE makes the mock agent attach usage.lastRequestInputTokens
    // to its prompt result (acp-usage-report Mod's extension point); the client
    // must pass it through untouched for the panel's occupancy overlay.
    const client = new AcpClient(
      { command: process.execPath, args: [mockAgent], cwd: here, env: { ACP_MOCK_USAGE: "61000" } },
    );
    clients.push(client);
    await client.connect();
    await client.newSession({ cwd: here, mcpServers: [] });
    const result = await client.prompt({ sessionId: "mock-session-1", prompt: [{ type: "text", text: "hi" }] });
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({ lastRequestInputTokens: 61000 });
  });

  it("passes the widened cache/completion breakdown through untouched", async () => {
    // The widened acp-usage-report Mod carries the cache-read split and the
    // final request's completion (the prefill term replayed into the next
    // prompt). The client must not reshape or drop it — the host's anchored
    // occupancy overlay reads all three fields off PromptResponse.usage.
    const client = new AcpClient(
      {
        command: process.execPath,
        args: [mockAgent],
        cwd: here,
        env: { ACP_MOCK_USAGE: "136000", ACP_MOCK_USAGE_DETAIL: '{"cachedReadTokens":164000,"completionTokens":4300}' },
      },
    );
    clients.push(client);
    await client.connect();
    await client.newSession({ cwd: here, mcpServers: [] });
    const result = await client.prompt({ sessionId: "mock-session-1", prompt: [{ type: "text", text: "hi" }] });
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({
      lastRequestInputTokens: 136000,
      cachedReadTokens: 164000,
      completionTokens: 4300,
    });
  });

  it("round-trips the MCP status report (mcp-status-refactor Mod extension)", async () => {
    // The mock agent answers _iflow/mcp/status with a per-server view; the
    // client must pass the report through untouched (the panel adds contextTokens
    // host-side). ACP_MOCK_MCP_STATUS=off simulates a bundle without the Mod:
    // the JSON-RPC error surfaces as a rejection so the panel degrades to
    // "no indicator" rather than inventing a color.
    const client = createClient(undefined, undefined, { ACP_MOCK_MCP_STATUS: "on" });
    await client.connect();
    const session = await client.newSession({ cwd: here, mcpServers: [] });
    const report = await client.mcpStatus(session.sessionId);
    expect(report.available).toBe(true);
    expect(report.discoveryState).toBe("completed");
    expect(report.servers.share.status).toBe("connected");
    expect(report.servers.share.tools[0]?.name).toBe("share_echo");
    expect(report.servers.broken.errorKind).toBe("spawn_failed");

    const withoutMod = createClient(undefined, undefined, { ACP_MOCK_MCP_STATUS: "off" });
    await withoutMod.connect();
    const session2 = await withoutMod.newSession({ cwd: here, mcpServers: [] });
    let threw = false;
    try {
      await withoutMod.mcpStatus(session2.sessionId);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("routes server→client request_permission to the injected handler", async () => {
    const decisions: string[] = [];
    const client = createClient(undefined, {
      onRequestPermission: async (req) => {
        decisions.push(req.toolCall.toolName ?? "?");
        return { outcome: { outcome: "selected", optionId: "allow" } };
      },
    });
    await client.connect();
    await client.newSession({ cwd: here, mcpServers: [] });
    await client.prompt({ sessionId: "mock-session-1", prompt: [{ type: "text", text: "hi" }] });
    expect(decisions).toEqual(["run_shell_command"]);
  });

  it("times out a prompt when the agent never responds", async () => {
    const client = new AcpClient(
      { command: process.execPath, args: [mockAgent], cwd: here, env: { ACP_MOCK_MODE: "timeout_prompt" }, promptTimeoutMs: 300 },
    );
    clients.push(client);
    await client.connect();
    await client.newSession({ cwd: here, mcpServers: [] });
    await expect(client.prompt({ sessionId: "mock-session-1", prompt: [{ type: "text", text: "hi" }] })).rejects.toMatchObject({
      message: expect.stringContaining("timed out"),
    });
  });

  it("resolveAgentPath keeps paths inside allowed roots and rejects traversal", () => {
    const client = createClient() as unknown as {
      resolveAgentPath: (p: string) => string;
    };
    // Relative paths inside the session dir resolve against cwd.
    expect(client.resolveAgentPath("a/b.ts")).toBe(path.join(here, "a", "b.ts"));
    expect(client.resolveAgentPath("./a.ts")).toBe(path.join(here, "a.ts"));
    // Absolute path pointing at the session dir itself is fine.
    expect(client.resolveAgentPath(here)).toBe(path.resolve(here));
    // Traversal and absolute paths outside the boundary are rejected.
    expect(() => client.resolveAgentPath("../../escape.txt")).toThrow(/outside allowed directories/);
    expect(() => client.resolveAgentPath("sub/../../escape.txt")).toThrow(/outside allowed directories/);
    expect(() => client.resolveAgentPath("/etc/passwd")).toThrow(/outside allowed directories/);
  });

  it("accepts absolute paths inside allowedRoots (multi-root workspaces)", () => {
    // The session dir is `here`; a sibling folder is explicitly allowed
    // (multi-root workspace). The CLI legitimately edits files there, so an
    // absolute path inside that root must NOT be rejected.
    const sibling = path.join(path.dirname(here), "allowed-root-fixture");
    const client = new AcpClient(
      { command: process.execPath, args: [mockAgent], cwd: here, allowedRoots: [sibling] },
    ) as unknown as {
      resolveAgentPath: (p: string) => string;
    };
    clients.push(client as unknown as AcpClient);
    expect(client.resolveAgentPath(path.join(sibling, "x.ts"))).toBe(path.join(sibling, "x.ts"));
    // And still rejects absolute paths outside every allowed root.
    expect(() => client.resolveAgentPath(path.join(path.dirname(sibling), "nope", "y.ts"))).toThrow(
      /outside allowed directories/,
    );
  });

  it("aligns with the CLI's realpath semantics for symlinked roots", () => {
    // The CLI realpaths both the candidate path and each root before its
    // workspace check (probed, CLI 0.5.19 bundle). On macOS os.tmpdir() is
    // usually a symlink (/var/folders/... -> /private/var/folders/...), so a
    // workspace opened via one spelling must accept paths spelled the other
    // way — otherwise the CLI accepts a path our boundary rejects.
    const lexical = os.tmpdir();
    const resolved = realpathSync(lexical);
    if (lexical === resolved) return; // no symlink on this platform — nothing to assert
    const client = new AcpClient({
      command: process.execPath,
      args: [mockAgent],
      cwd: lexical,
    }) as unknown as { resolveAgentPath: (p: string) => string };
    clients.push(client as unknown as AcpClient);
    // Same directory, opposite spelling: must be accepted, not rejected.
    expect(client.resolveAgentPath(resolved)).toBe(resolved);
  });

  it("buildAcpCommand passes extra workspace roots as --include-directories", () => {
    const extra = [path.join(here, "root-b"), path.join(here, "root-c")];
    const withExtras = buildAcpCommand(mockAgent, extra);
    expect(withExtras.args).toContain("--experimental-acp");
    expect(withExtras.args).toContain("--stream");
    for (const dir of extra) {
      const i = withExtras.args.indexOf("--include-directories");
      expect(i).toBeGreaterThan(-1);
      expect(withExtras.args).toContain(path.resolve(dir));
    }
    // No extra roots → no flag at all (single-root workspaces unchanged).
    const plain = buildAcpCommand(mockAgent);
    expect(plain.args).not.toContain("--include-directories");
  });

  it("buildAcpCommand removes every MCP server only when asked (main session)", () => {
    const scoped = buildAcpCommand(mockAgent, [], { disableMcpServers: true });
    const i = scoped.args.indexOf(MCP_SERVER_ALLOWLIST_FLAG);
    expect(i).toBeGreaterThan(-1);
    // 哨兵名与任何真实服务器名永不相交 → CLI 侧解析出的服务器集合为空，
    // 既不 spawn 也不注册任何 MCP 工具。
    expect(scoped.args[i + 1]).toBe(MCP_SERVER_ALLOWLIST_SENTINEL);

    // 默认（子会话路径）逐字节保持原样：没有该参数。
    const plain = buildAcpCommand(mockAgent);
    expect(plain.args).not.toContain(MCP_SERVER_ALLOWLIST_FLAG);
    expect(JSON.stringify(plain.args)).not.toContain(MCP_SERVER_ALLOWLIST_SENTINEL);
    // 与额外目录同用时也不互相干扰。
    const both = buildAcpCommand(mockAgent, [path.join(here, "root-b")], {
      disableMcpServers: true,
    });
    expect(both.args).toContain("--include-directories");
    expect(both.args).toContain(MCP_SERVER_ALLOWLIST_FLAG);
  });

  it("buildAcpCommand scopes child MCP servers with one allowlist flag per name (empty → sentinel)", () => {
    // 子会话路径（createClient 的 broker names）：每个 server 名一个 flag，
    // CLI 侧按 set 过滤合并后的 map，只有这些名字能连 host broker。
    const names = ["broker-a", "broker-b", "broker-c"];
    const scoped = buildAcpCommand(mockAgent, [], { mcpServerNames: names });
    const passed: string[] = [];
    for (let i = 0; i < scoped.args.length; i++) {
      if (scoped.args[i] === MCP_SERVER_ALLOWLIST_FLAG) passed.push(scoped.args[i + 1] ?? "");
    }
    expect(passed).toEqual(names);

    // 空数组（无 broker / 无配置）= 无 MCP：必须是永不匹配的哨兵，而不是
    // 「没有 flag」—— 后者会让 CLI 保留用户配置里的全部 stdio server。
    const empty = buildAcpCommand(mockAgent, [], { mcpServerNames: [] });
    const i = empty.args.indexOf(MCP_SERVER_ALLOWLIST_FLAG);
    expect(i).toBeGreaterThan(-1);
    expect(empty.args[i + 1]).toBe(MCP_SERVER_ALLOWLIST_SENTINEL);
    expect(empty.args.filter((a) => a === MCP_SERVER_ALLOWLIST_FLAG)).toHaveLength(1);

    // undefined = 不带 flag（没有 scope 请求时保持上游默认行为）。
    const unset = buildAcpCommand(mockAgent, [], {});
    expect(unset.args).not.toContain(MCP_SERVER_ALLOWLIST_FLAG);
  });

  it("rejects fs/write_text_file paths that escape the session dir (A1 guardrail)", async () => {
    const updates: SessionNotification[] = [];
    const client = createClient("sandbox_escape", { onSessionUpdate: (n) => updates.push(n) });
    await client.connect();
    await client.newSession({ cwd: here, mcpServers: [] });

    // The mock agent's prompt flow issues fs/write_text_file with a
    // `..`-traversing path (../../escape.txt) and echoes the client's reply
    // back as a message chunk. Assert the client rejected it with an error
    // (no file was written — the mock only reports the reply, never touches
    // disk itself).
    const result = await client.prompt({ sessionId: "mock-session-1", prompt: [{ type: "text", text: "hi" }] });
    expect(result.stopReason).toBe("end_turn");

    const notes = updates
      .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
      .map((u) => (u.update.content as { text?: string }).text ?? "");
    const escapeNote = notes.find((n) => n.startsWith("sandbox-"));
    expect(escapeNote).toBeDefined();
    expect(escapeNote!).toContain("sandbox-blocked");
    expect(escapeNote!).toContain("outside allowed directories");
  });

  it("transmits settings.add_dirs verbatim on session/new and session/load (multi-repo root subset)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "iflow-add-dirs-"));
    const dump = path.join(dir, "sessions.jsonl");
    try {
      const client = createClient(undefined, undefined, { ACP_MOCK_SESSION_DUMP: dump });
      await client.connect();
      const addDirs = [path.join(dir, "repo-b"), path.join(dir, "repo-c")];
      await client.newSession({ cwd: here, mcpServers: [], settings: { add_dirs: addDirs } });
      // 空数组是「只留 cwd」的合法收紧形态（CLI: includeDirectories || argv
      // 中空数组为真值，会胜出），必须原样透传而不是被当成缺省丢掉。
      await client.loadSession({
        cwd: here,
        mcpServers: [],
        sessionId: "add-dirs-session",
        settings: { add_dirs: [] },
      });
      const rows = readFileSync(dump, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
      const newRow = rows.find((r) => r.method === "session/new");
      const loadRow = rows.find((r) => r.method === "session/load");
      expect((newRow?.params as { settings?: { add_dirs?: string[] } }).settings?.add_dirs).toEqual(addDirs);
      expect((loadRow?.params as { settings?: { add_dirs?: string[] } }).settings?.add_dirs).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propagates a JSON-RPC error for unsupported methods", async () => {
    const client = createClient();
    await client.connect();
    // session/cancel is a notification; use an unknown request to check error mapping
    await expect(
      client.newSession({ cwd: here, mcpServers: [] }).then(() =>
        client["peer"]!.request("totally/unknown", {}, 5000),
      ),
    ).rejects.toMatchObject({ code: -32601 });
  });

  // --- S4 (3.5.0): AGENTS.md pitfall #20 — connect() must dispose the
  // spawned child when the initialize handshake fails, so every retry no
  // longer leaks a zombie node process. These tests only PIN the existing
  // behaviour; no runtime code is changed here.
  it("disposes the child on initialize timeout and dispose stays idempotent", async () => {
    let exits = 0;
    const client = new AcpClient(
      {
        command: process.execPath,
        args: [mockAgent],
        cwd: here,
        env: { ACP_MOCK_MODE: "hang_initialize" },
        requestTimeoutMs: 500,
      },
      { onExit: () => { exits += 1; } },
    );
    clients.push(client);
    const disposeSpy = vi.spyOn(client, "dispose");

    await expect(client.connect()).rejects.toThrow(/timed out/i);
    // connect()'s catch must have started teardown of the still-running child.
    expect(disposeSpy).toHaveBeenCalled();
    // And the child must actually be gone — not merely "dispose was called".
    await vi.waitFor(() => expect(exits).toBe(1), { timeout: 15000 });

    // The panel's catch calls dispose() a second time on the SAME instance;
    // a double call on an already-killed child must be a harmless no-op.
    await expect(client.dispose()).resolves.toBeUndefined();
    expect(disposeSpy).toHaveBeenCalledTimes(2);
  }, 20000);

  it("disposes the child on a non-timeout initialize handshake error", async () => {
    let exits = 0;
    const client = new AcpClient(
      { command: process.execPath, args: [mockAgent], cwd: here, env: { ACP_MOCK_MODE: "error_initialize" } },
      { onExit: () => { exits += 1; } },
    );
    clients.push(client);
    const disposeSpy = vi.spyOn(client, "dispose");

    await expect(client.connect()).rejects.toMatchObject({ code: -32000 });
    expect(disposeSpy).toHaveBeenCalled();
    await vi.waitFor(() => expect(exits).toBe(1), { timeout: 15000 });
  }, 20000);

  it("does not dispose a client whose initialize succeeded", async () => {
    const client = createClient();
    const disposeSpy = vi.spyOn(client, "dispose");
    await expect(client.connect()).resolves.toMatchObject({ protocolVersion: 1 });
    expect(disposeSpy).not.toHaveBeenCalled();
  });
});
