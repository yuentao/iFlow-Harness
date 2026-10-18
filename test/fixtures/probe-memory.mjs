#!/usr/bin/env node
/**
 * Phase 0 probe — verify the CLI-side memory contract the F3 memory manager
 * builds on. Run after `npm run build` (imports dist/src/acp/*.js):
 *
 *   node test/fixtures/probe-memory.mjs
 *
 * What it proves:
 *   1. Global memory is loaded from IFLOW_HOME/<context file> (default
 *      AGENTS.md), not only from memory.md.
 *   2. Project AGENTS.md / IFLOW.md are loaded from the session cwd.
 *   3. `@relative/path` imports inside a memory file are expanded (this is how
 *      the generated `.iflow/knowledge/index.md` will be injected).
 *   4. A legacy `memory.md` is (or is not) loaded — the harness fallback used
 *      to read it; this probe records the actual behavior.
 *
 * The probe uses a temporary IFLOW_HOME with a COPY of the current
 * settings.json so the CLI can authenticate without touching the real home.
 * No prompt is sent: session/new assembles the system instruction and the
 * acp-context-report Mod writes it to IFLOW_HARNESS_CONTEXT_FILE.
 */

import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "..");

const { AcpClient } = await import(
  pathToFileURL(path.join(root, "dist", "src", "acp", "client.js")).href,
);
const { buildAcpCommand, resolveVendoredEntry } = await import(
  pathToFileURL(path.join(root, "dist", "src", "acp", "cli-locator.js")).href,
);

const stamp = Date.now();
const globalMarker = `HARNESS_GLOBAL_MEMORY_${stamp}`;
const tempGlobalMarker = `HARNESS_TEMP_HOME_MEMORY_${stamp}`;
const projectMarker = `HARNESS_PROJECT_MEMORY_${stamp}`;
const iflowMarker = `HARNESS_IFLOW_MEMORY_${stamp}`;
const knowledgeMarker = `HARNESS_KNOWLEDGE_${stamp}`;
const legacyMarker = `HARNESS_LEGACY_MEMORY_${stamp}`;

const tmp = await mkdtemp(path.join(os.tmpdir(), "iflow-memory-probe-"));
const home = path.join(tmp, "home");
const project = path.join(tmp, "project");
const report = path.join(tmp, "context-report.json");
const realGlobalDir = path.join(os.homedir(), ".iflow");
const realGlobalAgents = path.join(realGlobalDir, "AGENTS.md");
const realLegacyMemory = path.join(realGlobalDir, "memory.md");
const backups = [];

const result = {
  cliEntry: null,
  sessionId: null,
  reportWritten: false,
  systemPromptChars: 0,
  checks: {
    globalAgents: false,
    tempHomeIgnored: false,
    projectAgents: false,
    projectIflow: false,
    knowledgeImport: false,
    importFailed: false,
    legacyMemoryMd: false,
  },
  errors: [],
};

/** Temporarily create/append a real global memory file, restoring it in the
 * finally block. The CLI loader hardcodes os.homedir()/.iflow (probed), so a
 * temp IFLOW_HOME cannot prove the global path. */
async function withRealFile(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const existed = existsSync(file);
  const previous = existed ? await readFile(file, "utf8") : null;
  backups.push({ file, existed, previous });
  await writeFile(file, existed ? `${previous}\n\n${content}\n` : content, "utf8");
}

