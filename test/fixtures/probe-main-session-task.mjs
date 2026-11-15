#!/usr/bin/env node
/**
 * 实测探针：主会话是否真的拿不到 `task` 工具。
 *
 * 背景：面板把主会话的 `session/new` / `session/load` 都带上
 * `settings: { disallowed_tools: ["task"] }`（panel.ts 的
 * `MAIN_SESSION_DISALLOWED_TOOLS` / `mainSessionSettings()`），CLI 侧把它映射成
 * Config 的 `excludeTools`，`createToolRegistry()` 注册器命中 `TaskTool.Name`
 * 即跳过注册。子会话（SuperAgentManager）刻意不传 settings，因此保留 `task`。
 *
 * 本脚本在**同一个 CLI 进程**内开两个会话做 A/B 对照：
 *   A = 带 `settings.disallowed_tools: ["task"]`（面板主会话的形态）
 *   B = 不带 settings（对照，应当保留 task 工具）
 * 两个会话收到同一句指令，统计各自出现 `toolName === "task"` 的
 * `tool_call` / `tool_call_update` 帧数。
 *
 * 验收口径：
 *   - A 必须 0 次 task 工具调用；
 *   - B 也必须 > 0 才有意义；B 若也是 0 次，本探针标为「对照无效（inconclusive）」，
 *     **不得**当作通过。
 *
 * 用法：
 *   $env:IFLOW_CLI_ENTRY = "J:\git\iflow-harness\vendor\iflow-cli\bundle\entry.js"
 *   node test/fixtures/probe-main-session-task.mjs
 *   # 默认 profile 不可用时换一个：
 *   node test/fixtures/probe-main-session-task.mjs --profile 深度求索
 *
 * 依赖 `npm run build` 生成的 dist（与 scripts/harness.mjs 同源）。
 * 退出码：0 = PASS；3 = INCONCLUSIVE（对照未观察到 task）；1 = FAIL；2 = 前置缺失。
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { AcpClient } = await import("../../dist/src/acp/client.js");
const { buildAcpCommand, resolveVendoredEntry } = await import("../../dist/src/acp/cli-locator.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

/** 两个会话收到的同一句指令（尽量短，避免额外 token）。 */
const PROMPT = [
  "Call the task tool with subagent_type=general-purpose and task='echo hi'.",
  "If you cannot, reply exactly NO_TASK_TOOL.",
].join(" ");

const PROMPT_TIMEOUT_MS = 300_000;

/** `--profile <name>` / `PROBE_PROFILE`：settings.json 里 currentApiProfile 指向的
 * 「本地网关 / gemini-4-argon」在本机网关会 400 model not allowed，所以允许显式
 * 换一个可用 profile 跑真实验证；默认仍是 currentApiProfile。 */
function requestedProfileName() {
  const index = process.argv.indexOf("--profile");
  const fromArgv = index >= 0 ? process.argv[index + 1] : undefined;
  return (fromArgv || process.env.PROBE_PROFILE || "").trim();
}

/** 面板的凭据在 SecretStorage；脚本退回到 CLI 自己的 settings.json
 * （与 probe-super-agent.mjs 的 loadProfile 同源，见 AGENTS.md 陷阱 #26）。 */
async function loadProfile() {
  const settingsPath = path.join(os.homedir(), ".iflow", "settings.json");
  const raw = (await readFile(settingsPath, "utf8")).replace(/^\uFEFF/, "");
  const settings = JSON.parse(raw);
  const name = requestedProfileName() || settings.currentApiProfile;
  const profile = (name && settings.apiProfiles?.[name]) || null;
  const apiKey = profile?.apiKey ?? settings.apiKey;
  const baseUrl = profile?.baseUrl ?? settings.baseUrl;
  const modelName = profile?.modelName ?? settings.modelName;
  if (!apiKey || !baseUrl || !modelName) {
    throw new Error(`~/.iflow/settings.json 里没有可用凭据（profile=${name}）`);
  }
  return { profileName: name, apiKey, baseUrl, modelName };
}

