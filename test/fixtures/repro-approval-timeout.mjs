// Repro: approval timeout (delayed cancelled response) → does session/prompt settle?
// Mirrors panel.ts requestPermissionFromUser's timeout path: after a delay,
// respond { outcome: { outcome: "cancelled" } }. Watchdog reports whether the
// in-flight session/prompt ever settles afterwards.
import { AcpClient } from "../../dist/src/acp/client.js";
import { buildAcpCommand, locateIflowEntry } from "../../dist/src/acp/cli-locator.js";

const entry = process.env.IFLOW_CLI_ENTRY ?? (await locateIflowEntry());
if (!entry) {
  console.error("FAIL: no CLI entry");
  process.exit(2);
}
console.log("[repro] CLI entry:", entry);
const { command, args } = buildAcpCommand(entry);

const RESPONSE_DELAY_MS = Number(process.env.REPRO_DELAY_MS ?? 8000);
const WATCHDOG_MS = Number(process.env.REPRO_WATCHDOG_MS ?? 120000);

let promptSettled = false;
let promptResult = null;
let lastUpdateAt = Date.now();
let permissionRespondedAt = 0;

const client = new AcpClient(
  { command, args, cwd: process.cwd(), promptTimeoutMs: 0 },
  {
    onSessionUpdate: (n) => {
      lastUpdateAt = Date.now();
      const u = n.update;
      const label = u?.sessionUpdate;
      if (label === "tool_call" || label === "tool_call_update") {
        console.log(`[update] ${label} tool=${u.toolName} status=${u.status}`);
      } else if (label === "agent_message_chunk") {
        console.log(`[update] chunk: ${JSON.stringify(String(u.content?.text ?? "").slice(0, 60))}`);
      } else if (label === "agent_thought_chunk") {
        console.log(`[update] thought: ${JSON.stringify(String(u.content?.text ?? "").slice(0, 60))}`);
      } else {
        console.log(`[update] ${label ?? JSON.stringify(u).slice(0, 120)}`);
      }
    },
    onStderr: (line) => console.error(`[stderr] ${line.slice(0, 200)}`),
    onExit: (code, signal) => console.error(`[repro] agent exit code=${code} signal=${signal}`),
    onRequestPermission: async (req) => {
      console.log(
        `[repro] permission request tool=${JSON.stringify(req.toolCall?.toolName ?? "")} ` +
          `title=${JSON.stringify(String(req.toolCall?.title ?? "")).slice(0, 80)}`,
      );
      console.log(`[repro] options: ${JSON.stringify(req.options)}`);
      await new Promise((r) => setTimeout(r, RESPONSE_DELAY_MS));
      permissionRespondedAt = Date.now();
      console.log(`[repro] responding {outcome:cancelled} after ${RESPONSE_DELAY_MS}ms (simulates approval timeout)`);
      return { outcome: { outcome: "cancelled" } };
    },
  },
);

try {
  await client.connect();
  console.log("[repro] connected");
  const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
  console.log("[repro] session:", session.sessionId);
  // Force the confirmation path: default mode = every shell command asks.
  try {
    const m = await client.setMode(session.sessionId, "default");
    console.log("[repro] setMode(default) →", JSON.stringify(m));
  } catch (e) {
    console.log("[repro] setMode failed:", JSON.stringify(e).slice(0, 200));
  }

  const promptPromise = client
    .prompt({
      sessionId: session.sessionId,
      prompt: [
        {
          type: "text",
          text: "你必须调用 run_shell_command 工具执行命令 echo hi，禁止直接用文本回答，现在就调用工具。",
        },
      ],
    })
    .then(
      (r) => {
        promptSettled = true;
        promptResult = r;
        console.log(`[repro] PROMPT SETTLED stopReason=${r.stopReason}`);
      },
      (e) => {
        promptSettled = true;
        promptResult = { rejected: true, error: e };
        console.log(`[repro] PROMPT REJECTED: ${JSON.stringify(e).slice(0, 300)}`);
      },
    );

  const t0 = Date.now();
  while (!promptSettled && Date.now() - t0 < WATCHDOG_MS) {
    await new Promise((r) => setTimeout(r, 2000));
    if (permissionRespondedAt > 0) {
      const since = Math.round((Date.now() - permissionRespondedAt) / 1000);
      const idle = Math.round((Date.now() - lastUpdateAt) / 1000);
      if (since % 10 === 0 && since > 0) {
        console.log(`[repro] watchdog: ${since}s since cancelled response, ${idle}s since last update, settled=${promptSettled}`);
      }
    }
  }
  if (!promptSettled) {
    console.log(`[repro] RESULT: STUCK — prompt never settled within ${WATCHDOG_MS / 1000}s`);
  } else {
    console.log(`[repro] RESULT: settled — ${JSON.stringify(promptResult).slice(0, 300)}`);
  }
  void promptPromise;
} catch (error) {
  console.error("[repro] FAIL:", error?.message ?? error);
} finally {
  await client.dispose();
}
process.exit(0);
