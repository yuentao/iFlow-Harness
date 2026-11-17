import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  ManagedOneBotManager,
  type ChildProcessLike,
  type ManagedOneBotDeps,
  type ManagedPhase,
} from "../src/qq/managed/manager.js";
import {
  getProvider as realGetProvider,
  type ManagedOneBotProvider,
} from "../src/qq/managed/provider.js";

const TOKEN = "super-secret-token-DO-NOT-LEAK-9f3a";

/** 登录探测的三种可控状态。 */
type LoginState = "logged_in" | "not_logged_in" | "down";

let server: http.Server;
let port = 0;
let loginState: LoginState = "down";
let authHeaders: string[] = [];
const dirs: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    authHeaders.push(String(req.headers["authorization"] ?? ""));
    if (loginState === "down") {
      // 模拟本机没有实例：直接断链，探测应判为 unreachable。
      req.socket.destroy();
      return;
    }
    if (loginState === "not_logged_in") {
      // HTTP 通但未登录（401）——「进程在但待登录」。
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "failed", retcode: 10002 }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", retcode: 0, data: { user_id: 123456789 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  loginState = "down";
  authHeaders = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "managed-manager-"));
  dirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// 注入替身
// ---------------------------------------------------------------------------

class FakeChild implements ChildProcessLike {
  readonly stderr = new PassThrough();
  readonly stdout: NodeJS.ReadableStream | null = null;
  readonly killed: string[] = [];
  private readonly handlers = new Map<string, Set<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void): this {
    this.add(event, listener);
    return this;
  }

  once(event: string, listener: (...args: any[]) => void): this {
    const wrapped = (...args: any[]): void => {
      this.remove(event, wrapped);
      listener(...args);
    };
    this.add(event, wrapped);
    return this;
  }

  kill(signal?: NodeJS.Signals | string): boolean {
    this.killed.push(String(signal ?? "SIGTERM"));
    // 同步触发 exit，验证 stop() 先注册监听再 kill 的顺序。
    this.emit("exit", 0, signal ?? "SIGTERM");
    return true;
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.handlers.get(event) ?? []) listener(...args);
  }

  private add(event: string, listener: (...args: any[]) => void): void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(listener);
    this.handlers.set(event, set);
  }

  private remove(event: string, listener: (...args: any[]) => void): void {
    this.handlers.get(event)?.delete(listener);
  }
}

function fakeProvider(overrides: Partial<ManagedOneBotProvider> = {}): ManagedOneBotProvider {
  return {
    id: "go-cqhttp",
    displayName: "fake-go-cqhttp",
    isSupported: () => true,
    binaryRelativePath: () => "go-cqhttp.exe",
    downloadUrl: () => "https://example.com/go-cqhttp_1.2.0_windows_amd64.zip",
    buildArgs: () => [],
    writeConfig: async (config) => ({
      configPath: join(config.installDir, "config.yml"),
      written: [join(config.installDir, "config.yml")],
    }),
    loginProbeUrl: (config) => `http://127.0.0.1:${config.port}/get_login_info`,
    ...overrides,
  };
}

interface HarnessOptions {
  installDir: string;
  provider?: ManagedOneBotProvider;
  download?: ManagedOneBotDeps["download"];
  extract?: ManagedOneBotDeps["extract"];
  spawn?: ManagedOneBotDeps["spawn"];
  sleep?: ManagedOneBotDeps["sleep"];
  now?: ManagedOneBotDeps["now"];
  log?: (line: string) => void;
  onSpawn?: (child: FakeChild) => void;
}

