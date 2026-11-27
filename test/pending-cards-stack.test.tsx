// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingCards } from "../webview/src/components/PendingCards";
import type { PendingApprovalUi, PendingQuestionsUi } from "../shared/messages";

const send = vi.hoisted(() => vi.fn());
vi.mock("../webview/src/store", async () => {
  const { createStoreMock } = await import("./helpers/store-mock");
  const mock = createStoreMock();
  // 断言仍落在文件级 send 上；把它接到工厂 store，其余全表面由工厂兜住。
  mock.store.send = send;
  return mock;
});
vi.mock("../webview/src/i18n", () => ({
  t: (s: string, ...args: Array<string | number>) => {
    let out = s;
    args.forEach((arg, i) => {
      out = out.replaceAll(`{${i}}`, String(arg));
    });
    return out;
  },
}));

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

type Props = {
  pendingApproval: PendingApprovalUi | null;
  pendingQuestions: PendingQuestionsUi | null;
};

const NONE: Props = { pendingApproval: null, pendingQuestions: null };

let root: Root;
let wrapper: HTMLDivElement;

beforeEach(() => {
  send.mockReset();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  // PendingCards mirrors --pending-card-h onto its overlay's parent (the
  // transcript wrapper in the real app), so the test needs that parent.
  wrapper = document.createElement("div");
  container.append(wrapper);
  root = createRoot(wrapper);
});

afterEach(() => {
  act(() => root.unmount());
  wrapper.parentElement?.remove();
});

function render(props: Partial<Props>) {
  act(() => root.render(<PendingCards {...NONE} {...props} />));
}

