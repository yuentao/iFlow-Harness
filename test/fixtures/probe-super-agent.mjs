#!/usr/bin/env node
/**
 * Super Agent 冒烟实测（真实链路）。
 *
 * 面板的委派链路在 VSCode 外壳里跑，这段脚本把外壳换成 Node，复用**生产代码本身**
 * （不是复制品），逐段验证：
 *
 *   1. 主会话：真实 vendored CLI + 面板同款系统提示（IFLOW_SYSTEM_MD），
 *      让模型自己拆解任务并输出 ```super-agent 委派块。
 *   2. 宿主扫描：面板同款纯函数 extractSuperDirectives 解析委派块。
 *   3. 子会话：真实 SuperAgentManager —— 独立 CLI 进程 + 独立 git worktree
 *      + 独立分支 + 宿主代提交 + 自动合并回主工作区。
 *   4. 汇报：面板同款 reportPrompt + streamChatCompletion 直连网关，验证
 *      「子会话结果回灌主会话」这一段真的能跑通。
 *
 * 用法：
 *   node test/fixtures/probe-super-agent.mjs            # 全链路
 *   node test/fixtures/probe-super-agent.mjs --keep     # 保留临时仓库便于排查
 *
 * 退出码：0 = 全链路通过；1 = 有环节失败。
 */

import { execFile } from "node:child_process";
import nodeModule from "node:module";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolve as resolveVscodeStub } from "./vscode-stub-loader.mjs";

// shared/session-state.ts 依赖 vscode.l10n —— 纯 Node 下先挂上替身解析钩子，
// 再动态 import 生产模块（静态 import 会被提升，钩子来不及生效）。
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({ resolve: resolveVscodeStub });
} else {
  nodeModule.register(new URL("./vscode-stub-loader.mjs", import.meta.url).href);
}

const { AcpClient } = await import("../../dist/src/acp/client.js");
const { buildAcpCommand, resolveVendoredEntry } = await import("../../dist/src/acp/cli-locator.js");
const { streamChatCompletion } = await import("../../dist/src/acp/complete.js");
const { SuperAgentManager } = await import("../../dist/src/panel/super-agent.js");
const { extractSuperDirectives, isTerminalSuperStatus, reportForSession, buildSuperDigest } = await import(
  "../../dist/shared/super-agent.js"
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const keep = process.argv.includes("--keep");
/** `--stage1 N`：只跑 N 轮主会话，统计「模型自行拆解并委派」的比率。 */
const stage1Only = (() => {
  const index = process.argv.indexOf("--stage1");
  const value = index >= 0 ? Number(process.argv[index + 1]) : 0;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
})();

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function git(cwd, ...args) {
  const { stdout } = await execFileP("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

/** 面板的凭据来源是 SecretStorage；脚本里退回到 CLI 自己的 settings.json
 *  （AGENTS.md 陷阱 #26：内部链路必须显式注入凭据，否则吃的是终端配置）。 */
async function loadProfile() {
  const settingsPath = path.join(os.homedir(), ".iflow", "settings.json");
  const raw = (await readFile(settingsPath, "utf8")).replace(/^\uFEFF/, "");
  const settings = JSON.parse(raw);
  const name = settings.currentApiProfile;
  const profile = (name && settings.apiProfiles?.[name]) || null;
  const apiKey = profile?.apiKey ?? settings.apiKey;
  const baseUrl = profile?.baseUrl ?? settings.baseUrl;
  const modelName = profile?.modelName ?? settings.modelName;
  if (!apiKey || !baseUrl || !modelName) {
    throw new Error(`~/.iflow/settings.json 里没有可用凭据（profile=${name}）`);
  }
  return { profileName: name, apiKey, baseUrl, modelName };
}

/** 一个只有初始提交的临时 git 仓库 —— 子会话的 worktree 从这里派生。 */
async function makeTempRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "iflow-super-smoke-"));
  await git(repoRoot, "init", "-b", "main");
  await git(repoRoot, "config", "user.name", "iflow smoke");
  await git(repoRoot, "config", "user.email", "smoke@example.com");
  await git(repoRoot, "config", "commit.gpgsign", "false");
  await git(repoRoot, "config", "core.autocrlf", "false");
  await mkdir(path.join(repoRoot, "docs"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "README.md"),
    "# smoke repo\n\n用于 Super Agent 冒烟实测的临时仓库。\n",
    "utf8",
  );
  await writeFile(path.join(repoRoot, "docs", "index.md"), "# 文档索引\n", "utf8");
  await git(repoRoot, "add", "-A");
  await git(repoRoot, "commit", "-m", "chore: init smoke repo");
  return repoRoot;
}

