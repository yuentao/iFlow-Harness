/**
 * ToolDiffService — host-side tool diff / revert logic, extracted from
 * `panel.ts` (阶段 1 of the panel split; behavior-preserving refactor).
 *
 * Owns every operation that turns a tool block's `diff` into a user-visible
 * action: opening the native diff editor, locating the on-disk file behind a
 * wire path, synthesizing a diff for tools the wire gives none, whole-file
 * revert, per-hunk keep/revert, and single-file turn undo.
 *
 * Dependency rule: this module NEVER imports `panel.ts`. It only receives the
 * narrow callback surface below, so it cannot create an import cycle and can
 * be unit-tested without constructing a ChatPanel. All path resolution stays
 * anchored on the CURRENT session cwd (AGENTS.md pitfall #8) — the callbacks
 * deliberately read `this.sessionCwd` at call time, never a context snapshot.
 */

import * as vscode from "vscode";
import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { errorMessage } from "../acp/jsonrpc.js";
import type { HostToWebview, SessionState, ToolBlock, ToolDiffUi } from "../../shared/messages.js";
import {
  MAX_SYNTH_DIFF_CHARS,
  findToolBlockById,
  parseToolFilePath,
  snapshotEditDiff,
  synthesizeEditDiff,
  type ParsedEditArgs,
  type PreEditSnapshot,
} from "../../shared/session-state.js";
import { computeHunks, replayHunks } from "../../shared/hunks.js";
import { canReviewTurn, collectTurnToolBlocks, isLatestTurn, turnChangeKey } from "../../shared/turn-changes.js";

export interface ToolDiffServiceDeps {
  /** Structured log sink (host output channel). */
  log: { warn: (message: string) => void };
  /** Current session cwd — the base for relative wire paths (pitfall #8). */
  getSessionCwd(): string | null;
  /** All workspace roots, same set passed to the CLI as --include-directories. */
  getWorkspaceRoots(): string[];
  /** Last-resort base when neither a session nor a workspace exists. */
  getExtensionPath(): string;
  /** Resolve one wire-relative path exactly as the panel does (arrow-wrapped). */
  resolvePath(p: string): string;
  /** Live host session state (read at call time, never cached). */
  getState(): SessionState;
  /** Post a host→webview message. */
  post(message: HostToWebview): void;
  /** Store mutations, kept as callbacks so no SessionStore import is needed. */
  toolDiffSynthesized(toolCallId: string, diff: ToolDiffUi): void;
  toolReverted(toolCallId: string): void;
  toolHunkDecisions(toolCallId: string, decisions: readonly boolean[], partial: boolean): void;
  /** Shared transient caches — the panel's ACP update hook writes the same
   * maps at `in_progress`; both sides therefore see one consistent view. */
  readonly toolArgs: Map<string, ParsedEditArgs>;
  readonly preSnapshots: Map<string, PreEditSnapshot>;
  /** Tool-args / pre-snapshot cap (owned by the panel, injected as a value). */
  readonly toolArgsCap: number;
}

export class ToolDiffService {
  constructor(private readonly deps: ToolDiffServiceDeps) {}

  // --- Path / disk helpers ----------------------------------------------------

  /** Same heuristic as the CLI-locator's shim probe (pitfall #7): a NUL byte
   * in the first 1KB. utf8 round-trips are LOSSY for binary content, so a
   * synthesized diff's oldText would be corrupted and reverting would write
   * the corruption back. */
  static isBinary(buf: Buffer): boolean {
    return buf.subarray(0, 1024).includes(0);
  }

  /** Session-base fallback chain; identical to the panel's resolveAgentPathToAbsolute base. */
  private sessionBase(): string {
    return (
      this.deps.getSessionCwd() ??
      this.deps.getWorkspaceRoots()[0] ??
      this.deps.getExtensionPath()
    );
  }

