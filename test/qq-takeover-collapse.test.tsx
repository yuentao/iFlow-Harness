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

/** ConfirmDialog portals to document.body, not into the composer container. */
function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="alertdialog"]');
}

function dialogButton(label: string): HTMLButtonElement | null {
  return Array.from(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
    (b) => b.textContent?.trim() === label,
  ) ?? null;
}

function textarea(): HTMLTextAreaElement {
  return container.querySelector("textarea")!;
}

function suggestionBar(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[aria-label="iFlow 猜的下一步，点一下填进输入框"]');
}

function suggestionLoadingPill(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[aria-label="正在想下一步建议…"]');
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

  it("非接管态：建议条完整显示，未收起", () => {
    mocked.state.nextStepSuggestions = ["检查登录逻辑", "补充单元测试"];
    renderComposer();
    const bar = suggestionBar()!;
    expect(bar).not.toBeNull();
    expect(bar.className).toContain("mb-2");
    expect(bar.className).not.toContain("max-h-0");
    expect(bar.className).not.toContain("opacity-0");
  });

  it("接管态：建议条以 CSS 过渡收起（max-h-0 / opacity-0 / mb-0），DOM 保留", () => {
    mocked.state.nextStepSuggestions = ["检查登录逻辑", "补充单元测试"];
    mocked.takeover = true;
    renderComposer();
    const bar = suggestionBar()!;
    expect(bar).not.toBeNull();
    expect(bar.className).toContain("transition-all");
    expect(bar.className).toContain("duration-200");
    expect(bar.className).toContain("max-h-0");
    expect(bar.className).toContain("overflow-hidden");
    expect(bar.className).toContain("py-0");
    expect(bar.className).toContain("opacity-0");
    expect(bar.className).toContain("pointer-events-none");
    expect(bar.className).toContain("mb-0");
    expect(bar.className).not.toContain("mb-2");
    // 建议 chip 仍在 DOM（仅被 CSS 收起，未卸载）
    expect(bar.textContent).toContain("检查登录逻辑");
  });

  it("接管态：「正在想下一步建议…」加载提示条一并收起", () => {
    mocked.state.nextStepLoading = true;
    mocked.takeover = true;
    renderComposer();
    const pill = suggestionLoadingPill()!;
    expect(pill).not.toBeNull();
    expect(pill.className).toContain("max-h-0");
    expect(pill.className).toContain("opacity-0");
    expect(pill.className).toContain("pointer-events-none");
    expect(pill.className).toContain("mb-0");
    expect(pill.className).not.toContain("mb-2");
    expect(pill.className).not.toContain("py-1");
  });

  it("接管态：关闭接续按钮危险配色、无方框、可见可点", () => {
    mocked.takeover = true;
    renderComposer();
    const button = takeoverButton()!;
    expect(button).not.toBeNull();
    expect(button.getAttribute("aria-label")).toBe("关闭接续");
    expect(button.disabled).toBe(false);
    expect(button.className).not.toContain("opacity-0");
    // 危险色语义：复用 kit 的 danger variant（destructive token），非 self-made 色值
    expect(button.className).toContain("text-destructive");
    // 接管态去掉外层方框：卡片圆角/边框/底色/阴影一概不出现
    const card = textarea().parentElement!;
    expect(card.className).not.toContain("rounded-lg");
    expect(card.className).not.toContain("bg-editor");
    expect(card.className).not.toContain("shadow-card");
  });

  it("非接管态：关闭/远程按钮保持中性，卡片方框完整", () => {
    renderComposer();
    const button = takeoverButton()!;
    expect(button.getAttribute("aria-label")).toBe("远程接续");
    expect(button.className).not.toContain("text-destructive");
    const card = textarea().parentElement!;
    expect(card.className).toContain("rounded-lg");
    expect(card.className).toContain("border-border");
    expect(card.className).toContain("bg-editor");
    expect(card.className).toContain("shadow-card");
  });

  it("接管态：点关闭接续先弹二次确认，确认后才发 stop", () => {
    mocked.takeover = true;
    renderComposer();
    const button = takeoverButton()!;
    act(() => button.click());
    // 仅弹确认框，尚未发 stop
    expect(mocked.send).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
    expect(dialog()?.getAttribute("aria-label")).toBe("确认关闭远程接续？");
    // 确认后真正停止接续
    act(() => dialogButton("确认关闭")!.click());
    expect(mocked.send).toHaveBeenCalledWith({ type: "qqTakeover", action: "stop" });
    expect(dialog()).toBeNull();
  });

  it("接管态：点取消不发 stop、对话框关闭且仍处于接管态", () => {
    mocked.takeover = true;
    renderComposer();
    act(() => takeoverButton()!.click());
    expect(dialog()).not.toBeNull();
    act(() => dialogButton("取消")!.click());
    expect(mocked.send).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    expect(takeoverButton()?.getAttribute("aria-label")).toBe("关闭接续");
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
