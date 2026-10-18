import { describe, it, expect } from "vitest";
import type { Block } from "../shared/messages.js";
import {
  buildExtractionPrompt,
  normalizeFact,
  parseCandidates,
} from "../src/memory/extract.js";

describe("memory extraction prompt", () => {
  it("includes recent user/assistant text and existing facts", () => {
    const blocks: Block[] = [
      { kind: "user", text: "以后用 pnpm 安装依赖" },
      { kind: "text", text: "好的，我会记住。" },
      { kind: "tool", toolCallId: "t1", toolName: "x", title: "x", toolKind: "other", status: "completed" } as Block,
    ];
    const prompt = buildExtractionPrompt(blocks, ["回答使用中文"]);
    expect(prompt).toContain("用户：以后用 pnpm 安装依赖");
    expect(prompt).toContain("助手：好的，我会记住。");
    expect(prompt).toContain("- 回答使用中文");
    expect(prompt).toContain('"facts"');
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
