import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChatPanel } from "../src/panel/panel.js";
import { stripFileMentions } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import type * as vscode from "vscode";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Internal prompts (enhance / AI title) run DIRECTLY against the
 * OpenAI-compatible endpoint (src/acp/complete.ts) since the fourth-wave
 * fix (gateway-probed 2026-10-09, pitfall #26): the CLI's ~61K-token fixed
 * input pushed thinking models into 180s+ reasoning loops that never produce
 * content, while the same enhance task sent directly converged in 60.3s.
 * These tests mock the completion module and assert the panel-side contract:
 * salvage semantics, busy gating, and @-reference neutralisation of the draft.
 */

// --- streamChatCompletion mock ------------------------------------------------

type CompletionResult = { text: string; reason: "complete" | "timeout" | "stalled" | "failed" };

const completionMock = vi.hoisted(() => {
  const state: {
    calls: Array<{ model: string; prompt: string; timeoutMs: number; idleMs: number }>;
    next: () => Promise<CompletionResult>;
  } = { calls: [], next: () => Promise.resolve({ text: "", reason: "failed" }) };
  return {
    state,
    streamChatCompletion: (
      _endpoint: unknown,
      model: string,
      prompt: string,
      opts: { timeoutMs: number; idleMs: number },
    ) => {
      state.calls.push({ model, prompt, timeoutMs: opts.timeoutMs, idleMs: opts.idleMs });
      return state.next();
    },
  };
});

vi.mock("../src/acp/complete.js", () => ({
  streamChatCompletion: completionMock.streamChatCompletion,
}));

function queueCompletion(result: CompletionResult | (() => Promise<CompletionResult>)) {
  completionMock.state.next = typeof result === "function" ? result : () => Promise.resolve(result);
}

// --- panel scaffolding ----------------------------------------------------------

const TEST_CREDS = { baseUrl: "https://gateway.test/v1", apiKey: "sk-test-1234", modelName: "test-model" };

function makeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? store.get(key) : defaultValue) as T,
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
      // Panel-owned credentials live here (auth.ts AUTH_SECRET_KEY); the
      // panel must never fall back to the real ~/.iflow/settings.json in
      // tests, so this always returns a valid profile.
      get: (key: string) =>
        Promise.resolve(key === "iflow.openai-compatible" ? JSON.stringify(TEST_CREDS) : undefined),
      store: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    workspaceState: state,
    globalState: state,
    extensionUri: { fsPath: here },
    extensionPath: here,
    extensionMode: 3,
    logPath: here,
    storageUri: { fsPath: here },
    globalStorageUri: { fsPath: here },
    storagePath: here,
    globalStoragePath: here,
    asAbsolutePath: (p: string) => path.join(here, p),
  } as unknown as vscode.ExtensionContext;
}

function makeWatchers(): NonNullable<PanelServices["watchers"]> {
  const noop = () => ({ dispose: () => {} });
  return [
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
  ];
}

type PanelInternals = {
  runInternalPrompt: (text: string) => Promise<string | null>;
  enhancePrompt: (requestId: number, text: string) => Promise<void>;
  internalPromptTimeoutMs: number;
  internalPromptIdleMs: number;
  postToWebview: (message: unknown) => void;
};

const internals = (panel: ChatPanel) => panel as unknown as PanelInternals;

function makePanel() {
  const panel = new ChatPanel(makeContext(), { workspaceRoot: here, watchers: makeWatchers() });
  const posted: Array<{ type?: string; error?: string; text?: string }> = [];
  internals(panel).postToWebview = (message) => {
    posted.push(message as { type?: string; error?: string; text?: string });
  };
  return { panel, posted };
}

// --- stripFileMentions -----------------------------------------------------------

describe("stripFileMentions (internal-prompt @-reference neutraliser)", () => {
  it("drops the @ but keeps the path text", () => {
    expect(stripFileMentions("@docs/feature-roadmap-2026-10.md 开始实施M2")).toBe("docs/feature-roadmap-2026-10.md 开始实施M2");
    expect(stripFileMentions("看下 src/a.ts 和 @src/a.ts 的问题")).toBe("看下 src/a.ts 和 src/a.ts 的问题");
    expect(stripFileMentions("@README.md 开头")).toBe("README.md 开头");
    expect(stripFileMentions("路径在末尾 @docs/z.md")).toBe("路径在末尾 docs/z.md");
    expect(stripFileMentions("（@src/x.ts）")).toBe("（src/x.ts）");
  });

  it("leaves emails, mentions and bare @ untouched", () => {
    expect(stripFileMentions("联系 a@b.com 确认")).toBe("联系 a@b.com 确认");
    expect(stripFileMentions("@张三 你好")).toBe("@张三 你好");
    expect(stripFileMentions("@ 单独符号")).toBe("@ 单独符号");
    expect(stripFileMentions("修复@src/y.ts问题")).toBe("修复@src/y.ts问题"); // mid-word @ is not a composer mention
  });
});

