// TEMP diagnostic probe (deleted after use). Dumps context around given offsets.
import { readFileSync } from "node:fs";

const file = "j:/git/iflow-harness-super-worktrees/诊断压缩窗口问题-mws5bo54-h/vendor/iflow-fork/bundle/iflow.js";
const s = readFileSync(file, "utf8");
const before = Number(process.env.BEFORE ?? "500");
const after = Number(process.env.AFTER ?? "700");
for (const raw of process.argv.slice(2)) {
  const off = Number(raw);
  const start = Math.max(0, off - before);
  const end = Math.min(s.length, off + after);
  console.log(`\n----- offset ${off} [${start}..${end}] -----`);
  console.log(s.slice(start, end));
}

