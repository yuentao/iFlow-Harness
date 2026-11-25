import { describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "../src/qq/adapter/types.js";
import type { QqConfig } from "../src/qq/config.js";
import type { QqPendingUserInput } from "../src/qq/pending-users.js";
import {
  QqService,
  QQ_DEFAULT_RETENTION_DAYS,
  QQ_PROGRESS_REFRESH_MIN_INTERVAL_MS,
  QQ_RESULT_CHANGED_WHILE_DELIVERING,
  QQ_RESULT_RESTORE_RETRY_MS,
  QQ_RESULT_UNDELIVERED,
  fingerprintChunks,
  qqSpawnPolicyFor,
  qqTaskProjectionChanged,
  QQ_MAX_TRACKED_PROGRESS_SLOTS,
  type QqServiceDispatchInput,
  type QqServiceHost,
} from "../src/qq/service.js";
import type {
  QqTaskEvent,
  QqTaskIndexEntry,
  QqTaskRecord,
  QqTaskStore,
} from "../src/qq/store.js";
import type { SuperPermissionDecision } from "../src/panel/super-agent.js";
import {
  isTerminalStatus,
  shortTaskId,
  type QqTask,
  type QqTaskChannel,
  type QqTaskStatus,
  type QqResultDetail,
} from "../shared/qq-task.js";

// ---------------------------------------------------------------------------
// 假 store（内存）
// ---------------------------------------------------------------------------

class MemoryStore {
  readonly records = new Map<string, QqTask>();
  readonly events: QqTaskEvent[] = [];
  /** pruneTasks 收到的保留天数（测试据此断言「prune 真的被调用」）。 */
  readonly pruneCalls: number[] = [];

  async saveTask(task: QqTaskRecord): Promise<void> {
    this.records.set(task.taskId, JSON.parse(JSON.stringify(task)) as QqTask);
  }

  async loadTask(taskId: string): Promise<QqTask | null> {
    const record = this.records.get(taskId);
    return record ? (JSON.parse(JSON.stringify(record)) as QqTask) : null;
  }

  /** 与 QqTaskStore 同规则：只删「终态 + 超过保留期」的记录。 */
  async pruneTasks(olderThanDays: number): Promise<{ deleted: string[]; skipped: string[] }> {
    this.pruneCalls.push(olderThanDays);
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const deleted: string[] = [];
    for (const [taskId, task] of [...this.records]) {
      if (!isTerminalStatus(task.status) || task.updatedAt >= cutoff) continue;
      this.records.delete(taskId);
      deleted.push(taskId);
    }
    return { deleted, skipped: [] };
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

// ---------------------------------------------------------------------------
// 假 host
// ---------------------------------------------------------------------------

interface DeliveredText {
  chatType: "private" | "group";
  chatId: string;
  text: string;
  replyToMsgId?: string;
  dedupeKey?: string;
}

interface HostFixture {
  host: QqServiceHost;
  delivered: DeliveredText[];
  notes: string[];
  dispatches: QqServiceDispatchInput[];
  cancels: string[];
  merges: string[];
  discards: string[];
  pendingUsers: QqPendingUserInput[];
  unbindCount: { value: number };
}

function makeHost(): HostFixture {
  const delivered: DeliveredText[] = [];
  const notes: string[] = [];
  const dispatches: QqServiceDispatchInput[] = [];
  const cancels: string[] = [];
  const merges: string[] = [];
  const discards: string[] = [];
  const pendingUsers: QqPendingUserInput[] = [];
  const unbindCount = { value: 0 };

  const host: QqServiceHost = {
    workspaceRoots: () => ["/ws"],
    dispatchTask: async (input) => {
      dispatches.push(input);
      return { superSessionId: "super-1", branch: "iflow/qq/test" };
    },
    cancelTask: async (id) => {
      cancels.push(id);
    },
    mergeTask: async (id) => {
      merges.push(id);
      return { ok: true, detail: "已合并" };
    },
    discardTask: async (id) => {
      discards.push(id);
      // 与 panel.ts 的 discard 端口同形：显式 ok:true 才是确认成功。
      return { ok: true };
    },
    readTaskOutcome: () => ({ summary: "完成", stopReason: "end_turn" }),
    deliver: async (msg) => {
      delivered.push({ ...msg });
      return { ok: true };
    },
    onPendingUser: (info) => {
      pendingUsers.push({ ...info });
    },
    unbindAccount: async () => {
      unbindCount.value += 1;
      return { ok: true, message: "已解绑" };
    },
    notify: (text) => {
      notes.push(text);
    },
  };

  return {
    host,
    delivered,
    notes,
    dispatches,
    cancels,
    merges,
    discards,
    pendingUsers,
    unbindCount,
  };
}

// ---------------------------------------------------------------------------
// 通用夹具
// ---------------------------------------------------------------------------

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

interface ServiceFixture extends HostFixture {
  service: QqService;
  store: MemoryStore;
  config: QqConfig;
}

function makeService(options: {
  config?: Partial<QqConfig>;
  store?: MemoryStore;
  now?: () => number;
  monotonicNow?: () => number;
  taskRetentionDays?: number;
  onChanged?: () => void;
  deliveryRetryDelayMs?: number;
  /** 默认 child：本文件多数用例覆盖历史归档 child 任务的收尾路径。 */
  newTaskChannel?: QqTaskChannel;
} = {}): ServiceFixture {
  const config = makeConfig(options.config);
  const fixture = makeHost();
  const store = options.store ?? new MemoryStore();
  const service = new QqService({
    config,
    store: store as unknown as QqTaskStore,
    host: fixture.host,
    now: options.now,
    newTaskChannel: options.newTaskChannel ?? "child",
    log: () => undefined,
    ...(options.monotonicNow ? { monotonicNow: options.monotonicNow } : {}),
    ...(options.taskRetentionDays !== undefined
      ? { taskRetentionDays: options.taskRetentionDays }
      : {}),
    ...(options.onChanged ? { onChanged: options.onChanged } : {}),
    ...(options.deliveryRetryDelayMs !== undefined
      ? { deliveryRetryDelayMs: options.deliveryRetryDelayMs }
      : {}),
  });
  return { ...fixture, service, store, config };
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

/**
 * 归档夹具的时间基准：取「一分钟前」。
 *
 * `start()` 会按保留期清理超期终态任务，若夹具仍用 1000 这类纪元附近的时间，
 * 会被当成几十年前的归档删掉 —— 那不是这些用例要验证的行为。
 */
const SEED_BASE = Date.now() - 60_000;

function seedTask(
  taskId: string,
  status: QqTaskStatus,
  overrides: Partial<QqTask> = {},
): QqTask {
  return {
    taskId,
    idempotencyKey: `qqbot:${taskId}`,
    source: { chatType: "private", chatId: "u1", senderId: "u1", msgId: taskId },
    target: { workspace: "/ws" },
    payload: { prompt: `任务 ${taskId}`, attachments: [], contexts: [] },
    policy: { remotePolicy: "supervised", resultDetail: "standard" },
    status,
    createdAt: SEED_BASE,
    updatedAt: SEED_BASE,
    correlation: {},
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

/**
 * 任务摘要分片：结果回传只受「已受理任务」ack 影响，其余投递都是摘要分片
 * （`chunkQqText` 切开的后续片段不以「QQ 任务」开头，只按前缀过滤会漏掉）。
 */
function summaryChunks(fixture: ServiceFixture): string[] {
  return fixture.delivered
    .filter((item) => !item.text.startsWith("已受理任务"))
    .map((item) => item.text);
}

function lastTask(fixture: ServiceFixture): QqTask {
  const summary = fixture.service.listTasks()[0];
  if (!summary) throw new Error("没有任务");
  const task = fixture.service.getTask(summary.taskId);
  if (!task) throw new Error(`任务 ${summary.taskId} 不在内存中`);
  return task;
}

const APPROVAL_CODE_PATTERN = /\/qq approve \S+ (\d{4})/u;

// ---------------------------------------------------------------------------
// 白名单 / 便捷路径 / 幂等 / 限流
// ---------------------------------------------------------------------------

describe("QqService — 入站准入", () => {
  it("发送者不在白名单时不回包，只记本地通知", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(inbound({ senderId: "u2", chatId: "u2" }));
    expect(f.delivered).toHaveLength(0);
    expect(f.dispatches).toHaveLength(0);
    expect(f.notes.some((line) => line.includes("白名单"))).toBe(true);
  });

  it("群聊未列入 allowedGroups 或未 @ 机器人时静默拒绝", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(
      inbound({ chatType: "group", chatId: "g2", mentionsBot: true }),
    );
    await f.service.handleInboundMessage(
      inbound({ chatType: "group", chatId: "g1", mentionsBot: false }),
    );
    expect(f.delivered).toHaveLength(0);
    expect(f.notes.filter((line) => line.includes("忽略")).length).toBeGreaterThanOrEqual(2);
  });

  it("私聊非命令文本在 enabled 时按任务派发", async () => {
    const f = makeService();
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      return { superSessionId: "simple-1" };
    };
    await f.service.handleInboundMessage(inbound({ text: "帮我看看这个报错" }));
    expect(f.delivered[0]?.text).toContain("已受理任务");
    await waitFor(() => f.service.listTasks().length === 1);
    expect(f.service.listTasks()[0]?.promptPreview).toContain("帮我看看这个报错");
    await waitFor(() => f.dispatches.length === 1);
    expect(f.dispatches[0]?.task.payload.prompt).toBe("帮我看看这个报错");
    await waitFor(() => f.service.listTasks()[0]?.status === "succeeded");
  });

  it("enabled=false 时私聊非命令文本静默忽略", async () => {
    const f = makeService({ config: { enabled: false } });
    await f.service.handleInboundMessage(inbound({ text: "帮我看看这个报错" }));
    expect(f.delivered).toHaveLength(0);
    expect(f.service.listTasks()).toHaveLength(0);
  });
});

describe("QqService — 建任务 / 幂等 / 限流", () => {
  it("同一 msgId 重复投递只建一个任务，第二次回已受理", async () => {
    const f = makeService();
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      return { superSessionId: "one" };
    };
    await f.service.handleInboundMessage(inbound({ msgId: "same", text: "/qq task 一" }));
    await f.service.handleInboundMessage(inbound({ msgId: "same", text: "/qq task 一" }));
    expect(f.service.listTasks()).toHaveLength(1);
    const acks = f.delivered.filter((item) => item.text.includes("已受理任务"));
    expect(acks).toHaveLength(2);
    expect(acks[1]?.text).toContain("不会重复执行");
    await waitFor(() => f.dispatches.length === 1);
  });

  it("滑动窗口限流：超出时明确提示且不建任务", async () => {
    const f = makeService({ config: { rateLimitPerMin: 2 }, now: () => 1_000_000 });
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      return { superSessionId: "rate" };
    };
    await f.service.handleInboundMessage(inbound({ msgId: "r1" }));
    await f.service.handleInboundMessage(inbound({ msgId: "r2" }));
    await f.service.handleInboundMessage(inbound({ msgId: "r3" }));
    expect(f.service.listTasks()).toHaveLength(2);
    expect(f.delivered.some((item) => item.text.includes("请求过于频繁"))).toBe(true);
  });

  it("提示词超长时拒绝并回可读原因", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(
      inbound({ text: `/qq task ${"长".repeat(4001)}` }),
    );
    expect(f.service.listTasks()).toHaveLength(0);
    expect(f.delivered.some((item) => item.text.includes("超过上限"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 调度 / 并发 / 策略映射
// ---------------------------------------------------------------------------

describe("QqService — 调度与并发", () => {
  it("并发上限为 1 时第二个任务排队，完成后依次启动", async () => {
    const f = makeService({ config: { maxConcurrentTasks: 1 } });
    const releases: Array<(value: { superSessionId: string }) => void> = [];
    f.host.dispatchTask = (input) => {
      f.dispatches.push(input);
      return new Promise((resolve) => {
        releases.push(resolve);
      });
    };
    await f.service.handleInboundMessage(inbound({ msgId: "q1" }));
    await f.service.handleInboundMessage(inbound({ msgId: "q2" }));

    await waitFor(() => f.dispatches.length === 1);
    const statuses = f.service.listTasks().map((task) => task.status);
    expect(statuses.filter((status) => status === "running")).toHaveLength(1);
    expect(statuses.filter((status) => status === "queued")).toHaveLength(1);

    releases[0]!({ superSessionId: "s1" });
    await waitFor(() => f.dispatches.length === 2);
    releases[1]!({ superSessionId: "s2" });
    await waitFor(() =>
      f.service.listTasks().every((task) =>
        ["succeeded", "failed", "needs_review", "canceled", "timeout"].includes(task.status),
      ),
    );
  });

  it("策略映射：readonly / supervised / trusted 与未知值", () => {
    expect(qqSpawnPolicyFor("readonly")).toEqual({
      approval: "deny",
      disallowedTools: [
        "write_file",
        "replace",
        "multi_edit",
        "run_shell_command",
        "xml_escape",
      ],
    });
    expect(qqSpawnPolicyFor("supervised")).toEqual({
      approval: "supervised",
      disallowedTools: [],
    });
    expect(qqSpawnPolicyFor("trusted")).toEqual({ approval: "auto", disallowedTools: [] });
    expect(qqSpawnPolicyFor("dirty-value")).toEqual({
      approval: "supervised",
      disallowedTools: [],
    });
  });

  it("派发时把配置的 remotePolicy 映射成 approval 与工具黑名单", async () => {
    const trusted = makeService({ config: { remotePolicy: "trusted" } });
    await trusted.service.handleInboundMessage(inbound({ msgId: "p1" }));
    await waitFor(() => trusted.dispatches.length === 1);
    expect(trusted.dispatches[0]?.approval).toBe("auto");
    expect(trusted.dispatches[0]?.disallowedTools).toEqual([]);

    const readonly = makeService({
      config: { remotePolicy: "readonly" as unknown as QqConfig["remotePolicy"] },
    });
    await readonly.service.handleInboundMessage(inbound({ msgId: "p2" }));
    await waitFor(() => readonly.dispatches.length === 1);
    expect(readonly.dispatches[0]?.approval).toBe("deny");
    expect(readonly.dispatches[0]?.disallowedTools).toContain("write_file");
    expect(readonly.dispatches[0]?.disallowedTools).toContain("run_shell_command");

    const supervised = makeService({ config: { remotePolicy: "supervised" } });
    await supervised.service.handleInboundMessage(inbound({ msgId: "p3" }));
    await waitFor(() => supervised.dispatches.length === 1);
    expect(supervised.dispatches[0]?.approval).toBe("supervised");
    expect(supervised.dispatches[0]?.disallowedTools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 审批桥
// ---------------------------------------------------------------------------

describe("QqService — 审批桥", () => {
  it("正确验证码放行，任务最终收尾", async () => {
    const f = makeService();
    let decision: SuperPermissionDecision | undefined;
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      decision = await input.onPermission({
        sessionId: "s-1",
        toolName: "run_shell_command",
        summary: "运行测试",
      });
      return { superSessionId: "super-approve" };
    };

    await f.service.handleInboundMessage(inbound({ msgId: "a1" }));
    await waitFor(() => lastTask(f).status === "waiting_approval");

    const approvalMessage = f.delivered.find((item) => item.text.includes("/qq approve"));
    expect(approvalMessage).toBeDefined();
    const code = APPROVAL_CODE_PATTERN.exec(approvalMessage!.text)?.[1];
    expect(code).toMatch(/^\d{4}$/u);

    const taskId = lastTask(f).taskId;
    await f.service.handleTaskAction(taskId, "approve", code);
    await waitFor(() => decision !== undefined);
    expect(decision).toBe("allow_once");
    await waitFor(() => lastTask(f).status === "succeeded");
    expect(f.notes.some((line) => line.includes("等待审批"))).toBe(true);
  });

  it("审批回执首行用任务标题，但 /qq approve|deny 命令参数保留短 id", async () => {
    const f = makeService();
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      await input.onPermission({
        sessionId: "s-title",
        toolName: "run_shell_command",
        summary: "运行测试",
      });
      return { superSessionId: "super-title" };
    };

    await f.service.handleInboundMessage(inbound({ msgId: "a-title" }));
    await waitFor(() => lastTask(f).status === "waiting_approval");
    const taskId = lastTask(f).taskId;
    const message = f.delivered.find((item) => item.text.includes("/qq approve"))!;
    const firstLine = message.text.split("\n")[0]!;

    // 首行是展示位：用户消息「修一下这个问题」当标题，不再是裸短 id。
    expect(firstLine).toContain("任务 修一下这个问题 请求审批");
    expect(firstLine).not.toContain(`任务 ${shortTaskId(taskId)} 请求审批`);
    // 关键回归：命令参数位必须仍是短 id，否则回复的命令无法定位任务。
    expect(message.text).toContain(`/qq approve ${shortTaskId(taskId)} `);
    expect(message.text).toContain(`/qq deny ${shortTaskId(taskId)} 拒绝`);
  });

  it("错误验证码保留机会，连续三次错误按拒绝处理", async () => {
    const f = makeService();
    let decision: SuperPermissionDecision | undefined;
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      decision = await input.onPermission({
        sessionId: "s-2",
        toolName: "write_file",
        summary: "写文件",
      });
      return { superSessionId: "super-wrong" };
    };

    await f.service.handleInboundMessage(inbound({ msgId: "a2" }));
    await waitFor(() => lastTask(f).status === "waiting_approval");
    const message = f.delivered.find((item) => item.text.includes("/qq approve"))!;
    const code = APPROVAL_CODE_PATTERN.exec(message.text)?.[1] ?? "1234";
    const wrong = code === "0000" ? "1111" : "0000";
    const taskId = lastTask(f).taskId;

    await f.service.handleTaskAction(taskId, "approve", wrong);
    expect(f.delivered.some((item) => item.text.includes("还可再试 2 次"))).toBe(true);
    expect(lastTask(f).status).toBe("waiting_approval");

    await f.service.handleTaskAction(taskId, "approve", wrong);
    expect(f.delivered.some((item) => item.text.includes("还可再试 1 次"))).toBe(true);

    await f.service.handleTaskAction(taskId, "approve", wrong);
    await waitFor(() => decision !== undefined);
    expect(decision).toBe("deny");
    expect(f.delivered.some((item) => item.text.includes("次数过多"))).toBe(true);
  });

  it("deny 直接拒绝", async () => {
    const f = makeService();
    let decision: SuperPermissionDecision | undefined;
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      decision = await input.onPermission({
        sessionId: "s-3",
        toolName: "write_file",
        summary: "写文件",
      });
      return { superSessionId: "super-deny" };
    };

    await f.service.handleInboundMessage(inbound({ msgId: "a3" }));
    await waitFor(() => lastTask(f).status === "waiting_approval");
    const taskId = lastTask(f).taskId;
    await f.service.handleTaskAction(taskId, "deny");
    await waitFor(() => decision !== undefined);
    expect(decision).toBe("deny");
  });

  it("审批超时 4 分钟后按拒绝处理", async () => {
    vi.useFakeTimers();
    try {
      let nowValue = 5_000_000;
      const f = makeService({ now: () => nowValue });
      let decision: SuperPermissionDecision | undefined;
      f.host.dispatchTask = async (input) => {
        f.dispatches.push(input);
        decision = await input.onPermission({
          sessionId: "s-4",
          toolName: "edit_file",
          summary: "编辑",
        });
        return { superSessionId: "super-timeout" };
      };

      await f.service.handleInboundMessage(inbound({ msgId: "a4" }));
      for (let i = 0; i < 20 && lastTask(f).status !== "waiting_approval"; i += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(lastTask(f).status).toBe("waiting_approval");

      nowValue += 240_000;
      await vi.advanceTimersByTimeAsync(240_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(decision).toBe("deny");
      expect(
        f.delivered.some((item) => item.text.includes("审批超时")),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() 会把所有等待审批的请求按拒绝放行", async () => {
    const f = makeService();
    let decision: SuperPermissionDecision | undefined;
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      decision = await input.onPermission({
        sessionId: "s-5",
        toolName: "run_shell_command",
        summary: "跑命令",
      });
      return { superSessionId: "super-stop" };
    };

    await f.service.handleInboundMessage(inbound({ msgId: "a5" }));
    await waitFor(() => lastTask(f).status === "waiting_approval");
    await f.service.stop();
    await waitFor(() => decision !== undefined);
    expect(decision).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// 终态映射 / 结果分片
// ---------------------------------------------------------------------------

describe("QqService — 终态与结果回传", () => {
  it("有分支且未开启自动合并 → needs_review，且不调用 mergeTask", async () => {
    const f = makeService({ config: { autoMerge: false } });
    await f.service.handleInboundMessage(inbound({ msgId: "t1" }));
    await waitFor(() => lastTask(f).status === "needs_review");
    expect(f.merges).toHaveLength(0);
    expect(lastTask(f).correlation.branch).toBe("iflow/qq/test");
  });

  it("开启自动合并且合并成功 → succeeded", async () => {
    const f = makeService({ config: { autoMerge: true } });
    await f.service.handleInboundMessage(inbound({ msgId: "t2" }));
    await waitFor(() => lastTask(f).status === "succeeded");
    expect(f.merges).toEqual(["super-1"]);
  });

  it("自动合并失败 → needs_review", async () => {
    const f = makeService({ config: { autoMerge: true } });
    f.host.mergeTask = async (id) => {
      f.merges.push(id);
      return { ok: false, detail: "冲突" };
    };
    await f.service.handleInboundMessage(inbound({ msgId: "t3" }));
    await waitFor(() => lastTask(f).status === "needs_review");
    expect(f.merges).toEqual(["super-1"]);
  });

  it("失败停止原因 → failed，并带可读错误", async () => {
    const f = makeService();
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      return { superSessionId: "super-fail" };
    };
    f.host.readTaskOutcome = () => ({ summary: "出错", stopReason: "error" });
    await f.service.handleInboundMessage(inbound({ msgId: "t4" }));
    await waitFor(() => lastTask(f).status === "failed");
    expect(f.service.listTasks()[0]?.errorMessage).toContain("error");
  });

  it("读不到结果 → failed(no_outcome)", async () => {
    const f = makeService();
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      return { superSessionId: "super-null" };
    };
    f.host.readTaskOutcome = () => null;
    await f.service.handleInboundMessage(inbound({ msgId: "t5" }));
    await waitFor(() => lastTask(f).status === "failed");
    expect(f.service.listTasks()[0]?.errorMessage).toContain("没有返回任务结果");
  });

  it("compact 档不回摘要正文；standard 档截断；detailed 档分片且含改动明细", async () => {
    const compact = makeService({ config: { resultDetail: "compact" as QqResultDetail } });
    compact.host.dispatchTask = async (input) => {
      compact.dispatches.push(input);
      return { superSessionId: "d-compact" };
    };
    compact.host.readTaskOutcome = () => ({
      summary: `SECRETBODY-${"甲".repeat(100)}`,
      stopReason: "end_turn",
    });
    await compact.service.handleInboundMessage(inbound({ msgId: "d1" }));
    await waitFor(() => summaryChunks(compact).length > 0);
    expect(summaryChunks(compact).some((text) => text.includes("SECRETBODY"))).toBe(false);

    const standard = makeService({ config: { resultDetail: "standard" } });
    standard.host.dispatchTask = async (input) => {
      standard.dispatches.push(input);
      return { superSessionId: "d-standard" };
    };
    standard.host.readTaskOutcome = () => ({
      summary: `${"乙".repeat(2_000)}TAILTOKEN`,
      stopReason: "end_turn",
    });
    await standard.service.handleInboundMessage(inbound({ msgId: "d2" }));
    await waitFor(() => summaryChunks(standard).length > 0);
    const standardText = summaryChunks(standard).join("\n");
    expect(standardText).toContain("摘要");
    expect(standardText).not.toContain("TAILTOKEN");
    expect(standardText.length).toBeLessThan(3_000);

    const detailed = makeService({ config: { resultDetail: "detailed" as QqResultDetail } });
    detailed.host.dispatchTask = async (input) => {
      detailed.dispatches.push(input);
      return { superSessionId: "d-full" };
    };
    detailed.host.readTaskOutcome = () => ({
      summary: `${"丙".repeat(25_000)}TAILTOKEN`,
      stopReason: "end_turn",
      changes: [{ path: "src/x.ts", additions: 3, deletions: 1 }],
    });
    await detailed.service.handleInboundMessage(inbound({ msgId: "d3" }));
    await waitFor(() => summaryChunks(detailed).length >= 2);
    const chunks = summaryChunks(detailed);
    expect(chunks.every((chunk) => chunk.length <= 12_000)).toBe(true);
    const joined = chunks.join("\n");
    expect(joined).toContain("摘要");
    expect(joined).toContain("改动明细");
    expect(joined).toContain("src/x.ts");
    expect(joined).toContain("TAILTOKEN");
  });
});

// ---------------------------------------------------------------------------
// 终态写回 / 真实耗时 / 结果回包（2026-11-17 用户实测回归）
// ---------------------------------------------------------------------------

describe("QqService — 终态写回与结果回包", () => {
  it("回合结束后写终态、记录真实耗时，并把结果回包一次", async () => {
    let clock = 1_000;
    const f = makeService({ now: () => clock });
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      clock = 61_000; // 子会话跑了 60 秒
      return { superSessionId: "super-1", branch: "iflow/qq/test" };
    };

    await f.service.handleInboundMessage(inbound({ msgId: "e1" }));
    await waitFor(() => lastTask(f).status === "needs_review");

    const task = lastTask(f);
    // 终态 + 真实耗时：updatedAt 是收尾时刻，不是创建时刻（否则卡片永远 0 秒）。
    expect(task.updatedAt).toBeGreaterThan(task.createdAt);
    expect(task.updatedAt - task.createdAt).toBe(60_000);
    expect(task.resultDeliveredAt).toBe(61_000);
    expect(task.deliveryError).toBeUndefined();

    // 结果只回一次，且是真的结果摘要（不是「已受理」ack）。
    const results = summaryChunks(f);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain("QQ 任务");
    expect(results[0]).toContain("needs_review");
  });

  it("任务每次状态变化都通知宿主刷新投影（onChanged）", async () => {
    const changes: string[] = [];
    const f = makeService({
      onChanged: () => {
        changes.push(lastTask(f).status);
      },
    });

    await f.service.handleInboundMessage(inbound({ msgId: "e2" }));
    await waitFor(() => lastTask(f).status === "needs_review");

    // 至少覆盖 建任务 → 派发 → 运行 → 终态 这几档，否则看板只会停在中途。
    expect(changes).toContain("validated");
    expect(changes).toContain("queued");
    expect(changes).toContain("dispatched");
    expect(changes).toContain("running");
    expect(changes).toContain("needs_review");
  });

  it("被动回复送达失败时退回主动消息，送达后仍记为已回包", async () => {
    const f = makeService({ deliveryRetryDelayMs: 0 });
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      return { superSessionId: "super-active" };
    };
    const attempts: Array<{ text: string; replyToMsgId?: string }> = [];
    f.host.deliver = async (msg) => {
      attempts.push({ text: msg.text, ...(msg.replyToMsgId ? { replyToMsgId: msg.replyToMsgId } : {}) });
      // 被动回复（带 msg_id）一律失败，模拟回复窗口已过期；主动消息可达。
      return msg.replyToMsgId === undefined ? { ok: true } : { ok: false, retryable: true };
    };

    await f.service.handleInboundMessage(inbound({ msgId: "e3" }));
    await waitFor(() => lastTask(f).resultDeliveredAt !== undefined);

    const resultAttempts = attempts.filter((item) => item.text.includes("QQ 任务"));
    expect(resultAttempts.length).toBeGreaterThanOrEqual(2);
    expect(resultAttempts[0]?.replyToMsgId).toBe("e3");
    expect(resultAttempts.some((item) => item.replyToMsgId === undefined)).toBe(true);
    expect(lastTask(f).deliveryError).toBeUndefined();
  });

  it("结果彻底送不出去时记录 deliveryError 并本地提示，不静默丢弃", async () => {
    const f = makeService({
      config: { resultDetail: "compact" as QqResultDetail },
      deliveryRetryDelayMs: 0,
    });
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      return { superSessionId: "super-down" };
    };
    f.host.deliver = async () => ({ ok: false, retryable: true });

    await f.service.handleInboundMessage(inbound({ msgId: "e4" }));
    await waitFor(() => Boolean(lastTask(f).deliveryError));

    const task = lastTask(f);
    expect(task.deliveryError).toContain("未能送达");
    // 回包失败不改写任务本身的终态：执行确实结束了，如实区分两件事。
    expect(task.status).toBe("succeeded");
    expect(task.resultDeliveredAt).toBeUndefined();
    expect(f.notes.some((line) => line.includes("未能送达"))).toBe(true);
    // 看板也要看得见（QqTaskUi.errorMessage）。
    expect(f.service.listTasks()[0]?.errorMessage).toContain("未能送达");
  });

  it("执行体没返回摘要时仍回一条如实的兜底说明", async () => {
    const f = makeService();
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      return { superSessionId: "super-empty" };
    };
    f.host.readTaskOutcome = () => ({ summary: "", stopReason: "end_turn" });

    await f.service.handleInboundMessage(inbound({ msgId: "e5" }));
    await waitFor(() => lastTask(f).resultDeliveredAt !== undefined);

    const text = summaryChunks(f).join("\n");
    expect(text).toContain("QQ 任务");
    expect(text).toContain("未返回摘要内容");
  });

  it("手动刷新不会把已送达的结果重复回包（幂等）", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(inbound({ msgId: "e6" }));
    await waitFor(() => summaryChunks(f).length > 0 && lastTask(f).resultDeliveredAt !== undefined);

    const before = summaryChunks(f).length;
    await f.service.handleTaskAction(lastTask(f).taskId, "refresh");
    await f.service.handleTaskAction(lastTask(f).taskId, "refresh");

    expect(summaryChunks(f)).toHaveLength(before);
  });

  it("宿主重启的中断也回一条通知，不让用户只看到「已受理」", async () => {
    const store = new MemoryStore();
    store.records.set("T-seed-run002", seedTask("T-seed-run002", "running"));
    const f = makeService({ store, now: () => 2_000, deliveryRetryDelayMs: 0 });

    await f.service.start();

    expect(f.delivered.some((item) => item.text.includes("扩展宿主重启而中断"))).toBe(true);
    expect(f.service.getTask("T-seed-run002")?.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// 回包可靠性缺口回归（2026-11-17）
// ---------------------------------------------------------------------------

describe("QqService — 回包可靠性缺口回归", () => {
  it("运行中刷新只回进度、不写中间 result，终态结果仍能送达且只送一次", async () => {
    let releaseDispatch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const f = makeService();
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      // 模拟 panel-host：spawnTask 后同步回填 correlation，再等待收尾。
      // （service 层要等 dispatchTask resolve 才写 correlated，回填必须发生在
      // 挂起之前，否则运行中刷新读不到 superSessionId。）
      input.task.correlation.superSessionId = "super-refresh-run";
      await gate; // 挂起派发：任务停在 running，finalize 尚未跑
      return { superSessionId: "super-refresh-run" };
    };
    // 运行中：没有 stopReason、没有摘要 —— 旧实现会拿占位文案 + 缺省 end_turn
    // 把「中间结果」写进幂等锚点，永久抑制真正的终态回包。
    f.host.readTaskOutcome = () => ({ summary: "", status: "running" });

    await f.service.handleInboundMessage(inbound({ msgId: "e-rr-1" }));
    await waitFor(() => f.dispatches.length === 1 && lastTask(f).status === "running");

    // 运行中刷新：只回一句进度，不写 result / 锚点。
    await f.service.handleTaskAction(lastTask(f).taskId, "refresh");
    const duringRun = lastTask(f);
    expect(duringRun.result).toBeUndefined();
    expect(duringRun.resultDeliveredAt).toBeUndefined();
    expect(duringRun.resultDeliveredChunks).toBeUndefined();
    const progress = f.delivered.filter((item) => item.text.includes("尚未结束"));
    expect(progress).toHaveLength(1);
    expect(progress[0]!.text).toContain("running");
    // 中间 result 不污染看板：没有伪造的 stopReason。
    expect(f.service.listTasks()[0]?.stopReason).toBeUndefined();

    // 子会话真正收尾：finalize 应送达终态结果（刷新不抑制它）。
    f.host.readTaskOutcome = () => ({
      summary: "真的改好了，附上验证结果。",
      status: "completed",
      stopReason: "end_turn",
    });
    releaseDispatch();
    await waitFor(() => lastTask(f).status === "succeeded");

    const done = lastTask(f);
    expect(done.result?.summary).toBe("真的改好了，附上验证结果。");
    expect(done.resultDeliveredAt).toBeDefined();
    const finalResults = f.delivered.filter((item) => item.text.includes("真的改好了"));
    expect(finalResults).toHaveLength(1);
  });

  it("投递进行中并发刷新不重复发送（在飞标记复用同一次投递）", async () => {
    let releaseDelivery!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const f = makeService();
    const delivered: string[] = [];
    let resultGating = false;
    f.host.deliver = async (msg) => {
      delivered.push(msg.text);
      // 只对结果摘要的投递挂起，模拟平台慢响应（锚点要等全部片发完才落盘）。
      if (msg.text.includes("QQ 任务") && !resultGating) {
        resultGating = true;
        await gate;
      }
      return { ok: true };
    };
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      return { superSessionId: "super-race" };
    };
    f.host.readTaskOutcome = () => ({
      summary: "并发刷新不该造成二次投递",
      status: "completed",
      stopReason: "end_turn",
    });

    const main = f.service.handleInboundMessage(inbound({ msgId: "e-race-1" }));
    await waitFor(() => delivered.some((text) => text.includes("QQ 任务")));

    // 投递进行中并发触发刷新：读到的 resultDeliveredAt 还是 undefined。
    const refresh = f.service.handleTaskAction(lastTask(f).taskId, "refresh");
    releaseDelivery();
    await Promise.all([main, refresh]);

    const results = delivered.filter((text) => text.includes("QQ 任务"));
    expect(results).toHaveLength(1);
    expect(lastTask(f).resultDeliveredAt).toBeDefined();
  });

  it("同一逻辑消息的重试复用同一 dedupeKey；不同逻辑投递使用不同 key", async () => {
    const f = makeService({ deliveryRetryDelayMs: 0 });
    const passiveKeys: Array<string | undefined> = [];
    // 被动回复与主动消息全部失败（可重试）→ 每个逻辑投递会烧满 3 次 attempt。
    f.host.deliver = async (msg) => {
      if (msg.replyToMsgId !== undefined && msg.dedupeKey !== undefined) {
        passiveKeys.push(msg.dedupeKey);
      }
      return { ok: false, retryable: true };
    };
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      return { superSessionId: `super-${f.dispatches.length}` };
    };
    f.host.readTaskOutcome = () => ({
      summary: "重试去重键验证",
      status: "completed",
      stopReason: "end_turn",
    });

    await f.service.handleInboundMessage(inbound({ msgId: "e-key-1" }));
    await waitFor(() => Boolean(lastTask(f).deliveryError));
    const firstResultKeys = passiveKeys.splice(0);

    // 同一逻辑消息的 3 次 attempt 必须全部复用同一个 key（adapter 据此复用
    // 同一个 msg_seq，平台按 (msg_id, msg_seq) 去重）。
    expect(firstResultKeys.length).toBeGreaterThan(0);
    const uniqueInFirst = new Set(firstResultKeys);
    expect(uniqueInFirst.size).toBe(1);

    // 第二条任务的结果投递是新的逻辑消息：key 必须与第一条不同。
    await f.service.handleInboundMessage(inbound({ msgId: "e-key-2" }));
    await waitFor(() => passiveKeys.length > 0);
    expect(new Set(passiveKeys).size).toBe(1);
    expect(passiveKeys[0]).not.toBe(firstResultKeys[0]);
  });

  it("retryable:false 的确定性拒绝不重试，直接走兜底/记录", async () => {
    const f = makeService({ deliveryRetryDelayMs: 0 });
    const attempts: string[] = [];
    f.host.deliver = async (msg) => {
      attempts.push(msg.text);
      return { ok: false, retryable: false }; // 4xx 类确定性拒绝
    };
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      return { superSessionId: "super-reject" };
    };
    f.host.readTaskOutcome = () => ({
      summary: "确定性拒绝验证",
      status: "completed",
      stopReason: "end_turn",
    });

    await f.service.handleInboundMessage(inbound({ msgId: "e-rej-1" }));
    await waitFor(() => Boolean(lastTask(f).deliveryError));

    // 每次 attempt 只做「被动力 → 主动力兜底」各一次，且断言拒绝后不再重试：
    // 3 次重试窗口一次都没被烧（结果投递恰 1 次被动 + 1 次主动兜底）。
    const resultAttempts = attempts.filter((text) => text.includes("QQ 任务"));
    expect(resultAttempts).toHaveLength(2);
    expect(lastTask(f).status).toBe("succeeded");
    expect(lastTask(f).resultDeliveredAt).toBeUndefined();
  });

  it("执行失败与回包失败同时可见（errorMessage 拼接，不互斥覆盖）", async () => {
    const f = makeService({ deliveryRetryDelayMs: 0 });
    f.host.deliver = async () => ({ ok: false, retryable: true });
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      return { superSessionId: "super-both" };
    };
    f.host.readTaskOutcome = () => ({
      summary: "",
      status: "failed",
      stopReason: "error",
    });

    await f.service.handleInboundMessage(inbound({ msgId: "e-both-1" }));
    await waitFor(() => lastTask(f).status === "failed");
    await waitFor(() => Boolean(lastTask(f).deliveryError));

    const ui = f.service.listTasks()[0]!;
    expect(ui.errorMessage).toContain("执行失败");
    expect(ui.errorMessage).toContain("执行结束：error");
    expect(ui.errorMessage).toContain("回包失败");
    expect(f.service.getTask(lastTask(f).taskId)?.failure?.message).toContain("执行结束：error");
  });

  describe("persist 去重（关键字段集合比较）", () => {
    it("字段等价的重复记录不推快照；仅 pending 变化会推一次", () => {
      const base = seedTask("T-proj-1", "running", {
        pending: { kind: "approval", text: "等待审批", at: 1 },
        result: {
          stopReason: "end_turn",
          summary: "汇总",
          changes: [],
          artifacts: [],
        },
        correlation: { superSessionId: "super-p" },
      });
      // 同一记录重复 persist（spread 重建、字段等价）：不推快照。
      expect(qqTaskProjectionChanged(base, { ...base })).toBe(false);
      expect(qqTaskProjectionChanged(base, { ...base, pending: { ...base.pending! } })).toBe(false);
      // 仅 pending 变化（updatedAt / status 都不变）：必须推一次。
      expect(qqTaskProjectionChanged(base, { ...base, pending: undefined })).toBe(true);
    });

    it("result / failure / correlation / 回包锚点任一变化都会推快照", () => {
      const base = seedTask("T-proj-2", "running");
      const result2 = {
        stopReason: "end_turn",
        summary: "新结果",
        changes: [],
        artifacts: [],
      };
      expect(qqTaskProjectionChanged(base, { ...base, result: result2 })).toBe(true);
      expect(
        qqTaskProjectionChanged(base, { ...base, failure: { code: "x", message: "y" } }),
      ).toBe(true);
      expect(
        qqTaskProjectionChanged(base, { ...base, correlation: { superSessionId: "s" } }),
      ).toBe(true);
      expect(qqTaskProjectionChanged(base, { ...base, resultDeliveredAt: 9 })).toBe(true);
      expect(qqTaskProjectionChanged(base, { ...base, deliveryError: "boom" })).toBe(true);
      expect(
        qqTaskProjectionChanged(base, {
          ...base,
          resultDeliveredChunks: { count: 1, fingerprint: "f" },
        }),
      ).toBe(true);
      expect(qqTaskProjectionChanged(base, { ...base, status: "succeeded" })).toBe(true);
      expect(qqTaskProjectionChanged(base, { ...base, updatedAt: 9_999 })).toBe(true);
    });

    it("fingerprintChunks：任一片文本变化都改变指纹，片数也参与", () => {
      const chunks = ["第一片", "第二片"];
      const fingerprint = fingerprintChunks(chunks);
      expect(fingerprintChunks([...chunks])).toBe(fingerprint);
      expect(fingerprintChunks(["第一片改", "第二片"])).not.toBe(fingerprint);
      expect(fingerprintChunks(["第一片"])).not.toBe(fingerprint);
    });

    it("重试不会因内容不变重复推快照（同一份结果的重复 persist 是 noop）", () => {
      const base = seedTask("T-proj-3", "succeeded", {
        result: { stopReason: "end_turn", summary: "s", changes: [], artifacts: [] },
        resultDeliveredAt: 100,
      });
      const rebuilt: QqTask = JSON.parse(JSON.stringify(base)) as QqTask;
      // 落盘再读回（store 深拷贝）后内容等价：重复 persist 不该再推快照。
      expect(qqTaskProjectionChanged(base, rebuilt)).toBe(false);
    });
  });

  it("执行体确认取消的超流体收成 canceled 终态（与 /qq stop 对齐，不再记 failed）", async () => {
    const f = makeService();
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      return { superSessionId: "super-cancel" };
    };
    f.host.readTaskOutcome = () => ({
      summary: "",
      status: "cancelled",
      // 英式拼写也要归一成 canceled：旧实现只匹配 "canceled"，"cancelled"
      // 会落进 isFailureStopReason → failed。
      stopReason: "cancelled",
    });

    await f.service.handleInboundMessage(inbound({ msgId: "e-cancel-1" }));
    await waitFor(() => lastTask(f).status === "canceled");

    const task = lastTask(f);
    expect(task.status).toBe("canceled");
    expect(task.failure?.code).toBe("agent_canceled");
    const ui = f.service.listTasks()[0]!;
    expect(ui.status).toBe("canceled");
    // 取消是用户主动动作：看板不借用「执行失败」前缀。
    expect(ui.errorMessage).toContain("已取消");
    expect(ui.errorMessage).not.toContain("执行失败");
    // 摘要同样中性：不再出现「失败 agent_canceled」与「执行结束」。
    const sent = f.delivered.map((item) => item.text).join("\n");
    expect(sent).toContain("取消");
    expect(sent).not.toContain("执行失败");
    expect(sent).not.toContain("执行结束");
  });

  it("多片结果中途失败后从下一片续发，不重发已送达片", async () => {
    const f = makeService({
      config: { resultDetail: "full" },
      deliveryRetryDelayMs: 0,
    });
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      return { superSessionId: "super-partial" };
    };
    // full 档档位期望预算 12000 字符（实际被 QQ_CHUNK_MAX_CHARS 收紧到
    // 3000 码点）：造超长摘要强制 chunkQqText 分片。
    const longSummary = Array.from(
      { length: 150 },
      (_, i) => `第 ${i} 项：${"摘要正文填充内容。".repeat(9)}`,
    ).join("\n");
    f.host.readTaskOutcome = () => ({
      summary: longSummary,
      status: "completed",
      stopReason: "end_turn",
    });

    const deliveredTexts: string[] = [];
    let firstRound = true;
    f.host.deliver = async (msg) => {
      deliveredTexts.push(msg.text);
      if (msg.text.startsWith("已受理任务")) return { ok: true }; // ack 不参与分片
      if (!firstRound) return { ok: true };
      // 第一轮：第一片（以「QQ 任务」开头）成功送达，续片一律失败。
      if (msg.text.startsWith("QQ 任务")) return { ok: true };
      return { ok: false, retryable: true };
    };

    await f.service.handleInboundMessage(inbound({ msgId: "e-part-1" }));
    await waitFor(() => Boolean(lastTask(f).deliveryError));

    const failed = lastTask(f);
    expect(failed.deliveryError).toContain("已送达 1/");
    // 尾片失败诚实化：剩余片明确归因「主动消息不可用」，并给出 /qq result
    // 的补救路径 —— 不静默、不虚报整体成功。
    expect(failed.deliveryError).toContain("主动消息不可用");
    expect(failed.deliveryError).toContain("/qq result");
    expect(failed.resultDeliveredChunks?.count).toBe(1);
    expect(failed.resultDeliveredAt).toBeUndefined();

    // 第二轮（手动刷新）：指纹一致 → 跳过已送达的第一片，从第二片续发。
    const firstRoundCount = deliveredTexts.length;
    firstRound = false;
    f.host.deliver = async (msg) => {
      deliveredTexts.push(msg.text);
      return { ok: true };
    };
    await f.service.handleTaskAction(failed.taskId, "refresh");
    await waitFor(() => lastTask(f).resultDeliveredAt !== undefined);

    const secondRound = deliveredTexts.slice(firstRoundCount);
    // 第一片没有重发，且续发的片全部成功送达。
    expect(secondRound.some((text) => text.startsWith("QQ 任务"))).toBe(false);
    expect(secondRound.length).toBeGreaterThan(0);
    expect(lastTask(f).resultDeliveredChunks).toBeUndefined();
    expect(lastTask(f).deliveryError).toBeUndefined();
  });

  it("连续 5 次运行中刷新只消耗 1 条被动回复，终态结果仍能送达", async () => {
    let clock = 10_000;
    let releaseDispatch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const f = makeService({ now: () => clock, monotonicNow: () => clock });
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      input.task.correlation.superSessionId = "super-throttle";
      await gate; // 挂起派发：任务停在 running
      return { superSessionId: "super-throttle" };
    };
    f.host.readTaskOutcome = () => ({ summary: "", status: "running" });

    await f.service.handleInboundMessage(inbound({ msgId: "e-throttle-1" }));
    await waitFor(() => f.dispatches.length === 1 && lastTask(f).status === "running");
    const taskId = lastTask(f).taskId;

    for (let i = 0; i < 5; i += 1) {
      clock += 1; // 5 次点击都落在最小间隔内
      await f.service.handleTaskAction(taskId, "refresh");
    }
    const progress = f.delivered.filter((item) => item.text.includes("尚未结束"));
    // 只有 1 条进度消息，且复用稳定 dedupeKey —— adapter 据此复用同一个
    // msg_seq，平台按 (msg_id, msg_seq) 去重，不会把终态结果的配额烧光。
    // key 由「progress:<taskId>:<最终文本指纹>」构成（指纹见 fingerprintText）。
    expect(progress).toHaveLength(1);
    expect(progress[0]?.dedupeKey?.startsWith(`progress:${taskId}:`)).toBe(true);
    // 节流命中不能再是「点了没反应」：本地必须给一次性回执（且不刷屏）。
    const receipts = f.notes.filter((note) => note.includes("已刷新"));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toContain(shortTaskId(taskId));

    // dedupeKey 的 TTL 是 10 分钟：过期后 adapter 会重新分配 seq，同一 key
    // 会被平台当成新消息 —— 同指纹必须由服务侧挡住，无论过了多久都不重发。
    clock += 10 * 60_000 + 1;
    await f.service.handleTaskAction(taskId, "refresh");
    expect(f.delivered.filter((item) => item.text.includes("尚未结束"))).toHaveLength(1);

    // 指纹变化（执行体状态变了）才允许再发一条进度。
    f.host.readTaskOutcome = () => ({ summary: "", status: "waiting_approval" });
    clock += QQ_PROGRESS_REFRESH_MIN_INTERVAL_MS + 1;
    await f.service.handleTaskAction(taskId, "refresh");
    const updated = f.delivered.filter((item) => item.text.includes("尚未结束"));
    expect(updated).toHaveLength(2);
    expect(updated[1]!.text).toContain("waiting_approval");
    expect(updated[1]!.dedupeKey).not.toBe(progress[0]?.dedupeKey);

    // 终态结果仍能送达。
    f.host.readTaskOutcome = () => ({
      summary: "终态结果到达",
      status: "completed",
      stopReason: "end_turn",
    });
    releaseDispatch();
    await waitFor(() => lastTask(f).resultDeliveredAt !== undefined);
    expect(f.delivered.some((item) => item.text.includes("终态结果到达"))).toBe(true);
  });

  it("投递窗口内 result 被改写时不写送达锚点，下次刷新重投新内容", async () => {
    let releaseDelivery!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    let gated = false;
    const f = makeService();
    f.host.deliver = async (msg) => {
      f.delivered.push({ ...msg });
      if (!gated && msg.text.includes("第一版结果")) {
        gated = true;
        await gate; // 模拟平台慢响应
      }
      return { ok: true };
    };
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      return { superSessionId: "super-rewrite" };
    };
    f.host.readTaskOutcome = () => ({
      summary: "第一版结果",
      status: "completed",
      stopReason: "end_turn",
    });

    const main = f.service.handleInboundMessage(inbound({ msgId: "e-rewrite-1" }));
    await waitFor(() => gated);
    const taskId = lastTask(f).taskId;

    // 投递还在飞时结果被刷新改写：旧内容的成功回包不能把新内容标成已送达。
    f.host.readTaskOutcome = () => ({
      summary: "第二版结果（更新）",
      status: "completed",
      stopReason: "end_turn",
    });
    const refresh = f.service.handleTaskAction(taskId, "refresh");
    releaseDelivery();
    await Promise.all([main, refresh]);

    const stale = lastTask(f);
    expect(stale.result?.summary).toBe("第二版结果（更新）");
    expect(stale.resultDeliveredAt).toBeUndefined();
    expect(stale.deliveryError).toContain(QQ_RESULT_CHANGED_WHILE_DELIVERING);

    // 下一次刷新重投新内容并补上锚点。
    await f.service.handleTaskAction(taskId, "refresh");
    await waitFor(() => lastTask(f).resultDeliveredAt !== undefined);
    expect(f.delivered.some((item) => item.text.includes("第二版结果"))).toBe(true);
  });

  it("重启后补发终态但未送达的结果；已送达的不重发", async () => {
    const store = new MemoryStore();
    store.records.set(
      "T-seed-un00001",
      seedTask("T-seed-un00001", "succeeded", {
        createdAt: SEED_BASE,
        updatedAt: SEED_BASE,
        result: { stopReason: "end_turn", summary: "重启补发的摘要", changes: [], artifacts: [] },
      }),
    );
    store.records.set(
      "T-seed-de00002",
      seedTask("T-seed-de00002", "succeeded", {
        createdAt: SEED_BASE,
        updatedAt: SEED_BASE,
        result: { stopReason: "end_turn", summary: "已经送达过的摘要", changes: [], artifacts: [] },
        resultDeliveredAt: 2_000,
      }),
    );
    const f = makeService({ store, now: () => 100_000, deliveryRetryDelayMs: 0 });

    await f.service.start();

    const texts = f.delivered.map((item) => item.text).join("\n");
    expect(texts).toContain("重启补发的摘要");
    expect(texts).not.toContain("已经送达过的摘要");
    expect(f.service.getTask("T-seed-un00001")?.resultDeliveredAt).toBeDefined();
    expect(f.service.getTask("T-seed-de00002")?.resultDeliveredAt).toBe(2_000);
  });

  it("重启补发受最小间隔节流：刚失败过的任务不会每次开窗都重试", async () => {
    const store = new MemoryStore();
    store.records.set(
      "T-seed-un00003",
      seedTask("T-seed-un00003", "succeeded", {
        createdAt: SEED_BASE,
        updatedAt: SEED_BASE,
        result: { stopReason: "end_turn", summary: "上次没送达的摘要", changes: [], artifacts: [] },
        deliveryError: QQ_RESULT_UNDELIVERED,
        resultDeliveryAttemptAt: 2_000,
      }),
    );
    const f = makeService({
      store,
      now: () => 2_000 + Math.floor(QQ_RESULT_RESTORE_RETRY_MS / 2),
      deliveryRetryDelayMs: 0,
    });

    await f.service.start();

    expect(f.delivered).toHaveLength(0);
    expect(f.service.getTask("T-seed-un00003")?.resultDeliveredAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 命令处理
// ---------------------------------------------------------------------------

describe("QqService — 命令处理", () => {
  it("help 返回命令清单", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(inbound({ text: "/qq help" }));
    expect(f.delivered[0]?.text).toContain("QQ 远程任务命令");
    expect(f.delivered[0]?.text).toContain("approve <任务编号> [验证码]");
  });

  it("未知子命令回可读错误", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(inbound({ text: "/qq frobnicate" }));
    expect(f.delivered[0]?.text).toContain("未知子命令");
  });

  it("status 无编号时只回最近 5 条，并按 updatedAt 倒序", async () => {
    const store = new MemoryStore();
    for (let i = 1; i <= 6; i += 1) {
      const id = `T-seed-00000${i}`;
      store.records.set(
        id,
        seedTask(id, "succeeded", {
          createdAt: SEED_BASE + i,
          updatedAt: SEED_BASE + i,
          // 已送达：start() 的重启补发不该在这里插一条结果摘要（本用例只测列表）。
          resultDeliveredAt: SEED_BASE + i,
          payload: { prompt: `任务${i}`, attachments: [], contexts: [] },
        }),
      );
    }
    const f = makeService({ store, now: () => 100 });
    await f.service.start();
    await f.service.handleInboundMessage(inbound({ text: "/qq status" }));
    const text = f.delivered[0]?.text ?? "";
    expect(text).toContain("000006");
    expect(text).toContain("000002");
    expect(text).not.toContain("000001");
  });

  it("短 id 唯一命中生效，多命中回歧义，未知回未找到", async () => {
    const store = new MemoryStore();
    store.records.set("T-seed-abc123", seedTask("T-seed-abc123", "succeeded"));
    store.records.set("T-seed-abc456", seedTask("T-seed-abc456", "succeeded"));
    const f = makeService({ store, now: () => 100 });
    await f.service.start();

    await f.service.handleInboundMessage(inbound({ text: "/qq status abc1" }));
    // 摘要首行展示可读标题，不再是裸短 id。
    expect(f.delivered.at(-1)?.text).toContain("任务 T-seed-abc123");
    expect(f.delivered.at(-1)?.text).not.toContain("QQ 任务 abc123");

    await f.service.handleInboundMessage(inbound({ text: "/qq status abc" }));
    expect(f.delivered.at(-1)?.text).toContain("命中 2 个任务");
    // 歧义提示里的短 id 是用户辨识并输入更长编号的依据，必须保留。
    expect(f.delivered.at(-1)?.text).toContain(shortTaskId("T-seed-abc123"));
    expect(f.delivered.at(-1)?.text).toContain(shortTaskId("T-seed-abc456"));

    await f.service.handleInboundMessage(inbound({ text: "/qq status zzz" }));
    expect(f.delivered.at(-1)?.text).toContain("未找到任务");
  });

  it("result / diff 输出已记录的结果与改动", async () => {
    const store = new MemoryStore();
    store.records.set(
      "T-seed-res001",
      seedTask("T-seed-res001", "succeeded", {
        result: {
          stopReason: "end_turn",
          summary: "修复完成",
          changes: [{ path: "src/a.ts", additions: 5, deletions: 1 }],
          artifacts: [],
        },
      }),
    );
    const f = makeService({ store, now: () => 100 });
    await f.service.start();

    await f.service.handleInboundMessage(inbound({ text: "/qq result res001" }));
    expect(f.delivered.at(-1)?.text).toContain("修复完成");

    await f.service.handleInboundMessage(inbound({ text: "/qq diff res001" }));
    expect(f.delivered.at(-1)?.text).toContain("src/a.ts");

    await f.service.handleInboundMessage(inbound({ text: "/qq result nope" }));
    expect(f.delivered.at(-1)?.text).toContain("未找到任务");
  });

  it("unbind 需特权身份 + 二次确认；/qq bind 已不是命令（回未知子命令）", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(inbound({ text: "/qq bind abcd12" }));
    expect(f.delivered.at(-1)?.text).toContain("未知子命令");
    expect(f.pendingUsers).toHaveLength(0);

    // 第一步：白名单首项（扫码绑定者）可发起，但只拿到确认码，不真正解绑。
    await f.service.handleInboundMessage(inbound({ text: "/qq unbind" }));
    expect(f.unbindCount.value).toBe(0);
    const prompt = f.delivered.at(-1)?.text ?? "";
    expect(prompt).toContain("确认请回复验证码");
    const code = /验证码 (\d{6})/u.exec(prompt)?.[1];
    expect(code).toMatch(/^\d{6}$/u);

    // 第二步：本人回复一次性确认码，才调用 host。
    await f.service.handleInboundMessage(inbound({ text: code!, msgId: "m-confirm" }));
    expect(f.unbindCount.value).toBe(1);
    expect(f.delivered.at(-1)?.text).toContain("已解绑");
  });

  it("answer 在没有等待问题时回明确提示", async () => {
    const store = new MemoryStore();
    store.records.set("T-seed-ans001", seedTask("T-seed-ans001", "succeeded"));
    const f = makeService({ store, now: () => 100 });
    await f.service.start();
    await f.service.handleInboundMessage(inbound({ text: "/qq answer ans001 继续" }));
    expect(f.delivered.at(-1)?.text).toContain("没有等待回答的问题");
  });

  it("stop 会请求宿主取消并落为 canceled", async () => {
    const f = makeService();
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      // 模拟宿主在启动时把子会话 id 回填到共享任务对象上。
      input.task.correlation.superSessionId = "super-live";
      return new Promise<never>(() => undefined);
    };
    await f.service.handleInboundMessage(inbound({ msgId: "stop-1" }));
    await waitFor(() => f.dispatches.length === 1 && lastTask(f).status === "running");
    const taskId = lastTask(f).taskId;
    await f.service.handleTaskAction(taskId, "stop");
    expect(f.cancels).toEqual(["super-live"]);
    expect(lastTask(f).status).toBe("canceled");
    expect(f.delivered.at(-1)?.text).toContain("已请求停止任务");
  });

  it("merge / discard 转发给宿主并回显结果", async () => {
    const store = new MemoryStore();
    store.records.set(
      "T-seed-mrg001",
      seedTask("T-seed-mrg001", "needs_review", {
        correlation: { superSessionId: "super-mrg", branch: "iflow/qq/mrg" },
      }),
    );
    const f = makeService({ store, now: () => 100 });
    await f.service.start();

    await f.service.handleInboundMessage(inbound({ text: "/qq merge mrg001" }));
    expect(f.merges).toEqual(["super-mrg"]);
    expect(f.delivered.at(-1)?.text).toContain("已合并");

    await f.service.handleInboundMessage(inbound({ text: "/qq discard mrg001" }));
    expect(f.discards).toEqual(["super-mrg"]);
    expect(f.delivered.at(-1)?.text).toContain("工作分支已丢弃");
  });
});

// ---------------------------------------------------------------------------
// 授权模型：白名单外的人只进待审核队列
// ---------------------------------------------------------------------------

describe("QqService — 待审核用户（授权模型）", () => {
  it("私聊未授权消息：不派发、不回执，交给 onPendingUser", async () => {
    const f = makeService({ now: () => 100 }); // allowedUsers: ["u1"]
    await f.service.handleInboundMessage(
      inbound({ chatId: "u2", senderId: "u2", text: "帮我看看这个报错" }),
    );
    expect(f.delivered).toHaveLength(0);
    expect(f.dispatches).toHaveLength(0);
    expect(f.service.listTasks()).toHaveLength(0);
    expect(f.pendingUsers).toHaveLength(1);
    expect(f.pendingUsers[0]).toEqual({
      openid: "u2",
      chatType: "private",
      preview: "帮我看看这个报错",
      at: 100,
    });
    expect(f.notes.some((line) => line.includes("白名单"))).toBe(true);
  });

  it("未授权用户发 /qq task 也只进待审核（不执行、不回执）", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(
      inbound({ chatId: "u2", senderId: "u2", text: "/qq task 帮我改个东西" }),
    );
    expect(f.delivered).toHaveLength(0);
    expect(f.dispatches).toHaveLength(0);
    expect(f.service.listTasks()).toHaveLength(0);
    expect(f.pendingUsers).toHaveLength(1);
    expect(f.pendingUsers[0]?.preview).toContain("/qq task");
  });

  it("群聊未在 allowedGroups 时不记录（避免任意群刷记录）", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(
      inbound({
        chatType: "group",
        chatId: "g2",
        senderId: "u2",
        mentionsBot: true,
        text: "拉机器人进群试试",
      }),
    );
    expect(f.pendingUsers).toHaveLength(0);
    expect(f.delivered).toHaveLength(0);
    expect(f.notes.some((line) => line.includes("忽略"))).toBe(true);
  });

  it("allowedGroups 内的群：未授权成员的消息入队并带 groupId", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(
      inbound({
        chatType: "group",
        chatId: "g1",
        senderId: "u2",
        mentionsBot: true,
        text: "群里的请求",
      }),
    );
    expect(f.pendingUsers).toHaveLength(1);
    expect(f.pendingUsers[0]).toMatchObject({
      openid: "u2",
      chatType: "group",
      groupId: "g1",
      preview: "群里的请求",
    });
    expect(f.delivered).toHaveLength(0);
    expect(f.dispatches).toHaveLength(0);
  });

  it("白名单命中的消息正常执行，且不产生待审核记录", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(inbound({ msgId: "ok-1" }));
    expect(f.pendingUsers).toHaveLength(0);
    expect(f.delivered[0]?.text).toContain("已受理任务");
    await waitFor(() => f.dispatches.length === 1);
  });
});

// ---------------------------------------------------------------------------
// 重启恢复
// ---------------------------------------------------------------------------

describe("QqService — 重启恢复", () => {
  it("start() 把非终态任务如实标记为 failed(host_restarted)", async () => {
    const store = new MemoryStore();
    store.records.set(
      "T-seed-run001",
      seedTask("T-seed-run001", "running", {
        pending: { kind: "approval", text: "审批 x", at: 1_000 },
      }),
    );
    store.records.set("T-seed-ok0001", seedTask("T-seed-ok0001", "succeeded"));
    const f = makeService({ store, now: () => 2_000 });
    await f.service.start();

    const interrupted = f.service.getTask("T-seed-run001");
    expect(interrupted?.status).toBe("failed");
    expect(interrupted?.failure?.code).toBe("host_restarted");
    expect(interrupted?.pending).toBeUndefined();
    expect(f.service.getTask("T-seed-ok0001")?.status).toBe("succeeded");
    expect(store.events.some((event) => event.type === "task_interrupted")).toBe(true);
    expect(f.notes.some((line) => line.includes("宿主重启"))).toBe(true);
    expect(shortTaskId(interrupted!.taskId)).toBe("run001");
  });
});

// ---------------------------------------------------------------------------
// listTasks / getTask 投影
// ---------------------------------------------------------------------------

describe("QqService — 看板投影", () => {
  it("listTasks 按 updatedAt 降序并映射结果统计与等待态", async () => {
    const store = new MemoryStore();
    store.records.set(
      "T-seed-old001",
      seedTask("T-seed-old001", "succeeded", {
        createdAt: SEED_BASE,
        updatedAt: SEED_BASE + 10,
        result: {
          stopReason: "end_turn",
          summary: "旧任务",
          changes: [
            { path: "a.ts", additions: 2, deletions: 1 },
            { path: "b.ts", additions: 3, deletions: 0 },
          ],
          artifacts: [],
        },
      }),
    );
    store.records.set(
      "T-seed-new001",
      seedTask("T-seed-new001", "needs_review", {
        createdAt: SEED_BASE,
        updatedAt: SEED_BASE + 20,
        correlation: { branch: "iflow/qq/new" },
        pending: { kind: "approval", text: "审批 run", at: 20 },
      }),
    );
    const f = makeService({ store, now: () => 30 });
    await f.service.start();
    const tasks = f.service.listTasks();
    expect(tasks[0]?.taskId).toBe("T-seed-new001");
    expect(tasks[0]?.branch).toBe("iflow/qq/new");
    expect(tasks[0]?.pending).toEqual({ kind: "approval", summary: "审批 run" });
    const old = tasks.find((task) => task.taskId === "T-seed-old001");
    expect(old?.changes).toBe(2);
    expect(old?.additions).toBe(5);
    expect(old?.deletions).toBe(1);
    expect(old?.stopReason).toBe("end_turn");
  });

  it("getTask 支持完整 id 与唯一短 id，未知返回 null", async () => {
    const store = new MemoryStore();
    store.records.set("T-seed-uuid001", seedTask("T-seed-uuid001", "succeeded"));
    const f = makeService({ store, now: () => 100 });
    await f.service.start();
    expect(f.service.getTask("T-seed-uuid001")?.taskId).toBe("T-seed-uuid001");
    expect(f.service.getTask(shortTaskId("T-seed-uuid001"))?.taskId).toBe("T-seed-uuid001");
    expect(f.service.getTask("nope")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 生命周期与存储层修复（discard 守卫 / 取消失败 / 终态粘性 / prune / 脱敏 /
// 续发与重启补发 / policy 投影 / worktreePath / 单调时钟）
// ---------------------------------------------------------------------------

const LONG_OPENID = "D754D2240C503C2ABE2B236DC1E78D11";

/** 启动一个真正处于 running 的任务（dispatchTask 挂起），返回服务夹具。 */
async function startRunningTask(
  options: Parameters<typeof makeService>[0],
  superSessionId: string,
): Promise<ServiceFixture> {
  const f = makeService(options);
  f.host.dispatchTask = async (input) => {
    f.dispatches.push(input);
    // 与真实宿主一致：派发时把子会话 id 回填到共享任务对象上。
    input.task.correlation.superSessionId = superSessionId;
    return new Promise<never>(() => undefined);
  };
  await f.service.handleInboundMessage(inbound({ msgId: `run-${superSessionId}` }));
  // 等 dispatchTask 已登记：宿主在派发回调里同步回填 correlation，只等 running
  // 会在两者之间抢跑，导致 stop/refresh 读不到 superSessionId（真实宿主不会）。
  await waitFor(() => f.dispatches.length === 1 && lastTask(f).status === "running");
  return f;
}

describe("QqService — discard 守卫", () => {
  it("非终态任务拒绝丢弃，提示先 /qq stop", async () => {
    const f = await startRunningTask({}, "super-guard");
    const taskId = lastTask(f).taskId;

    await f.service.handleInboundMessage(
      inbound({ text: `/qq discard ${shortTaskId(taskId)}` }),
    );

    expect(f.discards).toEqual([]);
    expect(f.delivered.at(-1)?.text).toContain("请先 /qq stop");
    expect(lastTask(f).status).toBe("running");
  });

  it("--force 才强制丢弃，并在回包里写明未提交改动会丢失", async () => {
    const f = await startRunningTask({}, "super-force");
    const taskId = lastTask(f).taskId;

    await f.service.handleInboundMessage(
      inbound({ text: `/qq discard ${shortTaskId(taskId)} --force` }),
    );

    expect(f.discards).toEqual(["super-force"]);
    const reply = f.delivered.at(-1)?.text ?? "";
    expect(reply).toContain("强制丢弃");
    expect(reply).toContain("未提交的改动已随之丢失");
    // 丢弃是独立终态（不是 canceled）：取消 ≠ 产物被处置，看板要能区分。
    const task = lastTask(f);
    expect(task.status).toBe("discarded");
    expect(task.failure).toBeUndefined();
    expect(task.discard?.message).toContain("未提交的改动已随之丢失");
    expect(
      f.store.events.some((event) => event.type === "task_discarded"),
    ).toBe(true);
  });

  it("终态任务不需要 --force 即可丢弃（保留原有行为）", async () => {
    const store = new MemoryStore();
    store.records.set(
      "T-seed-done09",
      seedTask("T-seed-done09", "needs_review", {
        correlation: { superSessionId: "super-done", branch: "iflow/qq/done" },
      }),
    );
    const f = makeService({ store, now: () => 100 });
    await f.service.start();

    await f.service.handleInboundMessage(inbound({ text: "/qq discard done09" }));

    expect(f.discards).toEqual(["super-done"]);
    expect(f.delivered.at(-1)?.text).toContain("工作分支已丢弃");
    // BUG 回归（用户实测：QQ 收到「已丢弃」、看板一动不动）：终态 sticky 会
    // 挡住 commitStatus，旧实现成功后一个字段都不改，投影自然毫无变化。
    const ui = f.service.listTasks()[0];
    expect(ui?.status).toBe("discarded");
    expect(ui?.discardNote).toContain("工作分支已丢弃");
  });

  it("丢弃成功：走公共投影通道刷新一次，看板立即反映", async () => {
    const store = new MemoryStore();
    store.records.set(
      "T-seed-dsc001",
      seedTask("T-seed-dsc001", "succeeded", {
        correlation: { superSessionId: "super-dsc", branch: "iflow/qq/dsc" },
      }),
    );
    let changed = 0;
    const f = makeService({
      store,
      now: () => 100,
      onChanged: () => {
        changed += 1;
      },
    });
    await f.service.start();
    // start() 的重启补发也会刷新投影，这里只数「丢弃」这一次。
    changed = 0;

    await f.service.handleTaskAction("T-seed-dsc001", "discard");

    const task = lastTask(f);
    expect(task.status).toBe("discarded");
    expect(task.discard?.message).toContain("工作分支已丢弃");
    // 失败痕迹（若有）必须被清掉：丢弃成功不该顶着一条陈旧的「执行失败」。
    expect(task.failure).toBeUndefined();
    // 走的是 persist → onChanged 这条公共通道，且恰好一次（不另发私有推送）。
    expect(changed).toBe(1);
    // 归档里也要能读回（重启后看板仍显示已丢弃）。
    expect(store.records.get("T-seed-dsc001")?.status).toBe("discarded");
  });

  it("丢弃被拒：原因写进任务记录（看板可见），不只发 QQ", async () => {
    let changed = 0;
    const f = await startRunningTask(
      {
        onChanged: () => {
          changed += 1;
        },
      },
      "super-refuse",
    );
    const taskId = lastTask(f).taskId;
    changed = 0;

    await f.service.handleTaskAction(taskId, "discard");

    expect(f.discards).toEqual([]);
    const task = lastTask(f);
    expect(task.status).toBe("running");
    expect(task.failure?.code).toBe("discard_refused");
    expect(task.failure?.message).toContain("请先 /qq stop");
    const ui = f.service.listTasks()[0];
    expect(ui?.errorMessage).toContain("丢弃被拒绝");
    // 丢弃是用户动作，不能渲染成「执行失败」。
    expect(ui?.errorMessage).not.toContain("执行失败");
    expect(f.store.events.some((event) => event.type === "task_discard_refused")).toBe(true);
    expect(changed).toBeGreaterThan(0);
  });

  it("宿主丢弃失败：原因写进任务记录，状态不变（不谎称已丢弃）", async () => {
    const store = new MemoryStore();
    store.records.set(
      "T-seed-dscfail",
      seedTask("T-seed-dscfail", "failed", {
        correlation: { superSessionId: "super-dscfail", branch: "iflow/qq/fail" },
      }),
    );
    const f = makeService({ store, now: () => 100 });
    await f.service.start();
    f.host.discardTask = async () => {
      throw new Error("worktree 被占用");
    };

    await f.service.handleTaskAction("T-seed-dscfail", "discard");

    const task = lastTask(f);
    expect(task.status).toBe("failed");
    expect(task.failure?.code).toBe("discard_failed");
    const ui = f.service.listTasks()[0];
    expect(ui?.errorMessage).toContain("丢弃失败");
    expect(ui?.errorMessage).toContain("worktree 被占用");
    expect(f.store.events.some((event) => event.type === "task_discard_failed")).toBe(true);
  });

  it("分支因未合并提交被保留时如实说明（不谎称提交也没了）", async () => {
    const store = new MemoryStore();
    store.records.set(
      "T-seed-keep01",
      seedTask("T-seed-keep01", "needs_review", {
        correlation: { superSessionId: "super-keep", branch: "iflow/qq/keep" },
      }),
    );
    const f = makeService({ store, now: () => SEED_BASE + 10 });
    await f.service.start();
    f.host.discardTask = async () => ({
      ok: true,
      branchKept: true,
      reason: "分支上还有未合并提交",
    });

    await f.service.handleTaskAction("T-seed-keep01", "discard");

    const task = lastTask(f);
    expect(task.status).toBe("discarded");
    expect(task.discard?.branchKept).toBe(true);
    expect(task.discard?.message).toContain("iflow/qq/keep");
    expect(task.discard?.message).toContain("未合并提交");
    const reply = f.delivered.at(-1)?.text ?? "";
    expect(reply).toContain("iflow/qq/keep");
    expect(reply).toContain("保留");
  });
});

describe("QqService — 取消失败不写 canceled", () => {
  it("host.cancelTask 抛错时保持原状态并如实回执", async () => {
    const f = await startRunningTask({}, "super-cancel-fail");
    const taskId = lastTask(f).taskId;
    f.host.cancelTask = async () => {
      throw new Error("宿主取消失败");
    };

    await f.service.handleTaskAction(taskId, "stop");

    const task = lastTask(f);
    expect(task.status).toBe("running");
    expect(task.failure?.code).toBe("cancel_failed");
    expect(task.failure?.message).toContain("宿主取消失败");
    expect(f.delivered.at(-1)?.text).toContain("取消失败");
    expect(f.store.events.some((event) => event.type === "task_cancel_failed")).toBe(true);
    expect(f.store.events.some((event) => event.type === "task_canceled")).toBe(false);
    // 看板用中性措辞，不把它渲染成「执行失败」。
    expect(f.service.listTasks()[0]?.errorMessage).toContain("取消失败");
    expect(f.service.listTasks()[0]?.errorMessage).not.toContain("执行失败");
  });

  it("取消成功时仍按原语义落 canceled", async () => {
    const f = await startRunningTask({}, "super-cancel-ok");
    const taskId = lastTask(f).taskId;

    await f.service.handleTaskAction(taskId, "stop");

    expect(f.cancels).toEqual(["super-cancel-ok"]);
    expect(lastTask(f).status).toBe("canceled");
    expect(f.store.events.some((event) => event.type === "task_canceled")).toBe(true);
  });
});

describe("QqService — commitStatus 终态粘性", () => {
  type CommitStatus = (
    task: QqTask,
    next: QqTaskStatus,
    patch?: Partial<QqTask>,
  ) => Promise<QqTask>;

  it("终态任务的迟到提交（含带 status 的 patch）一律不改写", async () => {
    const store = new MemoryStore();
    store.records.set("T-seed-term01", seedTask("T-seed-term01", "succeeded"));
    const f = makeService({ store, now: () => 100 });
    await f.service.start();
    const internals = f.service as unknown as { commitStatus: CommitStatus };
    const before = f.service.getTask("T-seed-term01")!;

    const returned = await internals.commitStatus(before, "queued", {
      status: "queued" as QqTaskStatus,
      pending: { kind: "approval", text: "迟到", at: 100 },
    });

    expect(returned.status).toBe("succeeded");
    expect(returned.pending).toBeUndefined();
    const stored = lastTask(f);
    expect(stored.status).toBe("succeeded");
    expect(stored.pending).toBeUndefined();
    expect(stored.updatedAt).toBe(before.updatedAt);
  });

  it("空 patch 直接返回，不因为 noop 提交再写一次", async () => {
    const f = await startRunningTask({}, "super-noop");
    const internals = f.service as unknown as { commitStatus: CommitStatus };
    const before = lastTask(f);

    const returned = await internals.commitStatus(before, before.status);

    expect(returned).toBe(before);
    expect(returned.updatedAt).toBe(before.updatedAt);
  });
});

describe("QqService — 归档清理（prune 接线）", () => {
  it("start() 用默认保留天数清理超期终态任务", async () => {
    const old = Date.now() - (QQ_DEFAULT_RETENTION_DAYS + 5) * 24 * 60 * 60 * 1000;
    const store = new MemoryStore();
    store.records.set(
      "T-seed-prune1",
      seedTask("T-seed-prune1", "succeeded", { createdAt: old, updatedAt: old }),
    );
    store.records.set(
      "T-seed-prune2",
      seedTask("T-seed-prune2", "running", { createdAt: old, updatedAt: old }),
    );
    const f = makeService({ store });
    await f.service.start();

    expect(store.pruneCalls).toEqual([QQ_DEFAULT_RETENTION_DAYS]);
    expect(f.service.getTask("T-seed-prune1")).toBeNull();
    // 非终态任务即使超期也不清（start 先 prune 再加载，随后被标成中断失败）。
    expect(f.service.getTask("T-seed-prune2")?.status).toBe("failed");
    expect(store.events.some((event) => event.type === "tasks_pruned")).toBe(true);
  });

  it("taskRetentionDays<=0 时完全关闭清理", async () => {
    const old = Date.now() - (QQ_DEFAULT_RETENTION_DAYS + 5) * 24 * 60 * 60 * 1000;
    const store = new MemoryStore();
    store.records.set(
      "T-seed-prune3",
      seedTask("T-seed-prune3", "succeeded", { createdAt: old, updatedAt: old }),
    );
    const f = makeService({ store, taskRetentionDays: 0 });
    await f.service.start();

    expect(store.pruneCalls).toEqual([]);
    expect(f.service.getTask("T-seed-prune3")).not.toBeNull();
  });
});

describe("QqService — 开放平台 id 脱敏", () => {
  it("通知 / 事件 / 看板投影都不含完整 openid 或群号", async () => {
    const f = makeService({ config: { allowedUsers: [LONG_OPENID] } });
    await f.service.handleInboundMessage(
      inbound({ msgId: "mask-1", senderId: LONG_OPENID, chatId: LONG_OPENID }),
    );
    await waitFor(() => f.service.listTasks().length === 1);

    const ui = f.service.listTasks()[0]!;
    expect(ui.senderId).toBe("D754********8D11");
    expect(ui.chatId).toBe("D754********8D11");

    const created = f.store.events.find((event) => event.type === "task_created");
    expect(created).toBeDefined();
    expect(JSON.stringify(created)).not.toContain(LONG_OPENID);

    expect(f.notes.join("\n")).not.toContain(LONG_OPENID);
  });

  it("限流通知与待审核通知里的 openid 也脱敏", async () => {
    const f = makeService({
      config: { allowedUsers: [LONG_OPENID], rateLimitPerMin: 1 },
    });
    await f.service.handleInboundMessage(
      inbound({ msgId: "mask-a", senderId: LONG_OPENID, chatId: LONG_OPENID }),
    );
    await f.service.handleInboundMessage(
      inbound({ msgId: "mask-b", senderId: LONG_OPENID, chatId: LONG_OPENID }),
    );
    expect(f.notes.join("\n")).toContain("触发限流");

    const other = "OTHEROPENID1234567890ABCDEF99";
    await f.service.handleInboundMessage(
      inbound({ msgId: "mask-c", senderId: other, chatId: other }),
    );
    expect(f.notes.join("\n")).toContain("待审核");

    const allNotes = f.notes.join("\n");
    expect(allNotes).not.toContain(LONG_OPENID);
    expect(allNotes).not.toContain(other);
    // 待审核队列本身仍保留完整 openid（授权依据，不是 UI/日志面）。
    expect(f.pendingUsers[0]?.openid).toBe(other);
  });
});

describe("QqService — 续发分片与重启补发绕开 (msg_id, seq) 去重", () => {
  const longSummary = Array.from(
    { length: 150 },
    (_, i) => `第 ${i} 项：${"摘要正文填充内容。".repeat(9)}`,
  ).join("\n");

  it("多片结果的续发分片走主动消息（不带 msg_id），首片仍是被动回复", async () => {
    const f = makeService({ config: { resultDetail: "full" }, deliveryRetryDelayMs: 0 });
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      return { superSessionId: "super-chunks" };
    };
    f.host.readTaskOutcome = () => ({
      summary: longSummary,
      status: "completed",
      stopReason: "end_turn",
    });

    await f.service.handleInboundMessage(inbound({ msgId: "chunk-1" }));
    await waitFor(() => lastTask(f).resultDeliveredAt !== undefined);

    const resultMessages = f.delivered.filter(
      (item) => !item.text.startsWith("已受理任务"),
    );
    expect(resultMessages.length).toBeGreaterThan(1);
    expect(resultMessages[0]?.replyToMsgId).toBe("chunk-1");
    for (const message of resultMessages.slice(1)) {
      expect(message.replyToMsgId).toBeUndefined();
    }
  });

  it("重启补发终态结果整份走主动消息", async () => {
    const store = new MemoryStore();
    store.records.set(
      "T-seed-retry1",
      seedTask("T-seed-retry1", "succeeded", {
        updatedAt: Date.now(),
        result: {
          stopReason: "end_turn",
          summary: "补偿结果正文",
          changes: [],
          artifacts: [],
        },
      }),
    );
    const f = makeService({ store, deliveryRetryDelayMs: 0 });
    await f.service.start();

    const results = f.delivered.filter((item) => item.text.includes("补偿结果正文"));
    expect(results).toHaveLength(1);
    expect(results[0]?.replyToMsgId).toBeUndefined();
    expect(lastTask(f).resultDeliveredAt).toBeTypeOf("number");
  });
});

describe("QqService — policy 投影与 worktree 落盘", () => {
  it("toUi 回填任务的 remotePolicy，看板 chip 可用", async () => {
    const f = makeService({ config: { remotePolicy: "trusted" } });
    await f.service.handleInboundMessage(inbound({ msgId: "policy-1" }));
    await waitFor(() => f.service.listTasks().length === 1);

    expect(f.service.listTasks()[0]?.policy).toBe("trusted");
  });

  it("派发结果里的 branch / worktreePath 落进任务记录", async () => {
    const f = makeService();
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      return {
        superSessionId: "super-wt",
        branch: "iflow/qq/wt",
        worktreePath: "/ws/.iflow/super/worktrees/wt",
      };
    };
    await f.service.handleInboundMessage(inbound({ msgId: "wt-1" }));
    await waitFor(() => lastTask(f).resultDeliveredAt !== undefined);

    const task = lastTask(f);
    expect(task.correlation.branch).toBe("iflow/qq/wt");
    expect(task.correlation.worktreePath).toBe("/ws/.iflow/super/worktrees/wt");
  });

  it("旧归档没有 worktreePath 也能正常恢复", async () => {
    const store = new MemoryStore();
    store.records.set(
      "T-seed-oldwt",
      seedTask("T-seed-oldwt", "succeeded", {
        correlation: { superSessionId: "s-old", branch: "iflow/qq/old" },
      }),
    );
    const f = makeService({ store });
    await f.service.start();

    const task = f.service.getTask("T-seed-oldwt");
    expect(task?.correlation.branch).toBe("iflow/qq/old");
    expect(task?.correlation.worktreePath).toBeUndefined();
  });
});

describe("QqService — 单调时钟", () => {
  it("系统时间回拨不会重置限流窗口", async () => {
    let wall = 1_000_000;
    let mono = 0;
    const f = makeService({
      config: { rateLimitPerMin: 2 },
      now: () => wall,
      monotonicNow: () => mono,
    });

    await f.service.handleInboundMessage(inbound({ msgId: "mono-1" }));
    // 每次消息之间把墙上时钟往回拨 5 分钟；单调时钟仍单调前进。
    wall -= 300_000;
    mono += 1;
    await f.service.handleInboundMessage(inbound({ msgId: "mono-2" }));
    wall -= 300_000;
    mono += 1;
    await f.service.handleInboundMessage(inbound({ msgId: "mono-3" }));

    expect(f.service.listTasks()).toHaveLength(2);
    expect(f.delivered.some((item) => item.text.includes("请求过于频繁"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 刷新去重与待审核诚实化回归（2026-11-17 复核）
// ---------------------------------------------------------------------------

describe("QqService — 指纹成功后才记账", () => {
  it("进度投递失败不记指纹：下次刷新会重试；成功后同指纹不再重发", async () => {
    let clock = 20_000;
    const f = makeService({ now: () => clock, monotonicNow: () => clock });
    let releaseDispatch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      input.task.correlation.superSessionId = "super-fp";
      await gate; // 挂起派发：任务停在 running，finalize 尚未跑
      return { superSessionId: "super-fp" };
    };
    f.host.readTaskOutcome = () => ({ summary: "", status: "running" });
    let failProgress = true;
    f.host.deliver = async (msg) => {
      f.delivered.push({ ...msg });
      if (msg.text.includes("尚未结束")) {
        return failProgress ? { ok: false, retryable: false } : { ok: true };
      }
      return { ok: true };
    };

    await f.service.handleInboundMessage(inbound({ msgId: "e-fp-1" }));
    await waitFor(() => f.dispatches.length === 1 && lastTask(f).status === "running");
    const taskId = lastTask(f).taskId;

    // 第一轮刷新：投递失败（确定性拒绝），失败必须可观测。
    await f.service.handleTaskAction(taskId, "refresh");
    const beforeRetry = f.delivered.filter((m) => m.text.includes("尚未结束"));
    expect(beforeRetry.length).toBeGreaterThan(0);
    expect(f.notes.some((n) => n.includes("仍未送达"))).toBe(true);

    // 投递失败后指纹**没有**被记账（旧实现先记账再投递，失败后同一条进度
    // 被指纹永久挡住、用户永远收不到）：修复后下次刷新立即重试并成功。
    failProgress = false;
    clock += 1;
    await f.service.handleTaskAction(taskId, "refresh");
    const afterRetry = f.delivered.filter((m) => m.text.includes("尚未结束"));
    expect(afterRetry.length).toBeGreaterThan(beforeRetry.length);

    // 成功后指纹才记账：同指纹无论过多久都不再重发。
    clock += QQ_PROGRESS_REFRESH_MIN_INTERVAL_MS + 1;
    await f.service.handleTaskAction(taskId, "refresh");
    expect(f.delivered.filter((m) => m.text.includes("尚未结束"))).toHaveLength(
      afterRetry.length,
    );
    releaseDispatch();
  });
});

describe("QqService — /qq refresh 三条分支节流去重", () => {
  /** 连点 5 次，断言该分支只发出 ≤1 条 QQ 消息 + 本地有一次性回执。 */
  async function assertFiveClicksSingleMessage(
    f: ReturnType<typeof makeService>,
    taskId: string,
    marker: string,
  ): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await f.service.handleTaskAction(taskId, "refresh");
    }
    const sent = f.delivered.filter((item) => item.text.includes(marker));
    expect(sent.length).toBeLessThanOrEqual(1);
    expect(sent.length).toBeGreaterThan(0); // 第一次点击必须有回包
    // 节流命中给本地一次性回执，不是「点了没反应」。
    const receipts = f.notes.filter((note) => note.includes("已刷新"));
    expect(receipts.length).toBeGreaterThanOrEqual(1);
  }

  it("main 渠道分支：连点 5 次只发 1 条摘要", async () => {
    let clock = 30_000;
    const f = makeService({
      now: () => clock,
      monotonicNow: () => clock,
      newTaskChannel: "main",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.host.injectIntoMainSession = async () => {
      await gate; // 挂起注入：任务停在排队态
      throw new Error("unreachable");
    };
    await f.service.handleInboundMessage(inbound({ msgId: "e-rf-main" }));
    await waitFor(() => f.service.listTasks().length === 1);
    await assertFiveClicksSingleMessage(f, f.service.listTasks()[0]!.taskId, "QQ 任务");
    release();
  });

  it("未派发分支：连点 5 次只发 1 条提示", async () => {
    let clock = 40_000;
    const f = makeService({ now: () => clock, monotonicNow: () => clock });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 派发挂起且尚未回填 superSessionId：refresh 走「尚未派发」分支。
    f.host.dispatchTask = async () => {
      await gate;
      throw new Error("unreachable");
    };
    await f.service.handleInboundMessage(inbound({ msgId: "e-rf-undis" }));
    await waitFor(() => f.service.listTasks().length === 1);
    await assertFiveClicksSingleMessage(f, f.service.listTasks()[0]!.taskId, "尚未派发");
    release();
  });

  it("读不到结果分支：连点 5 次只发 1 条提示", async () => {
    let clock = 50_000;
    const f = makeService({ now: () => clock, monotonicNow: () => clock });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      input.task.correlation.superSessionId = "super-unread";
      await gate;
      throw new Error("unreachable");
    };
    f.host.readTaskOutcome = () => null;
    await f.service.handleInboundMessage(inbound({ msgId: "e-rf-unread" }));
    await waitFor(() => f.dispatches.length === 1 && lastTask(f).status === "running");
    await assertFiveClicksSingleMessage(f, lastTask(f).taskId, "暂时读取不到结果");
    release();
  });
});

describe("QqService — 待审核入队结果诚实化", () => {
  it("入队成功时提示「已记入待审核」", async () => {
    const f = makeService();
    f.host.onPendingUser = (info) => {
      f.pendingUsers.push({ ...info });
      return { dropped: false };
    };
    await f.service.handleInboundMessage(
      inbound({ chatId: "u2", senderId: "u2", text: "帮我看看这个报错" }),
    );
    expect(f.pendingUsers).toHaveLength(1);
    expect(f.notes.some((n) => n.includes("已记入待审核"))).toBe(true);
    expect(f.notes.some((n) => n.includes("未能记入"))).toBe(false);
  });

  it("队列满被丢弃时不虚称「已记入」，如实提示未入队", async () => {
    const f = makeService();
    f.host.onPendingUser = (info) => {
      f.pendingUsers.push({ ...info });
      return { dropped: true };
    };
    await f.service.handleInboundMessage(
      inbound({ chatId: "u2", senderId: "u2", text: "帮我看看这个报错" }),
    );
    expect(f.pendingUsers).toHaveLength(1);
    expect(f.notes.some((n) => n.includes("已记入待审核"))).toBe(false);
    expect(f.notes.some((n) => n.includes("未能记入待审核"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 核心安全修复回归
// ---------------------------------------------------------------------------

describe("QqService — 安全修复：unbind 权限边界", () => {
  it("白名单内非绑定者/非管理员不能解绑，host 不被调用", async () => {
    const f = makeService({ config: { allowedUsers: ["u1", "u2"] } });
    await f.service.handleInboundMessage(
      inbound({ senderId: "u2", chatId: "u2", text: "/qq unbind" }),
    );
    expect(f.unbindCount.value).toBe(0);
    expect(f.delivered.at(-1)?.text).toContain("没有权限");
  });

  it("独立管理员白名单可发起二次确认，确认码错误不解绑", async () => {
    const f = makeService();
    // 用 options 注入管理员（makeService 未暴露该选项，直接构造注入见下例）。
    const service = new QqService({
      config: f.config,
      store: f.store as unknown as QqTaskStore,
      host: f.host,
      binderOpenid: "someone-else",
      adminOpenids: ["u1"],
    });
    await service.handleInboundMessage(inbound({ text: "/qq unbind" }));
    expect(f.unbindCount.value).toBe(0);
    const prompt = f.delivered.at(-1)?.text ?? "";
    const code = /验证码 (\d{6})/u.exec(prompt)?.[1] ?? "";

    await service.handleInboundMessage(
      inbound({ text: "000000" === code ? "111111" : "000000", msgId: "m-wrong" }),
    );
    expect(f.unbindCount.value).toBe(0);

    await service.handleInboundMessage(inbound({ text: code, msgId: "m-ok" }));
    expect(f.unbindCount.value).toBe(1);
  });

  it("确认码是一次性的：同一码第二次回复不会重复解绑", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(inbound({ text: "/qq unbind" }));
    const code = /验证码 (\d{6})/u.exec(f.delivered.at(-1)?.text ?? "")?.[1] ?? "";
    await f.service.handleInboundMessage(inbound({ text: code, msgId: "m-c1" }));
    await f.service.handleInboundMessage(inbound({ text: code, msgId: "m-c2" }));
    expect(f.unbindCount.value).toBe(1);
  });
});

describe("QqService — 安全修复：审批并发与身份", () => {
  it("并发两次权限请求不会留下悬挂 Promise：一次通过一次拒绝", async () => {
    const f = makeService();
    const decisions: SuperPermissionDecision[] = [];
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      const [a, b] = await Promise.all([
        input.onPermission({ sessionId: "s", toolName: "A", summary: "A" }),
        input.onPermission({ sessionId: "s", toolName: "B", summary: "B" }),
      ]);
      decisions.push(a!, b!);
      return { superSessionId: "super-race" };
    };
    await f.service.handleInboundMessage(inbound({ msgId: "race-1" }));
    await waitFor(() => lastTask(f).status === "waiting_approval");
    const code = APPROVAL_CODE_PATTERN.exec(
      f.delivered.find((item) => item.text.includes("/qq approve"))!.text,
    )?.[1]!;
    await f.service.handleTaskAction(lastTask(f).taskId, "approve", code);
    await waitFor(() => decisions.length === 2);
    expect(decisions.filter((d) => d === "allow_once")).toHaveLength(1);
    expect(decisions.filter((d) => d === "deny")).toHaveLength(1);
  });

  it("群里非发起者即使拿到验证码也不能代批", async () => {
    const f = makeService({ config: { allowedUsers: ["u1", "u2"], allowedGroups: ["g1"] } });
    let decision: SuperPermissionDecision | undefined;
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      decision = await input.onPermission({ sessionId: "s", toolName: "write_file", summary: "write_file" });
      return { superSessionId: "super-identity" };
    };
    await f.service.handleInboundMessage(inbound({ msgId: "identity-1" }));
    await waitFor(() => lastTask(f).status === "waiting_approval");
    const taskId = lastTask(f).taskId;
    const code = APPROVAL_CODE_PATTERN.exec(
      f.delivered.find((item) => item.text.includes("/qq approve"))!.text,
    )?.[1]!;

    await f.service.handleInboundMessage(
      inbound({
        chatType: "group",
        chatId: "g1",
        senderId: "u2",
        mentionsBot: true,
        text: `/qq approve ${shortTaskId(taskId)} ${code}`,
        msgId: "m-other",
      }),
    );
    expect(decision).toBeUndefined();
    expect(f.delivered.at(-1)?.text).toContain("只能由发起者或管理员");
    expect(lastTask(f).status).toBe("waiting_approval");

    await f.service.handleTaskAction(taskId, "approve", code);
    await waitFor(() => decision !== undefined);
    expect(decision).toBe("allow_once");
  });
});

describe("QqService — 安全修复：终态消费 outcome.status", () => {
  function runWithOutcome(status: string | undefined, stopReason: string | undefined) {
    const f = makeService();
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      return { superSessionId: "super-status" };
    };
    f.host.readTaskOutcome = () => ({
      summary: "执行体汇报",
      ...(status ? { status } : {}),
      ...(stopReason ? { stopReason } : {}),
    });
    return f;
  }

  it("interrupted + 缺省 end_turn 如实记 canceled，不伪造成功", async () => {
    const f = runWithOutcome("interrupted", undefined);
    await f.service.handleInboundMessage(inbound({ msgId: "status-1" }));
    await waitFor(() => isTerminalStatus(lastTask(f).status));
    expect(lastTask(f).status).toBe("canceled");
  });

  it("error + end_turn 如实记 failed", async () => {
    const f = runWithOutcome("error", undefined);
    await f.service.handleInboundMessage(inbound({ msgId: "status-2" }));
    await waitFor(() => isTerminalStatus(lastTask(f).status));
    expect(lastTask(f).status).toBe("failed");
  });

  it("merged + 分支不再重复合并，直接记 succeeded", async () => {
    const f = runWithOutcome("merged", "end_turn");
    f.host.readTaskOutcome = () => ({
      summary: "已合并",
      status: "merged",
      branch: "iflow/qr/merged",
    });
    await f.service.handleInboundMessage(inbound({ msgId: "status-3" }));
    await waitFor(() => isTerminalStatus(lastTask(f).status));
    expect(lastTask(f).status).toBe("succeeded");
    expect(f.merges).toEqual([]);
  });
});

describe("QqService — 安全修复：幂等并发与畸形入站", () => {
  it("同一 msgId 并发到达只建一个任务、只派发一次", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = makeService();
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      await gate;
      return { superSessionId: "super-idem" };
    };
    await Promise.all([
      f.service.handleInboundMessage(inbound({ msgId: "dupe-1" })),
      f.service.handleInboundMessage(inbound({ msgId: "dupe-1" })),
    ]);
    release();
    await waitFor(() => f.dispatches.length === 1);
    expect(f.store.records.size).toBe(1);
  });

  it("msgId 缺失时不建任务、不产生 qq-bot:undefined 幂等键", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(inbound({ msgId: "", text: "做点事" }));
    expect(f.store.records.size).toBe(0);
    expect(f.dispatches).toHaveLength(0);
  });

  it("attachments 非数组不会抛错，按空附件处理", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(
      inbound({ msgId: "bad-att", attachments: "not-an-array" as never }),
    );
    await waitFor(() => f.dispatches.length === 1);
    expect(lastTask(f).payload.attachments).toEqual([]);
  });

  it("完全畸形的入站对象不会打断服务", async () => {
    const f = makeService();
    await expect(
      f.service.handleInboundMessage(undefined as unknown as InboundMessage),
    ).resolves.toBeUndefined();
    expect(f.dispatches).toHaveLength(0);
  });
});

describe("QqService — 安全修复：内存记账与丢弃诚实性", () => {
  it("进度记账表超过上限时淘汰最旧键", async () => {
    const f = makeService();
    const internals = f.service as unknown as {
      progressFingerprints: Map<string, string>;
      trackProgressSlot: (map: Map<string, string>, slot: string, value: string) => void;
    };
    for (let i = 0; i < QQ_MAX_TRACKED_PROGRESS_SLOTS + 10; i += 1) {
      internals.trackProgressSlot(internals.progressFingerprints, `task-${i}:x`, "f");
    }
    expect(internals.progressFingerprints.size).toBe(QQ_MAX_TRACKED_PROGRESS_SLOTS);
  });

  it("任务进入终态时清掉该任务的进度记账键", async () => {
    const f = await startRunningTask({}, "super-cleanup");
    const taskId = lastTask(f).taskId;
    const internals = f.service as unknown as {
      progressFingerprints: Map<string, string>;
    };
    internals.progressFingerprints.set(`${taskId}:progress`, "f");
    await f.service.handleTaskAction(taskId, "stop");
    expect(internals.progressFingerprints.has(`${taskId}:progress`)).toBe(false);
  });

  it("宿主丢弃返回空对象时如实报失败，不谎称已丢弃", async () => {
    const f = await startRunningTask({}, "super-empty-discard");
    const taskId = lastTask(f).taskId;
    f.host.discardTask = async () => ({}) as never;
    await f.service.handleTaskAction(taskId, "discard", undefined, { force: true });
    expect(lastTask(f).status).not.toBe("discarded");
    expect(lastTask(f).failure?.code).toBe("discard_failed");
    expect(f.delivered.at(-1)?.text).toContain("丢弃失败");
  });
});

// ---------------------------------------------------------------------------
// 主会话纯文本正文轮同步：中间正文走独立进度分支，与最终结果严格隔离
// ---------------------------------------------------------------------------

describe("QqService — 主会话中间正文轮同步", () => {
  function seedInjected(f: ServiceFixture, taskId: string, overrides: Partial<QqTask> = {}): QqTask {
    const task = seedTask(taskId, "injected", { channel: "main", ...overrides });
    const internals = f.service as unknown as { tasks: Map<string, QqTask> };
    internals.tasks.set(taskId, task);
    return task;
  }

  it("只投 injected 的 main 任务，且整轮正文指纹去重（同一段不重复发）", async () => {
    let clock = 1_000;
    const f = makeService({ monotonicNow: () => clock });
    seedInjected(f, "mt-1");
    const text = "我先看一下项目结构，已经拆成两个子任务";

    await f.service.deliverMainTurnText("mt-1", text);
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0]!.text).toBe(text);

    // 过了节流窗口再投同一段：指纹未变仍不重发。
    clock += QQ_PROGRESS_REFRESH_MIN_INTERVAL_MS + 1;
    await f.service.deliverMainTurnText("mt-1", text);
    expect(f.delivered).toHaveLength(1);
  });

  it("终态任务 / child 渠道任务 / 过短正文一律不投（不与最终结果重复）", async () => {
    const f = makeService();
    seedInjected(f, "mt-done", { status: "succeeded" });
    seedInjected(f, "mt-child", { channel: "child" as QqTask["channel"] });
    seedInjected(f, "mt-ok");

    await f.service.deliverMainTurnText("mt-done", "已经完成的任务正文");
    await f.service.deliverMainTurnText("mt-child", "超流体的正文");
    await f.service.deliverMainTurnText("mt-ok", "  ");
    await f.service.deliverMainTurnText("mt-ok", "嗯");
    expect(f.delivered).toHaveLength(0);
  });

  it("超长正文复用 chunkQqText 分片，不自己造轮子", async () => {
    const f = makeService();
    seedInjected(f, "mt-long");
    const text = `${"甲".repeat(3_500)}尾部标记`;
    await f.service.deliverMainTurnText("mt-long", text);
    expect(f.delivered.length).toBeGreaterThan(1);
    expect(f.delivered.map((d) => d.text).join("")).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// 展示位标题化回归：标题化只作用于展示位，命令参数 / 空标题 / 歧义键不动
// ---------------------------------------------------------------------------

describe("QqService — 通知展示位标题化", () => {
  it("空标题时展示位退化为短 id，不出现空引号", async () => {
    const store = new MemoryStore();
    store.records.set(
      "T-seed-untitled",
      seedTask("T-seed-untitled", "succeeded", {
        payload: { prompt: "  \n ##  \n ", attachments: [], contexts: [] },
        result: {
          stopReason: "end_turn",
          summary: "完成",
          changes: [{ path: "src/a.ts", additions: 1, deletions: 0 }],
          artifacts: [],
        },
      }),
    );
    const f = makeService({ store, now: () => 100 });
    await f.service.start();

    await f.service.handleInboundMessage(inbound({ text: "/qq diff titled" }));
    const text = f.delivered.at(-1)?.text ?? "";
    expect(text.split("\n")[0]).toBe(`任务 ${shortTaskId("T-seed-untitled")} 改动（1 个文件）`);
    expect(text).not.toContain("任务「」");
    expect(text).not.toContain("任务 改动");
  });
});

// ---------------------------------------------------------------------------
// 远程接管提示：本地发起的任务没有 QQ 任务归属，完成提示走绑定者私聊
// ---------------------------------------------------------------------------

describe("QqService — 远程接管提示投递（notifyBoundUser）", () => {
  it("作为主动私聊消息投递给绑定者，不建任务、不改任务列表", async () => {
    const f = makeService();
    await f.service.start();

    const ok = await f.service.notifyBoundUser("  iFlow 已完成本轮回复  ");

    expect(ok).toBe(true);
    // 主动消息：不带 replyToMsgId（没有被动回复窗口可用），文本已 trim。
    expect(f.delivered).toEqual([
      { chatType: "private", chatId: "u1", text: "iFlow 已完成本轮回复" },
    ]);
    expect(f.service.listTasks()).toHaveLength(0);
  });

  it("空文本 / 未启动 / 无绑定者时不投递，也不抛错", async () => {
    const notStarted = makeService();
    expect(await notStarted.service.notifyBoundUser("提示")).toBe(false);
    expect(notStarted.delivered).toHaveLength(0);

    const started = makeService();
    await started.service.start();
    expect(await started.service.notifyBoundUser("   ")).toBe(false);
    expect(started.delivered).toHaveLength(0);

    // 白名单为空 → 推导不出绑定者私聊：静默放弃，绝不乱发。
    const unbound = makeService({ config: { allowedUsers: [] } });
    await unbound.service.start();
    expect(await unbound.service.notifyBoundUser("提示")).toBe(false);
    expect(unbound.delivered).toHaveLength(0);
  });

  it("平台拒绝时如实返回 false（不抛错、不伪造送达）", async () => {
    const f = makeService();
    await f.service.start();
    vi.spyOn(f.host, "deliver").mockResolvedValue({
      ok: false,
      error: "40054 主动消息额度已用尽",
      retryable: false,
    });

    await expect(f.service.notifyBoundUser("提示")).resolves.toBe(false);
  });
});

