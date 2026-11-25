/**
 * 看板波次聚合纯逻辑（shared/super-board.ts）单测 —— node 环境，零 React / 零 DOM。
 *
 * 核心契约：① 按 runId 分组（无 runId 归默认组）；② 组内按 wave 分层；
 * ③ 每层统计口径与 shared 的 summarizeSuperSessions / sumSuperUsage 一致；
 * ④ 诊断按 kind 汇总、最近一条错误可取；⑤ 纯函数：不改入参、不返回可变共享引用。
 */
import { describe, expect, it } from "vitest";
import type { SuperSessionUi, SuperTokenUsage } from "../shared/super-agent.js";
import {
  SUPER_BOARD_DEFAULT_RUN_ID,
  SUPER_BOARD_DEFAULT_WAVE,
  aggregateSuperBoardWaves,
  buildSuperBoardAggregate,
  collectSuperBoardDiagnosticTimeline,
  collectSuperSessionDiagnostics,
  countSuperBoardSessions,
  groupSuperBoardSessions,
  isSuperBoardBlocked,
  isSuperBoardRetrying,
  isSuperBoardRunning,
  sumSuperBoardUsage,
  summarizeSuperBoardDiagnostics,
  superBoardFailureKind,
  type SuperBoardSession,
} from "../shared/super-board.js";

function session(
  overrides: Partial<SuperBoardSession> = {},
): SuperBoardSession {
  return {
    id: "s",
    title: "任务",
    task: "描述",
    status: "running",
    isolation: { kind: "git_worktree", path: "/w", branch: "iflow/super/a", baseRef: "abc" },
    createdAt: 1000,
    updatedAt: 2000,
    reports: [],
    ...overrides,
  };
}

function usage(input: number, output: number, estimatedCost: number | null = null): SuperTokenUsage {
  return { input, output, estimatedCost };
}

