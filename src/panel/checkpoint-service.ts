/**
 * CheckpointService — turn-level workspace checkpoints, extracted from
 * `panel.ts` (阶段 4 of the panel split; behavior-preserving refactor).
 *
 * Owns the shadow-git snapshotter (`CheckpointManager`, one shadow repo per
 * session under `storageUri/checkpoints/`), the per-session warning gates,
 * the checkpoint-index persist chain, and the restore's pending re-anchor
 * index. `ChatPanel` keeps same-named thin delegates so the webview-message
 * switch, `extension.ts` and every existing test keep the exact same
 * contract.
 *
 * Dependency rule: this module NEVER imports `panel.ts`. It only receives the
 * narrow callback surface below, so it cannot create an import cycle and can
 * be unit-tested without constructing a ChatPanel. All panel state that is
 * shared with other flows (`disposed`, `historySyncBusy`, `sessionCwd`, the
 * store, `deleteUserMessage`) is read at CALL TIME through callbacks — never
 * captured as a context snapshot (AGENTS.md pitfall #8: sessionCwd, not
 * process.cwd()). Arrow wrappers in the panel preserve `this` binding.
 *
 * The shadow repo is NEVER the user's `.git`: `CheckpointManager` owns a
 * separate git store per session; that invariant lives in `./checkpoints.js`
 * and is unchanged here.
 *
 * `esbuild.mjs` only bundles `src/extension.ts`, so this file reaches the
 * output solely through the `panel.ts` import below.
 */

import path from "node:path";
import { readFile, readdir, writeFile, mkdir, rm, rename, stat } from "node:fs/promises";
import * as vscode from "vscode";
import {
  checkpointLabelFromText,
  parseCheckpointIndex,
  planCheckpointRetention,
  pruneCheckpointsForBlocks,
  reanchorCheckpoints,
  serializeCheckpointIndex,
  upsertCheckpoint,
} from "../../shared/checkpoints.js";
import type { CheckpointUi, SessionState } from "../../shared/messages.js";
import { errorMessage } from "../acp/jsonrpc.js";
import { CheckpointManager } from "./checkpoints.js";

export interface CheckpointServiceDeps {
  /** Structured log sink (host output channel). */
  log: { info: (message: string) => void; warn: (message: string) => void };
  /** Store surface used by checkpoints (all read at call time). */
  getState(): SessionState;
  setCheckpoints(checkpoints: SessionState["checkpoints"]): void;
  sendToast(
    level: "info" | "warning" | "error",
    message: string,
    opts?: { durationMs?: number },
  ): void;
  appendNotice(text: string): void;
  /** Panel lifecycle flags shared with the new-session / cancel flows. */
  isDisposed(): boolean;
  isHistorySyncBusy(): boolean;
  /** Path bases (pitfall #8: read at call time, never a context snapshot). */
  getSessionCwd(): string | null;
  getWorkspaceRoot(): string | null;
  getExtensionPath(): string;
  getStorageDir(): string;
  /** Conversation rollback reuses the panel's full delete-user-message chain. */
  deleteUserMessage(userBlockId: string, reason: "deleteMessage" | "rollback"): Promise<void>;
  /** `iflow.*` read with the panel's pending-write stash on top (see
   * ChatPanel.readUserSetting); absent in tests that drive the service alone. */
  readUserSetting?: <T>(key: string, fallback: T) => T;
}

/** Per-process sequence for unique temp file names (pid + seq, same
 * discipline as super-store.ts): multiple windows writing the same index
 * must never share a `${target}.tmp` path. */
let tmpSeq = 0;

export class CheckpointService {
  /** Shadow-git snapshotter (one shadow repo per session). */
  private readonly checkpoints: CheckpointManager;
  /** Sessions whose disable-reason toast was already shown (avoid repeats). */
  private readonly checkpointWarnedSessions = new Set<string>();
  /** Sessions whose large-file skip toast was already shown (avoid repeats). */
  private readonly checkpointSkippedWarnedSessions = new Set<string>();
  /** Persist chain for checkpoint index files (same discipline as transcripts). */
  private checkpointPersistChain: Promise<void> = Promise.resolve();
  /** Index loaded before a restore's id re-mint; consumed by finalizeCheckpointIndex. */
  private pendingCheckpointIndex: { sessionId: string; checkpoints: CheckpointUi[] } | null = null;

  constructor(private readonly deps: CheckpointServiceDeps) {
    this.checkpoints = new CheckpointManager({
      log: { info: (m) => this.deps.log.info(m), warn: (m) => this.deps.log.warn(m) },
    });
  }

