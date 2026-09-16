// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ErrorBoundary } from "../webview/src/components/ErrorBoundary";

/**
 * ErrorBoundary regression tests — the white-out fix: a render-phase throw
 * used to unmount the entire React tree (panel collapsed to the bare body
 * gradient until the tab was reopened). The boundary must instead render a
 * fallback, log the stack, recover via the 重试 button, and auto-retry when
 * `resetKey` changes (the next host snapshot/blockPatch).
 */

declare global {
  // React 19 act() environment flag (react-dom/client in tests).
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // React logs caught errors through console.error; silence them and assert
  // the boundary's own "[iflow] render error" line separately.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  consoleError.mockRestore();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

function render(ui: ReactNode): void {
  act(() => root.render(ui));
}

/** Child that throws while `boom` is true — mimics a markdown parse failing
 * on one transient streaming chunk, then succeeding on the next patch. */
function Flaky({ boom, resetKey }: { boom: boolean; resetKey: unknown }) {
  return (
    <ErrorBoundary resetKey={resetKey}>
      {boom ? <ThrowsOnce /> : <p>ok</p>}
    </ErrorBoundary>
  );
}

function ThrowsOnce(): ReactNode {
  throw new Error("boom");
}

describe("ErrorBoundary", () => {
  it("renders children normally when nothing throws", () => {
    render(<Flaky boom={false} resetKey={1} />);
    expect(container.textContent).toContain("ok");
    expect(container.textContent).not.toContain("消息区渲染异常");
  });

  it("catches a render-phase throw and shows the fallback instead of unmounting", () => {
    render(<Flaky boom={true} resetKey={1} />);
    // Fallback is mounted in place of the throwing subtree…
    expect(container.textContent).toContain("消息区渲染异常");
    expect(container.textContent).not.toContain("ok");
    // …and the stack is logged for root-cause follow-up (webview devtools).
    const logged = consoleError.mock.calls.map((c) => String(c[0]));
    expect(logged.some((m) => m.includes("[iflow] render error"))).toBe(true);
  });

  it("renders the full-screen fallback for variant=page", () => {
    render(
      <ErrorBoundary variant="page">
        <ThrowsOnce />
      </ErrorBoundary>,
    );
    expect(container.textContent).toContain("界面渲染异常");
  });

  it("recovers via the 重试 button once the child stops throwing", () => {
    render(<Flaky boom={true} resetKey={1} />);
    expect(container.textContent).toContain("消息区渲染异常");

    // Host pushes a new snapshot: the throwing chunk is gone (boom=false).
    // The boundary still shows the fallback until retried.
    render(<Flaky boom={false} resetKey={1} />);
    expect(container.textContent).toContain("消息区渲染异常");

    const retry = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("重试"),
    );
    expect(retry).toBeDefined();
    act(() => retry!.click());
    expect(container.textContent).toContain("ok");
    expect(container.textContent).not.toContain("消息区渲染异常");
  });

  it("auto-retries when resetKey changes (streaming self-heal)", () => {
    render(<Flaky boom={true} resetKey={1} />);
    expect(container.textContent).toContain("消息区渲染异常");

    // Next blockPatch: new state reference (resetKey bumps) AND the bad chunk
    // is gone — componentDidUpdate must clear the error and re-render children.
    render(<Flaky boom={false} resetKey={2} />);
    expect(container.textContent).toContain("ok");
    expect(container.textContent).not.toContain("消息区渲染异常");
  });

  it("re-catches when the retry still throws (no crash loop past the boundary)", () => {
    render(<Flaky boom={true} resetKey={1} />);
    expect(container.textContent).toContain("消息区渲染异常");

    // resetKey bumps but the content still throws → fallback stays mounted.
    render(<Flaky boom={true} resetKey={2} />);
    expect(container.textContent).toContain("消息区渲染异常");
  });

  it("a state update inside a healthy subtree is unaffected by the boundary", () => {
    function Counter() {
      const [n, setN] = useState(0);
      return <button onClick={() => setN(n + 1)}>count {n}</button>;
    }
    render(
      <ErrorBoundary resetKey={1}>
        <Counter />
      </ErrorBoundary>,
    );
    const btn = container.querySelector("button")!;
    act(() => btn.click());
    expect(container.textContent).toContain("count 1");
  });
});
