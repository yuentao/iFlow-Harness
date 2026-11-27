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
import { setConfigOverrides } from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeContext(storageDir: string): vscodeTypes.ExtensionContext {
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
  store: { sendToast: (...args: unknown[]) => number };
};

/** 写入内核 `settings.json`（`apiProfiles` 是面板 API 配置的唯一权威）。 */
function writeKernelSettings(home: string, profiles: Record<string, Credentials>): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "settings.json"),
    JSON.stringify(
      {
        selectedAuthType: "openai-compatible",
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
    panel = new ChatPanel(makeContext(storageDir), { workspaceRoot: here, watchers: makeWatchers() });
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
    expect(payload!.models.every((m) => m.id === "model-x")).toBe(true);
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
});
