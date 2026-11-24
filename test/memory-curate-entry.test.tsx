// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer, isMemoryCurateCommand, MEMORY_CURATE_COMMAND } from "../webview/src/components/Composer";
import { MemorySection } from "../webview/src/components/MemoryCard";
import { initialSessionState, type MemoryStateUi, type SessionState } from "../shared/messages";

/**
 * 「整理记忆」的两个主动入口（记忆页按钮 + Composer `/memory-curate`）
 * 与「移除多余按钮」的回归锁。
 *
 * 两条入口必须复用同一个 host 通道 `curateMemoryNow`（MaintenanceScheduler
 * 的 manual run），回包 `memoryCurated` 带 requestId 以便按钮结束 loading
 * 并展示失败；旧回包不得结束新一轮的 loading。
 */

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
    Dropdown: ({ trigger }: { trigger: (open: boolean) => ReactNode }) => <>{trigger(false)}</>,
    fuzzyScore: () => 0,
  };
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocked.send.mockReset();
  mocked.notify.mockReset();
  mocked.state = { ...initialSessionState(), status: "idle", sessionId: "s1", activeSessionId: "s1" } as SessionState;
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
  Element.prototype.scrollIntoView = () => {};
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const MEM_STATE = {
  home: "/home/.iflow",
  cwd: null,
  workspaceRoots: [],
  files: [],
  globalPrimary: null,
  projectPrimary: null,
} as unknown as MemoryStateUi;

function hostMessage(data: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data }));
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!btn) throw new Error(`找不到文案为「${text}」的按钮`);
  return btn;
}

function sentOfType(type: string): Record<string, unknown> | undefined {
  return mocked.send.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .find((msg) => msg.type === type);
}

function typeInComposer(value: string): HTMLTextAreaElement {
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return textarea;
}

function pressKey(el: HTMLElement, key: string): void {
  act(() => el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key })));
}

describe("记忆页：整理记忆按钮", () => {
  it("点击发送 curateMemoryNow（带 requestId），执行中显示 loading", () => {
    act(() => root.render(<MemorySection busy={false} onHeader={() => {}} />));
    hostMessage({ type: "memoryState", state: MEM_STATE });

    act(() => buttonByText("整理记忆").click());
    const sent = sentOfType("curateMemoryNow");
    expect(sent).toBeDefined();
    expect(typeof sent!.requestId).toBe("number");
    // loading 文案替换按钮正文
    expect(buttonByText("整理中…")).toBeTruthy();
    expect(buttonByText("整理中…").disabled).toBe(true);
  });

  it("回包按 requestId 认领：成功显示摘要，旧 requestId 不回写", () => {
    act(() => root.render(<MemorySection busy={false} onHeader={() => {}} />));
    hostMessage({ type: "memoryState", state: MEM_STATE });
    act(() => buttonByText("整理记忆").click());
    const requestId = sentOfType("curateMemoryNow")!.requestId as number;

    // 迟到的旧回包：不得结束 loading
    hostMessage({ type: "memoryCurated", requestId: requestId - 1, ok: true, message: "旧结果" });
    expect(buttonByText("整理中…")).toBeTruthy();

    hostMessage({ type: "memoryCurated", requestId, ok: true, message: "应用 2 个文件 · 节省 30 tokens" });
    expect(buttonByText("整理记忆")).toBeTruthy();
    const status = container.querySelector('[role="status"][aria-live="polite"]');
    expect(status?.textContent).toContain("应用 2 个文件");
  });

  it("失败回包就地显示 role=alert 错误", () => {
    act(() => root.render(<MemorySection busy={false} onHeader={() => {}} />));
    hostMessage({ type: "memoryState", state: MEM_STATE });
    act(() => buttonByText("整理记忆").click());
    const requestId = sentOfType("curateMemoryNow")!.requestId as number;

    hostMessage({ type: "memoryCurated", requestId, ok: false, message: "记忆整理未能开始：可能已在运行" });
    const alert = [...container.querySelectorAll('[role="alert"]')].find((el) =>
      el.textContent?.includes("可能已在运行"),
    );
    expect(alert).toBeTruthy();
    // 失败后按钮回到可点状态
    expect(buttonByText("整理记忆").disabled).toBe(false);
  });
});

describe("记忆页：多余按钮整排已移除", () => {
  it("页尾不再有「新建会话 / 重启内核使记忆生效 / 改动不会影响正在进行的会话」", () => {
    act(() => root.render(<MemorySection busy={false} onHeader={() => {}} />));
    hostMessage({ type: "memoryState", state: MEM_STATE });
    const text = container.textContent ?? "";
    expect(text).not.toContain("重启内核使记忆生效");
    expect(text).not.toContain("改动不会影响正在进行的会话。");
    // 「新建会话」在记忆页已无按钮（顶栏入口仍在 App.tsx）
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.trim() === "新建会话")).toBe(false);
    expect(sentOfType("restartCli")).toBeUndefined();
    expect(sentOfType("newSession")).toBeUndefined();
  });

  it("源码里不再残留该排的 handler / i18n key", () => {
    const card = readFileSync(join(__dirname, "..", "webview", "src", "components", "MemoryCard.tsx"), "utf8");
    expect(card).not.toContain("重启内核使记忆生效");
    expect(card).not.toContain("改动不会影响正在进行的会话");
    const i18n = readFileSync(join(__dirname, "..", "webview", "src", "i18n.ts"), "utf8");
    expect(i18n).not.toContain("重启内核使记忆生效");
    expect(i18n).not.toContain("改动不会影响正在进行的会话。");
  });
});

describe("Composer：/memory-curate 指令", () => {
  it("解析只认完整指令（带参数按普通提示词）", () => {
    expect(isMemoryCurateCommand(`/${MEMORY_CURATE_COMMAND}`)).toBe(true);
    expect(isMemoryCurateCommand(`  /${MEMORY_CURATE_COMMAND}  `)).toBe(true);
    expect(isMemoryCurateCommand(`/${MEMORY_CURATE_COMMAND} extra`)).toBe(false);
    expect(isMemoryCurateCommand("/memory")).toBe(false);
  });

  it("输入完整指令按回车直接触发 host 整理，不发提示词", () => {
    act(() => root.render(<Composer />));
    const textarea = typeInComposer(`/${MEMORY_CURATE_COMMAND}`);
    pressKey(textarea, "Enter");

    const sent = sentOfType("curateMemoryNow");
    expect(sent).toBeDefined();
    expect(typeof sent!.requestId).toBe("number");
    expect(sentOfType("sendPrompt")).toBeUndefined();
    expect(textarea.value).toBe("");
    expect(mocked.notify).toHaveBeenCalled();
  });

  it("slash 弹窗列出该指令，选中后补全", () => {
    act(() => root.render(<Composer />));
    const textarea = typeInComposer("/mem");
    // 弹窗里出现该指令行
    expect(container.textContent).toContain(`/${MEMORY_CURATE_COMMAND}`);
    pressKey(textarea, "Enter");
    expect(textarea.value).toBe(`/${MEMORY_CURATE_COMMAND} `);
    // 补全不触发整理
    expect(sentOfType("curateMemoryNow")).toBeUndefined();
  });
});
