// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApprovalCard } from "../webview/src/components/ApprovalCard";
import { PendingCards } from "../webview/src/components/PendingCards";
import { QuestionCard } from "../webview/src/components/QuestionCard";
import type { PendingApprovalUi, PendingQuestionsUi } from "../shared/messages";

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

const QUESTIONS: PendingQuestionsUi = {
  id: "q-1",
  questions: [
    {
      header: "framework",
      question: "Which framework?",
      options: [{ label: "React", description: "React 19 with hooks" }],
      multiSelect: false,
    },
    {
      header: "notes",
      question: "Anything else worth noting?",
      options: [],
      multiSelect: false,
    },
  ],
  deadline: Date.now() + 60_000,
  timeoutMs: 60_000,
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  send.mockReset();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function key(keyValue: string) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: keyValue, bubbles: true }));
  });
}

it("approves with Y, picks the first allow option regardless of wire order", () => {
  act(() => root.render(<ApprovalCard approval={APPROVAL} />));
  key("y");
  expect(send).toHaveBeenCalledWith({
    type: "respondApproval",
    id: "approval-1",
    optionId: "allow-1",
  });
});

it("rejects with N and ignores editable targets", () => {
  act(() => root.render(<ApprovalCard approval={APPROVAL} />));
  const input = document.createElement("input");
  document.body.append(input);
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true }));
  });
  expect(send).not.toHaveBeenCalled();

  key("n");
  expect(send).toHaveBeenCalledWith({
    type: "respondApproval",
    id: "approval-1",
    optionId: "reject-1",
  });
  input.remove();
});

it("does not bind Y to an allow-always option", () => {
  act(() =>
    root.render(
      <ApprovalCard
        approval={{
          ...APPROVAL,
          options: [
            { optionId: "always-1", name: "始终允许", kind: "allow_always" },
            { optionId: "reject-1", name: "拒绝", kind: "reject_once" },
          ],
        }}
      />,
    ),
  );
  key("y");
  expect(send).not.toHaveBeenCalled();
});

it("ignores shortcuts while a modal sits above the card", () => {
  act(() => root.render(<ApprovalCard approval={APPROVAL} />));
  const backdrop = document.createElement("div");
  backdrop.className = "auth-backdrop";
  document.body.append(backdrop);
  key("y");
  expect(send).not.toHaveBeenCalled();
  backdrop.remove();
});

it("ignores shortcuts originating from a select element", () => {
  act(() => root.render(<ApprovalCard approval={APPROVAL} />));
  const select = document.createElement("select");
  document.body.append(select);
  act(() => {
    select.dispatchEvent(new KeyboardEvent("keydown", { key: "y", bubbles: true }));
  });
  expect(send).not.toHaveBeenCalled();
  select.remove();
});

/**
 * Safety regression: the pending overlay stacks cards and marks the buried
 * ones `inert`, but `inert` only removes a subtree from focus / hit-testing /
 * the accessibility tree — a `keydown` listener on `window` still fires. A
 * covered approval card therefore used to approve a decision the user could
 * not see, just because they pressed Y for the card on top.
 */
it("does not approve from a covered card: only the top card answers Y", () => {
  act(() =>
    root.render(
      <>
        <ApprovalCard approval={{ ...APPROVAL, id: "approval-under" }} active={false} />
        <ApprovalCard approval={{ ...APPROVAL, id: "approval-top" }} />
      </>,
    ),
  );
  key("y");
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith({
    type: "respondApproval",
    id: "approval-top",
    optionId: "allow-1",
  });
});

it("does not deny from a covered card either: N only answers the top card", () => {
  act(() =>
    root.render(
      <>
        <ApprovalCard approval={{ ...APPROVAL, id: "approval-under" }} active={false} />
        <ApprovalCard approval={{ ...APPROVAL, id: "approval-top" }} />
      </>,
    ),
  );
  key("n");
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith({
    type: "respondApproval",
    id: "approval-top",
    optionId: "reject-1",
  });
});

