import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../src/qq/adapter/types.js";
import type { QqConfig } from "../src/qq/config.js";
import {
  QqService,
  QQ_IDEMPOTENCY_TTL_MS,
  QQ_MAX_TRACKED_IDEMPOTENCY_KEYS,
  QQ_MAX_TRACKED_RECENT_OUTBOUND,
  type QqServiceDeliverInput,
  type QqServiceHost,
} from "../src/qq/service.js";
import type {
  QqTaskEvent,
  QqTaskIndexEntry,
  QqTaskRecord,
  QqTaskStore,
} from "../src/qq/store.js";
import { shortTaskId, type QqTask, type QqTaskStatus } from "../shared/qq-task.js";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 可临时阻塞「下一次落盘」的内存归档，用于放大挂槽与 await 之间的窗口。 */
class MemoryStore {
  readonly records = new Map<string, QqTask>();
  readonly events: QqTaskEvent[] = [];
  private saveGate: Promise<void> | null = null;

  blockNextSave(): () => void {
    let release!: () => void;
    this.saveGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      this.saveGate = null;
      release();
    };
  }

  async saveTask(task: QqTaskRecord): Promise<void> {
    const gate = this.saveGate;
    if (gate) {
      this.saveGate = null;
      await gate;
    }
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

interface Fixture {
  service: QqService;
  store: MemoryStore;
  delivered: QqServiceDeliverInput[];
  dispatches: QqTask[];
  answered: Array<{ superSessionId: string; answers: Record<string, string | string[]> }>;
  mainAnswered: Array<{ taskId: string; answers: Record<string, string | string[]> }>;
  releaseDispatch: () => void;
}

function makeConfig(overrides: Partial<QqConfig> = {}): QqConfig {
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
    ...overrides,
  };
}

