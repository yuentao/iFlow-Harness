/**
 * 占用条与 CLI 的**同一个**窗口 resolver（2026-11-22「一个模型两个窗口」修复）。
 *
 * 回归背景：此前有两条并行的窗口解析路径——
 *   · 推给 CLI（`IFLOW_TOKENS_LIMIT` / `session/set_tokens_limit`）：
 *     user override → active profile → settings 顶层 → 内建表 → 无依据不推
 *   · webview 占用条（宿主算好后随 usage 快照下发）：
 *     user override → 内建表 → 兜底估算
 * 中间那两档（profile / settings 顶层）占用条这边没有，于是同一个模型在面板
 * 显示的窗口与推给 CLI 的窗口会分叉：
 *     auto/deepseek-v4.1-flash + profile tokensLimit=128000
 *       → CLI  : 128000（profile 档）
 *       → 占用条: 1000000（内建表档）
 *
 * 现在两条路径都走 `shared/context-window.ts` 的 `resolveContextWindowAuthority`。
 * 本文件的**核心断言**是「同一个输入喂给占用条路径与 CLI 路径，两边输出必须
 * 相等」——这条护栏就是防止分叉复发的回归网。
 *
 * Hermetic：内核 settings.json 的位置由 `IFLOW_HOME` 决定（内核 loader 的既有
 * 约定），测试把它指向临时目录，断言绝不依赖开发机上的 ~/.iflow/settings.json。
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel, type PanelServices } from "../src/panel/panel.js";
import {
  invalidateKernelTokensLimitsCache,
  resolveCliTokensLimit,
  tokensLimitEnvFromSettings,
} from "../src/acp/cli-tokens-limit.js";
import { parseContextWindowOverrides, resolveContextWindowAuthority } from "../shared/context-window.js";
import type { UsageContext } from "../shared/session-state.js";
import { setConfigOverrides } from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const mockAgent = path.join(here, "mock-acp-agent.mjs");

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
  store: {
    getState: () => { currentModelId?: string | null };
    sessionMeta: (m: { currentModelId?: string }) => void;
  };
  usageOverridesCache: unknown;
  resolveUsageContext: () => UsageContext;
};

describe("占用条与 CLI 共用同一窗口 resolver", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let homeDir: string;
  const originalIflowHome = process.env.IFLOW_HOME;

  /** 写内核 settings.json（活动 profile 档 / settings 顶层档）。 */
  function writeKernelSettings(content: Record<string, unknown>): void {
    fs.writeFileSync(path.join(homeDir, "settings.json"), JSON.stringify(content), "utf8");
    // 显式失效：mtime 缓存理论上能覆盖，但同毫秒同尺寸的写入必须被看见。
    invalidateKernelTokensLimitsCache();
  }

  /** 占用条侧解析出来的窗口（宿主算好后随 usage 快照下发）。 */
  function barWindow(): { window: number | null; source: string | null } {
    const ctx = p.resolveUsageContext();
    return { window: ctx.contextWindow, source: ctx.windowSource ?? null };
  }

  beforeEach(() => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-win-unified-storage-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-win-unified-home-"));
    process.env.IFLOW_HOME = homeDir;
    invalidateKernelTokensLimitsCache();
    setConfigOverrides({ nodePath: process.execPath, contextWindowOverrides: [] });
    panel = new ChatPanel(makeContext(storageDir), {
      entryOverride: mockAgent,
      workspaceRoot: here,
      watchers: makeWatchers(),
    });
    p = panel as unknown as PanelInternals;
  });

  afterEach(async () => {
    await panel.dispose();
    setConfigOverrides({});
    invalidateKernelTokensLimitsCache();
    if (originalIflowHome === undefined) delete process.env.IFLOW_HOME;
    else process.env.IFLOW_HOME = originalIflowHome;
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /** 设置当前模型 + 覆写表，并让面板的覆写缓存失效。 */
  function useModel(modelId: string, overrideRows: string[] = []): void {
    setConfigOverrides({ nodePath: process.execPath, contextWindowOverrides: overrideRows });
    p.usageOverridesCache = null;
    p.store.sessionMeta({ currentModelId: modelId });
  }

  it("分叉场景闭合：profile 档 128000 压过内建表的 1,000,000，两侧完全一致", () => {
    writeKernelSettings({ currentApiProfile: "main", apiProfiles: { main: { tokensLimit: 128000 } } });
    // 内建表命中 deepseek-v4 → 1,000,000；profile 档是 128,000。
    useModel("auto/deepseek-v4.1-flash");

    const cli = resolveCliTokensLimit({ modelId: "auto/deepseek-v4.1-flash", overrides: {} });
    expect(cli).toEqual({ limit: 128000, source: "profile" });
    expect(tokensLimitEnvFromSettings({ modelId: "auto/deepseek-v4.1-flash", overrides: {} })).toEqual({
      IFLOW_TOKENS_LIMIT: "128000",
    });

    const bar = barWindow();
    expect(bar.window).toBe(128000);
    expect(bar.source).toBe("profile");
    // 护栏：占用条 == CLI。
    expect(bar.window).toBe(cli.limit);
  });

  it("profile 未设 tokensLimit + settings 顶层有 → settings 档，两侧一致", () => {
    writeKernelSettings({ currentApiProfile: "main", apiProfiles: { main: {} }, tokensLimit: 200000 });
    useModel("auto/deepseek-v4.1-flash");

    const cli = resolveCliTokensLimit({ modelId: "auto/deepseek-v4.1-flash", overrides: {} });
    expect(cli).toEqual({ limit: 200000, source: "settings" });
    const bar = barWindow();
    expect(bar.window).toBe(200000);
    expect(bar.source).toBe("settings");
    expect(bar.window).toBe(cli.limit);
  });

  it("全不命中 → 两侧都没有窗口：CLI 不推 env，占用条不显示分母", () => {
    writeKernelSettings({});
    useModel("totally-unknown-model");

    const cli = resolveCliTokensLimit({ modelId: "totally-unknown-model", overrides: {} });
    expect(cli.limit).toBeUndefined();
    expect(cli.source).toBeUndefined();
    const env = tokensLimitEnvFromSettings({ modelId: "totally-unknown-model", overrides: {} });
    expect(env).toEqual({});
    expect("IFLOW_TOKENS_LIMIT" in env).toBe(false);

    const bar = barWindow();
    // 宿主没有依据 ⇒ 不给猜测的分母（旧实现会给 32,768 的兜底估算，那正是
    // 「一个模型两个窗口」的残留）。
    expect(bar.window).toBeNull();
    expect(bar.source).toBeNull();
    expect(bar.window).toBe(cli.limit ?? null);
  });

  it("user override 命中 → 最高优先级，两侧一致", () => {
    writeKernelSettings({ currentApiProfile: "main", apiProfiles: { main: { tokensLimit: 128000 } } });
    const overrides = parseContextWindowOverrides(["deepseek-v4.1-flash=960000"]);
    useModel("auto/deepseek-v4.1-flash", ["deepseek-v4.1-flash=960000"]);

    const cli = resolveCliTokensLimit({ modelId: "auto/deepseek-v4.1-flash", overrides });
    expect(cli).toEqual({ limit: 960000, source: "user" });
    const bar = barWindow();
    expect(bar.window).toBe(960000);
    expect(bar.source).toBe("user");
    expect(bar.window).toBe(cli.limit);
  });

  it("只有内建表命中 → 内建表档，两侧一致", () => {
    writeKernelSettings({});
    useModel("auto/deepseek-v4.1-flash");

    const cli = resolveCliTokensLimit({ modelId: "auto/deepseek-v4.1-flash", overrides: {} });
    expect(cli).toEqual({ limit: 1_000_000, source: "builtin-table" });
    const bar = barWindow();
    expect(bar.window).toBe(1_000_000);
    expect(bar.source).toBe("builtin-table");
    expect(bar.window).toBe(cli.limit);
  });

  it("模型 id 归一化：auto/ 前缀与裸 id 命中同一条 override，两侧一致", () => {
    writeKernelSettings({});
    const overrides = parseContextWindowOverrides(["deepseek-v4.1-flash=960000"]);

    useModel("auto/deepseek-v4.1-flash", ["deepseek-v4.1-flash=960000"]);
    const withPrefix = barWindow();
    useModel("deepseek-v4.1-flash", ["deepseek-v4.1-flash=960000"]);
    const withoutPrefix = barWindow();

    expect(withPrefix.window).toBe(960000);
    expect(withoutPrefix.window).toBe(withPrefix.window);
    expect(
      resolveCliTokensLimit({ modelId: "deepseek-v4.1-flash", overrides }).limit,
    ).toBe(withPrefix.window);
  });

  it("没有模型 id → 占用条没有分母（profile / settings 档是端点级别的上限，不是某个模型的窗口）", () => {
    writeKernelSettings({ currentApiProfile: "main", apiProfiles: { main: { tokensLimit: 128000 } } });
    useModel("auto/deepseek-v4.1-flash");
    p.store.getState().currentModelId = null;

    const bar = barWindow();
    expect(bar.window).toBeNull();
    expect(bar.source).toBeNull();
  });
});

