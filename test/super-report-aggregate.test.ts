/**
 * buildSuperReportPrompt 的聚合增强：按 wave 分组、头部 counts/usage 摘要、
 * 每条汇报的 lastError.kind 简述，以及 pendingCount 三支结尾语义保持不变
 * （QQ 回执依赖「还有人在跑时不做最终汇报」这一约定）。
 */
import { describe, it, expect } from "vitest";
import {
  buildSuperReportPrompt,
  type SuperFailureInfo,
  type SuperReport,
  type SuperReportState,
  type SuperSessionUi,
} from "../shared/super-agent.js";

function child(overrides: Partial<SuperSessionUi> = {}): SuperSessionUi {
  return {
    id: "s1",
    title: "任务",
    task: "做点事",
    status: "completed",
    isolation: {
      kind: "git_worktree",
      path: "/tmp/wt",
      branch: "iflow/super/a",
      baseRef: "abc",
    },
    createdAt: 1,
    updatedAt: 2,
    reports: [],
    ...overrides,
  };
}

function entry(
  id: string,
  wave: number | undefined,
  opts: {
    state?: SuperReportState;
    summary?: string;
    lastError?: SuperFailureInfo;
    tokens?: SuperSessionUi["tokens"];
  } = {},
): { session: SuperSessionUi; report: SuperReport } {
  const session = child({
    id,
    title: `任务 ${id}`,
    wave,
    status: opts.state === "failed" ? "failed" : "completed",
    lastError: opts.lastError,
    tokens: opts.tokens,
  });
  const report: SuperReport = {
    state: opts.state ?? "ready",
    summary: opts.summary ?? `summary-${id}`,
    at: 2,
  };
  return { session, report };
}

describe("buildSuperReportPrompt · wave 分组与聚合摘要", () => {
  it("空汇报仍返回空串", () => {
    expect(buildSuperReportPrompt([])).toBe("");
  });

  it("按 wave 分组渲染，空波次不出标题，未声明波次归入 wave 0", () => {
    const text = buildSuperReportPrompt([
      entry("a", 2),
      entry("b", undefined),
      entry("c", 0),
      entry("d", 2),
    ]);
    expect(text).toContain("Wave 0 (2 child session(s)):");
    expect(text).toContain("Wave 2 (2 child session(s)):");
    expect(text).not.toContain("Wave 1 (");
    // wave 0 的两条（b、c）在 wave 2 的两条（a、d）之前；组内保持入参顺序。
    expect(text.indexOf("Child session #b")).toBeLessThan(text.indexOf("Child session #a"));
    expect(text.indexOf("Child session #c")).toBeLessThan(text.indexOf("Child session #a"));
    expect(text.indexOf("Child session #a")).toBeLessThan(text.indexOf("Child session #d"));
  });

  it("头部带 counts / usage 摘要（含成本，口径与看板一致）", () => {
    const text = buildSuperReportPrompt([
      entry("a", 0, { tokens: { input: 100, output: 10, estimatedCost: 0.01 } }),
      entry("b", 0, { tokens: { input: 200, output: 20, estimatedCost: 0.02 } }),
      entry("c", 0, {
        state: "failed",
        tokens: { input: 50, output: 5, estimatedCost: 0.005 },
      }),
    ]);
    expect(text).toContain("Batch summary: 3 total");
    expect(text).toContain("2 completed");
    expect(text).toContain("1 failed");
    expect(text).toContain("tokens ↑350 ↓35");
    expect(text).toContain("est. $0.0350");
  });

  it("有用量但成本不全时不显示 cost（与 sumSuperUsage 一致）", () => {
    const text = buildSuperReportPrompt([
      entry("a", 0, { tokens: { input: 10, output: 2, estimatedCost: 0.01 } }),
      entry("b", 0, { tokens: { input: 20, output: 4 } }),
    ]);
    expect(text).toContain("tokens ↑30 ↓6");
    expect(text).not.toContain("est. $");
  });

  it("每条汇报补 lastError.kind 简述，无 lastError 时不出现", () => {
    const text = buildSuperReportPrompt([
      entry("ok", 0),
      entry("retry", 0, {
        state: "failed",
        lastError: { kind: "retryable", message: "上游限流", at: 2 },
      }),
      entry("terminal", 1, {
        state: "failed",
        lastError: { kind: "terminal", message: "分支已删", at: 2 },
      }),
    ]);
    expect(text).toContain("[last error: retryable — 上游限流]");
    expect(text).toContain("[last error: terminal — 分支已删]");
    // 无 lastError 的条目不带这个标记。
    expect(text).toContain('Child session #ok "任务 ok" completed: summary-ok\n');
    expect(text.match(/\[last error:/g)?.length).toBe(2);
  });
});

describe("buildSuperReportPrompt · pendingCount 三支结尾语义不变", () => {
  const entries = [entry("a", 0)];

  it("pendingCount=0：保留最终完整汇报分支", () => {
    const text = buildSuperReportPrompt(entries, { pendingCount: 0 });
    expect(text).toContain("give the user one complete report");
    expect(text).not.toContain("do not give the user a final complete report yet");
    expect(text).not.toContain("are still running");
  });

  it("pendingCount>0：只处理本批，明确不现在做最终汇报", () => {
    const text = buildSuperReportPrompt(entries, { pendingCount: 2 });
    expect(text).toContain("2 other child session(s) are still running");
    expect(text).toContain("do not give the user a final complete report yet");
    expect(text).not.toContain("give the user one complete report");
  });

  it("全部 dropped：不催继续，保留中断说明 + 仍在运行的说明", () => {
    const dropped = [
      {
        session: child({ status: "cancelled", id: "x" }),
        report: { state: "dropped" as const, summary: "用户中断", at: 2 },
      },
    ];
    const text = buildSuperReportPrompt(dropped, { pendingCount: 1 });
    expect(text).toContain("were **interrupted**");
    expect(text).toContain("Do not re-run them automatically");
    expect(text).toContain("ask the user whether to continue");
    expect(text).toContain("1 other child session(s) are still running");
    expect(text).not.toContain("a new turn of the same task");
  });

  it("finalOverride=true 时即便 pendingCount>0 也走最终汇报分支（QQ 补发）", () => {
    const text = buildSuperReportPrompt(entries, { pendingCount: 1, finalOverride: true });
    expect(text).not.toContain("do not give the user a final complete report yet");
    expect(text).toContain("give the user one complete report");
  });
});
