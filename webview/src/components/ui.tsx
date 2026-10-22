import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Brain,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  Eye,
  EyeOff,
  FileCode2,
  HelpCircle,
  Info,
  Loader2,
  Search,
  Square,
  X,
  XCircle,
} from "lucide-react";
import { useChat, type ToastItem } from "../store";
import { t } from "../i18n";

/* Shared visual primitives ported from the UI reference design. */

/** Visible, non-disabled focusable elements within a container (focus trap + initial focus). */
export function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.offsetParent !== null);
}

/**
 * Open-modal stack (mount order = z-order for same-layer modals). ModalShell's
 * ESC/Tab handling is document-level; when a ConfirmDialog stacks on the
 * settings modal, only the TOP instance may react — otherwise one ESC closes
 * both layers and the two focus traps fight over Tab.
 */
const modalStack: symbol[] = [];

/**
 * Shared centered-modal shell for the settings surface (API config / MCP
 * servers / approval policies / profile-switch). Converges the backdrop,
 * ESC-to-close, Tab focus trap, mount-focus + unmount-restore, and the header
 * (optional back arrow + icon + title + close button) that the four cards
 * previously each re-implemented with subtly different behavior — a major
 * source of the settings版块's "every dialog feels different" fragmentation.
 *
 * - `onClose`: ESC / backdrop click / header X. The profile-switch dialog
 *   passes its cancel handler here (Esc == cancel the whole switch).
 * - `onBack`: when set, the header shows a back arrow instead of the icon
 *   (list ⇄ editor navigation inside a section).
 * - `dismissible`: false suppresses the X and the backdrop/Esc close (the
 *   mandatory unauthenticated setup view).
 * - `initialFocus`: "input" (default) focuses the first text control; "first"
 *   focuses the first focusable (choice dialogs).
 */
export function ModalShell({
  title,
  icon,
  onClose,
  onBack,
  onEscape,
  dismissible = true,
  ariaLabel,
  role = "dialog",
  initialFocus = "input",
  wide = false,
  className,
  footer,
  children,
}: {
  title: ReactNode;
  icon?: ReactNode;
  onClose: () => void;
  onBack?: (() => void) | null;
  /** Overrides ESC (e.g. settings sub-pages: Esc goes back, not close). */
  onEscape?: () => void;
  dismissible?: boolean;
  ariaLabel: string;
  role?: "dialog" | "alertdialog";
  initialFocus?: "input" | "first";
  wide?: boolean;
  /** Extra class on the modal surface (e.g. the settings modal's width). */
  className?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  // Stack token: stable per mount, identifies this modal in modalStack.
  const stackToken = useRef(Symbol("modal"));
  useEffect(() => {
    const token = stackToken.current;
    modalStack.push(token);
    const prevFocus = document.activeElement as HTMLElement | null;
    const container = backdropRef.current;
    if (container) {
      const focusables = getFocusable(container);
      // A section can pin the initial focus with data-autofocus (e.g. the
      // primary option of a choice dialog — without it "first" lands on the
      // header's close button, which DOM-orders before the body).
      const pinned = container.querySelector<HTMLElement>("[data-autofocus]");
      if (pinned && focusables.includes(pinned)) {
        pinned.focus();
      } else if (initialFocus === "input") {
        (focusables.find((el) => el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") ??
          focusables[0])?.focus();
      } else {
        focusables[0]?.focus();
      }
    }
    return () => {
      const at = modalStack.indexOf(token);
      if (at >= 0) modalStack.splice(at, 1);
      prevFocus?.focus?.();
    };
    // Mount-only: the trap must not re-steal focus when the content re-renders.
  }, []);

  useEffect(() => {
    // Document-level ESC/Tab handling: the old per-div onKeyDown missed keys
    // whenever focus sat outside the modal (e.g. right after clicking a
    // button that unmounted — focus falls back to body, which never bubbles
    // through the backdrop). Registered on mount only; ESC must
    // stopPropagation so the window's "Esc stops generation" listener never
    // sees it.
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const container = backdropRef.current;
      if (!container) return;
      // Only the topmost open modal reacts (see modalStack).
      if (modalStack[modalStack.length - 1] !== stackToken.current) return;
      if (e.key === "Escape") {
        // A non-dismissible modal still owns ESC: swallow it so the global
        // "Esc stops generation" shortcut cannot fire behind the modal.
        e.preventDefault();
        e.stopPropagation();
        if (onEscape) onEscape();
        else if (dismissible) onClose();
        return;
      }
      if (e.key === "Tab") {
        const inside = container.contains(document.activeElement);
        const focusables = getFocusable(container);
        if (focusables.length === 0) return;
        if (!inside) {
          // Focus escaped the modal (unmounted trigger, editor click): pull it back.
          e.preventDefault();
          focusables[0]!.focus();
          return;
        }
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // onClose/onEscape close over section state (e.g. the settings shell's
    // sectionHeader); re-registering keeps the closures current.
  }, [dismissible, onClose, onEscape]);

  return (
    <div
      ref={backdropRef}
      className="auth-backdrop"
      role={role}
      aria-modal="true"
      aria-label={ariaLabel}
      tabIndex={-1}
      onMouseDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`auth-modal acrylic-pop${wide ? " auth-modal-wide @container" : ""}${className ? ` ${className}` : ""}`}>
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-panel/50 px-3 py-2 backdrop-blur-md">
          {onBack ? (
            <button
              type="button"
              className="press -ml-1 shrink-0 rounded p-0.5 text-muted-foreground transition-colors duration-200 hover:text-foreground"
              title={t("返回列表")}
              aria-label={t("返回列表")}
              onClick={onBack}
            >
              <ArrowLeft className={ICON_INLINE} />
            </button>
          ) : (
            icon
          )}
          <span className="min-w-0 truncate text-ui-title font-semibold">{title}</span>
          {dismissible && (
            <button
              type="button"
              className="press ml-auto shrink-0 rounded p-0.5 text-muted-foreground transition-colors duration-200 hover:text-foreground"
              title={t("收起")}
              aria-label={t("收起")}
              onClick={onClose}
            >
              <X className={ICON_INLINE} />
            </button>
          )}
        </div>
        {children}
        {footer}
      </div>
    </div>
  );
}

/**
 * Live countdown to a deadline (epoch ms). Re-renders once per second while
 * pending; the ratio (remaining / original window) feeds a proportional bar.
 * The interval is keyed on `deadline` so a fresh card restarts the clock.
 */
export function useCountdown(deadline: number, timeoutMs: number): {
  remainingMs: number;
  ratio: number;
} {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  const remainingMs = Math.max(0, deadline - now);
  const ratio = timeoutMs > 0 ? Math.min(1, Math.max(0, remainingMs / timeoutMs)) : 0;
  return { remainingMs, ratio };
}

/** "mm:ss" countdown text (tabular so the digits don't jitter). */
export function formatCountdown(remainingMs: number): string {
  const totalSec = Math.ceil(remainingMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Auto-expiry indicator for approval/question cards: a thin proportional bar
 * plus the remaining time. Turns warning (≤60s) then destructive (≤15s) so
 * the user can see at a glance that a card is about to auto-answer.
 *
 * Progressive disclosure: a strip that shrinks every second for five minutes
 * manufactures urgency on a decision that is not actually time-critical. While
 * the window is still minutes away it is replaced by one muted caption line
 * (pass `quietLabel`, e.g. t("自动拒绝")); the bar only joins in the final
 * minute, where reading it changes what the user does next.
 */
export function CountdownBar({
  deadline,
  timeoutMs,
  quietLabel,
}: {
  deadline: number;
  timeoutMs: number;
  /** Translated auto-action phrase for the quiet line (t("自动拒绝") etc.). */
  quietLabel?: string;
}) {
  const { remainingMs, ratio } = useCountdown(deadline, timeoutMs);
  const urgent = remainingMs <= 15_000;
  const warning = remainingMs <= 60_000;
  if (quietLabel && !warning) {
    return (
      <p className="px-3 pb-2 text-ui-caption leading-snug text-muted-foreground/70">
        {t("约 {0} 分钟后{1}", Math.ceil(remainingMs / 60_000), quietLabel)}
      </p>
    );
  }
  const barColor = urgent ? "bg-destructive" : warning ? "bg-warning" : "bg-primary";
  const textClass = urgent ? "text-destructive" : warning ? "text-warning" : "text-muted-foreground";
  return (
    <div className="flex items-center gap-2 px-3 pb-2">
      <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-border/40">
        <div
          className={`h-full rounded-full transition-[width] duration-1000 ease-linear ${barColor}`}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      <span
        className={`shrink-0 font-mono text-ui-caption tabular-nums transition-colors duration-300 ${textClass}`}
      >
        {formatCountdown(remainingMs)}
      </span>
    </div>
  );
}

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
  title,
  truncate = false,
}: {
  children: ReactNode;
  tone?: "muted" | "success" | "warning" | "danger" | "primary" | "info";
  className?: string;
  /** Optional hover explanation — a chip is too small to carry its own caveat. */
  title?: string;
  /** Let the chip shrink and ellipsize its label. Use for dynamic values in
   * tight rows (e.g. a subagent type); static chips keep their shrink-0. */
  truncate?: boolean;
}) {
  return (
    <span
      title={title}
      className={`chip-fade inline-flex ${truncate ? "min-w-0" : "shrink-0"} items-center gap-1 rounded-full px-2 py-0.5 text-ui-caption font-medium tracking-wide transition-colors duration-300 ${CHIP_TONES[tone]}${className ? ` ${className}` : ""}`}
    >
      {truncate ? <span className="truncate">{children}</span> : children}
    </span>
  );
}

/**
 * Small `?` help affordance: hover/focus opens a `role="tooltip"` bubble.
 * The bubble is portaled to document.body and placed in viewport coordinates
 * (clamped inside the viewport, flipping above the trigger when the bottom
 * edge runs out) — cards, settings groups and scroll containers all carry
 * overflow-hidden clips that sheared the old in-subtree absolute bubble at
 * card/panel edges (the acrylic layers also trap a plain `fixed` descendant,
 * same reason ConfirmDialog portals). No click semantics: hover already
 * opens, and the icon is a reading aid, not an action.
 */
export function HelpTip({
  label,
  children,
  align = "right",
  className = "",
}: {
  label: string;
  children: ReactNode;
  /** Which edge of the trigger the bubble aligns to. */
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  // Hover is tracked on BOTH the trigger and the bubble: after the portal the
  // bubble is not a descendant of the trigger, so a plain boolean would close
  // the bubble the moment the reader's cursor crossed onto it. The count keeps
  // it open while the cursor wanders between the two.
  const hoverCount = useRef(0);
  const enterHover = () => {
    hoverCount.current += 1;
    setOpen(true);
  };
  const leaveHover = () => {
    hoverCount.current = Math.max(0, hoverCount.current - 1);
    if (hoverCount.current === 0) setOpen(false);
  };

  // Viewport placement in fixed coordinates (Dropdown's clamp pattern, plus a
  // vertical flip): the bubble must survive sitting near any panel edge.
  const place = () => {
    const trigger = triggerRef.current;
    const bubble = bubbleRef.current;
    if (!trigger || !bubble) return;
    const margin = 8;
    const gap = 6;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const rect = trigger.getBoundingClientRect();
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    let left = align === "left" ? rect.left : rect.right - w;
    left = Math.max(margin, Math.min(left, vw - margin - w));
    let top = rect.bottom + gap;
    // Not enough room below: flip above the trigger, then clamp so a bubble
    // taller than the viewport still shows its head.
    if (top + h > vh - margin) top = Math.max(margin, rect.top - gap - h);
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
  };

  // Re-anchor while the panel re-flows/scrolls under an open bubble.
  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place);
    const observer = new ResizeObserver(place);
    if (triggerRef.current) observer.observe(triggerRef.current);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place);
      observer.disconnect();
    };
  }, [open, align]);

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={enterHover}
        onMouseLeave={leaveHover}
        className={`relative inline-flex shrink-0${className ? ` ${className}` : ""}`}
      >
        <button
          type="button"
          aria-label={label}
          aria-describedby={open ? id : undefined}
          aria-expanded={open}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(hoverCount.current > 0)}
          className="inline-flex size-5 items-center justify-center rounded-full border border-border/70 text-muted-foreground transition-colors duration-200 hover:border-primary/40 hover:text-foreground"
        >
          <HelpCircle className="size-3" />
        </button>
      </span>
      {open &&
        createPortal(
          <span
            ref={bubbleRef}
            id={id}
            role="tooltip"
            onMouseEnter={enterHover}
            onMouseLeave={leaveHover}
            className="fixed z-50 w-60 max-w-[calc(100vw-16px)] rounded-xl border border-border bg-card px-2.5 py-2 text-ui-caption font-normal leading-relaxed text-foreground shadow-float"
          >
            {children}
          </span>,
          document.body,
        )}
    </>
  );
}

