/**
 * OneBot v11 wire normalization (pure functions, no I/O).
 *
 * Spec reference: OneBot v11 「消息事件」/「消息段(CQ 码)」/「HTTP API」章节
 * (https://github.com/botuniverse/onebot-11). Field shapes below were also
 * cross-checked against go-cqhttp's implementation, which is what most QQ
 * backends expose:
 *
 *   event.post_type    -> "message" (received) | "message_sent" (bot's own)
 *   event.message_type -> "private" | "group"
 *   event.message      -> CQ string OR array of {type, data} segments
 *   event.time         -> unix SECONDS
 *   event.message_id   -> number or string, echoed back by reply
 *
 * Everything here is deliberately permissive: a malformed event must not throw
 * (the caller feeds it straight from a socket reader). Unroutable events
 * (no chat id, non-message post types) return null.
 */

import type { ChatType, InboundAttachment, InboundMessage } from "./types.js";

/** Parsed CQ segment. Unknown codes are kept as `other` so nothing is lost. */
export interface CqTextSegment {
  type: "text";
  text: string;
}

export interface CqAtSegment {
  type: "at";
  /** Target QQ, or the literal "all" for @全体成员. */
  qq: string;
}

export interface CqImageSegment {
  type: "image";
  url?: string;
  /** `file` / `file_id` — platform handle, not a path. */
  fileId?: string;
}

export interface CqFileSegment {
  type: "file";
  url?: string;
  fileId?: string;
  name?: string;
  sizeBytes?: number;
}

export interface CqReplySegment {
  type: "reply";
  msgId: string;
}

export interface CqOtherSegment {
  type: "other";
  /** Original CQ code name / segment type (face, record, forward, …). */
  code: string;
  params: Record<string, string>;
}

export type CqSegment =
  | CqTextSegment
  | CqAtSegment
  | CqImageSegment
  | CqFileSegment
  | CqReplySegment
  | CqOtherSegment;

/** Shape POSTed to the OneBot v11 HTTP API. */
export interface OneBotAction {
  action: string;
  params: Record<string, unknown>;
}

/** Options accepted by {@link buildSendGroupMsg}. */
export interface GroupSendOptions {
  /**
   * OneBot `auto_escape`: when true the backend delivers `message` verbatim
   * instead of parsing CQ codes in it. Omitted from params when not set so the
   * backend default applies.
   */
  autoEscape?: boolean;
}

/** Decode the CQ parameter escapes defined by OneBot v11. */
function decodeCqValue(value: string): string {
  // Order matters: `&amp;` is decoded last so `&amp;#44;` stays a literal
  // `&#44;` instead of turning into a comma.
  return value
    .replace(/&#44;/g, ",")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&amp;/g, "&");
}

/** Encode one value for use inside a CQ code (inverse of {@link decodeCqValue}). */
export function escapeCqValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/,/g, "&#44;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;");
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

function parseCqParams(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (!raw) return params;
  for (const pair of raw.split(",")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq);
    params[key] = decodeCqValue(pair.slice(eq + 1));
  }
  return params;
}

function segmentFromCqCode(code: string, params: Record<string, string>): CqSegment {
  switch (code) {
    case "text":
      // `[CQ:text,text=…]` is legal though rare (strings usually carry text raw).
      return { type: "text", text: params["text"] ?? "" };
    case "at":
      return { type: "at", qq: params["qq"] ?? "" };
    case "image":
      return { type: "image", url: params["url"], fileId: params["file"] ?? params["file_id"] };
    case "file":
      return {
        type: "file",
        url: params["url"],
        fileId: params["file"] ?? params["file_id"],
        name: params["name"],
        sizeBytes: toFiniteNumber(params["file_size"]) ?? toFiniteNumber(params["size"]),
      };
    case "reply":
      return { type: "reply", msgId: params["id"] ?? "" };
    default:
      return { type: "other", code, params };
  }
}

function segmentFromArrayItem(item: unknown): CqSegment | null {
  if (!isRecord(item)) return null;
  const code = item["type"];
  if (typeof code !== "string") return null;
  const data = isRecord(item["data"]) ? item["data"] : {};
  if (code === "text") {
    return { type: "text", text: toStringOrUndefined(data["text"]) ?? "" };
  }
  if (code === "at") {
    return { type: "at", qq: toStringOrUndefined(data["qq"]) ?? "" };
  }
  if (code === "image") {
    return {
      type: "image",
      url: toStringOrUndefined(data["url"]),
      fileId: toStringOrUndefined(data["file"]) ?? toStringOrUndefined(data["file_id"]),
    };
  }
  if (code === "file") {
    return {
      type: "file",
      url: toStringOrUndefined(data["url"]),
      fileId: toStringOrUndefined(data["file"]) ?? toStringOrUndefined(data["file_id"]),
      name: toStringOrUndefined(data["name"]),
      sizeBytes: toFiniteNumber(data["file_size"]) ?? toFiniteNumber(data["size"]),
    };
  }
  if (code === "reply") {
    return { type: "reply", msgId: toStringOrUndefined(data["id"]) ?? "" };
  }
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    const text = toStringOrUndefined(value);
    if (text !== undefined) params[key] = text;
  }
  return { type: "other", code, params };
}

/**
 * Parse a CQ-coded string into segments.
 *
 * Text between codes becomes `text` segments; `[CQ:at,qq=…]` covers both the
 * string form and (via {@link normalizeOneBotEvent}) the segment-array form, so
 * mention detection has exactly one code path.
 */
