import { describe, it, expect, vi } from "vitest";
import {
  applySessionUpdate,
  canStopSubAgent,
  appendApprovalResolution,
  attachSynthesizedDiff,
  backfillBlockIds,
  beginUserPrompt,
  completePrompt,
  dropSessionUpdate,
  estimateSessionUsage,
  estimateTokens,
  findToolBlockById,
  isAgentOutputUpdate,
  parseEditArgs,
  parseToolFilePath,
  refreshSessionUsage,
  snapshotEditDiff,
  sortSessionSummaries,
  synthesizeEditDiff,
  newSessionState,
  nextBlockId,
  reassignBlockIds,
  extractTextOutput,
  extractDiff,
  setPendingApproval,
  clearPendingApproval,
  closeOpenSubAgents,
  markSubAgentStopped,
  deleteUserMessageById,
  findCliHistoryCut,
  markToolReverted,
  setSessions,
  beginReplay,
  endReplay,
  beginCompressTurn,
  endCompressTurn,
  parseTranscriptJsonl,
  toAgentPromptText,
  appendInjectedContext,
} from "../shared/session-state";
import { evictBlockPayloads, payloadChars, EVICT_BUDGET_CHARS, initialSessionState, collectUserPromptTexts, normalizeUserPromptText, extractCorePrompt, splitSystemPromptSections, type Block, type SessionState, type ToolBlock } from "../shared/messages";
import type { SessionNotification } from "../src/acp/protocol";
// Mock the tokenizer so we can exercise the heuristic fallback. `vi.hoisted`
// captures `vi` before the `vi.mock` factory is hoisted above the import, so the
// factory body itself never references `vi` directly (required when globals are off).
const { countTokensMock, importActual } = vi.hoisted(() => ({
  countTokensMock: vi.fn<(text: string) => number>(),
  importActual: vi.importActual,
}));

vi.mock("gpt-tokenizer", async () => {
  const actual = await importActual<typeof import("gpt-tokenizer")>("gpt-tokenizer");
  countTokensMock.mockImplementation(actual.countTokens);
  return { ...actual, countTokens: countTokensMock };
});

function notify(update: SessionNotification["update"], sessionId = "s1"): SessionNotification {
  return { sessionId, update };
}

describe("SubAgent tree lifecycle (M5)", () => {
  const task = (id: string, agentId?: string, status: "pending" | "completed" = "pending"): SessionNotification => ({
    sessionId: "s1", update: { sessionUpdate: "tool_call_update", toolName: "task", toolCallId: id, status, agentId },
  });
  const chunk = (agentId: string, text = "hello"): SessionNotification => ({ sessionId: "default-session", update: { sessionUpdate: "agent_message_chunk", agentId, content: { type: "text", text } } });

  it("nests tasks under their caller and binds child agents FIFO across the whole tree", () => {
    const state = initialSessionState();
    applySessionUpdate(state, task("root"));
    applySessionUpdate(state, chunk("parent"));
    expect(applySessionUpdate(state, task("child-a", "parent"))).toBe(0);
    applySessionUpdate(state, task("child-b", "parent"));
    expect(applySessionUpdate(state, chunk("agent-a"))).toBe(0);
    applySessionUpdate(state, chunk("agent-b"));
    const root = state.blocks[0]!;
    if (root.kind !== "subagent") throw new Error("root");
    const children = root.entries.filter((b) => b.kind === "subagent");
    expect(children.map((c) => c.agentId)).toEqual(["agent-a", "agent-b"]);
    expect(applySessionUpdate(state, task("child-a", "parent", "completed"))).toBe(0);
    expect(children[0]!.status).toBe("completed");
    expect(children[1]!.status).toBe("pending");
    expect(root.status).toBe("pending");
  });

  it.each([false, true])("binds interleaved cards created at the same time (restored: %s)", (restored) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
    const state = initialSessionState();
    applySessionUpdate(state, task("root1"));
    // parent1's output binds root1 before the parallel task is created.
    applySessionUpdate(state, chunk("parent1"));
    // root2 is created later at the top level.
    applySessionUpdate(state, task("root2"));
    // nested1 is created later still, under parent1.
    applySessionUpdate(state, task("nested1", "parent1"));

    if (restored) {
      state.blocks = JSON.parse(JSON.stringify(state.blocks)) as Block[];
      backfillBlockIds(state.blocks);
      reassignBlockIds(state.blocks);
    }
    // The first unbound card in global creation order is root2, not nested1.
    expect(applySessionUpdate(state, chunk("parent2"))).toBe(1);

    const root1 = state.blocks[0]!;
    const root2 = state.blocks[1]!;
    if (root1.kind !== "subagent" || root2.kind !== "subagent") throw new Error("expected root cards");
    const nested1 = root1.entries.find((block) => block.kind === "subagent");
    if (!nested1 || nested1.kind !== "subagent") throw new Error("expected nested1");
    expect(root2.agentId).toBe("parent2");
    expect(nested1.agentId).toBe("nested1");
    expect(root2.entries).toEqual([{ kind: "text", text: "hello", id: expect.any(String), tokens: expect.any(Number) }]);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    ["bzz", "b100", 1],
    ["bzzzzzzzzzzzzzz", "b100000000000000", 1],
    [undefined, "b100", 0],
    ["legacy", "b100", 0],
    ["b100", "b100", 0],
  ] as const)("handles base36 boundaries and legacy ids (%s, %s)", (rootId, nestedId, index) => {
    const state = initialSessionState();
    applySessionUpdate(state, task("root1"));
    applySessionUpdate(state, chunk("parent1"));
    applySessionUpdate(state, task("root2"));
    applySessionUpdate(state, task("nested1", "parent1"));
    const root1 = state.blocks[0]!;
    const root2 = state.blocks[1]!;
    if (root1.kind !== "subagent" || root2.kind !== "subagent") throw new Error("roots");
    const nested = root1.entries.find((block) => block.kind === "subagent")!;
    root2.id = rootId;
    nested.id = nestedId;
    expect(applySessionUpdate(state, chunk("parent2"))).toBe(index);
    expect(index === 1 ? root2 : nested).toMatchObject({ agentId: "parent2" });
    expect(applySessionUpdate(state, chunk("last-agent"))).toBe(index === 1 ? 0 : 1);
  });

  it("sums every nested leaf once and records first-entry and terminal times", () => {
    const state = initialSessionState();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    applySessionUpdate(state, task("root"));
    expect(state.blocks[0]!.startedAt).toBeUndefined();
    applySessionUpdate(state, chunk("parent", "parent text"));
    applySessionUpdate(state, task("child", "parent"));
    clock.mockReturnValue(2000);
    applySessionUpdate(state, chunk("child-agent", "child text"));
    const root = state.blocks[0]!;
    if (root.kind !== "subagent") throw new Error("root");
    const child = root.entries.find((b) => b.kind === "subagent")!;
    expect(root.startedAt).toBe(1000);
    expect(child.startedAt).toBe(2000);
    expect(root.tokens).toBe(estimateTokens("parent text") + estimateTokens("child text"));
    expect(estimateSessionUsage(state.blocks).totalTokens).toBe(root.tokens);
    clock.mockReturnValue(3000);
    applySessionUpdate(state, task("child", "parent", "completed"));
    expect(child.completedAt).toBe(3000);
    clock.mockRestore();
  });

  it("recursively closes active descendants even under a terminal root, without inventing legacy duration", () => {
    const state = initialSessionState();
    applySessionUpdate(state, task("root"));
    applySessionUpdate(state, chunk("parent"));
    applySessionUpdate(state, task("child", "parent"));
    const root = state.blocks[0]!;
    if (root.kind !== "subagent") throw new Error("root");
    root.status = "completed";
    expect(closeOpenSubAgents(state.blocks, 5000)).toBe(0);
    const child = root.entries.find((b) => b.kind === "subagent")!;
    expect(child.status).toBe("failed");
    expect(child.startedAt).toBeUndefined();
    expect(child.completedAt).toBeUndefined();
  });

  it("validates session, streaming and active nested target before stop", () => {
    const state = initialSessionState();
    state.sessionId = "s1";
    state.status = "streaming";
    applySessionUpdate(state, task("root"));
    applySessionUpdate(state, chunk("parent"));
    applySessionUpdate(state, task("child", "parent"));
    expect(canStopSubAgent(state, "s1", "child")).toBe(true);
    expect(canStopSubAgent(state, "other", "child")).toBe(false);
    expect(canStopSubAgent(state, "s1", "missing")).toBe(false);
    state.status = "idle";
    expect(canStopSubAgent(state, "s1", "child")).toBe(false);
    state.status = "streaming";
    applySessionUpdate(state, task("child", "parent", "completed"));
    expect(canStopSubAgent(state, "s1", "child")).toBe(false);
  });

  it("markSubAgentStopped flags the card (and its subtree) as stopped, terminal", () => {
    const state = initialSessionState();
    state.sessionId = "s1";
    state.status = "streaming";
    applySessionUpdate(state, task("root"));
    applySessionUpdate(state, chunk("parent"));
    applySessionUpdate(state, task("child", "parent"));
    // give the child an entry (stamps startedAt) and a grandchild card
    applySessionUpdate(state, chunk("child"));
    applySessionUpdate(state, task("grand", "child"));
    const index = markSubAgentStopped(state, "child", 9000);
    // mutation index is the TOP-LEVEL owning card index (blockPatch anchor)
    expect(index).toBe(0);
    const root = state.blocks[0]!;
    if (root.kind !== "subagent") throw new Error("root");
    expect(root.stopped).toBeUndefined();
    expect(root.status).not.toBe("failed");
    expect(root.status).not.toBe("completed");
    const child = root.entries.find((b) => b.kind === "subagent")!;
    if (child.kind !== "subagent") throw new Error("child");
    expect(child.stopped).toBe(true);
    expect(child.status).toBe("failed");
    expect(child.completedAt).toBe(9000);
    const grand = child.entries.find((b) => b.kind === "subagent")!;
    if (grand.kind !== "subagent") throw new Error("grand");
    expect(grand.stopped).toBe(true);
    expect(grand.status).toBe("failed");
    // a stopped card is no longer a valid stop target
    expect(canStopSubAgent(state, "s1", "child")).toBe(false);
    // unknown agentId is a no-op
    expect(markSubAgentStopped(state, "missing")).toBeNull();
  });

  it("markSubAgentStopped keeps a completed card's status but flags stopped", () => {
    const state = initialSessionState();
    applySessionUpdate(state, task("root"));
    applySessionUpdate(state, task("root", undefined, "completed"));
    const index = markSubAgentStopped(state, "root");
    expect(index).toBe(0);
    const root = state.blocks[0]!;
    if (root.kind !== "subagent") throw new Error("root");
    expect(root.stopped).toBe(true);
    expect(root.status).toBe("completed");
  });

  it("stopped survives the transcript persist/restore round-trip", () => {
    const state = initialSessionState();
    applySessionUpdate(state, task("root"));
    markSubAgentStopped(state, "root");
    const restored = JSON.parse(JSON.stringify(state.blocks)) as typeof state.blocks;
    backfillBlockIds(restored);
    const root = restored[0]!;
    if (root.kind !== "subagent") throw new Error("root");
    expect(root.stopped).toBe(true);
    expect(root.status).toBe("failed");
  });
});

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

  it("opens a separate card per parallel task instead of merging into the open one", () => {
    // Parallel tasks (verified live): the main-session `task` tool_call
    // carries no agentId, and a second `task` arrives while the first card
    // is still in_progress. The old "any task update belongs to the open
    // interval" rule merged it into card 1 and card 2 never existed.
    const state: SessionState = initialSessionState();
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "task_a", toolName: "task", title: "Launch agent(explore-agent): 审查前端业务", kind: "other", status: "pending" }));
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "task_b", toolName: "task", title: "Launch agent(explore-agent): 审查后端业务", kind: "other", status: "pending" }));
    // Nested (agentId-less) flat activity goes to the newest open card…
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "r1", toolName: "read_file", title: "Reading a.ts", kind: "read", status: "completed" }));
    // …while each task's own completion matches by its OWN toolCallId,
    // even out of order (b finishes before a).
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call_update", toolCallId: "task_b", toolName: "task", kind: "other", status: "completed" }));
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call_update", toolCallId: "task_a", toolName: "task", kind: "other", status: "completed" }));

    expect(state.blocks.map((b) => b.kind)).toEqual(["subagent", "subagent"]);
    const [a, b] = state.blocks as [Extract<Block, { kind: "subagent" }>, Extract<Block, { kind: "subagent" }>];
    expect(a.taskToolCallId).toBe("task_a");
    expect(a.title).toContain("前端");
    expect(a.status).toBe("completed");
    expect(b.taskToolCallId).toBe("task_b");
    expect(b.title).toContain("后端");
    expect(b.status).toBe("completed");
    // r1 (agentId-less nested) rides the newest open card at the time (b);
    // card a's entries only ever saw its own spawning call.
    expect(a.entries.map((e) => e.kind)).toEqual(["tool"]);
    expect(b.entries.some((e) => e.kind === "tool" && (e as Extract<Block, { kind: "tool" }>).toolName === "task")).toBe(true);
  });

  it("adopts unbound cards FIFO so parallel adapter events hit the right card", () => {
    const state: SessionState = initialSessionState();
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "task_a", toolName: "task", title: "Launch agent(x): 任务甲", kind: "other", status: "in_progress" }));
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "task_b", toolName: "task", title: "Launch agent(x): 任务乙", kind: "other", status: "in_progress" }));
    // Adapter event for the FIRST agent (agents start in launch order).
    applySessionUpdate(
      state,
      notify({
        sessionUpdate: "tool_call",
        toolCallId: "nested_a1",
        toolName: "read_file",
        title: "Reading a.ts",
        kind: "read",
        status: "completed",
        agentId: "agent-1",
      } as SessionNotification["update"]),
    );
    const [a, b] = state.blocks as [Extract<Block, { kind: "subagent" }>, Extract<Block, { kind: "subagent" }>];
    expect(a.agentId).toBe("agent-1");
    expect(a.entries.some((e) => e.kind === "tool" && (e as Extract<Block, { kind: "tool" }>).toolCallId === "nested_a1")).toBe(true);
    expect(b.agentId).toBe("task_b");
    expect(b.entries).toHaveLength(0);
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

