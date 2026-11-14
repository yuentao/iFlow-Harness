/**
 * 委派围栏（```super-agent）的收栏解析回归 —— 分片无关。
 *
 * 背景（与 `super-action-scan.test.ts` 同一思路的真实故障）：模型先写了一个
 * **漏收栏**的委派围栏（载荷是完整 JSON），紧接着又写了一个完整的委派 / 动作
 * 围栏。宿主把前一个块的收栏搜索放到了「文本末尾」，于是后一个围栏的**开栏
 * 反引号**被当成前一个块的收栏 —— 后一个块整段被消费掉，任务永远不派发，且
 * 完全静默（既没有 toast，也没有非法块记录）。
 *
 * 宿主侧（`panel.ts` 的 `SuperDirectiveScanner`）的累积方式就是「逐 chunk 追加
 * 文本 + 用返回的 `end` 更新消费偏移」，所以这里用**完全相同的累积方式**驱动
 * `extractSuperDirectives`，在每一个字符位置切分输入 —— 结论不能随分片大小漂移。
 *
 * 核心不变量：`end` 绝不能越过一个尚未解析的合法围栏；同一段文本无论怎么切片，
 * 派发出来的任务数、标题与顺序都必须与一次性喂入完全一致。
 */
import { describe, expect, it } from "vitest";
import {
  extractSuperActions,
  extractSuperDirectives,
  splitSuperDirectiveSegments,
  type SuperAction,
  type SuperTaskSpec,
} from "../shared/super-agent.js";

interface DirectiveFeed {
  blocks: SuperTaskSpec[][];
  /** 派发出来的标题（按派发顺序）。 */
  titles: string[];
  invalidBlocks: number;
  end: number;
  /** 每次扫描后的累计任务数（用来钉住「同一块不会派发两次」）。 */
  counts: number[];
}

/** 与 `panel.ts` 的扫描器完全一致的累积 / 消费方式。 */
function feedDirectives(chunks: readonly string[]): DirectiveFeed {
  let text = "";
  let offset = 0;
  const blocks: SuperTaskSpec[][] = [];
  const counts: number[] = [];
  let invalidBlocks = 0;
  for (const chunk of chunks) {
    text += chunk;
    const scan = extractSuperDirectives(text, offset);
    if (scan.end > offset) offset = scan.end;
    blocks.push(...scan.blocks);
    invalidBlocks += scan.invalidBlocks.length;
    counts.push(blocks.reduce((sum, block) => sum + block.length, 0));
  }
  return {
    blocks,
    titles: blocks.flatMap((block) => block.map((task) => task.title)),
    invalidBlocks,
    end: offset,
    counts,
  };
}

/** 动作通道自己的累积方式（宿主也是两条独立扫描）。 */
function feedActions(chunks: readonly string[]): SuperAction[] {
  let text = "";
  let offset = 0;
  const actions: SuperAction[] = [];
  for (const chunk of chunks) {
    text += chunk;
    const scan = extractSuperActions(text, offset);
    if (scan.end > offset) offset = scan.end;
    actions.push(...scan.actions);
  }
  return actions;
}

/** 把所有二段切分（含空片）都喂一遍。 */
function everyTwoWaySplit(text: string): Array<{ at: number; chunks: string[] }> {
  const out: Array<{ at: number; chunks: string[] }> = [];
  for (let at = 0; at <= text.length; at++) {
    out.push({ at, chunks: [text.slice(0, at), text.slice(at)] });
  }
  return out;
}

/** 把所有三段切分都喂一遍（文本不长时才用，避免用例跑成平方级）。 */
function everyThreeWaySplit(text: string): Array<{ at: number[]; chunks: string[] }> {
  const out: Array<{ at: number[]; chunks: string[] }> = [];
  for (let i = 0; i <= text.length; i++) {
    for (let j = i; j <= text.length; j++) {
      out.push({ at: [i, j], chunks: [text.slice(0, i), text.slice(i, j), text.slice(j)] });
    }
  }
  return out;
}

