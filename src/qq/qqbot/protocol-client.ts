/**
 * 官方 QQBot 扫码协议的**自包含实现**（M3-A，不依赖官方 SDK）。
 *
 * 事实来源（M3-R 已用真机 / node:https 直连实测并逐字段比对 SDK，见下）：
 *  - 本地 key：`randomBytes(32).toString('base64')`，跨「创建任务 / 轮询结果」
 *    两次请求留存（解密 bot_encrypt_secret 要用同一把 key）。
 *  - 创建任务：`POST https://q.qq.com/lite/create_bind_task`，body `{key}`，
 *    响应 `{retcode:0, data:{task_id}}`。
 *  - 轮询结果：`POST https://q.qq.com/lite/poll_bind_result`，body `{task_id}`，
 *    响应 `{retcode:0, data:{status, bot_appid, bot_encrypt_secret, user_openid?}}`；
 *    status 0/1 = 继续轮询、2 = 完成、3 = 过期（需换新 key 重建任务并刷新二维码）。
 *  - 凭据解密：`appSecret = AES-256-GCM 解密(data.bot_encrypt_secret, key)`，
 *    密文布局 `IV(12) | CT | TAG(16)`、无 AAD、utf8（已与 SDK 真机比对一致）。
 *  - 二维码 URL：`https://q.qq.com/qqbot/openclaw/connect.html?task_id=<enc>&source=<enc>&_wv=2`。
 *
 * 设计纪律：
 *  - 所有 IO 都注入（`QqBotHttp` / `QqBotCrypto` / `renderQr`），默认实现用
 *    `node:https` + `node:crypto`；不引第三方 SDK（其 type:module + exports.require→CJS
 *    打包 bug 会让本 CJS bundle 起不来），也不引 qrcode 依赖（渲染交给注入方）。
 *  - 网络层只认 HTTP 200 + JSON，超时默认 10s；`retcode!==0` 抛带服务端 msg 的错。
 *  - appSecret 只经 `onSuccess` 传出，**绝不进日志**；失败文案也可能带 secret 回显，
 *    统一过 `redactSecrets` 再交回调。
 *  - 二维码 data URL 必须过 `isQrDataUrl` 护栏才允许回调 onQr（与 webview 同一把尺子）。
 *  - 传输禁用全局 `fetch`（VSCode 扩展宿主把它 patch 成 SOCKS 代理，会抛
 *    `Invalid URL protocol`，见 AGENTS.md 陷阱 #2），默认实现走 node:https 直连。
 */

import * as https from "node:https";
import { createDecipheriv, randomBytes as nodeRandomBytes } from "node:crypto";
import { isQrDataUrl } from "../../../shared/messages.js";

// ---------------------------------------------------------------------------
// 端点 / 常量
// ---------------------------------------------------------------------------

/** 创建扫码绑定任务端点（M3-R 实测）。 */
export const CREATE_BIND_TASK_URL = "https://q.qq.com/lite/create_bind_task";
/** 轮询扫码结果端点（M3-R 实测）。 */
export const POLL_BIND_RESULT_URL = "https://q.qq.com/lite/poll_bind_result";
/** 扫码落地页（二维码内容）。 */
export const CONNECT_URL_BASE = "https://q.qq.com/qqbot/openclaw/connect.html";
/** 默认 source 参数。 */
export const DEFAULT_QQBOT_SOURCE = "iflow-harness";
/** 单次 HTTP 请求默认超时。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** 轮询间隔默认 2s。 */
export const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** 二维码展示有效期（仅作 expiresAt 展示提示，真实生命周期由 status 3 驱动）。 */
export const DEFAULT_QR_TTL_MS = 60_000;
/** 连续失败多少次后放弃。 */
export const DEFAULT_MAX_FAILURES = 10;

/** 轮询 status：0/1 继续、2 完成、3 过期。 */
export const BIND_STATUS_CONTINUE_0 = 0;
export const BIND_STATUS_CONTINUE_1 = 1;
export const BIND_STATUS_COMPLETED = 2;
export const BIND_STATUS_EXPIRED = 3;

// ---------------------------------------------------------------------------
// 注入接口
// ---------------------------------------------------------------------------

/** 最小 HTTP 注入点：POST 一个 JSON body，返回已解析的 JSON。 */
export interface QqBotHttp {
  post(url: string, body: unknown, timeoutMs: number): Promise<unknown>;
}

/** 最小 crypto 注入点：随机 key + AES-256-GCM 解密。 */
export interface QqBotCrypto {
  randomBytes(n: number): Buffer;
  /** 解密 `IV(12)|CT|TAG(16)` 布局的密文，返回 utf8 明文。 */
  decipherGcm(key: Buffer, blob: Buffer): string;
}

export interface CreateBindTaskResult {
  taskId: string;
}

