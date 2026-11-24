// @vitest-environment jsdom
/**
 * 回归：「查看实时进度」page 级白屏。
 *
 * SuperSessionLive 把 superTranscripts 原样喂给 BlockView。正常实时流由 reducer
 * 产出字段完整，但历史转录快照（readSuperTranscriptSnapshot 只校验外层数组）或
 * 旧版 wire 可能带缺字段的畸形块。缺 text 的 text/user/thought 块、缺 entries
 * 的 plan 块会在渲染期抛错，冒泡成 page 级 ErrorBoundary（「界面出错了」白屏）。
 *
 * 修复在 webview store 的 superTranscript 入站处统一做块级规范化
 * （sanitizeTranscriptBlocks，shared/messages.ts）。这里既测纯函数的修补/丢弃
 * 语义，也测真实 store 入站 + App 点击「查看实时进度」不再白屏。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block, SessionState } from "../shared/messages";
import { sanitizeTranscriptBlocks } from "../shared/messages";
import { App } from "../webview/src/App";
import { useChat } from "../webview/src/store";
import { ErrorBoundary } from "../webview/src/components/ErrorBoundary";

vi.mock("../webview/src/i18n", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    setLocale: () => {},
    t: (s: string, ...args: Array<string | number>) => {
      let out = s;
      args.forEach((a, i) => { out = out.replaceAll(`{${i}}`, String(a)); });
      return out;
    },
  };
});

describe("sanitizeTranscriptBlocks", () => {
  it("合法块原样返回（identity 稳定、幂等）", () => {
    const blocks: Block[] = [
      { kind: "text", id: "t", text: "hello" },
      { kind: "tool", id: "c", toolCallId: "tc", toolName: "read_file", title: "读取", toolKind: "read", status: "completed", output: "ok", locations: [], diff: null },
      { kind: "plan", id: "p", entries: [{ content: "step" }] },
    ];
    expect(sanitizeTranscriptBlocks(blocks)).toBe(blocks);
    expect(sanitizeTranscriptBlocks(blocks)[0]).toBe(blocks[0]);
  });

  it("缺 text 的 text/user/thought 块补空串，不再让 trim()/marked() 抛错", () => {
    const out = sanitizeTranscriptBlocks([
      { kind: "text", id: "t1" },
      { kind: "user", id: "u1" },
      { kind: "thought", id: "th1" },
    ]);
    expect(out).toHaveLength(3);
    for (const b of out) expect((b as { text: string }).text).toBe("");
  });

  it("缺 entries/items 的 plan/subagent/injected 块补空数组", () => {
    const out = sanitizeTranscriptBlocks([
      { kind: "plan", id: "p" },
      { kind: "subagent", id: "sa", agentId: "a", taskToolCallId: null, title: "t", status: "in_progress", agentType: null },
      { kind: "injected", id: "inj", notice: "n" },
    ]);
    expect(out).toHaveLength(3);
    expect((out[0] as { entries: unknown[] }).entries).toEqual([]);
    expect((out[1] as { entries: unknown[] }).entries).toEqual([]);
    expect((out[2] as { items: unknown[] }).items).toEqual([]);
  });

  it("未知 kind / null / 非对象垃圾块被丢弃", () => {
    const out = sanitizeTranscriptBlocks([
      null,
      "garbage",
      { kind: "bogus", id: "x" },
      { kind: "text", id: "ok", text: "keep" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "text", text: "keep" });
  });

  it("递归修补 subagent.entries 里的畸形子块", () => {
    const out = sanitizeTranscriptBlocks([
      {
        kind: "subagent", id: "sa", agentId: "a", taskToolCallId: null,
        title: "t", status: "in_progress", agentType: null,
        entries: [{ kind: "print", id: "bad" }],
      },
    ]);
    const sa = out[0] as Extract<Block, { kind: "subagent" }>;
    expect(sa.entries).toEqual([]);
  });
});

// ---- 真实 store + App 集成：畸形块不再触发 page 级白屏 ----

let root: Root;
let container: HTMLDivElement;
let captured: unknown[] = [];

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  captured = [];
  vi.spyOn(console, "error").mockImplementation((...a) => { captured.push(a); });
  class Obs { observe() {} unobserve() {} disconnect() {} takeRecords(): [] { return []; } }
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = Obs;
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = Obs;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function snapshotState(): SessionState {
  return {
    blocks: [], status: "idle", errorMessage: null, stopReason: null, sessionId: "s1",
    modes: null, commands: [], skills: [], models: [], currentModelId: null, thinkLevel: "auto",
    pendingApproval: null, pendingQuestions: null, pendingProfileSwitch: null,
    auth: { authenticated: true, needsSetup: false, saved: null, profiles: [], onboardingDismissed: true },
    sessions: [], activeSessionId: null, replaying: false, initializing: false, compressing: false,
    superWaiting: false,
    superSessions: [{
      id: "super-1", title: "修复登录跳转", task: "做", status: "running",
      isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "b", baseRef: "x" },
      createdAt: Date.now() - 5000, startedAt: Date.now() - 4000, updatedAt: Date.now(),
      reports: [],
    }],
    queue: [], queuePaused: false, checkpoints: [], nextStepSuggestions: [], nextStepLoading: false,
  } as unknown as SessionState;
}

/** 打开看板 → 展开该子会话行 → 点「查看实时进度」。 */
function openLiveProgress(): void {
  const byLabel = (l: string) => [...document.body.querySelectorAll("button")].find(b => b.getAttribute("aria-label") === l);
  const byText = (t: string) => [...document.body.querySelectorAll("button")].find(b => b.textContent === t);
  act(() => byLabel("超流体看板")!.click());
  const row = [...document.body.querySelectorAll("button")].find(b => (b.textContent ?? "").includes("修复登录跳转"));
  expect(row).toBeTruthy();
  act(() => row!.click());
  const live = byText("查看实时进度");
  expect(live).toBeTruthy();
  act(() => live!.click());
}

it.each([
  ["缺 text 的 text 块", [{ kind: "text", id: "t" }]],
  ["缺 text 的 user 块", [{ kind: "user", id: "u" }]],
  ["缺 entries 的 plan 块", [{ kind: "plan", id: "p" }]],
  ["未知 kind + 缺字段混合", [
    { kind: "user", id: "u", text: "任务" },
    { kind: "bogus", id: "x" },
    { kind: "text", id: "t" },
    { kind: "subagent", id: "sa", agentId: "a", taskToolCallId: null, title: "t", status: "in_progress", agentType: null },
  ]],
])("真实 store 注入 %s：查看实时进度不再白屏", (_name, blocks) => {
  const st = useChat.getState();
  act(() => st.applyHostMessage({ type: "snapshot", state: snapshotState() } as never));
  act(() => st.applyHostMessage({ type: "superTranscript", sessionId: "super-1", from: 0, blocks } as never));
  act(() => root.render(<ErrorBoundary variant="page"><App /></ErrorBoundary>));

  openLiveProgress();

  const renderErrors = captured.filter(a => String(a[0]).includes("render error"));
  expect(renderErrors).toHaveLength(0);
  expect(document.body.textContent).not.toContain("界面出错了");
  // 弹窗正常打开（aria-label 来自 SuperSessionLive 的 ModalShell）。
  expect(document.querySelector('[role="dialog"][aria-label="超流体实时进度"]')).toBeTruthy();
});
