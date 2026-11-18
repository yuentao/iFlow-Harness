// @vitest-environment jsdom
/**
 * Super Agent 看板 UX 优化回归（P1-1 / P1-2 / P2-1..P2-6）。
 *
 * 与 super-board-surface.test.tsx 共用同一套 store / i18n mock，但这里只钉
 * "语义" 而不是像素：needsAction 的可见性、确认按钮的色调、忙态色调、术语、
 * 窄屏收缩、排队耗时口径、重试 tooltip。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuperSessionUi } from "../shared/super-agent";
import { SuperAgentBoard } from "../webview/src/components/SuperAgentBoard";

const store = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("../webview/src/store", () => ({
  useChat: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(store.current),
    { getState: () => store.current },
  ),
}));

const translate = vi.hoisted(() =>
  vi.fn((s: string, ...args: Array<string | number>) => {
    let out = s;
    args.forEach((arg, i) => {
      out = out.replaceAll(`{${i}}`, String(arg));
    });
    return out;
  }),
);
vi.mock("../webview/src/i18n", () => ({ t: translate }));

const send = vi.fn();

function session(overrides: Partial<SuperSessionUi> = {}): SuperSessionUi {
  return {
    id: "super-1",
    title: "修复登录跳转",
    task: "修好登录跳转并补单测",
    status: "running",
    isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/a", baseRef: "abc" },
    createdAt: 1000,
    updatedAt: 1000,
    reports: [],
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  send.mockReset();
  translate.mockClear();
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = Observer;
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = Observer;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(sessions: SuperSessionUi[], qqTasks: unknown[] = []): void {
  store.current = {
    state: { superSessions: sessions, qqTasks },
    superTranscripts: {},
    send,
  };
  act(() => root.render(<SuperAgentBoard />));
}

function control(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('button[aria-label="子会话看板"]');
  expect(el).toBeTruthy();
  return el!;
}

function expand(): void {
  act(() => control().click());
}

function rowButton(title: string): HTMLButtonElement {
  const el = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    (b.textContent ?? "").includes(title),
  );
  expect(el).toBeTruthy();
  return el!;
}

function buttonByText(text: string): HTMLButtonElement {
  const el = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  expect(el).toBeTruthy();
  return el!;
}

function buttonByLabel(label: string): HTMLButtonElement {
  const el = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.getAttribute("aria-label") === label,
  );
  expect(el).toBeTruthy();
  return el!;
}

function dialog(label: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[role="alertdialog"][aria-label="${label}"]`);
  expect(el).toBeTruthy();
  return el!;
}

/** The status span on a row (icon + label + colour), found by its exact label. */
function chipSpan(label: string): HTMLElement {
  const el = [...document.body.querySelectorAll<HTMLElement>("span")].find(
    (s) => s.textContent === label && s.classList.contains("text-ui-micro"),
  );
  expect(el).toBeTruthy();
  return el!;
}

// ---------------------------------------------------------------------------
// P1-1 — needsAction 有写无读
// ---------------------------------------------------------------------------
describe("P1-1 needsAction 可见性", () => {
  it("skipped + needsAction=true 显示「需人工合并」chip，false（中断）不显示", () => {
    render([
      session({
        id: "a",
        title: "改动重叠需人工",
        status: "completed",
        integration: { mode: "merge", state: "skipped", detail: "工作区脏", needsAction: true, at: 5000 },
      }),
      session({
        id: "b",
        title: "中断不用管",
        status: "cancelled",
        integration: { mode: "merge", state: "skipped", detail: "被用户中断", needsAction: false, at: 5000 },
      }),
    ]);
    expand();
    // Only one row's detail is open at a time — check each in turn.
    act(() => rowButton("改动重叠需人工").click());
    expect(document.body.textContent).toContain("未自动合并");
    expect(document.body.textContent).toContain("需人工合并");

    act(() => rowButton("中断不用管").click());
    expect(document.body.textContent).toContain("未自动合并");
    expect(document.body.textContent).not.toContain("需人工合并");
  });

  it("折叠分组里 needsAction 会话被单独计数，标题显示警示 chip", () => {
    // merged 会被 isSuperSessionSettled 折叠；即使带上 needsAction 也仍折叠，
    // 用于验证防御性计数分支不会把它误报成「无需合并」。
    render([
      session({
        id: "a",
        title: "合并后仍需人工",
        status: "completed",
        integration: { mode: "merge", state: "merged", needsAction: true, at: 5000 },
      }),
      session({
        id: "b",
        title: "普通已合并",
        status: "completed",
        integration: { mode: "merge", state: "merged", at: 5000 },
      }),
    ]);
    expand();
    const toggle = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="展开已完成的子会话"]',
    );
    expect(toggle).toBeTruthy();
    expect(toggle!.textContent).toContain("已完成、需人工合并的 2 个子会话");
    expect(toggle!.textContent).toContain("1 个需人工合并");
    expect(toggle!.textContent).not.toContain("已完成、无需合并的");
  });
});

