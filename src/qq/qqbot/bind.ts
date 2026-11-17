/**
 * 官方 QQBot 扫码绑定会话（M1，本地渲染 + 凭据归一）。
 *
 * 职责边界（刻意保持纯逻辑，可单测、零新依赖）：
 *  - 本模块**不 import vscode**，也**不直接 import SDK**（`@tencent-connect/qqbot-connector`
 *    的 ESM/CJS exports bug 留到 M3 依赖接线时处理）。SDK 与二维码渲染器都由
 *    `QqBotBindDeps` 注入，M3 只需在宿主侧实例化时把真实实现接进来。
 *  - 二维码 PNG 的 data URL 校验复用 `shared/messages.ts` 的 `isQrDataUrl`
 *    安全护栏（只认 `data:image/png;base64,` + 合法 base64），与 webview 侧同一把尺子。
 *
 * 安全纪律：
 *  - `appSecret` 只经 `onSuccess` 回调传出，**不写进本类任何字段**，也**不进日志**；
 *    日志只打阶段事件名（不含 url、不含凭据、不含失败文案）。
 *  - `onFailure` 透传消息前做脱敏，抹掉 `appSecret` / `app_secret` 键值形态的串，
 *    避免 SDK 把凭据回显进失败文案。
 *  - 凭据不完整（缺 appId 或 appSecret）一律按失败处理，绝不回半截凭据。
 */

import { isQrDataUrl } from "../../../shared/messages.js";

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

/** 扫码成功后拿到的官方机器人凭据。 */
export type QqBotCredentials = {
  appId: string;
  appSecret: string;
  userOpenid?: string;
};

/** 展示层需要感知的扫码生命周期阶段。 */
export type QrProgressPhase = "waiting_scan" | "scanned" | "confirmed";

/** 会话回调（由宿主实现，驱动 webview 的展示与落盘）。 */
export interface QrSessionCallbacks {
  onQr(dataUrl: string, expiresAt: number): void;
  onProgress(phase: QrProgressPhase, detail?: string): void;
  onSuccess(creds: QqBotCredentials): void;
  onFailure(message: string): void;
}

/**
 * M3-A 自实现扫码协议的最小契约（结构兼容 protocol-client.ts 的 QqBotQrProtocol）。
 * 只在这里声明结构，不 import 具体类，保持 bind 层零新增耦合。
 */
export interface QqBotQrProtocolLike {
  start(cbs: {
    onQr(dataUrl: string, expiresAt: number): void;
    onSuccess(creds: QqBotCredentials): void;
    onFailure(message: string): void;
  }): Promise<() => void>;
}

/** 全部 IO 注入点：SDK 启动、二维码渲染、时钟、日志。 */
export interface QqBotBindDeps {
  startQrConnect: (
    cbs: {
      onQrDisplayed: (url: string) => void;
      onSuccess: (list: unknown) => void;
      onFailure: (msg: string) => void;
    },
    opts: { displayQrCodeToConsole: boolean; source: string; signal?: AbortSignal },
  ) => (() => void) | void;
  renderQr: (url: string) => Promise<string>;
  now?: () => number;
  ttlMs?: number;
  log?: (line: string) => void;
  source?: string;
  /**
   * M3-A：若注入自实现协议则**优先**走它（真 https + 凭据解密），
   * `startQrConnect` 保留给 M1 兼容 / 未接线的宿主，二者互斥。
   */
  protocol?: QqBotQrProtocolLike;
}

// ---------------------------------------------------------------------------
// 默认值与纯辅助函数（不导出，仅本模块内部使用）
// ---------------------------------------------------------------------------

const DEFAULT_SOURCE = "iflow-harness";
/** 官方扫码链接的默认有效期；宿主可通过 `deps.ttlMs` 覆盖。 */
const DEFAULT_TTL_MS = 60_000;
/** 失败文案上限，防止超长回显灌进 UI。 */
const MAX_FAILURE_CHARS = 500;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function readString(rec: UnknownRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function normalizeOne(raw: unknown): QqBotCredentials | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const appId = readString(rec, ["appId", "app_id"]);
  const appSecret = readString(rec, ["appSecret", "app_secret"]);
  if (!appId || !appSecret) return null;
  const userOpenid = readString(rec, ["userOpenid", "user_openid"]);
  return userOpenid ? { appId, appSecret, userOpenid } : { appId, appSecret };
}

/** SDK 的 onSuccess 既可能给对象也可能给数组；数组取第一个凭据完整的元素。 */
function normalizeCredentials(raw: unknown): QqBotCredentials | null {
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const creds = normalizeOne(item);
      if (creds) return creds;
    }
    return null;
  }
  return normalizeOne(raw);
}

