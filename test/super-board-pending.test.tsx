// @vitest-environment jsdom
/**
 * Super Agent 看板的可访问性与语义契约。
 *
 * 这一组用例锁住的是「同一个 ask_user_question 在两个界面里必须一样」以及
 * 「看板不能只靠颜色/hover 传递关键事实」：
 *
 *  - 看板的提问区与主会话提问卡共用同一套题目渲染：单选 radiogroup、多选
 *    checkbox 语义、选项的 description 副文案可见、自由文本入口、宿主真实
 *    截止时间的倒计时。
 *  - 「子会话免确认」是安全事实，必须常驻可见（不依赖 hover）。
 *  - 状态必须颜色 + 文案 + 形状三重编码：折叠态一行也要能读出六种状态，
 *    且「准备中」与「等待你处理」必须一眼可分。
 *  - 合并按钮置灰时，禁用原因必须能被读到（aria-label / title，且不依赖
 *    pointer-events 被禁用）。
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

vi.mock("../webview/src/i18n", () => ({
  t: (s: string, ...args: Array<string | number>) => {
    let out = s;
    args.forEach((arg, i) => {
      out = out.replaceAll(`{${i}}`, String(arg));
    });
    return out;
  },
}));

const send = vi.fn();

function baseSession(overrides: Partial<SuperSessionUi> = {}): SuperSessionUi {
  return {
    id: "super-1",
    title: "修复登录跳转",
    task: "修好 src/auth.ts 的登录跳转并补单测",
    status: "running",
    isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/a", baseRef: "abc" },
    createdAt: 1000,
    updatedAt: 1000,
    reports: [],
    ...overrides,
  };
}

/** 一个正在等用户回答的子会话：两题（单选 + 多选），选项都带 description。 */
function askingSession(overrides: Partial<SuperSessionUi> = {}): SuperSessionUi {
  return baseSession({
    id: "super-ask",
    title: "要覆盖哪些范围",
    status: "awaiting_input",
    pending: {
      kind: "question",
      requestId: "req-1",
      deadline: Date.now() + 240_000,
      timeoutMs: 300_000,
      questions: [
        {
          header: "范围",
          question: "这一组单测要覆盖哪些范围？",
          multiSelect: false,
          options: [
            { label: "只覆盖用量估算", description: "范围小、跑得快" },
            { label: "连压缩卡一起覆盖", description: "更完整，但要多写夹具" },
          ],
        },
        {
          header: "夹具",
          question: "要准备哪些夹具？",
          multiSelect: true,
          options: [
            { label: "临时目录", description: "用 mkdtemp" },
            { label: "假 SecretStorage", description: "注入式实现" },
          ],
        },
      ],
    },
    ...overrides,
  });
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
    takeRecords(): [] {
      return [];
    }
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
  store.current = { state: { superSessions: sessions }, superTranscripts: {}, send };
  act(() => root.render(<SuperAgentBoard />));
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label,
  );
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text);
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

function rowButton(title: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(title),
  );
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

/** 展开看板（幂等）：有子会话在等回答时看板会自动展开，再点一次反而会收起。 */
function expandBoard(): void {
  const toggle = buttonByLabel("展开子会话看板");
  if (toggle.getAttribute("aria-expanded") === "false") act(() => toggle.click());
}

describe("看板提问区与主会话提问卡同源", () => {
  it("单选题是 radiogroup，多选题是 checkbox 语义，选项 description 可见", () => {
    render([askingSession()]);

    const radioGroup = container.querySelector('[role="radiogroup"]');
    expect(radioGroup).toBeTruthy();
    expect(radioGroup!.getAttribute("aria-label")).toBe("这一组单测要覆盖哪些范围？");
    expect(radioGroup!.querySelectorAll('[role="radio"]').length).toBe(2);

    // 多选：项目里的「checkboxgroup」= role=group + role=checkbox 子项
    // （ARIA 没有 checkboxgroup 这个 role，kit 的 OptionGroup 就是这么编码的）。
    const multiGroup = [...container.querySelectorAll('[role="group"]')].find(
      (g) => g.getAttribute("aria-label") === "要准备哪些夹具？",
    );
    expect(multiGroup).toBeTruthy();
    expect(multiGroup!.querySelectorAll('[role="checkbox"]').length).toBe(2);

    // 选项的副文案不能被丢弃 —— 它是用户判断该选哪个的依据。
    expect(container.textContent).toContain("范围小、跑得快");
    expect(container.textContent).toContain("更完整，但要多写夹具");
    expect(container.textContent).toContain("用 mkdtemp");
    expect(container.textContent).toContain("注入式实现");
  });

  it("提供自由文本作答入口", () => {
    render([askingSession()]);
    const custom = container.querySelector<HTMLButtonElement>('button[aria-label="填写自定义回答"]');
    expect(custom).toBeTruthy();
    act(() => custom!.click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label*="自定义回答"]');
    expect(input).toBeTruthy();
  });

  it("展示按宿主真实截止时间计算的「未回答按未回答继续」倒计时", () => {
    render([askingSession()]);
    // 宿主给的 deadline 是 4 分钟后、窗口 5 分钟：安静档显示「约 4 分钟后按未回答继续」。
    expect(container.textContent).toContain("分钟后按未回答继续");
  });

  it("作答后把答案回传给宿主（按 header 索引）", () => {
    render([askingSession()]);
    const firstRadio = container.querySelectorAll('[role="radio"]')[0]!;
    act(() => firstRadio.click());
    act(() => buttonByText("提交回答").click());

    expect(send).toHaveBeenCalledWith({
      type: "superAgent",
      action: "respond",
      sessionId: "super-ask",
      answers: { 范围: "只覆盖用量估算" },
    });
  });

  it("「不回答并继续」按空答案回传（子会话继续跑）", () => {
    render([askingSession()]);
    act(() => buttonByText("不回答并继续").click());
    expect(send).toHaveBeenCalledWith({
      type: "superAgent",
      action: "respond",
      sessionId: "super-ask",
      answers: {},
    });
  });
});

