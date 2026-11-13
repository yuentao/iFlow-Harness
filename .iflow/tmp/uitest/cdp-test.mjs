/**
 * Read-only browser verification for the mock webview (http://127.0.0.1:8791).
 * Drives headless Chrome over CDP, asserts DOM facts, saves screenshots.
 * Writes a JSON report next to the screenshots. No source files are touched.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const BASE = path.join(ROOT, ".iflow", "tmp", "uitest");
const OUT_DIR = path.join(BASE, "shots");
const PROFILE_DIR = path.join(BASE, "profile");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9333;
const PAGE_URL = "http://127.0.0.1:8791/";

fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOOK = `(() => {
  const orig = window.dispatchEvent;
  window.__lastSnapshot = null;
  window.__snapshotCount = 0;
  window.dispatchEvent = function (ev) {
    try {
      if (ev && ev.type === 'message' && ev.data && ev.data.type === 'snapshot') {
        window.__lastSnapshot = ev.data;
        window.__snapshotCount++;
      }
    } catch (e) {}
    return orig.call(this, ev);
  };
})();`;

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    "--window-size=1280,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);

let ws;
let msgId = 0;
const pending = new Map();

function cmd(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 60000);
  });
}

async function evaluate(expression) {
  const r = await cmd("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      `eval failed: ${JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails)}`,
    );
  }
  return r.result.value;
}

async function waitFor(expression, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return true;
    } catch {
      /* page still booting */
    }
    await sleep(150);
  }
  throw new Error(`waitFor timeout: ${label}`);
}

async function shot(name) {
  const r = await cmd("Page.captureScreenshot", { format: "png" });
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  return file;
}

async function shotRect(name, rect) {
  const r = await cmd("Page.captureScreenshot", {
    format: "png",
    clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
  });
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  return file;
}

