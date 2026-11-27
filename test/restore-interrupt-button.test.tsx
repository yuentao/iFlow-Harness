// @vitest-environment jsdom
/**
 * 恢复进行中顶栏「新会话」按钮的可用性（webview 侧）。
 *
 * 恢复历史会话期间（replaying）宿主会放弃这次恢复并立刻新建会话，所以按钮
 * 必须可点，且 tooltip 说清楚它会做什么 —— 否则用户点了没反应，只能等恢复
 * 跑完再点一次。其余忙碌态（生成中 / 正在创建新会话 / 正在切换会话 / 等待
 * 子会话汇报）仍然禁用。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../webview/src/App";
import type { SessionState } from "../shared/messages";

const send = vi.hoisted(() => vi.fn());
const holder = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock("../webview/src/store", async () => {
  const { createStoreMock } = await import("./helpers/store-mock");
  const mock = createStoreMock();
  // 工厂兜住 ChatStore 全表面；本文件仍用 holder 逐帧替换整份会话视图。
  const live = () =>
    ({ ...mock.store, ...holder.state }) as unknown as import("./helpers/store-mock").StoreMockState;
  const useChat = Object.assign(
    <T,>(selector: (s: ReturnType<typeof live>) => T): T => selector(live()),
    { getState: live },
  );
  return { ...mock, useChat, getState: live };
});

vi.mock("../webview/src/i18n", () => ({
  t: (s: string, ...args: Array<string | number>) => {
    let out = s;
    args.forEach((arg, i) => {
      out = out.replaceAll(`{${i}}`, String(arg));
    });
    return out;
  },
}));

function state(overrides: Partial<SessionState> = {}): SessionState {
  return {
    blocks: [],
    status: "idle",
    errorMessage: null,
    stopReason: null,
    sessionId: "s1",
    modes: null,
    commands: [],
    skills: [],
    models: [],
    currentModelId: null,
    thinkLevel: "auto",
    pendingApproval: null,
    pendingQuestions: null,
    pendingProfileSwitch: null,
    auth: {
      authenticated: true,
      needsSetup: false,
      saved: null,
      profiles: [],
      onboardingDismissed: true,
    },
    sessions: [],
    activeSessionId: null,
    replaying: false,
    initializing: false,
    compressing: false,
    superWaiting: false,
    superSessions: [],
    queue: [],
    queuePaused: false,
    checkpoints: [],
    nextStepSuggestions: [],
    nextStepLoading: false,
    ...overrides,
    qqTasks: overrides.qqTasks ?? [],
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  send.mockReset();
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): [] {
      return [];
    }
  }
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = Observer;
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = Observer;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(overrides: Partial<SessionState> = {}): void {
  holder.state = {
    state: state(overrides),
    send,
    toggleFocusMode: () => {},
    focusMode: false,
    headerScrolled: false,
    editorTheme: "light",
    pending: null,
    toasts: [],
    notify: () => {},
    dismissToast: () => {},
    clearMemoryDraft: () => {},
    memoryDraftRequest: null,
    superTranscripts: {},
    hostSettings: {
      theme: "light",
      auroraIntensity: 35,
      uiFontSize: "standard",
      uiDensity: "standard",
    },
  };
  act(() => root.render(<App />));
}

/** 顶栏的「新会话」图标按钮（aria-label = 新会话）。 */
function newSessionButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === "新会话",
  ) as HTMLButtonElement | undefined;
}

describe("恢复进行中顶栏「新会话」按钮", () => {
  it("恢复中：按钮可点，tooltip 说明会取消恢复并新建会话", () => {
    render({ replaying: true, status: "streaming" });

    const button = newSessionButton();
    expect(button).toBeTruthy();
    // 可点 —— 宿主会放弃这次恢复并立刻新建会话。
    expect(button!.disabled).toBe(false);
    expect(button!.getAttribute("title")).toContain("取消正在进行的会话恢复");
    // 顶栏同时如实显示「正在恢复历史会话…」。
    expect(container.textContent).toContain("正在恢复历史会话");
  });

  it("恢复中点击：发出 newSession 消息（不是点了没反应）", () => {
    render({ replaying: true, status: "streaming" });
    act(() => {
      newSessionButton()!.click();
    });
    expect(send).toHaveBeenCalledWith({ type: "newSession" });
  });

  it("其它忙碌态仍然禁用：生成中 / 正在创建新会话 / 等待超流体汇报", () => {
    render({ status: "streaming" });
    expect(newSessionButton()!.disabled).toBe(true);

    render({ initializing: true });
    expect(newSessionButton()!.disabled).toBe(true);

    render({ superWaiting: true });
    expect(newSessionButton()!.disabled).toBe(true);
  });

  it("空闲态：按钮可点，保留默认 tooltip", () => {
    render();
    const button = newSessionButton();
    expect(button!.disabled).toBe(false);
    expect(button!.getAttribute("title")).toBe("新会话");
  });
});

describe("新建会话的加载态", () => {
  it("starting：按钮禁用、带 aria-busy、显示「正在新建会话…」，重复点击不发请求", () => {
    render({ newSessionPhase: "starting" });

    const button = newSessionButton();
    expect(button).toBeTruthy();
    expect(button!.disabled).toBe(true);
    expect(button!.getAttribute("aria-busy")).toBe("true");
    expect(container.textContent).toContain("正在新建会话…");

    act(() => button!.click());
    expect(send).not.toHaveBeenCalledWith({ type: "newSession" });
  });

  it("waiting：显示「正在等待后台任务结束」，按钮同样禁用", () => {
    render({ newSessionPhase: "waiting" });

    expect(newSessionButton()!.disabled).toBe(true);
    expect(newSessionButton()!.getAttribute("aria-busy")).toBe("true");
    expect(container.textContent).toContain("正在等待后台任务结束");
  });

  it("点击后立即进入加载态（不等宿主回包），第二次点击被忽略", () => {
    render();
    act(() => newSessionButton()!.click());

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: "newSession" });
    const button = newSessionButton();
    expect(button!.disabled).toBe(true);
    expect(button!.getAttribute("aria-busy")).toBe("true");
    expect(container.textContent).toContain("正在新建会话…");

    act(() => button!.click());
    expect(send).toHaveBeenCalledTimes(1);
  });
});
