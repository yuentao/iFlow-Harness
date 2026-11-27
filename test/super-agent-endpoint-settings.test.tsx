// @vitest-environment jsdom
/**
 * 超流体链路独立指针（`iflow.superAgentProfile` / `iflow.superAgentModel`）的
 * 「声明 → 实现」对账测试。
 *
 * 纪律（AGENTS.md 陷阱 #14）：新增设置项必须声明了就有实现，不能声明了却没人用。
 * 这里钉住三层：
 *  1. manifest 声明（package.json 的 contributes.configuration，键名 / 类型 / 默认值）；
 *  2. 双语占位（package.nls.json / package.nls.zh-cn.json，键集合一致且非空）；
 *  3. 设置页 UI（超流体分类里真的渲染出两个 kit 下拉，且选中后经**已有的通用
 *     设置写入通道** `setHostSettings` 写回——不是另造一条落盘通道）。
 *
 * 模型下拉的候选来源是独立的「按所选 API 配置实时拉取」通道
 * （webview→host `refreshSuperProfileModels`，host→webview `superProfileModels`），
 * **不是**主会话的 `state.models`——超流体选了另一个配置时，主会话那份列表属于
 * 另一个端点。这里锁定这条通道在 UI 侧的消费方式（错误显式呈现、占位、同源
 * 过滤）。
 *
 * 注意：本文件整体 mock 了 store，只能证明 UI 怎么消费视图。「这条回包属于哪
 * 一次选择」的权威判定（非空选择精确比对、空串跟随主会话时丢弃上一个选择的
 * 迟到回包、指针变化作废旧列表）由 `test/super-profile-models-store.test.ts`
 * 用真实 store 覆盖。
 *
 * 同时锁住 UI 语义：空串 = 走回退链（跟随主会话 / 跟随所选 API 配置），当前值
 * 不在候选列表里（配置被删或用户手改过 settings.json）时必须补占位选项，
 * 否则下拉会显示成空白，用户看不出到底选了什么。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsModal } from "../webview/src/components/SettingsModal";
import type { AuthUiState, HostSettingsUi } from "../shared/messages";

/** jsdom ships neither ResizeObserver nor scrollIntoView; the settings shell
 * only needs the members to exist. */
