// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsModal, type SettingsTab } from "../webview/src/components/SettingsModal";
import type { AuthUiState, HostSettingsUi } from "../shared/messages";

const send = vi.hoisted(() => vi.fn());
const updateHostSetting = vi.hoisted(() => vi.fn());
const beginPending = vi.hoisted(() => vi.fn());
const hostSettings = vi.hoisted(() => ({
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
} as HostSettingsUi));
const chat = vi.hoisted(() => ({
  pending: null as { kind: string; target: string } | null,
  state: null as { pendingProfileSwitch: { id: string; profileName: string } | null } | null,
}));

vi.mock("../webview/src/store", () => ({
  useChat: Object.assign(
    (selector: (state: {
      send: typeof send;
      updateHostSetting: typeof updateHostSetting;
      hostSettings: typeof hostSettings;
      pending: typeof chat.pending;
      state: typeof chat.state;
    }) => unknown) =>
      selector({ send, updateHostSetting, hostSettings, ...chat }),
    { getState: () => ({ beginPending }) },
  ),
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
  beginPending.mockReset();
  chat.pending = null;
  chat.state = null;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <SettingsModal
        tab="appearance"
        onTabChange={() => {}}
        onDismiss={() => {}}
        dismissible
        busy={false}
        auth={{
          authenticated: true,
          needsSetup: false,
          saved: null,
          profiles: [],
          importable: [],
          onboardingDismissed: false,
        } as AuthUiState}
      />,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("renders the font-size and density presets in Appearance settings", () => {
  expect(container.textContent).toContain("字号");
  expect(container.textContent).toContain("密度");
  expect(container.textContent).toContain("调整面板整体字号");
});


it("exposes the redesigned top-level categories", () => {
  expect(container.textContent).toContain("账户与模型");
  expect(container.textContent).toContain("对话");
  expect(container.textContent).toContain("外观与交互");
  expect(container.textContent).toContain("权限与审批");
  expect(container.textContent).toContain("MCP 与工具");
  expect(container.textContent).toContain("记忆与知识");
  expect(container.textContent).toContain("运行与数据");
});

it("persists the theme choice through host settings", () => {
  click("深色");
  expect(updateHostSetting).toHaveBeenCalledWith({ theme: "dark" });
});

function renderTab(tab: SettingsTab, auth: AuthUiState) {
  act(() => root.render(
    <SettingsModal
      tab={tab}
      onTabChange={() => {}}
      onDismiss={() => {}}
      dismissible
      busy={false}
      auth={auth}
    />,
  ));
}

const BASIC_AUTH: AuthUiState = {
  authenticated: true,
  needsSetup: false,
  saved: null,
  profiles: [],
  importable: [],
  onboardingDismissed: false,
};

it("toggles auto-title in the Conversation tab", () => {
  renderTab("chat", BASIC_AUTH);
  expect(container.textContent).toContain("回合结束后");
  const toggle = container.querySelector<HTMLButtonElement>('[aria-label="自动生成标题"]');
  expect(toggle).toBeTruthy();
  act(() => toggle!.click());
  expect(updateHostSetting).toHaveBeenCalledWith({ autoTitle: false });
});

it("renders runtime groups and commits the Node path on blur", () => {
  renderTab("runtime", BASIC_AUTH);
  expect(container.textContent).toContain("检查点与存储");
  expect(container.textContent).toContain("Node.js 路径");
  const input = [...container.querySelectorAll<HTMLInputElement>("input")].find((el) =>
    el.placeholder.includes("node.exe"),
  );
  expect(input).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, "C:/node/node.exe");
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => {
    input!.focus();
    input!.blur();
  });
  expect(updateHostSetting).toHaveBeenCalledWith({ nodePath: "C:/node/node.exe" });
});

it("sends the selected size/density to the host", () => {
  click("大");
  expect(updateHostSetting).toHaveBeenCalledWith({ uiFontSize: "large" });
  click("宽松");
  expect(updateHostSetting).toHaveBeenCalledWith({ uiDensity: "comfortable" });
});

const API_AUTH: AuthUiState = {
  authenticated: true,
  needsSetup: false,
  saved: null,
  profiles: [{
    name: "B", source: "extension", baseUrl: "https://gw.example.com/v1",
    modelName: "model-b", keyTail: "1234", active: false,
  }],
  importable: [],
  onboardingDismissed: false,
};

function renderApiTab() {
  act(() => root.render(
    <SettingsModal
      tab="api"
      onTabChange={() => {}}
      onDismiss={() => {}}
      dismissible
      busy={false}
      auth={API_AUTH}
    />,
  ));
}

it("shows model metadata groups in the account tab", () => {
  renderApiTab();
  expect(container.textContent).toContain("模型元数据");
  expect(container.textContent).toContain("上下文窗口覆写");
  expect(container.textContent).toContain("思考模型规则");
});

it("shows a waiting label until the profile-switch choice is answered", () => {
  chat.pending = { kind: "profile", target: "B" };
  chat.state = { pendingProfileSwitch: { id: "pswitch-1", profileName: "B" } };
  renderApiTab();
  expect(container.textContent).toContain("等待选择…");
  expect(container.textContent).not.toContain("正在重新认证…");

  chat.state = { pendingProfileSwitch: null };
  renderApiTab();
  expect(container.textContent).toContain("正在重新认证…");
  expect(container.textContent).not.toContain("等待选择…");
});

const EMPTY_AUTH: AuthUiState = {
  authenticated: false,
  needsSetup: true,
  saved: null,
  profiles: [],
  importable: [],
  onboardingDismissed: false,
};

function renderAuthTabWith(auth: AuthUiState) {
  act(() => root.render(
    <SettingsModal
      tab="api"
      onTabChange={() => {}}
      onDismiss={() => {}}
      dismissible={false}
      busy={false}
      auth={auth}
    />,
  ));
}

function inputs(): HTMLInputElement[] {
  return [...container.querySelectorAll("input")] as HTMLInputElement[];
}

it("starts a new profile from a provider preset", () => {
  renderAuthTabWith(EMPTY_AUTH);
  expect(container.textContent).toContain("选择服务商预设");
  click("DeepSeek");
  const fields = inputs();
  expect(fields[1]?.value).toBe("https://api.deepseek.com");
  expect(fields[3]?.value).toBe("deepseek-chat");
  expect(container.textContent).toContain("获取 API Key");
});

it("opens the provider key page from the preset guidance", () => {
  renderAuthTabWith(EMPTY_AUTH);
  click("DeepSeek");
  click("获取 API Key");
  expect(send).toHaveBeenCalledWith({
    type: "openExternal",
    uri: "https://platform.deepseek.com/api_keys",
  });
});

it("fills the model field from a suggested model chip", () => {
  renderAuthTabWith(EMPTY_AUTH);
  click("DeepSeek");
  click("deepseek-reasoner");
  expect(inputs()[3]?.value).toBe("deepseek-reasoner");
});

it("does not carry the previous gateway's model into a preset without suggestions", () => {
  renderAuthTabWith({
    authenticated: true,
    needsSetup: false,
    saved: { baseUrl: "https://old.example.com/v1", modelName: "old-model", keyTail: "…1111" },
    profiles: [],
    importable: [],
    onboardingDismissed: false,
  });
  click("智谱 GLM");
  const fields = inputs();
  expect(fields[1]?.value).toBe("https://open.bigmodel.cn/api/paas/v4");
  expect(fields[3]?.value).toBe("");
});

it("hides the CLI import card once extension credentials exist", () => {
  renderAuthTabWith({
    authenticated: true,
    needsSetup: false,
    saved: { baseUrl: "https://old.example.com/v1", modelName: "old-model", keyTail: "…1111" },
    profiles: [],
    importable: [
      { name: "终端默认", baseUrl: "https://cli.example.com/v1", modelName: "cli-model", keyTail: "…abcd" },
    ],
    onboardingDismissed: false,
  });
  expect(container.textContent).not.toContain("检测到 iFlow CLI 已有凭据");
});

it("opens provider documentation from the preset guidance", () => {
  renderAuthTabWith(EMPTY_AUTH);
  click("DeepSeek");
  click("查看文档");
  expect(send).toHaveBeenCalledWith({
    type: "openExternal",
    uri: "https://api-docs.deepseek.com/",
  });
});

it("drops the preset guidance when the user switches to a custom endpoint", () => {
  renderAuthTabWith(EMPTY_AUTH);
  click("DeepSeek");
  expect(container.textContent).toContain("获取 API Key");
  click("自定义");
  expect(container.textContent).not.toContain("获取 API Key");
});

it("sends an import command for detected CLI credentials", () => {
  renderAuthTabWith({
    authenticated: false,
    needsSetup: true,
    saved: null,
    profiles: [],
    importable: [
      {
        name: "终端默认",
        baseUrl: "https://cli.example.com/v1",
        modelName: "cli-model",
        keyTail: "…abcd",
      },
    ],
    onboardingDismissed: false,
  });
  expect(container.textContent).toContain("检测到 iFlow CLI 已有凭据");
  click("导入并激活");
  expect(beginPending).toHaveBeenCalledWith("profile", "终端默认");
  expect(send).toHaveBeenCalledWith({ type: "importCliCredentials", name: "终端默认" });
});
