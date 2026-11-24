// @vitest-environment jsdom
/**
 * Composer 的提示词档位（效率开关）分段控件。
 *
 * 三件事钉死：①默认档位「平稳」被选中，且没有模型（models 为空）时控件依然
 * 可见 —— 它刻意不在 `models.length > 0` 条件里；②点「速推」把
 * `efficiencyMode: "turbo"` 交给 updateHostSetting（宿主据此写用户设置）；
 * ③「平稳」只是值本身，UI 层不触发任何额外的 prompt 注入（注入在 host 侧，
 * 按档位变化决定），因此断言只落在取值上。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../webview/src/components/Composer";
import { initialSessionState, type SessionState } from "../shared/messages";

const mocked = vi.hoisted(() => ({
  send: vi.fn(),
  notify: vi.fn(),
  updateHostSetting: vi.fn(),
  state: undefined as SessionState | undefined,
  efficiencyMode: "steady" as "steady" | "turbo",
}));

const useChat = vi.hoisted(() =>
  Object.assign(
    <T,>(selector: (s: Record<string, unknown>) => T) =>
      selector({
        state: mocked.state,
        pending: null,
        send: mocked.send,
        beginPending: vi.fn(),
        notify: mocked.notify,
        composerDraftRequest: null,
        clearDraftRequest: vi.fn(),
        updateHostSetting: mocked.updateHostSetting,
        hostSettings: { efficiencyMode: mocked.efficiencyMode },
      }),
    { getState: () => ({ state: mocked.state, send: mocked.send, notify: mocked.notify }) },
  ),
);

vi.mock("../webview/src/store", () => ({ useChat }));
vi.mock("../webview/src/i18n", () => ({
  t: (s: string, ...args: unknown[]) => `${s}${args.length ? ` ${args.join(" ")}` : ""}`,
  modeDisplay: () => ({ label: "mode", desc: "" }),
}));

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

let root: Root;
let container: HTMLDivElement;

/** 没有模型的会话：用来证明档位控件不受 `models.length > 0` 门控。 */
function emptyModelState(): SessionState {
  const state = initialSessionState();
  state.status = "idle";
  state.sessionId = "s1";
  state.activeSessionId = "s1";
  state.models = [];
  state.currentModelId = null;
  return state;
}

function render(): void {
  act(() => root.render(<Composer />));
}

function group(): HTMLElement {
  const el = container.querySelector<HTMLElement>('[role="radiogroup"][aria-label="提示词档位"]');
  expect(el).toBeTruthy();
  return el!;
}

function option(label: string): HTMLButtonElement {
  const el = [...group().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (b) => b.textContent?.trim() === label,
  );
  expect(el, `缺少「${label}」选项`).toBeTruthy();
  return el!;
}

beforeEach(() => {
  mocked.state = emptyModelState();
  mocked.send.mockReset();
  mocked.notify.mockReset();
  mocked.updateHostSetting.mockReset();
  mocked.efficiencyMode = "steady";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Composer · 提示词档位（效率开关）", () => {
  it("没有模型时也渲染出档位控件，默认选中「平稳」", () => {
    render();
    expect(option("平稳").getAttribute("aria-checked")).toBe("true");
    expect(option("速推").getAttribute("aria-checked")).toBe("false");
  });

  it("点「速推」把 efficiencyMode: turbo 交给宿主设置", () => {
    render();
    act(() => option("速推").click());
    expect(mocked.updateHostSetting).toHaveBeenCalledWith({ efficiencyMode: "turbo" });
  });

  it("「平稳」就是取值本身，UI 层不发额外的注入指令", () => {
    mocked.efficiencyMode = "turbo";
    render();
    act(() => option("平稳").click());
    expect(mocked.updateHostSetting).toHaveBeenCalledWith({ efficiencyMode: "steady" });
    // 注入逻辑在 host 侧；webview 只发设置补丁，不发任何 prompt / 注入消息。
    for (const call of mocked.send.mock.calls) {
      expect(call[0]).not.toMatchObject({ type: "setHostSettings" });
    }
  });

  it("窄面板降级：外层包裹声明 @max-[360px]:hidden", () => {
    render();
    const wrapper = group().parentElement!;
    expect(wrapper.className).toContain("@max-[360px]:hidden");
  });
});
