import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SuperAgentManager,
  awaitSuperPermissionDecision,
  normalizeDisallowedTools,
  resolvePermissionResponse,
  resolveSpawnPolicy,
  toSuperPermissionRequest,
  type SuperPermissionRequest,
  type SuperSpawnPolicy,
} from "../src/panel/super-agent.js";
import type { AcpClient, AcpClientCallbacks } from "../src/acp/client.js";
import type { PermissionOption, RequestPermissionRequest } from "../src/acp/protocol.js";
import type { SuperSessionUi } from "../shared/super-agent.js";

const roots: string[] = [];

/**
 * A stand-in for AcpClient covering only the surface the manager uses.
 *
 * `prompt` deliberately never settles: every test only needs the child to reach
 * "running" so the policy callbacks are reachable — letting the turn finish
 * would drag the integration / worktree-recycle machinery in for no benefit.
 */
class FakeClient {
  modes: string[] = [];
  newSessionRequests: Array<Record<string, unknown>> = [];
  disposed = false;

  constructor(readonly callbacks: AcpClientCallbacks) {}

  async newSession(request: Record<string, unknown>): Promise<{ sessionId: string }> {
    this.newSessionRequests.push(request);
    return { sessionId: "sub-1" };
  }

  async setMode(_sessionId: string, modeId: string): Promise<unknown> {
    this.modes.push(modeId);
    return {};
  }

  async setModel(): Promise<unknown> {
    return {};
  }

  async prompt(): Promise<{ stopReason: string }> {
    return new Promise(() => {
      /* stayed running on purpose */
    });
  }

  cancel(): void {}

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

interface Harness {
  manager: SuperAgentManager;
  clients: FakeClient[];
  sessions: SuperSessionUi[];
}

const managers: SuperAgentManager[] = [];

function makeHarness(policy?: SuperSpawnPolicy): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "iflow-super-policy-"));
  roots.push(root);
  const clients: FakeClient[] = [];
  const sessions: SuperSessionUi[] = [];
  const manager = new SuperAgentManager({
    repoRoot: root,
    createClient: async (params) => {
      const client = new FakeClient(params.callbacks);
      clients.push(client);
      return client as unknown as AcpClient;
    },
    onSessionsChanged: (next) => {
      sessions.length = 0;
      sessions.push(...next);
    },
    onReport: () => {},
    currentModel: () => "test-model",
    currentMainSessionId: () => "main-1",
    integrationMode: () => "manual",
    maxConcurrentSessions: () => 5,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  managers.push(manager);
  return { manager, clients, sessions };
}

async function until(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not met in time");
}

/** Spawn one child under the given policy and wait until it is running. */
async function spawnRunning(
  policy?: SuperSpawnPolicy,
): Promise<{ harness: Harness; client: FakeClient; session: SuperSessionUi }> {
  const harness = makeHarness(policy);
  harness.manager.spawn({ title: "改登录", task: "修好 src/auth.ts" }, policy ? { policy } : undefined);
  await until(() => harness.sessions[0]?.status === "running");
  const client = harness.clients[0];
  const session = harness.sessions[0];
  if (!client || !session) throw new Error("child did not start");
  return { harness, client, session };
}

const PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: "allow-1", name: "允许", kind: "allow_once" },
  { optionId: "always", name: "始终允许", kind: "allow_always" },
  { optionId: "deny-1", name: "拒绝", kind: "reject_once" },
];

function permissionRequest(): RequestPermissionRequest {
  return {
    sessionId: "sub-1",
    toolCall: { toolCallId: "t1", toolName: "write_file", title: "写入 a.txt" },
    options: PERMISSION_OPTIONS,
  };
}

