import { describe, expect, it, vi } from "vitest";
import {
  createQqServiceHost,
  QQ_DEFAULT_SETTLE_TIMEOUT_MS,
  QQ_MISSING_SUMMARY_TEXT,
  QqSettleTimeoutError,
  type QqHostPorts,
  type QqHostSpawnOptions,
  type QqHostSpawnSpec,
  type QqHostSuperSnapshot,
  type QqHostTaskOutcome,
} from "../src/qq/panel-host.js";
import type {
  QqServiceDeliverInput,
  QqServiceDispatchInput,
  QqServiceHost,
} from "../src/qq/service.js";
import type { QqPendingUserInput } from "../src/qq/pending-users.js";
import type { SuperPermissionDecision } from "../src/panel/super-agent.js";
import { shortTaskId, type QqTask } from "../shared/qq-task.js";

// ---------------------------------------------------------------------------
// 假端口（全部只记录调用，不碰磁盘 / 进程）
// ---------------------------------------------------------------------------

interface PortsFixture {
  ports: QqHostPorts;
  state: {
    snapshot: QqHostSuperSnapshot | null;
    mergeResult: { ok: boolean; detail: string };
    deliverResult: boolean;
    unbindResult: { ok: boolean; message: string };
  };
  spawns: Array<{ spec: QqHostSpawnSpec; opts: QqHostSpawnOptions }>;
  waits: Array<{ superSessionId: string; timeoutMs?: number }>;
  cancels: string[];
  merges: string[];
  discards: string[];
  notes: string[];
  delivered: QqServiceDeliverInput[];
  pendings: QqPendingUserInput[];
  unbinds: { count: number };
}

