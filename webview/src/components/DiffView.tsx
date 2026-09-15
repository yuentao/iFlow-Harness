import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";
import { Ellipsis, FileCode2 } from "lucide-react";
import type { ToolDiffUi } from "../../../shared/messages";
import { t } from "../i18n";
import { FileRef } from "./ui";

interface DiffRow {
  type: "add" | "del" | "same" | "hunk";
  /** Display line number (old numbering for del/same, new for add). */
  n: string;
  text: string;
  /** Gap index for hunk separators, so clicking expands the right region. */
  win?: number;
}

/** Context lines kept around each change, like git's unified diff. */
const CONTEXT_LINES = 3;

/**
 * Line-level diff renderer for structured tool diffs
 * (`{type:"diff", path, oldText, newText}` from `tool_call_update`).
 * LCS-based so edits show as paired -/+ lines like an editor gutter, then
 * folded git-style: each change keeps CONTEXT_LINES of context, the rest of
 * an unchanged file collapses into clickable "⋯" hunks that expand on demand.
 */
export function DiffView({ diff, actions }: { diff: ToolDiffUi; actions?: ReactNode }) {
  const { rows: fullRows, windows } = useMemo(() => buildRows(diff), [diff]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // A new diff invalidates previous expand/collapse choices.
  useEffect(() => setExpanded(new Set()), [diff]);

  const rows = useMemo(
    () => collapseAroundChanges(fullRows, windows, expanded),
    [fullRows, windows, expanded],
  );
  const addCount = rows.filter((r) => r.type === "add").length;
  const delCount = rows.filter((r) => r.type === "del").length;

  const toggleGap = (win: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(win)) next.delete(win);
      else next.add(win);
      return next;
    });
  };

  return (
    <div className="overflow-hidden bg-card">
      <div className="flex items-center gap-2 px-3 py-2">
        <FileCode2 className="size-3.5 shrink-0 text-primary" />
        <FileRef path={diff.path} />
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[10px]">
          {addCount > 0 && <span className="text-diff-add-fg">+{addCount}</span>}
          {delCount > 0 && <span className="text-diff-del-fg">−{delCount}</span>}
        </span>
      </div>
      <div className="diff-scroll mx-2.5 mb-2.5 max-h-60 overflow-auto rounded-lg border border-border/60 bg-editor font-mono text-[11px] leading-[1.7]">
        {rows.map((row, i) =>
          row.type === "hunk" ? (
            <button
              key={i}
              type="button"
              className="flex w-full items-center gap-1.5 px-3 py-0.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
              title={expanded.has(row.win ?? -1) ? t("收起") : t("展开上下文")}
              onClick={() => toggleGap(row.win ?? -1)}
            >
              <Ellipsis className="size-3 shrink-0" />
              <span className="truncate">
                {expanded.has(row.win ?? -1) ? t("收起") : t("展开上下文")}
              </span>
            </button>
          ) : (
            <div
              key={i}
              className={`flex px-3 ${
                row.type === "add" ? "bg-diff-add" : row.type === "del" ? "bg-diff-del" : ""
              }`}
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
              <span className="ml-3 whitespace-pre text-foreground/90">
                {row.text === "" ? " " : row.text === "⋯" ? "" : row.text}
              </span>
            </div>
          ),
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 px-3 py-2">{actions}</div>}
    </div>
  );
}

function buildRows(diff: ToolDiffUi): { rows: DiffRow[]; windows: Array<[number, number]> } {
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

  const rows = lcsRows(oldLines, newLines);
  return { rows, windows: computeWindows(rows) };
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

/** Classic LCS table over lines; fine for the line counts typical of tool diffs. */
function lcsRows(oldLines: string[], newLines: string[]): DiffRow[] {
  const n = oldLines.length;
  const m = newLines.length;
  // Guard against pathological inputs (whole-file rewrites of huge files).
  if (n * m > 4_000_000) {
    return [
      ...oldLines.map((text, i) => ({ type: "del" as const, n: String(i + 1), text })),
      ...newLines.map((text, j) => ({ type: "add" as const, n: String(j + 1), text })),
    ];
  }

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = oldLines[i] === newLines[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      rows.push({ type: "same", n: String(oldNo), text: oldLines[i]! });
      i++;
      j++;
      oldNo++;
      newNo++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push({ type: "del", n: String(oldNo), text: oldLines[i]! });
      i++;
      oldNo++;
    } else {
      rows.push({ type: "add", n: String(newNo), text: newLines[j]! });
      j++;
      newNo++;
    }
  }
  while (i < n) rows.push({ type: "del", n: String(oldNo++), text: oldLines[i++]! });
  while (j < m) rows.push({ type: "add", n: String(newNo++), text: newLines[j++]! });
  return rows;
}