import { describe, it, expect } from "vitest";
import {
  appendHostNotice,
  applySessionUpdate,
  backfillBlockIds,
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
  parseTranscriptJsonl,
  toAgentPromptText,
} from "../shared/session-state";
import { initialSessionState, type Block, type SessionState } from "../shared/messages";
import type { SessionNotification } from "../src/acp/protocol";

function notify(update: SessionNotification["update"], sessionId = "s1"): SessionNotification {
  return { sessionId, update };
}

describe("SubAgent grouping (agentId)", () => {
  it("groups flat nested activity by the task interval (live wire shape, no agentId)", () => {
    const state: SessionState = initialSessionState();
    // Live 0.5.19 wire timeline (captured via ACP probe): task opens the
    // interval, nested read_file + "Agent started" text are flat top-level
    // updates, the task completed update closes it.
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "call_task", toolName: "task", title: "Launch agent(general-purpose): 读取 package.json 的 name", kind: "other", status: "pending" }));
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call_update", toolCallId: "call_task", toolName: "task", title: "Launch agent(general-purpose): 读取 package.json 的 name", kind: "other", status: "in_progress" }));
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n>️ general-purpose Agent started\n" } }));
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "call_read", toolName: "read_file", title: "Reading package.json", kind: "read", status: "pending" }));
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call_update", toolCallId: "call_read", toolName: "read_file", title: "Reading package.json", kind: "read", status: "completed" }));
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call_update", toolCallId: "call_task", toolName: "task", kind: "other", status: "completed" }));
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "子代理已调用 read_file" } }));

    // Exactly one top-level subagent card + one post-interval text block.
    expect(state.blocks.map((b) => b.kind)).toEqual(["subagent", "text"]);
    const sub = state.blocks[0]!;
    if (sub.kind !== "subagent") throw new Error("expected subagent");
    expect(sub.taskToolCallId).toBe("call_task");
    expect(sub.status).toBe("completed");
    // task 自身的 call/update 也在区间内 → entries: [task(tool), text, read_file(tool)]。
    // task 的 tool_call 与 tool_call_update 按 toolCallId 合并为一个 entry。
    expect(sub.entries.map((e) => e.kind)).toEqual(["tool", "text", "tool"]);
    expect(sub.entries[0]).toMatchObject({ kind: "tool", toolName: "task" });
    expect(sub.entries[1]).toMatchObject({ kind: "text" });
    expect(sub.entries[2]).toMatchObject({ kind: "tool", toolName: "read_file", status: "completed" });
  });

  it("reads agentId from update._meta as a fallback", () => {
    const state: SessionState = initialSessionState();
    applySessionUpdate(
      state,
      notify({
        sessionUpdate: "tool_call",
        toolCallId: "n1",
        toolName: "read_file",
        title: "读取",
        kind: "read",
        status: "completed",
        _meta: { agentId: "meta-agent" },
      } as SessionNotification["update"]),
    );
    expect(state.blocks).toHaveLength(1);
    const sub = state.blocks[0]!;
    if (sub.kind !== "subagent") throw new Error("expected subagent");
    expect(sub.agentId).toBe("meta-agent");
    expect(sub.entries).toHaveLength(1);
  });

  it("groups sidechain JSONL lines into a SubAgent block on restore", () => {
    const jsonl = [
      JSON.stringify({ type: "user", message: { content: "修复限流器" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tk1", name: "task", input: { description: "测试编写" } }] } }),
      JSON.stringify({ type: "user", isSidechain: true, message: { content: "为限流器写测试" } }),
      JSON.stringify({ type: "assistant", isSidechain: true, message: { content: [{ type: "tool_use", id: "s1", name: "write_file", input: { description: "写用例" } }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "已完成" }] } }),
    ].join("\n");
    const { blocks } = parseTranscriptJsonl(jsonl);
    expect(blocks.map((b) => b.kind)).toEqual(["user", "subagent", "text"]);
    const sub = blocks[1]!;
    if (sub.kind !== "subagent") throw new Error("expected subagent");
    expect(sub.title).toBe("测试编写");
    expect(sub.status).toBe("completed");
    expect(sub.entries).toHaveLength(2);
    expect(sub.entries[0]).toMatchObject({ kind: "text", text: "为限流器写测试" });
    expect(sub.entries[1]).toMatchObject({ kind: "tool", toolName: "write_file", title: "写用例" });
  });
});

