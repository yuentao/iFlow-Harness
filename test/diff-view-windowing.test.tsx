// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DiffView } from "../webview/src/components/DiffView";

/**
 * P1 (3.4.0): a whole-file/minified edit folds to thousands of real rows with
 * no "⋯" gap, so `collapseAroundChanges` cannot shrink it. The sliding window
 * must keep the DOM row count bounded while the absolute row indices (and the
 * text/numbering they carry) stay correct. Folded diffs must keep the original
 * prefix behaviour untouched.
 */

const send = vi.hoisted(() => vi.fn());
vi.mock("../webview/src/store", () => ({
  useChat: (selector: (s: { send: typeof send }) => unknown) => selector({ send }),
}));
vi.mock("../webview/src/i18n", () => ({
  t: (s: string, ...args: (string | number)[]) =>
    s.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)] ?? "")),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(diff: { path: string; oldText: string | null; newText: string | null }) {
  act(() => root.render(<DiffView diff={diff} />));
}

function rowIndices(): number[] {
  return [...container.querySelectorAll<HTMLElement>("[data-diff-row]")].map((n) =>
    Number(n.dataset.diffRow),
  );
}

function clickContaining(text: string): void {
  const btn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  expect(btn, `button containing ${text}`).toBeTruthy();
  act(() => btn!.click());
}

/** Every line differs → one change window with no gap rows → windowed path. */
function wholeFileDiff(lines = 1500) {
  return {
    path: "src/big.ts",
    oldText: Array.from({ length: lines }, (_, i) => `OLD_LINE_${i}`).join("\n"),
    newText: Array.from({ length: lines }, (_, i) => `NEW_LINE_${i}`).join("\n"),
  };
}

describe("DiffView windowed row recycling", () => {
  it("renders only the initial prefix and keeps numbering/text correct", () => {
    render(wholeFileDiff());
    const idx = rowIndices();
    expect(idx.length).toBe(800);
    expect(idx[0]).toBe(0);
    expect(idx.at(-1)).toBe(799);
    // No spacer/restore affordance before anything is recycled.
    expect(container.querySelector("[data-diff-spacer]")).toBeNull();
    expect(container.querySelector("[data-diff-restore]")).toBeNull();
    expect(container.textContent).toContain("_LINE_");
  });

  it("slides the window on repeated loads and never exceeds the DOM row cap", () => {
    render(wholeFileDiff());
    clickContaining("加载剩余"); // cap 800 -> 1600, recycle top 400
    expect(rowIndices().length).toBe(1200);
    clickContaining("加载剩余"); // cap 1600 -> 2400, recycle up to index 1200
    const idx = rowIndices();
    expect(idx.length).toBe(1200);
    expect(idx[0]).toBe(1200);
    expect(idx.at(-1)).toBe(2399);
    // Absolute indices stay consecutive — no dupes, no gaps, no renumbering.
    for (let k = 1; k < idx.length; k++) expect(idx[k]).toBe(idx[k - 1]! + 1);
    // Spacer + explicit restore affordance appear once rows were recycled.
    expect(container.querySelector("[data-diff-spacer]")).toBeTruthy();
    expect(container.querySelector("[data-diff-restore]")).toBeTruthy();
    // Row text is the real generated content, not fabricated.
    expect(container.textContent).toContain("_LINE_");
  });

  it("restores recycled rows above the window while staying capped", () => {
    render(wholeFileDiff());
    clickContaining("加载剩余");
    clickContaining("加载剩余");
    clickContaining("加载上方");
    const idx = rowIndices();
    expect(idx.length).toBeLessThanOrEqual(1200);
    expect(idx[0]).toBe(800);
    expect(idx.at(-1)).toBe(1999);
    for (let k = 1; k < idx.length; k++) expect(idx[k]).toBe(idx[k - 1]! + 1);
  });

  it("leaves folded diffs (with expandable gaps) on the original prefix path", () => {
    const lines = 1200;
    const oldLines = Array.from({ length: lines }, (_, i) => (i === 600 ? "BEFORE" : `SAME_${i}`));
    const newLines = Array.from({ length: lines }, (_, i) => (i === 600 ? "AFTER" : `SAME_${i}`));
    render({
      path: "src/fold.ts",
      oldText: oldLines.join("\n"),
      newText: newLines.join("\n"),
    });
    // Gap rows exist → windowing is disabled, so no spacer/restore controls.
    expect(container.querySelector("[data-diff-spacer]")).toBeNull();
    expect(container.querySelector("[data-diff-restore]")).toBeNull();
    expect(container.textContent).toContain("展开上下文");
  });
});
