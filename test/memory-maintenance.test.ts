import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MemoryScope } from "../shared/messages.js";
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
