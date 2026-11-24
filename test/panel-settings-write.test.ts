import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import * as vscode from "vscode";

/**
 * 面板设置写入的回归锁：效率档位（`iflow.efficiencyMode`）与定期整理记忆
 * （`iflow.memoryMaintenanceEnabled`）。
 *
 * 用户反馈切换这两个开关时弹「设置写入失败：efficiencyMode」。根因不在面板
 * 写错了键，而在 VSCode 的写入校验只认**当前窗口已注册的配置 schema**：扩展
 * 就地更新后，新代码跑在旧版本的 schema 上，manifest 里新加的键会抛
 * 「没有注册配置 iflow.x，因此无法写入用户设置」，直到窗口重新加载。
 *
 * 所以这里用与 VSCode 相同的校验（未声明的键一律拒绝写入）驱动面板，锁住
 * 两件事：面板写出的每个键都必须在 package.json 声明（缺声明 = 线上必炸）；
 * 这两个键写入成功、落到用户设置（Global），且不走失败分支。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

interface SettingSchema {
  type?: string;
  default?: unknown;
  enum?: unknown[];
}

const schema = (
  JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    contributes: { configuration: { properties: Record<string, SettingSchema> } };
  }
).contributes.configuration.properties;

interface WriteLog {
  /** 完整键（`iflow.xxx`）→ 写入值。 */
  values: Record<string, unknown>;
  /** 完整键 → ConfigurationTarget。 */
  targets: Record<string, number | undefined>;
  /** 每次 `update()` 尝试的完整键（未注册时面板应完全不调用它）。 */
  attempts: string[];
}

/** 装一份与 VSCode 行为一致的假配置：`update()` 拒绝未在 manifest 声明的键
 * （ERROR_UNKNOWN_KEY），并按 manifest 的 default 回读。`forcedError` 模拟
 * 环境侧失败（settings.json 只读 / JSON 损坏 / Settings Sync 冲突）；
 * `unregistered` 模拟「就地升级后窗口注册表仍是旧 manifest」——这些键在
 * `inspect().defaultValue` 里没有默认层，`update()` 同样被拒。返回还原函数。 */
function installConfig(writes: WriteLog, forcedError?: Error, unregistered: string[] = []): () => void {
  const original = vscode.workspace.getConfiguration;
  (vscode.workspace as unknown as { getConfiguration: unknown }).getConfiguration = (section?: string) => {
    const prefix = section ? `${section}.` : "";
    return {
      get: <T>(key: string, defaultValue?: T): T => {
        const full = `${prefix}${key}`;
        if (full in writes.values) return writes.values[full] as T;
        const declared = schema[full];
        return (declared?.default !== undefined ? (declared.default as T) : defaultValue) as T;
      },
      has: (key: string): boolean => `${prefix}${key}` in schema || `${prefix}${key}` in writes.values,
      inspect: (key: string) => {
        const full = `${prefix}${key}`;
        return {
          key: full,
          defaultValue: unregistered.includes(full) ? undefined : schema[full]?.default,
          globalValue: writes.values[full],
        };
      },
      update: async (key: string, value: unknown, target?: number): Promise<void> => {
        const full = `${prefix}${key}`;
        writes.attempts.push(full);
        if (forcedError) throw forcedError;
        const declared = schema[full];
        if (!declared || unregistered.includes(full)) {
          // VSCode 的原话（ERROR_UNKNOWN_KEY）。面板不做猜测，只把它原样带进
          // 失败 toast，用户据此判断是「扩展版本旧」还是环境侧写入失败。
          throw new Error(`Unable to write to User Settings because ${full} is not a registered configuration.`);
        }
        if (declared.enum && !declared.enum.includes(value)) {
          throw new Error(`Unable to write to User Settings because ${full} is not a valid value.`);
        }
        writes.values[full] = value;
        writes.targets[full] = target;
      },
    };
  };
  return () => {
    (vscode.workspace as unknown as { getConfiguration: unknown }).getConfiguration = original;
  };
}

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

type PanelInternals = {
  store: { sendToast: (level: string, message: string) => number };
  writeUserSetting: (key: string, value: unknown, label?: string) => Promise<boolean>;
  applyPendingSettings: () => Promise<void>;
  handleWebviewMessage: (msg: unknown) => Promise<void>;
};

