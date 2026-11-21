/**
 * 残留清单新协议（`requestSuperResidueList` ↔ `superResidueList` ↔
 * `superResidueHandle`）的 store 侧闭环（无 DOM）：
 *
 *  · 请求带自增 requestId，回包只在 requestId 配对时入库（迟到的旧清单被丢弃）；
 *  · 批量处置原样回传一次性 confirmToken，发完立刻换发新清单（旧令牌已作废）；
 *  · 令牌缺失时如实提示并重新请求，绝不发一条注定被宿主拒绝的处置消息；
 *  · 回答宿主确认框（confirmed=true）且看板请求过清单时刷新一次。
 *
 * acquireVsCodeApi 在 store 模块求值时被读取，因此用 vi.hoisted 在导入前注入桩，
 * 捕获所有 webview → host 消息。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SuperResidueBranchUi } from "../shared/messages";

const capture = vi.hoisted(() => {
  const posted: Array<Record<string, unknown>> = [];
  (globalThis as typeof globalThis & {
    acquireVsCodeApi: () => { postMessage: (m: unknown) => void };
  }).acquireVsCodeApi = () => ({
    postMessage: (m: unknown) => {
      posted.push(m as Record<string, unknown>);
    },
  });
  return { posted };
});

import { useChat } from "../webview/src/store";

const BRANCH: SuperResidueBranchUi = {
  sessionId: "res-1",
  branch: "iflow/super/refactor-z9",
  worktree: "/tmp/wt-res",
  title: "被中断的重构",
  unmerged: true,
  worktreeExists: true,
};

function lastSent(): Record<string, unknown> {
  const sent = capture.posted[capture.posted.length - 1];
  if (!sent) throw new Error("nothing was posted");
  return sent;
}

/** 发一次请求并喂回一条匹配的回包，返回该回包的 confirmToken。 */
function seedList(token: string): string {
  const state = useChat.getState();
  state.requestSuperResidueList();
  const requestId = useChat.getState().superResidueRequestId!;
  state.applyHostMessage({
    type: "superResidueList",
    requestId,
    branches: [BRANCH],
    confirmToken: token,
  });
  return requestId;
}

beforeEach(() => {
  capture.posted.length = 0;
  useChat.setState({
    superResidueList: null,
    superResidueRequestId: null,
    superResidueLoading: false,
    superResidueConfirm: null,
    toasts: [],
  });
});

describe("残留清单新协议 · store", () => {
  it("requestSuperResidueList 发出带 requestId 的请求并置加载态", () => {
    useChat.getState().requestSuperResidueList();
    const sent = lastSent();
    expect(sent.type).toBe("requestSuperResidueList");
    expect(typeof sent.requestId).toBe("string");
    expect(useChat.getState().superResidueRequestId).toBe(sent.requestId);
    expect(useChat.getState().superResidueLoading).toBe(true);
  });

  it("superResidueList 只在 requestId 配对时入库并结束加载", () => {
    const state = useChat.getState();
    state.requestSuperResidueList();
    const requestId = useChat.getState().superResidueRequestId!;

    // 迟到的旧回包：不能覆盖当前清单，也不能结束加载态。
    state.applyHostMessage({
      type: "superResidueList",
      requestId: "stale-request",
      branches: [],
      confirmToken: "old-token",
    });
    expect(useChat.getState().superResidueList).toBeNull();
    expect(useChat.getState().superResidueLoading).toBe(true);

    state.applyHostMessage({
      type: "superResidueList",
      requestId,
      branches: [BRANCH],
      confirmToken: "tok-1",
    });
    expect(useChat.getState().superResidueList?.confirmToken).toBe("tok-1");
    expect(useChat.getState().superResidueList?.branches[0]?.sessionId).toBe("res-1");
    expect(useChat.getState().superResidueLoading).toBe(false);
  });

  it("批量处置带 confirmToken，发完立刻换发新清单（旧令牌已作废）", () => {
    seedList("tok-1");
    capture.posted.length = 0;

    useChat.getState().handleSuperResidueAction("merge", ["res-1", "res-2"]);

    expect(capture.posted[0]).toEqual({
      type: "superResidueHandle",
      action: "merge",
      sessionIds: ["res-1", "res-2"],
      confirmToken: "tok-1",
    });
    const refresh = capture.posted[1];
    expect(refresh?.type).toBe("requestSuperResidueList");
    expect(useChat.getState().superResidueLoading).toBe(true);
    // 旧令牌立即作废（清单行保留，但令牌清空）。
    expect(useChat.getState().superResidueList?.confirmToken).toBe("");
  });

  it("刷新回包到达前的第二次处置不会复用已消费的令牌", () => {
    seedList("tok-5");
    useChat.getState().handleSuperResidueAction("merge", ["res-1"]);
    capture.posted.length = 0;

    // 新清单还没回来：第二次点击必须走「令牌缺失 → 重新请求」，不再发 handle。
    useChat.getState().handleSuperResidueAction("merge", ["res-1"]);
    expect(capture.posted.some((m) => m.type === "superResidueHandle")).toBe(false);
    expect(capture.posted.filter((m) => m.type === "requestSuperResidueList")).toHaveLength(1);
  });

  it("丢弃同样走批量载荷（action=discard）", () => {
    seedList("tok-2");
    capture.posted.length = 0;
    useChat.getState().handleSuperResidueAction("discard", ["res-1"]);
    expect(capture.posted[0]).toEqual({
      type: "superResidueHandle",
      action: "discard",
      sessionIds: ["res-1"],
      confirmToken: "tok-2",
    });
  });

  it("令牌缺失时如实提示并重新请求，绝不发处置消息", () => {
    useChat.getState().handleSuperResidueAction("discard", ["res-1"]);
    expect(capture.posted.some((m) => m.type === "superResidueHandle")).toBe(false);
    expect(capture.posted.filter((m) => m.type === "requestSuperResidueList")).toHaveLength(1);
    const toast = useChat.getState().toasts.at(-1);
    expect(toast?.level).toBe("warning");
    expect(toast?.message).toContain("残留清单已过期");
  });

  it("空 sessionIds 不发任何消息", () => {
    seedList("tok-3");
    capture.posted.length = 0;
    useChat.getState().handleSuperResidueAction("merge", []);
    expect(capture.posted).toHaveLength(0);
  });

  it("回答确认框 confirmed=true 且请求过清单时刷新；false 不刷新", () => {
    seedList("tok-4");
    const confirm = {
      type: "superResidueConfirm" as const,
      requestId: "confirm-1",
      title: "丢弃残留工作目录？",
      message: "即将丢弃 1 项残留",
      confirmLabel: "丢弃",
      cancelLabel: "取消",
    };

    useChat.setState({ superResidueConfirm: confirm });
    capture.posted.length = 0;
    useChat.getState().respondSuperResidueConfirm(false);
    expect(capture.posted.map((m) => m.type)).toEqual(["respondSuperResidueConfirm"]);

    useChat.setState({ superResidueConfirm: confirm });
    capture.posted.length = 0;
    useChat.getState().respondSuperResidueConfirm(true);
    expect(capture.posted.map((m) => m.type)).toEqual([
      "respondSuperResidueConfirm",
      "requestSuperResidueList",
    ]);
  });
});
