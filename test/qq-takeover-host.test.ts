/**
 * 底部输入区「远程接续」开关（宿主侧）：
 *
 * - start 在当前会话设内存暂停门 + 常驻只读 toast + 回推 qqTakeoverState；
 * - stop 清门 + 取消在跑的 QQ 主会话注入 + dismiss toast + 回推 false；
 * - 被接管的会话不再接受 QQ 消息注入（机器人仍服务其它会话）；
 * - webview 重连 / dispose 一律清门，状态不持久化。
 */
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeContext(storageDir: string): vscode.ExtensionContext {
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
    storageUri: { fsPath: storageDir },
    globalStorageUri: { fsPath: storageDir },
    storagePath: storageDir,
    globalStoragePath: storageDir,
    asAbsolutePath: (p: string) => path.join(here, p),
  } as unknown as vscode.ExtensionContext;
}

function makeWatchers(): NonNullable<PanelServices["watchers"]> {
  const noop = () => ({ dispose: () => {} });
  return [
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
  ];
}

type Internals = {
  handleWebviewMessage: (msg: unknown) => Promise<void>;
  injectQqMainTurn: (input: unknown) => Promise<{ injected: boolean; reason?: string }>;
  isQqTakeoverActiveFor: (sessionId: string | null) => boolean;
  cancelAllQqMainInjections: () => void;
  pushQqState: () => void;
  store: {
    getState: () => { sessionId: string | null; [key: string]: unknown };
    sendToast: (level: string, message: string, opts?: unknown) => number;
    dismissToast: (id: number) => void;
  };
  postToWebview: (msg: unknown) => void;
  qqTakeoverActive: boolean;
  qqTakeoverSessionId: string | null;
  qqTakeoverToastId: number | null;
};

describe("ChatPanel 远程接续开关", () => {
  let panel: ChatPanel;
  let p: Internals;
  let iflowHome: string;
  let storageDir: string;

  beforeEach(async () => {
    iflowHome = await mkdtemp(path.join(os.tmpdir(), "iflow-takeover-home-"));
    process.env.IFLOW_HOME = iflowHome;
    storageDir = await mkdtemp(path.join(os.tmpdir(), "iflow-takeover-store-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as Internals;
    const realGetState = p.store.getState.bind(p.store);
    vi.spyOn(p.store, "getState").mockImplementation(() => ({ ...realGetState(), sessionId: "s1" }) as never);
    vi.spyOn(p, "postToWebview").mockImplementation(() => {});
    vi.spyOn(p, "pushQqState").mockImplementation(() => {});
  });

  afterEach(async () => {
    await panel.dispose();
    await rm(iflowHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    delete process.env.IFLOW_HOME;
    vi.restoreAllMocks();
  });

  it("start 设当前会话暂停门 + 发常驻只读 toast + 回推 active=true", async () => {
    const toast = vi.spyOn(p.store, "sendToast");
    await p.handleWebviewMessage({ type: "qqTakeover", action: "start" });

    expect(p.qqTakeoverActive).toBe(true);
    expect(p.qqTakeoverSessionId).toBe("s1");
    expect(p.isQqTakeoverActiveFor("s1")).toBe(true);
    expect(p.isQqTakeoverActiveFor("other-session")).toBe(false);
    expect(toast).toHaveBeenCalledWith("info", "远程接管中…", { persistent: true, displayOnly: true });
    expect(p.postToWebview).toHaveBeenCalledWith({ type: "qqTakeoverState", active: true });
  });

  it("stop 清门 + 取消在跑的 QQ 注入 + dismiss toast + 回推 active=false", async () => {
    await p.handleWebviewMessage({ type: "qqTakeover", action: "start" });
    const toastId = p.qqTakeoverToastId!;
    const cancel = vi.spyOn(p, "cancelAllQqMainInjections");
    const dismiss = vi.spyOn(p.store, "dismissToast");

    await p.handleWebviewMessage({ type: "qqTakeover", action: "stop" });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(p.qqTakeoverActive).toBe(false);
    expect(p.qqTakeoverSessionId).toBeNull();
    expect(dismiss).toHaveBeenCalledWith(toastId);
    expect(p.postToWebview).toHaveBeenCalledWith({ type: "qqTakeoverState", active: false });
  });

  it("被接管的会话不再注入 QQ 消息（机器人仍可服务其它会话）", async () => {
    await p.handleWebviewMessage({ type: "qqTakeover", action: "start" });

    // 最小输入即可：暂停门在方法最前面短路，不会读取 task 字段。
    const result = await p.injectQqMainTurn({ task: { taskId: "t1" } });
    expect(result.injected).toBe(false);
    expect(result.reason).toContain("远程接续");

    // 门是会话级的：切到别的会话时同一方法不会因这条门被挡住（这里只验证判定）。
    expect(p.isQqTakeoverActiveFor("another-session")).toBe(false);
  });

  it("webview 重连（ready）即失效：清门并撤掉常驻 toast", async () => {
    await p.handleWebviewMessage({ type: "qqTakeover", action: "start" });
    const toastId = p.qqTakeoverToastId!;
    const dismiss = vi.spyOn(p.store, "dismissToast");
    vi.spyOn(p.store, "resync").mockImplementation(() => {});
    vi.spyOn(p.store, "pushSnapshot").mockImplementation(() => {});

    await p.handleWebviewMessage({ type: "ready" });

    expect(p.qqTakeoverActive).toBe(false);
    expect(dismiss).toHaveBeenCalledWith(toastId);
    expect(p.postToWebview).toHaveBeenCalledWith({ type: "qqTakeoverState", active: false });
  });

  it("dispose 清门，重启后不遗留接管态", async () => {
    await p.handleWebviewMessage({ type: "qqTakeover", action: "start" });
    const toastId = p.qqTakeoverToastId!;
    const dismiss = vi.spyOn(p.store, "dismissToast");

    await panel.dispose();

    expect(p.qqTakeoverActive).toBe(false);
    expect(p.qqTakeoverSessionId).toBeNull();
    expect(dismiss).toHaveBeenCalledWith(toastId);
  });
});
