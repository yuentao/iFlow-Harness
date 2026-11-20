import { renderPrompt } from "../prompts/index.js";
import { normalizeModelId } from "./context-window.js";
import type { ThinkingModelRuleUi } from "./messages.js";

/**
 * 「联网补充模型数据」: the settings button runs a host-side web search and
 * asks the model to extract model metadata (context window, prices, thinking
 * support) from the retrieved snippets. Everything that touches the answer
 * (query building, prompt construction, envelope parsing, merge planning)
 * lives here as pure logic so the never-fabricate discipline is testable.
 *
 * The flow deliberately avoids a CLI agent session: the bundled CLI only
 * exposes `web_search` when a platform search key is configured (and it
 * carries no search backend for third-party gateway keys), while an agent
 * session drags in the whole system prompt + project memory + tool schemas —
 * measured 56,287 input tokens per turn for a trivial prompt. A plain
 * completion over a few hundred search snippets costs a few thousand.
 */

export interface ModelMetadataEntry {
  name: string;
  contextWindow?: number;
  inputPrice?: number;
  outputPrice?: number;
  supportsThinking?: boolean;
  /** Id of the source snippet the entry was read from (S1, S2, …). */
  source?: string;
}

/** One retrieved search snippet the model may cite. */
export interface MetadataSource {
  id: string;
  title: string;
  url: string;
  snippet: string;
}

/** Caps keep a chatty search turn from bloating the settings tables. */
export const MODEL_METADATA_MAX_ENTRIES = 80;
/** Model ids handed to the prompt (the profile list can be long). */
export const MODEL_METADATA_MAX_MODEL_IDS = 60;
/** Search queries per fetch (two per model id + one market-wide). */
export const MODEL_METADATA_MAX_QUERIES = 30;

const CONTEXT_WINDOW_MIN = 1_000;
const CONTEXT_WINDOW_MAX = 10_000_000;
const PRICE_MAX = 1_000;

/** One market-wide query that actually returns comparison tables. */
const MARKET_QUERY = "大模型 API 价格 对比 2026";

/**
 * Search queries for one fetch: two per model id of the user's profile (one
 * for the prices, one for the context length — a single combined query
 * rarely surfaces both facts) plus one market-wide comparison query. Capped —
 * a profile with dozens of models must not turn into dozens of round-trips.
 *
 * Query shape is load-bearing (probed against cn.bing.com, 2026-10-23):
 * `<id> pricing` / `<id> context window` / `<id> context length 1M` all
 * return Bing's brand card — the same fixed six results (vendor homepage,
 * Baidu Baike, app download, GitHub org, App Store, Hugging Face) regardless
 * of the id — because the hyphenated id is read as a brand token. The same
 * intent in Chinese (`<id> 价格`, `<id> 上下文长度`) returns the official
 * pricing/parameter pages. Adding a number ("上下文窗口 1M") re-triggers the
 * brand card, so the queries stay short. The market-wide query is likewise
 * shape-sensitive: "大模型 API 价格 对比 2026" returns comparison tables,
 * while "主流大模型 上下文窗口 价格 对比" degrades to dictionary results.
 */
export function buildMetadataQueries(modelIds: readonly string[]): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  const push = (query: string): void => {
    const key = query.toLowerCase();
    if (seen.has(key) || queries.length >= MODEL_METADATA_MAX_QUERIES) return;
    seen.add(key);
    queries.push(query);
  };
  for (const id of modelIds.slice(0, MODEL_METADATA_MAX_MODEL_IDS)) {
    const name = id.trim();
    if (!name) continue;
    push(`${name} 价格`);
    push(`${name} 上下文长度`);
  }
  push(MARKET_QUERY);
  return queries;
}

/**
 * Prompt for the extraction turn (wording in `prompts/model-metadata.md`). The
 * model may only use the provided snippets, and every entry must cite the
 * source it was read from — the parser drops entries whose citation is missing
 * or whose source never mentions the model, so a hallucinated row cannot reach
 * the settings.
 */
export function buildModelMetadataPrompt(
  modelIds: readonly string[],
  sources: readonly MetadataSource[],
): string {
  const ids = modelIds.slice(0, MODEL_METADATA_MAX_MODEL_IDS);
  return renderPrompt("model-metadata", {
    maxEntries: String(MODEL_METADATA_MAX_ENTRIES),
    ids: ids.length > 0 ? ids.map((id) => `- ${id}`).join("\n") : "(none)",
    sources: sources.length === 0
      ? "(none)"
      : sources
        .map((source) => `${source.id} | ${source.title} | ${source.url} | ${source.snippet}`)
        .join("\n"),
  });
}

