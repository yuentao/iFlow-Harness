/**
 * Host-side session store: owns SessionState, applies protocol events via the
 * shared reducer, and pushes throttled snapshots to the WebView.
 */

import type { SessionNotification, StopReason } from "../acp/protocol.js";
import type {
  AuthUiState,
  Block,
  HostToWebview,
  SessionState,
} from "../../shared/messages.js";
import { initialSessionState } from "../../shared/messages.js";
import {
  appendApprovalResolution,
  applySessionUpdate,
  beginUserPrompt,
  completePrompt,
  clearPendingApproval,
  markToolReverted,
  parseTranscriptJsonl,
  setMeta,
  setPendingApproval,
  setSessions,
} from "../../shared/session-state.js";
import type { PendingApprovalUi } from "../../shared/messages.js";

export class SessionStore {
  private state: SessionState = initialSessionState();

  private post: (message: HostToWebview) => void;
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly flushIntervalMs: number;
  /** Fired whenever the state changed materially (status bar, M5). */
  onStateChange: ((state: SessionState) => void) | null = null;

  // --- P-1 incremental snapshot bookkeeping ---------------------------------
  /**
   * Version anchor for the webview transcript, bumped once per pushed message
   * (full snapshot or block patch). Full snapshots stamp it into
   * `state.blockVersion`; patches reference it as `baseVersion`. A mismatch
   * makes the webview request a full re-sync via `ready`.
   */
  private blockVersion = 0;
  /** Any transcript-block mutation happened since the last push. */
  private dirty = false;
  /**
   * Every mutation since the last push was confined to the transcript tail
   * (verified by tail fingerprints — the reducer mutates blocks in place, so
   * mid-list changes are invisible to fingerprints and conservatively clear
   * this flag, falling back to a full snapshot).
   */
  private tailOnly = true;
  /** Array identity the webview's transcript is anchored to. */
  private syncedBlocks: Block[] | null = null;
  /** Transcript length the webview is anchored to. */
  private syncedLen = 0;
  /** blockVersion the webview's transcript is anchored to. */
  private syncedVersion = 0;

  constructor(options: {
    post: (message: HostToWebview) => void;
    flushIntervalMs?: number;
    /** vscode.env.language, forwarded with snapshots for webview i18n. */
    language?: string;
  }) {
    this.post = options.post;
    this.flushIntervalMs = options.flushIntervalMs ?? 80;
    this.language = options.language;
  }

  private readonly language: string | undefined;

  getState(): SessionState {
    return this.state;
  }

  /** Replace the whole state object (e.g. new session) and flush immediately. */
  replaceState(state: SessionState): void {
    this.state = state;
    this.flush();
  }

  markConnected(): void {
    this.state.status = "idle";
    this.flush();
  }

  markError(message: string): void {
    this.state.status = "error";
    this.state.errorMessage = message;
    this.flush();
  }

  /** Back to the splash state (profile-switch reconnect: old CLI is down, new one booting). */
  markConnecting(): void {
    this.state.status = "connecting";
    this.flush();
  }

  userPrompt(text: string, images?: string[], files?: { name: string; path: string }[]): void {
    const before = this.captureTail();
    beginUserPrompt(this.state, text, images, files);
    this.noteMutation(before, this.captureTail());
    this.flush();
  }

  sessionStarted(meta: { sessionId: string; models?: SessionState["models"]; currentModelId?: string | null; commands?: SessionState["commands"]; modes?: SessionState["modes"] }): void {
    setMeta(this.state, meta);
    this.flush();
  }

  sessionMeta(meta: Parameters<typeof setMeta>[1]): void {
    setMeta(this.state, meta);
    this.flush();
  }

  onSessionUpdate(notification: SessionNotification, options: { replaying?: boolean } = {}): void {
    const before = this.captureTail();
    applySessionUpdate(this.state, notification, options);
    const after = this.captureTail();
    this.noteMutation(before, after);
    // Streaming chunks arrive at high frequency; coalesce into one snapshot.
    this.scheduleFlush();
  }

  // --- P-1 change detection ---------------------------------------------------

  /**
   * Cheap fingerprint of the transcript tail. `id` is the tail block's
   * identity (kind + toolCallId/agentId); `fp` adds content sizes, so
   * in-place growth of the same block changes `fp` but not `id`.
   */
  private captureTail(): { len: number; id: string; fp: string } {
    const blocks = this.state.blocks;
    const last = blocks[blocks.length - 1];
    if (!last) return { len: 0, id: "", fp: "" };
    switch (last.kind) {
      case "text":
      case "thought":
      case "user":
        return {
          len: blocks.length,
          id: last.kind,
          fp: `${last.kind}:${last.text.length}:${last.kind === "user" ? last.images?.length ?? 0 : 0}`,
        };
      case "tool":
        return {
          len: blocks.length,
          id: `tool:${last.toolCallId}`,
          fp: `tool:${last.toolCallId}:${last.status}:${last.output.length}:${last.diff ? last.diff.newText?.length ?? 0 : -1}`,
        };
      case "subagent":
        return {
          len: blocks.length,
          id: `subagent:${last.agentId}`,
          fp: `subagent:${last.agentId}:${last.status}:${last.entries.length}`,
        };
      case "compression":
        return {
          len: blocks.length,
          id: "compression",
          fp: `compression:${last.notice.length}:${last.summary?.length ?? -1}`,
        };
      case "plan":
        return { len: blocks.length, id: "plan", fp: `plan:${last.entries.length}` };
    }
  }

