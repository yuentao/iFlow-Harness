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

/**
 * ESC 语义收敛：卡片通过 window 监听持有 ESC，不再依赖焦点是否落在卡片
 * 子树内。焦点在卡片外（例如 Composer / body）时同样 deny，且事件被
 * preventDefault，避免漏到 Composer 的「ESC 停止生成」造成一次按键两种语义。
 */
it("denies Esc from the window even when focus is outside the card, and consumes the event", () => {
  act(() => root.render(<ApprovalCard approval={APPROVAL} />));
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => {
    window.dispatchEvent(event);
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith({
    type: "respondApproval",
    id: "approval-1",
    optionId: "reject-1",
  });
  expect(event.defaultPrevented).toBe(true);
});

it("does not deny Esc from a covered approval card: only the top card owns it", () => {
  act(() =>
    root.render(
      <>
        <ApprovalCard approval={{ ...APPROVAL, id: "approval-under" }} active={false} />
        <ApprovalCard approval={{ ...APPROVAL, id: "approval-top" }} />
      </>,
    ),
  );
  key("Escape");
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith({
    type: "respondApproval",
    id: "approval-top",
    optionId: "reject-1",
  });
});

it("does not deny Esc while a modal sits above the card", () => {
  act(() => root.render(<ApprovalCard approval={APPROVAL} />));
  const backdrop = document.createElement("div");
  backdrop.className = "auth-backdrop";
  document.body.append(backdrop);
  key("Escape");
  expect(send).not.toHaveBeenCalled();
  backdrop.remove();
});

it("does not deny Esc from an editable target", () => {
  act(() => root.render(<ApprovalCard approval={APPROVAL} />));
  const input = document.createElement("input");
  document.body.append(input);
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(send).not.toHaveBeenCalled();
  input.remove();
});

it("dismisses a question card on Esc with an empty answer, and consumes the event", () => {
  act(() => root.render(<QuestionCard pending={QUESTIONS} />));
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => {
    window.dispatchEvent(event);
  });
  expect(send).toHaveBeenCalledWith({ type: "answerQuestions", id: "q-1", answers: {} });
  expect(event.defaultPrevented).toBe(true);
});

it("does not let a covered question card answer Esc", () => {
  act(() =>
    root.render(
      <>
        <QuestionCard pending={{ ...QUESTIONS, id: "q-under" }} active={false} />
        <QuestionCard pending={{ ...QUESTIONS, id: "q-top" }} />
      </>,
    ),
  );
  key("Escape");
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "answerQuestions", id: "q-top" }));
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

