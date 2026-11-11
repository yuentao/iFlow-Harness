// Board material / narrow-screen / modal verification (self-driven CDP).
// Writes screenshots to .iflow/screens and a JSON report to .iflow/tmp.
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const OUT = path.join(ROOT, ".iflow", "screens");
const REPORT = path.join(ROOT, ".iflow", "tmp", "board-verify.json");
const PAGE_URL = "http://127.0.0.1:8797/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = { meta: {}, atoms: {}, items: {}, errors: [] };
const save = () => fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), "utf8");

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch("http://127.0.0.1:9222/json")).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error("no CDP page target");
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async ev(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 1200));
    return r.result.value;
  }
}

const target = await getTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", rej);
});
const cdp = new CDP(ws);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");

const DSF = 2;
const setViewport = (w, h) =>
  cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: DSF, mobile: false });
const setTheme = async (theme) => {
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  await sleep(200);
};

async function shot(name, clip) {
  const params = { format: "png", captureBeyondViewport: false };
  if (clip) params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 };
  const r = await cdp.send("Page.captureScreenshot", params);
  const b64 = r.data;
  if (name) fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(b64, "base64"));
  return b64;
}

const installHelpers = async () => {
  await cdp.ev(`(() => {
  window.__sbAnalyze = async (b64, region, pageW) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const s = img.width / pageW;
    const x0 = Math.max(0, Math.round(region.x * s));
    const y0 = Math.max(0, Math.round(region.y * s));
    const w = Math.max(1, Math.min(img.width - x0, Math.round(region.w * s)));
    const h = Math.max(1, Math.min(img.height - y0, Math.round(region.h * s)));
    const d = ctx.getImageData(x0, y0, w, h).data;
    const n = w * h;
    const lum = new Float64Array(n);
    let sum = 0, sum2 = 0, mn = 255, mx = 0;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      lum[j] = l; sum += l; sum2 += l * l;
      if (l < mn) mn = l; if (l > mx) mx = l;
    }
    const mean = sum / n;
    const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    let g = 0, gn = 0;
    for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) { g += Math.abs(lum[y * w + x] - lum[y * w + x - 1]); gn++; }
    const rows = [];
    for (let y = 0; y < h; y++) { let sr = 0; for (let x = 0; x < w; x++) sr += lum[y * w + x]; rows.push(+(sr / w).toFixed(2)); }
    return { w, h, mean: +mean.toFixed(2), sd: +sd.toFixed(2), min: +mn.toFixed(1), max: +mx.toFixed(1), edge: +(g / Math.max(1, gn)).toFixed(3), rows };
  };
  window.__sbDiff = async (a64, b64, region, pageW) => {
    const load = async (b) => { const i = new Image(); i.src = 'data:image/png;base64,' + b; await i.decode(); return i; };
    const [ia, ib] = await Promise.all([load(a64), load(b64)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return { error: 'size mismatch' };
    const ca = document.createElement('canvas'); ca.width = ia.width; ca.height = ia.height;
    const ga = ca.getContext('2d', { willReadFrequently: true }); ga.drawImage(ia, 0, 0);
    const cb = document.createElement('canvas'); cb.width = ib.width; cb.height = ib.height;
    const gb = cb.getContext('2d', { willReadFrequently: true }); gb.drawImage(ib, 0, 0);
    const s = ia.width / pageW;
    const x0 = Math.max(0, Math.round(region.x * s)), y0 = Math.max(0, Math.round(region.y * s));
    const w = Math.max(1, Math.min(ia.width - x0, Math.round(region.w * s)));
    const h = Math.max(1, Math.min(ia.height - y0, Math.round(region.h * s)));
    const da = ga.getImageData(x0, y0, w, h).data, db = gb.getImageData(x0, y0, w, h).data;
    let changed = 0, n = w * h, total = 0;
    for (let i = 0; i < da.length; i += 4) {
      const la = 0.2126 * da[i] + 0.7152 * da[i + 1] + 0.0722 * da[i + 2];
      const lb = 0.2126 * db[i] + 0.7152 * db[i + 1] + 0.0722 * db[i + 2];
      const dd = Math.abs(la - lb);
      total += dd;
      if (dd > 2) changed++;
    }
    return { changedPct: +((changed / n) * 100).toFixed(2), meanAbsDelta: +(total / n).toFixed(3) };
  };
  'ready';
})()`);
};
await installHelpers();