function slot(kind: "approval" | "questions"): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-pending-slot="${kind}"]`);
  expect(node, `slot ${kind}`).not.toBeNull();
  return node!;
}

/** The stack counter is the only button that controls the card list. */
function counterOrNull(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("[data-pending-counter]");
}

function counter(): HTMLButtonElement {
  const node = counterOrNull();
  expect(node).not.toBeNull();
  return node!;
}

/** Cards arrive one at a time (approval → question). */
function arriveBoth() {
  render({ pendingApproval: APPROVAL });
  render({ pendingApproval: APPROVAL, pendingQuestions: QUESTIONS });
}

/** The overlay shell — in the list layout it is the vertical scroll container. */
function overlay(): HTMLElement {
  const node = document.querySelector<HTMLElement>("[data-pending-overlay]");
  expect(node, "overlay").not.toBeNull();
  return node!;
}

describe("PendingCards", () => {
  it("单卡：完整渲染，不出现计数器与露边", () => {
    render({ pendingApproval: APPROVAL });

    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    // No counter at all: nothing is covered.
    expect(counterOrNull()).toBeNull();

    const only = slot("approval");
    expect(only.getAttribute("aria-hidden")).toBeNull();
    expect(only.hasAttribute("inert")).toBe(false);
    expect(only.style.height).toBe("");
    // Card stays a direct flex item of the overlay (bottom-aligned list).
    expect(only.className).toContain("contents");
  });

  it("2 卡：只有最新一张完整可见，另一张只露 8px 边且退出 Tab 链", () => {
    arriveBoth();

    // Both cards stay mounted (local state must survive the slide-under).
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(2);

    const top = slot("questions");
    expect(top.getAttribute("aria-hidden")).toBeNull();
    expect(top.hasAttribute("inert")).toBe(false);
    expect(top.style.height).toBe("");

    for (const kind of ["approval"] as const) {
      const covered = slot(kind);
      expect(covered.getAttribute("aria-hidden")).toBe("true");
      expect(covered.hasAttribute("inert")).toBe(true);
      expect(covered.className).toContain("pointer-events-none");
      expect(covered.style.height).toBe("8px");
      // The card itself is still in the DOM, just clipped behind the top one.
      expect(covered.querySelector('[role="alertdialog"]')).not.toBeNull();
    }

    // Visual stacking is order-based, oldest edge further from the top card.
    const edgeOrder = Number(slot("approval").style.order);
    const topOrder = Number(top.style.order);
    expect(edgeOrder).toBeLessThan(topOrder);
  });

  it("计数器：文案、N 与 aria-expanded 正确，可访问名带被压住卡的类型", () => {
    arriveBoth();

    const pill = counter();
    expect(pill.textContent).toContain("还有 1 张卡片待处理");
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    // The hidden card is the approval (arrived first).
    expect(pill.getAttribute("aria-label")).toBe(
      "还有 1 张卡片待处理：iFlow 想执行一项操作",
    );
    expect(pill.getAttribute("aria-controls")).toBe(document.querySelector("[data-pending-slot]")!.parentElement!.id);
    // Keyboard-focusable by default (real <button>).
    expect(pill.tagName).toBe("BUTTON");
  });

  it("点计数器展开两卡，再点收起回堆叠", () => {
    arriveBoth();

    act(() => counter().click());

    const expandedPill = counter();
    expect(expandedPill.getAttribute("aria-expanded")).toBe("true");
    expect(expandedPill.textContent).toContain("收起待处理卡");
    for (const kind of ["approval", "questions"] as const) {
      const open = slot(kind);
      expect(open.getAttribute("aria-hidden")).toBeNull();
      expect(open.hasAttribute("inert")).toBe(false);
      expect(open.style.height).toBe("");
      expect(open.className).toContain("contents");
    }
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(2);

    act(() => counter().click());
    expect(counter().getAttribute("aria-expanded")).toBe("false");
    expect(slot("questions").getAttribute("aria-hidden")).toBeNull();
    expect(slot("approval").getAttribute("aria-hidden")).toBe("true");
    expect(slot("approval").style.height).toBe("8px");
  });

  it("新卡到达成为堆顶（重渲染换 props）", () => {
    render({ pendingApproval: APPROVAL });
    render({ pendingApproval: APPROVAL, pendingQuestions: QUESTIONS });
    // Question arrived last → it is the fully visible card.
    expect(slot("questions").getAttribute("aria-hidden")).toBeNull();
    expect(slot("approval").getAttribute("aria-hidden")).toBe("true");
    expect(slot("approval").style.height).toBe("8px");
    expect(counter().textContent).toContain("还有 1 张卡片待处理");
  });

  it("同一 kind 换实例（新 id）：新卡成为堆顶，旧实例的戳不残留", () => {
    render({ pendingApproval: APPROVAL, pendingQuestions: QUESTIONS });
    // Question arrived second → it is the fully visible card.
    expect(slot("questions").getAttribute("aria-hidden")).toBeNull();
    expect(slot("approval").getAttribute("aria-hidden")).toBe("true");

    // The host replaces the approval with ANOTHER approval (same kind, new id)
    // inside one render cycle. Arrival order is keyed on the instance, so B is
    // newer than the question and must take the top spot; a kind-only key
    // would keep the stale stamp and leave the question on top.
    const APPROVAL_B: PendingApprovalUi = { ...APPROVAL, id: "approval-2", title: "Write b.ts" };
    render({ pendingApproval: APPROVAL_B, pendingQuestions: QUESTIONS });

    const top = slot("approval");
    expect(top.getAttribute("aria-hidden")).toBeNull();
    expect(top.hasAttribute("inert")).toBe(false);
    expect(top.style.height).toBe("");
    expect(top.textContent).toContain("Write b.ts");
    expect(slot("questions").getAttribute("aria-hidden")).toBe("true");
    expect(slot("questions").style.height).toBe("8px");
    expect(counter().textContent).toContain("还有 1 张卡片待处理");

    // Stale-key sweep: drop the approval, then bring the ORIGINAL A back. It
    // must get a fresh stamp (beating the older question), which only holds if
    // A's key was deleted when B replaced it.
    render({ pendingQuestions: QUESTIONS });
    render({ pendingApproval: APPROVAL, pendingQuestions: QUESTIONS });
    expect(slot("approval").getAttribute("aria-hidden")).toBeNull();
    expect(slot("questions").getAttribute("aria-hidden")).toBe("true");
  });

  it("两卡清空回到初始态：无残留卡片/计数器，清掉 --pending-card-h", () => {
    arriveBoth();
    act(() => counter().click()); // expanded → reset must also collapse
    expect(counter().getAttribute("aria-expanded")).toBe("true");
    expect(wrapper.style.getPropertyValue("--pending-card-h")).not.toBe("");

    render({});

    expect(document.querySelector("[data-pending-slot]")).toBeNull();
    expect(document.querySelector("[data-pending-top]")).toBeNull();
    expect(wrapper.style.getPropertyValue("--pending-card-h")).toBe("");

    // A fresh card starts a fresh stack (no stale expanded flag / stamps).
    render({ pendingApproval: APPROVAL });
    expect(counterOrNull()).toBeNull();
    expect(slot("approval").getAttribute("aria-hidden")).toBeNull();

    render({ pendingApproval: APPROVAL, pendingQuestions: QUESTIONS });
    expect(counter().getAttribute("aria-expanded")).toBe("false");
    expect(slot("questions").getAttribute("aria-hidden")).toBeNull();
  });
});

/**
 * The counter button in the EXPANDED list is `sticky top-0` inside the
 * overlay's own vertical scroll container, and it is a `card-lift` canvas
 * button: hovering lifts it 1px (translateY(-1px)). With the button's top
 * edge flush against the clip line, the lift pushed its top border outside
 * the scrollport and the border row was cut away entirely.
 *
 * Chromium + CDP, pixel-decoded (border-top painted red, strip decoded via
 * canvas): idle gapTop 0 (border row whole) → hover gapTop -1 (border row
 * reduced to 4 stray pixels = clipped).
 *
 * The clearance therefore has to come from the CONTAINER's top padding, so
 * the sticky box's constraint edge moves down with it: hover gapTop 3, the
 * border row stays whole. `overflow-y: visible` is NOT an option here — this
 * overlay must scroll vertically (the expanded list scrolls inside it and the
 * counter sticks to its top).
 *
 * The padding is scoped to count >= 2 (the expanded list): the single-card
 * layout and the stacked layout must not move by a single pixel.
 */
describe("PendingCards 计数按钮裁切不变量", () => {
  it("展开列表态：滚动容器留 4px 顶部内边距，计数按钮不贴裁剪线", () => {
    arriveBoth();

    // 堆叠态走的是另一个分支（无纵向裁剪），不需要顶部内边距。
    expect(overlay().className).not.toContain("overflow-y-auto");
    expect(overlay().className).not.toContain("pt-1");

    act(() => counter().click());

    // 展开态 = 列表布局 + 有计数按钮 → 顶部内边距把 sticky 按钮推离裁剪线。
    expect(overlay().className).toContain("overflow-y-auto");
    expect(overlay().className).toContain("pt-1");
    // 余量来自容器内边距，sticky 偏移仍是 top-0（别把它改成 top-N 顶替）。
    expect(counter().className).toContain("sticky top-0");
  });

  it("单卡态：容器无顶部内边距（单卡布局零变化）", () => {
    render({ pendingApproval: APPROVAL });

    expect(overlay().className).toContain("overflow-y-auto");
    expect(overlay().className).not.toContain("pt-1");
    // 单卡态没有计数按钮，也就没有 sticky 裁切问题。
    expect(counterOrNull()).toBeNull();
  });
});
