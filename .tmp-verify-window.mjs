// TEMP diagnostic probe (deleted after use).
// Faithfully evaluates the CLI's built-in window table (uis/kln/Tqe) extracted
// from the vendored bundle and runs JR()'s matching logic for a model id.
import { readFileSync } from "node:fs";

const file = "j:/git/iflow-harness-super-worktrees/诊断压缩窗口问题-mws5bo54-h/vendor/iflow-fork/bundle/iflow.js";
const s = readFileSync(file, "utf8");

// --- extract the real table text from the bundle -------------------------
const anchor = s.indexOf("Tqe=128e3,uis=[");
if (anchor < 0) throw new Error("table anchor not found");
const arrStart = s.indexOf("uis=[", anchor) + "uis=".length;
// balanced-bracket scan for the array literal
let depth = 0;
let i = arrStart;
for (; i < s.length; i += 1) {
  const ch = s[i];
  if (ch === "[") depth += 1;
  else if (ch === "]") {
    depth -= 1;
    if (depth === 0) break;
  }
}
const arrText = s.slice(arrStart, i + 1);
const klnStart = s.indexOf("kln={", anchor);
let d2 = 0;
let j = klnStart + "kln=".length;
for (; j < s.length; j += 1) {
  const ch = s[j];
  if (ch === "{") d2 += 1;
  else if (ch === "}") {
    d2 -= 1;
    if (d2 === 0) break;
  }
}
const klnText = s.slice(klnStart + "kln=".length, j + 1);

const uis = eval(`(${arrText})`);
const kln = eval(`(${klnText})`);
const Tqe = 128e3; // bundle literal: Tqe=128e3

// JR() from the bundle (loader call replaced by "no settings limit"):
function JR(A, e) {
  if (e && e > 0) return e;              // caller-supplied limit (config.tokensLimit)
  // let t = require("./context-window-loader.cjs").readTokensLimit();  // settings.json top-level
  const t = 0;                          // <- settings.json tokensLimit currently ABSENT
  if (t > 0) return t;
  if (!A || typeof A !== "string") return Tqe;
  const r = A.toLowerCase();
  if (kln[A]) return kln[A];
  for (const n of uis) {
    if (n.pattern.test(r)) {
      for (const [s, a] of Object.entries(n.limits)) {
        if (s !== "default" && r.includes(s)) return a;
      }
      return n.limits.default ?? n.defaultLimit ?? Tqe;
    }
  }
  return Tqe;
}

const LIGHT = 0.6;   // lightCompressionTokenThreshold default
const FULL = 0.8;    // compressionTokenThreshold default

for (const id of ["auto/deepseek-v4.1-flash", "deepseek-v4.1-flash", "deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash"]) {
  const w = JR(id, undefined);
  console.log(
    `${id.padEnd(28)} window=${String(w).padEnd(8)} light@${Math.round(w * LIGHT)}  full@${Math.round(w * FULL)}`,
  );
}
console.log("\n-- with a user override forwarded via IFLOW_TOKENS_LIMIT --");
for (const n of [960000, 1000000]) {
  const w = JR("auto/deepseek-v4.1-flash", n);
  console.log(`tokensLimit=${n} -> window=${w} light@${Math.round(w * LIGHT)} full@${Math.round(w * FULL)}`);
}
console.log("\n-- occupancy of the user's screenshot numbers (window 65000) --");
for (const used of [62754, 69695]) {
  console.log(`used=${used} ratio=${(used / 65000).toFixed(3)} -> ${used / 65000 >= FULL ? "FULL compression" : used / 65000 >= LIGHT ? "lightweight" : "none"}`);
}
