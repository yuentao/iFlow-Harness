/**
 * 官方 QQBot（QQ 开放平台 / sgroup）网关协议归一化与 OpenAPI 载荷构造。
 *
 * 本文件是纯函数层：零 IO、不发起网络请求、不读 WebSocket、不写时钟以外的
 * 外部状态，可以由单测直接喂 wire payload。所有网络动作都在 adapter.ts。
 *
 * 事实来源（M0 实测 + 官方开发文档，2026-11-17）：
 *  - 网关 `wss://api.sgroup.qq.com/websocket` 握手返回 101；
 *  - access_token: `POST https://api.bot.qq.com/app/getAppAccessToken`，
 *    body `{appId, clientSecret}`，有效期 7200s，调用侧鉴权头
 *    `Authorization: QQBot <ACCESS_TOKEN>`；
 *  - 上行事件：C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE /
 *    GROUP_MESSAGE_CREATE；
 *  - 发送走 OpenAPI `/v2/users/{openid}/messages` 与
 *    `/v2/groups/{group_openid}/messages`；
 *  - 富媒体需先上传换 `file_info`（本 M2 不做上传，见 adapter 的 filePath 分支）。
 *
 * 字段形态若随平台版本漂移，只改本文件 + 测试，adapter/service 层不动。
 */

import type { InboundAttachment, InboundMessage } from "../adapter/types.js";

/** access_token 端点（M0 实测可达）。 */
export const QQBOT_ACCESS_TOKEN_ENDPOINT = "https://api.bot.qq.com/app/getAppAccessToken";
/** 官方 OpenAPI 基址（发送消息用）。 */
export const QQBOT_OPENAPI_BASE = "https://api.sgroup.qq.com";
/** 官方网关默认地址（可被 deps.gatewayUrl 覆盖，便于自签/代理环境）。 */
export const DEFAULT_QQBOT_GATEWAY_URL = "wss://api.sgroup.qq.com/websocket";

/**
 * 一条「待发送」的 OpenAPI 请求描述。adapter 负责把它交给注入的 transport，
 * 协议层只描述 endpoint / method / body，不碰鉴权头（头由 buildAuthHeaders 给出）。
 */
export interface QqBotRequestSpec {
  endpoint: string;
  method: "POST";
  body: Record<string, unknown>;
}

/** access_token 解析结果。 */
export interface QqBotAccessToken {
  accessToken: string;
  /** 有效期（秒）。平台默认 7200。 */
  expiresIn: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringOrUndefined(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** 平台时间戳：优先 ISO 8601 字符串，兼容秒/毫秒数值。失败返回 undefined。 */
function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : Math.round(value * 1000);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 1e12 ? numeric : Math.round(numeric * 1000);
  }
  return undefined;
}

/**
 * 去掉消息正文里平台插入的 @ 标记（`<@...>` / `<at ...>` / 行首或空白后的
 * `@xxx`），同时**保留段落与行结构**：单个换行照旧是换行，连续空白行压成最多
 * 一个空行，行内连续空白收敛为一个空格，首尾空白 trim。多行 `/qq task` 提示词
 * 的段落结构必须活到 shared/qq-command 的解析层，折成一行会改变语义。
 * 只判断「有没有 @」用 hasMentionMarkup，真正的 mentionsBot 由事件类型决定，
 * 不从正文猜。
 */
