/**
 * 子会话合并请求（宿主侧）。
 *
 * 三条要求：
 *  1. 子会话完成、改动**没能自动合并**时，宿主自动发起合并请求 —— 不再把这
 *     件事留给用户点看板上的按钮；主会话正忙时排队，空闲后再发起（串行）。
 *  2. 合并**不再走主会话的 prompt 通道**：宿主派一个跑在主仓工作区的合并
 *     子会话（repo 档）去执行 `git merge --no-ff`。主会话既不跑 git，也不
 *     收到这段提示词。
 *  3. 排队的是「待派发的合并子会话」，不是一条待发送的提示词。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// 本文件跑真实 git（建仓 / worktree / merge --no-ff），在 CI runner 与全量
// 并发下单个用例可能跑十几秒。按文件放宽超时，不动全局 testTimeout。
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { SuperAgentManager, type SuperAgentDeps } from "../src/panel/super-agent.js";
import { mergeBranch, previewMerge, type WorktreeGitRunner } from "../src/panel/worktree.js";
import { setConfigOverrides } from "./vscode-stub.js";
import type { SessionState } from "../shared/messages.js";
import type { SuperSessionUi } from "../shared/super-agent.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeContext(storageDir: string): vscodeTypes.ExtensionContext {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? (store.get(key) as T) : defaultValue),
    update: (key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    },
    keys: () => [...store.keys()],
    delete: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
  };
  return {
    subscriptions: [],
    secrets: {
      get: () => Promise.resolve(undefined),
      store: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    workspaceState: state,
    globalState: state,
    extensionUri: { fsPath: here },
    extensionPath: here,
    extensionMode: 3,
    logPath: here,
    storageUri: { fsPath: storageDir },
    globalStorageUri: { fsPath: storageDir },
    storagePath: storageDir,
    globalStoragePath: storageDir,
    asAbsolutePath: (p: string) => path.join(here, p),
  } as unknown as vscodeTypes.ExtensionContext;
}

function makeWatchers(): NonNullable<PanelServices["watchers"]> {
  const noop = () => ({ dispose: () => {} });
  return [
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
  ];
}

type PromptCall = {
  prompt: Array<{ type: string; text?: string }>;
  resolve: (v: { stopReason: string }) => void;
};

/** 宿主派发合并子会话时交给管理器的参数。 */
type MergeSpawn = {
  source: SuperSessionUi;
  task: string;
  title: string;
};

type PanelInternals = {
  ensureClient: () => Promise<unknown>;
  promptWithRetry: (
    client: unknown,
    sessionId: string,
    prompt: unknown,
  ) => Promise<{ stopReason: string }>;
  persistActiveTranscript: () => Promise<void>;
  touchActiveSession: () => Promise<void>;
  maybeGenerateAiTitle: (id: string) => Promise<void>;
  /** 宿主自动合并请求的排队入口（管理器回调）。 */
  scheduleSuperMerge: (id: string, reason: string) => void;
  /** 队列的串行 drain（回合结束钩子也会调它）。 */
  drainSuperMerges: () => Promise<void>;
  getSuperAgent: () => unknown;
  store: {
    getState: () => SessionState;
    sessionStarted: (meta: { sessionId: string }) => void;
    replaceState: (state: unknown) => void;
  };
};

/** 一个已结束、有分支的子会话（自动集成没把它合进来）。 */
const CHILD: SuperSessionUi = {
  id: "super-1",
  title: "修复登录跳转",
  task: "修好 src/auth.ts",
  status: "completed",
  isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/a", baseRef: "abc" },
  createdAt: 1000,
  updatedAt: 2000,
  reports: [],
};

