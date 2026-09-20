import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp/client.js";
import { buildAcpCommand } from "../src/acp/cli-locator.js";
import type { SessionNotification } from "../src/acp/protocol.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const mockAgent = path.join(here, "mock-acp-agent.mjs");

const clients: AcpClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.dispose()));
});

function createClient(mode?: string, callbacks?: ConstructorParameters<typeof AcpClient>[1]) {
  const client = new AcpClient(
    {
      command: process.execPath,
      args: [mockAgent],
      cwd: here,
      env: mode ? { ACP_MOCK_MODE: mode } : undefined,
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

  it("creates a session and receives the full streaming prompt flow", async () => {
    const updates: SessionNotification[] = [];
    const client = createClient(undefined, { onSessionUpdate: (n) => updates.push(n) });
    await client.connect();

    const session = await client.newSession({ cwd: here, mcpServers: [] });
    expect(session.sessionId).toBe("mock-session-1");
    expect(session.modes?.currentModeId).toBe("default");

    const result = await client.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hi" }] });
    expect(result.stopReason).toBe("end_turn");

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
});
