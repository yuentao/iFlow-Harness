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

function clickText(text: string): void {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === text);
  expect(button).toBeTruthy();
  act(() => button!.click());
}

function clickLabel(label: string): void {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label,
  );
  expect(button).toBeTruthy();
  act(() => button!.click());
}

describe("Super Agent 子会话实时操作面板", () => {
  it("折叠状态下不提供面板入口，展开看板后行内出现「查看实时操作」", () => {
    render();
    expect(container.textContent).not.toContain("查看实时操作");

    clickLabel("展开子会话看板");

    expect(container.textContent).toContain("修复登录跳转");
    expect(container.textContent).toContain("运行中");
    expect(container.textContent).toContain("查看实时操作");
  });

  it("打开面板时本地无转录 → 向宿主拉取该子会话的全量转录", () => {
    render();
    clickLabel("展开子会话看板");
    clickText("查看实时操作");

    expect(send).toHaveBeenCalledWith({
      type: "superAgent",
      action: "transcript",
      sessionId: "super-1",
    });
    // The dialog portals onto document.body; a running child with nothing
    // buffered yet reads as "暂无输出".
    expect(document.body.textContent).toContain("暂无输出");
  });

  it("有转录时渲染 user / tool / text 三类块（工具卡走真实 ToolCard）", () => {
    render({ "super-1": [USER_BLOCK, TOOL_BLOCK, TEXT_BLOCK] });
    clickLabel("展开子会话看板");
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

  it("实时操作以弹框呈现，头部关闭后回到行内入口", () => {
    render({ "super-1": [USER_BLOCK] });
    clickLabel("展开子会话看板");
    clickText("查看实时操作");

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.getAttribute("aria-label")).toBe("子会话实时操作");
    expect(dialog!.textContent).toContain(USER_TASK);

    const close = [...document.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "收起",
    );
    expect(close).toBeTruthy();
    act(() => close!.click());

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).not.toContain(USER_TASK);
    // The row keeps a single entry point — no inline pane state left behind.
    expect(container.textContent).toContain("查看实时操作");
  });
});

describe("Super Agent 子会话合并入口", () => {
  it("运行中的子会话不允许合并（按钮置灰）", () => {
    render();
    clickLabel("展开子会话看板");

    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "让智能体合并",
    );
    expect(button).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("完成态点击后确认框说明由智能体自己合并，确认才发 action=merge", () => {
    render({}, { status: "completed" });
    clickLabel("展开子会话看板");
    clickText("让智能体合并");

    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog).toBeTruthy();
    // The request is executed BY the agent, and conflicts are its problem.
    expect(dialog!.textContent).toContain("它会自己执行合并并解决冲突");
    expect(dialog!.textContent).toContain("iflow/super/a");

    const confirm = [...dialog!.querySelectorAll("button")].find(
      (b) => b.textContent === "让智能体合并",
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
