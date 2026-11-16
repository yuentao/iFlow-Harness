import { describe, it, expect } from "vitest";
import {
  newSessionState,
  removeQqTask,
  setQqTasks,
  upsertQqTask,
} from "../shared/session-state";
import { initialSessionState, type QqTaskUi, type SessionState } from "../shared/messages";

/** Minimal task fixture — only the fields the reducers care about vary. */
function task(taskId: string, overrides: Partial<QqTaskUi> = {}): QqTaskUi {
  return {
    taskId,
    shortId: `#${taskId}`,
    chatType: "private",
    chatId: "chat-1",
    senderId: "user-1",
    status: "received",
    promptPreview: "把日志里的错误整理一下",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function stateWith(tasks: QqTaskUi[]): SessionState {
  const state = initialSessionState();
  setQqTasks(state, tasks);
  return state;
}

describe("QQ 任务投影 (Wave2-B)", () => {
  it("initialSessionState / newSessionState 都带上 qqTasks", () => {
    expect(initialSessionState().qqTasks).toEqual([]);

    const state = stateWith([task("a"), task("b")]);
    const fresh = newSessionState(state);
    // 面板级投影：会话切换不清空（与 superSessions 同语义）。
    expect(fresh.qqTasks).toBe(state.qqTasks);
    expect(fresh.qqTasks.map((t) => t.taskId)).toEqual(["a", "b"]);
  });

  it("setQqTasks 整表替换并返回行数", () => {
    const state = stateWith([task("a")]);
    const count = setQqTasks(state, [task("b"), task("c")]);
    expect(count).toBe(2);
    expect(state.qqTasks.map((t) => t.taskId)).toEqual(["b", "c"]);
  });

  it("upsertQqTask 新任务追加到尾部，并返回投影下标", () => {
    const state = stateWith([task("a")]);
    const index = upsertQqTask(state, task("b"));
    expect(index).toBe(1);
    expect(state.qqTasks.map((t) => t.taskId)).toEqual(["a", "b"]);
    // 新任务永远从尾部追加：连续三次追加顺序稳定。
    upsertQqTask(state, task("c"));
    expect(state.qqTasks.map((t) => t.taskId)).toEqual(["a", "b", "c"]);
  });

  it("upsertQqTask 同 id 原位替换，不改变行序", () => {
    const state = stateWith([task("a"), task("b"), task("c")]);
    const index = upsertQqTask(state, task("b", { status: "running", updatedAt: 1_700_000_000_999 }));
    expect(index).toBe(1);
    expect(state.qqTasks.map((t) => t.taskId)).toEqual(["a", "b", "c"]);
    expect(state.qqTasks[1]!.status).toBe("running");
    expect(state.qqTasks[1]!.updatedAt).toBe(1_700_000_000_999);
  });

  it("removeQqTask 删除指定行、保留其余顺序；未知 id 返回 false", () => {
    const state = stateWith([task("a"), task("b"), task("c")]);
    expect(removeQqTask(state, "b")).toBe(true);
    expect(state.qqTasks.map((t) => t.taskId)).toEqual(["a", "c"]);
    expect(removeQqTask(state, "b")).toBe(false);
    expect(state.qqTasks.map((t) => t.taskId)).toEqual(["a", "c"]);
  });

  it("qqTasks 是非 blocks 元数据：三个 reducer 都不碰 transcripts", () => {
    const state = stateWith([task("a")]);
    const blocks = state.blocks;
    const index = upsertQqTask(state, task("b"));
    // 返回值是投影下标（findIndex 结果），不是 block 变更索引 —— 它不该被
    // 喂给 store 的 noteMutationIndex（整份投影随 blockPatch tail 重发）。
    expect(index).toBe(state.qqTasks.findIndex((t) => t.taskId === "b"));
    expect(index).toBeGreaterThanOrEqual(0);
    removeQqTask(state, "a");
    setQqTasks(state, []);
    expect(state.blocks).toBe(blocks);
    expect(state.blocks).toHaveLength(0);
  });
});
