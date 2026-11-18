import { describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "../src/qq/adapter/types.js";
import type { QqConfig } from "../src/qq/config.js";
import {
  createQqServiceHost,
  type QqHostPorts,
} from "../src/qq/panel-host.js";
import {
  formatQqQuestionNotice,
  QqService,
  type QqServiceDeliverInput,
  type QqServiceHost,
} from "../src/qq/service.js";
import type {
  QqTaskEvent,
  QqTaskIndexEntry,
  QqTaskRecord,
  QqTaskStore,
} from "../src/qq/store.js";
import {
  shortTaskId,
  type QqTask,
  type QqTaskChannel,
} from "../shared/qq-task.js";

// ---------------------------------------------------------------------------
// 内存夹具
// ---------------------------------------------------------------------------

class MemoryStore {
  readonly records = new Map<string, QqTask>();
  readonly events: QqTaskEvent[] = [];

  async saveTask(task: QqTaskRecord): Promise<void> {
    this.records.set(task.taskId, JSON.parse(JSON.stringify(task)) as QqTask);
  }

  async loadTask(taskId: string): Promise<QqTask | null> {
    const record = this.records.get(taskId);
    return record ? (JSON.parse(JSON.stringify(record)) as QqTask) : null;
  }

  async pruneTasks(): Promise<{ deleted: string[]; skipped: string[] }> {
    return { deleted: [], skipped: [] };
  }

  async listTasks(): Promise<QqTaskIndexEntry[]> {
    return [...this.records.values()].map((task) => ({
      taskId: task.taskId,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      chatId: task.source.chatId,
      senderId: task.source.senderId,
    }));
  }

  async appendEvent(event: QqTaskEvent): Promise<void> {
    this.events.push(event);
  }
}

interface AnswerCall {
  superSessionId: string;
  answers: Record<string, string | string[]>;
}

interface Fixture {
  service: QqService;
  store: MemoryStore;
  delivered: QqServiceDeliverInput[];
  answered: AnswerCall[];
  mainAnswered: Array<{ taskId: string; answers: Record<string, string | string[]> }>;
  releaseDispatch: () => void;
  setSuperSessionId: (id: string) => void;
}

function makeConfig(): QqConfig {
  return {
    enabled: true,
    allowedUsers: ["u1"],
    allowedGroups: [],
    workspace: "/ws",
    remotePolicy: "supervised",
    maxConcurrentTasks: 2,
    rateLimitPerMin: 10,
    resultDetail: "standard",
    autoMerge: false,
  };
}

function makeFixture(
  options: {
    questionTimeoutMs?: number;
    withAnswerPort?: boolean;
    throwingAnswerPort?: boolean;
    withMainAnswerPort?: boolean;
    throwingMainAnswerPort?: boolean;
    newTaskChannel?: QqTaskChannel;
  } = {},
): Fixture {
  const store = new MemoryStore();
  const delivered: QqServiceDeliverInput[] = [];
  const answered: AnswerCall[] = [];
  const mainAnswered: Array<{ taskId: string; answers: Record<string, string | string[]> }> = [];
  let releaseDispatch!: () => void;
  const dispatchGate = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  let superSessionId = "super-qq-1";

  const host: QqServiceHost = {
    workspaceRoots: () => ["/ws"],
    dispatchTask: async (input) => {
      // 模拟 panel 的 createQqServiceHost：派发时同步回填 superSessionId。
      input.task.correlation.superSessionId = superSessionId;
      await dispatchGate;
      return { superSessionId };
    },
    cancelTask: async () => undefined,
    mergeTask: async () => ({ ok: true, detail: "已合并" }),
    discardTask: async () => ({}),
    readTaskOutcome: () => ({ summary: "完成", stopReason: "end_turn" }),
    deliver: async (msg) => {
      delivered.push({ ...msg });
      return { ok: true };
    },
    onPendingUser: () => undefined,
    unbindAccount: async () => ({ ok: true, message: "已解绑" }),
    ...(options.withAnswerPort === false
      ? {}
      : {
          answerRemoteQuestion: (sid: string, answers: Record<string, string | string[]>) => {
            if (options.throwingAnswerPort) throw new Error("回灌端口故障");
            answered.push({ superSessionId: sid, answers });
            return true;
          },
        }),
    ...(options.withMainAnswerPort === false
      ? {}
      : {
          answerMainQuestion: (taskId: string, answers: Record<string, string | string[]>) => {
            if (options.throwingMainAnswerPort) throw new Error("主会话回灌端口故障");
            mainAnswered.push({ taskId, answers });
            return true;
          },
        }),
    notify: () => undefined,
  };

  const service = new QqService({
    config: makeConfig(),
    store: store as unknown as QqTaskStore,
    host,
    log: () => undefined,
    newTaskChannel: options.newTaskChannel ?? "child",
    ...(options.questionTimeoutMs !== undefined
      ? { questionTimeoutMs: options.questionTimeoutMs }
      : {}),
  });

  return {
    service,
    store,
    delivered,
    answered,
    mainAnswered,
    releaseDispatch,
    setSuperSessionId: (id: string) => {
      superSessionId = id;
    },
  };
}

function inbound(text: string, msgId = "m-task"): InboundMessage {
  return {
    chatType: "private",
    chatId: "u1",
    senderId: "u1",
    msgId,
    text,
    mentionsBot: false,
    attachments: [],
    timestamp: 0,
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * 建一个正在运行的 QQ 子会话渠道任务：派发 promise 被 gate 住，任务停在 running。
 */
async function runningRemoteTask(fixture: Fixture): Promise<QqTask> {
  await fixture.service.start();
  await fixture.service.handleInboundMessage(inbound("/qq task 修一下这个问题"));
  // 只等 running 会在「状态已落、派发回调尚未回填 correlation」之间抢跑；
  // forwardTaskQuestion 是按 superSessionId 找任务的，必须等回填完成。
  await waitFor(() => {
    const running = fixture.service.listTasks().find((task) => task.status === "running");
    return Boolean(running && fixture.service.getTask(running.taskId)?.correlation.superSessionId);
  });
  const id = fixture.service.listTasks().find((task) => task.status === "running")!.taskId;
  return fixture.service.getTask(id)!;
}

/** 把一条正在运行的任务切到 main 渠道（服务按 task.channel 区分寻址方式）。 */
async function runningMainTask(fixture: Fixture): Promise<QqTask> {
  const task = await runningRemoteTask(fixture);
  task.channel = "main";
  return task;
}

function question(overrides: Partial<Parameters<typeof formatQqQuestionNotice>[1][number]> = {}) {
  return {
    header: "颜色",
    question: "选哪个颜色？",
    options: [{ label: "红色", description: "热情" }, { label: "蓝色", description: "冷静" }],
    multiSelect: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 纯文本渲染
// ---------------------------------------------------------------------------

describe("formatQqQuestionNotice", () => {
  it("包含问题、选项、/qq answer 用法与超时说明，且无 Markdown 标记", () => {
    const text = formatQqQuestionNotice("abc123", [question()], 240_000);
    expect(text).toContain("任务 abc123 需要你回答");
    expect(text).toContain("选哪个颜色？");
    expect(text).toContain("红色 / 蓝色");
    expect(text).toContain("/qq answer abc123");
    expect(text).toContain("4 分钟");
    expect(text).not.toContain("**");
    expect(text).not.toContain("```");
  });

  it("多问题时如实说明自由文本会作为所有问题的答案", () => {
    const text = formatQqQuestionNotice(
      "abc123",
      [question(), question({ header: "尺寸", question: "要多大？", options: undefined })],
      240_000,
    );
    expect(text).toContain("1. 选哪个颜色？");
    expect(text).toContain("2. 要多大？");
    expect(text).toContain("所有问题的答案");
  });
});

// ---------------------------------------------------------------------------
// 转发与应答
// ---------------------------------------------------------------------------

describe("远程任务提问提醒转发", () => {
  it("远程任务的提问会转发到 QQ，任务切到 waiting_answer", async () => {
    const f = makeFixture();
    const task = await runningRemoteTask(f);
    f.delivered.length = 0;

    await f.service.forwardTaskQuestion({
      superSessionId: "super-qq-1",
      questions: [question()],
    });

    const updated = f.service.getTask(task.taskId)!;
    expect(updated.status).toBe("waiting_answer");
    expect(updated.pending?.kind).toBe("answer");
    expect(updated.pending?.text).toContain("选哪个颜色");
    expect(f.delivered.length).toBeGreaterThan(0);
    const notice = f.delivered[f.delivered.length - 1]!;
    expect(notice.text).toContain(`/qq answer ${shortTaskId(task.taskId)}`);
    expect(notice.chatId).toBe("u1");
  });

  it("本地子会话（没有对应 QQ 任务）不会转发任何消息", async () => {
    const f = makeFixture();
    await runningRemoteTask(f);
    f.delivered.length = 0;

    await f.service.forwardTaskQuestion({
      superSessionId: "local-session-xyz",
      questions: [question()],
    });

    expect(f.delivered.length).toBe(0);
    expect(f.service.listTasks().every((task) => task.status !== "waiting_answer")).toBe(true);
  });

  it("主会话渠道的任务不会转发提问", async () => {
    const f = makeFixture();
    const task = await runningRemoteTask(f);
    // getTask 返回的是服务内存里的同一个对象；直接改渠道即可模拟一条主会话
    // 渠道任务（start() 是幂等的，重新塞 store 不会重建内存任务）。
    task.channel = "main";
    f.delivered.length = 0;

    await f.service.forwardTaskQuestion({
      superSessionId: "super-qq-1",
      questions: [question()],
    });

    expect(f.delivered.length).toBe(0);
  });

  it("同一问题重复转发只发一次", async () => {
    const f = makeFixture();
    await runningRemoteTask(f);
    f.delivered.length = 0;

    await f.service.forwardTaskQuestion({ superSessionId: "super-qq-1", questions: [question()] });
    await f.service.forwardTaskQuestion({ superSessionId: "super-qq-1", questions: [question()] });

    expect(f.delivered.filter((msg) => msg.text.includes("/qq answer"))).toHaveLength(1);
  });

  it("用户应答经 /qq answer 回灌 agent，任务恢复 running 并回执", async () => {
    const f = makeFixture();
    const task = await runningRemoteTask(f);
    await f.service.forwardTaskQuestion({ superSessionId: "super-qq-1", questions: [question()] });
    f.delivered.length = 0;

    await f.service.handleInboundMessage(
      inbound(`/qq answer ${shortTaskId(task.taskId)} 我选蓝色`, "m-answer"),
    );

    expect(f.answered).toHaveLength(1);
    expect(f.answered[0]!.superSessionId).toBe("super-qq-1");
    expect(f.answered[0]!.answers).toEqual({ 颜色: "我选蓝色" });
    expect(f.service.getTask(task.taskId)!.status).toBe("running");
    expect(f.service.getTask(task.taskId)!.pending).toBeUndefined();
    expect(f.delivered.some((msg) => msg.text.includes("回答已提交给 agent"))).toBe(true);
  });

  it("多选问题的答案作为数组回灌", async () => {
    const f = makeFixture();
    const task = await runningRemoteTask(f);
    await f.service.forwardTaskQuestion({
      superSessionId: "super-qq-1",
      questions: [question({ multiSelect: true })],
    });

    await f.service.handleTaskAction(task.taskId, "answer", "红和蓝");

    expect(f.answered[0]!.answers).toEqual({ 颜色: ["红和蓝"] });
  });

  it("没有挂起提问时如实回答「当前没有等待回答的问题」", async () => {
    const f = makeFixture();
    const task = await runningRemoteTask(f);
    f.delivered.length = 0;

    await f.service.handleTaskAction(task.taskId, "answer", "随便");

    expect(f.answered).toHaveLength(0);
    expect(f.delivered[f.delivered.length - 1]!.text).toContain("当前没有等待回答的问题");
  });

  it("缺少回答正文时提示用法且不回灌", async () => {
    const f = makeFixture();
    const task = await runningRemoteTask(f);
    await f.service.forwardTaskQuestion({ superSessionId: "super-qq-1", questions: [question()] });
    f.delivered.length = 0;

    await f.service.handleTaskAction(task.taskId, "answer", "   ");

    expect(f.answered).toHaveLength(0);
    expect(f.delivered[f.delivered.length - 1]!.text).toContain("请提供回答");
    expect(f.service.getTask(task.taskId)!.status).toBe("waiting_answer");
  });

  it("宿主没有回灌端口时如实回执「回答未能送达」", async () => {
    const f = makeFixture({ withAnswerPort: false });
    const task = await runningRemoteTask(f);
    await f.service.forwardTaskQuestion({ superSessionId: "super-qq-1", questions: [question()] });
    f.delivered.length = 0;

    await f.service.handleTaskAction(task.taskId, "answer", "蓝色");

    expect(f.delivered.some((msg) => msg.text.includes("回答未能送达 agent"))).toBe(true);
    expect(f.service.getTask(task.taskId)!.status).toBe("running");
  });

  it("宿主回灌端口抛错时任务仍能收尾并如实回执", async () => {
    const f = makeFixture({ throwingAnswerPort: true });
    const task = await runningRemoteTask(f);
    await f.service.forwardTaskQuestion({ superSessionId: "super-qq-1", questions: [question()] });
    f.delivered.length = 0;

    await f.service.handleTaskAction(task.taskId, "answer", "蓝色");

    expect(f.service.getTask(task.taskId)!.status).toBe("running");
    expect(f.delivered.some((msg) => msg.text.includes("回答未能送达 agent"))).toBe(true);
  });

  it("超时按未回答继续：空答案回灌、任务恢复、如实回执", async () => {
    const f = makeFixture({ questionTimeoutMs: 20 });
    const task = await runningRemoteTask(f);
    await f.service.forwardTaskQuestion({ superSessionId: "super-qq-1", questions: [question()] });
    f.delivered.length = 0;

    await waitFor(() => f.answered.length === 1, 2_000);

    expect(f.answered[0]!.answers).toEqual({});
    await waitFor(() => f.service.getTask(task.taskId)!.status === "running");
    expect(f.delivered.some((msg) => msg.text.includes("已按未回答继续"))).toBe(true);
  });

  it("stop() 会把未答提问按未回答回灌，避免 agent 永远挂着", async () => {
    const f = makeFixture();
    await runningRemoteTask(f);
    await f.service.forwardTaskQuestion({ superSessionId: "super-qq-1", questions: [question()] });

    await f.service.stop();

    expect(f.answered).toHaveLength(1);
    expect(f.answered[0]!.answers).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 端口接线
// ---------------------------------------------------------------------------

describe("createQqServiceHost — 回答回灌端口", () => {
  it("把 QqHostPorts.answerRemoteQuestion 映射到 QqServiceHost", () => {
    const calls: AnswerCall[] = [];
    const ports: QqHostPorts = {
      workspaceRoots: () => ["/ws"],
      spawnTask: () => ({ superSessionId: "s1" }),
      waitForSettle: async () => undefined,
      cancel: async () => undefined,
      merge: async () => ({ ok: true, detail: "ok" }),
      discard: async () => ({}),
      readSuper: () => null,
      notify: () => undefined,
      deliver: async () => ({ ok: true }),
      onPendingUser: () => undefined,
      unbindAccount: async () => ({ ok: true, message: "ok" }),
      answerRemoteQuestion: (sid, answers) => {
        calls.push({ superSessionId: sid, answers });
        return true;
      },
    };
    const host = createQqServiceHost(ports);
    expect(host.answerRemoteQuestion?.("s1", { 颜色: "蓝色" })).toBe(true);
    expect(calls).toEqual([{ superSessionId: "s1", answers: { 颜色: "蓝色" } }]);
  });

  it("端口缺失时不暴露回灌方法（服务据此如实回执）", () => {
    const ports: QqHostPorts = {
      workspaceRoots: () => ["/ws"],
      spawnTask: () => ({ superSessionId: "s1" }),
      waitForSettle: async () => undefined,
      cancel: async () => undefined,
      merge: async () => ({ ok: true, detail: "ok" }),
      discard: async () => ({}),
      readSuper: () => null,
      notify: () => undefined,
      deliver: async () => ({ ok: true }),
      onPendingUser: () => undefined,
      unbindAccount: async () => ({ ok: true, message: "ok" }),
    };
    const host = createQqServiceHost(ports);
    expect(host.answerRemoteQuestion).toBeUndefined();
  });

  it("把 QqHostPorts.answerMainQuestion 映射到 QqServiceHost", () => {
    const calls: Array<{ taskId: string; answers: Record<string, string | string[]> }> = [];
    const ports: QqHostPorts = {
      workspaceRoots: () => ["/ws"],
      spawnTask: () => ({ superSessionId: "s1" }),
      waitForSettle: async () => undefined,
      cancel: async () => undefined,
      merge: async () => ({ ok: true, detail: "ok" }),
      discard: async () => ({}),
      readSuper: () => null,
      notify: () => undefined,
      deliver: async () => ({ ok: true }),
      onPendingUser: () => undefined,
      unbindAccount: async () => ({ ok: true, message: "ok" }),
      answerMainQuestion: (taskId, answers) => {
        calls.push({ taskId, answers });
        return true;
      },
    };
    const host = createQqServiceHost(ports);
    expect(host.answerMainQuestion?.("t1", { 颜色: "蓝色" })).toBe(true);
    expect(calls).toEqual([{ taskId: "t1", answers: { 颜色: "蓝色" } }]);
  });
});

// ---------------------------------------------------------------------------
// main 渠道提问转发（新功能）
// ---------------------------------------------------------------------------

describe("主会话渠道提问提醒转发（main）", () => {
  it("main 任务的提问转发到 QQ，任务切到 waiting_answer 并带 /qq answer 提示", async () => {
    const f = makeFixture();
    const task = await runningMainTask(f);
    f.delivered.length = 0;

    await f.service.forwardMainTaskQuestion({
      taskId: task.taskId,
      questions: [question()],
    });

    const updated = f.service.getTask(task.taskId)!;
    expect(updated.status).toBe("waiting_answer");
    expect(updated.pending?.kind).toBe("answer");
    const notice = f.delivered[f.delivered.length - 1]!;
    expect(notice.text).toContain(`/qq answer ${shortTaskId(task.taskId)}`);
    // 尚未回答：不能用子会话端口回灌。
    expect(f.answered).toHaveLength(0);
  });

  it("child 渠道 / 不存在的任务不会被 forwardMainTaskQuestion 误转发", async () => {
    const f = makeFixture();
    const child = await runningRemoteTask(f);
    f.delivered.length = 0;

    await f.service.forwardMainTaskQuestion({ taskId: child.taskId, questions: [question()] });
    await f.service.forwardMainTaskQuestion({ taskId: "not-exist", questions: [question()] });

    expect(f.delivered.length).toBe(0);
    expect(f.service.getTask(child.taskId)!.status).toBe("running");
  });

  it("/qq answer 经 answerMainQuestion 回灌主会话，任务恢复 running 并回执", async () => {
    const f = makeFixture();
    const task = await runningMainTask(f);
    await f.service.forwardMainTaskQuestion({ taskId: task.taskId, questions: [question()] });
    f.delivered.length = 0;

    await f.service.handleInboundMessage(
      inbound(`/qq answer ${shortTaskId(task.taskId)} 我选蓝色`, "m-main-answer"),
    );

    expect(f.mainAnswered).toHaveLength(1);
    expect(f.mainAnswered[0]!.taskId).toBe(task.taskId);
    expect(f.mainAnswered[0]!.answers).toEqual({ 颜色: "我选蓝色" });
    expect(f.answered).toHaveLength(0);
    expect(f.service.getTask(task.taskId)!.status).toBe("running");
    expect(f.delivered.some((msg) => msg.text.includes("回答已提交给 agent"))).toBe(true);
  });

  it("主会话回灌端口缺失或抛错时如实回执「未能送达」", async () => {
    for (const options of [{ withMainAnswerPort: false }, { throwingMainAnswerPort: true }]) {
      const f = makeFixture(options);
      const task = await runningMainTask(f);
      await f.service.forwardMainTaskQuestion({ taskId: task.taskId, questions: [question()] });
      f.delivered.length = 0;

      await f.service.handleTaskAction(task.taskId, "answer", "蓝色");

      expect(f.service.getTask(task.taskId)!.status).toBe("running");
      expect(f.delivered.some((msg) => msg.text.includes("回答未能送达 agent"))).toBe(true);
      f.service.stop();
    }
  });

  it("超时按未回答回灌空答案到主会话", async () => {
    const f = makeFixture({ questionTimeoutMs: 20 });
    const task = await runningMainTask(f);
    await f.service.forwardMainTaskQuestion({ taskId: task.taskId, questions: [question()] });
    f.delivered.length = 0;

    await waitFor(() => f.mainAnswered.length === 1, 2_000);

    expect(f.mainAnswered[0]!.answers).toEqual({});
    expect(f.answered).toHaveLength(0);
    await waitFor(() => f.service.getTask(task.taskId)!.status === "running");
  });

  it("stop() 把 main 未答提问按未回答回灌，避免主会话 agent 永远挂着", async () => {
    const f = makeFixture();
    const task = await runningMainTask(f);
    await f.service.forwardMainTaskQuestion({
      taskId: task.taskId,
      questions: [question()],
    });

    await f.service.stop();

    expect(f.mainAnswered).toHaveLength(1);
    expect(f.mainAnswered[0]!.answers).toEqual({});
  });

  it("本机先作答时 clearQuestionWait 撤销槽位且不回灌", async () => {
    const f = makeFixture();
    const task = await runningMainTask(f);
    await f.service.forwardMainTaskQuestion({ taskId: task.taskId, questions: [question()] });
    f.mainAnswered.length = 0;
    f.delivered.length = 0;

    f.service.clearQuestionWait(task.taskId);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(f.mainAnswered).toHaveLength(0);
    expect(f.service.getTask(task.taskId)!.pending).toBeUndefined();
    f.delivered.length = 0;
    await f.service.handleTaskAction(task.taskId, "answer", "蓝色");
    expect(f.mainAnswered).toHaveLength(0);
    expect(f.delivered[f.delivered.length - 1]!.text).toContain("当前没有等待回答的问题");
  });

  it("F1：readonly 远程策略的 main 任务直接失败，绝不调用主会话注入端口", async () => {
    const f = makeFixture({ newTaskChannel: "main" });
    const config = f.service.config as QqConfig & { remotePolicy: string };
    config.remotePolicy = "readonly";
    const inject = vi.fn(async () => ({ injected: true, text: "不该出现" }));
    (f.service.host as QqServiceHost & { injectIntoMainSession?: typeof inject }).injectIntoMainSession =
      inject;
    await f.service.start();
    f.delivered.length = 0;

    await f.service.handleInboundMessage(inbound("/qq task 只读任务", "m-readonly"));
    await waitFor(() =>
      f.service.listTasks().some((entry) => {
        const task = f.service.getTask(entry.taskId);
        return task?.failure?.code === "main_route_policy_denied";
      }),
    );

    const denied = f.service
      .listTasks()
      .map((entry) => f.service.getTask(entry.taskId)!)
      .find((task) => task.failure?.code === "main_route_policy_denied")!;
    expect(denied.channel).toBe("main");
    expect(inject).toHaveBeenCalledTimes(0);
    f.service.stop();
  });
});
