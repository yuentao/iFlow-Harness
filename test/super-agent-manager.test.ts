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

type Plan = "complete" | "commit" | "hang" | "throw";

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
    private readonly plan: Plan,
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

  async prompt(request: { sessionId: string; prompt: ContentBlock[] }): Promise<{ stopReason: string }> {
    this.prompts.push(request.prompt.map((p) => (p.type === "text" ? p.text : "")).join("\n"));
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
}

function makeManager(
  repoRoot: string,
  plan: Plan | Plan[] = "complete",
  mode: SuperIntegrationMode = "merge",
): Harness {
  const clients: FakeClient[] = [];
  const sessions: SuperSessionUi[] = [];
  const reports: { session: SuperSessionUi; report: SuperReport }[] = [];
  const manager = new SuperAgentManager({
    repoRoot,
    storageRoot: makeStorage(),
    createClient: async (params) => {
      const planForClient = Array.isArray(plan) ? (plan[clients.length] ?? "complete") : plan;
      const client = new FakeClient(params.callbacks, planForClient);
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
    currentModel: () => "test-model",
    integrationMode: () => mode,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { manager, clients, sessions, reports };
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

  it("重试提示词说明上一轮中断、要求先检查现状", () => {
    const text = buildTaskPrompt(
      "改登录",
      "干活",
      { kind: "directory", path: "/tmp/dir" },
      { attempt: 2, error: "子会话内核退出（code=1）", summary: "已改了一半" },
    );
    expect(text).toContain("第 2 次执行");
    expect(text).toContain("子会话内核退出");
    expect(text).toContain("先检查现状");
    expect(text).toContain("已改了一半");
  });

  it("首次执行的提示词里没有重试说明", () => {
    const text = buildTaskPrompt("改登录", "干活", { kind: "directory", path: "/tmp/dir" });
    expect(text).not.toContain("这是一次重试");
  });
});

describe("super agent · 意外中断后重试", () => {
  it("失败后可以重试，沿用原工作目录与分支，并保留上次的未提交改动", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, ["throw", "complete"], "manual");
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
    expect(prompt).toContain("这是一次重试");
    expect(prompt).toContain("第 2 次");
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
    const harness = makeManager(repo, ["throw", "complete"], "manual");
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
    const harness = makeManager(repo, "hang");
    const ids: string[] = [];
    for (let i = 0; i < MAX_CONCURRENT_SUPER_SESSIONS + 1; i++) {
      ids.push(harness.manager.spawn({ title: `任务 ${i}`, task: "干活" }).id);
    }
    await until(() => harness.clients.length >= MAX_CONCURRENT_SUPER_SESSIONS);
    const queued = harness.sessions.find((s) => s.queued);
    expect(queued).toBeDefined();
    await harness.manager.cancel(queued!.id);

    // 腾出槽位后，被取消的排队项不该再起一个新进程。
    await harness.manager.cancel(ids[0]!);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(harness.clients.length).toBe(MAX_CONCURRENT_SUPER_SESSIONS);
  }, 30000);
});
