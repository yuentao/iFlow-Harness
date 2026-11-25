/**
 * 检查点 / 转录落盘一致性回归。
 *
 * - M2: 索引写失败必须跳过 gc；成功路径先落新索引再 gc；两者与所有索引写
 *   共用同一串行链；fire-and-forget 调用不得留下 unhandled rejection。
 * - M4: 同一目标的并发写必须用 pid+seq 唯一临时名，失败路径清理临时文件。
 *
 * 用轻量的原型 spy 替代真实 git / VSCode；只验证服务层的顺序与落盘契约。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CheckpointService,
  type CheckpointServiceDeps,
} from "../src/panel/checkpoint-service.js";
import { CheckpointManager } from "../src/panel/checkpoints.js";
import {
  SessionPersistenceService,
  type SessionPersistenceDeps,
} from "../src/panel/session-persistence.js";
import { parseCheckpointIndex } from "../shared/checkpoints.js";
import { initialSessionState, type CheckpointUi, type SessionState } from "../shared/messages.js";

function cp(userBlockId: string, turnIndex: number, sha: string | null = `sha-${turnIndex}`): CheckpointUi {
  return {
    userBlockId,
    turnIndex,
    sha,
    createdAt: 1_000 + turnIndex,
    partial: sha === null,
    label: `turn ${turnIndex}`,
  };
}

describe("checkpoint / transcript 落盘一致性", () => {
  let storageDir: string;
  let state: SessionState;
  let warns: string[];

  beforeEach(async () => {
    storageDir = await mkdtemp(path.join(os.tmpdir(), "iflow-cp-consistency-"));
    state = initialSessionState();
    state.sessionId = "s1";
    state.activeSessionId = "s1";
    warns = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function service(settings: Record<string, unknown> = {}): CheckpointService {
    const deps: CheckpointServiceDeps = {
      log: { info: () => {}, warn: (message) => warns.push(message) },
      getState: () => state,
      setCheckpoints: (next) => {
        state.checkpoints = next;
      },
      sendToast: () => {},
      appendNotice: () => {},
      isDisposed: () => false,
      isHistorySyncBusy: () => false,
      getSessionCwd: () => storageDir,
      getWorkspaceRoot: () => storageDir,
      getExtensionPath: () => storageDir,
      getStorageDir: () => storageDir,
      deleteUserMessage: async () => {},
      readUserSetting: <T>(key: string, fallback: T): T =>
        (key in settings ? settings[key] : fallback) as T,
    };
    return new CheckpointService(deps);
  }

  function indexPath(): string {
    return path.join(storageDir, "checkpoints", "s1", "index.json");
  }

  function persistence(): SessionPersistenceService {
    const deps: SessionPersistenceDeps = {
      log: { info: () => {}, warn: () => {} },
      getStorageDir: () => storageDir,
      getSessionCwd: () => storageDir,
      getWorkspaceState: () => ({ get: () => [], update: async () => {} }) as unknown as import("vscode").Memento,
      defaultSessionLabel: "（无标题会话）",
      sessionsKey: "iflow.recentSessions",
      activeSessionKey: "iflow.activeSessionId",
      maxRecentSessions: 20,
    };
    return new SessionPersistenceService(deps);
  }

  it("索引写失败时跳过 gc，并清理唯一临时文件", async () => {
    const events: string[] = [];
    vi.spyOn(CheckpointManager.prototype, "rewriteKeptShas").mockImplementation(async () => {
      events.push("rewrite");
      return [{ oldSha: "sha-1", newSha: "new-1" }];
    });
    const gc = vi.spyOn(CheckpointManager.prototype, "gcSession").mockImplementation(async () => {
      events.push("gc");
    });

    state.checkpoints = [cp("u0", 0, "sha-0"), cp("u1", 1, "sha-1")];
    const svc = service({ checkpointMaxTurns: 1, checkpointMaxSizeMB: 0 });
    // 目标路径被目录占用 → rename 必定失败；旧实现会在 gc 之后才 void 写索引。
    await mkdir(indexPath(), { recursive: true });

    await svc.enforceCheckpointRetention("s1");

    expect(events).toEqual(["rewrite"]);
    expect(gc).not.toHaveBeenCalled(); // 索引写失败 → 不 gc，旧 sha 仍可回滚
    expect(warns.some((w) => w.includes("retention failed"))).toBe(true);
    const leftovers = (await readdir(path.dirname(indexPath()))).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("成功路径先落新索引，再 gc", async () => {
    const events: string[] = [];
    vi.spyOn(CheckpointManager.prototype, "rewriteKeptShas").mockImplementation(async () => {
      events.push("rewrite");
      return [{ oldSha: "sha-1", newSha: "new-1" }];
    });
    vi.spyOn(CheckpointManager.prototype, "gcSession").mockImplementation(async () => {
      // gc 发生时，磁盘索引必须已经是重写后的 sha。
      const raw = await readFile(indexPath(), "utf8");
      expect(parseCheckpointIndex(raw)?.map((c) => c.sha)).toEqual(["new-1"]);
      events.push("gc");
    });

    state.checkpoints = [cp("u0", 0, "sha-0"), cp("u1", 1, "sha-1")];
    const svc = service({ checkpointMaxTurns: 1, checkpointMaxSizeMB: 0 });
    await svc.enforceCheckpointRetention("s1");

    expect(events).toEqual(["rewrite", "gc"]);
  });

  it("gc 与索引写共用同一串行链：并发 persist 排在 retention 之后", async () => {
    let releaseRewrite!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRewrite = resolve;
    });
    const events: string[] = [];
    vi.spyOn(CheckpointManager.prototype, "rewriteKeptShas").mockImplementation(async () => {
      events.push("rewrite-start");
      await gate;
      events.push("rewrite-end");
      return [{ oldSha: "sha-1", newSha: "new-1" }];
    });
    vi.spyOn(CheckpointManager.prototype, "gcSession").mockImplementation(async () => {
      events.push("gc");
    });

    state.checkpoints = [cp("u0", 0, "sha-0"), cp("u1", 1, "sha-1")];
    const svc = service({ checkpointMaxTurns: 1, checkpointMaxSizeMB: 0 });
    const retention = svc.enforceCheckpointRetention("s1");
    await vi.waitFor(() => expect(events).toContain("rewrite-start"));
    // 在 retention 卡住时排队一次普通索引写：若不在同一链上，它会先落盘，
    // retention 的索引写随后覆盖它；串行链下它必须排在 gc 之后。
    const sentinel = cp("sentinel", 9, "sentinel-sha");
    const persist = svc.persistCheckpointIndex("s1", [sentinel]);
    releaseRewrite();
    await Promise.all([retention, persist]);

    expect(events).toEqual(["rewrite-start", "rewrite-end", "gc"]);
    expect(parseCheckpointIndex(await readFile(indexPath(), "utf8"))?.map((c) => c.userBlockId)).toEqual([
      "sentinel",
    ]);
  });

  it("fire-and-forget 的索引写失败不产生 unhandled rejection", async () => {
    await mkdir(indexPath(), { recursive: true }); // rename 目标被占用 → 写失败
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const svc = service({ checkpointMaxTurns: 0, checkpointMaxSizeMB: 0 });
      state.checkpoints = [cp("u0", 0, "sha-0")];
      svc.recordCheckpoint("s1", cp("u0", 0, "sha-0"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
      expect(warns.some((w) => w.includes("index persist failed"))).toBe(true);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("并发 transcript 写使用唯一临时名：占用固定 .tmp 路径也不影响写入", async () => {
    const dir = path.join(storageDir, "transcripts");
    const target = path.join(dir, "shared.json");
    await mkdir(`${target}.tmp`, { recursive: true }); // 旧实现的固定临时名被占
    const a = persistence();
    const b = persistence();
    const payloadA = a.serializeTranscript("A", []);
    const payloadB = b.serializeTranscript("B", []);

    await Promise.all([
      a.writeTranscriptFile("shared", payloadA),
      b.writeTranscriptFile("shared", payloadB),
    ]);

    const raw = await readFile(target, "utf8");
    expect([payloadA, payloadB]).toContain(raw);
    expect(existsSync(target)).toBe(true);
  });

  it("索引写失败时唯一临时文件被清理，且返回的 promise 拒绝可被观察", async () => {
    await mkdir(indexPath(), { recursive: true });
    const svc = service({ checkpointMaxTurns: 0, checkpointMaxSizeMB: 0 });

    await expect(svc.persistCheckpointIndex("s1", [cp("u0", 0, "sha-0")])).rejects.toThrow();
    const leftovers = (await readdir(path.dirname(indexPath()))).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
