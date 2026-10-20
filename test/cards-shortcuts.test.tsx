// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApprovalCard } from "../webview/src/components/ApprovalCard";
import { PlanExitCard } from "../webview/src/components/PlanExitCard";
import { QuestionCard } from "../webview/src/components/QuestionCard";
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

it("states the approval shortcut hint once, matching how Esc actually resolves", () => {
  act(() => root.render(<ApprovalCard approval={APPROVAL} />));
  expect(container.textContent.match(/Y 允许一次/g)?.length).toBe(1);
  expect(container.textContent).toContain("N/Esc 拒绝");
});

it("keeps the Esc = cancel wording only when no reject option exists", () => {
  act(() => root.render(<ApprovalCard approval={{ ...APPROVAL, options: [{ optionId: "allow-1", name: "Allow once", kind: "allow_once" }] }} />));
  expect(container.textContent).toContain("Esc 取消");
});

it("approves a plan with Y", () => {
  act(() => root.render(<PlanExitCard pending={PLAN} />));
  key("y");
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "respondPlanExit",
      id: "plan-1",
      approved: true,
      replan: false,
    }),
  );
});

it("replans with R", () => {
  act(() => root.render(<PlanExitCard pending={PLAN} />));
  key("r");
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "respondPlanExit",
      id: "plan-1",
      approved: false,
      replan: true,
    }),
  );
});

it("shows the plan shortcut hint once, and the edit-state primary button names the action", () => {
  act(() => root.render(<PlanExitCard pending={PLAN} />));
  expect(container.textContent).toContain("Y 批准 · N 拒绝 · R 重新规划");
  const edit = [...container.querySelectorAll("button")].find((b) => b.textContent === "编辑");
  expect(edit).toBeTruthy();
  act(() => edit!.click());
  // The edit-scope caveat now lives in ONE place (the tooltip); the edit-mode
  // action button states the consequence outright instead.
  expect(container.textContent).toContain("保存并重新规划");
  expect(container.textContent).not.toContain("「批准计划」执行原计划");
});

it("autofocuses the plan card's reject, so Enter cannot start execution", () => {
  act(() => root.render(<PlanExitCard pending={PLAN} />));
  const pinned = container.querySelectorAll("[data-autofocus]");
  expect(pinned.length).toBe(1);
  expect(pinned[0]!.textContent).toBe("拒绝计划");
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
