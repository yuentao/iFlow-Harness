import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp/client.js";
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
