// @vitest-environment jsdom
/**
 * QQ 远程任务融入 Super Agent 子会话看板。
 *
 * 覆盖：
 *  - 纯关联函数 `findQqTaskForSuperSession`（标题 / 分支两条路径、主会话渠道被排除）；
 *  - 组件层：远程子会话 title 后渲染「渠道」「发起人」tag，普通子会话不渲染；
 *  - 独立看板入口已从 App 移除（静态源码断言）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqTaskUi } from "../shared/messages";
import { findQqTaskForSuperSession } from "../shared/qq-task";
import type { SuperSessionUi } from "../shared/super-agent";
import { SuperAgentBoard } from "../webview/src/components/SuperAgentBoard";

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

function session(overrides: Partial<SuperSessionUi> = {}): SuperSessionUi {
  return {
    id: "super-qq-1",
    title: "QQ q3pzqq",
    task: "你好",
    status: "running",
    isolation: {
      kind: "git_worktree",
      path: "/tmp/wt",
      branch: "iflow/super/qq-q3pzqq-mwkr1f22-1",
    },
    createdAt: 1000,
    updatedAt: 1000,
    reports: [],
    ...overrides,
  };
}

function task(overrides: Partial<QqTaskUi> = {}): QqTaskUi {
  return {
    taskId: "T-1-q3pzqq",
    shortId: "q3pzqq",
    chatType: "private",
    chatId: "D754********8D11",
    senderId: "D754********8D11",
    status: "needs_review",
    channel: "child",
    branch: "iflow/super/qq-q3pzqq-mwkr1f22-1",
    promptPreview: "你好",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  send.mockReset();
  translate.mockClear();
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

function render(sessions: SuperSessionUi[], tasks: QqTaskUi[] = []): void {
  store.current = {
    state: { superSessions: sessions, qqTasks: tasks },
    superTranscripts: {},
    send,
  };
  act(() => root.render(<SuperAgentBoard />));
}

function expand(): void {
  const control = container.querySelector<HTMLButtonElement>('button[aria-label="超流体看板"]');
  expect(control).toBeTruthy();
  act(() => control!.click());
}

function rowButton(title = "QQ q3pzqq"): HTMLButtonElement {
  const el = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    (b.textContent ?? "").includes(title),
  );
  expect(el).toBeTruthy();
  return el!;
}

describe("findQqTaskForSuperSession —— QQ 任务与超流体的关联", () => {
  it("派发时写入的 QQ <shortId> 标题命中远程任务", () => {
    const qq = task();
    expect(findQqTaskForSuperSession([qq], session())).toBe(qq);
  });

  it("标题被改过时用共享分支兜底", () => {
    const qq = task();
    const s = session({ title: "修复登录跳转" });
    expect(findQqTaskForSuperSession([qq], s)).toBe(qq);
  });

  it("主会话渠道的任务不冒充远程超流体", () => {
    const main = task({ channel: "main", shortId: "q3pzqq", branch: session().isolation.branch });
    expect(findQqTaskForSuperSession([main], session({ title: "普通任务" }))).toBeUndefined();
  });

  it("关联不到返回 undefined", () => {
    expect(findQqTaskForSuperSession([], session())).toBeUndefined();
    expect(
      findQqTaskForSuperSession(
        [task({ shortId: "other", branch: "iflow/super/other" })],
        session(),
      ),
    ).toBeUndefined();
  });
});

describe("Super Agent 看板上的 QQ 远程任务 tag", () => {
  it("远程超流体 title 后渲染渠道与发起人 tag", () => {
    render([session()], [task()]);
    expand();
    const row = rowButton();
    expect(row.textContent).toContain("渠道：私聊");
    expect(row.textContent).toContain("发起人：D754********8D11");
  });

  it("群聊远程超流体渲染群聊渠道 tag", () => {
    render([session()], [task({ chatType: "group", chatId: "grp-1234" })]);
    expand();
    expect(rowButton().textContent).toContain("渠道：群聊");
  });

  it("普通超流体不渲染任何 QQ tag", () => {
    render([session({ id: "super-local", title: "本地任务", isolation: { kind: "git_worktree", path: "/tmp/x", branch: "iflow/super/local" } })]);
    expand();
    const row = rowButton("本地任务");
    expect(row.textContent).not.toContain("渠道：");
    expect(row.textContent).not.toContain("发起人：");
  });

  it("qqTasks 投影缺席时优雅降级、不渲染 tag", () => {
    render([session()]);
    expand();
    const row = rowButton();
    expect(row.textContent).not.toContain("渠道：");
    expect(row.textContent).not.toContain("发起人：");
  });
});

describe("独立远程任务看板入口已移除", () => {
  it("App 不再挂载 QqTasksPanel", () => {
    const app = readFileSync(join(process.cwd(), "webview/src/App.tsx"), "utf8");
    expect(app).not.toContain("<QqTasksPanel");
    expect(app).not.toContain('from "./components/QqTaskList"');
  });
});