it("keeps a buried approval in the real stack from answering Y", () => {
  // Approval arrives first, then a question arrives on top of it: the
  // approval is now the covered card (`inert` in the DOM) and must be silent.
  act(() => root.render(<PendingCards pendingApproval={APPROVAL} pendingQuestions={null} />));
  act(() => root.render(<PendingCards pendingApproval={APPROVAL} pendingQuestions={QUESTIONS} />));
  key("y");
  expect(send).not.toHaveBeenCalled();
});

it("keeps the top-most approval in the real stack answering Y", () => {
  act(() => root.render(<PendingCards pendingApproval={null} pendingQuestions={QUESTIONS} />));
  act(() => root.render(<PendingCards pendingApproval={APPROVAL} pendingQuestions={QUESTIONS} />));
  key("y");
  expect(send).toHaveBeenCalledWith({
    type: "respondApproval",
    id: "approval-1",
    optionId: "allow-1",
  });
});

it("states the approval shortcut hint once, matching how Esc actually resolves", () => {
  act(() => root.render(<ApprovalCard approval={APPROVAL} />));
  expect(container.textContent.match(/Y 允许一次/g)?.length).toBe(1);
  expect(container.textContent).toContain("N/Esc 拒绝");
});

it("keeps the Esc = cancel wording only when no reject option exists", () => {
  act(() => root.render(<ApprovalCard approval={{ ...APPROVAL, options: [{ optionId: "allow-1", name: "Allow once", kind: "allow_once" }] }} />));
  expect(container.textContent).toContain("Esc 取消");
});

it("autofocuses the approval card's reject option, never an allow button", () => {
  act(() => root.render(<ApprovalCard approval={APPROVAL} />));
  const pinned = container.querySelectorAll("[data-autofocus]");
  expect(pinned.length).toBe(1);
  expect(pinned[0]!.textContent).toBe("拒绝");
});

it("falls back to 取消 for the initial focus only when no reject option exists", () => {
  act(() =>
    root.render(
      <ApprovalCard
        approval={{
          ...APPROVAL,
          options: [{ optionId: "allow-1", name: "Allow once", kind: "allow_once" }],
        }}
      />,
    ),
  );
  const pinned = container.querySelectorAll("[data-autofocus]");
  expect(pinned.length).toBe(1);
  expect(pinned[0]!.textContent).toBe("取消");
});

it("answers Esc with the agent's own reject option (one deny affordance, no 取消 twin)", () => {
  act(() => root.render(<ApprovalCard approval={APPROVAL} />));
  const headerButton = container.querySelector("button")!;
  act(() => {
    headerButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(send).toHaveBeenCalledWith({
    type: "respondApproval",
    id: "approval-1",
    optionId: "reject-1",
  });
});

it("drops the 取消 twin when the agent already offered a reject option", () => {
  act(() => root.render(<ApprovalCard approval={APPROVAL} />));
  const group = container.querySelector('[role="group"]')!;
  const labels = [...group.querySelectorAll("button")].map((b) => b.textContent);
  expect(labels).toEqual(["允许一次", "拒绝"]);
});

it("renders canonical verb labels for the four kinds and keeps the CLI wording in title", () => {
  act(() =>
    root.render(
      <ApprovalCard
        approval={{
          ...APPROVAL,
          options: [
            { optionId: "allow-1", name: "Allow for once", kind: "allow_once" },
            { optionId: "always-1", name: "Allow always for this session", kind: "allow_always" },
            { optionId: "reject-1", name: "Do not run this command", kind: "reject_once" },
          ],
        }}
      />,
    ),
  );
  const group = container.querySelector('[role="group"]')!;
  const buttons = [...group.querySelectorAll("button")];
  expect(buttons.map((b) => b.textContent)).toEqual(["允许一次", "始终允许", "拒绝"]);
  expect(buttons.map((b) => b.getAttribute("title"))).toContain("Allow for once");
});

it("keeps the countdown quiet until the last minute", () => {
  act(() => root.render(<ApprovalCard approval={{ ...APPROVAL, deadline: Date.now() + 300_000 }} />));
  expect(container.textContent).toContain("约 5 分钟后自动拒绝");
});

it("brings the countdown bar in during the final minute", () => {
  act(() => root.render(<ApprovalCard approval={APPROVAL} />));
  expect(container.textContent).not.toContain("自动拒绝");
});

it("keeps a single free-text Enter local: it confirms that answer, not the card", () => {
  act(() => root.render(<QuestionCard pending={QUESTIONS} />));
  const other = [...container.querySelectorAll("button")].find((b) => b.textContent.includes("其他"));
  expect(other).toBeTruthy();
  act(() => other!.click());
  const input = container.querySelector("input");
  expect(input).toBeTruthy();
  act(() => {
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(send).not.toHaveBeenCalled();
});

it("commits the whole question card only from the explicit submit button", () => {
  act(() => root.render(<QuestionCard pending={QUESTIONS} />));
  const submitBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === "提交回答");
  expect(submitBtn).toBeTruthy();
  act(() => {
    submitBtn!.click();
  });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "answerQuestions", id: "q-1" }));
});

