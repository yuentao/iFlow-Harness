import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import * as vscode from "vscode";
import { setUnregisteredConfigKeys, getUnregisteredConfigKeys } from "./vscode-stub.js";

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
  /** Old-manifest view: the explicit list of this fake plus whatever the test
   * marked through `setUnregisteredConfigKeys` (short or `iflow.`-prefixed). */
  const isUnregistered = (full: string): boolean => {
    const shared = getUnregisteredConfigKeys();
    return (
      unregistered.includes(full)
      || shared.includes(full)
      || shared.includes(full.replace(/^iflow\./, ""))
    );
  };
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
          defaultValue: isUnregistered(full) ? undefined : schema[full]?.default,
          globalValue: writes.values[full],
        };
      },
      update: async (key: string, value: unknown, target?: number): Promise<void> => {
        const full = `${prefix}${key}`;
        writes.attempts.push(full);
        if (forcedError) throw forcedError;
        const declared = schema[full];
        if (!declared || isUnregistered(full)) {
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
  postHostSettings: () => void;
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
    setUnregisteredConfigKeys([]);
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
    setUnregisteredConfigKeys([]);
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

  it("两个新键都未注册：setHostSettings 暂存两值，且不弹失败 toast", async () => {
    setUnregisteredConfigKeys(["efficiencyMode", "memoryMaintenanceEnabled"]);
    const toast = vi.spyOn(p.store, "sendToast");

    await p.handleWebviewMessage({ type: "setHostSettings", efficiencyMode: "turbo", memoryMaintenanceEnabled: true });

    expect(writes.values["iflow.efficiencyMode"]).toBeUndefined();
    expect(writes.values["iflow.memoryMaintenanceEnabled"]).toBeUndefined();
    expect(ctx.globalState.get("iflow.pendingSettingsWrites")).toEqual({
      efficiencyMode: "turbo",
      memoryMaintenanceEnabled: true,
    });
    expect(toast).not.toHaveBeenCalledWith("warning", expect.stringContaining("设置写入失败"));
    expect(toast).toHaveBeenCalledWith(
      "warning",
      expect.stringContaining("已暂存并立即生效"),
      expect.objectContaining({ action: { actionId: "reload-window", label: "重新加载窗口" } }),
    );
  });

  it("postHostSettings 读到暂存值（未落盘也不弹回旧值）", async () => {
    setUnregisteredConfigKeys(["efficiencyMode", "memoryMaintenanceEnabled"]);
    await p.handleWebviewMessage({ type: "setHostSettings", efficiencyMode: "turbo", memoryMaintenanceEnabled: true });

    const posted: Array<Record<string, unknown>> = [];
    vi.spyOn(
      panel as unknown as { postToWebview: (m: unknown) => void },
      "postToWebview",
    ).mockImplementation((message) => {
      posted.push(message as Record<string, unknown>);
    });
    p.postHostSettings();

    const hostSettings = posted.find((message) => message.type === "hostSettings");
    expect(hostSettings?.efficiencyMode).toBe("turbo");
    expect(hostSettings?.memoryMaintenanceEnabled).toBe(true);
  });

  it("重载窗口后（键重新注册）applyPendingSettings 以 Global 落盘并清空暂存", async () => {
    await ctx.globalState.update("iflow.pendingSettingsWrites", {
      efficiencyMode: "turbo",
      memoryMaintenanceEnabled: true,
    });
    setUnregisteredConfigKeys([]);

    await p.applyPendingSettings();

    expect(writes.values["iflow.efficiencyMode"]).toBe("turbo");
    expect(writes.values["iflow.memoryMaintenanceEnabled"]).toBe(true);
    expect(writes.targets["iflow.efficiencyMode"]).toBe(vscode.ConfigurationTarget.Global);
    expect(writes.targets["iflow.memoryMaintenanceEnabled"]).toBe(vscode.ConfigurationTarget.Global);
    expect(ctx.globalState.get("iflow.pendingSettingsWrites")).toEqual({});
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
    // 已注册键的真实写入失败不得落进「暂存」分支。
    expect(ctx.globalState.get("iflow.pendingSettingsWrites") ?? {}).toEqual({});
    expect(toast).toHaveBeenCalledWith(
      "warning",
      "设置写入失败：效率模式（EPERM: operation not permitted, open 'settings.json'）",
    );
  });

  it("postHostSettings 读到暂存的 memoryMaintenanceEnabled: false（不弹回盘上的 true）", async () => {
    setUnregisteredConfigKeys(["memoryMaintenanceEnabled"]);
    // 盘上仍是上一次成功写入的 true —— 旧读法（裸 config.get）会让 UI 弹回 true。
    writes.values["iflow.memoryMaintenanceEnabled"] = true;

    await expect(p.writeUserSetting("memoryMaintenanceEnabled", false)).resolves.toBe(false);

    const posted: Array<Record<string, unknown>> = [];
    vi.spyOn(
      panel as unknown as { postToWebview: (m: unknown) => void },
      "postToWebview",
    ).mockImplementation((message) => {
      posted.push(message as Record<string, unknown>);
    });
    p.postHostSettings();

    const hostSettings = posted.find((message) => message.type === "hostSettings");
    expect(hostSettings?.memoryMaintenanceEnabled).toBe(false);
  });

  it("postHostSettings 正确回读暂存的 0（hasOwnProperty，不是 truthy）", async () => {
    setUnregisteredConfigKeys(["auroraIntensity"]);
    await expect(p.writeUserSetting("auroraIntensity", 0)).resolves.toBe(false);

    const posted: Array<Record<string, unknown>> = [];
    vi.spyOn(
      panel as unknown as { postToWebview: (m: unknown) => void },
      "postToWebview",
    ).mockImplementation((message) => {
      posted.push(message as Record<string, unknown>);
    });
    p.postHostSettings();

    const hostSettings = posted.find((message) => message.type === "hostSettings");
    // 默认 35：truthy 写法（`stash[key] || fallback`）会把它弹回 35。
    expect(hostSettings?.auroraIntensity).toBe(0);
  });

  it("superAgent 重试策略：maxAttempts 越界被 clamp，dependencyPolicy 非法值归一为 block", async () => {
    const toast = vi.spyOn(p.store, "sendToast");

    await p.handleWebviewMessage({
      type: "setHostSettings",
      superAgentMaxAttempts: 99,
      superAgentDependencyPolicy: "continue",
    });

    expect(writes.values["iflow.superAgent.maxAttempts"]).toBe(5);
    expect(writes.values["iflow.superAgent.dependencyPolicy"]).toBe("continue");
    expect(writes.targets["iflow.superAgent.maxAttempts"]).toBe(vscode.ConfigurationTarget.Global);
    expect(writes.targets["iflow.superAgent.dependencyPolicy"]).toBe(vscode.ConfigurationTarget.Global);
    expect(toast).not.toHaveBeenCalledWith("warning", expect.stringContaining("设置写入失败"));

    await p.handleWebviewMessage({
      type: "setHostSettings",
      superAgentMaxAttempts: 0,
      superAgentDependencyPolicy: "bogus",
    });

    // 0 被夹到 1（= 不自动重试），非法枚举一律按 block 落盘。
    expect(writes.values["iflow.superAgent.maxAttempts"]).toBe(1);
    expect(writes.values["iflow.superAgent.dependencyPolicy"]).toBe("block");
  });

  it("postHostSettings 回读 superAgent 重试策略（含越界 clamp 与非法枚举归一）", async () => {
    writes.values["iflow.superAgent.maxAttempts"] = 42;
    writes.values["iflow.superAgent.dependencyPolicy"] = "whatever";

    const posted: Array<Record<string, unknown>> = [];
    vi.spyOn(
      panel as unknown as { postToWebview: (m: unknown) => void },
      "postToWebview",
    ).mockImplementation((message) => {
      posted.push(message as Record<string, unknown>);
    });
    p.postHostSettings();

    const hostSettings = posted.find((message) => message.type === "hostSettings");
    expect(hostSettings?.superAgentMaxAttempts).toBe(5);
    expect(hostSettings?.superAgentDependencyPolicy).toBe("block");
  });

  it("language 选回默认（空串）时删除 CLI settings 里的 language 键，其余键不动", async () => {
    const file = path.join(iflowHome, "settings.json");
    await writeFile(
      file,
      JSON.stringify({ language: "zh-CN", mcpServers: { keep: { command: "node" } } }, null, 2),
      "utf8",
    );
    const info = vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined);

    (panel as unknown as { cliSettingsSyncRun: () => void }).cliSettingsSyncRun();

    const after = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(after.language).toBeUndefined();
    expect(after.mcpServers).toEqual({ keep: { command: "node" } });
    expect(info).toHaveBeenCalledWith("已写入内核配置，重启内核后生效", "立即重启");
  });

  it("language 为空且 CLI 里本就没有该键：不写盘、不弹重启提示", async () => {
    const file = path.join(iflowHome, "settings.json");
    await writeFile(file, JSON.stringify({ mcpServers: {} }, null, 2), "utf8");
    const info = vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined);

    (panel as unknown as { cliSettingsSyncRun: () => void }).cliSettingsSyncRun();

    const after = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(after).toEqual({ mcpServers: {} });
    expect(info).not.toHaveBeenCalled();
  });

  it("面板写出的每个设置键都在 manifest 声明（跨文件回归锁）", () => {
    const source = readFileSync(path.join(root, "src", "panel", "panel.ts"), "utf8");
    const keys = new Set<string>();
    for (const match of source.matchAll(/writes\.push\(\[\s*"([^"]+)"/g)) keys.add(match[1]!);
    for (const match of source.matchAll(/writeUserSetting\("([^"]+)"/g)) keys.add(match[1]!);

    expect(keys.size).toBeGreaterThan(20);
    expect([...keys].filter((key) => !(`iflow.${key}` in schema))).toEqual([]);
  });

/** 多轮多场景冒烟：锁住「就地升级后未注册键」与值域边界。复用上面的
 * installConfig / setUnregisteredConfigKeys 桩，场景编号与冒烟轮次对应。 */
describe("冒烟：未注册键暂存与值域边界", () => {
  function postedHostSettings(): Record<string, unknown> | undefined {
    const posted: Array<Record<string, unknown>> = [];
    vi.spyOn(
      panel as unknown as { postToWebview: (m: unknown) => void },
      "postToWebview",
    ).mockImplementation((message) => {
      posted.push(message as Record<string, unknown>);
    });
    p.postHostSettings();
    return posted.find((message) => message.type === "hostSettings");
  }

  it("第1轮①：四项未注册时全部暂存、无失败 toast，postHostSettings 立即读到新值（含 false/0/block）", async () => {
    setUnregisteredConfigKeys([
      "efficiencyMode",
      "memoryMaintenanceEnabled",
      "superAgent.maxAttempts",
      "superAgent.dependencyPolicy",
      "auroraIntensity",
    ]);
    const toast = vi.spyOn(p.store, "sendToast");

    await p.handleWebviewMessage({
      type: "setHostSettings",
      efficiencyMode: "turbo",
      memoryMaintenanceEnabled: false,
      superAgentMaxAttempts: 0,
      superAgentDependencyPolicy: "block",
      auroraIntensity: 0,
    });

    expect(toast).not.toHaveBeenCalledWith("warning", expect.stringContaining("设置写入失败"));
    expect(ctx.globalState.get("iflow.pendingSettingsWrites")).toEqual({
      efficiencyMode: "turbo",
      memoryMaintenanceEnabled: false,
      // 0 在写盘前被夹到 1（不自动重试），暂存的是归一后的值。
      "superAgent.maxAttempts": 1,
      "superAgent.dependencyPolicy": "block",
      auroraIntensity: 0,
    });
    // 未注册键一个都不该尝试 update。
    expect(writes.attempts).toEqual([]);

    expect(postedHostSettings()).toMatchObject({
      efficiencyMode: "turbo",
      memoryMaintenanceEnabled: false,
      superAgentMaxAttempts: 1,
      superAgentDependencyPolicy: "block",
      auroraIntensity: 0,
    });
  });

  it("第1轮②：连续切换 5 次（开→关→开→关→开）→ 最终暂存值与最后一次一致，无失败 toast", async () => {
    setUnregisteredConfigKeys(["efficiencyMode"]);
    const toast = vi.spyOn(p.store, "sendToast");

    for (const mode of ["turbo", "steady", "turbo", "steady", "turbo"] as const) {
      await p.handleWebviewMessage({ type: "setHostSettings", efficiencyMode: mode });
    }

    expect(ctx.globalState.get("iflow.pendingSettingsWrites")).toEqual({ efficiencyMode: "turbo" });
    expect(writes.attempts).toEqual([]);
    const failureToasts = toast.mock.calls.filter(([, message]) =>
      String(message).includes("设置写入失败"),
    );
    expect(failureToasts).toEqual([]);
    expect(postedHostSettings()?.efficiencyMode).toBe("turbo");
  });

  it("第1轮③：清空未注册状态后 applyPendingSettings 以 Global 落盘、清空暂存，二次调用幂等", async () => {
    await ctx.globalState.update("iflow.pendingSettingsWrites", {
      efficiencyMode: "turbo",
      memoryMaintenanceEnabled: false,
      "superAgent.maxAttempts": 1,
      "superAgent.dependencyPolicy": "block",
    });
    setUnregisteredConfigKeys([]);

    await p.applyPendingSettings();

    expect(writes.values["iflow.efficiencyMode"]).toBe("turbo");
    expect(writes.values["iflow.memoryMaintenanceEnabled"]).toBe(false);
    expect(writes.values["iflow.superAgent.maxAttempts"]).toBe(1);
    expect(writes.values["iflow.superAgent.dependencyPolicy"]).toBe("block");
    for (const key of [
      "iflow.efficiencyMode",
      "iflow.memoryMaintenanceEnabled",
      "iflow.superAgent.maxAttempts",
      "iflow.superAgent.dependencyPolicy",
    ]) {
      expect(writes.targets[key]).toBe(vscode.ConfigurationTarget.Global);
    }
    expect(ctx.globalState.get("iflow.pendingSettingsWrites")).toEqual({});

    const attemptsAfterFirst = [...writes.attempts];
    await p.applyPendingSettings();
    expect(writes.attempts).toEqual(attemptsAfterFirst);
    expect(ctx.globalState.get("iflow.pendingSettingsWrites")).toEqual({});
  });

  it("第2轮④：maxAttempts 0→1、99→5；NaN / Infinity 不落盘且回读为默认 2", async () => {
    await p.handleWebviewMessage({ type: "setHostSettings", superAgentMaxAttempts: 0 });
    expect(writes.values["iflow.superAgent.maxAttempts"]).toBe(1);

    await p.handleWebviewMessage({ type: "setHostSettings", superAgentMaxAttempts: 99 });
    expect(writes.values["iflow.superAgent.maxAttempts"]).toBe(5);

    const attemptsBeforeNonFinite = [...writes.attempts];
    await p.handleWebviewMessage({ type: "setHostSettings", superAgentMaxAttempts: Number.NaN });
    await p.handleWebviewMessage({ type: "setHostSettings", superAgentMaxAttempts: Number.POSITIVE_INFINITY });
    // 非有限数不进入写盘队列：盘上保持上一个合法值 5。
    expect(writes.attempts).toEqual(attemptsBeforeNonFinite);
    expect(writes.values["iflow.superAgent.maxAttempts"]).toBe(5);

    // 盘上被手改成脏值（NaN / Infinity）时，回读必须回落默认 2。
    writes.values["iflow.superAgent.maxAttempts"] = Number.NaN;
    expect(postedHostSettings()?.superAgentMaxAttempts).toBe(2);
    writes.values["iflow.superAgent.maxAttempts"] = Number.POSITIVE_INFINITY;
    expect(postedHostSettings()?.superAgentMaxAttempts).toBe(2);
  });
  });
});