const analyze = (b64, region) =>
  cdp.ev(`window.__sbAnalyze(${JSON.stringify(b64)}, ${JSON.stringify(region)}, window.innerWidth)`);
const diff = (a, b, region) =>
  cdp.ev(`window.__sbDiff(${JSON.stringify(a)}, ${JSON.stringify(b)}, ${JSON.stringify(region)}, window.innerWidth)`);

async function waitBoard(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await cdp.ev(`!!document.querySelector('.super-board-surface')`);
    if (ok) return true;
    await sleep(300);
  }
  return false;
}

async function ensureExpanded(expanded) {
  const cur = await cdp.ev(
    `document.querySelector('button[aria-label="展开子会话看板"]')?.getAttribute('aria-expanded') ?? null`,
  );
  if (cur === null) return "no-toggle";
  const isExpanded = cur === "true";
  if (isExpanded === expanded) return "already";
  await cdp.ev(`document.querySelector('button[aria-label="展开子会话看板"]').click(); 'ok'`);
  await sleep(400);
  return "toggled";
}

async function measure() {
  return cdp.ev(`(() => {
    const b = document.querySelector('.super-board-surface');
    if (!b) return null;
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    const alphaMatch = cs.backgroundColor.match(/\\/\\s*([0-9.]+)\\s*\\)/);
    const ancestors = [];
    let p = b.parentElement;
    while (p && p !== document.documentElement) {
      const pcs = getComputedStyle(p);
      ancestors.push({ tag: p.tagName, cls: String(p.className || '').slice(0, 80), overflow: pcs.overflow, overflowX: pcs.overflowX, overflowY: pcs.overflowY, backdropFilter: pcs.backdropFilter });
      p = p.parentElement;
    }
    const overflowEls = [];
    for (const el of b.querySelectorAll('*')) {
      const rr = el.getBoundingClientRect();
      if (rr.width > 1 && rr.height > 1 && (rr.right > innerWidth + 1 || rr.left < -1)) {
        overflowEls.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 70), left: +rr.left.toFixed(1), right: +rr.right.toFixed(1) });
      }
    }
    return {
      cls: String(b.className),
      backdropFilter: cs.backdropFilter,
      backgroundColor: cs.backgroundColor,
      backgroundAlpha: alphaMatch ? Number(alphaMatch[1]) : null,
      backgroundImage: cs.backgroundImage,
      boxShadow: cs.boxShadow,
      rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), bottom: +r.bottom.toFixed(1) },
      scrollWidth: b.scrollWidth,
      clientWidth: b.clientWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      ancestors,
      overflowEls: overflowEls.slice(0, 12),
      overflowCount: overflowEls.length,
      textUnderBoard: (() => {
        const sc = document.querySelector('.message-scroll');
        if (!sc) return null;
        const walker = document.createTreeWalker(sc, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        let chars = 0;
        while (walker.nextNode()) {
          const t = walker.currentNode;
          const v = t.nodeValue || '';
          if (!v.trim()) continue;
          range.selectNodeContents(t);
          for (const rr of range.getClientRects()) {
            if (rr.height <= 0) continue;
            const ov = Math.max(0, Math.min(r.bottom, rr.bottom) - Math.max(r.top, rr.top));
            if (ov > 2 && rr.right > r.left && rr.left < r.right) chars += Math.round(v.length * Math.min(1, ov / rr.height));
          }
        }
        return chars;
      })(),
    };
  })()`);
}

async function scrollTextBehind() {
  const res = await cdp.ev(`(() => {
    const sc = document.querySelector('.message-scroll');
    const b = document.querySelector('.super-board-surface');
    if (!sc || !b) return null;
    const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
    let best = { top: 0, chars: -1 };
    const step = Math.max(12, Math.round(max / 120) || 12);
    for (let t = 0; t <= max; t += step) {
      sc.scrollTop = t;
      const br = b.getBoundingClientRect();
      const walker = document.createTreeWalker(sc, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let chars = 0;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const v = node.nodeValue || '';
        if (!v.trim()) continue;
        range.selectNodeContents(node);
        for (const rr of range.getClientRects()) {
          if (rr.height <= 0) continue;
          const ov = Math.max(0, Math.min(br.bottom, rr.bottom) - Math.max(br.top, rr.top));
          if (ov > 2 && rr.right > br.left && rr.left < br.right) chars += Math.round(v.length * Math.min(1, ov / rr.height));
        }
      }
      if (chars > best.chars) best = { top: t, chars };
    }
    sc.scrollTop = best.top;
    return { top: best.top, chars: best.chars, max };
  })()`);
  await sleep(500);
  return res;
}

