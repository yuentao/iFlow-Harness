/**
 * M1 P0-6 / P1-6 — pure helpers for the context-occupancy bar and the cost
 * estimate. Zero VSCode dependency so both are unit-testable in isolation.
 *
 * The vendored CLI never reports a model's context window or a usage figure
 * (frozen fork), so the host maintains a curated table of the models our
 * users actually point at, plus a `模型名=数值` override setting for anything
 * the table has not caught up with. An unknown model falls back to a
 * deliberately conservative default and is flagged `estimated` so the UI says
 * so instead of presenting a guess as fact.
 */

import type { SessionUsageUi } from "./messages.js";

/** Fallback window for an unknown model — small on purpose: overestimating
 * the window hides an overflow that is about to happen. */
export const DEFAULT_CONTEXT_WINDOW = 32_768;

/** Curated context windows (tokens). Keys are matched against a normalized
 * model id (see `normalizeModelId`), longest-key-first, so `glm-5.3` wins
 * over a hypothetical `glm-5` prefix, and a bare key covers dated snapshots
 * (`gpt-5.4-2026-03-05` hits `gpt-5.4`). Values are the models' published
 * context sizes, scraped from each vendor's official model/pricing pages on
 * 2026-10-11 (OpenAI docs/models, Anthropic models overview, Gemini API
 * models, DeepSeek pricing, Kimi model list, bigmodel GLM pages, Aliyun
 * bailian model table, Volcengine ark model list, MiniMax, xAI pricing,
 * Mistral model pages, NVIDIA/StepFun via OpenRouter);
 * `iflow.contextWindowOverrides` covers newer releases without a code change.
 * SenseNova (商汤日日新) has no verifiable public source — deliberately not
 * listed; unknown models fall back to the conservative default. */
