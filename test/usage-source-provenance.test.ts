import { describe, it, expect } from "vitest";
import {
  emptySessionUsage,
  type SessionUsageUi,
  type UsageNumberSource,
  type ModelMetadataSource,
} from "../shared/messages.js";

/**
 * U1 is a pure type/field foundation, so its definitions are covered by
 * `npm run typecheck` (host + webview compile shared/messages.ts). This file
 * adds the runtime-observable guarantees: the provenance vocabulary is exactly
 * the set of existing computation paths, `emptySessionUsage()` stays unchanged
 * (older hosts / persisted transcripts remain valid), and a fully annotated
 * snapshot round-trips without disturbing any numeric field.
 */
describe("U1 usage provenance type contract", () => {
  it("UsageNumberSource admits exactly the three existing occupancy/split paths", () => {
    const paths: UsageNumberSource[] = ["kernel-report", "transcript-estimate", "lower-bound"];
    expect(paths).toEqual(["kernel-report", "transcript-estimate", "lower-bound"]);
  });

  it("ModelMetadataSource admits exactly the four existing curated-metadata paths", () => {
    const paths: ModelMetadataSource[] = ["user", "builtin-table", "ai-supplement", "fallback-estimate"];
    expect(paths).toEqual(["user", "builtin-table", "ai-supplement", "fallback-estimate"]);
  });

  it("emptySessionUsage stays provenance-free (backward compatibility)", () => {
    const usage = emptySessionUsage();
    expect(usage).not.toHaveProperty("sources");
    expect(usage).not.toHaveProperty("capturedAt");
    expect(usage).not.toHaveProperty("sourceUrl");
    // The legacy booleans keep their exact shape — the new fields never replace them.
    expect(usage).not.toHaveProperty("usageAuthoritative");
    expect(usage).not.toHaveProperty("estimated");
  });

  it("a fully annotated snapshot round-trips without disturbing numeric fields", () => {
    const annotated: SessionUsageUi = {
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      contextWindow: 1_000_000,
      contextUsed: 90_000,
      estimated: false,
      usageAuthoritative: true,
      estimatedCost: 0.012,
      sources: {
        contextUsed: "kernel-report",
        split: "transcript-estimate",
        window: "builtin-table",
        cost: "builtin-table",
      },
      capturedAt: 1_700_000_000_000,
      sourceUrl: "https://example.com/model/context-window",
    };
    expect(annotated.inputTokens).toBe(120);
    expect(annotated.usageAuthoritative).toBe(true);
    expect(annotated.sources).toEqual({
      contextUsed: "kernel-report",
      split: "transcript-estimate",
      window: "builtin-table",
      cost: "builtin-table",
    });
    expect(annotated.capturedAt).toBe(1_700_000_000_000);
    expect(annotated.sourceUrl).toBe("https://example.com/model/context-window");
  });

  it("provenance fields are optional — a legacy-shaped object still satisfies SessionUsageUi", () => {
    const legacy: SessionUsageUi = {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 3,
      estimated: true,
      usageAuthoritative: false,
      estimatedCost: null,
    };
    expect(legacy.sources).toBeUndefined();
    expect(legacy.capturedAt).toBeUndefined();
  });
});