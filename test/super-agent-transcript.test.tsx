// @vitest-environment jsdom
/**
 * Super Agent board — "查看实时操作" dialog.
 *
 * A child session runs in its own CLI process, so its transcript never enters
 * the main `blocks`; it rides the dedicated `superTranscripts` channel and is
 * rendered with the SAME `BlockView` as the main transcript. These cases pin
 * the data path + dialog behavior as real DOM interaction:
 *
 *  - the row only offers the entry once the board is expanded;
 *  - opening with no local buffer asks the host for the full transcript;
 *  - the opened dialog renders the child's user / tool / text blocks (tool
 *    card resolves its presentation label, i.e. the component wiring is real);
 *  - the dialog closes from its header button and leaves only the row entry.
 *
 * The incremental merge (`from > 0`) lives in `webview/src/store.ts`
 * `applyHostMessage`, not in this component — it is not re-tested here.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../shared/messages";
import type { SuperSessionUi } from "../shared/super-agent";
import { shortBranch, SuperAgentBoard } from "../webview/src/components/SuperAgentBoard";
import { BlockView } from "../webview/src/components/MessageList";

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

function session(overrides: Partial<SuperSessionUi> = {}): SuperSessionUi {
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

const USER_TASK = "修复登录跳转的回归用例";
const ASSISTANT_TEXT = "已完成登录跳转的修复并补了单测。";
const USER_BLOCK: Block = { kind: "user", id: "b-user", text: USER_TASK };
/** `run_shell_command` resolves to the 执行命令 presentation label — proves
 * the real ToolCard rendered, not a stub. */
const TOOL_BLOCK: Block = {
  kind: "tool",
  id: "b-tool",
  toolCallId: "tool-1",
  toolName: "run_shell_command",
  title: "run_shell_command",
  toolKind: "execute",
  status: "completed",
  output: "",
  locations: [],
  diff: null,
};
const TEXT_BLOCK: Block = { kind: "text", id: "b-text", text: ASSISTANT_TEXT };

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

function render(
  superTranscripts: Record<string, Block[]> = {},
  overrides: Partial<SuperSessionUi> = {},
): void {
  store.current = {
    state: { superSessions: [session(overrides)] },
    superTranscripts,
    send,
  };
  act(() => root.render(<SuperAgentBoard />));
}

// The board panel is PORTALED to document.body (it must sit outside the
// acrylic header's backdrop root to blur the real backdrop), so every
// panel-side query runs on the document — the React mount only holds the
// collapsed control.
function clickText(text: string): void {
  const button = [...document.body.querySelectorAll("button")].find((b) => b.textContent === text);
  expect(button).toBeTruthy();
  act(() => button!.click());
}

function clickLabel(label: string): void {
  const button = [...document.body.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label,
  );
  expect(button).toBeTruthy();
  act(() => button!.click());
}

/** Expand one child's detail by clicking its single-line row. */
function clickRow(title: string): void {
  const button = [...document.body.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").includes(title),
  );
  expect(button).toBeTruthy();
  act(() => button!.click());
}

