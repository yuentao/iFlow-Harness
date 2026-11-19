/**
 * QQ 主会话路由（QQ 消息固定走主会话）的行为锚点。
 *
 * 只测**纯编排**：宿主能力（注入主会话）由假实现提供，不 spawn CLI、不碰
 * vscode。这里钉住的是用户拍板的那几条语义：
 *  - 入站即回「已排队（第 N 位）」，不派子会话；
 *  - 主会话忙时排队、空闲后按 FIFO 逐条注入，不并发；
 *  - 注入的是带来源包裹的正文（发送方 id 脱敏），转录气泡正文是原文；
 *  - 结果只回传它自己那一轮，停止后不再二次回包；
 *  - 重启后仍未执行的排队项如实告知「请重发」。
 */
import { describe, it, expect } from "vitest";
import type { InboundMessage } from "../src/qq/adapter/types.js";
import type { QqConfig } from "../src/qq/config.js";
import {
  QqService,
  QQ_EMPTY_SUMMARY_NOTICE,
  QQ_MAIN_FINAL_EMPTY_NOTICE,
  buildQqMainPrompt,
  type QqMainInjectInput,
  type QqMainInjectResult,
  type QqServiceDispatchInput,
  type QqServiceHost,
} from "../src/qq/service.js";
import type {
  QqTaskEvent,
  QqTaskIndexEntry,
  QqTaskRecord,
  QqTaskStore,
} from "../src/qq/store.js";
import type { QqTask } from "../shared/qq-task.js";

