import { describe, it, expect } from "vitest";
import { renderCodeBlock } from "../webview/src/highlight";

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