export interface PollBindResult {
  status: number;
  botAppId?: string;
  botEncryptSecret?: string;
  userOpenid?: string;
}

/** 扫码成功后给回调的凭据（结构兼容 bind.ts 的 QqBotCredentials）。 */
export interface QqBotProtocolCredentials {
  appId: string;
  appSecret: string;
  userOpenid?: string;
}

export interface QrProtocolCallbacks {
  onQr(dataUrl: string, expiresAt: number): void;
  onSuccess(creds: QqBotProtocolCredentials): void;
  onFailure(message: string): void;
}

export interface QqBotQrProtocolOptions {
  http: QqBotHttp;
  crypto: QqBotCrypto;
  /** 把 connect URL 渲染成 PNG data URL（返回串会过 isQrDataUrl 校验）。 */
  renderQr: (url: string) => Promise<string>;
  source?: string;
  pollIntervalMs?: number;
  log?: (line: string) => void;
  /** 注入时钟（测试用），默认 Date.now。 */
  now?: () => number;
  /** 二维码展示有效期（测试用），默认 DEFAULT_QR_TTL_MS。 */
  qrTtlMs?: number;
  /** 连续失败上限（测试用），默认 DEFAULT_MAX_FAILURES。 */
  maxFailures?: number;
  /** 注入 sleep（测试用可设成 no-op 避免真实等待），默认 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// 纯辅助
// ---------------------------------------------------------------------------

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 抹掉 `appSecret=xxx` / `"app_secret":"xxx"` 这类密钥回显，防止失败文案泄密。 */
const SECRET_IN_TEXT = /(["']?app[_-]?secret["']?\s*[:=]\s*)(["']?)([^"'\s,;&})]+)\2/gi;

export function redactSecrets(text: string): string {
  return text.replace(
    SECRET_IN_TEXT,
    (_match, prefix: string, quote: string) => `${prefix}${quote}<redacted>${quote}`,
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

/** 从 retcode != 0 的响应里取服务端 msg（兼容 msg / message）。 */
function responseMessage(rec: UnknownRecord | null): string {
  if (!rec) return "请求失败";
  for (const key of ["msg", "message", "errmsg", "error"] as const) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return `retcode ${String(rec["retcode"])}`;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 默认 IO 实现
// ---------------------------------------------------------------------------

/** node:https 直连实现（禁全局 fetch，见文件头注释 / 陷阱 #2）。 */
export function createNodeHttp(): QqBotHttp {
  return {
    post(url, body, timeoutMs) {
      return new Promise<unknown>((resolve, reject) => {
        let target: URL;
        try {
          target = new URL(url);
        } catch {
          reject(new Error(`Invalid QQBot URL: ${url}`));
          return;
        }
        const payload = JSON.stringify(body);
        let settled = false;
        const succeed = (value: unknown): void => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        const fail = (err: Error): void => {
          if (settled) return;
          settled = true;
          reject(err);
        };

        const req = https.request(
          target,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
              "content-length": String(Buffer.byteLength(payload)),
            },
          },
          (res) => {
            const status = res.statusCode ?? 0;
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
            res.on("error", (err: Error) => fail(new Error(`QQBot response failed: ${err.message}`)));
            res.on("end", () => {
              if (status !== 200) {
                fail(new Error(`QQBot HTTP ${status}`));
                return;
              }
              const text = Buffer.concat(chunks).toString("utf8");
              try {
                succeed(JSON.parse(text) as unknown);
              } catch {
                fail(new Error("QQBot response is not valid JSON"));
              }
            });
          },
        );
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`QQBot request timed out after ${timeoutMs}ms`)));
        req.on("error", (err: Error) => fail(new Error(`QQBot request failed: ${err.message}`)));
        req.end(payload);
      });
    },
  };
}

/** node:crypto 实现：randomBytes + AES-256-GCM 解密（IV12|CT|TAG16，无 AAD）。 */
export function createNodeCrypto(): QqBotCrypto {
  return {
    randomBytes: (n) => nodeRandomBytes(n),
    decipherGcm: (key, blob) => {
      if (blob.length < 12 + 16) throw new Error("QQBot secret blob too short");
      const iv = blob.subarray(0, 12);
      const tag = blob.subarray(blob.length - 16);
      const ciphertext = blob.subarray(12, blob.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    },
  };
}

// ---------------------------------------------------------------------------
// 协议纯函数
// ---------------------------------------------------------------------------

/** `randomBytes(32).toString('base64')` 生成一次绑定 key（跨两次请求留存）。 */
export function generateBindKey(crypto: QqBotCrypto): string {
  return crypto.randomBytes(32).toString("base64");
}

/** 解密 bot_encrypt_secret：AES-256-GCM，布局 IV(12)|CT|TAG(16)，无 AAD，utf8。 */
export function decryptBotSecret(
  crypto: QqBotCrypto,
  encryptedBase64: string,
  keyBase64: string,
): string {
  const key = Buffer.from(keyBase64, "base64");
  const blob = Buffer.from(encryptedBase64, "base64");
  return crypto.decipherGcm(key, blob);
}

/** 构造二维码落地页 URL（task_id / source 均 encodeURIComponent）。 */
export function buildConnectUrl(taskId: string, source: string = DEFAULT_QQBOT_SOURCE): string {
  return `${CONNECT_URL_BASE}?task_id=${encodeURIComponent(taskId)}&source=${encodeURIComponent(source)}&_wv=2`;
}

/** `POST /lite/create_bind_task`：拿 task_id；retcode 非 0 / 缺 task_id 抛错。 */
export async function createBindTask(http: QqBotHttp, key: string): Promise<CreateBindTaskResult> {
  const raw = await http.post(CREATE_BIND_TASK_URL, { key }, DEFAULT_REQUEST_TIMEOUT_MS);
  const rec = isRecord(raw) ? raw : null;
  const retcode = rec ? toFiniteNumber(rec["retcode"]) : undefined;
  if (retcode !== 0) {
    throw new Error(`create_bind_task 失败: ${redactSecrets(responseMessage(rec))}`);
  }
  const data = isRecord(rec?.["data"]) ? (rec!["data"] as UnknownRecord) : null;
  const taskId = data?.["task_id"];
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new Error("create_bind_task 响应缺少 task_id");
  }
  return { taskId };
}

/** `POST /lite/poll_bind_result`：解析 status / 凭据字段；retcode 非 0 抛错。 */
export async function pollBindResult(http: QqBotHttp, taskId: string): Promise<PollBindResult> {
  const raw = await http.post(POLL_BIND_RESULT_URL, { task_id: taskId }, DEFAULT_REQUEST_TIMEOUT_MS);
  const rec = isRecord(raw) ? raw : null;
  const retcode = rec ? toFiniteNumber(rec["retcode"]) : undefined;
  if (retcode !== 0) {
    throw new Error(`poll_bind_result 失败: ${redactSecrets(responseMessage(rec))}`);
  }
  const data = isRecord(rec?.["data"]) ? (rec!["data"] as UnknownRecord) : null;
  const status = toFiniteNumber(data?.["status"]);
  if (status === undefined) throw new Error("poll_bind_result 响应缺少 status");

  const result: PollBindResult = { status };
  const appId = data?.["bot_appid"];
  if (typeof appId === "string" && appId) result.botAppId = appId;
  else if (typeof appId === "number" && Number.isFinite(appId)) result.botAppId = String(appId);

  const secret = data?.["bot_encrypt_secret"];
  if (typeof secret === "string" && secret) result.botEncryptSecret = secret;

  const openid = data?.["user_openid"];
  if (typeof openid === "string" && openid) result.userOpenid = openid;

  return result;
}

function isContinueStatus(status: number): boolean {
  return status === BIND_STATUS_CONTINUE_0 || status === BIND_STATUS_CONTINUE_1;
}

// ---------------------------------------------------------------------------
// 编排器：create → 轮询 → 解密 → 过期刷新
// ---------------------------------------------------------------------------

/**
 * 扫码绑定全流程编排器。
 *
 * `start(cbs)` 先创建任务并渲染/投递首张二维码（await 到 onQr 完成），随后在后台
 * 轮询；返回 stop 函数用于中止（幂等）。status 3 会用**新 key** 重建任务并刷新
 * 二维码；status 2 解密凭据后 onSuccess；连续失败达上限后 onFailure。
 */
export class QqBotQrProtocol {
  private readonly http: QqBotHttp;
  private readonly crypto: QqBotCrypto;
  private readonly renderQr: (url: string) => Promise<string>;
  private readonly source: string;
  private readonly pollIntervalMs: number;
  private readonly logFn: ((line: string) => void) | undefined;
  private readonly now: () => number;
  private readonly qrTtlMs: number;
  private readonly maxFailures: number;
  private readonly sleep: (ms: number) => Promise<void>;

