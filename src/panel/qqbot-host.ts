/**
 * QQBot 官方路线的宿主侧编排辅助（M3-C，纯逻辑 / 可注入 / 可单测）。
 *
 * 职责边界：
 *  - 把「构造 QQBot 官方通道」做成纯工厂：构造官方 QqBotAdapter 并用
 *    `setEventCallback` 把入站消息接进 QqService.handleInboundMessage
 *    （M2 的事件出口就是这道接缝）。已收敛到 QQBot 单一路径，无 onebot 分流。
 *  - 把「扫码绑定」的零件（协议 / 会话 / 回调 → webview 消息 / 凭据落盘）
 *    做成纯函数，panel 只负责调用与生命周期。
 *  - 本模块不 import vscode、不碰 panel 私有状态、不 spawn 进程。
 *
 * 安全纪律：
 *  - appId / appSecret 只写 SecretStorage：appSecret 用已有的
 *    `QQ_SECRET_KEYS.appSecret`，appId 用本模块的 `QQBOT_APP_ID_SECRET_KEY`
 *    （不复用 endpoint —— 那是 OneBot HTTP 地址字段，塞应用 id 会让配置语义
 *    混乱且被 validateQqConfig 当成 URL 校验）。
 *  - 失败文案过 `redactSecrets` 再推 webview；本模块没有任何 console/log 调用。
 *  - 二维码 data URL 复用 shared 的 `isQrDataUrl` 护栏（严格 PNG + base64）。
 */

import { deflateSync } from "node:zlib";
import { isQrDataUrl, type HostToWebview } from "../../shared/messages.js";
import type { InboundMessage, OutboundMessage, SendResult } from "../qq/adapter/types.js";
import { QQ_SECRET_KEYS } from "../qq/config.js";
import { QqBotAdapter, type QqBotEventHandler } from "../qq/qqbot/adapter.js";
import {
  QqBotBindSession,
  type QqBotCredentials,
  type QqBotQrProtocolLike as BindProtocolLike,
  type QrProgressPhase,
} from "../qq/qqbot/bind.js";
import { QqBotQrProtocol, createNodeCrypto, createNodeHttp, redactSecrets } from "../qq/qqbot/protocol-client.js";
import type { QqBotCrypto, QqBotHttp } from "../qq/qqbot/protocol-client.js";
import { createNodeQqBotTransport } from "../qq/qqbot/ws-transport.js";
import type { QqServiceDeliverInput } from "../qq/service.js";

// ---------------------------------------------------------------------------
// webview 消息形状与阶段映射（自 qq-managed-host 迁入；QQBot 单一路径不再
// 依赖 OneBot 托管模块。原模块保留这些定义的副本供其自身测试，下一阶段随
// OneBot 死代码一起删除。）
// ---------------------------------------------------------------------------

/** HostToWebview 的托管进度消息形状（从协议取，避免两侧漂移）。 */
export type ManagedStatusMessage = Extract<HostToWebview, { type: "qqManagedStatus" }>;
/** HostToWebview 的扫码消息形状。 */
export type QrLoginMessage = Extract<HostToWebview, { type: "qqLoginQr" }>;

/** 去掉文本里所有 token 出现（manager 已脱敏，这里再兜一层）。 */
function redactManagedToken(text: string, token: string | undefined): string {
  if (!token) return text;
  return text.split(token).join("[REDACTED]");
}

/**
 * manager 阶段快照 → qqManagedStatus 消息。
 * phase 直接透传；message 过 token 脱敏；progress 仅在数值时携带。
 */
export function toManagedStatusMessage(
  status: { phase: ManagedStatusMessage["phase"]; message: string; progress?: number },
  token?: string,
): ManagedStatusMessage {
  const out: ManagedStatusMessage = {
    type: "qqManagedStatus",
    phase: status.phase,
    message: redactManagedToken(status.message, token),
  };
  if (typeof status.progress === "number") out.progress = status.progress;
  return out;
}

