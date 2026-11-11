import fs from "node:fs";
import path from "node:path";

const OUT = "j:/git/iflow-harness/.iflow/super/worktrees/看板背景改亚克力加阴影-mwchyuns-9/.iflow/screens";
const PAGE_URL = "http://127.0.0.1:8799/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const out = { ghost: {}, shadow: {}, darkStyles: {}, shots: [], narrowDark: {} };

const list = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p.resolve(m.result); }
});
const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, { resolve }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 900));
  return r.result.value;
};
await send("Page.enable");
await send("Runtime.enable");
const DSF = 2;

const setViewport = (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: DSF, mobile: false });
const setTheme = async (t) => { await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: t }] }); await sleep(150); };

async function capture(name, clip) {
  const params = { format: "png", captureBeyondViewport: false };
  if (clip) params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 };
  const r = await send("Page.captureScreenshot", params);
  fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.data, "base64"));
  out.shots.push(name + ".png");
  return r.data;
}

async function install() {
  await ev(`window.__sbStats = async (b64, rect, dsf, wantRowProfile) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
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
    const mean = sum / n, sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    let mn = 255, mx = 0;
    for (let i = 0; i < n; i++) { if (lum[i] < mn) mn = lum[i]; if (lum[i] > mx) mx = lum[i]; }
    let g = 0, gn = 0;
    for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) { g += Math.abs(lum[y * w + x] - lum[y * w + x - 1]); gn++; }
    const rows = [];
    for (let y = 0; y < h; y++) { let s = 0; for (let x = 0; x < w; x++) s += lum[y * w + x]; rows.push(+(s / w).toFixed(2)); }
    // column-edge energy above a threshold reveals legible glyph structure
    const stats = { w, h, mean: +mean.toFixed(2), sd: +sd.toFixed(2), min: +mn.toFixed(1), max: +mx.toFixed(1), edge: +(g / gn).toFixed(3) };
    if (wantRowProfile) stats.rows = rows;
    return stats;
  }; 'ok'`);
}

const stats = (b64, rect, profile) => ev(`window.__sbStats(${JSON.stringify(b64)}, ${JSON.stringify(rect)}, ${DSF}, ${profile ? "true" : "false"})`);

async function rects() {
  return ev(`(() => {
    const b = document.querySelector('.super-board-surface');
    const r = b.getBoundingClientRect();
    const inner = { x: r.x + 5, y: r.y + 5, width: r.width - 10, height: r.height - 10 };
    return { rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) }, inner };
  })()`);
}

async function setCollapsed(collapsed) {
  const cur = await ev(`document.querySelector('button[aria-label="展开子会话看板"]')?.getAttribute('aria-expanded')`);
  if (cur === null || cur === undefined) return "no-toggle";
  if ((cur === "true") === !collapsed) return "already";
  await ev(`document.querySelector('button[aria-label="展开子会话看板"]').click(); 'ok'`);
  await sleep(360);
  return "toggled";
}

async function scrollTextBehind() {
  const pick = await ev(`(() => {
    const sc = document.querySelector('.message-scroll');
    if (!sc) return null;
    const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
    let best = { top: 0, chars: -1 };
    const step = Math.max(16, Math.round(max / 90) || 16);
    for (let t = 0; t <= max; t += step) {
      sc.scrollTop = t;
      const b = document.querySelector('.super-board-surface').getBoundingClientRect();
      const walker = document.createTreeWalker(sc, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let chars = 0;
      while (walker.nextNode()) {
        const t2 = walker.currentNode; const v = t2.nodeValue || '';
        if (!v.trim()) continue;
        range.selectNodeContents(t2);
        for (const r of range.getClientRects()) {
          if (r.height <= 0) continue;
          const ov = Math.max(0, Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top));
          if (ov > 2) chars += Math.round(v.length * Math.min(1, ov / r.height));
        }
      }
      if (chars > best.chars) best = { top: t, chars };
    }
    sc.scrollTop = best.top;
    return best;
  })()`);
  await sleep(500);
  return pick;
}

async function styleDump() {
  return ev(`(() => {
    const b = document.querySelector('.super-board-surface');
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    return {
      className: b.className,
      backdropFilter: cs.backdropFilter,
      backgroundColor: cs.backgroundColor,
      backgroundImage: cs.backgroundImage,
      boxShadow: cs.boxShadow,
      borderTopColor: cs.borderTopColor,
      overflow: cs.overflow,
      rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) },
      bgVar: getComputedStyle(document.documentElement).getPropertyValue('--editor').trim(),
      theme: document.documentElement.className + '|' + document.body.className + '|' + (getComputedStyle(document.body).backgroundColor)
    };
  })()`);
}

