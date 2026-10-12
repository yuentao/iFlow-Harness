/**
 * M3 P0-1 — shadow-git checkpoint manager (Extension Host only).
 *
 * One shadow repository per session under
 * `storageUri/checkpoints/<sanitized-sessionId>/git` — a bare repo addressed
 * via `--git-dir` + `--work-tree` (the classic dotfiles pattern), so the
 * user's own `.git` is never opened and non-git workspaces work identically.
 *
 * Capture discipline (roadmap P0-1):
 * - `add -A` (untracked included, .gitignore respected) → `write-tree` →
 *   `commit-tree` chained on the previous turn's sha. commit-tree is used
 *   instead of `commit` so no branch/HEAD bookkeeping is needed — the sha is
 *   the only truth the index file records.
 * - Every git call is async execFile with a timeout (pitfall #18: never block
 *   the extension host) and `windowsHide`. A timeout or failure marks THAT
 *   turn partial; a missing git binary or init failure disables checkpointing
 *   for the whole session (logged once; the panel toasts the reason).
 * - The pre-capture file-count probe guards against multi-GB workspaces:
 *   over the cap the session is disabled and the panel surfaces the reason.
 *
 * Restore semantics: `checkout <sha> -- .` restores tracked files to the
 * snapshot. Files created AFTER the snapshot stay on disk (auto-deleting
 * untracked files would eat content the user made outside the panel) — the
 * panel says so in its confirmation.
 *
 * Zero `vscode` imports: reasons/errors are technical strings the panel
 * localizes when surfacing them.
 */

import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

/** Ref anchoring the live capture chain. commit-tree commits are dangling by
 * design; without a ref a later `git gc --prune=now` (retention) would sweep
 * the snapshots we intend to KEEP. */
const LIVE_REF = "refs/iflow/live";

/** Per-command git timeout (roadmap: 提交带超时 10s，超限降级 partial). */
const GIT_TIMEOUT_MS = 10_000;
/** ls-files output for a 50k-file workspace is a few MB; keep headroom. */
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
/** commit-tree -m rides the command line (Windows cap ~32k chars) — cap it. */
const COMMIT_MESSAGE_MAX_CHARS = 200;
/** Identity for shadow commits — never depends on the user's git config. */
const SHADOW_IDENTITY = ["-c", "user.name=iflow-harness", "-c", "user.email=checkpoint@iflow.local"];

export interface CheckpointLog {
  info(message: string): void;
  warn(message: string): void;
}

interface ShadowRepo {
  /** Absolute path of the shadow repo's git dir (bare layout). */
  gitDir: string;
  workTree: string;
  /** Set when git is missing / init failed / over the file cap — the session
   * stops attempting captures (the panel surfaces the reason once). */
  disabledReason: string | null;
  /** Last captured sha (parent of the next commit-tree). */
  lastSha: string | null;
}

export class CheckpointManager {
  private readonly sessions = new Map<string, ShadowRepo>();
  /** Probe result of `git --version` (null = not probed yet). */
  private gitAvailable: Promise<boolean> | null = null;
  private readonly log: CheckpointLog;
  private readonly timeoutMs: number;
  private maxFiles: number;

  constructor(options: { log: CheckpointLog; timeoutMs?: number; maxFiles?: number }) {
    this.log = options.log;
    this.timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
    this.maxFiles = options.maxFiles ?? 50_000;
  }

  /** Panel re-reads `iflow.checkpointMaxFiles` before each capture. */
  setMaxFiles(maxFiles: number): void {
    if (Number.isFinite(maxFiles) && maxFiles > 0) this.maxFiles = maxFiles;
  }

  /** Filesystem-safe session dir name — same sanitizer as transcripts. */
  static safeSessionId(sessionId: string): string {
    return sessionId.replace(/[^A-Za-z0-9_-]/g, "-");
  }

  /** True when this session may still attempt captures. */
  isEnabled(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    return !state?.disabledReason;
  }

  /** Why capture attempts stopped for this session (null = enabled/unknown). */
  disabledReason(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.disabledReason ?? null;
  }