/*
 * P2-18 shared button primitives. The settings surface used to re-declare
 * byte-identical INPUT/BTN/SAVE_BTN strings in three files (Composer had its
 * own CANVAS_BTN variant, the header its own icon-button cluster — now the
 * IconButton component) — four definitions whose
 * radius/padding/disabled-state semantics drifted every visual tweak. One
 * home now; call sites import (aliasing INPUT where their local name is kept)
 * so a family-wide change is a single edit.
 */
export const BTN_INPUT =
  "rounded-md border border-border bg-editor px-2.5 py-1.5 text-ui-body text-foreground outline-none transition-all duration-200 placeholder:text-muted-foreground/80 focus:border-primary/50 focus:shadow-focus";
/** Regular secondary button (28px). */
export const BTN =
  "press inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-border bg-editor px-2.5 text-ui-caption font-medium text-foreground transition-all duration-200 hover:border-primary/40 hover:bg-accent disabled:pointer-events-none disabled:opacity-40";
/** Compact secondary button (24px) for dense card action rows. */
export const BTN_SM =
  "press inline-flex h-6 items-center justify-center gap-1 rounded-md border border-border bg-editor px-2 text-ui-caption font-medium text-foreground transition-all duration-200 hover:border-primary/40 hover:bg-accent disabled:pointer-events-none disabled:opacity-40";
/** Regular primary button (28px). */
export const SAVE_BTN =
  "press inline-flex h-7 items-center justify-center gap-1.5 rounded-md bg-gradient-to-b from-primary to-primary/90 px-2.5 text-ui-caption font-semibold text-primary-foreground shadow-btn transition-all duration-200 hover:shadow-btn-hover hover:brightness-105 disabled:pointer-events-none disabled:opacity-40";
/** Canvas-surface chip button (composer controls, 28px): lifts like transcript
 * cards. whitespace-nowrap: a narrow panel must never squeeze a label into
 * vertical text (e.g. 智/能 stacked) — the row wraps instead (flex-wrap). */
export const CANVAS_BTN =
  "card-lift press inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-surface/80 px-2 text-ui-caption text-foreground shadow-card hover:bg-surface-2 transition-colors disabled:pointer-events-none disabled:opacity-40";
/** Canvas-surface chip button, dense 24px variant (card action rows). */
export const CANVAS_BTN_SM =
  "card-lift press inline-flex h-6 items-center justify-center gap-1 whitespace-nowrap rounded-md border border-border bg-surface/80 px-2 text-ui-caption text-foreground shadow-card hover:bg-surface-2 transition-colors disabled:pointer-events-none disabled:opacity-40";
/** Composer-family chip surface (attachments, suggestions, "+N"): card radius
 * with the canvas fill and the card shadow, so a chip reads as a small card
 * rather than a button competing with the send slot. */
export const CANVAS_CHIP =
  "press inline-flex max-w-full items-center gap-1 rounded-lg border border-border bg-surface/80 px-2 py-1 text-ui-caption text-foreground shadow-card transition-colors hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-40";
/** Strong surface button (28px): occupies the composer's swapped stop slot —
 * same weight as the send button but neutral, never primary. */
export const BTN_EMPHASIS =
  "press inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-surface px-3 text-ui-caption font-semibold text-foreground shadow-btn transition-all duration-200 hover:bg-surface-2 active:brightness-95 disabled:pointer-events-none disabled:opacity-40";
export const BTN_EMPHASIS_SM =
  "press inline-flex h-6 items-center justify-center gap-1 whitespace-nowrap rounded-md border border-border bg-surface px-2.5 text-ui-caption font-semibold text-foreground shadow-btn transition-all duration-200 hover:bg-surface-2 active:brightness-95 disabled:pointer-events-none disabled:opacity-40";
/** Primary-tinted soft button (28px): the queue slot — primary colour carried
 * by border + fill at 15%, so it reads as a secondary commitment to primary. */
export const PRIMARY_SOFT =
  "press inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-primary/50 bg-primary/15 px-3 text-ui-caption font-semibold text-primary shadow-btn transition-all duration-200 hover:bg-primary/25 active:brightness-95 disabled:pointer-events-none disabled:opacity-40";
export const PRIMARY_SOFT_SM =
  "press inline-flex h-6 items-center justify-center gap-1 whitespace-nowrap rounded-md border border-primary/50 bg-primary/15 px-2 text-ui-caption font-semibold text-primary shadow-btn transition-all duration-200 hover:bg-primary/25 active:brightness-95 disabled:pointer-events-none disabled:opacity-40";
/** Warning-toned soft button (28px): the action inside a warning pill / banner
 * — the tone follows the surface it sits on, so the action never reads as an
 * unrelated grey chip on an amber notice. */
export const WARNING_SOFT =
  "press inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-warning/55 bg-warning/20 px-2.5 text-ui-caption font-semibold text-warning transition-all duration-200 hover:bg-warning/30 disabled:pointer-events-none disabled:opacity-40";
export const WARNING_SOFT_SM =
  "press inline-flex h-6 items-center justify-center gap-1 whitespace-nowrap rounded-md border border-warning/55 bg-warning/20 px-2 text-ui-caption font-semibold text-warning transition-all duration-200 hover:bg-warning/30 disabled:pointer-events-none disabled:opacity-40";
