// TEMP diagnostic probe (deleted after use). Prints keyword offsets in the bundle.
import { readFileSync } from "node:fs";

const file = "j:/git/iflow-harness-super-worktrees/诊断压缩窗口问题-mws5bo54-h/vendor/iflow-fork/bundle/iflow.js";
const s = readFileSync(file, "utf8");
const keys = process.argv.slice(2);
for (const k of keys) {
  const offs = [];
  let i = s.indexOf(k);
  while (i !== -1 && offs.length < 60) {
    offs.push(i);
    i = s.indexOf(k, i + 1);
  }
  console.log(`=== ${k} : ${offs.length} hits (showing up to ${offs.length})`);
  console.log(offs.join(", "));
}
