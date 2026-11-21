import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifySuperRecovery,
  deleteSuperSessionArchive,
  listSuperSessionArchiveFiles,
  MAX_SUPER_ARCHIVE_DIAGNOSTICS,
  MAX_SUPER_ARCHIVE_DIAGNOSTIC_TEXT,
  readSuperSessionArchive,
  sanitizeSuperArchiveRecord,
  superArchiveRecordFingerprint,
  superArchiveStoreFingerprint,
  superSessionFileName,
  superSessionsDir,
  writeSuperSessionArchive,
} from "../src/panel/super-store.js";
import type { SuperArchiveRecord } from "../src/panel/super-store.js";
import type { PersistedSuperSession } from "../shared/super-agent.js";

function record(overrides: Partial<SuperArchiveRecord> = {}): SuperArchiveRecord {
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

describe("super agent · 超流体归档", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), "iflow-super-store-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

  it("归档保留超流体的 todolist（重启后时间轴仍有步骤可看）", async () => {
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
    // 点与斜杠都被替换掉：归档名不可能再是路径片段；被折叠的 id 追加短 hash。
    expect(superSessionFileName("../../evil")).toMatch(/^------evil-[0-9a-f]{8}\.json$/);
    expect(superSessionFileName("a/b\\c")).toMatch(/^a-b-c-[0-9a-f]{8}\.json$/);
    // 本身就安全的 id 保持原名：旧归档零迁移可读。
    expect(superSessionFileName("main-1")).toBe("main-1.json");
  });

  it("折叠映射是单射：a.b / a-b / a/b 不再撞名", () => {
    const names = [
      superSessionFileName("a.b"),
      superSessionFileName("a-b"),
      superSessionFileName("a/b"),
    ];
    expect(new Set(names).size).toBe(3);
    // hash 稳定：同一个 id 永远得到同一个文件名。
    expect(superSessionFileName("a.b")).toBe(names[0]);
  });

  it("兼容旧文件名：无 hash 的归档仍可读", async () => {
    const dir = superSessionsDir(baseDir);
    mkdirSync(dir, { recursive: true });
    // 旧版本写出的归档名（id 含点号，旧实现折叠成 a-b.json）。
    writeFileSync(
      path.join(dir, "a-b.json"),
      JSON.stringify({ version: 1, sessions: [record({ id: "super-old" })] }),
      "utf8",
    );
    const loaded = await readSuperSessionArchive(baseDir, "a.b");
    expect(loaded.damaged).toBe(false);
    expect(loaded.sessions.map((s) => s.id)).toEqual(["super-old"]);
  });

  it("损坏备份固定单份：反复读取不再新增带时间戳的副本", async () => {
    const dir = superSessionsDir(baseDir);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, superSessionFileName("main-1"));
    writeFileSync(file, "{ 截断的 JSON", "utf8");

    const first = await readSuperSessionArchive(baseDir, "main-1");
    const second = await readSuperSessionArchive(baseDir, "main-1");
    expect(first.damaged).toBe(true);
    expect(second.damaged).toBe(true);
    expect(first.backupPath).toBe(second.backupPath);
    const backups = (await listSuperSessionArchiveFiles(baseDir)).filter((n) =>
      n.endsWith(".corrupt"),
    );
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(dir, backups[0]!), "utf8")).toBe("{ 截断的 JSON");
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

