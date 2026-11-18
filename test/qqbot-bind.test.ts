import { describe, expect, it, vi } from "vitest";
import {
  QqBotBindSession,
  type QqBotBindDeps,
  type QrSessionCallbacks,
} from "../src/qq/qqbot/bind.js";
import { QR_DATA_URL_PREFIX } from "../shared/messages.js";

type SdkCbs = Parameters<QqBotBindDeps["startQrConnect"]>[0];
type SdkOpts = Parameters<QqBotBindDeps["startQrConnect"]>[1];

const QR_URL = "https://q.qq.com/qqbot/openclaw/connect.html?task_id=abc&source=iflow-harness";
/** 合法但很短的 PNG data URL（base64 长度 12，4 的倍数，末尾一个填充）。 */
const VALID_PNG = QR_DATA_URL_PREFIX + "iVBORw0KGgo=";
const NOW = 1_700_000_000_000;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeCallbacks(): QrSessionCallbacks {
  return {
    onQr: vi.fn(),
    onProgress: vi.fn(),
    onSuccess: vi.fn(),
    onFailure: vi.fn(),
  };
}

function makeHarness(over: Partial<QqBotBindDeps> = {}) {
  const holder: { sdk?: SdkCbs; opts?: SdkOpts } = {};
  const stopFn = vi.fn();
  const startQrConnect = vi.fn((cbs: SdkCbs, opts: SdkOpts) => {
    holder.sdk = cbs;
    holder.opts = opts;
    return stopFn;
  });
  const deps: QqBotBindDeps = {
    startQrConnect,
    renderQr: vi.fn(async () => VALID_PNG),
    now: () => NOW,
    ttlMs: 60_000,
    source: "test-source",
    log: vi.fn(),
    ...over,
  };
  return { deps, holder, stopFn, startQrConnect };
}

// ---------------------------------------------------------------------------
// 正常流程
// ---------------------------------------------------------------------------

describe("QqBotBindSession / 扫码全流程", () => {
  it("onQr 拿到经校验的 dataUrl 与过期时间，onSuccess 拿到归一凭据", async () => {
    const h = makeHarness();
    const cbs = makeCallbacks();
    const session = new QqBotBindSession(h.deps);

    await session.start(cbs);
    expect(h.holder.opts?.displayQrCodeToConsole).toBe(false);
    expect(h.holder.opts?.source).toBe("test-source");
    expect(h.holder.opts?.signal).toBeInstanceOf(AbortSignal);

    h.holder.sdk!.onQrDisplayed(QR_URL);
    await flush();

    expect(cbs.onProgress).toHaveBeenCalledWith("waiting_scan");
    expect(cbs.onQr).toHaveBeenCalledWith(VALID_PNG, NOW + 60_000);

    h.holder.sdk!.onSuccess([{ appId: "app-1", appSecret: "sec-1", userOpenid: "open-1" }]);
    expect(cbs.onSuccess).toHaveBeenCalledWith({
      appId: "app-1",
      appSecret: "sec-1",
      userOpenid: "open-1",
    });
    expect(cbs.onFailure).not.toHaveBeenCalled();
  });

  it("onQrDisplayed 在 start 返回前同步触发也能投递二维码", async () => {
    const stopFn = vi.fn();
    const renderQr = vi.fn(async () => VALID_PNG);
    const deps: QqBotBindDeps = {
      startQrConnect: (cbs) => {
        cbs.onQrDisplayed(QR_URL);
        return stopFn;
      },
      renderQr,
      now: () => NOW,
      ttlMs: 10_000,
    };
    const cbs = makeCallbacks();

    await new QqBotBindSession(deps).start(cbs);

    // start() resolve 时渲染已完成，无需额外 flush。
    expect(renderQr).toHaveBeenCalledWith(QR_URL);
    expect(cbs.onQr).toHaveBeenCalledWith(VALID_PNG, NOW + 10_000);
    expect(cbs.onProgress).toHaveBeenCalledWith("waiting_scan");
  });

  it("expiresAt 使用注入的 now 与 ttlMs", async () => {
    const h = makeHarness({ now: () => 99, ttlMs: 1_234 });
    const cbs = makeCallbacks();
    const session = new QqBotBindSession(h.deps);

    await session.start(cbs);
    h.holder.sdk!.onQrDisplayed(QR_URL);
    await flush();

    expect(cbs.onQr).toHaveBeenCalledWith(VALID_PNG, 99 + 1_234);
  });

  it("SDK 有 onScanned / onConfirmed 时映射为阶段，不伪造", async () => {
    const h = makeHarness();
    const cbs = makeCallbacks();
    const session = new QqBotBindSession(h.deps);

    await session.start(cbs);
    h.holder.sdk!.onQrDisplayed(QR_URL);
    await flush();
    // 只到 waiting_scan，没有 SDK 事件时不自行推进。
    expect(cbs.onProgress).toHaveBeenCalledTimes(1);

    const withPhases = h.holder.sdk as SdkCbs & {
      onScanned?: (detail?: string) => void;
      onConfirmed?: (detail?: string) => void;
    };
    withPhases.onScanned?.("已扫码");
    withPhases.onConfirmed?.("已确认");

    expect(cbs.onProgress).toHaveBeenNthCalledWith(1, "waiting_scan");
    expect(cbs.onProgress).toHaveBeenNthCalledWith(2, "scanned", "已扫码");
    expect(cbs.onProgress).toHaveBeenNthCalledWith(3, "confirmed", "已确认");
  });
});