export function parseCqCodes(input: string): CqSegment[] {
  const segments: CqSegment[] = [];
  // A literal `]` always terminates a CQ code (brackets are escaped inside
  // values), so `[^\]]*` is safe for the parameter tail.
  const pattern = /\[CQ:([A-Za-z0-9_.-]+)((?:,[^\]]*)?)\]/g;
  let cursor = 0;
  for (;;) {
    const match = pattern.exec(input);
    if (!match) break;
    const index = match.index;
    if (index > cursor) {
      segments.push({ type: "text", text: input.slice(cursor, index) });
    }
    const code = match[1] ?? "";
    const rest = match[2] ?? "";
    segments.push(segmentFromCqCode(code, parseCqParams(rest.startsWith(",") ? rest.slice(1) : rest)));
    cursor = index + match[0].length;
  }
  if (cursor < input.length) {
    segments.push({ type: "text", text: input.slice(cursor) });
  }
  return segments;
}

/** Accept either wire form of `event.message` and produce segments. */
export function parseMessageContent(message: unknown): CqSegment[] {
  if (typeof message === "string") return parseCqCodes(message);
  if (Array.isArray(message)) {
    const segments: CqSegment[] = [];
    for (const item of message) {
      const segment = segmentFromArrayItem(item);
      if (segment) segments.push(segment);
    }
    return segments;
  }
  return [];
}

function collectAttachments(segments: CqSegment[]): InboundAttachment[] {
  const attachments: InboundAttachment[] = [];
  for (const segment of segments) {
    if (segment.type === "image") {
      attachments.push({ kind: "image", url: segment.url, fileId: segment.fileId });
    } else if (segment.type === "file") {
      attachments.push({
        kind: "file",
        url: segment.url,
        fileId: segment.fileId,
        name: segment.name,
        sizeBytes: segment.sizeBytes,
      });
    }
  }
  return attachments;
}

function collectText(segments: CqSegment[]): string {
  let text = "";
  for (const segment of segments) {
    if (segment.type === "text") text += segment.text;
  }
  return text.trim();
}

function mentionsSelf(segments: CqSegment[], selfId: string): boolean {
  if (!selfId) return false;
  for (const segment of segments) {
    if (segment.type === "at" && segment.qq === selfId) return true;
  }
  return false;
}

/**
 * Normalize one OneBot v11 event into {@link InboundMessage}.
 *
 * Returns null for anything that is not a routable message event: notices,
 * meta events, friend requests, unsupported `message_type`s, and messages with
 * no derivable chat id. Missing secondary fields (message id, sender, time)
 * degrade to `""` / `Date.now()` rather than throwing.
 */
export function normalizeOneBotEvent(raw: unknown, opts: { selfId: string }): InboundMessage | null {
  if (!isRecord(raw)) return null;
  const postType = raw["post_type"];
  if (postType !== "message" && postType !== "message_sent") return null;

  const messageType = raw["message_type"];
  if (messageType !== "private" && messageType !== "group") return null;
  const chatType: ChatType = messageType;

  // `message_sent` reports the bot as sender: for those events the chat is
  // `target_id` (private) / `group_id` (group), while `user_id` is the bot.
  const chatId =
    chatType === "group"
      ? toStringOrUndefined(raw["group_id"]) ?? toStringOrUndefined(raw["target_id"])
      : toStringOrUndefined(raw["target_id"]) ?? toStringOrUndefined(raw["user_id"]);
  if (!chatId) return null;

  const sender = isRecord(raw["sender"]) ? raw["sender"] : {};
  const senderId = toStringOrUndefined(sender["user_id"]) ?? toStringOrUndefined(raw["user_id"]) ?? "";

  const segments = parseMessageContent(raw["message"] ?? raw["raw_message"]);
  const timeSeconds = toFiniteNumber(raw["time"]);

  return {
    chatType,
    chatId,
    senderId,
    msgId: toStringOrUndefined(raw["message_id"]) ?? "",
    text: collectText(segments),
    mentionsBot: mentionsSelf(segments, opts.selfId),
    attachments: collectAttachments(segments),
    // OneBot reports unix seconds; the rest of the host works in milliseconds.
    timestamp: timeSeconds !== undefined ? Math.round(timeSeconds * 1000) : Date.now(),
  };
}

/**
 * `send_private_msg` action. `user_id` is a string here; OneBot accepts both
 * string and number, and strings avoid QQ-number precision surprises.
 */
export function buildSendPrivateMsg(chatId: string, text: string): OneBotAction {
  return { action: "send_private_msg", params: { user_id: chatId, message: text } };
}

/** `send_group_msg` action. */
export function buildSendGroupMsg(chatId: string, text: string, opts: GroupSendOptions = {}): OneBotAction {
  const params: Record<string, unknown> = { group_id: chatId, message: text };
  if (opts.autoEscape !== undefined) params["auto_escape"] = opts.autoEscape;
  return { action: "send_group_msg", params };
}

/**
 * Build a quote-reply action: OneBot quotes by prefixing `[CQ:reply,id=…]` to
 * the message body. The id is escaped so a hostile value cannot inject codes.
 */
export function buildReplyPayload(
  chatId: string,
  text: string,
  replyToMsgId: string,
  chatType: ChatType,
): OneBotAction {
  const message = `[CQ:reply,id=${escapeCqValue(replyToMsgId)}]${text}`;
  return chatType === "group" ? buildSendGroupMsg(chatId, message) : buildSendPrivateMsg(chatId, message);
}
