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
  const el = container.querySelector<HTMLButtonElement>('button[aria-label="超流体看板"]');
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
describe("超流体卡片主视图", () => {
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

// ---------------------------------------------------------------------------
// 组件：完整任务描述可就地展开 / 收起
// ---------------------------------------------------------------------------
describe("超流体卡片任务描述展开全文", () => {
  // 首行 150 字（会被截到 95 + 省略号），第二 / 三段只存在于完整 task 里。
  const LONG_TASK = "甲".repeat(150) + "\n第二段任务说明：这是短描述之外的内容\n第三段收尾";

  function renderExpandable(): void {
    render([session({ task: LONG_TASK, title: "长任务展开测试" })]);
    act(() => boardControl().click());
    act(() => rowButton("长任务展开测试").click());
  }

  function findToggleByText(text: string): HTMLButtonElement {
    const el = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => (b.textContent ?? "").trim() === text,
    );
    expect(el).toBeTruthy();
    return el!;
  }

  it("点击「展开全文」后 DOM 出现短描述截断之后的正文", () => {
    renderExpandable();
    // 折叠态只有 95 字截断串，不含被截断掉的内容
    expect(document.body.textContent ?? "").toContain("甲".repeat(95) + "…");
    expect(document.body.textContent ?? "").not.toContain("第二段任务说明");

    act(() => findToggleByText("展开全文").click());

    const body = document.body.textContent ?? "";
    // 第 96 字之后的正文（超过 95 字的甲 + 第二 / 三段）出现
    expect(body).toContain("甲".repeat(100));
    expect(body).toContain("第二段任务说明：这是短描述之外的内容");
    expect(body).toContain("第三段收尾");
  });

  it("展开 / 收起切换 aria-expanded 与可访问名、文案", () => {
    renderExpandable();
    const toggle = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.getAttribute("aria-label") === "展开任务说明",
    );
    expect(toggle).toBeTruthy();
    expect(toggle!.getAttribute("aria-expanded")).toBe("false");

    act(() => toggle!.click());
    expect(toggle!.getAttribute("aria-expanded")).toBe("true");
    expect(toggle!.getAttribute("aria-label")).toBe("收起任务说明");
    expect((toggle!.textContent ?? "").trim()).toBe("收起全文");

    act(() => toggle!.click());
    expect(toggle!.getAttribute("aria-expanded")).toBe("false");
    expect(toggle!.getAttribute("aria-label")).toBe("展开任务说明");
    expect((toggle!.textContent ?? "").trim()).toBe("展开全文");
  });

  it("收起后回到短描述（截断串），不再显示完整正文", () => {
    renderExpandable();
    act(() => findToggleByText("展开全文").click());
    expect(document.body.textContent ?? "").toContain("第二段任务说明");

    act(() => findToggleByText("收起全文").click());
    const body = document.body.textContent ?? "";
    expect(body).not.toContain("第二段任务说明");
    expect(body).not.toContain("第三段收尾");
    expect(body).toContain("甲".repeat(95) + "…");
  });

  it("短任务不显示展开入口", () => {
    render([session()]); // task 是单行短句，完整正文 === 短描述
    act(() => boardControl().click());
    act(() => rowButton("QQ传输层鲁棒性修复").click());
    const toggles = [...document.body.querySelectorAll<HTMLButtonElement>("button")].filter(
      (b) => b.getAttribute("aria-label") === "展开任务说明",
    );
    expect(toggles.length).toBe(0);
  });
});