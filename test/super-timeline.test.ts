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
  computeSuperTimelineEdgeHints,
  computeSuperTimelineTranslateX,
  deriveSuperTimeline,
  describeSuperTimelineFacts,
  estimateSuperTimelineGeometry,
  isCriticalTimelineNode,
  layoutSuperTimelineFocus,
  summarizeSuperTimelineProgress,
  SUPER_TIMELINE_NODE_PITCH,
  SUPER_TIMELINE_NODE_SIZE,
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

describe("estimateSuperTimelineGeometry · 等距模型", () => {
  it("节点中心等距排列，轨道宽 = 末节点右缘", () => {
    const { centers, trackWidth } = estimateSuperTimelineGeometry(3);
    expect(centers).toEqual([
      SUPER_TIMELINE_NODE_SIZE / 2,
      SUPER_TIMELINE_NODE_PITCH + SUPER_TIMELINE_NODE_SIZE / 2,
      2 * SUPER_TIMELINE_NODE_PITCH + SUPER_TIMELINE_NODE_SIZE / 2,
    ]);
    expect(trackWidth).toBe(2 * SUPER_TIMELINE_NODE_PITCH + SUPER_TIMELINE_NODE_SIZE);
  });

  it("空序列给出空模型（组件据此渲染空轨，不除零）", () => {
    expect(estimateSuperTimelineGeometry(0)).toEqual({ centers: [], trackWidth: 0 });
  });
});

describe("computeSuperTimelineTranslateX · 当前节点居中", () => {
  const VIEWPORT = 200;
  const geometry = estimateSuperTimelineGeometry(15);

  it("轨道装得下时整条轨道居中（空白均分两侧），奇数轨的中间节点正好在正中", () => {
    const small = estimateSuperTimelineGeometry(3);
    const shift = computeSuperTimelineTranslateX({
      focusCenter: small.centers[1]!,
      trackWidth: small.trackWidth,
      viewportWidth: VIEWPORT,
    });
    expect(shift).toBe(Math.round((VIEWPORT - small.trackWidth) / 2));
    // 中间节点精确居中；首末节点按规格豁免（宁可偏一点也不把空白全推一侧）。
    expect(Math.abs(small.centers[1]! + shift - VIEWPORT / 2)).toBeLessThanOrEqual(1);
    // 空白均分：两侧留白相等。
    expect(shift).toBe(VIEWPORT - small.trackWidth - shift);
  });

  it("装不下时把当前节点放在视窗正中", () => {
    const focusCenter = geometry.centers[7]!;
    const shift = computeSuperTimelineTranslateX({
      focusCenter,
      trackWidth: geometry.trackWidth,
      viewportWidth: VIEWPORT,
    });
    // 节点中心的屏幕位置 = 轨道内坐标 + 平移量，应等于视窗中点。
    expect(Math.abs(focusCenter + shift - VIEWPORT / 2)).toBeLessThanOrEqual(1);
  });

  it("首节点 clamp 到 0：左侧绝不拉出空白", () => {
    const shift = computeSuperTimelineTranslateX({
      focusCenter: geometry.centers[0]!,
      trackWidth: geometry.trackWidth,
      viewportWidth: VIEWPORT,
    });
    expect(shift).toBe(0);
  });

  it("末节点 clamp 到 viewportWidth - trackWidth：右侧绝不拉出空白", () => {
    const shift = computeSuperTimelineTranslateX({
      focusCenter: geometry.centers.at(-1)!,
      trackWidth: geometry.trackWidth,
      viewportWidth: VIEWPORT,
    });
    expect(shift).toBe(VIEWPORT - geometry.trackWidth);
    // 平移量永远 ≤ 0（轨道只左移，不会右移出左侧空白）。
    expect(shift).toBeLessThanOrEqual(0);
  });

  it("还没布局（视窗宽 0）时平移量为 0", () => {
    expect(
      computeSuperTimelineTranslateX({ focusCenter: 100, trackWidth: 400, viewportWidth: 0 }),
    ).toBe(0);
  });
});

