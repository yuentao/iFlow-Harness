import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  allSuperSessionsSettled,
  applySuperEvent,
  buildSuperActionReceiptPrompt,
  buildSuperDigest,
  buildSuperMergeRequestPrompt,
  buildSuperReportPrompt,
  canRetrySuperSession,
  capReportTail,
  clampMaxConcurrentSuperSessions,
  DEFAULT_MAX_CONCURRENT_SUPER_SESSIONS,
  describeSuperSessionLine,
  extractSuperActions,
  extractSuperDirectives,
  fromPersistedSuperSession,
  groupSuperSessionsForBoard,
  isTerminalSuperStatus,
  MAX_CONCURRENT_SUPER_SESSIONS,
  MAX_SUPER_ACTIONS,
  MAX_SUPER_ATTACHMENTS,
  MAX_SUPER_SCAN_BUFFER_CHARS,
  normalizeSuperTitle,
  normalizeSuperTodos,
  reportForSession,
  retrySuperSession,
  salvageSuperTasks,
  splitSuperDirectiveSegments,
  summarizeSuperSessions,
  superArchiveFingerprint,
  superDirectiveDedupeKey,
  superIsolationLabel,
  SUPER_BOARD_SUMMARY_MAX_CHARS,
  SUPER_DIGEST_MAX_CHARS,
  SUPER_REPORT_SUMMARY_MAX_CHARS,
  sumSuperUsage,
  SuperReportBuffer,
  SuperDirectiveScanner,
  toPersistedSuperSession,
  withUsage,
  type PersistedSuperSession,
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

  // 实测（2026-11-11）：模型写长任务书时常把正文按原始换行铺开（而不是 JSON
  // 的 \n 转义），任务书自己就带一段 markdown 代码围栏。旧实现把「第一行 ```」
  // 当收栏，载荷被拦腰截断，整块判非法、委派静默不生效。
  it("任务书里自带代码围栏，不会被当成收栏截断", () => {
    const expected = ["第一步：读代码", "```", "npm test", "```", "第二步：改实现"].join("\n");
    const text = [
      "```super-agent",
      '{"tasks":[{"title":"带围栏的任务书","task":"第一步：读代码',
      "```",
      "npm test",
      "```",
      '第二步：改实现"}]}',
      "```",
    ].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.invalidBlocks).toHaveLength(0);
    expect(scan.blocks).toHaveLength(1);
    expect(scan.blocks[0]?.[0]?.task).toBe(expected);
  });

  it("任务书里的转义双引号与原始换行都能解析", () => {
    const text = [
      "```super-agent",
      '{"tasks":[{"title":"引号","task":"他说：\\"先跑测试\\"，然后',
      '第二行继续"}]}',
      "```",
    ].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.invalidBlocks).toHaveLength(0);
    expect(scan.blocks[0]?.[0]?.task).toBe('他说："先跑测试"，然后\n第二行继续');
  });

  it("超长任务书（约 3 万字符）仍能解析", () => {
    const lines = Array.from(
      { length: 600 },
      (_, i) => `第 ${i + 1} 步：读 src/panel/panel.ts 并核对第 ${i + 1} 处调用点，确认参数与返回值一致`,
    );
    const expected = lines.join("\n");
    expect(expected.length).toBeGreaterThan(29_000);
    const text = ["```super-agent", `{"tasks":[{"title":"长任务","task":"${expected}"}]}`, "```"].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.invalidBlocks).toHaveLength(0);
    expect(scan.blocks[0]?.[0]?.task).toBe(expected);
  });

  // 实测（2026-11-11）：任务书正文里出现「只由三个反引号组成的一行」（JSON 里是
  // \n 转义）时，收栏定位不能被这段正文骗走。
  it("任务书里含只由三个反引号组成的行（JSON 转义换行）仍能解析", () => {
    const expected = ["步骤一", "```", "代码", "```", "步骤二"].join("\n");
    const payload = '{"tasks":[{"title":"t","task":"步骤一\\n```\\n代码\\n```\\n步骤二"}]}';
    // 载荷本身就是合法 JSON：\n 是转义序列，正文里没有真实的换行。
    expect(payload).not.toContain("\n");
    const text = ["```super-agent", payload, "```"].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.invalidBlocks).toHaveLength(0);
    expect(scan.blocks).toHaveLength(1);
    expect(scan.blocks[0]?.[0]?.title).toBe("t");
    expect(scan.blocks[0]?.[0]?.task).toBe(expected);
  });

  it("任务书里含 JSON 转义双引号时仍能解析", () => {
    const payload = '{"tasks":[{"title":"quoted","task":"He said \\"hi\\" then left"}]}';
    const text = ["```super-agent", payload, "```"].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.invalidBlocks).toHaveLength(0);
    expect(scan.blocks).toHaveLength(1);
    expect(scan.blocks[0]?.[0]?.task).toBe('He said "hi" then left');
  });

  it("约 3 万字符的任务书仍能解析（合法 JSON 载荷）", () => {
    const lines = Array.from(
      { length: 600 },
      (_, i) => `第 ${i + 1} 步：读 src/panel/panel.ts 并核对第 ${i + 1} 处调用点，确认参数与返回值一致`,
    );
    const expected = lines.join("\n");
    expect(expected.length).toBeGreaterThan(29_000);
    const payload = JSON.stringify({ tasks: [{ title: "长任务", task: expected }] });
    const text = ["```super-agent", payload, "```"].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.invalidBlocks).toHaveLength(0);
    expect(scan.blocks).toHaveLength(1);
    expect(scan.blocks[0]?.[0]?.task).toBe(expected);
  });

  it("非法转义与尾逗号会被修复后解析", () => {
    const text = [
      "```super-agent",
      '{"tasks":[{"title":"路径","task":"改 C:\\Program Files\\app\\main.ts 的构建脚本",},]}',
      "```",
    ].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.invalidBlocks).toHaveLength(0);
    expect(scan.blocks[0]?.[0]?.task).toBe("改 C:\\Program Files\\app\\main.ts 的构建脚本");
  });

  it("非法块带上失败原因与正文长度（宿主据此提示）", () => {
    const scan = extractSuperDirectives(["```super-agent", "{not json}", "```"].join("\n"));
    expect(scan.invalidBlocks).toHaveLength(1);
    expect(scan.invalidBlocks[0]?.reason).toBeTruthy();
    expect(scan.invalidBlocks[0]?.body).toBe("{not json}");
  });

  it("未闭合期间带 pendingOpen 续扫，收栏后只派发一次", () => {
    const head = "开始处理。\n```super-agent\n";
    const body = '{"tasks":[{"title":"A","task":"B"}]}';
    const first = extractSuperDirectives(head + body);
    expect(first.blocks).toHaveLength(0);
    expect(first.pendingOpen?.lineStart).toBe(head.indexOf("```super-agent"));
    const full = head + body + "\n```\n";
    const done = extractSuperDirectives(full, first.end, first.pendingOpen);
    expect(done.blocks).toHaveLength(1);
    expect(done.pendingOpen).toBeUndefined();
    const again = extractSuperDirectives(full, done.end, done.pendingOpen);
    expect(again.blocks).toHaveLength(0);
  });

  // 实测（2026-11-11）：流式中间态里 JSON 还没收全，而任务书正文自带一行独占的
  // 三个反引号。旧实现会把这行当收栏，把半截 JSON 当 closed 消费掉，后续 chunk
  // 补齐的载荷永远扫不回来（委派被静默吞掉）。
  it("流式：JSON 未收全 + 正文已含独占围栏行 → 不判非法，继续等收栏", () => {
    const head = "开始处理。\n```super-agent\n";
    const partial = [
      '{"tasks":[{"title":"带围栏的任务书","task":"第一步：读代码',
      "```",
      "npm test",
      "```",
    ].join("\n");
    const scan = extractSuperDirectives(head + partial);
    expect(scan.blocks).toHaveLength(0);
    expect(scan.invalidBlocks).toHaveLength(0);
    expect(scan.pendingOpen).toBeDefined();
    expect(scan.pendingOpen?.lineStart).toBe(head.indexOf("```super-agent"));
  });

  it("流式：补齐后的载荷从断点续扫，能派发且不判非法", () => {
    const head = "开始处理。\n```super-agent\n";
    const partial = [
      '{"tasks":[{"title":"带围栏的任务书","task":"第一步：读代码',
      "```",
      "npm test",
      "```",
    ].join("\n");
    const first = extractSuperDirectives(head + partial);
    const full = `${head}${partial}\n第二步：改实现"}]}\n\`\`\`\n`;
    const done = extractSuperDirectives(full, first.end, first.pendingOpen);
    expect(done.blocks).toHaveLength(1);
    expect(done.invalidBlocks).toHaveLength(0);
    expect(done.pendingOpen).toBeUndefined();
  });

  it("标题折叠空白并截断", () => {
    expect(normalizeSuperTitle("  修好   登录  ")).toBe("修好 登录");
    expect(normalizeSuperTitle("x".repeat(60)).length).toBe(40);
    expect(normalizeSuperTitle("")).toBe("子会话");
  });
});