let client;
let disposing = false;
try {
  await mkdir(home, { recursive: true });
  await mkdir(path.join(project, ".iflow", "knowledge"), { recursive: true });

  const realSettings = path.join(os.homedir(), ".iflow", "settings.json");
  if (existsSync(realSettings)) {
    await copyFile(realSettings, path.join(home, "settings.json"));
  }

  // The loader reads os.homedir()/.iflow regardless of IFLOW_HOME (probed):
  // write the real global files temporarily, and keep a temp-home marker to
  // prove it is ignored.
  await withRealFile(realGlobalAgents, `# Global memory\n\n${globalMarker}`);
  await withRealFile(realLegacyMemory, `# Legacy memory\n\n${legacyMarker}`);
  await writeFile(
    path.join(home, "AGENTS.md"),
    `# Temp home memory\n\n${tempGlobalMarker}\n`,
    "utf8",
  );
  await writeFile(
    path.join(project, "AGENTS.md"),
    `# Project memory\n\n${projectMarker}\n\n@.iflow/knowledge/index.md\n`,
    "utf8",
  );
  await writeFile(
    path.join(project, "IFLOW.md"),
    `# IFLOW memory\n\n${iflowMarker}\n`,
    "utf8",
  );
  await writeFile(
    path.join(project, ".iflow", "knowledge", "index.md"),
    `# Project knowledge\n\n${knowledgeMarker}\n`,
    "utf8",
  );

  const entry = resolveVendoredEntry(root);
  result.cliEntry = entry;
  const { command, args } = buildAcpCommand(entry);

  client = new AcpClient(
    {
      command,
      args,
      cwd: project,
      env: {
        ...process.env,
        IFLOW_HOME: home,
        IFLOW_HARNESS: "1",
        IFLOW_HARNESS_CONTEXT_FILE: report,
      },
    },
    {
      onSessionUpdate: () => {},
      onStderr: (line) => {
        console.error(`[probe][stderr] ${line}`);
      },
      onExit: (code, signal) => {
        if (!disposing && code !== 0 && code !== null) {
          console.error(`[probe] CLI exit code=${code} signal=${signal}`);
        }
      },
      onRequestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    },
  );

  console.error("[probe] connecting…");
  await client.connect();
  console.error("[probe] connected; creating session…");
  const session = await client.newSession({ cwd: project, mcpServers: [] });
  console.error("[probe] session created");
  result.sessionId = session.sessionId;

  for (let i = 0; i < 20 && !existsSync(report); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!existsSync(report)) throw new Error(`context report missing: ${report}`);
  result.reportWritten = true;

  const payload = JSON.parse(await readFile(report, "utf8"));
  const prompt = typeof payload.systemPrompt === "string" ? payload.systemPrompt : "";
  result.systemPromptChars = prompt.length;

  result.checks.globalAgents = prompt.includes(globalMarker);
  result.checks.tempHomeIgnored = !prompt.includes(tempGlobalMarker);
  result.checks.projectAgents = prompt.includes(projectMarker);
  result.checks.projectIflow = prompt.includes(iflowMarker);
  result.checks.knowledgeImport = prompt.includes(knowledgeMarker);
  result.checks.importFailed = /<!-- Import failed:/i.test(prompt);
  result.checks.legacyMemoryMd = prompt.includes(legacyMarker);

  const where = (marker) => {
    const i = prompt.indexOf(marker);
    return i === -1 ? "absent" : `offset ${i}`;
  };
  console.log("[probe-memory] CLI:", entry);
  console.log("[probe-memory] session:", result.sessionId);
  console.log("[probe-memory] systemPrompt chars:", result.systemPromptChars);
  console.log("[probe-memory] global AGENTS.md:", result.checks.globalAgents ? `present (${where(globalMarker)})` : "absent");
  console.log("[probe-memory] temp IFLOW_HOME ignored:", result.checks.tempHomeIgnored ? "yes" : "NO");
  console.log("[probe-memory] project AGENTS.md:", result.checks.projectAgents ? `present (${where(projectMarker)})` : "absent");
  console.log("[probe-memory] project IFLOW.md:", result.checks.projectIflow ? `present (${where(iflowMarker)})` : "absent");
  console.log("[probe-memory] @import knowledge:", result.checks.knowledgeImport ? `present (${where(knowledgeMarker)})` : "absent");
  console.log("[probe-memory] import failed marker:", result.checks.importFailed ? "YES" : "no");
  console.log("[probe-memory] legacy memory.md:", result.checks.legacyMemoryMd ? "loaded" : "not loaded");
} catch (error) {
  result.errors.push(String(error?.stack ?? error?.message ?? error));
  console.error("[probe-memory] FAIL:", error?.stack ?? error);
  if (client) {
    try {
      const dump = path.join(root, "test", "fixtures", "probe-memory-context.txt");
      if (existsSync(report)) {
        const payload = JSON.parse(await readFile(report, "utf8"));
        await writeFile(dump, String(payload.systemPrompt ?? ""), "utf8");
        console.error(`[probe-memory] context dump: ${dump}`);
      }
    } catch {
      /* best effort */
    }
  }
} finally {
  disposing = true;
  if (client) await client.dispose().catch(() => {});
  for (const { file, existed, previous } of backups.reverse()) {
    try {
      if (existed && previous !== null) await writeFile(file, previous, "utf8");
      else await rm(file, { force: true });
    } catch (error) {
      result.errors.push(`restore ${file}: ${String(error?.message ?? error)}`);
    }
  }
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log("[probe-memory] result:", JSON.stringify(result, null, 2));
process.exit(
  result.errors.length === 0 &&
    result.checks.globalAgents &&
    result.checks.tempHomeIgnored &&
    result.checks.projectAgents &&
    result.checks.projectIflow &&
    result.checks.knowledgeImport &&
    !result.checks.importFailed
    ? 0
    : 1,
);
