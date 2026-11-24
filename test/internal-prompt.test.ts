import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { ChatPanel } from "../src/panel/panel.js";
import { stripFileMentions } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import type * as vscode from "vscode";
import { setConfigOverrides, workspace } from "./vscode-stub.js";
import { clampSessionLabel } from "../shared/session-state.js";
import { buildFollowupPrompt, parseFollowupResponse } from "../shared/turn-followup.js";
import { buildAssetGenPrompt } from "../shared/asset-gen.js";
import { buildModelMetadataPrompt } from "../shared/model-metadata.js";
import { buildIncrementalKnowledgePrompt, buildKnowledgePrompt } from "../src/memory/knowledge.js";
import { loadPrompt, renderPrompt } from "../prompts/index.js";
import {
  MAX_MERGE_FACTS,
  suggestionsToActions,
  type MergeSuggestion,
  type RejectedMerge,
} from "../src/memory/curate-llm.js";
import { parseManagedFacts } from "../shared/memory-curate.js";
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

/**
 * 为连续多次模型调用排队回包：第 N 次 `completeInternalPrompt` 取第 N 个结果。
 * 用尽后返回 `failed`（空文本）—— L2 分批用例靠它逐批喂不同的 merges 信封。
 */
function queueSequence(results: Array<CompletionResult | (() => Promise<CompletionResult>)>) {
  let index = 0;
  completionMock.state.next = () => {
    const next = results[index++];
    if (next === undefined) return Promise.resolve({ text: "", reason: "failed" });
    return typeof next === "function" ? next() : Promise.resolve(next);
  };
}

// --- panel scaffolding ----------------------------------------------------------

const TEST_CREDS = { baseUrl: "https://gateway.test/v1", apiKey: "sk-test-1234", modelName: "test-model" };

function makeContext(storageDir: string): vscode.ExtensionContext {
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
    storageUri: { fsPath: storageDir },
    globalStorageUri: { fsPath: storageDir },
    storagePath: storageDir,
    globalStoragePath: storageDir,
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
  suggestMemoryMerges: (
    facts: string[],
  ) => Promise<{ suggestions: MergeSuggestion[]; rejected: RejectedMerge[] }>;
  internalPromptTimeoutMs: number;
  internalPromptIdleMs: number;
  postToWebview: (message: unknown) => void;
  pendingEnhance: { requestId: number; cancel: () => void; sessionId: string | null } | null;
  store: { getState: () => { activeSessionId: string | null; sessionId: string | null } };
  log: { lines: { level: string; message: string }[] };
};

const internals = (panel: ChatPanel) => panel as unknown as PanelInternals;

