import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  MAX_MERGE_FACTS,
  buildMergePrompt,
  chunkFacts,
  parseMergeResponse,
  suggestionsToActions,
  type MergeSuggestion,
} from "../src/memory/curate-llm.js";

/**
 * 纯字符串 fixture：不碰临时目录、不调真实模型。模板用一段最小外壳，真实
 * `prompts/memory-curate.md` 只在下面「提示词硬约束」用例里按路径读一次做断言。
 */
const TEMPLATE = [
  "[Memory curation] Merge semantically duplicated facts.",
  "",
  "{{facts}}",
  "",
  'Return { "merges": [...] } only.',
].join("\n");

const FACTS = [
  "使用 pnpm 安装依赖",
  "依赖安装统一用 pnpm",
  "回答使用中文",
  "提交前跑 typecheck",
];

function envelope(merges: unknown): string {
  return JSON.stringify({ merges });
}

describe("buildMergePrompt", () => {
  it("把事实编号后插进模板，编号连续且数量正确", () => {
    const prompt = buildMergePrompt(TEMPLATE, FACTS);
    expect(prompt).not.toContain("{{facts}}");
    for (let i = 0; i < FACTS.length; i++) {
      expect(prompt).toContain(`${i + 1}. ${FACTS[i]}`);
    }
    // 只出现编号 1..N，不越界。
    expect(prompt).not.toContain(`${FACTS.length + 1}. `);
    expect(prompt.split("\n").filter((line) => /^\d+\. /.test(line))).toHaveLength(FACTS.length);
  });

  it("空事实列表插入 (none) 占位而不是留空", () => {
    const prompt = buildMergePrompt(TEMPLATE, []);
    expect(prompt).toContain("(none)");
  });

  it("模板缺少 {{facts}} 时抛错（不静默产出无事实的提示词）", () => {
    expect(() => buildMergePrompt("no placeholder here", FACTS)).toThrow(/{{facts}}/);
  });

  it("事实里的 $& / $1 不被当成替换模式吞掉", () => {
    const tricky = ["使用 $& 与 $1 字面量"];
    const prompt = buildMergePrompt(TEMPLATE, tricky);
    expect(prompt).toContain("1. 使用 $& 与 $1 字面量");
  });
});

describe("提示词硬约束（prompts/memory-curate.md）", () => {
  const promptPath = fileURLToPath(new URL("../prompts/memory-curate.md", import.meta.url));
  const source = readFileSync(promptPath, "utf8");

  it("含事实占位符与严格 JSON 信封", () => {
    expect(source).toContain("{{facts}}");
    expect(source).toContain('"merges"');
    expect(source).toContain('"keep"');
    expect(source).toContain('"absorb"');
    expect(source).toContain('"merged"');
    expect(source).toContain('"reason"');
  });

  it("写明逐字、禁止引入新实体、空合并返回空数组三条硬约束", () => {
    expect(source).toContain("verbatim");
    expect(source).toContain("must not introduce");
    expect(source).toContain('{ "merges": [] }');
  });
});

