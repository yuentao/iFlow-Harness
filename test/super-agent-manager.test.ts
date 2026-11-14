import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SuperAgentManager, buildTaskPrompt, capTail, SUPER_TEXT_MAX_CHARS } from "../src/panel/super-agent.js";
import type { AcpClient, AcpClientCallbacks } from "../src/acp/client.js";
import type { ContentBlock, UserQuestion } from "../src/acp/protocol.js";
import {
  DEFAULT_MAX_CONCURRENT_SUPER_SESSIONS,
  type SuperIntegrationMode,
  type SuperReport,
  type SuperSessionUi,
} from "../shared/super-agent.js";
import type { Block } from "../shared/messages.js";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

/** 同上的读出版本（分支列表断言需要 stdout）。 */
function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    windowsHide: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "iflow-super-"));
  roots.push(dir);
  git(dir, "init");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(path.join(dir, "a.txt"), "one\n", "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  return dir;
}

type Plan =
  | "complete"
  | "commit"
  | "commit-a"
  | "commit-a-gated"
  | "edit"
  | "hang"
  | "hang-text"
  | "throw"
  | "throw-object"
  | "usage"
  /** 合并子会话：按任务书里的分支在主仓工作区执行 `git merge --no-ff`。 */
  | "merge"
  /** 合并子会话：什么都不做（用来验证宿主不谎报成功）。 */
  | "merge-noop"
  /**
   * `session/new` 挂起，直到测试放行 —— 用来在**准备阶段**中断子会话
   * （此时子会话还没拿到内核会话，也还没开始跑）。
   */
  | "gate-session"
  /**
   * 回合正常结束，但**进程回收挂起**直到测试放行 —— 用来观察「回合已结束、
   * 进程还活着」这段时间里并发额度是怎么算的。
   */
  | "commit-gated-dispose";

/** A stand-in for AcpClient — the manager only uses a small surface. */
class FakeClient {
  prompts: string[] = [];
  /** Full content blocks of each prompt (text + image) for attachment tests. */
  blocks: ContentBlock[][] = [];
  /** Mode ids pushed to the child session — the manager must send "yolo". */
  modes: string[] = [];
  disposed = false;
  cwd = "";
  allowedRoots: string[] = [];
  /** 传给 CLI 的 `--include-directories`（工作目录之外的额外可读写根）。 */
  includeDirectories: string[] = [];
  /** Resolver for the "commit-a-gated" plan: the test opens the gate explicitly. */
  releasePrompt: (() => void) | null = null;
  /** Resolver for the "gate-session" plan: releases the pending `session/new`. */
  releaseSession: (() => void) | null = null;
  /** Resolver for the "commit-gated-dispose" plan: releases the process teardown. */
  releaseDispose: (() => void) | null = null;
  private settle: ((value: { stopReason: string }) => void) | null = null;

  constructor(
    readonly callbacks: AcpClientCallbacks,
    private readonly plan: Plan,
  ) {}

  async newSession(): Promise<{ sessionId: string }> {
    if (this.plan === "gate-session") {
      // 准备阶段挂起：测试可以在这个窗口里中断子会话。
      await new Promise<void>((resolve) => {
        this.releaseSession = resolve;
      });
    }
    return { sessionId: `sub-${this.prompts.length}-${Math.random().toString(36).slice(2, 8)}` };
  }

  async setMode(_sessionId: string, modeId: string): Promise<unknown> {
    this.modes.push(modeId);
    return {};
  }

  async setModel(): Promise<unknown> {
    return {};
  }

