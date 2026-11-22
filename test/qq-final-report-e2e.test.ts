/**
 * QQ 完整汇报端到端判别用例（回归 84e0501）。
 *
 * 覆盖完整链路：QQ 入站 → 注入委派（发短提醒）→ 中间进度正文 →
 * 汇总轮交回「与进度措辞相近但更完整」的汇报 → 断言最终 delivered 中出现完整汇报正文。
 *
 * 该用例在「最终答复侧相似去重」存在时失败（完整汇报被 suppressDelivery 吞掉），
 * 移除后通过 —— 用于坐实 bug 与验证修复。
 */
import { describe, it, expect } from "vitest";
import {
  QqService,
  type QqMainInjectInput,
  type QqMainInjectResult,
  type QqServiceHost,
} from "../src/qq/service.js";
import type {
  QqTaskEvent,
  QqTaskIndexEntry,
  QqTaskRecord,
  QqTaskStore,
} from "../src/qq/store.js";
import type { QqTask } from "../shared/qq-task.js";
import type { QqConfig } from "../src/qq/config.js";
import type { InboundMessage } from "../src/qq/adapter/types.js";

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

interface Delivered {
  chatType: "private" | "group";
  chatId: string;
  text: string;
  replyToMsgId?: string;
  dedupeKey?: string;
}

function makeConfig(): QqConfig {
  return {
    enabled: true,
    allowedUsers: ["u1"],
    allowedGroups: [],
    workspace: "/ws",
    remotePolicy: "supervised",
    maxConcurrentTasks: 2,
    rateLimitPerMin: 20,
    resultDetail: "standard",
    autoMerge: false,
  };
}

function makeFixture() {
  const store = new MemoryStore();
  const delivered: Delivered[] = [];
  const injections: Array<{
    input: QqMainInjectInput;
    resolve: (result: QqMainInjectResult) => void;
  }> = [];
  let clock = 0;
  const host: QqServiceHost = {
    workspaceRoots: () => ["/ws"],
    dispatchTask: async () => ({ superSessionId: "super-1", branch: "iflow/qq/test" }),
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
    notify: () => undefined,
    injectIntoMainSession: (input) =>
      new Promise<QqMainInjectResult>((resolve) => {
        injections.push({ input, resolve });
      }),
  };
  const service = new QqService({
    config: makeConfig(),
    store: store as unknown as QqTaskStore,
    host,
    newTaskChannel: "main",
    deliveryRetryDelayMs: 0,
    log: () => undefined,
    now: () => clock,
    monotonicNow: () => clock,
  });
  return { service, store, delivered, injections };
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    chatType: "private",
    chatId: "u1",
    senderId: "u1",
    msgId: "m-e2e",
    text: "帮我打包并推送镜像",
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

describe("QQ 完整汇报端到端转发", () => {
  it("入站 → 短提醒 → 中间进度 → 相似但更完整的汇总汇报：完整汇报必须投递", async () => {
    const f = makeFixture();

    // 1. QQ 入站，触发委派注入。
    await f.service.handleInboundMessage(inbound());
    await waitFor(() => f.injections.length === 1);
    await f.injections[0]!.input.onInjected();
    f.injections[0]!.resolve({
      injected: true,
      text: "已派超流体去做，先等一下",
      stopReason: "end_turn",
      delegated: true,
    });

    // 2. 短提醒通道（main-accepted）独立投递，不受相似去重影响。
    await waitFor(() => f.delivered.some((item) => item.text.includes("已受理，正在处理")));
    const summary = f.service.listTasks()[0];
    if (!summary) throw new Error("没有任务");
    const taskId = summary.taskId;

    // 3. 中间进度正文（deliverMainTurnText 侧相似去重保留）。
    f.delivered.length = 0;
    await f.service.deliverMainTurnText(
      taskId,
      "打包任务已经取消，已经另外派了一个新的打包任务去做",
    );
    expect(f.delivered.length).toBe(1);

    // 4. 汇总轮交回完整汇报：前缀与中间进度高度相似，但带终局信息。
    const finalReport =
      "打包任务已经取消，已经另外派了一个新的打包任务去做；新任务已构建完成并推送镜像，版本 v2.3.1，全部测试通过";
    await f.service.completeMainFinalAnswer({
      taskId,
      text: finalReport,
      stopReason: "end_turn",
    });

    // 5. 完整汇报正文必须出现在 delivered 中，不能只落盘收尾。
    expect(f.delivered.some((item) => item.text.includes("新任务已构建完成并推送镜像"))).toBe(true);
    expect(f.service.getTask(taskId)?.status).toBe("succeeded");
    expect(f.store.events.some((e) => e.type === "task_answer_deduped")).toBe(false);
  });
});
