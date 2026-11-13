import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteSuperSessionArchive,
  listSuperSessionArchiveFiles,
  readSuperSessionArchive,
  superSessionFileName,
  superSessionsDir,
  writeSuperSessionArchive,
} from "../src/panel/super-store.js";
import type { PersistedSuperSession } from "../shared/super-agent.js";

function record(overrides: Partial<PersistedSuperSession> = {}): PersistedSuperSession {
  return {
    id: "super-1",
    title: "修复登录跳转",
    task: "修好它",
    status: "completed",
    mainSessionId: "main-1",
    isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/a", baseRef: "abc" },
    createdAt: 1000,
    updatedAt: 2000,
    reports: [],
    ...overrides,
  };
}

describe("super agent · 子会话归档", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), "iflow-super-store-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("写进去再读出来，记录原样回来", async () => {
    await writeSuperSessionArchive(baseDir, "main-1", [record(), record({ id: "super-2" })]);
    const loaded = await readSuperSessionArchive(baseDir, "main-1");
    expect(loaded.sessions).toHaveLength(2);
    expect(loaded.sessions[0]?.id).toBe("super-1");
    expect(loaded.sessions[0]?.isolation.branch).toBe("iflow/super/a");
    expect(loaded.sessions[1]?.id).toBe("super-2");
    expect(loaded.damaged).toBe(false);
  });

  it("归档保留子会话的 todolist（重启后时间轴仍有步骤可看）", async () => {
    const todos = [
      { content: "读代码", status: "completed" as const },
      { content: "改实现", status: "in_progress" as const, priority: "high" as const },
    ];
    await writeSuperSessionArchive(baseDir, "main-1", [record({ todos })]);
    const loaded = await readSuperSessionArchive(baseDir, "main-1");
    // 归档只存记录：todos 是那次运行留下的步骤，必须跟着记录一起回来。
    expect(loaded.sessions[0]?.todos).toEqual(todos);
  });

  it("没归档过的主会话读出空数组（不是错误）", async () => {
    const loaded = await readSuperSessionArchive(baseDir, "never-existed");
    expect(loaded.sessions).toEqual([]);
    // 「本来就没有子会话」不是故障 —— 与「读不出来」必须区分开。
    expect(loaded.damaged).toBe(false);
  });

  it("损坏的归档如实报损坏、保留原件备份，绝不伪装成空归档", async () => {
    const dir = superSessionsDir(baseDir);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, superSessionFileName("main-1"));
    writeFileSync(file, "{ 截断的 JSON", "utf8");

    const loaded = await readSuperSessionArchive(baseDir, "main-1");
    // 读不出来 = 故障，必须让上层知道，而不是当成「这个会话没有子会话」。
    expect(loaded.damaged).toBe(true);
    expect(loaded.damage).toBe("corrupt-json");
    expect(loaded.sessions).toEqual([]);
    // 损坏的原件被留底（备份路径可用、且内容与原件一致）。
    expect(loaded.backupPath).toBeTruthy();
    expect(existsSync(loaded.backupPath!)).toBe(true);
    expect(readFileSync(loaded.backupPath!, "utf8")).toBe("{ 截断的 JSON");
    // 原件仍在原处：下一次读取仍然能报出「损坏」，而不是变成「什么都没有」。
    expect(existsSync(file)).toBe(true);
  });

  it("版本不认识的归档如实报损坏（不当作空归档，也不当成损坏留底）", async () => {
    const dir = superSessionsDir(baseDir);
    await writeSuperSessionArchive(baseDir, "main-1", [record()]);
    writeFileSync(
      path.join(dir, superSessionFileName("main-1")),
      JSON.stringify({ version: 999, sessions: [record()] }),
      "utf8",
    );
    const loaded = await readSuperSessionArchive(baseDir, "main-1");
    expect(loaded.damaged).toBe(true);
    expect(loaded.damage).toBe("unknown-version");
    expect(loaded.sessions).toEqual([]);
    // 文件本身没坏（多半来自更高版本的扩展）—— 不做损坏留底。
    expect(loaded.backupPath).toBeUndefined();
  });

  it("并发写入同一个归档：落盘内容始终是完整的一份，绝不出现半截 JSON", async () => {
    // 旧实现用固定临时文件名且不串行化：两次写共用一个临时文件，后写覆盖
    // 前写的中间产物，rename 出来的可能是交错出来的半截 JSON。
    const payloads = Array.from({ length: 12 }, (_, i) =>
      Array.from({ length: 5 }, (_, j) => record({ id: `super-${i}-${j}`, title: `第 ${i} 批 ${j}` })),
    );
    await Promise.all(
      payloads.map((sessions) => writeSuperSessionArchive(baseDir, "main-1", sessions)),
    );

    const raw = readFileSync(
      path.join(superSessionsDir(baseDir), superSessionFileName("main-1")),
      "utf8",
    );
    // 落盘的一定是**某一次**写入的完整内容（不会是两批混合出来的）。
    const parsed = JSON.parse(raw) as { version: number; sessions: PersistedSuperSession[] };
    expect(parsed.version).toBe(1);
    expect(parsed.sessions).toHaveLength(5);
    const expected = payloads.find(
      (batch) => batch[0]?.id === parsed.sessions[0]?.id,
    );
    expect(expected).toBeDefined();
    expect(parsed.sessions.map((s) => s.id)).toEqual(expected!.map((s) => s.id));
    // 读侧看到的也是同一份（不是空数组，也不是损坏）。
    const loaded = await readSuperSessionArchive(baseDir, "main-1");
    expect(loaded.damaged).toBe(false);
    expect(loaded.sessions.map((s) => s.id)).toEqual(expected!.map((s) => s.id));
    // 没有临时文件残留。
    const leftovers = (await listSuperSessionArchiveFiles(baseDir)).filter((n) => n.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("不同主会话的归档互不干扰（并发写也是）", async () => {
    await Promise.all([
      writeSuperSessionArchive(baseDir, "main-1", [record({ id: "a1" })]),
      writeSuperSessionArchive(baseDir, "main-2", [record({ id: "b1" })]),
      writeSuperSessionArchive(baseDir, "main-1", [record({ id: "a2" })]),
      writeSuperSessionArchive(baseDir, "main-2", [record({ id: "b2" })]),
    ]);
    const one = await readSuperSessionArchive(baseDir, "main-1");
    const two = await readSuperSessionArchive(baseDir, "main-2");
    expect(one.damaged).toBe(false);
    expect(two.damaged).toBe(false);
    expect(one.sessions.map((s) => s.id)).toEqual(["a2"]);
    expect(two.sessions.map((s) => s.id)).toEqual(["b2"]);
  });

  it("内容没变时不重复写（写放大控制）", async () => {
    await writeSuperSessionArchive(baseDir, "main-1", [record()]);
    const file = path.join(superSessionsDir(baseDir), superSessionFileName("main-1"));
    const first = readFileSync(file, "utf8");
    // 同一份内容再写一次：文件内容与修改时间都不该变。
    await writeSuperSessionArchive(baseDir, "main-1", [record()]);
    expect(readFileSync(file, "utf8")).toBe(first);
    // 内容变了就必须写。
    await writeSuperSessionArchive(baseDir, "main-1", [record({ id: "super-9" })]);
    const loaded = await readSuperSessionArchive(baseDir, "main-1");
    expect(loaded.sessions.map((s) => s.id)).toEqual(["super-9"]);
  });

  it("文件名限制成文件系统安全的字符集，恶意 id 不能逃出目录", () => {
    // 点与斜杠都被替换掉：归档名不可能再是路径片段。
    expect(superSessionFileName("../../evil")).toBe("------evil.json");
    expect(superSessionFileName("a/b\\c")).toBe("a-b-c.json");
    expect(superSessionFileName("main-1")).toBe("main-1.json");
  });

  it("删除归档后读不出来", async () => {
    await writeSuperSessionArchive(baseDir, "main-1", [record()]);
    await deleteSuperSessionArchive(baseDir, "main-1");
    const loaded = await readSuperSessionArchive(baseDir, "main-1");
    expect(loaded.sessions).toEqual([]);
    expect(loaded.damaged).toBe(false);
  });

  it("列出归档目录里的文件名（供孤儿清理用）", async () => {
    await writeSuperSessionArchive(baseDir, "main-1", [record()]);
    await writeSuperSessionArchive(baseDir, "main-2", [record()]);
    const names = await listSuperSessionArchiveFiles(baseDir);
    expect(names).toContain("main-1.json");
    expect(names).toContain("main-2.json");
  });

  it("目录还没建时列文件返回空数组", async () => {
    expect(await listSuperSessionArchiveFiles(baseDir)).toEqual([]);
  });

  it("写入是原子的：不会留下半截 JSON（临时文件先落盘再改名）", async () => {
    await writeSuperSessionArchive(baseDir, "main-1", [record()]);
    const dir = superSessionsDir(baseDir);
    const leftovers = (await listSuperSessionArchiveFiles(baseDir)).filter((n) => n.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    const raw = readFileSync(path.join(dir, superSessionFileName("main-1")), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});