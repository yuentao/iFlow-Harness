/**
 * Super Agent 残留清理回归：
 *  1. 子会话终态（含失败/取消）回收附件副本，不再跨会话泄漏；
 *  2. `.iflow/super/attachments` 与 `dirs` 按 mtime 年龄清扫，活跃的保留；
 *  3. 删除主会话时归档子会话的附件/worktree 也清掉；
 *  4. 新建会话检测跨历史残留 → 二次确认；确认=全量清空（含未合并 worktree），
 *     取消=只新建不清空；
 *  5. 全量清空真的删掉未合并 worktree 目录与分支。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// 本文件跑真实 git + junction/realpath 混合路径清扫，重 FS IO；在 CI runner
// 与全量并发下单个用例可能跑十几秒。按文件放宽超时，不动全局 testTimeout。
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import {
  SuperAgentManager,
  SUPER_ATTACHMENT_MAX_AGE_MS,
  type SuperAgentDeps,
} from "../src/panel/super-agent.js";
import { comparisonPathKey, superIsolationDir } from "../src/panel/worktree.js";
import type { SuperSessionUi } from "../shared/super-agent.js";
import { setConfigOverrides } from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeContext(storageDir: string): vscodeTypes.ExtensionContext {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, defaultValue?: T): T =>
      store.has(key) ? (store.get(key) as T) : defaultValue,
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

const fakeClient = {
  newSession: async () => ({ sessionId: "child-fake" }),
  setMode: async () => ({}),
  setModel: async () => ({}),
  prompt: async () => ({ stopReason: "end_turn" }),
  cancel: async () => ({}),
  dispose: async () => {},
};

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeManager(repoRoot: string, overrides: Partial<SuperAgentDeps> = {}): SuperAgentManager {
  return new SuperAgentManager({
    repoRoot,
    createClient: async () => fakeClient as never,
    onSessionsChanged: () => {},
    onReport: () => {},
    currentModel: () => null,
    currentMainSessionId: () => "main-1",
    integrationMode: () => "manual",
    maxConcurrentSessions: () => 4,
    log: silentLog,
    ...overrides,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor timed out");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe("Super Agent · 残留目录清理", () => {
  let repoRoot: string;

  beforeEach(() => {
    setConfigOverrides({ checkpoints: false, autoTitle: false, autoMemoryCapture: false });
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-superresidue-repo-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("终态（正常完成）后删除附件副本", async () => {
    const src = path.join(repoRoot, "att.txt");
    fs.writeFileSync(src, "content");
    const mgr = makeManager(repoRoot);
    const session = mgr.spawn(
      { title: "t", task: "do it", attachments: [{ name: "att.txt", path: src }] },
      { isolation: "repo" },
    );
    const attachmentDir = path.join(superIsolationDir(repoRoot, "attachments"), session.id);
    await waitFor(() => mgr.get(session.id)?.status === "completed" && !fs.existsSync(attachmentDir));
    expect(fs.existsSync(attachmentDir)).toBe(false);
    await mgr.dispose();
  });

  it("附件/dirs 按 mtime 年龄清扫，新鲜目录保留", async () => {
    const now = Date.now();
    const attRoot = superIsolationDir(repoRoot, "attachments");
    const dirRoot = superIsolationDir(repoRoot, "dirs");
    fs.mkdirSync(path.join(attRoot, "old-att"), { recursive: true });
    fs.mkdirSync(path.join(attRoot, "new-att"), { recursive: true });
    fs.mkdirSync(path.join(dirRoot, "old-dir"), { recursive: true });
    fs.mkdirSync(path.join(dirRoot, "new-dir"), { recursive: true });
    for (const [entry, age] of [
      [path.join(attRoot, "old-att"), SUPER_ATTACHMENT_MAX_AGE_MS],
      [path.join(dirRoot, "old-dir"), 14 * 24 * 60 * 60 * 1000],
    ] as const) {
      const stale = new Date(now - (age + 60_000));
      fs.utimesSync(entry, stale, stale);
    }
    const mgr = makeManager(repoRoot);
    expect(await mgr.sweepStaleSuperAttachmentDirs({ now })).toBe(1);
    expect(await mgr.sweepStaleSuperDirs({ now })).toBe(1);
    expect(fs.existsSync(path.join(attRoot, "old-att"))).toBe(false);
    expect(fs.existsSync(path.join(dirRoot, "old-dir"))).toBe(false);
    expect(fs.existsSync(path.join(attRoot, "new-att"))).toBe(true);
    expect(fs.existsSync(path.join(dirRoot, "new-dir"))).toBe(true);
    await mgr.dispose();
  });

  it("活跃超流体正在用的附件目录即使过期也不清扫", async () => {
    const now = Date.now();
    const attRoot = superIsolationDir(repoRoot, "attachments");
    const dir = path.join(attRoot, "live-child");
    fs.mkdirSync(dir, { recursive: true });
    const stale = new Date(now - (SUPER_ATTACHMENT_MAX_AGE_MS + 60_000));
    fs.utimesSync(dir, stale, stale);
    const mgr = makeManager(repoRoot);
    (mgr as unknown as { sessions: Map<string, SuperSessionUi> }).sessions.set("live-child", {
      id: "live-child",
      title: "t",
      task: "t",
      status: "running",
      isolation: { kind: "directory", path: "" },
      createdAt: 0,
      updatedAt: 0,
      reports: [],
    });
    expect(await mgr.sweepStaleSuperAttachmentDirs({ now })).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
    await mgr.dispose();
  });

  it("删除主会话时清掉归档超流体的附件与 worktree", async () => {
    const mgr = makeManager(repoRoot);
    const attDir = path.join(superIsolationDir(repoRoot, "attachments"), "archived-child");
    fs.mkdirSync(attDir, { recursive: true });
    fs.writeFileSync(path.join(attDir, "a.txt"), "x");
    const wt = path.join(superIsolationDir(repoRoot, "worktrees"), "archived-wt");
    (mgr as unknown as { archived: Map<string, SuperSessionUi[]> }).archived.set("main-1", [
      {
        id: "archived-child",
        title: "t",
        task: "t",
        status: "completed",
        isolation: { kind: "git_worktree", path: wt, branch: "iflow/super/archived" },
        createdAt: 0,
        updatedAt: 0,
        reports: [],
      },
    ]);
    const result = await mgr.forgetMainSession("main-1");
    expect(fs.existsSync(attDir)).toBe(false);
    expect(result.worktrees.some((w) => w.id === "archived-child")).toBe(true);
    await mgr.dispose();
  });

  it("countResidue 统计 worktrees/dirs/attachments 三类目录", async () => {
    for (const kind of ["worktrees", "dirs", "attachments"] as const) {
      fs.mkdirSync(path.join(superIsolationDir(repoRoot, kind), "one"), { recursive: true });
    }
    fs.mkdirSync(path.join(superIsolationDir(repoRoot, "attachments"), "two"), { recursive: true });
    const mgr = makeManager(repoRoot);
    expect(await mgr.countResidue()).toEqual({ worktrees: 1, dirs: 1, attachments: 2, total: 4 });
    await mgr.dispose();
  });

  it("全量清空删除未合并 worktree 目录与分支（含未提交改动）", async () => {
    // 用真实 git 仓库制造一个「有未合并提交 + 有未提交改动」的 worktree。
    git(repoRoot, ["init", "-q"]);
    git(repoRoot, ["config", "user.email", "t@e.st"]);
    git(repoRoot, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repoRoot, "base.txt"), "base");
    git(repoRoot, ["add", "-A"]);
    git(repoRoot, ["commit", "-qm", "base"]);
    const wt = path.join(superIsolationDir(repoRoot, "worktrees"), "unmerged");
    git(repoRoot, ["worktree", "add", "-q", "-b", "iflow/super/unmerged", wt]);
    fs.writeFileSync(path.join(wt, "unmerged.txt"), "uncommitted work");
    expect(fs.existsSync(wt)).toBe(true);

    const mgr = makeManager(repoRoot);
    const result = await mgr.purgeAllResidue();
    expect(result.worktrees).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(wt)).toBe(false);
    const branches = git(repoRoot, ["branch", "--list", "iflow/super/*"]);
    expect(branches).toBe("");
    await mgr.dispose();
  });
});

type PostedMessage = {
  type: string;
  requestId?: string;
  message?: string;
  confirmLabel?: string;
};

type PanelInternals = {
  editorPanel: unknown;
  superAgent: unknown;
  confirmAndPurgeSuperResidue: () => Promise<void>;
  handleSuperResidueConfirmResponse: (requestId: string, confirmed: boolean) => void;
  store: { sendToast: (...args: unknown[]) => number };
};

describe("ChatPanel · 新建会话的残留确认", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let posted: PostedMessage[];
  let purgeSpy: ReturnType<typeof vi.fn>;
  let residueRepo: string;

  beforeEach(() => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-superresidue-panel-"));
    residueRepo = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-superresidue-repo2-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: residueRepo, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    posted = [];
    p.editorPanel = {
      webview: { postMessage: (m: PostedMessage) => { posted.push(m); return Promise.resolve(true); } },
      dispose: () => {},
      visible: true,
    };
    purgeSpy = vi.fn(async () => ({ worktrees: 1, dirs: 1, attachments: 1, failed: 0 }));
    p.superAgent = {
      countResidue: async () => ({ worktrees: 1, dirs: 1, attachments: 1, total: 3 }),
      purgeAllResidue: purgeSpy,
    };
    vi.spyOn(p.store, "sendToast").mockImplementation((() => 1) as PanelInternals["store"]["sendToast"]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(residueRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("检测到残留时发确认请求，文案醒目警示未合并工作将永久丢失", async () => {
    const run = p.confirmAndPurgeSuperResidue();
    await waitFor(() => posted.some((m) => m.type === "superResidueConfirm"));
    const confirm = posted.find((m) => m.type === "superResidueConfirm")!;
    expect(confirm.confirmLabel).toBe("清空并新建");
    expect(confirm.message).toContain("未合并");
    expect(confirm.message).toContain("永久丢失");
    expect(confirm.message).toContain("3 个");
    // 还没有回答 → 不提前清空。
    expect(purgeSpy).not.toHaveBeenCalled();
    p.handleSuperResidueConfirmResponse(confirm.requestId!, true);
    await run;
  });

  it("用户确认后执行全量清空", async () => {
    const run = p.confirmAndPurgeSuperResidue();
    await waitFor(() => posted.some((m) => m.type === "superResidueConfirm"));
    const confirm = posted.find((m) => m.type === "superResidueConfirm")!;
    p.handleSuperResidueConfirmResponse(confirm.requestId!, true);
    await run;
    expect(purgeSpy).toHaveBeenCalledTimes(1);
  });

  it("用户取消后只新建、不清空", async () => {
    const run = p.confirmAndPurgeSuperResidue();
    await waitFor(() => posted.some((m) => m.type === "superResidueConfirm"));
    const confirm = posted.find((m) => m.type === "superResidueConfirm")!;
    p.handleSuperResidueConfirmResponse(confirm.requestId!, false);
    await run;
    expect(purgeSpy).not.toHaveBeenCalled();
  });

  it("无残留时不弹确认框、不清空", async () => {
    (p.superAgent as { countResidue: () => Promise<unknown> }).countResidue = async () => ({
      worktrees: 0, dirs: 0, attachments: 0, total: 0,
    });
    await p.confirmAndPurgeSuperResidue();
    expect(posted).toHaveLength(0);
    expect(purgeSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// S3 · 残留清扫幂等性（3.5.0）
//
// 3.2.1 修复：sweepStaleWorktrees 用 realpath 归一键比较 git 注册表里的路径与
// 目录枚举结果。symlink / junction 形式的 repoRoot 下，git 报真实路径、枚举报
// 别名路径，只做词法归一会把全部 worktree 判成孤儿（清扫恒 0）。这里用别名路径
// 交叉验证：重复扫不漏删可回收、不误删未合并/活跃项，且不触碰主仓工作区。
// ---------------------------------------------------------------------------

describe("S3 · junction/realpath 混合路径下清扫幂等", () => {
  let realRepo: string;
  let aliasRepo: string;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, {
      cwd,
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  /** 在隔离子树下造一个 worktree：分支停在 HEAD（已并入、干净 → 可回收）。 */
  function makeWorktreeAtHead(slug: string): string {
    const branch = `iflow/super/${slug}`;
    const wt = path.join(superIsolationDir(realRepo, "worktrees"), slug);
    git(realRepo, "branch", branch);
    git(realRepo, "worktree", "add", "-q", wt, branch);
    return wt;
  }

  beforeEach(() => {
    setConfigOverrides({ checkpoints: false, autoTitle: false, autoMemoryCapture: false });
    realRepo = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-s3-real-"));
    git(realRepo, "init", "-q");
    git(realRepo, "config", "user.email", "t@e.st");
    git(realRepo, "config", "user.name", "t");
    fs.writeFileSync(path.join(realRepo, "base.txt"), "base\n");
    git(realRepo, "add", "-A");
    git(realRepo, "commit", "-qm", "base");

    // 别名路径：Windows 用 junction（免管理员权限），POSIX 用目录符号链接。
    aliasRepo = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-s3-alias-"));
    fs.rmdirSync(aliasRepo);
    fs.symlinkSync(realRepo, aliasRepo, process.platform === "win32" ? "junction" : "dir");
  });

  afterEach(() => {
    // 只移除别名本身（lstat 语义，绝不跟随进 realRepo）。
    try {
      if (process.platform === "win32") fs.rmdirSync(aliasRepo);
      else fs.unlinkSync(aliasRepo);
    } catch {
      // 别名可能已被测试清理，忽略。
    }
    fs.rmSync(realRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("realpath 归一把 junction 别名路径与真实路径归一到同一键", async () => {
    expect(await comparisonPathKey(aliasRepo)).toBe(await comparisonPathKey(realRepo));
    expect(await comparisonPathKey(path.join(aliasRepo, ".iflow", "super"))).toBe(
      await comparisonPathKey(path.join(realRepo, ".iflow", "super")),
    );
  });

  it("别名路径下重复清扫幂等：可回收不漏删，未合并与活跃 worktree 不误删", async () => {
    // 可回收：分支停在 HEAD、目录干净。
    const stale = makeWorktreeAtHead("merged-clean");
    // 保留一：分支比 HEAD 多一笔提交（未合并）。
    const unmerged = makeWorktreeAtHead("unmerged-keep");
    fs.writeFileSync(path.join(unmerged, "extra.txt"), "x\n");
    git(unmerged, "add", "-A");
    git(unmerged, "commit", "-qm", "extra");
    // 保留二：活着的子会话正在用（即便分支已并入也不能删）。
    const live = makeWorktreeAtHead("live-keep");

    // 管理器用别名路径打开仓库：注册表里 git 报真实路径、枚举报别名路径。
    const mgr = makeManager(aliasRepo);
    (mgr as unknown as { sessions: Map<string, SuperSessionUi> }).sessions.set("live-child", {
      id: "live-child",
      title: "t",
      task: "t",
      status: "running",
      isolation: {
        kind: "git_worktree",
        path: live,
        branch: "iflow/super/live-keep",
        baseRef: git(realRepo, "rev-parse", "HEAD"),
      },
      createdAt: 0,
      updatedAt: 0,
      reports: [],
    });

    const first = await mgr.sweepStaleWorktrees();
    expect(first.removed).toBe(1); // 可回收的那个真的被删了（不漏删）
    expect(fs.existsSync(stale)).toBe(false);
    // 未合并 / 活跃的两个都还在（不误删）。
    expect(fs.existsSync(unmerged)).toBe(true);
    expect(fs.existsSync(live)).toBe(true);
    expect(git(realRepo, "branch", "--list", "iflow/super/unmerged-keep")).toContain(
      "iflow/super/unmerged-keep",
    );

    // 再扫一次：可回收的已不在，其余仍受保护 → 0 删除，现场不变（幂等）。
    const second = await mgr.sweepStaleWorktrees();
    expect(second.removed).toBe(0);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(unmerged)).toBe(true);
    expect(fs.existsSync(live)).toBe(true);
    await mgr.dispose();
  });
});
