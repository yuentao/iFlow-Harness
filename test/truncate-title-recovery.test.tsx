// @vitest-environment jsdom
/**
 * 截断文本的 title 提示 + 工具输出的恢复出口。
 *
 * 一类同源缺陷：UI 用 `truncate` 把长文本裁掉，却不配 `title`（hover 看不到
 * 被省略的全文）；工具输出被宿主裁剪后也没有「复制全部 / 查看完整输出」的
 * 恢复出口。本仓的正确范式是**同一个元素上 `truncate` 与 `title` 成对出现**
 * （见 McpCard / SuperAgentBoard / AssetCard），以及主转录 `OutputDetails`
 * 的 recoverRow（`已截断 N 字符` + `复制全部` + `查看完整输出`）。
 *
 * 这里钉住三组修复：
 *  1. Composer / ApprovalCard / MemoryCard 的截断文本都带上了 title；
 *  2. 只读子代理条目的工具输出改走 OutputDetails（不再是裸 <pre>）；
 *  3. 载荷被释放（evicted）的工具卡仍保留「查看完整输出」出口。
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../webview/src/components/ApprovalCard";
import { Composer } from "../webview/src/components/Composer";
import { MemorySection } from "../webview/src/components/MemoryCard";
import { BlockView } from "../webview/src/components/MessageList";
import {
  initialSessionState,
  type Block,
  type MemoryStateUi,
  type PendingApprovalUi,
  type SessionState,
} from "../shared/messages";

const mocked = vi.hoisted(() => ({
  send: vi.fn(),
  notify: vi.fn(),
  state: undefined as SessionState | undefined,
}));

const useChat = vi.hoisted(() =>
  Object.assign(
    <T,>(selector: (s: Record<string, unknown>) => T) =>
      selector({
        state: mocked.state,
        pending: null,
        send: mocked.send,
        beginPending: vi.fn(),
        notify: mocked.notify,
      }),
    {
      getState: () => ({ state: mocked.state, send: mocked.send, notify: mocked.notify }),
    },
  ),
);

vi.mock("../webview/src/store", () => ({ useChat }));
vi.mock("../webview/src/i18n", () => ({
  t: (s: string, ...args: Array<string | number>) => {
    let out = s;
    args.forEach((arg, i) => {
      out = out.replaceAll(`{${i}}`, String(arg));
    });
    return out;
  },
  modeDisplay: () => ({ label: "mode", desc: "" }),
}));
vi.mock("../webview/src/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../webview/src/components/ui")>();
  return {
    ...actual,
    // The model menu body is a render prop — it must not render as a child.
    Dropdown: ({ trigger }: { trigger: (open: boolean) => ReactNode }) => <>{trigger(false)}</>,
    fuzzyScore: () => 0,
  };
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mocked.send.mockReset();
  mocked.notify.mockReset();
  mocked.state = { ...initialSessionState(), status: "idle" };
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
  Element.prototype.scrollIntoView = () => {};
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** The element that carries `truncate` AND exactly this text — the pair the
 *  repo-wide convention requires (truncate and title on the same node). */
function truncateByText(scope: ParentNode, text: string): HTMLElement {
  const el = [...scope.querySelectorAll<HTMLElement>("*")].find(
    (node) => node.classList.contains("truncate") && node.textContent?.trim() === text,
  );
  if (!el) throw new Error(`找不到带 truncate 的「${text}」元素`);
  return el;
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const btn = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!btn) throw new Error(`找不到文案为「${text}」的按钮`);
  return btn;
}

function typeInComposer(text: string): void {
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function hostMessage(data: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data }));
  });
}

/** The request the composer sent, by type. */
function sentOfType(type: string): Record<string, unknown> | undefined {
  return mocked.send.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .find((msg) => msg.type === type);
}

describe("Composer：弹层里的截断文本都要有 title", () => {
  it("slash 命令弹层：命令描述带 title（命令名早就有，唯独描述没有）", () => {
    mocked.state = {
      ...mocked.state!,
      commands: [{ name: "help", description: "列出全部命令与用法" }],
    } as SessionState;
    act(() => root.render(<Composer />));
    typeInComposer("/");

    const desc = truncateByText(container, "列出全部命令与用法");
    expect(desc.getAttribute("title")).toBe("列出全部命令与用法");
  });

  it("下一步建议 chip：建议全文进 title（按钮上的固定提示语不算）", () => {
    mocked.state = {
      ...mocked.state!,
      nextStepSuggestions: ["把登录跳转补上回归用例"],
    } as SessionState;
    act(() => root.render(<Composer />));

    const chip = truncateByText(container, "把登录跳转补上回归用例");
    expect(chip.getAttribute("title")).toBe("把登录跳转补上回归用例");
  });

  it("@ 弹层：来源行（@problems 等）的标签带 title", async () => {
    act(() => root.render(<Composer />));
    typeInComposer("@p");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    const label = truncateByText(container, "工作区诊断（Problems）");
    expect(label.getAttribute("title")).toBe("工作区诊断（Problems）");
  });

  it("@ 弹层：文件命中行的目录前缀带 title（basename 走 break-all，不动）", async () => {
    act(() => root.render(<Composer />));
    typeInComposer("@a");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    const search = sentOfType("searchFiles");
    expect(search).toBeTruthy();
    hostMessage({ type: "fileList", requestId: search!.requestId, hits: [{ path: "src/panel/panel.ts" }] });

    const dir = truncateByText(container, "src/panel/");
    expect(dir.getAttribute("title")).toBe("src/panel");
  });

  it("上下文解析中的「解析中…」chip：被截断的标签带 title", async () => {
    act(() => root.render(<Composer />));
    typeInComposer("@/");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    const search = sentOfType("searchFiles");
    expect(search).toBeTruthy();
    hostMessage({ type: "fileList", requestId: search!.requestId, hits: [{ path: "src" }] });

    const row = [...container.querySelectorAll("button")].find((b) => b.textContent === "src");
    expect(row).toBeTruthy();
    act(() => {
      row!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });

    const label = truncateByText(container, "src");
    expect(label.getAttribute("title")).toBe("src");
  });
});