function makeFixture(
  options: { now?: () => number; config?: Partial<QqConfig> } = {},
): Fixture {
  const store = new MemoryStore();
  const delivered: QqServiceDeliverInput[] = [];
  const dispatches: QqTask[] = [];
  const answered: Fixture["answered"] = [];
  const mainAnswered: Fixture["mainAnswered"] = [];
  let releaseDispatch!: () => void;
  const dispatchGate = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });

  const host: QqServiceHost = {
    workspaceRoots: () => ["/ws"],
    dispatchTask: async (input) => {
      dispatches.push(input.task);
      input.task.correlation.superSessionId = "super-qq-1";
      await dispatchGate;
      return { superSessionId: "super-qq-1" };
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
    answerRemoteQuestion: (superSessionId, answers) => {
      answered.push({ superSessionId, answers });
      return true;
    },
    answerMainQuestion: (taskId, answers) => {
      mainAnswered.push({ taskId, answers });
      return true;
    },
    notify: () => undefined,
  };

  const service = new QqService({
    config: makeConfig(options.config),
    store: store as unknown as QqTaskStore,
    host,
    log: () => undefined,
    newTaskChannel: "child",
    ...(options.now ? { now: options.now } : {}),
  });

  return { service, store, delivered, dispatches, answered, mainAnswered, releaseDispatch };
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

function question(header: string): { header: string; question: string; options: string[] } {
  return { header, question: `请选择${header}`, options: ["A", "B"] };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/** 建一个停在 running 的 main 渠道任务（派发被 gate 住）。 */
async function runningMainTask(f: Fixture): Promise<QqTask> {
  await f.service.start();
  await f.service.handleInboundMessage(inbound("/qq task 修一下这个问题"));
  await waitFor(() => {
    const running = f.service.listTasks().find((task) => task.status === "running");
    return Boolean(running && f.service.getTask(running.taskId)?.correlation.superSessionId);
  });
  const task = f.service.getTask(f.service.listTasks().find((t) => t.status === "running")!.taskId)!;
  task.channel = "main";
  return task;
}

/** 通过内部视图断言私有记账表（沿用项目既有的白盒测试口径）。 */
function internals(service: QqService): {
  pendingAnswers: Map<string, { taskId: string; questions: Array<{ header: string }> }>;
  idempotency: Map<string, { taskId: string; at: number; reserved: boolean }>;
  recentOutboundText: Map<string, Array<{ text: string; at: number }>>;
  readIdempotency: (key: string) => string | undefined;
  trackIdempotency: (key: string, taskId: string, reserved: boolean) => void;
  recordOutboundText: (taskId: string, text: string) => void;
  forwardQuestionToTask: (
    findTask: () => QqTask | undefined,
    questions: readonly QqRemoteQuestionLike[],
    channel: "child" | "main",
    answerSuperSessionId?: string,
  ) => Promise<void>;
} {
  return service as unknown as ReturnType<typeof internals>;
}

type QqRemoteQuestionLike = { header: string; question: string; options?: string[] };

// ---------------------------------------------------------------------------
// S2：提问占位先于 await，答案按占位精确消费
// ---------------------------------------------------------------------------

describe("QQ 提问答案占位（S2）", () => {
  it("并发提问只保留一个占位，答案不会按另一份问题清单错灌", async () => {
    const f = makeFixture();
    const task = await runningMainTask(f);
    const gate = f.store.blockNextSave();
    const view = internals(f.service);

    // 绕过 status 守卫直接调用共用实现，专门放大「has() 与 set() 之间」
    // 的窗口：两条提问几乎同时到达，落盘被 gate 住。
    const first = view.forwardQuestionToTask(() => task, [question("颜色")], "main");
    const second = view.forwardQuestionToTask(() => task, [question("尺寸")], "main");

    expect(view.pendingAnswers.size).toBe(1);
    expect([...view.pendingAnswers.values()][0]!.questions[0]!.header).toBe("颜色");

    gate();
    await Promise.all([first, second]);
    await f.service.handleTaskAction(task.taskId, "answer", "蓝色");

    expect(f.mainAnswered).toHaveLength(1);
    expect(f.mainAnswered[0]!.answers).toEqual({ 颜色: "蓝色" });
    expect(f.mainAnswered[0]!.answers).not.toHaveProperty("尺寸");
    expect(f.answered).toHaveLength(0);
  });

  it("答案在 waiting_answer 落盘完成前到达也能命中占位，任务不会卡在等待态", async () => {
    const f = makeFixture();
    const task = await runningMainTask(f);
    const gate = f.store.blockNextSave();
    const view = internals(f.service);
    f.delivered.length = 0;

    const forward = f.service.forwardMainTaskQuestion({
      taskId: task.taskId,
      questions: [question("颜色")],
    });
    await waitFor(() => view.pendingAnswers.has(task.taskId));

    // 此刻 commitStatus 仍被 gate 住；答案必须能命中刚登记的占位。
    await f.service.handleTaskAction(task.taskId, "answer", "蓝色");
    expect(f.mainAnswered).toHaveLength(1);
    expect(f.mainAnswered[0]!.answers).toEqual({ 颜色: "蓝色" });

    gate();
    await forward;
    // 迟到的 waiting_answer 写入不能把已经恢复的任务重新卡住。
    expect(f.service.getTask(task.taskId)!.status).toBe("running");
    expect(f.mainAnswered).toHaveLength(1);
    expect(view.pendingAnswers.size).toBe(0);
  });

  it("同一任务连续两次 answer 只回灌一次，第二次如实报无等待问题", async () => {
    const f = makeFixture();
    const task = await runningMainTask(f);
    await f.service.forwardMainTaskQuestion({
      taskId: task.taskId,
      questions: [question("颜色")],
    });

    await f.service.handleTaskAction(task.taskId, "answer", "蓝色");
    await f.service.handleTaskAction(task.taskId, "answer", "红色");

    expect(f.mainAnswered).toHaveLength(1);
    expect(f.mainAnswered[0]!.answers).toEqual({ 颜色: "蓝色" });
    expect(f.delivered.some((msg) => msg.text.includes("当前没有等待回答的问题"))).toBe(true);
    expect(shortTaskId(task.taskId).length).toBeGreaterThan(0);
  });

  it("旧 forward 迟到恢复时不会撤销已接管的新提问槽位", async () => {
    const f = makeFixture();
    const task = await runningMainTask(f);
    const view = internals(f.service);

    const gate = f.store.blockNextSave();
    const oldForward = view.forwardQuestionToTask(() => task, [question("旧问题")], "main");
    await waitFor(() => view.pendingAnswers.size === 1);

    // 答案先到：旧槽位被消费，任务恢复 running。
    await f.service.handleTaskAction(task.taskId, "answer", "旧答案");
    expect(view.pendingAnswers.size).toBe(0);

    // 新提问抢占：新槽位登记 + waiting_answer 落盘。
    const newForward = f.service.forwardMainTaskQuestion({
      taskId: task.taskId,
      questions: [question("新问题")],
    });
    await waitFor(() => view.pendingAnswers.size === 1);

    // 旧 forward 此刻才恢复：新槽位已接管，它不能再把状态回滚成 running。
    gate();
    await oldForward;
    await newForward;

    expect(view.pendingAnswers.size).toBe(1);
    expect([...view.pendingAnswers.values()][0]!.questions[0]!.header).toBe("新问题");
    expect(f.service.getTask(task.taskId)!.status).toBe("waiting_answer");

    await f.service.handleTaskAction(task.taskId, "answer", "新答案");
    expect(f.mainAnswered.at(-1)!.answers).toEqual({ 新问题: "新答案" });
  });
});

// ---------------------------------------------------------------------------
// M5：幂等键 / 任务表 / recentOutboundText 回收
// ---------------------------------------------------------------------------

describe("QQ 容量与回收（M5）", () => {
  it("幂等键（含 reserve 占位）到归档保留期才回收，窗口内去重语义不变", () => {
    let clock = 1_000_000;
    const f = makeFixture({ now: () => clock });
    const view = internals(f.service);

    // reserve 占位与真实键共用归档窗口：创建链路再长也不会中途失效。
    view.trackIdempotency("qqbot:m-reserve", "reserve:x", true);
    clock += QQ_IDEMPOTENCY_TTL_MS - 1;
    expect(view.readIdempotency("qqbot:m-reserve")).toBe("reserve:x");
    clock += 2;
    expect(view.readIdempotency("qqbot:m-reserve")).toBeUndefined();
    expect(view.idempotency.has("qqbot:m-reserve")).toBe(false);

    view.trackIdempotency("qqbot:m-real", "task-real", false);
    clock += QQ_IDEMPOTENCY_TTL_MS - 1;
    expect(view.readIdempotency("qqbot:m-real")).toBe("task-real");
    clock += 2;
    expect(view.readIdempotency("qqbot:m-real")).toBeUndefined();
    expect(view.idempotency.has("qqbot:m-real")).toBe(false);
  });

  it("幂等键超过容量时淘汰最旧键，窗口内去重语义不变", async () => {
    const f = makeFixture();
    const view = internals(f.service);
    for (let i = 0; i < QQ_MAX_TRACKED_IDEMPOTENCY_KEYS + 10; i += 1) {
      view.trackIdempotency(`qqbot:m-${i}`, `task-${i}`, false);
    }
    expect(view.idempotency.size).toBe(QQ_MAX_TRACKED_IDEMPOTENCY_KEYS);
    expect(view.idempotency.has("qqbot:m-0")).toBe(false);
    expect(view.idempotency.has(`qqbot:m-${QQ_MAX_TRACKED_IDEMPOTENCY_KEYS + 9}`)).toBe(true);

    // 真实链路：同一 msgId 仍只派发一次。
    await f.service.start();
    await f.service.handleInboundMessage(inbound("/qq task 修一下", "m-dedup"));
    await f.service.handleInboundMessage(inbound("/qq task 修一下", "m-dedup"));
    expect(f.dispatches).toHaveLength(1);
    expect(f.delivered.some((msg) => msg.text.includes("不会重复执行"))).toBe(true);
  });

  it("recentOutboundText 外层键按容量淘汰，任务终态时按裸 taskId 回收", async () => {
    const f = makeFixture();
    const view = internals(f.service);
    for (let i = 0; i < QQ_MAX_TRACKED_RECENT_OUTBOUND + 10; i += 1) {
      view.recordOutboundText(`task-${i}`, "这是一段足够长的中文正文用于短窗相似去重");
    }
    expect(view.recentOutboundText.size).toBe(QQ_MAX_TRACKED_RECENT_OUTBOUND);
    expect(view.recentOutboundText.has("task-0")).toBe(false);
    expect(view.recentOutboundText.has(`task-${QQ_MAX_TRACKED_RECENT_OUTBOUND + 9}`)).toBe(true);

    const task = await runningMainTask(f);
    view.recentOutboundText.set(task.taskId, [{ text: "短窗正文", at: 0 }]);
    await f.service.handleTaskAction(task.taskId, "stop");
    expect(view.recentOutboundText.has(task.taskId)).toBe(false);
  });

  it("终态任务超保留期后在运行期写入时从内存表回收", async () => {
    const now = Date.now();
    const f = makeFixture({ now: () => now });
    const stale: QqTask = {
      taskId: "task-stale",
      idempotencyKey: "qqbot:m-stale",
      source: { chatType: "private", chatId: "u1", senderId: "u1", msgId: "m-stale" },
      target: { workspace: "/ws" },
      payload: { prompt: "旧任务", attachments: [], contexts: [] },
      policy: { remotePolicy: "supervised", resultDetail: "standard" },
      status: "succeeded" as QqTaskStatus,
      createdAt: 100,
      updatedAt: 100,
      correlation: {},
    };
    f.store.records.set(stale.taskId, stale);

    await f.service.start();
    expect(f.service.getTask(stale.taskId)).toBeDefined();

    // 新建任务触发一次落盘 → sweepTaskMemory 回收超期终态条目（归档不删）。
    await f.service.handleInboundMessage(inbound("/qq task 新任务", "m-fresh"));
    await waitFor(() => f.dispatches.length === 1);
    expect(f.service.getTask(stale.taskId)).toBeNull();
    expect(f.store.records.has(stale.taskId)).toBe(true);
  });
});