  /**
   * Root of the shadow-git stores: `storageUri/checkpoints/<sessionId>/git`,
   * or `<iflow.checkpointDir>/<workspace-hash>/<sessionId>/git` when the
   * setting is set (move stores off workspaceStorage — e.g. huge GGUF-heavy
   * workspaces filled C:). Read fresh per call so the setting applies to the
   * next capture without a window reload.
   */
  /** One `iflow.*` setting with the panel's pending-write stash on top. */
  private setting<T>(key: string, fallback: T): T {
    return this.deps.readUserSetting
      ? this.deps.readUserSetting<T>(key, fallback)
      : vscode.workspace.getConfiguration("iflow").get<T>(key, fallback);
  }

  checkpointRoot(): string {
    const defaultRoot = path.join(this.deps.getStorageDir(), "checkpoints");
    const custom = this.setting<string>("checkpointDir", "");
    return CheckpointManager.resolveCheckpointRoot(custom, this.deps.getSessionCwd(), defaultRoot);
  }

  checkpointIndexPath(sessionId: string): string {
    return path.join(this.checkpointRoot(), CheckpointManager.safeSessionId(sessionId), "index.json");
  }

  private checkpointSettingEnabled(): boolean {
    return this.setting<boolean>("checkpoints", true);
  }

  /** Work tree the shadow repo mirrors = the session cwd (pitfall #8). */
  private checkpointCwd(): string {
    return this.deps.getSessionCwd() ?? this.deps.getWorkspaceRoot() ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.deps.getExtensionPath();
  }

  /**
   * Snapshot the workspace for the turn about to start. Awaited by sendPrompt
   * BEFORE the CLI prompt is issued — a parallel capture would race the
   * agent's own writes and bake them into the "before" snapshot. Returns the
   * commit sha (null = partial: git missing / init failed / timed out / over
   * the file cap); the reason is toasted once per session.
   */
  async captureWorkspaceSnapshot(sessionId: string, text: string): Promise<string | null> {
    if (!this.checkpointSettingEnabled()) return null;
    this.checkpoints.setMaxFiles(this.setting<number>("checkpointMaxFiles", 50_000));
    const maxFileMB = this.setting<number>("checkpointMaxFileMB", 300);
    this.checkpoints.setMaxFileBytes(maxFileMB * 1024 * 1024);
    const reason = await this.checkpoints.ensureReady(sessionId, this.checkpointRoot(), this.checkpointCwd());
    if (reason) {
      if (!this.checkpointWarnedSessions.has(sessionId)) {
        this.checkpointWarnedSessions.add(sessionId);
        this.deps.sendToast(
          "warning",
          vscode.l10n.t(
            "从这一轮起无法保存文件快照（原因：{0}），之后的「回滚」只能撤销对话、不能恢复文件。如需恢复文件回滚，请确认工作区可写后重试。",
            reason,
          ),
        );
      }
      return null;
    }
    const label = checkpointLabelFromText(text);
    const sha = await this.checkpoints.captureTurn(sessionId, label || vscode.l10n.t("轮次快照"));
    const skipped = this.checkpoints.skippedFiles(sessionId);
    if (sha && skipped > 0 && !this.checkpointSkippedWarnedSessions.has(sessionId)) {
      this.checkpointSkippedWarnedSessions.add(sessionId);
      this.deps.sendToast(
        "warning",
        vscode.l10n.t("本轮快照已跳过 {0} 个超过大小限制的文件；这些文件不会参与文件回滚。", skipped),
      );
    }
    return sha;
  }

  /** Record one turn's checkpoint into the store projection + index file. */
  recordCheckpoint(sessionId: string, entry: CheckpointUi): void {
    if (this.deps.isDisposed()) return;
    const state = this.deps.getState();
    // Session switched (or the panel moved on) while the capture was running.
    if ((state.activeSessionId ?? state.sessionId) !== sessionId) return;
    const next = upsertCheckpoint(state.checkpoints ?? [], entry);
    this.deps.setCheckpoints(next);
    void this.persistCheckpointIndex(sessionId, next).catch((error: unknown) => {
      this.deps.log.warn(`checkpoint index persist failed for ${sessionId}: ${errorMessage(error)}`);
    });
    void this.enforceCheckpointRetention(sessionId).catch((error: unknown) => {
      this.deps.log.warn(`checkpoint retention failed for ${sessionId}: ${errorMessage(error)}`);
    });
  }

