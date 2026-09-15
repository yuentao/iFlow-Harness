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
  clearPendingQuestions,
  completePrompt,
  clearPendingApproval,
  clearPendingPlanExit,
  markToolReverted,
  parseTranscriptJsonl,
  setMeta,
  setPendingApproval,
  setPendingPlanExit,
  setPendingQuestions,
  setSessions,
} from "../../shared/session-state.js";
import type { PendingApprovalUi, PendingPlanExitUi, PendingQuestionsUi } from "../../shared/messages.js";

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
  /**
   * Lowest block index mutated since the last push (null = no reported
   * mutation). The shared reducer returns the index of every block it touches
   * (P-1 follow-up, 2026-09), so mid-list updates — parallel tool calls
   * updating a non-tail card — stay on the incremental path: the patch tail
   * simply starts at the earliest mutated block instead of degrading to a
   * full-transcript snapshot.
   */
  private mutatedFrom: number | null = null;
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
    this.noteMutationIndex(beginUserPrompt(this.state, text, images, files));
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
    this.noteMutationIndex(applySessionUpdate(this.state, notification, options));
    // Streaming chunks arrive at high frequency; coalesce into one snapshot.
    this.scheduleFlush();
  }

  // --- P-1 change detection ---------------------------------------------------

  /**
   * Record the lowest block index mutated by one reducer call (null when the
   * update touched no block). Kept as the running minimum until the next
   * push; `pushSnapshot` re-sends everything from that index on.
   */
  private noteMutationIndex(index: number | null): void {
    if (index === null) return;
    if (this.mutatedFrom === null || index < this.mutatedFrom) this.mutatedFrom = index;
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
    this.mutatedFrom = null;
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

  /** Surface a transient host notice to the WebView (auto-dismissed by the UI).
   * `countdownDeadline` (host epoch-ms) anchors a live countdown in the WebView
   * to the host's actual wait; `durationMs` overrides the auto-dismiss lifetime. */
  sendToast(
    level: "info" | "warning" | "error",
    message: string,
    opts?: { durationMs?: number; countdownDeadline?: number },
  ): void {
    this.post({
      type: "toast",
      level,
      message,
      durationMs: opts?.durationMs,
      countdownDeadline: opts?.countdownDeadline,
    });
  }

  /** Transient host notice without an explicit level (question timeout / skip /
   * cancel reason). Auto-dismissed by the WebView UI. */
  appendNotice(text: string): void {
    this.post({ type: "toast", level: "info", message: text });
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

  /** Surface a Plan-mode exit confirmation to the WebView (immediate flush). */
  showPlanExit(pending: PendingPlanExitUi): void {
    setPendingPlanExit(this.state, pending);
    this.flush();
  }

  /** Answer whether the named plan-exit card was still pending. */
  clearPlanExit(id: string): boolean {
    const cleared = clearPendingPlanExit(this.state, id);
    if (cleared) this.flush();
    return cleared;
  }

  /** Visual marker recording the user's Plan-exit decision (the card is transient). */
  planExitResolutionNote(resolution: string): void {
    this.noteMutationIndex(appendApprovalResolution(this.state, "plan", resolution));
    this.flush();
  }

  /** Surface an ask_user_question card to the WebView (immediate flush). */
  showQuestions(pending: PendingQuestionsUi): void {
    setPendingQuestions(this.state, pending);
    this.flush();
  }

  /** Clear the question card once answered/timed out. */
  clearQuestions(id: string): boolean {
    const cleared = clearPendingQuestions(this.state, id);
    if (cleared) this.flush();
    return cleared;
  }

  approvalResolutionNote(toolName: string, resolution: string): void {
    this.noteMutationIndex(appendApprovalResolution(this.state, toolName, resolution));
    this.flush();
  }

  /** Visual marker for a reverted tool diff. */
  toolReverted(toolCallId: string): boolean {
    const index = markToolReverted(this.state, toolCallId);
    if (index === null) return false;
    this.noteMutationIndex(index);
    this.flush();
    return true;
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

    if (anchorIntact && webviewSynced) {
      // Incremental path: re-send the transcript tail [tailStart, end) — from
      // the earliest block mutated since the last push (the reducer reports
      // every mutation index, so mid-list tool updates stay incremental) —
      // plus the small non-block metadata. Block objects travel by reference;
      // `postMessage` serializes synchronously before we regain control (P-1:
      // the unchanged prefix is never copied, neither host-side nor to the
      // webview).
      // A null `mutatedFrom` with a length drift means an untracked direct
      // mutation of getState().blocks (nothing in the host does this today) —
      // fall back to re-sending from the anchored tail block.
      const tailStart = this.mutatedFrom ?? Math.max(0, this.syncedLen - 1);
      // Runtime strip: Omit<…> is type-level only, a plain spread would
      // smuggle the whole blocks array back into the patch payload.
      const { blocks: _stripped, ...tail } = this.state;
      this.post({
        type: "blockPatch",
        baseVersion: this.blockVersion - 1,
        tailStart,
        blocks: this.mutatedFrom !== null || blocks.length !== this.syncedLen ? blocks.slice(tailStart) : [],
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
    this.mutatedFrom = null;
  }

  private flush(): void {
    this.pushSnapshot();
  }
}
