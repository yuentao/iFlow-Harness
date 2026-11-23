import { describe, it, expect } from "vitest";
import {
  applyCurationPlan,
  computeNextPlanAt,
  estimateMarkdownTokens,
  factFingerprint,
  normalizeFactText,
  parseManagedFacts,
  planCuration,
  shouldRunCuration,
  type CurationPlan,
  type ScheduleState,
} from "../shared/memory-curate.js";

/**
 * Fixture with everything the parser must survive: a fenced block (``` and ~~~)
 * inside the managed section, an @path import inside and outside the section,
 * and other `## ` sections before/after.
 */
const FIXTURE = [
  "# 记忆",
  "",
  "## 项目约定",
  "",
  "@./imports/rules.md",
  "",
  "- 这条在其它区块里，不是托管事实",
  "",
  "## iFlow Added Memories",
  "",
  "- 使用 pnpm",
  "- 使用 pnpm。",
  "- 使用 pnpm",
  "- 回答使用中文",
  "- @./memory-extra.md",
  "```md",
  "- 围栏内的示例条目",
  "```",
  "~~~",
  "- 波浪号围栏内的条目",
  "~~~",
  "",
  "## 已知陷阱",
  "",
  "- 陷阱一",
  "",
].join("\n");

function lineOf(markdown: string, line: string): number {
  return markdown.split("\n").indexOf(line);
}

