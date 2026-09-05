import { describe, it, expect } from "vitest";
import {
  applySessionUpdate,
  beginUserPrompt,
  completePrompt,
  newSessionState,
  extractTextOutput,
} from "../shared/session-state";
import { initialSessionState, type SessionState } from "../shared/messages";
import type { SessionNotification } from "../src/acp/protocol";

function notify(update: SessionNotification["update"], sessionId = "s1"): SessionNotification {
  return { sessionId, update };
}

describe("applySessionUpdate", () => {
  it("merges consecutive agent_message_chunks into one text block", () => {
    const state: SessionState = initialSessionState();
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } }));
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } }));
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({ kind: "text", text: "Hello world" });
  });

  it("starts a new text block after a thought interleaves", () => {
    const state = initialSessionState();
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "part1" } }));
    applySessionUpdate(state, notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }));
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "part2" } }));
    expect(state.blocks.map((b) => b.kind)).toEqual(["text", "thought", "text"]);
  });

  it("upserts tool blocks by toolCallId without duplicating", () => {
    const state = initialSessionState();
    applySessionUpdate(
      state,
      notify({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        toolName: "replace",
        title: "Editing a.ts",
        kind: "edit",
        status: "pending",
      }),
    );
    applySessionUpdate(
      state,
      notify({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "done" } }],
      }),
    );
    expect(state.blocks).toHaveLength(1);
    const tool = state.blocks[0]!;
    expect(tool).toMatchObject({ kind: "tool", toolCallId: "t1", status: "completed", output: "done" });
  });

  it("keeps first tool output if update has empty output", () => {
    const state = initialSessionState();
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "t1", toolName: "x", status: "pending" }));
    applySessionUpdate(
      state,
      notify({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "result" } }],
      }),
    );
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }));
    expect(state.blocks[0]).toMatchObject({ output: "result" });
  });

  it("appends plan blocks and command updates", () => {
    const state = initialSessionState();
    applySessionUpdate(state, notify({ sessionUpdate: "plan", entries: [{ content: "step", status: "in_progress" }] }));
    applySessionUpdate(
      state,
      notify({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "init" }] }),
    );
    expect(state.blocks[0]).toMatchObject({ kind: "plan" });
    expect(state.commands).toEqual([{ name: "init" }]);
  });

  it("updates current mode through modes object", () => {
    const state = initialSessionState();
    state.modes = { currentModeId: "default", availableModes: [{ id: "yolo", name: "YOLO" }] };
    applySessionUpdate(state, notify({ sessionUpdate: "current_mode_update", currentModeId: "yolo" }));
    expect(state.modes?.currentModeId).toBe("yolo");
  });
});

describe("host-level transitions", () => {
  it("user → streaming → idle lifecycle", () => {
    const state = initialSessionState();
    expect(state.status).toBe("connecting");
    beginUserPrompt(state, "hi");
    expect(state.status).toBe("streaming");
    expect(state.blocks.at(-1)).toMatchObject({ kind: "user", text: "hi" });
    completePrompt(state, "end_turn");
    expect(state.status).toBe("idle");
    expect(state.stopReason).toBe("end_turn");
  });

  it("newSessionState preserves meta but clears transcript", () => {
    const state = initialSessionState();
    state.modes = { currentModeId: "smart", availableModes: [] };
    state.models = [{ id: "m1", name: "M1" }];
    state.currentModelId = "m1";
    state.commands = [{ name: "init" }];
    beginUserPrompt(state, "old stuff");
    const fresh = newSessionState(state);
    expect(fresh.blocks).toHaveLength(0);
    expect(fresh.sessionId).toBeNull();
    expect(fresh.modes?.currentModeId).toBe("smart");
    expect(fresh.models).toEqual([{ id: "m1", name: "M1" }]);
    expect(fresh.currentModelId).toBe("m1");
    expect(fresh.commands).toEqual([{ name: "init" }]);
  });
});

describe("extractTextOutput", () => {
  it("concatenates text content items", () => {
    expect(
      extractTextOutput([{ type: "content", content: { type: "text", text: "a" } }, { type: "content", content: { type: "text", text: "b" } }]),
    ).toBe("ab");
  });

  it("ignores diff items and malformed input", () => {
    expect(extractTextOutput([{ type: "diff", path: "x" }])).toBe("");
    expect(extractTextOutput(null)).toBe("");
    expect(extractTextOutput("nope")).toBe("");
  });
});
