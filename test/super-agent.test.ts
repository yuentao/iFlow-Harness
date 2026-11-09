import { describe, it, expect } from "vitest";
import {
  allSuperSessionsSettled,
  applySuperEvent,
  buildSuperReportPrompt,
  canRetrySuperSession,
  extractSuperDirectives,
  isTerminalSuperStatus,
  MAX_SUPER_ATTACHMENTS,
  normalizeSuperTitle,
  reportForSession,
  retrySuperSession,
  summarizeSuperSessions,
  sumSuperUsage,
  SuperReportBuffer,
  withUsage,
  type SuperSessionUi,
} from "../shared/super-agent.js";

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

describe("super agent · 委派指令解析", () => {
  it("解析一个 super-agent 代码块", () => {
    const text = ["好的，我来并行处理。", "```super-agent", '{"tasks":[{"title":"改登录","task":"修好 src/auth.ts"}]}', "```", "稍等。"].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.blocks).toHaveLength(1);
    expect(scan.blocks[0]).toEqual([{ title: "改登录", task: "修好 src/auth.ts" }]);
    expect(scan.invalidBlocks).toHaveLength(0);
  });

  it("一个块里可以带多个任务", () => {
    const text = ['```super-agent', '{"tasks":[{"title":"A","task":"任务 A"},{"title":"B","task":"任务 B"}]}', "```"].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.blocks[0]).toHaveLength(2);
    expect(scan.blocks[0]?.[1]?.title).toBe("B");
  });

  it("也接受裸数组", () => {
    const text = ['```super-agent', '[{"title":"A","task":"任务 A"}]', "```"].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.blocks[0]).toHaveLength(1);
  });

  it("普通代码块不是委派指令", () => {
    const scan = extractSuperDirectives("```ts\nconst a = 1;\n```");
    expect(scan.blocks).toHaveLength(0);
    expect(scan.invalidBlocks).toHaveLength(0);
  });

  it("JSON 非法 → 收进 invalidBlocks，不抛错", () => {
    const scan = extractSuperDirectives(["```super-agent", "{not json}", "```"].join("\n"));
    expect(scan.blocks).toHaveLength(0);
    expect(scan.invalidBlocks).toHaveLength(1);
  });

  it("缺少 task → 判为非法块", () => {
    const scan = extractSuperDirectives(['```super-agent', '{"tasks":[{"title":"A"}]}', "```"].join("\n"));
    expect(scan.blocks).toHaveLength(0);
    expect(scan.invalidBlocks).toHaveLength(1);
  });

  it("占位符任务被忽略（模型把示例原样抄回来）", () => {
    const text = ['```super-agent', '{"tasks":[{"title":"<标题>","task":"<自包含的任务说明>"}]}', "```"].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.blocks).toHaveLength(0);
    expect(scan.invalidBlocks).toHaveLength(1);
  });

  it("部分占位符被跳过，其余任务照常派发", () => {
    const text = [
      "```super-agent",
      '{"tasks":[{"title":"<标题>","task":"<说明>"},{"title":"真的","task":"真的任务"}]}',
      "```",
    ].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.blocks[0]).toEqual([{ title: "真的", task: "真的任务" }]);
  });

  it("任务可以携带附件路径（字符串或 {path,name} 对象）", () => {
    const text = [
      "```super-agent",
      '{"tasks":[{"title":"A","task":"任务 A","attachments":["docs/spec.md",{"path":"C:/tmp/shot.png","name":"截图.png"}]}]}',
      "```",
    ].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.blocks[0]?.[0]?.attachments).toEqual([
      { name: "spec.md", path: "docs/spec.md" },
      { name: "截图.png", path: "C:/tmp/shot.png" },
    ]);
  });

  it("附件列表里的非法项被跳过，且每个任务的附件数有上限", () => {
    const many = Array.from({ length: 15 }, (_, i) => `f${i}.txt`);
    const text = [
      "```super-agent",
      JSON.stringify({
        tasks: [
          {
            title: "A",
            task: "任务 A",
            attachments: ["<工作区相对路径或绝对路径>", ...many, 42, { name: "x" }, ""],
          },
        ],
      }),
      "```",
    ].join("\n");
    const scan = extractSuperDirectives(text);
    const attachments = scan.blocks[0]?.[0]?.attachments ?? [];
    expect(attachments).toHaveLength(MAX_SUPER_ATTACHMENTS);
    expect(attachments.every((attachment) => typeof attachment.path === "string")).toBe(true);
    // 模型把协议示例里的占位符原样抄回来时也要丢掉，不能去复制一个字面量。
    expect(attachments.some((attachment) => attachment.path?.startsWith("<"))).toBe(false);
  });

  it("没有附件时不产生 attachments 字段", () => {
    const text = ['```super-agent', '{"tasks":[{"title":"A","task":"任务 A"}]}', "```"].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.blocks[0]?.[0]).not.toHaveProperty("attachments");
  });

  it("未闭合的代码块不算数（等后续 chunk）", () => {
    const scan = extractSuperDirectives(['```super-agent', '{"tasks":[{"title":"A","task":"B"}]}'].join("\n"));
    expect(scan.blocks).toHaveLength(0);
  });

  it("消费偏移量让同一段文本不被二次派发", () => {
    const text = ['```super-agent', '{"tasks":[{"title":"A","task":"B"}]}', "```"].join("\n");
    const first = extractSuperDirectives(text);
    expect(first.blocks).toHaveLength(1);
    const second = extractSuperDirectives(text, first.end);
    expect(second.blocks).toHaveLength(0);
  });

  it("分片到达时逐段扫描最终只派发一次", () => {
    const head = "开始处理。\n```super-agent\n";
    const body = '{"tasks":[{"title":"A","task":"B"}]}';
    const tail = "\n```\n";
    expect(extractSuperDirectives(head).blocks).toHaveLength(0);
    const mid = extractSuperDirectives(head + body);
    expect(mid.blocks).toHaveLength(0); // 还没收栏
    const done = extractSuperDirectives(head + body + tail);
    expect(done.blocks).toHaveLength(1);
    expect(extractSuperDirectives(head + body + tail, done.end).blocks).toHaveLength(0);
  });

  it("标题折叠空白并截断", () => {
    expect(normalizeSuperTitle("  修好   登录  ")).toBe("修好 登录");
    expect(normalizeSuperTitle("x".repeat(60)).length).toBe(40);
    expect(normalizeSuperTitle("")).toBe("子会话");
  });
});