// ---------------------------------------------------------------------------
// P1-2 — 合并确认按钮语义色
// ---------------------------------------------------------------------------
describe("P1-2 合并确认按钮色调", () => {
  it("合并确认是 primary，不是 destructive 红", () => {
    render([
      session({
        id: "m",
        status: "completed",
        integration: { mode: "merge", state: "skipped", at: 5000 },
      }),
    ]);
    expand();
    act(() => rowButton("修复登录跳转").click());
    act(() => buttonByText("让智能体合并").click());

    const confirm = [...dialog("合并子会话分支").querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "让智能体合并分支",
    );
    expect(confirm).toBeTruthy();
    expect(confirm!.className).toContain("text-primary");
    expect(confirm!.className).not.toContain("text-destructive");
  });

  it("中断确认仍是 destructive 红（与合并形成对照）", () => {
    render([session({ id: "c", status: "running" })]);
    expand();
    act(() => rowButton("修复登录跳转").click());
    act(() => buttonByLabel("中断这个子会话").click());

    const confirm = [...dialog("中断子会话").querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "中断",
    );
    expect(confirm).toBeTruthy();
    expect(confirm!.className).toContain("text-destructive");
  });
});

// ---------------------------------------------------------------------------
// P2-1 — 忙态 chip 色调 + 全部中断
// ---------------------------------------------------------------------------
describe("P2-1 忙态色调与全部中断", () => {
  it("中断中 / 清理中 chip 是 danger 色", () => {
    render([session({ id: "c", status: "running" })]);
    expand();
    act(() => buttonByLabel("中断这个子会话").click());
    act(() => buttonByText("中断").click());
    expect(chipSpan("中断中").parentElement!.className).toContain("text-destructive");
  });

  it("合并中 / 重试中 chip 是 primary 色", () => {
    render([
      session({
        id: "m",
        status: "completed",
        integration: { mode: "merge", state: "skipped", at: 5000 },
      }),
    ]);
    expand();
    act(() => rowButton("修复登录跳转").click());
    act(() => buttonByText("让智能体合并").click());
    act(() => buttonByText("让智能体合并分支").click());
    expect(chipSpan("合并中").parentElement!.className).toContain("text-primary");
    expect(chipSpan("合并中").parentElement!.className).not.toContain("text-destructive");
  });

  it("「全部中断」按钮是 danger 色", () => {
    render([session({ status: "running" })]);
    expand();
    const btn = [...document.body.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "全部中断",
    );
    expect(btn).toBeTruthy();
    expect(btn!.className).toContain("text-destructive");
  });
});

// ---------------------------------------------------------------------------
// P2-2 — 提交回答的乐观反馈
// ---------------------------------------------------------------------------
describe("P2-2 提交回答乐观反馈", () => {
  it("提交后头部切成「已提交，等待子会话继续」且保留 aria-live", () => {
    render([
      session({
        id: "ask",
        status: "awaiting_input",
        pending: {
          kind: "question",
          requestId: "q-1",
          deadline: Date.now() + 240_000,
          timeoutMs: 300_000,
          questions: [
            { header: "范围", question: "覆盖范围？", multiSelect: false, options: [] },
          ],
        },
      }),
    ]);
    const body = () => document.body.textContent ?? "";
    expect(body()).toContain("子会话需要你回答");

    act(() => buttonByText("提交回答").click());

    expect(body()).toContain("已提交，等待子会话继续");
    expect(body()).not.toContain("子会话需要你回答");
    const live = [...document.body.querySelectorAll('[aria-live="polite"]')].find((el) =>
      (el.textContent ?? "").includes("已提交"),
    );
    expect(live).toBeTruthy();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ action: "respond", sessionId: "ask" }),
    );
  });
});

