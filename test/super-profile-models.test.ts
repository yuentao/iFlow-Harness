/**
 * 超流体（Super Agent）链路的独立 API 配置与模型 —— 协议与数据通道。
 *
 * 覆盖四条线：
 *   ① 按 Profile 的 baseUrl 实时拉到模型列表（用本地假 HTTP server，绝不连外网）；
 *   ② 端点不可达 → 返回空列表、不抛错、**不回退内建目录**；
 *   ③ 两个新键（`iflow.superAgentProfile` / `iflow.superAgentModel`）写入后
 *      回推值正确，且是 Global 作用域的**单键**写入；
 *   ④ 写入失败时 toast 带**真实错误原因**（不是一句泛化的「保存失败」）。
 *
 * 陷阱守则：
 *   • 模型列表的唯一数据源是实时 `GET {baseUrl}/models`；CLI 的
 *     `_meta.models.availableModels` 是硬编码目录，不可作为回退。
 *   • 查询必须走原生 `node:http(s)` 直连：扩展宿主被代理 agent patch 过，
 *     全局 `fetch` 遇到 SOCKS / 无 scheme 代理会抛 Invalid URL protocol。
 *   • VSCode 设置只能单键合并写（Global），严禁读全量 JSON 再整文件写回。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import * as vscode from "vscode";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import type { SuperProfileModelsUi } from "../shared/messages.js";
import { AUTH_SECRET_KEY, loadCredentials } from "../src/acp/auth.js";
import { readActiveEndpoint } from "../src/acp/models-query.js";
import { setConfigOverrides } from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** 可变 SecretStorage 替身：测试可在任意时刻写入/改写（`loadCredentials`
 *  在调用时读取，所以后写的值对下一次解析生效）。 */
interface SecretBag {
  map: Map<string, string>;
  secrets: vscodeTypes.SecretStorage;
}

function makeSecretBag(initial: Record<string, string> = {}): SecretBag {
  const map = new Map(Object.entries(initial));
  return {
    map,
    secrets: {
      get: (key: string) => Promise.resolve(map.get(key)),
      store: (key: string, value: string) => {
        map.set(key, value);
        return Promise.resolve();
      },
      delete: (key: string) => {
        map.delete(key);
        return Promise.resolve();
      },
    } as unknown as vscodeTypes.SecretStorage,
  };
}

function makeContext(
  storageDir: string,
  secretsImpl: vscodeTypes.SecretStorage = makeSecretBag().secrets,
): vscodeTypes.ExtensionContext {
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
    secrets: secretsImpl,
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

interface Credentials {
  baseUrl: string;
  apiKey: string;
  modelName: string;
}

type PanelInternals = {
  handleWebviewMessage: (msg: { type: string; [k: string]: unknown }) => Promise<void>;
  postToWebview: (message: unknown) => void;
  querySuperProfileModelIds: (
    creds: Credentials,
  ) => Promise<{ ids: string[]; error?: string }>;
  buildSuperProfileModels: (profileName?: string) => Promise<SuperProfileModelsUi>;
  pushSuperProfileModels: (profileName?: unknown, requestId?: unknown) => Promise<void>;
  clearSuperProfileModelsCache: () => void;
  resolveSuperProfileTarget: (wanted: unknown) => Promise<unknown>;
  resolveWorkspaceHandshakeCreds: () => Promise<Credentials | null>;
  superSelectedModel: (creds: Credentials | null, taskModelId?: string | null) => string;
  store: {
    sendToast: (...args: unknown[]) => number;
    sessionMeta: (meta: { currentModelId?: string | null }) => void;
    getState: () => { currentModelId: string | null };
  };
};

/** 写入内核 `settings.json`（`apiProfiles` 是面板 API 配置的唯一权威）。
 *  `currentApiProfile` = 主链路当前的活动 Profile（空串 = 没选）。 */
function writeKernelSettings(
  home: string,
  profiles: Record<string, Credentials>,
  currentApiProfile = "",
): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "settings.json"),
    JSON.stringify(
      {
        selectedAuthType: "openai-compatible",
        ...(currentApiProfile ? { currentApiProfile } : {}),
        apiProfiles: profiles,
      },
      null,
      2,
    ),
    "utf8",
  );
}

/** 假 HTTP server：记录收到的 Authorization 头，按需返回 /models 载荷。 */
interface FakeEndpoint {
  baseUrl: string;
  requests: Array<{ url: string | undefined; auth: string | undefined }>;
  close: () => Promise<void>;
}

async function startFakeEndpoint(
  handler: (url: string | undefined) => { status: number; body: string },
): Promise<FakeEndpoint> {
  const requests: FakeEndpoint["requests"] = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization });
    const { status, body } = handler(req.url);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** 配置替身：写入真的会落值（VSCode stub 默认不落值，测不出「写入 → 回推」）。 */
