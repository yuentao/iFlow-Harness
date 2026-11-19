// @vitest-environment jsdom
/**
 * 接管态顶栏冻结（webview 侧）：
 *
 * - 远端接管时，顶栏里会引起会话/配置/视图变更的控件（会话切换、Focus、
 *   新会话、设置、子会话看板）一律禁用，防止本机用户误操作打断远端流程；
 * - 纯展示性的状态 chip 保留可见；
 * - 非接管态这些控件照常可用（设置按钮仍可打开设置）。
 *
 * 输入区 / 审批卡 / 提问卡的冻结与「关闭接续」出口见 qq-takeover-webview.test.tsx。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../webview/src/App";
import type { SessionState, SuperSessionUi } from "../shared/messages";

const send = vi.hoisted(() => vi.fn());
const toggleFocusMode = vi.hoisted(() => vi.fn());
const holder = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock("../webview/src/store", () => ({
  useChat: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(holder.state),
    { getState: () => holder.state },
  ),
}));

vi.mock("../webview/src/i18n", () => ({
  t: (s: string, ...args: Array<string | number>) => {
    let out = s;
    args.forEach((arg, i) => {
      out = out.replaceAll(`{${i}}`, String(arg));
    });
    return out;
  },
  modeDisplay: (mode: { id: string; name: string }) => ({ label: mode.name || mode.id, desc: "" }),
}));

function idleState(overrides: Partial<SessionState> = {}): SessionState {
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
    // 非空会话列表：让顶栏渲染出会话切换 Dropdown 的 trigger。
    sessions: [{ id: "s1", label: "测试会话", updatedAt: 1_700_000_000_000, archived: false, pinned: false }],
    activeSessionId: "s1",
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
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  send.mockReset();
  toggleFocusMode.mockReset();
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
  Element.prototype.scrollTo = () => {};
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderState(takeover: boolean, overrides: Partial<SessionState> = {}): void {
  holder.state = {
    state: idleState(overrides),
    send,
    toggleFocusMode,
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
    remoteTakeover: takeover,
  };
  act(() => root.render(<App />));
}

function buttonByLabel(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label,
  ) as HTMLButtonElement | undefined;
}

/** 顶栏会话切换 trigger（aria-haspopup + 固定 tooltip）。 */
function sessionSwitcher(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (b) => b.getAttribute("title") === "历史会话（选择后恢复该会话上下文）",
  ) as HTMLButtonElement | undefined;
}

function headerControls(): Array<HTMLButtonElement | undefined> {
  return [
    sessionSwitcher(),
    buttonByLabel("Focus 视图"),
    buttonByLabel("新会话"),
    buttonByLabel("设置"),
  ];
}

describe("接管态顶栏控件冻结", () => {
  it("接管态：会话切换 / Focus / 新会话 / 设置全部 disabled", () => {
    renderState(true);
    const controls = headerControls();
    expect(controls.every(Boolean)).toBe(true);
    expect(controls.every((b) => b!.disabled)).toBe(true);
  });

  it("非接管态：这些控件照常可用", () => {
    renderState(false);
    const controls = headerControls();
    expect(controls.every(Boolean)).toBe(true);
    expect(controls.every((b) => !b!.disabled)).toBe(true);
  });

  it("接管态：点击不触发会话 / 视图 / 配置动作", () => {
    renderState(true);
    for (const control of headerControls()) act(() => control!.click());
    expect(send).not.toHaveBeenCalledWith({ type: "newSession" });
    expect(send).not.toHaveBeenCalledWith({ type: "loadSession", sessionId: "s1" });
    expect(toggleFocusMode).not.toHaveBeenCalled();
    // 设置弹层未被打开（ModalShell portal 到 body）。
    expect(document.body.textContent).not.toContain("API 配置");
  });

  it("接管态：Alt+N / Ctrl+Alt+F 快捷键不绕过顶栏禁用", () => {
    renderState(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", altKey: true, ctrlKey: true, bubbles: true }));
    });
    expect(toggleFocusMode).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "n", altKey: true, bubbles: true }));
    });
    expect(send).not.toHaveBeenCalledWith({ type: "newSession" });
  });

  it("纯展示的状态 chip 在接管态仍可见", () => {
    renderState(true, { status: "error" });
    expect(container.textContent).toContain("出错了");
  });
});

describe("接管态子会话看板冻结", () => {
  const settledSuper: SuperSessionUi = {
    id: "sa-1",
    title: "已完成的子会话",
    task: "补单测",
    status: "completed",
    isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/a", baseRef: "abc" },
    createdAt: 1000,
    updatedAt: 1000,
    reports: [],
  };

  /** 沿 DOM 向上找 inert 包裹层（SuperAgentBoard 内部按钮全部被它冻结）。 */
  function lockedAncestor(el: HTMLElement): HTMLElement | undefined {
    let cur: HTMLElement | null = el;
    while (cur && cur !== container) {
      if (cur.hasAttribute("inert")) return cur;
      cur = cur.parentElement;
    }
    return undefined;
  }

  it("非接管态看板控件可操作，接管态被 inert 冻结并带禁用视觉", () => {
    renderState(false, { superSessions: [settledSuper] });
    const normal = buttonByLabel("超流体看板");
    expect(normal).toBeTruthy();
    expect(lockedAncestor(normal!)).toBeUndefined();

    renderState(true, { superSessions: [settledSuper] });
    const frozen = buttonByLabel("超流体看板");
    expect(frozen).toBeTruthy();
    const wrapper = lockedAncestor(frozen!);
    expect(wrapper).toBeTruthy();
    expect(wrapper!.className).toContain("pointer-events-none");
    expect(wrapper!.className).toContain("opacity-40");
  });
});
