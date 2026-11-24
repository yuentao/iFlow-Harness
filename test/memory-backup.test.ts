import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  backupDir,
  createBackup,
  listBackups,
  pruneBackups,
  readBackup,
} from "../src/memory/backup.js";

const dirs: string[] = [];

function tempHome(prefix = "iflow-mem-backup-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("memory backup: createBackup", () => {
  it("writes the content to memory-backups/<stamp>-<basename>", async () => {
    const home = tempHome();
    const at = new Date("2026-11-23T10:20:30.123Z");
    const result = await createBackup(home, path.join("some", "AGENTS.md"), "# hi\n", at);
    expect(result.error).toBeUndefined();
    expect(result.id).toBe("2026-11-23T10-20-30.123Z-AGENTS.md");
    expect(result.backupPath).toBe(path.join(backupDir(home), result.id!));
    expect(readFileSync(result.backupPath!, "utf8")).toBe("# hi\n");
  });

  it("creates the backup directory on demand", async () => {
    const home = tempHome();
    const result = await createBackup(home, path.join("AGENTS.md"), "x", new Date());
    expect(existsSync(backupDir(home))).toBe(true);
    expect(result.backupPath).not.toBeNull();
  });
});

describe("memory backup: listBackups", () => {
  it("returns one file's backups newest first", async () => {
    const home = tempHome();
    await createBackup(home, "AGENTS.md", "old", new Date("2026-11-01T00:00:00.000Z"));
    await createBackup(home, "AGENTS.md", "new", new Date("2026-11-02T00:00:00.000Z"));
    await createBackup(home, "IFLOW.md", "other", new Date("2026-11-03T00:00:00.000Z"));
    const entries = await listBackups(home, "AGENTS.md");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.at).toBe("2026-11-02T00:00:00.000Z");
    expect(entries[1]?.at).toBe("2026-11-01T00:00:00.000Z");
    expect(entries[0]?.size).toBe(3);
    expect(readFileSync(entries[0]!.path, "utf8")).toBe("new");
  });

  it("returns an empty list when no backup directory exists", async () => {
    const home = tempHome();
    expect(await listBackups(home, "AGENTS.md")).toEqual([]);
  });
});

describe("memory backup: pruneBackups", () => {
  it("keeps the newest N backups per file and deletes the rest", async () => {
    const home = tempHome();
    for (let day = 1; day <= 4; day++) {
      const at = new Date(`2026-11-0${day}T00:00:00.000Z`);
      await createBackup(home, "AGENTS.md", `v${day}`, at);
    }
    await createBackup(home, "IFLOW.md", "only", new Date("2026-11-01T00:00:00.000Z"));

    const removed = await pruneBackups(home, 2);
    expect(removed).toBe(2);

    const agents = await listBackups(home, "AGENTS.md");
    expect(agents.map((entry) => readFileSync(entry.path, "utf8"))).toEqual(["v4", "v3"]);
    // A file with fewer than `keep` backups is untouched.
    expect(await listBackups(home, "IFLOW.md")).toHaveLength(1);
  });

  it("is a no-op when there is no backup directory", async () => {
    const home = tempHome();
    expect(await pruneBackups(home, 3)).toBe(0);
  });
});

describe("memory backup: readBackup", () => {
  it("round-trips the content and returns null for a missing file", async () => {
    const home = tempHome();
    const result = await createBackup(home, "AGENTS.md", "- a fact\n", new Date());
    expect(await readBackup(result.backupPath!)).toBe("- a fact\n");
    expect(await readBackup(path.join(home, "nope", "missing.md"))).toBeNull();
  });

  it("does not fail when the target memory file does not exist", async () => {
    // createBackup only copies a string into the backup dir; it never needs the
    // source file to exist.
    const home = tempHome();
    const ghost = path.join(home, "does-not-exist", "AGENTS.md");
    expect(existsSync(ghost)).toBe(false);
    const result = await createBackup(home, ghost, "snapshot", new Date());
    expect(result.error).toBeUndefined();
    expect(await readBackup(result.backupPath!)).toBe("snapshot");
  });
});
