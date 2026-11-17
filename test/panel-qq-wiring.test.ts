/**
 * QQ 通道在面板侧的行为锚点（Wave3-B2b）。
 *
 * 这里**不 spawn 任何真实进程**：只钉住不依赖 bridge 的那几段接线 ——
 * 投影刷新（refreshQqTasks → SessionState.qqTasks）、任务操作转发、配对
 * 绑定的白名单落盘，以及「通道未启动时所有入口都安静返回」。真正的 bridge
 * 生命周期只能由端到端手测覆盖（起进程 / 起监听），不在单测范围内。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import type { QqSettingsIo } from "../src/qq/settings-host.js";
import type { QqConfig } from "../src/qq/config.js";
import type { QqTaskUi, SessionState, WebviewToHost } from "../shared/messages.js";
import { setConfigOverrides } from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeContext(storageDir: string): vscodeTypes.ExtensionContext {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, defaultValue?: T): T =>
      (store.has(key) ? (store.get(key) as T) : defaultValue) as T,
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

function makeConfig(overrides: Partial<QqConfig> = {}): QqConfig {
  return {
    enabled: true,
    adapter: "onebot",
    endpoint: "http://127.0.0.1:3000/",
    bridgePort: 0,
    allowedUsers: ["10001"],
    allowedGroups: [],
    workspace: "",
    remotePolicy: "supervised",
    maxConcurrentTasks: 2,
    rateLimitPerMin: 6,
    resultDetail: "standard",
    autoMerge: false,
    ...overrides,
  };
}

/** 一张最小的看板条目。 */
const TASK: QqTaskUi = {
  taskId: "task-1",
  shortId: "task-1",
  chatType: "private",
  chatId: "10001",
  senderId: "10001",
  status: "running",
  promptPreview: "跑个测试",
  createdAt: 1,
  updatedAt: 2,
};

/** 内存版设置 IO：记录写入、返回固定快照。 */
function makeIo(initial: { settings?: Record<string, unknown> } = {}): {
  io: QqSettingsIo;
  writes: Array<Record<string, unknown>>;
} {
  const settings: Record<string, unknown> = { ...(initial.settings ?? {}) };
  const writes: Array<Record<string, unknown>> = [];
  const io: QqSettingsIo = {
    readAll: () => ({ ...settings }),
    writeAll: async (patch) => {
      writes.push({ ...patch });
      Object.assign(settings, patch);
    },
    getSecret: async () => undefined,
    setSecret: async () => undefined,
    deleteSecret: async () => undefined,
  };
  return { io, writes };
}

type PanelInternals = {
  qq?: unknown;
  qqWorkspaceRoots: () => string[];
  coerceQqInboundMessage: (value: unknown) => unknown;
  isQqTaskAction: (value: unknown) => boolean;
  handleWebviewMessage: (msg: WebviewToHost) => Promise<void>;
  handleQqConfigAction: (action: "testConnection" | "generateBindCode" | "unbind") => Promise<void>;
  handleQqTaskAction: (taskId: string, action: string, text?: string) => Promise<void>;
  refreshQqTasks: () => void;
  bindQqAccount: (code: string, senderId: string) => Promise<{ ok: boolean; message: string }>;
  unbindQqAccount: () => Promise<{ ok: boolean; message: string }>;
  store: { getState: () => SessionState; sendToast: (...args: unknown[]) => number };
};