  async prompt(request: {
    sessionId: string;
    prompt: ContentBlock[];
  }): Promise<{
    stopReason: string;
    usage?: { lastRequestInputTokens: number; completionTokens?: number; cachedReadTokens?: number };
  }> {
    this.blocks.push(request.prompt);
    this.prompts.push(request.prompt.map((p) => (p.type === "text" ? p.text : "")).join("\n"));
    const emit = (sessionUpdate: "agent_message_chunk" | "agent_thought_chunk", text: string): void => {
      this.callbacks.onSessionUpdate?.({
        sessionId: "sub",
        update: { sessionUpdate, content: { type: "text", text } },
      } as never);
    };
    if (this.plan === "usage") {
      emit("agent_message_chunk", "正在检查配置文件");
      emit("agent_thought_chunk", "先读 settings");
      return {
        stopReason: "end_turn",
        usage: { lastRequestInputTokens: 1_234, completionTokens: 56, cachedReadTokens: 12 },
      };
    }
    if (this.plan === "hang-text") {
      emit("agent_message_chunk", "已经写了一部分");
      return new Promise((resolve) => {
        this.settle = resolve;
      });
    }
    if (this.plan === "edit" || this.plan === "gate-session") {
      // A child that edits its worktree but does NOT commit (the common case:
      // the system prompt forbids committing without an explicit request).
      writeFileSync(path.join(this.cwd, "partial.txt"), "half done\n", "utf8");
      return { stopReason: "end_turn" };
    }
    if (this.plan === "commit") {
      // A real child edits files INSIDE its worktree and commits them.
      writeFileSync(path.join(this.cwd, "child.txt"), "from child\n", "utf8");
      git(this.cwd, "add", "-A");
      git(this.cwd, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "child work");
      return { stopReason: "end_turn" };
    }
    if (this.plan === "merge" || this.plan === "merge-noop") {
      // A merge child runs in the MAIN workspace (its cwd is the repo root)
      // and does what its task brief says: `git merge --no-ff <branch>`.
      const brief = request.prompt.map((p) => (p.type === "text" ? p.text : "")).join("\n");
      const match = /git merge --no-ff ([^\s`]+)/.exec(brief);
      const branch = match?.[1];
      if (this.plan === "merge" && branch) {
        git(this.cwd, "merge", "--no-ff", "--no-edit", branch);
      }
      return { stopReason: "end_turn" };
    }
    if (this.plan === "commit-a" || this.plan === "commit-a-gated") {
      // The child touches a file the user may also have edited locally —
      // this is the overlap case the integration step must defer on.
      writeFileSync(path.join(this.cwd, "a.txt"), "child side\n", "utf8");
      git(this.cwd, "add", "-A");
      git(this.cwd, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "child edits a");
      if (this.plan === "commit-a-gated") {
        await new Promise<void>((resolve) => {
          this.releasePrompt = resolve;
        });
      }
      return { stopReason: "end_turn" };
    }
    if (this.plan === "complete" || this.plan === "commit-gated-dispose") {
      return { stopReason: "end_turn" };
    }
    if (this.plan === "throw") throw new Error("child exploded");
    if (this.plan === "throw-object") {
      // JSON-RPC rejections are plain objects (`{code, message, data}`), not
      // Errors — naively stringifying them renders "[object Object]".
      throw { code: -32603, message: "内核拒绝了这次请求", data: { detail: "boom" } };
    }
    return new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  cancel(): void {
    this.settle?.({ stopReason: "cancelled" });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    // 进程回收挂起：回合已经结束，但「进程还活着」—— 用来观察并发额度。
    if (this.plan === "commit-gated-dispose") {
      await new Promise<void>((resolve) => {
        this.releaseDispose = resolve;
      });
    }
    // 真实 AcpClient 的 dispose 会 kill 进程，随后 child 的 exit 回调触发
    // onExit —— 管理层把它当作内核退出。这里照做，否则「先杀进程再落
    // cancelled」的顺序缺陷在测试里永远暴露不出来。
    this.callbacks.onExit?.(0, null);
  }
}

interface Harness {
  manager: SuperAgentManager;
  clients: FakeClient[];
  sessions: SuperSessionUi[];
  reports: { session: SuperSessionUi; report: SuperReport }[];
  /** Pushes seen on the child-transcript channel (incremental, `from`). */
  transcripts: { sessionId: string; from: number; blocks: Block[] }[];
  /** 「请智能体合并」的回调（自动集成没能把改动带回主分支时触发）。 */
  needMerges: { session: SuperSessionUi; reason: string }[];
  /** 合并子会话跑完后的检测结果（宿主据此 toast）。 */
  mergeResults: {
    sourceId: string;
    title: string;
    branch: string;
    merged: boolean;
    failed: boolean;
    detail: string;
  }[];
  /** 「子会话在等你回答」的通知（宿主据此弹系统通知）。 */
  needInputs: SuperSessionUi[];
}

function makeManager(
  repoRoot: string,
  plan: Plan | Plan[] = "complete",
  mode: SuperIntegrationMode = "merge",
  /** 归属主会话 id（函数形式 = 运行中可变，用例用来模拟「用户切了会话」）。 */
  mainSessionId: string | null | (() => string | null) = "main-1",
  /** 并发上限：排队用例显式注入小值，避免依赖某个写死的常量。 */
  maxConcurrent: number = DEFAULT_MAX_CONCURRENT_SUPER_SESSIONS,
  /** 隔离回收相关设置（默认：完成后回收工作目录、保留分支）。 */
  options: { keepWorktree?: boolean; maxWorktrees?: number } = {},
): Harness {
  const clients: FakeClient[] = [];
  const sessions: SuperSessionUi[] = [];
  const reports: { session: SuperSessionUi; report: SuperReport }[] = [];
  const transcripts: { sessionId: string; from: number; blocks: Block[] }[] = [];
  const needMerges: { session: SuperSessionUi; reason: string }[] = [];
  const mergeResults: Harness["mergeResults"] = [];
  const needInputs: SuperSessionUi[] = [];
  const manager = new SuperAgentManager({
    repoRoot,
    createClient: async (params) => {
      const planForClient = Array.isArray(plan) ? (plan[clients.length] ?? "complete") : plan;
      const client = new FakeClient(params.callbacks, planForClient);
      client.cwd = params.cwd;
      client.allowedRoots = params.allowedRoots;
      client.includeDirectories = params.includeDirectories;
      clients.push(client);
      return client as unknown as AcpClient;
    },
    onSessionsChanged: (next) => {
      sessions.length = 0;
      sessions.push(...next);
    },
    onReport: (entries) => {
      reports.push(...entries);
    },
    onNeedInput: (session) => {
      needInputs.push(session);
    },
    onNeedAgentMerge: (session, reason) => {
      needMerges.push({ session, reason });
    },
    onMergeResult: (info) => {
      mergeResults.push(info);
    },
    onTranscript: (sessionId, from, blocks) => {
      transcripts.push({ sessionId, from, blocks });
    },
    currentModel: () => "test-model",
    currentMainSessionId: () =>
      typeof mainSessionId === "function" ? mainSessionId() : mainSessionId,
    priceFor: () => ({ input: 1, output: 2 }),
    integrationMode: () => mode,
    maxConcurrentSessions: () => maxConcurrent,
    keepWorktree: () => options.keepWorktree ?? false,
    maxWorktrees: () => options.maxWorktrees ?? 10,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { manager, clients, sessions, reports, transcripts, needMerges, mergeResults, needInputs };
}

/**
 * Poll until the condition holds. The manager's work is asynchronous (git
 * worktree creation + a fake client's handshake), so a fixed sleep is flaky
 * under a loaded test run — polling is both faster and deterministic.
 */
async function until(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition not met in time");
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("super agent · 编排", () => {
  it("派发的子会话在自己的 worktree 里跑，边界只含 worktree", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo);
    harness.manager.spawn({ title: "改登录", task: "修好 src/auth.ts" });
    await until(() => harness.sessions[0]?.status === "completed");

    const session = harness.sessions[0];
    expect(session?.status).toBe("completed");
    expect(session?.isolation.kind).toBe("git_worktree");
    expect(session?.isolation.branch).toContain("iflow/super/");
    expect(existsSync(session?.isolation.path ?? "")).toBe(true);
    // 工作副本跟着项目走，不写扩展自己的数据目录。
    expect(path.resolve(session?.isolation.path ?? "").startsWith(path.resolve(repo))).toBe(true);
    expect(session?.isolation.path).toContain(path.join(".iflow", "super", "worktrees"));

    const client = harness.clients[0];
    expect(client).toBeDefined();
    // 关键：子会话看不到主工作区。
    expect(client?.cwd).toBe(session?.isolation.path);
    expect(client?.allowedRoots).toEqual([session?.isolation.path]);
    expect(client?.cwd).not.toBe(repo);
  }, 30000);

  it("子会话被推到 yolo 模式（刻意完全自主，不因审批往返停顿）", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "hang");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "running");
    expect(harness.clients[0]?.modes).toEqual(["yolo"]);
  }, 30000);

  it("审批请求由宿主直接放行，不产生待办、不打扰主会话", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "hang");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "running");
    const reportsBefore = harness.reports.length;

    const response = (await harness.clients[0]!.callbacks.onRequestPermission?.({
      sessionId: "sub-1",
      toolCall: { toolCallId: "t1", toolName: "write_file", title: "写入 a.txt" },
      options: [
        { optionId: "allow", name: "允许", kind: "allow_once" },
        { optionId: "always", name: "始终允许", kind: "allow_always" },
        { optionId: "deny", name: "拒绝", kind: "reject_once" },
      ],
    } as never)) as { outcome: { outcome: string; optionId?: string } };

    // 非 shell 工具选 allow_always：同一个子会话后续不该再问。
    expect(response.outcome).toEqual({ outcome: "selected", optionId: "always" });
    expect(harness.sessions[0]?.status).toBe("running");
    expect(harness.sessions[0]?.pending).toBeUndefined();
    expect(harness.reports.length).toBe(reportsBefore);
  }, 30000);

  it("兜底路径：shell 审批回 allow_once（allow_always 会让后续命令绕过护栏）", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "hang");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "running");

    const response = (await harness.clients[0]!.callbacks.onRequestPermission?.({
      sessionId: "sub-1",
      toolCall: {
        toolCallId: "t2",
        toolName: "run_shell_command",
        kind: "execute",
        title: "npm test",
        args: { command: "npm test" },
      },
      options: [
        { optionId: "allow", name: "允许", kind: "allow_once" },
        { optionId: "always", name: "始终允许", kind: "allow_always" },
        { optionId: "deny", name: "拒绝", kind: "reject_once" },
      ],
    } as never)) as { outcome: { outcome: string; optionId?: string } };

    expect(response.outcome).toEqual({ outcome: "selected", optionId: "allow" });
  }, 30000);

  it("兜底路径：命中依赖护栏的 shell 命令被拒绝，子会话继续跑、不产生待办", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "hang");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "running");
    const reportsBefore = harness.reports.length;

    const response = (await harness.clients[0]!.callbacks.onRequestPermission?.({
      sessionId: "sub-1",
      toolCall: {
        toolCallId: "t3",
        toolName: "run_shell_command",
        kind: "execute",
        title: `npm ci --prefix "${repo}"`,
        args: { command: `npm ci --prefix "${repo}"` },
      },
      options: [
        { optionId: "allow", name: "允许", kind: "allow_once" },
        { optionId: "always", name: "始终允许", kind: "allow_always" },
        { optionId: "deny", name: "拒绝", kind: "reject_once" },
      ],
    } as never)) as { outcome: { outcome: string; optionId?: string } };

    expect(response.outcome).toEqual({ outcome: "selected", optionId: "deny" });
    expect(harness.sessions[0]?.status).toBe("running");
    expect(harness.sessions[0]?.pending).toBeUndefined();
    expect(harness.reports.length).toBe(reportsBefore);
  }, 30000);

  it("计划退出也自动批准", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "hang");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "running");
    const response = await harness.clients[0]!.callbacks.onExitPlanMode?.({
      sessionId: "sub-1",
      plan: "1. 改代码 2. 跑测试",
    } as never);
    expect(response).toEqual({ approved: true });
  }, 30000);

  it("子会话的提问落到它自己的 pending，用户应答后恢复", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "hang");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "running");

    const questions: UserQuestion[] = [
      {
        header: "方案",
        question: "用哪个方案？",
        multiSelect: false,
        options: [
          { label: "A", description: "小改" },
          { label: "B", description: "大改" },
        ],
      },
    ];
    let answered: unknown = null;
    const pendingCall = harness.clients[0]!.callbacks.onUserQuestions?.({
      sessionId: "sub-1",
      questions,
    } as never).then((response) => {
      answered = response;
    });

    await until(() => harness.sessions[0]?.status === "awaiting_input");
    const session = harness.sessions[0]!;
    expect(session.pending?.kind).toBe("question");
    expect(session.pending?.questions).toEqual(questions);
    // 等待用户处理也要上报主会话。
    expect(harness.reports.at(-1)?.report.state).toBe("blocked");

    const answeredOk = harness.manager.respond(session.id, { answers: { 方案: "A" } });
    expect(answeredOk).toBe(true);
    await pendingCall;
    expect((answered as { answers: Record<string, string> }).answers).toEqual({ 方案: "A" });
    expect(harness.sessions[0]?.status).toBe("running");
    expect(harness.sessions[0]?.pending).toBeUndefined();
  }, 30000);

  it("子会话开始等你回答时通知一次 onNeedInput（宿主据此弹系统通知）", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "hang");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "running");
    expect(harness.needInputs).toHaveLength(0);

    const questions: UserQuestion[] = [
      { header: "方案", question: "用哪个方案？", multiSelect: false, options: [{ label: "A" }] },
    ];
    const pendingCall = harness.clients[0]!.callbacks.onUserQuestions?.({
      sessionId: "sub-1",
      questions,
    } as never);

    await until(() => harness.sessions[0]?.status === "awaiting_input");
    // 恰好一次，且带的是子会话记录（宿主用它取标题）。
    expect(harness.needInputs).toHaveLength(1);
    expect(harness.needInputs[0]?.title).toBe("改登录");
    expect(harness.needInputs[0]?.pending?.kind).toBe("question");

    // 应答后不再有第二次通知。
    harness.manager.respond(harness.sessions[0]!.id, { answers: { 方案: "A" } });
    await pendingCall;
    expect(harness.needInputs).toHaveLength(1);
  }, 30000);

  it("同一 pending 的重复 apply 不重复通知", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "hang");
    const spawned = harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "running");

    const pendingCall = harness.clients[0]!.callbacks.onUserQuestions?.({
      sessionId: "sub-1",
      questions: [{ header: "方案", question: "用哪个方案？", multiSelect: false, options: [{ label: "A" }] }],
    } as never);
    await until(() => harness.sessions[0]?.status === "awaiting_input");
    expect(harness.needInputs).toHaveLength(1);

    // 同一个 pending 再 apply 一次（看板重放 / 迟到事件）：用户已经看到这条
    // 通知了，不该再被惊动。
    const pending = harness.sessions[0]!.pending!;
    (harness.manager as unknown as {
      apply: (id: string, event: { type: "needs_input"; pending: unknown; at: number }) => void;
    }).apply(spawned.id, { type: "needs_input", pending, at: Date.now() });
    expect(harness.needInputs).toHaveLength(1);

    harness.manager.respond(spawned.id, { answers: { 方案: "A" } });
    await pendingCall;
  }, 30000);

  it("恢复出来的历史子会话收到 needs_input 也不通知", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "hang");
    harness.manager.restoreSessions("main-1", [
      {
        id: "super-old",
        title: "上次没跑完的活",
        task: "干活",
        status: "cancelled",
        restored: true,
        isolation: { kind: "git_worktree", path: "/tmp/wt-old", branch: "iflow/super/old" },
        mainSessionId: "main-1",
        createdAt: 100,
        updatedAt: 200,
        reports: [],
      },
    ]);

    (harness.manager as unknown as {
      apply: (id: string, event: { type: "needs_input"; pending: unknown; at: number }) => void;
    }).apply("super-old", {
      type: "needs_input",
      pending: { kind: "question", requestId: "q1", questions: [], deadline: 0, timeoutMs: 0 },
      at: Date.now(),
    });

    // 历史子会话没有进程，也不在看板上等你回答 —— 不该弹通知。
    expect(harness.needInputs).toHaveLength(0);
    expect(harness.manager.get("super-old")?.status).toBe("cancelled");
  }, 30000);

  it("任务说明连同工作目录一起交给子会话", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo);
    harness.manager.spawn({ title: "改登录", task: "修好 src/auth.ts" });
    await until(() => harness.sessions[0]?.status === "completed");
    const prompt = harness.clients[0]?.prompts[0] ?? "";
    expect(prompt).toContain("修好 src/auth.ts");
    expect(prompt).toContain(harness.sessions[0]?.isolation.path ?? "X");
    // 提示词本身是英文（子会话跑同一份英文系统提示）。
    expect(prompt).toContain("tool calls are never reviewed or approved");
  }, 30000);

  it("子会话的实时操作（思考/工具/正文）进入自己的转录并增量推送，委派提示词不出现", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "hang");
    const session = harness.manager.spawn({ title: "改登录", task: "修好 src/auth.ts" });
    await until(() => harness.sessions[0]?.status === "running");
    // Wait until `client.prompt` was actually called, so the injections below
    // land after the setMode/setModel awaits in prepare.
    await until(() => (harness.clients[0]?.prompts.length ?? 0) === 1);

    const cb = harness.clients[0]!.callbacks;
    cb.onSessionUpdate?.({
      sessionId: "sub",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "先看代码" } },
    } as never);
    cb.onSessionUpdate?.({
      sessionId: "sub",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        toolName: "read_file",
        title: "读取 src/auth.ts",
        kind: "read",
        status: "in_progress",
        content: [],
        locations: [],
        args: { path: "src/auth.ts" },
      },
    } as never);
    cb.onSessionUpdate?.({
      sessionId: "sub",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "改好了" } },
    } as never);

    await until(() => harness.manager.transcriptBlocks(session.id).length >= 3);
    const blocks = harness.manager.transcriptBlocks(session.id);
    // 委派提示词不写进转录（「查看实时操作」只展示子会话自己的动作）。
    expect(blocks.map((b) => b.kind)).toEqual(["thought", "tool", "text"]);
    expect(blocks.every((b) => b.kind !== "user")).toBe(true);
    if (blocks[1]?.kind === "tool") expect(blocks[1].toolName).toBe("read_file");
    if (blocks[2]?.kind === "text") expect(blocks[2].text).toBe("改好了");

    // 节流推送（~120ms）真正到达后再断言。
    await until(() => harness.transcripts.length > 0);
    // 首次推送从 0 开始且不带头部的用户块，详情打开即渲染子会话动作。
    expect(harness.transcripts[0]?.from).toBe(0);
    expect(harness.transcripts[0]?.blocks[0]?.kind).toBe("thought");
  }, 30000);

  it("非 git 仓库降级为目录隔离并如实标注", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "iflow-nogit-"));
    roots.push(dir);
    const harness = makeManager(dir);
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "completed");
    const session = harness.sessions[0];
    expect(session?.isolation.kind).toBe("directory");
    expect(session?.isolation.note).toBeTruthy();
    expect(session?.status).toBe("completed");
    // 目录隔离没有分支，自然也不会有集成结果。
    expect(session?.integration).toBeUndefined();
  }, 30000);

  it("子会话完成后上报主会话（ready），中间进展不上报", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo);
    harness.manager.spawn({ title: "改登录", task: "干活" });
    // 完成上报发生在自动集成之后，等状态会抢跑。
    await until(() => harness.reports.length > 0);
    expect(harness.sessions[0]?.status).toBe("completed");
    const states = harness.reports.map((r) => r.report.state);
    expect(states).toContain("ready");
    expect(states).not.toContain("progress");
  }, 30000);

  it("子会话失败时上报 failed 并记录原因", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "throw");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "failed");
    expect(harness.sessions[0]?.status).toBe("failed");
    expect(harness.reports.at(-1)?.report.state).toBe("failed");
  }, 30000);

  it("JSON-RPC 普通对象失败时给出可读原因，而不是 [object Object]", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "throw-object");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "failed");
    const error = harness.sessions[0]?.error ?? "";
    expect(error).toContain("内核拒绝了这次请求");
    expect(error).not.toContain("[object Object]");
    expect(harness.reports.at(-1)?.report.summary).toContain("内核拒绝了这次请求");
  }, 30000);

  it("中断子会话 → cancelled 并终止进程（内核退出不算失败）", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "hang");
    const session = harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "running");
    await harness.manager.cancel(session.id);
    expect(harness.sessions[0]?.status).toBe("cancelled");
    expect(harness.clients[0]?.disposed).toBe(true);
    // 终止进程会触发 onExit —— 它不能被记成内核异常退出，也不能上报失败。
    expect(harness.sessions[0]?.error).toBeUndefined();
    expect(harness.reports.filter((entry) => entry.report.state === "failed")).toHaveLength(0);
  }, 30000);

  it("并发超出的派发进排队，槽位空出后自动开跑", async () => {
    const repo = makeRepo();
    const limit = 2;
    const harness = makeManager(repo, "hang", "merge", "main-1", limit);
    const ids: string[] = [];
    for (let i = 0; i < limit + 2; i++) {
      ids.push(harness.manager.spawn({ title: `任务 ${i}`, task: "干活" }).id);
    }
    await until(() => harness.clients.length >= limit);
    const queued = harness.sessions.filter((s) => s.queued);
    expect(queued.length).toBe(2);
    expect(harness.clients.length).toBe(limit);

    // 腾出一个槽位 → 排队的那个自动开跑。
    await harness.manager.cancel(ids[0]!);
    await until(() => harness.clients.length === limit + 1);
    expect(harness.clients.length).toBe(limit + 1);
    expect(harness.sessions.filter((s) => s.queued).length).toBe(1);
  }, 30000);

  it("面板关闭时终止全部子进程，但保留 worktree", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "hang");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "running");
    const kept = await harness.manager.dispose();
    expect(harness.clients[0]?.disposed).toBe(true);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.path).toContain(path.join(".iflow", "super", "worktrees"));
    // worktree 还在 —— 用户可能还没合并里面的工作。
    expect(existsSync(kept[0]?.path ?? "")).toBe(true);
  }, 30000);

  it("清理子会话时保留有未合并提交的分支", async () => {
    const repo = makeRepo();
    // manual 模式：不做自动集成。keepWorktree=true 让工作目录活到测试自己
    // 往里提交为止（默认已完成即回收目录、只保留分支，本用例要验的是清理
    // 路径对未合并分支的处理）。
    const harness = makeManager(
      repo,
      "complete",
      "manual",
      "main-1",
      DEFAULT_MAX_CONCURRENT_SUPER_SESSIONS,
      { keepWorktree: true },
    );
    const session = harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "completed");
    // 宿主在 completed 之后还会检查一次 worktree 并可能代提交（`git add -A`）；
    // 等它上报完成再动 worktree，否则两个 git 进程会撞 index.lock。
    await until(() => harness.reports.length > 0);
    // 在 worktree 里提交一次 → 分支上有未合并提交。
    const wt = harness.sessions[0]?.isolation.path!;
    writeFileSync(path.join(wt, "b.txt"), "work\n", "utf8");
    git(wt, "add", "-A");
    git(wt, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "child");

    const result = await harness.manager.cleanup(session.id);
    expect(result.branchKept).toBe(true);
    expect(result.reason).toContain("未合并");
    expect(existsSync(wt)).toBe(false);
  }, 30000);

  it("结算 token 用量、预估成本与模型，并留下实时进度", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "usage");
    harness.manager.spawn({ title: "检查配置", task: "看看设置文件" });
    await until(() => harness.sessions[0]?.status === "completed");
    await until(() => harness.sessions[0]?.tokens !== undefined);

    const session = harness.sessions[0]!;
    expect(session.model).toBe("test-model");
    expect(session.progress).toContain("正在检查配置文件");

    const usage = session.tokens!;
    expect(usage.input).toBe(1_234);
    expect(usage.authoritative).toBe(true);
    expect(usage.cachedRead).toBe(12);
    // The reported completion (56) is larger than the tiny text estimate.
    expect(usage.output).toBeGreaterThanOrEqual(56);
    expect(usage.estimatedCost).toBeCloseTo(
      (usage.input / 1_000_000) * 1 + (usage.output / 1_000_000) * 2,
      10,
    );
  }, 30000);

  it("中断也保留已产生的用量（输入标记为非权威）", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "hang-text");
    const session = harness.manager.spawn({ title: "检查配置", task: "看看设置文件" });
    await until(() => harness.sessions[0]?.status === "running");

    await harness.manager.cancel(session.id);
    await until(() => harness.sessions[0]?.tokens !== undefined);

    const usage = harness.sessions[0]?.tokens!;
    expect(usage.authoritative).toBe(false);
    expect(usage.input).toBeGreaterThan(0);
    expect(usage.output).toBeGreaterThan(0);
    expect(harness.sessions[0]?.progress).toContain("已经写了一部分");
  }, 30000);
});

describe("super agent · 自动集成", () => {
  it("完成后自动把分支合并回主工作区（merge 模式）", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "commit", "merge");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.integration?.state === "merged");
    await until(() => harness.reports.length > 0);

    const session = harness.sessions[0]!;
    expect(session.integration?.mode).toBe("merge");
    expect(session.integration?.needsAction).toBeFalsy();
    // 子会话的提交真的回到了主工作区。
    expect(existsSync(path.join(repo, "child.txt"))).toBe(true);
    expect(readFileSync(path.join(repo, "child.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("from child\n");
    // 上报时已带上集成结果，主会话据此转述。
    expect(
      harness.reports.some((r) => r.report.state === "ready" && r.session.integration?.state === "merged"),
    ).toBe(true);
  }, 30000);

  it("子会话没提交时宿主代提交，再正常自动合并", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "edit", "merge");
    harness.manager.spawn({ title: "写文件", task: "把文件写出来但不提交" });
    await until(() => harness.sessions[0]?.integration?.state === "merged");

    const session = harness.sessions[0]!;
    expect(session.integration?.needsAction).toBeFalsy();
    // 宿主补的提交让自动合并真的把文件带回了主工作区。
    expect(existsSync(path.join(repo, "partial.txt"))).toBe(true);
    expect(
      session.reports.some((report) => report.summary.includes("宿主已代子会话提交")),
    ).toBe(true);
  }, 30000);

  it("主工作区的未跟踪文件与无关改动不再挡路：照常合并且本地改动原样保留", async () => {
    const repo = makeRepo();
    // 两种最常见的「脏」：未跟踪文件 + 与子会话无关的已跟踪改动。
    writeFileSync(path.join(repo, "untracked.txt"), "screenshot\n", "utf8");
    writeFileSync(path.join(repo, "a.txt"), "local edit\n", "utf8");

    const harness = makeManager(repo, "commit", "merge");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.integration?.state === "merged");
    await until(() => harness.reports.length > 0);

    const session = harness.sessions[0]!;
    expect(session.integration?.needsAction).toBeFalsy();
    expect(session.integration?.detail).toContain("原样保留");
    // 子会话的改动回到了主工作区……
    expect(existsSync(path.join(repo, "child.txt"))).toBe(true);
    // ……而用户自己的未提交改动一个字都没被覆盖。
    expect(readFileSync(path.join(repo, "a.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("local edit\n");
    expect(readFileSync(path.join(repo, "untracked.txt"), "utf8").replace(/\r\n/g, "\n")).toBe(
      "screenshot\n",
    );
    expect(harness.reports.at(-1)?.report.state).toBe("ready");
  }, 30000);

  it("主工作区的改动与子会话改动重叠时跳过，并列出重叠文件", async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, "a.txt"), "local edit\n", "utf8");

    const harness = makeManager(repo, "commit-a", "merge");
    harness.manager.spawn({ title: "改 a.txt", task: "干活" });
    await until(() => harness.sessions[0]?.integration?.state === "skipped");
    await until(() => harness.reports.length > 0);

    const session = harness.sessions[0]!;
    expect(session.integration?.needsAction).toBe(true);
    expect(session.integration?.detail).toContain("重叠");
    expect(session.integration?.detail).toContain("a.txt");
    // 用户的改动没有被覆盖，分支保留。
    expect(readFileSync(path.join(repo, "a.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("local edit\n");
    expect(harness.reports.at(-1)?.report.state).toBe("blocked");
  }, 30000);

  it("改动没能自动合并时，自动请主会话智能体合并（不再等用户点按钮）", async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, "a.txt"), "local edit\n", "utf8");

    const harness = makeManager(repo, "commit-a", "merge");
    harness.manager.spawn({ title: "改 a.txt", task: "干活" });
    await until(() => harness.needMerges.length > 0);

    const request = harness.needMerges[0]!;
    expect(request.session.id).toBe(harness.sessions[0]?.id);
    // 原因如实带给宿主（它会写进请求提示词，智能体据此知道背景）。
    // 提示词是英文的，所以这里断言的是英文原因。
    expect(request.reason).toContain("overlap");
  }, 30000);

  it("自动合并成功时不再打扰智能体", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "commit", "merge");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.integration?.state === "merged");
    expect(harness.needMerges).toHaveLength(0);
  }, 30000);

  it("自动合并成功后清理 worktree 与本地分支，记录保留", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "commit", "merge");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.integration?.state === "merged");

    const session = harness.sessions[0]!;
    const worktree = session.isolation.path;
    const branch = session.isolation.branch!;

    await until(() => harness.sessions[0]?.isolation.released === true);
    // 磁盘上的 worktree 与分支都清掉了……
    expect(existsSync(worktree)).toBe(false);
    expect(gitOut(repo, "branch", "--list", branch).trim()).toBe("");
    // ……而看板记录还在（分支名 / 路径留作追溯）。
    expect(harness.sessions[0]?.id).toBe(session.id);
    expect(harness.sessions[0]?.isolation.branch).toBe(branch);
    // 合并回来的文件确实在主工作区。
    expect(existsSync(path.join(repo, "child.txt"))).toBe(true);
  }, 30000);

  it("合并子会话合入后，worktree 里还有未提交改动时保留目录与分支（绝不丢数据）", async () => {
    const repo = makeRepo();
    // 第一个子会话在 worktree 里提交；第二个是合并子会话（主仓工作区档）。
    // keepWorktree=true：默认完成后会回收目录，而本用例要往目录里写 leftover。
    const harness = makeManager(
      repo,
      ["commit", "merge"],
      "manual",
      "main-1",
      DEFAULT_MAX_CONCURRENT_SUPER_SESSIONS,
      { keepWorktree: true },
    );
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "completed");
    // 宿主在终态之后还会检查 worktree 并可能代提交（`git add -A`）。ready 上报
    // 发生在那之后，是这条尾巴结束的确定信号 —— 否则我们写的文件会被顺带提交。
    await until(() => harness.reports.some((entry) => entry.report.state === "ready"));

    const worktree = harness.sessions[0]!.isolation.path;
    const branch = harness.sessions[0]!.isolation.branch!;
    // 子会话结束后又留下一份未提交内容（重试现场 / 用户手动改过）。
    writeFileSync(path.join(worktree, "leftover.txt"), "keep me\n", "utf8");

    // 派一个合并子会话：它在主仓工作区里把分支真的合进来。
    const merge = await harness.manager.spawnMerge({
      source: harness.sessions[0]!,
      task: `[合并任务]\n执行 \`git merge --no-ff ${branch}\``,
      title: `合并分支 ${branch}`,
    });
    expect(merge).not.toBeNull();
    await until(() => harness.mergeResults.length > 0);

    // 合并已确认，但目录不干净 → 不删、不标 released、分支保留。
    expect(harness.mergeResults[0]?.merged).toBe(true);
    expect(harness.sessions[0]?.integration?.state).toBe("merged");
    expect(harness.sessions[0]?.isolation.released).toBeFalsy();
    expect(existsSync(path.join(worktree, "leftover.txt"))).toBe(true);
    expect(readFileSync(path.join(worktree, "leftover.txt"), "utf8").replace(/\r\n/g, "\n")).toBe(
      "keep me\n",
    );
    expect(gitOut(repo, "branch", "--list", branch)).toContain(branch);
  }, 30000);

