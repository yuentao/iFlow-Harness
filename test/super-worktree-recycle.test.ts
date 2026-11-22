/**
 * Super Agent 子会话 worktree 的「终态默认回收 + 保留上限」。
 *
 * 背景：worktree 建在 `<repo>/.iflow/super/worktrees/`，子会话正常结束时宿主
 * 已经用 `commitWorktree` 把未提交改动代提交到分支。旧实现只有「自动合并成功」
 * 或「没有产生任何提交」才释放隔离 —— 合并被跳过 / PR 模式 / manual 模式都会
 * 把 worktree 永久留在磁盘上。
 *
 * 本文件覆盖五件事：
 *  1. `keepWorktree=false`（默认）：completed 后目录被删、**分支仍在**、
 *     记录 released + recycled；
 *  2. `keepWorktree=true`：目录保留，released 不为真；
 *  3. 工作目录有未提交改动：不删目录（recycle 直接打私有入口验证闸门）；
 *  4. 保留上限：3 个干净的未合并 worktree + maxKeep=1 → 只留最新 1 个，
 *     分支全部保留；
 *  5. failed / cancelled 不触发回收（重试要复用现场）。
 */
import { describe, it, expect, afterAll, vi } from "vitest";

// 本文件跑真实 git（建仓 / worktree / 回收），在 CI runner 与全量并发下
// 单个用例可能跑十几秒。按文件放宽超时，不动全局 testTimeout。
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SuperAgentManager } from "../src/panel/super-agent.js";
import type { AcpClient, AcpClientCallbacks } from "../src/acp/client.js";
import type { ContentBlock } from "../src/acp/protocol.js";
import type { SuperIntegrationMode, SuperSessionUi } from "../shared/super-agent.js";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    windowsHide: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "iflow-super-recycle-"));
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

interface MadeWorktree {
  path: string;
  branch: string;
}

/** 在 `<repo>/.iflow/super/worktrees/` 下建一个真实的 git worktree。 */
function makeWorktree(
  repo: string,
  name: string,
  options: { commit?: string } = {},
): MadeWorktree {
  const root = path.join(repo, ".iflow", "super", "worktrees");
  mkdirSync(root, { recursive: true });
  const target = path.join(root, name);
  const branch = `iflow/super/${name}`;
  git(repo, "worktree", "add", "-b", branch, target, "HEAD");
  if (options.commit) {
    writeFileSync(path.join(target, "child.txt"), options.commit, "utf8");
    git(target, "add", "-A");
    git(target, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "child work");
  }
  return { path: target, branch };
}

/** 分支是否还在（git branch --list 的输出里能找到它）。 */
function branchExists(repo: string, branch: string): boolean {
  return git(repo, "branch", "--list", branch).includes(branch);
}

type Plan = "complete" | "commit" | "hang" | "throw";

/** AcpClient 的替身：管理器只用到很小的一个面。 */
class FakeClient {
  disposed = false;
  cwd = "";

  constructor(
    readonly callbacks: AcpClientCallbacks,
    private readonly plan: Plan,
  ) {}

  async newSession(): Promise<{ sessionId: string }> {
    return { sessionId: "sub-1" };
  }

  async setMode(): Promise<unknown> {
    return {};
  }

  async setModel(): Promise<unknown> {
    return {};
  }

  async prompt(_request: { sessionId: string; prompt: ContentBlock[] }): Promise<{ stopReason: string }> {
    if (this.plan === "hang") return new Promise(() => {});
    if (this.plan === "throw") throw new Error("child exploded");
    if (this.plan === "commit") {
      writeFileSync(path.join(this.cwd, "child.txt"), "from child\n", "utf8");
      git(this.cwd, "add", "-A");
      git(this.cwd, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "child work");
    }
    return { stopReason: "end_turn" };
  }

  cancel(): void {}

  async dispose(): Promise<void> {
    this.disposed = true;
    this.callbacks.onExit?.(0, null);
  }
}

interface Harness {
  manager: SuperAgentManager;
  clients: FakeClient[];
  sessions: SuperSessionUi[];
}

