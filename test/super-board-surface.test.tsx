// @vitest-environment jsdom
/**
 * Super Agent board — header control + popup panel (structure and material).
 *
 * The board used to float over the scrolling transcript (an absolute overlay
 * with `.super-board-surface`). It is now part of the header: collapsed it is
 * one 28px inline control after the status chip; expanded it opens a popup
 * panel anchored under the header (`absolute top-full`).
 *
 * These cases pin the STRUCTURE + MATERIAL contract, not the pixels:
 *  - the collapsed control is a header-height neutral pill (surface tint,
 *    border, single hover surface) — not an acrylic overlay;
 *  - the expanded panel uses the popup acrylic tint (`.acrylic-pop`), NOT
 *    `.super-board-surface`: the panel lives inside the acrylic header, which
 *    is a backdrop root, so its own backdrop-filter could only sample the
 *    header subtree (the transcript text would ghost through sharp — the same
 *    trap documented on `.acrylic-pop`);
 *  - the panel keeps the panel-sized drop, the rounded/overflow-clipped box,
 *    the stream-in entrance and the header-anchored position.
 *
 * The old `.super-board-surface` stylesheet rules were removed with the
 * overlay (dead CSS — nothing references the class any more); `.acrylic-pop`
 * already carries the near-opaque tint this panel needs.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuperSessionUi } from "../shared/super-agent";
import { App } from "../webview/src/App";
import { SuperAgentBoard } from "../webview/src/components/SuperAgentBoard";

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

function session(overrides: Partial<SuperSessionUi> = {}): SuperSessionUi {
  return {
    id: "super-1",
    title: "修复登录跳转",
    task: "修好 src/auth.ts 的登录跳转并补单测",
    status: "running",
    isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/a", baseRef: "abc" },
    createdAt: 1000,
    updatedAt: 1000,
    reports: [],
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  send.mockReset();
  translate.mockClear();
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = Observer;
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = Observer;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(sessions: SuperSessionUi[] = [session()]): void {
  store.current = { state: { superSessions: sessions }, superTranscripts: {}, send };
  act(() => root.render(<SuperAgentBoard />));
}

/** Collapsed form: the one inline control in the header. */
function control(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('button[aria-label="展开子会话看板"]');
  expect(el).toBeTruthy();
  return el!;
}

/** Expanded form: the popup panel (labeled region) — null while collapsed. */
function panel(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="region"][aria-label="子会话"]');
}

function panelRoot(): HTMLElement {
  const el = panel();
  expect(el).toBeTruthy();
  return el!;
}

function expand(): void {
  act(() => control().click());
}

describe("Super Agent 看板表面材质", () => {
  it("折叠控件是顶栏内的中性控件，不再是亚克力浮层", () => {
    render();
    const el = control();
    // Header control species: 28px tall, control radius, neutral field tint.
    expect(el.classList.contains("h-7")).toBe(true);
    expect(el.classList.contains("rounded-md")).toBe(true);
    expect(el.classList.contains("border-border/70")).toBe(true);
    expect(el.classList.contains("bg-surface/60")).toBe(true);
    // The old floating-shelf material is gone from the collapsed form.
    expect(el.classList.contains("super-board-surface")).toBe(false);
    expect(el.classList.contains("shadow-panel")).toBe(false);
  });

  it("展开面板走弹层亚克力材质（在亚克力 header 内，自带 blur 会失效）", () => {
    render();
    expect(panel()).toBeNull();

    expand();
    const el = panelRoot();
    expect(el.classList.contains("acrylic-pop")).toBe(true);
    // Nested inside the acrylic header → its own backdrop-filter could only
    // sample the header subtree and the transcript text would ghost through
    // sharp, so the near-opaque popup tint carries readability instead.
    expect(el.classList.contains("super-board-surface")).toBe(false);
    expect(el.classList.contains("bg-card")).toBe(false);
  });

  it("展开面板锚定在 header 下方，保留入场动画、圆角裁切与留白", () => {
    render();
    expand();
    const el = panelRoot();
    for (const cls of [
      "absolute",
      "top-full",
      "inset-x-3",
      "z-40",
      "mt-2",
      "stream-in",
      "overflow-hidden",
      "rounded-lg",
    ]) {
      expect(el.classList.contains(cls)).toBe(true);
    }
    // Body keeps the breathing room: px-3 py-2 on the scroll container.
    const body = el.lastElementChild as HTMLElement;
    expect(body.className).toContain("px-3");
    expect(body.className).toContain("py-2");
    expect(body.className).toContain("divide-y");
  });
});

