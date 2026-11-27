/**
 * 子会话（超流体）**独立**凭据与模型的注入。
 *
 * 动因：配置面 / 协议面 / 纯解析层都已合入，但 `src/` 从未 import
 * `shared/super-profile.ts` —— 两个新设置对实际派发零运行时效果。本文件
 * 断言真实子进程收到的 `authenticate` 载荷（mock ACP agent 落盘）、spawn
 * env（防泄漏面回潮）与 `IFLOW_TOKENS_LIMIT`（按超流体自己的 Profile 解析，
 * 不随主会话 `currentApiProfile` 变）。
 *
 * 可证伪性（把注入改回主会话凭据会让哪条红）：
 *  - 第 1 条「配置了超流体 profile」：apiKey/baseUrl/modelName 三个断言都会红
 *    （会读到 main 的 sk-main / main.example）。
 *  - 第 2 条「未配置与握手全等」：若实现改成无条件用某个新 Profile，会红。
 *  - 窗口断言：主 profile tokensLimit=64000、超流体=128000 —— 若仍用主会话
 *    那套解析，子会话会拿到 64000 而不是 128000。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import * as vscode from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import type { SuperTaskSpec } from "../shared/super-agent.js";
import { setConfigOverrides } from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const mockAgent = path.join(here, "mock-acp-agent.mjs");

function makeSecrets(): {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  raw: Map<string, string>;
} {
  const raw = new Map<string, string>();
  return {
    raw,
    get: (key) => Promise.resolve(raw.get(key)),
    store: (key, value) => {
      raw.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      raw.delete(key);
      return Promise.resolve();
    },
  };
}

function makeContext(storageDir: string, secrets: ReturnType<typeof makeSecrets>): vscodeTypes.ExtensionContext {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, defaultValue?: T): T =>
      store.has(key) ? (store.get(key) as T) : (defaultValue as T),
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
    secrets,
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

type SpawnClient = { dispose: () => Promise<void> };
type PanelInternals = {
  createSuperClient: (params: {
    cwd: string;
    allowedRoots: string[];
    includeDirectories: string[];
    label: string;
    callbacks: Record<string, never>;
    profileId?: string;
    modelId?: string;
  }) => Promise<SpawnClient>;
  prepareSuperSpec: (spec: SuperTaskSpec, onDropped: (count: number) => void) => SuperTaskSpec;
  resolveWorkspaceHandshakeCreds: () => Promise<{
    baseUrl: string;
    apiKey: string;
    modelName: string;
  } | null>;
};

type AuthDumpEntry = {
  method: string;
  params: {
    methodId?: string;
    methodInfo?: { apiKey?: string; baseUrl?: string; modelName?: string };
    modelId?: string;
  };
};

const MAIN = {
  baseUrl: "https://main.example/v1",
  apiKey: "sk-main-secret",
  modelName: "main-profile-model",
  tokensLimit: 64_000,
};
const SUPER = {
  baseUrl: "https://super.example/v1",
  apiKey: "sk-super-secret",
  modelName: "super-profile-model",
  tokensLimit: 128_000,
};
const TASK = {
  baseUrl: "https://task.example/v1",
  apiKey: "sk-task-secret",
  modelName: "task-profile-model",
  tokensLimit: 200_000,
};

describe("子会话独立凭据与模型注入", () => {
  let panel: ChatPanel;
  let storageDir: string;
  let iflowHome: string;
  let secrets: ReturnType<typeof makeSecrets>;
  // 宿主 shell 的遗留键会污染断言：先存后删，测试结束原样恢复。
  let originalTokensLimitEnv: string | undefined;
  let originalApiKeyEnv: string | undefined;
  let originalBaseUrlEnv: string | undefined;

  beforeEach(() => {
    setConfigOverrides({ nodePath: process.execPath });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-supercred-storage-"));
    iflowHome = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-supercred-home-"));
    process.env.IFLOW_HOME = iflowHome;
    originalTokensLimitEnv = process.env.IFLOW_TOKENS_LIMIT;
    originalApiKeyEnv = process.env.IFLOW_API_KEY;
    originalBaseUrlEnv = process.env.IFLOW_BASE_URL;
    delete process.env.IFLOW_TOKENS_LIMIT;
    delete process.env.IFLOW_API_KEY;
    delete process.env.IFLOW_BASE_URL;
    (vscode.workspace as unknown as { fs: unknown }).fs = {
      readFile: (uri: { fsPath: string }) => fs.promises.readFile(uri.fsPath),
      writeFile: (uri: { fsPath: string }, data: Uint8Array) =>
        fs.promises.writeFile(uri.fsPath, data),
    };
    secrets = makeSecrets();
    panel = new ChatPanel(makeContext(storageDir, secrets), {
      entryOverride: mockAgent,
      workspaceRoot: here,
      watchers: makeWatchers(),
    });
  });

  afterEach(async () => {
    await panel.dispose();
    delete process.env.ACP_MOCK_ENV_DUMP;
    delete process.env.ACP_MOCK_AUTH_DUMP;
    delete process.env.IFLOW_HOME;
    if (originalTokensLimitEnv === undefined) delete process.env.IFLOW_TOKENS_LIMIT;
    else process.env.IFLOW_TOKENS_LIMIT = originalTokensLimitEnv;
    if (originalApiKeyEnv === undefined) delete process.env.IFLOW_API_KEY;
    else process.env.IFLOW_API_KEY = originalApiKeyEnv;
    if (originalBaseUrlEnv === undefined) delete process.env.IFLOW_BASE_URL;
    else process.env.IFLOW_BASE_URL = originalBaseUrlEnv;
    delete (vscode.workspace as unknown as { fs?: unknown }).fs;
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(iflowHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function writeKernelSettings(): void {
    fs.writeFileSync(
      path.join(iflowHome, "settings.json"),
      JSON.stringify({
        selectedAuthType: "openai-compatible",
        currentApiProfile: "main",
        apiProfiles: { main: MAIN, super: SUPER, taskProf: TASK },
      }),
      "utf8",
    );
  }

  function setWorkspaceProfile(name: string): void {
    void (panel as unknown as { context: vscodeTypes.ExtensionContext }).context.workspaceState.update(
      "iflow.workspaceActiveProfile",
      name,
    );
  }

  function readJsonl(file: string): AuthDumpEntry[] {
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuthDumpEntry);
  }

  function readEnv(file: string): NodeJS.ProcessEnv {
    return JSON.parse(fs.readFileSync(file, "utf8")) as NodeJS.ProcessEnv;
  }

  function spawnChild(
    authDump: string,
    envDump: string,
    overrides: { profileId?: string; modelId?: string } = {},
  ): Promise<SpawnClient> {
    process.env.ACP_MOCK_AUTH_DUMP = authDump;
    process.env.ACP_MOCK_ENV_DUMP = envDump;
    return (panel as unknown as PanelInternals).createSuperClient({
      cwd: here,
      allowedRoots: [here],
      includeDirectories: [],
      label: "supercred-child",
      callbacks: {},
      ...overrides,
    });
  }

  it("配置了超流体 Profile 时，子会话 authenticate 用它自己的 apiKey/baseUrl/modelName", async () => {
    writeKernelSettings();
    setWorkspaceProfile("main");
    setConfigOverrides({
      nodePath: process.execPath,
      superAgentProfile: "super",
      superAgentModel: "",
      contextWindowOverrides: [],
    });
    const authDump = path.join(storageDir, "child-auth.jsonl");
    const envDump = path.join(storageDir, "child-env.json");
    const child = await spawnChild(authDump, envDump);
    try {
      const auth = readJsonl(authDump).find((entry) => entry.method === "authenticate");
      expect(auth?.params.methodId).toBe("openai-compatible");
      expect(auth?.params.methodInfo).toEqual({
        apiKey: SUPER.apiKey,
        baseUrl: SUPER.baseUrl,
        modelName: SUPER.modelName,
      });

      // 防泄漏面回潮：机密只走 ACP authenticate，绝不进子进程 env（否则
      // 子会话派生的任何 shell 都能读到）。
      const env = readEnv(envDump);
      expect(env.IFLOW_API_KEY).toBeUndefined();
      expect(env.IFLOW_BASE_URL).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain(SUPER.apiKey);
      expect(JSON.stringify(env)).not.toContain(SUPER.baseUrl);

      // 令牌上限按超流体自己的 Profile 解析（128000），不是主会话的 64000。
      expect(env.IFLOW_TOKENS_LIMIT).toBe(String(SUPER.tokensLimit));
    } finally {
      await child.dispose();
    }
  }, 30000);

  it("未配置超流体时，子会话与主会话握手结果全等（凭据 + 模型 + 窗口）", async () => {
    writeKernelSettings();
    setWorkspaceProfile("main");
    setConfigOverrides({
      nodePath: process.execPath,
      superAgentProfile: "",
      superAgentModel: "",
      contextWindowOverrides: [],
    });
    const handshake = await (panel as unknown as PanelInternals).resolveWorkspaceHandshakeCreds();
    expect(handshake).not.toBeNull();
    const authDump = path.join(storageDir, "child-auth-default.jsonl");
    const envDump = path.join(storageDir, "child-env-default.json");
    const child = await spawnChild(authDump, envDump);
    try {
      const auth = readJsonl(authDump).find((entry) => entry.method === "authenticate");
      expect(auth?.params.methodInfo).toEqual({
        apiKey: handshake!.apiKey,
        baseUrl: handshake!.baseUrl,
        modelName: handshake!.modelName,
      });
      // 未配置 → 沿用主会话那套窗口解析（main profile 的 tokensLimit）。
      expect(readEnv(envDump).IFLOW_TOKENS_LIMIT).toBe(String(MAIN.tokensLimit));
    } finally {
      await child.dispose();
    }
  }, 30000);

  it("任务级 profileId/modelId 穿过 prepareSuperSpec 并驱动子会话的端点解析", async () => {
    writeKernelSettings();
    setWorkspaceProfile("main");
    setConfigOverrides({
      nodePath: process.execPath,
      superAgentProfile: "",
      superAgentModel: "",
      contextWindowOverrides: [],
    });
    const spec = (panel as unknown as PanelInternals).prepareSuperSpec(
      {
        title: "临时换网关",
        task: "只这一次用 task.example",
        profileId: "taskProf",
        modelId: "task-model",
      },
      () => {},
    );
    // 白名单拷贝不许把任务级覆盖丢掉。
    expect(spec.profileId).toBe("taskProf");
    expect(spec.modelId).toBe("task-model");

    const authDump = path.join(storageDir, "child-auth-task.jsonl");
    const envDump = path.join(storageDir, "child-env-task.json");
    const child = await spawnChild(authDump, envDump, {
      profileId: spec.profileId,
      modelId: spec.modelId,
    });
    try {
      const auth = readJsonl(authDump).find((entry) => entry.method === "authenticate");
      expect(auth?.params.methodInfo).toEqual({
        apiKey: TASK.apiKey,
        baseUrl: TASK.baseUrl,
        modelName: TASK.modelName,
      });
      // 窗口按任务级 Profile 的 tokensLimit 解析。
      expect(readEnv(envDump).IFLOW_TOKENS_LIMIT).toBe(String(TASK.tokensLimit));
    } finally {
      await child.dispose();
    }
  }, 30000);
});
