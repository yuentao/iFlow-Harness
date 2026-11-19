// @vitest-environment jsdom
/**
 * Super Agent board — header control + popup panel (structure and material).
 *
 * The board used to float over the scrolling transcript (an absolute overlay
 * with `.super-board-surface`). It is now part of the header: collapsed it is
 * one 28px inline control after the status chip; expanded it opens a popup
 * panel anchored under the header.
 *
 * These cases pin the STRUCTURE + MATERIAL contract, not the pixels:
 *  - the collapsed control is a header-height neutral pill (surface tint,
 *    border, single hover surface) — not an acrylic overlay;
 *  - the expanded panel is PORTALED to document.body: it must sit OUTSIDE
 *    the acrylic header, which is a backdrop root — a panel inside it can
 *    only sample the header subtree, so the transcript text behind it
 *    ghosts through sharp (the trap documented on `.acrylic-pop`);
 *  - being outside every backdrop root, the panel carries the frosted
 *    material (`.acrylic-frosted`: translucent tint + a real backdrop blur)
 *    — the app's only true frosted surface;
 *  - the panel keeps the panel-sized drop, the rounded/overflow-clipped box,
 *    the stream-in entrance and the header-anchored position (viewport
 *    coordinates now — a portal has no CSS anchor).
 *
 * Because the panel lives on document.body, the panel-side assertions below
 * query the DOCUMENT (the React mount only holds the collapsed control).
 * The semantics of every assertion are unchanged.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  const el = container.querySelector<HTMLButtonElement>('button[aria-label="超流体看板"]');
  expect(el).toBeTruthy();
  return el!;
}

/**
 * Expanded form: the popup panel (labeled region) — null while collapsed.
 *
 * The panel is PORTALED to document.body, so it is queried on the document.
 */
function panel(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="region"][aria-label="超流体"]');
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

  /**
   * 呼吸感：这一粒控件曾经是「8px 内边距 + 全部 6px 行间距」的一整块密集
   * 元素（图标、文案、总数、三个状态 chip、免确认徽标、chevron 等距排开）。
   * 现在用两档间距——水平内边距 12px（布局间距 token，随 --ui-density 缩放）、
   * 簇间 10px（控件内部光学间距的上限）、簇内 6px——高度仍是 28px 单行档，
   * 顶栏节奏不变。
   */
  it("折叠控件用两档间距留出呼吸感：12px 内边距 / 10px 簇间 / 6px 簇内", () => {
    render([
      session({ id: "super-running", status: "running" }),
      session({ id: "super-awaiting", status: "awaiting_input" }),
      session({ id: "super-failed", status: "failed", error: "进程崩溃" }),
    ]);
    const el = control();

    // 单行 28px 控件档：不靠 py-* 撑高，也不换行。
    expect(el.classList.contains("h-7")).toBe(true);
    expect(el.className).not.toMatch(/(^|\s)py-/);
    expect(el.classList.contains("flex-nowrap")).toBe(false);

    // 横向留白：内边距 12px（px-3），行间距 10px（gap-2.5）——不再是旧的
    // px-2 + gap-1.5。
    expect(el.classList.contains("px-3")).toBe(true);
    expect(el.classList.contains("gap-2.5")).toBe(true);
    expect(el.classList.contains("px-2")).toBe(false);
    expect(el.classList.contains("gap-1.5")).toBe(false);

    // 两个簇各自用 6px 光学间距：身份簇（图标 + 文案 + 总数）与状态 chip 簇。
    const clusters = [...el.children].filter(
      (child): child is HTMLElement =>
        child.tagName === "SPAN" && child.classList.contains("gap-1.5"),
    );
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.querySelector("svg")).toBeTruthy();
    expect(clusters[0]!.textContent).toContain("超流体");
    expect(clusters[0]!.textContent).toContain("3");
    // 运行中 / 待处理 / 未成功各一个 chip（aria-label 让 chip 带 role="img"）。
    expect(clusters[1]!.querySelectorAll('[role="img"]')).toHaveLength(3);

    // 簇之外只剩免确认徽标与 chevron（可访问名不变）。
    const inFlow = [...el.children].filter(
      (child) => !child.classList.contains("super-entry-glow"),
    );
    expect(inFlow).toHaveLength(4);
    expect(inFlow.at(-1)!.tagName.toLowerCase()).toBe("svg");
    expect(el.getAttribute("aria-label")).toBe("超流体看板");
  });

  it("没有任何运行中/待处理/未成功时状态簇整体不渲染（不留一段空行间距）", () => {
    render([session({ status: "completed", endedAt: 4000 })]);
    const el = control();
    const clusters = [...el.children].filter(
      (child): child is HTMLElement =>
        child.tagName === "SPAN" && child.classList.contains("gap-1.5"),
    );
    // 只剩身份簇；状态簇连壳都不在，簇间 10px 不会因为空簇多算一次。
    expect(clusters).toHaveLength(1);
    expect(el.textContent).not.toContain("个进行中");
  });

  it("展开面板走真亚克力材质（portal 出 header，自带 backdrop blur）", () => {
    render();
    expect(panel()).toBeNull();

    expand();
    const el = panelRoot();
    // 真亚克力：半透明底 + backdrop blur（.acrylic-frosted）。旧的
    // .acrylic-pop 是近不透明底色且没有 blur —— 转录文字原样透出来，
    // 视觉很脏。
    expect(el.classList.contains("acrylic-frosted")).toBe(true);
    expect(el.classList.contains("acrylic-pop")).toBe(false);
    expect(el.classList.contains("super-board-surface")).toBe(false);
    expect(el.classList.contains("bg-card")).toBe(false);
  });

  it("展开面板 portal 到 document.body：不在 header 内，才能采到真 backdrop", () => {
    render();
    expand();
    const el = panelRoot();
    // Portal 宿主是 body（不是 header 的子树）。
    expect(el.parentElement).toBe(document.body);
    // 脱离 header 的 backdrop root —— 否则 blur 只能采到 header 子树，
    // 背后的转录文字会原样透出来。
    expect(el.closest("header")).toBeNull();
    // 折叠控件仍在原处（被移走的只有浮层）。
    expect(container.contains(control())).toBe(true);
  });

  it("展开面板锚定在 header 下方，保留入场动画、圆角裁切与留白", () => {
    render();
    expand();
    const el = panelRoot();
    // Portal 没有 CSS 锚点：面板改为 fixed + 视口坐标（left / right / top）。
    for (const cls of ["fixed", "z-35", "stream-in", "overflow-hidden", "rounded-lg"]) {
      expect(el.classList.contains(cls)).toBe(true);
    }
    // 旧的 CSS 锚点（top-full / inset-x-3）需要 header 当定位祖先，
    // portal 之后不再成立。
    expect(el.classList.contains("absolute")).toBe(false);
    expect(el.classList.contains("top-full")).toBe(false);
    expect(el.classList.contains("inset-x-3")).toBe(false);
    // 位置由内联样式给出：左右各留 12px 边距（与 header 的 px-3 一致），
    // 顶边贴着 header 下沿 + 8px 间隙。
    expect(el.style.left).toBe("12px");
    expect(el.style.right).toBe("12px");
    expect(el.style.top).toBe("8px");
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
    const el = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
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
    return document.body.querySelectorAll<HTMLElement>('[role="img"][aria-label^="阶段轨："]');
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

    const rail = document.body.querySelector<HTMLElement>('[role="img"][aria-label^="阶段轨："]');
    expect(rail).toBeTruthy();
    // 派发（createdAt 恒有）+ 启动（startedAt 存在）——没有「收尾」「完成」这种
    // 尚未发生的占位节点。
    expect(rail!.getAttribute("aria-label")).toContain("已派出");
    expect(rail!.getAttribute("aria-label")).toContain("已启动");
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
    expect(described).toContain("在等你回答");

    const all = dots();
    expect(all).toHaveLength(3);
    expect(all[2]!.className).toContain("bg-warning");
    expect(all[2]!.className).toContain("ring-2");

    const last = labels().at(-1)!;
    expect(last.textContent).toBe("在等你回答");
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
    const foldedToggle = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="展开已完成的超流体"]',
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
    expect(labels().at(-1)!.textContent).toBe("已启动");
  });
});

