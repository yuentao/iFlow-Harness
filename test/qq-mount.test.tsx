// @vitest-environment jsdom
/**
 * Wave3-C2 — QQ 远程任务的 webview 挂载。
 *
 * 覆盖两处挂载点与它们对宿主通道的接线：
 *  - 设置弹窗的「QQ 机器人」页签：吃 `qqSettings` 快照、显示连接状态与配对码、
 *    普通改动走 `qqSettingsPatch`、凭据提交走 `qqSecretsWrite`；
 *  - 看板附近的「远程任务」区：只在有任务时出现，动作走 `qqTaskAction`。
 *
 * 用真实 store（只 mock `acquireVsCodeApi`），因此同时验证了 store 对
 * `qqSettings` / `qqStatus` / `qqBindCode` 三条消息的处理不会被快照覆盖。
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUiState, QqTaskUi } from "../shared/messages";

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
const { QqTasksPanel } = await import("../webview/src/components/QqTaskList");
const { initialSessionState, pickQqSettingsUi } = await import("../shared/messages");

const AUTH: AuthUiState = {
  authenticated: true,
  needsSetup: false,
  saved: null,
  profiles: [],
  onboardingDismissed: true,
};

let root: Root;
let container: HTMLDivElement;

function render(element: ReactElement): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(element));
}

function settings(values: Record<string, unknown> = {}, secrets?: {
  hasBotToken: boolean;
  hasAppSecret: boolean;
}): void {
  act(() =>
    useChat.getState().applyHostMessage({
      type: "qqSettings",
      values: pickQqSettingsUi(values, secrets ?? { hasBotToken: false, hasAppSecret: false }),
    }),
  );
}

function setInput(el: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickText(text: string): void {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  expect(button, `button 「${text}」`).toBeTruthy();
  act(() => button!.click());
}

function task(overrides: Partial<QqTaskUi> = {}): QqTaskUi {
  return {
    taskId: "task-1",
    shortId: "A1",
    chatType: "private",
    chatId: "1234567890",
    senderId: "42",
    status: "running",
    promptPreview: "把 README 的安装段改成内网镜像",
    createdAt: 0,
    updatedAt: 30_000,
    ...overrides,
  };
}

beforeEach(() => {
  postMessage.mockClear();
  useChat.setState({
    state: null,
    qqSettings: pickQqSettingsUi({}, { hasBotToken: false, hasAppSecret: false }),
    qqStatus: null,
    qqBindCode: null,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("QQ 机器人设置页", () => {
  it("renders the qqSettings snapshot in the settings modal", () => {
    settings(
      {
        enabled: true,
        allowedUsers: ["10001"],
        maxConcurrentTasks: 4,
      },
      { hasBotToken: true, hasAppSecret: false },
    );
    render(
      <SettingsModal
        tab="qq"
        onTabChange={() => {}}
        onDismiss={() => {}}
        dismissible
        busy={false}
        auth={AUTH}
      />,
    );

    expect(container.textContent).toContain("QQ 机器人");
    const toggle = container.querySelector<HTMLButtonElement>(
      "button[role='switch'][aria-label='启用 QQ 远程任务']",
    )!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(
      container.querySelector<HTMLInputElement>("input[aria-label='同时运行的任务数']")!.value,
    ).toBe("4");
    expect(container.querySelector<HTMLInputElement>("input[aria-label='允许的用户 1']")!.value).toBe(
      "10001",
    );
    // hasBotToken 只表达「已配置」，明文永远不回传。
    expect(container.textContent).toContain("已保存；输入新值并在失焦后提交");
  });

  it("keeps QQ settings across session snapshots", () => {
    settings({ enabled: true });
    act(() =>
      useChat.getState().applyHostMessage({
        type: "snapshot",
        state: initialSessionState(),
      }),
    );
    expect(useChat.getState().qqSettings.enabled).toBe(true);
  });

  it("posts settings changes through qqSettingsPatch", () => {
    render(
      <SettingsModal
        tab="qq"
        onTabChange={() => {}}
        onDismiss={() => {}}
        dismissible
        busy={false}
        auth={AUTH}
      />,
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      "button[role='switch'][aria-label='启用 QQ 远程任务']",
    )!;
    act(() => toggle.click());
    expect(postMessage).toHaveBeenCalledWith({
      type: "qqSettingsPatch",
      patch: { enabled: true },
    });
  });

  it("submits edited credentials through qqSecretsWrite on blur", () => {
    settings({});
    render(
      <SettingsModal
        tab="qq"
        onTabChange={() => {}}
        onDismiss={() => {}}
        dismissible
        busy={false}
        auth={AUTH}
      />,
    );
    const token = container.querySelector<HTMLInputElement>("input[aria-label='机器人 Token']")!;
    act(() => token.focus());
    setInput(token, "secret-token");
    act(() => token.blur());
    expect(postMessage).toHaveBeenCalledWith({
      type: "qqSecretsWrite",
      botToken: "secret-token",
    });

    const secret = container.querySelector<HTMLInputElement>("input[aria-label='App Secret']")!;
    // 未编辑过的字段不提交：只 focus 后失焦不会清空已保存的凭据。
    act(() => secret.focus());
    act(() => secret.blur());
    const secretWrites = () =>
      postMessage.mock.calls.filter(
        ([message]) => (message as { type?: string }).type === "qqSecretsWrite",
      );
    expect(secretWrites()).toHaveLength(1);

    // 先输入再清空并失焦 = 显式删除该凭据（空串语义）。
    act(() => secret.focus());
    setInput(secret, "tmp");
    setInput(secret, "");
    act(() => secret.blur());
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "qqSecretsWrite",
      appSecret: "",
    });
  });

  it("renders connection status and the pairing code with its expiry", () => {
    act(() => {
      useChat.getState().applyHostMessage({
        type: "qqStatus",
        connected: true,
        detail: "QQ 官方机器人已连接",
      });
      useChat.getState().applyHostMessage({
        type: "qqBindCode",
        code: "K7Q2",
        expiresAt: Date.now() + 60_000,
      });
    });
    render(
      <SettingsModal
        tab="qq"
        onTabChange={() => {}}
        onDismiss={() => {}}
        dismissible
        busy={false}
        auth={AUTH}
      />,
    );

    expect(container.textContent).toContain("已连接");
    expect(container.textContent).toContain("QQ 官方机器人已连接");
    expect(container.textContent).toContain("K7Q2");
    expect(container.textContent).toContain("剩余");
    expect(container.textContent).toContain("/qq bind K7Q2");
  });
});

describe("远程任务区", () => {
  function setTasks(tasks: QqTaskUi[]): void {
    act(() =>
      useChat.setState({
        state: { ...initialSessionState(), qqTasks: tasks },
      }),
    );
  }

  it("renders nothing when there are no remote tasks", () => {
    setTasks([]);
    render(<QqTasksPanel />);
    expect(container.textContent).toBe("");
    expect(container.querySelector("[data-qq-task]")).toBeNull();
  });

  it("renders the task list next to the board and posts qqTaskAction", () => {
    setTasks([task()]);
    render(<QqTasksPanel />);

    expect(container.textContent).toContain("远程任务");
    expect(container.querySelector("[data-qq-task='task-1']")).toBeTruthy();
    expect(container.textContent).toContain("把 README 的安装段改成内网镜像");

    clickText("停止");
    expect(postMessage).toHaveBeenCalledWith({
      type: "qqTaskAction",
      taskId: "task-1",
      action: "stop",
    });
  });
});
