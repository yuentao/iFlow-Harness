import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, FileCode2, HelpCircle, X } from "lucide-react";
import { useChat } from "../store";
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
        if (dismissible) onClose();
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
    // onClose closes over section state (e.g. the choice dialog's answered
    // flag); re-registering keeps the closure current.
  }, [dismissible, onClose]);

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
              <ArrowLeft className="size-3.5" />
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
              <X className="size-3.5" />
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
 */
export function CountdownBar({
  deadline,
  timeoutMs,
}: {
  deadline: number;
  timeoutMs: number;
}) {
  const { remainingMs, ratio } = useCountdown(deadline, timeoutMs);
  const urgent = remainingMs <= 15_000;
  const warning = remainingMs <= 60_000;
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
 * Small `?` help affordance: hover/focus opens a `role="tooltip"` bubble,
 * click opens it for touch. Use for concepts a card cannot explain inline
 * (approval policy semantics, Plan-mode artifacts, shortcut hints) without
 * stealing visual weight from the actual actions.
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
  return (
    <span
      className={`relative inline-flex shrink-0${className ? ` ${className}` : ""}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        className="press inline-flex size-5 items-center justify-center rounded-full border border-border/70 text-muted-foreground transition-colors duration-200 hover:border-primary/40 hover:text-foreground"
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <HelpCircle className="size-3" />
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className={`absolute top-full z-50 mt-1 w-60 max-w-[calc(100vw-48px)] rounded-xl border border-border bg-card px-2.5 py-2 text-ui-caption font-normal leading-relaxed text-foreground shadow-panel ${
            align === "left" ? "left-0" : "right-0"
          }`}
        >
          {children}
        </span>
      )}
    </span>
  );
}

/*
 * P2-18 shared button primitives. The settings surface used to re-declare
 * byte-identical INPUT/BTN/SAVE_BTN strings in three files (Composer had its
 * own CANVAS_BTN variant, the header its BTN_ICON) — four definitions whose
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
/** Compact icon-only button (header cluster, 28×28). */
export const BTN_ICON =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-all duration-200 hover:bg-surface hover:text-foreground active:scale-95 disabled:pointer-events-none disabled:opacity-40";
/** Icon scale: 14px inline controls, 16px toolbar buttons, 20px empty states. */
export const ICON_INLINE = "size-3.5";
export const ICON_TOOLBAR = "size-4";
export const ICON_DISPLAY = "size-5";

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
        '[role="menuitem"]:not([data-variant="danger"]), button.menu-item',
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
    focusMenuItem(getMenuItems(), 0);
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
          className={`absolute z-30 overflow-hidden rounded-xl border border-border acrylic-pop dropdown-in ${
            direction === "up" ? "bottom-full mb-1" : "top-full mt-1"
          } ${align === "right" ? "right-0" : "left-0"} ${menuClass}`}
        >
          {children(closeAndNotify)}
        </div>
      )}
    </div>
  );
}