  /** True when disk content === diff newText (decisive "this is the edited file"). */
  private async probeRevertCandidate(candidate: string, newText: string | null): Promise<boolean> {
    if (newText === null) return false;
    try {
      const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(candidate));
      return Buffer.from(buf).toString("utf8") === newText;
    } catch {
      return false;
    }
  }

  private async fileContentEquals(file: string, expected: string): Promise<boolean> {
    try {
      const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
      return Buffer.from(buf).toString("utf8") === expected;
    } catch {
      return false;
    }
  }

  /** Bounded case-insensitive basename search; skips heavy dirs, capped. */
  private async findFileByBasename(root: string, basename: string, maxDepth = 6): Promise<string[]> {
    const results: string[] = [];
    const target = basename.toLowerCase();
    const skip = new Set(["node_modules", ".git", "dist", "out", "build", "coverage", ".iflow", ".vscode"]);
    // C8: budget by directories walked, not entries seen — readdir cost is
    // dominated by the directory count, and per-entry counting exhausted the
    // old 20k budget prematurely in wide directories.
    let dirsVisited = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > maxDepth || dirsVisited > 2_000 || results.length >= 10) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // unreadable / not a dir
      }
      dirsVisited++;
      for (const entry of entries) {
        if (results.length >= 10) return;
        const full = path.join(dir, entry.name);
        if (entry.isFile() && entry.name.toLowerCase() === target) {
          results.push(full);
        } else if (entry.isDirectory() && !skip.has(entry.name.toLowerCase())) {
          await walk(full, depth + 1);
        }
      }
    };
    await walk(root, 0);
    return results;
  }

  /** Resolve which file on disk a tool diff refers to (shared by diff/revert). */
  private async locateDiffFile(block: ToolBlock): Promise<string | null> {
    const { path: rawPath, newText } = block.diff!;
    // The CLI may send workspace-relative paths; resolve them against the cwd
    // the session was created with (the Extension Host's process.cwd() is not
    // necessarily the workspace).
    const sessionBase = this.sessionBase();
    const toAbsolute = (p: string) => (path.isAbsolute(p) ? p : path.join(sessionBase, p));

    // diff.path is what the tool was invoked with and may NOT be anchored to
    // the session root (observed: "Home.vue" for src/views/Home.vue). The
    // tool_call locations usually carry the real path — try all candidates,
    // preferring the one whose disk content matches the diff's newText.
    const candidates: string[] = [];
    const seen = new Set<string>();
    const addCandidate = (p?: string | null) => {
      if (!p) return;
      const abs = toAbsolute(p);
      const key = abs.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(abs);
      }
    };
    addCandidate(rawPath);
    for (const loc of block.locations ?? []) addCandidate(loc.path);

    for (const candidate of candidates) {
      const decisive = await this.probeRevertCandidate(candidate, newText);
      if (decisive) return candidate; // disk content === diff newText: the edited file
    }

    // All direct candidates failed (CLI sent a tool-relative path without a
    // usable locations entry). Fall back to a bounded basename search under
    // the session root and workspace folders.
    const basename = path.basename(rawPath.replace(/\\/g, "/"));
    const roots = new Set<string>();
    if (sessionBase) roots.add(sessionBase);
    for (const folder of this.deps.getWorkspaceRoots()) roots.add(folder);
    const matches: string[] = [];
    for (const root of roots) {
      matches.push(...(await this.findFileByBasename(root, basename)));
      if (matches.length > 1) break; // enough for a picker
    }
    // Prefer the match whose content equals the diff's newText.
    for (const match of matches) {
      if (newText !== null && (await this.fileContentEquals(match, newText))) {
        return match;
      }
    }
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      const pick = await vscode.window.showQuickPick(matches, {
        placeHolder: vscode.l10n.t('找到多个 "{0}"，选择目标文件', basename),
      });
      return pick ?? null;
    }
    // Last resort: let the user point at the file.
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: vscode.l10n.t("选择目标文件"),
      defaultUri: sessionBase ? vscode.Uri.file(sessionBase) : undefined,
    });
    return picked?.[0]?.fsPath ?? null;
  }

  // --- Diff synthesis ---------------------------------------------------------

  /**
   * Attach a host-synthesized diff to a completed tool block that never
   * received one on the wire. MCP tools never carry structured diffs (CLI
   * 0.5.19 flattens MCP results to plain text — verified in the bundle), so
   * without this their edits render as a bare output card.
   *
   * Strategy 1 (tool-agnostic): compare the pre-run disk snapshot captured at
   * `in_progress` with the post-completion content — any editing tool
   * (replace-style, write-style, delete, or an MCP editor with unknown arg
   * shape) produces a real before/after diff.
   * Strategy 2 (fallback, no snapshot — e.g. the panel attached mid-session):
   * reverse recognized replacement args on the post-edit file
   * (shared/synthesizeEditDiff).
   * Fire-and-forget: any mismatch (file moved on, ambiguous fragments, read
   * failure) leaves the card unchanged — never a guessed diff (pitfall #6
   * discipline).
   */
  private async maybeSynthesizeToolDiff(toolCallId: string): Promise<void> {
    // Consume both caches up front: a completed tool must never leave stale
    // entries behind (the wire-diff early-return below would otherwise leak
    // them until cap eviction).
    const snapshot = this.deps.preSnapshots.get(toolCallId);
    this.deps.preSnapshots.delete(toolCallId);
    const parsed = this.deps.toolArgs.get(toolCallId);
    this.deps.toolArgs.delete(toolCallId);

    const block = findToolBlockById(this.deps.getState().blocks, toolCallId);
    if (!block || block.diff !== null) return;

    if (snapshot) {
      let postContent: string | null = null;
      try {
        const buf = await readFile(snapshot.path);
        if (buf.length <= MAX_SYNTH_DIFF_CHARS && !ToolDiffService.isBinary(buf)) postContent = buf.toString("utf8");
      } catch {
        postContent = null; // deleted (or unreadable) — deletion diff below
      }
      if (postContent === null && snapshot.content !== null) {
        // A read error is indistinguishable from a deletion here; only claim a
        // deletion when the file is truly gone (a fabricated revert target is
        // worse than a missing diff). A binary/oversized post-file still
        // exists on disk — existsSync fails those cases closed.
        if (!existsSync(snapshot.path)) {
          const diff = snapshotEditDiff(snapshot, null);
          if (diff) this.deps.toolDiffSynthesized(toolCallId, diff);
        }
        return;
      }
      const diff = snapshotEditDiff(snapshot, postContent);
      if (diff) {
        this.deps.toolDiffSynthesized(toolCallId, diff);
        return;
      }
      // Content identical (or oversized): fall through to arg reversal in
      // case the tool edited a DIFFERENT path than its args' primary field.
    }

    if (parsed === undefined) return;
    const candidates: string[] = [];
    const seen = new Set<string>();
    const addCandidate = (p?: string | null) => {
      if (!p) return;
      const abs = this.deps.resolvePath(p);
      const key = abs.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(abs);
      }
    };
    addCandidate(parsed.path);
    for (const loc of block.locations ?? []) addCandidate(loc.path);
    for (const candidate of candidates) {
      let postEdit: string;
      try {
        const buf = await readFile(candidate);
        if (ToolDiffService.isBinary(buf)) continue;
        postEdit = buf.toString("utf8");
      } catch {
        continue;
      }
      const diff = synthesizeEditDiff(parsed, postEdit);
      if (!diff) continue;
      // Keep the diff path anchored to the resolved absolute location so the
      // revert/diff-editor paths skip the basename-search fallback.
      this.deps.toolDiffSynthesized(toolCallId, { ...diff, path: candidate });
      return;
    }
  }

  /** Snapshot the target file's disk content before the tool runs. Runs
   * synchronously on purpose: the CLI starts executing the tool the moment it
   * finishes emitting this update, so an async read could race the write and
   * capture post-edit content (silently losing the diff). Bounded by
   * MAX_SYNTH_DIFF_CHARS via stat; unreadable/large/binary paths record
   * nothing. */
  capturePreEditSnapshot(toolCallId: string, args: unknown): void {
    if (this.deps.preSnapshots.has(toolCallId)) return;
    const rawPath = parseToolFilePath(args);
    if (!rawPath) return;
    const abs = this.deps.resolvePath(rawPath);
    try {
      const stat = statSync(abs);
      if (!stat.isFile() || stat.size > MAX_SYNTH_DIFF_CHARS) return;
      const buf = readFileSync(abs);
      if (ToolDiffService.isBinary(buf)) return;
      this.deps.preSnapshots.set(toolCallId, { path: abs, content: buf.toString("utf8") });
    } catch (error) {
      // ENOENT is meaningful (a creation is coming). Any other error (EPERM,
      // unreadable dir…) records nothing — a failed read must never masquerade
      // as "file will be created" and fabricate an all-additions diff.
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.deps.preSnapshots.set(toolCallId, { path: abs, content: null });
      }
    }
    if (this.deps.preSnapshots.size > this.deps.toolArgsCap) {
      const oldest = this.deps.preSnapshots.keys().next().value;
      if (oldest !== undefined) this.deps.preSnapshots.delete(oldest);
    }
  }

  /** Drop all transient per-tool-call caches (session switch / restore / hot
   * re-auth): a stale snapshot from the previous session must never be
   * compared against a same-id tool call in the new one. */
  clearToolCaches(): void {
    this.deps.preSnapshots.clear();
    this.deps.toolArgs.clear();
  }

  // --- Revert / hunk actions --------------------------------------------------

  /** M5: open the tool's change in VSCode's native diff editor
   * (left: temp file with the pre-edit content, right: current disk file). */
  private async openToolDiff(toolCallId: string): Promise<void> {
    const block = findToolBlockById(this.deps.getState().blocks, toolCallId);
    if (!block || !block.diff) return;
    const { oldText } = block.diff;
    if (oldText === null) {
      void vscode.window.showWarningMessage(vscode.l10n.t("无法打开 diff：缺少编辑前内容"));
      return;
    }
    const chosen =
      block.diff.newText === null && path.isAbsolute(block.diff.path)
        ? // Deletion diff on a known-absolute path: the native diff editor
          // shows the pre-delete content vs the missing file — the right
          // visualization, and locateDiffFile's probe cannot match a gone file.
          this.deps.resolvePath(block.diff.path)
        : await this.locateDiffFile(block);
    if (!chosen) return;

    // Left side: a temp file holding the pre-edit content. Files live in the
    // OS temp dir (cleaned by the system); the .ts suffix gives highlighting.
    const suffix = path.extname(chosen) || ".txt";
    const tmpOld = path.join(os.tmpdir(), `iflow-old-${Date.now()}-${path.basename(chosen)}`);
    const tmpUri = vscode.Uri.file(tmpOld + (suffix ? "" : suffix));
    try {
      await vscode.workspace.fs.writeFile(tmpUri, Buffer.from(oldText, "utf8"));
    } catch (error) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t("打开 diff 失败：{0}", errorMessage(error)),
      );
      return;
    }
    const title = `${path.basename(chosen)} (${block.toolName || "edit"})`;
    await vscode.commands.executeCommand("vscode.diff", tmpUri, vscode.Uri.file(chosen), title);
  }

  /**
   * Undo one file's changes in the LATEST completed turn by restoring the
   * pre-edit text of its first recorded diff (the turn-start content).
   * Multiple diffs grouped under the same location-aware identity are undone
   * together.
   *
   * Safety: refuses during generation, on historical turns, when the first
   * diff has no old text, or when the file has unsaved editor changes; asks
   * before recreating a missing file or overwriting content that moved on.
   * The disk is re-read immediately before writing, and session/status are
   * revalidated after every dialog. Editor reloading is left to the file
   * watcher — the dirty-buffer case was refused up front.
   */
  private async revertTurnFile(sessionId: string, userBlockId: string, key: string): Promise<void> {
    const state = this.deps.getState();
    if (state.sessionId !== sessionId || !canReviewTurn(state, userBlockId)) return;
    if (!isLatestTurn(state.blocks, userBlockId)) {
      void vscode.window.showWarningMessage(vscode.l10n.t("仅可回退最近一轮的文件修改"));
      return;
    }
    if (state.status === "streaming" || state.status === "connecting") {
      void vscode.window.showWarningMessage(vscode.l10n.t("当前正在生成，无法回退文件修改"));
      return;
    }
    const edits = collectTurnToolBlocks(state.blocks, userBlockId)
      .filter((block) => block.diff && turnChangeKey(block) === key);
    if (edits.length === 0) {
      void vscode.window.showWarningMessage(vscode.l10n.t("本轮没有该文件的修改记录"));
      return;
    }
    const first = edits[0]!;
    const last = edits[edits.length - 1]!;
    const oldText = first.diff!.oldText;
    if (oldText === null) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("无法回退：该文件缺少编辑前内容（可能是本轮新建的文件）"),
      );
      return;
    }
    const lastNew = last.diff!.newText;
    const chosen =
      lastNew === null && path.isAbsolute(last.diff!.path)
        ? this.deps.resolvePath(last.diff!.path)
        : await this.locateDiffFile(last);
    if (!chosen) return;

    const fileUri = vscode.Uri.file(chosen);
    let currentText: string | null = null;
    try {
      currentText = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString("utf8");
    } catch {
      // Missing on disk: writing oldText recreates it.
    }
    const openDoc = vscode.workspace.textDocuments.find(
      (d) => d.uri.fsPath.toLowerCase() === fileUri.fsPath.toLowerCase(),
    );
    if (openDoc?.isDirty) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("该文件在编辑器中有未保存的修改，请先保存或还原后再回退"),
      );
      return;
    }

    const markReverted = (): void => {
      // The store must still be the same session; a switch during a dialog
      // must never stamp tool ids in the new transcript.
      if (this.deps.getState().sessionId !== sessionId) return;
      for (const edit of edits) {
        const current = findToolBlockById(this.deps.getState().blocks, edit.toolCallId);
        if (current && !current.reverted) this.deps.toolReverted(edit.toolCallId);
      }
    };

    if (currentText === oldText) {
      markReverted();
      void vscode.window.showInformationMessage(vscode.l10n.t("已是本轮开始前的内容，无需回退：{0}", chosen));
      this.deps.post({ type: "turnFileReverted", sessionId, userBlockId, key });
      return;
    }
    const chained = edits.every((edit, index) =>
      index === 0 || edit.diff!.oldText === edits[index - 1]!.diff!.newText);
    if (edits.length > 1 && !chained && (currentText === null || currentText === lastNew)) {
      const pick = await vscode.window.showWarningMessage(
        vscode.l10n.t("本轮对该文件有 {0} 次修改记录且内容不连续，回退将恢复到本轮开始前的内容。继续？", edits.length),
        { modal: true },
        vscode.l10n.t("仍然回退"),
      );
      if (pick !== vscode.l10n.t("仍然回退")) return;
    }
    if (currentText === null && lastNew !== null) {
      const pick = await vscode.window.showWarningMessage(
        vscode.l10n.t("该文件当前不存在，回退将按本轮开始前的内容重建。继续？"),
        { modal: true },
        vscode.l10n.t("重建文件"),
      );
      if (pick !== vscode.l10n.t("重建文件")) return;
    }
    if (currentText !== null && currentText !== lastNew) {
      const pick = await vscode.window.showWarningMessage(
        vscode.l10n.t("文件内容与记录不一致（可能已被继续修改）。仍恢复到本轮开始前的内容？"),
        { modal: true },
        vscode.l10n.t("仍然回退"),
      );
      if (pick !== vscode.l10n.t("仍然回退")) return;
    }

    // The dialogs (and locateDiffFile's picker) can wait indefinitely: abort
    // if the file or session changed underneath us, instead of overwriting a
    // newer state with a stale decision.
    let latestText: string | null = null;
    try {
      latestText = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString("utf8");
    } catch {
      // Still missing.
    }
    if (latestText !== currentText) {
      void vscode.window.showWarningMessage(vscode.l10n.t("文件在回退确认期间被修改，请重试"));
      return;
    }
    const after = this.deps.getState();
    if (after.sessionId !== sessionId || after.status === "streaming" || after.status === "connecting" ||
        !isLatestTurn(after.blocks, userBlockId)) {
      void vscode.window.showWarningMessage(vscode.l10n.t("会话状态已变化，回退已取消"));
      return;
    }

    try {
      // Write through the VSCode file service so watchers stay consistent.
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(oldText, "utf8"));
      markReverted();
      void vscode.window.showInformationMessage(vscode.l10n.t("已回退本轮对该文件的全部修改：{0}", chosen));
      this.deps.post({ type: "turnFileReverted", sessionId, userBlockId, key });
    } catch (error) {
      vscode.window.showErrorMessage(
        vscode.l10n.t("回退文件修改失败：{0}", errorMessage(error)),
      );
    }
  }

  private async revertToolDiff(toolCallId: string): Promise<void> {
    const block = findToolBlockById(this.deps.getState().blocks, toolCallId);
    if (!block || !block.diff) return;
    const { oldText, newText } = block.diff;
    if (oldText === null) {
      vscode.window.showWarningMessage(
        vscode.l10n.t("无法回退：该 diff 缺少原始内容（可能是新建文件以外的信息缺失）"),
      );
      return;
    }
    const chosen =
      newText === null && path.isAbsolute(block.diff.path)
        ? // Deletion diff on a known-absolute path (synthesized deletions
          // always record one): revert recreates the file there —
          // locateDiffFile's disk-content probe can never match a missing
          // file and would dead-end at the manual picker. Relative paths
          // keep the full locateDiffFile resolution (pitfall #6).
          this.deps.resolvePath(block.diff.path)
        : await this.locateDiffFile(block);
    if (!chosen) return;

    const fileUri = vscode.Uri.file(chosen);
    let currentText: string | null = null;
    try {
      currentText = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString("utf8");
    } catch {
      // File missing on disk — writing oldText will (re)create it; that is the
      // best-possible revert for a deleted file.
    }
    try {
      const openDoc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath.toLowerCase() === fileUri.fsPath.toLowerCase(),
      );
      if (openDoc?.isDirty) {
        const pick = await vscode.window.showWarningMessage(
          vscode.l10n.t("该文件在编辑器中有未保存的修改。回退将从磁盘重新加载并丢弃这些修改。"),
          { modal: true },
          vscode.l10n.t("丢弃并回退"),
        );
        if (pick !== vscode.l10n.t("丢弃并回退")) return;
      }

      if (newText !== null && currentText === oldText) {
        // Already reverted (e.g. the CLI undid it, or a previous retry landed).
        this.deps.toolReverted(toolCallId);
        void vscode.window.showInformationMessage(vscode.l10n.t("已是原始内容，无需回退：{0}", chosen));
        return;
      }
      if (newText !== null && currentText !== null && currentText !== newText) {
        const pick = await vscode.window.showWarningMessage(
          vscode.l10n.t("文件内容与 diff 记录不一致（可能已被继续修改）。仍按 diff 原始内容回退？"),
          { modal: true },
          vscode.l10n.t("仍然回退"),
        );
        if (pick !== vscode.l10n.t("仍然回退")) return;
      }

      // Write through the VSCode file service so watchers stay consistent
      // (raw fs.writeFile bypasses them).
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(oldText, "utf8"));
      // Reveal + reload the document so the user immediately sees the revert.
      const doc = openDoc ?? (await vscode.workspace.openTextDocument(fileUri));
      await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
      if (doc.isDirty) {
        // Reload the editor from disk, discarding the stale unsaved buffer.
        await vscode.commands.executeCommand("workbench.action.files.revert");
      }
      this.deps.toolReverted(toolCallId);
      void vscode.window.showInformationMessage(vscode.l10n.t("已回退：{0}", chosen));
    } catch (error) {
      vscode.window.showErrorMessage(
        vscode.l10n.t("回退失败：{0}", errorMessage(error)),
      );
    }
  }

  /**
   * M4 P0-2 — apply a per-hunk keep/revert decision. Deterministic: the target
   * text is replayed from the diff's oldText with only the kept hunks applied
   * (shared/hunks.ts), so no fuzzy patching ever touches the file. The op is
   * REFUSED when disk content no longer equals the diff's newText — the file
   * moved on since the edit, and a partial write would be guesswork (the
   * roadmap routes that case to the turn checkpoint instead).
   */
  private async applyHunkSelection(toolCallId: string, keep: boolean[]): Promise<void> {
    const block = findToolBlockById(this.deps.getState().blocks, toolCallId);
    if (!block || !block.diff) return;
    const { oldText, newText } = block.diff;
    if (oldText === null || newText === null) {
      // Creation/deletion diffs have no per-hunk semantics — whole-file revert
      // (or nothing) is the only meaningful action there.
      vscode.window.showWarningMessage(
        vscode.l10n.t("无法逐块回退：新建或删除文件只能整文件处理"),
      );
      return;
    }
    const hunks = computeHunks(oldText, newText);
    if (!hunks || hunks.length === 0) {
      vscode.window.showWarningMessage(vscode.l10n.t("该改动无法逐块回退，请使用整文件回退"));
      return;
    }
    if (keep.length !== hunks.length) {
      this.deps.log.warn(`applyHunkSelection: decision length ${keep.length} ≠ hunk count ${hunks.length}`);
      return;
    }
    if (!keep.some((k) => k)) {
      // Nothing kept = whole-file revert; route through the battle-tested path
      // (it owns the already-reverted short-circuit and messaging).
      await this.revertToolDiff(toolCallId);
      return;
    }
    if (keep.every((k) => k)) {
      void vscode.window.showInformationMessage(vscode.l10n.t("未回退任何改动"));
      return;
    }

    const chosen = await this.locateDiffFile(block);
    if (!chosen) return;
    const fileUri = vscode.Uri.file(chosen);
    let currentText: string | null = null;
    try {
      currentText = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString("utf8");
    } catch {
      currentText = null;
    }
    if (currentText !== newText) {
      // Refuse rather than fuzzy-merge: the diff's line ranges no longer map
      // onto the file. The user can restore the whole turn via the checkpoint.
      void vscode.window.showWarningMessage(
        vscode.l10n.t("文件内容与 diff 记录不一致（可能已被继续修改）。请先回退整份改动，或使用「回滚到此轮之前」。"),
      );
      return;
    }

    try {
      const openDoc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath.toLowerCase() === fileUri.fsPath.toLowerCase(),
      );
      if (openDoc?.isDirty) {
        const pick = await vscode.window.showWarningMessage(
          vscode.l10n.t("该文件在编辑器中有未保存的修改。逐块回退将从磁盘重新加载并丢弃这些修改。"),
          { modal: true },
          vscode.l10n.t("丢弃并回退"),
        );
        if (pick !== vscode.l10n.t("丢弃并回退")) return;
      }

      const targetText = replayHunks(oldText, newText, hunks, keep);
      // Write through the VSCode file service so watchers stay consistent
      // (raw fs.writeFile bypasses them — pitfall #9).
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(targetText, "utf8"));
      const doc = openDoc ?? (await vscode.workspace.openTextDocument(fileUri));
      await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
      if (doc.isDirty) {
        await vscode.commands.executeCommand("workbench.action.files.revert");
      }
      const revertedCount = keep.filter((k) => !k).length;
      this.deps.toolHunkDecisions(toolCallId, keep, true);
      void vscode.window.showInformationMessage(
        vscode.l10n.t("已回退 {0} 处改动（保留 {1} 处）：{2}", revertedCount, keep.length - revertedCount, chosen),
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        vscode.l10n.t("逐块回退失败：{0}", errorMessage(error)),
      );
    }
  }

  // The four actions below are the narrow surface the panel delegates to;
  // they are thin wrappers so ChatPanel keeps its method signatures (the
  // webview-message switch and tests construct/stub them directly).

  /** Panel delegate target for the message handler's `openDiff` case. */
  async open(toolCallId: string): Promise<void> {
    await this.openToolDiff(toolCallId);
  }

  /** Panel delegate target for `maybeSynthesizeToolDiff`. */
  async synthesize(toolCallId: string): Promise<void> {
    await this.maybeSynthesizeToolDiff(toolCallId);
  }

  /** Panel delegate target for `revertTurnFile`. */
  async revertTurn(sessionId: string, userBlockId: string, key: string): Promise<void> {
    await this.revertTurnFile(sessionId, userBlockId, key);
  }

  /** Panel delegate target for `revertToolDiff` and the hunk path's whole-file fallback. */
  async revertTool(toolCallId: string): Promise<void> {
    await this.revertToolDiff(toolCallId);
  }

  /** Panel delegate target for `applyHunkSelection`. */
  async applyHunks(toolCallId: string, keep: boolean[]): Promise<void> {
    await this.applyHunkSelection(toolCallId, keep);
  }

  /** Panel delegate target for `locateDiffFile` (also used by openLocation). */
  async locate(block: ToolBlock): Promise<string | null> {
    return this.locateDiffFile(block);
  }

  /**
   * Teardown. There are no timers or node handles here; this exists so the
   * panel can hook the service into its (order-sensitive) dispose chain, and
   * so transient per-tool caches are released with the panel. Fire-and-forget
   * diff synthesis started before dispose settles on its own — same as the
   * pre-extraction behavior — but cannot create new cache entries afterwards.
   */
  dispose(): void {
    this.deps.preSnapshots.clear();
    this.deps.toolArgs.clear();
  }
}
