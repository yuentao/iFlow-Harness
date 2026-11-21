/**
 * 批次1B 新 Super Agent 消息在 panel.ts 的路由守卫。
 *
 * 这些消息此前未进 WebviewToHost switch，会落到版本不匹配 tripwire（只打
 * 一条 warn 然后静默丢弃）。本文件把「消息 → 宿主方法」的转发钉死，防止
 * 后续重构再把某个 case 搬丢或转发错参数。
 */
import { describe, it, expect, vi } from "vitest";
import { ChatPanel } from "../src/panel/panel.js";
import type { HostToWebview, WebviewToHost } from "../shared/messages.js";
import type { SuperResidueItem } from "../src/panel/super-agent.js";

type PanelInternals = {
  handleWebviewMessage: (msg: WebviewToHost) => Promise<void>;
  _superHost: unknown;
  postToWebview: (m: unknown) => void;
  log: { trace: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void };
  store: { sendToast: (...a: unknown[]) => void };
};

const item: SuperResidueItem = {
  key: "J:\\repo-super-worktrees\\demo-ab12",
  kind: "worktree",
  path: "J:\\repo-super-worktrees\\demo-ab12",
  branch: "iflow/super/demo-ab12",
  sessionId: "child-1",
  title: "demo",
  unmerged: true,
  uncommitted: false,
  inProgress: false,
};

const item2: SuperResidueItem = {
  ...item,
  key: "J:\\repo-super-worktrees\\demo-cd34",
  path: "J:\\repo-super-worktrees\\demo-cd34",
  branch: "iflow/super/demo-cd34",
  sessionId: "child-2",
  title: "demo2",
};

function makeHarness(items: SuperResidueItem[] = [item]) {
  const posted: HostToWebview[] = [];
  const host = {
    retrySuperWave: vi.fn(async (_input: { runId?: string; wave: number }) => {}),
    retrySuperFailed: vi.fn(async (_input: { runId?: string }) => {}),
    listSuperResidue: vi.fn(async (): Promise<SuperResidueItem[]> => items),
    handleSuperResidueAction: vi.fn(async (_input: { key: string; action: "merge" | "discard" }) => ({ ok: true })),
    handleSuperResidueDiscardBatch: vi.fn(async (_input: { keys: string[] }) => ({ ok: false, token: "tok" })),
  };
  const panel = Object.create(ChatPanel.prototype) as unknown as PanelInternals;
  panel._superHost = host;
  panel.postToWebview = (m) => posted.push(m as HostToWebview);
  panel.log = { trace: vi.fn(), warn: vi.fn(), info: vi.fn() };
  panel.store = { sendToast: vi.fn() };
  const route = (msg: WebviewToHost) => panel.handleWebviewMessage(msg);
  return { panel, host, posted, route };
}

describe("补齐 panel 消息路由 · Super Agent 新消息", () => {
  it("superRetryWave 转发 runId + wave 到宿主 retrySuperWave", async () => {
    const { host, route } = makeHarness();
    await route({ type: "superRetryWave", runId: "run-1", wave: 2 });
    expect(host.retrySuperWave).toHaveBeenCalledTimes(1);
    expect(host.retrySuperWave).toHaveBeenCalledWith({ runId: "run-1", wave: 2 });
  });

  it("superRetryFailed 转发 runId 到宿主 retrySuperFailed", async () => {
    const { host, route } = makeHarness();
    await route({ type: "superRetryFailed", runId: "run-1" });
    expect(host.retrySuperFailed).toHaveBeenCalledWith({ runId: "run-1" });
  });

  it("requestSuperResidueList 回包 superResidueList：requestId/分支/一次性令牌齐全", async () => {
    const { host, posted, route } = makeHarness();
    await route({ type: "requestSuperResidueList", requestId: "req-1" });
    expect(host.listSuperResidue).toHaveBeenCalledTimes(1);
    expect(posted).toHaveLength(1);
    const msg = posted[0]!;
    expect(msg.type).toBe("superResidueList");
    if (msg.type !== "superResidueList") return;
    expect(msg.requestId).toBe("req-1");
    expect(msg.confirmToken).toMatch(/^super-residue-list-/);
    expect(msg.branches[0]?.sessionId).toBe("child-1");
    expect(msg.branches[0]?.branch).toBe("iflow/super/demo-ab12");
  });

  it("superResidueHandle 凭清单令牌把 UI sessionId 翻译成宿主键后转发", async () => {
    const { host, posted, route } = makeHarness();
    await route({ type: "requestSuperResidueList", requestId: "req-1" });
    const token = (posted[0] as Extract<HostToWebview, { type: "superResidueList" }>).confirmToken;
    await route({
      type: "superResidueHandle",
      action: "merge",
      sessionIds: ["child-1"],
      confirmToken: token,
    });
    expect(host.handleSuperResidueAction).toHaveBeenCalledWith({ key: item.key, action: "merge" });
  });

  it("superResidueHandle 令牌失效时拒绝转发且给出提示", async () => {
    const { host, panel, route } = makeHarness();
    await route({
      type: "superResidueHandle",
      action: "discard",
      sessionIds: ["child-1"],
      confirmToken: "stale-token",
    });
    expect(host.handleSuperResidueAction).not.toHaveBeenCalled();
    expect(panel.store.sendToast).toHaveBeenCalled();
  });

  it("superResidueHandle 的一次性令牌用过即作废，不可复用", async () => {
    const { host, posted, route } = makeHarness();
    await route({ type: "requestSuperResidueList", requestId: "req-1" });
    const token = (posted[0] as Extract<HostToWebview, { type: "superResidueList" }>).confirmToken;
    const handle: WebviewToHost = {
      type: "superResidueHandle",
      action: "merge",
      sessionIds: ["child-1"],
      confirmToken: token,
    };
    await route(handle);
    await route(handle);
    expect(host.handleSuperResidueAction).toHaveBeenCalledTimes(1);
  });

  it("superResidueHandle 批量合并：逐个把 UI sessionId 翻译成宿主键并转发", async () => {
    const { host, posted, route } = makeHarness([item, item2]);
    await route({ type: "requestSuperResidueList", requestId: "req-1" });
    const token = (posted[0] as Extract<HostToWebview, { type: "superResidueList" }>).confirmToken;
    await route({
      type: "superResidueHandle",
      action: "merge",
      sessionIds: ["child-1", "child-2"],
      confirmToken: token,
    });
    expect(host.handleSuperResidueAction).toHaveBeenCalledTimes(2);
    expect(host.handleSuperResidueAction).toHaveBeenNthCalledWith(1, { key: item.key, action: "merge" });
    expect(host.handleSuperResidueAction).toHaveBeenNthCalledWith(2, { key: item2.key, action: "merge" });
    expect(host.handleSuperResidueDiscardBatch).not.toHaveBeenCalled();
  });

  it("superResidueHandle 批量丢弃：聚合成一次批量确认，不逐条丢弃", async () => {
    const { host, posted, route } = makeHarness([item, item2]);
    await route({ type: "requestSuperResidueList", requestId: "req-1" });
    const token = (posted[0] as Extract<HostToWebview, { type: "superResidueList" }>).confirmToken;
    await route({
      type: "superResidueHandle",
      action: "discard",
      sessionIds: ["child-1", "child-2"],
      confirmToken: token,
    });
    expect(host.handleSuperResidueDiscardBatch).toHaveBeenCalledTimes(1);
    expect(host.handleSuperResidueDiscardBatch).toHaveBeenCalledWith({
      keys: [item.key, item2.key],
    });
    expect(host.handleSuperResidueAction).not.toHaveBeenCalled();
  });
});