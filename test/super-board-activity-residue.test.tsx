// @vitest-environment jsdom
/**
 * 看板「最近活动」与「残留分支清单」回归（jsdom）。
 *
 * 这两个能力完全由真实字段驱动，不依赖尚不存在的新增协议：
 *   · 最近活动 = max(updatedAt, diagnostics[].at)，看板每秒节流刷新；
 *   · 残留分支 = 终态 + git worktree + 有分支 + 未成功合并；
 *   · 一键「合并 / 丢弃」走宿主既有的 superAgent/merge、superAgent/cleanup，
 *     二者都经 ConfirmDialog 二次确认后才发消息。
 *
 * 这里钉真实 DOM 交互：折叠行的「最近活动」文案与静默警示、诊断视图的
 * 残留清单渲染、丢弃二次确认（点按钮只弹框、不发包，确认后才发包）、
 * 以及「无 console error / 无横向溢出（语义：无越界的固定宽度行）」。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuperBoardSession } from "../shared/super-board";
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

/** 固定「现在」，让最近活动的相对时间可断言。 */
const NOW = 1_700_000_000_000;

function session(overrides: Partial<SuperBoardSession> = {}): SuperBoardSession {
  return {
    id: "super-1",
    title: "修复登录跳转",
    task: "修好登录跳转并补单测",
    status: "running",
    isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/a", baseRef: "abc" },
    createdAt: NOW - 120_000,
    updatedAt: NOW - 5_000,
    reports: [],
    ...overrides,
  };
}

/** 一条已中断、分支还在、改动未落地的残留会话。 */
function residual(overrides: Partial<SuperBoardSession> = {}): SuperBoardSession {
  return session({
    id: "res-1",
    title: "被中断的重构",
    status: "cancelled",
    updatedAt: NOW - 30_000,
    isolation: {
      kind: "git_worktree",
      path: "/tmp/wt-res",
      branch: "iflow/super/refactor-z9",
      baseRef: "abc",
    },
    ...overrides,
  });
}

let root: Root;
let container: HTMLDivElement;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  send.mockReset();
  translate.mockClear();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
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
  consoleError.mockRestore();
  vi.useRealTimers();
});

function render(sessions: SuperBoardSession[]): void {
  store.current = {
    state: { superSessions: sessions, qqTasks: [] },
    superTranscripts: {},
    send,
  };
  act(() => root.render(<SuperAgentBoard />));
}

function control(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('button[aria-label="超流体看板"]');
  expect(el).toBeTruthy();
  return el!;
}

function expand(): void {
  act(() => control().click());
}

function panel(): HTMLElement {
  const el = document.getElementById("super-board-panel");
  expect(el).toBeTruthy();
  return el!;
}

function allButtons(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>("button")];
}

function buttonByText(text: string): HTMLButtonElement {
  const el = allButtons().find((b) => (b.textContent ?? "").trim() === text);
  expect(el).toBeTruthy();
  return el!;
}

function buttonByLabel(label: string): HTMLButtonElement {
  const el = allButtons().find((b) => b.getAttribute("aria-label") === label);
  expect(el).toBeTruthy();
  return el!;
}

function viewTab(label: string): void {
  act(() => buttonByText(label).click());
}

describe("最近活动", () => {
  it("活跃会话折叠行显示「最近活动 N 前」，取自 updatedAt 与诊断时间的最大值", () => {
    render([
      session({
        updatedAt: NOW - 90_000,
        diagnostics: [
          { at: NOW - 3_000, kind: "report", level: "info", message: "刚推进" },
          { at: NOW - 60_000, kind: "spawn", level: "info", message: "早先" },
        ],
      }),
    ]);
    expand();
    // updatedAt=90s 前，但更晚的诊断是 3s 前 → 取 3s。
    expect(panel().textContent).toContain("最近活动 3s 前");
  });

  it("activityDetail.at 优先于诊断事件 at 与其它诊断时间，摘要进入最近活动提示", () => {
    render([
      session({
        updatedAt: NOW - 120_000,
        diagnostics: [
          {
            at: NOW - 60_000,
            kind: "activity",
            level: "info",
            message: "稍早活动",
            // 真实活动时刻比诊断落盘时刻晚得多：取错字段会得到 1m/20s 前。
            activityDetail: { source: "assistant", excerpt: "正在写文件", at: NOW - 4_000 },
          },
          { at: NOW - 20_000, kind: "report", level: "info", message: "中间心跳" },
        ],
      }),
    ]);
    expand();
    // 若误用事件 at，这里会是 1m 前或 20s 前；优先取 activityDetail.at → 4s。
    expect(panel().textContent).toContain("最近活动 4s 前");
    const chip = panel().querySelector<HTMLElement>('[data-super-recent-activity]');
    expect(chip).toBeTruthy();
    expect(chip!.getAttribute("title")).toContain("正在写文件");
  });

  it("静默超过阈值时给警示（title 提示可中断），不静默时用普通说明", () => {
    render([session({ updatedAt: NOW - 90_000, diagnostics: [] })]);
    expand();
    const chip = panel().querySelector<HTMLElement>('[data-super-recent-activity="super-1"]');
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toContain("最近活动 1m 30s 前");
    expect(chip!.getAttribute("title")).toContain("可能卡住");
    expect(chip!.className).toContain("text-warning");
  });

  it("终态会话不显示最近活动标签（只对活跃会话渲染）", () => {
    render([session({ status: "completed" })]);
    expand();
    expect(panel().querySelector('[data-super-recent-activity]')).toBeNull();
  });
});

