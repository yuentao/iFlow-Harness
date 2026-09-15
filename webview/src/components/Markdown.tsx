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

// Trailing copy icon appended inline to the markdown's last element — follows
// the text end like a tiny action icon instead of an overlay/extra row.
const COPY_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const REGEN_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>';

export function Markdown({
  text,
  showCopyIcon = false,
  onRegenerate,
}: {
  text: string;
  showCopyIcon?: boolean;
  onRegenerate?: () => void;
}) {
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
  // Trailing action icons are appended INLINE to the last element of the
  // markdown so they follow the text end (no overlay, no extra row).
  // Idempotent ensure: EVERY render re-checks (one cheap querySelector) —
  // React rewrites innerHTML whenever the html STRING differs and wipes the
  // injected icons, and an html-only deps effect misses renders where the
  // string stayed identical after such a wipe (icons vanished after
  // streaming). Per-render ensure guarantees they come back.
  const ensureInjected = () => {
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

    if (showCopyIcon) {
      const last = root.lastElementChild;
      if (last && !last.querySelector(":scope > button[data-role='copy-msg']")) {
        if (onRegenerateRef.current) {
          const regen = document.createElement("button");
          regen.type = "button";
          regen.className = "copy-msg-btn";
          regen.dataset.role = "regen-msg";
          regen.title = "重新生成";
          regen.setAttribute("aria-label", "重新生成");
          regen.innerHTML = REGEN_ICON_SVG;
          last.appendChild(regen);
        }
        const icon = document.createElement("button");
        icon.type = "button";
        icon.className = "copy-msg-btn";
        icon.dataset.role = "copy-msg";
        icon.title = "复制";
        icon.setAttribute("aria-label", "复制全文");
        icon.innerHTML = COPY_ICON_SVG;
        last.appendChild(icon);
      }
    }
  };

  useEffect(ensureInjected);

  // P2-2 event delegation: ONE click listener on the container handles every
  // copy button (past and future), instead of a per-button listener plus a
  // fresh querySelectorAll pass on every html change during streaming. The
  // delegated handler reads the sibling <pre> at click time.
  const textRef = useRef(text);
  textRef.current = text;
  const onRegenerateRef = useRef(onRegenerate);
  onRegenerateRef.current = onRegenerate;
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const regenBtn = target.closest<HTMLElement>("button[data-role='regen-msg']");
      if (regenBtn) {
        // Trailing regenerate icon (latest turn only): re-runs the preceding
        // user prompt via the host callback.
        onRegenerateRef.current?.();
        return;
      }
      const msgBtn = target.closest<HTMLElement>("button[data-role='copy-msg']");
      if (msgBtn) {
        // Trailing message icon: copies the whole block text (same payload as
        // the old button); swaps to a check icon briefly for feedback.
        void copyText(textRef.current).then(
          () => {
            msgBtn.innerHTML = CHECK_ICON_SVG;
            msgBtn.classList.add("copied");
            window.setTimeout(() => {
              msgBtn.innerHTML = COPY_ICON_SVG;
              msgBtn.classList.remove("copied");
            }, 1500);
          },
          () => undefined,
        );
        return;
      }
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

  // MutationObserver guard: React rewrites dangerouslySetInnerHTML whenever
  // the html string differs, wiping the injected icons; the per-render
  // ensure misses wipes that land between renders (React.memo(BlockView)
  // skips re-renders, so no effect runs to re-inject). Observe the container
  // and re-inject on any childList wipe — the ensure is idempotent so this
  // converges instead of looping.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const observer = new MutationObserver(() => {
      if (showCopyIcon && !root.querySelector("button[data-role='copy-msg']")) {
        ensureInjected();
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [showCopyIcon]);

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