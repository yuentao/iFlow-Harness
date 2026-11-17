// @vitest-environment jsdom
/**
 * QQBot 窗口内扫码的 UI 接线。
 *
 * 用真实 store（只 mock `acquireVsCodeApi`）挂载设置弹窗，因此同时验证：
 *  - 两条宿主回执（qqLoginQr / qqManagedStatus）被 store 收下且不被快照覆盖；
 *  - QqSettings 的按钮把正确消息 post 给宿主；
 *  - 二维码 dataUrl 过 isQrDataUrl 护栏后才渲染 <img>。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUiState } from "../shared/messages";

/** jsdom ships neither ResizeObserver nor scrollIntoView; the kit controls
 * need the members to exist. */
if (!("ResizeObserver" in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
/** No layout in jsdom: the kit's menu visibility filter reads offsetParent. */
Object.defineProperty(HTMLElement.prototype, "offsetParent", {
  configurable: true,
  get: () => document.body,
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const postMessage = vi.fn();
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({ postMessage });

const { useChat } = await import("../webview/src/store");
const { SettingsModal } = await import("../webview/src/components/SettingsModal");
const { initialSessionState, isQrDataUrl, pickQqSettingsUi } = await import("../shared/messages");

const AUTH: AuthUiState = {
  authenticated: true,
  needsSetup: false,
  saved: null,
  profiles: [],
  onboardingDismissed: true,
};

/** A strictly valid data:image/png;base64 URL (isQrDataUrl accepts it). */
const QR_URL = "data:image/png;base64," + btoa("fake-qr-png-bytes");
/** A forbidden SVG data URL — must never reach <img src>. */
const BAD_URL = "data:image/svg+xml;base64," + btoa("<svg/>");

let root: Root;
let container: HTMLDivElement;

function render(): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <SettingsModal
        tab="qq"
        onTabChange={() => {}}
        onDismiss={() => {}}
        dismissible
        busy={false}
        auth={AUTH}
      />,
    ),
  );
}

/** Click one of the three QR actions, scoped to the row that owns them so a
 * same-labelled button on another settings sub-page can never be hit. */
function clickQrAction(text: string): void {
  const refresh = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "刷新二维码",
  );
  expect(refresh, "刷新二维码 button").toBeTruthy();
  const row = refresh!.parentElement!;
  const button = [...row.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  expect(button, `QR action 「${text}」`).toBeTruthy();
  act(() => button!.click());
}

function qr(overrides: {
  dataUrl?: string;
  phase?: "waiting_scan" | "scanned" | "confirmed" | "expired";
  detail?: string;
  expiresAt?: number;
} = {}): void {
  act(() =>
    useChat.getState().applyHostMessage({
      type: "qqLoginQr",
      dataUrl: overrides.dataUrl ?? QR_URL,
      expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
      phase: overrides.phase ?? "waiting_scan",
      ...(overrides.detail !== undefined ? { detail: overrides.detail } : {}),
    }),
  );
}

function managed(
  phase: "idle" | "checking" | "downloading" | "configuring" | "starting" | "waiting_login" | "logged_in" | "error",
  message = "进度说明",
  progress?: number,
): void {
  act(() =>
    useChat.getState().applyHostMessage({
      type: "qqManagedStatus",
      phase,
      message,
      ...(progress !== undefined ? { progress } : {}),
    }),
  );
}

/** Switch the store's QQ settings to a given adapter before rendering. */
function setAdapter(adapter: "onebot" | "qqbot"): void {
  act(() =>
    useChat.setState({
      qqSettings: pickQqSettingsUi(
        { adapter },
        { hasBotToken: false, hasAppSecret: false },
      ),
    }),
  );
}

beforeEach(() => {
  postMessage.mockClear();
  useChat.setState({
    state: null,
    qqSettings: pickQqSettingsUi({}, { hasBotToken: false, hasAppSecret: false }),
    qqStatus: null,
    qqBindCode: null,
    qqLoginQr: null,
    qqManagedStatus: null,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("窗口内扫码", () => {
  it("合法 dataUrl 渲染 img（src/alt），并显示剩余倒计时", () => {
    qr();
    render();
    const img = container.querySelector("img")!;
    expect(img, "二维码 img").toBeTruthy();
    expect(img.getAttribute("src")).toBe(QR_URL);
    expect(img.getAttribute("alt")).toBe("QQ 登录二维码");
    expect(container.textContent).toContain("剩余");
  });

  it("expired 不渲染 img 且提示刷新", () => {
    qr({ phase: "expired" });
    render();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("二维码已过期，请刷新");
  });

  it("confirmed 不渲染 img 且提示正在完成登录", () => {
    qr({ phase: "confirmed" });
    render();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("已确认，正在完成登录");
  });

  it("isQrDataUrl 拦截非法 dataUrl：不渲染 img 也不崩", () => {
    expect(isQrDataUrl(BAD_URL)).toBe(false);
    qr({ dataUrl: BAD_URL, phase: "waiting_scan" });
    render();
    expect(container.querySelector("img")).toBeNull();
  });

  it("detail 非空时展示（且不回显端点/Token 明文）", () => {
    qr({ phase: "expired", detail: "二维码已被另一设备使用" });
    render();
    expect(container.textContent).toContain("二维码已被另一设备使用");
    expect(container.textContent).not.toContain("http://");
    expect(container.textContent).not.toContain("secret-token");
  });

  it("三个动作分别 post 正确的 qqConfigAction", () => {
    qr();
    render();
    clickQrAction("刷新二维码");
    expect(postMessage).toHaveBeenCalledWith({ type: "qqConfigAction", action: "refreshQr" });
    clickQrAction("我已扫码");
    expect(postMessage).toHaveBeenCalledWith({ type: "qqConfigAction", action: "startQrLogin" });
    clickQrAction("取消");
    expect(postMessage).toHaveBeenCalledWith({ type: "qqConfigAction", action: "cancelQrLogin" });
  });
});

describe("非快照通道", () => {
  it("snapshot 不覆盖二维码与托管进度回执", () => {
    managed("checking", "检查中");
    qr();
    act(() =>
      useChat.getState().applyHostMessage({
        type: "snapshot",
        state: initialSessionState(),
      }),
    );
    expect(useChat.getState().qqManagedStatus?.phase).toBe("checking");
    expect(useChat.getState().qqLoginQr?.dataUrl).toBe(QR_URL);
  });
});

describe("官方 QQBot 路线文案适配（M4）", () => {
  it("qqbot 模式显示官方机器人文案、通道定位与创建机器人引导", () => {
    setAdapter("qqbot");
    render();
    const text = container.textContent ?? "";
    expect(text).toContain("使用 QQ 官方机器人，扫码授权后即可从 QQ 远程控制本工作区");
    expect(text).toContain("官方合规通道（推荐）");
    expect(text).toContain("首次使用需在 q.qq.com 创建机器人（个人账号即可）。");
    expect(text).not.toContain("自动下载并配置 go-cqhttp");
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "一键接入 QQ 机器人",
    );
    expect(button, "一键接入 QQ 机器人 button").toBeTruthy();
  });

  it("qqbot 模式阶段文案用官方授权语义", () => {
    setAdapter("qqbot");
    managed("waiting_login", "等待授权");
    render();
    expect(container.textContent).toContain("请用手机 QQ 扫描二维码完成授权");
    managed("logged_in", "授权完成");
    expect(container.textContent).toContain("已连接 QQ 官方机器人");
  });

  it("qqbot 模式二维码标题为扫码授权，三个动作按钮保留", () => {
    setAdapter("qqbot");
    qr();
    render();
    expect(container.textContent).toContain("扫码授权 QQ 机器人");
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("QQ 登录二维码");
    clickQrAction("刷新二维码");
    expect(postMessage).toHaveBeenCalledWith({ type: "qqConfigAction", action: "refreshQr" });
    clickQrAction("我已扫码");
    expect(postMessage).toHaveBeenCalledWith({ type: "qqConfigAction", action: "startQrLogin" });
    clickQrAction("取消");
    expect(postMessage).toHaveBeenCalledWith({ type: "qqConfigAction", action: "cancelQrLogin" });
  });
});
