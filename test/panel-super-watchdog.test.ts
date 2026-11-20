import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SuperAgentManager,
  SUPER_STALL_WATCHDOG_MS,
} from "../src/panel/super-agent.js";
import { AcpClient, type AcpClientCallbacks } from "../src/acp/client.js";
import type { ContentBlock } from "../src/acp/protocol.js";
import type { SuperReport, SuperSessionUi } from "../shared/super-agent.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 非 git 仓库 → 目录隔离；避免测试依赖 git，也避开 worktree 创建的开销。 */
function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "iflow-sa1-wd-"));
  roots.push(dir);
  return dir;
}

type Plan = "hang" | "complete";

/**
 * 只实现管理器用到的一小撮客户端表面。`hang` 计划模拟 SA-1 要抓的故障形态：
 * 进程「还在」（isAlive=true）、在途 prompt 永不返回、且**没有任何**
 * session/update 事件。
 */
class WatchdogFakeClient {
  disposed = false;
  /** 存活探测结果，测试可改为 false 走「进程失联」分支。 */
  alive = true;
  /** 心跳间隔（ms）：>0 时 prompt 期间持续发 update，用来验证不会被误杀。 */
  heartbeatMs = 0;
  promptStarted = false;
  settle: ((value: { stopReason: string }) => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly callbacks: AcpClientCallbacks,
    private readonly plan: Plan,
  ) {}

  async newSession(): Promise<{ sessionId: string }> {
    return { sessionId: `sub-${Math.random().toString(36).slice(2, 8)}` };
  }
  async setMode(): Promise<unknown> {
    return {};
  }
  async setModel(): Promise<unknown> {
    return {};
  }
  async mcpStatus(): Promise<unknown> {
    return { available: false, servers: {} };
  }

  async prompt(_request: {
    sessionId: string;
    prompt: ContentBlock[];
  }): Promise<{ stopReason: string }> {
    this.promptStarted = true;
    if (this.heartbeatMs > 0) {
      this.heartbeat = setInterval(() => {
        this.callbacks.onSessionUpdate?.({
          sessionId: "sub",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "still working" },
          },
        } as never);
      }, this.heartbeatMs);
      if (typeof this.heartbeat?.unref === "function") this.heartbeat.unref();
    }
    if (this.plan === "complete") return { stopReason: "end_turn" };
    return new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  isAlive(): boolean {
    return this.alive;
  }
  cancel(): void {
    this.settle?.({ stopReason: "cancelled" });
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    // 刻意不触发 onExit —— 模拟「进程失联 / 在途请求永不返回」的卡死形态，
    // 让看门狗成为唯一的归一来源。
  }
}

interface Harness {
  manager: SuperAgentManager;
  clients: WatchdogFakeClient[];
  sessions: SuperSessionUi[];
  reports: { session: SuperSessionUi; report: SuperReport }[];
  warns: string[];
}