describe("normalizeFactText / factFingerprint", () => {
  it("mirrors extract.ts normalization (trim, lowercase, bullets, whitespace, punctuation)", () => {
    expect(normalizeFactText("  - Use   pnpm!! ")).toBe("use pnpm");
    expect(normalizeFactText("- 重复  空白。")).toBe("重复 空白");
    expect(normalizeFactText("（括号）【方括号】")).toBe("括号方括号");
  });

  it("puts 'Use  pnpm.' and '- use pnpm' on the same fingerprint", () => {
    expect(factFingerprint("Use  pnpm.")).toBe(factFingerprint("- use pnpm"));
    expect(factFingerprint("Use  pnpm.")).not.toBe(factFingerprint("use npm"));
  });

  it("is deterministic and stable across calls", () => {
    expect(factFingerprint("使用 pnpm 安装依赖")).toBe(factFingerprint("使用 pnpm 安装依赖"));
    expect(factFingerprint("")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("parseManagedFacts", () => {
  it("only reads bullets inside the managed section", () => {
    const facts = parseManagedFacts(FIXTURE);
    expect(facts.map((fact) => fact.text)).toEqual([
      "使用 pnpm",
      "使用 pnpm。",
      "使用 pnpm",
      "回答使用中文",
    ]);
  });

  it("skips fenced entries, @imports and other ## sections", () => {
    const texts = parseManagedFacts(FIXTURE).map((fact) => fact.text);
    expect(texts).not.toContain("围栏内的示例条目");
    expect(texts).not.toContain("波浪号围栏内的条目");
    expect(texts).not.toContain("@./memory-extra.md");
    expect(texts).not.toContain("这条在其它区块里，不是托管事实");
    expect(texts).not.toContain("陷阱一");
  });

  it("reports zero-based line numbers in the whole markdown", () => {
    const facts = parseManagedFacts(FIXTURE);
    expect(facts[0]?.line).toBe(lineOf(FIXTURE, "- 使用 pnpm"));
    expect(facts[1]?.line).toBe(lineOf(FIXTURE, "- 使用 pnpm。"));
    expect(facts[2]?.line).toBe(lineOf(FIXTURE, "- 使用 pnpm") + 2);
    expect(facts[3]?.line).toBe(lineOf(FIXTURE, "- 回答使用中文"));
  });

  it("returns [] when there is no managed section", () => {
    expect(parseManagedFacts("# 只有标题\n\n- 普通条目\n")).toEqual([]);
  });
});

describe("planCuration", () => {
  it("keeps the earliest of three duplicates and drops the rest", () => {
    const plan = planCuration(FIXTURE);
    const dedupe = plan.actions.filter((action) => action.kind === "dedupe");
    expect(dedupe).toHaveLength(1);
    const action = dedupe[0];
    if (action?.kind !== "dedupe") throw new Error("expected dedupe action");
    expect(action.keepLine).toBe(lineOf(FIXTURE, "- 使用 pnpm"));
    expect(action.dropLines).toEqual([
      lineOf(FIXTURE, "- 使用 pnpm。"),
      lineOf(FIXTURE, "- 使用 pnpm") + 2,
    ]);
    expect(plan.droppedFacts).toBe(2);
    expect(plan.archivedFacts).toBe(0);
    expect(plan.mergedFacts).toBe(0);
    expect(plan.actions.some((entry) => entry.kind === "merge")).toBe(false);
  });

  it("deletes facts whose normalized text is empty", () => {
    const markdown = ["## iFlow Added Memories", "", "- ，。", "- 有效事实", ""].join("\n");
    const plan = planCuration(markdown);
    const action = plan.actions.find((entry) => entry.kind === "dedupe");
    if (action?.kind !== "dedupe") throw new Error("expected dedupe action");
    expect(action.dropLines).toEqual([lineOf(markdown, "- ，。")]);
    const applied = applyCurationPlan(markdown, plan);
    expect(applied).not.toContain("- ，。");
    expect(applied).toContain("- 有效事实");
  });

  it("archives low-value facts when the managed section exceeds the budget", () => {
    const markdown = [
      "## iFlow Added Memories",
      "",
      "- 第一条很长的记忆内容，用来占用上下文预算的示例文本甲甲甲甲甲甲甲甲甲甲",
      "- 第二条很长的记忆内容，用来占用上下文预算的示例文本乙乙乙乙乙乙乙乙乙乙",
      "- 第三条很长的记忆内容，用来占用上下文预算的示例文本丙丙丙丙丙丙丙丙丙丙",
      "- 第四条很长的记忆内容，用来占用上下文预算的示例文本丁丁丁丁丁丁丁丁丁丁",
      "",
    ].join("\n");
    const plan = planCuration(markdown, { budgetTokens: 20 });
    expect(plan.archivedFacts).toBeGreaterThan(0);
    expect(plan.actions.some((action) => action.kind === "archive")).toBe(true);
    expect(plan.beforeTokens).toBeGreaterThan(plan.afterTokens);
    expect(plan.estimatedSaving).toBeGreaterThan(0);
    expect(plan.afterTokens).toBeLessThanOrEqual(20);
    // 计划不执行：原 markdown 未变。
    expect(markdown).toContain("第一条很长的记忆内容");
  });

  it("does not archive when under budget", () => {
    const plan = planCuration(FIXTURE, { budgetTokens: 100_000 });
    expect(plan.archivedFacts).toBe(0);
    expect(plan.afterTokens).toBeLessThanOrEqual(plan.beforeTokens);
    expect(plan.estimatedSaving).toBeGreaterThanOrEqual(0);
  });

  it("counts no actions on markdown without the managed marker", () => {
    const plan = planCuration("# 空记忆\n");
    expect(plan.actions).toEqual([]);
    expect(plan.beforeTokens).toBe(0);
    expect(plan.afterTokens).toBe(0);
  });
});

describe("applyCurationPlan", () => {
  it("removes duplicates and keeps one surviving fact", () => {
    const plan = planCuration(FIXTURE);
    const applied = applyCurationPlan(FIXTURE, plan);
    const surviving = applied.split("\n").filter((line) => line === "- 使用 pnpm");
    expect(surviving).toHaveLength(1);
    expect(applied).toContain("- 回答使用中文");
    expect(applied).not.toContain("- 使用 pnpm。");
  });

  it("leaves fences, @imports and other sections byte-identical", () => {
    const applied = applyCurationPlan(FIXTURE, planCuration(FIXTURE));
    expect(applied).toContain("```md\n- 围栏内的示例条目\n```");
    expect(applied).toContain("~~~\n- 波浪号围栏内的条目\n~~~");
    expect(applied).toContain("@./imports/rules.md");
    expect(applied).toContain("- @./memory-extra.md");
    expect(applied).toContain("## 项目约定\n\n@./imports/rules.md\n\n- 这条在其它区块里，不是托管事实");
    expect(applied).toContain("## 已知陷阱\n\n- 陷阱一");
  });

  it("moves archived facts into the Archived Memories section", () => {
    const markdown = ["## iFlow Added Memories", "", "- 归档我", "- 保留我", ""].join("\n");
    const plan: CurationPlan = {
      actions: [{ kind: "archive", lines: [lineOf(markdown, "- 归档我")] }],
      beforeTokens: 0,
      afterTokens: 0,
      estimatedSaving: 0,
      droppedFacts: 0,
      mergedFacts: 0,
      archivedFacts: 1,
    };
    const applied = applyCurationPlan(markdown, plan);
    expect(applied).toContain("- 保留我");
    expect(applied).not.toContain("- 归档我\n- 保留我");
    expect(applied).toContain("## Archived Memories\n- 归档我");
  });

  it("skips an out-of-range line without throwing", () => {
    const plan: CurationPlan = {
      actions: [{ kind: "dedupe", keepLine: 9999, dropLines: [lineOf(FIXTURE, "- 使用 pnpm")] }],
      beforeTokens: 0,
      afterTokens: 0,
      estimatedSaving: 0,
      droppedFacts: 0,
      mergedFacts: 0,
      archivedFacts: 0,
    };
    expect(applyCurationPlan(FIXTURE, plan)).toBe(FIXTURE);
  });

  it("skips drops whose text no longer matches the keep line", () => {
    const plan: CurationPlan = {
      actions: [
        {
          kind: "dedupe",
          keepLine: lineOf(FIXTURE, "- 使用 pnpm"),
          dropLines: [lineOf(FIXTURE, "- 回答使用中文")],
        },
      ],
      beforeTokens: 0,
      afterTokens: 0,
      estimatedSaving: 0,
      droppedFacts: 0,
      mergedFacts: 0,
      archivedFacts: 0,
    };
    expect(applyCurationPlan(FIXTURE, plan)).toBe(FIXTURE);
  });

  it("skips normalize/merge actions that no longer match", () => {
    const plan: CurationPlan = {
      actions: [
        { kind: "normalize", line: lineOf(FIXTURE, "## 项目约定"), nextText: "改标题" },
        {
          kind: "merge",
          targetLine: lineOf(FIXTURE, "- 使用 pnpm"),
          mergeLines: [lineOf(FIXTURE, "- 回答使用中文"), 9999],
          mergedText: "合并后的文本",
        },
      ],
      beforeTokens: 0,
      afterTokens: 0,
      estimatedSaving: 0,
      droppedFacts: 0,
      mergedFacts: 0,
      archivedFacts: 0,
    };
    expect(applyCurationPlan(FIXTURE, plan)).toBe(FIXTURE);
  });

  it("applies reserved merge/normalize actions when they match", () => {
    const markdown = ["## iFlow Added Memories", "", "- 甲事实", "- 乙事实", ""].join("\n");
    const plan: CurationPlan = {
      actions: [
        {
          kind: "merge",
          targetLine: lineOf(markdown, "- 甲事实"),
          mergeLines: [lineOf(markdown, "- 乙事实")],
          mergedText: "甲乙合并",
        },
        { kind: "normalize", line: lineOf(markdown, "- 甲事实"), nextText: "甲事实（规范）" },
      ],
      beforeTokens: 0,
      afterTokens: 0,
      estimatedSaving: 0,
      droppedFacts: 0,
      mergedFacts: 1,
      archivedFacts: 0,
    };
    const applied = applyCurationPlan(markdown, plan);
    expect(applied).toContain("- 甲事实（规范）");
    expect(applied).not.toContain("- 乙事实");
  });
});

describe("estimateMarkdownTokens", () => {
  it("returns 0 for empty input and a positive count otherwise", () => {
    expect(estimateMarkdownTokens("")).toBe(0);
    expect(estimateMarkdownTokens("- 使用 pnpm 安装依赖")).toBeGreaterThan(0);
  });
});

describe("shouldRunCuration", () => {
  const state: ScheduleState = { lastRunAt: "2026-11-20T00:00:00.000Z", failureCount: 0 };
  const now = "2026-11-23T00:00:00.000Z";

  it("runs when over budget even if not due", () => {
    expect(shouldRunCuration(state, now, 30, 500, 100)).toBe(true);
  });

  it("does not run when under budget and not due", () => {
    expect(shouldRunCuration(state, now, 30, 50, 100)).toBe(false);
  });

  it("runs when under budget but due", () => {
    expect(shouldRunCuration(state, now, 2, 50, 100)).toBe(true);
  });

  it("runs when over budget and due", () => {
    expect(shouldRunCuration(state, now, 2, 500, 100)).toBe(true);
  });

  it("runs when it has never run before", () => {
    expect(shouldRunCuration({ failureCount: 0 }, now, 30, 0, 100)).toBe(true);
  });
});

describe("computeNextPlanAt", () => {
  it("adds the interval in days", () => {
    expect(computeNextPlanAt("2026-11-20T00:00:00.000Z", 3)).toBe("2026-11-23T00:00:00.000Z");
    expect(computeNextPlanAt("2026-11-20T00:00:00.000Z", 0)).toBe("2026-11-20T00:00:00.000Z");
  });

  it("returns an empty string for a missing/invalid lastRunAt", () => {
    expect(computeNextPlanAt(undefined, 3)).toBe("");
    expect(computeNextPlanAt("not-a-date", 3)).toBe("");
  });
});