describe("Super Agent 看板阶段轨", () => {
  /** 行触发器（状态 + 标题 + 耗时那一行）。 */
  function rowButton(title = "修复登录跳转"): HTMLButtonElement {
    const el = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      (b.textContent ?? "").includes(title),
    );
    expect(el).toBeTruthy();
    return el!;
  }

  /** 展开某一行（阶段轨只在行展开后出现）。 */
  function openRow(title = "修复登录跳转"): void {
    act(() => rowButton(title).click());
  }

  function rails(): NodeListOf<HTMLElement> {
    return container.querySelectorAll<HTMLElement>('[role="img"][aria-label^="阶段轨："]');
  }

  /** 阶段轨元素：只在展开后出现，且恰好一个。 */
  function rail(): HTMLElement {
    const all = rails();
    expect(all).toHaveLength(1);
    return all[0]!;
  }

  /** 轨上的圆点（每个真实节点一个）。 */
  function dots(): HTMLElement[] {
    return Array.from(rail().querySelectorAll<HTMLElement>(".rounded-full"));
  }

  /** 节点文案（标签在 DOM 里常驻，窄容器只是被 CSS 隐藏）。 */
  function labels(): HTMLElement[] {
    return Array.from(rail().querySelectorAll<HTMLElement>("span.text-ui-micro"));
  }

  it("折叠行只报状态，阶段轨只在展开后出现一次", () => {
    render([session({ startedAt: 2000, updatedAt: 3000 })]);
    expand();

    // 折叠：单行只有状态 + 标题 + 耗时，没有任何阶段轨。
    expect(rails()).toHaveLength(0);
    expect(rowButton().textContent).toContain("运行中");

    openRow();
    // 展开：阶段轨恰好一条（不再渲染两条，也不重复状态 chip）。
    expect(rails()).toHaveLength(1);
    expect(rowButton().textContent).toContain("运行中");
  });

  it("只画真实发生过的节点，末节点带当前高亮", () => {
    render([session({ startedAt: 2000, updatedAt: 3000 })]);
    expand();
    openRow();

    const rail = container.querySelector<HTMLElement>('[role="img"][aria-label^="阶段轨："]');
    expect(rail).toBeTruthy();
    // 派发（createdAt 恒有）+ 启动（startedAt 存在）——没有「收尾」「完成」这种
    // 尚未发生的占位节点。
    expect(rail!.getAttribute("aria-label")).toContain("派发");
    expect(rail!.getAttribute("aria-label")).toContain("启动");
    expect(rail!.getAttribute("aria-label")).not.toContain("已完成");

    const dots = rail!.querySelectorAll(".rounded-full");
    expect(dots).toHaveLength(2);
    // 已发生=实心（静音色），当前=主色 + ring 高亮。
    expect(dots[0]!.className).toContain("bg-muted-foreground/60");
    expect(dots[1]!.className).toContain("bg-primary");
    expect(dots[1]!.className).toContain("ring-2");
  });

  it("queued：出现排队节点且为当前高亮（信息色）", () => {
    render([session({ status: "preparing", queued: true })]);
    expand();
    openRow();

    const described = rail().getAttribute("aria-label")!;
    expect(described).toContain("排队");
    // 还没启动：没有「启动」节点。
    expect(described).not.toContain("启动");

    const all = dots();
    expect(all).toHaveLength(2);
    expect(all[1]!.className).toContain("bg-info");
    expect(all[1]!.className).toContain("ring-2");

    const last = labels().at(-1)!;
    expect(last.textContent).toBe("排队");
    expect(last.className).toContain("text-info");
  });

  it("awaiting_input：等待应答是当前节点且用警告色", () => {
    render([
      session({
        status: "awaiting_input",
        startedAt: 2000,
        pending: {
          kind: "question",
          requestId: "q-1",
          questions: [],
          deadline: 305_000,
          timeoutMs: 300_000,
        },
      }),
    ]);
    // 有子会话在等应答时看板会自行展开（宿主 useEffect），但行详情仍需手动打开
    // ——阶段轨只在展开行里出现。
    openRow();

    const described = rail().getAttribute("aria-label")!;
    expect(described).toContain("等待应答");

    const all = dots();
    expect(all).toHaveLength(3);
    expect(all[2]!.className).toContain("bg-warning");
    expect(all[2]!.className).toContain("ring-2");

    const last = labels().at(-1)!;
    expect(last.textContent).toBe("等待应答");
    expect(last.className).toContain("text-warning");
  });

  it("completed + integration=merged：末节点是合并结果（完成态），且没有收尾占位", () => {
    render([
      session({
        status: "completed",
        startedAt: 2000,
        endedAt: 4000,
        integration: { mode: "merge", state: "merged", at: 5000 },
      }),
    ]);
    expand();
    // 已完成且改动已合并的子会话被折叠进「已完成的 N 个子会话」历史行。
    const foldedToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="展开已完成的子会话"]',
    );
    expect(foldedToggle).toBeTruthy();
    act(() => foldedToggle!.click());
    openRow();

    const described = rail().getAttribute("aria-label")!;
    expect(described).toContain("已完成");
    // 集成结果（derive 的既有文案「已自动合并」）排在终态节点之后 —— aria-label
    // 里每个节点后面还跟着时钟，所以用出现顺序而不是 endsWith。
    expect(described.lastIndexOf("已自动合并")).toBeGreaterThan(described.indexOf("已完成"));
    expect(described).not.toContain("收尾");

    const all = dots();
    expect(all).toHaveLength(4);
    // 终态没有「当前」节点：不该再有 ring 高亮。
    expect(all.some((dot) => dot.className.includes("ring-2"))).toBe(false);

    const last = labels().at(-1)!;
    expect(last.textContent).toBe("已自动合并");
    expect(last.className).toContain("text-muted-foreground");
    expect(last.className).not.toContain("text-destructive");
  });

  it("failed：末节点是失败且用错误色", () => {
    render([session({ status: "failed", error: "进程崩溃", startedAt: 2000, endedAt: 4000 })]);
    expand();
    openRow();

    const described = rail().getAttribute("aria-label")!;
    expect(described).toContain("失败");

    const all = dots();
    expect(all).toHaveLength(3);
    expect(all[2]!.className).toContain("bg-destructive");

    const last = labels().at(-1)!;
    expect(last.textContent).toBe("失败");
    expect(last.className).toContain("text-destructive");
  });

  it("running（无 endedAt）：轨上没有完成/收尾节点", () => {
    render([session({ startedAt: 2000, updatedAt: 3000 })]);
    expand();
    openRow();

    const described = rail().getAttribute("aria-label")!;
    for (const absent of ["已完成", "收尾", "失败", "已中断", "已自动合并"]) {
      expect(described).not.toContain(absent);
    }
    expect(labels().at(-1)!.textContent).toBe("启动");
  });
});