function makeManager(options: {
  maxConcurrent?: number;
  stallMs?: number;
  plans?: Plan[] | Plan;
  configure?: (client: WatchdogFakeClient, index: number) => void;
} = {}): Harness {
  const repoRoot = makeRepo();
  const clients: WatchdogFakeClient[] = [];
  const sessions: SuperSessionUi[] = [];
  const reports: { session: SuperSessionUi; report: SuperReport }[] = [];
  const warns: string[] = [];
  const plans = options.plans ?? "hang";
  const manager = new SuperAgentManager({
    repoRoot,
    createClient: async (params) => {
      const plan = Array.isArray(plans) ? (plans[clients.length] ?? "hang") : plans;
      const client = new WatchdogFakeClient(params.callbacks, plan);
      options.configure?.(client, clients.length);
      clients.push(client);
      return client as unknown as AcpClient;
    },
    onSessionsChanged: (next) => {
      sessions.length = 0;
      sessions.push(...next);
    },
    onReport: (entries) => {
      reports.push(...entries);
    },
    currentModel: () => null,
    currentMainSessionId: () => "main-1",
    integrationMode: () => "manual",
    maxConcurrentSessions: () => options.maxConcurrent ?? 5,
    log: {
      info: () => {},
      warn: (msg: string) => warns.push(msg),
      error: () => {},
    },
  });
  manager.stallTimeoutMs = options.stallMs ?? 80;
  return { manager, clients, sessions, reports, warns };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时：条件未满足");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Super Agent 子会话卡死看门狗（SA-1）", () => {
  it("默认阈值足够保守，且仅作为实例字段默认值存在", () => {
    // 真实长任务可跑数小时；默认阈值必须远大于分钟级，避免误杀正在思考的任务。
    expect(SUPER_STALL_WATCHDOG_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it("无进展超阈值：归一为 failed + error + 上报 + 回收槽位让队列下一个开跑", async () => {
    const h = makeManager({ maxConcurrent: 1, stallMs: 80, plans: ["hang", "complete"] });
    try {
      const a = h.manager.spawn({ title: "卡死的子会话", task: "hang" });
      const b = h.manager.spawn({ title: "排队等槽位", task: "complete" });
      expect(b.queued).toBe(true);

      await waitFor(() => h.clients.length >= 1 && h.clients[0]!.promptStarted);
      await waitFor(() => h.sessions.find((s) => s.id === a.id)?.status === "failed");

      const failed = h.sessions.find((s) => s.id === a.id)!;
      expect(failed.status).toBe("failed");
      expect(failed.error).toMatch(/无响应超时/);
      expect(h.reports.some((e) => e.session.id === a.id && e.report.state === "failed")).toBe(true);
      expect(h.warns.some((w) => w.includes("看门狗触发"))).toBe(true);
      expect(h.clients[0]!.disposed).toBe(true);

      // 槽位回收：被卡死的子会话归一后，队列里的 B 才能真正启动并正常完成。
      await waitFor(() => h.clients.length >= 2 && h.clients[1]!.promptStarted);
      await waitFor(() => h.sessions.find((s) => s.id === b.id)?.status === "completed");
      expect(h.sessions.find((s) => s.id === b.id)!.status).toBe("completed");
    } finally {
      await h.manager.dispose();
    }
  });

  it("持续 session/update 刷新最近进展：慢任务不会被误杀", async () => {
    const h = makeManager({
      stallMs: 80,
      plans: "hang",
      configure: (client) => {
        client.heartbeatMs = 20;
      },
    });
    try {
      const s = h.manager.spawn({ title: "慢但活着", task: "hang" });
      await waitFor(() => h.clients[0]?.promptStarted === true);
      // 等待超过 3 倍阈值：心跳持续刷新 lastProgressAt，观察窗不断后移。
      await new Promise((resolve) => setTimeout(resolve, 300));
      const live = h.sessions.find((x) => x.id === s.id)!;
      expect(live.status).toBe("running");
      expect(live.error).toBeUndefined();
      expect(h.reports.some((e) => e.session.id === s.id && e.report.state === "failed")).toBe(false);
      expect(h.clients[0]!.disposed).toBe(false);
    } finally {
      await h.manager.dispose();
    }
  });

  it("存活探测为 false（进程失联）：按进程退出归一，写明 error", async () => {
    const h = makeManager({
      stallMs: 60,
      plans: "hang",
      configure: (client) => {
        client.alive = false;
      },
    });
    try {
      const s = h.manager.spawn({ title: "进程失联", task: "hang" });
      await waitFor(() => h.sessions.find((x) => x.id === s.id)?.status === "failed");
      const failed = h.sessions.find((x) => x.id === s.id)!;
      expect(failed.error).toMatch(/进程已退出/);
      expect(h.reports.some((e) => e.session.id === s.id && e.report.state === "failed")).toBe(true);
    } finally {
      await h.manager.dispose();
    }
  });

  it("只看子会话：不属于管理器的主会话 prompt（无限等待）不受影响", async () => {
    const h = makeManager({ stallMs: 50, plans: "hang" });
    // 一个刻意不交给管理器的「主会话」客户端：prompt 同样挂起，且没有 isAlive
    // 之外的任何看门狗 —— 证明看门狗的作用域严格限于 manager.clients。
    const mainClient = new WatchdogFakeClient({}, "hang");
    const mainPrompt = mainClient.prompt({ sessionId: "main", prompt: [] });
    try {
      const s = h.manager.spawn({ title: "被看门狗归一的孩子", task: "hang" });
      await waitFor(() => h.sessions.find((x) => x.id === s.id)?.status === "failed");

      expect(mainClient.disposed).toBe(false);
      expect(mainClient.settle).not.toBeNull(); // 主会话在途 prompt 仍挂着，未被取消
      // isAlive 是纯只读探测：未连接任何子进程时返回 false，且不抛错、不建定时器。
      const bare = new AcpClient({
        command: "node",
        args: ["-e", ""],
        cwd: makeRepo(),
      });
      expect(bare.isAlive()).toBe(false);
      expect(() => bare.isAlive()).not.toThrow();
    } finally {
      mainClient.settle?.({ stopReason: "cancelled" });
      await mainPrompt;
      await h.manager.dispose();
    }
  });

  it("dispose 清除看门狗定时器，不留悬挂 timer", async () => {
    const h = makeManager({ stallMs: 80, plans: "hang" });
    const s = h.manager.spawn({ title: "待清理", task: "hang" });
    try {
      await waitFor(() => h.clients[0]?.promptStarted === true);
      const internal = h.manager as unknown as {
        watchdogTimers: Map<string, unknown>;
        watchdogs: Map<string, unknown>;
      };
      expect(internal.watchdogTimers.size).toBe(1);
      expect(internal.watchdogs.size).toBe(1);

      await h.manager.dispose();
      expect(internal.watchdogTimers.size).toBe(0);
      expect(internal.watchdogs.size).toBe(0);

      // 再等超过阈值：已取消的会话不会被迟到的 watchdog 覆盖成 failed。
      await new Promise((resolve) => setTimeout(resolve, 200));
      const after = h.sessions.find((x) => x.id === s.id)!;
      expect(after.status).toBe("cancelled");
      expect(after.error).toBeUndefined();
    } finally {
      await h.manager.dispose();
    }
  });
});