describe("Super Agent 看板时间轴 · 超流体 todolist", () => {
  const longTodo =
    "复核并汇报这一条特别长的中文任务描述，确认最后一条节点文本在任何窄屏下都完整可见而不是被硬裁掉";
  const todos = [
    { content: "读取现有实现", status: "completed" as const },
    { content: "改写时间轴组件", status: "in_progress" as const, priority: "high" as const },
    { content: "补充单元测试", status: "pending" as const },
    { content: longTodo, status: "pending" as const },
  ];

  function rail(): HTMLElement {
    const all = document.body.querySelectorAll<HTMLElement>('[role="img"][aria-label^="阶段轨："]');
    expect(all).toHaveLength(1);
    return all[0]!;
  }

  it("只画 todo 节点，最后一条长文本完整可见且不被字典改写", () => {
    render([session({ status: "running", startedAt: 2000, updatedAt: 3000, todos })]);
    expand();
    const row = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
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
    expect(described).toContain("已派出");
    expect(described).toContain("已启动");
    expect(described).toContain("进行中");
    expect(described).toContain(longTodo);
  });
});

describe("Super Agent 看板超流体行 hover 表面", () => {
  function rowTrigger(title = "修复登录跳转"): HTMLButtonElement {
    const el = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
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
    const cancel = row.querySelector<HTMLButtonElement>('button[aria-label="中断这个超流体"]');
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
  function renderApp(sessions: SuperSessionUi[], patch: Record<string, unknown> = {}): void {
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
        ...patch,
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
    container.querySelector<HTMLButtonElement>('button[aria-label="超流体看板"]');

  it("没有超流体时顶栏不渲染看板控件", () => {
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
    // 折叠态不渲染面板（整个文档里都没有）。
    expect(document.body.querySelector('[role="region"][aria-label="超流体"]')).toBeNull();
  });

  it("点击折叠控件展开面板，Esc 关闭面板", () => {
    renderApp([session()]);
    act(() => boardControl()!.click());
    const panel = document.body.querySelector<HTMLElement>('[role="region"][aria-label="超流体"]');
    expect(panel).toBeTruthy();
    // 面板 portal 到 body：不在 header 的子树里（header 的 backdrop root
    // 会让面板自己的 blur 采到 header 子树，背后的转录文字原样透出）。
    expect(panel!.parentElement).toBe(document.body);
    expect(panel!.closest("header")).toBeNull();
    // 真亚克力材质 + fixed 视口定位。
    expect(panel!.className).toContain("acrylic-frosted");
    expect(panel!.className).toContain("fixed");
    expect(panel!.style.top).toBe("8px");

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.querySelector('[role="region"][aria-label="超流体"]')).toBeNull();
    // 控件本身仍在顶栏里（只收起，不消失）。
    expect(boardControl()).toBeTruthy();
  });

  it("窄屏只隐藏「超流体」文案，控件本身保留", () => {
    renderApp([session()]);
    const control = boardControl()!;
    const label = [...control.querySelectorAll("span")].find((span) => span.textContent === "超流体");
    expect(label).toBeTruthy();
    expect(label!.className).toContain("@max-[380px]:hidden");
  });

  /**
   * jsdom 不做布局，offsetHeight 恒为 0 —— 按元素给出确定高度，让 App 的
   * 高度镜像 effect 走真实代码路径（不是假设值）。待答条与展开面板必须取
   * 不同的值，否则无法证明折叠态的变量来自 strip 自身。
   */
  function withStubHeights(run: () => void): void {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.getAttribute("aria-label") === "超流体待答问题") return 120;
        if (this.id === "super-board-panel") return 240;
        return 0;
      },
    });
    try {
      run();
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
    }
  }

  /** 承载 --super-bar-h 内联变量的元素（转录 wrapper）。 */
  const barHosts = () =>
    [...container.querySelectorAll<HTMLElement>("*")].filter(
      (el) => el.style.getPropertyValue("--super-bar-h") !== "",
    );
  const barValue = () => barHosts()[0]!.style.getPropertyValue("--super-bar-h");

  it("--super-bar-h：无待答折叠态不设置，展开时是面板高 + 16，收起后移除", () => {
    withStubHeights(() => {
      renderApp([session()]);

      // 折叠且没有待答条：控件在 header 里，转录顶部没有任何覆盖 → 不设置。
      expect(barHosts()).toHaveLength(0);

      act(() => boardControl()!.click());
      expect(barHosts()).toHaveLength(1);
      expect(barValue()).toBe("256px");

      act(() => boardControl()!.click());
      expect(barHosts()).toHaveLength(0);
    });
  });

  it("--super-bar-h：折叠 + 有待答条时是待答条高 + 16，转录按它预留顶部", () => {
    withStubHeights(() => {
      renderApp([askingSession()]);
      // 有待答子会话时看板自行展开；手动收起后待答条挂在 header 下方。
      act(() => boardControl()!.click());
      expect(document.body.querySelector('[role="region"][aria-label="超流体待答问题"]')).toBeTruthy();

      // 折叠态的 strip 同样镜像高度（旧实现为 0，转录首条与主会话提问卡
      // 因此无预留地盖住它）。
      expect(barHosts()).toHaveLength(1);
      expect(barValue()).toBe("136px");

      // 转录内容容器读的就是这个变量。jsdom 不解析继承的 var，因此断言
      // 「内联引用存在」+「变量宿主是它的祖先」，不伪造计算样式。
      const content = [...container.querySelectorAll<HTMLElement>("div")].find(
        (el) => el.style.paddingTop === "var(--super-bar-h, 0px)",
      );
      expect(content).toBeTruthy();
      expect(barHosts()[0]!.contains(content!)).toBe(true);

      // 再展开：strip 卸载、面板挂载，变量换成面板高度（同一 ref 不互覆盖）。
      act(() => boardControl()!.click());
      expect(barHosts()).toHaveLength(1);
      expect(barValue()).toBe("256px");
    });
  });

  it("--super-bar-h：看板完全卸载后变量被移除（不留残留）", () => {
    withStubHeights(() => {
      renderApp([askingSession()]);
      // 有待答子会话 → 面板挂载 → 转录顶部预留面板高度。
      expect(barHosts()).toHaveLength(1);
      expect(barValue()).toBe("256px");

      // 最后一个子会话消失（被清理 / 会话切换）→ 看板整体不渲染。
      renderApp([]);
      expect(boardControl()).toBeNull();
      expect(document.body.querySelector('[role="region"][aria-label="超流体"]')).toBeNull();
      // 卸载必须清掉变量：否则转录会一直留一条 334px 的空白。
      expect(barHosts()).toHaveLength(0);
    });
  });

  /**
   * 待处理卡浮层的类契约（多卡滚动回归 + 堆叠态）：≥2 张卡默认是堆叠态，
   * 贴底用 justify-end，**不是**滚动容器（顶卡可收缩，内容不会溢出）；
   * 展开成列表后必须回到滚动容器 + 首卡 `mt-auto` 做底部对齐，且滚动
   * 容器里**不能**用 justify-end —— flex-end 会把溢出到起始边之外的内容
   * 变成不可达。这条断言防的是「有人把 mt-auto 改回 justify-end」，也钉住
   * 堆叠态不得靠滚动伪装成贴底。
   */
  it("待处理卡浮层：堆叠态贴底不滚动，展开后才是带 mt-auto 的滚动容器", () => {
    const approval = {
      id: "approval-1",
      toolName: "write_file",
      title: "Write a.ts",
      toolKind: "edit" as const,
      locations: [],
      options: [{ optionId: "reject-1", name: "拒绝", kind: "reject_once" as const }],
      deadline: Date.now() + 60_000,
      timeoutMs: 60_000,
    };
    const questions = {
      id: "q-1",
      questions: [{ header: "范围", question: "覆盖哪些范围？", options: [], multiSelect: false }],
      deadline: Date.now() + 60_000,
      timeoutMs: 60_000,
    };
    renderApp([], { pendingApproval: approval, pendingQuestions: questions });

    const overlay = () => container.querySelector<HTMLElement>("[data-pending-overlay]");
    const stacked = overlay();
    expect(stacked).toBeTruthy();
    expect(stacked!.className).toContain("justify-end");
    expect(stacked!.classList.contains("overflow-y-auto")).toBe(false);
    expect(stacked!.className).not.toContain("[&>*]:mt-auto");

    // 计数器是唯一展开入口；展开后三卡完整、列表滚动并贴底。
    const counter = container.querySelector<HTMLButtonElement>("[data-pending-counter]");
    expect(counter).toBeTruthy();
    act(() => counter!.click());

    const list = overlay()!;
    for (const cls of ["min-h-0", "overflow-y-auto"]) {
      expect(list.classList.contains(cls)).toBe(true);
    }
    expect(list.className).not.toContain("justify-end");
    const firstSlot = list.querySelector<HTMLElement>("[data-pending-slot]");
    expect(firstSlot).toBeTruthy();
    expect(firstSlot!.className).toContain("[&>*]:mt-auto");
  });
});

