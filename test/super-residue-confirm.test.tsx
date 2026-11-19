// @vitest-environment jsdom
/**
 * Super Agent 残留清空确认框的 webview 侧闭环：
 * 收到 host 的 superResidueConfirm → 用消息里组装好的文案弹 ConfirmDialog →
 * 点确认/取消只回传一次 respondSuperResidueConfirm 并关闭弹框。
 *
 * acquireVsCodeApi 在 store 模块求值时被读取，因此用 vi.hoisted 在导入前
 * 注入桩，捕获所有 webview → host 消息；文案用可区分的字面量，验证 webview
 * 不改写、不重新翻译 host 下发的字符串。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const capture = vi.hoisted(() => {
  const posted: Array<Record<string, unknown>> = [];
  (globalThis as typeof globalThis & {
    acquireVsCodeApi: () => { postMessage: (m: unknown) => void };
  }).acquireVsCodeApi = () => ({
    postMessage: (m: unknown) => {
      posted.push(m as Record<string, unknown>);
    },
  });
  return { posted };
});

import { useChat } from "../webview/src/store";
import { SuperResidueConfirmDialog } from "../webview/src/components/SuperResidueConfirmDialog";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const REQUEST = {
  type: "superResidueConfirm" as const,
  requestId: "super-residue-test-1",
  title: "清空并新建会话？",
  message: "检测到 3 个历史子会话残留：未合并 worktree 的未提交改动将永久丢失且不可恢复。",
  confirmLabel: "清空并新建",
  cancelLabel: "取消",
};

let container: HTMLDivElement;
let root: Root;

function buttonByText(text: string): HTMLButtonElement {
  const btn = Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!btn) throw new Error(`button not found: ${text}`);
  return btn;
}

function postRequest(request: typeof REQUEST): void {
  act(() => useChat.getState().applyHostMessage(request));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  capture.posted.length = 0;
  useChat.setState({ superResidueConfirm: null });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<SuperResidueConfirmDialog />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useChat.setState({ superResidueConfirm: null });
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe("SuperResidueConfirmDialog", () => {
  it("no request → nothing rendered", () => {
    expect(useChat.getState().superResidueConfirm).toBeNull();
    expect(document.body.textContent).not.toContain(REQUEST.title);
  });

  it("shows the dialog with the host-provided title/message/button labels verbatim", () => {
    postRequest(REQUEST);
    expect(useChat.getState().superResidueConfirm).toEqual(REQUEST);
    expect(document.body.textContent).toContain(REQUEST.title);
    expect(document.body.textContent).toContain(REQUEST.message);
    expect(buttonByText(REQUEST.confirmLabel)).toBeTruthy();
    expect(buttonByText(REQUEST.cancelLabel)).toBeTruthy();
  });

  it("backdrop mousedown does not answer or close the dialog", () => {
    postRequest(REQUEST);
    const backdrop = document.body.querySelector<HTMLElement>(".auth-backdrop");
    expect(backdrop).toBeTruthy();
    act(() => {
      backdrop!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    expect(capture.posted.filter((m) => m.type === "respondSuperResidueConfirm")).toHaveLength(0);
    expect(useChat.getState().superResidueConfirm).toEqual(REQUEST);
    expect(document.body.textContent).toContain(REQUEST.title);
  });

  it("confirm posts confirmed:true exactly once and closes the dialog", () => {
    postRequest(REQUEST);
    act(() => {
      buttonByText(REQUEST.confirmLabel).click();
    });
    expect(capture.posted).toEqual([
      { type: "respondSuperResidueConfirm", requestId: REQUEST.requestId, confirmed: true },
    ]);
    expect(useChat.getState().superResidueConfirm).toBeNull();
    expect(document.body.textContent).not.toContain(REQUEST.title);
    // A second answer (racing click / Esc) must not post again.
    act(() => useChat.getState().respondSuperResidueConfirm(true));
    expect(capture.posted).toHaveLength(1);
  });

  it("cancel posts confirmed:false and closes the dialog", () => {
    const request = { ...REQUEST, requestId: "super-residue-test-2" };
    postRequest(request);
    act(() => {
      buttonByText(request.cancelLabel).click();
    });
    expect(capture.posted).toEqual([
      { type: "respondSuperResidueConfirm", requestId: request.requestId, confirmed: false },
    ]);
    expect(useChat.getState().superResidueConfirm).toBeNull();
    expect(document.body.textContent).not.toContain(request.title);
  });
});
