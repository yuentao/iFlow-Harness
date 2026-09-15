import { useEffect, useMemo, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useChat } from "../store";

marked.setOptions({ gfm: true, breaks: true });

// W1: tightened config. `target` never had an effect (clicks are intercepted
// and routed through openExternal); iframe/form/style are forbidden
// explicitly to survive upstream default changes — style injection used to
// rely entirely on DOMPurify's default attribute allowlist.
const SANITIZE_CONFIG = {
  FORBID_TAGS: ["iframe", "form"],
  FORBID_ATTR: ["style", "target"],
};

// Copy helper: prefer the async Clipboard API; fall back to a hidden textarea
// for webview contexts where the API is unavailable.
function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
  return Promise.resolve();
}

// Links open in the system browser via the host (VSCode webviews cannot
// navigate themselves). Intercept clicks here.
export function Markdown({ text }: { text: string }) {
  const send = useChat((s) => s.send);
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { async: false }) as string, SANITIZE_CONFIG),
    [text],
  );

  // Fenced code blocks get a copy button. The HTML is set via
  // dangerouslySetInnerHTML (no React handlers), so we wrap each <pre> in a
  // .code-block and pin the button to its corner — that way the button stays
  // put while the <pre> scrolls. Re-runs on every render; the wrapper guard
  // prevents duplicate buttons after React re-sets innerHTML during streaming.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll("pre").forEach((pre) => {
      if (pre.parentElement?.classList.contains("code-block")) return;
      const wrap = document.createElement("div");
      wrap.className = "code-block";
      pre.parentNode?.insertBefore(wrap, pre);
      wrap.appendChild(pre);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "copy-btn";
      btn.setAttribute("aria-label", "复制代码");
      btn.textContent = "复制";
      btn.addEventListener("click", () => {
        const code = pre.querySelector("code")?.textContent ?? "";
        copyText(code).then(
          () => {
            btn.textContent = "已复制";
            window.setTimeout(() => {
              btn.textContent = "复制";
            }, 1500);
          },
          () => {
            btn.textContent = "失败";
            window.setTimeout(() => {
              btn.textContent = "复制";
            }, 1500);
          },
        );
      });
      wrap.appendChild(btn);
    });
  }, [html]);

  return (
    <div
      ref={ref}
      className="md"
      onClick={(e) => {
        const anchor = (e.target as HTMLElement).closest("a");
        if (!anchor) return;
        e.preventDefault();
        const href = anchor.getAttribute("href");
        if (href && /^https?:\/\//.test(href)) send({ type: "openExternal", uri: href });
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}