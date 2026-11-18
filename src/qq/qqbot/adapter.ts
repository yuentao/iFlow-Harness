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
 *   op=11 Heartbeat ACK —— 心跳回执，按发出时的序号关联（陈旧 ACK 不清零）；
 *   op=7 Reconnect / op=9 Invalid Session —— 收到即主动断线重连，绝不等底层 close
 *     或心跳看门狗（半开连接会静默丢消息）。
 *
 * 序号纪律（2026-11-18 加固）：Dispatch 的 s 只在严格递增时覆盖 lastSequence；
 * lastSequence 归属会话，Identify 建新会话 / op=9 作废会话时清零，Resume 只在
 * 序号属于当前会话时携带。入站 msgId 有有界去重窗口，防 resume 重放重复建任务。
 *
 * 纪律：token 只出现在发往网关/API 的头与 Identify 载荷里，绝不进日志。
 *
 * 连接生命周期（2026-11-17 补齐断线恢复）：
 *  - 心跳发送异常与 ACK 断供都在定时器内部消化（记 lastError → 主动断开 →
 *    指数退避重连），异常绝不穿透定时器回调；
 *  - 101 建连成功后启动一次性握手超时（缺省 20s）：迟迟拿不到 READY 就断开
 *    重连，避免「已连接但不干活」（平台静默忽略 Resume 时就是这种形态）；
 *    定时器只在 READY 清除，HELLO 不算握手完成；
 *  - 退避按**连续失败次数**指数增长，只有 READY 成功才清零 —— 反复判死不
 *    会每次退回 1s 形成重连风暴；最近判死原因与连续失败次数进 health；
 *  - 重连优先 Resume（op=6，携带 session_id + 最近 seq，目标为 READY 给的
 *    resume_gateway_url），失败或没有会话时退回 Identify；
 *  - 退回 Identify 意味着断线区间无法补发：`missedWindowNotice` 会一直挂在
 *    health().detail 上，绝不宣称「消息已恢复」；
 *  - 出站 HTTP 失败（send）与断线都写入 lastError，health() 脱敏后带出。
 */

import type { ChannelAdapter, ChannelHealth, InboundMessage, OutboundMessage, SendResult } from "../adapter/types.js";
import {
  buildAccessTokenRequest,
  buildAuthHeaders,
  buildSendGroupMsg,
  buildSendPrivateMsg,
  DEFAULT_QQBOT_GATEWAY_URL,
  describeAccessTokenFailure,
  normalizeQqBotEvent,
  parseAccessTokenResponse,
} from "./protocol.js";

/** 注入的 WebSocket 抽象。 */
export interface QqBotSocket {
  onMessage(cb: (raw: unknown) => void): void;
  send(data: unknown): void;
  close(): void;
  /**
   * 可选：底层断开通知（ws 的 close / error）。缺失时适配器只能靠心跳
   * 发送异常发现连接已死；ws-transport 的实现会补上这条通道。
   */
  onClose?(cb: (error?: unknown) => void): void;
}

/** 注入的 HTTP + WebSocket 工厂。post 用于 token 换取与 OpenAPI 发送。 */
export interface QqBotTransport {
  connect(url: string, headers: Record<string, string>): Promise<QqBotSocket>;
  post(endpoint: string, headers: Record<string, string>, body: Record<string, unknown>): Promise<unknown>;
}

/** 归一化成功后的入站消息回调。 */
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
  /** 重连退避起始延迟（毫秒，测试注入）；缺省 1000。 */
  reconnectBaseDelayMs?: number;
  /** 重连退避上限（毫秒，测试注入）；缺省 30000。 */
  reconnectMaxDelayMs?: number;
  /**
   * 重连退避抖动的随机源（返回 [0,1)）；缺省 Math.random。测试注入固定值以
   * 断言抖动区间，生产保持随机化以打散多实例同时断线的惊群。
   */
  random?: () => number;
  /**
   * 连续多少个心跳周期收不到 ACK 就判定连接已死；缺省 2。
   * 测试与弱网场景可注入更大值以减少误判，注入 1 表示一个周期未 ACK 即判死。
   */
  heartbeatMaxMissedAcks?: number;
  /**
   * WS 建连成功（101）后等待 HELLO/READY 的一次性握手超时（毫秒）；
   * 缺省 20000，`<= 0` 关闭。平台对 Resume 静默忽略时连接会「看着活着但
   * 永远没有 READY」，这条超时是唯一能把它拉回来的机制。
   */
  handshakeTimeoutMs?: number;
}

/** 过期前 5 分钟刷新：避免请求打到临界点被拒。 */
export const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** 默认心跳间隔兜底（Hello 没给 heartbeat_interval 时用 30s）。 */
const DEFAULT_HEARTBEAT_MS = 30_000;

/**
 * 心跳连续多少个周期没收到 ACK 就判定连接已死（缺省 2 个周期 ≈ 平台容忍
 * 窗口）。可通过构造选项 `heartbeatMaxMissedAcks` 覆盖，行为默认不变。
 */
export const DEFAULT_HEARTBEAT_MAX_MISSED_ACKS = 2;

/**
 * WS 建连（101）后等待 HELLO/READY 的一次性超时缺省值（20s）。
 *
 * 只覆盖「已连接但不干活」：TCP/TLS 与 101 由 transport 自己的连接超时管，
 * 这里管的是握手帧迟迟不来（典型：平台静默忽略 Resume，连接保持但没有
 * READY，心跳也永远不启动）。可用 `handshakeTimeoutMs` 覆盖或关闭。
 */
export const DEFAULT_QQBOT_HANDSHAKE_TIMEOUT_MS = 20_000;

