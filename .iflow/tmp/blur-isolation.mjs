// Isolate the backdrop blur from the acrylic tint: measure the SAME region
// with (A) acrylic as shipped, (B) tint kept but backdrop-filter removed,
// (C) fully transparent. Board children are hidden so only the backdrop shows.
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const OUT = path.join(ROOT, ".iflow", "screens");
const REPORT = path.join(ROOT, ".iflow", "tmp", "blur-isolation.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { atoms: {} };

const list = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(JSON.stringify(m.error)));
    else p.resolve(m.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 900));
  return r.result.value;
};
await send("Page.enable");
await send("Runtime.enable");
const DSF = 2;
const setViewport = (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: DSF, mobile: false });
const setTheme = (t) => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: t }] });

async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  if (name) fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.data, "base64"));
  return r.data;
}

await send("Page.navigate", { url: "http://127.0.0.1:8797/" });
await sleep(2200);
await ev(`(() => {
  window.__analyze = async (b64, region) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
    const s = img.width / innerWidth;
    const x0 = Math.max(0, Math.round(region.x * s)), y0 = Math.max(0, Math.round(region.y * s));
    const w = Math.max(1, Math.min(img.width - x0, Math.round(region.w * s)));
    const h = Math.max(1, Math.min(img.height - y0, Math.round(region.h * s)));
    const d = ctx.getImageData(x0, y0, w, h).data;
    const n = w * h; const lum = new Float64Array(n);
    let sum = 0, sum2 = 0, mn = 255, mx = 0;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      lum[j] = l; sum += l; sum2 += l * l; if (l < mn) mn = l; if (l > mx) mx = l;
    }
    let g = 0, gn = 0;
    for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) { g += Math.abs(lum[y * w + x] - lum[y * w + x - 1]); gn++; }
    const mean = sum / n;
    return { w, h, mean: +mean.toFixed(2), sd: +Math.sqrt(Math.max(0, sum2 / n - mean * mean)).toFixed(2), min: +mn.toFixed(1), max: +mx.toFixed(1), contrast: +(mx - mn).toFixed(1), edge: +(g / Math.max(1, gn)).toFixed(3) };
  };
  window.__hideKids = (hide) => { const b = document.querySelector('.super-board-surface'); if (!b) return null; for (const k of b.children) k.style.visibility = hide ? 'hidden' : ''; return b.children.length; };
  window.__setSurf = (mode) => {
    const b = document.querySelector('.super-board-surface');
    if (!b) return null;
    if (!b.dataset.stash) b.dataset.stash = JSON.stringify({ bc: b.style.backgroundColor, bi: b.style.backgroundImage, bf: b.style.backdropFilter });
    if (mode === 'normal') { const s = JSON.parse(b.dataset.stash); b.style.backgroundColor = s.bc; b.style.backgroundImage = s.bi; b.style.backdropFilter = s.bf; }
    else if (mode === 'noblur') { b.style.backdropFilter = 'none'; }
    else if (mode === 'clear') { b.style.backdropFilter = 'none'; b.style.backgroundColor = 'transparent'; b.style.backgroundImage = 'none'; }
    return mode;
  };
  'ready';
})()`);

async function ensureExpanded(expanded) {
  const cur = await ev(`document.querySelector('button[aria-label="展开子会话看板"]')?.getAttribute('aria-expanded') ?? null`);
  if (cur === null) return 'no-toggle';
  if ((cur === 'true') === expanded) return 'already';
  await ev(`document.querySelector('button[aria-label="展开子会话看板"]').click(); 'ok'`);
  await sleep(450);
  return 'toggled';
}

