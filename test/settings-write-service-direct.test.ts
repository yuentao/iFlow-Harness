import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as vscode from "vscode";
import {
  SettingsWriteService,
  type SettingsWriteServiceDeps,
} from "../src/panel/settings-write-service.js";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";

/**
 * SettingsWriteService 的直测 + panel 薄委托接线锁。
 *
 * 这里不构造 ChatPanel 就能驱动服务：配置 / globalState / toast / log 全部由
 * 窄 deps 回调注入。重点锁住两条用户纪律：
 *   1. 写盘只走单键 `getConfiguration("iflow").update(key, value, Global)`，
 *      绝不整文件写回（attempts 里只有键名与目标，没有文件写入接口）；
 *   2. 「设置写入失败」toast 必须原样携带真实的 VSCode 拒绝原因。
 */

const here = path.dirname(fileURLToPath(import.meta.url));

interface UpdateAttempt {
  key: string;
  value: unknown;
  target: unknown;
}
interface ToastCall {
  level: string;
  message: string;
  opts?: { sticky?: boolean; action?: { actionId: string; label: string } };
}

function harness(options: { unregistered?: string[]; updateError?: Error } = {}) {
  const unregistered = new Set(options.unregistered ?? []);
  const stash = new Map<string, unknown>();
  const values = new Map<string, unknown>();
  const attempts: UpdateAttempt[] = [];
  const toasts: ToastCall[] = [];
  const warns: string[] = [];

  const config = {
    get: <T>(key: string, defaultValue?: T): T =>
      (values.has(key) ? values.get(key) as T : defaultValue as T),
    inspect: (key: string) => ({
      key,
      defaultValue: unregistered.has(key) ? undefined : ("registered" as unknown),
      globalValue: values.get(key),
    }),
    update: async (key: string, value: unknown, target?: unknown): Promise<void> => {
      attempts.push({ key, value, target });
      if (options.updateError) throw options.updateError;
      values.set(key, value);
    },
  };
  const globalState = {
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      (stash.has(key) ? stash.get(key) as T : defaultValue),
    update: async (key: string, value: unknown): Promise<void> => {
      stash.set(key, value);
    },
  };
  let currentGlobalState = globalState;
  const deps: SettingsWriteServiceDeps = {
    getConfiguration: (section) => {
      expect(section).toBe("iflow");
      return config as unknown as vscode.WorkspaceConfiguration;
    },
    getGlobalState: () => currentGlobalState as unknown as vscode.Memento,
    sendToast: (level, message, opts) => {
      toasts.push({ level, message, opts });
      return toasts.length;
    },
    warn: (message) => warns.push(message),
  };
  return {
    service: new SettingsWriteService(deps),
    stash,
    values,
    attempts,
    toasts,
    warns,
    unregistered,
    setGlobalState: (next: typeof globalState) => {
      currentGlobalState = next;
    },
  };
}

