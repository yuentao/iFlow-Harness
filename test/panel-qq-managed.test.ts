/**
 * 一键托管 / 窗口内扫码的面板编排单测（Wave5-C）。
 *
 * 全程不 spawn 真实 bridge、不占真实端口、不起真 CLI：端口探测 / manager /
 * 二维码桥 / QQ 设置 IO 全部注入假实现，只钉住编排顺序与消息投影。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel, type PanelServices } from "../src/panel/panel.js";
import type { QqSettingsIo } from "../src/qq/settings-host.js";
import type {
  ManagedOneBotDeps,
  ManagedOneBotManager,
  ManagedOneBotStatus,
} from "../src/qq/managed/manager.js";
import type { QrBridge, QrBridgeDeps, QrBridgeMessage } from "../src/qq/managed/qr-bridge.js";
import type { HostToWebview, WebviewToHost } from "../shared/messages.js";
import { QR_DATA_URL_PREFIX } from "../shared/messages.js";
import { setConfigOverrides } from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_INCOMING_PORT = 19999;
const VALID_PNG = QR_DATA_URL_PREFIX + Buffer.from("qr-bytes").toString("base64");

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

/** 内存 IO：记录设置写入 / 凭据写入，返回启用中的配置快照。 */
function makeIo(): {
  io: QqSettingsIo;
  writes: Array<Record<string, unknown>>;
  secretWrites: Array<[string, string]>;
} {
  const settings: Record<string, unknown> = {
    enabled: true,
    adapter: "onebot",
    endpoint: "http://127.0.0.1:3000/",
    allowedUsers: ["10001"],
  };
  const secrets = new Map<string, string>();
  const writes: Array<Record<string, unknown>> = [];
  const secretWrites: Array<[string, string]> = [];
  const io: QqSettingsIo = {
    readAll: () => ({ ...settings }),
    writeAll: async (patch) => {
      writes.push({ ...patch });
      Object.assign(settings, patch);
    },
    getSecret: async (key) => secrets.get(key),
    setSecret: async (key, value) => {
      secrets.set(key, value);
      secretWrites.push([key, value]);
    },
    deleteSecret: async (key) => {
      secrets.delete(key);
    },
  };
  return { io, writes, secretWrites };
}

type FakeManager = {
  onStatus: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  qrCodePath: ReturnType<typeof vi.fn>;
};

function makeManagerHarness() {
  const listeners: Array<(status: ManagedOneBotStatus) => void> = [];
  const opts = { throwWithToken: false };
  let deps: ManagedOneBotDeps | undefined;
  const manager: FakeManager = {
    onStatus: vi.fn((cb: (status: ManagedOneBotStatus) => void) => {
      listeners.push(cb);
      return () => undefined;
    }),
    start: vi.fn(async () => {
      // 模拟 manager 走过的阶段（二维码出现 → 登录完成）。
      for (const cb of listeners) cb({ phase: "waiting_login", message: "请扫码" });
      for (const cb of listeners) cb({ phase: "logged_in", message: "已登录" });
      if (opts.throwWithToken && deps) {
        throw new Error(`boom token=${deps.accessToken}`);
      }
      return {
        endpoint: `http://127.0.0.1:${deps?.port ?? 5700}`,
        accessToken: deps?.accessToken ?? "",
        alreadyRunning: false,
      };
    }),
    stop: vi.fn(async () => undefined),
    qrCodePath: vi.fn(() => path.join(here, "qr", "qrcode.png")),
  };
  const factory = (d: ManagedOneBotDeps): ManagedOneBotManager => {
    deps = d;
    return manager as unknown as ManagedOneBotManager;
  };
  return {
    manager,
    factory,
    getDeps: () => deps!,
    setThrow: (value: boolean) => {
      opts.throwWithToken = value;
    },
    emit: (s: ManagedOneBotStatus) => listeners.forEach((cb) => cb(s)),
  };
}

function makeQrHarness() {
  let current: QrBridgeMessage | null = null;
  const bridge = {
    start: vi.fn((onMessage: (msg: QrBridgeMessage) => void) => {
      current = {
        type: "qqLoginQr",
        dataUrl: VALID_PNG,
        expiresAt: Date.now() + 60_000,
        phase: "waiting_scan",
      };
      onMessage(current);
    }),
    stop: vi.fn(),
    refresh: vi.fn(),
    current: vi.fn(() => current),
  };
  const factory = (_deps: QrBridgeDeps): QrBridge => bridge as unknown as QrBridge;
  return { bridge, factory };
}

