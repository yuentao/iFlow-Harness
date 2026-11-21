/**
 * SessionRestoreService — session restore + session-list pruning, extracted
 * from `panel.ts` (阶段 4 of the panel split; behavior-preserving refactor).
 *
 * Owns `restoreSession` (the `session/load` replay / transcript rebuild /
 * state-machine orchestration), its abort checkpoints, and the session-list
 * garbage collection (`pruneUnrestorableSessions` / `refreshSessionList`).
 * `ChatPanel` keeps same-named thin delegates so the webview-message switch,
 * `extension.ts` and every existing test keep the exact same contract.
 *
 * Dependency rule: this module NEVER imports `panel.ts`. It only receives the
 * narrow callback surface below, so it cannot create an import cycle and can
 * be unit-tested without constructing a ChatPanel. Every piece of panel state
 * that is shared with other flows (the restore abort flags / settle handle /
 * replay markers, `sessionCwd`, `disposed`, `historySyncBusy`, the store and
 * the client) is read and written at CALL TIME through callbacks — never
 * captured as a context snapshot (AGENTS.md pitfall #8: sessionCwd, not
 * process.cwd()). Arrow wrappers in the panel preserve `this` binding.
 *
 * Stage 3's `SessionPersistenceService` is injected (never re-instantiated):
 * path construction, transcript reads, the legacy migration and the session
 * index are reused verbatim. The two transcript seams that existing tests
 * stub on the panel (`hasPersistedTranscript` / `loadPersistedTranscript`)
 * are additionally routed through callbacks so those tests keep working.
 *
 * Wire behavior (probed, CLI 0.5.19): `session/load` succeeds but does NOT
 * replay history via `session/update` — the transcript is rebuilt from the
 * CLI's own session file. Checkpoint phase 1 must read the persisted index
 * BEFORE `reassignBlockIds` re-mints ids; phase 2 re-anchors afterwards.
 *
 * `esbuild.mjs` only bundles `src/extension.ts`, so this file reaches the
 * output solely through the `panel.ts` import below.
 */

import path from "node:path";
import { rm, readdir } from "node:fs/promises";
import * as vscode from "vscode";
import type { AcpClient } from "../acp/client.js";
import { errorMessage } from "../acp/jsonrpc.js";
import type { NewSessionMeta, SessionSettings } from "../acp/protocol.js";
import type { SessionState, SessionSummaryUi } from "../../shared/messages.js";
import {
  beginReplay,
  clampSessionLabel,
  endReplay,
  newSessionState,
  reassignBlockIds,
} from "../../shared/session-state.js";
import { CheckpointManager } from "./checkpoints.js";
import type { SessionPersistenceService } from "./session-persistence.js";
import {
  listSuperSessionArchiveFiles,
  listSuperTranscriptFiles,
  readSuperSessionArchive,
  superSessionFileName,
  superSessionsDir,
  superTranscriptFileName,
} from "./super-store.js";

/** Outcome handed to a 新会话 request that joined an in-flight restore. */
export type RestoreOutcome = "aborted" | "completed" | "failed";

/** Cap for abandonedRestoreSessionIds (one entry per abandoned restore). */
const ABANDONED_RESTORE_IDS_CAP = 8;