describe("Super Agent 看板清理动作", () => {
  /** 行触发器（状态 + 标题 + 耗时那一行）。 */
  function rowTrigger(title = "修复登录跳转"): HTMLButtonElement {
    const el = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      (b.textContent ?? "").includes(title),
    );
    expect(el).toBeTruthy();
    return el!;
  }

  /** 详情区里的「清理」按钮（文案恰好是「清理」，不含确认框里的同名按钮）。 */
  function cleanupButton(): HTMLButtonElement {
    const el = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.textContent ?? "").trim() === "清理",
    );
    expect(el).toBeTruthy();
    return el!;
  }

  /** 清理确认框（ConfirmDialog 走 portal 挂在 document.body 上）。 */
  const cleanupDialog = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[role="alertdialog"][aria-label="清理超流体"]');

  it("运行中的超流体不能清理：aria-disabled 且点击不弹确认框", () => {
    render([session({ status: "running", startedAt: 2000, updatedAt: 3000 })]);
    expand();
    act(() => rowTrigger().click());

    const btn = cleanupButton();
    // 与合并按钮同一范式：aria-disabled（不是 disabled，否则理由读不到）。
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.getAttribute("aria-label")).toBe("超流体还在运行，请先中断再清理");
    expect(btn.getAttribute("title")).toBe("超流体还在运行，请先中断再清理");
    expect(btn.className).toContain("cursor-not-allowed");
    expect(btn.className).toContain("opacity-40");
    // 理由不再逐行重复：行首状态 chip 已说明子会话还在运行，规则统一
    // 收在看板头的帮助按钮里（见「看板帮助说明」那组用例）。
    expect(document.body.textContent).not.toContain("超流体还在运行，请先中断再清理");

    act(() => btn.click());
    expect(cleanupDialog()).toBeNull();
    expect(document.body.textContent).not.toContain("删除超流体");
  });

  it("已完成的超流体仍可清理：点击后弹出确认框", () => {
    render([session({ status: "completed", startedAt: 2000, endedAt: 4000 })]);
    expand();
    act(() => rowTrigger().click());

    const btn = cleanupButton();
    expect(btn.getAttribute("aria-disabled")).toBeNull();
    expect(document.body.textContent).not.toContain("超流体还在运行，请先中断再清理");

    act(() => btn.click());
    const dialog = cleanupDialog();
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain("删除超流体「修复登录跳转」的工作目录？");
    // 宿主对未提交改动是**拒绝清理**，不是「一起删掉」——旧文案是硬伤。
    expect(dialog!.textContent).toContain("有未提交的改动时会被拒绝清理");
    expect(dialog!.textContent).not.toContain("会被一起删掉");
  });

  it("目录隔离的超流体：确认文案说清没有分支、目录内容全部删除", () => {
    render([
      session({
        status: "completed",
        startedAt: 2000,
        endedAt: 4000,
        isolation: { kind: "directory", path: "/tmp/dir" },
      }),
    ]);
    expand();
    act(() => rowTrigger().click());

    act(() => cleanupButton().click());
    const dialog = cleanupDialog();
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain("删除超流体「修复登录跳转」的独立目录？");
    expect(dialog!.textContent).toContain("没有分支");
    expect(dialog!.textContent).not.toContain("分支一并删除");
  });

  it("主仓工作区档（repo）：确认文案说清只移除记录、不删主仓任何文件", () => {
    render([
      session({
        status: "completed",
        startedAt: 2000,
        endedAt: 4000,
        isolation: { kind: "repo", path: "/repo/root" },
      }),
    ]);
    expand();
    act(() => rowTrigger().click());

    act(() => cleanupButton().click());
    const dialog = cleanupDialog();
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain("移除超流体「修复登录跳转」的看板记录？");
    expect(dialog!.textContent).toContain("不会删除主仓里的任何文件");
    expect(dialog!.textContent).not.toContain("删除超流体「修复登录跳转」的工作目录");
  });

  /** 确认框里的确认按钮（文案与操作同名，与「取消」区分）。 */
  function dialogConfirm(dialog: HTMLElement, label = "清理"): HTMLButtonElement {
    const el = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.textContent ?? "").trim() === label,
    );
    expect(el).toBeTruthy();
    return el!;
  }

  /** 忙碌态的「清理中」按钮（普通态文案是「清理」，不会命中）。 */
  function busyCleanupButton(): HTMLButtonElement {
    const el = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.textContent ?? "").trim() === "清理中",
    );
    expect(el).toBeTruthy();
    return el!;
  }

  it("确认清理后立即出现 spinner +「清理中」，不等 host 回包", () => {
    render([session({ id: "super-a", status: "completed", startedAt: 2000, endedAt: 4000 })]);
    expand();
    act(() => rowTrigger().click());
    act(() => cleanupButton().click());
    const dialog = cleanupDialog();
    expect(dialog).toBeTruthy();

    act(() => dialogConfirm(dialog!).click());

    // 确认框立即关闭，请求立即发出。
    expect(cleanupDialog()).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: "superAgent",
      action: "cleanup",
      sessionId: "super-a",
    });
    // 行首状态 chip 立刻变成「清理中」+ 旋转图标（completed 原本没有 spinner）。
    const trigger = rowTrigger();
    expect(trigger.textContent).toContain("清理中");
    expect(trigger.querySelector(".animate-spin")).toBeTruthy();
    // 清理按钮同步进入忙碌态：文案、图标、可访问名都更新。
    const busy = busyCleanupButton();
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(busy.getAttribute("aria-label")).toBe("清理中");
    expect(busy.getAttribute("title")).toBe("清理中");
    expect(busy.querySelector(".animate-spin")).toBeTruthy();
  });

  it("进行态中重复点击清理按钮不会再次发送请求", () => {
    render([session({ id: "super-a", status: "completed", startedAt: 2000, endedAt: 4000 })]);
    expand();
    act(() => rowTrigger().click());
    act(() => cleanupButton().click());
    act(() => dialogConfirm(cleanupDialog()!).click());
    expect(send).toHaveBeenCalledTimes(1);

    const busy = busyCleanupButton();
    act(() => busy.click());
    expect(send).toHaveBeenCalledTimes(1);
    expect(cleanupDialog()).toBeNull();
  });

  it("取消确认框不触发进行态，也不发送请求", () => {
    render([session({ id: "super-a", status: "completed", startedAt: 2000, endedAt: 4000 })]);
    expand();
    act(() => rowTrigger().click());
    act(() => cleanupButton().click());
    const dialog = cleanupDialog();
    expect(dialog).toBeTruthy();
    const cancel = [...dialog!.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.textContent ?? "").trim() === "取消",
    );
    expect(cancel).toBeTruthy();

    act(() => cancel!.click());

    expect(cleanupDialog()).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("清理中");
    expect(cleanupButton().getAttribute("aria-label")).toBe("清理");
  });

  it("host 移除超流体后进行态自然消失，不残留到别的会话", () => {
    render([session({ id: "super-a", status: "completed", startedAt: 2000, endedAt: 4000 })]);
    expand();
    act(() => rowTrigger().click());
    act(() => cleanupButton().click());
    act(() => dialogConfirm(cleanupDialog()!).click());
    expect(document.body.textContent).toContain("清理中");

    // 模拟 host 完成清理：super-a 从 superSessions 消失，换成一个未清理的会话。
    render([
      session({
        id: "super-b",
        title: "另一个任务",
        status: "failed",
        startedAt: 2000,
        endedAt: 4000,
      }),
    ]);
    expect(document.body.textContent).toContain("另一个任务");
    expect(document.body.textContent).not.toContain("清理中");
  });
});

