import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { setConfigOverrides } from "./vscode-stub.js";
import { EFFICIENCY_STEADY_PROMPT, EFFICIENCY_TURBO_PROMPT } from "../prompts/index.js";

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

function makeWatchers(): NonNullable<PanelServices["watchers"]> {
  const noop = () => ({ dispose: () => {} });
  return [
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
    { dispose: () => {}, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
  ];
}

type PromptCall = {
  prompt: Array<{ type: string; text?: string }>;
  resolve: (v: { stopReason: string }) => void;
  reject: (e: unknown) => void;
};

type PanelInternals = {
  panelVisible: boolean;
  historySyncBusy: boolean;
  handleWebviewMessage: (msg: { type: string; [k: string]: unknown }) => Promise<void>;
  sendPrompt: (
    text: string,
    images?: { data: string; mimeType: string }[],
    files?: { name: string; path: string }[],
    contexts?: unknown,
    options?: { internal?: boolean; hidden?: boolean; delegateOnBusy?: boolean },
  ) => Promise<boolean>;
  ensureClient: () => Promise<unknown>;
  promptWithRetry: (client: unknown, sessionId: string, prompt: unknown) => Promise<{ stopReason: string }>;
  persistActiveTranscript: () => Promise<void>;
  touchActiveSession: () => Promise<void>;
  maybeGenerateAiTitle: (id: string) => Promise<void>;
  injectedEfficiencyMode: Map<string, "steady" | "turbo">;
  store: {
    getState: () => { sessionId: string | null; status: string; blocks: unknown[] };
    sessionStarted: (meta: { sessionId: string }) => void;
    sendToast: (...args: unknown[]) => number;
  };
};

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * 效率开关（`iflow.efficiencyMode`）的注入契约。
 *
 * 注入策略是「仅档位变化时注入一次」：同一会话连续多轮只带一次速推规则，
 * 切回 steady 时再带一次恢复块。新会话按 CLI 固有默认 `steady` 作基线，
 * 所以 turbo 的新会话首轮就注入，而 steady 的会话逐字节不变。
 */
describe("ChatPanel 效率开关注入", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let storageDir: string;
  let calls: PromptCall[];

  beforeEach(async () => {
    // sendPrompt awaits the M3 workspace snapshot (real git); disable it.
    setConfigOverrides({ checkpoints: false, efficiencyMode: "steady" });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-efficiency-storage-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    calls = [];
    p.ensureClient = async () => ({});
    p.promptWithRetry = vi.fn(
      (_c: unknown, _s: string, prompt: Array<{ type: string; text?: string }>) =>
        new Promise<{ stopReason: string }>((resolve, reject) => {
          calls.push({ prompt, resolve, reject });
        }),
    ) as unknown as PanelInternals["promptWithRetry"];
    p.persistActiveTranscript = async () => {};
    p.touchActiveSession = async () => {};
    p.maybeGenerateAiTitle = async () => {};
    p.store.sessionStarted({ sessionId: "eff-session" });
    p.panelVisible = true;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const send = (text: string): Promise<void> => p.handleWebviewMessage({ type: "sendPrompt", text });
  const textsOf = (call: PromptCall): string[] => call.prompt.map((b) => b.text ?? "");

  it("steady 会话首轮不注入（与开关上线前逐字节一致）", async () => {
    const turn = send("做点事");
    await flush();
    expect(calls).toHaveLength(1);
    const texts = textsOf(calls[0]!);
    expect(texts).toHaveLength(1); // 只有正文一个 text 块，没有档位块
    expect(texts.join("\n")).not.toContain(EFFICIENCY_TURBO_PROMPT);
    expect(texts.join("\n")).not.toContain(EFFICIENCY_STEADY_PROMPT);
    calls[0]!.resolve({ stopReason: "end_turn" });
    await turn;
  });

  it("新建会话即为 turbo 时首轮注入速推块", async () => {
    setConfigOverrides({ checkpoints: false, efficiencyMode: "turbo" });
    const turn = send("做点事");
    await flush();
    expect(calls).toHaveLength(1);
    const texts = textsOf(calls[0]!);
    // 档位块是最后一个 text 块（CLI 只看 prompt[0]，追加不影响命令识别）。
    expect(texts.at(-1)).toBe(EFFICIENCY_TURBO_PROMPT);
    expect(texts[0]).toContain("做点事");
    calls[0]!.resolve({ stopReason: "end_turn" });
    await turn;
  });

  it("档位未变时连续两轮都不重复注入", async () => {
    setConfigOverrides({ checkpoints: false, efficiencyMode: "turbo" });
    const first = send("第一轮");
    await flush();
    expect(textsOf(calls[0]!).at(-1)).toBe(EFFICIENCY_TURBO_PROMPT);
    calls[0]!.resolve({ stopReason: "end_turn" });
    await first;
    await flush();

    const second = send("第二轮");
    await flush();
    expect(calls).toHaveLength(2);
    // 第二轮不再带速推块（仅档位变化时注入一次）。
    expect(textsOf(calls[1]!)).toHaveLength(1);
    expect(textsOf(calls[1]!).join("\n")).not.toContain(EFFICIENCY_TURBO_PROMPT);
    calls[1]!.resolve({ stopReason: "end_turn" });
    await second;
  });

  it("turbo 注入一次后切回 steady，下一轮注入恢复块", async () => {
    setConfigOverrides({ checkpoints: false, efficiencyMode: "turbo" });
    const first = send("第一轮");
    await flush();
    expect(textsOf(calls[0]!).at(-1)).toBe(EFFICIENCY_TURBO_PROMPT);
    calls[0]!.resolve({ stopReason: "end_turn" });
    await first;
    await flush();

    setConfigOverrides({ checkpoints: false, efficiencyMode: "steady" });
    const second = send("第二轮");
    await flush();
    expect(textsOf(calls[1]!).at(-1)).toBe(EFFICIENCY_STEADY_PROMPT);
    calls[1]!.resolve({ stopReason: "end_turn" });
    await second;
    await flush();

    // 恢复块同样只注入一次：第三轮不再带任何档位块。
    const third = send("第三轮");
    await flush();
    expect(textsOf(calls[2]!)).toHaveLength(1);
    calls[2]!.resolve({ stopReason: "end_turn" });
    await third;
  });

  it("注入记录随会话 id 记在 Map 里，且只记当前会话", async () => {
    setConfigOverrides({ checkpoints: false, efficiencyMode: "turbo" });
    const turn = send("做点事");
    await flush();
    expect(p.injectedEfficiencyMode.get("eff-session")).toBe("turbo");
    calls[0]!.resolve({ stopReason: "end_turn" });
    await turn;
  });

  it("hidden 宿主回合不消耗档位变化，随后的真实用户回合仍注入", async () => {
    setConfigOverrides({ checkpoints: false, efficiencyMode: "turbo" });
    const hiddenTurn = p.sendPrompt("[子会话状态上报] ok", undefined, undefined, undefined, {
      hidden: true,
      delegateOnBusy: false,
    });
    await flush();
    expect(textsOf(calls[0]!).join("\n")).not.toContain(EFFICIENCY_TURBO_PROMPT);
    calls[0]!.resolve({ stopReason: "end_turn" });
    await hiddenTurn;
    await flush();

    const real = send("真实消息");
    await flush();
    expect(textsOf(calls[1]!).at(-1)).toBe(EFFICIENCY_TURBO_PROMPT);
    calls[1]!.resolve({ stopReason: "end_turn" });
    await real;
  });
});
