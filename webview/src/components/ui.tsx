import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileCode2 } from "lucide-react";
import { useChat } from "../store";

/* Shared visual primitives ported from the UI reference design. */

/**
 * Fuzzy match score for dropdown search (model list etc.): higher ranks
 * first, null = no match. Case-insensitive subsequence — "g53f" matches
 * "glm-5.3-flash-free". Ranking prefers substring hit > boundary-anchored
 * characters > scattered subsequence; contiguous runs and shorter targets
 * rank higher. Empty query matches everything with score 0.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) return 0;
  const exact = t.indexOf(q);
  if (exact >= 0) return 1000 - exact * 10 - Math.min(t.length, 100);
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi]!, ti);
    if (found < 0) return null;
    if (found === prev + 1) score += 20; // contiguous run bonus
    if (found === 0 || /[^a-z0-9]/.test(t[found - 1]!)) score += 10; // boundary bonus
    prev = found;
    ti = found + 1;
  }
  return score + 100 - Math.min(t.length, 100); // subsequence baseline + shorter-target bonus
}

const CHIP_TONES: Record<string, string> = {
  muted: "bg-surface text-muted-foreground",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-destructive/15 text-destructive",
  primary: "bg-primary/18 text-primary",
  info: "bg-info/15 text-info",
};

export function Chip({
  children,
  tone = "muted",
  className = "",
}: {
  children: ReactNode;
  tone?: "muted" | "success" | "warning" | "danger" | "primary" | "info";
  className?: string;
}) {
  return (
    <span
      className={`chip-fade inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-[2px] text-[10px] font-medium tracking-wide transition-colors duration-300 ${CHIP_TONES[tone]}${className ? ` ${className}` : ""}`}
    >
      {children}
    </span>
  );
}

/** Clickable file reference that opens the location in the editor. */
export function FileRef({ path, line }: { path: string; line?: number | null }) {
  const send = useChat((s) => s.send);
  return (
    <button
      className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-sm font-mono text-[11px] text-info underline decoration-info/30 underline-offset-2 hover:decoration-info"
      title={path}
      onClick={(e) => {
        e.preventDefault();
        send({ type: "openLocation", path, line });
      }}
    >
      <FileCode2 className="size-3 shrink-0" />
      <span className="truncate">{path.split(/[\\/]/).pop()}</span>
    </button>
  );
}

/**
 * Minimal popover menu: trigger + content render props, closes on outside
 * click / Escape. Opens upward for composer dropdowns, downward in the header.
 */
export function Dropdown({
  trigger,
  direction = "down",
  align = "left",
  menuClass = "",
  /** Classes for the shell div — needed when a trigger uses flex-1/truncate:
   * the wrapper is the flex item, so without min-w-0 it ignores the trigger's
   * shrink chain and long content stretches the whole parent row. */
  wrapperClass = "",
  /** Open-state change notification (true = opening). Lets callers refresh
   * data at open time (auth profile list, live model list). */
  onOpenChange,
  children,
}: {
  trigger: (open: boolean) => ReactNode;
  direction?: "down" | "up";
  align?: "left" | "right";
  menuClass?: string;
  wrapperClass?: string;
  onOpenChange?: (open: boolean) => void;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  /** Close + notify. Every close path (trigger toggle, selection via the
   * `close` render arg, outside click, Escape) must fire onOpenChange(false) —
   * callers reset per-open state there (e.g. the model search query); only
   * notifying on the trigger-toggle path left stale query/filter on reopen. */
  const closeAndNotify = () => {
    setOpen(false);
    onOpenChange?.(false);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeAndNotify();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // ESC 只关下拉：拦下事件，防止冒泡到 window 的「ESC 停止生成」。
        e.stopPropagation();
        closeAndNotify();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // closeAndNotify closes over onOpenChange, which callers may pass inline;
    // the listeners are only active while open, so re-registering on toggles
    // keeps the closure current.
  }, [open, onOpenChange]);

  return (
    <div className={`relative${wrapperClass ? ` ${wrapperClass}` : ""}`} ref={ref}>
      {/* The click proxy must constrain its child the same way the wrapper
          does: as a plain block it lets a long trigger label stretch the
          button far beyond the wrapper width (flex-1 inside is inert). */}
      <div
        className={wrapperClass.includes("flex-1") ? "flex min-w-0" : ""}
        onClick={() => {
          // Discrete toggle (not inside the setState updater): React StrictMode
          // may invoke updaters twice, which would double-fire onOpenChange.
          const next = !open;
          setOpen(next);
          onOpenChange?.(next);
        }}
      >
        {trigger(open)}
      </div>
      {open && (
        <div
          className={`absolute z-30 overflow-hidden rounded-lg border border-border bg-popover panel-shadow ${
            direction === "up" ? "bottom-full mb-1" : "top-full mt-1"
          } ${align === "right" ? "right-0" : "left-0"} ${menuClass}`}
        >
          {children(closeAndNotify)}
        </div>
      )}
    </div>
  );
}