describe("super agent · 状态机", () => {
  it("started → running", () => {
    const next = applySuperEvent(session(), { type: "started", cliSessionId: "s1", at: 2000 });
    expect(next.status).toBe("running");
    expect(next.cliSessionId).toBe("s1");
  });

  it("终态粘性：迟到的事件不改写已完成的子会话", () => {
    const done = applySuperEvent(
      applySuperEvent(session(), { type: "started", cliSessionId: "s1", at: 2000 }),
      { type: "report", report: { state: "ready", summary: "做完了", at: 3000 }, at: 3000 },
    );
    expect(done.status).toBe("completed");
    const late = applySuperEvent(done, { type: "progress", summary: "还在跑", at: 4000 });
    expect(late).toBe(done);
    expect(late.status).toBe("completed");
  });

  it("needs_input → awaiting_input，并带出结构化的人行动请求", () => {
    const next = applySuperEvent(session(), {
      type: "needs_input",
      at: 2000,
      pending: { kind: "question", requestId: "r1", questions: [], deadline: 0 },
    });
    expect(next.status).toBe("awaiting_input");
    expect(next.pending?.kind).toBe("question");
    expect(next.reports.at(-1)?.state).toBe("blocked");
  });

  it("input_resolved 回到 running 并清掉 pending", () => {
    const waiting = applySuperEvent(session(), {
      type: "needs_input",
      at: 2000,
      pending: { kind: "question", requestId: "r1", questions: [], deadline: 0 },
    });
    const next = applySuperEvent(waiting, { type: "input_resolved", at: 3000 });
    expect(next.status).toBe("running");
    expect(next.pending).toBeUndefined();
  });

  it("report 五态映射到子会话状态", () => {
    const base = applySuperEvent(session(), { type: "started", cliSessionId: "s1", at: 1 });
    expect(applySuperEvent(base, { type: "report", report: { state: "progress", summary: "s", at: 2 }, at: 2 }).status).toBe("running");
    expect(applySuperEvent(base, { type: "report", report: { state: "ready", summary: "s", at: 2 }, at: 2 }).status).toBe("completed");
    expect(applySuperEvent(base, { type: "report", report: { state: "blocked", summary: "s", at: 2 }, at: 2 }).status).toBe("awaiting_input");
    expect(applySuperEvent(base, { type: "report", report: { state: "failed", summary: "s", at: 2 }, at: 2 }).status).toBe("failed");
    expect(applySuperEvent(base, { type: "report", report: { state: "dropped", summary: "s", at: 2 }, at: 2 }).status).toBe("cancelled");
  });

  it("失败与中断记录原因", () => {
    expect(applySuperEvent(session(), { type: "failed", error: "boom", at: 1 }).error).toBe("boom");
    expect(applySuperEvent(session(), { type: "cancelled", at: 1 }).status).toBe("cancelled");
  });

  it("终态判定", () => {
    expect(isTerminalSuperStatus("completed")).toBe(true);
    expect(isTerminalSuperStatus("failed")).toBe(true);
    expect(isTerminalSuperStatus("cancelled")).toBe(true);
    expect(isTerminalSuperStatus("running")).toBe(false);
    expect(isTerminalSuperStatus("awaiting_input")).toBe(false);
  });
});