export const CONTEXT_WINDOW_TABLE: Readonly<Record<string, number>> = {
  // --- OpenAI (1.05M current gen; GPT-5 400k; o-series 200k; 4.x 128k) ---
  "gpt-6-astra": 1_050_000,
  "gpt-6-sol": 1_050_000,
  "gpt-6-luna": 1_050_000,
  "gpt-6.1-sol": 1_050_000,
  "gpt-5.6-sol": 1_050_000,
  "gpt-5.6-luna": 1_050_000,
  "gpt-5.6-terra": 1_050_000,
  "gpt-5.5": 1_050_000,
  "gpt-5.4": 1_050_000,
  "gpt-5.2": 1_050_000,
  "gpt-5.1": 400_000,
  "gpt-5": 400_000,
  "gpt-4.1": 128_000,
  "gpt-4o": 128_000,
  "o3": 200_000,
  "o4-mini": 200_000,
  // --- Anthropic (current 5.5 lineup 1M; 4.x generation 200k) ---
  "claude-fable": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-haiku-5": 1_000_000,
  "claude-opus-4": 200_000,
  "claude-sonnet-4": 200_000,
  "claude-haiku-4": 200_000,
  // --- Google Gemini (2.5 through 3.8 all 1,048,576) ---
  "gemini-3.8-flash": 1_048_576,
  "gemini-3.6-flash": 1_048_576,
  "gemini-3.5": 1_048_576,
  "gemini-3.1-pro": 1_048_576,
  "gemini-3.1-flash": 1_048_576,
  "gemini-3-flash": 1_048_576,
  "gemini-2.5-pro": 1_048_576,
  "gemini-2.5-flash": 1_048_576,
  // --- DeepSeek (V4 generation 1M; V3/R1 legacy 128k) ---
  "deepseek-flash": 1_000_000,
  "deepseek-v4": 1_000_000,
  "deepseek-chat": 128_000,
  "deepseek-reasoner": 128_000,
  "deepseek-v3": 128_000,
  "deepseek-r1": 128_000,
  // --- Kimi / Moonshot (K3 1M; K2.x 256k; moonshot-v1 legacy 128k) ---
  "kimi-k3": 1_000_000,
  "kimi-k2.7": 256_000,
  "kimi-k2.6": 256_000,
  "kimi-k2": 256_000,
  "moonshot-v1": 128_000,
  // --- Z.ai GLM (5.3/5.2 1M; 5.1/5 198k per Aliyun listing; 4.6 200k) ---
  "glm-5.3": 1_000_000,
  "glm-5.2": 1_000_000,
  "glm-5.1": 198_000,
  "glm-5": 198_000,
  "glm-4.6": 200_000,
  "glm-4.5": 128_000,
  // --- Qwen (3.6+ generations 1M; qwen3.5 compact tiers 256k; qwen-long 10M) ---
  "qwen3.8": 1_000_000,
  "qwen3.7": 1_000_000,
  "qwen3.6": 1_000_000,
  "qwen3-coder": 1_000_000,
  "qwen3.5": 256_000,
  "qwen3": 128_000,
  "qwen-plus": 1_000_000,
  "qwen-long": 10_000_000,
  // --- Doubao / Volcengine Seed (2.1 pro/lite + evolving 1024k; turbo/2.0 256k) ---
  "doubao-seed-evolving": 1_024_000,
  "doubao-seed-2-1-pro": 1_024_000,
  "doubao-seed-2-1-lite": 1_024_000,
  "doubao-seed-2-1": 256_000,
  "doubao-seed-2-0": 256_000,
  // --- Tencent Hunyuan (Hy3 256K per tencent.com + HuggingFace model card,
  //     verified 2026-10-11; earlier hunyuan-turbo/large generation is 128K —
  //     the prefix value stays conservative, overestimating a window hides
  //     an overflow that is about to happen) ---
  "hy3": 256_000,
  "hunyuan": 128_000,
  // --- MiniMax (M3 1M with MSA sparse attention; M2.x ~200k) ---
  "minimax-m3": 1_000_000,
  "minimax-m2": 200_000,
  // --- xAI Grok (4.5/4.6/4.7 500k; 4.3/4.20 1M; build 256k) ---
  "grok-4.7": 500_000,
  "grok-4.6": 500_000,
  "grok-4.5": 500_000,
  "grok-4.3": 1_000_000,
  "grok-4.20": 1_000_000,
  "grok-build": 256_000,
  "grok-4": 256_000,
  // --- Mistral (Large 4 1M; Medium/Small ~128k) ---
  "mistral-large-4": 1_000_000,
  "mistral-medium-3": 128_000,
  "mistral-small-4": 128_000,
  "codestral": 256_000,
  // --- NVIDIA Nemotron (3 Super/Ultra 1M official spec) ---
  "nemotron-3-super": 1_000_000,
  "nemotron-3-ultra": 1_000_000,
  "nemotron-3-nano": 262_000,
  // --- StepFun (Step 5 1M; Step 3.7 Flash 262k) ---
  "step-5": 1_000_000,
  "step-3.7": 262_000,
  "step-3.5": 262_000,
};

/** Curated unit prices (USD per MILLION tokens, input/output). Approximate
 * published API prices as of 2026-10 — the UI labels the figure an estimate
 * and `iflow.costTable` overrides let BYOK users pin their real contract. */
