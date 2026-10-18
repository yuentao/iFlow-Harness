// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsModal } from "../webview/src/components/SettingsModal";
import type { AuthUiState } from "../shared/messages";

const send = vi.hoisted(() => vi.fn());
const updateHostSetting = vi.hoisted(() => vi.fn());
const hostSettings = vi.hoisted(() => ({
  nextStepSuggestions: true,
  autoCompressOnIdle: false,
  autoMemoryCapture: false,
  uiFontSize: "standard" as const,
  uiDensity: "standard" as const,
}));

vi.mock("../webview/src/store", () => ({
  useChat: (selector: (state: { send: typeof send; updateHostSetting: typeof updateHostSetting; hostSettings: typeof hostSettings }) => unknown) =>
    selector({ send, updateHostSetting, hostSettings }),
}));
vi.mock("../webview/src/i18n", () => ({
  t: (s: string, ...args: string[]) => s.replace(/\{(\d+)\}/g, (_, i) => args[Number(i)] ?? ""),
}));

let root: Root;
let container: HTMLDivElement;

function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === text);
  expect(button).toBeTruthy();
  act(() => button!.click());
}

beforeEach(() => {
  send.mockReset();
  updateHostSetting.mockReset();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <SettingsModal
        tab="general"
        onTabChange={() => {}}
        onDismiss={() => {}}
        dismissible
        busy={false}
        auth={{ authenticated: true, needsSetup: false, saved: null, profiles: [] } as AuthUiState}
        dark
        onThemeChange={() => {}}
      />,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("renders the font-size and density presets in General settings", () => {
  expect(container.textContent).toContain("字号");
  expect(container.textContent).toContain("密度");
  expect(container.textContent).toContain("调整面板中文字的大小");
});

it("sends the selected size/density to the host", () => {
  click("大");
  expect(updateHostSetting).toHaveBeenCalledWith({ uiFontSize: "large" });
  click("宽松");
  expect(updateHostSetting).toHaveBeenCalledWith({ uiDensity: "comfortable" });
});
