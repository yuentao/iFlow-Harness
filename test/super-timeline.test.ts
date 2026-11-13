/**
 * 子会话阶段轨（shared/super-timeline.ts）。
 *
 * 核心契约只有一条：**只画真实发生过的阶段**。任何「准备 → 运行 → 收尾 →
 * 完成」式的固定模板都会让用户在子会话刚派发时就看到一个已经排到「完成」的
 * 进度条 —— 那是伪造。这些用例把「事实 → 节点」的映射钉死。
 */
import { describe, expect, it } from "vitest";
import type { SuperSessionUi } from "../shared/super-agent.js";
import { deriveSuperTimeline, type SuperTimelineKind } from "../shared/super-timeline.js";

function session(overrides: Partial<SuperSessionUi> = {}): SuperSessionUi {
  return {
    id: "super-1",
    title: "修复登录跳转",
    task: "修好它",
    status: "running",
    isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/a", baseRef: "abc" },
    createdAt: 1000,
    startedAt: 2000,
    updatedAt: 3000,
    reports: [],
    ...overrides,
  };
}

function kinds(s: SuperSessionUi): SuperTimelineKind[] {
  return deriveSuperTimeline(s).map((node) => node.kind);
}

describe("deriveSuperTimeline · 只画真实节点", () => {
  it("运行中（无 endedAt）：末节点是 current，且不出现任何终态/占位节点", () => {
    const nodes = deriveSuperTimeline(session());
    expect(kinds(session())).toEqual(["dispatched", "started"]);
    expect(nodes.map((n) => n.tone)).toEqual(["done", "current"]);
    // 尚未发生的阶段一个都不许预置（没有「收尾」「完成」这种灰点）。
    for (const forbidden of ["completed", "failed", "cancelled", "integration"]) {
      expect(kinds(session())).not.toContain(forbidden);
    }
    expect(nodes.at(-1)?.label).toBe("启动");
    // 时间戳来自真实字段。
    expect(nodes[0]?.at).toBe(1000);
    expect(nodes[1]?.at).toBe(2000);
  });

  it("queued：出现排队节点（没有启动时它就是当前节点）", () => {
    const queued = deriveSuperTimeline(
      session({ status: "preparing", queued: true, startedAt: undefined }),
    );
    expect(queued.map((n) => n.kind)).toEqual(["dispatched", "queued"]);
    expect(queued.at(-1)?.tone).toBe("current");
    expect(queued.at(-1)?.label).toBe("排队");
  });

  it("pending：当前节点是「等待应答」，时间由宿主超时窗口反推", () => {
    const nodes = deriveSuperTimeline(
      session({
        status: "awaiting_input",
        pending: {
          kind: "question",
          requestId: "q-1",
          questions: [],
          deadline: 305_000,
          timeoutMs: 300_000,
        },
      }),
    );
    const last = nodes.at(-1);
    expect(last?.kind).toBe("awaiting_input");
    expect(last?.tone).toBe("current");
    expect(last?.label).toBe("等待应答");
    expect(last?.at).toBe(5_000); // deadline - timeoutMs
  });

  it("attempts=2：出现「第 2 次」节点，并带上次数供 i18n 套模板", () => {
    const nodes = deriveSuperTimeline(session({ attempts: 2 }));
    const attempt = nodes.find((n) => n.kind === "attempt");
    expect(attempt?.label).toBe("第 2 次");
    expect(attempt?.attempt).toBe(2);
    // 首次运行不画「第 1 次」——那不提供任何信息。
    expect(kinds(session())).not.toContain("attempt");
  });

  it("failed / interrupted：末节点带对应终态色调，且没有 current", () => {
    const failed = deriveSuperTimeline(session({ status: "failed", error: "进程崩溃", endedAt: 4000 }));
    expect(failed.at(-1)?.kind).toBe("failed");
    expect(failed.at(-1)?.tone).toBe("failed");
    expect(failed.at(-1)?.at).toBe(4000);
    expect(failed.at(-1)?.detail).toBe("进程崩溃");
    expect(failed.some((n) => n.tone === "current")).toBe(false);

    const cancelled = deriveSuperTimeline(session({ status: "cancelled", endedAt: 4100 }));
    expect(cancelled.at(-1)?.kind).toBe("cancelled");
    expect(cancelled.at(-1)?.tone).toBe("failed");
    expect(cancelled.at(-1)?.label).toBe("已中断");

    const completed = deriveSuperTimeline(session({ status: "completed", endedAt: 4200 }));
    expect(completed.at(-1)?.kind).toBe("completed");
    expect(completed.at(-1)?.tone).toBe("done");
  });

  it("integration=merged：在终态之后加一个「已自动合并」节点", () => {
    const nodes = deriveSuperTimeline(
      session({
        status: "completed",
        endedAt: 4000,
        integration: { mode: "merge", state: "merged", at: 5000 },
      }),
    );
    expect(nodes.map((n) => n.kind)).toEqual(["dispatched", "started", "completed", "integration"]);
    const integration = nodes.at(-1);
    expect(integration?.label).toBe("已自动合并");
    expect(integration?.tone).toBe("done");
    expect(integration?.at).toBe(5000);
  });

  it("integration=skipped：节点保留原因、色调静音（完成但没落地不是绿色成功）", () => {
    const nodes = deriveSuperTimeline(
      session({
        status: "completed",
        endedAt: 4000,
        integration: {
          mode: "merge",
          state: "skipped",
          detail: "工作区有未提交改动",
          at: 5000,
        },
      }),
    );
    const integration = nodes.at(-1);
    expect(integration?.label).toBe("未自动合并");
    expect(integration?.tone).toBe("idle");
    expect(integration?.detail).toBe("工作区有未提交改动");
  });

  it("integration=not_needed：显示「无需合并」，色调静音", () => {
    const nodes = deriveSuperTimeline(
      session({
        status: "completed",
        endedAt: 4000,
        integration: {
          mode: "merge",
          state: "not_needed",
          detail: "无需合并：子会话没有产生任何提交",
          at: 5000,
        },
      }),
    );
    const integration = nodes.at(-1);
    expect(integration?.label).toBe("无需合并");
    expect(integration?.tone).toBe("idle");
    expect(integration?.detail).toBe("无需合并：子会话没有产生任何提交");
  });

  it("restored（重启后恢复的历史记录）：不因恢复而多造节点", () => {
    const nodes = deriveSuperTimeline(
      session({
        status: "cancelled",
        restored: true,
        startedAt: undefined,
        endedAt: undefined,
        updatedAt: 3000,
      }),
    );
    // 只剩「派发 → 已中断」两件真实事实；没有启动、没有伪造的「上次运行」。
    expect(nodes.map((n) => n.kind)).toEqual(["dispatched", "cancelled"]);
    expect(nodes.at(-1)?.at).toBe(3000); // endedAt 缺失时退回磁盘上的 updatedAt
  });

  it("刚派发、未排队也未启动：只有「派发」一个当前节点", () => {
    const nodes = deriveSuperTimeline(
      session({ status: "preparing", queued: undefined, startedAt: undefined }),
    );
    expect(nodes.map((n) => n.kind)).toEqual(["dispatched"]);
    expect(nodes[0]?.tone).toBe("current");
  });
});