describe("Super Agent 看板帮助说明", () => {
  /** 行触发器（状态 + 标题 + 耗时那一行）。 */
  function rowTrigger(title = "修复登录跳转"): HTMLButtonElement {
    const el = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      (b.textContent ?? "").includes(title),
    );
    expect(el).toBeTruthy();
    return el!;
  }

  it("看板头的帮助按钮统一说明合并与清理规则", () => {
    render();
    expand();
    // 行也展开：旧实现下那两句禁用原因就出现在这里，所以下面的
    // not.toContain 断言才是有效的（行内详情区确实渲染了）。
    act(() => rowTrigger().click());

    // 展开面板 header 里的帮助按钮（HelpTip 的触发器）。
    const tip = document.body.querySelector<HTMLButtonElement>('button[aria-label="看板说明"]');
    expect(tip).toBeTruthy();
    // 气泡是 hover / focus 才渲染的：focus 走 HelpTip 内部 button 的 onFocus。
    act(() => tip!.focus());
    const bubble = document.querySelector<HTMLElement>('[role="tooltip"]');
    expect(bubble).toBeTruthy();
    // 免确认 / 合并规则 / 清理规则，一条一行，都在同一个气泡里。
    expect(bubble!.textContent).toContain("超流体里的工具调用（包括运行命令）会直接执行");
    expect(bubble!.textContent).toContain("超流体结束之后才能合并");
    expect(bubble!.textContent).toContain("超流体还在运行时不能清理");
    // 规则只在这里说一次：行内不再重复那两句禁用原因。
    expect(document.body.textContent).not.toContain("超流体还没结束，等它完成再合并");
    expect(document.body.textContent).not.toContain("超流体还在运行，请先中断再清理");
  });
});

/** 一个正在等用户回答的子会话（看板会自动展开它）。 */
function askingSession(overrides: Partial<SuperSessionUi> = {}): SuperSessionUi {
  return session({
    id: "super-ask",
    title: "要覆盖哪些范围",
    status: "awaiting_input",
    pending: {
      kind: "question",
      requestId: "req-1",
      deadline: Date.now() + 240_000,
      timeoutMs: 300_000,
      questions: [
        {
          header: "范围",
          question: "这一组单测要覆盖哪些范围？",
          multiSelect: false,
          options: [{ label: "只覆盖用量估算", description: "范围小、跑得快" }],
        },
      ],
    },
    ...overrides,
  });
}