/** A promise whose resolver is captured by the restore orchestration. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export interface SessionRestoreDeps {
  log: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };

  // --- Panel state shared with the new-session / cancel flows --------------
  isHistorySyncBusy(): boolean;
  isDroppingForReset(): boolean;
  isDisposed(): boolean;
  getSessionCwd(): string | null;
  setSessionCwd(cwd: string): void;
  getWorkspaceRoot(): string | null;
  getExtensionPath(): string;
  isRestoring(): boolean;
  setRestoring(value: boolean): void;
  getRestoringSessionId(): string | null;
  setRestoringSessionId(id: string | null): void;
  getReplayTitle(): string | null;
  setReplayTitle(value: string | null): void;
  isRestoreAbort(): boolean;
  setRestoreAbort(value: boolean): void;
  isPendingNewSession(): boolean;
  setPendingNewSession(value: boolean): void;
  getLastRestoreOutcome(): RestoreOutcome;
  setLastRestoreOutcome(value: RestoreOutcome): void;
  getRestoreSettle(): { promise: Promise<RestoreOutcome>; resolve: (o: RestoreOutcome) => void } | null;
  setRestoreSettle(settle: { promise: Promise<RestoreOutcome>; resolve: (o: RestoreOutcome) => void } | null): void;
  getAbandonedRestoreIds(): Set<string>;
  getContextReportBaseline(): number;
  setContextReportBaseline(value: number): void;
  getPendingSwitchModel(): string | null;
  setPendingSwitchModel(value: string | null): void;
  /** Active-session pointer in workspaceState (prune fallback, pitfall discipline). */
  getWorkspaceActiveSessionId(): string | null;

  // --- Store port (call time) ----------------------------------------------
  getState(): SessionState;
  replaceState(state: SessionState): void;
  setInitializing(value: boolean): void;
  replaceTranscript(blocks: SessionState["blocks"]): void;
  sessionStarted(meta: {
    sessionId: string;
    modes?: SessionState["modes"];
    commands?: SessionState["commands"];
    skills?: SessionState["skills"];
    currentModelId?: string | null;
  }): void;
  markError(message: string): void;
  sendToast(level: "info" | "warning" | "error", message: string): void;
  setSessions(sessions: SessionState["sessions"], activeSessionId?: string | null): void;

  /** Injected stage-3 persistence (path helpers; never new'd here). */
  readonly persistence: SessionPersistenceService;
  /** Stage-3 thin delegates on the panel — test stubs hook here. */
  migrateLegacyTranscripts(): Promise<void>;
  readPersistedSessions(): SessionSummaryUi[];
  persistSessions(sessions: SessionSummaryUi[], activeId: string | null): Promise<void>;
  listOwnTranscriptFileNames(): Promise<string[]>;

  // --- Checkpoint restore wiring (阶段 4 sibling service) ------------------
  loadCheckpointIndex(sessionId: string): Promise<void>;
  finalizeCheckpointIndex(remap: ReadonlyMap<string, string>): void;
  checkpointRoot(): string;

  // --- Panel callbacks ------------------------------------------------------
  clearQqTakeover(): void;
  clearQqRemoteDetachedSessions(): void;
  hasPersistedTranscript(sessionId: string): boolean;
  forgetSession(sessionId: string): Promise<void>;
  ensureClient(): Promise<AcpClient>;
  queryLiveModels(): Promise<SessionState["models"]>;
  publishSuperSessions(): void;
  resetSuperDirectiveScans(): void;
  getMainSessionSettings(addDirs?: readonly string[] | null): SessionSettings;
  /** 多仓库协作：按该会话已存的根集合算出 settings.add_dirs（null = 全量根）。 */
  sessionAddDirsFor(roots: readonly string[] | null): string[] | null;
  /** 多仓库协作：恢复后发布根子集投影（applied = 该会话真实根集合）。 */
  publishWorkspaceRoots(applied?: readonly string[] | null): void;
  loadPersistedTranscript(sessionId: string): Promise<{ blocks: SessionState["blocks"]; firstUserText: string | null }>;
  workspaceModelId(): string | null;
  applyLiveModels(
    models: Promise<SessionState["models"]>,
    client: AcpClient,
    sessionId: string,
    cliModelId: string | null,
  ): void;
  validateModelForPush(
    models: Promise<SessionState["models"]>,
    modelId: string,
    fallback: string | null,
  ): Promise<string | null>;
  setModel(modelId: string): Promise<void>;
  applyThinkLevel(client: AcpClient, sessionId: string, level: SessionState["thinkLevel"]): Promise<void>;
  cleanupEmptySession(sessionId: string | null): Promise<void>;
  recordSession(sessionId: string, label: string | null, roots?: readonly string[] | null): Promise<void>;
  persistActiveTranscript(force?: boolean): void;
  restoreSuperSessions(sessionId: string): Promise<void>;
  postSound(kind: "done" | "error" | "child"): void;
  superStoreDir(): string;
}