interface FakeConfigState {
  values: Map<string, unknown>;
  failWith: Error | null;
  updates: Array<{ key: string; value: unknown; target: unknown }>;
}

function installFakeConfig(state: FakeConfigState): void {
  const original = vscode.workspace.getConfiguration.bind(vscode.workspace);
  vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation(((
    section?: string,
    scope?: unknown,
  ) => {
    const base = original(section, scope as never);
    return {
      get: <T>(key: string, fallback?: T): T => {
        if (state.values.has(key)) return state.values.get(key) as T;
        const value = fallback === undefined ? base.get<T>(key) : base.get<T>(key, fallback);
        return (value ?? fallback) as T;
      },
      inspect: (key: string) => base.inspect(key),
      update: async (key: string, value: unknown, target?: unknown): Promise<void> => {
        state.updates.push({ key, value, target });
        if (state.failWith) throw state.failWith;
        state.values.set(key, value);
      },
    };
  }) as never);
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await flush();
}

/**
 * 超流体链路的独立 API 配置与模型：协议 + 宿主接线。
 */
describe("超流体链路的独立 API 配置与模型（协议与数据通道）", () => {
  let panel: ChatPanel;
  let p: PanelInternals;
  let context: vscodeTypes.ExtensionContext;
  let secretBag: SecretBag;
  let storageDir: string;
  let home: string;
  let state: FakeConfigState;
  let posted: Array<Record<string, unknown>>;
  let toasts: Array<{ level: string; message: string }>;
  let previousIflowHome: string | undefined;

  beforeEach(async () => {
    setConfigOverrides({
      checkpoints: false,
      efficiencyMode: "steady",
      autoMemoryCapture: false,
      autoTitle: false,
      nextStepSuggestions: false,
      superAgentProfile: "",
      superAgentModel: "",
    });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-super-profile-storage-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-super-profile-home-"));
    previousIflowHome = process.env.IFLOW_HOME;
    process.env.IFLOW_HOME = home;
    state = { values: new Map(), failWith: null, updates: [] };
    installFakeConfig(state);
    secretBag = makeSecretBag();
    context = makeContext(storageDir, secretBag.secrets);
    panel = new ChatPanel(context, { workspaceRoot: here, watchers: makeWatchers() });
    p = panel as unknown as PanelInternals;
    posted = [];
    toasts = [];
    vi.spyOn(p, "postToWebview").mockImplementation(((message: unknown) => {
      posted.push(message as Record<string, unknown>);
    }) as never);
    vi.spyOn(p.store, "sendToast").mockImplementation(((level: string, message: string) => {
      toasts.push({ level, message });
      return 0;
    }) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await panel.dispose();
    if (previousIflowHome === undefined) delete process.env.IFLOW_HOME;
    else process.env.IFLOW_HOME = previousIflowHome;
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /** 最近一次推给 webview 的 superProfileModels 载荷。 */
  const lastModelsPayload = (): SuperProfileModelsUi | undefined => {
    for (let i = posted.length - 1; i >= 0; i--) {
      const message = posted[i]!;
      if (message["type"] === "superProfileModels") return message as unknown as SuperProfileModelsUi;
    }
    return undefined;
  };

  it("① 按 Profile 的 baseUrl 实时拉到模型列表（原生直连，Authorization 正确）", async () => {
    const endpoint = await startFakeEndpoint(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }),
    }));
    try {
      writeKernelSettings(home, {
        "super-gw": { baseUrl: endpoint.baseUrl, apiKey: "sk-super-test", modelName: "model-b" },
      });
      setConfigOverrides({
        checkpoints: false,
        efficiencyMode: "steady",
        autoMemoryCapture: false,
        autoTitle: false,
        nextStepSuggestions: false,
        superAgentProfile: "super-gw",
        superAgentModel: "model-b",
      });

      await p.handleWebviewMessage({ type: "refreshSuperProfileModels" });
      await waitFor(() => lastModelsPayload() !== undefined);

      const payload = lastModelsPayload();
      expect(payload).toBeDefined();
      expect(payload!.profileName).toBe("super-gw");
      expect(payload!.error).toBeUndefined();
      // 实时列表原样返回（当前选中的模型已在列表里，不重复补头）。
      expect(payload!.models.map((m) => m.id)).toEqual(["model-a", "model-b"]);
      // 真的打到了那个 Profile 的 baseUrl，且带上了该 Profile 的 key。
      expect(endpoint.requests).toHaveLength(1);
      expect(endpoint.requests[0]!.url).toBe("/v1/models");
      expect(endpoint.requests[0]!.auth).toBe("Bearer sk-super-test");
    } finally {
      await endpoint.close();
    }
  });

  it("② 端点不可达：返回空列表、不抛错、不回退内建目录", async () => {
    // 端口上没有任何监听者 → 连接被拒（快，不会等满 10s 超时）。
    const dead = await startFakeEndpoint(() => ({ status: 200, body: "{}" }));
    const deadBaseUrl = dead.baseUrl;
    await dead.close();
    writeKernelSettings(home, {
      "super-gw": { baseUrl: deadBaseUrl, apiKey: "sk-super-test", modelName: "model-x" },
    });
    setConfigOverrides({
      checkpoints: false,
      efficiencyMode: "steady",
      autoMemoryCapture: false,
      autoTitle: false,
      nextStepSuggestions: false,
      superAgentProfile: "super-gw",
      superAgentModel: "",
    });

    // 原始查询结果必须是空数组：绝不退回 CLI 的硬编码模型目录。
    const raw = await p.querySuperProfileModelIds({
      baseUrl: deadBaseUrl,
      apiKey: "sk-super-test",
      modelName: "model-x",
    });
    expect(raw.ids).toEqual([]);
    expect(raw.error).toBeTruthy();

    await p.handleWebviewMessage({ type: "refreshSuperProfileModels" });
    await waitFor(() => lastModelsPayload() !== undefined);

    const payload = lastModelsPayload();
    expect(payload).toBeDefined();
    // 失败必须带真实原因（而不是静默空列表）。
    expect(payload!.error).toBeTruthy();
    // 列表里最多只有「当前选中的模型」（补头避免下拉空白），绝不含内建目录里的模型。
    expect(payload!.models.map((m) => m.id)).toEqual(["model-x"]);
    expect(payload!.currentModelId).toBe("model-x");
  });

  it("②b 端点返回非 200 时同样只报真实原因，不回退内建目录", async () => {
    const endpoint = await startFakeEndpoint(() => ({ status: 503, body: "{}" }));
    try {
      writeKernelSettings(home, {
        "super-gw": { baseUrl: endpoint.baseUrl, apiKey: "sk-super-test", modelName: "model-x" },
      });
      setConfigOverrides({
        checkpoints: false,
        efficiencyMode: "steady",
        autoMemoryCapture: false,
        autoTitle: false,
        nextStepSuggestions: false,
        superAgentProfile: "super-gw",
        superAgentModel: "",
      });

      const raw = await p.querySuperProfileModelIds({
        baseUrl: endpoint.baseUrl,
        apiKey: "sk-super-test",
        modelName: "model-x",
      });
      expect(raw.ids).toEqual([]);
      expect(raw.error).toContain("503");
    } finally {
      await endpoint.close();
    }
  });

  it("③ 两个新键按 Global 单键写入，且回推值正确", async () => {
    await p.handleWebviewMessage({
      type: "setHostSettings",
      superAgentProfile: " super-gw ",
      superAgentModel: " model-b ",
    });

    // 单键合并写：两个键各一条 Global 写入，绝不整文件写回。
    const ours = state.updates.filter((u) => u.key === "superAgentProfile" || u.key === "superAgentModel");
    expect(ours).toHaveLength(2);
    expect(ours.find((u) => u.key === "superAgentProfile")!.value).toBe("super-gw");
    expect(ours.find((u) => u.key === "superAgentModel")!.value).toBe("model-b");
    for (const update of ours) {
      expect(update.target).toBe(vscode.ConfigurationTarget.Global);
    }

    // 回推：hostSettings 必须带上生效值（空串 = 跟随主链路）。
    const hostSettings = posted.find((m) => m["type"] === "hostSettings") as
      | Record<string, unknown>
      | undefined;
    expect(hostSettings).toBeDefined();
    expect(hostSettings!["superAgentProfile"]).toBe("super-gw");
    expect(hostSettings!["superAgentModel"]).toBe("model-b");
  });

  it("④ 写入失败时 toast 带真实错误原因（不是一句「保存失败」）", async () => {
    state.failWith = new Error("settings.json 是只读的，无法写入");
    await p.handleWebviewMessage({ type: "setHostSettings", superAgentProfile: "super-gw" });

    const failure = toasts.find((t) => t.message.includes("设置写入失败"));
    expect(failure).toBeDefined();
    expect(failure!.message).toContain("settings.json 是只读的，无法写入");
    expect(failure!.message).toContain("superAgentProfile");
  });

  it("⑤ 同一端点的重复请求命中短缓存，换端点必须失效", async () => {
    const endpoint = await startFakeEndpoint(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: "model-a" }] }),
    }));
    try {
      writeKernelSettings(home, {
        "super-gw": { baseUrl: endpoint.baseUrl, apiKey: "sk-super-test", modelName: "model-a" },
      });
      setConfigOverrides({
        checkpoints: false,
        efficiencyMode: "steady",
        autoMemoryCapture: false,
        autoTitle: false,
        nextStepSuggestions: false,
        superAgentProfile: "super-gw",
        superAgentModel: "",
      });

      await p.handleWebviewMessage({ type: "refreshSuperProfileModels" });
      await waitFor(() => lastModelsPayload() !== undefined);
      expect(endpoint.requests).toHaveLength(1);

      // 同一端点：短缓存命中，不再打网络。
      await p.handleWebviewMessage({ type: "refreshSuperProfileModels" });
      await waitFor(() => posted.filter((m) => m["type"] === "superProfileModels").length >= 2);
      expect(endpoint.requests).toHaveLength(1);

      // 换端点（改写 Profile 的 baseUrl）：缓存必须失效，重新打网络。
      const other = await startFakeEndpoint(() => ({
        status: 200,
        body: JSON.stringify({ data: [{ id: "model-z" }] }),
      }));
      try {
        writeKernelSettings(home, {
          "super-gw": { baseUrl: other.baseUrl, apiKey: "sk-super-test", modelName: "model-z" },
        });
        (p as unknown as { clearSuperProfileModelsCache: () => void }).clearSuperProfileModelsCache();
        await p.handleWebviewMessage({ type: "refreshSuperProfileModels" });
        await waitFor(
          () => posted.filter((m) => m["type"] === "superProfileModels").length >= 3,
        );
        expect(other.requests).toHaveLength(1);
        const payload = lastModelsPayload();
        expect(payload!.models.map((m) => m.id)).toContain("model-z");
      } finally {
        await other.close();
      }
    } finally {
      await endpoint.close();
    }
  });

  it("⑥ 选中的 Profile 不存在时给出真实原因（未找到 API 配置）", async () => {
    setConfigOverrides({
      checkpoints: false,
      efficiencyMode: "steady",
      autoMemoryCapture: false,
      autoTitle: false,
      nextStepSuggestions: false,
      superAgentProfile: "no-such-profile",
      superAgentModel: "",
    });
    await p.handleWebviewMessage({ type: "refreshSuperProfileModels" });
    await waitFor(() => lastModelsPayload() !== undefined);
    const payload = lastModelsPayload();
    expect(payload!.error).toContain("未找到 API 配置");
    expect(payload!.models).toEqual([]);
  });

  it("⑦ 空串 = 跟随主链路（不会被当成「名叫空串的 Profile」）", async () => {
    const main = await startFakeEndpoint(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: "main-model" }] }),
    }));
    const other = await startFakeEndpoint(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: "other-model" }] }),
    }));
    try {
      writeKernelSettings(
        home,
        {
          "main-gw": { baseUrl: main.baseUrl, apiKey: "sk-main-test", modelName: "main-model" },
          "super-gw": { baseUrl: other.baseUrl, apiKey: "sk-super-test", modelName: "other-model" },
        },
        "main-gw",
      );
      setConfigOverrides({
        checkpoints: false,
        efficiencyMode: "steady",
        autoMemoryCapture: false,
        autoTitle: false,
        nextStepSuggestions: false,
        superAgentProfile: "",
        superAgentModel: "",
      });

      await p.handleWebviewMessage({ type: "refreshSuperProfileModels" });
      await waitFor(() => lastModelsPayload() !== undefined);

      const payload = lastModelsPayload();
      // 回推的是**实际查询的** Profile 名：跟随主链路 → 主会话的活动 Profile。
      expect(payload!.profileName).toBe("main-gw");
      expect(payload!.models.map((m) => m.id)).toEqual(["main-model"]);
      expect(payload!.error).toBeUndefined();
      // 查的是主链路的端点，不是「空串 Profile」，也不是别的 Profile。
      expect(main.requests).toHaveLength(1);
      expect(other.requests).toHaveLength(0);
    } finally {
      await main.close();
      await other.close();
    }
  });

  it("⑧ 载荷里绝不带 apiKey（凭据不出宿主）", async () => {
    const endpoint = await startFakeEndpoint(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: "model-a" }] }),
    }));
    try {
      writeKernelSettings(home, {
        "super-gw": { baseUrl: endpoint.baseUrl, apiKey: "sk-super-secret", modelName: "model-a" },
      });
      setConfigOverrides({
        checkpoints: false,
        efficiencyMode: "steady",
        autoMemoryCapture: false,
        autoTitle: false,
        nextStepSuggestions: false,
        superAgentProfile: "super-gw",
        superAgentModel: "",
      });

      await p.handleWebviewMessage({ type: "refreshSuperProfileModels" });
      await waitFor(() => lastModelsPayload() !== undefined);

      const payload = lastModelsPayload();
      expect(JSON.stringify(payload)).not.toContain("sk-super-secret");
      // 凭据只出现在请求头里（服务端能看到，webview 看不到）。
      expect(endpoint.requests[0]!.auth).toBe("Bearer sk-super-secret");
    } finally {
      await endpoint.close();
    }
  });

  it("⑨ 宿主内部异常也必须回一条载荷（下拉框不能永远转圈）", async () => {
    vi.spyOn(p, "resolveSuperProfileTarget").mockRejectedValue(
      new Error("模拟宿主内部错误"),
    );
    await p.pushSuperProfileModels();
    const payload = lastModelsPayload();
    expect(payload).toBeDefined();
    expect(payload!.error).toContain("模拟宿主内部错误");
    expect(payload!.models).toEqual([]);
  });

  it("⑩ 同一端点的不同写法共用缓存，换端点必失效", async () => {
    const endpoint = await startFakeEndpoint(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: "model-a" }] }),
    }));
    try {
      writeKernelSettings(home, {
        "super-gw": { baseUrl: endpoint.baseUrl, apiKey: "sk-super-test", modelName: "model-a" },
      });
      setConfigOverrides({
        checkpoints: false,
        efficiencyMode: "steady",
        autoMemoryCapture: false,
        autoTitle: false,
        nextStepSuggestions: false,
        superAgentProfile: "super-gw",
        superAgentModel: "",
      });

      await p.handleWebviewMessage({ type: "refreshSuperProfileModels" });
      await waitFor(() => lastModelsPayload() !== undefined);
      expect(endpoint.requests).toHaveLength(1);

      // 同一个端点的另一种写法（多一个尾斜杠）= 同一个请求目标 → 命中缓存。
      const raw = await p.querySuperProfileModelIds({
        baseUrl: `${endpoint.baseUrl}/`,
        apiKey: "sk-super-test",
        modelName: "model-a",
      });
      expect(raw.error).toBeUndefined();
      expect(endpoint.requests).toHaveLength(1);

      // 换端点（另一个 baseUrl）→ 必须重查，绝不命中旧端点的列表。
      const other = await startFakeEndpoint(() => ({
        status: 200,
        body: JSON.stringify({ data: [{ id: "model-z" }] }),
      }));
      try {
        writeKernelSettings(home, {
          "super-gw": { baseUrl: other.baseUrl, apiKey: "sk-super-test", modelName: "model-z" },
        });
        await p.handleWebviewMessage({ type: "refreshSuperProfileModels" });
        await waitFor(
          () => posted.filter((m) => m["type"] === "superProfileModels").length >= 2,
        );
        expect(other.requests).toHaveLength(1);
        expect(lastModelsPayload()!.models.map((m) => m.id)).toContain("model-z");
      } finally {
        await other.close();
      }
    } finally {
      await endpoint.close();
    }
  });

  it("⑪ 脏值（手改 settings.json 塞了非字符串）不崩，也不拖累同批的其它设置", async () => {
    // settings.json 是用户可手改的：非字符串必须被当空串，而不是让 .trim() 抛错。
    setConfigOverrides({
      checkpoints: false,
      efficiencyMode: "steady",
      autoMemoryCapture: false,
      autoTitle: false,
      nextStepSuggestions: false,
      superAgentProfile: 123 as unknown as string,
      superAgentModel: "",
    });

    await expect(
      p.handleWebviewMessage({ type: "setHostSettings", superAgentModel: "model-x" }),
    ).resolves.toBeUndefined();
    // 同一批里的其它设置照写不误。
    expect(state.updates.find((u) => u.key === "superAgentModel")!.value).toBe("model-x");

    // 刷新模型列表也不能抛：脏值按「跟随主链路」处理，给出真实原因。
    await expect(
      p.handleWebviewMessage({ type: "refreshSuperProfileModels" }),
    ).resolves.toBeUndefined();
    await waitFor(() => lastModelsPayload() !== undefined);
    const payload = lastModelsPayload();
    expect(payload!.error).toBeTruthy();
    expect(payload!.models).toEqual([]);
  });

  it("⑫ VSCode 侧直接改设置时：缓存失效 + 把新端点的列表推给 webview（源码锁）", () => {
    const source = fs.readFileSync(path.join(here, "..", "src", "panel", "panel.ts"), "utf8");
    // Profile 键：配置监听器里必须同时清缓存并推送（面板之外的改动
    // webview 自己不知道，不会来请求）。
    expect(source).toMatch(
      /if \(e\.affectsConfiguration\("iflow\.superAgentProfile"\)\) \{\s*this\.clearSuperProfileModelsCache\(\);\s*void this\.pushSuperProfileModels\(\);/,
    );
    // 模型键也要覆盖：端点列表不用失效，但载荷里的 currentModelId / 补头项
    // 要重推（否则外部改成列表外的模型时下拉空白）。两个新键都被覆盖。
    expect(source).toMatch(
      /else if \(e\.affectsConfiguration\("iflow\.superAgentModel"\)\) \{[^}]*void this\.pushSuperProfileModels\(\);/,
    );
    // 监听器只存在于 panel.ts（super-agent-host.ts 里没有第二份）。
    const host = fs.readFileSync(
      path.join(here, "..", "src", "panel", "super-agent-host.ts"),
      "utf8",
    );
    expect(host).not.toContain("onDidChangeConfiguration");
  });

  // ── 收敛后的一致性 / 补洞用例 ────────────────────────────────────────────

  const setSuperSettings = (profile: string, model: string): void => {
    setConfigOverrides({
      checkpoints: false,
      efficiencyMode: "steady",
      autoMemoryCapture: false,
      autoTitle: false,
      nextStepSuggestions: false,
      superAgentProfile: profile,
      superAgentModel: model,
    });
  };

  /** 今天主会话实际用的凭据链（独立 oracle）：握手 → 活动凭据 → 内核活动/顶层默认。 */
  const mainHandshakeEndpoint = async (): Promise<{
    baseUrl: string;
    apiKey: string;
    modelName: string | null;
  } | null> =>
    (await p.resolveWorkspaceHandshakeCreds()) ??
    (await loadCredentials(context.secrets)) ??
    readActiveEndpoint();

  const normalizeCreds = (
    creds: { baseUrl: string; apiKey: string; modelName: string | null } | null,
  ): Credentials | null =>
    creds
      ? { baseUrl: creds.baseUrl, apiKey: creds.apiKey, modelName: creds.modelName ?? "" }
      : null;

  const superTargetCreds = async (): Promise<Credentials | null> => {
    const target = (await p.resolveSuperProfileTarget("")) as
      | { name: string; creds: Credentials }
      | { name: string; error: string };
    return "creds" in target ? target.creds : null;
  };

  /** 断言「未配置超流体」时超流体端点 ≡ 主会话握手/活动端点。 */
  const expectSuperMatchesMain = async (): Promise<Credentials | null> => {
    const main = normalizeCreds(await mainHandshakeEndpoint());
    expect(normalizeCreds(await superTargetCreds())).toEqual(main);
    return main;
  };

  it("⑭ 等价：workspace 指针有 + 内核 currentApiProfile 有 → 与主会话握手一致", async () => {
    writeKernelSettings(
      home,
      {
        "ws-gw": {
          baseUrl: "https://ws.example/v1",
          apiKey: "sk-ws",
          modelName: "ws-model",
        },
        "kernel-gw": {
          baseUrl: "https://kernel.example/v1",
          apiKey: "sk-kernel",
          modelName: "kernel-model",
        },
      },
      "kernel-gw",
    );
    await context.workspaceState.update("iflow.workspaceActiveProfile", "ws-gw");
    const main = await expectSuperMatchesMain();
    // 工作区记录优先于内核指针（与握手路径一致）。
    expect(main).toEqual({ baseUrl: "https://ws.example/v1", apiKey: "sk-ws", modelName: "ws-model" });
  });

  it("⑮ 等价：workspace 指针有 + 内核 currentApiProfile 无", async () => {
    writeKernelSettings(home, {
      "ws-gw": { baseUrl: "https://ws.example/v1", apiKey: "sk-ws", modelName: "ws-model" },
    });
    await context.workspaceState.update("iflow.workspaceActiveProfile", "ws-gw");
    const main = await expectSuperMatchesMain();
    expect(main?.baseUrl).toBe("https://ws.example/v1");
  });

  it("⑯ 等价：workspace 指针无 + 内核 currentApiProfile 有", async () => {
    writeKernelSettings(
      home,
      {
        "kernel-gw": {
          baseUrl: "https://kernel.example/v1",
          apiKey: "sk-kernel",
          modelName: "kernel-model",
        },
      },
      "kernel-gw",
    );
    const main = await expectSuperMatchesMain();
    expect(main).toEqual({
      baseUrl: "https://kernel.example/v1",
      apiKey: "sk-kernel",
      modelName: "kernel-model",
    });
  });

  it("⑰ 等价：workspace 无 + 内核指针无 + 只有顶层 baseUrl/apiKey（第⑤级真缺口）", async () => {
    fs.writeFileSync(
      path.join(home, "settings.json"),
      JSON.stringify({
        selectedAuthType: "openai-compatible",
        baseUrl: "https://top.example/v1",
        apiKey: "sk-top",
        modelName: "top-model",
      }),
      "utf8",
    );
    const main = await expectSuperMatchesMain();
    expect(main).toEqual({
      baseUrl: "https://top.example/v1",
      apiKey: "sk-top",
      modelName: "top-model",
    });
  });

  it("⑱ 等价：workspace 无 + 内核无 + 只有 SecretStorage 活动凭据", async () => {
    secretBag.map.set(
      AUTH_SECRET_KEY,
      JSON.stringify({
        baseUrl: "https://secret.example/v1",
        apiKey: "sk-secret",
        modelName: "secret-model",
      }),
    );
    const main = await expectSuperMatchesMain();
    expect(main).toEqual({
      baseUrl: "https://secret.example/v1",
      apiKey: "sk-secret",
      modelName: "secret-model",
    });
  });

  it("⑲ 等价：workspace 指针指向不存在的 Profile + 内核指针有 → 一起回落到内核", async () => {
    writeKernelSettings(
      home,
      {
        "kernel-gw": {
          baseUrl: "https://kernel.example/v1",
          apiKey: "sk-kernel",
          modelName: "kernel-model",
        },
      },
      "kernel-gw",
    );
    await context.workspaceState.update("iflow.workspaceActiveProfile", "gone-gw");
    const main = await expectSuperMatchesMain();
    expect(main?.baseUrl).toBe("https://kernel.example/v1");
  });

  it("⑳ 等价：完全未配置时两边都没有端点（超流体给出真实原因）", async () => {
    const main = normalizeCreds(await mainHandshakeEndpoint());
    expect(main).toBeNull();
    const target = (await p.resolveSuperProfileTarget("")) as { error?: string };
    expect(target.error).toContain("还没有配置 API 端点");
  });

  it("⑳b 等价：内核 selectedAuthType 不是 openai-compatible 时，具名内核 Profile 也不算端点", async () => {
    fs.writeFileSync(
      path.join(home, "settings.json"),
      JSON.stringify({
        selectedAuthType: "oauth",
        currentApiProfile: "kernel-gw",
        apiProfiles: {
          "kernel-gw": {
            baseUrl: "https://kernel.example/v1",
            apiKey: "sk-kernel",
            modelName: "kernel-model",
          },
        },
      }),
      "utf8",
    );
    const main = normalizeCreds(await mainHandshakeEndpoint());
    expect(main).toBeNull();
    const target = (await p.resolveSuperProfileTarget("")) as { error?: string };
    expect(target.error).toContain("还没有配置 API 端点");
  });

  it("㉑ 只有内核顶层 baseUrl/apiKey 时，超流体侧的模型列表也能拉到", async () => {
    const endpoint = await startFakeEndpoint(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: "model-a" }] }),
    }));
    try {
      fs.writeFileSync(
        path.join(home, "settings.json"),
        JSON.stringify(
          {
            selectedAuthType: "openai-compatible",
            baseUrl: endpoint.baseUrl,
            apiKey: "sk-top",
            modelName: "top-model",
          },
          null,
          2,
        ),
        "utf8",
      );
      await p.handleWebviewMessage({ type: "refreshSuperProfileModels" });
      await waitFor(() => lastModelsPayload() !== undefined);
      const payload = lastModelsPayload();
      expect(payload!.error).toBeUndefined();
      expect(payload!.models.map((m) => m.id)).toContain("model-a");
      expect(payload!.currentModelId).toBe("top-model");
      // 没有具名 Profile 可展示（展示名不是管理名）。
      expect(payload!.profileName).toBe("");
      expect(endpoint.requests[0]!.auth).toBe("Bearer sk-top");
    } finally {
      await endpoint.close();
    }
  });

  it("㉒ 模型链①：任务级 modelId 覆盖设置与 Profile 模型", () => {
    setSuperSettings("", "m-super");
    expect(
      p.superSelectedModel(
        { baseUrl: "https://x.example/v1", apiKey: "k", modelName: "m-profile" },
        "m-task",
      ),
    ).toBe("m-task");
  });

  it("㉓ 模型链②：iflow.superAgentModel 优先于 Profile 自带模型", () => {
    setSuperSettings("", "m-super");
    expect(
      p.superSelectedModel({ baseUrl: "https://x.example/v1", apiKey: "k", modelName: "m-profile" }),
    ).toBe("m-super");
  });

  it("㉔ 模型链④：设置与 Profile 模型都为空时回退主 store 的 currentModelId", () => {
    setSuperSettings("", "");
    p.store.sessionMeta({ currentModelId: "m-main" });
    expect(p.store.getState().currentModelId).toBe("m-main");
    expect(
      p.superSelectedModel({ baseUrl: "https://x.example/v1", apiKey: "k", modelName: "" }),
    ).toBe("m-main");
    expect(p.superSelectedModel(null)).toBe("m-main");
  });

  // ── 请求序号（迟到回包串台的根治）────────────────────────────────────────

  it("㉕ 回包原样回显请求的 requestId", async () => {
    const endpoint = await startFakeEndpoint(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: "model-a" }] }),
    }));
    try {
      writeKernelSettings(home, {
        "super-gw": { baseUrl: endpoint.baseUrl, apiKey: "sk-super-test", modelName: "model-a" },
      });
      setSuperSettings("super-gw", "");

      await p.handleWebviewMessage({
        type: "refreshSuperProfileModels",
        profileName: "super-gw",
        requestId: 42,
      });
      await waitFor(() => lastModelsPayload() !== undefined);
      expect(lastModelsPayload()!.requestId).toBe(42);
    } finally {
      await endpoint.close();
    }
  });

  it("㉖ 宿主内部异常的回包同样回显 requestId（下拉框不永远转圈）", async () => {
    vi.spyOn(p, "resolveSuperProfileTarget").mockRejectedValue(new Error("模拟宿主内部错误"));
    await p.pushSuperProfileModels("super-gw", 7);
    const payload = lastModelsPayload();
    expect(payload).toBeDefined();
    expect(payload!.error).toContain("模拟宿主内部错误");
    expect(payload!.requestId).toBe(7);
  });

  it("㉗ 宿主主动推送（无 requestId / 脏值）不伪造序号", async () => {
    const endpoint = await startFakeEndpoint(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: "model-a" }] }),
    }));
    try {
      writeKernelSettings(home, {
        "super-gw": { baseUrl: endpoint.baseUrl, apiKey: "sk-super-test", modelName: "model-a" },
      });
      setSuperSettings("super-gw", "");

      // 配置监听器 / 设置回推走的是同一个 push（不带 requestId）。
      await p.pushSuperProfileModels();
      expect(lastModelsPayload()).toBeDefined();
      expect(lastModelsPayload()!.requestId).toBeUndefined();

      // 脏值（非数字）也不冒充一次请求的回包。
      await p.pushSuperProfileModels("super-gw", "42");
      expect(lastModelsPayload()!.requestId).toBeUndefined();
    } finally {
      await endpoint.close();
    }
  });

  // ── 降级显式化（缺口 B）──────────────────────────────────────────────────

  it("㉘ live 非空且不含选中模型 → 显式标记降级，并带回被下架/实际回退的模型", async () => {
    const endpoint = await startFakeEndpoint(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: "live-a" }, { id: "live-b" }] }),
    }));
    try {
      writeKernelSettings(home, {
        "super-gw": { baseUrl: endpoint.baseUrl, apiKey: "sk-super-test", modelName: "profile-default" },
      });
      setSuperSettings("super-gw", "gone-model");
      p.store.sessionMeta({ currentModelId: null });

      await p.handleWebviewMessage({
        type: "refreshSuperProfileModels",
        profileName: "super-gw",
        requestId: 1,
      });
      await waitFor(() => lastModelsPayload() !== undefined);

      const payload = lastModelsPayload()!;
      expect(payload.degraded).toBe(true);
      expect(payload.delistedModelId).toBe("gone-model");
      // 链上更低候选都不在 live 里 → 用 live 首个模型兜底（与主会话同款）。
      expect(payload.degradedModelId).toBe("live-a");
      expect(payload.degradedReason).toBeTruthy();
      // 选中的（已下架）模型仍补在列表头，下拉不空白。
      expect(payload.models.map((m) => m.id)).toEqual(["gone-model", "live-a", "live-b"]);
      // 只提示，不擅改用户的设置（没有任何 superAgentModel 写入）。
      expect(state.updates.some((u) => u.key === "superAgentModel")).toBe(false);
      expect(state.values.has("superAgentModel")).toBe(false);
    } finally {
      await endpoint.close();
    }
  });

  it("㉙ live 列表为空（200 但没有任何模型）不构成下架证据：不标记降级、不带 error", async () => {
    const endpoint = await startFakeEndpoint(() => ({
      status: 200,
      body: JSON.stringify({ data: [] }),
    }));
    try {
      // 内核顶层默认端点（没有任何具名 Profile、也没有自带 modelName）：
      // 查询成功但零模型时，回包的 models 才会真正为空 —— 这正是 UI
      // 「端点没返回模型」提示要覆盖的第三种状态。
      fs.writeFileSync(
        path.join(home, "settings.json"),
        JSON.stringify({
          selectedAuthType: "openai-compatible",
          baseUrl: endpoint.baseUrl,
          apiKey: "sk-top",
        }),
        "utf8",
      );
      setSuperSettings("", "");
      p.store.sessionMeta({ currentModelId: null });

      await p.handleWebviewMessage({
        type: "refreshSuperProfileModels",
        requestId: 2,
      });
      await waitFor(() => lastModelsPayload() !== undefined);

      const payload = lastModelsPayload()!;
      expect(payload.error).toBeUndefined();
      // 成功但空：models 为空（UI 据此显示「端点没返回模型」提示）。
      expect(payload.models).toEqual([]);
      // 空 live 绝不构成下架证据（防误伤）。
      expect(payload.degraded).toBeUndefined();
      expect(payload.delistedModelId).toBeUndefined();
    } finally {
      await endpoint.close();
    }
  });

  it("㉚ 查询失败（端点不可达）同样不构成下架证据：不标记降级", async () => {
    const dead = await startFakeEndpoint(() => ({ status: 200, body: "{}" }));
    const deadBaseUrl = dead.baseUrl;
    await dead.close();
    writeKernelSettings(home, {
      "super-gw": { baseUrl: deadBaseUrl, apiKey: "sk-super-test", modelName: "profile-default" },
    });
    setSuperSettings("super-gw", "gone-model");
    p.store.sessionMeta({ currentModelId: null });

    await p.handleWebviewMessage({
      type: "refreshSuperProfileModels",
      profileName: "super-gw",
      requestId: 3,
    });
    await waitFor(() => lastModelsPayload() !== undefined);

    const payload = lastModelsPayload()!;
    expect(payload.error).toBeTruthy();
    expect(payload.degraded).toBeUndefined();
  });
});
