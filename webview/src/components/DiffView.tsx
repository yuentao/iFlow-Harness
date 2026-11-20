import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Ellipsis, FileCode2, Undo2 } from "lucide-react";
import type { DiffHunkUi, ToolDiffUi } from "../../../shared/messages";
import { computeHunks, diffRows, type DiffOp } from "../../../shared/hunks";
import { t } from "../i18n";
import { Button, FileRef, ICON_INLINE } from "./ui";

interface DiffRow {
  type: "add" | "del" | "same" | "hunk";
  /** Display line number (old numbering for del/same, new for add). */
  n: string;
  text: string;
  /** Gap index for hunk separators, so clicking expands the right region. */
  win?: number;
  /** P0-2: index into the hunk list this row belongs to (changed rows only). */
  hunk?: number;
  /** P0-2: this changed row is the FIRST row of its hunk (render the header). */
  hunkHead?: boolean;
  /** P0-2: this changed row is inside a reverted hunk (rendered struck through). */
  reverted?: boolean;
}

/** Context lines kept around each change, like git's unified diff. */
const CONTEXT_LINES = 3;

/**
 * Rendered-row cap for the diff body (long-session memory, second wave
 * 2026-10): a whole-file change window cannot be folded by
 * `collapseAroundChanges`, so a monster diff (minified-bundle edits reach the
 * 256KB cap) used to put tens of thousands of row nodes into the DOM for
 * EVERY mounted card. Render a bounded prefix; scrolling near the bottom of
 * the scroll body — or the trailing button — loads more on demand.
 */
const INITIAL_RENDER_ROWS = 800;
const RENDER_ROWS_STEP = 800;

/**
 * P1 (long-session memory, 3.4.0): the 800-row prefix above is capped but
 * GREW WITHOUT BOUND as the user scrolled — dozens of mounted diff cards with
 * tens of thousands of rows each were the main driver of multi-hundred-MB
 * webview processes. Cap the number of rows that stay in the DOM per card.
 *
 * A conservative sliding window is used ONLY for diffs whose folded result
 * has no "⋯" gap rows (e.g. whole-file/minified edits where every line is a
 * change) — the exact case from pitfall #27 that `collapseAroundChanges` cannot
 * shrink. Folded diffs keep the original prefix behaviour so gap
 * expand/collapse (which shifts row indices) is never disturbed.
 *
 * `windowStart`/`renderCap` are absolute indices into `rows`; the invariant
 * `renderCap - windowStart <= MAX_DOM_ROWS` holds. When appending hits the cap,
 * the surplus top rows are recycled into a single spacer whose pixel height is
 * the sum of their measured heights — the scroll height (and thus the visible
 * position) stays unchanged. A "加载上方 N 行" button restores them on demand
 * and drops an equal count from the far bottom to re-apply the cap.
 */
const MAX_DOM_ROWS = 1200;
/** Rows restored by the top "加载上方" button in one click. */
const RECOVERY_BLOCK = 400;

/**
 * Content-keyed cache of the line alignment (the LCS).
 *
 * `shared/hunks.ts#diffRows` is O(oldLines × newLines) — up to the 4M-cell
 * guard — and a diff body can reach the 256KB cap. Every blockPatch
 * re-serializes the transcript tail, so the `diff` OBJECT identity changes on
 * every patch even when its CONTENT did not: a per-render memo keyed on the
 * diff object therefore missed, and every mounted diff card re-ran the
 * alignment on every patch.
 *
 * The cache is keyed by CONTENT (path + both lengths + a hash of both texts),
 * never by object identity, so a re-serialized but unchanged diff hits. The
 * key stays small — no diff body in it — and the hash is O(chars), orders of
 * magnitude cheaper than the alignment it replaces.
 *
 * Capacity is bounded ({@link DIFF_CACHE_LIMIT}) and the OLDEST entry is
 * evicted first: a Map keeps insertion order, and a hit re-inserts its entry
 * so it becomes the newest one.
 */
const DIFF_CACHE_LIMIT = 16;

/** One cached alignment: both sides split, the op sequence and the hunks. */
interface DiffAlignment {
  /** Raw old side (null = the file did not exist before). */
  oldText: string | null;
  /** Raw new side (null = the file was deleted). */
  newText: string | null;
  /** Split old side (null = the file did not exist before). */
  oldLines: string[] | null;
  /** Split new side (null = the file was deleted). */
  newLines: string[] | null;
  /** Line alignment of both sides. */
  ops: DiffOp[];
  /**
   * Per-hunk split for the keep/revert decisions. `undefined` = not computed
   * yet — only editable diffs need it, so it is computed on demand and then
   * kept in the entry.
   */
  hunks: DiffHunkUi[] | null | undefined;
}

