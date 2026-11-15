/**
 * 结构化工具调用兜底的纯逻辑：名字归一 + 载荷合成 + 复用现有协议解析器。
 *
 * 这里钉住三件事：
 *  1. 名字判定**严格整串**归一（`super-agent-guard` 必须落空，否则正常工具帧
 *     会被误判成派发载荷）；
 *  2. `args` 既可以是对象也可以是装着 JSON 的字符串，空 / 非法 / 标量一律 null；
 *  3. 合成出的围栏文本必须能被 `shared/super-agent.ts` 的现有解析器原样解析
 *     —— 兜底通道不允许有第二套校验逻辑。
 */
import { describe, it, expect } from "vitest";
import {
  classifySuperToolName,
  parseSuperToolCall,
  synthesizeSuperToolCallBlock,
} from "../shared/super-tool-call.js";
import { extractSuperActions, extractSuperDirectives } from "../shared/super-agent.js";

describe("classifySuperToolName", () => {
  it("把派发工具名的大小写与分隔符归一", () => {
    for (const name of ["super-agent", "super_agent", "superAgent", "  Super Agent  ", "SUPER-AGENT"]) {
      expect(classifySuperToolName(name)).toBe("dispatch");
    }
  });

  it("把管理动作工具名归一", () => {
    for (const name of ["super-agent-actions", "super_agent_actions", "superAgentActions"]) {
      expect(classifySuperToolName(name)).toBe("actions");
    }
  });

  it("严格整串匹配：其它名字一律 null", () => {
    for (const name of [
      "super-agent-guard",
      "super-agent-actions-extra",
      "task",
      "super",
      "",
      "   ",
      "superagenttool",
    ]) {
      expect(classifySuperToolName(name)).toBeNull();
    }
  });
});

describe("synthesizeSuperToolCallBlock", () => {
  it("对象参数包成对应围栏", () => {
    const text = synthesizeSuperToolCallBlock("dispatch", {
      tasks: [{ title: "任务 A", task: "做点什么" }],
    });
    expect(text).toBe('```super-agent\n{"tasks":[{"title":"任务 A","task":"做点什么"}]}\n```');

    const actions = synthesizeSuperToolCallBlock("actions", {
      actions: [{ action: "cancel", sessionId: "super-1" }],
    });
    expect(actions).toBe(
      '```super-agent-actions\n{"actions":[{"action":"cancel","sessionId":"super-1"}]}\n```',
    );
  });

  it("JSON 字符串参数先 trim 再归一", () => {
    const text = synthesizeSuperToolCallBlock("dispatch", '  {"tasks":[]}  ');
    expect(text).toBe('```super-agent\n{"tasks":[]}\n```');
  });

  it("空 / 非法 / 标量参数返回 null", () => {
    for (const args of ["", "   ", "{not json", "null", "5", null, undefined, 5, true]) {
      expect(synthesizeSuperToolCallBlock("dispatch", args)).toBeNull();
    }
  });
});

describe("parseSuperToolCall", () => {
  it("合成文本能被现有委派解析器解析出任务", () => {
    const parsed = parseSuperToolCall("dispatch", {
      tasks: [
        { title: "第一个", task: "任务正文一" },
        { title: "第二个", task: "任务正文二" },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // 同一段文本交给公开解析器，结果必须与返回值一致（没有第二套校验）。
    const direct = extractSuperDirectives(parsed.text, 0);
    expect(direct.blocks).toEqual(parsed.tasks);
    expect(parsed.tasks.flat().map((task) => task.title)).toEqual(["第一个", "第二个"]);
    expect(parsed.actions).toEqual([]);
  });

  it("接受字符串形式的 JSON 载荷", () => {
    const parsed = parseSuperToolCall(
      "dispatch",
      '{"tasks":[{"title":"字符串载荷","task":"正文"}]}',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.tasks.flat()[0]?.title).toBe("字符串载荷");
  });

  it("管理动作载荷能被现有动作解析器解析", () => {
    const parsed = parseSuperToolCall("actions", {
      actions: [
        { action: "cancel", sessionId: "super-x" },
        { action: "cleanup", sessionId: "super-y", keepBranch: true },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.actions).toEqual([
      { action: "cancel", sessionId: "super-x" },
      { action: "cleanup", sessionId: "super-y", keepBranch: true },
    ]);
    const direct = extractSuperActions(parsed.text, 0);
    expect(direct.actions).toEqual(parsed.actions);
    expect(parsed.tasks).toEqual([]);
  });

  it("参数不可用或载荷为空时明确失败（不伪造派发）", () => {
    for (const args of [undefined, "", "{bad json", 5]) {
      expect(parseSuperToolCall("dispatch", args).ok).toBe(false);
    }
    // 语法合法但没有任务 / 动作：同样算失败（静默「成功」正是要消灭的故障）。
    expect(parseSuperToolCall("dispatch", { tasks: [] }).ok).toBe(false);
    expect(parseSuperToolCall("dispatch", { foo: 1 }).ok).toBe(false);
    expect(parseSuperToolCall("actions", { actions: [] }).ok).toBe(false);
  });
});
