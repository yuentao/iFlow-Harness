// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApprovalCard } from "../webview/src/components/ApprovalCard";
import { PlanExitCard } from "../webview/src/components/PlanExitCard";
import type { PendingApprovalUi, PendingPlanExitUi } from "../shared/messages";

const send = vi.hoisted(() => vi.fn());
const useChat = vi.hoisted(() =>
  Object.assign(
    (selector: (state: { send: typeof send }) => unknown) => selector({ send }),
    { getState: () => ({ send }) },
  ),
);
vi.mock("../webview/src/store", () => ({ useChat }));
vi.mock("../webview/src/i18n", () => ({ t: (s: string) => s }));

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

it("shows the approval shortcut hint", () => {
  act(() => root.render(<ApprovalCard approval={APPROVAL} />));
  expect(container.textContent).toContain("Y 允许一次 · N 拒绝 · Esc 取消");
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

it("shows the plan shortcut hint and the edit-scope clarification", () => {
  act(() => root.render(<PlanExitCard pending={PLAN} />));
  expect(container.textContent).toContain("Y 批准 · N 拒绝 · R 重新规划");
  const edit = [...container.querySelectorAll("button")].find((b) => b.textContent === "编辑");
  expect(edit).toBeTruthy();
  act(() => edit!.click());
  expect(container.textContent).toContain("「批准计划」执行原计划");
});
