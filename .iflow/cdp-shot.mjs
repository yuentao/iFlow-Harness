/**
 * 临时验收脚本（不属于产品代码）：用真实 Chromium (CDP) 打开 mock webview，
 * 走「设置 → QQ 机器人 → 访问控制」，截 500/360 两档默认态、编辑态、删除确认，
 * 并取回真实 DOM 数值。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CDP_BIN || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9333);
const URL_APP = "http://127.0.0.1:8792/";
const OUT_DIR = path.resolve(".iflow/screens");
const USER_DIR = path.join(os.tmpdir(), `iflow-cdp-${Date.now()}`);

fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--hide-scrollbars=false",
    "--force-device-scale-factor=1",
    "about:blank",
  ],
  { stdio: "ignore", detachment: true },
);
proc.unref();

async function getTarget() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error("CDP target not found");
}

const target = await getTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("ws error"));
});

let seq = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
    return;
  }
  if (msg.method === "Runtime.exceptionThrown") {
    consoleErrors.push(msg.params?.exceptionDetails?.text ?? "exception");
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
    consoleErrors.push(
      (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200),
    );
  }
};

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const out = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (out.exceptionDetails) {
    throw new Error(`eval failed: ${out.exceptionDetails.text} ${JSON.stringify(out.exceptionDetails.exception?.description ?? "")}`);
  }
  return out.result.value;
}

async function waitFor(expression, label, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await evaluate(expression)) return true;
    } catch {
      /* keep polling */
    }
    await sleep(120);
  }
  throw new Error(`waitFor timeout: ${label}`);
}

async function setViewport(width, height = 800) {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: width,
    screenHeight: height,
  });
  await sleep(250);
}

async function shot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  report.probes = report.probes || {};
  report.probes[name] = await evaluate(`
    (() => {
      const group = [...document.querySelectorAll('section')].find((s) => {
        const h = s.querySelector('h3');
        return h && h.textContent.trim() === '访问控制';
      });
      const h3 = group ? group.querySelector('h3') : null;
      let sc = group && group.parentElement;
      while (sc && !(sc.scrollHeight > sc.clientHeight + 4)) sc = sc.parentElement;
      const rectOf = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { y: +b.y.toFixed(1), h: +b.height.toFixed(1), bottom: +b.bottom.toFixed(1) }; };
      return {
        windowScrollY: window.scrollY,
        scroller: sc ? { tag: sc.tagName, cls: (sc.className || '').toString().slice(0, 60), scrollTop: Math.round(sc.scrollTop), rect: rectOf(sc) } : null,
        titleRect: rectOf(h3),
        tableRect: rectOf(group ? group.querySelector('table') : null),
        atTitle: (() => { if (!h3) return null; const b = h3.getBoundingClientRect(); const el = document.elementFromPoint(Math.min(window.innerWidth - 2, b.x + 8), Math.min(window.innerHeight - 2, b.y + b.height / 2)); return el ? (el.tagName + ':' + (el.textContent || '').trim().slice(0, 24)) : null; })(),
      };
    })()
  `);
  return file;
}