// --- direct-gateway internal prompts ---------------------------------------------

describe("ChatPanel internal prompt via direct gateway (enhance regression)", () => {
  let panel: ChatPanel;
  let posted: Array<{ type?: string; error?: string; text?: string }>;

  beforeEach(() => {
    completionMock.state.calls = [];
    queueCompletion({ text: "", reason: "failed" });
    panel = makePanel().panel;
    posted = [];
    internals(panel).postToWebview = (message) => {
      posted.push(message as { type?: string; error?: string; text?: string });
    };
  });

  afterEach(async () => {
    await panel.dispose();
  });

  it("returns the completion text on a clean stop", async () => {
    queueCompletion({ text: " rewritten ", reason: "complete" });
    expect(await internals(panel).runInternalPrompt("rewrite this")).toBe("rewritten");
    const call = completionMock.state.calls[0];
    expect(call?.model).toBe(TEST_CREDS.modelName);
    expect(call?.prompt).toBe("rewrite this");
  });

  it("salvages partial text when the ceiling fires (slow gateway, no turn-stop)", async () => {
    // Gateway-probed 2026-10-09: tencent/hy3 via Y-API streamed the FULL
    // enhanced rewrite at 60-75s but the turn-stop never arrived — the
    // ceiling must return what streamed instead of discarding it.
    queueCompletion({ text: "enhanced text", reason: "timeout" });
    expect(await internals(panel).runInternalPrompt("rewrite this")).toBe("enhanced text");
  });

  it("salvages partial text when the stream stalls", async () => {
    queueCompletion({ text: "half an answer", reason: "stalled" });
    expect(await internals(panel).runInternalPrompt("rewrite this")).toBe("half an answer");
  });

  it("returns null on a stalled stream with no text", async () => {
    queueCompletion({ text: "", reason: "stalled" });
    expect(await internals(panel).runInternalPrompt("rewrite this")).toBeNull();
  });

  it("discards partial text on transport failure", async () => {
    // A transport error's partial is not trustworthy — unlike timeout/stalled
    // it must not be salvaged.
    queueCompletion({ text: "corrupted…", reason: "failed" });
    expect(await internals(panel).runInternalPrompt("rewrite this")).toBeNull();
  });

  it("passes the configured ceiling and idle windows through", async () => {
    const p = internals(panel);
    p.internalPromptTimeoutMs = 1234;
    p.internalPromptIdleMs = 567;
    queueCompletion({ text: "ok", reason: "complete" });
    await p.runInternalPrompt("x");
    const call = completionMock.state.calls[0];
    expect(call?.timeoutMs).toBe(1234);
    expect(call?.idleMs).toBe(567);
  });

  it("fails fast while another internal prompt is in flight", async () => {
    let release: (v: CompletionResult) => void = () => {};
    queueCompletion(() => new Promise((resolve) => (release = resolve)));
    const first = internals(panel).runInternalPrompt("first");
    await vi.waitFor(() => expect(completionMock.state.calls).toHaveLength(1));
    expect(await internals(panel).runInternalPrompt("second")).toBeNull();
    expect(completionMock.state.calls).toHaveLength(1);
    release({ text: "done", reason: "complete" });
    expect(await first).toBe("done");
  });

  it("neutralises @file references in the draft before sending", async () => {
    // The `@` marker itself (not the path words) invites the thinking model's
    // "should I read the file first" loop (gateway-probed 2026-10-09); the
    // direct call keeps the guard so the cheap rewrite stays cheap.
    queueCompletion({ text: "ok", reason: "complete" });
    await internals(panel).enhancePrompt(1, "@docs/feature-roadmap-2026-10.md 开始实施M2");
    const sent = completionMock.state.calls[0]?.prompt ?? "";
    expect(sent).not.toContain("@docs/");
    expect(sent).toContain("docs/feature-roadmap-2026-10.md");
    expect(sent).toContain("开始实施M2");
  });

  it("posts the enhancement on success", async () => {
    queueCompletion({ text: "改写后的请求", reason: "complete" });
    await internals(panel).enhancePrompt(1, "帮我写一个周报模板");
    const msg = posted.find((m) => m.type === "enhancedPrompt");
    expect(msg?.text).toBe("改写后的请求");
    expect(msg?.error).toBeUndefined();
  });

  it("posts the salvaged text as a success", async () => {
    queueCompletion({ text: "改写后的请求", reason: "timeout" });
    await internals(panel).enhancePrompt(1, "帮我写一个周报模板");
    const msg = posted.find((m) => m.type === "enhancedPrompt");
    expect(msg?.text).toBe("改写后的请求");
    expect(msg?.error).toBeUndefined();
  });

  it("posts a generic failure message when nothing streamed", async () => {
    queueCompletion({ text: "", reason: "failed" });
    await internals(panel).enhancePrompt(1, "随便写点什么");
    const msg = posted.find((m) => m.type === "enhancedPrompt");
    expect(msg?.error).toContain("增强失败");
    expect(msg?.text).toBe("");
  });
});