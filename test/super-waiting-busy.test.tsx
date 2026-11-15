// @vitest-environment jsdom
/**
 * 顶栏状态 chip 的语义（webview 侧）。
 *
 * 历史：等待子会话汇报期间（`superWaiting`，不改 `status` 的正交标记）曾在
 * 顶栏挂一个转圈的「生成中」chip。现在顶栏不再承载重复的忙碌信号——转录
 * 底部已经有浮动 pill（正在生成 / 正在压缩 / 正在规划 / 正在创建新会话…），
 * 窄屏下顶栏的重复 chip 只会把会话标题挤到不可读；子会话的忙碌程度由看板
 * 计数承担。`superWaiting` 仍然必须禁用顶栏「新会话」——等待期新建会话会让
 * 排队里的汇报落到已被替换的会话上。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../webview/src/App";
import type { SessionState } from "../shared/messages";

const send = vi.hoisted(() => vi.fn());
const holder = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock("../webview/src/store", () => ({
  useChat: (selector: (s: unknown) => unknown) => selector(holder.state),
  send,
  getState: () => holder.state,
}));

vi.mock("../webview/src/i18n", () => ({
  t: (s: string, ...args: Array<string | number>) => {
    let out = s;
    args.forEach((arg, i) => {
      out = out.replaceAll(`{${i}}`, String(arg));
    });
    return out;
  },
  // Composer 的模式下拉在 modes 非空时会调用它（Plan 模式用例需要）。
  modeDisplay: (mode: { id: string; name: string }) => ({ label: mode.name || mode.id, desc: "" }),
}));

function idleState(superWaiting: boolean): SessionState {
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
    pendingPlanExit: null,
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
    superWaiting,
    superSessions: [],
    queue: [],
    queuePaused: false,
    checkpoints: [],
    nextStepSuggestions: [],
    nextStepLoading: false,
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

function renderState(overrides: Partial<SessionState> = {}): void {
  holder.state = {
    state: { ...idleState(false), ...overrides },
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

function render(superWaiting: boolean): void {
  renderState({ superWaiting });
}

/** 顶栏的「新会话」图标按钮（aria-label = 新会话）。 */
function newSessionButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === "新会话",
  ) as HTMLButtonElement | undefined;
}

describe("顶栏忙碌 chip", () => {
  it("等待子会话汇报时顶栏不再显示「生成中」chip", () => {
    render(false);
    // idle 且没有在等子会话 → 顶栏没有任何状态 chip（既有行为）。
    expect(container.textContent).not.toContain("生成中");

    // 等待期同样不占顶栏：忙碌信号交给转录底部 pill 与看板计数。
    render(true);
    expect(container.textContent).not.toContain("生成中");
  });

  it("等待期顶栏「新会话」按钮禁用，并说明原因", () => {
    render(false);
    expect(newSessionButton()).toBeTruthy();
    expect(newSessionButton()!.disabled).toBe(false);
    // 不在等待期时保留 IconButton 的默认 tooltip（title = label）。
    expect(newSessionButton()!.getAttribute("title")).toBe("新会话");

    render(true);
    const button = newSessionButton();
    expect(button).toBeTruthy();
    expect(button!.disabled).toBe(true);
    expect(button!.getAttribute("title")).toContain("子会话");
  });
});

describe("streaming 状态的顶栏 chip", () => {
  it("普通生成中不显示 chip（转录底部 pill 已承担）", () => {
    renderState({ status: "streaming" });
    expect(container.textContent).not.toContain("生成中");
  });

  it("压缩中仍显示「正在压缩」", () => {
    renderState({ status: "streaming", compressing: true });
    expect(container.textContent).toContain("正在压缩");
    expect(container.textContent).not.toContain("生成中");
  });

  it("Plan 模式仍显示「正在规划」", () => {
    renderState({
      status: "streaming",
      modes: {
        currentModeId: "plan",
        availableModes: [{ id: "plan", name: "Plan", kind: "plan" }],
      },
    });
    expect(container.textContent).toContain("正在规划");
    expect(container.textContent).not.toContain("生成中");
  });
});

/**
 * 停止按钮（用户报告：正在生成时点停止很难停下来，要点好几次）。
 *
 * 点击层的两条硬约束：
 *  1. 真实生成期间必须有停止键，点击就发出 `{type:"cancel"}`；
 *  2. 它与 ESC **同一语义**（同一个 canStop），不被待处理审批/提问卡门控 ——
 *     否则该槽位会换成可点的「发送/派发」，用户点在原停止位置反而派发出
 *     一个子会话（实测的语义错位）。
 */
function stopButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (b) => b.getAttribute("title") === "停止生成",
  ) as HTMLButtonElement | undefined;
}

function delegateButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (b) => b.getAttribute("title") === "派发为子会话 (Enter)",
  ) as HTMLButtonElement | undefined;
}

describe("生成中的停止按钮", () => {
  it("生成中显示停止键，点击发出 cancel", () => {
    renderState({ status: "streaming" });
    const button = stopButton();
    expect(button).toBeTruthy();
    expect(button!.disabled).toBe(false);
    act(() => button!.click());
    expect(send).toHaveBeenCalledWith({ type: "cancel" });
  });

  it("回放历史（status 同样是 streaming）不提供停止", () => {
    renderState({ status: "streaming", replaying: true });
    expect(stopButton()).toBeUndefined();
  });

  it("有提问卡时仍可停止，且该槽位不会变成派发键", () => {
    renderState({
      status: "streaming",
      pendingQuestions: {
        id: "q-1",
        questions: [
          {
            header: "framework",
            question: "Which framework?",
            options: [{ label: "React", description: "React 19 with hooks" }],
            multiSelect: false,
          },
        ],
        deadline: Date.now() + 60_000,
        timeoutMs: 60_000,
      },
    });
    const button = stopButton();
    expect(button).toBeTruthy();
    expect(button!.disabled).toBe(false);
    expect(delegateButton()).toBeUndefined();
    act(() => button!.click());
    expect(send).toHaveBeenCalledWith({ type: "cancel" });
  });
});
