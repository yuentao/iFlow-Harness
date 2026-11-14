import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Layers } from "lucide-react";
import type { PendingApprovalUi, PendingPlanExitUi, PendingQuestionsUi } from "../../../shared/messages";
import { t } from "../i18n";
import { Button, ICON_INLINE } from "./ui";
import { ApprovalCard } from "./ApprovalCard";
import { PlanExitCard } from "./PlanExitCard";
import { QuestionCard } from "./QuestionCard";

/**
 * Pending-action overlay (approval / plan-exit / ask_user_question).
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
 * Why the wrapper elements: each card owns local state (draft plan text,
 * question answers, optimistic answered lock), so a card must never be
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
 * each kind gets a monotonic stamp the first time it appears
 * (`useRef<Map<kind, number>>`), cleared when the kind disappears. A fixed
 * priority would be wrong — e.g. a question that arrives after an approval
 * must be the one fully visible.
 */

type PendingKind = "approval" | "planExit" | "questions";

interface PendingEntry {
  kind: PendingKind;
  /** Card heading, used for the counter's accessible name. */
  summary: string;
  node: ReactNode;
}

/** Peek height of each covered card; also the cap on visible edges. */
const EDGE_PX = 8;
const MAX_VISIBLE_EDGES = 3;

export function PendingCards({
  pendingApproval,
  pendingPlanExit,
  pendingQuestions,
}: {
  pendingApproval: PendingApprovalUi | null;
  pendingPlanExit: PendingPlanExitUi | null;
  pendingQuestions: PendingQuestionsUi | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLElement | null>(null);
  const stampsRef = useRef<Map<PendingKind, number>>(new Map());
  const stampSeqRef = useRef(0);

  // Stable DOM order (approval → planExit → questions) so React never moves a
  // card; the visual stack is ordered with CSS `order` instead.
  const present = useMemo<PendingEntry[]>(() => {
    const list: PendingEntry[] = [];
    if (pendingApproval) {
      list.push({ kind: "approval", summary: t("iFlow 请求执行"), node: <ApprovalCard approval={pendingApproval} /> });
    }
    if (pendingPlanExit) {
      list.push({
        kind: "planExit",
        summary: t("iFlow 请求退出 Plan 模式"),
        node: <PlanExitCard pending={pendingPlanExit} />,
      });
    }
    if (pendingQuestions) {
      list.push({ kind: "questions", summary: t("iFlow 需要你的回答"), node: <QuestionCard pending={pendingQuestions} /> });
    }
    return list;
  }, [pendingApproval, pendingPlanExit, pendingQuestions]);

  // Stamp on first appearance, drop when the kind disappears, then rank by
  // stamp. Runs during render (idempotent) so the very first paint already
  // knows which card is the newest — an effect would flash the wrong top card.
  const { topKind, hiddenKinds } = useMemo(() => {
    const stamps = stampsRef.current;
    const kinds = present.map((entry) => entry.kind);
    for (const kind of kinds) {
      if (!stamps.has(kind)) stamps.set(kind, ++stampSeqRef.current);
    }
    for (const kind of [...stamps.keys()]) {
      if (!kinds.includes(kind)) stamps.delete(kind);
    }
    const ranked = [...kinds].sort((a, b) => (stamps.get(b) ?? 0) - (stamps.get(a) ?? 0));
    return { topKind: ranked[0], hiddenKinds: ranked.slice(1) };
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
  const layoutKey = `${pendingApproval?.id ?? ""}|${pendingPlanExit?.id ?? ""}|${pendingQuestions?.id ?? ""}|${count}|${stacked ? "stacked" : "list"}`;
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) {
      wrapperRef.current?.style.removeProperty("--pending-card-h");
      return;
    }
    const wrapper = overlay.parentElement;
    if (!wrapper) return;
    wrapperRef.current = wrapper;
    const apply = () => {
      const top = overlay.querySelector<HTMLElement>("[data-pending-top]");
      if (!top) {
        wrapper.style.removeProperty("--pending-card-h");
        return;
      }
      const overlayRect = overlay.getBoundingClientRect();
      const topRect = top.getBoundingClientRect();
      // Measure viewport rects, not offsetTop: the overlay is absolutely
      // positioned, so offsetTop chains are relative to different boxes.
      const band = overlayRect.bottom - topRect.top;
      const height = Math.max(0, Math.min(band, overlayRect.height));
      wrapper.style.setProperty("--pending-card-h", `${height}px`);
    };
    apply();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(apply) : null;
    observer?.observe(overlay);
    for (const child of Array.from(overlay.children)) observer?.observe(child);
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
      className={
        listMode
          ? "pointer-events-none absolute inset-x-0 bottom-0 z-30 flex min-h-0 flex-col gap-2 overflow-y-auto pb-3"
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
              : t("还有 {0} 个待处理：{1}", hiddenKinds.length, hiddenSummary)
          }
          data-pending-top=""
          data-pending-counter=""
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("收起待处理卡") : t("还有 {0} 个待处理", hiddenKinds.length)}
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
            {entry.node}
          </div>
        );
      })}
    </div>
  );
}