function makeFixture(): PortsFixture {
  const state: PortsFixture["state"] = {
    snapshot: { summary: "已完成", branch: "iflow/qq/t" },
    mergeResult: { ok: true, detail: "已合并" },
    deliverResult: true,
    unbindResult: { ok: true, message: "已解绑" },
  };
  const fixture: PortsFixture = {
    ports: undefined as unknown as QqHostPorts,
    state,
    spawns: [],
    waits: [],
    cancels: [],
    merges: [],
    discards: [],
    notes: [],
    delivered: [],
    pendings: [],
    unbinds: { count: 0 },
  };

  fixture.ports = {
    workspaceRoots: () => ["/ws-a", "/ws-b"],
    spawnTask: (spec, opts) => {
      fixture.spawns.push({ spec, opts });
      return { superSessionId: "super-1", branch: "iflow/qq/t" };
    },
    waitForSettle: async (superSessionId, timeoutMs) => {
      fixture.waits.push({ superSessionId, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    },
    cancel: async (superSessionId) => {
      fixture.cancels.push(superSessionId);
    },
    merge: async (superSessionId) => {
      fixture.merges.push(superSessionId);
      return state.mergeResult;
    },
    discard: async (superSessionId) => {
      fixture.discards.push(superSessionId);
    },
    readSuper: () => state.snapshot,
    notify: (text) => {
      fixture.notes.push(text);
    },
    deliver: async (msg) => {
      fixture.delivered.push({ ...msg });
      return state.deliverResult;
    },
    onPendingUser: (info) => {
      fixture.pendings.push({ ...info });
    },
    unbindAccount: async () => {
      fixture.unbinds.count += 1;
      return state.unbindResult;
    },
  };
  return fixture;
}

function outcomeOf(
  host: QqServiceHost,
  superSessionId: string,
): QqHostTaskOutcome | null {
  return host.readTaskOutcome(superSessionId) as QqHostTaskOutcome | null;
}

function makeTask(taskId = "T-abcdef123456"): QqTask {
  return {
    taskId,
    idempotencyKey: `qqbot:${taskId}`,
    source: { chatType: "private", chatId: "u1", senderId: "u1", msgId: "m1" },
    target: { workspace: "/ws-a" },
    payload: { prompt: "把 README 的错误链接修一下", attachments: [], contexts: [] },
    policy: { remotePolicy: "supervised", resultDetail: "standard" },
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    correlation: {},
  };
}

function makeDispatchInput(
  task: QqTask,
  overrides: Partial<QqServiceDispatchInput> = {},
): QqServiceDispatchInput {
  return {
    task,
    approval: "supervised",
    disallowedTools: ["write_file"],
    onPermission: async (): Promise<SuperPermissionDecision> => "deny",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// dispatchTask
// ---------------------------------------------------------------------------

describe("createQqServiceHost — dispatchTask", () => {
  it("用「QQ + 短任务 id」作标题，把策略与回调原样交给端口", async () => {
    const f = makeFixture();
    const host = createQqServiceHost(f.ports);
    const task = makeTask();
    const onPermission = vi.fn(async (): Promise<SuperPermissionDecision> => "allow_once");

    const result = await host.dispatchTask(makeDispatchInput(task, { onPermission }));

    expect(f.spawns).toHaveLength(1);
    expect(f.spawns[0]!.spec.title).toBe(`QQ ${shortTaskId(task.taskId)}`);
    expect(f.spawns[0]!.spec.title).toBe("QQ 123456");
    expect(f.spawns[0]!.spec.task).toBe(task.payload.prompt);
    expect(f.spawns[0]!.opts.approval).toBe("supervised");
    expect(f.spawns[0]!.opts.disallowedTools).toEqual(["write_file"]);
    expect(f.spawns[0]!.opts.onPermission).toBe(onPermission);
    expect(result).toEqual({ superSessionId: "super-1", branch: "iflow/qq/t" });
  });

  it("等待端口被调用一次，并在收尾后返回分支", async () => {
    const f = makeFixture();
    const host = createQqServiceHost(f.ports);

    const result = await host.dispatchTask(makeDispatchInput(makeTask()));

    expect(f.waits).toEqual([
      { superSessionId: "super-1", timeoutMs: QQ_DEFAULT_SETTLE_TIMEOUT_MS },
    ]);
    expect(result.branch).toBe("iflow/qq/t");
  });

  it("等待开始前已把 superSessionId / branch 同步写回 correlation", async () => {
    const task = makeTask();
    let seen: QqTask["correlation"] | undefined;
    const f = makeFixture();
    const host = createQqServiceHost({
      ...f.ports,
      waitForSettle: async () => {
        // 读取此刻的共享任务对象：/qq stop 正是从这里找子会话 id。
        seen = { ...task.correlation };
      },
    });

    await host.dispatchTask(makeDispatchInput(task));

    expect(seen).toEqual({ superSessionId: "super-1", branch: "iflow/qq/t" });
    expect(task.correlation.superSessionId).toBe("super-1");
    expect(task.correlation.branch).toBe("iflow/qq/t");
  });

  it("端口没给分支时不覆盖已有 branch，也不在结果里编造", async () => {
    const task = makeTask();
    task.correlation.branch = "iflow/qq/legacy";
    const f = makeFixture();
    const host = createQqServiceHost({
      ...f.ports,
      spawnTask: (spec, opts) => {
        f.spawns.push({ spec, opts });
        return { superSessionId: "super-2" };
      },
    });

    const result = await host.dispatchTask(makeDispatchInput(task));

    expect(result).toEqual({ superSessionId: "super-2" });
    expect(task.correlation).toEqual({ superSessionId: "super-2", branch: "iflow/qq/legacy" });
  });

  it("spawnTask 抛错时原样上抛，不继续等待、不伪造成功", async () => {
    const task = makeTask();
    const waits: string[] = [];
    const f = makeFixture();
    const host = createQqServiceHost({
      ...f.ports,
      spawnTask: () => {
        throw new Error("worktree 创建失败");
      },
      waitForSettle: async (id) => {
        waits.push(id);
      },
    });

    await expect(host.dispatchTask(makeDispatchInput(task))).rejects.toThrow(
      "worktree 创建失败",
    );
    expect(waits).toEqual([]);
    expect(task.correlation).toEqual({});
  });

  it("等待超时抛 QqSettleTimeoutError，不返回成功", async () => {
    const task = makeTask();
    const f = makeFixture();
    const host = createQqServiceHost(
      {
        ...f.ports,
        waitForSettle: () => new Promise<void>(() => undefined),
      },
      { settleTimeoutMs: 10 },
    );

    const error = await host
      .dispatchTask(makeDispatchInput(task))
      .then(() => null)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(QqSettleTimeoutError);
    expect((error as QqSettleTimeoutError).code).toBe("timeout");
    expect((error as QqSettleTimeoutError).superSessionId).toBe("super-1");
    expect((error as QqSettleTimeoutError).timeoutMs).toBe(10);
    expect((error as Error).message).toContain("super-1");
    // 超时前已回填：/qq stop 仍能找到这个子会话。
    expect(task.correlation.superSessionId).toBe("super-1");
    expect(f.waits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// readTaskOutcome
// ---------------------------------------------------------------------------

describe("createQqServiceHost — readTaskOutcome", () => {
  it("端口读不到时返回 null", () => {
    const f = makeFixture();
    f.state.snapshot = null;
    const host = createQqServiceHost(f.ports);

    expect(outcomeOf(host, "super-1")).toBeNull();
  });

  it("缺摘要时用占位文案，不编造 stopReason / 分支", () => {
    const f = makeFixture();
    f.state.snapshot = {};
    const host = createQqServiceHost(f.ports);

    const outcome = outcomeOf(host, "super-1");

    expect(outcome).not.toBeNull();
    expect(outcome!.summary).toBe(QQ_MISSING_SUMMARY_TEXT);
    expect(Object.prototype.hasOwnProperty.call(outcome, "stopReason")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(outcome, "branch")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(outcome, "status")).toBe(false);
  });

  it("空白摘要同样视为缺失", () => {
    const f = makeFixture();
    f.state.snapshot = { summary: "   " };
    const host = createQqServiceHost(f.ports);

    expect(outcomeOf(host, "super-1")!.summary).toBe(QQ_MISSING_SUMMARY_TEXT);
  });

  it("摘要 / 分支 / 状态 / merged 原样透传，且始终不编造 stopReason", () => {
    const f = makeFixture();
    f.state.snapshot = {
      summary: "改完了 3 处",
      branch: "iflow/qq/abc",
      status: "merged",
      merged: true,
    };
    const host = createQqServiceHost(f.ports);

    const outcome = outcomeOf(host, "super-1")!;

    expect(outcome.summary).toBe("改完了 3 处");
    expect(outcome.branch).toBe("iflow/qq/abc");
    expect(outcome.status).toBe("merged");
    expect(outcome.merged).toBe(true);
    expect(outcome.stopReason).toBeUndefined();
  });

  it("status 为 merged 时即使没有 merged 布尔也保留合并标记", () => {
    const f = makeFixture();
    f.state.snapshot = { summary: "完成", status: "merged" };
    const host = createQqServiceHost(f.ports);

    expect(outcomeOf(host, "super-1")!.merged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 透传
// ---------------------------------------------------------------------------

describe("createQqServiceHost — 透传", () => {
  it("workspaceRoots 直接返回端口的值", () => {
    const f = makeFixture();
    const host = createQqServiceHost(f.ports);

    expect(host.workspaceRoots()).toEqual(["/ws-a", "/ws-b"]);
  });

  it("cancel / discard 用同一个 id 透传", async () => {
    const f = makeFixture();
    const host = createQqServiceHost(f.ports);

    await host.cancelTask("super-c");
    await host.discardTask("super-d");

    expect(f.cancels).toEqual(["super-c"]);
    expect(f.discards).toEqual(["super-d"]);
  });

  it("merge 失败时 detail 原样返回", async () => {
    const f = makeFixture();
    f.state.mergeResult = { ok: false, detail: "合并冲突：src/a.ts" };
    const host = createQqServiceHost(f.ports);

    await expect(host.mergeTask("super-m")).resolves.toEqual({
      ok: false,
      detail: "合并冲突：src/a.ts",
    });
    expect(f.merges).toEqual(["super-m"]);
  });

  it("deliver 透传消息与送达结果", async () => {
    const f = makeFixture();
    f.state.deliverResult = false;
    const host = createQqServiceHost(f.ports);
    const msg: QqServiceDeliverInput = {
      chatType: "group",
      chatId: "g1",
      text: "任务已完成",
      replyToMsgId: "m9",
    };

    await expect(host.deliver(msg)).resolves.toBe(false);
    expect(f.delivered).toEqual([msg]);
  });

  it("notify 不返回、不发往 QQ，只交给端口", () => {
    const f = makeFixture();
    const host = createQqServiceHost(f.ports);

    host.notify("QQ 任务已派发");

    expect(f.notes).toEqual(["QQ 任务已派发"]);
    expect(f.delivered).toEqual([]);
  });

  it("onPendingUser 原样透传；unbindAccount 透传结果", async () => {
    const f = makeFixture();
    f.state.unbindResult = { ok: true, message: "已解绑 1 个账号" };
    const host = createQqServiceHost(f.ports);
    const info: QqPendingUserInput = {
      openid: "u2",
      chatType: "group",
      groupId: "g1",
      preview: "帮我改个东西",
      at: 123,
    };

    host.onPendingUser(info);
    expect(f.pendings).toEqual([info]);

    await expect(host.unbindAccount()).resolves.toEqual({
      ok: true,
      message: "已解绑 1 个账号",
    });
    expect(f.unbinds.count).toBe(1);
  });
});