/** The alignment cache (content key → alignment). */
const diffAlignmentCache = new Map<string, DiffAlignment>();

/** FNV-1a over the text — a cheap content fingerprint for the cache key. */
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Content key of a diff: path + both lengths + both text hashes. */
function diffContentKey(diff: ToolDiffUi): string {
  const oldText = diff.oldText ?? "";
  const newText = diff.newText ?? "";
  return `${diff.path} ${oldText.length} ${newText.length} ${hashText(oldText)} ${hashText(newText)}`;
}

/** Cached alignment of a diff; computes it on the first miss. */
function getDiffAlignment(diff: ToolDiffUi): DiffAlignment {
  const key = diffContentKey(diff);
  const hit = diffAlignmentCache.get(key);
  if (hit) {
    // Refresh the LRU position: a hit becomes the newest entry.
    diffAlignmentCache.delete(key);
    diffAlignmentCache.set(key, hit);
    return hit;
  }
  const oldText = diff.oldText;
  const newText = diff.newText;
  const oldLines = oldText === null ? null : oldText.split("\n");
  const newLines = newText === null ? null : newText.split("\n");
  const alignment: DiffAlignment = {
    oldText,
    newText,
    oldLines,
    newLines,
    ops: diffRows(oldLines ?? [], newLines ?? []),
    hunks: undefined,
  };
  diffAlignmentCache.set(key, alignment);
  while (diffAlignmentCache.size > DIFF_CACHE_LIMIT) {
    const oldest = diffAlignmentCache.keys().next().value;
    if (oldest === undefined) break;
    diffAlignmentCache.delete(oldest);
  }
  return alignment;
}

/**
 * Per-hunk split for the keep/revert decisions. Computed on demand (only
 * editable diffs need it — a plain diff card never shows hunk headers) and
 * then kept in the cache entry, so it survives the re-serialization that
 * every blockPatch causes.
 */
function getDiffHunks(alignment: DiffAlignment): DiffHunkUi[] | null {
  if (alignment.hunks !== undefined) return alignment.hunks;
  const { oldText, newText } = alignment;
  alignment.hunks =
    oldText !== null && newText !== null ? computeHunks(oldText, newText) : null;
  return alignment.hunks;
}

/**
 * Line-level diff renderer for structured tool diffs
 * (`{type:"diff", path, oldText, newText}` from `tool_call_update`).
 * LCS-based so edits show as paired -/+ lines like an editor gutter, then
 * folded git-style: each change keeps CONTEXT_LINES of context, the rest of
 * an unchanged file collapses into clickable "⋯" hunks that expand on demand.
 *
 * M4 P0-2: when `hunkActions` is provided (editable diffs only), each hunk
 * gets a keep/revert header and the bottom action bar gains a commit button.
 * P2-14: every toggle (fold gaps, keep/revert, commit) is a real <button> —
 * Tab reaches it, Enter toggles, and the global :focus-visible ring paints —
 * with ARIA state (aria-expanded / aria-pressed) so keyboard and AT users
 * can read which hunks are folded or reverted, not just see it.
 */
