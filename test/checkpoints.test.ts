/**
 * M3 P0-1 turn-level checkpoints.
 *
 * Three layers, tested bottom-up:
 * 1. `shared/checkpoints.ts` — pure reducers (upsert / prune / re-anchor /
 *    label / index round-trip). No git, no vscode.
 * 2. `src/panel/checkpoints.ts` — CheckpointManager against a REAL git binary
 *    in throwaway temp dirs (init → capture → mutate → restore). Skips the
 *    git-dependent cases when no git is on PATH.
 * 3. `SessionStore` — the checkpoint projection is non-blocks metadata: it
 *    must ride the blockPatch tail channel without disturbing anchoring.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkpointLabelFromText,
  parseCheckpointIndex,
  pruneCheckpointsForBlocks,
  reanchorCheckpoints,
  serializeCheckpointIndex,
  upsertCheckpoint,
} from "../shared/checkpoints.js";
import type { CheckpointUi } from "../shared/messages.js";
import { CheckpointManager } from "../src/panel/checkpoints.js";
import { SessionStore } from "../src/panel/store.js";
import { initialSessionState, type HostToWebview } from "../shared/messages.js";

function cp(userBlockId: string, turnIndex: number, over: Partial<CheckpointUi> = {}): CheckpointUi {
  return {
    userBlockId,
    turnIndex,
    sha: `sha-${turnIndex}`,
    createdAt: 1_000 + turnIndex,
    partial: false,
    label: `turn ${turnIndex}`,
    ...over,
  };
}

describe("shared checkpoint reducers", () => {
  it("labels from the first line, capped at 30 chars with an ellipsis", () => {
    expect(checkpointLabelFromText("第一行\n第二行")).toBe("第一行");
    const long = "字".repeat(40);
    const label = checkpointLabelFromText(long);
    expect(label).toHaveLength(31); // 30 chars + the ellipsis
    expect(label.endsWith("…")).toBe(true);
  });

  it("strips attachment note lines before labelling", () => {
    expect(checkpointLabelFromText("改一下登录页\n（文件：a.ts → /tmp/a.ts）")).toBe("改一下登录页");
  });

  it("upsert is idempotent per anchor and immutable", () => {
    const base = [cp("u1", 0)];
    const again = upsertCheckpoint(base, cp("u1", 0, { sha: "new" }));
    expect(again).toHaveLength(1);
    expect(again[0]!.sha).toBe("new");
    expect(base[0]!.sha).toBe("sha-0"); // original untouched
    const added = upsertCheckpoint(base, cp("u2", 1));
    expect(added.map((c) => c.userBlockId)).toEqual(["u1", "u2"]);
  });

  it("prune drops checkpoints whose user block is gone", () => {
    const list = [cp("u1", 0), cp("u2", 1), cp("u3", 2)];
    const blocks = [{ kind: "user", id: "u1" }, { kind: "text" }, { kind: "user", id: "u3" }];
    expect(pruneCheckpointsForBlocks(list, blocks).map((c) => c.userBlockId)).toEqual(["u1", "u3"]);
  });

  it("prune returns a copy (never the same reference) even when nothing drops", () => {
    const list = [cp("u1", 0)];
    const blocks = [{ kind: "user", id: "u1" }];
    const out = pruneCheckpointsForBlocks(list, blocks);
    expect(out).not.toBe(list);
    expect(out).toEqual(list);
  });

  it("re-anchor maps old ids to new, dropping dead anchors", () => {
    const list = [cp("old-1", 0), cp("old-2", 1)];
    const remap = new Map([["old-1", "new-1"]]); // old-2's block did not survive
    const out = reanchorCheckpoints(list, remap);
    expect(out).toHaveLength(1);
    expect(out[0]!.userBlockId).toBe("new-1");
    expect(out[0]!.turnIndex).toBe(0); // metadata preserved
  });

  it("index round-trips through serialize/parse; corrupt input → null", () => {
    const list = [cp("u1", 0), cp("u2", 1, { sha: null, partial: true })];
    const parsed = parseCheckpointIndex(serializeCheckpointIndex(list));
    expect(parsed).toEqual(list);
    expect(parseCheckpointIndex("{ not json")).toBeNull();
    expect(parseCheckpointIndex('{"checkpoints":"nope"}')).toBeNull();
  });

  it("parse drops malformed entries but keeps valid ones", () => {
    const raw = JSON.stringify({
      version: 1,
      checkpoints: [cp("u1", 0), { userBlockId: "bad" }],
    });
    expect(parseCheckpointIndex(raw)?.map((c) => c.userBlockId)).toEqual(["u1"]);
  });
});

// ---------------------------------------------------------------------------
// CheckpointManager — real git, throwaway temp dirs.
// ---------------------------------------------------------------------------

let gitAvailable = false;
try {
  execFileSync("git", ["--version"], { stdio: "ignore", timeout: 5_000 });
  gitAvailable = true;
} catch {
  gitAvailable = false;
}

const maybe = gitAvailable ? it : it.skip;

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function silentLog() {
  return { info: () => {}, warn: () => {} };
}

describe("CheckpointManager (real shadow git)", () => {
  maybe("captures a turn, then restores tracked files to the snapshot", async () => {
    const work = tempDir("iflow-cp-work-");
    const store = tempDir("iflow-cp-store-");
    try {
      writeFileSync(path.join(work, "a.txt"), "v1");
      const mgr = new CheckpointManager({ log: silentLog() });
      expect(await mgr.ensureReady("s1", store, work)).toBeNull();
      const sha = await mgr.captureTurn("s1", "first turn");
      expect(sha).toMatch(/^[0-9a-f]{40}$/);

      // Agent edits + a brand-new untracked file.
      writeFileSync(path.join(work, "a.txt"), "v2");
      writeFileSync(path.join(work, "new.txt"), "created after snapshot");

      await mgr.restoreFiles("s1", sha!);
      expect(readFileSync(path.join(work, "a.txt"), "utf8")).toBe("v1"); // tracked restored
      expect(existsSync(path.join(work, "new.txt"))).toBe(true); // untracked kept
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(store, { recursive: true, force: true });
    }
  });

  maybe("chains commits so each turn restores to its own snapshot", async () => {
    const work = tempDir("iflow-cp-work-");
    const store = tempDir("iflow-cp-store-");
    try {
      writeFileSync(path.join(work, "a.txt"), "v1");
      const mgr = new CheckpointManager({ log: silentLog() });
      await mgr.ensureReady("s1", store, work);
      const sha1 = await mgr.captureTurn("s1", "t1");
      writeFileSync(path.join(work, "a.txt"), "v2");
      const sha2 = await mgr.captureTurn("s1", "t2");
      expect(sha2).not.toBe(sha1);
      writeFileSync(path.join(work, "a.txt"), "v3");

      await mgr.restoreFiles("s1", sha1!);
      expect(readFileSync(path.join(work, "a.txt"), "utf8")).toBe("v1");
      await mgr.restoreFiles("s1", sha2!);
      expect(readFileSync(path.join(work, "a.txt"), "utf8")).toBe("v2");
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(store, { recursive: true, force: true });
    }
  });

  maybe("respects .gitignore (ignored files are not snapshotted)", async () => {
    const work = tempDir("iflow-cp-work-");
    const store = tempDir("iflow-cp-store-");
    try {
      writeFileSync(path.join(work, ".gitignore"), "secret.txt\n");
      writeFileSync(path.join(work, "keep.txt"), "keep");
      writeFileSync(path.join(work, "secret.txt"), "before");
      const mgr = new CheckpointManager({ log: silentLog() });
      await mgr.ensureReady("s1", store, work);
      const sha = await mgr.captureTurn("s1", "t1");
      writeFileSync(path.join(work, "secret.txt"), "after");
      await mgr.restoreFiles("s1", sha!);
      // secret.txt was never tracked → restore leaves the current content.
      expect(readFileSync(path.join(work, "secret.txt"), "utf8")).toBe("after");
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(store, { recursive: true, force: true });
    }
  });

  maybe("restoreFiles rejects a sha the repo does not have", async () => {
    const work = tempDir("iflow-cp-work-");
    const store = tempDir("iflow-cp-store-");
    try {
      writeFileSync(path.join(work, "a.txt"), "v1");
      const mgr = new CheckpointManager({ log: silentLog() });
      await mgr.ensureReady("s1", store, work);
      await mgr.captureTurn("s1", "t1");
      await expect(mgr.restoreFiles("s1", "0".repeat(40))).rejects.toThrow();
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(store, { recursive: true, force: true });
    }
  });

  maybe("over the file cap the session is disabled with a reason", async () => {
    const work = tempDir("iflow-cp-work-");
    const store = tempDir("iflow-cp-store-");
    try {
      writeFileSync(path.join(work, "a.txt"), "v1");
      const mgr = new CheckpointManager({ log: silentLog(), maxFiles: 0 });
      const reason = await mgr.ensureReady("s1", store, work);
      expect(reason).toMatch(/cap 0/);
      expect(mgr.isEnabled("s1")).toBe(false);
      expect(await mgr.captureTurn("s1", "t1")).toBeNull();
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(store, { recursive: true, force: true });
    }
  });

  maybe("reopen restores the commit chain across manager restarts", async () => {
    const work = tempDir("iflow-cp-work-");
    const store = tempDir("iflow-cp-store-");
    try {
      writeFileSync(path.join(work, "a.txt"), "v1");
      const first = new CheckpointManager({ log: silentLog() });
      await first.ensureReady("s1", store, work);
      const sha = await first.captureTurn("s1", "t1");

      // New manager (host restart): reopen with the persisted last sha.
      const second = new CheckpointManager({ log: silentLog() });
      expect(await second.reopen("s1", store, work, sha)).toBeNull();
      writeFileSync(path.join(work, "a.txt"), "v2");
      await second.restoreFiles("s1", sha!);
      expect(readFileSync(path.join(work, "a.txt"), "utf8")).toBe("v1");
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(store, { recursive: true, force: true });
    }
  });

  maybe("removeSession deletes the shadow repo directory", async () => {
    const work = tempDir("iflow-cp-work-");
    const store = tempDir("iflow-cp-store-");
    try {
      writeFileSync(path.join(work, "a.txt"), "v1");
      const mgr = new CheckpointManager({ log: silentLog() });
      await mgr.ensureReady("s1", store, work);
      await mgr.captureTurn("s1", "t1");
      const sessionDir = path.join(store, CheckpointManager.safeSessionId("s1"));
      expect(existsSync(sessionDir)).toBe(true);
      await mgr.removeSession("s1", store);
      expect(existsSync(sessionDir)).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(store, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// SessionStore — checkpoint projection rides the tail channel.
// ---------------------------------------------------------------------------

describe("SessionStore checkpoint projection (tail channel)", () => {
  function makeStore(): { store: SessionStore; messages: HostToWebview[] } {
    const messages: HostToWebview[] = [];
    const store = new SessionStore({ post: (m) => messages.push(m), flushIntervalMs: 5 });
    return { store, messages };
  }

  it("setCheckpoints pushes the projection on snapshot and blockPatch tails", async () => {
    const { store, messages } = makeStore();
    store.markConnected(); // full anchor
    store.userPrompt("第一问");
    store.setCheckpoints([cp("u1", 0)]);
    store.pushSnapshot();
    const last = messages[messages.length - 1]!;
    if (last.type !== "blockPatch") throw new Error(`expected blockPatch, got ${last.type}`);
    expect(last.tail.checkpoints).toEqual([cp("u1", 0)]);
  });

  it("initialSessionState carries an empty checkpoint list", () => {
    expect(initialSessionState().checkpoints).toEqual([]);
  });
});