describe("compression history-item leak (slash /compress, CLI 0.5.19)", () => {
  const blob = (pending: boolean) =>
    JSON.stringify({
      type: "compression",
      compression: pending
        ? { isPending: true, originalTokenCount: null, newTokenCount: null }
        : { isPending: false, originalTokenCount: 98134, newTokenCount: 7855, summary: "\nThis session is being continued from a previous conversation.\n" },
    });

  it("emits a standalone compression card and keeps the summary", () => {
    const state: SessionState = initialSessionState();
    // Live shape: the localized "正在压缩…" info line is its own chunk; the
    // compression item (no `text` field on the wire) follows JSON.stringify'd.
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "正在压缩..." } }));
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: blob(false) } }));
    expect(state.blocks.map((b) => b.kind)).toEqual(["text", "compression"]);
    const card = state.blocks[1]!;
    if (card.kind !== "compression") throw new Error("expected compression");
    expect(card.notice).toBe("上下文已压缩：98134 → 7855 tokens");
    expect(card.summary).toBe("This session is being continued from a previous conversation.");
  });

  it("collapses the pending compression item to a notice-only card", () => {
    const state: SessionState = initialSessionState();
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: blob(true) } }));
    expect(state.blocks.map((b) => b.kind)).toEqual(["compression"]);
    const card = state.blocks[0]!;
    if (card.kind !== "compression") throw new Error("expected compression");
    expect(card.notice).toBe("正在压缩上下文…");
    expect(card.summary).toBeNull();
  });

  it("leaves torn JSON and unrelated objects verbatim", () => {
    const state: SessionState = initialSessionState();
    const torn = '{"type":"compression","compression":{"isPending":f';
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: torn } }));
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: '{"type":"other","compression":{"a":1}}' } }));
    expect(state.blocks.map((b) => b.kind)).toEqual(["text"]);
    const text = state.blocks[0]!;
    if (text.kind !== "text") throw new Error("expected text");
    expect(text.text).toBe(torn + '{"type":"other","compression":{"a":1}}');
  });

  it("restores /compress history as a compression card without stealing the session label", () => {
    const jsonl = [
      JSON.stringify({ type: "user", message: { content: "修复限流器" } }),
      JSON.stringify({ type: "user", isCompactSummary: true, compressionInfo: { originalTokenCount: 98134, newTokenCount: 7855, summary: "Continued summary." }, message: { content: "Continued summary." } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "继续" }] } }),
    ].join("\n");
    const { blocks, firstUserText } = parseTranscriptJsonl(jsonl);
    expect(blocks.map((b) => b.kind)).toEqual(["user", "compression", "text"]);
    const card = blocks[1]!;
    if (card.kind !== "compression") throw new Error("expected compression");
    expect(card.notice).toBe("上下文已压缩：98134 → 7855 tokens");
    expect(card.summary).toBe("Continued summary.");
    expect(firstUserText).toBe("修复限流器");
  });
});