afterAll(async () => {
  for (const manager of managers) await manager.dispose();
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("super agent · 审批策略（纯逻辑）", () => {
  it("缺省策略归一化为 auto：不推 yolo、不改变既有行为", () => {
    expect(resolveSpawnPolicy(undefined)).toEqual({ approval: "auto", disallowedTools: [] });
    expect(resolveSpawnPolicy(null)).toEqual({ approval: "auto", disallowedTools: [] });
    expect(resolveSpawnPolicy({})).toEqual({ approval: "auto", disallowedTools: [] });
    expect(resolveSpawnPolicy({ policy: null })).toEqual({ approval: "auto", disallowedTools: [] });
  });

  it("脏审批模式收敛为 auto，合法值原样保留", () => {
    const dirty = { approval: "Auto" } as unknown as SuperSpawnPolicy;
    expect(resolveSpawnPolicy({ policy: dirty }).approval).toBe("auto");
    const bogus = { approval: "yolo" } as unknown as SuperSpawnPolicy;
    expect(resolveSpawnPolicy({ policy: bogus }).approval).toBe("auto");
    expect(resolveSpawnPolicy({ policy: { approval: "deny" } }).approval).toBe("deny");
    expect(resolveSpawnPolicy({ policy: { approval: "supervised" } }).approval).toBe("supervised");
  });

  it("工具黑名单去空白、去重、丢弃非字符串", () => {
    expect(normalizeDisallowedTools(undefined)).toEqual([]);
    expect(normalizeDisallowedTools(null)).toEqual([]);
    expect(
      normalizeDisallowedTools(["task", " read_file ", "task", "", 42, null, "write_file"] as unknown[]),
    ).toEqual(["task", "read_file", "write_file"]);
    expect(
      resolveSpawnPolicy({
        policy: { approval: "deny", disallowedTools: ["task", "task"] },
      }).disallowedTools,
    ).toEqual(["task"]);
  });

  it("回调保留在归一化策略里；未提供时不伪造", () => {
    const onPermissionRequest = async (): Promise<"allow_once"> => "allow_once";
    expect(resolveSpawnPolicy({ policy: { approval: "supervised", onPermissionRequest } }).onPermissionRequest).toBe(
      onPermissionRequest,
    );
    expect(resolveSpawnPolicy({ policy: { approval: "supervised" } }).onPermissionRequest).toBeUndefined();
  });

  it("裁决映射回 agent 自己给出的 optionId，绝不伪造", () => {
    expect(resolvePermissionResponse(PERMISSION_OPTIONS, "allow_once")).toEqual({
      outcome: { outcome: "selected", optionId: "allow-1" },
    });
    expect(resolvePermissionResponse(PERMISSION_OPTIONS, "allow_always")).toEqual({
      outcome: { outcome: "selected", optionId: "always" },
    });
    expect(resolvePermissionResponse(PERMISSION_OPTIONS, "deny")).toEqual({
      outcome: { outcome: "selected", optionId: "deny-1" },
    });
    expect(resolvePermissionResponse(PERMISSION_OPTIONS, "cancel")).toEqual({
      outcome: { outcome: "cancelled" },
    });
    // 缺少对应种类的选项 → 取消（不伪造批准 / 拒绝）。
    const onlyAllow: PermissionOption[] = [
      { optionId: "allow-1", name: "允许", kind: "allow_once" },
    ];
    expect(resolvePermissionResponse(onlyAllow, "deny")).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("回调缺失 / 抛错 / 超时 / 脏值一律按拒绝处理", async () => {
    const request: SuperPermissionRequest = { sessionId: "s", summary: "写入" };
    expect(await awaitSuperPermissionDecision(undefined, request)).toBe("deny");

    const throws = async (): Promise<"allow_once"> => {
      throw new Error("boom");
    };
    expect(await awaitSuperPermissionDecision(throws, request)).toBe("deny");

    const dirty = async (): Promise<never> => "definitely" as never;
    expect(await awaitSuperPermissionDecision(dirty, request)).toBe("deny");

    const never = (): Promise<"allow_once"> => new Promise(() => {});
    expect(await awaitSuperPermissionDecision(never, request, 20)).toBe("deny");

    const allows = async (): Promise<"allow_always"> => "allow_always";
    expect(await awaitSuperPermissionDecision(allows, request)).toBe("allow_always");
  });

  it("请求摘要携带 wire 请求本体与工具标识", () => {
    const summary = toSuperPermissionRequest(permissionRequest());
    expect(summary).toMatchObject({
      sessionId: "sub-1",
      toolCallId: "t1",
      toolName: "write_file",
      summary: "写入 a.txt",
    });
    expect(summary.request?.options).toBe(PERMISSION_OPTIONS);
  });
});

describe("super agent · 审批策略（编排接线）", () => {
  it("缺省策略保持现状：推 yolo，session/new 不带 settings", async () => {
    const { client } = await spawnRunning();
    expect(client.modes).toEqual(["yolo"]);
    const request = client.newSessionRequests[0];
    expect(request?.settings).toBeUndefined();
    // 主会话的白名单（allowed_tools）与 MCP 作用域都是主会话专属，子会话
    // 一条都不能继承。
    expect(JSON.stringify(request ?? {})).not.toContain("disallowed_tools");
    expect(JSON.stringify(request ?? {})).not.toContain("allowed_tools");
  });

  it("deny：不推 yolo，权限请求与 Plan 退出直接拒绝，提问仍走看板", async () => {
    const { harness, client, session } = await spawnRunning({ approval: "deny" });
    expect(client.modes).toEqual([]);

    const permission = await client.callbacks.onRequestPermission?.(permissionRequest());
    expect(permission).toEqual({ outcome: { outcome: "selected", optionId: "deny-1" } });

    const plan = await client.callbacks.onExitPlanMode?.({ sessionId: "sub-1", plan: "计划正文" });
    expect(plan).toEqual({ approved: false });

    // 提问不是权限：仍然落到子会话自己的 pending 槽位。
    const pending = client.callbacks.onUserQuestions?.({
      sessionId: "sub-1",
      questions: [
        {
          question: "选哪个方案？",
          header: "方案",
          options: [
            { label: "A", description: "先做 A" },
            { label: "B", description: "先做 B" },
          ],
          multiSelect: false,
        },
      ],
    });
    await until(() => harness.sessions[0]?.pending !== undefined);
    expect(harness.sessions[0]?.pending?.questions[0]?.header).toBe("方案");
    expect(harness.manager.respond(session.id, { answers: { 方案: "A" } })).toBe(true);
    expect(await pending).toEqual({ answers: { 方案: "A" } });
  });

  it("supervised：回调被调用并采用其裁决，且不推 yolo", async () => {
    const seen: SuperPermissionRequest[] = [];
    const { client } = await spawnRunning({
      approval: "supervised",
      onPermissionRequest: async (request) => {
        seen.push(request);
        return "allow_once";
      },
    });
    expect(client.modes).toEqual([]);

    const permission = await client.callbacks.onRequestPermission?.(permissionRequest());
    expect(permission).toEqual({ outcome: { outcome: "selected", optionId: "allow-1" } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sessionId: "sub-1", toolName: "write_file", summary: "写入 a.txt" });

    const plan = await client.callbacks.onExitPlanMode?.({ sessionId: "sub-1", plan: "计划正文" });
    expect(plan).toEqual({ approved: true });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ toolName: "plan_exit", plan: "计划正文" });
  });

  it("supervised：回调拒绝 / 抛错 / 未提供时得到拒绝", async () => {
    const denying = await spawnRunning({
      approval: "supervised",
      onPermissionRequest: async () => "deny",
    });
    expect(await denying.client.callbacks.onRequestPermission?.(permissionRequest())).toEqual({
      outcome: { outcome: "selected", optionId: "deny-1" },
    });
    expect(await denying.client.callbacks.onExitPlanMode?.({ sessionId: "sub-1", plan: "p" })).toEqual({
      approved: false,
    });

    const throwing = await spawnRunning({
      approval: "supervised",
      onPermissionRequest: async () => {
        throw new Error("policy exploded");
      },
    });
    expect(await throwing.client.callbacks.onRequestPermission?.(permissionRequest())).toEqual({
      outcome: { outcome: "selected", optionId: "deny-1" },
    });

    const missing = await spawnRunning({ approval: "supervised" });
    expect(await missing.client.callbacks.onRequestPermission?.(permissionRequest())).toEqual({
      outcome: { outcome: "selected", optionId: "deny-1" },
    });
  });

  it("disallowedTools 透传到子会话 session/new 的 settings", async () => {
    const { client } = await spawnRunning({
      approval: "auto",
      disallowedTools: ["task", "read_file", " read_file ", "write_file"],
    });
    expect(client.newSessionRequests[0]?.settings).toEqual({
      disallowed_tools: ["task", "read_file", "write_file"],
    });
  });
});
