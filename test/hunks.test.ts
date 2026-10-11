import { describe, it, expect } from "vitest";
import { computeHunks, diffRows, replayHunks, HUNK_MAX } from "../shared/hunks.js";
import type { DiffHunkUi } from "../shared/messages.js";

/** Independent oracle: walk the ops alignment; for changed rows emit the
 * new-side line when the row's hunk is kept, the old-side line otherwise.
 * Derived purely from `diffRows` + hunk containment, NOT from the hunks'
 * old/new line arithmetic — so it can catch a range bug in computeHunks. */
function expectedReplay(
  oldText: string,
  newText: string,
  hunks: readonly DiffHunkUi[],
  keep: readonly boolean[],
): string {
  const ops = diffRows(oldText.split("\n"), newText.split("\n"));
  const out: string[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.type === "same") {
      out.push(op.text);
      continue;
    }
    const h = hunks.findIndex((hk) => i >= hk.rowStart && i < hk.rowEnd);
    const kept = h < 0 ? true : keep[h] !== false;
    if (kept) {
      if (op.type === "add") out.push(op.text);
    } else if (op.type === "del") {
      out.push(op.text);
    }
  }
  return out.join("\n");
}

describe("per-hunk keep/revert (M4 P0-2)", () => {
  it("no change yields an empty hunk list", () => {
    expect(computeHunks("a\nb\nc", "a\nb\nc")).toEqual([]);
  });

  it("a single-line replacement is one hunk covering the replaced line", () => {
    const oldText = "a\nb\nc";
    const newText = "a\nB\nc";
    const hunks = computeHunks(oldText, newText)!;
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
    expect(replayHunks(oldText, newText, hunks, [true])).toBe(newText);
    expect(replayHunks(oldText, newText, hunks, [false])).toBe(oldText);
  });

  it("two distant changes become two independently-decidable hunks", () => {
    const oldLines = Array.from({ length: 20 }, (_, i) => `line${i}`);
    const newLines = [...oldLines];
    newLines[2] = "LINE2";
    newLines[17] = "LINE17";
    const oldText = oldLines.join("\n");
    const newText = newLines.join("\n");
    const hunks = computeHunks(oldText, newText)!;
    expect(hunks).toHaveLength(2);
    // Keep the second change, revert the first.
    const out = replayHunks(oldText, newText, hunks, [false, true]);
    expect(out).toBe(expectedReplay(oldText, newText, hunks, [false, true]));
    expect(out).toContain("line2");
    expect(out).toContain("LINE17");
    expect(out).not.toContain("LINE2\n");
  });

  it("nearby changes (≤3 unchanged lines apart) merge into one hunk", () => {
    const oldLines = Array.from({ length: 12 }, (_, i) => `l${i}`);
    const newLines = [...oldLines];
    newLines[3] = "A";
    newLines[6] = "B"; // gap of 2 unchanged lines (4,5) → same hunk
    const hunks = computeHunks(oldLines.join("\n"), newLines.join("\n"))!;
    expect(hunks).toHaveLength(1);
  });

  it("pure insertion (add-only hunk) replays correctly", () => {
    const oldText = "a\nb";
    const newText = "a\nX\nY\nb";
    const hunks = computeHunks(oldText, newText)!;
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.oldLines).toBe(0);
    expect(hunks[0]!.newLines).toBe(2);
    expect(replayHunks(oldText, newText, hunks, [true])).toBe(newText);
    expect(replayHunks(oldText, newText, hunks, [false])).toBe(oldText);
  });

  it("pure deletion (del-only hunk) replays correctly", () => {
    const oldText = "a\nX\nY\nb";
    const newText = "a\nb";
    const hunks = computeHunks(oldText, newText)!;
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.newLines).toBe(0);
    expect(replayHunks(oldText, newText, hunks, [true])).toBe(newText);
    expect(replayHunks(oldText, newText, hunks, [false])).toBe(oldText);
  });

  it("a mixed mix of insert/delete/replace hunks: any keep set matches the contract", () => {
    const oldLines = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const newLines: string[] = [];
    for (let i = 0; i < oldLines.length; i++) {
      if (i === 2) {
        newLines.push("R2"); // replace
        continue;
      }
      if (i === 8) continue; // delete
      if (i === 14) newLines.push("I14a", "I14b"); // insert two lines
      newLines.push(oldLines[i]!);
    }
    const oldText = oldLines.join("\n");
    const newText = newLines.join("\n");
    const hunks = computeHunks(oldText, newText)!;
    expect(hunks.length).toBeGreaterThanOrEqual(2);
    const n = hunks.length;
    for (let mask = 0; mask < 1 << n; mask++) {
      const keep = Array.from({ length: n }, (_, i) => (mask & (1 << i)) !== 0);
      expect(replayHunks(oldText, newText, hunks, keep)).toBe(
        expectedReplay(oldText, newText, hunks, keep),
      );
    }
  });

  it("keeps CJK, CRLF and no-trailing-newline content intact", () => {
    const oldText = "第一行\n第二行\r\n第三行";
    const newText = "第一行\n第二行改了\r\n第三行";
    const hunks = computeHunks(oldText, newText)!;
    const kept = replayHunks(oldText, newText, hunks, [true]);
    expect(kept).toBe(newText);
    expect(replayHunks(oldText, newText, hunks, [false])).toBe(oldText);
  });

  it("no-trailing-newline vs trailing-newline difference is a hunk", () => {
    const oldText = "a\nb";
    const newText = "a\nb\n";
    const hunks = computeHunks(oldText, newText)!;
    expect(hunks.length).toBeGreaterThanOrEqual(1);
    expect(replayHunks(oldText, newText, hunks, hunks.map(() => true))).toBe(newText);
    expect(replayHunks(oldText, newText, hunks, hunks.map(() => false))).toBe(oldText);
  });

  it("identical texts produce no hunks (nothing to decide)", () => {
    expect(computeHunks("x\ny\nz", "x\ny\nz")).toEqual([]);
  });

  it("degrades to null beyond HUNK_MAX hunks", () => {
    // 220 changes each followed by 4 unchanged lines → 220 separate hunks
    // (gap 4 > HUNK_MERGE_GAP) with 1100 lines, so diffRows' n*m guard
    // (4M) is NOT hit — this exercises the real hunk-count cap.
    const N = 220;
    const oldLines = Array.from({ length: N * 5 }, (_, i) => `l${i}`);
    const newLines = [...oldLines];
    for (let i = 0; i < N; i++) newLines[i * 5] = `L${i}`;
    const result = computeHunks(oldLines.join("\n"), newLines.join("\n"));
    expect(result).toBeNull();
    expect(HUNK_MAX).toBe(200);
  });

  it("diffRows aligns deletions and additions like the renderer expects", () => {
    const ops = diffRows(["a", "b", "c"], ["a", "B", "c"]);
    expect(ops.map((o) => o.type)).toEqual(["same", "del", "add", "same"]);
    expect(ops[1]).toMatchObject({ type: "del", oldNo: 1, newNo: -1, text: "b" });
    expect(ops[2]).toMatchObject({ type: "add", oldNo: -1, newNo: 1, text: "B" });
  });
});
