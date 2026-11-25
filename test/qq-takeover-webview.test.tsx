// @vitest-environment jsdom
/**
 * 底部输入区「远程接续」开关（webview 侧）：
 *
 * - 仅 `qqSettings.enabled` 时渲染，点击发 `qqTakeover` start/stop；
 * - `remoteTakeover` 为真时 Composer 输入与发送禁用（但开关本身仍可关闭，
 *   否则会死锁），审批卡 / 提问卡的决策按钮同步禁用；
 * - 转录区（MessageList）不受冻结，仍是可滚动的只读观察面。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../webview/src/components/Composer";
import { ApprovalCard } from "../webview/src/components/ApprovalCard";
import { QuestionCard } from "../webview/src/components/QuestionCard";
import { MessageList } from "../webview/src/components/MessageList";
import { SuperAgentBoard } from "../webview/src/components/SuperAgentBoard";
import {
  initialSessionState,
  type PendingApprovalUi,
  type PendingQuestionsUi,
  type SessionState,

} from "../shared/messages";
import type { SuperSessionUi } from "../shared/super-agent";

const mocked = vi.hoisted(() => ({
  send: vi.fn(),
  notify: vi.fn(),
  dismissToast: vi.fn(),
  setHeaderScrolled: vi.fn(),
  state: undefined as SessionState | undefined,
  qqEnabled: true,
  takeover: false,
}));
const useChat = vi.hoisted(() =>
  Object.assign(
    <T,>(selector: (s: Record<string, unknown>) => T): T =>
      selector({
        state: mocked.state,
        pending: null,
        send: mocked.send,
        beginPending: vi.fn(),
        notify: mocked.notify,
        dismissToast: mocked.dismissToast,
        setHeaderScrolled: mocked.setHeaderScrolled,
        focusMode: false,
        promptSeq: 0,
        toasts: [],
        qqSettings: { enabled: mocked.qqEnabled },
        remoteTakeover: mocked.takeover,
        superTranscripts: {},
      }),
    {
      getState: () => ({
        state: mocked.state,
        send: mocked.send,
        notify: mocked.notify,
        remoteTakeover: mocked.takeover,
        superTranscripts: {},
      }),
    },
  ),
);
vi.mock("../webview/src/store", () => ({ useChat }));
vi.mock("../webview/src/i18n", () => ({ t: (s: string) => s }));
vi.mock("../webview/src/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../webview/src/components/ui")>();
  return {
    ...actual,
    Dropdown: ({ trigger, children }: { trigger: (open: boolean) => React.ReactNode; children: React.ReactNode }) => (
      <>{trigger(false)}{children}</>
    ),
    fuzzyScore: () => 0,
  };
});

const APPROVAL: PendingApprovalUi = {
  id: "approval-1",
  toolName: "write_file",
  title: "Write a.ts",
  toolKind: "edit",
  locations: [],
  options: [
    { optionId: "reject-1", name: "拒绝", kind: "reject_once" },
    { optionId: "allow-1", name: "允许", kind: "allow_once" },
  ],
  deadline: Date.now() + 60_000,
  timeoutMs: 60_000,
};
const QUESTIONS: PendingQuestionsUi = {
  id: "q-1",
  questions: [
    {
      header: "framework",
      question: "Which framework?",
      options: [{ label: "React", description: "React 19 with hooks" }],
      multiSelect: false,
    },
  ],
  deadline: Date.now() + 60_000,
  timeoutMs: 60_000,
};

let root: Root;
let container: HTMLDivElement;

function makeState(): SessionState {
  const state = initialSessionState();
  state.status = "idle";
  state.sessionId = "s1";
  state.activeSessionId = "s1";
  return state;
}

function renderComposer(): void {
  act(() => root.render(<Composer />));
}

function takeoverButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    'button[aria-label="远程接续"], button[aria-label="关闭接续"]',
  );
}

function sendButton(): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    b.textContent?.includes("发送"),
  ) ?? null;
}

/** ConfirmDialog portals to document.body, outside the composer container. */
function dialogButton(label: string): HTMLButtonElement | null {
  const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
  return Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
    (b) => b.textContent?.trim() === label,
  ) ?? null;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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
  Element.prototype.scrollTo = () => {};
  mocked.state = makeState();
  mocked.qqEnabled = true;
  mocked.takeover = false;
  mocked.send.mockReset();
  mocked.notify.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("远程接续按钮", () => {
  it("仅在机器人已启用时渲染", () => {
    mocked.qqEnabled = false;
    renderComposer();
    expect(takeoverButton()).toBeNull();

    mocked.qqEnabled = true;
    renderComposer();
    expect(takeoverButton()?.getAttribute("aria-label")).toBe("远程接续");
  });

  it("点击发 qqTakeover start；接管态下点关闭接续弹确认，确认后发 stop", () => {
    renderComposer();
    act(() => takeoverButton()!.click());
    expect(mocked.send).toHaveBeenCalledWith({ type: "qqTakeover", action: "start" });

    mocked.takeover = true;
    renderComposer();
    const button = takeoverButton()!;
    expect(button.getAttribute("aria-label")).toBe("关闭接续");
    act(() => button.click());
    // 二次确认：点击本身不发 stop
    expect(mocked.send).toHaveBeenCalledTimes(1);
    expect(dialogButton("确认关闭")).not.toBeNull();
    act(() => dialogButton("确认关闭")!.click());
    expect(mocked.send).toHaveBeenCalledWith({ type: "qqTakeover", action: "stop" });
  });

  it("接管态关闭接续点取消：不发 stop，保持接管态", () => {
    mocked.takeover = true;
    renderComposer();
    act(() => takeoverButton()!.click());
    expect(dialogButton("取消")).not.toBeNull();
    act(() => dialogButton("取消")!.click());
    expect(mocked.send).not.toHaveBeenCalled();
    expect(takeoverButton()?.getAttribute("aria-label")).toBe("关闭接续");
  });

  it("接管时输入框 readOnly、发送禁用，但开关自身仍可点击关闭（无死锁）", () => {
    mocked.takeover = true;
    renderComposer();
    const textarea = container.querySelector("textarea")!;
    expect(textarea.readOnly).toBe(true);
    expect(sendButton()?.disabled).toBe(true);
    expect(takeoverButton()?.disabled).toBe(false);
  });
});

