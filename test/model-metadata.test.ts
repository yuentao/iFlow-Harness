import { describe, it, expect } from "vitest";
import {
  buildModelMetadataPrompt,
  parseModelMetadata,
  pickMetadataModel,
  planMetadataAdditions,
  MODEL_METADATA_MAX_ENTRIES,
  MODEL_METADATA_MAX_MODEL_IDS,
  type ModelMetadataEntry,
} from "../shared/model-metadata.js";

describe("buildModelMetadataPrompt", () => {
  it("lists the profile model ids and demands a bare JSON envelope", () => {
    const prompt = buildModelMetadataPrompt(["glm-4.6", "deepseek-v3"]);
    expect(prompt).toContain("- glm-4.6");
    expect(prompt).toContain("- deepseek-v3");
    expect(prompt).toContain("只允许调用 web_search");
    expect(prompt).toContain("不要读取或写入任何文件");
    expect(prompt).toContain("键 models");
    expect(prompt).toContain("绝不猜测、编造");
  });

  it("caps the handed model ids", () => {
    const ids = Array.from({ length: MODEL_METADATA_MAX_MODEL_IDS + 10 }, (_, i) => `m-${i}`);
    const prompt = buildModelMetadataPrompt(ids);
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
});

describe("pickMetadataModel", () => {
  it("prefers the panel model when the live list proves it", () => {
    expect(pickMetadataModel("OpenAI/GPT-4O", "other", ["openai/gpt-4o", "glm-4.6"])).toBe("OpenAI/GPT-4O");
  });

  it("falls back to the profile model, then the first live id (never an unlisted push)", () => {
    expect(pickMetadataModel("delisted-model", "glm-4.6", ["glm-4.6", "x"])).toBe("glm-4.6");
    expect(pickMetadataModel("delisted", "also-delisted", ["first", "second"])).toBe("first");
    expect(pickMetadataModel(null, null, [])).toBeNull();
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
