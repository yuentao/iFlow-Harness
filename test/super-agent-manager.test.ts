import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SuperAgentManager, buildTaskPrompt } from "../src/panel/super-agent.js";
import type { AcpClient, AcpClientCallbacks } from "../src/acp/client.js";
import type { ContentBlock, UserQuestion } from "../src/acp/protocol.js";
import {
  MAX_CONCURRENT_SUPER_SESSIONS,
  type SuperIntegrationMode,
  type SuperReport,
  type SuperSessionUi,
} from "../shared/super-agent.js";
import type { Block } from "../shared/messages.js";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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

function makeStorage(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "iflow-super-storage-"));
  roots.push(dir);
  return dir;
}

/** A stand-in for AcpClient — the manager only uses a small surface. */
class FakeClient {
  prompts: string[] = [];
  /** Mode ids pushed to the child session — the manager must send "yolo". */
  modes: string[] = [];
  disposed = false;
  cwd = "";
  allowedRoots: string[] = [];
  private settle: ((value: { stopReason: string }) => void) | null = null;

  constructor(
    readonly callbacks: AcpClientCallbacks,
    private readonly plan: "complete" | "commit" | "hang" | "hang-text" | "throw" | "usage",
  ) {}

  async newSession(): Promise<{ sessionId: string }> {
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
    if (this.plan === "commit") {
      // A real child edits files INSIDE its worktree and commits them.
      writeFileSync(path.join(this.cwd, "child.txt"), "from child\n", "utf8");
      git(this.cwd, "add", "-A");
      git(this.cwd, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "child work");
      return { stopReason: "end_turn" };
    }
    if (this.plan === "complete") return { stopReason: "end_turn" };
    if (this.plan === "throw") throw new Error("child exploded");
    return new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  cancel(): void {
    this.settle?.({ stopReason: "cancelled" });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

interface Harness {
  manager: SuperAgentManager;
  clients: FakeClient[];
  sessions: SuperSessionUi[];
  reports: { session: SuperSessionUi; report: SuperReport }[];
  /** Pushes seen on the child-transcript channel (incremental, `from`). */
  transcripts: { sessionId: string; from: number; blocks: Block[] }[];
}

function makeManager(
  repoRoot: string,
  plan: "complete" | "commit" | "hang" | "hang-text" | "throw" | "usage" = "complete",
  mode: SuperIntegrationMode = "merge",
): Harness {
  const clients: FakeClient[] = [];
  const sessions: SuperSessionUi[] = [];
  const reports: { session: SuperSessionUi; report: SuperReport }[] = [];
  const transcripts: { sessionId: string; from: number; blocks: Block[] }[] = [];
  const manager = new SuperAgentManager({
    repoRoot,
    storageRoot: makeStorage(),
    createClient: async (params) => {
      const client = new FakeClient(params.callbacks, plan);
      client.cwd = params.cwd;
      client.allowedRoots = params.allowedRoots;
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
    onTranscript: (sessionId, from, blocks) => {
      transcripts.push({ sessionId, from, blocks });
    },
    currentModel: () => "test-model",
    priceFor: () => ({ input: 1, output: 2 }),
    integrationMode: () => mode,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { manager, clients, sessions, reports, transcripts };
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

    const client = harness.clients[0];
    expect(client).toBeDefined();
    // 关键：子会话看不到主工作区。
    expect(client?.cwd).toBe(session?.isolation.path);
    expect(client?.allowedRoots).toEqual([session?.isolation.path]);
    expect(client?.cwd).not.toBe(repo);
  }, 30000);

  it("子会话被推到免确认模式（yolo）", async () => {
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

    // 选 allow_always 而不是 allow_once：同一个子会话后续不该再问。
    expect(response.outcome).toEqual({ outcome: "selected", optionId: "always" });
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

  it("任务说明连同工作目录一起交给子会话", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo);
    harness.manager.spawn({ title: "改登录", task: "修好 src/auth.ts" });
    await until(() => harness.sessions[0]?.status === "completed");
    const prompt = harness.clients[0]?.prompts[0] ?? "";
    expect(prompt).toContain("修好 src/auth.ts");
    expect(prompt).toContain(harness.sessions[0]?.isolation.path ?? "X");
    expect(prompt).toContain("免确认");
  }, 30000);

  it("子会话的实时操作（任务/思考/工具/正文）进入自己的转录并增量推送", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "hang");
    const session = harness.manager.spawn({ title: "改登录", task: "修好 src/auth.ts" });
    await until(() => harness.sessions[0]?.status === "running");
    // The task prompt is appended right before `client.prompt`; wait for it so
    // the injections below land after the user turn (otherwise the ordering
    // assertion races the setMode/setModel awaits in prepare).
    await until(() => harness.manager.transcriptBlocks(session.id).length === 1);

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

    await until(() => harness.manager.transcriptBlocks(session.id).length >= 4);
    const blocks = harness.manager.transcriptBlocks(session.id);
    // 派发的任务提示词是用户轮，之后是 agent 的实时操作。
    expect(blocks.map((b) => b.kind)).toEqual(["user", "thought", "tool", "text"]);
    expect(blocks[0]).toMatchObject({ kind: "user" });
    if (blocks[0]?.kind === "user") expect(blocks[0].text).toContain("修好 src/auth.ts");
    if (blocks[2]?.kind === "tool") expect(blocks[2].toolName).toBe("read_file");
    if (blocks[3]?.kind === "text") expect(blocks[3].text).toBe("改好了");

    // 节流推送（~120ms）真正到达后再断言。
    await until(() => harness.transcripts.length > 0);
    // 首次推送从 0 开始且含用户块，详情打开即可完整渲染。
    expect(harness.transcripts[0]?.from).toBe(0);
    expect(harness.transcripts[0]?.blocks[0]?.kind).toBe("user");
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

  it("中断子会话 → cancelled 并终止进程", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "hang");
    const session = harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "running");
    await harness.manager.cancel(session.id);
    expect(harness.sessions[0]?.status).toBe("cancelled");
    expect(harness.clients[0]?.disposed).toBe(true);
  }, 30000);

  it("并发超出的派发进排队，槽位空出后自动开跑", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "hang");
    const ids: string[] = [];
    for (let i = 0; i < MAX_CONCURRENT_SUPER_SESSIONS + 2; i++) {
      ids.push(harness.manager.spawn({ title: `任务 ${i}`, task: "干活" }).id);
    }
    await until(() => harness.clients.length >= MAX_CONCURRENT_SUPER_SESSIONS);
    const queued = harness.sessions.filter((s) => s.queued);
    expect(queued.length).toBe(2);
    expect(harness.clients.length).toBe(MAX_CONCURRENT_SUPER_SESSIONS);

    // 腾出一个槽位 → 排队的那个自动开跑。
    await harness.manager.cancel(ids[0]!);
    await until(() => harness.clients.length === MAX_CONCURRENT_SUPER_SESSIONS + 1);
    expect(harness.clients.length).toBe(MAX_CONCURRENT_SUPER_SESSIONS + 1);
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
    expect(kept[0]?.path).toContain("super-worktrees");
    // worktree 还在 —— 用户可能还没合并里面的工作。
    expect(existsSync(kept[0]?.path ?? "")).toBe(true);
  }, 30000);

  it("清理子会话时保留有未合并提交的分支", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo);
    const session = harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "completed");
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

  it("主工作区有未提交改动时跳过自动合并，并上报 blocked", async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, "dirty.txt"), "uncommitted\n", "utf8");
    const harness = makeManager(repo, "commit", "merge");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.integration?.state === "skipped");
    await until(() => harness.reports.length > 0);

    const session = harness.sessions[0]!;
    expect(session.integration?.needsAction).toBe(true);
    expect(session.integration?.detail).toContain("未提交改动");
    // 分支保留、工作区没被改动。
    expect(existsSync(path.join(repo, "child.txt"))).toBe(false);
    expect(harness.reports.at(-1)?.report.state).toBe("blocked");
    expect(harness.reports.at(-1)?.report.humanAction).toContain("未提交改动");
  }, 30000);

  it("manual 模式不做任何自动集成", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "commit", "manual");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "completed");
    expect(harness.sessions[0]?.integration).toBeUndefined();
    expect(existsSync(path.join(repo, "child.txt"))).toBe(false);
  }, 30000);

  it("子会话没有产生提交时如实标注跳过（不需要用户动手）", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "complete", "merge");
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.integration?.state === "skipped");
    await until(() => harness.reports.length > 0);

    const session = harness.sessions[0]!;
    expect(session.integration?.detail).toContain("没有产生任何提交");
    expect(session.integration?.needsAction).toBeFalsy();
    expect(harness.reports.at(-1)?.report.state).toBe("ready");
  }, 30000);

  it("手动合并也记录集成结果", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "commit", "manual");
    const session = harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "completed");

    const first = await harness.manager.merge(session.id);
    expect(first.ok).toBe(true);
    await until(() => harness.sessions[0]?.integration?.state === "merged");
    expect(existsSync(path.join(repo, "child.txt"))).toBe(true);
  }, 30000);
});

describe("super agent · 任务提示词", () => {
  it("含标题、任务、工作目录与分支", () => {
    const text = buildTaskPrompt(
      "改登录",
      "修好 src/auth.ts",
      { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/x", baseRef: "abc" },
    );
    expect(text).toContain("改登录");
    expect(text).toContain("修好 src/auth.ts");
    expect(text).toContain("/tmp/wt");
    expect(text).toContain("iflow/super/x");
  });

  it("目录隔离时不提分支", () => {
    const text = buildTaskPrompt("改登录", "干活", { kind: "directory", path: "/tmp/dir" });
    expect(text).toContain("/tmp/dir");
    expect(text).not.toContain("iflow/super/");
  });

  it("明确告知免确认模式与「不要自己合并」", () => {
    const text = buildTaskPrompt("改登录", "干活", { kind: "directory", path: "/tmp/dir" });
    expect(text).toContain("免确认");
    expect(text).toContain("不需要自己合并");
  });
});