describe("system status text classification", () => {
  it("flags CLI compression status lines as system text (no copy/regenerate)", () => {
    const state: SessionState = initialSessionState();
    applySessionUpdate(
      state,
      notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "正在压缩..." } }),
    );
    expect(state.blocks).toHaveLength(1);
    const b = state.blocks[0]!;
    expect(b.kind).toBe("text");
    if (b.kind !== "text") throw new Error("expected text");
    expect(b.system).toBe(true);
  });

  it("flags compression failure lines as system text", () => {
    const state: SessionState = initialSessionState();
    applySessionUpdate(
      state,
      notify({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "压缩聊天历史失败：生成数据错误: fetch failed" },
      }),
    );
    const b = state.blocks[0]!;
    if (b.kind !== "text") throw new Error("expected text");
    expect(b.system).toBe(true);
  });

  it("does not merge a leading status line with the assistant reply that follows", () => {
    const state: SessionState = initialSessionState();
    applySessionUpdate(
      state,
      notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "正在压缩..." } }),
    );
    applySessionUpdate(
      state,
      notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "好的，我来看下这个仓库。" } }),
    );
    expect(state.blocks).toHaveLength(2);
    const [sys, reply] = state.blocks as [Extract<Block, { kind: "text" }>, Extract<Block, { kind: "text" }>];
    expect(sys.system).toBe(true);
    expect(reply.system).toBeUndefined();
    expect(reply.text).toBe("好的，我来看下这个仓库。");
  });

  it("does not let normal reply text absorb a following status line", () => {
    const state: SessionState = initialSessionState();
    applySessionUpdate(
      state,
      notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "我先分析代码。" } }),
    );
    applySessionUpdate(
      state,
      notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "正在压缩..." } }),
    );
    expect(state.blocks).toHaveLength(2);
    const [reply, sys] = state.blocks as [Extract<Block, { kind: "text" }>, Extract<Block, { kind: "text" }>];
    expect(reply.system).toBeUndefined();
    expect(sys.system).toBe(true);
  });

  it("flags approval/plan resolution notes as system text", () => {
    const state: SessionState = initialSessionState();
    appendApprovalResolution(state, "plan", "已批准计划");
    const b = state.blocks[0]!;
    if (b.kind !== "text") throw new Error("expected text");
    expect(b.system).toBe(true);
    expect(b.text).toBe("*plan — 已批准计划*");
  });

  it("classifies restored compression status lines as system text", () => {
    const jsonl = [
      JSON.stringify({ type: "user", message: { content: "压缩一下" } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "压缩聊天历史失败：stream timeout" }] },
      }),
    ].join("\n");
    const { blocks } = parseTranscriptJsonl(jsonl);
    const b = blocks[1]!;
    if (b.kind !== "text") throw new Error("expected text");
    expect(b.system).toBe(true);
  });

  it("backfills the system flag on legacy persisted blocks", () => {
    const blocks = [
      { kind: "text", text: "正在压缩..." },
      { kind: "text", text: "*plan — 已批准计划*" },
      { kind: "text", text: "普通回复 — 不是注记" },
      { kind: "text", text: "好的", system: false },
    ] as Block[];
    backfillBlockIds(blocks);
    const flags = blocks.map((b) => (b.kind === "text" ? b.system : undefined));
    expect(flags[0]).toBe(true);
    expect(flags[1]).toBe(true);
    expect(flags[2]).toBeUndefined();
    expect(flags[3]).toBe(false); // explicit value wins
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

describe("closeOpenSubAgents (zombie interval after a killed turn)", () => {
  /** Open a flat-interval card and leave it non-terminal (CLI killed mid-task). */
  function openZombie(state: SessionState): void {
    applySessionUpdate(
      state,
      notify({ sessionUpdate: "tool_call", toolCallId: "task-z", toolName: "task", title: "Launch agent(x): 修复", kind: "other", status: "in_progress" }),
    );
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "n-z", toolName: "read_file", title: "读", kind: "read", status: "completed" }));
  }

  it("completePrompt force-closes a non-terminal card and later events stay top-level", () => {
    const state: SessionState = initialSessionState();
    openZombie(state);
    expect(state.blocks).toHaveLength(1);

    const closedFrom = completePrompt(state, "cancelled");
    expect(closedFrom).toBe(0);
    const sub = state.blocks[0]!;
    if (sub.kind !== "subagent") throw new Error("expected subagent");
    expect(sub.status).toBe("failed");

    // The next turn must NOT be swallowed by the closed card.
    beginUserPrompt(state, "继续");
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "正常回复" } }));
    expect(state.blocks.map((b) => b.kind)).toEqual(["subagent", "user", "text"]);
    const after = state.blocks[0]!;
    if (after.kind === "subagent" && after.entries.some((e) => e.kind === "text")) {
      throw new Error("post-turn event leaked into the card");
    }
  });

  it("returns null when every card is already terminal (completed cards untouched)", () => {
    const state: SessionState = initialSessionState();
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "task-ok", toolName: "task", title: "任务", kind: "other", status: "in_progress" }));
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call_update", toolCallId: "task-ok", toolName: "task", kind: "other", status: "completed" }));
    expect(completePrompt(state, "end_turn")).toBeNull();
    const sub = state.blocks[0]!;
    if (sub.kind !== "subagent") throw new Error("expected subagent");
    expect(sub.status).toBe("completed");
  });

  it("closes multiple open cards and reports the LOWEST index", () => {
    const state: SessionState = initialSessionState();
    state.blocks.push(
      { kind: "text", text: "前置", id: nextBlockId() },
      { kind: "subagent", id: nextBlockId(), agentId: "a1", taskToolCallId: "t1", title: "一", status: "completed", agentType: null, entries: [] },
      { kind: "subagent", id: nextBlockId(), agentId: "a2", taskToolCallId: "t2", title: "二", status: "in_progress", agentType: null, entries: [] },
      { kind: "subagent", id: nextBlockId(), agentId: "a3", taskToolCallId: "t3", title: "三", status: "pending", agentType: null, entries: [] },
    );
    expect(closeOpenSubAgents(state.blocks)).toBe(2);
    expect(state.blocks.map((b) => (b.kind === "subagent" ? b.status : "-"))).toEqual(["-", "completed", "failed", "failed"]);
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

  it("groups nested events carrying update.agentId (real CLI 0.5.19 wire shape)", () => {
    // Wire shape (verified in the CLI bundle): the SubAgent adapter pushes
    // {sessionId:"default-session", update:{…, agentId}} — the agentId rides
    // the UPDATE, not the notification. Regression guard for the shape the
    // extension actually receives in production.
    const state: SessionState = initialSessionState();
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "task-w", toolName: "task", title: "Launch agent(explore-agent): 探索", kind: "other", status: "in_progress" }));
    const nested = (update: SessionNotification["update"]): SessionNotification => ({
      sessionId: "default-session",
      update: { ...update, agentId: "agent-w" } as SessionNotification["update"],
    });
    applySessionUpdate(state, nested({ sessionUpdate: "tool_call", toolCallId: "n-w1", toolName: "read_file", title: "Reading a.ts", kind: "read", status: "pending" }));
    applySessionUpdate(state, nested({ sessionUpdate: "tool_call_update", toolCallId: "n-w1", toolName: "read_file", kind: "read", status: "completed" }));
    applySessionUpdate(state, nested({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "探索中" } }));
    expect(state.blocks).toHaveLength(1); // no top-level leakage
    const sub = state.blocks[0]!;
    if (sub.kind !== "subagent") throw new Error("expected subagent");
    expect(sub.agentId).toBe("agent-w"); // adopted from the open interval
    expect(sub.entries.map((e) => e.kind)).toEqual(["tool", "text"]);
    expect(sub.entries[0]).toMatchObject({ toolName: "read_file", status: "completed" });
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

