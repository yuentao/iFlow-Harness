/**
 * T-8/T-9 wiring regression: the window/cost provenance labels produced by
 * the panel resolver must reach `SessionUsageUi.sources` alongside the values,
 * without disturbing the T-5 contextUsed/split labels produced downstream.
 *
 * This is the host-side integration point that T-8 explicitly left undone
 * ("host 侧接线在 panel.ts"). It exercises the real ChatPanel resolver (with
 * the vscode stub config) and the real `refreshSessionUsage` reducer.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel, type PanelServices } from "../src/panel/panel.js";
import { invalidateKernelTokensLimitsCache } from "../src/acp/cli-tokens-limit.js";
import type { UsageContext } from "../shared/session-state.js";
import { refreshSessionUsage } from "../shared/session-state.js";
import { initialSessionState } from "../shared/messages.js";
import type { MetadataAdditions, MetadataSource, ModelMetadataEntry } from "../shared/model-metadata.js";
import { setConfigOverrides } from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const mockAgent = path.join(here, "mock-acp-agent.mjs");

function makeContext(storageDir: string): vscodeTypes.ExtensionContext {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? (store.get(key) as T) : defaultValue),
    update: (key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    },
    keys: () => [...store.keys()],
    delete: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
  };
  return {
    subscriptions: [],
    secrets: {
      get: () => Promise.resolve(undefined),
      store: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    workspaceState: state,
    globalState: state,
    extensionUri: { fsPath: here },
    extensionPath: here,
    extensionMode: 3,
    logPath: here,
    storageUri: { fsPath: storageDir },
    globalStorageUri: { fsPath: storageDir },
    storagePath: storageDir,
    globalStoragePath: storageDir,
    asAbsolutePath: (p: string) => path.join(here, p),
  } as unknown as vscodeTypes.ExtensionContext;
}

function makeWatchers(): NonNullable<PanelServices["watchers"]> {
  const noop = () => ({ dispose: () => {} });
  return [
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
  ];
}

type AiStamp = {
  window?: { value: number; sourceUrl?: string; capturedAt: number };
  cost?: { value: { input: number; output: number }; sourceUrl?: string; capturedAt: number };
};
/** Narrow view of the panel internals this wiring unit is responsible for. */
type PanelInternals = {
  store: { getState: () => { currentModelId?: string | null }; sessionMeta: (m: { currentModelId?: string }) => void };
  usageOverridesCache: unknown;
  aiMetadataStamp: Map<string, AiStamp>;
  resolveUsageContext: () => UsageContext;
  recordAiMetadataStamp: (
    entries: readonly ModelMetadataEntry[],
    sources: readonly MetadataSource[],
    additions: MetadataAdditions,
  ) => void;
};
const internals = (panel: ChatPanel): PanelInternals => panel as unknown as PanelInternals;

