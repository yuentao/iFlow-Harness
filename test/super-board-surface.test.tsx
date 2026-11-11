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
