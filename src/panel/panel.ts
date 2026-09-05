/**
 * Chat panel: owns the AcpClient lifecycle and the WebView. Host-side routing:
 * WebView messages → ACP calls; ACP events → store → throttled snapshots.
 */

import * as vscode from "vscode";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { AcpClient } from "../acp/client.js";
import { buildAcpCommand, locateIflowEntry } from "../acp/cli-locator.js";
import type { NewSessionMeta, RequestPermissionRequest, RequestPermissionResponse } from "../acp/protocol.js";
import type { SessionState, WebviewToHost } from "../../shared/messages.js";
import { newSessionState } from "../../shared/session-state.js";
import { SessionStore } from "./store.js";

const WEBVIEW_DIST = "webview/dist/index.html";

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

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly services: PanelServices = {},
  ) {
    this.store = new SessionStore({ post: (m) => this.postToWebview(m) });
  }

  dispose(): void {
    this.disposed = true;
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
        await this.client?.setMode(this.store.getState().sessionId ?? "", msg.modeId);
        break;
      case "setModel":
        await this.client?.setModel(this.store.getState().sessionId ?? "", msg.modelId);
        this.store.sessionMeta({ currentModelId: msg.modelId });
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
    }
  }

  private postToWebview(message: unknown): void {
    if (this.view) void this.view.webview.postMessage(message);
  }

  private postSnapshot(): void {
    this.postToWebview({ type: "snapshot", state: structuredClone(this.store.getState()) satisfies SessionState as unknown });
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
              this.store.markError("iFlow CLI 进程已退出，重新打开面板可重试");
            }
          },
          onRequestPermission: async (req: RequestPermissionRequest) =>
            this.defaultPermission(req),
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

  private async defaultPermission(_req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    // M1: no approval UI yet — reject everything (matches harness safe mode).
    return { outcome: { outcome: "cancelled" } };
  }

  private async startNewSession(): Promise<void> {
    const client = await this.ensureClient();
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.context.extensionUri.fsPath;
    const session = await client.newSession({ cwd: workspaceRoot, mcpServers: [] });
    const meta: NewSessionMeta | undefined = session._meta;
    const store = this.store;
    store.replaceState(newSessionState(store.getState()));
    store.sessionStarted({
      sessionId: session.sessionId,
      modes: session.modes,
      commands: meta?.availableCommands ?? [],
      models: (meta?.models?.availableModels ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        thinking: m.capabilities?.thinking,
      })),
      currentModelId: meta?.models?.currentModelId ?? null,
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
