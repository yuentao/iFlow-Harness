/**
 * P-1 incremental snapshot tests: the host store pushes either a full
 * snapshot (anchor stamp) or an incremental tail patch (`blockPatch`),
 * classified by tail fingerprints; the webview-side merge helper
 * `applyBlockPatch` is pure and shared.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { SessionStore } from "../src/panel/store.js";
import {
  applyBlockPatch,
  initialSessionState,
  type Block,
  type HostToWebview,
  type SessionState,
} from "../shared/messages.js";
import type { SessionNotification } from "../src/acp/protocol.js";

function notify(update: SessionNotification["update"], sessionId = "s1"): SessionNotification {
  return { sessionId, update };
}

/** Create a store and capture every pushed wire message. */
function makeStore(): { store: SessionStore; messages: HostToWebview[] } {
  const messages: HostToWebview[] = [];
  const store = new SessionStore({ post: (m) => messages.push(m), flushIntervalMs: 5 });
  return { store, messages };
}

function textBlock(text: string): Block {
  return { kind: "text", text };
}

function toolBlock(toolCallId: string, output: string, status = "completed"): Block {
  return {
    kind: "tool",
    toolCallId,
    toolName: "read_file",
    title: "",
    toolKind: "read",
    status,
    output,
    locations: [],
    diff: null,
  };
}

describe("SessionStore snapshot paths (P-1)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("first push is a full snapshot carrying blockVersion", () => {
    const { store, messages } = makeStore();
    store.markConnected();
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.type).toBe("snapshot");
    if (msg.type !== "snapshot") throw new Error("unreachable");
    expect(msg.state.blockVersion).toBe(1);
    expect(msg.state.status).toBe("idle");
  });

  it("tail text growth streams as blockPatch on top of the last anchor", () => {
    const { store, messages } = makeStore();
    store.markConnected(); // full anchor, blockVersion 1
    store.userPrompt("问题"); // real timeline: user turn flips status to streaming
    store.onSessionUpdate(notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好" } }));
    store.pushSnapshot(); // flush the scheduled one
    store.onSessionUpdate(notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "，世界" } }));
    store.pushSnapshot();

    // First flush after userPrompt: append patch carries [user, text-start].
    expect(messages[1]?.type).toBe("blockPatch");
    // Second chunk appends to the same tail text block → replacement patch.
    const patch = messages[3];
    expect(patch?.type).toBe("blockPatch");
    if (patch?.type !== "blockPatch") throw new Error("unreachable");
    // Anchor: the previous push (the second patch) — patches chain.
    expect(patch.baseVersion).toBe(3);
    expect(patch.tailStart).toBe(1);
    expect(patch.blocks).toEqual([{ ...textBlock("你好，世界"), id: expect.any(String) }]);
    expect(patch.tail.status).toBe("streaming");
    // Patch carries no blocks field pollution: tail is metadata only.
    expect("blocks" in patch.tail).toBe(false);
  });

  it("coalesced append: tail range covers the old tail plus new blocks", () => {
    const { store, messages } = makeStore();
    store.markConnected();
    store.onSessionUpdate(notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "第一段" } }));
    store.pushSnapshot(); // anchor: len 1, tail = text
    // One flush window appends a new text block (chunk after a completed tool).
    store.onSessionUpdate(notify({ sessionUpdate: "tool_call", toolCallId: "t1", toolName: "ls", title: "", kind: "read", status: "pending" }));
    store.onSessionUpdate(notify({ sessionUpdate: "tool_call_update", toolCallId: "t1", toolName: "ls", title: "", kind: "read", status: "completed", content: [{ type: "content", content: { type: "text", text: "out" } }] }));
    store.pushSnapshot();

    const patch = messages[2];
    expect(patch?.type).toBe("blockPatch");
    if (patch?.type !== "blockPatch") throw new Error("unreachable");
    expect(patch.tailStart).toBe(0);
    expect(patch.blocks.map((b) => b.kind)).toEqual(["text", "tool"]);
  });

  it("metadata-only change pushes a patch with an empty block range", () => {
    const { store, messages } = makeStore();
    store.markConnected();
    store.sessionStarted({ sessionId: "s9" }); // no block mutation
    const patch = messages[1];
    expect(patch?.type).toBe("blockPatch");
    if (patch?.type !== "blockPatch") throw new Error("unreachable");
    expect(patch.blocks).toEqual([]);
    expect(patch.tail.sessionId).toBe("s9");
  });

  it("ambiguous same-fingerprint mutation falls back to a full snapshot", () => {
    const { store, messages } = makeStore();
    store.markConnected();
    store.userPrompt("问题");
    store.pushSnapshot();
    // Two tool blocks, then revert the NON-tail one: len and tail fp unchanged.
    const state = store.getState();
    state.blocks.push(toolBlock("t1", "旧输出"));
    state.blocks.push(toolBlock("t2", "输出"));
    const ok = store.toolReverted("t1"); // mid-list: invisible to tail fp
    expect(ok).toBe(true);
    const msg = messages[3];
    expect(msg?.type).toBe("snapshot"); // conservative full push
  });

  it("tail tool mutation stays on the patch path", () => {
    const { store, messages } = makeStore();
    store.markConnected();
    store.userPrompt("问题");
    store.getState().blocks.push(toolBlock("t1", "部分"));
    store.toolReverted("t1"); // tail block, fp changes
    store.pushSnapshot();
    const patch = messages[2];
    expect(patch?.type).toBe("blockPatch");
    if (patch?.type !== "blockPatch") throw new Error("unreachable");
    expect(patch.blocks).toHaveLength(2);
    const tail = patch.blocks[1]!;
    expect(tail.kind === "tool" && tail.output).toContain("已回退");
  });

  it("replaceState swaps the anchor: next flush is a full snapshot", () => {
    const { store, messages } = makeStore();
    store.markConnected();
    store.onSessionUpdate(notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } }));
    store.pushSnapshot(); // patch
    const fresh = initialSessionState();
    fresh.status = "idle";
    store.replaceState(fresh); // identity swap → full
    expect(messages[2]?.type).toBe("snapshot");
    // And the new transcript patches from the fresh anchor.
    store.onSessionUpdate(notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "新会话" } }));
    store.pushSnapshot();
    const patch = messages[3];
    expect(patch?.type).toBe("blockPatch");
    if (patch?.type !== "blockPatch") throw new Error("unreachable");
    expect(patch.tailStart).toBe(0);
    expect(patch.blocks).toEqual([{ ...textBlock("新会话"), id: expect.any(String) }]);
  });

  it("resync() forces the next push to be a full snapshot", () => {
    const { store, messages } = makeStore();
    store.markConnected();
    store.resync();
    store.onSessionUpdate(notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } }));
    store.pushSnapshot();
    expect(messages[1]?.type).toBe("snapshot");
  });

  it("first push after construction is full even for tail-only mutations (webview not yet synced)", () => {
    const { store, messages } = makeStore();
    store.onSessionUpdate(notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "early" } }));
    store.pushSnapshot();
    expect(messages[0]?.type).toBe("snapshot");
  });

  it("flush timer is drained by pushSnapshot (no duplicate pushes)", () => {
    vi.useFakeTimers();
    const { store, messages } = makeStore();
    store.markConnected();
    store.onSessionUpdate(notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "chunk" } }));
    store.pushSnapshot();
    vi.advanceTimersByTime(100);
    expect(messages).toHaveLength(2); // markConnected + one flush
  });
});