/** Destructive-toned soft button (28px): the action inside an error pill. */
export const DANGER_SOFT =
  "press inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-destructive/55 bg-destructive/20 px-2.5 text-ui-caption font-semibold text-destructive transition-all duration-200 hover:bg-destructive/30 disabled:pointer-events-none disabled:opacity-40";
export const DANGER_SOFT_SM =
  "press inline-flex h-6 items-center justify-center gap-1 whitespace-nowrap rounded-md border border-destructive/55 bg-destructive/20 px-2 text-ui-caption font-semibold text-destructive transition-all duration-200 hover:bg-destructive/30 disabled:pointer-events-none disabled:opacity-40";
/** Ghost convenience button for the secondary row (catalog / refresh): quieter
 * than BTN — caption text, no border, must not read as a peer of the primary. */
export const GHOST_BTN =
  "press inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-ui-caption text-muted-foreground transition-colors duration-200 hover:bg-accent/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40";
/** Icon scale: 14px inline controls, 16px toolbar buttons, 20px empty states. */
export const ICON_INLINE = "size-3.5";
export const ICON_TOOLBAR = "size-4";
export const ICON_DISPLAY = "size-5";

/*
 * Layout primitives for the settings surface. The five cards had drifted
 * copies of the same species — hint paragraphs in three sizes/offsets, action
 * rows in two gaps, field captions re-typed in every form. Same convergence
 * as the button family above: one home, call sites import. Components own the
 * species structure (wrap/gap/leading/typography); the stacking offset stays
 * contextual (`mt-*` or the parent `space-y` stack) so call sites never set a
 * same-property override against the base class.
 */
/** Explanatory paragraph under a list/form section. */
export function Hint({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p className={`text-ui-label leading-relaxed text-muted-foreground/85${className ? ` ${className}` : ""}`}>
      {children}
    </p>
  );
}

/** Button row under a list or at the end of a form (wrap + 6px optical gap). */
export function ActionRow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-wrap items-center gap-1.5${className ? ` ${className}` : ""}`}>{children}</div>;
}

/** Action row that closes a tab section with a divider (MCP / asset toolbars). */
export function ToolbarRow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`mt-2 flex flex-wrap items-center gap-2 border-b border-border/50 pb-3${className ? ` ${className}` : ""}`}>
      {children}
    </div>
  );
}

/** Secondary convenience-action row under a primary toolbar (catalog /
 * refresh): quieter than ToolbarRow — wider optical gap for ghost buttons,
 * still closes with a divider. */
export function SecondaryRow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`mt-2 flex flex-wrap items-center gap-3 border-b border-border/50 pb-3${className ? ` ${className}` : ""}`}>
      {children}
    </div>
  );
}

/** Segmented axis selector at the top of a settings section (MCP scope /
 * asset kind). One home for the two cards' tab strips so surface, padding and
 * active-state stay in lockstep; options may carry `disabled`/`title`.
 * Radio semantics: one tab stop on the selected option, Arrow/Home/End move the
 * selection (disabled options skipped), so screen readers announce which axis
 * is active instead of reading four unlabeled buttons. */
export function Segmented<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
}: {
  ariaLabel: string;
  options: Array<{ value: T; label: ReactNode; disabled?: boolean; title?: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const selectable = options.filter((option) => !option.disabled).map((option) => option.value);
  const onKeyDown = rovingTabKeyDown<T>(selectable, value, onChange, (id) => refs.current[id]?.focus());
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="flex shrink-0 items-center gap-1 rounded-lg border border-border/70 bg-surface/40 px-1 py-1"
    >
      {options.map((option) => (
        <button
          key={option.value}
          ref={(el) => {
            refs.current[option.value] = el;
          }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          disabled={option.disabled}
          title={option.title}
          onKeyDown={onKeyDown}
          className={
            option.value === value
              ? "press rounded-md whitespace-nowrap bg-primary/18 px-2 py-0.5 text-ui-label font-semibold text-primary disabled:pointer-events-none disabled:opacity-40"
              : "press rounded-md whitespace-nowrap px-2 py-0.5 text-ui-label text-muted-foreground transition-colors duration-200 hover:bg-surface-2 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          }
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Field caption line (13px muted); `required` appends the red asterisk. */
export function FieldLabel({ required = false, children }: { required?: boolean; children: ReactNode }) {
  return (
    <span className="text-ui-label text-muted-foreground">
      {children}
      {required && <span className="text-destructive">*</span>}
    </span>
  );
}

/** Form field: caption + a single control. `className` adds flex/grid participation. */
export function Field({
  label,
  required = false,
  className = "",
  children,
}: {
  label: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1${className ? ` ${className}` : ""}`}>
      <FieldLabel required={required}>{label}</FieldLabel>
      {children}
    </label>
  );
}

/** Clickable file reference that opens the location in the editor. */
export function FileRef({ path, line, toolCallId }: { path: string; line?: number | null; toolCallId?: string }) {
  const send = useChat((s) => s.send);
  return (
    <button
      className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-sm font-mono text-ui-caption text-info underline decoration-info/30 underline-offset-2 hover:decoration-info"
      title={path}
      onClick={(e) => {
        e.preventDefault();
        send({ type: "openLocation", path, line, toolCallId });
      }}
    >
      <FileCode2 className="size-3 shrink-0" />
      <span className="truncate">{path.split(/[\\/]/).pop()}</span>
    </button>
  );
}

