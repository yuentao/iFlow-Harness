import { describe, it, expect } from "vitest";
import {
  buildMetadataQueries,
  buildModelMetadataPrompt,
  parseModelMetadata,
  planMetadataAdditions,
  MODEL_METADATA_MAX_ENTRIES,
  MODEL_METADATA_MAX_MODEL_IDS,
  MODEL_METADATA_MAX_QUERIES,
  type MetadataSource,
  type ModelMetadataEntry,
} from "../shared/model-metadata.js";

const sources: MetadataSource[] = [
  { id: "S1", title: "GLM-4.6 pricing", url: "https://example.test/glm", snippet: "GLM-4.6 has a 200000 token context window." },
  { id: "S2", title: "Other model", url: "https://example.test/other", snippet: "Some other model costs 1.1 per 1M tokens." },
];

describe("buildMetadataQueries", () => {
  it("asks price and context-length queries per model id plus one market query", () => {
    // Chinese term shapes are deliberate: `<id> pricing` / `<id> context
    // window` hit Bing's fixed brand card (probed 2026-10-23), while
    // `<id> 价格` / `<id> 上下文长度` surface the official pricing pages.
    const queries = buildMetadataQueries(["glm-4.6", "deepseek-v3"]);
    expect(queries[0]).toBe("glm-4.6 价格");
    expect(queries[1]).toBe("glm-4.6 上下文长度");
    expect(queries[2]).toBe("deepseek-v3 价格");
    expect(queries[3]).toBe("deepseek-v3 上下文长度");
    expect(queries[4]).toContain("大模型 API 价格 对比");
    expect(queries).toHaveLength(5); // 2 models × 2 queries + 1 market query
  });

  it("dedupes repeated model ids", () => {
    expect(buildMetadataQueries(["glm-4.6", "GLM-4.6"])).toHaveLength(3);
  });

  it("caps the query count", () => {
    const ids = Array.from({ length: MODEL_METADATA_MAX_MODEL_IDS + 20 }, (_, i) => `m-${i}`);
    expect(buildMetadataQueries(ids)).toHaveLength(MODEL_METADATA_MAX_QUERIES);
  });
});

describe("buildModelMetadataPrompt", () => {
  it("lists the profile model ids and the citable sources", () => {
    const prompt = buildModelMetadataPrompt(["glm-4.6", "deepseek-v3"], sources);
    expect(prompt).toContain("- glm-4.6");
    expect(prompt).toContain("- deepseek-v3");
    expect(prompt).toContain("S1 | GLM-4.6 pricing");
    expect(prompt).toContain("200000 token context window");
    expect(prompt).toContain("single key models");
    expect(prompt).toContain("never guess");
    expect(prompt).toContain("source");
  });

  it("caps the handed model ids", () => {
    const ids = Array.from({ length: MODEL_METADATA_MAX_MODEL_IDS + 10 }, (_, i) => `m-${i}`);
    const prompt = buildModelMetadataPrompt(ids, sources);
    expect(prompt).toContain(`- m-${MODEL_METADATA_MAX_MODEL_IDS - 1}`);
    expect(prompt).not.toContain(`- m-${MODEL_METADATA_MAX_MODEL_IDS}`);
  });
});

