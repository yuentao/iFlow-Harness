// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProfileSwitchCard } from "../webview/src/components/ProfileSwitchCard";

const send = vi.hoisted(() => vi.fn());
const clearPending = vi.hoisted(() => vi.fn());
vi.mock("../webview/src/store", async () => {
  const { createStoreMock } = await import("./helpers/store-mock");
  const mock = createStoreMock();
  // 断言仍落在文件级 vi.fn 上；把这两个 action 接到工厂 store，其余全表面由工厂兜住。
  mock.store.send = send;
  mock.store.clearPending = clearPending;
  return mock;
});
vi.mock("../webview/src/i18n", () => ({ t: (s: string) => s }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  send.mockReset();
  clearPending.mockReset();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<ProfileSwitchCard pending={{ id: "pswitch-1", profileName: "B" }} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function click(label: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).toBeTruthy();
  act(() => button!.click());
}

it("clears the optimistic profile lock when the switch is cancelled", () => {
  click("取消切换");
  expect(clearPending).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith({ type: "respondProfileSwitch", id: "pswitch-1", keepSession: null });
});

it("keeps the lock while re-authentication is about to start", () => {
  click("停留在当前会话");
  expect(clearPending).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledWith({ type: "respondProfileSwitch", id: "pswitch-1", keepSession: true });
});

it("keeps the lock when starting a new session", () => {
  click("开启新会话");
  expect(clearPending).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledWith({ type: "respondProfileSwitch", id: "pswitch-1", keepSession: false });
});