export class SessionRestoreService {
  constructor(private readonly deps: SessionRestoreDeps) {}

  /**
   * Restore a persisted session via `session/load`. Wire behavior (CLI
   * 0.5.19): load succeeds (sessionId + modes returned) but the CLI does NOT
   * replay history through `session/update` — the transcript is rebuilt from
   * the CLI's own session file instead.
   */
  async restoreSession(sessionId: string): Promise<boolean> {
    if (this.deps.isHistorySyncBusy()) return false;
    // A3: the panel was disposed — the store is gone.
    if (this.deps.isDisposed()) return false;
    // 远程接续绑定在旧会话上：切走即失效。
    this.deps.clearQqTakeover();
    this.deps.clearQqRemoteDetachedSessions();
    // Fast path: the CLI only persists jsonl transcripts for sessions that
    // actually had a conversation. A "dead" session (auto-created on panel
    // open, never used) would burn 60s+ on new+load for nothing.
    this.deps.setSessionCwd(
      this.deps.getWorkspaceRoot() ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      this.deps.getExtensionPath(),
    );
    if (!this.deps.hasPersistedTranscript(sessionId)) {
      // Dead switcher entry (recorded but never used): clicking it would
      // fail on every attempt and the husk would sit in the list forever —
      // forget it instead. Clicking the LIVE active session (no transcript
      // until its first prompt lands) stays a plain no-op.
      const liveId = this.deps.getState().activeSessionId ?? this.deps.getState().sessionId;
      if (sessionId !== liveId) {
        this.deps.log.warn(`forget dead entry: no persisted transcript for ${sessionId}`);
        await this.deps.forgetSession(sessionId);
      } else {
        this.deps.log.warn(`skip restore: no persisted transcript for ${sessionId}`);
      }
      return false;
    }

    const client = await this.deps.ensureClient();
    // A3: a dispose during the handshake rejects ensureClient with
    // DisposedError; a dispose AFTER it must not write into the destroyed
    // store either.
    if (this.deps.isDisposed()) return false;
    const workspaceRoot = this.deps.getSessionCwd()!;
    const init = client.getInitializeResult();
    if (init && !init.agentCapabilities.loadSession) {
      this.deps.log.warn("loadSession capability not declared by CLI");
      void vscode.window.showWarningMessage(
        vscode.l10n.t("当前内核不支持恢复历史会话"),
      );
      return false;
    }

    // Mutual exclusion: a 新会话 is in flight (initializing) — its
    // session/new can take 30-60s with MCP servers, and running a restore
    // CONCURRENTLY let the replayed updates repopulate the transcript the
    // reset just cleared (user-reported: old content + "正在创建新会话…" +
    // empty-state all on screen). Refuse until the reset settles; the user
    // can retry the restore once the switcher unlocks.
    if (this.deps.getState().initializing || this.deps.isDroppingForReset()) {
      this.deps.log.warn(`restore ${sessionId} refused: a new-session switch is in flight`);
      void vscode.window.showWarningMessage(
        vscode.l10n.t("正在创建新会话，请稍后再恢复历史会话"),
      );
      return false;
    }
    if (this.deps.isRestoring()) return false; // a restore is already in flight

    // Race the /models HTTP query with the probe + loadSession below (it only
    // reads the endpoint from settings.json — independent of the session).
    const modelsPromise = this.deps.queryLiveModels();
    // 多仓库协作：这个会话当初的根集合记在会话索引里（恢复不迁移 cwd，也不
    // 跨根 load）。缺失（旧归档 / 单根）＝全量根，与今天一致。
    const storedRoots = this.deps.readPersistedSessions().find((s) => s.id === sessionId)?.roots ?? null;
    const restoreAddDirs = this.deps.sessionAddDirsFor(storedRoots);
    // An abandoned restore never calls applyLiveModels — keep the rejection
    // handled so the query cannot become an unhandled rejection.
    modelsPromise.catch(() => {});
    // Capture before the state swap: if the switch succeeds, an abandoned
    // empty active session must not linger in the switcher.
    const outgoingId = this.deps.getState().activeSessionId ?? this.deps.getState().sessionId;
    const tRestore = Date.now();
    this.deps.log.info(`restoring session ${sessionId} …`);
    this.deps.setRestoring(true);
    this.deps.setRestoringSessionId(sessionId);
    this.deps.setReplayTitle(null);
    this.deps.setSessionCwd(workspaceRoot!);
    // A fresh attempt: neither an abort request nor a queued 新会话 intent
    // may survive from an earlier restore.
    this.deps.setRestoreAbort(false);
    this.deps.setPendingNewSession(false);
    this.deps.setLastRestoreOutcome("completed");
    // Settle handle — a 新会话 requested while the restore runs waits on it
    // and may ask the restore to abort through `restoreAbort`.
    const settle = deferred<RestoreOutcome>();
    this.deps.setRestoreSettle(settle);
    // This session is being restored FOR REAL: drop the abandoned marker a
    // previous aborted attempt may have left, otherwise its replayed updates
    // would be swallowed by the late-traffic guard.
    this.deps.getAbandonedRestoreIds().delete(sessionId);
    const fresh = newSessionState(this.deps.getState());
    beginReplay(fresh);
    fresh.activeSessionId = sessionId;
    this.deps.replaceState(fresh);
    // 看板跟着主会话走：切到 B 就不能还显示着 A 的历史子会话。
    this.deps.publishSuperSessions();
    // 委派扫描状态也换人：上一个会话的助手文本（以及里面没收口的围栏）、
    // 已派发载荷的账本都跟新会话无关 —— 留着会让新会话的扫描基线落在别人的
    // 文本上，还会把本该重新派发的指令误判成重复。
    this.deps.resetSuperDirectiveScans();
    try {
      // CLI 0.5.19 wire behavior: an empty/short session's loadSession response
      // carries ONLY {sessionId} — no modes, no _meta. A prior session/new does
      // return the full meta, so fetch it first (also warms up the CLI).
      // R4: the probe session itself is deliberately discarded — only its
      // meta/modes are used. The CLI owns that session's lifecycle (ACP-mode
      // sessions are not persisted and die with the CLI process); this is not
      // a leak.
      //
      // Concurrency (probed 2026-11-12 against the vendored CLI,
      // test/fixtures/probe-restore-concurrency.mjs): running the probe
      // `session/new` and the `session/load` CONCURRENTLY on one client is
      // SAFE (both resolve, the loaded session keeps its id, a later load
      // still works, the loaded session still answers a prompt — no
      // crosstalk), but it is NOT meaningfully faster: serial 1541ms/1750ms
      // vs concurrent 1489ms/1574ms — the CLI does the heavy work serially
      // internally, only ~50ms of the ~1.5s overlap. The serial order stays:
      // no measurable win, and the probe's meta/modes ordering stays obvious.
      this.deps.setContextReportBaseline(Date.now());
      const tProbe = Date.now();
      const probe = await client.newSession({
        cwd: workspaceRoot,
        mcpServers: [],
        settings: this.deps.getMainSessionSettings(restoreAddDirs),
      });
      this.deps.log.info(`restore: probe session/new ok in ${Date.now() - tProbe}ms`);
      // Abort checkpoint 1 — nothing has been written to the store yet.
      if (this.abortRestoreIfRequested(sessionId, outgoingId)) return false;
      const probeMeta: NewSessionMeta | undefined = probe._meta;
      const tLoad = Date.now();
      const session = await client.loadSession({
        cwd: workspaceRoot,
        mcpServers: [],
        sessionId,
        settings: this.deps.getMainSessionSettings(restoreAddDirs),
      });
      this.deps.log.info(`restore: session/load ok in ${Date.now() - tLoad}ms`);
      // Abort checkpoint 2 — still nothing written to the store.
      if (this.abortRestoreIfRequested(sessionId, outgoingId)) return false;
      const meta: NewSessionMeta | undefined = probeMeta ?? session._meta;
      const modes = session.modes ?? probe.modes;
      endReplay(this.deps.getState());

      // Rebuild the transcript from the CLI's session file (NDJSON).
      const loadedId = session.sessionId;
      const tTranscript = Date.now();
      const restored = await this.deps.loadPersistedTranscript(loadedId);
      this.deps.log.info(`restore: transcript loaded in ${Date.now() - tTranscript}ms (${restored.blocks.length} blocks)`);
      // Abort checkpoint 3 — the transcript is rebuilt but not yet written.
      if (this.abortRestoreIfRequested(sessionId, outgoingId)) return false;
      if (restored.blocks.length === 0) {
        restored.blocks.push({
          kind: "text",
          text: vscode.l10n.t("已恢复会话。内核没有保存这条会话的历史记录，所以这里看不到之前的消息，但可以继续对话。"),
        });
      }
      // Structural isolation (user directive): a restored transcript carries
      // ids minted by PREVIOUS host lifetimes this process can never know —
      // entering the live array with them collided with fresh minting (404
      // duplicate ids measured). Re-mint every id from THIS host's counter so
      // a restored session shares NOTHING with the live namespace; the
      // original ids stay untouched in the persisted file (lossless).
      // backfillBlockIds (inside loadPersistedTranscript) already seeded the
      // counter past the originals, so the re-mints are collision-free.
      // M3 P0-1 phase 1: the persisted checkpoint index anchors to the
      // ORIGINAL ids (the transcript file is lossless), so read it + reopen
      // the shadow repo BEFORE the re-mint happens.
      const tCheckpoint = Date.now();
      await this.deps.loadCheckpointIndex(loadedId);
      this.deps.log.info(`restore: checkpoint index loaded in ${Date.now() - tCheckpoint}ms`);
      // Abort checkpoint 4 — the LAST await before the first store write
      // (sessionStarted / replaceTranscript). Beyond this point the restore
      // has already committed to the store and can no longer be abandoned;
      // a 新会话 request waits for it to settle instead.
      if (this.abortRestoreIfRequested(sessionId, outgoingId)) return false;
      const preRemintUserIds = restored.blocks
        .filter((b) => b.kind === "user" && b.id)
        .map((b) => b.id as string);
      reassignBlockIds(restored.blocks);
      this.deps.replaceTranscript(restored.blocks);
      // M3 P0-1 phase 2: the re-mint changed every user id in place (same
      // order, same array) — re-anchor the loaded index to the live ids.
      const postRemintUserIds = restored.blocks
        .filter((b) => b.kind === "user" && b.id)
        .map((b) => b.id as string);
      if (preRemintUserIds.length === postRemintUserIds.length) {
        const remap = new Map<string, string>();
        for (let i = 0; i < preRemintUserIds.length; i++) {
          const from = preRemintUserIds[i];
          const to = postRemintUserIds[i];
          if (from && to) remap.set(from, to);
        }
        this.deps.finalizeCheckpointIndex(remap);
      }

      // Model list: same live-endpoint-only source as a fresh session,
      // otherwise the model dropdown would vanish after a restore. Fetched
      // concurrently with probe/loadSession above and late-pushed via
      // applyLiveModels AFTER sessionStarted — a slow endpoint must not stall
      // the already-rebuilt transcript (it paints above before models land).
      // After a profile switch the default model is the one written in the
      // NEW profile (its configured modelName), not the previous endpoint's
      // stale current model (user directive).
      const switchModel = this.deps.getPendingSwitchModel();
      this.deps.setPendingSwitchModel(null);
      const currentModelId =
        switchModel ??
        this.deps.getState().currentModelId ??
        this.deps.workspaceModelId() ??
        meta?.models?.currentModelId ??
        null;

      this.deps.sessionStarted({
        sessionId: loadedId,
        modes,
        commands: meta?.availableCommands ?? [],
        skills: meta?.availableSkills ?? [],
        currentModelId,
      });
      // 多仓库协作：投影这个会话的真实根集合（null → 全量根），让根选择器
      // 如实显示「当前会话用了哪些根」。
      this.deps.publishWorkspaceRoots(storedRoots);
      this.deps.applyLiveModels(modelsPromise, client, loadedId, meta?.models?.currentModelId ?? null);
      // Same wire behavior as startNewSession (probed against CLI 0.5.19
      // bundle): session/new reports the CLI's BOOT-time model because
      // set_model never writes back to Config.model, while the shared
      // contentGeneratorConfig still carries the last dropdown switch.
      // Re-push whenever the panel's selection differs — after validating
      // the selection is still offered by the live endpoint.
      const restoreCliModelId = meta?.models?.currentModelId ?? null;
      const tModel = Date.now();
      if (currentModelId && currentModelId !== restoreCliModelId) {
        const pushId = await this.deps.validateModelForPush(modelsPromise, currentModelId, restoreCliModelId);
        if (pushId) await this.deps.setModel(pushId);
      }
      await this.deps.applyThinkLevel(client, loadedId, this.deps.getState().thinkLevel);
      this.deps.log.info(`restore: model push done in ${Date.now() - tModel}ms`);
      this.deps.log.info(
        `session restored: ${loadedId} (${restored.blocks.length} blocks) in ${Date.now() - tRestore}ms total`,
      );
      await this.deps.cleanupEmptySession(outgoingId);
      await this.deps.recordSession(loadedId, restored.firstUserText ? clampSessionLabel(restored.firstUserText) : null, storedRoots);
      this.deps.persistActiveTranscript(true); // seed the extension-owned copy
      // 该主会话当年派发的子会话（重启后进程已亡，但分支与工作目录还在）：
      // 把它们取回看板，用户才知道有哪些分支等着合并或清理。
      //
      // 单独兜错：看板是**附加信息**，它坏了不能把「会话已恢复」判成失败 ——
      // 那会连带丢掉刚重建好的转录并让用户以为恢复失败。失败可见（toast +
      // 日志）但不阻断（新建会话、继续对话都照常）。
      await this.deps.restoreSuperSessions(loadedId).catch((error: unknown) => {
        this.deps.log.warn(`super agent: 恢复超流体记录失败（不影响会话恢复）：${errorMessage(error)}`);
        this.deps.sendToast(
          "warning",
          vscode.l10n.t("超流体记录恢复失败（不影响会话）：{0}", errorMessage(error)),
        );
      });
      void vscode.window.showInformationMessage(vscode.l10n.t("已恢复会话"));
      return true;
    } catch (error) {
      const message = errorMessage(error);
      endReplay(this.deps.getState());
      this.deps.log.error(`session restore failed: ${message} (after ${Date.now() - tRestore}ms)`);
      this.deps.markError(vscode.l10n.t("会话恢复失败：{0}", message));
      // Async failure — the user is likely in the editor; cue it.
      this.deps.postSound("error");
      // Do NOT forget the session here: the transcript file still exists and
      // the failure is often transient (CLI boot hiccup, endpoint down, auth
      // not ready). Forgetting would drop it from the switcher, and the next
      // pruneUnrestorableSessions would delete the orphaned transcript file —
      // turning a retryable failure into irreversible content loss. The user
      // can still remove it explicitly via the switcher's delete.
      this.deps.setLastRestoreOutcome("failed");
      return false;
    } finally {
      this.deps.setRestoring(false);
      this.deps.setRestoringSessionId(null);
      this.deps.setReplayTitle(null);
      // Release everyone waiting on this restore (a 新会话 request that
      // interrupted it) with the truthful outcome.
      const settleHandle = this.deps.getRestoreSettle();
      this.deps.setRestoreSettle(null);
      settleHandle?.resolve(this.deps.getLastRestoreOutcome());
    }
  }

