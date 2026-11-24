import * as vscode from "vscode";
import path from "node:path";
import { ChatPanel } from "./panel/panel.js";
import { getTerminalRecorder } from "./panel/terminal.js";
import { errorMessage } from "./acp/jsonrpc.js";

/** R6: module-level reference so `deactivate` can await the CLI teardown. */
let panel: ChatPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const chatPanel = new ChatPanel(context);
  panel = chatPanel;
  context.subscriptions.push(chatPanel);
  warnAboutUnregisteredSettings(context);

  // Terminal command capture for @terminal must not depend on the chat panel
  // being opened — attach the recorder at activation (no-op on VS Code < 1.93
  // or with shell integration disabled; @terminal then explains itself).
  context.subscriptions.push({ dispose: () => getTerminalRecorder().dispose() });
  getTerminalRecorder();

  // Warm start: spawn + initialize the CLI in the background right after
  // activation (onStartupFinished) so the first panel open reuses the live
  // client instead of waiting through the ~6s handshake. Gated by
  // iflow.warmStart; teardown rides the subscription dispose above.
  chatPanel.warmStart();

  // A7: same one-shot background maintenance slot — sweep staged-attachment
  // temp dirs idle for over a week (no setting; temp files are ephemeral).
  chatPanel.sweepStaleAttachments();

  // iflow.autoOpenPanel: open the chat tab on window start. The connect
  // inside openEditorTab is idempotent with warmStart's in-flight ensureClient.
  if (vscode.workspace.getConfiguration("iflow").get<boolean>("autoOpenPanel", false)) {
    chatPanel.openEditorTab();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("iflow.openPanel", async () => {
      // Open as a wide, resizable editor tab (falls back to the sidebar view
      // via the activity bar icon when a narrow panel is preferred).
      chatPanel.openEditorTab();
    }),
    vscode.commands.registerCommand("iflow.restartCli", () => {
      void chatPanel.restartCli();
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
    vscode.commands.registerCommand("iflow.rememberSelection", () => {
      const sel = readActiveSelection();
      if (sel) void chatPanel.rememberSelection(sel.path, sel.range, sel.text);
    }),
    // P1 记忆整理：手动触发一轮（绕过周期 / 空闲判定，仍遵守锁与「已在运行」）。
    vscode.commands.registerCommand("iflow.curateMemory", () => {
      void chatPanel.curateMemoryNow();
    }),
    // M1 P0-7: export the active session from the command palette too (the
    // panel's session dropdown carries the same action once M1 UI lands).
    vscode.commands.registerCommand("iflow.exportSessionMarkdown", () => {
      void chatPanel["handleWebviewMessage"]({ type: "exportSession", format: "markdown" } as never);
    }),
    vscode.commands.registerCommand("iflow.exportSessionJson", () => {
      void chatPanel["handleWebviewMessage"]({ type: "exportSession", format: "json" } as never);
    }),
    // M1 P1-4: redacted ACP wire log for offline analysis (harness --record
    // compatible NDJSON).
    vscode.commands.registerCommand("iflow.exportWireLog", () => {
      void chatPanel.exportWireLog();
    }),
  );

  // M1 P0-5: click-through for native macOS toasts (terminal-notifier `--open`
  // carries vscode://yuentao.iflow-harness/openPanel — src/acp/os-notify.ts).
  // SnoreToast on Windows has no click action, its toast is informational.
  vscode.window.registerUriHandler({
    handleUri: (uri) => {
      if (uri.path === "/openPanel") void vscode.commands.executeCommand("iflow.openPanel");
    },
  });

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
          vscode.l10n.t("iFlow 处理失败：{0}", errorMessage(error)),
        );
      }
    },
  );
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "iflow.svg");
  context.subscriptions.push(participant);
}

/** globalState key: extension version for which the "reload the window" warning
 * was already shown (one warning per upgrade, not one per activation). */
const UNREGISTERED_SETTINGS_WARNED_KEY = "iflow.unregisteredSettingsWarnedFor";

/**
 * An in-place extension upgrade only restarts the extension host: the window
 * keeps the previous manifest in its configuration registry, so keys the new
 * version added cannot be written until the window reloads ("not a registered
 * configuration"). Probe every declared `iflow.*` key here — the registry-only
 * `inspect().defaultValue` layer, since `get()` would also read the user's
 * settings.json — and warn once per version, before the user hits a failed
 * save.
 */
function warnAboutUnregisteredSettings(context: vscode.ExtensionContext): void {
  const pkg = context.extension?.packageJSON as
    | { version?: string; contributes?: { configuration?: unknown } }
    | undefined;
  const raw = pkg?.contributes?.configuration;
  const blocks = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Array<{
    properties?: Record<string, unknown>;
  }>;
  const declared = new Set<string>();
  for (const block of blocks) {
    for (const key of Object.keys(block?.properties ?? {})) {
      if (key.startsWith("iflow.")) declared.add(key);
    }
  }
  if (declared.size === 0) return;
  const version = pkg?.version ?? "";
  if (context.globalState.get<string>(UNREGISTERED_SETTINGS_WARNED_KEY) === version) return;
  const config = vscode.workspace.getConfiguration("iflow");
  const missing = [...declared].filter((key) => {
    const info = config.inspect(key.slice("iflow.".length));
    return info === undefined || info.defaultValue === undefined;
  });
  if (missing.length === 0) return;
  void context.globalState.update(UNREGISTERED_SETTINGS_WARNED_KEY, version);
  void vscode.window
    .showWarningMessage(
      vscode.l10n.t(
        "设置「{0}」属于刚更新的扩展版本，本窗口还没加载它的定义，已暂存并立即生效；请重启 VS Code（先试重新加载窗口，仍无效则完全退出再启动）。",
        missing[0] ?? "iflow.*",
      ),
      vscode.l10n.t("重新加载窗口"),
    )
    .then((choice) => {
      if (choice) void vscode.commands.executeCommand("workbench.action.reloadWindow");
    });
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