/** 重连退避：1s 起、指数增长、封顶 30s（测试可注入更小值）。 */
const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * 入站 msgId 去重窗口：同一条消息在窗口内只投递一次（resume 会重放断线区间，
 * 重复推送也会造成重复建任务）。TTL 只用于内存回收与「同一消息」判定；容量
 * 上限兜底防无限增长（超限逐出最旧）。
 */
const SEEN_INBOUND_TTL_MS = 2 * 60_000;
const SEEN_INBOUND_LIMIT = 5_000;

/**
 * Resume 重试上限：连续这么多次重连都没成功（resume 地址不可达 / 会话被判死），
 * 就放弃恢复、改回默认网关新建会话 —— 否则会拿着一个失效地址无限退避重连。
 */
const RESUME_MAX_ATTEMPTS = 3;

/**
 * OP 码常量（导出便于测试/复用）。
 *
 * `RESUME=6` 是官方网关的会话恢复帧：`d = { token, session_id, seq }`，
 * `seq` 为最后收到的 Dispatch 序列号。**字段名不确定性**：`session_id` 取自
 * READY 的 `d.session_id`，重连目标取自 READY 的 `d.resume_gateway_url`；
 * 两者都存在才走 Resume，缺失则退回普通 Identify（见 sendHandshake）。若平台
 * 版本改名，只需改 `captureReady` 的取值键。
 */
export const QQBOT_OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
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
 * 从 transport 抛出的错误里取 HTTP status。
 *
 * `node:http(s)` 的 transport 在非 2xx 时抛带 `status` 字段的错误（见
 * `ws-transport.ts` 的 `QqBotHttpError`）；超时 / 网络错误没有 status ——
 * 返回 undefined 表示「无法判定，按可重试处理」。
 */
function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return toFiniteNumber((error as { status?: unknown }).status);
}

/**
 * 4xx（429 除外）是确定性拒绝：鉴权失败、参数非法、消息已被平台拒绝……重试
 * 只会拿到同一份拒绝，继续烧重试窗口（并可能重复发主动消息）毫无意义。
 * 429（限流）、5xx、超时与网络错误仍然可重试。
 */
function isPermanentHttpStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}

/** 业务错误码的字段名：QQBot OpenAPI 的错误响应以这些键承载（HTTP 可能仍是 200）。 */
const BUSINESS_ERROR_CODE_KEYS = ["code", "errcode", "retcode"] as const;

/**
 * 从 2xx 响应体里提取非零业务错误码。
 *
 * 成功响应是 `{id, timestamp}`（发送）或 `{access_token, expires_in}`（换 token），
 * 不含错误码；平台把部分拒绝放在 HTTP 200 的 `code` / `errcode` / `retcode`
 * 里。**HTTP 200 + 非零业务码必须算失败**，否则会把没发出去的消息记成已送达
 * （幂等锚点被虚增，结果再也不重发）。
 */
function businessError(raw: unknown): { code: number; message: string } | undefined {
  if (!isRecord(raw)) return undefined;
  for (const key of BUSINESS_ERROR_CODE_KEYS) {
    const code = toFiniteNumber(raw[key]);
    if (code === undefined || code === 0) continue;
    let message = "";
    for (const messageKey of ["message", "msg", "errmsg", "error"] as const) {
      const value = raw[messageKey];
      if (typeof value === "string" && value.trim()) {
        message = value.trim();
        break;
      }
    }
    return { code, message: message || `业务错误码 ${code}` };
  }
  return undefined;
}

