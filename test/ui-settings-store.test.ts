// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

/**
 * Store-level coverage for the appearance presets: the SettingsModal test
 * mocks the whole store, so it can only prove the UI hands the value over.
 * This file exercises the real store (CSS variable application + the
 * `setHostSettings` wire send).
 */
const postMessage = vi.fn();
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({ postMessage });

const { useChat } = await import("../webview/src/store");

const baseSettings = {
  nextStepSuggestions: true,
  autoCompressOnIdle: false,
  autoMemoryCapture: false,
  uiFontSize: "standard" as const,
  uiDensity: "standard" as const,
  soundFeedback: true,
  defaultMode: "smart" as const,
};

beforeEach(() => {
  postMessage.mockClear();
  document.documentElement.style.removeProperty("--ui-font-scale");
  document.documentElement.style.removeProperty("--ui-density");
});

it("applies hostSettings presets to the CSS scale variables", () => {
  useChat.getState().applyHostMessage({
    type: "hostSettings",
    ...baseSettings,
    uiFontSize: "large",
    uiDensity: "comfortable",
  });

  const style = document.documentElement.style;
  expect(style.getPropertyValue("--ui-font-scale")).toBe("1.2");
  expect(style.getPropertyValue("--ui-density")).toBe("1.08");
  expect(useChat.getState().hostSettings.uiFontSize).toBe("large");
  expect(useChat.getState().hostSettings.uiDensity).toBe("comfortable");
});

it("sends preset changes to the host and applies them optimistically", () => {
  useChat.getState().updateHostSetting({ uiFontSize: "compact", uiDensity: "compact" });

  const style = document.documentElement.style;
  expect(style.getPropertyValue("--ui-font-scale")).toBe("1");
  expect(style.getPropertyValue("--ui-density")).toBe("0.94");
  expect(useChat.getState().hostSettings.uiFontSize).toBe("compact");

  const sent = postMessage.mock.calls
    .map((call) => call[0] as { type?: string; uiFontSize?: string; uiDensity?: string })
    .find((msg) => msg.type === "setHostSettings");
  expect(sent).toMatchObject({ type: "setHostSettings", uiFontSize: "compact", uiDensity: "compact" });
});

it("sends sound and default-mode changes to the host", () => {
  useChat.getState().updateHostSetting({ soundFeedback: false, defaultMode: "plan" });

  expect(useChat.getState().hostSettings.soundFeedback).toBe(false);
  expect(useChat.getState().hostSettings.defaultMode).toBe("plan");
  const sent = postMessage.mock.calls
    .map((call) => call[0] as { type?: string; soundFeedback?: boolean; defaultMode?: string })
    .find((msg) => msg.type === "setHostSettings");
  expect(sent).toMatchObject({ type: "setHostSettings", soundFeedback: false, defaultMode: "plan" });
});