  it("manual 模式不触发自动合并请求（用户要自己收拾分支）", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "commit", "manual");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "completed");
    expect(harness.needMerges).toHaveLength(0);
  }, 30000);

  it("预演发现冲突时不启动合并，仓库保持原状", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "commit-a-gated", "merge");
    harness.manager.spawn({ title: "改 a.txt", task: "干活" });
    // 子会话先完成自己的提交，再让主分支上出现冲突改动。
    await until(() => Boolean(harness.clients[0]?.releasePrompt));
    writeFileSync(path.join(repo, "a.txt"), "main side\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "main side");
    harness.clients[0]!.releasePrompt!();

    await until(() => harness.sessions[0]?.integration?.state === "conflict");
    // 冲突在预演阶段就被识别 → 真正的 merge 没启动 → 没有 MERGE_HEAD、文件未被改写。
    expect(existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(readFileSync(path.join(repo, "a.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("main side\n");
  }, 30000);

  it("manual 模式不做任何自动集成", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "commit", "manual");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "completed");
    expect(harness.sessions[0]?.integration).toBeUndefined();
    expect(existsSync(path.join(repo, "child.txt"))).toBe(false);
  }, 30000);

  it("子会话没有产生提交时如实标注无需合并（不需要用户动手）", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "complete", "merge");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.integration?.state === "not_needed");
    await until(() => harness.reports.length > 0);

    const session = harness.sessions[0]!;
    expect(session.integration?.detail).toContain("没有产生任何提交");
    expect(session.integration?.needsAction).toBeFalsy();
    expect(harness.reports.at(-1)?.report.state).toBe("ready");
    // 没有任何东西可合并 → 不该白跑一轮「让智能体合并」。
    expect(harness.needMerges).toHaveLength(0);
  }, 30000);

  it("合并子会话的结果由只读 git 检测写入 integration：没并入就如实说仍保留", async () => {
    const repo = makeRepo();
    // 合并子会话什么都不做（只汇报自己干了活）—— 宿主不能信它的自述。
    const harness = makeManager(repo, ["commit", "merge-noop"], "manual");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "completed");
    const branch = harness.sessions[0]!.isolation.branch!;

    const merge = await harness.manager.spawnMerge({
      source: harness.sessions[0]!,
      task: `[合并任务]\n执行 \`git merge --no-ff ${branch}\``,
      title: `合并分支 ${branch}`,
    });
    expect(merge).not.toBeNull();
    await until(() => harness.mergeResults.length > 0);

    // 分支没并入 → 如实记「仍保留」，绝不谎报成功。
    expect(harness.mergeResults[0]?.merged).toBe(false);
    expect(harness.mergeResults[0]?.branch).toBe(branch);
    const integration = harness.sessions[0]?.integration;
    expect(integration?.state).not.toBe("merged");
    expect(integration?.needsAction).toBe(true);
    expect(integration?.detail).toContain(branch);
    // 改动没回到主工作区。
    expect(existsSync(path.join(repo, "child.txt"))).toBe(false);
  }, 30000);

  it("合并子会话真的合入后：integration 记为已合并，改动回到主工作区", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, ["commit", "merge"], "manual");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "completed");
    const branch = harness.sessions[0]!.isolation.branch!;

    const merge = await harness.manager.spawnMerge({
      source: harness.sessions[0]!,
      task: `[合并任务]\n执行 \`git merge --no-ff ${branch}\``,
      title: `合并分支 ${branch}`,
    });
    expect(merge).not.toBeNull();
    await until(() => harness.mergeResults.length > 0);

    expect(harness.mergeResults[0]?.merged).toBe(true);
    const integration = harness.sessions[0]?.integration;
    expect(integration?.state).toBe("merged");
    expect(integration?.detail).toContain(branch);
    expect(integration?.needsAction).toBeFalsy();
    // 子会话的改动真的回到了主工作区。
    expect(existsSync(path.join(repo, "child.txt"))).toBe(true);
    // 合并子会话自己没有分支：它不进入「自动合并它的分支」那条流程。
    const mergeSession = harness.sessions.find((s) => s.id === merge!.id);
    expect(mergeSession?.isolation.kind).toBe("repo");
    expect(mergeSession?.isolation.branch).toBeUndefined();
    expect(mergeSession?.integration).toBeUndefined();
  }, 30000);
});