describe("parseMergeResponse", () => {
  it("正常解析出两条建议", () => {
    const raw = envelope([
      {
        keep: "使用 pnpm 安装依赖",
        absorb: ["依赖安装统一用 pnpm"],
        merged: "依赖统一用 pnpm 安装",
        reason: "同一约定",
      },
      {
        keep: "回答使用中文",
        absorb: ["提交前跑 typecheck"],
        merged: "用中文回答，提交前跑 typecheck",
        reason: "同类约定合并",
      },
    ]);
    const { suggestions, rejected } = parseMergeResponse(raw, FACTS);
    expect(rejected).toEqual([]);
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]?.keep).toBe("使用 pnpm 安装依赖");
    expect(suggestions[0]?.absorb).toEqual(["依赖安装统一用 pnpm"]);
    expect(suggestions[0]?.merged).toBe("依赖统一用 pnpm 安装");
    expect(suggestions[0]?.reason).toBe("同一约定");
  });

  it("容忍信封外的说明文字（取首个 { 到末个 }）", () => {
    const raw = `好的，分析如下：\n${envelope([
      { keep: "回答使用中文", absorb: ["提交前跑 typecheck"], merged: "中文回答并跑 typecheck", reason: "r" },
    ])}\n以上。`;
    const { suggestions } = parseMergeResponse(raw, FACTS);
    expect(suggestions).toHaveLength(1);
  });

  it("拒绝幻觉：keep 不在输入事实中", () => {
    const raw = envelope([
      { keep: "使用 yarn", absorb: ["依赖安装统一用 pnpm"], merged: "使用 yarn", reason: "x" },
    ]);
    const { suggestions, rejected } = parseMergeResponse(raw, FACTS);
    expect(suggestions).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toContain("keep 不在输入事实中");
  });

  it("拒绝幻觉：absorb 含不存在的事实", () => {
    const raw = envelope([
      {
        keep: "使用 pnpm 安装依赖",
        absorb: ["依赖安装统一用 pnpm", "使用 bun 安装依赖"],
        merged: "依赖统一用 pnpm 安装",
        reason: "x",
      },
    ]);
    const { suggestions, rejected } = parseMergeResponse(raw, FACTS);
    expect(suggestions).toEqual([]);
    expect(rejected[0]?.reason).toContain("absorb 项不在输入事实中");
  });

  it("拒绝无意义：merged 与 keep 完全相同", () => {
    const raw = envelope([
      { keep: "使用 pnpm 安装依赖", absorb: ["依赖安装统一用 pnpm"], merged: "使用 pnpm 安装依赖", reason: "x" },
    ]);
    const { suggestions, rejected } = parseMergeResponse(raw, FACTS);
    expect(suggestions).toEqual([]);
    expect(rejected[0]?.reason).toContain("merged 与 keep 完全相同");
  });

  it("拒绝无意义：absorb 为空", () => {
    const raw = envelope([{ keep: "使用 pnpm 安装依赖", absorb: [], merged: "用 pnpm", reason: "x" }]);
    const { suggestions, rejected } = parseMergeResponse(raw, FACTS);
    expect(suggestions).toEqual([]);
    expect(rejected[0]?.reason).toContain("absorb 为空");
  });

  it("拒绝无意义：keep 与 absorb 有交集", () => {
    const raw = envelope([
      { keep: "使用 pnpm 安装依赖", absorb: ["使用 pnpm 安装依赖"], merged: "用 pnpm", reason: "x" },
    ]);
    const { suggestions, rejected } = parseMergeResponse(raw, FACTS);
    expect(suggestions).toEqual([]);
    expect(rejected[0]?.reason).toContain("keep 与 absorb 有交集");
  });

  it("拒绝无意义：absorb 有重复项", () => {
    const raw = envelope([
      {
        keep: "使用 pnpm 安装依赖",
        absorb: ["依赖安装统一用 pnpm", "依赖安装统一用 pnpm"],
        merged: "用 pnpm 安装依赖",
        reason: "x",
      },
    ]);
    const { suggestions, rejected } = parseMergeResponse(raw, FACTS);
    expect(suggestions).toEqual([]);
    expect(rejected[0]?.reason).toContain("absorb 有重复项");
  });

  it("坏 JSON（尾逗号）→ 不抛错，空建议 + rejected", () => {
    const raw = '{ "merges": [ { "keep": "使用 pnpm 安装依赖", }, ] }';
    const result = parseMergeResponse(raw, FACTS);
    expect(result.suggestions).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain("JSON 解析失败");
  });

  it("缺 merges 字段 → 不抛错，空建议 + rejected", () => {
    const result = parseMergeResponse('{ "other": [] }', FACTS);
    expect(result.suggestions).toEqual([]);
    expect(result.rejected[0]?.reason).toContain("merges");
  });

  it("回复是数组而不是信封 → 不抛错，空建议 + rejected", () => {
    const fromArray = parseMergeResponse('[ { "keep": "回答使用中文" }, { "keep": "提交前跑 typecheck" } ]', FACTS);
    expect(fromArray.suggestions).toEqual([]);
    expect(fromArray.rejected).toHaveLength(1);
    expect(fromArray.rejected[0]?.reason).toContain("JSON 解析失败");
  });

  it("merges 不是数组 → 不抛错，空建议 + rejected", () => {
    const result = parseMergeResponse('{ "merges": "nope" }', FACTS);
    expect(result.suggestions).toEqual([]);
    expect(result.rejected[0]?.reason).toContain("缺少 merges 数组");
  });

  it("回复里没有 JSON 对象 → 不抛错，空建议 + rejected", () => {
    const noObject = parseMergeResponse("没有任何 JSON", FACTS);
    expect(noObject.suggestions).toEqual([]);
    expect(noObject.rejected).toHaveLength(1);
    expect(noObject.rejected[0]?.reason).toContain("没有 JSON 对象");
  });

  it("建议项缺字段 → 该条进 rejected，不抛错", () => {
    const raw = envelope([{ absorb: ["依赖安装统一用 pnpm"], merged: "用 pnpm" }]);
    const { suggestions, rejected } = parseMergeResponse(raw, FACTS);
    expect(suggestions).toEqual([]);
    expect(rejected[0]?.reason).toContain("keep 缺失");
  });

  it("部分有效部分无效：有效保留、无效进 rejected", () => {
    const raw = envelope([
      { keep: "使用 pnpm 安装依赖", absorb: ["依赖安装统一用 pnpm"], merged: "依赖统一用 pnpm 安装", reason: "ok" },
      { keep: "不存在的事实", absorb: ["回答使用中文"], merged: "x", reason: "bad" },
      { keep: "回答使用中文", absorb: ["提交前跑 typecheck"], merged: "回答使用中文并跑 typecheck", reason: "ok2" },
    ]);
    const { suggestions, rejected } = parseMergeResponse(raw, FACTS);
    expect(suggestions).toHaveLength(2);
    expect(suggestions.map((s) => s.keep)).toEqual(["使用 pnpm 安装依赖", "回答使用中文"]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toContain("keep 不在输入事实中");
  });

  it("没有可合并项时返回空建议且不产生 rejected", () => {
    const result = parseMergeResponse('{ "merges": [] }', FACTS);
    expect(result.suggestions).toEqual([]);
    expect(result.rejected).toEqual([]);
  });
});