describe("Super Agent 看板折叠态不隐藏待答问题", () => {
  /** 折叠态专用的紧凑待答条（与展开面板是两个不同的 region）。 */
  const pendingStrip = () =>
    document.body.querySelector<HTMLElement>('[role="region"][aria-label="超流体待答问题"]');
  const submitButtons = () =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].filter(
      (b) => b.getAttribute("aria-label") === "提交回答",
    );

  it("折叠后待答问题仍在 DOM 里可见，且展开态不会重复渲染两条", () => {
    render([askingSession()]);

    // 有待答子会话时看板自行展开：问题由面板承载。
    expect(control().getAttribute("aria-expanded")).toBe("true");
    expect(panel()).toBeTruthy();
    expect(pendingStrip()).toBeNull();
    expect(submitButtons()).toHaveLength(1);

    // 手动收起：面板消失，但问题不能被一起藏起来（旧实现的功能回退）。
    act(() => control().click());
    expect(control().getAttribute("aria-expanded")).toBe("false");
    expect(panel()).toBeNull();

    const strip = pendingStrip();
    expect(strip).toBeTruthy();
    // 「哪个子会话」+「在等什么」都要读得到。
    expect(strip!.textContent).toContain("要覆盖哪些范围");
    expect(strip!.textContent).toContain("这一组单测要覆盖哪些范围？");
    // 折叠条与展开面板走同一条轨道（portal 到 body，fixed + 视口坐标）。
    expect(strip!.className).toContain("fixed");
    expect(strip!.className).toContain("z-35");
    // 真亚克力材质（半透明底 + backdrop blur）。
    expect(strip!.className).toContain("acrylic-frosted");
    // Portal 宿主是 body，不在 header 的子树里。
    expect(strip!.parentElement).toBe(document.body);
    expect(strip!.closest("header")).toBeNull();
    // 面板不在 DOM 里 → 同一道题只有一份。
    expect(submitButtons()).toHaveLength(1);
  });

  it("折叠态下作答照常回传宿主", () => {
    render([askingSession()]);
    act(() => control().click()); // 收起

    const radio = document.body.querySelector<HTMLElement>('[role="radio"]');
    expect(radio).toBeTruthy();
    act(() => radio!.click());
    act(() => submitButtons()[0]!.click());

    expect(send).toHaveBeenCalledWith({
      type: "superAgent",
      action: "respond",
      sessionId: "super-ask",
      answers: { 范围: "只覆盖用量估算" },
    });
  });

  it("没有待答超流体时折叠态不渲染待答条", () => {
    render([session()]);
    expect(pendingStrip()).toBeNull();
  });
});

describe("Super Agent 看板面板的收起通道", () => {
  it("aria-expanded 随点击翻转，可访问名保持静态", () => {
    render();
    expect(control().getAttribute("aria-expanded")).toBe("false");
    expect(control().getAttribute("aria-label")).toBe("超流体看板");
    expect(control().getAttribute("aria-controls")).toBeNull();

    expand();
    expect(control().getAttribute("aria-expanded")).toBe("true");
    // 名字不随状态变化：读屏只念「子会话看板」，展开态由 aria-expanded 表达。
    expect(control().getAttribute("aria-label")).toBe("超流体看板");
    // 悬停文案仍说明当前动作。
    expect(control().getAttribute("title")).toBe("收起超流体看板");
    expect(control().getAttribute("aria-controls")).toBe(panelRoot().id);
    expect(panelRoot().id).toBe("super-board-panel");

    act(() => control().click());
    expect(control().getAttribute("aria-expanded")).toBe("false");
    expect(control().getAttribute("aria-controls")).toBeNull();
  });

  it("外部 mousedown 收起面板，面板内部的 mousedown 不收起", () => {
    render();
    expand();
    expect(panel()).toBeTruthy();

    const inside = panelRoot().querySelector("span");
    expect(inside).toBeTruthy();
    act(() => {
      inside!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(panel()).toBeTruthy();

    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(panel()).toBeNull();
    expect(control().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("Super Agent 看板工作目录占用与批量清理", () => {
  /** 行触发器（状态 + 标题 + 耗时那一行）。 */
  function rowTrigger(title = "修复登录跳转"): HTMLButtonElement {
    const el = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      (b.textContent ?? "").includes(title),
    );
    expect(el).toBeTruthy();
    return el!;
  }

  /** 统计行里的「清理已结束」按钮（确认框里的同名按钮走 portal，不在面板里）。 */
  function bulkButton(): HTMLButtonElement | null {
    return (
      [...panelRoot().querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => (b.textContent ?? "").trim() === "清理已结束",
      ) ?? null
    );
  }

  /** 批量清理确认框（ConfirmDialog 走 portal 挂在 document.body 上）。 */
  const bulkDialog = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[role="alertdialog"][aria-label="清理已结束的超流体"]');

  /** 已释放的隔离记录；recycled=true 表示目录已回收、分支仍保留。 */
  function releasedIsolation(recycled: boolean): SuperSessionUi["isolation"] {
    return {
      kind: "git_worktree",
      path: "/tmp/wt",
      branch: "iflow/super/a",
      released: true,
      ...(recycled ? { recycled: true } : {}),
    };
  }

  it("终态且未释放：显示占用与可回收计数，确认后只发一条 cleanupBatch", () => {
    render([
      session({ id: "super-a", title: "修复登录跳转", status: "completed", startedAt: 2000, endedAt: 4000 }),
      session({ id: "super-b", title: "补充单测", status: "failed", startedAt: 2000, endedAt: 4000 }),
    ]);
    expand();

    const text = panelRoot().textContent ?? "";
    expect(text).toContain("工作目录 2 个");
    expect(text).toContain("已结束 2 个可清理");

    const btn = bulkButton();
    expect(btn).toBeTruthy();
    act(() => btn!.click());

    const dialog = bulkDialog();
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain("将清理 2 个超流体");
    // 与宿主 cleanup() 的真实行为一致：未提交改动会被拒绝（不是被删），
    // 只有未合并的提交才保留分支。
    expect(dialog!.textContent).toContain("有未提交的改动时会被拒绝清理");
    expect(dialog!.textContent).toContain("保留分支");
    expect(dialog!.textContent).not.toContain("分支都会保留");
    expect(dialog!.textContent).not.toContain("会被一起删掉");

    const confirm = [...dialog!.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.textContent ?? "").trim() === "清理已结束",
    );
    expect(confirm).toBeTruthy();
    act(() => confirm!.click());

    // 批次汇总回执：整批只有一条请求，由宿主串行清理并回一条汇总 toast
    // （旧实现逐个发 cleanup，用户会看到 N 条重复回执）。
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: "superAgent",
      action: "cleanupBatch",
      sessionIds: ["super-a", "super-b"],
    });
    expect(bulkDialog()).toBeNull();
  });

  it("批量确认文案按隔离类型分开说明（worktree 说分支，目录说没有分支）", () => {
    render([
      session({ id: "super-a", title: "修复登录跳转", status: "completed", startedAt: 2000, endedAt: 4000 }),
      session({
        id: "super-b",
        title: "补充单测",
        status: "failed",
        startedAt: 2000,
        endedAt: 4000,
        isolation: { kind: "directory", path: "/tmp/dir" },
      }),
    ]);
    expand();

    act(() => bulkButton()!.click());
    const dialog = bulkDialog();
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain("删除 1 个 git 工作目录");
    expect(dialog!.textContent).toContain("保留分支");
    expect(dialog!.textContent).toContain("删除 1 个只有目录隔离的独立目录");
    expect(dialog!.textContent).toContain("没有分支");
  });

  it("运行中的超流体不计入可回收，也不出现「清理已结束」按钮", () => {
    render([session({ status: "running", startedAt: 2000, updatedAt: 3000 })]);
    expand();

    const text = panelRoot().textContent ?? "";
    expect(text).toContain("工作目录 1 个");
    expect(text).toContain("已结束 0 个可清理");
    expect(bulkButton()).toBeNull();
    expect(bulkDialog()).toBeNull();
  });

  it("全部已释放时计数行不渲染", () => {
    render([
      session({
        status: "completed",
        startedAt: 2000,
        endedAt: 4000,
        isolation: releasedIsolation(true),
      }),
    ]);
    expand();

    expect(panelRoot().textContent ?? "").not.toContain("个可清理");
    expect(bulkButton()).toBeNull();
  });

  it("recycled 的超流体展开后说「工作目录已回收，分支保留」", () => {
    render([
      session({
        status: "completed",
        startedAt: 2000,
        endedAt: 4000,
        isolation: releasedIsolation(true),
      }),
    ]);
    expand();
    act(() => rowTrigger().click());

    expect(document.body.textContent).toContain("工作目录已删除，分支保留");
    expect(document.body.textContent).not.toContain("工作目录和分支都已删除");
  });

  it("批量清理确认后每行各自立即显示进行态", () => {
    render([
      session({ id: "super-a", title: "修复登录跳转", status: "completed", startedAt: 2000, endedAt: 4000 }),
      session({ id: "super-b", title: "补充单测", status: "failed", startedAt: 2000, endedAt: 4000 }),
    ]);
    expand();

    const btn = bulkButton();
    expect(btn).toBeTruthy();
    act(() => btn!.click());
    const dialog = bulkDialog();
    expect(dialog).toBeTruthy();
    const confirm = [...dialog!.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.textContent ?? "").trim() === "清理已结束",
    );
    expect(confirm).toBeTruthy();

    act(() => confirm!.click());

    // 一条批次请求 + 一次性的进行态标记（不是 N 条 cleanup）。
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: "superAgent",
      action: "cleanupBatch",
      sessionIds: ["super-a", "super-b"],
    });
    expect(bulkDialog()).toBeNull();
    // 两行各自进入进行态，而不是只有第一行或整批一个共用 spinner。
    const triggerA = rowTrigger("修复登录跳转");
    const triggerB = rowTrigger("补充单测");
    expect(triggerA.textContent).toContain("清理中");
    expect(triggerB.textContent).toContain("清理中");
    expect(triggerA.querySelector(".animate-spin")).toBeTruthy();
    expect(triggerB.querySelector(".animate-spin")).toBeTruthy();
  });
});