describe("超流体实时进度面板", () => {
  it("折叠时无行；展开看板只显示单行；再展开该行才出现「查看实时进度」", () => {
    render();
    expect(document.body.textContent).not.toContain("修复登录跳转");
    expect(document.body.textContent).not.toContain("查看实时进度");

    clickLabel("超流体看板");
    expect(document.body.textContent).toContain("修复登录跳转");
    expect(document.body.textContent).toContain("运行中");
    // P1: actions live in the row detail, not on the line.
    expect(document.body.textContent).not.toContain("查看实时进度");

    clickRow("修复登录跳转");
    expect(document.body.textContent).toContain("查看实时进度");
  });

  it("打开面板时本地无转录 → 向宿主拉取该超流体的全量转录", () => {
    render();
    clickLabel("超流体看板");
    clickRow("修复登录跳转");
    clickText("查看实时进度");

    expect(send).toHaveBeenCalledWith({
      type: "superAgent",
      action: "transcript",
      sessionId: "super-1",
    });
    // The dialog portals onto document.body, so it is outside `container`; a
    // running child with nothing buffered yet reads as "暂无输出".
    expect(document.body.textContent).toContain("暂无输出");
  });

  it("有转录时渲染 user / tool / text 三类块（工具卡走真实 ToolCard）", () => {
    render({ "super-1": [USER_BLOCK, TOOL_BLOCK, TEXT_BLOCK] });
    clickLabel("超流体看板");
    clickRow("修复登录跳转");
    clickText("查看实时进度");

    const text = document.body.textContent ?? "";
    expect(text).toContain(USER_TASK);
    expect(text).toContain("执行命令");
    expect(text).toContain(ASSISTANT_TEXT);
    // The buffer is already local — no needless full pull.
    expect(send).not.toHaveBeenCalledWith({
      type: "superAgent",
      action: "transcript",
      sessionId: "super-1",
    });
  });

  it("F1 恢复快照（含宿主已裁剪块）在详情面板照常渲染并如实标注已释放", () => {
    // 终态落盘写的是 evictBlockPayloads 裁剪后的窗口：旧块 output 为空、
    // evicted:true。宿主恢复时按 from:0 整份推来，详情面板必须能渲染它，
    // 而不是把「已裁剪历史转录」当空白或报错。
    const evictedTool: Block = { ...TOOL_BLOCK, evicted: true, output: "", hadDiff: false };
    const restoredText: Block = { kind: "text", id: "b-restored", text: "重启恢复后的结论" };
    render({ "super-1": [evictedTool, restoredText] });
    clickLabel("超流体看板");
    clickRow("修复登录跳转");
    clickText("查看实时进度");

    const text = document.body.textContent ?? "";
    expect(text).toContain("重启恢复后的结论");
    expect(text).toContain("内容已释放"); // 旧载荷如实标注，不假装还在
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    // Buffer came from the restore push — no needless full pull.
    expect(send).not.toHaveBeenCalledWith({
      type: "superAgent",
      action: "transcript",
      sessionId: "super-1",
    });
  });

  it("实时操作里的转录块走极简档：工具卡无卡片表面、状态是纯文字；主转录默认档仍是卡片", () => {
    render({
      "super-1": [
        TOOL_BLOCK,
        { kind: "thought", id: "b-thought", text: "先确认 redirect 的判断条件" },
      ],
    });
    clickLabel("超流体看板");
    clickRow("修复登录跳转");
    clickText("查看实时进度");

    const dialog = document.querySelector('[role="dialog"]');
    const flatCard = dialog!.querySelector<HTMLElement>(".tool-card");
    expect(flatCard).toBeTruthy();
    expect(flatCard!.classList.contains("tool-card-flat")).toBe(true);
    for (const cls of ["shadow-card", "bg-card", "card-lift", "stream-in", "border", "rounded-lg"]) {
      expect(flatCard!.classList.contains(cls)).toBe(false);
    }
    // Header padding is the tightened flat row.
    expect(flatCard!.firstElementChild!.className).toContain("px-2");
    expect(flatCard!.firstElementChild!.className).toContain("py-1");
    // Status reads as a caption line, not a chip.
    expect(flatCard!.textContent).toContain("已完成");
    expect(flatCard!.querySelector(".chip-fade")).toBeNull();
    // The thought row is a bare chevron + label, no framed card.
    const thoughtToggle = [...dialog!.querySelectorAll<HTMLElement>("button")].find(
      (el) => el.textContent === "思考过程",
    );
    expect(thoughtToggle).toBeTruthy();
    expect(thoughtToggle!.parentElement!.classList.contains("rounded-sm")).toBe(true);
    expect(thoughtToggle!.parentElement!.classList.contains("shadow-card")).toBe(false);
    expect(dialog!.querySelector(".thought-body")!.className).not.toContain("border-t");

    // Main transcript default chrome keeps the card surface it always had.
    const host = document.createElement("div");
    document.body.append(host);
    const mainRoot = createRoot(host);
    act(() =>
      mainRoot.render(
        <BlockView
          block={TOOL_BLOCK}
          isLatest
          turnActive={false}
          canCopy
          canRegenerate={false}
          canDelete={false}
          showAvatar
          onRegenerate={() => {}}
        />,
      ),
    );
    const card = host.querySelector<HTMLElement>(".tool-card");
    expect(card).toBeTruthy();
    expect(card!.classList.contains("shadow-card")).toBe(true);
    expect(card!.classList.contains("bg-card")).toBe(true);
    expect(card!.classList.contains("stream-in")).toBe(true);
    expect(card!.classList.contains("tool-card-flat")).toBe(false);
    act(() => mainRoot.unmount());
    host.remove();
  });

  it("实时进度以弹框呈现，头部关闭后回到行内入口", () => {
    render({ "super-1": [USER_BLOCK] });
    clickLabel("超流体看板");
    clickRow("修复登录跳转");
    clickText("查看实时进度");

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.getAttribute("aria-label")).toBe("超流体实时进度");
    expect(dialog!.textContent).toContain(USER_TASK);

    // ModalShell 的关闭按钮统一为 t("关闭")（ui.tsx）；「收起」是看板折叠
    // 控件的标签，不是弹框关闭按钮 —— 这里按产品的真实语义查找。
    const close = document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="关闭"]');
    expect(close).toBeTruthy();
    act(() => close!.click());

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).not.toContain(USER_TASK);
    // The row keeps a single entry point — no inline pane state left behind.
    expect(document.body.textContent).toContain("查看实时进度");
  });
});

