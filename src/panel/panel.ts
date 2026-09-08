/**
 * Chat panel: owns the AcpClient lifecycle and the WebView. Host-side routing:
 * WebView messages → ACP calls; ACP events → store → throttled snapshots.
 */

import * as vscode from "vscode";
import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile, readdir, writeFile, mkdir, rm, rename } from "node:fs/promises";
import { AcpClient } from "../acp/client.js";
import { errorMessage } from "../acp/jsonrpc.js";
import { buildAcpCommand, locateIflowEntry } from "../acp/cli-locator.js";
import { queryModelIds, readActiveEndpoint } from "../acp/models-query.js";
import {
  clearCredentials,
  getActiveProfileName,
  loadCredentials,
  loadProfiles,
  maskKey,
  saveCredentials,
  saveProfiles,
  setActiveProfileName,
  validateCredentials,
  type OpenAiCompatCredentials,
} from "../acp/auth.js";
import { readCliSettings } from "../acp/models-query.js";
import type { AuthUiState } from "../../shared/messages.js";
import type {
  ContentBlock,
  NewSessionMeta,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "../acp/protocol.js";
import type { PendingApprovalUi, SessionState, SessionSummaryUi, ToolBlock, WebviewToHost } from "../../shared/messages.js";
import {
  backfillBlockIds,
  beginReplay,
  endReplay,
  newSessionState,
  parseTranscriptJsonl,
  setSessions,
} from "../../shared/session-state.js";
import { SessionStore } from "./store.js";

const WEBVIEW_DIST = "webview/dist/index.html";
/** User answer window for a tool-approval card. */
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
/** Hard cap on how long the @iflow participant waits for a prompt to finish
 * (P3). The wait loop ends on idle/error/cancel; this timeout is the last
 * resort if none of those ever fire. */
const CHAT_FORWARD_TIMEOUT_MS = 10 * 60_000;
/** Cap on base64 payload of an openImage attachment (~6MB decoded) — a
 * webview-supplied data URL is untrusted input; an oversized one must be
 * rejected before it is materialized to disk. */
const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** workspaceState key: recent sessions for this workspace (M4). */
const SESSIONS_KEY = "iflow.recentSessions";
/** workspaceState key: session id to restore on panel open (M4). */
const ACTIVE_SESSION_KEY = "iflow.activeSessionId";
/** Cap on the per-workspace recent-session list. */
const MAX_RECENT_SESSIONS = 20;
/** Label until the first user prompt names the session. */
const DEFAULT_SESSION_LABEL = vscode.l10n.t("（无标题会话）");
/** Legacy workspaceState key: transcripts used to live in one monolithic map
 * here (P2 — every persist meant read-all + structuredClone + write-all, and
 * the map grew without bound). Transcripts now persist as per-session JSON
 * files under storageUri; this key survives only as the one-shot migration
 * source and is deleted after migration. */
const TRANSCRIPTS_KEY = "iflow.transcripts";

/** Persisted transcript payload for one session. */
interface PersistedTranscript {
  label: string;
  blocks: SessionState["blocks"];
}

interface PanelServices {
  entryOverride?: string | undefined;
}

export class ChatPanel implements vscode.Disposable {
  public static readonly viewId = "iflow.chatPanel";

  private editorPanel: vscode.WebviewPanel | undefined;
  private client: AcpClient | null = null;
  private store: SessionStore;
  private connecting: Promise<void> | null = null;
  private disposed = false;
  /** Diagnostics trail visible in the Output panel (helps locate connect issues). */
  private readonly log: vscode.LogOutputChannel;
  /** M5: agent status at a glance (idle / streaming / approval / error + model). */
  private readonly statusBar: vscode.StatusBarItem;
  /** cwd the current ACP session was created with (base for relative paths). */
  private sessionCwd: string | null = null;
  /** Awaiting user answers for `session/request_permission`, keyed by approval id. */
  private readonly pendingApprovals = new Map<
    string,
    {
      options: PermissionOption[];
      toolName: string;
      resolve: (response: RequestPermissionResponse) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private approvalSeq = 0;
  /** Serializes per-session transcript file writes (P2): overlapping persists
   * must not interleave inside one file's temp+rename sequence. */
  private persistChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly services: PanelServices = {},
  ) {
    this.log = vscode.window.createOutputChannel(vscode.l10n.t("心流·驭光"), { log: true });
    this.store = new SessionStore({ post: (m) => this.postToWebview(m), language: vscode.env.language });
    this.store.onStateChange = (state) => this.updateStatusBar(state);
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBar.command = "iflow.openPanel";
    this.statusBar.tooltip = vscode.l10n.t("心流·驭光 — 点击打开聊天面板");
    // Let the panel follow the editor color theme (the webview ignores this
    // once the user picked a theme manually).
    this.context.subscriptions.push(
      vscode.window.onDidChangeActiveColorTheme(() => this.postTheme()),
    );
    // Status bar entry is the always-visible launcher (no sidebar view anymore).
    this.statusBar.show();
  }

  private updateStatusBar(state: SessionState): void {
    const model = state.currentModelId ? ` · ${state.currentModelId}` : "";
    const mode = state.modes ? ` · ${state.modes.currentModeId}` : "";
    let text: string;
    let background: vscode.ThemeColor | undefined;
    switch (state.status) {
      case "connecting":
        text = `$(sync~spin) iFlow${model}`;
        break;
      case "streaming":
        text = `$(sync~spin) iFlow: ${vscode.l10n.t("生成中")}${model}`;
        break;
      case "error":
        text = `$(error) iFlow: ${vscode.l10n.t("出错")}${model}`;
        background = new vscode.ThemeColor("statusBarItem.errorBackground");
        break;
      default:
        text = state.pendingApproval
          ? `$(bell) iFlow: ${vscode.l10n.t("等待审批")}${model}`
          : `$(check) iFlow${mode}${model}`;
        background = state.pendingApproval
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
    }
    if (this.statusBar.text !== text || this.statusBar.backgroundColor !== background) {
      this.statusBar.text = text;
      this.statusBar.backgroundColor = background;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelAllApprovals(vscode.l10n.t("扩展已停用"));
    void this.client?.dispose();
    this.client = null;
    this.editorPanel?.dispose();
    this.editorPanel = undefined;
    this.statusBar.dispose();
    this.log.dispose();
  }

  // --- Editor-tab container (WebviewPanel) ------------------------------------
  // The chat lives in a wide, resizable editor tab opened via `openEditorTab`
  // (command palette / status bar / editor title icon). There is no sidebar
  // view: VSCode always opens a view in the sidebar, which is too narrow as
  // the primary surface.

  /** Open (or reveal) the chat as an editor tab with a generous width. */
  openEditorTab(): void {
    if (this.editorPanel) {
      void this.editorPanel.reveal(undefined, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "iflow.chatEditor",
      vscode.l10n.t("心流·驭光"),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        localResourceRoots: [this.context.extensionUri],
        retainContextWhenHidden: true,
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "media", "iflow.svg");
    this.editorPanel = panel;
    this.wireWebview(panel.webview);
    panel.onDidDispose(
      () => {
        if (this.editorPanel === panel) this.editorPanel = undefined;
      },
      null,
      this.context.subscriptions,
    );
    this.postSnapshot();
    this.postTheme();
    void this.ensureClient().catch((error) => {
      this.log.error("initial connect failed", errorMessage(error));
    });
  }

  /** Shared webview setup. */
  private wireWebview(webview: vscode.Webview): void {
    webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    webview.html = this.buildHtml(webview);
    webview.onDidReceiveMessage((msg: WebviewToHost) => void this.handleWebviewMessage(msg));
  }

  private buildHtml(webview: vscode.Webview): string {
    const absIndex = this.context.asAbsolutePath(WEBVIEW_DIST);
    let raw: string;
    try {
      raw = readFileSync(absIndex, "utf8");
    } catch {
      return `<html><body><h3>webview assets missing</h3><p>Run <code>npm run build</code> in iflow-harness/</p></body></html>`;
    }
    const nonce = Array.from({ length: 24 }, () => Math.random().toString(36).slice(2)).join("");
    // Rewrite relative asset refs (./assets/...) to webview URIs, then nonce scripts.
    const rewritten = raw.replace(/(src|href)="\.?\/?(assets\/[^"]+)"/g, (_m, attr: string, rel: string) => {
      const uri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "webview", "dist", rel));
      return `${attr}="${uri}"`;
    });
    const withNonce = rewritten.replace(/<script/g, `<script nonce="${nonce}"`);
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");
    // The built index.html already has <html>/<head>/<body>; inject CSP as the first head child.
    return withNonce.replace("<head>", `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);
  }

  /**
   * M5: @iflow chat participant — run a prompt through the shared session and
   * return the assistant text produced this turn (text-only fallback).
   */
  async chatForward(prompt: string, token: vscode.CancellationToken): Promise<string> {
    const stateBefore = this.store.getState();
    const textCountBefore = stateBefore.blocks.filter((b) => b.kind === "text").length;
    // sendPrompt never rejects (it catches internally and marks the store
    // error) — a failure surfaces here as status "error", which ends the
    // wait below (P3/R2: only "idle" was checked before, so a failed prompt
    // hung this promise and the participant forever).
    void this.sendPrompt(prompt);
    // Wait for completion (idle), failure (error), cancellation or timeout,
    // polling the small store.
    await new Promise<void>((resolve) => {
      let done = false;
      let cancelSent = false;
      let pollTimer: NodeJS.Timeout | null = null;
      let timeoutTimer: NodeJS.Timeout | null = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (pollTimer) clearInterval(pollTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        resolve();
      };
      timeoutTimer = setTimeout(finish, CHAT_FORWARD_TIMEOUT_MS);
      pollTimer = setInterval(() => {
        if (token.isCancellationRequested) {
          // P3: send cancel exactly once — the old loop re-sent it on every
          // 200ms tick. Ending the wait does not kill the prompt in the
          // panel; cancel here does (the user asked for it).
          if (!cancelSent) {
            cancelSent = true;
            const sessionId = this.store.getState().sessionId;
            if (sessionId) this.client?.cancel(sessionId);
          }
          finish();
          return;
        }
        const status = this.store.getState().status;
        if (status === "idle" || status === "error") finish();
      }, 200);
    });
    const blocks = this.store.getState().blocks;
    const newTexts = blocks.filter((b) => b.kind === "text").slice(textCountBefore);
    return newTexts.map((b) => (b.kind === "text" ? b.text : "")).join("\n").trim() || vscode.l10n.t("（本轮无文本输出）");
  }

  // --- Editor selection entry points (M5) ---------------------------------------

  /** Right-click "Ask iFlow": send the selection as a prompt immediately. */
  async askSelection(relPath: string, range: string, code: string): Promise<void> {
    await vscode.commands.executeCommand("iflow.chatPanel.focus");
    const prompt = [
      vscode.l10n.t("请解释/处理这段代码（`{0}:{1}`）：", relPath, range),
      "",
      "```",
      code,
      "```",
    ].join("\n");
    await this.sendPrompt(prompt);
  }

  /** Right-click "Add to iFlow Context": prefill the composer for editing. */
  addToContext(relPath: string, range: string, code: string): void {
    void vscode.commands.executeCommand("iflow.chatPanel.focus");
    const draft = [
      vscode.l10n.t("关于 `{0}:{1}`：", relPath, range),
      "",
      "```",
      code,
      "```",
      "",
    ].join("\n");
    this.postToWebview({ type: "setDraft", text: draft });
  }

  // --- WebView message routing -------------------------------------------------

  private async handleWebviewMessage(msg: WebviewToHost): Promise<void> {
    this.log.trace(`webview → host: ${msg.type}`);
    switch (msg.type) {
      case "ready":
        // The webview (re)booted and lost its transcript anchor: resync()
        // forces the next push to be a full snapshot (P-1 blockPatch would
        // apply on top of a transcript the webview no longer holds).
        this.store.resync();
        this.store.pushSnapshot();
        break;
      case "sendPrompt":
        await this.sendPrompt(msg.text, msg.images);
        break;
      case "cancel":
        this.client?.cancel(this.store.getState().sessionId ?? "");
        break;
      case "newSession":
        await this.startNewSession();
        break;
      case "setMode":
        await this.setMode(msg.modeId);
        break;
      case "setModel":
        await this.setModel(msg.modelId);
        break;
      case "openLocation": {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(msg.path));
        const line = Math.max(0, (msg.line ?? 1) - 1);
        await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0) });
        break;
      }
      case "openExternal":
        if (/^https?:\/\//.test(msg.uri)) {
          await vscode.env.openExternal(vscode.Uri.parse(msg.uri));
        }
        break;
      case "revealOutput":
        void msg;
        break;
      case "respondApproval":
        this.handleApprovalResponse(msg.id, msg.optionId);
        break;
      case "revertTool":
        await this.revertToolDiff(msg.toolCallId);
        break;
      case "openDiff":
        await this.openToolDiff(msg.toolCallId);
        break;
      case "searchFiles":
        void this.searchWorkspaceFiles(msg.requestId, msg.query);
        break;
      case "openImage":
        void this.openImageAttachment(msg.dataUrl);
        break;
      case "saveAuth":
        await this.saveAuthAndReconnect(msg.baseUrl, msg.apiKey, msg.modelName, msg.profileName ?? null);
        break;
      case "clearAuth":
        await clearCredentials(this.context.secrets);
        this.store.setAuth(await this.buildAuthState(false, true));
        break;
      case "activateProfile":
        await this.activateProfile(msg.name);
        break;
      case "deleteProfile":
        await this.deleteProfile(msg.name);
        break;
      case "loadSession":
        await this.restoreSession(msg.sessionId);
        break;
      case "deleteSession":
        await this.deleteSession(msg.sessionId);
        break;
    }
  }

  private postToWebview(message: unknown): void {
    // Single container: the editor tab. Snapshots/theme/etc. all go here.
    if (this.editorPanel) void this.editorPanel.webview.postMessage(message);
  }

  private postSnapshot(): void {
    // Delegate to the store: it stamps `blockVersion` and maintains the P-1
    // patch anchors; a snapshot pushed here bypassing those would corrupt the
    // webview's blockPatch anchoring.
    this.store.pushSnapshot();
  }

  /** Forward the editor color theme so the panel can follow it by default. */
  private postTheme(): void {
    const kind = vscode.window.activeColorTheme.kind;
    const light = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
    this.postToWebview({ type: "theme", kind: light ? "light" : "dark" });
  }

  // --- Tool approval flow (session/request_permission) --------------------------

  private async requestPermissionFromUser(req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const id = `ap-${++this.approvalSeq}`;
    const toolCall = req.toolCall;
    const approval: PendingApprovalUi = {
      id,
      toolName: toolCall.toolName ?? "",
      title: toolCall.title ?? "",
      toolKind: toolCall.kind ?? "other",
      locations: toolCall.locations ?? [],
      options: req.options,
    };

    return await new Promise<RequestPermissionResponse>((resolve) => {
      const timer = setTimeout(() => {
        // Safety: an unanswered card must not block the agent forever.
        this.pendingApprovals.delete(id);
        this.store.clearApproval(id);
        this.store.approvalResolutionNote(approval.toolName, vscode.l10n.t("审批超时，已自动拒绝"));
        resolve({ outcome: { outcome: "cancelled" } });
      }, APPROVAL_TIMEOUT_MS);

      this.pendingApprovals.set(id, {
        options: req.options,
        toolName: approval.toolName,
        resolve,
        timer,
      });
      this.store.showApproval(approval);
    });
  }

  private handleApprovalResponse(id: string, optionId: string | null): void {
    const pending = this.pendingApprovals.get(id);
    if (!pending) return;
    this.pendingApprovals.delete(id);
    clearTimeout(pending.timer);
    this.store.clearApproval(id);

    if (optionId === null) {
      // User dismissed the card — treat as cancel (agent decides what that means).
      this.store.approvalResolutionNote(pending.toolName, vscode.l10n.t("已取消"));
      pending.resolve({ outcome: { outcome: "cancelled" } });
      return;
    }
    const option = pending.options.find((o) => o.optionId === optionId);
    const isReject = option?.kind.startsWith("reject") ?? false;
    this.store.approvalResolutionNote(
      pending.toolName,
      isReject ? vscode.l10n.t("已拒绝") : vscode.l10n.t("已允许（{0}）", option?.name ?? optionId),
    );
    pending.resolve({ outcome: { outcome: "selected", optionId } });
  }

  private cancelAllApprovals(reason: string): void {
    for (const [id, pending] of this.pendingApprovals) {
      clearTimeout(pending.timer);
      this.store.clearApproval(id);
      this.store.approvalResolutionNote(pending.toolName, reason);
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingApprovals.clear();
  }

  // --- Diff revert ----------------------------------------------------------------

  /**
   * Open an attached image (data URL) in VSCode's built-in image preview.
   * The webview iframe is sandboxed without allow-popups, so window.open is
   * blocked by the browser — the host materializes the data URL into a temp
   * file and opens that instead. The payload is untrusted webview input:
   * size is capped before any disk I/O, and the write is async so a large
   * payload cannot block the extension host's event loop.
   */
  private async openImageAttachment(dataUrl: string): Promise<void> {
    const match = /^data:image\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
    if (!match) {
      void vscode.window.showWarningMessage(vscode.l10n.t("无法打开该图片附件（数据格式异常）"));
      return;
    }
    if (match[2]!.length > MAX_IMAGE_ATTACHMENT_BYTES) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("图片附件过大（超过 {0} MB），已拒绝打开", Math.floor(MAX_IMAGE_ATTACHMENT_BYTES / 1024 / 1024)),
      );
      return;
    }
    const ext = match[1]!.toLowerCase().replace("jpeg", "jpg");
    try {
      const file = path.join(os.tmpdir(), `iflow-image-${Date.now()}.${ext}`);
      await writeFile(file, Buffer.from(match[2]!, "base64"));
      void vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file));
    } catch (error) {
      const message = errorMessage(error);
      void vscode.window.showWarningMessage(vscode.l10n.t("打开图片失败: {0}", message));
    }
  }

  /**
   * M5: fuzzy workspace file search for the @-mention popup. Plain
   * `findFiles` (glob-excludes) + a simple relevance score is plenty at this
   * scale and avoids pulling in a fuzzy-matching dependency.
   */
  private async searchWorkspaceFiles(requestId: number, query: string): Promise<void> {
    const exclude = "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/coverage/**,**/.iflow/**}";
    try {
      const uris = await vscode.workspace.findFiles("**/*", exclude, 500);
      const q = query.trim().toLowerCase();
      const scored = uris.map((uri) => {
        const rel = path.relative(
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
          uri.fsPath,
        ).replace(/\\/g, "/");
        let score = 0;
        if (q) {
          const lower = rel.toLowerCase();
          const idx = lower.indexOf(q);
          if (idx >= 0) score += 100 - Math.min(50, idx); // earlier match = better
          else {
            // subsequence match (fuzzy) — weaker signal
            let qi = 0;
            for (const ch of lower) {
              if (ch === q[qi]) qi++;
              if (qi >= q.length) break;
            }
            if (qi >= q.length) score += 20;
            else score = -1;
          }
          // Prefer shallower paths and source files.
          score += Math.max(0, 10 - rel.split("/").length);
        }
        return { rel, score };
      })
        .filter((s) => s.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 12);
      this.postToWebview({ type: "fileList", requestId, hits: scored.map((s) => ({ path: s.rel })) });
    } catch (error) {
      this.log.warn(`file search failed: ${errorMessage(error)}`);
      this.postToWebview({ type: "fileList", requestId, hits: [] });
    }
  }

  /**
   * M5: open the tool's change in VSCode's native diff editor
   * (left: temp file with the pre-edit content, right: current disk file).
   */
  private async openToolDiff(toolCallId: string): Promise<void> {
    const state = this.store.getState();
    const block = state.blocks.find((b) => b.kind === "tool" && b.toolCallId === toolCallId);
    if (!block || block.kind !== "tool" || !block.diff) return;
    const { oldText, newText } = block.diff;
    if (oldText === null) {
      void vscode.window.showWarningMessage(vscode.l10n.t("无法打开 diff：缺少编辑前内容"));
      return;
    }
    const chosen = await this.locateDiffFile(block);
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
        vscode.l10n.t("打开 diff 失败: {0}", errorMessage(error)),
      );
      return;
    }
    const title = `${path.basename(chosen)} (${block.toolName || "edit"})`;
    await vscode.commands.executeCommand("vscode.diff", tmpUri, vscode.Uri.file(chosen), title);
  }

  /** Resolve which file on disk a tool diff refers to (shared by diff/revert). */
  private async locateDiffFile(block: ToolBlock): Promise<string | null> {
    const { path: rawPath, newText } = block.diff!;
    // The CLI may send workspace-relative paths; resolve them against the cwd
    // the session was created with (the Extension Host's process.cwd() is not
    // necessarily the workspace).
    const sessionBase = this.sessionCwd
      ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      ?? this.context.extensionUri.fsPath;
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
    for (const folder of vscode.workspace.workspaceFolders ?? []) roots.add(folder.uri.fsPath);
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

  private async revertToolDiff(toolCallId: string): Promise<void> {
    const block = this.store
      .getState()
      .blocks.find((b) => b.kind === "tool" && b.toolCallId === toolCallId);
    if (!block || block.kind !== "tool" || !block.diff) return;
    const { oldText, newText } = block.diff;
    if (oldText === null) {
      vscode.window.showWarningMessage(
        vscode.l10n.t("无法回退：该 diff 缺少原始内容（可能是新建文件以外的信息缺失）"),
      );
      return;
    }
    const chosen = await this.locateDiffFile(block);
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
        this.store.toolReverted(toolCallId);
        void vscode.window.showInformationMessage(vscode.l10n.t("已是原始内容，无需回退: {0}", chosen));
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
      this.store.toolReverted(toolCallId);
      void vscode.window.showInformationMessage(vscode.l10n.t("已回退: {0}", chosen));
    } catch (error) {
      vscode.window.showErrorMessage(
        vscode.l10n.t("回退失败: {0}", errorMessage(error)),
      );
    }
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
    let visited = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > maxDepth || visited > 20_000 || results.length >= 10) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // unreadable / not a dir
      }
      for (const entry of entries) {
        if (visited++ > 20_000 || results.length >= 10) return;
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

  // --- Auth (M3: openai-compatible credentials in SecretStorage) ----------------

  /** Masked summary for snapshots — never includes the raw API key. */
  private authMaskCache: AuthUiState["saved"] = null;

  private maskOf(creds: OpenAiCompatCredentials): AuthUiState["saved"] {
    return { baseUrl: creds.baseUrl, modelName: creds.modelName, keyTail: maskKey(creds.apiKey) };
  }

  /**
   * All known API profiles: extension-owned (SecretStorage, editable) merged
   * with the CLI settings.json ones (read-only source, the user's existing
   * configs). The active profile name drives the `active` flag.
   */
  private async buildProfileList(): Promise<AuthUiState["profiles"]> {
    const extProfiles = await loadProfiles(this.context.secrets);
    const cli = readCliSettings();
    // No explicit choice yet → highlight the CLI's own active profile, so the
    // dropdown reflects what the CLI would use on a fresh start.
    const activeName =
      (await getActiveProfileName(this.context.secrets)) ?? cli?.currentApiProfile ?? null;
    const list: AuthUiState["profiles"] = [];
    const push = (name: string, source: "extension" | "cli", p: OpenAiCompatCredentials) => {
      list.push({
        name,
        source,
        baseUrl: p.baseUrl,
        modelName: p.modelName,
        keyTail: maskKey(p.apiKey),
        active: name === activeName,
      });
    };
    for (const [name, p] of Object.entries(extProfiles)) {
      push(name, "extension", p);
    }
    for (const [name, p] of Object.entries(cli?.apiProfiles ?? {})) {
      // CLI profiles whose name collides with an extension profile are shadowed
      // (the extension one is what authenticate will use).
      if (!extProfiles[name] && p.baseUrl && p.apiKey && p.modelName) {
        push(name, "cli", { baseUrl: p.baseUrl, apiKey: p.apiKey, modelName: p.modelName });
      }
    }
    return list;
  }

  private async buildAuthState(authenticated: boolean, needsSetup: boolean): Promise<AuthUiState> {
    return {
      authenticated,
      needsSetup,
      saved: this.authMaskCache,
      profiles: await this.buildProfileList(),
    };
  }

  private async saveAuthAndReconnect(
    baseUrl: string,
    apiKey: string | null,
    modelName: string,
    profileName: string | null,
  ): Promise<void> {
    const stored = await loadCredentials(this.context.secrets);
    const validation = validateCredentials({
      baseUrl,
      apiKey: apiKey ?? stored?.apiKey ?? null,
      modelName,
    });
    if (!validation.ok) {
      this.store.markError(validation.error);
      return;
    }
    const creds = validation.value;

    // Upsert as a named profile. Default name: the model (distinct enough for
    // most setups; users can rename by re-saving under a custom name).
    const name = profileName?.trim() || creds.modelName;
    const profiles = await loadProfiles(this.context.secrets);
    profiles[name] = { baseUrl: creds.baseUrl, apiKey: creds.apiKey, modelName: creds.modelName };
    await saveProfiles(this.context.secrets, profiles);
    await setActiveProfileName(this.context.secrets, name);
    await saveCredentials(this.context.secrets, creds); // active-slot for the next handshake
    this.authMaskCache = this.maskOf(creds);

    await this.reconnectWithCredentials(creds);
  }

  /** Switch the active API profile and re-authenticate the session. */
  private async activateProfile(name: string): Promise<void> {
    const profiles = await loadProfiles(this.context.secrets);
    let creds: OpenAiCompatCredentials | null = profiles[name]
      ? { ...profiles[name] }
      : this.cliProfileCredentials(name);
    if (!creds) {
      vscode.window.showWarningMessage(vscode.l10n.t("未找到 API 配置: {0}", name));
      return;
    }
    await setActiveProfileName(this.context.secrets, name);
    await saveCredentials(this.context.secrets, creds);
    this.authMaskCache = this.maskOf(creds);
    await this.reconnectWithCredentials(creds);
  }

  /** Read a profile from CLI settings.json (read-only source). */
  private cliProfileCredentials(name: string): OpenAiCompatCredentials | null {
    const cli = readCliSettings();
    const p = cli?.apiProfiles?.[name];
    if (!p?.baseUrl || !p?.apiKey || !p?.modelName) return null;
    return { baseUrl: p.baseUrl, apiKey: p.apiKey, modelName: p.modelName };
  }

  private async deleteProfile(name: string): Promise<void> {
    const profiles = await loadProfiles(this.context.secrets);
    if (!profiles[name]) return; // CLI-sourced profiles are read-only
    delete profiles[name];
    await saveProfiles(this.context.secrets, profiles);
    const activeName = await getActiveProfileName(this.context.secrets);
    if (activeName === name) {
      await clearCredentials(this.context.secrets);
      this.authMaskCache = null;
      this.store.setAuth(await this.buildAuthState(false, true));
      return; // active profile deleted → user must pick/configure again
    }
    this.store.setAuth(await this.buildAuthState(this.store.getState().auth.authenticated, false));
  }

  /** Tear down the current CLI connection and start fresh with new credentials. */
  private async reconnectWithCredentials(creds: OpenAiCompatCredentials): Promise<void> {
    this.cancelAllApprovals(vscode.l10n.t("重新认证"));
    // Detach the old client FIRST: dispose() kills its child process, and the
    // resulting exit event must not be mistaken for a crashed session.
    const oldClient = this.client;
    this.client = null;
    await oldClient?.dispose();
    this.store.replaceState(newSessionState(this.store.getState()));
    // The stale currentModelId belongs to the previous endpoint — keep it out
    // of restoreSession's fallback chain.
    this.store.getState().currentModelId = null;
    // Next session start defaults to the NEW profile's configured modelName
    // (user directive) and pushes it to the CLI via set_model.
    this.pendingSwitchModel = creds.modelName;
    // Splash + "连接中" chip while the new CLI boots (can take 10-60s).
    this.store.markConnecting();
    // Remember for the next handshake (ensureClient reads these).
    this.pendingHandshakeCredentials = creds;
    try {
      await this.ensureClient();
      this.store.setAuth(await this.buildAuthState(true, false));
      void vscode.window.showInformationMessage(
        vscode.l10n.t("已切换 API 配置: {0}", (await getActiveProfileName(this.context.secrets)) ?? ""),
      );
    } catch {
      // ensureClient already marked the error in the store; nothing to add.
    }
  }

  /** Credentials to push via authenticate on the next handshake, if any. */
  private pendingHandshakeCredentials: OpenAiCompatCredentials | null = null;
  /**
   * Set by a profile switch; consumed by the next session start (new or
   * restored). Holds the NEW profile's configured modelName — the default
   * model must be the one written in the profile (user directive), not the
   * CLI's stale current model from the previous endpoint.
   */
  private pendingSwitchModel: string | null = null;

  /** Replay-title extraction state for the session currently being loaded. */
  private replayTitle: string | null = null;
  /** True while a `session/load` restore is in flight. */
  private restoring = false;

  private onSessionUpdate(n: Parameters<SessionStore["onSessionUpdate"]>[0]): void {
    // During restore, the first user turn names the session in the switcher.
    if (this.restoring && this.replayTitle === null && n.update.sessionUpdate === "user_message_chunk") {
      if (n.update.content.type === "text" && n.update.content.text.trim()) {
        this.replayTitle = n.update.content.text.trim().slice(0, 60);
      }
    }
    this.store.onSessionUpdate(n, { replaying: this.restoring });
  }

  // --- Session persistence (M4) --------------------------------------------------

  private readPersistedSessions(): SessionSummaryUi[] {
    return this.context.workspaceState.get<SessionSummaryUi[]>(SESSIONS_KEY, []);
  }

  private async persistSessions(sessions: SessionSummaryUi[], activeId: string | null): Promise<void> {
    await this.context.workspaceState.update(SESSIONS_KEY, sessions.slice(0, MAX_RECENT_SESSIONS));
    await this.context.workspaceState.update(ACTIVE_SESSION_KEY, activeId);
  }

  /** Upsert a session into the recent list (newest first) and persist it. */
  private async recordSession(id: string, label: string | null): Promise<void> {
    if (!id) return;
    const existing = this.readPersistedSessions();
    const prior = existing.find((s) => s.id === id);
    const sessions = [
      { id, label: label ?? prior?.label ?? DEFAULT_SESSION_LABEL, updatedAt: Date.now() },
      ...existing.filter((s) => s.id !== id),
    ];
    this.store.setSessions(sessions, id);
    await this.persistSessions(sessions, id);
  }

  /** Forgetter: drop one session from the persisted list (e.g. load failed). */
  private async forgetSession(id: string): Promise<void> {
    const sessions = this.readPersistedSessions().filter((s) => s.id !== id);
    const activeId = sessions[0]?.id ?? null;
    this.store.setSessions(sessions, activeId);
    await this.persistSessions(sessions, activeId);
  }

  /** User-invoked delete from the session switcher: forget + drop transcript. */
  private async deleteSession(sessionId: string): Promise<void> {
    await this.forgetSession(sessionId);
    await this.clearTranscript(sessionId);
  }

  /**
   * Restore a persisted session via `session/load`. Wire behavior (CLI
   * 0.5.19): load succeeds (sessionId + modes returned) but the CLI does NOT
   * replay history through `session/update` — the transcript is rebuilt from
   * the CLI's own session file instead.
   */
  private async restoreSession(sessionId: string): Promise<boolean> {
    // Fast path: the CLI only persists jsonl transcripts for sessions that
    // actually had a conversation. A "dead" session (auto-created on panel
    // open, never used) would burn 60s+ on new+load for nothing.
    this.sessionCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.context.extensionUri.fsPath;
    if (!this.hasPersistedTranscript(sessionId)) {
      this.log.warn(`skip restore: no persisted transcript for ${sessionId}`);
      return false;
    }

    const client = await this.ensureClient();
    const workspaceRoot = this.sessionCwd;
    const init = client.getInitializeResult();
    if (init && !init.agentCapabilities.loadSession) {
      this.log.warn("loadSession capability not declared by CLI");
      void vscode.window.showWarningMessage(
        vscode.l10n.t("当前 iFlow CLI 不支持会话恢复（loadSession 能力未声明）"),
      );
      return false;
    }

    this.log.info(`restoring session ${sessionId} …`);
    this.restoring = true;
    this.replayTitle = null;
    this.sessionCwd = workspaceRoot;
    const fresh = newSessionState(this.store.getState());
    beginReplay(fresh);
    fresh.activeSessionId = sessionId;
    this.store.replaceState(fresh);
    try {
      // CLI 0.5.19 wire behavior: an empty/short session's loadSession response
      // carries ONLY {sessionId} — no modes, no _meta. A prior session/new does
      // return the full meta, so fetch it first (also warms up the CLI).
      const probe = await client.newSession({ cwd: workspaceRoot, mcpServers: [] });
      const probeMeta: NewSessionMeta | undefined = probe._meta;
      const session = await client.loadSession({ cwd: workspaceRoot, mcpServers: [], sessionId });
      const meta: NewSessionMeta | undefined = probeMeta ?? session._meta;
      const modes = session.modes ?? probe.modes;
      endReplay(this.store.getState());

      // Rebuild the transcript from the CLI's session file (NDJSON).
      const loadedId = session.sessionId;
      const restored = await this.loadPersistedTranscript(loadedId);
      if (restored.blocks.length === 0) {
        restored.blocks.push({
          kind: "text",
          text: vscode.l10n.t("已恢复会话上下文（CLI 未持久化该会话的历史记录，故此处无历史消息，但对话可继续）。"),
        });
      }
      this.store.replaceTranscript(restored.blocks);

      // Model list: same live-endpoint-only source as a fresh session,
      // otherwise the model dropdown would vanish after a restore.
      const models = await this.queryLiveModels();
      // After a profile switch the default model is the one written in the
      // NEW profile (its configured modelName), not the previous endpoint's
      // stale current model (user directive).
      const switchModel = this.pendingSwitchModel;
      this.pendingSwitchModel = null;
      const currentModelId = switchModel ?? this.store.getState().currentModelId ?? meta?.models?.currentModelId ?? models[0]?.id ?? null;
      if (currentModelId && !models.some((m) => m.id === currentModelId)) {
        models.unshift({ id: currentModelId, name: currentModelId });
      }

      this.store.sessionStarted({
        sessionId: loadedId,
        modes,
        commands: meta?.availableCommands ?? [],
        models,
        currentModelId,
      });
      // Keep the restored session's actual model in sync with the profile's
      // configured model (only when a profile switch provided one).
      if (switchModel && currentModelId && currentModelId !== (meta?.models?.currentModelId ?? null)) {
        await this.setModel(currentModelId);
      }
      this.log.info(`session restored: ${loadedId} (${restored.blocks.length} blocks)`);
      await this.recordSession(loadedId, restored.firstUserText);
      void this.persistActiveTranscript(); // seed the extension-owned copy
      void vscode.window.showInformationMessage(vscode.l10n.t("已恢复会话"));
      return true;
    } catch (error) {
      const message = errorMessage(error);
      endReplay(this.store.getState());
      this.log.error(`session restore failed: ${message}`);
      this.store.markError(vscode.l10n.t("会话恢复失败：{0}", message));
      await this.forgetSession(sessionId);
      return false;
    } finally {
      this.restoring = false;
      this.replayTitle = null;
    }
  }

  /**
   * Locate the CLI's NDJSON transcript file for a session id. The CLI stores
   * one file per project dir: `~/.iflow/projects/<cwd-as-slug>/session-<id>.jsonl`.
   */
  private cliTranscriptFilePath(sessionId: string): string | null {
    const fileBase = sessionId.startsWith("session-") ? sessionId : `session-${sessionId}`;
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const base = path.join(home, ".iflow", "projects");
    const cwdSlug = (this.sessionCwd ?? "").replace(/[^A-Za-z0-9-]/g, "-");
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

  private async loadPersistedTranscript(sessionId: string): Promise<{ blocks: SessionState["blocks"]; firstUserText: string | null }> {
    // Source 1: the extension's own persisted copy (ACP mode writes no files).
    const own = await this.readTranscript(sessionId);
    if (own) {
      // P4: files written before block ids existed lack stable keys.
      backfillBlockIds(own.blocks);
      this.log.info(`transcript source: extension store (${own.blocks.length} blocks)`);
      return { blocks: own.blocks, firstUserText: own.label !== DEFAULT_SESSION_LABEL ? own.label : null };
    }
    // Source 2: the CLI's interactive-mode jsonl (only exists for terminal sessions).
    const file = this.cliTranscriptFilePath(sessionId);
    if (!file) {
      this.log.warn(`no persisted transcript found for ${sessionId}`);
      return { blocks: [], firstUserText: null };
    }
    try {
      const text = await readFile(file, "utf8");
      this.log.info(`transcript source: ${file}`);
      return parseTranscriptJsonl(text);
    } catch (error) {
      this.log.warn(`transcript read failed: ${errorMessage(error)}`);
      return { blocks: [], firstUserText: null };
    }
  }

  // --- Agent lifecycle ----------------------------------------------------------

  private async ensureClient(): Promise<AcpClient> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting.then(() => this.client!);

    this.connecting = (async () => {
      let entry: string;
      try {
        entry = this.resolveEntry();
      } catch (error) {
        // CLI not found: surface it in the panel instead of leaving it on the
        // loading screen (this used to throw before the try/catch below).
        const message = errorMessage(error);
        this.log.error(message);
        this.store.markError(message);
        throw error;
      }
      const node = vscode.workspace.getConfiguration("iflow").get<string>("nodePath") || process.execPath;
      const { command, args } = buildAcpCommand(entry);
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.context.extensionUri.fsPath;
      this.log.info(`spawning CLI: ${command} ${args.join(" ")} (cwd=${workspaceRoot})`);

      const client = new AcpClient(
        // Generous control-plane timeout: a CLI with many MCP servers can take
        // 30-60s+ before its first initialize response.
        { command: node, args, cwd: workspaceRoot, requestTimeoutMs: 120_000 },
        {
          onSessionUpdate: (n) => this.onSessionUpdate(n),
          onStderr: () => {},
          onExit: () => {
            // Ignore exits of clients that were replaced on purpose (profile
            // switch / reconnect): their exit is expected, and marking an error
            // here would flash a global "错误" while the new CLI is connecting.
            // A stale instance exiting late must also not clobber this.client.
            if (this.disposed || this.client !== client) return;
            this.client = null;
            this.cancelAllApprovals(vscode.l10n.t("CLI 进程已退出"));
            this.store.markError(vscode.l10n.t("iFlow CLI 进程已退出，重新打开面板可重试"));
          },
          onRequestPermission: (req: RequestPermissionRequest) =>
            this.requestPermissionFromUser(req),
        },
      );
      this.client = client;
      try {
        const init = await client.connect();
        this.log.info(
          `initialize ok: authenticated=${init.isAuthenticated ?? false}, loadSession=${init.agentCapabilities.loadSession ?? false}`,
        );
        // Explicit credentials from a profile switch take priority; otherwise
        // fall back to the persisted active slot.
        const explicitSwitch = this.pendingHandshakeCredentials !== null;
        const storedCreds = this.pendingHandshakeCredentials ?? (await loadCredentials(this.context.secrets));
        this.pendingHandshakeCredentials = null;
        this.authMaskCache = storedCreds ? this.maskOf(storedCreds) : null;
        // A profile switch must ALWAYS re-push authenticate: the CLI caches
        // auth across spawns and reports isAuthenticated=true for the PREVIOUS
        // profile's endpoint (observed: BUZZ→商汤 switch skipped authenticate,
        // prompts hit the BUZZ gateway with SenseTime models → model_not_found).
        if (!init.isAuthenticated || explicitSwitch) {
          // M3 flow: push stored openai-compatible credentials to the agent.
          if (storedCreds) {
            try {
              await client.authenticate({
                methodId: "openai-compatible",
                methodInfo: {
                  apiKey: storedCreds.apiKey,
                  baseUrl: storedCreds.baseUrl,
                  modelName: storedCreds.modelName,
                },
              });
              this.log.info("authenticate ok (openai-compatible)");
              this.store.setAuth(await this.buildAuthState(true, false));
            } catch (error) {
              const message = errorMessage(error);
              this.log.error(`authenticate failed: ${message}`);
              this.store.setAuth(await this.buildAuthState(false, true));
              this.store.markError(vscode.l10n.t("认证失败：{0}", message));
              this.store.markConnected();
              return; // session cannot start; setup banner is the remedy
            }
          } else {
            this.store.setAuth(await this.buildAuthState(false, true));
            this.store.markConnected();
            return; // no credentials yet — setup banner guides the user
          }
        } else {
          this.store.setAuth(await this.buildAuthState(true, false));
        }
        this.store.markConnected();
        // Surface the persisted session list before the session starts so the
        // switcher renders as soon as the panel opens. Sessions the CLI never
        // persisted (created but unused) are pruned: nothing to restore.
        const restorable = await this.pruneUnrestorableSessions();
        this.store.setSessions(restorable, restorable[0]?.id ?? null);
        if (!await this.tryRestoreLastSession()) {
          await this.startNewSession();
        }
      } catch (error) {
        this.client = null;
        this.store.setAuth(await this.buildAuthState(false, true));
        const message = errorMessage(error);
        this.log.error(`connect failed: ${message}`);
        this.store.markError(message);
        throw error;
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting.then(() => this.client!);
  }

  private resolveEntry(): string {
    const configured = this.services.entryOverride
      ?? vscode.workspace.getConfiguration("iflow").get<string>("cliPath");
    if (configured) {
      const resolved = path.resolve(configured);
      if (existsSync(resolved)) return resolved;
      vscode.window.showWarningMessage(
        vscode.l10n.t("iflow.cliPath 不存在，回退自动探测: {0}", configured),
      );
    }
    const entry = locateIflowEntry();
    if (!entry)
      throw new Error(
        vscode.l10n.t("未找到 iFlow CLI（entry.js）。请安装 @iflow-ai/iflow-cli 或设置 iflow.cliPath。"),
      );
    return entry;
  }

  // --- Mode / model switching ---------------------------------------------------
  // Wire behavior (probed, CLI 0.5.19): both return `{success, currentModeId |
  // currentModelId}` and the agent does NOT emit `current_mode_update`, so the
  // response must be written back into the store or the dropdown snaps back.

  private async setMode(modeId: string): Promise<void> {
    const sessionId = this.store.getState().sessionId;
    try {
      const resp = (await this.client?.setMode(sessionId ?? "", modeId)) as
        | { success?: boolean; currentModeId?: string }
        | undefined;
      if (resp?.success && resp.currentModeId) {
        const modes = this.store.getState().modes;
        if (modes) this.store.sessionMeta({ modes: { ...modes, currentModeId: resp.currentModeId } });
        return;
      }
      vscode.window.showWarningMessage(
        vscode.l10n.t("切换模式失败：{0}", JSON.stringify(resp ?? vscode.l10n.t("无响应"))),
      );
    } catch (error) {
      vscode.window.showWarningMessage(
        vscode.l10n.t("切换模式失败：{0}", errorMessage(error)),
      );
    }
  }

  private async setModel(modelId: string): Promise<void> {
    const sessionId = this.store.getState().sessionId;
    try {
      const resp = (await this.client?.setModel(sessionId ?? "", modelId)) as
        | { success?: boolean; currentModelId?: string }
        | undefined;
      if (resp?.success && resp.currentModelId) {
        this.store.sessionMeta({ currentModelId: resp.currentModelId });
        return;
      }
      vscode.window.showWarningMessage(
        vscode.l10n.t("切换模型失败：{0}", JSON.stringify(resp ?? vscode.l10n.t("无响应"))),
      );
      // Keep the dropdown consistent with the agent's actual model.
      this.store.pushSnapshot();
    } catch (error) {
      vscode.window.showWarningMessage(
        vscode.l10n.t("切换模型失败：{0}", errorMessage(error)),
      );
      this.store.pushSnapshot();
    }
  }

  // --- Extension-owned transcripts (M4) ------------------------------------------

  /**
   * The CLI's ACP mode does NOT write session files (verified: interactive
   * mode does, `--experimental-acp` doesn't). For "restart VSCode → get the
   * conversation back" the extension therefore persists transcripts itself —
   * one JSON file per session under storageUri (P2: the old workspaceState
   * map made every persist a read-all + clone + write-all of every session).
   */
  private transcriptDir(): string {
    // workspaceState falls back to global state when no workspace is open;
    // mirror that fallback for the file store.
    return path.join((this.context.storageUri ?? this.context.globalStorageUri).fsPath, "transcripts");
  }

  private ownTranscriptFileName(sessionId: string): string {
    // Session ids come from the CLI and webview messages — restrict to a
    // filesystem-safe charset so a hostile id cannot escape the directory.
    const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "-");
    return `${safe}.json`;
  }

  private ownTranscriptFilePath(sessionId: string): string {
    return path.join(this.transcriptDir(), this.ownTranscriptFileName(sessionId));
  }

  /** Read one session's transcript file; null when absent or corrupt. */
  private async readTranscript(sessionId: string): Promise<PersistedTranscript | null> {
    try {
      const raw = await readFile(this.ownTranscriptFilePath(sessionId), "utf8");
      const parsed = JSON.parse(raw) as PersistedTranscript;
      if (!Array.isArray(parsed.blocks)) return null;
      return parsed;
    } catch {
      return null; // ENOENT (never persisted) or corrupt (crash mid-write)
    }
  }

  /**
   * Serialize a transcript payload synchronously, at call time. Blocks are
   * mutated in place by the shared reducer; stringifying here captures a
   * coherent snapshot even though the actual file write runs later on the
   * persist chain. (Also replaces the old per-persist structuredClone.)
   */
  private serializeTranscript(label: string, blocks: SessionState["blocks"]): string {
    return JSON.stringify({ label, blocks } satisfies PersistedTranscript);
  }

  private async writeTranscriptFile(sessionId: string, payload: string): Promise<void> {
    const target = this.ownTranscriptFilePath(sessionId);
    const tmp = `${target}.tmp`;
    await mkdir(this.transcriptDir(), { recursive: true });
    await writeFile(tmp, payload, "utf8");
    await rename(tmp, target);
  }

  /**
   * Queue a transcript file write on the persist chain: overlapping persists
   * (e.g. prompt-start seeding and the previous prompt's completion) run
   * back-to-back instead of interleaving inside one file's write sequence.
   */
  private enqueueTranscriptWrite(sessionId: string, payload: string): Promise<void> {
    const run = this.persistChain.then(() => this.writeTranscriptFile(sessionId, payload));
    this.persistChain = run.catch(() => {});
    return run;
  }

  private async clearTranscript(sessionId: string): Promise<void> {
    await rm(this.ownTranscriptFilePath(sessionId), { force: true });
  }

  /** Restorable = the extension holds a transcript OR the CLI wrote a file. */
  private hasPersistedTranscript(sessionId: string): boolean {
    if (existsSync(this.ownTranscriptFilePath(sessionId))) return true;
    return this.cliTranscriptFilePath(sessionId) !== null;
  }

  /**
   * Drop persisted sessions the CLI has no transcript for (auto-created but
   * never used). Returns the surviving list (already persisted). Orphaned
   * transcript files (session forgotten/dead, file left behind) are deleted.
   */
  private async pruneUnrestorableSessions(): Promise<SessionSummaryUi[]> {
    this.sessionCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.context.extensionUri.fsPath;
    // Migrate BEFORE filtering: hasPersistedTranscript is file-based now, and
    // unmigrated transcripts would otherwise look unrestorable.
    await this.migrateLegacyTranscripts();
    const before = this.readPersistedSessions();
    const kept = before.filter((s) => this.hasPersistedTranscript(s.id));
    if (kept.length !== before.length) {
      this.log.info(`pruned ${before.length - kept.length} unrestorable session(s)`);
    }
    // P2: drop transcript files whose session is no longer in the list —
    // the old workspaceState map could only grow; the per-session files get
    // garbage-collected here instead. Filename-based comparison: the on-disk
    // name is the sanitized id, so kept ids must go through the same mapping.
    const keptFileNames = new Set(kept.map((s) => this.ownTranscriptFileName(s.id)));
    for (const name of await this.listOwnTranscriptFileNames()) {
      if (name.endsWith(".json") && !keptFileNames.has(name)) {
        await rm(path.join(this.transcriptDir(), name), { force: true });
      }
    }
    const activeId = (await this.context.workspaceState.get<string | null>(ACTIVE_SESSION_KEY, null)) ?? kept[0]?.id ?? null;
    await this.persistSessions(kept, kept.some((s) => s.id === activeId) ? activeId : kept[0]?.id ?? null);
    return kept;
  }

  /**
   * Transcript file names on disk under the extension's transcript store
   * (for orphan cleanup). Empty when the store directory doesn't exist yet.
   */
  private async listOwnTranscriptFileNames(): Promise<string[]> {
    try {
      return await readdir(this.transcriptDir());
    } catch {
      return []; // transcripts dir not created yet
    }
  }

  /**
   * P2 migration: move transcripts out of the legacy workspaceState map into
   * per-session files, then delete the legacy key. One-shot; a no-op when
   * the key is absent (fresh installs, already-migrated workspaces).
   */
  private async migrateLegacyTranscripts(): Promise<void> {
    const legacy = this.context.workspaceState.get<Record<string, PersistedTranscript>>(TRANSCRIPTS_KEY);
    if (!legacy) return;
    for (const [sessionId, transcript] of Object.entries(legacy)) {
      if (!transcript || !Array.isArray(transcript.blocks) || transcript.blocks.length === 0) continue;
      await this.enqueueTranscriptWrite(
        sessionId,
        this.serializeTranscript(transcript.label ?? DEFAULT_SESSION_LABEL, transcript.blocks),
      );
    }
    await this.context.workspaceState.update(TRANSCRIPTS_KEY, undefined);
    this.log.info(`migrated ${Object.keys(legacy).length} legacy transcript(s) from workspaceState to files`);
  }

  /**
   * Try to restore the last usable session for this workspace. Returns false
   * when there is nothing restorable (fresh session follows).
   */
  private async tryRestoreLastSession(): Promise<boolean> {
    const lastId = await this.context.workspaceState.get<string | null>(ACTIVE_SESSION_KEY, null);
    if (lastId && this.hasPersistedTranscript(lastId)) {
      return await this.restoreSession(lastId);
    }
    // The recorded active session is dead — fall back to the most recent
    // restorable one from the switcher list.
    const fallback = this.readPersistedSessions().find((s) => this.hasPersistedTranscript(s.id));
    if (fallback) {
      return await this.restoreSession(fallback.id);
    }
    return false;
  }

  /**
   * Live model list from the active endpoint (`GET {baseUrl}/models`).
   * Per user directive the CLI's hardcoded `_meta` catalog is NEVER used as a
   * fallback: an unreachable or empty endpoint yields an empty list (the CLI's
   * current model stays selectable so the dropdown isn't blank).
   */
  private async queryLiveModels(): Promise<SessionState["models"]> {
    const endpoint = (await loadCredentials(this.context.secrets)) ?? readActiveEndpoint();
    if (!endpoint) return [];
    try {
      return (await queryModelIds(endpoint)).map((id) => ({ id, name: id }));
    } catch (error) {
      const message = errorMessage(error);
      this.log.warn(
        vscode.l10n.t("模型列表查询失败（不回退 CLI 内置目录）: {0}", message),
      );
      return [];
    }
  }

  private async startNewSession(): Promise<void> {
    // Lock the UI while the CLI spins up the new session (sessions/mode/model
    // switches must not race the in-flight `session/new`).
    this.store.setInitializing(true);
    try {
    const client = await this.ensureClient();
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.context.extensionUri.fsPath;
    this.sessionCwd = workspaceRoot;
    const session = await client.newSession({ cwd: workspaceRoot, mcpServers: [] });
    const meta: NewSessionMeta | undefined = session._meta;
    const store = this.store;
    // A new session invalidates any approvals from the old one.
    this.cancelAllApprovals(vscode.l10n.t("会话已重置"));
    store.replaceState(newSessionState(store.getState()));
    // Model dropdown: live query of the active endpoint's `/models`. The CLI's
    // `_meta` catalog is hardcoded and not truthful for user-supplied
    // endpoints — per user directive, never fall back to it.
    const models = await this.queryLiveModels();
    const cliModelId = meta?.models?.currentModelId ?? null;
    // After a profile switch the CLI's current model belongs to the previous
    // endpoint — default to the model configured in the NEW profile (user
    // directive) and push it to the CLI so prompts actually use it.
    const switchModel = this.pendingSwitchModel;
    this.pendingSwitchModel = null;
    let currentModelId = switchModel ?? cliModelId;
    // The CLI's current model may be absent from the list; add it so the
    // controlled <select> doesn't render blank.
    if (currentModelId && !models.some((m) => m.id === currentModelId)) {
      models.unshift({ id: currentModelId, name: currentModelId });
    }
    // A failed restore leaves an error banner behind — clear it for the fresh
    // session so the stale message doesn't follow the user around.
    store.getState().errorMessage = null;
    if (store.getState().status === "error") store.getState().status = "idle";
    store.sessionStarted({
      sessionId: session.sessionId,
      modes: session.modes,
      commands: meta?.availableCommands ?? [],
      models,
      currentModelId,
    });
    if (switchModel && currentModelId && currentModelId !== cliModelId) {
      await this.setModel(currentModelId);
    }
    this.log.info(`session started: ${session.sessionId}`);
    await this.recordSession(session.sessionId, null);
    } finally {
      this.store.setInitializing(false);
    }
  }

  private async sendPrompt(text: string, images?: { data: string; mimeType: string }[]): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      const client = await this.ensureClient();
      const sessionId = this.store.getState().sessionId;
      if (!sessionId) throw new Error(vscode.l10n.t("会话未就绪"));
      this.store.userPrompt(
        trimmed,
        (images ?? []).map((img) => `data:${img.mimeType};base64,${img.data}`),
      );
      void this.labelSessionWithPrompt(trimmed);
      void this.persistActiveTranscript(); // user turn lands even on a crash
      const prompt: ContentBlock[] = [{ type: "text", text: trimmed }];
      for (const img of images ?? []) {
        prompt.push({ type: "image", data: img.data, mimeType: img.mimeType });
      }
      const result = await client.prompt({ sessionId, prompt });
      this.store.promptCompleted(result.stopReason);
      void this.persistActiveTranscript();
    } catch (error) {
      const message = errorMessage(error);
      if (/timed out/i.test(message)) {
        this.store.markError(vscode.l10n.t("请求超时：{0}", message));
      } else {
        this.store.markError(message);
      }
    }
  }

  /**
   * Snapshot the active session's transcript into the extension-owned file
   * store (M4). P2: the payload is serialized once, synchronously, at call
   * time and written as this session's own file on the persist chain — the
   * old workspaceState map made each persist a read-all + clone + write-all
   * of every session.
   */
  private persistActiveTranscript(): Promise<void> {
    const state = this.store.getState();
    const id = state.activeSessionId ?? state.sessionId;
    if (!id || state.blocks.length === 0) return Promise.resolve();
    const label = state.sessions.find((s) => s.id === id)?.label ?? DEFAULT_SESSION_LABEL;
    const payload = this.serializeTranscript(label, state.blocks);
    return this.enqueueTranscriptWrite(id, payload);
  }

  /**
   * Name the active session after its first user prompt (switcher label).
   * No-op once the session has a real title.
   */
  private async labelSessionWithPrompt(text: string): Promise<void> {
    const state = this.store.getState();
    const id = state.activeSessionId;
    if (!id) return;
    const target = state.sessions.find((s) => s.id === id);
    if (!target || target.label !== DEFAULT_SESSION_LABEL) return;
    const label = text.trim().slice(0, 60) || target.label;
    const sessions = state.sessions.map((s) => (s.id === id ? { ...s, label } : s));
    this.store.setSessions(sessions);
    await this.persistSessions(sessions, id);
  }
}
