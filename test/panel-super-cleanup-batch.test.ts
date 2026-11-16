/**
 * 批量清理的宿主侧回执（看板「清理已结束」）。
 *
 * 旧实现让看板逐个发 `cleanup`，宿主于是给每个子会话各发一条 info toast ——
 * 用户看到 N 条一模一样的「已清理子会话」，既不知道整批到哪了，也不知道
 * 有没有失败。这里钉住三件事：
 *
 *  1. `cleanupBatch` 是**串行**清理（worktree 删除 / git 探测会互相抢锁）；
 *  2. 整批只发**一条**汇总 toast，且按真实聚合结果措辞（全部成功 / 部分失败 /
 *     分支保留），失败绝不谎报成功；
 *  3. 单个 `cleanup` 的回执保持原样（不因批量改造被顺手改掉）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { setConfigOverrides } from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeContext(storageDir: string): vscodeTypes.ExtensionContext {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, defaultValue?: T): T =>
      store.has(key) ? (store.get(key) as T) : defaultValue,
    update: () => Promise.resolve(),
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

type CleanupResult = { ok: boolean; branchKept?: boolean; reason?: string };

type SuperActionMessage = {
  type: "superAgent";
  action:
    | "cancel"
    | "cancelAll"
    | "respond"
    | "cleanup"
    | "cleanupBatch"
    | "merge"
    | "transcript"
    | "retry";
  sessionId?: string;
  sessionIds?: string[];
  answers?: Record<string, string | string[]>;
  keepBranch?: boolean;
};

type PanelInternals = {
  superAgent: unknown;
  handleSuperAgentAction: (msg: SuperActionMessage) => Promise<void>;
  store: {
    sendToast: (...args: unknown[]) => number;
  };
};

describe("Super Agent · 批量清理的汇总回执", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let cleanup: ReturnType<typeof vi.fn>;
  let toasts: { level: string; message: string }[];

  beforeEach(() => {
    setConfigOverrides({
      checkpoints: false,
      autoTitle: false,
      autoMemoryCapture: false,
      nextStepSuggestions: false,
    });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-supercleanup-storage-"));
    panel = new ChatPanel(makeContext(storageDir), {
      workspaceRoot: here,
      watchers: makeWatchers(),
    });
    p = panel as unknown as PanelInternals;
    cleanup = vi.fn(async (_id: string): Promise<CleanupResult> => ({ ok: true }));
    p.superAgent = { list: () => [], reportPrompt: () => "", cleanup };
    toasts = [];
    vi.spyOn(p.store, "sendToast").mockImplementation(((
      level: string,
      message: string,
    ) => {
      toasts.push({ level, message });
      return 1;
    }) as unknown as PanelInternals["store"]["sendToast"]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("全部成功：串行清理每个目标，只发一条 info 汇总 toast", async () => {
    cleanup
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });

    await p.handleSuperAgentAction({
      type: "superAgent",
      action: "cleanupBatch",
      sessionIds: ["super-a", "super-b"],
    });

    // 串行 + 按顺序逐个调用。
    expect(cleanup.mock.calls.map((call) => call[0])).toEqual(["super-a", "super-b"]);
    // 一条回执，不是每个子会话各一条。
    expect(toasts).toEqual([{ level: "info", message: "已清理 2 个子会话" }]);
  });

  it("部分失败：如实给出成功与失败的数量（warning，不谎报全部成功）", async () => {
    cleanup
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, reason: "工作目录未能删除" });

    await p.handleSuperAgentAction({
      type: "superAgent",
      action: "cleanupBatch",
      sessionIds: ["super-a", "super-b"],
    });

    expect(toasts).toEqual([
      { level: "warning", message: "已清理 1 个子会话，1 个未能清理" },
    ]);
  });

  it("全部失败：只发一条 warning，说明这批都没清掉", async () => {
    cleanup.mockResolvedValue({ ok: false, reason: "工作目录未能删除" });

    await p.handleSuperAgentAction({
      type: "superAgent",
      action: "cleanupBatch",
      sessionIds: ["super-a", "super-b"],
    });

    expect(toasts).toEqual([{ level: "warning", message: "未能清理这 2 个子会话" }]);
  });

  it("分支被保留时如实补一句（不把「目录已删、分支还在」说成全部清干净）", async () => {
    cleanup
      .mockResolvedValueOnce({ ok: true, branchKept: true, reason: "分支上有未合并的提交" })
      .mockResolvedValueOnce({ ok: true });

    await p.handleSuperAgentAction({
      type: "superAgent",
      action: "cleanupBatch",
      sessionIds: ["super-a", "super-b"],
    });

    expect(toasts).toEqual([
      { level: "info", message: "已清理 2 个子会话，1 个分支已保留" },
    ]);
  });

  it("单个 cleanup 的回执保持原样（一条 info，不受批量改造影响）", async () => {
    cleanup.mockResolvedValueOnce({ ok: true });

    await p.handleSuperAgentAction({
      type: "superAgent",
      action: "cleanup",
      sessionId: "super-a",
    });

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith("super-a", { keepBranch: undefined });
    expect(toasts).toEqual([{ level: "info", message: "已清理子会话" }]);
  });
});
