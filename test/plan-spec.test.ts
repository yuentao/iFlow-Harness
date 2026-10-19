import { describe, expect, it } from "vitest";
import { planSpecContent, planSpecFileName, planChecklistEntries } from "../shared/plan-spec";

const AT = new Date(2026, 9, 18, 15, 30, 5);

describe("planSpecFileName", () => {
  it("prefixes a sortable timestamp and slugs the first meaningful line", () => {
    expect(planSpecFileName("## Fix Login Flow\n\n- read code", AT)).toBe(
      "20261018-153005-fix-login-flow.md",
    );
  });

  it("keeps CJK characters and strips filesystem-hostile punctuation", () => {
    expect(planSpecFileName("实现 登录/注册：并发安全?", AT)).toBe(
      "20261018-153005-实现-登录-注册-并发安全.md",
    );
  });

  it("falls back to `plan` when the text has no usable line", () => {
    expect(planSpecFileName("   \n\n###   ", AT)).toBe("20261018-153005-plan.md");
  });

  it("caps long titles", () => {
    const name = planSpecFileName("a".repeat(120), AT);
    expect(name.length).toBeLessThanOrEqual("20261018-153005-".length + 40 + ".md".length);
  });
});

describe("planSpecContent", () => {
  it("writes frontmatter, session id and the plan verbatim", () => {
    const content = planSpecContent("# Plan\n\n- [ ] step one", {
      sessionId: "sess-1",
      createdAt: AT,
    });
    expect(content).toContain('title: "Plan"');
    expect(content).toContain(`created: ${AT.toISOString()}`);
    expect(content).toContain("session: sess-1");
    expect(content).toMatch(/---\n\n# Plan\n\n- \[ \] step one\n$/);
  });

  it("omits an empty session id", () => {
    const content = planSpecContent("Do the thing", { sessionId: "  ", createdAt: AT });
    expect(content).not.toContain("session:");
    expect(content).toContain("Do the thing");
  });
});

describe("planChecklistEntries", () => {
  it("parses bullet and numbered list items as pending entries", () => {
    const entries = planChecklistEntries(
      "# 计划\n\n- 第一步\n* 第二步\n1. 第三步\n2) 第四步\n",
    );
    expect(entries).toEqual([
      { content: "第一步", status: "pending" },
      { content: "第二步", status: "pending" },
      { content: "第三步", status: "pending" },
      { content: "第四步", status: "pending" },
    ]);
  });

  it("tolerates checkbox forms and strips inline markdown emphasis", () => {
    const entries = planChecklistEntries("- [ ] 做 **事情**\n- [x] 做 `另一件`\n");
    expect(entries).toEqual([
      { content: "做 事情", status: "pending" },
      { content: "做 另一件", status: "pending" },
    ]);
  });

  it("falls back to ## / ### headings when there are no list items", () => {
    const entries = planChecklistEntries("# 总计划\n\n## 准备\n说明\n### 实施\n细节\n");
    expect(entries).toEqual([
      { content: "准备", status: "pending" },
      { content: "实施", status: "pending" },
    ]);
  });

  it("returns null below two usable items (one-item card is noise)", () => {
    expect(planChecklistEntries("只有一段散文，没有任何列表")).toBeNull();
    expect(planChecklistEntries("- 只有一项")).toBeNull();
    expect(planChecklistEntries("## 只有一个章节")).toBeNull();
  });

  it("caps the checklist at 20 items", () => {
    const plan = Array.from({ length: 30 }, (_, i) => `- 第 ${i + 1} 步`).join("\n");
    const entries = planChecklistEntries(plan);
    expect(entries).toHaveLength(20);
    expect(entries?.[19]?.content).toBe("第 20 步");
  });
});