export const COST_TABLE: Readonly<Record<string, { input: number; output: number }>> = {
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4o": { input: 2.5, output: 10 },
  "o3": { input: 2, output: 8 },
  "o4-mini": { input: 1.1, output: 4.4 },
  "claude-sonnet": { input: 3, output: 15 },
  "claude-opus": { input: 15, output: 75 },
  "claude-haiku": { input: 0.8, output: 4 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "deepseek-chat": { input: 0.27, output: 1.1 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
  "deepseek-v3": { input: 0.27, output: 1.1 },
  "kimi-k2": { input: 0.6, output: 2.5 },
  "glm-4.6": { input: 0.6, output: 2.2 },
  "glm-5": { input: 1, output: 3.2 },
};

/** `openai/gpt-4o-2024-11-20` → `gpt-4o-2024-11-20`: provider prefixes and
 * case drift must not defeat a table hit. */
export function normalizeModelId(modelId: string | null | undefined): string {
  if (!modelId) return "";
  const bare = modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId;
  return bare.trim().toLowerCase();
}

/**
 * Parse `模型名=数值` entries (the `iflow.contextWindowOverrides` setting).
 * Malformed or non-positive entries are dropped silently — a typo in one
 * override must not disable the whole table.
 */
export function parseContextWindowOverrides(entries: readonly string[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const raw of entries ?? []) {
    const idx = raw.indexOf("=");
    if (idx <= 0) continue;
    const key = normalizeModelId(raw.slice(0, idx));
    const value = Number(raw.slice(idx + 1).trim());
    if (!key || !Number.isFinite(value) || value <= 0) continue;
    out[key] = Math.floor(value);
  }
  return out;
}

/** Longest-normalized-key match wins (`glm-4.6` beats a `glm-*` style key). */
function lookup<T>(table: Readonly<Record<string, T>>, modelId: string | null | undefined): T | null {
  const key = normalizeModelId(modelId);
  if (!key) return null;
  const direct = table[key];
  if (direct !== undefined) return direct;
  let bestKey = "";
  let best: T | undefined;
  for (const candidate of Object.keys(table)) {
    if (candidate.length > bestKey.length && key.startsWith(candidate)) {
      bestKey = candidate;
      best = table[candidate];
    }
  }
  return best ?? null;
}

/** Resolve the context window for a model: override → curated table →
 * conservative default (`estimated: true`). A null model id yields a null
 * window so the bar can hide the percentage instead of inventing one. */
export function resolveContextWindow(
  modelId: string | null | undefined,
  overrides: Record<string, number>,
): { window: number | null; estimated: boolean } {
  const key = normalizeModelId(modelId);
  if (!key) return { window: null, estimated: false };
  const override = overrides[key];
  if (override !== undefined) return { window: override, estimated: false };
  const tabled = lookup(CONTEXT_WINDOW_TABLE, modelId);
  if (tabled !== null) return { window: tabled, estimated: false };
  return { window: DEFAULT_CONTEXT_WINDOW, estimated: true };
}

/** Parse `模型名=输入价,输出价` entries (the `iflow.costTable` setting). */
export function parseCostTable(entries: readonly string[] | undefined): Record<string, { input: number; output: number }> {
  const out: Record<string, { input: number; output: number }> = {};
  for (const raw of entries ?? []) {
    const idx = raw.indexOf("=");
    if (idx <= 0) continue;
    const key = normalizeModelId(raw.slice(0, idx));
    const parts = raw.slice(idx + 1).split(",");
    if (parts.length !== 2 || !key) continue;
    const input = Number(parts[0]!.trim());
    const output = Number(parts[1]!.trim());
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue;
    out[key] = { input, output };
  }
  return out;
}

/** Unit price for a model: override → curated table → null (UI says 无单价). */
export function resolveCost(
  modelId: string | null | undefined,
  overrides: Record<string, { input: number; output: number }>,
): { input: number; output: number } | null {
  const key = normalizeModelId(modelId);
  if (!key) return null;
  const overridePrice = overrides[key];
  if (overridePrice) return overridePrice;
  return lookup(COST_TABLE, modelId);
}

/** Estimated USD for a usage snapshot (per-million-token unit prices). */
export function estimateCost(
  usage: Pick<SessionUsageUi, "inputTokens" | "outputTokens">,
  price: { input: number; output: number } | null,
): number | null {
  if (!price) return null;
  return (usage.inputTokens / 1_000_000) * price.input + (usage.outputTokens / 1_000_000) * price.output;
}