/** Dig the outermost JSON object out of a reply (fences / preambles tolerated). */
function digObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

/** Model ids must survive the `模型名=数值` line format: no `=`, no newline. */
function validName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > 120 || name.includes("=") || /[\r\n]/.test(name)) return null;
  return name;
}

function validWindow(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const window = Math.floor(value);
  if (window < CONTEXT_WINDOW_MIN || window > CONTEXT_WINDOW_MAX) return undefined;
  return window;
}

function validPrice(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > PRICE_MAX) return undefined;
  return value;
}

/**
 * Parse the model's answer into validated entries. Anything unparseable or
 * out-of-range yields no entry (never a fabricated row); malformed fields
 * inside an otherwise valid entry are dropped individually.
 *
 * When the caller passes the retrieved `sources`, an entry must additionally
 * cite one of them (`source`) AND that source must actually mention the
 * model — a citation the snippet cannot back is a fabricated row and is
 * dropped whole.
 */
export function parseModelMetadata(
  raw: string | null | undefined,
  sources?: readonly MetadataSource[],
): ModelMetadataEntry[] {
  if (!raw) return [];
  const obj = digObject(raw);
  const models = obj?.models;
  if (!Array.isArray(models)) return [];
  const out: ModelMetadataEntry[] = [];
  for (const item of models.slice(0, MODEL_METADATA_MAX_ENTRIES)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const name = validName(entry.name);
    if (!name) continue;
    const parsed: ModelMetadataEntry = { name };
    const contextWindow = validWindow(entry.contextWindow);
    if (contextWindow !== undefined) parsed.contextWindow = contextWindow;
    const inputPrice = validPrice(entry.inputPrice);
    if (inputPrice !== undefined) parsed.inputPrice = inputPrice;
    const outputPrice = validPrice(entry.outputPrice);
    if (outputPrice !== undefined) parsed.outputPrice = outputPrice;
    if (typeof entry.supportsThinking === "boolean") parsed.supportsThinking = entry.supportsThinking;
    if (typeof entry.source === "string" && entry.source.trim()) parsed.source = entry.source.trim();
    // An entry whose every field was rejected carries no data — drop it whole.
    if (parsed.contextWindow === undefined && parsed.inputPrice === undefined && parsed.outputPrice === undefined && parsed.supportsThinking === undefined) {
      continue;
    }
    if (sources && !entryIsGrounded(parsed, sources)) continue;
    out.push(parsed);
  }
  return out;
}

/** Strip everything but alphanumerics so "DeepSeek-V3.2" matches "deepseek v3.2". */
function looseKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Is the entry backed by the source it cites? The citation must exist, the
 * source text must mention the model, and every number the model reported
 * must be findable in that source — otherwise the row is a guess.
 */
function entryIsGrounded(entry: ModelMetadataEntry, sources: readonly MetadataSource[]): boolean {
  if (!entry.source) return false;
  const source = sources.find((s) => s.id === entry.source);
  if (!source) return false;
  const text = `${source.title} ${source.url} ${source.snippet}`;
  const haystack = looseKey(text);
  const needle = looseKey(entry.name);
  if (!needle || !haystack.includes(needle)) return false;
  if (entry.contextWindow !== undefined && !contextWindowAppears(entry.contextWindow, text)) return false;
  if (entry.inputPrice !== undefined && !priceAppears(entry.inputPrice, text, "input")) return false;
  if (entry.outputPrice !== undefined && !priceAppears(entry.outputPrice, text, "output")) return false;
  return true;
}

/** "200000" must be findable as 200000 / 200,000 / 200K / 20万. */
function contextWindowAppears(value: number, text: string): boolean {
  const haystack = text.toLowerCase();
  const grouped = String(value).replace(/(\d)(?=(\d{3})+(?!\d))/g, "$1,");
  const spaced = String(value).replace(/(\d)(?=(\d{3})+(?!\d))/g, "$1 ");
  const candidates = new Set<string>([String(value), grouped, spaced]);
  if (value % 1000 === 0) candidates.add(`${value / 1000}k`);
  if (value % 1_000_000 === 0) candidates.add(`${value / 1_000_000}m`);
  if (value % 10_000 === 0) candidates.add(`${value / 10_000}万`);
  return [...candidates].some((candidate) => haystack.includes(candidate.toLowerCase()));
}

