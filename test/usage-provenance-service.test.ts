/**
 * Direct unit tests for the extracted UsageProvenanceService. No ChatPanel,
 * no VSCode, no disk: every panel-owned value is a fake dep read at call time.
 * Locks the three invariants the extraction must preserve:
 *   • the AI stamp map is SHARED between recordAiMetadataStamp and
 *     resolveUsageContext (same instance, in-memory only);
 *   • the settings cache is invalidated explicitly (config-change path), not
 *     by elapsed time;
 *   • the service never writes settings — its deps are read-only by shape.
 */
import { describe, it, expect } from "vitest";
import type { KernelTokensLimits } from "../src/acp/cli-tokens-limit.js";
import type { MetadataAdditions, MetadataSource, ModelMetadataEntry } from "../shared/model-metadata.js";
import { UsageProvenanceService, type UsageProvenanceServiceDeps } from "../src/panel/usage-provenance-service.js";

const MODEL = "svc-model";
const URL = "https://example.com/svc-model/context";
const SOURCES: MetadataSource[] = [
  { id: "S1", title: "svc-model specs", url: URL, snippet: `${MODEL} has 200000 context and price 1.5, 6` },
];
const ENTRIES: ModelMetadataEntry[] = [
  { name: MODEL, contextWindow: 200_000, inputPrice: 1.5, outputPrice: 6, source: "S1" },
];
const ADDITIONS: MetadataAdditions = {
  windows: [`${MODEL}=200000`],
  costs: [`${MODEL}=1.5,6`],
  rules: [],
  total: 2,
};

function harness(initial?: Partial<Record<"contextWindowOverrides" | "costTable", string[]>>) {
  let settings: Record<string, string[]> = {
    contextWindowOverrides: initial?.contextWindowOverrides ?? [`${MODEL}=200000`],
    costTable: initial?.costTable ?? [`${MODEL}=1.5,6`],
  };
  let modelId: string | null | undefined = MODEL;
  let kernel: KernelTokensLimits = {};
  let settingReads = 0;
  let kernelReads = 0;
  let modelReads = 0;

  // The deps object deliberately exposes ONLY read callbacks — there is no
  // write surface for the service to reach, so "never writes settings" is a
  // compile-time property rather than a convention.
  const deps: UsageProvenanceServiceDeps = {
    readUserSetting<T>(key: string, fallback: T): T {
      settingReads += 1;
      const value = settings[key];
      return (value === undefined ? fallback : value) as T;
    },
    getCurrentModelId(): string | null | undefined {
      modelReads += 1;
      return modelId;
    },
    readKernelTokensLimits(): KernelTokensLimits {
      kernelReads += 1;
      return kernel;
    },
  };
  const service = new UsageProvenanceService(deps);
  return {
    service,
    setSettings(next: Record<string, string[]>): void { settings = next; },
    setModel(id: string | null | undefined): void { modelId = id; },
    setKernel(next: KernelTokensLimits): void { kernel = next; },
    get settingReads(): number { return settingReads; },
    get kernelReads(): number { return kernelReads; },
    get modelReads(): number { return modelReads; },
    snapshotSettings(): string { return JSON.stringify(settings); },
  };
}

