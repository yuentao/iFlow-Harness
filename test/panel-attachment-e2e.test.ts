import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { setConfigOverrides } from "./vscode-stub.js";
import { AGENT_ATTACHMENT_HEADER, hasAgentAttachmentBlock } from "../shared/messages.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeContext(storageDir: string): vscodeTypes.ExtensionContext {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, defaultValue?: T): T =>
      (store.has(key) ? (store.get(key) as T) : defaultValue) as T,
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
    { dispose: noop, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
    { dispose: noop, onDidCreate: noop, onDidChange: noop, onDidDelete: noop },
  ];
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * End-to-end: the prompt text the panel actually sends to the CLI must carry
 * the shared attachment-header literal, and the consumer that has to
 * recognise that block (the delete-message flow's CLI-history matcher) must
 * recognise exactly what the producer wrote.
 *
 * The CLI records the prompt verbatim in `~/.iflow/acp/sessions/<id>.json`,
 * so the text sent here IS the text the consumer later sees.
 */
describe("agent attachment header · end-to-end (panel → CLI)", () => {
  let panel: ChatPanel;
  let storageDir: string;
  let sent: string[];

  beforeEach(async () => {
    setConfigOverrides({ checkpoints: false });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-attach-e2e-"));
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
    sent = [];
    const p = panel as unknown as {
      ensureClient: () => Promise<unknown>;
      promptWithRetry: (
        _c: unknown,
        _s: string,
        prompt: Array<{ type: string; text?: string }>,
      ) => Promise<{ stopReason: string }>;
      persistActiveTranscript: () => Promise<void>;
      touchActiveSession: () => Promise<void>;
      maybeGenerateAiTitle: () => Promise<void>;
      store: { sessionStarted: (meta: { sessionId: string }) => void };
    };
    p.ensureClient = async () => ({});
    p.promptWithRetry = vi.fn(
      async (_c: unknown, _s: string, prompt: Array<{ type: string; text?: string }>) => {
        sent.push(prompt.map((part) => part.text ?? "").join("\n"));
        return { stopReason: "end_turn" };
      },
    ) as unknown as typeof p.promptWithRetry;
    p.persistActiveTranscript = async () => {};
    p.touchActiveSession = async () => {};
    p.maybeGenerateAiTitle = async () => {};
    p.store.sessionStarted({ sessionId: "attach-session" });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const send = (msg: Record<string, unknown>) =>
    (panel as unknown as {
      handleWebviewMessage: (m: unknown) => Promise<void>;
    }).handleWebviewMessage({ type: "sendPrompt", ...msg });

  it("sends the shared header literal, and the consumer recognises that exact block", async () => {
    await send({
      text: "look at this",
      files: [{ name: "note.txt", path: "C:/tmp/note.txt" }],
    });
    await flush();

    expect(sent).toHaveLength(1);
    const recorded = sent[0]!;
    // The producer writes the shared protocol literal…
    expect(recorded).toContain(AGENT_ATTACHMENT_HEADER);
    expect(recorded).toContain("- note.txt → C:/tmp/note.txt");
    // …and the consumer recognises exactly what the producer wrote.
    expect(hasAgentAttachmentBlock(recorded)).toBe(true);
  });

  it("does not report an attachment block for a prompt without attachments", async () => {
    await send({ text: "look at this" });
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain(AGENT_ATTACHMENT_HEADER);
    expect(hasAgentAttachmentBlock(sent[0]!)).toBe(false);
  });

  it("streaming variant: delegated attachments are backfilled to the main session too", async () => {
    const p = panel as unknown as {
      promptWithRetry: (
        _c: unknown,
        _s: string,
        prompt: Array<{ type: string; text?: string }>,
      ) => Promise<{ stopReason: string }>;
    };
    const prompts: Array<Array<{ type: string; text?: string }>> = [];
    let resolveFirst: ((v: { stopReason: string }) => void) | null = null;
    let callIndex = 0;
    p.promptWithRetry = vi.fn((_c: unknown, _s: string, prompt: Array<{ type: string; text?: string }>) => {
      prompts.push(prompt);
      callIndex += 1;
      if (callIndex === 1) {
        // 第一回合保持 streaming，逼出「改道派发子会话」那条路径。
        return new Promise<{ stopReason: string }>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({ stopReason: "end_turn" });
    }) as unknown as typeof p.promptWithRetry;
    const spawn = vi.fn(() => ({ id: "super-1" }));
    Object.assign(p, { getSuperAgent: () => ({ spawn }) });

    const first = send({ text: "first turn" });
    await flush();
    await send({
      text: "look at this",
      images: [{ data: "QUJD", mimeType: "image/png" }],
      files: [{ name: "note.txt", path: "C:/tmp/note.txt" }],
    });
    await flush();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(prompts).toHaveLength(1); // streaming 期间绝不并发第二个主会话 prompt

    resolveFirst!({ stopReason: "end_turn" });
    await first;
    await flush();

    // 回合结束后的补投回合：主会话也拿到与 idle 发送同构的附件头/路径与图片块。
    expect(prompts).toHaveLength(2);
    const recorded = prompts[1]!.map((part) => part.text ?? "").join("\n");
    expect(recorded).toContain("[补投用户消息]");
    expect(recorded).toContain("look at this");
    expect(recorded).toContain(AGENT_ATTACHMENT_HEADER);
    expect(recorded).toContain("- note.txt → C:/tmp/note.txt");
    expect(hasAgentAttachmentBlock(recorded)).toBe(true);
    expect(prompts[1]).toContainEqual({ type: "image", data: "QUJD", mimeType: "image/png" });
    expect(spawn).toHaveBeenCalledTimes(1); // 补投不二次派发
  });
});