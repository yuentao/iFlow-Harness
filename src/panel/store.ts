/**
 * Host-side session store: owns SessionState, applies protocol events via the
 * shared reducer, and pushes throttled snapshots to the WebView.
 */

import type { SessionNotification, StopReason } from "../acp/protocol.js";
import type { HostToWebview, SessionState } from "../../shared/messages.js";
import {
  applySessionUpdate,
  beginUserPrompt,
  completePrompt,
  setMeta,
} from "../../shared/session-state.js";

export class SessionStore {
  private state: SessionState = {
    blocks: [],
    status: "connecting",
    errorMessage: null,
    stopReason: null,
    sessionId: null,
    modes: null,
    commands: [],
    models: [],
    currentModelId: null,
  };

  private post: (message: HostToWebview) => void;
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly flushIntervalMs: number;

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

  userPrompt(text: string): void {
    beginUserPrompt(this.state, text);
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

  onSessionUpdate(notification: SessionNotification): void {
    applySessionUpdate(this.state, notification);
    // Streaming chunks arrive at high frequency; coalesce into one snapshot.
    this.scheduleFlush();
  }

  promptCompleted(stopReason: StopReason): void {
    completePrompt(this.state, stopReason);
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
    this.post({ type: "snapshot", state: structuredClone(this.state) });
  }

  private flush(): void {
    this.pushSnapshot();
  }
}
