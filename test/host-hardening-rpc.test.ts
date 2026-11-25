import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonRpcPeer } from "../src/acp/jsonrpc.js";
import { SessionRestoreService } from "../src/panel/session-restore.js";
import type { SessionRestoreDeps } from "../src/panel/session-restore.js";
import { SessionStore } from "../src/panel/store.js";

// M6 needs the three orphan-cleanup rm() calls to fail deterministically on
// Windows without touching the real filesystem. Only the two fs seams used by
// pruneUnrestorableSessions are replaced; everything else stays real.
const { rmMock, readdirMock } = vi.hoisted(() => ({
  rmMock: vi.fn(),
  readdirMock: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: rmMock, readdir: readdirMock };
});

// Keep the super-agent archive seams empty so only the transcript orphan loop
// is exercised; the six exports below are exactly what session-restore imports.
vi.mock("../src/panel/super-store.js", () => ({
  listSuperSessionArchiveFiles: vi.fn(async () => []),
  listSuperTranscriptFiles: vi.fn(async () => []),
  readSuperSessionArchive: vi.fn(async () => ({ sessions: [] })),
  superSessionFileName: (id: string) => `${id}.json`,
  superSessionsDir: (dir: string) => dir,
  superTranscriptFileName: (id: string) => `${id}-transcript.json`,
}));

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function makeDeps(): SessionRestoreDeps {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const persistSessions = vi.fn(async () => {});
  return {
    log,
    migrateLegacyTranscripts: vi.fn(async () => {}),
    readPersistedSessions: vi.fn(() => []),
    getState: vi.fn(() => ({ activeSessionId: null })),
    hasPersistedTranscript: vi.fn(() => true),
    persistence: {
      ownTranscriptFileName: (id: string) => `${id}.json`,
      transcriptDir: () => "/virtual/transcripts",
    },
    listOwnTranscriptFileNames: vi.fn(async () => ["orphan.json", "orphan2.json"]),
    superStoreDir: () => "/virtual/super",
    setSessionCwd: vi.fn(),
    getExtensionPath: () => "/virtual/ext",
    getWorkspaceActiveSessionId: vi.fn(() => null),
    checkpointRoot: () => "/virtual/checkpoints",
    persistSessions,
  } as unknown as SessionRestoreDeps;
}

describe("M5 - inbound request reply chain", () => {
  afterEach(() => vi.restoreAllMocks());

  it("catches a synchronous reply-write failure instead of leaking an unhandled rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const peer = new JsonRpcPeer(() => {
      throw new Error("stdin destroyed");
    });
    peer.onRequest("ping", () => ({ ok: true }));
    peer.handleData(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);

    // Let Promise.resolve().then(handler).then(reply).catch(...) settle.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to reply to request ping"),
    );
  });

  it("still sends an error envelope when the handler throws (terminal catch is not a false positive)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lines: string[] = [];
    const peer = new JsonRpcPeer((line) => lines.push(line));
    peer.onRequest("boom", () => {
      throw new Error("handler failed");
    });
    peer.handleData(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "boom" })}\n`);

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32603, message: "handler failed" },
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("M6 - orphan session GC", () => {
  beforeEach(() => {
    rmMock.mockReset();
    readdirMock.mockReset();
    readdirMock.mockRejectedValue(errno("ENOENT"));
  });

  it("keeps cleaning the rest and still persists when one rm fails with EPERM", async () => {
    rmMock.mockImplementation(async (p: unknown) => {
      if (String(p).endsWith("orphan.json")) throw errno("EPERM");
    });
    const deps = makeDeps();

    await new SessionRestoreService(deps).pruneUnrestorableSessions();

    // The second orphan is still visited: the first failure did not abort GC.
    expect(rmMock).toHaveBeenCalledTimes(2);
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to prune transcript orphan.json"),
    );
    expect(deps.persistSessions).toHaveBeenCalledTimes(1);
  });

  it("stays silent for ENOENT and still persists", async () => {
    rmMock.mockRejectedValue(errno("ENOENT"));
    const deps = makeDeps();

    await new SessionRestoreService(deps).pruneUnrestorableSessions();

    expect(deps.log.warn).not.toHaveBeenCalled();
    expect(deps.persistSessions).toHaveBeenCalledTimes(1);
  });
});

describe("L1 - store teardown", () => {
  it("clears an armed flush timer so no snapshot fires after dispose", () => {
    vi.useFakeTimers();
    try {
      const post = vi.fn();
      const store = new SessionStore({ post, flushIntervalMs: 50 });
      // onSessionUpdate is the only public path that arms the coalescing
      // timer; hit the private seam directly to reproduce the exact scenario
      // without constructing a full ACP notification.
      (store as unknown as { scheduleFlush(): void }).scheduleFlush();
      // setSuperWaiting(false) is an idempotent early-return when already
      // false: it leaves the timer armed (the bug L1 describes).
      store.setSuperWaiting(false);
      expect(post).not.toHaveBeenCalled();

      store.dispose();
      vi.advanceTimersByTime(200);

      expect(post).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
