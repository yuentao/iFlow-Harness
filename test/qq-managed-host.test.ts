/**
 * 一键托管宿主侧纯函数单测（Wave5-C）。
 *
 * 这里只钉住不碰 vscode / 不 spawn 进程的纯逻辑：URL 构造、阶段/二维码映射、
 * token 脱敏、设置补丁构造，以及注入式端口占用探测的三态判定。
 */
import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import {
  QQ_MANAGED_ONEBOT_PORT,
  ONEBOT_POST_PATH,
  buildClearedQrMessage,
  buildManagedEndpoint,
  buildManagedSettingsUpdate,
  buildReversePostUrl,
  managedInstallDir,
  probeManagedPort,
  qrBridgeActiveForPhase,
  redactManagedToken,
  sanitizeQrMessage,
  toManagedStatusMessage,
} from "../src/panel/qq-managed-host.js";
import { QR_DATA_URL_PREFIX } from "../shared/messages.js";

const VALID_PNG = QR_DATA_URL_PREFIX + Buffer.from("fake-png-bytes").toString("base64");

describe("qq-managed-host · 常量与路径", () => {
  it("OneBot 端口固定 go-cqhttp 默认 5700，反向上报路径 /onebot/event", () => {
    expect(QQ_MANAGED_ONEBOT_PORT).toBe(5700);
    expect(ONEBOT_POST_PATH).toBe("/onebot/event");
  });

  it("安装目录落在 globalStorage/qq/managed", () => {
    expect(managedInstallDir(path.join("C:", "base"))).toBe(
      path.join("C:", "base", "qq", "managed"),
    );
  });
});

describe("qq-managed-host · URL 构造", () => {
  it("反向上报地址带 bridge 入站端口与 /onebot/event", () => {
    expect(buildReversePostUrl(19999)).toBe("http://127.0.0.1:19999/onebot/event");
  });

  it("非法入站端口抛错（0 / 负数 / 小数 / 越界）", () => {
    for (const port of [0, -1, 1.5, 65536, Number.NaN]) {
      expect(() => buildReversePostUrl(port)).toThrow();
    }
  });

  it("endpoint 由 OneBot 端口构造", () => {
    expect(buildManagedEndpoint(5700)).toBe("http://127.0.0.1:5700");
    expect(() => buildManagedEndpoint(0)).toThrow();
  });
});

describe("qq-managed-host · token 脱敏", () => {
  it("把所有出现的 token 换成 [REDACTED]，token 为空时原样返回", () => {
    expect(redactManagedToken(" Bearer abc123 and abc123 ", "abc123")).toBe(
      " Bearer [REDACTED] and [REDACTED] ",
    );
    expect(redactManagedToken("plain text", undefined)).toBe("plain text");
  });

  it("manager 阶段消息里的 token 不透传，progress 只在数值时携带", () => {
    const msg = toManagedStatusMessage(
      { phase: "error", message: "request failed with token abc123", progress: 42 },
      "abc123",
    );
    expect(msg).toEqual({
      type: "qqManagedStatus",
      phase: "error",
      message: "request failed with token [REDACTED]",
      progress: 42,
    });
    expect(JSON.stringify(msg)).not.toContain("abc123");

    const noProgress = toManagedStatusMessage({ phase: "checking", message: "检查中" });
    expect(noProgress).toEqual({ type: "qqManagedStatus", phase: "checking", message: "检查中" });
    expect("progress" in noProgress).toBe(false);
  });
});

describe("qq-managed-host · 二维码阶段映射", () => {
  it("只有 waiting_login 阶段需要二维码桥", () => {
    expect(qrBridgeActiveForPhase("waiting_login")).toBe(true);
    for (const phase of ["idle", "checking", "downloading", "configuring", "starting"] as const) {
      expect(qrBridgeActiveForPhase(phase)).toBe(false);
    }
    for (const phase of ["logged_in", "error"] as const) {
      expect(qrBridgeActiveForPhase(phase)).toBe(false);
    }
  });

  it("cancelQrLogin 的清屏帧 dataUrl 为空、phase=expired", () => {
    expect(buildClearedQrMessage(1234)).toEqual({
      type: "qqLoginQr",
      dataUrl: "",
      expiresAt: 1234,
      phase: "expired",
    });
  });

  it("非 PNG data URL 的二维码被降级成清屏帧，合法则原样透传", () => {
    const bad = sanitizeQrMessage({
      type: "qqLoginQr",
      dataUrl: "data:image/svg+xml;base64,PHN2Zz4=",
      expiresAt: 9,
      phase: "waiting_scan",
    });
    expect(bad.dataUrl).toBe("");
    expect(bad.phase).toBe("expired");

    const good = sanitizeQrMessage({
      type: "qqLoginQr",
      dataUrl: VALID_PNG,
      expiresAt: 9,
      phase: "waiting_scan",
    });
    expect(good.dataUrl).toBe(VALID_PNG);
    expect(good.phase).toBe("waiting_scan");
  });
});

describe("qq-managed-host · 成功后设置补丁", () => {
  it("endpoint / enabled 走设置补丁，accessToken 作为 botToken 走 SecretStorage", () => {
    const update = buildManagedSettingsUpdate(5700, "top-secret-token");
    expect(update.patch).toEqual({ enabled: true, endpoint: "http://127.0.0.1:5700" });
    expect(update.secrets).toEqual({ botToken: "top-secret-token" });
  });
});

describe("qq-managed-host · 端口占用探测", () => {
  it("连不上 = free，且不会调用 get_login_info", async () => {
    const getLogin = vi.fn(async () => true);
    await expect(
      probeManagedPort(5700, "tok", { connectTcp: async () => false, getLoginInfo: getLogin }),
    ).resolves.toEqual({ kind: "free" });
    expect(getLogin).not.toHaveBeenCalled();
  });

  it("连上且 get_login_info 应答 OneBot = onebot（manager 可复用）", async () => {
    await expect(
      probeManagedPort(5700, "tok", {
        connectTcp: async () => true,
        getLoginInfo: async () => true,
      }),
    ).resolves.toEqual({ kind: "onebot" });
  });

  it("连上但 get_login_info 不通 = occupied（拒绝，不拿别人的实例）", async () => {
    await expect(
      probeManagedPort(5700, "tok", {
        connectTcp: async () => true,
        getLoginInfo: async () => false,
      }),
    ).resolves.toEqual({ kind: "occupied" });
  });

  it("把端口和 token 透传给注入的两端（含正确 host）", async () => {
    const connectTcp = vi.fn(async () => true);
    const getLoginInfo = vi.fn(async () => true);
    await probeManagedPort(5700, "my-token", { connectTcp, getLoginInfo });
    expect(connectTcp).toHaveBeenCalledWith(5700, "127.0.0.1", 1500);
    expect(getLoginInfo).toHaveBeenCalledWith(5700, "my-token", 2000);
  });
});