type PanelInternals = {
  qq?: { managed?: unknown; qrBridge?: unknown; io: QqSettingsIo; [k: string]: unknown };
  handleWebviewMessage: (msg: WebviewToHost) => Promise<void>;
  handleQqManagedSetup: (action: "start" | "stop") => Promise<void>;
  handleQqConfigAction: (action: string) => Promise<void>;
  pushQqState: () => void;
  postToWebview: (msg: HostToWebview) => void;
  qqIncomingPort: number | null;
  [k: string]: unknown;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("QQ 一键托管 · 面板编排（Wave5-C）", () => {
  let storageDir: string;
  let posted: HostToWebview[];
  let ioHarness: ReturnType<typeof makeIo>;
  let managerHarness: ReturnType<typeof makeManagerHarness>;
  let qrHarness: ReturnType<typeof makeQrHarness>;
  let portProbe: ReturnType<typeof vi.fn>;
  let panel: ChatPanel;
  let p: PanelInternals;

  function createPanel(): void {
    managerHarness = makeManagerHarness();
    qrHarness = makeQrHarness();
    portProbe = vi.fn(async () => ({ kind: "free" }));
    const services: PanelServices = {
      workspaceRoot: here,
      watchers: makeWatchers(),
      qqSettingsIo: ioHarness.io,
      qqManagedDeps: {
        portProbe,
        managerFactory: managerHarness.factory,
        qrBridgeFactory: qrHarness.factory,
        bridgeStarter: () => {
          // 假 bridge_ready：直接写入 sink 端口，不 spawn、不占端口。
          (panel as unknown as PanelInternals).qqIncomingPort = FAKE_INCOMING_PORT;
        },
      },
    };
    panel = new ChatPanel(makeContext(storageDir), services);
    p = panel as unknown as PanelInternals;
  }

  beforeEach(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-managed-"));
    setConfigOverrides({
      enabled: true,
      adapter: "onebot",
      endpoint: "http://127.0.0.1:3000/",
      allowedUsers: ["10001"],
    });
    ioHarness = makeIo();
    posted = [];
    createPanel();
    await tick(); // 构造函数的 startQqIfEnabled 落定
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

  it("start：探测 5700 → 用 sink 端口构造反向上报 → 跑 manager → 写设置并挂回 manager", async () => {
    await p.handleQqManagedSetup("start");

    // 1) 端口探测用固定 5700 和生成的 accessToken。
    expect(portProbe).toHaveBeenCalledWith(5700, expect.any(String));
    const token = portProbe.mock.calls[0]![1] as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // 2) manager 收到由 bridge_ready 入站端口构造的反向上报地址。
    const deps = managerHarness.getDeps();
    expect(deps.reversePostUrl).toBe(`http://127.0.0.1:${FAKE_INCOMING_PORT}/onebot/event`);
    expect(deps.port).toBe(5700);
    expect(deps.accessToken).toBe(token);
    expect(deps.installDir).toBe(path.join(storageDir, "qq", "managed"));

    // 3) manager 跑完，二维码桥在 waiting_login 起、logged_in 停。
    expect(managerHarness.manager.start).toHaveBeenCalled();
    expect(qrHarness.bridge.start).toHaveBeenCalled();
    expect(qrHarness.bridge.stop).toHaveBeenCalled();

    // 4) 成功设置补丁：endpoint + enabled；botToken 与 accessToken 同值。
    expect(ioHarness.writes.some((w) => w.enabled === true && w.endpoint === "http://127.0.0.1:5700")).toBe(true);
    expect(ioHarness.secretWrites.some(([, v]) => v === token)).toBe(true);

    // 5) manager 挂回重建后的现场，供后续 stopQq 收掉。
    expect((p.qq as { managed?: unknown } | undefined)?.managed).toBe(managerHarness.manager);

    // 6) 进度消息推到 webview，且 token 不泄漏。
    const statuses = messages("qqManagedStatus");
    expect(statuses.length).toBeGreaterThan(0);
    expect(JSON.stringify(posted)).not.toContain(token);
  });

  it("端口被占用：报「端口 5700 被占用」并停止，绝不构造/启动 manager", async () => {
    portProbe.mockResolvedValueOnce({ kind: "occupied" });
    await p.handleQqManagedSetup("start");

    const errors = messages("qqManagedStatus").filter(
      (m) => (m as { phase?: string }).phase === "error",
    );
    expect(errors.some((m) => (m as { message: string }).message.includes("端口 5700 被占用"))).toBe(true);
    expect(managerHarness.manager.start).not.toHaveBeenCalled();
    expect(ioHarness.writes).toEqual([]);
  });

  it("manager 失败：推脱敏错误、停 manager、不写设置、不留半启动现场", async () => {
    // 让 manager 抛一个带真 token 的错误，验证状态消息里被脱敏。
    portProbe.mockImplementation(async () => ({ kind: "onebot" }));
    managerHarness.setThrow(true);
    posted.length = 0;

    await p.handleQqManagedSetup("start");

    const token = managerHarness.getDeps().accessToken;
    expect(managerHarness.manager.stop).toHaveBeenCalled();
    expect(ioHarness.writes).toEqual([]);
    expect(JSON.stringify(posted)).not.toContain(token);
    expect(JSON.stringify(posted)).toContain("[REDACTED]");
  });

  it("startQrLogin / refreshQr / cancelQrLogin 三动作与无现场防御", async () => {
    // 无现场：三个动作都安静返回，不抛错。
    await expect(p.handleQqConfigAction("startQrLogin")).resolves.toBeUndefined();
    await expect(p.handleQqConfigAction("refreshQr")).resolves.toBeUndefined();
    await expect(p.handleQqConfigAction("cancelQrLogin")).resolves.toBeUndefined();

    // 挂一份含 manager、无二维码桥的最小现场。
    (p as { qq: unknown }).qq = {
      managed: managerHarness.manager,
      qrBridge: undefined,
      io: ioHarness.io,
    };

    posted.length = 0;
    await p.handleQqConfigAction("startQrLogin");
    expect(qrHarness.bridge.start).toHaveBeenCalled();
    expect(messages("qqLoginQr").length).toBeGreaterThan(0);

    await p.handleQqConfigAction("refreshQr");
    expect(qrHarness.bridge.refresh).toHaveBeenCalledTimes(1);

    await p.handleQqConfigAction("cancelQrLogin");
    expect(qrHarness.bridge.stop).toHaveBeenCalled();
    expect((p.qq as { qrBridge?: unknown } | undefined)?.qrBridge).toBeUndefined();
    const cleared = messages("qqLoginQr").filter((m) => (m as { phase: string }).phase === "expired");
    expect(cleared.some((m) => (m as { dataUrl: string }).dataUrl === "")).toBe(true);
  });

  it("面板打开/刷新时补推二维码缓存帧", () => {
    // 先让二维码桥产生一帧缓存（真实场景是 waiting_login 阶段轮询出来的）。
    qrHarness.bridge.start(() => undefined);
    (p as { qq: unknown }).qq = {
      managed: managerHarness.manager,
      qrBridge: qrHarness.bridge,
      io: ioHarness.io,
    };
    posted.length = 0;
    p.pushQqState();
    expect(messages("qqLoginQr").length).toBeGreaterThan(0);
  });

  it("stopQq：先停二维码桥、再停 manager（顺序固定）", async () => {
    const order: string[] = [];
    qrHarness.bridge.stop.mockImplementation(() => {
      order.push("qr");
    });
    managerHarness.manager.stop.mockImplementation(async () => {
      order.push("manager");
    });
    (p as { qq: unknown }).qq = {
      managed: managerHarness.manager,
      qrBridge: qrHarness.bridge,
      io: ioHarness.io,
      service: { stop: async () => undefined, listTasks: () => [] },
      store: {},
      ipc: { port: 0, close: async () => undefined },
      restartCount: 0,
    };

    await (p as unknown as { stopQq: () => Promise<void> }).stopQq();
    expect(order).toEqual(["qr", "manager"]);
    expect(p.qq).toBeUndefined();
  });

  it("stop 动作推 idle，不写回 disabled", async () => {
    await p.handleQqManagedSetup("stop");
    const idle = messages("qqManagedStatus").filter((m) => (m as { phase: string }).phase === "idle");
    expect(idle.length).toBeGreaterThan(0);
    expect(ioHarness.writes.some((w) => w.enabled === false)).toBe(false);
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
