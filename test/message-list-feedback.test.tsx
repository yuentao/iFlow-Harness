// @vitest-environment jsdom
/**
 * 对话区反馈（转录侧）：
 *
 * 1. 复制回执——工具输出 / 用户消息 / 助手消息的复制按钮过去是
 *    `void copyText(...)`，成功与失败长得一模一样。现在成功后图标切 Check
 *    （2s 复位），失败发一条错误 toast。
 * 2. 转录底部浮动 pill——过去一律写「正在创建新会话…」，删除会话 / 删除
 *    消息 / 回滚 / 恢复都被说成新建会话。现在按 `initializingReason` 显示。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageList } from "../webview/src/components/MessageList";
import { initialSessionState, type InitializingReason, type SessionState } from "../shared/messages";

const store = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("../webview/src/store", () => ({
  useChat: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(store.current),
    { getState: () => store.current },
  ),
}));

vi.mock("../webview/src/i18n", () => ({
  t: (s: string, ...args: Array<string | number>) => {
    let out = s;
    args.forEach((arg, i) => {
      out = out.replaceAll(`{${i}}`, String(arg));
    });
    return out;
  },
}));

let root: Root;
let container: HTMLDivElement;
const notify = vi.fn();

function stateWithText(): SessionState {
  const state = initialSessionState();
  state.status = "idle";
  state.sessionId = "s1";
  state.blocks = [{ kind: "text", id: "b-1", text: "先读一下仓库结构。" }];
  return state;
}

function render(state: SessionState, focusMode = false): void {
  store.current = {
    state,
    toasts: [],
    send: vi.fn(),
    notify,
    dismissToast: vi.fn(),
    setHeaderScrolled: vi.fn(),
    focusMode,
    promptSeq: 0,
    requestDraft: vi.fn(),
    requestMemoryDraft: vi.fn(),
  };
  act(() => root.render(<MessageList />));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  notify.mockReset();
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): [] {
      return [];
    }
  }
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = Observer;
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = Observer;
  Element.prototype.scrollTo = () => {};
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function setClipboard(writeText: () => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

async function clickCopy(): Promise<void> {
  const btn = container.querySelector<HTMLButtonElement>('button[aria-label="复制"]');
  expect(btn).toBeTruthy();
  await act(async () => {
    btn!.click();
    // copyText is wrapped in Promise.resolve().then(...) — two microtask hops.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("复制回执", () => {
  it("成功后切到「已复制」，2 秒后复位", async () => {
    vi.useFakeTimers();
    setClipboard(() => Promise.resolve());
    render(stateWithText());
    await clickCopy();
    expect(container.querySelector('button[aria-label="已复制"]')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(container.querySelector('button[aria-label="已复制"]')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.querySelector('button[aria-label="已复制"]')).toBeNull();
    expect(container.querySelector('button[aria-label="复制"]')).toBeTruthy();
  });

  it("失败时不显示已复制，并发出错误 toast", async () => {
    setClipboard(() => Promise.reject(new Error("denied")));
    render(stateWithText());
    await clickCopy();
    expect(notify).toHaveBeenCalledWith("复制失败", "error");
    expect(container.querySelector('button[aria-label="已复制"]')).toBeNull();
  });
});

describe("转录底部浮动 pill 的忙碌文案", () => {
  const cases: Array<[InitializingReason, string]> = [
    ["newSession", "正在创建新会话…"],
    ["deleteSession", "正在删除会话…"],
    ["deleteMessage", "正在删除消息…"],
    ["rollback", "正在回滚对话…"],
    ["restore", "正在恢复会话…"],
  ];

  for (const [reason, label] of cases) {
    it(`initializingReason=${reason} → ${label}`, () => {
      const state = stateWithText();
      state.initializing = true;
      state.initializingReason = reason;
      render(state);
      const text = container.textContent ?? "";
      expect(text).toContain(label);
      for (const [, other] of cases) {
        if (other === label) continue;
        expect(text).not.toContain(other);
      }
    });
  }

  it("缺失 reason（旧宿主 / mock）回退到新建会话文案", () => {
    const state = stateWithText();
    state.initializing = true;
    state.initializingReason = null;
    render(state);
    expect(container.textContent ?? "").toContain("正在创建新会话…");
  });
});

describe("待决卡与 Focus 视图的 pill / 空态判据", () => {
  function streamingState(): SessionState {
    const state = stateWithText();
    state.status = "streaming";
    return state;
  }

  it("流式且有块时显示「正在生成」pill", () => {
    render(streamingState());
    expect(container.textContent ?? "").toContain("正在生成");
  });

  it("提问卡待回答时不显示「正在生成」pill", () => {
    const state = streamingState();
    state.pendingQuestions = {
      id: "q-1",
      questions: [{ header: "h", question: "Q?", options: [], multiSelect: false }],
      deadline: Date.now() + 60_000,
      timeoutMs: 60_000,
    };
    render(state);
    expect(container.textContent ?? "").not.toContain("正在生成");
  });

  it("审批卡待决时不显示「正在生成」pill", () => {
    const state = streamingState();
    state.pendingApproval = {
      id: "a-1",
      toolName: "write_file",
      title: "write",
      toolKind: "edit",
      locations: [],
      options: [{ optionId: "o", name: "允许", kind: "allow_once" }],
      deadline: Date.now() + 60_000,
      timeoutMs: 60_000,
    };
    render(state);
    expect(container.textContent ?? "").not.toContain("正在生成");
  });

  it("Focus 视图下本轮只有工具块时不误显空状态，且 pill 按未过滤块数显示", () => {
    const state = streamingState();
    state.blocks = [{ kind: "tool", id: "t-1", toolName: "run", status: "completed", content: "ok" } as never];
    render(state, true);
    // Focus view filters the tool block out of visibleBlocks, but the empty
    // state must key off the UNFILTERED transcript.
    expect(container.querySelector(".empty-state")).toBeNull();
    // The pill likewise keys off state.blocks, not the filtered view.
    expect(container.textContent ?? "").toContain("正在生成");
  });
});

describe("窄屏内联编辑器", () => {
  it("编辑器容器可收缩、动作行可换行，不设 280px 硬下限", () => {
    const state = stateWithText();
    state.blocks = [{ kind: "user", id: "u-1", text: "一条较长的问题需要编辑" }];
    render(state);
    const editBtn = container.querySelector<HTMLButtonElement>('button[aria-label="编辑并重发该消息"]');
    expect(editBtn).toBeTruthy();
    act(() => editBtn!.click());
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑消息"]');
    expect(textarea).toBeTruthy();
    // TextArea kit wraps the field in a `relative grid content-start` div.
    const editor = textarea!.parentElement!.parentElement!;
    expect(editor.className).toContain("min-w-0");
    expect(editor.className).not.toContain("min-w-[280px]");
    const actionRow = editor.children[1] as HTMLElement;
    expect(actionRow.className).toContain("flex-wrap");
  });
});
