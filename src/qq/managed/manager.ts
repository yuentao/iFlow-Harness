/**
 * 应用内一键托管 OneBot 的核心管理器（Wave5-B）。
 *
 * 职责：把 Wave5-A 的底层件（provider / downloader）串成一条完整链路——
 * 探测本机实例 → 平台门控 → 下载解压 → 写配置 → spawn 子进程 → 轮询扫码登录。
 *
 * 分层纪律：纯 node 内置模块（http/https/fs/path/child_process），不 import
 * vscode、不碰 panel / webview 协议，全部 IO 可注入，可直接单测。
 *
 * 安全纪律（贯穿全文件）：
 *  - accessToken 唯一合法去处是 provider 生成的 config.yml、探测请求头、以及
 *    `start()` 的返回值（给宿主写 SecretStorage）。status / message / error /
 *    log / stderr 环形缓冲里一律不出现明文——写入前统一过 `redact()`。
 *  - 探测 / 轮询走 node:http(s) 直连，**不用全局 fetch**（VSCode 宿主用代理
 *    agent patch 了 fetch，SOCKS / 无 scheme 代理会抛 Invalid URL protocol，
 *    项目陷阱 #2；http-transport.ts / downloader.ts 同纪律）。
 *  - 已存在的 config.yml 一律不覆盖（由 provider.writeConfig 保证）。
 */

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { stat } from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import { join, resolve } from "node:path";
import { downloadManagedBinary, extractArchive } from "./downloader.js";
import { getProvider, type ManagedOneBotConfig } from "./provider.js";

// ---------------------------------------------------------------------------
// 可注入契约
// ---------------------------------------------------------------------------

/** 管理器持有的子进程最小形状；真实 `ChildProcess`  structurally 满足它。 */
export interface ChildProcessLike {
  readonly stderr: NodeJS.ReadableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | string): boolean;
  on(event: string, listener: (...args: any[]) => void): ChildProcessLike;
  once(event: string, listener: (...args: any[]) => void): ChildProcessLike;
}

/** spawn 选项：只声明管理器实际用到的字段，避免绑死 node 的重载签名。 */
export interface ManagedSpawnOptions {
  cwd: string;
  windowsHide: boolean;
  stdio: ["ignore", "ignore", "pipe"];
}

/** 可注入的 spawn 签名。 */
export type ManagedSpawn = (
  cmd: string,
  args: string[],
  opts: ManagedSpawnOptions,
) => ChildProcessLike;

/** 构造一个托管实例所需的全部输入；所有 IO 端点都可注入以便单测。 */
export interface ManagedOneBotDeps {
  /** 安装目录（宿主传入：globalStorageUri/qq/managed）。 */
  installDir: string;
  platform: NodeJS.Platform;
  arch: string;
  /** 默认 `go-cqhttp`。 */
  providerId?: "go-cqhttp";
  /** 宿主生成并传入；只进 config.yml / 探测请求头 / start 返回值。 */
  accessToken: string;
  /** 事件反向上报地址，例如 `<bridge sink>/onebot/event`。 */
  reversePostUrl: string;
  /** OneBot HTTP API 端口。 */
  port: number;

