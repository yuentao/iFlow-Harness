import { describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "../src/qq/adapter/types.js";
import type { QqConfig } from "../src/qq/config.js";
import type { QqPendingUserInput } from "../src/qq/pending-users.js";
import {
  QqService,
  QQ_PROGRESS_REFRESH_MIN_INTERVAL_MS,
  QQ_RESULT_CHANGED_WHILE_DELIVERING,
  QQ_RESULT_RESTORE_RETRY_MS,
  QQ_RESULT_UNDELIVERED,
  fingerprintChunks,
  qqSpawnPolicyFor,
  qqTaskProjectionChanged,
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
import { shortTaskId, type QqTask, type QqTaskStatus } from "../shared/qq-task.js";

// ---------------------------------------------------------------------------
// 假 store（内存）
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
  onChanged?: () => void;
  deliveryRetryDelayMs?: number;
} = {}): ServiceFixture {
  const config = makeConfig(options.config);
  const fixture = makeHost();
  const store = options.store ?? new MemoryStore();
  const service = new QqService({
    config,
    store: store as unknown as QqTaskStore,
    host: fixture.host,
    now: options.now,
    log: () => undefined,
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
    createdAt: 1_000,
    updatedAt: 1_000,
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
    const compact = makeService({ config: { resultDetail: "compact" } });
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

    const detailed = makeService({ config: { resultDetail: "detailed" } });
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
      config: { resultDetail: "compact" },
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
    await waitFor(() => lastTask(f).status === "running");

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
      expect(qqTaskProjectionChanged(base, { ...base, pending: { ...base.pending } })).toBe(false);
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

  it("执行体确认取消的子会话收成 canceled 终态（与 /qq stop 对齐，不再记 failed）", async () => {
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
    // full 档单条消息预算 12000 字符：造超长摘要强制 chunkQqText 分片。
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
    const f = makeService({ now: () => clock });
    f.host.dispatchTask = async (input) => {
      f.dispatches.push(input);
      input.task.correlation.superSessionId = "super-throttle";
      await gate; // 挂起派发：任务停在 running
      return { superSessionId: "super-throttle" };
    };
    f.host.readTaskOutcome = () => ({ summary: "", status: "running" });

    await f.service.handleInboundMessage(inbound({ msgId: "e-throttle-1" }));
    await waitFor(() => lastTask(f).status === "running");
    const taskId = lastTask(f).taskId;

    for (let i = 0; i < 5; i += 1) {
      clock += 1; // 5 次点击都落在最小间隔内
      await f.service.handleTaskAction(taskId, "refresh");
    }
    const progress = f.delivered.filter((item) => item.text.includes("尚未结束"));
    // 只有 1 条进度消息，且复用稳定 dedupeKey —— adapter 据此复用同一个
    // msg_seq，平台按 (msg_id, msg_seq) 去重，不会把终态结果的配额烧光。
    expect(progress).toHaveLength(1);
    expect(progress[0]?.dedupeKey).toBe(`progress:${taskId}:running|running`);

    // 超出最小间隔后才允许再发一条（节流是时间窗，不是永久抑制）。
    clock += QQ_PROGRESS_REFRESH_MIN_INTERVAL_MS + 1;
    await f.service.handleTaskAction(taskId, "refresh");
    expect(f.delivered.filter((item) => item.text.includes("尚未结束"))).toHaveLength(2);

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
        createdAt: 1_000,
        updatedAt: 2_000,
        result: { stopReason: "end_turn", summary: "重启补发的摘要", changes: [], artifacts: [] },
      }),
    );
    store.records.set(
      "T-seed-de00002",
      seedTask("T-seed-de00002", "succeeded", {
        createdAt: 1_000,
        updatedAt: 2_000,
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
        createdAt: 1_000,
        updatedAt: 2_000,
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
          createdAt: i,
          updatedAt: i,
          // 已送达：start() 的重启补发不该在这里插一条结果摘要（本用例只测列表）。
          resultDeliveredAt: i,
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
    expect(f.delivered.at(-1)?.text).toContain("QQ 任务 abc123");

    await f.service.handleInboundMessage(inbound({ text: "/qq status abc" }));
    expect(f.delivered.at(-1)?.text).toContain("命中 2 个任务");

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

  it("unbind 转发给 host；/qq bind 已不是命令（回未知子命令）", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(inbound({ text: "/qq bind abcd12" }));
    expect(f.delivered.at(-1)?.text).toContain("未知子命令");
    expect(f.pendingUsers).toHaveLength(0);

    await f.service.handleInboundMessage(inbound({ text: "/qq unbind" }));
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
        updatedAt: 10,
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
        updatedAt: 20,
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
