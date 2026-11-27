/**
 * QQ 通道 · 工作区切换回归（面板接线层）。
 *
 * 用户报告的 BUG：切换 / 打开另一个 workspace 文件夹（或无文件夹窗口 →
 * 有文件夹窗口）之后，QQ 机器人必须手动「重新保存一次配置 / 重新连接」才
 * 生效。根因是通道现场在启动时把与工作区根相关的东西固定了下来（配置快照、
 * 启动门控用的 activeRoot、任务与待审核存储目录），而工作区文件夹变化监听
 * 只作废了文件缓存与根投影，从不重建 QQ 通道。
 *
 * 这里不联网、不 spawn：adapter 由 `qqbotDeps.adapterFactory` 逐个注入并记录，
 * 文件夹变化通过 `test/vscode-stub.ts` 的事件钩子驱动，断言：
 *  - 根真的变化时旧连接被 close、新连接被建（恰好一次，无重复连接）；
 *  - 新连接按新工作区**重新解析配置**（改盘上的设置后重建即生效）；
 *  - 根没变时不重建（避免打断在跑的 QQ 任务）；
 *  - 未运行（未启用）时，打开文件夹会按新工作区重新读设置并自动启动。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel, type PanelServices } from "../src/panel/panel.js";
import type { QqSettingsIo } from "../src/qq/settings-host.js";
import { QQBOT_APP_ID_SECRET_KEY } from "../src/panel/qqbot-host.js";
import { QQ_SECRET_KEYS } from "../src/qq/config.js";
import {
  fireWorkspaceFoldersChanged,
  resetWorkspaceFoldersStub,
  setWorkspaceFolders,
} from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeContext(storageDir: string): vscodeTypes.ExtensionContext {
  const state = {
    get: <T>(_key: string, defaultValue?: T): T => defaultValue as T,
    update: () => Promise.resolve(),
    keys: () => [] as string[],
    delete: () => Promise.resolve(),
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

interface FakeAdapter {
  setEventCallback: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  health: ReturnType<typeof vi.fn>;
}

function makeAdapter(): FakeAdapter {
  return {
    setEventCallback: vi.fn(),
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    send: vi.fn(async () => ({ ok: true as const })),
    health: vi.fn(async () => ({ connected: true, detail: "qqbot" })),
  };
}

function makeIo(initial: Record<string, unknown>): {
  io: QqSettingsIo;
  settings: Record<string, unknown>;
} {
  const settings: Record<string, unknown> = { ...initial };
  const secrets = new Map<string, string>([
    [QQBOT_APP_ID_SECRET_KEY, "app-id"],
    [QQ_SECRET_KEYS.appSecret, "app-secret"],
  ]);
  const io: QqSettingsIo = {
    readAll: () => ({ ...settings }),
    writeAll: async (patch) => {
      Object.assign(settings, patch);
    },
    getSecret: async (key) => secrets.get(key),
    setSecret: async (key, value) => {
      secrets.set(key, value);
    },
    deleteSecret: async (key) => {
      secrets.delete(key);
    },
  };
  return { io, settings };
}

type PanelInternals = {
  qq?: { config?: Record<string, unknown>; qqbot?: { adapter: FakeAdapter } };
  qqStarting?: Promise<void> | null;
  qqChannelStarting?: Promise<void> | null;
};

/** 等面板构造期那次 startQqIfEnabled 的 fire-and-forget 落定。 */
async function waitStartSettled(p: PanelInternals): Promise<void> {
  await vi.waitFor(
    () => {
      expect(p.qqStarting ?? null).toBeNull();
      expect(p.qqChannelStarting ?? null).toBeNull();
    },
    { timeout: 5000, interval: 5 },
  );
}

