#!/usr/bin/env node
/**
 * Minimal MCP server used by `test/mcp-broker.test.ts`.
 *
 * Two modes:
 *  - default: stdio, newline-delimited JSON-RPC 2.0 on stdin/stdout. Every
 *    instance appends one line to `FAKE_MCP_SPAWN_LOG` at startup, which is how
 *    the tests prove N concurrent child sessions still mean ONE process per
 *    server.
 *  - `--ws`: local loopback WebSocket server (port written to
 *    `FAKE_MCP_WS_PORT_FILE`) speaking the same JSON-RPC frames. Fully offline.
 *
 * Tools:
 *  - `<name>_echo`  — echoes `text`
 *  - `<name>_slow`  — answers after 300ms (exercises concurrent fan-out)
 *
 * Proactive inbound requests (offline receive/reply proof): when
 * `FAKE_MCP_INBOUND_METHODS` is set (comma separated), the server sends one
 * server→client request per method right after the `initialize` reply. Any
 * reply it later receives (a frame with `id` but no `method`) is appended as a
 * JSON line to `FAKE_MCP_REPLY_LOG`. No real sampling/elicitation is claimed —
 * this only proves the broker received the request and sent a reply back.
 */
import { appendFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const nameArg = argv.indexOf("--name");
const name = nameArg >= 0 ? (argv[nameArg + 1] ?? "fake") : "fake";

if (process.env.FAKE_MCP_SPAWN_LOG) {
  try {
    appendFileSync(process.env.FAKE_MCP_SPAWN_LOG, `${name} ${process.pid}\n`);
  } catch {
    // Diagnostics only.
  }
}

let currentSocket = null;
/** Frames sent back to us for our own inbound requests (id, no method). */
function logReply(message) {
  if (!process.env.FAKE_MCP_REPLY_LOG) return;
  try {
    appendFileSync(process.env.FAKE_MCP_REPLY_LOG, `${JSON.stringify(message)}\n`);
  } catch {
    // Diagnostics only.
  }
}

function send(message) {
  const line = JSON.stringify(message);
  if (currentSocket) currentSocket.send(line);
  else process.stdout.write(`${line}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const inboundMethods = (process.env.FAKE_MCP_INBOUND_METHODS ?? "")
  .split(",")
  .map((method) => method.trim())
  .filter(Boolean);
let inboundSeq = 0;

/** Proactively push server→client requests (the upstream inbound channel). */
function sendInbound() {
  const prefix = process.env.FAKE_MCP_INBOUND_ID_PREFIX ?? "inbound";
  for (const method of inboundMethods) {
    inboundSeq += 1;
    send({ jsonrpc: "2.0", id: `${prefix}-${inboundSeq}`, method, params: { probe: method } });
  }
}

async function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      result(id, {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: `fake-${name}`, version: "1.0.0" },
      });
      sendInbound();
      return;
    case "notifications/initialized":
      return;
    case "tools/list":
      result(id, {
        tools: [
          {
            name: `${name}_echo`,
            description: `${name} echo`,
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
          {
            name: `${name}_slow`,
            description: `${name} slow echo`,
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      });
      return;
    case "tools/call": {
      const tool = params?.name;
      const text = params?.arguments?.text ?? "";
      if (tool === `${name}_slow`) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (tool !== `${name}_echo` && tool !== `${name}_slow`) {
        error(id, -32602, `unknown tool ${tool}`);
        return;
      }
      result(id, { content: [{ type: "text", text: `echo:${text}` }] });
      return;
    }
    case "prompts/list":
      result(id, { prompts: [] });
      return;
    case "resources/list":
      result(id, { resources: [] });
      return;
    case "ping":
      result(id, {});
      return;
    default:
      if (id !== undefined) error(id, -32601, `Method not found: ${method}`);
  }
}

function onFrame(raw) {
  let message;
  try {
    message = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(raw.toString("utf8"));
  } catch {
    return;
  }
  // A reply to one of OUR inbound requests: id + result/error, no method.
  // Never feed it back into handle() — that would start an error ping-pong.
  if (typeof message.method !== "string" && message.id !== undefined) {
    logReply(message);
    return;
  }
  void handle(message);
}

if (argv.includes("--ws")) {
  const { WebSocketServer } = await import("ws");
  const port = Number(process.env.FAKE_MCP_WS_PORT ?? 0);
  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  wss.on("listening", () => {
    const address = wss.address();
    if (process.env.FAKE_MCP_WS_PORT_FILE && address && typeof address === "object") {
      writeFileSync(process.env.FAKE_MCP_WS_PORT_FILE, String(address.port));
    }
  });
  wss.on("connection", (socket) => {
    currentSocket = socket;
    socket.on("message", (raw) => onFrame(raw));
    socket.on("close", () => {
      if (currentSocket === socket) currentSocket = null;
    });
  });
  const shutdown = () => wss.close();
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} else {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      onFrame(line);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}