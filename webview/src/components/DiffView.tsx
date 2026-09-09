import { useMemo, type ReactNode } from "react";
import { Ellipsis, FileCode2 } from "lucide-react";
import type { ToolDiffUi } from "../../../shared/messages";
import { t } from "../i18n";
import { FileRef } from "./ui";

interface DiffRow {
  type: "add" | "del" | "same" | "hunk";
  /** Display line number (old numbering for del/same, new for add). */
  n: string;
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
export function DiffView({ diff, actions }: { diff: ToolDiffUi; actions?: ReactNode }) {
  const rows = useMemo(() => buildRows(diff), [diff]);
  const addCount = rows.filter((r) => r.type === "add").length;
  const delCount = rows.filter((r) => r.type === "del").length;

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
      <div className="diff-scroll max-h-60 overflow-auto border-y border-border/60 bg-editor font-mono text-[11px] leading-[1.7]">
        {rows.map((row, i) => (
          <div
            key={i}
            className={`flex gap-3 px-3 ${
              row.type === "add" ? "bg-diff-add" : row.type === "del" ? "bg-diff-del" : ""
            }`}
          >
            <span className="w-7 shrink-0 select-none text-right text-syn-com">{row.n}</span>
            <span
              className={`w-2 shrink-0 select-none ${
                row.type === "add"
                  ? "text-diff-add-fg"
                  : row.type === "del"
                    ? "text-diff-del-fg"
                    : "text-syn-com"
              }`}
            >
              {row.type === "add" ? "+" : row.type === "del" ? "−" : row.type === "hunk" ? <Ellipsis className="inline size-3 align-[-2px]" /> : " "}
            </span>
            <span className="whitespace-pre text-foreground/90">{row.text === "" ? " " : row.text === "⋯" ? "" : row.text}</span>
          </div>
        ))}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 px-3 py-2">{actions}</div>}
    </div>
  );
}

function buildRows(diff: ToolDiffUi): DiffRow[] {
  const oldLines = diff.oldText === null ? [] : diff.oldText.split("\n");
  const newLines = diff.newText === null ? [] : diff.newText.split("\n");

  // File creation: no old content, show everything as additions.
  if (diff.oldText === null) {
    return newLines.map((text, j) => ({ type: "add" as const, n: String(j + 1), text }));
  }
  // File deletion: no new content, show everything as removals.
  if (diff.newText === null) {
    return oldLines.map((text, i) => ({ type: "del" as const, n: String(i + 1), text }));
  }

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
    if (s > prevEnd + 1) out.push({ type: "hunk", n: "", text: "⋯" });
    for (let i = Math.max(prevEnd + 1, s); i <= e; i++) out.push(rows[i]!);
    prevEnd = e;
  }
  // Trailing unchanged stretch after the last window: mark as folded too,
  // so the reader can tell the diff was truncated (not that the file ends).
  if (prevEnd < rows.length - 1) out.push({ type: "hunk", n: "", text: "⋯" });
  return out;
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