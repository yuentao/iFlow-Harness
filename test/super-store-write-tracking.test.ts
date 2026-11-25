import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  superSessionFileName,
  superSessionsDir,
  superStoreWriteTrackingSizes,
  writeSuperSessionArchive,
  writeSuperTranscriptSnapshot,
} from "../src/panel/super-store.js";
import type { SuperArchiveRecord } from "../src/panel/super-store.js";

/**
 * 可按用例开关的内存文件层。
 *
 * 「lastWritten 有界」要写 100 个不同目标才能触发 LRU 淘汰，但它**不需要**
 * 真实磁盘：一次归档写是 `mkdir + writeFile + rename + existsSync` 四次系统
 * 调用，Windows 下 100 个目标 ≈ 400 次 syscall。全量并行（数百个 worker 抢
 * 同一块盘）时这条用例会偶发超过 5s 的用例超时，单独跑却只要 ~200ms ——
 * 典型的负载性 flaky，与实现无关（每次写都是顺序 await，不存在排队）。
 *
 * 这里给 `node:fs` / `node:fs/promises` 加一层**默认完全透传**的 mock，只有
 * 需要压 LRU 的那条用例打开内存模式：走的仍然是 `writeSuperSessionArchive`
 * 的同一条真实代码路径（唯一临时文件 → rename、内容去重、LRU 记账全都在），
 * 只是把磁盘换成内存 Map，于是断言依旧真实覆盖上限与淘汰语义。
 */
const memFs = vi.hoisted(() => ({
  enabled: false,
  /** 内存模式下 `writeFile` 被调用了几次（用于断言「命中缓存就跳过写」）。 */
  writes: 0,
  files: new Map<string, string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const existsSync = ((target: Parameters<typeof actual.existsSync>[0]) =>
    memFs.enabled ? memFs.files.has(String(target)) : actual.existsSync(target)) as typeof actual.existsSync;
  return { ...actual, default: actual, existsSync };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const pathMod = await import("node:path");
  const passthrough = <T extends (...args: never[]) => unknown>(fn: T) =>
    fn as unknown as (...args: unknown[]) => Promise<unknown>;
  const overrides = {
    mkdir: async (dir: unknown, ...rest: unknown[]) => {
      if (!memFs.enabled) return passthrough(actual.mkdir)(dir, ...rest);
      return undefined;
    },
    writeFile: async (file: unknown, data: unknown, ...rest: unknown[]) => {
      if (!memFs.enabled) return passthrough(actual.writeFile)(file, data, ...rest);
      memFs.writes += 1;
      memFs.files.set(String(file), String(data));
    },
    rename: async (from: unknown, to: unknown) => {
      if (!memFs.enabled) return passthrough(actual.rename)(from, to);
      const content = memFs.files.get(String(from));
      if (content === undefined) {
        const error = new Error(`ENOENT: ${String(from)}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      memFs.files.delete(String(from));
      memFs.files.set(String(to), content);
    },
    rm: async (target: unknown, ...rest: unknown[]) => {
      if (!memFs.enabled) return passthrough(actual.rm)(target, ...rest);
      memFs.files.delete(String(target));
    },
    readdir: async (dir: unknown) => {
      if (!memFs.enabled) return passthrough(actual.readdir)(dir);
      const wanted = String(dir);
      const names: string[] = [];
      for (const file of memFs.files.keys()) {
        if (pathMod.dirname(file) === wanted) names.push(pathMod.basename(file));
      }
      return names;
    },
  };
  return {
    ...actual,
    default: actual,
    ...(overrides as unknown as Partial<typeof actual>),
  };
});

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
    memFs.enabled = false;
    memFs.writes = 0;
    memFs.files.clear();
    baseDir = mkdtempSync(path.join(tmpdir(), "iflow-super-recycle-"));
  });

  afterEach(() => {
    memFs.enabled = false;
    memFs.files.clear();
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

  it("lastWritten 有界：连续写很多不同目标不会无界增长，且只淘汰最久未写的", async () => {
    // 内存文件层：断言的是写链 / 去重 / LRU 记账，与磁盘速度无关。
    memFs.enabled = true;
    for (let i = 0; i < 100; i++) {
      await writeSuperSessionArchive(baseDir, `main-${i}`, [record(`super-${i}`)]);
    }
    const sizes = superStoreWriteTrackingSizes();
    expect(sizes.pending).toBe(0);
    // 100 个不同目标写完后，记账映射被压到上限（而不是 100 条）。
    expect(sizes.lastWritten).toBe(64);
    // 淘汰只影响内存记账：所有归档都确实写出去了（100 份，不是 64 份）。
    const names = await readdir(superSessionsDir(baseDir));
    expect(names.filter((name) => name.endsWith(".json"))).toHaveLength(100);
    expect(memFs.writes).toBe(100);

    // 淘汰顺序必须真的是 LRU：最近写过的目标命中缓存、跳过落盘；
    // 最早写的目标已被淘汰，同样的内容也要重新写一次。
    const before = memFs.writes;
    await writeSuperSessionArchive(baseDir, "main-99", [record("super-99")]);
    expect(memFs.writes).toBe(before);
    await writeSuperSessionArchive(baseDir, "main-0", [record("super-0")]);
    expect(memFs.writes).toBe(before + 1);
  });

  it("回收不破坏写放大控制：相同内容再次落盘跳过（mtime 不变）", async () => {
    // 用独立的目标，避免命中前面用例留下的记账（否则第一次写就被跳过，
    // 这条用例就变成空断言）。
    await writeSuperSessionArchive(baseDir, "main-amp", [record()]);
    const file = path.join(superSessionsDir(baseDir), superSessionFileName("main-amp"));
    const first = readFileSync(file, "utf8");
    const mtime = statSync(file).mtimeMs;
    await writeSuperSessionArchive(baseDir, "main-amp", [record()]);
    expect(readFileSync(file, "utf8")).toBe(first);
    expect(statSync(file).mtimeMs).toBe(mtime);
  });
});