/** 会改工作区或跑命令的工具 —— 主会话只该委派，不该自己动手。 */
const FILE_MUTATING_TOOLS = new Set([
  "write_file",
  "replace",
  "edit_block",
  "fast_edit_block",
  "run_shell_command",
  "create_file",
  "write",
  "patch",
  "apply_patch",
]);

/** 主会话的任务：两件互不相关的工作，明确要求并行委派。 */
const MAIN_PROMPT = [
  "这个仓库目前只有 README.md 和 docs/index.md。",
  "",
  "请完成下面两件互不相关的工作，并把**每一件都交给一个独立的子会话并行去做**：",
  "1. 新建 docs/alpha.md，写一段「模块 A」的设计说明（不少于 5 行 Markdown）。",
  "2. 新建 docs/beta.md，写一段「模块 B」的设计说明（不少于 5 行 Markdown）。",
  "",
  "你自己只负责委派与最后汇报，不要亲手写这两个文件；也不要自己写第三次（拆成更多子会话也可以）。",
].join("\n");

let repoRoot = null;

async function main() {
  const entry = resolveVendoredEntry(root);
  const systemPromptPath = path.join(root, "prompts", "system-prompt.md");
  const profile = await loadProfile();
  console.log(`[probe] CLI entry      : ${entry}`);
  console.log(`[probe] system prompt  : ${systemPromptPath}`);
  console.log(`[probe] profile/model  : ${profile.profileName} / ${profile.modelName}`);
  console.log(`[probe] baseUrl        : ${profile.baseUrl}`);

  repoRoot = await makeTempRepo();
  console.log(`[probe] temp repo      : ${repoRoot}`);

  const { command, args } = buildAcpCommand(entry);
  let assistantText = "";
  const toolCalls = [];
  const mainClient = new AcpClient(
    {
      command,
      args,
      cwd: repoRoot,
      env: { IFLOW_HARNESS: "1", IFLOW_SYSTEM_MD: systemPromptPath },
      requestTimeoutMs: 180_000,
      allowedRoots: [repoRoot],
    },
    {
      onSessionUpdate: (n) => {
        const u = n.update;
        if (u?.sessionUpdate === "agent_message_chunk") {
          const t = typeof u.content?.text === "string" ? u.content.text : "";
          assistantText += t;
          process.stdout.write(t);
        } else if (typeof u?.sessionUpdate === "string" && u.sessionUpdate.startsWith("tool_call")) {
          toolCalls.push({ kind: u.sessionUpdate, name: u.toolName ?? "" });
          console.log(`\n[main tool] ${u.sessionUpdate} ${u.toolName ?? ""}`);
        }
      },
      onStderr: (line) => {
        if (process.env.PROBE_VERBOSE) console.error("[main stderr]", line);
      },
      // 主会话只负责委派，不该动手改文件 —— 拒绝一切审批，保持只读。
      onRequestPermission: async (req) => {
        console.log(`[main] permission DENIED for ${req.toolCall?.toolName ?? "?"}`);
        return { outcome: { outcome: "cancelled" } };
      },
    },
  );

  const reportEntries = [];
  const manager = new SuperAgentManager({
    repoRoot,
    createClient: async ({ cwd, allowedRoots, label, callbacks }) => {
      const includeDirectories = allowedRoots.filter((r) => path.resolve(r) !== path.resolve(cwd));
      const built = buildAcpCommand(entry, includeDirectories);
      const client = new AcpClient(
        {
          command: built.command,
          args: built.args,
          cwd,
          env: { IFLOW_HARNESS: "1", IFLOW_SYSTEM_MD: systemPromptPath },
          requestTimeoutMs: 180_000,
          allowedRoots,
        },
        callbacks,
      );
      await client.connect();
      await client.authenticate({
        methodId: "openai-compatible",
        methodInfo: { apiKey: profile.apiKey, baseUrl: profile.baseUrl, modelName: profile.modelName },
      });
      console.log(`[probe] child client ready: ${label} @ ${cwd}`);
      return client;
    },
    onSessionsChanged: () => {},
    onTranscript: () => {},
    onReport: (entries) => {
      for (const e of entries) {
        console.log(`[probe] report: ${e.session.id} 「${e.session.title}」→ ${e.report.state}`);
      }
      reportEntries.push(...entries);
    },
    currentModel: () => profile.modelName,
    integrationMode: () => "merge",
    // 探针固定用默认并发上限；真实面板读 iflow.superAgent.maxConcurrent。
    maxConcurrentSessions: () => 5,
    log: {
      info: (m) => console.log("[mgr]", m),
      warn: (m) => console.warn("[mgr]", m),
      error: (m) => console.error("[mgr]", m),
    },
  });

  /**
   * 跑一轮主会话：真实 CLI + 面板同款系统提示 + 看板快照。
   * 与面板 sendPrompt 的组装一致（panel.ts 的 superAgentsDigest() + promptText）。
   * 看板标记是主/子会话的角色信号，少了它模型会把自己当子会话而自己干活。
   */
  async function runMainTurn() {
    assistantText = "";
    toolCalls.length = 0;
    const session = await mainClient.newSession({ cwd: repoRoot, mcpServers: [] });
    console.log(`[probe] main session: ${session.sessionId}`);
    const promptText = [buildSuperDigest([]), MAIN_PROMPT].filter(Boolean).join("\n\n");
    console.log("\n--- 主会话输出 ---");
    const result = await mainClient.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: promptText }],
    });
    const scan = extractSuperDirectives(assistantText, 0);
    return { session, result, scan, tasks: scan.blocks.flat(), toolCalls: [...toolCalls], text: assistantText };
  }

  try {
    // ---- 阶段 1：主会话（模型自己决定要不要委派）----
    console.log("\n=== 阶段 1：主会话（真实 CLI + 面板同款系统提示） ===");
    await mainClient.connect();
    await mainClient.authenticate({
      methodId: "openai-compatible",
      methodInfo: { apiKey: profile.apiKey, baseUrl: profile.baseUrl, modelName: profile.modelName },
    });

    // `--stage1 N`：只测「模型是否自行拆解并委派」，N 次独立采样统计委派率。
    // 委派是模型自己的决策，宿主无法强制 —— 这个比率才是验收指标。
    if (stage1Only > 0) {
      let delegated = 0;
      for (let i = 1; i <= stage1Only; i++) {
        const turn = await runMainTurn();
        const ok = turn.tasks.length > 0;
        if (ok) delegated++;
        const tools = [...new Set(turn.toolCalls.map((t) => t.name))].join(",") || "无";
        console.log(
          `[probe] 采样 ${i}/${stage1Only}: 委派块=${turn.scan.blocks.length} 任务数=${turn.tasks.length} 工具=${tools} → ${ok ? "DELEGATED" : "NO-DELEGATION"}`,
        );
        if (!ok) console.log(`[probe]   主会话输出片段：\n${turn.text.slice(0, 1500)}`);
      }
      check(`模型自行拆解并委派（${delegated}/${stage1Only}）`, delegated === stage1Only, `委派率 ${delegated}/${stage1Only}`);
      return checks.every((c) => c.ok);
    }

    const turn = await runMainTurn();
    const { scan, tasks } = turn;
    const turnTools = turn.toolCalls;
    console.log(`\n--- 主会话结束（stopReason=${turn.result.stopReason}）---`);

    // ---- 阶段 2：宿主扫描委派指令 ----
    console.log("\n=== 阶段 2：宿主扫描委派指令（extractSuperDirectives） ===");
    console.log(
      `[probe] 解析成功指令块=${scan.blocks.length} 任务数=${tasks.length} 非法块=${scan.invalidBlocks.length}`,
    );
    for (const t of tasks) {
      console.log(`[probe]   - 「${t.title}」 ${String(t.task).slice(0, 80).replace(/\n/g, " ")}…`);
    }
    check("主会话自行输出 super-agent 委派块", tasks.length > 0, `任务数=${tasks.length}`);
    check("委派块全部可解析（无非法块）", scan.invalidBlocks.length === 0, `非法块=${scan.invalidBlocks.length}`);
    const mutating = turnTools.filter((t) => FILE_MUTATING_TOOLS.has(t.name));
    check(
      "主会话只做委派，没有自己写文件或跑命令",
      mutating.length === 0,
      mutating.map((t) => t.name).join(",") || `仅非写文件工具（${[...new Set(turnTools.map((t) => t.name))].join(",") || "无"}）`,
    );

    if (tasks.length === 0) {
      console.log("\n[probe] 没有可派发的任务，后续阶段跳过。");
      console.log("[probe] 主会话原始输出（前 4000 字）：\n" + turn.text.slice(0, 4000));
      return false;
    }

    // ---- 阶段 3：真实子会话（独立进程 + 独立 worktree + 自动合并）----
    console.log("\n=== 阶段 3：派发子会话（真实 SuperAgentManager） ===");
    const worktreeRoot = path.join(repoRoot, ".iflow", "super", "worktrees");
    for (const t of tasks) {
      // 只放行仓库内的附件路径 —— 模型给的路径不能成为任意读盘通道。
      const all = t.attachments ?? [];
      const safe = all
        .filter((a) => a.path && path.resolve(a.path).startsWith(path.resolve(repoRoot)))
        .map((a) => ({ name: a.name, path: a.path }));
      const dropped = all.length - safe.length;
      if (dropped > 0) console.log(`[probe] 丢弃 ${dropped} 个仓库外附件路径`);
      const spawned = manager.spawn({ title: t.title, task: t.task, attachments: safe });
      console.log(`[probe] spawned ${spawned.id} 「${spawned.title}」`);
    }

    console.log("[probe] 等待子会话进入终态（最多 20 分钟）…");
    const deadline = Date.now() + 20 * 60_000;
    let settled = [];
    while (Date.now() < deadline) {
      const list = manager.list();
      const allTerminal = list.length > 0 && list.every((s) => isTerminalSuperStatus(s.status));
      const integrated = list.every((s) => s.status !== "completed" || Boolean(s.integration));
      if (allTerminal && integrated) {
        settled = list;
        break;
      }
      await sleep(1500);
    }
    settled = manager.list();
    for (const s of settled) {
      console.log(
        `[probe] ${s.id} 「${s.title}」 status=${s.status} isolation=${s.isolation.kind} branch=${s.isolation.branch ?? "-"} integration=${s.integration?.state ?? "-"}`,
      );
      if (s.summary) console.log(`[probe]   summary: ${String(s.summary).slice(0, 300).replace(/\n/g, " ")}`);
      if (s.error) console.log(`[probe]   error: ${s.error}`);
    }

    const completed = settled.filter((s) => s.status === "completed");
    check("所有子会话到达终态", settled.length === tasks.length && settled.every((s) => isTerminalSuperStatus(s.status)));
    check(
      "子会话全部使用 git worktree 隔离",
      settled.length > 0 && settled.every((s) => s.isolation.kind === "git_worktree"),
      settled.map((s) => s.isolation.kind).join(","),
    );
    check(
      "worktree 落在项目内 .iflow/super/worktrees 下",
      settled.every((s) => path.resolve(s.isolation.path).startsWith(path.resolve(worktreeRoot))),
      settled.map((s) => s.isolation.path).join(", "),
    );
    check(
      "每个子会话在独立分支 iflow/super/* 上",
      settled.every((s) => (s.isolation.branch ?? "").startsWith("iflow/super/")),
      settled.map((s) => s.isolation.branch ?? "-").join(", "),
    );
    check("子会话全部成功完成", completed.length === settled.length, settled.map((s) => s.status).join(","));
    check(
      "改动已自动合并回主工作区",
      completed.length > 0 && completed.every((s) => s.integration?.state === "merged"),
      settled.map((s) => s.integration?.state ?? "-").join(","),
    );

    // 主工作区应拿到子会话的产物
    const fileExists = async (p) => {
      try {
        await readFile(p, "utf8");
        return true;
      } catch {
        return false;
      }
    };
    check("子会话产物已落到主工作区 docs/alpha.md", await fileExists(path.join(repoRoot, "docs", "alpha.md")));
    check("子会话产物已落到主工作区 docs/beta.md", await fileExists(path.join(repoRoot, "docs", "beta.md")));

    const log = await git(repoRoot, "log", "--oneline", "-n", "6");
    console.log("[probe] 主分支最近提交：\n" + log);
    const dirty = await git(repoRoot, "status", "--porcelain");
    check("主工作区保持干净（合并没有留下脏状态）", dirty.length === 0, dirty.slice(0, 200));

    // ---- 阶段 4：汇报回灌主会话（直连网关，同 payload）----
    console.log("\n=== 阶段 4：汇报回灌（reportPrompt + streamChatCompletion） ===");
    let entries = reportEntries;
    if (entries.length === 0) {
      entries = settled
        .map((s) => {
          const report = reportForSession(s, Date.now(), s.summary ?? "");
          return report ? { session: s, report } : null;
        })
        .filter(Boolean);
    }
    const reportPrompt = manager.reportPrompt(entries);
    console.log("[probe] 汇报提示词（前 600 字）：\n" + reportPrompt.slice(0, 600));
    const completion = await streamChatCompletion(
      { baseUrl: profile.baseUrl, apiKey: profile.apiKey, modelName: profile.modelName },
      profile.modelName,
      reportPrompt,
      { timeoutMs: 120_000, idleMs: 30_000 },
    );
    console.log(`[probe] 汇报回灌 reason=${completion.reason} 长度=${completion.text.length}`);
    console.log("[probe] 汇报正文：\n" + completion.text.slice(0, 1500));
    check("汇报提示词非空", reportPrompt.trim().length > 0, `entries=${entries.length}`);
    check(
      "汇报回灌拿到网关回复",
      completion.reason === "complete" && completion.text.trim().length > 0,
      `reason=${completion.reason}`,
    );

    return checks.every((c) => c.ok);
  } catch (error) {
    console.error("\n[probe] FAIL:", error?.stack ?? error);
    check("脚本执行未抛异常", false, String(error?.message ?? error));
    return false;
  } finally {
    // 必须先收掉所有 CLI 进程再删临时仓库：Windows 上「进程的工作目录」
    // 会锁住目录，删不掉；而且不 dispose 还会留下孤儿 CLI 进程。
    await manager.dispose().catch(() => undefined);
    await mainClient.dispose().catch(() => undefined);
  }
}

async function cleanup() {
  if (!repoRoot) return;
  if (keep) {
    console.log(`[probe] 保留临时仓库：${repoRoot}`);
    return;
  }
  // git 的 object 文件在 Windows 上是只读的 —— `fs.rm` 默认 0 次重试，
  // 第一次 EPERM 就会放弃，临时仓库会留在 %TEMP% 里。必须给足重试。
  try {
    await rm(repoRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    console.log(`[probe] 已清理临时仓库：${repoRoot}`);
  } catch (error) {
    console.warn(`[probe] 临时仓库清理失败（请手动删除）：${repoRoot} — ${error?.message ?? error}`);
  }
}

main()
  .then(async (ok) => {
    console.log("\n=== 冒烟结果 ===");
    for (const c of checks) {
      console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
    }
    const failed = checks.filter((c) => !c.ok);
    console.log(`\n[probe] ${checks.length - failed.length}/${checks.length} 项通过`);
    await cleanup();
    process.exit(ok && failed.length === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error("[probe] unexpected:", error);
    await cleanup();
    process.exit(1);
  });