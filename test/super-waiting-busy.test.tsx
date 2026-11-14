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