import path from "node:path";
import { normalizeFact } from "./extract.js";
import { readIfExists, sha256, writeAtomic } from "./files.js";

/**
 * Sidecar metadata for memory maintenance (fact ages / usage counters).
 *
 * The memory files themselves must stay byte-identical to what the CLI's
 * `save_memory` tool produces — the loader parses them and anything we add
 * there would be injected into the model's context. So the metadata lives in
 * a separate file under the memory home:
 *
 *   <memoryHome>/memory-maintenance/meta.json
 *
 * `memoryHome()` is `~/.iflow`, i.e. the file ends up at
 * `~/.iflow/memory-maintenance/meta.json` next to `AGENTS.md`. The path is
 * derived through the exported helpers below (never hardcode `os.homedir()`),
 * so a test / a future layout change only has to move one function.
 */
export const MAINTENANCE_DIR = "memory-maintenance";
export const MAINTENANCE_META_FILE = "meta.json";

export interface FactMeta {
  /** ISO timestamp of the first time the fact was observed. */
  firstSeenAt: string;
  /** ISO timestamp of the most recent observation. */
  lastSeenAt: string;
  /** How many times the fact was observed (extraction / rewrite / use). */
  useCount: number;
}

export interface MemoryMaintenanceMeta {
  version: 1;
  /** Fingerprint (see `factFingerprint`) → metadata. */
  facts: Record<string, FactMeta>;
}

export function emptyMeta(): MemoryMaintenanceMeta {
  return { version: 1, facts: {} };
}

export function maintenanceDir(home: string): string {
  return path.join(home, MAINTENANCE_DIR);
}

export function maintenanceMetaPath(home: string): string {
  return path.join(maintenanceDir(home), MAINTENANCE_META_FILE);
}

/**
 * Fact identity: the normalized text (same rule `parseCandidates` uses for
 * duplicate detection — lowercase, collapse whitespace, strip bullets and
 * punctuation) hashed with sha256. Normalizing first keeps "Use pnpm." and
 * "use  pnpm" on one row; a rewrite to a different text gets a new row.
 */
export function factFingerprint(text: string): string {
  return sha256(normalizeFact(text));
}

/** Parse the sidecar defensively: unknown versions / malformed entries are
 * dropped instead of failing the whole file (the metadata is advisory). */
function parseMeta(raw: string): MemoryMaintenanceMeta {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyMeta();
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) return emptyMeta();
  const rawFacts = record.facts;
  if (!rawFacts || typeof rawFacts !== "object" || Array.isArray(rawFacts)) return emptyMeta();
  const facts: Record<string, FactMeta> = {};
  for (const [key, value] of Object.entries(rawFacts as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const firstSeenAt = typeof entry.firstSeenAt === "string" ? entry.firstSeenAt : null;
    const lastSeenAt = typeof entry.lastSeenAt === "string" ? entry.lastSeenAt : null;
    const useCount =
      typeof entry.useCount === "number" && Number.isFinite(entry.useCount) ? entry.useCount : null;
    if (firstSeenAt === null || lastSeenAt === null || useCount === null) continue;
    facts[key] = { firstSeenAt, lastSeenAt, useCount };
  }
  return { version: 1, facts };
}

/** Missing or corrupted sidecar → empty structure (never throws). */
export async function loadMeta(home: string): Promise<MemoryMaintenanceMeta> {
  try {
    const raw = await readIfExists(maintenanceMetaPath(home));
    if (raw === null || raw.trim().length === 0) return emptyMeta();
    return parseMeta(raw);
  } catch {
    return emptyMeta();
  }
}

/** Atomic write (temp + rename) through the memory writer. */
export async function saveMeta(home: string, meta: MemoryMaintenanceMeta): Promise<void> {
  await writeAtomic(maintenanceMetaPath(home), `${JSON.stringify(meta, null, 2)}\n`);
}

/**
 * Record one observation of `text`. Returns a NEW object — the input meta is
 * never mutated, so callers can compare before/after cheaply. Blank text is a
 * no-op (nothing to fingerprint).
 */
export function touchFact(
  meta: MemoryMaintenanceMeta,
  text: string,
  now: string = new Date().toISOString(),
): MemoryMaintenanceMeta {
  const normalized = normalizeFact(text);
  if (!normalized) return meta;
  const key = sha256(normalized);
  const previous = meta.facts[key];
  const next: FactMeta = previous
    ? { firstSeenAt: previous.firstSeenAt, lastSeenAt: now, useCount: previous.useCount + 1 }
    : { firstSeenAt: now, lastSeenAt: now, useCount: 1 };
  return { version: 1, facts: { ...meta.facts, [key]: next } };
}

/**
 * Drop metadata for facts that no longer exist in ANY memory file. Returns a
 * new object; facts whose text is still present keep their counters.
 */
export function pruneMeta(
  meta: MemoryMaintenanceMeta,
  existingTexts: readonly string[],
): MemoryMaintenanceMeta {
  const keep = new Set<string>();
  for (const text of existingTexts) {
    const normalized = normalizeFact(text);
    if (normalized) keep.add(sha256(normalized));
  }
  const facts: Record<string, FactMeta> = {};
  for (const [key, value] of Object.entries(meta.facts)) {
    if (keep.has(key)) facts[key] = value;
  }
  return { version: 1, facts };
}
