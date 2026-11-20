import { describe, it, expect } from "vitest";
import { applySessionUpdate, closeOpenToolBlocks, completePrompt } from "../shared/session-state";
import { initialSessionState, type Block, type SessionState } from "../shared/messages";
import type { SessionNotification } from "../src/acp/protocol";

/**
 * 回归：工具块的状态被「不带 status 的 tool_call_update」错误地回退成 pending。
 *
 * ACP 规范里 `status` 在 `ToolCallBase` 上是**可选**的
 * （src/acp/protocol.ts：`status?: ToolCallStatus`），而 `tool_call_update`
 * 的语义就是「只带变化的字段」—— 只带内容（output/diff）而不带 status 的
 * 更新帧非常常见。
 *
 * 修复前 shared/session-state.ts 的两个调用点用 `update.status ?? "pending"`
 * 把「wire 没带 status」伪造成「pending」，合并时又把整个 patch 铺到既有块上，
 * 于是**已处于终态**（completed / failed）的工具卡被打回 pending：
 *  - UI 上表现为工具卡卡在「正在处理」永不结束；
 *  - 回合末的僵尸清扫（`closeOpenToolBlocks`）再把它盖成 failed —— 正是
 *    上一轮「问答卡作答后工具卡显示失败」那类误标的同族症状。
 *
 * 正确语义：**只有 update 显式带 status 时才覆盖；不带 status 时保留既有状态；
 * 仅在「新建一个块且没有任何状态」时才默认 pending。**
 */

function notify(update: SessionNotification["update"], sessionId = "s1"): SessionNotification {
  return { sessionId, update };
}

/** CLI 盖的 `tool_call(pending)` 帧（functionCall 片段流式到达时）。 */
function toolCall(
  toolCallId: string,
  toolName: string,
  status?: "pending" | "in_progress" | "completed" | "failed",
  title = "读取文件",
): SessionNotification {
  return notify({
    sessionUpdate: "tool_call",
    toolCallId,
    toolName,
    title,
    kind: "read",
    ...(status ? { status } : {}),
  });
}

/** 终态帧。 */
function terminal(
  toolCallId: string,
  status: "completed" | "failed",
  toolName = "read_file",
): SessionNotification {
  return notify({
    sessionUpdate: "tool_call_update",
    toolCallId,
    toolName,
    kind: "read",
    status,
  });
}

/** 不带 status 的内容更新帧（ACP：status 可选，更新只带变化的字段）。 */
function statuslessUpdate(toolCallId: string, text = "更多输出"): SessionNotification {
  return notify({
    sessionUpdate: "tool_call_update",
    toolCallId,
    content: [{ type: "content", content: { type: "text", text } }],
  });
}

function toolBlock(state: SessionState, index = 0): Extract<Block, { kind: "tool" }> {
  const block = state.blocks[index];
  if (block?.kind !== "tool") throw new Error(`expected a tool block at ${index}`);
  return block;
}