  /**
   * Abort checkpoint of an in-flight restore.
   *
   * True → the restore was abandoned: the user asked for a 新会话 while the
   * history was still being restored. Every store write of a restore happens
   * AFTER the last checkpoint, so abandoning here leaves the store untouched:
   * no sessionStarted, no replaceTranscript, no applyLiveModels, no
   * restoreSuperSessions, no "已恢复会话" toast. The state is reset to a
   * clean idle (the replay marker must not survive) and the abandoned
   * session id is remembered so its late traffic cannot leak into the fresh
   * session.
   *
   * False → no abort was requested: the restore continues.
   */
  private abortRestoreIfRequested(sessionId: string, outgoingId: string | null): boolean {
    if (!this.deps.isRestoreAbort()) return false;
    // Both flags are set together by the 新会话 flow: the abort REQUEST and
    // the queued INTENT. The restore only gives up when the intent is really
    // there — otherwise the request was stale.
    if (!this.deps.isPendingNewSession()) return false;
    this.deps.setRestoreAbort(false);
    this.deps.setLastRestoreOutcome("aborted");
    // The replayed history of the abandoned session must never reach the
    // store again — even the tail that arrives after the abort.
    const abandoned = this.deps.getAbandonedRestoreIds();
    abandoned.add(sessionId);
    while (abandoned.size > ABANDONED_RESTORE_IDS_CAP) {
      const oldest = abandoned.values().next().value;
      if (oldest === undefined) break;
      abandoned.delete(oldest);
    }
    // Clean idle: the replay marker (status "streaming" + replaying) must not
    // survive the abandoned restore, and the switcher must point back at the
    // session we came from (the 新会话 flow cleans THAT one up).
    const state = this.deps.getState();
    endReplay(state);
    state.sessionId = null;
    state.activeSessionId = outgoingId;
    this.deps.setInitializing(false);
    this.deps.replaceState(state);
    this.deps.log.warn(`session restore of ${sessionId} abandoned: the user asked for a 新会话`);
    return true;
  }

