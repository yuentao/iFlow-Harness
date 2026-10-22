import { normalizeModelId } from "./context-window.js";
import type { ThinkingModelRuleUi } from "./messages.js";

/**
 * 「联网补充模型数据」: the settings button drives a throwaway CLI agent
 * session whose only allowed tool is `web_search`. The agent searches the
 * live `/models` list of the user's API profile plus the newest mainstream
 * models on the market, and answers with one JSON envelope. Everything that
 * touches the answer (prompt construction, envelope parsing, merge planning)
 * lives here as pure logic so the never-fabricate discipline is testable.
 */

export interface ModelMetadataEntry {
  name: string;
  contextWindow?: number;
  inputPrice?: number;
  outputPrice?: number;
  supportsThinking?: boolean;
}

/** Caps keep a chatty search turn from bloating the settings tables. */
export const MODEL_METADATA_MAX_ENTRIES = 80;
/** Model ids handed to the prompt (the profile list can be long). */
export const MODEL_METADATA_MAX_MODEL_IDS = 60;

const CONTEXT_WINDOW_MIN = 1_000;
const CONTEXT_WINDOW_MAX = 10_000_000;
const PRICE_MAX = 1_000;

/**
 * Prompt for the metadata turn. Unlike the pure-text internal prompts
 * (pitfall #26) this task genuinely needs a tool — `web_search` — so it runs
 * on an agent session instead of a direct completion. The tool surface is
 * narrowed by instruction (the host auto-denies every permission request on
 * this session anyway) and the answer must be a bare JSON envelope: a missing
 * field is omitted, never guessed.
 */
export function buildModelMetadataPrompt(modelIds: readonly string[]): string {
  const ids = modelIds.slice(0, MODEL_METADATA_MAX_MODEL_IDS);
  return [
    "你在一次任务里为编码助手收集模型元数据（上下文窗口、单价、思考能力）。",
    "规则：",
    "- 只允许调用 web_search 工具检索资料。不要读取或写入任何文件、不要执行命令、不要创建子代理、不要向用户提问。",
    "- 对下面每个模型 ID，检索其官方文档与定价页，得到：上下文窗口（token 数）、输入/输出单价（USD 每百万 token）、是否支持思考模式。",
    "- 另外检索 2026 年市面上最新的主流大模型（近期发布的旗舰与开源模型），一并给出它们的元数据。",
    "- 数据必须来自检索结果；无法确认的字段直接省略该键，绝不猜测、编造或沿用记忆中的旧数值。",
    "- 最后只输出一个 JSON 对象：不要 markdown 代码围栏、不要解释文字。对象只有一个键 models，是数组，每项形如",
    '  {"name":"模型真实ID","contextWindow":200000,"inputPrice":0.27,"outputPrice":1.1,"supportsThinking":true}',
    `- name 用模型的真实 ID；每个模型最多一条；总数不超过 ${MODEL_METADATA_MAX_ENTRIES} 条。`,
    "",
    "当前 API 配置中的模型 ID：",
    ids.length > 0 ? ids.map((id) => `- ${id}`).join("\n") : "（无）",
  ].join("\n");
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
 * Parse the agent's answer into validated entries. Anything unparseable or
 * out-of-range yields no entry (never a fabricated row); malformed fields
 * inside an otherwise valid entry are dropped individually.
 */
export function parseModelMetadata(raw: string | null | undefined): ModelMetadataEntry[] {
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
    // An entry whose every field was rejected carries no data — drop it whole.
    if (parsed.contextWindow === undefined && parsed.inputPrice === undefined && parsed.outputPrice === undefined && parsed.supportsThinking === undefined) {
      continue;
    }
    out.push(parsed);
  }
  return out;
}

/**
 * Pick the model for the metadata turn: the panel's current selection when
 * the live list proves it exists on this endpoint (pitfall #25 — pushing a
 * delisted model means `model_not_found`), else the profile's configured
 * model, else the first live id. Never push an id the live list did not
 * report.
 */
export function pickMetadataModel(
  currentModelId: string | null | undefined,
  endpointModelName: string | null | undefined,
  liveIds: readonly string[],
): string | null {
  if (liveIds.length === 0) return null;
  for (const candidate of [currentModelId, endpointModelName]) {
    if (!candidate) continue;
    const key = normalizeModelId(candidate);
    if (liveIds.some((id) => normalizeModelId(id) === key)) return candidate;
  }
  return liveIds[0] ?? null;
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