async function scrollUnder() {
  const res = await ev(`(() => {
    const sc = document.querySelector('.message-scroll'); const b = document.querySelector('.super-board-surface');
    if (!sc || !b) return null;
    const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
    let best = { top: 0, chars: -1 };
    const step = Math.max(12, Math.round(max / 120) || 12);
    for (let t = 0; t <= max; t += step) {
      sc.scrollTop = t;
      const br = b.getBoundingClientRect();
      const walker = document.createTreeWalker(sc, NodeFilter.SHOW_TEXT); const range = document.createRange();
      let chars = 0;
      while (walker.nextNode()) {
        const node = walker.currentNode; const v = node.nodeValue || ''; if (!v.trim()) continue;
        range.selectNodeContents(node);
        for (const rr of range.getClientRects()) {
          if (rr.height <= 0) continue;
          const ov = Math.max(0, Math.min(br.bottom, rr.bottom) - Math.max(br.top, rr.top));
          if (ov > 2 && rr.right > br.left && rr.left < br.right) chars += Math.round(v.length * Math.min(1, ov / rr.height));
        }
      }
      if (chars > best.chars) best = { top: t, chars };
    }
    sc.scrollTop = best.top; return { top: best.top, chars: best.chars, max };
  })()`);
  await sleep(500);
  return res;
}

await setTheme("light");
await setViewport(900, 900);
await sleep(600);
const loaded = await ev(`!!document.querySelector('.super-board-surface')`);
out.atoms.loaded = loaded;

// --- expanded ---
await ensureExpanded(true);
await sleep(300);
out.atoms.scrollExpanded = await scrollUnder();
const rectE = await ev(`(() => { const r = document.querySelector('.super-board-surface').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
await shot("board-ghost-expanded");
const regionE = { x: rectE.x + 8, y: rectE.y + 46, w: rectE.w - 16, h: rectE.h - 70 };
await ev(`window.__hideKids(true)`);
await ev(`window.__setSurf('normal')`);
await sleep(200);
const A = await shot(null);
const aStats = await ev(`window.__analyze(${JSON.stringify(A)}, ${JSON.stringify(regionE)})`);
await ev(`window.__setSurf('noblur')`);
await sleep(250);
const B = await shot(null);
const bStats = await ev(`window.__analyze(${JSON.stringify(B)}, ${JSON.stringify(regionE)})`);
await ev(`window.__setSurf('clear')`);
await sleep(250);
const C = await shot(null);
const cStats = await ev(`window.__analyze(${JSON.stringify(C)}, ${JSON.stringify(regionE)})`);
await shot("board-ghost-expanded-clear");
await ev(`window.__setSurf('normal'); window.__hideKids(false); 'ok'`);
await sleep(200);
out.atoms.expanded = { rect: rectE, region: regionE, acrylic: aStats, tintNoBlur: bStats, clear: cStats };

// --- collapsed ---
await ensureExpanded(false);
await sleep(400);
out.atoms.scrollCollapsed = await scrollUnder();
const rectC = await ev(`(() => { const r = document.querySelector('.super-board-surface').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
await shot("board-ghost-collapsed");
const regionC = { x: rectC.x + 8, y: rectC.y + 7, w: rectC.w - 16, h: rectC.h - 22 };
await ev(`window.__hideKids(true)`);
await ev(`window.__setSurf('normal')`);
await sleep(200);
const A2 = await shot(null);
const a2 = await ev(`window.__analyze(${JSON.stringify(A2)}, ${JSON.stringify(regionC)})`);
await ev(`window.__setSurf('noblur')`);
await sleep(250);
const B2 = await shot(null);
const b2 = await ev(`window.__analyze(${JSON.stringify(B2)}, ${JSON.stringify(regionC)})`);
await ev(`window.__setSurf('clear')`);
await sleep(250);
const C2 = await shot(null);
const c2 = await ev(`window.__analyze(${JSON.stringify(C2)}, ${JSON.stringify(regionC)})`);
await ev(`window.__setSurf('normal'); window.__hideKids(false); 'ok'`);
await sleep(200);
out.atoms.collapsed = { rect: rectC, region: regionC, acrylic: a2, tintNoBlur: b2, clear: c2 };

fs.writeFileSync(REPORT, JSON.stringify(out, null, 2), "utf8");
console.log(JSON.stringify(out, null, 1));
ws.close();
