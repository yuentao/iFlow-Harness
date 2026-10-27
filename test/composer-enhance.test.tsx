// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../webview/src/components/Composer";
import type { SessionState } from "../shared/messages";

const mocked = vi.hoisted(() => ({
  send: vi.fn(),
  notify: vi.fn(),
  state: undefined as SessionState | undefined,
}));
const useChat = vi.hoisted(() =>
  Object.assign(
    <T,>(
      selector: (s: {
        state: SessionState | undefined;
        pending: null;
        send: typeof mocked.send;
        beginPending: ReturnType<typeof vi.fn>;
        notify: typeof mocked.notify;
      }) => T,
    ) => selector({ state: mocked.state, pending: null, send: mocked.send, beginPending: vi.fn(), notify: mocked.notify }),
    { getState: () => ({ state: mocked.state, send: mocked.send, notify: mocked.notify }) },
  ),
);

vi.mock("../webview/src/store", () => ({ useChat }));
vi.mock("../webview/src/i18n", () => ({ t: (s: string) => s, modeDisplay: () => ({ label: "mode", desc: "" }) }));
vi.mock("../webview/src/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../webview/src/components/ui")>();
  return {
    ...actual,
    Dropdown: ({ trigger, children }: { trigger: (open: boolean) => ReactNode; children: ReactNode }) => <>{trigger(false)}{children}</>,
    fuzzyScore: () => 0,
  };
});

let root: Root;
let container: HTMLDivElement;

function makeState(activeSessionId: string): SessionState {
  return {
    blocks: [],
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
    auth: {
      authenticated: true,
      needsSetup: false,
      saved: null,
      profiles: [],
      importable: [],
      onboardingDismissed: false,
    },
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

/** The wand (prompt-enhance) button — only rendered while a draft exists. */
function wandButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[aria-label="增强提示词"]');
}

/** Reply to the in-flight enhancement, exactly like the host does. */
function replyEnhanced(requestId: number, text: string): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: "enhancedPrompt", requestId, text } }));
  });
}

beforeEach(() => {
  mocked.state = makeState("s1");
  mocked.send.mockReset();
  mocked.notify.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Composer enhance state", () => {
  it("keeps the wand in the enhanced state until the draft is sent", () => {
    const textarea = render();
    change(textarea, "帮我写个周报");
    const wand = wandButton()!;
    expect(wand).toBeTruthy();
    act(() => wand.click());

    const enhanceMsg = mocked.send.mock.calls.find(([m]) => m.type === "enhancePrompt");
    expect(enhanceMsg).toBeTruthy();
    const requestId = enhanceMsg![0].requestId as number;

    replyEnhanced(requestId, "帮我写个周报\n\n（目标：明确预期产出；验收：给出可验证标准。）");
    expect(textarea.value).toContain("验收：给出可验证标准。");
    // Enhanced state: the wand offers to restore the pre-enhancement draft.
    expect(wandButton()!.getAttribute("title")).toBe("还原原始输入");

    // Sending the prompt retires the draft — the enhanced marker must not
    // survive it (the wand would keep its enhanced tint and clicking it
    // would restore a stale prompt into the empty composer).
    key(textarea, "Enter");
    expect(textarea.value).toBe("");
    expect(wandButton()).toBeNull();
  });

  it("does not restore the old draft when the wand is used after sending", () => {
    const textarea = render();
    change(textarea, "帮我写个周报");
    act(() => wandButton()!.click());
    const requestId = mocked.send.mock.calls.find(([m]) => m.type === "enhancePrompt")![0].requestId as number;
    replyEnhanced(requestId, "帮我写个周报（增强版）");
    expect(textarea.value).toBe("帮我写个周报（增强版）");

    key(textarea, "Enter");
    expect(textarea.value).toBe("");

    // A fresh draft must not resurrect the sent one.
    change(textarea, "新的问题");
    const wand = wandButton()!;
    expect(wand.getAttribute("title")).toBe("增强提示词（AI 改写为更清晰的请求）");
    act(() => wand.click());
    expect(textarea.value).toBe("新的问题");
    expect(mocked.send.mock.calls.filter(([m]) => m.type === "enhancePrompt")).toHaveLength(2);
  });
});
