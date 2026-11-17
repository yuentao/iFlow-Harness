// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../webview/src/App";
import type { SessionState } from "../shared/messages";

/**
 * Splash screen escape hatch (P0-3 follow-up): the 「重启内核」 button only grows
 * past a 30s patience threshold, and a host restart keeps `status === "connecting"`
 * (the successor handshake owns the same screen). Without `connectEpoch` the
 * elapsed timer keeps counting the SUPERSEDED boot, so the button looks dead —
 * these cases pin both halves: the click really sends restartCli, and the epoch
 * bump re-anchors the timer (seconds gone, patience hint gone) and re-labels the
 * hint as 「正在重新启动内核 …」.
 */

const send = vi.hoisted(() => vi.fn());
const holder = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock("../webview/src/store", () => ({
  // Only App.tsx reads the store in this render (the splash early-return keeps
  // the rest of the tree unmounted), so a selector-applied plain object is enough.
  useChat: (selector: (s: unknown) => unknown) => selector(holder.state),
  send,
  getState: () => holder.state,
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

function connectingState(connectEpoch = 0): SessionState {
  return {
    blocks: [],
    status: "connecting",
    errorMessage: null,
    stopReason: null,
    sessionId: null,
    modes: null,
    commands: [],
    skills: [],
    models: [],
    currentModelId: null,
    thinkLevel: "auto",
    pendingApproval: null,
    pendingQuestions: null,
    pendingProfileSwitch: null,
    auth: {
      authenticated: true,
      needsSetup: false,
      saved: null,
      profiles: [],
      onboardingDismissed: true,
    },
    sessions: [],
    activeSessionId: null,
    replaying: false,
    initializing: false,
    compressing: false,
    connectEpoch,
    superSessions: [],
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  send.mockReset();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  holder.state = {
    state: connectingState(0),
    send,
    toggleFocusMode: () => {},
    focusMode: false,
    headerScrolled: false,
    editorTheme: "light",
    pending: null,
    toasts: [],
    notify: () => {},
    dismissToast: () => {},
    clearMemoryDraft: () => {},
    memoryDraftRequest: null,
    superTranscripts: {},
    hostSettings: {
      theme: "light",
      auroraIntensity: 35,
      uiFontSize: "standard",
      uiDensity: "standard",
    },
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function render() {
  await act(async () => {
    root.render(<App />);
  });
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

it("shows 「重启内核」 only past the patience threshold and sends restartCli", async () => {
  vi.useFakeTimers();
  await render();
  expect(container.textContent).toContain("正在启动 …");
  // Below the threshold there is no escape hatch (the wait is still plausible).
  await advance(29_000);
  expect(container.querySelector(".splash button")).toBeNull();

  await advance(1_500);
  expect(container.textContent).toContain("等待时间偏长");
  const button = container.querySelector(".splash button");
  expect(button?.textContent).toContain("重启内核");

  await act(async () => {
    (button as HTMLButtonElement).click();
  });
  expect(send).toHaveBeenCalledWith({ type: "restartCli" });
});

it("re-anchors the timer on a connectEpoch bump instead of counting the superseded boot", async () => {
  vi.useFakeTimers();
  await render();
  await advance(31_000);
  expect(container.textContent).toContain("31s");
  expect(container.querySelector(".splash button")).not.toBeNull();

  // Host restart: status stays `connecting`, the epoch is what marks a NEW boot.
  holder.state.state = connectingState(1);
  await advance(1_000);

  expect(container.textContent).toContain("正在重新启动内核 …");
  expect(container.textContent).not.toContain("正在启动 …");
  // Timer re-anchored: the stale 31s count and the patience hint are gone, so
  // the restart is visibly reflected (the bar restarts from 0 too).
  expect(container.textContent).not.toContain("31s");
  expect(container.textContent).not.toContain("等待时间偏长");
  expect(container.querySelector(".splash-bar-fill")?.getAttribute("style")).toContain("width: 0%");
});
