import fs from "node:fs";
import path from "node:path";

const root = "webview/src";
const rules = [
  ["py-2.5", "py-3"],
  ["py-3.5", "py-4"],
  ["pt-1.5", "pt-2"],
  ["pt-2.5", "pt-3"],
  ["pb-3.5", "pb-4"],
  ["mb-1.5", "mb-2"],
  ["mb-2.5", "mb-3"],
  ["mt-1.5", "mt-2"],
  ["space-y-1.5", "space-y-2"],
  ["space-y-2.5", "space-y-3"],
  ["gap-2.5", "gap-3"],
  ["gap-y-0.5", "gap-y-1"],
  ["p-2.5", "p-3"],
  ["px-3.5", "px-4"],
  ["mx-2.5", "mx-3"],
  ["py-[1px]", "py-px"],
  ["py-[2px]", "py-0.5"],
  ["mt-[3px]", "mt-1"],
];

const counts = new Map(rules.map(([from]) => [from, 0]));
let changedFiles = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(file);
      continue;
    }
    if (!/\.(tsx|ts)$/.test(entry.name)) continue;
    const source = fs.readFileSync(file, "utf8");
    let next = source;
    for (const [from, to] of rules) {
      const pieces = next.split(from);
      if (pieces.length > 1) {
        counts.set(from, (counts.get(from) ?? 0) + pieces.length - 1);
        next = pieces.join(to);
      }
    }
    if (next !== source) {
      fs.writeFileSync(file, next, "utf8");
      changedFiles += 1;
    }
  }
}

walk(root);
for (const [from, to] of rules) {
  console.log(`${counts.get(from)} × ${from} -> ${to}`);
}
console.log(`changed ${changedFiles} files`);