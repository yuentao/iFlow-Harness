// @vitest-environment jsdom
/**
 * 顶栏忙碌 chip 的文案必须说出**正在做什么**（webview 侧）。
 *
 * 宿主把 `initializing` 这个锁复用于多种异步流程（新建会话 / 删除会话 /
 * 删除消息 / 回滚对话 / 恢复会话），webview 过去一律渲染「正在创建新会话…」，
 * 于是「删除一个会话」看起来像「正在新建会话」。现在按 `initializingReason`
 * 渲染对应文案；缺失 reason（旧宿主 / mock）仍回退到新建会话的说法。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../webview/src/App";
import type { InitializingReason, SessionState } from "../shared/messages";

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
    initializingReason: null,
    compressing: false,
    superWaiting: false,
    superSessions: [],
    queue: [],
    queuePaused: false,
    checkpoints: [],
    nextStepSuggestions: [],
    nextStepLoading: false,
    ...overrides,
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

/** 顶栏 chip 的可见文案（blocks 为空时 MessageList 的浮动 pill 不渲染，
 * 所以 DOM 里的忙碌文案只可能来自顶栏）。 */
function busyText(): string {
  return container.textContent ?? "";
}

describe("顶栏忙碌 chip 的文案", () => {
  const cases: Array<[InitializingReason, string]> = [
    ["newSession", "正在创建新会话…"],
    ["deleteSession", "正在删除会话…"],
    ["deleteMessage", "正在删除消息…"],
    ["rollback", "正在回滚对话…"],
    ["restore", "正在恢复会话…"],
  ];

  for (const [reason, label] of cases) {
    it(`initializingReason=${reason} → ${label}`, () => {
      render({ initializing: true, initializingReason: reason });
      expect(busyText()).toContain(label);
      // 其余文案不得出现：删除/回滚绝不能被说成「正在创建新会话」。
      for (const [, other] of cases) {
        if (other === label) continue;
        expect(busyText()).not.toContain(other);
      }
    });
  }

  it("缺失 reason（旧宿主 / mock）回退到新建会话文案", () => {
    render({ initializing: true });
    expect(busyText()).toContain("正在创建新会话…");
  });

  it("initializing=false 时不渲染忙碌 chip", () => {
    render({ initializing: false, initializingReason: "deleteSession" });
    expect(busyText()).not.toContain("正在删除会话…");
    expect(busyText()).not.toContain("正在创建新会话…");
  });
});
