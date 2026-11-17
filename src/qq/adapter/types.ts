/**
 * Platform-neutral ports for the QQ channel.
 *
 * Everything in `src/qq/adapter/` is transport-only: it converts wire payloads
 * into these shapes and back, and never imports `vscode` (so it stays unit
 * testable). The bridge/service layers above own scheduling, chunking and
 * retries; this file only fixes the contract they program against.
 */

/** The two chat kinds the adapter handles: private chat and group chat. */
export type ChatType = "private" | "group";

/**
 * An attachment carried by an inbound message.
 *
 * The platform may expose either a download URL or an opaque file id; both
 * fields are optional because neither is guaranteed.
 */
export interface InboundAttachment {
  kind: "image" | "file";
  /** Direct download URL when the platform exposes one. */
  url?: string;
  /** Opaque platform file identifier. */
  fileId?: string;
  /** Original file name when known. */
  name?: string;
  /** Size in bytes when the platform reports it. */
  sizeBytes?: number;
}

/** A normalized inbound chat message (QQBot's unified message shape). */
export interface InboundMessage {
  chatType: ChatType;
  /** Private: sender QQ. Group: group number. Always a decimal string. */
  chatId: string;
  /** Author of the message (QQ number). */
  senderId: string;
  /** Platform message id, used for replies and de-duplication. */
  msgId: string;
  /** Plain text with media segments (at/image/file/reply) stripped out. */
  text: string;
  /** True when the bot itself was @-mentioned. */
  mentionsBot: boolean;
  attachments: InboundAttachment[];
  /** Milliseconds since epoch (normalized on ingest). */
  timestamp: number;
}

/** A message the host wants to deliver to a chat. */
export interface OutboundMessage {
  chatType: ChatType;
  chatId: string;
  text: string;
  /** Quote-reply target; the adapter expresses it in the platform's reply segment. */
  replyToMsgId?: string;
  /**
   * Local file to upload instead of (or in addition to) text. Upload support is
   * a later milestone — the port is declared now so callers can be written
   * against it, and implementations must fail with `retryable: false`.
   */
  filePath?: string;
}

/**
 * Outcome of one send attempt. `retryable` lets the caller decide whether to
 * re-queue: 4xx and protocol rejections are final, 5xx and network failures
 * are worth another try.
 */
export type SendResult =
  | { ok: true; messageId?: string }
  | { ok: false; error: string; retryable: boolean };

/** Snapshot of the channel's liveness, for the status surface. */
export interface ChannelHealth {
  connected: boolean;
  /** Human-readable detail (last error, connection mode, …). */
  detail?: string;
  /** Milliseconds since epoch of the last inbound event. */
  lastEventAt?: number;
}

/**
 * What the bridge/service programs against. Implementations are free to talk
 * to a WebSocket reverse connection, an HTTP API or a fake in tests.
 */
export interface ChannelAdapter {
  connect(): Promise<void>;
  close(): Promise<void>;
  send(msg: OutboundMessage): Promise<SendResult>;
  health(): Promise<ChannelHealth>;
}