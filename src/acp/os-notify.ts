/**
 * M1 P0-5 — OS-level notification DELIVERY (the transport half; shared/notifications.ts
 * owns the trigger policy: setting × watching × throttle).
 *
 * The researched cross-platform solution is the binary pair node-notifier vendors
 * (SnoreToast-style toasts), spawned directly instead of through the library:
 *
 *   darwin  vendor/os-notify/mac.noindex/terminal-notifier.app/Contents/MacOS/
 *           terminal-notifier — Notification Center toast; `--open` click-through
 *           rides the vscode:// URI handler registered in extension.ts. Missing or
 *           failing → built-in `osascript display notification` fallback (works on
 *           every supported macOS, no click action).
 *   win32   vendor/os-notify/snoreToast/snoretoast-x{64,86}.exe — SnoreToast 0.7,
 *           Windows 8+ toast (VS Code 1.90+ requires Win10, so balloon fallbacks
 *           are moot). Wire behavior (probed, SnoreToast usage text in the bundled
 *           exe): exit 0 success, 1 hidden (Do-Not-Disturb), 2 dismissed, -1 failed
 *           — 0/1/2 all mean the toast was handed to the shell, count as delivered.
 *   other   returns false → the caller falls back to vscode.window.showInformationMessage.
 *
 * The binaries are copied at build time by esbuild.mjs from node_modules/node-notifier
 * into vendor/os-notify/ (gitignored vendor, same pattern as vendor/iflow-cli); the
 * node-notifier npm dependency exists ONLY to source them — it is never imported or
 * bundled at runtime. VSIX zip extraction can drop the exec bit, so the darwin path
 * chmods 0o755 before spawn (same fix-up as ensureVendorBinariesExecutable in
 * cli-locator.ts).
 *
 * Spawn discipline: argv arrays only, never a shell string. node-notifier's own
 * exec-string path is shell-escaping-buggy around quotes, and cmd.exe codepages
 * mangle Chinese; our messages carry arbitrary tool titles/error text, so both
 * hazards matter here.
 */

