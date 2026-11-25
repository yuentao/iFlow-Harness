/**
 * SessionPersistenceService — read-only session persistence + independent
 * transcript disk helpers, extracted from `panel.ts` (阶段 3 of the panel
 * split; behavior-preserving refactor).
 *
 * Owns the extension's private per-session transcript store: path construction
 * (both our JSON files and the CLI's interactive jsonl), reading/serializing a
 * single transcript, listing transcript files, the temp+rename atomic write
 * chain, legacy workspaceState migration, and the session-index read/write.
 * `ChatPanel` keeps same-named thin delegates so the webview-message switch,
 * `extension.ts` and every existing test keep the exact same contract.
 *
 * Dependency rule: this module NEVER imports `panel.ts`. It only receives the
 * narrow callback surface below, so it cannot create an import cycle and can
 * be unit-tested without constructing a ChatPanel. The `storageUri ??
 * globalStorageUri` base and the current session cwd are read at CALL TIME
 * through callbacks — never captured as a context snapshot (AGENTS.md pitfall
 * #8: sessionCwd, not process.cwd()). Every path is additionally sanitized to a
 * filesystem-safe charset before it reaches the disk.
 *
 * Note on the filesystem API: this store is extension-private storage, NOT a
 * workspace file, so — exactly as before the extraction — it uses
 * `node:fs/promises` (readFile / readdir / writeFile / mkdir / rename / rm).
 * Trap #9's `workspace.fs` rule applies to agent-driven workspace file writes
 * (which must notify the VSCode file watcher); switching this store to
 * `workspace.fs` would be a behavior change, so it is deliberately preserved.
 *
 * `esbuild.mjs` only bundles `src/extension.ts`, so this file reaches the
 * output solely through the `panel.ts` import below.
 */

import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { readFile, readdir, writeFile, mkdir, rm } from "node:fs/promises";
import type * as vscode from "vscode";
import { errorMessage } from "../acp/jsonrpc.js";
import { renameWithRetry } from "../acp/models-query.js";
import {
  backfillBlockIds,
  parseTranscriptJsonl,
  sortSessionSummaries,
} from "../../shared/session-state.js";
import type { SessionState, SessionSummaryUi } from "../../shared/messages.js";

/** Legacy workspaceState key: transcripts used to live in one monolithic map
 * here (P2 — every persist meant read-all + structuredClone + write-all, and
 * the map grew without bound). Transcripts now persist as per-session JSON
 * files under storageUri; this key survives only as the one-shot migration
 * source and is deleted after migration. Moved here from panel.ts together
 * with `migrateLegacyTranscripts` (single source of truth). */
const TRANSCRIPTS_KEY = "iflow.transcripts";

/** Persisted transcript payload for one session. */
export interface PersistedTranscript {
  label: string;
  blocks: SessionState["blocks"];
}

export interface SessionPersistenceDeps {
  /** Structured log sink (host output channel). */
  log: { info: (message: string) => void; warn: (message: string) => void };
  /** `storageUri ?? globalStorageUri` fsPath, read at call time. */
  getStorageDir(): string;
  /** Current session cwd — the base for the CLI jsonl lookup (pitfall #8). */
  getSessionCwd(): string | null;
  /** workspaceState surface used by the one-shot legacy migration. */
  getWorkspaceState(): vscode.Memento;
  /** Localized "untitled session" label, owned by the panel (l10n source). */
  readonly defaultSessionLabel: string;
  /** Recent-session index key (owned by panel.ts, injected to avoid a cycle). */
  readonly sessionsKey: string;
  /** Active-session pointer key (owned by panel.ts, injected to avoid a cycle). */
  readonly activeSessionKey: string;
  /** Cap on the persisted recent-session index (owned by panel.ts). */
  readonly maxRecentSessions: number;
}

/** Per-process sequence for unique temp file names (pid + seq, same
 * discipline as super-store.ts): two windows writing the same transcript
 * must never share a fixed `${target}.tmp` path. */
let tmpSeq = 0;

export class SessionPersistenceService {
  /** Serializes per-session transcript file writes (P2): overlapping persists
   * must not interleave inside one file's temp+rename sequence. */
  private persistChain: Promise<void> = Promise.resolve();
  /**
   * Transcript writes currently queued or in flight on `persistChain`.
   * `cleanupEmptySession` awaits the chain before the new-session state swap;
   * while that wait is non-trivial the new-session projection must say
   * 「正在等待后台任务结束」 instead of looking frozen (see NewSessionPhase).
   */
  private persistPending = 0;