describe("判定卡死", () => {
  it("运行中子会话有「判定卡死」按钮，点击先弹二次确认且不发包，确认后发 superAgent/stuck", () => {
    render([session({ id: "live", status: "running", updatedAt: NOW - 30_000 })]);
    expand();
    const btn = buttonByLabel("判定卡死");
    expect(btn).toBeTruthy();

    act(() => btn.click());
    expect(send).not.toHaveBeenCalled();
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain("用户判定超时");

    const confirm = [...dialog!.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.textContent ?? "").trim() === "判定卡死并中断",
    );
    expect(confirm).toBeTruthy();
    act(() => confirm!.click());
    expect(send).toHaveBeenCalledWith({ type: "superAgent", action: "stuck", sessionId: "live" });
  });

  it("确认框点取消不发任何消息", () => {
    render([session({ id: "live", status: "running" })]);
    expand();
    act(() => buttonByLabel("判定卡死").click());
    const cancel = allButtons().find((b) => (b.textContent ?? "").trim() === "取消");
    expect(cancel).toBeTruthy();
    act(() => cancel!.click());
    expect(send).not.toHaveBeenCalled();
  });

  it("终态会话不渲染「判定卡死」按钮", () => {
    render([session({ status: "completed" })]);
    expand();
    expect(document.body.querySelector('[aria-label="判定卡死"]')).toBeNull();
  });
});

describe("残留分支清单", () => {
  it("诊断视图顶部列出未合并的残留分支，带短分支名与合并/丢弃动作", () => {
    render([residual()]);
    expand();
    viewTab("诊断");

    const text = panel().textContent ?? "";
    expect(text).toContain("残留分支清单");
    expect(text).toContain("被中断的重构");
    expect(text).toContain("1 个待处置");
    // 短分支名（super/…后缀）出现，完整 ref 不铺开。
    expect(text).toContain("super/");
    // 两条真实动作入口都在。
    expect(buttonByLabel("合并残留分支 被中断的重构")).toBeTruthy();
    expect(buttonByLabel("丢弃残留分支 被中断的重构")).toBeTruthy();
  });

  it("已合并 / 无需合并 / 无提交的分支不进残留清单", () => {
    render([
      residual({ id: "merged", title: "已合并的", integration: { mode: "merge", state: "merged", at: NOW } }),
      residual({ id: "nn", title: "无提交的", integration: { mode: "merge", state: "not_needed", at: NOW } }),
      residual({ id: "pr", title: "已开 PR", integration: { mode: "pr", state: "pr_created", at: NOW } }),
    ]);
    expand();
    viewTab("诊断");
    const text = panel().textContent ?? "";
    expect(text).not.toContain("已合并的");
    expect(text).not.toContain("无提交的");
    expect(text).not.toContain("已开 PR");
    expect(text).not.toContain("残留分支清单");
  });

  it("无残留会话时清单不渲染，不留空标题", () => {
    render([session({ status: "completed", integration: { mode: "merge", state: "merged", at: NOW } })]);
    expand();
    viewTab("诊断");
    expect(panel().textContent).not.toContain("残留分支清单");
  });

  it("丢弃先弹二次确认框，此时不发包；确认后才发 superAgent/cleanup", () => {
    render([residual()]);
    expand();
    viewTab("诊断");
    act(() => buttonByLabel("丢弃残留分支 被中断的重构").click());

    // 只弹框，不发包。
    expect(send).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("丢弃残留分支");
    expect(document.body.textContent).toContain("此操作不可撤销");

    // 确认按钮（危险色默认确认）→ 发真实 cleanup 消息。限定在 alertdialog
    // 内查找，避免误点清单行里同样叫「丢弃」的按钮。
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog).toBeTruthy();
    const confirm = [...dialog!.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.textContent ?? "").trim() === "丢弃",
    );
    expect(confirm).toBeTruthy();
    act(() => confirm!.click());
    expect(send).toHaveBeenCalledWith({ type: "superAgent", action: "cleanup", sessionId: "res-1" });
  });

  it("丢弃确认框点取消不发任何消息", () => {
    render([residual()]);
    expand();
    viewTab("诊断");
    act(() => buttonByLabel("丢弃残留分支 被中断的重构").click());

    const cancel = allButtons().find((b) => (b.textContent ?? "").trim() === "取消");
    expect(cancel).toBeTruthy();
    act(() => cancel!.click());
    expect(send).not.toHaveBeenCalled();
  });

  it("合并先弹二次确认框，确认后才发 superAgent/merge", () => {
    render([residual()]);
    expand();
    viewTab("诊断");
    act(() => buttonByLabel("合并残留分支 被中断的重构").click());
    expect(send).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("合并残留分支");

    act(() => buttonByText("让智能体合并分支").click());
    expect(send).toHaveBeenCalledWith({ type: "superAgent", action: "merge", sessionId: "res-1" });
  });
});

describe("渲染卫生", () => {
  it("两功能全程无 console.error、无 undefined/NaN 文本、无越界固定宽度行", () => {
    render([
      session({ id: "live", updatedAt: NOW - 10_000 }),
      residual({ id: "res", status: "failed", lastError: { kind: "terminal", message: "崩了", at: NOW } }),
    ]);
    expand();
    viewTab("诊断");

    const text = panel().textContent ?? "";
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("NaN");
    expect(consoleError).not.toHaveBeenCalled();

    // 无横向溢出（语义）：清单行用 min-w-0 / flex-wrap，不出现固定像素宽度
    // 或 nowrap 把整行撑出面板。
    const list = panel().querySelector("section[aria-label='残留分支清单']");
    expect(list).toBeTruthy();
    expect(list!.querySelector("li")!.className).toContain("min-w-0");
    expect(list!.querySelector("li")!.className).toContain("flex-wrap");
    expect(list!.innerHTML).not.toMatch(/width:\s*\d+px/);
  });
});
