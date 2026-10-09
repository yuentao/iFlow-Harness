// Repro: enhance prompt "internal prompt timeout" (user-reported 2026-10-09).
// Fourth-wave revision: internal prompts now bypass the CLI entirely and call
// the OpenAI-compatible endpoint directly via src/acp/complete.ts. This script
// exercises that exact path against the real gateway — same profile resolution
// (~/.iflow/settings.json apiProfiles), same enhance template, same ceiling /
// idle / salvage semantics as panel.ts runInternalPrompt.
//
// Usage:
//   node test/fixtures/repro-internal-prompt.mjs                  # @file draft (user's failing input)
//   node test/fixtures/repro-internal-prompt.mjs --plain          # plain-text draft (control)
//   node test/fixtures/repro-internal-prompt.mjs --profile=商汤    # pick apiProfile (default: active)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { streamChatCompletion } from "../../dist/src/acp/complete.js";

const profileArg = process.argv.find((a) => a.startsWith("--profile="))?.slice(10);
const plain = process.argv.includes("--plain");

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

// Same ceilings as panel.ts (INTERNAL_PROMPT_TIMEOUT_MS / INTERNAL_PROMPT_IDLE_MS).
const TIMEOUT_MS = 180_000;
const IDLE_MS = 90_000;

console.log(`[repro ${ts()}] POST ${profile.baseUrl}/chat/completions (stream)`);
const result = await streamChatCompletion(
  { baseUrl: profile.baseUrl, apiKey: profile.apiKey, modelName: profile.modelName },
  profile.modelName,
  template,
  { timeoutMs: TIMEOUT_MS, idleMs: IDLE_MS },
);

const trimmed = result.text.trim();
const salvageable = result.reason === "complete" || result.reason === "timeout" || result.reason === "stalled";
console.log(`[repro ${ts()}] reason=${result.reason} text=${trimmed.length} chars`);
console.log(`[repro] text: ${JSON.stringify(trimmed.slice(0, 300))}`);
if (salvageable && trimmed) {
  console.log(`[repro] PASS — panel would ${result.reason === "complete" ? "return" : "salvage"} the enhancement`);
  process.exit(0);
}
console.log(`[repro] FAIL — panel would show enhance failure`);
process.exit(1);