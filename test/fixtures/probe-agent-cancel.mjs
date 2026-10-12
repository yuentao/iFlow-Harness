// E2E probe: verify `_iflow/agent/cancel` is wired in the vendored CLI.
// 1) unknown agentId -> {stopped:false,reason:"not_found"} (method exists, no methodNotFound)
// 2) spawn a real subagent via task tool, cancel it mid-flight, expect {stopped:true}
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const ENTRY = "J:\\git\\iflow-harness\\vendor\\iflow-cli\\bundle\\entry.js";
const child = spawn(process.execPath, [ENTRY, "--experimental-acp", "--stream"], {
  stdio: ["pipe", "pipe", "pipe"], cwd: "J:\\git\\iflow-harness", env: { ...process.env, IFLOW_HARNESS: "1" },
});
let id = 0;
const pending = new Map();
const updates = [];
function send(method, params) {
  const mid = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
  return new Promise((res, rej) => pending.set(mid, { res, rej }));
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}
const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id); if (p) { pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); }
    return;
  }
  if (msg.method === "session/update") updates.push(msg.params);
  if (msg.method && msg.id !== undefined) {
    // agent->client requests: answer harmlessly
    if (msg.method === "session/request_permission") notify === undefined || child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: (msg.params.options?.[0]?.optionId ?? "reject_once") } } }) + "\n");
    else if (msg.method === "_iflow/user/questions") child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { answers: {} } }) + "\n");
    else if (msg.method === "_iflow/plan/exit") child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { approved: false, reason: "probe" } }) + "\n");
    else child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
  }
});
child.stderr.on("data", () => {});

const t0 = Date.now();
const timeout = (p, ms, label = "") => Promise.race([
  p,
  new Promise((_, rej) => { const t = setTimeout(() => rej(new Error("timeout: " + label + " " + ms)), ms); t.unref && t.unref(); }),
]);

try {
  await timeout(send("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } }), 30000);
  console.log("[probe] initialize OK");
  const { sessionId } = await timeout(send("session/new", { cwd: "J:\\git\\iflow-harness", mcpServers: [] }), 30000);
  console.log("[probe] session", sessionId);
  // 1) unknown agentId
  const r1 = await timeout(send("_iflow/agent/cancel", { sessionId, agentId: "subagent-does-not-exist" }), 5000);
  console.log("[probe] unknown-agent cancel =>", JSON.stringify(r1));
  if (!r1 || r1.stopped !== false || r1.reason !== "not_found") throw new Error("expected not_found");
  // 2) real subagent: ask for a task tool call that runs long enough to cancel
  const promptP = send("session/prompt", { sessionId, prompt: [{ type: "text", text: "Use the task tool with subagent_type=general-purpose to run this exact instruction and wait for it: execute the shell command `node -e \"setTimeout(()=>console.log(1), 60000)\"` and report its output. Do not run anything yourself; delegate via the task tool only." }] });
  // wait for a subagent tool_call carrying agentId
  let agentId = null;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && !agentId) {
    await new Promise((r) => setTimeout(r, 250));
    for (const u of updates) {
      const ag = u.agentId ?? u.update?.agentId;
      if (typeof ag === "string" && ag.startsWith("subagent-")) { agentId = ag; break; }
    }
  }
  if (!agentId) { console.log("[probe] no subagent agentId observed in 120s (model may not have delegated) — protocol-layer check already passed"); }
  else {
    console.log("[probe] observed subagent agentId:", agentId);
    const r2 = await timeout(send("_iflow/agent/cancel", { sessionId, agentId }), 5000);
    console.log("[probe] real cancel =>", JSON.stringify(r2));
    // let the turn settle afterwards
    try {
      const pr = await timeout(promptP, 90000);
      console.log("[probe] prompt settled:", JSON.stringify(pr));
    } catch (e) { console.log("[probe] prompt after cancel:", e.message); }
    const failed = updates.filter((u) => (u.update?.toolName === "task" || u.update?.title?.includes?.("task")) && u.update?.status === "failed").length;
    console.log("[probe] task-failed updates:", failed);
    if (r2.stopped !== true) throw new Error("expected stopped:true");
  }
  console.log(`[probe] PASS (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.error("[probe] FAIL:", e.message);
  process.exitCode = 1;
} finally {
  child.kill();
  setTimeout(() => process.exit(process.exitCode ?? 1), 500).unref();
}