describe("Super Agent 看板时间轴 · 子会话 todolist", () => {
  const longTodo =
    "复核并汇报这一条特别长的中文任务描述，确认最后一条节点文本在任何窄屏下都完整可见而不是被硬裁掉";
  const todos = [
    { content: "读取现有实现", status: "completed" as const },
    { content: "改写时间轴组件", status: "in_progress" as const, priority: "high" as const },
    { content: "补充单元测试", status: "pending" as const },
    { content: longTodo, status: "pending" as const },
  ];

  function rail(): HTMLElement {
    const all = container.querySelectorAll<HTMLElement>('[role="img"][aria-label^="阶段轨："]');
    expect(all).toHaveLength(1);
    return all[0]!;
  }

  it("只画 todo 节点，最后一条长文本完整可见且不被字典改写", () => {
    render([session({ status: "running", startedAt: 2000, updatedAt: 3000, todos })]);
    expand();
    const row = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      (b.textContent ?? "").includes("修复登录跳转"),
    );
    expect(row).toBeTruthy();
    act(() => row!.click());

    const el = rail();
    // 目标：任何窄屏下都不硬裁 —— 换行而不是 overflow-hidden / max-w-[…] 截断。
    expect(el.className).not.toContain("overflow-hidden");
    expect(el.className).not.toContain("max-w-[");
    expect(el.className).toContain("flex-wrap");

    // 4 条 todo = 4 个圆点；阶段事实不再占节点。
    const dots = Array.from(el.querySelectorAll<HTMLElement>(".rounded-full"));
    expect(dots).toHaveLength(4);

    // 最后一条长文本完整出现在 DOM（不是省略号、不是被容器切掉）。
    const labels = Array.from(el.querySelectorAll<HTMLElement>("span.text-ui-micro"));
    const last = labels.at(-1)!;
    expect(last.textContent).toBe(longTodo);
    expect(last.className).toContain("break-words");
    expect(last.className).not.toContain("whitespace-nowrap");

    // 动态 todo 原文绝不过 i18n 字典（否则可能与字典 key 撞上被悄悄改写）。
    const keys = translate.mock.calls.map((call) => call[0]);
    for (const todo of todos) expect(keys).not.toContain(todo.content);
    // 静态状态词照常过字典（可翻译）。
    expect(keys).toContain("进行中");
    expect(keys).toContain("高优先级");

    // 阶段事实挪进 title / aria-label：派发、启动仍可查，todo 状态也在。
    const described = el.getAttribute("aria-label")!;
    expect(described).toContain("派发");
    expect(described).toContain("启动");
    expect(described).toContain("进行中");
    expect(described).toContain(longTodo);
  });
});