  /**
   * Prepare the shadow repo for a session (idempotent). Returns null when
   * ready, or a human-readable technical reason when checkpointing is
   * disabled for it (git missing / init failed / workspace over the file
   * cap). The panel shows the reason once and marks turns partial.
   */
  async ensureReady(sessionId: string, checkpointRoot: string, workTree: string): Promise<string | null> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      // The session cwd never changes in practice, but a restore/restart may
      // hand us the resolved path again — keep the freshest one.
      existing.workTree = workTree;
      return existing.disabledReason;
    }
    const state: ShadowRepo = {
      gitDir: path.join(checkpointRoot, CheckpointManager.safeSessionId(sessionId), "git"),
      workTree,
      disabledReason: null,
      lastSha: null,
    };
    this.sessions.set(sessionId, state);

    if (!(await this.probeGit())) {
      state.disabledReason = "git executable not found";
      this.log.warn("checkpoints disabled: git executable not found");
      return state.disabledReason;
    }
    try {
      // `git init` runs with cwd = checkpointRoot, which does not exist on
      // the very first capture — execFile would fail on an invalid cwd.
      await mkdir(checkpointRoot, { recursive: true });
      // Bare init: `gitDir` IS the git dir (no nested .git). core.bare=false
      // with an explicit --work-tree is the supported dotfiles configuration.
      await this.raw(["init", "--bare", state.gitDir], checkpointRoot);
      await this.git(state, ["config", "core.bare", "false"]);
      await this.git(state, ["config", "core.fsmonitor", "false"]);
      await this.git(state, ["config", "commit.gpgsign", "false"]);
    } catch (error) {
      state.disabledReason = `shadow repo init failed: ${errorMessage(error)}`;
      this.log.warn(`checkpoint init failed for ${sessionId}: ${errorMessage(error)}`);
      return state.disabledReason;
    }
    // File-count gate BEFORE the first capture (roadmap: 超阈值关闭并提示).
    try {
      const { stdout } = await this.git(state, ["ls-files", "--others", "--exclude-standard", "--cached"]);
      const count = stdout.split("\n").filter(Boolean).length;
      if (count > this.maxFiles) {
        state.disabledReason = `workspace has ${count} files (cap ${this.maxFiles})`;
        this.log.warn(`checkpoints disabled for ${sessionId}: ${count} files > cap ${this.maxFiles}`);
        return state.disabledReason;
      }
    } catch (error) {
      state.disabledReason = `workspace file enumeration failed: ${errorMessage(error)}`;
      return state.disabledReason;
    }
    return null;
  }
  async reopen(
    sessionId: string,
    checkpointRoot: string,
    workTree: string,
    lastSha: string | null,
  ): Promise<string | null> {
    const reason = await this.ensureReady(sessionId, checkpointRoot, workTree);
    if (reason) return reason;
    const state = this.sessions.get(sessionId);
    if (!state) return "checkpoint session state lost";
    if (lastSha) {
      try {
        await this.git(state, ["cat-file", "-e", `${lastSha}^{commit}`]);
        state.lastSha = lastSha;
        // Repos created before ref-anchoring existed: stamp the ref now so
        // a retention gc never sweeps the live chain.
        await this.git(state, ["update-ref", LIVE_REF, lastSha]).catch(() => undefined);
      } catch {
        // The index references a commit the repo lost (dir wiped): start a
        // fresh chain instead of failing every capture.
        state.lastSha = null;
      }
    }
    return null;
  }

  /**
   * Snapshot the workspace for one turn. Returns the commit sha, or null when
   * the turn must be marked partial (capture failed / timed out / disabled).
   * Chains onto the previous sha so the shadow history mirrors turns.
   */
  async captureTurn(sessionId: string, message: string): Promise<string | null> {
    const state = this.sessions.get(sessionId);
    if (!state || state.disabledReason) return null;
    try {
      await this.git(state, ["add", "-A"]);
      const { stdout: treeOut } = await this.git(state, ["write-tree"]);
      const tree = treeOut.trim();
      if (!tree) throw new Error("write-tree returned nothing");
      const args = ["commit-tree", tree, "-m", message.slice(0, COMMIT_MESSAGE_MAX_CHARS)];
      if (state.lastSha) args.push("-p", state.lastSha);
      const { stdout: shaOut } = await this.git(state, args);
      const sha = shaOut.trim();
      if (!sha) throw new Error("commit-tree returned nothing");
      state.lastSha = sha;
      // Anchor the chain so a retention gc never sweeps live commits.
      // Best effort: capture stays valid even if the ref write fails.
      await this.git(state, ["update-ref", LIVE_REF, sha]).catch(() => undefined);
      return sha;
    } catch (error) {
      this.log.warn(`checkpoint capture failed for ${sessionId}: ${errorMessage(error)}`);
      return null;
    }
  }

  /**
   * Restore the work tree to a captured sha (tracked files only — see the
   * module comment). Throws on failure; the panel surfaces the message.
   */
  async restoreFiles(sessionId: string, sha: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || state.disabledReason) {
      throw new Error("checkpoint session state is no longer available");
    }
    // Validate the sha exists before touching the work tree.
    await this.git(state, ["cat-file", "-e", `${sha}^{commit}`]);
    await this.git(state, ["checkout", sha, "--", "."], this.timeoutMs * 3);
  }

  /** Drop one session's shadow repo entirely (session deleted / pruned). */
  async removeSession(sessionId: string, checkpointRoot: string): Promise<void> {
    this.sessions.delete(sessionId);
    await rm(path.join(checkpointRoot, CheckpointManager.safeSessionId(sessionId)), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }

  /** Forget in-memory state only (session switched) — disk stays for restore. */
  forgetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Turn-count retention: rewrite the kept snapshots (oldest→newest order)
   * into a fresh ancestor-free chain, anchor the head on refs/iflow/live,
   * then `gc --prune=now` sweeps everything the dropped turns owned
   * exclusively. The rewrite is REQUIRED: the original commits chain via
   * parent links, so keeping only the newest would still make every older
   * commit reachable and gc would delete nothing. Trees are shared via
   * content addressing, so rewritten commits cost near-zero extra space and
   * `checkout <newSha> -- .` restores identically.
   *
   * Returns old→new sha pairs (the caller rewrites its index). Throws when a
   * kept sha is missing or any git step fails — the caller keeps the old
   * index untouched and retries next turn.
   */
  async pruneToKeptShas(
    sessionId: string,
    keptShas: readonly string[],
  ): Promise<Array<{ oldSha: string; newSha: string }>> {
    const state = this.sessions.get(sessionId);
    if (!state || state.disabledReason) {
      throw new Error("checkpoint session state is no longer available");
    }
    const mapping: Array<{ oldSha: string; newSha: string }> = [];
    let parent: string | null = null;
    for (const oldSha of keptShas) {
      const { stdout: treeOut } = await this.git(state, ["rev-parse", `${oldSha}^{tree}`]);
      const tree = treeOut.trim();
      if (!tree) throw new Error(`tree for ${oldSha} not found`);
      const { stdout: msgOut } = await this.git(state, ["log", "-1", "--format=%s", oldSha]);
      const args = ["commit-tree", tree, "-m", msgOut.trim() || "checkpoint"];
      if (parent) args.push("-p", parent);
      const { stdout: shaOut } = await this.git(state, args);
      const newSha = shaOut.trim();
      if (!newSha) throw new Error(`commit-tree returned nothing for ${oldSha}`);
      mapping.push({ oldSha, newSha });
      parent = newSha;
    }
    // Anchor first, then prune: the live ref is the only thing keeping the
    // rewritten chain alive against --prune=now.
    if (parent) await this.git(state, ["update-ref", LIVE_REF, parent]);
    await this.git(state, ["gc", "--prune=now"], this.timeoutMs * 6);
    state.lastSha = parent;
    return mapping;
  }

  /** Recursive byte size of one session's store dir (0 when absent). */
  static async dirSizeBytes(dir: string): Promise<number> {
    let total = 0;
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        continue; // vanished mid-walk or unreadable — treat as nothing
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          try {
            total += (await stat(full)).size;
          } catch {
            // raced with a delete — skip
          }
        }
      }
    }
    return total;
  }

  /**
   * Resolve the checkpoint root for `iflow.checkpointDir`. Empty → the
   * default storageUri location. `~` expands; relative paths resolve against
   * the workspace root. A per-workspace hash subfolder is ALWAYS appended
   * under a custom root: pruneUnrestorableSessions deletes unknown
   * subdirectories, and without the split one window would wipe another
   * window's session stores sharing the same custom root.
   */
  static resolveCheckpointRoot(customDir: string, workspaceRoot: string | null, defaultRoot: string): string {
    const trimmed = customDir.trim();
    if (!trimmed) return defaultRoot;
    let base = trimmed;
    if (base === "~" || base.startsWith("~/") || base.startsWith("~\\")) {
      base = path.join(os.homedir(), base.slice(1));
    }
    const abs = path.isAbsolute(base) ? base : path.resolve(workspaceRoot ?? defaultRoot, base);
    const scope = createHash("sha1").update(workspaceRoot ?? "no-workspace").digest("hex").slice(0, 12);
    return path.join(abs, scope);
  }

  private probeGit(): Promise<boolean> {
    if (!this.gitAvailable) {
      this.gitAvailable = execFileAsync("git", ["--version"], { timeout: 5_000, windowsHide: true })
        .then(() => true)
        .catch(() => false);
    }
    return this.gitAvailable;
  }

  /** One git command inside the session's shadow repo (cwd = work tree). */
  private git(state: ShadowRepo, args: string[], timeoutMs = this.timeoutMs): Promise<{ stdout: string }> {
    return this.raw(
      ["--git-dir", state.gitDir, "--work-tree", state.workTree, ...SHADOW_IDENTITY, ...args],
      state.workTree,
      timeoutMs,
    );
  }

  private raw(args: string[], cwd: string, timeoutMs = this.timeoutMs): Promise<{ stdout: string }> {
    return execFileAsync("git", args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: "utf8",
    });
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}