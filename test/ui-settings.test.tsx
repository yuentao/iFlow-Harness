// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../webview/src/App";
import { SettingsModal, type SettingsTab } from "../webview/src/components/SettingsModal";
import type { AuthUiState, HostSettingsUi } from "../shared/messages";
import type { SuperSessionUi, SuperStatus } from "../shared/super-agent";

const send = vi.hoisted(() => vi.fn());
const updateHostSetting = vi.hoisted(() => vi.fn());
const beginPending = vi.hoisted(() => vi.fn());
const hostSettings = vi.hoisted(() => ({
  nextStepSuggestions: true,
  autoCompressOnIdle: false,
  autoMemoryCapture: false,
  autoTitle: true,
  superAgentMaxAttempts: 2,
  superAgentDependencyPolicy: "block",
  efficiencyMode: "steady",
  memoryExtractTimeoutSeconds: 90,
  memoryMaintenanceEnabled: false,
  memoryMaintenanceIntervalDays: 7,
  memoryMaintenanceIdleMinutes: 15,
  memoryMaintenanceGlobalTokenBudget: 4000,
  memoryMaintenanceProjectTokenBudget: 2500,
  memoryMaintenanceTotalTokenBudget: 12000,
  memoryMaintenanceStrategy: "report" as const,
  nextStepTimeoutSeconds: 25,
  compressTimeoutSeconds: 0,
  autoCompressThresholdPercent: 95,
  restoreLastSession: false,
  autoOpenPanel: false,
  warmStart: true,
  soundFeedback: true,
  osNotifications: "approvals",
  language: "",
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
  superAgentMaxConcurrent: 5,
  superAgentIntegration: "merge",
  superAgentMaxWorktrees: 10,
  superAgentKeepWorktree: false,
  superAgentFullTrust: false,
  superAgentDefaultWorkspace: "",
} as HostSettingsUi));
const chat = vi.hoisted(() => ({
  pending: null as { kind: string; target: string } | null,
  // 新增用例需要把完整的 SessionState 投影塞进来；既有用例只写
  // pendingProfileSwitch，Record 让两种形状都能赋值。
  state: null as Record<string, unknown> | null,
  // App / Composer 渲染时订阅的顶层字段（渲染路径不调用，但 selector 要取到）。
  toggleFocusMode: () => {},
  focusMode: false,
  headerScrolled: false,
  setHeaderScrolled: () => {},
  editorTheme: "light",
  promptSeq: 0,
  toasts: [] as unknown[],
  notify: () => {},
  dismissToast: () => {},
  clearMemoryDraft: () => {},
  memoryDraftRequest: null,
  composerDraftRequest: null,
  beginPending: () => {},
  superTranscripts: {} as Record<string, unknown>,
}));
const modelMetadata = vi.hoisted(() => ({
  state: "idle" as "idle" | "searching" | "done" | "error",
  added: undefined as { windows: number; costs: number; rules: number } | undefined,
  error: undefined as string | undefined,
}));
/** 宿主的「上下文窗口覆写」通道载荷（行 + 当前模型 + 内建窗口）。 */
const contextWindow = vi.hoisted(() => ({
  view: null as { overrides: string[]; currentModelId?: string; builtinWindow?: number } | null,
}));

vi.mock("../webview/src/store", () => ({
  useChat: Object.assign(
    (selector: (state: {
      send: typeof send;
      updateHostSetting: typeof updateHostSetting;
      hostSettings: typeof hostSettings;
      modelMetadata: typeof modelMetadata;
      contextWindowOverridesView: typeof contextWindow.view;
      pending: typeof chat.pending;
      state: typeof chat.state;
    }) => unknown) =>
      selector({
        send,
        updateHostSetting,
        hostSettings,
        modelMetadata,
        contextWindowOverridesView: contextWindow.view,
        ...chat,
      }),
    {
      getState: () => ({
        send,
        ...chat,
        hostSettings,
        modelMetadata,
        updateHostSetting,
        contextWindowOverridesView: contextWindow.view,
      }),
    },
  ),
}));
vi.mock("../webview/src/i18n", () => ({
  t: (s: string, ...args: string[]) => s.replace(/\{(\d+)\}/g, (_, i) => args[Number(i)] ?? ""),
}));
// 新增用例只断言顶栏 / 设置页 / Composer 三处切换；转录与子会话看板不参与。
vi.mock("../webview/src/components/MessageList", () => ({ MessageList: () => null }));
vi.mock("../webview/src/components/SuperAgentBoard", () => ({ SuperAgentBoard: () => null }));

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
  contextWindow.view = null;
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
  expect(container.textContent).toContain("会话");
  expect(container.textContent).toContain("外观与交互");
  expect(container.textContent).not.toContain("权限与审批");
  expect(container.textContent).toContain("MCP 与工具");
  expect(container.textContent).toContain("记忆与知识");
  expect(container.textContent).toContain("运行与数据");
});

it("groups the nine tabs under four named sections", () => {
  for (const group of ["账户", "工作方式", "扩展", "系统"]) {
    expect(container.textContent).toContain(group);
  }
  // The nav is a real tablist with roving tabindex, not a flat button row.
  const tablist = container.querySelector('[role="tablist"]');
  expect(tablist).toBeTruthy();
  const tabs = container.querySelectorAll('[role="tab"]');
  expect(tabs).toHaveLength(9);
  expect([...tabs].filter((el) => el.getAttribute("tabindex") === "0")).toHaveLength(1);
});

/**
 * 窄屏（容器 <560px）导航：单行横向滚动 tab 条，不再纵向堆叠折行——旧实现
 * 在 360px 视口下占 ~312px 高度，内容区只剩 224px。jsdom 不计算容器查询，
 * 断言落在类名上：窄屏基类（横向滚动 / 无固定宽 / tab 不收缩）与宽屏变体
 * （172px 侧栏）分开断言，两层合起来即「窄屏不占宽、宽屏不变」。
 */
