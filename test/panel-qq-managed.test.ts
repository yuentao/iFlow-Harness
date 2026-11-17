/**
 * QQ 托管入口的面板编排单测（QQBot 官方扫码单一路径）。
 *
 * 验证托管入口恒走 QQBot 官方扫码：推二维码、扫码成功后写入官方凭据并建
 * adapter，三动作与停止收尾都收干净。全程注入，不联网 / 不 spawn。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel, type PanelServices } from "../src/panel/panel.js";
import type { QqSettingsIo } from "../src/qq/settings-host.js";
import type { HostToWebview, WebviewToHost } from "../shared/messages.js";
import { QR_DATA_URL_PREFIX } from "../shared/messages.js";
import { QQBOT_APP_ID_SECRET_KEY } from "../src/panel/qqbot-host.js";
import { QQ_SECRET_KEYS } from "../src/qq/config.js";
import { setConfigOverrides } from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const VALID_PNG = QR_DATA_URL_PREFIX + Buffer.from("qr-bytes").toString("base64");

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

function makeIo(): {
  io: QqSettingsIo;
  secrets: Map<string, string>;
  settings: Record<string, unknown>;
  writes: Array<Record<string, unknown>>;
} {
  const settings: Record<string, unknown> = { enabled: false, allowedUsers: ["10001"] };
  const secrets = new Map<string, string>();
  const writes: Array<Record<string, unknown>> = [];
  return {
    io: {
      readAll: () => ({ ...settings }),
      writeAll: async (patch) => {
        writes.push({ ...patch });
        Object.assign(settings, patch);
      },
      getSecret: async (key) => secrets.get(key),
      setSecret: async (key, value) => {
        secrets.set(key, value);
      },
      deleteSecret: async (key) => {
        secrets.delete(key);
      },
    },
    secrets,
    settings,
    writes,
  };
}

type PanelInternals = {
  qq?: { config?: Record<string, unknown>; qqbot?: { adapter: { close: () => Promise<void> } }; [k: string]: unknown };
  qqbotBinding?: { stop(): void } | null;
  handleWebviewMessage: (msg: WebviewToHost) => Promise<void>;
  handleQqManagedSetup: (action: "start" | "stop") => Promise<void>;
  handleQqConfigAction: (action: string) => Promise<void>;
  stopQq: () => Promise<void>;
  postToWebview: (msg: HostToWebview) => void;
  [k: string]: unknown;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

describe("QQ 托管入口收敛 · 面板编排（QQBot 单一路径）", () => {
  let storageDir: string;
  let panel: ChatPanel;
  let p: PanelInternals;
  let posted: HostToWebview[];
  let ioHarness: ReturnType<typeof makeIo>;
  let protocolCbs: Parameters<import("../src/qq/qqbot/bind.js").QqBotQrProtocolLike["start"]>[0] | null;
  let protocolStop: ReturnType<typeof vi.fn>;
  let adapter: { setEventCallback: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; health: ReturnType<typeof vi.fn> };

  function createPanel(): void {
    protocolCbs = null;
    protocolStop = vi.fn();
    adapter = {
      setEventCallback: vi.fn(),
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      send: vi.fn(async () => ({ ok: true as const })),
      health: vi.fn(async () => ({ connected: true, detail: "qqbot" })),
    };
    const services: PanelServices = {
      workspaceRoot: here,
      watchers: makeWatchers(),
      qqSettingsIo: ioHarness.io,
      qqbotDeps: {
        bind: {
          protocolFactory: (() => ({
            start: async (
              cbs: Parameters<import("../src/qq/qqbot/bind.js").QqBotQrProtocolLike["start"]>[0],
            ) => {
              protocolCbs = cbs;
              cbs.onQr(VALID_PNG, Date.now() + 60_000);
              return protocolStop as unknown as () => void;
            },
          })) as never,
        },
        adapterFactory: () => adapter as never,
      },
    };
    panel = new ChatPanel(makeContext(storageDir), services);
    p = panel as unknown as PanelInternals;
  }

  beforeEach(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-managed-"));
    setConfigOverrides({ enabled: true, allowedUsers: ["10001"] });
    ioHarness = makeIo();
    posted = [];
    createPanel();
    await tick();
    vi.spyOn(p, "postToWebview").mockImplementation((m) => {
      posted.push(m);
    });
    posted.length = 0;
  });

  afterEach(async () => {
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function messages(type: string): HostToWebview[] {
    return posted.filter((m) => (m as { type?: string }).type === type);
  }

  it("start：恒走 QQBot 扫码，推二维码并建立扫码会话", async () => {
    await p.handleQqManagedSetup("start");
    expect(messages("qqLoginQr").length).toBeGreaterThan(0);
    expect(protocolCbs).not.toBeNull();
  });

  it("扫码成功：写官方凭据（appId/appSecret）、自动启用并启动 adapter", async () => {
    await p.handleQqManagedSetup("start");
    protocolCbs!.onSuccess({ appId: "app-1", appSecret: "sec-1" });
    await tick();
    expect(ioHarness.secrets.get(QQBOT_APP_ID_SECRET_KEY)).toBe("app-1");
    expect(ioHarness.secrets.get(QQ_SECRET_KEYS.appSecret)).toBe("sec-1");
    // 首次绑定（原本未启用）必须自动开启远程任务。
    expect(ioHarness.writes).toContainEqual({ enabled: true });
    expect(ioHarness.settings.enabled).toBe(true);
    expect(p.qq?.config?.enabled).toBe(true);
    expect(adapter.setEventCallback).toHaveBeenCalled();
    // 先启动再落盘：配置监听不会在 this.qq 未赋值时再并发启动一次。
    expect(adapter.connect).toHaveBeenCalledTimes(1);
    expect(p.qq?.qqbot?.adapter).toBeTruthy();
    expect(protocolStop).toHaveBeenCalled();
  });

  it("QR 三动作只走 QQBot 扫码会话；无现场时安静返回", async () => {
    await expect(p.handleQqConfigAction("cancelQrLogin")).resolves.toBeUndefined();

    await p.handleQqConfigAction("startQrLogin");
    expect(protocolCbs).not.toBeNull();
    await p.handleQqConfigAction("refreshQr");
    await p.handleQqConfigAction("cancelQrLogin");
    expect(protocolStop).toHaveBeenCalled();
    expect(p.qqbotBinding).toBeNull();
    expect(messages("qqLoginQr").some((m) => (m as { phase?: string }).phase === "expired")).toBe(true);
  });

  it("stopQq：关 adapter 并清空绑定会话，幂等", async () => {
    await p.handleQqManagedSetup("start");
    protocolCbs!.onSuccess({ appId: "app", appSecret: "sec" });
    await tick();
    await p.stopQq();
    expect(adapter.close).toHaveBeenCalled();
    expect(p.qq).toBeUndefined();
    expect(p.qqbotBinding).toBeNull();
    await p.stopQq();
    expect(adapter.close).toHaveBeenCalledTimes(1);
  });

  it("stop 动作推 idle，不写回 disabled", async () => {
    await p.handleQqManagedSetup("stop");
    const idle = messages("qqManagedStatus").filter((m) => (m as { phase?: string }).phase === "idle");
    expect(idle.length).toBeGreaterThan(0);
  });

  it("qqManagedSetup 经 webview → host 通道路由到编排入口", async () => {
    const spy = vi.spyOn(p, "handleQqManagedSetup").mockResolvedValue(undefined);
    await p.handleWebviewMessage({ type: "qqManagedSetup", action: "start" });
    expect(spy).toHaveBeenCalledWith("start");
    await p.handleWebviewMessage({ type: "qqManagedSetup", action: "stop" });
    expect(spy).toHaveBeenLastCalledWith("stop");
    spy.mockRestore();
  });
});