type PriceKind = "input" | "output";

/** Currency / billing / role markers used by `priceAppears` below. */
const USD_MARKERS = ["$", "us$", "usd", "美元", "美金"];
const NON_USD_MARKERS = ["¥", "￥", "人民币", "rmb", "cny", "元"];
const RECURRING_MARKERS = [
  "月费", "每月", "包月", "包年", "订阅", "/月", "/年",
  "monthly", "annual", "per month", "per year", "/mo", "/yr",
];
const INPUT_LABELS = ["input", "输入", "prompt"];
const OUTPUT_LABELS = ["output", "输出", "completion", "生成"];

function hasAny(text: string, markers: readonly string[]): boolean {
  return markers.some((marker) => text.includes(marker));
}

/**
 * All positions where the price number is written in the text. Candidates are
 * tried longest-first so `0.600` wins over `0.6`, and a match embedded in a
 * longer number (`0.6` inside `0.60`, `2` inside `200000`) is ignored via a
 * digit/dot boundary check — this preserves the original unit-aware grounding
 * without weakening it.
 */
function priceOccurrences(value: number, text: string): Array<{ index: number; length: number }> {
  const haystack = text.toLowerCase();
  const candidates: string[] = [];
  const add = (candidate: string): void => {
    if (!candidates.includes(candidate)) candidates.push(candidate);
  };
  add(String(value));
  for (const digits of [1, 2, 3, 4]) add(value.toFixed(digits));
  candidates.sort((a, b) => b.length - a.length);
  const found: Array<{ index: number; length: number }> = [];
  const seen = new Set<number>();
  for (const candidate of candidates) {
    let from = 0;
    while (from <= haystack.length - candidate.length) {
      const index = haystack.indexOf(candidate, from);
      if (index < 0) break;
      const before = index > 0 ? haystack[index - 1]! : "";
      const after = index + candidate.length < haystack.length ? haystack[index + candidate.length]! : "";
      if (!/[0-9.]/.test(before) && !/[0-9]/.test(after) && !seen.has(index)) {
        seen.add(index);
        found.push({ index, length: candidate.length });
      }
      from = index + candidate.length;
    }
  }
  return found;
}

/**
 * Which role label owns a number: only a label directly adjacent to it (gap
 * made of currency symbols / spaces / punctuation) counts. In
 * `input $0.6 output $2.4` the `input` label owns 0.6 and `output` owns 2.4 —
 * a following `output` does not own the number that precedes it. When neither
 * side is adjacent (e.g. a bare table cell) we defer rather than reject, so a
 * legitimate price is never dropped over a distant header.
 */
function adjacentPriceRole(text: string, index: number, length: number): PriceKind | null {
  const lower = text.toLowerCase();
  const beforeRel = lower.slice(Math.max(0, index - 20), index);
  const newline = beforeRel.lastIndexOf("\n");
  const before = newline >= 0 ? beforeRel.slice(newline + 1) : beforeRel;
  const after = lower.slice(index + length, index + length + 20);
  const groups: ReadonlyArray<readonly [readonly string[], PriceKind]> = [
    [INPUT_LABELS, "input"],
    [OUTPUT_LABELS, "output"],
  ];
  for (const [labels, role] of groups) {
    for (const label of labels) {
      const at = before.lastIndexOf(label);
      if (at >= 0 && /^[$:：\s]{0,3}$/.test(before.slice(at + label.length))) return role;
    }
  }
  for (const [labels, role] of groups) {
    for (const label of labels) {
      const at = after.indexOf(label);
      if (at >= 0 && /^[\s():，,、]{0,3}$/.test(after.slice(0, at))) return role;
    }
  }
  return null;
}

