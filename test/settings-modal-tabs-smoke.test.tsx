// @vitest-environment jsdom
/**
 * `SettingsModal` 全 tab 渲染 smoke。
 *
 * 目的不是替代既有分区测试（那些逐控件断言取值/写回），而是**最早暴露
 * 「组件新订阅了 store 成员、但 mock 没提供」**这一类回归：0cbaee9 给 store
 * 加了 `requestSuperProfileModels` / `superProfileModelsView`，超流体页挂载即
 * `TypeError`，两个旧测试共 19 个用例一次性全红。这里用共享工厂
 * (`test/helpers/store-mock.ts`) 建一份覆盖 ChatStore 完整表面的 mock，再把 9
 * 个 tab 依次激活一遍：任何漏掉的成员都会在挂载/切换时当场抛错。
 *
 * 断言刻意保持粗粒度：tab 能切、panel 存在且非空、超流体页真的调到了专用
 * 模型列表 action。内容层面的对账仍归各分区自己的测试。
 */
import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsModal, type SettingsTab } from "../webview/src/components/SettingsModal";
import { setLocale } from "../webview/src/i18n";
import type { AuthUiState } from "../shared/messages";
import type { StoreMock } from "./helpers/store-mock";

/** jsdom ships neither ResizeObserver nor scrollIntoView; the settings shell and
 * the kit's menus only need the members to exist. */
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
/** jsdom has no layout, so `offsetParent` is always null and focus/menu scans
 * would filter everything out (same shim as test/ui-kit-guard.test.ts). */
Object.defineProperty(HTMLElement.prototype, "offsetParent", {
  configurable: true,
  get: () => document.body,
});
/** React 19 refuses `act()` unless the environment declares itself act-capable. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 工厂实例槽位。`vi.mock` 工厂被提升到 import 之前、并在首次 import store 时
 * 执行，所以只能用 `vi.hoisted` 的东西接住实例（`StoreMock` 是纯类型导入，
 * 编译后消失，不涉及 TDZ）。用法说明见 test/helpers/store-mock.ts 顶部注释。
 */
const storeMock = vi.hoisted(() => ({ current: null as unknown as StoreMock }));
vi.mock("../webview/src/store", async () => {
  const { createStoreMock } = await import("./helpers/store-mock");
  const mock = createStoreMock();
  storeMock.current = mock;
  return mock;
});

/** import 阶段工厂已执行完，模块体里可以安全取用同一批 vi.fn。 */
const actions = storeMock.current.actions;

const TABS: SettingsTab[] = [
  "api",
  "chat",
  "appearance",
  "mcp",
  "memory",
  "assets",
  "super",
  "qq",
  "runtime",
];

const BASIC_AUTH: AuthUiState = {
  authenticated: true,
  needsSetup: false,
  saved: null,
  profiles: [],
  onboardingDismissed: true,
};

/** 受控壳：让点击 tab 按钮真的切页（证明导航 → 内容联动，而不是只换 prop）。 */
function Harness(): ReactElement {
  const [tab, setTab] = useState<SettingsTab>("api");
  return createElement(SettingsModal, {
    tab,
    onTabChange: setTab,
    onDismiss: () => {},
    dismissible: true,
    busy: false,
    auth: BASIC_AUTH,
  });
}

let root: Root;
let container: HTMLDivElement;

function tabButton(id: SettingsTab): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(`#settings-tab-${id}`);
  expect(el, `找不到 tab 按钮「${id}」`).toBeTruthy();
  return el!;
}

function activate(id: SettingsTab): void {
  act(() => tabButton(id).click());
}

/** 该 tab 已激活、panel 存在且渲染出了内容。 */
function expectActivePanel(id: SettingsTab): void {
  const button = tabButton(id);
  expect(button.getAttribute("aria-selected"), `${id}: tab 未激活`).toBe("true");
  const panel = container.querySelector<HTMLElement>('[role="tabpanel"]');
  expect(panel, `${id}: 缺少 tabpanel`).toBeTruthy();
  expect(panel!.getAttribute("aria-label")).toBe(button.textContent);
  expect(panel!.childElementCount, `${id}: panel 内容为空`).toBeGreaterThan(0);
}

beforeEach(() => {
  setLocale("zh-cn");
  // 只回滚「覆盖生效」用例改过的键；其余默认视图全文件只读。
  storeMock.current.set({ hostSettings: { theme: "auto" } });
  actions.requestSuperProfileModels.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(createElement(Harness)));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setLocale("zh-cn");
});

describe("SettingsModal 全 tab smoke", () => {
  it("渲染出 9 个 tab 按钮，默认停在 api 页", () => {
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(9);
    expectActivePanel("api");
  });

  it.each(TABS)("切到 %s 能渲染（不抛错、panel 非空）", (tab) => {
    if (tab !== "api") activate(tab);
    expectActivePanel(tab);
  });

  it("在同一实例里连续切完 9 个 tab 不崩（卸载/重挂不残留）", () => {
    for (const tab of TABS) {
      activate(tab);
      expectActivePanel(tab);
    }
  });

  it("超流体页挂载即调用专用模型列表 action（19 用例回归的原始现场）", () => {
    activate("super");
    expect(actions.requestSuperProfileModels).toHaveBeenCalled();
    // 空串 = 跟随主会话；组件应把当前选择原样传下去。
    expect(actions.requestSuperProfileModels).toHaveBeenCalledWith("");
  });

  it("工厂的 action 集合与 ChatStore 表面一致（少一个/多一个都会红）", () => {
    // 与 webview/src/store.ts 的 ChatStore 接口逐项对应（该接口没有导出，
    // 拿不到编译期链接；这份清单就是运行期的对账表）。
    const expected: Array<keyof typeof actions> = [
      "respondSuperResidueConfirm",
      "requestSuperResidueList",
      "handleSuperResidueAction",
      "updateHostSetting",
      "requestSuperProfileModels",
      "dismissToast",
      "notify",
      "setHeaderScrolled",
      "toggleFocusMode",
      "requestDraft",
      "clearDraftRequest",
      "requestMemoryDraft",
      "clearMemoryDraft",
      "applyHostMessage",
      "beginPending",
      "clearPending",
      "send",
    ];
    expect(Object.keys(actions).sort()).toEqual([...expected].sort());
    for (const name of expected) {
      expect(vi.isMockFunction(actions[name]), `${name} 不是 vi.fn()`).toBe(true);
    }
  });

  it("set() 深合并 hostSettings：只改目标键，其它默认值不丢", () => {
    storeMock.current.set({ hostSettings: { theme: "dark" } });
    const { hostSettings } = storeMock.current.getState();
    expect(hostSettings.theme).toBe("dark");
    expect(hostSettings.superAgentMaxAttempts).toBe(2);
    expect(hostSettings.uiFontSize).toBe("standard");
  });
});
