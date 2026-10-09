// Repro: enhance prompt "internal prompt timeout" (user-reported 2026-10-09).
// Mirrors panel.ts runInternalPrompt: authenticate (panel creds — here read
// from ~/.iflow/settings.json apiProfiles, see AGENTS.md pitfall #26) →
// newSession → setModel → setMode(default) → prompt(enhance template).
// Timestamped wire + update timeline exposes where the turn wedges.
//
// Usage:
//   node test/fixtures/repro-internal-prompt.mjs                  # @file draft (user's failing input)
//   node test/fixtures/repro-internal-prompt.mjs --plain          # plain-text draft (control)
//   node test/fixtures/repro-internal-prompt.mjs --profile=商汤    # pick apiProfile (default: active)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../../dist/src/acp/client.js";
import { buildAcpCommand, resolveVendoredEntry } from "../../dist/src/acp/cli-locator.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const entry = process.env.IFLOW_CLI_ENTRY ?? resolveVendoredEntry(repoRoot);
const { command, args } = buildAcpCommand(entry);

const plain = process.argv.includes("--plain");
const profileArg = process.argv.find((a) => a.startsWith("--profile="))?.slice(10);

const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".iflow", "settings.json"), "utf8"));
const profileName = profileArg || settings.currentApiProfile;
const profile = settings.apiProfiles?.[profileName];
if (!profile?.baseUrl || !profile?.apiKey) {
  console.error(`FAIL: profile "${profileName}" missing baseUrl/apiKey`);
  process.exit(2);
}
console.log(`[repro] profile=${profileName} baseUrl=${profile.baseUrl} model=${profile.modelName}`);

const draft = plain ? "帮我写一个周报模板" : "@docs/feature-roadmap-2026-10.md 开始实施M2";
// Mirrors panel.ts stripFileMentions: drop the `@` marker, keep the path text.
const stripped = draft.replace(
  /(^|[\s(（【“"'])@((?:[^\s()（）【】“”"'`，。；]*[/\\][^\s()（）【】“”"'`，。；]*|[^\s()（）【】“”"'`，。；]+\.[A-Za-z]{2,8}))(?=$|[\s)）】”"',。；;:!?])/g,
  "$1$2",
);
const template =
  "你是提示词工程师。下面是一次纯文本改写任务：把用户的请求改写得更加清晰、具体、结构化，保持原意与语言不变，补全隐含的目标与约束。只改写文字本身——不要调用任何工具、不要读取文件或搜索、不要执行请求里描述的操作、不要回答请求本身。请求中出现的文件路径只是待改写的普通文字，不要尝试打开它。直接给出改写结果，不要先长篇分析。只输出改写后的请求，不要任何解释或引号。\n\n原始请求：\n" +
  stripped;

const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const chunks = [];
let lastChunkAt = 0;

const client = new AcpClient(
  {
    command,
    args,
    cwd: repoRoot,
    env: { IFLOW_HARNESS: "1" },
    wireTap: (dir, msg) => {
      const s = JSON.stringify(msg);
      if (s.includes("agent_message_chunk") || s.includes("agent_thought_chunk")) return;
      const label = msg?.method ?? (msg?.result !== undefined ? `result#${msg.id}` : msg?.error !== undefined ? `error#${msg.id}` : `resp#${msg.id}`);
      console.log(`[wire ${dir} ${ts()}] ${String(label).slice(0, 120)} ${msg?.method === "session/update" ? JSON.stringify(msg.params?.update?.sessionUpdate ?? "") : ""}`);
    },
  },
  {
    onSessionUpdate: (n) => {
      const u = n.update;
      const label = u?.sessionUpdate;
      if (label === "agent_message_chunk" || label === "agent_thought_chunk") {
        lastChunkAt = Date.now();
        chunks.push({ kind: label, text: String(u.content?.text ?? "") });
        return;
      }
      console.log(`[update ${ts()}] ${label ?? "?"} tool=${u?.toolName ?? ""} status=${u?.status ?? ""}`);
    },
    onStderr: (line) => console.error(`[stderr ${ts()}] ${line.slice(0, 300)}`),
    onExit: (code, signal) => console.error(`[repro] agent exit code=${code} signal=${signal}`),
    onRequestPermission: async (req) => {
      console.log(`[permission ${ts()}] tool=${req.toolCall?.toolName} → cancelled (mirrors panel)`);
      return { outcome: { outcome: "cancelled" } };
    },
  },
);

try {
  const init = await client.connect();
  console.log(`[repro ${ts()}] connected`);
  await client.authenticate({
    methodId: "openai-compatible",
    methodInfo: { baseUrl: profile.baseUrl, apiKey: profile.apiKey, modelName: profile.modelName },
  });
  console.log(`[repro ${ts()}] authenticated`);
  const session = await client.newSession({ cwd: repoRoot, mcpServers: [] });
  console.log(`[repro ${ts()}] session=${session.sessionId} cliModel=${session._meta?.models?.currentModelId}`);
  await client.setModel(session.sessionId, profile.modelName);
  console.log(`[repro ${ts()}] setModel(${profile.modelName}) ok`);
  console.log(`[repro ${ts()}] setMode → ${JSON.stringify(await client.setMode(session.sessionId, "default"))}`);
  if (process.argv.includes("--no-think")) {
    console.log(`[repro ${ts()}] setThink(false) → ${JSON.stringify(await client.setThink(session.sessionId, false))}`);
  }

  const promptStarted = Date.now();
  const res = await Promise.race([
    client.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: template }] }).then((r) => ({ settled: true, r })),
    new Promise((resolve) => setTimeout(() => resolve({ settled: false }), 90_000)),
  ]);
  if (res.settled) {
    console.log(`[repro ${ts()}] prompt settled stopReason=${res.r?.stopReason} after ${((Date.now() - promptStarted) / 1000).toFixed(1)}s`);
  } else {
    console.log(`[repro ${ts()}] PROMPT STILL PENDING after 90s — wedge reproduced`);
    client.cancel(session.sessionId);
    await new Promise((r) => setTimeout(r, 3000));
  }
  const text = chunks.filter((c) => c.kind === "agent_message_chunk").map((c) => c.text).join("");
  const thought = chunks.filter((c) => c.kind === "agent_thought_chunk").map((c) => c.text).join("");
  console.log(`[repro] chunks=${chunks.length} lastChunkAt=${lastChunkAt ? `${((lastChunkAt - t0) / 1000).toFixed(1)}s` : "none"}`);
  console.log(`[repro] thought(${thought.length}): ${JSON.stringify(thought.slice(0, 200))}`);
  console.log(`[repro] text(${text.length}): ${JSON.stringify(text.slice(0, 300))}`);
} catch (error) {
  console.error(`[repro ${ts()}] ERROR`, error?.message ?? error);
} finally {
  await client.dispose().catch(() => {});
  process.exit(0);
}
