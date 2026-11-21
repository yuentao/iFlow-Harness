/**
 * Super Agent 共享契约层：任务依赖 / 批次 / 波次 + 诊断事件 + 消息协议。
 *
 * 本文件钉住的是**共享层**（`shared/super-agent.ts` + `shared/messages.ts`）的
 * 纯逻辑契约：
 *  - 三种模式（平铺 / 依赖 / 批次）的判定与波次计算；
 *  - 校验错误的**分层**（块级错误整块拒绝 / 条级错误只丢这一条）——
 *    这是本次改造最关键的一条：新增字段若被静默忽略，依赖语义会整段丢失；
 *  - 诊断事件的追加 / 截断 / 终态粘性；
 *  - 看板投影的裁剪与归档往返。
 *
 * 宿主层（`src/panel/**`）如何接线不在本文件范围 —— 见共享层的导出说明。
 */
import { describe, it, expect } from "vitest";
import {
  applySuperDiagnostic,
  applySuperFailure,
  fromPersistedSuperSession,
  groupSuperReportsByWave,
  parseSuperDelegationPayload,
  planSuperWaves,
  superArchiveFingerprint,
  superParseIssueMessages,
  superTaskKey,
  toPersistedSuperSession,
  toSuperBoardSession,
  SUPER_BOARD_DIAGNOSTICS_MAX_EVENTS,
  SUPER_DIAGNOSTICS_MAX_EVENTS,
  SUPER_PROGRESS_TAIL_MAX_CHARS,
  type PersistedSuperSession,
  type SuperDiagnosticEvent,
  type SuperSessionUi,
  type SuperTaskSpec,
} from "../shared/super-agent.js";
import { parseSuperToolCall } from "../shared/super-tool-call.js";
import type { WebviewToHost } from "../shared/messages.js";