const results = [];
function record(id, title, ok, details, shots = []) {
  results.push({ id, title, ok, details, shots });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${title}`);
  console.log(JSON.stringify(details, null, 2));
}

const CLICK_BY_TITLE = (title) => `(() => {
  const el = [...document.querySelectorAll('button')].find(
    (b) => b.getAttribute('title') === ${JSON.stringify(title)},
  );
  if (!el) return { clicked: false, reason: 'not found' };
  el.click();
  return { clicked: true, disabled: el.disabled === true };
})()`;

const CLICK_BY_TEXT = (text, scope = "document") => `(() => {
  const root = ${scope};
  if (!root) return { clicked: false, reason: 'no scope' };
  const el = [...root.querySelectorAll('button')].find(
    (b) => (b.textContent || '').includes(${JSON.stringify(text)}),
  );
  if (!el) return { clicked: false, reason: 'not found' };
  el.click();
  return { clicked: true, disabled: el.disabled === true };
})()`;

const CLICK_BY_ARIA = (label) => `(() => {
  const el = document.querySelector('button[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']');
  if (!el) return { clicked: false, reason: 'not found' };
  el.click();
  return { clicked: true, disabled: el.disabled === true };
})()`;

async function main() {
  // ---- boot chrome ----
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(200);
    if (i === 119) throw new Error("Chrome DevTools endpoint never came up");
  }
  const target = await (
    await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })
  ).json();

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });

  await cmd("Page.enable");
  await cmd("Runtime.enable");
  await cmd("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cmd("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
  await cmd("Page.navigate", { url: PAGE_URL });

  await waitFor(
    `document.readyState === 'complete' && document.body.innerText.includes('子会话')`,
    "app rendered",
  );
  await waitFor(`window.__lastSnapshot !== null`, "snapshot captured");
  await sleep(700);

  const boot = await evaluate(`({
    title: document.title,
    hasBoard: !!document.querySelector('[aria-label="展开子会话看板"]'),
    snapshotCount: window.__snapshotCount,
    bodyLen: document.body.innerText.length,
  })`);

  // The demo snapshot ships with a pending question card (role=alertdialog).
  // It overlays the board and would be picked up by every dialog lookup, so
  // dismiss it up front exactly like a user would ("不回答并继续").
  const questionDismiss = await evaluate(`(() => {
    const card = [...document.querySelectorAll('[role="alertdialog"]')].find(
      (d) => (d.textContent || '').includes('iFlow 需要你的回答'),
    );
    if (!card) return { present: false };
    const btn = [...card.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '不回答并继续');
    if (!btn) return { present: true, dismissed: false, buttons: [...card.querySelectorAll('button')].map((b) => (b.textContent || '').trim()) };
    btn.click();
    return { present: true, dismissed: true };
  })()`);
  if (questionDismiss.dismissed) {
    await waitFor(
      `![...document.querySelectorAll('[role="alertdialog"]')].some((d) => (d.textContent || '').includes('iFlow 需要你的回答'))`,
      "question card dismissed",
      8000,
    );
  }
  await sleep(300);

  // The demo also carries a pending tool approval. It is a *different* lock
  // (pending interaction) and would keep the model dropdown disabled even
  // after every child is terminal, so reject it up front.
  const approvalDismiss = await evaluate(`(() => {
    const card = [...document.querySelectorAll('[role="alertdialog"]')].find(
      (d) => !(d.textContent || '').includes('iFlow 需要你的回答'),
    );
    if (!card) return { present: false };
    const btn = [...card.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '拒绝');
    if (!btn) return { present: true, dismissed: false, buttons: [...card.querySelectorAll('button')].map((b) => (b.textContent || '').trim()) };
    btn.click();
    return { present: true, dismissed: true };
  })()`);
  await sleep(600);

  // =====================================================================
  // 2) 主会话委派块 → 每任务一张卡片，无整段 JSON
  // =====================================================================
  const t2 = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('[data-testid="super-task-card"]')];
    const titles = cards.map((c) => {
      const head = c.querySelector('span.text-ui-body');
      return head ? head.textContent.trim() : '';
    });
    const seqChips = cards.map((c) => {
      const chip = [...c.querySelectorAll('span')].find((s) => /第 \\d+\\/\\d+ 个任务/.test(s.textContent || ''));
      return chip ? chip.textContent.trim() : null;
    });
    const superFences = [...document.querySelectorAll('pre code')].filter((c) =>
      /language-super-agent/.test(c.className || ''),
    );
    const bodyText = document.body.innerText;
    return {
      cardCount: cards.length,
      titles,
      seqChips,
      superAgentCodeBlocks: superFences.length,
      bodyHasJsonTasks: bodyText.includes('"tasks": ['),
      bodyHasSuperFenceWord: bodyText.includes('super-agent'),
    };
  })()`);

  // The board floats over the transcript; collapse it and scroll the cards
  // into view so the screenshot shows the cards themselves.
  await evaluate(`(() => {
    const btn = document.querySelector('[aria-label="展开子会话看板"]');
    if (btn && btn.getAttribute('aria-expanded') === 'true') btn.click();
    return true;
  })()`);
  await sleep(350);
  await evaluate(`(() => {
    const card = document.querySelector('[data-testid="super-task-card"]');
    if (!card) return false;
    card.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await sleep(500);

  const shotT2 = await shot("02-delegation-cards.png");
  const boardRectT2 = await evaluate(`(() => {
    const cards = document.querySelectorAll('[data-testid="super-task-card"]');
    const first = cards[0], last = cards[cards.length - 1];
    if (!first || !last) return null;
    const a = first.getBoundingClientRect(), b = last.getBoundingClientRect();
    return { x: Math.max(0, a.x - 8), y: Math.max(0, a.y - 8), width: Math.min(window.innerWidth, a.width + 16), height: Math.min(window.innerHeight, b.bottom - a.top + 16) };
  })()`);
  const shotT2b = boardRectT2
    ? await shotRect("02b-delegation-cards-closeup.png", boardRectT2)
    : null;

  // Second framing: the single-task + indented-fence cards live further down.
  await evaluate(`(() => {
    const cards = document.querySelectorAll('[data-testid="super-task-card"]');
    const last = cards[cards.length - 1];
    if (last) last.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await sleep(400);
  const shotT2c = await shot("02c-single-task-cards.png");

  record(
    "2",
    "主会话委派块按任务拆分卡片，不出现整段 JSON",
    t2.cardCount === 5 &&
      t2.superAgentCodeBlocks === 0 &&
      t2.bodyHasJsonTasks === false &&
      t2.titles.includes("修复登录跳转") &&
      t2.titles.includes("只跑一次 typecheck") &&
      t2.titles.includes("缩进围栏任务"),
    t2,
    [shotT2, shotT2b, shotT2c].filter(Boolean),
  );

  // =====================================================================
  // 1) 子会话展开区时间轴：有 todo 只显示 todo 节点；无 todo 回退阶段轨
  // =====================================================================
  const LONG_TODO =
    "核对 src/panel/panel.ts 里 superActive 的三个使用点（历史会话下拉、设置页 API 配置切换、模型下拉），确认非终态子会话存在时三处都被禁用，而发送按钮不受影响，并把结论连同截图写进汇报里；这条文本刻意写得很长，用来验证时间轴最后一条 todo 在窄屏下完整换行显示、不被裁切或省略号截断";
  const SECOND_TODO = "补 401 回跳单测并跑 npx vitest run test/auth.test.ts";

  // ensure the board is expanded
  await evaluate(`(() => {
    const btn = document.querySelector('[aria-label="展开子会话看板"]');
    if (btn && btn.getAttribute('aria-expanded') === 'false') btn.click();
    return true;
  })()`);
  await sleep(300);

  const injectTodos = await evaluate(`(() => {
    if (!window.__lastSnapshot) return { ok: false, reason: 'no snapshot' };
    const clone = JSON.parse(JSON.stringify(window.__lastSnapshot));
    clone.state.superSessions = clone.state.superSessions.map((s) =>
      s.id === 'super-demo-1'
        ? { ...s, todos: [
            { content: ${JSON.stringify(SECOND_TODO)}, status: 'completed' },
            { content: ${JSON.stringify(LONG_TODO)}, status: 'in_progress', priority: 'high' },
          ] }
        : s,
    );
    window.dispatchEvent(new MessageEvent('message', { data: clone }));
    return { ok: true };
  })()`);
  await sleep(400);

  // open the running child's row
  await evaluate(CLICK_BY_TEXT("修复登录跳转"));
  await sleep(400);

  const t1a = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('button')].filter((b) => (b.textContent || '').includes('修复登录跳转'));
    const rowBtn = rows[0];
    if (!rowBtn) return { error: 'row not found' };
    const rowRoot = rowBtn.closest('div.shrink-0');
    if (!rowRoot) return { error: 'row root not found' };
    const rail = rowRoot.querySelector('[role="img"]');
    if (!rail) return { error: 'timeline rail not found' };
    const labels = [...rail.querySelectorAll('span.font-medium')];
    const items = [...rail.querySelectorAll(':scope > span')].map((node) => ({
      hasDot: !!node.querySelector('span.rounded-full'),
      text: (node.textContent || '').trim(),
    }));
    const last = labels[labels.length - 1];
    const cs = last ? getComputedStyle(last) : null;
    const railRect = rail.getBoundingClientRect();
    const lastRect = last ? last.getBoundingClientRect() : null;
    return {
      ariaLabel: rail.getAttribute('aria-label'),
      nodeCount: items.length,
      items,
      labelTexts: labels.map((l) => l.textContent || ''),
      lastTextLen: last ? (last.textContent || '').length : 0,
      lastScrollWidth: last ? last.scrollWidth : null,
      lastClientWidth: last ? last.clientWidth : null,
      lastNoClip: last ? last.scrollWidth <= last.clientWidth + 1 : false,
      lastTextOverflow: cs ? cs.textOverflow : null,
      lastOverflow: cs ? cs.overflow : null,
      lastRight: lastRect ? lastRect.right : null,
      railRight: railRect.right,
      lastWithinRail: lastRect ? lastRect.right <= railRect.right + 1 : false,
      lastWithinViewport: lastRect ? lastRect.right <= window.innerWidth + 1 : false,
      rowHeight: rowRoot.getBoundingClientRect().height,
    };
  })()`);

  const railRect1 = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('button')].filter((b) => (b.textContent || '').includes('修复登录跳转'));
    const rowRoot = rows[0]?.closest('div.shrink-0');
    if (!rowRoot) return null;
    const r = rowRoot.getBoundingClientRect();
    return { x: Math.max(0, r.x - 6), y: Math.max(0, r.y - 6), width: Math.min(window.innerWidth, r.width + 12), height: r.height + 12 };
  })()`);
  const shotT1a = await shot("01a-timeline-todos.png");
  const shotT1aClose = railRect1 ? await shotRect("01a-timeline-todos-closeup.png", railRect1) : null;
  const railOnlyRect = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('button')].filter((b) => (b.textContent || '').includes('修复登录跳转'));
    const rowRoot = rows[0]?.closest('div.shrink-0');
    const rail = rowRoot ? rowRoot.querySelector('[role="img"]') : null;
    if (!rail) return null;
    const r = rail.getBoundingClientRect();
    return { x: Math.max(0, r.x - 4), y: Math.max(0, r.y - 4), width: Math.min(window.innerWidth, r.width + 8), height: r.height + 8 };
  })()`);
  const shotT1aRail = railOnlyRect
    ? await shotRect("01a-timeline-rail-closeup.png", railOnlyRect)
    : null;

  const todosOk =
    t1a.nodeCount === 2 &&
    t1a.lastTextLen === LONG_TODO.length &&
    t1a.lastNoClip === true &&
    t1a.lastOverflow !== "hidden" &&
    t1a.lastTextOverflow !== "ellipsis" &&
    t1a.lastWithinRail === true &&
    t1a.lastWithinViewport === true &&
    t1a.labelTexts.includes(LONG_TODO) &&
    t1a.labelTexts.includes(SECOND_TODO) &&
    !t1a.labelTexts.includes("派发") &&
    !t1a.labelTexts.includes("启动");

  // restore the original snapshot → stage rail fallback
  await evaluate(`(() => {
    const clone = JSON.parse(JSON.stringify(window.__lastSnapshot));
    // strip the injected todos again (snapshot may have been captured before injection)
    clone.state.superSessions = clone.state.superSessions.map((s) => {
      const { todos, ...rest } = s;
      void todos;
      return rest;
    });
    window.dispatchEvent(new MessageEvent('message', { data: clone }));
    return true;
  })()`);
  await sleep(400);
  const railStillOpen = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('button')].filter((b) => (b.textContent || '').includes('修复登录跳转'));
    const rowRoot = rows[0]?.closest('div.shrink-0');
    return !!(rowRoot && rowRoot.querySelector('[role="img"]'));
  })()`);
  if (!railStillOpen) {
    await evaluate(CLICK_BY_TEXT("修复登录跳转"));
    await sleep(400);
  }

  const t1b = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('button')].filter((b) => (b.textContent || '').includes('修复登录跳转'));
    const rowRoot = rows[0]?.closest('div.shrink-0');
    if (!rowRoot) return { error: 'row not found' };
    const rail = rowRoot.querySelector('[role="img"]');
    if (!rail) return { error: 'timeline rail not found' };
    const labels = [...rail.querySelectorAll('span.font-medium')].map((l) => (l.textContent || '').trim());
    return {
      ariaLabel: rail.getAttribute('aria-label'),
      labels,
      nodeCount: rail.querySelectorAll(':scope > span').length,
      hasDispatched: labels.includes('派发'),
      hasStarted: labels.includes('启动'),
    };
  })()`);

  const shotT1b = await shot("01b-timeline-stage-fallback.png");

  record(
    "1",
    "子会话展开区时间轴：有 todo 只显示 todo 节点、长文本不裁切；无 todo 回退阶段轨",
    todosOk && t1b.hasDispatched === true && t1b.hasStarted === true && t1b.nodeCount >= 2,
    { withTodos: t1a, injected: injectTodos, withoutTodos: t1b, longTodoLen: LONG_TODO.length },
    [shotT1a, shotT1aClose, shotT1aRail, shotT1b].filter(Boolean),
  );

  // =====================================================================
  // 3) 思考块里的委派围栏 → 普通 Markdown / 代码块，不出委派卡
  // =====================================================================
  const THOUGHT_PROBE = "思考里出现委派围栏，这里应当只当普通代码块渲染。";
  const FENCE_TASK_TITLE = "不该出卡的任务";
  await evaluate(`(() => {
    const clone = JSON.parse(JSON.stringify(window.__lastSnapshot));
    const text = ${JSON.stringify(
      `${THOUGHT_PROBE}\n\n\`\`\`super-agent\n{"tasks":[{"title":"${FENCE_TASK_TITLE}","task":"这是思考内容，不是派发。"}]}\n\`\`\``,
    )};
    clone.state.blocks = [
      ...clone.state.blocks,
      { kind: 'thought', id: 'probe-thought-fence', text },
    ];
    window.dispatchEvent(new MessageEvent('message', { data: clone }));
    return true;
  })()`);
  await sleep(500);

  // The thought card auto-collapses 1600ms after it stops being live; wait it
  // out, then open it only if it is really collapsed.
  await sleep(1900);
  const reopenThought = await evaluate(`(() => {
    const body = [...document.querySelectorAll('div')].find(
      (el) => el.className && String(el.className).includes('thought-body') &&
        (el.textContent || '').includes(${JSON.stringify(THOUGHT_PROBE)}),
    );
    if (!body) return { ok: false, reason: 'probe thought body not found' };
    const wrap = body.closest('.collapse-wrap');
    const openBefore = wrap ? wrap.getAttribute('data-open') === 'true' : false;
    if (openBefore) return { ok: true, clicked: false, openBefore };
    let card = body;
    while (card && !card.querySelector(':scope > button')) card = card.parentElement;
    if (!card) return { ok: false, reason: 'no card root' };
    const btn = card.querySelector(':scope > button');
    btn.click();
    return { ok: true, clicked: true, openBefore, headerText: (btn.textContent || '').trim() };
  })()`);
  await sleep(400);

  const t3 = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('[data-testid="super-task-card"]')];
    const titles = cards.map((c) => {
      const head = c.querySelector('span.text-ui-body');
      return head ? head.textContent.trim() : '';
    });
    // locate the probe thought block container by its text
    const all = [...document.querySelectorAll('div')];
    const body = all.find((el) => el.className && String(el.className).includes('thought-body') && (el.textContent || '').includes(${JSON.stringify(THOUGHT_PROBE)}));
    if (!body) return { error: 'probe thought body not found' };
    const card = body.parentElement;
    const code = body.querySelector('pre code');
    const cardInThought = card.querySelectorAll('[data-testid="super-task-card"]').length;
    const fenceTitleInCards = titles.includes(${JSON.stringify(FENCE_TASK_TITLE)});
    return {
      thoughtCodeLang: code ? code.className : null,
      thoughtCodeText: code ? code.textContent.slice(0, 80) : null,
      cardsInsideThought: cardInThought,
      totalCards: cards.length,
      fenceTitleInCards,
      thoughtText: (body.textContent || '').slice(0, 120),
    };
  })()`);

  await evaluate(`(() => {
    const body = [...document.querySelectorAll('div')].find(
      (el) => el.className && String(el.className).includes('thought-body') &&
        (el.textContent || '').includes(${JSON.stringify(THOUGHT_PROBE)}),
    );
    if (body) body.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await sleep(400);
  const shotT3 = await shot("03-thought-fence.png");

  record(
    "3",
    "思考块里的委派围栏只按普通 Markdown 代码块渲染，不出现委派卡",
    t3.totalCards === 5 &&
      t3.cardsInsideThought === 0 &&
      t3.fenceTitleInCards === false &&
      /language-super-agent/.test(t3.thoughtCodeLang || ""),
    t3,
    [shotT3],
  );

  // restore transcript (drop the probe thought)
  await evaluate(`(() => {
    const clone = JSON.parse(JSON.stringify(window.__lastSnapshot));
    clone.state.blocks = clone.state.blocks.filter((b) => b.id !== 'probe-thought-fence');
    window.dispatchEvent(new MessageEvent('message', { data: clone }));
    return true;
  })()`);
  await sleep(300);

  // =====================================================================
  // 4) 非终态子会话 → 历史会话下拉 / 设置页 API 切换 / 模型下拉 disabled，
  //    发送按钮仍可用；全终态后恢复
  // =====================================================================
  const fillComposer = `(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return { ok: false, reason: 'no textarea' };
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '发送按钮可用性检查');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true };
  })()`;

  async function controlState(label) {
    return evaluate(`(() => {
      const hist = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').startsWith('历史会话'));
      const model = [...document.querySelectorAll('button')].find((b) => b.getAttribute('title') === '模型');
      const send = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').startsWith('发送'));
      return {
        label: ${JSON.stringify(label)},
        history: hist ? { found: true, disabled: hist.disabled === true, title: hist.getAttribute('title') } : { found: false },
        model: model ? { found: true, disabled: model.disabled === true, title: model.getAttribute('title') } : { found: false },
        send: send ? { found: true, disabled: send.disabled === true, title: send.getAttribute('title') } : { found: false },
      };
    })()`);
  }

  await evaluate(fillComposer);
  await sleep(250);
  const stateActive = await controlState("active");
  const shotT4a = await shot("04a-controls-locked.png");

  // settings → API profile switch
  await evaluate(CLICK_BY_ARIA("设置"));
  await waitFor(`!!document.querySelector('[role="dialog"]')`, "settings dialog");
  await sleep(500);
  const profileActive = await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return { found: false };
    const rows = [...dialog.querySelectorAll('button')].filter((b) => (b.textContent || '').trim().startsWith('BUZZ'));
    const target = rows[0];
    return target
      ? { found: true, disabled: target.disabled === true, text: (target.textContent || '').trim().slice(0, 40) }
      : { found: false, buttons: [...dialog.querySelectorAll('button')].map((b) => (b.textContent || '').trim().slice(0, 20)).slice(0, 40) };
  })()`);
  const shotT4aSettings = await shot("04a2-settings-profile-locked.png");
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(400);

  // interrupt all → everything terminal
  await evaluate(CLICK_BY_ARIA("全部中断"));
  await sleep(300);
  const confirmDialog = await evaluate(`(() => {
    const dialogs = [...document.querySelectorAll('[role="alertdialog"],[role="dialog"]')];
    for (const dialog of dialogs) {
      const btn = [...dialog.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '全部中断');
      if (btn) {
        btn.click();
        return { found: true, clicked: true, dialogCount: dialogs.length };
      }
    }
    return {
      found: false,
      dialogs: dialogs.map((d) => (d.textContent || '').trim().slice(0, 60)),
    };
  })()`);
  await sleep(800);

  const terminalStatuses = await evaluate(`(() => {
    const clone = window.__lastSnapshot;
    return clone ? clone.state.superSessions.map((s) => ({ id: s.id, status: s.status })) : null;
  })()`);

  await evaluate(fillComposer);
  await sleep(250);
  const stateIdle = await controlState("all-terminal");
  const shotT4b = await shot("04b-controls-restored.png");

  await evaluate(CLICK_BY_ARIA("设置"));
  await waitFor(`!!document.querySelector('[role="dialog"]')`, "settings dialog (terminal)");
  await sleep(500);
  const profileIdle = await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return { found: false };
    const rows = [...dialog.querySelectorAll('button')].filter((b) => (b.textContent || '').trim().startsWith('BUZZ'));
    const target = rows[0];
    return target ? { found: true, disabled: target.disabled === true } : { found: false };
  })()`);
  const shotT4bSettings = await shot("04b2-settings-profile-restored.png");
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(400);

  const t4ok =
    stateActive.history.disabled === true &&
    stateActive.model.disabled === true &&
    stateActive.send.found === true &&
    stateActive.send.disabled === false &&
    profileActive.found === true &&
    profileActive.disabled === true &&
    stateIdle.history.disabled === false &&
    stateIdle.model.disabled === false &&
    stateIdle.send.disabled === false &&
    profileIdle.found === true &&
    profileIdle.disabled === false &&
    Array.isArray(terminalStatuses) &&
    terminalStatuses.every((s) => ["completed", "failed", "cancelled"].includes(s.status));

  record(
    "4",
    "非终态子会话时历史/API 配置/模型下拉禁用、发送仍可用；全终态恢复",
    t4ok,
    { active: stateActive, profileActive, confirmDialog, terminalStatuses, idle: stateIdle, profileIdle },
    [shotT4a, shotT4aSettings, shotT4b, shotT4bSettings],
  );

  // =====================================================================
  // 5) 「查看实时操作」弹框：四类块间距一致、无卡片残留、无主转录专属按钮
  // =====================================================================
  // reopen the running child's row (it is cancelled now but the live button stays)
  await evaluate(`(() => {
    const btn = document.querySelector('[aria-label="展开子会话看板"]');
    if (btn && btn.getAttribute('aria-expanded') === 'false') btn.click();
    return true;
  })()`);
  await sleep(300);
  const liveVisible = await evaluate(`(() => {
    return [...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes('查看实时操作'));
  })()`);
  if (!liveVisible) {
    await evaluate(CLICK_BY_TEXT("修复登录跳转"));
    await sleep(400);
  }
  const liveClick = await evaluate(CLICK_BY_TEXT("查看实时操作"));
  await sleep(800);

  // Expand the collapsed 原始参数 / 操作输出 sections so all four block kinds
  // are actually rendered before measuring the rhythm.
  const expandAll = await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find(
      (d) => (d.textContent || '').includes('实时输出'),
    );
    if (!dialog) return { ok: false, reason: 'no dialog' };
    const scroller = dialog.querySelector('.overflow-y-auto');
    const log = scroller ? scroller.querySelector('.flex.flex-col.gap-2') : null;
    if (!log) return { ok: false, reason: 'no log' };
    let clicks = 0;
    for (const b of [...log.querySelectorAll('button')]) {
      const txt = (b.textContent || '').trim();
      if (txt === '操作输出' || txt === '实时输出' || txt === '查看原始参数') {
        b.click();
        clicks++;
      }
    }
    return { ok: true, clicks };
  })()`);
  await sleep(700);

  const t5 = await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find(
      (d) => (d.textContent || '').includes('实时输出'),
    );
    if (!dialog) return { error: 'live dialog not found', dialogs: [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].map((d) => (d.textContent || '').trim().slice(0, 40)) };
    const scroller = dialog.querySelector('.overflow-y-auto');
    const log = scroller ? scroller.querySelector('.flex.flex-col.gap-2') : null;
    if (!log) return { error: 'log container not found', dialogText: (dialog.textContent || '').slice(0, 200) };
    const rows = [...log.children];
    const rects = rows.map((el) => el.getBoundingClientRect());
    const gaps = rects.slice(1).map((r, i) => Math.round((r.top - rects[i].bottom) * 10) / 10);
    const toolCards = [...log.querySelectorAll('.tool-card')];
    const flatToolCards = toolCards.filter((el) => el.classList.contains('tool-card-flat'));
    const nonFlat = toolCards.filter((el) => !el.classList.contains('tool-card-flat')).map((el) => el.className);
    const cardSurfaces = [...log.querySelectorAll('.shadow-card, .bg-card, .rounded-lg.border')].map((el) => el.className);
    // inner rhythm of each tool card: header → input → output
    const inner = toolCards.map((card) => {
      const kids = [...card.children].map((el) => el.getBoundingClientRect());
      const gapList = kids.slice(1).map((r, i) => Math.round((r.top - kids[i].bottom) * 10) / 10);
      const inputEl = card.querySelector('.tool-card-raw');
      const cs = inputEl ? getComputedStyle(inputEl) : null;
      return {
        className: card.className,
        childCount: kids.length,
        gaps: gapList,
        inputMarginBottom: cs ? cs.marginBottom : null,
        inputPadding: cs ? cs.padding : null,
      };
    });
    const buttonLabels = [...dialog.querySelectorAll('button')].map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim()).filter(Boolean);
    const forbidden = buttonLabels.filter((l) => /^(复制|重新生成|回退|在终端中打开|查看改动|展开全部改动)/.test(l));
    const pres = [...log.querySelectorAll('pre')].map((pre) => {
      const cs = getComputedStyle(pre);
      return { className: pre.className, marginBottom: cs.marginBottom, padding: cs.padding };
    });
    const headerPads = [...log.querySelectorAll('.tool-card')].map((card) => {
      const head = card.firstElementChild;
      const cs = head ? getComputedStyle(head) : null;
      return cs ? cs.padding : null;
    });
    return {
      rowCount: rows.length,
      gaps,
      toolCardCount: toolCards.length,
      flatToolCardCount: flatToolCards.length,
      nonFlat,
      cardSurfaces,
      inner,
      preCount: pres.length,
      preMetrics: [...new Set(pres.map((p) => p.marginBottom + '|' + p.padding))],
      preSample: pres.slice(0, 6),
      headerPads,
      buttonLabels,
      forbidden,
      kinds: rows.map((el) => (el.textContent || '').trim().slice(0, 30)),
    };
  })()`);

  const modalRect = await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find(
      (d) => (d.textContent || '').includes('实时输出'),
    );
    if (!dialog) return null;
    const r = dialog.getBoundingClientRect();
    return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: r.width, height: r.height };
  })()`);
  const shotT5 = await shot("05-live-pane.png");
  const shotT5b = modalRect ? await shotRect("05b-live-pane-closeup.png", modalRect) : null;

  const gapUniform = Array.isArray(t5.gaps) && t5.gaps.length > 0 && t5.gaps.every((g) => Math.abs(g - 8) <= 1);
  const preConsistent = Array.isArray(t5.preMetrics) && t5.preMetrics.length === 1 && t5.preCount >= 4;
  const headerConsistent =
    Array.isArray(t5.headerPads) && t5.headerPads.length > 0 && new Set(t5.headerPads).size === 1;

  record(
    "5",
    "「查看实时操作」弹框四类块间距一致、无卡片残留、无主转录专属按钮",
    t5.rowCount >= 4 &&
      t5.toolCardCount === 3 &&
      t5.flatToolCardCount === 3 &&
      t5.nonFlat.length === 0 &&
      t5.cardSurfaces.length === 0 &&
      t5.forbidden.length === 0 &&
      gapUniform &&
      preConsistent &&
      headerConsistent,
    t5,
    [shotT5, shotT5b].filter(Boolean),
  );

  // =====================================================================
  const report = {
    boot,
    pageUrl: PAGE_URL,
    chrome: CHROME,
    viewport: { width: 1280, height: 900 },
    results,
  };
  const reportPath = path.join(BASE, "report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nreport: ${reportPath}`);
  console.log(`screenshots: ${OUT_DIR}`);
  return report;
}

try {
  const report = await main();
  const failed = report.results.filter((r) => !r.ok);
  console.log(`\nSUMMARY: ${report.results.length - failed.length}/${report.results.length} passed`);
  process.exitCode = failed.length === 0 ? 0 : 2;
} catch (err) {
  console.error("FATAL:", err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
} finally {
  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
}
