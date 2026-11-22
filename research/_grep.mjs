#!/usr/bin/env node
// Research-only helper: grep plain-text captures with long-line trimming.
import { readFileSync } from "node:fs";

const file = process.argv[2];
const re = new RegExp(process.argv[3], "i");
const ctx = Number(process.argv[4] ?? 1);
const maxLen = Number(process.argv[5] ?? 400);

const lines = readFileSync(file, "utf8").split(/\r?\n/);
const hits = [];
for (let i = 0; i < lines.length; i++) {
  if (re.test(lines[i])) hits.push(i);
}
const shown = new Set();
for (const i of hits) {
  for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) {
    if (shown.has(j)) continue;
    shown.add(j);
    const s = lines[j].trim();
    if (s.length > maxLen) {
      // skip the giant Mintlify JSON payload line
      if (s.length > 2000) continue;
      console.log(`${j + 1}: ${s.slice(0, maxLen)} …`);
    } else {
      console.log(`${j + 1}: ${s}`);
    }
  }
  console.log("---");
}
console.log(`TOTAL HITS: ${hits.length}`);