/** Dispatch a key event another handler already consumed (`defaultPrevented`). */
function keyAlreadyHandled(keyValue: string) {
  act(() => {
    const event = new KeyboardEvent("keydown", { key: keyValue, bubbles: true, cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);
  });
}

/**
 * Shared gate contract (ApprovalCard / QuestionCard `window` keydown handlers):
 * a shortcut must not answer a card when the event was already consumed by a
 * handler above it. Both cards check `e.defaultPrevented` before doing anything,
 * so a second consumer of the same key can never silently approve/deny/dismiss
 * behind the user's back.
 */
it("ignores an already-defaultPrevented Y on an approval card", () => {
  act(() => root.render(<ApprovalCard approval={APPROVAL} />));
  keyAlreadyHandled("y");
  expect(send).not.toHaveBeenCalled();
});

it("ignores an already-defaultPrevented N on an approval card", () => {
  act(() => root.render(<ApprovalCard approval={APPROVAL} />));
  keyAlreadyHandled("n");
  expect(send).not.toHaveBeenCalled();
});

it("ignores an already-defaultPrevented Escape on an approval card", () => {
  act(() => root.render(<ApprovalCard approval={APPROVAL} />));
  keyAlreadyHandled("Escape");
  expect(send).not.toHaveBeenCalled();
});

it("ignores Escape on a question card while a modal sits above it", () => {
  act(() => root.render(<QuestionCard pending={QUESTIONS} />));
  const backdrop = document.createElement("div");
  backdrop.className = "auth-backdrop";
  document.body.append(backdrop);
  key("Escape");
  expect(send).not.toHaveBeenCalled();
  backdrop.remove();
});

it("ignores Escape on a question card originating from a select element", () => {
  act(() => root.render(<QuestionCard pending={QUESTIONS} />));
  const select = document.createElement("select");
  document.body.append(select);
  act(() => {
    select.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(send).not.toHaveBeenCalled();
  select.remove();
});

it("ignores an already-defaultPrevented Escape on a question card", () => {
  act(() => root.render(<QuestionCard pending={QUESTIONS} />));
  keyAlreadyHandled("Escape");
  expect(send).not.toHaveBeenCalled();
});

/** Dispatch a key on whatever currently owns focus — a real keystroke always
 * targets the focused element, which is what makes the autofocus race visible. */
function keyAtFocus(keyValue: string) {
  act(() => {
    (document.activeElement ?? window).dispatchEvent(
      new KeyboardEvent("keydown", { key: keyValue, bubbles: true, cancelable: true }),
    );
  });
}

/** IME keystrokes: the composition start/commit can carry keyCode 229 / key
 * "Process" while isComposing is already false. */
function imeKey(keyValue: string, keyCode?: number) {
  act(() => {
    const event = new KeyboardEvent("keydown", { key: keyValue, bubbles: true, cancelable: true });
    if (keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: keyCode });
    window.dispatchEvent(event);
  });
}

/**
 * BUG regression: a card pushed while the user is typing used to autofocus a
 * button on mount. Focus left the Composer textarea, so the user's next real
 * keystroke targeted that BUTTON — no longer an editable target — and the
 * window-level handler read it as Y/N/Esc, answering a card the user had not
 * looked at yet. The card must keep the user's typing focus instead.
 */
it("弹审批卡时不抢走正在输入的 textarea 焦点，后续按键不误触 Y/N", () => {
  const textarea = document.createElement("textarea");
  document.body.append(textarea);
  act(() => textarea.focus());
  expect(document.activeElement).toBe(textarea);

  act(() => root.render(<ApprovalCard approval={APPROVAL} />));
  // 焦点必须仍留在输入框，而不是被卡片按钮抢走。
  expect(document.activeElement).toBe(textarea);

  keyAtFocus("y");
  keyAtFocus("n");
  expect(send).not.toHaveBeenCalled();
  textarea.remove();
});

it("弹问答卡时不抢走正在输入的 textarea 焦点，后续按键不误触 Esc", () => {
  const textarea = document.createElement("textarea");
  document.body.append(textarea);
  act(() => textarea.focus());

  act(() => root.render(<QuestionCard pending={QUESTIONS} />));
  expect(document.activeElement).toBe(textarea);

  keyAtFocus("Escape");
  expect(send).not.toHaveBeenCalled();
  textarea.remove();
});

it("审批卡忽略 IME 组合键（keyCode 229 / key Process），不误判为 Y", () => {
  act(() => root.render(<ApprovalCard approval={APPROVAL} />));
  imeKey("y", 229);
  imeKey("Process");
  expect(send).not.toHaveBeenCalled();
});

it("问答卡忽略 IME 组合键（keyCode 229），不误判为 Esc", () => {
  act(() => root.render(<QuestionCard pending={QUESTIONS} />));
  imeKey("Escape", 229);
  expect(send).not.toHaveBeenCalled();
});

/**
 * Normal path preserved: with focus genuinely on the card (no editor typing),
 * the mount autofocus still lands on the safe option and the shortcuts fire.
 */
it("无输入焦点时卡片仍自动聚焦安全按钮，Y/N/Esc 快捷键照常生效", () => {
  act(() => root.render(<ApprovalCard approval={APPROVAL} />));
  const pinned = container.querySelector<HTMLElement>("[data-autofocus]");
  expect(document.activeElement).toBe(pinned);
  keyAtFocus("y");
  expect(send).toHaveBeenCalledWith({
    type: "respondApproval",
    id: "approval-1",
    optionId: "allow-1",
  });
});
