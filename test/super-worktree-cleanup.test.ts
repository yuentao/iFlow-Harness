/**
 * Super Agent 的隔离释放与残留清扫。
 *
 * 背景（现场实证）：一批子会话跑完后，`.iflow/super/worktrees/` 下留下了
 * 一堆 worktree 目录与 `iflow/super/*` 分支 —— 它们的分支已经完全没有独有
 * 提交（`merge-base --is-ancestor` 为真、ahead=0），删掉不会丢东西，却一直
 * 占着磁盘，看板也不标「已释放」。
 *
 * 根因：集成阶段在「分支上没有任何提交」时只记了一句 skipped 就返回，释放
 * 隔离的动作只挂在「已合并」那一条路上 —— 于是这批 worktree 被永久留下。
 *
 * 本文件覆盖四件事：
 *  1. 没有产生任何提交时，隔离照样释放（目录 + 分支都删掉，released=true）；
 *  2. 释放失败时**不误标** released，并安排有限次后台重试；
 *  3. 工作目录还有未提交改动时保留目录与分支，绝不谎称已清理；
 *  4. 残留清扫的判定条件（并入则删 / 未并入则留 / 脏则留 / 孤儿则留）。
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SuperAgentManager } from "../src/panel/super-agent.js";
import { removeWorktree } from "../src/panel/worktree.js";
import type { AcpClient, AcpClientCallbacks } from "../src/acp/client.js";
import type { ContentBlock } from "../src/acp/protocol.js";
import type { SuperSessionUi } from "../shared/super-agent.js";

// 只把 removeWorktree 换成可断言的桩：其余导出保持真实实现（生产路径
// 真的删目录、真的删分支）。默认实现仍是原函数，只有个别用例用
// mockImplementationOnce 模拟「目录删不掉」。
vi.mock("../src/panel/worktree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/panel/worktree.js")>();
  return { ...actual, removeWorktree: vi.fn(actual.removeWorktree) };
});

const roots: string[] = [];
/** 装着 symlink/junction 的临时父目录（清理时先拆链接，再删目录）。 */
const linkParents: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    windowsHide: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "iflow-super-clean-"));
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

/**
 * 造一个「链接形态的仓库根」：真实仓库在 `repo`，另一个路径通过 symlink /
 * junction 指向它。
 *
 * 复刻 macOS CI 的真实形态：`os.tmpdir()` 给 `/var/folders/...`，git 的
 * `rev-parse --show-toplevel` 与 `worktree list --porcelain` 却输出 realpath
 * 形式 `/private/var/folders/...`。Windows 的目录联接会被 git 同样解析成
 * 目标路径（不需要管理员权限），所以这个坑在 Windows 上也能真实复现。
 *
 * 建立失败时返回真实仓库路径 —— 调用方据此 `ctx.skip()`。
 */
function makeLinkedRepo(repo: string): string {
  const parent = mkdtempSync(path.join(tmpdir(), "iflow-super-link-"));
  const link = path.join(parent, "link");
  try {
    symlinkSync(repo, link, process.platform === "win32" ? "junction" : "dir");
  } catch {
    rmSync(parent, { recursive: true, force: true });
    return repo;
  }
  linkParents.push(parent);
  return link;
}

/** 拆掉 makeLinkedRepo 建的链接（Windows junction 用 rmdir，POSIX 用 unlink）。 */
function removeLinkedRoot(parent: string): void {
  const link = path.join(parent, "link");
  try {
    unlinkSync(link);
  } catch {
    try {
      rmdirSync(link);
    } catch {
      // 已经不在 / 不是链接：下面的递归删除会兜底。
    }
  }
  rmSync(parent, { recursive: true, force: true });
}

/**
 * 在 `<repo>/.iflow/super/worktrees/` 下建一个真实的 git worktree。
 *
 * `commit` 非空时在 worktree 里提交一次 —— 分支因此领先 HEAD，
 * `merge-base --is-ancestor` 为假（正是「未并入」那一档）。
 */
