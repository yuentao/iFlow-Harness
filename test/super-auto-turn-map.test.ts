/**
 * Super Agent 宿主自动回合队列：5 种 kind 的派发 / 判空定点回归。
 *
 * 两处 switch 合并为 SUPER_AUTO_TURN_HANDLERS 后，这里从公开 API 验证行为
 * 完全不变：4 种队列按 mainSessionId 判空、merges 只判非空；仲裁只调用
 * 被选中的那个 drain，并把轮转游标挪到下一位。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { SuperAgentHost } from "../src/panel/super-agent-host.js";
import type { SuperAgentHostCallbacks } from "../src/panel/super-agent-host.js";

type Kind = (typeof SuperAgentHost.SUPER_AUTO_TURN_PRIORITY)[number];
type DrainName =
  | "drainSuperReports"
  | "drainSuperActionReceipts"
  | "drainDelegatedUserTurns"
  | "drainSuperToolCallCorrections"
  | "drainSuperMerges";

const OWNER = "main-under-test";
const KIND_ORDER = SuperAgentHost.SUPER_AUTO_TURN_PRIORITY;
const OWNER_KINDS = ["reports", "actionReceipts", "delegated", "corrections"] as const;
const DRAIN_OF: Record<Kind, DrainName> = {
  reports: "drainSuperReports",
  actionReceipts: "drainSuperActionReceipts",
  delegated: "drainDelegatedUserTurns",
  corrections: "drainSuperToolCallCorrections",
  merges: "drainSuperMerges",
};
const DRAINS = Object.values(DRAIN_OF);

/** 只有 currentMainSessionId / isDisposed 会被这两个公开方法用到；drain 全部打桩。 */
function makeHost(currentMainSessionId: () => string | null = () => OWNER): SuperAgentHost {
  const deps = { currentMainSessionId, isDisposed: () => false } as unknown as SuperAgentHostCallbacks;
  return new SuperAgentHost(deps);
}

function clearQueues(host: SuperAgentHost): void {
  host.pendingSuperReportPrompts = [];
  host.pendingSuperActionReceipts = [];
  host.pendingDelegatedUserTurns = [];
  host.pendingSuperToolCallCorrections = [];
  host.pendingSuperMerges = [];
}

function seedWork(host: SuperAgentHost, kind: Kind, mainSessionId: string | null = OWNER): void {
  clearQueues(host);
  switch (kind) {
    case "reports":
      host.pendingSuperReportPrompts = [{ mainSessionId, text: "R" }];
      break;
    case "actionReceipts":
      host.pendingSuperActionReceipts = [{ mainSessionId, text: "A" }];
      break;
    case "delegated":
      host.pendingDelegatedUserTurns = [
        { mainSessionId, text: "D", images: [], imageCaptions: [], files: [], droppedByChild: 0 },
      ];
      break;
    case "corrections":
      host.pendingSuperToolCallCorrections = [{ mainSessionId, text: "C" }];
      break;
    case "merges":
      host.pendingSuperMerges = [{ id: "m1", reason: "r" }];
      break;
  }
}

function spyDrains(host: SuperAgentHost) {
  return {
    drainSuperReports: vi.spyOn(host, "drainSuperReports").mockResolvedValue(undefined),
    drainSuperActionReceipts: vi.spyOn(host, "drainSuperActionReceipts").mockResolvedValue(undefined),
    drainDelegatedUserTurns: vi.spyOn(host, "drainDelegatedUserTurns").mockResolvedValue(undefined),
    drainSuperToolCallCorrections: vi
      .spyOn(host, "drainSuperToolCallCorrections")
      .mockResolvedValue(undefined),
    drainSuperMerges: vi.spyOn(host, "drainSuperMerges").mockResolvedValue(undefined),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("super auto turn · 映射表行为等价（判空）", () => {
  it("优先级数组由 4 种归属队列 + merges 组成", () => {
    expect(KIND_ORDER).toEqual([...OWNER_KINDS, "merges"]);
  });

  it.each(OWNER_KINDS)("%s 只认属于当前主会话的待投递项", (kind) => {
    const host = makeHost();
    clearQueues(host);
    expect(host.superAutoTurnHasWork(kind, OWNER)).toBe(false);

    seedWork(host, kind, OWNER);
    expect(host.superAutoTurnHasWork(kind, OWNER)).toBe(true);
    expect(host.superAutoTurnHasWork(kind, "someone-else")).toBe(false);

    seedWork(host, kind, null);
    expect(host.superAutoTurnHasWork(kind, null)).toBe(true);
    expect(host.superAutoTurnHasWork(kind, OWNER)).toBe(false);
  });

  it("merges 不带主会话归属，非空即为有工作；空队列为无工作", () => {
    const host = makeHost(() => null);
    clearQueues(host);
    expect(host.superAutoTurnHasWork("merges", null)).toBe(false);
    expect(host.superAutoTurnHasWork("merges", OWNER)).toBe(false);

    seedWork(host, "merges", OWNER);
    expect(host.superAutoTurnHasWork("merges", null)).toBe(true);
    expect(host.superAutoTurnHasWork("merges", OWNER)).toBe(true);
  });

  it("越过类型约束的脏 kind 按原无 default switch 处理：无工作", () => {
    const host = makeHost();
    seedWork(host, "reports", OWNER);
    expect(host.superAutoTurnHasWork("bogus" as never, OWNER)).toBe(false);
  });
});

describe("super auto turn · 映射表行为等价（派发）", () => {
  it.each(KIND_ORDER)("%s 只调用自己的 drain 一次，其余零调用且游标前进", async (kind) => {
    const index = KIND_ORDER.indexOf(kind);
    const host = makeHost();
    seedWork(host, kind, OWNER);
    host.superAutoTurnCursor = index;
    const spies = spyDrains(host);

    await host.drainSuperAutoTurns();

    expect(spies[DRAIN_OF[kind]].mock.calls).toHaveLength(1);
    for (const other of DRAINS) {
      if (other !== DRAIN_OF[kind]) expect(spies[other].mock.calls).toHaveLength(0);
    }
    expect(host.superAutoTurnCursor).toBe((index + 1) % KIND_ORDER.length);
  });

  it("异主的队列不算工作：仲裁跳过且不移动游标", async () => {
    const host = makeHost();
    seedWork(host, "reports", "someone-else");
    host.superAutoTurnCursor = 0;
    const spies = spyDrains(host);

    await host.drainSuperAutoTurns();

    expect(spies.drainSuperReports.mock.calls).toHaveLength(0);
    expect(host.superAutoTurnCursor).toBe(0);
  });

  it("merges 的仲裁不受当前主会话为空影响", async () => {
    const host = makeHost(() => null);
    seedWork(host, "merges");
    host.superAutoTurnCursor = KIND_ORDER.indexOf("merges");
    const spies = spyDrains(host);

    await host.drainSuperAutoTurns();

    expect(spies.drainSuperMerges.mock.calls).toHaveLength(1);
    expect(host.superAutoTurnCursor).toBe(0);
  });
});
