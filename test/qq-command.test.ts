import { describe, expect, it } from "vitest";
import {
  buildQqHelpText,
  formatAck,
  normalizeCommandText,
  parseQqCommand,
  type QqCommandErrorCode,
  type QqCommandIntent,
} from "../shared/qq-command.js";

/** 断言解析成功并取出意图（失败时给出可读的失败原因）。 */
function parseOk(raw: string): QqCommandIntent {
  const parsed = parseQqCommand(raw);
  if (!parsed.ok) {
    throw new Error(`预期解析成功，实际失败：${parsed.code} ${parsed.message}（输入：${JSON.stringify(raw)}）`);
  }
  return parsed.intent;
}

/** 断言解析失败并取出错误码。 */
function parseErr(raw: string): { code: QqCommandErrorCode; message: string } {
  const parsed = parseQqCommand(raw);
  if (parsed.ok) {
    throw new Error(`预期解析失败，实际成功：${JSON.stringify(parsed.intent)}（输入：${JSON.stringify(raw)}）`);
  }
  return { code: parsed.code, message: parsed.message };
}

/** 全部子命令（帮助文本必须逐个覆盖）。 */
const ALL_SUBCOMMANDS = [
  "task",
  "status",
  "result",
  "diff",
  "stop",
  "approve",
  "deny",
  "answer",
  "merge",
  "discard",
  "unbind",
  "help",
] as const;

// ---------------------------------------------------------------------------
// 每个意图至少一例
// ---------------------------------------------------------------------------

describe("parseQqCommand / 基础意图", () => {
  it("task 取整段原文作为提示词", () => {
    expect(parseOk("/qq task 修复登录页的空指针")).toEqual({
      kind: "task",
      prompt: "修复登录页的空指针",
    });
  });

  it("task 提示词保留内部连续空格与空行，只去首尾空白", () => {
    expect(parseOk("/qq task   修复  登录\n\n并补测试   ")).toEqual({
      kind: "task",
      prompt: "修复  登录\n\n并补测试",
    });
  });

  it("status 无参数", () => {
    expect(parseOk("/qq status")).toEqual({ kind: "status" });
  });

  it("status 带任务编号", () => {
    expect(parseOk("/qq status T-abc123")).toEqual({ kind: "status", taskId: "T-abc123" });
  });

  it("按任务编号的子命令（result / diff / stop / merge / discard / deny）", () => {
    const cases: Array<[string, string]> = [
      ["result", "result"],
      ["diff", "diff"],
      ["stop", "stop"],
      ["merge", "merge"],
      ["discard", "discard"],
      ["deny", "deny"],
    ];
    for (const [word, kind] of cases) {
      expect(parseOk(`/qq ${word} T-1`)).toEqual({ kind, taskId: "T-1" });
    }
  });

  it("approve 无验证码", () => {
    expect(parseOk("/qq approve T-1")).toEqual({ kind: "approve", taskId: "T-1" });
  });

  it("approve 带验证码", () => {
    expect(parseOk("/qq approve T-1 A1b2")).toEqual({
      kind: "approve",
      taskId: "T-1",
      code: "A1b2",
    });
  });

  it("answer 带任务编号与回答正文", () => {
    expect(parseOk("/qq answer T-1 用方案 B")).toEqual({
      kind: "answer",
      taskId: "T-1",
      text: "用方案 B",
    });
  });

  it("bind 已不是子命令（配对码机制随授权模型移除）", () => {
    expect(parseErr("/qq bind A1b2").code).toBe("unknown_subcommand");
    // 注意 `unbind` 含 `bind` 子串：按「行首命令词」判断，别用 includes。
    expect(buildQqHelpText()).not.toMatch(/^\s+bind\s/mu);
  });

  it("unbind 无参数", () => {
    expect(parseOk("/qq unbind")).toEqual({ kind: "unbind" });
  });

  it("help 与裸 /qq 都返回 help", () => {
    expect(parseOk("/qq help")).toEqual({ kind: "help" });
    expect(parseOk("/qq")).toEqual({ kind: "help" });
    expect(parseOk("/qq   ")).toEqual({ kind: "help" });
  });

  it("子命令与命令前缀大小写不敏感", () => {
    expect(parseOk("/QQ STATUS T-9")).toEqual({ kind: "status", taskId: "T-9" });
    expect(parseOk("/Qq TaSk 修一下")).toEqual({ kind: "task", prompt: "修一下" });
  });
});

