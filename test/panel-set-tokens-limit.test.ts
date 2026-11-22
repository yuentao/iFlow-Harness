import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import * as vscode from "vscode";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readCliSettings } from "../src/acp/models-query.js";
import { resolveCliTokensLimit } from "../src/acp/cli-tokens-limit.js";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { setConfigOverrides } from "./vscode-stub.js";

/**
 * 方案D：模型热切换成功后再串行推送 `session/set_tokens_limit`。
 *
 * `session/set_model` 只改模型名，不重算 CLI 缓存的 tokensLimit（自动压缩阈值
 * 取自 getTokensLimit()/JR()）。面板必须在 set_model 成功后把**该模型的有效
 * 窗口**推给 CLI，且 set_model → set_tokens_limit 之间不能并发发 prompt。
 *
 * 窗口口径与 spawnEnv 完全一致（同一个 resolver）：user override → active
 * profile → settings 顶层 → 内建对照表 → 无依据不推。因此这里既推用户显式
 * 覆写，也推内建表命中的窗口（CLI 自己的表缺现代模型 id，正是自动压缩误触发
 * 的根因）；只有**完全无依据**时才什么都不推。
 *
 * Hermetic：内核 settings.json 的位置由 `IFLOW_HOME` 决定（内核 loader 的既有
 * 约定），测试把它指向临时目录，于是断言绝不依赖开发机上的 ~/.iflow。
 * 这里刻意**不用 vi.mock** —— `--no-isolate` 下模块 mock 会跨测试文件泄漏。
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
  const originalIflowHome = process.env.IFLOW_HOME;

  beforeEach(() => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-set-tokens-"));
    // 内核 settings.json 指向临时目录：默认没有任何 profile / 顶层 tokensLimit。
    process.env.IFLOW_HOME = storageDir;
    setConfigOverrides({ checkpoints: false, contextWindowOverrides: ["switch-model=256000"] });
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
    if (originalIflowHome === undefined) delete process.env.IFLOW_HOME;
    else process.env.IFLOW_HOME = originalIflowHome;
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("hermetic：内核 settings 指向临时 IFLOW_HOME，断言不依赖开发机的 ~/.iflow/settings.json", () => {
    expect(readCliSettings()).toBeNull();
    // 面板真实使用的那条解析路径同样看不到内核 settings。
    expect(resolveCliTokensLimit({ modelId: "totally-unknown-model" })).toEqual({
      limit: undefined,
      source: undefined,
    });
  });

  it("setModel 成功后串行推送用户显式覆写的窗口", async () => {
    await p.setModel("switch-model");
    expect(setTokensLimit).toHaveBeenCalledTimes(1);
    expect(setTokensLimit).toHaveBeenCalledWith("s-switch", 256000);
  });

  it("内建对照表命中的窗口同样推送（CLI 自己的表缺这个模型，只能由宿主补位）", async () => {
    setConfigOverrides({ checkpoints: false, contextWindowOverrides: [] });
    await p.setModel("gpt-4o");
    expect(setTokensLimit).toHaveBeenCalledTimes(1);
    expect(setTokensLimit).toHaveBeenCalledWith("s-switch", 128000);
  });

  it("active profile 的 tokensLimit 也推送（profile 优先于内建表）", async () => {
    fs.writeFileSync(
      path.join(storageDir, "settings.json"),
      JSON.stringify({ currentApiProfile: "main", apiProfiles: { main: { tokensLimit: 128000 } } }),
      "utf8",
    );
    setConfigOverrides({ checkpoints: false, contextWindowOverrides: [] });
    await p.setModel("gpt-4o");
    expect(setTokensLimit).toHaveBeenCalledTimes(1);
    expect(setTokensLimit).toHaveBeenCalledWith("s-switch", 128000);
  });

  it("任何一档都没有依据 → 不推送，也不调 session/set_tokens_limit", async () => {
    setConfigOverrides({ checkpoints: false, contextWindowOverrides: ["another-model=999999"] });
    await p.setModel("totally-unknown-model");
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
    // 等推送真的发出（而不是靠固定 sleep 猜时序）：此刻 setModel 必须仍未返回。
    await vi.waitFor(() => {
      expect(setTokensLimit).toHaveBeenCalledTimes(1);
    });
    expect(settled).toBe(false);
    release();
    await running;
    expect(settled).toBe(true);
  });
});