describe("super agent · 合并子会话（主仓工作区档）", () => {
  it("合并子会话跑在主仓工作区：cwd / allowedRoots / includeDirectories 都是主仓根", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, ["commit", "merge-noop"], "manual");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "completed");
    const branch = harness.sessions[0]!.isolation.branch!;

    const merge = await harness.manager.spawnMerge({
      source: harness.sessions[0]!,
      task: `[合并任务]\n执行 \`git merge --no-ff ${branch}\``,
      title: `合并分支 ${branch}`,
    });
    expect(merge).not.toBeNull();
    await until(() => harness.clients.length === 2);

    const client = harness.clients[1]!;
    // 工作目录就是主仓根（合并只能在目标分支所在的工作区发生）。
    expect(client.cwd).toBe(repo);
    expect(client.allowedRoots).toEqual([repo]);
    // CLI 侧 isPathWithinWorkspace 与宿主 resolveAgentPath 同源：主仓根必须
    // 显式交给 CLI，否则它读不到主仓文件。
    expect(client.includeDirectories).toEqual([repo]);

    // 隔离档位是 repo：没有自己的分支，也没有 worktree。
    const mergeSession = harness.sessions.find((s) => s.id === merge!.id);
    expect(mergeSession?.isolation.kind).toBe("repo");
    expect(mergeSession?.isolation.path).toBe(repo);
    expect(mergeSession?.isolation.branch).toBeUndefined();
  }, 30000);

  it("清理合并子会话只移除记录，绝不删主仓工作区", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, ["commit", "merge-noop"], "manual");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "completed");
    const branch = harness.sessions[0]!.isolation.branch!;

    const merge = await harness.manager.spawnMerge({
      source: harness.sessions[0]!,
      task: `[合并任务]\n执行 \`git merge --no-ff ${branch}\``,
      title: `合并分支 ${branch}`,
    });
    expect(merge).not.toBeNull();
    await until(() => harness.mergeResults.length > 0);

    const cleaned = await harness.manager.cleanup(merge!.id);
    expect(cleaned.ok).toBe(true);
    // 主仓根还在，里面的一切都没被动过。
    expect(existsSync(repo)).toBe(true);
    expect(readFileSync(path.join(repo, "a.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("one\n");
    expect(existsSync(path.join(repo, ".git"))).toBe(true);
    // 记录也没了。
    expect(harness.manager.get(merge!.id)).toBeUndefined();
  }, 30000);

  it("同一时刻只能有一个合并子会话（主仓工作区没有版本隔离）", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, ["commit", "hang", "merge-noop"], "manual");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "completed");
    const branch = harness.sessions[0]!.isolation.branch!;

    const first = await harness.manager.spawnMerge({
      source: harness.sessions[0]!,
      task: `[合并任务]\n执行 \`git merge --no-ff ${branch}\``,
      title: `合并分支 ${branch}`,
    });
    expect(first).not.toBeNull();
    await until(() => harness.clients.length === 2);

    // 第一个还在跑 → 第二个不派（并发合并同一个仓库会把状态搅乱）。
    const second = await harness.manager.spawnMerge({
      source: harness.sessions[0]!,
      task: `[合并任务]\n执行 \`git merge --no-ff ${branch}\``,
      title: `合并分支 ${branch}`,
    });
    expect(second).toBeNull();

    await harness.manager.cancel(first!.id);
  }, 30000);

  it("合并子会话的提示词写死边界：不许 git add -A / commit -a / stash", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, ["commit", "merge-noop"], "manual");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "completed");
    const branch = harness.sessions[0]!.isolation.branch!;

    const merge = await harness.manager.spawnMerge({
      source: harness.sessions[0]!,
      task: `[合并任务]\n执行 \`git merge --no-ff ${branch}\``,
      title: `合并分支 ${branch}`,
    });
    expect(merge).not.toBeNull();
    await until(() => (harness.clients[1]?.prompts.length ?? 0) === 1);

    const prompt = harness.clients[1]?.prompts[0] ?? "";
    // 主仓工作区档：允许合并，但绝不能卷走用户未提交的其它改动。
    expect(prompt).toContain("git merge --no-ff");
    expect(prompt).toContain("`git add -A`");
    expect(prompt).toContain("`git commit -a`");
    expect(prompt).toContain("`git stash`");
    // 也不能让子会话自己提交：合并提交就是交付物。
    expect(prompt).not.toContain("git add -A && git commit");
    expect(prompt).toContain("do not create commits of your own");
  }, 30000);
});