  constructor(private readonly deps: SessionPersistenceDeps) {}

  // --- Session index (workspaceState) ----------------------------------------

  readPersistedSessions(): SessionSummaryUi[] {
    return this.deps.getWorkspaceState().get<SessionSummaryUi[]>(this.deps.sessionsKey, []);
  }

  async persistSessions(sessions: SessionSummaryUi[], activeId: string | null): Promise<void> {
    // M4 P1-8: canonical order (pinned first, newest activity) on EVERY
    // persist — stored index and rendered list can never drift. The cap
    // drops from the tail, which after sorting means oldest non-pinned
    // first (archived sessions are old by nature, so they leave first).
    const sorted = sortSessionSummaries(sessions);
    await this.deps.getWorkspaceState().update(this.deps.sessionsKey, sorted.slice(0, this.deps.maxRecentSessions));
    await this.deps.getWorkspaceState().update(this.deps.activeSessionKey, activeId);
  }

  // --- Path construction -----------------------------------------------------

  transcriptDir(): string {
    // workspaceState falls back to global state when no workspace is open;
    // mirror that fallback for the file store.
    return path.join(this.deps.getStorageDir(), "transcripts");
  }

  ownTranscriptFileName(sessionId: string): string {
    // Session ids come from the CLI and webview messages — restrict to a
    // filesystem-safe charset so a hostile id cannot escape the directory.
    const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "-");
    return `${safe}.json`;
  }

  ownTranscriptFilePath(sessionId: string): string {
    return path.join(this.transcriptDir(), this.ownTranscriptFileName(sessionId));
  }

  /**
   * Locate the CLI's NDJSON transcript file for a session id. The CLI stores
   * one file per project dir: `~/.iflow/projects/<cwd-as-slug>/session-<id>.jsonl`.
   */
  cliTranscriptFilePath(sessionId: string): string | null {
    const fileBase = sessionId.startsWith("session-") ? sessionId : `session-${sessionId}`;
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const base = path.join(home, ".iflow", "projects");
    const cwdSlug = (this.deps.getSessionCwd() ?? "").replace(/[^A-Za-z0-9-]/g, "-");
    if (cwdSlug) {
      const candidate = path.join(base, cwdSlug, `${fileBase}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
    // Fallback: session ids are globally unique — scan every project dir.
    try {
      for (const dir of readdirSync(base)) {
        const candidate = path.join(base, dir, `${fileBase}.jsonl`);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // projects dir missing
    }
    return null;
  }

  // --- Reads -----------------------------------------------------------------

  /** Read one session's transcript file; null when absent or corrupt. */
  async readTranscript(sessionId: string): Promise<PersistedTranscript | null> {
    try {
      const raw = await readFile(this.ownTranscriptFilePath(sessionId), "utf8");
      const parsed = JSON.parse(raw) as PersistedTranscript;
      if (!Array.isArray(parsed.blocks)) return null;
      return parsed;
    } catch {
      return null; // ENOENT (never persisted) or corrupt (crash mid-write)
    }
  }

  async loadPersistedTranscript(sessionId: string): Promise<{ blocks: SessionState["blocks"]; firstUserText: string | null }> {
    // Source 1: the extension's own persisted copy (ACP mode writes no files).
    const own = await this.readTranscript(sessionId);
    if (own) {
      // P4: files written before block ids existed lack stable keys.
      backfillBlockIds(own.blocks);
      this.deps.log.info(`transcript source: extension store (${own.blocks.length} blocks)`);
      return { blocks: own.blocks, firstUserText: own.label !== this.deps.defaultSessionLabel ? own.label : null };
    }
    // Source 2: the CLI's interactive-mode jsonl (only exists for terminal sessions).
    const file = this.cliTranscriptFilePath(sessionId);
    if (!file) {
      this.deps.log.warn(`no persisted transcript found for ${sessionId}`);
      return { blocks: [], firstUserText: null };
    }
    try {
      const text = await readFile(file, "utf8");
      this.deps.log.info(`transcript source: ${file}`);
      return parseTranscriptJsonl(text);
    } catch (error) {
      this.deps.log.warn(`transcript read failed: ${errorMessage(error)}`);
      return { blocks: [], firstUserText: null };
    }
  }

  /**
   * Transcript file names on disk under the extension's transcript store
   * (for orphan cleanup). Empty when the store directory doesn't exist yet.
   */
  async listOwnTranscriptFileNames(): Promise<string[]> {
    try {
      return await readdir(this.transcriptDir());
    } catch {
      return []; // transcripts dir not created yet
    }
  }

  /** Restorable = the extension holds a transcript OR the CLI wrote a file. */
  hasPersistedTranscript(sessionId: string): boolean {
    if (existsSync(this.ownTranscriptFilePath(sessionId))) return true;
    return this.cliTranscriptFilePath(sessionId) !== null;
  }

  // --- Write helpers ---------------------------------------------------------

  /**
   * Serialize a transcript payload synchronously, at call time. Blocks are
   * mutated in place by the shared reducer; stringifying here captures a
   * coherent snapshot even though the actual file write runs later on the
   * persist chain. (Also replaces the old per-persist structuredClone.)
   */
  serializeTranscript(label: string, blocks: SessionState["blocks"]): string {
    return JSON.stringify({ label, blocks } satisfies PersistedTranscript);
  }

  async writeTranscriptFile(sessionId: string, payload: string): Promise<void> {
    const target = this.ownTranscriptFilePath(sessionId);
    const tmp = `${target}.${process.pid.toString(36)}-${(tmpSeq++).toString(36)}.tmp`;
    await mkdir(this.transcriptDir(), { recursive: true });
    try {
      await writeFile(tmp, payload, "utf8");
      // Atomic replace: retry transient Windows "target is busy" (EPERM /
      // EACCES / EBUSY) instead of losing the write. Same helper/discipline
      // as settings.json (models-query.ts) and memory/files.ts. The target
      // is NEVER unlinked first; on failure we only remove our own tmp.
      await renameWithRetry(tmp, target);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Queue a transcript file write on the persist chain: overlapping persists
   * (e.g. prompt-start seeding and the previous prompt's completion) run
   * back-to-back instead of interleaving inside one file's write sequence.
   * The payload factory runs on the chain (after a setImmediate yield), so
   * the synchronous JSON.stringify no longer sits on the event path (P1).
   */
  enqueueTranscriptWrite(sessionId: string, payloadFactory: () => string): Promise<void> {
    this.persistPending += 1;
    const run = this.persistChain
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(() => this.writeTranscriptFile(sessionId, payloadFactory()));
    this.persistChain = run
      .catch(() => {})
      .finally(() => {
        this.persistPending = Math.max(0, this.persistPending - 1);
      });
    return run;
  }

  async clearTranscript(sessionId: string): Promise<void> {
    await rm(this.ownTranscriptFilePath(sessionId), { force: true });
  }

  // --- Chain introspection (used by the panel's debounce / lifecycle) --------

  /** The live write chain — returned by the debounced `persistActiveTranscript`. */
  currentChain(): Promise<void> {
    return this.persistChain;
  }

  /** Writes queued or in flight — drives the "waiting" new-session phase. */
  pendingWriteCount(): number {
    return this.persistPending;
  }

  /** Settle every queued write before a state swap (swallows write failures). */
  async awaitPersistChain(): Promise<void> {
    await this.persistChain.catch(() => {});
  }

  // --- One-shot legacy migration ---------------------------------------------

  /**
   * P2 migration: move transcripts out of the legacy workspaceState map into
   * per-session files, then delete the legacy key. One-shot; a no-op when
   * the key is absent (fresh installs, already-migrated workspaces).
   */
  async migrateLegacyTranscripts(): Promise<void> {
    const state = this.deps.getWorkspaceState();
    const legacy = state.get<Record<string, PersistedTranscript>>(TRANSCRIPTS_KEY);
    if (!legacy) return;
    for (const [sessionId, transcript] of Object.entries(legacy)) {
      if (!transcript || !Array.isArray(transcript.blocks) || transcript.blocks.length === 0) continue;
      await this.enqueueTranscriptWrite(
        sessionId,
        () => this.serializeTranscript(transcript.label ?? this.deps.defaultSessionLabel, transcript.blocks),
      );
    }
    await state.update(TRANSCRIPTS_KEY, undefined);
    this.deps.log.info(`migrated ${Object.keys(legacy).length} legacy transcript(s) from workspaceState to files`);
  }
}