describe("todo tool unification (single TaskList card)", () => {
  it("suppresses todo_write tool cards — the CLI's plan update is the single representation", () => {
    const state = initialSessionState();
    applySessionUpdate(
      state,
      notify({ sessionUpdate: "tool_call", toolCallId: "tw1", toolName: "todo_write", title: "Updating todos", status: "in_progress" }),
    );
    applySessionUpdate(
      state,
      notify({ sessionUpdate: "tool_call_update", toolCallId: "tw1", toolName: "todo_write", title: "Updating todos", status: "completed" }),
    );
    expect(state.blocks).toEqual([]);
    // The plan update the CLI sends right after the completed update
    // (bundle: handleTodoWriteToolResult) renders the unified TaskList card.
    applySessionUpdate(
      state,
      notify({ sessionUpdate: "plan", entries: [{ content: "步骤一", status: "in_progress", priority: "high" }] }),
    );
    expect(state.blocks.map((b) => b.kind)).toEqual(["plan"]);
  });

  it("suppresses every todo naming variant and todo_read bookkeeping", () => {
    const state = initialSessionState();
    const names = ["TodoWrite", "todo-write", "todowrite", "todo_read", "TodoRead", "todo-read", "todo_update"];
    names.forEach((toolName, i) => {
      expect(
        applySessionUpdate(state, notify({ sessionUpdate: "tool_call_update", toolCallId: `t${i}`, toolName, status: "completed" })),
      ).toBeNull();
    });
    expect(state.blocks).toEqual([]);
  });

  it("keeps non-todo tool cards untouched", () => {
    const state = initialSessionState();
    applySessionUpdate(
      state,
      notify({ sessionUpdate: "tool_call_update", toolCallId: "r1", toolName: "read_file", title: "Reading a.ts", status: "completed" }),
    );
    expect(state.blocks.map((b) => b.kind)).toEqual(["tool"]);
  });

  it("restores todo_write from CLI jsonl as a TaskList (plan) block and drops todo_read", () => {
    const jsonl = [
      JSON.stringify({ type: "user", message: { content: "开始" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu1",
              name: "todo_write",
              input: {
                todos: [
                  { id: "1", task: "写代码", status: "in_progress", priority: "high" },
                  { id: "2", task: "写测试", status: "pending" },
                ],
              },
            },
          ],
        },
      }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu2", name: "todo_read", input: {} }] } }),
    ].join("\n");
    const { blocks } = parseTranscriptJsonl(jsonl);
    expect(blocks.map((b) => b.kind)).toEqual(["user", "plan"]);
    const plan = blocks[1]!;
    if (plan.kind !== "plan") throw new Error("expected plan");
    expect(plan.entries).toEqual([
      { content: "写代码", status: "in_progress", priority: "high" },
      { content: "写测试", status: "pending", priority: "low" },
    ]);
  });

  it("unifies todo calls inside restored sidechain (SubAgent) runs", () => {
    const jsonl = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "task1", name: "task", input: { description: "Task: 检查" } }] } }),
      JSON.stringify({ type: "user", isSidechain: true, message: { content: "做子任务" } }),
      JSON.stringify({
        type: "assistant",
        isSidechain: true,
        message: { content: [{ type: "tool_use", id: "tw9", name: "todo_write", input: { todos: [{ task: "子任务步骤", status: "completed" }] } }] },
      }),
    ].join("\n");
    const { blocks } = parseTranscriptJsonl(jsonl);
    expect(blocks.map((b) => b.kind)).toEqual(["subagent"]);
    const sub = blocks[0]!;
    if (sub.kind !== "subagent") throw new Error("expected subagent");
    expect(sub.entries.map((b) => b.kind)).toEqual(["text", "plan"]);
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

describe("MCP edit-tool diff synthesis", () => {
  it("parseEditArgs recognizes desktop-commander edit shapes", () => {
    expect(parseEditArgs({ file_path: "/a/b.ts", old_string: "x", new_string: "y" })).toEqual({
      path: "/a/b.ts",
      edits: [{ oldText: "x", newText: "y", expectedReplacements: 1 }],
    });
    expect(parseEditArgs({ path: "/a/b.ts", old_text: "x", new_text: "y", expected_replacements: 3 })).toEqual({
      path: "/a/b.ts",
      edits: [{ oldText: "x", newText: "y", expectedReplacements: 3 }],
    });
    // Batch edits ride inside `edits`.
    const batch = parseEditArgs({
      path: "/a/b.ts",
      edits: [
        { old_text: "a", new_text: "b" },
        { old_text: "c", new_text: "d" },
      ],
    });
    expect(batch?.edits.length).toBe(2);
    // Generic wire shape.
    expect(parseEditArgs({ path: "p", oldText: "o", newText: "n" })).not.toBeNull();
  });

  it("parseEditArgs rejects non-edit and malformed args", () => {
    expect(parseEditArgs(null)).toBeNull();
    expect(parseEditArgs("string")).toBeNull();
    expect(parseEditArgs([])).toBeNull();
    // No recognized old/new pair (write-style content cannot be reversed).
    expect(parseEditArgs({ file_path: "/a/b.ts", content: "whole file" })).toBeNull();
    // No path.
    expect(parseEditArgs({ old_string: "x", new_string: "y" })).toBeNull();
    // Mixed pair keys must not cross-match.
    expect(parseEditArgs({ path: "p", old_string: "x", new_text: "y" })).toBeNull();
  });

  it("synthesizeEditDiff reverses a single replacement against the post-edit file", () => {
    const parsed = parseEditArgs({ file_path: "/a/b.ts", old_string: "const a = 1;", new_string: "const a = 2;" })!;
    const post = "line0\nconst a = 2;\nline2\n";
    const diff = synthesizeEditDiff(parsed, post)!;
    expect(diff).not.toBeNull();
    expect(diff.newText).toBe(post);
    expect(diff.oldText).toBe("line0\nconst a = 1;\nline2\n");
  });

  it("synthesizeEditDiff undoes batch edits in reverse order", () => {
    const parsed = parseEditArgs({
      path: "/a/b.ts",
      edits: [
        { old_text: "alpha", new_text: "ALPHA" },
        { old_text: "beta", new_text: "BETA" },
      ],
    })!;
    const post = "ALPHA and BETA\n";
    const diff = synthesizeEditDiff(parsed, post)!;
    expect(diff.oldText).toBe("alpha and beta\n");
  });

  it("synthesizeEditDiff bails when occurrence count disagrees with the tool", () => {
    const parsed = parseEditArgs({ file_path: "/a/b.ts", old_string: "x", new_string: "y", expected_replacements: 2 })!;
    // Only one "y" on disk — the file moved on or the count is wrong: no guess.
    expect(synthesizeEditDiff(parsed, "y\n")).toBeNull();
    // Missing fragment entirely.
    const missing = parseEditArgs({ file_path: "/a/b.ts", old_string: "x", new_string: "zzz" })!;
    expect(synthesizeEditDiff(missing, "nothing here\n")).toBeNull();
  });

  it("synthesizeEditDiff bails on deletions, no-ops, and oversized files", () => {
    // Pure deletion: nothing left to anchor the reversal.
    const del = parseEditArgs({ path: "p", old_string: "gone", new_string: "" })!;
    expect(synthesizeEditDiff(del, "rest\n")).toBeNull();
    // No-op edit.
    const noop = parseEditArgs({ path: "p", old_string: "same", new_string: "same" })!;
    expect(synthesizeEditDiff(noop, "same\n")).toBeNull();
    // Oversized post-edit content is skipped.
    const big = parseEditArgs({ path: "p", old_string: "x", new_string: "y" })!;
    expect(synthesizeEditDiff(big, "y".repeat(256 * 1024 + 10))).toBeNull();
  });

  it("attachSynthesizedDiff attaches to a top-level tool block and recounts tokens", () => {
    const state = initialSessionState();
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "t1", toolName: "edit_block", kind: "other", status: "pending" }));
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "ok" } }] }));
    const idx = attachSynthesizedDiff(state, "t1", { path: "/a/b.ts", oldText: "old", newText: "new" });
    expect(idx).toBe(0);
    const tool = state.blocks[0]!;
    expect(tool.kind === "tool" && tool.diff).toEqual({ path: "/a/b.ts", oldText: "old", newText: "new" });
    // A second attach must not overwrite (wire diff / first synthesis wins).
    expect(attachSynthesizedDiff(state, "t1", { path: "other", oldText: "x", newText: "y" })).toBeNull();
  });

  it("attachSynthesizedDiff reaches nested SubAgent entries and reports the card index", () => {
    const state = initialSessionState();
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "task-1", toolName: "task", title: "Launch agent(x): 编辑", kind: "other", status: "in_progress" }));
    applySessionUpdate(
      state,
      { sessionId: "s1", agentId: "agent-1", update: { sessionUpdate: "tool_call", toolCallId: "n1", toolName: "edit_block", kind: "other", status: "completed" } },
    );
    const idx = attachSynthesizedDiff(state, "n1", { path: "/a/b.ts", oldText: "old", newText: "new" });
    expect(idx).toBe(0); // the SubAgent card index rides the blockPatch
    const sub = state.blocks[0]!;
    expect(sub.kind).toBe("subagent");
    if (sub.kind === "subagent") {
      const nested = sub.entries.find((e) => e.kind === "tool");
      expect(nested && nested.kind === "tool" && nested.diff?.path).toBe("/a/b.ts");
    }
    expect(findToolBlockById(state.blocks, "n1")).not.toBeNull();
    expect(findToolBlockById(state.blocks, "missing")).toBeNull();
  });

  it("wire structured diff always wins over synthesis targets", () => {
    // Blocks that already carry a wire diff are never touched (attach returns
    // null) — the reducer's extractDiff path remains the priority source.
    const state = initialSessionState();
    applySessionUpdate(
      state,
      notify({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        toolName: "replace",
        kind: "edit",
        status: "completed",
        content: [{ type: "diff", path: "wire.ts", oldText: "a", newText: "b" }],
      }),
    );
    expect(attachSynthesizedDiff(state, "t1", { path: "synth.ts", oldText: "x", newText: "y" })).toBeNull();
    const tool = state.blocks[0]!;
    expect(tool.kind === "tool" && tool.diff?.path).toBe("wire.ts");
  });

  it("parseToolFilePath extracts paths from any tool's args", () => {
    expect(parseToolFilePath({ file_path: "/a/b.ts", content: "whole file" })).toBe("/a/b.ts");
    expect(parseToolFilePath({ path: "src/x.ts", pattern: "anything" })).toBe("src/x.ts");
    expect(parseToolFilePath({ absolute_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(parseToolFilePath({ query: "no path here" })).toBeNull();
    expect(parseToolFilePath(null)).toBeNull();
    expect(parseToolFilePath("string")).toBeNull();
  });

  it("snapshotEditDiff turns before/after disk content into a diff for any tool", () => {
    // Modification (any edit shape — replace, write, sed, MCP editor…).
    expect(snapshotEditDiff({ path: "/a/b.ts", content: "old\n" }, "new\n")).toEqual({
      path: "/a/b.ts",
      oldText: "old\n",
      newText: "new\n",
    });
    // Creation: absent before, content after (write_file style).
    expect(snapshotEditDiff({ path: "/a/b.ts", content: null }, "brand new\n")).toEqual({
      path: "/a/b.ts",
      oldText: null,
      newText: "brand new\n",
    });
    // Deletion: content before, gone after.
    expect(snapshotEditDiff({ path: "/a/b.ts", content: "was here\n" }, null)).toEqual({
      path: "/a/b.ts",
      oldText: "was here\n",
      newText: null,
    });
    // No-op (a read tool, or an edit that changed nothing) → no diff.
    expect(snapshotEditDiff({ path: "/a/b.ts", content: "same\n" }, "same\n")).toBeNull();
    // Absent before AND after (a failed creation) → no diff.
    expect(snapshotEditDiff({ path: "/a/b.ts", content: null }, null)).toBeNull();
    // Oversized content on either side is skipped.
    expect(snapshotEditDiff({ path: "/a/b.ts", content: "x" }, "y".repeat(256 * 1024 + 1))).toBeNull();
    expect(snapshotEditDiff({ path: "/a/b.ts", content: "x".repeat(256 * 1024 + 1) }, "y")).toBeNull();
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
      deadline: Date.now() + 5 * 60_000,
      timeoutMs: 5 * 60_000,
    });
    expect(state.pendingApproval?.id).toBe("ap-1");
    expect(state.pendingApproval?.deadline).toBeGreaterThan(Date.now());
    expect(state.pendingApproval?.timeoutMs).toBe(5 * 60_000);
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
      deadline: Date.now() + 60_000,
      timeoutMs: 60_000,
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
    expect(markToolReverted(state, "t1")).toBe(0);
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
    expect(markToolReverted(state, "t1")).toBe(0);
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

  it("returns null for unknown toolCallId", () => {
    const state = initialSessionState();
    expect(markToolReverted(state, "nope")).toBeNull();
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
    state.pendingQuestions = { id: "q1", questions: [], deadline: Date.now() + 60_000, timeoutMs: 60_000 };
    beginReplay(state);
    // No placeholder block: the replay wait is rendered by the webview's own
    // indicator while `replaying` is true.
    expect(state.blocks).toHaveLength(0);
    expect(state.replaying).toBe(true);
    expect(state.status).toBe("streaming");
    expect(state.pendingApproval).toBeNull();
    // Review B3: the shared transcript-field list must include
    // pendingQuestions — a question card from the outgoing session used to
    // survive into the restored transcript.
    expect(state.pendingQuestions).toBeNull();
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

  it("sortSessionSummaries: pinned first, then newest activity (M4 P1-8)", () => {
    const input = [
      { id: "old", label: "旧", updatedAt: 100 },
      { id: "pin-old", label: "置顶旧", updatedAt: 50, pinned: true },
      { id: "new", label: "新", updatedAt: 300 },
      { id: "arch-new", label: "归档新", updatedAt: 200, archived: true },
      { id: "pin-new", label: "置顶新", updatedAt: 400, pinned: true },
    ];
    const sorted = sortSessionSummaries(input);
    expect(sorted.map((s) => s.id)).toEqual(["pin-new", "pin-old", "new", "arch-new", "old"]);
    // Immutable: the stored index and the caller's array never alias mutations.
    expect(input.map((s) => s.id)).toEqual(["old", "pin-old", "new", "arch-new", "pin-new"]);
  });
});

describe("estimateTokens", () => {
  it("uses the real BPE tokenizer for normal input", () => {
    // Sanity check: real o200k_base count, not the CJK heuristic.
    expect(estimateTokens("hello world")).toBe(2);
  });

  it("falls back to the CJK-aware heuristic when the tokenizer throws", () => {
    const text = "hello world";
    countTokensMock.mockImplementationOnce(() => {
      throw new Error("forced fallback");
    });
    const got = estimateTokens(text);
    // Mirrors the heuristic in session-state.ts: CJK/fullwidth/kana ≈ 1.5 tokens,
    // other chars ≈ 0.25 tokens. ASCII "hello world" (11 chars) → ceil(11 * 0.25) = 3.
    const cjk = (text.match(/[　-鿿぀-ヿ＀-￯]/g) ?? []).length;
    const other = text.length - cjk;
    expect(got).toBe(Math.ceil(cjk * 1.5 + other * 0.25));
  });
});

describe("tool output truncation (P0-2)", () => {
  it("caps output at MAX_TOOL_OUTPUT_CHARS and records truncatedChars", () => {
    const state = initialSessionState();
    const big = "y".repeat(64 * 1024 + 100);
    applySessionUpdate(state, notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      toolName: "read_file",
      title: "",
      kind: "read",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: big } }],
    }));
    const tool = state.blocks[0]!;
    if (tool.kind !== "tool") throw new Error("expected tool block");
    expect(tool.output.length).toBe(64 * 1024);
    expect(tool.truncatedChars).toBe(100);
  });

  it("does not truncate output below the cap (truncatedChars absent)", () => {
    const state = initialSessionState();
    applySessionUpdate(state, notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      toolName: "read_file",
      title: "",
      kind: "read",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "short" } }],
    }));
    const tool = state.blocks[0]!;
    if (tool.kind !== "tool") throw new Error("expected tool block");
    expect(tool.output).toBe("short");
    expect(tool.truncatedChars).toBeUndefined();
  });

  it("does NOT truncate diff newText (revert matches disk content verbatim)", () => {
    const state = initialSessionState();
    const bigNew = "z".repeat(64 * 1024 + 500);
    applySessionUpdate(state, notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      toolName: "edit",
      title: "",
      kind: "edit",
      status: "completed",
      content: [{ type: "diff", path: "a.txt", oldText: "old", newText: bigNew }],
    }));
    const tool = state.blocks[0]!;
    if (tool.kind !== "tool") throw new Error("expected tool block");
    expect(tool.diff?.newText).toBe(bigNew); // intact
    expect(tool.truncatedChars).toBeUndefined();
  });
});