// ---------------------------------------------------------------------------
// 别名
// ---------------------------------------------------------------------------

describe("parseQqCommand / 别名", () => {
  it("log / state 映射到 status", () => {
    expect(parseOk("/qq log")).toEqual({ kind: "status" });
    expect(parseOk("/qq log T-2")).toEqual({ kind: "status", taskId: "T-2" });
    expect(parseOk("/qq state T-2")).toEqual({ kind: "status", taskId: "T-2" });
  });

  it("resend 映射到 result", () => {
    expect(parseOk("/qq resend T-3")).toEqual({ kind: "result", taskId: "T-3" });
  });

  it("cancel 映射到 stop", () => {
    expect(parseOk("/qq cancel T-4")).toEqual({ kind: "stop", taskId: "T-4" });
  });

  it("中文别名", () => {
    expect(parseOk("/qq 状态 T-5")).toEqual({ kind: "status", taskId: "T-5" });
    expect(parseOk("/qq 结果 T-5")).toEqual({ kind: "result", taskId: "T-5" });
    expect(parseOk("/qq 停止 T-5")).toEqual({ kind: "stop", taskId: "T-5" });
    expect(parseOk("/qq 帮助")).toEqual({ kind: "help" });
  });
});

// ---------------------------------------------------------------------------
// 错误码
// ---------------------------------------------------------------------------

describe("parseQqCommand / not_a_command", () => {
  it("普通文本与近似前缀都不是命令", () => {
    for (const input of ["", "   ", "hello", "qq status", "/qqq status", "/qq-status", "@机器人 你好"]) {
      expect(parseErr(input).code).toBe("not_a_command");
    }
  });
});

describe("parseQqCommand / unknown_subcommand", () => {
  it("未知子命令带出原词", () => {
    const err = parseErr("/qq fly T-1");
    expect(err.code).toBe("unknown_subcommand");
    expect(err.message).toContain("fly");
  });
});

describe("parseQqCommand / missing_arg", () => {
  it("task 缺少任务描述", () => {
    expect(parseErr("/qq task").code).toBe("missing_arg");
    expect(parseErr("/qq task    ").code).toBe("missing_arg");
    expect(parseErr("/qq task\n\n").code).toBe("missing_arg");
  });

  it("按任务编号的子命令缺少编号", () => {
    for (const word of ["result", "diff", "stop", "approve", "deny", "answer", "merge", "discard"]) {
      expect(parseErr(`/qq ${word}`).code).toBe("missing_arg");
    }
  });

  it("answer 缺少回答正文", () => {
    expect(parseErr("/qq answer T-1").code).toBe("missing_arg");
  });
});

describe("parseQqCommand / too_many_args", () => {
  it("非 task / answer 子命令的多余参数被拒绝", () => {
    const cases = [
      "/qq status T-1 T-2",
      "/qq result T-1 T-2",
      "/qq diff T-1 T-2",
      "/qq stop T-1 T-2",
      "/qq deny T-1 T-2",
      "/qq merge T-1 T-2",
      "/qq discard T-1 T-2",
      "/qq approve T-1 CODE EXTRA",
      "/qq unbind x",
      "/qq help x",
    ];
    for (const input of cases) {
      expect(parseErr(input).code).toBe("too_many_args");
    }
  });

  it("answer 的多余参数属于回答正文，不是错误", () => {
    expect(parseOk("/qq answer T-1 先跑 单测 再合并")).toEqual({
      kind: "answer",
      taskId: "T-1",
      text: "先跑 单测 再合并",
    });
  });
});

