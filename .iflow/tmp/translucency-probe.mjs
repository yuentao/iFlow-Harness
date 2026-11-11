// Decisive translucency probe: replace the app root's background with solid
// red while the board children are hidden. A translucent surface must shift
// toward red; an opaque one cannot.
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800));
  return r.result.value;
};
await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 900, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: "http://127.0.0.1:8797/" });
await sleep(2200);
await ev(`(() => {
  window.__rgb = async (b64, region) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
    const s = img.width / innerWidth;
    const x0 = Math.round(region.x * s), y0 = Math.round(region.y * s);
    const w = Math.round(region.w * s), h = Math.round(region.h * s);
    const d = ctx.getImageData(x0, y0, w, h).data;
    let r = 0, g = 0, b = 0, n = w * h;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    return { r: +(r / n).toFixed(1), g: +(g / n).toFixed(1), b: +(b / n).toFixed(1) };
  };
  const b = document.querySelector('.super-board-surface');
  const bt = b.querySelector('button[aria-label="展开子会话看板"]');
  if (bt && bt.getAttribute('aria-expanded') === 'false') bt.click();
  return 'ready';
})()`);
await sleep(500);
// hide board children so only the surface is measured
await ev(`(() => { const b = document.querySelector('.super-board-surface'); for (const k of b.children) k.style.visibility = 'hidden'; return b.children.length; })()`);
await sleep(250);
const region = await ev(`(() => { const r = document.querySelector('.super-board-surface').getBoundingClientRect(); return { x: r.x + 10, y: r.y + 50, w: r.width - 20, h: r.height - 80 }; })()`);
const shot = async () => (await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data;
const base = await shot();
const baseRgb = await ev(`window.__rgb(${JSON.stringify(base)}, ${JSON.stringify(region)})`);
// paint the app root (the board's only ancestor) solid red
const rootInfo = await ev(`(() => {
  const b = document.querySelector('.super-board-surface');
  const root = b.parentElement;
  root.dataset.prevBg = JSON.stringify({ c: root.style.backgroundColor, i: root.style.backgroundImage });
  root.style.backgroundColor = '#ff0000'; root.style.backgroundImage = 'none';
  return { tag: root.tagName, cls: String(root.className || '').slice(0, 80) };
})()`);
await sleep(350);
const red = await shot();
const redRgb = await ev(`window.__rgb(${JSON.stringify(red)}, ${JSON.stringify(region)})`);
fs.writeFileSync(path.join(process.cwd(), ".iflow", "screens", "board-translucency-red.png"), Buffer.from(red, "base64"));
await ev(`(() => { const b = document.querySelector('.super-board-surface'); const root = b.parentElement;
  const st = JSON.parse(root.dataset.prevBg); root.style.backgroundColor = st.c; root.style.backgroundImage = st.i; delete root.dataset.prevBg;
  for (const k of b.children) k.style.visibility = '';
  return 'restored'; })()`);
const out = { root: rootInfo, region, baseRgb, redBackdropRgb: redRgb, delta: { r: +(redRgb.r - baseRgb.r).toFixed(1), g: +(redRgb.g - baseRgb.g).toFixed(1), b: +(redRgb.b - baseRgb.b).toFixed(1) } };
fs.writeFileSync(path.join(process.cwd(), ".iflow", "tmp", "translucency.json"), JSON.stringify(out, null, 2), "utf8");
console.log(JSON.stringify(out, null, 1));
ws.close();