describe("Super Agent 看板隔离行：准备中不误报降级", () => {
  /** 行触发器（状态 + 标题 + 耗时那一行）。 */
  function rowTrigger(title = "修复登录跳转"): HTMLButtonElement {
    const el = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      (b.textContent ?? "").includes(title),
    );
    expect(el).toBeTruthy();
    return el!;
  }

  /** 行标题 span 的 tooltip 文本（分支 / 目录 / 尝试次数 / 历史标记）。 */
  function rowTitleHint(): string {
    const el = rowTrigger().querySelector<HTMLElement>("[title]");
    expect(el).toBeTruthy();
    return el!.getAttribute("title") ?? "";
  }

  it("排队/准备中的占位隔离不显示「仅目录隔离」，改为显示宿主占位说明", () => {
    render([
      session({
        status: "preparing",
        queued: true,
        isolation: { kind: "directory", path: "", note: "正在准备隔离环境" },
      }),
    ]);
    expand();
    act(() => rowTrigger().click());

    // 状态 chip 已经写着「排队中」，再叠一个警告色降级 chip 只会误读成
    // 「独立工作目录创建失败」——占位态不得出现。
    expect(document.body.textContent).toContain("排队中");
    expect(document.body.textContent).not.toContain("只隔离了目录");
    // 隔离行不能渲染空字符串：宿主给的中文占位说明要能看到。
    expect(document.body.textContent).toContain("正在准备隔离环境");
  });

  it("真降级（directory + 非空 path）仍显示「仅目录隔离」", () => {
    render([
      session({
        isolation: {
          kind: "directory",
          path: "/tmp/fallback",
          note: "独立工作目录创建失败（fatal: not a git repository），仅目录隔离",
        },
      }),
    ]);
    expand();
    act(() => rowTrigger().click());

    expect(document.body.textContent).toContain("只隔离了目录");
    // 真降级时定位文本仍是那个目录，而不是 note。
    expect(document.body.textContent).toContain("/tmp/fallback");
  });

  it("占位隔离的行标题 tooltip 不拼出空「目录 」，改说宿主占位说明", () => {
    render([
      session({
        status: "preparing",
        queued: true,
        isolation: { kind: "directory", path: "", note: "正在准备隔离环境" },
      }),
    ]);
    expand();

    const hint = rowTitleHint();
    // 空 path 拼出的「目录 」会读成隔离信息丢失；占位态根本没有目录可报。
    expect(hint).not.toContain("目录 ");
    expect(hint).toContain("正在准备隔离环境");
    // 也不留空行（.filter(Boolean) 必须把空值整项剔掉）。
    expect(hint).toBe(hint.trim());
    expect(hint.split("\n").every((line) => line.trim() !== "")).toBe(true);
  });

  it("真降级的行标题 tooltip 仍带「目录 <path>」", () => {
    render([
      session({
        isolation: {
          kind: "directory",
          path: "/tmp/fallback",
          note: "独立工作目录创建失败（fatal: not a git repository），仅目录隔离",
        },
      }),
    ]);
    expand();

    const hint = rowTitleHint();
    expect(hint).toContain("目录 /tmp/fallback");
  });
});

