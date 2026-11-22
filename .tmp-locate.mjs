// TEMP diagnostic probe (deleted after use). Maps search strings -> line/col offsets.
import { readFileSync } from "node:fs";

const file = "j:/git/iflow-harness-super-worktrees/诊断压缩窗口问题-mws5bo54-h/vendor/iflow-fork/bundle/iflow.js";
const s = readFileSync(file, "utf8");

// Precompute line start offsets (bundle has ~7.4k lines).
const lineStarts = [0];
for (let i = 0; i < s.length; i += 1) if (s[i] === "\n") lineStarts.push(i + 1);

function lineCol(off) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1;
  }
  return { line: lo + 1, col: off - lineStarts[lo] + 1 };
}

const patterns = process.argv.slice(2);
for (const p of patterns) {
  let idx = -1;
  let n = 0;
  while ((idx = s.indexOf(p, idx + 1)) !== -1 && n < 6) {
    const { line, col } = lineCol(idx);
    console.log(`"${p}" @ char ${idx} -> line ${line}, col ${col}`);
    n += 1;
  }
  if (n === 0) console.log(`"${p}" -> NOT FOUND`);
}