describe("QQ 通道 · 工作区切换", () => {
  let storageDir: string;
  let panel: ChatPanel;
  let p: PanelInternals;
  let adapters: FakeAdapter[];
  let ioHarness: ReturnType<typeof makeIo>;
  const oldRoot = path.join(here, "qq-old-root");
  const newRoot = path.join(here, "qq-new-root");

  function createPanel(): void {
    adapters = [];
    const services: PanelServices = {
      workspaceRoot: here,
      watchers: makeWatchers(),
      qqSettingsIo: ioHarness.io,
      qqbotDeps: {
        adapterFactory: (() => {
          const adapter = makeAdapter();
          adapters.push(adapter);
          return adapter as never;
        }) as never,
      },
    };
    panel = new ChatPanel(makeContext(storageDir), services);
    p = panel as unknown as PanelInternals;
  }

  beforeEach(() => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-workspace-"));
    // 事件钩子清干净：只让本用例构造的面板注册监听。
    resetWorkspaceFoldersStub();
    setWorkspaceFolders([{ uri: { fsPath: oldRoot } }]);
  });

  afterEach(async () => {
    await panel.dispose();
    resetWorkspaceFoldersStub();
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("根变化：释放旧连接并按新工作区重新解析配置重建（无需手动保存）", async () => {
    ioHarness = makeIo({ enabled: true, allowedUsers: ["10001"], resultDetail: "standard" });
    createPanel();
    await waitStartSettled(p);
    await vi.waitFor(() => expect(adapters).toHaveLength(1), { timeout: 3000 });
    expect(adapters[0]!.connect).toHaveBeenCalledTimes(1);
    expect(p.qq).toBeTruthy();

    // 盘上的设置在切换前被改过：重建必须重新读它（证明是「重新解析配置」，
    // 而不是沿用启动时的快照）。
    ioHarness.settings.resultDetail = "full";

    setWorkspaceFolders([{ uri: { fsPath: newRoot } }]);
    fireWorkspaceFoldersChanged();

    await vi.waitFor(
      () => {
        expect(adapters).toHaveLength(2);
        expect(adapters[1]!.connect).toHaveBeenCalledTimes(1);
      },
      { timeout: 4000, interval: 10 },
    );
    await waitStartSettled(p);

    // 旧连接已释放，新连接是唯一在跑的现场（无重复连接）。
    expect(adapters[0]!.close).toHaveBeenCalledTimes(1);
    expect(p.qq?.qqbot?.adapter).toBe(adapters[1]);
    // 新现场用的是新工作区根。
    expect(panel.qqWorkspaceRoots()).toEqual([newRoot]);
    // 配置被重新解析（不是启动时的快照）。
    expect(p.qq?.config?.resultDetail).toBe("full");
  });

  it("根没变：不重建（不打断在跑的 QQ 任务）", async () => {
    ioHarness = makeIo({ enabled: true, allowedUsers: ["10001"] });
    createPanel();
    await waitStartSettled(p);
    await vi.waitFor(() => expect(adapters).toHaveLength(1), { timeout: 3000 });

    fireWorkspaceFoldersChanged();
    // 重建是 500ms 防抖；等过这个窗口确认它没有被排上。
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(adapters).toHaveLength(1);
    expect(adapters[0]!.connect).toHaveBeenCalledTimes(1);
    expect(adapters[0]!.close).not.toHaveBeenCalled();
  });

  it("未启用 / 未运行：打开文件夹后按新工作区重新读设置并自动启动", async () => {
    ioHarness = makeIo({ enabled: false, allowedUsers: ["10001"] });
    createPanel();
    await waitStartSettled(p);
    expect(adapters).toHaveLength(0);
    expect(p.qq).toBeUndefined();

    // 新工作区里开关是开着的（例如工作区级设置，或用户刚打开就改了）：
    // 旧实现要等用户手动保存一次才会读设置，这里必须自动补起。
    ioHarness.settings.enabled = true;
    setWorkspaceFolders([{ uri: { fsPath: newRoot } }]);
    fireWorkspaceFoldersChanged();

    await vi.waitFor(
      () => {
        expect(adapters).toHaveLength(1);
        expect(adapters[0]!.connect).toHaveBeenCalledTimes(1);
      },
      { timeout: 4000, interval: 10 },
    );
    await waitStartSettled(p);
    expect(p.qq).toBeTruthy();
    expect(panel.qqWorkspaceRoots()).toEqual([newRoot]);
  });
});
