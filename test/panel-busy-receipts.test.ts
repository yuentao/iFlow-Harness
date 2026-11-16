import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ChatPanel } from "../src/panel/panel.js";
import { acpSessionFilePath } from "../src/acp/models-query.js";
import type { PanelServices } from "../src/panel/panel.js";
import type * as vscode from "vscode";

/**
 * 异步操作的「进行态 + 失败回执」（host 侧）。
 *
 * - `initializing` 锁必须带原因（删除会话 / 删除消息 / 回滚对话），否则顶栏
 *   一律说「正在创建新会话」。
 * - webview 消息路由必须有统一 catch（旧实现是静默 unhandled rejection）。
 * - 设置写入失败 / 模型列表刷新失败 / 审批规则写失败都必须有面板内回执。
 */

const here = path.dirname(fileURLToPath(import.meta.url));

function makeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? store.get(key) : defaultValue) as T,
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
    storageUri: { fsPath: here },
    globalStorageUri: { fsPath: here },
    storagePath: here,
    globalStoragePath: here,
    asAbsolutePath: (p: string) => path.join(here, p),
  } as unknown as vscode.ExtensionContext;
}

/** Watcher doubles: the vscode stub has no watcher API. */
function makeWatchers(): NonNullable<PanelServices["watchers"]> {
  const noop = () => ({ dispose: () => {} });
  return [
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
  ];
}

type PanelInternals = {
  store: {
    getState: () => {
      initializing: boolean;
      initializingReason: string | null;
      status: string;
      blocks: Array<{ id?: string }>;
    };
    sendToast: (level: string, message: string) => number;
    sessionStarted: (meta: unknown) => void;
    userPrompt: (text: string) => void;
  };
  client: unknown;
  historySyncBusy: boolean;
  context: vscode.ExtensionContext;
  approvalRules: unknown[];
  deleteUserMessage: (id: string, reason?: "deleteMessage" | "rollback") => Promise<void>;
  refreshLiveModels: () => Promise<void>;
  queryLiveModelsDetailed: () => Promise<
    | { ok: true; models: Array<{ id: string; name: string }> }
    | { ok: false; reason: "no-endpoint" | "unreachable"; message?: string }
  >;
  saveApprovalPolicy: (rules: unknown[]) => Promise<void>;
  writeUserSetting: (key: string, value: unknown) => Promise<void>;
  wireWebview: (webview: unknown) => void;
  handleWebviewMessage: (msg: unknown) => Promise<void>;
};

describe("ChatPanel async busy states and failure receipts", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let iflowHome: string;

  beforeEach(async () => {
    iflowHome = await mkdtemp(path.join(os.tmpdir(), "iflow-busy-test-"));
    process.env.IFLOW_HOME = iflowHome;
    panel = new ChatPanel(makeContext(), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
  });

  afterEach(async () => {
    await panel.dispose();
    await rm(iflowHome, { recursive: true, force: true });
    await rm(path.join(here, "transcripts"), { recursive: true, force: true });
    delete process.env.IFLOW_HOME;
  });

  it("writeUserSetting 失败时发 warning toast，而不是静默", async () => {
    const toast = vi.spyOn(p.store, "sendToast");
    // The vscode stub's WorkspaceConfiguration has no update() — calling it
    // throws, which is exactly the "write rejected" path under test.
    await p.writeUserSetting("autoTitle", true);
    expect(toast).toHaveBeenCalledWith("warning", "设置写入失败：autoTitle");
  });

  it("webview 消息路由的 rejection 变成 error toast", async () => {
    const toast = vi.spyOn(p.store, "sendToast");
    let listener: ((msg: unknown) => void) | undefined;
    const webview = {
      options: {},
      html: "",
      onDidReceiveMessage: (fn: (msg: unknown) => void) => {
        listener = fn;
        return { dispose: () => {} };
      },
    };
    p.wireWebview(webview);
    p.handleWebviewMessage = () => Promise.reject(new Error("boom"));
    listener!({ type: "ready" });
    await vi.waitFor(() => {
      expect(toast).toHaveBeenCalledWith("error", "操作失败：boom");
    });
  });

  it("模型列表刷新没有端点时如实提示（区分端点不可达 / 无模型）", async () => {
    const toast = vi.spyOn(p.store, "sendToast");
    await p.refreshLiveModels();
    expect(toast).toHaveBeenCalledWith("warning", "尚未配置 API 端点，无法刷新模型列表");
  });

  it("模型列表刷新时端点不可达 → 「刷新失败，仍显示上次结果」", async () => {
    const toast = vi.spyOn(p.store, "sendToast");
    p.queryLiveModelsDetailed = async () => ({ ok: false, reason: "unreachable", message: "ECONNREFUSED" });
    await p.refreshLiveModels();
    expect(toast).toHaveBeenCalledWith("warning", "模型列表刷新失败，仍显示上次结果");
  });

  it("端点可达但返回空列表 → 不谎称刷新失败，说明「未返回任何模型」", async () => {
    const toast = vi.spyOn(p.store, "sendToast");
    p.queryLiveModelsDetailed = async () => ({ ok: true, models: [] });
    await p.refreshLiveModels();
    expect(toast).toHaveBeenCalledWith("warning", "端点未返回任何模型，仍显示上次结果");
  });

  it("审批规则写盘失败时 toast 且保留原规则", async () => {
    const toast = vi.spyOn(p.store, "sendToast");
    p.context.globalState.update = () => Promise.reject(new Error("disk full"));
    await p.saveApprovalPolicy([
      { id: "rule-a", label: "允许读取 src", enabled: true, action: "allow", path: "src/**" },
    ]);
    expect(toast).toHaveBeenCalledWith("warning", "审批规则保存失败，已保留原规则");
    expect(p.approvalRules).toEqual([]);
  });

  function harness(loadSession: () => Promise<void> | void): void {
    p.store.sessionStarted({
      sessionId: "busy-session",
      currentModelId: "model-a",
      modes: { currentModeId: "default", availableModes: [] },
    });
    p.store.userPrompt("first");
    p.store.userPrompt("second");
    p.store.getState().status = "idle";
    p.store.getState().initializing = false;
    p.client = {
      loadSession: vi.fn(async () => loadSession()),
      setMode: vi.fn(async () => ({ success: true })),
      setModel: vi.fn(async () => ({ success: true })),
    };
  }

  async function seedCliHistory(): Promise<void> {
    const file = acpSessionFilePath("busy-session");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        chatHistory: [
          { role: "user", parts: [{ text: "first" }] },
          { role: "model", parts: [{ text: "reply" }] },
          { role: "user", parts: [{ text: "second" }] },
        ],
      }),
      "utf8",
    );
  }

  it("删除消息期间 initializingReason = deleteMessage，结束后清空", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness(() => gate);
    await seedCliHistory();
    const target = p.store.getState().blocks[0]!.id!;
    const running = p.deleteUserMessage(target);
    await vi.waitFor(() => {
      expect(p.store.getState().initializing).toBe(true);
      expect(p.store.getState().initializingReason).toBe("deleteMessage");
    });
    release();
    await running;
    expect(p.store.getState().initializing).toBe(false);
    expect(p.store.getState().initializingReason).toBeNull();
  });

  it("回滚对话期间 initializingReason = rollback", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness(() => gate);
    await seedCliHistory();
    const target = p.store.getState().blocks[0]!.id!;
    const running = p.deleteUserMessage(target, "rollback");
    await vi.waitFor(() => {
      expect(p.store.getState().initializingReason).toBe("rollback");
    });
    release();
    await running;
    expect(p.store.getState().initializingReason).toBeNull();
  });
});
