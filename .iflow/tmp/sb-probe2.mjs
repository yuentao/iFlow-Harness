const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { error: JSON.stringify(r.exceptionDetails).slice(0, 600) };
  return r.result.value;
};
await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Page.navigate", { url: "http://127.0.0.1:8792/" });
await sleep(3500);
console.log("URL", JSON.stringify(await ev(`location.href`)));
console.log("CSS links", JSON.stringify(await ev(`[...document.querySelectorAll('link[rel=stylesheet]')].map(l => l.href)`)));
console.log("Scripts", JSON.stringify(await ev(`[...document.querySelectorAll('script')].map(s => s.src)`)));
console.log("superBoard", JSON.stringify(await ev(`({
  q: !!document.querySelector('.super-board-surface'),
  toggle: !!document.querySelector('button[aria-label="展开子会话看板"]'),
  boardNodes: [...document.querySelectorAll('div')].filter(d => typeof d.className === 'string' && d.className.includes('super-board')).map(d => d.className),
  shadowNodes: [...document.querySelectorAll('div')].filter(d => typeof d.className === 'string' && d.className.includes('shadow-float')).map(d => d.className).slice(0,6)
})`)));
console.log("cssRule", JSON.stringify(await ev(`(() => { const out=[]; for (const ss of document.styleSheets) { try { for (const r of ss.cssRules) { if (r.selectorText && r.selectorText.includes('super-board')) out.push(r.cssText.slice(0,200)); } } catch(e) {} } return out; })()`)));
ws.close();