  /**
   * Classify one batch of in-place block mutations (the reducer mutates
   * `state.blocks` directly; tail fingerprints are the only change signal).
   *
   * - len +1: a block was appended → tail-only (the reducer appends exactly
   *   one block per update; a bigger jump means a wholesale swap).
   * - same len, same fingerprint: ambiguous — could be a metadata-only update
   *   OR a mid-list mutation invisible to the tail fingerprint → dirty but
   *   NOT tail-only (the full push re-anchors; correct on both sides).
   * - same len, different fingerprint: the tail mutated in place iff `id`
   *   matches (text growth, tool status/output change, SubAgent entries);
   *   an id flip is conservative.
   * - both empty: metadata-only update, blocks untouched.
   */
  private noteMutation(
    before: { len: number; id: string; fp: string },
    after: { len: number; id: string; fp: string },
  ): void {
    if (after.len !== before.len) {
      this.dirty = true;
      this.tailOnly = this.tailOnly && after.len === before.len + 1;
      return;
    }
    if (after.fp === before.fp) {
      if (before.fp !== "") {
        this.dirty = true;
        this.tailOnly = false;
      }
      return;
    }
    this.dirty = true;
    this.tailOnly = this.tailOnly && before.id !== "" && before.id === after.id;
  }

  /**
   * Invalidate the webview's sync anchor so the next push is a full snapshot.
   * Called when the anchor's precondition breaks (state replaced, transcript
   * swapped, webview recreated).
   */
  resync(): void {
    this.syncedBlocks = null;
    this.syncedLen = 0;
    this.syncedVersion = 0;
    this.tailOnly = false;
  }

  /** Replace the recent-session switcher list (M4). */
  setSessions(sessions: SessionState["sessions"], activeSessionId?: string | null): void {
    setSessions(this.state, sessions);
    if (activeSessionId !== undefined) this.state.activeSessionId = activeSessionId;
    this.flush();
  }

  /** Swap in a restored transcript (M4: rebuilt from the CLI session file). */
  replaceTranscript(blocks: SessionState["blocks"]): void {
    this.state.blocks = blocks;
    this.flush();
  }

  promptCompleted(stopReason: StopReason): void {
    completePrompt(this.state, stopReason);
    this.flush();
  }

  /** Surface an approval request to the WebView (immediate flush, no throttle). */
  showApproval(approval: PendingApprovalUi): void {
    setPendingApproval(this.state, approval);
    this.flush();
  }

  /** Answer whether the named approval card was still pending. */
  clearApproval(id: string): boolean {
    const cleared = clearPendingApproval(this.state, id);
    if (cleared) this.flush();
    return cleared;
  }

  approvalResolutionNote(toolName: string, resolution: string): void {
    const before = this.captureTail();
    appendApprovalResolution(this.state, toolName, resolution);
    this.noteMutation(before, this.captureTail());
    this.flush();
  }

  /** Visual marker for a reverted tool diff. */
  toolReverted(toolCallId: string): boolean {
    const before = this.captureTail();
    const ok = markToolReverted(this.state, toolCallId);
    if (ok) {
      this.noteMutation(before, this.captureTail());
      this.flush();
    }
    return ok;
  }

  /** True while `session/new` is in flight; the webview locks switches. */
  setInitializing(initializing: boolean): void {
    this.state.initializing = initializing;
    this.flush();
  }

  /** Update the auth setup banner / form state (M3). */
  setAuth(auth: AuthUiState): void {
    this.state.auth = auth;
    this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.pushSnapshot();
    }, this.flushIntervalMs);
  }

  /** Push to the webview: incremental tail patch when safe, full snapshot otherwise. */
  pushSnapshot(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.onStateChange?.(this.state);

    const blocks = this.state.blocks;
    // Same array identity and monotonic growth — the reducer never removes
    // blocks, and swaps (replaceState/replaceTranscript) change the identity.
    const anchorIntact = this.syncedBlocks === blocks && blocks.length >= this.syncedLen;
    const webviewSynced = this.syncedVersion > 0 && this.syncedVersion === this.blockVersion;
    this.blockVersion++;
    this.state.blockVersion = this.blockVersion; // wire anchor stamp

    if (this.tailOnly && anchorIntact && webviewSynced) {
      // Incremental path: re-send the transcript tail [syncedLen-1, end) —
      // the anchored tail block (possibly mutated in place) plus every block
      // appended since the last push — and the small non-block metadata.
      // Block objects travel by reference; `postMessage` serializes
      // synchronously before we regain control (P-1: the unchanged prefix is
      // never copied, neither host-side nor to the webview).
      const tailStart = Math.max(0, this.syncedLen - 1);
      // Runtime strip: Omit<…> is type-level only, a plain spread would
      // smuggle the whole blocks array back into the patch payload.
      const { blocks: _stripped, ...tail } = this.state;
      this.post({
        type: "blockPatch",
        baseVersion: this.blockVersion - 1,
        tailStart,
        // Untracked direct mutations of getState().blocks (nothing in the
        // host does this today) show up as a length drift without `dirty` —
        // re-send the tail instead of trusting the dirty flag alone.
        blocks: this.dirty || blocks.length !== this.syncedLen ? blocks.slice(tailStart) : [],
        tail,
      });
      this.syncedLen = blocks.length;
      this.syncedVersion = this.blockVersion;
    } else {
      // Full path: one state-shell copy; blocks are carried by reference —
      // the wire serialization happens inside `postMessage` (synchronous),
      // so no `structuredClone` is needed here (P-1).
      this.post({
        type: "snapshot",
        state: { ...this.state },
        locale: this.language,
      });
      this.syncedBlocks = blocks;
      this.syncedLen = blocks.length;
      this.syncedVersion = this.blockVersion;
    }
    this.dirty = false;
    this.tailOnly = true;
  }

  private flush(): void {
    this.pushSnapshot();
  }
}