describe("面板设置写入：效率档位 / 定期整理记忆", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let iflowHome: string;
  let storageDir: string;
  let ctx: vscode.ExtensionContext;
  let writes: WriteLog;
  let restoreConfig: () => void;

  beforeEach(async () => {
    iflowHome = await mkdtemp(path.join(os.tmpdir(), "iflow-settings-write-"));
    process.env.IFLOW_HOME = iflowHome;
    storageDir = await mkdtemp(path.join(os.tmpdir(), "iflow-settings-write-storage-"));
    writes = { values: {}, targets: {}, attempts: [] };
    restoreConfig = installConfig(writes);
    ctx = makeContext(storageDir);
    panel = new ChatPanel(ctx, { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    restoreConfig();
    await panel.dispose();
    await rm(iflowHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    delete process.env.IFLOW_HOME;
  });

  it("两个键都在 manifest 声明（缺声明时 VSCode 直接拒绝写入）", () => {
    expect(schema["iflow.efficiencyMode"]).toMatchObject({ type: "string", enum: ["steady", "turbo"], default: "steady" });
    expect(schema["iflow.memoryMaintenanceEnabled"]).toMatchObject({ type: "boolean", default: false });
  });

  it("setHostSettings 把 efficiencyMode / memoryMaintenanceEnabled 写进用户设置，且不弹失败 toast", async () => {
    const toast = vi.spyOn(p.store, "sendToast");

    await p.handleWebviewMessage({ type: "setHostSettings", efficiencyMode: "turbo", memoryMaintenanceEnabled: true });

    expect(writes.values["iflow.efficiencyMode"]).toBe("turbo");
    expect(writes.values["iflow.memoryMaintenanceEnabled"]).toBe(true);
    expect(writes.targets["iflow.efficiencyMode"]).toBe(vscode.ConfigurationTarget.Global);
    expect(writes.targets["iflow.memoryMaintenanceEnabled"]).toBe(vscode.ConfigurationTarget.Global);
    expect(toast).not.toHaveBeenCalledWith("warning", expect.stringContaining("设置写入失败"));
  });

  it("写两个键直接返回成功，不走失败分支", async () => {
    const toast = vi.spyOn(p.store, "sendToast");

    await expect(p.writeUserSetting("efficiencyMode", "steady")).resolves.toBe(true);
    await expect(p.writeUserSetting("memoryMaintenanceEnabled", false)).resolves.toBe(true);

    expect(writes.values["iflow.efficiencyMode"]).toBe("steady");
    expect(writes.values["iflow.memoryMaintenanceEnabled"]).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it("未注册（就地升级后窗口仍是旧 schema）→ 不抛错、不写盘、暂存并提示重载窗口", async () => {
    restoreConfig();
    restoreConfig = installConfig(writes, undefined, ["iflow.efficiencyMode"]);
    const toast = vi.spyOn(p.store, "sendToast");

    await expect(p.writeUserSetting("efficiencyMode", "turbo")).resolves.toBe(false);

    // 写入根本没有尝试（VSCode 对未注册键的拒绝是确定性的，无需试探）。
    expect(writes.attempts).not.toContain("iflow.efficiencyMode");
    expect(writes.values["iflow.efficiencyMode"]).toBeUndefined();
    expect(toast).toHaveBeenCalledWith(
      "warning",
      expect.stringContaining("已暂存"),
      expect.objectContaining({
        sticky: true,
        action: { actionId: "reload-window", label: "重新加载窗口" },
      }),
    );
    expect(toast).not.toHaveBeenCalledWith("warning", expect.stringContaining("设置写入失败"));
    expect(ctx.globalState.get("iflow.pendingSettingsWrites")).toEqual({ efficiencyMode: "turbo" });
  });

  it("已注册且写入成功 → 清掉同名暂存，不弹失败 toast", async () => {
    await ctx.globalState.update("iflow.pendingSettingsWrites", { efficiencyMode: "steady" });
    const toast = vi.spyOn(p.store, "sendToast");

    await expect(p.writeUserSetting("efficiencyMode", "turbo")).resolves.toBe(true);

    expect(writes.values["iflow.efficiencyMode"]).toBe("turbo");
    expect(ctx.globalState.get("iflow.pendingSettingsWrites")).toEqual({});
    expect(toast).not.toHaveBeenCalled();
  });

  it("toastAction reload-window → 执行 workbench.action.reloadWindow", async () => {
    const exec = vi.spyOn(vscode.commands, "executeCommand");

    await p.handleWebviewMessage({ type: "toastAction", actionId: "reload-window", toastId: 7 });

    expect(exec).toHaveBeenCalledWith("workbench.action.reloadWindow");
  });

  it("applyPendingSettings：已注册的回放一次并清空，未注册的保留", async () => {
    restoreConfig();
    restoreConfig = installConfig(writes, undefined, ["iflow.memoryMaintenanceEnabled"]);
    await ctx.globalState.update("iflow.pendingSettingsWrites", {
      efficiencyMode: "turbo",
      memoryMaintenanceEnabled: true,
    });

    await p.applyPendingSettings();

    expect(writes.values["iflow.efficiencyMode"]).toBe("turbo");
    expect(writes.targets["iflow.efficiencyMode"]).toBe(vscode.ConfigurationTarget.Global);
    expect(writes.values["iflow.memoryMaintenanceEnabled"]).toBeUndefined();
    expect(ctx.globalState.get("iflow.pendingSettingsWrites")).toEqual({ memoryMaintenanceEnabled: true });
  });

  it("环境侧写入被拒（settings.json 只读）时，toast 带出真实错误信息", async () => {
    restoreConfig();
    restoreConfig = installConfig(writes, new Error("EPERM: operation not permitted, open 'settings.json'"));
    const toast = vi.spyOn(p.store, "sendToast");

    await expect(p.writeUserSetting("efficiencyMode", "turbo", "效率模式")).resolves.toBe(false);

    expect(writes.values["iflow.efficiencyMode"]).toBeUndefined();
    expect(toast).toHaveBeenCalledWith(
      "warning",
      "设置写入失败：效率模式（EPERM: operation not permitted, open 'settings.json'）",
    );
  });

  it("面板写出的每个设置键都在 manifest 声明（跨文件回归锁）", () => {
    const source = readFileSync(path.join(root, "src", "panel", "panel.ts"), "utf8");
    const keys = new Set<string>();
    for (const match of source.matchAll(/writes\.push\(\[\s*"([^"]+)"/g)) keys.add(match[1]!);
    for (const match of source.matchAll(/writeUserSetting\("([^"]+)"/g)) keys.add(match[1]!);

    expect(keys.size).toBeGreaterThan(20);
    expect([...keys].filter((key) => !(`iflow.${key}` in schema))).toEqual([]);
  });
});