describe("super agent · 归档持久化 v2", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), "iflow-super-store-v2-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const fingerprintOf = (session: SuperArchiveRecord): string =>
    superArchiveStoreFingerprint([{ mainSessionId: "main-1", sessions: [session] }]);

  it("新字段往返：波次 / 依赖 / 尝试 / 失败分类 / 诊断 / 状态说明原样回来", async () => {
    await writeSuperSessionArchive(baseDir, "main-1", [
      record({
        runId: "run-7",
        wave: 2,
        batch: 3,
        dependsOn: ["super-0", "super-1"],
        attempts: 2,
        maxAttempts: 5,
        lastError: { kind: "retryable", message: "网关超时", at: 1234 },
        diagnostics: [
          { at: 1, kind: "spawn", level: "info", message: "拉起子进程" },
          { at: 2, kind: "error", level: "error", message: "网关超时", detail: "ETIMEDOUT" },
        ],
        statusDetail: "上游任务失败，已跳过",
      }),
    ]);
    const loaded = await readSuperSessionArchive(baseDir, "main-1");
    expect(loaded.damaged).toBe(false);
    const got = loaded.sessions[0]!;
    expect(got.runId).toBe("run-7");
    expect(got.wave).toBe(2);
    expect(got.batch).toBe(3);
    expect(got.dependsOn).toEqual(["super-0", "super-1"]);
    expect(got.attempts).toBe(2);
    expect(got.maxAttempts).toBe(5);
    expect(got.lastError).toEqual({ kind: "retryable", message: "网关超时", at: 1234 });
    expect(got.diagnostics).toHaveLength(2);
    expect(got.diagnostics?.[1]?.detail).toBe("ETIMEDOUT");
    expect(got.statusDetail).toBe("上游任务失败，已跳过");
  });

  it("新字段落盘不改变归档版本号（老归档零迁移：版本仍是 1）", async () => {
    await writeSuperSessionArchive(baseDir, "main-1", [record({ wave: 1, runId: "r" })]);
    const raw = JSON.parse(
      readFileSync(path.join(superSessionsDir(baseDir), superSessionFileName("main-1")), "utf8"),
    ) as { version: number; sessions: SuperArchiveRecord[] };
    expect(raw.version).toBe(1);
    expect(raw.sessions[0]?.wave).toBe(1);
  });

  it("旧格式记录（无新字段）照常读回，指纹照常算得出", async () => {
    const dir = superSessionsDir(baseDir);
    mkdirSync(dir, { recursive: true });
    // 手工写一份「v1 形状」的归档：只有 v1 字段，一个新字段都没有。
    const legacy = {
      id: "super-old",
      title: "老记录",
      task: "干活",
      status: "completed",
      mainSessionId: "main-legacy",
      isolation: { kind: "git_worktree", path: "/tmp/wt", branch: "iflow/super/a" },
      createdAt: 1,
      updatedAt: 2,
      reports: [],
    };
    writeFileSync(
      path.join(dir, superSessionFileName("main-legacy")),
      JSON.stringify({ version: 1, sessions: [legacy] }),
      "utf8",
    );
    const loaded = await readSuperSessionArchive(baseDir, "main-legacy");
    expect(loaded.damaged).toBe(false);
    expect(loaded.sessions).toHaveLength(1);
    expect(loaded.sessions[0]?.id).toBe("super-old");
    // 新字段一律缺省，不补零、不填假值。
    expect(loaded.sessions[0]?.wave).toBeUndefined();
    expect(loaded.sessions[0]?.diagnostics).toBeUndefined();
    expect(loaded.sessions[0]?.lastError).toBeUndefined();
    // 指纹对缺失字段按默认值处理，不抛异常。
    const fp = superArchiveStoreFingerprint([
      { mainSessionId: "main-legacy", sessions: loaded.sessions },
    ]);
    expect(typeof fp).toBe("string");
    expect(fp.length).toBeGreaterThan(0);
  });

  it("指纹规则：诊断事件流不参与指纹（高频事件不打爆节流写盘）", () => {
    const base = record({ runId: "r", wave: 1, attempts: 1 });
    const oneDiag = record({
      runId: "r",
      wave: 1,
      attempts: 1,
      diagnostics: [{ at: 1, kind: "spawn", level: "info", message: "x" }],
    });
    const manyDiag = record({
      runId: "r",
      wave: 1,
      attempts: 1,
      diagnostics: [
        { at: 1, kind: "spawn", level: "info", message: "x" },
        { at: 2, kind: "error", level: "error", message: "y" },
      ],
    });
    expect(fingerprintOf(oneDiag)).toBe(fingerprintOf(base));
    expect(fingerprintOf(manyDiag)).toBe(fingerprintOf(base));
  });

  it("指纹规则：状态 / 波次 / 尝试次数 / 失败分类 / 状态说明变了，指纹必变", () => {
    const base = record({ status: "running", wave: 1, attempts: 1 });
    const baseline = fingerprintOf(base);
    expect(fingerprintOf(record({ status: "completed", wave: 1, attempts: 1 }))).not.toBe(baseline);
    expect(fingerprintOf(record({ status: "running", wave: 2, attempts: 1 }))).not.toBe(baseline);
    expect(fingerprintOf(record({ status: "running", wave: 1, attempts: 2 }))).not.toBe(baseline);
    expect(
      fingerprintOf(
        record({
          status: "running",
          wave: 1,
          attempts: 1,
          lastError: { kind: "retryable", message: "boom", at: 5 },
        }),
      ),
    ).not.toBe(baseline);
    expect(
      fingerprintOf(record({ status: "running", wave: 1, attempts: 1, statusDetail: "已跳过" })),
    ).not.toBe(baseline);
  });

  it("指纹稳定：同样内容两次算出来一样；依赖是集合语义（顺序不同不算变化）", () => {
    const r = record({ runId: "r", wave: 3, dependsOn: ["a", "b"], attempts: 2 });
    expect(fingerprintOf(r)).toBe(fingerprintOf(record({ ...r })));
    expect(fingerprintOf(record({ ...r, dependsOn: ["b", "a"] }))).toBe(fingerprintOf(r));
    expect(superArchiveRecordFingerprint(r)).toBe(superArchiveRecordFingerprint(record({ ...r })));
  });

  it("诊断裁剪：超过上限只保留最近的，单条超长文本被截断", async () => {
    const many = Array.from({ length: MAX_SUPER_ARCHIVE_DIAGNOSTICS + 50 }, (_, i) => ({
      at: i,
      kind: "spawn" as const,
      level: "info" as const,
      message: `事件 ${i}`,
    }));
    const long = "x".repeat(MAX_SUPER_ARCHIVE_DIAGNOSTIC_TEXT * 3);
    await writeSuperSessionArchive(baseDir, "main-1", [
      record({
        diagnostics: [
          ...many,
          { at: 9999, kind: "error", level: "error", message: long, detail: long },
        ],
      }),
    ]);
    const loaded = await readSuperSessionArchive(baseDir, "main-1");
    const diags = loaded.sessions[0]?.diagnostics ?? [];
    expect(diags).toHaveLength(MAX_SUPER_ARCHIVE_DIAGNOSTICS);
    // 保留的是**最近**的：最老的那批被裁掉了。
    // 总共 251 条（250 条 + 1 条超长），保留最近 200 条 → 第一条是原数组第 51 条。
    const total = MAX_SUPER_ARCHIVE_DIAGNOSTICS + 50 + 1;
    expect(diags[0]?.at).toBe(total - MAX_SUPER_ARCHIVE_DIAGNOSTICS);
    expect(diags.some((d) => d.at === 0)).toBe(false);
    // 最后一条是超长那条，文本被截到上限以内。
    const last = diags[diags.length - 1]!;
    expect(last.at).toBe(9999);
    expect(last.message.length).toBeLessThanOrEqual(MAX_SUPER_ARCHIVE_DIAGNOSTIC_TEXT);
    expect(last.detail?.length).toBeLessThanOrEqual(MAX_SUPER_ARCHIVE_DIAGNOSTIC_TEXT);
  });

  it("失败分类的说明文本也截断（不让一条超长错误把归档撑大）", () => {
    const long = "y".repeat(MAX_SUPER_ARCHIVE_DIAGNOSTIC_TEXT * 2);
    const sanitized = sanitizeSuperArchiveRecord(
      record({ lastError: { kind: "terminal", message: long, at: 1 } }),
    );
    expect(sanitized.lastError?.kind).toBe("terminal");
    expect(sanitized.lastError?.message.length).toBeLessThanOrEqual(
      MAX_SUPER_ARCHIVE_DIAGNOSTIC_TEXT,
    );
  });

  it("恢复分类：工作目录与分支都在 → 可原地恢复", () => {
    const result = classifySuperRecovery(record({ status: "running" }), {
      worktreeExists: true,
      branchExists: true,
    });
    expect(result.state).toBe("recoverable");
    expect(result.reason).toBeTruthy();
  });

  it("恢复分类：工作目录没了 → 只剩分支，如实说明缺的是哪一样", () => {
    const result = classifySuperRecovery(record({ status: "running" }), {
      worktreeExists: false,
      branchExists: true,
    });
    expect(result.state).toBe("lost");
    expect(result.reason).toContain("工作目录已不存在");
    expect(result.reason).toContain("仅保留分支");
  });

  it("恢复分类：分支没了 → 只剩记录，如实说明缺的是哪一样", () => {
    const result = classifySuperRecovery(record({ status: "running" }), {
      worktreeExists: true,
      branchExists: false,
    });
    expect(result.state).toBe("lost");
    expect(result.reason).toContain("分支已不存在");
    expect(result.reason).toContain("仅保留记录");
  });

  it("恢复分类：已终态且磁盘上什么都没剩 → 没有可恢复的内容", () => {
    const result = classifySuperRecovery(record({ status: "completed" }), {
      worktreeExists: false,
      branchExists: false,
    });
    expect(result.state).toBe("none");
    expect(result.reason).toBeTruthy();
  });

  it("恢复分类：非终态但磁盘上什么都没剩 → 只剩记录（不能说成「没什么可恢复」）", () => {
    const result = classifySuperRecovery(record({ status: "running" }), {
      worktreeExists: false,
      branchExists: false,
    });
    expect(result.state).toBe("lost");
  });

  it("回归：子会话被清理后该主会话归档写成空数组（下次恢复不会又冒出已清理的子会话）", async () => {
    await writeSuperSessionArchive(baseDir, "main-1", [record({ id: "super-1" })]);
    await writeSuperSessionArchive(baseDir, "main-1", []);
    const loaded = await readSuperSessionArchive(baseDir, "main-1");
    expect(loaded.sessions).toEqual([]);
    expect(loaded.damaged).toBe(false);
    const raw = JSON.parse(
      readFileSync(path.join(superSessionsDir(baseDir), superSessionFileName("main-1")), "utf8"),
    ) as { version: number; sessions: unknown[] };
    expect(raw.version).toBe(1);
    expect(raw.sessions).toEqual([]);
  });

  it("回归：带新字段的并发写仍然原子（落盘内容始终是完整的一份）", async () => {
    const payloads = Array.from({ length: 8 }, (_, i) => [
      record({
        id: `super-${i}`,
        wave: i,
        runId: `run-${i}`,
        diagnostics: [{ at: i, kind: "spawn", level: "info", message: `第 ${i} 批` }],
      }),
    ]);
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
    // 落盘内容是**某一次**写入的完整内容（新字段也一致）。
    const expected = payloads.find((batch) => batch[0]?.id === parsed.sessions[0]?.id);
    expect(expected).toBeDefined();
    expect(parsed.sessions[0]?.wave).toBe(expected![0]!.wave);
    expect(parsed.sessions[0]?.diagnostics?.[0]?.message).toBe(expected![0]!.diagnostics?.[0]?.message);
    // 没有临时文件残留。
        const leftovers = (await listSuperSessionArchiveFiles(baseDir)).filter((n) => n.endsWith(".tmp"));
        expect(leftovers).toEqual([]);
      });
    });
    
    describe("super agent · 归档指纹与恢复元数据", () => {
      let baseDir: string;
    
      beforeEach(() => {
        baseDir = mkdtempSync(path.join(tmpdir(), "iflow-super-store-fp-"));
      });
    
      afterEach(() => {
        rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      });
    
      const fingerprintOf = (session: SuperArchiveRecord): string =>
        superArchiveStoreFingerprint([{ mainSessionId: "main-1", sessions: [session] }]);
    
      it("指纹纳入 error：只有人类可读错误的终态也立即落盘", () => {
        const baseline = fingerprintOf(record({ status: "failed" }));
        expect(fingerprintOf(record({ status: "failed", error: "网关超时" }))).not.toBe(baseline);
      });
    
      it("终态进度尾与归一元数据随归档往返保留（多轮重启仍如实）", async () => {
        await writeSuperSessionArchive(baseDir, "main-1", [
          record({
            status: "cancelled",
            interruptedBy: "system",
            progressTail: { text: "最后停在读取登录流程", at: 1999 },
            restoredFromStatus: "running",
            restoreReason: "restart",
          }),
        ]);
        const loaded = await readSuperSessionArchive(baseDir, "main-1");
        const got = loaded.sessions[0]!;
        expect(got.progressTail).toEqual({ text: "最后停在读取登录流程", at: 1999 });
        expect(got.restoredFromStatus).toBe("running");
        expect(got.restoreReason).toBe("restart");
      });
    
      it("activity / tool_call 的结构化细节随归档回来，超长文本被截断", async () => {
        const long = "z".repeat(MAX_SUPER_ARCHIVE_DIAGNOSTIC_TEXT * 2);
        await writeSuperSessionArchive(baseDir, "main-1", [
          record({
            diagnostics: [
              {
                at: 1,
                kind: "activity",
                level: "info",
                message: "最近活动",
                activityDetail: { source: "tool_result", excerpt: long, at: 1 },
              },
              {
                at: 2,
                kind: "tool_call",
                level: "warn",
                message: "工具失败",
                toolCallDetail: {
                  name: "read_file",
                  toolCallId: "call-1",
                  state: "failed",
                  excerpt: long,
                },
              },
            ],
          }),
        ]);
        const loaded = await readSuperSessionArchive(baseDir, "main-1");
        const [activity, toolCall] = loaded.sessions[0]?.diagnostics ?? [];
        expect(activity?.kind).toBe("activity");
        expect(activity?.activityDetail?.source).toBe("tool_result");
        expect(activity?.activityDetail?.excerpt.length).toBeLessThanOrEqual(
          MAX_SUPER_ARCHIVE_DIAGNOSTIC_TEXT,
        );
        expect(toolCall?.kind).toBe("tool_call");
        expect(toolCall?.toolCallDetail?.state).toBe("failed");
        expect(toolCall?.toolCallDetail?.toolCallId).toBe("call-1");
        expect(toolCall?.toolCallDetail?.excerpt?.length).toBeLessThanOrEqual(
          MAX_SUPER_ARCHIVE_DIAGNOSTIC_TEXT,
        );
        // 结构化细节不进指纹：高频活动帧不会触发立即落盘。
        const base = record({ diagnostics: [] });
        expect(fingerprintOf(record({ diagnostics: [activity!, toolCall!] }))).toBe(
          fingerprintOf(base),
        );
      });
    });
    