function makeManager(
  repo: string,
  plan: Plan,
  options: {
    mode?: SuperIntegrationMode;
    keepWorktree?: boolean;
    maxWorktrees?: number;
  } = {},
): Harness {
  const clients: FakeClient[] = [];
  const sessions: SuperSessionUi[] = [];
  const manager = new SuperAgentManager({
    repoRoot: repo,
    createClient: async (params) => {
      const client = new FakeClient(params.callbacks, plan);
      client.cwd = params.cwd;
      clients.push(client);
      return client as unknown as AcpClient;
    },
    onSessionsChanged: (next) => {
      sessions.length = 0;
      sessions.push(...next);
    },
    onReport: () => {},
    currentModel: () => "test-model",
    currentMainSessionId: () => "main-1",
    integrationMode: () => options.mode ?? "manual",
    maxConcurrentSessions: () => 5,
    keepWorktree: () => options.keepWorktree ?? false,
    maxWorktrees: () => options.maxWorktrees ?? 10,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { manager, clients, sessions };
}

async function until(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition not met in time");
}

/** 等 finally 走完的确定信号：CLI 进程已被回收（回收动作发生在那之后）。 */
async function settled(harness: Harness): Promise<void> {
  await until(() => harness.clients[0]?.disposed === true);
  await new Promise((resolve) => setTimeout(resolve, 200));
}

/** 一条「上次运行遗留」的历史子会话记录（进程早没了，磁盘事实还在）。 */
function archivedRecord(id: string, worktree: MadeWorktree, repo: string): SuperSessionUi {
  return {
    id,
    title: "上次没跑完的活",
    task: "干活",
    status: "cancelled",
    isolation: {
      kind: "git_worktree",
      path: worktree.path,
      branch: worktree.branch,
      baseRef: git(repo, "rev-parse", "HEAD").trim(),
    },
    createdAt: 1,
    updatedAt: 2,
    reports: [],
    mainSessionId: "main-1",
    restored: true,
  };
}

/** 管理器内部的释放入口（私有方法）：直接打它验证闸门判定。 */
type Internals = {
  releaseIsolation(
    id: string,
    mode: "merged" | "empty" | "recycle",
  ): Promise<{ ok: boolean; retryable?: boolean; reason?: string }>;
};

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("super agent · 终态默认回收（keepWorktree=false）", () => {
  it("completed 后删掉工作目录，但分支仍在；记录 released + recycled", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "commit", { mode: "manual" });
    harness.manager.spawn({ title: "改登录", task: "干活" });

    await until(() => harness.sessions[0]?.status === "completed");
    await until(() => harness.sessions[0]?.isolation.recycled === true);

    const session = harness.sessions[0]!;
    const worktree = session.isolation.path;
    const branch = session.isolation.branch!;

    // 目录没了……
    expect(existsSync(worktree)).toBe(false);
    // ……分支还在（上面有未合并的提交，删掉就是丢提交）。
    expect(branchExists(repo, branch)).toBe(true);
    // 记录如实：目录已回收、分支保留。
    expect(session.isolation.released).toBe(true);
    expect(session.isolation.recycled).toBe(true);
    // manual 模式没有集成结果，回收不能伪造一个。
    expect(session.integration).toBeUndefined();

    await harness.manager.dispose();
  }, 30000);

  it("keepWorktree=true 时保留工作目录，released 不为真", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "commit", { mode: "manual", keepWorktree: true });
    harness.manager.spawn({ title: "改登录", task: "干活" });

    await until(() => harness.sessions[0]?.status === "completed");
    await settled(harness);

    const session = harness.sessions[0]!;
    expect(existsSync(session.isolation.path)).toBe(true);
    expect(session.isolation.released).toBeFalsy();
    expect(session.isolation.recycled).toBeFalsy();
    expect(branchExists(repo, session.isolation.branch!)).toBe(true);

    await harness.manager.dispose();
  }, 30000);
});