/** 取消扫码 / 登录结束后的清屏帧（dataUrl 空、phase=expired）。 */
export function buildClearedQrMessage(now: number): QrLoginMessage {
  return { type: "qqLoginQr", dataUrl: "", expiresAt: now, phase: "expired" };
}

// ---------------------------------------------------------------------------
// 凭据存储
// ---------------------------------------------------------------------------

/**
 * appId 在 SecretStorage 里的键名。
 *
 * `QQ_SECRET_KEYS` 没有 appId 键，而 endpoint 是 OneBot HTTP 基地址（会被
 * validateQqConfig 当 URL 校验），两者都不适合塞应用 id —— 因此在本模块
 * 单独声明一个点分段键，与现有键风格一致。
 */
export const QQBOT_APP_ID_SECRET_KEY = "iflow.qq.app-id";

/** 凭据读写只需 SecretStorage 的最小面（panel 的 QqSettingsIo 天然满足）。 */
export interface QqBotCredentialIo {
  getSecret(key: string): Promise<string | undefined>;
  setSecret(key: string, value: string): Promise<void>;
}

export interface QqBotStoredCredentials {
  appId: string;
  appSecret: string;
  userOpenid?: string;
}

/** 扫码成功 → 凭据落盘。凭据不完整时抛错，绝不写半截。 */
export async function storeQqBotCredentials(
  io: QqBotCredentialIo,
  creds: QqBotCredentials,
): Promise<void> {
  const appId = typeof creds.appId === "string" ? creds.appId.trim() : "";
  const appSecret = typeof creds.appSecret === "string" ? creds.appSecret.trim() : "";
  if (!appId || !appSecret) throw new Error("扫码返回的凭据不完整");
  await io.setSecret(QQBOT_APP_ID_SECRET_KEY, appId);
  await io.setSecret(QQ_SECRET_KEYS.appSecret, appSecret);
}

/** 常规启动时读取已绑定凭据；任一缺失返回 null（提示用户先扫码绑定）。 */
export async function readQqBotCredentials(
  io: QqBotCredentialIo,
): Promise<QqBotStoredCredentials | null> {
  const [appId, appSecret] = await Promise.all([
    io.getSecret(QQBOT_APP_ID_SECRET_KEY),
    io.getSecret(QQ_SECRET_KEYS.appSecret),
  ]);
  if (typeof appId !== "string" || appId.trim().length === 0) return null;
  if (typeof appSecret !== "string" || appSecret.trim().length === 0) return null;
  return { appId: appId.trim(), appSecret: appSecret.trim() };
}

// ---------------------------------------------------------------------------
// adapter 分流 / 出站
// ---------------------------------------------------------------------------

/**
 * 分流结果：单一路径恒走 QQBot 官方 adapter。
 *
 * 保留 `kind` 判别字段是为了兼容既有调用点（panel 侧曾按 kind 分支），
 * 收敛到 QQBot 单一路径后它恒为 `"qqbot"`。
 */
export type QqChannelDispatch = { kind: "qqbot"; adapter: QqBotAdapter };

/** QqBotAdapter 鸭子类型（便于测试注入假实现）。 */
export type QqBotAdapterLike = QqBotAdapter;

/** adapter 构造入参（与 QqBotAdapterDeps 同形，另外把 log 暴露给宿主）。 */
export interface QqBotAdapterFactoryDeps {
  appId: string;
  appSecret: string;
  transport: ReturnType<typeof createNodeQqBotTransport>;
  gatewayUrl?: string;
  log?: (line: string) => void;
}

export interface QqChannelDispatchDeps {
  appId: string;
  appSecret: string;
  /** 入站消息出口：panel 接到 service.handleInboundMessage。 */
  onInbound: (msg: InboundMessage) => void | Promise<void>;
  transport?: ReturnType<typeof createNodeQqBotTransport>;
  adapterFactory?: (deps: QqBotAdapterFactoryDeps) => QqBotAdapterLike;
  gatewayUrl?: string;
  log?: (line: string) => void;
}

/**
 * 构造 QQBot 官方 adapter 通道（QQBot 单一路径）。
 *
 * 保留 `config` 入参仅为兼容既有调用点签名，不再按 config.adapter 分流。
 * 构造出 adapter 后立刻用 `setEventCallback` 接上入站出口 —— 这是 M2 唯一
 * 的事件接缝，不能改用轮询或旁路调用。
 */