describe("stable block ids (P4)", () => {
  it("assigns unique non-empty ids to every live block", () => {
    const state: SessionState = initialSessionState();
    beginUserPrompt(state, "问题");
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "回答" } }));
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "t1", toolName: "read_file", title: "读", kind: "read", status: "pending" }));
    applySessionUpdate(state, notify({ sessionUpdate: "plan", entries: [{ content: "步骤" }] }));
    const ids = state.blocks.map((b) => b.id);
    expect(ids).toHaveLength(state.blocks.length);
    for (const id of ids) expect(id).toBeTruthy();
    expect(new Set(ids).size).toBe(ids.length); // all distinct
  });

  it("keeps the same id across tool_call_update upserts and reverts", () => {
    const state: SessionState = initialSessionState();
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "t1", toolName: "edit_file", title: "改", kind: "edit", status: "pending" }));
    const before = state.blocks[0]!;
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call_update", toolCallId: "t1", toolName: "edit_file", title: "改", kind: "edit", status: "completed" }));
    const after = state.blocks[0]!;
    // Upsert replaces the block object in place — the id must survive so the
    // React key (and memo anchor) stays stable across updates.
    expect(after.id).toBeTruthy();
    expect(after.id).toBe(before.id);
    markToolReverted(state, "t1");
    expect(state.blocks[0]!.id).toBe(before.id);
  });

  it("backfillBlockIds fills missing ids and keeps existing ones (recursing into subagents)", () => {
    const blocks: Block[] = [
      { kind: "text", text: "无 id 的旧块" },
      { kind: "tool", toolCallId: "t1", toolName: "x", title: "", toolKind: "read", status: "completed", output: "", locations: [], diff: null, id: "keep-me" },
      { kind: "subagent", agentId: "a", taskToolCallId: null, title: "子", status: "completed", agentType: null, entries: [{ kind: "text", text: "嵌套旧块" }] },
    ];
    backfillBlockIds(blocks);
    expect(blocks[0]!.id).toBeTruthy();
    expect(blocks[1]!.id).toBe("keep-me");
    const sub = blocks[2]!;
    if (sub.kind !== "subagent") throw new Error("expected subagent");
    expect(sub.id).toBeTruthy();
    expect(sub.entries[0]!.id).toBeTruthy();
  });

  it("parseTranscriptJsonl output carries ids", () => {
    const jsonl = [
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }),
    ].join("\n");
    const { blocks } = parseTranscriptJsonl(jsonl);
    expect(blocks.map((b) => b.id)).toEqual([expect.any(String), expect.any(String)]);
    expect(blocks[0]!.id).not.toBe(blocks[1]!.id);
  });
});

