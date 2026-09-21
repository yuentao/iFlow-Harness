import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ATTACHMENT_TMP_MAX_AGE_MS,
  ATTACHMENT_TMP_ROOT,
  attachmentSessionDir,
  sweepStaleAttachmentDirs,
} from "../src/panel/attachments.js";

/**
 * Review 2026-09-19 A7: staged drop/paste attachments under the OS temp dir
 * had no cleanup. The sweep removes session dirs idle past the max age and
 * must never throw (missing root, vanishing entries) — it runs unattended at
 * every window activation.
 */

const tempDir = mkdtempSync(path.join(tmpdir(), "iflow-attachments-test-"));
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

let rootSeq = 0;
/** Fresh fake staging root per case (the sweep takes `root` as a test hook). */
function makeRoot(): string {
  const root = path.join(tempDir, `root-${++rootSeq}`);
  mkdirSync(root, { recursive: true });
  return root;
}

/** Populate a session dir, THEN backdate it (writing children bumps mtime). */
function makeSessionDir(root: string, name: string, ageMs: number): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "staged.bin"), "payload");
  const mtime = new Date(Date.now() - ageMs);
  utimesSync(dir, mtime, mtime);
  return dir;
}

describe("attachmentSessionDir", () => {
  it("nests the sanitized session id under the shared temp root", () => {
    expect(attachmentSessionDir("abc-123")).toBe(path.join(ATTACHMENT_TMP_ROOT, "abc-123"));
  });

  it("strips path separators and controls so an id cannot escape the root", () => {
    const dir = attachmentSessionDir("../../etc/passwd");
    expect(path.dirname(dir)).toBe(ATTACHMENT_TMP_ROOT);
    expect(path.basename(dir)).toBe(".._.._etc_passwd");
  });
});

describe("sweepStaleAttachmentDirs", () => {
  it("removes dirs idle past the max age and keeps fresh ones", async () => {
    const root = makeRoot();
    const stale = makeSessionDir(root, "old-session", ATTACHMENT_TMP_MAX_AGE_MS + 60_000);
    const fresh = makeSessionDir(root, "new-session", 60_000);
    const removed = await sweepStaleAttachmentDirs({ root });
    expect(removed).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(path.join(fresh, "staged.bin"))).toBe(true);
  });

  it("removes stale non-directory entries too (same namespaced root)", async () => {
    const root = makeRoot();
    const stray = path.join(root, "stray-file");
    writeFileSync(stray, "x");
    const mtime = new Date(Date.now() - ATTACHMENT_TMP_MAX_AGE_MS - 60_000);
    utimesSync(stray, mtime, mtime);
    const removed = await sweepStaleAttachmentDirs({ root });
    expect(removed).toBe(1);
    expect(existsSync(stray)).toBe(false);
  });

  it("honours an explicit `now` anchor for age comparison", async () => {
    const root = makeRoot();
    // 6 days idle: under the 7-day default it survives relative to "now",
    // but a `now` 2 days in the future pushes it past the threshold.
    const dir = makeSessionDir(root, "borderline", 6 * 24 * 60 * 60 * 1000);
    expect(await sweepStaleAttachmentDirs({ root })).toBe(0);
    expect(existsSync(dir)).toBe(true);
    const later = Date.now() + 2 * 24 * 60 * 60 * 1000;
    expect(await sweepStaleAttachmentDirs({ root, now: later })).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  it("returns 0 without throwing when the staging root does not exist", async () => {
    const missing = path.join(tempDir, "never-created");
    await expect(sweepStaleAttachmentDirs({ root: missing })).resolves.toBe(0);
  });

  it("keeps sweeping when an entry cannot be stat'ed (broken symlink)", async () => {
    const root = makeRoot();
    const stale = makeSessionDir(root, "stale-session", ATTACHMENT_TMP_MAX_AGE_MS + 60_000);
    // stat() follows symlinks, so a dangling link deterministically throws
    // inside the sweep loop — the failure must be logged-and-skipped, never
    // abort the remaining entries nor reject the promise.
    symlinkSync(path.join(root, "no-such-target"), path.join(root, "dangling"));
    const skipped: string[] = [];
    const removed = await sweepStaleAttachmentDirs({ root, log: (m) => skipped.push(m) });
    expect(removed).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(skipped.some((m) => m.includes("dangling"))).toBe(true);
  });
});