  /**
   * Drop persisted sessions the CLI has no transcript for (auto-created but
   * never used). Returns the surviving list (already persisted). Orphaned
   * transcript files (session forgotten/dead, file left behind) are deleted.
   */
  async pruneUnrestorableSessions(): Promise<SessionSummaryUi[]> {
    this.deps.setSessionCwd(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.deps.getExtensionPath(),
    );
    // Migrate BEFORE filtering: hasPersistedTranscript is file-based now, and
    // unmigrated transcripts would otherwise look unrestorable.
    await this.deps.migrateLegacyTranscripts();
    const before = this.deps.readPersistedSessions();
    // The CURRENTLY ACTIVE session must never be pruned: a panel-open
    // auto-session has no transcript until its first prompt lands. Dropping
    // it from the list here poisons the state — the user then chats into a
    // session the switcher no longer contains, nothing ever re-adds it, and
    // the orphan cleanup below deletes its transcript file on the next
    // refresh (close / profile switch) = total content loss.
    const liveActiveId = this.deps.getState().activeSessionId;
    const kept = before.filter((s) => this.deps.hasPersistedTranscript(s.id) || s.id === liveActiveId);
    if (kept.length !== before.length) {
      this.deps.log.info(`pruned ${before.length - kept.length} unrestorable session(s)`);
    }
    // P2: drop transcript files whose session is no longer in the list —
    // the old workspaceState map could only grow; the per-session files get
    // garbage-collected here instead. Filename-based comparison: the on-disk
    // name is the sanitized id, so kept ids must go through the same mapping.
    const keptFileNames = new Set(kept.map((s) => this.deps.persistence.ownTranscriptFileName(s.id)));
    for (const name of await this.deps.listOwnTranscriptFileNames()) {
      if (name.endsWith(".json") && !keptFileNames.has(name)) {
        await rm(path.join(this.deps.persistence.transcriptDir(), name), { force: true });
      }
    }
    // Same garbage collection for the Super Agent child-session archives: an
    // archive whose session left the list is pure residue — nothing would
    // ever read it again, and leaving it behind resurrects the dead session's
    // children (and their unmerged branches) on the next restore.
    const superDir = this.deps.superStoreDir();
    const keptArchiveNames = new Set(kept.map((s) => superSessionFileName(s.id)));
    for (const name of await listSuperSessionArchiveFiles(superDir)) {
      // 归档本体（<name>.json）与损坏备份（<name>.json.corrupt）都要 GC。
      // 备份名是归档名再加 .corrupt：剥掉后缀后按同一份 kept 集合比对——
      // 正常归档（含仍归属的会话）一律不动，只有其会话已离开列表的残留
      // 才回收，避免误删正在用的归档或把备份当独立会话。
      const isBackup = name.endsWith(".corrupt");
      const archiveName = isBackup ? name.slice(0, -".corrupt".length) : name;
      if ((isBackup || archiveName.endsWith(".json")) && !keptArchiveNames.has(archiveName)) {
        await rm(path.join(superSessionsDir(superDir), name), { force: true });
      }
    }
    // 转录快照按 childId 放在 transcripts/ 子目录（新文件放子目录必须显式
    // GC，否则永久残留）。转录按 childId 命名，无法直接与主会话列表比；先从
    // 仍归属的归档里取出全部子会话 id，再回收不在其中的快照。归档读不出来
    // 时按空处理（损坏归档已由 restoreSuperSessions 单独提示），绝不误删
    // 仍归属会话的转录。
    const keptChildIds = new Set<string>();
    for (const session of kept) {
      const archive = await readSuperSessionArchive(superDir, session.id);
      for (const child of archive.sessions) keptChildIds.add(child.id);
    }
    const keptTranscriptNames = new Set([...keptChildIds].map((id) => superTranscriptFileName(id)));
    const transcriptsDir = path.join(superSessionsDir(superDir), "transcripts");
    for (const name of await listSuperTranscriptFiles(superDir)) {
      if (name.endsWith("-transcript.json") && !keptTranscriptNames.has(name)) {
        await rm(path.join(transcriptsDir, name), { force: true });
      }
    }
    // M3 P0-1: same garbage collection for shadow-repo dirs — a checkpoint
    // store whose session left the list is pure residue (dirs are keyed by
    // the same sanitized id as the transcript files, minus the extension).
    const keptDirNames = new Set(kept.map((s) => CheckpointManager.safeSessionId(s.id)));
    try {
      for (const name of await readdir(this.deps.checkpointRoot())) {
        if (!keptDirNames.has(name)) {
          await rm(path.join(this.deps.checkpointRoot(), name), { recursive: true, force: true });
        }
      }
    } catch {
      // ENOENT: no session ever captured a checkpoint — nothing to prune.
    }
    const activeId = this.deps.getState().activeSessionId
      ?? this.deps.getWorkspaceActiveSessionId()
      ?? kept[0]?.id
      ?? null;
    await this.deps.persistSessions(kept, kept.some((s) => s.id === activeId) ? activeId : kept[0]?.id ?? null);
    return kept;
  }

  /**
   * Background refresh of the recent-session switcher: prune unrestorable
   * entries, then push the list WITHOUT touching activeSessionId (used after
   * a fresh session start — the new session must stay active).
   */
  async refreshSessionList(): Promise<void> {
    this.deps.setSessionCwd(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.deps.getExtensionPath(),
    );
    const kept = await this.pruneUnrestorableSessions();
    const activeId = this.deps.getState().activeSessionId;
    this.deps.setSessions(kept, activeId);
  }
}
