// @vitest-environment jsdom
/**
 * 看板「按波次 / 诊断」视图回归（jsdom）。
 *
 * 与 super-board-ux.test.tsx 共用同一套 store / i18n mock 与 render / expand
 * 工具函数。这里只钉语义：
 *   · 切到「按波次」能看到运行组与组级汇总 chip；
 *   · 组展开后能看到波次分层；
 *   · 切到「诊断」能看到跨子会话诊断事件；
 *   · 子会话行显示波次标记、尝试次数、失败分类文案；
 *   · 旧数据（无 runId / wave / attempts / lastError / diagnostics）不崩溃、
 *     不出现 undefined / NaN / 「第 0 波」/「尝试 1/1」文案（回归红线）。
 *
 * 面板与浮层会 portal 到 document.body，断言范围显式限定到面板/当前视图。
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

function session(overrides: Partial<SuperBoardSession> = {}): SuperBoardSession {
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

function render(sessions: SuperBoardSession[]): void {
  store.current = {
    state: { superSessions: sessions, qqTasks: [] },
    superTranscripts: {},
    superResidueList: null,
    superResidueLoading: false,
    requestSuperResidueList: () => {},
    handleSuperResidueAction: () => {},
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

/** 行触发按钮：行文本还含状态/chip，按「包含标题」定位（同 super-board-ux）。 */
function rowButton(title: string): HTMLButtonElement {
  const el = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    (b.textContent ?? "").includes(title),
  );
  expect(el).toBeTruthy();
  return el!;
}

/** 当前看板面板（portal 到 body 的 region），断言范围限定在它里面。 */
function panel(): HTMLElement {
  const el = document.getElementById("super-board-panel");
  expect(el).toBeTruthy();
  return el!;
}

function viewTab(label: string): void {
  act(() => buttonByText(label).click());
}

describe("按波次视图 · 运行组与波次分层", () => {
  const sessions: SuperBoardSession[] = [
    session({
      id: "a",
      title: "甲任务",
      runId: "run-a",
      wave: 1,
      status: "completed",
      createdAt: 1000,
      endedAt: 2000,
    }),
    session({
      id: "b",
      title: "乙任务",
      runId: "run-a",
      wave: 2,
      status: "running",
      attempts: 2,
      maxAttempts: 3,
      createdAt: 1500,
    }),
    session({
      id: "c",
      title: "丙任务",
      status: "failed",
      createdAt: 900,
      endedAt: 1200,
      lastError: { kind: "terminal", message: "配额耗尽", at: 1200 },
    }),
  ];

  it("切到「按波次」能看到运行组标题与组级汇总 chip", () => {
    render(sessions);
    expand();
    viewTab("按波次");

    const scope = panel();
    expect(scope.textContent).toContain("run-a");
    expect(scope.textContent).toContain("默认运行组");
    // run-a：1 完成 + 1 运行中（重试中也是运行中的子集，两个 chip 都在）。
    expect(scope.textContent).toContain("1 完成");
    expect(scope.textContent).toContain("1 运行中");
    expect(scope.textContent).toContain("1 重试中");
    // 默认组：1 失败。
    expect(scope.textContent).toContain("1 失败");
  });

  it("组默认折叠；展开后出现波次分层与组内任务行", () => {
    render(sessions);
    expand();
    viewTab("按波次");

    // 折叠态：组内任务行不渲染，波次标题也不渲染。
    expect(panel().textContent).not.toContain("第 1 波");
    expect(panel().textContent).not.toContain("甲任务");

    act(() => buttonByLabel("展开运行组 run-a").click());

    const scope = panel();
    expect(scope.textContent).toContain("第 1 波");
    expect(scope.textContent).toContain("第 2 波");
    expect(scope.textContent).toContain("甲任务");
    expect(scope.textContent).toContain("乙任务");
    // 默认组仍折叠：它的「未分组」层不出现。
    expect(scope.textContent).not.toContain("未分组");
  });

  it("默认运行组用「未分组」作为波次标题，旧数据也能分层", () => {
    render([session({ id: "legacy", title: "旧任务" })]);
    expand();
    viewTab("按波次");
    act(() => buttonByLabel("展开运行组 默认运行组").click());
    expect(panel().textContent).toContain("未分组");
    expect(panel().textContent).toContain("旧任务");
  });

  it("组标题与波次标题渲染聚合好的 token 用量（不重算，行折叠时不重复）", () => {
    render([
      session({
        id: "a",
        title: "甲任务",
        runId: "run-u",
        wave: 1,
        status: "completed",
        createdAt: 1000,
        endedAt: 2000,
        tokens: { input: 1500, output: 200 },
      }),
      session({
        id: "b",
        title: "乙任务",
        runId: "run-u",
        wave: 2,
        status: "completed",
        createdAt: 1500,
        endedAt: 2500,
        tokens: { input: 2000, output: 400 },
      }),
    ]);
    expand();
    viewTab("按波次");

    // 组默认折叠：组标题渲染组级合计（1500+2000 / 200+400）。
    expect(panel().textContent).toContain("↑3.5K ↓600");

    act(() => buttonByLabel("展开运行组 run-u").click());
    const scope = panel();
    // 两个波次标题各自渲染自己的用量。
    expect(scope.textContent).toContain("↑1.5K ↓200");
    expect(scope.textContent).toContain("↑2.0K ↓400");
    // 行仍是折叠态，行内用量不渲染 —— 波次用量只出现一次。
    expect((scope.textContent ?? "").split("↑1.5K").length - 1).toBe(1);
  });
});