describe("QQ 通道 · 面板侧接线", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let iflowHome: string;

  beforeEach(async () => {
    iflowHome = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-wiring-home-"));
    process.env.IFLOW_HOME = iflowHome;
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-wiring-storage-"));
    setConfigOverrides({});
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
  });

  afterEach(async () => {
    await panel.dispose();
    delete process.env.IFLOW_HOME;
    fs.rmSync(iflowHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("设置未启用时启动路径不留下通道现场", async () => {
    // 构造函数的 startQqIfEnabled 是异步的：给它一轮事件循环。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(p.qq).toBeUndefined();
    expect(p.qqWorkspaceRoots()).toEqual([]);
  });

  it("刷新投影：把服务任务写进 SessionState.qqTasks", () => {
    const stop = vi.fn(async () => undefined);
    p.qq = {
      service: {
        listTasks: () => [TASK],
        handleTaskAction: vi.fn(async () => undefined),
        stop,
      },
      store: {},
      ipc: { port: 0, close: async () => undefined },
      config: makeConfig(),
      io: makeIo().io,
      restartCount: 0,
    };

    p.refreshQqTasks();
    expect(p.store.getState().qqTasks).toEqual([TASK]);

    // 通道没了以后刷新应当清空投影，而不是留下上一轮的幽灵条目。
    p.qq = undefined;
    p.refreshQqTasks();
    expect(p.store.getState().qqTasks).toEqual([]);
  });

  it("任务操作转发给服务并刷新投影", async () => {
    const handleTaskAction = vi.fn(async () => undefined);
    const io = makeIo().io;
    p.qq = {
      service: { listTasks: () => [], handleTaskAction, stop: async () => undefined },
      store: {},
      ipc: { port: 0, close: async () => undefined },
      config: makeConfig(),
      io,
      restartCount: 0,
    };

    await p.handleQqTaskAction("task-1", "stop");
    expect(handleTaskAction).toHaveBeenCalledWith("task-1", "stop", undefined);
  });

  it("qqConfigAction 走 webview → host 通道并被识别（不再是 HostToWebview 的误声明）", async () => {
    // 类型层面：它必须是合法的 WebviewToHost 消息（tsc 在测试配置下会把
    // 这里标红为不兼容 —— 若方向被写回 HostToWebview 即可发现）。
    const msg: WebviewToHost = { type: "qqConfigAction", action: "testConnection" };
    const handler = vi.spyOn(p, "handleQqConfigAction").mockResolvedValue(undefined);

    await p.handleWebviewMessage(msg);
    expect(handler).toHaveBeenCalledWith("testConnection");

    await p.handleWebviewMessage({ type: "qqConfigAction", action: "generateBindCode" });
    expect(handler).toHaveBeenLastCalledWith("generateBindCode");

    handler.mockRestore();
  });

  it("通道未启动时提问/操作入口安静返回（不崩、不改状态）", async () => {
    const toast = vi.spyOn(p.store, "sendToast").mockImplementation(() => 0);
    await p.handleQqTaskAction("task-1", "stop");
    expect(toast).toHaveBeenCalled();
    await p.handleQqConfigAction("generateBindCode");
    expect(toast).toHaveBeenCalledTimes(2);
    await expect(p.bindQqAccount("ABC123", "10001")).resolves.toEqual({
      ok: false,
      message: "QQ 通道未启动",
    });
  });

  it("配对成功：校验码 → 去重追加白名单 → 落盘", async () => {
    const { io, writes } = makeIo({ settings: { allowedUsers: ["10001"] } });
    p.qq = {
      service: { listTasks: () => [], handleTaskAction: async () => undefined, stop: async () => undefined },
      store: {},
      ipc: { port: 0, close: async () => undefined },
      config: makeConfig({ allowedUsers: ["10001"] }),
      io,
      restartCount: 0,
      bindCode: { code: "ABC123", expiresAt: Date.now() + 60_000 },
    };
    const owner = p.qq as { config: QqConfig; io: QqSettingsIo };

    await expect(p.bindQqAccount(" abc123 ", "10002")).resolves.toEqual({
      ok: true,
      message: "已绑定 10002",
    });
    expect(writes[writes.length - 1]).toEqual({ allowedUsers: ["10001", "10002"] });
    // 与服务共享同一份 config：白名单立刻生效（不必等重启）。
    expect(owner.config.allowedUsers).toEqual(["10001", "10002"]);

    // 幂等：重复绑定不重复占位。
    await p.bindQqAccount("ABC123", "10002");
    expect(writes[writes.length - 1]).toEqual({ allowedUsers: ["10001", "10002"] });
  });

  it("配对失败：码不匹配 / 已过期 / 不存在都不改白名单", async () => {
    const { io, writes } = makeIo({ settings: { allowedUsers: ["10001"] } });
    p.qq = {
      service: { listTasks: () => [], handleTaskAction: async () => undefined, stop: async () => undefined },
      store: {},
      ipc: { port: 0, close: async () => undefined },
      config: makeConfig(),
      io,
      restartCount: 0,
      bindCode: { code: "ABC123", expiresAt: Date.now() + 60_000 },
    };

    await expect(p.bindQqAccount("WRONG1", "10002")).resolves.toEqual({
      ok: false,
      message: "绑定码无效",
    });
    const expired = p.qq as { bindCode?: { code: string; expiresAt: number } };
    expired.bindCode = { code: "ABC123", expiresAt: Date.now() - 1 };
    await expect(p.bindQqAccount("ABC123", "10002")).resolves.toEqual({
      ok: false,
      message: "绑定码已过期",
    });
    delete expired.bindCode;
    await expect(p.bindQqAccount("ABC123", "10002")).resolves.toEqual({
      ok: false,
      message: "绑定码无效",
    });
    expect(writes).toEqual([]);
  });

  it("解绑清空用户白名单并落盘", async () => {
    const { io, writes } = makeIo({ settings: { allowedUsers: ["10001"] } });
    p.qq = {
      service: { listTasks: () => [], handleTaskAction: async () => undefined, stop: async () => undefined },
      store: {},
      ipc: { port: 0, close: async () => undefined },
      config: makeConfig({ allowedUsers: ["10001"] }),
      io,
      restartCount: 0,
    };
    const owner = p.qq as { config: QqConfig };

    await expect(p.unbindQqAccount()).resolves.toEqual({ ok: true, message: "已解除账号绑定" });
    expect(writes[writes.length - 1]).toEqual({ allowedUsers: [] });
    expect(owner.config.allowedUsers).toEqual([]);
  });

  it("入站消息收敛：坏帧丢弃、合法帧逐字段兜底", () => {
    expect(p.coerceQqInboundMessage(null)).toBeNull();
    expect(p.coerceQqInboundMessage({ chatType: "channel", chatId: "1" })).toBeNull();
    expect(
      p.coerceQqInboundMessage({ chatType: "private", chatId: "1", senderId: "2", msgId: "m" }),
    ).toBeNull();

    const message = p.coerceQqInboundMessage({
      chatType: "group",
      chatId: "3",
      senderId: "2",
      msgId: "m1",
      text: "hi",
      attachments: [{ kind: "image", url: "https://example.com/a.png" }, { kind: "video" }],
    }) as {
      chatType: string;
      mentionsBot: boolean;
      attachments: unknown[];
      timestamp: number;
    };
    expect(message.chatType).toBe("group");
    // 无法证明被 @ 就不算（群聊会安全丢弃）。
    expect(message.mentionsBot).toBe(false);
    expect(message.attachments).toHaveLength(1);
    expect(typeof message.timestamp).toBe("number");
  });

  it("任务动作白名单", () => {
    for (const action of ["approve", "deny", "answer", "stop", "merge", "discard", "refresh"]) {
      expect(p.isQqTaskAction(action)).toBe(true);
    }
    expect(p.isQqTaskAction("delete")).toBe(false);
    expect(p.isQqTaskAction(undefined)).toBe(false);
  });

  it("adapter=qqbot 走官方路线：未绑定时提示扫码，不再以「尚未实现」拒绝", async () => {
    setConfigOverrides({
      enabled: true,
      adapter: "qqbot",
      endpoint: "http://127.0.0.1:3000/",
      allowedUsers: ["10001"],
    });
    const other = new ChatPanel(makeContext(storageDir), {
      workspaceRoot: here,
      watchers: makeWatchers(),
    });
    const op = other as unknown as PanelInternals;
    const toast = vi.spyOn(op.store, "sendToast").mockImplementation(() => 0);
    await (other as unknown as { startQqIfEnabled: () => Promise<void> }).startQqIfEnabled();

    expect(op.qq).toBeUndefined();
    expect(toast).toHaveBeenCalledWith("warning", expect.stringContaining("尚未扫码绑定"));
    expect(toast).not.toHaveBeenCalledWith("warning", expect.stringContaining("尚未实现"));
    toast.mockRestore();
    await other.dispose();
  });

  it("workspace 指向其他目录时拒绝启动：toast 说明只支持当前工作区", async () => {
    setConfigOverrides({
      enabled: true,
      adapter: "onebot",
      endpoint: "http://127.0.0.1:3000/",
      allowedUsers: ["10001"],
      workspace: path.resolve(here, "..", "qq-elsewhere"),
    });
    const other = new ChatPanel(makeContext(storageDir), {
      workspaceRoot: here,
      watchers: makeWatchers(),
    });
    const op = other as unknown as PanelInternals;
    const toast = vi.spyOn(op.store, "sendToast").mockImplementation(() => 0);
    await (other as unknown as { startQqIfEnabled: () => Promise<void> }).startQqIfEnabled();

    expect(op.qq).toBeUndefined();
    expect(toast).toHaveBeenCalledWith("warning", expect.stringContaining("当前工作区"));
    toast.mockRestore();
    await other.dispose();
  });
});
