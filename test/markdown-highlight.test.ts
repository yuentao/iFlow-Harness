// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { describe, it, expect, vi } from "vitest";
import { renderCodeBlock } from "../webview/src/highlight";
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
 * Fenced code block highlighting (webview/src/highlight.ts): known languages
 * get hljs token spans, unknown languages render escaped-but-unhighlighted,
 * and neither path may let raw HTML from the fence content or the infostring
 * leak into the output (the result is DOMPurify-sanitized downstream, but the
 * renderer itself must still be injection-safe).
 */

describe("renderCodeBlock", () => {
  it("highlights json with token spans and keeps the language class", () => {
    const html = renderCodeBlock('{"a": 1, "b": "x"}', "json");
    expect(html).not.toBe(false);
    const out = html as string;
    expect(out).toContain('class="hljs language-json"');
    expect(out).toContain("hljs-attr"); // "a" / "b" keys
    expect(out).toContain("hljs-number"); // 1
    expect(out).toContain("hljs-string"); // "x"
  });

  it("highlights typescript keywords and comments", () => {
    const html = renderCodeBlock('// hi\nconst n: number = 1;\nfunction f() { return n; }', "ts");
    expect(html).not.toBe(false);
    const out = html as string;
    expect(out).toContain('class="hljs language-ts"');
    expect(out).toContain("hljs-comment");
    expect(out).toContain("hljs-keyword");
    expect(out).toContain("hljs-number");
  });

  it("renders unknown languages escaped without token spans, keeping the badge class", () => {
    const html = renderCodeBlock("a < b && c", "notalang");
    expect(html).not.toBe(false);
    const out = html as string;
    expect(out).toContain('class="hljs language-notalang"');
    expect(out).toContain("a &lt; b &amp;&amp; c");
    expect(out).not.toContain("hljs-keyword");
  });

  it("uses only the first word of the infostring (drops {1,3}-style attrs)", () => {
    const html = renderCodeBlock('{"a": 1}', "json {1}");
    expect(html).not.toBe(false);
    const out = html as string;
    expect(out).toContain('class="hljs language-json"');
    expect(out).toContain("hljs-attr");
  });

  it("escapes raw html in the code content for known languages", () => {
    const html = renderCodeBlock('const s = "<img src=x onerror=alert(1)>";', "js");
    expect(html).not.toBe(false);
    const out = html as string;
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });

  it("escapes quotes in the infostring-derived class", () => {
    const html = renderCodeBlock("x", 'notalang"><script>');
    expect(html).not.toBe(false);
    const out = html as string;
    expect(out).not.toContain("<script>");
    expect(out).toContain("&quot;");
    expect(out).toContain("&gt;");
  });

  it("handles empty language id (plain fence)", () => {
    const html = renderCodeBlock("plain <text>", "");
    expect(html).not.toBe(false);
    const out = html as string;
    expect(out).toContain('class="hljs"');
    expect(out).toContain("plain &lt;text&gt;");
  });
});

/**
 * Behaviour half: the Markdown component's code fences keep the syntax
 * highlighting, and the stylesheet gives every markdown code block the
 * agreed treatment — no plate behind the rows (the tokens carry the only
 * color) and soft-wrapped lines instead of a horizontal scroll.
 */
describe("Markdown code fences", () => {
  const FENCE = "```ts\nconst n: number = 1;\n```";

  const render = (): HTMLElement => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(createElement(Markdown, { text: FENCE }));
    });
    return container;
  };

  it("keeps the syntax highlighting", () => {
    const container = render();
    expect(container.querySelector("pre code .hljs-keyword")).toBeTruthy();
    expect(container.querySelector("pre code .hljs-number")).toBeTruthy();
  });

  it("drops the row plate and soft-wraps every markdown code block", () => {
    const css = readFileSync(join(__dirname, "..", "webview", "src", "styles.css"), "utf8");
    const rule = css.match(/\.md pre\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/background:\s*transparent/);
    expect(rule).toMatch(/white-space:\s*pre-wrap/);
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
