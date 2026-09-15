import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useChat } from "../store";

marked.setOptions({ gfm: true, breaks: true });

/**
 * P2-2 streaming markdown throttle: the streaming tail re-renders up to
 * 12.5/s, and each render re-parses + re-sanitizes the WHOLE block text
 * (O(size) — a long answer accumulates into tens of KB). Parse rate is
 * throttled by text length tier: short text (fast) stays live, long text
 * drops to 400ms so the parse work stays bounded while tokens stream.
 */
const PARSE_THROTTLE_MS = (chars: number): number => {
  if (chars <= 2_000) return 0;
  if (chars <= 8_000) return 200;
  return 400;
};

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
export function copyText(text: string): Promise<void> {
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
  // Throttled text: during streaming the block grows every ~80ms; parse the
  // rendered content at the tier's cadence instead. Completed blocks (text
  // stable for the throttle window) always converge to the final content.
  const [renderText, setRenderText] = useState(text);
  const lastSet = useRef(Date.now());
  const pending = useRef(false);
  useEffect(() => {
    const throttle = PARSE_THROTTLE_MS(text.length);
    if (throttle === 0) {
      pending.current = false;
      setRenderText(text);
      return;
    }
    const elapsed = Date.now() - lastSet.current;
    if (elapsed >= throttle) {
      lastSet.current = Date.now();
      setRenderText(text);
      return;
    }
    if (pending.current) return;
    pending.current = true;
    const timer = window.setTimeout(() => {
      pending.current = false;
      lastSet.current = Date.now();
      setRenderText(text);
    }, throttle - elapsed);
    return () => window.clearTimeout(timer);
  }, [text]);
  // Converge on unmount: never leave a stale throttled render behind.
  useEffect(() => {
    return () => {
      if (pending.current) setRenderText(text);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount only
  }, []);
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(renderText, { async: false }) as string, SANITIZE_CONFIG),
    [renderText],
  );

  // Fenced code blocks get a copy button. The HTML is set via
  // dangerouslySetInnerHTML (no React handlers), so we wrap each <pre> in a
  // .code-block and pin the button to its corner — that way the button stays
  // put while the <pre> scrolls. The wrapper injection only processes pres
  // that are not yet wrapped (the guard prevents duplicates after React
  // re-sets innerHTML during streaming).
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll("pre").forEach((pre) => {
      if (pre.parentElement?.classList.contains("code-block")) return;
      const wrap = document.createElement("div");
      wrap.className = "code-block";
      pre.parentNode?.insertBefore(wrap, pre);
      wrap.appendChild(pre);

      // Language label from marked's `language-xxx` class on the <code>.
      const code = pre.querySelector("code");
      const lang = code?.className.match(/language-([\w+-]+)/)?.[1];
      if (lang) {
        const label = document.createElement("span");
        label.className = "code-lang";
        label.textContent = lang;
        wrap.appendChild(label);
        wrap.classList.add("has-lang");
      }

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "copy-btn";
      btn.setAttribute("aria-label", "复制代码");
      btn.textContent = "复制";
      btn.dataset.role = "copy-code";
      wrap.appendChild(btn);
    });
  }, [html]);

  // P2-2 event delegation: ONE click listener on the container handles every
  // copy button (past and future), instead of a per-button listener plus a
  // fresh querySelectorAll pass on every html change during streaming. The
  // delegated handler reads the sibling <pre> at click time.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const btn = target.closest<HTMLElement>("button[data-role='copy-code']");
      if (!btn) return;
      const code = btn.parentElement?.querySelector("pre code")?.textContent ?? "";
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
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, []);

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