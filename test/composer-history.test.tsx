// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../webview/src/components/Composer";
import type { SessionState } from "../shared/messages";

const mocked = vi.hoisted(() => ({ send: vi.fn(), state: undefined as SessionState | undefined }));
const useChat = vi.hoisted(() =>
  Object.assign(
    <T,>(selector: (s: { state: SessionState | undefined; pending: null; send: typeof mocked.send; beginPending: ReturnType<typeof vi.fn> }) => T) =>
      selector({ state: mocked.state, pending: null, send: mocked.send, beginPending: vi.fn() }),
    { getState: () => ({ state: mocked.state, send: mocked.send }) },
  ),
);
let state: SessionState;


vi.mock("../webview/src/store", () => ({ useChat }));
vi.mock("../webview/src/i18n", () => ({ t: (s: string) => s, modeDisplay: () => ({ label: "mode", desc: "" }) }));
vi.mock("../webview/src/components/ui", () => ({
  Dropdown: ({ trigger, children }: { trigger: (open: boolean) => ReactNode; children: ReactNode }) => <>{trigger(false)}{children}</>,
  fuzzyScore: () => 0,
}));

let root: Root;
let container: HTMLDivElement;

function makeState(activeSessionId: string, prompts: string[]): SessionState {
  return {
    blocks: prompts.map((text, i) => ({ kind: "user", id: `u${i}`, text })),
    status: "idle",
    errorMessage: null,
    stopReason: null,
    sessionId: activeSessionId,
    activeSessionId,
    modes: null,
    commands: [],
    models: [],
    currentModelId: null,
    pendingApproval: null,
    pendingPlanExit: null,
    pendingQuestions: null,
    auth: { authenticated: true, needsSetup: false, saved: null, profiles: [] },
    sessions: [],
    replaying: false,
    initializing: false,
  } as SessionState;
}

function render(): HTMLTextAreaElement {
  act(() => root.render(<Composer />));
  return container.querySelector("textarea")!;
}

function change(textarea: HTMLTextAreaElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function key(textarea: HTMLTextAreaElement, keyName: string, init: KeyboardEventInit = {}): void {
  act(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: keyName, ...init })));
}

beforeEach(() => {
  state = makeState("s1", ["oldest", "newest"]);
  mocked.state = state;
  mocked.send.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Composer keyboard interactions", () => {
  it("does not send or navigate while an IME composition is active", () => {
    const textarea = render();
    change(textarea, "拼");
    key(textarea, "Enter", { isComposing: true });
    key(textarea, "ArrowUp", { isComposing: true });
    expect(mocked.send).not.toHaveBeenCalled();
    expect(textarea.value).toBe("拼");
  });

  it("keeps Shift+Arrow and selected text as textarea editing", () => {
    const textarea = render();
    change(textarea, "draft");
    textarea.setSelectionRange(0, 0);
    key(textarea, "ArrowUp", { shiftKey: true });
    expect(textarea.value).toBe("draft");
    change(textarea, "draft");
    textarea.setSelectionRange(0, 2);
    key(textarea, "ArrowDown");
    expect(textarea.value).toBe("draft");
  });

  it("leaves history browsing when the recalled prompt is edited", () => {
    const textarea = render();
    key(textarea, "ArrowUp");
    expect(textarea.value).toBe("newest");
    change(textarea, "newest edited");
    expect(textarea.value).toBe("newest edited");
    key(textarea, "ArrowUp");
    expect(textarea.value).toBe("newest edited");
  });

  it("resets the history draft when the active session changes", () => {
    const textarea = render();
    change(textarea, "session one draft");
    key(textarea, "ArrowUp");
    expect(textarea.value).toBe("newest");
    state = makeState("s2", ["other session"]);
    mocked.state = state;
    act(() => root.render(<Composer />));
    const next = container.querySelector("textarea")!;
    key(next, "ArrowDown");
    expect(next.value).toBe("newest");
  });

  it("keeps the @ popup in charge even when there are no matching files", () => {
    const textarea = render();
    change(textarea, "@missing");
    expect(container.textContent).toContain("无匹配文件");
    key(textarea, "ArrowUp");
    expect(textarea.value).toBe("@missing");
  });
});