describe("parseModelMetadata", () => {
  it("parses a bare envelope", () => {
    const raw = '{"models":[{"name":"glm-4.6","contextWindow":200000,"inputPrice":0.6,"outputPrice":2.4,"supportsThinking":true}]}';
    expect(parseModelMetadata(raw)).toEqual([
      { name: "glm-4.6", contextWindow: 200000, inputPrice: 0.6, outputPrice: 2.4, supportsThinking: true },
    ]);
  });

  it("tolerates fences and preamble sentences", () => {
    const raw = '检索完成，结果如下：\n```json\n{"models":[{"name":"x","contextWindow":32000}]}\n```';
    expect(parseModelMetadata(raw)).toEqual([{ name: "x", contextWindow: 32000 }]);
  });

  it("returns nothing for unparseable or non-array answers (never fabricates)", () => {
    expect(parseModelMetadata("")).toEqual([]);
    expect(parseModelMetadata(null)).toEqual([]);
    expect(parseModelMetadata("抱歉，我没有找到任何数据")).toEqual([]);
    expect(parseModelMetadata('{"models":"not-an-array"}')).toEqual([]);
    expect(parseModelMetadata('{"models":[{"name":"x","contextWindow":"200000"}]}')).toEqual([]);
  });

  it("drops malformed fields and unusable names individually", () => {
    const raw = JSON.stringify({
      models: [
        { name: "ok", contextWindow: 128000, inputPrice: 0.27, outputPrice: 1.1 },
        { name: "tiny-window", contextWindow: 10 },
        { name: "huge-window", contextWindow: 100_000_000 },
        { name: "negative-price", inputPrice: -1, outputPrice: 2 },
        { name: "price=broken", contextWindow: 100000 },
        { name: "multi\nline", contextWindow: 100000 },
        { name: "bool-string", supportsThinking: "yes" },
        "not-an-object",
      ],
    });
    const entries = parseModelMetadata(raw);
    expect(entries).toEqual([
      { name: "ok", contextWindow: 128000, inputPrice: 0.27, outputPrice: 1.1 },
      { name: "negative-price", outputPrice: 2 },
    ]);
  });

  it("caps the entry count", () => {
    const models = Array.from({ length: MODEL_METADATA_MAX_ENTRIES + 20 }, (_, i) => ({ name: `m-${i}`, contextWindow: 8000 }));
    expect(parseModelMetadata(JSON.stringify({ models }))).toHaveLength(MODEL_METADATA_MAX_ENTRIES);
  });

  it("keeps an entry whose cited source really mentions the model", () => {
    const raw = '{"models":[{"name":"glm-4.6","contextWindow":200000,"source":"S1"}]}';
    expect(parseModelMetadata(raw, sources)).toEqual([
      { name: "glm-4.6", contextWindow: 200000, source: "S1" },
    ]);
  });

  it("drops an entry without a citation, with an unknown citation, or with a source that never mentions the model", () => {
    const raw = JSON.stringify({
      models: [
        { name: "glm-4.6", contextWindow: 200000 },
        { name: "glm-4.6", contextWindow: 200000, source: "S9" },
        { name: "hallucinated-model", contextWindow: 999999, source: "S2" },
      ],
    });
    expect(parseModelMetadata(raw, sources)).toEqual([]);
  });

  it("matches a source that writes the id differently (spacing/case)", () => {
    const loose: MetadataSource[] = [
      { id: "S1", title: "DeepSeek", url: "https://example.test/ds", snippet: "DeepSeek V3.2 supports 128000 tokens." },
    ];
    const raw = '{"models":[{"name":"deepseek-v3.2","contextWindow":128000,"source":"S1"}]}';
    expect(parseModelMetadata(raw, loose)).toEqual([
      { name: "deepseek-v3.2", contextWindow: 128000, source: "S1" },
    ]);
  });

  it("accepts a context window written in K/M units in the source", () => {
    const k: MetadataSource[] = [
      { id: "S1", title: "GLM-5", url: "https://example.test/glm", snippet: "GLM-5 supports 200K context tokens." },
    ];
    const raw = '{"models":[{"name":"glm-5","contextWindow":200000,"source":"S1"}]}';
    expect(parseModelMetadata(raw, k)).toEqual([{ name: "glm-5", contextWindow: 200000, source: "S1" }]);
    const m: MetadataSource[] = [
      { id: "S1", title: "Kimi", url: "https://example.test/kimi", snippet: "Kimi K3 supports 1M token context window." },
    ];
    const rawM = '{"models":[{"name":"kimi-k3","contextWindow":1000000,"source":"S1"}]}';
    expect(parseModelMetadata(rawM, m)).toEqual([{ name: "kimi-k3", contextWindow: 1000000, source: "S1" }]);
  });

  it("drops an entry whose number the source does not state", () => {
    const src: MetadataSource[] = [
      { id: "S1", title: "GLM-5", url: "https://example.test/glm", snippet: "GLM-5 supports 200K context tokens." },
    ];
    const raw = '{"models":[{"name":"glm-5","contextWindow":1000000,"source":"S1"}]}';
    expect(parseModelMetadata(raw, src)).toEqual([]);
  });

  it("drops an entry whose price the source does not state", () => {
    const src: MetadataSource[] = [
      { id: "S1", title: "GLM-5", url: "https://example.test/glm", snippet: "GLM-5 input $0.6 output $2.4 per 1M tokens." },
    ];
    const ok = '{"models":[{"name":"glm-5","inputPrice":0.6,"outputPrice":2.4,"source":"S1"}]}';
    expect(parseModelMetadata(ok, src)).toEqual([{ name: "glm-5", inputPrice: 0.6, outputPrice: 2.4, source: "S1" }]);
    const wrong = '{"models":[{"name":"glm-5","inputPrice":9.9,"outputPrice":2.4,"source":"S1"}]}';
    expect(parseModelMetadata(wrong, src)).toEqual([]);
  });

  // --- Baseline tests: lock in the price-grounding behaviour that must NOT
  // regress when the currency / input-output semantic check is added below.
  it("BASELINE: keeps USD prices written with a dollar sign", () => {
    const src: MetadataSource[] = [
      { id: "S1", title: "GLM-5 pricing (USD)", url: "https://example.test/glm", snippet: "GLM-5 input $0.27 and output $1.10 per 1M tokens (USD)." },
    ];
    const raw = '{"models":[{"name":"glm-5","inputPrice":0.27,"outputPrice":1.1,"source":"S1"}]}';
    expect(parseModelMetadata(raw, src)).toEqual([
      { name: "glm-5", inputPrice: 0.27, outputPrice: 1.1, source: "S1" },
    ]);
  });

  it("BASELINE: keeps a price on a no-symbol pricing page (neutral context)", () => {
    const src: MetadataSource[] = [
      { id: "S1", title: "Kimi K2 pricing", url: "https://example.test/kimi", snippet: "Kimi K2 lists 2.5 input and 10 output per million tokens on its pricing page." },
    ];
    const raw = '{"models":[{"name":"kimi-k2","inputPrice":2.5,"outputPrice":10,"source":"S1"}]}';
    expect(parseModelMetadata(raw, src)).toEqual([
      { name: "kimi-k2", inputPrice: 2.5, outputPrice: 10, source: "S1" },
    ]);
  });

  it("BASELINE: price number still matches trailing-zero / unit-aware forms", () => {
    const src: MetadataSource[] = [
      { id: "S1", title: "GLM-5", url: "https://example.test/glm", snippet: "GLM-5 input $0.600 / 1M tokens, 600K context." },
    ];
    const raw = '{"models":[{"name":"glm-5","inputPrice":0.6,"contextWindow":600000,"source":"S1"}]}';
    expect(parseModelMetadata(raw, src)).toEqual([
      { name: "glm-5", contextWindow: 600000, inputPrice: 0.6, source: "S1" },
    ]);
  });

  // --- T-10: currency / input-output semantic validation of mined prices.
  it("T-10: drops a CNY price written with ¥ (never converts currency)", () => {
    const src: MetadataSource[] = [
      { id: "S1", title: "GLM-5 定价", url: "https://example.test/glm", snippet: "GLM-5 输入价 ¥2 /百万 tokens，输出价 ¥8 /百万 tokens。" },
    ];
    const raw = '{"models":[{"name":"glm-5","inputPrice":2,"outputPrice":8,"source":"S1"}]}';
    expect(parseModelMetadata(raw, src)).toEqual([]);
  });

  it("T-10: drops a CNY price written as 元 / 人民币", () => {
    const src: MetadataSource[] = [
      { id: "S1", title: "Kimi 价格", url: "https://example.test/kimi", snippet: "Kimi K2 每百万 tokens 输入 2.5 元，输出 10 元，均为人民币计价。" },
    ];
    const raw = '{"models":[{"name":"kimi-k2","inputPrice":2.5,"outputPrice":10,"source":"S1"}]}';
    expect(parseModelMetadata(raw, src)).toEqual([]);
  });

  it("T-10: drops an output price mislabelled as inputPrice", () => {
    const src: MetadataSource[] = [
      { id: "S1", title: "GLM-5 pricing", url: "https://example.test/glm", snippet: "GLM-5 input $0.6 output $2.4 per 1M tokens." },
    ];
    // model reported the output price (2.4) as the input price and vice versa
    const swapped = '{"models":[{"name":"glm-5","inputPrice":2.4,"outputPrice":0.6,"source":"S1"}]}';
    expect(parseModelMetadata(swapped, src)).toEqual([]);
    // correct orientation still grounded
    const correct = '{"models":[{"name":"glm-5","inputPrice":0.6,"outputPrice":2.4,"source":"S1"}]}';
    expect(parseModelMetadata(correct, src)).toEqual([
      { name: "glm-5", inputPrice: 0.6, outputPrice: 2.4, source: "S1" },
    ]);
  });

  it("T-10: drops a monthly / subscription fee used as a token price", () => {
    const src: MetadataSource[] = [
      { id: "S1", title: "Plan pricing", url: "https://example.test/plan", snippet: "GLM-5 Pro 订阅 plan is $20 per month (monthly billing)." },
    ];
    const raw = '{"models":[{"name":"glm-5","inputPrice":20,"source":"S1"}]}';
    expect(parseModelMetadata(raw, src)).toEqual([]);
  });

  it("T-10: a USD price in a mixed CNY/USD snippet is still kept", () => {
    const src: MetadataSource[] = [
      { id: "S1", title: "价格对比", url: "https://example.test/cmp", snippet: "海外版 GLM-5 input $0.6 per 1M tokens; 国内版 输入 2 元 per 1M tokens." },
    ];
    const raw = '{"models":[{"name":"glm-5","inputPrice":0.6,"source":"S1"}]}';
    expect(parseModelMetadata(raw, src)).toEqual([
      { name: "glm-5", inputPrice: 0.6, source: "S1" },
    ]);
  });
});