describe("ChatPanel 超流体合并请求（派合并超流体，不再走主会话 prompt）", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let calls: PromptCall[];
  let merges: MergeSpawn[];

  beforeEach(async () => {
    // sendPrompt 会等一次工作区快照（真实 git 子进程）；这里只测合并请求的
    // 触发与派发，关掉 checkpoint 免得每次都拉起 git。
    setConfigOverrides({ checkpoints: false });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-supermerge-storage-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    calls = [];
    merges = [];
    p.ensureClient = async () => ({});
    p.promptWithRetry = vi.fn(
      (_c: unknown, _s: string, prompt: Array<{ type: string; text?: string }>) =>
        new Promise<{ stopReason: string }>((resolve) => {
          calls.push({ prompt, resolve });
        }),
    ) as unknown as PanelInternals["promptWithRetry"];
    p.persistActiveTranscript = async () => {};
    p.touchActiveSession = async () => {};
    p.maybeGenerateAiTitle = async () => {};
    p.store.sessionStarted({ sessionId: "sm-session" });
    Object.assign(p, {
      getSuperAgent: () => ({
        get: () => CHILD,
        // 合并子会话由管理器派发（repo 档）；这里只记录宿主交给它的参数。
        spawnMerge: async (request: MergeSpawn) => {
          merges.push(request);
          return {
            id: "super-merge-1",
            title: request.title,
            task: request.task,
            status: "preparing",
            isolation: { kind: "repo", path: here },
            createdAt: Date.now(),
            updatedAt: Date.now(),
            reports: [],
          };
        },
      }),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
  }

  /**
   * 等到合并子会话真的派出为止。合并子会话是异步的（它有自己的 CLI 进程），
   * 所以这里等「已派发」这个信号，而不是等它跑完。
   */
  async function waitForMerges(count: number, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (merges.length < count && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("自动触发合并请求：派合并超流体，主会话收不到这段提示词", async () => {
    p.scheduleSuperMerge("super-1", "改动与本地未提交改动重叠");
    await waitForMerges(1);

    expect(merges).toHaveLength(1);
    const request = merges[0]!;
    // 来源就是那个没合进来的子会话。
    expect(request.source.id).toBe("super-1");
    // 标题点明是哪个分支。
    expect(request.title).toBe("合并分支 iflow/super/a");
    // 任务书就是合并任务书本身。
    expect(request.task).toContain("git merge --no-ff iflow/super/a");
    // 自动触发：开头说的是「没能自动合并」，不是「用户在看板点击了」（提示词正文是英文）。
    expect(request.task).toContain("could not be merged automatically");
    expect(request.task).not.toContain("The user clicked");

    // 关键：合并不再走主会话的 prompt 通道（主会话不跑 git）。
    expect(calls).toHaveLength(0);
    expect(p.store.getState().blocks.filter((b) => b.kind === "user")).toHaveLength(0);
  });

  it("主会话正忙时排队，空闲后自动派发（不丢请求）", async () => {
    p.store.replaceState({ ...p.store.getState(), status: "streaming" });
    p.scheduleSuperMerge("super-1", "改动重叠");
    await flush();
    expect(merges).toHaveLength(0);

    p.store.replaceState({ ...p.store.getState(), status: "idle" });
    void p.drainSuperMerges();
    await waitForMerges(1);
    expect(merges).toHaveLength(1);
    expect(merges[0]?.source.id).toBe("super-1");
  });

  it("requestSuperMerge 返回真实结果：派出成功 / 已有合并超流体未派发", async () => {
    const request = (p as unknown as {
      requestSuperMerge: (id: string) => Promise<{ dispatched: boolean; reason?: string }>;
    }).requestSuperMerge.bind(p);

    const ok = await request("super-1");
    expect(ok.dispatched).toBe(true);
    expect(merges).toHaveLength(1);

    // 主仓工作区只允许一个合并子会话：再派一次 spawnMerge 返回 null。
    Object.assign(p, {
      getSuperAgent: () => ({
        get: () => CHILD,
        spawnMerge: async () => null,
      }),
    });
    const blocked = await request("super-1");
    expect(blocked.dispatched).toBe(false);
    expect(blocked.reason).toContain("已有合并超流体");
    expect(merges).toHaveLength(1);
  });

  it("QQ 端口 merge 回传真实 detail：未派发时不谎报「已派出合并超流体」", async () => {
    Object.assign(p, {
      getSuperAgent: () => ({
        get: () => CHILD,
        spawnMerge: async () => null,
      }),
    });
    const ports = (p as unknown as {
      createQqHostPorts: () => {
        merge: (id: string) => Promise<{ ok: boolean; detail: string }>;
      };
    }).createQqHostPorts();

    const result = await ports.merge("super-1");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("未派出");
    expect(result.detail).not.toContain("已派出合并超流体");
  });
});

// ---------------------------------------------------------------------------
// S1 · 自动合并竞态回归（3.5.0）
//
// 固化已有的高危安全承诺，不改行为：
//  - 预演只操作对象库（merge-tree --write-tree），索引/工作区绝不被触碰；
//  - 合并前检查中间态；合并失败只撤销「自己留下的」MERGE_HEAD；
//  - 全程不替用户 git add / commit / stash / abort 用户自己的操作。
//
// 纯函数用 WorktreeMergeDeps 注入精确制造竞态（真实仓库里两次探测之间用户启动
// merge 无法稳定复现）；两条让路分支用真实 git 夹具断言磁盘不变量。
// ---------------------------------------------------------------------------

const MUTATING_GIT_VERBS = ["add", "commit", "stash", "abort", "checkout", "reset"];

function expectNoMutatingGit(calls: string[]): void {
  for (const call of calls) {
    const tokens = call.split(" ");
    for (const verb of MUTATING_GIT_VERBS) {
      expect(tokens).not.toContain(verb);
    }
  }
}

describe("S1 · 预演与合并的只读不变量（deps 注入，确定性）", () => {
  it("预演发现内容冲突：clean=false + 改动路径，且全程只读 git（不触碰工作区）", async () => {
    const runCalls: string[] = [];
    const run: WorktreeGitRunner = async (_cwd, args) => {
      runCalls.push(args.join(" "));
      if (args[0] === "merge-base") return { stdout: "base\n", stderr: "" };
      if (args[0] === "diff") return { stdout: "src/app.ts\0", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const rawCalls: string[] = [];
    const preview = await previewMerge({
      repoRoot: "/fake",
      branch: "iflow/super/child",
      deps: {
        run,
        runRaw: async (_cwd, args) => {
          rawCalls.push(args.join(" "));
          // exit 1 = 合并有冲突；--write-tree 只写对象库，索引与工作区不变。
          return { code: 1, stdout: "", stderr: "conflict" };
        },
      },
    });

    expect(preview).toEqual({ available: true, clean: false, paths: ["src/app.ts"] });
    expect(rawCalls).toEqual(["merge-tree --write-tree HEAD iflow/super/child"]);
    // 除了 merge-tree 预演，只有只读的 merge-base / diff；没有任何写命令。
    expect(runCalls.every((c) => c.startsWith("merge-base") || c.startsWith("diff"))).toBe(true);
    expectNoMutatingGit([...runCalls, ...rawCalls]);
  });

  it("合并成功也只发一条 merge --no-ff，不先替用户 add/commit/stash", async () => {
    const calls: string[] = [];
    const run: WorktreeGitRunner = async (_cwd, args) => {
      calls.push(args.join(" "));
      return { stdout: "", stderr: "" };
    };
    const result = await mergeBranch({
      repoRoot: "/fake",
      branch: "iflow/super/child",
      deps: { run, marker: async () => false },
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toContain("merge --no-ff --no-edit iflow/super/child");
    expectNoMutatingGit(calls);
  });

  it("主仓停在 merge/rebase/cherry-pick 中间态时合并根本不启动，不 abort 用户操作", async () => {
    for (const marker of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD"]) {
      const calls: string[] = [];
      const run: WorktreeGitRunner = async (_cwd, args) => {
        calls.push(args.join(" "));
        return { stdout: "", stderr: "" };
      };
      const result = await mergeBranch({
        repoRoot: "/fake",
        branch: "iflow/super/child",
        deps: { run, marker: async (_repo, name) => name === marker },
      });
      expect(result.ok).toBe(false);
      // 一次 git 都没发：连 HEAD/分支 tip 探测都没做，更不会 abort 用户的中间态。
      expect(calls).toEqual([]);
    }
  });
});

describe("S1 · 自动合并的两条让路分支（真实 git，工作区不变）", () => {
  let repo: string;
  let mgr: SuperAgentManager;
  let baseRef: string;
  const wtDirs: string[] = [];

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, {
      cwd,
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  function makeMergeManager(repoRoot: string): SuperAgentManager {
    const fakeClient = {
      newSession: async () => ({ sessionId: "child-fake" }),
      setMode: async () => ({}),
      setModel: async () => ({}),
      prompt: async () => ({ stopReason: "end_turn" }),
      cancel: async () => ({}),
      dispose: async () => {},
    };
    const deps: SuperAgentDeps = {
      repoRoot,
      createClient: async () => fakeClient as never,
      onSessionsChanged: () => {},
      onReport: () => {},
      currentModel: () => null,
      currentMainSessionId: () => "main-1",
      integrationMode: () => "merge",
      maxConcurrentSessions: () => 4,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    };
    return new SuperAgentManager(deps);
  }

  /** 造一个「有独有提交」的子会话记录，并放进管理器的 sessions 供集成判定。 */
  function addChildWithCommit(
    id: string,
    branch: string,
    file: string,
    content: string,
  ): void {
    const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-s1-wt-"));
    wtDirs.push(wtDir);
    const wt = path.join(wtDir, "wt");
    git(repo, "worktree", "add", "-q", "-b", branch, wt);
    fs.writeFileSync(path.join(wt, file), content, "utf8");
    git(wt, "add", "-A");
    git(wt, "commit", "-qm", "child commit");
    (mgr as unknown as { sessions: Map<string, SuperSessionUi> }).sessions.set(id, {
      id,
      title: "child",
      task: "child",
      status: "completed",
      attempts: 1,
      isolation: { kind: "git_worktree", path: wt, branch, baseRef },
      createdAt: 1,
      updatedAt: 2,
      reports: [],
    });
  }

  /** 直接驱动一次集成（跳过 CLI 回合，专注 git 让路决策）。 */
  function integrate(id: string): Promise<void> {
    return (
      mgr as unknown as { integrate: (id: string, attempt: number) => Promise<void> }
    ).integrate(id, 1);
  }

  beforeEach(() => {
    setConfigOverrides({ checkpoints: false });
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-s1-merge-"));
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "t@e.st");
    git(repo, "config", "user.name", "t");
    // 主仓里预置一个已跟踪文件，子会话会改它，制造「已跟踪路径重叠」。
    fs.writeFileSync(path.join(repo, "shared.txt"), "base\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    baseRef = git(repo, "rev-parse", "HEAD");
    mgr = makeMergeManager(repo);
  }, 60000);

  afterEach(async () => {
    await mgr.dispose();
    for (const dir of wtDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }, 60000);

  it("已跟踪文件与合并改动路径重叠：跳过、保留分支，主仓文件与 HEAD 不变", async () => {
    addChildWithCommit("s-overlap", "iflow/super/overlap", "shared.txt", "child\n");
    // 主仓同名已跟踪文件有未提交改动（用户正在改）。
    fs.writeFileSync(path.join(repo, "shared.txt"), "user work\n", "utf8");
    const beforeHead = git(repo, "rev-parse", "HEAD");

    await integrate("s-overlap");

    const session = mgr.get("s-overlap")!;
    expect(session.integration?.state).toBe("skipped");
    expect(session.integration?.needsAction).toBe(true);
    expect(session.integration?.detail).toContain("重叠");
    // 不变量：用户的工作区文件原样、HEAD 没产生合并提交、分支仍在、无 MERGE_HEAD。
    expect(fs.readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe("user work\n");
    expect(git(repo, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(git(repo, "branch", "--list", "iflow/super/overlap")).toContain("iflow/super/overlap");
    expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  }, 60000);

  it("同名未跟踪文件挡住合并：拒绝且工作区原样，绝不替用户 add/commit/stash", async () => {
    addChildWithCommit("s-untracked", "iflow/super/untracked", "new.txt", "child\n");
    // 主仓里同名文件是用户自己的未跟踪草稿。
    fs.writeFileSync(path.join(repo, "new.txt"), "user draft\n", "utf8");
    const beforeHead = git(repo, "rev-parse", "HEAD");

    await integrate("s-untracked");

    const session = mgr.get("s-untracked")!;
    // 预演干净但 git 落盘前被同名未跟踪文件拒绝 → 如实记 skipped，不谎报成功。
    expect(session.integration?.state).toBe("skipped");
    expect(session.integration?.needsAction).toBe(true);
    // 不变量：未跟踪草稿原样、仍是未跟踪、HEAD 无合并提交、分支保留、无中间态。
    expect(fs.readFileSync(path.join(repo, "new.txt"), "utf8")).toBe("user draft\n");
    expect(git(repo, "status", "--porcelain")).toContain("?? new.txt");
    expect(git(repo, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(git(repo, "branch", "--list", "iflow/super/untracked")).toContain(
      "iflow/super/untracked",
    );
    expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  }, 60000);

  it("多子会话同时完成：集成走串行链，逐个判定，不会并发叠加出坏合并", async () => {
    addChildWithCommit("s-a", "iflow/super/a-task", "from-a.txt", "a\n");
    addChildWithCommit("s-b", "iflow/super/b-task", "from-b.txt", "b\n");

    // 两次集成同时发起——宿主把它们排在同一条串行 promise 链上。
    await Promise.all([integrate("s-a"), integrate("s-b")]);

    // 主仓干净，两笔都干净合并；HEAD 恰好多出两个 merge commit（不多不少）。
    expect(mgr.get("s-a")?.integration?.state).toBe("merged");
    expect(mgr.get("s-b")?.integration?.state).toBe("merged");
    expect(Number(git(repo, "rev-list", "--count", "--merges", `${baseRef}..HEAD`))).toBe(2);
    expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  }, 60000);
}, 60000);