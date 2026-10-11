import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { setConfigOverrides } from "./vscode-stub.js";
import type { SessionUsageUi } from "../shared/messages.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeContext(storageDir: string): vscodeTypes.ExtensionContext {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? (store.get(key) as T) : defaultValue),
    update: (key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    },
    keys: () => [...store.keys()],
    delete: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
  };
  return {
    subscriptions: [],
    secrets: {
      get: () => Promise.resolve(undefined),
      store: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    workspaceState: state,
    globalState: state,
    extensionUri: { fsPath: here },
    extensionPath: here,
    extensionMode: 3,
    logPath: here,
    storageUri: { fsPath: storageDir },
    globalStorageUri: { fsPath: storageDir },
    storagePath: storageDir,
    globalStoragePath: storageDir,
    asAbsolutePath: (p: string) => path.join(here, p),
  } as unknown as vscodeTypes.ExtensionContext;
}

type PostedMessage = { type: string; [k: string]: unknown };

type PanelInternals = {
  postToWebview: (message: PostedMessage) => void;
  evaluateContextWarning: () => void;
  store: {
    getState: () => { usage?: SessionUsageUi | null };
  };
};

function usage(window: number | null, used: number, estimated = false): SessionUsageUi {
  return {
    inputTokens: used,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: used,
    contextWindow: window,
    contextUsed: used,
    estimated,
  };
}

/**
 * M1 P0-6 occupancy-warning state machine display-truthfulness rules
 * (2026-10-11 fix):
 * - The persistent pill carries NO frozen percentage (a 99% pill surviving a
 *   compression that drops the live chip to 91% was the reported contradiction).
 * - An `estimated` (fallback-guess) window never warns, and a warning already
 *   up is withdrawn when the window becomes estimated.
 * - Hysteresis: fires ≥90%, exits <85%.
 */
describe("context occupancy warning state machine (P0-6)", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let posted: PostedMessage[];

  const toasts = () => posted.filter((m) => m.type === "toast");
  const dismisses = () => posted.filter((m) => m.type === "dismissToast");

  beforeEach(async () => {
    setConfigOverrides({ checkpoints: false });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-ctxwarn-storage-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here });
    p = panel as unknown as PanelInternals;
    posted = [];
    vi.spyOn(p, "postToWebview").mockImplementation((m: PostedMessage) => {
      posted.push(m);
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  const setUsage = (u: SessionUsageUi | null) => {
    (p.store.getState() as { usage?: SessionUsageUi | null }).usage = u;
  };

  it("fires a persistent compress pill at ≥90% (exact window)", () => {
    setUsage(usage(1000, 950));
    p.evaluateContextWarning();
    const fired = toasts();
    expect(fired).toHaveLength(1);
    expect(fired[0]!.level).toBe("warning");
    expect(fired[0]!.persistent).toBe(true);
    expect((fired[0]!.action as { actionId: string }).actionId).toBe("compress");
  });

  it("toast text carries no frozen percentage (chip owns live numbers)", () => {
    setUsage(usage(1000, 990));
    p.evaluateContextWarning();
    const message = String(toasts()[0]!.message);
    expect(message).not.toContain("%");
    expect(/\d/.test(message)).toBe(false);
  });

  it("stays silent below 90% and re-fires only once while active", () => {
    setUsage(usage(1000, 890));
    p.evaluateContextWarning();
    expect(toasts()).toHaveLength(0);

    setUsage(usage(1000, 950));
    p.evaluateContextWarning();
    p.evaluateContextWarning();
    expect(toasts()).toHaveLength(1);
  });

  it("hysteresis: stays up in the 85–90% band, dismisses below 85%", () => {
    setUsage(usage(1000, 950));
    p.evaluateContextWarning();
    expect(toasts()).toHaveLength(1);

    // Compression drops to 87% — inside the hysteresis band, pill stays.
    setUsage(usage(1000, 870));
    p.evaluateContextWarning();
    expect(dismisses()).toHaveLength(0);
    expect(toasts()).toHaveLength(1);

    // Below the exit floor — pill withdrawn.
    setUsage(usage(1000, 800));
    p.evaluateContextWarning();
    expect(dismisses()).toHaveLength(1);
    expect(dismisses()[0]!.toastId).toBe(toasts()[0]!.toastId);
  });

  it("estimated window never warns", () => {
    setUsage(usage(32768, 32000, true));
    p.evaluateContextWarning();
    expect(toasts()).toHaveLength(0);
  });

  it("estimated window withdraws an active warning (model switch away)", () => {
    setUsage(usage(1000, 950));
    p.evaluateContextWarning();
    expect(toasts()).toHaveLength(1);

    setUsage(usage(32768, 32000, true));
    p.evaluateContextWarning();
    expect(dismisses()).toHaveLength(1);

    // And does not re-fire while estimated, even at ratio ≥90%.
    p.evaluateContextWarning();
    expect(toasts()).toHaveLength(1);
  });

  it("missing usage or window does not warn", () => {
    setUsage(null);
    p.evaluateContextWarning();
    setUsage(usage(null, 5000));
    p.evaluateContextWarning();
    expect(toasts()).toHaveLength(0);
  });
});
