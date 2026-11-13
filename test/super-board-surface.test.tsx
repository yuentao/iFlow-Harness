// @vitest-environment jsdom
/**
 * Super Agent board — surface material (acrylic + shadow).
 *
 * The board floats OVER the scrolling transcript, so its surface used to be
 * pinned to an opaque `bg-card` — any alpha let the message text underneath
 * ghost through. It is now an acrylic surface (`.super-board-surface` in
 * styles.css: own backdrop-filter + a denser tint mixed from the two
 * existing acrylic tints) with a shadow tier that follows the surface size.
 *
 * These cases pin the MATERIAL contract, not the pixels:
 *  - the board root carries the acrylic surface class (no opaque card bg);
 *  - the collapsed shelf takes the float shadow tier, the expanded panel the
 *    panel tier (the float tier's spread stays inside a ~38px strip, while
 *    --shadow-panel's -24px spread collapses to nothing at that height);
 *  - the overlay contract survives the material change: pointer-events-auto,
 *    the stream-in entrance, the rounded/overflow-clipped box and the
 *    margins that keep the bar off the transcript edges.
 *
 * The stylesheet half asserts the surface really is acrylic (it declares its
 * own backdrop-filter — the board has no backdrop-filter ancestor, so the
 * blur samples the transcript for real) and that it degrades to an OPAQUE
 * card colour where backdrop-filter is unsupported.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuperSessionUi } from "../shared/super-agent";
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

/** The board's root element — the only child the component renders. */
function boardRoot(): HTMLElement {
  const el = container.firstElementChild;
  expect(el).toBeTruthy();
  return el as HTMLElement;
}

function expand(): void {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="展开子会话看板"]');
  expect(button).toBeTruthy();
  act(() => button!.click());
}

describe("Super Agent 看板表面材质", () => {
  it("根节点是亚克力表面，不再是不透明卡片底", () => {
    render();
    const el = boardRoot();
    expect(el.classList.contains("super-board-surface")).toBe(true);
    // The old opaque card background must be gone — it is what the acrylic
    // surface replaces.
    expect(el.classList.contains("bg-card")).toBe(false);
  });

  it("折叠态取浮层阴影档，展开态换面板档", () => {
    render();
    const collapsed = boardRoot();
    expect(collapsed.classList.contains("shadow-float")).toBe(true);
    expect(collapsed.classList.contains("shadow-panel")).toBe(false);

    expand();
    const expanded = boardRoot();
    expect(expanded.classList.contains("shadow-panel")).toBe(true);
    expect(expanded.classList.contains("shadow-float")).toBe(false);
  });

  it("保留浮层契约：可点击、入场动画、圆角裁切与边距", () => {
    render();
    const el = boardRoot();
    // The bar sits inside App's pointer-events-none overlay shell, so it has
    // to re-enable hits for itself.
    expect(el.classList.contains("pointer-events-auto")).toBe(true);
    expect(el.classList.contains("stream-in")).toBe(true);
    expect(el.classList.contains("overflow-hidden")).toBe(true);
    expect(el.classList.contains("rounded-lg")).toBe(true);
    for (const margin of ["mx-3", "mt-2", "mb-2"]) {
      expect(el.classList.contains(margin)).toBe(true);
    }
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

describe("Super Agent 看板亚克力材质规则", () => {
  const css = readFileSync(join(__dirname, "..", "webview", "src", "styles.css"), "utf8");

  it("自带 backdrop-filter（看板不在任何 backdrop-filter 祖先内，能真正采样背后的转录）", () => {
    const block = css.match(/\.super-board-surface\s*\{([^}]*)\}/);
    expect(block).toBeTruthy();
    expect(block![1]).toMatch(/backdrop-filter:\s*blur\(/);
  });

  it("底色由既有亚克力 tint 混合而来，且无 backdrop-filter 时退回不透明卡片色", () => {
    const block = css.match(/\.super-board-surface\s*\{([^}]*)\}/);
    expect(block![1]).toMatch(/color-mix\(in oklab, var\(--acrylic-pop-tint\)/);
    // No blur → nothing hides the transcript text → the shelf must go opaque.
    const fallback = css.match(
      /@supports not \(backdrop-filter: blur\(1px\)\)\s*\{([\s\S]*?)\n\}/,
    );
    expect(fallback).toBeTruthy();
    expect(fallback![1]).toMatch(/\.super-board-surface\s*\{[^}]*background-color:\s*var\(--card\)/);
  });

  it("两档阴影都走既有 token，并在亚克力表面上保留内描边", () => {
    expect(css).toMatch(/\.super-board-surface\.shadow-float\s*\{[^}]*var\(--shadow-float\)/);
    expect(css).toMatch(/\.super-board-surface\.shadow-panel\s*\{[^}]*var\(--shadow-panel\)/);
    expect(css).toMatch(/\.super-board-surface\.shadow-float\s*\{[^}]*var\(--acrylic-edge\)/);
    expect(css).toMatch(/\.super-board-surface\.shadow-panel\s*\{[^}]*var\(--acrylic-edge\)/);
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

  it("看板头部折叠开关保持默认的自绘 hover（不受行级收敛影响）", () => {
    render();
    const headerSwitch = container.querySelector<HTMLButtonElement>(
      'button[aria-label="展开子会话看板"]',
    );
    expect(headerSwitch).toBeTruthy();
    expect(cls(headerSwitch!)).toContain("hover:bg-accent/60");
  });
});