describe("Super Agent 看板合并 / 重试进行态", () => {
  /** 行触发器（状态 + 标题 + 耗时那一行）。 */
  function rowTrigger(title = "修复登录跳转"): HTMLButtonElement {
    const el = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      (b.textContent ?? "").includes(title),
    );
    expect(el).toBeTruthy();
    return el!;
  }

  /** 详情区里的「让智能体合并」按钮（确认框里的确认按钮文案不同）。 */
  function mergeButton(): HTMLButtonElement {
    const el = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.textContent ?? "").trim() === "让智能体合并",
    );
    expect(el).toBeTruthy();
    return el!;
  }

  /** 忙碌态的合并按钮（普通态文案是「让智能体合并」，不会命中）。 */
  function busyMergeButton(): HTMLButtonElement {
    const el = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.textContent ?? "").trim() === "合并中",
    );
    expect(el).toBeTruthy();
    return el!;
  }

  /** 合并确认框（ConfirmDialog 走 portal 挂在 document.body 上）。 */
  const mergeDialog = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[role="alertdialog"][aria-label="合并超流体分支"]');

  function dialogButton(dialog: HTMLElement, label: string): HTMLButtonElement {
    const el = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.textContent ?? "").trim() === label,
    );
    expect(el).toBeTruthy();
    return el!;
  }

  /** 详情区里的「重试」按钮（忙碌态文案是「重试中」）。 */
  function retryButton(): HTMLButtonElement {
    const el = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      ["重试", "重试中"].includes((b.textContent ?? "").trim()),
    );
    expect(el).toBeTruthy();
    return el!;
  }

  /** 已结束、分支仍在、集成结果为「未自动合并」——合并按钮可用且行不被折叠。 */
  function mergeableSession(overrides: Partial<SuperSessionUi> = {}): SuperSessionUi {
    return session({
      id: "super-m",
      status: "completed",
      startedAt: 2000,
      endedAt: 4000,
      integration: { mode: "merge", state: "skipped", detail: "工作区脏", at: 5000 },
      ...overrides,
    });
  }

  it("确认合并后立即出现 spinner +「合并中」，不等 host 回包", () => {
    render([mergeableSession()]);
    expand();
    act(() => rowTrigger().click());
    act(() => mergeButton().click());
    const dialog = mergeDialog();
    expect(dialog).toBeTruthy();

    act(() => dialogButton(dialog!, "让智能体合并分支").click());

    // 确认框立即关闭，请求立即发出。
    expect(mergeDialog()).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: "superAgent",
      action: "merge",
      sessionId: "super-m",
    });
    // 行首状态 chip 立刻变成「合并中」+ 旋转图标（completed 原本没有 spinner）。
    const trigger = rowTrigger();
    expect(trigger.textContent).toContain("合并中");
    expect(trigger.querySelector(".animate-spin")).toBeTruthy();
    // 合并按钮同步进入忙碌态：文案、图标、可访问名都更新。
    const busy = busyMergeButton();
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(busy.getAttribute("aria-label")).toBe("合并中");
    expect(busy.getAttribute("title")).toBe("合并中");
    expect(busy.querySelector(".animate-spin")).toBeTruthy();
    // 「已请求、未合入」绝不能被误报成「已自动合并」。
    expect(document.body.textContent).not.toContain("已自动合并");
  });

  it("合并进行态中重复点击不会再次发送请求", () => {
    render([mergeableSession()]);
    expand();
    act(() => rowTrigger().click());
    act(() => mergeButton().click());
    act(() => dialogButton(mergeDialog()!, "让智能体合并分支").click());
    expect(send).toHaveBeenCalledTimes(1);

    act(() => busyMergeButton().click());
    expect(send).toHaveBeenCalledTimes(1);
    expect(mergeDialog()).toBeNull();
  });

  it("integration 落定后收尾：不再显示「合并中」，结果改为已合并", () => {
    render([mergeableSession()]);
    expand();
    act(() => rowTrigger().click());
    act(() => mergeButton().click());
    act(() => dialogButton(mergeDialog()!, "让智能体合并分支").click());
    expect(document.body.textContent).toContain("合并中");

    // 合并子会话跑完：host 把来源行的 integration 改写成 merged（新的 at）。
    render([
      mergeableSession({ integration: { mode: "merge", state: "merged", at: 9000 } }),
    ]);

    expect(document.body.textContent).not.toContain("合并中");
    // 全部子会话都已合并 → 看板自动收起成顶栏控件：重新展开再读历史行。
    expect(control().getAttribute("aria-expanded")).toBe("false");
    expand();
    // 已合并的行折叠进「已完成的 N 个子会话」：展开后读到真实结果。
    const foldedToggle = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="展开已完成的超流体"]',
    );
    expect(foldedToggle).toBeTruthy();
    act(() => foldedToggle!.click());
    act(() => rowTrigger().click());
    expect(rowTrigger().querySelector(".animate-spin")).toBeNull();
    expect(document.body.textContent).toContain("已自动合并");
  });

  it("取消合并确认框不触发进行态，也不发送请求", () => {
    render([mergeableSession()]);
    expand();
    act(() => rowTrigger().click());
    act(() => mergeButton().click());
    const dialog = mergeDialog();
    expect(dialog).toBeTruthy();

    act(() => dialogButton(dialog!, "取消").click());

    expect(mergeDialog()).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("合并中");
    expect(mergeButton().getAttribute("aria-label")).toBe("让智能体合并");
    expect(mergeButton().getAttribute("aria-disabled")).toBeNull();
  });

  it("请求未被受理（没有合并超流体）时兜底超时解锁，不永久转圈", () => {
    vi.useFakeTimers();
    try {
      render([mergeableSession()]);
      expand();
      act(() => rowTrigger().click());
      act(() => mergeButton().click());
      act(() => dialogButton(mergeDialog()!, "让智能体合并分支").click());
      expect(document.body.textContent).toContain("合并中");

      // host 拒掉请求（主会话正忙等）不会产生合并子会话：宽限期到点收尾。
      act(() => {
        vi.advanceTimersByTime(6_000);
      });

      expect(document.body.textContent).not.toContain("合并中");
      expect(mergeButton().getAttribute("aria-label")).toBe("让智能体合并");
    } finally {
      vi.useRealTimers();
    }
  });

  it("点击重试立即禁用并显示「重试中」，重复点击不重发", () => {
    render([
      session({
        id: "super-r",
        status: "failed",
        error: "进程崩溃",
        startedAt: 2000,
        endedAt: 4000,
      }),
    ]);
    expand();
    act(() => rowTrigger().click());

    act(() => retryButton().click());

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: "superAgent",
      action: "retry",
      sessionId: "super-r",
    });
    const busy = retryButton();
    expect(busy.textContent?.trim()).toBe("重试中");
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(busy.getAttribute("aria-label")).toBe("重试中");
    expect(busy.getAttribute("title")).toBe("重试中");
    expect(busy.querySelector(".animate-spin")).toBeTruthy();
    // 行首 chip 同样立即说明「重试中」。
    expect(rowTrigger().textContent).toContain("重试中");

    // 防连点：进行态下再点一次不会再发。
    act(() => busy.click());
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("host 受理重试（状态变为运行中）后进行态收尾", () => {
    render([
      session({
        id: "super-r",
        status: "failed",
        error: "进程崩溃",
        startedAt: 2000,
        endedAt: 4000,
      }),
    ]);
    expand();
    act(() => rowTrigger().click());
    act(() => retryButton().click());
    expect(document.body.textContent).toContain("重试中");

    // host 重置 worktree 并起了新进程：status 变化即视为已受理。
    render([
      session({
        id: "super-r",
        status: "running",
        attempts: 2,
        startedAt: 9000,
        updatedAt: 9000,
      }),
    ]);

    expect(document.body.textContent).not.toContain("重试中");
    expect(rowTrigger().textContent).toContain("运行中");
  });
});

