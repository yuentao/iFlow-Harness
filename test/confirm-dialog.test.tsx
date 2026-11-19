// @vitest-environment jsdom
/**
 * A 方案回归：ConfirmDialog 默认只能由显式按钮关闭。
 * 遮罩 mousedown / ESC / 头部 X 都不应触发 onCancel（静默取消高危操作），
 * 但「取消」按钮必须仍然可用（用户始终有显式出口）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as typeof globalThis & {
    acquireVsCodeApi: () => { postMessage: (m: unknown) => void };
  }).acquireVsCodeApi = () => ({ postMessage: () => {} });
});

vi.mock("../webview/src/i18n", () => ({ t: (s: string) => s }));

import { ConfirmDialog } from "../webview/src/components/ui";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root;
let container: HTMLDivElement;
let onCancel: ReturnType<typeof vi.fn>;

function backdrop(): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(".auth-backdrop");
  if (!el) throw new Error("backdrop not found");
  return el;
}

function buttonByText(text: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`button not found: ${text}`);
  return btn;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  onCancel = vi.fn();
  act(() =>
    root.render(
      <ConfirmDialog title="删除会话？" message="此操作不可撤销" cancelLabel="取消" onCancel={onCancel} />,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it("backdrop mousedown does not cancel and leaves the dialog open", () => {
  act(() => {
    backdrop().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  });
  expect(onCancel).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alertdialog"]')).toBeTruthy();
});

it("Escape keydown does not cancel and leaves the dialog open", () => {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(onCancel).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alertdialog"]')).toBeTruthy();
});

it("renders no header X close button", () => {
  expect(document.querySelector('button[aria-label="收起"]')).toBeNull();
});

it("explicit 取消 button still cancels (there is always an exit)", () => {
  act(() => {
    buttonByText("取消").click();
  });
  expect(onCancel).toHaveBeenCalledTimes(1);
});