describe("parseQqCommand / 配对码已移除", () => {
  it("任何 /qq bind 形态都只回未知子命令（没有格式校验分支）", () => {
    for (const code of ["A1b2", "abc", "abcdefghijk", "A1_b2"]) {
      expect(parseErr(`/qq bind ${code}`).code).toBe("unknown_subcommand");
    }
    expect(parseErr("/qq bind").code).toBe("unknown_subcommand");
  });
});

// ---------------------------------------------------------------------------
// 归一化（@ 提及 / 空白）
// ---------------------------------------------------------------------------

describe("normalizeCommandText", () => {
  it("剥掉行首 @ 提及并合并多余空白", () => {
    expect(normalizeCommandText("  @机器人   /qq    log  ")).toBe("/qq log");
  });

  it("只剥开头一个提及标记，双标记残留按非命令处理", () => {
    expect(normalizeCommandText("@bot @user /qq status")).toBe("@user /qq status");
    expect(parseErr("@bot @user /qq status").code).toBe("not_a_command");
  });

  it("保留换行，只合并行内空白", () => {
    expect(normalizeCommandText("/qq task 第一行\n\n第二行")).toBe("/qq task 第一行\n\n第二行");
    expect(normalizeCommandText("  /qq   task   第一行\t第二行  ")).toBe("/qq task 第一行 第二行");
  });

  it("统一 CRLF 为 LF", () => {
    expect(normalizeCommandText("/qq task a\r\nb")).toBe("/qq task a\nb");
  });
});

describe("parseQqCommand / 提及剥离后的解析", () => {
  it("@ 提及前缀不妨碍解析", () => {
    expect(parseOk("@机器人 /qq status T-7")).toEqual({ kind: "status", taskId: "T-7" });
  });

  it("任务提示词保留原文空行与行内连续空格", () => {
    expect(parseOk("/qq task 修复  登录\n\n补测试")).toEqual({
      kind: "task",
      prompt: "修复  登录\n\n补测试",
    });
  });
});

// ---------------------------------------------------------------------------
// 帮助文本
// ---------------------------------------------------------------------------

describe("buildQqHelpText", () => {
  it("包含用法与全部子命令", () => {
    const help = buildQqHelpText();
    expect(help).toContain("用法");
    for (const sub of ALL_SUBCOMMANDS) {
      expect(help).toContain(sub);
    }
    expect(help).toContain("别名");
  });

  it("是纯文本，不含 Markdown 标记", () => {
    const help = buildQqHelpText();
    expect(help).not.toMatch(/^#{1,6}\s/mu);
    expect(help).not.toContain("|");
    expect(help).not.toContain("```");
    expect(help).not.toContain("**");
    expect(help.split("\n").every((line) => !line.trimStart().startsWith("#"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 确认文案
// ---------------------------------------------------------------------------

describe("formatAck", () => {
  it("每个意图都有非空确认文案，且不编造任务编号", () => {
    const intents: QqCommandIntent[] = [
      { kind: "task", prompt: "x" },
      { kind: "status" },
      { kind: "status", taskId: "T-1" },
      { kind: "result", taskId: "T-1" },
      { kind: "diff", taskId: "T-1" },
      { kind: "stop", taskId: "T-1" },
      { kind: "approve", taskId: "T-1" },
      { kind: "approve", taskId: "T-1", code: "A1b2" },
      { kind: "deny", taskId: "T-1" },
      { kind: "answer", taskId: "T-1", text: "x" },
      { kind: "merge", taskId: "T-1" },
      { kind: "discard", taskId: "T-1" },
      { kind: "unbind" },
      { kind: "help" },
    ];
    for (const intent of intents) {
      const ack = formatAck(intent);
      expect(ack.length).toBeGreaterThan(0);
      expect(ack).not.toContain("T-");
    }
  });

  it("task 的确认文案说明已收到、排队中", () => {
    expect(formatAck({ kind: "task", prompt: "x" })).toContain("排队");
  });
});