async function bandStats(b64, rect, from, to, align) {
  // rows measured relative to rect bottom (`below`) or top (`inside`)
  const region =
    align === "below"
      ? { x: rect.x, y: rect.bottom + from, w: rect.w, h: to - from }
      : { x: rect.x + 4, y: rect.y + from, w: rect.w - 8, h: to - from };
  return analyze(b64, region);
}

// ---------- phase 1: light 900 ----------
await setTheme("light");
await setViewport(900, 900);
await cdp.send("Page.navigate", { url: PAGE_URL });
const loaded = await waitBoard();
report.meta.loaded = loaded;
await installHelpers();
await sleep(900);

report.meta.page = await cdp.ev(`({
  url: location.href,
  title: document.title,
  assetScript: [...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src')),
  assetCss: [...document.querySelectorAll('link[rel=stylesheet]')].map(s => s.getAttribute('href')),
  classList: [...document.querySelectorAll('.super-board-surface')].map(e => String(e.className)),
})`);

await ensureExpanded(true);
await sleep(300);
const expanded = await measure();
report.atoms.expanded = expanded;
save();

// expanded screenshot (board + shadow margin)
if (expanded) {
  await shot("board-acrylic-expanded", {
    x: Math.max(0, expanded.rect.x - 6),
    y: Math.max(0, expanded.rect.y - 6),
    width: Math.min(900 - Math.max(0, expanded.rect.x - 6), expanded.rect.w + 12),
    height: Math.min(900 - Math.max(0, expanded.rect.y - 6), expanded.rect.h + 34),
  });
  const fullOn = await shot(null);
  await cdp.ev(`document.querySelector('.super-board-surface').dataset.prevShadow = getComputedStyle(document.querySelector('.super-board-surface')).boxShadow; document.querySelector('.super-board-surface').style.boxShadow = 'none'; 'ok'`);
  const fullOff = await shot(null);
  await cdp.ev(`{ const b = document.querySelector('.super-board-surface'); b.style.boxShadow = ''; delete b.dataset.prevShadow; } 'ok'`);
  await sleep(200);
  report.atoms.expandedShadowBand = await diff(fullOn, fullOff, {
    x: expanded.rect.x + 2,
    y: expanded.rect.bottom + 1,
    w: expanded.rect.w - 4,
    h: 26,
  });
  report.atoms.expandedShadowFarBand = await diff(fullOn, fullOff, {
    x: expanded.rect.x + 2,
    y: expanded.rect.bottom + 40,
    w: expanded.rect.w - 4,
    h: 16,
  });
  // pixel-level check of the same band while the shadow is ON
  report.atoms.expandedBelowRows = await bandStats(fullOn, expanded.rect, 1, 30, "below");
}

// ---------- phase 2: light 900 collapsed ----------
const collapseRes = await ensureExpanded(false);
await sleep(400);
const collapsed = await measure();
report.atoms.collapsed = collapsed;
save();
if (collapsed) {
  await shot("board-acrylic-collapsed", {
    x: Math.max(0, collapsed.rect.x - 6),
    y: Math.max(0, collapsed.rect.y - 6),
    width: Math.min(900 - Math.max(0, collapsed.rect.x - 6), collapsed.rect.w + 12),
    height: Math.min(900 - Math.max(0, collapsed.rect.y - 6), collapsed.rect.h + 34),
  });
  const on = await shot(null);
  await cdp.ev(`document.querySelector('.super-board-surface').style.boxShadow = 'none'; 'ok'`);
  const off = await shot(null);
  await cdp.ev(`document.querySelector('.super-board-surface').style.boxShadow = ''; 'ok'`);
  await sleep(200);
  report.atoms.collapsedShadowBand = await diff(on, off, {
    x: collapsed.rect.x + 2,
    y: collapsed.rect.bottom + 1,
    w: collapsed.rect.w - 4,
    h: 20,
  });
  report.atoms.collapsedBelowRows = await bandStats(on, collapsed.rect, 1, 22, "below");
  report.atoms.collapseToggle = collapseRes;
}