describe("ApprovalCard：标题里的目标路径带 title", () => {
  const APPROVAL: PendingApprovalUi = {
    id: "approval-1",
    toolName: "write_file",
    title: "Write a.ts",
    toolKind: "edit",
    locations: [{ path: "src/panel/panel.ts", line: 12 }],
    options: [
      { optionId: "reject-1", name: "拒绝", kind: "reject_once" },
      { optionId: "allow-1", name: "允许", kind: "allow_once" },
    ],
    deadline: Date.now() + 60_000,
    timeoutMs: 60_000,
  };

  it("标题 span（truncate）带 actionTarget 的 title", () => {
    act(() => root.render(<ApprovalCard approval={APPROVAL} />));
    const card = container.querySelector('[role="alertdialog"]')!;
    const labelledBy = card.getAttribute("aria-labelledby")!;
    const titleEl = document.getElementById(labelledBy)!;
    expect(titleEl).toBeTruthy();
    expect(titleEl.classList.contains("truncate")).toBe(true);
    expect(titleEl.getAttribute("title")).toBe("src/panel/panel.ts");
  });
});

describe("MemoryCard：目录与知识库条目的截断文本带 title", () => {
  const HOME = "/home/user/.iflow";
  const CWD = "/work/iflow-demo-repo";

  const MEM_STATE = {
    home: HOME,
    cwd: CWD,
    workspaceRoots: [CWD],
    files: [],
    globalPrimary: null,
    projectPrimary: null,
    knowledge: {
      dir: `${CWD}/.iflow/knowledge`,
      index: {
        path: `${CWD}/.iflow/knowledge/index.md`,
        displayPath: ".iflow/knowledge/index.md",
        title: "项目知识索引",
        injected: true,
        bytes: 10,
        tokens: 5,
        updatedAt: null,
        hash: null,
      },
      docs: [
        {
          path: `${CWD}/.iflow/knowledge/index.md`,
          displayPath: ".iflow/knowledge/index.md",
          title: "项目知识索引",
          injected: true,
          bytes: 10,
          tokens: 5,
          updatedAt: null,
          hash: null,
        },
      ],
      managedBy: `${CWD}/AGENTS.md`,
      injectedTokens: 12,
    },
  } as unknown as MemoryStateUi;

  it("全局记忆目录、项目记忆目录、知识库标题与路径都带 title", () => {
    act(() => root.render(<MemorySection busy={false} onHeader={() => {}} />));
    hostMessage({ type: "memoryState", state: MEM_STATE });

    expect(truncateByText(container, HOME).getAttribute("title")).toBe(HOME);
    expect(truncateByText(container, CWD).getAttribute("title")).toBe(CWD);
    expect(truncateByText(container, "项目知识索引").getAttribute("title")).toBe("项目知识索引");
    expect(truncateByText(container, ".iflow/knowledge/index.md").getAttribute("title")).toBe(
      ".iflow/knowledge/index.md",
    );
  });
});

describe("MessageList：只读输出的恢复出口", () => {
  const SUBAGENT: Block = {
    kind: "subagent",
    id: "sa-1",
    agentId: "agent-1",
    taskToolCallId: "tc-task",
    title: "子代理",
    status: "completed",
    agentType: null,
    entries: [
      {
        kind: "tool",
        id: "t-1",
        toolCallId: "tc-2",
        toolName: "run_shell_command",
        title: "run_shell_command",
        toolKind: "execute",
        status: "completed",
        output: "line one\nline two\nline three",
        truncatedChars: 1234,
        locations: [],
        diff: null,
      },
    ],
  };

  function renderBlock(block: Block): void {
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

  it("只读子代理的工具输出走 OutputDetails：有截断提示与「复制全部」出口", () => {
    renderBlock(SUBAGENT);
    // 只读记录默认收起，先展开。
    act(() => buttonByText(container, "查看完整记录").click());

    // OutputDetails 的输出体首次打开才挂载（openedOnce），先点开「操作输出」。
    // 按钮文案含截断徽标（操作输出已截断 N 字符），按包含匹配。
    const outputToggle = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("操作输出"),
    );
    expect(outputToggle).toBeTruthy();
    act(() => outputToggle!.click());

    expect(container.textContent).toContain("line one");
    // recoverRow 范式：截断说明 + 复制出口。
    expect(container.textContent).toContain("已截断 1,234 字符");
    const copy = buttonByText(container, "复制全部");
    expect(copy).toBeTruthy();
    // 旧的裸 <pre>（没有恢复出口的那份）已经不在了。
    expect(container.querySelector("pre.whitespace-pre-wrap")).toBeNull();
  });

  it("载荷被释放的工具卡仍保留「查看完整输出」出口", () => {
    const evictedTool: Block = {
      kind: "tool",
      id: "b-evicted",
      toolCallId: "tc-9",
      toolName: "run_shell_command",
      title: "运行命令",
      toolKind: "execute",
      status: "completed",
      output: "",
      evicted: true,
      locations: [],
      diff: null,
    };
    renderBlock(evictedTool);

    expect(container.textContent).toContain("内容已释放");
    const exportBtn = buttonByText(container, "查看完整输出");
    expect(exportBtn).toBeTruthy();
    act(() => exportBtn.click());
    expect(mocked.send).toHaveBeenCalledWith({ type: "exportToolOutput", blockId: "b-evicted" });
  });
});