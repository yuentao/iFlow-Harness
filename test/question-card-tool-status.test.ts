import { describe, it, expect } from "vitest";
import { applySessionUpdate, completePrompt, closeOpenToolBlocks } from "../shared/session-state";
import { initialSessionState, type SessionState } from "../shared/messages";
import type { SessionNotification } from "../src/acp/protocol";

/**
 * 回归：用户回答「问答卡」（`_iflow/user/questions`）之后，关联的工具卡被误标
 * 成「失败」（用户截图：工具操作 / 正在处理一项工具任务 旁边是「× 失败」）。
 *
 * Wire 证据（vendor/iflow-fork/bundle/iflow.js，CLI 0.5.19 fork 快照）：
 * `AcpSession.runTool` 对 `ask_user_question` 提前返回 ——
 *   `if (t.name === "ask_user_question") return { response: await this.handleAskUserQuestion(...) }`
 * —— 这一行位于 in_progress / completed / failed 三次 `sendUpdate` **之前**，
 * 所以 CLI 不会为这次调用发任何终态帧；唯一到达宿主的帧是模型 functionCall
 * 片段流式到达时盖的 `tool_call(pending)`（`AcpSession.prompt`）。
 * 提问本身由 `handleAskUserQuestion` 经 `_iflow/user/questions` 往返宿主，宿主
 * 回完答案后 CLI 用 `{ success: true, output: "User has answered your
 * questions: …" }` 结束这次调用 —— 调用是**成功**结束的。
 *
 * 于是回合末的僵尸清扫（`closeOpenToolBlocks`）把这张还开着的卡一律盖成
 * failed：用户刚答完问，卡片却写着「× 失败」。问答题的 wire 请求里只有
 * `sessionId` + `questions`、没有 toolCallId，宿主无法把问答题与工具卡对上，
 * 所以修在 reducer（唯一能判定这一类调用真实结局的那一层）。
 */

function notify(update: SessionNotification["update"], sessionId = "s1"): SessionNotification {
  return { sessionId, update };
}

/** CLI 盖的 `tool_call(pending)` 帧（functionCall 片段流式到达时）。 */
function pendingToolCall(
  toolCallId: string,
  toolName: string,
  kind: "other" | "edit" = "other",
  agentId?: string,
): SessionNotification {
  const update: SessionNotification["update"] = {
    sessionUpdate: "tool_call",
    toolCallId,
    toolName,
    title: toolName === "ask_user_question" ? "Ask Question" : "替换内容",
    kind,
    status: "pending",
  };
  return agentId ? { sessionId: "s1", agentId, update } : { sessionId: "s1", update };
}

describe("问答卡作答后的工具卡状态（ask_user_question 不得标 failed）", () => {
  it("回答完问卡后回合结束，提问工具卡是「已完成」而不是「失败」", () => {
    const state: SessionState = initialSessionState();

    // 提问工具的 pending 帧：kind=other → 通用「工具操作 / 正在处理一项工具任务」卡
    // （正是用户截图里那张卡）。
    applySessionUpdate(state, pendingToolCall("q-1", "ask_user_question"));
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({
      kind: "tool",
      toolName: "ask_user_question",
      toolKind: "other",
      status: "pending",
    });

    // 用户作答 → 宿主回答案 → CLI 用 success functionResponse 结束这次调用
    // （全程没有任何终态 tool_call_update 到达宿主）→ 回合结束。
    completePrompt(state, "end_turn");

    const block = state.blocks[0];
    if (block?.kind !== "tool") throw new Error("expected a tool block");
    expect(block.status).toBe("completed");
    expect(block.status).not.toBe("failed");
  });

  it("同一回合里其它工具的僵尸卡仍然标 failed（真失败不被吞掉）", () => {
    const state: SessionState = initialSessionState();
    applySessionUpdate(state, pendingToolCall("q-1", "ask_user_question"));
    // 计划模式拒绝 / 工具不存在 / 用户取消审批等路径：CLI 用 error
    // functionResponse 结束调用但不发终态帧 —— 回合末必须如实标 failed。
    applySessionUpdate(state, pendingToolCall("w-1", "write_file", "edit"));
    applySessionUpdate(state, pendingToolCall("x-1", "exit_plan_mode"));

    completePrompt(state, "end_turn");

    const statuses = state.blocks.map((b) => (b.kind === "tool" ? [b.toolName, b.status] : null));
    expect(statuses).toEqual([
      ["ask_user_question", "completed"],
      ["write_file", "failed"],
      ["exit_plan_mode", "failed"],
    ]);
  });

  it("子代理卡片里的提问工具同样按「已完成」收尾", () => {
    const state: SessionState = initialSessionState();
    // 子代理的 task 工具 → 子代理卡；嵌套进来的提问工具帧带 agentId。
    applySessionUpdate(state, pendingToolCall("task-1", "task"));
    applySessionUpdate(state, pendingToolCall("q-1", "ask_user_question", "other", "agent-9"));
    expect(state.blocks).toHaveLength(1);

    completePrompt(state, "end_turn");

    const sub = state.blocks[0];
    if (sub?.kind !== "subagent") throw new Error("expected a subagent block");
    const nested = sub.entries.find((b) => b.kind === "tool");
    if (nested?.kind !== "tool") throw new Error("expected a nested tool block");
    expect(nested.toolName).toBe("ask_user_question");
    expect(nested.status).toBe("completed");
  });

  it("已经是终态的提问工具卡不受回合末清扫影响", () => {
    const state: SessionState = initialSessionState();
    applySessionUpdate(
      state,
      notify({
        sessionUpdate: "tool_call_update",
        toolCallId: "q-1",
        toolName: "ask_user_question",
        kind: "other",
        status: "completed",
      }),
    );
    expect(closeOpenToolBlocks(state.blocks)).toBeNull();
    expect(state.blocks[0]).toMatchObject({ status: "completed" });
  });
});