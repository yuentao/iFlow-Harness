// @vitest-environment jsdom
/**
 * 图片读取失败的兜底：FileReader.onerror 必须撤掉空占位槽并提示，绝不能
 * 在输入区留下一个 data 为空的破图（发送时空槽会被过滤，但界面上不该残留）。
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

vi.mock("../webview/src/store", async () => {
  const { createStoreMock } = await import("./helpers/store-mock");
  const mock = createStoreMock();
  // 工厂兜住 ChatStore 全表面；本文件只覆盖可变会话、pending 与断言用 action。
  const live = () =>
    ({
      ...mock.store,
      state: mocked.state,
      pending: mocked.pending,
      send: mocked.send,
      beginPending: mocked.beginPending,
      notify: mocked.notify,
    }) as unknown as import("./helpers/store-mock").StoreMockState;
  const useChat = Object.assign(
    <T,>(selector: (s: ReturnType<typeof live>) => T): T => selector(live()),
    { getState: live },
  );
  return { ...mock, useChat, getState: live };
});
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

/** 文件名以 bad 开头的图模拟读取失败，其余正常读出一份假 base64。 */
class FakeFileReader {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result: string | ArrayBuffer | null = null;
  private name = "";

  readAsDataURL(file: File): void {
    this.name = file.name;
    queueMicrotask(() => {
      if (this.name.startsWith("bad")) {
        this.onerror?.();
      } else {
        this.result = `data:${file.type || "image/png"};base64,QUJD`;
        this.onload?.();
      }
    });
  }
}

const OriginalFileReader = globalThis.FileReader;

let root: Root;
let container: HTMLDivElement;

function render(): void {
  mocked.state = { ...initialSessionState(), status: "idle" };
  act(() => root.render(<Composer />));
}

function pasteFiles(files: File[]): void {
  const textarea = container.querySelector("textarea")!;
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files } });
  act(() => {
    textarea.dispatchEvent(event);
  });
}

function settle(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
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
  globalThis.FileReader = FakeFileReader as unknown as typeof FileReader;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.FileReader = OriginalFileReader;
});

describe("图片读取失败兜底", () => {
  it("读取失败时撤掉占位槽：既没有破图 <img>，也没有空占位，并发出提示", async () => {
    render();
    pasteFiles([new File(["x"], "bad.png", { type: "image/png" })]);

    // 读取还没落地时占位槽可见（mimeType 为占位的 image/*）。
    expect(container.querySelectorAll("span[title='image/*']")).toHaveLength(1);
    expect(container.querySelectorAll("img[src^='data:']")).toHaveLength(0);

    await settle();

    // 失败后空槽被回收：没有破图、没有空槽，整行输入说明也一起消失。
    expect(container.querySelectorAll("img[src^='data:']")).toHaveLength(0);
    expect(container.querySelectorAll("span[title='image/*']")).toHaveLength(0);
    expect(container.textContent).not.toContain("图片说明（可选");
    expect(mocked.notify).toHaveBeenCalledWith("图片读取失败，已跳过", "warning");
  });

  it("一张成功一张失败：只保留成功的那张，空槽不残留", async () => {
    render();
    pasteFiles([
      new File(["x"], "bad.png", { type: "image/png" }),
      new File(["y"], "good.png", { type: "image/png" }),
    ]);
    expect(container.querySelectorAll("span[title='image/*']")).toHaveLength(2);

    await settle();

    expect(container.querySelectorAll("img[src^='data:']")).toHaveLength(1);
    expect(container.querySelectorAll("span[title='image/*']")).toHaveLength(0);
    expect(mocked.notify).toHaveBeenCalledWith("图片读取失败，已跳过", "warning");
  });
});
