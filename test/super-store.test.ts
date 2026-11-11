import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.id).toBe("super-1");
    expect(loaded[0]?.isolation.branch).toBe("iflow/super/a");
    expect(loaded[1]?.id).toBe("super-2");
  });

  it("没归档过的主会话读出空数组（不是错误）", async () => {
    expect(await readSuperSessionArchive(baseDir, "never-existed")).toEqual([]);
  });

  it("损坏的归档读出空数组，不拖垮恢复流程", async () => {
    const dir = superSessionsDir(baseDir);
    await writeSuperSessionArchive(baseDir, "main-1", [record()]);
    writeFileSync(path.join(dir, superSessionFileName("main-1")), "{ 截断的 JSON", "utf8");
    expect(await readSuperSessionArchive(baseDir, "main-1")).toEqual([]);
  });

  it("版本不认识的归档读出空数组", async () => {
    const dir = superSessionsDir(baseDir);
    await writeSuperSessionArchive(baseDir, "main-1", [record()]);
    writeFileSync(
      path.join(dir, superSessionFileName("main-1")),
      JSON.stringify({ version: 999, sessions: [record()] }),
      "utf8",
    );
    expect(await readSuperSessionArchive(baseDir, "main-1")).toEqual([]);
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
    expect(await readSuperSessionArchive(baseDir, "main-1")).toEqual([]);
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
