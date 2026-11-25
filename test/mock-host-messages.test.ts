// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type WireMessage = { type?: string; message?: string };

/**
 * Dev/browser preview drives createMockHost instead of the real VSCode host:
 * `vscode` is chosen at module load from the absence of `acquireVsCodeApi`.
 * These tests deliberately leave that global unset so the three newly added
 * handlers are exercised, and assert they no longer fall through to the
 * default `console.warn` tripwire.
 */
describe("createMockHost postMessage handlers (dev preview)", () => {
  beforeEach(() => {
    delete (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
    // Give every case a fresh module instance (fresh mock host + debounce state).
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  it("regenerate replies with a toast instead of the unhandled-message warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: WireMessage[] = [];
    const onMessage = (event: MessageEvent) => { seen.push(event.data as WireMessage); };
    window.addEventListener("message", onMessage);

    const { useChat } = await import("../webview/src/store");
    useChat.getState().send({ type: "regenerate" });
    await wait(150);

    expect(warn).not.toHaveBeenCalled();
    expect(seen.some((m) => m.type === "toast" && m.message?.includes("重新生成"))).toBe(true);
    window.removeEventListener("message", onMessage);
  });

  it("editAndResend replies with a toast instead of the unhandled-message warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: WireMessage[] = [];
    const onMessage = (event: MessageEvent) => { seen.push(event.data as WireMessage); };
    window.addEventListener("message", onMessage);

    const { useChat } = await import("../webview/src/store");
    useChat.getState().send({ type: "editAndResend", blockId: "block-1", text: "hello" });
    await wait(150);

    expect(warn).not.toHaveBeenCalled();
    expect(seen.some((m) => m.type === "toast" && m.message?.includes("编辑并重新发送"))).toBe(true);
    window.removeEventListener("message", onMessage);
  });

  it("openLocation is consumed with a log instead of the unhandled-message warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    const { useChat } = await import("../webview/src/store");
    useChat.getState().send({ type: "openLocation", path: "src/App.tsx", line: 12 });
    await wait(30);

    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("src/App.tsx"));
  });
});
