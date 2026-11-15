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

describe("Super Agent 子会话实时操作面板", () => {
  it("折叠时无行；展开看板只显示单行；再展开该行才出现「查看实时操作」", () => {
    render();
    expect(document.body.textContent).not.toContain("修复登录跳转");
    expect(document.body.textContent).not.toContain("查看实时操作");

    clickLabel("子会话看板");
    expect(document.body.textContent).toContain("修复登录跳转");
    expect(document.body.textContent).toContain("运行中");
    // P1: actions live in the row detail, not on the line.
    expect(document.body.textContent).not.toContain("查看实时操作");

    clickRow("修复登录跳转");
    expect(document.body.textContent).toContain("查看实时操作");
  });

  it("打开面板时本地无转录 → 向宿主拉取该子会话的全量转录", () => {
    render();
    clickLabel("子会话看板");
    clickRow("修复登录跳转");
    clickText("查看实时操作");

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
    clickLabel("子会话看板");
    clickRow("修复登录跳转");
    clickText("查看实时操作");

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

  it("实时操作里的转录块走极简档：工具卡无卡片表面、状态是纯文字；主转录默认档仍是卡片", () => {
    render({
      "super-1": [
        TOOL_BLOCK,
        { kind: "thought", id: "b-thought", text: "先确认 redirect 的判断条件" },
      ],
    });
    clickLabel("子会话看板");
    clickRow("修复登录跳转");
    clickText("查看实时操作");

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

  it("实时操作以弹框呈现，头部关闭后回到行内入口", () => {
    render({ "super-1": [USER_BLOCK] });
    clickLabel("子会话看板");
    clickRow("修复登录跳转");
    clickText("查看实时操作");

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.getAttribute("aria-label")).toBe("子会话实时操作");
    expect(dialog!.textContent).toContain(USER_TASK);

    const close = document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="收起"]');
    expect(close).toBeTruthy();
    act(() => close!.click());

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).not.toContain(USER_TASK);
    // The row keeps a single entry point — no inline pane state left behind.
    expect(document.body.textContent).toContain("查看实时操作");
  });
});

describe("Super Agent 子会话合并入口", () => {
  it("运行中的子会话不允许合并（按钮置灰，禁用原因由帮助按钮统一说明）", () => {
    render();
    clickLabel("子会话看板");
    clickRow("修复登录跳转");

    const button = [...document.body.querySelectorAll("button")].find(
      (b) => b.textContent === "让智能体合并",
    );
    expect(button).toBeTruthy();
    // 置灰用 aria-disabled 而不是 disabled：kit 的 disabled 样式会吞掉
    // pointer-events，title（唯一写着原因的地方）就读不到了。
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button!.getAttribute("aria-disabled")).toBe("true");
    expect(button!.getAttribute("title")).toContain("子会话还没结束，完成后再让智能体合并");
    // 原因不再逐行重复：行首的状态 chip 已经说明子会话还在运行，
    // 完整规则统一收在看板头的帮助按钮里（见下一组用例）。
    expect(document.body.textContent).not.toContain("子会话还没结束，完成后再让智能体合并");
  });

  it("完成态点击后确认框说明由智能体自己合并，确认才发 action=merge", () => {
    render({}, { status: "completed" });
    clickLabel("子会话看板");
    clickRow("修复登录跳转");
    clickText("让智能体合并");

    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog).toBeTruthy();
    // The request is executed BY the agent, and conflicts are its problem.
    expect(dialog!.textContent).toContain("它会自己执行合并并解决冲突");
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

describe("Super Agent 子会话中断确认", () => {
  /** Click a button by its text inside the confirm dialog (portalled to body). */
  function clickTextInDialog(text: string, dialog: Element): void {
    const button = [...dialog.querySelectorAll("button")].find((b) => b.textContent === text);
    expect(button).toBeTruthy();
    act(() => button!.click());
  }

  it("行内中断先弹确认框，未确认前不发送 cancel", () => {
    render();
    clickLabel("子会话看板");
    clickLabel("中断该子会话");

    expect(send).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain("中断子会话「修复登录跳转」？");

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
    clickLabel("子会话看板");
    clickLabel("中断该子会话");

    clickTextInDialog("取消", document.querySelector('[role="alertdialog"]')!);

    expect(send).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("全部中断先弹确认框，确认后才发送 cancelAll", () => {
    render();
    // 「全部中断」住在展开面板的头部（折叠控件只有开关本身），先展开看板。
    clickLabel("子会话看板");
    clickLabel("全部中断");

    expect(send).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain("中断全部 1 个进行中的子会话？");

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

  it("进行中的子会话排在前面，改动没落地的排其后", () => {
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

  it("已完成且已自动合并的子会话默认折叠，展开分组后才可见", () => {
    renderMany([
      session({ id: "super-live", title: "进行中的任务", status: "running", createdAt: 2000 }),
      merged("super-merged", "已合并的任务", 1000),
    ]);
    clickLabel("子会话看板");

    // Folded away: only a one-line history row, no card, no title.
    expect(document.body.textContent).toContain("已完成的 1 个子会话");
    expect(document.body.textContent).not.toContain("已合并的任务");

    clickLabel("展开已完成的子会话");
    expect(document.body.textContent).toContain("已合并的任务");
  });

  it("一次只展开一行详情", () => {
    renderMany([
      session({ id: "super-a", title: "任务甲", status: "running", createdAt: 1000 }),
      session({ id: "super-b", title: "任务乙", status: "running", createdAt: 2000 }),
    ]);
    clickLabel("子会话看板");

    const rowButton = (title: string) =>
      [...document.body.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(title))!;
    const entryCount = () =>
      [...document.body.querySelectorAll("button")].filter((b) => b.textContent === "查看实时操作").length;

    clickRow("任务甲");
    expect(rowButton("任务甲").getAttribute("aria-expanded")).toBe("true");
    expect(entryCount()).toBe(1);

    clickRow("任务乙");
    expect(rowButton("任务甲").getAttribute("aria-expanded")).toBe("false");
    expect(rowButton("任务乙").getAttribute("aria-expanded")).toBe("true");
    // 甲的详情已收起，只剩乙的一份入口。
    expect(entryCount()).toBe(1);
  });

  it("有子会话等待回答时自动展开；全部已完成且已合并后自动收起", () => {
    // 折叠控件留在 header 里（只有浮层被 portal 出去），所以这里查挂载点。
    const boardExpanded = () =>
      container
        .querySelector('button[aria-label="子会话看板"]')
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
    expect(card!.textContent).toContain("子会话委派");
    expect(card!.textContent).toContain("已完成");
    const title = [...card!.querySelectorAll("span")].find(
      (span) => span.textContent === "子会话委派",
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
    expect(card!.textContent).toContain("Delegation request accepted.");
    // 通用工具卡的文案与 DOM 一概不再出现。
    expect(card!.textContent).not.toContain("工具操作");
    expect(card!.textContent).not.toContain("执行参数");
    expect(container.querySelector(".tool-card")).toBeNull();
    // 任务说明可展开，原始参数仍是折叠项。
    const expand = [...card!.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "展开任务说明",
    );
    expect(expand).toBeTruthy();
    act(() => expand!.click());
    expect(card!.textContent).toContain("第 6 步");
    const rawToggle = [...card!.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("查看原始参数"),
    );
    expect(rawToggle).toBeTruthy();
    act(() => rawToggle!.click());
    const raw = card!.querySelector('[data-testid="super-tool-call-raw"]');
    expect(raw).toBeTruthy();
    expect(raw!.textContent).toContain('"tasks"');
    expect(raw!.textContent).toContain("补开发期同步说明");
  });

  it.each([
    ["非法 JSON", '{"tasks":[oops]}', "工具参数未能完整解析"],
    ["未收全的半截载荷", '{"tasks":[{"title":"半截任务","task":"还没写完"', "工具参数未能完整解析"],
    ["参数还没到达", null, "正在编写任务书…"],
  ])("tasks 解析失败或未完成时诚实降级：%s", (_name, input, expected) => {
    renderBlock(toolBlock({ input, status: "in_progress", output: "" }));
    const card = container.querySelector<HTMLElement>('[data-testid="super-tool-call-card"]');
    expect(card).toBeTruthy();
    expect(card!.classList.contains("super-directive-card")).toBe(true);
    expect(card!.textContent).toContain(expected);
    expect(card!.textContent).toContain("执行中");
    expect(card!.querySelectorAll('[data-testid="super-tool-call-task"]')).toHaveLength(0);
    expect(card!.textContent).not.toContain("工具操作");
    expect(card!.textContent).not.toContain("执行参数");
    expect(container.querySelector(".tool-card")).toBeNull();
    // 失败态不折叠原文：那是卡上唯一有价值的内容，默认就摊开。
    const raw = card!.querySelector('[data-testid="super-tool-call-raw"]');
    if (input) {
      expect(raw).toBeTruthy();
      expect(raw!.textContent).toContain(String(input));
      expect(
        [...card!.querySelectorAll("button")].some((button) =>
          button.textContent?.includes("查看原始参数"),
        ),
      ).toBe(false);
    } else {
      expect(raw).toBeNull();
    }
  });

  it("只接管 dispatch：super-agent-actions 仍走通用工具卡，命名空间形态照常识别", () => {
    renderBlock(toolBlock({ toolName: "super-agent-actions", input: '{"actions":[]}' }));
    expect(container.querySelector('[data-testid="super-tool-call-card"]')).toBeNull();
    expect(container.querySelector(".tool-card")).toBeTruthy();

    renderBlock(toolBlock({ toolName: "iflow__super-agent" }));
    const card = container.querySelector<HTMLElement>('[data-testid="super-tool-call-card"]');
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain("补开发期同步说明");
    expect(container.querySelector(".tool-card")).toBeNull();
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
