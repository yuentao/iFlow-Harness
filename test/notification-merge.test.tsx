// @vitest-environment jsdom
/**
 * UI-audit 4.9: exactly ONE indicator may describe a running turn.
 *
 * The host's rate-limit / stream-interrupt retries push a countdown toast
 * while the same turn keeps the sticky 生成中 pill up — two stacked "something
 * is happening" indicators. The countdown now rides the pill itself (message
 * + live seconds) and is skipped in the bottom toast stack.
 *
 * `pickStreamingNotice` holds the decision (pure, so it is pinned here);
 * the DOM cases assert the rendered result: the message appears exactly once,
 * in the pill while streaming and in the toast stack when idle.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageList, pickStreamingNotice } from "../webview/src/components/MessageList";
import { initialSessionState, type SessionState } from "../shared/messages";
import type { ToastItem } from "../webview/src/store";

const store = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("../webview/src/store", () => ({
  useChat: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(store.current),
    { getState: () => store.current },
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
}));

const RATE_LIMIT = "模型触发平台速率限制，自动重试中（第 1/3 次）";
const COMPRESS_WARN = "上下文接近上限，建议压缩";

function countdownToast(overrides: Partial<ToastItem> = {}): ToastItem {
  return {
    id: 1,
    level: "warning",
    message: RATE_LIMIT,
    countdownDeadline: Date.now() + 5000,
    ...overrides,
  };
}

const STREAMING_TURN = {
  status: "streaming" as const,
  compressing: false,
  initializing: false,
  pillVisible: true,
};

describe("pickStreamingNotice", () => {
  it("merges the countdown retry into the streaming pill", () => {
    const toast = countdownToast();
    expect(pickStreamingNotice([toast], STREAMING_TURN)).toBe(toast);
  });

  it("leaves the retry in the toast stack when no turn is streaming", () => {
    expect(pickStreamingNotice([countdownToast()], { ...STREAMING_TURN, status: "idle" })).toBeUndefined();
  });

  it("does not swallow the retry while the session is still initializing", () => {
    // The pill says 正在创建新会话 then — a hidden pill must never eat a toast.
    expect(pickStreamingNotice([countdownToast()], { ...STREAMING_TURN, initializing: true })).toBeUndefined();
  });

  it("does not swallow the retry during a compress turn", () => {
    expect(pickStreamingNotice([countdownToast()], { ...STREAMING_TURN, compressing: true })).toBeUndefined();
  });

  it("does not swallow the retry when the pill is hidden (pending card / empty transcript)", () => {
    expect(pickStreamingNotice([countdownToast()], { ...STREAMING_TURN, pillVisible: false })).toBeUndefined();
  });

  it("prefers the retry with the latest deadline (consecutive retries overlap)", () => {
    const older = countdownToast({ id: 1, countdownDeadline: Date.now() + 1000, message: "第 1/3 次" });
    const newer = countdownToast({ id: 2, countdownDeadline: Date.now() + 9000, message: "第 2/3 次" });
    expect(pickStreamingNotice([older, newer], STREAMING_TURN)).toBe(newer);
  });

  it("never merges a toast whose action would have no entry point", () => {
    const actionable = countdownToast({ action: { actionId: "retry", label: "立即重试" } });
    expect(pickStreamingNotice([actionable], STREAMING_TURN)).toBeUndefined();
  });

  it("still merges the compress warning (its action is suppressed during a turn)", () => {
    const warn = countdownToast({
      id: 7,
      message: COMPRESS_WARN,
      countdownDeadline: undefined,
      action: { actionId: "compress", label: "立即压缩" },
    });
    expect(pickStreamingNotice([warn], STREAMING_TURN)).toBe(warn);
  });

  it("prefers the countdown retry over the compress warning", () => {
    const warn = countdownToast({
      id: 7,
      message: COMPRESS_WARN,
      countdownDeadline: undefined,
      action: { actionId: "compress", label: "立即压缩" },
    });
    const count = countdownToast({ id: 8 });
    expect(pickStreamingNotice([warn, count], STREAMING_TURN)).toBe(count);
  });
});

/** Closest rounded surface around the text — the pill that carries it. */
function toneOf(root: HTMLElement, needle: string): string | undefined {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node.textContent?.includes(needle)) {
      let el = node.parentElement;
      while (el) {
        const cls = el.className || "";
        if (cls.includes("rounded-xl")) return "rounded-xl";
        if (cls.includes("rounded-lg")) return "rounded-lg";
        if (cls.includes("rounded-full")) return "rounded-full";
        el = el.parentElement;
      }
      return undefined;
    }
    node = walker.nextNode();
  }
  return undefined;
}

