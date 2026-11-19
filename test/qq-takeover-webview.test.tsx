// @vitest-environment jsdom
/**
 * 底部输入区「远程接续」开关（webview 侧）：
 *
 * - 仅 `qqSettings.enabled` 时渲染，点击发 `qqTakeover` start/stop；
 * - `remoteTakeover` 为真时 Composer 输入与发送禁用（但开关本身仍可关闭，
 *   否则会死锁），审批卡 / 提问卡的决策按钮同步禁用；
 * - 转录区（MessageList）不受冻结，仍是可滚动的只读观察面。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../webview/src/components/Composer";
import { ApprovalCard } from "../webview/src/components/ApprovalCard";
import { QuestionCard } from "../webview/src/components/QuestionCard";
import { MessageList } from "../webview/src/components/MessageList";
import { initialSessionState, type PendingApprovalUi, type PendingQuestionsUi, type SessionState } from "../shared/messages";

const mocked = vi.hoisted(() => ({
  send: vi.fn(),
  notify: vi.fn(),
  dismissToast: vi.fn(),
  setHeaderScrolled: vi.fn(),
  state: undefined as SessionState | undefined,
  qqEnabled: true,
  takeover: false,
}));
const useChat = vi.hoisted(() =>
  Object.assign(
    <T,>(selector: (s: Record<string, unknown>) => T): T =>
      selector({
        state: mocked.state,
        pending: null,
        send: mocked.send,
        beginPending: vi.fn(),
        notify: mocked.notify,
        dismissToast: mocked.dismissToast,
        setHeaderScrolled: mocked.setHeaderScrolled,
        focusMode: false,
        promptSeq: 0,
        toasts: [],
        qqSettings: { enabled: mocked.qqEnabled },
        remoteTakeover: mocked.takeover,
      }),
    {
      getState: () => ({
        state: mocked.state,
        send: mocked.send,
        notify: mocked.notify,
        remoteTakeover: mocked.takeover,
      }),
    },
  ),
);
vi.mock("../webview/src/store", () => ({ useChat }));
vi.mock("../webview/src/i18n", () => ({ t: (s: string) => s }));
vi.mock("../webview/src/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../webview/src/components/ui")>();
  return {
    ...actual,
    Dropdown: ({ trigger, children }: { trigger: (open: boolean) => React.ReactNode; children: React.ReactNode }) => (
      <>{trigger(false)}{children}</>
    ),
    fuzzyScore: () => 0,
  };
});

const APPROVAL: PendingApprovalUi = {
  id: "approval-1",
  toolName: "write_file",
  title: "Write a.ts",
  toolKind: "edit",
  locations: [],
  options: [
    { optionId: "reject-1", name: "拒绝", kind: "reject_once" },
    { optionId: "allow-1", name: "允许", kind: "allow_once" },
  ],
  deadline: Date.now() + 60_000,
  timeoutMs: 60_000,
};
const QUESTIONS: PendingQuestionsUi = {
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
};

let root: Root;
let container: HTMLDivElement;

function makeState(): SessionState {
  const state = initialSessionState();
  state.status = "idle";
  state.sessionId = "s1";
  state.activeSessionId = "s1";
  return state;
}

function renderComposer(): void {
  act(() => root.render(<Composer />));
}

function takeoverButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    'button[aria-label="远程接续"], button[aria-label="关闭接续"]',
  );
}

function sendButton(): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    b.textContent?.includes("发送"),
  ) ?? null;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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
  mocked.state = makeState();
  mocked.qqEnabled = true;
  mocked.takeover = false;
  mocked.send.mockReset();
  mocked.notify.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("远程接续按钮", () => {
  it("仅在机器人已启用时渲染", () => {
    mocked.qqEnabled = false;
    renderComposer();
    expect(takeoverButton()).toBeNull();

    mocked.qqEnabled = true;
    renderComposer();
    expect(takeoverButton()?.getAttribute("aria-label")).toBe("远程接续");
  });

  it("点击发 qqTakeover start；接管态下切成关闭接续并发 stop", () => {
    renderComposer();
    act(() => takeoverButton()!.click());
    expect(mocked.send).toHaveBeenCalledWith({ type: "qqTakeover", action: "start" });

    mocked.takeover = true;
    renderComposer();
    const button = takeoverButton()!;
    expect(button.getAttribute("aria-label")).toBe("关闭接续");
    act(() => button.click());
    expect(mocked.send).toHaveBeenCalledWith({ type: "qqTakeover", action: "stop" });
  });

  it("接管时输入框 readOnly、发送禁用，但开关自身仍可点击关闭（无死锁）", () => {
    mocked.takeover = true;
    renderComposer();
    const textarea = container.querySelector("textarea")!;
    expect(textarea.readOnly).toBe(true);
    expect(sendButton()?.disabled).toBe(true);
    expect(takeoverButton()?.disabled).toBe(false);
  });
});

describe("远程接管的卡片冻结", () => {
  it("审批卡按钮在接管时禁用，键盘决策也不发送", () => {
    mocked.takeover = true;
    act(() => root.render(<ApprovalCard approval={APPROVAL} />));
    const decision = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter((b) =>
      ["允许", "拒绝", "取消"].some((label) => b.textContent?.includes(label)),
    );
    expect(decision.length).toBeGreaterThan(0);
    expect(decision.every((b) => b.disabled)).toBe(true);

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", bubbles: true })));
    expect(mocked.send).not.toHaveBeenCalled();
  });

  it("提问卡按钮在接管时禁用，且不发送回答", () => {
    mocked.takeover = true;
    act(() => root.render(<QuestionCard pending={QUESTIONS} />));
    const decision = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter((b) =>
      b.getAttribute("aria-label") === "提交回答" || b.getAttribute("aria-label") === "不回答并继续",
    );
    expect(decision.length).toBe(2);
    expect(decision.every((b) => b.disabled)).toBe(true);
    expect(mocked.send).not.toHaveBeenCalled();
  });
});

describe("只读观察", () => {
  it("接管态下转录仍渲染为可滚动容器且能滚动", () => {
    mocked.takeover = true;
    const state = makeState();
    state.blocks = [{ kind: "text", id: "b-1", text: "远程正在改代码。" }];
    mocked.state = state;
    act(() => root.render(<MessageList />));
    const scroll = container.querySelector<HTMLElement>(".message-scroll");
    expect(scroll).not.toBeNull();
    expect(scroll!.className).toContain("overflow-y-auto");
    expect(scroll!.hasAttribute("disabled")).toBe(false);
    act(() => {
      scroll!.scrollTop = 120;
      scroll!.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(scroll!.scrollTop).toBe(120);
  });
});
