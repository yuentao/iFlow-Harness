/**
 * QQ 出站投递的「双通道回退 + 平台错误码留痕」回归（2026-11-19）。
 *
 * 背景：主会话渠道的**最终答复**曾被 `forceActive` 强制走「主动消息」，而
 * 主动消息需要额度 —— 额度用尽时平台以业务错误码拒绝（真实错误码 40054
 * 「主动消息额度已用尽」）。旧实现在这条路上**没有任何兜底**：既没有第二条
 * 通道可退，面板与归档里也没有任何痕迹，用户的最终答复被静默丢弃。
 *
 * 本文件锁住四条纪律：
 *  1. 被动失败 → 自动回退主动并成功送达；
 *  2. 主动失败 → 回退被动（**带 msg_id**）并成功送达；
 *  3. 两条通道都失败 → 归档事件 `task_result_undelivered` + 任务
 *     `deliveryError` + 面板 toast 文案 + 平台错误码，全部留痕；
 *  4. `health().detail`（QQ 设置页「通道状态」的数据源）里能看到平台错误码。
 */

import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../src/qq/adapter/types.js";
import type { QqConfig } from "../src/qq/config.js";
import {
  QqService,
  QQ_RESULT_UNDELIVERED,
  type QqDeliveryOutcome,
  type QqServiceHost,
} from "../src/qq/service.js";
import type {
  QqTaskEvent,
  QqTaskIndexEntry,
  QqTaskRecord,
  QqTaskStore,
} from "../src/qq/store.js";
import { QqBotAdapter, type QqBotTransport } from "../src/qq/qqbot/adapter.js";
import { deliverViaQqBotAdapter } from "../src/panel/qqbot-host.js";
import type { QqTask } from "../shared/qq-task.js";

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

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

interface DeliveredText {
  text: string;
  replyToMsgId?: string;
}

