/**
 * M4 P0-2 — per-hunk keep/revert of a structured tool diff (pure, unit-testable).
 *
 * Correctness core (roadmap §1 P0-2): we hold the FULL `oldText`/`newText` of
 * a `ToolDiffUi`, so hunk-ification and replay are 100% deterministic — the
 * target text is computed by walking from `oldText` and replaying only the
 * kept hunks. There is NO fuzzy patching against the current disk content
 * (the host refuses the whole operation when disk ≠ newText), keeping the
 * "never ship a fabricated diff into a revert path" discipline (pitfall #6).
 *
 * The SAME module runs in the webview (hunk headers + preview) and in the
 * Extension Host (replay → write), so what the user approves is byte-identical
 * to what gets written. `DiffView` renders its rows from `diffRows` here —
 * a second LCS implementation could tie-break differently and desync the hunk
 * headers from the rendered lines.
 */

import type { DiffHunkUi } from "./messages.js";

/** Adjacent change runs separated by at most this many unchanged lines merge
 * into one hunk (git-style clustering). */
const HUNK_MERGE_GAP = 3;

/** Above this hunk count per-hunk decisions stop being usable — the caller
 * degrades to whole-file revert (roadmap: >200 hunks → overall ops only). */
export const HUNK_MAX = 200;

/** One line of the LCS alignment between old and new content. */
export interface DiffOp {
  type: "same" | "del" | "add";
  /** 0-based line index in the old content (-1 for pure additions). */
  oldNo: number;
  /** 0-based line index in the new content (-1 for pure deletions). */
  newNo: number;
  text: string;
}

/**
 * Line-level LCS alignment — the algorithm DiffView used before P0-2, moved
 * here so UI and replay share one source of truth. The quadratic guard
 * degrades to "delete all + add all" for pathological whole-file rewrites —
 * that still replays correctly (one giant hunk), just without minimal diffs.
 */