/**
 * Modal destructive-action confirm, shared by every delete affordance
 * (message, session, MCP entry, profile, approval rule). Replaces the old
 * InlineConfirm two-step pill: the in-row armed state was too fiddly to hit
 * in dense rows, so arming now opens a real dialog. Rendered through a
 * portal to document.body — the settings modal's acrylic layers create
 * containing blocks that would trap a plain `fixed` descendant.
 * ModalShell semantics: ESC / backdrop / X all cancel. Initial focus sits on
 * 取消 (data-autofocus) so an accidental Enter never fires the destructive
 * action.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  /** P1-8: multi-action variant — when set, replaces the single confirm
   * button with this action group (e.g. the rollback mode picker: files /
   * conversation / both). Cancel keeps data-autofocus so an accidental Enter
   * never fires a destructive action. */
  actions,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm?: () => void;
  onCancel: () => void;
  actions?: {
    label: string;
    title?: string;
    disabled?: boolean;
    variant?: "default" | "primary" | "danger";
    onClick: () => void;
  }[];
}) {
  return createPortal(
    <ModalShell title={title} onClose={onCancel} ariaLabel={title} role="alertdialog">
      <div className="px-4 py-3 text-ui-label leading-relaxed text-foreground/90">{message}</div>
      <div className="flex items-center justify-end gap-1.5 border-t border-border/60 bg-panel/50 px-3 py-2">
        <button
          data-autofocus
          type="button"
          className="press inline-flex h-6 items-center justify-center rounded-md border border-border bg-editor px-3 text-ui-caption font-medium text-foreground transition-colors hover:bg-accent"
          onClick={onCancel}
        >
          {t("取消")}
        </button>
        {actions
          ? actions.map((a) => (
              <button
                key={a.label}
                type="button"
                title={a.title}
                disabled={a.disabled}
                className={`press inline-flex h-6 items-center justify-center rounded-md border px-3 text-ui-caption font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  a.variant === "primary"
                    ? "border-primary/50 bg-primary/15 text-primary hover:bg-primary/25"
                    : a.variant === "danger"
                      ? "border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20"
                      : "border-border bg-editor text-foreground hover:bg-accent"
                }`}
                onClick={a.onClick}
              >
                {a.label}
              </button>
            ))
          : (
            <button
              type="button"
              className="press inline-flex h-6 items-center justify-center rounded-md border border-destructive/50 bg-destructive/10 px-3 text-ui-caption font-semibold text-destructive transition-colors hover:bg-destructive/20"
              onClick={onConfirm}
            >
              {confirmLabel ?? t("删除")}
            </button>
          )}
      </div>
    </ModalShell>,
    document.body,
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
  /** Hard gate: while true the click proxy ignores all clicks. The trigger
   * button's own `disabled` + `pointer-events-none` is NOT enough — with
   * pointer-events suppressed the click falls through to this proxy div,
   * which still toggles the menu (seen as "dropdowns open while streaming"). */
  disabled = false,
  children,
}: {
  trigger: (open: boolean) => ReactNode;
  direction?: "down" | "up";
  align?: "left" | "right";
  menuClass?: string;
  wrapperClass?: string;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  // --- keyboard navigation (ARIA menu pattern) ---
  // ArrowUp/Down move between items, Home/End jump to ends, typing does
  // type-ahead. Skipped entirely while focus is in a search input (the model
  // dropdown owns its own input-driven navigation) so we never steal focus.
  const typeahead = useRef<{ str: string; timer: number | null }>({ str: "", timer: null });

  function getMenuItems(): HTMLElement[] {
    if (!menuRef.current) return [];
    return Array.from(
      menuRef.current.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([data-variant="danger"]), [role="menuitemradio"]:not([data-variant="danger"]), [role="menuitemcheckbox"]:not([data-variant="danger"]), button.menu-item',
      ),
    ).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
  }

  function focusMenuItem(items: HTMLElement[], idx: number): void {
    if (items.length === 0) return;
    const i = ((idx % items.length) + items.length) % items.length;
    const el = items[i];
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  }

  useEffect(() => {
    if (!open) return;
    // Don't yank focus into the menu if it owns a search input.
    if (menuRef.current?.querySelector("input, textarea")) return;
    // Value pickers (menuitemradio) start on the active choice — same anchor as
    // the model menu's highlight; plain action menus still start at the top.
    const items = getMenuItems();
    const checked = menuRef.current?.querySelector('[aria-checked="true"]') as HTMLElement | null;
    focusMenuItem(items, checked && items.includes(checked) ? items.indexOf(checked) : 0);
  }, [open]);

  // Keep the menu inside the viewport. Right-aligned menus near a narrow panel
  // edge (thinking level at 300px) used to start left of x=0. Shift the
  // absolutely positioned menu with margin-left — not transform — so the
  // dropdown-in animation keeps working.
  useLayoutEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const anchor = ref.current;
    if (!menu || !anchor) return;
    const clamp = () => {
      const width = menu.offsetWidth;
      const rect = anchor.getBoundingClientRect();
      const margin = 8;
      const viewport = document.documentElement.clientWidth;
      const preferred = align === "right" ? rect.right - width : rect.left;
      const target = Math.max(margin, Math.min(preferred, viewport - margin - width));
      // Position relative to the wrapper's padding box and drop the class's
      // `right-0` anchor; margin-left is ignored on a right-anchored absolute box.
      menu.style.left = `${target - rect.left}px`;
      menu.style.right = "auto";
    };
    clamp();
    window.addEventListener("resize", clamp);
    const observer = new ResizeObserver(clamp);
    observer.observe(menu);
    return () => {
      window.removeEventListener("resize", clamp);
      observer.disconnect();
      menu.style.left = "";
      menu.style.right = "";
    };
  }, [open, align]);

  function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    const ae = document.activeElement as HTMLElement | null;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
    const items = getMenuItems();
    if (items.length === 0) return;
    const idx = ae ? items.indexOf(ae) : -1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusMenuItem(items, idx < 0 ? 0 : idx + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusMenuItem(items, idx < 0 ? items.length - 1 : idx - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusMenuItem(items, 0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusMenuItem(items, items.length - 1);
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // type-ahead: jump to the first item whose visible text starts with the
      // typed prefix; resets after 500ms of inactivity.
      e.preventDefault();
      const ta = typeahead.current;
      ta.str += e.key.toLowerCase();
      if (ta.timer) window.clearTimeout(ta.timer);
      ta.timer = window.setTimeout(() => {
        ta.str = "";
      }, 500);
      const match = items.find((it) => (it.textContent ?? "").trim().toLowerCase().startsWith(ta.str));
      match?.focus();
    }
    // Enter/Space/Escape: let the focused button's own handler (or the
    // document-level Escape closer) take over.
  }

  return (
    <div className={`relative${wrapperClass ? ` ${wrapperClass}` : ""}`} ref={ref}>
      {/* P1-10: this is a plain click proxy, NOT a button — the trigger
          render prop already renders a real <button>; a role="button" here
          would nest interactive elements (ARIA violation, doubled screen-
          reader announcement). The proxy must stay: with the inner button
          disabled (pointer-events-none) clicks fall through to this div, and
          the disabled gate below is what keeps dropdowns closed mid-turn.
          menu semantics (aria-haspopup/aria-expanded) live on the caller's
          real button. The proxy must constrain its child the same way the
          wrapper does: as a plain block it lets a long trigger label stretch
          the button far beyond the wrapper width (flex-1 inside is inert). */}
      <div
        className={wrapperClass.includes("flex-1") ? "flex min-w-0" : ""}
        onClick={(e) => {
          if (disabled) return;
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
          ref={menuRef}
          role="menu"
          onKeyDown={onMenuKeyDown}
          className={`absolute z-30 overflow-hidden rounded-xl border border-border acrylic-pop shadow-float dropdown-in ${
            direction === "up" ? "bottom-full mb-1" : "top-full mt-1"
          } ${align === "right" ? "right-0" : "left-0"} ${menuClass}`}
        >
          {children(closeAndNotify)}
        </div>
      )}
    </div>
  );
}

/**
 * One grouped settings card: header + divided rows. Replaces the old
 * per-row card wall so long tabs stay scannable.
 */
export function SettingsGroup({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-surface/60 shadow-card">
      <div className="flex items-baseline gap-2 border-b border-border/60 bg-surface/40 px-4 py-3">
        <h3 className="text-ui-caption font-semibold uppercase tracking-[0.08em] text-muted-foreground">{title}</h3>
        {hint && <span className="ml-auto min-w-0 truncate text-ui-caption text-muted-foreground/75">{hint}</span>}
      </div>
      <div className="divide-y divide-border/50">{children}</div>
    </section>
  );
}

/**
 * Collapsible SettingsGroup for advanced, rarely-touched fields. Keeping
 * these closed by default is what stops a tab from reading as a dense wall of
 * inputs; the summary keeps the same header rhythm as SettingsGroup.
 *
 * Controlled disclosure (aria-expanded + a toggle button) instead of
 * <details>: the header may carry primary actions (e.g. 「生成项目知识」) and
 * interactive elements inside a <summary> are an accessibility violation.
 * The body stays mounted (just hidden) so form drafts survive a collapse.
 */
export function SettingsDisclosure({
  title,
  hint,
  header,
  children,
  defaultOpen = false,
}: {
  title: string;
  hint?: string;
  /** Primary action(s) rendered in the header row (block header). */
  header?: ReactNode;
  children: ReactNode;
  /** Open on first render (used for blocks that hold the primary action). */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-surface/60 shadow-card">
      <div className="flex items-center gap-2 bg-surface/40 px-4 py-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          className="press flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={`size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ${open ? "rotate-90" : ""}`}
          />
          <h3 className="truncate text-ui-caption font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {title}
          </h3>
        </button>
        {hint && <span className="shrink-0 truncate text-ui-caption text-muted-foreground/75">{hint}</span>}
        {header && <div className="flex shrink-0 flex-wrap items-center gap-1.5">{header}</div>}
      </div>
      <div
        id={bodyId}
        className={open ? "divide-y divide-border/50 border-t border-border/60" : "hidden"}
      >
        {children}
      </div>
    </section>
  );
}

/* ============================================================================
 * Control kit — the project's interface language for interactive controls.
 *
 * One home for every control species (button / field / switch / checkbox /
 * radio / toggle chip / slider / tab / floating capsule / toast). Call sites
 * import these instead of re-typing class strings: the drift that this kit
 * removes is visual (radius, height, disabled state, focus ring) and semantic
 * (role, aria, keyboard path, commit timing), both of which used to be
 * re-invented per card.
 *
 * Design-language contract (enforced by test/ui-kit-guard.test.ts):
 * - Radius: control 6 (`rounded-md`), overlay 12 (`rounded-xl`), capsule
 *   `rounded-full`; nested corners step down one level.
 * - Type: the five semantic sizes only (`text-ui-*`); never `text-[Npx]`.
 * - Height: 28px (regular / toolbar) and 24px (dense card rows); icon buttons
 *   28×28 and 24×24.
 * - Colour: oklch tokens only — selected = `primary/10–18`, danger =
 *   `destructive/10–15`, muted text = `muted-foreground`. Never a literal.
 * - Focus: the global `:focus-visible` ring (`--shadow-focus`); small fields
 *   inside a wrapper use the inset `--shadow-focus-soft` instead.
 * - Disabled: `pointer-events-none + opacity-40`, everywhere, no exceptions.
 * - Motion: `.press` feedback, `--ease-out-expo` settle, `stream-in` /
 *   `dropdown-in` entrances.
 * - Icons: `ICON_INLINE` / `ICON_TOOLBAR` / `ICON_DISPLAY`, laid out with
 *   flex gap (no manual margins).
 * - Copy: `t()` from i18n; `aria-label` and `title` carry the same wording.
 * ========================================================================== */

/** Primary button, dense 24px variant (card action rows). */
export const SAVE_BTN_SM =
  "press inline-flex h-6 items-center justify-center gap-1 rounded-md bg-gradient-to-b from-primary to-primary/90 px-2.5 text-ui-caption font-semibold text-primary-foreground shadow-btn transition-all duration-200 hover:shadow-btn-hover hover:brightness-105 disabled:pointer-events-none disabled:opacity-40";
/** Destructive button (regular 28px / dense 24px). */
export const BTN_DANGER =
  "press inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-destructive/50 bg-destructive/10 px-2.5 text-ui-caption font-semibold text-destructive transition-all duration-200 hover:bg-destructive/20 disabled:pointer-events-none disabled:opacity-40";
