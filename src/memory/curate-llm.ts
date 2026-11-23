import type { CurationAction } from "../../shared/memory-curate.js";

/**
 * L2 语义合并层（纯逻辑 + 可注入接口）。
 *
 * 分工：
 *  - 提示词模板在 `prompts/memory-curate.md`，由调用方读入后传给
 *    `buildMergePrompt` —— 本文件**不 import md**：模板在宿主构建时被 esbuild 内联，
 *    测试环境只镜像了同名 loader，直接 import 会让纯逻辑模块绑死在构建产物上。
 *  - 模型调用不在本文件：`src/acp/complete.ts` 的 `streamChatCompletion` 由编排层注入，
 *    这里只负责「拼提示词 → 解析 → 校验 → 转成 `CurationAction`」。
 *  - 本文件零 VSCode 依赖、零文件 I/O、不读时钟，全部是纯函数。
 *
 * 幻觉防护（L2 的风险全在模型自由发挥）：
 *  - keep / absorb 的每一项都必须**逐字**存在于输入事实里，否则整条建议作废；
 *  - absorb 不能为空、不能有重复项、不能与 keep 相交；
 *  - merged 不能为空，也不能与 keep 完全相同（那等于没合并，却会白白触发一次写盘）；
 *  - 任何一条建议失败只进 `rejected` 并附原因，绝不抛错 —— 上层拿到的是「可用的
 *    建议 + 被拒清单」，不会因为模型胡说而中断整理。
 */

/** 一条通过校验的合并建议（全部字段都是 trim 后的原文/压缩文本）。 */
export interface MergeSuggestion {
  /** 保留的事实原文（逐字来自输入列表）。 */
  keep: string;
  /** 被吸收的事实原文（逐字来自输入列表，非空、无重复、不含 keep）。 */
  absorb: string[];
  /** 合并后的新文本：keep + absorb 的压缩表达。 */
  merged: string;
  /** 模型给出的简短理由；缺失时为空串。 */
  reason: string;
}

/** 一条被拒的建议：原样保留模型输出片段，附带拒绝原因。 */
export interface RejectedMerge {
  suggestion: unknown;
  reason: string;
}

export interface MergeParseResult {
  suggestions: MergeSuggestion[];
  rejected: RejectedMerge[];
}

/** 单次喂给模型的事实上限：太多条目会让模型倾向于「凑」合并。 */
export const MAX_MERGE_FACTS = 40;

/** 模板里的事实占位符。 */
const FACTS_PLACEHOLDER = "{{facts}}";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把事实编号后套进模板。编号只是定位器，提示词明确要求模型逐字回填事实文本。
 *
 * 用 `split/join` 而不是 `String.replace`：事实文本里可能出现 `$&`、`$1` 之类的
 * 替换模式，`replace` 会把它们当成分组引用而吞掉内容。占位符缺失直接抛错 ——
 * 少了一整个事实列表的提示词只会产出垃圾，不值得静默降级。
 */
export function buildMergePrompt(template: string, facts: readonly string[]): string {
  if (!template.includes(FACTS_PLACEHOLDER)) {
    throw new Error(`memory-curate prompt template is missing ${FACTS_PLACEHOLDER}`);
  }
  const list =
    facts.length === 0
      ? "(none)"
      : facts.map((fact, index) => `${index + 1}. ${fact}`).join("\n");
  return template.split(FACTS_PLACEHOLDER).join(list);
}

/** 校验一条候选建议；失败时返回拒绝原因而不是抛错。 */
function validateSuggestion(
  candidate: unknown,
  facts: ReadonlySet<string>,
): { ok: true; suggestion: MergeSuggestion } | { ok: false; reason: string } {
  if (!isRecord(candidate)) return { ok: false, reason: "建议不是对象" };

  const keep = typeof candidate.keep === "string" ? candidate.keep.trim() : "";
  if (!keep) return { ok: false, reason: "keep 缺失或为空" };

  const rawAbsorb = candidate.absorb;
  if (!Array.isArray(rawAbsorb)) return { ok: false, reason: "absorb 缺失或不是数组" };
  if (rawAbsorb.length === 0) return { ok: false, reason: "absorb 为空" };

  const absorb: string[] = [];
  for (const item of rawAbsorb) {
    if (typeof item !== "string" || !item.trim()) {
      return { ok: false, reason: "absorb 含非字符串或空项" };
    }
    absorb.push(item.trim());
  }

  const merged = typeof candidate.merged === "string" ? candidate.merged.trim() : "";
  if (!merged) return { ok: false, reason: "merged 缺失或为空" };

  // 幻觉防护：keep / absorb 必须逐字来自输入列表。
  if (!facts.has(keep)) return { ok: false, reason: "keep 不在输入事实中" };
  for (const item of absorb) {
    if (!facts.has(item)) return { ok: false, reason: `absorb 项不在输入事实中：${item}` };
  }

  // 结构约束：absorb 不能吸收 keep 自己，也不能重复。
  if (absorb.includes(keep)) return { ok: false, reason: "keep 与 absorb 有交集" };
  if (new Set(absorb).size !== absorb.length) return { ok: false, reason: "absorb 有重复项" };

  // 无意义合并：合并结果与保留项一字不差，等于什么都没做。
  if (merged === keep) return { ok: false, reason: "merged 与 keep 完全相同" };

  const reason = typeof candidate.reason === "string" ? candidate.reason.trim() : "";
  return { ok: true, suggestion: { keep, absorb, merged, reason } };
}