describe("resolveContextWindowAuthority — 五档权威链（纯逻辑）", () => {
  it("user > profile > settings > builtin-table > 无依据", () => {
    const overrides = parseContextWindowOverrides(["deepseek-v4.1-flash=960000"]);
    // 1) user 压过其余所有档
    expect(
      resolveContextWindowAuthority({
        modelId: "auto/deepseek-v4.1-flash",
        overrides,
        profileTokensLimit: 128000,
        settingsTokensLimit: 200000,
      }),
    ).toEqual({ limit: 960000, source: "user" });
    // 2) profile 压过 settings 与内建表
    expect(
      resolveContextWindowAuthority({
        modelId: "auto/deepseek-v4.1-flash",
        overrides: {},
        profileTokensLimit: 128000,
        settingsTokensLimit: 200000,
      }),
    ).toEqual({ limit: 128000, source: "profile" });
    // 3) settings 压过内建表
    expect(
      resolveContextWindowAuthority({
        modelId: "auto/deepseek-v4.1-flash",
        overrides: {},
        settingsTokensLimit: 200000,
      }),
    ).toEqual({ limit: 200000, source: "settings" });
    // 4) 内建表
    expect(
      resolveContextWindowAuthority({ modelId: "auto/deepseek-v4.1-flash", overrides: {} }),
    ).toEqual({ limit: 1_000_000, source: "builtin-table" });
    // 5) 全不命中 → undefined（绝不猜测）
    expect(resolveContextWindowAuthority({ modelId: "totally-unknown-model" })).toEqual({
      limit: undefined,
      source: undefined,
    });
  });

  it("非正整数 / 非数字一律视为缺失", () => {
    expect(
      resolveContextWindowAuthority({
        modelId: "unknown-model",
        profileTokensLimit: -1,
        settingsTokensLimit: "200000",
      }),
    ).toEqual({ limit: undefined, source: undefined });
  });
});
