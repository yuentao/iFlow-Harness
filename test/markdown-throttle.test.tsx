// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "../webview/src/components/Markdown";

const send = vi.hoisted(() => vi.fn());
const useChat = vi.hoisted(() =>
  Object.assign(
    (selector: (state: { send: typeof send }) => unknown) => selector({ send }),
    { getState: () => ({ send }) },
  ),
);
vi.mock("../webview/src/store", () => ({ useChat }));

/** React 19 refuses `act()` unless the environment declares itself act-capable. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * P2-2 streaming throttle must never swallow the FINAL update.
 *
 * The throttle parses long text at a reduced cadence (>2000 chars → 200ms,
 * >8000 → 400ms). The regression this file pins down: the previous effect
 * armed a trailing timer only once (`pending` early-return). Every new text
 * chunk re-ran the effect, whose cleanup cancelled that timer, and the
 * early-return then declined to arm a new one — so the moment the stream
 * stopped, no timer was left and the last chunk never rendered (the block
 * looked truncated even though `block.text` was complete, which is also why
 * copy produced the full text).
 */

/** ~3000 chars: the 200ms tier, so every update is throttled. */
const LONG_PREFIX = "streaming markdown body ".repeat(120);

describe("Markdown streaming throttle", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container.remove();
    vi.useRealTimers();
  });

  const paint = (text: string): void => {
    const target = root;
    if (!target) throw new Error("root already unmounted");
    act(() => target.render(createElement(Markdown, { text })));
  };

  it("renders the final text when the stream stops before the timer fires", () => {
    paint(`${LONG_PREFIX}TAIL-A`);
    expect(container.textContent).toContain("TAIL-A");

    // A newer chunk arrives while the trailing timer is still armed. React
    // runs the previous effect's cleanup (clearTimeout) before this one.
    paint(`${LONG_PREFIX}TAIL-B`);

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(container.textContent).toContain("TAIL-B");
    expect(container.textContent).not.toContain("TAIL-A");
  });

  it("converges on the newest text after several rapid updates", () => {
    paint(`${LONG_PREFIX}T1`);
    paint(`${LONG_PREFIX}T2`);
    paint(`${LONG_PREFIX}T3`);

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(container.textContent).toContain("T3");
    expect(container.textContent).not.toContain("T2");
  });

  it("renders short text immediately without waiting for a timer", () => {
    paint(`${LONG_PREFIX}TAIL-LONG`);
    paint("short TAIL-SHORT");

    // No timer advance: the ≤2000-char tier renders synchronously.
    expect(container.textContent).toContain("TAIL-SHORT");
    expect(container.textContent).not.toContain("TAIL-LONG");
  });

  it("flushes a pending update on unmount without throwing", () => {
    paint(`${LONG_PREFIX}TAIL-UNMOUNT-A`);
    paint(`${LONG_PREFIX}TAIL-UNMOUNT-B`);

    const target = root;
    if (!target) throw new Error("root missing");
    expect(() => act(() => target.unmount())).not.toThrow();
    root = null;

    // A timer that outlived the unmount must not touch a dead tree.
    expect(() =>
      act(() => {
        vi.advanceTimersByTime(500);
      }),
    ).not.toThrow();
  });
});
