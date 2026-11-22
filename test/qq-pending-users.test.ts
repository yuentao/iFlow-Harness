/**
 * QQ 待审核用户存储（授权模型 2026-11-17）。
 *
 * 钉住的行为：同一 openid 累加次数 / 刷新时间与预览、预览截断、队列上限按
 * `firstSeenAt` 保留最早出现的记录（重复消息不刷新淘汰优先级，刷消息挤不掉
 * 别人）、approve 移除、reject 移除并持久化拒绝集合（同一个 openid 不会再次
 * 出现）、以及所有变更都原子落盘（新实例能读回）。
 *
 * 2026-11-17 补齐：时间清退（超过 TTL 未再出现的记录自动移除、计数与日志
 * 可观测）、满队丢弃不再静默（`record()` 回传 dropped / reason / 累计计数）、
 * 清退后新用户能重新进队。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// 本文件做大量原子写盘（tmp + rename + 索引重建），全量并发时单个用例可能
// 超过默认 5000ms。按文件放宽超时，不动全局 testTimeout。
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  QqPendingUserStore,
  QQ_PENDING_MAX_REJECTED,
  QQ_PENDING_MAX_USERS,
  QQ_PENDING_PREVIEW_CHARS,
  QQ_PENDING_TTL_MS,
  truncateQqPreview,
  type QqPendingUserStoreOptions,
} from "../src/qq/pending-users.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-pending-"));
  roots.push(root);
  return root;
}

/**
 * 固定时钟的 store（既有用例的时间戳都是 1..10000 这类小值，注入 20000 的
 * 时钟既不会误触发 7 天清退，也让「过期」用例可以显式推进时钟）。
 */
const BASE_NOW = 20_000;