/** Is one written occurrence of the number a legitimate per-token USD price? */
function priceOccurrenceUsable(
  text: string,
  occurrence: { index: number; length: number },
  kind: PriceKind,
): boolean {
  const lower = text.toLowerCase();
  const beforeRel = lower.slice(Math.max(0, occurrence.index - 34), occurrence.index);
  const newline = beforeRel.lastIndexOf("\n");
  const before = newline >= 0 ? beforeRel.slice(newline + 1) : beforeRel;
  const after = lower.slice(occurrence.index + occurrence.length);

  // Currency: a CNY/non-USD marker without any USD marker means the number is
  // a local-currency price (settings are USD-denominated, no conversion).
  // A USD marker wins when both appear, e.g. in a mixed comparison table.
  const near = before.slice(-18) + after.slice(0, 8);
  if (hasAny(near, NON_USD_MARKERS) && !hasAny(near, USD_MARKERS)) return false;

  // A monthly / annual / subscription fee is not a per-token unit price.
  if (hasAny(before.slice(-26) + after.slice(0, 14), RECURRING_MARKERS)) return false;

  // Role: reject when an adjacent role label contradicts the field being
  // validated (e.g. an "output" price reported as inputPrice).
  const role = adjacentPriceRole(text, occurrence.index, occurrence.length);
  if (role !== null && role !== kind) return false;

  return true;
}

/**
 * "0.6" must be findable as 0.6 / 0.60 / $0.6 / 0.600 — AND at least one such
 * occurrence must be a USD (or unlabelled, but USD-context) per-token price
 * for the correct input/output role. CNY prices, subscription fees and numbers
 * belonging to the opposite role never ground a price field.
 */
function priceAppears(value: number, text: string, kind: PriceKind): boolean {
  return priceOccurrences(value, text).some((occurrence) => priceOccurrenceUsable(text, occurrence, kind));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does an existing thinking rule already cover this model name? */
function ruleCovers(pattern: string, name: string): boolean {
  try {
    return new RegExp(pattern, "i").test(name);
  } catch {
    // A malformed stored pattern cannot claim coverage (it would fail in the
    // CLI's matcher too) — treat it as not covering.
    return false;
  }
}

export interface ExistingMetadata {
  contextWindowOverrides: readonly string[];
  costTable: readonly string[];
  thinkingModelRules: readonly ThinkingModelRuleUi[];
}

export interface MetadataAdditions {
  windows: string[];
  costs: string[];
  rules: ThinkingModelRuleUi[];
  total: number;
}

/**
 * Plan what to APPEND to the three metadata tables. Existing rows are never
 * rewritten: a model already pinned by the user (case-insensitive, provider
 * prefixes stripped via normalizeModelId) is skipped, as are duplicates
 * inside one batch. Cost lines need BOTH prices (the setting format is
 * `name=input,output`). Thinking rules are appended only for `true` — a
 * `false` answer would override the CLI's built-in capability rules with a
 * guess, so unsupported models simply get no rule.
 */
export function planMetadataAdditions(
  entries: readonly ModelMetadataEntry[],
  existing: ExistingMetadata,
): MetadataAdditions {
  const windowKeys = new Set<string>();
  for (const line of existing.contextWindowOverrides) {
    const idx = line.indexOf("=");
    if (idx > 0) windowKeys.add(normalizeModelId(line.slice(0, idx)));
  }
  const costKeys = new Set<string>();
  for (const line of existing.costTable) {
    const idx = line.indexOf("=");
    if (idx > 0) costKeys.add(normalizeModelId(line.slice(0, idx)));
  }

  const windows: string[] = [];
  const costs: string[] = [];
  const rules: ThinkingModelRuleUi[] = [];
  const seenWindows = new Set<string>();
  const seenCosts = new Set<string>();
  const seenRules = new Set<string>();

  for (const entry of entries) {
    const key = normalizeModelId(entry.name);
    if (!key) continue;
    if (entry.contextWindow !== undefined && !windowKeys.has(key) && !seenWindows.has(key)) {
      seenWindows.add(key);
      windows.push(`${entry.name}=${entry.contextWindow}`);
    }
    if (
      entry.inputPrice !== undefined
      && entry.outputPrice !== undefined
      && !costKeys.has(key)
      && !seenCosts.has(key)
    ) {
      seenCosts.add(key);
      costs.push(`${entry.name}=${entry.inputPrice},${entry.outputPrice}`);
    }
    if (entry.supportsThinking === true && !seenRules.has(key)) {
      seenRules.add(key);
      if (!existing.thinkingModelRules.some((rule) => ruleCovers(rule.pattern, entry.name))) {
        rules.push({ pattern: `^${escapeRegExp(entry.name)}$`, supportsThinking: true });
      }
    }
  }
  return { windows, costs, rules, total: windows.length + costs.length + rules.length };
}
