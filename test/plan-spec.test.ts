import { describe, expect, it } from "vitest";
import { planSpecContent, planSpecFileName } from "../shared/plan-spec";

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
