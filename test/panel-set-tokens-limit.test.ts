import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import * as vscode from "vscode";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { setConfigOverrides } from "./vscode-stub.js";

/**
 * 方案D：模型热切换成功后再串行推送 `session/set_tokens_limit`。
 *
 * `session/set_model` 只改模型名，不重算 CLI 缓存的 tokensLimit（自动压缩阈值
 * 取自 getTokensLimit()/JR()）。面板必须在 set_model 成功后把用户显式覆盖的
 * 上下文窗口推给 CLI，且 set_model → set_tokens_limit 之间不能并发发 prompt。
 *
 * 只推 source === "user"：内建表 / 兜底值是 UI 估算，推给 CLI 会覆盖 profile
 * 里显式的 tokensLimit（与 spawnEnv 启动兜底同一口径）。
 */
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

type PanelInternals = {
  client: unknown;
  setModel: (modelId: string) => Promise<void>;
  store: {
    getState: () => { sessionId: string | null; currentModelId: string | null };
    sessionStarted: (meta: unknown) => void;
    pushSnapshot: () => void;
  };
};

describe("ChatPanel 热切换同步 CLI tokensLimit (方案D)", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let setTokensLimit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setConfigOverrides({ checkpoints: false, contextWindowOverrides: ["switch-model=256000"] });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-set-tokens-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    setTokensLimit = vi.fn(async () => ({ success: true }));
    p.client = {
      setModel: vi.fn(async (_sid: string, modelId: string) => ({ success: true, currentModelId: modelId })),
      setTokensLimit,
    };
    p.store.sessionStarted({ sessionId: "s-switch", currentModelId: "old-model" });
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setConfigOverrides({});
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("setModel 成功后串行推送用户覆盖的窗口", async () => {
    await p.setModel("switch-model");
    expect(setTokensLimit).toHaveBeenCalledTimes(1);
    expect(setTokensLimit).toHaveBeenCalledWith("s-switch", 256000);
  });

  it("非 user 覆盖（内建表 / 兜底）不推送，避免覆盖 profile tokensLimit", async () => {
    setConfigOverrides({ checkpoints: false, contextWindowOverrides: ["another-model=999999"] });
    await p.setModel("switch-model");
    expect(setTokensLimit).not.toHaveBeenCalled();
  });

  it("setTokensLimit 失败时告警并 pushSnapshot，不静默成功", async () => {
    const pushSnapshot = vi.spyOn(p.store, "pushSnapshot");
    setTokensLimit.mockRejectedValueOnce(new Error("methodNotFound"));
    await p.setModel("switch-model");
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("切换模型后同步上下文长度失败"),
    );
    expect(pushSnapshot).toHaveBeenCalled();
  });

  it("串行门控：setTokensLimit 未 settle 前 setModel 不返回（禁止窗口期并发 prompt）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setTokensLimit.mockImplementationOnce(() => gate as never);
    let settled = false;
    const running = p.setModel("switch-model").then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    release();
    await running;
    expect(settled).toBe(true);
  });
});
