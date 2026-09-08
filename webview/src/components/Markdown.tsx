import { useMemo } from "react";
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

// Links open in the system browser via the host (VSCode webviews cannot
// navigate themselves). Intercept clicks here.
export function Markdown({ text }: { text: string }) {
  const send = useChat((s) => s.send);
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { async: false }) as string, SANITIZE_CONFIG),
    [text],
  );
  return (
    <div
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
