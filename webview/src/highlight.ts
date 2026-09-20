import hljs from "highlight.js/lib/common";

/**
 * Fenced code block syntax highlighting (highlight.js `common` subset — ~40
 * languages, covers every fence the agent realistically emits). Token colors
 * come from the `--syn-*` design tokens in styles.css (no hljs theme CSS is
 * imported), so highlighting follows the host-pushed light/dark theme.
 *
 * The renderer runs INSIDE the marked parse, and its output passes through
 * DOMPurify together with the rest of the markdown (`span`/`class` are in
 * DOMPurify's default allowlist), so untrusted fence content stays sanitized.
 */

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * marked `renderer.code` implementation. `lang` is the fence infostring
 * (first word is the language id; trailing `{1,3}`-style attributes are
 * dropped). Returns `false` only on a highlighter throw, letting marked fall
 * back to its default renderer — unknown languages still render escaped and
 * keep the `language-xxx` class so the badge in Markdown.tsx works.
 */
export function renderCodeBlock(text: string, lang: string | null | undefined): string | false {
  const id = (lang ?? "").split(/\s+/)[0] ?? "";
  const langClass = id ? ` language-${escapeHtml(id)}` : "";
  const grammar = id && hljs.getLanguage(id);
  if (!grammar) {
    return `<pre><code class="hljs${langClass}">${escapeHtml(text)}</code></pre>\n`;
  }
  try {
    const highlighted = hljs.highlight(text, { language: id, ignoreIllegals: true }).value;
    return `<pre><code class="hljs${langClass}">${highlighted}</code></pre>\n`;
  } catch {
    return false;
  }
}