describe("groupSuperBoardSessions · 运行组划分", () => {
  it("无 runId 全部归默认组；有 runId 的各自成组，组按最早创建时间排序", () => {
    const groups = groupSuperBoardSessions([
      session({ id: "old", createdAt: 5000 }),
      session({ id: "a1", runId: "run-b", createdAt: 3000 }),
      session({ id: "a2", runId: "run-a", createdAt: 1000 }),
      session({ id: "old2", createdAt: 2000 }),
    ]);
    expect(groups).toHaveLength(3);
    // 默认组最早创建是 2000，run-a 是 1000 → run-a 排第一，默认组第二。
    expect(groups.map((g) => g.runId)).toEqual(["run-a", SUPER_BOARD_DEFAULT_RUN_ID, "run-b"]);
    const def = groups.find((g) => g.isDefault)!;
    expect(def.sessions.map((s) => s.id)).toEqual(["old2", "old"]);
    expect(def.isDefault).toBe(true);
  });

  it("空 runId 字符串（全空白）也归默认组，不产生幽灵组", () => {
    const groups = groupSuperBoardSessions([
      session({ id: "blank", runId: "   " }),
      session({ id: "none" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.runId).toBe(SUPER_BOARD_DEFAULT_RUN_ID);
    expect(groups[0]!.sessions).toHaveLength(2);
  });

  it("组内按 wave 分层，缺省 wave 归 0 且升序排列", () => {
    const groups = groupSuperBoardSessions([
      session({ id: "w2", runId: "r", wave: 2 }),
      session({ id: "no", runId: "r" }),
      session({ id: "w1", runId: "r", wave: 1 }),
      session({ id: "w2b", runId: "r", wave: 2 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.waves.map((w) => w.wave)).toEqual([
      SUPER_BOARD_DEFAULT_WAVE,
      1,
      2,
    ]);
    const wave2 = groups[0]!.waves.find((w) => w.wave === 2)!;
    expect(wave2.sessions.map((s) => s.id)).toEqual(["w2", "w2b"]);
  });
});

describe("统计口径：组级 / 波次级 / 全量", () => {
  const sessions: SuperBoardSession[] = [
    session({ id: "d", status: "completed", wave: 1, tokens: usage(100, 20, 0.01) }),
    session({ id: "f", status: "failed", wave: 1, tokens: usage(200, 30, 0.02) }),
    session({ id: "r", status: "running", wave: 2, attempts: 3, tokens: usage(300, 40) }),
    session({ id: "b", status: "awaiting_input", wave: 2 }),
    session({ id: "c", status: "cancelled", wave: 2 }),
  ];

  it("countSuperBoardSessions：完成/失败/中断沿用 shared；重试中与阻塞单独计", () => {
    const counts = countSuperBoardSessions(sessions);
    expect(counts).toEqual({
      total: 5,
      done: 1,
      failed: 1,
      retrying: 1,
      blocked: 1,
      running: 1,
      cancelled: 1,
    });
    // cancelled 不计入 failed（与 summarizeSuperSessions 同口径）。
    expect(counts.failed).toBe(1);
    expect(isSuperBoardRunning(sessions[2]!)).toBe(true);
    expect(isSuperBoardRetrying(sessions[2]!)).toBe(true);
    expect(isSuperBoardBlocked(sessions[3]!)).toBe(true);
  });

  it("lastError.kind=blocked 也让运行中会话计入阻塞", () => {
    const s = session({
      status: "running",
      lastError: { kind: "blocked", message: "等依赖", at: 10 },
    });
    expect(isSuperBoardBlocked(s)).toBe(true);
    expect(countSuperBoardSessions([s]).blocked).toBe(1);
  });

  it("sumSuperBoardUsage 与 sumSuperUsage 同口径：成本不全则不报数", () => {
    expect(sumSuperBoardUsage(sessions)).toEqual({ input: 600, output: 90, estimatedCost: null });
    expect(sumSuperBoardUsage(sessions.slice(0, 2))).toEqual({
      input: 300,
      output: 50,
      estimatedCost: 0.03,
    });
  });

  it("组级与波次级统计各自独立：组=5 个、第 1 波 2 个、第 2 波 3 个", () => {
    const groups = groupSuperBoardSessions(sessions.map((s) => ({ ...s, runId: "run" })));
    const group = groups[0]!;
    expect(group.counts.total).toBe(5);
    expect(group.waves).toHaveLength(2);
    const wave1 = group.waves.find((w) => w.wave === 1)!;
    const wave2 = group.waves.find((w) => w.wave === 2)!;
    expect(wave1.counts).toEqual({
      total: 2,
      done: 1,
      failed: 1,
      retrying: 0,
      blocked: 0,
      running: 0,
      cancelled: 0,
    });
    expect(wave2.counts.total).toBe(3);
    expect(wave2.counts.retrying).toBe(1);
    expect(wave2.counts.blocked).toBe(1);
  });

  it("波次耗时区间：最早 startedAt→最晚 endedAt，只取真的结束过的会话", () => {
    const waves = aggregateSuperBoardWaves([
      session({ id: "a", wave: 1, createdAt: 100, startedAt: 200, endedAt: 500 }),
      session({ id: "b", wave: 1, createdAt: 300, startedAt: 400 }),
      session({ id: "c", wave: 2, createdAt: 50 }),
    ]);
    expect(waves[0]!.startedAt).toBe(200);
    expect(waves[0]!.endedAt).toBe(500);
    expect(waves[1]!.startedAt).toBe(50);
    expect(waves[1]!.endedAt).toBeUndefined();
  });
});

describe("诊断汇总与时间线", () => {
  const sessions: SuperBoardSession[] = [
    session({
      id: "a",
      title: "甲",
      diagnostics: [
        { at: 100, kind: "tool_call", level: "info", message: "调用工具" },
        {
          at: 400,
          kind: "error",
          level: "error",
          message: "网关 503",
          detail: "重试 3 次",
        },
      ],
      lastError: { kind: "terminal", message: "配额耗尽", at: 500 },
    }),
    session({
      id: "b",
      title: "乙",
      diagnostics: [{ at: 300, kind: "tool_call", level: "warn", message: "命令超时" }],
    }),
  ];

  it("按 kind 分组计数（降序 + kind 稳定），最近错误取 at 最大者", () => {
    const summary = summarizeSuperBoardDiagnostics(sessions);
    expect(summary.total).toBe(3);
    expect(summary.byKind).toEqual([
      { kind: "tool_call", count: 2 },
      { kind: "error", count: 1 },
    ]);
    expect(summary.lastError).toEqual({
      sessionId: "a",
      sessionTitle: "甲",
      at: 500,
      message: "配额耗尽",
    });
  });

  it("无诊断、无 lastError 时汇总为空且不带 lastError 键", () => {
    const summary = summarizeSuperBoardDiagnostics([session()]);
    expect(summary.total).toBe(0);
    expect(summary.byKind).toEqual([]);
    expect(summary.lastError).toBeUndefined();
  });

  it("时间线按 at 倒序，带来源子会话信息；单会话版本等价过滤", () => {
    const timeline = collectSuperBoardDiagnosticTimeline(sessions);
    expect(timeline.map((e) => e.at)).toEqual([400, 300, 100]);
    expect(timeline[0]).toMatchObject({
      sessionId: "a",
      sessionTitle: "甲",
      kind: "error",
      level: "error",
      message: "网关 503",
      detail: "重试 3 次",
    });
    expect(collectSuperSessionDiagnostics(sessions[1]!)).toHaveLength(1);
  });

  it("脏诊断事件不会污染聚合（非对象 / 非字符串 kind 被跳过）", () => {
    const dirty = session({
      diagnostics: [
        null as unknown as { at: number; kind: never; level: "info"; message: string },
        { at: 1, kind: 42, level: "info", message: "x" } as unknown as {
          at: number;
          kind: never;
          level: "info";
          message: string;
        },
        { at: 2, kind: "ok", level: "info", message: "y" } as never,
      ],
    });
    const summary = summarizeSuperBoardDiagnostics([dirty]);
    expect(summary.total).toBe(1);
    expect(summary.byKind).toEqual([{ kind: "ok", count: 1 }]);
  });
});

describe("失败分类降级", () => {
  it("新字段优先；旧数据按状态兜底，未知字段不出现 undefined", () => {
    expect(superBoardFailureKind(session({ lastError: { kind: "terminal", message: "", at: 1 } }))).toBe("terminal");
    expect(superBoardFailureKind(session({ status: "cancelled" }))).toBe("interrupted");
    expect(superBoardFailureKind(session({ status: "failed" }))).toBe("retryable");
    expect(superBoardFailureKind(session({ status: "awaiting_input" }))).toBe("blocked");
    expect(superBoardFailureKind(session({ status: "running" }))).toBeNull();
    expect(superBoardFailureKind(session({ status: "failed", lastError: { kind: "weird", message: "", at: 1 } as never }))).toBe("retryable");
  });
});

describe("纯函数纪律", () => {
  it("buildSuperBoardAggregate 不修改入参（深冻结入参仍可调用，快照前后相等）", () => {
    const input: SuperBoardSession[] = [
      session({
        id: "a",
        runId: "r",
        wave: 1,
        tokens: usage(10, 5, 0.001),
        diagnostics: [{ at: 1, kind: "k" as never, level: "info", message: "m" }],
      }),
      session({ id: "b", status: "completed" }),
    ];
    const before = JSON.stringify(input);
    // 深冻结：任何就地改动都会抛错（非严格模式下静默失败也会被下面的快照比对抓到）。
    const deepFreeze = (value: unknown): void => {
      if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
      Object.freeze(value);
      for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    };
    deepFreeze(input);
    expect(() => buildSuperBoardAggregate(input)).not.toThrow();
    expect(JSON.stringify(input)).toBe(before);
  });

  it("每次返回新对象与新数组，不共享可变引用", () => {
    const input = [session({ id: "a", runId: "r", wave: 1 })];
    const first = buildSuperBoardAggregate(input);
    const second = buildSuperBoardAggregate(input);
    expect(first).not.toBe(second);
    expect(first.groups).not.toBe(second.groups);
    expect(first.groups[0]).not.toBe(second.groups[0]);
    expect(first.groups[0]!.sessions).not.toBe(second.groups[0]!.sessions);
    expect(first.groups[0]!.waves).not.toBe(second.groups[0]!.waves);
    expect(first.diagnostics.byKind).not.toBe(second.diagnostics.byKind);
    // 返回的会话数组不是入参数组本身（但可以复用会话对象本身，它们只读）。
    expect(first.groups[0]!.sessions).not.toBe(input);
    // 空输入也要返回合法的空聚合，不抛错。
    const empty = buildSuperBoardAggregate([]);
    expect(empty.groups).toEqual([]);
    expect(empty.counts.total).toBe(0);
    expect(empty.diagnostics.total).toBe(0);
  });

  it("旧的 SuperSessionUi（无任何新字段）可直接赋值并安全聚合", () => {
    const legacy: SuperSessionUi = session({ id: "legacy", status: "failed", error: "崩溃" });
    const aggregate = buildSuperBoardAggregate([legacy]);
    expect(aggregate.groups).toHaveLength(1);
    expect(aggregate.groups[0]!.isDefault).toBe(true);
    expect(aggregate.groups[0]!.waves[0]!.wave).toBe(SUPER_BOARD_DEFAULT_WAVE);
    expect(aggregate.counts.failed).toBe(1);
    expect(aggregate.diagnostics.total).toBe(0);
  });
});
