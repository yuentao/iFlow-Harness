#!/usr/bin/env node
/**
 * M0 harness: drive the real iFlow CLI over ACP.
 *
 * Usage:
 *   node scripts/harness.mjs                 # handshake + session + prompt
 *   node scripts/harness.mjs --record        # also record the wire log to test/fixtures
 *   IFLOW_CLI_ENTRY=<path> node scripts/harness.mjs
 *
 * Steps: initialize → newSession → prompt("Say OK and nothing else.")
 * → print streaming updates → prompt response summary → dispose.
 * No tool calls are allowed (permission requests are denied), so the run is
 * safe and does not modify the workspace.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../dist/src/acp/client.js";
import { buildAcpCommand, locateIflowEntry } from "../dist/src/acp/cli-locator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const record = args.includes("--record");
const probe = args.includes("--probe");
const promptText = args.find((a, i) => i > 0 && args[i - 1] === "--prompt") ?? "Reply with exactly: OK";

// locateIflowEntry is async (spawn probes must not block an event loop).
const entry = process.env.IFLOW_CLI_ENTRY ?? (await locateIflowEntry());
if (!entry) {
  console.error("[harness] FAIL: could not locate iflow CLI entry.js. Set IFLOW_CLI_ENTRY.");
  process.exit(2);
}
console.log(`[harness] CLI entry: ${entry}`);

const { command, args: acpArgs } = buildAcpCommand(entry);
const wire = [];
const wireTap = (direction, message) => {
  if (record) wire.push({ t: Date.now(), dir: direction, msg: message });
};

const client = new AcpClient(
  { command, args: acpArgs, cwd: root, wireTap },
  {
    onSessionUpdate: (n) => {
      const label = n.update?.sessionUpdate;
      if (label === "agent_message_chunk") {
        process.stdout.write(String(n.update.content?.text ?? ""));
      } else if (label === "agent_thought_chunk") {
        process.stdout.write(`[thought] ${String(n.update.content?.text ?? "").slice(0, 80)}\n`);
      } else if (label?.startsWith("tool_call")) {
        console.log(`\n[tool] ${label} ${n.update.toolName ?? ""} ${n.update.status ?? ""}`);
      } else {
        console.log(`\n[update] ${label ?? JSON.stringify(n.update).slice(0, 120)}`);
      }
    },
    onStderr: (line) => console.error(`[stderr] ${line}`),
    onExit: (code, signal) => console.error(`[harness] agent exit code=${code} signal=${signal}`),
    onRequestPermission: async (req) => {
      console.log(`[harness] permission requested for tool=${req.toolCall?.toolName} → denied (safe mode)`);
      return { outcome: { outcome: "cancelled" } };
    },
  },
);

const summary = {
  startedAt: new Date().toISOString(),
  cliEntry: entry,
  cliVersion: null,
  protocolVersion: null,
  authMethods: [],
  agentCapabilities: null,
  agentInfo: null,
  sessionId: null,
  modes: null,
  currentModel: null,
  modelsCount: null,
  commandsCount: null,
  promptStopReason: null,
  messageText: "",
  errors: [],
};

try {
  const init = await client.connect();
  summary.protocolVersion = init.protocolVersion;
  summary.authMethods = (init.authMethods ?? []).map((m) => ({ id: m.id, name: m.name }));
  summary.agentCapabilities = init.agentCapabilities ?? null;
  summary.agentInfo = init.agentInfo ?? null;
  summary.cliVersion = init.agentInfo?.version ?? null;
  console.log(`\n[harness] initialize OK: protocolVersion=${init.protocolVersion} agent=${init.agentInfo?.name ?? "?"}`);
  console.log(`[harness] authMethods: ${summary.authMethods.map((m) => m.id).join(", ")}`);

  const session = await client.newSession({ cwd: root, mcpServers: [] });
  summary.sessionId = session.sessionId;
  summary.modes = session.modes ?? null;
  summary.modelsCount = session._meta?.models?.availableModels?.length ?? 0;
  summary.currentModel = session._meta?.models?.currentModelId ?? null;
  summary.commandsCount = session._meta?.availableCommands?.length ?? 0;
  console.log(`[harness] session OK: ${session.sessionId}`);
  console.log(`[harness] modes: ${session.modes?.availableModes?.map((m) => m.id).join("/") ?? "?"} (current=${session.modes?.currentModeId})`);
  console.log(`[harness] models=${summary.modelsCount} slashCommands=${summary.commandsCount}`);

  if (probe) {
    // Wire-behavior probe for methods M0 marked "verify on wire".
    // No prompt is sent, so no tokens are consumed.
    console.log("\n[harness] === probe: set_mode ===");
    for (const modeId of ["smart", "default", "plan", "yolo"]) {
      try {
        const r = await client.setMode(session.sessionId, modeId);
        console.log(`[probe] set_mode(${modeId}) → ${JSON.stringify(r)}`);
      } catch (error) {
        console.log(`[probe] set_mode(${modeId}) → ERROR ${JSON.stringify(error)}`);
      }
    }
    console.log("\n[harness] === probe: set_model ===");
    const currentModel = session._meta?.models?.currentModelId;
    for (const modelId of [currentModel, "test-probe-nonexistent-model"].filter(Boolean)) {
      try {
        const r = await client.setModel(session.sessionId, modelId);
        console.log(`[probe] set_model(${modelId}) → ${JSON.stringify(r)}`);
      } catch (error) {
        console.log(`[probe] set_model(${modelId}) → ERROR ${JSON.stringify(error)}`);
      }
    }
    const firstCatalogModel = session._meta?.models?.availableModels?.[0]?.id;
    if (firstCatalogModel) {
      try {
        const r = await client.setModel(session.sessionId, firstCatalogModel);
        console.log(`[probe] set_model(${firstCatalogModel}) → ${JSON.stringify(r)}`);
      } catch (error) {
        console.log(`[probe] set_model(${firstCatalogModel}) → ERROR ${JSON.stringify(error)}`);
      }
    }
    console.log("\n[harness] === probe: set_think ===");
    try {
      const r = await client.setThink(session.sessionId, true, "think");
      console.log(`[probe] set_think(true) → ${JSON.stringify(r)}`);
    } catch (error) {
      console.log(`[probe] set_think(true) → ERROR ${JSON.stringify(error)}`);
    }
    summary.finishedAt = new Date().toISOString();
    console.log("\n[harness] probe complete");
    await client.dispose();
    process.exit(0);
  }

  console.log(`\n[harness] prompt: "${promptText}"\n--- agent output ---`);
  const result = await client.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: promptText }],
  });
  summary.promptStopReason = result.stopReason;
  console.log(`\n--- end (stopReason=${result.stopReason}) ---`);
} catch (error) {
  summary.errors.push(String(error?.message ?? error));
  console.error(`\n[harness] FAIL:`, error?.message ?? error);
} finally {
  await client.dispose();
}

summary.finishedAt = new Date().toISOString();
delete summary.messageText;

console.log("\n[harness] === M0 summary ===");
console.log(JSON.stringify(summary, null, 2));

if (record) {
  const fixturesDir = path.join(root, "test", "fixtures");
  await mkdir(fixturesDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const wireFile = path.join(fixturesDir, `acp-wire-${stamp}.ndjson`);
  await writeFile(wireFile, wire.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  await writeFile(path.join(fixturesDir, `m0-summary-${stamp}.json`), JSON.stringify(summary, null, 2));
  console.log(`[harness] fixture written: ${wireFile} (${wire.length} messages)`);
}

process.exit(summary.errors.length === 0 && summary.promptStopReason ? 0 : 1);