/** 抹掉 `appSecret=xxx` / `"app_secret":"xxx"` 这类键值形态的密钥回显。 */
const SECRET_IN_TEXT = /(["']?app[_-]?secret["']?\s*[:=]\s*)(["']?)([^"'\s,;&})]+)\2/gi;

function sanitizeFailure(message: string): string {
  const text = typeof message === "string" ? message : "扫码失败";
  const redacted = text.replace(
    SECRET_IN_TEXT,
    (_match, prefix: string, quote: string) => `${prefix}${quote}<redacted>${quote}`,
  );
  return redacted.length > MAX_FAILURE_CHARS
    ? `${redacted.slice(0, MAX_FAILURE_CHARS)}…`
    : redacted;
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

/**
 * 一次官方扫码绑定会话。
 *
 * 用法：构造后 `await session.start(callbacks)`；二维码就绪时 `onQr` 会带
 * 本地渲染出的 PNG data URL 与过期时间；成功/失败走对应回调；随时可 `stop()`。
 */
export class QqBotBindSession {
  private readonly controller = new AbortController();
  private stopHandle: (() => void) | void = undefined;
  /** M3-A 自实现协议返回的 stop（与 stopHandle 互斥）。 */
  private protocolStop: (() => void) | undefined = undefined;
  private started = false;
  private stopped = false;
  private lastPhase: QrProgressPhase | null = null;
  /** onQrDisplayed 可能在 start() 返回前同步触发，用这个槽接住渲染 Promise。 */
  private qrRender: Promise<void> | null = null;
  private cbs: QrSessionCallbacks | null = null;

  constructor(private readonly deps: QqBotBindDeps) {}

  async start(cbs: QrSessionCallbacks): Promise<void> {
    if (this.started || this.stopped) {
      this.log("startIgnored");
      return;
    }
    this.started = true;
    this.cbs = cbs;
    this.log("start");

    // M3-A：注入了自实现协议则优先走它（真 https + AES-GCM 解密 + 过期刷新）。
    // 首张二维码已在 protocol.start() 内渲染并过 isQrDataUrl 校验，这里直接转发。
    if (this.deps.protocol) {
      const stop = await this.deps.protocol.start({
        onQr: (dataUrl, expiresAt) => {
          if (this.stopped || !this.cbs) return;
          this.emitProgress("waiting_scan");
          this.log("qrReady");
          this.cbs.onQr(dataUrl, expiresAt);
        },
        onSuccess: (creds) => {
          if (this.stopped || !this.cbs) return;
          this.log("success");
          this.cbs.onSuccess(creds);
        },
        onFailure: (message) => {
          if (this.stopped || !this.cbs) return;
          this.log("failure");
          this.cbs.onFailure(sanitizeFailure(message));
        },
      });
      this.protocolStop = stop;
      // stop() 可能在首次 createBindTask 仍在飞行时被调（此时 protocolStop 还没拿到），
      // 补一次 stop，避免协议在后台继续轮询。
      if (this.stopped) {
        try {
          stop();
        } catch {
          this.log("stopError");
        }
        this.protocolStop = undefined;
      }
      return;
    }

    // 额外的 onScanned / onConfirmed 只是「SDK 若有就映射」的透明通道：
    // 我们绝不在没有 SDK 事件时自己伪造 scanned/confirmed 阶段。
    const sdkCbs = {
      onQrDisplayed: (url: string) => this.handleQrDisplayed(url),
      onSuccess: (list: unknown) => this.handleSuccess(list),
      onFailure: (msg: string) => this.handleFailure(msg),
      onScanned: (detail?: string) => this.emitProgress("scanned", detail),
      onConfirmed: (detail?: string) => this.emitProgress("confirmed", detail),
    };
    const opts = {
      displayQrCodeToConsole: false, // 本模块本地渲染二维码，不让 SDK 重复打到控制台
      source: this.deps.source ?? DEFAULT_SOURCE,
      signal: this.controller.signal,
    };
    this.stopHandle = this.deps.startQrConnect(sdkCbs, opts);

    // 同步触发的 onQrDisplayed 已把渲染 Promise 放进 qrRender，这里接住它，
    // 保证 start() resolve 时首张二维码已经（或明确未能）投递给调用方。
    if (this.qrRender) await this.qrRender;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.log("stop");
    this.controller.abort();
    this.cbs = null;
    const stopFn = this.stopHandle;
    this.stopHandle = undefined;
    if (typeof stopFn === "function") {
      try {
        stopFn();
      } catch {
        this.log("stopError");
      }
    }
    const protocolStop = this.protocolStop;
    this.protocolStop = undefined;
    if (protocolStop) {
      try {
        protocolStop();
      } catch {
        this.log("stopError");
      }
    }
  }

  // -- SDK 回调侧 ----------------------------------------------------------

  private handleQrDisplayed(url: string): void {
    if (this.stopped || !this.cbs) return;
    this.log("qrDisplayed");
    this.emitProgress("waiting_scan");
    this.qrRender = this.renderAndPublish(url);
  }

  private async renderAndPublish(url: string): Promise<void> {
    try {
      const dataUrl = await this.deps.renderQr(url);
      if (this.stopped || !this.cbs) return;
      if (!isQrDataUrl(dataUrl)) {
        this.log("qrInvalid");
        return;
      }
      const now = this.deps.now ?? Date.now;
      const expiresAt = now() + (this.deps.ttlMs ?? DEFAULT_TTL_MS);
      this.cbs.onQr(dataUrl, expiresAt);
      this.log("qrReady");
    } catch {
      this.log("qrRenderError");
      if (!this.stopped && this.cbs) this.cbs.onFailure("二维码渲染失败");
    }
  }

  private handleSuccess(raw: unknown): void {
    if (this.stopped || !this.cbs) return;
    const creds = normalizeCredentials(raw);
    if (!creds) {
      this.log("credentialsInvalid");
      this.cbs.onFailure("扫码成功但未返回有效的 appId/appSecret");
      return;
    }
    this.log("success");
    this.cbs.onSuccess(creds);
  }

  private handleFailure(message: string): void {
    if (this.stopped || !this.cbs) return;
    this.log("failure");
    this.cbs.onFailure(sanitizeFailure(message));
  }

  // -- 内部小工具 ----------------------------------------------------------

  private emitProgress(phase: QrProgressPhase, detail?: string): void {
    if (this.stopped || !this.cbs) return;
    if (this.lastPhase === phase) return;
    this.lastPhase = phase;
    this.log(phase);
    if (detail === undefined) this.cbs.onProgress(phase);
    else this.cbs.onProgress(phase, detail);
  }

  private log(line: string): void {
    this.deps.log?.(line);
  }
}
