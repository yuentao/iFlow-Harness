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

const updateHostSetting = vi.hoisted(() => vi.fn());
/** 宿主尚未把这两个字段接进 `HostSettingsUi`（host 侧子会话负责），这里用与
 * webview 相同的「可选扩展视图」模拟「已接线」与「未接线」两种状态。 */
type SuperAgentEndpointUi = { superAgentProfile?: string; superAgentModel?: string };
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
    }) as unknown as HostSettingsUi & SuperAgentEndpointUi,
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
  models: [
    { id: "alpha-1", name: "Alpha One" },
    { id: "gamma-3", name: "Gamma Three" },
  ],
}));

vi.mock("../webview/src/store", () => ({
  useChat: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ send: vi.fn(), updateHostSetting, hostSettings, state }),
    { getState: () => ({ send: vi.fn(), updateHostSetting, hostSettings, state }) },
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

beforeEach(() => {
  updateHostSetting.mockClear();
  hostSettings.superAgentProfile = "";
  hostSettings.superAgentModel = "";
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

    const modelTrigger = container.querySelector<HTMLButtonElement>("button[aria-label='模型']")!;
    expect(modelTrigger.textContent).toContain("跟随所选 API 配置");
    const modelItems = openMenu(modelTrigger);
    // 当前会话可见的模型 + 各 API 配置自带的模型名。
    expect(modelItems).toHaveLength(4);
    expect(modelItems[0]!.textContent).toContain("跟随所选 API 配置");
    expect(modelItems[1]!.textContent).toContain("Alpha One");
    expect(modelItems[1]!.textContent).toContain("alpha-1");
    expect(modelItems[3]!.textContent).toContain("beta-2");
    act(() => modelItems[2]!.click());
    expect(updateHostSetting).toHaveBeenCalledWith({ superAgentModel: "gamma-3" });
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
});
