// @vitest-environment jsdom
/**
 * 子会话卡片短描述回归：卡片必须显示委派时的一句话短描述，
 * 而不是把实时 agent 输出（progress）的长文本平铺出来。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuperSessionUi } from "../shared/super-agent";
import {
  shortSuperSessionDescription,
  SuperAgentBoard,
} from "../webview/src/components/SuperAgentBoard";

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

/** 模拟用户截图里那种「标题 + 一长段英文实时输出」的子会话。 */
const LONG_PROGRESS =
  "I'll start by setting up a todo list and reading the relevant source files to verify each " +
  "issue's mechanics and exact line numbers before making changes. Now let me read the four " +
  "source files in parallel. Starting with 'adapter.js' which has the most issues.";

function session(overrides: Partial<SuperSessionUi> = {}): SuperSessionUi {
  return {
    id: "super-short-desc",
    title: "QQ传输层鲁棒性修复",
    task: "修复传输层重连与序号问题并补 qq 单测",
    status: "running",
    isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/a", baseRef: "abc" },
    createdAt: 1000,
    updatedAt: 1000,
    reports: [],
    progress: LONG_PROGRESS,
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  send.mockReset();
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

function render(sessions: SuperSessionUi[]): void {
  store.current = {
    state: { superSessions: sessions, qqTasks: [] },
    superTranscripts: {},
    send,
  };
  act(() => root.render(<SuperAgentBoard />));
}

function boardControl(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('button[aria-label="子会话看板"]');
  expect(el).toBeTruthy();
  return el!;
}

function rowButton(title: string): HTMLButtonElement {
  const el = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    (b.textContent ?? "").includes(title),
  );
  expect(el).toBeTruthy();
  return el!;
}

// ---------------------------------------------------------------------------
// 纯函数：短描述取委派任务首句，回退 title，跳标题、单行截断
// ---------------------------------------------------------------------------
describe("shortSuperSessionDescription", () => {
  it("取 task 的首句有效正文，不取 progress", () => {
    expect(
      shortSuperSessionDescription(
        session({
          task: "修复传输层重连与序号问题并补 qq 单测\n\n```\nnpm test\n```\n提交改动",
          progress: LONG_PROGRESS,
        }),
      ),
    ).toBe("修复传输层重连与序号问题并补 qq 单测");
  });

  it("跳过 markdown 标题与中文方括号小节，取第一句正文", () => {
    expect(
      shortSuperSessionDescription(
        session({ task: "# 目标\n【前置检查（重要，先做）】\n先读四个源文件再动手" }),
      ),
    ).toBe("先读四个源文件再动手");
  });

  it("task 为空时回退到 title", () => {
    expect(shortSuperSessionDescription(session({ task: "", title: "修复登录跳转" }))).toBe(
      "修复登录跳转",
    );
  });

  it("超长首句单行截断并带省略号", () => {
    const long = "甲".repeat(200);
    const out = shortSuperSessionDescription(session({ task: long }));
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(96);
    expect(out).not.toContain("\n");
  });
});

// ---------------------------------------------------------------------------
// 组件：展开的卡片只显示短描述，不铺开 progress
// ---------------------------------------------------------------------------
describe("子会话卡片主视图", () => {
  it("展开卡片显示委派短描述，不渲染长段实时输出", () => {
    render([session()]);
    act(() => boardControl().click()); // 展开看板
    act(() => rowButton("QQ传输层鲁棒性修复").click()); // 展开该行详情

    const body = document.body.textContent ?? "";
    expect(body).toContain("修复传输层重连与序号问题并补 qq 单测");
    // 长实时进度日志不应出现在卡片上（仅在「查看实时进度」弹窗里才有）
    expect(body).not.toContain("I'll start by setting up a todo list");
    expect(body).not.toContain("Starting with 'adapter.js'");
  });

  it("查看实时进度入口仍在（长文本可按需查看）", () => {
    render([session()]);
    act(() => boardControl().click());
    act(() => rowButton("QQ传输层鲁棒性修复").click());

    const btn = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.textContent ?? "").trim() === "查看实时进度",
    );
    expect(btn).toBeTruthy();
  });
});