/** 每个会话的观测结果。 */
function newBucket(label) {
  return {
    label,
    sessionId: null,
    taskCalls: 0,
    taskCallEvents: [],
    toolNames: new Set(),
    text: "",
    stopReason: null,
    error: null,
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${label} ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function main() {
  return (async () => {
    // ---- 前置：dist / CLI entry / 凭据 ----
    const clientModule = path.join(root, "dist", "src", "acp", "client.js");
    if (!existsSync(clientModule)) {
      console.error("[probe] FAIL: dist 缺失，请先 `npm run build`。");
      return 2;
    }

    let entry = process.env.IFLOW_CLI_ENTRY?.trim() || "";
    if (!entry) {
      try {
        entry = resolveVendoredEntry(root);
      } catch {
        console.error(
          "[probe] FAIL: 本 worktree 没有 vendor/iflow-cli。请用 IFLOW_CLI_ENTRY 指向内置 CLI 的 bundle/entry.js（只读）。",
        );
        return 2;
      }
    }
    if (!existsSync(entry)) {
      console.error(`[probe] FAIL: CLI entry 不存在：${entry}`);
      return 2;
    }

    let profile;
    try {
      profile = await loadProfile();
    } catch (error) {
      console.error(`[probe] FAIL: ${error?.message ?? error}`);
      return 2;
    }

    console.log(`[probe] CLI entry     : ${entry}`);
    console.log(`[probe] profile/model : ${profile.profileName} / ${profile.modelName}`);
    console.log(`[probe] cwd           : ${root}`);

    const { command, args } = buildAcpCommand(entry);
    const sessionA = newBucket("A:disallowed_tools=[task]");
    const sessionB = newBucket("B:control(no settings)");

    /** sessionId -> bucket，会话建好后填入。 */
    const bySession = new Map();

    const client = new AcpClient(
      {
        command,
        args,
        cwd: root,
        env: { IFLOW_HARNESS: "1" },
        requestTimeoutMs: 180_000,
        allowedRoots: [root],
      },
      {
        onSessionUpdate: (notification) => {
          const update = notification?.update;
          const bucket = bySession.get(notification?.sessionId);
          if (!update || !bucket) return;
          const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
          if (kind === "agent_message_chunk") {
            const text = typeof update.content?.text === "string" ? update.content.text : "";
            bucket.text += text;
            process.stdout.write(`[${bucket.label}] ${text}`);
            return;
          }
          if (kind === "tool_call" || kind === "tool_call_update") {
            const toolName = typeof update.toolName === "string" ? update.toolName : "";
            if (toolName) bucket.toolNames.add(toolName);
            if (toolName === "task") {
              bucket.taskCalls += 1;
              bucket.taskCallEvents.push({ kind, title: update.title ?? null, status: update.status ?? null });
              console.log(`\n[probe] ${bucket.label} → task 工具调用帧 #${bucket.taskCalls} (${kind})`);
            }
          }
        },
        onStderr: (line) => {
          if (process.env.PROBE_VERBOSE) console.error("[stderr]", line);
        },
        // 对照会话 B 需要真的执行 task 才能证明工具存在：放行审批。
        // A 若意外尝试调用工具，也照此放行 —— 计数本身才是结论。
        onRequestPermission: async (request) => {
          const toolName = request?.toolCall?.toolName ?? "?";
          const option =
            request?.options?.find((o) => o.optionId === "allow_always") ??
            request?.options?.find((o) => o.optionId === "allow_once") ??
            request?.options?.[0];
          console.log(`[probe] permission request: ${toolName} → ${option?.optionId ?? "cancelled"}`);
          return option
            ? { outcome: { outcome: "selected", optionId: option.optionId } }
            : { outcome: { outcome: "cancelled" } };
        },
      },
    );

    let exitCode = 1;
    try {
      await withTimeout(client.connect(), 60_000, "connect");
      await withTimeout(
        client.authenticate({
          methodId: "openai-compatible",
          methodInfo: { apiKey: profile.apiKey, baseUrl: profile.baseUrl, modelName: profile.modelName },
        }),
        120_000,
        "authenticate",
      );
      console.log("[probe] initialize + authenticate OK");

      // 会话 A：面板主会话形态（settings.disallowed_tools: ["task"]）
      const a = await withTimeout(
        client.newSession({ cwd: root, mcpServers: [], settings: { disallowed_tools: ["task"] } }),
        120_000,
        "session/new A",
      );
      sessionA.sessionId = a.sessionId;
      bySession.set(a.sessionId, sessionA);
      console.log(`[probe] session A = ${a.sessionId}`);

      // 会话 B：对照，不带 settings
      const b = await withTimeout(
        client.newSession({ cwd: root, mcpServers: [] }),
        120_000,
        "session/new B",
      );
      sessionB.sessionId = b.sessionId;
      bySession.set(b.sessionId, sessionB);
      console.log(`[probe] session B = ${b.sessionId}`);

      // ---- 依次跑两个会话（串行，避免更新互相干扰）----
      for (const bucket of [sessionA, sessionB]) {
        console.log(`\n--- ${bucket.label} prompt ---`);
        try {
          const result = await withTimeout(
            client.prompt({ sessionId: bucket.sessionId, prompt: [{ type: "text", text: PROMPT }] }),
            PROMPT_TIMEOUT_MS,
            `prompt ${bucket.label}`,
          );
          bucket.stopReason = result?.stopReason ?? null;
        } catch (error) {
          bucket.error = error?.message ?? String(error);
        }
        console.log(
          `\n[probe] ${bucket.label} settled: stopReason=${bucket.stopReason ?? "-"}${
            bucket.error ? ` error=${bucket.error}` : ""
          }`,
        );
      }
    } catch (error) {
      console.error("[probe] FAIL:", error?.stack ?? error);
      exitCode = 1;
    } finally {
      await client.dispose().catch(() => undefined);
    }

    // ---- 汇总 ----
    const snippet = (text) => text.replace(/\s+/g, " ").trim().slice(0, 400) || "(空)";
    for (const bucket of [sessionA, sessionB]) {
      console.log(`\n[probe] ${bucket.label}`);
      console.log(`  sessionId      : ${bucket.sessionId ?? "-"}`);
      console.log(`  task 工具调用数 : ${bucket.taskCalls}`);
      if (bucket.taskCallEvents.length > 0) {
        console.log(`  事件           : ${JSON.stringify(bucket.taskCallEvents)}`);
      }
      console.log(`  观测到的工具名  : ${[...bucket.toolNames].join(", ") || "(无)"}`);
      console.log(`  助手文本片段    : ${snippet(bucket.text)}`);
      if (bucket.error) console.log(`  错误           : ${bucket.error}`);
    }

    console.log("\n[probe] === 结论 ===");
    if (sessionA.error) {
      console.log(`[probe] VERDICT: FAIL —— 会话 A 出错，未完成验证（${sessionA.error}）`);
      exitCode = 1;
    } else if (sessionA.taskCalls > 0) {
      console.log(`[probe] VERDICT: FAIL —— 会话 A 出现了 ${sessionA.taskCalls} 次 task 工具调用（应当为 0）`);
      exitCode = 1;
    } else if (sessionB.taskCalls > 0) {
      console.log(
        `[probe] VERDICT: PASS —— A=0 次 task 调用；B（对照）=${sessionB.taskCalls} 次，说明 task 工具本身可用`,
      );
      exitCode = 0;
    } else {
      console.log(
        "[probe] VERDICT: INCONCLUSIVE —— A=0 次，但对照 B 也没有调用 task；对照无效，不能据此判定通过",
      );
      exitCode = 3;
    }
    return exitCode;
  })();
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
