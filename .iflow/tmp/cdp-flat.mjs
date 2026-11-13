// Headless Chrome + CDP harness for verifying the Super Agent live-activity
// pane's flat chrome. Throwaway verification script (not part of the product).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9333;
const TARGET = "http://127.0.0.1:8791/";
const ROOT = "j:\\git\\iflow-harness\\.iflow\\super\\worktrees\\实时弹框-flat-彻底化-mwfd1pg7-x";
const OUT = path.join(ROOT, ".iflow", "tmp", "flat-live");
const PROFILE = path.join(ROOT, ".iflow", "tmp", "cdp-profile");

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(PROFILE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
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
  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        "eval threw: " + (res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails)),
      );
    }
    return res.result.value;
  }
  async shot(file) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    const p = path.join(OUT, file);
    fs.writeFileSync(p, Buffer.from(data, "base64"));
    return p;
  }
}

async function waitJsonList() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error("chrome devtools endpoint never came up");
}

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--force-device-scale-factor=1",
    "--window-size=520,800",
    "about:blank",
  ],
  { stdio: "ignore", windowsHide: true },
);

const R = {};
const shots = [];
const note = (k, v) => {
  R[k] = v;
};

try {
  const page = await waitJsonList();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const cdp = new CDP(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 520,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url: TARGET });

  // --- step 1: first paint ---------------------------------------------------
  let booted = false;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const s = await cdp.eval(`
      return { ta: !!document.querySelector('textarea'), len: document.body.innerText.length };
    `);
    if (s.ta && s.len > 40) {
      booted = true;
      break;
    }
  }
  note("step1.boot", {
    pass: booted,
    viewport: await cdp.eval(`return { w: innerWidth, h: innerHeight };`),
  });

  // --- step 2: board expanded ------------------------------------------------
  const before = await cdp.eval(`
    const b = document.querySelector('[aria-label="展开子会话看板"]');
    return b ? b.getAttribute('aria-expanded') : 'missing';
  `);
  if (before !== "true") {
    await cdp.eval(`
      const b = document.querySelector('[aria-label="展开子会话看板"]');
      if (b) b.click();
      return true;
    `);
    await sleep(400);
  }
  const after = await cdp.eval(`
    const b = document.querySelector('[aria-label="展开子会话看板"]');
    return b ? b.getAttribute('aria-expanded') : 'missing';
  `);
  note("step2.board", { autoExpanded: before === "true", ariaExpanded: after, pass: after === "true" });

  // --- step 3: open the child row, then the live pane ------------------------
  const rowClick = await cdp.eval(`
    const board = document.querySelector('.super-board-surface');
    if (!board) return { pass: false, reason: 'no board surface' };
    const b = [...board.querySelectorAll('button')].find(
      (x) => x.getAttribute('aria-expanded') !== null && x.innerText.includes('修复登录跳转'),
    );
    if (!b) return { pass: false, reason: 'row button not found' };
    b.click();
    return { pass: true, text: b.innerText.replace(/\\s+/g, ' ').trim() };
  `);
  await sleep(500);
  const liveClick = await cdp.eval(`
    const board = document.querySelector('.super-board-surface');
    const b = board && [...board.querySelectorAll('button')].find((x) => x.innerText.trim() === '查看实时操作');
    if (!b) return { pass: false, labels: board ? [...board.querySelectorAll('button')].map((x) => x.innerText.trim()).filter(Boolean).slice(0, 40) : [] };
    b.click();
    return { pass: true };
  `);
  await sleep(700);
  const dlg = await cdp.eval(`
    const d = document.querySelector('[role="dialog"][aria-label="子会话实时操作"]');
    if (!d) {
      const any = document.querySelector('[role="dialog"]');
      return { pass: false, anyDialog: any ? any.getAttribute('aria-label') : null };
    }
    return { pass: true, aria: d.getAttribute('aria-label'), heading: d.innerText.split('\\n')[0] };
  `);
  note("step3.dialog", { rowClick, liveClick, dialog: dlg, pass: rowClick.pass && liveClick.pass && dlg.pass });

  // scroll the pane to the top so screenshots show the whole log
  await cdp.eval(`
    const d = document.querySelector('[role="dialog"]');
    const pane = [...d.querySelectorAll('div')].find((el) => {
      const cs = getComputedStyle(el);
      return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
    });
    if (pane) pane.scrollTop = 0;
    return !!pane;
  `);
  await sleep(300);
  shots.push(await cdp.shot("01-dialog.png"));

  // --- step 5a: vertical rhythm ---------------------------------------------
  note(
    "step5a.gaps",
    await cdp.eval(`
      const d = document.querySelector('[role="dialog"]');
      const pane = [...d.querySelectorAll('div')].find((el) => {
        const cs = getComputedStyle(el);
        return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
      });
      if (!pane) return { pass: false, reason: 'no scroll pane' };
      const stack = pane.firstElementChild;
      const kids = [...stack.children];
      const rects = kids.map((el) => {
        const r = el.getBoundingClientRect();
        const inner = el.firstElementChild;
        return {
          top: +r.top.toFixed(2),
          bottom: +r.bottom.toFixed(2),
          h: +r.height.toFixed(2),
          cls: inner ? inner.className.toString().slice(0, 70) : '',
        };
      });
      const gaps = rects.slice(1).map((r, i) => +(r.top - rects[i].bottom).toFixed(2));
      return {
        pass: gaps.length > 0 && gaps.every((g) => Math.abs(g - 8) <= 1),
        blockCount: kids.length,
        gaps,
        rects,
        stackClass: stack.className.toString(),
        pane: { scrollTop: pane.scrollTop, scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight },
      };
    `),
  );

  // --- step 5b: flat card surface -------------------------------------------
  note(
    "step5b.flatCards",
    await cdp.eval(`
      const d = document.querySelector('[role="dialog"]');
      const cards = [...d.querySelectorAll('.tool-card-flat')];
      const pane = [...d.querySelectorAll('div')].find((el) => {
        const cs = getComputedStyle(el);
        return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
      });
      const paneBg = pane ? getComputedStyle(pane).backgroundColor : null;
      const rows = cards.map((el) => {
        const cs = getComputedStyle(el);
        const before = getComputedStyle(el, '::before');
        const header = el.firstElementChild;
        const hs = getComputedStyle(header);
        return {
          cls: el.className.toString().slice(0, 110),
          pseudoBefore: { content: before.content, backgroundImage: before.backgroundImage.slice(0, 90), animation: before.animationName },
          borderWidth: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
          backgroundColor: cs.backgroundColor,
          backgroundImage: cs.backgroundImage,
          boxShadow: cs.boxShadow,
          borderRadius: cs.borderRadius,
          headerPadLeft: hs.paddingLeft,
          headerPadTop: hs.paddingTop,
          headerPadBottom: hs.paddingBottom,
        };
      });
      const pass = rows.length > 0 && rows.every(
        (r) =>
          r.borderWidth.every((w) => parseFloat(w) === 0) &&
          (r.backgroundColor === 'rgba(0, 0, 0, 0)' || r.backgroundColor === 'transparent') &&
          r.backgroundImage === 'none' &&
          r.boxShadow === 'none' &&
          Math.abs(parseFloat(r.headerPadLeft) - 8) <= 1,
      );
      return { pass, count: rows.length, paneBg, rows };
    `),
  );

  // --- step 5c: main-transcript-only affordances ----------------------------
  note(
    "step5c.affordances",
    await cdp.eval(`
      const d = document.querySelector('[role="dialog"]');
      const btns = [...d.querySelectorAll('button')].map((b) => ({
        label: b.getAttribute('aria-label'),
        title: b.getAttribute('title'),
        text: b.innerText.replace(/\\s+/g, ' ').trim(),
      }));
      const needle = ['在终端中打开', '在集成终端重跑', '回退此改动', '文件对比', '复制全部', '查看完整输出', '保留此改动'];
      const hits = [];
      for (const b of btns) {
        const hay = [b.label, b.title, b.text].filter(Boolean).join(' | ');
        for (const n of needle) if (hay.includes(n)) hits.push({ needle: n, hay });
        if (/改动\\s*\\d+\\s*\\//.test(b.text)) hits.push({ needle: 'hunk pager', hay: b.text });
      }
      const allText = d.innerText;
      const textHits = needle.filter((n) => allText.includes(n));
      return {
        pass: hits.length === 0 && textHits.length === 0,
        hits,
        textHits,
        buttons: btns.map((b) => b.text || b.label || b.title).filter(Boolean),
      };
    `),
  );

  // --- step 5d: raw params pre ---------------------------------------------
  const rawClick = await cdp.eval(`
    const d = document.querySelector('[role="dialog"]');
    const b = [...d.querySelectorAll('button')].find((x) => x.innerText.includes('查看原始参数'));
    if (!b) return { pass: false };
    b.click();
    return { pass: true };
  `);
  await sleep(500);
  note(
    "step5d.rawParams",
    await cdp.eval(`
      const d = document.querySelector('[role="dialog"]');
      const pres = [...d.querySelectorAll('.tool-card-raw')];
      const rows = pres.map((el) => {
        const cs = getComputedStyle(el);
        return {
          borderWidth: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
          borderRadius: cs.borderRadius,
          backgroundColor: cs.backgroundColor,
          paddingLeft: cs.paddingLeft,
          h: +el.getBoundingClientRect().height.toFixed(1),
        };
      });
      const pass = rows.length > 0 && rows.every(
        (r) => r.borderWidth.every((w) => parseFloat(w) === 0) && parseFloat(r.borderRadius) === 0 &&
          (r.backgroundColor === 'rgba(0, 0, 0, 0)' || r.backgroundColor === 'transparent') &&
          Math.abs(parseFloat(r.paddingLeft) - 8) <= 1,
      );
      return { pass, click: ${JSON.stringify(rawClick)}, count: rows.length, rows };
    `),
  );
  await cdp.eval(`
    const d = document.querySelector('[role="dialog"]');
    const el = [...d.querySelectorAll('.tool-card-raw')].pop();
    if (el) el.scrollIntoView({ block: 'center' });
    return !!el;
  `);
  await sleep(300);
  shots.push(await cdp.shot("02-raw-params.png"));

  // --- step 5e: output pre (completed command) ------------------------------
  const outClick = await cdp.eval(`
    const d = document.querySelector('[role="dialog"]');
    const b = [...d.querySelectorAll('button')].find((x) => x.innerText.trim().startsWith('操作输出'));
    if (!b) return { pass: false };
    b.click();
    return { pass: true };
  `);
  await sleep(500);
  note(
    "step5e.output",
    await cdp.eval(`
      const d = document.querySelector('[role="dialog"]');
      const pres = [...d.querySelectorAll('.tool-card-flat pre')].filter((p) => !p.classList.contains('tool-card-raw'));
      const rows = pres.map((el) => {
        const cs = getComputedStyle(el);
        return {
          borderWidth: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
          borderRadius: cs.borderRadius,
          backgroundColor: cs.backgroundColor,
          paddingLeft: cs.paddingLeft,
          h: +el.getBoundingClientRect().height.toFixed(1),
          head: el.innerText.slice(0, 24).replace(/\\n/g, ' / '),
        };
      });
      const pass = rows.length > 0 && rows.every(
        (r) => r.borderWidth.every((w) => parseFloat(w) === 0) && parseFloat(r.borderRadius) === 0 &&
          (r.backgroundColor === 'rgba(0, 0, 0, 0)' || r.backgroundColor === 'transparent'),
      );
      return { pass, click: ${JSON.stringify(outClick)}, count: rows.length, rows };
    `),
  );
  await cdp.eval(`
    const d = document.querySelector('[role="dialog"]');
    const el = [...d.querySelectorAll('.tool-card-flat pre')].filter((p) => !p.classList.contains('tool-card-raw')).pop();
    if (el) el.scrollIntoView({ block: 'center' });
    return !!el;
  `);
  await sleep(300);
  shots.push(await cdp.shot("03-output.png"));

  // --- step 5f: thought body ------------------------------------------------
  const thoughtClick = await cdp.eval(`
    const d = document.querySelector('[role="dialog"]');
    const b = [...d.querySelectorAll('button')].find((x) => x.innerText.trim().startsWith('思考过程'));
    if (!b) return { pass: false, reason: 'no thought toggle' };
    const body = d.querySelector('.thought-body');
    const visible = body ? body.getBoundingClientRect().height > 0 : false;
    if (!visible) b.click();
    return { pass: true, wasOpen: visible };
  `);
  await sleep(500);
  note(
    "step5f.thought",
    await cdp.eval(`
      const d = document.querySelector('[role="dialog"]');
      const body = d.querySelector('.thought-body');
      if (!body) return { pass: false, reason: 'no thought body' };
      const cs = getComputedStyle(body);
      const host = body.parentElement;
      const hs = getComputedStyle(host);
      const wrap = host.parentElement;
      const ws2 = getComputedStyle(wrap);
      return {
        pass:
          parseFloat(cs.borderTopWidth) === 0 &&
          (cs.backgroundColor === 'rgba(0, 0, 0, 0)' || cs.backgroundColor === 'transparent') &&
          (hs.backgroundColor === 'rgba(0, 0, 0, 0)' || hs.backgroundColor === 'transparent') &&
          (ws2.backgroundColor === 'rgba(0, 0, 0, 0)' || ws2.backgroundColor === 'transparent') &&
          parseFloat(ws2.borderTopWidth) === 0,
        click: ${JSON.stringify(thoughtClick)},
        body: {
          borderTopWidth: cs.borderTopWidth,
          backgroundColor: cs.backgroundColor,
          paddingLeft: cs.paddingLeft,
          paddingTop: cs.paddingTop,
          height: +body.getBoundingClientRect().height.toFixed(1),
        },
        collapseHost: { backgroundColor: hs.backgroundColor, borderTopWidth: hs.borderTopWidth },
        cardWrap: {
          backgroundColor: ws2.backgroundColor,
          borderTopWidth: ws2.borderTopWidth,
          borderRadius: ws2.borderRadius,
          boxShadow: ws2.boxShadow,
        },
      };
    `),
  );
  await cdp.eval(`
    const d = document.querySelector('[role="dialog"]');
    const el = d.querySelector('.thought-body');
    if (el) el.scrollIntoView({ block: 'center' });
    return !!el;
  `);
  await sleep(300);
  shots.push(await cdp.shot("04-thought.png"));

  // --- step 5g: narrow viewport --------------------------------------------
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(500);
  await cdp.eval(`
    const d = document.querySelector('[role="dialog"]');
    const pane = [...d.querySelectorAll('div')].find((el) => {
      const cs = getComputedStyle(el);
      return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
    });
    if (pane) pane.scrollTop = 0;
    return !!pane;
  `);
  await sleep(300);
  shots.push(await cdp.shot("05-narrow.png"));
  note(
    "step5g.narrow",
    await cdp.eval(`
      const d = document.querySelector('[role="dialog"]');
      const pane = [...d.querySelectorAll('div')].find((el) => {
        const cs = getComputedStyle(el);
        return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
      });
      const paneRect = pane.getBoundingClientRect();
      const headers = [...d.querySelectorAll('.tool-card-flat')].map((card) => {
        const header = card.firstElementChild;
        const status = header.lastElementChild;
        const sr = status.getBoundingClientRect();
        return {
          label: (header.children[1] ? header.children[1].innerText : '').slice(0, 20),
          statusText: status.innerText.replace(/\\s+/g, ' ').trim(),
          statusRight: +sr.right.toFixed(1),
          paneRight: +paneRect.right.toFixed(1),
          inside: sr.right <= paneRect.right + 0.5 && sr.left >= paneRect.left - 0.5,
          clipped: status.scrollWidth > status.clientWidth + 1,
          headerScroll: header.scrollWidth,
          headerClient: header.clientWidth,
        };
      });
      return {
        pass:
          pane.scrollWidth <= pane.clientWidth + 1 &&
          headers.every((h) => h.inside && !h.clipped && h.headerScroll <= h.headerClient + 1),
        pane: {
          scrollWidth: pane.scrollWidth,
          clientWidth: pane.clientWidth,
          scrollHeight: pane.scrollHeight,
          clientHeight: pane.clientHeight,
        },
        viewport: { w: innerWidth, h: innerHeight },
        bodyScroll: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
        headers,
      };
    `),
  );

  // --- step 6: main transcript still uses card chrome ----------------------
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 520,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(300);
  const closeClick = await cdp.eval(`
    const d = document.querySelector('[role="dialog"][aria-label="子会话实时操作"]');
    const b = d && [...d.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '收起');
    if (!b) return { pass: false, labels: d ? [...d.querySelectorAll('button')].map((x) => x.getAttribute('aria-label')).filter(Boolean) : [] };
    b.click();
    return { pass: true };
  `);
  await sleep(500);
  note(
    "step6.mainCard",
    await cdp.eval(`
      const dlgGone = !document.querySelector('[role="dialog"][aria-label="子会话实时操作"]');
      const cards = [...document.querySelectorAll('.tool-card:not(.tool-card-flat)')];
      const rows = cards.slice(0, 6).map((el) => {
        const cs = getComputedStyle(el);
        return {
          cls: el.className.toString().slice(0, 90),
          backgroundColor: cs.backgroundColor,
          boxShadow: cs.boxShadow !== 'none',
          borderRadius: cs.borderRadius,
          borderWidth: cs.borderTopWidth,
        };
      });
      const terminalBtns = [...document.querySelectorAll('button')].filter((b) =>
        (b.getAttribute('aria-label') || '').includes('在终端中打开'),
      ).length;
      return {
        pass:
          dlgGone &&
          rows.length > 0 &&
          rows.every(
            (r) =>
              r.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
              r.boxShadow &&
              parseFloat(r.borderRadius) > 0 &&
              parseFloat(r.borderWidth) > 0,
          ) &&
          terminalBtns > 0,
        close: ${JSON.stringify(closeClick)},
        dialogClosed: dlgGone,
        cardCount: rows.length,
        cards: rows,
        terminalOpenButtons: terminalBtns,
      };
    `),
  );
  await cdp.eval(`
    const card = document.querySelector('.tool-card:not(.tool-card-flat)');
    if (card) card.scrollIntoView({ block: 'center' });
    return !!card;
  `);
  await sleep(400);
  shots.push(await cdp.shot("06-main-card.png"));

  note("shots", shots);
  console.log(JSON.stringify(R, null, 2));
  ws.close();
} catch (err) {
  console.error("FATAL:", err?.stack ?? err);
  console.log(JSON.stringify(R, null, 2));
  process.exitCode = 1;
} finally {
  await sleep(200);
  try {
    spawn("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } catch {
    /* ignore */
  }
}