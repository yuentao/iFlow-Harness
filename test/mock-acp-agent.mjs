#!/usr/bin/env node
/**
 * Minimal mock ACP agent for integration tests: speaks NDJSON JSON-RPC on
 * stdio, answers initialize/session/new, streams a scripted set of
 * session/update events on prompt, and issues a server→client
 * session/request_permission call. Also supports scripted failure injection
 * via ACP_MOCK_MODE env ("timeout_prompt" never answers a prompt).
 */

let buffer = "";

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function handle(msg) {
  const isResponse = msg.id !== undefined && msg.method === undefined;
  if (isResponse) return; // client's reply to our server→client request

  switch (msg.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false } },
          authMethods: [{ id: "mock", name: "Mock Login", description: null }],
          agentInfo: { name: "mock-agent", title: "Mock Agent" },
        },
      });
      break;

    case "session/new":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessionId: "mock-session-1",
          modes: {
            currentModeId: "default",
            availableModes: [
              { id: "default", name: "Default" },
              { id: "yolo", name: "YOLO" },
            ],
          },
        },
      });
      break;

    case "session/prompt": {
      if (process.env.ACP_MOCK_MODE === "timeout_prompt") return; // never respond
      const sessionId = msg.params.sessionId;
      const updates = [
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking..." } },
        {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          toolName: "read_file",
          title: "Reading a.ts",
          kind: "read",
          status: "pending",
          locations: [{ path: "a.ts", line: 1 }],
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "file body" } }],
        },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } },
        { sessionUpdate: "plan", entries: [{ content: "step 1", status: "completed" }] },
      ];
      for (const update of updates) {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
      }
      // Exercise the server→client request path (permission approval).
      send({
        jsonrpc: "2.0",
        id: "srv-req-1",
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: "tool-1", toolName: "run_shell_command" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      break;
    }

    case "session/cancel":
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "[cancelled]" } } },
      });
      break;

    default:
      if (msg.id !== undefined) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not supported: ${msg.method}` } });
      }
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch (error) {
        process.stderr.write(`[mock-agent] bad line: ${error.message}\n`);
      }
    }
  }
});
process.stdin.on("end", () => process.exit(0));