describe("super agent · 任务提示词", () => {
  it("含标题、任务、工作目录与分支（英文骨架）", () => {
    const text = buildTaskPrompt(
      "改登录",
      "修好 src/auth.ts",
      { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/x", baseRef: "abc" },
    );
    expect(text).toContain("Task title: 改登录");
    expect(text).toContain("Task description:");
    expect(text).toContain("修好 src/auth.ts");
    expect(text).toContain("/tmp/wt");
    expect(text).toContain("iflow/super/x");
  });

  it("目录隔离时不提分支", () => {
    const text = buildTaskPrompt("改登录", "干活", { kind: "directory", path: "/tmp/dir" });
    expect(text).toContain("/tmp/dir");
    expect(text).toContain("directory isolation only");
    expect(text).not.toContain("iflow/super/");
  });

  it("明确告知非交互、要求自己提交、且不要自己合并/推送", () => {
    const text = buildTaskPrompt(
      "改登录",
      "干活",
      { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/x", baseRef: "abc" },
    );
    expect(text).toContain("tool calls are never reviewed or approved");
    expect(text).toContain("git add -A && git commit");
    expect(text).toContain("do not push");
    expect(text).toContain("commits any changes you leave uncommitted");
  });

  it("目录隔离时用英文 degradeReason 说明原因，中文 note 不进提示词", () => {
    const text = buildTaskPrompt("改登录", "干活", {
      kind: "directory",
      path: "/tmp/dir",
      note: "worktree 创建失败（fatal: 路径过长），仅目录隔离",
      degradeReason: "worktree creation failed: fatal: path too long",
    });
    expect(text).toContain("worktree creation failed: fatal: path too long");
    expect(text).toContain("do not run git commands");
    expect(text).not.toContain("git add -A && git commit");
    // 面向看板的中文说明只给人看。
    expect(text).not.toContain("worktree 创建失败");
  });

  it("重试提示词说明上一轮中断、要求先检查现状", () => {
    const text = buildTaskPrompt(
      "改登录",
      "干活",
      { kind: "directory", path: "/tmp/dir" },
      undefined,
      { attempt: 2, error: "子会话内核退出（code=1）", summary: "已改了一半" },
    );
    expect(text).toContain("This is a retry (attempt 2)");
    expect(text).toContain("子会话内核退出");
    expect(text).toContain("inspect the current state first");
    expect(text).toContain("已改了一半");
  });

  it("首次执行的提示词里没有重试说明", () => {
    const text = buildTaskPrompt("改登录", "干活", { kind: "directory", path: "/tmp/dir" });
    expect(text).not.toContain("This is a retry");
  });
});

describe("super agent · 意外中断后重试", () => {
  it("失败后可以重试，沿用原工作目录与分支，并保留上次的未提交改动", async () => {
    const repo = makeRepo();
    // keepWorktree=true：第二轮完成时宿主会代提交 partial.txt，默认回收会
    // 把目录删掉 —— 本用例要验的是重试复用现场，不是回收。
    const harness = makeManager(
      repo,
      ["throw", "complete"],
      "manual",
      "main-1",
      DEFAULT_MAX_CONCURRENT_SUPER_SESSIONS,
      { keepWorktree: true },
    );
    const spawned = harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "failed");

    const first = harness.sessions[0]!;
    const originalPath = first.isolation.path;
    const originalBranch = first.isolation.branch;
    // 模拟中断前留下、尚未提交的工作。
    writeFileSync(path.join(originalPath, "partial.txt"), "half done\n", "utf8");

    expect(await harness.manager.retry(spawned.id)).toBe(true);
    await until(() => harness.sessions[0]?.status === "completed");

    const second = harness.sessions[0]!;
    expect(second.attempts).toBe(2);
    expect(second.error).toBeUndefined();
    expect(second.isolation.path).toBe(originalPath);
    expect(second.isolation.branch).toBe(originalBranch);
    // 重试起的是新进程，但工作目录还是同一个 —— 之前没提交的改动还在。
    expect(harness.clients).toHaveLength(2);
    expect(harness.clients[1]?.cwd).toBe(originalPath);
    expect(harness.clients[1]?.allowedRoots).toEqual([originalPath]);
    expect(existsSync(path.join(originalPath, "partial.txt"))).toBe(true);
    // 提示词明确这是重试，并带上上次的中断原因。
    const prompt = harness.clients[1]?.prompts[0] ?? "";
    expect(prompt).toContain("This is a retry (attempt 2)");
    expect(prompt).toContain("child exploded");
  }, 30000);

  it("被中断（cancelled）的子会话也可以重试", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, ["hang", "complete"], "manual");
    const spawned = harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "running");
    await harness.manager.cancel(spawned.id);
    await until(() => harness.sessions[0]?.status === "cancelled");

    expect(await harness.manager.retry(spawned.id)).toBe(true);
    await until(() => harness.sessions[0]?.status === "completed");
    expect(harness.sessions[0]?.attempts).toBe(2);
  }, 30000);

  it("已完成的子会话不能重试", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "complete", "manual");
    const spawned = harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "completed");

    expect(await harness.manager.retry(spawned.id)).toBe(false);
    expect(harness.clients).toHaveLength(1);
    expect(harness.sessions[0]?.status).toBe("completed");
  }, 30000);

  it("工作目录已被删除时重试会新建隔离环境", async () => {
    const repo = makeRepo();
    // keepWorktree=true：本用例断言的是「新目录真的建出来了」，默认回收会
    // 在断言前把它删掉（竞态）。
    const harness = makeManager(
      repo,
      ["throw", "complete"],
      "manual",
      "main-1",
      DEFAULT_MAX_CONCURRENT_SUPER_SESSIONS,
      { keepWorktree: true },
    );
    const spawned = harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "failed");
    const originalPath = harness.sessions[0]!.isolation.path;
    rmSync(originalPath, { recursive: true, force: true });

    expect(await harness.manager.retry(spawned.id)).toBe(true);
    await until(() => harness.sessions[0]?.status === "completed");
    const second = harness.sessions[0]!;
    expect(second.isolation.path).toBeTruthy();
    expect(second.isolation.path).not.toBe(originalPath);
    expect(existsSync(second.isolation.path)).toBe(true);
  }, 30000);

  it("排队中的子会话被取消后不会再被启动", async () => {
    const repo = makeRepo();
    const limit = 2;
    const harness = makeManager(repo, "hang", "merge", "main-1", limit);
    const ids: string[] = [];
    for (let i = 0; i < limit + 1; i++) {
      ids.push(harness.manager.spawn({ title: `任务 ${i}`, task: "干活" }).id);
    }
    await until(() => harness.clients.length >= limit);
    const queued = harness.sessions.find((s) => s.queued);
    expect(queued).toBeDefined();
    await harness.manager.cancel(queued!.id);

    // 腾出槽位后，被取消的排队项不该再起一个新进程。
    await harness.manager.cancel(ids[0]!);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(harness.clients.length).toBe(limit);
  }, 30000);

  it("上限 1 时第二个派发排队，第一个完成后才启动", async () => {
    const repo = makeRepo();
    // 第一个在 prompt 里挂住（releasePrompt 控制），否则它会瞬间完成，
    // 「第二个还在排队」的断言就会和完成事件赛跑。
    const harness = makeManager(repo, ["commit-a-gated", "complete"], "manual", "main-1", 1);
    const first = harness.manager.spawn({ title: "任务 1", task: "干活" });
    const second = harness.manager.spawn({ title: "任务 2", task: "干活" });
    // spawn 同步入队：第二个立刻处于排队态。
    expect(harness.sessions.find((s) => s.id === second.id)?.queued).toBe(true);

    // 第一个真正跑起来时，仍然只有一个进程 —— 第二个不能被提前启动。
    await until(() => Boolean(harness.clients[0]?.releasePrompt));
    expect(harness.sessions.find((s) => s.id === first.id)?.queued).toBe(false);
    expect(harness.sessions.find((s) => s.id === second.id)?.queued).toBe(true);
    expect(harness.clients.length).toBe(1);

    // 放行第一个 → 它完成腾出槽位，第二个才起跑。
    harness.clients[0]!.releasePrompt!();
    await until(() => harness.clients.length === 2);
    expect(harness.sessions.find((s) => s.id === second.id)?.queued).toBe(false);
    await until(() => harness.sessions.find((s) => s.id === second.id)?.status === "completed");
  }, 30000);
});

