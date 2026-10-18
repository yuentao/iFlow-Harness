// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OnboardingWizard } from "../webview/src/components/OnboardingWizard";
import type { AuthUiState } from "../shared/messages";

const send = vi.hoisted(() => vi.fn());
const updateHostSetting = vi.hoisted(() => vi.fn());
const beginPending = vi.hoisted(() => vi.fn());
const onClose = vi.hoisted(() => vi.fn());
const onOpenSettings = vi.hoisted(() => vi.fn());
const onThemeChange = vi.hoisted(() => vi.fn());

const chat = vi.hoisted(() => ({
  hostSettings: {
    nextStepSuggestions: true,
    autoCompressOnIdle: false,
    autoMemoryCapture: true,
    uiFontSize: "standard" as const,
    uiDensity: "standard" as const,
    soundFeedback: true,
    defaultMode: "smart" as const,
  },
  state: {
    status: "error" as string | null,
    errorMessage: null as string | null,
    initializing: false,
    sessionId: null as string | null,
    modes: null as { currentModeId: string; availableModes: Array<{ id: string; name: string }> } | null,
    models: [] as Array<{ id: string; name: string }>,
    currentModelId: null as string | null,
  },
}));

vi.mock("../webview/src/store", () => ({
  useChat: Object.assign(
    (selector: (state: {
      send: typeof send;
      updateHostSetting: typeof updateHostSetting;
      hostSettings: typeof chat.hostSettings;
      state: typeof chat.state;
    }) => unknown) =>
      selector({
        send,
        updateHostSetting,
        hostSettings: chat.hostSettings,
        state: chat.state,
      }),
    { getState: () => ({ beginPending }) },
  ),
}));
vi.mock("../webview/src/i18n", () => ({
  t: (s: string, ...args: string[]) => s.replace(/\{(\d+)\}/g, (_, i) => args[Number(i)] ?? ""),
  modeDisplay: (mode: { id: string }) => ({ label: mode.id, desc: "" }),
}));

const AUTH: AuthUiState = {
  authenticated: false,
  needsSetup: true,
  saved: null,
  profiles: [],
  importable: [],
  onboardingDismissed: false,
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  send.mockReset();
  updateHostSetting.mockReset();
  beginPending.mockReset();
  onClose.mockReset();
  onOpenSettings.mockReset();
  onThemeChange.mockReset();
  chat.state.status = "error";
  chat.state.errorMessage = null;
  chat.state.initializing = false;
  chat.state.sessionId = null;
  chat.state.modes = null;
  chat.state.models = [];
  chat.state.currentModelId = null;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderWizard(auth: AuthUiState = AUTH) {
  act(() =>
    root.render(
      <OnboardingWizard
        auth={auth}
        dark
        onThemeChange={onThemeChange}
        onClose={onClose}
        onOpenSettings={onOpenSettings}
      />,
    ),
  );
}

function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === text);
  expect(button, `button ${text}`).toBeTruthy();
  act(() => button!.click());
}

function clickContaining(text: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  expect(button, `button containing ${text}`).toBeTruthy();
  act(() => button!.click());
}

function inputAt(index: number): HTMLInputElement {
  const input = container.querySelectorAll("input")[index];
  expect(input).toBeTruthy();
  return input as HTMLInputElement;
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("walks the user from the welcome screen into the API form", () => {
  renderWizard();
  expect(container.textContent).toContain("欢迎使用 心流·驭光");
  expect(container.textContent).toContain("第 1 / 6 步");

  click("开始配置");
  expect(container.textContent).toContain("第 2 / 6 步");
  expect(container.textContent).toContain("DeepSeek");
  expect(container.textContent).toContain("Base URL（OpenAI 兼容）");
});

it("prefills a preset and saves the credentials", () => {
  renderWizard();
  click("开始配置");
  click("DeepSeek");

  expect(inputAt(0).value).toBe("https://api.deepseek.com");
  expect(inputAt(2).value).toBe("deepseek-chat");
  setInput(inputAt(1), "sk-test");

  click("保存并继续");
  expect(send).toHaveBeenCalledWith({
    type: "saveAuth",
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-test",
    modelName: "deepseek-chat",
    profileName: null,
  });
  expect(container.textContent).toContain("选择默认使用的模型");
});

it("validates the API form before saving", () => {
  renderWizard();
  click("开始配置");
  click("DeepSeek");
  click("保存并继续");

  expect(container.textContent).toContain("API Key 不能为空");
  expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "saveAuth" }));
});

