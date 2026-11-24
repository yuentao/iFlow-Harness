/**
 * 子会话阶段轨（shared/super-timeline.ts）。
 *
 * 核心契约只有一条：**只画真实发生过的阶段**。任何「准备 → 运行 → 收尾 →
 * 完成」式的固定模板都会让用户在子会话刚派发时就看到一个已经排到「完成」的
 * 进度条 —— 那是伪造。这些用例把「事实 → 节点」的映射钉死。
 */
import { describe, expect, it } from "vitest";
import type { SuperSessionUi, SuperTodoUi } from "../shared/super-agent.js";
import {
  deriveSuperTimeline,
  describeSuperTimelineFacts,
  isCriticalTimelineNode,
  layoutSuperTimeline,
  summarizeSuperTimelineProgress,
  SUPER_TIMELINE_FOLD_MIN_NODES,
  SUPER_TODO_DETAIL_SEP,
  type SuperTimelineKind,
  type SuperTimelineNode,
} from "../shared/super-timeline.js";

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
    expect(nodes.at(-1)?.label).toBe("已启动");
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
    expect(last?.label).toBe("在等你回答");
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
          detail: "无需合并：超流体没有产生任何提交",
          at: 5000,
        },
      }),
    );
    const integration = nodes.at(-1);
    expect(integration?.label).toBe("无需合并");
    expect(integration?.tone).toBe("idle");
    expect(integration?.detail).toBe("无需合并：超流体没有产生任何提交");
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

describe("deriveSuperTimeline · 只用 todolist 节点", () => {
  const todos: SuperTodoUi[] = [
    { content: "读代码", status: "completed" },
    { content: "改实现", status: "in_progress", priority: "high" },
    { content: "跑测试", status: "pending", priority: "low" },
  ];

  it("有 todos：只画 todo 节点，一个条目一个，label 是原文且 rawLabel", () => {
    const nodes = deriveSuperTimeline(session({ todos }));
    expect(nodes.map((n) => n.kind)).toEqual(["todo", "todo", "todo"]);
    expect(nodes.map((n) => n.label)).toEqual(["读代码", "改实现", "跑测试"]);
    // 动态文本绝不过字典；派发 / 启动 / 集成等阶段事实不再占节点。
    expect(nodes.every((n) => n.rawLabel === true)).toBe(true);
    for (const forbidden of ["dispatched", "started", "completed", "integration"]) {
      expect(nodes.map((n) => n.kind)).not.toContain(forbidden);
    }
    // wire 不带逐条时间戳，绝不伪造。
    expect(nodes.every((n) => n.at === undefined)).toBe(true);
  });

  it("tone 由条目自身状态决定：completed→done、in_progress→current、pending→idle", () => {
    const nodes = deriveSuperTimeline(session({ todos }));
    expect(nodes.map((n) => n.tone)).toEqual(["done", "current", "idle"]);
  });

  it("detail 放状态/优先级的中文说明（只进 title），不含动态文本", () => {
    const nodes = deriveSuperTimeline(session({ todos }));
    expect(nodes[0]?.detail).toBe("已完成");
    expect(nodes[1]?.detail).toBe(`进行中${SUPER_TODO_DETAIL_SEP}高优先级`);
    expect(nodes[2]?.detail).toBe(`待办${SUPER_TODO_DETAIL_SEP}低优先级`);
    expect(nodes.every((n) => !n.detail?.includes("读代码"))).toBe(true);
  });

  it("终态会话不允许 current：残留 in_progress 归为 done", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      const nodes = deriveSuperTimeline(session({ status, todos, endedAt: 4000 }));
      expect(nodes.map((n) => n.tone)).toEqual(["done", "done", "idle"]);
      expect(nodes.some((n) => n.tone === "current")).toBe(false);
    }
  });

  it("restored 历史记录不允许 current：不能谎称还在跑", () => {
    const nodes = deriveSuperTimeline(session({ status: "cancelled", restored: true, todos }));
    expect(nodes.map((n) => n.tone)).toEqual(["done", "done", "idle"]);
    expect(nodes.some((n) => n.tone === "current")).toBe(false);
  });

  it("todos 为空数组 / 缺省：完整回退阶段节点，不空白、不伪造", () => {
    const withEmpty = deriveSuperTimeline(session({ todos: [], startedAt: 2000 }));
    expect(withEmpty.map((n) => n.kind)).toEqual(["dispatched", "started"]);
    const without = deriveSuperTimeline(session({ startedAt: 2000 }));
    expect(without.map((n) => n.kind)).toEqual(["dispatched", "started"]);
    expect(withEmpty).toEqual(without);
  });

  it("describeSuperTimelineFacts：阶段事实拼成中文串供 title 使用", () => {
    const facts = describeSuperTimelineFacts(
      session({
        status: "completed",
        startedAt: 2000,
        endedAt: 4000,
        integration: { mode: "merge", state: "not_needed", at: 5000 },
      }),
    );
    expect(facts).toBe("已派出 → 已启动 → 已完成 → 无需合并");
    // 复用阶段逻辑：即使有 todos，facts 仍是阶段事实（不受 todolist 影响）。
    expect(describeSuperTimelineFacts(session({ todos, startedAt: 2000 }))).toBe(
      "已派出 → 已启动",
    );
  });
});

/** 造节点的小工具：只关心 kind / tone。 */
function node(kind: SuperTimelineKind, tone: SuperTimelineNode["tone"]): SuperTimelineNode {
  return { kind, tone, label: kind };
}