  getProvider?: typeof getProvider;
  download?: typeof downloadManagedBinary;
  extract?: typeof extractArchive;
  spawn?: ManagedSpawn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// 对外状态 / 结果
// ---------------------------------------------------------------------------

export type ManagedPhase =
  | "idle"
  | "checking"
  | "downloading"
  | "configuring"
  | "starting"
  | "waiting_login"
  | "logged_in"
  | "error";

/** 阶段快照；**不含 token**。 */
export interface ManagedOneBotStatus {
  phase: ManagedPhase;
  message: string;
  progress?: number;
  detail?: string;
}

/** start 成功结果；accessToken 是给宿主写 SecretStorage 的必要字段。 */
export interface ManagedStartResult {
  endpoint: string;
  accessToken: string;
  alreadyRunning: boolean;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 首次探测本机实例的超时（2s，未启动时应快速失败进入下载流程）。 */
const INITIAL_PROBE_TIMEOUT_MS = 2_000;
/** 登录轮询间隔。 */
const LOGIN_POLL_INTERVAL_MS = 1_500;
/** 扫码登录总时限（5 分钟）。错误文案里也写死「5 分钟」。 */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** stderr 内存环形缓冲上限（行）。 */
const STDERR_RING_MAX = 200;
/** stop() 时 SIGTERM → SIGKILL 的宽限期。 */
const KILL_GRACE_MS = 2_000;
/** 登录探测响应体上限（OneBot 回应很小，超限视为异常）。 */
const PROBE_MAX_BYTES = 2_000_000;

// ---------------------------------------------------------------------------
// 登录探测：node:http(s) 直连，返回三态（不用全局 fetch，见文件头纪律）
// ---------------------------------------------------------------------------

export type LoginProbe =
  /** HTTP 通、响应是 {status:"ok",data:{user_id}}。 */
  | { kind: "logged_in"; userId: string | number }
  /** HTTP 通但未登录（401 / status!=ok / 无 user_id）——「进程在但待登录」。 */
  | { kind: "not_logged_in" }
  /** 连接被拒 / 超时 / 非法地址——本机没有可连接的实例。 */
  | { kind: "unreachable"; reason: string };

function probeLogin(url: string, accessToken: string, timeoutMs: number): Promise<LoginProbe> {
  return new Promise<LoginProbe>((resolve) => {
    let settled = false;
    const finish = (value: LoginProbe): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let target: URL;
    try {
      target = new URL(url);
    } catch {
      finish({ kind: "unreachable", reason: "invalid_url" });
      return;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      finish({ kind: "unreachable", reason: `unsupported_protocol:${target.protocol}` });
      return;
    }

    const transport = target.protocol === "https:" ? https : http;
    const req = transport.request(
      target,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        let overflowed = false;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > PROBE_MAX_BYTES) {
            overflowed = true;
            req.destroy();
            finish({ kind: "not_logged_in" });
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled || overflowed) return;
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            // HTTP 通（401/403 等）说明进程在，只是还没登录 / token 不匹配。
            finish({ kind: "not_logged_in" });
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            finish({ kind: "not_logged_in" });
            return;
          }
          const userId = loggedInUserId(parsed);
          if (userId !== undefined) finish({ kind: "logged_in", userId });
          else finish({ kind: "not_logged_in" });
        });
        res.on("error", () => finish({ kind: "not_logged_in" }));
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish({ kind: "unreachable", reason: "timeout" });
    });
    req.on("error", () => finish({ kind: "unreachable", reason: "network" }));
    req.end();
  });
}

/** 严格判定 OneBot get_login_info 成功响应：`{status:"ok",data:{user_id}}`。 */
function loggedInUserId(parsed: unknown): string | number | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (obj["status"] !== "ok") return undefined;
  const data = obj["data"];
  if (typeof data !== "object" || data === null) return undefined;
  const id = (data as Record<string, unknown>)["user_id"];
  if (typeof id === "string" || (typeof id === "number" && Number.isFinite(id))) return id;
  return undefined;
}

/** 从下载地址推一个归档文件名（扩展名只影响可读性，不影响解压）。 */
function archiveNameFor(url: string): string {
  return url.toLowerCase().endsWith(".zip")
    ? "go-cqhttp-download.zip"
    : "go-cqhttp-download.tar.gz";
}

// ---------------------------------------------------------------------------
// 管理器
// ---------------------------------------------------------------------------

export class ManagedOneBotManager {
  private readonly deps: Required<
    Pick<
      ManagedOneBotDeps,
      | "installDir"
      | "platform"
      | "arch"
      | "providerId"
      | "accessToken"
      | "reversePostUrl"
      | "port"
      | "getProvider"
      | "download"
      | "extract"
      | "spawn"
      | "sleep"
      | "now"
    >
  > & { log?: (line: string) => void };

  private readonly endpoint: string;
  private readonly listeners = new Set<(status: ManagedOneBotStatus) => void>();
  private readonly stderrRing: string[] = [];

  private currentStatus: ManagedOneBotStatus = { phase: "idle", message: "尚未启动" };
  private cachedResult?: ManagedStartResult;
  private inFlight?: Promise<ManagedStartResult>;
  private child?: ChildProcessLike;
  private stopped = false;
  private killTimer?: ReturnType<typeof setTimeout>;

  constructor(deps: ManagedOneBotDeps) {
    this.deps = {
      installDir: deps.installDir,
      platform: deps.platform,
      arch: deps.arch,
      providerId: deps.providerId ?? "go-cqhttp",
      accessToken: deps.accessToken,
      reversePostUrl: deps.reversePostUrl,
      port: deps.port,
      getProvider: deps.getProvider ?? getProvider,
      download: deps.download ?? downloadManagedBinary,
      extract: deps.extract ?? extractArchive,
      spawn: deps.spawn ?? defaultSpawn,
      sleep: deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
      now: deps.now ?? (() => Date.now()),
      ...(deps.log ? { log: deps.log } : {}),
    };
    this.endpoint = `http://127.0.0.1:${deps.port}`;
  }

  /** 当前阶段快照（同一个对象引用直到下次变更；不含 token）。 */
  status(): ManagedOneBotStatus {
    return this.currentStatus;
  }

