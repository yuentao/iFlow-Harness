/**
 * Chat panel: owns the AcpClient lifecycle and the WebView. Host-side routing:
 * WebView messages → ACP calls; ACP events → store → throttled snapshots.
 */

import * as vscode from "vscode";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { AcpClient } from "../acp/client.js";
import { buildAcpCommand, locateIflowEntry } from "../acp/cli-locator.js";
import { queryModelIds, readActiveEndpoint } from "../acp/models-query.js";
import type {
  NewSessionMeta,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "../acp/protocol.js";
import type { PendingApprovalUi, SessionState, WebviewToHost } from "../../shared/messages.js";
import { newSessionState } from "../../shared/session-state.js";
import { SessionStore } from "./store.js";

const WEBVIEW_DIST = "webview/dist/index.html";
/** User answer window for a tool-approval card. */
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

interface PanelServices {
  entryOverride?: string | undefined;
}

export class ChatPanel implements vscode.Disposable, vscode.WebviewViewProvider {
  public static readonly viewId = "iflow.chatPanel";

  private view: vscode.WebviewView | undefined;
  private client: AcpClient | null = null;
  private store: SessionStore;
  private connecting: Promise<void> | null = null;
  private disposed = false;
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

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly services: PanelServices = {},
  ) {
    this.store = new SessionStore({ post: (m) => this.postToWebview(m) });
  }

  dispose(): void {
    this.disposed = true;
    this.cancelAllApprovals("扩展已停用");
    void this.client?.dispose();
    this.client = null;
  }

  // --- WebviewViewProvider ---------------------------------------------------

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    view.webview.html = this.buildHtml(view.webview);
    view.webview.onDidReceiveMessage((msg: WebviewToHost) => void this.handleWebviewMessage(msg));
    // Connect eagerly so the panel is usable immediately (errors surface via store).
    void this.ensureClient().catch(() => {});
  }

  private buildHtml(webview: vscode.Webview): string {
    const absIndex = this.context.asAbsolutePath(WEBVIEW_DIST);
    let raw: string;
    try {
      raw = readFileSync(absIndex, "utf8");
    } catch {
      return `<html><body><h3>webview assets missing</h3><p>Run <code>npm run build</code> in iflow-vscode/</p></body></html>`;
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

  // --- WebView message routing -------------------------------------------------

  private async handleWebviewMessage(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.store.pushSnapshot();
        break;
      case "sendPrompt":
        await this.sendPrompt(msg.text);
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
    }
  }

  private postToWebview(message: unknown): void {
    if (this.view) void this.view.webview.postMessage(message);
  }

  private postSnapshot(): void {
    this.postToWebview({ type: "snapshot", state: structuredClone(this.store.getState()) satisfies SessionState as unknown });
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
        this.store.approvalResolutionNote(approval.toolName, "审批超时，已自动拒绝");
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
      this.store.approvalResolutionNote(pending.toolName, "已取消");
      pending.resolve({ outcome: { outcome: "cancelled" } });
      return;
    }
    const option = pending.options.find((o) => o.optionId === optionId);
    const isReject = option?.kind.startsWith("reject") ?? false;
    this.store.approvalResolutionNote(pending.toolName, isReject ? "已拒绝" : `已允许（${option?.name ?? optionId}）`);
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

  private async revertToolDiff(toolCallId: string): Promise<void> {
    const block = this.store
      .getState()
      .blocks.find((b) => b.kind === "tool" && b.toolCallId === toolCallId);
    if (!block || block.kind !== "tool" || !block.diff) return;
    const { path: rawPath, oldText, newText } = block.diff;
    if (oldText === null) {
      vscode.window.showWarningMessage("无法回退：该 diff 缺少原始内容（可能是新建文件以外的信息缺失）");
      return;
    }
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

    let chosen: string | null = null;
    for (const candidate of candidates) {
      const decisive = await this.probeRevertCandidate(candidate, newText);
      if (decisive) {
        chosen = candidate; // disk content === diff newText: the edited file
        break;
      }
    }

    if (!chosen) {
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
          chosen = match;
          break;
        }
      }
      if (!chosen && matches.length === 1) chosen = matches[0]!;
      if (!chosen && matches.length > 1) {
        const pick = await vscode.window.showQuickPick(matches, {
          placeHolder: `找到多个 "${basename}"，选择要回退的文件`,
        });
        if (!pick) return;
        chosen = pick;
      }
      if (!chosen) {
        // Last resort: let the user point at the file.
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          openLabel: "选择要回退的文件",
          defaultUri: sessionBase ? vscode.Uri.file(sessionBase) : undefined,
        });
        if (!picked?.[0]) return;
        chosen = picked[0].fsPath;
      }
    }

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
          "该文件在编辑器中有未保存的修改。回退将从磁盘重新加载并丢弃这些修改。",
          { modal: true },
          "丢弃并回退",
        );
        if (pick !== "丢弃并回退") return;
      }

      if (newText !== null && currentText === oldText) {
        // Already reverted (e.g. the CLI undid it, or a previous retry landed).
        this.store.toolReverted(toolCallId);
        void vscode.window.showInformationMessage(`已是原始内容，无需回退: ${chosen}`);
        return;
      }
      if (newText !== null && currentText !== null && currentText !== newText) {
        const pick = await vscode.window.showWarningMessage(
          "文件内容与 diff 记录不一致（可能已被继续修改）。仍按 diff 原始内容回退？",
          { modal: true },
          "仍然回退",
        );
        if (pick !== "仍然回退") return;
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
      void vscode.window.showInformationMessage(`已回退: ${chosen}`);
    } catch (error) {
      vscode.window.showErrorMessage(`回退失败: ${error instanceof Error ? error.message : String(error)}`);
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

  // --- Agent lifecycle ----------------------------------------------------------

  private async ensureClient(): Promise<AcpClient> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting.then(() => this.client!);

    this.connecting = (async () => {
      const entry = this.resolveEntry();
      const node = vscode.workspace.getConfiguration("iflow").get<string>("nodePath") || process.execPath;
      const { command, args } = buildAcpCommand(entry);
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.context.extensionUri.fsPath;

      const client = new AcpClient(
        { command: node, args, cwd: workspaceRoot },
        {
          onSessionUpdate: (n) => this.store.onSessionUpdate(n),
          onStderr: () => {},
          onExit: () => {
            if (!this.disposed) {
              this.client = null;
              this.cancelAllApprovals("CLI 进程已退出");
              this.store.markError("iFlow CLI 进程已退出，重新打开面板可重试");
            }
          },
          onRequestPermission: (req: RequestPermissionRequest) =>
            this.requestPermissionFromUser(req),
        },
      );
      this.client = client;
      try {
        const init = await client.connect();
        if (!init.isAuthenticated) {
          this.store.markError("CLI 未认证：请配置 OpenAI Compatible 凭据（见扩展设置）");
        }
        this.store.markConnected();
        await this.startNewSession();
      } catch (error) {
        this.client = null;
        this.store.markError(error instanceof Error ? error.message : String(error));
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
      vscode.window.showWarningMessage(`iflow.cliPath 不存在，回退自动探测: ${configured}`);
    }
    const entry = locateIflowEntry();
    if (!entry) throw new Error("未找到 iFlow CLI（entry.js）。请安装 @iflow-ai/iflow-cli 或设置 iflow.cliPath。");
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
      vscode.window.showWarningMessage(`切换模式失败：${JSON.stringify(resp ?? "无响应")}`);
    } catch (error) {
      vscode.window.showWarningMessage(`切换模式失败：${error instanceof Error ? error.message : String(error)}`);
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
      vscode.window.showWarningMessage(`切换模型失败：${JSON.stringify(resp ?? "无响应")}`);
      // Keep the dropdown consistent with the agent's actual model.
      this.store.pushSnapshot();
    } catch (error) {
      vscode.window.showWarningMessage(`切换模型失败：${error instanceof Error ? error.message : String(error)}`);
      this.store.pushSnapshot();
    }
  }

  private async startNewSession(): Promise<void> {
    const client = await this.ensureClient();
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.context.extensionUri.fsPath;
    this.sessionCwd = workspaceRoot;
    const session = await client.newSession({ cwd: workspaceRoot, mcpServers: [] });
    const meta: NewSessionMeta | undefined = session._meta;
    const store = this.store;
    // A new session invalidates any approvals from the old one.
    this.cancelAllApprovals("会话已重置");
    store.replaceState(newSessionState(store.getState()));
    // Model dropdown: query the active endpoint's live `/models` — the CLI's
    // `_meta` catalog is hardcoded official models and not truthful for
    // user-supplied (openai-compatible) endpoints. Falls back to the catalog
    // when the endpoint query fails or yields nothing.
    const models: SessionState["models"] = (meta?.models?.availableModels ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      thinking: m.capabilities?.thinking,
    }));
    const currentModelId = meta?.models?.currentModelId ?? null;
    const endpoint = readActiveEndpoint();
    if (endpoint) {
      try {
        const ids = await queryModelIds(endpoint);
        if (ids.length > 0) {
          models.length = 0;
          for (const id of ids) models.push({ id, name: id });
        }
      } catch {
        // Endpoint unreachable / bad response: keep the CLI catalog fallback.
      }
    }
    // The CLI's current model may be absent from the list; add it so the
    // controlled <select> doesn't render blank.
    if (currentModelId && !models.some((m) => m.id === currentModelId)) {
      models.unshift({ id: currentModelId, name: currentModelId });
    }
    store.sessionStarted({
      sessionId: session.sessionId,
      modes: session.modes,
      commands: meta?.availableCommands ?? [],
      models,
      currentModelId,
    });
  }

  private async sendPrompt(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      const client = await this.ensureClient();
      const sessionId = this.store.getState().sessionId;
      if (!sessionId) throw new Error("会话未就绪");
      this.store.userPrompt(trimmed);
      const result = await client.prompt({ sessionId, prompt: [{ type: "text", text: trimmed }] });
      this.store.promptCompleted(result.stopReason);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/timed out/i.test(message)) {
        this.store.markError(`请求超时：${message}`);
      } else {
        this.store.markError(message);
      }
    }
  }
}
