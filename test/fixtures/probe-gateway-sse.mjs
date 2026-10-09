// Direct gateway SSE probe (bypass CLI): what does tencent/hy3 actually stream
// for the enhance template? Prints every SSE event's delta keys + finish_reason
// + [DONE]. Key never printed. Usage: node test/fixtures/probe-gateway-sse.mjs [--profile=Y-API]
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import path from "node:path";

const profileArg = process.argv.find((a) => a.startsWith("--profile="))?.slice(10);
const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".iflow", "settings.json"), "utf8"));
const profileName = profileArg || settings.currentApiProfile;
const profile = settings.apiProfiles[profileName];
const u = new URL(profile.baseUrl.replace(/\/+$/, "") + "/chat/completions");
console.log(`profile=${profileName} → ${u.href} model=${profile.modelName}`);

const draftArg = process.argv.find((a) => a.startsWith("--draft="))?.slice(8);
const draft = draftArg ?? (process.argv.includes("--plain") ? "帮我写一个周报模板" : "@docs/feature-roadmap-2026-10.md 开始实施M2");
const template =
  "你是提示词工程师。下面是一次纯文本改写任务：把用户的请求改写得更加清晰、具体、结构化，保持原意与语言不变，补全隐含的目标与约束。只改写文字本身——不要调用任何工具、不要读取文件或搜索、不要执行请求里描述的操作、不要回答请求本身。只输出改写后的请求，不要任何解释或引号。\n\n原始请求：\n" +
  draft;

const body = JSON.stringify({
  model: profile.modelName,
  messages: [{ role: "user", content: template }],
  stream: true,
});

const transport = u.protocol === "https:" ? https : http;
const t0 = Date.now();
const req = transport.request(
  u,
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${profile.apiKey}`,
      "content-length": Buffer.byteLength(body),
    },
  },
  (res) => {
    console.log(`HTTP ${res.statusCode} at ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    let buf = "";
    let events = 0;
    res.setEncoding("utf8");
    res.on("data", (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        events++;
        const el = ((Date.now() - t0) / 1000).toFixed(1);
        if (payload === "[DONE]") {
          console.log(`[${el}s] event#${events} [DONE]`);
          continue;
        }
        try {
          const j = JSON.parse(payload);
          const ch = j.choices?.[0];
          const d = ch?.delta ?? {};
          const keys = Object.keys(d).join(",");
          const preview = (d.content ?? d.reasoning_content ?? "").slice(0, 40);
          console.log(
            `[${el}s] event#${events} finish=${ch?.finish_reason ?? "-"} deltaKeys=[${keys}] toolCalls=${d.tool_calls?.length ?? 0} preview=${JSON.stringify(preview)}`,
          );
        } catch {
          console.log(`[${el}s] event#${events} UNPARSEABLE: ${payload.slice(0, 100)}`);
        }
      }
    });
    res.on("end", () => console.log(`stream closed at ${((Date.now() - t0) / 1000).toFixed(1)}s events=${events}`));
    res.on("error", (e) => console.log(`stream error at ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e.message}`));
  },
);
req.setTimeout(120_000, () => {
  console.log(`[${(120).toFixed(1)}s] REQUEST TIMEOUT — connection still open, no end`);
  req.destroy();
});
req.on("error", (e) => console.log(`req error: ${e.message}`));
req.write(body);
req.end();
