// End-to-end probe for the mcp-status-refactor Mod (iFlowMods), run against
// the VENDOR cli bundle (patched). Verifies:
//   1) `_iflow/mcp/status` answers {available:true, discoveryState, servers}
//      (servers may be {} when settings.json configures none — availability
//      is the contract under test; per-server entries carry status/toolCount)
//   2) IFLOW_MCP_STATUS=0 answers {available:false, reason:"disabled"}
// No prompt is sent (no token spend, no credentials needed).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const ENTRY = "/Users/yuantao/dev/iFlow-Harness/vendor/iflow-cli/bundle/entry.js";
const CWD = "/Users/yuantao/dev/iFlow-Harness";

function runStatus(extraEnv) {
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
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } }) + "\n");
      }
    });
    child.stderr.on("data", () => {});
    const kill = () => { try { child.kill(); } catch {} };
    const hard = setTimeout(() => { kill(); reject(new Error("hard timeout 60s")); }, 60000);
    hard.unref?.();
    (async () => {
      try {
        await send("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
        const { sessionId } = await send("session/new", { cwd: CWD, mcpServers: [] });
        const result = await send("_iflow/mcp/status", { sessionId });
        clearTimeout(hard); kill();
        resolve(result);
      } catch (e) { clearTimeout(hard); kill(); reject(e); }
    })();
  });
}

const t0 = Date.now();
try {
  const r1 = await runStatus({});
  console.log("[probe] default env status result:", JSON.stringify(r1));
  if (r1?.available !== true) throw new Error("expected available:true, got: " + JSON.stringify(r1));
  if (typeof r1.discoveryState !== "string") throw new Error("expected discoveryState string, got: " + JSON.stringify(r1));
  for (const [name, view] of Object.entries(r1.servers ?? {})) {
    if (!typeof view.status === "string" || typeof view.toolCount !== "number")
      throw new Error(`server ${name} malformed: ` + JSON.stringify(view));
  }
  console.log(`[probe] status reported: ${Object.keys(r1.servers ?? {}).length} servers, discovery=${r1.discoveryState}`);

  const r2 = await runStatus({ IFLOW_MCP_STATUS: "0" });
  console.log("[probe] IFLOW_MCP_STATUS=0 status result:", JSON.stringify(r2));
  if (r2?.available !== false || r2?.reason !== "disabled")
    throw new Error("expected {available:false,reason:disabled}, got: " + JSON.stringify(r2));

  console.log(`[probe] PASS (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(0);
} catch (e) {
  console.error("[probe] FAIL:", e.message);
  process.exit(1);
}