function delegate(title: string, task: string): string {
  return ["```super-agent", JSON.stringify({ tasks: [{ title, task }] }), "```"].join("\n");
}

function actionsBlock(action: string, sessionId: string): string {
  return ["```super-agent-actions", JSON.stringify({ actions: [{ action, sessionId }] })].join("\n") + "\n```";
}

const RETRY: SuperAction = { action: "retry", sessionId: "super-abc123" };

/** 缺收栏的委派块（载荷是完整 JSON）+ 一个完整的委派块。 */
const ABANDONED_THEN_DELEGATE = [
  "先试一次：",
  "```super-agent",
  JSON.stringify({ tasks: [{ title: "缺收栏", task: "这一块漏了收栏" }] }),
  delegate("真的", "这一块必须派发"),
  "",
  "这次应该能生效。",
].join("\n");

/** 缺收栏的委派块 + 一个完整的动作块。 */
const ABANDONED_THEN_ACTIONS = [
  "先试一次：",
  "```super-agent",
  JSON.stringify({ tasks: [{ title: "缺收栏", task: "这一块漏了收栏" }] }),
  actionsBlock("retry", "super-abc123"),
  "",
  "完成。",
].join("\n");

/** 代表性混排文本（三段切分用例用，刻意压短以控制平方级开销）。 */
const MIXED = [
  "```super-agent",
  JSON.stringify({ tasks: [{ title: "甲", task: "做甲" }] }),
  "```",
  "```super-agent",
  JSON.stringify({ tasks: [{ title: "废", task: "漏了收栏" }] }),
  actionsBlock("cancel", "super-x"),
  delegate("乙", "做乙"),
].join("\n");

