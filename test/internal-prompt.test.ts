import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChatPanel } from "../src/panel/panel.js";
import { stripFileMentions } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import type * as vscode from "vscode";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * User-reported 2026-10-08: enhance ("增强提示词") failed every time with
 * "internal prompt timeout". The CLI-side session files (~/.iflow/acp/
 * sessions) showed the model treated the enhancement draft — which contained
 * an @file reference and an imperative ("@docs/…md 开始实现M2") — as a task to
 * EXECUTE: it called read_file, the tool result landed, and the turn then
 * stalled mid-task until the 60s internal ceiling fired. The panel now aborts
 * the moment the internal session issues a tool call, instead of waiting out
 * the ceiling, and reports the reason.
 */

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

/**
 * AcpClient double: newSession hands out one id, prompt hangs until the test
 * settles it (mirroring a model that stalls mid-task), cancel is recorded.
 */
function makeFakeClient() {
  const calls: string[] = [];
  const promptTexts: string[] = [];
  let settle: (v: unknown) => void = () => {};
  const promptPromise = new Promise((resolve) => {
    settle = resolve;
  });
  const client = {
    newSession: async () => {
      calls.push("newSession");
      return { sessionId: "internal-1" };
    },
    setModel: async () => {
      calls.push("setModel");
      return {};
    },
    setMode: async (_sid: string, modeId: string) => {
      calls.push(`setMode:${modeId}`);
      return {};
    },
    prompt: async (req: { prompt: Array<{ type: string; text?: string }> }) => {
      calls.push("prompt");
      promptTexts.push(req.prompt.map((c) => c.text ?? "").join(""));
      return promptPromise;
    },
    cancel: (sessionId: string) => {
      calls.push(`cancel:${sessionId}`);
    },
    dispose: async () => {},
  };
  return { client, calls, promptTexts, settle };
}

type PanelInternals = {
  client: unknown;
  connecting: Promise<void> | null;
  runInternalPrompt: (text: string) => Promise<string | null>;
  enhancePrompt: (requestId: number, text: string) => Promise<void>;
  lastInternalPromptFailure: string;
  onSessionUpdate: (n: unknown) => void;
  postToWebview: (message: unknown) => void;
};

const internals = (panel: ChatPanel) => panel as unknown as PanelInternals;

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

describe("ChatPanel internal prompt tool-call guard (enhance regression)", () => {
  let panel: ChatPanel;

  beforeEach(() => {
    panel = new ChatPanel(makeContext(), { workspaceRoot: here, watchers: makeWatchers() });
  });

  afterEach(async () => {
    await panel.dispose();
  });

  function inject(panel: ChatPanel) {
    const fake = makeFakeClient();
    const p = internals(panel);
    p.client = fake.client;
    p.connecting = null;
    const posted: Array<{ type?: string; error?: string; text?: string }> = [];
    p.postToWebview = (message) => {
      posted.push(message as { type?: string; error?: string; text?: string });
    };
    return { ...fake, p, posted };
  }

  it("aborts the internal prompt the moment its session issues a tool_call", async () => {
    const { p, calls, settle } = inject(panel);
    const resultPromise = p.runInternalPrompt("rewrite this");
    await vi.waitFor(() => expect(calls).toContain("prompt"));
    // The model treats the draft as a task to execute (the user-reported flow).
    p.onSessionUpdate({
      sessionId: "internal-1",
      update: { sessionUpdate: "tool_call", toolCallId: "t1", toolName: "read_file", status: "pending" },
    });
    // The guard rejects immediately — no waiting for the 60s ceiling.
    expect(await resultPromise).toBeNull();
    expect(p.lastInternalPromptFailure).toBe("tool-call");
    expect(calls).toContain("cancel:internal-1");
    // Non-YOLO mode is forced per internal session so a runaway model cannot
    // silently execute write/shell tools (request_permission auto-cancels).
    expect(calls).toContain("setMode:default");
    settle({ stopReason: "cancelled" });
  });

  it("aborts on tool_call_update too (--stream mode never sends the pending tool_call)", async () => {
    // Wire behavior (probed, CLI 0.5.19 bundle): with --stream the CLI skips
    // the pending tool_call announcement (`getStream() ||` short-circuits) and
    // only emits tool_call_update once the tool finished — the guard must
    // catch this shape or the abort silently never fires in the panel.
    const { p, calls, settle } = inject(panel);
    const resultPromise = p.runInternalPrompt("rewrite this");
    await vi.waitFor(() => expect(calls).toContain("prompt"));
    p.onSessionUpdate({
      sessionId: "internal-1",
      update: { sessionUpdate: "tool_call_update", toolCallId: "t1", toolName: "read_file", status: "completed" },
    });
    expect(await resultPromise).toBeNull();
    expect(p.lastInternalPromptFailure).toBe("tool-call");
    settle({ stopReason: "cancelled" });
  });

  it("reports a targeted error when the model treated the draft as a task", async () => {
    const { p, calls, posted, settle } = inject(panel);
    const done = p.enhancePrompt(1, "@docs/spec.md 开始实现");
    await vi.waitFor(() => expect(calls).toContain("prompt"));
    p.onSessionUpdate({
      sessionId: "internal-1",
      update: { sessionUpdate: "tool_call", toolCallId: "t1", toolName: "read_file", status: "pending" },
    });
    await done;
    const msg = posted.find((m) => m.type === "enhancedPrompt");
    expect(msg?.error).toContain("当成了要执行的任务");
    expect(msg?.text).toBe("");
    settle({ stopReason: "cancelled" });
  });

  it("neutralises @file references in the draft before sending (thinking-loop guard)", async () => {
    // Gateway-probed 2026-10-09: tencent/hy3 streamed reasoning_content only
    // (never content, never finish_reason) for 150s+ on "@docs/…md 开始实施M2"
    // — the `@` reference invites a "should I read the file first" loop that
    // blows past the internal ceiling. The bare path converges in ~33s, so
    // enhance must drop the `@` while keeping the path words.
    const { p, calls, promptTexts, settle } = inject(panel);
    const done = p.enhancePrompt(1, "@docs/feature-roadmap-2026-10.md 开始实施M2");
    await vi.waitFor(() => expect(calls).toContain("prompt"));
    const sent = promptTexts[0] ?? "";
    expect(sent).not.toContain("@docs/");
    expect(sent).toContain("docs/feature-roadmap-2026-10.md");
    expect(sent).toContain("开始实施M2");
    settle({ stopReason: "end_turn" });
    await done;
  });

  it("resolves with the agent text when no tool call occurs", async () => {
    const { p, calls, settle } = inject(panel);
    const resultPromise = p.runInternalPrompt("rewrite this");
    await vi.waitFor(() => expect(calls).toContain("prompt"));
    p.onSessionUpdate({
      sessionId: "internal-1",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking…" } },
    });
    p.onSessionUpdate({
      sessionId: "internal-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "rewritten" } },
    });
    settle({ stopReason: "end_turn" });
    expect(await resultPromise).toBe("rewritten");
    expect(p.lastInternalPromptFailure).toBe("none");
  });
});
