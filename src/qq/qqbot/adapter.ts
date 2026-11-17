/**
 * 官方 QQBot（sgroup）网关 adapter：单连接生命周期（鉴权 → 建连 → 心跳 →
 * 收发 → 关闭）。零具体网络依赖：WebSocket 与 HTTP 全部走注入的 transport，
 * 这样 M2 可以纯单测；真正的 node:ws / node:http(s) transport 属于后续接线。
 *
 * 网关 OP 码（官方 Gateway 文档，M0 已实测握手 101）：
 *   op=0  Dispatch  —— 服务器推送事件，d 为事件体、t 为事件名、s 为序列号；
 *   op=1  Heartbeat —— 客户端心跳，d 为最后收到的序列号（首次可为 null）；
 *   op=2  Identify  —— 客户端鉴权，d.token = "QQBot <access_token>"、intents、
 *                     properties；收到 Hello 后立刻发一次；
 *   op=10 Hello     —— 连接建立后服务器首帧，d.heartbeat_interval（毫秒）；
 *   op=11 Heartbeat ACK —— 心跳回执，忽略即可；
 *   op=7 Reconnect / op=9 Invalid Session —— 仅记录，重连由上层负责。
 *
 * 纪律：token 只出现在发往网关/API 的头与 Identify 载荷里，绝不进日志；
 * 本类不做异常重试（上层负责），只维护一条连接的生命周期。
 */

import type { ChannelAdapter, ChannelHealth, InboundMessage, OutboundMessage, SendResult } from "../adapter/types.js";
import {
  buildAccessTokenRequest,
  buildAuthHeaders,
  buildSendGroupMsg,
  buildSendPrivateMsg,
  DEFAULT_QQBOT_GATEWAY_URL,
  normalizeQqBotEvent,
  parseAccessTokenResponse,
} from "./protocol.js";

/** 注入的 WebSocket 抽象。 */
export interface QqBotSocket {
  onMessage(cb: (raw: unknown) => void): void;
  send(data: unknown): void;
  close(): void;
}

/** 注入的 HTTP + WebSocket 工厂。post 用于 token 换取与 OpenAPI 发送。 */
export interface QqBotTransport {
  connect(url: string, headers: Record<string, string>): Promise<QqBotSocket>;
  post(endpoint: string, headers: Record<string, string>, body: Record<string, unknown>): Promise<unknown>;
}

/** 归一化成功后的入站消息回调（与 onebot-sink 的 onEvent 同语义）。 */
export type QqBotEventHandler = (inbound: InboundMessage) => void | Promise<void>;

export interface QqBotAdapterDeps {
  appId: string;
  appSecret: string;
  transport: QqBotTransport;
  /** 覆盖默认官方网关（自签/代理环境）；缺省 `wss://api.sgroup.qq.com/websocket`。 */
  gatewayUrl?: string;
  /** 注入时钟，便于测试 token 过期与刷新；缺省 Date.now。 */
  now?: () => number;
  /** 诊断日志；调用方保证不把 token 写进来。 */
  log?: (line: string) => void;
}

/** 过期前 5 分钟刷新：避免请求打到临界点被拒。 */
export const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** 默认心跳间隔兜底（Hello 没给 heartbeat_interval 时用 30s）。 */
const DEFAULT_HEARTBEAT_MS = 30_000;

/** OP 码常量（导出便于测试/复用）。 */
export const QQBOT_OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
  RECONNECT: 7,
  INVALID_SESSION: 9,
} as const;

/**
 * C2C / 群消息意图位。官方 intents 中 `1 << 25` 覆盖 GROUP_AND_C2C_MESSAGE；
 * 若平台开放更多事件，调用方可在 Identify 载荷侧扩展（本 M2 固定此值）。
 */
export const QQBOT_INTENTS = 1 << 25;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 官方 QQBot ChannelAdapter 实现。
 *
 * 复用 `src/qq/adapter/types.ts` 的 ChannelAdapter 形态（connect/close/send/
 * health 四个方法签名完全一致）；该接口没有事件回调位，因此额外提供
 * `setEventCallback` 供 bridge 把 InboundMessage 接到 service 层——这是对
 * 契约的扩展而非改动，现有 OneBot HTTP sink 不受影响。
 */
export class QqBotAdapter implements ChannelAdapter {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly transport: QqBotTransport;
  private readonly gatewayUrl: string;
  private readonly nowFn: () => number;
  private readonly logFn?: (line: string) => void;

  private token: string | undefined;
  private tokenExpiresAt = 0;
  private socket: QqBotSocket | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private lastSequence: number | null = null;
  private lastEventAt: number | undefined;
  private lastError: string | undefined;
  private connected = false;
  private eventHandler: QqBotEventHandler | undefined;

  constructor(deps: QqBotAdapterDeps) {
    this.appId = deps.appId;
    this.appSecret = deps.appSecret;
    this.transport = deps.transport;
    this.gatewayUrl = deps.gatewayUrl ?? DEFAULT_QQBOT_GATEWAY_URL;
    this.nowFn = deps.now ?? Date.now;
    this.logFn = deps.log;
  }

  /** 注册入站消息回调（可用链式调用；重复注册以最后一次为准）。 */
  setEventCallback(handler: QqBotEventHandler): this {
    this.eventHandler = handler;
    return this;
  }

  /** 仅输出不含凭据的诊断行；token/appSecret 永不进这里。 */
  private log(line: string): void {
    this.logFn?.(line);
  }

