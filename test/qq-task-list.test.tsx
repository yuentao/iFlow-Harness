// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqTaskUi } from "../shared/messages";
import { maskQqOpenId } from "../shared/qq-access";
import { QqTaskList } from "../webview/src/components/QqTaskList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let onAction: ReturnType<typeof vi.fn>;

function task(overrides: Partial<QqTaskUi> = {}): QqTaskUi {
  return {
    taskId: "task-1",
    shortId: "A1",
    chatType: "private",
    chatId: "1234567890",
    senderId: "42",
    status: "running",
    channel: "child",
    promptPreview: "把 README 的安装段改成内网镜像",
    createdAt: 0,
    updatedAt: 90_000,
    ...overrides,
  };
}

function render(tasks: QqTaskUi[]): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<QqTaskList tasks={tasks} onAction={onAction} />));
}

function rows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-qq-task]")];
}

function clickText(text: string): void {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  expect(button, `button 「${text}」`).toBeTruthy();
  act(() => button!.click());
}

beforeEach(() => {
  onAction = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("QqTaskList", () => {
  it("explains the empty state with a concrete next step", () => {
    render([]);
    expect(container.textContent).toContain("还没有远程任务");
    expect(container.textContent).toContain("/qq task <任务描述>");
    expect(rows()).toHaveLength(0);
  });

  it("projects one row: short id, status, masked source, preview, elapsed and diff stats", () => {
    render([
      task({
        status: "succeeded",
        branch: "iflow/qq/a1",
        changes: 2,
        additions: 12,
        deletions: 3,
      }),
    ]);
    const [row] = rows();
    expect(row!.textContent).toContain("#A1");
    expect(row!.textContent).toContain("已完成");
    // chatId 与白名单 / 待审核区同一套脱敏：前 4 + 固定 8 个星号 + 后 4。
    expect(row!.textContent).toContain("私聊 · 1234********7890");
    expect(row!.textContent).toContain("把 README 的安装段改成内网镜像");
    expect(row!.textContent).toContain("耗时 1 分 30 秒");
    expect(row!.textContent).toContain("iflow/qq/a1");
    expect(row!.textContent).toContain("2 个文件");
    expect(row!.textContent).toContain("+12");
    expect(row!.textContent).toContain("-3");
    expect(maskQqOpenId("1234567890")).toBe("1234********7890");
  });

  it("tones the status chip by state", () => {
    render([
      task({ taskId: "ok", shortId: "OK", status: "succeeded" }),
      task({ taskId: "bad", shortId: "BAD", status: "failed" }),
      task({ taskId: "wait", shortId: "WAIT", status: "waiting_approval", pending: { kind: "approval", summary: "要执行 npm i" } }),
    ]);
    const [ok, bad, wait] = rows();
    expect(ok!.querySelector(".chip-fade")!.className).toContain("bg-success");
    expect(bad!.querySelector(".chip-fade")!.className).toContain("bg-destructive");
    expect(wait!.querySelector(".chip-fade")!.className).toContain("bg-warning");
  });

  it("offers stop while running and refresh on every row", () => {
    render([task()]);
    clickText("停止");
    expect(onAction).toHaveBeenCalledWith("task-1", "stop");

    const refresh = container.querySelector<HTMLButtonElement>("button[aria-label='刷新任务 A1']")!;
    act(() => refresh.click());
    expect(onAction).toHaveBeenCalledWith("task-1", "refresh");
  });

  it("shows approve / deny for an approval and reports the choice", () => {
    render([
      task({
        status: "waiting_approval",
        pending: { kind: "approval", summary: "要执行 npm install" },
      }),
    ]);
    expect(container.textContent).toContain("等待你的审批");
    expect(container.textContent).toContain("要执行 npm install");
    clickText("批准");
    expect(onAction).toHaveBeenCalledWith("task-1", "approve");
    clickText("拒绝");
    expect(onAction).toHaveBeenCalledWith("task-1", "deny");
  });

  it("提问通道未接通：不提供「提交回答」入口，只如实说明", () => {
    render([
      task({
        status: "waiting_answer",
        pending: { kind: "answer", summary: "选哪个包管理器？" },
      }),
    ]);
    expect(container.textContent).toContain("等待你的回答");
    expect(container.textContent).toContain("选哪个包管理器？");
    // 既没有输入框，也没有点了没用的「提交回答」按钮。
    expect(container.querySelector("input[aria-label='回答任务 A1']")).toBeNull();
    expect(
      [...container.querySelectorAll("button")].some(
        (b) => b.textContent?.trim() === "提交回答",
      ),
    ).toBe(false);
    expect(container.textContent).toContain("提问通道尚未接通，暂不支持在此回答");
  });

  it("offers merge and discard for a finished task with a branch", () => {
    render([task({ status: "succeeded", branch: "iflow/qq/a1" })]);
    clickText("合并");
    expect(onAction).toHaveBeenCalledWith("task-1", "merge");
    clickText("丢弃");
    expect(onAction).toHaveBeenCalledWith("task-1", "discard");
  });

  it("只在宿主回填 policy 时显示策略 chip：trusted 警告色、supervised 中性", () => {
    render([
      task({ taskId: "t-trust", shortId: "TR", status: "running", policy: "trusted" }),
      task({ taskId: "t-sup", shortId: "SU", status: "running", policy: "supervised" }),
      task({ taskId: "t-none", shortId: "NO", status: "running" }),
    ]);
    const [trusted, supervised, plain] = rows();

    const trustedChips = [...trusted!.querySelectorAll<HTMLElement>(".chip-fade")];
    expect(trustedChips).toHaveLength(3);
    expect(trustedChips[1]!.textContent).toBe("免确认");
    expect(trustedChips[1]!.className).toContain("bg-warning");

    const supervisedChips = [...supervised!.querySelectorAll<HTMLElement>(".chip-fade")];
    expect(supervisedChips).toHaveLength(3);
    expect(supervisedChips[1]!.textContent).toBe("需审批");
    expect(supervisedChips[1]!.className).toContain("bg-surface");
    expect(supervisedChips[1]!.className).not.toContain("bg-warning");

    // 没有 policy 的行只有状态 chip + 渠道 chip：看板不猜策略。
    expect(plain!.querySelectorAll(".chip-fade")).toHaveLength(2);
  });

  it("marks the main-session channel and its injected stage", () => {
    render([task({ channel: "main", status: "injected", promptPreview: "把安装段改掉" })]);
    const [row] = rows();
    expect(row!.textContent).toContain("渠道：主会话");
    expect(row!.textContent).toContain("已注入待回复");
    // 注入中仍可停止（排队/等回复都属于「中途」）。
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.trim() === "停止")).toBe(true);
  });

  it("does not offer merge for a main-session task (it has no branch of its own)", () => {
    render([task({ channel: "main", status: "succeeded" })]);
    expect(container.textContent).toContain("渠道：主会话");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.trim() === "合并")).toBe(false);
  });

  it("renders only the first fifty rows and says so", () => {
    render(
      Array.from({ length: 60 }, (_, index) =>
        task({ taskId: `task-${index}`, shortId: `T${index}`, status: "queued" }),
      ),
    );
    expect(rows()).toHaveLength(50);
    expect(container.textContent).toContain("只显示前 50 条，共 60 条。");
    expect(container.textContent).toContain("共 60 条");
  });
});