describe("isCriticalTimelineNode · 需要用户介入的节点", () => {
  it("等待回答 / 失败 / 合并失败是关键节点", () => {
    expect(isCriticalTimelineNode(node("awaiting_input", "current"))).toBe(true);
    expect(isCriticalTimelineNode(node("failed", "failed"))).toBe(true);
    expect(isCriticalTimelineNode(node("integration", "failed"))).toBe(true);
  });

  it("已完成 / 已中断 / 跳过的集成 / 普通 todo 不是关键节点", () => {
    expect(isCriticalTimelineNode(node("completed", "done"))).toBe(false);
    // 已中断不需要用户动手 —— 折起来不丢可操作信息。
    expect(isCriticalTimelineNode(node("cancelled", "failed"))).toBe(false);
    // 跳过 / 无需合并是静音事实，不是冲突。
    expect(isCriticalTimelineNode(node("integration", "idle"))).toBe(false);
    expect(isCriticalTimelineNode(node("integration", "done"))).toBe(false);
    expect(isCriticalTimelineNode(node("todo", "current"))).toBe(false);
    expect(isCriticalTimelineNode(node("dispatched", "done"))).toBe(false);
  });
});

describe("summarizeSuperTimelineProgress · 顶部进度计数", () => {
  it("done = tone 为 done 的节点数，total = 全部节点", () => {
    const nodes = [
      node("dispatched", "done"),
      node("started", "done"),
      node("completed", "done"),
      node("integration", "idle"),
      node("todo", "current"),
    ];
    expect(summarizeSuperTimelineProgress(nodes)).toEqual({ done: 3, total: 5 });
  });

  it("空节点序列给出 0/0（组件据此避免除零）", () => {
    expect(summarizeSuperTimelineProgress([])).toEqual({ done: 0, total: 0 });
  });
});

describe("layoutSuperTimeline · 默认只展开当前步与上一步", () => {
  /** 5 条 todo：done done done current pending。 */
  function fiveNodes(): SuperTimelineNode[] {
    return [
      node("todo", "done"),
      node("todo", "done"),
      node("todo", "done"),
      node("todo", "current"),
      node("todo", "idle"),
    ];
  }

  it("节点数低于阈值时整条展开（折叠只增加点击，不减少高度）", () => {
    const nodes = fiveNodes().slice(0, SUPER_TIMELINE_FOLD_MIN_NODES - 1);
    expect(layoutSuperTimeline(nodes, false)).toEqual(
      nodes.map((_, index) => ({ type: "node", index })),
    );
  });

  it("默认态：当前步 + 上一步露出，其余按连续区间各自折叠", () => {
    const rows = layoutSuperTimeline(fiveNodes(), false);
    // 锚点 = 当前节点(3)，上一步(2)一起露出；0/1 与 4 各折成一行。
    expect(rows[0]).toEqual({ type: "folded", indices: [0, 1] });
    expect(rows[1]).toEqual({ type: "node", index: 2 });
    expect(rows[2]).toEqual({ type: "node", index: 3 });
    expect(rows[3]).toEqual({ type: "folded", indices: [4] });
  });

  it("expanded=true 时全部展开，没有 folded 行", () => {
    const rows = layoutSuperTimeline(fiveNodes(), true);
    expect(rows.every((row) => row.type === "node")).toBe(true);
    expect(rows).toHaveLength(5);
  });

  it("终态 todo 轨没有 current：锚点是最后一个节点，其前一步一起露出", () => {
    const nodes = [
      node("todo", "done"),
      node("todo", "done"),
      node("todo", "done"),
      node("todo", "idle"),
    ];
    const rows = layoutSuperTimeline(nodes, false);
    expect(rows).toContainEqual({ type: "node", index: 2 });
    expect(rows).toContainEqual({ type: "node", index: 3 });
    expect(rows[0]).toEqual({ type: "folded", indices: [0, 1] });
  });

  it("阶段轨（非 todolist）永不折叠：生命周期事实最多六行，折起来只丢信息", () => {
    const nodes = [
      node("dispatched", "done"),
      node("attempt", "done"),
      node("queued", "done"),
      node("started", "done"),
      node("completed", "done"),
      node("integration", "idle"),
    ];
    expect(layoutSuperTimeline(nodes, false)).toEqual(
      nodes.map((_, index) => ({ type: "node", index })),
    );
  });

  it("关键状态永不折叠：等待回答 / 失败即使远离当前步也强制露出", () => {
    const nodes = [
      node("awaiting_input", "current"), // 关键：在等你回答
      node("todo", "done"),
      node("todo", "done"),
      node("todo", "done"),
      node("todo", "done"),
      node("todo", "current"),
    ];
    const rows = layoutSuperTimeline(nodes, false);
    // 关键节点单独露出，不与后面的折叠组混在一起。
    expect(rows[0]).toEqual({ type: "node", index: 0 });
    // 1..3 折成一行（4 是最后一个 current 的上一步，露出）。
    expect(rows[1]).toEqual({ type: "folded", indices: [1, 2, 3] });
    expect(rows.slice(2)).toEqual([
      { type: "node", index: 4 },
      { type: "node", index: 5 },
    ]);
  });

  it("折叠组保留原始索引（webview 据此判断是否全部完成）", () => {
    const rows = layoutSuperTimeline(fiveNodes(), false);
    const folded = rows.find((row) => row.type === "folded");
    expect(folded && folded.type === "folded" ? folded.indices : []).toEqual([0, 1]);
  });
});
