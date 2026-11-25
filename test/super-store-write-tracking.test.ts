import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  superSessionFileName,
  superSessionsDir,
  superStoreWriteTrackingSizes,
  writeSuperSessionArchive,
  writeSuperTranscriptSnapshot,
} from "../src/panel/super-store.js";
import type { SuperArchiveRecord } from "../src/panel/super-store.js";

function record(id = "super-1"): SuperArchiveRecord {
  return {
    id,
    title: "修复登录跳转",
    task: "修好它",
    status: "completed",
    mainSessionId: "main-1",
    isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/a", baseRef: "abc" },
    createdAt: 1000,
    updatedAt: 2000,
    reports: [],
  };
}

describe("super 归档写入映射回收", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), "iflow-super-recycle-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("归档写完后写链映射归零，记账映射只保留少量目标", async () => {
    await writeSuperSessionArchive(baseDir, "main-1", [record()]);
    const sizes = superStoreWriteTrackingSizes();
    // pendingWrites 是串行链，收尾后必须没有任何残留条目，否则长期运行会
    // 为每个写过的目标永久留下一个 Promise。
    expect(sizes.pending).toBe(0);
    expect(sizes.lastWritten).toBeGreaterThanOrEqual(1);
    expect(sizes.lastWritten).toBeLessThanOrEqual(64);
  });

  it("转录快照写完后写链映射同样归零", async () => {
    await writeSuperTranscriptSnapshot(baseDir, "super-1", []);
    expect(superStoreWriteTrackingSizes().pending).toBe(0);
  });

  it("并发写同一归档仍串行（落盘是完整的一份），写链映射最终归零", async () => {
    const payloads = Array.from({ length: 10 }, (_, i) => [record(`super-${i}`)]);
    await Promise.all(
      payloads.map((sessions) => writeSuperSessionArchive(baseDir, "main-1", sessions)),
    );

    const raw = readFileSync(
      path.join(superSessionsDir(baseDir), superSessionFileName("main-1")),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { version: number; sessions: SuperArchiveRecord[] };
    expect(parsed.version).toBe(1);
    expect(parsed.sessions).toHaveLength(1);
    // 落盘内容一定是**某一次**写入的完整内容，而不是交错出来的半截。
    const expected = payloads.find((batch) => batch[0]!.id === parsed.sessions[0]?.id);
    expect(expected).toBeDefined();
    expect(parsed.sessions[0]!.id).toBe(expected![0]!.id);
    // 条件删除只回收自己的链尾：所有并发写排完队后，映射必须归零。
    expect(superStoreWriteTrackingSizes().pending).toBe(0);
  });

  it("lastWritten 有界：连续写很多不同目标不会无界增长", async () => {
    for (let i = 0; i < 100; i++) {
      await writeSuperSessionArchive(baseDir, `main-${i}`, [record(`super-${i}`)]);
    }
    const sizes = superStoreWriteTrackingSizes();
    expect(sizes.pending).toBe(0);
    // 100 个不同目标写完后，记账映射仍被限制在上限内（而不是 100 条）。
    expect(sizes.lastWritten).toBeLessThanOrEqual(64);
    expect(sizes.lastWritten).toBeGreaterThan(0);
    // 淘汰只影响内存记账：所有归档都确实落盘了。
    const names = await import("node:fs/promises").then((fs) =>
      fs.readdir(superSessionsDir(baseDir)),
    );
    expect(names.filter((name) => name.endsWith(".json"))).toHaveLength(100);
  });

  it("回收不破坏写放大控制：相同内容再次落盘跳过（mtime 不变）", async () => {
    await writeSuperSessionArchive(baseDir, "main-1", [record()]);
    const file = path.join(superSessionsDir(baseDir), superSessionFileName("main-1"));
    const first = readFileSync(file, "utf8");
    const mtime = statSync(file).mtimeMs;
    await writeSuperSessionArchive(baseDir, "main-1", [record()]);
    expect(readFileSync(file, "utf8")).toBe(first);
    expect(statSync(file).mtimeMs).toBe(mtime);
  });
});