describe("block token cache (P1 incremental usage)", () => {
  it("keeps caches valid through streaming: each append tokenizes only its chunk", () => {
    const state = initialSessionState();
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "第一轮回答" } }));
    // The chunk itself established the block's cache — turn end adds nothing.
    completePrompt(state, "end_of_turn");
    const before = state.blocks[0]!.tokens!; // capture the NUMBER, not the block ref
    expect(before).toBeGreaterThan(0);

    // Second turn appends to the SAME text block (streaming growth): the
    // cache ACCUMULATES the new chunk's tokens — one tokenize call for the
    // chunk, never a re-scan of the grown block.
    countTokensMock.mockClear();
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "第二轮回答" } }));
    expect(countTokensMock).toHaveBeenCalledTimes(1); // the chunk only, not per-refresh re-scan
    const grown = state.blocks[0]!.tokens!;
    expect(grown).toBeGreaterThan(before);
    expect(state.blocks).toHaveLength(1); // merged into the same block
    countTokensMock.mockClear();
    completePrompt(state, "end_of_turn");
    expect(countTokensMock).not.toHaveBeenCalled(); // caches stayed valid all along
    expect(state.blocks[0]!.tokens).toBe(grown);
  });

  it("reuses the cache across turns for blocks whose content stopped growing", () => {
    const state = initialSessionState();
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "稳定块" } }));
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "t1", toolName: "ls", title: "", kind: "read", status: "pending" }));
    completePrompt(state, "end_of_turn");
    // All blocks now have caches (turn end established them).
    countTokensMock.mockClear();
    // Next turn: new user prompt (a fresh block — tokenized once).
    beginUserPrompt(state, "新问题");
    completePrompt(state, "end_of_turn");
    // Only the NEW user block was tokenized; the stable text and tool blocks reused caches.
    expect(countTokensMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates a tool block's cache when the reducer updates its content", () => {
    const state = initialSessionState();
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "t1", toolName: "ls", title: "", kind: "read", status: "pending" }));
    completePrompt(state, "end_of_turn");
    const before = state.blocks[0]!.tokens!;

    // The tool completes with output — the cache must be recomputed, not reused.
    countTokensMock.mockClear();
    applySessionUpdate(state, notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      toolName: "ls",
      title: "",
      kind: "read",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "新的输出内容" } }],
    }));
    const tool = state.blocks[0]!;
    if (tool.kind !== "tool") throw new Error("expected tool block");
    expect(tool.tokens).not.toBe(before);
    // The update itself consumed one tokenize call (recount at mutation time).
    expect(countTokensMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT recount a tool block on a pure status flip (no content change)", () => {
    const state = initialSessionState();
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "t1", toolName: "ls", title: "ls", kind: "read", status: "pending" }));
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call_update", toolCallId: "t1", toolName: "ls", title: "ls", kind: "read", status: "completed", content: [{ type: "content", content: { type: "text", text: "输出" } }] }));
    completePrompt(state, "end_of_turn");
    const cached = state.blocks[0]!.tokens!;

    // A later update that only flips status (no new output/diff/title) must
    // ride the cache — the hot tool-update path stays BPE-free.
    countTokensMock.mockClear();
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call_update", toolCallId: "t1", toolName: "ls", title: "ls", kind: "read", status: "in_progress" }));
    expect(countTokensMock).not.toHaveBeenCalled();
    expect(state.blocks[0]!.tokens).toBe(cached);
  });
});

