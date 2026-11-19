/**
 * QQBot 宿主编排的纯逻辑锚点（M3-C）。
 *
 * 不打网络、不 spawn、不 import vscode：只钉住分流、setEventCallback 接缝、
 * 扫码回调 → webview 消息映射、凭据落盘与内联 QR PNG 渲染。
 */
import { describe, it, expect, vi } from "vitest";
import { isQrDataUrl, QR_DATA_URL_PREFIX } from "../shared/messages.js";
import { QQ_SECRET_KEYS } from "../src/qq/config.js";
import type { InboundMessage, OutboundMessage } from "../src/qq/adapter/types.js";
import type { QqBotQrProtocolLike, QqBotCredentials } from "../src/qq/qqbot/bind.js";
import {
  QQBOT_APP_ID_SECRET_KEY,
  buildConfirmedQrMessage,
  createQqBotBindRuntime,
  createQqChannelDispatch,
  deliverViaQqBotAdapter,
  qrFailureMessage,
  qrProgressMessage,
  qrReadyMessage,
  readQqBotCredentials,
  renderQrPng,
  sanitizeQrLoginMessage,
  storeQqBotCredentials,
} from "../src/panel/qqbot-host.js";

const VALID_PNG = QR_DATA_URL_PREFIX + Buffer.from("fake-png-bytes").toString("base64");
const INBOUND: InboundMessage = {
  chatType: "private",
  chatId: "u1",
  senderId: "u1",
  msgId: "m1",
  text: "hello",
  mentionsBot: true,
  attachments: [],
  timestamp: 1,
};

function fakeAdapter() {
  return {
    setEventCallback: vi.fn(),
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    send: vi.fn(async (_msg: OutboundMessage) => ({ ok: true as const, messageId: "x" })),
  };
}

