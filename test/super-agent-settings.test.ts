// @vitest-environment jsdom
/**
 * Super Agent 重试策略设置的对账测试。
 *
 * 覆盖两件新设置（`iflow.superAgent.maxAttempts` / `iflow.superAgent.dependencyPolicy`）
 * 的三层一致性：
 *  1. manifest 声明（package.json 的 contributes.configuration）；
 *  2. 本地化占位（package.nls.json / package.nls.zh-cn.json，两个文件键集合必须一致）；
 *  3. 设置页 UI（webview 的「超流体」分组里真的渲染出这两个控件）。
 *
 * 纪律（AGENTS.md 陷阱 #14）：新增设置项必须「声明 → 实现」对账，绝不能声明了
 * 却没人用；这里把三层的键名、默认值与取值范围都钉死，避免以后漂移。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsModal } from "../webview/src/components/SettingsModal";
import { setLocale, t } from "../webview/src/i18n";
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

/** 仓库根（测试文件在 test/ 下）。 */
const REPO_ROOT = join(__dirname, "..");

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  contributes: { configuration: { properties: Record<string, Record<string, unknown>> } };
};
const nlsEn = JSON.parse(readFileSync(join(REPO_ROOT, "package.nls.json"), "utf8")) as Record<string, string>;
const nlsZh = JSON.parse(readFileSync(join(REPO_ROOT, "package.nls.zh-cn.json"), "utf8")) as Record<string, string>;

const properties = manifest.contributes.configuration.properties;

const send = vi.hoisted(() => vi.fn());
const updateHostSetting = vi.hoisted(() => vi.fn());
const hostSettings = vi.hoisted(() =>
  ({
    nextStepSuggestions: true,
    autoCompressOnIdle: false,
    autoMemoryCapture: false,
    autoTitle: true,
    memoryExtractTimeoutSeconds: 90,
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
    checkpointMaxFiles: 50_000,
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
    // 宿主尚未把这两个字段接进 HostSettingsUi（host 侧子会话负责），这里
    // 用可选字段模拟「已接线」与「未接线」两种状态。
    superAgentMaxAttempts: undefined as number | undefined,
    superAgentDependencyPolicy: undefined as string | undefined,
  }) as unknown as HostSettingsUi & { superAgentMaxAttempts?: number; superAgentDependencyPolicy?: string },
);

