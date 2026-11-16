// @vitest-environment jsdom
/**
 * 委派成功 → 飞入看板动效（SuperDelegationFly）。
 *
 * 钉住的关键契约：
 *  - 触发信号是**当前主会话** superSessions 新增的非 restored id，不是 toast；
 *  - 同一批 N 个只合成一个飞入体（徽标显示 N），飞行中不再叠第二个；
 *  - 起点取委派卡（data-super-delegation-origin），终点取看板控件 rect；
 *  - reduced-motion 直接跳过，pointer-events:none + aria-hidden 不挡点击；
 *  - 抵达高亮有时限，定时器在卸载时清理，不留悬挂节点。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuperSessionUi } from "../shared/super-agent";
import { SuperAgentBoard } from "../webview/src/components/SuperAgentBoard";
import { DELEGATION_ORIGIN_ATTR } from "../webview/src/components/SuperDelegationFly";

const store = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../webview/src/store", () => ({
  useChat: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(store.current),
    { getState: () => store.current },
  ),
}));

const translate = vi.hoisted(() =>
  vi.fn((s: string, ...args: Array<string | number>) => {
    let out = s;
    args.forEach((arg, i) => {
      out = out.replaceAll(`{${i}}`, String(arg));
    });
    return out;
  }),
);
vi.mock("../webview/src/i18n", () => ({ t: translate }));

const send = vi.fn();

function session(id: string, overrides: Partial<SuperSessionUi> = {}): SuperSessionUi {
  return {
    id,
    title: `任务 ${id}`,
    task: `任务书 ${id}`,
    status: "preparing",
    isolation: { kind: "git_worktree", path: "/tmp/wt", branch: `iflow/super/${id}`, baseRef: "abc" },
    createdAt: 1000,
    updatedAt: 1000,
    reports: [],
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;
let reduced = false;

class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  reduced = false;
  send.mockReset();
  translate.mockClear();
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = Observer;
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = Observer;
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: reduced && query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  // jsdom 的 rect 全是 0；给起点/终点一个可断言的几何，验证 dx/dy 由 rect 推导。
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.hasAttribute(DELEGATION_ORIGIN_ATTR)) {
      return { left: 100, top: 200, width: 40, height: 20, right: 140, bottom: 220, x: 100, y: 200, toJSON: () => ({}) } as DOMRect;
    }
    if (this.getAttribute("aria-label") === "子会话看板") {
      return { left: 400, top: 10, width: 120, height: 28, right: 520, bottom: 38, x: 400, y: 10, toJSON: () => ({}) } as DOMRect;
    }
    return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.querySelectorAll('[data-testid="super-delegation-fly"]').forEach((el) => el.remove());
  document.querySelectorAll("[data-super-delegation-origin]").forEach((el) => el.remove());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setStore(sessions: SuperSessionUi[], activeSessionId: string | null = "main-1"): void {
  store.current = {
    state: { superSessions: sessions, activeSessionId },
    superTranscripts: {},
    send,
  };
}

function render(sessions: SuperSessionUi[], activeSessionId: string | null = "main-1"): void {
  setStore(sessions, activeSessionId);
  act(() => root.render(<SuperAgentBoard />));
}

/** 模拟转录里已经渲染出来的委派卡（真实由 SuperDirectiveCard 挂标记）。 */
function addOriginCard(): void {
  const card = document.createElement("div");
  card.setAttribute(DELEGATION_ORIGIN_ATTR, "");
  document.body.append(card);
}

function fly(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-testid="super-delegation-fly"]');
}

function boardControl(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('button[aria-label="子会话看板"]');
  expect(el).toBeTruthy();
  return el!;
}

