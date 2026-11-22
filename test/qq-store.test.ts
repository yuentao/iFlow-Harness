import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// 本文件做大量原子写盘（tmp + rename + 索引重建），全量并发时单个用例可能
// 超过默认 5000ms。按文件放宽超时，不动全局 testTimeout。
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
import { DEFAULT_TERMINAL_STATUSES, QqTaskStore } from "../src/qq/store.js";
import { TERMINAL_STATUSES } from "../shared/qq-task.js";

const created: string[] = [];

function makeStore(): QqTaskStore {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qq-store-"));
  created.push(dir);
  return new QqTaskStore(dir);
}

function tasksDir(store: QqTaskStore): string {
  return path.join(store.rootDir, "tasks");
}

function readIndexFile(store: QqTaskStore): { version: number; tasks: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(path.join(tasksDir(store), "index.json"), "utf8")) as {
    version: number;
    tasks: Array<Record<string, unknown>>;
  };
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("QqTaskStore — 任务读写", () => {
  it("保存后能原样读回", async () => {
    const store = makeStore();
    const task = {
      taskId: "t-1",
      status: "running",
      createdAt: 1_000,
      updatedAt: 2_000,
      chatId: "u100",
      senderId: "u100",
      prompt: "帮我看看这个报错",
    };

    await store.saveTask(task);
    expect(await store.loadTask("t-1")).toEqual(task);
  });

  it("同步维护索引，且索引只读不扫任务文件", async () => {
    const store = makeStore();
    await store.saveTask({
      taskId: "a",
      status: "pending",
      createdAt: 1,
      updatedAt: 2,
      chatId: "c1",
      senderId: "s1",
    });

    const index = readIndexFile(store);
    expect(index.version).toBe(1);
    expect(index.tasks).toEqual([
      { taskId: "a", status: "pending", createdAt: 1, updatedAt: 2, chatId: "c1", senderId: "s1" },
    ]);
    expect(await store.listTasks()).toEqual([
      { taskId: "a", status: "pending", createdAt: 1, updatedAt: 2, chatId: "c1", senderId: "s1" },
    ]);
  });

  it("重复保存同一任务会更新条目而不是追加", async () => {
    const store = makeStore();
    await store.saveTask({ taskId: "dup", status: "pending", createdAt: 10, updatedAt: 20 });
    await store.saveTask({ taskId: "dup", status: "completed", createdAt: 10, updatedAt: 30 });

    const listed = await store.listTasks();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ taskId: "dup", status: "completed", updatedAt: 30 });
  });

  it("并发保存不同任务不会丢索引条目，也不会写坏文件", async () => {
    const store = makeStore();
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        store.saveTask({
          taskId: `c-${index}`,
          status: "pending",
          createdAt: index,
          updatedAt: index,
        }),
      ),
    );

    const listed = await store.listTasks();
    expect(listed).toHaveLength(25);
    for (const entry of listed) {
      expect(await store.loadTask(entry.taskId)).not.toBeNull();
    }
    // 索引本身必须是一份合法 JSON（并发写没有交错）
    expect(readIndexFile(store).tasks).toHaveLength(25);
  });

  it("并发保存同一个任务时最终文件仍是完整 JSON", async () => {
    const store = makeStore();
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.saveTask({ taskId: "same", status: "pending", updatedAt: index }),
      ),
    );

    const raw = readFileSync(path.join(tasksDir(store), "same.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect((JSON.parse(raw) as { taskId: string }).taskId).toBe("same");
  });

  it("saveTask 缺少 taskId 时显式报错", async () => {
    const store = makeStore();
    await expect(store.saveTask({ taskId: "   " })).rejects.toThrow(/taskId/);
  });

  it("listTasks 支持 status / since / limit / 倒序", async () => {
    const store = makeStore();
    await store.saveTask({ taskId: "old-done", status: "completed", updatedAt: 100 });
    await store.saveTask({ taskId: "mid-done", status: "completed", updatedAt: 200 });
    await store.saveTask({ taskId: "new-run", status: "running", updatedAt: 300 });

    expect((await store.listTasks({ status: "completed" })).map((e) => e.taskId)).toEqual([
      "mid-done",
      "old-done",
    ]);
    expect((await store.listTasks({ since: 200 })).map((e) => e.taskId)).toEqual([
      "new-run",
      "mid-done",
    ]);
    expect((await store.listTasks({ limit: 1 })).map((e) => e.taskId)).toEqual(["new-run"]);
  });
});

