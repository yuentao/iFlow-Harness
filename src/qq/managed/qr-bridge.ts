/**
 * 扫码登录桥接（Wave5-B2）：把宿主侧 go-cqhttp 写出的二维码 png 轮询、转成
 * webview 可渲染的 `qqLoginQr` 消息。
 *
 * 职责边界：本模块只做「文件轮询 → base64 data URL → 消息推送」，不碰进程
 * 管理、不碰 panel、不 import vscode。所有 IO（fs / now / log）经构造函数注入，
 * 可直接单测。
 *
 * 安全纪律：
 * - qrPath 必须是宿主传入的绝对路径（构造时校验），运行期不接受任何路径替换；
 * - dataUrl 只由该 png 的 Buffer 生成，并过 `isQrDataUrl` 自检，非法数据绝不推送；
 * - 读取失败信息只带路径与次数，不带底层 error.message / stack（避免泄漏敏感内容）。
 */

import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  isQrDataUrl,
  QR_DATA_URL_PREFIX,
  type HostToWebview,
} from "../../../shared/messages.js";

/** webview 侧扫码消息类型，直接复用共享协议，避免两侧结构漂移。 */
export type QrBridgeMessage = Extract<HostToWebview, { type: "qqLoginQr" }>;

/** 二维码轮询所需的全部注入依赖。 */
export interface QrBridgeDeps {
  /** go-cqhttp 生成的二维码 png 绝对路径（宿主给定，运行期不变）。 */
  qrPath: string;
  /** 文件系统；缺省用 `node:fs/promises`。测试注入内存实现。 */
  fs?: {
    readFile(path: string): Promise<Buffer>;
    stat(path: string): Promise<{ mtimeMs: number; size: number }>;
  };
  /** 当前时间（epoch ms）；缺省 `Date.now`。`expiresAt` 用它计算。 */
  now?: () => number;
  /** 二维码有效时长，默认 3 分钟（二维码通常 3–5 分钟过期，宁短勿长）。 */
  ttlMs?: number;
  /** 诊断日志（非法内容 / 连续读错）；缺省 no-op。 */
  log?: (line: string) => void;
}

const DEFAULT_TTL_MS = 3 * 60 * 1000;
const ERROR_THRESHOLD = 3;

/** 判断 `stat` / `readFile` 抛出的错误是否为「文件不存在」。 */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

