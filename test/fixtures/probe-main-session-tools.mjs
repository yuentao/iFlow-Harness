#!/usr/bin/env node
/**
 * 实测探针：主会话的 `settings.disallowed_tools` 是否真的让 CLI 不把
 * 读取/搜索/写入/执行类工具交给模型。
 *
 * 与 `probe-main-session-task.mjs` 的区别：那个探针靠真实模型「是否愿意调用
 * task」来推断，慢且依赖网关行为；本探针用本地 mock OpenAI 兼容端点，直接
 * 抓取**模型请求体里的 `tools` 数组**——这是工具是否存在的确定性证据，不需要
 * 模型配合，也不消耗真实 token。
 *
 * 覆盖三条路径：
 *   A. `session/new` + settings   → 期望 tools 里没有 run_shell_command / read_file …
 *   B. `session/new` 不带 settings → 对照，期望 tools 里有这些工具（否则对照无效）
 *   C. `session/load` + settings  → 期望加载后的会话同样被门控
 *
 * 用法：
 *   node test/fixtures/probe-main-session-tools.mjs
 *   # 指向任意内置 CLI（默认 vendor/iflow-cli，缺失时退回 vendor/iflow-fork 快照）：
 *   $env:IFLOW_CLI_ENTRY = "...\bundle\entry.js"
 *
 * 前置：`npx tsc -p tsconfig.json`（需要 dist/src/acp/client.js）。
 * 退出码：0 = PASS；3 = INCONCLUSIVE（对照里也没看到被禁工具）；1 = FAIL；2 = 前置缺失。
 */

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { AcpClient } = await import("../../dist/src/acp/client.js");
const { buildAcpCommand } = await import("../../dist/src/acp/cli-locator.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

const PROMPT = "Reply with exactly OK.";
const PROMPT_TIMEOUT_MS = 120_000;

/** 从源码读门控清单，避免探针与 panel.ts 漂移。 */
async function loadDisallowedTools() {
  const source = await readFile(path.join(root, "src", "panel", "panel.ts"), "utf8");
  const start = source.indexOf("export const MAIN_SESSION_DISALLOWED_TOOLS = [");
  if (start < 0) throw new Error("panel.ts 里找不到 MAIN_SESSION_DISALLOWED_TOOLS");
  const end = source.indexOf("] as const;", start);
  if (end < 0) throw new Error("MAIN_SESSION_DISALLOWED_TOOLS 没有 `] as const;` 收尾");
  const body = source.slice(start, end);
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** 必须被挡住的名字（存在性证据，不看模型是否想调用）。 */
const MUST_BE_BLOCKED = ["run_shell_command", "read_file", "write_file", "task"];

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 最小 OpenAI 兼容 mock：记录每次 /chat/completions 的 tools 名，回一段流式文本。 */
function startMockEndpoint() {
  const requests = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (req.method === "GET" && url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
      return;
    }
    if (req.method !== "POST" || !url.includes("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `unexpected ${req.method} ${url}` } }));
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        body = {};
      }
      const names = Array.isArray(body.tools)
        ? body.tools.map((t) => t?.function?.name ?? t?.name).filter(Boolean)
        : [];
      requests.push({ at: Date.now(), url, model: body.model ?? null, tools: names });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: body.model ?? "mock-model" };
      res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
      res.write(sse({ ...base, choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }] }));
      res.write(
        sse({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        }),
      );
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        port: address.port,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${label} ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  const clientModule = path.join(root, "dist", "src", "acp", "client.js");
  if (!existsSync(clientModule)) {
    console.error("[probe] FAIL: dist 缺失，请先 `npx tsc -p tsconfig.json`。");
    return 2;
  }
  const entry =
    process.env.IFLOW_CLI_ENTRY?.trim() ||
    path.join(root, "vendor", "iflow-cli", "bundle", "entry.js");
  const fallbackEntry = path.join(root, "vendor", "iflow-fork", "bundle", "entry.js");
  const cliEntry = existsSync(entry) ? entry : existsSync(fallbackEntry) ? fallbackEntry : "";
  if (!cliEntry) {
    console.error("[probe] FAIL: 找不到内置 CLI（vendor/iflow-cli 或 vendor/iflow-fork 快照）。");
    return 2;
  }

  const disallowed = await loadDisallowedTools();
  const mock = await startMockEndpoint();
  const home = await mkdtemp(path.join(os.tmpdir(), "iflow-probe-home-"));
  const baseUrl = `http://127.0.0.1:${mock.port}/v1`;
  console.log(`[probe] CLI entry      : ${cliEntry}`);
  console.log(`[probe] mock endpoint  : ${baseUrl}`);
  console.log(`[probe] isolated HOME  : ${home}`);
  console.log(`[probe] disallowed     : ${disallowed.join(", ")}`);

  const { command, args } = buildAcpCommand(cliEntry);
  const client = new AcpClient(
    {
      command,
      args,
      cwd: root,
      // 隔离 ~/.iflow（不读本机 profile / MCP / 记忆），mock 端点只服务本次探针。
      env: {
        HOME: home,
        USERPROFILE: home,
        IFLOW_HARNESS: "1",
        IFLOW_SUPER_TOOL: "1",
      },
      requestTimeoutMs: 120_000,
      allowedRoots: [root],
    },
    {
      onSessionUpdate: () => undefined,
      onStderr: (line) => {
        if (process.env.PROBE_VERBOSE) console.error("[stderr]", line);
      },
      onRequestPermission: async (request) => {
        const option = request?.options?.[0];
        return option
          ? { outcome: { outcome: "selected", optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" } };
      },
    },
  );

  const results = [];
  let exitCode = 1;
  try {
    await withTimeout(client.connect(), 60_000, "connect");
    await withTimeout(
      client.authenticate({
        methodId: "openai-compatible",
        methodInfo: { apiKey: "probe-key", baseUrl, modelName: "mock-model" },
      }),
      120_000,
      "authenticate",
    );
    console.log("[probe] initialize + authenticate OK");

    const promptOnce = async (sessionId, label) => {
      const before = mock.requests.length;
      await withTimeout(
        client.prompt({ sessionId, prompt: [{ type: "text", text: PROMPT }] }),
        PROMPT_TIMEOUT_MS,
        `prompt ${label}`,
      );
      const seen = mock.requests.slice(before);
      const tools = seen.length > 0 ? seen[seen.length - 1].tools : [];
      results.push({ label, sessionId, requestCount: seen.length, tools });
      console.log(`[probe] ${label}: requests=${seen.length} tools=${tools.length}`);
    };

    // A：面板主会话形态
    const gated = await withTimeout(
      client.newSession({ cwd: root, mcpServers: [], settings: { disallowed_tools: disallowed } }),
      120_000,
      "session/new gated",
    );
    await promptOnce(gated.sessionId, "A:session/new+settings");

    // B：对照，不带 settings
    const control = await withTimeout(
      client.newSession({ cwd: root, mcpServers: [] }),
      120_000,
      "session/new control",
    );
    await promptOnce(control.sessionId, "B:session/new(control)");

    // C：session/load 带 settings（面板恢复会话的形态）
    await withTimeout(
      client.loadSession({
        cwd: root,
        mcpServers: [],
        sessionId: control.sessionId,
        settings: { disallowed_tools: disallowed },
      }),
      120_000,
      "session/load gated",
    );
    await promptOnce(control.sessionId, "C:session/load+settings");
  } catch (error) {
    console.error("[probe] FAIL:", error?.stack ?? error);
    exitCode = 1;
  } finally {
    await client.dispose().catch(() => undefined);
    await mock.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }

  console.log("\n[probe] === 汇总 ===");
  for (const result of results) {
    const blockedPresent = MUST_BE_BLOCKED.filter((name) => result.tools.includes(name));
    console.log(`- ${result.label}`);
    console.log(`    requests=${result.requestCount} tools=${result.tools.length}`);
    console.log(`    可见工具: ${result.tools.join(", ") || "(无)"}`);
    console.log(`    被禁工具仍在: ${blockedPresent.join(", ") || "(无)"}`);
  }

  const gatedNew = results.find((r) => r.label.startsWith("A:"));
  const controlNew = results.find((r) => r.label.startsWith("B:"));
  const gatedLoad = results.find((r) => r.label.startsWith("C:"));

  console.log("\n[probe] === 结论 ===");
  if (!gatedNew || !controlNew || !gatedLoad) {
    console.log("[probe] VERDICT: FAIL —— 三条路径没有全部跑完");
    return 1;
  }
  const controlHasTools = MUST_BE_BLOCKED.every((name) => controlNew.tools.includes(name));
  const newBlocked = MUST_BE_BLOCKED.filter((name) => gatedNew.tools.includes(name));
  const loadBlocked = MUST_BE_BLOCKED.filter((name) => gatedLoad.tools.includes(name));

  if (!controlHasTools) {
    console.log(
      `[probe] VERDICT: INCONCLUSIVE —— 对照会话的 tools 里也没有 ${MUST_BE_BLOCKED.join("/")}，无法判断门控是否生效`,
    );
    exitCode = 3;
  } else if (newBlocked.length > 0 || loadBlocked.length > 0) {
    console.log(
      `[probe] VERDICT: FAIL —— session/new 泄漏 [${newBlocked.join(", ")}]；session/load 泄漏 [${loadBlocked.join(", ")}]`,
    );
    exitCode = 1;
  } else {
    console.log("[probe] VERDICT: PASS —— session/new 与 session/load 的模型请求都不含被禁工具，对照会话含全部");
    exitCode = 0;
  }
  return exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 300).unref();
  })
  .catch((error) => {
    console.error("[probe] unexpected:", error);
    process.exit(1);
  });
