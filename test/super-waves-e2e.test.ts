import { describe, expect, it } from "vitest";
import {
  parseSuperDelegationPayload,
  planSuperWaves,
  type SuperTaskSpec,
} from "../shared/super-agent.js";

describe("Super Agent 委派波次端到端解析", () => {
  it("依赖链从载荷解析后分成两波", () => {
    const parsed = parseSuperDelegationPayload({
      tasks: [
        { id: "design", title: "设计", task: "完成设计" },
        { id: "implement", title: "实现", task: "完成实现", dependsOn: ["design"] },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.tasks).toEqual([
      { id: "design", title: "设计", task: "完成设计" },
      { id: "implement", title: "实现", task: "完成实现", dependsOn: ["design"] },
    ]);
    expect(planSuperWaves(parsed.tasks)).toMatchObject({
      mode: "dependency",
      waves: [["design"], ["implement"]],
      taskWave: { design: 0, implement: 1 },
      issues: [],
    });
  });

  it("batch 字段从载荷解析后按批次分波", () => {
    const parsed = parseSuperDelegationPayload({
      tasks: [
        { id: "later", title: "后批", task: "第二批工作", batch: 8 },
        { id: "first", title: "首批", task: "第一批工作", batch: 3 },
        { id: "default", title: "默认批次", task: "无批次工作" },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.tasks.map((task) => task.batch)).toEqual([8, 3, undefined]);
    expect(planSuperWaves(parsed.tasks)).toMatchObject({
      mode: "batch",
      waves: [["first", "default"], ["later"]],
      taskWave: { first: 0, default: 0, later: 1 },
      issues: [],
    });
  });

  it("悬空依赖返回块级错误且不产出可派发任务", () => {
    const parsed = parseSuperDelegationPayload({
      tasks: [
        { id: "known", title: "已知任务", task: "处理已知任务" },
        { id: "orphan", title: "悬空任务", task: "依赖缺失任务", dependsOn: ["missing"] },
      ],
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("依赖引用不存在");
    expect(parsed.issues).toContain("依赖引用不存在：tasks[1].dependsOn → missing");
    expect(parsed).not.toHaveProperty("tasks");
  });

  it("无依赖任务解析后都处于同一平铺波次", () => {
    const parsed = parseSuperDelegationPayload({
      tasks: [
        { id: "one", title: "任务一", task: "执行一" },
        { id: "two", title: "任务二", task: "执行二" },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(planSuperWaves(parsed.tasks as SuperTaskSpec[])).toMatchObject({
      mode: "flat",
      waves: [["one", "two"]],
      taskWave: { one: 0, two: 0 },
      issues: [],
    });
  });
});
