import { describe, it, expect } from "vitest";
import {
  applySessionUpdate,
  attachSynthesizedDiff,
  findToolBlockById,
  markToolHunkDecisions,
  parseEditArgs,
  setMeta,
  synthesizeEditDiff,
} from "../shared/session-state.js";
import {
  initialSessionState,
  type SessionState,
  type SubAgentBlock,
  type ToolBlock,
} from "../shared/messages.js";

function tool(toolCallId: string): ToolBlock {
  return {
    kind: "tool",
    toolCallId,
    toolName: "edit_block",
    title: toolCallId,
    toolKind: "other",
    status: "completed",
    output: "ok",
    diff: null,
    locations: [],
  };
}

function subagent(agentId: string, entries: SubAgentBlock["entries"] = []): SubAgentBlock {
  return {
    kind: "subagent",
    id: `b-${agentId}`,
    agentId,
    taskToolCallId: null,
    title: agentId,
    status: "in_progress",
    agentType: null,
    entries,
  };
}

describe("稳定性回归 #2：深层孙代理工具块的合成 diff 可附加", () => {
  it("attachSynthesizedDiff 递归命中两层孙代理并返回顶层索引", () => {
    const state = initialSessionState();
    const deep = tool("deep-edit");
    // top-level card → child card → grandchild card → tool (MCP-derived)
    state.blocks = [subagent("parent", [subagent("child", [subagent("grandchild", [deep])])])];

    const diff = { path: "/deep.ts", oldText: "old", newText: "new" };
    expect(attachSynthesizedDiff(state, "deep-edit", diff)).toBe(0);
    expect(deep.diff).toEqual(diff);
    expect(findToolBlockById(state.blocks, "deep-edit")?.diff).toEqual(diff);
    // wire/first-synthesis wins at depth as well
    expect(attachSynthesizedDiff(state, "deep-edit", { path: "second", oldText: "x", newText: "y" })).toBeNull();
    expect(deep.diff?.path).toBe("/deep.ts");
  });

  it("markToolHunkDecisions 与 diff 走同一递归定位，深层工具不再漏回填", () => {
    const state = initialSessionState();
    const deep = tool("deep-hunk");
    state.blocks = [subagent("parent", [subagent("child", [subagent("grandchild", [deep])])])];
    expect(markToolHunkDecisions(state, "deep-hunk", [true, false], true)).toBe(0);
    expect(deep.hunkDecisions).toEqual([true, false]);
    expect(deep.partiallyReverted).toBe(true);
  });
});

describe("稳定性回归 #3：批量编辑逐项 expected_replacements / replace_all", () => {
  it("批量项携带 expected_replacements>1 时仍能合成 diff", () => {
    const parsed = parseEditArgs({
      path: "/a.ts",
      edits: [{ old_text: "x", new_text: "y", expected_replacements: 2 }],
    })!;
    expect(parsed.edits[0]!.expectedReplacements).toBe(2);
    const diff = synthesizeEditDiff(parsed, "y and y\n")!;
    expect(diff).not.toBeNull();
    expect(diff.oldText).toBe("x and x\n");
    // 精确计数不符仍然拒绝合成（不放松安全门槛）
    expect(synthesizeEditDiff(parsed, "match y\n")).toBeNull();
  });

  it("replace_all 在批量项与顶层都映射为跳过精确计数", () => {
    const batch = parseEditArgs({
      path: "/a.ts",
      edits: [{ old_text: "x", new_text: "y", replace_all: true }],
    })!;
    expect(batch.edits[0]!.expectedReplacements).toBe(Number.POSITIVE_INFINITY);
    expect(synthesizeEditDiff(batch, "y y y\n")!.oldText).toBe("x x x\n");
    // 找不到锚点时仍拒绝，避免伪造 diff
    expect(synthesizeEditDiff(batch, "nothing here\n")).toBeNull();

    const single = parseEditArgs({ path: "/a.ts", old_string: "x", new_string: "y", replace_all: true })!;
    expect(single.edits[0]!.expectedReplacements).toBe(Number.POSITIVE_INFINITY);
    expect(synthesizeEditDiff(single, "y/y/y\n")!.oldText).toBe("x/x/x\n");
  });
});

