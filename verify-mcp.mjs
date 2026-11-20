#!/usr/bin/env node
/**
 * Minimal verification script: CLI-side MCP tool invocation in a session.
 *
 * Connects to the vendored CLI (NO disableMcpServers → MCP servers from
 * settings.json + the session request are kept), creates a session passing
 * mcpServers, queries _iflow/mcp/status to observe server connection state
 * and discovered tools, then sends a web-search prompt with MCP tool
 * permission allowed and observes whether the model invokes an MCP tool.
 *
 * Usage: node verify-mcp.mjs
 */

import { AcpClient } from "./dist/src/acp/client.js";
import { buildAcpCommand, resolveVendoredEntry } from "./dist/src/acp/cli-locator.js";

const root = process.cwd();
const entry = resolveVendoredEntry(root);
// No disableMcpServers / mcpServerNames → no --allowed-mcp-server-names flag,
// so the CLI keeps every configured MCP server (settings + session request).
const { command, args: acpArgs } = buildAcpCommand(entry);

const mcpServers = [
  {
    name: "firecrawl",
    type: "http",
    url: "https://mcp.firecrawl.dev/v2/mcp",
    headers: { Authorization: "Bearer [REDACTED]" },
  },
];

const toolEvents = [];
const textChunks = [];

const client = new AcpClient(
  { command, args: acpArgs, cwd: root },
  {
    onSessionUpdate: (n) => {
      const u = n.update;
      if (u.sessionUpdate === "agent_message_chunk") {
        const t = String(u.content?.text ?? "");
        textChunks.push(t);
        process.stdout.write(t);
      } else if (u.sessionUpdate?.startsWith("tool_call")) {
        toolEvents.push(u);
        console.log(
          `\n[tool] ${u.sessionUpdate} tool=${u.toolName ?? "-"} status=${u.status ?? "-"} args=${JSON.stringify(u.args ?? {}).slice(0, 160)}`,
        );
      } else if (u.sessionUpdate) {
        console.log(`\n[update] ${u.sessionUpdate}`);
      }
    },
    onStderr: (line) => console.error(`[stderr] ${line}`),
    onExit: (code, signal) => console.error(`\n[verify] agent exit code=${code} signal=${signal}`),
    onRequestPermission: async (req) => {
      const tn = req.toolCall?.toolName ?? "?";
      const allowOpt = (req.options ?? []).find(
        (o) => o.kind === "allow_once" || o.kind === "allow_always",
      );
      const optionId = allowOpt?.optionId ?? req.options?.[0]?.optionId ?? "";
      console.log(`\n[permission] tool=${tn} → ALLOW (${optionId}) kinds=${(req.options ?? []).map((o) => o.kind).join(",")}`);
      return { outcome: { outcome: "selected", optionId } };
    },
  },
);

let failed = false;
try {
  const init = await client.connect();
  console.log(`\n[verify] initialize OK: protocolVersion=${init.protocolVersion} agent=${init.agentInfo?.name ?? "?"}`);

  const session = await client.newSession({ cwd: root, mcpServers });
  console.log(`[verify] session OK: ${session.sessionId}`);

  // Query MCP status to observe server connection state + discovered tools.
  let mcpStatus;
  try {
    mcpStatus = await client.mcpStatus(session.sessionId);
    console.log(`\n[verify] mcpStatus available=${mcpStatus.available} reason=${mcpStatus.reason ?? "-"}`);
    console.log(`[verify] discoveryState=${mcpStatus.discoveryState ?? "-"}`);
    for (const [name, srv] of Object.entries(mcpStatus.servers ?? {})) {
      console.log(
        `[verify] server ${name}: status=${srv.status} toolCount=${srv.toolCount} promptCount=${srv.promptCount} ` +
          `disabled=${srv.disabled} blocked=${srv.blocked} error=${srv.error ?? "-"} errorKind=${srv.errorKind ?? "-"}`,
      );
      for (const t of srv.tools ?? []) {
        console.log(`[verify]   tool ${t.name} schemaOmitted=${t.schemaOmitted} desc=${t.description ?? "-"}`);
      }
    }
  } catch (e) {
    console.log(`\n[verify] mcpStatus ERROR: ${e?.message ?? e}`);
  }

  // Send a web-search prompt that should encourage MCP tool use.
  console.log(`\n[verify] prompt (web search via MCP) ---`);
  const result = await client.prompt({
    sessionId: session.sessionId,
    prompt: [
      {
        type: "text",
        text:
          "请使用 MCP 搜索工具（firecrawl）搜索“2026 年 iFlow 最新动态”，并用中文简要总结。不要使用 curl，不要直接回答，必须调用搜索工具。",
      },
    ],
  });
  console.log(`\n--- end (stopReason=${result.stopReason}) ---`);
  console.log(`\n[verify] total tool_call events: ${toolEvents.length}`);
  console.log(`[verify] mcp tool events: ${toolEvents.filter((e) => String(e.toolName ?? "").startsWith("mcp") || String(e.toolName ?? "").includes("firecrawl")).length}`);
  console.log(`\n[verify] agent text length: ${textChunks.join("").length} chars`);
} catch (error) {
  failed = true;
  console.error(`\n[verify] FAIL: ${error?.message ?? error}`);
} finally {
  await client.dispose();
}

process.exit(failed ? 1 : 0);