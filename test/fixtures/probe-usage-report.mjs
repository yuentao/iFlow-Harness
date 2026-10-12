// End-to-end probe for the acp-usage-report-refactor Mod (iFlowMods).
// Verifies against the VENDOR cli bundle (patched):
//   1) session/prompt settles with usage.lastRequestInputTokens > 0
//   2) IFLOW_USAGE_REPORT=0 suppresses the field (upstream byte-identical)
// Requires working credentials in ~/.iflow/settings.json (same as
// probe-agent-cancel.mjs — the vendored CLI reads the terminal config).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const ENTRY = "J:\\git\\iflow-harness\\vendor\\iflow-cli\\bundle\\entry.js";
const CWD = "J:\\git\\iflow-harness";

function runPrompt(extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, "--experimental-acp", "--stream"], {
      stdio: ["pipe", "pipe", "pipe"], cwd: CWD,
      env: { ...process.env, IFLOW_HARNESS: "1", ...extraEnv },
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
        // agent→client requests: answer harmlessly (permissions cancelled).
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } }) + "\n");
      }
    });
    child.stderr.on("data", () => {});
    const kill = () => { try { child.kill(); } catch {} };
    const hard = setTimeout(() => { kill(); reject(new Error("hard timeout 180s")); }, 180000);
    hard.unref?.();
    (async () => {
      try {
        await send("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
        const { sessionId } = await send("session/new", { cwd: CWD, mcpServers: [] });
        const result = await send("session/prompt", { sessionId, prompt: [{ type: "text", text: "Reply with exactly: ok" }] });
        clearTimeout(hard); kill();
        resolve(result);
      } catch (e) { clearTimeout(hard); kill(); reject(e); }
    })();
  });
}

const t0 = Date.now();
try {
  const r1 = await runPrompt({});
  console.log("[probe] default env prompt result:", JSON.stringify(r1));
  const u = r1?.usage?.lastRequestInputTokens;
  if (!(typeof u === "number" && u > 0)) throw new Error("expected usage.lastRequestInputTokens > 0, got: " + JSON.stringify(r1?.usage));
  console.log(`[probe] usage reported: ${u} tokens`);

  const r2 = await runPrompt({ IFLOW_USAGE_REPORT: "0" });
  console.log("[probe] IFLOW_USAGE_REPORT=0 prompt result:", JSON.stringify(r2));
  if (r2?.usage !== undefined) throw new Error("expected NO usage field when disabled, got: " + JSON.stringify(r2.usage));
  if (Object.keys(r2).sort().join(",") !== "stopReason") throw new Error("disabled response must be {stopReason} only, got keys: " + Object.keys(r2).join(","));

  console.log(`[probe] PASS (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(0);
} catch (e) {
  console.error("[probe] FAIL:", e.message);
  process.exit(1);
}