describe("MessageList — the countdown retry rides the streaming pill", () => {
  let root: Root;
  let container: HTMLDivElement;

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
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function render(state: SessionState, toasts: ToastItem[]): void {
    store.current = {
      state,
      toasts,
      send: vi.fn(),
      dismissToast: vi.fn(),
      setHeaderScrolled: vi.fn(),
      focusMode: false,
      promptSeq: 0,
      requestDraft: vi.fn(),
      requestMemoryDraft: vi.fn(),
    };
    act(() => {
      root.render(<MessageList />);
    });
  }

  function streamingState(status: SessionState["status"]): SessionState {
    const state = initialSessionState();
    state.status = status;
    state.blocks = [{ kind: "text", id: "b-1", text: "先读一下仓库结构。" }];
    return state;
  }

  it("shows the retry in the streaming pill only — no second pill in the stack", () => {
    render(streamingState("streaming"), [countdownToast()]);
    const text = container.textContent ?? "";
    // Exactly one surface carries the message (no stacked indicators).
    expect(text.split(RATE_LIMIT).length - 1).toBe(1);
    expect(toneOf(container, RATE_LIMIT)).toBe("rounded-full");
    // The pill keeps the live countdown.
    expect(container.querySelector(".rounded-full")?.textContent ?? "").toMatch(/\d+s/);
  });

  it("keeps the retry in the bottom toast stack when no turn is streaming", () => {
    render(streamingState("idle"), [countdownToast()]);
    const text = container.textContent ?? "";
    expect(text.split(RATE_LIMIT).length - 1).toBe(1);
    expect(toneOf(container, RATE_LIMIT)).toBe("rounded-xl");
  });

  it("renders a memory proposal as an overlay pill with the memory icon and 24px controls", () => {
    render(streamingState("idle"), [
      {
        id: 5,
        level: "info",
        message: "发现 2 条可记忆内容，是否追加到记忆？",
        sticky: true,
        toastId: 9,
        action: { actionId: "memory-review", label: "追加记忆" },
      },
    ]);
    const pill = container.querySelector(".rounded-xl")!;
    // Overlay species (same family as the dropdowns / approval card), not a
    // transcript card: acrylic surface, primary accent, 13px body.
    expect(pill.className).toContain("acrylic-pop");
    expect(pill.className).toContain("border-primary/45");
    expect(pill.className).toContain("text-ui-label");
    expect(pill.querySelector(".lucide-brain")).not.toBeNull();
    const action = [...pill.querySelectorAll("button")].find((b) => b.textContent?.includes("追加记忆"));
    expect(action?.className).toContain("h-6");
    expect(pill.querySelector('[aria-label="关闭"]')?.className).toContain("size-6");
    // Nesting the action inside the dismiss button used to swallow it entirely.
    expect(pill.querySelector("button button")).toBeNull();
    act(() => {
      action!.click();
    });
    expect(store.current.send).toHaveBeenCalledWith({
      type: "toastAction",
      actionId: "memory-review",
      toastId: 9,
    });
  });

  it("spins the host-owned extraction wait instead of a static info dot", () => {
    render(streamingState("idle"), [
      { id: 6, level: "info", message: "正在提取长期记忆候选…", displayOnly: true, persistent: true, toastId: 10 },
    ]);
    const pill = container.querySelector(".rounded-xl")!;
    expect(pill.querySelector(".animate-spin")).not.toBeNull();
    // The host owns this pill's lifecycle — clicking must not imply a cancel.
    expect(pill.querySelector("button")).toBeNull();
  });
});