function makeDeps(opts: HarnessOptions): ManagedOneBotDeps & { child: FakeChild } {
  const child = new FakeChild();
  const downloadSpy = vi.fn(async () => ({ bytes: 123 }));
  const extractSpy = vi.fn(async () => ["go-cqhttp.exe"]);
  const spawnSpy = vi.fn((_cmd: string, _args: string[], _opts: unknown) => {
    opts.onSpawn?.(child);
    return child;
  });
  return {
    installDir: opts.installDir,
    platform: "win32",
    arch: "x64",
    accessToken: TOKEN,
    reversePostUrl: "http://127.0.0.1:3000/onebot/event",
    port,
    getProvider: () => opts.provider ?? fakeProvider(),
    download: opts.download ?? downloadSpy,
    extract: opts.extract ?? extractSpy,
    spawn: opts.spawn ?? spawnSpy,
    sleep: opts.sleep ?? (async () => undefined),
    now: opts.now ?? (() => 0),
    ...(opts.log ? { log: opts.log } : {}),
    // 测试辅助字段（管理器不读）。
    child,
  } as ManagedOneBotDeps & { child: FakeChild };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe("ManagedOneBotManager", () => {
  it("本机已有已登录实例：直接返回 alreadyRunning=true，不下载/不启动", async () => {
    loginState = "logged_in";
    const deps = makeDeps({ installDir: tempDir() });
    const mgr = new ManagedOneBotManager(deps);
    const phases: ManagedPhase[] = [];
    mgr.onStatus((s) => phases.push(s.phase));

    const result = await mgr.start();

    expect(result).toEqual({
      endpoint: `http://127.0.0.1:${port}`,
      accessToken: TOKEN,
      alreadyRunning: true,
    });
    expect(deps.download).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(phases).toEqual(["checking", "logged_in"]);
    // 探测请求确实带了 Bearer token。
    expect(authHeaders.some((h) => h === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("不支持的平台：error 阶段并抛可读错误（不含 token）", async () => {
    loginState = "down";
    const deps = makeDeps({
      installDir: tempDir(),
      provider: fakeProvider({ isSupported: () => false, displayName: "go-cqhttp" }),
    });
    const mgr = new ManagedOneBotManager(deps);

    let caught: Error | undefined;
    try {
      await mgr.start();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/不支持/);
    expect(caught!.message).toMatch(/win32\/x64/);
    expect(caught!.message).not.toContain(TOKEN);
    expect(mgr.status().phase).toBe("error");
    expect(JSON.stringify(mgr.status())).not.toContain(TOKEN);
  });

  it("完整首次流程：阶段序列 checking→downloading→configuring→starting→waiting_login→logged_in", async () => {
    loginState = "down";
    const deps = makeDeps({
      installDir: tempDir(),
      onSpawn: () => {
        // 进程启动后 OneBot 变为已登录，轮询第一次即成功。
        loginState = "logged_in";
      },
    });
    const mgr = new ManagedOneBotManager(deps);
    const phases: ManagedPhase[] = [];
    mgr.onStatus((s) => phases.push(s.phase));

    const result = await mgr.start();

    expect(phases).toEqual([
      "checking",
      "downloading",
      "configuring",
      "starting",
      "waiting_login",
      "logged_in",
    ]);
    expect(deps.download).toHaveBeenCalledTimes(1);
    expect(deps.extract).toHaveBeenCalledTimes(1);
    expect(deps.spawn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      endpoint: `http://127.0.0.1:${port}`,
      accessToken: TOKEN,
      alreadyRunning: false,
    });
    expect(mgr.status().phase).toBe("logged_in");
  });

  it("二进制已存在且非空：跳过下载", async () => {
    loginState = "down";
    const installDir = tempDir();
    writeFileSync(join(installDir, "go-cqhttp.exe"), "pre-existing binary");
    const deps = makeDeps({
      installDir,
      onSpawn: () => {
        loginState = "logged_in";
      },
    });
    const mgr = new ManagedOneBotManager(deps);

    await mgr.start();

    expect(deps.download).not.toHaveBeenCalled();
    expect(deps.extract).not.toHaveBeenCalled();
    expect(deps.spawn).toHaveBeenCalledTimes(1);
  });

  it("config.yml 已存在：使用真实 provider 时不覆盖用户配置", async () => {
    loginState = "down";
    const installDir = tempDir();
    const configPath = join(installDir, "config.yml");
    writeFileSync(configPath, "# CUSTOM CONFIG — DO NOT TOUCH\n", "utf8");
    const deps = makeDeps({
      installDir,
      provider: realGetProvider("go-cqhttp"),
      onSpawn: () => {
        loginState = "logged_in";
      },
    });
    const mgr = new ManagedOneBotManager(deps);

    await mgr.start();

    expect(readFileSync(configPath, "utf8")).toBe("# CUSTOM CONFIG — DO NOT TOUCH\n");
  });

  it("登录轮询超时：error 阶段、错误文案含「5 分钟」与脱敏后的 stderr 摘要", async () => {
    loginState = "down";
    let clock = 0;
    const deps = makeDeps({
      installDir: tempDir(),
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
      onSpawn: (child) => {
        // 进程在但一直未登录；同时把含 token 的 stderr 写进环形缓冲。
        loginState = "not_logged_in";
        child.stderr.write(`auth failed with token=${TOKEN}\n`);
      },
    });
    const mgr = new ManagedOneBotManager(deps);

    let caught: Error | undefined;
    try {
      await mgr.start();
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/等待扫码登录超时（5 分钟）/);
    expect(caught!.message).toMatch(/最后 stderr/);
    expect(caught!.message).toContain("[REDACTED]");
    expect(caught!.message).not.toContain(TOKEN);
    expect(mgr.status().phase).toBe("error");
    expect(mgr.status().message).not.toContain(TOKEN);
    // stderr 环形缓冲也已脱敏。
    expect(mgr.lastStderr()).not.toContain(TOKEN);
    expect(mgr.lastStderr()).toContain("[REDACTED]");
  });

  it("重复 start 幂等：进行中共享同一 Promise，logged_in 后返回缓存结果", async () => {
    loginState = "logged_in";
    const deps = makeDeps({ installDir: tempDir() });
    const mgr = new ManagedOneBotManager(deps);

    const first = mgr.start();
    const second = mgr.start();
    expect(second).toBe(first);
    const result1 = await first;
    const result2 = await mgr.start();

    expect(result2).toEqual(result1);
    expect(deps.download).not.toHaveBeenCalled();
  });

  it("stop 终止轮询并 SIGTERM 子进程，且不再继续轮询", async () => {
    loginState = "down";
    let sleepCount = 0;
    const deps = makeDeps({
      installDir: tempDir(),
      // clock 恒为 0：不会走到 5 分钟超时，只靠 stop 标志退出。
      now: () => 0,
      sleep: async () => {
        sleepCount += 1;
        await new Promise<void>((r) => setTimeout(r, 5));
      },
      onSpawn: () => {
        loginState = "not_logged_in";
      },
    });
    const mgr = new ManagedOneBotManager(deps);

    const running = mgr.start();
    await new Promise<void>((r) => setTimeout(r, 120));
    expect(sleepCount).toBeGreaterThan(0);
    await mgr.stop();

    await expect(running).rejects.toThrow(/停止/);
    expect(deps.child.killed).toContain("SIGTERM");
    const atStop = sleepCount;
    await new Promise<void>((r) => setTimeout(r, 60));
    expect(sleepCount).toBe(atStop);
    // 未 spawn 新进程、未清配置。
    expect(mgr.qrCodePath()).toBe(join(deps.installDir, "qrcode.png"));
  });

  it("stderr 环形缓冲上限 200 行，且所有行都脱敏", async () => {
    loginState = "down";
    const deps = makeDeps({
      installDir: tempDir(),
      now: () => 0,
      sleep: async () => {
        await new Promise<void>((r) => setTimeout(r, 5));
      },
      onSpawn: (child) => {
        loginState = "not_logged_in";
        for (let i = 0; i < 250; i += 1) {
          child.stderr.write(`line-${i} token=${TOKEN}\n`);
        }
      },
    });
    const mgr = new ManagedOneBotManager(deps);
    const running = mgr.start();
    await new Promise<void>((r) => setTimeout(r, 80));
    await mgr.stop();
    await running.catch(() => undefined);

    const lines = mgr.lastStderr().split("\n");
    expect(lines.length).toBe(200);
    expect(lines[0]).toContain("line-50");
    expect(lines[199]).toContain("line-249");
    expect(mgr.lastStderr()).not.toContain(TOKEN);
    expect(mgr.lastStderr()).toContain("[REDACTED]");
  });

  it("log 回调里的 token 同样被脱敏", async () => {
    loginState = "logged_in";
    const logLines: string[] = [];
    const deps = makeDeps({
      installDir: tempDir(),
      log: (line) => logLines.push(line),
    });
    const mgr = new ManagedOneBotManager(deps);
    await mgr.start();
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join("\n")).not.toContain(TOKEN);
  });

  it("qrCodePath 指向 installDir/qrcode.png 的绝对路径", () => {
    const installDir = tempDir();
    const mgr = new ManagedOneBotManager(makeDeps({ installDir }));
    expect(mgr.qrCodePath()).toBe(join(installDir, "qrcode.png"));
  });

  it("初始状态为 idle，onStatus 返回可取消订阅函数", async () => {
    const mgr = new ManagedOneBotManager(makeDeps({ installDir: tempDir() }));
    expect(mgr.status().phase).toBe("idle");
    const seen: ManagedPhase[] = [];
    const off = mgr.onStatus((s) => seen.push(s.phase));
    loginState = "logged_in";
    await mgr.start();
    expect(seen.length).toBeGreaterThan(0);
    expect(() => off()).not.toThrow();
    // 退订是幂等的。
    expect(() => off()).not.toThrow();
  });
});