export function createQqChannelDispatch(
  _config: { adapter: string },
  deps: QqChannelDispatchDeps,
): QqChannelDispatch {
  const transport = deps.transport ?? createNodeQqBotTransport();
  const args: QqBotAdapterFactoryDeps = {
    appId: deps.appId,
    appSecret: deps.appSecret,
    transport,
    ...(deps.gatewayUrl ? { gatewayUrl: deps.gatewayUrl } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  };
  const adapter = deps.adapterFactory
    ? deps.adapterFactory(args)
    : new QqBotAdapter(args);
  const handler: QqBotEventHandler = (inbound) => deps.onInbound(inbound);
  adapter.setEventCallback(handler);
  return { kind: "qqbot", adapter };
}

/** 官方 adapter 出站：把 service 的投递契约翻译成 OutboundMessage。 */
export async function deliverViaQqBotAdapter(
  adapter: Pick<QqBotAdapter, "send">,
  msg: QqServiceDeliverInput,
): Promise<boolean> {
  const out: OutboundMessage = {
    chatType: msg.chatType,
    chatId: msg.chatId,
    text: msg.text,
    ...(msg.replyToMsgId ? { replyToMsgId: msg.replyToMsgId } : {}),
  };
  const result: SendResult = await adapter.send(out);
  return result.ok;
}

// ---------------------------------------------------------------------------
// 扫码绑定会话
// ---------------------------------------------------------------------------

/** 扫码零件的注入面；缺省用 node:https / node:crypto + 内联 PNG 渲染。 */
export interface QqBotBindRuntimeDeps {
  http?: QqBotHttp;
  crypto?: QqBotCrypto;
  renderQr?: (url: string) => Promise<string>;
  now?: () => number;
  source?: string;
  log?: (line: string) => void;
  /** 测试注入假协议（避免真网络），签名与 QqBotQrProtocol.start 一致。 */
  protocolFactory?: (opts: {
    http: QqBotHttp;
    crypto: QqBotCrypto;
    renderQr: (url: string) => Promise<string>;
    source?: string;
    log?: (line: string) => void;
  }) => BindProtocolLike;
}

export interface QqBotBindRuntime {
  protocol: BindProtocolLike;
  session: QqBotBindSession;
}

/** 构造 QqBotQrProtocol + QqBotBindSession（M3-A 协议优先，SDK 分支留空）。 */
export function createQqBotBindRuntime(deps: QqBotBindRuntimeDeps = {}): QqBotBindRuntime {
  const http = deps.http ?? createNodeHttp();
  const crypto = deps.crypto ?? createNodeCrypto();
  const renderQr = deps.renderQr ?? renderQrPng;
  const protocol = deps.protocolFactory
    ? deps.protocolFactory({
        http,
        crypto,
        renderQr,
        ...(deps.source ? { source: deps.source } : {}),
        ...(deps.log ? { log: deps.log } : {}),
      })
    : new QqBotQrProtocol({
        http,
        crypto,
        renderQr,
        ...(deps.source ? { source: deps.source } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.log ? { log: deps.log } : {}),
      });
  // BindSession 的 SDK 分支在这里用不到（protocol 已注入），但构造签名要求
  // 两个函数：给会抛错的占位实现，万一将来有人误删 protocol 分支会显式失败，
  // 绝不静默退化成「假二维码」。
  const session = new QqBotBindSession({
    protocol,
    startQrConnect: () => {
      throw new Error("QQBot: 未注入 SDK 启动器（应走自实现扫码协议）");
    },
    renderQr,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  });
  return { protocol, session };
}

/** onQr → qqLoginQr（dataUrl 已由协议层过 isQrDataUrl 护栏）。 */
export function qrReadyMessage(dataUrl: string, expiresAt: number): QrLoginMessage {
  return { type: "qqLoginQr", dataUrl, expiresAt, phase: "waiting_scan" };
}

/** 协议阶段 → qqManagedStatus（枚举取协议允许值，绝不发明新 phase）。 */
export function qrProgressMessage(phase: QrProgressPhase): ManagedStatusMessage {
  switch (phase) {
    case "waiting_scan":
      return { type: "qqManagedStatus", phase: "waiting_login", message: "请用 QQ 扫码绑定机器人" };
    case "scanned":
      return { type: "qqManagedStatus", phase: "waiting_login", message: "已扫码，请在手机上确认" };
    case "confirmed":
      return { type: "qqManagedStatus", phase: "logged_in", message: "已确认，正在建立连接" };
  }
}

/** 失败文案 → qqManagedStatus error（再过一次脱敏 + 长度上限）。 */
export function qrFailureMessage(message: string): ManagedStatusMessage {
  const safe = redactSecrets(typeof message === "string" ? message : "扫码失败");
  return {
    type: "qqManagedStatus",
    phase: "error",
    message: safe.length > 500 ? `${safe.slice(0, 500)}…` : safe,
  };
}

/** 推给 webview 的扫码帧统一过护栏（非法 dataUrl 退化成清屏帧）。 */
export function sanitizeQrLoginMessage(msg: QrLoginMessage): QrLoginMessage {
  if (isQrDataUrl(msg.dataUrl)) return msg;
  return { ...msg, dataUrl: "", phase: "expired" };
}

/** 方便 panel 统一 post 的类型：扫码链路只会推这两种消息。 */
export type QqBotWebviewMessage = QrLoginMessage | ManagedStatusMessage;

/** 类型守卫（panel 里做收口用，避免 unknown 误投）。 */
export function isQqBotWebviewMessage(value: unknown): value is QqBotWebviewMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "qqLoginQr" || type === "qqManagedStatus";
}