describe("窄屏设置导航（横向滚动 tab 条）", () => {
  const tablist = () => container.querySelector<HTMLElement>('[role="tablist"]')!;

  it("窄屏下导航是单行横向滚动条，不占固定宽度，内容区全宽", () => {
    const nav = tablist();
    // 窄屏基类：横向滚动；无固定侧栏宽度（w-[172px] 只允许出现在宽屏变体里）。
    expect(nav.className).toContain("overflow-x-auto");
    const tokens = nav.className.split(/\s+/);
    expect(tokens).not.toContain("w-[172px]");
    expect(tokens).toContain("@min-[560px]:w-[172px]");
    // 每个 tab 不折行不收缩：超出容器宽度的部分横向滚动，而不是挤压换行。
    const tabs = nav.querySelectorAll("button");
    expect(tabs).toHaveLength(9);
    for (const tab of tabs) {
      expect(tab.className).toContain("shrink-0");
      expect(tab.className).not.toContain("basis-");
    }
    // 内容区 flex-1 + min-w-0 → 占满导航之外的全部宽度。
    const content = container.querySelector("#settings-panel");
    expect(content?.className).toContain("flex-1");
    expect(content?.className).toContain("min-w-0");
  });

  it("分组语义保留，分组标题只在宽屏侧栏显示", () => {
    const nav = tablist();
    expect(nav.querySelectorAll('[role="group"]')).toHaveLength(4);
    const labels = [...nav.querySelectorAll<HTMLElement>('div[aria-hidden="true"]')];
    expect(labels.map((el) => el.textContent)).toEqual(["账户", "工作方式", "扩展", "系统"]);
    for (const label of labels) {
      expect(label.className).toContain("hidden");
      expect(label.className).toContain("@min-[560px]:block");
    }
  });

  it("宽屏保持左侧边栏（172px 固定宽 + 纵向排布 + 右分隔线）", () => {
    const nav = tablist();
    expect(nav.className).toContain("@min-[560px]:flex-col");
    expect(nav.className).toContain("@min-[560px]:w-[172px]");
    expect(nav.className).toContain("@min-[560px]:border-r");
    expect(nav.className).toContain("@min-[560px]:overflow-y-auto");
  });

  it("tablist 键盘可达：ArrowRight / ArrowLeft / End / Home 切换并移动焦点", () => {
    const onTabChange = vi.fn();
    act(() =>
      root.render(
        <SettingsModal
          tab="chat"
          onTabChange={onTabChange}
          onDismiss={() => {}}
          dismissible
          busy={false}
          auth={BASIC_AUTH}
        />,
      ),
    );
    const active = tablist().querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!;
    expect(active.id).toBe("settings-tab-chat");
    const fire = (key: string) =>
      act(() => active.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
    // 顺序：api → chat → appearance → mcp → memory → assets → super → qq → runtime。
    fire("ArrowRight");
    expect(onTabChange).toHaveBeenLastCalledWith("appearance");
    expect(document.activeElement?.id).toBe("settings-tab-appearance");
    fire("ArrowLeft");
    expect(onTabChange).toHaveBeenLastCalledWith("api");
    fire("End");
    expect(onTabChange).toHaveBeenLastCalledWith("runtime");
    fire("Home");
    expect(onTabChange).toHaveBeenLastCalledWith("api");
  });

  it("切换后选中的 tab 滚入导航可视区", () => {
    const target = container.querySelector<HTMLButtonElement>("#settings-tab-mcp");
    expect(target).toBeTruthy();
    const scrollIntoView = vi.fn();
    Object.defineProperty(target!, "scrollIntoView", { value: scrollIntoView, configurable: true });
    act(() =>
      root.render(
        <SettingsModal
          tab="mcp"
          onTabChange={() => {}}
          onDismiss={() => {}}
          dismissible
          busy={false}
          auth={BASIC_AUTH}
        />,
      ),
    );
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });
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

/**
 * 「完全信任模式」开关（iflow.superAgent.fullTrust，默认关闭）。
 *
 * 三件事钉死：①默认关闭；②打开时把取值写回宿主设置（宿主据此喂给
 * `shared/super-tool-policy.ts` 的策略层）；③宿主已下发开启时读回宿主值，
 * 不回落成默认值。可见文案必须写清「默认关闭」与它解除的是哪一层限制
 * （工具白名单 / MCP 服务器白名单），否则用户按不住这个开关。
 */
it("keeps the full-trust switch off by default and says so on screen", () => {
  hostSettings.superAgentFullTrust = false;
  renderTab("super", BASIC_AUTH);
  const toggle = container.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="完全信任模式"]');
  expect(toggle).toBeTruthy();
  expect(toggle!.getAttribute("aria-checked")).toBe("false");
  expect(container.textContent).toContain("默认关闭：开启后不再向超流体施加工具白名单与 MCP 服务器白名单限制。");
});

it("writes the full-trust switch value back to host settings", () => {
  hostSettings.superAgentFullTrust = false;
  renderTab("super", BASIC_AUTH);
  const toggle = container.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="完全信任模式"]')!;
  act(() => toggle.click());
  expect(updateHostSetting).toHaveBeenCalledWith({ superAgentFullTrust: true });
});

it("reads the full-trust value back from the host settings", () => {
  hostSettings.superAgentFullTrust = true;
  try {
    renderTab("super", BASIC_AUTH);
    const toggle = container.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="完全信任模式"]');
    expect(toggle).toBeTruthy();
    expect(toggle!.getAttribute("aria-checked")).toBe("true");
  } finally {
    hostSettings.superAgentFullTrust = false;
  }
});