  /**
   * Post-capture retention (settings: checkpointMaxTurns / checkpointMaxSizeMB,
   * 0 = off). Runs fire-and-forget after a turn's checkpoint is recorded —
   * never blocks the prompt, failures only log (the next capture retries).
   *
   * Turn cap: prune the shadow repo to the newest N captures (rewritten
   * chain + gc) and rewrite the live index with the new shas.
   * Size cap: whole-session LRU eviction under the global byte budget —
   * per-turn gc cannot shrink a single huge capture (one GGUF set IS one
   * snapshot), only dropping stale sessions reclaims that. The active
   * session is never evicted. Orphan stores (no index after an idle window,
   * or an index without a single restorable sha — the partial-only /
   * corrupt-repo residue) are reclaimed unconditionally.
   */
  async enforceCheckpointRetention(sessionId: string): Promise<void> {
    if (this.deps.isDisposed()) return;
    const maxTurns = this.setting<number>("checkpointMaxTurns", 0);
    const maxSizeMB = this.setting<number>("checkpointMaxSizeMB", 0);
    const state = this.deps.getState();
    const activeId = state.activeSessionId ?? state.sessionId;

    if (maxTurns > 0 && activeId === sessionId) {
      const list = state.checkpoints ?? [];
      const { kept, dropped } = planCheckpointRetention(list, maxTurns);
      if (dropped.length > 0) {
        const keptShas = [...new Set(kept.map((c) => c.sha).filter((s): s is string => !!s))];
        try {
          // The whole rewrite → index write → gc sequence runs on the SAME
          // chain as every other index write. The rewritten index MUST reach
          // disk before gc deletes the old commits; if the write throws, gc
          // never runs and the old index still points at restorable shas.
          await this.enqueueCheckpointTask(async () => {
            if (this.deps.isDisposed()) return;
            const live = this.deps.getState();
            if ((live.activeSessionId ?? live.sessionId) !== sessionId) return;
            const mapping = keptShas.length > 0
              ? await this.checkpoints.rewriteKeptShas(sessionId, keptShas)
              : [];
            const remap = new Map(mapping.map((m) => [m.oldSha, m.newSha]));
            const rewritten = kept.map((c) =>
              c.sha && remap.has(c.sha) ? { ...c, sha: remap.get(c.sha)! } : c);
            this.deps.setCheckpoints(rewritten);
            await this.writeCheckpointIndexFile(sessionId, rewritten);
            if (keptShas.length > 0) await this.checkpoints.gcSession(sessionId);
            this.deps.log.info(`checkpoint retention: dropped ${dropped.length} turn(s) for ${sessionId}`);
          });
        } catch (error) {
          this.deps.log.warn(`checkpoint retention failed for ${sessionId}: ${errorMessage(error)}`);
        }
      }
    }

    if (maxSizeMB <= 0) return;
    const root = this.checkpointRoot();
    let names: string[];
    try {
      const entries = await readdir(root, { withFileTypes: true });
      names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return; // no store dir yet
    }
    const scored: Array<{ name: string; bytes: number; lastUsed: number }> = [];
    for (const name of names) {
      const dir = path.join(root, name);
      const bytes = await CheckpointManager.dirSizeBytes(dir);
      let lastUsed = 0;
      try {
        lastUsed = (await stat(path.join(dir, "index.json"))).mtimeMs;
      } catch {
        try {
          lastUsed = (await stat(dir)).mtimeMs;
        } catch {
          // vanished mid-scan
        }
      }
      scored.push({ name, bytes, lastUsed });
    }
    const activeDir = activeId ? CheckpointManager.safeSessionId(activeId) : null;
    // Orphans: index-less stores idle >10 min (crashed capture / corrupt repo
    // — the idle guard avoids racing a brand-new session's first capture),
    // or an index whose entries have no restorable sha at all.
    const removed = new Set<string>();
    for (const s of scored) {
      if (s.name === activeDir) continue;
      try {
        const parsed = parseCheckpointIndex(await readFile(path.join(root, s.name, "index.json"), "utf8"));
        if (!parsed || !parsed.some((c) => c.sha)) removed.add(s.name);
      } catch {
        if (Date.now() - s.lastUsed > 10 * 60 * 1000) removed.add(s.name);
      }
    }
    let total = scored.reduce((sum, s) => sum + (removed.has(s.name) ? 0 : s.bytes), 0);
    const budget = maxSizeMB * 1024 * 1024;
    for (const s of [...scored].sort((a, b) => a.lastUsed - b.lastUsed)) {
      if (total <= budget) break;
      if (removed.has(s.name) || s.name === activeDir) continue;
      removed.add(s.name);
      total -= s.bytes;
    }
    if (removed.size === 0) return;
    const freedBytes = scored
      .filter((s) => removed.has(s.name))
      .reduce((sum, s) => sum + s.bytes, 0);
    for (const name of removed) {
      await rm(path.join(root, name), { recursive: true, force: true }).catch(() => undefined);
    }
    this.deps.log.info(`checkpoint retention: removed ${removed.size} store dir(s), freed ${Math.round(freedBytes / (1024 * 1024))} MB`);
    this.deps.sendToast(
      "info",
      vscode.l10n.t("已按上限清理 {0} 份旧快照（释放约 {1} MB）", removed.size, Math.round(freedBytes / (1024 * 1024))),
      { durationMs: 8000 },
    );
  }

