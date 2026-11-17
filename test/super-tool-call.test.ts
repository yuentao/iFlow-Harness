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
  parseSuperDelegationTasks,
  parseSuperToolCall,
  resolveSuperToolCallKind,
  synthesizeSuperToolCallBlock,
} from "../shared/super-tool-call.js";
import { extractSuperActions, extractSuperDirectives, parseSuperDelegationPayload } from "../shared/super-agent.js";

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

describe("classifySuperToolName · 命名空间前缀", () => {
  it("接受 `__` / `.` 分隔的命名空间前缀（内置工具注册名可能带前缀）", () => {
    const cases: Array<[string, "dispatch" | "actions"]> = [
      ["iflow__super-agent", "dispatch"],
      ["server__super-agent", "dispatch"],
      ["mcp__server__super-agent", "dispatch"],
      ["iflow.super-agent", "dispatch"],
      ["super.agent", "dispatch"],
      ["IFLOW__Super_Agent", "dispatch"],
      ["iflow__super-agent-actions", "actions"],
      ["server.super_agent_actions", "actions"],
      ["iflow.super-agent-actions", "actions"],
    ];
    for (const [name, expected] of cases) {
      expect(classifySuperToolName(name)).toBe(expected);
    }
  });

  it("前缀形态仍然严格：整串与最后一段都不等于目标就落空", () => {
    for (const name of [
      "super-agent-guard",
      "super-agent-tool-v2",
      "iflow__super-agent-guard",
      "server.super-agent-tool-v2",
      "iflow__super-agent-actions-extra",
      "super.agent.guard",
      "iflow__super_agent_extra",
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

  it("任务正文含 ``` 围栏与换行时仍能完整切出（收栏按 JSON 结构定位）", () => {
    const task = '第一行\n```super-agent\n{"tasks":[]}\n```\n最后一行';
    const parsed = parseSuperToolCall("dispatch", { tasks: [{ title: "带围栏", task }] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.tasks.flat()[0]?.task).toBe(task);
  });

  it("长任务书里的裸引号 / 反斜杠 / 反引号原样保留", () => {
    const task =
      '实现 "foo" 与 C:\\path\\to\\file，并保留 `code` 与 \\" 转义；'.repeat(40) + '结尾"';
    const parsed = parseSuperToolCall("dispatch", [{ title: '引号 "x"', task }]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.tasks.flat()[0]?.task).toBe(task.trim());
    expect(parsed.tasks.flat()[0]?.title).toBe('引号 "x"');
  });

  it("直接数组载荷（含 JSON 字符串形式）同样可解析", () => {
    const parsed = parseSuperToolCall(
      "dispatch",
      '[{"title":"数组","task":"直接数组载荷"}]',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.tasks.flat()[0]?.task).toBe("直接数组载荷");
  });

  it("actions 的 answers 含反引号与换行时原样保留", () => {
    const answer = "第一行\n```js\nconst a = 1;\n```";
    const parsed = parseSuperToolCall("actions", {
      actions: [{ action: "answer", sessionId: "super-a", answers: { "问题": answer } }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.actions[0]?.action).toBe("answer");
    if (parsed.actions[0]?.action !== "answer") return;
    expect(parsed.actions[0].answers["问题"]).toBe(answer);
  });
});

describe("合并载荷纠偏 · super-agent 工具的 actions 参数", () => {
  const actionArgs = { actions: [{ action: "cancel", sessionId: "super-x" }] };

  it("dispatch 名字 + 纯 actions 载荷 → 识别为 actions 并解析出动作", () => {
    expect(resolveSuperToolCallKind("dispatch", actionArgs)).toBe("actions");
    const parsed = parseSuperToolCall("dispatch", actionArgs);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.kind).toBe("actions");
    expect(parsed.tasks).toEqual([]);
    expect(parsed.actions).toEqual([{ action: "cancel", sessionId: "super-x" }]);
  });

  it("字符串 JSON 载荷同样被识别为 actions", () => {
    const parsed = parseSuperToolCall("dispatch", JSON.stringify(actionArgs));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.kind).toBe("actions");
    expect(parsed.actions[0]?.sessionId).toBe("super-x");
  });

  it("有 tasks 时不改判（派发优先），两者都带也不误吞", () => {
    const withTasks = { tasks: [{ title: "甲", task: "做事" }] };
    expect(resolveSuperToolCallKind("dispatch", withTasks)).toBe("dispatch");
    expect(resolveSuperToolCallKind("dispatch", { ...withTasks, ...actionArgs })).toBe("dispatch");
  });

  it("空 actions 不改判：照派发解析并明确失败，不静默成功", () => {
    expect(resolveSuperToolCallKind("dispatch", { actions: [] })).toBe("dispatch");
    expect(parseSuperToolCall("dispatch", { actions: [] }).ok).toBe(false);
  });

  it("反向不改判：actions 工具带 tasks 仍按 actions 处理", () => {
    expect(resolveSuperToolCallKind("actions", { tasks: [{ title: "甲", task: "做事" }] })).toBe(
      "actions",
    );
  });
});

/**
 * `parseSuperDelegationTasks` —— 宿主 reducer 与转录卡片共用的委派载荷解析。
 *
 * 口径必须与派发器**完全一致**（复用同一份实现，不复制校验）：模型调内置
 * `super-agent` 工具时**有时漏掉 `title`**（wire 实证：args 是
 * `{"tasks":[{"task":"…"}]}`），派发器容忍它（回退到 task 首行、照常派发），
 * 而卡片此前要求每条任务都有非空 title → 把一次成功的委派谎报成解析失败。
 */
describe("parseSuperDelegationTasks", () => {
  it("缺 title 时回退到 task 首行（与派发器同口径，不判非法）", () => {
    const tasks = parseSuperDelegationTasks({
      tasks: [{ task: "只读审查 src/panel/panel.ts\n补充说明在下一行" }],
    });
    expect(tasks).not.toBeNull();
    expect(tasks?.[0]?.title).toBe("只读审查 src/panel/panel.ts");
    expect(tasks?.[0]?.task).toBe("只读审查 src/panel/panel.ts\n补充说明在下一行");
  });

  it("显式 title 照常保留（与首行回退并存）", () => {
    const tasks = parseSuperDelegationTasks({
      tasks: [{ title: "审查面板", task: "只读审查 src/panel/panel.ts" }],
    });
    expect(tasks?.[0]?.title).toBe("审查面板");
  });

  it("attachments 同时接受 string[] 与 {path,name} 对象数组", () => {
    const tasks = parseSuperDelegationTasks({
      tasks: [
        { title: "甲", task: "做甲", attachments: ["a.png", "docs/b.txt"] },
        { title: "乙", task: "做乙", attachments: [{ path: "C:/tmp/c.png", name: "c.png" }] },
      ],
    });
    expect(tasks?.[0]?.attachments?.map((a) => a.name)).toEqual(["a.png", "b.txt"]);
    expect(tasks?.[1]?.attachments?.map((a) => a.name)).toEqual(["c.png"]);
    expect(tasks?.[1]?.attachments?.[0]?.path).toBe("C:/tmp/c.png");
  });

  it("字符串形态走宽松解析（原始换行 / 尾逗号都能救回来）", () => {
    const tasks = parseSuperDelegationTasks('{"tasks":[{"task":"第一行\n第二行",}]}');
    expect(tasks).not.toBeNull();
    expect(tasks?.[0]?.task).toBe("第一行\n第二行");
  });

  it("非法载荷返回 null（绝不编造内容）", () => {
    for (const args of [
      undefined,
      null,
      5,
      "",
      "{bad json",
      '{"tasks":[]}',
      '{"tasks":"x"}',
      { foo: 1 },
      { tasks: [{ title: "只有标题" }] },
    ]) {
      expect(parseSuperDelegationTasks(args)).toBeNull();
    }
  });

  it("与派发器同源：解析结果与 parseSuperToolCall 的任务完全一致", () => {
    const args = { tasks: [{ task: "同一个载荷" }] };
    const direct = parseSuperDelegationTasks(args);
    const viaDispatcher = parseSuperToolCall("dispatch", args);
    expect(viaDispatcher.ok).toBe(true);
    if (!viaDispatcher.ok) return;
    expect(direct).toEqual(viaDispatcher.tasks.flat());
  });
});

/**
 * 畸形委派载荷必须给出可诊断的错误，而不是静默丢成「零派发 + 一堵 JSON 墙」。
 *
 * 实测形态（2026-11-17）：主 Agent 把 `tasks[].task` 写成字符串数组
 * （`{"tasks":[["a","b"]]}`），旧解析只回一句「没有可派发的任务」，用户与模型
 * 都无法定位是哪个字段写错了。
 */
describe("parseSuperDelegationPayload · 畸形载荷诊断", () => {
  it("tasks[].task 传成字符串数组 → ok:false，原因指向 task 字段", () => {
    const parsed = parseSuperDelegationPayload({ tasks: [["a", "b"]] });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("task 必须是字符串");
    expect(parsed.issues).toEqual(["tasks[0].task 必须是字符串"]);
  });

  it("task 不是字符串 → ok:false，索引级原因", () => {
    const parsed = parseSuperDelegationPayload({ tasks: [{ task: 123 }] });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("task 必须是字符串");
    expect(parsed.issues).toEqual(["tasks[0].task 必须是字符串"]);
  });

  it("非对象条目 → 指出是第几条不是对象", () => {
    const parsed = parseSuperDelegationPayload({ tasks: ["坏条目"] });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues).toEqual(["tasks[0] 必须是对象"]);
  });

  it("混合载荷：合法任务保留，畸形条目进 issues（ok:true）", () => {
    const parsed = parseSuperDelegationPayload({
      tasks: [{ task: "合法任务" }, { task: 42 }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0]?.task).toBe("合法任务");
    expect(parsed.issues).toEqual(["tasks[1].task 必须是字符串"]);
  });

  it("parseSuperToolCall 的失败分支带 issues", () => {
    const parsed = parseSuperToolCall("dispatch", { tasks: [["a", "b"]] });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("task 必须是字符串");
    expect(parsed.issues).toContain("tasks[0].task 必须是字符串");
  });

  it("parseSuperToolCall 的成功分支带 issues（混合载荷）", () => {
    const parsed = parseSuperToolCall("dispatch", {
      tasks: [{ task: "真的" }, { task: 7 }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.tasks.flat()).toHaveLength(1);
    expect(parsed.issues).toEqual(["tasks[1].task 必须是字符串"]);
  });
});