export function cleanQqBotContent(content: unknown): string {
  let text = toStringOrUndefined(content) ?? "";
  // 平台 XML 式 mention 标签，如 `<@123456>`、`<@!123456>`、`<at id="x">`。
  text = text.replace(/<@[^>]*>/g, " ").replace(/<at\b[^>]*>/gi, " ");
  // 纯文本 @提及：仅在行首或空白之后，避免误伤 user@example.com。
  // `m` 让 `^` 命中每一行行首，行首 `@token` 同样被剥掉。
  text = text.replace(/(^|\s)@[\p{L}\p{N}_.-]+/gmu, "$1");
  // 真实换行与字面量 \n（很多网关把换行转义后塞进 content）：统一成 LF，
  // 然后逐行收敛行内空白，最后把连续空白行压成一个空行。
  const lines = text
    .replace(/\\r\\n|\\n|\\r/g, "\n")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/gu, " ").trim());
  const out: string[] = [];
  for (const line of lines) {
    // 行首与行尾的空行丢弃，中间连续空行只留一个。
    if (line === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/** 正文里是否带显式 mention 标记（用于 GROUP_MESSAGE_CREATE 的保守判定）。 */
function hasMentionMarkup(content: unknown): boolean {
  const text = toStringOrUndefined(content) ?? "";
  return /<@[^>]*>|<at\b[^>]*>/i.test(text);
}

/** 仅写入已定义字段，避免 `{url: undefined}` 干扰调用方的 toEqual 断言。 */
function attachmentFrom(value: unknown): InboundAttachment | null {
  if (!isRecord(value)) return null;
  const contentType = toStringOrUndefined(value["content_type"]) ?? "";
  const kind: InboundAttachment["kind"] = contentType.startsWith("image/") ? "image" : "file";
  const result: InboundAttachment = { kind };
  const url = toStringOrUndefined(value["url"]);
  const fileId =
    toStringOrUndefined(value["file_uuid"]) ??
    toStringOrUndefined(value["file_info"]) ??
    toStringOrUndefined(value["file_id"]);
  const name = toStringOrUndefined(value["filename"]) ?? toStringOrUndefined(value["name"]);
  const sizeBytes = toFiniteNumber(value["size"]);
  if (url !== undefined) result.url = url;
  if (fileId !== undefined) result.fileId = fileId;
  if (name !== undefined) result.name = name;
  if (sizeBytes !== undefined) result.sizeBytes = sizeBytes;
  return result;
}

function collectAttachments(value: unknown): InboundAttachment[] {
  if (!Array.isArray(value)) return [];
  const result: InboundAttachment[] = [];
  for (const item of value) {
    const attachment = attachmentFrom(item);
    if (attachment) result.push(attachment);
  }
  return result;
}

/**
 * 把一条官方事件归一化成本项目的 InboundMessage；未知/系统事件返回 null。
 *
 * 接受两种形态：网关 Dispatch 帧 `{op:0, t, s, d}`（用 `t` + `d`），或直接把
 * `d` 载荷连事件名一起传进来 `{t, id, author, content, ...}`（无 `d` 时退回整帧）。
 * 缺字段不抛错：msgId / senderId / text 退化为 ""，时间退化为 Date.now()；
 * 但定位不到 chatId 的事件无法路由，返回 null。
 */
export function normalizeQqBotEvent(raw: unknown): InboundMessage | null {
  const frame = isRecord(raw) ? raw : null;
  if (!frame) return null;
  const eventType = toStringOrUndefined(frame["t"]) ?? toStringOrUndefined(frame["type"]);
  if (!eventType) return null;
  const data = isRecord(frame["d"]) ? frame["d"] : frame;

  let chatType: InboundMessage["chatType"];
  let mentionsBot: boolean;
  switch (eventType) {
    case "C2C_MESSAGE_CREATE":
      chatType = "private";
      // 单聊只有机器人与用户，用户消息天然 @机器人。
      mentionsBot = true;
      break;
    case "GROUP_AT_MESSAGE_CREATE":
      chatType = "group";
      mentionsBot = true;
      break;
    case "GROUP_MESSAGE_CREATE":
      chatType = "group";
      // 群普通消息只有在正文带 @标记时才算提及（无 @ 必须 false）。
      mentionsBot = hasMentionMarkup(data["content"]);
      break;
    default:
      // READY / HEARTBEAT_ACK / GUILD_* / 其它系统事件一律忽略。
      return null;
  }

  const author = isRecord(data["author"]) ? data["author"] : {};
  const senderId =
    toStringOrUndefined(author["id"]) ??
    toStringOrUndefined(author["user_openid"]) ??
    toStringOrUndefined(author["member_openid"]) ??
    toStringOrUndefined(author["unionid"]) ??
    "";
  // 群聊 chatId 用群 openid；单聊 chatId 就是发送者 openid（回复沿此 openid）。
  const chatId =
    chatType === "group"
      ? (toStringOrUndefined(data["group_id"]) ??
        toStringOrUndefined(data["group_openid"]) ??
        toStringOrUndefined(data["chat_id"]) ??
        "")
      : senderId;
  if (!chatId) return null;

  return {
    chatType,
    chatId,
    senderId,
    msgId: toStringOrUndefined(data["id"]) ?? toStringOrUndefined(data["msg_id"]) ?? "",
    text: cleanQqBotContent(data["content"]),
    mentionsBot,
    attachments: collectAttachments(data["attachments"]),
    timestamp: parseTimestamp(data["timestamp"]) ?? Date.now(),
  };
}

/** 调用侧鉴权头：`Authorization: QQBot <token>`（token 不进日志由 adapter 保证）。 */
export function buildAuthHeaders(token: string): Record<string, string> {
  return { Authorization: `QQBot ${token}` };
}

/** `POST /app/getAppAccessToken` 请求描述（凭据放 body，不放 URL/日志）。 */
export function buildAccessTokenRequest(appId: string, secret: string): QqBotRequestSpec {
  return {
    endpoint: QQBOT_ACCESS_TOKEN_ENDPOINT,
    method: "POST",
    body: { appId, clientSecret: secret },
  };
}

/** 解析 token 响应；缺 access_token 返回 null。expires_in 缺省 7200 秒。 */
export function parseAccessTokenResponse(raw: unknown): QqBotAccessToken | null {
  if (!isRecord(raw)) return null;
  const accessToken = toStringOrUndefined(raw["access_token"]);
  if (!accessToken) return null;
  const reported = toFiniteNumber(raw["expires_in"]);
  const expiresIn = reported !== undefined && reported > 0 ? Math.floor(reported) : 7200;
  return { accessToken, expiresIn };
}

/**
 * 换 token 的失败诊断：平台在 HTTP 200 里回 `{code, message}` 而不是
 * `{access_token}` 时，旧实现只报「未返回 access_token」，AppID 非法 /
 * secret 过期 / 频控这些真实原因全部丢失。这里只读**诊断字段**
 * （code / errcode / retcode + message / msg / errmsg / error），
 * 绝不读取 access_token / clientSecret 一类凭据字段。
 *
 * 返回 undefined 表示响应体里没有任何可用诊断（调用方仍报通用错误）。
 */
export function describeAccessTokenFailure(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  let code: number | undefined;
  for (const key of ["code", "errcode", "retcode"] as const) {
    const value = toFiniteNumber(raw[key]);
    // 0 是成功码；走到这里通常已经缺 access_token，没必要把它当诊断。
    if (value !== undefined && value !== 0) {
      code = value;
      break;
    }
  }
  let message = "";
  for (const key of ["message", "msg", "errmsg", "error"] as const) {
    const value = raw[key];
    if (typeof value === "string" && value.trim() !== "") {
      message = value.trim();
      break;
    }
  }
  if (code === undefined && message === "") return undefined;
  if (code !== undefined && message !== "") return `code ${code}: ${message}`;
  if (code !== undefined) return `code ${code}`;
  return message;
}

/**
 * 单聊发送：`POST /v2/users/{openid}/messages`。
 *
 * `msg_id` 用于被动回复；`msg_seq` 是**同一 msg_id 的回复序号** —— QQ 用
 * `(msg_id, msg_seq)` 去重，不填时每条回复都被当成序号 1，于是同一条用户
 * 消息的第 2 条及以后的回复会被平台当作重复消息丢弃（实测：只有「已受理」
 * 送达，结果回包一条都收不到）。因此调用方必须为同一 msg_id 递增 seq。
 */
export function buildSendPrivateMsg(
  openid: string,
  text: string,
  msgId?: string,
  msgSeq?: number,
): QqBotRequestSpec {
  const body: Record<string, unknown> = { content: text };
  if (msgId) body["msg_id"] = msgId;
  if (typeof msgSeq === "number" && Number.isFinite(msgSeq) && msgSeq > 0) {
    body["msg_seq"] = Math.floor(msgSeq);
  }
  return {
    endpoint: `${QQBOT_OPENAPI_BASE}/v2/users/${encodeURIComponent(openid)}/messages`,
    method: "POST",
    body,
  };
}

/** 群聊发送：`POST /v2/groups/{group_openid}/messages`。msg_seq 语义同单聊。 */
export function buildSendGroupMsg(
  groupId: string,
  text: string,
  msgId?: string,
  msgSeq?: number,
): QqBotRequestSpec {
  const body: Record<string, unknown> = { content: text };
  if (msgId) body["msg_id"] = msgId;
  if (typeof msgSeq === "number" && Number.isFinite(msgSeq) && msgSeq > 0) {
    body["msg_seq"] = Math.floor(msgSeq);
  }
  return {
    endpoint: `${QQBOT_OPENAPI_BASE}/v2/groups/${encodeURIComponent(groupId)}/messages`,
    method: "POST",
    body,
  };
}
