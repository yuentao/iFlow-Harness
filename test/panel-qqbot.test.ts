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
  writes: Array<Record<string, unknown>>;
} {
  const settings: Record<string, unknown> = { enabled: true, adapter: "qqbot", allowedUsers: ["10001"] };
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
    writes,
  };
}

type PanelInternals = {
  qq?: {
    config?: { adapter: string };
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
      adapter: "qqbot",
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
    expect(adapter.setEventCallback).toHaveBeenCalledOnce();
    expect(adapter.connect).toHaveBeenCalledOnce();
    expect(p.qq?.qqbot?.adapter).toBeTruthy();
    expect(p.qq?.config?.adapter).toBe("qqbot");
    expect(protocolStop).toHaveBeenCalled();
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
});