describe("历史超流体（restored）的转录详情入口", () => {
  const restored = { restored: true, status: "completed" as const };

  it("有已保存转录时放行详情入口，文案按历史区分，点击可打开并渲染转录", () => {
    render({ "super-1": [USER_BLOCK, TEXT_BLOCK] }, restored);
    clickLabel("超流体看板");
    clickRow("修复登录跳转");

    // 历史会话入口是「查看已保存的转录」，不再是写死的「查看实时进度」。
    expect(document.body.textContent).toContain("查看已保存的转录");
    expect(document.body.textContent).not.toContain("查看实时进度");
    // 恢复的会话没有活进程可重试，重试入口保持隐藏。
    expect(document.body.textContent).not.toContain("重试");

    clickText("查看已保存的转录");

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.getAttribute("aria-label")).toBe("超流体历史转录");
    const text = dialog!.textContent ?? "";
    expect(text).toContain(USER_TASK);
    expect(text).toContain(ASSISTANT_TEXT);
    expect(text).toContain("已保存的转录");
    expect(text).not.toContain("实时输出");
    // 快照已在本地（恢复时宿主按 from:0 推来），不向已死的进程拉全量。
    expect(send).not.toHaveBeenCalledWith({
      type: "superAgent",
      action: "transcript",
      sessionId: "super-1",
    });
  });

  it("无转录时详情入口仍隐藏，不给一个点了没内容的按钮", () => {
    render({}, restored);
    clickLabel("超流体看板");
    clickRow("修复登录跳转");

    expect(document.body.textContent).not.toContain("查看已保存的转录");
    expect(document.body.textContent).not.toContain("查看实时进度");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("超流体合并入口", () => {
  it("运行中的超流体不允许合并（按钮置灰，禁用原因由帮助按钮统一说明）", () => {
    render();
    clickLabel("超流体看板");
    clickRow("修复登录跳转");

    const button = [...document.body.querySelectorAll("button")].find(
      (b) => b.textContent === "让智能体合并",
    );
    expect(button).toBeTruthy();
    // 置灰用 aria-disabled 而不是 disabled：kit 的 disabled 样式会吞掉
    // pointer-events，title（唯一写着原因的地方）就读不到了。
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button!.getAttribute("aria-disabled")).toBe("true");
    expect(button!.getAttribute("title")).toContain("超流体还没结束，等它完成再合并");
    // 原因不再逐行重复：行首的状态 chip 已经说明子会话还在运行，
    // 完整规则统一收在看板头的帮助按钮里（见下一组用例）。
    expect(document.body.textContent).not.toContain("超流体还没结束，等它完成再合并");
  });

  it("完成态点击后确认框说明由智能体自己合并，确认才发 action=merge", () => {
    render({}, { status: "completed" });
    clickLabel("超流体看板");
    clickRow("修复登录跳转");
    clickText("让智能体合并");

    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog).toBeTruthy();
    // The request is executed BY the agent, and conflicts are its problem.
    expect(dialog!.textContent).toContain("它会自己完成合并并处理冲突");
    expect(dialog!.textContent).toContain("iflow/super/a");

    const confirm = [...dialog!.querySelectorAll("button")].find(
      (b) => b.textContent === "让智能体合并分支",
    );
    expect(confirm).toBeTruthy();
    act(() => confirm!.click());

    expect(send).toHaveBeenCalledWith({
      type: "superAgent",
      action: "merge",
      sessionId: "super-1",
    });
  });
});

describe("超流体中断确认", () => {
  /** Click a button by its text inside the confirm dialog (portalled to body). */
  function clickTextInDialog(text: string, dialog: Element): void {
    const button = [...dialog.querySelectorAll("button")].find((b) => b.textContent === text);
    expect(button).toBeTruthy();
    act(() => button!.click());
  }

  it("行内中断先弹确认框，未确认前不发送 cancel", () => {
    render();
    clickLabel("超流体看板");
    clickLabel("中断这个超流体");

    expect(send).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain("中断超流体「修复登录跳转」？");

    clickTextInDialog("中断", dialog!);
    expect(send).toHaveBeenCalledWith({
      type: "superAgent",
      action: "cancel",
      sessionId: "super-1",
    });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("取消中断只关闭确认框，不发送任何消息", () => {
    render();
    clickLabel("超流体看板");
    clickLabel("中断这个超流体");

    clickTextInDialog("取消", document.querySelector('[role="alertdialog"]')!);

    expect(send).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("全部中断先弹确认框，确认后才发送 cancelAll", () => {
    render();
    // 「全部中断」住在展开面板的头部（折叠控件只有开关本身），先展开看板。
    clickLabel("超流体看板");
    clickLabel("全部中断");

    expect(send).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain("中断全部 1 个进行中的超流体？");

    clickTextInDialog("全部中断", dialog!);
    expect(send).toHaveBeenCalledWith({ type: "superAgent", action: "cancelAll" });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });
});

describe("Super Agent 看板排序与折叠", () => {
  const notMerged = (id: string, title: string, createdAt: number): SuperSessionUi =>
    session({
      id,
      title,
      status: "completed",
      createdAt,
      integration: { mode: "merge", state: "skipped", at: createdAt + 10 },
    });

  const merged = (id: string, title: string, createdAt: number): SuperSessionUi =>
    session({
      id,
      title,
      status: "completed",
      createdAt,
      integration: { mode: "merge", state: "merged", at: createdAt + 10 },
    });

  function renderMany(sessions: SuperSessionUi[]): void {
    store.current = { state: { superSessions: sessions }, superTranscripts: {}, send };
    act(() => root.render(<SuperAgentBoard />));
  }

  it("进行中的超流体排在前面，改动没落地的排其后", () => {
    renderMany([
      notMerged("super-done", "待合并的任务", 1000),
      session({ id: "super-live", title: "进行中的任务", status: "running", createdAt: 2000 }),
      session({ id: "super-ask", title: "等我回答的任务", status: "awaiting_input", createdAt: 3000 }),
    ]);
    // 有子会话等待回答 → 看板自动展开，不需要（也不应该）再点一次。

    const text = document.body.textContent ?? "";
    expect(text.indexOf("等我回答的任务")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("等我回答的任务")).toBeLessThan(text.indexOf("进行中的任务"));
    expect(text.indexOf("进行中的任务")).toBeLessThan(text.indexOf("待合并的任务"));
  });

  it("已完成且已自动合并的超流体默认折叠，展开分组后才可见", () => {
    renderMany([
      session({ id: "super-live", title: "进行中的任务", status: "running", createdAt: 2000 }),
      merged("super-merged", "已合并的任务", 1000),
    ]);
    clickLabel("超流体看板");

    // Folded away: only a one-line history row, no card, no title.
    expect(document.body.textContent).toContain("已完成并合并的 1 个超流体");
    expect(document.body.textContent).not.toContain("已合并的任务");

    clickLabel("展开已完成的超流体");
    expect(document.body.textContent).toContain("已合并的任务");
  });

  const nothingToMerge = (id: string, title: string, createdAt: number): SuperSessionUi =>
    session({
      id,
      title,
      status: "completed",
      createdAt,
      integration: { mode: "merge", state: "not_needed", at: createdAt + 10 },
    });

  it("没有产生任何提交的超流体折叠行说「无需合并」，绝不谎报成已合并", () => {
    renderMany([
      session({ id: "super-live", title: "进行中的任务", status: "running", createdAt: 2000 }),
      nothingToMerge("super-empty", "没有改动的任务", 1000),
    ]);
    clickLabel("超流体看板");

    const text = document.body.textContent ?? "";
    // 元提交（not_needed）不是合并：标题与 chip 都必须如实。
    expect(text).toContain("已完成、无需合并的 1 个超流体");
    expect(text).toContain("无需合并");
    expect(text).not.toContain("已完成并合并");
    expect(text).not.toContain("已自动合并");
  });

  it("折叠分组混合时只给总数，两种结果分 chip 显示（只有 merged 才算已合并）", () => {
    renderMany([
      session({ id: "super-live", title: "进行中的任务", status: "running", createdAt: 3000 }),
      merged("super-merged", "已合并的任务", 1000),
      nothingToMerge("super-empty", "没有改动的任务", 2000),
    ]);
    clickLabel("超流体看板");

    const text = document.body.textContent ?? "";
    expect(text).toContain("已完成的 2 个超流体");
    expect(text).not.toContain("已完成并合并的 2 个超流体");
    // 两个 chip 同时在场：一条真合并、一条无需合并。
    const chips = [...document.body.querySelectorAll(".chip-fade")].map((el) => el.textContent);
    expect(chips).toContain("已自动合并");
    expect(chips).toContain("无需合并");
  });

  it("一次只展开一行详情", () => {
    renderMany([
      session({ id: "super-a", title: "任务甲", status: "running", createdAt: 1000 }),
      session({ id: "super-b", title: "任务乙", status: "running", createdAt: 2000 }),
    ]);
    clickLabel("超流体看板");

    const rowButton = (title: string) =>
      [...document.body.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(title))!;
    const entryCount = () =>
      [...document.body.querySelectorAll("button")].filter((b) => b.textContent === "查看实时进度").length;

    clickRow("任务甲");
    expect(rowButton("任务甲").getAttribute("aria-expanded")).toBe("true");
    expect(entryCount()).toBe(1);

    clickRow("任务乙");
    expect(rowButton("任务甲").getAttribute("aria-expanded")).toBe("false");
    expect(rowButton("任务乙").getAttribute("aria-expanded")).toBe("true");
    // 甲的详情已收起，只剩乙的一份入口。
    expect(entryCount()).toBe(1);
  });

  it("有超流体等待回答时自动展开；全部已完成且已合并后自动收起", () => {
    // 折叠控件留在 header 里（只有浮层被 portal 出去），所以这里查挂载点。
    const boardExpanded = () =>
      container
        .querySelector('button[aria-label="超流体看板"]')
        ?.getAttribute("aria-expanded");

    renderMany([
      session({ id: "super-ask", title: "等我回答的任务", status: "awaiting_input", createdAt: 1000 }),
    ]);
    expect(boardExpanded()).toBe("true");
    expect(document.body.textContent).toContain("等我回答的任务");

    renderMany([merged("super-m", "已合并的任务", 1000)]);
    expect(boardExpanded()).toBe("false");
  });
});

/**
 * 内置 `super-agent` 工具调用（vendor/iflow-fork/bundle/super-agent-loader.cjs）：
 * toolName `super-agent`、args `{tasks:[{title,task,attachments?}]}`，回
 * `Delegation request accepted.`。上一轮只改了围栏卡，这里钉住 tool 块渲染
 * 路径确实分派到独立委派卡，而不是通用 ToolCard。
 *
 * issue #166：委派卡只回答「派了什么」——工具回执（`Delegation request
 * accepted.`）与「(查看原始参数)」折叠项自此不再出现在卡面上。
 */
describe("内置 super-agent 工具调用卡片", () => {
  const longTask = Array.from(
    { length: 6 },
    (_, i) => `- 第 ${i + 1} 步：在 j:/git/iflow-harness 里核对委派卡表面、任务列表与窄屏布局，确保不回退成通用工具卡。`,
  ).join("\n");
  const payload = JSON.stringify({
    tasks: [
      { title: "补开发期同步说明", task: longTask, attachments: ["image1.png"] },
      { title: "修工具委派卡样式", task: "把内置 super-agent 工具调用从通用 ToolCard 分派到独立委派卡。" },
    ],
  });

  function toolBlock(overrides: Record<string, unknown> = {}): Block {
    return {
      kind: "tool",
      id: "b-super-tool",
      toolCallId: "tc-super-1",
      toolName: "super-agent",
      title: "Delegate 2 tasks",
      toolKind: "other",
      status: "completed",
      output: "Delegation request accepted.",
      input: payload,
      locations: [],
      diff: null,
      ...overrides,
    } as Block;
  }

  function renderBlock(block: Block): void {
    store.current = { state: { superSessions: [] }, superTranscripts: {}, send };
    act(() =>
      root.render(
        <BlockView
          block={block}
          isLatest
          turnActive={false}
          canCopy
          canRegenerate={false}
          canDelete={false}
          showAvatar
          onRegenerate={() => {}}
        />,
      ),
    );
  }

  it("super-agent tool_call 渲染成独立委派卡，不再走 ToolCard", () => {
    renderBlock(toolBlock());
    const card = container.querySelector<HTMLElement>('[data-testid="super-tool-call-card"]');
    expect(card).toBeTruthy();
    // 与 d7f3d72 的围栏委派卡同一独立表面。
    expect(card!.classList.contains("super-directive-card")).toBe(true);
    expect(card!.className).toContain("bg-primary/10");
    expect(card!.className).toContain("border-primary/35");
    expect(card!.className).toContain("shadow-float");
    for (const cls of ["bg-card", "shadow-card", "tool-card"]) {
      expect(card!.classList.contains(cls)).toBe(false);
    }
    expect(card!.firstElementChild!.className).toContain("bg-primary/60");
    // eyebrow + 高一级标题 + 状态 chip 都在独立卡内。
    expect(card!.textContent).toContain("委派指令");
    expect(card!.textContent).toContain("超流体委派");
    expect(card!.textContent).toContain("已完成");
    const title = [...card!.querySelectorAll("span")].find(
      (span) => span.textContent === "超流体委派",
    );
    expect(title).toBeTruthy();
    expect(title!.className).toContain("text-ui-title");
    const head = card!.children[1] as HTMLElement;
    expect(head.lastElementChild!.className).toContain("shrink-0");
    // tasks JSON 被投影成可读任务列表，原始 JSON 不在默认卡面。
    expect(card!.textContent).toContain("2 个任务");
    expect(card!.textContent).toContain("补开发期同步说明");
    expect(card!.textContent).toContain("修工具委派卡样式");
    expect(card!.textContent).toContain("附件 1");
    expect(card!.querySelectorAll('[data-testid="super-tool-call-task"]')).toHaveLength(2);
    expect(card!.textContent).not.toContain('"tasks"');
    // issue #166：卡片底部不再有工具回执/结果区块。
    expect(card!.textContent).not.toContain("Delegation request accepted.");
    // 通用工具卡的文案与 DOM 一概不再出现。
    expect(card!.textContent).not.toContain("工具操作");
    expect(card!.textContent).not.toContain("执行参数");
    expect(container.querySelector(".tool-card")).toBeNull();
    // 任务说明仍可展开。
    const expand = [...card!.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "展开任务说明",
    );
    expect(expand).toBeTruthy();
    act(() => expand!.click());
    expect(card!.textContent).toContain("第 6 步");
    // issue #166：「(查看原始参数)」折叠入口与原始参数本身一并下线 ——
    // 委派卡只回答「派了什么」，原始 JSON 载荷不再回灌进卡面。
    expect(
      [...card!.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("查看原始参数"),
      ),
    ).toBe(false);
    expect(card!.querySelector('[data-testid="super-tool-call-raw"]')).toBeNull();
    // 原始载荷的 JSON 字段名一个都不该露出来（标题等结构化内容仍在卡上）。
    expect(card!.textContent).not.toContain('"title"');
    expect(card!.textContent).not.toContain('"attachments"');
  });

  it.each([
    ["非法 JSON", '{"tasks":[oops]}'],
    ["未收全的半截载荷", '{"tasks":[{"title":"半截任务","task":"还没写完"'],
  ])("tasks 解析失败时不再摊开原始 JSON，改为具体错误 + 未派发：%s", (_name, input) => {
    renderBlock(toolBlock({ input, status: "in_progress", output: "" }));
    const card = container.querySelector<HTMLElement>('[data-testid="super-tool-call-card"]');
    expect(card).toBeTruthy();
    expect(card!.classList.contains("super-directive-card")).toBe(true);
    // 卡面只回答「哪儿错了、没派发」：具体原因进横幅。
    expect(card!.textContent).toContain("委派指令格式错误：");
    expect(card!.textContent).toContain("载荷不是合法 JSON");
    expect(card!.textContent).toContain("未派发");
    // 工具帧还在 executing，但载荷坏了不能读成「执行中」。
    expect(card!.textContent).not.toContain("执行中");
    expect(card!.querySelector('[data-testid="super-tool-call-invalid"]')).toBeTruthy();
    expect(card!.querySelectorAll('[data-testid="super-tool-call-task"]')).toHaveLength(0);
    expect(card!.textContent).not.toContain("工具操作");
    expect(card!.textContent).not.toContain("执行参数");
    expect(container.querySelector(".tool-card")).toBeNull();
    // 原始 JSON 正文不再渲染（连字段名都不该出现）——只留「复制原始参数」入口。
    expect(card!.querySelector('[data-testid="super-tool-call-raw"]')).toBeNull();
    expect(card!.querySelector("pre")).toBeNull();
    expect(card!.textContent).not.toContain('"tasks"');
    expect(card!.querySelector('button[aria-label="复制原始参数"]')).toBeTruthy();
  });

  it("参数还没到达时仍是 pending 占位，不误报格式错误", () => {
    renderBlock(toolBlock({ input: null, status: "in_progress", output: "" }));
    const card = container.querySelector<HTMLElement>('[data-testid="super-tool-call-card"]');
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain("正在编写任务书…");
    expect(card!.textContent).toContain("执行中");
    expect(card!.textContent).not.toContain("委派指令格式错误");
    expect(card!.textContent).not.toContain("未派发");
    expect(card!.querySelector('[data-testid="super-tool-call-raw"]')).toBeNull();
    expect(card!.querySelectorAll('[data-testid="super-tool-call-task"]')).toHaveLength(0);
  });

  it("宿主写回的 superTasksError 直接渲染成字段级原因（不回解有损 input）", () => {
    renderBlock(
      toolBlock({
        // input 已被展示串截断（回解必然失败），宿主诊断才是真源。
        input: '{"tasks":[{"title":"半截',
        superTasksError: "载荷格式错误：tasks[0].task 必须是字符串",
        status: "completed",
      }),
    );
    const card = container.querySelector<HTMLElement>('[data-testid="super-tool-call-card"]');
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain("委派指令格式错误：tasks[0].task 必须是字符串");
    expect(card!.textContent).toContain("未派发");
    // 工具帧 completed 也不能挂绿色「已完成」——载荷坏了就是没派出去。
    expect(card!.textContent).not.toContain("已完成");
    expect(card!.querySelector('[data-testid="super-tool-call-raw"]')).toBeNull();
    expect(card!.querySelectorAll('[data-testid="super-tool-call-task"]')).toHaveLength(0);
  });

  it("混合载荷：合法任务照常渲染，被丢弃条目给 warning 而不是绿色完成", () => {
    renderBlock(
      toolBlock({
        status: "completed",
        superTasks: [{ title: "保留的任务", task: "做点事", attachmentCount: 0 }],
        superTasksError: "已忽略 1 个格式错误的任务条目（tasks[0].task 必须是字符串）",
      }),
    );
    const card = container.querySelector<HTMLElement>('[data-testid="super-tool-call-card"]');
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain("保留的任务");
    expect(card!.querySelectorAll('[data-testid="super-tool-call-task"]')).toHaveLength(1);
    expect(card!.textContent).toContain("委派指令格式错误：已忽略 1 个格式错误的任务条目");
    expect(card!.textContent).toContain("部分未派发");
    expect(card!.textContent).not.toContain("已完成");
    expect(card!.querySelector('[data-testid="super-tool-call-partial"]')).toBeTruthy();
  });

  it("宿主解析出的 superTasks 直接渲染成任务列表（input 有损也不怕）", () => {
    renderBlock(
      toolBlock({
        // input 是宿主故意做成有损的展示串（长任务书会被从中间切断）——
        // 卡片不靠它解析任务，靠宿主随快照下发的结构。
        input: '{"tasks":[{"task":"只读审查 src/panel/panel.ts 被截断',
        superTasks: [
          {
            title: "只读审查",
            task: "只读审查 src/panel/panel.ts\n第二行说明",
            attachmentCount: 2,
          },
        ],
      }),
    );
    const card = container.querySelector<HTMLElement>('[data-testid="super-tool-call-card"]');
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain("1 个任务");
    expect(card!.textContent).toContain("只读审查");
    expect(card!.textContent).toContain("第二行说明");
    expect(card!.textContent).toContain("附件 2");
    expect(card!.querySelectorAll('[data-testid="super-tool-call-task"]')).toHaveLength(1);
    expect(card!.textContent).not.toContain("委派指令格式错误");
    expect(card!.querySelector('[data-testid="super-tool-call-raw"]')).toBeNull();
  });

  it("模型漏 title 的载荷如实显示字段级错误（title 必填，不再回退 task 全文当标题）", () => {
    // 实测载荷形态：模型调内置 super-agent 工具时漏掉 title。现在 title 必填，
    // 宿主拒绝该条，卡片给出可诊断原因，绝不把整段任务描述顶到标题位。
    renderBlock(
      toolBlock({
        input: '{"tasks":[{"task":"任务：只读审查 AGENTS.md 与 src/panel/panel.ts"}]}',
      }),
    );
    const card = container.querySelector<HTMLElement>('[data-testid="super-tool-call-card"]');
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain("title 必填");
    expect(card!.textContent).not.toContain("正在编写任务书…");
    expect(card!.querySelectorAll('[data-testid="super-tool-call-task"]')).toHaveLength(0);
  });

  it("title 缺失的展示兜底：标题位显示「未命名任务」而不是正文", () => {
    // 历史转录 / 手工快照里可能残留空标题条目 —— 渲染层兜底不能让正文顶到标题位。
    renderBlock(
      toolBlock({
        superTasks: [
          { title: "", task: "项目根目录：任务：背景：整段描述", attachmentCount: 0 },
        ],
      }),
    );
    const card = container.querySelector<HTMLElement>('[data-testid="super-tool-call-card"]');
    expect(card).toBeTruthy();
    const title = card!.querySelector('[data-testid="super-tool-call-task"] span');
    expect(title?.textContent).toBe("未命名任务");
  });

  it("对象形态的 attachments 也能渲染（附件数照常显示）", () => {
    renderBlock(
      toolBlock({
        input: JSON.stringify({
          tasks: [
            {
              title: "带附件",
              task: "做点事",
              attachments: [{ path: "C:/tmp/a.png", name: "a.png" }],
            },
          ],
        }),
      }),
    );
    const card = container.querySelector<HTMLElement>('[data-testid="super-tool-call-card"]');
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain("附件 1");
    expect(card!.textContent).not.toContain("委派指令格式错误");
    expect(card!.querySelectorAll('[data-testid="super-tool-call-task"]')).toHaveLength(1);
  });

  const ACTIONS_INPUT = JSON.stringify({
    actions: [
      { action: "retry", sessionId: "super-a1" },
      { action: "cancel", sessionId: "super-a2" },
      { action: "cleanup", sessionId: "super-a3", keepBranch: true },
      { action: "answer", sessionId: "super-a4", answers: { q1: "方案 A", q2: "方案 B" } },
    ],
  });

  it("super-agent 工具带 actions 载荷渲染成超流体操作卡，不再走通用工具卡", () => {
    renderBlock(toolBlock({ input: ACTIONS_INPUT }));
    const card = container.querySelector<HTMLElement>('[data-testid="super-actions-tool-call-card"]');
    expect(card).toBeTruthy();
    // 与围栏 ActionsCard 同一独立表面，不回退到工具卡材质。
    expect(card!.classList.contains("super-directive-card")).toBe(true);
    expect(card!.className).toContain("bg-primary/10");
    expect(card!.className).toContain("border-primary/35");
    expect(card!.className).toContain("shadow-float");
    for (const cls of ["bg-card", "shadow-card", "tool-card"]) {
      expect(card!.classList.contains(cls)).toBe(false);
    }
    // 标题、计数、状态 chip 与逐项动作都来自围栏动作卡同一套语言/组件。
    expect(card!.textContent).toContain("超流体操作");
    expect(card!.textContent).toContain("4 个动作");
    expect(card!.textContent).toContain("重试");
    expect(card!.textContent).toContain("中断");
    expect(card!.textContent).toContain("清理");
    expect(card!.textContent).toContain("回答");
    expect(card!.textContent).toContain("super-a1");
    expect(card!.textContent).toContain("保留分支");
    expect(card!.textContent).toContain("2 个回答");
    // 工具帧 completed 只表示内核回了 ack，不代表动作真的生效。宿主还没
    // 回填 superActionResult 时显示中性的「已执行」，不再挂绿色「已完成」；
    // 真实成功/失败由回填后的结果 chip 与摘要呈现。
    expect(card!.textContent).toContain("已执行");
    expect(card!.textContent).not.toContain("执行参数");
    expect(card!.querySelectorAll("li")).toHaveLength(4);
    // 委派卡没有接管这条工具帧；管理动作也不是「委派产生子会话」，不挂飞入起点。
    expect(container.querySelector('[data-testid="super-tool-call-card"]')).toBeNull();
    expect(card!.hasAttribute("data-super-delegation-origin")).toBe(false);
    expect(container.querySelector(".tool-card")).toBeNull();
  });

  it("命名空间形态照常识别：actions 载荷走操作卡，tasks 载荷仍是委派卡", () => {
    renderBlock(toolBlock({ toolName: "iflow__super-agent", input: ACTIONS_INPUT }));
    expect(container.querySelector('[data-testid="super-actions-tool-call-card"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="super-tool-call-card"]')).toBeNull();
    expect(container.querySelector(".tool-card")).toBeNull();

    renderBlock(toolBlock({ toolName: "iflow__super-agent" }));
    const dispatch = container.querySelector<HTMLElement>('[data-testid="super-tool-call-card"]');
    expect(dispatch).toBeTruthy();
    expect(dispatch!.textContent).toContain("补开发期同步说明");
    expect(container.querySelector('[data-testid="super-actions-tool-call-card"]')).toBeNull();
    expect(container.querySelector(".tool-card")).toBeNull();
  });

  it("super-agent-actions 工具名也渲染同一张操作卡", () => {
    renderBlock(toolBlock({ toolName: "super-agent-actions", input: ACTIONS_INPUT, status: "failed" }));
    const card = container.querySelector<HTMLElement>('[data-testid="super-actions-tool-call-card"]');
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain("超流体操作");
    expect(card!.textContent).toContain("4 个动作");
    expect(card!.textContent).toContain("失败");
    expect(card!.className).toContain("super-directive-card");
    expect(container.querySelector(".tool-card")).toBeNull();
  });

  it("空 actions / 坏 JSON 诚实降级，只给原因不摊开原始 JSON", () => {
    renderBlock(toolBlock({ toolName: "super-agent-actions", input: '{"actions":[]}' }));
    let card = container.querySelector<HTMLElement>('[data-testid="super-actions-tool-call-card"]');
    expect(card).toBeTruthy();
    expect(card!.getAttribute("role")).toBe("status");
    expect(card!.querySelector('[data-testid="super-actions-tool-call-invalid"]')).toBeTruthy();
    expect(card!.textContent).toContain("委派指令格式错误：里面没有操作列表");
    expect(card!.querySelector('[data-testid="super-actions-tool-call-raw"]')).toBeNull();
    expect(card!.querySelector("pre")).toBeNull();
    expect(card!.textContent).not.toContain('"actions"');
    expect(card!.textContent).not.toContain("个动作");
    expect(card!.querySelectorAll("li")).toHaveLength(0);

    renderBlock(toolBlock({ toolName: "super-agent-actions", input: '{"actions":[oops}' }));
    card = container.querySelector<HTMLElement>('[data-testid="super-actions-tool-call-card"]');
    expect(card!.querySelector('[data-testid="super-actions-tool-call-invalid"]')).toBeTruthy();
    expect(card!.textContent).toContain("委派指令格式错误：内容格式不对，读不出来");
    expect(card!.querySelector('[data-testid="super-actions-tool-call-raw"]')).toBeNull();
    expect(card!.querySelector("pre")).toBeNull();
    expect(card!.textContent).not.toContain("个动作");

    renderBlock(toolBlock({ toolName: "super-agent-actions", input: null }));
    card = container.querySelector<HTMLElement>('[data-testid="super-actions-tool-call-card"]');
    expect(card!.textContent).toContain("正在编写超流体操作…");
    expect(card!.textContent).not.toContain("个动作");

    renderBlock(toolBlock({ toolName: "super-agent-guard", input: ACTIONS_INPUT }));
    expect(container.querySelector('[data-testid="super-actions-tool-call-card"]')).toBeNull();
    expect(container.querySelector(".tool-card")).toBeTruthy();
  });

  it("通用工具卡只留结构化执行参数，不再提供「查看原始参数」折叠入口", () => {
    renderBlock(
      toolBlock({
        toolName: "search_file_content",
        title: "search_file_content",
        toolKind: "search",
        input: '{"pattern":"handleClick","path":"src/App.tsx"}',
        output: "2 matches",
      }),
    );
    const card = container.querySelector<HTMLElement>(".tool-card");
    expect(card).toBeTruthy();
    // 工具名 / 状态照常展示。
    expect(card!.textContent).toContain("搜索文件");
    expect(card!.textContent).toContain("已完成");
    // 结构化参数就是审计面：键与值都摊在卡上。
    expect(card!.textContent).toContain("执行参数");
    expect(card!.textContent).toContain("handleClick");
    // 折叠入口与它展开的原始 JSON 一并下线（issue #166 同源）。
    expect(card!.querySelector(".tool-card-raw-toggle")).toBeNull();
    expect(card!.querySelector(".tool-card-raw")).toBeNull();
    expect(card!.textContent).not.toContain('{"pattern"');
    expect(
      [...card!.querySelectorAll("button")].some((b) => (b.textContent ?? "").includes("原始参数")),
    ).toBe(false);
  });

  it("无结构化参数的降级态仍把原始参数直接摊开，不折叠也不隐藏", () => {
    renderBlock(
      toolBlock({
        toolName: "run_shell_command",
        title: "run_shell_command",
        toolKind: "execute",
        input: "Get-ChildItem src -Recurse",
        output: "",
      }),
    );
    const card = container.querySelector<HTMLElement>(".tool-card");
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain("执行命令");
    expect(card!.textContent).toContain("执行参数");
    expect(card!.textContent).toContain("Get-ChildItem src -Recurse");
    expect(card!.querySelector(".tool-card-raw-toggle")).toBeNull();
  });
});

describe("shortBranch", () => {
  it("只保留 base36 唯一后缀，非 super 分支原样返回", () => {
    expect(shortBranch("iflow/super/修复按钮-mwammvh-1")).toBe("super/…mwammvh-1");
    // 第 6 个子会话起序号是 base36（a、b…），不能被十进制正则退回整条 ref。
    expect(shortBranch("iflow/super/修复按钮-mwammvh-b")).toBe("super/…mwammvh-b");
    expect(shortBranch("feature/login-fix")).toBe("feature/login-fix");
  });
});