describe("稳定性回归 #5：先于 _meta.modes 到达的模式变更不丢失", () => {
  it("pendingModeId 在 setMeta 后覆盖旧 currentModeId", () => {
    const state = initialSessionState();
    applySessionUpdate(state, { sessionId: "s1", update: { sessionUpdate: "current_mode_update", currentModeId: "yolo" } });
    expect(state.modes).toBeNull();
    expect(state.pendingModeId).toBe("yolo");

    setMeta(state, {
      modes: {
        currentModeId: "default",
        availableModes: [{ id: "default", name: "Default" }, { id: "yolo", name: "YOLO" }],
      },
    });
    expect(state.modes?.currentModeId).toBe("yolo");
    expect(state.pendingModeId).toBeNull();
  });

  it("已应用的内联模式变更清除 pending，后续 setMeta 不再回填旧值", () => {
    const state: SessionState = initialSessionState();
    applySessionUpdate(state, { sessionId: "s1", update: { sessionUpdate: "current_mode_update", currentModeId: "yolo" } });
    setMeta(state, {
      modes: {
        currentModeId: "default",
        availableModes: [{ id: "default", name: "Default" }, { id: "yolo", name: "YOLO" }],
      },
    });
    applySessionUpdate(state, { sessionId: "s1", update: { sessionUpdate: "current_mode_update", currentModeId: "default" } });
    expect(state.modes?.currentModeId).toBe("default");
    expect(state.pendingModeId).toBeNull();
    setMeta(state, {
      modes: {
        currentModeId: "yolo",
        availableModes: [{ id: "default", name: "Default" }, { id: "yolo", name: "YOLO" }],
      },
    });
    expect(state.modes?.currentModeId).toBe("yolo");
  });

  it("modes 仍为 null 时 pending 保留，等待真正的模式列表", () => {
    const state = initialSessionState();
    applySessionUpdate(state, { sessionId: "s1", update: { sessionUpdate: "current_mode_update", currentModeId: "yolo" } });
    setMeta(state, { modes: null });
    expect(state.modes).toBeNull();
    expect(state.pendingModeId).toBe("yolo");
  });
});

describe("稳定性回归 #6：嵌套事件只重算受影响祖先链", () => {
  function nestedUpdate(state: SessionState): void {
    applySessionUpdate(state, {
      sessionId: "s1",
      agentId: "grandchild",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " line" } },
    });
  }

  it("祖先链汇总仍正确（深层变更向上冒泡）", () => {
    const state = initialSessionState();
    state.blocks = [subagent("parent", [subagent("grandchild", [{ kind: "text", text: "base" }])])];
    nestedUpdate(state);
    const parent = state.blocks[0] as SubAgentBlock;
    const child = parent.entries[0] as SubAgentBlock;
    expect(parent.tokens).toBeTypeOf("number");
    expect(parent.tokens).toBe(child.tokens);
    expect(parent.tokens).toBeGreaterThan(0);
  });

  it("无关的顶层 SubAgent 缓存不再被逐帧重算", () => {
    const state = initialSessionState();
    const affected = subagent("parent", [subagent("grandchild", [])]);
    const unrelatedTool = tool("unrelated");
    // 旧实现 for (const block of state.blocks) if (subagent) blockTokens(block)
    // 会遍历到这个兄弟卡片并读取 tokens；新实现只刷新 grandchild 的祖先链。
    Object.defineProperty(unrelatedTool, "tokens", {
      get(): number {
        throw new Error("unrelated SubAgent was re-folded");
      },
    });
    state.blocks = [affected, subagent("unrelated", [unrelatedTool])];
    expect(() => nestedUpdate(state)).not.toThrow();
    expect((affected.entries[0] as SubAgentBlock).tokens).toBeTypeOf("number");
  });
});