  private controller: AbortController | null = null;
  private stopped = false;
  private stopFn: (() => void) | null = null;

  constructor(options: QqBotQrProtocolOptions) {
    this.http = options.http;
    this.crypto = options.crypto;
    this.renderQr = options.renderQr;
    this.source = options.source ?? DEFAULT_QQBOT_SOURCE;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.logFn = options.log;
    this.now = options.now ?? Date.now;
    this.qrTtlMs = options.qrTtlMs ?? DEFAULT_QR_TTL_MS;
    this.maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** 启动流程，resolve 时首张二维码已投递（或已明确失败）；返回幂等 stop。 */
  async start(cbs: QrProtocolCallbacks): Promise<() => void> {
    if (this.controller) return this.stopFn!;

    const controller = new AbortController();
    this.controller = controller;
    this.stopped = false;
    const stop = (): void => {
      if (this.stopped) return;
      this.stopped = true;
      controller.abort();
      this.log("stop");
    };
    this.stopFn = stop;

    let key = generateBindKey(this.crypto);
    let taskId: string;
    try {
      taskId = await this.issueQr(key, cbs, controller);
    } catch (err) {
      if (!this.stopped) {
        this.log("createFailed");
        this.reportFailure(cbs, err);
      }
      return stop;
    }
    if (this.stopped) return stop;

    void this.runPollLoop(taskId, key, cbs, controller, stop);
    return stop;
  }

  /** 对外暴露的 stop（等价于调用 start 返回的 stop），便于宿主统一收口。 */
  stop(): void {
    this.stopFn?.();
  }

  // -- 内部 ----------------------------------------------------------------

  /** 用给定 key 创建任务、渲染二维码、投递 onQr；返回 taskId。 */
  private async issueQr(
    key: string,
    cbs: QrProtocolCallbacks,
    controller: AbortController,
  ): Promise<string> {
    const { taskId } = await createBindTask(this.http, key);
    if (this.stopped || controller.signal.aborted) return taskId;

    const url = buildConnectUrl(taskId, this.source);
    const dataUrl = await this.renderQr(url);
    if (this.stopped || controller.signal.aborted) return taskId;

    if (!isQrDataUrl(dataUrl)) {
      this.log("qrInvalid");
      return taskId;
    }
    const expiresAt = this.now() + this.qrTtlMs;
    cbs.onQr(dataUrl, expiresAt);
    this.log("qrReady");
    return taskId;
  }

  private async runPollLoop(
    initialTaskId: string,
    initialKey: string,
    cbs: QrProtocolCallbacks,
    controller: AbortController,
    stop: () => void,
  ): Promise<void> {
    let taskId = initialTaskId;
    let key = initialKey;
    let consecutiveFailures = 0;

    while (!this.stopped && !controller.signal.aborted) {
      await this.sleep(this.pollIntervalMs);
      if (this.stopped || controller.signal.aborted) break;

      try {
        const result = await pollBindResult(this.http, taskId);
        if (this.stopped || controller.signal.aborted) break;
        consecutiveFailures = 0;

        if (isContinueStatus(result.status)) {
          this.log("pollPending");
          continue;
        }

        if (result.status === BIND_STATUS_EXPIRED) {
          this.log("expired");
          try {
            key = generateBindKey(this.crypto);
            taskId = await this.issueQr(key, cbs, controller);
            consecutiveFailures = 0;
          } catch (err) {
            this.log("refreshFailed");
            consecutiveFailures += 1;
            if (consecutiveFailures >= this.maxFailures) {
              this.log("giveUp");
              this.reportFailure(cbs, err);
              stop();
              return;
            }
          }
          continue;
        }

        if (result.status === BIND_STATUS_COMPLETED) {
          if (!result.botAppId || !result.botEncryptSecret) {
            this.log("credentialsMissing");
            if (!this.stopped) cbs.onFailure("扫码完成但缺少凭据字段");
            stop();
            return;
          }
          try {
            const appSecret = decryptBotSecret(
              this.crypto,
              result.botEncryptSecret,
              key,
            );
            this.log("success");
            const creds: QqBotProtocolCredentials = { appId: result.botAppId, appSecret };
            if (result.userOpenid) creds.userOpenid = result.userOpenid;
            if (!this.stopped) cbs.onSuccess(creds);
          } catch {
            this.log("decryptFailed");
            if (!this.stopped) cbs.onFailure("凭据解密失败");
          }
          stop();
          return;
        }

        // 未知 status：当作一次软失败，计数达上限即放弃。
        this.log("unknownStatus");
        consecutiveFailures += 1;
        if (consecutiveFailures >= this.maxFailures) {
          this.log("giveUp");
          if (!this.stopped) cbs.onFailure("扫码返回未知状态");
          stop();
          return;
        }
      } catch (err) {
        if (this.stopped || controller.signal.aborted) break;
        consecutiveFailures += 1;
        this.log("pollError");
        if (consecutiveFailures >= this.maxFailures) {
          this.log("giveUp");
          this.reportFailure(cbs, err);
          stop();
          return;
        }
      }
    }
  }

  /** 失败文案过脱敏再交回调；log 只记事件名，绝不写凭据 / 原始文案。 */
  private reportFailure(cbs: QrProtocolCallbacks, err: unknown): void {
    if (this.stopped) return;
    cbs.onFailure(redactSecrets(errorMessage(err)));
  }

  private log(line: string): void {
    this.logFn?.(line);
  }
}