describe("Super Agent 看板子会话行 hover 表面", () => {
  function rowTrigger(title = "修复登录跳转"): HTMLButtonElement {
    const el = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      (b.textContent ?? "").includes(title),
    );
    expect(el).toBeTruthy();
    return el!;
  }

  const cls = (el: Element): string => el.getAttribute("class") ?? "";

  it("整行是唯一 hover 表面：行内只有一个元素带 hover:bg-accent", () => {
    render([session({ startedAt: 2000, updatedAt: 3000 })]);
    expand();

    const row = rowTrigger().parentElement as HTMLElement;
    expect(row).toBeTruthy();
    // 行容器持有行级高亮，数值不变。
    expect(cls(row)).toContain("hover:bg-accent/30");

    // 行自身 + 全部后代一起算，带 hover:bg-accent 的元素恰好一个（就是行）。
    const withAccent = [row, ...Array.from(row.querySelectorAll("*"))].filter((el) =>
      cls(el).includes("hover:bg-accent"),
    );
    expect(withAccent).toHaveLength(1);
    expect(withAccent[0]).toBe(row);

    // 行触发器不再自绘深一档的 hover。
    expect(cls(rowTrigger())).not.toContain("hover:bg-accent/60");
  });

  it("行内中断按钮不自绘底色，只保留 danger 文字色响应", () => {
    render([session({ startedAt: 2000, updatedAt: 3000 })]);
    expand();

    const row = rowTrigger().parentElement as HTMLElement;
    const cancel = row.querySelector<HTMLButtonElement>('button[aria-label="中断该子会话"]');
    expect(cancel).toBeTruthy();
    // 不出现第三层底色（danger 的 destructive/10 或任何 hover 背景）。
    expect(cls(cancel!)).not.toContain("hover:bg-");
    expect(cls(cancel!)).toContain("hover:text-destructive");
  });

  it("顶栏折叠控件是唯一 hover 表面（hover:bg-accent/40，内部不再叠第二层）", () => {
    render();
    const headerSwitch = control();
    expect(cls(headerSwitch)).toContain("hover:bg-accent/40");
    // 旧的 DisclosureButton 自绘档不再出现。
    expect(cls(headerSwitch)).not.toContain("hover:bg-accent/60");
    // 控件内部（图标、计数 chip、免确认徽标）没有自己的 hover 底色。
    const nested = [headerSwitch, ...Array.from(headerSwitch.querySelectorAll("*"))].filter((el) =>
      cls(el).includes("hover:bg-"),
    );
    expect(nested).toHaveLength(1);
    expect(nested[0]).toBe(headerSwitch);
  });
});

