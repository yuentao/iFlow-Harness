// @vitest-environment jsdom
/**
 * 对话区反馈（输入区）：
 *
 * 1. 粘贴/拖入文件先出现「暂存中…」占位 chip，宿主回包后替换为真实 chip。
 * 2. @文件搜索请求在飞时弹层显示「搜索中…」，回包后恢复。
 * 3. @文件夹解析在飞时出现「解析中…」占位卡，回包后变成上下文卡。
 * 4. 模型 / 思考强度 / 模式切换在飞时触发按钮显示 Loader2 并禁用，回包后恢复。
 * 5. 停止请求在飞时按钮显示「正在停止…」并禁用，状态回 idle 后恢复。
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../webview/src/components/Composer";
import { initialSessionState, type SessionState } from "../shared/messages";

const mocked = vi.hoisted(() => ({
  send: vi.fn(),
  notify: vi.fn(),
  beginPending: vi.fn(),
  state: undefined as SessionState | undefined,
  pending: null as { kind: string; target: string } | null,
}));

const useChat = vi.hoisted(() =>
  Object.assign(
    <T,>(selector: (s: Record<string, unknown>) => T) =>
      selector({
        state: mocked.state,
        pending: mocked.pending,
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

let root: Root;
let container: HTMLDivElement;

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return { ...initialSessionState(), status: "idle", ...overrides };
}

function render(overrides: Partial<SessionState> = {}): void {
  mocked.state = makeState(overrides);
  act(() => root.render(<Composer />));
}

function rerender(overrides: Partial<SessionState> = {}): void {
  mocked.state = makeState(overrides);
  act(() => root.render(<Composer />));
}

function change(textarea: HTMLTextAreaElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pasteFiles(files: File[]): void {
  const textarea = container.querySelector("textarea")!;
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files } });
  act(() => {
    textarea.dispatchEvent(event);
  });
}

function sentOfType(type: string): Record<string, unknown> | undefined {
  return mocked.send.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .find((msg) => msg.type === type);
}

function hostMessage(data: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data }));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocked.send.mockReset();
  mocked.notify.mockReset();
  mocked.beginPending.mockReset();
  mocked.pending = null;
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
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("文件暂存占位", () => {
  it("粘贴后立即出现「暂存中…」占位，回包后替换为真实 chip", async () => {
    render();
    pasteFiles([new File(["hello"], "notes.txt", { type: "text/plain" })]);

    // 占位在 FileReader / 宿主回包之前就可见。
    expect(container.textContent).toContain("暂存中…");
    expect(container.textContent).toContain("notes.txt");

    // FileReader 读完 → stageFiles 发出。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const staged = sentOfType("stageFiles");
    expect(staged).toBeTruthy();

    // 宿主回包 → 占位消失，真实附件 chip 出现（title 是绝对路径）。
    hostMessage({ type: "stagedFiles", requestId: staged!.requestId, paths: ["C:\\tmp\\notes.txt"] });
    expect(container.textContent).not.toContain("暂存中…");
    const chip = [...container.querySelectorAll("span")].find(
      (span) => span.getAttribute("title") === "C:\\tmp\\notes.txt",
    );
    expect(chip?.textContent).toContain("notes.txt");
  });
});

describe("@ 搜索与上下文解析的进行态", () => {
  it("搜索请求在飞时显示「搜索中…」，回包后恢复为空结果", async () => {
    render();
    const textarea = container.querySelector("textarea")!;
    change(textarea, "@a");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(container.textContent).toContain("搜索中…");

    const search = sentOfType("searchFiles");
    expect(search).toBeTruthy();
    hostMessage({ type: "fileList", requestId: search!.requestId, hits: [] });
    expect(container.textContent).not.toContain("搜索中…");
    expect(container.textContent).toContain("无匹配文件");
  });

  it("文件夹解析在飞时显示「解析中…」，回包后变成上下文卡", async () => {
    render();
    const textarea = container.querySelector("textarea")!;
    change(textarea, "@/");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    const search = sentOfType("searchFiles");
    expect(search).toBeTruthy();
    hostMessage({ type: "fileList", requestId: search!.requestId, hits: [{ path: "src" }] });

    const row = [...container.querySelectorAll("button")].find((b) => b.textContent === "src");
    expect(row).toBeTruthy();
    act(() => {
      row!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain("解析中…");
    const resolve = sentOfType("resolveContext");
    expect(resolve).toBeTruthy();
    hostMessage({
      type: "contextResolved",
      requestId: resolve!.requestId,
      kind: "folder",
      label: "src",
      detail: "",
      content: "ab",
    });
    expect(container.textContent).not.toContain("解析中…");
    expect(container.textContent).toContain("2 字符");
  });
});

describe("切换控件的进行态", () => {
  const models = [
    { id: "m1", name: "Model One" },
    { id: "m2", name: "Model Two" },
  ];
  it("模型切换在飞时显示 Loader2 且禁用，回包后恢复", () => {
    render({ models, currentModelId: "m1" });
    expect(container.querySelector('button[title="模型"]')).toBeTruthy();

    mocked.pending = { kind: "model", target: "m2" };
    act(() => root.render(<Composer />));
    const busy = container.querySelector<HTMLButtonElement>('button[title="切换中…"]');
    expect(busy).toBeTruthy();
    expect(busy!.disabled).toBe(true);
    expect(busy!.querySelector(".animate-spin")).toBeTruthy();

    mocked.pending = null;
    act(() => root.render(<Composer />));
    expect(container.querySelector('button[title="模型"]')).toBeTruthy();
    expect(container.querySelector('button[title="切换中…"]')).toBeNull();
  });

  it("思考强度切换在飞时同样显示 Loader2", () => {
    render({ models, currentModelId: "m1" });
    mocked.pending = { kind: "think", target: "deep" };
    act(() => root.render(<Composer />));
    expect(container.querySelector('button[title="切换中…"]')).toBeTruthy();
  });

  });

describe("停止请求的进行态", () => {
  it("点击停止后按钮显示「正在停止…」并禁用，状态回 idle 后恢复", () => {
    render({ status: "streaming" });
    const stop = container.querySelector<HTMLButtonElement>('button[title="停止生成"]');
    expect(stop).toBeTruthy();
    act(() => stop!.click());
    expect(mocked.send).toHaveBeenCalledWith({ type: "cancel" });

    const stopping = container.querySelector<HTMLButtonElement>('button[title="正在停止…"]');
    expect(stopping).toBeTruthy();
    expect(stopping!.disabled).toBe(true);
    expect(stopping!.querySelector(".animate-spin")).toBeTruthy();

    rerender({ status: "idle" });
    expect(container.querySelector('button[title="正在停止…"]')).toBeNull();
    expect(container.querySelector('button[title="停止生成"]')).toBeNull();
    expect(container.textContent).toContain("发送");
  });
});