// ---------- phase 3: readability (text scrolled under the shelf) ----------
await ensureExpanded(false);
await sleep(300);
const scrollPick = await scrollTextBehind();
report.atoms.scrollPick = scrollPick;
const shelfRect = await cdp.ev(`(() => { const b = document.querySelector('.super-board-surface'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), bottom: +r.bottom.toFixed(1) }; })()`);
report.atoms.shelfPresent = !!shelfRect;
save();
if (!shelfRect) throw new Error("board missing in phase 3");
const ghostOn = await shot("board-ghost-text");
const ghostOnStats = await analyze(ghostOn, {
  x: shelfRect.x + 4,
  y: shelfRect.y + (shelfRect.h > 60 ? 60 : 4),
  w: shelfRect.w - 8,
  h: Math.max(6, Math.min(60, shelfRect.h - 8)),
});
// control: remove the acrylic tint + blur -> the SAME region shows raw text
await cdp.ev(`(() => { const b = document.querySelector('.super-board-surface');
  b.dataset.stash = JSON.stringify({ bc: b.style.backgroundColor, bi: b.style.backgroundImage, bf: b.style.backdropFilter });
  b.style.backgroundColor = 'transparent'; b.style.backgroundImage = 'none'; b.style.backdropFilter = 'none'; return 'ok'; })()`);
await sleep(250);
const ghostOff = await shot("board-ghost-control");
const ghostOffStats = await analyze(ghostOff, {
  x: shelfRect.x + 4,
  y: shelfRect.y + (shelfRect.h > 60 ? 60 : 4),
  w: shelfRect.w - 8,
  h: Math.max(6, Math.min(60, shelfRect.h - 8)),
});
await cdp.ev(`(() => { const b = document.querySelector('.super-board-surface');
  const st = JSON.parse(b.dataset.stash); b.style.backgroundColor = st.bc; b.style.backgroundImage = st.bi; b.style.backdropFilter = st.bf; delete b.dataset.stash; return 'ok'; })()`);
await sleep(250);
report.atoms.ghost = {
  textCharsUnderShelf: (await measure())?.textUnderBoard,
  withAcrylic: ghostOnStats,
  withoutAcrylic: ghostOffStats,
};

// ---------- phase 4: narrow 360 / 480 ----------
report.atoms.narrow = {};
for (const w of [360, 480]) {
  await setViewport(w, 820);
  await sleep(500);
  await ensureExpanded(true);
  await sleep(450);
  const m = await measure();
  const on = await shot(`board-narrow-${w}`);
  if (!m) {
    report.atoms.narrow[w] = null;
    continue;
  }
  await cdp.ev(`document.querySelector('.super-board-surface').style.boxShadow = 'none'; 'ok'`);
  const off = await shot(null);
  await cdp.ev(`document.querySelector('.super-board-surface').style.boxShadow = ''; 'ok'`);
  await sleep(150);
  const shadowBand = await diff(on, off, {
    x: Math.max(0, m.rect.x + 1),
    y: Math.max(0, m.rect.y + m.rect.h + 1),
    w: Math.min(w - Math.max(0, m.rect.x) - 2, m.rect.w - 2),
    h: 20,
  });
  report.atoms.narrow[w] = {
    rect: m.rect,
    boxShadow: m.boxShadow,
    backdropFilter: m.backdropFilter,
    backgroundAlpha: m.backgroundAlpha,
    docScrollWidth: m.docScrollWidth,
    innerWidth: m.innerWidth,
    boardScrollWidth: m.scrollWidth,
    boardClientWidth: m.clientWidth,
    overflowCount: m.overflowCount,
    overflowEls: m.overflowEls,
    clippedAncestors: m.ancestors.filter((a) => a.overflow !== "visible"),
    backdropAncestors: m.ancestors.filter((a) => a.backdropFilter && a.backdropFilter !== "none"),
    shadowBand,
  };
  // collapsed narrow check too
  await ensureExpanded(false);
  await sleep(350);
  const mc = await measure();
  report.atoms.narrow[w].collapsed = mc
    ? { rect: mc.rect, boxShadow: mc.boxShadow, overflowCount: mc.overflowCount, overflowEls: mc.overflowEls, docScrollWidth: mc.docScrollWidth }
    : null;
  await shot(`board-narrow-${w}-collapsed`);
  await ensureExpanded(true);
  await sleep(300);
}
save();

