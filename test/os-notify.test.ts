import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  MAX_NOTIFY_CHARS,
  OS_NOTIFY_OPEN_URI,
  buildOsascriptNotificationScript,
  buildSnoreToastArgs,
  buildTerminalNotifierArgs,
  darwinTerminalNotifierPath,
  sanitizeNotifyText,
  windowsSnoreToastPath,
} from "../src/acp/os-notify.js";

describe("sanitizeNotifyText", () => {
  it("strips ANSI escapes (CLI error text carries them) and collapses newlines", () => {
    expect(sanitizeNotifyText("a\x1b[31mred\x1b[0m\nb")).toBe("a red b");
  });

  it("caps the body with an ellipsis at MAX_NOTIFY_CHARS", () => {
    const out = sanitizeNotifyText("x".repeat(MAX_NOTIFY_CHARS + 10));
    expect(out.length).toBe(MAX_NOTIFY_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns the empty string for whitespace-only input (caller skips delivery)", () => {
    expect(sanitizeNotifyText("  \n\t ")).toBe("");
  });
});

describe("buildTerminalNotifierArgs", () => {
  it("uses terminal-notifier flags with the group + vscode:// click-through", () => {
    expect(buildTerminalNotifierArgs("t", "m")).toEqual([
      "-title",
      "t",
      "-message",
      "m",
      "-group",
      "iflow-harness",
      "-open",
      "vscode://yuentao.iflow-harness/openPanel",
    ]);
  });
});

describe("buildSnoreToastArgs", () => {
  it("uses SnoreToast 0.7 short flags, branded appID and -silent (chime carries audio)", () => {
    expect(buildSnoreToastArgs("t", "m")).toEqual([
      "-t",
      "t",
      "-m",
      "m",
      "-appID",
      "iflow-harness",
      "-silent",
    ]);
  });

  it("appends the branded icon only when one is provided", () => {
    expect(buildSnoreToastArgs("t", "m", "/abs/icon.png")).toEqual([
      "-t",
      "t",
      "-m",
      "m",
      "-appID",
      "iflow-harness",
      "-silent",
      "-p",
      "/abs/icon.png",
    ]);
  });
});

describe("buildOsascriptNotificationScript", () => {
  it("escapes backslashes then quotes for the embedded double-quoted strings", () => {
    expect(buildOsascriptNotificationScript('Ti"tle', 'msg \\ "x"')).toBe(
      'display notification "msg \\\\ \\"x\\"" with title "Ti\\"tle"'
    );
  });
});

describe("binary paths (vendor/os-notify, copied by esbuild.mjs at build time)", () => {
  it("darwin resolves the bundled terminal-notifier inside the .app layout", () => {
    expect(darwinTerminalNotifierPath(path.join(path.sep, "ext"))).toBe(
      path.join(
        path.sep,
        "ext",
        "vendor",
        "os-notify",
        "mac.noindex",
        "terminal-notifier.app",
        "Contents",
        "MacOS",
        "terminal-notifier",
      ),
    );
  });

  it("win32 picks the exe matching process.arch", () => {
    const exe = process.arch === "x64" ? "snoretoast-x64.exe" : "snoretoast-x86.exe";
    expect(windowsSnoreToastPath(path.join(path.sep, "ext"))).toBe(
      path.join(path.sep, "ext", "vendor", "os-notify", "snoreToast", exe),
    );
  });
});