describe("QqTaskStore — 容错与重建", () => {
  it("坏 JSON 被跳过且不抛，重建结果如实报告 skipped", async () => {
    const store = makeStore();
    await store.saveTask({ taskId: "ok", status: "done", updatedAt: 1 });
    mkdirSync(tasksDir(store), { recursive: true });
    writeFileSync(path.join(tasksDir(store), "bad.json"), "{ not json", "utf8");

    const rebuilt = await store.rebuildIndex();
    expect(rebuilt.indexed).toBe(1);
    expect(rebuilt.skipped).toEqual(["bad.json"]);

    // 读坏文件不抛，按不存在处理
    expect(await store.loadTask("bad")).toBeNull();
    expect((await store.listTasks()).map((e) => e.taskId)).toEqual(["ok"]);
  });

  it("索引损坏时 listTasks 自动重建而不是返回空表", async () => {
    const store = makeStore();
    await store.saveTask({ taskId: "survivor", status: "running", updatedAt: 5 });
    writeFileSync(path.join(tasksDir(store), "index.json"), "{ broken", "utf8");

    const listed = await store.listTasks();
    expect(listed.map((e) => e.taskId)).toEqual(["survivor"]);
    // 重建后索引文件恢复为合法 JSON
    expect(readIndexFile(store).tasks).toHaveLength(1);
  });

  it("rebuildIndex 忽略 index.json 与遗留的临时文件", async () => {
    const store = makeStore();
    await store.saveTask({ taskId: "t", status: "running", updatedAt: 1 });
    writeFileSync(path.join(tasksDir(store), "stale.json.tmp-deadbeef"), "garbage", "utf8");

    const rebuilt = await store.rebuildIndex();
    expect(rebuilt.indexed).toBe(1);
    expect(rebuilt.skipped).toEqual([]);
  });
});

describe("QqTaskStore — 事件日志", () => {
  it("appendEvent 每行一个 JSON，可逐行解析", async () => {
    const store = makeStore();
    await store.appendEvent({ type: "task.created", taskId: "e1", detail: "first\nline" });
    await store.appendEvent({ type: "task.completed", taskId: "e1", ts: 123 });

    const raw = readFileSync(path.join(store.rootDir, "events.ndjson"), "utf8");
    const lines = raw.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);

    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events[0]).toMatchObject({ type: "task.created", taskId: "e1" });
    expect(events[0]!.ts).toEqual(expect.any(Number));
    expect(events[1]).toMatchObject({ type: "task.completed", taskId: "e1", ts: 123 });
  });

  it("并发追加不产生交错行", async () => {
    const store = makeStore();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.appendEvent({ type: "tick", detail: index }),
      ),
    );

    const raw = readFileSync(path.join(store.rootDir, "events.ndjson"), "utf8");
    const lines = raw.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(20);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe("QqTaskStore — 绑定白名单", () => {
  it("保存时归一化（去空白、去重），读回一致", async () => {
    const store = makeStore();
    const saved = await store.saveBindings({
      users: [" 10001 ", "10001", "10002"],
      groups: ["20001", ""],
    });
    expect(saved).toEqual({ users: ["10001", "10002"], groups: ["20001"] });
    expect(await store.loadBindings()).toEqual(saved);
  });

  it("缺失或损坏时返回空列表而不抛", async () => {
    const store = makeStore();
    expect(await store.loadBindings()).toEqual({ users: [], groups: [] });

    await store.saveBindings({ users: ["1"], groups: ["2"] });
    writeFileSync(path.join(store.rootDir, "bindings.json"), "not json", "utf8");
    expect(await store.loadBindings()).toEqual({ users: [], groups: [] });
  });
});

