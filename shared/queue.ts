/**
 * M2 P0-3 — prompt-queue reducers (pure, unit-testable).
 *
 * The queue's truth lives in the Extension Host (architecture rule: state
 * only exists there); these helpers operate on the UI projection
 * (`QueuedPromptUi[]`) that rides the blockPatch tail channel. The full
 * payload (images/files/contexts) stays in a host-side parallel map keyed by
 * `id` — base64 images must never ride every snapshot.
 *
 * All helpers are immutable: they return a NEW array (or the same reference
 * when nothing changed, so the store's snapshot diffing stays cheap).
 */

import type { QueuedPromptUi } from "./messages.js";

/** Roadmap P0-3: a longer backlog stops being "queued steering" and starts
 * being a task board — refuse with a toast instead. */
export const QUEUE_MAX = 10;

export function enqueuePrompt(
  queue: readonly QueuedPromptUi[],
  entry: QueuedPromptUi,
  limit: number = QUEUE_MAX,
): { queue: QueuedPromptUi[]; ok: boolean } {
  if (queue.length >= limit) return { queue: [...queue], ok: false };
  return { queue: [...queue, entry], ok: true };
}

/** Drop one entry. Returns the same reference when the id is unknown (the
 * entry was already consumed / cleared — the action is a no-op). */
export function removeQueued(queue: readonly QueuedPromptUi[], id: string): QueuedPromptUi[] {
  const next = queue.filter((q) => q.id !== id);
  return next.length === queue.length ? [...queue] : next;
}

/** Swap an entry with its neighbour (`delta` = -1 earlier / +1 later).
 * Out-of-range moves clamp to the ends; unknown ids are a no-op. */
export function moveQueued(queue: readonly QueuedPromptUi[], id: string, delta: number): QueuedPromptUi[] {
  const from = queue.findIndex((q) => q.id === id);
  if (from < 0 || delta === 0) return [...queue];
  const to = Math.min(queue.length - 1, Math.max(0, from + delta));
  if (to === from) return [...queue];
  const next = [...queue];
  const [moved] = next.splice(from, 1);
  if (moved) next.splice(to, 0, moved);
  return next;
}

/** The FIFO head (the entry the next idle slot consumes), without removing it. */
export function peekQueued(queue: readonly QueuedPromptUi[]): QueuedPromptUi | null {
  return queue[0] ?? null;
}

/** Remove and return the FIFO head (the dispatch step). */
export function shiftQueued(queue: readonly QueuedPromptUi[]): { queue: QueuedPromptUi[]; head: QueuedPromptUi | null } {
  if (queue.length === 0) return { queue: [...queue], head: null };
  const [head, ...rest] = queue;
  return { queue: rest, head: head ?? null };
}

export function clearQueue(): QueuedPromptUi[] {
  return [];
}
