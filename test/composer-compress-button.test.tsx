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
  remoteTakeover: false as boolean,
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
        remoteTakeover: mocked.remoteTakeover,
      }),
    {
      getState: () => ({
        state: mocked.state,
        send: mocked.send,
        notify: mocked.notify,
        remoteTakeover: mocked.remoteTakeover,
      }),
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

function render(overrides: Partial<SessionState> = {}, remoteTakeover = false): void {
  mocked.state = makeState(overrides);
  mocked.remoteTakeover = remoteTakeover;
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
  mocked.remoteTakeover = false;
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

  it("title 是「压缩上下文，减少 token 占用」", () => {
    render();
    expect(compressButton().title).toBe("压缩上下文，减少 token 占用");
  });

  it("图标是折叠语义（ChevronsDownUp），不再是「缩到角落」的箭头", () => {
    render();
    const button = compressButton();
    // lucide 把图标名写进 class（lucide-<kebab-name>），用它锁语义，
    // 不去断言易碎的 SVG path 字符串。
    const icon = button.querySelector("svg.lucide-chevrons-down-up");
    expect(icon).toBeTruthy();
    // 尺寸必须落在 ICON_INLINE 档（size-3.5），不写死任意值。
    expect(icon!.getAttribute("class")).toContain("size-3.5");
    // 旧图标 Minimize2（两枚斜箭头缩到角落）读起来像「最小化窗口」，必须消失。
    expect(button.querySelector("svg.lucide-minimize-2")).toBeNull();
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

  it("initializing 时禁用", () => {
    render({ initializing: true });
    expect(compressButton().disabled).toBe(true);
  });

  it("replaying 时禁用", () => {
    render({ replaying: true });
    expect(compressButton().disabled).toBe(true);
  });

  it("remoteTakeover（远程接管）时禁用", () => {
    render({}, true);
    expect(compressButton().disabled).toBe(true);
  });
});