describe("session usage split & real-time refresh", () => {
  it("splits input (user/tool) from output (text/thought)", () => {
    const state = initialSessionState();
    beginUserPrompt(state, "用户的问题");
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "回答内容" } }));
    // tool_call opens without output; the output arrives on the update (wire shape).
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "t1", toolName: "ls", title: "列出目录", kind: "read", status: "pending" }));
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call_update", toolCallId: "t1", toolName: "ls", title: "列出目录", kind: "read", status: "completed", content: [{ type: "content", content: { type: "text", text: "文件清单" } }] }));
    completePrompt(state, "end_of_turn");
    const usage = state.usage!;
    // user prompt + tool block are input; the agent reply is output.
    const expectedInput = estimateTokens("用户的问题") + estimateTokens("列出目录\n文件清单");
    const expectedOutput = estimateTokens("回答内容");
    expect(usage.inputTokens).toBe(expectedInput);
    expect(usage.outputTokens).toBe(expectedOutput);
    expect(usage.totalTokens).toBe(expectedInput + expectedOutput);
  });

  it("refreshSessionUsage is reference-stable when numbers are unchanged", () => {
    const state = initialSessionState();
    beginUserPrompt(state, "问题");
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "回答" } }));
    refreshSessionUsage(state);
    const first = state.usage;
    expect(first).not.toBeNull();
    // No content moved between refreshes → the SAME object is kept (lets the
    // webview's Object.is selector skip a re-render).
    refreshSessionUsage(state);
    expect(state.usage).toBe(first);
  });

  it("refreshSessionUsage grows live mid-stream without waiting for turn end", () => {
    const state = initialSessionState();
    beginUserPrompt(state, "问题");
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "第一段" } }));
    refreshSessionUsage(state);
    const mid = state.usage!;
    expect(mid.outputTokens).toBeGreaterThan(0);
    // More streaming, then a refresh BEFORE completePrompt reflects it.
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "，第二段更长的内容" } }));
    refreshSessionUsage(state);
    const later = state.usage!;
    expect(later.outputTokens).toBeGreaterThan(mid.outputTokens);
    expect(later).not.toBe(mid); // numbers moved → a fresh object
  });

  it("usage is zeroed (not null) from session start so the chip shows immediately", () => {
    const state = initialSessionState();
    expect(state.usage).not.toBeNull();
    expect(state.usage!.inputTokens).toBe(0);
    expect(state.usage!.outputTokens).toBe(0);
    // A new session resets to a fresh zeroed counter, never null.
    beginUserPrompt(state, "问题");
    completePrompt(state, "end_of_turn");
    expect(state.usage!.totalTokens).toBeGreaterThan(0);
    const fresh = newSessionState(state);
    expect(fresh.usage).not.toBeNull();
    expect(fresh.usage!.totalTokens).toBe(0);
  });

  it("drops the context counter to the compressed context after /compress", () => {
    const state = initialSessionState();
    beginUserPrompt(state, "很长的历史对话".repeat(1000));
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "很长的历史回复".repeat(1000) } }));
    completePrompt(state, "end_of_turn");
    const before = state.usage!.totalTokens;
    // The compression event arrives (CLI's authoritative post-compression size).
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ type: "compression", compression: { isPending: false, originalTokenCount: before, newTokenCount: 7855, summary: "压缩摘要" } }) } }));
    refreshSessionUsage(state);
    // Everything before the card folds into the CLI's newTokenCount.
    expect(state.usage!.inputTokens).toBe(7855);
    // Post-compression turns count on top of the compressed context.
    beginUserPrompt(state, "压缩后的新问题");
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "压缩后的回答" } }));
    completePrompt(state, "end_of_turn");
    expect(state.usage!.inputTokens).toBe(7855 + estimateTokens("压缩后的新问题"));
    expect(state.usage!.outputTokens).toBe(estimateTokens("压缩后的回答"));
    // The counter dropped — the old cumulative fold could only ever grow.
    expect(state.usage!.totalTokens).toBeLessThan(before);
  });

  it("a pending compression card does not fold the context", () => {
    const state = initialSessionState();
    beginUserPrompt(state, "问题");
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "回答" } }));
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ type: "compression", compression: { isPending: true, originalTokenCount: null, newTokenCount: null } }) } }));
    refreshSessionUsage(state);
    expect(state.usage!.inputTokens).toBe(estimateTokens("问题"));
    expect(state.usage!.outputTokens).toBe(estimateTokens("回答"));
  });

  it("multi-round compression folds at the LAST completed card only", () => {
    const state = initialSessionState();
    beginUserPrompt(state, "第一轮问题");
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ type: "compression", compression: { isPending: false, originalTokenCount: 90000, newTokenCount: 8000, summary: "第一次摘要" } }) } }));
    beginUserPrompt(state, "第二轮问题");
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ type: "compression", compression: { isPending: false, originalTokenCount: 30000, newTokenCount: 3000, summary: "第二次摘要" } }) } }));
    beginUserPrompt(state, "第三轮问题");
    refreshSessionUsage(state);
    // First round's blocks AND the first card fold into the second card's number.
    expect(state.usage!.inputTokens).toBe(3000 + estimateTokens("第三轮问题"));
  });

  it("restored transcripts fold at the isCompactSummary card too", () => {
    const jsonl = [
      JSON.stringify({ type: "user", message: { content: "修复限流器" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "大量历史输出".repeat(100) }] } }),
      JSON.stringify({ type: "user", isCompactSummary: true, compressionInfo: { originalTokenCount: 98134, newTokenCount: 7855, summary: "Continued summary." }, message: { content: "Continued summary." } }),
      JSON.stringify({ type: "user", message: { content: "继续修复" } }),
    ].join("\n");
    const { blocks } = parseTranscriptJsonl(jsonl);
    const usage = estimateSessionUsage(blocks);
    expect(usage.inputTokens).toBe(7855 + estimateTokens("继续修复"));
    // The pre-compression assistant output is out of context too.
    expect(usage.outputTokens).toBe(0);
  });

  it("P0-6: contextUsed mirrors the post-fold total and breakdown sums by kind", () => {
    const state = initialSessionState();
    beginUserPrompt(state, "用户的问题");
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "回答内容" } }));
    applySessionUpdate(state, notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "思考过程" } }));
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "t1", toolName: "ls", title: "列出目录", kind: "read", status: "pending" }));
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call_update", toolCallId: "t1", toolName: "ls", title: "列出目录", kind: "read", status: "completed", content: [{ type: "content", content: { type: "text", text: "文件清单" } }] }));
    refreshSessionUsage(state);
    const usage = state.usage!;
    // contextUsed is the model's carried context, not a separate counter.
    expect(usage.contextUsed).toBe(usage.totalTokens);
    const b = usage.breakdown!;
    expect(b.user).toBe(estimateTokens("用户的问题"));
    expect(b.assistant).toBe(estimateTokens("回答内容"));
    expect(b.thought).toBe(estimateTokens("思考过程"));
    expect(b.tool).toBe(estimateTokens("列出目录\n文件清单"));
    // Every kind lands in exactly one bucket, and they sum to the total.
    expect(b.user + b.assistant + b.tool + b.thought).toBe(usage.totalTokens);
  });

  it("P0-6: the breakdown folds at the compression boundary too", () => {
    const state = initialSessionState();
    beginUserPrompt(state, "压缩前的历史问题");
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ type: "compression", compression: { isPending: false, originalTokenCount: 90000, newTokenCount: 7855, summary: "摘要" } }) } }));
    beginUserPrompt(state, "压缩后的新问题");
    refreshSessionUsage(state);
    // Pre-compression blocks are out of the fold window entirely.
    expect(state.usage!.breakdown!.user).toBe(estimateTokens("压缩后的新问题"));
    expect(state.usage!.breakdown!.assistant).toBe(0);
  });

  it("P0-6/P1-6: usageCtx stamps window, estimated flag and cost onto the estimate", () => {
    const state = initialSessionState();
    beginUserPrompt(state, "问题");
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "回答" } }));
    refreshSessionUsage(state, {
      contextWindow: 128_000,
      estimated: false,
      costPrice: { input: 2, output: 8 },
    });
    const usage = state.usage!;
    expect(usage.contextWindow).toBe(128_000);
    expect(usage.estimated).toBe(false);
    expect(usage.estimatedCost).toBe(
      (usage.inputTokens / 1_000_000) * 2 + (usage.outputTokens / 1_000_000) * 8,
    );
  });

  it("P1-6: a null price yields a null cost instead of a bogus zero", () => {
    const state = initialSessionState();
    beginUserPrompt(state, "问题");
    refreshSessionUsage(state, { contextWindow: 128_000, estimated: true, costPrice: null });
    expect(state.usage!.estimatedCost).toBeNull();
    expect(state.usage!.estimated).toBe(true);
  });

  it("P0-6/P1-6: a usageCtx change breaks reference stability and re-stamps", () => {
    const state = initialSessionState();
    beginUserPrompt(state, "问题");
    refreshSessionUsage(state, { contextWindow: 128_000, estimated: false, costPrice: null });
    const first = state.usage;
    // Same numbers, same ctx → the object is kept.
    refreshSessionUsage(state, { contextWindow: 128_000, estimated: false, costPrice: null });
    expect(state.usage).toBe(first);
    // Model switch (new window) → a fresh object, old numbers preserved.
    refreshSessionUsage(state, { contextWindow: 200_000, estimated: false, costPrice: null });
    expect(state.usage).not.toBe(first);
    expect(state.usage!.inputTokens).toBe(first!.inputTokens);
    expect(state.usage!.contextWindow).toBe(200_000);
  });

  it("P0-6: completePrompt threads the usage context through", () => {
    const state = initialSessionState();
    beginUserPrompt(state, "问题");
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "回答" } }));
    completePrompt(state, "end_of_turn", { contextWindow: 32_768, estimated: true, costPrice: null });
    expect(state.usage!.contextWindow).toBe(32_768);
    expect(state.usage!.estimated).toBe(true);
  });

  describe("authoritative occupancy overlay (P2-7 usage report)", () => {
    it("completePrompt overlays the reported occupancy and flags it authoritative", () => {
      const state = initialSessionState();
      beginUserPrompt(state, "问题");
      applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "回答" } }));
      completePrompt(state, "end_turn", null, { lastRequestInputTokens: 61_000 });
      const usage = state.usage!;
      expect(usage.contextUsed).toBe(61_000);
      expect(usage.usageAuthoritative).toBe(true);
      // The input/output SPLIT stays estimated (the wire carries no split).
      expect(usage.inputTokens).toBe(estimateTokens("问题"));
      expect(state.usageReport).toEqual({ lastRequestInputTokens: 61_000, atBlockCount: state.blocks.length });
    });

    it("without a report the numbers stay estimated (flag absent)", () => {
      const state = initialSessionState();
      beginUserPrompt(state, "问题");
      completePrompt(state, "end_turn", null, null);
      expect(state.usage!.usageAuthoritative).toBeUndefined();
      expect(state.usageReport ?? null).toBeNull();
    });

    it("a zero/negative report is ignored (gateway emitted nothing)", () => {
      const state = initialSessionState();
      beginUserPrompt(state, "问题");
      completePrompt(state, "end_turn", null, { lastRequestInputTokens: 0 });
      expect(state.usageReport ?? null).toBeNull();
      expect(state.usage!.usageAuthoritative).toBeUndefined();
    });

    it("the anchor survives a growing transcript (occupancy = report + delta)", () => {
      const state = initialSessionState();
      beginUserPrompt(state, "问题");
      completePrompt(state, "end_turn", null, { lastRequestInputTokens: 61_000 });
      expect(state.usage!.usageAuthoritative).toBe(true);
      // A new turn appends blocks: the reported number still describes the
      // model's context AT the anchor, and the appended blocks are the only
      // thing that context gained since (the CLI replays assistant parts, so
      // they genuinely re-enter the next request). Re-folding the whole
      // transcript instead would drop back to the transcript's own biased
      // total — the 2x mismatch against the provider's own fill meter.
      beginUserPrompt(state, "第二个问题");
      refreshSessionUsage(state);
      expect(state.usage!.contextUsed).toBe(61_000 + estimateTokens("第二个问题"));
      // Part of the number is now estimated (the streamed delta) → honest flag.
      expect(state.usage!.usageAuthoritative).toBe(false);
      // The next report lands and re-authorises the overlay.
      completePrompt(state, "end_turn", null, { lastRequestInputTokens: 62_000 });
      expect(state.usage!.contextUsed).toBe(62_000);
      expect(state.usage!.usageAuthoritative).toBe(true);
    });

    it("the reported completion replays into the next request (prefill term)", () => {
      const state = initialSessionState();
      beginUserPrompt(state, "问题");
      applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "回答" } }));
      completePrompt(state, "end_turn", null, { lastRequestInputTokens: 61_000, completionTokens: 4_300 });
      // promptTokenCount covers only the request's INPUT; the CLI appends the
      // generated text (thoughts included) to history, so the carried context
      // at turn end is prompt + completion — and the blocks carrying that text
      // sit inside the anchor, so the delta range must not add them again.
      expect(state.usage!.contextUsed).toBe(65_300);
      expect(state.usage!.usageAuthoritative).toBe(true);
      expect(state.usageReport!.completionTokens).toBe(4_300);
      expect(state.usageReport!.atBlockCount).toBe(state.blocks.length);
    });

    it("cache-read tokens surface as a split, never re-added to occupancy", () => {
      const state = initialSessionState();
      beginUserPrompt(state, "问题");
      completePrompt(state, "end_turn", null, { lastRequestInputTokens: 136_000, cachedReadTokens: 96_000 });
      const usage = state.usage!;
      // Gateway `prompt_tokens` ALREADY folds cache hits in (fork bundle
      // offset 3172990 maps it verbatim). Adding them again — the fork's own
      // saveUsageMetadata commits that error at offset 3166865 — is what makes
      // a 52% fill read as 100% and fire a spurious auto-compress.
      expect(usage.contextUsed).toBe(136_000);
      expect(usage.cacheReadTokens).toBe(96_000);
      expect(usage.usageAuthoritative).toBe(true);
    });

    it("a compression card after the report expires it (fold floor is the CLI's own number)", () => {
      const state = initialSessionState();
      beginUserPrompt(state, "问题");
      completePrompt(state, "end_turn", null, { lastRequestInputTokens: 61_000 });
      // The compression card is a new block → the atBlockCount anchor expires
      // the stale report; the fold's floor (newTokenCount) is itself CLI
      // authoritative, so the bar keeps trustworthy numbers.
      applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ type: "compression", compression: { isPending: false, originalTokenCount: 61_000, newTokenCount: 7_855, summary: "摘要" } }) } }));
      refreshSessionUsage(state);
      expect(state.usage!.usageAuthoritative).toBeUndefined();
      expect(state.usage!.contextUsed).toBe(7_855);
    });

    it("deleting a user message clears the report (CLI history truncates in lockstep)", () => {
      const state = initialSessionState();
      beginUserPrompt(state, "问题一");
      completePrompt(state, "end_turn", null, { lastRequestInputTokens: 61_000 });
      const userId = state.blocks.find((b) => b.kind === "user")!.id!;
      beginUserPrompt(state, "问题二");
      deleteUserMessageById(state, userId);
      expect(state.usageReport ?? null).toBeNull();
      expect(state.usage!.usageAuthoritative).toBeUndefined();
    });

    it("reference stability accounts for the overlay (report flip forces a new object)", () => {
      const state = initialSessionState();
      beginUserPrompt(state, "问题");
      refreshSessionUsage(state);
      const estimated = state.usage;
      completePrompt(state, "end_turn", null, { lastRequestInputTokens: 61_000 });
      expect(state.usage).not.toBe(estimated);
      // Re-refreshing with nothing changed keeps the SAME authoritative object.
      const reported = state.usage;
      refreshSessionUsage(state);
      expect(state.usage).toBe(reported);
    });
  });
});

