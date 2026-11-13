// @vitest-environment jsdom
/**
 * 等待子会话汇报期间的面板呈现（webview 侧）。
 *
 * 用户原话：「主会话等待子会话汇报和处理汇报时的状态应该是(正在生成)状态，
 * 不应该出现无状态」—— idle 时顶栏本来没有任何状态 chip（UI-audit 4.2 的
 * 「idle 不显示 chip」），等待期必须例外：顶栏要有转圈的忙碌 chip，且
 * 顶栏「新会话」必须禁用（等待期新建会话会让排队里的汇报落到已被替换的
 * 会话上）。
 *
 * 忙碌态来自宿主权威的正交标记 `superWaiting`（不改 `status`），所以等待期
 * 用户仍然可以发消息、由主会话响应。
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

function render(superWaiting: boolean): void {
  holder.state = {
    state: idleState(superWaiting),
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

describe("等待子会话汇报期间的顶栏", () => {
  it("等待期顶栏不是「无状态」：显示转圈的忙碌 chip", () => {
    render(false);
    // idle 且没有在等子会话 → 顶栏没有任何状态 chip（既有行为）。
    expect(container.textContent).not.toContain("生成中");

    render(true);
    expect(container.textContent).toContain("生成中");
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
