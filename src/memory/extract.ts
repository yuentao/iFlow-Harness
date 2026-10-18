import type { Block, MemoryCandidateUi, MemoryCategory, MemoryScope } from "../../shared/messages.js";
import { sha256 } from "./files.js";

export interface ExtractLimits {
  maxFacts?: number;
  maxInputChars?: number;
  minConfidence?: number;
}

const CATEGORIES = new Set<MemoryCategory>([
  "preference",
  "convention",
  "decision",
  "gotcha",
  "other",
]);

/** Normalize for duplicate detection only — never written to disk. */
export function normalizeFact(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^[-*]\s+/, "")
    .replace(/\s+/g, " ")
    .replace(/[，。；、,.!?！？;:："'“”‘’()（）【】\[\]]/g, "")
    .trim();
}

/** Build the strict JSON-only extraction prompt. */
export function buildExtractionPrompt(
  blocks: readonly Block[],
  existingFacts: readonly string[],
  limits: ExtractLimits = {},
): string {
  const maxInput = limits.maxInputChars ?? 6_000;
  const lines: string[] = [];
  let used = 0;
  for (let i = blocks.length - 1; i >= 0 && used < maxInput; i--) {
    const block = blocks[i];
    if (!block) continue;
    let text: string | null = null;
    if (block.kind === "user") text = block.text;
    else if (block.kind === "text" && !block.system) text = block.text;
    if (!text?.trim()) continue;
    const remaining = Math.max(0, maxInput - used);
    const trimmed = text.trim();
    const clipped = trimmed.length > remaining ? trimmed.slice(trimmed.length - remaining) : trimmed;
    if (!clipped) break;
    lines.unshift(`${block.kind === "user" ? "用户" : "助手"}：${clipped}`);
    used += clipped.length;
  }
  const existing = existingFacts
    .map((f) => `- ${f.trim()}`)
    .filter((f) => f.length > 2)
    .slice(0, 60)
    .join("\n");
  return [
    "你在为一个编码助手整理跨会话长期记忆。",
    "只提取稳定、可复用、对以后任务有帮助的信息：",
    "- 用户偏好（语言、风格、工具、沟通方式）",
    "- 项目约定（架构、目录、测试方式、依赖管理）",
    "- 已确认的技术决策",
    "- 反复踩到的陷阱",
    "不要提取：一次性任务细节、代码正文、密钥、临时路径、未确认的猜测。",
    "",
    "已有记忆（不要重复）：",
    existing || "（无）",
    "",
    "最近对话：",
    lines.join("\n") || "（无）",
    "",
    "只输出 JSON，不要 markdown 代码围栏、不要解释：",
    '{"facts":[{"text":"...","scope":"global|project","category":"preference|convention|decision|gotcha|other","confidence":0.0}]}',
  ].join("\n");
}

export interface ParseCandidateOptions extends ExtractLimits {
  existingFacts?: readonly string[];
  /** When false, project-scoped candidates are downgraded to global. */
  allowProject?: boolean;
}

/**
 * Parse + validate the model's JSON. Every failure degrades to [] — the host
 * never guesses a fact. Dedupe is normalized-text based (existing memory and
 * repeated candidates), and confidence < 0.6 is dropped.
 */
export function parseCandidates(raw: string, options: ParseCandidateOptions = {}): MemoryCandidateUi[] {
  const maxFacts = options.maxFacts ?? 5;
  const minConfidence = options.minConfidence ?? 0.6;
  const allowProject = options.allowProject !== false;
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last <= first) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(first, last + 1));
  } catch {
    return [];
  }
  const facts = (parsed as { facts?: unknown })?.facts;
  if (!Array.isArray(facts)) return [];

  const seen = new Set<string>();
  for (const fact of options.existingFacts ?? []) {
    const key = normalizeFact(fact);
    if (key) seen.add(key);
  }

  const out: MemoryCandidateUi[] = [];
  for (const item of facts) {
    if (out.length >= maxFacts) break;
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (text.length < 5 || text.length > 300) continue;
    const key = normalizeFact(text);
    if (!key || seen.has(key)) continue;
    const scope: MemoryScope =
      record.scope === "project" && allowProject ? "project" : "global";
    const category: MemoryCategory =
      typeof record.category === "string" && CATEGORIES.has(record.category as MemoryCategory)
        ? (record.category as MemoryCategory)
        : "other";
    const confidence =
      typeof record.confidence === "number" && Number.isFinite(record.confidence)
        ? record.confidence
        : 0.7;
    if (confidence < minConfidence) continue;
    seen.add(key);
    out.push({
      id: sha256(key).slice(0, 12),
      text,
      scope,
      category,
      confidence: Math.min(1, Math.max(0, confidence)),
    });
  }
  return out;
}