describe("QqTaskStore — 清理与原子写", () => {
  it("pruneTasks 只删除终态且超期的任务，并同步索引", async () => {
    const store = makeStore();
    const day = 24 * 60 * 60 * 1000;
    const old = Date.now() - 40 * day;
    const recent = Date.now() - 1 * day;

    await store.saveTask({ taskId: "done-old", status: "completed", createdAt: old, updatedAt: old });
    await store.saveTask({ taskId: "failed-old", status: "failed", createdAt: old, updatedAt: old });
    await store.saveTask({ taskId: "running-old", status: "running", createdAt: old, updatedAt: old });
    await store.saveTask({ taskId: "done-new", status: "completed", createdAt: recent, updatedAt: recent });

    const result = await store.pruneTasks(30);
    expect(result.deleted.sort()).toEqual(["done-old", "failed-old"]);
    expect(result.skipped).toEqual([]);

    expect(await store.loadTask("done-old")).toBeNull();
    expect(await store.loadTask("failed-old")).toBeNull();
    expect(await store.loadTask("running-old")).not.toBeNull();
    expect(await store.loadTask("done-new")).not.toBeNull();

    const indexed = (await store.listTasks()).map((entry) => entry.taskId).sort();
    expect(indexed).toEqual(["done-new", "running-old"]);
  });

  it("pruneTasks 在索引陈旧时以文件为准，不误删仍在跑的任务", async () => {
    const store = makeStore();
    const day = 24 * 60 * 60 * 1000;
    const old = Date.now() - 40 * day;

    // 文件说 running（更新时间很新），索引却被手改成 completed+old
    await store.saveTask({ taskId: "actually-running", status: "running", createdAt: old, updatedAt: Date.now() });
    writeFileSync(
      path.join(tasksDir(store), "index.json"),
      JSON.stringify({
        version: 1,
        tasks: [
          { taskId: "actually-running", status: "completed", createdAt: old, updatedAt: old, chatId: "", senderId: "" },
        ],
      }),
      "utf8",
    );

    const result = await store.pruneTasks(30);
    expect(result.deleted).toEqual([]);
    expect(await store.loadTask("actually-running")).not.toBeNull();
    // 索引已按文件修正
    expect((await store.listTasks())[0]).toMatchObject({ taskId: "actually-running", status: "running" });
  });

  it("所有写入完成后目录里没有残留临时文件", async () => {
    const store = makeStore();
    await store.saveTask({ taskId: "t", status: "running", updatedAt: 1 });
    await store.saveBindings({ users: ["u"], groups: ["g"] });
    await store.appendEvent({ type: "evt" });

    const rootNames = readdirSync(store.rootDir);
    const taskNames = readdirSync(tasksDir(store));
    expect([...rootNames, ...taskNames].filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("索引写入失败时以文件为准重建，不让「文件在、索引无」长期存在", async () => {
    const store = makeStore();
    // 把 index.json 变成一个目录：任何写索引的尝试（rename 到该路径）都会失败。
    const blocker = path.join(tasksDir(store), "index.json");
    mkdirSync(blocker, { recursive: true });

    await expect(
      store.saveTask({ taskId: "resilient", status: "running", updatedAt: 5 }),
    ).rejects.toBeTruthy();
    // 任务文件已经原子落地：失败的是索引这一步，不是保存本身。
    expect(await store.loadTask("resilient")).not.toBeNull();

    // 障碍移除后，读路径以文件为准把索引补齐（stale 标记驱动重建）。
    rmSync(blocker, { recursive: true, force: true });
    const listed = await store.listTasks();
    expect(listed.map((entry) => entry.taskId)).toContain("resilient");
  });

  it("默认终态词表与 shared/qq-task 的 isTerminalStatus 同源", async () => {
    const store = makeStore();
    for (const status of TERMINAL_STATUSES) {
      expect(store.isTerminalStatus(status)).toBe(true);
      expect(DEFAULT_TERMINAL_STATUSES).toContain(status);
    }
    // 非终态绝不能出现在词表里（否则清理会误删在跑的任务）。
    for (const status of ["running", "queued", "waiting_approval", "injected"]) {
      expect(store.isTerminalStatus(status)).toBe(false);
    }
  });

  it("终态词表覆盖超流体上报的别名（与 waitForSettle 同口径）", () => {
    const store = makeStore();
    for (const status of ["done", "error", "aborted", "interrupted", "merged", "cancelled"]) {
      expect(DEFAULT_TERMINAL_STATUSES).toContain(status);
      expect(store.isTerminalStatus(status)).toBe(true);
    }
  });
});