describe("SettingsWriteService 直测", () => {
  it("成功写入：只做单键 Global update，不碰暂存、不写整文件", async () => {
    const h = harness();

    await expect(h.service.writeUserSetting("efficiencyMode", "turbo")).resolves.toBe(true);

    expect(h.attempts).toEqual([
      { key: "efficiencyMode", value: "turbo", target: vscode.ConfigurationTarget.Global },
    ]);
    expect(h.values.get("efficiencyMode")).toBe("turbo");
    // 成功写入不产生任何 globalState 暂存写入，更没有整文件写回路径。
    expect(h.stash.has("iflow.pendingSettingsWrites")).toBe(false);
    expect(h.toasts).toEqual([]);
  });

  it("写失败：toast 原样带出真实错误原因，stderr 也记录，暂存仍为空", async () => {
    const detail = "EPERM: operation not permitted, open 'settings.json'";
    const h = harness({ updateError: new Error(detail) });

    await expect(h.service.writeUserSetting("efficiencyMode", "turbo", "效率模式")).resolves.toBe(false);

    expect(h.values.has("efficiencyMode")).toBe(false);
    expect(h.stash.has("iflow.pendingSettingsWrites")).toBe(false);
    expect(h.toasts).toEqual([
      { level: "warning", message: `设置写入失败：效率模式（${detail}）`, opts: undefined },
    ]);
    expect(h.warns).toEqual([`failed to update efficiencyMode: ${detail}`]);
  });

  it("未注册键：不尝试 update，暂存到 globalState，并提示重载窗口", async () => {
    const h = harness({ unregistered: ["efficiencyMode"] });

    await expect(h.service.writeUserSetting("efficiencyMode", "turbo")).resolves.toBe(false);

    expect(h.attempts).toEqual([]);
    expect(h.stash.get("iflow.pendingSettingsWrites")).toEqual({ efficiencyMode: "turbo" });
    expect(h.toasts[0]?.level).toBe("warning");
    expect(h.toasts[0]?.message).toContain("已暂存并立即生效");
    expect(h.toasts[0]?.opts).toEqual({
      sticky: true,
      action: { actionId: "reload-window", label: "重新加载窗口" },
    });
    expect(h.toasts[0]?.message).not.toContain("设置写入失败");
  });

  it("读取时暂存层优先，且 0 / false / 空串用 hasOwnProperty 不被当缺失", async () => {
    const h = harness();
    h.stash.set("iflow.pendingSettingsWrites", { zero: 0, flag: false, text: "" });
    h.values.set("zero", 35);
    h.values.set("flag", true);
    h.values.set("text", "盘上的值");

    expect(h.service.readUserSetting("zero", 35)).toBe(0);
    expect(h.service.readUserSetting("flag", true)).toBe(false);
    expect(h.service.readUserSetting("text", "fallback")).toBe("");
    expect(h.service.readUserSetting("missing", "fallback")).toBe("fallback");
  });

  it("applyPendingSettings：只回放已注册键，Global 落盘后清暂存，未注册保留", async () => {
    const h = harness({ unregistered: ["stale"] });
    h.stash.set("iflow.pendingSettingsWrites", { fresh: "turbo", stale: "block" });

    await h.service.applyPendingSettings();

    expect(h.attempts).toEqual([
      { key: "fresh", value: "turbo", target: vscode.ConfigurationTarget.Global },
    ]);
    expect(h.stash.get("iflow.pendingSettingsWrites")).toEqual({ stale: "block" });
  });

  it("applyPendingSettings 回放失败：保留暂存并 warn 带真实错误，不误报成功", async () => {
    const detail = "Settings Sync conflict";
    const h = harness({ updateError: new Error(detail) });
    h.stash.set("iflow.pendingSettingsWrites", { fresh: "turbo" });

    await h.service.applyPendingSettings();

    expect(h.stash.get("iflow.pendingSettingsWrites")).toEqual({ fresh: "turbo" });
    expect(h.warns).toEqual([`failed to apply stashed setting fresh: ${detail}`]);
  });

  it("deps 在调用时读取：构造后替换 globalState，服务立刻读到新对象而非过期快照", () => {
    const h = harness();
    h.stash.set("iflow.pendingSettingsWrites", { key: "first" });
    expect(h.service.pendingSettingsWrites()).toEqual({ key: "first" });

    const second = new Map<string, unknown>([["iflow.pendingSettingsWrites", { key: "second" }]]);
    h.setGlobalState({
      get: <T>(key: string, defaultValue?: T): T | undefined =>
        (second.has(key) ? second.get(key) as T : defaultValue),
      update: async (key: string, value: unknown): Promise<void> => {
        second.set(key, value);
      },
    });

    expect(h.service.pendingSettingsWrites()).toEqual({ key: "second" });
  });
});

describe("ChatPanel 设置写入薄委托接线锁", () => {
  let panel: ChatPanel;
  let iflowHome: string;
  let storageDir: string;

  beforeEach(async () => {
    iflowHome = await mkdtemp(path.join(os.tmpdir(), "iflow-settings-service-"));
    process.env.IFLOW_HOME = iflowHome;
    storageDir = await mkdtemp(path.join(os.tmpdir(), "iflow-settings-service-storage-"));
    const noop = () => ({ dispose: () => {} });
    const watchers = [
      { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
      { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
    ] as NonNullable<PanelServices["watchers"]>;
    const store = new Map<string, unknown>();
    const state = {
      get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? store.get(key) as T : defaultValue as T),
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
    const ctx = {
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
    panel = new ChatPanel(ctx, { workspaceRoot: here, watchers });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    await rm(iflowHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    delete process.env.IFLOW_HOME;
  });

  it("panel.writeUserSetting / readUserSetting / readHostSetting 都转发到服务", async () => {
    const service = (panel as unknown as { settingsWriteService: SettingsWriteService }).settingsWriteService;
    const writeSpy = vi.spyOn(service, "writeUserSetting").mockResolvedValue(true);
    const readSpy = vi.spyOn(service, "readUserSetting").mockReturnValue(false);
    const p = panel as unknown as {
      writeUserSetting: (key: string, value: unknown, label?: string) => Promise<boolean>;
      readUserSetting: <T>(key: string, fallback: T) => T;
      readHostSetting: <T>(key: string, fallback: T) => T;
    };

    await expect(p.writeUserSetting("autoTitle", true, "自动标题")).resolves.toBe(true);
    expect(writeSpy).toHaveBeenCalledWith("autoTitle", true, "自动标题");

    expect(p.readUserSetting("warmStart", true)).toBe(false);
    expect(readSpy).toHaveBeenCalledWith("warmStart", true);
    expect(p.readHostSetting("autoOpenPanel", false)).toBe(false);
    expect(readSpy).toHaveBeenCalledWith("autoOpenPanel", false);
  });

  it("panel.applyPendingSettings 转发到服务", async () => {
    const service = (panel as unknown as { settingsWriteService: SettingsWriteService }).settingsWriteService;
    const spy = vi.spyOn(service, "applyPendingSettings").mockResolvedValue();
    const p = panel as unknown as { applyPendingSettings: () => Promise<void> };

    await p.applyPendingSettings();
    expect(spy).toHaveBeenCalledOnce();
  });
});
