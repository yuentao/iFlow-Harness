// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqTaskUi } from "../shared/messages";
import { QqTaskList, maskQqChatId } from "../webview/src/components/QqTaskList";

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
    // chatId 保留前两位与末两位，中间打码。
    expect(row!.textContent).toContain("私聊 · 12****90");
    expect(row!.textContent).toContain("把 README 的安装段改成内网镜像");
    expect(row!.textContent).toContain("耗时 1 分 30 秒");
    expect(row!.textContent).toContain("iflow/qq/a1");
    expect(row!.textContent).toContain("2 个文件");
    expect(row!.textContent).toContain("+12");
    expect(row!.textContent).toContain("-3");
    expect(maskQqChatId("123")).toBe("***");
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

  it("requires an answer text before submitting an answer", () => {
    render([
      task({
        status: "waiting_answer",
        pending: { kind: "answer", summary: "选哪个包管理器？" },
      }),
    ]);
    expect(container.textContent).toContain("等待你的回答");
    const input = container.querySelector<HTMLInputElement>("input[aria-label='回答任务 A1']")!;
    const submit = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "提交回答",
    )!;
    expect(submit.disabled).toBe(true);

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "pnpm");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(submit.disabled).toBe(false);
    act(() => submit.click());
    expect(onAction).toHaveBeenCalledWith("task-1", "answer", "pnpm");
  });

  it("offers merge and discard for a finished task with a branch", () => {
    render([task({ status: "succeeded", branch: "iflow/qq/a1" })]);
    clickText("合并");
    expect(onAction).toHaveBeenCalledWith("task-1", "merge");
    clickText("丢弃");
    expect(onAction).toHaveBeenCalledWith("task-1", "discard");
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
