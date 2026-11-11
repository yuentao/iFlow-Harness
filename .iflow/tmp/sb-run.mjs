import fs from "node:fs";
import path from "node:path";

const OUT = "j:/git/iflow-harness/.iflow/super/worktrees/看板背景改亚克力加阴影-mwchyuns-9/.iflow/screens";
const PAGE_URL = "http://127.0.0.1:8799/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = { steps: [], shots: [], styles: {}, readability: {}, shadow: {}, narrow: {}, modal: {} };

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch("http://127.0.0.1:9222/json")).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error("no CDP target");
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

async function setViewport(w, h) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: DSF, mobile: false });
}
async function setTheme(theme) {
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  await sleep(200);
}

async function shot(name, clip) {
  const params = { format: "png", captureBeyondViewport: false };
  if (clip) params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 };
  const r = await cdp.send("Page.captureScreenshot", params);
  const buf = Buffer.from(r.data, "base64");
  fs.writeFileSync(path.join(OUT, name + ".png"), buf);
  report.shots.push({ file: name + ".png", bytes: buf.length });
  return r.data;
}

async function shotFull(name) {
  return shot(name, null);
}

async function installAnalyzer() {
  await cdp.ev(`window.__sbAnalyze = async (dataUrl, rect, dsf) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const x0 = Math.round(rect.x * dsf), y0 = Math.round(rect.y * dsf);
    const w = Math.max(2, Math.min(img.width - x0, Math.round(rect.width * dsf)));
    const h = Math.max(2, Math.min(img.height - y0, Math.round(rect.height * dsf)));
    const d = ctx.getImageData(x0, y0, w, h).data;
    const lum = new Float64Array(w * h);
    let sum = 0, sum2 = 0;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      lum[j] = l; sum += l; sum2 += l * l;
    }
    const n = w * h;
    const mean = sum / n;
    const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    let mn = 255, mx = 0;
    for (let i = 0; i < n; i++) { if (lum[i] < mn) mn = lum[i]; if (lum[i] > mx) mx = lum[i]; }
    let g = 0, gn = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 1; x < w; x++) { g += Math.abs(lum[y * w + x] - lum[y * w + x - 1]); gn++; }
    }
    const rmeans = [];
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = 0; x < w; x++) s += lum[y * w + x];
      rmeans.push(s / w);
    }
    let rm = 0;
    for (const v of rmeans) rm += v;
    rm /= h;
    let rv = 0;
    for (const v of rmeans) rv += (v - rm) * (v - rm);
    const rowSd = Math.sqrt(rv / h);
    return { w, h, mean: +mean.toFixed(2), sd: +sd.toFixed(2), min: +mn.toFixed(1), max: +mx.toFixed(1), range: +(mx - mn).toFixed(1), edge: +(g / gn).toFixed(3), rowSd: +rowSd.toFixed(2) };
  }; 'ok'`);
}

async function analyze(dataUrl, rect) {
  return cdp.ev(`window.__sbAnalyze("data:image/png;base64," + ${JSON.stringify(dataUrl)}, ${JSON.stringify(rect)}, ${DSF})`);
}

async function boardInfo() {
  return cdp.ev(`(() => {
    const b = document.querySelector('.super-board-surface');
    if (!b) return null;
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    const root = document.documentElement;
    const rootCs = getComputedStyle(root);
    const sc = document.querySelector('.message-scroll');
    const toggle = document.querySelector('button[aria-label="展开子会话看板"]');
    return {
      className: b.className,
      ariaExpanded: toggle ? toggle.getAttribute('aria-expanded') : null,
      backdropFilter: cs.backdropFilter,
      webkitBackdropFilter: cs.webkitBackdropFilter,
      backgroundColor: cs.backgroundColor,
      backgroundImage: cs.backgroundImage,
      boxShadow: cs.boxShadow,
      borderTop: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
      borderRadius: cs.borderRadius,
      overflow: cs.overflow,
      rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) },
      cssVars: {
        acrylicTint: rootCs.getPropertyValue('--acrylic-tint').trim(),
        acrylicPopTint: rootCs.getPropertyValue('--acrylic-pop-tint').trim(),
        acrylicEdge: rootCs.getPropertyValue('--acrylic-edge').trim(),
        shadowFloat: rootCs.getPropertyValue('--shadow-float').trim(),
        shadowPanel: rootCs.getPropertyValue('--shadow-panel').trim(),
        card: rootCs.getPropertyValue('--card').trim(),
        editor: rootCs.getPropertyValue('--editor').trim()
      },
      scroll: sc ? { scrollTop: Math.round(sc.scrollTop), scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight, rect: (() => { const s = sc.getBoundingClientRect(); return { x: +s.x.toFixed(1), y: +s.y.toFixed(1), width: +s.width.toFixed(1), height: +s.height.toFixed(1) }; })() } : null,
      docScrollWidth: root.scrollWidth,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      bodyScrollWidth: document.body.scrollWidth,
      hasHorizontalOverflow: root.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth
    };
  })()`);
}

