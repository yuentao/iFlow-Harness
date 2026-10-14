// End-to-end probe for the acp-context-report-refactor Mod (iFlow-Mods).
// Verifies against the VENDOR cli bundle (patched):
//   1) session/new (startChat) writes the IFLOW_HARNESS_CONTEXT_FILE report
//   2) the report carries the FULL systemPrompt (v2: the final
//      systemInstruction; hierarchical memory + context-file bodies are
//      embedded in it, so nothing else is reported)
//   3) IFLOW_ACP_CONTEXT_REPORT=0 suppresses the file entirely
// No prompt is sent — startChat runs on session/new, so the probe costs zero
// tokens. Paths resolve relative to this file (cross-platform).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const ENTRY = path.join(REPO, "vendor", "iflow-cli", "bundle", "entry.js");
const CWD = REPO;

function runSession(extraEnv, reportFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, "--experimental-acp", "--stream"], {
      stdio: ["pipe", "pipe", "pipe"], cwd: CWD,
      env: { ...process.env, IFLOW_HARNESS: "1", IFLOW_HARNESS_CONTEXT_FILE: reportFile, ...extraEnv },
    });
    let id = 0;
    const pending = new Map();
    const send = (method, params) => {
      const mid = ++id;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
      return new Promise((res, rej) => pending.set(mid, { res, rej }));
    };
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); }
        return;
      }
      if (msg.method && msg.id !== undefined) {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } }) + "\n");
      }
    });
    child.stderr.on("data", () => {});
    const kill = () => { try { child.kill("SIGKILL"); } catch {} };
    const hard = setTimeout(() => { kill(); reject(new Error("hard timeout 120s")); }, 120000);
    hard.unref?.();
    (async () => {
      try {
        await send("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
        const { sessionId } = await send("session/new", { cwd: CWD, mcpServers: [] });
        // startChat runs inside session/new; give the atomic write a beat.
        let report = null;
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          try { report = JSON.parse(fs.readFileSync(reportFile, "utf8")); break; }
          catch { await new Promise((r) => setTimeout(r, 250)); }
        }
        clearTimeout(hard); kill();
        resolve({ sessionId, report });
      } catch (e) { clearTimeout(hard); kill(); reject(e); }
    })();
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-probe-"));
const t0 = Date.now();
try {
  // 1) default env: report appears with the full system prompt
  const f1 = path.join(tmp, "report.json");
  const { report: r1 } = await runSession({}, f1);
  if (!r1) throw new Error("report file never appeared");
  if (r1.version !== 2) throw new Error("unexpected report version: " + r1.version);
  if (!(typeof r1.systemPrompt === "string" && r1.systemPrompt.length > 1000)) {
    throw new Error("systemPrompt missing or suspiciously short: " + (r1.systemPrompt ?? "").length);
  }
  // Hierarchical memory (incl. this repo's AGENTS.md body) must be embedded
  // in the reported systemPrompt — that is the whole point of reporting only
  // the final systemInstruction (P0e appends the joined memory).
  if (!r1.systemPrompt.includes("# AGENTS.md")) {
    throw new Error("AGENTS.md body not embedded in systemPrompt");
  }
  console.log(`[probe] report: systemPrompt=${r1.systemPrompt.length}ch (memory embedded)`);

  // 2) disabled: no file at all
  const f2 = path.join(tmp, "disabled.json");
  await runSession({ IFLOW_ACP_CONTEXT_REPORT: "0" }, f2);
  if (fs.existsSync(f2)) throw new Error("report written despite IFLOW_ACP_CONTEXT_REPORT=0");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`[probe] PASS (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(0);
} catch (e) {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.error("[probe] FAIL:", e.message);
  process.exit(1);
}
