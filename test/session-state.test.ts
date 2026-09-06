import { describe, it, expect } from "vitest";
import {
  applySessionUpdate,
  beginUserPrompt,
  completePrompt,
  newSessionState,
  extractTextOutput,
  extractDiff,
  setPendingApproval,
  clearPendingApproval,
  markToolReverted,
  setSessions,
  beginReplay,
  endReplay,
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

  it("newSessionState preserves connection status (no connecting flash)", () => {
    const state = initialSessionState();
    state.status = "idle"; // connected, then user clicks 新会话
    const fresh = newSessionState(state);
    expect(fresh.status).toBe("idle");
    expect(fresh.pendingApproval).toBeNull();
  });

  it("newSessionState preserves auth state incl. profile list", () => {
    const state = initialSessionState();
    state.auth = {
      authenticated: true,
      needsSetup: false,
      saved: { baseUrl: "https://x", modelName: "m", keyTail: "…1234" },
      profiles: [{ name: "BUZZ", source: "cli", baseUrl: "https://x", modelName: "m", keyTail: "…1234", active: true }],
    };
    const fresh = newSessionState(state);
    expect(fresh.auth).toEqual(state.auth);
  });
});

describe("tool diffs (M2)", () => {
  it("attaches a structured diff from tool_call_update content", () => {
    const state = initialSessionState();
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "t1", toolName: "edit_file", kind: "edit", status: "pending" }));
    applySessionUpdate(
      state,
      notify({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [
          { type: "diff", path: "src/a.ts", oldText: "const a = 1;", newText: "const a = 2;" },
        ],
      }),
    );
    const tool = state.blocks[0]!;
    expect(tool.kind).toBe("tool");
    expect(tool.kind === "tool" && tool.diff).toEqual({ path: "src/a.ts", oldText: "const a = 1;", newText: "const a = 2;" });
  });

  it("keeps the previous diff when a later update carries none", () => {
    const state = initialSessionState();
    applySessionUpdate(
      state,
      notify({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        toolName: "edit_file",
        kind: "edit",
        status: "pending",
        content: [{ type: "diff", path: "src/a.ts", oldText: "old", newText: "new" }],
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
    const tool = state.blocks[0]!;
    expect(tool.kind === "tool" && tool.diff).toMatchObject({ path: "src/a.ts" });
  });

  it("extractDiff ignores malformed items and non-arrays", () => {
    expect(extractDiff(null)).toBeNull();
    expect(extractDiff([{ type: "content", content: { type: "text", text: "x" } }])).toBeNull();
    expect(extractDiff([{ type: "diff", oldText: "a", newText: "b" }])).toBeNull();
    expect(extractDiff([{ type: "diff", path: "p", oldText: null, newText: "new file" }])).toEqual({
      path: "p",
      oldText: null,
      newText: "new file",
    });
  });
});

describe("approval flow (M2)", () => {
  it("initial state has no pending approval", () => {
    expect(initialSessionState().pendingApproval).toBeNull();
  });

  it("set/clear pending approval round-trips", () => {
    const state = initialSessionState();
    setPendingApproval(state, {
      id: "ap-1",
      toolName: "write_file",
      title: "Write x",
      toolKind: "edit",
      locations: [],
      options: [{ optionId: "o1", name: "Allow", kind: "allow_once" }],
    });
    expect(state.pendingApproval?.id).toBe("ap-1");
    expect(clearPendingApproval(state, "wrong-id")).toBe(false);
    expect(state.pendingApproval?.id).toBe("ap-1");
    expect(clearPendingApproval(state, "ap-1")).toBe(true);
    expect(state.pendingApproval).toBeNull();
  });

  it("newSessionState starts with no pending approval", () => {
    const state = initialSessionState();
    setPendingApproval(state, {
      id: "ap-1",
      toolName: "x",
      title: null as unknown as string,
      toolKind: "edit",
      locations: [],
      options: [],
    });
    expect(newSessionState(state).pendingApproval).toBeNull();
  });
});

describe("markToolReverted (M2)", () => {
  it("marks the matching tool block as reverted", () => {
    const state = initialSessionState();
    applySessionUpdate(
      state,
      notify({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        toolName: "edit_file",
        kind: "edit",
        status: "completed",
        content: [{ type: "diff", path: "a.ts", oldText: "old", newText: "new" }],
      }),
    );
    expect(markToolReverted(state, "t1")).toBe(true);
    const tool = state.blocks[0]!;
    expect(tool.kind === "tool" && tool.status).toBe("failed");
    expect(tool.kind === "tool" && tool.output).toContain("已回退");
  });

  it("returns false for unknown toolCallId", () => {
    const state = initialSessionState();
    expect(markToolReverted(state, "nope")).toBe(false);
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

describe("session replay (M4)", () => {
  it("renders user_message_chunk as a user block while replaying", () => {
    const state = initialSessionState();
    applySessionUpdate(
      state,
      notify({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "历史提问" } }),
      { replaying: true },
    );
    applySessionUpdate(
      state,
      notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "历史回答" } }),
      { replaying: true },
    );
    expect(state.blocks.map((b) => b.kind)).toEqual(["user", "text"]);
    expect(state.blocks[0]).toMatchObject({ kind: "user", text: "历史提问" });
  });

  it("ignores user_message_chunk in live mode once the transcript has content", () => {
    const state = initialSessionState();
    beginUserPrompt(state, "真实提问");
    applySessionUpdate(
      state,
      notify({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "agent 回显" } }),
    );
    expect(state.blocks.filter((b) => b.kind === "user")).toHaveLength(1);
  });

  it("still renders user_message_chunk live when the transcript is empty", () => {
    const state = initialSessionState();
    applySessionUpdate(
      state,
      notify({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "首条" } }),
    );
    expect(state.blocks[0]).toMatchObject({ kind: "user", text: "首条" });
  });

  it("beginReplay clears the transcript and endReplay returns to idle", () => {
    const state = initialSessionState();
    beginUserPrompt(state, "旧内容");
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "旧回答" } }));
    beginReplay(state);
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({ kind: "text" });
    expect((state.blocks[0] as { text: string }).text).toContain("正在恢复会话历史");
    expect(state.replaying).toBe(true);
    expect(state.status).toBe("streaming");
    expect(state.pendingApproval).toBeNull();
    applySessionUpdate(
      state,
      notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "新内容" } }),
      { replaying: true },
    );
    endReplay(state);
    expect(state.replaying).toBe(false);
    expect(state.status).toBe("idle");
    expect(state.blocks).toHaveLength(1);
  });
});

describe("session switcher (M4)", () => {
  it("setSessions replaces the list", () => {
    const state = initialSessionState();
    setSessions(state, [{ id: "s1", label: "会话一", updatedAt: 1 }]);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]!.label).toBe("会话一");
  });

  it("newSessionState preserves workspace-scoped session list and flags", () => {
    const state = initialSessionState();
    setSessions(state, [{ id: "s1", label: "会话一", updatedAt: 1 }]);
    state.activeSessionId = "s1";
    state.replaying = true;
    const fresh = newSessionState(state);
    expect(fresh.sessions).toHaveLength(1);
    expect(fresh.activeSessionId).toBe("s1");
    expect(fresh.replaying).toBe(true);
    // Session-scoped state still resets.
    expect(fresh.blocks).toHaveLength(0);
    expect(fresh.sessionId).toBeNull();
  });
});