describe("dropSessionUpdate guard (leak prevention)", () => {
  const base = { status: "streaming" as const, restoring: false, resetting: false };

  it("drops a foreign-session update on an active session", () => {
    expect(dropSessionUpdate({ ...base, sessionId: "OLD", storeSessionId: "NEW" })).toBe(true);
  });

  it("accepts an update addressed to the store's own session", () => {
    expect(dropSessionUpdate({ ...base, sessionId: "S1", storeSessionId: "S1" })).toBe(false);
  });

  it("drops EVERYTHING foreign during the reset window — including sessionId-less updates", () => {
    // Store sessionId is null while 新会话 runs; the abandoned turn's
    // stragglers (with or without a sessionId) must all drop.
    expect(dropSessionUpdate({ ...base, resetting: true, sessionId: "OLD", storeSessionId: null })).toBe(true);
    expect(dropSessionUpdate({ ...base, resetting: true, sessionId: null, storeSessionId: null })).toBe(true);
  });

  it("accepts an own-session update during the reset window (late sessionStarted tail)", () => {
    expect(dropSessionUpdate({ ...base, resetting: true, sessionId: "NEW", storeSessionId: "NEW" })).toBe(false);
  });

  it("drops sessionId-less updates unless a turn is verifiably in flight on the own session", () => {
    // In-flight on the own session: accept (defensive CLI omitting sessionId).
    expect(dropSessionUpdate({ ...base, sessionId: null, storeSessionId: "S1", status: "streaming" })).toBe(false);
    // Idle session (turn already settled): stragglers drop.
    expect(dropSessionUpdate({ ...base, sessionId: null, storeSessionId: "S1", status: "idle" })).toBe(true);
    // Fresh session never started: drop.
    expect(dropSessionUpdate({ ...base, sessionId: null, storeSessionId: null, status: "streaming" })).toBe(true);
  });

  it("restore window: replayed updates for the RESTORED session pass; foreign ones drop", () => {
    // Replayed updates tagged with the restored session's id pass.
    expect(dropSessionUpdate({ ...base, restoring: true, sessionId: "LOADED", storeSessionId: null, status: "streaming", restoringSessionId: "LOADED" })).toBe(false);
    // Untagged replayed turns pass.
    expect(dropSessionUpdate({ ...base, restoring: true, sessionId: null, storeSessionId: null, status: "streaming", restoringSessionId: "LOADED" })).toBe(false);
    // An abandoned turn still streaming on a FOREIGN session must not ride
    // the restoring exemption into the restored transcript.
    expect(dropSessionUpdate({ ...base, restoring: true, sessionId: "ABANDONED", storeSessionId: null, status: "streaming", restoringSessionId: "LOADED" })).toBe(true);
  });

  it("SubAgent adapter events (sentinel sessionId + agentId) pass only while the own turn streams", () => {
    // CLI 0.5.19 pushes nested subagent activity from a separate adapter with
    // the hard-coded sessionId "default-session" and agentId on the update.
    // Regression guard: the 2026-09-11 cross-session rule dropped ALL of them
    // (subagent cards lost their progress).
    const sub = { sessionId: "default-session", agentId: "agent-1" };
    // Own session streaming → the nested events belong to this turn.
    expect(dropSessionUpdate({ ...base, ...sub, storeSessionId: "S1", status: "streaming" })).toBe(false);
    // Idle own session → stragglers from an abandoned turn drop.
    expect(dropSessionUpdate({ ...base, ...sub, storeSessionId: "S1", status: "idle" })).toBe(true);
    // No session at all → drop.
    expect(dropSessionUpdate({ ...base, ...sub, storeSessionId: null, status: "streaming" })).toBe(true);
    // Reset window → drop (the sentinel never equals the store's id).
    expect(dropSessionUpdate({ ...base, ...sub, resetting: true, storeSessionId: null, status: "streaming" })).toBe(true);
    // Restore window → drop (replay never streams a live subagent).
    expect(dropSessionUpdate({ ...base, ...sub, restoring: true, storeSessionId: null, status: "streaming", restoringSessionId: "LOADED" })).toBe(true);
    // An agentId event addressed to the OWN session (a future CLI stamping
    // the real id) is attributable by sessionId alone — no streaming gate.
    expect(dropSessionUpdate({ ...base, sessionId: "S1", agentId: "agent-1", storeSessionId: "S1", status: "idle" })).toBe(false);
  });
});

describe("block id uniqueness across host reloads (P4)", () => {
  it("seeds and increments beyond Number precision without repeating ids", () => {
    // 36^14 is well beyond Number.MAX_SAFE_INTEGER; increments must stay exact.
    const restored: Block[] = [{ kind: "text", text: "old", id: "b100000000000000" }];
    backfillBlockIds(restored);
    expect(nextBlockId()).toBe("b100000000000001");
    expect(nextBlockId()).toBe("b100000000000002");
  });

  it("backfillBlockIds seeds the counter past restored ids — no duplicate minting", () => {
    // Transcript persisted by a PREVIOUS extension-host lifetime: ids up to
    // b4t (the 404-duplicate-id corruption measured in a real transcript).
    const restored: Block[] = [
      { kind: "user", text: "旧消息", id: "b4s" },
      { kind: "text", text: "旧回复", id: "b4t" },
    ];
    backfillBlockIds(restored);
    // The counter is now seeded past b4t — the next minted id must NOT
    // collide with any restored id (the module counter restarts at 0 on
    // every host reload; without the seed it would mint b1, colliding).
    const fresh = nextBlockId();
    const restoredIds = new Set(restored.map((b) => b.id));
    expect(restoredIds.has(fresh)).toBe(false);
    // And subsequent ids keep growing past the seeded value.
    const next = nextBlockId();
    expect(next).not.toBe(fresh);
    expect(restoredIds.has(next)).toBe(false);
  });

  it("backfillBlockIds assigns ids to legacy blocks and keeps the counter monotonic", () => {
    const legacy: Block[] = [{ kind: "text", text: "无 id 的旧块" }];
    backfillBlockIds(legacy);
    expect(legacy[0]!.id).toBeDefined();
    const after = nextBlockId();
    expect(after).not.toBe(legacy[0]!.id);
  });

  it("restores ALL ids before minting (subagent entries seeded too)", () => {
    const deep: Block[] = [
      { kind: "text", text: "a", id: "bzz" }, // high id on the top level
      { kind: "subagent", agentId: "a1", taskToolCallId: null, title: "", status: "completed", agentType: null, entries: [{ kind: "text", text: "nested", id: "b9z" }] },
    ];
    backfillBlockIds(deep);
    const minted = nextBlockId();
    // bzz parses higher than b9z; the counter must be past the max seen.
    expect(parseInt(minted.slice(1), 36)).toBeGreaterThan(parseInt("bzz".slice(1), 36));
  });

  it("reassignBlockIds re-mints every restored id — a restored session shares NOTHING with the live namespace", () => {
    // Restored transcript with ids from a previous host lifetime (the 404-
    // duplicate-id corruption shape: restored blocks up to b4t).
    const restored: Block[] = [
      { kind: "user", text: "旧消息", id: "b1" },
      { kind: "text", text: "旧回复", id: "b2" },
      { kind: "subagent", agentId: "a1", taskToolCallId: null, title: "", status: "completed", agentType: null, entries: [{ kind: "text", text: "nested", id: "b3" }] },
    ];
    const originalIds = ["b1", "b2", "b3"];
    // Seed the counter past the originals first (backfillBlockIds's job),
    // then re-mint — each block gets a FRESH id from this host's counter.
    backfillBlockIds(restored);
    reassignBlockIds(restored);
    const seen = new Set<string>();
    const walk = (bs: Block[]): void => {
      for (const b of bs) {
        expect(b.id).toBeDefined();
        // No restored id survives the re-mint — the live namespace is clean.
        expect(originalIds).not.toContain(b.id);
        expect(seen.has(b.id!)).toBe(false); // mutually unique
        seen.add(b.id!);
        if (b.kind === "subagent") walk(b.entries);
      }
    };
    walk(restored);
    // And live minting after the restore can never collide either.
    const live = nextBlockId();
    expect(seen.has(live)).toBe(false);
  });
});

describe("deleteUserMessageById (truncate transcript at a user turn)", () => {
  function seeded(): SessionState {
    const state = initialSessionState();
    beginUserPrompt(state, "第一条");
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "回复一" } }));
    beginUserPrompt(state, "第二条");
    applySessionUpdate(state, notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "回复二" } }));
    return state;
  }

  it("removes the user block AND everything after it, returning the index", () => {
    const state = seeded();
    const firstUser = state.blocks.find((b) => b.kind === "user" && b.text === "第一条")!;
    const before = state.blocks.length;
    const index = deleteUserMessageById(state, firstUser.id!);
    expect(index).toBe(0);
    // Everything from the deleted turn on is gone — no orphaned reply.
    expect(state.blocks).toHaveLength(0);
    expect(state.blocks.length).toBeLessThan(before);
  });

  it("keeps earlier turns when deleting a later message", () => {
    const state = seeded();
    const secondUser = state.blocks.find((b) => b.kind === "user" && b.text === "第二条")!;
    const index = deleteUserMessageById(state, secondUser.id!);
    expect(index).toBeGreaterThan(0);
    // The first turn (user + reply) survives untouched.
    expect(state.blocks.map((b) => b.kind)).toEqual(["user", "text"]);
    expect((state.blocks[0] as { text: string }).text).toBe("第一条");
  });

  it("recomputes the usage estimate after the deletion", () => {
    const state = seeded();
    refreshSessionUsage(state);
    const before = state.usage!.inputTokens;
    expect(before).toBeGreaterThan(0);
    const firstUser = state.blocks.find((b) => b.kind === "user")!;
    deleteUserMessageById(state, firstUser.id!);
    // Deleting every turn drops the input estimate to the emptied baseline.
    expect(state.usage!.inputTokens).toBeLessThan(before);
  });

  it("returns null for a non-user block id or an unknown id", () => {
    const state = seeded();
    const textBlock = state.blocks.find((b) => b.kind === "text")!;
    expect(deleteUserMessageById(state, textBlock.id!)).toBeNull();
    expect(deleteUserMessageById(state, "no-such-id")).toBeNull();
    // Untouched on a miss.
    expect(state.blocks.length).toBeGreaterThan(0);
  });
});