describe("诊断视图 · 跨子会话时间线", () => {
  const sessions: SuperBoardSession[] = [
    session({
      id: "a",
      title: "甲",
      status: "failed",
      diagnostics: [
        { at: 100, kind: "tool", level: "info", message: "调用工具" },
        { at: 400, kind: "error", level: "error", message: "网关 503", detail: "重试 3 次" },
      ],
      lastError: { kind: "retryable", message: "网关 503", at: 400 },
    }),
    session({
      id: "b",
      title: "乙",
      status: "completed",
      diagnostics: [{ at: 300, kind: "tool", level: "warn", message: "命令超时" }],
    }),
  ];

  it("切到「诊断」能看到事件条目、级别文案与汇总", () => {
    render(sessions);
    expand();
    viewTab("诊断");

    const scope = panel();
    expect(scope.textContent).toContain("诊断事件");
    expect(scope.textContent).toContain("共 3 条");
    expect(scope.textContent).toContain("调用工具");
    expect(scope.textContent).toContain("网关 503");
    expect(scope.textContent).toContain("命令超时");
    // 级别是三重编码里的文案一重。
    expect(scope.textContent).toContain("错误");
    expect(scope.textContent).toContain("警告");
    expect(scope.textContent).toContain("最近错误：网关 503");
    // 归档指纹只纳入终态错误，diagnostics 不进指纹：如实提示可能滞后。
    expect(scope.textContent).toContain("诊断事件可能滞后于最后一次归档写入");
  });

  it("无诊断事件时给出空态文案，而不是空白或 undefined", () => {
    render([session({ id: "a" })]);
    expand();
    viewTab("诊断");
    expect(panel().textContent).toContain("暂无诊断事件");
    expect(panel().textContent).not.toContain("undefined");
  });
});

describe("子会话行 · 波次 / 尝试 / 失败分类 / 单行诊断", () => {
  it("行上显示波次标记与尝试次数（重试过才显示）", () => {
    render([
      session({
        id: "a",
        title: "重试中的任务",
        wave: 2,
        status: "running",
        attempts: 2,
        maxAttempts: 3,
      }),
      session({ id: "b", title: "首次任务", wave: 1, status: "running" }),
    ]);
    expand();

    const scope = panel();
    expect(scope.textContent).toContain("第 2 波");
    expect(scope.textContent).toContain("尝试 2/3");
    // 首次运行不挂「尝试 1/1」噪音。
    expect(scope.textContent).not.toContain("尝试 1/1");
  });

  it("首次尝试即使声明上限也不挂「尝试 1/N」chip，详情里仍能看到尝试次数", () => {
    render([
      session({ id: "a", title: "首次任务", status: "running", attempts: 1, maxAttempts: 2 }),
    ]);
    expand();
    act(() => rowButton("首次任务").click());

    const text = panel().textContent ?? "";
    expect(text).not.toContain("尝试 1/2");
    expect(text).toContain("已尝试 1 次，最多 2 次");
  });

  it("失败分类翻成中文文案（terminal / retryable），不显示英文枚举", () => {
    render([
      session({
        id: "a",
        title: "配额任务",
        status: "failed",
        lastError: { kind: "terminal", message: "配额耗尽", at: 10 },
      }),
      session({ id: "b", title: "崩溃任务", status: "failed" }),
    ]);
    expand();

    const scope = panel();
    expect(scope.textContent).toContain("不可重试的失败");
    expect(scope.textContent).toContain("可重试的失败");
    expect(scope.textContent).not.toContain("terminal");
    expect(scope.textContent).not.toContain("retryable");
  });

  it("已中断的行不重复挂「已中断」失败 chip（状态文案已表达）", () => {
    render([session({ id: "a", title: "停掉的任务", status: "cancelled" })]);
    expand();
    const occurrences = (panel().textContent ?? "").split("已中断").length - 1;
    expect(occurrences).toBe(1);
  });

  it("有诊断事件的行提供「查看诊断（N 条）」入口，点开就地展开时间线", () => {
    render([
      session({
        id: "a",
        title: "带诊断的任务",
        status: "failed",
        diagnostics: [{ at: 5, kind: "error", level: "error", message: "进程崩溃" }],
      }),
    ]);
    expand();
    // 先展开这一行。
    act(() => rowButton("带诊断的任务").click());

    const entry = buttonByLabel("查看诊断（1 条）");
    act(() => entry.click());

    const scope = panel();
    expect(scope.textContent).toContain("进程崩溃");
    expect(scope.textContent).toContain("收起诊断");
  });
});

describe("旧数据降级 · 回归红线", () => {
  it("没有任何新字段的旧记录：三个视图都不崩溃、不出现 undefined / NaN", () => {
    render([
      session({ id: "a", title: "旧任务一", status: "failed", error: "进程崩溃" }),
      session({ id: "b", title: "旧任务二", status: "completed" }),
    ]);
    expand();

    for (const label of ["子会话", "按波次", "诊断"]) {
      viewTab(label);
      const text = panel().textContent ?? "";
      expect(text).not.toContain("undefined");
      expect(text).not.toContain("NaN");
      expect(text).not.toContain("第 0 波");
      expect(text).not.toContain("尝试 1/1");
      expect(text).not.toContain("第 undefined 波");
    }

    // 回到平铺视图，旧任务仍在。
    viewTab("子会话");
    expect(panel().textContent).toContain("旧任务一");
    expect(panel().textContent).toContain("旧任务二");
  });

  it("空的子会话列表：看板整体不渲染且不抛错", () => {
    expect(() => render([])).not.toThrow();
    // 空列表时看板早返回（只保留飞入体），不提供折叠入口。
    expect(container.querySelector('button[aria-label="超流体看板"]')).toBeNull();
    expect(document.body.textContent ?? "").not.toContain("undefined");
    expect(document.body.textContent ?? "").not.toContain("NaN");
  });
});