describe("UsageProvenanceService · deps-driven five-tier resolution", () => {
  it("resolves the user override tier and cost from injected settings only", () => {
    const h = harness();
    const ctx = h.service.resolveUsageContext();
    expect(ctx.contextWindow).toBe(200_000);
    expect(ctx.costPrice).toEqual({ input: 1.5, output: 6 });
    expect(ctx.windowSource).toBe("user");
    expect(ctx.costSource).toBe("user");
    expect(ctx.estimated).toBe(false);
    // Both settings are read live, but only once per cache generation.
    expect(h.settingReads).toBe(2);
    expect(h.modelReads).toBe(1);
    expect(h.kernelReads).toBe(1);
  });

  it("kernel profile / settings tiers flow through the same authority chain", () => {
    const h = harness({ contextWindowOverrides: [], costTable: [] });
    h.service.usageOverridesCache = null;
    h.setKernel({ profileTokensLimit: 128_000, settingsTokensLimit: 64_000 });
    expect(h.service.resolveUsageContext()).toMatchObject({ contextWindow: 128_000, windowSource: "profile" });

    h.setKernel({ settingsTokensLimit: 64_000 });
    expect(h.service.resolveUsageContext()).toMatchObject({ contextWindow: 64_000, windowSource: "settings" });

    h.setKernel({});
    // No authority at all: NO guessed denominator, no fabricated cost source.
    h.setModel("unknown-svc-model-x9");
    const ctx = h.service.resolveUsageContext();
    expect(ctx.contextWindow).toBeNull();
    expect(ctx.windowSource).toBeNull();
    expect(ctx.costPrice).toBeNull();
    expect(ctx.costSource).toBeNull();
  });

  it("caches the parsed settings until explicitly invalidated (config-change path)", () => {
    const h = harness();
    const first = h.service.resolveUsageContext();
    const second = h.service.resolveUsageContext();
    expect(second).toEqual(first);
    expect(h.settingReads).toBe(2); // no re-parse on the second push

    h.setSettings({ contextWindowOverrides: [`${MODEL}=111111`], costTable: [`${MODEL}=1.5,6`] });
    expect(h.service.resolveUsageContext().contextWindow).toBe(200_000); // still cached
    expect(h.settingReads).toBe(2);

    h.service.usageOverridesCache = null; // exactly what the config listener does
    expect(h.service.resolveUsageContext().contextWindow).toBe(111_111);
    expect(h.settingReads).toBe(4);
  });

  it("null model id produces no window and no source (profile/settings are endpoint-level)", () => {
    const h = harness();
    h.setModel(null);
    h.setKernel({ profileTokensLimit: 128_000 });
    const ctx = h.service.resolveUsageContext();
    expect(ctx.contextWindow).toBeNull();
    expect(ctx.windowSource).toBeNull();
  });
});

describe("UsageProvenanceService · T-9 stamp shared instance & no-disk invariant", () => {
  it("records into the SAME map the resolver reads: AI rows become ai-supplement", () => {
    const h = harness();
    expect(h.service.aiMetadataStamp.size).toBe(0);
    h.service.recordAiMetadataStamp(ENTRIES, SOURCES, ADDITIONS);
    // Shared instance: the write is directly observable in the resolver's map.
    const stamp = h.service.aiMetadataStamp.get(MODEL);
    expect(stamp?.window?.value).toBe(200_000);
    expect(stamp?.cost?.value).toEqual({ input: 1.5, output: 6 });

    const ctx = h.service.resolveUsageContext();
    expect(ctx.windowSource).toBe("ai-supplement");
    expect(ctx.costSource).toBe("ai-supplement");
    expect(ctx.sourceUrl).toBe(URL);
    expect(typeof ctx.capturedAt).toBe("number");
  });

  it("exact-value guard: a later hand edit reverts only the edited dimension", () => {
    const h = harness();
    h.service.recordAiMetadataStamp(ENTRIES, SOURCES, ADDITIONS);
    h.setSettings({ contextWindowOverrides: [`${MODEL}=111111`], costTable: [`${MODEL}=1.5,6`] });
    h.service.usageOverridesCache = null;
    const ctx = h.service.resolveUsageContext();
    expect(ctx.windowSource).toBe("user"); // window no longer matches the AI value
    expect(ctx.costSource).toBe("ai-supplement"); // cost untouched
  });

  it("empty additions never stamp pre-existing user rows", () => {
    const h = harness();
    h.service.recordAiMetadataStamp(ENTRIES, SOURCES, { windows: [], costs: [], rules: [], total: 0 });
    expect(h.service.aiMetadataStamp.size).toBe(0);
    const ctx = h.service.resolveUsageContext();
    expect(ctx.windowSource).toBe("user");
    expect(ctx.costSource).toBe("user");
  });

  it("never writes settings: deps expose reads only and settings stay byte-identical", () => {
    const h = harness();
    const before = h.snapshotSettings();
    h.service.recordAiMetadataStamp(ENTRIES, SOURCES, ADDITIONS);
    for (let i = 0; i < 3; i += 1) h.service.resolveUsageContext();
    // Stamp is in-memory only — the settings snapshot has not moved at all.
    expect(h.snapshotSettings()).toBe(before);
    expect(h.service.aiMetadataStamp.size).toBe(1);
  });
});