describe("findCliHistoryCut (locate a turn inside the CLI chatHistory)", () => {
  const user = (text: string) => ({ role: "user", parts: [{ text }] });
  const model = (text: string) => ({ role: "model", parts: [{ text }] });
  const toolResp = (name: string) => ({ role: "user", parts: [{ functionResponse: { name, response: {} } }] });
  const injected = (text: string) => user(text);
  const truncate = (index: number) => ({ kind: "truncate" as const, index });

  it("truncates at the target's exact text-only entry", () => {
    const history = [user("第一条"), model("回复"), user("第二条"), model("回复二")];
    expect(findCliHistoryCut(history, ["第一条", "第二条"], 1)).toEqual(truncate(2));
    expect(findCliHistoryCut(history, ["第一条", "第二条"], 0)).toEqual(truncate(0));
  });

  it("matches by prefix (agent-side text carries an attachment block the transcript lacks)", () => {
    const history = [user("看这个文件\n\n用户附带以下本地文件（可按需读取）：\n- a.ts → /p/a.ts")];
    expect(findCliHistoryCut(history, ["看这个文件"], 0)).toEqual(truncate(0));
  });

  it("disambiguates identical prompts by occurrence", () => {
    const history = [user("hi"), model("a"), user("hi"), model("b")];
    expect(findCliHistoryCut(history, ["hi", "hi"], 0)).toEqual(truncate(0));
    expect(findCliHistoryCut(history, ["hi", "hi"], 1)).toEqual(truncate(2));
  });

  it("ignores CLI-injected turns (Please continue. / compression summary)", () => {
    // The next-speaker loop and auto-compression inject role:"user" entries
    // with foreign text; occurrence matching must walk past them.
    const history = [
      user("原始提问"),
      model("答"),
      injected("Please continue."),
      model("续答"),
      user("第二个提问"),
    ];
    expect(findCliHistoryCut(history, ["原始提问", "第二个提问"], 1)).toEqual(truncate(4));
  });

  it("keeps exact and attachment-prefix occurrences in one chronological pool", () => {
    const history = [
      user("hi\n\n用户附带以下本地文件（可按需读取）：\n- a.ts → /p/a.ts"),
      model("x"),
      user("hi"),
    ];
    expect(findCliHistoryCut(history, ["hi", "hi"], 0)).toEqual(truncate(0));
    expect(findCliHistoryCut(history, ["hi", "hi"], 1)).toEqual(truncate(2));
  });

  it("never matches a prompt that is only a prefix of the CLI turn (attachment block shape required)", () => {
    const history = [user("部署服务并检查日志")];
    // "部署服务" is a bare prefix without the attachment block — not a match.
    expect(findCliHistoryCut(history, ["部署服务"], 0)).toEqual({ kind: "skip" });
  });

  it("strips whole system-reminder parts before matching", () => {
    const history = [
      { role: "user", parts: [{ text: "<system-reminder>context</system-reminder>" }, { text: "真正的提问" }] },
    ];
    expect(findCliHistoryCut(history, ["真正的提问"], 0)).toEqual(truncate(0));
  });

  it("never matches a tool-response entry (role user but functionResponse parts)", () => {
    const history = [toolResp("read_file"), model("x")];
    expect(findCliHistoryCut(history, ["read_file"], 0)).toEqual({ kind: "skip" });
  });

  it("keeps the typed text of an image turn (inlineData part ignored)", () => {
    const history = [
      { role: "user", parts: [{ text: "看这个截图" }, { inlineData: { data: "AAA", mimeType: "image/png" } }] },
      model("看到了"),
    ];
    expect(findCliHistoryCut(history, ["看这个截图"], 0)).toEqual(truncate(0));
  });

  it("cuts at the first surviving successor when the target was compressed away", () => {
    // CLI compressed its head into a summary entry: the target prompt is gone
    // but its successor remains — cutting at the successor drops the whole tail.
    const history = [
      injected("This session is being continued from a previous conversation that ran out of context. ..."),
      model("..."),
      user("幸存的后续提问"),
    ];
    expect(findCliHistoryCut(history, ["被压缩的原始提问", "幸存的后续提问"], 0)).toEqual(truncate(2));
  });

  it("skips (transcript-only delete) when nothing of the tail remains in the CLI", () => {
    const history = [model("这是压缩后的摘要，原文已不在上下文中。")];
    expect(findCliHistoryCut(history, ["很久以前被压缩掉的原始提问"], 0)).toEqual({ kind: "skip" });
  });

  it("skips for a slash command the CLI never recorded", () => {
    const history = [user("真正的提问"), model("答")];
    // /compress rides the transcript but never reaches chatHistory.
    expect(findCliHistoryCut(history, ["真正的提问", "/compress"], 1)).toEqual({ kind: "skip" });
  });

  it("refuses to guess when an earlier surviving turn sits after the anchor", () => {
    // Compression remap: transcript [X, Y] but the CLI only kept one "X" that
    // occurrence-maps behind Y's own surviving copy — cutting there would eat
    // Y's successor context... the safety net must refuse the cut instead.
    const history = [user("甲"), model("a"), user("乙"), model("b")];
    // Deleting "甲" with a transcript whose later copy of "甲" maps AFTER "乙"
    // (history below) would cut into kept context → skip.
    const remap = [user("乙"), model("b"), user("甲")];
    expect(findCliHistoryCut(remap, ["甲", "乙", "甲"], 0)).toEqual({ kind: "skip" });
    // Sanity: the same history with an aligned transcript truncates fine.
    expect(findCliHistoryCut(remap, ["乙", "甲"], 1)).toEqual(truncate(2));
  });

  it("returns skip for a non-array history and refuses on empty prompt text", () => {
    expect(findCliHistoryCut(undefined, ["x"], 0)).toEqual({ kind: "skip" });
    expect(findCliHistoryCut({ not: "an array" }, ["x"], 0)).toEqual({ kind: "skip" });
    expect(findCliHistoryCut([user("x")], ["   "], 0)).toEqual({ kind: "refuse", reason: "empty" });
  });

  it("matches the zero-width-escaped form the CLI persisted", () => {
    // toAgentPromptText prefixes U+200B to non-command "/" input; the CLI
    // stores the escaped text, the transcript block carries the same escape.
    const history = [user("\u200B/foo not a command")];
    expect(findCliHistoryCut(history, ["\u200B/foo not a command"], 0)).toEqual(truncate(0));
  });
});

describe("normalizeUserPromptText & collectUserPromptTexts", () => {
  it("strips the zero-width escape and the attachment note lines", () => {
    expect(normalizeUserPromptText("\u200B/foo bar")).toBe("/foo bar");
    expect(normalizeUserPromptText("看这个\n（文件：a.ts → /p/a.ts）\n（文件：b.ts → /p/b.ts）")).toBe("看这个");
  });

  it("collects user prompts oldest→newest, deduped keeping the last, notes stripped", () => {
    const state = initialSessionState();
    beginUserPrompt(state, "第一条");
    beginUserPrompt(state, "重复");
    beginUserPrompt(state, "第二条");
    beginUserPrompt(state, "重复");
    const texts = collectUserPromptTexts(state.blocks);
    // Dedup keeps the LAST occurrence → "重复" sits at its newest position.
    expect(texts).toEqual(["第一条", "第二条", "重复"]);
  });

  it("drops attachment-only prompts down to their typed text and skips blanks", () => {
    const state = initialSessionState();
    beginUserPrompt(state, "看文件", undefined, [{ name: "a.ts", path: "/p/a.ts" }]);
    const texts = collectUserPromptTexts(state.blocks);
    expect(texts).toEqual(["看文件"]);
  });
});

describe("isAgentOutputUpdate (empty-response detection)", () => {
  it("counts visible agent output: text, thought, tool call, tool update, plan", () => {
    expect(isAgentOutputUpdate({ sessionUpdate: "agent_message_chunk" })).toBe(true);
    expect(isAgentOutputUpdate({ sessionUpdate: "agent_thought_chunk" })).toBe(true);
    expect(isAgentOutputUpdate({ sessionUpdate: "tool_call" })).toBe(true);
    expect(isAgentOutputUpdate({ sessionUpdate: "tool_call_update" })).toBe(true);
    expect(isAgentOutputUpdate({ sessionUpdate: "plan" })).toBe(true);
  });

  it("metadata-only and user-echo updates are NOT output", () => {
    // available_commands_update / current_mode_update fire on session/new and
    // mode switches — an empty-response turn can still emit them, so counting
    // them would mask the failure the gate exists to catch.
    expect(isAgentOutputUpdate({ sessionUpdate: "available_commands_update" })).toBe(false);
    expect(isAgentOutputUpdate({ sessionUpdate: "current_mode_update" })).toBe(false);
    // The user's own turn echoed by the agent (live prompts render from the
    // host's beginUserPrompt block; replay uses this channel).
    expect(isAgentOutputUpdate({ sessionUpdate: "user_message_chunk" })).toBe(false);
  });
});

