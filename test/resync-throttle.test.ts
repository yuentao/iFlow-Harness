// @vitest-environment jsdom
/**
 * WebView resync 节流补发（真实 webview store，只 mock `acquireVsCodeApi`）：
 * unanchorable `blockPatch` 请求的 `ready` 在 1s 窗口内不得被直接丢弃 —— 第二次
 * 失配必须在窗口边界补发一次；整窗突发只补一次，避免风暴；首次仍立即触发。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostToWebview } from "../shared/messages";

const postMessage = vi.fn();
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({ postMessage });

/** 固定且足够大的 epoch，确保首次请求一定在节流窗口之外（lastResyncAt 初值 0）。 */
const START = 1_700_000_000_000;

let useChat: typeof import("../webview/src/store").useChat;

/** 永远无法锚定的 blockPatch → store 走 requestResync() 分支后直接 return。 */
function unanchorablePatch(): HostToWebview {
  return {
    type: "blockPatch",
    baseVersion: -1,
    tailStart: 0,
    blocks: [],
    tail: {} as never, // resync 分支在读取 tail 之前就返回
  };
}

function readyCount(): number {
  return postMessage.mock.calls.filter(
    ([msg]) => (msg as { type?: unknown })?.type === "ready",
  ).length;
}

describe("webview resync 节流补发", () => {
  beforeEach(async () => {
    // 每个用例拿到全新的 store 模块：重置模块级 lastResyncAt / resyncTimer。
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(START);
    postMessage.mockClear();
    ({ useChat } = await import("../webview/src/store"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("首次失配立即 ready；1s 内第二次失配在窗口边界补发", () => {
    useChat.getState().applyHostMessage(unanchorablePatch());
    expect(readyCount()).toBe(1); // leading edge 保持不变

    vi.advanceTimersByTime(200);
    useChat.getState().applyHostMessage(unanchorablePatch());
    expect(readyCount()).toBe(1); // 窗口内，不立即发

    vi.advanceTimersByTime(799);
    expect(readyCount()).toBe(1); // 仍未到窗口边界
    vi.advanceTimersByTime(1);
    expect(readyCount()).toBe(2); // trailing 补发
  });

  it("窗口内多次失配只补发一次，不产生风暴", () => {
    useChat.getState().applyHostMessage(unanchorablePatch());
    expect(readyCount()).toBe(1);

    for (const step of [100, 200, 300]) {
      vi.advanceTimersByTime(step);
      useChat.getState().applyHostMessage(unanchorablePatch());
    }
    expect(readyCount()).toBe(1); // 三次窗口内请求仍只有首次的 ready

    vi.advanceTimersByTime(1_000);
    expect(readyCount()).toBe(2); // 突发合并为一次 trailing
  });

  it("静默超过窗口后，下一次失配重新立即 ready", () => {
    useChat.getState().applyHostMessage(unanchorablePatch());
    expect(readyCount()).toBe(1);

    vi.advanceTimersByTime(1_500);
    useChat.getState().applyHostMessage(unanchorablePatch());
    expect(readyCount()).toBe(2); // 新窗口的 leading edge
  });
});