export function DiffView({
  diff,
  actions,
  toolCallId,
  hunkActions,
  maxHeightClass = "max-h-60",
  chrome = "card",
}: {
  diff: ToolDiffUi;
  actions?: ReactNode;
  toolCallId?: string;
  /** Surface style inherited from the containing block: `card` (main
   * transcript) keeps the framed diff box; `flat` (Super Agent live pane)
   * drops the outer card fill and tightens the paddings, while the diff body
   * itself keeps its readable red/green rows. */
  chrome?: "card" | "flat";
  /** P0-2 per-hunk editing: present only for completed, editable diffs. */
  hunkActions?: {
    /** Committed decisions to restore UI state (index-aligned with hunks). */
    decisions?: boolean[];
    /** Commit the (possibly edited) decision set. */
    onApply: (keep: boolean[]) => void;
    /** True while the host is processing a commit. */
    busy?: boolean;
  };
  /** Height cap class for the scroll body. Bottom-anchored overlay cards
   * (approval) pass a viewport-relative cap so the fixed 240px default
   * cannot push the card's action row off-screen on short panels. */
  maxHeightClass?: string;
}) {
  const editable = !!hunkActions && diff.oldText !== null && diff.newText !== null;
  // Content-keyed alignment (see the cache above). The memo is keyed on the
  // CONTENT, so a diff that was merely re-serialized by a blockPatch keeps
  // the cached alignment instead of re-running the LCS.
  const diffKey = useMemo(() => diffContentKey(diff), [diff]);
  const alignment = useMemo(() => getDiffAlignment(diff), [diffKey]);
  const hunks = useMemo(() => (editable ? getDiffHunks(alignment) : null), [editable, alignment]);
  const hunkCount = hunks?.length ?? 0;
  const [keep, setKeep] = useState<boolean[]>(() => new Array(hunkCount).fill(true));
  // A new diff, or a fresh commit from outside, resets the local decision set.
  useEffect(() => {
    setKeep(new Array(hunkCount).fill(true));
  }, [diff, hunkCount]);
  useEffect(() => {
    if (hunkActions?.decisions && hunkActions.decisions.length === hunkCount) {
      setKeep(hunkActions.decisions);
    }
  }, [hunkActions?.decisions, hunkCount]);

  const dirty = useMemo(
    () => editable && keep.some((k) => !k),
    [editable, keep],
  );

  const { rows: fullRows, windows } = useMemo(
    () => buildRows(alignment, hunks, keep),
    [alignment, hunks, keep],
  );
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  /**
   * Absolute [windowStart, renderCap) slice of `rows` currently in the DOM.
   * `renderCap` grows on scroll like before; `windowStart` stays 0 for folded
   * diffs and only advances for unfoldable ones once the cap is hit (P1).
   */
  const [windowStart, setWindowStart] = useState(0);
  const [renderCap, setRenderCap] = useState(INITIAL_RENDER_ROWS);
  /** Pixel height of the recycled rows above `windowStart`. */
  const [spacerHeight, setSpacerHeight] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Measured height of each rendered absolute row index (for exact spacer). */
  const rowHeights = useRef(new Map<number, number>());
  // Synchronous mirror so scroll handlers read the latest window even between
  // renders (React batches setState; two quick scrolls must not double-append).
  const winRef = useRef({ start: 0, cap: INITIAL_RENDER_ROWS });
  winRef.current = { start: windowStart, cap: renderCap };

  // A new diff invalidates previous expand/collapse, window and row-cap choices.
  useEffect(() => {
    setExpanded(new Set());
    setWindowStart(0);
    setRenderCap(INITIAL_RENDER_ROWS);
    setSpacerHeight(0);
    rowHeights.current.clear();
  }, [diff]);

  const rows = useMemo(
    () => collapseAroundChanges(fullRows, windows, expanded),
    [fullRows, windows, expanded],
  );
  const addCount = rows.filter((r) => r.type === "add").length;
  const delCount = rows.filter((r) => r.type === "del").length;

  // Only diffs whose folded result has NO gap ("⋯") rows are windowed. A gap
  // can be expanded/collapsed, which re-indexes `rows` and would invalidate
  // absolute window indices — keep the original prefix behaviour there. A
  // whole-file/minified edit folds to every row with no gap, so it is windowed
  // (that is the memory hog from pitfall #27).
  const windowed = !rows.some((r) => r.type === "hunk");

  // Measure rendered rows AFTER each window change, so recycling can restore
  // the exact pixel height later. jsdom reports 0 — harmless (spacer stays 0),
  // while the row-count/content invariants remain fully testable.
  useEffect(() => {
    if (!windowed) return;
    const container = scrollRef.current;
    if (!container) return;
    container.querySelectorAll<HTMLElement>("[data-diff-row]").forEach((node) => {
      const idx = Number(node.dataset.diffRow);
      if (Number.isFinite(idx) && node.offsetHeight > 0) {
        rowHeights.current.set(idx, node.offsetHeight);
      }
    });
  }, [windowed, windowStart, renderCap]);

  /** Append a step of rows; recycle an equal surplus off the top when capped. */
  const appendRows = () => {
    const { start, cap } = winRef.current;
    if (cap >= rows.length) return;
    const nextCap = Math.min(cap + RENDER_ROWS_STEP, rows.length);
    if (windowed) {
      const overflow = nextCap - start - MAX_DOM_ROWS;
      if (overflow > 0) {
        const removeEnd = start + overflow;
        let removed = 0;
        for (let i = start; i < removeEnd; i++) removed += rowHeights.current.get(i) ?? 0;
        setSpacerHeight((h) => h + removed);
        setWindowStart(removeEnd);
      }
    }
    setRenderCap(nextCap);
  };

  /** Restore a block of recycled rows above the window, re-applying the cap at
   * the far bottom so the DOM row count never exceeds MAX_DOM_ROWS. */
  const restoreAbove = () => {
    const { start, cap } = winRef.current;
    if (start <= 0) return;
    const nextStart = Math.max(0, start - RECOVERY_BLOCK);
    let restored = 0;
    for (let i = nextStart; i < start; i++) restored += rowHeights.current.get(i) ?? 0;
    setSpacerHeight((h) => Math.max(0, h - restored));
    setWindowStart(nextStart);
    const nextCap = Math.min(cap, nextStart + MAX_DOM_ROWS);
    if (nextCap < cap) setRenderCap(nextCap);
  };

  // Bounded DOM slice (see MAX_DOM_ROWS): the full row list stays in the memo
  // for folding/hunk math, only the rendered slice is capped/windowed.
  const visibleRows = rows.slice(windowStart, renderCap);
  const hiddenRows = rows.length - renderCap;

  const toggleGap = (win: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(win)) next.delete(win);
      else next.add(win);
      return next;
    });
  };

  const setHunk = (index: number, value: boolean) => {
    setKeep((prev) => {
      if (prev[index] === value) return prev;
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const keepCount = keep.filter(Boolean).length;
  const revertCount = hunkCount - keepCount;

  const flat = chrome === "flat";

  return (
    <div className={flat ? "overflow-hidden" : "overflow-hidden bg-card"}>
      <div className={`flex items-center gap-2 ${flat ? "px-2 py-1" : "px-3 py-2"}`}>
        <FileCode2 className="size-3.5 shrink-0 text-primary" />
        <FileRef path={diff.path} toolCallId={toolCallId} />
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-ui-caption">
          {addCount > 0 && <span className="text-diff-add-fg">+{addCount}</span>}
          {delCount > 0 && <span className="text-diff-del-fg">−{delCount}</span>}
        </span>
      </div>
      <div
        ref={scrollRef}
        className={`diff-scroll overflow-auto bg-editor font-mono text-ui-caption leading-[1.7] ${
          flat
            ? "mx-2 mb-2 rounded-sm border border-border/50"
            : "mx-3 mb-3 rounded-lg border border-border/60"
        } ${maxHeightClass}`}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
            appendRows();
          }
        }}
      >
        {windowStart > 0 && (
          <div
            data-diff-spacer
            aria-hidden="true"
            style={{ height: spacerHeight }}
            className="w-full"
          />
        )}
        {windowed && windowStart > 0 && (
          <button
            type="button"
            data-diff-restore
            className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-ui-caption text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
            onClick={restoreAbove}
          >
            <Ellipsis className="size-3 shrink-0" />
            <span className="truncate">{t("加载上方 {0} 行", windowStart)}</span>
          </button>
        )}
        {visibleRows.map((row, i) => {
          const abs = windowStart + i;
          return row.type === "hunk" ? (
            <button
              key={abs}
              type="button"
              className="flex w-full items-center gap-1.5 px-3 py-0.5 text-left text-ui-caption text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
              title={expanded.has(row.win ?? -1) ? t("收起") : t("展开上下文")}
              aria-expanded={expanded.has(row.win ?? -1)}
              onClick={() => toggleGap(row.win ?? -1)}
            >
              <Ellipsis className="size-3 shrink-0" />
              <span className="truncate">
                {expanded.has(row.win ?? -1) ? t("收起") : t("展开上下文")}
              </span>
            </button>
          ) : (
            <div key={abs} data-diff-row={abs}>
              {editable && row.hunkHead && row.hunk !== undefined && (
                <HunkHeader
                  index={row.hunk}
                  total={hunkCount}
                  kept={keep[row.hunk] !== false}
                  onToggle={(value) => setHunk(row.hunk!, value)}
                />
              )}
              <div
                className={`flex px-3 ${
                  row.type === "add" ? "bg-diff-add" : row.type === "del" ? "bg-diff-del" : ""
                } ${row.reverted ? "opacity-40" : ""}`}
              >
                {/* Gutter merged into one column ("+3" / "−3" / "  4"): separate
                    number + sign columns made paired -/+ lines show the same
                    number twice and read as a rendering glitch. */}
                <span
                  className={`w-9 shrink-0 select-none text-right tabular-nums ${
                    row.type === "add"
                      ? "text-diff-add-fg"
                      : row.type === "del"
                        ? "text-diff-del-fg"
                        : "text-syn-com"
                  }`}
                >
                  {row.type === "add"
                    ? `+${row.n}`
                    : row.type === "del"
                      ? `−${row.n}`
                      : `  ${row.n}`}
                </span>
                {/* pre-wrap + break-words: long lines (minified code, URLs)
                    wrap inside the card instead of forcing a horizontal
                    scrollbar; flex-1 min-w-0 lets the span shrink within the
                    row so wrapping actually kicks in. */}
                <span
                  className={`ml-3 min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground/90 ${
                    row.reverted && row.type !== "same" ? "line-through" : ""
                  }`}
                >
                  {row.text === "" ? " " : row.text === "⋯" ? "" : row.text}
                </span>
              </div>
            </div>
          );
        })}
        {hiddenRows > 0 && (
          <button
            type="button"
            className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-ui-caption text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
            onClick={appendRows}
          >
            <Ellipsis className="size-3 shrink-0" />
            <span className="truncate">{t("加载剩余 {0} 行", hiddenRows)}</span>
          </button>
        )}
      </div>
      {editable && hunkCount > 0 && (
        <div
          className={`flex flex-wrap items-center gap-2 ${
            flat ? "px-2 pb-1" : "border-t border-border/60 px-3 py-2"
          }`}
        >
          {flat ? (
            <Button
              variant="canvas"
              size="sm"
              icon={<Check className={ICON_INLINE} />}
              disabled={!dirty || hunkActions?.busy}
              title={t("把标记为回退的改动恢复成修改前的内容，其余改动保留")}
              onClick={() => hunkActions?.onApply([...keep])}
            >
              {t("应用（保留 {0} · 回退 {1}）", keepCount, revertCount)}
            </Button>
          ) : (
            <button
              className="card-lift press inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/80 px-2.5 py-1 text-ui-caption font-medium text-foreground shadow-card transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!dirty || hunkActions?.busy}
              title={t("把标记为回退的改动恢复成修改前的内容，其余改动保留")}
              onClick={() => hunkActions?.onApply([...keep])}
            >
              <Check className="size-3" /> {t("应用（保留 {0} · 回退 {1}）", keepCount, revertCount)}
            </button>
          )}
          {dirty && (
            <button
              className="press inline-flex items-center gap-1 text-ui-caption text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setKeep(new Array(hunkCount).fill(true))}
            >
              <Undo2 className="size-2.5" /> {t("全部保留")}
            </button>
          )}
        </div>
      )}
      {actions && (
        <div className={`flex flex-wrap items-center gap-2 ${flat ? "px-2 pb-1" : "px-3 py-2"}`}>
          {actions}
        </div>
      )}
    </div>
  );
}

