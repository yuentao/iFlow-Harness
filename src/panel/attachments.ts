/**
 * Staged drop/paste attachment storage. Files dropped or pasted into the
 * composer have no real filesystem path (the webview only holds File
 * objects), so the host persists their bytes under a per-session directory
 * inside the OS temp dir and hands the absolute paths to the agent.
 *
 * Review 2026-09-19 A7: nothing ever cleaned these directories — long-term
 * use accumulated orphaned staging dirs. This module owns the layout (so the
 * writer and the sweeper can never disagree on the path scheme) plus the
 * age-based sweep and the per-session delete on session removal.
 *
 * Kept free of `vscode` imports for unit tests; I/O uses plain node:fs —
 * the staging root lives outside every workspace, so there are no file
 * watchers to preserve (cf. the workspace-write convention in panel.ts).
 */

import os from "node:os";
import path from "node:path";
import { readdir, rm, stat } from "node:fs/promises";

/** Root of all staged-attachment session dirs (under the OS temp dir). */
export const ATTACHMENT_TMP_ROOT = path.join(os.tmpdir(), "iflow-harness-attachments");
/** Staging dirs untouched for this long are swept. 7 days matches the
 * "temp files are ephemeral" contract: an older session's staged paths were
 * already dead links under every major OS's own temp reaper. */
export const ATTACHMENT_TMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Per-session staging dir. The id is sanitized exactly as stageDroppedFiles
 * used to inline it (word chars / dot / dash only), so a wire-supplied
 * session id can never escape the root.
 */
export function attachmentSessionDir(sessionId: string): string {
  return path.join(ATTACHMENT_TMP_ROOT, sessionId.replace(/[^\w.-]/g, "_"));
}

/**
 * Delete staging entries whose mtime is older than `maxAgeMs`. mtime is the
 * idle signal: it refreshes whenever a file is staged into (or removed
 * from) the dir. Best-effort — never throws; a missing root or a per-entry
 * failure just narrows the sweep. Returns the number of entries removed.
 */
export async function sweepStaleAttachmentDirs(options?: {
  now?: number;
  maxAgeMs?: number;
  /** Test hook: sweep a directory other than the real temp root. */
  root?: string;
  log?: (message: string) => void;
}): Promise<number> {
  const root = options?.root ?? ATTACHMENT_TMP_ROOT;
  const maxAgeMs = options?.maxAgeMs ?? ATTACHMENT_TMP_MAX_AGE_MS;
  const now = options?.now ?? Date.now();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0; // staging root not created yet (nothing was ever dropped)
  }
  let removed = 0;
  for (const name of entries) {
    const dir = path.join(root, name);
    try {
      const info = await stat(dir);
      if (now - info.mtimeMs < maxAgeMs) continue;
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      // Entry vanished mid-sweep or is unreadable — skip it, keep sweeping.
      options?.log?.(
        `skipping attachment entry ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (removed > 0) options?.log?.(`swept ${removed} stale attachment dir(s) from ${root}`);
  return removed;
}