describe("super agent · 工具调用式委派载荷", () => {
  // 实测（2026-11-10）：sensenova-6.8-flash-lite 不按 markdown 围栏块输出，
  // 而是写成工具调用语法，载荷本身仍是合法的 tasks JSON。
  const dsml = [
    "我来把这两件工作分别委派给两个独立的子会话并行执行。",
    "",
    "<｜DSML｜tool-super-agent>",
    '{"tasks":[{"title":"编写模块A设计说明","task":"新建 docs/alpha.md"},{"title":"编写模块B设计说明","task":"新建 docs/beta.md"}]}',
    "</tool-super-agent>",
  ].join("\n");

  it("工具调用式载荷也能解析出任务", () => {
    const scan = extractSuperDirectives(dsml);
    expect(scan.blocks).toHaveLength(1);
    expect(scan.blocks[0]).toHaveLength(2);
    expect(scan.blocks[0]?.[0]?.title).toBe("编写模块A设计说明");
    expect(scan.blocks[0]?.[1]?.task).toBe("新建 docs/beta.md");
    expect(scan.invalidBlocks).toHaveLength(0);
  });

  it("工具调用式载荷消费过的偏移量同样防止二次派发", () => {
    const first = extractSuperDirectives(dsml);
    expect(first.end).toBeGreaterThan(0);
    expect(extractSuperDirectives(dsml, first.end).blocks).toHaveLength(0);
  });

  it("围栏块与工具调用式载荷各派发一次，不重复", () => {
    const text = [
      "```super-agent",
      '{"tasks":[{"title":"围栏任务","task":"围栏里的任务"}]}',
      "```",
      "",
      "<｜DSML｜tool-super-agent>",
      '{"tasks":[{"title":"工具任务","task":"工具调用里的任务"}]}',
      "</tool-super-agent>",
    ].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.blocks).toHaveLength(2);
    expect(scan.blocks[0]?.[0]?.title).toBe("围栏任务");
    expect(scan.blocks[1]?.[0]?.title).toBe("工具任务");
  });

  it("参数包装体形态也能解析", () => {
    const text = [
      "<tool_call>",
      '{"name":"super-agent","arguments":{"tasks":[{"title":"A","task":"任务 A"}]}}',
      "</tool_call>",
    ].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.blocks[0]?.[0]).toEqual({ title: "A", task: "任务 A" });
  });

  it("super-agent-actions 动作块不会被当成委派载荷", () => {
    const text = [
      "```super-agent-actions",
      '{"actions":[{"action":"retry","sessionId":"super-1"}]}',
      "```",
    ].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.blocks).toHaveLength(0);
    expect(scan.invalidBlocks).toHaveLength(0);
  });

  it("工具调用式载荷里的占位符任务不派发", () => {
    const text = [
      "<｜DSML｜tool-super-agent>",
      '{"tasks":[{"title":"<标题>","task":"<自包含的任务说明>"}]}',
      "</tool-super-agent>",
    ].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.blocks).toHaveLength(0);
  });

  it("工具调用式载荷内容非法时进 invalidBlocks（宿主据此提示用户）", () => {
    const text = ["<｜DSML｜tool-super-agent>", '{"tasks":[{"title":"A"}]}', "</tool-super-agent>"].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.blocks).toHaveLength(0);
    expect(scan.invalidBlocks).toHaveLength(1);
  });

  it("载荷没收全时不派发，收全后只派发一次", () => {
    const head = "<｜DSML｜tool-super-agent>\n";
    const body = '{"tasks":[{"title":"A","task":"任务 A"}]}';
    expect(extractSuperDirectives(head).blocks).toHaveLength(0);
    const mid = extractSuperDirectives(head + body);
    expect(mid.blocks).toHaveLength(1);
    expect(extractSuperDirectives(head + body, mid.end).blocks).toHaveLength(0);
  });

  it("与 super-agent 无关的 JSON 不会被误派发", () => {
    const scan = extractSuperDirectives('普通文本里的 {"tasks":[{"title":"A","task":"真的任务"}]} 与 super-agent 无关');
    expect(scan.blocks).toHaveLength(0);
  });
});

describe("super agent · 重复派发与载荷丢失", () => {
  // 实测：助手在围栏之前的散文里写一句「I'll use super-agent:」。旧实现的互斥
  // 判据只看标记位置（标记落在围栏跨度之外），同一份载荷于是被围栏路径与工具
  // 调用式路径各派发一次：宿主开两个子会话、双倍 token、转录出两张重复卡。
  it("散文里的 super-agent 标记 + 后面的围栏块：只派发一次", () => {
    const text = [
      "好的，我来委派。I'll use super-agent:",
      "```super-agent",
      '{"tasks":[{"title":"改登录","task":"修好 src/auth.ts"}]}',
      "```",
    ].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.blocks).toHaveLength(1);
    expect(scan.blocks[0]).toEqual([{ title: "改登录", task: "修好 src/auth.ts" }]);
  });

  it("同一条委派写成围栏 + 工具调用式两份：也只派发一次", () => {
    const payload = '{"tasks":[{"title":"A","task":"任务 A"}]}';
    const text = [
      "```super-agent",
      payload,
      "```",
      "",
      "<｜DSML｜tool-super-agent>",
      payload,
      "</tool-super-agent>",
    ].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.blocks).toHaveLength(1);
    expect(scan.blocks[0]?.[0]?.title).toBe("A");
  });

  // 实测：工具调用式扫描在第一个标记后 80 字符内找不到 { 时直接 break，后面
  // 的载荷被静默吞掉：既不派发也不报错，用户以为派了其实没有。
  it("标记后 80 字符内没有载荷：后面的载荷不被吞掉", () => {
    const preamble =
      "我先说明一下接下来的安排与分工，这段铺垫话故意写得很长，长到标记与后面的载荷之间已经超过了八十个字符的间隔，所以工具调用式扫描在第一个标记后找不到载荷起点。";
    const text = [
      `super-agent: ${preamble}${preamble}`,
      "<｜DSML｜tool-super-agent>",
      '{"tasks":[{"title":"B","task":"任务 B"}]}',
      "</tool-super-agent>",
    ].join("\n");
    // 前置条件：第一个标记到载荷起点的距离确实超过 80 字符的间隔。
    expect(text.indexOf("{")).toBeGreaterThan(text.indexOf("super-agent") + 90);
    const scan = extractSuperDirectives(text);
    expect(scan.blocks).toHaveLength(1);
    expect(scan.blocks[0]?.[0]?.title).toBe("B");
  });

  it("散文里的标记后没有载荷：不误派发，也不吞掉后面的围栏块", () => {
    const text = [
      "super-agent: 这段话里没有载荷，只是随口提了一嘴。",
      "```super-agent",
      '{"tasks":[{"title":"C","task":"任务 C"}]}',
      "```",
    ].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.blocks).toHaveLength(1);
    expect(scan.blocks[0]?.[0]?.title).toBe("C");
  });
});

describe("super agent · 子会话任务书的如实描述", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const brief = readFileSync(path.join(here, "..", "prompts", "super-agent-task.md"), "utf8");

  it("不再宣称宿主会拒绝危险命令", () => {
    // 真实实现：子会话跑在 yolo 模式，CLI 通常根本不发权限请求，依赖护栏只是
    // 基于命令文本关键词的兜底（还能被 `node -e "..."` 这类写法绕过）。
    // 提示词却宣称「宿主会拒绝这类命令」—— 模型据此以为有安全网，就敢写危险
    // 命令。这条断言钉住「不许再吹这个牛」。
    expect(brief).not.toContain("The host refuses commands that would damage the main workspace");
  });

  it("如实说明宿主不拦截工具调用、护栏只是关键词兜底", () => {
    expect(brief).toContain("does **not** intercept your tool calls");
    expect(brief).toContain("keyword-based guard");
    expect(brief).toContain("can be bypassed");
    // 兜底自己：约束落在模型身上。
    expect(brief).toContain("**You** are the guard here");
  });
});

describe("super agent · 流式扫描缓冲有界", () => {
  it("长时间流式输入下扫描缓冲不无界增长", () => {
    const scanner = new SuperDirectiveScanner();
    const chunk = "普通叙述段落，用来把扫描缓冲撑起来，长度足够长以至于缓冲会明显增长。".repeat(4);
    for (let i = 0; i < 200; i++) {
      scanner.push(`${chunk}（第 ${i} 段）`);
    }
    // 扫过又没有指令的前缀是死区：扫完就该丢掉，缓冲不能随会话长度增长。
    expect(scanner.bufferLength).toBeLessThan(1024);
    expect(scanner.bufferLength).toBeLessThanOrEqual(MAX_SUPER_SCAN_BUFFER_CHARS);
  });

  it("裁剪缓冲不影响后续派发", () => {
    const scanner = new SuperDirectiveScanner();
    for (let i = 0; i < 50; i++) scanner.push(`普通叙述 ${i}。`);
    const scan = scanner.push(
      ['```super-agent', '{"tasks":[{"title":"A","task":"任务 A"}]}', "```"].join("\n"),
    );
    expect(scan.blocks).toHaveLength(1);
    expect(scan.blocks[0]?.[0]?.title).toBe("A");
  });

  it("正在写的围栏不会被裁掉（载荷下一块才到）", () => {
    const scanner = new SuperDirectiveScanner();
    scanner.push("```super-agent\n");
    scanner.push('{"tasks":[{"title":"A","task":"任务 A"}]}');
    const scan = scanner.push("\n```\n");
    expect(scan.blocks).toHaveLength(1);
    expect(scan.blocks[0]?.[0]?.title).toBe("A");
  });

  // 标记被切成两半：这一帧结尾只有 "``"，下一帧才是 "`super-agent"。扫描只看
  // 得到完整标记 —— 如果把扫过的前缀整个丢掉，标记的前半截也跟着没了，下一
  // 帧补齐也认不出来（委派静默丢失）。
  //
  // 载荷离标记足够远（超过工具调用式路径的 80 字符间隔），于是只有围栏路径能
  // 认出来：这条用例真正盯的是「围栏标记的前半截有没有被裁掉」。
  it("围栏开栏被切成两半时不会丢失", () => {
    const scanner = new SuperDirectiveScanner();
    scanner.push("叙述文字。\n``");
    // 围栏正文前面垫一大段空白：载荷离「super-agent」标记超过 80 字符，于是
    // 工具调用式那条兜底路径够不着它 —— 只有「围栏开栏的前半截没被裁掉」这条
    // 围栏路径能派发出来。这条用例真正盯的就是尾巴保护。
    const pad = " ".repeat(120);
    const scan = scanner.push(
      `\`super-agent\n${pad}\n{"tasks":[{"title":"A","task":"任务 A"}]}\n\`\`\`\n`,
    );
    expect(scan.blocks).toHaveLength(1);
    expect(scan.blocks[0]?.[0]?.title).toBe("A");
  });

  // 工具调用式载荷跨 chunk 到达：标记先到，载荷后到。裁剪不能把标记吃掉 ——
  // 标记没了，下一块的载荷就永远配不上对（委派静默丢失）。
  it("工具调用式标记先到、载荷后到时不会丢失", () => {
    const scanner = new SuperDirectiveScanner();
    scanner.push("<｜DSML｜tool-super-agent>\n");
    const scan = scanner.push('{"tasks":[{"title":"T","task":"任务 T"}]}\n</tool-super-agent>\n');
    expect(scan.blocks).toHaveLength(1);
    expect(scan.blocks[0]?.[0]?.title).toBe("T");
  });

  // 工具调用式标记被切成两半（"super-ag" + "ent:"）：半截标记扫描根本认不出来，
  // 于是这一帧「没有标记」—— 前半截被丢掉的话，下一帧补齐也认不出来（委派静默
  // 丢失）。这条用例是尾巴保护最尖锐的一条：没有别的路径能兜底。
  it("工具调用式标记被切成两半时不会丢失", () => {
    const scanner = new SuperDirectiveScanner();
    scanner.push("叙述文字。\nsuper-ag");
    const scan = scanner.push('ent:\n{"tasks":[{"title":"S","task":"任务 S"}]}\n');
    expect(scan.blocks).toHaveLength(1);
    expect(scan.blocks[0]?.[0]?.title).toBe("S");
  });

  // 载荷写到一半（JSON 还没收口）：标记必须留着，载荷补齐后才派发。
  it("工具调用式载荷分三块到达时不会丢失", () => {
    const scanner = new SuperDirectiveScanner();
    const dispatched: string[] = [];
    for (const chunk of [
      "<｜DSML｜tool-super-agent>\n{\"tasks\":[{\"title\"",
      ':\"T\",\"task\":\"任务 T\"}]}\n',
      "</tool-super-agent>\n",
    ]) {
      for (const tasks of scanner.push(chunk).blocks) {
        for (const task of tasks) dispatched.push(task.title);
      }
    }
    expect(dispatched).toEqual(["T"]);
  });
});