/** Per-hunk keep/revert header, rendered above the hunk's first changed row. */
function HunkHeader({
  index,
  total,
  kept,
  onToggle,
}: {
  index: number;
  total: number;
  kept: boolean;
  onToggle: (value: boolean) => void;
}) {
  return (
    <div
      className={`flex items-center gap-2 border-y border-border/40 px-3 py-0.5 text-ui-caption ${
        kept ? "bg-surface/50 text-muted-foreground" : "bg-diff-del/40 text-diff-del-fg"
      }`}
    >
      <span className="font-medium">{t("第 {0}/{1} 处改动", index + 1, total)}</span>
      <span className="ml-auto flex items-center gap-1">
        <button
          className={`press rounded px-1.5 py-0.5 font-medium transition-colors ${
            kept ? "bg-success/20 text-success" : "text-muted-foreground hover:bg-surface-2 hover:text-foreground"
          }`}
          title={t("保留此改动")}
          aria-pressed={kept}
          onClick={() => onToggle(true)}
        >
          {t("保留")}
        </button>
        <button
          className={`press rounded px-1.5 py-0.5 font-medium transition-colors ${
            !kept ? "bg-diff-del text-diff-del-fg" : "text-muted-foreground hover:bg-surface-2 hover:text-foreground"
          }`}
          title={t("回退此改动（恢复为编辑前内容）")}
          aria-pressed={!kept}
          onClick={() => onToggle(false)}
        >
          {t("回退")}
        </button>
      </span>
    </div>
  );
}