async function ghostSuite(tag, theme) {
  // board children hidden -> pure surface over transcript, no own labels
  await ev(`(() => { const b = document.querySelector('.super-board-surface'); b.dataset.sbChild = '1'; [...b.children].forEach(c => c.style.visibility = 'hidden'); })()`);
  await sleep(350);
  const g = await rects();
  const surfaceOnly = await capture(`v3-${theme}-${tag}-surface-only`, g.inner);
  const sStats = await stats(surfaceOnly, g.inner, false);

  // board hidden -> raw transcript behind
  await ev(`(() => { const b = document.querySelector('.super-board-surface'); b.style.visibility = 'hidden'; })()`);
  await sleep(350);
  const raw = await capture(`v3-${theme}-${tag}-raw-behind`, g.inner);
  const rStats = await stats(raw, g.inner, false);
  await ev(`(() => { const b = document.querySelector('.super-board-surface'); b.style.visibility = ''; [...b.children].forEach(c => c.style.visibility = ''); })()`);
  await sleep(300);

  return { rect: g.inner, surfaceOnly: sStats, rawBehind: rStats, ghostRatio: +(sStats.sd / Math.max(0.01, rStats.sd)).toFixed(3), edgeRatio: +(sStats.edge / Math.max(0.001, rStats.edge)).toFixed(3) };
}

async function shadowProfile(tag, theme) {
  const r = await rects();
  const clipRect = { x: r.rect.x + 4, y: r.rect.y + r.rect.height - 2, width: r.rect.width - 8, height: 46 };
  const b64 = await capture(`v3-${theme}-${tag}-shadow-below`, clipRect);
  const s = await stats(b64, clipRect, true);
  const near = s.rows.slice(0, 10);
  const far = s.rows.slice(30, 44);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  return {
    clipRect,
    rowsY0to44: s.rows,
    nearMean: +avg(near).toFixed(2),
    farMean: +avg(far).toFixed(2),
    dropNear: +(avg(far) - avg(near)).toFixed(2),
    meanAll: s.mean,
  };
}

async function load(theme, w, h) {
  await setViewport(w, h);
  await setTheme(theme);
  await send("Page.navigate", { url: PAGE_URL });
  await sleep(2600);
  for (let i = 0; i < 40; i++) {
    if (await ev(`!!document.querySelector('.super-board-surface')`)) break;
    await sleep(250);
  }
  await sleep(600);
  await ev(`window.__x = 1; 'ok'`);
  await install();
}

// ================= LIGHT 900 =================
await load("light", 900, 900);
out.themeProbe = await ev(`({ mockDark: document.documentElement.className, bodyBg: getComputedStyle(document.body).backgroundColor })`);
await setCollapsed(true);
await sleep(300);
out.lightCollapsedStyle = await styleDump();
await capture("v3-light-collapsed-900", null);
const scrollInfo = await scrollTextBehind();
out.lightScrollPick = scrollInfo;
out.lightGhostCollapsed = await ghostSuite("collapsed", "light");
out.lightShadowCollapsed = await shadowProfile("collapsed", "light");
await capture("v3-light-collapsed-text-behind-900", null);

await setCollapsed(false);
await sleep(500);
out.lightExpandedStyle = await styleDump();
await capture("v3-light-expanded-900", null);
out.lightGhostExpanded = await ghostSuite("expanded", "light");
out.lightShadowExpanded = await shadowProfile("expanded", "light");
await capture("v3-light-expanded-text-behind-900", null);

// ================= DARK 900 =================
await load("dark", 900, 900);
out.darkThemeProbe = await ev(`({ bodyBg: getComputedStyle(document.body).backgroundColor, rootClass: document.documentElement.className, htmlData: document.documentElement.getAttribute('data-theme') })`);
await setCollapsed(true);
await sleep(300);
out.darkCollapsedStyle = await styleDump();
await capture("v3-dark-collapsed-900", null);
out.darkScrollPick = await scrollTextBehind();
out.darkGhostCollapsed = await ghostSuite("collapsed", "dark");
out.darkShadowCollapsed = await shadowProfile("collapsed", "dark");
await capture("v3-dark-collapsed-text-behind-900", null);

await setCollapsed(false);
await sleep(500);
out.darkExpandedStyle = await styleDump();
await capture("v3-dark-expanded-900", null);
out.darkGhostExpanded = await ghostSuite("expanded", "dark");
out.darkShadowExpanded = await shadowProfile("expanded", "dark");

// ================= DARK narrow =================
for (const w of [480, 360]) {
  await load("dark", w, 900);
  await setCollapsed(true);
  await sleep(350);
  const collapsed = await ev(`(() => {
    const b = document.querySelector('.super-board-surface');
    const r = b.getBoundingClientRect();
    return { innerWidth, docScrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth,
      overflowX: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
      boardLeft: +r.left.toFixed(1), boardRight: +r.right.toFixed(1), boardHeight: +r.height.toFixed(1) };
  })()`);
  await capture(`v3-dark-collapsed-${w}`, null);
  await setCollapsed(false);
  await sleep(450);
  const expanded = await ev(`(() => {
    const b = document.querySelector('.super-board-surface');
    const r = b.getBoundingClientRect();
    const rows = [...b.querySelectorAll('.divide-y > div')];
    return { innerWidth, docScrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth,
      overflowX: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
      boardLeft: +r.left.toFixed(1), boardRight: +r.right.toFixed(1), boardHeight: +r.height.toFixed(1), boardBottom: +r.bottom.toFixed(1),
      rowsWithOwnOverflow: rows.filter(x => x.scrollWidth > x.clientWidth + 1).length };
  })()`);
  await capture(`v3-dark-expanded-${w}`, null);
  out.narrowDark[w] = { collapsed, expanded };
}

fs.writeFileSync(path.join(OUT, "v3-report-2.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
ws.close();
