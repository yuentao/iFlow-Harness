import { describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "../src/qq/adapter/types.js";
import type { QqConfig } from "../src/qq/config.js";
import {
  QqService,
  qqSpawnPolicyFor,
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
}

interface HostFixture {
  host: QqServiceHost;
  delivered: DeliveredText[];
  notes: string[];
  dispatches: QqServiceDispatchInput[];
  cancels: string[];
  merges: string[];
  discards: string[];
  bindCodes: string[];
  bindSenders: string[];
  unbindCount: { value: number };
}

function makeHost(): HostFixture {
  const delivered: DeliveredText[] = [];
  const notes: string[] = [];
  const dispatches: QqServiceDispatchInput[] = [];
  const cancels: string[] = [];
  const merges: string[] = [];
  const discards: string[] = [];
  const bindCodes: string[] = [];
  const bindSenders: string[] = [];
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
      return true;
    },
    bindAccount: async (code, senderId) => {
      bindCodes.push(code);
      bindSenders.push(senderId);
      return { ok: true, message: `已绑定 ${code}` };
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
    bindCodes,
    bindSenders,
    unbindCount,
  };
}

// ---------------------------------------------------------------------------
// 通用夹具
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<QqConfig> = {}): QqConfig {
  return {
    enabled: true,
    adapter: "onebot",
    endpoint: "http://127.0.0.1:3000",
    bridgePort: 0,
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
    idempotencyKey: `onebot:${taskId}`,
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
        seedTask(id, "succeeded", { createdAt: i, updatedAt: i, payload: { prompt: `任务${i}`, attachments: [], contexts: [] } }),
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

  it("bind / unbind 转发给 host，成功回执只报账号数", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(inbound({ text: "/qq bind abcd12" }));
    expect(f.bindCodes).toEqual(["abcd12"]);
    expect(f.bindSenders).toEqual(["u1"]);
    expect(f.delivered.at(-1)?.text).toBe("已绑定，当前共 1 个账号。");

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
// 绑定流程（必须绕过发送者白名单）
// ---------------------------------------------------------------------------

describe("QqService — 绑定流程", () => {
  it("未在白名单的用户可以完成绑定，宿主收到正确的发送者标识", async () => {
    const f = makeService(); // allowedUsers: ["u1"]
    await f.service.handleInboundMessage(
      inbound({
        chatType: "private",
        chatId: "u2",
        senderId: "u2",
        text: "/qq bind abcd12",
      }),
    );
    expect(f.bindCodes).toEqual(["abcd12"]);
    expect(f.bindSenders).toEqual(["u2"]);
    expect(f.delivered.at(-1)?.text).toBe("已绑定，当前共 2 个账号。");
    expect(f.service.listTasks()).toHaveLength(0);
  });

  it("未绑定用户发 /qq task 仍被静默拒绝", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(
      inbound({ chatId: "u2", senderId: "u2", text: "/qq task 帮我改个东西" }),
    );
    expect(f.delivered).toHaveLength(0);
    expect(f.dispatches).toHaveLength(0);
    expect(f.service.listTasks()).toHaveLength(0);
    expect(f.notes.some((line) => line.includes("白名单"))).toBe(true);
  });

  it("群聊未在 allowedGroups、或未 @ 机器人时 /qq bind 也不放行", async () => {
    const f = makeService();
    await f.service.handleInboundMessage(
      inbound({
        chatType: "group",
        chatId: "g2",
        senderId: "u2",
        mentionsBot: true,
        text: "/qq bind abcd12",
      }),
    );
    await f.service.handleInboundMessage(
      inbound({
        chatType: "group",
        chatId: "g1",
        senderId: "u2",
        mentionsBot: false,
        text: "/qq bind abcd12",
      }),
    );
    expect(f.bindCodes).toHaveLength(0);
    expect(f.delivered).toHaveLength(0);

    // 允许列表内的群 + @ 机器人：名单外的人也能绑定
    await f.service.handleInboundMessage(
      inbound({
        chatType: "group",
        chatId: "g1",
        senderId: "u2",
        mentionsBot: true,
        text: "/qq bind abcd12",
      }),
    );
    expect(f.bindCodes).toEqual(["abcd12"]);
    expect(f.delivered.at(-1)?.text).toBe("已绑定，当前共 2 个账号。");
  });

  it("绑定失败统一回「绑定码无效或已过期」，不泄露码与白名单细节", async () => {
    const f = makeService();
    f.host.bindAccount = async () => ({
      ok: false,
      message: "配对码 abcd12 不存在（当前白名单：u1）",
    });
    await f.service.handleInboundMessage(
      inbound({ senderId: "u2", chatId: "u2", text: "/qq bind abcd12" }),
    );
    const text = f.delivered.at(-1)?.text ?? "";
    expect(text).toBe("绑定码无效或已过期。");
    expect(text).not.toContain("abcd12");
    expect(text).not.toContain("u1");

    // 宿主抛错同样不把内部信息带给 QQ 用户
    f.host.bindAccount = async () => {
      throw new Error("store: EACCES C:\\secret\\bind.json");
    };
    await f.service.handleInboundMessage(
      inbound({ msgId: "b2", senderId: "u2", chatId: "u2", text: "/qq bind abcd12" }),
    );
    expect(f.delivered.at(-1)?.text).toBe("绑定码无效或已过期。");
  });

  it("同一发送者重复绑定幂等成功，回执不回显白名单", async () => {
    const f = makeService();
    const bound = new Set(["u1"]);
    f.host.bindAccount = async (_code, senderId) => {
      bound.add(senderId);
      return { ok: true, message: `已绑定 ${senderId}，白名单：${[...bound].join("、")}` };
    };
    await f.service.handleInboundMessage(
      inbound({ msgId: "b1", senderId: "u2", chatId: "u2", text: "/qq bind abcd12" }),
    );
    await f.service.handleInboundMessage(
      inbound({ msgId: "b2", senderId: "u2", chatId: "u2", text: "/qq bind abcd12" }),
    );
    const receipts = f.delivered.filter((item) => item.text.startsWith("已绑定"));
    expect(receipts).toHaveLength(2);
    expect(receipts[0]?.text).toBe("已绑定，当前共 2 个账号。");
    expect(receipts[1]?.text).toBe("已绑定，当前共 2 个账号。");
    expect(receipts.some((item) => item.text.includes("u1"))).toBe(false);
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