const defaultFs: NonNullable<QrBridgeDeps["fs"]> = {
  readFile: (p: string) => fsReadFile(p),
  stat: async (p: string) => {
    const s = await fsStat(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  },
};

/**
 * 二维码文件轮询器。
 *
 * - 指纹 = `mtimeMs + size`，同指纹不重复读 / 不重复推（`refresh()` 可强制清零）；
 * - 文件从无到有才推首帧，文件消失推一次 `expired` 清空 UI；
 * - 连续 IO 错误满 3 次只推一次带 `detail` 的帧，避免刷屏。
 */
export class QrBridge {
  private readonly qrPath: string;
  private readonly fs: NonNullable<QrBridgeDeps["fs"]>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly log?: (line: string) => void;

  private onMessage?: (msg: QrBridgeMessage) => void;
  private timer?: ReturnType<typeof setInterval>;
  private fingerprint?: string;
  /** 是否曾成功推出过二维码（用于区分「从未存在」与「消失」）。 */
  private hadQr = false;
  private lastMessage: QrBridgeMessage | null = null;
  private consecutiveErrors = 0;
  private errorReported = false;
  /** 避免上一帧异步 IO 未落地时下一帧重叠进入。 */
  private polling = false;

  constructor(deps: QrBridgeDeps) {
    if (typeof deps.qrPath !== "string" || !deps.qrPath || !isAbsolute(deps.qrPath)) {
      throw new Error("QrBridge: qrPath 必须是宿主传入的绝对路径");
    }
    this.qrPath = deps.qrPath;
    this.fs = deps.fs ?? defaultFs;
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.log = deps.log;
  }

  /** 启动轮询；重复调用会先停掉旧 interval。 */
  start(onMessage: (msg: QrBridgeMessage) => void, pollMs = 1000): void {
    this.stop();
    this.onMessage = onMessage;
    this.timer = setInterval(() => {
      void this.tick();
    }, pollMs);
  }

  /** 停掉轮询；幂等，可重复调用。 */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 强制下次轮询重推（对应 UI 的「刷新二维码」）。 */
  refresh(): void {
    this.fingerprint = undefined;
    this.consecutiveErrors = 0;
    this.errorReported = false;
  }

  /** 最近一次推出的消息（面板刚打开时补一帧）。 */
  current(): QrBridgeMessage | null {
    return this.lastMessage;
  }

  /** 以 `scanned` 阶段重推最近一次成功的二维码（不重新读文件）。 */
  markScanned(): void {
    this.repushPhase("scanned");
  }

  /** 以 `confirmed` 阶段重推最近一次成功的二维码（不重新读文件）。 */
  markConfirmed(): void {
    this.repushPhase("confirmed");
  }

  private repushPhase(phase: "scanned" | "confirmed"): void {
    const last = this.lastMessage;
    if (!last || !isQrDataUrl(last.dataUrl)) return;
    const msg: QrBridgeMessage = { ...last, phase };
    this.lastMessage = msg;
    this.onMessage?.(msg);
  }

  private push(msg: QrBridgeMessage): void {
    this.lastMessage = msg;
    this.onMessage?.(msg);
  }

  private clearErrors(): void {
    this.consecutiveErrors = 0;
    this.errorReported = false;
  }

  private noteError(): void {
    this.consecutiveErrors += 1;
    if (this.consecutiveErrors >= ERROR_THRESHOLD && !this.errorReported) {
      this.errorReported = true;
      // 只带路径与次数，不碰底层 error 内容。
      const detail = `二维码读取失败（连续 ${this.consecutiveErrors} 次）：${this.qrPath}`;
      this.log?.(detail);
      this.push({
        type: "qqLoginQr",
        dataUrl: "",
        expiresAt: this.now(),
        phase: "expired",
        detail,
      });
    }
  }

  private async tick(): Promise<void> {
    if (this.polling || !this.onMessage) return;
    this.polling = true;
    try {
      let info: { mtimeMs: number; size: number };
      try {
        info = await this.fs.stat(this.qrPath);
      } catch (err) {
        if (isNotFound(err)) this.handleMissing();
        else this.noteError();
        return;
      }

      const fp = `${info.mtimeMs}:${info.size}`;
      if (fp === this.fingerprint) return;

      let buf: Buffer;
      try {
        buf = await this.fs.readFile(this.qrPath);
      } catch (err) {
        // 读取瞬间被删也当「文件消失」处理，而不是计为读错误。
        if (isNotFound(err)) this.handleMissing();
        else this.noteError();
        return;
      }

      // IO 真正成功（读到 Buffer）才清错误计数；同指纹命中上面的早返回不清，
      // 这样连续读错误能跨帧累计到阈值。
      this.clearErrors();

      const dataUrl = QR_DATA_URL_PREFIX + buf.toString("base64");
      if (!isQrDataUrl(dataUrl)) {
        // 记下指纹，避免同一个坏文件每帧刷日志；内容变化（指纹变）会再试。
        this.fingerprint = fp;
        this.log?.("二维码内容非法，已跳过本帧");
        return;
      }

      this.fingerprint = fp;
      this.hadQr = true;
      this.push({
        type: "qqLoginQr",
        dataUrl,
        expiresAt: this.now() + this.ttlMs,
        phase: "waiting_scan",
      });
    } finally {
      this.polling = false;
    }
  }

  /** 文件不存在：从未成功过就静默等待；已有二维码则推一次 `expired` 清空 UI。 */
  private handleMissing(): void {
    this.clearErrors();
    if (this.hadQr && this.fingerprint !== undefined) {
      this.hadQr = false;
      this.fingerprint = undefined;
      this.push({
        type: "qqLoginQr",
        dataUrl: "",
        expiresAt: this.now(),
        phase: "expired",
      });
    }
  }
}
