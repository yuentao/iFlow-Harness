// @vitest-environment jsdom
/**
 * 多仓库协作的 Composer 根选择器：多根工作区才出现、多选用 ToggleChip、
 * 点击写回 `setSessionRoots`、至少保留一个根、`pendingChange` 时提示「新会话
 * 生效」。真实宿主会渲染同一组 aria 语义，这里锁住行为而不是截图。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../webview/src/components/Composer";
import { initialSessionState, type SessionState } from "../shared/messages";

const mocked = vi.hoisted(() => ({
  send: vi.fn(),
  notify: vi.fn(),
  state: undefined as SessionState | undefined,
}));

const useChat = vi.hoisted(() =>
  Object.assign(
    <T,>(selector: (s: Record<string, unknown>) => T) =>
      selector({
        state: mocked.state,
        pending: null,
        send: mocked.send,
        beginPending: vi.fn(),
        notify: mocked.notify,
        composerDraftRequest: null,
        clearDraftRequest: vi.fn(),
      }),
    { getState: () => ({ state: mocked.state, send: mocked.send, notify: mocked.notify }) },
  ),
);

vi.mock("../webview/src/store", () => ({ useChat }));
vi.mock("../webview/src/i18n", () => ({ t: (s: string, ...args: unknown[]) => `${s}${args.length ? ` ${args.join(" ")}` : ""}`, modeDisplay: () => ({ label: "mode", desc: "" }) }));

if (!("ResizeObserver" in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
/** React 19 refuses `act()` unless the environment declares itself act-capable. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

const ROOT_A = "J:\\git\\repo-a";
const ROOT_B = "J:\\git\\repo-b";

function stateWithRoots(patch: Partial<NonNullable<SessionState["workspaceRoots"]>>): SessionState {
  const state = initialSessionState();
  state.status = "idle";
  state.sessionId = "s1";
  state.activeSessionId = "s1";
  state.workspaceRoots = {
    roots: [
      { path: ROOT_A, name: "repo-a" },
      { path: ROOT_B, name: "repo-b" },
    ],
    selected: [ROOT_A, ROOT_B],
    applied: [ROOT_A, ROOT_B],
    pendingChange: false,
    ...patch,
  };
  return state;
}

function chipLabels(): Array<{ label: string; pressed: string | null }> {
  return [...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].map((button) => ({
    label: button.textContent?.trim() ?? "",
    pressed: button.getAttribute("aria-pressed"),
  }));
}

beforeEach(() => {
  mocked.send.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  mocked.state = undefined;
});

describe("Composer · 多仓库目标根选择器", () => {
  it("多根工作区渲染每个根的 chip，并按 selected 标出选中态", () => {
    mocked.state = stateWithRoots({ selected: [ROOT_A], applied: [ROOT_A] });
    act(() => root.render(<Composer />));

    const chips = chipLabels().filter((c) => c.label === "repo-a" || c.label === "repo-b");
    expect(chips).toEqual([
      { label: "repo-a", pressed: "true" },
      { label: "repo-b", pressed: "false" },
    ]);
    // 与 applied 一致时不应出现「新会话生效」提示
    expect(container.textContent).not.toContain("新会话生效");
  });

  it("点击未选中的根，把完整的新集合写回宿主", () => {
    mocked.state = stateWithRoots({ selected: [ROOT_A], applied: [ROOT_A] });
    act(() => root.render(<Composer />));

    const b = [...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(
      (button) => button.textContent?.trim() === "repo-b",
    );
    expect(b).toBeTruthy();
    act(() => b!.click());
    expect(mocked.send).toHaveBeenCalledWith({ type: "setSessionRoots", roots: [ROOT_A, ROOT_B] });
  });

  it("不允许取消最后一个根（否则等于只剩 cwd）", () => {
    mocked.state = stateWithRoots({ selected: [ROOT_A], applied: [ROOT_A] });
    act(() => root.render(<Composer />));

    const a = [...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(
      (button) => button.textContent?.trim() === "repo-a",
    );
    act(() => a!.click());
    expect(mocked.send).not.toHaveBeenCalled();
  });

  it("selected 与 applied 不同时提示「新会话生效」", () => {
    mocked.state = stateWithRoots({ selected: [ROOT_A, ROOT_B], applied: [ROOT_A], pendingChange: true });
    act(() => root.render(<Composer />));
    expect(container.textContent).toContain("新会话生效");
  });

  it("单根工作区（投影为 null）不渲染选择器", () => {
    const state = initialSessionState();
    state.status = "idle";
    state.workspaceRoots = null;
    mocked.state = state;
    act(() => root.render(<Composer />));
    expect(chipLabels().filter((c) => c.label === "repo-a" || c.label === "repo-b")).toEqual([]);
  });
});