describe("看板的安全事实常驻可见", () => {
  it("「免确认」不依赖 hover 就出现在看板上，并说明 shell 也直接执行", () => {
    render([baseSession()]);
    const marker = container.querySelector<HTMLElement>('[title*="shell"]');
    expect(marker).toBeTruthy();
    expect(marker!.textContent).toContain("免确认");
    // 可见，不是只有读屏/hover 才拿得到的隐藏文本。
    expect(marker!.className).not.toContain("sr-only");
    expect(marker!.closest(".sr-only")).toBeNull();
  });
});

describe("看板状态编码", () => {
  it("状态不只用颜色：每行都有形状与文案，准备中与等待你处理可区分", () => {
    render([
      baseSession({ id: "a", title: "准备中的任务", status: "preparing" }),
      baseSession({ id: "b", title: "等我的任务", status: "awaiting_input" }),
    ]);
    expandBoard();

    const preparing = rowButton("准备中的任务");
    const awaiting = rowButton("等我的任务");

    // 文案（第一重）
    expect(preparing.textContent).toContain("准备中");
    expect(awaiting.textContent).toContain("等待你处理");
    // 形状（第二重）：两个状态的图标不是同一个。
    const iconOf = (row: HTMLElement) => row.querySelector("svg")?.outerHTML ?? "";
    expect(iconOf(preparing)).toBeTruthy();
    expect(iconOf(preparing)).not.toBe(iconOf(awaiting));
  });

  it("状态变化会被 aria-live 播报（首次挂载不念，变了才念）", () => {
    render([baseSession({ id: "a", title: "准备中的任务", status: "preparing" })]);
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).toBeTruthy();
    // 刚打开看板时不必把整列状态念一遍。
    expect(live!.textContent).toBe("");

    // 状态真的变了 → 播报这一条。
    render([baseSession({ id: "a", title: "准备中的任务", status: "running" })]);
    expect(live!.textContent).toContain("准备中的任务");
    expect(live!.textContent).toContain("运行中");
  });
});

describe("看板计数 chip 的可访问名", () => {
  it("计数 chip 带 aria-label（不只是一个裸数字）", () => {
    render([
      baseSession({ id: "a", title: "任务甲", status: "running" }),
      baseSession({ id: "b", title: "任务乙", status: "running" }),
    ]);
    const chips = [...container.querySelectorAll('[aria-label]')].filter((el) =>
      (el.getAttribute("aria-label") ?? "").includes("个进行中"),
    );
    expect(chips.length).toBeGreaterThan(0);
  });
});

describe("合并按钮的禁用原因可见", () => {
  it("已合并时按钮置灰但原因可读（aria-disabled + title + 可见文案）", () => {
    render([
      baseSession({
        id: "m",
        title: "已合并的任务",
        status: "completed",
        integration: { mode: "merge", state: "merged", at: 2000 },
      }),
    ]);
    expandBoard();
    // 已合并的子会话折叠在历史分组里，先把它展开。
    act(() => buttonByLabel("展开已完成的子会话").click());
    act(() => rowButton("已合并的任务").click());

    const merge = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("让智能体合并"),
    );
    expect(merge).toBeTruthy();
    // 不是 disabled：kit 的 disabled 样式会吞掉 pointer-events，title 就读不到了。
    expect(merge!.hasAttribute("disabled")).toBe(false);
    expect(merge!.getAttribute("aria-disabled")).toBe("true");
    expect(merge!.getAttribute("title")).toContain("该子会话的改动已经合并");
    expect(merge!.getAttribute("aria-label")).toContain("该子会话的改动已经合并");
    // 原因也直接写在行里，不依赖 hover。
    expect(container.textContent).toContain("该子会话的改动已经合并");

    // 置灰状态下点了也不能派发合并。
    act(() => merge!.click());
    expect(send).not.toHaveBeenCalled();
  });
});