function buildRows(
  alignment: DiffAlignment,
  hunks: { rowStart: number; rowEnd: number }[] | null,
  keep: boolean[],
): { rows: DiffRow[]; windows: Array<[number, number]> } {
  const { oldLines, newLines, ops } = alignment;

  // File creation: no old content, show everything as additions.
  if (oldLines === null) {
    const lines = newLines ?? [];
    return {
      rows: lines.map((text, j) => ({ type: "add" as const, n: String(j + 1), text })),
      windows: [],
    };
  }
  // File deletion: no new content, show everything as removals.
  if (newLines === null) {
    return {
      rows: oldLines.map((text, i) => ({ type: "del" as const, n: String(i + 1), text })),
      windows: [],
    };
  }

  const rows: DiffRow[] = [];
  let prevHunk = -1;
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index]!;
    if (op.type === "same" || !hunks) {
      rows.push({
        type: op.type,
        n: op.type === "add" ? String(op.newNo + 1) : String(op.oldNo + 1),
        text: op.text,
      });
      continue;
    }
    const hunkIndex = findHunk(hunks, index);
    const head = hunkIndex >= 0 && hunkIndex !== prevHunk;
    if (hunkIndex >= 0) prevHunk = hunkIndex;
    rows.push({
      type: op.type,
      n: op.type === "add" ? String(op.newNo + 1) : String(op.oldNo + 1),
      text: op.text,
      hunk: hunkIndex >= 0 ? hunkIndex : undefined,
      hunkHead: head,
      reverted: hunkIndex >= 0 ? keep[hunkIndex] === false : false,
    });
  }
  return { rows, windows: computeWindows(rows) };
}