const TEXT_CHARS_FN = `window.__sbTextBehind = () => {
  const b = document.querySelector('.super-board-surface');
  const sc = document.querySelector('.message-scroll');
  if (!b || !sc) return { chars: 0, lines: 0 };
  const br = b.getBoundingClientRect();
  const walker = document.createTreeWalker(sc, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let chars = 0, lines = 0;
  while (walker.nextNode()) {
    const t = walker.currentNode;
    const v = t.nodeValue || '';
    if (!v.trim()) continue;
    range.selectNodeContents(t);
    for (const r of range.getClientRects()) {
      if (r.height <= 0) continue;
      const ov = Math.max(0, Math.min(br.bottom, r.bottom) - Math.max(br.top, r.top));
      if (ov > 2) { chars += Math.round(v.length * Math.min(1, ov / r.height)); lines++; }
    }
  }
  return { chars, lines };
}; 'ok'`;

async function setCollapsed(collapsed) {
  const cur = await cdp.ev(`document.querySelector('button[aria-label="展开子会话看板"]')?.getAttribute('aria-expanded')`);
  if (cur === null || cur === undefined) return "no-toggle";
  const isExpanded = cur === "true";
  if (isExpanded === !collapsed) return "already";
  await cdp.ev(`document.querySelector('button[aria-label="展开子会话看板"]').click(); 'ok'`);
  await sleep(340);
  return "toggled";
}

// ---------- 0. navigate ----------
await setViewport(900, 900);
await setTheme("light");
await cdp.send("Page.navigate", { url: PAGE_URL });
await sleep(2600);
for (let i = 0; i < 40; i++) {
  const ok = await cdp.ev(`!!document.querySelector('.super-board-surface')`);
  if (ok) break;
  await sleep(300);
}
await sleep(700);
await cdp.ev(TEXT_CHARS_FN);
await installAnalyzer();

report.steps.push({ step: "loaded", info: await cdp.ev(`({ title: document.title, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, hasBoard: !!document.querySelector('.super-board-surface'), scrollEl: !!document.querySelector('.message-scroll') })`) });
if (!(await cdp.ev(`!!document.querySelector('.super-board-surface')`))) {
  throw new Error("board not found on " + (await cdp.ev("location.href")));
}
report.lightCollapsedInit = await boardInfo();

// ---------- 1. light 900 ----------
report.collapseToggle = await setCollapsed(true);
await sleep(300);
report.styles.light900Collapsed = await boardInfo();
await shotFull("v3-light-collapsed-900");

const scrollPick = await cdp.ev(`(() => {
  const sc = document.querySelector('.message-scroll');
  const b = document.querySelector('.super-board-surface');
  if (!sc || !b) return null;
  const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
  let best = { top: 0, chars: -1, lines: 0 };
  const step = Math.max(16, Math.round(max / 100) || 16);
  for (let t = 0; t <= max; t += step) {
    sc.scrollTop = t;
    const r = window.__sbTextBehind();
    if (r.chars > best.chars) best = { top: t, chars: r.chars, lines: r.lines };
  }
  sc.scrollTop = best.top;
  return best;
})()`);
await sleep(600);
report.scrollPick = scrollPick;
report.textBehindCollapsed = await cdp.ev(`window.__sbTextBehind()`);

{
  const bi = await boardInfo();
  const r = bi.rect;
  const inner = { x: r.x + 8, y: r.y + r.height * 0.3, width: r.width - 16, height: r.height * 0.45 };
  const data = await shotFull("v3-light-collapsed-text-behind-900");
  report.readability.collapsedBoardRegion = await analyze(data, inner);
  await shot("v3-light-collapsed-board-crop-900", { x: r.x - 4, y: r.y - 4, width: r.width + 8, height: r.height + 8 });
  await cdp.ev(`(() => { const b = document.querySelector('.super-board-surface'); b.dataset.sbPrev = b.style.visibility; b.style.visibility = 'hidden'; })()`);
  await sleep(300);
  const data2 = await shotFull("v3-light-collapsed-board-hidden-900");
  report.readability.behindBoardRaw = await analyze(data2, inner);
  await cdp.ev(`(() => { const b = document.querySelector('.super-board-surface'); b.style.visibility = b.dataset.sbPrev || ''; })()`);
  await sleep(300);
  report.readability.innerRect = inner;
  await shot("v3-light-collapsed-shadow-below-900", { x: r.x - 6, y: r.y + r.height - 6, width: r.width + 12, height: 48 });
  report.shadow.collapsedRect = r;
}

