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
    // glm-5.3 (1M) must beat the glm-5 prefix (198k); glm-4.6 (200k) must
    // not shadow glm-4.5 (128k) or vice versa.
    expect(resolveContextWindow("glm-5.3", {}).window).toBe(1_000_000);
    expect(resolveContextWindow("glm-5.2", {}).window).toBe(1_000_000);
    expect(resolveContextWindow("glm-5", {}).window).toBe(198_000);
    expect(resolveContextWindow("glm-4.6", {}).window).toBe(200_000);
    expect(resolveContextWindow("glm-4.5", {}).window).toBe(128_000);
  });

  it("table hit is not flagged estimated", () => {
    expect(resolveContextWindow("deepseek-v3", {})).toEqual({ window: 128_000, estimated: false });
    expect(resolveContextWindow("deepseek-v4-pro", {})).toEqual({ window: 1_000_000, estimated: false });
  });

  it("bare keys cover dated snapshots via longest-prefix match", () => {
    // Dated snapshot ids must resolve through their bare generation key.
    expect(resolveContextWindow("gpt-5.4-2026-03-05", {}).window).toBe(1_050_000);
    expect(resolveContextWindow("gpt-4o-2024-11-20", {}).window).toBe(128_000);
    expect(resolveContextWindow("claude-opus-5-5", {}).window).toBe(1_000_000);
    expect(resolveContextWindow("claude-sonnet-4-6", {}).window).toBe(200_000);
    expect(resolveContextWindow("doubao-seed-2-1-pro-260915", {}).window).toBe(1_024_000);
    expect(resolveContextWindow("doubao-seed-2-1-turbo-260628", {}).window).toBe(256_000);
    expect(resolveContextWindow("doubao-seed-2-0-lite-260428", {}).window).toBe(256_000);
    expect(resolveContextWindow("nemotron-3-super-120b-a12b", {}).window).toBe(1_000_000);
    expect(resolveContextWindow("step-5-preview", {}).window).toBe(1_000_000);
    expect(resolveContextWindow("kimi-k2.7-code", {}).window).toBe(256_000);
    expect(resolveContextWindow("grok-4.20-0309-reasoning", {}).window).toBe(1_000_000);
    expect(resolveContextWindow("mistral-medium-3-5", {}).window).toBe(128_000);
  });

  it("covers the 2026-10 vendor lineup (scraped from official docs)", () => {
    // OpenAI current gen 1.05M, GPT-5 400k.
    expect(resolveContextWindow("gpt-6-astra", {}).window).toBe(1_050_000);
    expect(resolveContextWindow("gpt-5.5", {}).window).toBe(1_050_000);
    expect(resolveContextWindow("gpt-5", {}).window).toBe(400_000);
    // Anthropic 5.5 lineup 1M.
    expect(resolveContextWindow("claude-fable-5-1", {}).window).toBe(1_000_000);
    // Gemini 1,048,576 across 2.5–3.8.
    expect(resolveContextWindow("gemini-3.8-flash", {}).window).toBe(1_048_576);
    expect(resolveContextWindow("gemini-2.5-pro", {}).window).toBe(1_048_576);
    // DeepSeek V4 1M / legacy 128k; Kimi K3 1M / K2 256k.
    expect(resolveContextWindow("deepseek-flash", {}).window).toBe(1_000_000);
    expect(resolveContextWindow("kimi-k3", {}).window).toBe(1_000_000);
    expect(resolveContextWindow("kimi-k2", {}).window).toBe(256_000);
    // Qwen 3.6+ 1M, qwen3.5 compact 256k, qwen3 legacy 128k.
    expect(resolveContextWindow("qwen3.8-max", {}).window).toBe(1_000_000);
    expect(resolveContextWindow("qwen3.5-plus", {}).window).toBe(256_000);
    expect(resolveContextWindow("qwen3-max", {}).window).toBe(128_000);
    // MiniMax M3 1M / M2 200k; Grok 4.7 500k.
    expect(resolveContextWindow("minimax-m3", {}).window).toBe(1_000_000);
    expect(resolveContextWindow("minimax-m2.7", {}).window).toBe(200_000);
    expect(resolveContextWindow("grok-4.7", {}).window).toBe(500_000);
    // Tencent Hunyuan: Hy3 256K (tencent.com + HuggingFace), earlier
    // hunyuan-* generation 128K via the prefix. The hy3 miss that fell back
    // to the 32K default is what misreported 100% occupancy (2026-10-11).
    expect(resolveContextWindow("hy3", {})).toEqual({ window: 256_000, estimated: false });
    expect(resolveContextWindow("tencent/hy3", {})).toEqual({ window: 256_000, estimated: false });
    expect(resolveContextWindow("hunyuan-turbo", {}).window).toBe(128_000);
  });

  it("unknown model falls back to the conservative default and flags estimated", () => {
    // SenseNova has no verifiable public source — deliberately unlisted.
    expect(resolveContextWindow("sensenova-6.8-flash", {})).toEqual({
      window: DEFAULT_CONTEXT_WINDOW,
      estimated: true,
    });
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