if (!("ResizeObserver" in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
/** React 19 refuses `act()` unless the environment declares itself act-capable. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REPO_ROOT = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  contributes: { configuration: { properties: Record<string, Record<string, unknown>> } };
};
const nlsEn = JSON.parse(readFileSync(join(REPO_ROOT, "package.nls.json"), "utf8")) as Record<string, string>;
const nlsZh = JSON.parse(readFileSync(join(REPO_ROOT, "package.nls.zh-cn.json"), "utf8")) as Record<string, string>;
const properties = manifest.contributes.configuration.properties;

const send = vi.hoisted(() => vi.fn());
const updateHostSetting = vi.hoisted(() => vi.fn());
/** 模型列表请求的专用 action（store 负责自增 requestId 并记录最近一次请求）；
 * UI 侧只断言它被调用、参数正确。 */
const requestSuperProfileModels = vi.hoisted(() => vi.fn());
/** 「按 Profile 拉模型」载荷的 mock：用例改写 `current` 模拟宿主回包（含
 * error / 空列表 / 降级）；null = 尚未回包（加载态）。 */
const superProfileModelsView = vi.hoisted(() => ({
  current: null as null | {
    profileName: string;
    models: Array<{ id: string; name: string }>;
    currentModelId: string;
    error?: string;
    degraded?: boolean;
    delistedModelId?: string;
    degradedModelId?: string;
    degradedReason?: string;
  },
}));
/** 共享的 `HostSettingsUi` 已带 superAgentProfile / superAgentModel（可选），
 * 这里不再重复声明同形状的本地类型。 */
const hostSettings = vi.hoisted(
  () =>
    ({
      superAgentProfile: "",
      superAgentModel: "",
      superAgentMaxConcurrent: 5,
      superAgentMaxAttempts: 2,
      superAgentDependencyPolicy: "block",
      superAgentIntegration: "merge",
      superAgentMaxWorktrees: 10,
      superAgentKeepWorktree: false,
      superAgentFullTrust: false,
      superAgentDefaultWorkspace: "",
    }) as unknown as HostSettingsUi,
);
const state = vi.hoisted(() => ({
  auth: {
    authenticated: true,
    needsSetup: false,
    saved: null,
    onboardingDismissed: true,
    profiles: [
      { name: "gateway", baseUrl: "https://a.example/v1", modelName: "alpha-1", keyTail: "abcd", active: true },
      { name: "backup", baseUrl: "https://b.example/v1", modelName: "beta-2", keyTail: "efgh", active: false },
    ],
  },
  // 主会话当前端点的模型列表：模型下拉**不得**再用它当候选来源。
  models: [
    { id: "alpha-1", name: "Alpha One" },
    { id: "gamma-3", name: "Gamma Three" },
  ],
}));

vi.mock("../webview/src/store", () => ({
  useChat: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({
        send,
        updateHostSetting,
        requestSuperProfileModels,
        hostSettings,
        superProfileModelsView: superProfileModelsView.current,
        state,
      }),
    {
      getState: () => ({
        send,
        updateHostSetting,
        requestSuperProfileModels,
        hostSettings,
        superProfileModelsView: superProfileModelsView.current,
        state,
      }),
    },
  ),
}));

const BASIC_AUTH = {
  authenticated: true,
  needsSetup: false,
  saved: null,
  profiles: [],
  onboardingDismissed: false,
} as AuthUiState;

let root: Root;
let container: HTMLDivElement;

function renderSuperTab(): void {
  act(() =>
    root.render(
      createElement(SettingsModal, {
        tab: "super",
        onTabChange: () => {},
        onDismiss: () => {},
        dismissible: true,
        busy: false,
        auth: BASIC_AUTH,
      }),
    ),
  );
}

/** 打开某个 kit 下拉并返回浮层里的选项（菜单 portal 到 document.body）。 */
function openMenu(trigger: HTMLButtonElement): HTMLButtonElement[] {
  act(() => trigger.click());
  return [...document.body.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']")];
}

function modelTrigger(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>("button[aria-label='模型']")!;
}

/** 跟随主会话（空串）时宿主 resolveSuperProfileTarget 解析出活动 Profile
 * `gateway`，回包里的 profileName 因此是 "gateway" 而不是空串。 */
function activeProfileReply(): void {
  superProfileModelsView.current = {
    profileName: "gateway",
    models: [
      { id: "alpha-1", name: "Alpha One" },
      { id: "delta-4", name: "Delta Four" },
    ],
    currentModelId: "alpha-1",
  };
}

beforeEach(() => {
  send.mockClear();
  updateHostSetting.mockClear();
  requestSuperProfileModels.mockClear();
  hostSettings.superAgentProfile = "";
  hostSettings.superAgentModel = "";
  activeProfileReply();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  renderSuperTab();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.querySelectorAll(".acrylic-pop").forEach((node) => node.remove());
});

describe("超流体链路的两个指针：声明与实现对账", () => {
  it("manifest 声明了两个键，类型为 string、默认空串（空 = 走回退链）", () => {
    for (const key of ["iflow.superAgentProfile", "iflow.superAgentModel"]) {
      const schema = properties[key];
      expect(schema, `${key} 未声明`).toBeTruthy();
      expect(schema!.type).toBe("string");
      expect(schema!.default).toBe("");
      const nlsKey = String(schema!.description ?? schema!.markdownDescription ?? "");
      expect(nlsKey.startsWith("%") && nlsKey.endsWith("%")).toBe(true);
      const bare = nlsKey.slice(1, -1);
      expect(nlsEn[bare], `英文 nls 缺少 ${bare}`).toBeTruthy();
      expect(nlsZh[bare], `中文 nls 缺少 ${bare}`).toBeTruthy();
    }
  });

  it("超流体分类渲染出两个 kit 下拉，且没有原生 select", () => {
    const triggers = [...container.querySelectorAll<HTMLButtonElement>("button[aria-haspopup='menu']")];
    expect(triggers.map((button) => button.getAttribute("aria-label"))).toEqual(["API 配置", "模型"]);
    expect(container.textContent).toContain("API 与模型");
    expect(container.querySelector("select")).toBeNull();
  });

  it("默认显示回退项，选中后经通用通道 setHostSettings 写回", () => {
    const profileTrigger = container.querySelector<HTMLButtonElement>("button[aria-label='API 配置']")!;
    expect(profileTrigger.textContent).toContain("跟随主会话");
    const profileItems = openMenu(profileTrigger);
    expect(profileItems).toHaveLength(3);
    expect(profileItems[0]!.textContent).toContain("跟随主会话");
    expect(profileItems[1]!.textContent).toContain("gateway");
    expect(profileItems[1]!.textContent).toContain("https://a.example/v1");
    act(() => profileItems[1]!.click());
    expect(updateHostSetting).toHaveBeenCalledWith({ superAgentProfile: "gateway" });

    const trigger = modelTrigger();
    expect(trigger.textContent).toContain("跟随所选 API 配置");
    const modelItems = openMenu(trigger);
    // 专用通道回包的列表（Alpha One / Delta Four）+ 活动配置自带的模型名
    // （alpha-1 已在回包里，不重复）。
    expect(modelItems).toHaveLength(3);
    expect(modelItems[0]!.textContent).toContain("跟随所选 API 配置");
    expect(modelItems[1]!.textContent).toContain("Alpha One");
    expect(modelItems[1]!.textContent).toContain("alpha-1");
    expect(modelItems[2]!.textContent).toContain("Delta Four");
    act(() => modelItems[2]!.click());
    expect(updateHostSetting).toHaveBeenCalledWith({ superAgentModel: "delta-4" });
  });

  it("当前值不在候选列表里时补占位选项，下拉不会显示成空白", () => {
    hostSettings.superAgentProfile = "ghost";
    renderSuperTab();
    const profileTrigger = container.querySelector<HTMLButtonElement>("button[aria-label='API 配置']")!;
    expect(profileTrigger.textContent).toContain("ghost");
    const items = openMenu(profileTrigger);
    expect(items).toHaveLength(4);
    expect(items[3]!.textContent).toContain("ghost");
    expect(items[3]!.textContent).toContain("找不到这个 API 配置");
  });

  it("当前选中的模型不在专用通道回包里时补占位选项", () => {
    hostSettings.superAgentModel = "legacy-model";
    superProfileModelsView.current = {
      profileName: "gateway",
      models: [{ id: "alpha-1", name: "Alpha One" }],
      currentModelId: "legacy-model",
    };
    renderSuperTab();
    const trigger = modelTrigger();
    expect(trigger.textContent).toContain("legacy-model");
    const items = openMenu(trigger);
    const last = items[items.length - 1]!;
    expect(last.textContent).toContain("legacy-model");
    expect(last.textContent).toContain("当前模型不在列表里");
  });

  it("宿主解析出的 currentModelId 不在列表里时仍出现在候选中", () => {
    superProfileModelsView.current = {
      profileName: "gateway",
      models: [{ id: "alpha-1", name: "Alpha One" }],
      currentModelId: "resolved-9",
    };
    renderSuperTab();
    const items = openMenu(modelTrigger());
    expect(items.some((item) => item.textContent?.includes("resolved-9"))).toBe(true);
  });
});

describe("模型下拉的专用通道（按所选 API 配置拉取）", () => {
  it("挂载时按当前选择（空串 = 跟随主会话）请求模型列表", () => {
    // 走 store 的专用 action（它自增 requestId 并记录最近一次请求），UI 不直接
    // 拼 refreshSuperProfileModels —— 否则回包没有可配对的序号。
    expect(requestSuperProfileModels).toHaveBeenCalledWith("");
  });

  it("切换 API 配置后按新配置重拉模型列表", () => {
    hostSettings.superAgentProfile = "backup";
    renderSuperTab();
    expect(requestSuperProfileModels).toHaveBeenCalledWith("backup");
  });

  it("端点查询失败时显式呈现真实原因，不回退主会话的模型列表", () => {
    const reason = "模型列表查询失败（不回退内置目录）：connect ECONNREFUSED";
    superProfileModelsView.current = {
      profileName: "gateway",
      models: [],
      currentModelId: "",
      error: reason,
    };
    renderSuperTab();
    expect(container.textContent).toContain(reason);
    const items = openMenu(modelTrigger());
    // 只有「跟随所选配置」+ 活动配置自带的 alpha-1；不会出现主会话列表里的 gamma-3。
    expect(items.some((item) => item.textContent?.includes("gamma-3"))).toBe(false);
    expect(items.some((item) => item.textContent?.includes("alpha-1"))).toBe(true);
  });

  it("回包属于别的 API 配置时不拿它渲染（切换瞬间不串台）", () => {
    hostSettings.superAgentProfile = "backup";
    superProfileModelsView.current = {
      profileName: "gateway",
      models: [{ id: "gateway-only", name: "Gateway Only" }],
      currentModelId: "gateway-only",
    };
    renderSuperTab();
    // 这里只能证明 UI 的同源过滤（store 被 mock）；真正的丢弃判定见
    // test/super-profile-models-store.test.ts。
    const items = openMenu(modelTrigger());
    expect(items.some((item) => item.textContent?.includes("gateway-only"))).toBe(false);
    // 新配置自带的模型名已经补进候选，切换过程不会出现空白下拉。
    expect(items.some((item) => item.textContent?.includes("beta-2"))).toBe(true);
  });

  it("首次回包到达前显示加载提示，而不是静默留空", () => {
    superProfileModelsView.current = null;
    renderSuperTab();
    expect(container.textContent).toContain("正在连接并读取可用模型…");
  });

  it("端点返回 200 但没有任何模型时显式提示，而不是留空或一直转圈", () => {
    superProfileModelsView.current = {
      profileName: "gateway",
      models: [],
      currentModelId: "",
    };
    renderSuperTab();
    expect(container.textContent).toContain("该端点没有返回任何模型");
    // 不是加载态、也不是错误态。
    expect(container.textContent).not.toContain("正在连接并读取可用模型…");
  });

  it("空列表提示只在「成功但空」时出现：查询失败显示的是真实错误原因", () => {
    superProfileModelsView.current = {
      profileName: "gateway",
      models: [],
      currentModelId: "",
      error: "模型列表查询失败（不回退内置目录）：connect ECONNREFUSED",
    };
    renderSuperTab();
    expect(container.textContent).not.toContain("该端点没有返回任何模型");
    expect(container.textContent).toContain("ECONNREFUSED");
  });

  it("live 列表能证明选中模型已下架时显式提示降级（含 id 与回退目标），且不改写设置", () => {
    superProfileModelsView.current = {
      profileName: "gateway",
      models: [{ id: "live-a", name: "live-a" }],
      currentModelId: "gone-model",
      degraded: true,
      delistedModelId: "gone-model",
      degradedModelId: "live-a",
      degradedReason: "模型 gone-model 已不在当前可用列表中，已回退为 live-a",
    };
    renderSuperTab();
    const text = container.textContent ?? "";
    expect(text).toContain("gone-model");
    expect(text).toContain("live-a");
    expect(text).toContain("仅提示");
    // 降级只提示：不擅改用户的 superAgentModel。
    expect(updateHostSetting).not.toHaveBeenCalled();
  });

  it("live 为空 / 查询失败不构成下架证据：不显示任何降级提示（防误伤）", () => {
    superProfileModelsView.current = {
      profileName: "gateway",
      models: [],
      currentModelId: "",
    };
    renderSuperTab();
    expect(container.textContent).not.toContain("已不在当前可用列表中");
  });
});