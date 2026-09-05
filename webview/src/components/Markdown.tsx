import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useChat } from "../store";

marked.setOptions({ gfm: true, breaks: true });

// Links open in the system browser via the host (VSCode webviews cannot
// navigate themselves). Intercept clicks here.
export function Markdown({ text }: { text: string }) {
  const send = useChat((s) => s.send);
  const html = useMemo(
    () =>
      DOMPurify.sanitize(marked.parse(text, { async: false }) as string, {
        ADD_ATTR: ["target"],
      }),
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