describe("suggestionsToActions", () => {
  const facts = [
    { line: 11, text: "使用 pnpm 安装依赖" },
    { line: 12, text: "依赖安装统一用 pnpm" },
    { line: 13, text: "回答使用中文" },
    { line: 14, text: "提交前跑 typecheck" },
  ];

  const suggestion: MergeSuggestion = {
    keep: "使用 pnpm 安装依赖",
    absorb: ["依赖安装统一用 pnpm"],
    merged: "依赖统一用 pnpm 安装",
    reason: "同一约定",
  };

  it("按文本映射到正确的 line 号并生成 merge 动作", () => {
    const actions = suggestionsToActions([suggestion], facts);
    expect(actions).toEqual([
      { kind: "merge", targetLine: 11, mergeLines: [12], mergedText: "依赖统一用 pnpm 安装" },
    ]);
  });

  it("keep 文本在 facts 中找不到时跳过该建议", () => {
    const actions = suggestionsToActions(
      [{ ...suggestion, keep: "不在列表里的事实" }],
      facts,
    );
    expect(actions).toEqual([]);
  });

  it("任一 absorb 找不到时整条跳过（不留半合并状态）", () => {
    const actions = suggestionsToActions(
      [{ ...suggestion, absorb: ["依赖安装统一用 pnpm", "不存在的事实"] }],
      facts,
    );
    expect(actions).toEqual([]);
  });

  it("absorb 落到 keep 自己那一行时跳过", () => {
    const actions = suggestionsToActions(
      [{ ...suggestion, absorb: ["使用 pnpm 安装依赖"] }],
      facts,
    );
    expect(actions).toEqual([]);
  });

  it("重复映射到同一行的 absorb 静默去重", () => {
    const actions = suggestionsToActions(
      [{ ...suggestion, absorb: ["依赖安装统一用 pnpm", "依赖安装统一用 pnpm"] }],
      facts,
    );
    expect(actions).toHaveLength(1);
    const action = actions[0];
    expect(action?.kind).toBe("merge");
    if (action?.kind === "merge") expect(action.mergeLines).toEqual([12]);
  });

  it("多条建议全部映射（保持输入顺序）", () => {
    const actions = suggestionsToActions(
      [
        suggestion,
        { keep: "回答使用中文", absorb: ["提交前跑 typecheck"], merged: "中文回答并跑 typecheck", reason: "r" },
      ],
      facts,
    );
    expect(actions).toHaveLength(2);
    expect(actions[1]).toEqual({
      kind: "merge",
      targetLine: 13,
      mergeLines: [14],
      mergedText: "中文回答并跑 typecheck",
    });
  });
});

describe("chunkFacts", () => {
  it("按 size 正确分批", () => {
    const facts = Array.from({ length: 7 }, (_, i) => `fact ${i}`);
    expect(chunkFacts(facts, 3)).toEqual([
      ["fact 0", "fact 1", "fact 2"],
      ["fact 3", "fact 4", "fact 5"],
      ["fact 6"],
    ]);
  });

  it("默认按 MAX_MERGE_FACTS 分批", () => {
    const facts = Array.from({ length: MAX_MERGE_FACTS + 1 }, (_, i) => `fact ${i}`);
    const chunks = chunkFacts(facts);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(MAX_MERGE_FACTS);
    expect(chunks[1]).toHaveLength(1);
  });

  it("空数组返回空数组", () => {
    expect(chunkFacts([], 5)).toEqual([]);
  });

  it("非法 size 退回默认上限（不产生死循环/空批）", () => {
    const facts = ["a", "b", "c"];
    expect(chunkFacts(facts, 0)).toEqual([["a", "b", "c"]]);
    expect(chunkFacts(facts, Number.NaN)).toEqual([["a", "b", "c"]]);
  });
});