describe("super agent · 附件", () => {
  it("文件附件复制到工作区之外的目录，并在提示词里列出", async () => {
    const repo = makeRepo();
    const source = mkdtempSync(path.join(tmpdir(), "iflow-attachment-"));
    roots.push(source);
    const sourceFile = path.join(source, "note.txt");
    writeFileSync(sourceFile, "hello attachment\n", "utf8");

    const harness = makeManager(repo, "hang");
    const session = harness.manager.spawn({
      title: "看附件",
      task: "读一下附件",
      attachments: [{ name: "note.txt", path: sourceFile }],
    });
    await until(() => harness.clients.length > 0);

    const prompt = harness.clients[0]?.prompts[0] ?? "";
    const match = /^- note\.txt → (.+)$/m.exec(prompt);
    expect(match).not.toBeNull();
    const copyPath = match![1]!.trim();

    // 副本刻意放在 worktree 之外：子会话 `git add -A` 不会把附件提交进分支。
    // `spawn()` 返回的是准备期的占位记录，worktree 路径要读活会话。
    const worktree = harness.sessions[0]?.isolation.path ?? "";
    expect(worktree).not.toBe("");
    expect(path.relative(worktree, copyPath).startsWith("..")).toBe(true);
    expect(readFileSync(copyPath, "utf8").replace(/\r\n/g, "\n")).toBe("hello attachment\n");
    // 但边界必须包含附件目录，否则子会话读不到它。
    expect(harness.clients[0]?.allowedRoots).toContain(path.dirname(copyPath));

    await harness.manager.cancel(session.id);
    await harness.manager.cleanup(session.id);
    expect(existsSync(copyPath)).toBe(false);
  }, 30000);

  it("粘贴的图片既落盘也作为图片块送给子会话", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "hang");
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).toString("base64");
    harness.manager.spawn({
      title: "看图",
      task: "看截图",
      attachments: [{ name: "shot", data, mimeType: "image/png" }],
    });
    await until(() => harness.clients.length > 0);

    const blocks = harness.clients[0]?.blocks[0] ?? [];
    const images = blocks.filter((block) => block.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    // 没有扩展名的内联图片按 MIME 补上扩展名，落盘副本才可被图片工具识别。
    expect(harness.clients[0]?.prompts[0] ?? "").toContain("shot.png");

    await harness.manager.cancel(harness.sessions[0]!.id);
  }, 30000);

  it("源文件不存在时如实写入提示词，不影响子会话运行", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "complete");
    harness.manager.spawn({
      title: "缺附件",
      task: "干活",
      attachments: [{ name: "missing.txt", path: path.join(tmpdir(), "definitely-missing-iflow.txt") }],
    });
    await until(() => harness.sessions[0]?.status === "completed");

    const prompt = harness.clients[0]?.prompts[0] ?? "";
    expect(prompt).toContain("These attachments could not be delivered");
    expect(prompt).toContain("missing.txt");
  }, 30000);
});