interface Fixture {
  service: QqService;
  store: MemoryStore;
  delivered: DeliveredText[];
  notes: string[];
  logs: string[];
  host: QqServiceHost;
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

function makeFixture(options: {
  config?: Partial<QqConfig>;
  /** 投递实现：按消息决定成败。 */
  deliver?: (msg: { text: string; replyToMsgId?: string }) => QqDeliveryOutcome;
  /** 主会话注入实现；缺省视为「派了子会话，最终答复稍后由宿主回传」。 */
  injectIntoMainSession?: QqServiceHost["injectIntoMainSession"];
  /** 新任务渠道（默认 main，与生产一致）。 */
  newTaskChannel?: "main" | "child";
} = {}): Fixture {
  const delivered: DeliveredText[] = [];
  const notes: string[] = [];
  const logs: string[] = [];
  const store = new MemoryStore();

  const host: QqServiceHost = {
    workspaceRoots: () => ["/ws"],
    dispatchTask: async () => ({ superSessionId: "super-1" }),
    cancelTask: async () => undefined,
    mergeTask: async () => ({ ok: true, detail: "已合并" }),
    discardTask: async () => ({ ok: true }),
    readTaskOutcome: () => ({ summary: "完成", stopReason: "end_turn" }),
    deliver: async (msg) => {
      delivered.push({
        text: msg.text,
        ...(msg.replyToMsgId ? { replyToMsgId: msg.replyToMsgId } : {}),
      });
      return options.deliver
        ? options.deliver({ text: msg.text, ...(msg.replyToMsgId ? { replyToMsgId: msg.replyToMsgId } : {}) })
        : { ok: true };
    },
    onPendingUser: () => undefined,
    unbindAccount: async () => ({ ok: true, message: "已解绑" }),
    notify: (text) => {
      notes.push(text);
    },
    ...(options.injectIntoMainSession
      ? { injectIntoMainSession: options.injectIntoMainSession }
      : {}),
  };

  const service = new QqService({
    config: makeConfig(options.config),
    store: store as unknown as QqTaskStore,
    host,
    newTaskChannel: options.newTaskChannel ?? "main",
    deliveryRetryDelayMs: 0,
    log: (line) => {
      logs.push(line);
    },
  });
  return { service, store, delivered, notes, logs, host };
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

function taskOf(f: Fixture): QqTask {
  const summary = f.service.listTasks()[0];
  if (!summary) throw new Error("没有任务");
  const task = f.service.getTask(summary.taskId);
  if (!task) throw new Error(`任务 ${summary.taskId} 不在内存中`);
  return task;
}

/** 平台拒绝的原文（含真实业务错误码 40054）。 */
const QUOTA_ERROR = "QQBot: 业务错误 40054（主动消息额度已用尽）";

// ---------------------------------------------------------------------------
// 1 / 2：双通道回退
// ---------------------------------------------------------------------------

describe("QQ 出站 — 双通道回退", () => {
  it("被动失败 → 自动回退主动消息并成功送达（子渠道结果回包）", async () => {
    const attempts: Array<string | undefined> = [];
    const f = makeFixture({
      newTaskChannel: "child",
      deliver: (msg) => {
        attempts.push(msg.replyToMsgId);
        // 被动回复（带 msg_id）一律失败，模拟回复窗口已过期；主动消息可达。
        return msg.replyToMsgId === undefined ? { ok: true } : { ok: false, retryable: true };
      },
    });

    await f.service.handleInboundMessage(inbound({ msgId: "e3" }));
    await waitFor(() => taskOf(f).resultDeliveredAt !== undefined);

    const task = taskOf(f);
    expect(task.deliveryError).toBeUndefined();
    expect(attempts.some((id) => id === undefined)).toBe(true);
    // 被动在前、主动在后：先试带 msg_id 的通道。
    expect(attempts[0]).toBe("e3");
  });

  it("主动失败 → 回退被动回复（带 msg_id）并成功送达（主渠道最终答复）", async () => {
    const attempts: Array<string | undefined> = [];
    const f = makeFixture({
      // 主会话渠道：这一轮派了子会话，最终答复由宿主稍后回传。
      injectIntoMainSession: async (input) => {
        await input.onInjected();
        return { injected: true, delegated: true };
      },
      deliver: (msg) => {
        attempts.push(msg.replyToMsgId);
        // 主动消息（不带 msg_id）一律失败，模拟额度用尽；被动回复可达。
        return msg.replyToMsgId === undefined
          ? { ok: false, retryable: false }
          : { ok: true };
      },
    });

    await f.service.handleInboundMessage(inbound({ msgId: "m-final" }));
    await waitFor(() => taskOf(f).status === "injected");
    const taskId = taskOf(f).taskId;
    attempts.length = 0;

    await f.service.completeMainFinalAnswer({
      taskId,
      text: "已经改好了，附验证结果。",
      stopReason: "end_turn",
    });

    const task = taskOf(f);
    expect(task.status).toBe("succeeded");
    // 最终答复送达了：不是「静默丢弃」。
    expect(task.resultDeliveredAt).toBeDefined();
    expect(task.deliveryError).toBeUndefined();
    // 先按「主动优先」发（不带 msg_id），失败后回退被动（带 msg_id）。
    expect(attempts[0]).toBeUndefined();
    expect(attempts.some((id) => id === "m-final")).toBe(true);
    // 兜底成功的那条确实带着 msg_id（是被动回复，不是第三条主动消息）。
    const passive = attempts.filter((id) => id === "m-final");
    expect(passive.length).toBeGreaterThanOrEqual(1);
  });

  it("分片续发的后续分片同样具备双通道回退（主动失败 → 被动兜底）", async () => {
    const attempts: Array<string | undefined> = [];
    const f = makeFixture({
      config: { resultDetail: "full" },
      newTaskChannel: "child",
      deliver: (msg) => {
        attempts.push(msg.replyToMsgId);
        // 首片（被动）成功；续片一律先试主动（失败），再回退被动。
        if (msg.replyToMsgId !== undefined) return { ok: true };
        return { ok: false, retryable: false };
      },
    });
    // 造一份需要分片的摘要（full 档不截断正文）。
    f.host.readTaskOutcome = () => ({
      summary: Array.from(
        { length: 150 },
        (_, i) => `第 ${i} 项：${"摘要正文填充内容。".repeat(9)}`,
      ).join("\n"),
      status: "completed",
      stopReason: "end_turn",
    });

    await f.service.handleInboundMessage(inbound({ msgId: "chunk-fb" }));
    await waitFor(() => taskOf(f).resultDeliveredAt !== undefined);

    const task = taskOf(f);
    expect(task.deliveryError).toBeUndefined();
    // 续片最终是靠「被动回退」送出去的（带 msg_id），而不是被丢掉。
    expect(attempts.filter((id) => id === "chunk-fb").length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// 3：两条通道都失败 → 留痕
// ---------------------------------------------------------------------------

describe("QQ 出站 — 两条通道都失败的留痕", () => {
  it("产生 task_result_undelivered 归档事件、deliveryError、toast，并保留平台错误码", async () => {
    const f = makeFixture({
      injectIntoMainSession: async (input) => {
        await input.onInjected();
        return { injected: true, delegated: true };
      },
      deliver: () => ({ ok: false, retryable: false, error: QUOTA_ERROR }),
    });

    await f.service.handleInboundMessage(inbound({ msgId: "m-dead" }));
    await waitFor(() => taskOf(f).status === "injected");
    const taskId = taskOf(f).taskId;

    await f.service.completeMainFinalAnswer({
      taskId,
      text: "这条最终答复送不出去。",
      stopReason: "end_turn",
    });

    const task = taskOf(f);
    // 任务本身的状态不受回包失败影响（执行确实结束了）。
    expect(task.status).toBe("succeeded");
    expect(task.resultDeliveredAt).toBeUndefined();
    // 任务记录里有 deliveryError，且**带着平台错误码**。
    expect(task.deliveryError).toContain("未能送达");
    expect(task.deliveryError).toContain("40054");
    expect(task.deliveryError).toContain("主动消息额度已用尽");

    // 归档事件：类型 + 错误码都在。
    const undelivered = f.store.events.filter(
      (event) => event.type === "task_result_undelivered",
    );
    expect(undelivered.length).toBeGreaterThan(0);
    const detail = JSON.stringify(undelivered.at(-1)?.detail ?? {});
    expect(detail).toContain("40054");

    // 面板 toast 文案（「结果未能送达 QQ（被动回复与主动消息均失败）」）。
    expect(f.notes.some((line) => line.includes(QQ_RESULT_UNDELIVERED))).toBe(true);

    // 宿主输出通道日志：含平台错误码与文案。
    expect(f.logs.some((line) => line.includes("40054"))).toBe(true);
    expect(f.logs.some((line) => line.includes("主动消息额度已用尽"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4：平台错误码可见（health().detail / 通道状态）
// ---------------------------------------------------------------------------

/** 只实现发送端点的假 transport：token 正常，发送按脚本返回。 */
class ScriptedTransport implements QqBotTransport {
  sendResult: unknown = { id: "sent-1" };

  async connect(): Promise<never> {
    throw new Error("本用例不建连");
  }

  async post(endpoint: string): Promise<unknown> {
    if (endpoint.includes("getAppAccessToken")) {
      return { access_token: "tok-1", expires_in: 7200 };
    }
    return this.sendResult;
  }
}

describe("QQ 通道状态 — 平台错误码可见", () => {
  it("业务错误码（40054）出现在 health().detail，且成功发送后仍保留", async () => {
    const transport = new ScriptedTransport();
    const adapter = new QqBotAdapter({
      appId: "app-1",
      appSecret: "secret-1",
      transport,
    });

    // HTTP 200 + 业务错误码：平台拒绝了这次主动消息。
    transport.sendResult = { code: 40054, message: "主动消息额度已用尽" };
    const failed = await adapter.send({
      chatType: "private",
      chatId: "openid-1",
      text: "最终答复",
    });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("40054");

    const detail = (await adapter.health()).detail ?? "";
    expect(detail).toContain("40054");
    expect(detail).toContain("最近发送被拒");

    // 随后一次成功发送**不会**抹掉这条拒绝原因：额度见底是用户必须知道的事实。
    transport.sendResult = { id: "sent-2" };
    await adapter.send({ chatType: "private", chatId: "openid-1", text: "补发" });
    const after = (await adapter.health()).detail ?? "";
    expect(after).toContain("40054");
  });

  it("qqbot-host 的出站翻译保留平台错误码（不再丢弃 result.error）", async () => {
    const adapter = {
      send: async () => ({ ok: false, error: QUOTA_ERROR, retryable: false }),
    };
    const outcome = await deliverViaQqBotAdapter(adapter, {
      chatType: "private",
      chatId: "u1",
      text: "最终答复",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("40054");
  });
});
