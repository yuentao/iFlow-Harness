import { describe, it, expect } from "vitest";
import {
  CONTEXT_CHAR_LIMITS,
  truncateChars,
  formatContextSection,
  assembleContextSections,
  FOLDER_LISTING_MAX,
  normalizeFolderRel,
  buildFolderListing,
  formatDiagnosticsReport,
  formatGitStatus,
  buildGitReport,
  extractHtmlText,
  isHttpUrl,
  type DiagnosticLineUi,
} from "../shared/context-source.js";
import type { ContextRefUi } from "../shared/messages.js";

function ctx(kind: ContextRefUi["kind"], label: string, content: string): ContextRefUi {
  return { id: `c-${label}`, kind, label, detail: "", content };
}

/**
 * M2 P0-4 context assembly discipline. The prompt prefix must never start
 * with "/" (CLI slash-command gate) and sections keep composer card order.
 */
describe("context-source assembly (P0-4)", () => {
  it("truncateChars caps and annotates; short text passes through", () => {
    expect(truncateChars("hello", 100)).toBe("hello");
    const long = "x".repeat(50);
    const out = truncateChars(long, 20);
    expect(out.startsWith("x".repeat(20))).toBe(true);
    expect(out).toContain("已截断，共 50 字符");
  });

  it("formatContextSection fences a body containing ``` without escape", () => {
    const body = "code\n```\ninner\n```";
    const section = formatContextSection(ctx("code", "a.ts", body), "关于 `a.ts:1-2`：");
    // fence must be longer than the longest backtick run in the body
    expect(section).toContain("````text");
    expect(section.startsWith("关于 `a.ts:1-2`：\n\n````text\n")).toBe(true);
    expect(section.endsWith("````")).toBe(true);
  });

  it("assembleContextSections keeps card order, skips empty cards, joins with blank line", () => {
    const out = assembleContextSections(
      [ctx("git", "git", "STATUS"), ctx("problems", "p", "   "), ctx("url", "https://x.dev", "TEXT")],
      (c) => `[${c.label}]`,
    );
    expect(out).toBe("[git]\n\n```text\nSTATUS\n```\n\n[https://x.dev]\n\n```text\nTEXT\n```");
    // never slash-leading: the composed prefix starts with the first title
    expect(out.startsWith("/")).toBe(false);
  });

  it("assembleContextSections of nothing is empty (sendPrompt skips the prefix)", () => {
    expect(assembleContextSections([], () => "x")).toBe("");
  });

  it("per-kind limits are the roadmap values", () => {
    expect(CONTEXT_CHAR_LIMITS).toMatchObject({ folder: 16_000, git: 32_000, url: 64_000 });
  });
});

describe("folder listing (P0-4 @/)", () => {
  it("normalizeFolderRel strips ./, trailing slash, backslashes", () => {
    expect(normalizeFolderRel("./src/")).toBe("src");
    expect(normalizeFolderRel("src\\components")).toBe("src/components");
    expect(normalizeFolderRel("/")).toBe("");
    expect(normalizeFolderRel("  ")).toBe("");
  });

  it("lists direct children only: dirs (trailing /) first, hidden entries dropped", () => {
    const rels = [
      "src/App.tsx",
      "src/components/Button.tsx",
      "src/components/Deep/x.tsx",
      "src/.hidden/file.ts",
      "src/styles.css",
      "README.md", // outside the folder
    ];
    const body = buildFolderListing(rels, "src");
    expect(body.split("\n")).toEqual(["- components/", "- App.tsx", "- styles.css"]);
  });

  it("caps at FOLDER_LISTING_MAX with a notice", () => {
    const rels = Array.from({ length: FOLDER_LISTING_MAX + 5 }, (_, i) => `d/f${String(i).padStart(4, "0")}`);
    const body = buildFolderListing(rels, "d");
    expect(body.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(FOLDER_LISTING_MAX);
    expect(body).toContain(`仅列出前 ${FOLDER_LISTING_MAX} 项`);
  });
});

describe("problems / git / url formatters (P0-4)", () => {
  it("diagnostics group by path, one header per file", () => {
    const rows: DiagnosticLineUi[] = [
      { path: "a.ts", line: 3, severityLabel: "错误", message: "boom" },
      { path: "a.ts", line: 9, severityLabel: "警告", message: "meh" },
      { path: "b.ts", line: 1, severityLabel: "错误", message: "other" },
    ];
    expect(formatDiagnosticsReport(rows)).toBe(
      ["a.ts:", "  [错误] L3: boom", "  [警告] L9: meh", "b.ts:", "  [错误] L1: other"].join("\n"),
    );
  });

  it("clean porcelain status maps to the clean-workspace note", () => {
    expect(formatGitStatus("")).toBe("（工作区干净，无未提交变更）");
    expect(formatGitStatus(" M src/a.ts\n?? new.ts\r\n")).toBe("   M src/a.ts\n  ?? new.ts");
  });

  it("git report composes status + diff + truncation marker", () => {
    const report = buildGitReport(" M a.ts", "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n", true);
    expect(report).toContain("状态（git status --porcelain）：");
    expect(report).toContain("  M a.ts");
    expect(report).toContain("变更内容（git diff，未含未跟踪文件的正文）：");
    expect(report).toContain("diff --git a/a.ts");
    expect(report).toContain("已截断");
    // diff-only-clean case: no diff section
    expect(buildGitReport("", "", false)).not.toContain("变更内容");
  });

  it("html extraction drops script/style, decodes entities, keeps text lines", () => {
    const html = `<html><head><title>t</title></head><body><h1>Title</h1><script>evil()</script><style>b{}</style><p>Hello &amp; welcome</p><p>Line&nbsp;2</p></body></html>`;
    const text = extractHtmlText(html);
    expect(text).toBe("Title\nHello & welcome\nLine 2");
    expect(text).not.toContain("evil");
  });

  it("isHttpUrl allows only http/https", () => {
    expect(isHttpUrl("https://example.com/x")).toBe(true);
    expect(isHttpUrl("http://localhost:3000")).toBe(true);
    expect(isHttpUrl("file:///c:/secret")).toBe(false);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
  });
});