// ---- measurement helpers (run inside the page) -----------------------------
const MEASURE_FN = `
(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), right: +b.right.toFixed(1), bottom: +b.bottom.toFixed(1) }; };
  const tables = [...document.querySelectorAll('table[aria-label]')];
  const table = tables.find((t) => t.getAttribute('aria-label').includes('用户')) || tables[0];
  const group = [...document.querySelectorAll('section')].find((s) => {
    const h = s.querySelector('h3');
    return h && h.textContent.trim() === '访问控制';
  });
  const h3 = group ? group.querySelector('h3') : null;
  const hs = h3 ? getComputedStyle(h3) : null;
  const row = table ? table.querySelector('tbody tr') : null;
  const cells = row ? [...row.children] : [];
  const noteEl = cells[0] ? cells[0].querySelector('span') : null;
  const idEl = cells[0] ? cells[0].querySelector('span[class*="font-mono"]') : null;
  const idStyle = idEl ? getComputedStyle(idEl) : null;
  const btns = cells[1] ? [...cells[1].querySelectorAll('button')] : [];
  const input = document.querySelector('table input[aria-label^="备注"]');
  // 背景转录里也有 role="alertdialog" 的提问卡，必须按标题精确定位本次的删除确认。
  const dialog = [...document.querySelectorAll('[role="alertdialog"]')].find((d) => (d.textContent || '').includes('删除条目')) || null;
  const modalShell = dialog;
  const viewport = { w: window.innerWidth, h: window.innerHeight };
  return {
    viewport,
    docScrollWidth: document.documentElement.scrollWidth,
    docClientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 0.5,
    table: table ? { label: table.getAttribute('aria-label'), className: table.className, rect: r(table) } : null,
    thWidths: table ? [...table.querySelectorAll('thead th')].map((th) => ({ text: th.textContent.trim(), w: +th.getBoundingClientRect().width.toFixed(1) })) : [],
    firstRow: {
      noteText: noteEl ? noteEl.textContent.trim() : null,
      maskedText: idEl ? idEl.textContent.trim() : null,
      maskedHasTail4: idEl ? idEl.textContent.includes('8D11') : null,
      maskedRect: r(idEl),
      maskedScrollWidth: idEl ? idEl.scrollWidth : null,
      maskedClientWidth: idEl ? idEl.clientWidth : null,
      maskedScrollHeight: idEl ? idEl.scrollHeight : null,
      maskedClientHeight: idEl ? idEl.clientHeight : null,
      maskedLineHeight: idStyle ? idStyle.lineHeight : null,
      maskedFontSize: idStyle ? idStyle.fontSize : null,
      maskedWhiteSpace: idStyle ? idStyle.whiteSpace : null,
      maskedOverflowX: idEl ? idEl.scrollWidth > idEl.clientWidth + 0.5 : null,
      noteLines: noteEl ? Math.round(noteEl.getBoundingClientRect().height / parseFloat(getComputedStyle(noteEl).lineHeight || '16')) : null,
    },
    actionButtons: btns.map((b) => ({ label: b.getAttribute('aria-label'), rect: r(b) })),
    actionMaxRight: btns.length ? Math.max(...btns.map((b) => b.getBoundingClientRect().right)) : null,
    actionInsideViewport: btns.length ? btns.every((b) => b.getBoundingClientRect().right <= window.innerWidth + 0.5) : null,
    groupTitle: h3 ? {
      text: h3.textContent.trim(),
      rect: r(h3),
      lineHeight: hs.lineHeight,
      fontSize: hs.fontSize,
      scrollHeight: h3.scrollHeight,
      clientHeight: h3.clientHeight,
      lines: Math.round(h3.getBoundingClientRect().height / parseFloat(hs.lineHeight || '20')),
    } : null,
    groupHint: (() => {
      const hintEl = h3 && h3.parentElement ? h3.parentElement.querySelector('span') : null;
      return hintEl ? { text: hintEl.textContent.trim(), rect: r(hintEl), belowTitle: h3 ? hintEl.getBoundingClientRect().top >= h3.getBoundingClientRect().bottom - 0.5 : null } : null;
    })(),
    editInput: input ? {
      rect: r(input),
      ariaLabel: input.getAttribute('aria-label'),
      value: input.value,
      fontSize: getComputedStyle(input).fontSize,
    } : null,
    dialog: modalShell ? (() => {
      const panel = modalShell.firstElementChild || modalShell;
      const rect = r(panel);
      const clippedBy = [];
      for (let el = panel.parentElement; el; el = el.parentElement) {
        const cs = getComputedStyle(el);
        if (cs.overflow === 'visible' && cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const b = el.getBoundingClientRect();
        const clipped = b.left > rect.x + 0.5 || b.top > rect.y + 0.5 || b.right < rect.right - 0.5 || b.bottom < rect.bottom - 0.5;
        if (clipped) clippedBy.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 80), overflow: cs.overflow, rect: r(el) });
      }
      return {
        role: modalShell.getAttribute('role'),
        ariaLabel: modalShell.getAttribute('aria-label'),
        backdropRect: r(modalShell),
        rect,
        insideViewport: rect.x >= -0.5 && rect.y >= -0.5 && rect.right <= window.innerWidth + 0.5 && rect.bottom <= window.innerHeight + 0.5,
        clipped: clippedBy.length > 0,
        clippedBy,
        text: (modalShell.textContent || '').replace(/\\s+/g, ' ').slice(0, 120),
      };
    })() : null,
    settingsModal: (() => {
      const d = document.querySelector('[role="dialog"][aria-label="设置"]') || document.querySelector('[role="dialog"]');
      if (!d) return null;
      const panel = d.firstElementChild || d;
      const rect = r(panel);
      const tableRect = table ? r(table) : null;
      return {
        ariaLabel: d.getAttribute('aria-label'),
        rect,
        insideViewport: rect.x >= -0.5 && rect.y >= -0.5 && rect.right <= window.innerWidth + 0.5 && rect.bottom <= window.innerHeight + 0.5,
        contentColumnWidth: tableRect ? tableRect.w : null,
      };
    })(),
  };
})()
`;

async function scrollAccessIntoView(mode = "title") {
  const r = await evaluate(`
    (() => {
      const wantTable = ${JSON.stringify(mode === "table")};
      const group = [...document.querySelectorAll('section')].find((s) => {
        const h = s.querySelector('h3');
        return h && h.textContent.trim() === '访问控制';
      });
      if (!group) return 'no-group';
      let sc = group.parentElement;
      while (sc) {
        const cs = getComputedStyle(sc);
        const scrollable = sc.scrollHeight > sc.clientHeight + 4 && (cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowY === 'overlay');
        if (scrollable) break;
        sc = sc.parentElement;
      }
      if (!sc) { group.scrollIntoView({ block: 'start' }); return 'window'; }
      // scroll-behavior: smooth 会把 scrollTop 赋值变成动画（测量时在滚动中、截图时已过界）。
      sc.style.scrollBehavior = 'auto';
      sc.scrollTop += group.getBoundingClientRect().top - sc.getBoundingClientRect().top - 8;
      const table = group.querySelector('table');
      if (wantTable && table) {
        const scRect = sc.getBoundingClientRect();
        const tRect = table.getBoundingClientRect();
        if (tRect.bottom > scRect.bottom - 6) {
          sc.scrollTop += Math.min(tRect.bottom - (scRect.bottom - 10), tRect.top - scRect.top - 8);
        }
      }
      return { scrollTop: sc.scrollTop, clientHeight: sc.clientHeight, scrollHeight: sc.scrollHeight };
    })()
  `);
  await sleep(350);
  return r;
}

