#!/usr/bin/env node
/**
 * Minimal stdio MCP server used by `test/mcp-broker.test.ts`.
 *
 * Every instance appends one line to `FAKE_MCP_SPAWN_LOG` at startup, which is
 * how the tests prove that N concurrent child sessions still mean ONE process
 * per server. Tools:
 *  - `<name>_echo`  — echoes `text`
 *  - `<name>_slow`  — answers after 300ms (exercises concurrent fan-out)
 *
 * Speaks newline-delimited JSON-RPC 2.0 on stdio, like the real transports.
 */
import { appendFileSync } from "node:fs";

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

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
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

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line));
    } catch {
      // Ignore malformed frames.
    }
  }
});
process.stdin.on("end", () => process.exit(0));