// ---------------------------------------------------------------------------
// 夹具
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

  async listTasks(): Promise<QqTaskIndexEntry[]> {
    return [...this.records.values()]
      .map((task) => ({
        taskId: task.taskId,
        status: task.status,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        chatId: task.source.chatId,
        senderId: task.source.senderId,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.taskId.localeCompare(b.taskId));
  }

  async appendEvent(event: QqTaskEvent): Promise<void> {
    this.events.push(event);
  }
}

interface Delivered {
  chatType: "private" | "group";
  chatId: string;
  text: string;
  replyToMsgId?: string;
  dedupeKey?: string;
}

interface Injection {
  input: QqMainInjectInput;
  resolve: (result: QqMainInjectResult) => void;
}

interface Fixture {
  service: QqService;
  store: MemoryStore;
  config: QqConfig;
  delivered: Delivered[];
  notes: string[];
  dispatches: QqServiceDispatchInput[];
  injections: Injection[];
  canceledInjections: string[];
}

function makeConfig(overrides: Partial<QqConfig> = {}): QqConfig {
  return {
    enabled: true,
    allowedUsers: ["u1"],
    allowedGroups: ["g1"],
    workspace: "/ws",
    remotePolicy: "supervised",
    maxConcurrentTasks: 2,
    rateLimitPerMin: 6,
    resultDetail: "standard",
    autoMerge: false,
    ...overrides,
  };
}

function makeService(options: {
  config?: Partial<QqConfig>;
  store?: MemoryStore;
  /** 拿掉主会话注入能力，验证「缺失即如实失败」。 */
  withoutInjection?: boolean;
} = {}): Fixture {
  const store = options.store ?? new MemoryStore();
  const delivered: Delivered[] = [];
  const notes: string[] = [];
  const dispatches: QqServiceDispatchInput[] = [];
  const injections: Injection[] = [];
  const canceledInjections: string[] = [];

  const host: QqServiceHost = {
    workspaceRoots: () => ["/ws"],
    dispatchTask: async (input) => {
      dispatches.push(input);
      return { superSessionId: "super-1", branch: "iflow/qq/test" };
    },
    cancelTask: async () => undefined,
    mergeTask: async () => ({ ok: true, detail: "已合并" }),
    discardTask: async () => ({}),
    readTaskOutcome: () => ({ summary: "超流体完成", stopReason: "end_turn" }),
    deliver: async (msg) => {
      delivered.push({ ...msg });
      return { ok: true };
    },
    onPendingUser: () => undefined,
    unbindAccount: async () => ({ ok: true, message: "已解绑" }),
    notify: (text) => {
      notes.push(text);
    },
    ...(options.withoutInjection
      ? {}
      : {
          injectIntoMainSession: (input: QqMainInjectInput) =>
            new Promise<QqMainInjectResult>((resolve) => {
              injections.push({ input, resolve });
            }),
          cancelMainInjection: (taskId: string) => {
            canceledInjections.push(taskId);
            // 真实宿主会立刻让 injectIntoMainSession 以 canceled 收尾。
            const pending = injections.find((entry) => entry.input.task.taskId === taskId);
            pending?.resolve({ injected: false, canceled: true });
            return true;
          },
        }),
  };

  const config = makeConfig(options.config);
  const service = new QqService({
    config,
    store: store as unknown as QqTaskStore,
    host,
    log: () => undefined,
  });
  return { service, store, config, delivered, notes, dispatches, injections, canceledInjections };
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    chatType: "private",
    chatId: "u1",
    senderId: "u1",
    msgId: "m1",
    text: "/qq task 修一下这个问题",
    mentionsBot: false,
    attachments: [],
    timestamp: 0,
    ...overrides,
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** 非 ack 的投递（结果摘要 / 失败说明 / 取消说明）。 */
function resultTexts(f: Fixture): string[] {
  return f.delivered
    .filter(
      (item) =>
        !item.text.startsWith("已受理任务") &&
        !item.text.includes("已排队（第 ") &&
        !item.text.includes("已受理，正在处理"),
    )
    .map((item) => item.text);
}

function onlyTask(f: Fixture): QqTask {
  const summary = f.service.listTasks()[0];
  if (!summary) throw new Error("没有任务");
  const task = f.service.getTask(summary.taskId);
  if (!task) throw new Error("任务不在内存中");
  return task;
}

// ---------------------------------------------------------------------------
// 来源包裹
// ---------------------------------------------------------------------------

describe("buildQqMainPrompt", () => {
  it("首行标注来源，发送方 id 脱敏，正文逐字保留", () => {
    const task = {
      taskId: "T-1",
      source: {
        chatType: "private",
        chatId: "chat-1",
        senderId: "D754D2240C503C2ABE2B236DC1E78D11",
        msgId: "m1",
      },
      payload: { prompt: "把 README 的安装段改成内网镜像", attachments: [], contexts: [] },
    } as unknown as QqTask;
    const text = buildQqMainPrompt(task);
    const firstLine = text.split("\n")[0] ?? "";
    expect(firstLine).toBe("[来自 QQ 用户 D754********8D11 的消息]");
    expect(text).not.toContain("D754D2240C503C2ABE2B236DC1E78D11");
    expect(text).toContain("把 README 的安装段改成内网镜像");
    // 明确告诉模型这是外部消息、回复会回传 QQ（安全边界的一部分）。
    expect(text).toContain("外部消息");
    expect(text).toContain("发回 QQ");
  });

  it("群消息同时脱敏群 id 与发送方；附件引用附在包裹里", () => {
    const task = {
      taskId: "T-2",
      source: {
        chatType: "group",
        chatId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        senderId: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        msgId: "m2",
      },
      payload: {
        prompt: "看下这个日志",
        attachments: ["https://example.com/x.png"],
        contexts: [],
      },
    } as unknown as QqTask;
    const text = buildQqMainPrompt(task);
    expect(text.split("\n")[0]).toBe(
      "[来自 QQ 群 AAAA********AAAA 的用户 BBBB********BBBB 的消息]",
    );
    expect(text).toContain("https://example.com/x.png");
    expect(text).toContain("看下这个日志");
  });
});

// ---------------------------------------------------------------------------
// 入站 → 排队 → 注入
// ---------------------------------------------------------------------------

describe("主会话路由 · 排队与注入", () => {
  it("入站立即回「已排队（第 1 位）」且不派超流体", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(inbound());

    const ack = f.delivered[0];
    expect(ack?.text).toContain("已排队（第 1 位）");
    expect(ack?.replyToMsgId).toBe("m1");
    expect(ack?.dedupeKey).toContain("qq-queued:");
    expect(f.dispatches).toHaveLength(0);

    await waitFor(() => f.injections.length === 1);
    const task = onlyTask(f);
    expect(task.channel).toBe("main");
    expect(task.status).toBe("queued");
  });

  it("注入正文带来源包裹，气泡正文是原文；onInjected 把状态切到已注入待回复", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(inbound({ text: "/qq task 只改这一行" }));
    await waitFor(() => f.injections.length === 1);

    const injection = f.injections[0]!;
    expect(injection.input.origin).toBe("qq");
    expect(injection.input.displayText).toBe("只改这一行");
    expect(injection.input.text).toContain("[来自 QQ 用户");
    expect(injection.input.text).toContain("只改这一行");
    expect(injection.input.signal.aborted).toBe(false);

    await injection.input.onInjected();
    expect(onlyTask(f).status).toBe("injected");
    const ui = f.service.listTasks()[0];
    expect(ui?.status).toBe("injected");
    expect(ui?.channel).toBe("main");
  });

  it("该轮 assistant 文本回传 QQ，且只投递一次", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(inbound());
    await waitFor(() => f.injections.length === 1);
    await f.injections[0]!.input.onInjected();
    f.injections[0]!.resolve({
      injected: true,
      text: "已经派超流体改好了",
      stopReason: "end_turn",
    });

    await waitFor(() => resultTexts(f).length > 0);
    expect(resultTexts(f).join("\n")).toContain("已经派超流体改好了");
    const task = onlyTask(f);
    expect(task.status).toBe("succeeded");
    expect(task.resultDeliveredAt).toBeTypeOf("number");
    expect(task.result?.summary).toBe("已经派超流体改好了");

    // 自动回包只此一次（幂等锚点）；refresh 只是用户主动查摘要，不算重复推送。
    const deliveredAt = task.resultDeliveredAt;
    const before = f.delivered.length;
    await f.service.handleTaskAction(task.taskId, "refresh");
    expect(f.delivered.length).toBe(before + 1);
    expect(f.service.getTask(task.taskId)?.resultDeliveredAt).toBe(deliveredAt);
    expect(f.store.events.filter((event) => event.type === "task_result_delivered")).toHaveLength(1);
  });

  it("空结果回一条如实说明（不伪造内容）", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(inbound());
    await waitFor(() => f.injections.length === 1);
    await f.injections[0]!.input.onInjected();
    f.injections[0]!.resolve({ injected: true, text: "   ", stopReason: "end_turn" });

    await waitFor(() => resultTexts(f).length > 0);
    expect(resultTexts(f).join("\n")).toContain(QQ_EMPTY_SUMMARY_NOTICE);
  });

  it("主会话忙时按 FIFO 排队：第 2 条回「第 2 位」，第一条结束前不并发注入", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(inbound({ msgId: "m1", text: "/qq task 第一件事" }));
    await waitFor(() => f.injections.length === 1);

    await f.service.handleInboundMessage(inbound({ msgId: "m2", text: "/qq task 第二件事" }));
    const secondAck = f.delivered.find((item) => item.text.includes("第 2 位"));
    expect(secondAck, "第二条应收到排队位次确认").toBeTruthy();
    expect(f.injections).toHaveLength(1); // 第一条还没结束 → 不并发注入

    // 第一条结束（注入 + 结果）后才轮到第二条。
    await f.injections[0]!.input.onInjected();
    f.injections[0]!.resolve({ injected: true, text: "第一件完成", stopReason: "end_turn" });
    await waitFor(() => f.injections.length === 2);
    expect(f.injections[1]!.input.displayText).toBe("第二件事");
  });

  it("注入失败如实回包（失败原因原样带回）", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(inbound());
    await waitFor(() => f.injections.length === 1);
    f.injections[0]!.resolve({ injected: false, reason: "主会话长时间未空闲" });

    await waitFor(() => resultTexts(f).length > 0);
    expect(resultTexts(f).join("\n")).toContain("主会话长时间未空闲");
    expect(onlyTask(f).status).toBe("failed");
  });

  it("宿主没有注入能力时如实失败，绝不退化成超流体", async () => {
    const f = makeService({ withoutInjection: true });
    await f.service.handleInboundMessage(inbound());
    await waitFor(() => resultTexts(f).length > 0);
    expect(resultTexts(f).join("\n")).toContain("主会话");
    expect(f.dispatches).toHaveLength(0);
    expect(onlyTask(f).status).toBe("failed");
  });

  it("未授权用户不入队、不回包", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(inbound({ senderId: "stranger" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.delivered).toHaveLength(0);
    expect(f.injections).toHaveLength(0);
    expect(f.service.listTasks()).toHaveLength(0);
  });

  it("同一 msgId 重复到达不重复排队（幂等）", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(inbound({ msgId: "dup" }));
    await f.service.handleInboundMessage(inbound({ msgId: "dup" }));
    expect(f.injections).toHaveLength(1);
    expect(f.delivered.some((item) => item.text.includes("不会重复执行"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 停止 / 重启
// ---------------------------------------------------------------------------

describe("主会话路由 · 停止与重启", () => {
  it("停止排队中的任务：移出队列、回状态，且不会注入", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(inbound({ msgId: "m1", text: "/qq task 第一件事" }));
    await waitFor(() => f.injections.length === 1);
    await f.service.handleInboundMessage(inbound({ msgId: "m2", text: "/qq task 第二件事" }));

    const second = f.service.listTasks().find((task) => task.promptPreview === "第二件事");
    expect(second).toBeTruthy();
    await f.service.handleTaskAction(second!.taskId, "stop");

    expect(f.delivered.some((item) => item.text.includes("已取消排队中的任务"))).toBe(true);
    const stopped = f.service.getTask(second!.taskId);
    expect(stopped?.status).toBe("canceled");

    // 第一条结束后，第二条也不会被注入。
    await f.injections[0]!.input.onInjected();
    f.injections[0]!.resolve({ injected: true, text: "第一件完成", stopReason: "end_turn" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.injections).toHaveLength(1);
  });

  it("停止注入中的任务：中断该轮，且不把这一轮的输出二次回传", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(inbound());
    await waitFor(() => f.injections.length === 1);
    await f.injections[0]!.input.onInjected();
    const taskId = onlyTask(f).taskId;

    await f.service.handleTaskAction(taskId, "stop");
    expect(f.canceledInjections).toContain(taskId);
    expect(f.service.getTask(taskId)?.status).toBe("canceled");

    // 即便那一轮之后才带着正文收尾，也不再回传（结果只属于「未停止」的轮次）。
    const before = f.delivered.length;
    f.injections[0]!.resolve({ injected: true, text: "迟到的一轮输出", stopReason: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.delivered).toHaveLength(before);
    expect(f.delivered.some((item) => item.text.includes("迟到的一轮输出"))).toBe(false);
  });

  it("重启后未执行的排队项如实告知「未执行，请重发」", async () => {
    const store = new MemoryStore();
    // 预置一条「上次运行排队中、尚未来得及注入」的归档（队列是内存态）。
    const archived: QqTask = {
      taskId: "T-archived",
      idempotencyKey: "qqbot:m-archived",
      source: { chatType: "private", chatId: "u1", senderId: "u1", msgId: "m-archived" },
      target: { workspace: "/ws" },
      payload: { prompt: "重启前排队的事", attachments: [], contexts: [] },
      policy: { remotePolicy: "supervised", resultDetail: "standard" },
      status: "queued",
      channel: "main",
      createdAt: 1_000,
      updatedAt: 1_000,
      correlation: {},
    };
    await store.saveTask(archived as unknown as QqTaskRecord);

    const f = makeService({ store });
    await f.service.start();

    const text = f.delivered.map((item) => item.text).join("\n");
    expect(text).toContain("未执行");
    expect(text).toContain("请重新发送");
    const task = f.service.getTask("T-archived");
    expect(task?.status).toBe("failed");
    expect(task?.failure?.code).toBe("host_restarted");
  });
});

// ---------------------------------------------------------------------------
// 最终回执：占位轮不回传，汇总轮回传真正答复
// ---------------------------------------------------------------------------

describe("主会话路由 · 最终回执归属", () => {
  /** 走完入站 + 注入，并让注入轮以 delegated=true 收尾。 */
  async function delegatedTask(): Promise<Fixture> {
    const f = makeService();
    await f.service.handleInboundMessage(inbound());
    await waitFor(() => f.injections.length === 1);
    await f.injections[0]!.input.onInjected();
    f.injections[0]!.resolve({
      injected: true,
      text: "已派超流体去做，先等一下",
      stopReason: "end_turn",
      delegated: true,
    });
    // 等服务把进度回执与记账落盘（status 由 onInjected 提前置好，不能拿来当
    // 「注入轮已收尾」的信号）。
    await waitFor(() => f.delivered.some((item) => item.text.includes("已受理，正在处理")));
    return f;
  }

  it("注入轮只回进度：占位文本不进 result，任务停在 injected 等最终答复", async () => {
    const f = await delegatedTask();
    const task = onlyTask(f);

    expect(task.status).toBe("injected");
    expect(task.result).toBeUndefined();
    expect(task.resultDeliveredAt).toBeUndefined();
    // 占位文本绝不能作为最终结果回给 QQ（既不是 result 文本，也不在投递里）。
    expect(f.delivered.some((item) => item.text.includes("已派超流体去做"))).toBe(false);
    // 但用户能收到一条明确的「已受理、正在处理」进度，不碰幂等锚点。
    expect(f.delivered.some((item) => item.text.includes("已受理，正在处理"))).toBe(true);
  });

  it("汇总轮真正答复单次回传，且只投递一次（非占位文本）", async () => {
    const f = await delegatedTask();
    const taskId = onlyTask(f).taskId;

    await f.service.completeMainFinalAnswer({
      taskId,
      text: "真正最终答复：三个文件都改好了，测试全过。",
      stopReason: "end_turn",
    });

    expect(resultTexts(f).join("\n")).toContain("真正最终答复：三个文件都改好了");
    expect(resultTexts(f).join("\n")).not.toContain("已派超流体去做");
    const done = f.service.getTask(taskId);
    expect(done?.status).toBe("succeeded");
    expect(done?.result?.summary).toBe("真正最终答复：三个文件都改好了，测试全过。");
    expect(done?.resultDeliveredAt).toBeTypeOf("number");
    expect(f.store.events.filter((e) => e.type === "task_result_delivered")).toHaveLength(1);

    // 迟到的第二个汇报轮再调一次：终态幂等，QQ 不会收到第二条矛盾消息。
    const before = f.delivered.length;
    await f.service.completeMainFinalAnswer({ taskId, text: "迟到的第二轮结论", stopReason: "end_turn" });
    expect(f.delivered).toHaveLength(before);
    expect(f.delivered.some((item) => item.text.includes("迟到的第二轮结论"))).toBe(false);
  });

  it("长任务最终回执走主动消息，绕开 (msg_id, msg_seq) 的 TTL 去重窗口", async () => {
    const f = await delegatedTask();
    const taskId = onlyTask(f).taskId;

    await f.service.completeMainFinalAnswer({ taskId, text: "长任务终于完成了", stopReason: "end_turn" });

    // 主动消息不带 replyToMsgId / dedupeKey —— 长任务下被动回复序号窗口
    // （REPLY_SEQ_TTL_MS）早已关闭，复用它会让平台把最终回执静默去重。
    const final = f.delivered.find((item) => item.text.includes("长任务终于完成了"));
    expect(final).toBeTruthy();
    expect(final?.replyToMsgId).toBeUndefined();
    expect(final?.dedupeKey).toBeUndefined();
  });

  it("未注入 / 非主渠道 / 未知任务不会被汇总轮回执污染", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(inbound());
    await waitFor(() => f.injections.length === 1);
    const taskId = onlyTask(f).taskId; // 仍 queued，未注入

    const before = f.delivered.length;
    await f.service.completeMainFinalAnswer({ taskId, text: "不该发出的结论", stopReason: "end_turn" });
    await f.service.completeMainFinalAnswer({ taskId: "unknown", text: "不该发出的结论", stopReason: "end_turn" });
    expect(f.delivered).toHaveLength(before);
    expect(onlyTask(f).status).toBe("queued");
  });

  it("汇总轮回执为空摘要时服务侧防御性兜底（不双重发送）", async () => {
    const f = await delegatedTask();
    const taskId = onlyTask(f).taskId;

    await f.service.completeMainFinalAnswer({ taskId, text: "   ", stopReason: "end_turn" });

    expect(resultTexts(f).join("\n")).toContain(QQ_MAIN_FINAL_EMPTY_NOTICE);
    expect(f.service.getTask(taskId)?.status).toBe("succeeded");
    // 只有一条终态结果，兜底文案不会被 QQ_EMPTY_SUMMARY_NOTICE 再拼一遍。
    expect(resultTexts(f).length).toBe(1);
    expect(resultTexts(f).join("\n")).not.toContain(QQ_EMPTY_SUMMARY_NOTICE);
    expect(f.store.events.filter((e) => e.type === "task_result_delivered")).toHaveLength(1);
  });
});

