// @vitest-environment jsdom
/**
 * 底部「压缩上下文」按钮：
 *
 * 1. 单次点击只发一条 `{ type: "compressNow" }`（本地 1.5s 防抖）。
 * 2. 会话未就绪 / 正在生成 / 正在停止 / 正在压缩 / 无内容可压时禁用。
 *
 * 真守卫都在宿主（compressNowFromComposer + runCompressTurn），这里只锁
 * UI 契约：只有一个按钮、只发一条消息、禁用态齐全。
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../webview/src/components/Composer";
import { initialSessionState, type Block, type SessionState } from "../shared/messages";

const mocked = vi.hoisted(() => ({
  send: vi.fn(),
  notify: vi.fn(),
  beginPending: vi.fn(),
  state: undefined as SessionState | undefined,
}));

const useChat = vi.hoisted(() =>
  Object.assign(
    <T,>(selector: (s: Record<string, unknown>) => T) =>
      selector({
        state: mocked.state,
        pending: null,
        send: mocked.send,
        beginPending: mocked.beginPending,
        notify: mocked.notify,
      }),
    {
      getState: () => ({ state: mocked.state, send: mocked.send, notify: mocked.notify }),
    },
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
  modeDisplay: () => ({ label: "mode", desc: "" }),
}));
vi.mock("../webview/src/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../webview/src/components/ui")>();
  return {
    ...actual,
    Dropdown: ({
      trigger,
      children,
    }: {
      trigger: (open: boolean) => ReactNode;
      children: ReactNode | ((close: () => void) => ReactNode);
    }) => (
      <>
        {trigger(false)}
        {typeof children === "function" ? children(() => {}) : children}
      </>
    ),
    fuzzyScore: () => 0,
  };
});

const USER_BLOCK: Block = { kind: "user", text: "hello", id: "user-1" };

let root: Root;
let container: HTMLDivElement;

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    ...initialSessionState(),
    status: "idle",
    sessionId: "s1",
    activeSessionId: "s1",
    blocks: [USER_BLOCK],
    ...overrides,
  };
}

function render(overrides: Partial<SessionState> = {}): void {
  mocked.state = makeState(overrides);
  act(() => root.render(<Composer />));
}

function compressButton(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('button[aria-label="压缩上下文"]');
  expect(el).toBeTruthy();
  return el!;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocked.send.mockReset();
  mocked.notify.mockReset();
  mocked.beginPending.mockReset();
  class Observer {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  }
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = Observer;
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = Observer;
  Element.prototype.scrollIntoView = () => {};
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("压缩上下文按钮", () => {
  it("单次点击只发一条 compressNow（重复点击被防抖吞掉）", () => {
    render();
    const button = compressButton();
    expect(button.disabled).toBe(false);

    act(() => button.click());
    // 第二下：本地锁已生效（按钮同时进入禁用态），不会再发一条。
    act(() => button.click());

    const sent = mocked.send.mock.calls.map((call) => call[0] as { type: string });
    expect(sent.filter((msg) => msg.type === "compressNow")).toHaveLength(1);
  });

  it("streaming 时禁用", () => {
    render({ status: "streaming" });
    expect(compressButton().disabled).toBe(true);
  });

  it("cancelling（宿主权威停止窗口）时禁用", () => {
    render({ cancelling: true });
    expect(compressButton().disabled).toBe(true);
  });

  it("compressing 时禁用，并显示 spinner", () => {
    render({ compressing: true });
    const button = compressButton();
    expect(button.disabled).toBe(true);
    expect(button.querySelector(".animate-spin")).toBeTruthy();
  });

  it("没有 user 块（无内容可压）时禁用", () => {
    render({ blocks: [] });
    expect(compressButton().disabled).toBe(true);
  });

  it("needsSetup 时禁用", () => {
    const state = makeState();
    render({ auth: { ...state.auth, needsSetup: true } });
    expect(compressButton().disabled).toBe(true);
  });
});
