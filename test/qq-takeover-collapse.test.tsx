// @vitest-environment jsdom
/**
 * 接管态输入框收缩：remoteTakeover=true 时底部 Composer 用 CSS 过渡
 * （max-height / opacity，而非卸载 DOM）收缩为只剩「关闭接续」按钮。
 * 本测试只验证 Composer 的收缩形态与解冻出口；审批/提问卡冻结、
 * 转录只读滚动等契约由 test/qq-takeover-webview.test.tsx 覆盖。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../webview/src/components/Composer";
import { initialSessionState, type SessionState } from "../shared/messages";

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
        beginPending: vi.fn(),
        send: mocked.send,
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

function textarea(): HTMLTextAreaElement {
  return container.querySelector("textarea")!;
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

describe("接管态输入框收缩", () => {
  it("非接管态：输入框完整可见，未收缩", () => {
    renderComposer();
    const ta = textarea();
    expect(ta.readOnly).toBe(false);
    expect(ta.className).toContain("opacity-100");
    expect(ta.className).not.toContain("opacity-0");
    expect(ta.className).not.toContain("max-h-0");
    expect(ta.className).toContain("py-3");
    expect(container.firstElementChild?.className).not.toContain("overflow-hidden");
    expect(takeoverButton()?.getAttribute("aria-label")).toBe("远程接续");
  });

  it("接管态：输入框以 CSS 过渡收缩到 0（仍在 DOM），根容器裁剪溢出", () => {
    mocked.takeover = true;
    renderComposer();
    const ta = textarea();
    // 收缩类：过渡 + 高度/内边距/透明度归零，DOM 保留（readOnly 断言依赖它）
    expect(ta.className).toContain("transition-all");
    expect(ta.className).toContain("duration-200");
    expect(ta.className).toContain("max-h-0");
    expect(ta.className).toContain("overflow-hidden");
    expect(ta.className).toContain("py-0");
    expect(ta.className).toContain("opacity-0");
    expect(ta.className).not.toContain("py-3");
    expect(ta.readOnly).toBe(true);
    expect(container.firstElementChild?.className).toContain("overflow-hidden");
  });

  it("接管态：模型区与发送/附件等操作按钮水平收起（max-w-0 opacity-0）", () => {
    mocked.takeover = true;
    renderComposer();
    const collapsed = container.querySelectorAll(".max-w-0.opacity-0");
    expect(collapsed.length).toBeGreaterThanOrEqual(2);
    // 发送按钮仍在 DOM（仅被 CSS 收起，未卸载）
    const sendBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("发送"),
    );
    expect(sendBtn).not.toBeNull();
  });

  it("接管态：关闭接续按钮始终可见可点，点击发 qqTakeover stop", () => {
    mocked.takeover = true;
    renderComposer();
    const button = takeoverButton()!;
    expect(button).not.toBeNull();
    expect(button.getAttribute("aria-label")).toBe("关闭接续");
    expect(button.disabled).toBe(false);
    expect(button.className).not.toContain("opacity-0");
    act(() => button.click());
    expect(mocked.send).toHaveBeenCalledWith({ type: "qqTakeover", action: "stop" });
  });

  it("从接管态切回：布局与交互完全恢复", () => {
    mocked.takeover = true;
    renderComposer();
    expect(textarea().className).toContain("max-h-0");

    mocked.takeover = false;
    renderComposer();
    const ta = textarea();
    expect(ta.className).toContain("opacity-100");
    expect(ta.className).not.toContain("max-h-0");
    expect(ta.className).toContain("py-3");
    expect(ta.readOnly).toBe(false);
    expect(container.firstElementChild?.className).not.toContain("overflow-hidden");
    expect(takeoverButton()?.getAttribute("aria-label")).toBe("远程接续");
  });
});
