/**
 * QQ 待审核用户存储（授权模型 2026-11-17）。
 *
 * 钉住的行为：同一 openid 累加次数 / 刷新时间与预览、预览截断、队列上限按
 * `lastSeenAt` 丢最旧、approve 移除、reject 移除并持久化拒绝集合（同一个
 * openid 不会再次出现）、以及所有变更都原子落盘（新实例能读回）。
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  QqPendingUserStore,
  QQ_PENDING_MAX_REJECTED,
  QQ_PENDING_MAX_USERS,
  QQ_PENDING_PREVIEW_CHARS,
  truncateQqPreview,
} from "../src/qq/pending-users.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-qq-pending-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("QqPendingUserStore — 记录与上限", () => {
  it("同一 openid 累加次数、刷新 lastSeenAt 与最新预览", async () => {
    const store = new QqPendingUserStore(makeRoot());
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
    const store = new QqPendingUserStore(makeRoot());
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
    const store = new QqPendingUserStore(makeRoot());
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

  it("超过上限时按 lastSeenAt 丢掉最旧的记录", async () => {
    const store = new QqPendingUserStore(makeRoot());
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
    // 最旧的 5 个被丢掉，最新的还在。
    expect(list.some((user) => user.openid === "open-0")).toBe(false);
    expect(list.some((user) => user.openid === "open-4")).toBe(false);
    expect(list.some((user) => user.openid === `open-${QQ_PENDING_MAX_USERS + 4}`)).toBe(true);
  });

  it("list 按 lastSeenAt 倒序返回副本", async () => {
    const store = new QqPendingUserStore(makeRoot());
    await store.addOrUpdate({ openid: "a", chatType: "private", preview: "a", at: 10 });
    await store.addOrUpdate({ openid: "b", chatType: "private", preview: "b", at: 20 });
    const list = await store.list();
    expect(list.map((user) => user.openid)).toEqual(["b", "a"]);
    list[0]!.preview = "被外部改坏";
    expect((await store.list())[0]?.preview).toBe("b");
  });
});

describe("QqPendingUserStore — 放行 / 拒绝与持久化", () => {
  it("approve 移除记录并落盘（新实例读回同样的状态）", async () => {
    const root = makeRoot();
    const store = new QqPendingUserStore(root);
    await store.addOrUpdate({ openid: "open-1", chatType: "private", preview: "hi", at: 1 });
    await store.addOrUpdate({ openid: "open-2", chatType: "private", preview: "hi", at: 2 });

    const left = await store.approve("open-1");
    expect(left.map((user) => user.openid)).toEqual(["open-2"]);

    const reloaded = new QqPendingUserStore(root);
    expect((await reloaded.list()).map((user) => user.openid)).toEqual(["open-2"]);
  });

  it("reject 移除记录并持久化拒绝集合：同一 openid 不再出现", async () => {
    const root = makeRoot();
    const store = new QqPendingUserStore(root);
    await store.addOrUpdate({ openid: "spam", chatType: "private", preview: "hi", at: 1 });
    await store.reject("spam");
    expect(await store.list()).toHaveLength(0);
    expect(await store.isRejected("spam")).toBe(true);

    // 同一实例与重启后的新实例都必须忽略被拒绝的人。
    expect(await store.addOrUpdate({ openid: "spam", chatType: "private", preview: "again", at: 2 })).toHaveLength(0);
    const reloaded = new QqPendingUserStore(root);
    expect(await reloaded.isRejected("spam")).toBe(true);
    expect(await reloaded.addOrUpdate({ openid: "spam", chatType: "private", preview: "again", at: 3 })).toHaveLength(0);
  });

  it("approve 会清掉历史拒绝标记（人工放行优先于旧拒绝）", async () => {
    const store = new QqPendingUserStore(makeRoot());
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
    const store = new QqPendingUserStore(root);
    for (let index = 0; index < QQ_PENDING_MAX_REJECTED + 10; index += 1) {
      await store.reject(`bad-${index}`);
    }
    const reloaded = new QqPendingUserStore(root);
    // 最新的仍在拒绝集合里，最旧的被挤出。
    expect(await reloaded.isRejected(`bad-${QQ_PENDING_MAX_REJECTED + 9}`)).toBe(true);
    expect(await reloaded.isRejected("bad-0")).toBe(false);
  });

  it("坏文件 / 缺失文件按空处理，不抛错", async () => {
    const root = makeRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "pending-users.json"), "{ not json", "utf8");
    const store = new QqPendingUserStore(root);
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
});
