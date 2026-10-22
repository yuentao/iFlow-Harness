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

/** Full class list of the closest rounded surface around the text — lets the
 * pins assert the whole floating-overlay species (radius + shadow token), not
 * just the corner. jsdom applies no CSS, so the species is pinned by classes. */
function surfaceClasses(root: HTMLElement, needle: string): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node.textContent?.includes(needle)) {
      let el = node.parentElement;
      while (el) {
        const cls = el.className || "";
        if (cls.includes("rounded-full") || cls.includes("rounded-xl") || cls.includes("rounded-lg")) return cls;
        el = el.parentElement;
      }
      return "";
    }
    node = walker.nextNode();
  }
  return "";
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
    // Floating overlay species: the capsule drop must be the float token —
    // --shadow-panel's -24px spread collapses on a ~30px pill (invisible shadow).
    expect(surfaceClasses(container, RATE_LIMIT)).toContain("shadow-float");
    // The pill keeps the live countdown.
    expect(container.querySelector(".rounded-full")?.textContent ?? "").toMatch(/\d+s/);
  });

  it("keeps the retry in the bottom toast stack when no turn is streaming", () => {
    render(streamingState("idle"), [countdownToast()]);
    const text = container.textContent ?? "";
    expect(text.split(RATE_LIMIT).length - 1).toBe(1);
    // Bottom floating chips are capsules (streaming pill / jump-to-latest), so
    // a stack pill must round the same way — the mismatch read as "wrong radius".
    expect(toneOf(container, RATE_LIMIT)).toBe("rounded-full");
    expect(surfaceClasses(container, RATE_LIMIT)).toContain("shadow-float");
  });

  it("lifts the toast stack above the bottom band so the pair never overlaps", () => {
    // The retry wins the merge; the context warning keeps its own slot. The
    // band floats above the transcript (absolute in the overlay) and its
    // height + breathing gap is mirrored into --stream-pill-h — a fixed stack
    // offset overlapped it (user screenshot 2026-10-21).
    const warn = countdownToast({
      id: 7,
      message: COMPRESS_WARN,
      countdownDeadline: undefined,
      action: { actionId: "compress", label: "立即压缩" },
    });
    render(streamingState("streaming"), [warn, countdownToast({ id: 8 })]);
    const stack = container.querySelector(".absolute.inset-x-0.z-20") as HTMLElement;
    // 2.5rem above the band's bottom offset (0.5rem) leaves a clear gap even
    // with the band's mirrored height folded into --stream-pill-h.
    expect(stack.style.bottom).toContain("--stream-pill-h");
    expect(stack.style.bottom).toContain("2.5rem");
    expect(toneOf(container, COMPRESS_WARN)).toBe("rounded-full");
    // The warning pill is the one the user reported as shadow-less: it must carry
    // the same floating-overlay drop as the band pill next to it.
    expect(surfaceClasses(container, COMPRESS_WARN)).toContain("shadow-float");
  });

  it("wears the pill's tone on the action button (no grey chip on a notice)", () => {
    // The 立即压缩 action used to wear the neutral secondary button — a grey
    // chip floating on an amber notice, which read as an unrelated control.
    const warn = countdownToast({
      id: 7,
      message: COMPRESS_WARN,
      countdownDeadline: undefined,
      action: { actionId: "compress", label: "立即压缩" },
    });
    render(streamingState("idle"), [warn]);
    const action = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("立即压缩"));
    expect(action).toBeTruthy();
    expect(action!.className).toContain("text-warning");
    expect(action!.className).toContain("border-warning");
    expect(action!.className).not.toContain("bg-editor");
  });

  it("wears the error tone on the action button of an error notice", () => {
    render(streamingState("idle"), [
      {
        id: 9,
        level: "error",
        message: "网关拒绝了本次请求",
        action: { actionId: "retry", label: "重试" },
      },
    ]);
    const action = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("重试"));
    expect(action).toBeTruthy();
    expect(action!.className).toContain("text-destructive");
    expect(action!.className).not.toContain("bg-editor");
  });

  it("keeps the fixed clearance when no bottom band is on screen", () => {
    render(streamingState("idle"), [countdownToast()]);
    const stack = container.querySelector(".absolute.inset-x-0.z-20") as HTMLElement;
    expect(stack.style.bottom).toContain("3.5rem");
  });

  it("renders memory candidates as a decision card with previews and one forward channel", () => {
    render(streamingState("idle"), [
      {
        id: 5,
        level: "info",
        message: "发现 3 条可记忆内容",
        sticky: true,
        toastId: 9,
        action: { actionId: "memory-review", label: "查看并确认" },
        preview: [
          { text: "以后用 pnpm 安装依赖", scope: "global" },
          { text: "提交前跑 npm run typecheck", scope: "project" },
        ],
      },
    ]);
    const card = container.querySelector(".z-20")!.querySelector(".rounded-xl")!;
    // Approval-card family, not a pill: acrylic surface + primary accent.
    expect(card.className).toContain("acrylic");
    expect(card.className).toContain("border-primary/45");
    expect(card.textContent).toContain("iFlow 建议沉淀记忆");
    expect(card.textContent).toContain("发现 3 条可记忆内容");
    expect(card.textContent).toContain("以后用 pnpm 安装依赖");
    expect(card.textContent).toContain("全局");
    expect(card.textContent).toContain("项目");
    expect(card.querySelector(".lucide-brain")).not.toBeNull();
    const buttons = [...card.querySelectorAll("button")];
    const primary = buttons.find((b) => b.textContent?.includes("查看并确认"));
    const ignore = buttons.find((b) => b.textContent?.includes("忽略"));
    expect(primary?.className).toContain("h-6");
    expect(ignore?.className).toContain("h-6");
    // The primary rides the button species (shadow-btn); the secondary is the
    // kit's border-only surface (no shadow). Neither may take shadow-card: its
    // third layer (-12px spread) collapses on a 24px-tall button.
    expect(primary?.className).toContain("shadow-btn");
    expect(ignore?.className).not.toContain("shadow-card");
    expect(ignore?.className).not.toContain("shadow-panel");
    expect(card.querySelector('[aria-label="关闭"]')?.className).toContain("size-6");
    expect(card.textContent).toContain("确认后才会写入记忆");
    // Buttons stay siblings: nesting the action inside a dismiss button used to
    // swallow the whole action.
    expect(card.querySelector("button button")).toBeNull();
    act(() => {
      primary!.click();
    });
    expect(store.current.send).toHaveBeenCalledWith({
      type: "toastAction",
      actionId: "memory-review",
      toastId: 9,
    });
    act(() => {
      ignore!.click();
    });
    expect(store.current.dismissToast).toHaveBeenCalledWith(5);
  });

  it("spins the host-owned extraction wait instead of a static info dot", () => {
    render(streamingState("idle"), [
      { id: 6, level: "info", message: "正在提取长期记忆候选…", displayOnly: true, persistent: true, toastId: 10 },
    ]);
    const pill = container.querySelector(".rounded-full")!;
    expect(pill.querySelector(".animate-spin")).not.toBeNull();
    // Same floating-overlay species as every other toast: capsule radius plus the
    // float drop (acrylic-pop alone carried the panel-sized drop, invisible here).
    expect(pill.className).toContain("shadow-float");
    expect(pill.className).toContain("acrylic-pop");
    // The host owns this pill's lifecycle — clicking must not imply a cancel.
    expect(pill.querySelector("button")).toBeNull();
  });
});
