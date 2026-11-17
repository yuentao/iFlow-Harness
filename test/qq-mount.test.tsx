// @vitest-environment jsdom
/**
 * Wave3-C2 — QQ 远程任务的 webview 挂载。
 *
 * 覆盖两处挂载点与它们对宿主通道的接线：
 *  - 设置弹窗的「QQ 机器人」页签：吃 `qqSettings` 快照、显示连接状态与待审核
 *    用户列表、普通改动走 `qqSettingsPatch`（凭据只由扫码写入，页面上没有输入框）；
 *  - 看板附近的「远程任务」区：只在有任务时出现，动作走 `qqTaskAction`。
 *
 * 用真实 store（只 mock `acquireVsCodeApi`），因此同时验证了 store 对
 * `qqSettings` / `qqStatus` / `qqPendingUsers` 三条消息的处理不会被快照覆盖。
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
  hasAppSecret: boolean;
}): void {
  act(() =>
    useChat.getState().applyHostMessage({
      type: "qqSettings",
      values: pickQqSettingsUi(values, secrets ?? { hasAppSecret: false }),
    }),
  );
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
    qqSettings: pickQqSettingsUi({}, { hasAppSecret: false }),
    qqStatus: null,
    qqPendingUsers: [],
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("QQ 机器人设置页", () => {
  it("renders the qqSettings snapshot in the settings modal", () => {
    const openid = "D754D2240C503C2ABE2B236DC1E78D11";
    settings(
      {
        enabled: true,
        allowedUsers: [openid],
        maxConcurrentTasks: 4,
      },
      { hasAppSecret: true },
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
    expect(container.textContent).toContain("D754********8D11");
    expect(container.textContent).not.toContain(openid);
    expect(container.querySelector("input[aria-label='允许的用户 1']")).toBeNull();
    // 凭据只由扫码写入：设置页不再有手填输入框。
    expect(container.querySelector("input[aria-label='机器人 Token']")).toBeNull();
    expect(container.querySelector("input[aria-label='App Secret']")).toBeNull();
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

  it("renders connection status and the pending-user list", () => {
    act(() => {
      useChat.getState().applyHostMessage({
        type: "qqStatus",
        connected: true,
        detail: "QQ 官方机器人已连接",
      });
      useChat.getState().applyHostMessage({
        type: "qqPendingUsers",
        users: [
          {
            openid: "openid-123456",
            firstSeenAt: 1_700_000_000_000,
            lastSeenAt: 1_700_000_600_000,
            count: 1,
            preview: "帮我跑一下测试",
            chatType: "group",
            groupId: "987654321098",
          },
        ],
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
    expect(container.textContent).toContain("待审核用户");
    expect(container.textContent).toContain("open********3456");
    expect(container.textContent).not.toContain("openid-123456");
    expect(container.textContent).toContain("群 9876********1098");
    expect(container.textContent).toContain("帮我跑一下测试");
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
