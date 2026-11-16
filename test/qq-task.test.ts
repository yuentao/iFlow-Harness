import { describe, expect, it } from "vitest";
import {
  DEFAULT_QQ_TASK_LIMITS,
  buildQqTaskResult,
  chunkQqText,
  createQqTask,
  formatQqTaskSummary,
  isTerminalStatus,
  makeIdempotencyKey,
  qqTaskStatusLabel,
  shortTaskId,
  transitionQqTask,
  validateQqTaskRequest,
  type CreateQqTaskInput,
  type QqTask,
  type QqTaskRequest,
  type QqTaskStatus,
} from "../shared/qq-task.js";
import type { Block, TurnChangeUi } from "../shared/messages.js";

const CREATED_AT = 1_800_000_000_000;

function makeInput(over: Partial<CreateQqTaskInput> = {}): CreateQqTaskInput {
  return {
    adapter: "qq-bot",
    source: { chatType: "private", chatId: "c-1", senderId: "u-1", msgId: "m-1" },
    target: { workspace: "j:/proj/app" },
    payload: { prompt: "整理登录模块", attachments: [], contexts: [] },
    policy: { remotePolicy: "supervised", resultDetail: "standard" },
    ...over,
  };
}

function makeTask(over: Partial<QqTask> = {}): QqTask {
  const base = createQqTask(makeInput(), { now: () => CREATED_AT, random: () => 0 });
  return { ...base, ...over };
}