function session(overrides: Partial<SuperSessionUi> = {}): SuperSessionUi {
  return {
    id: "super-1",
    title: "修复登录跳转",
    task: "修好它",
    status: "preparing",
    isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/a", baseRef: "abc" },
    createdAt: 1000,
    updatedAt: 1000,
    reports: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 模式判定与波次计算
// ---------------------------------------------------------------------------

describe("super waves · 模式判定与波次计算", () => {
  it("平铺模式：没有任何依赖 / 批次 → 全部 wave 0", () => {
    const plan = planSuperWaves([
      { title: "A", task: "任务 A" },
      { title: "B", task: "任务 B" },
    ]);
    expect(plan.mode).toBe("flat");
    expect(plan.waves).toEqual([["A", "B"]]);
    expect(plan.taskWave).toEqual({ A: 0, B: 0 });
    expect(plan.issues).toEqual([]);
  });

  it("依赖模式：多级依赖 → wave 0 / 1 / 2（最长依赖路径）", () => {
    const plan = planSuperWaves([
      { id: "d", title: "数据层", task: "实现数据层" },
      { id: "a", title: "接口层", task: "实现接口层", dependsOn: ["d"] },
      { id: "b", title: "联调", task: "跑联调", dependsOn: ["a"] },
    ]);
    expect(plan.mode).toBe("dependency");
    expect(plan.taskWave).toEqual({ d: 0, a: 1, b: 2 });
    expect(plan.waves).toEqual([["d"], ["a"], ["b"]]);
    expect(plan.issues).toEqual([]);
  });

  it("依赖模式：标识先按 id 解析，解析不到再按 title 解析", () => {
    const plan = planSuperWaves([
      { id: "data", title: "数据层", task: "实现数据层" },
      { title: "接口层", task: "实现接口层", dependsOn: ["data"] },
      { title: "缓存层", task: "实现缓存层", dependsOn: ["数据层"] },
    ]);
    expect(plan.taskWave).toEqual({ data: 0, 接口层: 1, 缓存层: 1 });
    expect(plan.issues).toEqual([]);
  });

  it("依赖模式：部分任务没有 dependsOn 是合法的（它们在 wave 0）", () => {
    const plan = planSuperWaves([
      { title: "独立的活", task: "随手做" },
      { title: "数据层", task: "实现数据层" },
      { title: "接口层", task: "实现接口层", dependsOn: ["数据层"] },
    ]);
    expect(plan.mode).toBe("dependency");
    expect(plan.taskWave).toEqual({ 独立的活: 0, 数据层: 0, 接口层: 1 });
    expect(plan.waves).toEqual([["独立的活", "数据层"], ["接口层"]]);
  });

  it("批次模式：batch 值离散压缩成 0..n-1，没填 batch 的任务归 wave 0", () => {
    const plan = planSuperWaves([
      { title: "A", task: "第一批", batch: 2 },
      { title: "B", task: "第二批", batch: 1 },
      { title: "C", task: "没填批次" },
    ]);
    expect(plan.mode).toBe("batch");
    // batch 值离散排名：B(1) → 0、A(2) → 1；没填 batch 的 C 归 wave 0。
    expect(plan.taskWave).toEqual({ B: 0, A: 1, C: 0 });
    expect(plan.waves).toEqual([["B", "C"], ["A"]]);
    expect(plan.issues).toEqual([]);
  });

  it("批次模式：batch 值不连续也按离散排名压缩（2 与 5 → wave 0 / 1）", () => {
    const plan = planSuperWaves([
      { title: "A", task: "任务 A", batch: 5 },
      { title: "B", task: "任务 B", batch: 2 },
    ]);
    expect(plan.taskWave).toEqual({ B: 0, A: 1 });
  });

  it("superTaskKey：优先 id，缺省用 title", () => {
    expect(superTaskKey({ id: "x", title: "标题" })).toBe("x");
    expect(superTaskKey({ title: "标题" })).toBe("标题");
    expect(superTaskKey({ id: "   ", title: "标题" })).toBe("标题");
  });
});

// ---------------------------------------------------------------------------
// 校验错误分层
// ---------------------------------------------------------------------------

describe("super waves · 块级错误（整块拒绝，不得部分派发）", () => {
  it("混合模式：同块同时出现 dependsOn 与 batch → 整块拒绝", () => {
    const parsed = parseSuperDelegationPayload({
      tasks: [
        { title: "A", task: "任务 A", dependsOn: ["B"] },
        { title: "B", task: "任务 B", batch: 2 },
      ],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("dependsOn");
    expect(parsed.issues.join("；")).toContain("batch");
  });

  it("混合模式：plan 层给出 mixed_mode 且 waves 为空", () => {
    const plan = planSuperWaves([
      { title: "A", task: "任务 A", dependsOn: ["B"] },
      { title: "B", task: "任务 B", batch: 2 },
    ]);
    expect(plan.issues.some((issue) => issue.kind === "mixed_mode")).toBe(true);
    expect(plan.issues.every((issue) => issue.blockLevel)).toBe(true);
    expect(plan.waves).toEqual([]);
    expect(plan.taskWave).toEqual({});
  });

  it("同一任务同时带 dependsOn 与 batch → 整块拒绝", () => {
    const plan = planSuperWaves([
      { title: "A", task: "任务 A", dependsOn: ["B"], batch: 1 },
      { title: "B", task: "任务 B" },
    ]);
    expect(plan.issues.some((issue) => issue.kind === "task_dual_mode")).toBe(true);
    expect(plan.waves).toEqual([]);
  });

  it("依赖成环 → 整块拒绝（诊断里给出环上的任务）", () => {
    const plan = planSuperWaves([
      { title: "A", task: "任务 A", dependsOn: ["B"] },
      { title: "B", task: "任务 B", dependsOn: ["A"] },
    ]);
    const cycle = plan.issues.find((issue) => issue.kind === "dependency_cycle");
    expect(cycle).toBeDefined();
    expect(cycle?.blockLevel).toBe(true);
    expect(cycle?.message).toContain("A");
    expect(cycle?.message).toContain("B");
    expect(plan.waves).toEqual([]);
  });

  it("悬空依赖 → 整块拒绝（诊断里列出未解析的标识）", () => {
    const plan = planSuperWaves([
      { title: "A", task: "任务 A", dependsOn: ["并不存在的任务"] },
    ]);
    const missing = plan.issues.find((issue) => issue.kind === "dependency_missing");
    expect(missing).toBeDefined();
    expect(missing?.blockLevel).toBe(true);
    expect(missing?.message).toContain("并不存在的任务");
  });

  it("悬空依赖在解析层同样整块拒绝（不得部分派发）", () => {
    const parsed = parseSuperDelegationPayload({
      tasks: [
        { title: "A", task: "任务 A", dependsOn: ["并不存在的任务"] },
        { title: "B", task: "任务 B" },
      ],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.join("；")).toContain("并不存在的任务");
  });

  it("title 重复 → 整块拒绝（title 参与标识解析）", () => {
    const plan = planSuperWaves([
      { title: "同一个", task: "任务 A" },
      { title: "同一个", task: "任务 B" },
    ]);
    const duplicate = plan.issues.find((issue) => issue.kind === "duplicate_title");
    expect(duplicate).toBeDefined();
    expect(duplicate?.blockLevel).toBe(true);
    expect(plan.waves).toEqual([]);
  });

  it("id 重复 → 整块拒绝（id 必须块内唯一）", () => {
    const plan = planSuperWaves([
      { id: "x", title: "A", task: "任务 A" },
      { id: "x", title: "B", task: "任务 B" },
    ]);
    expect(plan.issues.some((issue) => issue.kind === "duplicate_id")).toBe(true);
  });

  it("batch 不是正整数 → 整块拒绝（0 / -1 / 1.5 / 字符串）", () => {
    for (const batch of [0, -1, 1.5, "2"]) {
      const parsed = parseSuperDelegationPayload({
        tasks: [{ title: "A", task: "任务 A", batch }],
      });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.issues.join("；")).toContain("batch");
    }
  });

  it("dependsOn 不是字符串数组 → 整块拒绝（绝不静默忽略）", () => {
    const parsed = parseSuperDelegationPayload({
      tasks: [{ title: "A", task: "任务 A", dependsOn: "B" }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.join("；")).toContain("dependsOn");
  });

  it("id 不是字符串 → 整块拒绝", () => {
    const parsed = parseSuperDelegationPayload({
      tasks: [{ id: 7, title: "A", task: "任务 A" }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.join("；")).toContain("id");
  });
});

describe("super waves · 条级错误（丢弃该条，其余照派）", () => {
  it("缺 title → 丢弃该条，保留其余，并记 issue", () => {
    const parsed = parseSuperDelegationPayload({
      tasks: [
        { title: "合法", task: "任务 A" },
        { task: "缺标题的任务" },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0]?.title).toBe("合法");
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]).toContain("title 必填");
  });

  it("缺 task → 丢弃该条，保留其余，并记 issue", () => {
    const parsed = parseSuperDelegationPayload({
      tasks: [
        { title: "合法", task: "任务 A" },
        { title: "缺任务" },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0]?.title).toBe("合法");
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]).toContain("task 必须是字符串");
  });
});

// ---------------------------------------------------------------------------
// 新字段必须被显式读取；未知字段的既有语义保持不变
// ---------------------------------------------------------------------------

describe("super waves · 字段读取纪律", () => {
  it("新增字段被显式解析（id / dependsOn / batch 不会无声消失）", () => {
    const parsed = parseSuperDelegationPayload({
      tasks: [
        { id: "data", title: "数据层", task: "实现数据层" },
        { title: "接口层", task: "实现接口层", dependsOn: ["data"], batch: undefined },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.tasks[0]?.id).toBe("data");
    expect(parsed.tasks[1]?.dependsOn).toEqual(["data"]);
  });

  it("未知字段仍然静默忽略（既有语义不变）", () => {
    const parsed = parseSuperDelegationPayload({
      tasks: [{ title: "A", task: "任务 A", 随便写个字段: 123, another: { x: 1 } }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.tasks[0] ?? {}).sort()).toEqual(["task", "title"]);
  });

  it("依赖引用被规范化成目标任务的标识（有 id 时用 id）", () => {
    const parsed = parseSuperDelegationPayload({
      tasks: [
        { id: "data", title: "数据层", task: "实现数据层" },
        { title: "接口层", task: "实现接口层", dependsOn: ["数据层"] },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.tasks[1]?.dependsOn).toEqual(["data"]);
  });

  it("两个通道口径一致：工具通道同样读得到 dependsOn / batch", () => {
    const parsed = parseSuperToolCall("dispatch", {
      tasks: [
        { title: "数据层", task: "实现数据层" },
        { title: "接口层", task: "实现接口层", dependsOn: ["数据层"] },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.tasks[0]?.[1]?.dependsOn).toEqual(["数据层"]);
  });

  it("工具通道读到写坏的 dependsOn 时不静默（按现有 issue 机制报错）", () => {
    const parsed = parseSuperToolCall("dispatch", {
      tasks: [{ title: "A", task: "任务 A", dependsOn: 42 }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.join("；")).toContain("dependsOn");
  });
});

// ---------------------------------------------------------------------------
// 诊断事件与失败分类
// ---------------------------------------------------------------------------

describe("super waves · 诊断事件", () => {
  it("追加诊断：事件进入会话的诊断数组", () => {
    const event: SuperDiagnosticEvent = {
      at: 1234,
      kind: "spawn",
      level: "info",
      message: "已派发子会话",
    };
    const next = applySuperDiagnostic(session(), event);
    expect(next.diagnostics).toHaveLength(1);
    expect(next.diagnostics?.[0]?.message).toBe("已派发子会话");
    // 追加诊断不改状态机。
    expect(next.status).toBe("preparing");
  });

  it("超出上限时从最早处丢弃（保留最近的诊断）", () => {
    let current = session();
    for (let i = 0; i < SUPER_DIAGNOSTICS_MAX_EVENTS + 50; i += 1) {
      current = applySuperDiagnostic(current, {
        at: 1000 + i,
        kind: "report",
        level: "info",
        message: `事件 ${i}`,
      });
    }
    expect(current.diagnostics).toHaveLength(SUPER_DIAGNOSTICS_MAX_EVENTS);
    expect(current.diagnostics?.[0]?.message).toBe("事件 50");
    expect(current.diagnostics?.[SUPER_DIAGNOSTICS_MAX_EVENTS - 1]?.message).toBe(
      `事件 ${SUPER_DIAGNOSTICS_MAX_EVENTS + 49}`,
    );
  });

  it("终态粘性：终态会话收到 error 事件不改终态，只追加诊断", () => {
    const done = session({ status: "completed", endedAt: 2000 });
    const next = applySuperDiagnostic(done, {
      at: 3000,
      kind: "error",
      level: "error",
      message: "迟到的错误",
    });
    expect(next.status).toBe("completed");
    expect(next.endedAt).toBe(2000);
    expect(next.diagnostics).toHaveLength(1);
  });

  it("失败信息写入 lastError 并落一条诊断", () => {
    const next = applySuperFailure(session(), {
      kind: "retryable",
      message: "网关超时",
      at: 4242,
    });
    expect(next.lastError?.kind).toBe("retryable");
    expect(next.lastError?.message).toBe("网关超时");
    expect(next.diagnostics).toHaveLength(1);
    expect(next.diagnostics?.[0]?.level).toBe("warn");
    expect(next.status).toBe("preparing");
  });
});

// ---------------------------------------------------------------------------
// 看板投影裁剪
// ---------------------------------------------------------------------------

describe("super waves · 看板投影裁剪", () => {
  it("诊断数组在投影里被裁到上限（保留最近的）", () => {
    const diagnostics: SuperDiagnosticEvent[] = Array.from({ length: 50 }, (_, i) => ({
      at: 1000 + i,
      kind: "report",
      level: "info" as const,
      message: `事件 ${i}`,
    }));
    const projected = toSuperBoardSession(session({ diagnostics }));
    expect(projected.diagnostics).toHaveLength(SUPER_BOARD_DIAGNOSTICS_MAX_EVENTS);
    expect(projected.diagnostics?.[0]?.message).toBe(`事件 ${50 - SUPER_BOARD_DIAGNOSTICS_MAX_EVENTS}`);
  });

  it("诊断未超限时投影原样返回（不多换对象）", () => {
    const base = session({
      diagnostics: [{ at: 1, kind: "spawn", level: "info", message: "x" }],
    });
    expect(toSuperBoardSession(base)).toBe(base);
  });
});

// ---------------------------------------------------------------------------
// 聚合辅助
// ---------------------------------------------------------------------------

describe("super waves · 按波次聚合", () => {
  it("按波次分组，没声明波次的归入 wave 0 组", () => {
    const groups = groupSuperReportsByWave(
      [{ w: 1 }, { w: undefined }, { w: 0 }, { w: 2 }],
      (entry) => entry.w,
    );
    expect(groups).toHaveLength(3);
    expect(groups[0]).toHaveLength(2);
    expect(groups[1]).toHaveLength(1);
    expect(groups[2]).toHaveLength(1);
  });

  it("空输入返回空分组", () => {
    expect(groupSuperReportsByWave([], () => 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 归档往返
// ---------------------------------------------------------------------------

describe("super waves · 归档往返", () => {
  it("新增字段（wave / dependsOn / attempts / lastError / diagnostics）往返保留", () => {
    const original = session({
      runId: "run-1",
      wave: 2,
      batch: 3,
      dependsOn: ["数据层"],
      attempts: 2,
      maxAttempts: 3,
      lastError: { kind: "retryable", message: "网关超时", at: 1234 },
      diagnostics: [{ at: 1234, kind: "error", level: "warn", message: "网关超时" }],
      statusDetail: "上游任务失败，已跳过",
    });
    const persisted = toPersistedSuperSession(original);
    expect(persisted.wave).toBe(2);
    expect(persisted.dependsOn).toEqual(["数据层"]);
    expect(persisted.lastError?.kind).toBe("retryable");
    expect(persisted.diagnostics).toHaveLength(1);

    const restored = fromPersistedSuperSession(persisted);
    expect(restored.runId).toBe("run-1");
    expect(restored.wave).toBe(2);
    expect(restored.batch).toBe(3);
    expect(restored.dependsOn).toEqual(["数据层"]);
    expect(restored.attempts).toBe(2);
    expect(restored.maxAttempts).toBe(3);
    expect(restored.lastError?.message).toBe("网关超时");
    expect(restored.diagnostics).toHaveLength(1);
    expect(restored.statusDetail).toBe("上游任务失败，已跳过");
  });

  it("归档指纹不因诊断变化而改变（诊断是展示性字段）", () => {
    const base = session({ status: "running" });
    const withDiagnostics = applySuperDiagnostic(base, {
      at: 9999,
      kind: "error",
      level: "error",
      message: "某个诊断",
    });
    const fingerprintOf = (target: SuperSessionUi): string =>
      superArchiveFingerprint([
        { mainSessionId: "main-1", sessions: [toPersistedSuperSession(target)] },
      ]);
    expect(fingerprintOf(withDiagnostics)).toBe(fingerprintOf(base));
  });
});

// ---------------------------------------------------------------------------
// 消息协议
// ---------------------------------------------------------------------------

describe("super waves · 消息协议", () => {
  it("新增的 Webview→Host 消息在联合类型里可赋值", () => {
    const wave: WebviewToHost = { type: "superRetryWave", runId: "run-1", wave: 2 };
    const failed: WebviewToHost = { type: "superRetryFailed" };
    const failedWithRun: WebviewToHost = { type: "superRetryFailed", runId: "run-1" };
    expect(wave.type).toBe("superRetryWave");
    expect(failed.type).toBe("superRetryFailed");
    expect(failedWithRun.runId).toBe("run-1");
  });
});

// ---------------------------------------------------------------------------
// 诊断文案工具
// ---------------------------------------------------------------------------

describe("super waves · issue 文案", () => {
  it("superParseIssueMessages 把诊断压成宿主既有 issue 通道的字符串数组", () => {
    const plan = planSuperWaves([{ title: "A", task: "任务 A", dependsOn: ["不存在"] }]);
    const messages = superParseIssueMessages(plan.issues);
    expect(messages).toHaveLength(plan.issues.length);
    expect(messages[0]).toContain("不存在");
  });

  it("SuperTaskSpec 允许带新字段（旧写法仍然合法）", () => {
    const spec: SuperTaskSpec = { title: "A", task: "任务 A" };
    expect(spec.dependsOn).toBeUndefined();
    expect(spec.batch).toBeUndefined();
    expect(spec.id).toBeUndefined();
  });
});

describe("super waves · 恢复如实性：非终态归一要能区分原因", () => {
  const persisted = (overrides: Partial<PersistedSuperSession> = {}): PersistedSuperSession => ({
    id: "super-1",
    title: "修复登录跳转",
    task: "修好它",
    status: "running",
    isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/a", baseRef: "abc" },
    createdAt: 1000,
    updatedAt: 2000,
    reports: [],
    ...overrides,
  });

  it("重启时还在跑 → cancelled + interruptedBy=system + restoreReason=restart", () => {
    const restored = fromPersistedSuperSession(persisted({ status: "running" }));
    expect(restored.status).toBe("cancelled");
    expect(restored.interruptedBy).toBe("system");
    expect(restored.restoredFromStatus).toBe("running");
    expect(restored.restoreReason).toBe("restart");
    expect(restored.restored).toBe(true);
    // 旧行为保留：非终态归档的 endedAt 仍取 updatedAt。
    expect(restored.endedAt).toBe(2000);
  });

  it("归档已带 interruptedBy（用户 / 智能体）→ 原样沿用，归因为 recorded", () => {
    const byUser = fromPersistedSuperSession(
      persisted({ status: "awaiting_input", interruptedBy: "user" }),
    );
    expect(byUser.status).toBe("cancelled");
    expect(byUser.interruptedBy).toBe("user");
    expect(byUser.restoredFromStatus).toBe("awaiting_input");
    expect(byUser.restoreReason).toBe("recorded");

    const byAgent = fromPersistedSuperSession(
      persisted({ status: "preparing", interruptedBy: "agent" }),
    );
    expect(byAgent.interruptedBy).toBe("agent");
    expect(byAgent.restoreReason).toBe("recorded");
  });

  it("宿主主动收口（非终态 + interruptedBy=system）与重启归一可区分", () => {
    const hostStopped = fromPersistedSuperSession(
      persisted({ status: "running", interruptedBy: "system" }),
    );
    const restarted = fromPersistedSuperSession(persisted({ status: "running" }));
    expect(hostStopped.interruptedBy).toBe(restarted.interruptedBy); // 都是 system
    expect(hostStopped.restoreReason).toBe("recorded"); // 但原因不同
    expect(restarted.restoreReason).toBe("restart");
  });

  it("原生终态取消（用户喊停）不带归一元数据，可与重启区分", () => {
    const restored = fromPersistedSuperSession(persisted({ status: "cancelled", interruptedBy: "user" }));
    expect(restored.status).toBe("cancelled");
    expect(restored.interruptedBy).toBe("user");
    expect(restored.restoreReason).toBeUndefined();
    expect(restored.restoredFromStatus).toBeUndefined();
  });

  it("旧归档缺新字段时退回现行为（cancelled + interruptedBy=system），不抛异常", () => {
    // persisted() 故意只给 v1 字段：没有 progressTail / restoreReason / restoredFromStatus。
    const legacy = persisted({ status: "preparing", summary: undefined });
    expect(Object.keys(legacy)).not.toContain("restoreReason");
    const restored = fromPersistedSuperSession(legacy);
    expect(restored.status).toBe("cancelled");
    expect(restored.interruptedBy).toBe("system");
    expect(restored.restoredFromStatus).toBe("preparing");
    expect(restored.restoreReason).toBe("restart");
  });

  it("多次重启：归一元数据随归档往返原样保留", () => {
    const first = fromPersistedSuperSession(persisted({ status: "running", interruptedBy: "user" }));
    const second = fromPersistedSuperSession(toPersistedSuperSession(first));
    expect(second.status).toBe("cancelled");
    expect(second.interruptedBy).toBe("user");
    expect(second.restoredFromStatus).toBe("running");
    expect(second.restoreReason).toBe("recorded");
  });
});

describe("super waves · 终态进度尾落盘", () => {
  it("终态进度被截成尾部快照（最后 N 字符 + updatedAt 时间戳）", () => {
    const long = `${"x".repeat(SUPER_PROGRESS_TAIL_MAX_CHARS + 500)}TAIL`;
    const persisted = toPersistedSuperSession(
      session({ status: "completed", progress: long, updatedAt: 9999 }),
    );
    expect(persisted.progressTail).toBeDefined();
    expect(persisted.progressTail?.at).toBe(9999);
    expect(persisted.progressTail?.text.length).toBe(SUPER_PROGRESS_TAIL_MAX_CHARS);
    expect(persisted.progressTail?.text.endsWith("TAIL")).toBe(true);
  });

  it("非终态不落进度尾（实时流式字段仍不进归档）", () => {
    expect(
      toPersistedSuperSession(session({ status: "running", progress: "临时进度" })).progressTail,
    ).toBeUndefined();
  });

  it("恢复时从进度尾还原最后进度；老归档没有进度尾则 progress 缺省", () => {
    const base: PersistedSuperSession = {
      id: "super-1",
      title: "修复登录跳转",
      task: "修好它",
      status: "completed",
      isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/a" },
      createdAt: 1000,
      updatedAt: 2000,
      reports: [],
    };
    expect(fromPersistedSuperSession(base).progress).toBeUndefined();
    expect(
      fromPersistedSuperSession({
        ...base,
        progressTail: { text: "最后停在读取登录流程", at: 1999 },
      }).progress,
    ).toBe("最后停在读取登录流程");
  });
});

describe("super waves · 诊断 kind 扩展（activity / tool_call）", () => {
  it("两种新 kind 都能追加，结构化细节原样保留，不改状态机", () => {
    const activity: SuperDiagnosticEvent = {
      at: 10,
      kind: "activity",
      level: "info",
      message: "最近活动：读到 3 个文件",
      activityDetail: { source: "tool_result", excerpt: "读到 3 个文件", at: 9 },
    };
    const toolCall: SuperDiagnosticEvent = {
      at: 11,
      kind: "tool_call",
      level: "warn",
      message: "read_file 超时",
      toolCallDetail: {
        name: "read_file",
        toolCallId: "call-1",
        state: "failed",
        excerpt: "ETIMEDOUT",
      },
    };
    const next = applySuperDiagnostic(applySuperDiagnostic(session(), activity), toolCall);
    expect(next.status).toBe("preparing");
    expect(next.diagnostics?.[0]?.kind).toBe("activity");
    expect(next.diagnostics?.[0]?.activityDetail?.source).toBe("tool_result");
    expect(next.diagnostics?.[1]?.kind).toBe("tool_call");
    expect(next.diagnostics?.[1]?.toolCallDetail?.state).toBe("failed");
    expect(next.diagnostics?.[1]?.toolCallDetail?.toolCallId).toBe("call-1");
  });

  it("新 kind 同样受 200 条环形缓冲约束（保留最近）", () => {
    let current = session();
    for (let i = 0; i < SUPER_DIAGNOSTICS_MAX_EVENTS + 30; i += 1) {
      current = applySuperDiagnostic(current, {
        at: 1000 + i,
        kind: i % 2 === 0 ? "activity" : "tool_call",
        level: "info",
        message: `事件 ${i}`,
        ...(i % 2 === 0
          ? { activityDetail: { source: "status" as const, excerpt: `e${i}`, at: 1000 + i } }
          : { toolCallDetail: { name: "read_file", state: "completed" as const } }),
      });
    }
    expect(current.diagnostics).toHaveLength(SUPER_DIAGNOSTICS_MAX_EVENTS);
    expect(current.diagnostics?.[0]?.message).toBe("事件 30");
  });

  it("终态粘性与新 kind 无关：终态收到 activity 只追加不改状态", () => {
    const done = session({ status: "completed", endedAt: 2000 });
    const next = applySuperDiagnostic(done, {
      at: 3000,
      kind: "activity",
      level: "info",
      message: "迟到的活动",
      activityDetail: { source: "status", excerpt: "已完成", at: 2999 },
    });
    expect(next.status).toBe("completed");
    expect(next.endedAt).toBe(2000);
    expect(next.diagnostics).toHaveLength(1);
  });

  it("结构化细节随归档往返保留", () => {
    const original = session({
      status: "failed",
      diagnostics: [
        {
          at: 10,
          kind: "tool_call",
          level: "error",
          message: "工具失败",
          toolCallDetail: { name: "run_shell_command", state: "failed", excerpt: "exit 1" },
        },
      ],
    });
    const restored = fromPersistedSuperSession(toPersistedSuperSession(original));
    expect(restored.diagnostics?.[0]?.toolCallDetail).toEqual({
      name: "run_shell_command",
      state: "failed",
      excerpt: "exit 1",
    });
  });
});

describe("super waves · 归档指纹纳入终态错误", () => {
  const fingerprintOf = (target: SuperSessionUi): string =>
    superArchiveFingerprint([{ mainSessionId: "main-1", sessions: [toPersistedSuperSession(target)] }]);

  it("error 变化改变指纹（只有人类可读错误的终态也能立即落盘）", () => {
    const baseline = fingerprintOf(session({ status: "failed" }));
    expect(fingerprintOf(session({ status: "failed", error: "网关超时" }))).not.toBe(baseline);
  });

  it("lastError / statusDetail 变化同样改变指纹", () => {
    const baseline = fingerprintOf(session({ status: "running" }));
    expect(
      fingerprintOf(
        session({ status: "running", lastError: { kind: "retryable", message: "boom", at: 5 } }),
      ),
    ).not.toBe(baseline);
    expect(fingerprintOf(session({ status: "running", statusDetail: "已跳过" }))).not.toBe(baseline);
  });
});
