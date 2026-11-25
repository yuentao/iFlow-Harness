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
import * as vscode from "vscode";
import { ChatPanel } from "../src/panel/panel.js";
import type { PanelServices } from "../src/panel/panel.js";
import { MCP_SERVER_ALLOWLIST_FLAG, MCP_SERVER_ALLOWLIST_SENTINEL } from "../src/acp/cli-locator.js";
import { loadPrompt } from "../prompts/index.js";
import { setConfigOverrides } from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const mockAgent = path.join(here, "mock-acp-agent.mjs");
const fakeMcpServer = path.join(here, "fixtures", "fake-mcp-server.mjs");

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
  // 宿主 shell 可能带着 IFLOW_TOKENS_LIMIT（本任务环境实测为 960000）：
  // AcpClient 以 `{ ...process.env, ...spawnEnv }` 起子进程，而五档权威链在
  // 「无依据」档刻意不往 spawnEnv 放这个键 —— 不清掉宿主的陈旧值，子进程
  // 就会继承它，让「无依据不推」的断言假失败。beforeEach 先存后删，
  // afterEach 原样恢复，保持测试 hermetic。
  let originalTokensLimitEnv: string | undefined;

  beforeEach(() => {
    // nodePath 指向当前进程可执行文件：concealNodeExecutable 会直接返回它，
    // 不再复制一份 node 到 storage，测试因此更快也更贴近 hermetic。
    setConfigOverrides({ nodePath: process.execPath });
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-spawnenv-storage-"));
    iflowHome = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-spawnenv-home-"));
    process.env.IFLOW_HOME = iflowHome;
    delete process.env.IFLOW_SUPER_TOOL;
    // 宿主 shell 可能带着真实的 IFLOW_SYSTEM_MD；不清掉会掩盖宿主自己设的值。
    delete process.env.IFLOW_SYSTEM_MD;
    // 宿主 shell 可能带着 IFLOW_TOKENS_LIMIT：子进程会继承它，掩盖「无依据
    // 不推」这档的真实行为。先存后删，测完在 afterEach 里恢复。
    originalTokensLimitEnv = process.env.IFLOW_TOKENS_LIMIT;
    delete process.env.IFLOW_TOKENS_LIMIT;
    // stub 默认没有 workspace.fs，materializeSystemPrompt 会写入失败而返回 null；
    // 这里只补最小读写，其它 fs 调用仍保持原来的报错行为。
    (vscode.workspace as unknown as { fs: unknown }).fs = {
      readFile: (uri: { fsPath: string }) => fs.promises.readFile(uri.fsPath),
      writeFile: (uri: { fsPath: string }, data: Uint8Array) => fs.promises.writeFile(uri.fsPath, data),
    };
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
    delete process.env.IFLOW_SYSTEM_MD;
    delete process.env.IFLOW_HOME;
    // 恢复宿主 shell 原有的 IFLOW_TOKENS_LIMIT（无则维持删除）。
    if (originalTokensLimitEnv === undefined) delete process.env.IFLOW_TOKENS_LIMIT;
    else process.env.IFLOW_TOKENS_LIMIT = originalTokensLimitEnv;
    delete (vscode.workspace as unknown as { fs?: unknown }).fs;
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
    // 主会话仍指向原 system-prompt.md，内容逐字节等于主模板（child 变体不得串味）。
    expect(path.resolve(env.IFLOW_SYSTEM_MD!)).toBe(path.resolve(storageDir, "system-prompt.md"));
    expect(fs.readFileSync(env.IFLOW_SYSTEM_MD!, "utf8")).toBe(loadPrompt("system-prompt"));
  }, 30000);

  /**
   * 冷启动：spawn env 是在 CLI 的 `session/new` 返回**之前**构造的，所以扩展
   * 刚激活时 store 的 `currentModelId` 还是 null。此时用户的
   * `iflow.contextWindowOverrides` 与宿主内建表都必须靠「内核 profile 的
   * modelName」兜底命中 —— 否则 CLI 会退回自己的 65k deepseek 默认值
   * （「每轮都触发上下文自动压缩」的根因）。
   */
  it("冷启动（currentModelId 尚为 null）时用内核 profile 的 modelName 兜底命中用户覆写", async () => {
    fs.writeFileSync(
      path.join(iflowHome, "settings.json"),
      JSON.stringify({
        currentApiProfile: "main",
        apiProfiles: { main: { modelName: "auto/deepseek-v4.1-flash" } },
      }),
      "utf8",
    );
    setConfigOverrides({
      nodePath: process.execPath,
      contextWindowOverrides: ["deepseek-v4.1-flash=960000"],
    });
    const dump = path.join(storageDir, "coldstart-override-env.json");
    process.env.ACP_MOCK_ENV_DUMP = dump;

    await (panel as unknown as SpawnEnvInternals).ensureClient();

    expect(readDumpedEnv(dump).IFLOW_TOKENS_LIMIT).toBe("960000");
  }, 30000);

  it("冷启动时内核 profile 的 modelName 命中内建对照表（1M）", async () => {
    fs.writeFileSync(
      path.join(iflowHome, "settings.json"),
      JSON.stringify({
        currentApiProfile: "main",
        apiProfiles: { main: { modelName: "auto/deepseek-v4.1-flash" } },
      }),
      "utf8",
    );
    setConfigOverrides({ nodePath: process.execPath, contextWindowOverrides: [] });
    const dump = path.join(storageDir, "coldstart-builtin-env.json");
    process.env.ACP_MOCK_ENV_DUMP = dump;

    await (panel as unknown as SpawnEnvInternals).ensureClient();

    expect(readDumpedEnv(dump).IFLOW_TOKENS_LIMIT).toBe("1000000");
  }, 30000);

  it("冷启动且毫无依据时不推 IFLOW_TOKENS_LIMIT（绝不推猜测的默认值）", async () => {
    // 内核 settings.json 不存在（iflowHome 是空的临时目录）→ 全链路无依据。
    setConfigOverrides({ nodePath: process.execPath, contextWindowOverrides: [] });
    const dump = path.join(storageDir, "coldstart-none-env.json");
    process.env.ACP_MOCK_ENV_DUMP = dump;

    await (panel as unknown as SpawnEnvInternals).ensureClient();

    expect(readDumpedEnv(dump).IFLOW_TOKENS_LIMIT).toBeUndefined();
  }, 30000);

  it("子会话与主会话共用同一兜底查表（冷启动时子会话也拿到兜底窗口）", async () => {
    fs.writeFileSync(
      path.join(iflowHome, "settings.json"),
      JSON.stringify({
        currentApiProfile: "main",
        apiProfiles: { main: { modelName: "auto/deepseek-v4.1-flash" } },
      }),
      "utf8",
    );
    setConfigOverrides({
      nodePath: process.execPath,
      contextWindowOverrides: ["deepseek-v4.1-flash=960000"],
    });
    const dump = path.join(storageDir, "child-coldstart-env.json");
    process.env.ACP_MOCK_ENV_DUMP = dump;

    const child = await (panel as unknown as SpawnEnvInternals).createSuperClient({
      cwd: here,
      allowedRoots: [here],
      includeDirectories: [],
      label: "spawn-env-child-coldstart",
      callbacks: {},
    });
    try {
      expect(readDumpedEnv(dump).IFLOW_TOKENS_LIMIT).toBe("960000");
    } finally {
      await child.dispose();
    }
  }, 30000);

  it("超流体的 spawn env 没有 IFLOW_SUPER_TOOL（即便宿主 process.env 里设了）", async () => {
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
      // 子会话必须拿裁剪版系统提示（去掉主会话编排段）。
      expect(path.resolve(env.IFLOW_SYSTEM_MD!)).toBe(path.resolve(storageDir, "system-prompt-child.md"));
      expect(fs.readFileSync(env.IFLOW_SYSTEM_MD!, "utf8")).toBe(loadPrompt("system-prompt-child"));
    } finally {
      await child.dispose();
    }
  }, 30000);

  /**
   * MCP 作用域按**进程**生效：主会话的 CLI 进程一个 MCP 服务器都不该有
   * （MCP 工具绕过 `settings.allowed_tools` 白名单，只能这样整体移除）。
   *
   * 子会话反过来必须能用 MCP，但**不能**每个子会话各起一套：宿主 broker
   * 先认领每个配置的 server（每 server 只 spawn 一份），子会话的 argv 只放
   * broker 的 server 名 —— 用户配置里的 stdio server 因此在子会话进程里不会
   * 被拉起，子会话经 loopback HTTP 连同一份 server。
   *
   * 断言的是宿主真的交给子进程的 argv（mock agent 自己 dump 的），不是某个
   * 内部对象。
   */
  function readDumpedArgv(file: string): string[] {
    return JSON.parse(fs.readFileSync(file, "utf8")) as string[];
  }

  function allowedMcpNames(argv: string[]): string[] {
    const names: string[] = [];
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === MCP_SERVER_ALLOWLIST_FLAG) names.push(argv[i + 1] ?? "");
    }
    return names;
  }

  function writeConfiguredServer(spawnLog: string): void {
    fs.writeFileSync(
      path.join(iflowHome, "settings.json"),
      JSON.stringify({
        mcpServers: {
          demo: {
            command: process.execPath,
            args: [fakeMcpServer, "--name", "demo"],
            env: { FAKE_MCP_SPAWN_LOG: spawnLog },
          },
        },
      }),
      "utf8",
    );
  }

  function spawnLines(file: string): string[] {
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
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

  it("超流体的 spawn argv 只放共享 broker 的 server 名（并发超流体仍只有一份 server 进程）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-spawnenv-mcp-"));
    const spawnLog = path.join(dir, "spawns.log");
    fs.writeFileSync(spawnLog, "");
    try {
      writeConfiguredServer(spawnLog);
      const dump = path.join(storageDir, "child-argv.json");
      process.env.ACP_MOCK_ARGV_DUMP = dump;

      const first = await (panel as unknown as SpawnEnvInternals).createSuperClient({
        cwd: here,
        allowedRoots: [here],
        includeDirectories: [],
        label: "spawn-argv-child-1",
        callbacks: {},
      });
      const second = await (panel as unknown as SpawnEnvInternals).createSuperClient({
        cwd: here,
        allowedRoots: [here],
        includeDirectories: [],
        label: "spawn-argv-child-2",
        callbacks: {},
      });
      try {
        const argv = readDumpedArgv(dump);
        expect(allowedMcpNames(argv)).toEqual(["demo"]);
        expect(argv).not.toContain(MCP_SERVER_ALLOWLIST_SENTINEL);
        // 内置工具能力不受影响：只改 MCP 作用域，参数仍是同一套 ACP 启动方式。
        expect(argv).toContain("--experimental-acp");
        expect(argv).toContain("--stream");

        // 两个子会话共享同一份 broker → 服务端只被拉起一次。
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && spawnLines(spawnLog).length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(spawnLines(spawnLog)).toHaveLength(1);

        // 同一个 broker 实例给两个子会话的是同一个地址（不是每次新起一套）。
        const internals = panel as unknown as {
          mcpBroker: { sessionServers: () => { url?: string }[] } | null;
        };
        expect(internals.mcpBroker?.sessionServers()).toHaveLength(1);
      } finally {
        await first.dispose();
        await second.dispose();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 40000);

  it("没有配置 MCP 时超流体仍退回哨兵（不伪造共享）", async () => {
    const dump = path.join(storageDir, "child-no-mcp-argv.json");
    process.env.ACP_MOCK_ARGV_DUMP = dump;

    const child = await (panel as unknown as SpawnEnvInternals).createSuperClient({
      cwd: here,
      allowedRoots: [here],
      includeDirectories: [],
      label: "spawn-argv-child-none",
      callbacks: {},
    });
    try {
      const argv = readDumpedArgv(dump);
      expect(allowedMcpNames(argv)).toEqual([MCP_SERVER_ALLOWLIST_SENTINEL]);
      expect(argv).toContain("--experimental-acp");
    } finally {
      await child.dispose();
    }
  }, 30000);

  it("子会话 MCP 白名单：缺省为 broker 全量，非空取交集且过滤未知名字", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iflow-spawnenv-allowlist-"));
    const spawnLog = path.join(dir, "spawns.log");
    fs.writeFileSync(spawnLog, "");
    try {
      fs.writeFileSync(
        path.join(iflowHome, "settings.json"),
        JSON.stringify({
          mcpServers: {
            alpha: {
              command: process.execPath,
              args: [fakeMcpServer, "--name", "alpha"],
              env: { FAKE_MCP_SPAWN_LOG: spawnLog },
            },
            beta: {
              command: process.execPath,
              args: [fakeMcpServer, "--name", "beta"],
              env: { FAKE_MCP_SPAWN_LOG: spawnLog },
            },
          },
        }),
        "utf8",
      );
      const spawnChild = async (label: string, dumpFile: string): Promise<SpawnClient> => {
        process.env.ACP_MOCK_ARGV_DUMP = path.join(storageDir, dumpFile);
        return (panel as unknown as SpawnEnvInternals).createSuperClient({
          cwd: here,
          allowedRoots: [here],
          includeDirectories: [],
          label,
          callbacks: {},
        });
      };

      // 缺省（空 allowlist）：必须等于接线前的原表达式 —— broker 全量 server 名。
      setConfigOverrides({
        nodePath: process.execPath,
        "superAgent.childMcpServerAllowlist": [],
      });
      const all = await spawnChild("spawn-argv-child-all", "child-allowlist-all-argv.json");
      try {
        const argv = readDumpedArgv(path.join(storageDir, "child-allowlist-all-argv.json"));
        expect([...allowedMcpNames(argv)].sort()).toEqual(["alpha", "beta"]);
        expect(argv).not.toContain(MCP_SERVER_ALLOWLIST_SENTINEL);
      } finally {
        await all.dispose();
      }

      // 非空 allowlist：只保留 broker 里真实存在的名字，未知名字被过滤。
      setConfigOverrides({
        nodePath: process.execPath,
        "superAgent.childMcpServerAllowlist": ["beta", "does-not-exist"],
      });
      const picked = await spawnChild("spawn-argv-child-picked", "child-allowlist-picked-argv.json");
      try {
        const argv = readDumpedArgv(path.join(storageDir, "child-allowlist-picked-argv.json"));
        expect(allowedMcpNames(argv)).toEqual(["beta"]);
        expect(allowedMcpNames(argv)).not.toContain("does-not-exist");
        expect(argv).not.toContain(MCP_SERVER_ALLOWLIST_SENTINEL);
      } finally {
        await picked.dispose();
      }
    } finally {
      setConfigOverrides({ nodePath: process.execPath });
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 60000);
});
