import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONTEXT_WINDOW,
  normalizeModelId,
  parseContextWindowOverrides,
  parseCostTable,
  resolveContextWindow,
  resolveCost,
  estimateCost,
} from "../shared/context-window.js";

describe("normalizeModelId", () => {
  it("strips provider prefixes and lowercases", () => {
    expect(normalizeModelId("openai/gpt-4o-2024-11-20")).toBe("gpt-4o-2024-11-20");
    expect(normalizeModelId("OpenAI/GPT-4O")).toBe("gpt-4o");
  });

  it("keeps bare ids and trims whitespace", () => {
    expect(normalizeModelId("  glm-4.6  ")).toBe("glm-4.6");
  });

  it("returns empty for null/undefined/blank", () => {
    expect(normalizeModelId(null)).toBe("");
    expect(normalizeModelId(undefined)).toBe("");
    expect(normalizeModelId("   ")).toBe("");
  });
});

describe("parseContextWindowOverrides", () => {
  it("parses model=count entries and floors the value", () => {
    expect(parseContextWindowOverrides(["glm-4.6=200000", "my-model=131072.9"])).toEqual({
      "glm-4.6": 200_000,
      "my-model": 131_072,
    });
  });

  it("drops malformed, non-positive and key-less entries without breaking the rest", () => {
    expect(parseContextWindowOverrides(["noequals", "=128000", "m=0", "m=-1", "m=abc", "ok=128000"])).toEqual({
      ok: 128_000,
    });
  });

  it("normalizes the key (provider prefix + case)", () => {
    expect(parseContextWindowOverrides(["OpenAI/gpt-4o=99999"])).toEqual({ "gpt-4o": 99_999 });
  });

  it("handles undefined / empty input", () => {
    expect(parseContextWindowOverrides(undefined)).toEqual({});
    expect(parseContextWindowOverrides([])).toEqual({});
  });
});

describe("resolveContextWindow", () => {
  it("override wins over the curated table", () => {
    expect(resolveContextWindow("glm-4.6", { "glm-4.6": 4096 })).toEqual({ window: 4096, estimated: false });
  });

  it("curated table hit is not flagged estimated", () => {
    expect(resolveContextWindow("deepseek-v3", {})).toEqual({ window: 128_000, estimated: false });
  });

  it("longest table key wins over a shorter prefix", () => {
    // glm-4.6 (200k) must beat a hypothetical glm-4 prefix; here verified
    // against the real table: glm-4.5 (128k) must not shadow glm-4.6.
    expect(resolveContextWindow("glm-4.6", {}).window).toBe(200_000);
    expect(resolveContextWindow("glm-4.5", {}).window).toBe(128_000);
  });

  it("unknown model falls back to the conservative default and flags estimated", () => {
    expect(resolveContextWindow("totally-unknown-model-x9", {})).toEqual({
      window: DEFAULT_CONTEXT_WINDOW,
      estimated: true,
    });
  });

  it("null model id yields a null window (bar hides the percentage)", () => {
    expect(resolveContextWindow(null, {})).toEqual({ window: null, estimated: false });
    expect(resolveContextWindow("", {})).toEqual({ window: null, estimated: false });
  });
});

describe("parseCostTable / resolveCost", () => {
  it("parses model=input,output entries", () => {
    expect(parseCostTable(["deepseek-v3=0.27,1.1", "my=1.5,2.5"])).toEqual({
      "deepseek-v3": { input: 0.27, output: 1.1 },
      my: { input: 1.5, output: 2.5 },
    });
  });

  it("drops entries with the wrong arity or negative prices", () => {
    expect(parseCostTable(["a=1", "a=1,2,3", "a=-1,2", "a=1,-2", "ok=1,2"])).toEqual({ ok: { input: 1, output: 2 } });
  });

  it("override wins over the curated table", () => {
    expect(resolveCost("glm-4.6", { "glm-4.6": { input: 9, output: 9 } })).toEqual({ input: 9, output: 9 });
  });

  it("curated hit returns the table price", () => {
    expect(resolveCost("gpt-4o", {})).toEqual({ input: 2.5, output: 10 });
  });

  it("unknown model returns null (UI says 无单价)", () => {
    expect(resolveCost("unknown-model", {})).toBeNull();
    expect(resolveCost(null, {})).toBeNull();
  });
});

describe("estimateCost", () => {
  it("computes per-million-token USD", () => {
    // 1M input @ $2 + 1M output @ $8 = $10
    expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, { input: 2, output: 8 })).toBe(10);
  });

  it("handles sub-cent figures without rounding away precision", () => {
    const out = estimateCost({ inputTokens: 10_000, outputTokens: 1_000 }, { input: 0.27, output: 1.1 });
    expect(out).toBeCloseTo(0.0038, 6);
  });

  it("returns null when no price is known", () => {
    expect(estimateCost({ inputTokens: 100, outputTokens: 100 }, null)).toBeNull();
  });
});