export const BTN_DANGER_SM =
  "press inline-flex h-6 items-center justify-center gap-1 rounded-md border border-destructive/50 bg-destructive/10 px-2.5 text-ui-caption font-semibold text-destructive transition-all duration-200 hover:bg-destructive/20 disabled:pointer-events-none disabled:opacity-40";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "canvas"
  /** Composer send-slot pair: the stop slot stays neutral but carries the same
   * optical weight as the send button; the queue slot is a primary commitment
   * at 15% fill instead of a second gradient. */
  | "emphasis"
  | "primary-soft"
  /** Outline variants for pending-card action rows: the semantic colour is
   * carried by border + text, the fill only appears on hover, so a card never
   * reads as three shouting buttons. */
  | "outline-primary"
  | "outline-danger"
  /** Tone-following soft variants: an action that sits inside a warning or
   * error surface wears that surface's tone instead of the neutral grey. */
  | "warning-soft"
  | "danger-soft";
/** `md` = 28px (regular / toolbar), `sm` = 24px (dense card action rows). */
export type ButtonSize = "md" | "sm";

const OUTLINE_PRIMARY =
  "press inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-primary/40 px-2.5 text-ui-caption font-medium text-primary transition-all duration-200 hover:bg-primary/10 disabled:pointer-events-none disabled:opacity-40";
const OUTLINE_PRIMARY_SM =
  "press inline-flex h-6 items-center justify-center gap-1 rounded-md border border-primary/40 px-2.5 text-ui-caption font-medium text-primary transition-all duration-200 hover:bg-primary/10 disabled:pointer-events-none disabled:opacity-40";
const OUTLINE_DANGER =
  "press inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-destructive/40 px-2.5 text-ui-caption font-medium text-destructive transition-all duration-200 hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-40";
const OUTLINE_DANGER_SM =
  "press inline-flex h-6 items-center justify-center gap-1 rounded-md border border-destructive/40 px-2.5 text-ui-caption font-medium text-destructive transition-all duration-200 hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-40";

const BUTTON_CLASSES: Record<ButtonVariant, { md: string; sm: string }> = {
  primary: { md: SAVE_BTN, sm: SAVE_BTN_SM },
  secondary: { md: BTN, sm: BTN_SM },
  danger: { md: BTN_DANGER, sm: BTN_DANGER_SM },
  ghost: { md: GHOST_BTN, sm: GHOST_BTN },
  canvas: { md: CANVAS_BTN, sm: CANVAS_BTN_SM },
  emphasis: { md: BTN_EMPHASIS, sm: BTN_EMPHASIS_SM },
  "primary-soft": { md: PRIMARY_SOFT, sm: PRIMARY_SOFT_SM },
  "outline-primary": { md: OUTLINE_PRIMARY, sm: OUTLINE_PRIMARY_SM },
  "outline-danger": { md: OUTLINE_DANGER, sm: OUTLINE_DANGER_SM },
  "warning-soft": { md: WARNING_SOFT, sm: WARNING_SOFT_SM },
  "danger-soft": { md: DANGER_SOFT, sm: DANGER_SOFT_SM },
};

/**
 * The one button primitive. `icon` renders before the label with the shared
 * optical gap; omit `children` for an icon-only button (then `aria-label` is
 * mandatory — use IconButton). Every state (disabled, press, focus ring) is
 * owned here so a family-wide change is a single edit.
 */
export function Button({
  variant = "secondary",
  size = "md",
  icon,
  className = "",
  children,
  ref,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}) {
  const base = BUTTON_CLASSES[variant][size];
  return (
    <button type="button" ref={ref} className={`${base}${className ? ` ${className}` : ""}`} {...rest}>
      {icon}
      {children}
    </button>
  );
}

/** Icon-only button: 28×28 (header cluster) or 24×24 (dense card rows). */
export function IconButton({
  icon,
  label,
  size = "md",
  tone = "default",
  className = "",
  ref,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: ReactNode;
  /** Accessible name; also used as the hover tooltip. */
  label: string;
  size?: "md" | "sm";
  tone?: "default" | "danger" | "primary";
  ref?: Ref<HTMLButtonElement>;
}) {
  const toneClass =
    tone === "danger"
      ? "hover:bg-destructive/10 hover:text-destructive"
      : tone === "primary"
        ? "text-primary hover:bg-accent/60"
        : "hover:bg-surface hover:text-foreground";
  return (
    <button
      type="button"
      ref={ref}
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-all duration-200 active:scale-95 disabled:pointer-events-none disabled:opacity-40 ${
        size === "sm" ? "size-6" : "size-7"
      } ${toneClass}${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {icon}
    </button>
  );
}

/* --- fields -----------------------------------------------------------------
 * Two species, named by their commit timing:
 * - `*Input` / `TextArea`: live controlled (form drafts the user edits before
 *   an explicit save).
 * - `Commit*`: local draft, committed on blur / Enter, normalised before the
 *   host write. The draft survives an external echo while focused (a host
 *   round-trip must not overwrite what the user is typing), and the committed
 *   text is always shown normalised so the field never displays a value that
 *   was silently dropped.
 * Enter commits and is IME-safe: a composition-confirming Enter must not act.
 * -------------------------------------------------------------------------- */

function isImeEnter(e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

function useCommitDraft(
  value: string,
  normalize: (v: string) => string,
  onCommit: (v: string) => void,
) {
  const [draft, setDraft] = useState(() => normalize(value));
  const focused = useRef(false);
  const last = useRef(value);
  useEffect(() => {
    if (last.current === value) return;
    last.current = value;
    if (!focused.current) setDraft(normalize(value));
  }, [value, normalize]);
  const commit = () => {
    const next = normalize(draft);
    setDraft(next);
    if (next !== value) onCommit(next);
  };
  return {
    draft,
    setDraft,
    commit,
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      commit();
    },
    onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key !== "Enter" || isImeEnter(e)) return;
      e.preventDefault();
      e.currentTarget.blur();
    },
  };
}

/** Live text field (form draft). `mono` for paths/URLs/JSON-ish values.
 * `revealable` moves the password reveal off Chromium's built-in toggle (which
 * CSS cannot restyle) onto the kit's icon button. */
export function TextInput({
  mono = false,
  invalid = false,
  revealable = false,
  className = "",
  ref,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  mono?: boolean;
  invalid?: boolean;
  /** Kit reveal toggle for credential fields (call site supplies `type`). */
  revealable?: boolean;
  ref?: Ref<HTMLInputElement>;
}) {
  const [shown, setShown] = useState(false);
  const field = (
    <input
      ref={ref}
      spellCheck={false}
      aria-invalid={invalid || undefined}
      {...rest}
      type={revealable && shown ? "text" : (rest.type ?? "text")}
      className={`${BTN_INPUT}${mono ? " font-mono" : ""}${invalid ? " border-destructive/60" : ""}${
        revealable ? " pr-8" : ""
      }${className ? ` ${className}` : ""}`}
    />
  );
  if (!revealable) return field;
  return (
    <div className="relative">
      {field}
      <IconButton
        icon={shown ? <EyeOff className={ICON_INLINE} /> : <Eye className={ICON_INLINE} />}
        label={shown ? t("隐藏密码") : t("显示密码")}
        size="sm"
        className="absolute right-0.5 top-1/2 -translate-y-1/2"
        onClick={() => setShown((current) => !current)}
      />
    </div>
  );
}

/** Text field with blur/Enter commit (settings rows writing host settings). */
export function CommitTextInput({
  value,
  onCommit,
  normalize = (v) => v.trim(),
  mono = false,
  label,
  className = "",
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onCommit: (value: string) => void;
  normalize?: (v: string) => string;
  mono?: boolean;
  /** Accessible name (rows usually have a visible label already). */
  label: string;
}) {
  const field = useCommitDraft(value, normalize, onCommit);
  return (
    <input
      type="text"
      spellCheck={false}
      aria-label={label}
      value={field.draft}
      className={`${BTN_INPUT}${mono ? " font-mono" : ""}${className ? ` ${className}` : ""}`}
      onFocus={field.onFocus}
      onBlur={field.onBlur}
      onChange={(e) => field.setDraft(e.target.value)}
      onKeyDown={field.onKeyDown}
      {...rest}
    />
  );
}

/** Numeric field with blur/Enter commit; out-of-range input is clamped,
 * non-numeric input reverts to the stored value (never a silent 0). */
export function CommitNumberInput({
  value,
  min,
  max,
  step = 1,
  unit,
  label,
  className = "",
  onCommit,
}: {
  value: number;
  min: number;
  max?: number;
  step?: number;
  unit?: string;
  label: string;
  className?: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);
  const last = useRef(value);
  useEffect(() => {
    if (last.current === value) return;
    last.current = value;
    if (!focused.current) setDraft(String(value));
  }, [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.trunc(Math.max(min, Math.min(max ?? Number.POSITIVE_INFINITY, parsed)));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={draft}
        className={`${BTN_INPUT}${className ? ` ${className}` : ""}`}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || isImeEnter(e)) return;
          e.preventDefault();
          e.currentTarget.blur();
        }}
      />
      {unit && <span className="shrink-0 text-ui-caption text-muted-foreground">{unit}</span>}
    </div>
  );
}