import { existsSync, chmodSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

/** Branding id for the toast (SnoreToast shows "SnoreToast" without -appID). */
const OS_NOTIFY_APP_ID = "iflow-harness";

/** Click-through target (macOS terminal-notifier only; SnoreToast has no click
 * action, the Windows toast is purely informational). The vscode:// scheme routes
 * by EXTENSION ID (publisher.name), handled by the URI handler registered in
 * extension.ts — not by the toast branding appID. */
export const OS_NOTIFY_OPEN_URI = "vscode://yuentao.iflow-harness/openPanel";

/** Toast bodies are one-liners; longer payloads are ellipsized. */
export const MAX_NOTIFY_CHARS = 180;

/** Kill guard: both binaries exit immediately; a hang means something wedged. */
const SPAWN_GUARD_MS = 5_000;

/**
 * One-line, control-char-free toast body: strips ANSI escapes (CLI error text
 * carries them), collapses newlines, caps length. Applied to BOTH title and
 * message so downstream escapers only ever see single-line plain text.
 */
export function sanitizeNotifyText(text: string): string {
  const cleaned = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length <= MAX_NOTIFY_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_NOTIFY_CHARS - 1)}…`;
}

/** Bundled terminal-notifier (universal binary, shipped inside the .app layout). */
export function darwinTerminalNotifierPath(extensionPath: string): string {
  return path.join(
    extensionPath,
    "vendor",
    "os-notify",
    "mac.noindex",
    "terminal-notifier.app",
    "Contents",
    "MacOS",
    "terminal-notifier",
  );
}

/** Bundled SnoreToast exe; arch picked like node-notifier's toaster does (os.arch). */
export function windowsSnoreToastPath(extensionPath: string): string {
  const exe = process.arch === "x64" ? "snoretoast-x64.exe" : "snoretoast-x86.exe";
  return path.join(extensionPath, "vendor", "os-notify", "snoreToast", exe);
}

/**
 * Our branded icon for the Windows toast (`-p`): local png ≤1024×1024 and ≤200KB
 * (Toast system limits; media/icon.png is ~6KB). macOS always shows the sending
 * app's icon, so the terminal-notifier path gets no image argument.
 */
function snoreToastIconPath(extensionPath: string): string | undefined {
  const icon = path.join(extensionPath, "media", "icon.png");
  return existsSync(icon) ? icon : undefined;
}

/** terminal-notifier flags (probed, terminal-notifier 1.x usage): `-group` makes
 * same-group notifications REPLACE each other — a burst of events shows one toast. */
export function buildTerminalNotifierArgs(title: string, message: string, openUrl = OS_NOTIFY_OPEN_URI): string[] {
  const args = ["-title", title, "-message", message, "-group", OS_NOTIFY_APP_ID];
  if (openUrl) args.push("-open", openUrl);
  return args;
}

/** SnoreToast 0.7 short flags (probed from the bundled exe's UTF-16 usage block).
 * `-silent`: the webview chime already carries the audio cue for every state,
 * a second sound from the toast would double-ping away users. */
export function buildSnoreToastArgs(title: string, message: string, icon?: string): string[] {
  const args = ["-t", title, "-m", message, "-appID", OS_NOTIFY_APP_ID, "-silent"];
  if (icon) args.push("-p", icon);
  return args;
}

/** osascript fallback script; the message is already sanitized single-line text,
 * only the embedding double-quotes and backslashes need escaping (argv, no shell). */
export function buildOsascriptNotificationScript(title: string, message: string): string {
  const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
  return `display notification ${quote(message)} with title ${quote(title)}`;
}

/** VSIX zip extraction can lose the exec bit — chmod before spawn, best effort
 * (a still-unusable binary surfaces as the spawn 'error' event → fallback). */
function ensureExecutable(bin: string): void {
  try {
    chmodSync(bin, 0o755);
  } catch {
    // best effort
  }
}

/** Run a notification binary quietly with an argv array; resolves its exit code
 * (-1 for spawn failure / kill-guard timeout). Never rejects, never throws. */
function runQuiet(exe: string, args: string[]): Promise<number> {
  return new Promise((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(exe, args, { windowsHide: true });
    } catch {
      resolvePromise(-1);
      return;
    }
    let settled = false;
    const guard = setTimeout(() => {
      if (settled) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, SPAWN_GUARD_MS);
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolvePromise(-1);
    });
    child.on("exit", (_error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolvePromise(typeof code === "number" ? code : -1);
    });
  });
}

/**
 * Deliver one OS-level notification. Returns whether a SYSTEM toast was handed to
 * the OS — false means the caller should fall back to the in-IDE
 * vscode.window.showInformationMessage (Linux, missing binary, wedged spawn).
 * Never throws: notification delivery must not break the flow that produced it.
 */
export async function sendOsNotification(extensionPath: string, rawTitle: string, rawMessage: string): Promise<boolean> {
  const title = sanitizeNotifyText(rawTitle) || "iFlow";
  const message = sanitizeNotifyText(rawMessage);
  if (!message) return false;
  if (process.platform === "darwin") {
    const bin = darwinTerminalNotifierPath(extensionPath);
    if (existsSync(bin)) {
      ensureExecutable(bin);
      if ((await runQuiet(bin, buildTerminalNotifierArgs(title, message))) === 0) return true;
    }
    return (await runQuiet("osascript", ["-e", buildOsascriptNotificationScript(title, message)])) === 0;
  }
  if (process.platform === "win32") {
    const bin = windowsSnoreToastPath(extensionPath);
    if (!existsSync(bin)) return false;
    const code = await runQuiet(bin, buildSnoreToastArgs(title, message, snoreToastIconPath(extensionPath)));
    // 0 success / 1 hidden (DND) / 2 dismissed all mean "handed to the shell";
    // only -1 (and other failures) warrant the in-IDE fallback.
    return code === 0 || code === 1 || code === 2;
  }
  return false;
}