describe("super agent · 归属与归档", () => {
  it("派发的子会话归属当前主会话", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "complete", "merge", "main-7");
    harness.manager.spawn({ title: "改登录", task: "修好它" });
    await until(() => harness.sessions[0]?.status === "completed");

    expect(harness.sessions[0]?.mainSessionId).toBe("main-7");
    expect(harness.manager.archivableMainSessionIds()).toContain("main-7");
  }, 30000);

  // 汇报是投给**某个**主会话的：提示词里的 pendingCount（「还有 N 个在跑」）
  // 必须只数同一归属下的子会话 —— 混进别人家的孩子，模型会以为自己也该
  // 等那些不存在于它上下文里的孩子。
  it("汇报提示词里的 pendingCount 只算同一归属主会话的子会话", async () => {
    const repo = makeRepo();
    let owner: string | null = "main-A";
    // 三个孩子：A 的一个跑完、A 的一个还在跑、B 的一个还在跑。
    // manual 集成：不跑自动合并（那条路会在临时仓里做 git merge，Windows 上
    // 清理临时目录时可能撞上还在跑的 git 进程）。
    const harness = makeManager(repo, ["complete", "hang", "hang"], "manual", () => owner);

    harness.manager.spawn({ title: "A 的活儿", task: "干活" });
    await until(() => harness.sessions[0]?.status === "completed");
    owner = "main-A";
    harness.manager.spawn({ title: "A 的下一个", task: "干活" });
    await until(() => harness.sessions.filter((s) => s.mainSessionId === "main-A").length >= 2);
    owner = "main-B";
    harness.manager.spawn({ title: "B 的活儿", task: "干活" });
    await until(() => harness.sessions.some((s) => s.mainSessionId === "main-B"));

    const aDone = harness.sessions.find((s) => s.mainSessionId === "main-A" && s.status === "completed");
    expect(aDone).toBeDefined();
    const prompt = harness.manager.reportPrompt([
      { session: aDone!, report: { state: "ready", summary: "干完了", at: Date.now() } },
    ]);
    // A 名下只有「A 的下一个」还在跑 → 1；B 的那个不算。
    expect(prompt).toContain("1 other child session(s) are still running");
    expect(prompt).not.toContain("2 other child session(s) are still running");
    await harness.manager.dispose();
  }, 60000);

  it("归档只含该主会话名下的子会话（别的会话的不混进来）", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "complete", "merge", "main-1");
    harness.manager.spawn({ title: "A 的任务", task: "干活" });
    await until(() => harness.sessions[0]?.status === "completed");

    const archived = harness.manager.archivableSessions("main-1");
    expect(archived).toHaveLength(1);
    expect(archived[0]?.mainSessionId).toBe("main-1");
    // 另一个主会话名下一个都没有 —— 归档不能串会话。
    expect(harness.manager.archivableSessions("main-2")).toEqual([]);
  }, 30000);

  it("恢复历史子会话后它回到看板上", () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "complete", "merge", "main-1");
    harness.manager.restoreSessions("main-1", [
      {
        id: "super-old",
        title: "上次没跑完的活",
        task: "干活",
        status: "cancelled",
        restored: true,
        isolation: { kind: "git_worktree", path: "/tmp/wt-old", branch: "iflow/super/old" },
        mainSessionId: "main-1",
        createdAt: 100,
        updatedAt: 200,
        reports: [],
      },
    ]);

    expect(harness.sessions).toHaveLength(1);
    expect(harness.sessions[0]?.id).toBe("super-old");
    expect(harness.sessions[0]?.restored).toBe(true);
  });

  it("历史子会话只在它自己的主会话下出现", () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "complete", "merge", "main-1");
    harness.manager.restoreSessions("main-1", [
      {
        id: "super-old",
        title: "上次没跑完的活",
        task: "干活",
        status: "cancelled",
        restored: true,
        isolation: { kind: "git_worktree", path: "/tmp/wt-old", branch: "iflow/super/old" },
        mainSessionId: "main-1",
        createdAt: 100,
        updatedAt: 200,
        reports: [],
      },
    ]);

    // 切到别的会话：那个会话看不到别人的历史子会话。
    expect(harness.manager.list("main-2")).toEqual([]);
    expect(harness.manager.list("main-1")).toHaveLength(1);
  });

  it("活着的子会话一直可见（不分主会话）—— 用户得能中断它们", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "hang", "merge", "main-1");
    harness.manager.spawn({ title: "还在跑", task: "干活" });
    await until(() => harness.sessions[0]?.status === "running");

    // 即便当前主会话不是 main-1，跑着的子会话也不能从看板上消失。
    expect(harness.manager.list("main-2")).toHaveLength(1);

    await harness.manager.cancel(harness.sessions[0]!.id);
  }, 30000);

  it("历史子会话不能被重试（没有进程可以重启），但可以查到", () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "complete", "merge", "main-1");
    harness.manager.restoreSessions("main-1", [
      {
        id: "super-old",
        title: "上次没跑完的活",
        task: "干活",
        status: "cancelled",
        restored: true,
        isolation: { kind: "git_worktree", path: "/tmp/wt-old", branch: "iflow/super/old" },
        mainSessionId: "main-1",
        createdAt: 100,
        updatedAt: 200,
        reports: [],
      },
    ]);

    // 查得到（合并/清理要靠它拿分支），但不在活着的会话表里 —— 重试/中断
    // 这些进程级操作天然找不到它，不会去 kill 一个不存在的会话。
    expect(harness.manager.get("super-old")).toBeDefined();
    expect(harness.manager.list("main-1").some((s) => s.id === "super-old")).toBe(true);
  });

  it("归档剥掉运行期字段，但保留分支与工作目录", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "hang", "merge", "main-1");
    harness.manager.spawn({ title: "改登录", task: "修好它" });
    await until(() => harness.sessions[0]?.status === "running");

    const archived = harness.manager.archivableSessions("main-1");
    expect(archived).toHaveLength(1);
    expect(archived[0]?.isolation.branch).toContain("iflow/super/");
    expect(archived[0]).not.toHaveProperty("pending");
    expect(archived[0]).not.toHaveProperty("progress");

    await harness.manager.cancel(harness.sessions[0]!.id);
  }, 30000);

  it("写 A 的归档不会抹掉 B 的历史记录", () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "complete", "merge", "main-1");
    harness.manager.restoreSessions("main-1", [
      {
        id: "super-a",
        title: "A 的活",
        task: "干活",
        status: "cancelled",
        restored: true,
        isolation: { kind: "git_worktree", path: "/tmp/wt-a", branch: "iflow/super/a" },
        mainSessionId: "main-1",
        createdAt: 100,
        updatedAt: 200,
        reports: [],
      },
    ]);
    harness.manager.restoreSessions("main-2", [
      {
        id: "super-b",
        title: "B 的活",
        task: "干活",
        status: "cancelled",
        restored: true,
        isolation: { kind: "git_worktree", path: "/tmp/wt-b", branch: "iflow/super/b" },
        mainSessionId: "main-2",
        createdAt: 300,
        updatedAt: 400,
        reports: [],
      },
    ]);

    // 两个会话各写各的归档 —— 互不干扰。
    expect(harness.manager.archivableSessions("main-1").map((r) => r.id)).toEqual(["super-a"]);
    expect(harness.manager.archivableSessions("main-2").map((r) => r.id)).toEqual(["super-b"]);
    expect(harness.manager.archivableMainSessionIds().sort()).toEqual(["main-1", "main-2"]);
  });

  it("子会话被清理后，那个会话的归档写成空数组（不会又冒出旧记录）", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "complete", "merge", "main-1");
    harness.manager.spawn({ title: "改登录", task: "修好它" });
    await until(() => harness.sessions[0]?.status === "completed");

    expect(harness.manager.archivableSessions("main-1")).toHaveLength(1);

    // 清理掉它（工作目录删掉，分支按策略处理）。
    await harness.manager.cleanup(harness.sessions[0]!.id);

    // 归档要变空 —— 否则下次恢复又冒出已经清理掉的子会话。
    expect(harness.manager.archivableSessions("main-1")).toEqual([]);
    // 会话本身仍在归档集合里（要写一次空数组把磁盘上的旧记录清掉）。
    expect(harness.manager.archivableMainSessionIds()).toContain("main-1");
  }, 30000);
});

