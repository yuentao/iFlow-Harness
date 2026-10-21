import { describe, it, expect } from "vitest";
import type { Block } from "../shared/messages.js";
import {
  buildExtractionConversation,
  normalizeFact,
  parseCandidates,
} from "../src/memory/extract.js";

describe("memory extraction conversation excerpt", () => {
  it("keeps recent user/assistant text and skips tool blocks", () => {
    const blocks: Block[] = [
      { kind: "user", text: "以后用 pnpm 安装依赖" },
      { kind: "text", text: "好的，我会记住。" },
      { kind: "tool", toolCallId: "t1", toolName: "x", title: "x", toolKind: "other", status: "completed" } as Block,
    ];
    const conversation = buildExtractionConversation(blocks);
    expect(conversation).toContain("用户：以后用 pnpm 安装依赖");
    expect(conversation).toContain("助手：好的，我会记住。");
    expect(conversation).not.toContain("t1");
  });

  it("clips an overlong block to its tail within the budget", () => {
    const blocks: Block[] = [
      { kind: "user", text: "开头".repeat(400) },
      { kind: "text", text: "结尾结论" },
    ];
    const conversation = buildExtractionConversation(blocks, { maxInputChars: 200 });
    expect(conversation).toContain("结尾结论");
    expect(conversation.length).toBeLessThanOrEqual(240);
  });

  it("skips system notices and returns empty for a transcript without prose", () => {
    const blocks: Block[] = [
      { kind: "text", text: "正在压缩聊天历史…", system: true } as Block,
      { kind: "tool", toolCallId: "t2", toolName: "x", title: "x", toolKind: "other", status: "completed" } as Block,
    ];
    expect(buildExtractionConversation(blocks)).toBe("");
  });
});

describe("memory candidate parsing", () => {
  it("parses a JSON code fence and validates fields", () => {
    const raw = [
      "```json",
      JSON.stringify({
        facts: [
          { text: "以后用 pnpm", scope: "project", category: "convention", confidence: 0.9 },
          { text: "回答使用中文", scope: "global", category: "preference", confidence: 0.8 },
        ],
      }),
      "```",
    ].join("\n");
    const out = parseCandidates(raw, { allowProject: true });
    expect(out).toHaveLength(2);
    expect(out[0]?.scope).toBe("project");
    expect(out[1]?.category).toBe("preference");
  });

  it("drops short, long, low-confidence and duplicate candidates", () => {
    const raw = JSON.stringify({
      facts: [
        { text: "x", scope: "global", confidence: 0.9 },
        { text: "a".repeat(301), scope: "global", confidence: 0.9 },
        { text: "低置信度事实内容", scope: "global", confidence: 0.2 },
        { text: "重复的偏好内容", scope: "global", confidence: 0.9 },
        { text: "重复的偏好内容！", scope: "global", confidence: 0.9 },
      ],
    });
    const out = parseCandidates(raw, { existingFacts: ["重复的偏好内容"] });
    expect(out).toHaveLength(0);
  });

  it("downgrades project scope when no project is available", () => {
    const raw = JSON.stringify({
      facts: [{ text: "项目内使用 npm test", scope: "project", confidence: 0.9 }],
    });
    const out = parseCandidates(raw, { allowProject: false });
    expect(out[0]?.scope).toBe("global");
  });

  it("caps the batch at five facts", () => {
    const raw = JSON.stringify({
      facts: Array.from({ length: 10 }, (_, i) => ({
        text: `长期约定编号 ${i}`,
        scope: "global",
        confidence: 0.9,
      })),
    });
    expect(parseCandidates(raw)).toHaveLength(5);
  });

  it("returns [] for malformed JSON", () => {
    expect(parseCandidates("not json")).toEqual([]);
    expect(parseCandidates('{"facts": "nope"}')).toEqual([]);
  });
});

describe("normalizeFact", () => {
  it("ignores punctuation, case and whitespace for dedupe", () => {
    expect(normalizeFact("  Use  PNPM! ")).toBe(normalizeFact("use pnpm"));
    expect(normalizeFact("- 先给结论，再展开。")).toBe("先给结论再展开");
  });
});