describe("工具块状态：缺省值不得覆盖既有终态（upsertToolBlock）", () => {
  it("completed 工具收到无 status 的 update 后仍是 completed", () => {
    const state: SessionState = initialSessionState();
    applySessionUpdate(state, toolCall("t1", "read_file", "pending"));
    applySessionUpdate(state, terminal("t1", "completed"));
    expect(toolBlock(state).status).toBe("completed");

    // 只带内容、不带 status 的更新帧：状态必须原样保留。
    applySessionUpdate(state, statuslessUpdate("t1", "补充输出"));

    expect(toolBlock(state).status).toBe("completed");
    expect(toolBlock(state).output).toBe("补充输出");
  });

  it("failed 工具收到无 status 的 update 后仍是 failed", () => {
    const state: SessionState = initialSessionState();
    applySessionUpdate(state, toolCall("t1", "write_file", "pending"));
    applySessionUpdate(state, terminal("t1", "failed"));
    expect(toolBlock(state).status).toBe("failed");

    applySessionUpdate(state, statuslessUpdate("t1"));

    expect(toolBlock(state).status).toBe("failed");
  });

  it("新建块没有任何状态时仍是 pending（缺省只在新建时生效）", () => {
    const state: SessionState = initialSessionState();

    // `tool_call` 不带 status：新建的块是 pending（CLI 通常会显式带 pending，
    // 但缺省时不得产生别的状态）。
    applySessionUpdate(state, toolCall("t1", "read_file"));
    expect(toolBlock(state).status).toBe("pending");

    // 另一个连 `tool_call` 都没有、只有一条无 status 的 update 的工具：
    // 同样按新建块处理，默认 pending。
    const state2: SessionState = initialSessionState();
    applySessionUpdate(state2, statuslessUpdate("t2"));
    expect(toolBlock(state2).status).toBe("pending");
  });

  it("显式带 status 的 update 仍然覆盖既有状态（修复没有把状态冻结）", () => {
    const state: SessionState = initialSessionState();
    applySessionUpdate(state, toolCall("t1", "read_file", "pending"));
    applySessionUpdate(
      state,
      notify({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        toolName: "read_file",
        kind: "read",
        status: "in_progress",
      }),
    );
    expect(toolBlock(state).status).toBe("in_progress");

    applySessionUpdate(state, terminal("t1", "completed"));
    expect(toolBlock(state).status).toBe("completed");
  });

  it("无 status 的 update 不得抹掉工具身份与展示字段", () => {
    const state: SessionState = initialSessionState();
    applySessionUpdate(state, toolCall("t1", "read_file", "pending", "Reading package.json"));
    applySessionUpdate(state, terminal("t1", "completed"));

    // 帧里没带 toolName / title / kind —— 缺失即「未携带」，不得被清空：
    // 工具名是卡片身份（标签、图标、回合末的结算判定都读它）。
    applySessionUpdate(state, statuslessUpdate("t1"));

    expect(toolBlock(state)).toMatchObject({
      toolName: "read_file",
      title: "Reading package.json",
      toolKind: "read",
      status: "completed",
    });
  });

  it("回合末清扫不会再把「被无 status 更新拖回 pending」的终态卡盖成 failed", () => {
    const state: SessionState = initialSessionState();
    applySessionUpdate(state, toolCall("t1", "read_file", "pending"));
    applySessionUpdate(state, terminal("t1", "completed"));
    // 一条迟到的、无 status 的内容更新（跨 NDJSON 管道的乱序帧）。
    applySessionUpdate(state, statuslessUpdate("t1"));

    // 回合末：终态卡不受影响。
    expect(closeOpenToolBlocks(state.blocks)).toBeNull();
    expect(toolBlock(state).status).toBe("completed");

    completePrompt(state, "end_turn");
    expect(toolBlock(state).status).toBe("completed");
    expect(toolBlock(state).status).not.toBe("failed");
  });

  it("子代理卡片里的工具同样不被无 status 的 update 打回 pending", () => {
    const state: SessionState = initialSessionState();
    // 子代理的 task 工具 → 子代理卡。
    applySessionUpdate(state, notify({ sessionUpdate: "tool_call", toolCallId: "task-1", toolName: "task", title: "子任务", kind: "other", status: "pending" }));
    // 嵌套进来的工具帧带 agentId。
    applySessionUpdate(
      state,
      { sessionId: "s1", agentId: "agent-9", update: { sessionUpdate: "tool_call", toolCallId: "n1", toolName: "read_file", title: "读", kind: "read", status: "pending" } },
    );
    applySessionUpdate(
      state,
      { sessionId: "s1", agentId: "agent-9", update: { sessionUpdate: "tool_call_update", toolCallId: "n1", toolName: "read_file", kind: "read", status: "completed" } },
    );
    // 无 status 的嵌套更新帧。
    applySessionUpdate(
      state,
      { sessionId: "s1", agentId: "agent-9", update: { sessionUpdate: "tool_call_update", toolCallId: "n1", content: [{ type: "content", content: { type: "text", text: "更多" } }] } },
    );

    const sub = state.blocks[0];
    if (sub?.kind !== "subagent") throw new Error("expected a subagent block");
    const nested = sub.entries.find((b) => b.kind === "tool");
    if (nested?.kind !== "tool") throw new Error("expected a nested tool block");
    expect(nested.status).toBe("completed");
  });
});