function newStore(
  root: string = makeRoot(),
  options: QqPendingUserStoreOptions = {},
): QqPendingUserStore {
  return new QqPendingUserStore(root, {
    now: () => BASE_NOW,
    log: () => undefined,
    ...options,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("QqPendingUserStore — 记录与上限", () => {
  it("同一 openid 累加次数、刷新 lastSeenAt 与最新预览", async () => {
    const store = newStore();
    await store.addOrUpdate({
      openid: "open-1",
      chatType: "private",
      preview: "第一条",
      at: 100,
    });
    const afterSecond = await store.addOrUpdate({
      openid: "open-1",
      chatType: "private",
      preview: "第二条",
      at: 200,
    });

    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]).toMatchObject({
      openid: "open-1",
      firstSeenAt: 100,
      lastSeenAt: 200,
      count: 2,
      preview: "第二条",
      chatType: "private",
    });
    expect(afterSecond[0]?.groupId).toBeUndefined();
  });

  it("群聊记录带 groupId，私聊记录不带", async () => {
    const store = newStore();
    await store.addOrUpdate({
      openid: "open-g",
      chatType: "group",
      groupId: "group-1",
      preview: "群消息",
      at: 1,
    });
    const list = await store.addOrUpdate({
      openid: "open-p",
      chatType: "private",
      preview: "私聊",
      at: 2,
    });
    const group = list.find((user) => user.openid === "open-g");
    const priv = list.find((user) => user.openid === "open-p");
    expect(group?.groupId).toBe("group-1");
    expect(priv?.groupId).toBeUndefined();
  });

  it("预览折叠空白并截断到上限（按码点，不切碎代理对）", async () => {
    const store = newStore();
    const raw = `第一行\n第二行\t${"甲".repeat(200)}`;
    const [user] = await store.addOrUpdate({
      openid: "open-long",
      chatType: "private",
      preview: raw,
      at: 1,
    });
    expect(user?.preview.length).toBe(QQ_PENDING_PREVIEW_CHARS);
    expect(user?.preview.startsWith("第一行 第二行 ")).toBe(true);
    expect(user?.preview).not.toContain("\n");

    // emoji 是代理对：按码点截断不会留下半个字符。
    const emoji = "😀".repeat(QQ_PENDING_PREVIEW_CHARS + 10);
    expect(Array.from(truncateQqPreview(emoji))).toHaveLength(QQ_PENDING_PREVIEW_CHARS);
    expect(truncateQqPreview(emoji).endsWith("😀")).toBe(true);
  });

  it("超过上限时保留最早出现的记录，丢弃最新出现的", async () => {
    const store = newStore();
    for (let index = 0; index < QQ_PENDING_MAX_USERS + 5; index += 1) {
      await store.addOrUpdate({
        openid: `open-${index}`,
        chatType: "private",
        preview: `第 ${index} 条`,
        at: index,
      });
    }
    const list = await store.list();
    expect(list).toHaveLength(QQ_PENDING_MAX_USERS);
    // 先出现的人保留，刚冒出来的 5 个被丢弃。
    expect(list.some((user) => user.openid === "open-0")).toBe(true);
    expect(list.some((user) => user.openid === "open-4")).toBe(true);
    expect(list.some((user) => user.openid === `open-${QQ_PENDING_MAX_USERS}`)).toBe(false);
    expect(list.some((user) => user.openid === `open-${QQ_PENDING_MAX_USERS + 4}`)).toBe(false);
  });

  it("重复消息不刷新淘汰优先级：刷屏的人挤不掉其它待审核记录", async () => {
    const store = newStore();
    for (let index = 0; index < QQ_PENDING_MAX_USERS; index += 1) {
      await store.addOrUpdate({
        openid: `open-${index}`,
        chatType: "private",
        preview: `第 ${index} 条`,
        at: index,
      });
    }

    // 队首的人疯狂刷消息：lastSeenAt 远超其他人，但 firstSeenAt 不变。
    for (let burst = 0; burst < 60; burst += 1) {
      await store.addOrUpdate({
        openid: "open-0",
        chatType: "private",
        preview: `刷屏 ${burst}`,
        at: 10_000 + burst,
      });
    }

    const list = await store.list();
    expect(list).toHaveLength(QQ_PENDING_MAX_USERS);
    const ids = list.map((user) => user.openid);
    for (let index = 0; index < QQ_PENDING_MAX_USERS; index += 1) {
      expect(ids, `open-${index} 被挤掉了`).toContain(`open-${index}`);
    }
    expect(list.find((user) => user.openid === "open-0")?.count).toBe(61);
  });

  it("队列满时新来的人被丢弃，不挤掉已有记录", async () => {
    const store = newStore();
    for (let index = 0; index < QQ_PENDING_MAX_USERS; index += 1) {
      await store.addOrUpdate({
        openid: `open-${index}`,
        chatType: "private",
        preview: `第 ${index} 条`,
        at: index,
      });
    }

    const list = await store.addOrUpdate({
      openid: "newcomer",
      chatType: "private",
      preview: "刚来",
      at: 10_000,
    });
    expect(list).toHaveLength(QQ_PENDING_MAX_USERS);
    const ids = list.map((user) => user.openid);
    expect(ids).not.toContain("newcomer");
    expect(ids).toContain("open-0");
    expect(ids).toContain(`open-${QQ_PENDING_MAX_USERS - 1}`);
  });

  it("list 按 lastSeenAt 倒序返回副本", async () => {
    const store = newStore();
    await store.addOrUpdate({ openid: "a", chatType: "private", preview: "a", at: 10 });
    await store.addOrUpdate({ openid: "b", chatType: "private", preview: "b", at: 20 });
    const list = await store.list();
    expect(list.map((user) => user.openid)).toEqual(["b", "a"]);
    list[0]!.preview = "被外部改坏";
    expect((await store.list())[0]?.preview).toBe("b");
  });
});

describe("QqPendingUserStore — 时间清退与可观测丢弃", () => {
  it("超过 TTL 未再出现的记录被清退，计数与日志可观测", async () => {
    let clock = 1_000_000;
    const logs: string[] = [];
    const store = new QqPendingUserStore(makeRoot(), {
      now: () => clock,
      log: (line) => logs.push(line),
    });

    await store.addOrUpdate({ openid: "stale", chatType: "private", preview: "旧", at: clock });
    expect(await store.list()).toHaveLength(1);

    // 刚过期 1ms：时间清退必须发生。
    clock += QQ_PENDING_TTL_MS + 1;
    const outcome = await store.record({
      openid: "fresh",
      chatType: "private",
      preview: "新",
      at: clock,
    });

    expect(outcome.pruned).toBe(1);
    expect(outcome.prunedTotal).toBe(1);
    expect(outcome.users.map((user) => user.openid)).toEqual(["fresh"]);
    expect(logs.join("\n")).toContain("清退 1 条");
    expect(await store.list()).toHaveLength(1);
  });

  it("未到 TTL 的记录不会被清退（保守值，避免误杀仍在等审核的人）", async () => {
    let clock = 1_000_000;
    const store = new QqPendingUserStore(makeRoot(), { now: () => clock, log: () => undefined });
    await store.addOrUpdate({ openid: "waiting", chatType: "private", preview: "等", at: clock });

    clock += QQ_PENDING_TTL_MS - 1;
    expect((await store.list()).map((user) => user.openid)).toEqual(["waiting"]);
  });

  it("队列被过期记录占满时，新用户仍能进队（不会永久堵死）", async () => {
    let clock = 1_000_000;
    const store = new QqPendingUserStore(makeRoot(), { now: () => clock, log: () => undefined });
    for (let index = 0; index < QQ_PENDING_MAX_USERS; index += 1) {
      await store.addOrUpdate({
        openid: `old-${index}`,
        chatType: "private",
        preview: `第 ${index} 条`,
        at: clock,
      });
    }
    expect(await store.list()).toHaveLength(QQ_PENDING_MAX_USERS);

    clock += QQ_PENDING_TTL_MS + 1;
    const outcome = await store.record({
      openid: "newcomer",
      chatType: "private",
      preview: "刚来",
      at: clock,
    });

    expect(outcome.dropped).toBe(false);
    expect(outcome.pruned).toBe(QQ_PENDING_MAX_USERS);
    expect(outcome.users.map((user) => user.openid)).toEqual(["newcomer"]);
  });

  it("满队丢弃新用户时结果可观测：dropped / 原因 / 累计计数 / 日志", async () => {
    const logs: string[] = [];
    const store = new QqPendingUserStore(makeRoot(), {
      now: () => 1_000_000,
      log: (line) => logs.push(line),
    });
    for (let index = 0; index < QQ_PENDING_MAX_USERS; index += 1) {
      await store.addOrUpdate({
        openid: `open-${index}`,
        chatType: "private",
        preview: `第 ${index} 条`,
        at: 1_000_000 + index,
      });
    }

    const outcome = await store.record({
      openid: "newcomer",
      chatType: "private",
      preview: "刚来",
      at: 1_000_100,
    });
    expect(outcome.dropped).toBe(true);
    expect(outcome.reason).toBe("queue_full");
    expect(outcome.openid).toBe("newcomer");
    expect(outcome.droppedTotal).toBe(1);
    expect(outcome.users).toHaveLength(QQ_PENDING_MAX_USERS);
    expect(outcome.users.some((user) => user.openid === "newcomer")).toBe(false);
    expect(logs.join("\n")).toContain("队列已满");

    // 已在队列里的人再说话不算丢弃（只是累加），累计计数不增。
    const repeated = await store.record({
      openid: "open-0",
      chatType: "private",
      preview: "又一条",
      at: 1_000_200,
    });
    expect(repeated.dropped).toBe(false);
    expect(repeated.reason).toBeUndefined();
    expect(repeated.droppedTotal).toBe(1);
  });

  it("被拒绝的 openid 不占队列、也不会触发丢弃", async () => {
    const store = newStore();
    await store.reject("spam");
    const outcome = await store.record({
      openid: "spam",
      chatType: "private",
      preview: "再来",
      at: 10,
    });
    expect(outcome.dropped).toBe(false);
    expect(outcome.reason).toBe("rejected");
    expect(outcome.users).toHaveLength(0);
  });
});

describe("QqPendingUserStore — 放行 / 拒绝与持久化", () => {
  it("approve 移除记录并落盘（新实例读回同样的状态）", async () => {
    const root = makeRoot();
    const store = newStore(root);
    await store.addOrUpdate({ openid: "open-1", chatType: "private", preview: "hi", at: 1 });
    await store.addOrUpdate({ openid: "open-2", chatType: "private", preview: "hi", at: 2 });

    const left = await store.approve("open-1");
    expect(left.map((user) => user.openid)).toEqual(["open-2"]);

    const reloaded = newStore(root);
    expect((await reloaded.list()).map((user) => user.openid)).toEqual(["open-2"]);
  });

  it("reject 移除记录并持久化拒绝集合：同一 openid 不再出现", async () => {
    const root = makeRoot();
    const store = newStore(root);
    await store.addOrUpdate({ openid: "spam", chatType: "private", preview: "hi", at: 1 });
    await store.reject("spam");
    expect(await store.list()).toHaveLength(0);
    expect(await store.isRejected("spam")).toBe(true);

    // 同一实例与重启后的新实例都必须忽略被拒绝的人。
    expect(await store.addOrUpdate({ openid: "spam", chatType: "private", preview: "again", at: 2 })).toHaveLength(0);
    const reloaded = newStore(root);
    expect(await reloaded.isRejected("spam")).toBe(true);
    expect(await reloaded.addOrUpdate({ openid: "spam", chatType: "private", preview: "again", at: 3 })).toHaveLength(0);
  });

  it("approve 会清掉历史拒绝标记（人工放行优先于旧拒绝）", async () => {
    const store = newStore();
    await store.reject("open-x");
    expect(await store.isRejected("open-x")).toBe(true);
    await store.approve("open-x");
    expect(await store.isRejected("open-x")).toBe(false);
    const list = await store.addOrUpdate({
      openid: "open-x",
      chatType: "private",
      preview: "回来了",
      at: 5,
    });
    expect(list.map((user) => user.openid)).toEqual(["open-x"]);
  });

  it("拒绝集合只保留最近 100 个", async () => {
    const root = makeRoot();
    const store = newStore(root);
    for (let index = 0; index < QQ_PENDING_MAX_REJECTED + 10; index += 1) {
      await store.reject(`bad-${index}`);
    }
    const reloaded = newStore(root);
    // 最新的仍在拒绝集合里，最旧的被挤出。
    expect(await reloaded.isRejected(`bad-${QQ_PENDING_MAX_REJECTED + 9}`)).toBe(true);
    expect(await reloaded.isRejected("bad-0")).toBe(false);
  });

  it("坏文件 / 缺失文件按空处理，不抛错", async () => {
    const root = makeRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "pending-users.json"), "{ not json", "utf8");
    const store = newStore(root);
    expect(await store.list()).toEqual([]);
    expect(await store.isRejected("x")).toBe(false);
    const after = await store.addOrUpdate({
      openid: "x",
      chatType: "private",
      preview: "ok",
      at: 1,
    });
    expect(after.map((user) => user.openid)).toEqual(["x"]);
  });

  it("读盘时也清退过期记录（重启后不会带着旧账继续堵队）", async () => {
    const root = makeRoot();
    let clock = 1_000_000;
    const first = new QqPendingUserStore(root, { now: () => clock, log: () => undefined });
    await first.addOrUpdate({ openid: "stale", chatType: "private", preview: "旧", at: clock });

    clock += QQ_PENDING_TTL_MS + 1;
    const reloaded = new QqPendingUserStore(root, { now: () => clock, log: () => undefined });
    expect(await reloaded.list()).toEqual([]);
    const outcome = await reloaded.record({
      openid: "new",
      chatType: "private",
      preview: "新",
      at: clock,
    });
    expect(outcome.users.map((user) => user.openid)).toEqual(["new"]);
  });
});