// ---------- expanded ----------
report.expandToggle = await setCollapsed(false);
await sleep(500);
report.styles.light900Expanded = await boardInfo();
await shotFull("v3-light-expanded-900");
{
  const bi = await boardInfo();
  const r = bi.rect;
  const inner = { x: r.x + 8, y: r.y + 8, width: r.width - 16, height: Math.min(140, r.height - 16) };
  const data = await shotFull("v3-light-expanded-text-behind-900");
  report.readability.expandedBoardRegion = await analyze(data, inner);
  await shot("v3-light-expanded-board-crop-900", { x: r.x - 6, y: r.y - 6, width: r.width + 12, height: r.height + 12 });
  await shot("v3-light-expanded-shadow-below-900", { x: r.x - 6, y: r.y + r.height - 8, width: r.width + 12, height: 56 });
  report.shadow.expandedRect = r;
}

// ---------- 2. dark 900 ----------
await setTheme("dark");
await sleep(450);
await setCollapsed(true);
await sleep(350);
report.styles.dark900Collapsed = await boardInfo();
{
  const bi = await boardInfo();
  const r = bi.rect;
  await shotFull("v3-dark-collapsed-900");
  await shot("v3-dark-collapsed-board-crop-900", { x: r.x - 4, y: r.y - 4, width: r.width + 8, height: r.height + 8 });
  const inner = { x: r.x + 8, y: r.y + r.height * 0.3, width: r.width - 16, height: r.height * 0.45 };
  const data = await shotFull("v3-dark-collapsed-text-behind-900");
  report.readability.darkCollapsedBoardRegion = await analyze(data, inner);
  await cdp.ev(`(() => { const b = document.querySelector('.super-board-surface'); b.dataset.sbPrev = b.style.visibility; b.style.visibility = 'hidden'; })()`);
  await sleep(300);
  const data2 = await shotFull("v3-dark-collapsed-board-hidden-900");
  report.readability.darkBehindRaw = await analyze(data2, inner);
  await cdp.ev(`(() => { const b = document.querySelector('.super-board-surface'); b.style.visibility = b.dataset.sbPrev || ''; })()`);
  await sleep(250);
  await shot("v3-dark-collapsed-shadow-below-900", { x: r.x - 6, y: r.y + r.height - 6, width: r.width + 12, height: 48 });
}
await setCollapsed(false);
await sleep(500);
report.styles.dark900Expanded = await boardInfo();
{
  const bi = await boardInfo();
  const r = bi.rect;
  await shotFull("v3-dark-expanded-900");
  await shot("v3-dark-expanded-board-crop-900", { x: r.x - 6, y: r.y - 6, width: r.width + 12, height: r.height + 12 });
  await shot("v3-dark-expanded-shadow-below-900", { x: r.x - 6, y: r.y + r.height - 8, width: r.width + 12, height: 56 });
}

