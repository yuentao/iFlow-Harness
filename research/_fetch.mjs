#!/usr/bin/env node
// Research-only helper: fetch a URL and print plain text.
// Not part of the extension build; used solely for the multi-agent token research task.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

function htmlToText(html) {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  // keep some block structure
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "\n- ");
  s = s.replace(/<h([1-6])[^>]*>/gi, "\n\n### ");
  s = s.replace(/<[^>]+>/g, "");
  const ent = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
    "&nbsp;": " ", "&mdash;": "—", "&ndash;": "–", "&hellip;": "…",
    "&rsquo;": "'", "&lsquo;": "'", "&ldquo;": '"', "&rdquo;": '"',
    "&times;": "x", "&rarr;": "→", "&larr;": "←",
  };
  s = s.replace(/&[a-z#0-9]+;/gi, (m) => ent[m] ?? m);
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

const url = process.argv[2];
const out = process.argv[3];
if (!url) {
  console.error("usage: node _fetch.mjs <url> [outFile]");
  process.exit(2);
}

let text = "";
let status = "unknown";
try {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8" },
    signal: ctrl.signal,
    redirect: "follow",
  });
  clearTimeout(timer);
  status = `${res.status} ${res.url}`;
  const body = await res.text();
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json") || /^\s*[[{]/.test(body)) {
    text = body;
  } else {
    text = htmlToText(body);
  }
} catch (e) {
  status = `ERROR ${e?.message || e}`;
  text = "";
}

if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `/* STATUS: ${status} */\n\n${text}`, "utf8");
  console.log(`STATUS: ${status}\nWROTE: ${out}\nCHARS: ${text.length}`);
} else {
  console.log(`STATUS: ${status}\n\n${text}`);
}