function makeWorktree(
  repo: string,
  name: string,
  options: { branch?: string; commit?: string } = {},
): MadeWorktree {
  const root = path.join(repo, ".iflow", "super", "worktrees");
  mkdirSync(root, { recursive: true });
  const target = path.join(root, name);
  const branch = options.branch ?? `iflow/super/${name}`;
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

type Plan = "complete" | "hang";

/** AcpClient 的替身：管理器只用到很小的一个面。 */
class FakeClient {
  constructor(
    private readonly callbacks: AcpClientCallbacks,
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
    if (this.plan === "hang") {
      // 一直挂着 —— 子会话保持「运行中」，它的工作目录绝不能被清扫。
      return new Promise(() => {});
    }
    return { stopReason: "end_turn" };
  }

  cancel(): void {}

  async dispose(): Promise<void> {
    this.callbacks.onExit?.(0, null);
  }
}

interface Harness {
  manager: SuperAgentManager;
  sessions: SuperSessionUi[];
}

function makeManager(repo: string, plan: Plan = "complete"): Harness {
  const sessions: SuperSessionUi[] = [];
  const manager = new SuperAgentManager({
    repoRoot: repo,
    createClient: async (params) => new FakeClient(params.callbacks, plan) as unknown as AcpClient,
    onSessionsChanged: (next) => {
      sessions.length = 0;
      sessions.push(...next);
    },
    onReport: () => {},
    currentModel: () => "test-model",
    currentMainSessionId: () => "main-1",
    integrationMode: () => "merge",
    maxConcurrentSessions: () => 5,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { manager, sessions };
}

/** 轮询直到条件成立（管理器的工作是异步的：git worktree + 假客户端握手）。 */
async function until(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition not met in time");
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

/** 管理器内部的释放入口（私有方法）：单测直接打它，验证闸门判定。 */
type Internals = {
  releaseIsolation(
    id: string,
    mode: "merged" | "empty",
  ): Promise<{ ok: boolean; retryable?: boolean; reason?: string }>;
};

afterAll(() => {
  for (const parent of linkParents) removeLinkedRoot(parent);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("super agent · 没有产生提交时的隔离释放", () => {
  it("worktree 目录与分支都被清掉，记录标成已释放，文案不谎称已合入", async () => {
    const repo = makeRepo();
    const { manager, sessions } = makeManager(repo);
    manager.spawn({ title: "改登录", task: "干活" });
    await until(() => sessions[0]?.isolation.released === true);

    const session = sessions[0]!;
    const worktree = session.isolation.path;
    const branch = session.isolation.branch!;
    // 磁盘上真的没了……
    expect(existsSync(worktree)).toBe(false);
    expect(branchExists(repo, branch)).toBe(false);
    // ……而记录标成已释放（看板据此显示「工作目录与分支已清理」）。
    expect(session.isolation.released).toBe(true);
    // 文案如实：没有产生任何提交 → 工作目录已清理；**不**谎称已合入。
    expect(session.integration?.state).toBe("not_needed");
    expect(session.integration?.detail).toContain("没有产生任何提交");
    expect(session.integration?.detail).toContain("工作目录已清理");
    expect(session.integration?.detail).not.toContain("已合入");

    await manager.dispose();
  }, 30000);

  it("释放失败时不误标 released，并安排后台重试；重试成功后补上 released", async () => {
    const repo = makeRepo();
    const { manager, sessions } = makeManager(repo);
    // 第一次释放失败：目录删不掉（Windows 上子进程刚退出、文件仍被占用）。
    vi.mocked(removeWorktree).mockImplementationOnce(async () => ({
      removed: false,
      branchKept: false,
      reason: "目录删不掉",
    }));

    manager.spawn({ title: "改登录", task: "干活" });
    await until(() => sessions[0]?.integration?.state === "not_needed");
    await until(() => sessions[0]?.integration?.detail?.includes("清理未完成") === true);

    const session = sessions[0]!;
    const worktree = session.isolation.path;
    // 目录还在、记录没被标成已释放 —— 绝不谎称已清理。
    expect(existsSync(worktree)).toBe(true);
    expect(session.isolation.released).toBeFalsy();
    expect(session.integration?.detail).not.toContain("工作目录已清理");

    // 后台重试（首次 5s）成功后补上 released，并把目录真的删掉。
    await until(() => sessions[0]?.isolation.released === true, 30_000);
    expect(existsSync(worktree)).toBe(false);

    await manager.dispose();
  }, 60000);

  it("工作目录还有未提交改动时保留目录与分支，不谎称已清理", async () => {
    const repo = makeRepo();
    const { manager } = makeManager(repo);
    // 分支停在 HEAD（没有独有提交），但工作目录是脏的。
    const worktree = makeWorktree(repo, "dirty");
    writeFileSync(path.join(worktree.path, "leftover.txt"), "keep me\n", "utf8");
    manager.restoreSessions("main-1", [archivedRecord("super-dirty", worktree, repo)]);

    const outcome = await (manager as unknown as Internals).releaseIsolation("super-dirty", "empty");
    expect(outcome.ok).toBe(false);
    // 有未提交改动是**有意保留**，不是可重试的失败。
    expect(outcome.retryable).toBe(false);

    const record = manager.get("super-dirty");
    expect(record?.isolation.released).toBeFalsy();
    expect(existsSync(worktree.path)).toBe(true);
    expect(branchExists(repo, worktree.branch)).toBe(true);
    // 文案说的是「保留」，不是「已清理」。
    expect(record?.integration?.detail).toContain("保留");

    await manager.dispose();
  }, 30000);

  it("子会话在自己的 worktree 里另建过分支时：删目录不删掉那个分支，提交仍在", async () => {
    const repo = makeRepo();
    const { manager } = makeManager(repo);
    const worktree = makeWorktree(repo, "own-branch");
    // 子会话在 worktree 里另建分支并提交 —— 提交不在 iflow/super/ 分支上。
    git(worktree.path, "checkout", "-b", "child/own-work");
    writeFileSync(path.join(worktree.path, "own.txt"), "child work\n", "utf8");
    git(worktree.path, "add", "-A");
    git(worktree.path, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "own work");
    manager.restoreSessions("main-1", [archivedRecord("super-own", worktree, repo)]);

    const outcome = await (manager as unknown as Internals).releaseIsolation("super-own", "empty");
    expect(outcome.ok).toBe(true);

    // 空分支与它的 worktree 目录被清掉了……
    expect(existsSync(worktree.path)).toBe(false);
    expect(branchExists(repo, worktree.branch)).toBe(false);
    // ……但子会话自己那条分支与它的提交都还在。
    expect(branchExists(repo, "child/own-work")).toBe(true);
    expect(git(repo, "log", "--oneline", "child/own-work").trim().length).toBeGreaterThan(0);

    await manager.dispose();
  }, 30000);
});

describe("super agent · 残留 worktree 清扫", () => {
  it("分支已并入 HEAD 且工作目录干净的残留 worktree 会被删掉（目录 + 分支）", async () => {
    const repo = makeRepo();
    const { manager } = makeManager(repo);
    const worktree = makeWorktree(repo, "stale");
    manager.restoreSessions("main-1", [archivedRecord("super-stale", worktree, repo)]);

    const result = await manager.sweepStaleWorktrees();
    expect(result.removed).toBe(1);
    expect(result.kept).toBe(0);
    expect(existsSync(worktree.path)).toBe(false);
    expect(branchExists(repo, worktree.branch)).toBe(false);
    // 被清掉的历史记录也要标成已释放，否则看板一直显示待清理。
    expect(manager.get("super-stale")?.isolation.released).toBe(true);

    await manager.dispose();
  }, 30000);

  it("分支还没并入 HEAD 的 worktree 保留（上面可能有还没人审的提交）", async () => {
    const repo = makeRepo();
    const { manager } = makeManager(repo);
    const worktree = makeWorktree(repo, "unmerged", { commit: "child work\n" });
    manager.restoreSessions("main-1", [archivedRecord("super-unmerged", worktree, repo)]);

    const result = await manager.sweepStaleWorktrees();
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(1);
    expect(existsSync(worktree.path)).toBe(true);
    expect(branchExists(repo, worktree.branch)).toBe(true);
    expect(manager.get("super-unmerged")?.isolation.released).toBeFalsy();

    await manager.dispose();
  }, 30000);

  it("工作目录还有未提交改动的 worktree 保留（删掉就是丢数据）", async () => {
    const repo = makeRepo();
    const { manager } = makeManager(repo);
    const worktree = makeWorktree(repo, "dirty-stale");
    writeFileSync(path.join(worktree.path, "leftover.txt"), "keep me\n", "utf8");
    manager.restoreSessions("main-1", [archivedRecord("super-dirty-stale", worktree, repo)]);

    const result = await manager.sweepStaleWorktrees();
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(1);
    expect(existsSync(worktree.path)).toBe(true);
    expect(branchExists(repo, worktree.branch)).toBe(true);

    await manager.dispose();
  }, 30000);

  it("孤儿目录（已不在 git 注册表里）不自动删，只记日志请人工确认", async () => {
    const repo = makeRepo();
    const { manager } = makeManager(repo);
    const root = path.join(repo, ".iflow", "super", "worktrees");
    const orphan = path.join(root, "orphan");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(path.join(orphan, "leftover.txt"), "maybe mine\n", "utf8");

    const result = await manager.sweepStaleWorktrees();
    expect(result.orphans).toHaveLength(1);
    expect(result.removed).toBe(0);
    // 孤儿目录一律不自动删：无法确认里面有没有独有改动。
    expect(existsSync(orphan)).toBe(true);
    expect(existsSync(path.join(orphan, "leftover.txt"))).toBe(true);

    await manager.dispose();
  }, 30000);

  it("不是 iflow/super/ 命名空间下的分支不碰（用户自己的分支）", async () => {
    const repo = makeRepo();
    const { manager } = makeManager(repo);
    const worktree = makeWorktree(repo, "user-branch", { branch: "feature/user-work" });
    manager.restoreSessions("main-1", [archivedRecord("super-user", worktree, repo)]);

    const result = await manager.sweepStaleWorktrees();
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(1);
    expect(existsSync(worktree.path)).toBe(true);
    expect(branchExists(repo, "feature/user-work")).toBe(true);

    await manager.dispose();
  }, 30000);

  it("活着的子会话正在用的 worktree 不删", async () => {
    const repo = makeRepo();
    const { manager, sessions } = makeManager(repo, "hang");
    manager.spawn({ title: "改登录", task: "干活" });
    await until(() => sessions[0]?.status === "running");
    const worktree = sessions[0]!.isolation.path;

    // 子会话的分支停在 HEAD（已并入）—— 只有「活着」这一条能拦住清扫。
    const result = await manager.sweepStaleWorktrees();
    expect(result.removed).toBe(0);
    expect(existsSync(worktree)).toBe(true);

    await manager.cancel(sessions[0]!.id);
    await manager.dispose();
  }, 30000);

  it("清扫是幂等的：第二次调用不会再删任何东西", async () => {
    const repo = makeRepo();
    const { manager } = makeManager(repo);
    makeWorktree(repo, "stale-1");
    makeWorktree(repo, "stale-2");

    const first = await manager.sweepStaleWorktrees();
    expect(first.removed).toBe(2);
    const second = await manager.sweepStaleWorktrees();
    expect(second.removed).toBe(0);
    expect(second.kept).toBe(0);

    await manager.dispose();
  }, 30000);

  /**
   * macOS CI 回归（2026-11-16）：`git worktree list --porcelain` 输出的是
   * realpath 形式（`/private/var/...`），而目录枚举基于调用方手里的
   * `repoRoot`（`/var/...`）。旧实现直接比较两者 → 注册表里的 worktree
   * 全被判成孤儿目录，清扫恒为 0（CI 实测 `expected +0 to be 2`）。
   */
  it("链接形态的仓库根：清扫仍能认出注册表里的 worktree 并删掉", async (ctx) => {
    const realRepo = makeRepo();
    const repo = makeLinkedRepo(realRepo);
    if (repo === realRepo) ctx.skip();
    const { manager } = makeManager(repo);
    const worktree = makeWorktree(repo, "linked-stale");
    manager.restoreSessions("main-1", [archivedRecord("super-linked", worktree, repo)]);

    // 夹具证明：git 注册的路径与目录枚举的写法确实不同。个别平台/文件系统
    // 上 git 可能原样返回链接路径 —— 那样就没有回归场景，明确跳过。
    const toplevel = path.resolve(git(repo, "rev-parse", "--show-toplevel").trim());
    if (toplevel.toLowerCase() === path.resolve(repo).toLowerCase()) ctx.skip();

    const result = await manager.sweepStaleWorktrees();
    expect(result.orphans).toHaveLength(0);
    expect(result.removed).toBe(1);
    expect(result.kept).toBe(0);
    expect(existsSync(worktree.path)).toBe(false);
    expect(branchExists(repo, worktree.branch)).toBe(false);
    // 记录照旧标记为已释放，看板不会一直显示待清理。
    expect(manager.get("super-linked")?.isolation.released).toBe(true);

    await manager.dispose();
  }, 30000);

  it("链接形态的仓库根：保留上限回收也生效（只删目录、分支全部保留）", async (ctx) => {
    const realRepo = makeRepo();
    const repo = makeLinkedRepo(realRepo);
    if (repo === realRepo) ctx.skip();
    const { manager } = makeManager(repo);
    const oldest = makeWorktree(repo, "linked-oldest", { commit: "a\n" });
    const newest = makeWorktree(repo, "linked-newest", { commit: "b\n" });
    // 目录 mtime 决定回收顺序：显式设置，避免依赖创建顺序的时钟精度。
    const base = Date.now() - 60_000;
    utimesSync(oldest.path, new Date(base), new Date(base));
    utimesSync(newest.path, new Date(base + 10_000), new Date(base + 10_000));
    manager.restoreSessions("main-1", [
      archivedRecord("super-linked-oldest", oldest, repo),
      archivedRecord("super-linked-newest", newest, repo),
    ]);

    const result = await manager.sweepStaleWorktrees({ maxKeep: 1 });
    expect(result.removed).toBe(1);
    expect(existsSync(oldest.path)).toBe(false);
    expect(existsSync(newest.path)).toBe(true);
    // 回收只删目录，分支一律保留（上面可能有还没人审的提交）。
    expect(branchExists(repo, oldest.branch)).toBe(true);
    expect(branchExists(repo, newest.branch)).toBe(true);

    await manager.dispose();
  }, 30000);
});
