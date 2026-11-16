// @vitest-environment jsdom
/**
 * 审批策略「已保存」必须等宿主回执（webview 侧）。
 *
 * 旧实现 `send({type:"saveApprovalPolicy"})` 之后立刻 setSavedFlash(true)：
 * 宿主那边 globalState.update 还没写、甚至写失败，卡片也已经宣称「已保存」。
 * 现在卡片进入「保存中…」，只有收到带 `saveResult:"ok"` 的 approvalPolicy
 * 回包才闪「已保存」；`saveResult:"failed"` 时不闪（宿主另有 toast 说明原因）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalPolicySection } from "../webview/src/components/ApprovalPolicyCard";
import type { ApprovalRule } from "../shared/messages";

const send = vi.hoisted(() => vi.fn());

vi.mock("../webview/src/store", () => ({
  useChat: Object.assign(
    (selector: (s: { send: typeof send }) => unknown) => selector({ send }),
    { getState: () => ({ send }) },
  ),
}));

vi.mock("../webview/src/i18n", () => ({
  t: (s: string, ...args: string[]) => s.replace(/\{(\d+)\}/g, (_, i) => args[Number(i)] ?? ""),
}));

const RULES: ApprovalRule[] = [
  { id: "rule-a", label: "允许读取 src", enabled: true, action: "allow", path: "src/**" },
];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  send.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function dispatch(data: unknown): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data }));
  });
}

function render(): void {
  act(() =>
    root.render(
      <ApprovalPolicySection busy={false} onHeader={() => {}} />,
    ),
  );
  dispatch({ type: "approvalPolicy", rules: RULES, projectRules: [], draft: null });
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === text,
  ) as HTMLButtonElement | undefined;
}

describe("审批策略保存回执", () => {
  it("点击保存后进入「保存中…」，宿主未回包前不显示「已保存」", () => {
    render();
    const save = buttonByText("保存");
    expect(save).toBeTruthy();

    act(() => save!.click());

    expect(send).toHaveBeenCalledWith({ type: "saveApprovalPolicy", rules: RULES });
    expect(container.textContent).toContain("保存中…");
    expect(container.textContent).not.toContain("已保存");
  });

  it("saveResult:ok 回包后才闪「已保存」", () => {
    render();
    act(() => buttonByText("保存")!.click());
    expect(container.textContent).not.toContain("已保存");

    dispatch({ type: "approvalPolicy", rules: RULES, projectRules: [], draft: null, saveResult: "ok" });

    expect(container.textContent).toContain("已保存");
    expect(container.textContent).not.toContain("保存中…");
  });

  it("saveResult:failed 回包不宣称已保存，且退回可再次保存", () => {
    render();
    act(() => buttonByText("保存")!.click());

    dispatch({ type: "approvalPolicy", rules: RULES, projectRules: [], draft: null, saveResult: "failed" });

    expect(container.textContent).not.toContain("已保存");
    expect(container.textContent).not.toContain("保存中…");
    expect(buttonByText("保存")).toBeTruthy();
  });
});