describe("planMetadataAdditions", () => {
  it("appends validated rows for new models", () => {
    const entries: ModelMetadataEntry[] = [
      { name: "glm-4.6", contextWindow: 200000, inputPrice: 0.6, outputPrice: 2.4, supportsThinking: true },
    ];
    const plan = planMetadataAdditions(entries, { contextWindowOverrides: [], costTable: [], thinkingModelRules: [] });
    expect(plan.windows).toEqual(["glm-4.6=200000"]);
    expect(plan.costs).toEqual(["glm-4.6=0.6,2.4"]);
    expect(plan.rules).toEqual([{ pattern: "^glm-4\\.6$", supportsThinking: true }]);
    expect(plan.total).toBe(3);
  });

  it("never rewrites rows the user already pinned (case/prefix-insensitive)", () => {
    const entries: ModelMetadataEntry[] = [
      { name: "openai/GLM-4.6", contextWindow: 128000, inputPrice: 1, outputPrice: 4 },
      { name: "new-model", contextWindow: 64000, supportsThinking: true },
    ];
    const plan = planMetadataAdditions(entries, {
      contextWindowOverrides: ["glm-4.6=200000"],
      costTable: ["GLM-4.6=0.6,2.4"],
      thinkingModelRules: [],
    });
    expect(plan.windows).toEqual(["new-model=64000"]);
    expect(plan.costs).toEqual([]);
    expect(plan.rules).toEqual([{ pattern: "^new-model$", supportsThinking: true }]);
  });

  it("dedups within one batch (first entry wins)", () => {
    const entries: ModelMetadataEntry[] = [
      { name: "a", contextWindow: 100000 },
      { name: "A", contextWindow: 32000 },
    ];
    const plan = planMetadataAdditions(entries, { contextWindowOverrides: [], costTable: [], thinkingModelRules: [] });
    expect(plan.windows).toEqual(["a=100000"]);
  });

  it("cost rows need BOTH prices", () => {
    const entries: ModelMetadataEntry[] = [{ name: "a", inputPrice: 0.5 }];
    const plan = planMetadataAdditions(entries, { contextWindowOverrides: [], costTable: [], thinkingModelRules: [] });
    expect(plan.costs).toEqual([]);
  });

  it("appends thinking rules only for true, and skips names an existing pattern already covers", () => {
    const entries: ModelMetadataEntry[] = [
      { name: "gpt-4o", supportsThinking: true },
      { name: "gpt-4o-mini", supportsThinking: true },
      { name: "old-model", supportsThinking: false },
    ];
    const plan = planMetadataAdditions(entries, {
      contextWindowOverrides: [],
      costTable: [],
      thinkingModelRules: [{ pattern: "^gpt-4o$", supportsThinking: true }],
    });
    expect(plan.rules).toEqual([{ pattern: "^gpt-4o-mini$", supportsThinking: true }]);
  });

  it("a malformed stored pattern does not claim coverage", () => {
    const entries: ModelMetadataEntry[] = [{ name: "weird", supportsThinking: true }];
    const plan = planMetadataAdditions(entries, {
      contextWindowOverrides: [],
      costTable: [],
      thinkingModelRules: [{ pattern: "[bad(", supportsThinking: true }],
    });
    expect(plan.rules).toEqual([{ pattern: "^weird$", supportsThinking: true }]);
  });
});