describe("applySessionUpdate", () => {
  it("groups a task tool_call + nested agentId updates into one subagent block", () => {
    const state: SessionState = initialSessionState();
    // Spawning task tool_call arrives WITHOUT an agentId.
    applySessionUpdate(
      state,
      notify({ sessionUpdate: "tool_call", toolCallId: "task-1", toolName: "task", title: "测试编写", kind: "other", status: "in_progress" }),
    );
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({ kind: "subagent", taskToolCallId: "task-1", title: "测试编写", status: "in_progress", agentId: "task-1" });
    // Nested updates carry the real agentId and must land inside the card.
    applySessionUpdate(
      state,
      { sessionId: "s1", agentId: "agent-9", update: { sessionUpdate: "tool_call", toolCallId: "n1", toolName: "read_file", title: "读取文件", kind: "read", status: "completed" } },
    );
    applySessionUpdate(
      state,
      { sessionId: "s1", agentId: "agent-9", update: { sessionUpdate: "tool_call", toolCallId: "n2", toolName: "write_file", title: "写测试", kind: "edit", status: "in_progress" } },
    );
    expect(state.blocks).toHaveLength(1); // no top-level leakage
    const sub = state.blocks[0]!;
    if (sub.kind !== "subagent") throw new Error("expected subagent");
    expect(sub.agentId).toBe("agent-9"); // rebound from toolCallId key
    expect(sub.entries).toHaveLength(2);
    expect(sub.entries[0]).toMatchObject({ kind: "tool", toolName: "read_file", status: "completed" });
  });

  it("marks the subagent completed when the spawning tool_call completes", () => {
    const state: SessionState = initialSessionState();
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "task-2", toolName: "task", title: "重构", kind: "other", status: "in_progress" }));
    applySessionUpdate(
      state,
      { sessionId: "s1", agentId: "agent-a", update: { sessionUpdate: "tool_call", toolCallId: "task-2", toolName: "task", kind: "other", status: "completed" } },
    );
    const sub = state.blocks[0]!;
    if (sub.kind !== "subagent") throw new Error("expected subagent");
    expect(sub.status).toBe("completed");
  });

  it("keeps the interval open after a nested tool failure (flat strategy)", () => {
    const state: SessionState = initialSessionState();
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "call_task", toolName: "task", title: "Launch agent(x): 修复", kind: "other", status: "in_progress" }));
    // Nested tool fails...
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "call_bad", toolName: "run_command", title: "Running cmd", kind: "execute", status: "in_progress" }));
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call_update", toolCallId: "call_bad", toolName: "run_command", kind: "execute", status: "failed" }));
    // ...but the subagent keeps running: later events must stay inside the card.
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "call_retry", toolName: "run_command", title: "Retrying", kind: "execute", status: "in_progress" }));
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "重试中" } }));
    expect(state.blocks).toHaveLength(1);
    const sub = state.blocks[0]!;
    if (sub.kind !== "subagent") throw new Error("expected subagent");
    expect(sub.status).toBe("in_progress"); // not "failed" — the subagent may recover
    expect(sub.entries.map((e) => e.kind)).toEqual(["tool", "tool", "text"]);
    // Spawning task call closes the interval normally — no duplicate card.
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call_update", toolCallId: "call_task", toolName: "task", kind: "other", status: "completed" }));
    expect(state.blocks).toHaveLength(1);
    if (sub.kind !== "subagent") throw new Error("expected subagent");
    expect(sub.status).toBe("completed");
  });

  it("keeps the card in_progress after a nested tool failure (agentId strategy)", () => {
    const state: SessionState = initialSessionState();
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "task-3", toolName: "task", title: "测试", kind: "other", status: "in_progress" }));
    applySessionUpdate(state, { sessionId: "s1", agentId: "agent-b", update: { sessionUpdate: "tool_call", toolCallId: "n3", toolName: "edit_file", title: "改", kind: "edit", status: "failed" } });
    const sub = state.blocks[0]!;
    if (sub.kind !== "subagent") throw new Error("expected subagent");
    expect(sub.status).toBe("in_progress");
  });

  it("synthesizes a subagent card for agentId events without a task tool_call", () => {
    const state: SessionState = initialSessionState();
    applySessionUpdate(
      state,
      { sessionId: "s1", agentId: "agent-x", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "子任务进行中" } } },
    );
    expect(state.blocks).toHaveLength(1);
    const sub = state.blocks[0]!;
    if (sub.kind !== "subagent") throw new Error("expected subagent");
    expect(sub.agentId).toBe("agent-x");
    expect(sub.entries).toHaveLength(1);
    expect(sub.entries[0]).toMatchObject({ kind: "text", text: "子任务进行中" });
  });

  it("keeps top-level tool blocks unaffected when no agentId is present", () => {
    const state: SessionState = initialSessionState();
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "t1", toolName: "read_file", title: "x", kind: "read", status: "completed" }));
    expect(state.blocks[0]).toMatchObject({ kind: "tool", toolCallId: "t1" });
  });
});

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

  it("appendHostNotice adds an agent-styled text block without touching status", () => {
    const state = initialSessionState();
    beginUserPrompt(state, "长任务");
    completePrompt(state, "end_turn");
    appendHostNotice(state, "上下文长度已达模型上限，自动压缩会话后重试…");
    expect(state.blocks.at(-1)).toMatchObject({
      kind: "text",
      text: "上下文长度已达模型上限，自动压缩会话后重试…",
    });
    expect(state.blocks.at(-1)?.id).toBeDefined();
    expect(state.status).toBe("idle");
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
  it("marks the matching tool block as reverted without faking a failure (C4)", () => {
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
    // C4: the tool SUCCEEDED — its change was undone. `reverted` is the
    // marker; `status` stays "completed" so it never reads as a failure in
    // SubAgent cards (whose terminal status is driven only by the spawning
    // task call).
    expect(tool.kind === "tool" && tool.status).toBe("completed");
    expect(tool.kind === "tool" && tool.reverted).toBe(true);
    expect(tool.kind === "tool" && tool.output).toContain("已回退");
  });

  it("clears the reverted marker when a new diff arrives for the same tool", () => {
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
    applySessionUpdate(
      state,
      notify({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        toolName: "edit_file",
        kind: "edit",
        status: "completed",
        content: [{ type: "diff", path: "a.ts", oldText: "new", newText: "newer" }],
      }),
    );
    const tool = state.blocks[0]!;
    expect(tool.kind === "tool" && tool.reverted).toBe(false);
    expect(tool.kind === "tool" && tool.diff?.newText).toBe("newer");
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

  it("ignores user_message_chunk live even when the transcript is empty", () => {
    // An echo reaching an empty transcript is stale content from an abandoned
    // turn (新会话 cleared mid-flight) — never the user's real message.
    const state = initialSessionState();
    applySessionUpdate(
      state,
      notify({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "首条" } }),
    );
    expect(state.blocks).toHaveLength(0);
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

describe("toAgentPromptText (CLI slash-command disambiguation)", () => {
  const commands = [
    { name: "init" },
    { name: "help" },
    { name: "commit", _meta: { altName: ["coc"] } },
  ];

  it("passes plain text through verbatim", () => {
    expect(toAgentPromptText("hello world", commands)).toBe("hello world");
    expect(toAgentPromptText("  spaced  ", commands)).toBe("  spaced  ");
  });

  it("passes known commands through verbatim (name, altName, with args)", () => {
    expect(toAgentPromptText("/init", commands)).toBe("/init");
    expect(toAgentPromptText("/init foo", commands)).toBe("/init foo");
    expect(toAgentPromptText("/coc", commands)).toBe("/coc");
    expect(toAgentPromptText("  /init", commands)).toBe("  /init");
  });

  it("escapes unknown /-leading text with U+200B", () => {
    expect(toAgentPromptText("/foo", commands)).toBe("\u200B/foo");
    expect(toAgentPromptText("/foo bar", commands)).toBe("\u200B/foo bar");
    expect(toAgentPromptText(" /unknown", commands)).toBe("\u200B/unknown");
  });

  it("exempts path-like invocations (CLI T8u mirror)", () => {
    expect(toAgentPromptText("/usr/bin/node -v", commands)).toBe("/usr/bin/node -v");
    expect(toAgentPromptText("/Users/outlo/report.md", commands)).toBe("/Users/outlo/report.md");
    expect(toAgentPromptText("C:/tools/run.exe", commands)).toBe("C:/tools/run.exe");
    expect(toAgentPromptText("c:/tools/run.exe", commands)).toBe("c:/tools/run.exe");
    expect(toAgentPromptText("./scripts/build.sh", commands)).toBe("./scripts/build.sh");
    expect(toAgentPromptText("../parent/dir", commands)).toBe("../parent/dir");
    expect(toAgentPromptText("~/notes/todo.txt", commands)).toBe("~/notes/todo.txt");
    expect(toAgentPromptText("\\\\server\\share\\file", commands)).toBe("\\\\server\\share\\file");
    expect(toAgentPromptText("/Program Files x/app", commands)).toBe("/Program Files x/app");
  });

  it("still escapes slash text that is neither command nor path", () => {
    // ".md" is not a separator-led token: /notes.md is a command attempt for
    // the CLI (no separator after the first token), so it must be escaped.
    expect(toAgentPromptText("/notes.md", commands)).toBe("\u200B/notes.md");
    expect(toAgentPromptText("/初始化 项目", commands)).toBe("\u200B/初始化 项目");
  });

  it("passes everything through when the command list is empty", () => {
    expect(toAgentPromptText("/anything", [])).toBe("/anything");
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