  /**
   * 取得可用 access_token：命中缓存（过期前 5 分钟视为过期）直接返回，
   * 否则用 AppID+Secret 换一次并缓存。异常原样抛给上层决定重试。
   */
  private async ensureToken(): Promise<string> {
    if (this.token && this.nowFn() < this.tokenExpiresAt - TOKEN_REFRESH_SKEW_MS) {
      return this.token;
    }
    const request = buildAccessTokenRequest(this.appId, this.appSecret);
    const raw = await this.transport.post(
      request.endpoint,
      { "content-type": "application/json" },
      request.body,
    );
    const parsed = parseAccessTokenResponse(raw);
    if (!parsed) throw new Error("QQBot: getAppAccessToken 未返回 access_token");
    this.token = parsed.accessToken;
    this.tokenExpiresAt = this.nowFn() + parsed.expiresIn * 1000;
    this.log("QQBot: access token refreshed");
    return parsed.accessToken;
  }

  /** 连接：换 token → 建 WebSocket → 注册消息回调。Hello 到达后再 Identify。 */
  async connect(): Promise<void> {
    const token = await this.ensureToken();
    // 单连接生命周期：重复 connect 先清理旧连接与心跳，不叠加 socket。
    this.stopHeartbeat();
    this.socket?.close();
    const socket = await this.transport.connect(this.gatewayUrl, buildAuthHeaders(token));
    this.socket = socket;
    this.connected = true;
    this.lastError = undefined;
    socket.onMessage((raw) => this.handleRaw(raw));
    this.log("QQBot: websocket connected");
  }

  /** 处理一帧网关消息：Hello/Heartbeat/Dispatch/重连指令。 */
  private handleRaw(raw: unknown): void {
    if (!isRecord(raw)) return;
    const op = toFiniteNumber(raw["op"]);
    if (op === undefined) return;

    switch (op) {
      case QQBOT_OP.HELLO: {
        const hello = isRecord(raw["d"]) ? raw["d"] : {};
        const interval = toFiniteNumber(hello["heartbeat_interval"]);
        this.startHeartbeat(interval !== undefined && interval > 0 ? interval : DEFAULT_HEARTBEAT_MS);
        this.sendIdentify();
        break;
      }
      case QQBOT_OP.DISPATCH: {
        const seq = toFiniteNumber(raw["s"]);
        if (seq !== undefined) this.lastSequence = seq;
        this.lastEventAt = this.nowFn();
        const inbound = normalizeQqBotEvent(raw);
        if (!inbound || !this.eventHandler) break;
        // 回调可能异步；失败只记日志，绝不让一根异常打断 socket 消息循环。
        void Promise.resolve(this.eventHandler(inbound)).catch((error: unknown) => {
          this.log(`QQBot: inbound handler failed: ${errorText(error)}`);
        });
        break;
      }
      case QQBOT_OP.HEARTBEAT:
        // 服务器也可能反向要求心跳，直接回一帧。
        this.sendHeartbeat();
        break;
      case QQBOT_OP.HEARTBEAT_ACK:
        break;
      case QQBOT_OP.RECONNECT:
        this.log("QQBot: server requested reconnect");
        break;
      case QQBOT_OP.INVALID_SESSION:
        this.log("QQBot: invalid session");
        break;
      default:
        break;
    }
  }

  /** Identify 载荷：token 带 `QQBot ` 前缀（与鉴权头一致），intents 固定。 */
  private sendIdentify(): void {
    if (!this.token || !this.socket) return;
    this.socket.send({
      op: QQBOT_OP.IDENTIFY,
      d: {
        token: buildAuthHeaders(this.token)["Authorization"],
        intents: QQBOT_INTENTS,
        properties: { $os: "node", $sdk: "iflow-harness" },
      },
    });
  }

  private sendHeartbeat(): void {
    this.socket?.send({ op: QQBOT_OP.HEARTBEAT, d: this.lastSequence });
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), intervalMs);
    // 心跳定时器不应阻止进程退出。
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /** 发送一条文本消息；token 复用缓存。filePath 属富媒体上传，M2 明确不支持。 */
  async send(msg: OutboundMessage): Promise<SendResult> {
    if (msg.filePath) {
      return {
        ok: false,
        error: "QQBot: 富媒体上传（file_info）尚未实现",
        retryable: false,
      };
    }
    try {
      const token = await this.ensureToken();
      const request =
        msg.chatType === "group"
          ? buildSendGroupMsg(msg.chatId, msg.text, msg.replyToMsgId)
          : buildSendPrivateMsg(msg.chatId, msg.text, msg.replyToMsgId);
      const raw = await this.transport.post(
        request.endpoint,
        { ...buildAuthHeaders(token), "content-type": "application/json" },
        request.body,
      );
      let messageId: string | undefined;
      if (isRecord(raw)) {
        const id = raw["id"] ?? raw["msg_id"];
        if (typeof id === "string" || typeof id === "number") messageId = String(id);
      }
      return { ok: true, messageId };
    } catch (error) {
      // 网络/服务端异常交给上层重试；错误文本不含凭据。
      return { ok: false, error: errorText(error), retryable: true };
    }
  }

  /** 关闭连接并清理心跳定时器，可安全重复调用。 */
  async close(): Promise<void> {
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = undefined;
    this.connected = false;
    this.log("QQBot: websocket closed");
  }

  /** 连接态快照；detail 只含状态描述，不含 token。 */
  async health(): Promise<ChannelHealth> {
    return {
      connected: this.connected,
      detail: this.lastError ?? (this.connected ? "qqbot websocket" : "disconnected"),
      lastEventAt: this.lastEventAt,
    };
  }
}