// ---------------------------------------------------------------------------
// 内联 QR → PNG data URL（零新依赖）
// ---------------------------------------------------------------------------
//
// 项目 node_modules 没有 qrcode / qrcode-generator，且本波不允许改 package.json，
// 所以这里实现一份**最小但真实**的 QR 编码器（字节模式 / ECC-L / mask 0），
// 再用 node:zlib 手写 PNG（1-bit 灰度 + 4 模块静区 + 4x 放大）。产出是能扫的
// PNG，不是把 URL 塞进 dataUrl 的假渲染。算法参照 ISO/IEC 18004 标准流程。

/** 只覆盖二维码落地页这类短文本；超出容量直接报错，绝不生成残缺码。 */
const QR_MAX_VERSION = 20;
/** ECC-L 的每块校验码字数与块数（版本 1..20）。 */
const QR_ECC_PER_BLOCK_L = [
  7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28,
] as const;
const QR_BLOCKS_L = [
  1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8,
] as const;
/** 每模块渲染成 4x4 像素，手机扫起来更稳。 */
const QR_PIXEL_SCALE = 4;
/** 静区宽度（规范要求至少 4 模块）。 */
const QR_QUIET_ZONE = 4;

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/** 总码字数（data + ecc），余下不足 8 的模块是格式需要的剩余位。 */
function qrTotalCodewords(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return Math.floor(result / 8);
}

function qrDataCodewords(ver: number): number {
  const idx = ver - 1;
  return qrTotalCodewords(ver) - QR_ECC_PER_BLOCK_L[idx]! * QR_BLOCKS_L[idx]!;
}

function rsDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < degree) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (const byte of data) {
    const factor = byte ^ result[0]!;
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i += 1) {
      result[i] = result[i]! ^ gfMul(divisor[i]!, factor);
    }
  }
  return result;
}