/**
 * Overlay height contract (narrow-window regression): the pending cards are
 * bottom-aligned in a shell that starts below the header. Each card must cap
 * at that shell (max-h-full) and scroll its BODY internally, so a long
 * approval title / diff can never grow the card upward over the header
 * (which made the header controls unclickable). The decision row must stay
 * outside the scroll body: it is the one thing that must never scroll away.
 */
function expectCappedCard(root: Element, actionRowLabel: string) {
  expect(root.classList.contains("max-h-full")).toBe(true);
  expect(root.classList.contains("flex-col")).toBe(true);

  const bodies = [...root.querySelectorAll<HTMLElement>("*")].filter(
    (el) => el.classList.contains("min-h-0") && el.classList.contains("overflow-y-auto"),
  );
  // Exactly one scroll body — a second one would mean a nested scroll region
  // (the old title/diff caps) competing with the card-level scroll.
  expect(bodies).toHaveLength(1);
  const body = bodies[0]!;

  const actions = root.querySelector<HTMLElement>(
    `[role="group"][aria-label="${actionRowLabel}"]`,
  );
  expect(actions).toBeTruthy();
  // DOM structure, not just a class-name string: the action row is a sibling
  // of the scroll body, never a descendant of it.
  expect(body.contains(actions!)).toBe(false);
  expect(root.contains(actions!)).toBe(true);

  return { body, actions: actions! };
}

it("caps the approval card and keeps its action row outside the scroll body", () => {
  act(() => root.render(<ApprovalCard approval={APPROVAL} />));
  const { body, actions } = expectCappedCard(container.firstElementChild!, "审批操作");
  expect(body.querySelectorAll("button")).toHaveLength(0);
  expect(actions.querySelectorAll("button")).toHaveLength(2);
});

it("caps the question card and keeps its action row outside the scroll body", () => {
  act(() => root.render(<QuestionCard pending={QUESTIONS} />));
  const { actions } = expectCappedCard(container.firstElementChild!, "回答操作");
  expect(actions.querySelectorAll("button")).toHaveLength(2);
});

it("keeps the approval actions rendered when the title is long enough to overflow", () => {
  // 200 lines is far taller than any 360×800 viewport's available card height.
  const longTitle = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  act(() => root.render(<ApprovalCard approval={{ ...APPROVAL, title: longTitle }} />));
  const { body, actions } = expectCappedCard(container.firstElementChild!, "审批操作");
  // The long title really lives in the scroll body…
  expect(body.textContent).toContain("line 199");
  // …and the decision buttons are still there, outside it.
  expect([...actions.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
    "允许一次",
    "拒绝",
  ]);
});

/**
 * Diff preview cap contract: the approval card is already capped by the
 * overlay shell, so the diff must take a coarse container-relative cap
 * (45vh) instead of arithmetic on the viewport height — a `100vh` guess
 * ignored the header, the Super Agent board and the resizable Composer and
 * pushed the card past the shell.
 */
it("caps the approval diff preview at 45vh, never with viewport arithmetic", () => {
  act(() =>
    root.render(
      <ApprovalCard
        approval={{
          ...APPROVAL,
          toolKind: "edit",
          diff: { path: "webview/src/App.tsx", oldText: "a\nb", newText: "a\nc" },
        }}
      />,
    ),
  );
  const diff = container.querySelector<HTMLElement>(".diff-scroll");
  expect(diff).toBeTruthy();
  expect(diff!.classList.contains("max-h-[45vh]")).toBe(true);
  expect(container.innerHTML).not.toContain("calc(100vh");
});