  /**
   * Run one checkpoint disk task on the shared serial chain. The chain stores
   * an error-swallowing tail (one failed write must not block later writes),
   * but the RETURNED promise still rejects so callers can observe/report the
   * failure — which is why every fire-and-forget caller attaches `.catch`.
   */
  private enqueueCheckpointTask<T>(task: () => Promise<T>): Promise<T> {
    const run = this.checkpointPersistChain
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(task);
    this.checkpointPersistChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Atomic index write (temp + rename), serialized on its own chain. */
  persistCheckpointIndex(sessionId: string, checkpoints: readonly CheckpointUi[]): Promise<void> {
    return this.enqueueCheckpointTask(() => this.writeCheckpointIndexFile(sessionId, checkpoints));
  }

  /**
   * One raw atomic write — MUST only be called from inside a
   * `checkpointPersistChain` task (calling `persistCheckpointIndex` there
   * would deadlock by queueing behind itself).
   *
   * Temp name is pid + monotonic seq (never a fixed `${target}.tmp`): two
   * windows writing the same session index cannot overwrite each other's
   * temp file. Any failure removes that temp file before rethrowing.
   */
  private async writeCheckpointIndexFile(sessionId: string, checkpoints: readonly CheckpointUi[]): Promise<void> {
    const target = this.checkpointIndexPath(sessionId);
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid.toString(36)}-${(tmpSeq++).toString(36)}.tmp`;
    try {
      await writeFile(tmp, serializeCheckpointIndex(checkpoints), "utf8");
      await rename(tmp, target);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Phase 1 of the restore wiring: read the persisted index (whose anchors
   * are the ORIGINAL block ids — the transcript file is lossless) and reopen
   * the shadow repo so file restores work. Must run BEFORE
   * `reassignBlockIds` re-mints the ids; the raw list is kept for
   * {@link finalizeCheckpointIndex}. Silent no-op when the session predates
   * the feature.
   */
  async loadCheckpointIndex(sessionId: string): Promise<void> {
    this.pendingCheckpointIndex = null;
    let raw: string;
    try {
      raw = await readFile(this.checkpointIndexPath(sessionId), "utf8");
    } catch {
      return; // no index — nothing to restore
    }
    const parsed = parseCheckpointIndex(raw);
    if (!parsed || parsed.length === 0) return;
    if (this.checkpointSettingEnabled()) {
      const lastSha = [...parsed].reverse().find((c) => c.sha)?.sha ?? null;
      await this.checkpoints.reopen(sessionId, this.checkpointRoot(), this.checkpointCwd(), lastSha);
    }
    this.pendingCheckpointIndex = { sessionId, checkpoints: parsed };
  }

  /**
   * Phase 2: after `replaceTranscript` re-minted the block ids, re-anchor the
   * loaded index to the live ids (old→new map captured by the caller around
   * the re-mint) and push the projection. No-op when phase 1 found nothing
   * or the session changed meanwhile.
   */
  finalizeCheckpointIndex(remap: ReadonlyMap<string, string>): void {
    const pending = this.pendingCheckpointIndex;
    this.pendingCheckpointIndex = null;
    if (!pending) return;
    const state = this.deps.getState();
    if (state.activeSessionId !== pending.sessionId) return;
    const reanchored = reanchorCheckpoints(pending.checkpoints, remap);
    if (reanchored.length > 0) this.deps.setCheckpoints(reanchored);
  }

  /** Drop checkpoints whose anchor user block no longer exists (truncation). */
  pruneCheckpointIndexAfterTruncation(): void {
    const state = this.deps.getState();
    const sessionId = state.activeSessionId ?? state.sessionId;
    const list = state.checkpoints ?? [];
    if (!sessionId || list.length === 0) return;
    const pruned = pruneCheckpointsForBlocks(list, state.blocks);
    if (pruned.length === list.length) return;
    this.deps.setCheckpoints(pruned);
    void this.persistCheckpointIndex(sessionId, pruned).catch((error: unknown) => {
      this.deps.log.warn(`checkpoint index persist failed for ${sessionId}: ${errorMessage(error)}`);
    });
  }

  /** Delete a session's shadow repo (session deleted / pruned as dead). */
  async removeCheckpointsForSession(sessionId: string): Promise<void> {
    this.checkpointWarnedSessions.delete(sessionId);
    this.checkpointSkippedWarnedSessions.delete(sessionId);
    await this.checkpoints.removeSession(sessionId, this.checkpointRoot());
  }

  /**
   * M3 P0-1 restore entry point (three modes, roadmap §1 P0-1): "files" =
   * shadow-git checkout of the turn's pre-turn snapshot; "conversation" =
   * truncate the transcript at that user message (reuses the deleteUserMessage
   * chain incl. CLI chatHistory truncation); "both" = files first, then
   * conversation. Gates mirror deleteUserMessage (no mid-turn restores).
   */
  async restoreCheckpoint(
    userBlockId: string,
    mode: "files" | "conversation" | "both",
  ): Promise<void> {
    if (this.deps.isDisposed() || this.deps.isHistorySyncBusy()) return;
    const state = this.deps.getState();
    if (
      state.initializing || state.replaying || state.status === "streaming" || state.status === "connecting" ||
      state.pendingApproval || state.pendingQuestions
    ) {
      this.deps.appendNotice(vscode.l10n.t("正在生成、连接或等待确认，请先完成当前操作后再回滚"));
      return;
    }
    const sessionId = state.activeSessionId ?? state.sessionId;
    if (!sessionId) return;
    const entry = (state.checkpoints ?? []).find((c) => c.userBlockId === userBlockId);
    if (!entry) {
      this.deps.appendNotice(vscode.l10n.t("该轮没有可用的工作区快照"));
      return;
    }
    if (mode === "files" || mode === "both") {
      if (!entry.sha) {
        this.deps.appendNotice(vscode.l10n.t("该轮快照不完整，无法恢复文件（可选择仅回滚对话）"));
        return;
      }
      const restored = await this.confirmAndRestoreCheckpointFiles(sessionId, entry);
      if (!restored) return;
    }
    if (mode === "conversation" || mode === "both") {
      // Reuses the full delete chain: transcript truncation + CLI history
      // truncation + reload, plus the checkpoint-index prune inside it.
      await this.deps.deleteUserMessage(userBlockId, "rollback");
    }
  }

  /**
   * Confirm + perform the workspace checkout. Two guard rails mirror
   * revertToolDiff: dirty editors (unsaved buffers) and an explicit modal
   * (this is a whole-workspace overwrite). Returns false when the user
   * cancels or the checkout fails.
   */
  async confirmAndRestoreCheckpointFiles(sessionId: string, entry: CheckpointUi): Promise<boolean> {
    const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === "file");
    if (dirty.length > 0) {
      const pick = await vscode.window.showWarningMessage(
        vscode.l10n.t("有 {0} 个文件在编辑器中有未保存的修改。回滚将从磁盘重新加载并丢弃这些修改。", dirty.length),
        { modal: true },
        vscode.l10n.t("丢弃并回滚"),
      );
      if (pick !== vscode.l10n.t("丢弃并回滚")) return false;
    }
    const title = entry.label || vscode.l10n.t("该轮");
    const pick = await vscode.window.showWarningMessage(
      vscode.l10n.t("将工作区文件回滚到「{0}」之前的状态？已跟踪文件会被覆盖；该快照之后新建的文件会保留。", title),
      { modal: true },
      vscode.l10n.t("回滚文件"),
    );
    if (pick !== vscode.l10n.t("回滚文件")) return false;
    try {
      await this.checkpoints.restoreFiles(sessionId, entry.sha!);
    } catch (error) {
      void vscode.window.showErrorMessage(vscode.l10n.t("工作区回滚失败：{0}", errorMessage(error)));
      return false;
    }
    // Reload the editors we just overwrote from disk so the restored content
    // is what the user sees (same trick as revertToolDiff).
    for (const doc of dirty) {
      try {
        await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
        await vscode.commands.executeCommand("workbench.action.files.revert");
      } catch {
        // best-effort reload
      }
    }
    void vscode.window.showInformationMessage(vscode.l10n.t("工作区文件已回滚到该轮之前的状态。"));
    return true;
  }
}