it("renders runtime groups and commits the Node path on blur", () => {
  renderTab("runtime", BASIC_AUTH);
  expect(container.textContent).toContain("检查点");
  expect(container.textContent).toContain("Node.js 路径");
  // Node path / checkpoint limits moved into the 高级 disclosure (4.7).
  const toggle = [...container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((b) =>
    b.textContent?.includes("高级"),
  );
  expect(toggle).toBeTruthy();
  expect(toggle!.getAttribute("aria-expanded")).toBe("false");
  act(() => toggle!.click());
  expect(toggle!.getAttribute("aria-expanded")).toBe("true");
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
    name: "B", baseUrl: "https://gw.example.com/v1",
    modelName: "model-b", keyTail: "1234", active: false,
  }],
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
  expect(container.textContent).toContain("自定义上下文窗口");
  expect(container.textContent).toContain("思考模型规则");
});

it("the metadata fetch button starts the web-search fetch", () => {
  renderApiTab();
  expect(container.textContent).toContain("检索到的资料会交给当前模型提炼一次，额外消耗 token。");
  click("开始检索");
  expect(send).toHaveBeenCalledWith({ type: "fetchModelMetadata" });
});

it("shows the busy label and stop control while the fetch is searching", () => {
  modelMetadata.state = "searching";
  renderApiTab();
  expect(container.textContent).toContain("正在检索…");
  expect(container.textContent).toContain("正在检索资料，随后交给当前模型提炼…");
  click("停止检索");
  expect(send).toHaveBeenCalledWith({ type: "cancelModelMetadata" });
  modelMetadata.state = "idle";
});

it("shows the appended counts when the fetch finishes", () => {
  modelMetadata.state = "done";
  modelMetadata.added = { windows: 2, costs: 1, rules: 2 };
  renderApiTab();
  expect(container.textContent).toContain("已追加：上下文窗口 2 条 · 成本单价 1 条 · 思考规则 2 条");
  modelMetadata.state = "idle";
  modelMetadata.added = undefined;
});

it("keeps the metadata status line out of the disclosure's divided children", () => {
  // SettingsDisclosure's body applies `divide-y`, i.e. a border-top to every
  // child after the first. The status line must share the action row's
  // wrapper: as a direct child it got its own divider, which the -mt-2 pull
  // dragged straight through the spinner text and the 停止检索 button.
  renderApiTab();
  click("模型元数据");
  const hint = [...container.querySelectorAll("span")].find((el) =>
    el.textContent?.includes("检索到的资料会交给当前模型提炼一次"),
  );
  const block = hint?.parentElement?.parentElement;
  const divider = block?.parentElement;
  expect(block?.textContent).toContain("联网补充模型数据");
  expect(divider?.className).toContain("divide-y");
  expect(divider?.firstElementChild).toBe(block);
});

/* --- 上下文窗口覆写（结构化编辑器） --------------------------------------- */

/** 打开设置页的「账户与模型」页并展开「模型元数据」分组。 */
function renderContextWindowOverrides() {
  renderApiTab();
  click("模型元数据");
}

function overrideInput(label: string): HTMLInputElement {
  const input = container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null;
  expect(input).toBeTruthy();
  return input!;
}

/** React 受控输入：走原生 setter + input 事件（与项目其它 UI 用例同法）。 */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("rejects an empty model name with an inline error", () => {
  contextWindow.view = { overrides: [] };
  renderContextWindowOverrides();
  typeInto(overrideInput("上下文窗口"), "960000");
  click("添加");
  expect(container.textContent).toContain("请填写模型名");
  expect(send).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "setContextWindowOverrides" }),
  );
});

it("rejects a window value the runtime would silently drop", () => {
  // "960K" 在运行时被 parseContextWindowOverrides 静默丢弃 —— 设置页必须
  // 在写盘前就拦住，否则用户以为配好了、实际没生效。
  contextWindow.view = { overrides: [] };
  renderContextWindowOverrides();
  typeInto(overrideInput("模型名"), "deepseek-v4.1-flash");
  typeInto(overrideInput("上下文窗口"), "960K");
  click("添加");
  expect(container.textContent).toContain("上下文窗口必须是正整数（纯数字，不带 K / M 单位）");
  expect(send).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "setContextWindowOverrides" }),
  );
});

it("submits a new override row under its normalized model name", () => {
  contextWindow.view = { overrides: [] };
  renderContextWindowOverrides();
  typeInto(overrideInput("模型名"), "auto/deepseek-v4.1-flash");
  typeInto(overrideInput("上下文窗口"), "960000");
  click("添加");
  expect(send).toHaveBeenCalledWith({
    type: "setContextWindowOverrides",
    overrides: ["deepseek-v4.1-flash=960000"],
  });
});

it("lists override rows under their normalized model name", () => {
  contextWindow.view = { overrides: ["auto/deepseek-v4.1-flash=960000"] };
  renderContextWindowOverrides();
  expect(container.textContent).toContain("deepseek-v4.1-flash");
  expect(container.textContent).not.toContain("auto/deepseek-v4.1-flash");
  expect(container.textContent).toContain("960000");
});

it("marks an unparsable row as not applied instead of hiding it", () => {
  contextWindow.view = { overrides: ["deepseek=960K"] };
  renderContextWindowOverrides();
  expect(container.textContent).toContain("不生效");
  expect(container.textContent).toContain("deepseek=960K");
});

it("removes an override row", () => {
  contextWindow.view = { overrides: ["deepseek-v4.1-flash=960000", "glm-4.6=200000"] };
  renderContextWindowOverrides();
  const remove = container.querySelector('button[aria-label="删除覆写 glm-4.6"]') as HTMLButtonElement | null;
  expect(remove).toBeTruthy();
  act(() => remove!.click());
  expect(send).toHaveBeenCalledWith({
    type: "setContextWindowOverrides",
    overrides: ["deepseek-v4.1-flash=960000"],
  });
});