/** Multiline chrome shared by the kit's textareas: height adjustment is the
 * kit's own grip (`.ui-resize`) instead of Chromium's corner handle, so a drag
 * writes an explicit height and `resize-none` keeps the browser out of the
 * painting. Mouse-only and decorative. */
function FieldTextarea({
  resizable = true,
  className = "",
  style,
  ref,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  resizable?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}) {
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const attachRef = (el: HTMLTextAreaElement | null) => {
    boxRef.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) (ref as MutableRefObject<HTMLTextAreaElement | null>).current = el;
  };
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const originY = event.clientY;
    const base = height ?? boxRef.current?.getBoundingClientRect().height ?? 0;
    const move = (e: PointerEvent) => {
      const next = Math.max(40, Math.min(window.innerHeight - 120, base + (e.clientY - originY)));
      setHeight(next);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };
  return (
    /* grid + content-start: the row keeps the textarea's own height even when an
       outer grid stretches this wrapper, so the grip always lands on the
       textarea's own bottom-right corner instead of the wrapper's. */
    <div className="relative grid content-start">
      <textarea
        ref={attachRef}
        className={`w-full resize-none col-start-1 row-start-1${className ? ` ${className}` : ""}`}
        style={height !== null ? { ...style, height } : style}
        {...rest}
      />
      {resizable ? (
        <div
          className="ui-resize col-start-1 row-start-1 self-end justify-self-end"
          aria-hidden="true"
          onPointerDown={startDrag}
        />
      ) : null}
    </div>
  );
}

/** Live multi-line field. */
export function TextArea({
  mono = false,
  invalid = false,
  resizable = true,
  className = "",
  ref,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  mono?: boolean;
  invalid?: boolean;
  /** Off for editors that size themselves (the inline message editor). */
  resizable?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}) {
  return (
    <FieldTextarea
      resizable={resizable}
      ref={ref}
      spellCheck={false}
      aria-invalid={invalid || undefined}
      className={`${BTN_INPUT}${mono ? " font-mono" : ""}${invalid ? " border-destructive/60" : ""}${
        className ? ` ${className}` : ""
      }`}
      {...rest}
    />
  );
}

/** Multi-line field with blur commit. */
export function CommitTextArea({
  value,
  onCommit,
  normalize = (v) => v.trim(),
  mono = false,
  label,
  rows = 3,
  resizable = true,
  className = "",
  ...rest
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string;
  onCommit: (value: string) => void;
  normalize?: (v: string) => string;
  mono?: boolean;
  label: string;
  resizable?: boolean;
}) {
  const field = useCommitDraft(value, normalize, onCommit);
  return (
    <FieldTextarea
      resizable={resizable}
      rows={rows}
      spellCheck={false}
      aria-label={label}
      value={field.draft}
      className={`${BTN_INPUT}${mono ? " font-mono" : ""}${className ? ` ${className}` : ""}`}
      onFocus={field.onFocus}
      onBlur={field.onBlur}
      onChange={(e) => field.setDraft(e.target.value)}
      {...rest}
    />
  );
}

/** Line-list field (one entry per line): blank lines are dropped on commit and
 * the textarea mirrors the stored form so dropped lines never stay on screen. */
export function LinesCommitTextArea({
  value,
  onCommit,
  label,
  rows = 3,
  placeholder,
  className = "",
}: {
  value: string[];
  onCommit: (value: string[]) => void;
  label: string;
  rows?: number;
  placeholder?: string;
  className?: string;
}) {
  const serialized = value.join("\n");
  return (
    <CommitTextArea
      label={label}
      rows={rows}
      placeholder={placeholder}
      mono
      className={`leading-relaxed${className ? ` ${className}` : ""}`}
      value={serialized}
      normalize={(v) =>
        v
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .join("\n")
      }
      onCommit={(next) => onCommit(next.split("\n").filter(Boolean))}
    />
  );
}

/**
 * Overlay menu row — the home of the menu-item language (mode/model menus,
 * custom selects). Optional leading icon, optional caption description, and a
 * trailing check for the active choice. Value pickers get `role="menuitemradio"`
 * + `aria-checked` so screen readers announce the current selection; action
 * rows stay `menuitem`. Danger rows carry `data-variant="danger"` (the
 * Dropdown keyboard nav skips them, matching the destructive-first rule).
 */