/** 字节模式位缓冲：mode + 计数 + 数据 + 终止符 + 0xEC/0x11 交替填充。 */
function qrBuildCodewords(data: Uint8Array, ver: number): Uint8Array {
  const bits: number[] = [];
  const push = (value: number, len: number): void => {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  const capacityBits = qrDataCodewords(ver) * 8;
  push(0b0100, 4); // byte mode
  push(data.length, ver <= 9 ? 8 : 16);
  for (const byte of data) push(byte, 8);
  push(0, Math.min(4, capacityBits - bits.length));
  // 对齐到码字边界：即使刚好落在边界，也补满 8 位 0（segno/官方规范实现
  // 的常见写法，扫描器对这种排布兼容性最好）。
  push(0, 8 - (bits.length % 8));
  let pad = 0xec;
  while (bits.length < capacityBits) {
    push(pad, 8);
    pad ^= 0xec ^ 0x11;
  }
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i += 1) {
    out[i >>> 3] = out[i >>> 3]! | (bits[i]! << (7 - (i & 7)));
  }
  return out;
}

/** 数据分块 + ECC + 交错，得到按码字流顺序排列的最终字节串。 */
function qrInterleave(data: Uint8Array, ver: number): Uint8Array {
  const blocks = QR_BLOCKS_L[ver - 1]!;
  const eccLen = QR_ECC_PER_BLOCK_L[ver - 1]!;
  const shortLen = Math.floor(data.length / blocks);
  const longCount = data.length - shortLen * blocks;
  const shortCount = blocks - longCount;

  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < blocks; i += 1) {
    const len = shortLen + (i < shortCount ? 0 : 1);
    const block = data.subarray(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    eccBlocks.push(rsRemainder(block, rsDivisor(eccLen)));
  }

  const out: number[] = [];
  for (let i = 0; i < shortLen + 1; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) out.push(block[i]!);
    }
  }
  for (let i = 0; i < eccLen; i += 1) {
    for (const block of eccBlocks) out.push(block[i]!);
  }
  return Uint8Array.from(out);
}

function qrAlignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = new Array<number>(numAlign);
  result[0] = 6;
  for (let i = numAlign - 1; i >= 1; i -= 1) {
    result[i] = ver * 4 + 10 - (numAlign - 1 - i) * step;
  }
  return result;
}

function qrFormatBits(mask: number): number {
  // ECC-L 的格式位 = 01；BCH(15,5) + 0x5412 掩码。
  const data = (1 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
}

function qrVersionBits(ver: number): number {
  let rem = ver;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return ((ver << 12) | rem) & 0x3ffff;
}

/** 生成 QR 的布尔矩阵（true = 黑模块），mask 固定为 0（规范允许的 8 种之一）。 */
function qrBuildMatrix(codewords: Uint8Array, ver: number): { modules: boolean[][]; size: number } {
  const size = ver * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean): void => {
    modules[y]![x] = dark;
    isFunction[y]![x] = true;
  };

  // 定位图形 + 分隔带（7x7 加周围一圈白），中心在 (3,3)/(size-4,3)/(3,size-4)。
  const finder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);

  // 定时图形。
  for (let i = 0; i < size; i += 1) {
    if (!isFunction[6]![i]) set(i, 6, i % 2 === 0);
    if (!isFunction[i]![6]) set(6, i, i % 2 === 0);
  }

  // 校准图形（跳过与定位图形重叠的三个角）。
  const positions = qrAlignmentPositions(ver);
  for (const y of positions) {
    for (const x of positions) {
      if (isFunction[y]![x]) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // 格式信息（占位 mask=0，末尾统一重画）与版本信息（v>=7）。
  const fmt = qrFormatBits(0);
  // Nayuki 约定 set(x, y)：格式信息的第一份在 (x=8, y=0..5)，不是 (x=0..5, y=8)。
  for (let i = 0; i <= 5; i += 1) set(8, i, ((fmt >>> i) & 1) !== 0);
  set(8, 7, ((fmt >>> 6) & 1) !== 0);
  set(8, 8, ((fmt >>> 7) & 1) !== 0);
  set(7, 8, ((fmt >>> 8) & 1) !== 0);
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, ((fmt >>> i) & 1) !== 0);
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, ((fmt >>> i) & 1) !== 0);
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, ((fmt >>> i) & 1) !== 0);
  set(8, size - 8, true); // dark module
  if (ver >= 7) {
    const vb = qrVersionBits(ver);
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      const bit = ((vb >>> i) & 1) !== 0;
      set(a, b, bit);
      set(b, a, bit);
    }
  }

  // 数据码字按 zig-zag 放入非功能位。
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    // 跳过第 6 列（竖定时图形）：把整对列从 (6,5) 挪到 (5,4)，并让后续
    // right-=2 从 3 继续 —— 只改局部 col 会让第 4 列被写两次、第 3 列漏写。
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (isFunction[y]![x] || bitIndex >= codewords.length * 8) continue;
        modules[y]![x] = ((codewords[bitIndex >>> 3]! >>> (7 - (bitIndex & 7))) & 1) !== 0;
        bitIndex += 1;
      }
    }
  }

  // mask 0：(x+y)%2==0 反转。
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!isFunction[y]![x] && (x + y) % 2 === 0) modules[y]![x] = !modules[y]![x];
    }
  }
  // mask 改变后重画格式信息（同一 mask=0，数值不变，但位置必须恢复为功能位）。
  const fmt2 = qrFormatBits(0);
  const drawFmt = (x: number, y: number, bit: number): void => {
    modules[y]![x] = ((fmt2 >>> bit) & 1) !== 0;
  };
  for (let i = 0; i <= 5; i += 1) drawFmt(8, i, i);
  drawFmt(8, 7, 6);
  drawFmt(8, 8, 7);
  drawFmt(7, 8, 8);
  for (let i = 9; i < 15; i += 1) drawFmt(14 - i, 8, i);
  for (let i = 0; i < 8; i += 1) drawFmt(size - 1 - i, 8, i);
  for (let i = 8; i < 15; i += 1) drawFmt(8, size - 15 + i, i);
  modules[size - 8]![8] = true;
  return { modules, size };
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC32_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), data.length + 8);
  return out;
}

