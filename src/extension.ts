import * as vscode from "vscode";
import path from "node:path";
import { ChatPanel } from "./panel/panel.js";
import { errorMessage } from "./acp/jsonrpc.js";

/** R6: module-level reference so `deactivate` can await the CLI teardown. */
let panel: ChatPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const chatPanel = new ChatPanel(context);
  panel = chatPanel;
  context.subscriptions.push(chatPanel);

  context.subscriptions.push(
    vscode.commands.registerCommand("iflow.openPanel", async () => {
      // Open as a wide, resizable editor tab (falls back to the sidebar view
      // via the activity bar icon when a narrow panel is preferred).
      chatPanel.openEditorTab();
    }),
    vscode.commands.registerCommand("iflow.newSession", () => {
      void chatPanel["handleWebviewMessage"]({ type: "newSession" } as never);
    }),
    vscode.commands.registerCommand("iflow.askSelection", () => {
      const sel = readActiveSelection();
      if (sel) void chatPanel.askSelection(sel.path, sel.range, sel.text);
    }),
    vscode.commands.registerCommand("iflow.addSelectionToContext", () => {
      const sel = readActiveSelection();
      if (sel) chatPanel.addToContext(sel.path, sel.range, sel.text);
    }),
  );

  // M5: @iflow chat participant — text-only fallback into the same session.
  const participant = vscode.chat.createChatParticipant(
    "iflow.agent",
    async (request, chatContext, response, token) => {
      void chatContext;
      const prompt = request.prompt;
      if (!prompt.trim()) return;
      const stream = new vscode.MarkdownString();
      response.progress(vscode.l10n.t("正在通过 iFlow 处理…"));
      try {
        const answer = await chatPanel.chatForward(prompt, token);
        stream.appendMarkdown(answer);
        response.markdown(stream);
      } catch (error) {
        response.markdown(
          vscode.l10n.t("iFlow 出错：{0}", errorMessage(error)),
        );
      }
    },
  );
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "iflow.svg");
  context.subscriptions.push(participant);
}

/** Active editor selection → {relative path, line range, text} (M5). */
function readActiveSelection(): { path: string; range: string; text: string } | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showInformationMessage(vscode.l10n.t("请先选中一段代码"));
    return null;
  }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const abs = editor.document.uri.fsPath;
  // C7: path.relative handles Windows drive-letter case drift (VSCode often
  // returns a lowercase drive while workspaceFolders keeps the user's casing
  // — a case-sensitive string replace would silently fail) and yields the
  // native separator; normalize to "/" for the wire display.
  const rel = workspaceRoot ? path.relative(workspaceRoot, abs).replace(/\\/g, "/") : abs;
  const start = editor.selection.start.line + 1;
  const end = editor.selection.end.line + 1;
  const range = start === end ? `L${start}` : `L${start}-L${end}`;
  return { path: rel, range, text: editor.document.getText(editor.selection) };
}

export async function deactivate(): Promise<void> {
  // R6: await the CLI child teardown (kill + SIGKILL fallback, up to ~3s) —
  // the subscription-based dispose is not awaited by the host, so the child
  // could otherwise outlive the extension host on shutdown.
  await panel?.dispose();
  panel = undefined;
}
