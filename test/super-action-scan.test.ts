/**
 * 管理动作块（```super-agent-actions）的流式扫描回归。
 *
 * 背景（真实故障）：主会话发出了一个合法围栏，宿主既没执行任何动作、也没有
 * 任何提示；同一段文本稍后重发一次就生效了。宿主侧（`panel.ts` 的
 * `scanSuperActions`）的累积方式就是「逐 chunk 追加文本 + 用返回的 `end` 更新
 * 消费偏移」，所以这里用**完全相同的累积方式**驱动 `extractSuperActions`，
 * 在每一个字符位置切分输入 —— 结论不能随分片大小漂移。
 *
 * 核心不变量：`end` 绝不能越过一个尚未解析的合法围栏。
 */
import { describe, expect, it } from "vitest";
import { extractSuperActions, extractSuperDirectives, type SuperAction } from "../shared/super-agent.js";

/** 与 `panel.ts` 的 `scanSuperActions` 完全一致的累积 / 消费方式。 */
function feed(chunks: readonly string[]): {
  actions: SuperAction[];
  invalidBlocks: string[];
  offset: number;
  /** 每次扫描后的动作总数快照（用来钉住「不会执行两次」）。 */
  counts: number[];
} {
  let text = "";
  let offset = 0;
  const actions: SuperAction[] = [];
  const invalidBlocks: string[] = [];
  const counts: number[] = [];
  for (const chunk of chunks) {
    text += chunk;
    const scan = extractSuperActions(text, offset);
    if (scan.end > offset) offset = scan.end;
    actions.push(...scan.actions);
    invalidBlocks.push(...scan.invalidBlocks);
    counts.push(actions.length);
  }
  return { actions, invalidBlocks, offset, counts };
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

const RETRY_ACTION: SuperAction = { action: "retry", sessionId: "super-abc123" };

/** 一个合法的动作围栏。 */
function actionsFence(actions: readonly unknown[]): string {
  return ["```super-agent-actions", JSON.stringify({ actions }), "```"].join("\n");
}

describe("super agent · 动作块扫描（分片无关）", () => {
  // (a) 代表性文本：散文 + 工具调用式标记（宿主不认这种写法）+ 错误文本 +
  // 一个完整的动作围栏 + 结尾散文。每一个字符位置切成两段 / 三段，动作都必须
  // 恰好被解析一次。
  const representative = [
    "看板上的 super-abc123 已经中断了，我让它重试一下。",
    "",
    "<tool_name>super-agent-actions</tool_name>",
    '{"actions":[{"action":"retry","sessionId":"super-abc123"}]}',
    "",
    "工具调用写法宿主认不出来，换成围栏：",
    "",
    actionsFence([RETRY_ACTION]),
    "",
    "发完这条，看板应该立刻变成运行中。",
  ].join("\n");

  it("(a) 每个字符位置切成两段：动作恰好执行一次", () => {
    const failures: string[] = [];
    for (const { at, chunks } of everyTwoWaySplit(representative)) {
      const result = feed(chunks);
      if (result.actions.length !== 1 || result.invalidBlocks.length !== 0) {
        failures.push(`split@${at}: actions=${JSON.stringify(result.actions)} invalid=${result.invalidBlocks.length}`);
      }
      if (result.counts.some((count) => count > 1)) {
        failures.push(`split@${at}: 同一段文本被执行了两次（${result.counts.join(",")}）`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("(a) 每个字符位置切成三段：动作恰好执行一次", () => {
    const failures: string[] = [];
    for (const { at, chunks } of everyThreeWaySplit(representative)) {
      const result = feed(chunks);
      if (result.actions.length !== 1 || result.invalidBlocks.length !== 0) {
        failures.push(`split@${at.join(",")}: actions=${JSON.stringify(result.actions)} invalid=${result.invalidBlocks.length}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("(a) 被放弃的前一个围栏（漏了收栏）不能吞掉后面那个完整围栏", () => {
    // 真实形态：模型先按工具调用式写了一遍（围栏 + 占位符载荷），却没写收栏，
    // 紧接着又写了一个完整的动作块。旧实现会把后一个围栏的开栏当成前一个块的
    // 收栏吃掉 —— 两个块都不执行，且完全静默。
    const text = [
      "先试一次：",
      "```super-agent-actions",
      '{"actions":[{"action":"retry","sessionId":"<id>"}]}',
      actionsFence([RETRY_ACTION]),
      "",
      "这次应该能生效。",
    ].join("\n");
    const failures: string[] = [];
    for (const { at, chunks } of everyTwoWaySplit(text)) {
      const result = feed(chunks);
      if (result.actions.length !== 1) {
        failures.push(`split@${at}: actions=${JSON.stringify(result.actions)} invalid=${result.invalidBlocks.length} end=${result.offset}`);
      }
    }
    expect(failures).toEqual([]);
  });

  // (b) 同一段文本里先有委派围栏、后有动作围栏 —— 两者各自解析一次。
  it("(b) 委派围栏与动作围栏各自解析一次（含分片）", () => {
    const text = [
      "先派一个子会话，再让另一个重试。",
      "",
      "```super-agent",
      JSON.stringify({ tasks: [{ title: "跑测试", task: "npm test 并汇报真实输出" }] }),
      "```",
      "",
      "然后管理一下旧的那个：",
      "",
      actionsFence([RETRY_ACTION]),
      "",
      "结束。",
    ].join("\n");
    const failures: string[] = [];
    for (const { at, chunks } of everyTwoWaySplit(text)) {
      // 两条通道各用自己的累积方式（宿主也是两条独立扫描）。
      let delegationText = "";
      let delegationOffset = 0;
      let tasks = 0;
      let actionsText = "";
      let actionsOffset = 0;
      const actions: SuperAction[] = [];
      for (const chunk of chunks) {
        delegationText += chunk;
        const directive = extractSuperDirectives(delegationText, delegationOffset);
        if (directive.end > delegationOffset) delegationOffset = directive.end;
        tasks += directive.blocks.reduce((sum, block) => sum + block.length, 0);

        actionsText += chunk;
        const scan = extractSuperActions(actionsText, actionsOffset);
        if (scan.end > actionsOffset) actionsOffset = scan.end;
        actions.push(...scan.actions);
      }
      if (tasks !== 1 || actions.length !== 1) {
        failures.push(`split@${at}: tasks=${tasks} actions=${JSON.stringify(actions)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  // (c) 未闭合的动作围栏（流式半截）之后再来一个完整围栏 —— 后者必须被解析，
  // 不能因为前者把消费偏移推过去而丢失。
  it("(c) 未闭合的围栏之后那个完整围栏必须被解析", () => {
    const text = [
      "```super-agent-actions",
      '{"actions":[{"action":"cancel","sessionId":"super-half"}',
      "",
      "（上面那段是半截的，重写一个）",
      "",
      actionsFence([RETRY_ACTION]),
      "",
      "完成。",
    ].join("\n");
    const failures: string[] = [];
    for (const { at, chunks } of everyTwoWaySplit(text)) {
      const result = feed(chunks);
      if (!result.actions.some((action) => action.sessionId === "super-abc123")) {
        failures.push(`split@${at}: actions=${JSON.stringify(result.actions)} end=${result.offset}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("(c) 半截围栏紧贴完整围栏（中间没有收栏）也不能把后者吞掉", () => {
    const text = [
      "```super-agent-actions",
      '{"actions":[{"action":"cancel","sessionId":"super-half"}',
      actionsFence([RETRY_ACTION]),
    ].join("\n");
    const scan = extractSuperActions(text);
    expect(scan.actions).toEqual([RETRY_ACTION]);
  });

  // (d) 占位符 id 静默跳过；非法 JSON 进 invalidBlocks。
  it("(d) 占位符 id 静默跳过（不报错、不执行）", () => {
    const scan = extractSuperActions(actionsFence([{ action: "retry", sessionId: "<id>" }]));
    expect(scan.actions).toEqual([]);
    expect(scan.invalidBlocks).toEqual([]);
    expect(scan.sawFence).toBe(true);
  });

  it("(d) 非法 JSON 进 invalidBlocks，且不会执行任何动作", () => {
    const text = ["```super-agent-actions", "{nope}", "```", "", actionsFence([RETRY_ACTION])].join("\n");
    const scan = extractSuperActions(text);
    expect(scan.actions).toEqual([RETRY_ACTION]);
    expect(scan.invalidBlocks).toHaveLength(1);
  });

  it("没有围栏时 sawFence 为 false（宿主据此不刷日志）", () => {
    expect(extractSuperActions("只是普通散文，没有任何协议块。").sawFence).toBe(false);
  });

  // (e) 真实故障形态（2026-11-14）：主会话先发一个**漏收栏**的动作块，紧接着
  // 发一个委派块。动作块的收栏搜索被委派块的开栏截断 → 旧实现判「未闭合」
  // → 扫描停在 pending → cancel 被**静默丢弃**（子会话还在跑，重发一次才生效）。
  it("(e) 漏收栏的动作块紧跟委派围栏：动作仍被执行、委派仍被派发", () => {
    const text = [
      "先取消旧的那个，再派一个新的：",
      "```super-agent-actions",
      JSON.stringify({ actions: [{ action: "cancel", sessionId: "super-old" }] }),
      "```super-agent",
      JSON.stringify({ tasks: [{ title: "跑测试", task: "npm test 并汇报真实输出" }] }),
      "```",
      "",
      "结束。",
    ].join("\n");

    // 整段：动作一次、委派一次。
    const whole = feed([text]);
    expect(whole.actions).toEqual([{ action: "cancel", sessionId: "super-old" }]);
    expect(whole.invalidBlocks).toEqual([]);

    // 每个字符位置切两段：结论不能随分片大小漂移（两条通道各扫各的）。
    const failures: string[] = [];
    for (const { at, chunks } of everyTwoWaySplit(text)) {
      let delegationText = "";
      let delegationOffset = 0;
      let tasks = 0;
      let actionsText = "";
      let actionsOffset = 0;
      const actions: SuperAction[] = [];
      for (const chunk of chunks) {
        delegationText += chunk;
        const directive = extractSuperDirectives(delegationText, delegationOffset);
        if (directive.end > delegationOffset) delegationOffset = directive.end;
        tasks += directive.blocks.reduce((sum, block) => sum + block.length, 0);

        actionsText += chunk;
        const scan = extractSuperActions(actionsText, actionsOffset);
        if (scan.end > actionsOffset) actionsOffset = scan.end;
        actions.push(...scan.actions);
      }
      if (tasks !== 1) {
        failures.push(`split@${at}: tasks=${tasks}`);
      }
      if (actions.length !== 1 || actions[0]?.sessionId !== "super-old") {
        failures.push(`split@${at}: actions=${JSON.stringify(actions)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  // (f) 动作块与委派块**相邻**书写（各自带收栏）：两者都不该被对方吞掉。
  it("(f) 动作块与委派块相邻书写：两者各自解析一次（含分片）", () => {
    const text = [
      "```super-agent-actions",
      JSON.stringify({ actions: [{ action: "cancel", sessionId: "super-old" }] }),
      "```",
      "```super-agent",
      JSON.stringify({ tasks: [{ title: "跑测试", task: "npm test 并汇报真实输出" }] }),
      "```",
    ].join("\n");
    const failures: string[] = [];
    for (const { at, chunks } of everyTwoWaySplit(text)) {
      let delegationText = "";
      let delegationOffset = 0;
      let tasks = 0;
      let actionsText = "";
      let actionsOffset = 0;
      const actions: SuperAction[] = [];
      for (const chunk of chunks) {
        delegationText += chunk;
        const directive = extractSuperDirectives(delegationText, delegationOffset);
        if (directive.end > delegationOffset) delegationOffset = directive.end;
        tasks += directive.blocks.reduce((sum, block) => sum + block.length, 0);

        actionsText += chunk;
        const scan = extractSuperActions(actionsText, actionsOffset);
        if (scan.end > actionsOffset) actionsOffset = scan.end;
        actions.push(...scan.actions);
      }
      if (tasks !== 1 || actions.length !== 1) {
        failures.push(`split@${at}: tasks=${tasks} actions=${JSON.stringify(actions)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  // (g) 未闭合的动作围栏必须留下**有内容**的 pending 信号：宿主据此在回合
  // 收尾时留痕（旧实现零日志零 toast —— 动作被静默丢弃）。
  it("(g) 未闭合的动作围栏留下 pending 信号（不再是零痕迹）", () => {
    const text = [
      "```super-agent-actions",
      '{"actions":[{"action":"cancel","sessionId":"super-1"}',
    ].join("\n");
    const scan = extractSuperActions(text);
    expect(scan.sawFence).toBe(true);
    expect(scan.pending).toBe(true);
    expect(scan.actions).toEqual([]);
    // 没收完的正文必须带出来（宿主据此写日志，不能只留一句空话）。
    expect(scan.pendingBody).toContain("cancel");
  });
});
