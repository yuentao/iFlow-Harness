import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChatPanel } from "../src/panel/panel.js";
import { stripFileMentions } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import type * as vscode from "vscode";
import { setConfigOverrides, workspace } from "./vscode-stub.js";
import { clampSessionLabel } from "../shared/session-state.js";
import { buildFollowupPrompt, parseFollowupResponse } from "../shared/turn-followup.js";
import type { Block } from "../shared/messages.js";

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

type CompletionResult = {
  text: string;
  reason: "complete" | "timeout" | "stalled" | "failed" | "cancelled";
};

const completionMock = vi.hoisted(() => {
  const state: {
    calls: Array<{
      model: string;
      prompt: string;
      timeoutMs: number;
      idleMs: number;
      signal?: { aborted: boolean; onAbort?: (cancel: () => void) => void };
    }>;
    next: () => Promise<CompletionResult>;
  } = { calls: [], next: () => Promise.resolve({ text: "", reason: "failed" }) };
  return {
    state,
    streamChatCompletion: (
      _endpoint: unknown,
      model: string,
      prompt: string,
      opts: {
        timeoutMs: number;
        idleMs: number;
        signal?: { aborted: boolean; onAbort?: (cancel: () => void) => void };
      },
    ) => {
      state.calls.push({ model, prompt, timeoutMs: opts.timeoutMs, idleMs: opts.idleMs, signal: opts.signal });
      const pending = state.next();
      // Mirror the real module: an onAbort hook receives a synchronous
      // settle-canceller, so a user cancel releases the panel lane at once.
      if (opts.signal?.onAbort) {
        let settle: (r: CompletionResult) => void = () => {};
        const tracked = new Promise<CompletionResult>((resolve) => {
          settle = resolve;
          pending.then(resolve);
        });
        opts.signal.onAbort(() => settle({ text: "", reason: "cancelled" }));
        return tracked;
      }
      return pending;
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
  cancelEnhance: (requestId: number) => void;
  internalPromptTimeoutMs: number;
  internalPromptIdleMs: number;
  postToWebview: (message: unknown) => void;
  pendingEnhance: { requestId: number; cancel: () => void; sessionId: string | null } | null;
  store: { getState: () => { activeSessionId: string | null; sessionId: string | null } };
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

// --- enhance anti-footgun (cancel / session isolation) --------------------------

describe("ChatPanel enhance cancellation & session isolation", () => {
  let panel: ChatPanel;
  let posted: Array<{ type?: string; error?: string; text?: string; requestId?: number }>;
  let internalsPanel: PanelInternals;

  beforeEach(() => {
    completionMock.state.calls = [];
    queueCompletion({ text: "", reason: "failed" });
    const made = makePanel();
    panel = made.panel;
    internalsPanel = internals(panel);
    posted = [];
    internalsPanel.postToWebview = (message) => {
      posted.push(message as { type?: string; error?: string; text?: string; requestId?: number });
    };
  });

  afterEach(async () => {
    await panel.dispose();
  });

  /** Start an enhance whose completion hangs until `release` resolves. */
  async function startHangingEnhance(requestId = 7) {
    let release: (v: CompletionResult) => void = () => {};
    queueCompletion(() => new Promise((resolve) => (release = resolve)));
    const running = internalsPanel.enhancePrompt(requestId, "帮我写个周报");
    await vi.waitFor(() => expect(completionMock.state.calls).toHaveLength(1));
    return { running, release };
  }

  it("cancelEnhance aborts the stream and never replies", async () => {
    const { running, release } = await startHangingEnhance(7);
    internalsPanel.cancelEnhance(7);
    // The onAbort hook settles the completion synchronously → the enhance
    // promise resolves without ever posting a reply.
    await running;
    release({ text: "late", reason: "complete" });
    expect(posted.filter((m) => m.type === "enhancedPrompt")).toHaveLength(0);
    expect(internalsPanel.pendingEnhance).toBeNull();
  });

  it("releases the internal lane immediately on cancel (no busy-reject on retry)", async () => {
    const { running } = await startHangingEnhance(7);
    internalsPanel.cancelEnhance(7);
    await running;
    // A fresh enhance right after a cancel must get through (busy released
    // in the same tick via the abort hook, not after a 500ms poll).
    queueCompletion({ text: "第二次改写", reason: "complete" });
    await internalsPanel.enhancePrompt(8, "再来一次");
    expect(completionMock.state.calls).toHaveLength(2);
    const msg = posted.find((m) => m.type === "enhancedPrompt" && m.requestId === 8);
    expect(msg?.text).toBe("第二次改写");
  });

  it("ignores a cancel for a stale requestId", async () => {
    const { running, release } = await startHangingEnhance(7);
    internalsPanel.cancelEnhance(6); // superseded request — must NOT abort 7
    expect(internalsPanel.pendingEnhance?.requestId).toBe(7);
    release({ text: "改写完成", reason: "complete" });
    await running;
    const msg = posted.find((m) => m.type === "enhancedPrompt");
    expect(msg?.text).toBe("改写完成");
  });

  it("drops the reply when the session changed mid-rewrite (no ghost fill)", async () => {
    const { running, release } = await startHangingEnhance(7);
    // User switches sessions while the rewrite is in flight.
    internalsPanel.store.getState().activeSessionId = "other-session";
    release({ text: "迟到的改写", reason: "complete" });
    await running;
    expect(posted.filter((m) => m.type === "enhancedPrompt")).toHaveLength(0);
  });

  it("replies when the session is unchanged", async () => {
    const { running, release } = await startHangingEnhance(7);
    release({ text: "正常回填", reason: "complete" });
    await running;
    const msg = posted.find((m) => m.type === "enhancedPrompt");
    expect(msg?.text).toBe("正常回填");
  });
});

// --- merged turn-end follow-up (title + next steps + memory in ONE call) ------

describe("turn-followup prompt & envelope (pure)", () => {
  it("lists only the requested keys and sections", () => {
    const prompt = buildFollowupPrompt({
      nextSteps: { user: "修一下登录报错", assistant: "已修复并跑了测试", toolTitles: ["run_shell_command"] },
    });
    expect(prompt).toContain('"nextSteps"');
    expect(prompt).not.toContain('"title"');
    expect(prompt).not.toContain('"facts"');
    expect(prompt).toContain("【下一步】");
    expect(prompt).not.toContain("【标题】");
    expect(prompt).toContain("本轮工具调用：run_shell_command");
  });

  it("parses a fenced envelope and keeps the raw reply for the memory task", () => {
    const raw = '```json\n{"title":"重构登录流程","nextSteps":["跑测试"]}\n```';
    const result = parseFollowupResponse(raw, ["title", "nextSteps", "memory"]);
    expect(result.title).toBe("重构登录流程");
    expect(result.nextSteps).toEqual(["跑测试"]);
    expect(result.memoryRaw).toContain("重构登录流程");
  });

  it("falls back to per-key digging when the envelope is malformed", () => {
    const raw = '{"title":"登录改用 PKCE", "nextSteps": ["继续实现", "运行测试"], broken';
    const result = parseFollowupResponse(raw, ["title", "nextSteps"]);
    expect(result.title).toBe("登录改用 PKCE");
    expect(result.nextSteps).toEqual(["继续实现", "运行测试"]);
  });

  it("never fabricates a part from a non-JSON reply", () => {
    const result = parseFollowupResponse("好的，我来看看这几点。", ["title", "nextSteps"]);
    expect(result.title).toBeNull();
    expect(result.nextSteps).toEqual([]);
  });

  it("keeps a part absent when its task was not requested", () => {
    const raw = JSON.stringify({ title: "标题内容", nextSteps: ["继续"] });
    expect(parseFollowupResponse(raw, ["nextSteps"]).title).toBeNull();
    expect(parseFollowupResponse(raw, ["title"]).nextSteps).toEqual([]);
    expect(parseFollowupResponse(raw, ["title"]).memoryRaw).toBeNull();
  });
});

describe("ChatPanel merged turn-end follow-up (one gateway call)", () => {
  type SessionEntry = { id: string; label: string; updatedAt: number };
  type FollowupInternals = {
    runTurnFollowup: (
      sessionId: string,
      opts: { allowTitle: boolean; conversationTasks: boolean },
    ) => Promise<void>;
    enhancePrompt: (requestId: number, text: string) => Promise<void>;
    store: {
      getState: () => {
        sessionId: string;
        activeSessionId: string | null;
        sessions: SessionEntry[];
        blocks: Block[];
        status: string;
        nextStepSuggestions?: string[];
        nextStepLoading?: boolean;
      };
      sessionStarted: (meta: { sessionId: string }) => void;
      setSessions: (sessions: SessionEntry[], activeSessionId?: string | null) => void;
    };
    memory: {
      isExtractionEligible: (sessionId: string, blocks: Block[]) => boolean;
      buildExtractionInput: (blocks: Block[]) => Promise<{ conversation: string; existingFacts: string[] } | null>;
      beginExtraction: () => number | null;
      finishExtraction: (toastId: number | null) => void;
      applyExtractionResult: (raw: string, sessionId: string, existingFacts: readonly string[]) => void;
    };
    titledSessionIds: Set<string>;
    persistSessions: (sessions: unknown, activeSessionId: string | null) => Promise<void>;
    persistActiveTranscript: (labelSync?: boolean) => Promise<void>;
  };

  const SESSION_ID = "followup-session";
  const FIRST_REQUEST = "把登录流程改成 PKCE，并补上测试";

  let panel: ChatPanel;
  let p: FollowupInternals;

  beforeEach(() => {
    completionMock.state.calls = [];
    queueCompletion({ text: "", reason: "failed" });
    setConfigOverrides({
      checkpoints: false,
      autoTitle: true,
      nextStepSuggestions: true,
      autoMemoryCapture: true,
    });
    panel = makePanel().panel;
    p = panel as unknown as FollowupInternals;
    // Persistence is fs-bound in production; these tests assert the store only.
    p.persistSessions = async () => {};
    p.persistActiveTranscript = async () => {};
    // Mirror the real service gates: the auto-capture setting plus the session
    // id, without touching the real ~/.iflow discovery.
    vi.spyOn(p.memory, "isExtractionEligible").mockImplementation((sessionId) =>
      p.store.getState().sessionId === sessionId &&
      workspace.getConfiguration("iflow").get<boolean>("autoMemoryCapture", true),
    );
    vi.spyOn(p.memory, "buildExtractionInput").mockResolvedValue({
      conversation: "用户：把登录流程改成 PKCE，并补上测试",
      existingFacts: [],
    });
    vi.spyOn(p.memory, "beginExtraction").mockReturnValue(null);
    vi.spyOn(p.memory, "finishExtraction").mockImplementation(() => {});
    vi.spyOn(p.memory, "applyExtractionResult").mockImplementation(() => {});
    p.store.sessionStarted({ sessionId: SESSION_ID });
    p.store.getState().blocks.push(
      { kind: "user", text: FIRST_REQUEST },
      { kind: "text", text: "已改完，测试通过。" },
    );
    p.store.getState().status = "idle";
    // A still-mechanical label is the only one the title task may replace.
    p.store.setSessions([{ id: SESSION_ID, label: clampSessionLabel(FIRST_REQUEST), updatedAt: 1 }], SESSION_ID);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setConfigOverrides({});
    await panel.dispose();
  });

  it("fires ONE call carrying every enabled task and dispatches all three parts", async () => {
    queueCompletion({
      text: JSON.stringify({
        title: "登录改用 PKCE",
        nextSteps: ["运行测试", "查看改动"],
        facts: [{ text: "项目统一用 pnpm 安装依赖", scope: "global", category: "convention", confidence: 0.9 }],
      }),
      reason: "complete",
    });
    await p.runTurnFollowup(SESSION_ID, { allowTitle: true, conversationTasks: true });

    expect(completionMock.state.calls).toHaveLength(1);
    const sent = completionMock.state.calls[0]?.prompt ?? "";
    expect(sent).toContain("【标题】");
    expect(sent).toContain("【下一步】");
    expect(sent).toContain("【长期记忆】");
    expect(sent).toContain('"facts"');

    expect(p.store.getState().sessions[0]?.label).toBe("登录改用 PKCE");
    expect(p.store.getState().nextStepSuggestions).toEqual(["运行测试", "查看改动"]);
    expect(p.store.getState().nextStepLoading).toBe(false);
    expect(p.memory.applyExtractionResult).toHaveBeenCalledTimes(1);
    expect(p.memory.beginExtraction).toHaveBeenCalledTimes(1);
    expect(p.memory.finishExtraction).toHaveBeenCalledTimes(1);
    expect(p.titledSessionIds.has(SESSION_ID)).toBe(true);
  });

  it("asks for exactly the enabled tasks", async () => {
    setConfigOverrides({
      checkpoints: false,
      autoTitle: false,
      nextStepSuggestions: true,
      autoMemoryCapture: false,
    });
    queueCompletion({ text: JSON.stringify({ nextSteps: ["运行测试"] }), reason: "complete" });
    await p.runTurnFollowup(SESSION_ID, { allowTitle: true, conversationTasks: true });

    expect(completionMock.state.calls).toHaveLength(1);
    const sent = completionMock.state.calls[0]?.prompt ?? "";
    expect(sent).toContain("【下一步】");
    expect(sent).not.toContain("【标题】");
    expect(sent).not.toContain("【长期记忆】");
    expect(p.store.getState().sessions[0]?.label).toBe(clampSessionLabel(FIRST_REQUEST));
    expect(p.store.getState().nextStepSuggestions).toEqual(["运行测试"]);
    expect(p.memory.applyExtractionResult).not.toHaveBeenCalled();
  });

  it("sends nothing when no task is eligible", async () => {
    setConfigOverrides({
      checkpoints: false,
      autoTitle: false,
      nextStepSuggestions: false,
      autoMemoryCapture: false,
    });
    await p.runTurnFollowup(SESSION_ID, { allowTitle: true, conversationTasks: true });
    expect(completionMock.state.calls).toHaveLength(0);
    expect(p.memory.beginExtraction).not.toHaveBeenCalled();
  });

  it("skips the whole batch while an enhance is in flight, and retries the title next turn", async () => {
    let release: (v: CompletionResult) => void = () => {};
    queueCompletion(() => new Promise((resolve) => (release = resolve)));
    const enhance = p.enhancePrompt(9, "帮我写个周报");
    await vi.waitFor(() => expect(completionMock.state.calls).toHaveLength(1));

    await p.runTurnFollowup(SESSION_ID, { allowTitle: true, conversationTasks: true });
    expect(completionMock.state.calls).toHaveLength(1);
    // Not registered: the next turn's completion still gets a title attempt.
    expect(p.titledSessionIds.has(SESSION_ID)).toBe(false);

    release({ text: "改写完成", reason: "complete" });
    await enhance;
    queueCompletion({ text: JSON.stringify({ title: "登录改用 PKCE" }), reason: "complete" });
    await p.runTurnFollowup(SESSION_ID, { allowTitle: true, conversationTasks: true });
    expect(completionMock.state.calls).toHaveLength(2);
    expect(p.store.getState().sessions[0]?.label).toBe("登录改用 PKCE");
  });

  it("drops the chips when the transcript moved while the call was in flight", async () => {
    queueCompletion(async () => {
      // A new user turn landed while the merged request was running.
      p.store.getState().blocks.push({ kind: "user", text: "换个问题" });
      return { text: JSON.stringify({ nextSteps: ["运行测试"] }), reason: "complete" };
    });
    await p.runTurnFollowup(SESSION_ID, { allowTitle: false, conversationTasks: true });
    expect(p.store.getState().nextStepSuggestions).toEqual([]);
    expect(p.store.getState().nextStepLoading).toBe(false);
  });

  it("runs with the loosest ceiling among the tasks it carries", async () => {
    queueCompletion({ text: "{}", reason: "complete" });
    await p.runTurnFollowup(SESSION_ID, { allowTitle: true, conversationTasks: true });
    const batch = completionMock.state.calls[0];
    expect(batch?.timeoutMs).toBe(180_000);
    expect(batch?.idleMs).toBe(90_000);

    completionMock.state.calls = [];
    setConfigOverrides({
      checkpoints: false,
      autoTitle: false,
      nextStepSuggestions: true,
      autoMemoryCapture: false,
    });
    await p.runTurnFollowup(SESSION_ID, { allowTitle: false, conversationTasks: true });
    expect(completionMock.state.calls[0]?.timeoutMs).toBe(25_000);
    expect(completionMock.state.calls[0]?.idleMs).toBe(12_000);
  });
});