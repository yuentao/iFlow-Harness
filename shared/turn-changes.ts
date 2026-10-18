import { diffRows } from "./hunks.js";
import type { Block, SessionState, ToolBlock, TurnChangeUi } from "./messages.js";

/**
 * Identity used to group/undo one physical file. The wire diff path is often
 * a bare basename (pitfall #6), so prefer a tool location whose basename
 * matches it; then any location; then the raw diff path.
 */
export function turnChangeKey(block: ToolBlock): string {
  const diffPath = block.diff?.path ?? "";
  const base = diffPath.split(/[\\/]/).pop();
  const locations = block.locations ?? [];
  const matching = base
    ? locations.find((location) => location.path.split(/[\\/]/).pop() === base)
    : undefined;
  return matching?.path || locations.find((location) => location.path)?.path || diffPath;
}

/** True when the block — or any nested subagent entry — holds a diff. */
function hasRecordedDiff(block: Block): boolean {
  if (block.kind === "tool") return !!block.diff || block.hadDiff === true;
  if (block.kind === "subagent") return block.entries.some(hasRecordedDiff);
  return false;
}

/** Top-level user block ids whose turn holds at least one tool diff. */
export function turnsWithChanges(blocks: readonly Block[]): Set<string> {
  const ids = new Set<string>();
  let currentId: string | undefined;
  let changed = false;
  for (const block of blocks) {
    if (block.kind === "user") {
      if (currentId && changed) ids.add(currentId);
      currentId = block.id;
      changed = false;
    } else if (hasRecordedDiff(block)) {
      changed = true;
    }
  }
  if (currentId && changed) ids.add(currentId);
  return ids;
}

/** Line counts in the same +/- terms DiffView renders. */
function lineCounts(oldText: string | null, newText: string | null): { additions: number; deletions: number } {
  if (newText === null) {
    return { additions: 0, deletions: oldText === null ? 0 : oldText.split("\n").length };
  }
  if (oldText === null) return { additions: newText.split("\n").length, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const op of diffRows(oldText.split("\n"), newText.split("\n"))) {
    if (op.type === "add") additions++;
    else if (op.type === "del") deletions++;
  }
  return { additions, deletions };
}

interface FileGroup {
  record: TurnChangeUi;
  firstOld: string | null;
  lastNew: string | null;
  /** Consecutive diffs chain old→new, so the net change can be recomputed. */
  chained: boolean;
  allReverted: boolean;
  anyPartiallyReverted: boolean;
  summedAdditions: number;
  summedDeletions: number;
}

/** Tool blocks recorded in one turn (nested subagent edits included). */
export function collectTurnToolBlocks(blocks: readonly Block[], userBlockId: string): ToolBlock[] {
  const start = blocks.findIndex((b) => b.kind === "user" && b.id === userBlockId);
  if (start < 0) return [];
  const out: ToolBlock[] = [];
  const visit = (block: Block): void => {
    if (block.kind === "tool") out.push(block);
    else if (block.kind === "subagent") block.entries.forEach(visit);
  };
  for (let i = start + 1; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.kind === "user") break;
    visit(block);
  }
  return out;
}

/**
 * Files changed by one turn, in first-recorded order. Multiple diffs for the
 * same raw path are aggregated into one row; when their texts chain
 * (`next.oldText === previous.newText`) the counts are recomputed from the
 * first old text to the last new text, otherwise the per-record counts are
 * summed (recorded changes, not a guaranteed working-tree net diff).
 */
export function collectTurnChanges(blocks: readonly Block[], userBlockId: string): TurnChangeUi[] {
  const groups = new Map<string, FileGroup>();
  const add = (block: ToolBlock): void => {
    const diff = block.diff;
    if (!diff) return;
    const counts = lineCounts(diff.oldText, diff.newText);
    const key = turnChangeKey(block);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        record: {
          toolCallId: block.toolCallId, title: block.title, status: block.status, key, path: diff.path,
          additions: counts.additions, deletions: counts.deletions, edits: 1,
          canUndo: diff.oldText !== null,
        },
        firstOld: diff.oldText,
        lastNew: diff.newText,
        chained: true,
        allReverted: block.reverted === true,
        anyPartiallyReverted: block.partiallyReverted === true,
        summedAdditions: counts.additions,
        summedDeletions: counts.deletions,
      });
      return;
    }
    existing.record.toolCallId = block.toolCallId;
    existing.record.title = block.title;
    existing.record.status = block.status;
    existing.record.path = diff.path;
    existing.record.edits += 1;
    existing.allReverted = existing.allReverted && block.reverted === true;
    existing.anyPartiallyReverted = existing.anyPartiallyReverted || block.partiallyReverted === true;
    existing.summedAdditions += counts.additions;
    existing.summedDeletions += counts.deletions;
    if (existing.chained && existing.lastNew === diff.oldText) existing.lastNew = diff.newText;
    else existing.chained = false;
  };
  for (const block of collectTurnToolBlocks(blocks, userBlockId)) add(block);
  return Array.from(groups.values(), (group) => {
    if (group.record.edits > 1 && group.chained) {
      const counts = lineCounts(group.firstOld, group.lastNew);
      group.record.additions = counts.additions;
      group.record.deletions = counts.deletions;
    } else if (group.record.edits > 1) {
      group.record.additions = group.summedAdditions;
      group.record.deletions = group.summedDeletions;
    }
    group.record.reverted = group.allReverted;
    group.record.partiallyReverted = !group.allReverted && group.anyPartiallyReverted;
    // Multiple edits are only safely undoable as a file when they chain and
    // the identity is not still a bare basename.
    if (group.record.edits > 1 && (!group.chained || !/[\\/]/.test(group.record.key))) {
      group.record.canUndo = false;
    }
    return group.record;
  });
}

/** True when no later top-level user message exists — the turn is the latest. */
export function isLatestTurn(blocks: readonly Block[], userBlockId: string): boolean {
  const start = blocks.findIndex((b) => b.kind === "user" && b.id === userBlockId);
  if (start < 0) return false;
  return !blocks.slice(start + 1).some((b) => b.kind === "user");
}

export function canReviewTurn(state: SessionState, userBlockId: string): boolean {
  if (!state.sessionId || state.initializing || state.replaying) return false;
  const start = state.blocks.findIndex((b) => b.kind === "user" && b.id === userBlockId);
  if (start < 0) return false;
  if (state.blocks.slice(start + 1).some((b) => b.kind === "user")) return true;
  return (state.status === "idle" || state.status === "error") &&
    !state.pendingApproval && !state.pendingQuestions && !state.pendingPlanExit && !state.pendingProfileSwitch;
}