describe("远程接管的卡片冻结", () => {
  it("审批卡按钮在接管时禁用，键盘决策也不发送", () => {
    mocked.takeover = true;
    act(() => root.render(<ApprovalCard approval={APPROVAL} />));
    const decision = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter((b) =>
      ["允许", "拒绝", "取消"].some((label) => b.textContent?.includes(label)),
    );
    expect(decision.length).toBeGreaterThan(0);
    expect(decision.every((b) => b.disabled)).toBe(true);

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", bubbles: true })));
    expect(mocked.send).not.toHaveBeenCalled();
  });

  it("提问卡按钮在接管时禁用，且不发送回答", () => {
    mocked.takeover = true;
    act(() => root.render(<QuestionCard pending={QUESTIONS} />));
    const decision = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter((b) =>
      b.getAttribute("aria-label") === "提交回答" || b.getAttribute("aria-label") === "不回答并继续",
    );
    expect(decision.length).toBe(2);
    expect(decision.every((b) => b.disabled)).toBe(true);
    expect(mocked.send).not.toHaveBeenCalled();
  });
});

describe("看板 portal 表面在接管态被冻结", () => {
  const settled: SuperSessionUi = {
    id: "sa-1",
    title: "已完成的子会话",
    task: "补单测",
    status: "completed",
    isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/a", baseRef: "abc" },
    createdAt: 1000,
    updatedAt: 1000,
    reports: [],
  };

  function boardPanel(): HTMLElement | null {
    return document.body.querySelector<HTMLElement>('[role="region"][aria-label="超流体"]');
  }

  function boardControl(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>('button[aria-label="超流体看板"]');
  }

  it("接管态：展开的看板浮层带 inert（它 portal 到 body，顶栏 inert 管不到）", () => {
    const state = makeState();
    state.superSessions = [settled];
    mocked.state = state;
    mocked.takeover = false;
    act(() => root.render(<SuperAgentBoard frozen={mocked.takeover} />));
    act(() => boardControl()!.click());

    const open = boardPanel();
    expect(open).toBeTruthy();
    expect(open!.hasAttribute("inert")).toBe(false);
    expect(open!.className).not.toContain("opacity-40");

    // 远程接管：同一块浮层必须被冻结（鼠标与键盘都拦），并给出冻结视觉。
    mocked.takeover = true;
    act(() => root.render(<SuperAgentBoard frozen={mocked.takeover} />));
    const frozen = boardPanel();
    expect(frozen).toBeTruthy();
    expect(frozen!.hasAttribute("inert")).toBe(true);
    expect(frozen!.className).toContain("opacity-40");
    // 点浮层里的动作不会发消息（inert 之外，按钮自身也没有被点到的路径）。
    expect(mocked.send).not.toHaveBeenCalled();
  });

  it("接管态：折叠态的待答条同样被冻结", () => {
    const state = makeState();
    const asking: SuperSessionUi = {
      ...settled,
      id: "sa-ask",
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
            question: "要覆盖哪些范围？",
            multiSelect: false,
            options: [{ label: "只覆盖用量估算", description: "范围小、跑得快" }],
          },
        ],
      },
    };
    state.superSessions = [asking];
    mocked.state = state;
    // 有待答子会话时看板会自行展开；手动收起后待答条 portal 到 body。
    mocked.takeover = false;
    act(() => root.render(<SuperAgentBoard frozen={mocked.takeover} />));
    act(() => boardControl()!.click());

    const strip = () =>
      document.body.querySelector<HTMLElement>('[role="region"][aria-label="超流体待答问题"]');
    expect(strip()).toBeTruthy();
    expect(strip()!.hasAttribute("inert")).toBe(false);

    mocked.takeover = true;
    act(() => root.render(<SuperAgentBoard frozen={mocked.takeover} />));
    expect(strip()).toBeTruthy();
    expect(strip()!.hasAttribute("inert")).toBe(true);
    expect(strip()!.className).toContain("opacity-40");
  });
});

describe("只读观察", () => {
  it("接管态下转录仍渲染为可滚动容器且能滚动", () => {
    mocked.takeover = true;
    const state = makeState();
    state.blocks = [{ kind: "text", id: "b-1", text: "远程正在改代码。" }];
    mocked.state = state;
    act(() => root.render(<MessageList />));
    const scroll = container.querySelector<HTMLElement>(".message-scroll");
    expect(scroll).not.toBeNull();
    expect(scroll!.className).toContain("overflow-y-auto");
    expect(scroll!.hasAttribute("disabled")).toBe(false);
    act(() => {
      scroll!.scrollTop = 120;
      scroll!.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(scroll!.scrollTop).toBe(120);
  });
});