export function diffRows(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 4_000_000) {
    return [
      ...oldLines.map((text, i) => ({ type: "del" as const, oldNo: i, newNo: -1, text })),
      ...newLines.map((text, j) => ({ type: "add" as const, oldNo: -1, newNo: j, text })),
    ];
  }

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = oldLines[i] === newLines[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: "same", oldNo: i, newNo: j, text: oldLines[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ type: "del", oldNo: i, newNo: -1, text: oldLines[i]! });
      i++;
    } else {
      ops.push({ type: "add", oldNo: -1, newNo: j, text: newLines[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", oldNo: i, newNo: -1, text: oldLines[i++]! });
  while (j < m) ops.push({ type: "add", oldNo: -1, newNo: j, text: newLines[j++]! });
  return ops;
}

/**
 * Split a whole-file old→new change into hunks of contiguous changed lines
 * (runs merged when ≤ HUNK_MERGE_GAP unchanged lines apart). `rowStart`/
 * `rowEnd` index the `diffRows` sequence so the renderer attaches its
 * keep/revert header to the right rows; the old/new ranges drive replay.
 *
 * Returns [] when old and new are identical (nothing to decide) and null
 * when the change cannot be hunked usefully (> HUNK_MAX hunks — the caller
 * degrades to whole-file operations). Creation/deletion diffs (null side)
 * have no per-hunk semantics and must not reach this function.
 */
export function computeHunks(oldText: string, newText: string): DiffHunkUi[] | null {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const ops = diffRows(oldLines, newLines);

  // Contiguous runs of changed rows: [start, end) in the ops sequence.
  const runs: Array<[number, number]> = [];
  let runStart = -1;
  for (let i = 0; i < ops.length; i++) {
    const changed = ops[i]!.type !== "same";
    if (changed && runStart < 0) runStart = i;
    if (!changed && runStart >= 0) {
      runs.push([runStart, i]);
      runStart = -1;
    }
  }
  if (runStart >= 0) runs.push([runStart, ops.length]);
  if (runs.length === 0) return [];

  // Merge runs whose unchanged gap is small, so a cluster of nearby edits
  // becomes one decision unit.
  const groups: Array<[number, number]> = [runs[0]!];
  for (let r = 1; r < runs.length; r++) {
    const prev = groups[groups.length - 1]!;
    const cur = runs[r]!;
    if (cur[0] - prev[1] <= HUNK_MERGE_GAP) prev[1] = cur[1];
    else groups.push(cur);
  }
  if (groups.length > HUNK_MAX) return null;

  const hunks: DiffHunkUi[] = [];
  // Old/new lines consumed before ops index i — the insertion anchor for
  // pure-add (no old lines) / pure-del (no new lines) groups.
  const oldBefore = (index: number): number => {
    let count = 0;
    for (let i = 0; i < index; i++) if (ops[i]!.type !== "add") count++;
    return count;
  };
  const newBefore = (index: number): number => {
    let count = 0;
    for (let i = 0; i < index; i++) if (ops[i]!.type !== "del") count++;
    return count;
  };
  for (const [rowStart, rowEnd] of groups) {
    // Ranges are the CONTIGUOUS replacement span from the first to the last
    // old/new-touching op. Merged groups can contain `same` rows inside (the
    // merge gap); including them is lossless because those lines are identical
    // on both sides — and it keeps replay a pure line-range replacement.
    let oldStart = -1;
    let oldEnd = -1;
    let newStart = -1;
    let newEnd = -1;
    for (let i = rowStart; i < rowEnd; i++) {
      const op = ops[i]!;
      if (op.type !== "add") {
        if (oldStart < 0) oldStart = op.oldNo;
        oldEnd = op.oldNo;
      }
      if (op.type !== "del") {
        if (newStart < 0) newStart = op.newNo;
        newEnd = op.newNo;
      }
    }
    if (oldStart < 0) {
      // Pure insertion: the hunk replaces zero old lines; anchor start = end
      // so `oldEnd - oldStart` is 0 instead of a bogus negative.
      oldStart = oldBefore(rowStart);
      oldEnd = oldStart;
    } else {
      oldEnd += 1;
    }
    if (newStart < 0) {
      // Pure deletion: the hunk inserts zero new lines.
      newStart = newBefore(rowStart);
      newEnd = newStart;
    } else {
      newEnd += 1;
    }
    hunks.push({ rowStart, rowEnd, oldStart, oldLines: oldEnd - oldStart, newStart, newLines: newEnd - newStart });
  }
  return hunks;
}

/**
 * Replay only the kept hunks: start from `oldText`, apply each kept hunk's
 * replacement (oldStart/oldLines → newStart/newLines, ranges into the
 * split("\n") line arrays) in ascending order. Reverting a hunk = not
 * applying it (its old lines stay). Deterministic: for keep = all true the
 * result equals `newText`; for all false it equals `oldText`.
 *
 * Hunk ranges must come from `computeHunks(oldText, newText)` — replay does
 * not re-verify content (the host checks disk === newText up front instead).
 */
export function replayHunks(oldText: string, newText: string, hunks: readonly DiffHunkUi[], keep: readonly boolean[]): string {
  if (keep.every((k) => k)) return newText;
  if (keep.every((k) => !k)) return oldText;
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const out: string[] = [];
  let cursor = 0; // next old line to copy
  for (let h = 0; h < hunks.length; h++) {
    const hunk = hunks[h]!;
    if (hunk.oldStart < cursor) continue; // overlapping (shouldn't happen) — skip
    for (let i = cursor; i < hunk.oldStart; i++) out.push(oldLines[i]!);
    if (keep[h]) {
      for (let j = hunk.newStart; j < hunk.newStart + hunk.newLines; j++) out.push(newLines[j]!);
    } else {
      for (let i = hunk.oldStart; i < hunk.oldStart + hunk.oldLines; i++) out.push(oldLines[i]!);
    }
    cursor = hunk.oldStart + hunk.oldLines;
  }
  for (let i = cursor; i < oldLines.length; i++) out.push(oldLines[i]!);
  return out.join("\n");
}
