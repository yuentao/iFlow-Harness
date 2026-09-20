#!/usr/bin/env node
/**
 * Minimal mock ACP agent for integration tests: speaks NDJSON JSON-RPC on
 * stdio, answers initialize/session/new, streams a scripted set of
 * session/update events on prompt, and issues a server→client
 * session/request_permission call. Also supports scripted failure injection
 * via ACP_MOCK_MODE env ("timeout_prompt" never answers a prompt;
 * "sandbox_escape" makes the "agent" ask the client to fs/write_text_file a
 * path outside the session dir, so tests can verify boundary rejection).
 */

let buffer = "";
const pendingEscapeReplies = []; // resolvers for sandbox_escape write replies
const escapeReplies = []; // collected client replies (asserted by the test)

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function handle(msg) {
  const isResponse = msg.id !== undefined && msg.method === undefined;
  if (isResponse) {
    // The client's reply to our fs/write_text_file probe (id "fs-escape-1").
    if (msg.id === "fs-escape-1") pendingEscapeReplies.shift()?.(msg);
    return; // client's reply to our server→client request
  }

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

      let escapeNote = null;
      if (process.env.ACP_MOCK_MODE === "sandbox_escape") {
        // A1 guardrail probe: the agent asks the client to write outside the
        // session dir. The client must reply with an error, not touch disk.
        const escape = await new Promise((resolve) => {
          pendingEscapeReplies.push(resolve);
          send({
            jsonrpc: "2.0",
            id: "fs-escape-1",
            method: "fs/write_text_file",
            params: { sessionId, path: "../../escape.txt", content: "pwned" },
          });
        });
        escapeReplies.push(escape);
        escapeNote = escape.error
          ? `sandbox-blocked:${escape.error.message}`
          : `sandbox-allowed:${JSON.stringify(escape.result)}`;
      }
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
        ...(escapeNote ? [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: escapeNote } }] : []),
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

    case "fs/read_text_file": {
      const { path: p, content } = msg.params;
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: process.env.ACP_MOCK_MODE === "sandbox_escape" ? (p ? `resolved:${p}` : content) : `mock read of ${p}` },
      });
      break;
    }

    case "fs/write_text_file": {
      // The mock never touches disk: it only acks. Boundary rejection is the
      // client's job, so a `sandbox_escape` probe that reaches this handler
      // still gets a plain result (the client rejects before calling us).
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
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