function makePanel(storageDir: string) {
  const panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
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
  let storageDir: string;

  beforeEach(async () => {
    completionMock.state.calls = [];
    queueCompletion({ text: "", reason: "failed" });
    storageDir = await mkdtemp(path.join(os.tmpdir(), "iflow-internal-prompt-storage-"));
    panel = makePanel(storageDir).panel;
    posted = [];
    internals(panel).postToWebview = (message) => {
      posted.push(message as { type?: string; error?: string; text?: string });
    };
  });

  afterEach(async () => {
    await panel.dispose();
    await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
  let storageDir: string;

  beforeEach(async () => {
    completionMock.state.calls = [];
    queueCompletion({ text: "", reason: "failed" });
    storageDir = await mkdtemp(path.join(os.tmpdir(), "iflow-enhance-storage-"));
    const made = makePanel(storageDir);
    panel = made.panel;
    internalsPanel = internals(panel);
    posted = [];
    internalsPanel.postToWebview = (message) => {
      posted.push(message as { type?: string; error?: string; text?: string; requestId?: number });
    };
  });

  afterEach(async () => {
    await panel.dispose();
    await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
    expect(prompt).toContain("[Next steps]");
    expect(prompt).not.toContain("[Title]");
    expect(prompt).toContain("Tool calls this turn: run_shell_command");
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

  it("digArray keeps a ] inside a suggestion instead of truncating the list", () => {
    const raw = '{"title":"t", "nextSteps": ["run ] step", "second"], broken';
    const result = parseFollowupResponse(raw, ["nextSteps"]);
    expect(result.nextSteps).toEqual(["run ] step", "second"]);
  });

  it("digArray keeps a [ inside a suggestion instead of losing the list", () => {
    const raw = '{"title":"t", "nextSteps": ["run [ step", "second"], broken';
    const result = parseFollowupResponse(raw, ["nextSteps"]);
    expect(result.nextSteps).toEqual(["run [ step", "second"]);
  });

  it("digArray honours escaped quotes inside a suggestion", () => {
    const raw = '{"title":"t", "nextSteps": ["say \\" quoted ] text"], broken';
    const result = parseFollowupResponse(raw, ["nextSteps"]);
    expect(result.nextSteps).toEqual(['say " quoted ] text']);
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
        superSessions?: Array<{ status: string }>;
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
  let storageDir: string;

  beforeEach(async () => {
    completionMock.state.calls = [];
    queueCompletion({ text: "", reason: "failed" });
    setConfigOverrides({
      checkpoints: false,
      autoTitle: true,
      nextStepSuggestions: true,
      autoMemoryCapture: true,
    });
    storageDir = await mkdtemp(path.join(os.tmpdir(), "iflow-followup-storage-"));
    panel = makePanel(storageDir).panel;
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
    await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
    expect(sent).toContain("[Title]");
    expect(sent).toContain("[Next steps]");
    expect(sent).toContain("[Long-term memory]");
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
    expect(sent).toContain("[Next steps]");
    expect(sent).not.toContain("[Title]");
    expect(sent).not.toContain("[Long-term memory]");
    expect(p.store.getState().sessions[0]?.label).toBe(clampSessionLabel(FIRST_REQUEST));
    expect(p.store.getState().nextStepSuggestions).toEqual(["运行测试"]);
    expect(p.memory.applyExtractionResult).not.toHaveBeenCalled();
  });

  it("skips next steps and memory while child sessions are still running", async () => {
    // 主会话回合先结束、子会话还在跑：它们的结果还没进对话，此时提炼
    // 下一步/记忆是残缺的，子会话汇报后那一轮会自然补上。
    p.store.getState().superSessions = [{ status: "running" }];
    queueCompletion({ text: JSON.stringify({ title: "登录改用 PKCE" }), reason: "complete" });
    await p.runTurnFollowup(SESSION_ID, { allowTitle: true, conversationTasks: true });

    expect(completionMock.state.calls).toHaveLength(1);
    const sent = completionMock.state.calls[0]?.prompt ?? "";
    expect(sent).toContain("[Title]");
    expect(sent).not.toContain("[Next steps]");
    expect(sent).not.toContain("[Long-term memory]");
    expect(sent).not.toContain('"facts"');
    expect(p.store.getState().sessions[0]?.label).toBe("登录改用 PKCE");
    expect(p.store.getState().nextStepSuggestions).toEqual([]);
    expect(p.memory.beginExtraction).not.toHaveBeenCalled();
    expect(p.memory.applyExtractionResult).not.toHaveBeenCalled();
  });

  it("keeps the full batch once every child session reached a terminal state", async () => {
    p.store.getState().superSessions = [{ status: "completed" }, { status: "cancelled" }];
    queueCompletion({
      text: JSON.stringify({
        title: "登录改用 PKCE",
        nextSteps: ["运行测试"],
        facts: [{ text: "项目统一用 pnpm 安装依赖", scope: "global", category: "convention", confidence: 0.9 }],
      }),
      reason: "complete",
    });
    await p.runTurnFollowup(SESSION_ID, { allowTitle: true, conversationTasks: true });

    expect(completionMock.state.calls).toHaveLength(1);
    const sent = completionMock.state.calls[0]?.prompt ?? "";
    expect(sent).toContain("[Title]");
    expect(sent).toContain("[Next steps]");
    expect(sent).toContain("[Long-term memory]");
    expect(p.store.getState().nextStepSuggestions).toEqual(["运行测试"]);
    expect(p.memory.applyExtractionResult).toHaveBeenCalledTimes(1);
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

  it("takes the memory-extraction ceiling from the setting", async () => {
    setConfigOverrides({
      checkpoints: false,
      autoTitle: false,
      nextStepSuggestions: false,
      autoMemoryCapture: true,
      memoryExtractTimeoutSeconds: 30,
    });
    queueCompletion({ text: "{}", reason: "complete" });
    await p.runTurnFollowup(SESSION_ID, { allowTitle: false, conversationTasks: true });
    const batch = completionMock.state.calls[0];
    expect(batch?.timeoutMs).toBe(30_000);
    // The idle watchdog stays below the shortened ceiling (at most half of
    // it), so a wall-clock expiry never pre-empts the stall detection.
    expect(batch?.idleMs).toBe(15_000);
  });

  it("takes the next-step ceiling from the setting", async () => {
    setConfigOverrides({
      checkpoints: false,
      autoTitle: false,
      nextStepSuggestions: true,
      autoMemoryCapture: false,
      nextStepTimeoutSeconds: 40,
    });
    queueCompletion({ text: "{}", reason: "complete" });
    await p.runTurnFollowup(SESSION_ID, { allowTitle: false, conversationTasks: true });
    const batch = completionMock.state.calls[0];
    expect(batch?.timeoutMs).toBe(40_000);
    expect(batch?.idleMs).toBe(12_000);
  });

  it("a 0 ceiling lifts the whole batch (no wall-clock limit, no idle watchdog)", async () => {
    // The turn-end title / next-step / memory tasks share ONE request, so
    // 「不限制」 on one of them lifts the batch: no ceiling AND no watchdog.
    setConfigOverrides({
      checkpoints: false,
      autoTitle: true,
      nextStepSuggestions: true,
      autoMemoryCapture: true,
      memoryExtractTimeoutSeconds: 0,
    });
    queueCompletion({ text: "{}", reason: "complete" });
    await p.runTurnFollowup(SESSION_ID, { allowTitle: true, conversationTasks: true });
    const batch = completionMock.state.calls[0];
    expect(batch?.timeoutMs).toBe(0);
    expect(batch?.idleMs).toBe(0);
  });
});

// --- prompt template centralisation (prompts/) --------------------------------

/** Every template a builder or the panel references by name. */
const SHIPPED_TEMPLATES = [
  "system-prompt",
  "enhance",
  "ask-selection",
  "followup",
  "followup-keys",
  "followup-title",
  "followup-next-steps",
  "followup-memory",
  "model-metadata",
  "super-agent-task",
  "asset-gen",
  "asset-gen-nouns",
  "asset-gen-contracts",
  "knowledge",
  "knowledge-incremental",
  "memory-curate",
];

describe("prompt templates (prompts/)", () => {
  it("ships every template the builders reference", () => {
    for (const name of SHIPPED_TEMPLATES) {
      expect(existsSync(path.join(here, "..", "prompts", `${name}.md`), "utf8")).toBe(true);
    }
  });

  it("registers memory-curate in prompts/index.ts so loadPrompt resolves it", () => {
    // L2 语义合并依赖这条模板；未注册时 loadPrompt 会抛「not registered」，
    // 而该错误只会在真实整理时暴露 —— 这里提前钉住。
    const text = loadPrompt("memory-curate");
    expect(text).toContain("{{facts}}");
    expect(text).toContain('"merges"');
  });

  it("makes the main session an orchestrator that only delegates, plans, manages and reports", () => {
    // The host can only dispatch what the main agent writes: if this mandate is
    // dropped, the agent silently goes back to doing everything itself and
    // child sessions only appear when the user asks for them. The boundary is
    // strict — implementation is never kept in the main session.
    const text = readFileSync(path.join(here, "..", "prompts", "system-prompt.md"), "utf8");
    expect(text).toContain("You are the orchestrator: delegation, planning, management and reporting");
    // 优先级必须覆盖整份提示词：Tool Usage / Security 段也在教「本会话怎么跑 shell」，
    // 只写「the workflows above」会把那几段留在覆盖范围之外，两段直接自相矛盾。
    expect(text).toContain(
      "Where anything in this prompt tells you to implement, read a file, search the code, inspect logs, run a command, run a check or run git, this section takes precedence in this session: you implement and investigate by delegating",
    );
    expect(text).not.toContain("Where the workflows above tell you to implement");
    // 读到 Tool Usage 段时就该知道那些 shell 指令属于子会话，而不是读到后面才发现矛盾。
    expect(text).toContain(
      "These command-execution instructions apply to child sessions — the main session (the one that receives the child-session board) runs no shell commands at all; it delegates them.",
    );
    expect(text).toContain("The children do the work");
    expect(text).toContain("Decompose the user's task yourself, then delegate");
    expect(text).toContain("Implementation work is never kept here");
    expect(text).toContain("```super-agent");
    // 派发首选内置工具：CLI 已注册 `super-agent` 工具，工具调用就是主通道。
    // 缺了这段声明，模型会退回手写围栏（浪费 token）或改用进程内 task 工具。
    expect(text).toContain("Dispatching means calling the `super-agent` tool");
    expect(text).toContain('{"tasks":[{"title"');
    // 只有工具不在列表时（Plan 模式 / 旧 bundle）才退回正文围栏。
    expect(text).toContain("Only when the tool is absent from your tool list");
    expect(text).toContain("Do not hand-write the fenced block while the tool is available");
    // `task` 是进程内子代理：无 worktree 隔离、不上看板，不能拿来派发。
    expect(text).toContain("Do not use the `task` tool for this");
    // 管理动作：工具优先（super-agent 的 actions 参数），围栏仅作兜底。
    expect(text).toContain("Tool first, fenced block as fallback");
    expect(text).toContain("If the `super-agent` tool's schema exposes an `actions` parameter");
    expect(text).toContain(
      "Only when the tool is not in your list, or its schema has no `actions` parameter",
    );
    expect(text).toContain("## When to split");
    expect(text).toContain("## What stays in this session");
    expect(text).toContain("Never edit a delegated file yourself");
    expect(text).toContain("children cannot delegate further");
    // Zero-execution mandate: the main session runs no checks itself, and
    // verification is delegated like any other unit of work.
    expect(text).toContain("This session executes nothing");
    expect(text).toContain("no tests, no typecheck, no build, no shell command, and no file edits");
    expect(text).toContain("running the project's checks and reporting their real output goes to a child");
    expect(text).toContain("never re-run it here");
    // The child side owns the checks and has to report them honestly.
    const brief = readFileSync(path.join(here, "..", "prompts", "super-agent-task.md"), "utf8");
    expect(brief).toContain("Run the project checks the task brief asks for");
    expect(brief).toContain("never claim a check passed");
  });

  it("forbids the main session from reading, writing or running anything and routes it to a child", () => {
    // 2026-11-16 用户截图实测：主会话仍在 read_file / 跑 npx vitest。提示词必须
    // 把这些写成硬性禁止，并与宿主的 settings.disallowed_tools 机械门控同口径。
    const text = readFileSync(path.join(here, "..", "prompts", "system-prompt.md"), "utf8");
    expect(text).toContain("## Hard prohibitions for the main session (mechanically enforced)");
    expect(text).toContain("No reading or exploring");
    expect(text).toContain("No writing");
    expect(text).toContain("No executing");
    for (const tool of [
      "read_file",
      "read_many_files",
      "glob",
      "search_file_content",
      "list_directory",
      "image_read",
      "web_fetch",
      "web_search",
      "ReadCommandOutput",
      "write_file",
      "replace",
      "multi_edit",
      "xml_escape",
      "run_shell_command",
    ]) {
      expect(text).toContain(`\`${tool}\``);
    }
    // 探查也必须派子会话：旧的「只读探查可以留在主会话」整句消失。
    expect(text).not.toContain("read-only exploration to build the plan");
    expect(text).toContain("Planning that needs the codebase is itself a unit of work");
    expect(text).toContain("dispatch a child to investigate and report back");
    expect(text).toContain("which files to read, which question to answer, which commands to run");
    // 规划与派发通道不受影响。
    expect(text).toContain("`todo_write` / `todo_read` stay yours for planning");
    expect(text).toContain("`super-agent` is your dispatch channel");
  });

  it("keeps single-level decomposition, finer self-contained tasks and task-based read-only probing", () => {
    // 3.9.0 F3 决策：多层嵌套被刻意拒绝（递归合并拓扑序可能丢孙会话改动、
    // worktree 只含已提交内容使嵌套收益受限、免确认 + 真实 shell 攻击面放大），
    // 改为细化单层拆解 + 子会话用 in-process `task` 做只读探查。两份 prompt
    // 都必须写明，防止后续 agent 误以为嵌套是遗漏而重新实现。
    const text = readFileSync(path.join(here, "..", "prompts", "system-prompt.md"), "utf8");
    expect(text).toContain("## 只做单层拆解（single-level，刻意为之）");
    expect(text).toContain("这是刻意设计，不是遗漏");
    expect(text).toContain("递归合并的拓扑序可能丢失孙会话改动");
    expect(text).toContain("worktree 只含已提交内容，嵌套的额外收益有限");
    expect(text).toContain("免确认且能跑真实 shell");
    expect(text).toContain("**禁止让子会话再派发 super-agent**");
    expect(text).toContain("主会话是唯一的派发者");
    expect(text).toContain("每个子会话职责单一，任务描述自包含");
    expect(text).toContain("看不到主工作区的未提交改动，也看不到彼此的工作");
    expect(text).toContain("优先用 CLI 进程内 `task` 子代理做只读探查");

    const brief = readFileSync(path.join(here, "..", "prompts", "super-agent-task.md"), "utf8");
    expect(brief).toContain("## 单层拆解与只读探查（single-level decomposition）");
    expect(brief).toContain("每个子会话职责单一，任务描述自包含");
    expect(brief).toContain("看不到主工作区的未提交改动，也看不到其它子会话的工作");
    expect(brief).toContain("优先用 CLI 进程内的 `task` 子代理做只读探查");
    expect(brief).toContain("**禁止嵌套派发**");
    expect(brief).toContain("本设计刻意只保留「主会话 → 子会话」一层");
    expect(brief).toContain("递归合并的拓扑序可能丢失孙会话的改动");
  });

  it("keeps the child-session concurrency limit configurable instead of hard-coding 4", () => {
    // 模型会照着提示词里的数字自我约束：写死的 "At most 4 child sessions" 曾让
    // 用户把 iflow.superAgent.maxConcurrent 设成 10 后仍只派 4 个任务
    //（2026-11-15 实测）。实现层的上限来自设置且每次实时读取，提示词不得再写死数字。
    const text = readFileSync(path.join(here, "..", "prompts", "system-prompt.md"), "utf8");
    expect(text).not.toContain("At most 4 child sessions run concurrently");
    expect(text).not.toMatch(/At most [0-9]+ child sessions run concurrently/);
    expect(text).toContain("`iflow.superAgent.maxConcurrent`");
    expect(text).toContain("default 5, adjustable from 1 to 20");
    expect(text).toContain("the host queues extra dispatches in FIFO order");
    expect(text).toContain("never truncate the delegation to a hard-coded count");
  });

  it("declares that the main session has no `task` tool while child sessions keep it, and routes every delegation through child sessions", () => {
    // 宿主在 session/new 的 settings.disallowed_tools 里剔除 `task`（宿主行为由
    // test/panel-session-tools.test.ts 覆盖，这里只校验提示词措辞）。提示词若还写
    // 「用 task 探索 / 用 task 并行」，模型会去调一个不存在的工具，然后零派发
    // （2026-11-15 用户实测：主会话优先调进程内子代理）。
    // 同一份模板也作为子会话的 system prompt，所以「没有 task」必须显式限定主会话，
    // 否则子会话会误以为自己也不能用 `task`，与 prompts/super-agent-task.md 矛盾。
    const text = readFileSync(path.join(here, "..", "prompts", "system-prompt.md"), "utf8");
    expect(text).toContain("the main session — the one that receives the child-session board — has no `task` tool");
    expect(text).toContain("settings.disallowed_tools");
    expect(text).toContain(
      'carrying `"task"` plus every read/explore, write and execute tool listed above',
    );
    // 无条件的裸句必须消失（子会话读到会误判）。
    expect(text).not.toContain("this session has no `task` tool");
    expect(text).not.toContain("This session has no `task` tool");
    // 委派只有一条通道：super-agent 子会话。
    expect(text).toContain("delegation always goes through child sessions");
    expect(text).toContain("is a child session's job: dispatch it with `super-agent`");
    // 子会话保留 `task`，那是它自己进程内子代理的机制。
    expect(text).toContain("Child sessions keep `task` for their own in-process subagents");
    const brief = readFileSync(path.join(here, "..", "prompts", "super-agent-task.md"), "utf8");
    expect(brief).toContain("run in-process subagents with the `task` tool");
    expect(brief).toContain("you have no `super-agent` tool");
    // 旧的「task 优先」整句必须消失，否则又把模型指向进程内子代理。
    expect(text).not.toContain("for file search prefer 'task' to save context");
    expect(text).not.toContain("it is CRITICAL that you use 'task' with subagent_type=explore-agent");
    expect(text).not.toContain("Proactively use 'task' with specialized agents");
    expect(text).not.toContain("Delegate via `task`; `subagent_type` must exactly match the name in the agent list");
    expect(text).not.toContain("Use multi 'task' tools when the user asks for parallel execution");
    expect(text).not.toContain('use task(subagent_type="frontend-tester")');
    expect(text).not.toContain("route high-volume or speculative exploration through 'task'");
    expect(text).not.toContain("Run one via the Task tool with the slash invocation");
  });

  it("gives the main session no git exception: an unmerged branch goes to a merge child session", () => {
    // 主会话连 git 也不跑：分支没能自动合并时，派一个合并子会话去做，
    // 主会话只读汇报。旧提示词给主会话留了「自己 merge」这条例外。
    const text = readFileSync(path.join(here, "..", "prompts", "system-prompt.md"), "utf8");
    // 新分工：明确不跑 git + 派合并子会话。
    expect(text).toContain("This session runs no git either");
    expect(text).toContain("you never run git yourself");
    expect(text).toContain("dispatch a merge child session");
    expect(text).toContain("dispatch a merge child session to do it");
    expect(text).toContain("means you dispatch a merge child session for it");
    // 旧分工：「你自己合并」整句消失（用完整句子断言，不用裸 git merge 串）。
    expect(text).not.toContain(
      "Only when the board shows the branch was **kept** (未自动合并 / 合并冲突 / no gh CLI) do you merge it yourself: run `git merge --no-ff <branch>` in the main workspace (the branch is on the board) and resolve conflicts by reading the code.",
    );
    expect(text).not.toContain(
      "a finished child with `未自动合并` needs you to merge its branch yourself (or tell the user exactly why it was left alone).",
    );
  });

  it("makes retrying a failed child session mandatory and forbids re-dispatching an equivalent task", () => {
    // 2026-11 用户实测：主会话看到 failed 子会话后新派等价 super-agent 任务，
    // 新建 worktree 从零开始，丢掉原 worktree 里大半未提交改动。规则必须进
    // 系统提示（每轮都读），且要与看板 footer 的英文措辞一致。
    const text = readFileSync(path.join(here, "..", "prompts", "system-prompt.md"), "utf8");
    expect(text).toContain("A failed child session must be retried, never re-dispatched");
    expect(text).toContain("Do not dispatch a new, equivalent `super-agent` task");
    expect(text).toContain("the **same worktree**");
    // 保留「检查失败=新任务」规则，但要显式区分对象，避免模型对失败子会话也 new task。
    expect(text).toContain("A failed check is a new task, not a reason to code");
    expect(text).toContain("not a failed child session");
    // interrupted 不算失败，不自动 retry。
    expect(text).toContain("is **not** a failure — do not auto-retry it unless the user asks");
  });

  it("fills every placeholder in the assembled prompts", () => {
    const assembled = [
      buildFollowupPrompt({
        title: { request: "修一下登录报错" },
        nextSteps: { user: "修一下登录报错", assistant: "已修复", toolTitles: [] },
        memory: { conversation: "用户：…", existingFacts: [] },
      }),
      buildAssetGenPrompt("command", "fix", "run lint"),
      buildModelMetadataPrompt(["m-1"], [{ id: "S1", title: "t", url: "u", snippet: "s" }]),
      buildKnowledgePrompt("## 顶层结构\nsrc/  (2 files)"),
      buildIncrementalKnowledgePrompt("# 项目知识索引", { added: ["a.ts"], modified: [], deleted: [] }, "tree", "excerpt"),
      renderPrompt("enhance", { request: "hello" }),
      renderPrompt("ask-selection", { path: "src/a.ts", range: "1-2", code: "x = 1" }),
    ];
    for (const prompt of assembled) {
      // `{{args}}` is the CLI's own slash-command syntax, kept verbatim by design.
      expect(prompt.replace("`{{args}}`", "")).not.toMatch(/\{\{\w+\}\}/);
    }
  });

  it("rejects a missing variable instead of sending a half-filled prompt", () => {
    expect(() => renderPrompt("enhance", {})).toThrow(/missing variable "{{request}}"/);
  });

  it("collapses an optional placeholder line rather than leaving a blank row", () => {
    const unnamed = renderPrompt("asset-gen", { noun: "skill", contract: "c", nameLine: "", requirement: "r" });
    expect(unnamed).not.toContain("Name:");
    expect(unnamed).not.toMatch(/\n\n\n/);
  });

  it("keeps the slash-command contract's own {{args}} token verbatim", () => {
    expect(buildAssetGenPrompt("command", "fix", "x")).toContain("`{{args}}`");
    expect(buildAssetGenPrompt("agent", "a", "x")).not.toContain("`{{args}}`");
  });
});

// --- L2 语义合并：分批 / 反查 / 跨批去重 / 单批失败 ------------------------------

/** 模型回包信封（`parseMergeResponse` 取首个 { 到末个 } 解析）。 */
function mergeReply(merges: unknown): CompletionResult {
  return { text: JSON.stringify({ merges }), reason: "complete" };
}

describe("ChatPanel L2 语义合并 (suggestMemoryMerges)", () => {
  let panel: ChatPanel;
  let storageDir: string;

  beforeEach(async () => {
    completionMock.state.calls = [];
    queueCompletion({ text: "", reason: "failed" });
    storageDir = await mkdtemp(path.join(os.tmpdir(), "iflow-l2-merge-storage-"));
    panel = makePanel(storageDir).panel;
  });

  afterEach(async () => {
    await panel.dispose();
    await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("按 MAX_MERGE_FACTS 分批，每批一次模型调用", async () => {
    const facts = Array.from({ length: 100 }, (_, i) => `唯一事实 ${i}`);
    queueSequence([mergeReply([]), mergeReply([]), mergeReply([])]);

    const result = await internals(panel).suggestMemoryMerges(facts);

    // 100 条按 40 切：40 / 40 / 20，每批都真的发了一次模型请求。
    expect(completionMock.state.calls).toHaveLength(3);
    const numbered = completionMock.state.calls.map(
      (call) => (call.prompt.match(/^\d+\. /gm) ?? []).length,
    );
    expect(numbered).toEqual([MAX_MERGE_FACTS, MAX_MERGE_FACTS, 100 - 2 * MAX_MERGE_FACTS]);
    // 占位符已被替换（提示词完整）。
    for (const call of completionMock.state.calls) expect(call.prompt).not.toContain("{{facts}}");
    expect(result.suggestions).toHaveLength(0);
  });

  it("含 @path 标记时，模型基于 stripped 文本返回的 keep/absorb 能反查回原始文本并定位行号", async () => {
    const markdown = [
      "# 记忆",
      "",
      "## iFlow Added Memories",
      "",
      "- 遵循 @docs/style.md 的格式约定",
      "- 格式约定见 docs/style.md",
      "",
    ].join("\n");
    const facts = parseManagedFacts(markdown);
    const originalTexts = facts.map((fact) => fact.text);
    // 模型只看到去掉 @ 的文本，按 stripped 文本回填 keep/absorb。
    queueSequence([
      mergeReply([
        {
          keep: "遵循 docs/style.md 的格式约定",
          absorb: ["格式约定见 docs/style.md"],
          merged: "按 docs/style.md 的格式约定执行",
          reason: "同一约定",
        },
      ]),
    ]);

    const result = await internals(panel).suggestMemoryMerges(originalTexts);

    // 发送前去掉 @（陷阱 #26），但回包经反查表还原成原始文本。
    const sent = completionMock.state.calls[0]?.prompt ?? "";
    expect(sent).not.toContain("@docs/");
    expect(sent).toContain("docs/style.md");
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.keep).toBe("遵循 @docs/style.md 的格式约定");
    expect(result.suggestions[0]?.absorb).toEqual(["格式约定见 docs/style.md"]);

    // 反查后的原始文本能按行号定位（applyCurationPlan 的 merge 依赖行号）。
    const actions = suggestionsToActions(result.suggestions, facts);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: "merge",
      targetLine: facts[0]?.line,
      mergeLines: [facts[1]?.line],
    });
  });

  it("跨批重复建议同一 keep 时只保留首个、不产生重复建议", async () => {
    // 42 条 → 两批（40 + 2）。keep/absorb 在批 1（索引 0/1）与批 2（索引 40/41）
    // 各出现一次（同一原文），模拟模型对重复事实给出同一条合并建议。
    const facts = Array.from({ length: 40 }, (_, i) => `填充事实 ${i}`);
    facts[0] = "使用 pnpm 管理依赖";
    facts[1] = "依赖安装统一用 pnpm";
    facts.push("使用 pnpm 管理依赖"); // 索引 40
    facts.push("依赖安装统一用 pnpm"); // 索引 41
    expect(facts).toHaveLength(42);

    const sameMerge = [
      {
        keep: "使用 pnpm 管理依赖",
        absorb: ["依赖安装统一用 pnpm"],
        merged: "依赖统一用 pnpm 管理",
        reason: "同一约定",
      },
    ];
    queueSequence([mergeReply(sameMerge), mergeReply(sameMerge)]);

    const result = await internals(panel).suggestMemoryMerges(facts);

    expect(completionMock.state.calls).toHaveLength(2);
    // 只保留首个 keep，第二批的同一条被静默丢弃（不重复、也不进 rejected）。
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.keep).toBe("使用 pnpm 管理依赖");
    expect(result.rejected).toHaveLength(0);
  });

  it("某一批回包为空（网关失败）时其它批的建议仍生效", async () => {
    // 100 条 → 三批（40 / 40 / 20）。批 1、3 各有一条有效合并，批 2 回包为空。
    const facts = Array.from({ length: 100 }, (_, i) => `填充事实 ${i}`);
    facts[0] = "使用 pnpm 管理依赖";
    facts[1] = "依赖安装统一用 pnpm";
    facts[80] = "回答使用中文";
    facts[81] = "回复统一中文";

    queueSequence([
      mergeReply([
        {
          keep: "使用 pnpm 管理依赖",
          absorb: ["依赖安装统一用 pnpm"],
          merged: "依赖统一用 pnpm 管理",
          reason: "同一约定",
        },
      ]),
      { text: "", reason: "failed" }, // 批 2：网关无回包
      mergeReply([
        {
          keep: "回答使用中文",
          absorb: ["回复统一中文"],
          merged: "统一用中文回答",
          reason: "同一约定",
        },
      ]),
    ]);

    const result = await internals(panel).suggestMemoryMerges(facts);

    expect(completionMock.state.calls).toHaveLength(3);
    // 批 2 的空回包只丢这一批，批 1、3 的建议都保留。
    expect(result.suggestions.map((s) => s.keep).sort()).toEqual(
      ["使用 pnpm 管理依赖", "回答使用中文"].sort(),
    );
    expect(result.rejected).toHaveLength(0);
  });

  it("某一批模型调用抛错时只丢该批，其它批建议仍生效（有意行为变更）", async () => {
    // 有意行为变更：此前的实现没有逐批 try/catch，某批抛错会中断整个调用、
    // 丢弃全部建议（维护层降级为 L1）。现在逐批隔离 —— 单批瞬时故障只丢该批。
    const facts = Array.from({ length: 100 }, (_, i) => `填充事实 ${i}`);
    facts[0] = "使用 pnpm 管理依赖";
    facts[1] = "依赖安装统一用 pnpm";
    facts[80] = "回答使用中文";
    facts[81] = "回复统一中文";

    queueSequence([
      mergeReply([
        {
          keep: "使用 pnpm 管理依赖",
          absorb: ["依赖安装统一用 pnpm"],
          merged: "依赖统一用 pnpm 管理",
          reason: "同一约定",
        },
      ]),
      () => Promise.reject(new Error("网关超时")), // 批 2：抛错
      mergeReply([
        {
          keep: "回答使用中文",
          absorb: ["回复统一中文"],
          merged: "统一用中文回答",
          reason: "同一约定",
        },
      ]),
    ]);

    const result = await internals(panel).suggestMemoryMerges(facts);

    // 三批都发过请求；批 2 抛错不影响批 1、3。
    expect(completionMock.state.calls).toHaveLength(3);
    expect(result.suggestions.map((s) => s.keep).sort()).toEqual(
      ["使用 pnpm 管理依赖", "回答使用中文"].sort(),
    );
    expect(result.rejected).toHaveLength(0);
    // 失败批次有日志痕迹：点名第 2/3 批与错误摘要，并有一条汇总。
    const warns = internals(panel).log.lines.filter((line) => line.level === "warn");
    expect(
      warns.some((line) => line.message.includes("第 2/3 批") && line.message.includes("网关超时")),
    ).toBe(true);
    expect(warns.some((line) => line.message.includes("1/3 批调用失败"))).toBe(true);
  });

  it("全部批次都抛错时返回空建议、不抛错（维护层降级为纯 L1）", async () => {
    const facts = Array.from({ length: 100 }, (_, i) => `填充事实 ${i}`);
    queueSequence([
      () => Promise.reject(new Error("网关超时 A")),
      () => Promise.reject(new Error("网关超时 B")),
      () => Promise.reject(new Error("网关超时 C")),
    ]);

    const result = await internals(panel).suggestMemoryMerges(facts);

    expect(completionMock.state.calls).toHaveLength(3);
    expect(result.suggestions).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
    const warns = internals(panel).log.lines.filter((line) => line.level === "warn");
    expect(warns.some((line) => line.message.includes("3/3 批调用失败"))).toBe(true);
  });

  it("空回包与抛错混合时：空回包跳过、抛错批次隔离，其余批建议保留", async () => {
    // 100 条 → 三批（40 / 40 / 20）：批 1 抛错、批 2 空回包、批 3 有效建议。
    const facts = Array.from({ length: 100 }, (_, i) => `填充事实 ${i}`);
    facts[80] = "回答使用中文";
    facts[81] = "回复统一中文";

    queueSequence([
      () => Promise.reject(new Error("网关超时")),
      { text: "", reason: "failed" }, // 批 2：网关无回包（不是抛错）
      mergeReply([
        {
          keep: "回答使用中文",
          absorb: ["回复统一中文"],
          merged: "统一用中文回答",
          reason: "同一约定",
        },
      ]),
    ]);

    const result = await internals(panel).suggestMemoryMerges(facts);

    expect(completionMock.state.calls).toHaveLength(3);
    // 只有批 3 的建议存活；抛错与空回包都不产生建议，也不进 rejected。
    expect(result.suggestions.map((s) => s.keep)).toEqual(["回答使用中文"]);
    expect(result.rejected).toHaveLength(0);
    const warns = internals(panel).log.lines.filter((line) => line.level === "warn");
    expect(warns.some((line) => line.message.includes("第 1/3 批"))).toBe(true);
    expect(warns.some((line) => line.message.includes("1/3 批调用失败"))).toBe(true);
  });
});