// ---------- phase 5: live modal at 360 ----------
await setViewport(360, 820);
await sleep(500);
await ensureExpanded(true);
await sleep(400);
const rowOpen = await cdp.ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('修复登录跳转'));
  if (!b) return { found: false };
  b.click();
  return { found: true };
})()`);
await sleep(500);
const liveClick = await cdp.ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('查看实时操作'));
  if (!b) return { found: false, buttons: [...document.querySelectorAll('button')].map(x => (x.textContent||'').trim().slice(0,14)).slice(0, 40) };
  b.click();
  return { found: true };
})()`);
await sleep(700);
const modal = await cdp.ev(`(() => {
  const d = document.querySelector('[role="dialog"]');
  if (!d) return { open: false };
  const r = d.getBoundingClientRect();
  const cs = getComputedStyle(d);
  const chain = [];
  let p = d;
  while (p && p !== document.documentElement) { chain.push(p === d ? 'dialog' : (p.tagName + '.' + String(p.className || '').slice(0, 50))); p = p.parentElement; }
  const ancestors = [];
  p = d.parentElement;
  while (p && p !== document.documentElement) {
    const pcs = getComputedStyle(p);
    ancestors.push({ tag: p.tagName, cls: String(p.className || '').slice(0, 70), overflow: pcs.overflow, backdropFilter: pcs.backdropFilter, position: pcs.position });
    p = p.parentElement;
  }
  const pts = [[r.left + 4, r.top + 4], [r.right - 4, r.top + 4], [r.left + 4, r.bottom - 4], [r.right - 4, r.bottom - 4], [r.left + r.width / 2, r.top + r.height / 2]];
  const hits = pts.map(([x, y]) => {
    const el = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, x)), Math.max(0, Math.min(innerHeight - 1, y)));
    return { inDialog: !!el && d.contains(el), tag: el ? el.tagName : null };
  });
  return {
    open: true,
    ariaLabel: d.getAttribute('aria-label'),
    rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
    insideViewport: r.x >= -1 && r.y >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
    position: cs.position,
    parentIsBody: d.parentElement === document.body || chain.includes('BODY'),
    chain: chain.slice(0, 10),
    clippedAncestors: ancestors.filter(a => a.overflow !== 'visible'),
    backdropAncestors: ancestors.filter(a => a.backdropFilter && a.backdropFilter !== 'none'),
    hits,
    textLen: (d.textContent || '').length,
  };
})()`);
await shot("board-live-modal", { x: 0, y: 0, width: 360, height: 820 });
report.atoms.modal = { rowOpen, liveClick, modal };
save();

// ---------- phase 6: dark theme spot check ----------
await setTheme("dark");
await cdp.send("Page.navigate", { url: PAGE_URL });
await waitBoard();
await installHelpers();
await sleep(900);
await ensureExpanded(false);
await sleep(400);
const dark = await measure();
report.atoms.dark = dark;
if (dark) {
  const on = await shot("board-acrylic-dark-collapsed");
  await cdp.ev(`document.querySelector('.super-board-surface').style.boxShadow = 'none'; 'ok'`);
  const off = await shot(null);
  await cdp.ev(`document.querySelector('.super-board-surface').style.boxShadow = ''; 'ok'`);
  await sleep(200);
  report.atoms.darkShadowBand = await diff(on, off, {
    x: dark.rect.x + 2,
    y: dark.rect.bottom + 1,
    w: dark.rect.w - 4,
    h: 20,
  });
  await ensureExpanded(true);
  await sleep(350);
  const darkExpanded = await measure();
  report.atoms.darkExpanded = darkExpanded;
  await shot("board-acrylic-dark-expanded", {
    x: Math.max(0, darkExpanded.rect.x - 6),
    y: Math.max(0, darkExpanded.rect.y - 6),
    width: Math.min(900 - Math.max(0, darkExpanded.rect.x - 6), darkExpanded.rect.w + 12),
    height: Math.min(900 - Math.max(0, darkExpanded.rect.y - 6), darkExpanded.rect.h + 34),
  });
}

report.meta.dist = (() => {
  const dist = path.join(ROOT, "webview", "dist");
  const files = ["index.html"];
  const matcher = /(index-[A-Za-z0-9_-]+\.(?:js|css))/g;
  const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
  for (const m of html.matchAll(matcher)) files.push(path.join("assets", m[1]));
  return files.map((f) => {
    const p = path.join(dist, f);
    const st = fs.statSync(p);
    return { file: f.replace(/\\/g, "/"), bytes: st.size, mtime: st.mtime.toISOString() };
  });
})();
save();
console.log(JSON.stringify({ ok: true, report: REPORT }, null, 2));
ws.close();