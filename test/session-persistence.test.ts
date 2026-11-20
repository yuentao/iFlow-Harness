/**
 * SessionPersistenceService (阶段 3 panel split) — standalone unit tests.
 *
 * Proves the extracted module keeps the exact persistence semantics with only
 * its narrow injected deps (no ChatPanel, no real VSCode): path sanitization,
 * temp+rename atomic writes, read/migration behavior, chain introspection and
 * the session-index read/write. The panel-side thin delegates are covered by
 * the existing panel-* integration tests (panel-dispose, panel-session-tools,
 * panel-super-restore) — this file targets the service in isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SessionPersistenceService,
  type PersistedTranscript,
  type SessionPersistenceDeps,
} from "../src/panel/session-persistence.js";
import type { SessionSummaryUi } from "../shared/messages.js";

class FakeMemento {
  private readonly data = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.data.has(key) ? this.data.get(key) : defaultValue) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, value);
  }
  set(key: string, value: unknown): void {
    this.data.set(key, value);
  }
  has(key: string): boolean {
    return this.data.has(key);
  }
}

describe("SessionPersistenceService", () => {
  let storageDir: string;
  let memento: FakeMemento;
  let svc: SessionPersistenceService;
  let sessionCwd: string | null;

  beforeEach(async () => {
    storageDir = await mkdtemp(path.join(os.tmpdir(), "iflow-persistence-svc-"));
    memento = new FakeMemento();
    sessionCwd = null;
    const deps: SessionPersistenceDeps = {
      log: { info: vi.fn(), warn: vi.fn() },
      getStorageDir: () => storageDir,
      getSessionCwd: () => sessionCwd,
      getWorkspaceState: () => memento as unknown as import("vscode").Memento,
      defaultSessionLabel: "（无标题会话）",
      sessionsKey: "iflow.recentSessions",
      activeSessionKey: "iflow.activeSessionId",
      maxRecentSessions: 20,
    };
    svc = new SessionPersistenceService(deps);
  });

  afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("sanitizes hostile session ids before touching the filesystem", () => {
    expect(svc.ownTranscriptFileName("abc/../../evil")).toBe("abc-------evil.json");
    expect(svc.ownTranscriptFilePath("s1")).toBe(path.join(storageDir, "transcripts", "s1.json"));
    expect(svc.transcriptDir()).toBe(path.join(storageDir, "transcripts"));
  });

  it("round-trips a transcript via a temp+rename atomic write (no .tmp leftover)", async () => {
    const payload = svc.serializeTranscript("会话", []);
    await svc.writeTranscriptFile("s1", payload);
    expect(existsSync(svc.ownTranscriptFilePath("s1"))).toBe(true);
    expect(existsSync(`${svc.ownTranscriptFilePath("s1")}.tmp`)).toBe(false);
    const read = await svc.readTranscript("s1");
    expect(read?.label).toBe("会话");
    expect(read?.blocks).toEqual([]);
    expect(svc.hasPersistedTranscript("s1")).toBe(true);
  });

  it("readTranscript returns null for missing or corrupt files", async () => {
    expect(await svc.readTranscript("never")).toBeNull();
    await svc.writeTranscriptFile("bad", "{not json");
    expect(await svc.readTranscript("bad")).toBeNull();
    await svc.writeTranscriptFile("noblocks", JSON.stringify({ label: "x" }));
    expect(await svc.readTranscript("noblocks")).toBeNull();
  });

  it("loadPersistedTranscript reads the extension store and hides the untitled label", async () => {
    await svc.writeTranscriptFile("s2", svc.serializeTranscript("真实标题", []));
    const named = await svc.loadPersistedTranscript("s2");
    expect(named.firstUserText).toBe("真实标题");
    await svc.writeTranscriptFile("s3", svc.serializeTranscript("（无标题会话）", []));
    const untitled = await svc.loadPersistedTranscript("s3");
    expect(untitled.firstUserText).toBeNull();
  });

  it("clearTranscript removes the file", async () => {
    await svc.writeTranscriptFile("s4", svc.serializeTranscript("x", []));
    await svc.clearTranscript("s4");
    expect(existsSync(svc.ownTranscriptFilePath("s4"))).toBe(false);
  });

  it("migrates the legacy workspaceState map into files and deletes the key", async () => {
    const legacy: Record<string, PersistedTranscript> = {
      old1: { label: "旧会话", blocks: [{ id: "b1", type: "user", text: "hi" }] as unknown as PersistedTranscript["blocks"] },
      empty: { label: "空", blocks: [] },
    };
    memento.set("iflow.transcripts", legacy);
    await svc.migrateLegacyTranscripts();
    // Empty-block entries are skipped; only old1 lands on disk.
    expect(existsSync(svc.ownTranscriptFilePath("old1"))).toBe(true);
    expect(existsSync(svc.ownTranscriptFilePath("empty"))).toBe(false);
    expect(memento.has("iflow.transcripts")).toBe(false);
  });

  it("exposes the write chain for lifecycle introspection", async () => {
    expect(svc.pendingWriteCount()).toBe(0);
    const p = svc.enqueueTranscriptWrite("s5", () => svc.serializeTranscript("x", []));
    expect(svc.pendingWriteCount()).toBe(1);
    await svc.awaitPersistChain();
    await p;
    expect(svc.pendingWriteCount()).toBe(0);
    expect((await svc.readTranscript("s5"))?.label).toBe("x");
  });

  it("persists a sorted, capped session index and active pointer", async () => {
    const sessions: SessionSummaryUi[] = [
      { id: "a", label: "A", updatedAt: 100 },
      { id: "b", label: "B", updatedAt: 300 },
      { id: "c", label: "C", updatedAt: 200 },
    ];
    await svc.persistSessions(sessions, "b");
    expect(svc.readPersistedSessions().map((s) => s.id)).toEqual(["b", "c", "a"]);
    expect(memento.get("iflow.activeSessionId")).toBe("b");
  });
});