describe("Super Agent 看板入口运行态炫光", () => {
  /** 装饰层：只在至少一个子会话非终态时挂载。 */
  const glow = (): HTMLElement | null =>
    control().querySelector<HTMLElement>(".super-entry-glow");

  it("至少一个非终态超流体：渲染纯装饰层，可访问名/aria-expanded/点击区不变", () => {
    render([session({ status: "running" })]);

    const el = glow();
    expect(el).toBeTruthy();
    // 纯装饰：不进可访问树、无文本、不吃指针事件（后者在 CSS 契约里断言）。
    expect(el!.getAttribute("aria-hidden")).toBe("true");
    expect(el!.textContent).toBe("");
    expect(el!.childElementCount).toBe(0);
    // 装饰层不改变按钮本身的可访问语义与展开状态。
    expect(control().getAttribute("aria-label")).toBe("超流体看板");
    expect(control().getAttribute("aria-expanded")).toBe("false");
    // 定位/层叠上下文挂在按钮上，装饰层自己不引入新控件。
    expect(control().className).toContain("relative");
    expect(control().className).toContain("isolate");
    // 装饰层不带任何可交互形态（不是按钮/链接）。
    expect(el!.querySelector("button, a, input")).toBeNull();
  });

  it("准备中 / 等你处理同属非终态，炫光层同样出现", () => {
    for (const status of ["preparing", "awaiting_input"] as const) {
      render([session({ status })]);
      expect(glow()).toBeTruthy();
      expect(glow()!.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("running 混合终态：只要有一个非终态就保留炫光层", () => {
    render([
      session({ id: "a", status: "completed" }),
      session({ id: "b", status: "running" }),
      session({ id: "c", status: "cancelled" }),
    ]);
    expect(glow()).toBeTruthy();
  });

  it("全部为终态时完全静止：零装饰层 DOM（completed/failed/cancelled 任一组合）", () => {
    const terminalSets: Array<Array<"completed" | "failed" | "cancelled">> = [
      ["completed"],
      ["failed"],
      ["cancelled"],
      ["completed", "failed", "cancelled"],
    ];
    for (const statuses of terminalSets) {
      render(statuses.map((status, i) => session({ id: `s${i}`, status })));
      expect(glow()).toBeNull();
      // 控件本身仍在（只是没有多余装饰层与动画）。
      expect(control().getAttribute("aria-label")).toBe("超流体看板");
    }
  });

  it("从运行态收敛到全终态后，重新渲染会移除装饰层（无残留动画）", () => {
    render([session({ status: "running" })]);
    expect(glow()).toBeTruthy();

    render([session({ status: "completed" })]);
    expect(glow()).toBeNull();
  });

  it("CSS 契约：角度动画 + conic-gradient + 复合环形 mask（圆角连续）+ blur 柔光 + reduced-motion 降级", () => {
    const css = readFileSync(join(__dirname, "..", "webview", "src", "styles.css"), "utf8");
    const start = css.indexOf(".super-entry-glow {");
    expect(start).toBeGreaterThan(-1);
    // 取动效整段（含 @property / keyframes / reduced-motion）。
    const block = css.slice(css.lastIndexOf("@property --super-entry-angle", start));
    expect(block).toContain('syntax: "<angle>"');
    expect(block).toContain("@keyframes super-entry-spin");
    expect(block).toContain("conic-gradient(");
    expect(block).toContain("from var(--super-entry-angle)");
    // 中心被挖空：单个复合环形遮罩 = 外框减 content-box，两层同受
    // border-radius: inherit 约束，圆角处不会像四条轴向矩形条那样被掐细。
    expect(block).toContain("-webkit-mask:");
    expect(block).toContain("mask:");
    expect(block).toContain("content-box");
    expect(block).toContain("-webkit-mask-composite: xor");
    expect(block).toContain("mask-composite: exclude");
    // 环宽由 padding 给出（内容框内缩同量 → 环沿圆角等宽）。
    expect(block).toContain("padding: 2px");
    expect(block).toContain("border-radius: inherit");
    // 旧实现：四条轴向矩形条，在 45° 对角处只剩 ~0.75px，四角看起来被裁切。
    expect(block).not.toContain("no-repeat");
    expect(block).toContain("filter: blur(");
    expect(block).toContain("pointer-events: none");
    // 纯装饰层不吃点击；focus ring 由按钮自身 box-shadow 提供，不被裁切。
    expect(block).not.toContain("overflow: hidden");
    // 不依赖 backdrop-filter（陷阱 #22）。
    expect(block).not.toContain("backdrop-filter");
    // 减弱动效降级为静态角度，不加任意 px 字号/圆角。
    expect(block).toContain("@media (prefers-reduced-motion: reduce)");
    expect(block).toContain("animation: none");
    expect(block).not.toMatch(/text-\[\d+px\]|rounded-\[\d+px\]/);
  });
});

describe("Super Agent 看板 · 已中断状态危险色与中断来源", () => {
  function rowTrigger(title = "修复登录跳转"): HTMLButtonElement {
    const el = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      (b.textContent ?? "").includes(title),
    );
    expect(el).toBeTruthy();
    return el!;
  }

  it("已中断状态用危险色（与失败同级），折叠行 chip 带 text-destructive", () => {
    render([session({ status: "cancelled", interruptedBy: "user" })]);
    expand();
    const statusChip = rowTrigger().querySelector<HTMLElement>(".text-destructive");
    expect(statusChip).toBeTruthy();
    expect(statusChip!.textContent).toContain("已中断");
  });

  it.each([
    ["user", "由用户中断"],
    ["agent", "由智能体中断"],
    ["system", "由系统中断"],
  ] as const)("interruptedBy=%s 时标题旁显示「%s」", (source, label) => {
    render([session({ status: "cancelled", interruptedBy: source })]);
    expand();
    expect(rowTrigger().textContent).toContain(label);
  });

  it("非已中断状态不显示中断来源小字", () => {
    render([session({ status: "running", interruptedBy: "user" })]);
    expand();
    expect(rowTrigger().textContent).not.toContain("由用户中断");
  });

  it("已中断但无来源（理论缺省）时不显示任何来源小字", () => {
    render([session({ status: "cancelled" })]);
    expand();
    const text = rowTrigger().textContent ?? "";
    expect(text).toContain("已中断");
    expect(text).not.toContain("由用户中断");
    expect(text).not.toContain("由智能体中断");
    expect(text).not.toContain("由系统中断");
  });
});
