/**
 * Host-side session store: owns SessionState, applies protocol events via the
 * shared reducer, and pushes throttled snapshots to the WebView.
 */

import type { SessionNotification, StopReason } from "../acp/protocol.js";
import type { AuthUiState, HostToWebview, SessionState } from "../../shared/messages.js";
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

  constructor(options: { post: (message: HostToWebview) => void; flushIntervalMs?: number }) {
    this.post = options.post;
    this.flushIntervalMs = options.flushIntervalMs ?? 80;
  }

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

  userPrompt(text: string, images?: string[]): void {
    beginUserPrompt(this.state, text, images);
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
    applySessionUpdate(this.state, notification, options);
    // Streaming chunks arrive at high frequency; coalesce into one snapshot.
    this.scheduleFlush();
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
    appendApprovalResolution(this.state, toolName, resolution);
    this.flush();
  }

  /** Visual marker for a reverted tool diff. */
  toolReverted(toolCallId: string): boolean {
    const ok = markToolReverted(this.state, toolCallId);
    if (ok) this.flush();
    return ok;
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

  /** Immediately push a structured-clone snapshot to the webview. */
  pushSnapshot(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.onStateChange?.(this.state);
    this.post({ type: "snapshot", state: structuredClone(this.state) });
  }

  private flush(): void {
    this.pushSnapshot();
  }
}