async function clickByText(selector, text) {
  return evaluate(`
    (() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const el = els.find((e) => (e.textContent || '').trim() === ${JSON.stringify(text)} || e.getAttribute('aria-label') === ${JSON.stringify(text)});
      if (!el) return 'not-found';
      el.click();
      return 'clicked';
    })()
  `);
}

// ---- run -------------------------------------------------------------------
const report = { steps: [], measures: {}, consoleErrors };
const log = (k, v) => {
  report.steps.push({ step: k, ok: v });
};

await send("Page.enable");
await send("Runtime.enable");
await setViewport(500, 800);
await send("Page.navigate", { url: URL_APP });
await waitFor(`!!document.querySelector('button[aria-label="设置"]')`, "app ready");
log("app-ready", true);

// open settings
await evaluate(`document.querySelector('button[aria-label="设置"]').click()`);
await waitFor(`!!document.querySelector('#settings-tab-qq')`, "settings modal");
log("settings-open", true);

await evaluate(`document.querySelector('#settings-tab-qq').click()`);
await waitFor(`!!document.querySelector('table[aria-label="允许的用户"]')`, "qq access table");
log("qq-tab", true);

// ---- 500 default ----
await setViewport(500, 800);
await scrollAccessIntoView();
report.measures.w500 = await evaluate(MEASURE_FN);
report.files = report.files || {};
report.files.default500 = path.relative(process.cwd(), await shot("qq-access-default-500.png"));

// ---- 360 default ----
// 360 下设置导航占 312px，内容可滚动区只有 224px：标题与整表无法同框。
// 主图取「整表入框」（证明两列 + 三条脱敏尾部 + 按钮不出界），
// 另存一张「标题优先」的补充图证明标题/提示上下排版。
await setViewport(360, 800);
await sleep(200);
await scrollAccessIntoView("table");
report.measures.w360 = await evaluate(MEASURE_FN);
report.files.default360 = path.relative(process.cwd(), await shot("qq-access-default-360.png"));

await scrollAccessIntoView("title");
report.files.section360 = path.relative(process.cwd(), await shot("qq-access-section-360.png"));

// ---- 500 edit ----
await setViewport(500, 800);
await sleep(200);
await scrollAccessIntoView();
const editClick = await evaluate(`
  (() => {
    const table = document.querySelector('table[aria-label="允许的用户"]');
    const btn = table.querySelector('tbody tr button[aria-label^="编辑"]');
    if (!btn) return 'no-edit-btn';
    btn.click();
    return btn.getAttribute('aria-label');
  })()
`);
await sleep(350);
await scrollAccessIntoView();
report.measures.edit500 = await evaluate(MEASURE_FN);
report.files.edit500 = path.relative(process.cwd(), await shot("qq-access-edit-500.png"));
log("edit-click", editClick);

// ---- 360 edit ----
await setViewport(360, 800);
await sleep(200);
await scrollAccessIntoView("table");
report.measures.edit360 = await evaluate(MEASURE_FN);
report.files.edit360 = path.relative(process.cwd(), await shot("qq-access-edit-360.png"));

// cancel edit, then delete confirm at 500
await evaluate(`
  (() => {
    const btn = [...document.querySelectorAll('table[aria-label="允许的用户"] tbody button')].find((b) => b.getAttribute('aria-label') === '取消');
    if (btn) btn.click();
    return !!btn;
  })()
`);
await sleep(250);
await setViewport(500, 800);
await sleep(200);
await scrollAccessIntoView();
const delClick = await evaluate(`
  (() => {
    const table = document.querySelector('table[aria-label="允许的用户"]');
    const btn = table.querySelector('tbody tr button[aria-label^="删除"]');
    if (!btn) return 'no-delete-btn';
    btn.click();
    return btn.getAttribute('aria-label');
  })()
`);
await waitFor(`!!document.querySelector('[role="alertdialog"]')`, "delete confirm");
await sleep(300);
report.measures.deleteDialog = await evaluate(MEASURE_FN);
report.files.deleteConfirm500 = path.relative(process.cwd(), await shot("qq-access-delete-confirm-500.png"));
log("delete-click", delClick);

fs.writeFileSync(path.join(OUT_DIR, "qq-access-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await send("Browser.close").catch(() => {});
ws.close();
process.exit(0);