describe("applyBlockPatch (webview merge)", () => {
  function anchoredState(version: number, blocks: Block[]): SessionState {
    const state = initialSessionState();
    state.blockVersion = version;
    state.blocks = blocks;
    return state;
  }

  it("merges the tail range onto the anchored transcript", () => {
    const current = anchoredState(3, [textBlock("历史"), toolBlock("t1", "out")]);
    const merged = applyBlockPatch(current, {
      baseVersion: 3,
      tailStart: 1,
      blocks: [toolBlock("t1", "out（更新）")],
    });
    expect(merged).toEqual([textBlock("历史"), toolBlock("t1", "out（更新）")]);
  });

  it("appends when the tail range extends past the current length", () => {
    const current = anchoredState(3, [textBlock("历史")]);
    const merged = applyBlockPatch(current, {
      baseVersion: 3,
      tailStart: 0,
      blocks: [textBlock("历史"), textBlock("新块")],
    });
    expect(merged).toEqual([textBlock("历史"), textBlock("新块")]);
  });

  it("keeps the transcript for a metadata-only patch (empty blocks)", () => {
    const blocks = [textBlock("保持")];
    const current = anchoredState(4, blocks);
    const merged = applyBlockPatch(current, { baseVersion: 4, tailStart: 0, blocks: [] });
    expect(merged).toBe(blocks);
  });

  it("returns null on version mismatch (lost patch) — caller must re-sync", () => {
    const current = anchoredState(2, [textBlock("旧锚点")]);
    expect(applyBlockPatch(current, { baseVersion: 3, tailStart: 0, blocks: [textBlock("x")] })).toBeNull();
  });

  it("returns null without an anchored state", () => {
    expect(applyBlockPatch(null, { baseVersion: 1, tailStart: 0, blocks: [textBlock("x")] })).toBeNull();
  });

  it("returns null on out-of-bounds tailStart", () => {
    const current = anchoredState(1, [textBlock("a")]);
    expect(applyBlockPatch(current, { baseVersion: 1, tailStart: 5, blocks: [textBlock("x")] })).toBeNull();
    expect(applyBlockPatch(current, { baseVersion: 1, tailStart: -1, blocks: [textBlock("x")] })).toBeNull();
  });
});
