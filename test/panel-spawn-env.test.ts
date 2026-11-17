/**
 * 主会话 / 子会话的 CLI spawn env 门控。
 *
 * `IFLOW_SUPER_TOOL=1` 是 vendored CLI 内置 `super-agent` 工具的注册开关
 * （工具实现以 `process.env.IFLOW_SUPER_TOOL === "1"` 为门控）。只有主会话
 * 该拿到派发能力：子会话若继承这个键，就等于允许子会话再派子会话。
 *
 * 这里不 mock spawn，而是让真实的 `test/mock-acp-agent.mjs` 在启动时把
 * 自己的 `process.env` 写成 JSON（`ACP_MOCK_ENV_DUMP`），因此断言的是宿主
 * 实际交给子进程的环境，而不是某个内部对象的形状。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscodeTypes from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { MCP_SERVER_ALLOWLIST_FLAG, MCP_SERVER_ALLOWLIST_SENTINEL } from "../src/acp/cli-locator.js";
import { setConfigOverrides } from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const mockAgent = path.join(here, "mock-acp-agent.mjs");

function makeContext(storageDir: string): vscodeTypes.ExtensionContext {
  const store = new Map<string, unknown>();
  const state = {
    get: <T>(key: string, defaultValue?: T): T =>
      store.has(key) ? (store.get(key) as T) : defaultValue,
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

type SpawnClient = { dispose: () => Promise<void> };

type SpawnEnvInternals = {
  ensureClient: () => Promise<SpawnClient>;
  createSuperClient: (params: {
    cwd: string;
    allowedRoots: string[];
    includeDirectories: string[];
    label: string;
    callbacks: Record<string, never>;
  }) => Promise<SpawnClient>;
};

describe("CLI spawn env · IFLOW_SUPER_TOOL 只给主会话", () => {
  let panel: ChatPanel;
  let storageDir: string;
  let iflowHome: string;

  beforeEach(() => {
    // nodePath 指向当前进程可执行文件：concealNodeExecutable 会直接返回它，
    // 不再复制一份 node 到 storage，测试因此更快也更贴近 hermetic。
    setConfigOverrides({ nodePath: process.execPath });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-spawnenv-storage-"));
    iflowHome = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-spawnenv-home-"));
    process.env.IFLOW_HOME = iflowHome;
    delete process.env.IFLOW_SUPER_TOOL;
    panel = new ChatPanel(makeContext(storageDir), {
      entryOverride: mockAgent,
      workspaceRoot: here,
      watchers: makeWatchers(),
    });
  });

  afterEach(async () => {
    await panel.dispose();
    delete process.env.ACP_MOCK_ENV_DUMP;
    delete process.env.ACP_MOCK_ARGV_DUMP;
    delete process.env.IFLOW_SUPER_TOOL;
    delete process.env.IFLOW_HOME;
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(iflowHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function readDumpedEnv(file: string): NodeJS.ProcessEnv {
    return JSON.parse(fs.readFileSync(file, "utf8")) as NodeJS.ProcessEnv;
  }

  it("主会话的 spawn env 带 IFLOW_SUPER_TOOL=1", async () => {
    const dump = path.join(storageDir, "main-env.json");
    process.env.ACP_MOCK_ENV_DUMP = dump;

    await (panel as unknown as SpawnEnvInternals).ensureClient();

    const env = readDumpedEnv(dump);
    expect(env.IFLOW_SUPER_TOOL).toBe("1");
    // 既有契约没被破坏：harness 标记仍在。
    expect(env.IFLOW_HARNESS).toBe("1");
  }, 30000);

  it("子会话的 spawn env 没有 IFLOW_SUPER_TOOL（即便宿主 process.env 里设了）", async () => {
    // 模拟一个「用户 shell 里已经设了该变量」的环境：子会话必须显式抹掉，
    // 不能靠「父进程没设」这个偶然条件。
    process.env.IFLOW_SUPER_TOOL = "1";
    const dump = path.join(storageDir, "child-env.json");
    process.env.ACP_MOCK_ENV_DUMP = dump;

    const child = await (panel as unknown as SpawnEnvInternals).createSuperClient({
      cwd: here,
      allowedRoots: [here],
      includeDirectories: [],
      label: "spawn-env-child",
      callbacks: {},
    });
    try {
      const env = readDumpedEnv(dump);
      expect(env.IFLOW_SUPER_TOOL).toBeUndefined();
      // 子会话仍是 harness 子进程，只是没有派发工具。
      expect(env.IFLOW_HARNESS).toBe("1");
    } finally {
      await child.dispose();
    }
  }, 30000);

  /**
   * MCP 作用域按**进程**生效：主会话的 CLI 进程一个 MCP 服务器都不该有
   * （MCP 工具绕过 `settings.allowed_tools` 白名单，只能这样整体移除），
   * 子会话必须保留（实现工作要用 MCP 的浏览器/数据库工具）。
   *
   * 断言的是宿主真的交给子进程的 argv（mock agent 自己 dump 的），不是某个
   * 内部对象。哨兵名与真实服务器名永不相交，所以「新装一个 MCP 服务器」不
   * 需要改任何代码。
   */
  function readDumpedArgv(file: string): string[] {
    return JSON.parse(fs.readFileSync(file, "utf8")) as string[];
  }

  it("主会话的 spawn argv 带 MCP 作用域参数（哨兵不可命中任何服务器）", async () => {
    const dump = path.join(storageDir, "main-argv.json");
    process.env.ACP_MOCK_ARGV_DUMP = dump;

    await (panel as unknown as SpawnEnvInternals).ensureClient();

    const argv = readDumpedArgv(dump);
    const i = argv.indexOf(MCP_SERVER_ALLOWLIST_FLAG);
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe(MCP_SERVER_ALLOWLIST_SENTINEL);
    // 既有参数没被破坏。
    expect(argv).toContain("--experimental-acp");
    expect(argv).toContain("--stream");
  }, 30000);

  it("子会话的 spawn argv 不带 MCP 作用域参数（子会话保留全部 MCP 工具）", async () => {
    const dump = path.join(storageDir, "child-argv.json");
    process.env.ACP_MOCK_ARGV_DUMP = dump;

    const child = await (panel as unknown as SpawnEnvInternals).createSuperClient({
      cwd: here,
      allowedRoots: [here],
      includeDirectories: [],
      label: "spawn-argv-child",
      callbacks: {},
    });
    try {
      const argv = readDumpedArgv(dump);
      expect(argv).not.toContain(MCP_SERVER_ALLOWLIST_FLAG);
      expect(JSON.stringify(argv)).not.toContain(MCP_SERVER_ALLOWLIST_SENTINEL);
      expect(argv).toContain("--experimental-acp");
    } finally {
      await child.dispose();
    }
  }, 30000);
});