it("fills the current model's built-in window into the draft", () => {
  contextWindow.view = { overrides: [], currentModelId: "gemini-2.5-pro", builtinWindow: 1048576 };
  renderContextWindowOverrides();
  click("填入建议值");
  expect(overrideInput("模型名").value).toBe("gemini-2.5-pro");
  expect(overrideInput("上下文窗口").value).toBe("1048576");
});

it("shows a waiting label until the profile-switch choice is answered", () => {
  chat.pending = { kind: "profile", target: "B" };
  chat.state = { pendingProfileSwitch: { id: "pswitch-1", profileName: "B" } };
  renderApiTab();
  expect(container.textContent).toContain("等待选择…");
  expect(container.textContent).not.toContain("正在重新连接…");

  chat.state = { pendingProfileSwitch: null };
  renderApiTab();
  expect(container.textContent).toContain("正在重新连接…");
  expect(container.textContent).not.toContain("等待选择…");
});

const EMPTY_AUTH: AuthUiState = {
  authenticated: false,
  needsSetup: true,
  saved: null,
  profiles: [],
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
  expect(container.textContent).toContain("选一个服务商预设");
  click("DeepSeek");
  const fields = inputs();
  expect(fields[1]?.value).toBe("https://api.deepseek.com");
  expect(fields[3]?.value).toBe("deepseek-chat");
  expect(container.textContent).toContain("获取 API Key");
});

/**
 * API Key 字段：提示语不能塞进 placeholder。placeholder 既不换行也不省略，
 * 窄面板下整句被裁掉（「已保存（…fH04），留空则不改」），而且输入框宽度塌缩、
 * 眼睛按钮悬在框外。已保存提示改为字段下方的次级说明行。
 */
it("keeps the saved-key notice out of the API Key placeholder", () => {
  renderAuthTabWith({
    authenticated: true,
    needsSetup: false,
    saved: { baseUrl: "https://api.deepseek.com", modelName: "deepseek-chat", keyTail: "…fH04" },
    profiles: [],
    onboardingDismissed: false,
  });
  click("DeepSeek");
  const keyInput = inputs()[2]!;
  expect(keyInput.placeholder).toBe("sk-…");
  expect(keyInput.placeholder).not.toContain("已保存");
  expect(container.textContent).toContain("已保存（…fH04），留空则不改");
});

it("omits the saved-key notice when no key is stored", () => {
  renderAuthTabWith(EMPTY_AUTH);
  click("DeepSeek");
  const keyInput = inputs()[2]!;
  expect(keyInput.placeholder).toBe("sk-…");
  expect(container.textContent).not.toContain("已保存");
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
    onboardingDismissed: false,
  });
  click("智谱 GLM");
  const fields = inputs();
  expect(fields[1]?.value).toBe("https://open.bigmodel.cn/api/paas/v4");
  expect(fields[3]?.value).toBe("");
});

it("renders profile rows without an extension/Core source chip", () => {
  renderAuthTabWith(API_AUTH);
  const row = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("model-b"));
  expect(row).toBeTruthy();
  expect(row!.textContent).not.toContain("扩展");
  expect(row!.textContent).not.toContain("内核");
});

const MULTI_AUTH: AuthUiState = {
  ...BASIC_AUTH,
  profiles: [
    { name: "A", baseUrl: "https://a.example.com/v1", modelName: "model-a", keyTail: "1111", active: true },
    { name: "B", baseUrl: "https://b.example.com/v1", modelName: "model-b", keyTail: "2222", active: false },
    { name: "C", baseUrl: "https://c.example.com/v1", modelName: "model-c", keyTail: "3333", active: false },
  ],
};