// ---------------------------------------------------------------------------
// P2-3 — 状态术语统一
// ---------------------------------------------------------------------------
describe("P2-3 计数 chip 术语统一", () => {
  it("等你回答 / 失败 chip 复用状态词根，不再出现「待处理」「未成功」", () => {
    render([
      session({ id: "a", status: "awaiting_input" }),
      session({ id: "b", status: "failed", error: "崩溃" }),
    ]);
    const labels = [...control().querySelectorAll("[aria-label]")].map((el) =>
      el.getAttribute("aria-label") ?? "",
    );
    expect(labels.some((l) => l.includes("{0} 个等你回答") || l.includes("个等你回答"))).toBe(true);
    expect(labels.some((l) => l.includes("{0} 个失败") || l.includes("个失败"))).toBe(true);
    expect(labels.some((l) => l.includes("个待处理") || l.includes("个未成功"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P2-4 — QQ 元信息 chip 窄屏收缩
// ---------------------------------------------------------------------------
describe("P2-4 QQ 元信息 chip 窄屏收缩", () => {
  it("渠道 / 发起人 chip 带窄屏隐藏类（与其余 chip 一致）", () => {
    const qq = {
      taskId: "T-1",
      shortId: "q3pzqq",
      chatType: "private",
      chatId: "D754********8D11",
      senderId: "D754********8D11",
      status: "needs_review",
      channel: "child",
      branch: "iflow/super/qq-q3pzqq-1",
      promptPreview: "你好",
      createdAt: 1000,
      updatedAt: 1000,
    };
    render(
      [
        session({
          id: "qq-1",
          title: "QQ q3pzqq",
          isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/qq-q3pzqq-1" },
        }),
      ],
      [qq],
    );
    expand();

    const channel = [...document.body.querySelectorAll<HTMLElement>("span")].find(
      (s) => s.textContent === "渠道：私聊",
    );
    const sender = [...document.body.querySelectorAll<HTMLElement>("span")].find(
      (s) => s.textContent === "发起人：D754********8D11",
    );
    expect(channel).toBeTruthy();
    expect(sender).toBeTruthy();
    expect(channel!.className).toContain("@max-[380px]:hidden");
    expect(sender!.className).toContain("@max-[380px]:hidden");
    expect(channel!.className).toContain("shrink-0");
  });
});

// ---------------------------------------------------------------------------
// P2-5 — 排队时间口径
// ---------------------------------------------------------------------------
describe("P2-5 排队耗时口径", () => {
  it("排队中（无 startedAt）显示「排队 Ns」，不显示裸运行耗时", () => {
    const base = Date.now();
    render([
      session({
        id: "q",
        status: "preparing",
        queued: true,
        createdAt: base - 5_000,
        isolation: { kind: "directory", path: "", note: "正在准备隔离环境" },
      }),
    ]);
    expand();
    const row = rowButton("修复登录跳转");
    expect(row.textContent).toMatch(/排队 \d+s/);
    expect(row.textContent).not.toContain("已运行");
  });

  it("已启动的行显示裸耗时；实时弹窗显示「已运行 Ns」", () => {
    const base = Date.now();
    render([session({ id: "r", status: "running", createdAt: base - 9_000, startedAt: base - 5_000 })]);
    expand();
    const row = rowButton("修复登录跳转");
    expect(row.textContent).not.toContain("排队");
    expect(row.textContent).toMatch(/\d+s/);

    act(() => row.click());
    act(() => buttonByText("查看实时进度").click());
    expect(document.body.textContent).toContain("已运行");
    expect(document.body.textContent).not.toContain("排队 4s");
  });
});

// ---------------------------------------------------------------------------
// P2-6 — 重试 tooltip 明示代价
// ---------------------------------------------------------------------------
describe("P2-6 重试 tooltip 代价", () => {
  it("重试按钮在 tooltip 与可访问名里说明清空集成结果并重跑", () => {
    render([session({ id: "r", status: "failed", error: "进程崩溃" })]);
    expand();
    act(() => rowButton("修复登录跳转").click());
    const retry = [...document.body.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "重试",
    );
    expect(retry).toBeTruthy();
    for (const fragment of ["不产生新提交", "清空上一次的集成结果", "重跑"]) {
      expect(retry!.getAttribute("title")).toContain(fragment);
      expect(retry!.getAttribute("aria-label")).toContain(fragment);
    }
  });
});
