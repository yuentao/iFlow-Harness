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

  it("脏 JSON 字符串（原始换行 + 尾逗号）两通道一致：围栏能派发，工具通道也必须能派发", () => {
    // 任务书正文带未转义的原始换行，数组与对象末尾各带一个尾逗号。
    const dirty = '{\n"tasks":[{"title":"甲","task":"第一行\n第二行",},],\n}';
    const fenced = parseSuperDelegationPayload(dirty);
    expect(fenced.ok).toBe(true);
    if (!fenced.ok) return;
    expect(fenced.tasks[0]?.task).toContain("\n第二行");

    const parsed = parseSuperToolCall("dispatch", dirty);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.tasks.flat()[0]?.task).toContain("\n第二行");
    expect(parsed.tasks.flat()[0]?.title).toBe("甲");
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

  it("有 tasks 时按派发处理；tasks 与 actions 同时非空 → conflict 明确报错", () => {
    const withTasks = { tasks: [{ title: "甲", task: "做事" }] };
    expect(resolveSuperToolCallKind("dispatch", withTasks)).toBe("dispatch");
    // 派发与动作互斥：并存不是「派发优先」，而是结构错误，必须显式失败，
    // 不能静默挑一条通道执行、把另一半指令凭空丢掉。
    expect(resolveSuperToolCallKind("dispatch", { ...withTasks, ...actionArgs })).toBe(
      "conflict",
    );
    const parsed = parseSuperToolCall("dispatch", { ...withTasks, ...actionArgs });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("both tasks and actions");
    expect(parsed.issues[0]).toContain("tasks 与 actions");
  });

  it("空 actions 不改判：照派发解析并明确失败，不静默成功", () => {
    expect(resolveSuperToolCallKind("dispatch", { actions: [] })).toBe("dispatch");
    expect(parseSuperToolCall("dispatch", { actions: [] }).ok).toBe(false);
  });

  it("反向不改判：actions 工具带纯 tasks 仍按 actions 处理（不误吞派发载荷）", () => {
    expect(resolveSuperToolCallKind("actions", { tasks: [{ title: "甲", task: "做事" }] })).toBe(
      "actions",
    );
  });

  it("actions 通道：tasks 与 actions 并存同样判 conflict（与工具名无关）", () => {
    // 与 dispatch 侧同口径：并存是载荷结构错误，不能只执行 actions 把 tasks
    // 静默丢弃。
    const both = { tasks: [{ title: "甲", task: "做事" }], ...actionArgs };
    expect(resolveSuperToolCallKind("actions", both)).toBe("conflict");
    const parsed = parseSuperToolCall("actions", both);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("both tasks and actions");
    expect(parsed.issues[0]).toContain("tasks 与 actions");
    expect(parsed.issues[0]).toContain("分开");
  });

  it("actions 通道：纯 actions 行为不变（仍解析出动作）", () => {
    expect(resolveSuperToolCallKind("actions", actionArgs)).toBe("actions");
    const parsed = parseSuperToolCall("actions", actionArgs);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.kind).toBe("actions");
    expect(parsed.tasks).toEqual([]);
    expect(parsed.actions).toEqual([{ action: "cancel", sessionId: "super-x" }]);
  });

  it("actions 通道：纯 tasks（无 actions）行为不变 —— 不误判 conflict，按 actions 解析为空载失败", () => {
    const pureTasks = { tasks: [{ title: "甲", task: "做事" }] };
    expect(resolveSuperToolCallKind("actions", pureTasks)).toBe("actions");
    // 名字是 actions 却不带动作：明确失败，绝不静默成功或改判派发。
    expect(parseSuperToolCall("actions", pureTasks).ok).toBe(false);
  });

  it("actions 通道：tasks / actions 都为空数组行为不变（不判 conflict，按空载失败）", () => {
    const empty = { tasks: [], actions: [] };
    expect(resolveSuperToolCallKind("actions", empty)).toBe("actions");
    expect(parseSuperToolCall("actions", empty).ok).toBe(false);
    // dispatch 侧同样保持：两者都空 → 仍按 dispatch，解析为空载失败。
    expect(resolveSuperToolCallKind("dispatch", empty)).toBe("dispatch");
    expect(parseSuperToolCall("dispatch", empty).ok).toBe(false);
  });
});