describe("API 配置行更多菜单", () => {
  const previousObserver = (globalThis as unknown as Record<string, unknown>).ResizeObserver;
  beforeEach(() => {
    class Observer {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as unknown as Record<string, unknown>).ResizeObserver = Observer;
  });
  afterEach(() => {
    if (previousObserver === undefined) {
      delete (globalThis as unknown as Record<string, unknown>).ResizeObserver;
    } else {
      (globalThis as unknown as Record<string, unknown>).ResizeObserver = previousObserver;
    }
  });

  const moreButton = (name: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="配置 ${name} 的操作"]`);
  const rowOf = (name: string) => moreButton(name)?.closest<HTMLElement>(".card-lift");
  const overflowMenu = () =>
    [...document.body.querySelectorAll<HTMLElement>('[role="menu"]')].find((menu) =>
      menu.textContent?.includes("编辑") && menu.textContent?.includes("删除"),
    );

  it("hides the overflow action for the active API profile", () => {
    renderAuthTabWith(MULTI_AUTH);
    expect(moreButton("A")).toBeNull();
    expect(moreButton("B")).toBeTruthy();
    expect(moreButton("C")).toBeTruthy();
  });

  it("raises only the row whose overflow menu is open", () => {
    renderAuthTabWith(MULTI_AUTH);
    const button = moreButton("B");
    expect(button).toBeTruthy();
    expect(rowOf("B")?.className).not.toContain("z-20");
    expect(rowOf("C")?.className).not.toContain("z-20");

    act(() => button!.click());
    expect(overflowMenu()).toBeTruthy();
    expect(button!.getAttribute("aria-expanded")).toBe("true");
    expect(rowOf("B")?.className).toContain("relative z-20");
    expect(rowOf("C")?.className).not.toContain("z-20");

    act(() => button!.click());
    expect(overflowMenu()).toBeUndefined();
    expect(button!.getAttribute("aria-expanded")).toBe("false");
    expect(rowOf("B")?.className).not.toContain("z-20");
  });
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



/**
 * The turn-end ceilings live under their own toggle and follow it: the row is
 * shown only while the toggle is on, and it sits between that toggle and the
 * next one in the DOM.
 */
describe("回合末 timeout rows follow their toggle", () => {
  /** True when `a` appears before `b` in the rendered text. */
  const before = (a: string, b: string) => {
    const text = container.textContent ?? "";
    const ia = text.indexOf(a);
    const ib = text.indexOf(b);
    expect(ia).toBeGreaterThanOrEqual(0);
    expect(ib).toBeGreaterThanOrEqual(0);
    return ia < ib;
  };

  beforeEach(() => {
    hostSettings.nextStepSuggestions = true;
    hostSettings.autoCompressOnIdle = false;
    hostSettings.autoMemoryCapture = true;
  });

  it("hides the next-step timeout while 下一步建议 is off", () => {
    hostSettings.nextStepSuggestions = false;
    renderTab("chat", BASIC_AUTH);
    expect(container.textContent).not.toContain("下一步预测超时");
  });

  it("hides the compression rows while 自动压缩上下文 is off", () => {
    renderTab("chat", BASIC_AUTH);
    expect(container.textContent).not.toContain("压缩超时");
    expect(container.textContent).not.toContain("自动压缩阈值");
  });

  it("hides the memory timeout while 自动提取记忆 is off", () => {
    hostSettings.autoMemoryCapture = false;
    renderTab("chat", BASIC_AUTH);
    expect(container.textContent).not.toContain("记忆提取超时");
  });

  it("shows each timeout under its own toggle, in order", () => {
    hostSettings.autoCompressOnIdle = true;
    renderTab("chat", BASIC_AUTH);
    expect(container.textContent).toContain("下一步预测超时");
    expect(container.textContent).toContain("压缩超时");
    expect(container.textContent).toContain("自动压缩阈值");
    expect(container.textContent).toContain("记忆提取超时");
    // 下一步建议 → 它的超时 → 自动压缩上下文 → 压缩超时 → 阈值 → 自动提取记忆 → 它的超时
    expect(before("下一步建议", "下一步预测超时")).toBe(true);
    expect(before("下一步预测超时", "自动压缩上下文")).toBe(true);
    expect(before("自动压缩上下文", "压缩超时")).toBe(true);
    expect(before("压缩超时", "自动压缩阈值")).toBe(true);
    expect(before("自动压缩阈值", "自动提取记忆")).toBe(true);
    expect(before("自动提取记忆", "记忆提取超时")).toBe(true);
  });

  it("carries the configured values into the controls", () => {
    hostSettings.autoCompressOnIdle = true;
    renderTab("chat", BASIC_AUTH);
    const number = (label: string) =>
      container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)?.value;
    expect(number("下一步预测超时")).toBe("25");
    expect(number("记忆提取超时")).toBe("90");
    expect(number("压缩超时")).toBe("0");
    expect(number("自动压缩阈值")).toBe("95");
  });
});

/**
 * 记忆整理（P1）：设置分组在「记忆与知识」页渲染（整理的是记忆文件本身，
 * 因此归入该分类，不再挂在「对话」页），且每个控件都通过 updateHostSetting
 * 写回宿主。总开关关闭时从属行（策略 / 周期 / 阈值 / 预算）必须隐藏 ——
 * 避免用户以为关掉开关仍在按默认值整理。
 */
describe("记忆整理设置", () => {
  const label = (text: string) => text;

  beforeEach(() => {
    hostSettings.memoryMaintenanceEnabled = false;
    hostSettings.memoryMaintenanceIntervalDays = 7;
    hostSettings.memoryMaintenanceIdleMinutes = 15;
    hostSettings.memoryMaintenanceGlobalTokenBudget = 4000;
    hostSettings.memoryMaintenanceProjectTokenBudget = 2500;
    hostSettings.memoryMaintenanceTotalTokenBudget = 12000;
    hostSettings.memoryMaintenanceStrategy = "report";
  });

  it("在记忆与知识页渲染记忆整理分组与总开关", () => {
    renderTab("memory", BASIC_AUTH);
    expect(container.textContent).toContain("记忆整理");
    const toggles = container.querySelectorAll<HTMLButtonElement>('button[role="switch"][aria-label="定期整理记忆"]');
    // 只渲染一次：迁移后原分类与新分类不得同时出现。
    expect(toggles).toHaveLength(1);
    const toggle = toggles[0]!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("对话页不再残留记忆整理分组", () => {
    renderTab("chat", BASIC_AUTH);
    expect(container.textContent).not.toContain("记忆整理");
    expect(container.querySelector('button[role="switch"][aria-label="定期整理记忆"]')).toBeNull();
  });

  it("打开总开关会写回宿主设置", () => {
    renderTab("memory", BASIC_AUTH);
    const toggle = container.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="定期整理记忆"]')!;
    act(() => toggle.click());
    expect(updateHostSetting).toHaveBeenCalledWith({ memoryMaintenanceEnabled: true });
  });

  it("关闭时隐藏策略与数值行", () => {
    renderTab("memory", BASIC_AUTH);
    expect(container.textContent).not.toContain("整理策略");
    expect(container.textContent).not.toContain("整理周期");
    expect(container.textContent).not.toContain("空闲阈值");
    expect(container.textContent).not.toContain("全局记忆预算");
    expect(container.textContent).not.toContain("项目记忆预算");
    expect(container.textContent).not.toContain("总量预算");
  });

  it("打开后渲染策略分段控件并写回所选值", () => {
    hostSettings.memoryMaintenanceEnabled = true;
    renderTab("memory", BASIC_AUTH);
    expect(container.textContent).toContain("整理策略");
    const apply = [...container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')].find(
      (b) => b.textContent === "执行并改写文件",
    );
    expect(apply).toBeTruthy();
    act(() => apply!.click());
    expect(updateHostSetting).toHaveBeenCalledWith({ memoryMaintenanceStrategy: "apply" });
  });

  it("渲染周期 / 阈值 / 三个预算的当前值", () => {
    hostSettings.memoryMaintenanceEnabled = true;
    renderTab("memory", BASIC_AUTH);
    const number = (name: string) =>
      container.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)?.value;
    expect(number(label("整理周期"))).toBe("7");
    expect(number(label("空闲阈值"))).toBe("15");
    expect(number(label("全局记忆预算"))).toBe("4000");
    expect(number(label("项目记忆预算"))).toBe("2500");
    expect(number(label("总量预算"))).toBe("12000");
  });

  it("提交空闲阈值时写回宿主设置", () => {
    hostSettings.memoryMaintenanceEnabled = true;
    renderTab("memory", BASIC_AUTH);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="空闲阈值"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "30");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      input.focus();
      input.blur();
    });
    expect(updateHostSetting).toHaveBeenCalledWith({ memoryMaintenanceIdleMinutes: 30 });
  });

  it("提交总量预算时写回宿主设置", () => {
    hostSettings.memoryMaintenanceEnabled = true;
    renderTab("memory", BASIC_AUTH);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="总量预算"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "16000");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      input.focus();
      input.blur();
    });
    expect(updateHostSetting).toHaveBeenCalledWith({ memoryMaintenanceTotalTokenBudget: 16000 });
  });
});

/**
 * 活跃子会话期间三处「切换」必须一起禁用：历史会话下拉、设置页 API 配置
 * 切换、模型下拉。切换会让在跑的子会话用错凭据/模型，或让汇报落到被替换的
 * 主会话；但主会话仍必须能发消息（Composer 发送按钮不受影响）。
 */
describe("活跃超流体禁用会话/模型/凭据切换", () => {
  function child(status: SuperStatus): SuperSessionUi {
    return {
      id: `child-${status}`,
      title: "子任务",
      task: "执行任务",
      status,
      isolation: { kind: "worktree", path: "/w" },
      createdAt: 0,
      updatedAt: 0,
      reports: [],
    } as unknown as SuperSessionUi;
  }

  /** 最小完整投影：顶栏历史下拉、设置页 profile 行、Composer 模型下拉都要出现。 */
  function appState(superSessions: SuperSessionUi[]): Record<string, unknown> {
    return {
      blocks: [],
      status: "idle",
      errorMessage: null,
      errorAdvice: null,
      stopReason: null,
      sessionId: "s1",
      modes: null,
      commands: [],
      skills: [],
      models: [{ id: "model-a", name: "Model A" }],
      currentModelId: "model-a",
      thinkLevel: "auto",
      pendingApproval: null,
      pendingQuestions: null,
      pendingProfileSwitch: null,
      auth: {
        authenticated: true,
        needsSetup: false,
        saved: null,
        profiles: [
          { name: "A", baseUrl: "https://a.example.com/v1", modelName: "model-a", keyTail: "1111", active: true },
          { name: "B", baseUrl: "https://gw.example.com/v1", modelName: "model-b", keyTail: "1234", active: false },
        ],
        onboardingDismissed: true,
      },
      sessions: [{ id: "s1", label: "会话 1", updatedAt: 0 }],
      activeSessionId: "s1",
      replaying: false,
      initializing: false,
      compressing: false,
      superWaiting: false,
      superSessions,
      queue: [],
      queuePaused: false,
      checkpoints: [],
      nextStepSuggestions: [],
      nextStepLoading: false,
    };
  }

  function renderApp(superSessions: SuperSessionUi[]): void {
    chat.state = appState(superSessions);
    act(() => root.render(<App />));
  }

  const historyButton = () =>
    document.querySelector<HTMLButtonElement>('button[title="历史会话（选择后恢复该会话上下文）"]');
  const modelButton = () => document.querySelector<HTMLButtonElement>('button[title="模型"]');
  const sendButton = () =>
    [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "发送") as
      | HTMLButtonElement
      | undefined;
  const profileButton = () =>
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("model-b")) as
      | HTMLButtonElement
      | undefined;

  /** 空输入时发送按钮本来就禁用，先写入草稿才能验证「仍可用」。 */
  function typeDraft(): void {
    const textarea = container.querySelector("textarea");
    expect(textarea).toBeTruthy();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "继续");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function openSettings(): void {
    const gear = container.querySelector<HTMLButtonElement>('button[aria-label="设置"]');
    expect(gear).toBeTruthy();
    act(() => gear!.click());
  }

  beforeEach(() => {
    class Observer {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords(): [] {
        return [];
      }
    }
    (globalThis as unknown as Record<string, unknown>).ResizeObserver = Observer;
    (globalThis as unknown as Record<string, unknown>).IntersectionObserver = Observer;
  });

  for (const status of ["preparing", "running", "awaiting_input"] as const) {
    it(`超流体 ${status}：历史下拉 / API 配置 / 模型下拉禁用，发送仍可用`, () => {
      renderApp([child(status)]);
      expect(historyButton()).toBeTruthy();
      expect(historyButton()!.disabled).toBe(true);
      expect(modelButton()).toBeTruthy();
      expect(modelButton()!.disabled).toBe(true);
      typeDraft();
      expect(sendButton()).toBeTruthy();
      expect(sendButton()!.disabled).toBe(false);
      openSettings();
      expect(profileButton()).toBeTruthy();
      expect(profileButton()!.disabled).toBe(true);
    });
  }

  it("超流体全部终态：三处恢复可用", () => {
    renderApp([child("completed"), child("failed"), child("cancelled")]);
    expect(historyButton()!.disabled).toBe(false);
    expect(modelButton()!.disabled).toBe(false);
    openSettings();
    expect(profileButton()!.disabled).toBe(false);
  });
});

/**
 * 保存按钮的 busy 门控只针对「会打断当前会话」的保存：编辑非当前配置
 * 只写内核配置文件、宿主不重连，所以生成中或有子会话在跑时也必须能点
 * （此前一律 disabled，用户读作「没保存成功」）；编辑当前使用中的配置
 * 才会重新认证会话，busy 时禁用并给出原因；新增配置仍走激活 + 冷重连。
 */
describe("API 配置保存按钮的 busy 门控", () => {
  const previousObserver = (globalThis as unknown as Record<string, unknown>).ResizeObserver;
  beforeEach(() => {
    class Observer {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as unknown as Record<string, unknown>).ResizeObserver = Observer;
  });
  afterEach(() => {
    if (previousObserver === undefined) {
      delete (globalThis as unknown as Record<string, unknown>).ResizeObserver;
    } else {
      (globalThis as unknown as Record<string, unknown>).ResizeObserver = previousObserver;
    }
  });

  const SAVE_REASON = "这是正在使用的配置。正在生成或有超流体在跑，暂时不能保存。";
  /** B 变成当前使用的配置（编辑它才会触发重新认证）。 */
  const ACTIVE_B_AUTH: AuthUiState = {
    ...MULTI_AUTH,
    profiles: MULTI_AUTH.profiles.map((p) => ({ ...p, active: p.name === "B" })),
  };

  function renderApi(auth: AuthUiState, busy: boolean) {
    act(() => root.render(
      <SettingsModal
        tab="api"
        onTabChange={() => {}}
        onDismiss={() => {}}
        dismissible
        busy={busy}
        auth={auth}
      />,
    ));
  }

  /** 从行内「更多操作」菜单进入编辑表单（active 行没有菜单，这里都编辑非 active 行）。 */
  function openEdit(name: string) {
    const more = container.querySelector<HTMLButtonElement>(`button[aria-label="配置 ${name} 的操作"]`);
    expect(more).toBeTruthy();
    act(() => more!.click());
    const editItem = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (el) => el.textContent?.trim() === "编辑",
    );
    expect(editItem).toBeTruthy();
    act(() => editItem!.click());
  }

  const saveButton = () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "保存" || b.textContent === "保存中…",
    );

  it("busy 时编辑非当前配置仍可保存（只落盘，不重连）", () => {
    renderApi(MULTI_AUTH, false);
    openEdit("B");
    // 表单打开后开始生成 / 子会话启动 → busy 变 true，表单保持。
    renderApi(MULTI_AUTH, true);
    const save = saveButton();
    expect(save).toBeTruthy();
    expect(save!.disabled).toBe(false);
    expect(container.textContent).not.toContain(SAVE_REASON);
    act(() => save!.click());
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "saveAuth", replaceName: "B" }));
  });

  it("busy 时编辑当前使用的配置：保存禁用并说明原因", () => {
    renderApi(MULTI_AUTH, false);
    openEdit("B");
    renderApi(ACTIVE_B_AUTH, true);
    const save = saveButton();
    expect(save).toBeTruthy();
    expect(save!.disabled).toBe(true);
    expect(container.textContent).toContain(SAVE_REASON);
  });

  it("空闲时编辑当前使用的配置可以保存", () => {
    renderApi(MULTI_AUTH, false);
    openEdit("B");
    renderApi(ACTIVE_B_AUTH, false);
    const save = saveButton();
    expect(save).toBeTruthy();
    expect(save!.disabled).toBe(false);
    expect(container.textContent).not.toContain(SAVE_REASON);
  });

  /** 用原生 setter 改受控输入（React 只认 value 的原型 setter + input 事件）。 */
  function typeInput(placeholder: string, value: string) {
    const input = [...container.querySelectorAll<HTMLInputElement>("input")].find(
      (el) => el.placeholder === placeholder,
    );
    expect(input).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input!, value);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return input!;
  }

  it("保存失败：表单不关闭、字段保留，并就地显示宿主返回的具体错误", () => {
    renderApi(MULTI_AUTH, false);
    openEdit("B");
    const edited = "https://changed.example.com/v1";
    typeInput("https://api.example.com/v1", edited);

    act(() => saveButton()!.click());
    const call = send.mock.calls.at(-1)![0] as { type: string; requestId?: number; baseUrl?: string };
    expect(call.type).toBe("saveAuth");
    expect(typeof call.requestId).toBe("number");
    expect(call.baseUrl).toBe(edited);
    // 乐观关闭已移除：收到回执前表单仍在（字段还在，按钮变「保存中…」）。
    expect(container.textContent).toContain("服务商预设");
    expect([...container.querySelectorAll<HTMLInputElement>("input")].some(
      (el) => el.value === edited,
    )).toBe(true);

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: {
          type: "saveAuthResult",
          requestId: call.requestId,
          ok: false,
          error: "内核配置写入失败（磁盘只读）",
        },
      }));
    });
    expect(container.textContent).toContain("内核配置写入失败（磁盘只读）");
    const alert = [...container.querySelectorAll('[role="alert"]')].find((el) =>
      el.textContent?.includes("内核配置写入失败"),
    );
    expect(alert).toBeTruthy();
    // 失败后用户输入的每一个字段都还在，可原地修改重试。
    expect([...container.querySelectorAll<HTMLInputElement>("input")].some(
      (el) => el.value === edited,
    )).toBe(true);
    expect(saveButton()).toBeTruthy();
  });

  it("只在该保存的成功回执到达后才关闭表单", () => {
    renderApi(MULTI_AUTH, false);
    openEdit("B");
    act(() => saveButton()!.click());
    const requestId = (send.mock.calls.at(-1)![0] as { requestId?: number }).requestId;

    // 另一条保存的回执不能误关本表单。
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: { type: "saveAuthResult", requestId: (requestId ?? 0) + 100, ok: true },
      }));
    });
    expect(saveButton()).toBeTruthy();

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: { type: "saveAuthResult", requestId, ok: true },
      }));
    });
    expect(container.textContent).toContain("添加配置");
    expect(saveButton()).toBeFalsy();
  });
});

describe("记忆保存失败可见与状态播报", () => {
  function renderMemory() {
    act(() => root.render(
      <SettingsModal
        tab="memory"
        onTabChange={() => {}}
        onDismiss={() => {}}
        dismissible
        busy={false}
        auth={BASIC_AUTH}
      />,
    ));
  }

  const MEM_STATE = {
    home: "/home/.iflow",
    cwd: null,
    workspaceRoots: [],
    files: [{
      path: "/home/.iflow/AGENTS.md",
      displayPath: "~/.iflow/AGENTS.md",
      scope: "global",
      role: "primary",
      exists: true,
      editable: true,
      injected: true,
      bytes: 12,
      tokens: 3,
      updatedAt: null,
      hash: "abc",
    }],
    globalPrimary: "/home/.iflow/AGENTS.md",
    projectPrimary: null,
  } as unknown as import("../shared/messages").MemoryStateUi;

  function post(data: unknown) {
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data }));
    });
  }

  it("写入失败就地可见、提供重试，失败/成功节点带 aria-live", () => {
    renderMemory();
    post({ type: "memoryState", state: MEM_STATE });
    // 模拟一次快速追加失败后宿主回报的具体错误。
    post({
      type: "memorySaved",
      path: "/home/.iflow/AGENTS.md",
      ok: false,
      error: "磁盘只读，无法写入记忆文件",
    });

    expect(container.textContent).toContain("磁盘只读，无法写入记忆文件");
    const alert = [...container.querySelectorAll('[role="alert"]')].find((el) =>
      el.textContent?.includes("磁盘只读，无法写入记忆文件"),
    );
    expect(alert).toBeTruthy();
    // 就地重试动作：点击会重发上一条写入请求。
    const retry = [...alert!.querySelectorAll("button")].find((b) => b.textContent === "重试");
    expect(retry).toBeTruthy();

    // 成功回执清掉失败节点，成功提示带 role=status / aria-live=polite。
    post({ type: "memorySaved", path: "/home/.iflow/AGENTS.md", ok: true });
    expect(container.textContent).not.toContain("磁盘只读，无法写入记忆文件");
    const status = container.querySelector('[role="status"][aria-live="polite"]');
    expect(status).toBeTruthy();
    expect(status!.textContent).toContain("已保存");
  });
});

/**
 * 「记忆文件」「项目知识库」默认折叠：设置页首屏只留块头，长文件列表与知识
 * 文档列表按需展开。区块体仍挂载（hidden），所以断言落在 aria-expanded 与
 * 区块体的 hidden 类上，而不是「文本不在 DOM 里」。
 *
 * 例外：知识库生成进度与失败提示渲染在区块体内，有任务在跑或失败时必须自动
 * 展开，否则点了「生成项目知识」看不到任何反馈。
 */
describe("记忆页：记忆文件与项目知识库默认折叠", () => {
  const MEM_STATE = {
    home: "/home/.iflow",
    cwd: null,
    workspaceRoots: [],
    files: [{
      path: "/home/.iflow/AGENTS.md",
      displayPath: "~/.iflow/AGENTS.md",
      scope: "global",
      role: "primary",
      exists: true,
      editable: true,
      injected: true,
      bytes: 12,
      tokens: 3,
      updatedAt: null,
      hash: "abc",
    }],
    globalPrimary: "/home/.iflow/AGENTS.md",
    projectPrimary: null,
  } as unknown as import("../shared/messages").MemoryStateUi;

  function renderMemoryTab() {
    act(() =>
      root.render(
        <SettingsModal
          tab="memory"
          onTabChange={() => {}}
          onDismiss={() => {}}
          dismissible
          busy={false}
          auth={BASIC_AUTH}
        />,
      ),
    );
  }

  /** 折叠头是按标题文案找的按钮（chevron + h3 标题）。 */
  function disclosureHeader(title: string): HTMLButtonElement {
    const btn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === title,
    );
    expect(btn).toBeTruthy();
    return btn!;
  }

  /** 区块体：头按钮 aria-controls 指向的 div。 */
  function disclosureBody(title: string): HTMLElement {
    const id = disclosureHeader(title).getAttribute("aria-controls")!;
    const body = document.getElementById(id);
    expect(body).toBeTruthy();
    return body!;
  }

  function post(data: unknown) {
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data }));
    });
  }

  it("两个区块默认闭合（aria-expanded=false，区块体 hidden）", () => {
    renderMemoryTab();
    post({ type: "memoryState", state: MEM_STATE });

    for (const title of ["记忆文件", "项目知识库"]) {
      expect(disclosureHeader(title).getAttribute("aria-expanded")).toBe("false");
      expect(disclosureBody(title).className).toContain("hidden");
    }
  });

  it("点击块头可展开，再次点击收起", () => {
    renderMemoryTab();
    post({ type: "memoryState", state: MEM_STATE });

    for (const title of ["记忆文件", "项目知识库"]) {
      const header = disclosureHeader(title);
      act(() => header.click());
      expect(disclosureHeader(title).getAttribute("aria-expanded")).toBe("true");
      expect(disclosureBody(title).className).not.toContain("hidden");

      act(() => disclosureHeader(title).click());
      expect(disclosureHeader(title).getAttribute("aria-expanded")).toBe("false");
      expect(disclosureBody(title).className).toContain("hidden");
    }
  });

  it("知识库生成失败时自动展开，让区块体内的错误可见", () => {
    renderMemoryTab();
    post({ type: "memoryState", state: MEM_STATE });
    // 前置：默认闭合。
    expect(disclosureHeader("项目知识库").getAttribute("aria-expanded")).toBe("false");

    post({ type: "knowledgeJob", stage: "error", message: "生成失败：工作区为空" });

    expect(disclosureHeader("项目知识库").getAttribute("aria-expanded")).toBe("true");
    expect(disclosureBody("项目知识库").className).not.toContain("hidden");
    expect(disclosureBody("项目知识库").textContent).toContain("生成失败：工作区为空");
    // 记忆文件不受影响，仍保持折叠。
    expect(disclosureHeader("记忆文件").getAttribute("aria-expanded")).toBe("false");
  });
});
