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

/**
 * Transcript excerpt for the memory task: the newest blocks, clipped to the
 * byte budget, as `用户：… / 助手：…` lines. The instruction text and the JSON
 * envelope spec live in the merged turn-end prompt (shared/turn-followup.ts),
 * so this stays a pure data builder.
 */
export function buildExtractionConversation(
  blocks: readonly Block[],
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
  return lines.join("\n");
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
