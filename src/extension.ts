import * as vscode from "vscode";
import { ChatPanel } from "./panel/panel.js";

export function activate(context: vscode.ExtensionContext): void {
  const panel = new ChatPanel(context);
  context.subscriptions.push(panel);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanel.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("iflow.openPanel", async () => {
      // Open as a wide, resizable editor tab (falls back to the sidebar view
      // via the activity bar icon when a narrow panel is preferred).
      panel.openEditorTab();
    }),
    vscode.commands.registerCommand("iflow.newSession", () => {
      void panel["handleWebviewMessage"]({ type: "newSession" } as never);
    }),
    vscode.commands.registerCommand("iflow.askSelection", () => {
      const sel = readActiveSelection();
      if (sel) void panel.askSelection(sel.path, sel.range, sel.text);
    }),
    vscode.commands.registerCommand("iflow.addSelectionToContext", () => {
      const sel = readActiveSelection();
      if (sel) panel.addToContext(sel.path, sel.range, sel.text);
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
        const answer = await panel.chatForward(prompt, token);
        stream.appendMarkdown(answer);
        response.markdown(stream);
      } catch (error) {
        response.markdown(
          vscode.l10n.t("iFlow 出错：{0}", error instanceof Error ? error.message : String(error)),
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
  const rel = workspaceRoot ? abs.replace(workspaceRoot + "\\", "").replace(workspaceRoot + "/", "") : abs;
  const start = editor.selection.start.line + 1;
  const end = editor.selection.end.line + 1;
  const range = start === end ? `L${start}` : `L${start}-L${end}`;
  return { path: rel, range, text: editor.document.getText(editor.selection) };
}

export function deactivate(): void {
  // ChatPanel.dispose runs via context.subscriptions.
}