describe("super agent · 委派围栏收栏（分片无关）", () => {
  // (a) 前一个块缺收栏、载荷是完整 JSON，紧接着就是一个完整的委派围栏。
  // 旧实现把后者的开栏反引号当成前者的收栏 —— 后者永远不派发，且静默。
  it("(a) 缺收栏的块不能吞掉后面那个完整的 super-agent 块", () => {
    const oneShot = feedDirectives([ABANDONED_THEN_DELEGATE]);
    // 后一个块必须被解析，且恰好一次。
    expect(oneShot.titles.filter((title) => title === "真的")).toEqual(["真的"]);
    expect(oneShot.invalidBlocks).toBe(0);
    // 前一个块的载荷其实已经写全：按载荷收尾收口派发，绝不静默丢弃一份写全的
    // 委派（这也正是「切片与一次性喂入结论一致」的前提 —— 见 (c)）。
    expect(oneShot.titles).toEqual(["缺收栏", "真的"]);

    const failures: string[] = [];
    for (const { at, chunks } of everyTwoWaySplit(ABANDONED_THEN_DELEGATE)) {
      const result = feedDirectives(chunks);
      if (result.titles.join("|") !== oneShot.titles.join("|")) {
        failures.push(`split@${at}: titles=${JSON.stringify(result.titles)} end=${result.end}`);
      }
      if (result.counts.some((count) => count > oneShot.titles.length)) {
        failures.push(`split@${at}: 同一块被派发了两次（${result.counts.join(",")}）`);
      }
    }
    expect(failures).toEqual([]);
  });

  // (b) 两个协议共用同一套收栏判定：委派围栏不能把动作围栏的开栏当成自己的收栏。
  it("(b) 缺收栏的委派块不能吞掉后面那个完整的 super-agent-actions 块", () => {
    const oneShot = feedDirectives([ABANDONED_THEN_ACTIONS]);
    expect(oneShot.invalidBlocks).toBe(0);
    expect(oneShot.titles).toEqual(["缺收栏"]);
    expect(feedActions([ABANDONED_THEN_ACTIONS])).toEqual([RETRY]);

    // 宿主两条通道各自累积，切片后结论不变。
    const failures: string[] = [];
    for (const { at, chunks } of everyTwoWaySplit(ABANDONED_THEN_ACTIONS)) {
      const directives = feedDirectives(chunks);
      const actions = feedActions(chunks);
      if (directives.titles.join("|") !== oneShot.titles.join("|")) {
        failures.push(`split@${at}: titles=${JSON.stringify(directives.titles)}`);
      }
      if (actions.length !== 1 || actions[0]?.sessionId !== RETRY.sessionId) {
        failures.push(`split@${at}: actions=${JSON.stringify(actions)}`);
      }
    }
    expect(failures).toEqual([]);

    // 渲染侧同源：动作围栏必须切出**动作卡**（旧实现里它的开栏被前一个块的收栏
    // 搜索吃掉，动作卡整段消失、转录里只剩一个被吞歪的委派卡）。
    const segments = splitSuperDirectiveSegments(ABANDONED_THEN_ACTIONS);
    const directives = segments.filter((segment) => segment.kind === "directive");
    expect(directives.map((segment) => (segment.kind === "directive" ? segment.language : ""))).toEqual([
      "super-agent",
      "super-agent-actions",
    ]);
    const actionsCard = directives[1];
    expect(actionsCard?.kind === "directive" ? actionsCard.display.kind : "").toBe("actions");
    expect(actionsCard?.kind === "directive" ? actionsCard.raw : "").toContain('"actions"');
    // 委派卡与宿主派发的任务一一对应（缺收栏但载荷写全的块同样被派发）。
    const tasksCard = directives[0];
    expect(tasksCard?.kind === "directive" ? tasksCard.display.kind : "").toBe("tasks");
    expect(tasksCard?.kind === "directive" && tasksCard.display.kind === "tasks"
      ? tasksCard.display.tasks.map((task) => task.title)
      : [],
    ).toEqual(oneShot.titles);
  });

  // 实测（2026-11-14）：流式分片正好断在「行首 ```」与语言词之间。那一行在缓冲
  // 里是裸 ```，被当成前一个块的收栏整行吃掉；下一帧从行中间起扫，认不出开栏。
  it("(b) 分片断在行首 ``` 与语言词之间：后一个围栏不会被前一块当收栏吃掉", () => {
    const chunk1 = [
      "```super-agent",
      JSON.stringify({ tasks: [{ title: "甲", task: "做甲" }] }),
      "```",
    ].join("\n");
    // 末尾那行 ``` 其实是下一个围栏的开栏（语言词还在下一帧）。
    const chunk2 = `super-agent\n${JSON.stringify({ tasks: [{ title: "乙", task: "做乙" }] })}\n\`\`\`\n`;
    const result = feedDirectives([chunk1, chunk2]);
    expect(result.titles).toEqual(["甲", "乙"]);
    expect(result.counts).toEqual([1, 2]);
  });

  // (c) 逐字符切分：结论必须与一次性喂入完全一致（任务数、标题逐字相同，不重复）。
  it("(c) 每个字符位置切成两段：结果与一次性喂入一致", () => {
    const oneShot = feedDirectives([MIXED]);
    // 「废」那块的载荷是完整 JSON，只是漏了收栏 —— 按载荷收尾收口派发，
    // 不静默丢掉一份写全了的委派。
    expect(oneShot.titles).toEqual(["甲", "废", "乙"]);
    const oneShotActions = feedActions([MIXED]);
    expect(oneShotActions).toEqual([{ action: "cancel", sessionId: "super-x" }]);

    const failures: string[] = [];
    for (const { at, chunks } of everyTwoWaySplit(MIXED)) {
      const directives = feedDirectives(chunks);
      const actions = feedActions(chunks);
      if (directives.titles.join("|") !== oneShot.titles.join("|")) {
        failures.push(`split@${at}: titles=${JSON.stringify(directives.titles)} end=${directives.end}`);
      }
      if (directives.counts.some((count) => count > oneShot.titles.length)) {
        failures.push(`split@${at}: 重复派发（${directives.counts.join(",")}）`);
      }
      if (JSON.stringify(actions) !== JSON.stringify(oneShotActions)) {
        failures.push(`split@${at}: actions=${JSON.stringify(actions)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("(c) 每个字符位置切成三段：结果与一次性喂入一致", () => {
    const oneShot = feedDirectives([MIXED]);
    const oneShotActions = feedActions([MIXED]);

    const failures: string[] = [];
    for (const { at, chunks } of everyThreeWaySplit(MIXED)) {
      const directives = feedDirectives(chunks);
      const actions = feedActions(chunks);
      if (directives.titles.join("|") !== oneShot.titles.join("|")) {
        failures.push(`split@${at.join(",")}: titles=${JSON.stringify(directives.titles)}`);
      }
      if (JSON.stringify(actions) !== JSON.stringify(oneShotActions)) {
        failures.push(`split@${at.join(",")}: actions=${JSON.stringify(actions)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  // (d) 正常形态：两个完整围栏各自解析一次（含任意切片）。
  it("(d) 两个完整围栏各自解析一次", () => {
    const text = ["先派两个：", delegate("甲", "做甲"), "", delegate("乙", "做乙"), "", "结束。"].join("\n");
    const oneShot = feedDirectives([text]);
    expect(oneShot.titles).toEqual(["甲", "乙"]);
    expect(oneShot.invalidBlocks).toBe(0);

    const failures: string[] = [];
    for (const { at, chunks } of everyTwoWaySplit(text)) {
      const result = feedDirectives(chunks);
      if (result.titles.join("|") !== oneShot.titles.join("|")) {
        failures.push(`split@${at}: titles=${JSON.stringify(result.titles)}`);
      }
      if (result.counts.some((count) => count > 2)) {
        failures.push(`split@${at}: 重复派发（${result.counts.join(",")}）`);
      }
    }
    expect(failures).toEqual([]);
  });

  // 渲染侧与宿主派发同源：同段文本切出的任务卡与派发出来的任务一一对应。
  it("(d) 转录切出的任务卡与派发的任务一一对应", () => {
    const text = ["先派两个：", delegate("甲", "做甲"), "", delegate("乙", "做乙")].join("\n");
    const dispatched = feedDirectives([text]).titles;
    const cards = splitSuperDirectiveSegments(text)
      .filter((segment) => segment.kind === "directive")
      .flatMap((segment) => (segment.kind === "directive" && segment.display.kind === "tasks" ? segment.display.tasks : []))
      .map((task) => task.title);
    expect(cards).toEqual(dispatched);
  });

  // 未闭合块在流式中间态仍停在开栏处等待（不提前派发、不报非法）。
  it("流式中间态：载荷没写全就停在开栏处等后续 chunk", () => {
    const head = ["```super-agent", '{"tasks":[{"title":"甲","task":"做甲"'].join("\n");
    const scan = extractSuperDirectives(head);
    expect(scan.blocks).toHaveLength(0);
    expect(scan.invalidBlocks).toHaveLength(0);
    expect(scan.pendingOpen?.lineStart).toBe(0);
    const done = feedDirectives([head, '}]}\n```\n']);
    expect(done.titles).toEqual(["甲"]);
  });

  // 占位符标题 / 非法 JSON 的既有语义不变。
  it("占位符块静默跳过、非法 JSON 仍只记 invalidBlocks", () => {
    const placeholder = feedDirectives([
      ["```super-agent", '{"tasks":[{"title":"<标题>","task":"<说明>"}]}', "```"].join("\n"),
    ]);
    expect(placeholder.titles).toEqual([]);
    expect(placeholder.invalidBlocks).toBe(1);

    const invalid = feedDirectives([
      ["```super-agent", "{not json}", "```", "", delegate("甲", "做甲")].join("\n"),
    ]);
    expect(invalid.titles).toEqual(["甲"]);
    expect(invalid.invalidBlocks).toBe(1);
  });
});