describe("super agent · 意外中断后的重试", () => {
  it("只有 failed / cancelled 可以重试，completed 与进行中都不行", () => {
    expect(canRetrySuperSession(session({ status: "failed" }))).toBe(true);
    expect(canRetrySuperSession(session({ status: "cancelled" }))).toBe(true);
    expect(canRetrySuperSession(session({ status: "completed" }))).toBe(false);
    expect(canRetrySuperSession(session({ status: "running" }))).toBe(false);
    expect(canRetrySuperSession(session({ status: "preparing" }))).toBe(false);
    expect(canRetrySuperSession(session({ status: "awaiting_input" }))).toBe(false);
  });

  it("重试把终态残留清掉，保留隔离环境与汇报历史", () => {
    const failed = applySuperEvent(session({ attempts: 1 }), {
      type: "failed",
      error: "子会话内核退出（code=1）",
      at: 2000,
    });
    const next = retrySuperSession(failed, 3000);

    expect(next.status).toBe("preparing");
    expect(next.queued).toBe(true);
    expect(next.attempts).toBe(2);
    expect(next.error).toBeUndefined();
    expect(next.summary).toBeUndefined();
    expect(next.endedAt).toBeUndefined();
    expect(next.startedAt).toBeUndefined();
    expect(next.integration).toBeUndefined();
    // 同一个记录、同一套隔离环境 —— worktree 里可能有上次没提交的工作。
    expect(next.id).toBe(failed.id);
    expect(next.isolation).toEqual(failed.isolation);
    // 审计轨迹保留：失败记录还在，末尾追加一条重试记录。
    expect(next.reports.length).toBe(failed.reports.length + 1);
    expect(next.reports.at(-1)?.summary).toContain("第 2 次");
  });

  it("首次执行没有 attempts 时按 1 计", () => {
    const failed = applySuperEvent(session(), { type: "failed", error: "boom", at: 2000 });
    expect(retrySuperSession(failed, 3000).attempts).toBe(2);
  });
});

describe("super agent · 汇报", () => {
  it("完成后推导出 ready 报告", () => {
    const done = applySuperEvent(
      session(),
      { type: "report", report: { state: "ready", summary: "改完了", at: 10 }, at: 10 },
    );
    const report = reportForSession(done, 20, "fallback");
    expect(report?.state).toBe("ready");
    expect(report?.summary).toBe("改完了");
  });

  it("等待应答时推导出 blocked 报告并带人行动描述", () => {
    const waiting = applySuperEvent(session(), {
      type: "needs_input",
      at: 10,
      pending: { kind: "question", requestId: "r", questions: [], deadline: 0 },
    });
    const report = reportForSession(waiting, 20, "fallback");
    expect(report?.state).toBe("blocked");
    expect(report?.humanAction).toBeTruthy();
  });

  it("运行中的子会话没有需要上报的报告", () => {
    const running = applySuperEvent(session(), { type: "started", cliSessionId: "s", at: 1 });
    expect(reportForSession(running, 2, "x")).toBeNull();
  });

  it("汇报提示词带上子会话标题与状态", () => {
    const text = buildSuperReportPrompt([
      { session: session({ status: "completed" }), report: { state: "ready", summary: "改完了", at: 1 } },
    ]);
    expect(text).toContain("修复登录跳转");
    expect(text).toContain("改完了");
    expect(text).toContain("已完成");
  });

  it("空汇报不产出提示词", () => {
    expect(buildSuperReportPrompt([])).toBe("");
  });

  it("汇报提示词要求主会话自行处理、仅在疑惑时提问、最后完整汇报", () => {
    const text = buildSuperReportPrompt([
      { session: session({ status: "completed" }), report: { state: "ready", summary: "改完了", at: 1 } },
    ]);
    expect(text).toContain("自行处理");
    expect(text).toContain("完整汇报");
    expect(text).toContain("都已结束");
    expect(text).toContain("不要编造");
  });
});