/**
 * 解析模型回复里的 JSON 信封 `{ "merges": [...] }`。
 *
 * 取首个 `{` 到末个 `}` 做 `JSON.parse`（与 `shared/turn-followup.ts` 的 digObject
 * 同一范式）；解析失败、顶层不是对象、`merges` 不是数组都降级为「空建议 + 一条
 * rejected」，绝不抛错。逐条校验通过的建议进 `suggestions`，其余进 `rejected`。
 */
export function parseMergeResponse(raw: string, facts: readonly string[]): MergeParseResult {
  const text = raw.trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last <= first) {
    return { suggestions: [], rejected: [{ suggestion: text, reason: "回复中没有 JSON 对象" }] };
  }
  const body = text.slice(first, last + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { suggestions: [], rejected: [{ suggestion: body, reason: "JSON 解析失败" }] };
  }
  if (!isRecord(parsed)) {
    return { suggestions: [], rejected: [{ suggestion: parsed, reason: "JSON 顶层不是对象" }] };
  }
  const merges = parsed.merges;
  if (!Array.isArray(merges)) {
    return { suggestions: [], rejected: [{ suggestion: parsed, reason: "缺少 merges 数组" }] };
  }

  const known = new Set(facts.map((fact) => fact.trim()).filter((fact) => fact.length > 0));
  const suggestions: MergeSuggestion[] = [];
  const rejected: RejectedMerge[] = [];
  for (const candidate of merges) {
    const result = validateSuggestion(candidate, known);
    if (result.ok) suggestions.push(result.suggestion);
    else rejected.push({ suggestion: candidate, reason: result.reason });
  }
  return { suggestions, rejected };
}

/**
 * 把通过校验的建议转成 `shared/memory-curate.ts` 的 `merge` 动作。
 *
 * 按文本找行号：keep 找不到 → 跳过整条建议；任一 absorb 找不到、或落到 keep 自己的
 * 行 → 同样跳过（`applyCurationPlan` 的 merge 是原子的，留下半条只会制造脏数据）。
 * 重复映射到同一行的 absorb 静默去重。纯函数，不读文件、不改入参。
 */
export function suggestionsToActions(
  suggestions: readonly MergeSuggestion[],
  facts: ReadonlyArray<{ line: number; text: string }>,
): CurationAction[] {
  const lineByText = new Map<string, number>();
  for (const fact of facts) {
    const key = fact.text.trim();
    if (key && !lineByText.has(key)) lineByText.set(key, fact.line);
  }

  const actions: CurationAction[] = [];
  for (const suggestion of suggestions) {
    const keep = suggestion.keep.trim();
    const merged = suggestion.merged.trim();
    if (!keep || !merged) continue;
    const targetLine = lineByText.get(keep);
    if (targetLine === undefined) continue;

    const mergeLines: number[] = [];
    let resolvable = true;
    for (const item of suggestion.absorb) {
      const key = item.trim();
      const line = key ? lineByText.get(key) : undefined;
      if (line === undefined || line === targetLine) {
        resolvable = false;
        break;
      }
      if (!mergeLines.includes(line)) mergeLines.push(line);
    }
    if (!resolvable || mergeLines.length === 0) continue;
    actions.push({ kind: "merge", targetLine, mergeLines, mergedText: merged });
  }
  return actions;
}

/**
 * 把事实列表按 `size` 切块，避免一次喂太多条目。空数组返回空数组；
 * 非法 `size`（NaN / < 1）退回 `MAX_MERGE_FACTS`。
 */
export function chunkFacts(facts: readonly string[], size: number = MAX_MERGE_FACTS): string[][] {
  const step = Number.isFinite(size) && size >= 1 ? Math.floor(size) : MAX_MERGE_FACTS;
  const chunks: string[][] = [];
  for (let i = 0; i < facts.length; i += step) {
    chunks.push(facts.slice(i, i + step));
  }
  return chunks;
}
