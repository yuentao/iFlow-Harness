/**
 * M3 P0-1 — turn-level checkpoint reducers & index (pure, unit-testable).
 *
 * One checkpoint per user turn: before the prompt is sent, the host snapshots
 * the workspace into a shadow git repo (GIT_DIR under the extension's
 * storageUri, work-tree = session cwd — the user's own .git is never touched).
 * The UI projection (`CheckpointUi`) rides the blockPatch tail channel like
 * the queue; the heavy truth (shadow commits) lives on disk, the JSON index
 * beside it mirrors the projection with the same temp-write + rename
 * discipline as transcripts.
 *
 * Anchoring: a checkpoint is anchored to the stable id (P4 `BlockBase.id`) of
 * the user block that opened the turn — the same id `deleteUserMessage` uses,
 * so conversation truncation and index pruning share one key.
 */

import type { CheckpointUi } from "./messages.js";
import { normalizeUserPromptText } from "./messages.js";

/** Label shown in the restore dialog: first line of the prompt, 30 chars. */
export const CHECKPOINT_LABEL_MAX_CHARS = 30;

export function checkpointLabelFromText(text: string): string {
  const firstLine = normalizeUserPromptText(text).split("\n")[0]?.trim() ?? "";
  return firstLine.length > CHECKPOINT_LABEL_MAX_CHARS
    ? `${firstLine.slice(0, CHECKPOINT_LABEL_MAX_CHARS)}…`
    : firstLine;
}

/**
 * Append or replace the checkpoint for one turn anchor (idempotent per
 * userBlockId — a retried capture overwrites the partial placeholder).
 * Immutable: returns a NEW array.
 */
export function upsertCheckpoint(
  list: readonly CheckpointUi[],
  entry: CheckpointUi,
): CheckpointUi[] {
  const idx = list.findIndex((c) => c.userBlockId === entry.userBlockId);
  if (idx < 0) return [...list, entry];
  const next = [...list];
  next[idx] = entry;
  return next;
}

/**
 * Drop checkpoints whose anchor user block is gone (after a
 * `deleteUserMessage` truncation — the deleted turns' restores would anchor to
 * nothing). Keeps entries for blocks that still exist, in original order.
 */
export function pruneCheckpointsForBlocks(
  list: readonly CheckpointUi[],
  blocks: readonly { kind: string; id?: string }[],
): CheckpointUi[] {
  const alive = new Set<string>();
  for (const b of blocks) {
    if (b.kind === "user" && b.id) alive.add(b.id);
  }
  const next = list.filter((c) => alive.has(c.userBlockId));
  return next.length === list.length ? [...list] : next;
}

/**
 * Re-anchor a restored session's checkpoints to the freshly re-minted block
 * ids. `reassignBlockIds` mints new ids on EVERY restore (structural
 * isolation — the persisted transcript keeps the originals, lossless), so a
 * loaded index's anchors are stale the moment the transcript enters the live
 * array. The caller snapshots the user ids immediately before and after the
 * re-mint (same array, same order — only ids differ) and passes the old→new
 * map; entries whose old id is absent (block didn't survive) are dropped.
 */
export function reanchorCheckpoints(
  list: readonly CheckpointUi[],
  remap: ReadonlyMap<string, string>,
): CheckpointUi[] {
  const out: CheckpointUi[] = [];
  for (const c of list) {
    const id = remap.get(c.userBlockId);
    if (id) out.push({ ...c, userBlockId: id });
  }
  return out;
}

/** On-disk index shape (`checkpoints/<sessionId>/index.json`). */
export interface CheckpointIndexFile {
  version: 1;
  checkpoints: readonly CheckpointUi[];
}

export function serializeCheckpointIndex(checkpoints: readonly CheckpointUi[]): string {
  return JSON.stringify({ version: 1, checkpoints: [...checkpoints] } satisfies CheckpointIndexFile);
}

/** Parse one index file; null when corrupt or shape-unknown (callers treat
 * null as "no checkpoints" — same discipline as readTranscript). */
export function parseCheckpointIndex(raw: string): CheckpointUi[] | null {
  try {
    const parsed = JSON.parse(raw) as Partial<CheckpointIndexFile>;
    if (!Array.isArray(parsed.checkpoints)) return null;
    return parsed.checkpoints.filter(
      (c): c is CheckpointUi =>
        !!c &&
        typeof c.userBlockId === "string" &&
        typeof c.turnIndex === "number" &&
        typeof c.createdAt === "number" &&
        typeof c.partial === "boolean" &&
        (c.sha === null || typeof c.sha === "string"),
    );
  } catch {
    return null;
  }
}

/**
 * Turn-count retention plan (one session): keep the NEWEST `maxTurns`
 * entries (the index array is append-ordered, so "newest" = array tail),
 * drop the rest. `maxTurns <= 0` disables the cap. Partial placeholders
 * count toward the budget like real captures — they anchor a turn and the
 * restore dialog shows them.
 */
export function planCheckpointRetention(
  list: readonly CheckpointUi[],
  maxTurns: number,
): { kept: CheckpointUi[]; dropped: CheckpointUi[] } {
  if (!Number.isFinite(maxTurns) || maxTurns <= 0 || list.length <= maxTurns) {
    return { kept: [...list], dropped: [] };
  }
  const dropCount = list.length - Math.floor(maxTurns);
  return { kept: list.slice(dropCount), dropped: list.slice(0, dropCount) };
}