describe("super agent · 合并汇报", () => {
  it("只有全部子会话进入终态才算结束", () => {
    expect(allSuperSessionsSettled([])).toBe(false);
    expect(allSuperSessionsSettled([session({ status: "running" })])).toBe(false);
    expect(allSuperSessionsSettled([session({ status: "awaiting_input" })])).toBe(false);
    expect(
      allSuperSessionsSettled([
        session({ id: "a", status: "completed" }),
        session({ id: "b", status: "failed" }),
        session({ id: "c", status: "cancelled" }),
      ]),
    ).toBe(true);
  });

  it("未全部结束前不产出汇报批次", () => {
    const buffer = new SuperReportBuffer();
    buffer.add([
      { session: session({ id: "b", status: "completed" }), report: { state: "ready", summary: "b 完成", at: 1 } },
    ]);
    expect(buffer.takeSettled([session({ id: "a", status: "running" }), session({ id: "b", status: "completed" })])).toBeNull();
  });

  it("全部结束后一次性取走所有子会话的最后一条汇报", () => {
    const buffer = new SuperReportBuffer();
    buffer.add([
      { session: session({ id: "b", status: "completed" }), report: { state: "ready", summary: "b 完成", at: 1 } },
    ]);
    buffer.add([
      { session: session({ id: "a", status: "completed" }), report: { state: "ready", summary: "a 完成", at: 2 } },
    ]);
    const batch = buffer.takeSettled([
      session({ id: "a", status: "completed" }),
      session({ id: "b", status: "completed" }),
    ]);
    expect(batch?.map((entry) => entry.session.id)).toEqual(["b", "a"]);
    expect(batch?.[0]?.report.summary).toBe("b 完成");
    // 取走后缓冲区清空，不会重复转述。
    expect(
      buffer.takeSettled([
        session({ id: "a", status: "completed" }),
        session({ id: "b", status: "completed" }),
      ]),
    ).toBeNull();
  });

  it("同一子会话只保留最后一条汇报（blocked 被 ready 覆盖）", () => {
    const buffer = new SuperReportBuffer();
    buffer.add([
      { session: session({ id: "a", status: "awaiting_input" }), report: { state: "blocked", summary: "等待回答", at: 1 } },
    ]);
    buffer.add([
      { session: session({ id: "a", status: "completed" }), report: { state: "ready", summary: "已完成", at: 2 } },
    ]);
    const batch = buffer.takeSettled([session({ id: "a", status: "completed" })]);
    expect(batch).toHaveLength(1);
    expect(batch?.[0]?.report.state).toBe("ready");
  });

  it("看板计数", () => {
    const summary = summarizeSuperSessions([
      session({ id: "a", status: "running" }),
      session({ id: "b", status: "preparing" }),
      session({ id: "c", status: "awaiting_input" }),
      session({ id: "d", status: "completed" }),
      session({ id: "e", status: "failed" }),
      session({ id: "f", status: "cancelled" }),
    ]);
    expect(summary).toEqual({ total: 6, running: 2, awaiting: 1, done: 1, failed: 2 });
  });
});

describe("super agent · token 用量", () => {
  it("结算用量可以补记在终态会话上（不经过状态机）", () => {
    const done = applySuperEvent(
      session(),
      { type: "report", report: { state: "ready", summary: "改完了", at: 10 }, at: 10 },
    );
    expect(isTerminalSuperStatus(done.status)).toBe(true);
    const withTokens = withUsage(
      done,
      { input: 1200, output: 300, cachedRead: 100, estimatedCost: 0.0018, authoritative: true },
      20,
    );
    expect(withTokens.status).toBe("completed");
    expect(withTokens.tokens?.input).toBe(1200);
    expect(withTokens.tokens?.output).toBe(300);
    expect(withTokens.tokens?.cachedRead).toBe(100);
    expect(withTokens.tokens?.estimatedCost).toBeCloseTo(0.0018);
    expect(withTokens.updatedAt).toBe(20);
  });

  it("合计只统计产生了用量的子会话", () => {
    const totals = sumSuperUsage([
      session({ id: "a", tokens: { input: 1000, output: 100, estimatedCost: 0.001 } }),
      session({ id: "b", tokens: { input: 500, output: 50, estimatedCost: 0.0005 } }),
      session({ id: "c" }),
    ]);
    expect(totals.input).toBe(1500);
    expect(totals.output).toBe(150);
    expect(totals.estimatedCost).toBeCloseTo(0.0015);
  });

  it("混入无单价的子会话时合计成本不显示（不给偏小的总数）", () => {
    const totals = sumSuperUsage([
      session({ id: "a", tokens: { input: 1000, output: 100, estimatedCost: 0.001 } }),
      session({ id: "b", tokens: { input: 500, output: 50, estimatedCost: null } }),
    ]);
    expect(totals.input).toBe(1500);
    expect(totals.estimatedCost).toBeNull();
  });
});