describe("委派成功飞入看板", () => {
  it("新子会话出现时飞一次：起点委派卡 → 终点看板控件，带 count 徽标", () => {
    render([]);
    addOriginCard();
    expect(fly()).toBeNull();

    setStore([session("a")]);
    act(() => root.render(<SuperAgentBoard />));

    const el = fly();
    expect(el).toBeTruthy();
    expect(el!.getAttribute("aria-hidden")).toBe("true");
    // 组件用 styles.css 的 .super-delegation-fly 承载 pointer-events:none。
    expect(el!.classList.contains("super-delegation-fly")).toBe(true);
    expect(el!.querySelector('[data-testid="super-delegation-fly-count"]')?.textContent).toBe("1");
    // 起点中心 (120,210)，终点中心 (460,24) → dx=340 / dy=-186。
    expect(el!.style.getPropertyValue("--fly-dx")).toBe("340px");
    expect(el!.style.getPropertyValue("--fly-dy")).toBe("-186px");
  });

  it("同一批 3 个只合成一个飞入体，徽标显示 3", () => {
    render([]);
    addOriginCard();
    setStore([session("a"), session("b"), session("c")]);
    act(() => root.render(<SuperAgentBoard />));

    expect(document.querySelectorAll('[data-testid="super-delegation-fly"]').length).toBe(1);
    expect(fly()!.querySelector('[data-testid="super-delegation-fly-count"]')?.textContent).toBe("3");
    // 飞行中再来一个 id，不叠第二个、不刷屏。
    setStore([session("a"), session("b"), session("c"), session("d")]);
    act(() => root.render(<SuperAgentBoard />));
    expect(document.querySelectorAll('[data-testid="super-delegation-fly"]').length).toBe(1);
    expect(fly()!.querySelector('[data-testid="super-delegation-fly-count"]')?.textContent).toBe("3");
  });

  it("reduced-motion 直接跳过飞入", () => {
    reduced = true;
    render([]);
    addOriginCard();
    setStore([session("a")]);
    act(() => root.render(<SuperAgentBoard />));
    expect(fly()).toBeNull();
  });

  it("restored 历史子会话不触发", () => {
    render([]);
    addOriginCard();
    setStore([session("old", { restored: true })]);
    act(() => root.render(<SuperAgentBoard />));
    expect(fly()).toBeNull();
  });

  it("切换主会话不误触发（新 id 属于另一会话名册）", () => {
    render([session("a")], "main-1");
    addOriginCard();
    setStore([session("b")], "main-2");
    act(() => root.render(<SuperAgentBoard />));
    expect(fly()).toBeNull();
  });

  it("抵达后高亮控件、飞入体自动卸载；卸载组件清理定时器", () => {
    vi.useFakeTimers();
    render([]);
    addOriginCard();
    setStore([session("a")]);
    act(() => root.render(<SuperAgentBoard />));
    expect(fly()).toBeTruthy();

    // animationend 不会在 jsdom 触发，兜底定时器负责卸载并回调抵达。
    act(() => vi.advanceTimersByTime(820));
    expect(fly()).toBeNull();
    expect(boardControl().classList.contains("super-board-received")).toBe(true);

    act(() => vi.advanceTimersByTime(500));
    expect(boardControl().classList.contains("super-board-received")).toBe(false);
  });

  it("飞行途中组件卸载不会留下飞入体或悬挂定时器", () => {
    vi.useFakeTimers();
    render([]);
    addOriginCard();
    setStore([session("a")]);
    act(() => root.render(<SuperAgentBoard />));
    expect(fly()).toBeTruthy();

    act(() => root.unmount());
    expect(fly()).toBeNull();
    // 定时器应被 effect cleanup 清掉；推进时间不应抛 act 警告或复活元素。
    act(() => vi.advanceTimersByTime(2000));
    expect(fly()).toBeNull();
  });

  it("样式契约：飞入体不挡点击，reduced-motion 下隐藏", () => {
    // 用与 ui-kit-guard 相同的静态扫描思路钉住 CSS 行为（jsdom 不执行 CSS）。
    const css = readFileSync(join(process.cwd(), "webview/src/styles.css"), "utf8");
    expect(css).toMatch(
      /\.super-delegation-fly\s*\{[^}]*pointer-events:\s*none/s,
    );
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.super-delegation-fly\s*\{\s*display:\s*none/s,
    );
  });

  it("轨迹分三层：外层 X / 中层 Y / 内层缩放淡出，徽标仍在可见体里", () => {
    render([]);
    addOriginCard();
    setStore([session("a")]);
    act(() => root.render(<SuperAgentBoard />));

    const el = fly();
    expect(el).toBeTruthy();
    // 三层嵌套：外层样式容器 → 抛体上升层 → 可见体。
    const rise = el!.querySelector<HTMLElement>('[data-testid="super-delegation-fly-rise"]');
    expect(rise).toBeTruthy();
    expect(rise!.classList.contains("super-delegation-fly-rise")).toBe(true);
    const body = rise!.querySelector<HTMLElement>(".super-delegation-fly-body");
    expect(body).toBeTruthy();
    expect(body!.querySelector('[data-testid="super-delegation-fly-count"]')?.textContent).toBe("1");
    // 起点/终点坐标仍写在最外层，供两层 transform 各自读取（组件 API 不变）。
    expect(el!.style.getPropertyValue("--fly-dx")).toBe("340px");
    expect(el!.style.getPropertyValue("--fly-dy")).toBe("-186px");
  });

  it("轨迹契约：X/Y 分轴使用不同缓动合成抛物线（非直线），时长与 FLY_DURATION_MS 一致", () => {
    const css = readFileSync(join(process.cwd(), "webview/src/styles.css"), "utf8");
    // X 只位移 --fly-dx，且用 linear（匀速水平）。
    expect(css).toMatch(
      /@keyframes super-delegation-fly-x\s*\{[\s\S]*?transform:\s*translate3d\(var\(--fly-dx\),\s*0,\s*0\)/,
    );
    expect(css).toMatch(
      /\.super-delegation-fly\s*\{[^}]*animation:\s*super-delegation-fly-x 0\.64s linear both/s,
    );
    // Y 只位移 --fly-dy，且用 ease-out-quad（抛体缓出），与 X 的 linear 不同。
    expect(css).toMatch(
      /@keyframes super-delegation-fly-rise\s*\{[\s\S]*?transform:\s*translate3d\(0,\s*var\(--fly-dy\),\s*0\)/,
    );
    expect(css).toMatch(
      /animation:\s*super-delegation-fly-rise 0\.64s cubic-bezier\(0\.25,\s*0\.46,\s*0\.45,\s*0\.94\) both/,
    );
    // 三层动画都必须是 0.64s，和组件常量同步；旧的直线关键帧已移除。
    expect(css).toMatch(/animation:\s*super-delegation-fly-body 0\.64s/);
    expect(css).not.toMatch(/@keyframes super-delegation-fly\s*\{/);
  });
});