it("imports a detected CLI credential and advances", () => {
  renderWizard({
    ...AUTH,
    importable: [
      {
        name: "终端默认",
        baseUrl: "https://cli.example.com/v1",
        modelName: "cli-model",
        keyTail: "…abcd",
      },
    ],
  });
  click("开始配置");
  expect(container.textContent).toContain("检测到 iFlow CLI 已有凭据");
  click("导入并激活");
  expect(beginPending).toHaveBeenCalledWith("profile", "终端默认");
  expect(send).toHaveBeenCalledWith({ type: "importCliCredentials", name: "终端默认" });
});

it("lets the user skip the whole wizard", () => {
  renderWizard();
  click("跳过引导");
  expect(send).toHaveBeenCalledWith({ type: "setOnboardingDismissed", dismissed: true });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("selects a model from the live list", () => {
  chat.state.models = [
    { id: "m1", name: "Model One" },
    { id: "m2", name: "Model Two" },
  ];
  chat.state.currentModelId = "m1";
  renderWizard();
  click("开始配置");
  click("稍后配置");

  expect(container.textContent).toContain("当前模型：m1");
  clickContaining("Model Two");
  expect(beginPending).toHaveBeenCalledWith("model", "m2");
  expect(send).toHaveBeenCalledWith({ type: "setModel", modelId: "m2" });
});

it("persists the default approval mode and switches the live session", () => {
  chat.state.sessionId = "session-1";
  chat.state.modes = {
    currentModeId: "smart",
    availableModes: [
      { id: "smart", name: "" },
      { id: "yolo", name: "" },
    ],
  };
  renderWizard();
  click("开始配置");
  click("稍后配置");
  click("下一步");

  expect(container.textContent).toContain("选择新会话默认的权限模式");
  click("yolo");
  expect(updateHostSetting).toHaveBeenCalledWith({ defaultMode: "yolo" });
  expect(beginPending).toHaveBeenCalledWith("mode", "yolo");
  expect(send).toHaveBeenCalledWith({ type: "setMode", modeId: "yolo" });
});

it("updates preferences and theme", () => {
  renderWizard();
  click("开始配置");
  click("稍后配置");
  click("下一步");
  click("下一步");

  expect(container.textContent).toContain("第 5 / 6 步");
  const sound = container.querySelector<HTMLButtonElement>('button[aria-label="提示音"]');
  expect(sound).toBeTruthy();
  act(() => sound!.click());
  expect(updateHostSetting).toHaveBeenCalledWith({ soundFeedback: false });

  click("大");
  expect(updateHostSetting).toHaveBeenCalledWith({ uiFontSize: "large" });

  click("浅色");
  expect(onThemeChange).toHaveBeenCalledWith("light");
});

it("shows the host error even when the model list is not empty", () => {
  renderWizard();
  click("开始配置");
  click("DeepSeek");
  setInput(inputAt(1), "sk-test");
  // A reconnect failure leaves the previous model list in place.
  chat.state.models = [{ id: "deepseek-chat", name: "DeepSeek Chat" }];
  chat.state.errorMessage = "invalid api key";
  click("保存并继续");

  expect(container.textContent).toContain("invalid api key");
});

it("finishes onboarding and can jump straight to advanced settings", () => {
  renderWizard();
  click("开始配置");
  click("稍后配置");
  click("下一步");
  click("下一步");
  click("下一步");

  expect(container.textContent).toContain("配置完成");
  expect(container.textContent).toContain("已开启");
  expect(container.textContent).not.toContain("standard / standard");
  click("开始使用");
  expect(send).toHaveBeenCalledWith({ type: "setOnboardingDismissed", dismissed: true });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onOpenSettings).not.toHaveBeenCalled();
});

it("opens the requested advanced settings after finishing", () => {
  renderWizard();
  click("开始配置");
  click("稍后配置");
  click("下一步");
  click("下一步");
  click("下一步");
  click("MCP 服务器");

  expect(send).toHaveBeenCalledWith({ type: "setOnboardingDismissed", dismissed: true });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onOpenSettings).toHaveBeenCalledWith("mcp");
});
