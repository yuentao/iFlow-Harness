import { useMemo } from "react";
import type { ToolDiffUi } from "../../../shared/messages";

interface DiffRow {
  type: "add" | "del" | "same" | "hunk";
  text: string;
}

/** Context lines kept around each change, like git's unified diff. */
const CONTEXT_LINES = 3;

/**
 * Line-level diff renderer for structured tool diffs
 * (`{type:"diff", path, oldText, newText}` from `tool_call_update`).
 * LCS-based so edits show as paired -/+ lines like an editor gutter, then
 * folded git-style: each change keeps CONTEXT_LINES of context, the rest of
 * an unchanged file collapses into "⋯" hunks.
 */
export function DiffView({ diff }: { diff: ToolDiffUi }) {
  const rows = useMemo(() => buildRows(diff), [diff]);

  return (
    <div className="diff-view">
      <div className="diff-head">
        <span className="diff-path" title={diff.path}>
          {diff.path}
        </span>
        <span className="diff-stats">
          {rows.filter((r) => r.type === "add").length > 0 && (
            <span className="diff-add-count">+{rows.filter((r) => r.type === "add").length}</span>
          )}
          {rows.filter((r) => r.type === "del").length > 0 && (
            <span className="diff-del-count">-{rows.filter((r) => r.type === "del").length}</span>
          )}
        </span>
      </div>
      <div className="diff-body">
        {rows.map((row, i) => (
          <div key={i} className={`diff-row ${row.type}`}>
            <span className="diff-gutter">
              {row.type === "add" ? "+" : row.type === "del" ? "-" : row.type === "hunk" ? "" : " "}
            </span>
            <span className="diff-text">{row.text === "" ? " " : row.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function buildRows(diff: ToolDiffUi): DiffRow[] {
  const oldLines = diff.oldText === null ? [] : diff.oldText.split("\n");
  const newLines = diff.newText === null ? [] : diff.newText.split("\n");

  // File creation: no old content, show everything as additions.
  if (diff.oldText === null) return newLines.map((text) => ({ type: "add" as const, text }));
  // File deletion: no new content, show everything as removals.
  if (diff.newText === null) return oldLines.map((text) => ({ type: "del" as const, text }));

  return collapseAroundChanges(lcsRows(oldLines, newLines));
}

/**
 * Fold unchanged stretches: each add/del keeps CONTEXT_LINES of surrounding
 * context; gaps larger than that collapse into a single "⋯" hunk separator.
 */
function collapseAroundChanges(rows: DiffRow[]): DiffRow[] {
  const changed = rows
    .map((r, i) => (r.type === "add" || r.type === "del" ? i : -1))
    .filter((i) => i >= 0);
  if (changed.length === 0) return rows;

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

  const out: DiffRow[] = [];
  let prevEnd = -1;
  for (const [s, e] of windows) {
    if (s > prevEnd + 1) out.push({ type: "hunk", text: "⋯" });
    for (let i = Math.max(prevEnd + 1, s); i <= e; i++) out.push(rows[i]!);
    prevEnd = e;
  }
  // Trailing unchanged stretch after the last window: mark as folded too,
  // so the reader can tell the diff was truncated (not that the file ends).
  if (prevEnd < rows.length - 1) out.push({ type: "hunk", text: "⋯" });
  return out;
}

/** Classic LCS table over lines; fine for the line counts typical of tool diffs. */
function lcsRows(oldLines: string[], newLines: string[]): DiffRow[] {
  const n = oldLines.length;
  const m = newLines.length;
  // Guard against pathological inputs (whole-file rewrites of huge files).
  if (n * m > 4_000_000) {
    return [
      ...oldLines.map((text) => ({ type: "del" as const, text })),
      ...newLines.map((text) => ({ type: "add" as const, text })),
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
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      rows.push({ type: "same", text: oldLines[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push({ type: "del", text: oldLines[i]! });
      i++;
    } else {
      rows.push({ type: "add", text: newLines[j]! });
      j++;
    }
  }
  while (i < n) rows.push({ type: "del", text: oldLines[i++]! });
  while (j < m) rows.push({ type: "add", text: newLines[j++]! });
  return rows;
}