vi.mock("../webview/src/store", () => ({
  useChat: Object.assign(
    (selector: (state: {
      send: typeof send;
      updateHostSetting: typeof updateHostSetting;
      hostSettings: typeof hostSettings;
    }) => unknown) => selector({ send, updateHostSetting, hostSettings }),
    { getState: () => ({ send, updateHostSetting, hostSettings }) },
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

function renderChatTab(): void {
  act(() =>
    root.render(
      createElement(SettingsModal, {
        tab: "chat",
        onTabChange: () => {},
        onDismiss: () => {},
        dismissible: true,
        busy: false,
        auth: BASIC_AUTH,
      }),
    ),
  );
}

/** kit 的 CommitNumberInput 走「草稿 + blur 提交」：先派 input 改草稿值，
 * 再派 focusout 触发提交（React 的 onBlur 走 focusout）。 */
async function commitNumber(input: HTMLInputElement, raw: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, raw);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

function radio(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (el) => el.textContent === label,
  );
  expect(found, `找不到选项「${label}」`).toBeTruthy();
  return found!;
}

beforeEach(() => {
  send.mockReset();
  updateHostSetting.mockReset();
  hostSettings.superAgentMaxAttempts = undefined;
  hostSettings.superAgentDependencyPolicy = undefined;
  hostSettings.superAgentFullTrust = false;
  setLocale("zh-cn");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  renderChatTab();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setLocale("zh-cn");
});

describe("manifest 声明", () => {
  it("声明了 iflow.superAgent.maxAttempts（number，默认 2，范围 1–5）", () => {
    const entry = properties["iflow.superAgent.maxAttempts"];
    expect(entry).toBeTruthy();
    expect(entry!.type).toBe("number");
    expect(entry!.default).toBe(2);
    expect(entry!.minimum).toBe(1);
    expect(entry!.maximum).toBe(5);
  });

  it("声明了 iflow.superAgent.dependencyPolicy（string，默认 block，枚举 block/continue）", () => {
    const entry = properties["iflow.superAgent.dependencyPolicy"];
    expect(entry).toBeTruthy();
    expect(entry!.type).toBe("string");
    expect(entry!.default).toBe("block");
    expect(entry!.enum).toEqual(["block", "continue"]);
  });
});

describe("本地化占位", () => {
  it("两个 nls 文件都带这两个键，且键集合完全一致", () => {
    for (const key of [
      "iflow.configuration.superAgentMaxAttempts.description",
      "iflow.configuration.superAgentDependencyPolicy.description",
      "iflow.configuration.superAgentFullTrust.description",
    ]) {
      expect(nlsEn[key], `package.nls.json 缺 ${key}`).toBeTruthy();
      expect(nlsZh[key], `package.nls.zh-cn.json 缺 ${key}`).toBeTruthy();
    }
    expect(Object.keys(nlsEn).sort()).toEqual(Object.keys(nlsZh).sort());
  });

  it("superAgent 分组在 manifest 里用到的占位都能在两个 nls 文件里找到", () => {
    const placeholders = Object.entries(properties)
      .filter(([key]) => key.startsWith("iflow.superAgent."))
      .flatMap(([, entry]) => [entry.description, entry.markdownDescription])
      .filter((value): value is string => typeof value === "string");
    expect(placeholders.length).toBeGreaterThan(0);
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^%/, "").replace(/%$/, "");
      expect(nlsEn[key], `package.nls.json 缺 ${key}`).toBeTruthy();
      expect(nlsZh[key], `package.nls.zh-cn.json 缺 ${key}`).toBeTruthy();
    }
  });
});

describe("设置页 UI", () => {
  it("「超流体」分组渲染出最大尝试次数与依赖策略两个控件", () => {
    expect(container.textContent).toContain("最大尝试次数");
    expect(container.textContent).toContain("依赖策略");
  });

  it("最大尝试次数是 kit 的整数输入，默认 2、范围 1–5", () => {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="最大尝试次数"]');
    expect(input).toBeTruthy();
    expect(input!.type).toBe("number");
    expect(input!.min).toBe("1");
    expect(input!.max).toBe("5");
    expect(input!.value).toBe("2");
  });

  it("依赖策略是同屏二选一（radiogroup），默认选中「阻塞」", () => {
    const group = container.querySelector<HTMLElement>('[role="radiogroup"][aria-label="依赖策略"]');
    expect(group).toBeTruthy();
    expect(radio("阻塞").getAttribute("aria-checked")).toBe("true");
    expect(radio("继续").getAttribute("aria-checked")).toBe("false");
  });

  it("选「继续」把依赖策略写回宿主设置", () => {
    act(() => radio("继续").click());
    expect(updateHostSetting).toHaveBeenCalledWith({ superAgentDependencyPolicy: "continue" });
  });

  it("提交尝试次数时写回宿主设置，并把越界值钳到 1–5", async () => {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="最大尝试次数"]')!;
    await commitNumber(input, "9");
    expect(updateHostSetting).toHaveBeenCalledWith({ superAgentMaxAttempts: 5 });
    updateHostSetting.mockReset();
    await commitNumber(input, "0");
    expect(updateHostSetting).toHaveBeenCalledWith({ superAgentMaxAttempts: 1 });
  });

  it("宿主已经下发取值时，设置页显示宿主的值而不是默认值", () => {
    hostSettings.superAgentMaxAttempts = 3;
    hostSettings.superAgentDependencyPolicy = "continue";
    renderChatTab();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="最大尝试次数"]')!;
    expect(input.value).toBe("3");
    expect(radio("继续").getAttribute("aria-checked")).toBe("true");
  });

  it("「超流体」分组渲染出完全信任模式开关，默认关闭", () => {
    expect(container.textContent).toContain("完全信任模式");
    const toggle = container.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="完全信任模式"]');
    expect(toggle).toBeTruthy();
    expect(toggle!.getAttribute("aria-checked")).toBe("false");
  });

  it("风险提示始终可见", () => {
    expect(container.textContent).toContain(
      "开启后子会话可修改主仓文件、执行任意命令并推送/开 PR，仅在你完全信任派生任务时使用。",
    );
  });

  it("打开完全信任模式把取值写回宿主设置", () => {
    const toggle = container.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="完全信任模式"]')!;
    act(() => toggle.click());
    expect(updateHostSetting).toHaveBeenCalledWith({ superAgentFullTrust: true });
  });

  it("宿主已下发开启时，设置页显示为已开启", () => {
    hostSettings.superAgentFullTrust = true;
    renderChatTab();
    const toggle = container.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="完全信任模式"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("英文词典里有对应的英文文案", () => {
    setLocale("en-US");
    expect(t("最大尝试次数")).toBe("Max attempts");
    expect(t("依赖策略")).toBe("Dependency policy");
    expect(t("阻塞")).toBe("Block");
    expect(t("继续")).toBe("Continue");
    expect(t("完全信任模式")).toBe("Full trust mode");
  });
});