export function MenuItem({
  selected = false,
  role = "menuitem",
  description,
  icon,
  danger = false,
  disabled = false,
  className = "",
  onClick,
  children,
}: {
  selected?: boolean;
  /** `menuitemradio` / `menuitemcheckbox` for value pickers — every option in a
   * value group carries the radio role, only the active one is checked. Plain
   * action rows stay `menuitem` (aria-checked is invalid there). */
  role?: "menuitem" | "menuitemradio" | "menuitemcheckbox";
  description?: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const checkable = role === "menuitemradio" || role === "menuitemcheckbox";
  return (
    <button
      type="button"
      role={role}
      aria-checked={checkable ? selected : undefined}
      data-variant={danger ? "danger" : undefined}
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors duration-200 disabled:pointer-events-none disabled:opacity-40 ${
        danger ? "hover:bg-destructive/10" : "hover:bg-accent/50"
      }${className ? ` ${className}` : ""}`}
    >
      {icon ? (
        <span className={`mt-0.5 shrink-0 ${danger ? "text-destructive" : "text-muted-foreground"}`}>{icon}</span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className={`flex items-center gap-1 text-ui-label ${danger ? "text-destructive" : "text-foreground"}`}>
          <span className="truncate">{children}</span>
          {selected ? <Check className={`${ICON_INLINE} shrink-0 text-primary`} /> : null}
        </span>
        {description ? <span className="block text-ui-caption text-muted-foreground">{description}</span> : null}
      </span>
    </button>
  );
}

export type SelectOption = { value: string; label: string; description?: string; disabled?: boolean };

/**
 * Value picker rendered as an overlay menu (the acrylic menu the mode dropdown
 * uses) instead of a native `<select>`: the OS popup ignores the panel's overlay
 * language (radius, acrylic surface, selection check, secondary captions).
 * Trigger keeps the text-field chrome (`BTN_INPUT`) at the two control heights;
 * the menu is at least as wide as the field and viewport-clamped by Dropdown.
 */
export function Select({
  options,
  value,
  onChange,
  ariaLabel,
  size = "md",
  disabled = false,
  align = "left",
  direction = "down",
  className = "",
  wrapperClass = "",
  menuClass = "",
}: {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  size?: "md" | "sm";
  disabled?: boolean;
  align?: "left" | "right";
  direction?: "down" | "up";
  className?: string;
  wrapperClass?: string;
  menuClass?: string;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <Dropdown
      align={align}
      direction={direction}
      disabled={disabled}
      wrapperClass={wrapperClass}
      menuClass={`min-w-full max-w-[calc(100vw_-_24px)]${menuClass ? ` ${menuClass}` : ""}`}
      trigger={(open) => (
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={ariaLabel}
          title={ariaLabel}
          disabled={disabled}
          className={`${BTN_INPUT} inline-flex ${size === "sm" ? "h-6" : "h-7"} w-full min-w-0 items-center gap-1.5 disabled:pointer-events-none disabled:opacity-40${
            open ? " border-primary/50" : ""
          }${className ? ` ${className}` : ""}`}
        >
          <span
            className={`min-w-0 flex-1 truncate text-left${size === "sm" ? " text-ui-caption" : ""}`}
          >
            {current?.label ?? ""}
          </span>
          <ChevronDown className={`${ICON_INLINE} shrink-0 opacity-60`} />
        </button>
      )}
    >
      {(close) => (
        <>
          {options.map((option) => (
            <MenuItem
              key={option.value}
              role="menuitemradio"
              selected={option.value === value}
              description={option.description}
              disabled={option.disabled ?? false}
              onClick={() => {
                if (option.value !== value) onChange(option.value);
                close();
              }}
            >
              {option.label}
            </MenuItem>
          ))}
        </>
      )}
    </Dropdown>
  );
}

/** Search field embedded in menus/lists: transparent inside a bordered
 * wrapper, focus feedback is the wrapper's inset ring (`--shadow-focus-soft`),
 * not an outward ring on the bare input. */
export function SearchInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  mono = false,
  icon = true,
  autoFocus = false,
  className = "",
  onKeyDown,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  mono?: boolean;
  icon?: boolean;
  autoFocus?: boolean;
  className?: string;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md border border-border bg-editor/60 px-2.5 py-1.5 transition-colors duration-200 focus-within:border-primary/40 focus-within:shadow-focus-soft${
        className ? ` ${className}` : ""
      }`}
    >
      {icon && <Search className="size-3.5 shrink-0 text-muted-foreground" />}
      <input
        type="text"
        autoFocus={autoFocus}
        spellCheck={false}
        aria-label={ariaLabel}
        value={value}
        placeholder={placeholder}
        className={`w-full min-w-0 bg-transparent text-ui-body text-foreground outline-none placeholder:text-muted-foreground/80${
          mono ? " font-mono text-ui-caption" : ""
        }`}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

/* --- selection -------------------------------------------------------------- */

/** Switch (role=switch): 20×36 track, 14px knob. The visible label lives in
 * the row; the control carries only the accessible name. */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  className = "",
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`press relative mt-0.5 inline-flex h-[20px] w-[36px] shrink-0 items-center rounded-full border transition-colors duration-200 disabled:pointer-events-none disabled:opacity-40 ${
        checked ? "border-primary/50 bg-primary/70" : "border-border bg-border/70"
      }${className ? ` ${className}` : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span
        className={`inline-block size-[14px] rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? "translate-x-[19px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}

/** Checkbox: a native input (keyboard + screen-reader semantics) drawn with
 * `.ui-checkbox` so the box matches the radius/colour system instead of the
 * browser's accent colour. `label` renders as adjacent text; without it the
 * control is labelled by `ariaLabel`. */
export function Checkbox({
  checked,
  onChange,
  ariaLabel,
  label,
  title,
  disabled = false,
  className = "",
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  ariaLabel?: string;
  /** Visible adjacent text (wraps the input in a clickable label). */
  label?: string;
  title?: string;
  disabled?: boolean;
  className?: string;
}) {
  const box = (
    <input
      type="checkbox"
      className={`ui-checkbox shrink-0${disabled ? " disabled:pointer-events-none disabled:opacity-40" : ""}${
        className ? ` ${className}` : ""
      }`}
      checked={checked}
      disabled={disabled}
      title={label ? undefined : title}
      aria-label={label ? undefined : ariaLabel}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
  if (!label) return box;
  return (
    <label
      className={`inline-flex shrink-0 cursor-pointer items-center gap-1 text-ui-label text-muted-foreground${
        disabled ? " pointer-events-none opacity-40" : ""
      }`}
      title={title}
    >
      {box}
      <span>{label}</span>
    </label>
  );
}

/** Pill control. With `active` it is a toggle (`aria-pressed`); without it it
 * is a quiet pill action (preset entries, model shortcuts) that advances a
 * form rather than holding a state. */
export function ToggleChip({
  active,
  mono = false,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; mono?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`press rounded-full border px-2 py-0.5 text-ui-caption transition-colors duration-200 disabled:pointer-events-none disabled:opacity-40 ${
        active
          ? "border-primary/50 bg-primary/10 font-semibold text-primary"
          : "border-border text-muted-foreground hover:border-primary/40 hover:bg-accent/60 hover:text-foreground"
      }${mono ? " font-mono" : ""}${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * Radio / checkbox option group (question cards). Arrow keys move focus among
 * enabled options (Home/End jump to the ends); Enter/Space select through the
 * option's own button handler. `multi` swaps radiogroup → group semantics
 * (checkboxes keep per-item tabindex, no roving selection).
 */
export function OptionGroup({
  ariaLabel,
  multi = false,
  className = "",
  children,
}: {
  ariaLabel: string;
  multi?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
    if (items.length === 0) return;
    const at = document.activeElement instanceof HTMLButtonElement ? items.indexOf(document.activeElement) : -1;
    let next = -1;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = at < 0 ? 0 : (at + 1) % items.length;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else next = items.length - 1;
    e.preventDefault();
    items[next]?.focus();
  };
  return (
    <div
      ref={ref}
      role={multi ? "group" : "radiogroup"}
      aria-label={ariaLabel}
      className={className}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}

/** One option inside an OptionGroup: indicator + label + optional description.
 * `emphasis` marks the recommended row of a one-shot choice (primary outline +
 * light fill) without claiming a persisted selection; `ariaLabel` keeps the
 * accessible name exact when the visible label and description differ. */
export function OptionCard({
  type = "radio",
  checked,
  disabled = false,
  label,
  description,
  title,
  icon,
  onClick,
  className = "",
  ariaLabel,
  emphasis = false,
}: {
  type?: "radio" | "checkbox";
  checked: boolean;
  disabled?: boolean;
  label: ReactNode;
  description?: ReactNode;
  title?: string;
  /** Domain icon replacing the radio/checkbox indicator (role/aria stay). */
  icon?: ReactNode;
  onClick: () => void;
  className?: string;
  /** Explicit accessible name (defaults to the visible label + description). */
  ariaLabel?: string;
  /** Primary-tinted row for the recommended option of a one-shot choice. */
  emphasis?: boolean;
}) {
  const Indicator =
    type === "checkbox" ? (checked ? CheckSquare : Square) : checked ? CircleDot : Circle;
  return (
    <button
      type="button"
      role={type === "checkbox" ? "checkbox" : "radio"}
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`press flex items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-ui-caption transition-all duration-200 shadow-card disabled:pointer-events-none disabled:opacity-40 ${
        checked
          ? "border-primary/60 bg-primary/10 shadow-card"
          : emphasis
            ? "border-primary/40 bg-primary/10"
            : "border-border bg-surface/80 hover:border-primary/30 hover:bg-surface-2"
      }${className ? ` ${className}` : ""}`}
    >
      {icon ?? (
        <Indicator
          className={`mt-px size-3.5 shrink-0 ${checked ? "text-primary" : "text-muted-foreground/80"}`}
        />
      )}
      <span className="min-w-0">
        <span className={`block font-medium leading-tight ${checked ? "text-primary" : "text-foreground"}`}>
          {label}
        </span>
        {description && <span className="mt-0.5 block leading-snug text-muted-foreground">{description}</span>}
      </span>
    </button>
  );
}

/** Slider (range): 4px track with a primary-filled portion, 14px knob. Commit
 * timing matches the settings rows — live during drag, written on pointerup /
 * blur / arrow key, so a drag never fires a host write per pixel. */
export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  label,
  format,
  onCommit,
  className = "",
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  /** Value readout (e.g. `(v) => `${v}%`); omit for none. */
  format?: (value: number) => ReactNode;
  onCommit: (value: number) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const last = useRef(value);
  useEffect(() => {
    if (last.current === value) return;
    last.current = value;
    setDraft(value);
  }, [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  const pct = max > min ? ((draft - min) / (max - min)) * 100 : 0;
  return (
    <div className={`flex w-full items-center gap-2${className ? ` ${className}` : ""}`}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={draft}
        aria-label={label}
        className="ui-slider w-full"
        style={{ background: `linear-gradient(to right, var(--primary) ${pct}%, var(--border) ${pct}%)` }}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onBlur={commit}
        onKeyUp={(e) => {
          if (e.key.startsWith("Arrow")) commit();
        }}
      />
      {format && (
        <span className="w-9 shrink-0 text-right text-ui-caption tabular-nums text-muted-foreground">
          {format(draft)}
        </span>
      )}
    </div>
  );
}

/* --- tabs -------------------------------------------------------------------
 * Tabs are page navigation (role=tablist + roving tabindex); in-page selection
 * uses Segmented / ToggleChip instead. Keep the two semantics separate — the
 * audit finding was one feature with two entry points.
 * ------------------------------------------------------------------------- */

export function TabButton({
  active,
  icon,
  children,
  onActivate,
  id,
  controls,
  refCallback,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active: boolean;
  icon?: ReactNode;
  children: ReactNode;
  onActivate: () => void;
  id?: string;
  /** id of the panel this tab controls. */
  controls?: string;
  refCallback?: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-selected={active}
      aria-current={active ? "page" : undefined}
      aria-controls={controls}
      // Roving tabindex: only the active tab is in the Tab chain; arrows move
      // between the rest (see rovingTabKeyDown).
      tabIndex={active ? 0 : -1}
      ref={refCallback}
      onClick={onActivate}
      className={`press flex items-center gap-2 whitespace-nowrap rounded-lg px-2.5 py-2 text-left text-ui-body transition-all duration-200 ${
        active ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      }${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

/** Roving-tabindex keyboard handler for a tablist (Arrow/Home/End). */
export function rovingTabKeyDown<T extends string>(
  tabs: T[],
  active: T,
  onSelect: (tab: T) => void,
  focus: (tab: T) => void,
): (e: ReactKeyboardEvent<HTMLElement>) => void {
  return (e) => {
    const at = tabs.indexOf(active);
    if (at < 0) return;
    let next = -1;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = (at + 1) % tabs.length;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = (at - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    const id = tabs[next]!;
    onSelect(id);
    focus(id);
  };
}

/* --- floating capsules + toasts ----------------------------------------------
 * The bottom floating family (streaming pill / jump-to-latest / expand-older /
 * toast pills) is one species: `rounded-full` + `--shadow-float`. `--shadow-panel`
 * collapses on a ~30px capsule (its -24px spread shrinks the rect by 48px), so
 * pills must never use it.
 * -------------------------------------------------------------------------- */

export type FloatTone = "neutral" | "primary" | "warning" | "danger" | "decision";

const FLOAT_TONES: Record<FloatTone, string> = {
  neutral: "acrylic-pop border border-border text-foreground shadow-float",
  primary: "bg-primary text-primary-foreground shadow-float",
  warning: "border border-warning/50 bg-warning/15 text-warning shadow-float backdrop-blur-md",
  danger: "border border-destructive/45 bg-destructive/15 text-destructive shadow-float backdrop-blur-md",
  decision: "acrylic-pop border-primary/45 text-foreground shadow-float",
};

export function FloatPill({
  tone = "neutral",
  size = "md",
  className = "",
  children,
}: {
  tone?: FloatTone;
  /** `md` = 13px body (toast), `sm` = 12px caption (streaming band). */
  size?: "md" | "sm";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`inline-flex items-center gap-2 rounded-full shadow-float ${
        size === "md" ? "px-3 py-2 text-ui-label leading-snug" : "px-4 py-1.5 text-ui-caption font-medium"
      } ${FLOAT_TONES[tone]}${className ? ` ${className}` : ""}`}
    >
      {children}
    </div>
  );
}

/** Interactive floating chip (jump-to-latest / expand-older). */
export function FloatChip({
  children,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`press inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-ui-caption font-medium text-foreground shadow-float hover:bg-surface-2${
        className ? ` ${className}` : ""
      }`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Live countdown chip ("Ns"), anchored to the host's absolute epoch deadline
 * so the UI never drifts from message round-trip latency. Shared by the toast
 * stack pills and the streaming pill's merged countdown. */
export function CountdownSeconds({ deadline }: { deadline: number }) {
  const [secs, setSecs] = useState(Math.ceil((deadline - Date.now()) / 1000));
  useEffect(() => {
    let last = -1;
    const tick = () => {
      const left = Math.max(0, deadline - Date.now());
      const s = Math.ceil(left / 1000);
      if (s !== last) {
        last = s;
        setSecs(s);
      }
    };
    tick();
    const iv = setInterval(tick, 250);
    return () => clearInterval(iv);
  }, [deadline]);
  return <span className="ml-0.5 shrink-0 font-mono tabular-nums opacity-80">{secs}s</span>;
}

/** Domain icon for a sticky notice that asks for a decision, so the pill reads
 * as its own species instead of a generic info dot. */
const TOAST_ACTION_ICON: Record<string, typeof Info> = {
  "memory-review": Brain,
};

/** Decision-card species for a sticky notice that carries previews (the
 * auto-memory candidate batch): the approval-card family — eyebrow + title,
 * the lines that would be written, and one actions row. The primary button is
 * the ONLY forward channel; 「忽略」and the header X retire the notice, so no
 * second affordance competes with the decision. */
function ToastCard({ toast, dismiss }: { toast: ToastItem; dismiss: (id: number) => void }) {
  const previews = toast.preview ?? [];
  return (
    <div className="acrylic glow-ring card-lift pointer-events-auto stream-in w-full max-w-[min(100%,34rem)] rounded-xl border border-primary/45">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <Brain className={`${ICON_INLINE} shrink-0 text-primary`} />
        <span className="block min-w-0 flex-1 space-y-0.5">
          <span className="block text-ui-micro tracking-wide text-muted-foreground/85">
            {t("iFlow 建议沉淀记忆")}
          </span>
          <span className="block truncate text-ui-label font-semibold leading-tight">{toast.message}</span>
        </span>
        <IconButton
          icon={<X className={ICON_INLINE} />}
          label={t("关闭")}
          size="sm"
          className="ml-auto"
          onClick={() => dismiss(toast.id)}
        />
      </div>
      {previews.length > 0 && (
        <div className="space-y-1 px-3 py-2">
          {previews.map((item, index) => (
            <div key={index} className="flex items-start gap-1.5">
              <Chip tone={item.scope === "project" ? "primary" : "muted"}>
                {item.scope === "project" ? t("项目") : t("全局")}
              </Chip>
              <span className="min-w-0 flex-1 break-words text-ui-caption leading-relaxed text-foreground/90">
                {item.text}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 px-3 py-2">
        {toast.action && (
          <Button
            variant="primary"
            size="sm"
            icon={<Check className={`${ICON_INLINE} shrink-0`} />}
            onClick={() =>
              useChat.getState().send({ type: "toastAction", actionId: toast.action!.actionId, toastId: toast.toastId })
            }
          >
            {toast.action.label}
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={() => dismiss(toast.id)}>
          {t("忽略")}
        </Button>
        <span className="ml-auto text-ui-micro text-muted-foreground/80">{t("确认后才会写入记忆")}</span>
      </div>
    </div>
  );
}

/** One toast pill — overlay species, not a transcript card: the bottom
 * floating capsule family, so it rounds full rather than taking the 12px card
 * radius. Click semantics: sticky pills close on the message body, plain
 * toasts dismiss on click, and host-owned waits (countdown / display-only /
 * persistent) stay non-clickable because the host owns their lifecycle. An
 * actionable pill is never wrapped in the dismiss button — nesting buttons is
 * invalid HTML and used to swallow the whole action. */
function ToastPill({ toast, suppressCompressAction }: { toast: ToastItem; suppressCompressAction?: boolean }) {
  const dismiss = useChat((s) => s.dismissToast);
  // A preview-bearing sticky notice is a decision, not a status line.
  if (toast.sticky && toast.preview && toast.preview.length > 0) {
    return <ToastCard toast={toast} dismiss={dismiss} />;
  }
  const waiting = toast.level === "info" && toast.displayOnly;
  const Icon =
    toast.level === "warning"
      ? AlertTriangle
      : toast.level === "error"
        ? XCircle
        : waiting
          ? Loader2
          : TOAST_ACTION_ICON[toast.action?.actionId ?? ""] ?? Info;
  const tone: FloatTone =
    toast.level === "error"
      ? "danger"
      : toast.level === "warning"
        ? "warning"
        : toast.sticky
          ? "decision"
          : "neutral";
  const body = (
    <>
      <Icon
        className={`${ICON_INLINE} shrink-0 ${waiting || toast.level === "info" ? "text-primary" : ""} ${waiting ? "animate-spin" : ""}`}
      />
      <span className="break-words text-left">{toast.message}</span>
      {toast.countdownDeadline !== undefined && <CountdownSeconds deadline={toast.countdownDeadline} />}
    </>
  );
  // M1 P0-6: an inline action (e.g. 立即压缩) rides its own button; the
  // compress action is suppressed while a turn owns the session.
  const actionHidden = suppressCompressAction && toast.action?.actionId === "compress";
  // The action wears the pill's tone: a neutral grey chip on an amber notice
  // reads as an unrelated control (the 立即压缩 button on the context warning).
  const actionVariant: ButtonVariant = toast.sticky
    ? "primary"
    : toast.level === "warning"
      ? "warning-soft"
      : toast.level === "error"
        ? "danger-soft"
        : "secondary";
  const actionButton =
    toast.action &&
    !actionHidden && (
      <Button
        variant={actionVariant}
        size="sm"
        className={actionVariant === "secondary" ? "border-current/45 font-medium opacity-90 hover:opacity-100" : ""}
        onClick={() =>
          useChat.getState().send({ type: "toastAction", actionId: toast.action!.actionId, toastId: toast.toastId })
        }
      >
        {toast.action.label}
      </Button>
    );
  const clickable =
    toast.sticky || !(toast.countdownDeadline !== undefined || toast.displayOnly || toast.persistent || toast.action);
  return (
    <FloatPill tone={tone} className="pointer-events-auto stream-in max-w-[92%]">
      {clickable ? (
        <button
          type="button"
          onClick={() => dismiss(toast.id)}
          title={toast.sticky ? t("关闭") : undefined}
          className="flex min-w-0 items-center gap-1.5 text-left"
        >
          {body}
        </button>
      ) : (
        <span className="flex min-w-0 items-center gap-1.5 text-left">{body}</span>
      )}
      {actionButton}
      {toast.sticky ? (
        <IconButton icon={<X className={ICON_INLINE} />} label={t("关闭")} size="sm" onClick={() => dismiss(toast.id)} />
      ) : null}
    </FloatPill>
  );
}

/** Transient host notices, rendered as a centered stack above the streaming
 * indicator. Bottom-anchored pending cards (approval / plan / question) and the
 * floating bottom band are cleared via `--pending-card-h` / `--stream-pill-h`;
 * the stack bottom is computed from those measured heights, never a fixed
 * offset. */
export function ToastStack({
  skipToastId,
  suppressCompressAction,
  rideBand,
}: {
  skipToastId?: number;
  /** A turn owns the session: hide the 立即压缩 action (the host refuses it). */
  suppressCompressAction?: boolean;
  /** A sticky bottom band is on screen: the stack rides above it. */
  rideBand?: boolean;
}) {
  const toasts = useChat((s) => s.toasts);
  const visible = skipToastId === undefined ? toasts : toasts.filter((x) => x.id !== skipToastId);
  if (visible.length === 0) return null;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-20 flex flex-col items-center gap-1.5 px-3"
      style={{
        bottom: rideBand
          ? "calc(2.5rem + var(--pending-card-h, 0px) + var(--stream-pill-h, 0px))"
          : "calc(3.5rem + var(--pending-card-h, 0px))",
      }}
    >
      {visible.map((toast) => (
        <ToastPill key={toast.id} toast={toast} suppressCompressAction={suppressCompressAction} />
      ))}
    </div>
  );
}