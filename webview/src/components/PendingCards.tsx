import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { Layers } from "lucide-react";
import type { PendingApprovalUi, PendingQuestionsUi } from "../../../shared/messages";
import { t } from "../i18n";
import { Button, ICON_INLINE } from "./ui";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";

/**
 * Pending-action overlay (approval / ask_user_question).
 *
 * Single card: exactly the previous rendering — bottom-anchored, `pb-3`, the
 * card caps itself with `max-h-full` and scrolls its own body.
 *
 * Two or more cards: STACKED. Only the newest arrival is fully visible; the
 * others peek out as 8px edges above it (at most 3 edges — more would be
 * unreadable at this width), and a counter pill on top of the stack is the
 * single expand entry point. Expanding restores the flat list (vertical,
 * `gap-2`, bottom-anchored, overlay scrolls and sticks to the bottom).
 *
 * Why the wrapper elements: each card owns local state (question answers,
 * optimistic answered lock), so a card must never be
 * unmounted when it slides under a newer one. Every kind therefore keeps ONE
 * stable wrapper element and only its classes change:
 *  - list mode  → `display: contents`, so the card is a flex item of the
 *    overlay exactly as before (its `max-h-full` keeps resolving against the
 *    overlay's definite height, and `gap-2` applies between cards);
 *  - stacked    → a clipped 8px strip (`overflow-hidden`) that shows the
 *    card's own top edge; the newest one is a shrinkable flex item so its
 *    `max-h-full` resolves against the space left below the counter + edges.
 * Visual stacking order is done with the flex `order` property, never by
 * reordering DOM nodes (a move would drop focus and could remount cards).
 *
 * Newest-arrival detection: the three pending fields carry no timestamps, so
 * each pending INSTANCE gets a monotonic stamp the first time it appears
 * (`useRef<Map<instanceKey, number>>`), dropped when the instance disappears.
 * The key MUST include the id, not just the kind: the host can swap one
 * pending card for another of the same kind within a single snapshot
 * (approval A → approval B, same `kind`, new `id`), and a kind-only key would
 * keep the stale stamp so the replacement never reaches the top. A fixed
 * priority would be wrong too — e.g. a question that arrives after an
 * approval must be the one fully visible.
 */

type PendingKind = "approval" | "questions";

interface PendingEntry {
  kind: PendingKind;
  /**
   * Identity of this pending instance (`${kind}:${id}`), stable while the host
   * keeps the same request and different once it replaces it. Used only for
   * arrival ordering; the DOM stays keyed by `kind` so cards never remount.
   */
  key: string;
  /** Card heading, used for the counter's accessible name. */
  summary: string;
}

/** Peek height of each covered card; also the cap on visible edges. */
const EDGE_PX = 8;
const MAX_VISIBLE_EDGES = 3;