/** The hunk whose op range contains `index`, or -1 (unchanged rows). */
function findHunk(hunks: { rowStart: number; rowEnd: number }[], index: number): number {
  for (let h = 0; h < hunks.length; h++) {
    if (index >= hunks[h]!.rowStart && index < hunks[h]!.rowEnd) return h;
  }
  return -1;
}

/**
 * Fold unchanged stretches into collapsible gaps. Each change keeps
 * CONTEXT_LINES of surrounding context; gaps between changes (and the leading/
 * trailing tails) become clickable "⋯" hunks that expand on demand.
 */
function collapseAroundChanges(
  rows: DiffRow[],
  windows: Array<[number, number]>,
  expanded: Set<number>,
): DiffRow[] {
  if (windows.length === 0) return rows;

  const out: DiffRow[] = [];
  let prevEnd = -1;
  let gapIndex = 0;
  windows.forEach(([s, e]) => {
    const gapStart = prevEnd + 1;
    const gapEnd = s - 1;
    if (gapStart <= gapEnd) {
      if (expanded.has(gapIndex)) {
        for (let i = gapStart; i <= gapEnd; i++) out.push(rows[i]!);
      } else {
        out.push({ type: "hunk", n: "", text: "⋯", win: gapIndex });
      }
      gapIndex++;
    }
    for (let i = Math.max(prevEnd + 1, s); i <= e; i++) out.push(rows[i]!);
    prevEnd = e;
  });
  // Trailing tail after the last window.
  const trailStart = prevEnd + 1;
  const trailEnd = rows.length - 1;
  if (trailStart <= trailEnd) {
    if (expanded.has(gapIndex)) {
      for (let i = trailStart; i <= trailEnd; i++) out.push(rows[i]!);
    } else {
      out.push({ type: "hunk", n: "", text: "⋯", win: gapIndex });
    }
  }
  return out;
}

/** Group changed lines into windows of ±CONTEXT_LINES, merging windows that
 * touch (≤1 line apart) so a cluster of nearby edits folds into one hunk. */
function computeWindows(rows: DiffRow[]): Array<[number, number]> {
  const changed = rows
    .map((r, i) => (r.type === "add" || r.type === "del" ? i : -1))
    .filter((i) => i >= 0);
  if (changed.length === 0) return [];

  const windows: Array<[number, number]> = [];
  let start = Math.max(0, changed[0]! - CONTEXT_LINES);
  let end = Math.min(rows.length - 1, changed[0]! + CONTEXT_LINES);
  for (const idx of changed.slice(1)) {
    const s = Math.max(0, idx - CONTEXT_LINES);
    const e = Math.min(rows.length - 1, idx + CONTEXT_LINES);
    if (s <= end + 1) {
      end = e; // windows touch (≤1 line apart) — keep as one hunk
    } else {
      windows.push([start, end]);
      start = s;
      end = e;
    }
  }
  windows.push([start, end]);
  return windows;
}