// ---------------------------------------------------------------------------
// 校验与失败路径
// ---------------------------------------------------------------------------

describe("QqBotBindSession / 安全护栏", () => {
  it("renderQr 返回非法 dataUrl 时不回调 onQr，明确 onFailure（不再静默空等）", async () => {
    const log = vi.fn();
    const h = makeHarness({
      log,
      renderQr: async () => "javascript:alert(1)",
    });
    const cbs = makeCallbacks();
    const session = new QqBotBindSession(h.deps);

    await session.start(cbs);
    h.holder.sdk!.onQrDisplayed(QR_URL);
    await flush();

    expect(cbs.onQr).not.toHaveBeenCalled();
    expect(cbs.onFailure).toHaveBeenCalledTimes(1);
    expect(cbs.onFailure).toHaveBeenCalledWith(expect.stringContaining("二维码渲染结果非法"));
    expect(log).toHaveBeenCalledWith("qrInvalid");
  });

  it("onSuccess 缺 appSecret 时按失败处理，不回半截凭据", async () => {
    const h = makeHarness();
    const cbs = makeCallbacks();
    const session = new QqBotBindSession(h.deps);
    await session.start(cbs);

    h.holder.sdk!.onSuccess([{ appId: "app-1" }]);

    expect(cbs.onSuccess).not.toHaveBeenCalled();
    expect(cbs.onFailure).toHaveBeenCalledTimes(1);
    expect(cbs.onFailure).toHaveBeenCalledWith(expect.stringContaining("appSecret"));
  });

  it("字段别名 app_id / app_secret 归一，userOpenid 可选", async () => {
    const h = makeHarness();
    const cbs = makeCallbacks();
    const session = new QqBotBindSession(h.deps);
    await session.start(cbs);

    h.holder.sdk!.onSuccess({ app_id: "app-2", app_secret: "sec-2" });
    expect(cbs.onSuccess).toHaveBeenCalledWith({ appId: "app-2", appSecret: "sec-2" });

    h.holder.sdk!.onSuccess([{ app_id: "app-3", app_secret: "sec-3", user_openid: "open-3" }]);
    expect(cbs.onSuccess).toHaveBeenLastCalledWith({
      appId: "app-3",
      appSecret: "sec-3",
      userOpenid: "open-3",
    });
  });

  it("onFailure 透传消息但抹掉 secret 回显，日志不含正文", async () => {
    const log = vi.fn();
    const h = makeHarness({ log });
    const cbs = makeCallbacks();
    const session = new QqBotBindSession(h.deps);
    await session.start(cbs);

    h.holder.sdk!.onFailure("bad appSecret=TOP_SECRET_123 end");
    const first = vi.mocked(cbs.onFailure).mock.calls[0]![0];
    expect(first).toContain("bad");
    expect(first).toContain("<redacted>");
    expect(first).not.toContain("TOP_SECRET_123");

    h.holder.sdk!.onFailure('{"app_secret":"JSON_SECRET_456","reason":"bad"}');
    const second = vi.mocked(cbs.onFailure).mock.calls[1]![0];
    expect(second).not.toContain("JSON_SECRET_456");

    expect(log).toHaveBeenCalledWith("failure");
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("TOP_SECRET_123"));
  });

  it("stop 幂等：只 abort 一次、只调一次 stop 函数，后续回调被忽略", async () => {
    const log = vi.fn();
    const h = makeHarness({ log });
    const cbs = makeCallbacks();
    const session = new QqBotBindSession(h.deps);

    await session.start(cbs);
    const signal = h.holder.opts!.signal!;
    expect(signal.aborted).toBe(false);

    session.stop();
    session.stop();

    expect(signal.aborted).toBe(true);
    expect(h.stopFn).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("stop");

    h.holder.sdk!.onSuccess([{ appId: "x", appSecret: "y" }]);
    h.holder.sdk!.onFailure("boom");
    expect(cbs.onSuccess).not.toHaveBeenCalled();
    expect(cbs.onFailure).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 二维码代次守卫（防慢渲染乱序 / stop 后发布旧二维码）
// ---------------------------------------------------------------------------

describe("QqBotBindSession / 二维码代次守卫", () => {
  it("旧渲染晚于新二维码 resolve 时不覆盖，只发布最新一张", async () => {
    const secondPng = QR_DATA_URL_PREFIX + "aGVsbG8=";
    let resolveFirst!: (value: string) => void;
    let resolveSecond!: (value: string) => void;
    const renderQr = vi
      .fn()
      .mockImplementationOnce(() => new Promise<string>((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise<string>((resolve) => (resolveSecond = resolve)));
    const h = makeHarness({ renderQr });
    const cbs = makeCallbacks();
    const session = new QqBotBindSession(h.deps);

    await session.start(cbs);
    h.holder.sdk!.onQrDisplayed(QR_URL + "&n=1");
    h.holder.sdk!.onQrDisplayed(QR_URL + "&n=2");

    // 第二张先完成 → 正常发布。
    resolveSecond(secondPng);
    await flush();
    expect(cbs.onQr).toHaveBeenCalledTimes(1);
    expect(cbs.onQr).toHaveBeenCalledWith(secondPng, NOW + 60_000);

    // 第一张（旧代次）晚到 → 必须被丢弃，不能覆盖新二维码。
    resolveFirst(VALID_PNG);
    await flush();
    expect(cbs.onQr).toHaveBeenCalledTimes(1);
    expect(cbs.onQr).toHaveBeenCalledWith(secondPng, NOW + 60_000);
  });

  it("stop 后迟到的渲染 resolve 也不再发布二维码", async () => {
    let resolveRender!: (value: string) => void;
    const h = makeHarness({
      renderQr: () => new Promise<string>((resolve) => (resolveRender = resolve)),
    });
    const cbs = makeCallbacks();
    const session = new QqBotBindSession(h.deps);

    await session.start(cbs);
    h.holder.sdk!.onQrDisplayed(QR_URL);
    session.stop();
    resolveRender(VALID_PNG);
    await flush();

    expect(cbs.onQr).not.toHaveBeenCalled();
    expect(cbs.onFailure).not.toHaveBeenCalled();
  });
});
