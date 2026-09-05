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
      await vscode.commands.executeCommand("iflow-chat.Chat.focus");
    }),
    vscode.commands.registerCommand("iflow.newSession", () => {
      void panel["handleWebviewMessage"]({ type: "newSession" } as never);
    }),
  );
}

export function deactivate(): void {
  // ChatPanel.dispose runs via context.subscriptions.
}