/**
 * `parseSuperDelegationTasks` —— 宿主 reducer 与转录卡片共用的委派载荷解析。
 *
 * 口径必须与派发器**完全一致**（复用同一份实现，不复制校验）：模型调内置
 * `super-agent` 工具时漏掉 title 的载荷现在被**拒绝**（title 必填），卡片与
 * 派发器给出同一字段级诊断，不会出现「派发成功但卡片说失败」的分叉。
 */
describe("parseSuperDelegationTasks", () => {
  it("缺 title 的载荷被拒绝（title 必填，不会回退 task 首行）", () => {
    const tasks = parseSuperDelegationTasks({
      tasks: [{ task: "只读审查 src/panel/panel.ts\n补充说明在下一行" }],
    });
    expect(tasks).toBeNull();
  });

  it("显式 title 照常保留", () => {
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
    const tasks = parseSuperDelegationTasks('{"tasks":[{"title":"审查","task":"第一行\n第二行",}]}');
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
    const args = { tasks: [{ title: "同一载荷", task: "同一个载荷" }] };
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

  it("缺 title → 拒绝该条，原因指向 title 必填（绝不拿 task 正文当标题）", () => {
    const parsed = parseSuperDelegationPayload({
      tasks: [{ task: "项目根目录：任务：背景：一整段描述" }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("title 必填");
    expect(parsed.issues).toEqual([
      "tasks[0].title 必填（每个任务都必须有非空标题，不能用任务正文当标题）",
    ]);
    // 整段任务描述不能出现在任何结果的 title 上（这里根本没有结果任务）。
    expect(JSON.stringify(parsed)).not.toContain('"title":"项目根目录');
  });

  it("title 为空白字符 → 同样拒绝", () => {
    const parsed = parseSuperDelegationPayload({ tasks: [{ title: "   \t ", task: "做点事" }] });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues?.[0]).toContain("title 必填");
  });

  it("混合载荷：缺 title 的条目被拒绝、带 title 的照常派发", () => {
    const parsed = parseSuperDelegationPayload({
      tasks: [{ title: "合法", task: "做这件事" }, { task: "缺标题的任务" }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0]?.title).toBe("合法");
    expect(parsed.issues).toEqual([
      "tasks[1].title 必填（每个任务都必须有非空标题，不能用任务正文当标题）",
    ]);
  });

  it("非对象条目 → 指出是第几条不是对象", () => {
    const parsed = parseSuperDelegationPayload({ tasks: ["坏条目"] });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues).toEqual(["tasks[0] 必须是对象"]);
  });

  it("混合载荷：合法任务保留，畸形条目进 issues（ok:true）", () => {
    const parsed = parseSuperDelegationPayload({
      tasks: [{ title: "合法任务", task: "合法任务" }, { task: 42 }],
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
      tasks: [{ title: "真的", task: "真的" }, { task: 7 }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.tasks.flat()).toHaveLength(1);
    expect(parsed.issues).toEqual(["tasks[1].task 必须是字符串"]);
  });
});

/**
 * 动作围栏的容错口径必须与派发通道一致：同一份「脏但语义完整」的 JSON
 * （尾逗号 / 裸换行 / 非法转义）在委派围栏里能派发，在动作围栏里也必须能执行。
 * 旧实现用严格 JSON.parse，两条通道的容错口径不对称 —— 动作被静默丢弃。
 */
describe("动作围栏 · 宽松解析（与派发通道同源）", () => {
  it("尾逗号（对象 / 数组末尾都有）也能解析出动作", () => {
    const text = [
      "```super-agent-actions",
      '{"actions":[{"action":"cancel","sessionId":"super-x",},],}',
      "```",
    ].join("\n");
    const scan = extractSuperActions(text, 0);
    expect(scan.invalidBlocks).toEqual([]);
    expect(scan.actions).toEqual([{ action: "cancel", sessionId: "super-x" }]);
  });

  it("answer 文本里的裸换行被修复后原样保留", () => {
    const text = [
      "```super-agent-actions",
      '{"actions":[{"action":"answer","sessionId":"super-a","answers":{"问题":"第一行',
      '第二行"}}]}',
      "```",
    ].join("\n");
    const scan = extractSuperActions(text, 0);
    expect(scan.invalidBlocks).toEqual([]);
    expect(scan.actions[0]).toMatchObject({ action: "answer", sessionId: "super-a" });
    if (scan.actions[0]?.action !== "answer") return;
    expect(scan.actions[0].answers["问题"]).toBe("第一行\n第二行");
  });
});