function baseRequest(over: Partial<QqTaskRequest> = {}): QqTaskRequest {
  return {
    authorized: true,
    chatType: "private",
    prompt: "整理登录模块",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 创建与幂等
// ---------------------------------------------------------------------------

describe("createQqTask / idempotency", () => {
  it("生成确定形态的 taskId 与幂等键（可注入时钟与随机源）", () => {
    const task = createQqTask(makeInput(), { now: () => CREATED_AT, random: () => 0 });
    expect(task.taskId).toBe(`T-${CREATED_AT.toString(36)}-000000`);
    expect(task.idempotencyKey).toBe("qq-bot:m-1");
    expect(task.status).toBe("received");
    expect(task.createdAt).toBe(CREATED_AT);
    expect(task.updatedAt).toBe(CREATED_AT);
    expect(task.correlation).toEqual({});
  });

  it("随机段按注入随机源取 base36，随机值越界被夹取", () => {
    const task = createQqTask(makeInput(), { now: () => CREATED_AT, random: () => 1 });
    expect(task.taskId.endsWith("-zzzzzz")).toBe(true);
  });

  it("不同 adapter / msgId 产生不同幂等键，同一组合稳定", () => {
    expect(makeIdempotencyKey("a", "m")).toBe("a:m");
    expect(makeIdempotencyKey("a", "m")).toBe(makeIdempotencyKey("a", "m"));
    expect(makeIdempotencyKey("a", "m")).not.toBe(makeIdempotencyKey("b", "m"));
    expect(makeIdempotencyKey("a", "m")).not.toBe(makeIdempotencyKey("a", "m2"));
  });

  it("payload 数组做浅拷贝，调用方后续改动不影响任务", () => {
    const attachments = ["a.png"];
    const task = createQqTask(
      makeInput({ payload: { prompt: "p", attachments, contexts: ["src/a.ts"] } }),
      { now: () => CREATED_AT, random: () => 0 },
    );
    attachments.push("b.png");
    expect(task.payload.attachments).toEqual(["a.png"]);
    expect(task.payload.contexts).toEqual(["src/a.ts"]);
  });

  it("shortTaskId 取末 6 位", () => {
    expect(shortTaskId("T-abc-def123")).toBe("def123");
    expect(shortTaskId("T-xy")).toBe("T-xy");
  });
});

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

describe("transitionQqTask", () => {
  it("主干迁移返回新对象且不就地改", () => {
    let task = makeTask();
    let clock = CREATED_AT;
    const chain: QqTaskStatus[] = ["validated", "queued", "dispatched", "running", "succeeded"];
    for (const status of chain) {
      const before = task;
      clock += 1000;
      const outcome = transitionQqTask(task, status, clock);
      expect(outcome.noop).toBe(false);
      expect(outcome.error).toBeUndefined();
      expect(outcome.task).not.toBe(before);
      expect(outcome.task.status).toBe(status);
      expect(before.status).not.toBe(status);
      expect(outcome.task.updatedAt).toBe(clock);
      task = outcome.task;
    }
    expect(task.status).toBe("succeeded");
  });

  it("等待态可以进出主干", () => {
    const running = transitionQqTask(makeTask(), "validated", CREATED_AT + 1).task;
    const validated = transitionQqTask(running, "queued", CREATED_AT + 2).task;
    const queued = transitionQqTask(validated, "dispatched", CREATED_AT + 3).task;
    const dispatched = transitionQqTask(queued, "running", CREATED_AT + 4).task;
    const waiting = transitionQqTask(dispatched, "waiting_approval", CREATED_AT + 5);
    expect(waiting.noop).toBe(false);
    expect(waiting.task.status).toBe("waiting_approval");
    const resumed = transitionQqTask(waiting.task, "running", CREATED_AT + 6);
    expect(resumed.noop).toBe(false);
    expect(resumed.task.status).toBe("running");
  });

  it("非法迁移返回原对象 + noop + illegal_transition 错误码", () => {
    const task = makeTask();
    const outcome = transitionQqTask(task, "succeeded", CREATED_AT + 1);
    expect(outcome.noop).toBe(true);
    expect(outcome.task).toBe(task);
    expect(outcome.error?.code).toBe("illegal_transition");
  });

  it("同状态重复迁移按 noop 处理且不报错", () => {
    const task = makeTask();
    const outcome = transitionQqTask(task, "received", CREATED_AT + 1);
    expect(outcome.noop).toBe(true);
    expect(outcome.task).toBe(task);
    expect(outcome.error).toBeUndefined();
  });

  it("终态粘性：任何迁移都返回原对象", () => {
    const terminals: QqTaskStatus[] = ["succeeded", "failed", "canceled", "timeout", "needs_review"];
    for (const status of terminals) {
      expect(isTerminalStatus(status)).toBe(true);
      const task = makeTask({ status });
      const outcome = transitionQqTask(task, "running", CREATED_AT + 1);
      expect(outcome.noop).toBe(true);
      expect(outcome.task).toBe(task);
      expect(outcome.error).toBeUndefined();
    }
    expect(isTerminalStatus("running")).toBe(false);
    expect(isTerminalStatus("waiting_answer")).toBe(false);
  });

  it("updatedAt 不会被回拨（时钟回退不产生负耗时）", () => {
    const task = makeTask({ updatedAt: CREATED_AT + 5000 });
    const outcome = transitionQqTask(task, "validated", CREATED_AT);
    expect(outcome.task.updatedAt).toBe(CREATED_AT + 5000);
  });
});

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

describe("validateQqTaskRequest", () => {
  it("合法私聊请求通过", () => {
    expect(validateQqTaskRequest(baseRequest())).toEqual({ ok: true });
  });

  it("群聊开启且 @ 后可执行", () => {
    const result = validateQqTaskRequest(
      baseRequest({ chatType: "group", groupAllowed: true, mentioned: true }),
    );
    expect(result.ok).toBe(true);
  });

  const cases: Array<[string, QqTaskRequest]> = [
    ["unauthorized", baseRequest({ authorized: false })],
    ["group_not_allowed", baseRequest({ chatType: "group" })],
    ["mention_required", baseRequest({ chatType: "group", groupAllowed: true })],
    ["rate_limited", baseRequest({ rateLimited: true })],
    ["duplicate", baseRequest({ duplicate: true })],
    ["prompt_empty", baseRequest({ prompt: "   \n\t" })],
    ["prompt_too_long", baseRequest({ prompt: "x".repeat(DEFAULT_QQ_TASK_LIMITS.maxPromptChars + 1) })],
    [
      "too_many_attachments",
      baseRequest({
        attachments: Array.from({ length: DEFAULT_QQ_TASK_LIMITS.maxAttachments + 1 }, () => ({ size: 1 })),
      }),
    ],
    [
      "attachment_too_large",
      baseRequest({
        attachments: [
          { name: "big.png", kind: "image", size: DEFAULT_QQ_TASK_LIMITS.maxImageBytes + 1 },
        ],
      }),
    ],
    [
      "workspace_not_allowed",
      baseRequest({ workspace: "j:/other", allowedWorkspaces: ["j:/proj/app"] }),
    ],
  ];

  it.each(cases)("拒绝 %s", (code, request) => {
    const result = validateQqTaskRequest(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(code);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("文件附件按 maxFileBytes 判定（图片与文件两档）", () => {
    const fileTooBig = validateQqTaskRequest(
      baseRequest({ attachments: [{ kind: "file", size: DEFAULT_QQ_TASK_LIMITS.maxFileBytes + 1 }] }),
    );
    expect(fileTooBig.ok).toBe(false);
    if (!fileTooBig.ok) expect(fileTooBig.code).toBe("attachment_too_large");

    const imageOk = validateQqTaskRequest(
      baseRequest({ attachments: [{ kind: "image", size: DEFAULT_QQ_TASK_LIMITS.maxFileBytes + 1 }] }),
    );
    expect(imageOk.ok).toBe(true);
  });

  it("上限可参数化", () => {
    expect(validateQqTaskRequest(baseRequest({ prompt: "123456" }), { maxPromptChars: 5 })).toMatchObject({
      ok: false,
      code: "prompt_too_long",
    });
    expect(
      validateQqTaskRequest(baseRequest({ attachments: [{ size: 0 }, { size: 0 }] }), { maxAttachments: 1 }),
    ).toMatchObject({ ok: false, code: "too_many_attachments" });
    expect(
      validateQqTaskRequest(baseRequest({ attachments: [{ kind: "image", size: 11 }] }), { maxImageBytes: 10 }),
    ).toMatchObject({ ok: false, code: "attachment_too_large" });
    expect(
      validateQqTaskRequest(baseRequest({ attachments: [{ kind: "file", size: 11 }] }), { maxFileBytes: 10 }),
    ).toMatchObject({ ok: false, code: "attachment_too_large" });
  });

  it("提示词长度按 Unicode 码点计算", () => {
    const atLimit = "😀".repeat(DEFAULT_QQ_TASK_LIMITS.maxPromptChars);
    expect(validateQqTaskRequest(baseRequest({ prompt: atLimit })).ok).toBe(true);
    const overLimit = `${atLimit}😀`;
    expect(validateQqTaskRequest(baseRequest({ prompt: overLimit }))).toMatchObject({
      ok: false,
      code: "prompt_too_long",
    });
  });

  it("工作区白名单：缺省工作区或未提供白名单时不校验", () => {
    expect(validateQqTaskRequest(baseRequest({ workspace: "j:/any" })).ok).toBe(true);
    expect(validateQqTaskRequest(baseRequest({ allowedWorkspaces: ["j:/proj/app"] })).ok).toBe(true);
  });

  it("未知附件大小按 0 处理，不误判超限", () => {
    expect(validateQqTaskRequest(baseRequest({ attachments: [{ kind: "file" }] })).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 结果聚合
// ---------------------------------------------------------------------------

function toolBlock(): Block {
  return {
    kind: "tool",
    toolCallId: "t-1",
    toolName: "read_file",
    title: "read_file",
    toolKind: "read",
    status: "completed",
    output: "",
    locations: [],
    diff: null,
  };
}

function turnChange(over: Partial<TurnChangeUi> = {}): TurnChangeUi {
  return {
    toolCallId: "t-1",
    title: "replace",
    status: "completed",
    key: "src/a.ts",
    path: "src/a.ts",
    additions: 5,
    deletions: 2,
    edits: 1,
    canUndo: true,
    ...over,
  };
}

describe("buildQqTaskResult", () => {
  it("从尾部取最后一条非 system 的非空 text 块作为摘要", () => {
    const blocks: Block[] = [
      { kind: "user", id: "u1", text: "做一个任务" },
      { kind: "text", id: "b1", text: "第一段回复" },
      { kind: "text", id: "b2", text: "   " },
      toolBlock(),
      { kind: "text", id: "b3", text: "系统提示", system: true },
    ];
    const result = buildQqTaskResult({
      stopReason: "end_turn",
      blocks,
      turnChanges: [turnChange()],
    });
    expect(result.summary).toBe("第一段回复");
    expect(result.stopReason).toBe("end_turn");
    expect(result.changes).toEqual([
      { path: "src/a.ts", additions: 5, deletions: 2, status: "completed" },
    ]);
    expect(result.usage).toBeUndefined();
    expect(result.artifacts).toEqual([]);
    expect(result.branch).toBeUndefined();
  });

  it("没有可用 text 块时摘要为空串（不拿 user 文本冒充）", () => {
    const result = buildQqTaskResult({
      stopReason: "end_turn",
      blocks: [{ kind: "user", id: "u1", text: "用户消息" }],
      turnChanges: [],
    });
    expect(result.summary).toBe("");
    expect(result.changes).toEqual([]);
  });

  it("透传 usage / branch，并把 PR 地址收进产物", () => {
    const result = buildQqTaskResult({
      stopReason: "end_turn",
      blocks: [],
      turnChanges: [],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      branch: "iflow/super/qq-task",
      integration: {
        mode: "merge",
        state: "pr_created",
        url: "https://github.com/x/y/pull/1",
        at: CREATED_AT,
      },
    });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    expect(result.branch).toBe("iflow/super/qq-task");
    expect(result.artifacts).toEqual(["https://github.com/x/y/pull/1"]);
  });
});

// ---------------------------------------------------------------------------
// 纯文本摘要
// ---------------------------------------------------------------------------

describe("formatQqTaskSummary", () => {
  const task = makeTask({
    status: "succeeded",
    updatedAt: CREATED_AT + 90_000,
    correlation: { branch: "iflow/super/qq-task" },
    result: {
      stopReason: "end_turn",
      summary: "# 完成情况\n\n| 文件 | 结果 |\n| --- | --- |\n\n- 修好了登录校验",
      changes: [
        { path: "src/a.ts", additions: 10, deletions: 2, status: "completed" },
        { path: "src/b.ts", additions: 0, deletions: 1, status: "completed" },
      ],
      artifacts: [],
    },
  });

  it("包含关键字段且不含 Markdown 标题 / 表格", () => {
    const text = formatQqTaskSummary(task, "standard");
    expect(text).toContain(shortTaskId(task.taskId));
    expect(text).toContain("成功 (succeeded)");
    expect(text).toContain("耗时");
    expect(text).toContain("1 分 30 秒");
    expect(text).toContain("2 个文件 (+10 -3)");
    expect(text).toContain("iflow/super/qq-task");
    expect(text).toContain(`/qq status ${task.taskId}`);
    expect(text).toContain(`/qq log ${task.taskId}`);
    expect(text).toContain("完成情况");
    expect(text).toContain("修好了登录校验");

    const lines = text.split("\n");
    expect(lines.some((line) => /^#{1,6}\s/.test(line))).toBe(false);
    expect(lines.some((line) => line.trimStart().startsWith("|"))).toBe(false);
    expect(lines.some((line) => line.trimStart().startsWith("```"))).toBe(false);
  });

  it("summary 档省略摘要正文与日志命令，full 档追加改动明细", () => {
    const short = formatQqTaskSummary(task, "summary");
    expect(short).not.toContain("完成情况");
    expect(short).not.toContain("/qq log");
    expect(short).toContain("/qq status");

    const full = formatQqTaskSummary(task, "full");
    expect(full).toContain("完成情况");
    expect(full).toContain("改动明细");
    expect(full).toContain("+10 -2  src/a.ts");
  });

  it("结果缺失时如实写未记录，不补造统计", () => {
    const pending = makeTask({ status: "waiting_approval", pending: { kind: "approval", text: "run_shell_command", at: CREATED_AT } });
    const text = formatQqTaskSummary(pending, "standard");
    expect(text).toContain("改动  未记录");
    expect(text).toContain("等待  审批：run_shell_command");
    expect(text).toContain(qqTaskStatusLabel("waiting_approval"));
  });

  it("失败原因如实呈现", () => {
    const failed = makeTask({ status: "failed", failure: { code: "rate_limited", message: "请求过于频繁" } });
    const text = formatQqTaskSummary(failed, "summary");
    expect(text).toContain("失败  rate_limited：请求过于频繁");
    expect(text).toContain("失败 (failed)");
  });
});

// ---------------------------------------------------------------------------
// 分片
// ---------------------------------------------------------------------------

describe("chunkQqText", () => {
  it("空输入返回空数组", () => {
    expect(chunkQqText("", 100)).toEqual([]);
  });

  it("普通文本按行切分，每片不超长且不丢内容", () => {
    const text = Array.from({ length: 40 }, (_, i) => `第 ${i} 行内容，长度略长一些用来撑满预算`).join("\n");
    const chunks = chunkQqText(text, 60);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(60);
    expect(chunks.join("\n")).toBe(text);
  });

  it("超长单行按字符硬切", () => {
    const text = "a".repeat(250);
    const chunks = chunkQqText(text, 40);
    expect(chunks.length).toBe(7);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(40);
    expect(chunks.join("")).toBe(text);
  });

  it("代码围栏不被切断：每片围栏成对", () => {
    const body = Array.from({ length: 30 }, (_, i) => `const value${i} = ${i};`);
    const text = ["前言", "```ts", ...body, "```", "后记"].join("\n");
    const chunks = chunkQqText(text, 80);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(80);
      const fences = chunk.split("\n").filter((line) => line.trimStart().startsWith("```"));
      expect(fences.length % 2).toBe(0);
    }
    expect(chunks[0]!.startsWith("前言")).toBe(true);
    expect(chunks[chunks.length - 1]!.endsWith("后记")).toBe(true);
    const codeLines = chunks.flatMap((chunk) => chunk.split("\n")).filter((line) => line.startsWith("const value"));
    expect(codeLines).toHaveLength(30);
  });

  it("未闭合围栏在片尾补齐关闭标记", () => {
    const text = ["```js", ...Array.from({ length: 10 }, (_, i) => `line ${i} content here`)].join("\n");
    const chunks = chunkQqText(text, 60);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const fences = chunk.split("\n").filter((line) => line.trimStart().startsWith("```"));
      expect(fences.length % 2).toBe(0);
      expect(chunk.length).toBeLessThanOrEqual(60);
    }
    expect(chunks[chunks.length - 1]!.endsWith("```")).toBe(true);
  });

  it("非法 maxChars 抛 RangeError", () => {
    expect(() => chunkQqText("x", 0)).toThrow(RangeError);
    expect(() => chunkQqText("x", Number.NaN)).toThrow(RangeError);
  });
});