describe("super agent · 收尾守卫（用户中断后不许落改动）", () => {
  it("准备阶段被中断的子会话：不代提交、不自动合并，分支与工作目录保留", async () => {
    const repo = makeRepo();
    // gate-session：内核会话还没建好就挂起 —— 测试在这个窗口里中断它。
    const harness = makeManager(repo, "gate-session", "merge");
    const spawned = harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.clients.length === 1);
    // 还在准备阶段：子会话没拿到内核会话，也还没开始跑。
    expect(harness.sessions[0]?.status).toBe("preparing");

    await harness.manager.cancel(spawned.id);
    expect(harness.sessions[0]?.status).toBe("cancelled");

    // 放行内核会话：子会话会真的跑完并在自己的 worktree 里留下改动。
    harness.clients[0]!.releaseSession!();
    await until(() => harness.sessions[0]?.integration !== undefined);
    await until(() => harness.reports.length > 0);

    const session = harness.sessions[0]!;
    const branch = session.isolation.branch!;
    const worktree = session.isolation.path;

    // 改动确实被子会话写出来了（在它自己的 worktree 里）。
    expect(existsSync(path.join(worktree, "partial.txt"))).toBe(true);
    // 但**绝不能**进主分支 —— 用户喊停之后不许自动合并。
    expect(existsSync(path.join(repo, "partial.txt"))).toBe(false);
    // 也**绝不能**被宿主代提交 —— 分支上只有初始那一个提交。
    expect(gitOut(worktree, "rev-list", "--count", "HEAD").trim()).toBe("1");
    expect(gitOut(repo, "log", "--oneline", "master").includes("super-agent")).toBe(false);

    // 集成结果如实记成「已中断、改动保留在分支（未合并）」。
    expect(session.integration?.state).toBe("skipped");
    expect(session.integration?.detail).toContain("中断");
    expect(session.integration?.detail).toContain("未合并");
    expect(session.integration?.detail).toContain(branch);
    // 用户主动喊停 → 不该再自动请智能体去合并它。
    expect(session.integration?.needsAction).toBeFalsy();
    expect(harness.needMerges).toHaveLength(0);

    // 分支与工作目录都保留着（用户可能还想看看它改了什么）。
    expect(gitOut(repo, "branch", "--list", branch)).toContain(branch);
    expect(existsSync(worktree)).toBe(true);
    expect(session.isolation.released).toBeFalsy();
  }, 30000);

  it("中断后子会话仍跑完，也不会把它的改动带进主分支", async () => {
    const repo = makeRepo();
    // hang-text：子会话先吐一段文字再挂着；取消后内核仍会 resolve。
    const harness = makeManager(repo, "hang-text", "merge");
    const spawned = harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "running");
    await harness.manager.cancel(spawned.id);
    expect(harness.sessions[0]?.status).toBe("cancelled");

    await until(() => harness.sessions[0]?.integration !== undefined);
    const session = harness.sessions[0]!;
    // 中断 → 没有合并，也没有代提交。
    expect(session.integration?.state).not.toBe("merged");
    expect(existsSync(path.join(repo, "partial.txt"))).toBe(false);
  }, 30000);
});

describe("super agent · 并发额度按活着的 CLI 进程算", () => {
  it("回合已结束但进程还活着的子会话继续占着槽位（不超发）", async () => {
    const repo = makeRepo();
    // 上限 1。第一个子会话回合结束，但进程回收被挂住 —— 进程还活着。
    const harness = makeManager(repo, "commit-gated-dispose", "manual", "main-1", 1);
    harness.manager.spawn({ title: "第一个", task: "干活" });
    await until(() => harness.sessions[0]?.status === "completed");
    // 回合结束 ≠ 进程结束：回收还挂着，进程仍然活着。
    await until(() => Boolean(harness.clients[0]?.releaseDispose));

    // 额度已经被第一个子会话占着 → 第二个只能排队，绝不能再起一个进程。
    const second = harness.manager.spawn({ title: "第二个", task: "干活" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(harness.clients.length).toBe(1);
    expect(harness.sessions.find((s) => s.id === second.id)?.queued).toBe(true);

    // 第一个进程真的被回收之后，槽位才空出来。
    harness.clients[0]!.releaseDispose!();
    await until(() => harness.clients.length === 2);
    expect(harness.sessions.find((s) => s.id === second.id)?.queued).toBe(false);
  }, 30000);
});

describe("super agent · 子会话输出文本有上限", () => {
  it("超出上限时只保留尾部，并标注前文被截断", () => {
    const text = `HEAD${"x".repeat(100)}TAIL`;
    const capped = capTail(text, 20);
    expect(capped.endsWith("TAIL")).toBe(true);
    // 头部被丢掉（只剩尾部）—— 这正是「留尾丢头」的目的。
    expect(capped).not.toContain("HEAD");
    // 截断必须被标注出来 —— 看板不能装作全文都在。
    expect(capped.startsWith("…")).toBe(true);
    expect(capped.length).toBeLessThanOrEqual(21);
  });

  it("没超上限时原样返回（不加标记）", () => {
    expect(capTail("短文本", 100)).toBe("短文本");
  });

  it("上限常量是一个真实的界（不是无限制）", () => {
    expect(SUPER_TEXT_MAX_CHARS).toBeGreaterThan(0);
    expect(SUPER_TEXT_MAX_CHARS).toBeLessThan(1_000_000);
  });
});

describe("super agent · 子会话 todolist 投影", () => {
  /** 起一个正在跑的子会话（hang），并等 prompt 真正发出后再注入 plan 更新。 */
  async function running(): Promise<{ harness: Harness; id: string }> {
    const repo = makeRepo();
    const harness = makeManager(repo, "hang");
    const spawned = harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "running");
    await until(() => (harness.clients[0]?.prompts.length ?? 0) === 1);
    return { harness, id: spawned.id };
  }

  function sendPlan(
    client: FakeClient,
    entries: unknown,
    extra: Record<string, unknown> = {},
  ): void {
    client.callbacks.onSessionUpdate?.({
      sessionId: "sub",
      update: { sessionUpdate: "plan", entries },
      ...extra,
    } as never);
  }

  it("plan（todo_write 的镜像）全量写入 todos，并经既有 emit 刷新看板", async () => {
    const { harness } = await running();

    sendPlan(harness.clients[0]!, [
      { content: "读代码", status: "completed" },
      { content: "改实现", status: "in_progress", priority: "high" },
    ]);

    // emit 是同步的：看板投影（onSessionsChanged）立刻拿到 todo；归档落盘也
    // 搭这同一条通道，没有第二条广播 / 落盘路径。
    expect(harness.sessions[0]?.todos).toEqual([
      { content: "读代码", status: "completed" },
      { content: "改实现", status: "in_progress", priority: "high" },
    ]);

    // 每次 plan 都是完整快照：第二次直接替换，不追加、不合并。
    sendPlan(harness.clients[0]!, [{ content: "跑测试", status: "pending" }]);
    expect(harness.sessions[0]?.todos).toEqual([{ content: "跑测试", status: "pending" }]);
    // 只更新看板，不重复向子会话发 prompt。
    expect(harness.clients[0]?.prompts.length).toBe(1);
  }, 30000);

  it("清洗脏条目：丢弃空文本、截断超长、非法状态/优先级归一、条目数封顶", async () => {
    const { harness } = await running();
    sendPlan(harness.clients[0]!, [
      { content: "  读代码  ", status: "pending" },
      { content: "", status: "completed" },
      { content: "   ", status: "completed" },
      { content: 42, status: "completed" },
      { content: "x".repeat(260), status: "weird", priority: "urgent" },
      ...Array.from({ length: 30 }, (_, i) => ({ content: `任务 ${i}`, status: "pending" })),
    ]);

    const todos = harness.sessions[0]?.todos ?? [];
    // 条目上限 20：脏数据不能把快照撑爆。
    expect(todos).toHaveLength(20);
    // trim 后非空才收，非字符串 content 转字符串（与 wire 的容错一致）。
    expect(todos[0]).toEqual({ content: "读代码", status: "pending" });
    expect(todos[1]?.content).toBe("42");
    // 单条 200 字符封顶（含省略号），别让快照膨胀。
    expect(todos[2]?.content).toHaveLength(200);
    expect(todos[2]?.content.endsWith("…")).toBe(true);
    // 非法 status → pending，非法 priority → 丢弃。
    expect(todos[2]?.status).toBe("pending");
    expect(todos[2]).not.toHaveProperty("priority");
  }, 30000);

  it("忽略带 agentId 的 plan：嵌套子代理的 todo 不能混进本子会话", async () => {
    const { harness } = await running();
    const client = harness.clients[0]!;
    const entries = [{ content: "别人的步骤", status: "in_progress" }];

    // notification / update / update._meta 三个位置都可能带 agentId（wire 实证）。
    sendPlan(client, entries, { agentId: "agent-1" });
    client.callbacks.onSessionUpdate?.({
      sessionId: "sub",
      update: { sessionUpdate: "plan", entries, agentId: "agent-2" },
    } as never);
    client.callbacks.onSessionUpdate?.({
      sessionId: "sub",
      update: { sessionUpdate: "plan", entries, _meta: { agentId: "agent-3" } },
    } as never);
    expect(harness.sessions[0]?.todos).toBeUndefined();

    // 主代理自己的 plan（不带 agentId）照常写入。
    sendPlan(client, entries);
    expect(harness.sessions[0]?.todos).toEqual([{ content: "别人的步骤", status: "in_progress" }]);
  }, 30000);
});