describe("computeSuperTimelineEdgeHints · 屏外关键节点提示", () => {
  const VIEWPORT = 200;

  /** n 条 todo 节点，只有 `criticalAt` 那条是失败（关键）节点。 */
  function withCritical(n: number, criticalAt: number): SuperTimelineNode[] {
    return Array.from({ length: n }, (_, index) =>
      index === criticalAt ? node("failed", "failed") : node("todo", "done"),
    );
  }

  it("关键节点落在左侧视窗外：给出左侧提示并指向它", () => {
    const nodes = withCritical(15, 1);
    const geometry = estimateSuperTimelineGeometry(nodes.length);
    const shift = computeSuperTimelineTranslateX({
      focusCenter: geometry.centers[10]!,
      trackWidth: geometry.trackWidth,
      viewportWidth: VIEWPORT,
    });
    const hints = computeSuperTimelineEdgeHints({
      nodes,
      centers: geometry.centers,
      translateX: shift,
      viewportWidth: VIEWPORT,
    });
    expect(hints).toHaveLength(1);
    expect(hints[0]!.side).toBe("left");
    expect(hints[0]!.index).toBe(1);
    expect(hints[0]!.count).toBe(1);
    expect(hints[0]!.tone).toBe("danger");
  });

  it("关键节点落在右侧视窗外：给出右侧提示，色调跟随节点种类", () => {
    const nodes = Array.from({ length: 15 }, (_, index) =>
      index === 13 ? node("awaiting_input", "current") : node("todo", "done"),
    );
    const geometry = estimateSuperTimelineGeometry(nodes.length);
    const shift = computeSuperTimelineTranslateX({
      focusCenter: geometry.centers[1]!,
      trackWidth: geometry.trackWidth,
      viewportWidth: VIEWPORT,
    });
    const hints = computeSuperTimelineEdgeHints({
      nodes,
      centers: geometry.centers,
      translateX: shift,
      viewportWidth: VIEWPORT,
    });
    const right = hints.find((hint) => hint.side === "right");
    expect(right).toBeTruthy();
    expect(right!.index).toBe(13);
    expect(right!.tone).toBe("warning");
  });

  it("关键节点就在视窗内：不产生任何边缘提示", () => {
    const nodes = withCritical(5, 2);
    const geometry = estimateSuperTimelineGeometry(nodes.length);
    // 5 个节点装得下 200px 视窗 → 整条轨居中，全部可见。
    const shift = computeSuperTimelineTranslateX({
      focusCenter: geometry.centers[2]!,
      trackWidth: geometry.trackWidth,
      viewportWidth: VIEWPORT,
    });
    expect(
      computeSuperTimelineEdgeHints({
        nodes,
        centers: geometry.centers,
        translateX: shift,
        viewportWidth: VIEWPORT,
      }),
    ).toEqual([]);
  });

  it("同一侧多个关键节点：数量如实累计，最近的那个决定索引与色调", () => {
    const nodes = Array.from({ length: 15 }, (_, index) =>
      index === 1 ? node("failed", "failed") : index === 4 ? node("awaiting_input", "current") : node("todo", "done"),
    );
    const geometry = estimateSuperTimelineGeometry(nodes.length);
    const shift = computeSuperTimelineTranslateX({
      focusCenter: geometry.centers[12]!,
      trackWidth: geometry.trackWidth,
      viewportWidth: VIEWPORT,
    });
    const left = computeSuperTimelineEdgeHints({
      nodes,
      centers: geometry.centers,
      translateX: shift,
      viewportWidth: VIEWPORT,
    }).find((hint) => hint.side === "left");
    expect(left).toBeTruthy();
    expect(left!.count).toBe(2);
    expect(left!.index).toBe(4);
    expect(left!.tone).toBe("warning");
    expect(left!.labels).toHaveLength(2);
  });

  it("还没布局时不给提示（避免首帧闪一下）", () => {
    expect(
      computeSuperTimelineEdgeHints({
        nodes: withCritical(5, 0),
        centers: estimateSuperTimelineGeometry(5).centers,
        translateX: 0,
        viewportWidth: 0,
      }),
    ).toEqual([]);
  });
});

describe("layoutSuperTimelineFocus · 平移 + 边缘提示一起算", () => {
  const VIEWPORT = 160;

  it("屏外关键节点：给出提示，同时当前步仍精确居中（提示不占用轨道宽度）", () => {
    // 8 个节点（轨道 232px）塞进 160px 视窗：当前步在第 5 个，
    // 失败 / 合并冲突落在右侧视窗外。
    const nodes: SuperTimelineNode[] = [
      node("todo", "done"),
      node("todo", "done"),
      node("todo", "done"),
      node("awaiting_input", "current"),
      node("todo", "done"),
      node("todo", "done"),
      node("failed", "failed"),
      node("integration", "failed"),
    ];
    const geometry = estimateSuperTimelineGeometry(nodes.length);
    const layout = layoutSuperTimelineFocus({
      nodes,
      centers: geometry.centers,
      trackWidth: geometry.trackWidth,
      viewportWidth: VIEWPORT,
      focusIndex: 3,
    });
    const right = layout.hints.find((hint) => hint.side === "right");
    expect(right).toBeTruthy();
    expect(right!.count).toBeGreaterThanOrEqual(1);
    // 提示渲染在轨道下方单独一行，不挤占轨道：当前步仍精确居中。
    const screenCenter = geometry.centers[3]! + layout.translateX;
    expect(Math.abs(screenCenter - VIEWPORT / 2)).toBeLessThanOrEqual(1);
  });

  it("关键节点全在视窗内：不给提示，轨道整体居中", () => {
    const nodes = [
      node("dispatched", "done"),
      node("failed", "failed"),
      node("awaiting_input", "current"),
    ];
    const geometry = estimateSuperTimelineGeometry(nodes.length);
    const layout = layoutSuperTimelineFocus({
      nodes,
      centers: geometry.centers,
      trackWidth: geometry.trackWidth,
      viewportWidth: VIEWPORT,
      focusIndex: 2,
    });
    expect(layout.hints).toEqual([]);
    // 3 个节点装得下 → 整条轨居中。
    expect(layout.translateX).toBe(Math.round((VIEWPORT - geometry.trackWidth) / 2));
  });
});
