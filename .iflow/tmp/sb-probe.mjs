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
console.log(JSON.stringify(await ev(`({url: location.href, title: document.title, bodyLen: document.body.innerHTML.length})`)));
console.log(JSON.stringify(await ev(`document.body.innerHTML.slice(0, 1200)`)));
console.log(JSON.stringify(await ev(`({
  hasBoard: !!document.querySelector('.super-board-surface'),
  classes: [...document.querySelectorAll('[class]')].slice(0,0).length,
  boardLike: [...document.querySelectorAll('div')].filter(d => (d.className||'').toString().includes('board')).map(d => (d.className||'').toString()).slice(0,10),
  messageScroll: !!document.querySelector('.message-scroll'),
  buttons: [...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || (b.textContent||'').trim().slice(0,20)).slice(0,40)
})`)));
console.log(JSON.stringify(await ev(`(async () => { await new Promise(r=>setTimeout(r,3000)); return { hasBoard: !!document.querySelector('.super-board-surface'), html: document.body.innerHTML.length }; })()`)));
console.log(JSON.stringify(await ev(`({ hasBoard: !!document.querySelector('.super-board-surface'), allClasses: [...new Set([...document.querySelectorAll('*')].flatMap(e => [...e.classList]))].filter(c => c.includes('super') || c.includes('board')).slice(0,20) })`)));
ws.close();