// ---------- 3. narrow (light) ----------
await setTheme("light");
await sleep(300);
for (const w of [480, 360]) {
  await setViewport(w, 900);
  await sleep(500);
  await setCollapsed(true);
  await sleep(400);
  const collapsedInfo = await boardInfo();
  const collapsedProbe = await cdp.ev(`(() => {
    const b = document.querySelector('.super-board-surface');
    const r = b.getBoundingClientRect();
    const sc = document.querySelector('.message-scroll');
    const sr = sc.getBoundingClientRect();
    const h = b.firstElementChild;
    return {
      innerWidth: innerWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      overflowX: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
      boardLeft: +r.left.toFixed(1), boardRight: +r.right.toFixed(1), boardWidth: +r.width.toFixed(1),
      boardOutsideLeft: r.left < -0.5, boardOutsideRight: r.right > innerWidth + 0.5,
      scrollLeft: +sr.left.toFixed(1), scrollRight: +sr.right.toFixed(1),
      scrollOverflowX: sr.right > innerWidth + 0.5 || sr.left < -0.5,
      headerRowClientWidth: h.clientWidth,
      headerRowScrollWidth: h.scrollWidth,
      headerRowHeight: +h.getBoundingClientRect().height.toFixed(1),
      headerRowWraps: h.getBoundingClientRect().height > 34
    };
  })()`);
  await shotFull(`v3-light-collapsed-${w}`);
  await setCollapsed(false);
  await sleep(500);
  const expandedInfo = await boardInfo();
  const expandedProbe = await cdp.ev(`(() => {
    const b = document.querySelector('.super-board-surface');
    const r = b.getBoundingClientRect();
    const sc = document.querySelector('.message-scroll');
    const sr = sc.getBoundingClientRect();
    const rows = [...b.querySelectorAll('.divide-y > div')];
    let rowOverflow = 0;
    for (const row of rows) if (row.scrollWidth > row.clientWidth + 1) rowOverflow++;
    return {
      innerWidth: innerWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      overflowX: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
      boardLeft: +r.left.toFixed(1), boardRight: +r.right.toFixed(1), boardWidth: +r.width.toFixed(1),
      boardOutsideLeft: r.left < -0.5, boardOutsideRight: r.right > innerWidth + 0.5,
      boardHeight: +r.height.toFixed(1),
      boardBottom: +r.bottom.toFixed(1),
      scrollLeft: +sr.left.toFixed(1), scrollRight: +sr.right.toFixed(1),
      rowsWithOwnOverflow: rowOverflow,
      rowCount: rows.length
    };
  })()`);
  await shotFull(`v3-light-expanded-${w}`);
  report.narrow[w] = { collapsed: { info: collapsedInfo, probe: collapsedProbe }, expanded: { info: expandedInfo, probe: expandedProbe } };
}

// ---------- 4. modal portal (900 light) ----------
await setViewport(900, 900);
await setTheme("light");
await sleep(500);
await setCollapsed(false);
await sleep(600);
report.modal.table = await cdp.ev(`(() => {
  const b = document.querySelector('.super-board-surface');
  const btns = [...b.querySelectorAll('button')].map(x => (x.textContent || '').trim()).slice(0, 50);
  const rows = [...b.querySelectorAll('.divide-y > div')];
  return { buttonTexts: btns, rowCount: rows.length, boardOverflow: getComputedStyle(b).overflow, rowHeaderTexts: rows.map(r => (r.querySelector('button')?.textContent || '').trim().slice(0, 24)) };
})()`);

report.modal.open = await cdp.ev(`(async () => {
  const out = { rowClicked: null, liveClicked: false, dialogFound: false };
  const b = document.querySelector('.super-board-surface');
  const rows = [...b.querySelectorAll('.divide-y > div')];
  let live = null;
  for (const row of rows) {
    const header = row.querySelector('button');
    if (!header) continue;
    header.click();
    await new Promise(r => setTimeout(r, 350));
    live = [...document.querySelectorAll('.super-board-surface button')].find(x => (x.textContent || '').trim().includes('查看实时操作'));
    if (live) { out.rowClicked = (header.textContent || '').trim().slice(0, 30); break; }
  }
  if (!live) return out;
  live.click();
  out.liveClicked = true;
  await new Promise(r => setTimeout(r, 800));
  const dialog = document.querySelector('[aria-label="子会话实时操作"]') || document.querySelector('[role="dialog"]');
  out.dialogFound = !!dialog;
  if (dialog) {
    out.dialogAria = dialog.getAttribute('aria-label') || dialog.getAttribute('role');
    out.dialogParentTag = dialog.parentElement ? dialog.parentElement.tagName : null;
    out.dialogParentIsBody = dialog.parentElement === document.body;
    out.closestBoard = dialog.closest('.super-board-surface') !== null;
    out.closestBackdropFilterAncestor = (() => {
      let el = dialog.parentElement;
      while (el && el !== document.documentElement) {
        const cs = getComputedStyle(el);
        if (cs.backdropFilter && cs.backdropFilter !== 'none') return el.className.toString().slice(0, 60);
        el = el.parentElement;
      }
      return null;
    })();
    const r = dialog.getBoundingClientRect();
    out.dialogRect = { x: +r.x.toFixed(1), y: +r.y.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) };
    out.dialogWithinViewport = r.x >= -0.5 && r.y >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;
    out.dialogChain = (() => { const c = []; let el = dialog; while (el && c.length < 6) { c.push(el.tagName + (el.className ? '.' + el.className.toString().slice(0, 50) : '')); el = el.parentElement; } return c; })();
  }
  return out;
})()`);
await sleep(400);
await shotFull("v3-light-modal-900");

fs.writeFileSync(path.join(OUT, "v3-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
ws.close();
