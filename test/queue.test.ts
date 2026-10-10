import { describe, it, expect } from "vitest";
import {
  QUEUE_MAX,
  enqueuePrompt,
  removeQueued,
  moveQueued,
  peekQueued,
  shiftQueued,
  clearQueue,
} from "../shared/queue.js";
import type { QueuedPromptUi } from "../shared/messages.js";

function entry(id: string, text = `text-${id}`): QueuedPromptUi {
  return { id, text, attachments: [], enqueuedAt: 0 };
}

/**
 * M2 P0-3 queue reducers — pure logic pinned here; the host wiring
 * (enqueue on streaming sendPrompt, dispatch on settle, error-pause,
 * lifecycle clears) lives in panel-queue.test.ts.
 */
describe("queue reducers (P0-3)", () => {
  it("enqueue appends and respects QUEUE_MAX", () => {
    let queue: QueuedPromptUi[] = [];
    for (let i = 0; i < QUEUE_MAX; i++) {
      const r = enqueuePrompt(queue, entry(`q${i}`));
      expect(r.ok).toBe(true);
      queue = r.queue;
    }
    expect(queue).toHaveLength(QUEUE_MAX);
    const overflow = enqueuePrompt(queue, entry("overflow"));
    expect(overflow.ok).toBe(false);
    expect(overflow.queue).toHaveLength(QUEUE_MAX);
    expect(overflow.queue.some((q) => q.id === "overflow")).toBe(false);
  });

  it("reducers are immutable (input array untouched)", () => {
    const original = [entry("a"), entry("b"), entry("c")];
    const snapshot = [...original];
    enqueuePrompt(original, entry("d"));
    removeQueued(original, "b");
    moveQueued(original, "c", -1);
    shiftQueued(original);
    expect(original).toEqual(snapshot);
  });

  it("removeQueued drops the id; unknown id is a content-equal no-op", () => {
    const q = [entry("a"), entry("b")];
    expect(removeQueued(q, "a").map((x) => x.id)).toEqual(["b"]);
    const untouched = removeQueued(q, "zzz");
    expect(untouched.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("moveQueued swaps neighbours and clamps at both ends", () => {
    const q = [entry("a"), entry("b"), entry("c")];
    expect(moveQueued(q, "c", -1).map((x) => x.id)).toEqual(["a", "c", "b"]);
    expect(moveQueued(q, "a", -1).map((x) => x.id)).toEqual(["a", "b", "c"]); // clamp head
    expect(moveQueued(q, "c", 5).map((x) => x.id)).toEqual(["a", "b", "c"]); // clamp tail
    expect(moveQueued(q, "zzz", -1).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("peek/shift walk the FIFO head", () => {
    const q = [entry("a"), entry("b")];
    expect(peekQueued(q)?.id).toBe("a");
    const shifted = shiftQueued(q);
    expect(shifted.head?.id).toBe("a");
    expect(shifted.queue.map((x) => x.id)).toEqual(["b"]);
    const empty = shiftQueued([]);
    expect(empty.head).toBeNull();
    expect(empty.queue).toEqual([]);
    expect(peekQueued([])).toBeNull();
  });

  it("clearQueue empties", () => {
    expect(clearQueue()).toEqual([]);
  });
});