describe("QQBot 宿主编排（M3-C）", () => {
  it("分流恒走 QQBot：任意 adapter 都构造官方 adapter 并接 setEventCallback", () => {
    const factory = vi.fn(fakeAdapter);
    // 收敛到 QQBot 单一路径后，config.adapter 不再影响分流；即便是遗留的
    // "legacy" 值也恒走官方 adapter，绝不再返回无副作用的分支。
    const legacy = createQqChannelDispatch(
      { adapter: "legacy" },
      { appId: "a", appSecret: "s", onInbound: () => undefined, adapterFactory: factory as never },
    );
    expect(legacy.kind).toBe("qqbot");
    expect(factory).toHaveBeenCalledOnce();

    const onInbound = vi.fn();
    const qqbot = createQqChannelDispatch(
      { adapter: "qqbot" },
      { appId: "app", appSecret: "sec", onInbound, adapterFactory: factory as never },
    );
    expect(qqbot.kind).toBe("qqbot");
    expect(factory).toHaveBeenCalledTimes(2);
    expect(qqbot.kind === "qqbot" && qqbot.adapter.setEventCallback).toHaveBeenCalled();

    // 事件出口：M2 的 setEventCallback 接缝必须把入站消息交给 service。
    const handler = factory.mock.results[1]!.value.setEventCallback.mock.calls[0]![0] as (
      msg: InboundMessage,
    ) => void;
    handler(INBOUND);
    expect(onInbound).toHaveBeenCalledWith(INBOUND);
  });

  it("出站投递：QqService 契约翻译成 OutboundMessage，失败如实回报 retryable", async () => {
    const adapter = fakeAdapter();
    await expect(
      deliverViaQqBotAdapter(adapter, {
        chatType: "group",
        chatId: "g1",
        text: "hi",
        replyToMsgId: "m0",
      }),
    ).resolves.toEqual({ ok: true });
    expect(adapter.send).toHaveBeenCalledWith({
      chatType: "group",
      chatId: "g1",
      text: "hi",
      replyToMsgId: "m0",
    });
    adapter.send.mockResolvedValueOnce({ ok: false, error: "x", retryable: true } as never);
    await expect(
      deliverViaQqBotAdapter(adapter, { chatType: "private", chatId: "u", text: "t" }),
    ).resolves.toEqual({ ok: false, retryable: true });
    // 确定性拒绝（retryable:false）也要原样透传，服务据此短路不重试。
    adapter.send.mockResolvedValueOnce({ ok: false, error: "403", retryable: false } as never);
    await expect(
      deliverViaQqBotAdapter(adapter, { chatType: "private", chatId: "u", text: "t" }),
    ).resolves.toEqual({ ok: false, retryable: false });
  });

  it("扫码回调映射：onQr / onProgress / onFailure 走注入协议，失败文案脱敏", async () => {
    let protocolCbs: Parameters<QqBotQrProtocolLike["start"]>[0] | null = null;
    const stop = vi.fn();
    const protocol: QqBotQrProtocolLike = {
      start: async (cbs) => {
        protocolCbs = cbs;
        return stop;
      },
    };
    const { session } = createQqBotBindRuntime({
      renderQr: async () => VALID_PNG,
      protocolFactory: () => protocol,
    });
    const cbs = {
      onQr: vi.fn(),
      onProgress: vi.fn(),
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
    };
    await session.start(cbs);
    expect(protocolCbs).not.toBeNull();

    protocolCbs!.onQr(VALID_PNG, 123);
    expect(cbs.onQr).toHaveBeenCalledWith(VALID_PNG, 123);
    const qr = qrReadyMessage(VALID_PNG, 123);
    expect(qr).toEqual({ type: "qqLoginQr", dataUrl: VALID_PNG, expiresAt: 123, phase: "waiting_scan" });

    protocolCbs!.onFailure("app_secret=SUPERSECRET 扫码失败");
    expect(cbs.onFailure).toHaveBeenCalledWith(expect.not.stringContaining("SUPERSECRET"));
    expect(qrFailureMessage("appSecret=abc123 扫码失败").message).not.toContain("abc123");
    expect(qrProgressMessage("scanned").phase).toBe("waiting_login");
    expect(qrProgressMessage("confirmed").phase).toBe("logged_in");

    const creds: QqBotCredentials = { appId: "app", appSecret: "sec" };
    protocolCbs!.onSuccess(creds);
    expect(cbs.onSuccess).toHaveBeenCalledWith(creds);
    session.stop();
    expect(stop).toHaveBeenCalled();
  });

  it("非法 dataUrl 退化成清屏帧，绝不塞进 img", () => {
    expect(isQrDataUrl(VALID_PNG)).toBe(true);
    expect(sanitizeQrLoginMessage(qrReadyMessage(VALID_PNG, 1)).dataUrl).toBe(VALID_PNG);
    const bad = sanitizeQrLoginMessage(qrReadyMessage("javascript:alert(1)", 1));
    expect(bad).toMatchObject({ dataUrl: "", phase: "expired" });
  });

  it("绑定成功清屏帧：空 dataUrl + phase=confirmed + expiresAt=0", () => {
    const frame = buildConfirmedQrMessage();
    expect(frame).toEqual({ type: "qqLoginQr", dataUrl: "", expiresAt: 0, phase: "confirmed" });
    // 空串过不了护栏 —— webview 即使还没收到 connected 状态也不会渲染旧码。
    expect(isQrDataUrl(frame.dataUrl)).toBe(false);
  });

  it("凭据写 SecretStorage 的两个键；不完整凭据不落盘", async () => {
    const secrets = new Map<string, string>();
    const io = {
      getSecret: async (k: string) => secrets.get(k),
      setSecret: async (k: string, v: string) => {
        secrets.set(k, v);
      },
    };
    await storeQqBotCredentials(io, { appId: " app ", appSecret: " sec ", userOpenid: "o" });
    expect(secrets.get(QQBOT_APP_ID_SECRET_KEY)).toBe("app");
    expect(secrets.get(QQ_SECRET_KEYS.appSecret)).toBe("sec");
    expect(await readQqBotCredentials(io)).toEqual({ appId: "app", appSecret: "sec" });
    await expect(storeQqBotCredentials(io, { appId: "", appSecret: "sec" })).rejects.toThrow(
      /不完整/,
    );
  });

  it("renderQrPng 产出真实可扫描 PNG（严格 data:image/png;base64 前缀）", async () => {
    const url = `https://q.qq.com/qqbot/openclaw/connect.html?task_id=${"x".repeat(60)}&source=iflow-harness&_wv=2`;
    const dataUrl = await renderQrPng(url);
    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(isQrDataUrl(dataUrl)).toBe(true);
    const png = Buffer.from(dataUrl.slice(QR_DATA_URL_PREFIX.length), "base64");
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // PNG signature
    expect(png.toString("latin1")).toContain("IHDR");
    await expect(renderQrPng("")).rejects.toThrow(/为空/);
  });
});