/** 把 QR 矩阵编码成 1-bit 灰度 PNG（黑=0 白=1，MSB 优先，每行 filter=0）。 */
function qrEncodePng(modules: boolean[][], size: number): Buffer {
  const width = (size + QR_QUIET_ZONE * 2) * QR_PIXEL_SCALE;
  const rowBytes = Math.ceil(width / 8);
  const rows: Buffer[] = [];
  for (let py = 0; py < width; py += 1) {
    const row = Buffer.alloc(rowBytes + 1); // 首字节 filter type 0
    const moduleY = Math.floor(py / QR_PIXEL_SCALE) - QR_QUIET_ZONE;
    for (let px = 0; px < width; px += 1) {
      const moduleX = Math.floor(px / QR_PIXEL_SCALE) - QR_QUIET_ZONE;
      const inQr = moduleX >= 0 && moduleX < size && moduleY >= 0 && moduleY < size;
      const dark = inQr && modules[moduleY]![moduleX]!;
      if (!dark) row[1 + (px >>> 3)] = row[1 + (px >>> 3)]! | (1 << (7 - (px & 7)));
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(width, 4);
  ihdr[8] = 1; // bit depth 1
  ihdr[9] = 0; // color type: grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * `renderQr` 的真实实现：URL → 可扫描的 PNG data URL。
 *
 * 选最小可容纳的 ECC-L 版本（1..20）；超长内容报错而不是返回假二维码。
 * 产出严格满足 `data:image/png;base64,`（与 shared 的护栏一致）。
 */
export async function renderQrPng(url: string): Promise<string> {
  const payload = Buffer.from(String(url ?? ""), "utf8");
  if (payload.length === 0) throw new Error("二维码内容为空");
  let version = 0;
  for (let v = 1; v <= QR_MAX_VERSION; v += 1) {
    // 计数位 + 模式位 + 数据 + 终止位都要装得下。
    const countBits = v <= 9 ? 8 : 16;
    if (4 + countBits + payload.length * 8 <= qrDataCodewords(v) * 8) {
      version = v;
      break;
    }
  }
  if (version === 0) throw new Error("二维码内容过长，无法渲染");
  const codewords = qrInterleave(qrBuildCodewords(payload, version), version);
  const { modules, size } = qrBuildMatrix(codewords, version);
  return `data:image/png;base64,${qrEncodePng(modules, size).toString("base64")}`;
}
