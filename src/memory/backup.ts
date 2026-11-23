import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { readIfExists, writeAtomic } from "./files.js";

/**
 * Backups for memory files, so every fact-level edit can be rolled back.
 *
 * Layout: `<memoryHome>/memory-backups/<stamp>-<basename>`, where `stamp` is
 * the ISO timestamp with the colons stripped (Windows forbids `:` in names).
 * `<memoryHome>` is `~/.iflow`, so backups sit next to `AGENTS.md`.
 *
 * Every operation is best-effort: a backup that cannot be written must never
 * take down the edit itself (the caller reports a structured failure), and no
 * function here ever deletes or rewrites a user memory file — the only things
 * removed are our own backup copies during pruning.
 */
export const BACKUP_DIR = "memory-backups";

export interface BackupEntry {
  id: string;
  path: string;
  /** ISO timestamp parsed back from the file name. */
  at: string;
  size: number;
}

export interface CreateBackupResult {
  /** Absolute path of the written backup, or null when the write failed. */
  backupPath: string | null;
  /** File name (used as a stable handle for restore/prune). */
  id: string | null;
  error?: string;
}

export function backupDir(home: string): string {
  return path.join(home, BACKUP_DIR);
}

/** `2026-11-23T10:20:30.123Z` → `2026-11-23T10-20-30.123Z` (no colons). */
function stampFor(now: Date): string {
  return now.toISOString().replace(/:/g, "-");
}

function basenameOf(filePath: string): string {
  return path.basename(filePath);
}

/**
 * Copy `content` into the backup directory. Uses the memory writer's atomic
 * temp+rename so a partially written backup is never visible.
 *
 * Failure is reported, not thrown: a memory edit whose backup failed still
 * has to be able to proceed (and the caller can surface the warning).
 */
export async function createBackup(
  home: string,
  filePath: string,
  content: string,
  now: Date = new Date(),
): Promise<CreateBackupResult> {
  const base = basenameOf(filePath);
  const id = `${stampFor(now)}-${base}`;
  const target = path.join(backupDir(home), id);
  try {
    await writeAtomic(target, content);
    return { backupPath: target, id };
  } catch (error) {
    return {
      backupPath: null,
      id: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Backups for one memory file (by basename), newest first. A missing backup
 * directory yields an empty list — never an error.
 */
export async function listBackups(home: string, basename: string): Promise<BackupEntry[]> {
  const dir = backupDir(home);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const suffix = `-${basename}`;
  const entries: BackupEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(suffix)) continue;
    const full = path.join(dir, name);
    const info = await stat(full).catch(() => null);
    if (!info || !info.isFile()) continue;
    // Recover the timestamp: strip the trailing `-<basename>` and put the
    // colons back so the value is a parseable ISO string again.
    const stamp = name.slice(0, name.length - suffix.length);
    const at = stamp.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
    entries.push({ id: name, path: full, at, size: info.size });
  }
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
  return entries;
}

/**
 * Keep only the newest `keep` backups for every basename and delete the rest.
 * Returns how many files were removed. `keep <= 0` prunes everything for the
 * given basenames (callers should pass a sane floor).
 */
export async function pruneBackups(home: string, keep: number): Promise<number> {
  const dir = backupDir(home);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  // Group by basename: the suffix after the first `-` is unreliable (basenames
  // may contain dashes), so derive it from the known stamp shape instead.
  const byBase = new Map<string, { name: string; at: string }[]>();
  for (const name of names) {
    const match = /^(.+?T[\d.-]+Z)-(.+)$/.exec(name);
    if (!match) continue;
    const at = match[1]!.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
    const base = match[2]!;
    const group = byBase.get(base) ?? [];
    group.push({ name, at });
    byBase.set(base, group);
  }
  const floor = Math.max(0, Math.floor(keep));
  let removed = 0;
  for (const group of byBase.values()) {
    group.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.name < b.name ? 1 : -1));
    for (const entry of group.slice(floor)) {
      try {
        await rm(path.join(dir, entry.name), { force: true });
        removed++;
      } catch {
        /* best-effort: a locked file stays until the next prune */
      }
    }
  }
  return removed;
}

/** Read a backup's content; null when it is gone or unreadable. */
export async function readBackup(filePath: string): Promise<string | null> {
  try {
    return await readIfExists(filePath);
  } catch {
    return null;
  }
}