describe("Super Agent 看板并入顶栏（App 级结构）", () => {
  /** Full store shape App needs (same mock surface as super-waiting-busy). */
  function renderApp(sessions: SuperSessionUi[]): void {
    store.current = {
      state: {
        blocks: [],
        status: "idle",
        errorMessage: null,
        stopReason: null,
        sessionId: "s1",
        modes: null,
        commands: [],
        skills: [],
        models: [],
        currentModelId: null,
        thinkLevel: "auto",
        pendingApproval: null,
        pendingPlanExit: null,
        pendingQuestions: null,
        pendingProfileSwitch: null,
        auth: {
          authenticated: true,
          needsSetup: false,
          saved: null,
          profiles: [],
          onboardingDismissed: true,
        },
        sessions: [],
        activeSessionId: null,
        replaying: false,
        initializing: false,
        compressing: false,
        superWaiting: false,
        superSessions: sessions,
        queue: [],
        queuePaused: false,
        checkpoints: [],
        nextStepSuggestions: [],
        nextStepLoading: false,
      },
      send,
      toggleFocusMode: () => {},
      focusMode: false,
      headerScrolled: false,
      editorTheme: "light",
      pending: null,
      toasts: [],
      notify: () => {},
      dismissToast: () => {},
      clearMemoryDraft: () => {},
      memoryDraftRequest: null,
      superTranscripts: {},
      hostSettings: {
        theme: "light",
        auroraIntensity: 35,
        uiFontSize: "standard",
        uiDensity: "standard",
      },
    };
    act(() => root.render(<App />));
  }

  const boardControl = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>('button[aria-label="展开子会话看板"]');

  it("没有子会话时顶栏不渲染看板控件", () => {
    renderApp([]);
    expect(boardControl()).toBeNull();
  });

  it("折叠控件在 header 内，不再挂在转录顶部的绝对定位浮层里", () => {
    renderApp([session()]);
    const control = boardControl();
    expect(control).toBeTruthy();
    // 顶栏的一部分：header 里有它。
    expect(control!.closest("header")).toBeTruthy();
    // 旧的转录 overlay 壳（pointer-events-none absolute inset-x-0 top-0）已删除。
    expect(container.querySelector(".pointer-events-none.absolute.inset-x-0.top-0")).toBeNull();
    // 折叠态不渲染面板。
    expect(container.querySelector('[role="region"][aria-label="子会话"]')).toBeNull();
  });

  it("点击折叠控件展开面板，Esc 关闭面板", () => {
    renderApp([session()]);
    act(() => boardControl()!.click());
    const panel = container.querySelector<HTMLElement>('[role="region"][aria-label="子会话"]');
    expect(panel).toBeTruthy();
    // 面板挂在 header 下方（absolute top-full），不是转录 overlay。
    expect(panel!.className).toContain("top-full");
    expect(panel!.closest("header")).toBeTruthy();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector('[role="region"][aria-label="子会话"]')).toBeNull();
    // 控件本身仍在顶栏里（只收起，不消失）。
    expect(boardControl()).toBeTruthy();
  });

  it("窄屏只隐藏「子会话」文案，控件本身保留", () => {
    renderApp([session()]);
    const control = boardControl()!;
    const label = [...control.querySelectorAll("span")].find((span) => span.textContent === "子会话");
    expect(label).toBeTruthy();
    expect(label!.className).toContain("@max-[380px]:hidden");
  });
});
