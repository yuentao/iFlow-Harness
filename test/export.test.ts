import { describe, it, expect } from "vitest";
import { redactSecrets, unifiedFromOldNew, transcriptToMarkdown, transcriptToJson } from "../shared/export.js";
import type { Block, ToolBlock } from "../shared/messages.js";

const SECRET = "sk-abcdefghij1234567890";

function toolBlock(overrides: Partial<ToolBlock> = {}): ToolBlock {
  return {
    kind: "tool",
    toolCallId: "t1",
    toolName: "write_file",
    title: "写入 src/a.ts",
    toolKind: "edit",
    status: "completed",
    output: "ok",
    locations: [],
    diff: null,
    ...overrides,
  };
}

describe("redactSecrets", () => {
  it("replaces sk- and sk-ant- shaped keys", () => {
    expect(redactSecrets(`key ${SECRET}`)).toBe("key «redacted»");
    expect(redactSecrets("sk-ant-abcdefghij1234567890")).toBe("«redacted»");
  });

  it("leaves short tokens and ordinary code alone", () => {
    expect(redactSecrets("sk-abc")).toBe("sk-abc");
    expect(redactSecrets("const x = 1;")).toBe("const x = 1;");
  });
});

describe("unifiedFromOldNew", () => {
  it("trims identical prefix and suffix lines", () => {
    const out = unifiedFromOldNew(
      "src/a.ts",
      ["a", "b", "old", "d"].join("\n"),
      ["a", "b", "new", "d"].join("\n"),
    );
    expect(out).toBe("--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3 +3 @@\n-old\n+new");
  });

  it("reports pure additions and deletions", () => {
    const out = unifiedFromOldNew("f", "", "x");
    expect(out).toContain("+++ b/f");
    expect(out).toContain("+x");
  });
});

describe("transcriptToMarkdown", () => {
  it("renders a header with session/model/usage and every block kind", () => {
    const blocks: Block[] = [
      { kind: "user", text: `请用 ${SECRET} 调用接口` },
      { kind: "text", text: "好的，我来处理。" },
      { kind: "thought", text: "先读文件" },
      toolBlock({ output: `token ${SECRET}` }),
      { kind: "plan", entries: [{ content: "第一步", status: "completed" }, { content: "第二步" }] },
      { kind: "compression", notice: "上下文已压缩：1000 → 200", summary: "摘要", newTokenCount: 200 },
      { kind: "subagent", agentId: "a1", taskToolCallId: null, title: "子任务", status: "completed", agentType: "general-purpose", entries: [{ kind: "text", text: "子输出" }] },
      { kind: "text", text: "状态行", system: true },
    ];
    const md = transcriptToMarkdown({
      label: "会话标题",
      sessionId: "s-1",
      modelId: "deepseek-v3",
      blocks,
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1200 },
    });
    expect(md).toContain("# 会话标题");
    expect(md).toContain("- 会话：`s-1`");
    expect(md).toContain("- 模型：`deepseek-v3`");
    expect(md).toContain("Token 估算");
    expect(md).toContain("## 👤 用户");
    expect(md).toContain("## 🤖 助手");
    expect(md).toContain("> **思考**");
    expect(md).toContain("### 计划");
    expect(md).toContain("上下文压缩");
    expect(md).toContain("子代理 子任务");
    expect(md).toContain("> _状态行_");
    // Credentials never leave the trust boundary.
    expect(md).not.toContain(SECRET);
    expect(md).toContain("«redacted»");
  });

  it("renders a tool diff as a fenced diff block and marks deletions/creations", () => {
    const md = transcriptToMarkdown({
      label: "t",
      sessionId: null,
      modelId: null,
      blocks: [
        toolBlock({ diff: { path: "src/a.ts", oldText: "a\nb", newText: "a\nc" } }),
        toolBlock({ diff: { path: "src/gone.ts", oldText: "x", newText: null } }),
        toolBlock({ diff: { path: "src/new.ts", oldText: null, newText: "y" } }),
      ],
    });
    expect(md).toContain("```diff");
    expect(md).toContain("-b");
    expect(md).toContain("+c");
    expect(md).toContain("删除 src/gone.ts");
    expect(md).toContain("新建 src/new.ts");
  });

  it("widens the fence when a tool output itself contains triple backticks", () => {
    const md = transcriptToMarkdown({
      label: "t",
      sessionId: null,
      modelId: null,
      blocks: [toolBlock({ output: "```\nconsole.log(1)\n```" })],
    });
    expect(md).toContain("````");
  });

  it("clips long tool output with a truncation notice", () => {
    const md = transcriptToMarkdown({
      label: "t",
      sessionId: null,
      modelId: null,
      blocks: [toolBlock({ output: "x".repeat(5000) })],
    });
    expect(md).toContain("输出截断");
  });

  it("handles an empty transcript", () => {
    const md = transcriptToMarkdown({ label: "空会话", sessionId: null, modelId: null, blocks: [] });
    expect(md).toContain("# 空会话");
    expect(md).toContain("未知");
  });
});

describe("transcriptToJson", () => {
  it("emits a parseable payload with redacted string leaves", () => {
    const json = transcriptToJson({
      label: `标题 ${SECRET}`,
      sessionId: "s-1",
      blocks: [{ kind: "user", text: SECRET }, toolBlock({ output: SECRET })],
    });
    const parsed = JSON.parse(json);
    expect(parsed.sessionId).toBe("s-1");
    expect(parsed.label).toContain("«redacted»");
    expect(parsed.blocks[0].text).toBe("«redacted»");
    expect(parsed.blocks[1].output).toBe("«redacted»");
    expect(json).not.toContain(SECRET);
  });

  it("keeps non-string fields untouched", () => {
    const parsed = JSON.parse(
      transcriptToJson({ label: "t", sessionId: null, blocks: [toolBlock({ truncatedChars: 42 })] }),
    );
    expect(parsed.blocks[0].truncatedChars).toBe(42);
    expect(parsed.blocks[0].diff).toBeNull();
  });
});