describe("super agent · 回收的保守闸门", () => {
  it("工作目录还有未提交改动时不删目录，也不谎称已回收", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "complete");
    // 分支领先 HEAD（未合并），工作目录里还有没提交的改动。
    const worktree = makeWorktree(repo, "dirty", { commit: "child work\n" });
    writeFileSync(path.join(worktree.path, "leftover.txt"), "keep me\n", "utf8");
    harness.manager.restoreSessions("main-1", [archivedRecord("super-dirty", worktree, repo)]);

    const outcome = await (harness.manager as unknown as Internals).releaseIsolation(
      "super-dirty",
      "recycle",
    );
    expect(outcome.ok).toBe(false);
    // 有意保留，不是可重试的失败。
    expect(outcome.retryable).toBe(false);

    const record = harness.manager.get("super-dirty");
    expect(record?.isolation.released).toBeFalsy();
    expect(record?.isolation.recycled).toBeFalsy();
    expect(existsSync(worktree.path)).toBe(true);
    expect(existsSync(path.join(worktree.path, "leftover.txt"))).toBe(true);
    expect(branchExists(repo, worktree.branch)).toBe(true);

    await harness.manager.dispose();
  }, 30000);

  it("failed 的超流体不回收（重试要复用现场）", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "throw", { mode: "manual" });
    harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "failed");
    await settled(harness);

    const session = harness.sessions[0]!;
    expect(existsSync(session.isolation.path)).toBe(true);
    expect(session.isolation.released).toBeFalsy();
    expect(branchExists(repo, session.isolation.branch!)).toBe(true);

    await harness.manager.dispose();
  }, 30000);

  it("cancelled 的超流体不回收", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "hang", { mode: "manual" });
    const spawned = harness.manager.spawn({ title: "改登录", task: "干活" });
    await until(() => harness.sessions[0]?.status === "running");

    await harness.manager.cancel(spawned.id);
    await until(() => harness.sessions[0]?.status === "cancelled");
    await settled(harness);

    const session = harness.sessions[0]!;
    expect(existsSync(session.isolation.path)).toBe(true);
    expect(session.isolation.released).toBeFalsy();

    await harness.manager.dispose();
  }, 30000);
});

describe("super agent · 保留上限（maxKeep）", () => {
  it("3 个干净的未合并 worktree + maxKeep=1 → 只保留最新的目录，分支全部保留", async () => {
    const repo = makeRepo();
    const harness = makeManager(repo, "complete");
    // 未合并（分支领先 HEAD）+ 干净：主循环（并入才删）不会动它们，
    // 正好交给保留上限阶段。
    const oldest = makeWorktree(repo, "keep-oldest", { commit: "a\n" });
    const middle = makeWorktree(repo, "keep-middle", { commit: "b\n" });
    const newest = makeWorktree(repo, "keep-newest", { commit: "c\n" });
    // 目录 mtime 决定「谁先被回收」：显式设置，避免依赖创建顺序的时钟精度。
    const base = Date.now() - 60_000;
    utimesSync(oldest.path, new Date(base), new Date(base));
    utimesSync(middle.path, new Date(base + 10_000), new Date(base + 10_000));
    utimesSync(newest.path, new Date(base + 20_000), new Date(base + 20_000));
    harness.manager.restoreSessions("main-1", [
      archivedRecord("super-oldest", oldest, repo),
      archivedRecord("super-middle", middle, repo),
      archivedRecord("super-newest", newest, repo),
    ]);

    const result = await harness.manager.sweepStaleWorktrees({ maxKeep: 1 });
    expect(result.removed).toBe(2);

    // 最旧的两个目录被回收……
    expect(existsSync(oldest.path)).toBe(false);
    expect(existsSync(middle.path)).toBe(false);
    // ……最新的那个留着。
    expect(existsSync(newest.path)).toBe(true);
    // 分支一律保留（回收只删目录）。
    expect(branchExists(repo, oldest.branch)).toBe(true);
    expect(branchExists(repo, middle.branch)).toBe(true);
    expect(branchExists(repo, newest.branch)).toBe(true);
    // 记录如实：回收的标 released + recycled，保留的不标。
    expect(harness.manager.get("super-oldest")?.isolation.recycled).toBe(true);
    expect(harness.manager.get("super-middle")?.isolation.recycled).toBe(true);
    expect(harness.manager.get("super-newest")?.isolation.released).toBeFalsy();
    expect(harness.manager.get("super-newest")?.isolation.recycled).toBeFalsy();

    // 幂等：再扫一次不会再删。
    const again = await harness.manager.sweepStaleWorktrees({ maxKeep: 1 });
    expect(again.removed).toBe(0);

    await harness.manager.dispose();
  }, 30000);
});
