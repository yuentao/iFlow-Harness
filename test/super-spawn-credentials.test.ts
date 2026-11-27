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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
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
    writeSettings({
      selectedAuthType: "openai-compatible",
      currentApiProfile: "main",
      apiProfiles: { main: MAIN, super: SUPER, taskProf: TASK },
    });
  }

  function writeSettings(raw: Record<string, unknown>): void {
    fs.writeFileSync(path.join(iflowHome, "settings.json"), JSON.stringify(raw), "utf8");
  }

  async function storeActiveCreds(creds: {
    baseUrl: string;
    apiKey: string;
    modelName: string;
  }): Promise<void> {
    await secrets.store("iflow.openai-compatible", JSON.stringify(creds));
  }

  async function storeLegacyProfiles(
    map: Record<string, { baseUrl: string; apiKey: string; modelName: string }>,
  ): Promise<void> {
    await secrets.store("iflow.profiles", JSON.stringify(map));
  }

  /** 纯零配置：两个超流体指针都留空（= package.json 默认值）。 */
  function zeroConfig(): void {
    setConfigOverrides({
      nodePath: process.execPath,
      superAgentProfile: "",
      superAgentModel: "",
      contextWindowOverrides: [],
    });
  }

  /** spawn 一个子会话，读回 authenticate 载荷与 spawn env。 */
  async function spawnAndCollect(
    suffix: string,
    overrides: { profileId?: string; modelId?: string } = {},
  ): Promise<{ auth?: AuthDumpEntry; env: NodeJS.ProcessEnv }> {
    const authDump = path.join(storageDir, `child-auth-${suffix}.jsonl`);
    const envDump = path.join(storageDir, `child-env-${suffix}.json`);
    const child = await spawnChild(authDump, envDump, overrides);
    try {
      return {
        auth: readJsonl(authDump).find((entry) => entry.method === "authenticate"),
        env: readEnv(envDump),
      };
    } finally {
      await child.dispose();
    }
  }

  /** 机密只走 ACP authenticate：子进程 env 里不得出现任何密钥 / 端点。 */
  function expectNoSecretInEnv(env: NodeJS.ProcessEnv, secretsToHide: readonly string[]): void {
    expect(env.IFLOW_API_KEY).toBeUndefined();
    expect(env.IFLOW_BASE_URL).toBeUndefined();
    const dump = JSON.stringify(env);
    for (const secret of secretsToHide) expect(dump).not.toContain(secret);
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

  // ── 零配置矩阵（方案 §4.1「老用户零配置零行为变化」的逐项锁）──────────────
  //
  // 今天子会话的凭据链只有 `resolveWorkspaceHandshakeCreds() ??
  // loadCredentials(secrets)`，窗口解析是面板那套 `resolveCliTokensLimit`。
  // 下面把每种「凭据来源组合」的 authenticate 与窗口都锁成今天的行为：
  // 内核 currentApiProfile / 内核顶层默认 **绝不**流进子会话（未配置时 ⑤ 两档
  // 被刻意置空）；SecretStorage 活动凭据与工作区指针照旧生效。

  it("零配置 · 只有内核 currentApiProfile：子会话不推 authenticate（内核指针不得冒充握手凭据），窗口仍随主会话", async () => {
    writeSettings({
      selectedAuthType: "openai-compatible",
      currentApiProfile: "main",
      apiProfiles: { main: MAIN },
    });
    zeroConfig();
    // 无工作区指针、无 SecretStorage 活动凭据 —— 今天子会话什么都拿不到。
    const { auth, env } = await spawnAndCollect("zero-kernel-pointer");
    expect(auth).toBeUndefined();
    // 窗口与今天一致：仍由主会话那套解析（currentApiProfile 的 tokensLimit）。
    expect(env.IFLOW_TOKENS_LIMIT).toBe(String(MAIN.tokensLimit));
    expectNoSecretInEnv(env, [MAIN.apiKey, MAIN.baseUrl]);
  }, 30000);

  it("零配置 · 只有内核顶层 baseUrl/apiKey：子会话不推 authenticate，窗口取顶层 tokensLimit", async () => {
    const top = {
      baseUrl: "https://kernel-top.example/v1",
      apiKey: "sk-kernel-top-secret",
      modelName: "kernel-top-model",
    };
    writeSettings({
      selectedAuthType: "openai-compatible",
      ...top,
      tokensLimit: 200_000,
    });
    zeroConfig();
    const { auth, env } = await spawnAndCollect("zero-kernel-top");
    // 今天子会话从不读内核顶层默认（那只在主会话 / 设置页链路里）。
    expect(auth).toBeUndefined();
    expect(env.IFLOW_TOKENS_LIMIT).toBe("200000");
    expectNoSecretInEnv(env, [top.apiKey, top.baseUrl]);
  }, 30000);

  it("零配置 · 只有 SecretStorage 活动凭据：子会话用它 authenticate，窗口无依据不推", async () => {
    const active = {
      baseUrl: "https://active.example/v1",
      apiKey: "sk-active-secret",
      modelName: "active-model",
    };
    await storeActiveCreds(active);
    zeroConfig();
    const { auth, env } = await spawnAndCollect("zero-active-creds");
    expect(auth?.params.methodId).toBe("openai-compatible");
    expect(auth?.params.methodInfo).toEqual(active);
    // 无内核 settings、无模型键 → 没有任何窗口依据：不推（绝不猜 65k）。
    expect(env.IFLOW_TOKENS_LIMIT).toBeUndefined();
    expectNoSecretInEnv(env, [active.apiKey, active.baseUrl]);
  }, 30000);

  it("零配置 · 全空：不推 authenticate，也不推窗口", async () => {
    zeroConfig();
    const { auth, env } = await spawnAndCollect("zero-empty");
    expect(auth).toBeUndefined();
    expect(env.IFLOW_TOKENS_LIMIT).toBeUndefined();
  }, 30000);

  it("零配置 · 工作区指针指向不存在的 Profile 时回退到 SecretStorage 活动凭据", async () => {
    const active = {
      baseUrl: "https://active-fallback.example/v1",
      apiKey: "sk-active-fallback",
      modelName: "active-fallback-model",
    };
    setWorkspaceProfile("ghost");
    await storeActiveCreds(active);
    zeroConfig();
    const { auth, env } = await spawnAndCollect("zero-pointer-missing");
    // 与今天同序：握手（指针）拿不到 → 落 SecretStorage 活动槽。
    expect(auth?.params.methodInfo).toEqual(active);
    expectNoSecretInEnv(env, [active.apiKey, active.baseUrl]);
  }, 30000);

  it("零配置 · 工作区指针有 Profile、内核无 currentApiProfile：凭据跟指针，窗口无依据不推", async () => {
    writeSettings({ apiProfiles: { main: MAIN } });
    setWorkspaceProfile("main");
    zeroConfig();
    const { auth, env } = await spawnAndCollect("zero-pointer-no-kernel-pointer");
    expect(auth?.params.methodInfo).toEqual({
      apiKey: MAIN.apiKey,
      baseUrl: MAIN.baseUrl,
      modelName: MAIN.modelName,
    });
    // 没有内核指针 / 顶层 tokensLimit / 模型键 → 今天的解析也拿不到窗口。
    expect(env.IFLOW_TOKENS_LIMIT).toBeUndefined();
    expectNoSecretInEnv(env, [MAIN.apiKey, MAIN.baseUrl]);
  }, 30000);

  it("零配置 · 工作区指针与内核 currentApiProfile 不同：凭据跟指针，窗口仍按今天的主会话口径", async () => {
    const other = {
      baseUrl: "https://other.example/v1",
      apiKey: "sk-other-secret",
      modelName: "other-model",
      tokensLimit: 100_000,
    };
    writeSettings({
      selectedAuthType: "openai-compatible",
      currentApiProfile: "other",
      apiProfiles: { main: MAIN, other },
    });
    setWorkspaceProfile("main");
    zeroConfig();
    const { auth, env } = await spawnAndCollect("zero-pointer-vs-kernel");
    // 凭据 = 工作区指针（握手路径），不是内核 currentApiProfile。
    expect(auth?.params.methodInfo).toEqual({
      apiKey: MAIN.apiKey,
      baseUrl: MAIN.baseUrl,
      modelName: MAIN.modelName,
    });
    // 窗口锁定今天的行为：主会话那条链读 currentApiProfile（= other）。
    expect(env.IFLOW_TOKENS_LIMIT).toBe(String(other.tokensLimit));
    expectNoSecretInEnv(env, [MAIN.apiKey, MAIN.baseUrl, other.apiKey, other.baseUrl]);
  }, 30000);

  it("任务级 modelId 只换模型不换凭据：窗口按子会话自己的模型解析，不复用主会话窗口", async () => {
    // 主会话 Profile 的窗口 64000；子会话模型 gpt-4o 的内建窗口 128000。
    writeSettings({
      selectedAuthType: "openai-compatible",
      currentApiProfile: "main",
      apiProfiles: { main: MAIN },
    });
    const active = {
      baseUrl: "https://active-task-model.example/v1",
      apiKey: "sk-active-task-model",
      modelName: "active-task-model",
    };
    await storeActiveCreds(active);
    zeroConfig();
    const { auth, env } = await spawnAndCollect("task-model-only", { modelId: "gpt-4o" });
    // 端点链不因任务级模型覆盖而改变（仍是今天的活动凭据）。
    expect(auth?.params.methodInfo).toEqual(active);
    // 窗口必须跟子会话模型（gpt-4o → 内建 128000），不是主会话的 64000。
    expect(env.IFLOW_TOKENS_LIMIT).toBe("128000");
    expectNoSecretInEnv(env, [active.apiKey, active.baseUrl, MAIN.apiKey]);
  }, 30000);

  it("内核指针指向残缺 Profile 时，SecretStorage 同名 Profile 不得冒充内核指针", async () => {
    // 内核 `ghost` 缺 modelName → readKernelApiProfiles 过滤掉它（不可用）；
    // 但 readActiveEndpoint 会按字段从内核条目取 baseUrl/apiKey（内核自己的
    // 端点，永远不碰 SecretStorage）。
    const kernelTop = {
      baseUrl: "https://kernel-top2.example/v1",
      apiKey: "sk-kernel-top2",
      modelName: "kernel-top2-model",
    };
    writeSettings({
      selectedAuthType: "openai-compatible",
      currentApiProfile: "ghost",
      ...kernelTop,
      apiProfiles: {
        ghost: { baseUrl: "https://kernel-ghost.example/v1", apiKey: "sk-kernel-ghost" },
      },
    });
    // SecretStorage 里一个**同名且完整**的历史 Profile：不能冒充内核指针。
    const legacy = {
      baseUrl: "https://legacy-ghost.example/v1",
      apiKey: "sk-legacy-ghost",
      modelName: "legacy-ghost-model",
    };
    await storeLegacyProfiles({ ghost: legacy });
    // 配置任意超流体指针 → 启用完整 ①→⑤ 链（未配置时 ⑤ 被置空）。
    setConfigOverrides({
      nodePath: process.execPath,
      superAgentProfile: "missing-super",
      superAgentModel: "",
      contextWindowOverrides: [],
    });
    const { auth, env } = await spawnAndCollect("kernel-pointer-incomplete");
    // ⑤b 内核顶层默认（readActiveEndpoint 的字段级结果）—— 不是 legacy。
    expect(auth?.params.methodInfo).toEqual({
      apiKey: "sk-kernel-ghost",
      baseUrl: "https://kernel-ghost.example/v1",
      modelName: kernelTop.modelName,
    });
    expect(auth?.params.methodInfo?.apiKey).not.toBe(legacy.apiKey);
    expectNoSecretInEnv(env, [legacy.apiKey, legacy.baseUrl]);
  }, 30000);

  // ── 派发时 live 模型校验（方案 §7.8 的取舍已反转：派发也校验）─────────────
  //
  // 可证伪性：
  //  - 把 `resolveSuperSpawnPlan` 里的 live 查询去掉（恢复
  //    `liveModelIds: undefined`），第 1 条立刻变红（不降级、没有 toast、
  //    窗口也不是降级模型的）。
  //  - 若把「空列表 / 查询失败 / 超时」也当成下架证据，第 2 / 3 / 4 条会红
  //    （会误降级，正是陷阱 #25 要防的）。
  //  - 若给零配置派发也加这一跳，第 5 条会红（会多发请求）。
  describe("派发时 live 模型校验", () => {
    type PlanModel = {
      modelId: string | null;
      source: string | null;
      degraded: boolean;
      delistedModelId?: string;
      reason?: string;
    };
    type HostInternals = {
      resolveSuperSpawnPlan: (
        taskProfileId: string | null,
        taskModelId: string | null,
      ) => Promise<{
        spec: { endpoint: { baseUrl: string } | null; model: PlanModel };
        configured: boolean;
        modelConfigured: boolean;
      }>;
      /** 管理器 `spawnModel` 回调的实现（先消费 createSuperClient 暂存的计划）。 */
      resolveSpawnModelForSpec: (spec: SuperTaskSpec) => Promise<string | null>;
    };

    /** `superHost` 是面板的私有懒加载访问器；运行时可直接取用（只读调用）。 */
    function hostPlan(): HostInternals {
      return (panel as unknown as { superHost: HostInternals }).superHost;
    }

    /** 记录宿主推给 UI 的 toast（用来断言「降级必须显式」）。 */
    function spyToasts(): Array<{ level: string; message: string }> {
      const store = (panel as unknown as {
        store: { sendToast: (level: string, message: string, opts?: unknown) => number };
      }).store;
      const seen: Array<{ level: string; message: string }> = [];
      vi.spyOn(store, "sendToast").mockImplementation((level: string, message: string) => {
        seen.push({ level, message });
        return seen.length;
      });
      return seen;
    }

    /** 假 `/models` 端点：这是测试里 live 列表的**唯一**来源。 */
    async function startModelsServer(
      onModels: (res: http.ServerResponse) => void,
    ): Promise<{ baseUrl: string; requestCount: () => number; close: () => Promise<void> }> {
      let requests = 0;
      const server = http.createServer((req, res) => {
        if (req.url?.endsWith("/models")) {
          requests++;
          onModels(res);
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("假 /models server 未监听");
      return {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        requestCount: () => requests,
        close: () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
          }),
      };
    }

    /** 超流体 Profile 指向假端点 + 用户点名了一个模型。 */
    function writeLiveServerSettings(baseUrl: string, superModel: string): void {
      writeSettings({
        selectedAuthType: "openai-compatible",
        apiProfiles: {
          main: { ...MAIN },
          superFlow: { baseUrl, apiKey: "sk-live-secret", modelName: "profile-model-x" },
        },
      });
      setWorkspaceProfile("main");
      setConfigOverrides({
        nodePath: process.execPath,
        superAgentProfile: "superFlow",
        superAgentModel: superModel,
        contextWindowOverrides: [],
      });
    }

    it("live 非空且不含目标模型：子会话拿到降级目标，并弹出带真实原因的提示", async () => {
      const server = await startModelsServer((res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "gpt-4o" }] }));
      });
      try {
        writeLiveServerSettings(server.baseUrl, "gone-model");
        const toasts = spyToasts();
        const plan = await hostPlan().resolveSuperSpawnPlan(null, null);
        expect(plan.modelConfigured).toBe(true);
        expect(plan.spec.model.degraded).toBe(true);
        expect(plan.spec.model.delistedModelId).toBe("gone-model");
        // 链上其余候选（profile-model-x / 主会话模型）都不在 live 列表里 →
        // 兜底 live[0]（同主会话兜底口径）。
        expect(plan.spec.model.modelId).toBe("gpt-4o");
        const message =
          "子会话模型 gone-model 已不在可用模型中，本次派发改用 gpt-4o（不会修改你的超流体模型设置）";
        expect(toasts.filter((t) => t.message === message)).toHaveLength(1);
        expect(toasts.find((t) => t.message === message)?.level).toBe("warning");
        // 降级只是提示：用户的 superAgentModel 原样保留。
        expect(vscode.workspace.getConfiguration("iflow").get("superAgentModel")).toBe("gone-model");

        // 端到端：子会话 spawn 真的按降级后的模型解析窗口
        // （gpt-4o → 内建 128000，而不是查不到的 gone-model 的「无依据」）。
        const { env } = await spawnAndCollect("live-degraded");
        expect(env.IFLOW_TOKENS_LIMIT).toBe("128000");
        // 同一结论重复解析（createSuperClient + spawnModel）只提示一次。
        expect(toasts.filter((t) => t.message === message)).toHaveLength(1);
      } finally {
        await server.close();
        vi.restoreAllMocks();
      }
    }, 30000);

    it("live 为空列表：不构成下架证据，不降级、不提示，派发照常", async () => {
      const server = await startModelsServer((res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [] }));
      });
      try {
        writeLiveServerSettings(server.baseUrl, "gone-model");
        const toasts = spyToasts();
        const plan = await hostPlan().resolveSuperSpawnPlan(null, null);
        expect(plan.spec.model.degraded).toBe(false);
        expect(plan.spec.model.modelId).toBe("gone-model");
        expect(toasts).toEqual([]);
        // 派发没有被阻断：子会话照常起来（模型仍是 gone-model，查不到内建窗口）。
        const { env } = await spawnAndCollect("live-empty");
        expect(env.IFLOW_TOKENS_LIMIT).toBeUndefined();
      } finally {
        await server.close();
        vi.restoreAllMocks();
      }
    }, 30000);

    it("live 查询失败（非 2xx）：按无证据处理 —— 不降级、不抛错、派发继续", async () => {
      const server = await startModelsServer((res) => {
        res.statusCode = 500;
        res.end("boom");
      });
      try {
        writeLiveServerSettings(server.baseUrl, "gone-model");
        const toasts = spyToasts();
        const plan = await hostPlan().resolveSuperSpawnPlan(null, null);
        expect(plan.spec.model.degraded).toBe(false);
        expect(plan.spec.model.modelId).toBe("gone-model");
        expect(toasts).toEqual([]);
        const { env } = await spawnAndCollect("live-500");
        expect(env.IFLOW_TOKENS_LIMIT).toBeUndefined();
      } finally {
        await server.close();
        vi.restoreAllMocks();
      }
    }, 30000);

    it("live 查询超时：按无证据处理，并在短超时内放弃（不拖死派发）", async () => {
      // 永不响应 → 走 queryModelIds 的短超时（4s）分支。
      const server = await startModelsServer(() => {});
      try {
        writeLiveServerSettings(server.baseUrl, "gone-model");
        const toasts = spyToasts();
        const startedAt = Date.now();
        const plan = await hostPlan().resolveSuperSpawnPlan(null, null);
        const elapsed = Date.now() - startedAt;
        expect(plan.spec.model.degraded).toBe(false);
        expect(plan.spec.model.modelId).toBe("gone-model");
        expect(toasts).toEqual([]);
        expect(elapsed).toBeLessThan(8_000);
      } finally {
        await server.close();
        vi.restoreAllMocks();
      }
    }, 20000);

    it("零配置派发不发 live 查询：老用户零配置零行为变化", async () => {
      const server = await startModelsServer((res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "other-model" }] }));
      });
      try {
        writeSettings({
          selectedAuthType: "openai-compatible",
          apiProfiles: { main: { ...MAIN } },
        });
        setWorkspaceProfile("main");
        zeroConfig();
        const toasts = spyToasts();
        const plan = await hostPlan().resolveSuperSpawnPlan(null, null);
        expect(plan.modelConfigured).toBe(false);
        expect(plan.spec.model.degraded).toBe(false);
        // 端点来自握手路径（工作区指针 = main），不是假 server。
        expect(plan.spec.endpoint?.baseUrl).toBe(MAIN.baseUrl);
        expect(server.requestCount()).toBe(0);
        expect(toasts).toEqual([]);
      } finally {
        await server.close();
        vi.restoreAllMocks();
      }
    }, 30000);

    // ── 共享设置页缓存（30s TTL / normalizeModelsUrl key / apiKey 比对）──────
    //
    // 可证伪：把 panel.ts `buildSuperHost` 里的 `querySuperModelIds` 注入删掉
    // （宿主回退到无缓存直连），第二条派发会再发一次请求 → 下面第 1 条变红。
    it("同一 Profile 连续两次派发：/models 只发 1 次（与设置页共享同一份缓存）", async () => {
      const server = await startModelsServer((res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "profile-model-x" }] }));
      });
      try {
        writeLiveServerSettings(server.baseUrl, "profile-model-x");
        await spawnAndCollect("cache-first");
        expect(server.requestCount()).toBe(1);
        // 第二次派发同一 Profile：命中面板那份 30s 缓存 → 零额外请求。
        await spawnAndCollect("cache-second");
        expect(server.requestCount()).toBe(1);
      } finally {
        await server.close();
        vi.restoreAllMocks();
      }
    }, 40000);

    it("同一次派发只解析一次计划：createSuperClient 的解析结果被 spawnModel 复用", async () => {
      const server = await startModelsServer((res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "profile-model-x" }] }));
      });
      try {
        writeLiveServerSettings(server.baseUrl, "profile-model-x");
        const host = hostPlan() as HostInternals;
        const spy = vi.spyOn(host, "resolveSuperSpawnPlan");
        await spawnAndCollect("plan-once");
        expect(spy).toHaveBeenCalledTimes(1);
        expect(server.requestCount()).toBe(1);
        // 管理器紧随其后的 spawnModel：消费 createSuperClient 暂存的同一份计划，
        // 不再解析（否则这里会变成 2 次，server 也可能再发一次请求）。
        await expect(
          host.resolveSpawnModelForSpec({ title: "同一派发", task: "复用计划" }),
        ).resolves.toBe("profile-model-x");
        expect(spy).toHaveBeenCalledTimes(1);
        expect(server.requestCount()).toBe(1);
      } finally {
        await server.close();
        vi.restoreAllMocks();
      }
    }, 40000);

    it("不同 Profile 的派发不串台：各自请求一次，互不复用计划", async () => {
      const serverA = await startModelsServer((res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "a-model" }] }));
      });
      const serverB = await startModelsServer((res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "b-model" }] }));
      });
      try {
        writeSettings({
          selectedAuthType: "openai-compatible",
          apiProfiles: {
            main: { ...MAIN },
            superA: { baseUrl: serverA.baseUrl, apiKey: "sk-super-a", modelName: "a-profile-model" },
            superB: { baseUrl: serverB.baseUrl, apiKey: "sk-super-b", modelName: "b-profile-model" },
          },
        });
        setWorkspaceProfile("main");
        setConfigOverrides({
          nodePath: process.execPath,
          superAgentProfile: "superA",
          superAgentModel: "a-model",
          contextWindowOverrides: [],
        });
        const host = hostPlan() as HostInternals;
        const spy = vi.spyOn(host, "resolveSuperSpawnPlan");
        // A 派发：解析到 A 的端点（请求 A 一次）。
        await spawnAndCollect("isolation-a");
        expect(serverA.requestCount()).toBe(1);
        expect(serverB.requestCount()).toBe(0);
        // B 的任务级覆盖：暂存键不同 → 不得复用 A 的计划，重新解析并打 B 端点。
        await expect(
          host.resolveSpawnModelForSpec({
            title: "B 任务",
            task: "走 B 端点",
            profileId: "superB",
            modelId: "b-model",
          }),
        ).resolves.toBe("b-model");
        // 解析了两次（A 一次、B 一次）；B 的查询只打 B 的端点。
        expect(spy).toHaveBeenCalledTimes(2);
        expect(serverB.requestCount()).toBe(1);
        expect(serverA.requestCount()).toBe(1);
      } finally {
        await serverA.close();
        await serverB.close();
        vi.restoreAllMocks();
      }
    }, 40000);
  });
});
