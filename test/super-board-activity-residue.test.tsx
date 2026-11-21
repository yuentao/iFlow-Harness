// @vitest-environment jsdom
/**
 * 看板「最近活动」与「残留分支清单」回归（jsdom）。
 *
 *   · 最近活动 = max(updatedAt, diagnostics[].at)，看板每秒节流刷新；
 *   · 残留分支 = 宿主新协议（requestSuperResidueList ↔ superResidueList）下发
 *     的完整清单，webview 不再从 superSessions 本地聚合；
 *   · 多选后「合并选中 / 丢弃选中」批量处置，单条行动作复用同一通道
 *     （单元素 sessionIds）；两者都先经 ConfirmDialog 再发 superResidueHandle
 *     （带 sessionIds + 一次性 confirmToken）。
 *
 * 这里钉真实 DOM 交互：打开视图发请求、回包渲染、多选/全选、批量与单条
 * 合并/丢弃的消息载荷、二次确认（点按钮只弹框、不发包）、刷新重发，以及
 * 「无 console error / 无横向溢出（语义：无越界的固定宽度行）」。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuperBoardSession } from "../shared/super-board";
import type { SuperResidueBranchUi } from "../shared/messages";
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
const requestList = vi.fn();
const handleAction = vi.fn();

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
  requestList.mockReset();
  handleAction.mockReset();
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

/** 一条宿主回包的残留分支。 */
function branch(overrides: Partial<SuperResidueBranchUi> = {}): SuperResidueBranchUi {
  return {
    sessionId: "res-1",
    branch: "iflow/super/refactor-z9",
    worktree: "/tmp/wt-res",
    title: "被中断的重构",
    unmerged: true,
    worktreeExists: true,
    ...overrides,
  };
}

function render(sessions: SuperBoardSession[], residue: SuperResidueBranchUi[] = []): void {
  // 看板在本地没有任何子会话时只渲染委派动效（控制按钮不出现）；残留清单
  // 是看板的一部分，需要看板存在才可达。只看残留清单的用例补一个占位会话。
  const boardSessions =
    sessions.length > 0 ? sessions : [session({ id: "board-placeholder" })];
  store.current = {
    state: { superSessions: boardSessions, qqTasks: [] },
    superTranscripts: {},
    superResidueList:
      residue.length > 0
        ? {
            type: "superResidueList",
            requestId: "req-test",
            branches: residue,
            confirmToken: "token-test",
          }
        : null,
    superResidueLoading: false,
    requestSuperResidueList: requestList,
    handleSuperResidueAction: handleAction,
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

describe("残留分支清单（新协议）", () => {
  const twoBranches = (): SuperResidueBranchUi[] => [
    branch(),
    branch({ sessionId: "res-2", title: "另一条残留", branch: "iflow/super/other-x1" }),
  ];

  function selectAll(): void {
    const all = panel().querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(all).toBeTruthy();
    act(() => all!.click());
  }

  it("打开诊断视图即请求清单，并渲染宿主回包的分支（短分支名 + 单条动作）", () => {
    render([], [branch()]);
    expand();
    viewTab("诊断");
    expect(requestList).toHaveBeenCalled();

    const text = panel().textContent ?? "";
    expect(text).toContain("残留分支清单");
    expect(text).toContain("被中断的重构");
    expect(text).toContain("1 个待处置");
    // 短分支名（super/…后缀）出现，完整 ref 不铺开。
    expect(text).toContain("super/");
    expect(buttonByLabel("合并残留分支 被中断的重构")).toBeTruthy();
    expect(buttonByLabel("丢弃残留分支 被中断的重构")).toBeTruthy();
  });

  it("无清单时清单不渲染，不留空标题", () => {
    render([session({ status: "completed" })], []);
    expand();
    viewTab("诊断");
    expect(panel().textContent).not.toContain("残留分支清单");
  });

  it("多选：行首勾选与全选联动，批量按钮按选中数启用", () => {
    render([], twoBranches());
    expand();
    viewTab("诊断");

    expect(buttonByText("合并选中（0）").disabled).toBe(true);
    expect(buttonByText("丢弃选中（0）").disabled).toBe(true);

    const rowBox = panel().querySelector<HTMLInputElement>(
      'input[aria-label="选择残留分支 被中断的重构"]',
    );
    expect(rowBox).toBeTruthy();
    act(() => rowBox!.click());
    expect(buttonByText("合并选中（1）").disabled).toBe(false);

    selectAll();
    expect(buttonByText("合并选中（2）").disabled).toBe(false);
    selectAll();
    expect(buttonByText("合并选中（0）").disabled).toBe(true);
  });

  it("批量合并：确认前不发，确认后发一次 handleSuperResidueAction('merge', ids)", () => {
    render([], twoBranches());
    expand();
    viewTab("诊断");
    selectAll();

    act(() => buttonByText("合并选中（2）").click());
    expect(handleAction).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("合并残留分支");

    act(() => buttonByText("让智能体合并分支").click());
    expect(handleAction).toHaveBeenCalledWith("merge", ["res-1", "res-2"]);
  });

  it("批量丢弃：确认前不发，确认后发一次 handleSuperResidueAction('discard', ids)", () => {
    render([], twoBranches());
    expand();
    viewTab("诊断");
    selectAll();

    act(() => buttonByText("丢弃选中（2）").click());
    expect(handleAction).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("此操作不可撤销");

    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog).toBeTruthy();
    const confirm = [...dialog!.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.textContent ?? "").trim() === "丢弃",
    );
    expect(confirm).toBeTruthy();
    act(() => confirm!.click());
    expect(handleAction).toHaveBeenCalledWith("discard", ["res-1", "res-2"]);
  });

  it("单条合并走同一通道：单元素 sessionIds", () => {
    render([], [branch()]);
    expand();
    viewTab("诊断");
    act(() => buttonByLabel("合并残留分支 被中断的重构").click());
    expect(handleAction).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("合并残留分支");

    act(() => buttonByText("让智能体合并分支").click());
    expect(handleAction).toHaveBeenCalledWith("merge", ["res-1"]);
  });

  it("单条丢弃确认后发单元素 sessionIds；取消不发", () => {
    render([], [branch()]);
    expand();
    viewTab("诊断");
    act(() => buttonByLabel("丢弃残留分支 被中断的重构").click());
    expect(handleAction).not.toHaveBeenCalled();

    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog).toBeTruthy();
    const confirm = [...dialog!.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.textContent ?? "").trim() === "丢弃",
    );
    act(() => confirm!.click());
    expect(handleAction).toHaveBeenCalledWith("discard", ["res-1"]);

    // 取消路径：再次打开确认框后点取消，不追加任何处置调用。
    handleAction.mockClear();
    act(() => buttonByLabel("丢弃残留分支 被中断的重构").click());
    const cancel = allButtons().find((b) => (b.textContent ?? "").trim() === "取消");
    expect(cancel).toBeTruthy();
    act(() => cancel!.click());
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("刷新按钮重发 requestSuperResidueList", () => {
    render([], [branch()]);
    expand();
    viewTab("诊断");
    requestList.mockClear();
    act(() => buttonByLabel("刷新残留清单").click());
    expect(requestList).toHaveBeenCalledTimes(1);
  });
});

describe("渲染卫生", () => {
  it("两功能全程无 console.error、无 undefined/NaN 文本、无越界固定宽度行", () => {
    render(
      [
        session({ id: "live", updatedAt: NOW - 10_000 }),
        residual({ id: "res", status: "failed", lastError: { kind: "terminal", message: "崩了", at: NOW } }),
      ],
      [branch()],
    );
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
