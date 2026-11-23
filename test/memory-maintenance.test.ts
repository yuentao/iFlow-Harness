import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MemoryScope } from "../shared/messages.js";
import { estimateMarkdownTokens } from "../shared/memory-curate.js";
import { sha256 } from "../src/memory/files.js";
import {
  MaintenanceConflictError,
  runMaintenance,
  type MaintenanceDeps,
  type MaintenanceLogLevel,
} from "../src/memory/maintenance.js";

const dirs: string[] = [];

function tempHome(prefix = "iflow-mem-maint-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

const UNIQUE_FIXTURE = [
  "# 记忆",
  "",
  "## iFlow Added Memories",
  "",
  "- 使用 pnpm 管理依赖",
  "- 回答使用中文",
  "",
].join("\n");

/** 两条归一化后相同的事实（大小写 / 标点差异），planCuration 会去重掉第二条。 */
const DUP_FIXTURE = [
  "# 记忆",
  "",
  "## iFlow Added Memories",
  "",
  "- 使用 pnpm",
  "- 使用 pnpm。",
  "- 回答使用中文",
  "",
].join("\n");

interface FakeFile {
  path: string;
  scope: MemoryScope;
  content: string;
}

interface FakeOptions {
  home: string;
  files: FakeFile[];
  now?: Date;
  writeFile?: (
    filePath: string,
    content: string,
    expectedHash: string,
    store: Map<string, string>,
  ) => Promise<void>;
  log?: (level: MaintenanceLogLevel, message: string, detail?: unknown) => void;
  measureTokens?: (markdown: string) => number;
  budgets?: { global?: number; project?: number };
  suggestMerges?: MaintenanceDeps["suggestMerges"];
  dryRun?: () => boolean;
}

function createDeps(options: FakeOptions): {
  deps: MaintenanceDeps;
  store: Map<string, string>;
  writes: Array<{ path: string; content: string; expectedHash: string }>;
} {
  const store = new Map(options.files.map((file) => [file.path, file.content]));
  const writes: Array<{ path: string; content: string; expectedHash: string }> = [];
  const now = options.now ?? new Date("2026-11-24T00:00:00.000Z");
  const deps: MaintenanceDeps = {
    listFiles: async () =>
      options.files.map((file) => ({ path: file.path, scope: file.scope, kind: "primary" })),
    readFile: async (filePath) => {
      const content = store.get(filePath);
      if (content === undefined) throw new Error(`ENOENT: ${filePath}`);
      return { content, hash: sha256(content) };
    },
    writeFile: async (filePath, content, expectedHash) => {
      if (options.writeFile) {
        await options.writeFile(filePath, content, expectedHash, store);
        return;
      }
      const current = store.get(filePath) ?? "";
      if (sha256(current) !== expectedHash) throw new MaintenanceConflictError();
      store.set(filePath, content);
      writes.push({ path: filePath, content, expectedHash });
    },
    home: options.home,
    now: () => now,
    ...(options.log ? { log: options.log } : {}),
    ...(options.measureTokens ? { measureTokens: options.measureTokens } : {}),
    ...(options.budgets ? { budgets: options.budgets } : {}),
    ...(options.suggestMerges ? { suggestMerges: options.suggestMerges } : {}),
    ...(options.dryRun ? { dryRun: options.dryRun } : {}),
  };
  return { deps, store, writes };
}

describe("runMaintenance: 无动作", () => {
  it("计划为空时标记 skipped 且不写文件、不建备份", async () => {
    const home = tempHome();
    const file = path.join(home, "AGENTS.md");
    const { deps, writes } = createDeps({
      home,
      files: [{ path: file, scope: "global", content: UNIQUE_FIXTURE }],
    });

    const report = await runMaintenance(deps, "manual");

    expect(report.files).toHaveLength(1);
    expect(report.files[0]?.status).toBe("skipped");
    expect(report.files[0]?.reason).toBe("no-actions");
    expect(writes).toHaveLength(0);
    expect(existsSync(path.join(home, "memory-backups"))).toBe(false);
    expect(report.totalBeforeTokens).toBe(report.totalAfterTokens);
    expect(report.savedTokens).toBe(0);
  });
});

describe("runMaintenance: 重复事实", () => {
  it("去重后 applied，托管区块 token 下降并写回文件", async () => {
    const home = tempHome();
    const file = path.join(home, "AGENTS.md");
    const { deps, store, writes } = createDeps({
      home,
      files: [{ path: file, scope: "global", content: DUP_FIXTURE }],
    });

    const report = await runMaintenance(deps, "manual");

    const entry = report.files[0];
    expect(entry?.status).toBe("applied");
    expect(entry?.dropped).toBe(1);
    expect(entry?.merged).toBe(0);
    expect(entry?.archived).toBe(0);
    expect(entry!.afterTokens).toBeLessThan(entry!.beforeTokens);
    expect(report.savedTokens).toBeGreaterThan(0);
    expect(writes).toHaveLength(1);

    const stored = store.get(file) ?? "";
    const pnpmLines = stored.split("\n").filter((line) => line.includes("pnpm"));
    expect(pnpmLines).toHaveLength(1);
    expect(stored).toContain("- 使用 pnpm");
    expect(report.backupsCreated).toBe(1);
  });
});

describe("runMaintenance: 写冲突", () => {
  it("写入抛冲突时标记 conflict，文件内容原样保留", async () => {
    const home = tempHome();
    const file = path.join(home, "AGENTS.md");
    const { deps, store } = createDeps({
      home,
      files: [{ path: file, scope: "global", content: DUP_FIXTURE }],
      writeFile: async () => {
        throw new MaintenanceConflictError();
      },
    });

    const report = await runMaintenance(deps, "manual");

    expect(report.files[0]?.status).toBe("conflict");
    expect(report.files[0]?.reason).toContain("改动");
    expect(store.get(file)).toBe(DUP_FIXTURE);
    expect(report.savedTokens).toBe(0);
    expect(report.totalAfterTokens).toBe(report.totalBeforeTokens);
  });
});

describe("runMaintenance: 备份顺序", () => {
  it("写入前已经创建了备份", async () => {
    const home = tempHome();
    const file = path.join(home, "AGENTS.md");
    const { deps } = createDeps({
      home,
      files: [{ path: file, scope: "global", content: DUP_FIXTURE }],
      writeFile: async (filePath, content, _expectedHash, store) => {
        const backupDir = path.join(home, "memory-backups");
        expect(existsSync(backupDir)).toBe(true);
        expect(readdirSync(backupDir).length).toBeGreaterThan(0);
        store.set(filePath, content);
      },
    });

    const report = await runMaintenance(deps, "manual");

    expect(report.files[0]?.status).toBe("applied");
    expect(report.backupsCreated).toBe(1);
  });
});

describe("runMaintenance: token 未下降", () => {
  it("放弃写入并记一条 warning", async () => {
    const home = tempHome();
    const file = path.join(home, "AGENTS.md");
    const warnings: string[] = [];
    const { deps, store, writes } = createDeps({
      home,
      files: [{ path: file, scope: "global", content: DUP_FIXTURE }],
      measureTokens: () => 42,
      log: (level, message) => {
        if (level === "warn") warnings.push(message);
      },
    });

    const report = await runMaintenance(deps, "manual");

    expect(report.files[0]?.status).toBe("skipped");
    expect(report.files[0]?.reason).toBe("tokens-not-reduced");
    expect(writes).toHaveLength(0);
    expect(store.get(file)).toBe(DUP_FIXTURE);
    expect(warnings.some((message) => message.includes("token"))).toBe(true);
  });
});

describe("runMaintenance: 审计日志", () => {
  it("每轮向 events.ndjson 追加一行 JSON", async () => {
    const home = tempHome();
    const file = path.join(home, "AGENTS.md");
    const { deps } = createDeps({
      home,
      files: [{ path: file, scope: "global", content: DUP_FIXTURE }],
    });

    await runMaintenance(deps, "manual");
    // 第二轮已无重复，应该 skipped，但仍然追加一行。
    await runMaintenance(deps, "scheduled");

    const eventsPath = path.join(home, "memory-maintenance", "events.ndjson");
    const lines = readFileSync(eventsPath, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(first.trigger).toBe("manual");
    expect(first.files).toBe(1);
    expect(first.applied).toBe(1);
    expect(first.savedTokens).toBeGreaterThan(0);

    const second = JSON.parse(lines[1] ?? "") as Record<string, unknown>;
    expect(second.trigger).toBe("scheduled");
    expect(second.skipped).toBe(1);
    expect(second.applied).toBe(0);
  });
});

// --- L2 语义合并 ---------------------------------------------------------------

/**
 * 两条语义重复但**文本不同**的事实：L1 的去重（按归一化指纹）不会动它们，
 * 只有 L2 模型层能把它们合并。用于验证 merge 动作真的产生了。
 */
const SEMANTIC_FIXTURE = [
  "# 记忆",
  "",
  "## iFlow Added Memories",
  "",
  "- 项目使用 pnpm 管理依赖",
  "- 依赖安装统一用 pnpm",
  "",
].join("\n");

/** L1 会去重掉第二条（"使用 pnpm。" 归一化后与 "使用 pnpm" 相同）。 */
const DUP_PLUS_SEMANTIC = [
  "# 记忆",
  "",
  "## iFlow Added Memories",
  "",
  "- 使用 pnpm",
  "- 使用 pnpm。",
  "- 回答使用中文",
  "",
].join("\n");

describe("runMaintenance: L2 语义合并", () => {
  it("未注入 suggestMerges 时行为与纯 L1 完全一致（不标注 l2）", async () => {
    const home = tempHome();
    const file = path.join(home, "AGENTS.md");
    const { deps, writes } = createDeps({
      home,
      files: [{ path: file, scope: "global", content: SEMANTIC_FIXTURE }],
    });

    const report = await runMaintenance(deps, "manual");

    const entry = report.files[0];
    expect(entry?.status).toBe("skipped");
    expect(entry?.reason).toBe("no-actions");
    expect(entry?.l2).toBeUndefined();
    expect(entry?.rejectedMerges).toBeUndefined();
    expect(writes).toHaveLength(0);
  });

  it("返回有效建议时产生 merge 动作、token 下降并写回合并文本", async () => {
    const home = tempHome();
    const file = path.join(home, "AGENTS.md");
    const calls: string[][] = [];
    const { deps, store, writes } = createDeps({
      home,
      files: [{ path: file, scope: "global", content: SEMANTIC_FIXTURE }],
      suggestMerges: async (facts) => {
        calls.push(facts);
        return {
          suggestions: [
            {
              keep: "项目使用 pnpm 管理依赖",
              absorb: ["依赖安装统一用 pnpm"],
              merged: "依赖统一用 pnpm 管理",
              reason: "同一约定",
            },
          ],
          rejected: [],
        };
      },
    });

    const report = await runMaintenance(deps, "manual");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["项目使用 pnpm 管理依赖", "依赖安装统一用 pnpm"]);
    const entry = report.files[0];
    expect(entry?.status).toBe("applied");
    expect(entry?.l2).toBe("ran");
    expect(entry?.merged).toBe(1);
    expect(entry!.afterTokens).toBeLessThan(entry!.beforeTokens);
    expect(report.savedTokens).toBeGreaterThan(0);
    expect(writes).toHaveLength(1);

    const stored = store.get(file) ?? "";
    expect(stored).toContain("- 依赖统一用 pnpm 管理");
    expect(stored).not.toContain("- 依赖安装统一用 pnpm");
  });

  it("keep/absorb 在事实中不存在时不产生动作并记入 rejected", async () => {
    const home = tempHome();
    const file = path.join(home, "AGENTS.md");
    const { deps, store, writes } = createDeps({
      home,
      files: [{ path: file, scope: "global", content: SEMANTIC_FIXTURE }],
      suggestMerges: async () => ({
        suggestions: [
          {
            keep: "不存在的事实",
            absorb: ["依赖安装统一用 pnpm"],
            merged: "随便",
            reason: "幻觉",
          },
        ],
        rejected: [],
      }),
    });

    const report = await runMaintenance(deps, "manual");

    const entry = report.files[0];
    expect(entry?.status).toBe("skipped");
    expect(entry?.reason).toBe("no-actions");
    expect(entry?.merged).toBe(0);
    expect(entry?.rejectedMerges).toHaveLength(1);
    expect(entry?.rejectedMerges?.[0]?.reason).toContain("无法在托管事实中定位");
    expect(writes).toHaveLength(0);
    expect(store.get(file)).toBe(SEMANTIC_FIXTURE);

    // rejected 逐条落进 events.ndjson（字段 at / path / reason / suggestion）。
    const eventsPath = path.join(home, "memory-maintenance", "events.ndjson");
    const lines = readFileSync(eventsPath, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2); // 汇总行 + 一条 rejected
    const rejectedLine = JSON.parse(lines[1] ?? "") as Record<string, unknown>;
    expect(rejectedLine.path).toBe(file);
    expect(typeof rejectedLine.at).toBe("string");
    expect(String(rejectedLine.reason)).toContain("无法在托管事实中定位");
    expect(String(rejectedLine.suggestion)).toContain("不存在的事实");
  });

  it("merge 与 L1 动作抢同一行时被丢弃并记入 rejected", async () => {
    const home = tempHome();
    const file = path.join(home, "AGENTS.md");
    const { deps, store } = createDeps({
      home,
      files: [{ path: file, scope: "global", content: DUP_PLUS_SEMANTIC }],
      suggestMerges: async () => ({
        suggestions: [
          {
            // absorb 指向 L1 dedupe 会删除的那一行（"使用 pnpm。"）。
            keep: "回答使用中文",
            absorb: ["使用 pnpm。"],
            merged: "用中文回答，依赖用 pnpm",
            reason: "跨行合并",
          },
        ],
        rejected: [],
      }),
    });

    const report = await runMaintenance(deps, "manual");

    const entry = report.files[0];
    // L1 去重仍然生效；L2 merge 被丢弃，不产生 merged 计数。
    expect(entry?.status).toBe("applied");
    expect(entry?.dropped).toBe(1);
    expect(entry?.merged).toBe(0);
    expect(entry?.rejectedMerges?.some((item) => item.reason.includes("冲突"))).toBe(true);

    const stored = store.get(file) ?? "";
    // L1 的保留项还在，L2 的合并文本没有写进去。
    expect(stored).toContain("- 使用 pnpm");
    expect(stored).not.toContain("用中文回答，依赖用 pnpm");
  });

  it("suggestMerges 抛错时该文件降级为 L1 并记警告，不影响其它文件", async () => {
    const home = tempHome();
    const failing = path.join(home, "AGENTS.md");
    const healthy = path.join(home, "project.md");
    const warnings: string[] = [];
    const { deps, store } = createDeps({
      home,
      files: [
        { path: failing, scope: "global", content: SEMANTIC_FIXTURE },
        { path: healthy, scope: "project", content: DUP_FIXTURE },
      ],
      log: (level, message) => {
        if (level === "warn") warnings.push(message);
      },
      suggestMerges: async (facts) => {
        if (facts.some((fact) => fact.includes("pnpm 管理依赖"))) throw new Error("网关超时");
        return { suggestions: [], rejected: [] };
      },
    });

    const report = await runMaintenance(deps, "manual");

    const failingEntry = report.files.find((f) => f.path === failing);
    const healthyEntry = report.files.find((f) => f.path === healthy);
    // 抛错的文件：L1 无动作 → skipped，但标注 L2 失败。
    expect(failingEntry?.status).toBe("skipped");
    expect(failingEntry?.l2).toBe("failed");
    // 另一个文件照常走 L1 去重并写回。
    expect(healthyEntry?.status).toBe("applied");
    expect(healthyEntry?.dropped).toBe(1);
    expect(store.get(failing)).toBe(SEMANTIC_FIXTURE);
    expect(warnings.some((message) => message.includes("L2 语义合并失败"))).toBe(true);
  });

  it("report 模式下即使注入了 suggestMerges 也不调用，并标注已跳过", async () => {
    const home = tempHome();
    const file = path.join(home, "AGENTS.md");
    let calls = 0;
    const { deps } = createDeps({
      home,
      files: [{ path: file, scope: "global", content: SEMANTIC_FIXTURE }],
      dryRun: () => true,
      suggestMerges: async () => {
        calls++;
        return { suggestions: [], rejected: [] };
      },
    });

    const report = await runMaintenance(deps, "manual");

    expect(calls).toBe(0);
    const entry = report.files[0];
    expect(entry?.status).toBe("skipped");
    expect(entry?.l2).toBe("skipped-report");
  });

  it("事实不足 2 条时不调用 suggestMerges", async () => {
    const home = tempHome();
    const file = path.join(home, "AGENTS.md");
    const single = ["# 记忆", "", "## iFlow Added Memories", "", "- 回答使用中文", ""].join("\n");
    let calls = 0;
    const { deps } = createDeps({
      home,
      files: [{ path: file, scope: "global", content: single }],
      suggestMerges: async () => {
        calls++;
        return { suggestions: [], rejected: [] };
      },
    });

    const report = await runMaintenance(deps, "manual");

    expect(calls).toBe(0);
    expect(report.files[0]?.l2).toBeUndefined();
  });

  it("merge 与 L1 archive 抢同一行时 merge 被丢弃、archive 照常生效", async () => {
    const home = tempHome();
    const file = path.join(home, "AGENTS.md");
    // 三条事实中 "pnpm" 归一化后最短，rankArchiveCandidates 会先归档它。
    const fixture = [
      "# 记忆",
      "",
      "## iFlow Added Memories",
      "",
      "- pnpm",
      "- 项目使用 pnpm 管理依赖",
      "- 回答使用中文",
      "",
    ].join("\n");
    // 预算 = 恰好归档掉 "- pnpm" 后托管区块的 token 数：planCuration 只会归档一条。
    const budget = estimateMarkdownTokens(
      ["## iFlow Added Memories", "", "- 项目使用 pnpm 管理依赖", "- 回答使用中文"].join("\n"),
    );
    const { deps, store } = createDeps({
      home,
      files: [{ path: file, scope: "global", content: fixture }],
      budgets: { global: budget },
      suggestMerges: async () => ({
        suggestions: [
          {
            // absorb 指向 L1 archive 会移除的 "- pnpm" 行。
            keep: "项目使用 pnpm 管理依赖",
            absorb: ["pnpm"],
            merged: "依赖统一用 pnpm 管理",
            reason: "同一约定",
          },
        ],
        rejected: [],
      }),
    });

    const report = await runMaintenance(deps, "manual");

    const entry = report.files[0];
    // archive 生效、merge 被丢弃。
    expect(entry?.status).toBe("applied");
    expect(entry?.archived).toBe(1);
    expect(entry?.merged).toBe(0);
    expect(entry?.l2).toBe("ran");
    expect(entry?.rejectedMerges?.some((item) => item.reason.includes("冲突"))).toBe(true);

    const stored = store.get(file) ?? "";
    // L1 的保留项还在，merge 的合并文本没有写进去。
    expect(stored).toContain("- 项目使用 pnpm 管理依赖");
    expect(stored).not.toContain("依赖统一用 pnpm 管理");
    // archive 真的把 "pnpm" 移到了归档区。
    expect(stored).toContain("## Archived Memories");
    expect(stored).toContain("- pnpm");
  });

  it("两条 L2 merge 涉及同一行时只保留首条、另一条进 rejected", async () => {
    const home = tempHome();
    const file = path.join(home, "AGENTS.md");
    const fixture = [
      "# 记忆",
      "",
      "## iFlow Added Memories",
      "",
      "- 使用 pnpm 管理依赖",
      "- 依赖安装统一用 pnpm",
      "- 回答使用中文",
      "",
    ].join("\n");
    const { deps, store } = createDeps({
      home,
      files: [{ path: file, scope: "global", content: fixture }],
      suggestMerges: async () => ({
        suggestions: [
          {
            keep: "使用 pnpm 管理依赖",
            absorb: ["依赖安装统一用 pnpm"],
            merged: "依赖统一用 pnpm 管理",
            reason: "同一约定",
          },
          {
            // 同样 absorb "依赖安装统一用 pnpm"（同一行），与上一条抢行。
            keep: "回答使用中文",
            absorb: ["依赖安装统一用 pnpm"],
            merged: "中文回答，依赖用 pnpm",
            reason: "跨行合并",
          },
        ],
        rejected: [],
      }),
    });

    const report = await runMaintenance(deps, "manual");

    const entry = report.files[0];
    expect(entry?.status).toBe("applied");
    // 只有首条 merge 生效。
    expect(entry?.merged).toBe(1);
    expect(entry?.l2).toBe("ran");
    expect(entry?.rejectedMerges).toHaveLength(1);
    expect(entry?.rejectedMerges?.[0]?.reason).toContain("冲突");

    const stored = store.get(file) ?? "";
    expect(stored).toContain("- 依赖统一用 pnpm 管理");
    expect(stored).not.toContain("- 依赖安装统一用 pnpm");
    expect(stored).not.toContain("中文回答，依赖用 pnpm");
  });
});
