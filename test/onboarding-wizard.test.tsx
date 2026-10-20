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
    root.render(<OnboardingWizard auth={auth} onClose={onClose} onOpenSettings={onOpenSettings} />),
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

/** Fill the connect step with the DeepSeek preset and move to the model step. */
function connectWithPreset() {
  click("DeepSeek");
  setInput(inputAt(1), "sk-test");
  click("保存并继续");
}

it("opens directly on the connect step without a separate welcome screen", () => {
  renderWizard();
  expect(container.textContent).toContain("第 1 / 4 步");
  expect(container.textContent).toContain("连接 iFlow");
  expect(container.textContent).toContain("欢迎使用 心流·驭光");
  expect(container.textContent).toContain("Base URL（OpenAI 兼容）");
  expect(container.textContent).not.toContain("开始配置");
});

it("focuses the first empty input instead of the primary button", () => {
  renderWizard();
  expect(document.activeElement).toBe(inputAt(0));
  expect(inputAt(0).value).toBe("");
});

it("prefills a preset and saves the credentials", () => {
  renderWizard();
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
  expect(container.textContent).toContain("第 2 / 4 步");
});

it("validates the API form before saving", () => {
  renderWizard();
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
  expect(container.textContent).toContain("检测到 iFlow CLI 已有凭据");
  click("导入并激活");
  expect(beginPending).toHaveBeenCalledWith("profile", "终端默认");
  expect(send).toHaveBeenCalledWith({ type: "importCliCredentials", name: "终端默认" });
});

it("offers a single escape door instead of skip plus later", () => {
  renderWizard();
  expect(container.textContent).not.toContain("跳过引导");
  expect(container.textContent).not.toContain("稍后配置");
  click("稍后设置");
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
  connectWithPreset();

  expect(container.textContent).toContain("当前模型：m1");
  clickContaining("Model Two");
  expect(beginPending).toHaveBeenCalledWith("model", "m2");
  expect(send).toHaveBeenCalledWith({ type: "setModel", modelId: "m2" });
});

it("shows the model search only for long catalogs", () => {
  chat.state.models = [
    { id: "m1", name: "Model One" },
    { id: "m2", name: "Model Two" },
  ];
  renderWizard();
  connectWithPreset();
  expect(container.querySelector('input[placeholder="搜索模型…"]')).toBeNull();

  act(() => root.unmount());
  container.innerHTML = "";
  root = createRoot(container);
  chat.state.models = Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, name: `Model ${i}` }));
  renderWizard();
  connectWithPreset();

  const search = container.querySelector<HTMLInputElement>('input[placeholder="搜索模型…"]');
  expect(search).toBeTruthy();
  setInput(search!, "Model 8");
  expect(container.textContent).toContain("Model 8");
  expect(container.textContent).not.toContain("Model 1");
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
  connectWithPreset();
  click("下一步");

  expect(container.textContent).toContain("选择新会话默认的权限模式");
  expect(container.textContent).toContain("第 3 / 4 步");
  click("yolo");
  expect(updateHostSetting).toHaveBeenCalledWith({ defaultMode: "yolo" });
  expect(beginPending).toHaveBeenCalledWith("mode", "yolo");
  expect(send).toHaveBeenCalledWith({ type: "setMode", modeId: "yolo" });
});

it("shows the host error even when the model list is not empty", () => {
  renderWizard();
  click("DeepSeek");
  setInput(inputAt(1), "sk-test");
  // A reconnect failure leaves the previous model list in place.
  chat.state.models = [{ id: "deepseek-chat", name: "DeepSeek Chat" }];
  chat.state.errorMessage = "invalid api key";
  click("保存并继续");

  expect(container.textContent).toContain("invalid api key");
});

it("finishes onboarding without the old preferences summary", () => {
  renderWizard();
  connectWithPreset();
  click("下一步");
  click("下一步");

  expect(container.textContent).toContain("第 4 / 4 步");
  expect(container.textContent).toContain("配置完成");
  expect(container.textContent).not.toContain("standard / standard");
  expect(container.textContent).not.toContain("提示音");
  click("开始使用");
  expect(send).toHaveBeenCalledWith({ type: "setOnboardingDismissed", dismissed: true });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onOpenSettings).not.toHaveBeenCalled();
});

it("links the moved preferences from the done step", () => {
  renderWizard();
  connectWithPreset();
  click("下一步");
  click("下一步");
  click("外观与交互");

  expect(send).toHaveBeenCalledWith({ type: "setOnboardingDismissed", dismissed: true });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onOpenSettings).toHaveBeenCalledWith("appearance");
});

it("opens the requested advanced settings after finishing", () => {
  renderWizard();
  connectWithPreset();
  click("下一步");
  click("下一步");
  click("MCP 服务器");

  expect(send).toHaveBeenCalledWith({ type: "setOnboardingDismissed", dismissed: true });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onOpenSettings).toHaveBeenCalledWith("mcp");
});