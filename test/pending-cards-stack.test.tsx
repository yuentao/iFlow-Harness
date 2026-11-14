// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingCards } from "../webview/src/components/PendingCards";
import type { PendingApprovalUi, PendingPlanExitUi, PendingQuestionsUi } from "../shared/messages";

const send = vi.hoisted(() => vi.fn());
const useChat = vi.hoisted(() =>
  Object.assign(
    (selector: (state: { send: typeof send }) => unknown) => selector({ send }),
    { getState: () => ({ send }) },
  ),
);
vi.mock("../webview/src/store", () => ({ useChat }));
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

const PLAN: PendingPlanExitUi = {
  id: "plan-1",
  plan: "# Plan\n\n- step one",
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
  pendingPlanExit: PendingPlanExitUi | null;
  pendingQuestions: PendingQuestionsUi | null;
};

const NONE: Props = { pendingApproval: null, pendingPlanExit: null, pendingQuestions: null };

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

function slot(kind: "approval" | "planExit" | "questions"): HTMLElement {
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

/** Cards arrive one at a time (approval → plan-exit → question). */
function arriveAllThree() {
  render({ pendingApproval: APPROVAL });
  render({ pendingApproval: APPROVAL, pendingPlanExit: PLAN });
  render({ pendingApproval: APPROVAL, pendingPlanExit: PLAN, pendingQuestions: QUESTIONS });
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

  it("3 卡：只有最新一张完整可见，另两张只露 8px 边且退出 Tab 链", () => {
    arriveAllThree();

    // All three cards stay mounted (local state must survive the slide-under).
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(3);

    const top = slot("questions");
    expect(top.getAttribute("aria-hidden")).toBeNull();
    expect(top.hasAttribute("inert")).toBe(false);
    expect(top.style.height).toBe("");

    for (const kind of ["approval", "planExit"] as const) {
      const covered = slot(kind);
      expect(covered.getAttribute("aria-hidden")).toBe("true");
      expect(covered.hasAttribute("inert")).toBe(true);
      expect(covered.className).toContain("pointer-events-none");
      expect(covered.style.height).toBe("8px");
      // The card itself is still in the DOM, just clipped behind the top one.
      expect(covered.querySelector('[role="alertdialog"]')).not.toBeNull();
    }

    // Visual stacking is order-based, oldest edge furthest from the top card.
    const edgeOrder = Number(slot("approval").style.order);
    const newerEdgeOrder = Number(slot("planExit").style.order);
    const topOrder = Number(top.style.order);
    expect(edgeOrder).toBeLessThan(newerEdgeOrder);
    expect(newerEdgeOrder).toBeLessThan(topOrder);
  });

  it("计数器：文案、N 与 aria-expanded 正确，可访问名带被压住卡的类型", () => {
    arriveAllThree();

    const pill = counter();
    expect(pill.textContent).toContain("还有 2 个待处理");
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    // Hidden cards are plan-exit (arrived second) and approval (arrived first).
    expect(pill.getAttribute("aria-label")).toBe(
      "还有 2 个待处理：iFlow 请求退出 Plan 模式、iFlow 请求执行",
    );
    expect(pill.getAttribute("aria-controls")).toBe(document.querySelector("[data-pending-slot]")!.parentElement!.id);
    // Keyboard-focusable by default (real <button>).
    expect(pill.tagName).toBe("BUTTON");
  });

  it("点计数器展开三卡，再点收起回堆叠", () => {
    arriveAllThree();

    act(() => counter().click());

    const expandedPill = counter();
    expect(expandedPill.getAttribute("aria-expanded")).toBe("true");
    expect(expandedPill.textContent).toContain("收起待处理卡");
    for (const kind of ["approval", "planExit", "questions"] as const) {
      const open = slot(kind);
      expect(open.getAttribute("aria-hidden")).toBeNull();
      expect(open.hasAttribute("inert")).toBe(false);
      expect(open.style.height).toBe("");
      expect(open.className).toContain("contents");
    }
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(3);

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

    // A plan-exit card arriving afterwards takes the top spot, pushing the
    // question card under it.
    render({ pendingApproval: APPROVAL, pendingPlanExit: PLAN, pendingQuestions: QUESTIONS });
    expect(slot("planExit").getAttribute("aria-hidden")).toBeNull();
    expect(slot("planExit").style.height).toBe("");
    expect(slot("questions").getAttribute("aria-hidden")).toBe("true");
    expect(slot("questions").style.height).toBe("8px");
    expect(counter().textContent).toContain("还有 2 个待处理");
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
    expect(counter().textContent).toContain("还有 1 个待处理");

    // Stale-key sweep: drop the approval, then bring the ORIGINAL A back. It
    // must get a fresh stamp (beating the older question), which only holds if
    // A's key was deleted when B replaced it.
    render({ pendingQuestions: QUESTIONS });
    render({ pendingApproval: APPROVAL, pendingQuestions: QUESTIONS });
    expect(slot("approval").getAttribute("aria-hidden")).toBeNull();
    expect(slot("questions").getAttribute("aria-hidden")).toBe("true");
  });

  it("三卡清空回到初始态：无残留卡片/计数器，清掉 --pending-card-h", () => {
    arriveAllThree();
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
