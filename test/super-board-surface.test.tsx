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

vi.mock("../webview/src/i18n", () => ({
  t: (s: string, ...args: Array<string | number>) => {
    let out = s;
    args.forEach((arg, i) => {
      out = out.replaceAll(`{${i}}`, String(arg));
    });
    return out;
  },
}));

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
  /** 阶段轨元素（折叠行里那个就是第一个；展开只是多渲染一个同样的轨）。 */
  function rail(): HTMLElement {
    const el = container.querySelector<HTMLElement>('[role="img"][aria-label^="阶段轨："]');
    expect(el).toBeTruthy();
    return el as HTMLElement;
  }

  /** 轨上的圆点（每个真实节点一个）。 */
  function dots(): HTMLElement[] {
    return Array.from(rail().querySelectorAll<HTMLElement>(".rounded-full"));
  }

  /** 节点文案（标签在 DOM 里常驻，窄容器只是被 CSS 隐藏）。 */
  function labels(): HTMLElement[] {
    return Array.from(rail().querySelectorAll<HTMLElement>("span.text-ui-micro"));
  }

  it("只画真实发生过的节点，末节点带当前高亮", () => {
    render([session({ startedAt: 2000, updatedAt: 3000 })]);
    expand();

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
    // 有子会话在等应答时看板会自行展开（宿主 useEffect），再点一次反而收起。

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

    const described = rail().getAttribute("aria-label")!;
    for (const absent of ["已完成", "收尾", "失败", "已中断", "已自动合并"]) {
      expect(described).not.toContain(absent);
    }
    expect(labels().at(-1)!.textContent).toBe("启动");
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
