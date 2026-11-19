/**
 * QQBot 官方路线在面板侧的行为锚点（M3-C）。
 *
 * 全程注入：协议不联网、adapter 不建连、QR 用固定 PNG 帧。只钉住编排顺序 ——
 * 扫码成功后启动官方 service、stop 收干净。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel, type PanelServices } from "../src/panel/panel.js";
import type { QqSettingsIo } from "../src/qq/settings-host.js";
import type { OutboundMessage } from "../src/qq/adapter/types.js";
import type { QqBotQrProtocolLike, QqBotCredentials } from "../src/qq/qqbot/bind.js";
import type { HostToWebview, WebviewToHost } from "../shared/messages.js";
import { QR_DATA_URL_PREFIX } from "../shared/messages.js";
import { QQ_SECRET_KEYS } from "../src/qq/config.js";
import { QQBOT_APP_ID_SECRET_KEY } from "../src/panel/qqbot-host.js";
import { setConfigOverrides } from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const VALID_PNG = QR_DATA_URL_PREFIX + Buffer.from("fake-png").toString("base64");

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
  qq?: {
    config?: Record<string, unknown>;
    qqbot?: { adapter: { close: () => Promise<void> } };
    [k: string]: unknown;
  };
  qqbotBinding?: { stop(): void } | null;
  handleWebviewMessage: (msg: WebviewToHost) => Promise<void>;
  handleQqManagedSetup: (action: "start" | "stop") => Promise<void>;
  handleQqConfigAction: (action: string) => Promise<void>;
  stopQq: () => Promise<void>;
  postToWebview: (msg: HostToWebview) => void;
  startQqBotChannel: (...args: unknown[]) => Promise<void>;
  [k: string]: unknown;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("QQBot 官方路线 · 面板接线（M3-C）", () => {
  let storageDir: string;
  let panel: ChatPanel;
  let p: PanelInternals;
  let posted: HostToWebview[];
  let ioHarness: ReturnType<typeof makeIo>;
  let protocolCbs: Parameters<QqBotQrProtocolLike["start"]>[0] | null;
  let protocolStop: ReturnType<typeof vi.fn>;
  let adapter: {
    setEventCallback: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };

  function createPanel(): void {
    protocolCbs = null;
    protocolStop = vi.fn();
    adapter = {
      setEventCallback: vi.fn(),
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      send: vi.fn(async (_msg: OutboundMessage) => ({ ok: true as const })),
    };
    const services: PanelServices = {
      workspaceRoot: here,
      watchers: makeWatchers(),
      qqSettingsIo: ioHarness.io,
      qqbotDeps: {
        bind: {
          protocolFactory: (() => ({
            start: async (cbs: Parameters<QqBotQrProtocolLike["start"]>[0]) => {
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
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qqbot-"));
    setConfigOverrides({
      enabled: true,
      allowedUsers: ["10001"],
    });
    ioHarness = makeIo();
    posted = [];
    createPanel();
    await tick(); // 构造函数的 startQqIfEnabled 落定（无凭据 → 提示绑定）
    vi.spyOn(p, "postToWebview").mockImplementation((m) => {
      posted.push(m);
    });
    posted.length = 0;
  });

  afterEach(async () => {
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("常规启动：无凭据时提示先绑定，不启动 QQ 通道", async () => {
    // 夹具默认未启用（避免构造期就起通道）；这条用例要走「已启用但无凭据」。
    ioHarness.settings.enabled = true;
    await (p as unknown as { startQqIfEnabled: () => Promise<void> }).startQqIfEnabled();
    expect(p.qq).toBeUndefined();
    expect(
      posted.some(
        (m) => (m as { message?: string }).message?.includes("尚未扫码绑定"),
      ),
    ).toBe(true);
  });

  it("扫码 start：推二维码，成功后写凭据并启动官方 service", async () => {
    await p.handleQqManagedSetup("start");

    const qr = posted.filter((m) => (m as { type?: string }).type === "qqLoginQr");
    expect(qr.length).toBeGreaterThan(0);
    expect((qr[0] as { dataUrl: string }).dataUrl).toBe(VALID_PNG);
    expect(protocolCbs).not.toBeNull();

    const creds: QqBotCredentials = { appId: "app-1", appSecret: "sec-1" };
    protocolCbs!.onSuccess(creds);
    await tick();

    expect(ioHarness.secrets.get(QQBOT_APP_ID_SECRET_KEY)).toBe("app-1");
    expect(ioHarness.secrets.get(QQ_SECRET_KEYS.appSecret)).toBe("sec-1");
    // 首次绑定自动开启远程任务；先启动再落盘，不会重复启动。
    expect(ioHarness.writes).toContainEqual({ enabled: true });
    expect(ioHarness.settings.enabled).toBe(true);
    expect(p.qq?.config?.enabled).toBe(true);
    expect(adapter.setEventCallback).toHaveBeenCalledOnce();
    expect(adapter.connect).toHaveBeenCalledOnce();
    expect(p.qq?.qqbot?.adapter).toBeTruthy();
    expect(protocolStop).toHaveBeenCalled();

    // 成功必须清屏：qqLoginQr 是独立通道，不覆盖就会残留旧二维码 + 倒计时。
    const confirmed = posted.find(
      (m) => m.type === "qqLoginQr" && m.phase === "confirmed",
    );
    expect(confirmed, "成功后 confirmed 清屏帧").toBeTruthy();
    expect(confirmed?.dataUrl).toBe("");
    expect(confirmed?.expiresAt).toBe(0);
    const confirmedAt = posted.indexOf(confirmed!);
    const loggedInAt = posted.findIndex(
      (m) => m.type === "qqManagedStatus" && m.phase === "logged_in",
    );
    expect(loggedInAt, "logged_in 回执").toBeGreaterThan(-1);
    expect(loggedInAt, "先撤二维码再宣布已连接").toBeGreaterThan(confirmedAt);
    expect(
      posted.some((m) => m.type === "qqStatus" && m.connected === true),
      "qqStatus connected=true",
    ).toBe(true);
  });

  it("扫码成功：扫码者 openid 去重写入白名单，重复扫码不重复占位", async () => {
    await p.handleQqManagedSetup("start");
    protocolCbs!.onSuccess({ appId: "app-2", appSecret: "sec-2", userOpenid: "open-self" });
    await tick();

    expect(ioHarness.writes).toContainEqual({ allowedUsers: ["10001", "open-self"] });
    expect(
      (p.qq?.config as { allowedUsers?: string[] } | undefined)?.allowedUsers,
    ).toEqual(["10001", "open-self"]);
    expect(p.qq).toBeTruthy();

    // 再扫一次（同一 openid）不应重复占位。
    await p.handleQqManagedSetup("start");
    protocolCbs!.onSuccess({ appId: "app-2", appSecret: "sec-2", userOpenid: "open-self" });
    await tick();
    expect(ioHarness.settings.allowedUsers).toEqual(["10001", "open-self"]);
  });

  it("扫码绑定以磁盘最新白名单为基准：另一个窗口新增的条目与备注不被内存快照覆盖", async () => {
    // 本窗口内存里只有扫码者本人；扫码流程开始后，另一个窗口在磁盘上写入
    // 用户 A（带备注）。旧实现会用内存快照整体覆盖，把 A 抹掉。
    ioHarness.settings.allowedUsers = ["mem-b"];
    await p.handleQqManagedSetup("start");
    ioHarness.settings.allowedUsers = [{ openid: "user-a", note: "同事" }];

    protocolCbs!.onSuccess({ appId: "app-3", appSecret: "sec-3", userOpenid: "mem-b" });
    await tick();

    expect(ioHarness.settings.allowedUsers).toEqual([
      { openid: "user-a", note: "同事" },
      "mem-b",
    ]);
    expect(
      (p.qq?.config as { allowedUsers?: string[] } | undefined)?.allowedUsers,
    ).toEqual(["user-a", "mem-b"]);
  });

  it("白名单为空也能启动（allowlist_empty 只是提示，不拦启动）", async () => {
    ioHarness.settings.enabled = true;
    ioHarness.settings.allowedUsers = [];
    ioHarness.secrets.set(QQBOT_APP_ID_SECRET_KEY, "app-x");
    ioHarness.secrets.set(QQ_SECRET_KEYS.appSecret, "sec-x");

    await (p as unknown as { startQqIfEnabled: () => Promise<void> }).startQqIfEnabled();

    expect(p.qq).toBeTruthy();
    expect(adapter.connect).toHaveBeenCalledOnce();
    expect(
      posted.some((m) => m.type === "qqStatus" && m.connected === true),
      "白名单空不得拒启动",
    ).toBe(true);
  });

  it("扫码失败：推脱敏 error，不留扫码会话", async () => {
    await p.handleQqManagedSetup("start");
    protocolCbs!.onFailure("app_secret=LEAK 失败");
    await tick();
    const errors = posted.filter(
      (m) => (m as { type?: string; phase?: string }).type === "qqManagedStatus" &&
        (m as { phase?: string }).phase === "error",
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(posted)).not.toContain("LEAK");
    expect(p.qqbotBinding).toBeNull();
  });

  it("stopQq：关闭 adapter 并清空绑定会话，幂等", async () => {
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

  it("qqManagedSetup / startQrLogin 经 webview → host 通道进入官方扫码", async () => {
    const spy = vi.spyOn(p, "handleQqManagedSetup").mockResolvedValue(undefined);
    await p.handleWebviewMessage({ type: "qqManagedSetup", action: "start" });
    expect(spy).toHaveBeenCalledWith("start");
    spy.mockRestore();

    await p.handleQqConfigAction("startQrLogin");
    expect(protocolCbs).not.toBeNull();
    await p.handleQqConfigAction("cancelQrLogin");
    expect(protocolStop).toHaveBeenCalled();
    expect(p.qqbotBinding).toBeNull();
  });

  it("并发启动只建一套 owner（配置事件路径与绑定路径共用同一份启动）", async () => {
    ioHarness.settings.enabled = true;
    ioHarness.secrets.set(QQBOT_APP_ID_SECRET_KEY, "app-1");
    ioHarness.secrets.set(QQ_SECRET_KEYS.appSecret, "sec-1");
    const internals = p as unknown as {
      currentQqConfig: () => Promise<unknown>;
      qqGeneration: number;
    };
    const config = await internals.currentQqConfig();
    const generation = internals.qqGeneration;

    // 两个路径同时到达：同步占位保证只有一份启动在跑。
    await Promise.all([
      p.startQqBotChannel(config, ioHarness.io, generation),
      p.startQqBotChannel(config, ioHarness.io, generation),
    ]);

    expect(adapter.connect).toHaveBeenCalledTimes(1);
    expect(p.qq).toBeTruthy();
  });

  it("首绑启动途中配置事件读到 enabled=false 也不会反杀正在建的通道", async () => {
    let releaseConnect!: () => void;
    adapter.connect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseConnect = resolve;
        }),
    );

    await p.handleQqManagedSetup("start");
    protocolCbs!.onSuccess({ appId: "app-1", appSecret: "sec-1" });

    // 等 adapter.connect 真正进入在飞状态。
    const deadline = Date.now() + 1_000;
    while (adapter.connect.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(adapter.connect).toHaveBeenCalledTimes(1);

    // 首绑尚未把 enabled 落盘：此刻配置事件路径会读到 false，旧实现会
    // 在 stopQq 里把半成品通道拆掉。
    ioHarness.settings.enabled = false;
    await (p as unknown as { syncQqServiceWithSettings: () => Promise<void> }).syncQqServiceWithSettings();

    expect(p.qq).toBeTruthy();
    releaseConnect();
    await tick();
    expect(p.qq).toBeTruthy();
    expect(adapter.connect).toHaveBeenCalledTimes(1);
  });
});