  /** 订阅阶段变化，返回取消订阅函数。监听器抛错被吞掉，不影响主流程。 */
  onStatus(cb: (status: ManagedOneBotStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * 启动完整托管流程。
   *
   * 幂等：logged_in 状态直接返回缓存结果；进行中的调用共享同一个 Promise。
   */
  start(): Promise<ManagedStartResult> {
    if (this.currentStatus.phase === "logged_in" && this.cachedResult) {
      return Promise.resolve(this.cachedResult);
    }
    if (this.inFlight) return this.inFlight;

    const promise = this.doStart();
    this.inFlight = promise;
    // 用 then(ok, err) 清理，避免 .finally 生成新 Promise 或制造未处理 rejection。
    void promise.then(
      () => {
        if (this.inFlight === promise) this.inFlight = undefined;
      },
      () => {
        if (this.inFlight === promise) this.inFlight = undefined;
      },
    );
    return promise;
  }

  /** 停止轮询与子进程（SIGTERM → 超时 SIGKILL），不清配置文件。 */
  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    this.child = undefined;
    if (!child) return;

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        if (this.killTimer !== undefined) clearTimeout(this.killTimer);
        this.killTimer = undefined;
        resolve();
      };
      // 先注册再 kill：真实进程与注入的假进程都可能在 kill 内同步触发 exit。
      child.once("exit", finish);
      child.once("error", finish);
      child.kill("SIGTERM");
      if (!done) {
        this.killTimer = setTimeout(() => {
          child.kill("SIGKILL");
          finish();
        }, KILL_GRACE_MS);
        this.killTimer.unref?.();
      }
    });
  }

  /** 二维码图片绝对路径（供桥接模块读取；本波不读文件）。 */
  qrCodePath(): string {
    return resolve(this.deps.installDir, "qrcode.png");
  }

  /** 最近若干行 stderr（已脱敏），用于失败诊断。 */
  lastStderr(): string {
    return this.stderrRing.join("\n");
  }

  // -------------------------------------------------------------------------
  // 内部：阶段 / 脱敏
  // -------------------------------------------------------------------------

  private setPhase(phase: ManagedPhase, message: string, extra?: { progress?: number; detail?: string }): void {
    this.currentStatus = {
      phase,
      message: this.redact(message),
      ...(extra?.progress !== undefined ? { progress: extra.progress } : {}),
      ...(extra?.detail !== undefined ? { detail: this.redact(extra.detail) } : {}),
    };
    for (const cb of this.listeners) {
      try {
        cb(this.currentStatus);
      } catch {
        // 单个监听器异常不影响主流程 / 其它监听器。
      }
    }
  }

  /** 把 accessToken 的所有出现替换为 [REDACTED]。 */
  private redact(text: string): string {
    const token = this.deps.accessToken;
    if (!token) return text;
    return text.split(token).join("[REDACTED]");
  }

  private log(line: string): void {
    this.deps.log?.(this.redact(line));
  }

  private pushStderr(chunk: string): void {
    for (const line of this.redact(chunk).split(/\r?\n/)) {
      if (line.length === 0) continue;
      this.stderrRing.push(line);
      if (this.stderrRing.length > STDERR_RING_MAX) this.stderrRing.shift();
    }
  }

  private lastStderrLine(): string {
    return this.stderrRing[this.stderrRing.length - 1] ?? "";
  }

  // -------------------------------------------------------------------------
  // 内部：主流程
  // -------------------------------------------------------------------------

  private async doStart(): Promise<ManagedStartResult> {
    this.stopped = false;
    this.setPhase("checking", "正在检查 OneBot 环境…", { progress: 10 });

    try {
      const provider = this.deps.getProvider(this.deps.providerId);
      const config: ManagedOneBotConfig = {
        installDir: this.deps.installDir,
        platform: this.deps.platform,
        arch: this.deps.arch,
        port: this.deps.port,
        accessToken: this.deps.accessToken,
        reversePostUrl: this.deps.reversePostUrl,
      };

      // 1) 先探测本机是否已有可连接的实例（已登录直接复用，不重复下载/启动）。
      const probe = await probeLogin(this.endpoint + "/get_login_info", this.deps.accessToken, INITIAL_PROBE_TIMEOUT_MS);
      if (probe.kind === "logged_in") {
        this.log("检测到已登录的 OneBot 实例，直接复用");
        this.setPhase("logged_in", "OneBot 已登录（复用现有实例）", { progress: 100 });
        const result: ManagedStartResult = {
          endpoint: this.endpoint,
          accessToken: this.deps.accessToken,
          alreadyRunning: true,
        };
        this.cachedResult = result;
        return result;
      }

      // 2) 平台门控：不支持的组合绝不假装可用。
      if (!provider.isSupported(config.platform, config.arch)) {
        throw new Error(
          `当前平台不支持 ${provider.displayName} 一键托管：${config.platform}/${config.arch}`,
        );
      }

      if (probe.kind === "not_logged_in") {
        // HTTP 通但未登录：进程在，只差扫码——跳过下载/配置/启动，直接进轮询。
        this.log("检测到 OneBot 进程在运行但尚未登录，直接进入扫码登录轮询");
      } else {
        // 3) 下载 + 解压（二进制已存在且 size>0 则跳过，不校验 hash）。
        await this.ensureBinary(provider, config);

        // 4) 写配置（provider 保证已存在的 config.yml 不被覆盖）。
        this.setPhase("configuring", "正在写入 OneBot 配置…", { progress: 70 });
        const writeResult = await provider.writeConfig(config);
        this.log(
          writeResult.written.length > 0
            ? `已写入配置：${writeResult.configPath}`
            : "config.yml 已存在，保留原有配置",
        );

        // 5) spawn 子进程（stderr 收集到环形缓冲，不写 stdout）。
        this.setPhase("starting", "正在启动 OneBot 进程…", { progress: 85 });
        this.spawnChild(provider, config);
      }

      // 6) 轮询扫码登录（最长 5 分钟，间隔 1.5s，sleep 可注入）。
      return await this.waitForLogin();
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const message = this.redact(raw);
      const alreadyError = this.currentStatus.phase === "error";
      if (!alreadyError) this.setPhase("error", message);
      throw new Error(message);
    }
  }

  /** 确保二进制落地：已存在且非空则跳过，否则下载 + 解压。 */
  private async ensureBinary(
    provider: ReturnType<typeof getProvider>,
    config: ManagedOneBotConfig,
  ): Promise<void> {
    const binaryPath = join(this.deps.installDir, provider.binaryRelativePath(config));
    if (await isNonEmptyFile(binaryPath)) {
      this.log("二进制已存在且非空，跳过下载");
      return;
    }

    this.setPhase("downloading", "正在下载 OneBot 运行时…", { progress: 30 });
    const url = provider.downloadUrl(config);
    const archivePath = join(this.deps.installDir, archiveNameFor(url));
    await this.deps.download({ url, destPath: archivePath });
    await this.deps.extract({ archivePath, destDir: this.deps.installDir });
  }

  /** 启动子进程并把 stderr 收集进脱敏环形缓冲。 */
  private spawnChild(provider: ReturnType<typeof getProvider>, config: ManagedOneBotConfig): void {
    const binaryPath = join(this.deps.installDir, provider.binaryRelativePath(config));
    const child = this.deps.spawn(binaryPath, provider.buildArgs(config), {
      cwd: this.deps.installDir,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.child = child;
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer | string) => this.pushStderr(String(chunk)));
    }
    child.on("error", (err) => this.pushStderr(`进程错误：${err instanceof Error ? err.message : String(err)}`));
  }

  /** 轮询 get_login_info 直到登录成功 / 超时 / 被 stop。 */
  private async waitForLogin(): Promise<ManagedStartResult> {
    this.setPhase("waiting_login", "请扫描二维码登录 OneBot…", { progress: 95 });
    const deadline = this.deps.now() + LOGIN_TIMEOUT_MS;

    while (!this.stopped && this.deps.now() < deadline) {
      // 每次轮询都是一次新请求；连接失败视作「暂时不可达」，继续等。
      const probe = await probeLogin(
        this.endpoint + "/get_login_info",
        this.deps.accessToken,
        INITIAL_PROBE_TIMEOUT_MS,
      );
      if (probe.kind === "logged_in") {
        this.log(`OneBot 登录成功（user_id=${String(probe.userId)}）`);
        this.setPhase("logged_in", "OneBot 已登录", { progress: 100 });
        const result: ManagedStartResult = {
          endpoint: this.endpoint,
          accessToken: this.deps.accessToken,
          alreadyRunning: false,
        };
        this.cachedResult = result;
        return result;
      }
      await this.deps.sleep(LOGIN_POLL_INTERVAL_MS);
    }

    if (this.stopped) {
      throw new Error("OneBot 托管已停止");
    }
    const tail = this.lastStderrLine();
    const message = tail
      ? `等待扫码登录超时（5 分钟）；最后 stderr：${tail}`
      : "等待扫码登录超时（5 分钟）";
    this.setPhase("error", message);
    throw new Error(this.redact(message));
  }
}

// ---------------------------------------------------------------------------
// 默认 spawn / 文件探测
// ---------------------------------------------------------------------------

const defaultSpawn: ManagedSpawn = (cmd, args, opts) =>
  nodeSpawn(cmd, args, opts as SpawnOptions) as unknown as ChildProcessLike;

async function isNonEmptyFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}
