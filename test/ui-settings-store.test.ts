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

import type { HostSettingsUi } from "../shared/messages";
const { useChat } = await import("../webview/src/store");

const baseSettings: HostSettingsUi = {
  nextStepSuggestions: true,
  autoCompressOnIdle: false,
  autoMemoryCapture: false,
  autoTitle: true,
  restoreLastSession: false,
  autoOpenPanel: false,
  warmStart: true,
  soundFeedback: true,
  osNotifications: "approvals",
  language: "",
  defaultMode: "smart",
  approvalMode: "",
  theme: "auto",
  auroraIntensity: 35,
  uiFontSize: "standard",
  uiDensity: "standard",
  nodePath: "",
  checkpoints: true,
  checkpointMaxFiles: 50000,
  checkpointMaxFileMB: 300,
  checkpointDir: "",
  checkpointMaxTurns: 0,
  checkpointMaxSizeMB: 0,
  contextWindowOverrides: [],
  costTable: [],
  thinkingModelRules: [],
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

it("mirrors theme and advanced settings from the host", () => {
  useChat.getState().applyHostMessage({
    type: "hostSettings",
    ...baseSettings,
    theme: "dark",
    nodePath: "/opt/node",
  });
  expect(useChat.getState().hostSettings.theme).toBe("dark");
  expect(useChat.getState().hostSettings.nodePath).toBe("/opt/node");
});

it("sends theme changes to the host", () => {
  useChat.getState().updateHostSetting({ theme: "light" });
  expect(useChat.getState().hostSettings.theme).toBe("light");
  const sent = postMessage.mock.calls
    .map((call) => call[0] as { type?: string; theme?: string })
    .find((msg) => msg.type === "setHostSettings");
  expect(sent).toMatchObject({ type: "setHostSettings", theme: "light" });
});

