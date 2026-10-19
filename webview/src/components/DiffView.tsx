import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Ellipsis, FileCode2, Undo2 } from "lucide-react";
import type { ToolDiffUi } from "../../../shared/messages";
import { computeHunks, diffRows } from "../../../shared/hunks";
import { t } from "../i18n";
import { FileRef } from "./ui";

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
}: {
  diff: ToolDiffUi;
  actions?: ReactNode;
  toolCallId?: string;
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
  const hunks = useMemo(
    () => (editable ? computeHunks(diff.oldText!, diff.newText!) : null),
    [editable, diff.oldText, diff.newText],
  );
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
    () => buildRows(diff, hunks, keep),
    [diff, hunks, keep],
  );
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  /** DOM row cap; grows as the user scrolls the diff body (see render). */
  const [renderCap, setRenderCap] = useState(INITIAL_RENDER_ROWS);
  // A new diff invalidates previous expand/collapse and row-cap choices.
  useEffect(() => {
    setExpanded(new Set());
    setRenderCap(INITIAL_RENDER_ROWS);
  }, [diff]);

  const rows = useMemo(
    () => collapseAroundChanges(fullRows, windows, expanded),
    [fullRows, windows, expanded],
  );
  const addCount = rows.filter((r) => r.type === "add").length;
  const delCount = rows.filter((r) => r.type === "del").length;
  // Bounded DOM prefix (see INITIAL_RENDER_ROWS): the full row list stays in
  // the memo for folding/hunk math, only the rendered slice is capped.
  const visibleRows = rows.slice(0, renderCap);
  const hiddenRows = rows.length - visibleRows.length;

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

  return (
    <div className="overflow-hidden bg-card">
      <div className="flex items-center gap-2 px-3 py-2">
        <FileCode2 className="size-3.5 shrink-0 text-primary" />
        <FileRef path={diff.path} toolCallId={toolCallId} />
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-ui-caption">
          {addCount > 0 && <span className="text-diff-add-fg">+{addCount}</span>}
          {delCount > 0 && <span className="text-diff-del-fg">−{delCount}</span>}
        </span>
      </div>
      <div
        className={`diff-scroll mx-3 mb-3 overflow-auto rounded-lg border border-border/60 bg-editor font-mono text-ui-caption leading-[1.7] ${maxHeightClass}`}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
            setRenderCap((c) => (c < rows.length ? c + RENDER_ROWS_STEP : c));
          }
        }}
      >
        {visibleRows.map((row, i) =>
          row.type === "hunk" ? (
            <button
              key={i}
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
            <div key={i}>
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
          ),
        )}
        {hiddenRows > 0 && (
          <button
            type="button"
            className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-ui-caption text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
            onClick={() => setRenderCap((c) => c + RENDER_ROWS_STEP)}
          >
            <Ellipsis className="size-3 shrink-0" />
            <span className="truncate">{t("加载剩余 {0} 行", hiddenRows)}</span>
          </button>
        )}
      </div>
      {editable && hunkCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-3 py-2">
          <button
            className="card-lift press inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/80 px-2.5 py-1 text-ui-caption font-medium text-foreground shadow-card transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!dirty || hunkActions?.busy}
            title={t("将回退的块恢复为编辑前内容，保留其余改动")}
            onClick={() => hunkActions?.onApply([...keep])}
          >
            <Check className="size-3" /> {t("应用（保留 {0} · 回退 {1}）", keepCount, revertCount)}
          </button>
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
      {actions && <div className="flex flex-wrap items-center gap-2 px-3 py-2">{actions}</div>}
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
      <span className="font-medium">{t("改动 {0}/{1}", index + 1, total)}</span>
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
  diff: ToolDiffUi,
  hunks: { rowStart: number; rowEnd: number }[] | null,
  keep: boolean[],
): { rows: DiffRow[]; windows: Array<[number, number]> } {
  const oldLines = diff.oldText === null ? [] : diff.oldText.split("\n");
  const newLines = diff.newText === null ? [] : diff.newText.split("\n");

  // File creation: no old content, show everything as additions.
  if (diff.oldText === null) {
    return {
      rows: newLines.map((text, j) => ({ type: "add" as const, n: String(j + 1), text })),
      windows: [],
    };
  }
  // File deletion: no new content, show everything as removals.
  if (diff.newText === null) {
    return {
      rows: oldLines.map((text, i) => ({ type: "del" as const, n: String(i + 1), text })),
      windows: [],
    };
  }

  const ops = diffRows(oldLines, newLines);
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