describe("evictBlockPayloads (webview long-session memory bound)", () => {
  const tool = (id: string): ToolBlock => ({
    kind: "tool",
    id,
    toolCallId: id,
    toolName: "edit_file",
    title: "Edit",
    toolKind: "edit",
    status: "completed",
    output: "some output",
    locations: [],
    diff: { path: "p.ts", oldText: "a", newText: "b" },
  });

  it("releases heavy payloads of blocks outside the keep window and marks them", () => {
    const blocks: Block[] = [tool("old"), tool("new")];
    const out = evictBlockPayloads(blocks, 1);
    const evicted = out[0] as ToolBlock;
    expect(evicted.evicted).toBe(true);
    expect(evicted.output).toBe("");
    expect(evicted.diff).toBeNull();
    expect(evicted.truncatedChars).toBeUndefined();
    // Identity markers survive — revert chips still render on evicted cards.
    expect(evicted.toolCallId).toBe("old");
    // The kept tail is untouched, same reference.
    expect(out[1]).toBe(blocks[1]);
  });

  it("keeps user text / plan / text blocks and the whole list when within the window", () => {
    const blocks: Block[] = [
      { kind: "user", id: "u1", text: "prompt", images: ["data:image/png;base64,AAA"] },
      { kind: "text", id: "t1", text: "reply" },
    ];
    // keepRecent covers everything → identity-stable, nothing evicted.
    expect(evictBlockPayloads(blocks, 5)).toBe(blocks);
    const out = evictBlockPayloads(blocks, 1);
    const user = out[0] as Extract<Block, { kind: "user" }>;
    expect(user.evicted).toBe(true);
    expect(user.images).toBeUndefined();
    // The typed prompt itself is never released (delete/regenerate scans).
    expect(user.text).toBe("prompt");
    expect(out[1]).toBe(blocks[1]);
  });

  it("evicts thought text and compression summaries", () => {
    const blocks: Block[] = [
      { kind: "thought", id: "th", text: "reasoning…" },
      { kind: "compression", id: "c", notice: "已压缩", summary: "long summary", newTokenCount: 10 },
      { kind: "text", id: "tail", text: "x" },
    ];
    const out = evictBlockPayloads(blocks, 1);
    const thought = out[0] as Extract<Block, { kind: "thought" }>;
    const comp = out[1] as Extract<Block, { kind: "compression" }>;
    expect(thought.text).toBe("");
    expect(thought.evicted).toBe(true);
    expect(comp.summary).toBeNull();
    expect(comp.evicted).toBe(true);
    // The one-line notice carries the compression numbers — never released.
    expect(comp.notice).toBe("已压缩");
  });

  it("recurses into subagent entries", () => {
    const blocks: Block[] = [
      {
        kind: "subagent",
        id: "sa",
        agentId: "a1",
        taskToolCallId: null,
        title: "task",
        status: "completed",
        agentType: null,
        entries: [tool("nested"), { kind: "thought", id: "nth", text: "deep" }],
      },
      { kind: "text", id: "tail", text: "x" },
    ];
    const out = evictBlockPayloads(blocks, 1);
    const card = out[0] as Extract<Block, { kind: "subagent" }>;
    const nestedTool = card.entries[0] as ToolBlock;
    const nestedThought = card.entries[1] as Extract<Block, { kind: "thought" }>;
    expect(nestedTool.output).toBe("");
    expect(nestedTool.diff).toBeNull();
    expect(nestedTool.evicted).toBe(true);
    expect(nestedThought.text).toBe("");
  });

  it("is idempotent: a second pass returns the same array and block references", () => {
    const blocks: Block[] = [tool("old"), tool("new")];
    const once = evictBlockPayloads(blocks, 1);
    const twice = evictBlockPayloads(once, 1);
    expect(twice).toBe(once);
    expect(twice[0]).toBe(once[0]);
  });

  const heavy = (id: string, chars: number): ToolBlock => ({
    ...tool(id),
    output: "x".repeat(chars),
    diff: null,
  });

  it("cuts the keep window by char budget on heavy-block sessions", () => {
    // The probed bloat shape: few blocks, monster payloads — a pure block
    // count would keep all of it (249 blocks / 23.4MB session, 2026-10).
    const blocks: Block[] = Array.from({ length: 60 }, (_, i) => heavy(`t${i}`, 100_000));
    const out = evictBlockPayloads(blocks, 200);
    // 4M budget / 100K per block = 40 kept, the older 20 released.
    expect(out.filter((b) => (b as ToolBlock).evicted)).toHaveLength(20);
    expect((out[19] as ToolBlock).evicted).toBe(true);
    expect((out[20] as ToolBlock).evicted).toBeUndefined();
    expect((out[20] as ToolBlock).output).toBe("x".repeat(100_000));
    const keptPayload = out
      .slice(20)
      .reduce((sum, b) => sum + payloadChars(b), 0);
    expect(keptPayload).toBeLessThanOrEqual(EVICT_BUDGET_CHARS);
  });

  it("floors the keep window at minKeep even when monster blocks blow the budget", () => {
    const blocks: Block[] = Array.from({ length: 30 }, (_, i) => heavy(`m${i}`, 1_000_000));
    const out = evictBlockPayloads(blocks, 200);
    // Budget would keep ~4, the floor keeps the 20 newest turns renderable.
    expect(out.filter((b) => (b as ToolBlock).evicted)).toHaveLength(10);
    expect((out[9] as ToolBlock).evicted).toBe(true);
    expect((out[10] as ToolBlock).evicted).toBeUndefined();
    // The floor is a parameter, not a magic number.
    const tight = evictBlockPayloads(blocks, 200, EVICT_BUDGET_CHARS, 5);
    expect(tight.filter((b) => (b as ToolBlock).evicted)).toHaveLength(25);
  });

  it("keeps the full block-count window when payloads are light", () => {
    const blocks: Block[] = Array.from({ length: 250 }, (_, i) => tool(`l${i}`));
    const out = evictBlockPayloads(blocks, 200);
    expect(out.filter((b) => (b as ToolBlock).evicted)).toHaveLength(50);
    expect((out[49] as ToolBlock).evicted).toBe(true);
    expect((out[50] as ToolBlock).evicted).toBeUndefined();
  });

  it("payloadChars measures exactly what eviction releases", () => {
    expect(payloadChars(tool("t"))).toBe("some output".length + 2);
    expect(payloadChars({ kind: "thought", id: "th", text: "abc" })).toBe(3);
    expect(payloadChars({ kind: "user", id: "u", text: "p", images: ["abcd", "ef"] })).toBe(6);
    expect(
      payloadChars({ kind: "compression", id: "c", notice: "n", summary: "sum", newTokenCount: 1 }),
    ).toBe(3);
    expect(payloadChars({ kind: "text", id: "x", text: "never released" })).toBe(0);
    expect(
      payloadChars({
        kind: "subagent",
        id: "sa",
        agentId: null,
        taskToolCallId: null,
        title: "t",
        status: "completed",
        agentType: null,
        entries: [tool("n"), { kind: "thought", id: "nt", text: "deep" }],
      }),
    ).toBe("some output".length + 2 + 4);
  });

  it("releases injected-context bodies and counts them in the budget", () => {
    const blocks: Block[] = [
      {
        kind: "injected",
        id: "inj",
        notice: "n",
        tokens: 123,
        items: [
          { kind: "system", label: "系统提示词", content: "sys prompt body" },
          { kind: "context-file", label: "AGENTS.md", path: "/w/AGENTS.md", content: "file body" },
        ],
      },
      tool("keep"),
    ];
    expect(payloadChars(blocks[0]!)).toBe("sys prompt body".length + "file body".length);
    const out = evictBlockPayloads(blocks, 1);
    const inj = out[0] as Extract<Block, { kind: "injected" }>;
    expect(inj.evicted).toBe(true);
    expect(inj.items.every((i) => i.content === "")).toBe(true);
    // The token chip on the collapsed header survives body eviction.
    expect(inj.tokens).toBe(123);
    // Identity survives eviction: labels/paths keep the card readable.
    expect(inj.items[0]!.label).toBe("系统提示词");
    expect(inj.items[1]!.path).toBe("/w/AGENTS.md");
    expect(inj.notice).toBe("n");
    // Idempotent: a second pass finds nothing to release.
    expect(evictBlockPayloads(out, 1)).toBe(out);
  });
});

describe("appendInjectedContext (auto-injected context card)", () => {
  const items = () => [
    { kind: "system" as const, label: "系统提示词", content: "full system prompt" },
    { kind: "memory" as const, label: "记忆", content: "joined memory" },
    { kind: "context-file" as const, label: "AGENTS.md", path: "/w/AGENTS.md", content: "# rules" },
  ];

  it("inserts BEFORE the first user block (the card reads as pre-request context)", () => {
    const state = initialSessionState();
    beginUserPrompt(state, "hello");
    const index = appendInjectedContext(state, items());
    expect(state.blocks.map((b) => b.kind)).toEqual(["injected", "user"]);
    expect(index).toBe(0);
  });

  it("appends when no user block exists yet", () => {
    const state = initialSessionState();
    const index = appendInjectedContext(state, items());
    expect(state.blocks).toHaveLength(1);
    expect(index).toBe(0);
  });

  it("composes the notice from the item kinds and mints a stable id", () => {
    const state = initialSessionState();
    appendInjectedContext(state, items());
    const block = state.blocks[0] as Extract<Block, { kind: "injected" }>;
    expect(block.id).toBeTruthy();
    expect(block.notice).toContain("3");
    expect(block.notice).toContain("系统提示词");
    expect(block.notice).toContain("记忆");
    expect(block.notice).toContain("1 个上下文文件");
    expect(block.tokens).toBe(
      estimateTokens("full system prompt") + estimateTokens("joined memory") + estimateTokens("# rules"),
    );
  });

  it("excludes injected bodies from the transcript token estimate", () => {
    const state = initialSessionState();
    appendInjectedContext(state, items());
    beginUserPrompt(state, "hi");
    const usage = estimateSessionUsage(state.blocks);
    // Only the user turn counts; the injected system prompt/memory do not.
    expect(usage.inputTokens).toBe(estimateTokens("hi"));
  });

  it("is idempotent: a second call skips when a card already exists", () => {
    const state = initialSessionState();
    appendInjectedContext(state, items());
    expect(appendInjectedContext(state, items())).toBeNull();
    expect(state.blocks.filter((b) => b.kind === "injected")).toHaveLength(1);
  });

  it("does not duplicate the card after deleting the first user message and re-sending", () => {
    // The card lives BEFORE the first user block; deleteUserMessageById
    // truncates FROM the user block, so the card survives while the user
    // blocks vanish — the re-send must not insert a second card (user-reported
    // duplicate injection cards).
    const state = initialSessionState();
    appendInjectedContext(state, items());
    beginUserPrompt(state, "first");
    deleteUserMessageById(state, (state.blocks[1] as { id: string }).id);
    beginUserPrompt(state, "second");
    expect(appendInjectedContext(state, items())).toBeNull();
    expect(state.blocks.map((b) => b.kind)).toEqual(["injected", "user"]);
  });
});

describe("splitSystemPromptSections (injected card visual segments)", () => {
  // Wire format proven from the CLI 0.5.19 bundle: P0e joins core and memory
  // with "\n\n---\n\n"; the memory joiner Gva emits "\r\n"-delimited blocks.
  const prompt = [
    "You are iFlow CLI...",
    "",
    "---",
    "",
    "global memory body",
    "",
    "--- Context from: AGENTS.md ---\r\n# repo rules\r\nmore rules\r\n--- End of Context from: AGENTS.md ---",
    "",
    "--- Context from: docs/IFLOW.md ---\r\nnested doc\r\n--- End of Context from: docs/IFLOW.md ---",
  ].join("\n");

  it("splits core, global memory and each context file", () => {
    const sections = splitSystemPromptSections(prompt);
    expect(sections.map((s) => s.kind)).toEqual(["core", "memory", "context-file", "context-file"]);
    expect(sections[0]!.content).toBe("You are iFlow CLI...");
    expect(sections[1]!.content).toBe("global memory body");
    expect(sections[2]).toMatchObject({ path: "AGENTS.md", content: "# repo rules\r\nmore rules" });
    expect(sections[3]).toMatchObject({ path: "docs/IFLOW.md", content: "nested doc" });
  });

  it("omits the memory segment when the prompt has no global memory", () => {
    const noMemory = "core\n\n---\n\n--- Context from: A.md ---\nbody\n--- End of Context from: A.md ---";
    expect(splitSystemPromptSections(noMemory).map((s) => s.kind)).toEqual(["core", "context-file"]);
  });

  it("returns a single core segment for marker-free bodies", () => {
    expect(splitSystemPromptSections("plain fallback text")).toEqual([
      { kind: "core", path: "", content: "plain fallback text" },
    ]);
  });

  it("extractCorePrompt strips memory markers and context-file bodies", () => {
    expect(extractCorePrompt(prompt)).toBe("You are iFlow CLI...");
    expect(extractCorePrompt("plain fallback text")).toBe("plain fallback text");
  });
});

describe("beginCompressTurn / endCompressTurn (silent /compress bridge turns)", () => {
  it("streams the session + stamps compressing without touching blocks", () => {
    const state: SessionState = initialSessionState();
    const blocksBefore = state.blocks;
    beginCompressTurn(state);
    expect(state.status).toBe("streaming");
    expect(state.compressing).toBe(true);
    expect(state.stopReason).toBeNull();
    expect(state.errorMessage).toBeNull();
    expect(state.blocks).toBe(blocksBefore);
  });

  it("endCompressTurn only closes a still-streaming session", () => {
    const state: SessionState = initialSessionState();
    beginCompressTurn(state);
    endCompressTurn(state);
    expect(state.status).toBe("idle");
    // An errored/replaced state is never stomped back to idle.
    const errored: SessionState = initialSessionState();
    errored.status = "error";
    endCompressTurn(errored);
    expect(errored.status).toBe("error");
  });
});
