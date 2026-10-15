// End-to-end probe for the web-search-refactor Mod (iFlowMods).
// Verifies against the VENDOR cli bundle (patched):
//   1) IFLOW_WS_ENGINES=bing: prompt forces a web_search call; the turn
//      settles and the tool output carries the loader's own returnDisplay
//      marker ("Searched web: ... (N results)" — session/update tool_call_update
//      events carry returnDisplay text only, not llmContent) with NO upstream
//      auth-rejection text ("Search capability"/"90402") — proves the scraping
//      chain replaced the iFlow-platform-key-only endpoint (probed 2026-10-15:
//      third-party keys rejected with {"success":false,"code":"90402"}).
//   2) IFLOW_WEB_SEARCH=0: loader reverts entirely (upstream path; with an
//      iFlow terminal key this may still succeed — logged, not asserted).
// Requires working credentials in ~/.iflow/settings.json (same assumption as
// probe-usage-report.mjs — the vendored CLI reads the terminal config).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const ENTRY = process.env.IFLOW_CLI_ENTRY || "/Users/pandorastudio/git/iFlow-harness/vendor/iflow-cli/bundle/entry.js";
const CWD = process.cwd();

function runPrompt(extraEnv, promptText) {
  const updates = [];
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
      if (msg.method === "session/update" && msg.params !== undefined) {
        updates.push(JSON.stringify(msg.params));
      }
      if (msg.method && msg.id !== undefined) {
        // agent→client requests: answer harmlessly (permissions cancelled).
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } }) + "\n");
      }
    });
    child.stderr.on("data", () => {});
    const kill = () => { try { child.kill(); } catch {} };
    const hard = setTimeout(() => { kill(); reject(new Error("hard timeout 240s")); }, 240000);
    hard.unref?.();
    (async () => {
      try {
        await send("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
        const { sessionId } = await send("session/new", { cwd: CWD, mcpServers: [] });
        const result = await send("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: promptText }],
        });
        clearTimeout(hard); kill();
        resolve({ result, updates });
      } catch (e) { clearTimeout(hard); kill(); reject(e); }
    })();
  });
}

const SEARCH_PROMPT =
  'Use the web_search tool to search the web for "iFlow harness vscode" and reply with the first result title only.';

const t0 = Date.now();
try {
  const { result: r1, updates: u1 } = await runPrompt({ IFLOW_WS_ENGINES: "bing" }, SEARCH_PROMPT);
  const allText = u1.join("\n");
  console.log("[probe] bing-chain prompt result:", JSON.stringify(r1));
  console.log("[probe] session/update count:", u1.length);
  if (!/"stopReason":"end_turn"/.test(JSON.stringify(r1))) throw new Error("prompt must settle end_turn, got: " + JSON.stringify(r1));
  if (!/web_search/.test(allText)) throw new Error("no web_search tool call seen in session/update events");
  if (/Search capability|90402/.test(allText)) throw new Error("upstream auth-rejection text still present — loader did not replace the backend");
  if (!/Searched web:/.test(allText)) throw new Error("loader returnDisplay marker (Searched web:) missing in tool output");
  console.log("[probe] bing chain replaced upstream backend OK");

  const { result: r2, updates: u2 } = await runPrompt({ IFLOW_WEB_SEARCH: "0" }, SEARCH_PROMPT);
  console.log("[probe] IFLOW_WEB_SEARCH=0 prompt result:", JSON.stringify(r2));
  console.log(`[probe] PASS (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(0);
} catch (e) {
  console.error("[probe] FAIL:", e.message);
  process.exit(1);
}