/**
 * 官方 QQBot ChannelAdapter 实现。
 *
 * 复用 `src/qq/adapter/types.ts` 的 ChannelAdapter 形态（connect/close/send/
 * health 四个方法签名完全一致）；该接口没有事件回调位，因此额外提供
 * `setEventCallback` 供宿主把 InboundMessage 接到 service 层——这是对契约的
 * 扩展而非改动。
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
  /** token 刷新代际：只用于阻止「旧响应覆盖新 token」。 */
  private tokenVersion = 0;
  /** 进行中的 token 刷新（并发调用共享同一次请求）；失败即清除以便重试。 */
  private tokenFetch: Promise<string> | undefined;

  private socket: QqBotSocket | undefined;
  /** socket 代际：重连后旧 socket 的 message/close 事件必须被忽略。 */
  private socketEpoch = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatIntervalMs = DEFAULT_HEARTBEAT_MS;
  /** 建连成功后等待 HELLO/READY 的一次性超时定时器（READY 时清除）。 */
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  /** 已发出但尚未收到 ACK 的心跳数（连续多个周期无 ACK 判定连接已死）。 */
  private awaitingHeartbeatAcks = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;
  /**
   * 连续失败次数（建连失败 / 心跳判死 / 握手超时都算）。
   *
   * 退避延迟按它指数增长，**只有 READY 成功才清零** —— 否则「反复判死 →
   * 重连 → 又判死」的震荡里每次都会退回 1s 重连风暴。
   */
  private consecutiveFailures = 0;
  /** 最近一次判死原因（脱敏后进 health().detail，便于排查震荡）。 */
  private lastDeathReason: string | undefined;
  /** 用户显式 close 后不再自动重连。 */
  private closing = false;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly heartbeatMaxMissedAcks: number;
  private readonly handshakeTimeoutMs: number;
  /** 退避抖动随机源（注入固定值便于测试；缺省 Math.random）。 */
  private readonly randomFn: () => number;

  private lastSequence: number | null = null;
  /**
   * lastSequence 归属的会话 id：只有与当前 sessionId 相同才允许带进 Resume。
   * Identify 建新会话 / op=9 作废会话时连同 lastSequence 一起清零，防止把旧
   * 会话的序号带进新会话（心跳与 Resume 都会带错）。
   */
  private lastSequenceSessionId: string | undefined;
  /**
   * 已发出心跳的序号队列（与 lastSequence 同源；null 表示发出时尚无序号）。
   * ACK 带回序号时只认领队列中对应项，陈旧 ACK 不再清零在途计数。
   */
  private readonly heartbeatAckQueue: Array<number | null> = [];
  /**
   * 已投递入站消息的 msgId → 投递时刻（有界去重窗口）。resume 重放 / 平台
   * 重复推送不会让同一条消息被处理两次。
   */
  private readonly seenInbound = new Map<string, number>();
  /** 窗口内被去重丢弃的入站事件数（health.detail 可观测）。 */
  private duplicateInbound = 0;
  private lastEventAt: number | undefined;
  private lastError: string | undefined;
  /** lastError 来源：send 类错误在下次成功发送时清除，连接类错误等连接成功才清。 */
  private lastErrorSource: "send" | "connection" | undefined;
  /** 缺 msgId 而被丢弃的入站事件数（可观测；health.detail 会带出）。 */
  private droppedInbound = 0;
  /**
   * 可恢复会话状态（READY 提供）。字段名按官方文档 / Discord 同源语义；
   * 平台若改名，缺失时自然退回普通 Identify（不猜、不伪造恢复）。
   */
  private sessionId: string | undefined;
  private resumeGatewayUrl: string | undefined;
  /** 本次握手用的是 Identify 还是 Resume（READY 时据此判断是否真的续上了）。 */
  private handshake: "identify" | "resume" | undefined;
  /** 自上次 READY 后是否发生过断线（下一次 READY 据此结算丢消息提示）。 */
  private disconnectedSinceReady = false;
  /** 当前连接上「断线区间可能丢消息」的可见提示（health.detail 带出）。 */
  private missedWindowNotice: string | undefined;
  private connected = false;
  private eventHandler: QqBotEventHandler | undefined;
  /**
   * 每个 `msg_id` 已经用掉的被动回复序号。
   *
   * QQ 按 `(msg_id, msg_seq)` 去重：同一个 msg_id 若不带 seq（缺省都当 1），
   * 第二条及以后的回复会被平台当成重复消息丢弃 —— 表现就是「只有已受理送达，
   * 结果回包一条也收不到」。这里为每条入站消息维护递增序号。
   */
  private readonly replySeq = new Map<string, { seq: number; at: number }>();
  /**
   * 逻辑消息去重键 → 已分配的 msg_seq、归属 msg_id 与分配时刻。
   *
   * 同一 `dedupeKey`（同一逻辑消息的首次发送 + 它的全部重试）复用同一个
   * seq：平台按 `(msg_id, msg_seq)` 去重，重试不会刷出重复消息。条目带
   * TTL —— 被动回复窗口本身有限，过期条目再分配新 seq 也无碍（旧窗口
   * 早已关闭，不可能再撞上旧消息）。
   *
   * 与 `replySeq` 共同记账：任一侧逐出对应 msg_id 时必须同步作废，否则
   * dedupe 条目会指向一个已被重置的序号（下次同 msg_id 从 1 重开，可能撞
   * 历史 `(msg_id, 1)` 被平台当重复丢弃）。
   */
  private readonly dedupeSeq = new Map<string, { seq: number; at: number; msgId: string }>();

  /** 去重条目的保留时长；超过即视为新消息重新分配 seq。 */
  private static readonly DEDUPE_TTL_MS = 10 * 60_000;
  /**
   * 单个 `msg_id` 的序号记账保留时长。
   *
   * 被动回复绑定在用户那条消息的短窗口上；超出该窗口后序号不再有平台语义，
   * 重开不会撞上一条「仍然有效」的历史消息。TTL 只用于回收内存，不改变
   * 窗口内的单调递增。
   */
  private static readonly REPLY_SEQ_TTL_MS = 30 * 60_000;

  /** 限容映射的条目上限（超限逐出最旧，防无限增长）。 */
  private static readonly SEQ_MAP_LIMIT = 5_000;

  private evictOldest<K, V>(map: Map<K, V>, limit: number): void {
    if (map.size <= limit) return;
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }

  /** 逐出某 `msg_id` 的序号记账，并同步作废指向它的 dedupe 条目。 */
  private forgetMsgSeq(msgId: string): void {
    this.replySeq.delete(msgId);
    for (const [key, entry] of this.dedupeSeq) {
      if (entry.msgId === msgId) this.dedupeSeq.delete(key);
    }
  }

  constructor(deps: QqBotAdapterDeps) {
    this.appId = deps.appId;
    this.appSecret = deps.appSecret;
    this.transport = deps.transport;
    this.gatewayUrl = deps.gatewayUrl ?? DEFAULT_QQBOT_GATEWAY_URL;
    this.nowFn = deps.now ?? Date.now;
    this.logFn = deps.log;
    this.reconnectBaseDelayMs =
      typeof deps.reconnectBaseDelayMs === "number" && deps.reconnectBaseDelayMs > 0
        ? deps.reconnectBaseDelayMs
        : DEFAULT_RECONNECT_BASE_DELAY_MS;
    this.reconnectMaxDelayMs =
      typeof deps.reconnectMaxDelayMs === "number" && deps.reconnectMaxDelayMs > 0
        ? deps.reconnectMaxDelayMs
        : DEFAULT_RECONNECT_MAX_DELAY_MS;
    this.heartbeatMaxMissedAcks =
      typeof deps.heartbeatMaxMissedAcks === "number" &&
      Number.isFinite(deps.heartbeatMaxMissedAcks) &&
      deps.heartbeatMaxMissedAcks >= 1
        ? Math.floor(deps.heartbeatMaxMissedAcks)
        : DEFAULT_HEARTBEAT_MAX_MISSED_ACKS;
    this.handshakeTimeoutMs =
      typeof deps.handshakeTimeoutMs === "number" && Number.isFinite(deps.handshakeTimeoutMs)
        ? deps.handshakeTimeoutMs
        : DEFAULT_QQBOT_HANDSHAKE_TIMEOUT_MS;
    this.randomFn =
      typeof deps.random === "function" ? deps.random : () => Math.random();
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

  /** 抹掉可能混进错误文案的凭据（transport 已承诺不回显，这里再兜一层）。 */
  private redact(text: string): string {
    let out = text;
    if (this.token) out = out.split(this.token).join("[REDACTED]");
    if (this.appSecret) out = out.split(this.appSecret).join("[REDACTED]");
    return out;
  }

  /** 记录最近错误（脱敏后），供 health().detail 与诊断使用。 */
  private noteError(source: "send" | "connection", text: string): void {
    this.lastError = this.redact(text);
    this.lastErrorSource = source;
  }

  /**
   * 取得可用 access_token：命中缓存（过期前 5 分钟视为过期）直接返回，
   * 否则用 AppID+Secret 换一次并缓存。
   *
   * 并发纪律：refresh 在飞时后续调用直接复用同一个 promise —— 旧实现每个
   * 并发 send 各发一次 token 请求（一轮多片结果就是 5 次鉴权，平台侧容易
   * 触发频控）。失败不缓存：promise 在 finally 清空，下一次调用会重新请求。
   * 成功回写用 `tokenVersion` 守卫，旧响应不会覆盖更新的 token。
   */
  private async ensureToken(): Promise<string> {
    if (this.token && this.nowFn() < this.tokenExpiresAt - TOKEN_REFRESH_SKEW_MS) {
      return this.token;
    }
    if (this.tokenFetch) return this.tokenFetch;

    const version = this.tokenVersion;
    const attempt = (async (): Promise<string> => {
      const request = buildAccessTokenRequest(this.appId, this.appSecret);
      const raw = await this.transport.post(
        request.endpoint,
        { "content-type": "application/json" },
        request.body,
      );
      const parsed = parseAccessTokenResponse(raw);
      if (!parsed) {
        // HTTP 200 + 业务错误码时旧实现只丢一句「未返回 access_token」，
        // 真正的 AppID 非法 / secret 过期 / 频控原因全丢；这里带出 code+message
        // （describeAccessTokenFailure 不会读凭据字段，且再过一次 redact）。
        const detail = describeAccessTokenFailure(raw);
        throw new Error(
          this.redact(
            `QQBot: getAppAccessToken 未返回 access_token${detail ? `（${detail}）` : ""}`,
          ),
        );
      }
      if (version !== this.tokenVersion) {
        // 期间已有更新的一轮刷新落库：不覆盖，返回当前最新 token。
        return this.token ?? parsed.accessToken;
      }
      this.token = parsed.accessToken;
      this.tokenExpiresAt = this.nowFn() + parsed.expiresIn * 1000;
      this.tokenVersion += 1;
      this.log("QQBot: access token refreshed");
      return parsed.accessToken;
    })();

    this.tokenFetch = attempt;
    try {
      return await attempt;
    } finally {
      // 失败必须清空（可重试）；成功也清空，后续走缓存分支。
      if (this.tokenFetch === attempt) this.tokenFetch = undefined;
    }
  }

  /**
   * 连接：换 token → 建 WebSocket → 注册消息回调与断开通知。Hello 到达后
   * 再发起握手（有可恢复会话走 Resume，否则 Identify）。
   *
   * 显式 connect 会把用户主动 close 的闸门重新打开并清空退避，初次连接失败
   * 仍原样抛给宿主（宿主负责提示/重试）；后台自动重连的失败则在内部消化。
   */
  async connect(): Promise<void> {
    this.closing = false;
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    await this.openSocket();
  }

  /**
   * 建一条新连接。调用方区分「首次 connect」与「自动重连」：前者失败向上抛，
   * 后者由 scheduleReconnect 的 catch 继续退避。
   */
  private async openSocket(): Promise<void> {
    const token = await this.ensureToken();
    // 单连接生命周期：新建前先让旧 socket 失效（抬 epoch）并关闭，避免它的
    // close 事件反过来再触发一次重连。
    this.stopHeartbeat();
    this.clearHandshakeTimeout();
    this.socketEpoch += 1;
    const previous = this.socket;
    this.socket = undefined;
    this.connected = false;
    if (previous) {
      try {
        previous.close();
      } catch {
        // 关闭旧连接失败不影响新建
      }
    }

    const epoch = this.socketEpoch;
    // 有可恢复会话时优先连 resume_gateway_url（README/官方语义：该地址专供
    // 恢复用）；字段缺失就退回默认网关，Resume 帧照样带 session/seq。
    const target = this.sessionId
      ? (this.resumeGatewayUrl ?? this.gatewayUrl)
      : this.gatewayUrl;
    const socket = await this.transport.connect(target, buildAuthHeaders(token));
    if (this.closing || epoch !== this.socketEpoch) {
      // 连接期间用户 close 或又发起了新的连接：丢弃这条迟到的 socket。
      try {
        socket.close();
      } catch {
        // ignore
      }
      return;
    }

    this.socket = socket;
    this.connected = true;
    this.awaitingHeartbeatAcks = 0;
    // 101 不等于可用：连接类错误必须留到 READY 才清（captureReady），否则
    // 「握手超时 → 重连 → 立刻把错误抹掉」会让 health 完全看不到问题。
    socket.onMessage((raw) => {
      if (epoch === this.socketEpoch) this.handleRaw(raw);
    });
    socket.onClose?.((error) => {
      if (epoch !== this.socketEpoch) return;
      this.handleDisconnect(
        error ? `连接断开：${errorText(error)}` : "连接已断开",
        "connection",
      );
    });
    // 握手超时：101 之后若一直拿不到 READY（典型：Resume 被平台静默忽略），
    // 连接会「看着活着但不干活」。这里在拿到 READY 前兜一层超时。
    this.startHandshakeTimeout(epoch);
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
        // 注意：HELLO **不**清握手超时。平台静默忽略 Resume 时连接只会收到
        // HELLO、永远没有 READY —— 若在这里清定时器，那次握手就永远悬着。
        this.startHeartbeat(
          interval !== undefined && interval > 0 ? interval : DEFAULT_HEARTBEAT_MS,
        );
        this.sendHandshake();
        break;
      }
      case QQBOT_OP.DISPATCH: {
        const seq = toFiniteNumber(raw["s"]);
        // 单调性：较小/重复 seq 是乱序重放，若覆盖基准会让心跳与 Resume 带上
        // 过期序号（平台可能拒绝或重放错误区间）。只有严格递增才推进。
        if (seq !== undefined && (this.lastSequence === null || seq > this.lastSequence)) {
          this.lastSequence = seq;
          this.lastSequenceSessionId = this.sessionId;
        }
        this.lastEventAt = this.nowFn();
        const eventType = typeof raw["t"] === "string" ? raw["t"] : "";
        // READY 携带可恢复会话信息（session_id / resume_gateway_url），必须在
        // normalize 丢弃系统事件之前抓住它。
        if (eventType === "READY") {
          // 握手真正完成：清一次性超时，已 ready 的连接绝不误杀。
          this.clearHandshakeTimeout();
          this.captureReady(raw);
        }
        const inbound = normalizeQqBotEvent(raw);
        if (!inbound) break;
        // 空 msgId 的消息无法做被动回复、也无法参与去重锚点：绝不能进任务
        // 链路（否则任务会「已受理」却永远回不了包）。丢弃必须是可观测的。
        if (!inbound.msgId) {
          this.droppedInbound += 1;
          this.log(
            `QQBot: dropped inbound event: missing msgId (t=${eventType || "unknown"}, chat=${inbound.chatId})`,
          );
          break;
        }
        // 有界 msgId 去重：同一条消息在窗口内只投递一次（resume 会重放断线
        // 区间，平台重复推送也会造成重复建任务）。计数与日志都可观测。
        const now = this.nowFn();
        const seenAt = this.seenInbound.get(inbound.msgId);
        if (seenAt !== undefined && now - seenAt < SEEN_INBOUND_TTL_MS) {
          this.duplicateInbound += 1;
          this.log(`QQBot: dropped duplicate inbound event: msgId=${inbound.msgId}`);
          break;
        }
        this.seenInbound.set(inbound.msgId, now);
        if (this.seenInbound.size > SEEN_INBOUND_LIMIT) {
          const oldest = this.seenInbound.keys().next().value;
          if (oldest !== undefined) this.seenInbound.delete(oldest);
        }
        if (!this.eventHandler) break;
        // 回调可能异步；失败只记日志，绝不让一根异常打断 socket 消息循环。
        void Promise.resolve(this.eventHandler(inbound)).catch((error: unknown) => {
          this.log(`QQBot: inbound handler failed: ${errorText(error)}`);
        });
        break;
      }
      case QQBOT_OP.HEARTBEAT:
        // 服务器也可能反向要求心跳，直接回一帧。发送失败按连接已死处理。
        try {
          this.socket?.send({ op: QQBOT_OP.HEARTBEAT, d: this.lastSequence });
        } catch (error) {
          this.handleDisconnect(`心跳发送失败：${errorText(error)}`, "connection");
        }
        break;
      case QQBOT_OP.HEARTBEAT_ACK: {
        // ACK 关联序号：陈旧 ACK（序号不在在途队列里）绝不能清零计数，否则
        // 心跳断供会被一条迟到回执长期掩盖，半开连接永不判死。
        const d = raw["d"];
        const ackSeq =
          toFiniteNumber(d) ?? (isRecord(d) ? toFiniteNumber(d["seq"] ?? d["s"]) : undefined);
        if (ackSeq !== undefined) {
          let index = this.heartbeatAckQueue.indexOf(ackSeq);
          if (index < 0) {
            // 心跳发出时尚无 Dispatch 序号（d=null）：ACK 带回的序号视为对
            // 最早那次心跳的回执（平台首包常见形态）。
            index = this.heartbeatAckQueue.indexOf(null);
          }
          if (index >= 0) this.heartbeatAckQueue.splice(index, 1);
          // index < 0 → 陈旧 ACK，忽略，awaitingHeartbeatAcks 保持不变。
        } else if (this.heartbeatAckQueue.length > 0) {
          // 平台 ACK 不带序号：按 FIFO 认领最早一次心跳（兼容旧行为）。
          this.heartbeatAckQueue.shift();
        }
        this.awaitingHeartbeatAcks = this.heartbeatAckQueue.length;
        break;
      }
      case QQBOT_OP.RECONNECT:
        // 服务端明确要求重连：立即断开并重连，不等底层 close 或心跳看门狗
        // （最坏约两个心跳周期），否则半开连接期间的消息会静默丢失。
        this.handleDisconnect("服务端要求重连（op=7）", "connection");
        break;
      case QQBOT_OP.INVALID_SESSION: {
        // op=9：会话已被平台判死。不可恢复时立即作废会话与序号，使下一轮重连
        // 退回 Identify 且不携带旧会话 seq；平台声明可恢复（d.resumable=true）
        // 时保留两者，让重连先尝试 Resume。无论哪种都**立即**重连。
        const payload = raw["d"];
        const resumable =
          payload === true ||
          (isRecord(payload) &&
            (payload["resumable"] === true || toFiniteNumber(payload["resumable"]) === 1));
        const hadSession = this.sessionId !== undefined;
        if (!resumable) {
          this.sessionId = undefined;
          this.resumeGatewayUrl = undefined;
          this.lastSequence = null;
          this.lastSequenceSessionId = undefined;
          if (hadSession) {
            this.missedWindowNotice = "断线区间可能丢消息（会话已失效，无法 resume）";
          }
        }
        this.handleDisconnect(
          resumable
            ? "会话失效（op=9，平台允许 resume，立即重连）"
            : "会话已失效（op=9 invalid session，立即重连）",
          "connection",
        );
        break;
      }
      default:
        break;
    }
  }

  /**
   * Hello 之后发起握手：有可恢复会话发 Resume（op=6），否则發普通 Identify。
   *
   * 任一帧发送抛错都按连接不可用处理（主动断开 + 退避重连），绝不把异常抛回
   * socket 的消息循环。
   */
  private sendHandshake(): void {
    try {
      if (this.sessionId && this.token) {
        this.handshake = "resume";
        // 序号必须属于当前会话：Identify 新建会话 / op=9 作废后 lastSequence
        // 已清零，这里再按归属会话校验一层，绝不携带上一个会话的 seq。
        const seq =
          this.lastSequence !== null && this.lastSequenceSessionId === this.sessionId
            ? this.lastSequence
            : 0;
        this.socket?.send({
          op: QQBOT_OP.RESUME,
          d: {
            token: buildAuthHeaders(this.token)["Authorization"],
            session_id: this.sessionId,
            seq,
          },
        });
        this.log("QQBot: resume sent");
        return;
      }
      this.handshake = "identify";
      this.sendIdentify();
    } catch (error) {
      this.handleDisconnect(`鉴权帧发送失败：${errorText(error)}`, "connection");
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

  /**
   * READY：抓 session_id / resume_gateway_url，并结算上一次断线的缺口语义。
   *
   * - Resume 成功：平台会重放断线期间的事件，缺口提示清除。
   * - 断线后退回 Identify（没有 session、resume 被拒）：留下可见的
   *   「断线区间可能丢消息」提示，绝不宣称消息已恢复。
   */
  private captureReady(raw: unknown): void {
    const frame = isRecord(raw) ? raw : {};
    const d = isRecord(frame["d"]) ? frame["d"] : {};
    const sessionId = d["session_id"] ?? d["sessionId"];
    // 无条件刷新：READY 缺 session_id 时必须清掉旧值，否则断线后会拿一个
    // 已被平台作废的 session_id 去 Resume（静默失败/死循环）。
    this.sessionId = typeof sessionId === "string" && sessionId ? sessionId : undefined;
    const resumeUrl = d["resume_gateway_url"] ?? d["resumeGatewayUrl"];
    this.resumeGatewayUrl = typeof resumeUrl === "string" && resumeUrl ? resumeUrl : undefined;
    this.lastSequenceSessionId = this.sessionId;
    this.heartbeatAckQueue.length = 0;
    this.awaitingHeartbeatAcks = 0;

    if (this.handshake === "identify") {
      // 新建会话：旧会话的 lastSequence 不能带进心跳 / 下一次 Resume。
      this.lastSequence = null;
    }
    if (this.handshake === "resume") {
      this.missedWindowNotice = undefined;
    } else if (this.disconnectedSinceReady) {
      this.missedWindowNotice = "断线区间可能丢消息（未使用 resume 恢复旧会话）";
    }
    this.disconnectedSinceReady = false;
    this.reconnectAttempts = 0;
    // 真正连上了：这是唯一的重置点 —— 连续失败次数与判死原因都清空，
    // 退避下次从头算；连接类 lastError 也在这里清（101 不算连上）。
    this.consecutiveFailures = 0;
    this.lastDeathReason = undefined;
    if (this.lastErrorSource !== "send") {
      this.lastError = undefined;
      this.lastErrorSource = undefined;
    }
    this.log("QQBot: ready");
  }

  private sendHeartbeat(): void {
    if (!this.socket) return;
    this.socket.send({ op: QQBOT_OP.HEARTBEAT, d: this.lastSequence });
    // 记录发出时的序号，ACK 到达时按序号认领（而不是无条件清零）。
    this.heartbeatAckQueue.push(this.lastSequence);
    this.awaitingHeartbeatAcks = this.heartbeatAckQueue.length;
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatIntervalMs = intervalMs;
    this.awaitingHeartbeatAcks = 0;
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), intervalMs);
    // 心跳定时器不应阻止进程退出。
    this.heartbeatTimer.unref?.();
  }

  /** 一个心跳周期：ACK 断供或发送抛错都走「断开 + 退避重连」，绝不穿透定时器。 */
  private heartbeatTick(): void {
    if (!this.socket || this.closing) return;
    if (this.awaitingHeartbeatAcks >= this.heartbeatMaxMissedAcks) {
      this.handleDisconnect(
        `心跳 ACK 超时（${this.heartbeatIntervalMs}ms × ${this.heartbeatMaxMissedAcks}）`,
        "connection",
      );
      return;
    }
    try {
      this.sendHeartbeat();
    } catch (error) {
      // 关键修复：旧实现的 send 抛错会打断 setInterval 回调，此后心跳与 ACK
      // 检测都不再运行，连接「看着活着实际已死」且永不重连。
      this.handleDisconnect(`心跳发送失败：${errorText(error)}`, "connection");
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.heartbeatAckQueue.length = 0;
    this.awaitingHeartbeatAcks = 0;
  }

  /**
   * 启动一次性握手超时（仅在还没有 READY 时有效）。
   *
   * 守卫用 `epoch === this.socketEpoch`：socket 已换代的旧定时器直接作废。
   * 超时即按连接已死处理（关 socket + 记 lastError + 退避重连），避免连接
   * 「已连上但永远不干活」地挂着。
   */
  private startHandshakeTimeout(epoch: number): void {
    this.clearHandshakeTimeout();
    if (!(this.handshakeTimeoutMs > 0)) return;
    const timer = setTimeout(() => {
      if (this.handshakeTimer !== timer) return;
      this.handshakeTimer = undefined;
      if (this.closing || epoch !== this.socketEpoch || !this.socket) return;
      this.handleDisconnect(
        `握手超时（${this.handshakeTimeoutMs}ms 内未收到 READY）`,
        "connection",
      );
    }, this.handshakeTimeoutMs);
    timer.unref?.();
    this.handshakeTimer = timer;
  }

  private clearHandshakeTimeout(): void {
    if (this.handshakeTimer !== undefined) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  /**
   * 断线统一出口：停心跳、让旧 socket 失效并关闭、记录可观测错误、安排退避
   * 重连。幂等（关闭触发的二次调用只会看到已清空的 socket）。
   */
  private handleDisconnect(reason: string, source: "send" | "connection"): void {
    if (this.closing) return;
    const hadSocket = this.socket !== undefined;
    this.clearHandshakeTimeout();
    this.stopHeartbeat();
    this.socketEpoch += 1;
    const socket = this.socket;
    this.socket = undefined;
    this.connected = false;
    if (socket) {
      try {
        socket.close();
      } catch {
        // 关闭失败不影响重连
      }
    }
    // 震荡记账：连续失败次数只由 READY 清零（见 captureReady），退避据此
    // 递增，绝不因为「又建上了一条 101」就退回 1s 重连。
    this.consecutiveFailures += 1;
    this.lastDeathReason = reason;
    this.noteError(source, reason);
    this.log(`QQBot: disconnected: ${this.redact(reason)}`);
    // 本次断线若最终退回 Identify（没有会话 / resume 被拒），断线区间就是真实
    // 的消息缺口，由下一次 READY 结算成可见提示（不静默宣称已恢复）。
    this.disconnectedSinceReady = true;
    if (hadSocket || this.sessionId) this.scheduleReconnect();
  }

  /**
   * 指数退避重连 + equal jitter（1s 起、双倍增长、封顶 30s）；用户 close 后
   * 不再排队。抖动让多实例同时断线时不会在同一毫秒集体重连（惊群）。
   */
  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer !== undefined) return;
    this.reconnectAttempts += 1;
    // 退避基数按**连续失败次数**算（READY 才清零）：反复判死时单调增长，
    // 不会因为「这次 TCP 又连上了」而重置到 1s，避免重连风暴。
    const failures = Math.max(1, this.consecutiveFailures);
    const fullDelay = Math.min(
      this.reconnectBaseDelayMs * 2 ** (failures - 1),
      this.reconnectMaxDelayMs,
    );
    // equal jitter：延迟落在 [fullDelay/2, fullDelay]，上限仍为 reconnectMaxDelayMs。
    const jitter = Math.min(1, Math.max(0, this.randomFn()));
    const delay = Math.min(
      Math.floor(fullDelay / 2 + jitter * (fullDelay / 2)),
      this.reconnectMaxDelayMs,
    );
    this.log(`QQBot: reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closing) return;
      if (this.reconnectAttempts > RESUME_MAX_ATTEMPTS && this.sessionId) {
        // resume 地址/会话连续重试仍不可用：放弃恢复，回默认网关新建会话。
        // 旧会话断线后的事件无法再补发，必须把缺口留在可见状态上；序号属于
        // 旧会话，一并作废，绝不能带进新的 Identify 会话。
        this.log("QQBot: resume retries exhausted, falling back to identify");
        this.sessionId = undefined;
        this.resumeGatewayUrl = undefined;
        this.lastSequence = null;
        this.lastSequenceSessionId = undefined;
        this.missedWindowNotice = "断线区间可能丢消息（resume 多次失败，已改为新建会话）";
      }
      void this.openSocket().catch((error: unknown) => {
        const reason = `重连失败：${errorText(error)}`;
        // 不在这里推进 consecutiveFailures：断线时 handleDisconnect 已记过一次，
        // 二次累加会让单次故障跳两级退避。这里只让重连尝试继续（attempts 由
        // 下一次 scheduleReconnect 自增），并保留可观测错误。
        this.lastDeathReason = reason;
        this.noteError("connection", reason);
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /**
   * 取下一条被动回复序号（每个 msg_id 独立递增）；映射有上限，防止无限增长。
   *
   * 带 `dedupeKey` 时：同一逻辑消息的重试复用首次分配的 seq（不推进
   * replySeq）—— 平台按 `(msg_id, msg_seq)` 去重，重试是幂等的；若首次
   * 发送真的失败（平台没有记录这对键值），复用的 seq 等价于新消息，不会被
   * 平台误拒。条目过期（超 {@link QqBotAdapter.DEDUPE_TTL_MS}）后按新消息
   * 处理。
   */
  private nextReplySeq(msgId: string, dedupeKey?: string): number {
    const now = this.nowFn();
    if (dedupeKey) {
      const cached = this.dedupeSeq.get(dedupeKey);
      if (cached && cached.msgId === msgId && now - cached.at < QqBotAdapter.DEDUPE_TTL_MS) {
        return cached.seq;
      }
      // 过期或换了 msg_id（理论上同一逻辑消息不会换）都按新消息处理。
      if (cached) this.dedupeSeq.delete(dedupeKey);
    }

    const existing = this.replySeq.get(msgId);
    if (existing && now - existing.at >= QqBotAdapter.REPLY_SEQ_TTL_MS) {
      // 旧窗口早已关闭：连同 dedupe 条目一起作废再重开，避免复用旧 seq。
      this.forgetMsgSeq(msgId);
    }
    const next = (this.replySeq.get(msgId)?.seq ?? 0) + 1;
    this.replySeq.set(msgId, { seq: next, at: now });
    if (this.replySeq.size > QqBotAdapter.SEQ_MAP_LIMIT) {
      // 超限逐出最旧：必须同步作废它的 dedupe 条目 —— 只删 replySeq 会让
      // dedupeSeq 指向一个被重置的序号（下次同 msg_id 从 1 重开）。
      const oldest = this.replySeq.keys().next().value;
      if (oldest !== undefined) this.forgetMsgSeq(oldest);
    }
    if (dedupeKey) {
      this.dedupeSeq.set(dedupeKey, { seq: next, at: now, msgId });
      this.evictOldest(this.dedupeSeq, QqBotAdapter.SEQ_MAP_LIMIT);
    }
    return next;
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
      // 有 msg_id 才算被动回复，才需要 msg_seq；主动消息两者都不带。
      // dedupeKey 让同一逻辑消息的重试复用同一个 msg_seq（平台按
      // (msg_id, msg_seq) 去重，重试不会刷出重复消息）。
      const msgSeq = msg.replyToMsgId
        ? this.nextReplySeq(msg.replyToMsgId, msg.dedupeKey)
        : undefined;
      const request =
        msg.chatType === "group"
          ? buildSendGroupMsg(msg.chatId, msg.text, msg.replyToMsgId, msgSeq)
          : buildSendPrivateMsg(msg.chatId, msg.text, msg.replyToMsgId, msgSeq);
      const raw = await this.transport.post(
        request.endpoint,
        { ...buildAuthHeaders(token), "content-type": "application/json" },
        request.body,
      );
      // HTTP 200 不等于发送成功：平台可能用 `code`/`errcode` 承载拒绝。
      const failure = businessError(raw);
      if (failure) {
        const error = `QQBot: 业务错误 ${failure.code}（${failure.message}）`;
        // 发送失败也属于「最近错误」：health().detail 必须能看出发不出去。
        this.noteError("send", error);
        return {
          ok: false,
          error,
          // 语义拒绝：同样的请求重试只会得到同一份拒绝。
          retryable: false,
        };
      }
      let messageId: string | undefined;
      if (isRecord(raw)) {
        const id = raw["id"] ?? raw["msg_id"];
        if (typeof id === "string" || typeof id === "number") messageId = String(id);
      }
      // 一次成功发送证明链路已恢复：只清 send 类错误，连接类错误等连接成功。
      if (this.lastErrorSource === "send") {
        this.lastError = undefined;
        this.lastErrorSource = undefined;
      }
      return { ok: true, messageId };
    } catch (error) {
      // transport 的非 2xx 错误带 status：4xx（429 除外）是确定性拒绝，不再
      // 让上层重试（配额耗尽后每片再烧 3 轮注定失败的请求）。
      const status = errorStatus(error);
      const retryable = status === undefined ? true : !isPermanentHttpStatus(status);
      const text = errorText(error);
      this.noteError("send", `发送失败：${text}`);
      // 网络/服务端异常交给上层重试；错误文本不含凭据。
      return { ok: false, error: text, retryable };
    }
  }

  /** 关闭连接并清理心跳/重连定时器，可安全重复调用；关闭后不再自动重连。 */
  async close(): Promise<void> {
    this.closing = true;
    this.clearReconnectTimer();
    this.clearHandshakeTimeout();
    this.stopHeartbeat();
    this.socketEpoch += 1;
    const socket = this.socket;
    this.socket = undefined;
    this.connected = false;
    this.sessionId = undefined;
    this.resumeGatewayUrl = undefined;
    this.lastSequence = null;
    this.lastSequenceSessionId = undefined;
    this.heartbeatAckQueue.length = 0;
    this.seenInbound.clear();
    this.duplicateInbound = 0;
    this.disconnectedSinceReady = false;
    this.missedWindowNotice = undefined;
    this.reconnectAttempts = 0;
    this.consecutiveFailures = 0;
    this.lastDeathReason = undefined;
    if (socket) {
      try {
        socket.close();
      } catch {
        // 关闭失败也不影响本地状态
      }
    }
    this.log("QQBot: websocket closed");
  }

  /**
   * 连接态快照；detail 只含状态描述与脱敏后的最近错误，不含 token。
   *
   * 组成：连接态 + 最近错误（send/断线/op=9/心跳超时）+ 断线丢消息提示 +
   * 缺 msgId 丢弃计数 —— 前两项满足「health 永不含最近错误」的修复，后两项
   * 让静默丢失变成可观测状态，绝不宣称已恢复。
   */
  async health(): Promise<ChannelHealth> {
    const parts: string[] = [this.connected ? "qqbot websocket" : "disconnected"];
    if (this.lastError) parts.push(this.redact(this.lastError));
    // 判死原因单独带标签（可能与 lastError 同一句，成对出现也无害）。
    const deathReason = this.lastDeathReason ? this.redact(this.lastDeathReason) : undefined;
    if (deathReason) {
      parts.push(`最近断线原因：${deathReason}`);
    }
    if (this.consecutiveFailures > 0) {
      parts.push(`连续失败 ${this.consecutiveFailures} 次`);
    }
    if (this.missedWindowNotice) parts.push(this.missedWindowNotice);
    if (this.droppedInbound > 0) {
      parts.push(`已丢弃 ${this.droppedInbound} 条缺 msgId 的入站事件`);
    }
    if (this.duplicateInbound > 0) {
      parts.push(`已丢弃 ${this.duplicateInbound} 条重复入站事件`);
    }
    return {
      connected: this.connected,
      detail: parts.join("; "),
      lastEventAt: this.lastEventAt,
    };
  }
}