describe("panel usage provenance wiring · window/cost source → state.usage.sources", () => {
  let panel: ChatPanel;
  let storageDir: string;
  let homeDir: string;
  const originalIflowHome = process.env.IFLOW_HOME;

  beforeEach(() => {
    setConfigOverrides({ nodePath: process.execPath });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-usageprov-storage-"));
    // Hermetic: since 2026-11-22 the occupancy bar resolves its window
    // through the SAME five-tier chain the CLI uses, which also reads the
    // kernel settings file (active profile's tokensLimit / top-level
    // tokensLimit). Point IFLOW_HOME at an empty temp dir so the assertions
    // never depend on the developer's own ~/.iflow/settings.json.
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-usageprov-home-"));
    process.env.IFLOW_HOME = homeDir;
    invalidateKernelTokensLimitsCache();
    panel = new ChatPanel(makeContext(storageDir), {
      entryOverride: mockAgent,
      workspaceRoot: here,
      watchers: makeWatchers(),
    });
  });

  afterEach(async () => {
    await panel.dispose();
    invalidateKernelTokensLimitsCache();
    if (originalIflowHome === undefined) delete process.env.IFLOW_HOME;
    else process.env.IFLOW_HOME = originalIflowHome;
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /** Reconfigure overrides + invalidate the panel's parsed cache. */
  function configure(values: Record<string, unknown>): void {
    setConfigOverrides({ nodePath: process.execPath, ...values });
    internals(panel).usageOverridesCache = null;
  }
  function setModel(id: string): void {
    internals(panel).store.sessionMeta({ currentModelId: id });
  }
  function resolve(): UsageContext {
    return internals(panel).resolveUsageContext();
  }
  /** Feed the resolver output through the real reducer and read the stamped
   * usage snapshot (mirrors what SessionStore does on every push). */
  function stamped(ctx: UsageContext) {
    const state = initialSessionState();
    refreshSessionUsage(state, ctx);
    return state.usage!;
  }

  it("hand-typed window/cost overrides are labeled user", () => {
    configure({
      contextWindowOverrides: ["glm-4.6=4096"],
      costTable: ["glm-4.6=1,2"],
    });
    setModel("glm-4.6"); // a tabled model, but the override must win the label
    const ctx = resolve();
    expect(ctx.contextWindow).toBe(4096);
    expect(ctx.costPrice).toEqual({ input: 1, output: 2 });
    expect(ctx.windowSource).toBe("user");
    expect(ctx.costSource).toBe("user");
    const usage = stamped(ctx);
    expect(usage.sources?.window).toBe("user");
    expect(usage.sources?.cost).toBe("user");
  });

  it("curated table hits are labeled builtin-table", () => {
    configure({ contextWindowOverrides: [], costTable: [] });
    setModel("deepseek-v3");
    const ctx = resolve();
    expect(ctx.contextWindow).toBe(128_000);
    expect(ctx.costPrice).toEqual({ input: 0.27, output: 1.1 });
    expect(ctx.windowSource).toBe("builtin-table");
    expect(ctx.costSource).toBe("builtin-table");
    const usage = stamped(ctx);
    expect(usage.sources?.window).toBe("builtin-table");
    expect(usage.sources?.cost).toBe("builtin-table");
  });

  it("unknown model: NO window at all (no guessed denominator), cost has no source (never fabricated)", () => {
    configure({ contextWindowOverrides: [], costTable: [] });
    setModel("totally-unknown-model-x9");
    const ctx = resolve();
    // 2026-11-22：宿主对「没有依据」的模型**不给**窗口（旧实现给 32,768 的
    // 兜底估算，那个猜测值与 CLI 自己算的窗口不同 —— 正是「一个模型两个窗口」）。
    // 现在占用条只显示原始 token 数，不显示分母。
    expect(ctx.contextWindow).toBeNull();
    expect(ctx.windowSource).toBeNull();
    expect(ctx.estimated).toBe(false);
    expect(ctx.costPrice).toBeNull();
    expect(ctx.costSource).toBeNull();
    const usage = stamped(ctx);
    expect(usage.sources?.window).toBeUndefined();
    // No price → sources.cost must stay ABSENT, never fallback-estimate.
    expect(usage.sources?.cost).toBeUndefined();
    expect(usage.estimatedCost).toBeNull();
  });

  it("null model id stamps no window/cost source", () => {
    configure({ contextWindowOverrides: [], costTable: [] });
    internals(panel).store.getState().currentModelId = null;
    const ctx = resolve();
    expect(ctx.contextWindow).toBeNull();
    expect(ctx.windowSource).toBeNull();
    expect(ctx.costSource).toBeNull();
    const usage = stamped(ctx);
    expect(usage.sources?.window).toBeUndefined();
    expect(usage.sources?.cost).toBeUndefined();
  });

  it("stamping window/cost sources does NOT overwrite T-5 contextUsed/split", () => {
    configure({ contextWindowOverrides: [], costTable: [] });
    setModel("deepseek-v3");
    const ctx = resolve();
    const usage = stamped(ctx);
    // estimateSessionUsage owns these two labels; the wiring must spread
    // them through untouched.
    expect(usage.sources?.contextUsed).toBe("transcript-estimate");
    expect(usage.sources?.split).toBe("transcript-estimate");
    // And it adds the two new labels on top.
    expect(usage.sources?.window).toBe("builtin-table");
    expect(usage.sources?.cost).toBe("builtin-table");
  });

  it("a pure provenance relabel breaks reference stability (fresh usage object)", () => {
    const state = initialSessionState();
    const base: UsageContext = {
      contextWindow: 128_000,
      estimated: false,
      costPrice: { input: 2, output: 8 },
      windowSource: "user",
      costSource: "user",
    };
    refreshSessionUsage(state, base);
    const first = state.usage;
    // Same numbers, only the window source flips — must still adopt a new
    // object so the webview sees the new tag.
    refreshSessionUsage(state, { ...base, windowSource: "ai-supplement" });
    expect(state.usage).not.toBe(first);
    expect(state.usage!.sources?.window).toBe("ai-supplement");
    expect(state.usage!.contextWindow).toBe(128_000);
  });
});

describe("panel usage provenance wiring · T-9 ai-supplement stamp", () => {
  let panel: ChatPanel;
  let storageDir: string;
  let homeDir: string;
  const originalIflowHome = process.env.IFLOW_HOME;

  beforeEach(() => {
    setConfigOverrides({ nodePath: process.execPath });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-usageprov-ai-storage-"));
    // Hermetic for the same reason as the block above: the occupancy bar's
    // window now comes from the kernel-aware five-tier resolver.
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-usageprov-ai-home-"));
    process.env.IFLOW_HOME = homeDir;
    invalidateKernelTokensLimitsCache();
    panel = new ChatPanel(makeContext(storageDir), {
      entryOverride: mockAgent,
      workspaceRoot: here,
      watchers: makeWatchers(),
    });
  });

  afterEach(async () => {
    await panel.dispose();
    invalidateKernelTokensLimitsCache();
    if (originalIflowHome === undefined) delete process.env.IFLOW_HOME;
    else process.env.IFLOW_HOME = originalIflowHome;
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function configure(values: Record<string, unknown>): void {
    setConfigOverrides({ nodePath: process.execPath, ...values });
    internals(panel).usageOverridesCache = null;
  }
  function setModel(id: string): void {
    internals(panel).store.sessionMeta({ currentModelId: id });
  }

  const MODEL = "ai-only-model-x9";
  const URL = "https://example.com/ai-only-model-x9/context";
  const sources: MetadataSource[] = [
    { id: "S1", title: "AI-only Model Specs", url: URL, snippet: `${MODEL} has 200000 context and price 1.5, 6` },
  ];
  const entries: ModelMetadataEntry[] = [
    { name: MODEL, contextWindow: 200_000, inputPrice: 1.5, outputPrice: 6, source: "S1" },
  ];
  const additions: MetadataAdditions = {
    windows: [`${MODEL}=200000`],
    costs: [`${MODEL}=1.5,6`],
    rules: [],
    total: 2,
  };

  it("AI-appended window/cost are relabeled ai-supplement with citation + time", () => {
    configure({
      contextWindowOverrides: [`${MODEL}=200000`],
      costTable: [`${MODEL}=1.5,6`],
    });
    setModel(MODEL);
    internals(panel).recordAiMetadataStamp(entries, sources, additions);
    const ctx = internals(panel).resolveUsageContext();
    expect(ctx.contextWindow).toBe(200_000);
    expect(ctx.costPrice).toEqual({ input: 1.5, output: 6 });
    expect(ctx.windowSource).toBe("ai-supplement");
    expect(ctx.costSource).toBe("ai-supplement");
    expect(ctx.sourceUrl).toBe(URL);
    expect(typeof ctx.capturedAt).toBe("number");

    const state = initialSessionState();
    refreshSessionUsage(state, ctx);
    expect(state.usage!.sources?.window).toBe("ai-supplement");
    expect(state.usage!.sources?.cost).toBe("ai-supplement");
    expect(state.usage!.sourceUrl).toBe(URL);
    // T-5 labels survive the AI stamp too.
    expect(state.usage!.sources?.contextUsed).toBe("transcript-estimate");
    expect(state.usage!.sources?.split).toBe("transcript-estimate");
  });

  it("a hand-typed override (no AI stamp) stays user", () => {
    configure({
      contextWindowOverrides: [`${MODEL}=200000`],
      costTable: [`${MODEL}=1.5,6`],
    });
    setModel(MODEL);
    // No recordAiMetadataStamp call — this is a value the user typed.
    const ctx = internals(panel).resolveUsageContext();
    expect(ctx.windowSource).toBe("user");
    expect(ctx.costSource).toBe("user");
    expect(ctx.sourceUrl).toBeUndefined();
  });

  it("a later hand-edit of an AI value reverts the label to user (value guard)", () => {
    configure({
      contextWindowOverrides: [`${MODEL}=200000`], // AI wrote this
      costTable: [`${MODEL}=1.5,6`],
    });
    setModel(MODEL);
    internals(panel).recordAiMetadataStamp(entries, sources, additions);
    // User later hand-edits the window to 111111 (the setting changed, cache
    // invalidated) — the number no longer matches what the AI appended.
    configure({
      contextWindowOverrides: [`${MODEL}=111111`],
      costTable: [`${MODEL}=1.5,6`],
    });
    const ctx = internals(panel).resolveUsageContext();
    expect(ctx.windowSource).toBe("user");
    // Cost is untouched by the hand edit, so it stays ai-supplement.
    expect(ctx.costSource).toBe("ai-supplement");
  });

  it("a pre-existing user override is never stamped (additions empty for that model)", () => {
    configure({
      contextWindowOverrides: [`${MODEL}=200000`],
      costTable: [`${MODEL}=1.5,6`],
    });
    setModel(MODEL);
    // planMetadataAdditions would not append an already-pinned model, so
    // additions carry no rows for it — nothing to stamp.
    internals(panel).recordAiMetadataStamp(entries, sources, {
      windows: [],
      costs: [],
      rules: [],
      total: 0,
    });
    const ctx = internals(panel).resolveUsageContext();
    expect(ctx.windowSource).toBe("user");
    expect(ctx.costSource).toBe("user");
  });
});