export function PendingCards({
  pendingApproval,
  pendingQuestions,
}: {
  pendingApproval: PendingApprovalUi | null;
  pendingQuestions: PendingQuestionsUi | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLElement | null>(null);
  const stampsRef = useRef<Map<string, number>>(new Map());
  const stampSeqRef = useRef(0);

  // Stable DOM order (approval → questions) so React never moves a card; the
  // visual stack is ordered with CSS `order` instead.
  const present = useMemo<PendingEntry[]>(() => {
    const list: PendingEntry[] = [];
    if (pendingApproval) {
      list.push({
        kind: "approval",
        key: `approval:${pendingApproval.id}`,
        summary: t("iFlow 想执行一项操作"),
      });
    }
    if (pendingQuestions) {
      list.push({
        kind: "questions",
        key: `questions:${pendingQuestions.id}`,
        summary: t("iFlow 有问题想问你"),
      });
    }
    return list;
  }, [pendingApproval, pendingQuestions]);

  // Stamp on first appearance, drop every key that is no longer present, then
  // rank by stamp. Keying on `${kind}:${id}` is what makes a same-kind
  // replacement (approval A → approval B) count as a fresh arrival; the sweep
  // deletes the old instance's key in the same pass, so the map cannot grow
  // across replacements. Runs during render (idempotent) so the very first
  // paint already knows which card is the newest — an effect would flash the
  // wrong top card.
  const { topKind, hiddenKinds } = useMemo(() => {
    const stamps = stampsRef.current;
    const keys = present.map((entry) => entry.key);
    for (const key of keys) {
      if (!stamps.has(key)) stamps.set(key, ++stampSeqRef.current);
    }
    for (const key of [...stamps.keys()]) {
      if (!keys.includes(key)) stamps.delete(key);
    }
    const ranked = [...present].sort((a, b) => (stamps.get(b.key) ?? 0) - (stamps.get(a.key) ?? 0));
    return {
      topKind: ranked[0]?.kind,
      hiddenKinds: ranked.slice(1).map((entry) => entry.kind),
    };
  }, [present]);

  const count = present.length;
  const stacked = !expanded && count >= 2;
  const listMode = !stacked;
  const edgeKinds = hiddenKinds.slice(0, MAX_VISIBLE_EDGES);
  const hiddenSummary = hiddenKinds
    .map((kind) => present.find((entry) => entry.kind === kind)?.summary ?? "")
    .filter(Boolean)
    .join(t("、"));

  // All three cards gone → back to the initial stacked state and forget the
  // arrival stamps so the next card starts a fresh stack.
  useEffect(() => {
    if (count > 0) return;
    stampsRef.current.clear();
    stampSeqRef.current = 0;
    setExpanded(false);
  }, [count]);

  // `--pending-card-h` is the clearance MessageList reserves under the
  // transcript (and the "生成中" pill rides on top of). Single writer, same
  // mechanism as before: a ResizeObserver mirrors the visible band into a CSS
  // custom property on the transcript wrapper (the overlay's parent). Stacked
  // → counter + edges + top card; expanded → whole list; single → the card.
  const layoutKey = `${pendingApproval?.id ?? ""}|${pendingQuestions?.id ?? ""}|${count}|${stacked ? "stacked" : "list"}`;
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) {
      wrapperRef.current?.style.removeProperty("--pending-card-h");
      return;
    }
    const wrapper = overlay.parentElement;
    if (!wrapper) return;
    wrapperRef.current = wrapper;
    // `data-pending-top` sits on the slot wrapper in the single-card / list
    // layout, and that slot is `display: contents` — it has no box, so its
    // getBoundingClientRect() is all zeros (measured: the band then clamps to
    // the overlay's full height, e.g. 900px instead of the card's 310px).
    // Resolve the real card before measuring.
    const measureTarget = () => {
      const probe = overlay.querySelector<HTMLElement>("[data-pending-top]");
      if (!probe) return null;
      if (getComputedStyle(probe).display !== "contents") return probe;
      return probe.firstElementChild instanceof HTMLElement ? probe.firstElementChild : null;
    };
    const apply = () => {
      const top = measureTarget();
      if (!top) {
        wrapper.style.removeProperty("--pending-card-h");
        return;
      }
      const overlayRect = overlay.getBoundingClientRect();
      // Layout box, not viewport rect: getBoundingClientRect includes the
      // card's `stream-in` entrance transform (translateY(8px)), and a
      // transform change never fires the ResizeObserver — the first measure
      // would then stay stale by ~9px (measured 300.5px vs the real 310px).
      // `offsetTop` is relative to the overlay itself (it is the positioned
      // ancestor — verified in the browser) and includes its pb-3.
      //
      // Expanded is special: the counter is `sticky top-0` in the scroll
      // container, and a sticky box's offsetTop follows the scroll offset
      // (measured 0px when scrolled to the bottom, 870px instead of 900.5px
      // when partially scrolled), so it cannot be measured like a normal box.
      // There the list fills the shell and the counter pins to its top edge —
      // the painted band is the whole overlay. Keyed on "the counter exists
      // and is sticky" (count >= 2), not on `expanded` alone: after the other
      // cards are answered the counter disappears while `expanded` is still
      // true, and a lone card must fall back to the normal measurement.
      const band =
        expanded && count >= 2
          ? overlay.clientHeight
          : top.offsetParent === overlay
            ? overlay.clientHeight - top.offsetTop
            : overlayRect.bottom - top.getBoundingClientRect().top;
      const height = Math.max(0, Math.min(band, overlayRect.height));
      wrapper.style.setProperty("--pending-card-h", `${height}px`);
    };
    apply();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(apply) : null;
    observer?.observe(overlay);
    for (const child of Array.from(overlay.children)) observer?.observe(child);
    // The card itself can grow without the overlay changing size (the overlay
    // is inset-sized), so observe the measured element too.
    const target = measureTarget();
    if (target) observer?.observe(target);
    return () => observer?.disconnect();
  }, [layoutKey]);

  // Unmount (or "no cards left") must clear the clearance, otherwise the
  // transcript keeps a stale bottom padding.
  useEffect(
    () => () => {
      wrapperRef.current?.style.removeProperty("--pending-card-h");
    },
    [],
  );

  // Expanded list is a scroll container; keep the newest card (bottom) in
  // view when the card set changes. Same rule as before: only a set change
  // re-sticks, a content-only re-render never fights a user who scrolled up.
  useEffect(() => {
    if (!expanded) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const stick = () => {
      overlay.scrollTop = overlay.scrollHeight;
    };
    stick();
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(stick) : null;
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [expanded, layoutKey]);

  if (count === 0) return null;

  return (
    <div
      ref={overlayRef}
      id={listId}
      data-pending-overlay=""
      // The shell spans the transcript wrapper (definite height → cards can
      // cap themselves with max-h-full). pointer-events-none keeps the empty
      // gutters transparent; each card re-enables pointer events on itself.
      //
      // `pt-1` (expanded list only, i.e. count >= 2 → the counter exists):
      // the list layout is a SCROLL container, so the sticky counter's top
      // edge would sit exactly ON the clip line — and the counter is a
      // `card-lift` canvas button whose hover lifts it 1px (translateY(-1px)),
      // so the lift pushed the button's top border outside the clip and the
      // border row vanished (Chromium + CDP, pixel-decoded: idle gapTop 0 →
      // hover gapTop -1, the painted border row lost 96% of its pixels).
      // A 4px top padding moves the sticky box's constraint edge down with
      // it → hover gapTop 3, the border row stays whole.
      //
      // Why not `overflow-y: visible` (the fix used for the composer's action
      // row): this overlay MUST scroll vertically — the expanded list scrolls
      // inside it and the counter sticks to its top. Letting the vertical
      // axis overflow would spill the list into the transcript.
      //
      // Scoped to count >= 2 on purpose: the single-card layout has no
      // counter and no clipping problem, and the stacked layout has no
      // vertical scroll at all — neither may move by a single pixel.
      className={
        listMode
          ? `pointer-events-none absolute inset-x-0 bottom-0 z-30 flex min-h-0 flex-col gap-2 overflow-y-auto pb-3${count >= 2 ? " pt-1" : ""}`
          : "pointer-events-none absolute inset-x-0 bottom-0 z-30 flex min-h-0 flex-col justify-end pb-3"
      }
      style={{ top: "var(--super-bar-h, 0px)" }}
    >
      {count >= 2 && (
        <Button
          variant="canvas"
          size="sm"
          icon={<Layers className={ICON_INLINE} />}
          // The only way in and out of the stack. Visible label is short; the
          // accessible name spells out which cards are buried underneath.
          // In the expanded list it stays pinned to the scrollport top —
          // otherwise a list taller than the overlay scrolls the collapse
          // affordance out of view and the stack can only be re-collapsed by
          // scrolling back up.
          className={`pointer-events-auto mb-1 self-center shadow-card${listMode ? " sticky top-0 z-10" : ""}`}
          aria-expanded={expanded}
          aria-controls={listId}
          aria-label={
            expanded
              ? t("收起待处理卡")
              : t("还有 {0} 张卡片待处理：{1}", hiddenKinds.length, hiddenSummary)
          }
          data-pending-top=""
          data-pending-counter=""
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("收起待处理卡") : t("还有 {0} 张卡片待处理", hiddenKinds.length)}
        </Button>
      )}
      {present.map((entry) => {
        const isTop = entry.kind === topKind;
        const covered = stacked && !isTop;
        const edgeIndex = edgeKinds.indexOf(entry.kind);
        const showsEdge = covered && edgeIndex >= 0;
        const firstInList = listMode && entry.kind === present[0]?.kind;
        const slotClass = listMode
          ? // `contents` keeps the card a direct flex item of the overlay:
            // its max-h-full still resolves against the overlay and gap-2
            // still applies between cards. mt-auto on the first card is what
            // bottom-aligns the list in a scroll container (flex-end would
            // make overflow above the start edge unreachable).
            `contents${firstInList ? " [&>*]:mt-auto" : ""}`
          : isTop
            ? // Shrinkable so the card's max-h-full resolves to the space
              // left below the counter + peek edges.
              "flex min-h-0 shrink flex-col"
            : "pointer-events-none block shrink-0 overflow-hidden";
        const slotStyle: CSSProperties | undefined = listMode
          ? undefined
          : isTop
            ? { order: edgeKinds.length + 1 }
            : { order: showsEdge ? edgeKinds.length - edgeIndex : 0, height: showsEdge ? EDGE_PX : 0 };
        return (
          <div
            key={entry.kind}
            data-pending-slot={entry.kind}
            // The single-card case has no counter, so the card itself anchors
            // the height measurement.
            data-pending-top={count === 1 ? "" : undefined}
            className={slotClass}
            style={slotStyle}
            // Covered cards stay MOUNTED (local state must survive) but leave
            // the tab order and the accessibility tree. `inert` is the primary
            // switch (Chromium/VSCode); aria-hidden + pointer-events-none keep
            // older engines honest.
            inert={covered || undefined}
            aria-hidden={covered ? true : undefined}
          >
            {entry.kind === "approval" && pendingApproval && (
              // `covered` is the stack's own notion of "buried under a newer
              // card"; the shortcut listener keys off it explicitly because
              // `inert` (set on the slot below) does not mute window handlers.
              <ApprovalCard approval={pendingApproval} active={!covered} />
            )}
            {entry.kind === "questions" && pendingQuestions && (
              <QuestionCard pending={pendingQuestions} active={!covered} />
            )}
          </div>
        );
      })}
    </div>
  );
}
