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
  store: { sendToast: (...args: unknown[]) => number };
  [k: string]: unknown;
};

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

  /**
   * 等面板构造期那次 startQqIfEnabled（fire-and-forget）落定。
   *
   * 以内部 qqStarting promise 归零为完成信号 —— 固定 sleep 在慢速 CI
   * runner 上不够（它会与用例里的扫码链路交错）。
   */
  async function waitPanelStartSettled(): Promise<void> {
    const internals = p as unknown as { qqStarting?: Promise<void> | null };
    await vi.waitFor(
      () => {
        expect(internals.qqStarting).toBeNull();
      },
      { timeout: 5000, interval: 5 },
    );
  }

  /**
   * 等扫码绑定链（`onQqBotBound` 是 fire-and-forget）真正收尾。
   *
   * 链的**最后一步**是「首次绑定自动开启远程任务」的 `{ enabled: true }`
   * 落盘 —— 它发生在凭据写入、白名单合并、通道启动**之后**，等它出现即
   * 等价于「整条链已落定」（通道启动闸门 qqChannelStarting 也已释放）。
   * 固定 sleep 在慢速 CI runner 上不够：曾导致 writes 仍为空，以及失活
   * 恢复被 `recoverQqChannel` 的「正在启动就别抢」分支直接跳过。
   */
  async function waitBindSettled(): Promise<void> {
    await vi.waitFor(
      () => {
        expect(ioHarness.writes).toContainEqual({ enabled: true });
      },
      { timeout: 5000, interval: 10 },
    );
  }

  beforeEach(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-managed-"));
    setConfigOverrides({ enabled: true, allowedUsers: ["10001"] });
    ioHarness = makeIo();
    posted = [];
    createPanel();
    await waitPanelStartSettled();
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
    // onSuccess 里 `void this.onQqBotBound(...)` 是 fire-and-forget，且
    // `{ enabled: true }` 的落盘在整条链（含 QqService.start() 的真实磁盘 IO）
    // 末尾才发生。固定 25ms tick 在慢速 CI runner 上不够，assert 时 writes 还
    // 是空的 —— 用 waitFor 等实际副作用到位，消除时序 flake。
    await vi.waitFor(
      () => {
        expect(ioHarness.writes).toContainEqual({ enabled: true });
        expect(p.qq?.qqbot?.adapter).toBeTruthy();
      },
      { timeout: 5000, interval: 10 },
    );
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
    // 绑定链是 fire-and-forget：不等它落定就 stopQq，adapter 还没建出来，
    // close 次数与 p.qq 的断言都会随 runner 负载漂移。
    await waitBindSettled();
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

  it("op=9 失活：测试连接不再显示正常，并自动重启一次", async () => {
    await p.handleQqManagedSetup("start");
    protocolCbs!.onSuccess({ appId: "app", appSecret: "sec" });
    // 绑定链是 fire-and-forget（`void this.onQqBotBound(...)`）：固定 25ms
    // tick 在慢速 CI runner 上不够 —— 通道启动闸门（qqChannelStarting）还
    // 占着时，失活恢复会被 recoverQqChannel 的「正在启动就别抢」分支直接
    // 跳过，connect 停在 1 次（曾稳定复现）。轮询等整条绑定链落定。
    await waitBindSettled();
    expect(p.qq).toBeTruthy();
    expect(adapter.connect).toHaveBeenCalledTimes(1);

    const toast = vi.spyOn(p.store, "sendToast").mockImplementation(() => 0);
    adapter.health.mockResolvedValueOnce({
      connected: true,
      detail: "qqbot websocket; 会话已失效（op=9 invalid session）",
    });

    await p.handleQqConfigAction("testConnection");

    const statuses = messages("qqStatus");
    expect(statuses.some((m) => (m as { connected?: boolean }).connected === false)).toBe(true);
    // 自动重启一次：stop 旧 owner 后重新 connect。恢复链含真实磁盘 IO +
    // 通道重建，轮询等它真正落地 —— 轮询只是同步手段，断言强度不变：
    // 下面仍然精确断言 connect 恰好 2 次（首绑 1 次 + 重启 1 次）。
    await vi.waitFor(
      () => {
        expect(adapter.connect.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(toast).toHaveBeenCalledWith("info", expect.stringContaining("已自动重启一次"));
      },
      { timeout: 5000, interval: 10 },
    );
    expect(adapter.connect).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenCalledWith("info", expect.stringContaining("已自动重启一次"));
    expect(p.qq).toBeTruthy();
    toast.mockRestore();
  });

  it("连续失活最多自动重启一次：第二次只提示重新扫码", async () => {
    await p.handleQqManagedSetup("start");
    protocolCbs!.onSuccess({ appId: "app", appSecret: "sec" });
    // 同上：等整条绑定链落定，避免失活恢复被「正在启动就别抢」跳过。
    await waitBindSettled();
    expect(adapter.connect).toHaveBeenCalledTimes(1);

    const toast = vi.spyOn(p.store, "sendToast").mockImplementation(() => 0);
    adapter.health.mockResolvedValue({
      connected: true,
      detail: "qqbot websocket; 会话已失效（op=9 invalid session）",
    });

    await p.handleQqConfigAction("testConnection");
    // 恢复链含真实磁盘 IO + 通道重建：轮询等第一次重启真正落地。
    await vi.waitFor(
      () => {
        expect(adapter.connect.mock.calls.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 5000, interval: 10 },
    );
    expect(adapter.connect).toHaveBeenCalledTimes(2);

    // 第二次仍然失活：预算已用尽，绝不再重启，只能让用户重扫。
    await p.handleQqConfigAction("testConnection");
    expect(adapter.connect).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenCalledWith(
      "warning",
      expect.stringContaining("重新扫码"),
    );
    toast.mockRestore();
  });
});