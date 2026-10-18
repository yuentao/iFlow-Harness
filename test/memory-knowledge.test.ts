import { describe, it, expect } from "vitest";
import {
  MANAGED_END,
  MANAGED_START,
  buildIncrementalKnowledgePrompt,
  buildKnowledgePrompt,
  buildKnowledgeSources,
  buildWorkspaceDigest,
  diffKnowledgeSources,
  hasKnowledgeChanges,
  parseKnowledgeManifest,
  readManagedKnowledgeImports,
  sanitizeGeneratedMarkdown,
  setManagedKnowledgeBlock,
} from "../src/memory/knowledge.js";

describe("managed knowledge block", () => {
  it("appends, replaces and removes only the managed block", () => {
    const base = "# 项目记忆\n\n## 约定\n\n- keep me\n";
    const added = setManagedKnowledgeBlock(base, [".iflow/knowledge/index.md"]);
    expect(added).toContain(MANAGED_START);
    expect(added).toContain("@.iflow/knowledge/index.md");
    expect(added).toContain(MANAGED_END);
    expect(added).toContain("- keep me");
    expect(readManagedKnowledgeImports(added)).toEqual([".iflow/knowledge/index.md"]);

    const replaced = setManagedKnowledgeBlock(added, [
      ".iflow/knowledge/index.md",
      ".iflow/knowledge/architecture.md",
    ]);
    expect(readManagedKnowledgeImports(replaced)).toEqual([
      ".iflow/knowledge/index.md",
      ".iflow/knowledge/architecture.md",
    ]);
    expect(replaced.match(new RegExp(MANAGED_START, "g"))).toHaveLength(1);

    const removed = setManagedKnowledgeBlock(replaced, []);
    expect(removed).not.toContain(MANAGED_START);
    expect(removed).toContain("- keep me");
  });

  it("dedupes imports and ignores non-import lines", () => {
    const content = [
      MANAGED_START,
      "## 项目知识库",
      "@.iflow/knowledge/index.md",
      "@.iflow/knowledge/index.md",
      "not an import",
      MANAGED_END,
    ].join("\n");
    expect(readManagedKnowledgeImports(content)).toEqual([".iflow/knowledge/index.md"]);
  });
});

describe("workspace digest", () => {
  it("summarizes top-level entries and key file excerpts", async () => {
    const files = [
      { path: "C:/ws/package.json", rel: "package.json", size: 120, mtimeMs: 1 },
      { path: "C:/ws/src/index.ts", rel: "src/index.ts", size: 80, mtimeMs: 1 },
      { path: "C:/ws/docs/readme.md", rel: "docs/readme.md", size: 40, mtimeMs: 1 },
    ];
    const digest = await buildWorkspaceDigest(files, async (file) =>
      file.endsWith("package.json") ? '{"name":"demo"}' : null,
    );
    expect(digest).toContain("采样文件数：3 / 3");
    expect(digest).toContain("src/");
    expect(digest).toContain('"name":"demo"');
  });

  it("asks for the fixed knowledge structure", () => {
    const prompt = buildKnowledgePrompt("digest");
    expect(prompt).toContain("# 项目知识索引");
    expect(prompt).toContain("## 常用命令");
    expect(prompt).toContain("不要用代码围栏包裹整篇文档");
    expect(prompt).toContain("digest");
  });
});

describe("sanitizeGeneratedMarkdown", () => {
  it("strips an outer fence and ensures the title", () => {
    const clean = sanitizeGeneratedMarkdown("```markdown\n## 概览\n\n内容\n```");
    expect(clean.startsWith("# 项目知识索引")).toBe(true);
    expect(clean).toContain("## 概览");
    expect(clean.endsWith("\n")).toBe(true);
  });

  it("keeps an existing title and truncates extremely long output", () => {
    const clean = sanitizeGeneratedMarkdown("# 我的索引\n\n" + "x".repeat(30_000));
    expect(clean.startsWith("# 我的索引")).toBe(true);
    expect(clean.length).toBeLessThan(20_100);
    expect(clean).toContain("已截断");
  });
});

describe("incremental refresh", () => {
  it("diffs source snapshots and builds an incremental prompt", () => {
    const previous = buildKnowledgeSources([
      { path: "a", rel: "README.md", size: 10, mtimeMs: 1 },
      { path: "b", rel: "src/a.ts", size: 10, mtimeMs: 1 },
      { path: "c", rel: "old.ts", size: 10, mtimeMs: 1 },
    ]);
    const current = buildKnowledgeSources([
      { path: "a", rel: "README.md", size: 12, mtimeMs: 2 },
      { path: "b", rel: "src/a.ts", size: 10, mtimeMs: 1 },
      { path: "d", rel: "new.ts", size: 10, mtimeMs: 3 },
    ]);
    const change = diffKnowledgeSources(previous, current);
    expect(change).toEqual({ added: ["new.ts"], modified: ["README.md"], deleted: ["old.ts"] });
    expect(hasKnowledgeChanges(change)).toBe(true);
    const prompt = buildIncrementalKnowledgePrompt(
      "# 项目知识索引\n\n## 概览\n\nold",
      change,
      "## 顶层结构\nsrc/  (2 files)",
      "### README.md\n# Demo v2",
    );
    expect(prompt).toContain("## 当前索引");
    expect(prompt).toContain("README.md");
    expect(prompt).toContain("new.ts");
    expect(prompt).toContain("old.ts");
    expect(prompt).toContain("不要编造");
  });

  it("parses manifests and rejects invalid payloads", () => {
    const manifest = parseKnowledgeManifest(
      JSON.stringify({
        version: 2,
        generatedAt: "2026-10-18T00:00:00Z",
        model: "mock",
        mode: "incremental",
        docs: [{ path: "index.md", hash: "abc", tokens: 10 }],
        sources: [{ rel: "README.md", size: 1, mtimeMs: 2 }],
      }),
    );
    expect(manifest?.mode).toBe("incremental");
    expect(manifest?.sources[0]?.rel).toBe("README.md");
    expect(parseKnowledgeManifest("not json")).toBeNull();
  });
});
