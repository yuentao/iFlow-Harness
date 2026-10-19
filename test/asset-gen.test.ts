import { describe, expect, it } from "vitest";
import { buildAssetGenPrompt, normalizeGeneratedAsset } from "../shared/asset-gen";

describe("buildAssetGenPrompt", () => {
  it("states the kind contract, the given name and the requirement", () => {
    const prompt = buildAssetGenPrompt("agent", "docs-writer", "写文档并校对术语");
    expect(prompt).toContain("subagent definition");
    expect(prompt).toContain("`name`");
    expect(prompt).toContain("allowed-tools");
    expect(prompt).toContain("Name: docs-writer");
    expect(prompt).toContain("写文档并校对术语");
  });

  it("asks for the file only — no prose, no fences", () => {
    const prompt = buildAssetGenPrompt("skill", "pdf", "填表");
    expect(prompt).toContain("NOTHING else");
    expect(prompt).toContain("no markdown code fences");
    expect(prompt).toContain("starting with the opening `---`");
  });

  it("switches the contract per kind", () => {
    expect(buildAssetGenPrompt("command", "fix", "x")).toContain("{{args}}");
    expect(buildAssetGenPrompt("skill", "pdf", "x")).toContain("step-by-step procedure");
    expect(buildAssetGenPrompt("agent", "a", "x")).not.toContain("{{args}}");
  });

  it("omits the Name line before the user typed one and tolerates no requirement", () => {
    expect(buildAssetGenPrompt("command", "   ", "")).not.toContain("Name:");
    expect(buildAssetGenPrompt("command", "", "")).toContain("(none given");
  });
});

describe("normalizeGeneratedAsset", () => {
  it("strips a wrapping code fence", () => {
    const out = normalizeGeneratedAsset(
      "```markdown\n---\ndescription: d\n---\n\nbody\n```",
      "command",
      "x",
    );
    expect(out.startsWith("---\ndescription: d")).toBe(true);
    expect(out).not.toContain("```");
  });

  it("prepends the kind frontmatter when the model returned bare prose", () => {
    const out = normalizeGeneratedAsset("just a body", "skill", "pdf");
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("name: pdf");
    expect(out).toContain("just a body");
  });

  it("injects a missing name key for agent/skill, which the CLI would skip", () => {
    const out = normalizeGeneratedAsset("---\ndescription: d\n---\n\nbody", "agent", "docs");
    expect(out).toContain("name: docs");
    expect(out.startsWith("---\nname: docs\n")).toBe(true);
  });

  it("accepts agent-type as the name key and never duplicates one", () => {
    const src = "---\nagent-type: explore\n---\n\nbody";
    expect(normalizeGeneratedAsset(src, "agent", "x")).not.toContain("name: x");
    const named = "---\nname: mine\ndescription: d\n---\n\nbody";
    const out = normalizeGeneratedAsset(named, "agent", "other");
    expect(out).toContain("name: mine");
    expect(out).not.toContain("name: other");
  });

  it("leaves a command's frontmatter alone and ends with exactly one newline", () => {
    const src = "---\ndescription: d\n---\n\nbody";
    expect(normalizeGeneratedAsset(src, "command", "x")).toBe(`${src}\n`);
    expect(normalizeGeneratedAsset(`${src}\n`, "command", "x")).toBe(`${src}\n`);
  });

  it("falls back to the skeleton on an empty answer", () => {
    const out = normalizeGeneratedAsset("   ", "skill", "pdf");
    expect(out).toContain("name: pdf");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("uses a placeholder name when none was typed", () => {
    expect(normalizeGeneratedAsset("", "agent", "  ")).toContain("name: generated");
  });
});
