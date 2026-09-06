import { useMemo } from "react";
import type { ToolDiffUi } from "../../../shared/messages";

interface DiffRow {
  type: "add" | "del" | "same" | "hunk";
  text: string;
}

/**
 * Line-level diff renderer for structured tool diffs
 * (`{type:"diff", path, oldText, newText}` from `tool_call_update`).
 * LCS-based so edits show as paired -/+ lines like an editor gutter.
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
            <span className="diff-gutter">{row.type === "add" ? "+" : row.type === "del" ? "-" : " "}</span>
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

  return lcsRows(oldLines, newLines);
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