describe("super agent · 委派载荷跨通道去重键", () => {
  it("空白差异归一化：同一份载荷得到同一个键", () => {
    const a = superDirectiveDedupeKey([
      { title: "改登录", task: "修好 src/auth.ts\n并补测试" },
    ]);
    const b = superDirectiveDedupeKey([
      { title: "  改登录  ", task: "修好   src/auth.ts   并补测试" },
    ]);
    expect(b).toBe(a);
  });

  it("附件顺序不同是同一份载荷", () => {
    const first = superDirectiveDedupeKey([
      {
        title: "看这两个文件",
        task: "一起读",
        attachments: [
          { name: "a.txt", path: "src\\a.txt" },
          { name: "b.txt", path: "src/b.txt" },
        ],
      },
    ]);
    const second = superDirectiveDedupeKey([
      {
        title: "看这两个文件",
        task: "一起读",
        attachments: [
          { name: "b.txt", path: "src/b.txt" },
          { name: "a.txt", path: "src/a.txt" },
        ],
      },
    ]);
    expect(second).toBe(first);
  });

  it("附件内容不同的载荷得到不同的键", () => {
    const base = { title: "看文件", task: "一起读" };
    const one = superDirectiveDedupeKey([
      { ...base, attachments: [{ name: "a.txt", path: "src/a.txt" }] },
    ]);
    const other = superDirectiveDedupeKey([
      { ...base, attachments: [{ name: "a.txt", path: "src/a.txt", mimeType: "image/png" }] },
    ]);
    expect(other).not.toBe(one);
  });

  it("任务或标题不同则不是同一份载荷", () => {
    const one = superDirectiveDedupeKey([{ title: "改登录", task: "修好 src/auth.ts" }]);
    const otherTask = superDirectiveDedupeKey([{ title: "改登录", task: "修好 src/auth.ts 并补测试" }]);
    const otherTitle = superDirectiveDedupeKey([{ title: "改登录跳转", task: "修好 src/auth.ts" }]);
    expect(otherTask).not.toBe(one);
    expect(otherTitle).not.toBe(one);
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
      pending: { kind: "question", requestId: "r1", questions: [], deadline: 0, timeoutMs: 300_000 },
    });
    expect(next.status).toBe("awaiting_input");
    expect(next.pending?.kind).toBe("question");
    expect(next.reports.at(-1)?.state).toBe("blocked");
  });

  it("input_resolved 回到 running 并清掉 pending", () => {
    const waiting = applySuperEvent(session(), {
      type: "needs_input",
      at: 2000,
      pending: { kind: "question", requestId: "r1", questions: [], deadline: 0, timeoutMs: 300_000 },
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

describe("super agent · 归档与恢复", () => {
  it("落盘剥掉运行期字段（待应答提问 / 实时进度 / 已死的会话 id）", () => {
    const live = session({
      status: "awaiting_input",
      mainSessionId: "main-1",
      cliSessionId: "cli-9",
      progress: "正在写代码……",
      pending: {
        kind: "question",
        requestId: "req-1",
        questions: [{ header: "h", question: "选哪个？" }],
        deadline: 5000,
        timeoutMs: 300_000,
      },
    });
    const persisted = toPersistedSuperSession(live);

    // 恢复出来也答不了那个提问（进程没了），更不该展示实时进度 —— 都不存。
    expect(persisted).not.toHaveProperty("pending");
    expect(persisted).not.toHaveProperty("progress");
    expect(persisted).not.toHaveProperty("cliSessionId");
    // 归属与隔离信息必须留下：分支与工作目录是恢复后唯一还能操作的东西。
    expect(persisted.mainSessionId).toBe("main-1");
    expect(persisted.isolation.branch).toBe("iflow/super/a");
    expect(persisted.task).toBe("修好它");
  });

  it("恢复出来标成历史记录", () => {
    const restored = fromPersistedSuperSession(toPersistedSuperSession(session({ status: "completed" })));
    expect(restored.restored).toBe(true);
    expect(restored.status).toBe("completed");
    expect(restored.isolation.branch).toBe("iflow/super/a");
  });

  it("运行中的子会话恢复成「已中断」—— 进程已经没了，不能谎称还在跑", () => {
    for (const status of ["preparing", "running", "awaiting_input"] as const) {
      const restored = fromPersistedSuperSession(toPersistedSuperSession(session({ status })));
      expect(restored.status).toBe("cancelled");
      // 终态：否则主会话的「全部子会话结束」汇报永远等不到，主会话就卡住了。
      expect(isTerminalSuperStatus(restored.status)).toBe(true);
      expect(restored.endedAt).toBe(1000);
    }
  });

  it("已完成的子会话恢复后仍是已完成（不篡改历史）", () => {
    const restored = fromPersistedSuperSession(toPersistedSuperSession(session({ status: "completed" })));
    expect(restored.status).toBe("completed");
  });

  it("恢复出来的记录不能重试 —— 没有进程可以重启", () => {
    const restored = fromPersistedSuperSession(toPersistedSuperSession(session({ status: "running" })));
    // cancelled 本身可重试，但历史记录的重试语义不同（那会重跑整个任务），
    // 所以看板按 restored 标记隐藏重试入口。
    expect(restored.restored).toBe(true);
  });

  it("归档往返保留归属主会话", () => {
    const persisted = toPersistedSuperSession(session({ mainSessionId: "main-42" }));
    expect(fromPersistedSuperSession(persisted).mainSessionId).toBe("main-42");
  });

  it("归档带着 todolist；恢复时 in_progress 归一（进程已死，不能冒充运行中）", () => {
    const live = session({
      status: "completed",
      todos: [
        { content: "读代码", status: "completed" },
        { content: "改实现", status: "in_progress", priority: "high" },
      ],
    });
    const persisted = toPersistedSuperSession(live);
    // 记录性内容（不存运行期字段的原则不变）：重启后时间轴仍要有步骤可看。
    expect(persisted.todos).toEqual(live.todos);

    const restored = fromPersistedSuperSession(persisted);
    expect(restored.todos).toEqual([
      { content: "读代码", status: "completed" },
      // 进程已经没了：残留的 in_progress 如实降为 pending，不能显示成正在跑。
      { content: "改实现", status: "pending", priority: "high" },
    ]);
  });
});

describe("super agent · todolist 清洗", () => {
  it("非数组 / 空数组都是合法的「没有 todolist」", () => {
    expect(normalizeSuperTodos(undefined)).toEqual([]);
    expect(normalizeSuperTodos(null)).toEqual([]);
    expect(normalizeSuperTodos({})).toEqual([]);
    expect(normalizeSuperTodos([])).toEqual([]);
  });

  it("只取数组、丢弃脏条目，content trim / 字符串化，空串丢弃", () => {
    const todos = normalizeSuperTodos([
      { content: "  读代码  ", status: "in_progress" },
      null,
      "不是对象",
      { content: "", status: "completed" },
      { content: "   ", status: "completed" },
      { content: 42 },
    ]);
    expect(todos).toEqual([
      { content: "读代码", status: "in_progress" },
      { content: "42", status: "pending" },
    ]);
  });

  it("单条 200 字符截断（含省略号），status / priority 只认白名单", () => {
    const [todo] = normalizeSuperTodos([
      { content: "x".repeat(260), status: "weird", priority: "urgent" },
    ]);
    expect(todo?.content).toHaveLength(200);
    expect(todo?.content.endsWith("…")).toBe(true);
    expect(todo?.status).toBe("pending");
    expect(todo).not.toHaveProperty("priority");

    expect(
      normalizeSuperTodos([{ content: "a", status: "completed", priority: "low" }])[0],
    ).toEqual({ content: "a", status: "completed", priority: "low" });
  });

  it("条目数封顶 20，脏数据不能撑爆快照", () => {
    const todos = normalizeSuperTodos(
      Array.from({ length: 30 }, (_, i) => ({ content: `任务 ${i}`, status: "pending" })),
    );
    expect(todos).toHaveLength(20);
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
      pending: { kind: "question", requestId: "r", questions: [], deadline: 0, timeoutMs: 300_000 },
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
    // 状态标签是英文（提示词正文面向模型）。
    expect(text).toContain("completed");
  });

  it("空汇报不产出提示词", () => {
    expect(buildSuperReportPrompt([])).toBe("");
  });

  it("汇报提示词要求把后续步骤派给子会话、仅在疑惑时提问、最后完整汇报", () => {
    const text = buildSuperReportPrompt([
      { session: session({ status: "completed" }), report: { state: "ready", summary: "改完了", at: 1 } },
    ]);
    expect(text).toContain("Dispatch every follow-up step to a child session");
    expect(text).toContain("do not run commands or edit files yourself");
    expect(text).toContain("give the user one complete report");
    // 逐个即时汇报：说的是「本批已结束的 N 个」，不再是「这一批都已结束」。
    expect(text).toContain("the 1 child session(s) that just finished in this batch");
    expect(text).not.toContain("the whole batch has finished");
    expect(text).toContain("Do not invent results");
  });

  it("没有子会话在跑时：提示词说宿主逐个交回，并保留最终完整汇报", () => {
    const text = buildSuperReportPrompt(
      [{ session: session({ status: "completed" }), report: { state: "ready", summary: "改完了", at: 1 } }],
      { pendingCount: 0 },
    );
    expect(text).toContain("hands their results back to you as each one finishes");
    expect(text).toContain("give the user one complete report");
    expect(text).not.toContain("are still running");
    expect(text).not.toContain("wait until every one of them has finished");
  });

  it("还有子会话在跑时：先处理这批结果，不要现在做最终完整汇报", () => {
    const text = buildSuperReportPrompt(
      [{ session: session({ status: "completed" }), report: { state: "ready", summary: "改完了", at: 1 } }],
      { pendingCount: 2 },
    );
    expect(text).toContain("2 other child session(s) are still running");
    expect(text).toContain("the host will keep reporting as they finish");
    expect(text).toContain("do not wait for them");
    expect(text).toContain("do not give the user a final complete report yet");
    // 还有人在跑 → 这一轮不做最终完整汇报（收尾留给最后一次）。
    expect(text).not.toContain("give the user one complete report");
  });

  it("缺省 pendingCount 等同于 0（没有子会话在跑）", () => {
    const text = buildSuperReportPrompt([
      { session: session({ status: "completed" }), report: { state: "ready", summary: "改完了", at: 1 } },
    ]);
    expect(text).toContain("give the user one complete report");
    expect(text).not.toContain("are still running");
  });

  it("汇报提示词把复核写成派发任务，而不是让主会话自己执行", () => {
    const text = buildSuperReportPrompt([
      { session: session({ status: "completed" }), report: { state: "ready", summary: "改完了", at: 1 } },
    ]);
    expect(text).toContain("review does not run in this session");
    expect(text).toContain("run the tests");
    expect(text).toContain("the type check");
    expect(text).toContain("the build");
    expect(text).toContain("do not run commands or edit files yourself");
    // 旧措辞（主会话自己动手）不能再出现。
    expect(text).not.toContain("handle it yourself first");
    expect(text).not.toContain("the follow-up steps you can complete yourself");
  });

  it("汇报提示词把主会话接回同一个任务，而不是让它等用户再开口", () => {
    const text = buildSuperReportPrompt([
      { session: session({ status: "completed" }), report: { state: "ready", summary: "改完了", at: 1 } },
    ]);
    // 主会话派发完本轮结束是正常的，宿主在子会话全部结束后补一轮。
    expect(text).toContain("a new turn of the same task");
    expect(text).toContain("do not stop and wait for the user to speak again");
    // 「根据汇报再进行下一步」：后续步骤要自己动手，不是只给建议。
    expect(text).toContain("Dispatch those tasks directly");
    expect(text).toContain("do not merely suggest them");
  });

  it("全部被中断的汇报不催主会话继续，而是先问用户", () => {
    const text = buildSuperReportPrompt([
      { session: session({ status: "cancelled" }), report: { state: "dropped", summary: "用户中断", at: 1 } },
    ]);
    expect(text).toContain("were **interrupted**");
    expect(text).toContain("Do not re-run them automatically");
    expect(text).toContain("ask the user whether to continue");
    expect(text).not.toContain("do not stop and wait for the user to speak again");
  });

  it("全部被中断且还有子会话在跑：保留中断说明，并补上仍在运行的说明", () => {
    const text = buildSuperReportPrompt(
      [{ session: session({ status: "cancelled" }), report: { state: "dropped", summary: "用户中断", at: 1 } }],
      { pendingCount: 1 },
    );
    expect(text).toContain("were **interrupted**");
    expect(text).toContain("Do not re-run them automatically");
    expect(text).toContain("ask the user whether to continue");
    expect(text).toContain("1 other child session(s) are still running");
    expect(text).toContain("the host will keep reporting as they finish");
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

  it("只取走来源已终态的条目，还在跑的留在缓冲里", () => {
    const buffer = new SuperReportBuffer();
    buffer.add([
      { session: session({ id: "a", status: "completed" }), report: { state: "ready", summary: "a 完成", at: 1 } },
      { session: session({ id: "b", status: "running" }), report: { state: "ready", summary: "b 未完", at: 2 } },
    ]);
    const batch = buffer.takeSettled([
      session({ id: "a", status: "completed" }),
      session({ id: "b", status: "running" }),
    ]);
    // 只有终态的 a 被取走（逐个即时汇报）。
    expect(batch?.map((entry) => entry.session.id)).toEqual(["a"]);
    // b 还在跑：它的条目继续留在缓冲里。
    expect(buffer.size).toBe(1);
  });

  it("仍在跑的子会话结束后，它的汇报被取走", () => {
    const buffer = new SuperReportBuffer();
    buffer.add([
      { session: session({ id: "b", status: "running" }), report: { state: "ready", summary: "b 未完", at: 2 } },
    ]);
    expect(buffer.takeSettled([session({ id: "b", status: "running" })])).toBeNull();
    expect(buffer.size).toBe(1);

    const batch = buffer.takeSettled([session({ id: "b", status: "completed" })]);
    expect(batch?.map((entry) => entry.session.id)).toEqual(["b"]);
    expect(buffer.size).toBe(0);
  });

  it("已终态的子会话的汇报各自被取走（不再等整批结束）", () => {
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

  it("来源子会话已不存在：条目被丢掉（否则面板永久忙碌）", () => {
    const buffer = new SuperReportBuffer();
    buffer.add([
      { session: session({ id: "a", status: "completed" }), report: { state: "ready", summary: "a 完成", at: 1 } },
      { session: session({ id: "b", status: "running" }), report: { state: "ready", summary: "b 未完", at: 2 } },
    ]);
    // a 已被清理（不再出现在会话列表里）→ 它的汇报没人能接。
    expect(buffer.dropMissing([session({ id: "b", status: "running" })])).toEqual(["a"]);
    expect(buffer.size).toBe(1);
    // 已经丢过的不再重复上报。
    expect(buffer.dropMissing([session({ id: "b", status: "running" })])).toEqual([]);
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

  it("看板计数：用户中断不计入失败", () => {
    const summary = summarizeSuperSessions([
      session({ id: "a", status: "running" }),
      session({ id: "b", status: "preparing" }),
      session({ id: "c", status: "awaiting_input" }),
      session({ id: "d", status: "completed" }),
      session({ id: "e", status: "failed" }),
      session({ id: "f", status: "cancelled" }),
    ]);
    expect(summary).toEqual({ total: 6, running: 2, awaiting: 1, done: 1, failed: 1, cancelled: 1 });
  });
});

describe("super agent · 看板排序与折叠", () => {
  const merged = (id: string, createdAt = 1000): SuperSessionUi =>
    session({
      id,
      status: "completed",
      createdAt,
      integration: { mode: "merge", state: "merged", at: createdAt + 10 },
    });

  it("进行中的子会话排在最前，改动没落地的排其后", () => {
    const { visible } = groupSuperSessionsForBoard([
      merged("done"),
      session({ id: "failed", status: "failed", createdAt: 2000 }),
      session({ id: "running", status: "running", createdAt: 3000 }),
      session({ id: "awaiting", status: "awaiting_input", createdAt: 4000 }),
      session({ id: "pending-merge", status: "completed", createdAt: 5000 }),
    ]);
    expect(visible.map((s) => s.id)).toEqual(["awaiting", "running", "failed", "pending-merge"]);
  });

  it("已完成且已自动合并的子会话折叠成历史分组", () => {
    const { visible, folded } = groupSuperSessionsForBoard([
      merged("done"),
      session({ id: "running", status: "running" }),
    ]);
    expect(folded.map((s) => s.id)).toEqual(["done"]);
    expect(visible.map((s) => s.id)).toEqual(["running"]);
  });

  it("已完成且无需合并（没有产生任何提交）的子会话也折叠成历史分组", () => {
    const { visible, folded } = groupSuperSessionsForBoard([
      session({
        id: "nothing-to-merge",
        status: "completed",
        createdAt: 1000,
        integration: { mode: "merge", state: "not_needed", at: 2 },
      }),
      session({ id: "running", status: "running", createdAt: 2000 }),
    ]);
    expect(folded.map((s) => s.id)).toEqual(["nothing-to-merge"]);
    expect(visible.map((s) => s.id)).toEqual(["running"]);
  });

  it("改动还没落地的已完成子会话不折叠（PR / 未自动合并 / 冲突都要人看）", () => {
    const { visible, folded } = groupSuperSessionsForBoard([
      session({ id: "pr", status: "completed", createdAt: 1000, integration: { mode: "pr", state: "pr_created", at: 2 } }),
      session({ id: "skipped", status: "completed", createdAt: 2000, integration: { mode: "merge", state: "skipped", at: 2 } }),
      session({ id: "conflict", status: "completed", createdAt: 3000, integration: { mode: "merge", state: "conflict", at: 2 } }),
      session({ id: "none", status: "completed", createdAt: 4000 }),
    ]);
    expect(folded).toHaveLength(0);
    expect(visible.map((s) => s.id).sort()).toEqual(["conflict", "none", "pr", "skipped"]);
  });

  it("同一权重内按派发顺序排列（状态变化不会让卡片跳来跳去）", () => {
    const { visible } = groupSuperSessionsForBoard([
      session({ id: "later", status: "running", createdAt: 2000 }),
      session({ id: "earlier", status: "running", createdAt: 1000 }),
    ]);
    expect(visible.map((s) => s.id)).toEqual(["earlier", "later"]);
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

describe("super agent · 看板摘要", () => {
  it("没有子会话时仍注入看板标记（主/子会话的角色信号）", () => {
    // 系统提示用「输入里有没有 [子会话看板]」区分主会话与子会话：
    // 空看板若返回空串，首轮主会话会被误判成子会话而自己动手干活。
    const digest = buildSuperDigest([]);
    expect(digest).toContain("[子会话看板]");
    // 哨兵必须打头：面板按前缀判定这一轮是不是主会话。
    expect(digest.startsWith("[子会话看板]")).toBe(true);
    expect(digest.trim().length).toBeGreaterThan(0);
    // 首轮还没有子会话，也必须明确「首选内置 super-agent 工具；没有该工具时
    // 才写正文围栏」，并说明管理动作只有围栏一条通道。
    expect(digest).toContain("Dispatch by calling the `super-agent` tool");
    expect(digest).toContain("if that tool is not in your list");
    expect(digest).toContain("```super-agent fenced block instead");
    expect(digest).toContain("Manage children only by emitting a ```super-agent-actions fenced block");
    expect(digest).toContain("no actions tool exists");
  });

  it("看板 hint 的载荷示例是合法 JSON（模型照抄示例不会撞上 invalid payload）", () => {
    // 2026-11-15 实测：`{"title","task"}` 这种缺冒号的简写会被 parseDirectiveBody
    // 判成「载荷不是合法 JSON」并进 invalidBlocks —— 模型照抄示例就会零派发。
    // 示例必须是可解析的 JSON，同时保留占位符（原样抄回按占位符规则拒掉）。
    const digest = buildSuperDigest([]);
    const match = /with body (\{[^;]+\}); if that tool is not in your list/.exec(digest);
    expect(match).not.toBeNull();
    expect(() => JSON.parse(match![1]!)).not.toThrow();
  });

  it("列出每个子会话的 id、状态与摘要，并附管理动作说明", () => {
    const digest = buildSuperDigest([
      session({ id: "super-a", status: "running", summary: "正在补单测" }),
      session({
        id: "super-b",
        title: "梳理依赖",
        status: "completed",
        summary: "未发现冗余",
        integration: { mode: "merge", state: "merged", at: 10 },
      }),
    ]);
    expect(digest).toContain("super-a");
    expect(digest).toContain("running");
    expect(digest).toContain("正在补单测");
    expect(digest).toContain("super-b");
    expect(digest).toContain("completed");
    expect(digest).toContain("merged automatically");
    expect(digest).toContain("super-agent-actions");
    // 非空分支同样要带委派协议提示：有子会话在跑时模型仍可能选错派发通道。
    expect(digest).toContain("Dispatch by calling the `super-agent` tool");
    expect(digest).toContain("if that tool is not in your list");
    expect(digest).toContain("Manage children only by emitting a ```super-agent-actions fenced block");
    // 用户中断不计入失败：摘要里应分开呈现。
    expect(digest).toContain("0 failed");
    expect(digest).toContain("0 interrupted");
  });

  it("失败会话给出原因，待答会话给出请求 id 与问题", () => {
    const digest = buildSuperDigest([
      session({ id: "super-f", status: "failed", error: "内核拒绝了这次请求" }),
      session({
        id: "super-q",
        status: "awaiting_input",
        pending: {
          kind: "question",
          requestId: "req-7",
          questions: [{ header: "范围", question: "要覆盖压缩卡吗？", multiSelect: false, options: [] }],
          deadline: 1,
          timeoutMs: 300_000,
        },
      }),
    ]);
    expect(digest).toContain("failure reason: 内核拒绝了这次请求");
    expect(digest).toContain("req-7");
    expect(digest).toContain("要覆盖压缩卡吗？");
  });

  it("失败子会话的看板指令硬性要求 retry、禁止新派等价任务", () => {
    // 用户实测：failed 子会话的 worktree 里已有大半未提交改动，主会话却用
    // super-agent 新派了一个等价任务（全新 worktree、从零开始），把半成品全丢了。
    // 因此看板末尾的英文指令必须把「失败优先 retry、不重派」写成硬规则。
    const digest = buildSuperDigest([
      session({ id: "super-failed", status: "failed", error: "内核拒绝了这次请求" }),
    ]);
    expect(digest).toContain("A child whose status is `failed` MUST be retried with the `retry` action");
    expect(digest).toContain("Do NOT dispatch a new, equivalent `super-agent` task");
    expect(digest).toContain("same working directory");
    expect(digest).toContain("An `interrupted` child is not a failure");
  });

  it("超出字符预算时丢弃尾部条目并注明省略数量", () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      session({ id: `super-${i}`, title: `任务 ${i}`, status: "completed", summary: "x".repeat(120) }),
    );
    const digest = buildSuperDigest(many);
    expect(digest.length).toBeLessThanOrEqual(SUPER_DIGEST_MAX_CHARS);
    expect(digest).toMatch(/\d+ more child session\(s\) omitted for budget/);
    expect(digest).toContain("super-0");
    expect(digest).not.toContain("super-119");
  });

  it("单行摘要压成一行并截断过长文本", () => {
    const line = describeSuperSessionLine(
      session({ status: "completed", summary: `第一行\n第二行${"长".repeat(300)}` }),
    );
    expect(line).not.toContain("\n");
    // 单行上限已提高到 SUPER_BOARD_SUMMARY_MAX_CHARS：约 306 字符的摘要不再
    // 被截断，但仍受这个上限约束、不无界增长（整体 4000 预算另有用例覆盖）。
    expect(line.length).toBeLessThan(SUPER_BOARD_SUMMARY_MAX_CHARS + 240);
  });
});

describe("super agent · 汇报截断不丢尾部结论", () => {
  // 用户反馈（2026-11-13）：completed 行与状态上报里的详细汇报都以省略号
  // 收尾、看不到最终结论。结论写在汇报末尾，而旧实现只留开头（宿主
  // summarize 的 799 字符 / 看板行的 160 字符），恰好把结论砍掉了。
  const conclusion = "最终结论：三项检查全部通过，改动已自动合并到主分支";
  const longReport = `开始处理。\n${"过程流水账 ".repeat(1200)}\n${conclusion}`;

  it("长汇报经 summarize 的截断逻辑后，尾部结论仍可见且带明确省略标记", () => {
    // 宿主 summarize() 直接委托 capReportTail(text)：断言这份共用实现的契约。
    const summary = capReportTail(longReport);
    expect(summary).toContain(conclusion);
    expect(summary).toContain("[middle omitted]");
    expect(summary.startsWith("开始处理")).toBe(true); // 头尾拼接：开头语境也留着
    expect(summary.length).toBeLessThanOrEqual(SUPER_REPORT_SUMMARY_MAX_CHARS);
    expect(summary.length).toBeGreaterThan(SUPER_REPORT_SUMMARY_MAX_CHARS - 100);
  });

  it("短汇报原样返回（不截断、不带省略标记）", () => {
    const short = `修好了。\n${conclusion}`;
    expect(capReportTail(short)).toBe(short);
    expect(capReportTail("   ")).toBe("");
    expect(capReportTail("x".repeat(200))).toBe("x".repeat(200));
  });

  it("看板行：长汇报的尾部结论仍可见、压成一行、带明确省略标记", () => {
    const line = describeSuperSessionLine(
      session({ status: "completed", summary: longReport }),
    );
    expect(line).not.toContain("\n");
    expect(line).toContain(conclusion);
    expect(line).toContain("[middle omitted]");
    expect(line.length).toBeLessThan(SUPER_BOARD_SUMMARY_MAX_CHARS + 240);
  });

  it("看板行：短汇报原样呈现，不冒出省略标记", () => {
    const line = describeSuperSessionLine(
      session({ status: "completed", summary: conclusion }),
    );
    expect(line).toContain(conclusion);
    expect(line).not.toContain("middle omitted");
  });

  it("汇报正文经 reportForSession → buildSuperReportPrompt 后结论不被二次截断", () => {
    const done = session({ status: "completed", summary: capReportTail(longReport) });
    const report = reportForSession(done, 1, "(the child session left no text summary)");
    expect(report).not.toBeNull();
    expect(report!.summary).toContain(conclusion);
    const prompt = buildSuperReportPrompt([{ session: done, report: report! }], { pendingCount: 0 });
    expect(prompt).toContain(conclusion);
    expect(prompt).toContain("[middle omitted]");
  });

  it("看板整体 4000 预算仍生效：超预算从尾部丢弃条目并注明省略数量", () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      session({ id: `super-${i}`, title: `任务 ${i}`, status: "completed", summary: longReport }),
    );
    const digest = buildSuperDigest(many);
    expect(digest.length).toBeLessThanOrEqual(SUPER_DIGEST_MAX_CHARS);
    expect(digest).toMatch(/\d+ more child session\(s\) omitted for budget/);
    expect(digest).toContain("super-0");
    expect(digest).not.toContain("super-119");
    // 单行上限提高没有把结论挤掉：保留下来的行仍能看到尾部结论。
    expect(digest).toContain(conclusion);
  });
});

describe("super agent · 管理动作协议", () => {
  it("解析 retry / cancel / cleanup / answer", () => {
    const text = [
      "```super-agent-actions",
      JSON.stringify({
        actions: [
          { action: "retry", sessionId: "super-a" },
          { action: "cancel", sessionId: "super-b" },
          { action: "cleanup", sessionId: "super-d", keepBranch: true },
          { action: "answer", sessionId: "super-e", answers: { 范围: ["A", "B"], 备注: "都行" } },
        ],
      }),
      "```",
    ].join("\n");
    const scan = extractSuperActions(text);
    expect(scan.invalidBlocks).toHaveLength(0);
    expect(scan.actions).toEqual([
      { action: "retry", sessionId: "super-a" },
      { action: "cancel", sessionId: "super-b" },
      { action: "cleanup", sessionId: "super-d", keepBranch: true },
      { action: "answer", sessionId: "super-e", answers: { 范围: ["A", "B"], 备注: "都行" } },
    ]);
  });

  it("回显文档占位符时静默忽略，不当作错误", () => {
    const text = ['```super-agent-actions', '{"actions":[{"action":"retry","sessionId":"<id>"}]}', "```"].join("\n");
    const scan = extractSuperActions(text);
    expect(scan.actions).toHaveLength(0);
    expect(scan.invalidBlocks).toHaveLength(0);
  });

  it("非法 JSON → 收进 invalidBlocks 且不执行任何动作", () => {
    const scan = extractSuperActions(["```super-agent-actions", "{nope}", "```"].join("\n"));
    expect(scan.actions).toHaveLength(0);
    expect(scan.invalidBlocks).toHaveLength(1);
  });

  it("未闭合的块不提前执行（流式中间态）", () => {
    const text = ['```super-agent-actions', '{"actions":[{"action":"retry","sessionId":"super-a"}]}'].join("\n");
    const scan = extractSuperActions(text);
    expect(scan.actions).toHaveLength(0);
    expect(scan.end).toBe(0);
  });

  it("消费偏移保证同一段文本不会被执行两次", () => {
    const text = ['```super-agent-actions', '{"actions":[{"action":"cancel","sessionId":"super-a"}]}', "```"].join("\n");
    const first = extractSuperActions(text);
    expect(first.actions).toHaveLength(1);
    const second = extractSuperActions(text, first.end);
    expect(second.actions).toHaveLength(0);
  });

  it("未知动作与缺 answers 的 answer 被丢弃，但块本身合法", () => {
    const text = [
      "```super-agent-actions",
      JSON.stringify({
        actions: [
          { action: "explode", sessionId: "super-a" },
          { action: "answer", sessionId: "super-b" },
          { action: "cleanup", sessionId: "super-c" },
        ],
      }),
      "```",
    ].join("\n");
    const scan = extractSuperActions(text);
    expect(scan.invalidBlocks).toHaveLength(0);
    expect(scan.actions).toEqual([{ action: "cleanup", sessionId: "super-c" }]);
  });

  it("一次输出最多执行 MAX_SUPER_ACTIONS 个动作", () => {
    const actions = Array.from({ length: MAX_SUPER_ACTIONS + 5 }, (_, i) => ({
      action: "cancel",
      sessionId: `super-${i}`,
    }));
    const text = ["```super-agent-actions", JSON.stringify({ actions }), "```"].join("\n");
    expect(extractSuperActions(text).actions).toHaveLength(MAX_SUPER_ACTIONS);
  });
});

describe("super agent · 动作回执", () => {
  it("回执区分「已生效」「幂等重复（已终态）」「真未生效」，并劝主会话别重复发", () => {
    const text = buildSuperActionReceiptPrompt([
      { action: "cancel", sessionId: "super-a", ok: true, reason: "applied" },
      {
        action: "cancel",
        sessionId: "super-b",
        ok: true,
        reason: "already-terminal",
        detail: "the child session was already completed",
      },
      { action: "cancel", sessionId: "super-c", ok: false, reason: "not-found" },
    ]);
    expect(text).toContain("[子会话动作回执]");
    expect(text).toContain("super-a");
    expect(text).toContain("applied");
    // 幂等重复：不是失败，但也不能说成「没生效」。
    expect(text).toContain("already applied (idempotent)");
    expect(text).toContain("the child session was already completed");
    // 目标不存在：这才是真的没生效。
    expect(text).toContain("NOT applied");
    // 主会话必须被明确告知：已生效的动作不要再发一遍。
    expect(text).toContain("must NOT be sent again");
  });

  it("没有回执时不产出提示词（不发空回合）", () => {
    expect(buildSuperActionReceiptPrompt([])).toBe("");
  });
});

describe("super agent · 让智能体合并的请求", () => {
  it("任务书要求在主仓工作区执行 git merge --no-ff，并划清硬边界", () => {
    const text = buildSuperMergeRequestPrompt(
      session({ title: "修复登录跳转", status: "completed" }),
    );
    expect(text).toContain("修复登录跳转");
    expect(text).toContain("iflow/super/a");
    // 合并只能在主仓工作区发生 —— 任务书必须写明这一点。
    expect(text).toContain("main repository workspace");
    expect(text).toContain("git merge --no-ff iflow/super/a");
    // 冲突按代码语义解决，两边的改动都要保住。
    expect(text).toContain("judge the intent of both sides by the code itself");
    expect(text).toContain("never discard one side");
    // 硬边界：不推送、不 rebase、不删分支、不切分支、不碰无关文件。
    expect(text).toContain("do not push");
    expect(text).toContain("do not rebase");
    expect(text).toContain("do not delete branches");
    expect(text).toContain("do not switch branches");
    expect(text).toContain("do not modify files unrelated to this merge");
    expect(text).toContain("do not touch the user's other uncommitted changes");
    // 手动触发：措辞如实说明是用户点的。
    expect(text).toContain("The user clicked");
  });

  it("任务书带安全阀：冲突解决不了就 abort，并要求如实汇报", () => {
    const text = buildSuperMergeRequestPrompt(
      session({ title: "修复登录跳转", status: "completed" }),
    );
    expect(text).toContain("git merge --abort");
    expect(text).toContain("never leave the repository half-merged");
    expect(text).toContain("report faithfully");
    expect(text).toContain("the merge commit (hash and title)");
    expect(text).toContain("the list of changed files");
  });

  // 旧的措辞是写给主会话的（「你自己去合并、别只给建议、别让我手动执行」）。
  // 现在这段文本是委派块里的 task 文本，交给一个专职合并的子会话执行 ——
  // 面向主会话的指令必须删掉，否则子会话会读到互相矛盾的要求。
  it("不再残留面向主会话的旧措辞", () => {
    const text = buildSuperMergeRequestPrompt(
      session({ title: "修复登录跳转", status: "completed" }),
    );
    expect(text).not.toContain("do not merely suggest it");
    expect(text).not.toContain("do not make me do it manually");
    expect(text).not.toContain("please do it yourself");
  });

  it("自动触发时不说「用户在看板点击了」，而是说明改动没能自动合并", () => {
    const text = buildSuperMergeRequestPrompt(
      session({ title: "修复登录跳转", status: "completed" }),
      { auto: true, reason: "主工作区有未提交改动，与子会话的改动重叠" },
    );
    expect(text).toContain("could not be merged automatically");
    expect(text).toContain("主工作区有未提交改动，与子会话的改动重叠");
    expect(text).not.toContain("The user clicked");
    // 执行步骤与手动触发一致。
    expect(text).toContain("git merge --no-ff iflow/super/a");
    expect(text).toContain("git merge --abort");
  });

  it("没有分支时不编造合并命令，如实说明无可合并目标", () => {
    const text = buildSuperMergeRequestPrompt(
      session({ isolation: { kind: "directory", path: "/tmp/dir" }, status: "completed" }),
    );
    expect(text).not.toContain("git merge --no-ff");
    expect(text).toContain("there is nothing to merge");
    expect(text).toContain("Do not run any git command");
  });
});

describe("super agent · 主仓工作区隔离（repo）", () => {
  const repoSession = (overrides: Partial<SuperSessionUi> = {}): SuperSessionUi =>
    session({
      isolation: { kind: "repo", path: "J:/repo" },
      ...overrides,
    });

  it("看板标签如实说明是主仓工作区，而不是伪造一个分支", () => {
    expect(superIsolationLabel(repoSession().isolation)).toBe("主仓工作区（无隔离）");
    expect(superIsolationLabel({ kind: "git_worktree", path: "/wt", branch: "iflow/super/a" })).toBe(
      "独立 worktree",
    );
    expect(superIsolationLabel({ kind: "directory", path: "/dir" })).toBe("仅目录隔离");
  });

  it("看板摘要里报的是隔离方式，不是一个不存在的分支", () => {
    const line = describeSuperSessionLine(repoSession({ status: "running" }));
    // 摘要是模型面向的，隔离说明用英文。
    expect(line).toContain("main repository workspace (no isolation)");
    expect(line).not.toContain("branch ");
  });

  it("归档往返保留 repo 隔离，且不会带出分支", () => {
    const persisted = toPersistedSuperSession(repoSession({ status: "completed" }));
    expect(persisted.isolation.kind).toBe("repo");
    expect(persisted.isolation.path).toBe("J:/repo");
    expect(persisted.isolation.branch).toBeUndefined();

    const restored = fromPersistedSuperSession(persisted);
    expect(restored.isolation.kind).toBe("repo");
    expect(restored.isolation.path).toBe("J:/repo");
    expect(restored.isolation.branch).toBeUndefined();
  });

  it("恢复时把残留的分支名丢掉（不能显示并不存在的分支）", () => {
    const restored = fromPersistedSuperSession({
      ...toPersistedSuperSession(repoSession({ status: "completed" })),
      isolation: { kind: "repo", path: "J:/repo", branch: "iflow/super/ghost" },
    });
    expect(restored.isolation.branch).toBeUndefined();
    expect(superIsolationLabel(restored.isolation)).toBe("主仓工作区（无隔离）");
  });

  it("运行中的主仓工作区子会话恢复后仍是「已中断」（进程已经没了）", () => {
    const restored = fromPersistedSuperSession(toPersistedSuperSession(repoSession({ status: "running" })));
    expect(restored.status).toBe("cancelled");
    expect(isTerminalSuperStatus(restored.status)).toBe(true);
  });
});

describe("子会话并发上限", () => {
  it("默认 5，可调范围 1–20", () => {
    expect(DEFAULT_MAX_CONCURRENT_SUPER_SESSIONS).toBe(5);
    expect(MAX_CONCURRENT_SUPER_SESSIONS).toBe(20);
  });

  it("越界值夹到 1..20", () => {
    expect(clampMaxConcurrentSuperSessions(0)).toBe(1);
    expect(clampMaxConcurrentSuperSessions(1000)).toBe(20);
    expect(clampMaxConcurrentSuperSessions(7)).toBe(7);
  });

  it("非有限值回落到默认 5", () => {
    // 手改 settings.json 可能留下 NaN / 字符串 —— 不能让池子卡死或无限放开。
    expect(clampMaxConcurrentSuperSessions(Number.NaN)).toBe(5);
    expect(clampMaxConcurrentSuperSessions("8" as unknown as number)).toBe(5);
    expect(clampMaxConcurrentSuperSessions(Number.POSITIVE_INFINITY)).toBe(5);
  });

  it("用户把上限设为 10 时按 10 生效（实现层从不截断到 4）", () => {
    // 2026-11-15 实测：maxConcurrent=10 却只派 4 个，根因是 system prompt
    // 里写死 "At most 4"，不是 clamp。锁住 clamp 对 10 的返回值。
    expect(clampMaxConcurrentSuperSessions(10)).toBe(10);
  });
});

describe("super agent · 宿主与渲染共用块解析", () => {
  /** 渲染侧切出的协议段。 */
  function directiveSegments(text: string) {
    return splitSuperDirectiveSegments(text).flatMap((segment) =>
      segment.kind === "directive" ? [segment] : [],
    );
  }

  it("合法载荷：宿主派发时，渲染切出的是 directive 段而不是文本段", () => {
    const text = [
      "好的，我来拆分。",
      "```super-agent",
      JSON.stringify({
        tasks: [
          { title: "改登录", task: "修好 src/auth.ts" },
          { title: "补文档", task: "更新 README" },
        ],
      }),
      "```",
      "两位子会话已经开工。",
    ].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.blocks).toHaveLength(1);
    expect(scan.invalidBlocks).toHaveLength(0);

    const segments = splitSuperDirectiveSegments(text);
    expect(segments.map((segment) => segment.kind)).toEqual(["text", "directive", "text"]);
    const [directive] = directiveSegments(text);
    expect(directive?.display.kind).toBe("tasks");
    expect(directive?.display.kind === "tasks" ? directive.display.tasks.length : 0).toBe(2);
    // 正常解析出来的任务不是「容错拆出」的降级预览。
    expect(directive?.display.kind === "tasks" ? directive.display.salvaged : undefined).not.toBe(true);
  });

  it("任务书自带代码围栏时，宿主与渲染选到同一个收栏", () => {
    const task = "先跑：\n```\nnpm test\n```\n然后修";
    const text = [
      "```super-agent",
      JSON.stringify({ tasks: [{ title: "带围栏", task }] }),
      "```",
    ].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.blocks[0]?.[0]?.task).toBe(task);

    const [directive] = directiveSegments(text);
    expect(directive?.display.kind).toBe("tasks");
    expect(directive?.display.kind === "tasks" ? directive.display.tasks[0]?.task : undefined).toBe(task);
    // 收栏是块自己的结束行，不是任务书里那段围栏。
    expect(directive?.raw.endsWith("```")).toBe(true);
    expect(directive?.raw).toContain("npm test");
  });

  // 三种实测形态：整体 JSON 解析不了，但「哪是标题、哪是任务书」一目了然。
  // 旧实现里宿主静默吞掉、渲染退化成一堵 JSON 墙。
  const malformed: Array<{ name: string; payload: string }> = [
    {
      name: "长任务书按原始换行铺开",
      payload: [
        '{"tasks":[{"title":"读代码","task":"第一步：读 shared/super-agent.ts',
        '第二步：改实现"},{"title":"跑测试","task":"npm test"}]}',
      ].join("\n"),
    },
    {
      name: "任务书正文里有裸引号",
      payload:
        '{"tasks":[{"title":"查日志","task":"执行 grep "TODO" 定位残留"},{"title":"跑测试","task":"npm test"}]}',
    },
    {
      name: "括号不配对",
      payload: '{"tasks":[{"title":"甲","task":"读代码"},{"title":"乙","task":"跑测试"}',
    },
  ];

  for (const { name, payload } of malformed) {
    it(`畸形载荷（${name}）→ 渲染拆出任务书，宿主不静默吞掉`, () => {
      const text = ["```super-agent", payload, "```"].join("\n");
      const scan = extractSuperDirectives(text);
      // 宿主侧：要么派发，要么给出明确失败（invalidBlocks 带原因），绝不静默吞掉。
      expect(scan.blocks.length + scan.invalidBlocks.length).toBeGreaterThanOrEqual(1);
      if (scan.invalidBlocks.length > 0) {
        expect(scan.invalidBlocks[0]?.reason).toBeTruthy();
      }

      const segments = splitSuperDirectiveSegments(text);
      expect(segments.every((segment) => segment.kind === "directive")).toBe(true);
      const [directive] = directiveSegments(text);
      expect(directive).toBeDefined();
      // 不再退化成一堵 JSON 墙 / 原始协议块卡。
      expect(directive?.display.kind).toBe("tasks");
      const display = directive?.display;
      expect(display?.kind === "tasks" ? display.tasks.length : 0).toBe(2);
      // 宿主报非法时，两边认定的块正文必须是同一段（边界同源）。
      if (scan.invalidBlocks[0]) {
        expect(directive?.raw).toContain(scan.invalidBlocks[0].body);
      }
      // 容错拆出 ≠ 已派发：宿主没派发时必须带 salvaged 标记；反过来宿主派发了
      // 就不是降级预览（两侧对同一段文本的严格解析结论一致）。
      if (scan.blocks.length === 0 && display?.kind === "tasks") {
        expect(display.salvaged).toBe(true);
      }
      if (scan.blocks.length > 0) {
        expect(display?.kind === "tasks" ? display.salvaged : undefined).not.toBe(true);
      }
    });
  }

  it("容错拆分：字段顺序颠倒、缺 title、夹杂无关字段都能拆", () => {
    const body = '{"tasks":[{"task":"跑测试","owner":"x","title":"乙"},{"task":"读代码","owner":"y"}]}';
    expect(salvageSuperTasks(body)).toEqual([
      { title: "乙", task: "跑测试", attachments: [] },
      // 缺 title 时用任务书首行兜底，绝不编造标题。
      { title: "读代码", task: "读代码", attachments: [] },
    ]);
  });

  it("容错拆分：任务书里的裸引号与原始换行按正文保留", () => {
    const body = [
      '{"tasks":[{"title":"查日志","task":"执行 grep "TODO"',
      '并修掉"},{"title":"跑测试","task":"npm test"}]}',
    ].join("\n");
    const tasks = salvageSuperTasks(body);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.task).toContain('"TODO"');
    expect(tasks[0]?.task).toContain("\n并修掉");
    expect(tasks[1]?.task).toBe("npm test");
  });

  it("容错拆分不认占位符任务（模型回显协议示例）", () => {
    expect(salvageSuperTasks('{"tasks":[{"title":"<标题>","task":"<任务说明>"}]}')).toEqual([]);
    // 混入占位符时只保留真任务 —— 与宿主 parseDirectiveBody 的占位符判定同源。
    expect(
      salvageSuperTasks('{"tasks":[{"title":"<标题>","task":"<说明>"},{"title":"真的","task":"真的任务"}]}'),
    ).toEqual([{ title: "真的", task: "真的任务", attachments: [] }]);
  });

  it("全是占位符的畸形载荷仍退回 raw 原因码，而不是编造任务", () => {
    const text = ["```super-agent", '{"tasks":[{"title":"<标题>","task":"<任务说明>"}', "```"].join("\n");
    const [directive] = directiveSegments(text);
    expect(directive?.display).toEqual({ kind: "raw", reason: "invalid_json" });
  });

  it("未闭合的畸形围栏不产出半截卡片（宿主继续续扫，渲染切出 pending 占位段）", () => {
    const unclosed = [
      "```super-agent",
      '{"tasks":[{"title":"带围栏","task":"第一步：读代码',
      "```",
      "npm test",
      "```",
    ].join("\n");
    const scan = extractSuperDirectives(unclosed);
    expect(scan.blocks).toHaveLength(0);
    expect(scan.invalidBlocks).toHaveLength(0);
    expect(scan.pendingOpen).toBeDefined();
    expect(splitSuperDirectiveSegments(unclosed)).toEqual([
      { kind: "pending", language: "super-agent" },
    ]);
  });

  // 实测（2026-11-12 用户截图）：模型不按 markdown 围栏写委派，而写成**工具调用式**
  // 载荷（`<｜DSML｜tool-super-agent>`，或「super-agent:」+ ```json 围栏）。宿主走
  // findToolStylePayloads 派发，只认围栏的渲染侧切不出卡片 —— 看板上「等待子会话
  // 汇报」已经出现，转录里却还是一堵 JSON 墙。两条读者必须走同一条判定链。
  const dsmlShape = [
    "我把这两件工作分别委派给两个子会话并行执行。",
    "",
    "<｜DSML｜tool-super-agent>",
    '{"tasks":[{"title":"编写模块A设计说明","task":"新建 docs/alpha.md"},{"title":"编写模块B设计说明","task":"新建 docs/beta.md"}]}',
    "</tool-super-agent>",
    "",
    "两个子会话已经开工。",
  ].join("\n");

  it("工具调用式载荷：宿主派发时渲染同样切出卡片（不再是 JSON 墙）", () => {
    const scan = extractSuperDirectives(dsmlShape);
    expect(scan.blocks).toHaveLength(1);
    expect(scan.blocks[0]).toHaveLength(2);

    const segments = splitSuperDirectiveSegments(dsmlShape);
    expect(segments.map((s) => s.kind)).toEqual(["text", "directive", "text"]);
    const [directive] = directiveSegments(dsmlShape);
    expect(directive?.language).toBe("super-agent");
    expect(directive?.display.kind).toBe("tasks");
    const display = directive?.display;
    expect(display?.kind === "tasks" ? display.tasks.map((task) => task.title) : []).toEqual([
      "编写模块A设计说明",
      "编写模块B设计说明",
    ]);
    // 包裹标记连同载荷一起进卡片（前后不留残字），散文留在文本段里 —— 那是真给用户读的话。
    expect(directive?.raw).toContain("<｜DSML｜tool-super-agent>");
    expect(directive?.raw).toContain("</tool-super-agent>");
    expect(segments[0]?.kind === "text" ? segments[0].text : "").toContain("我把这两件工作");
    expect(segments[2]?.kind === "text" ? segments[2].text : "").toContain("两个子会话已经开工");
    // 宿主派发出来的不是容错预览。
    expect(display?.kind === "tasks" ? display.salvaged : undefined).not.toBe(true);
  });

  it("「super-agent:」+ ```json 围栏载荷渲染成卡片，正文不丢、代码块消失", () => {
    const text = [
      "5 个子会话全部完成并已经合并到 beta，现在派一个复核会话跑全量检查。",
      "super-agent:",
      "```json",
      '{"tasks":[{"title":"合并后全量复核","task":"跑全量检查、如实汇报真实输出"}]}',
      "```",
      "复核会话已开工。",
    ].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.blocks).toHaveLength(1);
    expect(scan.blocks[0]?.[0]?.title).toBe("合并后全量复核");

    const segments = splitSuperDirectiveSegments(text);
    expect(segments.map((s) => s.kind)).toEqual(["text", "directive", "text"]);
    const [directive] = directiveSegments(text);
    expect(directive?.display.kind).toBe("tasks");
    // 裹载荷的 ```json 连同收栏一起进卡片，否则转录里会剩一行孤立的 ```。
    expect(directive?.raw).toContain("```json");
    expect(directive?.raw.trimEnd().endsWith("```")).toBe(true);
    expect(segments[0]?.kind === "text" ? segments[0].text : "").toContain("现在派一个复核会话");
    expect(segments[2]?.kind === "text" ? segments[2].text : "").toContain("复核会话已开工");
  });

  it("参数包装体（arguments.tasks）派发出来时卡片照原样展示，不标容错", () => {
    const text = [
      "<tool_call>",
      '{"name":"super-agent","arguments":{"tasks":[{"title":"A","task":"任务 A"}]}}',
      "</tool_call>",
    ].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.blocks[0]?.[0]).toEqual({ title: "A", task: "任务 A" });

    const [directive] = directiveSegments(text);
    expect(directive?.display.kind).toBe("tasks");
    const display = directive?.display;
    expect(display?.kind === "tasks" ? display.tasks[0]?.task : undefined).toBe("任务 A");
    expect(display?.kind === "tasks" ? display.salvaged : undefined).not.toBe(true);
  });

  it("载荷没收全时不出卡片（流式中间态），收全后出一张", () => {
    const head = "<｜DSML｜tool-super-agent>\n";
    const partial = '{"tasks":[{"title":"A","task":"任务 A"';
    expect(splitSuperDirectiveSegments(head + partial)).toEqual([
      { kind: "text", text: head + partial },
    ]);
    expect(directiveSegments(head + partial + "}]}")).toHaveLength(1);
  });

  it("散文里提到 super-agent 但没有载荷时不出现卡片", () => {
    const text = "我会在需要时用 super-agent 代码块来委派子会话。";
    expect(extractSuperDirectives(text).blocks).toHaveLength(0);
    expect(splitSuperDirectiveSegments(text)).toEqual([{ kind: "text", text }]);
  });

  it("与 super-agent 无关的 JSON 不出现卡片（与宿主同一判定）", () => {
    const text = '普通文本里的 {"tasks":[{"title":"A","task":"真的任务"}]} 与 super-agent 无关';
    expect(extractSuperDirectives(text).blocks).toHaveLength(0);
    expect(splitSuperDirectiveSegments(text)).toEqual([{ kind: "text", text }]);
  });

  it("围栏块与工具调用式载荷各出一张卡，不重复切分", () => {
    const text = [
      "```super-agent",
      '{"tasks":[{"title":"围栏任务","task":"围栏里的任务"}]}',
      "```",
      "",
      "<｜DSML｜tool-super-agent>",
      '{"tasks":[{"title":"工具任务","task":"工具里的任务"}]}',
      "</tool-super-agent>",
    ].join("\n");
    expect(extractSuperDirectives(text).blocks).toHaveLength(2);
    const titles = directiveSegments(text).flatMap((segment) =>
      segment.display.kind === "tasks" ? segment.display.tasks.map((task) => task.title) : [],
    );
    expect(titles).toEqual(["围栏任务", "工具任务"]);
  });

  it("工具调用式载荷内容非法时切成卡片段（宿主同样报非法），不再留 JSON 墙", () => {
    const text = ["<｜DSML｜tool-super-agent>", '{"tasks":[{"title":"A"}]}', "</tool-super-agent>"].join("\n");
    const scan = extractSuperDirectives(text);
    expect(scan.blocks).toHaveLength(0);
    expect(scan.invalidBlocks).toHaveLength(1);
    const [directive] = directiveSegments(text);
    expect(directive).toBeDefined();
    expect(directive?.raw).toContain("tool-super-agent");
  });

  // 用户实测截图 2026-11-12：模型把委派写成「散文 + 内联开栏 + 单行 JSON」——
  // 开栏粘在前一段散文后面（不在独占一行）。宿主照样派发（面板出现等待汇报的
  // pill），转录里却是一整块 JSON：渲染侧与派发侧各抄了一份近似规则，同一段
  // 文本两边判定不一致（渲染侧的协议块扫描先吃掉后面的围栏块，内联载荷就再
  // 也没人认领）。
  describe("散文 + 内联开栏 + 单行 JSON", () => {
    const PAYLOAD = '{"tasks":[{"title":"甲任务","task":"做甲"}]}';
    const PAYLOAD_B = '{"tasks":[{"title":"乙任务","task":"做乙"}]}';

    /** 宿主逐帧扫描（模拟流式分片），返回派发出去的任务标题。 */
    function dispatchedTitles(text: string, chunk: number): string[] {
      let fromOffset = 0;
      let pending: ReturnType<typeof extractSuperDirectives>["pendingOpen"];
      const titles: string[] = [];
      for (let i = 0; i < text.length; i += chunk) {
        const scan = extractSuperDirectives(text.slice(0, i + chunk), fromOffset, pending);
        for (const block of scan.blocks) for (const task of block) titles.push(task.title);
        fromOffset = scan.end;
        pending = scan.pendingOpen;
      }
      return titles;
    }

    /** 转录里出卡片的任务标题。 */
    function renderedTitles(text: string): string[] {
      return directiveSegments(text).flatMap((segment) =>
        segment.display.kind === "tasks" ? segment.display.tasks.map((task) => task.title) : [],
      );
    }

    const FIXTURES: Array<[string, string]> = [
      ["独占收栏", ["我来分派两件事。```super-agent", PAYLOAD, "```", "分派完成。"].join("\n")],
      ["无收栏", ["我来分派两件事。```super-agent", PAYLOAD].join("\n")],
      ["同行 JSON + 同行收栏", "我来分派两件事。```super-agent " + PAYLOAD + " ```"],
      ["后续还有一个独占围栏块", ["我来分派两件事。```super-agent", PAYLOAD, "```", "再补一个：", "```super-agent", PAYLOAD_B, "```"].join("\n")],
    ];

    for (const [name, text] of FIXTURES) {
      it(`宿主派发出来的载荷，转录里一定出卡片（${name}）`, () => {
        const rendered = renderedTitles(text);
        expect(rendered.length).toBeGreaterThan(0);
        // 分片大小不同也不能改变结论：宿主派发过的任务，转录里都有卡片。
        for (const chunk of [1, 3, 16, text.length]) {
          for (const title of dispatchedTitles(text, chunk)) {
            expect(rendered).toContain(title);
          }
        }
      });
    }

    it("流式过程中：宿主一派发，转录当场就出卡片（不等下一帧）", () => {
      const text = ["我来分派两件事。```super-agent", PAYLOAD, "```", "分派完成。"].join("\n");
      let fromOffset = 0;
      let pending: ReturnType<typeof extractSuperDirectives>["pendingOpen"];
      const dispatched: string[] = [];
      for (let i = 0; i < text.length; i += 3) {
        const slice = text.slice(0, i + 3);
        const scan = extractSuperDirectives(slice, fromOffset, pending);
        for (const block of scan.blocks) for (const task of block) dispatched.push(task.title);
        fromOffset = scan.end;
        pending = scan.pendingOpen;
        const rendered = renderedTitles(slice);
        for (const title of dispatched) expect(rendered).toContain(title);
      }
      expect(dispatched).toEqual(["甲任务"]);
    });

    it("载荷没收全时：既不派发也不出卡（收齐了才一起切）", () => {
      const partial = ["我来分派两件事。```super-agent", '{"tasks":[{"title":"甲任务","task":"做'].join("\n");
      expect(extractSuperDirectives(partial).blocks).toHaveLength(0);
      expect(renderedTitles(partial)).toHaveLength(0);
      const full = `${partial}甲"}]}`;
      expect(extractSuperDirectives(full).blocks).toHaveLength(1);
      expect(renderedTitles(full)).toEqual(["甲任务"]);
    });
  });
});

describe("super agent · 归档关键内容指纹（写放大的分流依据）", () => {
  const archive = (sessions: PersistedSuperSession[]) => [{ mainSessionId: "main-1", sessions }];

  it("状态、改动去向、归属变了 → 指纹变（必须立刻落盘）", () => {
    const base = toPersistedSuperSession(
      session({ status: "completed", mainSessionId: "main-1" }),
    );
    const before = superArchiveFingerprint(archive([base]));
    // 终态变了。
    expect(
      superArchiveFingerprint(archive([{ ...base, status: "cancelled" }])),
    ).not.toBe(before);
    // 改动去向变了。
    expect(
      superArchiveFingerprint(
        archive([
          {
            ...base,
            integration: { mode: "merge", state: "merged", at: 1 },
          },
        ]),
      ),
    ).not.toBe(before);
    // 归属变了。
    expect(
      superArchiveFingerprint(archive([{ ...base, mainSessionId: "main-2" }])),
    ).not.toBe(before);
  });

  it("只有展示性字段变了 → 指纹不变（走节流，不必立刻落盘）", () => {
    const base = toPersistedSuperSession(session({ status: "completed" }));
    const before = superArchiveFingerprint(archive([base]));
    const cosmetic = superArchiveFingerprint(
      archive([
        {
          ...base,
          summary: "又多说了一句",
          updatedAt: base.updatedAt + 999,
          reports: [...base.reports, { state: "progress", summary: "干活中", at: 5 }],
        },
      ]),
    );
    expect(cosmetic).toBe(before);
  });

  it("子会话集合变了 → 指纹变（增删都要落盘）", () => {
    const one = toPersistedSuperSession(session({ id: "a" }));
    const two = toPersistedSuperSession(session({ id: "b" }));
    expect(superArchiveFingerprint(archive([one, two]))).not.toBe(
      superArchiveFingerprint(archive([one])),
    );
  });
});
